<script setup lang="ts">
import {measurementsForSymptom} from '../../../shared/symptom-measurements';
import ObservationReceipt from './ObservationReceipt.vue';
import SymptomMeasurementFields from './SymptomMeasurementFields.vue';
import MedicationUnitPicker from './MedicationUnitPicker.vue';
import { computed,nextTick,onBeforeUnmount,onMounted,reactive,ref,watch } from 'vue';
import { X } from '@lucide/vue';
import DateTimePicker from './DateTimePicker.vue';
import SymptomSeverityPicker from './SymptomSeverityPicker.vue';
import ReportScrollingTitle from './ReportScrollingTitle.vue';
import { useAppContext } from '../composables/useAppContext';
import { useScrollLock } from '../composables/useScrollLock';
import { useUnsavedRecord } from '../composables/useUnsavedRecord';
import { createSubmissionKey } from '../utils/submission-key';
import { request } from '../utils/api';
import { healthSymptomChangeLabels,type HealthSymptomChange } from '../../../shared/health-events';
import type { ProcessQuickMedication,ProcessQuickRecordResult,ProcessQuickSymptom } from '../../../shared/health-process-care';
const props=defineProps<{memberId:string;processId:string;fingerprint:string;symptom?:ProcessQuickSymptom;medication?:ProcessQuickMedication;returnFocus?:HTMLElement|null}>();
const emit=defineEmits<{close:[];saved:[result:ProcessQuickRecordResult];continued:[result:ProcessQuickRecordResult];editSaved:[result:ProcessQuickRecordResult]}>();const app=useAppContext();
function localNow(){const now=new Date();return new Date(now.getTime()-now.getTimezoneOffset()*60000).toISOString().slice(0,19);}
const lastSaved=ref<ProcessQuickRecordResult|null>(null);
async function editLast(){if(lastSaved.value&&await leave.confirmLeave())emit('editSaved',lastSaved.value);}
const currentFingerprint=ref(props.fingerprint);const target=ref(props.symptom?.id||'');const notice=ref('');
const form=reactive({recordedAt:localNow() as string|null,change:(!props.symptom?.id||props.symptom?.unit||props.symptom?.status==='resolved'?'':'unchanged') as HealthSymptomChange|'',severity:'',temperatureValue:'',measurementValue:'',measurementUnit:measurementsForSymptom(props.symptom?.name||'')[0]?.unit||'',amount:props.medication?.amount||'',amountUnit:props.medication?.unit||'',description:''});
const busy=ref(false);const error=ref('');const panel=ref<HTMLElement|null>(null);const backdrop=ref<HTMLElement|null>(null);const key=createSubmissionKey();let generation=0;
const visible=computed(()=>props.memberId===app.selectedMemberId.value&&app.selectedMember.value?.permission==='manager');
const title=computed(()=>props.symptom?'新增变化 · '+props.symptom.name:'新增服药记录 · '+props.medication?.name);
const leave=useUnsavedRecord(()=>JSON.stringify(form),busy);useScrollLock(visible);
async function close(){if(await leave.confirmLeave())emit('close');}
async function save(again=false){
 if(busy.value||!visible.value)return;const token=++generation;busy.value=true;error.value='';notice.value='';
 const body={kind:props.symptom?(target.value?'symptom':'new_symptom'):'medication',target:props.symptom?(target.value||props.symptom.name):props.medication?.key,fingerprint:currentFingerprint.value,...form,change:form.change||null,severity:form.severity===''?null:Number(form.severity)};
 try{const saved=await request<ProcessQuickRecordResult>(`health-processes/${encodeURIComponent(props.processId)}/quick-record`,{method:'POST',body:JSON.stringify({...body,requestKey:key.forRequest('process-quick-record',body)})});
  if(token!==generation||!visible.value)return;
  if(saved.memberId!==props.memberId||saved.processId!==props.processId||saved.kind!==(props.symptom?'symptom':'intake')||!saved.id)throw Error('保存结果无效，请刷新后核对');
  busy.value=false;lastSaved.value=saved;
  if(again&&saved.fingerprint){currentFingerprint.value=saved.fingerprint;if(saved.symptomId)target.value=saved.symptomId;form.recordedAt=localNow();form.measurementValue='';form.temperatureValue='';form.amount='';form.description='';form.severity='';key.reset();notice.value='已新增，可以继续记录下一次。';leave.reset();emit('continued',saved);void nextTick(()=>panel.value?.querySelector<HTMLInputElement>(props.symptom?'input[name=measurementValue],input[name=temperatureValue]':'input[name=amount]')?.focus({preventScroll:true}));}
  else{leave.reset();emit('saved',saved);}
 }catch(cause){if(token===generation&&visible.value)error.value=cause instanceof Error?cause.message:'保存失败，请重试';}finally{if(token===generation)busy.value=false;}
}
function onKey(event:KeyboardEvent){
 if(!visible.value||!panel.value||document.querySelector('.confirm-backdrop,.form-select-layer,.datetime-picker-layer')||[...document.querySelectorAll('.modal-backdrop,.sheet-backdrop')].at(-1)!==backdrop.value)return;
 if(event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();void close();return;}
 if(event.key!=='Tab')return;
 const controls=[...panel.value.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),[tabindex="0"]')].filter(e=>!e.closest('[hidden],[inert]'));
 const first=controls[0],last=controls.at(-1);if(!first){event.preventDefault();panel.value.focus();return;}
 if(event.shiftKey&&(document.activeElement===first||document.activeElement===panel.value)){event.preventDefault();last?.focus();}
 else if(!event.shiftKey&&(document.activeElement===last||document.activeElement===panel.value)){event.preventDefault();first.focus();}
}
watch(visible,allowed=>{if(!allowed){generation++;emit('close');}},{flush:'sync'});
onMounted(()=>{window.addEventListener('keydown',onKey);void nextTick(()=>panel.value?.focus({preventScroll:true}));});
onBeforeUnmount(()=>{generation++;window.removeEventListener('keydown',onKey);const target=props.returnFocus;void nextTick(()=>{if(visible.value&&target?.isConnected)target.focus({preventScroll:true});});});
</script>
<template>
 <Teleport to="body"><div v-if="visible" ref="backdrop" class="modal-backdrop process-quick-backdrop" @click.self="close"><section ref="panel" class="modal-panel record-sheet process-quick-modal" role="dialog" aria-modal="true" :aria-label="title" tabindex="-1">
  <span class="sheet-grabber" aria-hidden="true"/><header><ReportScrollingTitle :text="title"/><button class="plain-icon-button" type="button" aria-label="关闭快捷记录" :disabled="busy" @click="close"><X :size="18"/></button></header>
  <form @submit.prevent="save(false)"><fieldset :disabled="busy" class="process-quick-fields">
   <p v-if="medication" class="process-quick-hint">仅记录这次已服用的药，不改变处方或正在使用的药品。<span v-if="medication.amount">已带入上次实际用量，请核对。</span></p>
   <p v-if="symptom" class="process-quick-hint">补充这个症状的变化，不会新增症状记录。</p>
   <div v-if="symptom" class="process-quick-change" role="group" aria-label="症状变化"><button v-for="(label,value) in healthSymptomChangeLabels" :key="value" type="button" :aria-pressed="form.change===value" @click="form.change=value">{{label}}</button><button type="button" :aria-pressed="!form.change" @click="form.change=''">仅补充</button></div>
   <SymptomMeasurementFields v-if="symptom" :name="symptom.name" v-model:value="form.measurementValue" v-model:unit="form.measurementUnit" v-model:temperature="form.temperatureValue" :disabled="busy"/>
   <div v-else class="process-quick-grid"><label>这次实际用量<input v-model="form.amount" name="amount" required maxlength="100"/></label><MedicationUnitPicker v-model="form.amountUnit" label="实际用量单位" title="单位（选填）" name="amountUnit" maxlength="100" :disabled="busy" /></div>
   <label>记录时间<DateTimePicker v-model="form.recordedAt" show-time :disabled="busy" aria-label="快捷记录时间"/></label>
   <label>补充说明（选填）<textarea v-model="form.description" name="description" rows="2" maxlength="2000"/></label>
   <SymptomSeverityPicker v-if="symptom" v-model="form.severity" label="快捷记录程度" :disabled="busy"/>
   <ObservationReceipt v-if="lastSaved" :record="{kind:lastSaved.kind,id:lastSaved.id}" :label="lastSaved.label" :recorded-at="lastSaved.recordedAt" :disabled="busy" @edit="editLast"/><p v-if="notice" class="process-quick-hint" role="status">{{notice}}</p>
   <p v-if="error" class="inline-panel-error" role="alert">{{error}}</p>
  </fieldset><footer class="form-actions record-form-actions"><button type="button" :disabled="busy" @click="close">取消</button><button type="button" class="soft-action-button" :disabled="busy||!form.recordedAt||Boolean(medication&&!form.amount.trim())" @click="save(true)">新增并继续</button><button class="primary-button" type="submit" :disabled="busy||!form.recordedAt">{{busy?'正在保存…':'新增记录'}}</button></footer></form>
 </section></div></Teleport>
</template>
<style scoped>
.process-quick-grid .form-suggest { --form-suggest-height: 39px; --form-suggest-padding: 8px; }
.process-quick-backdrop{z-index:70}.process-quick-modal{width:min(560px,100%);max-height:88dvh;outline:0}.process-quick-modal>header{gap:8px;min-height:50px;padding:12px 14px}.process-quick-modal :deep(.report-scrolling-title){flex:1;min-width:0;margin:0;font-size:16px;line-height:22px;overflow-wrap:anywhere}.process-quick-modal>header>button{width:28px;height:28px;flex-shrink:0;position:relative}.process-quick-modal>header>button:after{content:'';position:absolute;inset:-8px}.process-quick-modal form{display:flex;flex-direction:column;min-height:0;overflow:hidden}.process-quick-fields{display:grid;gap:12px;min-width:0;min-height:0;margin:0;padding:14px;border:0;overflow:auto;overscroll-behavior:contain}.process-quick-fields label{display:grid;align-content:start;gap:6px;min-width:0;font-size:12px;color:var(--muted)}.process-quick-fields input,.process-quick-fields textarea{width:100%;min-width:0;padding:8px 10px;border:1px solid var(--line-strong);border-radius:var(--radius-s);background:var(--surface);color:var(--ink);font:inherit;font-size:14px;line-height:21px}.process-quick-fields input:focus,.process-quick-fields textarea:focus{border-color:var(--brand);outline:2px solid var(--brand-soft)}.process-quick-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:10px}.process-quick-change{display:flex;flex-wrap:wrap;gap:6px}.process-quick-change button{min-height:32px;padding:5px 10px;border:1px solid var(--line);border-radius:var(--radius-s);background:var(--surface);color:var(--ink-2);font:inherit;font-size:12px}.process-quick-change button[aria-pressed=true]{border-color:var(--brand);background:var(--brand-soft);color:var(--brand-strong)}.process-quick-hint{margin:0;font-size:12px;line-height:19px;color:var(--muted)}.process-quick-modal footer{flex-shrink:0;margin:0;padding:10px 14px;border-top:1px solid var(--line)}.process-quick-modal button:focus-visible{outline:2px solid var(--brand);outline-offset:2px}@media(max-width:760px),(pointer:coarse){.process-quick-fields{padding:12px 14px;gap:10px}.process-quick-modal footer{padding:8px 14px max(8px,env(safe-area-inset-bottom))}}
</style>
