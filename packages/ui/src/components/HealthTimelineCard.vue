<script setup lang="ts">
import { computed } from 'vue';
import HealthCategoryIcon from './HealthCategoryIcon.vue';
import { RouterLink } from 'vue-router';
import { healthCategoryLabels, type HealthFeedEntry } from '../../../shared/health-categories';
import { healthRecordPath } from '../utils/health-record-navigation';
import { timelineDateParts } from '../utils/health-timeline';
import { formatMedicationDate } from '../utils/medication-date';
const props=defineProps<{entry:HealthFeedEntry;selected?:boolean;origin?:'overview';returnTo?:string;dateLabel?:string}>();
const emit=defineEmits<{activate:[entry:HealthFeedEntry,event:MouseEvent]}>();
const labels:Record<string,string>={checkup:'体检',laboratory:'检验',imaging:'影像检查',functional:'功能检查',pathology:'病理',outpatient:'门诊病历',inpatient:'住院资料',billing:'费用凭证',prescription:'用药单',vaccination:'接种',course:'用药记录',intake:'用药记录',symptom:'症状跟踪',other:'其他资料'};
const states:Record<string,string>={active:'进行中',resolved:'已缓解',unknown:'状态未知',paused:'已暂停',stopped:'已停用',queued:'排队中',uploading:'上传中',processing:'处理中',needs_review:'待确认',failed:'识别失败',ready:'已归档'};
const card=computed(()=>{
 const entry=props.entry;const details:string[]=[];const isVaccination=entry.kind==='vaccination';
 const dose=entry.doseNumber?.trim();const doseLabel=dose && /^\d+$/.test(dose)?`第 ${dose} 剂`:dose;
 if(entry.medicationCount)details.push(`${entry.medicationCount} 项药品`);
 if(entry.activeCount)details.push(`${entry.activeCount} 项正在使用`);
 else if(entry.kind==='medication_document')details.push(entry.confirmedCount?'已确认使用情况':'使用情况未确认');
 if(entry.intakeCount)details.push(`${entry.intakeCount} 次服用补充`);
 if(entry.processIds.length)details.push(`关联 ${entry.processIds.length} 个健康历程`);
 const state=isVaccination?'已接种':entry.category==='vaccination'&&['ready','needs_review'].includes(entry.status||'')?'待完善':entry.kind==='medication' && entry.status==='active'?'正在使用':states[entry.status||''];
 const subtypeLabels=[...new Set((entry.category==='report' && entry.documents.length ? entry.documents.map(doc=>doc.reportType) : [entry.subtype]).map(type=>labels[type]||type))];
 const meta=(isVaccination || ['symptom','imaging','vaccination'].includes(entry.category))?'':subtypeLabels.join(' · ');
 const tone=isVaccination?'chip--green':entry.status==='failed'?'chip--red':entry.status==='needs_review'||entry.category==='vaccination'&&entry.status==='ready'?'chip--amber':['processing','uploading','queued'].includes(entry.status||'')?'chip--info':['active','resolved','ready'].includes(entry.status||'')?'chip--green':'chip--plain';
 return {to:props.returnTo?{path:healthRecordPath(entry.kind,entry.resourceId),query:{...(props.origin?{from:props.origin}:{}),returnTo:props.returnTo}}:props.origin?{path:healthRecordPath(entry.kind,entry.resourceId),query:{from:props.origin}}:healthRecordPath(entry.kind,entry.resourceId),type:healthCategoryLabels[entry.category],title:entry.title,
 institution:entry.institution,meta,dose:isVaccination?doseLabel:null,summaryNote:isVaccination?entry.note:null,description:isVaccination?null:entry.description,details,
 status:state?{label:state,chip:tone}:null};
});
const date=computed(()=>{const value=timelineDateParts(props.entry.date);return {main:value?.day||(props.dateLabel?'待确认':'日期待确认'),details:value?.time?[value.time]:[],label:formatMedicationDate(props.entry.date)||(props.dateLabel?'待确认':'日期待确认')};});
const uploadTime=computed(()=>{
 const value=props.entry.uploadedAt;
 if(!props.dateLabel||!value||!Number.isFinite(Date.parse(value)))return null;
 const full=formatMedicationDate(value);
 const today=new Date();const yesterday=new Date(today);yesterday.setDate(today.getDate()-1);
 const day=full.slice(0,10);
 const relative=day===formatMedicationDate(today.toISOString()).slice(0,10)?'今天':day===formatMedicationDate(yesterday.toISOString()).slice(0,10)?'昨天':null;
 return {full,label:relative?`${relative} ${full.slice(11)}`:full};
});
</script>

<template>
  <RouterLink :to="card.to" class="health-timeline-card" :class="{ 'is-selected': selected }" :aria-current="selected ? 'true' : undefined" :data-kind="entry.kind" :data-category="entry.category" @click.capture="emit('activate', entry, $event)">
    <span class="health-timeline-icon" aria-hidden="true"><HealthCategoryIcon :category="entry.category" :size="40" /></span>
    <span class="health-timeline-copy">
      <span class="health-timeline-heading">
        <span class="health-timeline-type">{{ card.type }}</span>
        <span v-if="card.meta" class="health-timeline-meta" :title="card.meta">{{ card.meta }}</span>
        <span v-if="card.status || card.dose" class="health-timeline-labels">
          <span v-if="card.dose" class="chip chip--plain health-timeline-dose">{{card.dose}}</span>
          <span v-if="card.status" class="chip health-timeline-status" :class="card.status.chip">{{ card.status.label }}</span>
        </span>
        <span class="health-timeline-date" :aria-label="dateLabel ? `${dateLabel}：${date.label}` : date.label">
          <span class="health-timeline-date-main">{{ date.main }}</span>
          <small v-for="detail in date.details" :key="detail" class="health-timeline-date-detail">{{ detail }}</small>
        </span>
      </span>
      <strong class="health-timeline-title" :class="{'health-timeline-title--vaccination':entry.kind==='vaccination'}"><span class="health-timeline-title-text">{{ card.title }}</span></strong>
      <span v-if="entry.duplicateHint" class="health-timeline-duplicate"><span class="chip chip--amber" title="打开报告查看已有报告及匹配依据">{{entry.duplicateHint==='high'?'高度重复':'疑似重复'}}</span></span>
      <span v-if="card.institution || card.summaryNote" class="health-timeline-summary">
        <span v-if="card.institution" class="health-timeline-institution">{{ card.institution }}</span>
        <span v-if="card.summaryNote" class="health-timeline-note">{{card.summaryNote}}</span>
      </span>
      <span v-if="card.description" class="health-timeline-description">{{ card.description }}</span>
      <span v-if="card.details.length" class="health-timeline-footer">
        <span class="health-timeline-details">{{ card.details.join(' · ') }}</span>
      </span>
      <time v-if="uploadTime" class="health-timeline-upload-time" :datetime="entry.uploadedAt || undefined" :title="uploadTime.full">上传时间：{{ uploadTime.label }}</time>
    </span>
  </RouterLink>
</template>

<style scoped>
.health-timeline-card {
  --timeline-type: var(--brand-strong);

  --timeline-gap: 10px;
  position: relative;
  display: grid;
  grid-template-columns: 40px minmax(0, 1fr);
  align-items: start;
  gap: var(--timeline-gap);
  min-width: 0;
  padding: 12px 14px;
  border: 1px solid var(--line);
  border-radius: var(--radius-m);
  color: var(--ink);
  background: var(--surface);
  text-align: left;
  transition: background-color .15s ease, border-color .15s ease, box-shadow .15s ease;
}
@media (hover: hover) {
  .health-timeline-card:hover { background: var(--fill-2); border-color: var(--line-strong); }
}
.health-timeline-card.is-selected { background: var(--brand-softer); border-color: var(--brand); box-shadow: inset 3px 0 0 var(--brand); }
.health-timeline-card:active { background: var(--brand-soft); border-color: var(--brand); }
.health-timeline-card:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; }
@media (prefers-reduced-motion: reduce) { .health-timeline-card { transition: none; } }
.health-timeline-card[data-category="symptom"] { --timeline-type: var(--amber); }
.health-timeline-card:is([data-category="report"], [data-category="imaging"]) { --timeline-type: var(--info); }
.health-timeline-card[data-category="medication"] { --timeline-type: color-mix(in srgb, var(--info) 68%, var(--danger)); }
.health-timeline-card[data-category="vaccination"] { --timeline-type: var(--brand-strong); }
.health-timeline-heading { display: flex; align-items: center; justify-content: flex-start; flex-wrap: nowrap; gap: 8px; }
.health-timeline-heading .health-timeline-labels { flex-wrap: nowrap; flex-shrink: 0; }
.health-timeline-card[data-kind="vaccination"] .health-timeline-heading { align-items: flex-start; }
.health-timeline-card[data-kind="vaccination"] .health-timeline-labels { flex-shrink: 1; flex-wrap: wrap; gap: 4px; }
.health-timeline-date { margin-left: auto; margin-right: calc(0px - var(--timeline-gap)); display: flex; flex-shrink: 0; flex-wrap: nowrap; justify-content: flex-end; gap: 4px; min-width: 0; max-width: 100%; color: var(--ink-2); font-variant-numeric: tabular-nums; }
.health-timeline-date-main { color: var(--muted); font-size: 12px; line-height: 18px; }
.health-timeline-date-detail { color: var(--muted); font-size: 12px; line-height: 18px; overflow-wrap: anywhere; }
.health-timeline-upload-time { color:var(--ink-2);font-size:12px;line-height:18px; }
.health-timeline-icon { position: relative; display: grid; place-items: center; width: 40px; height: 40px; pointer-events: none; user-select: none; }
.health-timeline-icon :deep(.health-category-icon) { width: 100%; height: 100%; }
.health-timeline-copy { display: grid; gap: 4px; min-width: 0; font-weight: 400; letter-spacing: 0; }
.health-timeline-type { flex-shrink: 0; font-size: 12px; line-height: 18px; font-weight: 500; color: var(--timeline-type); }
.health-timeline-title {
  font-size: 14px;
  font-weight: 500;
  overflow-wrap: anywhere;
  line-height: 22px;
}
.health-timeline-title--vaccination .health-timeline-title-text { display: block; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.health-timeline-dose { min-width: 0; max-width: 100%; white-space: normal; overflow-wrap: anywhere; color: var(--ink-2); }
.health-timeline-note { color: var(--muted); font-size: 12px; }
.health-timeline-institution + .health-timeline-note::before { content: " · "; }
.health-timeline-summary { display: block; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; line-height: 20px; }
.health-timeline-institution { color: var(--ink-2); font-size: 12px; font-weight: 400; line-height: 20px; min-width: 0; }
.health-timeline-meta { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); font-size: 12px; line-height: 18px; }
.health-timeline-description {
  color: var(--ink-2);
  font-size: 12px;
  line-height: 20px;
  overflow-wrap: anywhere;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
}
.health-timeline-card[data-category="medication"] .health-timeline-description { font-size: 12px; }
.health-timeline-labels, .health-timeline-footer { display: flex; align-items: center; justify-content: flex-start; flex-wrap: wrap; gap: 4px 8px; min-width: 0; }
.health-timeline-details { color: var(--muted); font-size: 12px; line-height: 18px; overflow-wrap: anywhere; }
.health-timeline-status, .health-timeline-dose { flex-shrink: 0; font-size: 12px; font-weight: 400; padding: 0 6px; border-radius: 5px; line-height: 18px; }
@media (max-width: 760px), (pointer: coarse) {
  .health-timeline-card { --timeline-gap: 6px; isolation: isolate; overflow: hidden; padding: 8px 10px 10px 8px; grid-template-columns: minmax(0, 1fr); }
  .health-timeline-icon { position: absolute; right: -6px; bottom: -6px; z-index: -1; width: 48px; height: 48px; opacity: .2; }
}
</style>
