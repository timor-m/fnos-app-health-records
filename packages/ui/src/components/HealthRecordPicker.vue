<script setup lang="ts">
import { computed, onBeforeUnmount, ref, useId, watch } from 'vue';
import HealthCategoryIcon from './HealthCategoryIcon.vue';
import { healthCategoryLabels, type HealthFeedEntry, type HealthFeedPage } from '../../../shared/health-categories';
import {healthCategoryOrder,isHealthCategoryDisabled} from '../utils/health-record-presentation';
import type { HealthRecordRef } from '../../../shared/health-record-associations';
import { request } from '../utils/api';
import { formatMedicationDate } from '../utils/medication-date';
const props=defineProps<{memberId:string;modelValue:HealthRecordRef[];exclude?:HealthRecordRef[];disabled?:boolean;reportOnly?:boolean;maxSelections?:number}>();
const emit=defineEmits<{'update:modelValue':[value:HealthRecordRef[]]}>();
const pickerId=useId();const maxSelections=computed(()=>props.maxSelections||20);
const category=ref('');const search=ref('');const items=ref<HealthFeedEntry[]>([]);const cursor=ref<string|null>(null);
const loading=ref(false);const error=ref('');let sequence=0;let timer:ReturnType<typeof setTimeout>|undefined;
const key=(ref:HealthRecordRef)=>`${ref.kind==='medication_document'?'report':ref.kind}:${ref.id}`;
const visible=computed(()=>items.value.filter(item=>(!props.reportOnly||item.category==='report')&&!props.exclude?.some(ref=>key(ref)===key({kind:item.kind,id:item.resourceId}))));
const selected=(item:HealthFeedEntry)=>props.modelValue.some(ref=>key(ref)===key({kind:item.kind,id:item.resourceId}));
async function load(more=false){
  if(more&&(loading.value||!cursor.value))return;
  const token=++sequence;const member=props.memberId;loading.value=true;error.value='';
  if(!more){items.value=[];cursor.value=null;}
  const query=new URLSearchParams({memberId:member,timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone});if(props.reportOnly||category.value)query.set('category',props.reportOnly?'report':category.value);if(search.value.trim())query.set('q',search.value.trim());if(more&&cursor.value)query.set('cursor',cursor.value);
  try{const next=await request<HealthFeedPage>(`health-records?${query}`);if(token!==sequence||member!==props.memberId)return;
    if(!next||!Array.isArray(next.items)||next.items.some(item=>item.memberId!==member))throw Error('关联记录数据无效，请刷新重试');
    items.value=more?[...items.value,...next.items]:next.items;cursor.value=next.nextCursor;
  }catch(cause){if(token===sequence)error.value=cause instanceof Error?cause.message:'记录加载失败';}
  finally{if(token===sequence)loading.value=false;}
}
function toggle(item:HealthFeedEntry){if(props.disabled)return;const ref={kind:item.kind,id:item.resourceId};
  if(selected(item))emit('update:modelValue',props.modelValue.filter(value=>key(value)!==key(ref)));
  else if(maxSelections.value===1)emit('update:modelValue',[ref]);
  else if(props.modelValue.length<maxSelections.value)emit('update:modelValue',[...props.modelValue,ref]);
}
watch(()=>[props.memberId,category.value,props.reportOnly],()=>{clearTimeout(timer);void load();},{immediate:true});
watch(search,()=>{sequence++;cursor.value=null;items.value=[];error.value='';loading.value=true;clearTimeout(timer);timer=setTimeout(()=>void load(),250);});
onBeforeUnmount(()=>{sequence++;clearTimeout(timer);});
</script>
<template>
 <div class="health-record-picker">
  <input v-model="search" type="search" placeholder="搜索名称或日期" aria-label="搜索待关联记录" :disabled="disabled"/>
  <div v-if="!reportOnly" class="record-picker-filters" role="group" aria-label="关联记录类型"><button type="button" :aria-pressed="!category" :disabled="disabled" @click="category=''">全部</button><button v-for="type in healthCategoryOrder" :key="type" type="button" :aria-pressed="category===type" :disabled="disabled||isHealthCategoryDisabled(type)" :title="isHealthCategoryDisabled(type)?'影像暂未开放':undefined" @click="category=type">{{healthCategoryLabels[type]}}</button></div>
  <p class="record-picker-hint"><template v-if="reportOnly">选择一份报告，原报告会保留。</template><template v-else>已选择 {{modelValue.length}} 项，最多 {{maxSelections}} 项。保存后将串入同一健康历程。</template></p>
  <div class="record-picker-list" :aria-busy="loading">
   <p v-if="error" role="alert" class="inline-panel-error">{{error}} <button type="button" :disabled="disabled" @click="load()">重试</button></p>
   <label v-for="item in visible" :key="item.id" class="record-picker-option" :class="{'is-selected':selected(item)}"><input :type="maxSelections===1?'radio':'checkbox'" :name="maxSelections===1?pickerId:undefined" :checked="selected(item)" :disabled="disabled||maxSelections!==1&&!selected(item)&&modelValue.length>=maxSelections" @change="toggle(item)"/><HealthCategoryIcon :category="item.category" :size="24"/><span><strong>{{item.title}}</strong><small>{{healthCategoryLabels[item.category]}} · {{formatMedicationDate(item.date)||'日期未记录'}}<template v-if="item.processIds.length"> · 已有关联历程</template></small><small v-if="item.institution" class="record-picker-institution" :title="item.institution">{{item.institution}}</small></span></label>
   <p v-if="loading" role="status" class="record-picker-hint record-picker-state">正在读取记录…</p><p v-else-if="!visible.length&&!error" class="record-picker-hint record-picker-state">没有匹配的记录，可更换类型或搜索词。</p>
  </div>
  <button v-if="cursor" type="button" class="soft-action-button" :disabled="loading||disabled" @click="load(true)">加载更多</button>
 </div>
</template>
<style scoped>
.health-record-picker{display:grid;gap:10px;min-width:0}.health-record-picker>input{width:100%;min-height:38px;padding:8px 10px;border:1px solid var(--line-strong);border-radius:var(--radius-s);background:var(--surface);color:var(--ink);font:inherit;font-size:14px}.record-picker-filters{display:flex;flex-wrap:wrap;gap:6px}.record-picker-filters button{min-height:32px;padding:4px 10px;border:1px solid var(--line);border-radius:8px;background:var(--surface);color:var(--ink-2);font:inherit;font-size:12px}.record-picker-filters button[aria-pressed=true]{background:var(--brand-soft);color:var(--brand-strong);border-color:var(--brand)}.record-picker-hint{margin:0;font-size:12px;line-height:19px;color:var(--muted)}.record-picker-list{max-height:300px;overflow:auto;overscroll-behavior:contain}.record-picker-option{display:flex;align-items:center;gap:9px;min-height:52px;padding:8px 2px;border-bottom:1px solid var(--line)}.record-picker-option.is-selected{background:var(--brand-softer)}.record-picker-option>input{width:16px;height:16px;flex-shrink:0;accent-color:var(--brand)}.record-picker-option>span{min-width:0;display:grid;gap:3px}.record-picker-option strong{font-size:14px;font-weight:500;line-height:20px;overflow-wrap:anywhere}.record-picker-institution{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.record-picker-option small{font-size:12px;line-height:18px;color:var(--muted)}.health-record-picker button:focus-visible,.record-picker-option:focus-within{outline:2px solid var(--brand);outline-offset:2px}@media(max-width:760px),(pointer:coarse){.record-picker-filters button{min-height:36px}.record-picker-list{max-height:260px}}
</style>
