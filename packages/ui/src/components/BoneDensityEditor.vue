<script setup lang="ts">
import {computed,nextTick,onBeforeUnmount,onMounted,ref} from 'vue';
import {Plus,Trash2,X} from '@lucide/vue';
import {boneSites,boneMetrics} from '../../../shared/bone-density';
import FormSelect from './FormSelect.vue';
import DateTimePicker from './DateTimePicker.vue';
import {request} from '../utils/api';
import {useScrollLock} from '../composables/useScrollLock';
import {useUnsavedRecord} from '../composables/useUnsavedRecord';
const props=defineProps<{reportId:string;sourceVersion:number;pages:Array<{id:string;pageNumber:number}>}>();
const emit=defineEmits<{close:[];saved:[]}>();
const examinedAt=ref<string|null>(null),sourcePageId=ref(''),saving=ref(false),error=ref('');
const panel=ref<HTMLElement|null>(null);
let nextKey=0;
const blank=()=>({key:++nextKey,site:'',side:'unspecified',dxa_bmd:'',dxa_t_score:'',dxa_z_score:''});
const rows=ref([blank()]);
const leave=useUnsavedRecord(()=>JSON.stringify([examinedAt.value,sourcePageId.value,rows.value]),saving);
useScrollLock(computed(()=>true));
const previousFocus=document.activeElement as HTMLElement|null;
onMounted(()=>{panel.value?.focus();leave.reset();});
onBeforeUnmount(()=>previousFocus?.focus({preventScroll:true}));
async function close(){if(await leave.confirmLeave())emit('close');}
function trapFocus(event:KeyboardEvent){
 const elements=Array.from(panel.value?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),[tabindex="0"]') || []);
 const first=elements[0],last=elements[elements.length-1];
 if(event.shiftKey && (document.activeElement===first || document.activeElement===panel.value)){event.preventDefault();last?.focus();}
 else if(!event.shiftKey && document.activeElement===last){event.preventDefault();first?.focus();}
}
async function add(){rows.value.push(blank());await nextTick();panel.value?.querySelectorAll<HTMLElement>('.bone-site-row').item(rows.value.length-1)?.scrollIntoView({block:'nearest'});}
async function save(){
 if(saving.value)return;
 saving.value=true;error.value='';
 try{await request(`reports/${encodeURIComponent(props.reportId)}/bone-density`,{method:'POST',body:JSON.stringify({examinedAt:examinedAt.value,sourcePageId:sourcePageId.value,expectedSourceVersion:props.sourceVersion,sites:rows.value})});leave.reset();emit('saved');}
 catch(cause){error.value=cause instanceof Error?cause.message:'保存失败';}finally{saving.value=false;}
}
</script>
<template>
<Teleport to="body"><div class="modal-backdrop bone-density-backdrop" @click.self="close" @keydown.esc.stop="close" @keydown.tab="trapFocus">
<section ref="panel" tabindex="-1" class="modal-panel bone-density-editor" role="dialog" aria-modal="true" aria-label="补充骨密度">
<header><strong>补充骨密度 · DXA</strong><button class="plain-icon-button" type="button" aria-label="关闭" :disabled="saving" @click="close"><X :size="18"/></button></header>
<form class="settings-form" @submit.prevent="save"><div class="bone-editor-body">
<div class="bone-density-fields"><label><span>检查时间</span><DateTimePicker v-model="examinedAt" :show-time="false" /></label><label><span>来源页</span><FormSelect v-model="sourcePageId" :options="[{value:'',label:'待确认'},...pages.map(page=>({value:page.id,label:`第 ${page.pageNumber} 页`}))]" aria-label="骨密度来源页"/></label></div>
<p class="muted-copy">按部位填写，每个部位至少填一项。BMD 单位为 g/cm²，T／Z 值无单位。</p>
<div class="bone-density-sites"><fieldset v-for="(row,index) in rows" :key="row.key" class="bone-site-row"><legend>部位 {{index+1}}</legend>
<div class="bone-density-fields"><label><span>检查部位</span><FormSelect v-model="row.site" :options="boneSites.map(([value,label])=>({value,label}))" aria-label="检查部位" /></label><label v-if="!row.site.startsWith('lumbar_')"><span>左右侧</span><FormSelect v-model="row.side" :options="[{value:'unspecified',label:'未注明'},{value:'left',label:'左侧'},{value:'right',label:'右侧'}]" aria-label="左右侧" /></label></div>
<div class="bone-values"><label v-for="metric in boneMetrics" :key="metric.key"><span>{{metric.label}}</span><input v-model="row[metric.key]" type="number" step="any" :min="metric.key==='dxa_bmd'?0:undefined" :aria-label="`${index+1} ${metric.label}`"/></label><button v-if="rows.length>1" class="plain-icon-button" type="button" aria-label="移除部位" :disabled="saving" @click="rows.splice(index,1)"><Trash2 :size="17"/></button></div></fieldset></div>
<button class="soft-action-button" type="button" :disabled="saving" @click="add"><Plus :size="16"/>添加部位</button>
<p v-if="error" class="inline-panel-error" role="alert">{{error}}</p></div><footer class="form-actions record-form-actions"><button type="button" :disabled="saving" @click="close">取消</button><button class="primary-button" :disabled="saving" type="submit">{{saving?'保存中…':'保存'}}</button></footer>
</form></section></div></Teleport>
</template>
<style scoped>
.bone-density-backdrop{z-index:120;display:grid;place-items:center}.bone-density-editor{width:min(720px,calc(100vw - 32px));max-height:90vh;display:flex;flex-direction:column;overflow:hidden;padding:24px;gap:16px}
header,footer,.bone-values{display:flex;align-items:center;gap:12px}header{justify-content:space-between}footer{justify-content:flex-end;padding-top:16px}.settings-form{display:flex;flex-direction:column;min-height:0;overflow:hidden;gap:0}.bone-editor-body{overflow:auto;padding-right:8px;min-height:0}footer{flex-shrink:0}.bone-density-fields{display:grid;grid-template-columns:1fr 1fr;gap:12px}.bone-density-sites{display:grid;gap:12px}.bone-site-row{border:1px solid var(--line);border-radius:12px;padding:12px;min-width:0}.bone-values{margin-top:12px}.bone-values label{min-width:0;flex:1}.bone-values input{width:100%;box-sizing:border-box}label{display:grid;gap:6px}.muted-copy{font-size:12px;line-height:1.6}
@media(max-width:600px){.bone-density-editor{padding:16px;width:calc(100vw - 24px)}.bone-density-fields{grid-template-columns:1fr}.bone-values{gap:8px}}
</style>
