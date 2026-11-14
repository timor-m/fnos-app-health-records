<script setup lang="ts">
import {computed,onBeforeUnmount,onMounted,ref} from 'vue';
import {X,Plus,Search,LoaderCircle,ChartNoAxesCombined} from '@lucide/vue';
import type {ManagedTrendGroup,TrendGroupManagement} from '../../../shared/trend-groups';
import {request} from '../utils/api';
import FormSelect from './FormSelect.vue';
import {useScrollLock} from '../composables/useScrollLock';
import {useConfirm} from '../composables/useConfirm';
import {useToast} from '../composables/useToast';
const emit=defineEmits<{close:[];changed:[key:string,removed:boolean]}>();
useScrollLock(computed(()=>true));
const confirm=useConfirm(),toast=useToast();
const data=ref<TrendGroupManagement>({groups:[],indicators:[]});
const loading=ref(true),busy=ref(false),error=ref(''),editing=ref(false);
const editKey=ref(''),name=ref(''),selected=ref<string[]>([]),search=ref(''),templateKey=ref('');
let alive=true;
onBeforeUnmount(()=>{alive=false;});
const personal=computed(()=>data.value.groups.filter(g=>g.source==='user'));
const templates=computed(()=>data.value.groups.filter(g=>g.source==='builtin'));
const normalize=(v:string)=>v.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g,'');
const matches=computed(()=>{const q=normalize(search.value);return data.value.indicators.filter(i=>
  (!q || normalize([i.name,i.category,...i.aliases].join(' ')).includes(q)) && (i.enabled || selected.value.includes(i.key)));});
async function load(){
  loading.value=true;error.value='';
  try{const next=await request<TrendGroupManagement>('trends/groups/manage');if(alive)data.value=next;}
  catch(e){if(alive)error.value=e instanceof Error?e.message:'读取分组失败';}
  finally{if(alive)loading.value=false;}
}
onMounted(load);
function close(){if(!busy.value)emit('close');}
function edit(group?:ManagedTrendGroup,copy=false){
  editKey.value=copy?'':group?.key||'';
  name.value=group?.name||'';selected.value=[...(group?.indicatorKeys||[])];
  search.value='';error.value='';editing.value=true;templateKey.value='';
}
function copyTemplate(){const group=templates.value.find(g=>g.key===templateKey.value);if(group)edit(group,true);}
function toggle(key:string){selected.value=selected.value.includes(key)?selected.value.filter(k=>k!==key):[...selected.value,key];}
async function save(){
  if(busy.value || !name.value.trim() || !selected.value.length)return;
  busy.value=true;error.value='';
  try{
    const group=await request<ManagedTrendGroup>(`trends/groups${editKey.value?`/${encodeURIComponent(editKey.value)}`:''}`,{
      method:editKey.value?'PUT':'POST',body:JSON.stringify({name:name.value.trim(),indicatorKeys:selected.value}),
    });
    toast.show('分组已保存');emit('changed',group.key,false);emit('close');
  }catch(e){error.value=e instanceof Error?e.message:'保存失败，请重试';}
  finally{busy.value=false;}
}
function remove(group:ManagedTrendGroup){
  confirm.ask({title:'删除个人分组',message:`确认删除“${group.name}”？报告和指标数据会保留。`,danger:true,confirmText:'删除分组',run:async()=>{
    busy.value=true;error.value='';
    try{
      await request(`trends/groups/${encodeURIComponent(group.key)}`,{method:'DELETE'});
      emit('changed',group.key,true);toast.show('分组已删除');await load();
    }catch(e){error.value=e instanceof Error?e.message:'删除失败，请重试';}
    finally{busy.value=false;}
  }});
}
</script>

<template>
  <Teleport to="body">
    <div class="modal-backdrop trend-group-backdrop" @click.self="close" @keydown.esc.stop="close">
      <section class="modal-panel trend-group-manager" role="dialog" aria-modal="true" aria-label="管理我的分组" :aria-busy="busy || loading">
        <header><div><ChartNoAxesCombined :size="19" /><h3>{{ editing ? (editKey?'编辑个人分组':'新建个人分组') : '管理我的分组' }}</h3></div><button class="plain-icon-button" aria-label="关闭分组管理" :disabled="busy" @click="close"><X :size="20" /></button></header>
        <div class="manager-body">
        <p v-if="error" class="manager-error" role="alert">{{ error }}<button v-if="!editing" :disabled="loading || busy" @click="load">重试</button></p>
        <div v-if="loading" class="manager-loading" role="status"><LoaderCircle class="spin-icon" :size="20" />正在读取分组…</div>
        <template v-else-if="!editing">
          <div class="manager-toolbar"><button class="primary-button" :disabled="busy || !!error" @click="edit()"><Plus :size="16" />新建分组</button>
            <label><span>复制内置分组</span><FormSelect v-model="templateKey" :options="templates.map(group=>({value:group.key,label:group.name}))" placeholder="选择内置组合" aria-label="复制内置分组" :disabled="busy || !!error" @change="copyTemplate" /></label>
          </div>
          <p class="manager-hint">仅当前账号可管理，切换有权查看的成员时可继续使用。</p>
          <div class="manager-list">
            <p v-if="!personal.length" class="manager-empty">还没有个人分组，可以新建或复制内置组合。</p>
            <div v-for="group in personal" :key="group.key" class="manager-group"><div><strong>{{ group.name }}</strong><small>已选 {{ group.indicatorKeys.length }} 项</small></div><button class="soft-action-button" :disabled="busy" @click="edit(group)">编辑</button><button class="soft-action-button manager-delete" :disabled="busy" @click="remove(group)">删除</button></div>
          </div>
        </template>
        <form v-else class="settings-form manager-form" @submit.prevent="save">
          <label class="manager-name">分组名称<input v-model="name" aria-label="分组名称" maxlength="40" required :disabled="busy" placeholder="例如：血脂七项" /></label>
          <label class="manager-search"><Search :size="17" /><input v-model="search" aria-label="搜索分组指标" :disabled="busy" placeholder="搜索指标、别名或分类" /></label>
          <p class="manager-hint">已选 {{ selected.length }} 项（最多 200 项）；无数据的指标也可预先选择。</p>
          <div class="manager-indicators">
            <p v-if="!matches.length" class="manager-empty">没有匹配的指标</p>
            <label v-for="item in matches" :key="item.key" class="manager-indicator"><input type="checkbox" :checked="selected.includes(item.key)" :disabled="busy || (!item.enabled || selected.length>=200) && !selected.includes(item.key)" @change="toggle(item.key)" /><span>{{ item.name }}<small>{{ item.category }}{{ item.enabled?'':' · 当前字典不可用' }}</small></span></label>
          </div>
          <footer><button class="soft-action-button" type="button" :disabled="busy" @click="editing=false;error=''">返回</button><button class="primary-button" type="submit" :disabled="busy || !name.trim() || !selected.length || selected.length>200"><LoaderCircle v-if="busy" class="spin-icon" :size="16" />{{ busy?'保存中…':'保存分组' }}</button></footer>
        </form>
        </div>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.trend-group-manager {
  width: min(640px, calc(100vw - 32px)); height: min(720px, calc(100vh - 32px));
  height: min(720px, calc(100dvh - 32px)); display: flex; flex-direction: column; overflow: hidden;
}
.trend-group-manager > header { flex-shrink: 0; }
.manager-body { display: flex; flex-direction: column; flex: 1; min-height: 0; padding: 14px 16px; gap: 14px; }
.manager-toolbar { display: flex; align-items: flex-end; gap: 14px; flex-wrap: wrap; }
.manager-toolbar > button { flex-shrink: 0; }
.manager-toolbar label { display: grid; flex: 1; min-width: 170px; gap: 7px; color: var(--muted); font-size: 12px; }
.manager-delete { color: var(--danger); }
.manager-hint { margin: 0; color: var(--muted); font-size: 12px; line-height: 1.5; }
.manager-list, .manager-indicators { flex: 1; min-height: 0; overflow-y: auto; padding-right: 12px; overscroll-behavior: contain; }
.manager-group { display: flex; align-items: center; gap: 8px; padding: 12px 0; border-bottom: 1px solid var(--line); }
.manager-group > div { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.manager-group small, .manager-indicator small { display: block; color: var(--muted); font-size: 12px; margin-top: 4px; }
.manager-form { display: flex; flex-direction: column; min-height: 0; flex: 1; gap: 12px; padding: 0; }
.manager-search { display: flex !important; align-items: center; gap: 8px; padding: 0 12px; min-height: 44px; border: 1px solid var(--line-strong); border-radius: 10px; color: var(--muted); background: var(--surface); }
.manager-search:focus-within { border-color: var(--brand); box-shadow: 0 0 0 3px var(--brand-soft); }
.manager-form .manager-search input { min-width: 0; flex: 1; border: 0; background: transparent; box-shadow: none; padding: 0; }
.manager-indicator { display: flex; align-items: center; gap: 10px; padding: 10px 0; border-bottom: 1px solid var(--line); }
.manager-indicator input { width: 17px; height: 17px; flex: 0 0 auto; accent-color: var(--brand); }
.manager-indicator span { display: block; min-width: 0; overflow-wrap: anywhere; }
.manager-form footer { display: flex; justify-content: flex-end; gap: 8px; flex-shrink: 0; border-top: 1px solid var(--line); padding-top: 14px; }
.manager-loading { display: flex; align-items: center; justify-content: center; gap: 8px; flex: 1; }
.manager-error { margin: 0; color: var(--danger); white-space: pre-wrap; }
.manager-error button { margin-left: 8px; }
.manager-empty { color: var(--muted); padding: 20px 0; }
@media (max-width: 760px) {
  .trend-group-manager { width: 100vw; height: min(720px, 94vh); height: min(720px, 94dvh); max-height: 94dvh; border-radius: 8px 8px 0 0; align-self: end; }
}
</style>
