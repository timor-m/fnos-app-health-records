<script setup lang="ts">
import { computed, onActivated, onDeactivated, onBeforeUnmount, ref, watch } from 'vue';
import { Search, RefreshCw } from '@lucide/vue';
import { useRoute, useRouter } from 'vue-router';
import { healthCategoryOrder, isHealthCategoryDisabled } from '../utils/health-record-presentation';
import { healthCategoryLabels, healthSubtypeOptions, type HealthCategory, type HealthFeedEntry, type HealthFeedPage } from '../../../shared/health-categories';
import HealthCategoryIcon from '../components/HealthCategoryIcon.vue';
import HealthTimelineCard from '../components/HealthTimelineCard.vue';
import HealthRecordDetailModal from '../components/HealthRecordDetailModal.vue';
import MedicationRecordModal from '../components/MedicationRecordModal.vue';
import PullIndicator from '../components/PullIndicator.vue';
import EmptyState from '../components/EmptyState.vue';
import { useAppContext } from '../composables/useAppContext';
import { useTouchRecordDetail } from '../composables/useTouchRecordDetail';
import { usePullRefresh } from '../composables/usePullRefresh';
import { useRefreshOnActivate } from '../composables/useRefreshOnActivate';
import { vaccinationReturnTo } from '../utils/vaccination';
import { request } from '../utils/api';
import { createUuid } from '../utils/uuid';
import { healthRecordPath, isHealthRecordKind } from '../utils/health-record-navigation';
import { groupHealthTimeline } from '../utils/health-timeline';
import { healthRecordFilters, healthRecordStatusLabels as statusLabels } from '../utils/health-record-filters';
const app=useAppContext();const route=useRoute();const router=useRouter();
const active=ref(true);const root=ref<HTMLElement|null>(null);const sentinel=ref<HTMLElement|null>(null);
const entries=ref<HealthFeedEntry[]>([]);const category=ref<HealthCategory|''>('');const subtype=ref('');const status=ref('');const search=ref('');
const loading=ref(false);const loadingMore=ref(false);const loaded=ref(false);const error=ref('');const moreError=ref('');const cursor=ref<string|null>(null);
let sequence=0;let timer:ReturnType<typeof setTimeout>|undefined;let applied='';let loadedScope='';let observer:IntersectionObserver|null=null;
const text=(key:string)=>typeof route.query[key]==='string'?route.query[key] as string:undefined;
const dialogMember=ref(app.selectedMemberId.value);
const dialog=computed(()=>{const kind=text('recordKind');const id=text('recordId');return isHealthRecordKind(kind)&&id?.trim()&&id.length<=200?{kind,recordId:id}:null;});
const recordOpen=computed(()=>active.value&&route.path==='/events'&&touch.value&&Boolean(dialog.value)&&dialogMember.value===app.selectedMemberId.value);
const initialRelatedRecords=computed(()=>text('memberId')&&text('memberId')!==app.selectedMemberId.value?[]:isHealthRecordKind(text('relatedKind'))&&text('relatedId')?[{kind:text('relatedKind') as HealthFeedEntry['kind'],id:text('relatedId')!}]:[]);
const medicationOpen=computed(()=>active.value&&route.path==='/events'&&text('add')==='medication'&&(!(text('processId')||text('relatedId'))||!text('memberId')||text('memberId')===app.selectedMemberId.value)&&!dialog.value&&Boolean(app.selectedMemberId.value));
const touch=useTouchRecordDetail();let owned:{token:string;memberId:string}|null=null;
const subtypeOptions=computed(()=>category.value?healthSubtypeOptions[category.value]:[]);
const groups=computed(()=>groupHealthTimeline(entries.value));
function query(cursorValue?:string){const params=new URLSearchParams({memberId:app.selectedMemberId.value,timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone});if(category.value)params.set('category',category.value);if(subtype.value)params.set('subtype',subtype.value);if(status.value)params.set('status',status.value);if(search.value.trim())params.set('q',search.value.trim());if(cursorValue)params.set('cursor',cursorValue);return params;}
const criteria=()=>JSON.stringify([app.selectedMemberId.value,category.value,subtype.value,status.value,search.value.trim()]);
function writeFilters(){const next={...route.query};for(const [key,value] of [['category',category.value],['subtype',subtype.value],['status',status.value],['q',search.value.trim()]]){if(value)next[key]=value;else delete next[key];}if(JSON.stringify(next)!==JSON.stringify(route.query))void router.replace({path:'/events',query:next});}
function validatePage(page:HealthFeedPage,member:string){
 if(!page||!Array.isArray(page.items))throw Error('记录数据无效，请刷新重试');
 if(page.items.some(item=>item.memberId!==member))throw Error('记录与当前成员不一致');
}
async function load(){
 if(!active.value||route.path!=='/events'||!app.selectedMemberId.value)return;
 const current=++sequence;const member=app.selectedMemberId.value;const scope=criteria();const keepCount=scope===loadedScope?entries.value.length:0;
 if(scope!==loadedScope){entries.value=[];cursor.value=null;loaded.value=false;}applied=search.value.trim();loading.value=true;error.value='';moreError.value='';loadingMore.value=false;
 const valid=()=>current===sequence&&active.value&&route.path==='/events'&&member===app.selectedMemberId.value;
 try{
  let page=await request<HealthFeedPage>(`health-records?${query()}`);if(!valid())return;validatePage(page,member);
  let items=page.items;const visited=new Set<string>();
  // Refresh the loaded window together, so returning from a detail does not discard later pages.
  while(page.nextCursor&&items.length<keepCount){
   if(visited.has(page.nextCursor))throw Error('分页信息异常，请刷新重试');visited.add(page.nextCursor);
   page=await request<HealthFeedPage>(`health-records?${query(page.nextCursor)}`);if(!valid())return;validatePage(page,member);
   items=[...new Map([...items,...page.items].map(item=>[item.id,item])).values()];
  }
  entries.value=items;cursor.value=page.nextCursor;loaded.value=true;loadedScope=scope;
 }catch(cause){if(current===sequence)error.value=cause instanceof Error?cause.message:'读取失败';}finally{if(current===sequence)loading.value=false;}
}
async function loadMore(){
 if(!active.value||route.path!=='/events'||recordOpen.value||medicationOpen.value||loading.value||loadingMore.value||!cursor.value||criteria()!==loadedScope||applied!==search.value.trim())return;
 const current=sequence;const member=app.selectedMemberId.value;loadingMore.value=true;moreError.value='';
 try{const page=await request<HealthFeedPage>(`health-records?${query(cursor.value)}`);if(current!==sequence||!active.value||member!==app.selectedMemberId.value||route.path!=='/events')return;
  validatePage(page,member);if(page.nextCursor===cursor.value)throw Error('分页信息异常，请刷新重试');entries.value=[...new Map([...entries.value,...page.items].map(item=>[item.id,item])).values()];cursor.value=page.nextCursor;
 }catch(cause){if(current===sequence)moreError.value=cause instanceof Error?cause.message:'加载更多失败';}finally{if(current===sequence)loadingMore.value=false;}
}
function submit(){clearTimeout(timer);if(applied!==search.value.trim()){writeFilters();void load();}}
function activateSearch(){app.setTopbarSearch({key:'events',model:search,placeholder:'搜索记录',expandedPlaceholder:'搜索报告、影像、症状、监测、药品或疫苗',submit});}
function observe(){observer?.disconnect();observer=null;if(!active.value||!sentinel.value||recordOpen.value||medicationOpen.value)return;observer=new IntersectionObserver(items=>{if(items.some(item=>item.isIntersecting)&&!moreError.value)void loadMore();},{rootMargin:'260px 0px',threshold:0.01});observer.observe(sentinel.value);}
const {pullDistance,refreshing,refresh}=usePullRefresh(root,async()=>{if(!recordOpen.value&&!medicationOpen.value)await load();});
function activateRecord(entry:HealthFeedEntry,event:MouseEvent){if(!touch.value||event.defaultPrevented||event.button!==0||event.ctrlKey||event.metaKey||event.shiftKey||event.altKey)return;event.preventDefault();if(entry.memberId!==app.selectedMemberId.value)return;const token=createUuid();owned={token,memberId:entry.memberId};void router.push({path:'/events',query:{...route.query,recordKind:entry.kind,recordId:entry.resourceId},state:{healthRecordTimelineEntry:token}});}
function closeRecord(){if(!recordOpen.value)return;const owner=owned;owned=null;if(owner?.memberId===app.selectedMemberId.value&&router.options.history.state.healthRecordTimelineEntry===owner.token){router.back();return;}if(route.query.returnTo){void router.replace(vaccinationReturnTo(route.query.returnTo));return;}const query={...route.query};delete query.recordKind;delete query.recordId;void router.replace({path:'/events',query});}
function openReport(id:string){if(recordOpen.value)void router.replace({path:'/events',query:{...route.query,recordKind:'report',recordId:id}});}
function closeMedication(){if(route.path!=='/events')return;const query={...route.query};delete query.add;void router.replace({path:'/events',query});}
watch(()=>JSON.stringify([route.path,dialog.value]),()=>{dialogMember.value=route.path==='/events'?app.selectedMemberId.value:'';if(!dialog.value)owned=null;},{immediate:true,flush:'sync'});
watch([dialog,touch,active],()=>{if(!dialog.value||touch.value||!active.value||route.path!=='/events'||dialogMember.value!==app.selectedMemberId.value)return;const query={...route.query};delete query.recordKind;delete query.recordId;void router.replace({path:healthRecordPath(dialog.value.kind,dialog.value.recordId),query});},{immediate:true});
watch(search,()=>{clearTimeout(timer);if(applied!==search.value.trim()){sequence++;loading.value=false;loadingMore.value=false;}timer=setTimeout(submit,350);});
function revealFilteredStart(){
 if(!touch.value||!root.value)return;
 const bar=root.value.querySelector('.timeline-filter-bar');if(!bar)return;
 const offset=Number.parseFloat(getComputedStyle(bar).top)||0;
 const top=root.value.getBoundingClientRect().top;
 if(top<offset)window.scrollTo({top:Math.max(0,window.scrollY+top-offset),behavior:'instant'});
}
function setCategory(value:HealthCategory|''){if(value && isHealthCategoryDisabled(value))return;if(category.value!==value||subtype.value||status.value)revealFilteredStart();subtype.value='';status.value='';category.value=value;}
function setSubtype(value:string){if(subtype.value!==value)revealFilteredStart();subtype.value=value;}
watch(()=>[route.path,text('category'),text('subtype'),text('status'),text('q')],()=>{
 if(route.path!=='/events')return;
 const filters=healthRecordFilters(route.query);category.value=filters.category;subtype.value=filters.subtype;status.value=filters.status;search.value=filters.search;
},{immediate:true});
watch([category,subtype,status],()=>{
 if(!active.value||route.path!=='/events')return;
 clearTimeout(timer);writeFilters();void load();
});
watch(app.selectedMemberId,(next,previous)=>{sequence++;entries.value=[];cursor.value=null;loaded.value=false;loadedScope='';error.value='';owned=null;
 if(previous&&next!==previous){dialogMember.value='';if(route.path==='/events'&&(dialog.value||text('add'))){const query={...route.query};delete query.recordKind;delete query.recordId;delete query.add;void router.replace({path:'/events',query});}}
 void load();},{immediate:true,flush:'sync'});
watch([sentinel,cursor,active,recordOpen,medicationOpen],observe,{flush:'post'});
onActivated(()=>{active.value=true;activateSearch();});onDeactivated(()=>{active.value=false;sequence++;clearTimeout(timer);observer?.disconnect();app.clearTopbarSearch('events');});
onBeforeUnmount(()=>{active.value=false;sequence++;clearTimeout(timer);observer?.disconnect();app.clearTopbarSearch('events');});
activateSearch();useRefreshOnActivate(load);
</script>
<template>
 <section ref="root" class="events-page">
  <header class="page-intro"><div><h2>健康时间轴</h2><p>报告、影像、症状、监测、用药与接种</p></div><div class="event-page-links">
   <label class="search-field page-search-field"><Search :size="18" aria-hidden="true"/><input v-model="search" aria-label="搜索记录" placeholder="搜索名称或日期" maxlength="200" @keydown.enter="submit"/></label>
   <button class="icon-button refresh-action" type="button" title="刷新" aria-label="刷新记录" :disabled="loading||refreshing" @click="refresh"><RefreshCw :size="18" :class="{'spin-icon':loading||refreshing}"/></button>
   <span v-if="loaded" class="count-label">{{cursor?'已显示 ':''}}{{entries.length}} 条记录</span>
  </div></header>
  <div class="timeline-filter-bar" data-pull-refresh-ignore>
   <div class="timeline-filters" role="group" aria-label="记录分类"><button type="button" :aria-pressed="!category" @click="setCategory('')">全部</button><button v-for="value in healthCategoryOrder" :key="value" type="button" :aria-pressed="category===value" :disabled="isHealthCategoryDisabled(value)" :title="isHealthCategoryDisabled(value)?'影像暂未开放':undefined" @click="setCategory(value)"><HealthCategoryIcon :category="value" :size="18"/>{{healthCategoryLabels[value]}}</button></div>
   <button v-if="category||subtype||status" class="timeline-filter-clear" type="button" aria-label="清除筛选" title="清除筛选" @click="setCategory('')">清除</button>
   <div v-if="subtypeOptions.length||status" class="timeline-filters secondary-filters" role="group" aria-label="细分类型"><span v-if="status" class="active-status-filter">{{statusLabels[status]}}</span><template v-if="subtypeOptions.length"><button type="button" :aria-pressed="!subtype" @click="setSubtype('')">全部类型</button><button v-for="[value,label] in subtypeOptions" :key="value" type="button" :aria-pressed="subtype===value" @click="setSubtype(value)">{{label}}</button></template></div>
  </div>
  <PullIndicator :distance="pullDistance" :refreshing="refreshing"/>
  <div v-if="loading&&!loaded" class="loading-list" role="status" aria-label="正在加载健康记录"><span v-for="index in 8" :key="index"/></div>
  <p v-if="error" class="inline-panel-error" role="alert">{{error}} <button type="button" class="error-retry" @click="load">重试</button></p>
  <div v-if="entries.length" class="events-list" :aria-busy="loading"><section v-for="group in groups" :key="group.key" class="health-timeline-group" :aria-label="group.label"><h3 class="health-timeline-month">{{group.label}}</h3><div class="health-timeline-entries"><HealthTimelineCard v-for="entry in group.entries" :key="entry.id" :entry="entry" :return-to="route.fullPath" :selected="recordOpen&&dialog?.kind===entry.kind&&dialog?.recordId===entry.resourceId" @activate="activateRecord"/></div></section></div>
  <EmptyState v-else-if="!loading&&!error" :title="search.trim()?'没有找到相关记录':category?'暂无这类记录':'暂无健康记录'" :description="search.trim()?'试试其他关键词，或清空搜索查看全部记录。':category==='monitoring'?'还没有测量记录，可从新增里记录血压、体格、血糖或血氧。':'上传资料，或从新增菜单填写症状、测量、用药和接种。'"/>
  <div v-if="cursor" ref="sentinel" class="form-actions load-more-indicator" aria-live="polite"><button :disabled="loading||loadingMore||applied!==search.trim()" @click="loadMore">{{loadingMore?'正在加载…':moreError?'加载失败，点击重试':'加载更多'}}</button></div><p v-if="moreError" class="inline-panel-error" role="alert">{{moreError}}</p>
  <p v-if="text('add')==='medication'&&(text('processId')||text('relatedId'))&&text('memberId')&&text('memberId')!==app.selectedMemberId.value" class="inline-panel-error" role="alert">关联来源不属于当前成员，请返回健康历程后重新填写。</p>
  <MedicationRecordModal v-if="medicationOpen" :open="true" add="course" :initial-related-records="initialRelatedRecords" :process-id="text('processId')||undefined" @close="closeMedication" @updated="load"/>
  <HealthRecordDetailModal v-if="recordOpen&&dialog" :key="`${app.selectedMemberId.value}:${dialog.kind}:${dialog.recordId}`" :open="true" v-bind="dialog" @close="closeRecord" @open-report="openReport" @updated="load"/>
 </section>
</template>
<style scoped>
.events-page { min-width: 0; }
.page-intro { align-items: center; }
.page-intro > div:first-child { flex: 1 1 auto; min-width: 0; }
.event-page-links { display: flex; align-items: center; gap: 10px; flex: 0 1 430px; min-width: 0; }
.page-search-field { min-width: 160px; min-height: 38px; max-width: 320px; }
.page-search-field > svg { flex-shrink: 0; }
.page-search-field input { min-width: 0; font-size: 14px; }
.event-page-links .count-label { padding: 0; font-size: 12px; }
.refresh-action { flex: 0 0 38px; width: 38px; height: 38px; min-height: 38px; }
.events-list { display: grid; gap: 18px; }
.health-timeline-group { display: grid; gap: 8px; min-width: 0; }
.health-timeline-month { font-size: 12px; line-height: 18px; color: var(--muted); font-weight: 500; }
.health-timeline-entries { display: grid; gap: 8px; min-width: 0; }
.timeline-filter-bar { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 2px 4px; min-width: 0; margin-bottom: 8px; }
.timeline-filters { min-width: 0; grid-column: 1; display: flex; align-items: center; gap: 6px; overflow-x: auto; overflow-y: hidden; overscroll-behavior-x: contain; touch-action: pan-x pinch-zoom; padding: 3px 2px; margin: 0; scroll-padding-inline: 2px; scrollbar-width: thin; }
.timeline-filters button { display:inline-flex; align-items:center; gap:4px; flex: 0 0 auto; min-height: 32px; padding: 4px 12px; border: 1px solid transparent; border-radius: 999px; color: var(--muted); background: var(--fill-2); font: inherit; font-size: 12px; line-height: 22px; white-space: nowrap; }
.timeline-filters button:disabled { opacity: .45; cursor: not-allowed; }
.timeline-filters button[aria-pressed=true] { color: var(--brand-strong); border-color: var(--brand); background: var(--brand-soft); }
.active-status-filter { flex: 0 0 auto; padding: 3px 8px; border-radius: 6px; color: var(--brand-strong); background: var(--brand-soft); font-size: 12px; line-height: 18px; white-space: nowrap; }
.timeline-filter-clear { grid-column: 2; grid-row: 1; position: relative; min-height: 32px; padding: 4px 7px; border: 0; border-radius: 0; color: var(--brand-strong); background: linear-gradient(90deg, transparent, var(--background) 30%, var(--background) 70%, transparent); font: inherit; font-size: 12px; line-height: 20px; white-space: nowrap; }
.timeline-filter-bar:has(> .timeline-filter-clear) > .timeline-filters:first-child { mask-image: linear-gradient(90deg, #000 calc(100% - 16px), transparent); }
.secondary-filters { grid-column: 1 / -1; }
.secondary-filters button { font-size: 12px; background: transparent; }
.secondary-filters button[aria-pressed=true] { border-color: transparent; background: var(--brand-soft); }
.timeline-filters button:focus-visible, .timeline-filter-clear:focus-visible { outline: 2px solid var(--brand); outline-offset: 1px; }
.load-more-indicator { justify-content: center; margin-top: 12px; border-bottom: 0; }
.load-more-indicator button { min-height: 40px; padding: 6px 16px; font-size: 14px; font-weight: 500; border-radius: 999px; }
.load-more-indicator button:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; }
.events-page > .inline-panel-error { margin-bottom: 12px; overflow-wrap: anywhere; }
.loading-list span { height: 108px; border: 1px solid var(--line); }
.events-page .refresh-action:disabled { opacity: .6; }
.events-page :deep(.empty-state strong) { font-size: 16px; }
.events-page :deep(.empty-state p), .events-page :deep(.pull-refresh-text) { font-size: 12px; }
@media (hover:hover) { .timeline-filters button:hover:not(:disabled):not([aria-pressed=true]) { background: var(--fill-3); color: var(--ink); } }
@media (min-width:761px) and (max-width:980px) {
  .page-intro { flex-direction: column; align-items: stretch; gap: 12px; }
  .event-page-links { flex: 0 0 auto; width: 100%; }
  .page-search-field { max-width: none; }
}
@media (max-width:760px), (pointer:coarse) {
  .events-page { margin-top: -8px; }
  .page-intro { display: none; }
  .timeline-filter-bar { position: sticky; top: var(--mobile-topbar-height); z-index: 10; row-gap: 0; margin-inline: calc(-1 * var(--page-content-inset, 16px)); margin-bottom: 4px; background: var(--background); }
  .timeline-filter-clear { margin-inline-end: var(--page-content-inset, 16px); }
  .timeline-filter-bar:has(> .timeline-filter-clear) > .timeline-filters:first-child { padding-inline-end: 2px; }
  /* The scroll viewport reaches both edges; its content keeps the page alignment. */
  .timeline-filters { gap: 3px; padding: 6px var(--page-content-inset, 16px); scroll-padding-inline: var(--page-content-inset, 16px); scrollbar-width: none; }
  .timeline-filter-bar:has(.secondary-filters) > .timeline-filters:first-child { padding-bottom: 2px; }
  .secondary-filters { padding-top: 2px; }
  .timeline-filters::-webkit-scrollbar { display: none; }
  .timeline-filters button { min-height: 28px; padding: 4px 9px; font-size: 12px; line-height: 18px; }
  .secondary-filters button { min-height: 26px; padding: 3px 8px; }
  .timeline-filter-clear { min-height: 28px; line-height: 18px; }
}
@media (pointer: coarse) { .timeline-filters button, .timeline-filter-clear { position: relative; } .timeline-filters button::after, .timeline-filter-clear::after { content: ''; position: absolute; inset: -8px 0; } .secondary-filters button::after { inset-block: -9px; } }
@media(prefers-reduced-motion:reduce) { .loading-list span { animation: none; } }
</style>
