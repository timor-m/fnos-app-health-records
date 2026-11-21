<script setup lang="ts">
import { computed, onActivated, onDeactivated, onBeforeUnmount, ref, watch } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';
import { BellRing } from '@lucide/vue';
import HealthCategoryIcon from '../components/HealthCategoryIcon.vue';
import EmptyState from '../components/EmptyState.vue';
import PullIndicator from '../components/PullIndicator.vue';
import HealthTimelineCard from '../components/HealthTimelineCard.vue';
import HealthProcessCard from '../components/HealthProcessCard.vue';
import HealthRecordDetailModal from '../components/HealthRecordDetailModal.vue';
import { useAppContext } from '../composables/useAppContext';
import { usePullRefresh } from '../composables/usePullRefresh';
import { useRefreshOnActivate } from '../composables/useRefreshOnActivate';
import { useTouchRecordDetail } from '../composables/useTouchRecordDetail';
import { useToast } from '../composables/useToast';
import { vaccinationReturnTo } from '../utils/vaccination';
import { request } from '../utils/api';
import { createUuid } from '../utils/uuid';
import { healthRecordPath, isHealthRecordKind } from '../utils/health-record-navigation';
import { healthCategoryLabels, type HealthFeedEntry } from '../../../shared/health-categories';
import { healthCategoryOrder, isHealthCategoryDisabled } from '../utils/health-record-presentation';
import type { HealthOverview, OverviewReminder } from '../../../shared/health-overview';
const app=useAppContext();const route=useRoute();const router=useRouter();const toast=useToast();const touch=useTouchRecordDetail();
const root=ref<HTMLElement|null>(null);const overview=ref<HealthOverview|null>(null);const loading=ref(false);const error=ref('');const active=ref(true);
let sequence=0;let owned:{token:string;memberId:string}|null=null;
const dialogMember=ref(app.selectedMemberId.value);
const text=(key:string)=>typeof route.query[key]==='string'?route.query[key] as string:'';
const dialog=computed(()=>{const kind=text('recordKind'),id=text('recordId');return isHealthRecordKind(kind)&&id.trim()&&id.length<=200?{kind,recordId:id}:null;});
const recordOpen=computed(()=>active.value&&route.path==='/overview'&&touch.value&&!!dialog.value&&dialogMember.value===app.selectedMemberId.value);
const canManage=computed(()=>app.selectedMember.value?.permission==='manager');
const focusItems=computed(()=>overview.value?[...overview.value.attention.symptoms,...overview.value.attention.medications]:[]);
const hasAttention=computed(()=>!!overview.value&&(overview.value.attention.symptomCount+overview.value.attention.medicationCount)>0);
const hasPendingDocuments=computed(()=>!!overview.value&&(overview.value.pending.reviewCount+overview.value.pending.processingCount+overview.value.pending.failedCount)>0);
const processingFilters=[{status:'needs_review',key:'reviewCount',label:'待确认'},{status:'processing',key:'processingCount',label:'处理中'},{status:'failed',key:'failedCount',label:'识别失败'}] as const;
watch([overview,active,()=>route.path,app.selectedMemberId],()=>{
 const value=overview.value;
 if(active.value&&route.path==='/overview'&&value?.memberId===app.selectedMemberId.value)app.setTopbarSubtitle('overview',`共 ${value.recordCount} 条记录`);
 else app.clearTopbarSubtitle('overview');
},{immediate:true,flush:'sync'});
async function load(){
 const member=app.selectedMemberId.value;if(!active.value||route.path!=='/overview'||!member)return false;
 const current=++sequence;loading.value=true;error.value='';
 const valid=()=>current===sequence&&active.value&&route.path==='/overview'&&member===app.selectedMemberId.value;
 try{const next=await request<HealthOverview>(`overview?memberId=${encodeURIComponent(member)}`);if(!valid())return false;
  const items=[...next.recentRecords,...next.pending.documents,...next.attention.symptoms,...next.attention.medications];
  if(next.memberId!==member||items.some(item=>item.memberId!==member)||next.pending.reminders.some(item=>item.memberId!==member))throw Error('概览与当前成员不一致');
  overview.value=next;void app.refreshReminderCount(member);return true;
 }catch(cause){if(valid())error.value=cause instanceof Error?cause.message:'概览加载失败';return false;}
 finally{if(current===sequence)loading.value=false;}
}
function closeRecord(){if(!recordOpen.value)return;const owner=owned;owned=null;
 if(owner?.memberId===app.selectedMemberId.value&&router.options.history.state.healthOverviewEntry===owner.token){router.back();return;}
 if(route.query.returnTo){void router.replace(vaccinationReturnTo(route.query.returnTo,'/overview'));return;}
 const query={...route.query};delete query.recordKind;delete query.recordId;void router.replace({path:'/overview',query});
}
function activateRecord(entry:HealthFeedEntry,event:MouseEvent){
 if(!touch.value||event.defaultPrevented||event.button!==0||event.ctrlKey||event.metaKey||event.shiftKey||event.altKey)return;
 event.preventDefault();if(entry.memberId!==app.selectedMemberId.value)return;
 const token=createUuid();owned={token,memberId:entry.memberId};void router.push({path:'/overview',query:{...route.query,recordKind:entry.kind,recordId:entry.resourceId},state:{healthOverviewEntry:token}});
}
function openReport(id:string){if(!id)return;if(touch.value){void router.replace({path:'/overview',query:{...route.query,recordKind:'report',recordId:id}});}else void router.push({path:healthRecordPath('report',id),query:{from:'overview'}});}
function reminderLink(item:OverviewReminder){return item.vaccinationId&&canManage.value?{path:'/add/vaccination',query:{sourceVaccinationId:item.vaccinationId,reminderId:item.id,memberId:app.selectedMemberId.value,relatedKind:'vaccination',relatedId:item.vaccinationId,returnTo:route.fullPath||route.path}}:{path:'/reminders'};}
watch(()=>JSON.stringify([route.path,dialog.value]),()=>{dialogMember.value=route.path==='/overview'?app.selectedMemberId.value:'';if(!dialog.value)owned=null;},{immediate:true,flush:'sync'});
watch([dialog,touch,active],()=>{if(dialog.value&&!touch.value&&active.value&&route.path==='/overview'&&dialogMember.value===app.selectedMemberId.value)void router.replace({path:healthRecordPath(dialog.value.kind,dialog.value.recordId),query:{...route.query,from:'overview',recordKind:undefined,recordId:undefined}});},{immediate:true});
watch(app.selectedMemberId,(next,previous)=>{sequence++;overview.value=null;error.value='';loading.value=false;owned=null;
 if(previous&&next!==previous){dialogMember.value='';if(route.path==='/overview'&&dialog.value){const query={...route.query};delete query.recordKind;delete query.recordId;void router.replace({path:'/overview',query});}}
 void load();},{immediate:true,flush:'sync'});
onActivated(()=>{active.value=true;});onDeactivated(()=>{active.value=false;sequence++;});onBeforeUnmount(()=>{active.value=false;sequence++;});
useRefreshOnActivate(load);
const {pullDistance,refreshing}=usePullRefresh(root,async()=>{if(recordOpen.value)return;const member=app.selectedMemberId.value;const success=await load();if(active.value&&route.path==='/overview'&&member===app.selectedMemberId.value)toast.show(success?'概览已刷新':'刷新失败，请稍后重试');});
</script>

<template>
 <section ref="root" class="plain-page overview-page">
  <PullIndicator v-if="pullDistance>0||refreshing" :distance="pullDistance" :refreshing="refreshing"/>
  <p v-if="error" class="inline-panel-error" role="alert">{{error}}<button class="error-retry" type="button" @click="load">重试</button></p>
  <div v-if="loading&&!overview" class="overview-skeleton" role="status" aria-label="正在加载概览" aria-busy="true">
   <div class="overview-types" aria-hidden="true">
    <div v-for="category in healthCategoryOrder" :key="category" class="overview-type overview-skeleton-type" :class="{'is-disabled':isHealthCategoryDisabled(category)}">
     <span class="skeleton-block overview-type-image"/><span class="skeleton-block overview-type-label"/><span class="skeleton-block overview-type-count"/>
    </div>
   </div>
   <section class="settings-band overview-panel" aria-hidden="true">
    <header><span class="skeleton-block skeleton-section-title"/></header>
    <div class="overview-panel-body">
     <div class="overview-processing overview-skeleton-processing"><div v-for="index in 3" :key="index"><span class="skeleton-block skeleton-stat-label"/><span class="skeleton-block skeleton-stat-value"/></div></div>
     <div class="overview-pending-list overview-skeleton-records"><div v-for="index in 2" :key="index" class="overview-skeleton-record"><span class="skeleton-block skeleton-record-icon"/><div class="skeleton-record-content"><span class="skeleton-block skeleton-record-meta"/><span class="skeleton-block skeleton-record-title"/><span class="skeleton-block skeleton-record-description"/></div></div></div>
    </div>
   </section>
   <section class="settings-band overview-panel" aria-hidden="true">
    <header><span class="skeleton-block skeleton-section-title"/><span class="skeleton-block skeleton-section-action"/></header>
    <div class="overview-panel-body"><div class="overview-skeleton-process"><span class="skeleton-block skeleton-process-icon"/><div class="skeleton-record-content"><span class="skeleton-block skeleton-record-title"/><span class="skeleton-block skeleton-record-meta"/><span class="skeleton-block skeleton-record-description"/></div><span class="skeleton-block skeleton-process-open"/></div></div>
   </section>
   <section class="settings-band overview-panel" aria-hidden="true">
    <header><span class="skeleton-block skeleton-section-title"/><span class="skeleton-block skeleton-section-action"/></header>
    <div class="overview-panel-body"><div v-for="index in 2" :key="index" class="overview-skeleton-record"><span class="skeleton-block skeleton-record-icon"/><div class="skeleton-record-content"><span class="skeleton-block skeleton-record-meta"/><span class="skeleton-block skeleton-record-title"/><span class="skeleton-block skeleton-record-description"/></div></div></div>
   </section>
  </div>
  <template v-if="overview">
   <nav class="overview-types" aria-label="健康记录分类">
    <component :is="isHealthCategoryDisabled(category)?'button':RouterLink" v-for="category in healthCategoryOrder" :key="category" class="overview-type" :to="isHealthCategoryDisabled(category)?undefined:{path:'/events',query:{category}}" :type="isHealthCategoryDisabled(category)?'button':undefined" :disabled="isHealthCategoryDisabled(category)||undefined" :aria-label="isHealthCategoryDisabled(category)?'影像，暂未开放':undefined" :title="isHealthCategoryDisabled(category)?'影像暂未开放':undefined" :data-category="category">
     <HealthCategoryIcon class="overview-type-image" :category="category" :size="40"/>
     <span class="overview-type-label">{{healthCategoryLabels[category]}}</span>
     <strong class="overview-type-count" :class="{'is-long-count':overview.categoryCounts[category]>=10000}">{{isHealthCategoryDisabled(category)?'—':overview.categoryCounts[category]}}</strong>
    </component>
   </nav>
   <div v-if="hasPendingDocuments||overview.pending.reminderCount" class="overview-columns">
    <section v-if="hasPendingDocuments" class="settings-band overview-panel"><header><h3>资料处理</h3></header><div class="overview-panel-body"><div class="overview-processing"><RouterLink v-for="filter in processingFilters" :key="filter.status" :to="{path:'/events',query:{status:filter.status}}" :data-status="filter.status"><span>{{filter.label}}</span><strong>{{overview.pending[filter.key]}}<small> 份</small></strong></RouterLink></div><div class="overview-pending-list"><HealthTimelineCard v-for="entry in overview.pending.documents" :key="entry.id" :entry="entry" date-label="报告日期" :return-to="entry.category==='vaccination'?route.fullPath:undefined" origin="overview" @activate="activateRecord"/></div><p v-if="!overview.pending.documents.length" class="overview-empty">暂无需要处理的资料</p></div></section>
    <section v-if="overview.pending.reminderCount" class="settings-band overview-panel"><header><div><BellRing :size="17"/><h3>近期提醒 <span>{{overview.pending.reminderCount}}</span></h3></div><RouterLink to="/reminders">全部提醒</RouterLink></header><div class="overview-panel-body overview-reminders-list"><article v-for="item in overview.pending.reminders" :key="item.id" class="overview-reminder"><div class="overview-reminder-copy"><strong>{{item.title}}</strong><span><time :datetime="item.dueAt">{{item.dueAt}}</time> · {{item.vaccinationId?'下一剂接种':item.reportTitle?'来源：'+item.reportTitle:'健康待办'}}</span></div><RouterLink :to="reminderLink(item)">{{item.vaccinationId&&canManage?'填写下一剂':'查看提醒'}}</RouterLink></article><p v-if="!overview.pending.reminders.length" class="overview-empty">暂无待处理提醒</p></div></section>
   </div>
   <section v-if="overview.processes?.length" class="settings-band overview-panel overview-processes"><header><h3>健康历程</h3><RouterLink to="/health-processes">查看全部历程</RouterLink></header><div class="overview-panel-body"><HealthProcessCard v-for="process in overview.processes" :key="process.id" :process="process" :return-to="route.fullPath"/></div></section>
   <section v-if="hasAttention" class="settings-band overview-panel overview-attention">
    <header><h3>当前关注</h3></header>
    <div class="overview-panel-body">
     <div class="overview-focus-counts">
      <RouterLink v-if="overview.attention.symptomCount" :to="{path:'/events',query:{category:'symptom',status:'active'}}">持续跟踪的症状 <strong>{{overview.attention.symptomCount}}</strong> 项</RouterLink>
      <RouterLink v-if="overview.attention.medicationCount" :to="{path:'/events',query:{category:'medication',subtype:'record',status:'active'}}">正在使用的药物 <strong>{{overview.attention.medicationCount}}</strong> 项</RouterLink>
     </div>
     <div v-if="focusItems.length" class="overview-focus-list" :class="{'single-item':focusItems.length===1}"><HealthTimelineCard v-for="entry in focusItems" :key="entry.id" :entry="entry" :return-to="entry.category==='vaccination'?route.fullPath:undefined" origin="overview" @activate="activateRecord"/></div>
    </div>
   </section>
   <section v-if="overview.recentRecords.length" class="settings-band overview-panel overview-recent-uploads"><header><h3>最近上传</h3><RouterLink to="/events">全部记录</RouterLink></header><div class="overview-panel-body"><HealthTimelineCard v-for="entry in overview.recentRecords" :key="entry.id" :entry="entry" date-label="报告日期" :return-to="entry.category==='vaccination'?route.fullPath:undefined" origin="overview" @activate="activateRecord"/></div></section>
   <EmptyState v-if="!overview.recordCount" title="还没有健康记录" :description="canManage?'上传资料，或从新增菜单填写症状、测量、用药和接种。':'当前成员暂无健康记录。'"><RouterLink v-if="canManage" class="primary-button" to="/upload">上传资料</RouterLink></EmptyState>
  </template>
  <HealthRecordDetailModal v-if="recordOpen&&dialog" :key="`${app.selectedMemberId.value}:${dialog.kind}:${dialog.recordId}`" :open="true" v-bind="dialog" @close="closeRecord" @updated="load" @open-report="openReport"/>
 </section>
</template>

<style scoped>

.overview-page { gap:16px; min-width:0; width:100%; align-content:start; }
.overview-types {
  --overview-type-gap: 10px;
  display: flex;
  align-items: stretch;
  gap: var(--overview-type-gap);
  min-width: 0;
  overflow: hidden;
  container-type: inline-size;
}
.overview-types .overview-type {
  flex: 1 1 0;
  width: auto;
  min-width: 0;
  min-height: 104px;
  display: grid;
  grid-template-areas: "icon label" "icon count";
  grid-template-columns: 40px minmax(0, 1fr);
  grid-template-rows: 20px auto;
  justify-content: center;
  align-items: center;
  align-content: center;
  gap: 2px 12px;
  padding: 12px 6px;
  border: 1px solid var(--line);
  border-radius: var(--radius-m);
  background: var(--surface);
  box-sizing: border-box;
}
.overview-types button:disabled { opacity: .45; cursor: not-allowed; font: inherit; text-align: inherit; }
.overview-type-image { grid-area:icon; width:40px; height:40px; object-fit:contain; }
.overview-type-label { grid-area:label; color:var(--ink-2); font-size:12px; line-height:20px; white-space:nowrap; }
@container (max-width: 700px) {
  .overview-types .overview-type {
    grid-template-areas: "icon" "label" "count";
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: 40px 20px auto;
    justify-items: center;
    gap: 2px;
    min-height: 96px;
    padding: 10px 4px;
  }
  .overview-type-count { text-align: center; }
}
.overview-type-count { grid-area:count; min-width:0; max-width:100%; color:var(--ink); font-size:22px; line-height:26px; font-weight:600; font-variant-numeric:tabular-nums; overflow-wrap:anywhere; }
.overview-columns { display:grid; align-items:start; grid-template-columns:minmax(0,1fr); gap:16px; min-width:0; }
.overview-panel { min-width:0; overflow:hidden; border:1px solid var(--line); box-shadow:none; }
.overview-panel > header { min-height:48px; display:flex; align-items:center; justify-content:space-between; gap:10px; padding:7px 14px; }
.overview-panel > header > div { display:flex; align-items:center; gap:7px; color:var(--brand-strong); }
.overview-panel h3 { font-size:16px; line-height:22px; font-weight:600; color:var(--ink); }
.overview-panel h3 span { margin-left:4px; color:var(--muted); font-size:12px; font-weight:400; }
.overview-panel > header > a { display:inline-flex; align-items:center; justify-content:center; min-height:32px; flex-shrink:0; padding:4px 6px; margin-right:-6px; border-radius:6px; background:transparent; color:var(--brand-strong); font-size:12px; font-weight:500; }
.overview-panel-body { padding:12px; display:grid; gap:8px; min-width:0; }
.overview-pending-list { display:grid; gap:8px; }.overview-pending-list :deep(.health-timeline-footer) { display:none; }.overview-pending-list :deep(.health-timeline-card) { padding:10px; }.overview-pending-list :deep(.health-timeline-meta) { display:none; }
.overview-processing { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:8px; }
.overview-processing a { display:grid; gap:4px; min-width:0; padding:10px 8px; border-radius:8px; background:var(--fill-2); }
.overview-processing span { color:var(--muted); font-size:12px; }.overview-processing strong { color:var(--ink); font-size:17px; font-weight:500; }.overview-processing small { color:var(--muted); font-size:12px; font-weight:400; }
.overview-focus-counts { display:flex; flex-wrap:wrap; gap:4px 12px; font-size:14px; color:var(--ink-2); }.overview-focus-counts a { display:inline-flex; align-items:center; gap:4px; min-height:32px; padding:4px 8px; border-radius:6px; background:var(--fill-2); }.overview-focus-counts strong { color:var(--brand-strong); }
.overview-focus-list { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px; }
.overview-focus-list.single-item { grid-template-columns:minmax(0,1fr); }
.overview-reminder { padding:10px 12px; border:1px solid var(--line); border-radius:var(--radius-m); background:var(--fill-2); display:flex; align-items:center; gap:12px; min-width:0; }
.overview-reminder-copy { display:grid; flex:1; gap:4px; min-width:0; }
.overview-reminder time { white-space:nowrap; }
.overview-reminder strong { font-size:14px; font-weight:500; line-height:22px; overflow-wrap:anywhere; }.overview-reminder span { color:var(--muted); font-size:12px; line-height:19px; overflow-wrap:anywhere; }.overview-reminder a { flex-shrink:0; align-self:center; white-space:nowrap; display:inline-flex; align-items:center; min-height:32px; color:var(--brand-strong); font-size:12px; padding:4px 6px; margin-left:0; border-radius:6px; }
.overview-empty { padding:12px 2px; margin:0; color:var(--muted); font-size:12px; line-height:21px; }
.overview-page a:focus-visible { outline:2px solid var(--brand); outline-offset:-2px; }
.overview-types a:active,.overview-processing a:active,.overview-focus-counts a:active { background:var(--brand-soft); }
.overview-skeleton { display:grid; gap:inherit; min-width:0; }
.skeleton-block { display:block; min-width:0; height:12px; border-radius:4px; background:linear-gradient(90deg,var(--skeleton-a) 25%,var(--skeleton-b) 50%,var(--skeleton-a) 75%); background-size:200% 100%; animation:shimmer 1.2s linear infinite; }
.overview-skeleton-type.is-disabled { opacity:.45; }
.overview-skeleton-type .overview-type-image { height:40px; border-radius:8px; }
.overview-skeleton-type .overview-type-label { width:28px; height:12px; }
.overview-skeleton-type .overview-type-count { width:30px; height:20px; }
.skeleton-section-title { width:64px; height:14px; }
.skeleton-section-action { width:68px; height:10px; margin-left:auto; }
.overview-skeleton-processing > div { display:grid; gap:4px; min-width:0; padding:10px 8px; border-radius:8px; background:var(--fill-2); }
.skeleton-stat-label { width:42px; max-width:100%; height:12px; margin:3px 0; }
.skeleton-stat-value { width:26px; height:18px; margin:2px 0; }
.overview-skeleton-record { position:relative; display:flex; align-items:flex-start; gap:10px; min-width:0; min-height:92px; padding:12px; border:1px solid var(--line); border-radius:var(--radius-m); overflow:hidden; }
.skeleton-record-icon { flex:0 0 40px; width:40px; height:40px; border-radius:8px; }
.skeleton-record-content { display:grid; gap:9px; flex:1; min-width:0; }
.skeleton-record-meta { width:40%; max-width:120px; height:10px; }
.skeleton-record-title { width:85%; height:14px; }
.skeleton-record-description { width:65%; height:10px; }
.overview-skeleton-process { display:flex; align-items:flex-start; gap:10px; padding:12px 0; min-width:0; }
.skeleton-process-icon { width:20px; height:20px; flex:0 0 20px; }
.skeleton-process-open { width:12px; height:12px; flex:0 0 12px; align-self:center; }
@media(hover:hover) { .overview-types a:hover { background:var(--brand-softer); border-color:var(--line-strong); }.overview-processing a:hover,.overview-focus-counts a:hover,.overview-panel > header > a:hover,.overview-reminder a:hover { background:var(--brand-soft); } }
@media(min-width:981px) { .overview-pending-list,.overview-reminders-list { grid-template-columns:repeat(2,minmax(0,1fr)); }.overview-pending-list > :only-child,.overview-reminders-list > :only-child { grid-column:1 / -1; }.overview-processing a,.overview-skeleton-processing > div { display:flex; align-items:center; justify-content:space-between; gap:8px; min-height:44px; padding:8px 10px; } }
@media(max-width:980px) { .overview-focus-list { grid-template-columns:minmax(0,1fr); } }
@media(max-width:760px) {
 .overview-page { gap:12px; }
 .overview-panel > header { min-height:52px; padding:3px 12px; }.overview-panel-body { padding:10px; }
 .overview-focus-counts { gap:6px; }.overview-focus-counts a { flex-wrap:wrap; }
}
@media(max-width:760px), (pointer:coarse) {
 .overview-pending-list,.overview-reminders-list { grid-template-columns:minmax(0,1fr); }
 .overview-skeleton-type .overview-type-image { width:26px; height:26px; }
 .overview-skeleton-type .overview-type-label { width:24px; height:10px; }
 .overview-skeleton-type .overview-type-count { width:20px; height:16px; }
 .overview-skeleton-processing > div { min-height:44px; padding:4px 8px; gap:0; }
 .skeleton-stat-label { margin:2px 0; }
 .skeleton-stat-value { height:16px; margin:2px 0; }
 .overview-skeleton-record { min-height:86px; padding:10px; }
 .overview-skeleton-record .skeleton-record-icon { position:absolute; right:-3px; bottom:-3px; width:38px; height:38px; opacity:.6; }
 .overview-processing { gap:6px; }
 .overview-processing a,.overview-skeleton-processing > div { display:grid; }
 .overview-processing a { min-height:44px; padding:4px 8px; gap:0; }
 .overview-processing span { line-height:16px; }
 .overview-processing strong { font-size:16px; line-height:20px; }
 .overview-types {
   --overview-type-gap: 6px;
   margin-inline: calc(-1 * var(--page-content-inset, 8px));
   padding-inline: var(--page-content-inset, 8px);
   overflow-x: auto;
   overflow-y: hidden;
   overscroll-behavior-x: contain;
   touch-action: pan-x pinch-zoom;
   scrollbar-width: none;
 }
 .overview-types::-webkit-scrollbar { display: none; }
 .overview-types .overview-type {
   flex: 0 0 calc((100% - (4 * var(--overview-type-gap))) / 5);
   width: calc((100% - (4 * var(--overview-type-gap))) / 5);
   min-width: calc((100% - (4 * var(--overview-type-gap))) / 5);
   grid-template-areas: "icon" "label" "count";
   grid-template-columns: minmax(0, 1fr);
   grid-template-rows: 26px 14px minmax(20px, auto);
   justify-items: center;
   gap: 1px;
   min-height: 70px;
   padding: 3px;
 }
 .overview-type-image { width:26px; height:26px; }
 .overview-type-label { font-size:12px; line-height:14px; white-space:nowrap; }
 .overview-type-count { font-size:16px; line-height:20px; text-align:center; }
 .overview-type-count.is-long-count { font-size:14px; }
 .overview-panel > header { min-height:52px; padding-block:3px; }
 .overview-panel > header > a,.overview-reminder a,.overview-focus-counts a { min-height:44px; }
 .overview-panel > header > a { padding-inline:8px; margin-right:-8px; }
}
@media(prefers-reduced-motion:reduce) { .overview-skeleton .skeleton-block { animation:none; } }
</style>
