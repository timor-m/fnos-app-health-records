<script setup lang="ts">
import HealthRecordAssociations from './HealthRecordAssociations.vue';
import type {HealthRecordRef} from '../../../shared/health-record-associations';
import HealthRecordTrashAction from './HealthRecordTrashAction.vue';
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import RecordLoading from './RecordLoading.vue';
import VaccinationEditor from './VaccinationEditor.vue';
import VaccinationDetail from './VaccinationDetail.vue';
import ReportDetail from './ReportDetail.vue';
import { documentStatusMeta, type HealthRecordHeading } from '../utils/health-record-presentation';
import { vaccinationFromReport } from '../utils/vaccination';
import { formatMedicationDate } from '../utils/medication-date';
import { useAppContext } from '../composables/useAppContext';
import { request } from '../utils/api';
import { confirmUnsavedRecordChanges } from '../utils/record-edit-guards';
import type { ReportDetail as Detail, VaccinationRecord } from '../types/api';
import type { VaccinationEntry } from '../../../shared/health-categories';
const props = defineProps<{reportId:string;hideTitle?:boolean;openRelatedInPlace?:boolean}>();
const emit = defineEmits<{heading:[value:HealthRecordHeading];updated:[];close:[];openReport:[id:string];openRecord:[record:HealthRecordRef]}>();
const app = useAppContext();
const detail = ref<Detail|null>(null); const records = ref<VaccinationEntry[]>([]); const source = ref<Partial<VaccinationEntry>|null>(null);
const selected = ref(''); const retainedRecordId = ref(''); const error = ref(''); const statusError = ref(''); let sequence = 0; let alive = true;
const canManage = computed(() => app.selectedMember.value?.permission === 'manager');
const choices = computed(() => {
  const linked = records.value.filter(record => record.sourceReportId === props.reportId || record.id === retainedRecordId.value);
  const facts = (detail.value?.vaccinations || []).map(fact => ({key:`fact:${fact.id}`, fact, entry:linked.find(entry => entry.sourceFactId === fact.id)}));
  return [...facts,...linked.filter(entry => !facts.some(item => item.entry?.id === entry.id)).map(entry => ({key:`entry:${entry.id}`, fact:undefined, entry}))];
});
const current = computed(() => choices.value.find(item => item.key === selected.value) || choices.value[0]);
const fact = computed(() => current.value?.fact);
const selectedRecord = computed(() => current.value?.entry);
const pendingStatus = computed(() => ['ready','needs_review'].includes(detail.value?.status || '') ? {label:'待完善',chip:'chip--amber'} : documentStatusMeta[detail.value?.status || '']);
async function load() {
  const token = ++sequence; const member = app.selectedMemberId.value; detail.value = null; source.value = null; selected.value = ''; retainedRecordId.value = ''; records.value = []; error.value = ''; statusError.value = '';
  const [report, entries] = await Promise.allSettled([request<Detail>(`reports/${encodeURIComponent(props.reportId)}`),request<VaccinationEntry[]>(`vaccinations?memberId=${encodeURIComponent(member)}`)]);
  if (!alive || token !== sequence || member !== app.selectedMemberId.value) return;
  if (report.status === 'rejected') { error.value = report.reason instanceof Error ? report.reason.message : '读取接种信息失败'; return; }
  if (report.value.memberId !== member) { error.value = '接种信息不属于当前成员'; return; }
  detail.value = report.value;
  if (entries.status === 'fulfilled' && Array.isArray(entries.value) && entries.value.every(item => item.memberId === member)) records.value = entries.value;
  else statusError.value = '接种信息暂时无法完整读取，请重试后编辑；原件附件仍可查看。';
}
function attachmentLoaded(next:Detail) {
  if (next.id === props.reportId && next.memberId === app.selectedMemberId.value && detail.value) detail.value = next;
}
function start() { if (detail.value && canManage.value && !statusError.value) source.value = vaccinationFromReport(detail.value,fact.value); }
function saved(entry:VaccinationEntry) {
  records.value = [entry,...records.value.filter(item => item.id !== entry.id)]; source.value = null;
  retain(entry); emit('updated');
}
function retain(entry:VaccinationEntry) {
  retainedRecordId.value = entry.id;
  selected.value = entry.sourceReportId === props.reportId && detail.value?.vaccinations.some(fact => fact.id === entry.sourceFactId) ? `fact:${entry.sourceFactId}` : `entry:${entry.id}`;
}
function changed(entry:VaccinationEntry) { records.value = records.value.map(item => item.id===entry.id?entry:item); retain(entry); }
async function select(key:string) { if (key !== current.value?.key && await confirmUnsavedRecordChanges()) selected.value = key; }
watch(() => [detail.value?.title,current.value], () => {
  if (detail.value) emit('heading',{title:selectedRecord.value?.vaccineName || fact.value?.vaccineName || detail.value.title,category:'vaccination'});
});
watch(() => [props.reportId,app.selectedMemberId.value], () => { void load(); }, {immediate:true,flush:'sync'});
onBeforeUnmount(() => { alive = false; sequence++; });
</script>
<template>
  <section class="vaccination-document-detail">
    <p v-if="error" role="alert" class="inline-panel-error record-detail-state">{{error}} <button type="button" class="error-retry" @click="load">重试</button></p>
    <template v-if="detail">
      <VaccinationEditor v-if="source" :source="source" :report="detail" @saved="saved" @cancel="source=null"/>
      <template v-else>
        <nav v-if="choices.length > 1" class="vaccination-entry-tabs record-detail-inset" aria-label="原件中的接种">
          <button v-for="item in choices" :key="item.key" type="button" class="soft-action-button" :aria-pressed="current?.key===item.key" @click="select(item.key)">{{item.entry?.vaccineName || item.fact?.vaccineName}}<span v-if="item.entry?.doseNumber || item.fact?.doseNumber"> · {{item.entry?.doseNumber || item.fact?.doseNumber}}</span></button>
        </nav>
        <VaccinationDetail v-if="selectedRecord" :key="selectedRecord.id" :record-id="selectedRecord.id" :initial-entry="selectedRecord" :association-subject="{kind:'report',id:reportId}" :open-related-in-place="openRelatedInPlace" @open-record="emit('openRecord',$event)" @heading="emit('heading',$event)" @changed="changed" @updated="emit('updated')" @close="emit('close')" @open-report="select(choices.find(item => !item.entry)?.key || choices[0]?.key || '')"/>
        <template v-else>
          <HealthRecordTrashAction :target="{kind:'report',id:detail.id,memberId:detail.memberId,title:detail.title,revision:null}" @trashed="emit('updated');emit('close')"><div class="preview-heading"><span v-if="pendingStatus" class="chip" :class="pendingStatus.chip">{{pendingStatus.label}}</span></div></HealthRecordTrashAction>
          <div class="record-detail-inset record-detail-stack">
            <p v-if="statusError" role="alert" class="record-detail-caption">{{statusError}} <button type="button" class="vaccination-inline-action" @click="load">重试</button></p>
            <h3 v-if="!hideTitle" class="record-detail-title vaccination-detail-name">{{fact?.vaccineName || detail.title}}</h3>
            <dl class="preview-facts record-detail-facts"><div><dt>接种日期</dt><dd>{{formatMedicationDate(fact?.administeredAt) || '待完善'}}</dd></div><div v-if="fact?.doseNumber"><dt>剂次</dt><dd>{{fact.doseNumber}}</dd></div><div v-if="detail.hospitalName"><dt>接种机构</dt><dd>{{detail.hospitalName}}</dd></div><div v-if="fact?.manufacturer"><dt>生产厂家</dt><dd>{{fact.manufacturer}}</dd></div><div v-if="fact?.lotNumber"><dt>批号</dt><dd>{{fact.lotNumber}}</dd></div><div v-if="fact?.administrationSite"><dt>接种部位</dt><dd>{{fact.administrationSite}}</dd></div></dl>
            <p class="record-detail-caption">完善并保存接种信息后，可安排下一剂提醒。</p>
            <div v-if="canManage" class="form-actions record-detail-actions"><button type="button" :disabled="!!statusError" @click="start">完善接种</button></div>
            <HealthRecordAssociations :subject="{kind:'report',id:reportId}" :member-id="detail.memberId" :open-in-place="openRelatedInPlace" @open-record="emit('openRecord',$event)" @updated="emit('updated')"/>
            <ReportDetail :report-id="reportId" :expected-member-id="app.selectedMemberId.value" :summary="detail" originals-only hide-title hide-trash-action variant="panel" @loaded="attachmentLoaded" @updated="emit('updated')"/>
          </div>
        </template>
      </template>
    </template>
    <RecordLoading v-else-if="!error" label="正在读取接种…"/>
  </section>
</template>
<style scoped>
.vaccination-entry-tabs { display:flex;gap:6px;overflow-x:auto;padding-block:6px; }
.vaccination-entry-tabs button { flex-shrink:0; }
.vaccination-entry-tabs button[aria-pressed="true"] { color:var(--brand-strong);background:var(--brand-softer); }
</style>
