<script setup lang="ts">
import { formatMedicationFrequency } from '../../../shared/medication-frequency';
import type { HealthRecordRef } from '../../../shared/health-record-associations';
import HealthCategoryIcon from './HealthCategoryIcon.vue';
import RecordLoading from './RecordLoading.vue';
import type { HealthRecordHeading } from '../utils/health-record-presentation';
import { computed, nextTick, onActivated, onBeforeUnmount, onDeactivated, ref, watch } from 'vue';
import MedicationEditor from './MedicationEditor.vue';
import MedicationRecordDetail from './MedicationRecordDetail.vue';
import HealthRecordTrashAction from './HealthRecordTrashAction.vue';
import HealthRecordAssociations from './HealthRecordAssociations.vue';
import { PencilLine } from '@lucide/vue';
import ReportDetailModal from './ReportDetailModal.vue';
import { useAppContext } from '../composables/useAppContext';
import { useRefreshOnActivate } from '../composables/useRefreshOnActivate';
import { request } from '../utils/api';
import { formatMedicationDate } from '../utils/medication-date';
import { medicationActionLabels, medicationStatusLabels } from '../../../shared/medications';
import type { HistoricalMedication, MedicationAction, MedicationContext, MedicationCourse, MedicationFields,
  MedicationIntake, MedicationOverview } from '../types/medications';
import type { MedicationDocument } from '../../../shared/medications';

const props=defineProps<{courseId?:string;intakeId?:string;reportId?:string;add?:'course'|'intake';entryMode?:'report'|'course'|'intake';entrySource?:HistoricalMedication;processId?:string;initialRelatedRecords?:HealthRecordRef[];openRelatedInPlace?:boolean;separateEntry?:boolean}>();
const emit=defineEmits<{heading:[value:HealthRecordHeading];updated:[];close:[];entry:[mode:'report'|'course'|'intake',source?:HistoricalMedication];back:[];completed:[record?:MedicationCourse|MedicationIntake];viewCourse:[id:string];openRecord:[record:HealthRecordRef]}>();
const app=useAppContext();
const data=ref<MedicationOverview>({courses:[],intakes:[]});const history=ref<HistoricalMedication[]>([]);
const loading=ref(false);const error=ref('');const historyError=ref('');const search=ref('');
const savedMessage=ref('');
const historyExpanded=ref(false);let sequence=0;let alive=true;let active=true;
type Editor={mode:'course'|'intake';course?:MedicationCourse;action?:Exclude<MedicationAction,'start'>;intake?:MedicationIntake;source?:HistoricalMedication};
const editor=ref<Editor|null>(null);
const editorContainer=ref<HTMLElement|null>(null);
const sourceReportId=ref<string|null>(null);
const reportDocument=ref<MedicationDocument|null>(null);const reportError=ref('');
const focused=ref<{courseId?:string;intakeId?:string}|null>(null);
const historyContainer=ref<HTMLElement|null>(null);
const targetCourseId=computed(()=>focused.value?.courseId || props.courseId);
const targetIntakeId=computed(()=>focused.value?.intakeId || props.intakeId);
const reportReady=computed(()=>!props.reportId || reportDocument.value?.id===props.reportId && reportDocument.value.memberId===app.selectedMemberId.value);
const canManage=computed(()=>app.selectedMember.value?.permission==='manager' && reportReady.value);
const initialContext=computed<MedicationContext>(()=>({
  ...(props.processId?{processId:props.processId}:{}),...(props.initialRelatedRecords?{relatedRecords:props.initialRelatedRecords}:{})
}));
const targeted=computed(()=>Boolean(targetCourseId.value || targetIntakeId.value));
const scoped=computed(()=>Boolean(targeted.value || props.reportId));
const selectedCourses=computed(()=>{
  if(targetCourseId.value)return data.value.courses.filter(course=>course.id===targetCourseId.value);
  if(targetIntakeId.value){const intake=data.value.intakes.find(item=>item.id===targetIntakeId.value);return data.value.courses.filter(course=>course.id===intake?.courseId);}
  if(props.reportId)return data.value.courses.filter(course=>course.sourceReportId===props.reportId);
  return scoped.value ? data.value.courses : [];
});
const selectedIntakes=computed(()=>{
  if(targetIntakeId.value)return data.value.intakes.filter(intake=>intake.id===targetIntakeId.value);
  if(targetCourseId.value)return data.value.intakes.filter(intake=>intake.courseId===targetCourseId.value);
  if(props.reportId){const ids=new Set(selectedCourses.value.map(course=>course.id));return data.value.intakes.filter(intake=>intake.courseId && ids.has(intake.courseId));}
  return scoped.value ? data.value.intakes : [];
});
const activeCourses=computed(()=>selectedCourses.value.filter(course=>course.status!=='stopped'));
const stoppedCourses=computed(()=>selectedCourses.value.filter(course=>course.status==='stopped'));

const visibleHistory=computed(()=>history.value.filter(item=>(!props.reportId || item.reportId===props.reportId) && (!search.value.trim()
  || `${item.medicationName} ${item.specification || ''} ${item.reportTitle}`.toLocaleLowerCase().includes(search.value.trim().toLocaleLowerCase()))));
function usage(item:Partial<MedicationFields>){return [item.specification,item.dosageForm,[item.dose,item.doseUnit].filter(Boolean).join(' '),formatMedicationFrequency(item.frequency),item.route].filter(Boolean).join(' · ');}
function displayTime(value:string){return formatMedicationDate(value);}
function currentScope(){return JSON.stringify([app.selectedMemberId.value,props.courseId,props.intakeId,props.reportId,props.add,props.entryMode,props.entrySource]);}
async function load() {
  if(!active || !alive)return;
  const memberId=app.selectedMemberId.value;const scope=currentScope();const current=++sequence;loading.value=true;error.value='';historyError.value='';reportError.value='';
  if(!memberId){data.value={courses:[],intakes:[]};history.value=[];loading.value=false;return;}
  const params=new URLSearchParams({memberId});
  const results=await Promise.allSettled([
    request<MedicationOverview>(`medications?${params}`),
    (historyExpanded.value || props.reportId) ? request<HistoricalMedication[]>(`medications/report-history?memberId=${encodeURIComponent(memberId)}`) : Promise.resolve([]),
    props.reportId ? request<MedicationDocument[]>(`medications/documents?memberId=${encodeURIComponent(memberId)}`) : Promise.resolve([])
  ]);
  if(current!==sequence || !alive || !active || scope!==currentScope())return;
  const [overview,historical,documents]=results;
  if(props.reportId){
    reportDocument.value=documents.status==='fulfilled' ? documents.value.find(item=>item.id===props.reportId && item.memberId===memberId) || null : null;
    if(!reportDocument.value){
      reportError.value=documents.status==='rejected' ? '用药单暂时无法加载，请重试' : '这张用药单不属于当前成员或已不可用，请返回记录列表';
      editor.value=null;sourceReportId.value=null;data.value={courses:[],intakes:[]};history.value=[];loading.value=false;return;
    }
  }
  if(overview.status==='fulfilled'){
    const value=overview.value;
    if(!Array.isArray(value?.courses) || !Array.isArray(value?.intakes)
      || value.courses.some(item=>item.memberId!==memberId) || value.intakes.some(item=>item.memberId!==memberId)){
      data.value={courses:[],intakes:[]};error.value='用药记录与当前成员不一致，请重试';
    }else if((targetCourseId.value && !value.courses.some(item=>item.id===targetCourseId.value)) || (targetIntakeId.value && !value.intakes.some(item=>item.id===targetIntakeId.value))){
      data.value={courses:[],intakes:[]};error.value='这条用药记录已变化或不属于当前范围，请刷新记录列表';
    }else data.value=value;
  }else {data.value={courses:[],intakes:[]};error.value=overview.reason instanceof Error ? overview.reason.message : '用药记录加载失败';}
  if(historical.status==='fulfilled')history.value=historical.value;
  else {history.value=[];historyError.value=historical.reason instanceof Error ? historical.reason.message : '历史处方加载失败';}
  loading.value=false;
}
function openEditor(value:Editor){
  if(!alive || !active || !canManage.value || !app.selectedMemberId.value)return;
  if(props.separateEntry && props.entryMode==='report' && !value.course && !value.intake && !value.action){emit('entry',value.mode,value.source);return;}
  savedMessage.value='';editor.value=value;void nextTick(()=>{editorContainer.value?.scrollIntoView?.({behavior:'smooth',block:'start'});editorContainer.value?.querySelector<HTMLInputElement>('input[name=medicationName]')?.focus();});
}
function startEntry(mode:'report'|'course'|'intake'){if(props.separateEntry){emit('entry',mode);return;}if(mode==='report')showHistory();else openEditor({mode});}
function cancelEditor(){if(props.entryMode)emit('back');else editor.value=null;}
async function saved(record?:MedicationCourse|MedicationIntake){
  if(props.entryMode){emit('updated');emit('completed',record);return;}
  editor.value=null;savedMessage.value='用药记录已保存，已同步到记录列表。';
  if(record?.id && record.memberId===app.selectedMemberId.value){
    if('status' in record){data.value.courses=[record,...data.value.courses.filter(item=>item.id!==record.id)];focused.value={courseId:record.id};}
    else {data.value.intakes=[record,...data.value.intakes.filter(item=>item.id!==record.id)];focused.value={intakeId:record.id};}
  }
  emit('updated');await load();
}
function trashed(){emit('updated');if(props.courseId||props.intakeId){emit('close');emit('completed');}else clearFocus();}
function focusCourse(id:string){if(props.separateEntry&&props.entryMode==='report'){emit('viewCourse',id);return;}editor.value=null;focused.value={courseId:id};savedMessage.value='';void load();}
function clearFocus(){focused.value=null;editor.value=null;savedMessage.value='';void load();}
function showHistory(){historyExpanded.value=true;void load();void nextTick(()=>historyContainer.value?.scrollIntoView?.({behavior:'smooth',block:'start'}));}
const showCurrent=computed(()=>!props.entryMode && scoped.value && !error.value);
const showStopped=computed(()=>!props.entryMode && stoppedCourses.value.length>0);
const showIntakes=computed(()=>!props.entryMode && scoped.value && !error.value);
const trashTarget=computed(()=>{if(loading.value||error.value||editor.value)return undefined;const item=targetIntakeId.value?selectedIntakes.value[0]:targetCourseId.value?selectedCourses.value[0]:undefined;return item?{kind:targetIntakeId.value?'intake' as const:'medication' as const,id:item.id,memberId:item.memberId,title:item.medicationName,revision:item.revision}:undefined;});
const reportCourses=computed(()=>props.reportId ? data.value.courses.filter(course=>course.sourceReportId===props.reportId) : []);

async function intakeTrashed(){emit('updated');await load();}
function browseHistory(){historyExpanded.value=!historyExpanded.value;if(historyExpanded.value)void load();}
watch([loading,reportDocument,selectedCourses,selectedIntakes],()=>{
 if(loading.value)return;
 const title=props.reportId?reportDocument.value?.title:targetIntakeId.value?selectedIntakes.value[0]?.medicationName:targetCourseId.value?selectedCourses.value[0]?.medicationName:undefined;
 if(title)emit('heading',{title,category:'medication'});
});
watch(currentScope,()=>{
  editor.value=canManage.value && (props.entryMode==='course'||props.entryMode==='intake') ? {mode:props.entryMode,source:props.entrySource} : props.add==='intake' && canManage.value ? {mode:'intake'} : null;focused.value=null;
  sourceReportId.value=null;reportDocument.value=null;reportError.value='';savedMessage.value='';data.value={courses:[],intakes:[]};history.value=[];search.value='';historyExpanded.value=Boolean(props.reportId || props.entryMode==='report');void load();
},{immediate:true});
watch(()=>canManage.value,value=>{if(!value)editor.value=null;});
onDeactivated(()=>{active=false;sequence++;editor.value=null;sourceReportId.value=null;});
onActivated(()=>{active=true;});
useRefreshOnActivate(load);
onBeforeUnmount(()=>{alive=false;sequence++;});
</script>
<template>
  <div class="medication-records" :class="{'is-detail':targeted}">
    <p v-if="!app.selectedMemberId.value" class="medication-empty">请先选择成员。</p>
    <RecordLoading v-else-if="loading && !editor && !data.courses.length && !data.intakes.length && !reportDocument" label="正在加载用药记录…" />
    <template v-else>
      <p v-if="reportError" class="inline-panel-error" role="alert">{{ reportError }} <button type="button" class="error-retry" @click="load">重试</button></p>
      <RecordLoading v-else-if="!reportReady" label="正在核对用药单…" />
      <template v-else>
      <button v-if="focused && !courseId && !intakeId" type="button" class="soft-action-button medication-return" @click="clearFocus">{{ reportId ? '返回这张用药单' : '继续记录其他用药' }}</button>
      <section v-if="!entryMode && !targeted && !editor && !reportId" class="medication-start settings-band">
        <p class="medication-start-description">有报告可直接带入药品和用法；确认后记录为正在使用。</p>
        <div class="medication-start-actions">
          <button type="button" :class="canManage ? 'primary-button' : 'soft-action-button'" @click="startEntry('report')" data-medication-entry="report"><HealthCategoryIcon category="report" :size="20" />{{ canManage ? '从报告带入' : '查看报告中的用药' }}</button>
          <button v-if="canManage" type="button" class="soft-action-button" @click="startEntry('course')" data-medication-entry="course"><PencilLine :size="20" />手动添加用药</button>
        </div>
        <div v-if="canManage" class="medication-one-time"><p>按需记录单次服药，无需每天打卡。</p><button type="button" class="soft-action-button" @click="startEntry('intake')" data-medication-entry="intake">记一次已服药</button></div>
      </section>
      <div v-if="editor && canManage" ref="editorContainer" class="medication-entry-editor"><MedicationEditor :key="app.selectedMemberId.value" :member-id="app.selectedMemberId.value" :mode="editor.mode"
        :course="editor.course" :action="editor.action" :intake="editor.intake" :source="editor.source" :hide-header="Boolean(entryMode)" :courses="targeted ? selectedCourses : data.courses"
        :initial-context="initialContext.relatedRecords?.length || initialContext.processId ? initialContext : undefined"
        @saved="saved" @cancel="cancelEditor" /></div>

      <p v-if="error" role="alert">{{ error }} <button type="button" @click="load">重试</button></p>
      <p v-if="savedMessage" class="medication-saved" role="status">{{ savedMessage }}</p>
      <MedicationRecordDetail v-if="targeted && !editor && !error && (selectedCourses.length || selectedIntakes.length)"
        :key="targetIntakeId || targetCourseId" :course="selectedCourses[0]" :intake="targetIntakeId ? selectedIntakes[0] : undefined"
        :open-related-in-place="openRelatedInPlace" :trash-target="trashTarget" :intakes="selectedIntakes" :can-manage="canManage" :busy="loading" :show-name="!courseId && !intakeId"
        @edit-course="action=>openEditor({mode:'course',course:selectedCourses[0],action})"
        @add-intake="openEditor({mode:'intake',course:selectedCourses[0]})" @edit-intake="intake=>openEditor({mode:'intake',intake})"
        @trashed="trashed" @intake-trashed="intakeTrashed" @source="sourceReportId=$event" @parent="emit('openRecord',{kind:'medication',id:$event})" />
      <section v-if="!targeted && showCurrent && (activeCourses.length || (!reportId && !stoppedCourses.length))" class="medication-section">
        <header><h3>已确认的用药</h3><span>{{ activeCourses.length }} 项</span></header>
        <p v-if="!activeCourses.length && !loading" class="medication-empty">暂无确认使用的药品。历史处方需经确认后才会出现在这里。</p>
        <article v-for="course in activeCourses" :key="course.id" class="medication-card">
          <header><strong>{{ course.medicationName }}</strong><span class="medication-status">{{ medicationStatusLabels[course.status] }}</span></header>
          <p v-if="usage(course)">{{ usage(course) }}</p><p v-if="course.instructions">{{ course.instructions }}</p>
          <small>开始于 {{ displayTime(course.startedAt) }}</small>
          <p v-if="course.source" class="medication-source">来源：<button v-if="course.sourceReportId" class="medication-source-link" type="button" @click="sourceReportId=course.sourceReportId">{{ course.source.reportTitle }}</button><span v-else>{{ course.source.reportTitle }}（原报告不可用，已保留确认时快照）</span></p>
          <details v-if="course.source"><summary>确认时的处方</summary><p>{{ course.source.medicationName }} · {{ usage(course.source) }}</p><p v-if="course.source.instructions">{{ course.source.instructions }}</p></details>
          <div class="medication-actions" v-if="canManage">
            <button type="button" class="soft-action-button" @click="openEditor({mode:'intake',course})">记一次已服药</button>
            <button type="button" class="soft-action-button" @click="openEditor({mode:'course',course,action:'adjust'})">调整</button>
            <button type="button" class="soft-action-button" @click="openEditor({mode:'course',course,action:course.status==='paused' ? 'resume' : 'pause'})">{{ course.status==='paused' ? '恢复' : '暂停' }}</button>
            <button type="button" class="soft-action-button" @click="openEditor({mode:'course',course,action:'stop'})">停止</button>
          </div>
          <details><summary>查看使用历史（{{ course.changes.length }}）</summary><ol class="medication-history"><li v-for="change in course.changes" :key="change.id"><strong>{{ medicationActionLabels[change.action] }}</strong> · {{ displayTime(change.occurredAt) }}<p>{{ change.snapshot.medicationName }} · {{ usage(change.snapshot) || '未填写用法' }}</p><p v-if="change.snapshot.instructions">{{ change.snapshot.instructions }}</p><p v-if="change.note">{{ change.note }}</p></li></ol></details>
        </article>
      </section>
      <details class="medication-section" v-if="!targeted && showStopped"><summary>已停止的用药（{{ stoppedCourses.length }}）</summary>
        <article v-for="course in stoppedCourses" :key="course.id" class="medication-card">
          <header><strong>{{ course.medicationName }}</strong><span>已停止</span></header><p>{{ usage(course) }}</p>
          <small>{{ displayTime(course.startedAt) }} 至 {{ displayTime(course.stoppedAt || course.lastChangedAt) }}</small>
          <p v-if="course.source"><button v-if="course.sourceReportId" class="medication-source-link" type="button" @click="sourceReportId=course.sourceReportId">查看来源：{{ course.source.reportTitle }}</button><span v-else>来源已不可用，确认时的记录保留</span></p>
          <details v-if="course.source"><summary>确认时的处方</summary><p>{{ course.source.medicationName }} · {{ usage(course.source) }}</p><p v-if="course.source.instructions">{{ course.source.instructions }}</p></details>
          <details><summary>使用历史（{{ course.changes.length }}）</summary><ol class="medication-history"><li v-for="change in course.changes" :key="change.id">{{ medicationActionLabels[change.action] }} · {{ displayTime(change.occurredAt) }}<p>{{ change.snapshot.medicationName }} · {{ usage(change.snapshot) || '未填写用法' }}</p><p v-if="change.note">{{ change.note }}</p></li></ol></details>
          <button v-if="canManage" type="button" class="soft-action-button" @click="openEditor({mode:'intake',course})">补记一次已服药</button>
        </article>
      </details>
      <section v-if="!targeted && showIntakes && (!reportId || selectedIntakes.length)" class="medication-section">
        <header><h3>服用补充（选填）</h3></header>
        <div v-if="!selectedIntakes.length && !loading" class="medication-empty"><p>尚未按次记录。此项可选，不影响正在用药状态。</p></div>
        <article v-for="intake in selectedIntakes" :key="intake.id" class="medication-card">
          <header><strong>{{ intake.medicationName }}</strong></header>
          <p>{{ intake.amount }} {{ intake.amountUnit }} · {{ displayTime(intake.takenAt) }}</p><small>{{ [intake.specification,intake.dosageForm,intake.route].filter(Boolean).join(' · ') }}</small>
          <p v-if="intake.note">{{ intake.note }}</p>
          <HealthRecordTrashAction v-if="canManage" class="medication-actions medication-intake-toolbar" :target="{kind:'intake',id:intake.id,memberId:intake.memberId,title:intake.medicationName,revision:intake.revision}" :disabled="loading" @trashed="intakeTrashed"><button type="button" class="soft-action-button" :disabled="loading" @click="openEditor({mode:'intake',intake})">编辑</button></HealthRecordTrashAction>
          <details v-if="intake.history.length"><summary>修订记录（{{ intake.history.length }}）</summary><ol class="medication-history"><li v-for="(revision,index) in intake.history" :key="index">{{ revision.operation==='edit' ? '编辑前' : '撤销前' }} · {{ displayTime(revision.recordedAt) }}<p>{{ revision.snapshot.medicationName }} {{ revision.snapshot.specification }} · {{ revision.snapshot.amount }} {{ revision.snapshot.amountUnit }} · {{ displayTime(String(revision.snapshot.takenAt || '')) }}</p></li></ol></details>
        </article>
      </section>
      <section v-if="historyExpanded && !targeted" ref="historyContainer" class="medication-section medication-prescriptions">
        <header v-if="entryMode!=='report'"><h3>{{ reportId ? '报告中的药品' : '从报告选择药品' }}</h3><button v-if="!reportId" class="soft-action-button" type="button" @click="browseHistory">收起</button></header>
        <p class="medication-empty">这些是报告记载的处方或用药信息，不代表目前正在使用。请选择你实际开始使用的药品。</p>
        <p v-if="reportCourses.length" class="medication-confirmed-hint">这张报告已有 {{ reportCourses.length }} 项确认用药，可在上方查看和调整；报告重新识别后原有记录仍保留。</p>
        <input v-if="!reportId" v-model="search" type="search" class="medication-search" placeholder="搜索药品、规格或报告" aria-label="搜索报告用药" />
        <p v-if="historyError" role="alert">{{ historyError }} <button type="button" class="error-retry" @click="load">重试</button></p>
        <div v-if="!visibleHistory.length && !loading && !historyError" class="medication-empty">
          <p>{{ reportId ? '暂未识别出药品，可查看原件，或按实际情况手动记录。' : '没有匹配的报告药品，可手动添加用药。' }}</p>
          <button v-if="canManage" type="button" class="soft-action-button" @click="openEditor({mode:'course'})">手动添加用药</button>
        </div>
        <article v-for="item in visibleHistory" :key="item.medicationId" class="medication-card medication-prescription">
          <header><strong>{{ item.medicationName }}</strong><span v-if="item.confirmedCourseIds.length" class="medication-status">已有确认记录</span></header>
          <p>{{ usage(item) || '原报告未注明详细用法' }}</p><p v-if="item.instructions">{{ item.instructions }}</p>
          <button class="medication-source-link" type="button" @click="sourceReportId=item.reportId">{{ item.reportTitle }} · {{ item.reportIssuedAt ? displayTime(item.reportIssuedAt) : '日期未注明' }}</button>
          <div class="medication-actions">
            <button v-for="id in item.confirmedCourseIds" :key="id" type="button" class="soft-action-button" @click="focusCourse(id)">查看已确认用药{{ item.confirmedCourseIds.length>1 ? ` · ${displayTime(data.courses.find(course=>course.id===id)?.startedAt || '')}` : '' }}</button>
            <button v-if="canManage && !item.confirmedCourseIds.length" type="button" class="primary-button" @click="openEditor({mode:'course',source:item})">确认开始用药</button>
            <button v-if="canManage && item.confirmedCourseIds.length" type="button" class="soft-action-button medication-repeat" @click="openEditor({mode:'course',source:item})">再次开始用药</button>
          </div>
        </article>
      </section>
      <HealthRecordAssociations :open-in-place="openRelatedInPlace" @open-record="emit('openRecord',$event)" v-if="targeted&&!editor&&!loading&&(targetCourseId||targetIntakeId)" :subject="{kind:targetIntakeId?'intake':'medication',id:targetIntakeId||targetCourseId!}" :member-id="app.selectedMemberId.value" @updated="load"/>
      <ReportDetailModal :open="Boolean(sourceReportId)" :report-id="sourceReportId" @close="sourceReportId=null" @updated="load" />
      </template>
    </template>
  </div>
</template>
<style scoped>
.medication-intake-toolbar.record-detail-toolbar { justify-content: flex-start; padding: 0; }
.medication-records.is-detail { gap: 14px; padding: var(--record-inset,16px); }
.medication-records.is-detail > .medication-detail:first-child { margin-top: calc(-1 * var(--record-inset,16px)); }
.medication-records{display:grid;gap:18px}.medication-section>header,.medication-card>header{display:flex;align-items:center;justify-content:space-between;gap:12px}.medication-section h3{margin:0}.medication-empty,.medication-card small{color:var(--muted);font-size:12px;line-height:1.6}.medication-section{display:grid;gap:12px}.medication-section>summary{cursor:pointer;font-weight:600}.medication-section>header>span{font-size:12px;color:var(--muted)}.medication-card{padding:16px;border:1px solid var(--line);border-radius:12px;min-width:0;overflow-wrap:anywhere}.medication-card p{font-size:14px;line-height:1.6;margin:8px 0}.medication-card>details{margin-top:12px;font-size:14px}.medication-card summary{cursor:pointer}.medication-actions{display:flex;gap:8px;flex-wrap:wrap;margin:10px 0}.medication-history{padding-left:20px}.medication-history li{margin:12px 0}.medication-source,.medication-card a{font-size:14px}.medication-status{font-size:12px;white-space:nowrap;padding:3px 9px;border-radius:20px;background:var(--brand-soft)}.medication-checkbox{display:flex;gap:6px;font-size:14px;align-items:center}.medication-checkbox input{width:auto}.medication-search{width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:transparent;color:inherit}@media(max-width:650px){.medication-card{padding:14px}}
.medication-source-link{border:0;padding:0;background:none;color:var(--brand);font:inherit;font-size:14px;cursor:pointer;text-align:left;text-decoration:underline;text-underline-offset:3px}
@media (max-width: 760px), (pointer: coarse) {
  .medication-card { font-size: 14px; line-height: 1.6; }
  .medication-card > header { align-items: flex-start; gap: 8px; }
  .medication-card > header > strong { flex: 1; min-width: 0; font-size: 14px; font-weight: 600; line-height: 1.5; }
  .medication-card > header > span { flex-shrink: 0; font-size: 12px; line-height: 18px; }
  .medication-card p { margin-block: 6px; font-size: 14px; line-height: 1.6; }
  .medication-card small,
  .medication-card .medication-source,
  .medication-card .medication-source-link { font-size: 12px; line-height: 1.6; }
  .medication-card > details { margin-top: 8px; font-size: 12px; }
  .medication-card details strong { font-weight: 600; }
  .medication-card .medication-actions > button { max-width: 100%; font-size: 14px; font-weight: 600; line-height: 20px; white-space: normal; }
}
.medication-start-description { padding: 16px 18px 10px; }
.medication-start p { margin: 0; font-size: 12px; line-height: 1.6; color: var(--muted); }
.medication-start-actions { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; padding: 0 18px 12px; }
.medication-start-actions > button { width: 100%; min-width: 0; min-height: 44px; padding: 8px 10px; justify-content: center; gap: 6px; font-size: 14px; font-weight: 600; line-height: 20px; white-space: normal; }
.medication-start-actions > button:only-child { grid-column: 1 / -1; }
.medication-start-actions > button:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; }
.medication-one-time { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 10px; padding: 10px 18px 12px; border-top: 1px solid var(--line); }
.medication-one-time > p { min-width: 0; font-size: 12px; line-height: 18px; }
.medication-one-time > button { min-height: 44px; margin: 0; padding: 6px 10px; justify-content: center; font-size: 12px; font-weight: 600; line-height: 20px; white-space: nowrap; }
.medication-return{justify-self:start}.medication-confirmed-hint{font-size:12px;color:var(--muted);line-height:1.7}.medication-saved{font-size:14px;color:var(--brand-strong);padding:12px 14px;margin:0;background:var(--brand-soft);border-radius:var(--radius-s)}@media(max-width:520px){.medication-card>header{align-items:flex-start}}
</style>
