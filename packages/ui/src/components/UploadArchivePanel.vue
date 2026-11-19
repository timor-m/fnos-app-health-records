<script setup lang="ts">
import { computed, onActivated, onDeactivated, onBeforeUnmount, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';
import FormSelect from './FormSelect.vue';
import ReportDetailModal from './ReportDetailModal.vue';
import { useAppContext } from '../composables/useAppContext';
import { request } from '../utils/api';
import { createSubmissionKey } from '../utils/submission-key';
import { healthCategoryLabels, reportCategory } from '../../../shared/health-categories';
import type { ReportDetail } from '../types/api';
const props=defineProps<{memberId:string;reportIds:string[];review?:boolean;currentBatch?:boolean}>();const emit=defineEmits<{saved:[]}>();const app=useAppContext();
type Item={id:string;title:string;status:string;reportType:string;state:string;eventId:string|null};type Group={id:string;reportIds:string[];title:string};
type WorkflowPreview={reports:Item[]};
type WorkflowPage=WorkflowPreview&{nextCursor:string|null};
const reports=ref<Item[]>([]);const groups=ref<Group[]>([]);const selected=ref<string[]>([]);const busy=ref(false);const error=ref('');const previewId=ref('');const cursor=ref<string|null>(null);const done=ref(false);let sequence=0;let active=true;let timer:ReturnType<typeof setTimeout>|undefined;const key=createSubmissionKey();
const organizing=ref(false);const currentLoaded=ref(0);
const editing=computed(()=>!props.currentBatch||organizing.value);
const statusLabels:Record<string,string>={queued:'待识别',uploading:'上传中',processing:'识别中',needs_review:'待核对',failed:'识别失败',ready:'已识别'};
type Draft={groups:Group[];pending?:{signature:string;requestKey:string}};
const draftKey=()=>`health-document-groups:${props.memberId}`;
let cached:Draft|null=null;let draftReady=false;let pending:Draft['pending'];
function readDraft():Draft|null{
 try{const value=JSON.parse(sessionStorage.getItem(draftKey())||'null');if(!value||!Array.isArray(value.groups))return null;
  const valid=value.groups.every((group:Group)=>group&&typeof group.id==='string'&&Array.isArray(group.reportIds)&&group.reportIds.every(id=>typeof id==='string')&&typeof group.title==='string');
  if(!valid)return null;return {groups:value.groups,pending:value.pending&&typeof value.pending.signature==='string'&&typeof value.pending.requestKey==='string'?value.pending:undefined};
 }catch{return null;}
}
function persistDraft(){if(!draftReady)return;try{if(!groups.value.length)sessionStorage.removeItem(draftKey());else sessionStorage.setItem(draftKey(),JSON.stringify({groups:groups.value,pending}));}catch{/* Storage may be unavailable; uploaded originals remain saved. */}}
function syncGroups(){
 const pendingReports=reports.value.filter(item=>item.state!=='archived'&&item.state!=='skipped');
 const available=new Set((props.currentBatch?pendingReports.slice(0,100):pendingReports).map(item=>item.id));const used=new Set<string>();
 groups.value=(groups.value.length?groups.value:cached?.groups||[]).map(group=>({...group,reportIds:group.reportIds.filter(id=>{if(!available.has(id)||used.has(id))return false;used.add(id);return true;})})).filter(group=>group.reportIds.length);
 groups.value.push(...[...available].filter(id=>!used.has(id)).map(id=>({id,reportIds:[id],title:''})));
 cached=null;draftReady=true;persistDraft();
}
watch(groups,persistDraft,{deep:true});
const typeOptions=[{value:'checkup',label:'报告 · 体检'},{value:'laboratory',label:'报告 · 检验'},{value:'pathology',label:'报告 · 病理'},{value:'functional',label:'报告 · 功能检查'},{value:'outpatient',label:'报告 · 门诊病历'},{value:'inpatient',label:'报告 · 住院资料'},{value:'billing',label:'报告 · 费用凭证'},{value:'other',label:'报告 · 其他资料'},{value:'prescription',label:'用药单'},{value:'vaccination',label:'接种'},{value:'imaging',label:'影像报告'}];
const processing=computed(()=>reports.value.some(item=>['queued','processing','uploading'].includes(item.status)));
const pendingReports=computed(()=>reports.value.filter(item=>!['archived','skipped'].includes(item.state)));
const writable=computed(()=>props.memberId===app.selectedMemberId.value&&app.selectedMember.value?.permission==='manager');
async function load(poll=false,more=false){if(!active||!props.memberId)return;const token=sequence;error.value='';
 try{
 let value:WorkflowPreview;
 const ids=props.reportIds.slice(0,100);
 if(props.currentBatch){
  if(!props.reportIds.length)return;
  const start=more?currentLoaded.value:0;
  const end=more?Math.min(props.reportIds.length,start+100):Math.max(currentLoaded.value,Math.min(props.reportIds.length,100));
  value={reports:[]};
  for(let offset=start;offset<end;offset+=100){
   const part=await request<WorkflowPreview>('uploads/workflow/preview',{method:'POST',body:JSON.stringify({memberId:props.memberId,reportIds:props.reportIds.slice(offset,Math.min(offset+100,end))})});
   if(token!==sequence||!active)return;
   value.reports.push(...part.reports);
  }
  currentLoaded.value=end;cursor.value=end<props.reportIds.length?'current':null;
 }else if(!ids.length||more){
  const page=await request<WorkflowPage>(`uploads/workflow?memberId=${encodeURIComponent(props.memberId)}${more&&cursor.value?`&cursor=${encodeURIComponent(cursor.value)}`:''}`);
  if(token!==sequence||!active)return;
  value=page;cursor.value=page.nextCursor;
 }else{
  value=await request<WorkflowPreview>('uploads/workflow/preview',{method:'POST',body:JSON.stringify({memberId:props.memberId,reportIds:ids})});
  if(token!==sequence||!active)return;
 }
 reports.value=more?[...new Map([...reports.value,...value.reports].map(item=>[item.id,item])).values()]:value.reports;
 if(!poll){syncGroups();selected.value=[];}
 }catch(cause){if(token===sequence&&active)error.value=cause instanceof Error?cause.message:'无法读取上传资料';}
 finally{clearTimeout(timer);if(active&&token===sequence&&processing.value)timer=setTimeout(()=>void load(true),3000);}}
function merge(){if(selected.value.length<2||busy.value)return;const ids=[...selected.value];groups.value=groups.value.map(group=>({...group,reportIds:group.reportIds.filter(id=>!ids.includes(id))})).filter(group=>group.reportIds.length);groups.value.push({id:ids.join(':'),reportIds:ids,title:''});selected.value=[];}
function split(group:Group){groups.value=groups.value.filter(item=>item!==group);groups.value.push(...group.reportIds.map(id=>({id,reportIds:[id],title:''})));}
async function classify(item:Item,type:string){if(busy.value||!writable.value)return;const token=++sequence;clearTimeout(timer);busy.value=true;try{const report=await request<ReportDetail>(`reports/${encodeURIComponent(item.id)}`);if(token!==sequence||!active||!writable.value||report.memberId!==props.memberId)return;await request(`reports/${encodeURIComponent(item.id)}`,{method:'PUT',body:JSON.stringify({reportType:type,expectedSourceVersion:report.sourceVersion})});if(token!==sequence||!active||!writable.value)return;item.reportType=type;app.notifyDataChanged();}catch(cause){if(token===sequence)error.value=cause instanceof Error?cause.message:'分类修改失败';}finally{if(token===sequence){busy.value=false;if(processing.value&&active)timer=setTimeout(()=>void load(true),3000);}}}
async function save(separate=false){if(busy.value||!writable.value||!groups.value.length)return;const token=sequence;const payload={memberId:props.memberId,groups:separate?groups.value.flatMap(group=>group.reportIds.map(id=>({reportIds:[id]}))):groups.value.map(group=>({reportIds:group.reportIds,title:group.title}))};busy.value=true;error.value='';
 const signature=JSON.stringify(payload);if(pending?.signature!==signature)pending={signature,requestKey:key.forRequest('documents.organize',payload)};persistDraft();
 try{const saved=await request<{reportIds:string[];groups:Array<{reportIds:string[]}>}>('health-records/organize',{method:'POST',body:JSON.stringify({...payload,requestKey:pending.requestKey})});if(token!==sequence||!active)return;if(props.currentBatch){const ids=new Set(saved.reportIds);const grouped=new Set(saved.groups.flatMap(group=>group.reportIds));reports.value=reports.value.map(item=>ids.has(item.id)?{...item,state:grouped.has(item.id)?'archived':'skipped'}:item);}groups.value=[];selected.value=[];pending=undefined;persistDraft();done.value=true;organizing.value=false;if(props.currentBatch)syncGroups();app.notifyDataChanged();emit('saved');}catch(cause){if(token===sequence&&active)error.value=cause instanceof Error?cause.message:'整理失败';}finally{if(token===sequence)busy.value=false;}}
watch(()=>[props.memberId,props.reportIds.join(','),props.review,props.currentBatch],()=>{draftReady=false;cached=readDraft();pending=cached?.pending;sequence++;clearTimeout(timer);reports.value=[];groups.value=[];selected.value=[];previewId.value='';busy.value=false;done.value=false;organizing.value=false;currentLoaded.value=0;cursor.value=null;key.reset();void load();},{immediate:true,flush:'pre'});
onDeactivated(()=>{active=false;sequence++;clearTimeout(timer);previewId.value='';});onActivated(()=>{if(!active){active=true;void load();}});onBeforeUnmount(()=>{active=false;sequence++;clearTimeout(timer);});
</script>
<template>
  <section v-if="props.memberId===app.selectedMemberId.value&&(reports.length||error||cursor)" class="archive-panel settings-band" :class="{'archive-current-batch':currentBatch}" :aria-label="currentBatch?'本次上传资料':'整理上传资料'">
    <header><div><h3>{{currentBatch?'本次上传资料':'资料已保存'}}</h3><p v-if="currentBatch">{{reportIds.length}} 份资料，可直接查看记录；类型和合并按需调整。</p><p v-else>资料会自动识别类型。可纠正类型，并将明确属于同一次的资料放在一起。</p></div></header>
    <div class="archive-body">
      <p v-if="error" role="alert" class="inline-panel-error">{{error}} <button :disabled="busy" @click="load()">重试</button></p>
      <p v-if="processing" role="status" class="archive-processing">正在识别，完成后自动更新资料信息。</p>
      <article v-for="item in reports" :key="item.id" class="archive-report">
        <input v-if="editing&&writable&&groups.some(group=>group.reportIds.includes(item.id))" v-model="selected" type="checkbox" :value="item.id" :disabled="busy" :aria-label="`选择资料：${item.title}`"/>
        <button type="button" class="soft-action-button archive-report-title" @click="previewId=item.id">{{item.title}}</button>
        <span class="archive-report-type">{{healthCategoryLabels[reportCategory(item.reportType)]}}</span>
        <span v-if="currentBatch" class="archive-report-status" :class="{'is-failed':item.status==='failed'}">{{statusLabels[item.status]||'已保存'}}</span>
        <FormSelect v-if="writable&&(editing||item.reportType==='other'&&['ready','needs_review'].includes(item.status))" :model-value="item.reportType" :options="typeOptions" :disabled="busy" :aria-label="`资料类型：${item.title}`" @update:model-value="classify(item,$event)"/>
      </article>
      <template v-if="editing&&groups.length&&writable">
        <p v-if="currentBatch&&pendingReports.length>100" class="archive-processing">单次最多调整 100 份，其余资料已保存，可在完成后继续调整。</p>
        <button v-if="!currentBatch||reports.length>1" type="button" class="soft-action-button" :disabled="selected.length<2||busy" @click="merge">选中的资料属于同一次（{{selected.length}}）</button>
        <article v-for="group in groups" :key="group.id" class="archive-group">
          <p>{{group.reportIds.length}} 份资料 <button v-if="group.reportIds.length>1" :disabled="busy" @click="split(group)">分开保存</button></p>
          <label v-if="group.reportIds.length>1">这组资料的标题<input v-model="group.title" maxlength="120" :disabled="busy" placeholder="例如：年度体检"/></label>
          <p class="archive-processing">保存后可在记录详情点击“关联历程”，将同一健康事项的记录组织在一起。</p>
        </article>
        <div class="form-actions"><button class="primary-button" :disabled="busy" @click="save()">{{busy?'正在保存…':currentBatch?'保存调整':'确认整理'}}</button><button v-if="!currentBatch||reports.length>1" :disabled="busy" @click="save(true)">{{currentBatch?'保持分开':'分别保存'}}</button></div>
      </template>
      <p v-if="done" class="archive-processing" role="status">{{currentBatch?'调整已保存，可在记录页查看。':'整理已保存，可在记录页查看。'}}</p>
      <button v-if="cursor" class="soft-action-button" :disabled="busy" @click="load(false,true)">{{currentBatch?'显示更多本次资料':'继续整理更多资料'}}</button>
      <div v-if="currentBatch&&writable&&groups.length" class="archive-secondary-actions"><button type="button" class="soft-action-button" :disabled="busy" :aria-expanded="organizing" @click="organizing=!organizing;selected=[]">{{organizing?'收起调整':'调整资料'}}</button></div>
      <RouterLink v-if="!currentBatch" class="soft-action-button" to="/events">查看记录</RouterLink>
    </div>
    <ReportDetailModal :open="Boolean(previewId)" :report-id="previewId||null" @close="previewId=''" @updated="load(true)"/>
  </section>
</template>
<style scoped>
.archive-body{padding:16px;display:grid;gap:14px}.archive-report{display:flex;flex-wrap:wrap;align-items:center;gap:10px;padding:12px 0;border-bottom:1px solid var(--line)}.archive-report>input{width:18px;height:18px}.archive-group{padding:14px;border:1px solid var(--line);border-radius:var(--radius-m);display:grid;gap:12px}.archive-group label{display:grid;gap:8px}.archive-group input{width:100%}
.archive-current-batch { margin-top: 14px; }
.archive-current-batch > header h3 { font-size: 16px; }
.archive-current-batch > header p,.archive-processing { margin: 0; color: var(--muted); font-size: 12px; line-height: 1.6; }
.archive-current-batch .archive-body { gap: 8px; padding: 12px 16px; }
.archive-current-batch .archive-report { min-width: 0; gap: 6px 8px; padding: 8px 0; }
.archive-current-batch .archive-report-title { position: relative; flex: 1; min-width: 0; padding: 0; border-radius: 0; background: transparent; color: var(--ink); font-size: 14px; font-weight: 500; line-height: 20px; overflow-wrap: anywhere; }
.archive-current-batch .archive-report-type,.archive-report-status { color: var(--muted); font-size: 12px; line-height: 20px; }
.archive-report-status.is-failed { color: var(--danger); }
.archive-secondary-actions { display: flex; justify-content: flex-end; }
.archive-secondary-actions > button { position: relative; min-height: 36px; font-size: 12px; }
.archive-current-batch .archive-report-title:focus-visible,.archive-secondary-actions > button:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; }
.archive-current-batch .archive-group { gap: 8px; padding: 10px; font-size: 14px; }
.archive-current-batch .form-actions { margin: 0; gap: 8px; }
.archive-current-batch .form-actions > button { width: auto; font-size: 14px; }
@media (max-width: 760px) { .archive-current-batch .archive-body { padding: 10px 14px; } }
@media (max-width: 760px), (pointer: coarse) {
  .archive-current-batch .archive-report-title::after { content: ''; position: absolute; inset: -5px 0; }
  .archive-secondary-actions > button::after { content: ''; position: absolute; inset: -4px 0; }
}
</style>
