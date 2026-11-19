<script setup lang="ts">
import MedicationFormulaPanel from './MedicationFormulaPanel.vue';
import FormSuggest from './FormSuggest.vue';
import MedicationUnitPicker from './MedicationUnitPicker.vue';
import { medicationDosageFormOptions, medicationFrequencyOptions, medicationRouteOptions } from '../utils/record-form-options';
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue';
import DateTimePicker from './DateTimePicker.vue';
import FormSelect from './FormSelect.vue';
import MedicationContextPicker from './MedicationContextPicker.vue';
import { request } from '../utils/api';
import { createUuid } from '../utils/uuid';
import { formatMedicationDate } from '../utils/medication-date';
import { useAppContext } from '../composables/useAppContext';
import { useUnsavedRecord } from '../composables/useUnsavedRecord';
import { medicationActionLabels, medicationStatusLabels } from '../../../shared/medications';
import type { HistoricalMedication, MedicationAction, MedicationContext, MedicationCourse, MedicationIntake, MedicationSource } from '../types/medications';

const props = defineProps<{
  memberId: string; mode: 'course' | 'intake'; course?: MedicationCourse | null;
  action?: Exclude<MedicationAction,'start'>; intake?: MedicationIntake | null;
  source?: MedicationSource | HistoricalMedication | null; courses?: MedicationCourse[]; initialContext?: MedicationContext; hideHeader?: boolean;
}>();
const emit = defineEmits<{ saved: [record:MedicationCourse|MedicationIntake]; cancel: [] }>();
const app = useAppContext();
const saving = ref(false); const error = ref(''); let generation = 0;
let selectedCourseId='';
let receipt:{signature:string;key:string}|undefined;
const form = reactive({ medicationName:'',specification:'',dosageForm:'',dose:'',doseUnit:'',frequency:'',route:'',instructions:'',
  amount:'',amountUnit:'',note:'',courseId:'',occurredAt:null as string|null });
const context = ref<MedicationContext>({});
const repeatAcknowledged=ref(false);
const leave=useUnsavedRecord(()=>JSON.stringify([form,context.value,repeatAcknowledged.value]),saving);
async function cancel(){if(await leave.confirmLeave())emit('cancel');}
const isRepeat=computed(()=>Boolean(props.source && 'confirmedCourseIds' in props.source && props.source.confirmedCourseIds.length && !props.action));
const courseOptions=computed(()=>[{value:'',label:'不关联已有用药'},...(props.courses || []).map(course=>({value:course.id,label:`${course.medicationName} ${course.specification || ''} · ${medicationStatusLabels[course.status]} · ${course.startedAt.slice(0,10)}`}))]);
const sourceFormula=computed(()=>props.intake?.source?.formula || props.course?.source?.formula || props.source?.formula || props.courses?.find(course=>course.id===form.courseId)?.source?.formula || null);
const editableFields = computed(()=>props.mode==='intake' || !props.action || props.action==='adjust');
const title = computed(()=>props.mode==='intake' ? (props.intake ? '编辑这次服药' : '记一次已服药')
  : props.action ? `${medicationActionLabels[props.action]}用药` : sourceFormula.value ? '确认整方使用' : '确认开始用药');
function localNow() { const now=new Date();return new Date(now.getTime()-now.getTimezoneOffset()*60000).toISOString().slice(0,16); }
function displayedIntakeTime(){return props.intake?.takenAt ? formatMedicationDate(props.intake.takenAt).replace(' ','T') : null;}
function reset() {
  generation++; saving.value=false; error.value='';receipt=undefined;
  const source=props.intake || props.course || props.source;
  const doseSource=props.course || props.source;
  Object.assign(form,{medicationName:source?.medicationName || '',specification:source?.specification || '',dosageForm:source?.dosageForm || '',
    dose:doseSource?.dose || '',doseUnit:doseSource?.doseUnit || '',frequency:doseSource?.frequency || '',route:source?.route || '',
    instructions:doseSource?.instructions || '',amount:props.intake?.amount || '',amountUnit:props.intake?.amountUnit || '',
    note:props.intake?.note || '',courseId:props.intake?.courseId || props.course?.id || '',occurredAt:displayedIntakeTime() || (props.mode==='intake' || props.action ? localNow() : localNow().slice(0,10))});
  selectedCourseId=form.courseId;
  const relatedRecords=props.initialContext?.relatedRecords;
  context.value={...(props.initialContext?.processId?{processId:props.initialContext.processId}:{}),...(relatedRecords?{relatedRecords:[...relatedRecords]}:{})};
  repeatAcknowledged.value=false;
  leave.reset();
}
function chooseCourse() {
  const selected=props.courses?.find(course=>course.id===form.courseId);
  const changed=form.courseId!==selectedCourseId;
  selectedCourseId=form.courseId;
  if (!selected || !changed) return;
  // An actual dose belongs to the chosen drug, never to the next selection.
  form.amount='';form.amountUnit='';
  form.medicationName=selected.medicationName;form.specification=selected.specification || '';form.dosageForm=selected.dosageForm || '';form.route=selected.route || '';
}
async function save() {
  if (saving.value) return;
  if(app.selectedMemberId.value!==props.memberId || app.selectedMember.value?.permission!=='manager'){error.value='当前成员已变化或只有查看权限，请重新打开记录';return;}
  if(isRepeat.value && !repeatAcknowledged.value){error.value='已有这张处方的用药记录，请先确认是否确实开始新的一段用药';return;}
  const memberId=props.memberId;const current=generation;saving.value=true;error.value='';
  let path='medications';let method='POST';
  let body:Record<string,unknown>={...form,...context.value,memberId};
  if (props.mode==='intake') {
    path=props.intake ? `medications/intakes/${encodeURIComponent(props.intake.id)}` : 'medications/intakes';
    method=props.intake ? 'PATCH' : 'POST';
    body={...body,courseId:form.courseId || null,takenAt:props.intake && form.occurredAt===displayedIntakeTime() ? props.intake.takenAt : form.occurredAt,revision:props.intake?.revision,...(!props.intake && props.source ? {sourceMedicationId:props.source.medicationId} : {})};
  } else if (props.course && props.action) {
    path=`medications/${encodeURIComponent(props.course.id)}/changes`;
    body={...body,action:props.action,revision:props.course.revision};
  } else body={...body,sourceMedicationId:props.source?.medicationId,startedAt:form.occurredAt,confirmed:true};
  if((props.mode==='intake' && !props.intake) || (props.mode==='course' && !props.action)){
    const signature=JSON.stringify(body);
    if(receipt?.signature!==signature)receipt={signature,key:createUuid()};
    body={...body,requestKey:receipt.key};
  }
  try {
    const saved=await request<MedicationCourse|MedicationIntake>(path,{method,body:JSON.stringify(body)});
    app.notifyDataChanged();
    if (generation===current && props.memberId===memberId) {saving.value=false;leave.reset();emit('saved',saved);}
  } catch(cause) {if(generation===current)error.value=cause instanceof Error ? cause.message : '保存失败，请重试';}
  finally {if(generation===current)saving.value=false;}
}
watch(()=>[props.memberId,props.mode,props.course?.id,props.action,props.intake?.id,props.source?.medicationId,JSON.stringify(props.initialContext)],reset,{immediate:true});
onBeforeUnmount(()=>{generation++;});
</script>
<template>
  <form class="medication-editor settings-band" @submit.prevent="save">
    <header v-if="!hideHeader"><div><h3>{{ title }}</h3></div><button type="button" :disabled="saving" class="soft-action-button" @click="cancel">取消</button></header>
    <div class="medication-form-body">
      <p v-if="source && !action" class="medication-form-hint">已从「{{ source.reportTitle }}」带入药品{{ mode==='intake' ? '信息，请填写实际服用时间和用量。' : '和用法，请核对实际开始日期。' }}</p>
      <p v-else-if="mode==='intake'" class="medication-form-hint">仅记录这一次已经服用的药。不要求每天记录，也不会自动生成服药记录。</p>
      <p v-else-if="action && action!=='adjust'" class="medication-form-hint">{{ course?.medicationName }} · {{ [course?.specification,course?.dose,course?.doseUnit].filter(Boolean).join(' ') }}</p>
      <p v-else class="medication-form-hint">记录你已开始使用的药品及用法，以后可在这条记录中调整或停止。</p>
      <MedicationFormulaPanel v-if="sourceFormula" :formula="sourceFormula" title="来源配方" />
      <p v-if="sourceFormula" class="medication-form-hint">按整张药方记录服用，药材投料克数不是每次服用量。配方如有变化，请核对新药单后另行确认使用。</p>
      <fieldset :disabled="saving" class="medication-form-grid">
        <label v-if="mode==='intake' && courses?.length" class="full">从已有用药带入（选填）<FormSelect v-model="form.courseId" :options="courseOptions" :disabled="saving" aria-label="选择已有用药" @change="chooseCourse" /></label>
        <label v-if="editableFields" class="full">{{ sourceFormula ? '药方名称' : '药品名称' }}<input v-model="form.medicationName" name="medicationName" required maxlength="200" placeholder="填写药盒或处方上的名称" /></label>
        <template v-if="mode==='course' && editableFields">
          <label>{{ sourceFormula ? '整方每次服用量（选填）' : '每次用量（选填）' }}<input v-model="form.dose" name="dose" maxlength="200" placeholder="例如 1" /></label>
          <MedicationUnitPicker v-model="form.doseUnit" label="用量单位" title="用量单位（选填）" name="doseUnit" maxlength="200" :disabled="saving" />
          <label class="full">频次（选填）<FormSuggest v-model="form.frequency" :options="medicationFrequencyOptions" label="用药频次" name="frequency" maxlength="200" placeholder="选择或填写" :disabled="saving" /></label>
        </template>
        <template v-if="mode==='intake'">
          <label>这次实际用量<input v-model="form.amount" name="amount" required maxlength="100" placeholder="填写实际已服用的量" /></label>
          <MedicationUnitPicker v-model="form.amountUnit" label="实际用量单位" title="单位（选填）" name="amountUnit" maxlength="100" :disabled="saving" />
        </template>
        <label class="full">{{ mode==='intake' ? '服用时间' : action ? '变更时间' : '实际开始日期' }}<DateTimePicker v-model="form.occurredAt" :show-time="mode==='intake' || Boolean(action)" :disabled="saving" /></label>
        <details class="medication-extra full">
          <summary>补充药品信息（选填）<span v-if="form.specification"> · {{ form.specification }}</span></summary>
          <div class="medication-form-grid">
            <label v-if="editableFields">规格（选填）<input v-model="form.specification" name="specification" maxlength="200" placeholder="按包装或处方填写" /></label>
            <label v-if="editableFields">剂型（选填）<FormSuggest v-model="form.dosageForm" :options="medicationDosageFormOptions" label="剂型" name="dosageForm" maxlength="200" placeholder="选择或填写" :disabled="saving" /></label>
            <label v-if="editableFields" class="full">使用途径（选填）<FormSuggest v-model="form.route" :options="medicationRouteOptions" label="使用途径" name="route" maxlength="200" placeholder="选择或填写" :disabled="saving" /></label>
            <label v-if="mode==='course' && editableFields" class="full">补充用法（选填）<textarea v-model="form.instructions" name="instructions" maxlength="2000" rows="2" /></label>
            <label class="full">备注（选填）<textarea v-model="form.note" name="note" maxlength="2000" rows="2" /></label>
          </div>
        </details>
        <MedicationContextPicker v-model="context" :member-id="memberId" :exclude="intake?[{kind:'intake',id:intake.id}]:course?[{kind:'medication',id:course.id}]:[]" :disabled="saving" />
        <label v-if="isRepeat" class="full medication-repeat-confirm"><input v-model="repeatAcknowledged" type="checkbox" />这张处方已有用药记录，我确认要开始新的一段用药</label>
      </fieldset>
    </div>
    <p v-if="error" class="form-error" role="alert">{{ error }}</p>
    <div class="form-actions" :class="{'medication-dialog-actions':hideHeader}"><button v-if="hideHeader" type="button" class="soft-action-button" :disabled="saving" @click="cancel">取消</button><button type="submit" class="primary-button" :disabled="saving || !form.occurredAt || (isRepeat && !repeatAcknowledged)">{{ saving ? '保存中…' : mode==='intake' ? (intake ? '保存修改' : '新增服药记录') : title }}</button></div>
  </form>
</template>
<style scoped>
.medication-editor{overflow:hidden}.medication-editor>header{min-height:58px;padding:12px 18px;gap:12px}.medication-editor h3{margin:0;font-size:16px}.medication-form-body{padding:0 18px 18px}.medication-form-hint{font-size:12px;line-height:1.7;color:var(--muted);margin:14px 0;overflow-wrap:anywhere}.medication-form-grid{border:0;padding:0;display:grid;grid-template-columns:1fr 1fr;gap:14px;min-width:0}.medication-form-grid label{display:grid;align-content:start;gap:6px;font-size:12px;min-width:0}.medication-form-grid .full{grid-column:1/-1}.medication-form-grid input:not([type=checkbox]):not([type=radio]),.medication-form-grid textarea{width:100%;min-width:0;min-height:44px;border:1px solid var(--line-strong);border-radius:10px;padding:11px 12px;background:var(--surface);color:var(--ink);font-family:inherit;font-size:14px;line-height:20px}.medication-form-grid input:not([type=checkbox]):not([type=radio]):focus,.medication-form-grid textarea:focus{outline:0;border-color:var(--brand);box-shadow:0 0 0 3px var(--brand-soft)}.medication-editor .form-error{color:var(--danger);font-size:12px}.medication-extra{padding:12px 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line)}.medication-extra summary{font-size:12px;color:var(--muted);cursor:pointer;line-height:1.7}.medication-extra>.medication-form-grid{padding-top:14px}.medication-form-grid .medication-context-confirm,.medication-form-grid .medication-repeat-confirm{display:flex;align-items:flex-start;gap:8px;line-height:1.6}.medication-context-confirm input,.medication-repeat-confirm input{width:auto;margin-top:4px}.medication-editor > .form-actions{margin:0;padding:0 18px 18px}.medication-editor > .form-error{margin:0;padding:0 18px 12px;overflow-wrap:anywhere}
.medication-editor .medication-dialog-actions { justify-content: flex-end; gap: 8px; }
@media(max-width:520px){.medication-form-grid{grid-template-columns:1fr}.medication-form-body{padding:0 14px 14px}.medication-editor>header{padding:12px 14px}.medication-editor .form-actions>button{width:100%}.medication-editor .medication-dialog-actions>button{width:auto}.medication-editor > .form-actions{padding-right:14px;padding-left:14px}}
</style>
