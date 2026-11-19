<script setup lang="ts">
import HealthProcessEditorDialog from '../components/HealthProcessEditorDialog.vue';
import ObservationEditorModal from '../components/ObservationEditorModal.vue';
import ObservationReceipt from '../components/ObservationReceipt.vue';
import { observationDescription } from '../utils/health-observation';
import { formatMedicationDate } from '../utils/medication-date';
import type { HealthObservation,ObservationRef,SymptomContinuationCandidate,SymptomContinuationPage } from '../../../shared/health-observations';
import InitialSymptomMeasurementFields from '../components/InitialSymptomMeasurementFields.vue';
import { symptomMeasurementDefinitions, measurementsForSymptom, validSymptomMeasurementValue, type InitialSymptomMeasurement } from '../../../shared/symptom-measurements';
import { symptomAreas, symptomBodyAreaOptions, symptomTriggerOptions, symptomReliefOptions, associatedSymptomChoices, toggleAssociatedSymptom, localSymptomDate, type SymptomAreaId } from '../utils/symptom-presets';
import FormSuggest from '../components/FormSuggest.vue';
import { symptomFrequencyOptions } from '../utils/record-form-options';
import {computed,nextTick,onActivated,onBeforeUnmount,onDeactivated,reactive,ref,watch} from 'vue';
import {useRoute,useRouter,type LocationQuery} from 'vue-router';
import {ChevronDown,LoaderCircle} from '@lucide/vue';
import SubPageHeader from '../components/SubPageHeader.vue';
import DateTimePicker from '../components/DateTimePicker.vue';
import SymptomSeverityPicker from '../components/SymptomSeverityPicker.vue';
import HealthRecordAssociationField from '../components/HealthRecordAssociationField.vue';
import {useAppContext} from '../composables/useAppContext';
import {useUnsavedRecord} from '../composables/useUnsavedRecord';
import {createSubmissionKey} from '../utils/submission-key';
import {isHealthRecordKind} from '../utils/health-record-navigation';
import {vaccinationReturnTo} from '../utils/vaccination';
import {request} from '../utils/api';
import type {HealthRecordRef} from '../../../shared/health-record-associations';
const props=defineProps<{embedded?:boolean;processId?:string;memberId?:string;returnFocus?:HTMLElement|null}>();
const emit=defineEmits<{close:[];saved:[]}>();
const app=useAppContext(),currentRoute=useRoute(),router=useRouter();
const route=reactive({
 get path(){return props.embedded?'/add/symptom':currentRoute.path;},
 get fullPath(){return props.embedded?'/health-processes/'+encodeURIComponent(props.processId||''):currentRoute.fullPath;},
 get query():LocationQuery{return props.embedded?{processId:props.processId||null,memberId:props.memberId||null}:currentRoute.query;}
});
const pageActive=ref(true);
const busy=ref(false),error=ref(''),symptomTitle=ref(''),symptomDate=ref<string|null>('');
const bodyArea=ref(''),severity=ref<number|null>(null),frequency=ref(''),description=ref(''),triggerText=ref(''),relievingText=ref(''),associatedSymptomsText=ref('');
const formRoot=ref<HTMLFormElement|null>(null),measurementIssue=ref('');
const measurementDrafts=reactive<Record<string,{value:string;recordedAt:string|null}>>({});
const manualTemperature=ref(false);
const primaryMeasurements=computed(()=>measurementsForSymptom(symptomTitle.value));
const associatedMeasurements=computed(()=>associatedSymptomsText.value.split(/[、,，;；\n]+/).flatMap(name=>measurementsForSymptom(name)));
const temperatureAtCompanion=computed(()=>!primaryMeasurements.value.some(item=>item.id==='temperature')&&associatedMeasurements.value.some(item=>item.id==='temperature'));
const measurementDefinitions=computed(()=>[...new Map([...primaryMeasurements.value,...associatedMeasurements.value,...(manualTemperature.value?symptomMeasurementDefinitions.filter(item=>item.id==='temperature'):[])].map(item=>[item.id,item])).values()]);
async function expandTemperature(){manualTemperature.value=true;await nextTick();formRoot.value?.querySelector<HTMLInputElement>('[data-measurement-input="temperature"]')?.focus();}
watch(temperatureAtCompanion,value=>{if(value)void nextTick(()=>formRoot.value?.querySelector<HTMLElement>('.symptom-associated-measurements')?.scrollIntoView?.({block:'nearest'}));});
function localMeasurementTime(){const now=new Date();return new Date(now.getTime()-now.getTimezoneOffset()*60000).toISOString().slice(0,19);}
watch(measurementDefinitions,definitions=>{for(const definition of definitions)if(!measurementDrafts[definition.id])measurementDrafts[definition.id]={value:'',recordedAt:localMeasurementTime()};},{immediate:true,flush:'sync'});
const initialMeasurements=computed<InitialSymptomMeasurement[]>(()=>measurementDefinitions.value.filter(definition=>measurementDrafts[definition.id]?.value.trim()).map(definition=>({kind:definition.id,value:measurementDrafts[definition.id].value.trim(),recordedAt:measurementDrafts[definition.id].recordedAt||''})));
watch(initialMeasurements,()=>{measurementIssue.value='';});
function measurementError(){for(const measurement of initialMeasurements.value){const definition=measurementDefinitions.value.find(definition=>definition.id===measurement.kind)!;if(!validSymptomMeasurementValue(definition,measurement.value))return `请填写有效的${definition.label}数值`;if(!measurement.recordedAt)return '请选择测量时间';}return '';}
const areaId=ref<SymptomAreaId>('general'),allAreas=ref(false),selectedPreset=ref('');
const selectedArea=computed(()=>symptomAreas.find(area=>area.id===areaId.value)!);
const visibleAreas=computed(()=>allAreas.value?symptomAreas:symptomAreas.filter((area,index)=>index<7||area.id===areaId.value));
const bodyAreaOptions=computed(()=>symptomBodyAreaOptions(areaId.value));
const symptomOptions=computed(()=>selectedArea.value.symptoms.map(value=>({value,label:value})));
function selectArea(id:SymptomAreaId){
 if(busy.value)return;if(areaId.value===id){allAreas.value=false;return;}const next=symptomAreas.find(area=>area.id===id)!;
 if(selectedPreset.value&&!(next.symptoms as readonly string[]).includes(selectedPreset.value)){symptomTitle.value='';selectedPreset.value='';}
 areaId.value=id;bodyArea.value=next.value;allAreas.value=false;
}
function selectSymptom(name:string){if(busy.value)return;symptomTitle.value=name;selectedPreset.value=name;}
function changeBodyArea(value:string){bodyArea.value=value;}
function hasAssociated(name:string){return associatedSymptomsText.value.split(/[、,，;；\n]+/).map(value=>value.trim()).includes(name);}
const moreOpen=ref(false),relatedRecords=ref<HealthRecordRef[]>([]);
const supplementalSummary=computed(()=>{
 const parts=[bodyArea.value&&bodyArea.value!==selectedArea.value.value?bodyArea.value:'',severity.value!==null?`程度 ${severity.value}/10`:'',frequency.value,triggerText.value,relievingText.value,associatedSymptomsText.value?`伴随：${associatedSymptomsText.value}`:'',description.value?'已填描述':''].filter(Boolean);
 return parts.length?parts.slice(0,2).join(' · ')+(parts.length>2?` · 另 ${parts.length-2} 项`:''):'部位细化、程度、频率等 · 选填';
});
const severitySelection=computed({get:()=>severity.value===null?'':String(severity.value),set:(value:string)=>{severity.value=value===''?null:Number(value);}});
const backTo=computed(()=>vaccinationReturnTo(route.query.returnTo,'/events'));
const sourceMember=ref('');let sourceKey='',draftKey='',generation=0;
const hasSource=computed(()=>Boolean(route.query.processId||route.query.relatedId||route.query.relatedKind||route.query.memberId));
const contextMismatch=computed(()=>hasSource.value&&sourceMember.value!==app.selectedMemberId.value);
const sourceInvalid=computed(()=>Boolean(route.query.relatedId||route.query.relatedKind)&&(!isHealthRecordKind(route.query.relatedKind)||typeof route.query.relatedId!=='string'||!route.query.relatedId.trim()||route.query.relatedId.length>200));
const submissionKey=createSubmissionKey();
const candidateRoot=ref<HTMLElement|null>(null),continuation=ref<SymptomContinuationCandidate|null>(null),continuationInitial=ref<Partial<HealthObservation>>({}),editingObservation=ref<ObservationRef|null>(null),receipt=ref<HealthObservation|null>(null);
const observationOpener=ref<HTMLElement|null>(null);
const leave=useUnsavedRecord(()=>JSON.stringify([symptomTitle.value,symptomDate.value,bodyArea.value,severity.value,frequency.value,description.value,triggerText.value,relievingText.value,associatedSymptomsText.value,relatedRecords.value,initialMeasurements.value]),busy,()=>!continuation.value&&!editingObservation.value);
const candidates=ref<SymptomContinuationCandidate[]>([]),candidateLoading=ref(false),candidateError=ref(''),candidateScopeLabel=ref(''),candidateCursor=ref<string|null>(null);

let candidateGeneration=0,candidateLoaded='';let candidateTimer:ReturnType<typeof setTimeout>|undefined;let candidateFlight:{scope:string;promise:Promise<boolean>}|null=null;
const candidateScope=computed(()=>JSON.stringify([route.path,app.selectedMemberId.value,symptomTitle.value.trim(),route.query.processId,relatedRecords.value]));
async function findCandidates(scope:string,more=false){
 if(!pageActive.value)return false;
 const token=++candidateGeneration;candidateLoading.value=true;candidateError.value='';const memberId=app.selectedMemberId.value;
 try{const page=await request<SymptomContinuationPage>('symptoms/candidates',{method:'POST',body:JSON.stringify({memberId,name:symptomTitle.value.trim(),...(route.query.processId?{processId:route.query.processId}:{}),relatedRecords:relatedRecords.value,...(more&&candidateCursor.value?{cursor:candidateCursor.value}:{})})});
  if(!pageActive.value||token!==candidateGeneration||scope!==candidateScope.value||route.path!=='/add/symptom')return false;
  if(page.memberId!==memberId||!Array.isArray(page.items)||page.items.some(item=>item.memberId!==memberId))throw Error('已有症状与当前成员不一致');
  candidates.value=more?[...new Map([...candidates.value,...page.items].map(item=>[item.id,item])).values()]:page.items;candidateCursor.value=page.nextCursor||null;candidateScopeLabel.value=page.scope==='process'?'当前历程':page.scope==='related'?'关联记录所属历程':'此成员的历史记录';candidateLoaded=scope;return true;
 }catch(cause){if(token===candidateGeneration){candidateError.value=cause instanceof Error?cause.message:'查找已有症状失败';}return false;}finally{if(token===candidateGeneration){candidateLoading.value=false;candidateFlight=null;}}
}
function retryCandidates(){candidateLoaded='';void ensureCandidates();}
function moreCandidates(){if(!candidateLoading.value&&candidateCursor.value)void findCandidates(candidateScope.value,true);}
function ensureCandidates(){clearTimeout(candidateTimer);const scope=candidateScope.value;if(candidateLoaded===scope)return Promise.resolve(true);if(candidateFlight?.scope===scope)return candidateFlight.promise;const promise=findCandidates(scope);candidateFlight={scope,promise};return promise;}
watch(candidateScope,()=>{candidateGeneration++;clearTimeout(candidateTimer);candidateFlight=null;candidateLoaded='';candidates.value=[];candidateCursor.value=null;candidateError.value='';candidateLoading.value=false;
 if(pageActive.value&&route.path==='/add/symptom'&&app.selectedMember.value?.permission==='manager'&&symptomTitle.value.trim()&&!contextMismatch.value&&!sourceInvalid.value)candidateTimer=setTimeout(()=>void ensureCandidates(),180);
},{immediate:true,flush:'sync'});
function openContinuation(candidate:SymptomContinuationCandidate){
 if(busy.value||candidate.memberId!==app.selectedMemberId.value)return;const invalid=measurementError();if(invalid){measurementIssue.value=invalid;return;}
 if(initialMeasurements.value.length>1){error.value='多个测量请分别续记';return;}
 observationOpener.value=document.activeElement instanceof HTMLElement?document.activeElement:null;
 const measurement=initialMeasurements.value[0],primary=measurement&&measurementsForSymptom(candidate.name).find(item=>item.id===measurement.kind);continuationInitial.value={measurementValue:primary?measurement.value:null,measurementUnit:primary?primary.unit:candidate.unit,temperatureValue:measurement&&!primary&&measurement.kind==='temperature'?measurement.value:null,recordedAt:measurement?.recordedAt,severity:severity.value,description:description.value||null};continuation.value=candidate;editingObservation.value=null;
}
function editReceipt(ref:ObservationRef,event?:MouseEvent){observationOpener.value=event?.currentTarget as HTMLElement||null;editingObservation.value=ref;continuation.value=null;}
function observationSaved(entry:HealthObservation){if(props.embedded){leave.reset();emit('saved');return;}const continued=Boolean(continuation.value);continuation.value=null;editingObservation.value=null;receipt.value=entry;
 if(continued){manualTemperature.value=false;symptomTitle.value='';areaId.value='general';selectedPreset.value='';bodyArea.value='';symptomDate.value='';severity.value=null;frequency.value='';description.value='';triggerText.value='';relievingText.value='';associatedSymptomsText.value='';for(const key of Object.keys(measurementDrafts))delete measurementDrafts[key];moreOpen.value=false;leave.reset();}
 void nextTick(()=>formRoot.value?.querySelector<HTMLButtonElement>('[data-observation-edit]')?.focus({preventScroll:true}));
}
watch(()=>JSON.stringify([route.path,route.query,app.selectedMemberId.value]),()=>{
 if(route.path!=='/add/symptom')return;const member=app.selectedMemberId.value;const key=JSON.stringify([route.query,member]);if(key===draftKey)return;
 generation++;draftKey=key;const nextSource=JSON.stringify(route.query);if(nextSource!==sourceKey){sourceKey=nextSource;sourceMember.value=typeof route.query.memberId==='string'?route.query.memberId:member;}
 busy.value=false;error.value='';manualTemperature.value=false;continuation.value=null;editingObservation.value=null;receipt.value=null;measurementIssue.value='';for(const key of Object.keys(measurementDrafts))delete measurementDrafts[key];areaId.value='general';allAreas.value=false;selectedPreset.value='';symptomTitle.value='';symptomDate.value='';bodyArea.value='';severity.value=null;frequency.value='';description.value='';triggerText.value='';relievingText.value='';associatedSymptomsText.value='';moreOpen.value=false;
 relatedRecords.value=!sourceInvalid.value&&isHealthRecordKind(route.query.relatedKind)?[{kind:route.query.relatedKind,id:String(route.query.relatedId)}]:[];
 submissionKey.reset();leave.reset();
},{immediate:true,flush:'sync'});
async function createSymptom(forceNew=false){
 const memberId=app.selectedMemberId.value;if(!pageActive.value||route.path!=='/add/symptom'||busy.value||!memberId||contextMismatch.value||sourceInvalid.value||app.selectedMember.value?.permission!=='manager')return;
 if(!forceNew){const scope=candidateScope.value;if(!await ensureCandidates()||scope!==candidateScope.value||route.path!=='/add/symptom')return;if(candidates.value.length){if(candidates.value.length===1)openContinuation(candidates.value[0]);else candidateRoot.value?.focus();return;}}
 if(busy.value||memberId!==app.selectedMemberId.value||app.selectedMember.value?.permission!=='manager')return;
 const invalidMeasurement=measurementError();if(invalidMeasurement){measurementIssue.value=invalidMeasurement;void nextTick(()=>formRoot.value?.querySelector<HTMLInputElement>('[data-measurement-input]')?.focus());return;}
 measurementIssue.value='';
 const token=generation;busy.value=true;error.value='';
 const payload={memberId,name:symptomTitle.value,startedAt:symptomDate.value||null,bodyArea:bodyArea.value,severity:severity.value,frequency:frequency.value,description:description.value,triggerText:triggerText.value,relievingText:relievingText.value,associatedSymptomsText:associatedSymptomsText.value,relatedRecords:relatedRecords.value,...(initialMeasurements.value.length?{initialMeasurements:initialMeasurements.value}:{}),...(route.query.processId?{processId:route.query.processId}:{})};
 try{const created=await request<{id:string;memberId:string}>('symptoms',{method:'POST',body:JSON.stringify({...payload,requestKey:submissionKey.forRequest('symptoms',payload)})});
  if(token!==generation||memberId!==app.selectedMemberId.value||route.path!=='/add/symptom')return;
  if(created.memberId!==memberId||!created.id)throw Error('保存结果与当前成员不一致，请刷新后核对');
  busy.value=false;draftKey='';leave.reset();app.notifyDataChanged();if(props.embedded){emit('saved');return;}await router.push({path:'/events/detail/symptom/'+encodeURIComponent(created.id),query:{returnTo:backTo.value}});
 }catch(cause){if(token===generation)error.value=cause instanceof Error?cause.message:'创建症状记录失败';}finally{if(token===generation)busy.value=false;}
}
async function cancel(){if(await leave.confirmLeave()){draftKey='';leave.reset();if(props.embedded){emit('close');return;}void router.push(backTo.value);}}
onActivated(()=>{if(!pageActive.value){pageActive.value=true;candidateFlight=null;candidateLoaded='';candidateLoading.value=false;if(symptomTitle.value.trim()&&!contextMismatch.value&&!sourceInvalid.value)void ensureCandidates();}});
onDeactivated(()=>{pageActive.value=false;generation++;candidateGeneration++;candidateFlight=null;candidateLoading.value=false;clearTimeout(candidateTimer);continuation.value=null;editingObservation.value=null;busy.value=false;});onBeforeUnmount(()=>{pageActive.value=false;generation++;candidateGeneration++;clearTimeout(candidateTimer);});
</script>
<template><component :is="embedded?HealthProcessEditorDialog:'div'" v-bind="embedded?{busy,title:'新增症状',closeLabel:'关闭新增症状',returnFocus}:{}" @close="cancel"><section class="create-page" :class="{'is-embedded':embedded}">
 <SubPageHeader v-if="!embedded" category="symptom" title="记录症状 / 不适" :back-to="backTo" back-label="返回记录" description="仅症状名称必填，其余可稍后补充"/>
 <p v-if="app.selectedMember.value?.permission!=='manager'" class="inline-panel-error" role="alert">当前成员只有查看权限，无法新增。</p>
 <p v-else-if="contextMismatch||sourceInvalid" class="inline-panel-error" role="alert">关联来源与当前成员不一致或已失效，请返回健康历程后重新填写。</p>
 <template v-else>
      <form ref="formRoot" class="create-form" :aria-busy="busy" @submit.prevent="createSymptom()">
        <div class="symptom-create-body">
        <p class="symptom-entry-hint">记录新出现的不适；已有症状加重、减轻或再次出现，请选择“新增变化”。</p>
        <ObservationReceipt v-if="receipt" :record="receipt.ref" :label="receipt.name+' '+observationDescription(receipt)" :recorded-at="receipt.recordedAt" :disabled="busy" @edit="editReceipt"/>
        <section class="settings-band">
          <fieldset class="settings-form create-fields" :disabled="busy">

            <div class="create-field symptom-area-field"><span>哪里不舒服 <small>可先选部位，再选症状</small></span>
              <div class="symptom-presets symptom-areas" role="group" aria-label="不适部位"><button v-for="area in visibleAreas" :key="area.id" type="button" :aria-pressed="areaId===area.id" @click="selectArea(area.id)">{{area.label}}</button><button type="button" class="symptom-more-areas" :aria-expanded="allAreas" @click="allAreas=!allAreas">{{allAreas?'收起部位':'更多部位'}}<ChevronDown :size="12" :class="{'is-open':allAreas}"/></button></div>
            </div>
            <label v-if="areaId==='other'"><span>具体部位（选填）</span><input v-model="bodyArea" aria-label="其他身体部位" maxlength="120" placeholder="如有需要，可填写具体部位" /></label>
            <div class="create-field symptom-name-field"><span>症状 <span class="create-required">必填 · 单选</span></span>
              <div class="symptom-presets symptom-choices" role="group" :aria-label="`${selectedArea.label}常用症状`"><button v-for="item in symptomOptions" :key="item.value" type="button" :aria-pressed="symptomTitle.trim()===item.value" @click="selectSymptom(item.value)">{{item.label}}</button></div>
              <input v-model="symptomTitle" required aria-label="症状名称" maxlength="120" placeholder="没有合适的？在这里填写症状" @input="selectedPreset=''" />
            </div>
            <button v-if="!measurementDefinitions.length" type="button" class="symptom-initial-temperature-add" :disabled="busy" @click="expandTemperature">补充体温（选填）</button>
            <template v-if="!temperatureAtCompanion"><InitialSymptomMeasurementFields v-for="definition in measurementDefinitions" :key="definition.id" :definition="definition" v-model:value="measurementDrafts[definition.id].value" v-model:recorded-at="measurementDrafts[definition.id].recordedAt" :issue="measurementIssue" :disabled="busy"/></template>
            <p v-if="candidateLoading" class="symptom-candidate-state" role="status">正在查找已有症状…</p>
            <p v-if="candidateError" class="inline-panel-error" role="alert">{{candidateError}} <button type="button" class="error-retry" @click="retryCandidates">重试</button><button type="button" class="error-retry" :disabled="busy" @click="createSymptom(true)">仍然新建</button></p>
            <section v-if="candidates.length" ref="candidateRoot" class="symptom-continuations" aria-label="已有同名症状" tabindex="-1"><header><strong>已有同名症状</strong><span>{{candidateScopeLabel}}</span></header><div class="symptom-candidate-list"><div v-for="candidate in candidates" :key="candidate.id" class="symptom-candidate"><div><strong>{{candidate.name}}</strong><span>{{candidate.bodyArea||'部位未记录'}} · 开始 {{formatMedicationDate(candidate.startedAt)||'日期未记录'}}</span><small>{{candidate.status==='resolved'?'已消失':candidate.status==='active'?'持续跟踪':'状态未知'}}<template v-if="candidate.latestAt"> · 最近 {{formatMedicationDate(candidate.latestAt)}}</template></small></div><button type="button" class="soft-action-button" :disabled="busy" @click="openContinuation(candidate)">续记</button></div></div><button v-if="candidateCursor" type="button" class="symptom-create-another" :disabled="candidateLoading" @click="moreCandidates">加载更多同名症状</button><button type="button" class="symptom-create-another" :disabled="busy" @click="createSymptom(true)">这是另一次不适，新建一条</button></section>

            <div class="create-field symptom-date-field"><div class="symptom-date-heading"><span>开始日期</span>
              <div class="symptom-date-shortcuts" role="group" aria-label="开始日期快捷选择"><button v-for="item in [{label:'今天',value:localSymptomDate()},{label:'昨天',value:localSymptomDate(1)},{label:'不确定',value:''}]" :key="item.label" type="button" :aria-pressed="(symptomDate||'')===item.value" @click="symptomDate=item.value">{{item.label}}</button></div>
              </div><DateTimePicker v-model="symptomDate" label="不确定可留空，或选择日期" aria-label="症状开始日期" :disabled="busy" />
            </div>
            <p v-if="route.query.processId" class="preview-hint">保存后加入当前健康历程。</p>
            <HealthRecordAssociationField v-else :key="route.fullPath" v-model="relatedRecords" :member-id="app.selectedMemberId.value" :disabled="busy"/>
          </fieldset>
        </section>
        <details class="settings-band create-more" :open="moreOpen" @toggle="moreOpen = ($event.target as HTMLDetailsElement).open">
          <summary><span><strong>补充信息</strong><small>{{supplementalSummary}}</small></span><ChevronDown :size="18" aria-hidden="true" /></summary>
          <fieldset class="settings-form create-fields" :disabled="busy">
            <label v-if="areaId!=='other'"><span>具体部位</span><FormSuggest :model-value="bodyArea" :options="bodyAreaOptions" label="具体身体部位" maxlength="120" placeholder="可选择或细化，如左下腹" :disabled="busy" @update:model-value="changeBodyArea" /></label>
            <div class="form-grid">
              <SymptomSeverityPicker v-model="severitySelection" label="严重程度（0～10）" title="严重程度（0～10，选填）" :disabled="busy" />
              <label><span>发生频率</span><FormSuggest v-model="frequency" :options="symptomFrequencyOptions" label="症状发生频率" name="frequency" maxlength="120" placeholder="选择或填写" :disabled="busy" /></label>
            </div>
            <label><span>可能诱因</span><FormSuggest v-model="triggerText" :options="symptomTriggerOptions" label="可能诱因" maxlength="500" placeholder="选择或填写" :disabled="busy" /></label>
            <label><span>缓解因素</span><FormSuggest v-model="relievingText" :options="symptomReliefOptions" label="缓解因素" maxlength="500" placeholder="选择或填写" :disabled="busy" /></label>
            <div class="create-field"><label><span>伴随症状 <small>可多选</small></span><input v-model="associatedSymptomsText" aria-label="伴随症状" maxlength="500" placeholder="点选下方，也可填写其他不适" /></label><div class="symptom-presets" role="group" aria-label="伴随症状快捷选择"><button v-for="name in associatedSymptomChoices" :key="name" type="button" :aria-pressed="hasAssociated(name)" :disabled="!hasAssociated(name)&&toggleAssociatedSymptom(associatedSymptomsText,name).length>500" @click="associatedSymptomsText=toggleAssociatedSymptom(associatedSymptomsText,name)">{{name}}</button></div></div>
            <div v-if="temperatureAtCompanion" class="symptom-associated-measurements"><InitialSymptomMeasurementFields v-for="definition in measurementDefinitions" :key="definition.id" :definition="definition" v-model:value="measurementDrafts[definition.id].value" v-model:recorded-at="measurementDrafts[definition.id].recordedAt" :issue="measurementIssue" :disabled="busy"/></div>
            <label><span>具体描述</span><textarea v-model="description" maxlength="2000" rows="3" placeholder="还有需要补充的表现或感受？没有可不填" /></label>
          </fieldset>
        </details>
        <p v-if="error" class="form-error" role="alert">{{ error }}</p>
        </div><div class="form-actions record-form-actions"><button type="button" :disabled="busy" @click="cancel">取消</button><button class="primary-button" type="submit" :disabled="busy||candidateLoading"><LoaderCircle v-if="busy" :size="16" class="spin-icon" aria-hidden="true" />{{ busy ? '正在保存…' : candidates.length===1 ? '续记已有症状' : candidates.length>1 ? '选择已有症状续记' : '保存症状记录' }}</button></div>
      </form>
  <ObservationEditorModal v-if="continuation||editingObservation" :key="editingObservation?editingObservation.kind+editingObservation.id:continuation!.id" :member-id="app.selectedMemberId.value" :process-id="typeof route.query.processId==='string'?route.query.processId:undefined" :target="editingObservation||undefined" :return-focus="observationOpener" :symptom="continuation||undefined" :initial="continuationInitial" :related-records="relatedRecords" @close="continuation=null;editingObservation=null" @saved="observationSaved"/>
 </template></section></component></template>
<style scoped>
.symptom-entry-hint{margin:0;color:var(--muted);font-size:12px;line-height:19px}
.is-embedded{display:flex;flex-direction:column;min-height:0;overflow:hidden}.is-embedded .create-form{display:flex;flex-direction:column;min-height:0;overflow:hidden;gap:0}.symptom-create-body{display:grid;gap:12px;min-width:0}.is-embedded .symptom-create-body{overflow:auto;min-height:0;overscroll-behavior:contain;padding:12px 14px;gap:10px}.is-embedded .settings-band{box-shadow:none;border-radius:0;background:none;overflow:visible}.is-embedded .create-fields{padding:0;gap:10px}.is-embedded .create-more{border-top:1px solid var(--line)}.is-embedded .create-more>summary{padding:10px 0}.is-embedded .create-form>.record-form-actions{position:static;flex-shrink:0;margin:0;padding:8px 14px;border-top:1px solid var(--line);background:var(--surface)}.is-embedded .create-form>.record-form-actions button{font-size:14px}.is-embedded .create-form input,.is-embedded .create-form textarea{font-size:14px}

.symptom-candidate-state{margin:0;color:var(--muted);font-size:12px;line-height:19px}.symptom-continuations{display:grid;gap:8px;padding:10px;border:1px solid var(--line);border-radius:10px;min-width:0}.symptom-continuations>header{display:flex;align-items:center;justify-content:space-between;gap:6px}.symptom-continuations>header>strong{font-size:14px;font-weight:500;color:var(--ink-2)}.symptom-continuations>header>span{font-size:12px;color:var(--muted)}.symptom-candidate-list{display:grid;gap:10px;max-height:240px;overflow:auto;overscroll-behavior:contain;min-width:0}.symptom-candidate{display:flex;align-items:center;justify-content:space-between;gap:8px;min-width:0}.symptom-candidate>div{display:grid;gap:2px;min-width:0;overflow-wrap:anywhere}.symptom-candidate strong{font-size:14px;font-weight:500;color:var(--ink)}.symptom-candidate span,.symptom-candidate small{font-size:12px;line-height:18px;color:var(--muted)}.symptom-candidate>button{flex-shrink:0;font-size:12px;min-height:32px;padding:4px 8px}.symptom-create-another{justify-self:start;min-height:30px;padding:4px 0;border:0;background:none;color:var(--muted);font:inherit;font-size:12px}.symptom-create-another:focus-visible,.symptom-continuations:focus-visible{outline:2px solid var(--brand);outline-offset:2px}
.create-page { min-width: 0; }
.create-form { display: grid; gap: 12px; }
.create-fields { min-width: 0; margin: 0; border: 0; padding: 16px; gap: 14px; }
.create-fields .form-grid { gap: 12px; }
.symptom-area-field > span, .symptom-name-field > span { font-size: 14px; color: var(--ink-2); font-weight: 500; }
.symptom-name-field { border-top: 1px solid var(--line); padding-top: 10px; gap: 6px; }
.symptom-initial-temperature-add{justify-self:start;min-height:32px;padding:4px 0;border:0;background:none;color:var(--brand-strong);font:inherit;font-size:12px;cursor:pointer}.symptom-initial-temperature-add:focus-visible{outline:2px solid var(--brand);outline-offset:2px}.symptom-associated-measurements{display:grid;gap:8px;min-width:0}
.symptom-date-heading { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
.symptom-areas button:not(.symptom-more-areas) { border-radius: 6px; }
.create-field { display: grid; align-content: start; gap: 6px; min-width: 0; color: var(--muted); font-size: 12px; }
.create-field > label { display: grid; gap: 7px; min-width: 0; }
.create-fields textarea { width: 100%; min-height: 80px; padding: 11px 12px; border: 1px solid var(--line-strong); border-radius: 10px; background: var(--surface); color: var(--ink); line-height: 1.6; resize: vertical; outline: 0; }
.create-fields :deep(.datetime-picker input), .create-fields :deep(.form-suggest > input) { border: 0; background: transparent; box-shadow: none; }
.create-fields :deep(.datetime-picker input:focus), .create-fields :deep(.form-suggest > input:focus) { border: 0; box-shadow: none; }
.create-fields textarea:focus { border-color: var(--brand); box-shadow: 0 0 0 3px var(--brand-soft); }
.symptom-presets { display: flex; flex-wrap: wrap; gap: 4px; margin: 0; }
.create-field small, .create-fields label small { color: var(--muted); font-size: 12px; font-weight: 400; margin-left: 6px; }
.symptom-presets .symptom-more-areas { display: inline-flex; align-items: center; gap: 3px; background: transparent; color: var(--brand-strong); }
.symptom-more-areas .is-open { transform: rotate(180deg); }
.symptom-date-shortcuts { display: flex; gap: 6px; flex-wrap: wrap; }
.symptom-date-shortcuts button { min-height: 28px; padding: 3px 10px; border: 0; border-radius: 6px; background: var(--fill-2); color: var(--muted); font: inherit; font-size: 12px; }
.symptom-date-shortcuts button[aria-pressed=true] { background: var(--brand-soft); color: var(--brand-strong); }
.symptom-date-shortcuts button:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; }
.symptom-presets button { min-height: 28px; min-width: 28px; padding: 2px 8px; border: 1px solid transparent; border-radius: 999px; background: var(--fill-2); color: var(--muted); font: inherit; font-size: 12px; line-height: 20px; white-space: nowrap; }
.symptom-presets button[aria-pressed=true] { border-color: var(--brand); background: var(--brand-soft); color: var(--brand-strong); }
.symptom-presets button:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; }
@media (hover:hover) { .symptom-presets button:hover:not(:disabled):not([aria-pressed=true]) { background: var(--fill-3); color: var(--ink); } }
.create-required { color: var(--brand); font-size: 12px; font-weight: 500; }
.create-field :deep(.datetime-picker-trigger), .create-field :deep(.form-select-trigger) { width: 100%; min-height: 44px; }
.create-more > summary { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 12px 16px; cursor: pointer; list-style: none; }
.create-more > summary::-webkit-details-marker { display: none; }
.create-more > summary > span { display: flex; flex: 1; align-items: center; gap: 10px; min-width: 0; }
.create-more > summary strong { flex-shrink: 0; display: block; color: var(--ink); font-size: 14px; }
.create-more > summary small { display: block; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); font-size: 12px; }
.create-more > summary > svg { color: var(--muted); flex-shrink: 0; transition: transform .15s; }
.create-more[open] > summary { border-bottom: 1px solid var(--line); }
.create-more[open] > summary > svg { transform: rotate(180deg); }
@media (max-width: 760px) {
  .create-form { gap: 12px; }
  .create-fields { padding: 14px; gap: 12px; }
  .create-form > .record-form-actions { position: sticky; bottom: calc(66px + var(--safe-bottom, 0px)); z-index: 11; padding: 8px 0; background: var(--background); }
  .create-page :deep(.subpage-header h2) { display: none; }
  .create-more > summary { padding: 12px 14px; }
}
</style>
