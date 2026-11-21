<script setup lang="ts">
import { computed,nextTick,onActivated,onDeactivated,onBeforeUnmount,ref,shallowRef,watch } from 'vue';
import { RouterLink,useRoute,useRouter } from 'vue-router';
import { Pencil,Sparkles,LoaderCircle } from '@lucide/vue';
import HealthProcessEditorDialog from '../components/HealthProcessEditorDialog.vue';
import HealthProcessFollowups from '../components/HealthProcessFollowups.vue';
import HealthProcessObservations from '../components/HealthProcessObservations.vue';
import HealthProcessCarePanel from '../components/HealthProcessCarePanel.vue';
import QuickAddMenu from '../components/QuickAddMenu.vue';
import SubPageHeader from '../components/SubPageHeader.vue';
import type {HealthProcessActivity} from '../../../shared/health-process-activity';
import RecordLoading from '../components/RecordLoading.vue';
import HealthRecordTrashAction from '../components/HealthRecordTrashAction.vue';
import {useToast} from '../composables/useToast';
import HealthCategoryIcon from '../components/HealthCategoryIcon.vue';
import HealthRecordAssociationModal from '../components/HealthRecordAssociationModal.vue';
import HealthRecordDetailModal from '../components/HealthRecordDetailModal.vue';
import DateTimePicker from '../components/DateTimePicker.vue';
import {processLifecycleLabels,type ProcessLifecycle} from '../../../shared/health-process';
import FormSelect from '../components/FormSelect.vue';
import { useAppContext } from '../composables/useAppContext';
import { useUnsavedRecord } from '../composables/useUnsavedRecord';
import { useTouchRecordDetail } from '../composables/useTouchRecordDetail';
import { useConfirm } from '../composables/useConfirm';
import { request } from '../utils/api';
import { createSubmissionKey } from '../utils/submission-key';
import {createUuid} from '../utils/uuid';
import { healthRecordPath,isHealthRecordKind } from '../utils/health-record-navigation';
import { compareMedicationDates,formatMedicationDate } from '../utils/medication-date';
import { groupHealthTimeline } from '../utils/health-timeline';
import { readStorage,writeStorage } from '../utils/storage';
import { vaccinationReturnTo } from '../utils/vaccination';
import { processStageLabels,processStages,type HealthProcessDetail,type ProcessRecordRemoval,type ProcessRecordRef,type ProcessStage } from '../../../shared/health-process';
import { healthCategoryLabels } from '../../../shared/health-categories';
const app=useAppContext();const route=useRoute();const router=useRouter();const touch=useTouchRecordDetail();const active=ref(true);
const root=ref<HTMLElement|null>(null);
const carePanel=ref<InstanceType<typeof HealthProcessCarePanel>|null>(null);
const initialActivity=shallowRef<Promise<HealthProcessActivity>>();
const process=ref<HealthProcessDetail|null>(null);const loading=ref(false);const busy=ref(false);const error=ref('');
const organizing=ref(false);
const aiOrganizing=computed(()=>organizing.value||process.value?.aiState==='pending');
const editReturnFocus=ref<HTMLElement|null>(null);const editError=ref('');
const editing=ref(false);const linking=ref(false);const linkError=ref('');const linkReturnFocus=ref<HTMLElement|null>(null);const title=ref('');const summary=ref('');const stages=ref<Record<string,ProcessStage>>({});
const lifecycle=ref<ProcessLifecycle>({status:'unknown',onsetAt:null,endedAt:null});
const lifecycleOptions=Object.entries(processLifecycleLabels).map(([value,label])=>({value,label}));
watch(()=>lifecycle.value.status,status=>{if(status!=='resolved')lifecycle.value.endedAt=null;});
const processAnchor=ref<ProcessRecordRef|null>(null);
const opened=ref<ProcessRecordRef|null>(null);const opener=ref<HTMLElement|null>(null);
let owned:{token:string;memberId:string}|null=null;
const key=createSubmissionKey();let sequence=0;let contextGeneration=0;let poll:ReturnType<typeof setTimeout>|undefined;
const confirm=useConfirm();const toast=useToast();const trashKey=createSubmissionKey();const removalKey=createSubmissionKey();
const timelineViewKey='health-records:process-timeline-view';
const timelineView=ref<'flow'|'time'>(readStorage(timelineViewKey)==='time'?'time':'flow');
let timelineSwitch=0;
const scope=computed(()=>JSON.stringify([route.params.id,app.selectedMemberId.value]));
const canManage=computed(()=>app.selectedMember.value?.permission==='manager');
const backTo=computed(()=>{const target=vaccinationReturnTo(route.query.returnTo,'/health-processes');return target.split('?')[0]===route.path?'/health-processes':target;});
const orderedRecords=computed(()=>[...(process.value?.records||[])].sort((a,b)=>compareMedicationDates(b.date,a.date)||refKey(a.ref).localeCompare(refKey(b.ref))));
const groups=computed(()=>timelineView.value==='flow'
 ?[...processStages].reverse().map(stage=>({key:stage,label:processStageLabels[stage],records:orderedRecords.value.filter(record=>record.stage===stage)})).filter(group=>group.records.length)
 :groupHealthTimeline(orderedRecords.value).map(group=>({key:group.key,label:group.label,records:group.entries})));
const stageOptions=processStages.map(value=>({value,label:processStageLabels[value]}));
const refKey=(ref:ProcessRecordRef)=>`${ref.kind}:${ref.id}`;
const sameRef=(a:ProcessRecordRef,b:ProcessRecordRef)=>a.id===b.id&&(a.kind==='medication_document'?'report':a.kind)===(b.kind==='medication_document'?'report':b.kind);
async function changeTimelineView(view:'flow'|'time'){
 if(timelineView.value===view)return;
 const token=++timelineSwitch;const context=contextGeneration;
 const timeline=root.value?.querySelector<HTMLElement>('.process-stages');
 // At the beginning of the timeline keep its controls in place. When reading further
 // down, retain the first visible record instead of jumping to a different record.
 const anchor=timeline&&timeline.getBoundingClientRect().top<0?Array.from(timeline.querySelectorAll<HTMLElement>('[data-process-record]')).find(element=>{
  const rect=element.getBoundingClientRect();return rect.bottom>0&&rect.top<window.innerHeight;
 }):undefined;
 const key=anchor?.dataset.processRecord;const top=anchor?.getBoundingClientRect().top;
 timelineView.value=view;writeStorage(timelineViewKey,view);
 await nextTick();
 if(!active.value||context!==contextGeneration||token!==timelineSwitch||!key||top===undefined)return;
 const next=Array.from(root.value?.querySelectorAll<HTMLElement>('.process-stages [data-process-record]')||[]).find(element=>element.dataset.processRecord===key);
 if(next){const offset=next.getBoundingClientRect().top-top;if(Math.abs(offset)>1)window.scrollBy({top:offset,behavior:'instant'});}
}
const leave=useUnsavedRecord(()=>JSON.stringify(editing.value?[title.value,summary.value,stages.value,lifecycle.value]:null),busy);
async function load(preserve=true,prefetch=false){if(!active.value||!route.path.startsWith('/health-processes/'))return;const token=++sequence;const member=app.selectedMemberId.value;const id=String(route.params.id||'');clearTimeout(poll);loading.value=true;error.value='';if(!preserve)process.value=null;
 try{const primary=request<HealthProcessDetail>(`health-processes/${encodeURIComponent(id)}`);
  if(prefetch){const pending=request<HealthProcessActivity>(`health-processes/${encodeURIComponent(id)}/activity?${new URLSearchParams({timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone})}`);void pending.catch(()=>{});initialActivity.value=pending;}
  const next=await primary;if(token!==sequence)return;
  if(next.memberId!==member||member!==app.selectedMemberId.value||!Array.isArray(next.records))throw Error('健康历程不属于当前成员');process.value=next;
  if(!processAnchor.value||!next.records.some(r=>refKey(r.ref)===refKey(processAnchor.value!)))processAnchor.value=next.records[0]?.ref||null;
  if(!editing.value&&!linking.value&&(next.aiState==='pending'||canManage.value&&(next.aiState==='idle'||next.aiState==='stale')))poll=setTimeout(()=>{if(!busy.value&&!editing.value&&!linking.value)void load();},3000);
 }catch(cause){if(token===sequence)error.value=cause instanceof Error?cause.message:'历程加载失败';}finally{if(token===sequence)loading.value=false;}}
function openLinking(){if(!active.value||!process.value||process.value.memberId!==app.selectedMemberId.value||!canManage.value||busy.value||loading.value||editing.value||linking.value)return;
 linkReturnFocus.value=root.value?.querySelector<HTMLElement>('[aria-label="补充记录"]')||null;
 linking.value=true;linkError.value='';key.reset();clearTimeout(poll);
}
function closeLinking(){linking.value=false;linkError.value='';}
function edit(event:MouseEvent){if(!active.value||!process.value||process.value.memberId!==app.selectedMemberId.value||!canManage.value||busy.value||loading.value)return;editReturnFocus.value=event.currentTarget as HTMLElement;editError.value='';clearTimeout(poll);title.value=process.value.title;summary.value=process.value.summary||'';lifecycle.value={...(process.value.lifecycle||{status:'unknown' as const,onsetAt:null,endedAt:null})};stages.value=Object.fromEntries(process.value.records.map(r=>[refKey(r.ref),r.stage]));editing.value=true;leave.reset();}
async function cancel(){if(await leave.confirmLeave()){editing.value=false;linking.value=false;leave.reset();}}
async function save(){if(!active.value||!editing.value||!canManage.value||!process.value||process.value.memberId!==app.selectedMemberId.value||busy.value)return;const token=sequence;busy.value=true;editError.value='';
 try{const next=await request<HealthProcessDetail>(`health-processes/${encodeURIComponent(process.value.id)}`,{method:'PATCH',body:JSON.stringify({fingerprint:process.value.fingerprint,editToken:process.value.editToken,title:title.value,summary:summary.value,lifecycle:lifecycle.value,stages:process.value.records.filter(r=>stages.value[refKey(r.ref)]!==r.stage).map(r=>({ref:r.ref,stage:stages.value[refKey(r.ref)]}))})});
  if(token!==sequence||!active.value||!canManage.value)return;if(next.id!==process.value?.id||next.memberId!==app.selectedMemberId.value||!Array.isArray(next.records))throw Error('保存结果与当前历程不一致');process.value=next;editing.value=false;busy.value=false;leave.reset();app.notifyDataChanged();
 }catch(cause){if(token===sequence)editError.value=cause instanceof Error?cause.message:'保存失败';}finally{if(token===sequence)busy.value=false;}}
async function link(records:ProcessRecordRef[]){if(!active.value||!linking.value||!process.value||process.value.memberId!==app.selectedMemberId.value||!canManage.value||busy.value||!records.length)return;
 const token=contextGeneration;const current=process.value;const member=current.memberId;busy.value=true;linkError.value='';
 try{const body={records,fingerprint:current.fingerprint,editToken:current.editToken};const result=await request<HealthProcessDetail>(`health-processes/${encodeURIComponent(current.id)}/records`,{method:'POST',body:JSON.stringify({...body,requestKey:key.forRequest('process-link',body)})});
  if(token!==contextGeneration||!active.value||member!==app.selectedMemberId.value||!canManage.value||current.id!==process.value?.id)return;
  if(!result||typeof result.id!=='string'||!result.id||result.memberId!==member||!Array.isArray(result.records)||!records.every(ref=>result.records.some(record=>record.ref&&sameRef(record.ref,ref))))throw Error('历程保存结果无效，请刷新后核对');
  process.value=result;closeLinking();busy.value=false;app.notifyDataChanged();
  if(result.id!==current.id)await router.replace({path:'/health-processes/'+encodeURIComponent(result.id),query:{returnTo:backTo.value}});else await load();
 }catch(cause){if(token===contextGeneration&&active.value&&member===app.selectedMemberId.value&&canManage.value)linkError.value=cause instanceof Error?cause.message:'关联失败';}finally{if(token===contextGeneration)busy.value=false;}}

async function organize(){
 if(!process.value||!canManage.value||busy.value||loading.value||editing.value||linking.value||aiOrganizing.value)return;
 const context=contextGeneration;const member=app.selectedMemberId.value;const id=process.value.id;
 const valid=()=>active.value&&context===contextGeneration&&member===app.selectedMemberId.value&&process.value?.id===id&&canManage.value;
 busy.value=true;organizing.value=true;error.value='';clearTimeout(poll);
 try{const next=await request<HealthProcessDetail>(`health-processes/${encodeURIComponent(id)}/organize`,{method:'POST'});
  if(!valid())return;if(next.memberId!==member||next.id!==id)throw Error('整理结果与当前历程不一致，请刷新后核对');
  // Discard a preceding read so its older AI status cannot replace the completed result.
  sequence++;loading.value=false;process.value=next;
  busy.value=false;organizing.value=false;app.notifyDataChanged();if(!['ready','unconfigured'].includes(next.aiState))void load();
 }catch(cause){if(valid()){
  const message=cause instanceof Error?cause.message:'整理失败';busy.value=false;organizing.value=false;
  // An interrupted HTTP response does not prove the server-side job stopped.
  await load();if(valid())error.value=message;
 }}finally{if(valid()){busy.value=false;organizing.value=false;}}
}
function askTrash(){
 const current=process.value;if(!current||!active.value||current.memberId!==app.selectedMemberId.value||!canManage.value||busy.value||loading.value||editing.value||linking.value)return;
 const context=contextGeneration;clearTimeout(poll);
 confirm.ask({title:'移入回收站',message:`将「${current.title}」移入回收站？保留 30 天，期间可以恢复。仅移除健康历程，其中的报告、症状、用药、接种记录及附件全部保留。`,confirmText:'移入回收站',danger:true,onCancel:()=>{if(context===contextGeneration&&active.value)void load();},run:async()=>{
  if(context!==contextGeneration||!active.value||!canManage.value||current.memberId!==app.selectedMemberId.value||busy.value)return;
  const token=++sequence;busy.value=true;error.value='';clearTimeout(poll);
  const body={fingerprint:current.fingerprint,editToken:current.editToken};
  try{
   const result=await request<{id:string;memberId:string;status:string}>(`health-processes/${encodeURIComponent(current.id)}`,{method:'DELETE',body:JSON.stringify({...body,requestKey:trashKey.forRequest('process-trash',body)})});
   if(token!==sequence||context!==contextGeneration||!active.value||current.memberId!==app.selectedMemberId.value||!canManage.value)return;
   if(result.id!==current.id||result.memberId!==current.memberId||result.status!=='trashed')throw Error('历程删除结果无效，请刷新后核对');
   process.value=null;busy.value=false;trashKey.reset();leave.reset();toast.show('健康历程已移入回收站，原始记录保留');await router.replace(backTo.value);app.notifyDataChanged();
  }catch(cause){if(token===sequence)error.value=cause instanceof Error?cause.message:'历程删除失败，请重试';}finally{if(token===sequence)busy.value=false;}
 }});
}
function askRemove(record:ProcessRecordRef){
 if(!process.value||!canManage.value||busy.value||loading.value||editing.value||linking.value)return;
 const current=process.value;const target=current.records.find(item=>sameRef(item.ref,record));if(!target)return;
 const token=contextGeneration;
 const outcome=current.records.length===2?'移出后该历程将不再展示，两条原始记录都会保留。':'原始记录会保留，其余记录仍在当前历程中。';
 confirm.ask({title:'移出历程',message:`将“${target.title}”移出当前历程？${outcome}`,confirmText:'移出历程',run:()=>token===contextGeneration?removeRecord(current,record):undefined});
}
async function removeRecord(current:HealthProcessDetail,record:ProcessRecordRef){
 if(!active.value||!process.value||current.id!==process.value.id||current.memberId!==app.selectedMemberId.value||!canManage.value||busy.value||editing.value||linking.value)return;
 if(!process.value.records.some(item=>sameRef(item.ref,record)))return;
 const token=++sequence;busy.value=true;loading.value=false;clearTimeout(poll);error.value='';
 const body={record,fingerprint:current.fingerprint,editToken:current.editToken};
 try{
  const result=await request<ProcessRecordRemoval>(`health-processes/${encodeURIComponent(current.id)}/records/remove`,{method:'POST',body:JSON.stringify({...body,requestKey:removalKey.forRequest('process-record-remove',body)})});
  if(token!==sequence)return;
  if(result.memberId!==current.memberId||current.memberId!==app.selectedMemberId.value||!result.removed||!sameRef(result.removed,record)||result.process!==null&&(!result.process||result.process.id!==current.id||result.process.memberId!==current.memberId||!Array.isArray(result.process.records)||result.process.records.some(item=>sameRef(item.ref,record))))throw Error('移出结果无效，请刷新后核对');
  process.value=result.process;removalKey.reset();
  if(result.process){app.notifyDataChanged();busy.value=false;await load();}
  else{busy.value=false;leave.reset();await router.replace(backTo.value);app.notifyDataChanged();}
 }catch(cause){if(token===sequence)error.value=cause instanceof Error?cause.message:'移出历程失败';}finally{if(token===sequence)busy.value=false;}
}
function openRecord(ref:ProcessRecordRef,event:MouseEvent){
 if(!touch.value||event.defaultPrevented||event.button!==0||event.ctrlKey||event.metaKey||event.shiftKey||event.altKey)return;
 event.preventDefault();opener.value=event.currentTarget as HTMLElement;const token=createUuid();owned={token,memberId:app.selectedMemberId.value};
 void router.push({path:route.path,query:{...route.query,recordKind:ref.kind,recordId:ref.id},state:{healthProcessEntry:token}});
}
async function restoreRecordFocus(){await nextTick();if(opener.value?.isConnected)opener.value.focus({preventScroll:true});opener.value=null;}
function closeRecord(){
 const owner=owned;owned=null;
 if(owner?.memberId===app.selectedMemberId.value&&router.options.history.state.healthProcessEntry===owner.token){router.back();return;}
 const query={...route.query};delete query.recordKind;delete query.recordId;void router.replace({path:route.path,query});
}
function openReport(id:string){void router.replace({path:route.path,query:{...route.query,recordKind:'report',recordId:id}});}
watch(()=>[route.path,route.query.recordKind,route.query.recordId,touch.value,process.value?.id,process.value?.memberId,active.value],()=>{
 const kind=route.query.recordKind,id=route.query.recordId;const previous=opened.value;
 opened.value=active.value&&process.value?.memberId===app.selectedMemberId.value&&process.value?.id===String(route.params.id)&&route.path.startsWith('/health-processes/')&&touch.value&&isHealthRecordKind(kind)&&typeof id==='string'&&id.length<=200?{kind,id}:null;
 if(previous&&!opened.value){owned=null;void restoreRecordFocus();}
},{immediate:true});
watch(scope,()=>{
 sequence++;contextGeneration++;organizing.value=false;clearTimeout(poll);opened.value=null;owned=null;
 if(!route.path.startsWith('/health-processes/'))return;
 const same=process.value?.id===String(route.params.id)&&process.value?.memberId===app.selectedMemberId.value;
 if(!same){process.value=null;processAnchor.value=null;editing.value=false;linking.value=false;busy.value=false;linkError.value='';leave.reset();}
 void load(same,!same);
},{immediate:true,flush:'sync'});
watch(app.dataVersion,()=>{if(!editing.value&&!linking.value&&!busy.value)void load();});
watch(canManage,allowed=>{if(!allowed){sequence++;editing.value=false;leave.reset();contextGeneration++;closeLinking();busy.value=false;organizing.value=false;}});
onDeactivated(()=>{active.value=false;editing.value=false;leave.reset();closeLinking();sequence++;contextGeneration++;busy.value=false;organizing.value=false;clearTimeout(poll);opened.value=null;});
onActivated(()=>{if(!active.value){active.value=true;void load();}});
onBeforeUnmount(()=>{sequence++;contextGeneration++;clearTimeout(poll);});
</script>
<template>
 <section ref="root" class="plain-page health-process-page">
  <SubPageHeader :title="process?.title||'健康历程'" :back-to="backTo" back-label="返回上一页"><HealthRecordTrashAction v-if="process&&canManage" class="process-trash-action" delegate :disabled="busy||loading||editing||linking||organizing" @request="askTrash"/></SubPageHeader>
  <RecordLoading v-if="loading&&!process" label="正在读取健康历程…"/>
  <p v-if="error&&!editing" class="inline-panel-error" role="alert">{{error}} <button type="button" class="error-retry" @click="load()">重试</button></p>
  <template v-if="process">
   <HealthProcessEditorDialog v-if="editing&&canManage&&active" :busy="busy" :return-focus="editReturnFocus" @close="cancel">    <form class="process-editor" @submit.prevent="save"><div class="process-editor-body"><fieldset :disabled="busy"><label>历程标题<input v-model="title" required maxlength="120"/></label><label>历程摘要<textarea v-model="summary" rows="3" maxlength="2000"/></label><div class="process-lifecycle-fields"><label>历程状态<FormSelect v-model="lifecycle.status" :options="lifecycleOptions" aria-label="历程状态"/></label><label>起病／开始日期（选填）<DateTimePicker v-model="lifecycle.onsetAt" aria-label="起病／开始日期"/></label><label v-if="lifecycle.status==='resolved'">结束日期（选填）<DateTimePicker v-model="lifecycle.endedAt" aria-label="历程结束日期"/></label></div><p class="process-hint">这些日期由你确认，记录范围不会自动作为起病或结束时间。</p><div class="process-stage-fields"><label v-for="record in process.records" :key="refKey(record.ref)"><span>{{record.title}}</span><FormSelect v-model="stages[refKey(record.ref)]" :options="stageOptions" :aria-label="`阶段：${record.title}`"/></label></div><p v-if="editError" class="inline-panel-error" role="alert">{{editError}}</p></fieldset></div><div class="process-form-actions record-form-actions"><button type="button" class="soft-action-button" :disabled="busy" @click="cancel">取消</button><button class="primary-button" type="submit" :disabled="busy">{{busy?'正在保存…':'保存修改'}}</button></div></form> </HealthProcessEditorDialog>
   <section class="settings-band process-overview">
    <div class="process-meta"><span>{{process.recordCount}} 条记录</span><span>{{formatMedicationDate(process.startedAt)||'日期未记录'}}<template v-if="process.latestAt&&process.latestAt!==process.startedAt"> ～ {{formatMedicationDate(process.latestAt)}}</template></span></div>
    <p v-if="process.lifecycle&&(process.lifecycle.status!=='unknown'||process.lifecycle.onsetAt)" class="process-meta process-lifecycle"><span>{{processLifecycleLabels[process.lifecycle.status]}}</span><span v-if="process.lifecycle.onsetAt">起病／开始 {{process.lifecycle.onsetAt}}</span><span v-if="process.lifecycle.endedAt">结束 {{process.lifecycle.endedAt}}</span></p>
    <p v-if="process.summary" class="process-summary">{{process.summary}}</p>
    <div class="process-tools" v-if="canManage"><QuickAddMenu symptom-dialog @symptom="carePanel?.openNewSymptom($event)" placement="inline" label="补充记录" :can-manage="canManage" :disabled="busy||linking||editing" :route-key="route.fullPath" :member-id="process.memberId" :process-id="process.id" @associate="openLinking"/><button type="button" class="process-text-action" :disabled="busy||linking||editing" @click="edit"><Pencil :size="14"/>编辑信息与阶段</button><button v-if="process.aiState!=='unconfigured'" type="button" class="process-text-action" :disabled="busy||linking||editing||loading||aiOrganizing" :aria-busy="aiOrganizing" @click="organize"><LoaderCircle v-if="aiOrganizing" class="spin-icon" :size="14"/><Sparkles v-else :size="14"/>{{aiOrganizing?'正在整理…':process.aiState==='failed'?'重试 AI 整理':'AI 整理'}}</button></div>
   </section>
   <HealthProcessCarePanel :initial-load="initialActivity" ref="carePanel" @edit-member="router.push({path:'/me/members',query:{editMember:process.memberId,returnTo:route.fullPath}})" :process="process" :disabled="busy||editing||linking||loading" @updated="load()"/>
   <section v-if="process.highlights.length" class="settings-band process-highlights"><h3>历程重点</h3><ul><li v-for="(item,index) in process.highlights" :key="index"><p>{{item.text}}</p><div><RouterLink v-for="source in item.sources" :key="refKey(source)" :to="{path:healthRecordPath(source.kind,source.id),query:{returnTo:route.fullPath}}" @click.capture="openRecord(source,$event)">{{process.records.find(r=>refKey(r.ref)===refKey(source))?.title}}</RouterLink></div></li></ul></section>
   <HealthProcessObservations :initial-load="initialActivity" :process="process" :disabled="busy||editing||linking||loading" @updated="load()" @open-record="openRecord"/>
   <HealthProcessFollowups :initial-load="initialActivity" :source-records="process.records" :process-fingerprint="process.fingerprint" :process-edit-token="process.editToken" @completed="id=>{if(id!==process?.id)void router.replace({path:'/health-processes/'+encodeURIComponent(id),query:{returnTo:backTo}})}" compact :member-id="process.memberId" :process-id="process.id" :anchor-record="processAnchor||process.records[0].ref"/>
   <div class="process-timeline-toolbar"><div class="process-timeline-switch" role="group" aria-label="历程排序方式"><button type="button" :aria-pressed="timelineView==='flow'" title="流程阶段倒序，阶段内按时间倒序" @click="changeTimelineView('flow')">流程</button><button type="button" :aria-pressed="timelineView==='time'" title="全部记录按实际发生时间倒序" @click="changeTimelineView('time')">时间</button></div></div>
   <div class="process-stages" :aria-label="timelineView==='flow'?'按流程倒序分组、组内按时间倒序排列的健康历程':'按实际发生时间倒序排列的健康历程'">
    <section v-for="group in groups" :key="group.key" class="process-stage"><h3>{{group.label}} <span>{{group.records.length}}</span></h3><ol><li v-for="record in group.records" :key="refKey(record.ref)" :data-process-record="refKey(record.ref)"><time>{{formatMedicationDate(record.date)||'日期未记录'}}</time><RouterLink class="process-record" :to="{path:healthRecordPath(record.ref.kind,record.ref.id),query:{returnTo:route.fullPath}}" @click.capture="openRecord(record.ref,$event)"><HealthCategoryIcon :category="record.category" :size="24"/><span><strong>{{record.title}}</strong><small v-if="timelineView==='time'||record.institution">{{[timelineView==='time'?processStageLabels[record.stage]:null,record.institution].filter(Boolean).join(' · ')}}</small><p v-if="record.description">{{record.description}}</p><small v-if="record.latestDate&&record.latestDate!==record.date">最近变化：{{formatMedicationDate(record.latestDate)}}</small></span><span class="process-record-open">查看</span></RouterLink></li></ol></section>
   </div>
   <details v-if="canManage" class="settings-band process-record-management"><summary>管理历程记录 <span>{{process.records.length}}</span></summary><p class="process-hint">移出只调整历程归属，原始记录会保留。</p><ul><li v-for="record in process.records" :key="refKey(record.ref)"><RouterLink class="process-managed-record" :to="{path:healthRecordPath(record.ref.kind,record.ref.id),query:{returnTo:route.fullPath}}" @click.capture="openRecord(record.ref,$event)"><HealthCategoryIcon :category="record.category" :size="24"/><span><strong>{{record.title}}</strong><small>{{healthCategoryLabels[record.category]}} · {{formatMedicationDate(record.date)||'日期未记录'}}</small></span></RouterLink><button type="button" class="process-text-action" :disabled="busy||loading||editing||linking" :aria-label="`移出历程：${record.title}`" @click="askRemove(record.ref)">移出历程</button></li></ul></details>
  </template>
  <HealthRecordAssociationModal v-if="linking&&process" :key="scope" :member-id="process.memberId" :exclude="process.records.map(record=>record.ref)" :busy="busy" :error="linkError" :return-focus="linkReturnFocus" @close="closeLinking" @confirm="link"/>
  <HealthRecordDetailModal v-if="opened&&process?.memberId===app.selectedMemberId.value" :open="true" :kind="opened.kind" :record-id="opened.id" @close="closeRecord" @open-report="openReport" @updated="load()"/>
 </section>
</template>
<style scoped>
.health-process-page :deep(.subpage-header > .process-trash-action) { display: flex; flex: 0 0 auto; padding: 0; margin: 0 0 0 auto; }
.process-lifecycle{margin:8px 0 0}.process-lifecycle-fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px;}
.process-timeline-toolbar{display:flex;justify-content:flex-end;margin:0 0 8px;min-height:32px}.process-timeline-switch{display:inline-flex;gap:2px;padding:2px;border:1px solid var(--line);border-radius:8px;background:var(--fill-2)}.process-timeline-switch button{position:relative;min-width:44px;min-height:26px;padding:3px 10px;border:0;border-radius:5px;background:transparent;color:var(--muted);font:inherit;font-size:12px;line-height:18px;cursor:pointer}.process-timeline-switch button[aria-pressed=true]{background:var(--surface);color:var(--brand-strong);box-shadow:0 1px 3px rgb(0 0 0 / 6%)}@media(max-width:760px),(pointer:coarse){.process-timeline-switch button:after{content:'';position:absolute;top:50%;left:0;width:100%;height:44px;transform:translateY(-50%)}}
.process-record-management{padding:12px 14px;margin-top:18px}.process-record-management summary{cursor:pointer;font-size:14px;line-height:22px}.process-record-management summary>span{color:var(--muted);font-size:12px;margin-left:4px}.process-record-management ul{list-style:none;margin:10px 0 0;padding:0}.process-record-management li{display:flex;align-items:center;gap:12px;padding:10px 0;border-top:1px solid var(--line)}.process-managed-record{display:flex;align-items:center;gap:8px;flex:1;min-width:0;color:var(--ink);text-decoration:none}.process-managed-record>span{display:grid;gap:3px;min-width:0}.process-managed-record strong{font-size:14px;font-weight:500;line-height:20px;overflow-wrap:anywhere}.process-managed-record small{font-size:12px;line-height:19px;color:var(--muted)}.process-record-management button{flex-shrink:0;min-height:36px;font-size:12px}

.health-process-page{min-width:0}.health-process-page :deep(.subpage-header h2){font-size:16px;line-height:24px;overflow-wrap:anywhere}.process-overview{overflow:visible;padding:14px;margin-bottom:16px}.process-meta{display:flex;flex-wrap:wrap;gap:6px 12px;color:var(--muted);font-size:12px;line-height:19px}.process-summary{font-size:14px;line-height:1.65;white-space:pre-wrap;overflow-wrap:anywhere;margin:10px 0}.process-tools{display:flex;align-items:center;flex-wrap:wrap;gap:8px 12px;margin-top:10px}.process-tools button{display:flex;align-items:center;gap:5px;font-size:12px;min-height:32px}.process-text-action{padding:4px 0;border:0;background:none;color:var(--brand-strong);cursor:pointer}.process-hint{color:var(--muted);font-size:12px;line-height:19px;margin:8px 0 0}.process-highlights{padding:14px;margin-bottom:16px}.process-highlights h3,.process-stage h3{font-size:16px;line-height:22px;font-weight:500;margin:0}.process-highlights ul{padding-left:18px;margin:10px 0 0}.process-highlights li+li{margin-top:10px}.process-highlights p{margin:0;font-size:14px;line-height:1.6}.process-highlights li>div{display:flex;flex-wrap:wrap;gap:4px 10px;margin-top:4px}.process-highlights a{font-size:12px;color:var(--brand-strong);overflow-wrap:anywhere}.process-stages,.process-stage,.process-stage ol,.process-stage li{min-width:0}.process-stages{display:grid;gap:18px}.process-stage h3 span{font-size:12px;color:var(--muted);margin-left:4px}.process-stage ol{list-style:none;padding:0;margin:10px 0 0 5px;border-left:1px solid var(--line-strong)}.process-stage li{padding-left:16px;position:relative;margin-bottom:12px}.process-stage li:before{content:'';position:absolute;left:-4px;top:6px;width:7px;height:7px;border-radius:50%;background:var(--brand)}.process-stage time{display:block;color:var(--muted);font-size:12px;line-height:18px;margin-bottom:5px}.process-record{display:flex;align-items:flex-start;gap:8px;padding:12px;border:1px solid var(--line);background:var(--surface);border-radius:var(--radius-s);color:var(--ink);text-decoration:none;min-width:0}.process-record>.health-category-icon{width:40px;height:40px}.process-record>span:first-of-type{flex:1;min-width:0}.process-record strong{display:block;font-size:14px;line-height:21px;font-weight:500;max-width:100%;word-break:keep-all;overflow-wrap:break-word}.process-record small{display:block;font-size:12px;line-height:19px;color:var(--muted);margin-top:3px;overflow-wrap:anywhere}.process-record p{font-size:14px;line-height:21px;white-space:pre-wrap;overflow-wrap:anywhere;margin:5px 0 0}.process-record-open{align-self:center;font-size:12px;line-height:21px;flex-shrink:0;color:var(--brand-strong)}.process-editor{display:flex;flex-direction:column;min-height:0;overflow:hidden;margin:0}.process-editor .process-form-actions{flex-shrink:0;margin:0;padding:8px 14px;border-top:1px solid var(--line)}.process-editor-body{min-height:0;overflow:auto;overscroll-behavior:contain;position:relative}.process-editor fieldset{border:0;margin:0;padding:12px 14px;min-width:0;display:grid;gap:12px}.process-editor label{display:grid;gap:6px;font-size:12px;color:var(--muted);min-width:0}.process-editor input,.process-editor textarea{width:100%;padding:8px 10px;border:1px solid var(--line-strong);border-radius:var(--radius-s);background:var(--surface);color:var(--ink);font:inherit;font-size:14px;line-height:21px}.process-stage-fields{display:grid;gap:10px}.process-stage-fields label{grid-template-columns:minmax(0,1fr) 130px;align-items:center}.process-stage-fields label>span{overflow-wrap:anywhere}.process-form-actions{display:flex;justify-content:flex-end;gap:8px}.process-form-actions button{font-size:14px;min-height:34px}.health-process-page a:focus-visible,.health-process-page button:focus-visible{outline:2px solid var(--brand);outline-offset:2px}@media(max-width:760px),(pointer:coarse){.process-overview,.process-highlights{padding:12px}.process-record{padding:10px}.process-record>.health-category-icon{width:24px;height:24px}.process-stage li{padding-left:12px}.process-stages{gap:14px}.process-stage-fields label{grid-template-columns:minmax(0,1fr) 110px}}
</style>
