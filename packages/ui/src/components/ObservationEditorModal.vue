<script setup lang="ts">
import {measurementsForSymptom} from '../../../shared/symptom-measurements';
import {computed,nextTick,onBeforeUnmount,onDeactivated,onMounted,reactive,ref,watch} from 'vue';
import {X,LoaderCircle} from '@lucide/vue';
import type {HealthObservation,ObservationRef,SymptomContinuationCandidate} from '../../../shared/health-observations';
import type {HealthRecordRef} from '../../../shared/health-record-associations';
import {healthSymptomChangeLabels,type HealthSymptomChange} from '../../../shared/health-events';
import {useAppContext} from '../composables/useAppContext';
import {useUnsavedRecord} from '../composables/useUnsavedRecord';
import {useScrollLock} from '../composables/useScrollLock';
import {createSubmissionKey} from '../utils/submission-key';
import {request} from '../utils/api';
import SymptomMeasurementFields from './SymptomMeasurementFields.vue';
import DateTimePicker from './DateTimePicker.vue';
import SymptomSeverityPicker from './SymptomSeverityPicker.vue';
import MedicationUnitPicker from './MedicationUnitPicker.vue';
import RecordLoading from './RecordLoading.vue';
import ReportScrollingTitle from './ReportScrollingTitle.vue';
const props=defineProps<{memberId:string;processId?:string;target?:ObservationRef;symptom?:SymptomContinuationCandidate;initial?:Partial<HealthObservation>;relatedRecords?:HealthRecordRef[];returnFocus?:HTMLElement|null}>();
const emit=defineEmits<{close:[];saved:[entry:HealthObservation]}>();const app=useAppContext();
const panel=ref<HTMLElement|null>(null),backdrop=ref<HTMLElement|null>(null),entry=ref<HealthObservation|null>(null);
const loading=ref(false),busy=ref(false),error=ref('');let alive=true,generation=0;
const visible=computed(()=>alive&&props.memberId===app.selectedMemberId.value&&app.selectedMember.value?.permission==='manager');
function now(){const date=new Date();return new Date(date.getTime()-date.getTimezoneOffset()*60000).toISOString().slice(0,19);}
const form=reactive({recordedAt:now() as string|null,change:'' as HealthSymptomChange|'',severity:'',temperatureValue:'',measurementValue:'',measurementUnit:'',amount:'',amountUnit:'',description:''});
const leave=useUnsavedRecord(()=>JSON.stringify(form),busy);const key=createSubmissionKey();useScrollLock(visible);
const isIntake=computed(()=>props.target?.kind==='intake');
const name=computed(()=>entry.value?.name||props.symptom?.name||'记录');
const title=computed(()=>`${props.target?'修改记录':'新增变化'} · ${name.value}`);
function populate(value:Partial<HealthObservation>){Object.assign(form,{recordedAt:value.recordedAt||now(),change:value.change||(!props.target&&props.symptom?.status==='active'&&!props.symptom.unit?'unchanged':''),severity:value.severity===null||value.severity===undefined?'':String(value.severity),temperatureValue:value.temperatureValue||'',measurementValue:value.measurementValue||'',measurementUnit:value.measurementUnit||measurementsForSymptom(props.symptom?.name||'')[0]?.unit||'',amount:value.amount||'',amountUnit:value.amountUnit||'',description:value.description||''});leave.reset();}
async function load(){
 if(!visible.value)return;const token=++generation;loading.value=true;error.value='';
 try{if(props.target){const params=new URLSearchParams({memberId:props.memberId});if(props.processId)params.set('processId',props.processId);const value=await request<HealthObservation>(`health-observations/${props.target.kind}/${encodeURIComponent(props.target.id)}?${params}`);
  if(!alive||token!==generation||!visible.value)return;if(value.memberId!==props.memberId||value.ref.kind!==props.target.kind||value.ref.id!==props.target.id)throw Error('记录与当前成员不一致');entry.value=value;populate(value);
 }else if(props.symptom?.memberId===props.memberId){populate(props.initial||{});}else throw Error('续记目标无效');
 }catch(cause){if(alive&&token===generation)error.value=cause instanceof Error?cause.message:'无法读取记录';}finally{if(token===generation)loading.value=false;}
}
async function close(){if(await leave.confirmLeave())emit('close');}
async function save(){
 if(!visible.value||busy.value||loading.value||props.target&&!entry.value)return;const token=++generation;busy.value=true;error.value='';
 const body={memberId:props.memberId,...(props.processId?{processId:props.processId}:{}),...(props.target?{revision:entry.value!.revision}:{relatedRecords:props.relatedRecords||[]}),...form,severity:form.severity===''?null:Number(form.severity),change:form.change||null};
 const path=props.target?`health-observations/${props.target.kind}/${encodeURIComponent(props.target.id)}`:`symptoms/${encodeURIComponent(props.symptom!.id)}/observations`;
 try{const result=await request<HealthObservation>(path,{method:props.target?'PATCH':'POST',body:JSON.stringify({...body,requestKey:key.forRequest(path,body)})});
  if(!alive||token!==generation||!visible.value)return;if(result.memberId!==props.memberId||(props.target&&(result.ref.kind!==props.target.kind||result.ref.id!==props.target.id))||(!props.target&&result.record.id!==props.symptom!.id))throw Error('保存结果与当前记录不一致');
  busy.value=false;leave.reset();app.notifyDataChanged();emit('saved',result);
 }catch(cause){if(alive&&token===generation&&visible.value)error.value=cause instanceof Error?cause.message:'保存失败，请重试';}finally{if(token===generation)busy.value=false;}
}
function onKey(event:KeyboardEvent){if(!visible.value||!panel.value||document.querySelector('.form-select-layer,.datetime-picker-layer,.confirm-backdrop')||[...document.querySelectorAll('.modal-backdrop,.sheet-backdrop')].at(-1)!==backdrop.value)return;
 if(event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();void close();return;}if(event.key!=='Tab')return;
 const controls=[...panel.value.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled)')];const first=controls[0],last=controls.at(-1);if(event.shiftKey&&(document.activeElement===first||document.activeElement===panel.value)){event.preventDefault();last?.focus();}else if(!event.shiftKey&&(document.activeElement===last||document.activeElement===panel.value)){event.preventDefault();first?.focus();}}
watch(visible,allowed=>{if(!allowed){generation++;emit('close');}},{flush:'sync'});
onMounted(()=>{window.addEventListener('keydown',onKey);void load();void nextTick(()=>panel.value?.focus({preventScroll:true}));});
onDeactivated(()=>{alive=false;generation++;emit('close');});onBeforeUnmount(()=>{alive=false;generation++;window.removeEventListener('keydown',onKey);void nextTick(()=>{if(props.memberId===app.selectedMemberId.value&&props.returnFocus?.isConnected)props.returnFocus.focus({preventScroll:true});});});
</script>
<template><Teleport to="body"><div v-if="visible" ref="backdrop" class="modal-backdrop observation-editor-backdrop" @click.self="close"><section ref="panel" class="modal-panel record-sheet observation-editor-modal" role="dialog" aria-modal="true" :aria-label="title" tabindex="-1"><span class="sheet-grabber" aria-hidden="true"/><header><ReportScrollingTitle :text="title"/><button type="button" class="plain-icon-button" aria-label="关闭记录编辑" :disabled="busy" @click="close"><X :size="18"/></button></header><form @submit.prevent="save"><RecordLoading v-if="loading" label="正在读取记录…"/><fieldset v-else :disabled="busy" class="observation-editor-fields">
 <p v-if="!target" class="observation-editor-hint">补充这个症状的变化，不会新增症状记录。<template v-if="relatedRecords?.length">保存时将所选记录一并纳入健康历程。</template></p>
 <template v-if="!target||entry"><div v-if="!isIntake" class="observation-change-options" role="group" aria-label="症状变化"><button v-for="(label,value) in healthSymptomChangeLabels" :key="value" type="button" :aria-pressed="form.change===value" @click="form.change=value">{{label}}</button><button type="button" :aria-pressed="!form.change" @click="form.change=''">仅补充</button></div>
 <div v-if="isIntake" class="observation-editor-grid"><label>实际服用量<input v-model="form.amount" aria-label="实际服用量" maxlength="100" required/></label><MedicationUnitPicker v-model="form.amountUnit" label="服用量单位" title="单位" :disabled="busy" maxlength="100"/></div>
 <SymptomMeasurementFields v-if="!isIntake" :name="name" v-model:value="form.measurementValue" v-model:unit="form.measurementUnit" v-model:temperature="form.temperatureValue" :disabled="busy"/>
 <label>记录时间<DateTimePicker v-model="form.recordedAt" show-time :disabled="busy" aria-label="变化记录时间"/></label><SymptomSeverityPicker v-if="!isIntake" v-model="form.severity" label="变化程度" :disabled="busy"/><label>补充说明（选填）<textarea v-model="form.description" aria-label="变化说明" maxlength="2000" rows="2"/></label></template>
 <p v-if="error" class="inline-panel-error" role="alert">{{error}} <button v-if="target&&!entry" type="button" class="error-retry" @click="load">重试</button></p>
 </fieldset><footer class="form-actions record-form-actions"><button type="button" :disabled="busy" @click="close">取消</button><button class="primary-button" type="submit" :disabled="busy||loading||!form.recordedAt||Boolean(target&&!entry)"><LoaderCircle v-if="busy" :size="14" class="spin-icon"/>{{busy?'正在保存…':target?'保存修改':'新增记录'}}</button></footer></form></section></div></Teleport></template>
<style scoped>
.observation-editor-backdrop{z-index:72}.observation-editor-modal{width:min(560px,100%);max-height:88dvh;outline:0}.observation-editor-modal>header{gap:8px;min-height:48px;padding:10px 14px}.observation-editor-modal :deep(.report-scrolling-title){flex:1;min-width:0;font-size:16px}.observation-editor-modal>header>button{flex-shrink:0;width:28px;height:28px}.observation-editor-modal form{display:flex;flex-direction:column;min-height:0;overflow:hidden}.observation-editor-fields{display:grid;gap:10px;min-width:0;min-height:0;margin:0;padding:14px;border:0;overflow:auto;overscroll-behavior:contain}.observation-editor-fields label{display:grid;align-content:start;gap:6px;min-width:0;color:var(--muted);font-size:12px}.observation-editor-fields input,.observation-editor-fields textarea{min-width:0;width:100%;padding:8px 10px;border:1px solid var(--line-strong);border-radius:var(--radius-s);background:var(--surface);color:var(--ink);font:inherit;font-size:14px;line-height:21px}.observation-editor-fields :deep(.datetime-picker input),.observation-editor-fields :deep(.form-suggest>input){border:0;background:transparent;box-shadow:none}.observation-editor-fields input:focus,.observation-editor-fields textarea:focus{outline:2px solid var(--brand-soft);border-color:var(--brand)}.observation-editor-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:10px}.observation-change-options{display:flex;flex-wrap:wrap;gap:6px}.observation-change-options button{min-height:32px;padding:4px 9px;border:1px solid transparent;border-radius:8px;background:var(--fill-2);color:var(--muted);font:inherit;font-size:12px}.observation-change-options button[aria-pressed=true]{border-color:var(--brand);color:var(--brand-strong);background:var(--brand-soft)}.observation-editor-hint{margin:0;color:var(--muted);font-size:12px;line-height:19px}.observation-editor-modal footer{margin:0;flex-shrink:0;padding:8px 14px;border-top:1px solid var(--line)}.observation-editor-modal button:focus-visible{outline:2px solid var(--brand);outline-offset:2px}
</style>
