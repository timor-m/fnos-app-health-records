<script setup lang="ts">
import '../styles/process-list-filters.css';
import { computed,onActivated,onBeforeUnmount,onDeactivated,ref,watch } from 'vue';
import { RouterLink,useRoute,useRouter } from 'vue-router';
import { RefreshCw,Search } from '@lucide/vue';
import SubPageHeader from '../components/SubPageHeader.vue';
import EmptyState from '../components/EmptyState.vue';
import RecordLoading from '../components/RecordLoading.vue';
import PullIndicator from '../components/PullIndicator.vue';
import HealthRecordIndexPanel from '../components/HealthRecordIndexPanel.vue';
import HealthProcessCard from '../components/HealthProcessCard.vue';
import { useAppContext } from '../composables/useAppContext';
import { usePullRefresh } from '../composables/usePullRefresh';
import { useRefreshOnActivate } from '../composables/useRefreshOnActivate';
import { request } from '../utils/api';
import type { HealthProcessPage,HealthProcessSummary } from '../../../shared/health-process';

const app=useAppContext();const route=useRoute();const router=useRouter();
const listRoot=ref<HTMLElement|null>(null);const items=ref<HealthProcessSummary[]>([]);
const sentinel=ref<HTMLElement|null>(null);const cursor=ref<string|null>(null);const total=ref(0);
const loading=ref(false);const loadingMore=ref(false);const loaded=ref(false);const error=ref('');const moreError=ref('');const active=ref(true);
let sequence=0;let loadedScope='';let timer:ReturnType<typeof setTimeout>|undefined;let observer:IntersectionObserver|null=null;
const search=computed({get:()=>typeof route.query.q==='string'?route.query.q:'',set:(q:string)=>{void router.replace({path:'/health-processes',query:{...route.query,q:q||undefined}});}});
const indexView=computed(()=>route.query.view==='index');
const hasFilters=computed(()=>indexView.value?Boolean(route.query.indexName||route.query.indexQuery||route.query.indexKind==='symptom'):Boolean(search.value));
function clearFilters(){const values={...route.query};if(indexView.value){delete values.indexName;delete values.indexQuery;delete values.indexKind;}else delete values.q;void router.replace({path:'/health-processes',query:values});}
function switchView(index:boolean){const values={...route.query};if(index)values.view='index';else{delete values.view;delete values.indexKind;delete values.indexName;delete values.indexQuery;}void router.replace({path:'/health-processes',query:values});}
const criteria=()=>JSON.stringify([app.selectedMemberId.value,search.value.trim()]);
function query(member:string,q:string,after?:string){const params=new URLSearchParams({memberId:member,limit:'20'});if(q)params.set('q',q);if(after)params.set('cursor',after);return params;}
function validatePage(page:HealthProcessPage,member:string){
 if(!page||!Array.isArray(page.items)||!Number.isInteger(page.total)||page.total<0||typeof page.hasMore!=='boolean'||!(page.nextCursor===null||typeof page.nextCursor==='string'&&page.nextCursor.length>0)||page.hasMore!==Boolean(page.nextCursor))throw Error('健康历程数据无效，请刷新重试');
 if(page.items.some(item=>item.memberId!==member))throw Error('健康历程与当前成员不一致');
}
async function load(){
 const member=app.selectedMemberId.value;if(!active.value||route.path!=='/health-processes'||!member)return;
 clearTimeout(timer);const token=++sequence;const scope=criteria();const q=search.value.trim();const keepCount=scope===loadedScope?items.value.length:0;
 loading.value=true;loadingMore.value=false;error.value='';moreError.value='';
 const valid=()=>token===sequence&&member===app.selectedMemberId.value&&active.value&&route.path==='/health-processes'&&scope===criteria();
 try{let page=await request<HealthProcessPage>(`health-processes?${query(member,q)}`);if(!valid())return;validatePage(page,member);
  let next=page.items;const visited=new Set<string>();
  // Refresh the whole visible window atomically; detail return must not collapse later pages.
  while(page.nextCursor&&next.length<keepCount){if(visited.has(page.nextCursor))throw Error('分页信息异常，请刷新重试');visited.add(page.nextCursor);
   page=await request<HealthProcessPage>(`health-processes?${query(member,q,page.nextCursor)}`);if(!valid())return;validatePage(page,member);
   next=[...new Map([...next,...page.items].map(item=>[item.id,item])).values()];
  }
  items.value=next;total.value=page.total;cursor.value=page.nextCursor;loaded.value=true;loadedScope=scope;
 }catch(cause){if(token===sequence&&active.value&&member===app.selectedMemberId.value&&route.path==='/health-processes')error.value=cause instanceof Error?cause.message:'健康历程加载失败';}
 finally{if(token===sequence)loading.value=false;}
}
async function loadMore(){
 const member=app.selectedMemberId.value;if(!active.value||route.path!=='/health-processes'||!member||loading.value||loadingMore.value||!cursor.value||criteria()!==loadedScope)return;
 const token=sequence;const after=cursor.value;const scope=criteria();loadingMore.value=true;moreError.value='';
 try{const page=await request<HealthProcessPage>(`health-processes?${query(member,search.value.trim(),after)}`);
  if(token!==sequence||!active.value||member!==app.selectedMemberId.value||route.path!=='/health-processes'||scope!==criteria())return;
  validatePage(page,member);if(page.nextCursor===after)throw Error('分页信息异常，请刷新重试');
  items.value=[...new Map([...items.value,...page.items].map(item=>[item.id,item])).values()];cursor.value=page.nextCursor;total.value=page.total;
 }catch(cause){if(token===sequence)moreError.value=cause instanceof Error?cause.message:'加载更多失败';}finally{if(token===sequence)loadingMore.value=false;}
}
function observe(){observer?.disconnect();observer=null;const element=sentinel.value;if(!active.value||!element||!cursor.value||typeof IntersectionObserver==='undefined')return;
 const next=new IntersectionObserver(entries=>{if(observer===next&&entries.some(entry=>entry.isIntersecting)&&!error.value&&!moreError.value)void loadMore();},{rootMargin:'260px 0px',threshold:0.01});observer=next;next.observe(element);
}
function clearList(){sequence++;items.value=[];cursor.value=null;total.value=0;loaded.value=false;loadedScope='';loading.value=false;loadingMore.value=false;error.value='';moreError.value='';clearTimeout(timer);}
watch(search,(next,previous)=>{if(next.trim()===previous.trim()||route.path!=='/health-processes'||criteria()===loadedScope)return;clearList();if(active.value){loading.value=true;timer=setTimeout(()=>void load(),350);}},{flush:'sync'});
watch(app.selectedMemberId,()=>{clearList();void load();},{immediate:true,flush:'sync'});
watch([sentinel,cursor,active],observe,{flush:'post'});
onActivated(()=>{active.value=true;});onDeactivated(()=>{active.value=false;sequence++;loading.value=false;loadingMore.value=false;clearTimeout(timer);observer?.disconnect();observer=null;});onBeforeUnmount(()=>{active.value=false;sequence++;clearTimeout(timer);observer?.disconnect();observer=null;});
useRefreshOnActivate(load);
const {pullDistance,refreshing,refresh}=usePullRefresh(listRoot,load);
</script>

<template>
 <section class="plain-page health-processes-page">
  <SubPageHeader title="健康历程" back-to="/overview" back-label="返回概览"/>
  <div class="process-filter-bar" data-pull-refresh-ignore><div class="process-view-tabs process-filter-row" role="group" aria-label="历程查看方式"><button type="button" :aria-pressed="!indexView" @click="switchView(false)">按历程看</button><button type="button" :aria-pressed="indexView" @click="switchView(true)">按疾病／症状看</button></div><button v-if="hasFilters" class="process-filter-clear" type="button" aria-label="清除筛选" @click="clearFilters">清除</button></div>
  <HealthRecordIndexPanel v-if="indexView" :member-id="app.selectedMemberId.value"/>
  <template v-else>
  <div class="process-list-toolbar"><label class="process-list-search"><Search :size="16" aria-hidden="true"/><input v-model="search" type="search" placeholder="搜索历程名称或摘要" aria-label="搜索健康历程" maxlength="200"/></label><button type="button" class="plain-icon-button process-list-refresh" aria-label="刷新健康历程" title="刷新" :disabled="loading||refreshing" @click="refresh"><RefreshCw :size="16" :class="{'spin-icon':loading||refreshing}"/></button></div>
  <p v-if="loaded" class="process-list-count">{{search.trim()?`找到 ${total} 个历程`:`共 ${total} 个历程 · 按最近记录时间排序`}}</p>
  <div ref="listRoot" class="process-list-results">
  <PullIndicator v-if="pullDistance>0||refreshing" :distance="pullDistance" :refreshing="refreshing"/>
  <RecordLoading v-if="loading&&!loaded" label="正在读取健康历程…"/>
  <p v-if="error" class="inline-panel-error" role="alert">{{error}} <button class="error-retry" type="button" :disabled="loading" @click="load">重试</button></p>
  <template v-if="loaded">
   <div v-if="items.length" class="process-list settings-band">
    <HealthProcessCard v-for="item in items" :key="item.id" class="process-list-card" :process="item" :return-to="route.fullPath"/>
   </div>
   <EmptyState v-else :title="search.trim()?'没有匹配的历程':'还没有健康历程'" :description="search.trim()?'试试其他名称或关键词。':'在记录详情关联相关记录后，会自动形成健康历程。'"><button v-if="search.trim()" type="button" class="soft-action-button" @click="search=''">清除搜索</button><RouterLink v-else class="soft-action-button" to="/events">查看记录</RouterLink></EmptyState>
   <div v-if="cursor" ref="sentinel" class="process-list-pagination" aria-live="polite"><button type="button" class="soft-action-button process-list-more" :disabled="loading||loadingMore" @click="loadMore">{{loadingMore?'正在加载…':moreError?'加载失败，点击重试':'加载更多历程'}}</button></div>
   <p v-if="moreError" class="inline-panel-error" role="alert">{{moreError}}</p>
  </template>
  </div>
  </template>
 </section>
</template>

<style scoped>

.health-processes-page{min-width:0;display:grid;gap:8px;align-content:start}.health-processes-page :deep(.subpage-header){margin-bottom:0}.health-processes-page :deep(.subpage-header h2){font-size:16px;line-height:24px}.process-list-toolbar{display:flex;align-items:center;gap:8px;min-width:0}.process-list-search{display:flex;align-items:center;gap:6px;flex:1;min-width:0;padding:5px 10px;border:1px solid var(--line-strong);border-radius:var(--radius-s);background:var(--surface);color:var(--muted)}.process-list-search:focus-within{border-color:var(--brand);outline:2px solid var(--brand-soft)}.process-list-search>svg{flex-shrink:0}.process-list-search input{width:100%;min-width:0;padding:0;border:0;border-radius:0;background:transparent;color:var(--ink);font:inherit;font-size:14px;line-height:20px;outline:none;box-shadow:none}.process-list-toolbar>button{width:36px;height:36px;flex-shrink:0}.process-list-count{margin:0;color:var(--muted);font-size:12px;line-height:17px}.process-list-results{display:grid;gap:12px;align-content:start;min-width:0}.process-list{display:grid;gap:8px;min-width:0;padding:12px;border:1px solid var(--line);box-shadow:none}.process-list-pagination{display:flex;justify-content:center}.process-list-more{min-height:34px;font-size:14px}.health-processes-page button:focus-visible{outline:2px solid var(--brand);outline-offset:2px}.health-processes-page :deep(.empty-state strong){font-size:16px}.health-processes-page :deep(.empty-state p){font-size:14px}@media(max-width:760px),(pointer:coarse){.health-processes-page{gap:8px}.process-list-results{gap:10px}.process-list-refresh{display:none}}
@media(max-width:760px){.process-list{padding:10px}}
</style>
