<script setup lang="ts">
import type {HealthProcessActivity} from '../../../shared/health-process-activity';
import {initialProcessActivity} from '../utils/health-process-activity';
import RecordLoading from './RecordLoading.vue';
import {formatMedicationDate} from '../utils/medication-date';
import { computed, onBeforeUnmount, onDeactivated, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';
import { Plus } from '@lucide/vue';
import HealthProcessEditorDialog from './HealthProcessEditorDialog.vue';
import FormSelect from './FormSelect.vue';
import HealthRecordAssociationModal from './HealthRecordAssociationModal.vue';
import {createSubmissionKey} from '../utils/submission-key';
import DateTimePicker from './DateTimePicker.vue';
import ReportDetailModal from './ReportDetailModal.vue';
import { request } from '../utils/api';
import { useAppContext } from '../composables/useAppContext';
import { useRefreshOnActivate } from '../composables/useRefreshOnActivate';
import {useUnsavedRecord} from '../composables/useUnsavedRecord';
import { useToast } from '../composables/useToast';
import {healthRecordPath} from '../utils/health-record-navigation';
import type {HealthRecordRef} from '../../../shared/health-record-associations';
import type { Reminder } from '../types/api';

const props=defineProps<{initialLoad?:Promise<HealthProcessActivity>;memberId:string;compact?:boolean;processId?:string;anchorRecord?:HealthRecordRef;processFingerprint?:string;processEditToken?:string;sourceRecords?:Array<{ref:HealthRecordRef;title:string;date?:string|null}>}>();
const emit=defineEmits<{completed:[processId:string]}>();
const app=useAppContext();const toast=useToast();
const canManage=computed(()=>props.memberId===app.selectedMemberId.value
  ? app.selectedMember.value?.permission==='manager'
  : app.members.value.find(member=>member.id===props.memberId)?.permission==='manager');
const reminders=ref<Reminder[]>([]);const loading=ref(false);const loaded=ref(false);const error=ref('');
const formOpen=ref(false);const title=ref('');const dueAt=ref<string|null>('');const saving=ref(false);
const createOpener=ref<HTMLElement|null>(null),createError=ref(''),sourceKey=ref('');
const sourceOptions=computed(()=>props.sourceRecords?.map(record=>({value:record.ref.kind+':'+record.ref.id,label:record.title+(record.date?' · '+formatMedicationDate(record.date):'')}))||[]);
function quickDate(days:number){const value=new Date();value.setDate(value.getDate()+days);dueAt.value=`${value.getFullYear()}-${String(value.getMonth()+1).padStart(2,'0')}-${String(value.getDate()).padStart(2,'0')}`;}
const pendingId=ref('');const rescheduleId=ref('');const rescheduleDate=ref<string|null>('');
const previewReportId=ref<string|null>(null);const completedOpen=ref(false),dismissedOpen=ref(false),showAllPending=ref(false);
const recordChoice=ref<Reminder|null>(null),actionOpener=ref<HTMLElement|null>(null);
const completion=ref<{item:Reminder;opener:HTMLElement|null;fingerprint?:string;editToken?:string}|null>(null);const completionError=ref('');const completionKey=createSubmissionKey();

const leave=useUnsavedRecord(()=>JSON.stringify([formOpen.value?[title.value,dueAt.value,sourceKey.value]:null,rescheduleId.value?[rescheduleId.value,rescheduleDate.value]:null]),computed(()=>saving.value||Boolean(pendingId.value)));
function toggleForm(event:MouseEvent){openCreate(event.currentTarget as HTMLElement);}
async function cancelForm(){if(await leave.confirmLeave()){formOpen.value=false;leave.reset();}}
let scopeVersion=0;let loadVersion=0;
const scoped=computed(()=>reminders.value.filter(item=>!props.processId||item.processes?.some(p=>p.id===props.processId)));
const reminderGroups=computed(()=>[
 {key:'pending',items:scoped.value.filter(item=>item.status==='pending').slice().sort((a,b)=>a.dueAt.localeCompare(b.dueAt)).slice(0,showAllPending.value?undefined:3)},
 {key:'completed',items:scoped.value.filter(item=>item.status==='completed').slice().sort((a,b)=>b.dueAt.localeCompare(a.dueAt))},
 {key:'dismissed',items:scoped.value.filter(item=>item.status==='dismissed').slice().sort((a,b)=>b.dueAt.localeCompare(a.dueAt))}
]);
function groupOpen(key:string){return key==='pending'||(key==='completed'?completedOpen.value:dismissedOpen.value);}
function toggleHistory(key:string){if(key==='completed')completedOpen.value=!completedOpen.value;else dismissedOpen.value=!dismissedOpen.value;}
const rescheduleItem=computed(()=>scoped.value.find(item=>item.id===rescheduleId.value));
function openRecordChoice(item:Reminder,event:MouseEvent){if(!canManage.value||pendingId.value)return;actionOpener.value=event.currentTarget as HTMLElement;recordChoice.value=item;}
const hasContext=(item:Reminder)=>item.vaccinationId||item.completedVaccinationId||item.completedRecord||item.relatedRecord||item.processes?.some(p=>p.id!==props.processId);
const pending=computed(()=>scoped.value.filter(item=>item.status==='pending').length);
function contextQuery(item:Reminder){return {memberId:props.memberId,reminderId:item.id,
  ...(item.relatedRecord?{relatedKind:item.relatedRecord.kind,relatedId:item.relatedRecord.id}:{}),...(props.processId?{returnTo:'/health-processes/'+encodeURIComponent(props.processId)}:{})};}
function statusLabel(item:Reminder){return item.status==='completed'?(item.completedVaccinationId?'已完成 · 已关联接种':item.completedRecord?'已完成 · 已关联复查记录':'已完成 · 手工标记')
  :item.status==='dismissed'?'已忽略':'待处理';}
async function refresh(initial=false){
  const current=++loadVersion;const memberId=props.memberId;
  if(!memberId){reminders.value=[];loading.value=false;return true;}
  loading.value=true;error.value='';
  try{const result=(initial&&props.initialLoad&&props.processId?await initialProcessActivity(props.initialLoad,{id:props.processId,memberId,fingerprint:props.processFingerprint},'reminders'):undefined)??await request<Reminder[]>(props.processId?`health-processes/${encodeURIComponent(props.processId)}/followups`:`reminders?memberId=${encodeURIComponent(memberId)}`);
    if(current!==loadVersion||memberId!==props.memberId)return false;
    if(!Array.isArray(result)||result.some(item=>item.memberId!==memberId))throw Error('提醒数据不属于当前成员，请刷新重试');
    reminders.value=result;loaded.value=true;return true;
  }catch(cause){if(current===loadVersion)error.value=cause instanceof Error?cause.message:'复查提醒加载失败';return false;}
  finally{if(current===loadVersion)loading.value=false;}
}
watch(()=>JSON.stringify([props.memberId,props.processId,props.processId?null:props.anchorRecord]),()=>{
  scopeVersion++;completion.value=null;completionError.value='';completedOpen.value=false;dismissedOpen.value=false;showAllPending.value=false;recordChoice.value=null;reminders.value=[];loaded.value=false;formOpen.value=false;title.value='';dueAt.value='';rescheduleId.value='';previewReportId.value=null;pendingId.value='';saving.value=false;leave.reset();void refresh(true);
},{immediate:true});
watch(canManage,allowed=>{if(!allowed){recordChoice.value=null;formOpen.value=false;rescheduleId.value='';completion.value=null;leave.reset();}});
onBeforeUnmount(()=>{scopeVersion++;loadVersion++;});
useRefreshOnActivate(()=>void refresh());
function openCreate(opener?:HTMLElement){if(!canManage.value||formOpen.value||saving.value||pendingId.value)return;title.value='';dueAt.value='';createOpener.value=opener||document.activeElement as HTMLElement;createError.value='';sourceKey.value=props.anchorRecord?props.anchorRecord.kind+':'+props.anchorRecord.id:sourceOptions.value[0]?.value||'';formOpen.value=true;leave.reset();}
defineExpose({refresh,openCreate});
onDeactivated(()=>{scopeVersion++;recordChoice.value=null;formOpen.value=false;rescheduleId.value='';saving.value=false;completion.value=null;pendingId.value='';leave.reset();});
async function createReminder(){
  if(!canManage.value||!formOpen.value||saving.value||!props.memberId)return;
  const scope=scopeVersion;const memberId=props.memberId;saving.value=true;createError.value='';
  const source=props.sourceRecords?.length?props.sourceRecords.find(record=>record.ref.kind+':'+record.ref.id===sourceKey.value)?.ref:props.anchorRecord;
  if(props.processId&&!source){saving.value=false;createError.value='请选择依据记录';return;}
  const payload={memberId,title:title.value,dueAt:dueAt.value,...(source?{relatedRecord:source}:{})};
  try{await request('reminders',{method:'POST',body:JSON.stringify(payload)});app.notifyDataChanged();
    if(scope!==scopeVersion)return;formOpen.value=false;title.value='';dueAt.value='';leave.reset();await refresh();void app.refreshReminderCount(memberId);toast.show('复查提醒已创建');
  }catch(cause){if(scope===scopeVersion)createError.value=cause instanceof Error?cause.message:'创建提醒失败';}
  finally{if(scope===scopeVersion)saving.value=false;}
}
async function update(item:Reminder,status:Reminder['status'],date?:string|null){
  if(!canManage.value||pendingId.value||item.memberId!==props.memberId)return;
  const scope=scopeVersion;pendingId.value=item.id;error.value='';
  try{await request(`reminders/${encodeURIComponent(item.id)}`,{method:'PUT',body:JSON.stringify({status,...(date?{dueAt:date}:{})})});app.notifyDataChanged();
    if(scope!==scopeVersion)return;rescheduleId.value='';leave.reset();await refresh();void app.refreshReminderCount(props.memberId);
    toast.show(date?'复查日期已更新':status==='completed'?'已手工标记完成':status==='pending'?'提醒已恢复':'提醒已忽略');
  }catch(cause){if(scope===scopeVersion)error.value=cause instanceof Error?cause.message:'更新提醒失败';}
  finally{if(scope===scopeVersion)pendingId.value='';}
}
function selectReport(item:Reminder,event?:MouseEvent){if(!canManage.value||pendingId.value||props.memberId!==app.selectedMemberId.value)return;recordChoice.value=null;completion.value={item,opener:event?.currentTarget as HTMLElement||actionOpener.value,fingerprint:props.processFingerprint,editToken:props.processEditToken};completionError.value='';completionKey.reset();}
async function completeWithReport(records:HealthRecordRef[]){
 const current=completion.value;if(!current||!canManage.value||pendingId.value||records.length!==1)return;
 const scope=scopeVersion;const memberId=props.memberId;const selectedMember=app.selectedMemberId.value;pendingId.value=current.item.id;completionError.value='';
 const body={memberId,record:records[0],...(props.processId?{processId:props.processId,fingerprint:current.fingerprint,editToken:current.editToken}:{})};
 try{const result=await request<{id:string;memberId:string;status:string;processId:string|null;completedRecord:HealthRecordRef}>(`reminders/${encodeURIComponent(current.item.id)}/complete-record`,{method:'POST',body:JSON.stringify({...body,requestKey:completionKey.forRequest('reminder-complete',body)})});
  if(scope!==scopeVersion||!canManage.value||memberId!==props.memberId||selectedMember!==app.selectedMemberId.value)return;
  if(result.id!==current.item.id||result.memberId!==memberId||result.status!=='completed'||result.completedRecord?.id!==records[0].id||result.completedRecord.kind!=='report'||result.processId!==null&&typeof result.processId!=='string')throw Error('复查保存结果无效，请刷新后核对');
  completion.value=null;completedOpen.value=true;pendingId.value='';app.notifyDataChanged();await refresh();if(scope!==scopeVersion||selectedMember!==app.selectedMemberId.value)return;void app.refreshReminderCount(memberId);toast.show('已关联复查报告并完成提醒');if(result.processId)emit('completed',result.processId);
 }catch(cause){if(scope===scopeVersion)completionError.value=cause instanceof Error?cause.message:'关联复查报告失败';}finally{if(scope===scopeVersion)pendingId.value='';}
}
async function cancelReschedule(){if(await leave.confirmLeave()){rescheduleId.value='';leave.reset();}}
function postpone(item:Reminder,event:MouseEvent){actionOpener.value=event.currentTarget as HTMLElement;rescheduleId.value=item.id;rescheduleDate.value=item.dueAt;leave.reset();}
</script>

<template>
  <section class="health-followups" :class="{'is-compact':compact}" aria-label="复查与待办">
    <header class="followup-heading"><div><h3>复查与待办 <small v-if="pending">{{ pending }} 项待处理</small></h3><p v-if="!compact">计划与已发生记录分开展示，完成复查后再补充资料。</p></div><button v-if="canManage" class="soft-action-button" type="button" @click="toggleForm"><Plus :size="16"/>添加提醒</button></header>
    <HealthProcessEditorDialog v-if="formOpen&&canManage" title="添加复查与待办" close-label="关闭新增提醒" :busy="saving" :return-focus="createOpener" @close="cancelForm">
      <form class="followup-create-form" @submit.prevent="createReminder"><div class="followup-create-body"><fieldset :disabled="saving">
        <label>事项<input v-model="title" maxlength="180" placeholder="如：复查血常规、携带报告复诊" required/></label>
        <div class="followup-shortcuts" role="group" aria-label="常用事项"><button v-for="item in ['复查','复诊','复查检查结果']" :key="item" type="button" @click="title=item">{{item}}</button></div>
        <label>计划日期<DateTimePicker v-model="dueAt" aria-label="到期日期" :disabled="saving"/></label>
        <div class="followup-shortcuts" role="group" aria-label="计划日期快捷选择"><button v-for="day in [7,14,30]" :key="day" type="button" @click="quickDate(day)">{{day}} 天后</button></div>
        <label v-if="sourceOptions.length">依据记录<FormSelect v-model="sourceKey" :options="sourceOptions" aria-label="依据记录" :disabled="saving"/></label>
        <p class="followup-create-hint">{{processId?'保存后归入当前历程。':''}}完成后可上传或选择已有复查报告。</p>
        <p v-if="createError" class="inline-panel-error" role="alert">{{createError}}</p>
      </fieldset></div><footer class="form-actions record-form-actions"><button type="button" :disabled="saving" @click="cancelForm">取消</button><button class="primary-button" type="submit" :disabled="saving||!title.trim()||!dueAt">{{saving?'正在保存…':'保存提醒'}}</button></footer></form>
    </HealthProcessEditorDialog>
    <p v-if="error" class="inline-panel-error" role="alert">{{ error }} <button type="button" @click="refresh()">重新加载</button></p>
    <RecordLoading v-if="loading&&!loaded" label="正在读取复查提醒…"/>
    <p v-else-if="loaded&&!error&&!pending" class="followup-empty">{{scoped.length?'暂无待处理事项。':'暂无复查与待办。'}}</p>
    <template v-for="group in reminderGroups" :key="group.key">
      <button v-if="group.key!=='pending'&&group.items.length" type="button" class="followup-history-toggle" :aria-expanded="groupOpen(group.key)" @click="toggleHistory(group.key)">{{group.key==='completed'?'已完成':'已忽略'}} {{group.items.length}} 项 <span aria-hidden="true">{{groupOpen(group.key)?'收起':'展开'}}</span></button>
      <div v-if="group.items.length&&groupOpen(group.key)" class="data-list reminder-list">
        <article v-for="item in group.items" :key="item.id" :data-reminder="item.id">
          <div class="followup-item-heading"><strong>{{item.title}}</strong><span class="chip status-label" :class="item.status==='completed'?'chip--green':item.status==='pending'?'chip--amber':''">{{statusLabel(item)}}</span></div>
          <p class="followup-meta"><span>计划 {{formatMedicationDate(item.dueAt)}}</span><span>{{item.vaccinationId?'下一剂接种':item.source==='report_suggestion'?'报告复查建议':'手工提醒'}}</span></p>
          <div v-if="hasContext(item)||item.reportId" class="followup-context">
            <RouterLink v-if="item.vaccinationId" :to="healthRecordPath('vaccination',item.vaccinationId)">来源接种</RouterLink>
            <RouterLink v-else-if="item.relatedRecord" :to="healthRecordPath(item.relatedRecord.kind,item.relatedRecord.id)">{{item.reportTitle?'依据：'+item.reportTitle:'来源记录'}}</RouterLink>
            <button v-else-if="item.reportId" type="button" @click="previewReportId=item.reportId">查看报告</button>
            <RouterLink v-for="process in (item.processes||[]).filter(p=>p.id!==processId)" :key="process.id" :to="'/health-processes/'+encodeURIComponent(process.id)">{{process.title}}</RouterLink>
            <RouterLink v-if="item.completedRecord" :to="healthRecordPath(item.completedRecord.kind,item.completedRecord.id)">复查资料</RouterLink>
            <RouterLink v-if="item.completedVaccinationId" :to="healthRecordPath('vaccination',item.completedVaccinationId)">本次接种</RouterLink>
          </div>
          <div v-if="canManage" class="followup-actions">
            <template v-if="item.status==='pending'">
              <RouterLink v-if="item.vaccinationId" class="soft-action-button" :to="{path:'/add/vaccination',query:{sourceVaccinationId:item.vaccinationId,reminderId:item.id,memberId:props.memberId,relatedKind:'vaccination',relatedId:item.vaccinationId,returnTo:props.processId?'/health-processes/'+encodeURIComponent(props.processId):'/reminders'}}">填写下一剂接种</RouterLink>
              <button v-else class="soft-action-button" type="button" :disabled="Boolean(pendingId)" @click="openRecordChoice(item,$event)">记录复查</button>
              <button type="button" class="followup-text-button" :disabled="Boolean(pendingId)" @click="postpone(item,$event)">延期</button>

                <button type="button" class="followup-text-button" :disabled="Boolean(pendingId)" @click="update(item,'completed')">手工标记完成</button>
                <button type="button" class="followup-text-button" :disabled="Boolean(pendingId)" @click="update(item,'dismissed')">忽略</button>

            </template>
            <button v-else-if="!item.completedVaccinationId" type="button" class="followup-text-button" :disabled="Boolean(pendingId)" @click="update(item,'pending')">恢复待处理</button>
          </div>
        </article>
      </div>
      <button v-if="group.key==='pending'&&pending>3" type="button" class="followup-history-toggle" :aria-expanded="showAllPending" @click="showAllPending=!showAllPending">{{showAllPending?'收起待办':'查看全部 '+pending+' 项待办'}}</button>
    </template>
    <HealthProcessEditorDialog v-if="recordChoice&&canManage" title="记录复查" close-label="关闭记录复查" :busy="false" :return-focus="actionOpener" @close="recordChoice=null">
      <div class="followup-choice-body"><p>{{recordChoice.title}}</p><RouterLink class="soft-action-button" :to="{path:'/upload',query:contextQuery(recordChoice)}" @click="recordChoice=null">上传新资料</RouterLink><button type="button" class="soft-action-button" @click="selectReport(recordChoice)">选择已有报告</button></div>
    </HealthProcessEditorDialog>
    <HealthProcessEditorDialog v-if="rescheduleItem&&canManage" title="调整计划日期" close-label="关闭日期调整" :busy="Boolean(pendingId)" :return-focus="actionOpener" @close="cancelReschedule">
      <form class="followup-create-form followup-reschedule" @submit.prevent="update(rescheduleItem,'pending',rescheduleDate)">
        <div class="followup-create-body"><fieldset :disabled="Boolean(pendingId)"><p class="followup-dialog-context">{{rescheduleItem.title}}</p><label>新的复查日期<DateTimePicker v-model="rescheduleDate" aria-label="新的复查日期"/></label><p v-if="error" class="inline-panel-error" role="alert">{{error}}</p></fieldset></div>
        <footer class="form-actions record-form-actions"><button type="button" :disabled="Boolean(pendingId)" @click="cancelReschedule">取消</button><button class="primary-button" :disabled="Boolean(pendingId)||!rescheduleDate">{{pendingId?'正在保存…':'保存日期'}}</button></footer>
      </form>
    </HealthProcessEditorDialog>
    <HealthRecordAssociationModal v-if="completion&&canManage" :key="completion.item.id" :member-id="memberId" :exclude="completion.item.relatedRecord?[completion.item.relatedRecord]:[]" report-only :max-selections="1" title="选择复查报告" :hint="processId?'选择一份报告完成本次复查。报告将加入当前历程；若属于其他历程，将合并历程。':'选择一份已有报告完成复查。有来源记录时，将关联相应健康历程；若已有不同历程，会合并历程。'" confirm-text="关联并完成" :busy="Boolean(pendingId)" :error="completionError" :return-focus="completion.opener" @close="completion=null" @confirm="completeWithReport"/>
    <ReportDetailModal :open="Boolean(previewReportId)" :report-id="previewReportId" @close="previewReportId=null" @updated="refresh()"/>
  </section>
</template>
<style scoped>
.followup-create-form{display:flex;flex-direction:column;min-height:0;overflow:hidden}.followup-create-body{min-height:0;overflow:auto;position:relative;overscroll-behavior:contain}.followup-create-body fieldset{display:grid;gap:10px;padding:12px 14px;margin:0;border:0;min-width:0}.followup-create-body label{display:grid;gap:6px;font-size:12px;color:var(--muted);min-width:0}.followup-create-body input{width:100%;padding:8px 10px;border:1px solid var(--line-strong);border-radius:var(--radius-s);background:var(--surface);color:var(--ink);font:inherit;font-size:14px}.followup-create-body input:focus{border-color:var(--brand);outline:2px solid var(--brand-soft)}.followup-create-form footer{flex-shrink:0;margin:0;padding:8px 14px;border-top:1px solid var(--line)}.followup-shortcuts{display:flex;flex-wrap:wrap;gap:6px}.followup-shortcuts button{padding:4px 8px;min-height:28px;border:0;border-radius:6px;background:var(--fill-2);color:var(--brand-strong);font:inherit;font-size:12px}.followup-create-hint{margin:0;font-size:12px;line-height:19px;color:var(--muted)}

.health-followups{margin:12px 0;min-width:0}.followup-heading{display:flex;align-items:center;gap:8px;margin-bottom:10px}.followup-heading>div{flex:1;min-width:0}.followup-heading h3{margin:0;font-size:16px;line-height:22px;font-weight:500}.followup-heading small{font-size:12px;font-weight:400;color:var(--muted);margin-left:6px}.followup-heading>button{flex-shrink:0;white-space:nowrap;font-size:12px;min-height:32px;padding:5px 10px}.followup-heading p,.followup-empty{margin:4px 0 0;font-size:12px;line-height:20px;color:var(--muted)}
.health-followups .reminder-list{box-shadow:none;border:1px solid var(--line);border-radius:var(--radius-s)}.health-followups .reminder-list>article{padding:10px 12px;gap:6px;min-height:0}.health-followups .followup-item-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:8px}.followup-item-heading strong{min-width:0;overflow-wrap:anywhere;font-size:14px;line-height:21px;font-weight:500}.followup-item-heading .status-label{flex-shrink:0;font-size:12px;font-weight:400;line-height:18px;padding:2px 6px;max-width:55%;white-space:normal;text-align:right}
.followup-meta{display:flex;flex-wrap:wrap;gap:4px 12px;margin:0;line-height:18px;color:var(--muted);font-size:12px}.health-followups .followup-context{display:flex;flex-wrap:wrap;gap:4px 12px;font-size:12px;line-height:18px;min-width:0}.followup-context a,.followup-context button{color:var(--brand-strong);overflow-wrap:anywhere;text-align:left}.followup-context button{border:0;background:none;padding:0;font:inherit;cursor:pointer}
.health-followups .followup-actions{display:flex;align-items:center;flex-wrap:wrap;gap:4px 10px;margin-top:2px}.followup-actions>.soft-action-button{font-size:12px;line-height:18px;min-height:30px;padding:5px 10px;font-weight:500}.followup-text-button{border:0;background:none;padding:5px 2px;min-height:30px;color:var(--muted);font:inherit;font-size:12px;cursor:pointer}.followup-text-button:hover{color:var(--brand-strong)}
.followup-history-toggle{display:flex;align-items:center;gap:8px;width:100%;margin:6px 0;padding:5px 0;min-height:30px;border:0;background:none;color:var(--muted);font:inherit;font-size:12px;text-align:left;cursor:pointer}.followup-history-toggle>span{margin-left:auto;color:var(--brand-strong)}
.followup-dialog-context,.followup-choice-body>p{margin:0;font-size:14px;line-height:21px;overflow-wrap:anywhere}.followup-choice-body{display:grid;gap:10px;padding:12px 14px;overflow:auto}.followup-choice-body>.soft-action-button{justify-content:center;font-size:14px;min-height:36px}.followup-actions button:focus-visible,.followup-history-toggle:focus-visible{outline:2px solid var(--brand);outline-offset:2px}.health-followups button:disabled{cursor:wait;opacity:.6}
</style>
