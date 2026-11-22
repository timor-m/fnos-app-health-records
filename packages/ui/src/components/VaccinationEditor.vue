<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onDeactivated, reactive, ref, watch } from 'vue';
import { useAppContext } from '../composables/useAppContext';
import { useUnsavedRecord } from '../composables/useUnsavedRecord';
import { Paperclip, Upload, X } from '@lucide/vue';
import { request, requestUpload } from '../utils/api';
import { vaccinationAttachmentError } from '../utils/vaccination-attachments';
import { createUuid } from '../utils/uuid';
import { createSubmissionKey } from '../utils/submission-key';
import { vaccinationFromReport } from '../utils/vaccination';
import HealthRecordAssociationField from './HealthRecordAssociationField.vue';
import type { HealthRecordRef } from '../../../shared/health-record-associations';
import DateTimePicker from './DateTimePicker.vue';
import FormSelect from './FormSelect.vue';
import FormSuggest from './FormSuggest.vue';
import ReportDetailModal from './ReportDetailModal.vue';
import type { ReportDetail, VaccinationRecord } from '../types/api';
import type { VaccinationEntry } from '../../../shared/health-categories';

const props = defineProps<{entry?: VaccinationEntry; source?: Partial<VaccinationEntry>; focusReminder?: boolean; report?: ReportDetail; credentialTarget?: HTMLElement | null;processId?:string;initialRelatedRecords?:HealthRecordRef[]}>();
const emit = defineEmits<{saved: [entry: VaccinationEntry]; cancel: []}>();
const app = useAppContext();
const root = ref<HTMLFormElement | null>(null);
const doseOptions = ['第 1 剂', '第 2 剂', '第 3 剂', '加强剂'].map(dose => ({ value: dose, label: dose }));
const attachmentInput = ref<HTMLInputElement|null>(null);
const attachments = ref<Array<{id:string;file:File}>>([]);
const uploadProgress = ref(0);
const form = reactive({vaccineName:'', doseNumber:'', administeredAt:null as string|null, organizationName:'', manufacturer:'', lotNumber:'', administrationSite:'', note:'', nextDueAt:null as string|null, relatedRecords:[] as HealthRecordRef[], sourceReportId:''});
const sourceFactId = ref<string|null>(null);
const reminderEnabled = ref(false);
const reminderOpen = ref(false);
const sourceDetail = ref<ReportDetail|null>(null);
const sourceFacts = ref<VaccinationRecord[]>([]);
const credentialLoading = ref(false);
const credentialMessage = ref('');
const documents = ref<Array<{id:string;title:string}>>([]);
const optionErrors = reactive({documents:''});
const documentsLoading = ref(false);
const fieldErrors = reactive({vaccineName:'', administeredAt:'', nextDueAt:'', sourceReportId:''});
const busy = ref(false);
const error = ref('');
const preview = ref(false);
const key = createSubmissionKey();
let sequence = 0;
let credentialSequence = 0;
let alive = true;
let autofilled: Record<string, unknown> = {};
let originalAdministeredAt: string | undefined;
let originalNextDueAt: string | undefined;
const leave = useUnsavedRecord(() => JSON.stringify([form, sourceFactId.value, reminderEnabled.value,attachments.value.map(item=>item.id)]), busy);
const scope = computed(() => JSON.stringify([props.entry?.id, props.entry?.revision, props.source, props.report?.id, props.report?.sourceVersion,props.initialRelatedRecords, props.processId, app.selectedMemberId.value]));
const documentOptions = computed(() => {
  const items = [...documents.value];
  if (form.sourceReportId && !items.some(item => item.id === form.sourceReportId)) items.unshift({id:form.sourceReportId,title:'当前关联原件'});
  return [...(form.sourceReportId ? [{value:'',label:'不关联原件'}] : []), ...items.map(item => ({value:item.id,label:item.title}))];
});
const reminderLocked = computed(() => Boolean(props.entry?.nextVaccinationId));
const reminderDismissed = computed(() => props.entry?.reminderStatus === 'dismissed' && day(originalNextDueAt) === form.nextDueAt);
function day(value: string | null | undefined) { return value?.slice(0,10) || null; }
function today() { const now = new Date(); return `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`; }
function validDay(value: string | null) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0,10) === value;
}
async function loadDocuments() {
  const token = sequence;
  const member = app.selectedMemberId.value;
  optionErrors.documents = '';
  documentsLoading.value = true;
  try {
    const items = await request<Array<{id:string;title:string}>>(`vaccinations/documents?memberId=${encodeURIComponent(member)}`);
    if (!alive || token !== sequence || member !== app.selectedMemberId.value) return;
    if (!Array.isArray(items)) throw Error();
    documents.value = items;
  } catch { if (alive && token === sequence) optionErrors.documents = '原件列表暂时无法读取，仍可手动填写。'; }
  finally { if (alive && token === sequence) documentsLoading.value = false; }
}
watch(scope, () => {
  sequence++; credentialSequence++; busy.value = false; error.value = ''; attachments.value = []; uploadProgress.value = 0; key.reset();
  const value = props.entry || props.source;
  Object.assign(form, {vaccineName:value?.vaccineName||'',doseNumber:value?.doseNumber||'',administeredAt:day(value?.administeredAt),organizationName:value?.organizationName||'',manufacturer:value?.manufacturer||'',lotNumber:value?.lotNumber||'',administrationSite:value?.administrationSite||'',note:value?.note||'',nextDueAt:day(value?.nextDueAt),relatedRecords:[...(props.initialRelatedRecords||[])],sourceReportId:value?.sourceReportId||''});
  originalAdministeredAt = value?.administeredAt; originalNextDueAt = value?.nextDueAt || undefined;
  sourceFactId.value = value?.sourceFactId || null;
  reminderEnabled.value = Boolean(value?.nextDueAt);
  reminderOpen.value = Boolean(props.focusReminder || value?.nextDueAt);
  preview.value = false; credentialLoading.value = false; credentialMessage.value = '';
  sourceDetail.value = props.report || null; sourceFacts.value = props.report?.vaccinations || []; documents.value = []; autofilled = props.entry ? {} : {...form};
  for (const field of Object.keys(fieldErrors) as Array<keyof typeof fieldErrors>) fieldErrors[field] = '';
  leave.reset(); void loadDocuments();
}, {immediate:true, flush:'sync'});

function applyFact(fact?: VaccinationRecord) {
  if (!sourceDetail.value) return;
  const next = vaccinationFromReport(sourceDetail.value, fact);
  sourceFactId.value = fact?.id || null;
  for (const field of ['vaccineName','doseNumber','organizationName','manufacturer','lotNumber','administrationSite','administeredAt','nextDueAt'] as const) {
    const value = field.endsWith('At') ? day(next[field]) : next[field] || '';
    if (!form[field] || form[field] === autofilled[field]) {
      Object.assign(form, {[field]:value}); autofilled[field] = value;
      if (field === 'administeredAt') originalAdministeredAt = next.administeredAt;
      if (field === 'nextDueAt') { originalNextDueAt = next.nextDueAt || undefined; reminderEnabled.value = Boolean(value); if (value) reminderOpen.value = true; }
    }
  }
  fieldErrors.sourceReportId = '';
  credentialMessage.value = '已带入可识别的信息，请核对；已手动填写的内容保持不变。';
}
async function chooseDocument(id: string, retry = false) {
  if (busy.value || attachments.value.length || !retry && id === form.sourceReportId) return;
  const token = ++credentialSequence; const owner = sequence; const member = app.selectedMemberId.value;
  form.sourceReportId = id; sourceFactId.value = null; sourceDetail.value = null; sourceFacts.value = []; credentialMessage.value = ''; fieldErrors.sourceReportId = '';
  credentialLoading.value = Boolean(id);
  if (!id) return;
  try {
    const report = await request<ReportDetail>(`reports/${encodeURIComponent(id)}`);
    if (!alive || owner !== sequence || token !== credentialSequence || member !== app.selectedMemberId.value) return;
    if (report.memberId !== member) { form.sourceReportId = ''; throw Error('这份原件不属于当前成员'); }
    sourceDetail.value = report; sourceFacts.value = report.vaccinations || [];
    if (sourceFacts.value.length <= 1) applyFact(sourceFacts.value[0]);
    else credentialMessage.value = '请选择这份原件中的一条接种信息。';
  } catch (cause) {
    if (alive && owner === sequence && token === credentialSequence) credentialMessage.value = cause instanceof Error ? cause.message : '原件内容暂时无法读取，可手动填写后保存。';
  } finally { if (owner === sequence && token === credentialSequence) credentialLoading.value = false; }
}
function pickAttachments(event:Event) {
  const input = event.target as HTMLInputElement;
  const files = Array.from(input.files || []); input.value = '';
  if (busy.value || form.sourceReportId || !files.length) return;
  error.value = '';
  error.value=vaccinationAttachmentError([...attachments.value.map(item=>item.file),...files]);
  if(error.value)return;
  attachments.value.push(...files.map(file=>({id:createUuid(),file})));
}
function validate() {
  fieldErrors.vaccineName = form.vaccineName.trim() ? '' : '请填写疫苗名称';
  fieldErrors.administeredAt = !validDay(form.administeredAt) ? '请选择接种日期' : form.administeredAt! > today() ? '接种日期不能晚于今天' : '';
  fieldErrors.nextDueAt = reminderEnabled.value && !reminderLocked.value && (!validDay(form.nextDueAt) || Boolean(form.administeredAt && form.nextDueAt! < form.administeredAt)) ? '请选择不早于本次接种的下一剂日期' : '';
  fieldErrors.sourceReportId = sourceFacts.value.length > 1 && !sourceFactId.value ? '请选择原件中的接种条目，或取消原件关联' : '';
  const valid = !Object.values(fieldErrors).some(Boolean);
  if (!valid) { reminderOpen.value ||= Boolean(fieldErrors.nextDueAt); void nextTick(() => (root.value?.querySelector<HTMLElement>('[aria-invalid="true"] input, input[aria-invalid="true"], [aria-invalid="true"] button') || props.credentialTarget?.querySelector<HTMLElement>('[aria-invalid="true"] button'))?.focus()); }
  return valid;
}
async function save() {
  if (busy.value || credentialLoading.value || app.selectedMember.value?.permission !== 'manager' || !validate()) return;
  const token = sequence; const memberId = app.selectedMemberId.value; busy.value = true; error.value = '';
  try {
    const body = {...form,...(props.processId?{processId:props.processId}:{}), vaccineName:form.vaccineName.trim(), administeredAt:day(originalAdministeredAt) === form.administeredAt ? originalAdministeredAt : form.administeredAt,
      nextDueAt:reminderEnabled.value ? day(originalNextDueAt) === form.nextDueAt ? originalNextDueAt : form.nextDueAt : null,
      memberId, completedReminderId:props.entry?.completedReminderId||props.source?.completedReminderId||null, revision:props.entry?.revision, sourceReportId:form.sourceReportId||null, sourceFactId:sourceFactId.value};
    let value:VaccinationEntry;
    if (attachments.value.length) {
      const data = new FormData();
      const payload = {...body,...(props.entry?{id:props.entry.id}:{})};
      data.append('payload',JSON.stringify({...payload,requestKey:key.forRequest('vaccination.original.save',{...payload,files:attachments.value.map(item=>item.id)})}));
      for (const item of attachments.value) data.append('files',item.file,item.file.name);
      uploadProgress.value = 0;
      value = await requestUpload<VaccinationEntry>('vaccinations/with-original',data,percent=>{if(alive&&token===sequence)uploadProgress.value=percent;});
    } else value = await request<VaccinationEntry>(props.entry?`vaccinations/${encodeURIComponent(props.entry.id)}`:'vaccinations', {method:props.entry?'PATCH':'POST',body:JSON.stringify({...body,...(!props.entry?{requestKey:key.forRequest('vaccination.create',body)}:{})})});
    if (!alive || token !== sequence || memberId !== app.selectedMemberId.value) return;
    if (value.memberId !== memberId) throw Error('保存结果与当前成员不一致，请刷新后查看');
    busy.value = false; leave.reset(); app.notifyDataChanged(); void app.refreshReminderCount?.(); emit('saved',value);
  } catch (cause) { if (alive && token === sequence) error.value = cause instanceof Error ? cause.message : '保存失败'; }
  finally { if (token === sequence) busy.value = false; }
}
async function cancel() { if (await leave.confirmLeave()) emit('cancel'); }
onDeactivated(() => { sequence++; credentialSequence++; busy.value = false; });
onBeforeUnmount(() => { alive = false; sequence++; credentialSequence++; });
</script>

<template>
  <form ref="root" class="settings-form vaccination-form" :aria-busy="busy" novalidate @submit.prevent="save">
    <fieldset :disabled="busy" class="vaccination-fields record-detail-inset">
      <Teleport :to="credentialTarget || 'body'" :disabled="!credentialTarget">
      <div class="vaccination-source-toolbar">
        <FormSelect class="vaccination-source-picker" :model-value="form.sourceReportId" :options="documentOptions" placeholder="关联原件" :disabled="busy || !!attachments.length" :aria-invalid="!!fieldErrors.sourceReportId" aria-label="接种原件" :panel-min-width="280" :hint="documentsLoading ? '正在加载原件…' : optionErrors.documents" empty-text="暂无接种原件，可先手动填写。" @update:model-value="chooseDocument"/>
      </div>
      </Teleport>
      <div v-if="form.sourceReportId || optionErrors.documents || credentialMessage" class="vaccination-source-feedback">
        <p v-if="optionErrors.documents" class="record-detail-caption">{{optionErrors.documents}} <button type="button" class="vaccination-inline-action" @click="loadDocuments()">重试</button></p>
        <p v-if="credentialLoading" role="status" class="record-detail-caption">正在读取原件内容…</p>
        <p v-else-if="source?.sourceReportId && !credentialMessage" class="record-detail-caption">已关联原件，请核对接种信息后保存。</p>
        <div v-if="sourceFacts.length>1" class="vaccination-fact-choices" role="group" aria-label="原件中的接种条目"><button v-for="fact in sourceFacts" :key="fact.id" type="button" :aria-pressed="sourceFactId===fact.id" @click="applyFact(fact)">{{[fact.vaccineName,fact.doseNumber,day(fact.administeredAt)].filter(Boolean).join(' · ')}}</button></div>
        <small v-if="fieldErrors.sourceReportId" class="vaccination-field-error">{{fieldErrors.sourceReportId}}</small>
        <p v-if="credentialMessage" role="status" class="record-detail-caption">{{credentialMessage}}</p>
        <div v-if="form.sourceReportId" class="record-detail-actions"><button type="button" class="vaccination-inline-action" @click="preview=true">查看原件</button><button v-if="!sourceDetail&&!credentialLoading" type="button" class="vaccination-inline-action" @click="chooseDocument(form.sourceReportId,true)">重新读取原件</button></div>
      </div>
      <label>疫苗名称（必填）<input v-model="form.vaccineName" aria-label="疫苗名称" required maxlength="180" :aria-invalid="!!fieldErrors.vaccineName" @input="fieldErrors.vaccineName=''"/><small v-if="fieldErrors.vaccineName" class="vaccination-field-error">{{fieldErrors.vaccineName}}</small></label>
      <div class="vaccination-field" :aria-invalid="!!fieldErrors.administeredAt">
        <div class="vaccination-field-heading"><span>接种日期（必填）</span><button type="button" class="vaccination-inline-action" @click="form.administeredAt=today();fieldErrors.administeredAt=''">今天</button></div>
        <DateTimePicker v-model="form.administeredAt" aria-label="接种日期" label="选择接种日期" @update:model-value="fieldErrors.administeredAt=''"/>
        <small v-if="fieldErrors.administeredAt" class="vaccination-field-error">{{fieldErrors.administeredAt}}</small>
      </div>
      <div class="form-grid vaccination-core-secondary">
        <label>剂次（选填）<FormSuggest v-model="form.doseNumber" :options="doseOptions" label="剂次" maxlength="80" placeholder="选择或填写剂次" :disabled="busy" /></label>
        <label>接种机构（选填）<input v-model="form.organizationName" aria-label="接种机构" maxlength="180" placeholder="接种医院或门诊"/></label>
      </div>
      <section v-if="!form.sourceReportId" class="vaccination-attachments" aria-label="原件附件">
        <header><span>原件附件（选填）</span><button type="button" class="soft-action-button" :disabled="busy" @click="attachmentInput?.click()"><Upload :size="14"/>上传附件</button></header>
        <input ref="attachmentInput" type="file" accept=".jpg,.jpeg,.png,.webp,.heic,.heif,.pdf,image/jpeg,image/png,image/webp,image/heic,image/heif,application/pdf" multiple hidden aria-label="选择接种附件" @change="pickAttachments"/>
        <ul v-if="attachments.length"><li v-for="item in attachments" :key="item.id"><Paperclip :size="14"/><span>{{item.file.name}}</span><button type="button" class="plain-icon-button" :aria-label="`移除附件：${item.file.name}`" :disabled="busy" @click="attachments=attachments.filter(file=>file.id!==item.id)"><X :size="14"/></button></li></ul>
        <p class="record-detail-caption">{{attachments.length?'附件将在保存接种时一起上传。':'支持图片、PDF，单文件不超过 40 MB。'}}</p>
        <p v-if="busy && attachments.length" class="record-detail-caption" role="status">{{uploadProgress<100?`正在上传附件 ${uploadProgress}%`:'附件已上传，正在保存接种…'}}</p>
      </section>
      <details><summary>补充说明（选填）</summary><div class="vaccination-extra-fields"><label>补充说明<textarea v-model="form.note" aria-label="补充说明" maxlength="2000" placeholder="有需要再填写"/></label></div></details>
      <details><summary>更多信息（选填）</summary><div class="vaccination-extra-fields"><label>生产厂家<input v-model="form.manufacturer" maxlength="180"/></label><label>批号<input v-model="form.lotNumber" maxlength="120"/></label><label>接种部位<input v-model="form.administrationSite" maxlength="120"/></label></div></details>
      <p v-if="!entry&&processId" class="preview-hint">保存后加入当前健康历程。</p>
      <HealthRecordAssociationField v-else-if="!entry" :key="scope" v-model="form.relatedRecords" :member-id="app.selectedMemberId.value" :disabled="busy"/>
      <details :open="reminderOpen" @toggle="reminderOpen=($event.target as HTMLDetailsElement).open"><summary>下一剂提醒（选填）<small v-if="reminderEnabled&&form.nextDueAt"> · {{form.nextDueAt}}</small></summary><div class="vaccination-extra-fields"><p v-if="reminderLocked" class="record-detail-caption">下一剂已登记，请在下一剂记录中安排后续提醒。</p><template v-else><label class="vaccination-reminder-toggle"><input v-model="reminderEnabled" type="checkbox"/>{{reminderDismissed?'保留下一剂日期（提醒已取消）':'提醒我下一剂接种'}}</label><div v-if="reminderEnabled" class="vaccination-field" :aria-invalid="!!fieldErrors.nextDueAt"><DateTimePicker v-model="form.nextDueAt" aria-label="下一剂日期" label="选择下一剂日期" @update:model-value="fieldErrors.nextDueAt=''"/><small v-if="fieldErrors.nextDueAt" class="vaccination-field-error">{{fieldErrors.nextDueAt}}</small><span class="record-detail-caption">{{reminderDismissed?'原日期的提醒已取消，可返回详情恢复；修改日期将重新安排。':'保存后安排提醒，日期请按接种原件或接种机构的安排填写。'}}</span></div></template></div></details>
      <p v-if="error" role="alert" class="inline-panel-error">{{error}}</p>
    </fieldset>
    <footer class="form-actions vaccination-editor-actions vaccination-save-bar"><button type="button" class="soft-action-button" :disabled="busy" @click="cancel">取消</button><button type="submit" class="primary-button" :disabled="busy||credentialLoading">{{busy?'正在保存…':entry?'保存修改':'保存记录'}}</button></footer>
    <ReportDetailModal v-if="preview" :open="true" :report-id="form.sourceReportId" originals-only hide-vaccination-confirmation @close="preview=false"/>
  </form>
</template>

<style scoped>
.vaccination-attachments input[hidden] { display:none; }
.vaccination-attachments { display:grid;gap:8px;min-width:0; }
.vaccination-attachments header { display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:14px;color:var(--ink-2); }
.vaccination-attachments header button { flex:0 0 auto;min-height:32px;padding:5px 10px;font-size:12px;line-height:20px; }
.vaccination-attachments ul { display:grid;gap:4px;margin:0;padding:0;list-style:none; }
.vaccination-attachments li { display:flex;align-items:center;gap:6px;min-width:0;padding:4px 8px;border-radius:8px;background:var(--fill-2);font-size:12px; }
.vaccination-attachments li>svg { flex-shrink:0;color:var(--muted); }
.vaccination-attachments li>span { flex:1;min-width:0;overflow-wrap:anywhere; }
.vaccination-attachments p { margin:0; }
@media(max-width:760px),(pointer:coarse) {
  .vaccination-attachments header button { position:relative;min-height:28px;padding:3px 8px; }
  .vaccination-attachments header button::after { content:'';position:absolute;inset:-8px 0; }
}
</style>
