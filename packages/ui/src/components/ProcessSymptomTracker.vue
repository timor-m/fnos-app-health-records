<script setup lang="ts">
import SymptomMeasurementFields from './SymptomMeasurementFields.vue';
import { measurementsForSymptom } from '../../../shared/symptom-measurements';
import FormSuggest from './FormSuggest.vue';
import { symptomFrequencyOptions } from '../utils/record-form-options';
import HealthRecordTrashAction from './HealthRecordTrashAction.vue';
import HealthCategoryIcon from './HealthCategoryIcon.vue';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { MoreHorizontal, PencilLine, Plus, X } from '@lucide/vue';
import DateTimePicker from './DateTimePicker.vue';
import SymptomSeverityPicker from './SymptomSeverityPicker.vue';
import { useScrollLock } from '../composables/useScrollLock';
import { useUnsavedRecord } from '../composables/useUnsavedRecord';
import { useConfirm } from '../composables/useConfirm';
import { useAppContext } from '../composables/useAppContext';
import { request } from '../utils/api';
import { createSubmissionKey } from '../utils/submission-key';
import { compareMedicationDates, formatMedicationDate } from '../utils/medication-date';
import { timelineDateParts } from '../utils/health-timeline';
import { healthSymptomChangeLabels, type HealthSymptomChange } from '../../../shared/health-events';
import type { HealthEpisodeDetail, HealthProcessSymptom, HealthProcessSymptomUpdate } from '../types/health-events';

const props = defineProps<{ episode: HealthEpisodeDetail; canManage: boolean; standalone?: boolean }>();
const emit = defineEmits<{ updated: [removedSymptomId?: string] }>();
const app = useAppContext();
const confirmDialog = useConfirm();
const symptoms = computed(() => props.episode.symptoms || []);
const root = ref<HTMLElement|null>(null);
const expandedHistory = ref(new Set<string>());
const symptomRows = computed(() => symptoms.value.map(symptom => {
  // The server returns history oldest first; reverse equal-time entries as well.
  const updates = [...symptom.updates].reverse().sort((a,b) => compareMedicationDates(b.recordedAt,a.recordedAt));
  const severityAt = updates.find(item => !item.deletedAt && item.severity !== null)?.recordedAt || symptom.startedAt;
  const latestMeasurement=updates.find(item=>!item.deletedAt&&(item.temperatureValue||item.measurementValue&&item.measurementUnit));
  const measurementLabel=latestMeasurement?.temperatureValue?'体温':measurementsForSymptom(symptom.name).find(definition=>definition.unit===latestMeasurement?.measurementUnit)?.label||'测量';
  return {symptom,updates,severityAt,latestMeasurement,measurementLabel};
}));
function displayTime(value:string|null) { const date=timelineDateParts(value);return date?[date.day,date.time].filter(Boolean).join(' '):'时间未记录'; }
function toggleHistory(id:string) { if(expandedHistory.value.has(id))expandedHistory.value.delete(id);else expandedHistory.value.add(id); }
function dismissMenus(event?:Event) {
  root.value?.querySelectorAll<HTMLDetailsElement>('.symptom-more[open]').forEach(menu=>{
    if(!event || !(event.target instanceof Node) || !menu.contains(event.target))menu.open=false;
  });
}
function closeMenu(event:KeyboardEvent) { const menu=event.currentTarget as HTMLDetailsElement;menu.open=false;menu.querySelector('summary')?.focus(); }
const mode = ref<'symptom' | 'record' | null>(null);
const selected = ref<HealthProcessSymptom | null>(null);
const editing = ref<HealthProcessSymptomUpdate | null>(null);
const busy = ref(false);
const submissionKey = createSubmissionKey();
const error = ref('');
const panel = ref<HTMLElement | null>(null);
const visible = computed(() => mode.value !== null);
useScrollLock(visible);
let disposed = false;
let opener: HTMLElement | null = null;
let generation = 0;
const blank = () => ({ name:'', startedAt:null as string | null, bodyArea:'', frequency:'', description:'',
  triggerText:'',relievingText:'',associatedSymptomsText:'',severity:null as number | null,
  recordedAt:null as string | null,change:'' as HealthSymptomChange | '',temperatureValue:'',measurementValue:'',measurementUnit:'' });
const draft = ref(blank());
const leave=useUnsavedRecord(()=>mode.value?JSON.stringify(draft.value):'',busy);
const severitySelection = computed({get:()=>draft.value.severity===null?'':String(draft.value.severity),set:(value:string)=>{draft.value.severity=value===''?null:Number(value);}});
const current = (id: string, memberId: string) => !disposed && props.episode.id===id && props.episode.memberId===memberId
  && app.selectedMember.value?.id===memberId && props.canManage;
function nowLocal() { const d=new Date();const p=(n:number)=>String(n).padStart(2,'0');return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; }
async function close() {if(!await leave.confirmLeave())return;mode.value=null;error.value='';leave.reset();void nextTick(()=>opener?.focus({preventScroll:true}));}
function focusPanel() { const focused=document.activeElement as HTMLElement|null;opener=focused?.closest('.symptom-more')?.querySelector('summary')||focused;dismissMenus();void nextTick(()=>panel.value?.querySelector<HTMLElement>('input,button')?.focus()); }
function openSymptom(symptom?: HealthProcessSymptom) {
  if(!props.canManage || busy.value)return;
  submissionKey.reset();
  selected.value=symptom||null;editing.value=null;draft.value=blank();error.value='';mode.value='symptom';
  if(symptom) Object.assign(draft.value,symptom);
  leave.reset();focusPanel();
}
function openRecord(symptom:HealthProcessSymptom,update?:HealthProcessSymptomUpdate) {
  if(!props.canManage || busy.value)return;
  submissionKey.reset();
  selected.value=symptom;editing.value=update||null;draft.value=blank();error.value='';mode.value='record';
  draft.value.recordedAt=update?.recordedAt||nowLocal();
  draft.value.change=update ? update.change??'' : symptom.status==='resolved'?'':'unchanged';
  draft.value.severity=update?.severity??null;draft.value.description=update?.description||'';
  draft.value.temperatureValue=update?.temperatureValue||'';draft.value.measurementValue=update?.measurementValue||'';draft.value.measurementUnit=update?.measurementUnit||'';
  leave.reset();focusPanel();
}
async function mutate(path:string,method:string,body:unknown) {
  const id=props.episode.id;const memberId=props.episode.memberId;const operation=generation;
  if(busy.value||!current(id,memberId))return;
  busy.value=true;error.value='';
  const payload = method==='POST' ? {...body as Record<string,unknown>,requestKey:submissionKey.forRequest(path,body)} : body;
  try { await request(path,{method,body:JSON.stringify(payload)});
    app.notifyDataChanged();
    if(operation===generation&&current(id,memberId)){mode.value=null;leave.reset();emit('updated',method==='DELETE'&&!path.includes('/updates/')?decodeURIComponent(path.split('/').at(-1)!):undefined);void nextTick(()=>opener?.focus({preventScroll:true}));}
  } catch(cause) { if(operation===generation&&current(id,memberId))error.value=cause instanceof Error?cause.message:'保存失败，请重试'; }
  finally {busy.value=false;}
}
function save() {
  const prefix=`episodes/${encodeURIComponent(props.episode.id)}/symptoms`;
  if(mode.value==='symptom') {
    const {name,startedAt,bodyArea,severity,frequency,description,triggerText,relievingText,associatedSymptomsText}=draft.value;
    void mutate(selected.value?`${prefix}/${encodeURIComponent(selected.value.id)}`:prefix,selected.value?'PATCH':'POST',
      {name,startedAt,bodyArea,severity,frequency,description,triggerText,relievingText,associatedSymptomsText,version:selected.value?.version});
  } else if(selected.value) {
    const {recordedAt,change,severity,temperatureValue,measurementValue,measurementUnit,description}=draft.value;
    const path=`${prefix}/${encodeURIComponent(selected.value.id)}/updates`;
    void mutate(editing.value?`${path}/${encodeURIComponent(editing.value.id)}`:path,editing.value?'PATCH':'POST',
      {recordedAt,change:change||null,severity,temperatureValue:temperatureValue||null,measurementValue:measurementValue||null,measurementUnit:measurementUnit||null,description,version:editing.value?.version});
  }
}
function retract(symptom:HealthProcessSymptom,update?:HealthProcessSymptomUpdate) {
  if(busy.value||!props.canManage)return;
  const id=props.episode.id;const memberId=props.episode.memberId;
  confirmDialog.ask({title:update?'撤销变化记录':'移除症状条目',message:update?'撤销后将重新按其余记录显示症状状态，原记录会保留。':'该症状将从当前历程隐藏，已有记录会保留。',confirmText:'确认撤销',danger:true,
    run:async()=>{if(!current(id,memberId))return;const base=`episodes/${encodeURIComponent(id)}/symptoms/${encodeURIComponent(symptom.id)}`;
      await mutate(update?`${base}/updates/${encodeURIComponent(update.id)}`:base,'DELETE',{version:update?.version??symptom.version});}});
}
function onKey(event:KeyboardEvent) {
  if(event.key==='Escape'){event.preventDefault();close();return;}
  if(event.key!=='Tab'||!panel.value)return;
  const controls=Array.from(panel.value.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),[tabindex="0"]'));
  const first=controls[0],last=controls.at(-1);
  if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}
  else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
}
watch([()=>props.episode.id,()=>app.selectedMember.value?.id],()=>{++generation;mode.value=null;error.value='';expandedHistory.value.clear();dismissMenus();leave.reset();});
onMounted(()=>document.addEventListener('pointerdown',dismissMenus));
onBeforeUnmount(()=>{disposed=true;++generation;document.removeEventListener('pointerdown',dismissMenus);});
</script>

<template>
  <section ref="root" class="settings-band process-symptoms" :class="{'is-standalone':standalone}">
    <header v-if="!standalone"><HealthCategoryIcon category="symptom" :size="26" /><div><h3>症状跟踪 <span class="event-count">{{ symptoms.length }} 项</span></h3><p>每个症状单独记录变化，症状消失不会结束整个健康历程。</p></div><button v-if="canManage" class="soft-action-button" type="button" :disabled="busy" @click="openSymptom()"><Plus :size="15" />添加症状</button></header>
    <p v-if="error && !mode" class="inline-panel-error" role="alert">{{ error }}</p>
    <p v-if="!symptoms.length" class="event-empty">可在这个阶段中持续记录多个症状。</p>
    <article v-for="{symptom,updates,severityAt,latestMeasurement,measurementLabel} in symptomRows" :key="symptom.id" class="process-symptom">
      <component :is="standalone ? HealthRecordTrashAction : 'div'" :class="standalone ? 'symptom-detail-toolbar' : 'symptom-heading'"
        v-bind="standalone ? {target:canManage ? {kind:'symptom' as const,id:symptom.id,memberId:episode.memberId,title:symptom.name,revision:symptom.version} : undefined,disabled:busy} : {}"
        @trashed="emit('updated',symptom.id)">
        <div class="symptom-current"><strong v-if="!standalone">{{ symptom.name }}</strong><span :class="standalone ? ['record-detail-status',`is-${symptom.status}`] : 'chip'">{{ symptom.status === 'resolved' ? '已消失' : symptom.status === 'unknown' ? '状态未知' : '持续跟踪' }}</span></div>
        <button v-if="standalone && canManage" class="soft-action-button symptom-toolbar-edit" type="button" :disabled="busy" @click="openSymptom(symptom)"><PencilLine :size="14" />编辑</button>
        <div v-if="canManage && !standalone" class="symptom-heading-actions">
          <button class="primary-button symptom-record-add" type="button" :disabled="busy" @click="openRecord(symptom)">新增变化</button>
          <button class="symptom-edit" type="button" :disabled="busy" @click="openSymptom(symptom)">编辑</button>
          <HealthRecordTrashAction v-if="!standalone" :key="episode.id+symptom.id" :target="{kind:'symptom',id:symptom.id,memberId:episode.memberId,title:symptom.name,revision:symptom.version}" :disabled="busy" @trashed="emit('updated',symptom.id)"/>
        </div>
      </component>
      <div class="symptom-information" :class="{'symptom-detail-section':standalone}">
        <div v-if="standalone" class="symptom-detail-section-heading">
          <h4 class="symptom-detail-section-title">症状信息</h4>
          <div v-if="canManage" class="record-detail-compact-actions symptom-detail-actions">
            <button class="soft-action-button symptom-record-add" type="button" :disabled="busy" @click="openRecord(symptom)"><Plus :size="14" />新增变化</button>
          </div>
        </div>
        <dl class="symptom-facts" :class="{'preview-facts record-detail-facts':standalone}">
          <div><dt>开始时间</dt><dd>{{ formatMedicationDate(symptom.startedAt) || '未记录' }}</dd></div>
          <div><dt>最近程度</dt><dd class="symptom-severity">{{ symptom.currentSeverity == null ? '未记录' : `${symptom.currentSeverity} / 10` }}<small v-if="symptom.currentSeverity != null">{{ formatMedicationDate(severityAt) || '时间未记录' }}</small></dd></div>
          <div v-if="standalone&&latestMeasurement"><dt>最近{{measurementLabel}}</dt><dd class="symptom-severity">{{latestMeasurement.temperatureValue||latestMeasurement.measurementValue}} {{latestMeasurement.temperatureValue?'℃':latestMeasurement.measurementUnit}}<small>{{formatMedicationDate(latestMeasurement.recordedAt)}}</small><button v-if="canManage" type="button" class="symptom-measurement-edit" :disabled="busy" @click="openRecord(symptom,latestMeasurement)">修改测量</button></dd></div>
          <div v-if="symptom.endedAt"><dt>结束时间</dt><dd>{{ formatMedicationDate(symptom.endedAt) }}</dd></div>
          <div v-if="symptom.bodyArea"><dt>身体部位</dt><dd>{{ symptom.bodyArea }}</dd></div>
          <div v-if="symptom.frequency"><dt>出现频率</dt><dd>{{ symptom.frequency }}</dd></div>
        </dl>
      </div>
      <section v-if="standalone && (symptom.description || symptom.triggerText || symptom.relievingText || symptom.associatedSymptomsText)" class="symptom-detail-section symptom-description-section" aria-label="补充描述">
        <h4 class="symptom-detail-section-title">补充描述</h4>
        <dl class="symptom-description-facts">
          <div v-if="symptom.description" class="symptom-description-main"><dt>症状描述</dt><dd class="symptom-detail-note">{{ symptom.description }}</dd></div>
          <div v-if="symptom.triggerText"><dt>诱因</dt><dd class="symptom-detail-note">{{ symptom.triggerText }}</dd></div>
          <div v-if="symptom.relievingText"><dt>缓解因素</dt><dd class="symptom-detail-note">{{ symptom.relievingText }}</dd></div>
          <div v-if="symptom.associatedSymptomsText"><dt>伴随症状</dt><dd class="symptom-detail-note">{{ symptom.associatedSymptomsText }}</dd></div>
        </dl>
      </section>
      <p v-if="!standalone && symptom.description" class="symptom-description">{{ symptom.description }}</p>
      <dl v-if="!standalone && (symptom.triggerText || symptom.relievingText || symptom.associatedSymptomsText)" class="symptom-extra">
        <div v-if="symptom.triggerText"><dt>诱因</dt><dd>{{ symptom.triggerText }}</dd></div>
        <div v-if="symptom.relievingText"><dt>缓解因素</dt><dd>{{ symptom.relievingText }}</dd></div>
        <div v-if="symptom.associatedSymptomsText"><dt>伴随症状</dt><dd>{{ symptom.associatedSymptomsText }}</dd></div>
      </dl>
      <component :is="standalone ? 'details' : 'section'" v-if="!standalone || updates.length" class="symptom-history" :class="{'record-detail-disclosure':standalone}" :open="standalone || undefined" aria-label="变化记录">
        <summary v-if="standalone"><h4 class="symptom-detail-section-title">变化记录<span class="symptom-history-count">（{{ updates.length }}）</span></h4></summary>
        <header v-else><h4>变化记录 <span>· {{ updates.length }}</span></h4></header>
        <p v-if="!updates.length" class="symptom-empty">还没有变化记录。</p>
        <div v-for="item in expandedHistory.has(symptom.id) ? updates : updates.slice(0,3)" :key="item.id" class="symptom-record" :class="{'is-retracted':item.deletedAt}">
          <div class="symptom-record-main"><div class="symptom-record-heading"><time :datetime="item.recordedAt" :title="formatMedicationDate(item.recordedAt)">{{ standalone ? formatMedicationDate(item.recordedAt) : displayTime(item.recordedAt) }}</time><span class="symptom-change-label" :class="item.deletedAt ? '' : `change-${item.change}`">{{ item.deletedAt ? '已撤销' : item.change ? healthSymptomChangeLabels[item.change] : '补充记录' }}</span><span v-if="item.severity != null" class="symptom-record-severity">{{ item.severity }} / 10</span><span v-if="item.version>1 && !item.deletedAt" class="symptom-corrected">已更正</span></div>
          <p v-if="item.measurementValue">测量：{{ item.measurementValue }} {{ item.measurementUnit }}</p><p v-if="item.temperatureValue">体温：{{item.temperatureValue}} ℃</p><p v-if="item.description">{{ item.description }}</p></div>
          <details v-if="canManage&&!item.deletedAt" class="symptom-more symptom-actions" @keydown.esc.stop.prevent="closeMenu($event)"><summary :aria-label="`${formatMedicationDate(item.recordedAt)} 记录更多操作`"><MoreHorizontal :size="16" /></summary><div class="symptom-menu"><button type="button" :disabled="busy" @click="openRecord(symptom,item)">纠错</button><button class="is-danger" type="button" :disabled="busy" @click="dismissMenus();retract(symptom,item)">撤销</button></div></details>
        </div>
        <button v-if="updates.length>3" class="symptom-history-toggle" type="button" :aria-expanded="expandedHistory.has(symptom.id)" @click="toggleHistory(symptom.id)">{{ expandedHistory.has(symptom.id) ? '收起较早记录' : `查看全部 ${updates.length} 条变化` }}</button>
      </component>
    </article>
  </section>
  <Teleport to="body">
    <div v-if="mode" class="sheet-backdrop symptom-sheet-backdrop" @click.self="close" @keydown="onKey">
      <section ref="panel" class="sheet-panel symptom-sheet record-sheet" role="dialog" aria-modal="true" :aria-label="mode==='symptom'?(selected?'编辑症状':'添加症状'):(editing?'纠错变化记录':'记录症状变化')">
        <span class="sheet-grabber" aria-hidden="true"></span>
        <header><h3>{{ mode==='symptom'?(selected?'编辑症状':'添加症状'):(editing?'修改记录':'新增变化')+' · '+selected?.name }}</h3><button type="button" aria-label="关闭症状面板" :disabled="busy" @click="close"><X :size="20" /></button></header>
        <form @submit.prevent="save"><fieldset :disabled="busy" class="settings-form">
          <template v-if="mode==='symptom'"><label><span>症状名称</span><input v-model="draft.name" required maxlength="120" /></label><div class="symptom-field"><span>开始时间</span><DateTimePicker v-model="draft.startedAt" aria-label="症状开始时间" show-time :disabled="busy" /></div><label><span>身体部位</span><input v-model="draft.bodyArea" maxlength="120" /></label></template>
          <template v-else><p v-if="!editing" class="symptom-help">补充这个症状的变化，不会新增症状记录。</p><div class="symptom-change" role="group" aria-label="症状变化"><button v-for="(label,value) in healthSymptomChangeLabels" :key="value" type="button" :aria-pressed="draft.change===value" @click="draft.change=value">{{ label }}</button><button type="button" :aria-pressed="draft.change===''" @click="draft.change=''">仅补充</button></div><p class="symptom-help">“消失”只更新这个症状，之后仍可继续记录。</p><div class="symptom-field"><span>记录时间</span><DateTimePicker v-model="draft.recordedAt" aria-label="变化记录时间" show-time :disabled="busy" /></div></template>
          <SymptomSeverityPicker v-model="severitySelection" :disabled="busy" />
          <SymptomMeasurementFields v-if="mode==='record'" :name="selected?.name||''" v-model:value="draft.measurementValue" v-model:unit="draft.measurementUnit" v-model:temperature="draft.temperatureValue" :disabled="busy"/>

          <label><span>{{ mode==='symptom'?'症状描述':'补充说明' }}</span><textarea v-model="draft.description" maxlength="2000" rows="3" /></label>
          <details v-if="mode==='symptom'"><summary>其他信息</summary><label><span>频率</span><FormSuggest v-model="draft.frequency" :options="symptomFrequencyOptions" label="症状发生频率" name="frequency" maxlength="120" placeholder="选择或填写" :disabled="busy" /></label><label><span>诱因</span><input v-model="draft.triggerText" maxlength="500" /></label><label><span>缓解因素</span><input v-model="draft.relievingText" maxlength="500" /></label><label><span>伴随症状原文</span><input v-model="draft.associatedSymptomsText" maxlength="500" /></label></details>
          <p v-if="error" class="inline-panel-error" role="alert">{{ error }}</p><div class="form-actions record-form-actions"><button type="button" @click="close">取消</button><button class="primary-button" type="submit">{{ busy?'保存中…':mode==='symptom'?(selected?'保存修改':'新增症状'):editing?'保存修改':'新增记录' }}</button></div>
        </fieldset></form>
      </section>
    </div>
  </Teleport>
</template>
<style scoped>
.process-symptoms { overflow: visible; }
.process-symptoms.is-standalone { border: 0; border-radius: 0; box-shadow: none; background: transparent; }
.process-symptoms.is-standalone > .process-symptom { display: grid; gap: 14px; padding: 8px var(--record-inset,16px) 14px; }
.is-standalone .symptom-detail-toolbar { align-items: center; gap: 8px; padding: 0; }
.symptom-detail-toolbar > .symptom-current { margin-right: auto; }
.symptom-toolbar-edit { min-height: 32px; padding: 5px 10px; font-size: 12px; font-weight: 600; line-height: 20px; white-space: nowrap; }
.is-standalone .symptom-facts { grid-template-columns: minmax(0,1fr); gap: 0; margin: 0; }
.is-standalone .symptom-facts dt { font-size: 12px; line-height: 1.6; }
.is-standalone .symptom-facts dd { margin: 0; font-size: 14px; font-weight: 400; line-height: 1.6; }
.symptom-measurement-edit{min-height:28px;padding:2px 0;border:0;background:none;color:var(--brand-strong);font:inherit;font-size:12px}
.is-standalone .symptom-facts .symptom-severity { flex-direction: column; align-items: flex-end; gap: 2px; }
.is-standalone .symptom-detail-note { white-space: pre-wrap; }
.is-standalone .symptom-detail-section { display: grid; gap: 10px; min-width: 0; padding-top: 14px; border-top: 1px solid var(--line); }
.is-standalone .symptom-detail-section-title { margin: 0; color: var(--ink); font-size: 16px; font-weight: 600; line-height: 24px; }
.symptom-detail-section-heading { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-width: 0; }
.symptom-detail-section-heading > .symptom-detail-actions { flex: 0 0 auto; width: auto; }
.symptom-detail-section-heading .symptom-record-add { white-space: nowrap; }
.symptom-description-facts { display: grid; gap: 10px; margin: 0; min-width: 0; }
.symptom-description-facts > div { display: grid; gap: 3px; min-width: 0; }
.symptom-description-facts dt { color: var(--muted); font-size: 12px; line-height: 18px; }
.symptom-description-facts dd { min-width: 0; margin: 0; color: var(--ink); font-size: 14px; line-height: 1.7; overflow-wrap: anywhere; }
.is-standalone .symptom-history { margin: 0; border: 0; border-top: 1px solid var(--line); padding: 14px 0 0; min-width: 0; }
.is-standalone .symptom-history > summary { color: var(--ink); font-size: 16px; line-height: 24px; }
.is-standalone .symptom-history > summary::marker { color: var(--muted); font-size: 12px; }
.is-standalone .symptom-history > summary > h4 { display: inline; }
.symptom-history-count { color: var(--muted); font-size: 12px; font-weight: 400; }
.is-standalone .symptom-record { border-bottom-style: dashed; }
.is-standalone .symptom-record:last-of-type { border-bottom: 0; }
.is-standalone .symptom-record p { font-size: 14px; }
.is-standalone .symptom-record-heading > time { order: 5; margin-left: auto; }
.is-standalone > .process-symptom:first-of-type { border-top: 0; }
.process-symptoms > header { display: flex; align-items: center; gap: 12px; padding: 16px; }
.process-symptoms > header > div { flex: 1; min-width: 0; }
.process-symptoms h3 { margin: 0; font-size: 16px; }
.process-symptoms header p, .symptom-help { color: var(--muted); font-size: 12px; line-height: 1.6; }
.process-symptom { min-width: 0; padding: 16px; border-top: 1px solid var(--line); }
.symptom-heading { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
.symptom-current { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; min-width: 0; }
.symptom-current strong { font-size: 14px; line-height: 22px; overflow-wrap: anywhere; }
.symptom-current .chip { font-size: 12px; font-weight: 400; white-space: nowrap; }
.symptom-heading-actions { display: flex; flex: 0 0 auto; align-items: center; gap: 8px; }
.symptom-heading-actions .symptom-record-add { min-height: 32px; padding: 5px 12px; font-size: 14px; font-weight: 500; line-height: 20px; }
.symptom-edit, .symptom-history-toggle { border: 0; padding: 5px 2px; min-height: 32px; background: none; color: var(--brand-strong); font: inherit; font-size: 14px; cursor: pointer; }
.symptom-facts { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 10px 16px; margin: 12px 0; }
.symptom-facts > div { min-width: 0; }
.symptom-facts dt, .symptom-extra dt { color: var(--muted); font-size: 12px; line-height: 18px; }
.symptom-facts dd { margin: 2px 0 0; font-size: 14px; line-height: 21px; overflow-wrap: anywhere; }
.symptom-facts small { display: block; color: var(--muted); font-size: 12px; line-height: 18px; }
.symptom-description, .symptom-record p { margin: 8px 0 0; font-size: 14px; line-height: 1.6; color: var(--ink-2); white-space: pre-wrap; overflow-wrap: anywhere; }
.symptom-extra { display: grid; gap: 6px; margin: 10px 0 0; }
.symptom-extra > div { display: grid; grid-template-columns: 56px minmax(0,1fr); gap: 8px; align-items: baseline; }
.symptom-extra dd { margin: 0; font-size: 14px; line-height: 1.6; color: var(--ink-2); white-space: pre-wrap; overflow-wrap: anywhere; }
.symptom-history { margin-top: 16px; border-top: 1px solid var(--line); padding-top: 12px; }
.symptom-history h4 { margin: 0; font-size: 16px; line-height: 22px; font-weight: 500; }
.symptom-history h4 span { color: var(--muted); font-size: 12px; font-weight: 400; }
.symptom-empty { margin: 8px 0 0; color: var(--muted); font-size: 12px; line-height: 20px; }
.symptom-record { display: flex; justify-content: space-between; align-items: flex-start; gap: 8px; padding: 10px 0; border-bottom: 1px solid var(--line); }
.symptom-record-main { flex: 1; min-width: 0; }
.symptom-record-heading { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 8px; min-height: 28px; font-size: 12px; line-height: 18px; color: var(--muted); }
.symptom-record time { white-space: nowrap; }
.symptom-change-label { padding: 1px 6px; border-radius: 5px; background: var(--fill-1); color: var(--ink-2); }
.change-improved, .change-resolved { background: var(--brand-soft); color: var(--brand-strong); }
.change-worsened { background: var(--amber-soft); color: var(--amber); }
.symptom-record-severity { color: var(--ink-2); white-space: nowrap; }
.symptom-corrected { font-size: 12px; }
.symptom-record p { margin-top: 4px; }
.is-retracted { opacity: .6; }
.symptom-history-toggle { margin-top: 4px; font-size: 12px; }
.symptom-more { position: relative; flex: 0 0 auto; margin: 0; }
.symptom-more > summary { position: relative; list-style: none; display: grid; place-items: center; width: 28px; height: 28px; border-radius: 6px; color: var(--muted); cursor: pointer; }
.symptom-more > summary::-webkit-details-marker { display: none; }
.symptom-menu { position: absolute; top: calc(100% + 3px); right: 0; z-index: 3; display: grid; min-width: 100px; padding: 4px; border: 1px solid var(--line); border-radius: 8px; background: var(--surface); box-shadow: var(--shadow-s); }
.symptom-menu button { border: 0; border-radius: 5px; background: none; padding: 8px 12px; min-height: 36px; color: var(--ink-2); font: inherit; font-size: 14px; text-align: left; white-space: nowrap; cursor: pointer; }
.symptom-menu .is-danger { color: var(--danger); }
.symptom-more > summary:focus-visible, .process-symptom button:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; }
.symptom-sheet-backdrop { z-index: 140; display: flex; align-items: flex-end; justify-content: center; }
.symptom-sheet { width: min(100%,580px); max-height: 90dvh; background: var(--surface); color: var(--ink); border-radius: 18px 18px 0 0; }
.symptom-sheet > header { display: flex; justify-content: space-between; align-items: center; padding: 10px 14px; border-bottom: 1px solid var(--line); gap: 8px; }
.symptom-sheet h3 { margin: 0; font-size: 16px; }
.symptom-sheet header button { position: relative; display: grid; place-items: center; width: 28px; height: 28px; flex-shrink: 0; background: none; border: 0; border-radius: 8px; color: var(--ink); }
.symptom-sheet header button::after { content: ''; position: absolute; inset: -8px; }
.symptom-sheet fieldset { border: 0; margin: 0; padding: 14px; min-width: 0; gap: 12px; }
.symptom-field { display: grid; gap: 6px; color: var(--muted); font-size: 12px; }
.symptom-sheet textarea { width: 100%; background: var(--surface); color: var(--ink); border: 1px solid var(--line-strong); border-radius: 10px; padding: 9px 12px; font-size: 14px; line-height: 1.6; }
.symptom-sheet textarea:focus { outline: 0; border-color: var(--brand); box-shadow: 0 0 0 3px var(--brand-soft); }
.symptom-change { display: flex; flex-wrap: wrap; gap: 12px 6px; }
.symptom-change button { border: 1px solid var(--line-strong); border-radius: 8px; background: var(--surface); color: var(--ink); min-height: 32px; padding: 5px 10px; font-size: 14px; line-height: 20px; }
.symptom-change button[aria-pressed=true] { background: var(--brand-soft); border-color: var(--brand); color: var(--brand-strong); }
.symptom-help { margin: 0; }
.symptom-sheet details label { margin-top: 10px; display: grid; gap: 6px; }
.symptom-sheet :deep(.datetime-picker-trigger), .symptom-sheet :deep(.form-select-trigger) { width: 100%; }
.symptom-sheet .symptom-measurement-fields { grid-template-columns: minmax(0,1fr) minmax(72px,.45fr); gap: 10px; }
.symptom-sheet .record-form-actions { position: sticky; bottom: 0; margin-bottom: 0; background: var(--surface); }
@media (min-width:761px) and (pointer:fine) { .symptom-facts { grid-template-columns: repeat(4,minmax(0,1fr)); } }
@media (min-width: 981px) and (pointer: fine) {
  .is-standalone .symptom-facts { grid-template-columns: repeat(2, minmax(0, 1fr)); column-gap: 24px; }
  .symptom-description-facts { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px 16px; }
  .symptom-description-main { grid-column: 1 / -1; }
}
@media (hover:hover) { .symptom-menu button:hover, .symptom-more > summary:hover { background: var(--fill-2); } }
@media (max-width:760px), (pointer:coarse) {
  .is-standalone .symptom-detail-toolbar { gap: 8px; }
  .is-standalone .symptom-detail-section, .is-standalone .symptom-history { padding-top: 12px; }
  .symptom-toolbar-edit { position: relative; min-height: 28px; padding: 3px 8px; }
  .symptom-toolbar-edit::after { content: ''; position: absolute; inset: -8px 0; }
  .process-symptoms.is-standalone > .process-symptom { gap: 12px; padding: 4px var(--record-inset,14px) 12px; }
  .symptom-record-add, .symptom-edit, .symptom-history-toggle, .symptom-change button { position: relative; }
  .symptom-record-add::after, .symptom-edit::after, .symptom-history-toggle::after, .symptom-change button::after { content: ''; position: absolute; inset: -6px 0; }
  .symptom-more > summary::after { content: ''; position: absolute; inset: -8px; }
  .symptom-menu button { min-height: 44px; }
  .symptom-sheet { max-height: 94dvh; padding-bottom: env(safe-area-inset-bottom); }
}
</style>
