<script setup lang="ts">
import type {HealthProcessActivity} from '../../../shared/health-process-activity';
import {initialProcessActivity} from '../utils/health-process-activity';
import RecordLoading from './RecordLoading.vue';
import { computed,nextTick,onActivated,onBeforeUnmount,onDeactivated,ref,watch } from 'vue';
import NewSymptomPage from '../pages/NewSymptomPage.vue';
import ObservationReceipt from './ObservationReceipt.vue';
import ObservationEditorModal from './ObservationEditorModal.vue';
import { observationDescription } from '../utils/health-observation';
import type { HealthObservation,ObservationRef } from '../../../shared/health-observations';
import { Stethoscope,Thermometer } from '@lucide/vue';
import ProcessTemperatureChart from './ProcessTemperatureChart.vue';
import {healthSymptomChangeLabels} from '../../../shared/health-events';
import ProcessQuickRecordModal from './ProcessQuickRecordModal.vue';
import ProcessDoctorSummaryModal from './ProcessDoctorSummaryModal.vue';
import { useAppContext } from '../composables/useAppContext';
import { request } from '../utils/api';
import { formatMedicationDate } from '../utils/medication-date';
import type { HealthProcessDetail } from '../../../shared/health-process';
import type { HealthProcessCare,ProcessQuickMedication,ProcessQuickRecordResult,ProcessQuickSymptom } from '../../../shared/health-process-care';
function editMember(){if(!canManage.value)return;summaryOpen.value=false;emit('editMember');}
const props=defineProps<{initialLoad?:Promise<HealthProcessActivity>;process:HealthProcessDetail;disabled?:boolean}>();const emit=defineEmits<{updated:[];editMember:[]}>();const app=useAppContext();
const care=ref<HealthProcessCare|null>(null);const loading=ref(false);const error=ref('');const active=ref(true);let generation=0;
const newSymptomOpen=ref(false),newSymptomOpener=ref<HTMLElement|null>(null);
function openNewSymptom(opener?:HTMLElement|null){if(!canManage.value||props.disabled)return;summaryOpen.value=false;newSymptomOpener.value=opener||document.activeElement as HTMLElement;newSymptomOpen.value=true;}
function symptomCreated(){newSymptomOpen.value=false;emit('updated');void load();}
defineExpose({openNewSymptom});
const summaryOpen=ref(false);const summaryButton=ref<HTMLElement|null>(null);
const summaryCare=ref<HealthProcessCare|null>(null),summaryLoading=ref(false),summaryError=ref('');let summaryGeneration=0;
const shownSummary=computed(()=>summaryCare.value||care.value);
function validateCare(next:HealthProcessCare,id:string,member:string){
 if(next.processId!==id||next.memberId!==member||!Array.isArray(next.symptoms)||!Array.isArray(next.medications)||typeof next.summaryText!=='string')throw Error('快速记录与当前历程不一致');
}
async function loadSummary(){
 if(!visible.value||!summaryOpen.value)return;const token=++summaryGeneration,id=props.process.id,member=props.process.memberId;
 summaryLoading.value=true;summaryError.value='';
 try{const next=await request<HealthProcessCare>(`health-processes/${encodeURIComponent(id)}/care?${new URLSearchParams({timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone})}`);
  if(token!==summaryGeneration||!visible.value||!summaryOpen.value||id!==props.process.id||member!==props.process.memberId)return;
  validateCare(next,id,member);if(next.summaryReady===false)throw Error('就诊摘要尚未准备完成');summaryCare.value=next;
 }catch(cause){if(token===summaryGeneration&&visible.value)summaryError.value=cause instanceof Error?cause.message:'就诊摘要读取失败';}
 finally{if(token===summaryGeneration)summaryLoading.value=false;}
}
watch(summaryOpen,open=>{
 if(!open){summaryGeneration++;summaryLoading.value=false;return;}
 if(care.value?.summaryReady!==false){summaryCare.value=care.value;return;}
 if(!summaryCare.value)void loadSummary();
});

const selection=ref<{symptom?:ProcessQuickSymptom;medication?:ProcessQuickMedication;fingerprint:string;opener:HTMLElement|null}|null>(null);
const receipt=ref<ProcessQuickRecordResult|null>(null),editingObservation=ref<ObservationRef|null>(null);
function editSaved(result:ProcessQuickRecordResult){selection.value=null;editingObservation.value={kind:result.kind,id:result.id};}
function editReceipt(record:ObservationRef){if(canManage.value&&!props.disabled)editingObservation.value=record;}
function corrected(entry:HealthObservation){editingObservation.value=null;receipt.value={processId:props.process.id,memberId:entry.memberId,kind:entry.ref.kind,id:entry.ref.id,label:entry.name+' '+observationDescription(entry),recordedAt:entry.recordedAt};app.notifyDataChanged();emit('updated');void load();}
function closeObservation(){editingObservation.value=null;void nextTick(()=>root.value?.querySelector<HTMLButtonElement>('[data-observation-edit]')?.focus({preventScroll:true}));}
const pendingFocus=ref<HTMLElement|null>(null);const root=ref<HTMLElement|null>(null);
const scope=computed(()=>JSON.stringify([props.process.id,props.process.memberId,app.selectedMemberId.value]));
const visible=computed(()=>active.value&&props.process.memberId===app.selectedMemberId.value);
const canManage=computed(()=>visible.value&&app.selectedMember.value?.permission==='manager');
async function load(initial=false){
 if(!visible.value)return;const token=++generation;const id=props.process.id;const member=props.process.memberId;loading.value=true;error.value='';
 try{const next=(initial&&props.initialLoad?await initialProcessActivity(props.initialLoad,props.process,'care'):undefined)??await request<HealthProcessCare>(`health-processes/${encodeURIComponent(id)}/care?${new URLSearchParams({timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone,view:'quick'})}`);
  if(token!==generation||!visible.value||id!==props.process.id)return;
  validateCare(next,id,member);care.value=next;
  if(next.summaryReady!==false)summaryCare.value=next;else if(summaryOpen.value)void loadSummary();else summaryCare.value=null;
 }catch(cause){if(token===generation&&visible.value)error.value=cause instanceof Error?cause.message:'快速记录读取失败';}finally{if(token===generation)loading.value=false;}
}
function open(symptom:ProcessQuickSymptom|undefined,medication:ProcessQuickMedication|undefined,event:MouseEvent){if(!canManage.value||!care.value||props.disabled||loading.value)return;summaryOpen.value=false;selection.value={symptom,medication,fingerprint:care.value.fingerprint,opener:event.currentTarget as HTMLElement};}
function closeQuick(){const current=selection.value;pendingFocus.value=current?.opener?.isConnected?current.opener:([...(root.value?.querySelectorAll<HTMLButtonElement>('[data-symptom-name]')||[])].find(button=>button.dataset.symptomName===current?.symptom?.name)||summaryButton.value);selection.value=null;}
const currentSymptoms=computed(()=>care.value?.symptoms.filter(item=>item.status!=='resolved')||[]);
const currentMedications=computed(()=>care.value?.medications.filter(item=>item.status!=='stopped'&&item.origin!=='intake')||[]);
const historical=computed(()=>[
 ...(care.value?.symptoms.filter(item=>item.status==='resolved').map(symptom=>({key:'symptom:'+symptom.id,symptom,medication:undefined,name:symptom.name,status:'已消失'}))||[]),
 ...(care.value?.medications.filter(item=>item.status==='stopped'||item.origin==='intake').map(medication=>({key:medication.key,medication,symptom:undefined,name:medication.name,status:medication.status==='stopped'?'已停止':'曾服用'}))||[])
]);
const quickEmpty=computed(()=>!currentSymptoms.value.length&&!currentMedications.value.length&&!historical.value.length);
function lastSymptom(symptom:ProcessQuickSymptom){const last=symptom.latest;if(!last)return '';return ['上次记录',last.temperatureValue?'体温 '+last.temperatureValue+' ℃':last.measurementValue?[last.measurementValue,last.measurementUnit].filter(Boolean).join(' '):last.change?healthSymptomChangeLabels[last.change]:'',last.severity!=null?'程度 '+last.severity+'/10':'',formatMedicationDate(last.recordedAt)].filter(Boolean).join(' · ');}
function lastIntake(medication:ProcessQuickMedication){return medication.lastTakenAt?['上次记录服药',[medication.amount,medication.unit].filter(Boolean).join(' '),formatMedicationDate(medication.lastTakenAt)].filter(Boolean).join(' · '):'';}

function continued(result:ProcessQuickRecordResult){if(!visible.value||result.memberId!==props.process.memberId||result.processId!==props.process.id)return;receipt.value=result;app.notifyDataChanged();emit('updated');void load();}
function saved(result:ProcessQuickRecordResult){if(!visible.value||result.memberId!==props.process.memberId||result.processId!==props.process.id)return;receipt.value=result;closeQuick();app.notifyDataChanged();emit('updated');void load();}
watch([()=>props.disabled,loading,visible,pendingFocus],()=>{if(visible.value&&!props.disabled&&!loading.value&&pendingFocus.value?.isConnected){const target=pendingFocus.value;pendingFocus.value=null;void nextTick(()=>{if(visible.value&&target.isConnected)target.focus({preventScroll:true});});}},{flush:'post'});
watch(scope,()=>{generation++;newSymptomOpen.value=false;care.value=null;summaryCare.value=null;summaryError.value='';summaryGeneration++;summaryLoading.value=false;selection.value=null;receipt.value=null;editingObservation.value=null;pendingFocus.value=null;summaryOpen.value=false;void load(true);},{immediate:true,flush:'sync'});
watch([scope,()=>props.process.fingerprint,()=>props.process.editToken,()=>props.process.title,()=>props.process.summary],([current],[previous])=>{if(current===previous)void load();});watch(canManage,allowed=>{if(!allowed){newSymptomOpen.value=false;selection.value=null;editingObservation.value=null;}});
onActivated(()=>{if(!active.value){active.value=true;void load();}});onDeactivated(()=>{active.value=false;newSymptomOpen.value=false;generation++;loading.value=false;selection.value=null;editingObservation.value=null;pendingFocus.value=null;summaryOpen.value=false;});
onBeforeUnmount(()=>{generation++;summaryGeneration++;});
</script>
<template>
 <div v-if="visible" ref="root" class="process-care-panel">
  <RecordLoading v-if="loading&&!care" label="正在准备就诊摘要与快速记录…"/>
  <p v-if="error" class="inline-panel-error" role="alert">{{error}} <button class="error-retry" type="button" :disabled="loading" @click="load()">重试</button></p>
  <template v-if="care">
   <section class="settings-band process-care-actions"><header><h3>{{canManage?'快速记录':'就诊摘要'}}</h3><button ref="summaryButton" type="button" class="process-care-text" :aria-expanded="summaryOpen" aria-haspopup="dialog" @click="summaryOpen=true"><Stethoscope :size="16"/>给医生看</button></header>
    <div v-if="canManage" class="process-care-body">
     <div v-if="currentSymptoms.length||currentMedications.length" class="process-quick-options"><button v-for="symptom in currentSymptoms" :key="symptom.id" :data-symptom-name="symptom.name" type="button" class="process-symptom-choice" :disabled="disabled||loading" @click="open(symptom,undefined,$event)"><span class="process-choice-heading"><span class="process-choice-name">{{symptom.name}}</span><span class="process-choice-action">新增变化</span></span><small class="process-choice-last" v-if="lastSymptom(symptom)">{{lastSymptom(symptom)}}</small></button><button v-for="medication in currentMedications" :key="medication.key" type="button" class="process-medication-choice" :disabled="disabled||loading" @click="open(undefined,medication,$event)"><span class="process-choice-heading"><span class="process-choice-name">{{medication.name}}</span><span class="process-choice-action">新增服药</span></span><small class="process-choice-meta">{{medication.origin==='prescription'?'报告所列':medication.status==='paused'?'已暂停':'正在使用'}}</small><small class="process-choice-last" v-if="lastIntake(medication)">{{lastIntake(medication)}}</small></button></div>
     <div class="process-care-footer" :class="{'is-empty':quickEmpty}">
     <p v-if="quickEmpty" class="process-care-empty">还没有正在跟踪的症状或用药。</p>
     <details v-if="historical.length" class="process-history"><summary>历史记录 <small>{{historical.length}}</small></summary><div class="process-quick-options"><button v-for="item in historical" :key="item.key" type="button" :disabled="disabled||loading" @click="open(item.symptom,item.medication,$event)"><span class="process-choice-heading"><span class="process-choice-name">{{item.name}}</span><span class="process-choice-action">{{item.symptom?'新增变化':'新增服药'}}</span></span><small class="process-choice-meta">{{item.status}}</small><small class="process-choice-last" v-if="item.symptom?lastSymptom(item.symptom):item.medication&&lastIntake(item.medication)">{{item.symptom?lastSymptom(item.symptom):item.medication&&lastIntake(item.medication)}}</small></button></div></details>
     <button type="button" class="process-care-text process-add-symptom" :disabled="disabled||loading" @click="openNewSymptom($event.currentTarget as HTMLElement)">＋ 新增症状</button>
     </div>
    </div>
   </section>
   <ObservationReceipt v-if="receipt" :record="{kind:receipt.kind,id:receipt.id}" :label="receipt.label" :recorded-at="receipt.recordedAt" :disabled="disabled||!canManage" @edit="editReceipt"/>
   <section v-if="care.temperature" class="settings-band process-temperature"><header><h3><Thermometer :size="16"/>体温 / 发热小结</h3></header><dl><div><dt>最高体温</dt><dd>{{care.temperature.highest.value}}<small>℃</small></dd><span>{{formatMedicationDate(care.temperature.highest.at)}}</span></div><div><dt>最近一次</dt><dd>{{care.temperature.latest.value}}<small>℃</small></dd><span>{{formatMedicationDate(care.temperature.latest.at)}}</span></div><div><dt>≥{{care.temperature.threshold}}℃ 的记录天数</dt><dd>{{care.temperature.thresholdDays}}<small>天</small></dd></div><div><dt>体温记录</dt><dd>{{care.temperature.count}}<small>次 / {{care.temperature.recordedDays}} 天</small></dd></div></dl><ProcessTemperatureChart v-if="care.temperature.readings?.length" :readings="care.temperature.readings"/><p class="process-care-hint">仅统计已保存的摄氏体温记录，未记录的日期不计入。</p></section>
  </template>
  <ProcessDoctorSummaryModal v-if="summaryOpen&&care" :key="scope" :member-id="process.memberId" @edit-member="editMember" :load-error="summaryError" :context="shownSummary?.doctorContext" :disabled="disabled||summaryLoading" :loading="summaryLoading" @updated="loadSummary" :text="shownSummary?.summaryText||''" :day-text="shownSummary?.summaryByDay" :return-focus="summaryButton" @close="summaryOpen=false"/>
  <NewSymptomPage v-if="newSymptomOpen&&canManage" embedded :key="scope" :member-id="process.memberId" :process-id="process.id" :return-focus="newSymptomOpener" @close="newSymptomOpen=false" @saved="symptomCreated"/>
  <ProcessQuickRecordModal v-if="selection&&care&&canManage" :key="scope" :member-id="process.memberId" :process-id="process.id" :fingerprint="selection.fingerprint" :symptom="selection.symptom" :medication="selection.medication" :return-focus="selection.opener" @close="closeQuick" @saved="saved" @continued="continued" @edit-saved="editSaved"/>
  <ObservationEditorModal v-if="editingObservation&&canManage" :key="editingObservation.kind+editingObservation.id" :member-id="process.memberId" :process-id="process.id" :target="editingObservation" @close="closeObservation" @saved="corrected"/>
 </div>
</template>
<style scoped>
.process-care-panel{display:grid;gap:12px;margin-bottom:16px;min-width:0}.process-care-panel .settings-band{margin:0;min-width:0;box-shadow:none}.process-care-panel header{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:10px 12px;min-height:44px}.process-care-panel h3{display:flex;align-items:center;gap:6px;margin:0;font-size:16px;line-height:22px;font-weight:500}.process-care-body{display:grid;gap:8px;padding:10px 12px 12px}.process-care-hint{margin:0;color:var(--muted);font-size:12px;line-height:19px}.process-care-text{display:inline-flex;align-items:center;gap:5px;min-height:32px;padding:4px 0;border:0;background:none;color:var(--brand-strong);font:inherit;font-size:12px;cursor:pointer}

.process-care-footer{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:start;gap:0 8px;min-width:0}.process-care-footer>.process-history{grid-area:1/1/2/-1;min-width:0}.process-care-footer>.process-add-symptom{grid-area:1/2;justify-self:end;white-space:nowrap;z-index:1}.process-care-footer .process-history>summary{max-width:calc(100% - 100px);min-height:32px;padding:6px 0}.process-care-footer.is-empty{grid-template-columns:minmax(0,1fr)}.process-care-empty{margin:0;color:var(--muted);font-size:12px;line-height:19px}.process-care-footer.is-empty>.process-add-symptom{grid-area:auto;justify-self:start}
.process-history summary{width:fit-content;cursor:pointer;color:var(--brand-strong);font-size:12px;line-height:20px;padding:4px 0;min-height:28px}.process-history summary{color:var(--muted)}.process-history[open]>.process-quick-options{margin-top:6px}
.process-quick-options{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;min-width:0}.process-quick-options button{width:100%;min-width:0;max-width:100%;min-height:44px;display:flex;flex-direction:column;align-items:stretch;justify-content:center;gap:4px;padding:8px 10px;border:1px solid var(--line);border-radius:var(--radius-s);color:var(--ink);background:var(--surface);font:inherit;font-size:14px;line-height:20px;overflow-wrap:anywhere;text-align:left;cursor:pointer}.process-choice-heading{display:flex;align-items:baseline;justify-content:space-between;gap:8px;min-width:0}.process-choice-name{min-width:0;font-size:14px;font-weight:500;line-height:20px;overflow-wrap:anywhere}.process-choice-action{flex-shrink:0;font-size:12px;line-height:20px;color:var(--brand-strong);white-space:nowrap}.process-quick-options button small{font-size:12px;line-height:18px;font-weight:400;color:var(--muted);overflow-wrap:anywhere}.process-quick-options button:hover:not(:disabled){border-color:var(--brand);background:var(--brand-softer)}.process-quick-options button:active:not(:disabled){background:var(--brand-soft)}.process-quick-options button:disabled{opacity:.55;cursor:default}.process-add-symptom{justify-self:start;}.process-history .process-choice-action{color:var(--muted)}
.process-temperature dl{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin:0;padding:0 12px 10px}.process-temperature dl>div{min-width:0}.process-temperature dt{font-size:12px;line-height:19px;color:var(--muted)}.process-temperature dd{margin:4px 0 0;font-size:16px;line-height:23px;font-weight:500}.process-temperature dd small{font-size:12px;margin-left:3px;font-weight:400;color:var(--muted)}.process-temperature dl span{display:block;font-size:12px;line-height:18px;margin-top:3px;color:var(--muted);overflow-wrap:anywhere}.process-temperature>p{padding:0 12px 12px}.process-care-panel button:focus-visible{outline:2px solid var(--brand);outline-offset:2px}@media(max-width:760px),(pointer:coarse){.process-temperature dl{grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.process-care-panel{gap:10px;margin-bottom:14px}.process-quick-options{grid-template-columns:minmax(0,1fr)}}
</style>
