import { computed, nextTick, onActivated, onBeforeUnmount, onDeactivated, ref, shallowRef } from 'vue';
import { ApiRequestError, request } from '../utils/api';
import type { TrendPoint, TrendExcludedPoint, TrendSeries } from '../types/api';
import type { TrendSnapshotItem, TrendSnapshotOverview, TrendSnapshotPage, TrendSnapshotSection, TrendSnapshotStatus, TrendSectionPage } from '../types/trend-snapshot';
import type { TrendGroupNode } from '../../../shared/trend-groups';

type Filters = {query:string;group:string;attention:string};
const identity = (item: Pick<TrendSeries,'indicatorKey'|'unit'>) => JSON.stringify([item.indicatorKey,item.unit || '']);
const emptyPage = (): TrendSectionPage => ({keys:[],cursor:null,started:false,loading:false,error:''});

/** Owns one member/query/version at a time. Rendering and existing UI remain in the page. */
export function useTrendSnapshots(member: () => string|null, filters: () => Filters) {
  const series = shallowRef<TrendSnapshotItem[]>([]);
  const groups = shallowRef<TrendGroupNode[]>([]);
  const sections = shallowRef<TrendSnapshotSection[]>([]);
  const pages = ref<Record<string,TrendSectionPage>>({});
  const opened = ref(new Set<string>());
  const manuallyClosed = new Set<string>();
  const version = ref<number|null>(null);
  const status = ref<TrendSnapshotStatus>('building');
  const total = ref(0), pointCount = ref(0), pinnedCount = ref(0), pinnedAbnormalCount = ref(0);
  const loading = ref(true), filtering = ref(false), error = ref('');
  const visibleCharts = ref(new Set<string>());
  const chartErrors = ref<Record<string,string>>({});
  const detailErrors = ref<Record<string,string>>({});
  const chartPending = ref(new Set<string>());
  const detailPending = ref(new Set<string>());
  const queuedCharts = new Set<string>();
  const forcedCharts = new Set<string>();
  const chartWaiters = new Map<string,{generation:number;promise:Promise<void>;resolve:()=>void}>();
  function settleCharts(keys:string[], sequence:number) {
    for(const key of keys){const waiter=chartWaiters.get(key);if(waiter?.generation===sequence){waiter.resolve();chartWaiters.delete(key);forcedCharts.delete(key);}}
  }
  const controllers = new Set<AbortController>();
  const detailRequests = new Map<string,Promise<void>>();
  let generation = 0, active = true, disposed = false;
  let appliedMember: string|null = null, appliedQuery = '';
  let poll: ReturnType<typeof setTimeout>|null = null;
  let chartTimer: ReturnType<typeof setTimeout>|null = null;
  let chartRun: number|null = null, refreshing = false;
  let resumeWanted = false;

  const keyOf = (item: Pick<TrendSeries,'indicatorKey'|'unit'>) => identity(item);
  const itemFor = (key:string) => series.value.find(item => keyOf(item)===key);
  const context = () => ({memberId:member(),version:version.value,generation});
  const current = (value: ReturnType<typeof context>) => active && !disposed && member()===value.memberId
    && generation===value.generation && version.value===value.version;
  const queryKey = () => JSON.stringify(filters());
  const params = (memberId:string, extras:Record<string,string> = {}) => new URLSearchParams({memberId,...filters(),...extras}).toString();

  let sectionReads=0;
  const sectionWaiters=new Set<()=>void>();
  function reserveSection(signal:AbortSignal):Promise<()=>void> {
    return new Promise((resolve,reject)=>{
      let occupied=false,settled=false;
      const cleanup=()=>{sectionWaiters.delete(start);signal.removeEventListener('abort',abort);};
      const release=()=>{
        if(!occupied)return;
        occupied=false;sectionReads--;cleanup();
        for(const wake of [...sectionWaiters])wake();
      };
      const abort=()=>{
        cleanup();
        if(occupied)release();
        else if(!settled){settled=true;reject(new DOMException('Aborted','AbortError'));}
      };
      const start=()=>{
        if(signal.aborted){abort();return;}
        if(sectionReads>=2)return;
        occupied=true;settled=true;sectionReads++;sectionWaiters.delete(start);resolve(release);
      };
      signal.addEventListener('abort',abort,{once:true});sectionWaiters.add(start);start();
    });
  }
  async function fetchData<T>(path:string, init:RequestInit={}) {
    const controller = new AbortController(); controllers.add(controller);
    const timeout=setTimeout(()=>controller.abort(),30000);
    controller.signal.addEventListener('abort',()=>clearTimeout(timeout),{once:true});
    let release=()=>{};
    try {
      if(path.startsWith('trends/snapshot/series?'))release=await reserveSection(controller.signal);
      if(controller.signal.aborted)throw new DOMException('Aborted','AbortError');
      return await request<T>(path,{...init,signal:controller.signal});
    } finally { release();clearTimeout(timeout);controllers.delete(controller); }
  }
  function cancel() {
    generation++;
    for (const controller of controllers) controller.abort();
    controllers.clear();queuedCharts.clear();detailRequests.clear();forcedCharts.clear();
    for(const waiter of chartWaiters.values())waiter.resolve();chartWaiters.clear();
    chartPending.value = new Set();detailPending.value = new Set();chartRun=null;
    if (chartTimer) clearTimeout(chartTimer);chartTimer=null;
    if (poll) clearTimeout(poll);poll=null;
  }
  function reset() {
    cancel();series.value=[];groups.value=[];sections.value=[];pages.value={};opened.value=new Set();manuallyClosed.clear();
    version.value=null;appliedMember=null;appliedQuery='';total.value=0;pointCount.value=0;pinnedCount.value=0;pinnedAbnormalCount.value=0;
    visibleCharts.value=new Set();chartErrors.value={};detailErrors.value={};error.value='';loading.value=true;
  }
  function clearDenied(cause:unknown) {
    if(!(cause instanceof ApiRequestError) || ![401,403,404].includes(cause.status))return false;
    reset();loading.value=false;filtering.value=false;
    error.value=cause.message;
    return true;
  }
  function merge(items:TrendSnapshotItem[], retain:boolean) {
    const cache = new Map(series.value.map(item=>[keyOf(item),item]));
    for (const item of items) {
      const key=keyOf(item), previous=cache.get(key);
      cache.set(key,retain && previous ? {...item,
        points:previous.chartLoaded ? previous.points : item.points,chartLoaded:previous.chartLoaded,
        excludedPoints:previous.detailLoaded ? previous.excludedPoints : item.excludedPoints,detailLoaded:previous.detailLoaded} : item);
    }
    series.value=[...cache.values()];
  }
  function acceptPage(key:string, page:TrendSnapshotPage, append=false, retain=true) {
    merge(page.items,retain);
    const previous=pages.value[key] || emptyPage();
    pages.value[key]={keys:[...new Set([...(append?previous.keys:[]),...page.items.map(keyOf)])],
      cursor:page.nextCursor,started:true,loading:false,error:''};
  }
  function schedulePoll() {
    if (poll) clearTimeout(poll);
    if (!active || disposed || !member()) return;
    poll=setTimeout(()=>{poll=null;void checkStatus();},status.value==='ready'?15000:1500);
  }
  async function checkStatus() {
    const target=context();if (!target.memberId || !active) return;
    try {
      const next=await fetchData<{version:number|null;status:TrendSnapshotStatus}>(`trends/snapshot/status?memberId=${encodeURIComponent(target.memberId)}`);
      if (!current(target)) return;
      status.value=next.status;
      if (next.version!==version.value) { await load(target.memberId,true);return; }
    }catch(cause) {
      if(current(target) && clearDenied(cause))return;
      // Transient transport failures keep content and retry on the next status check.
    }
    schedulePoll();
  }

  async function load(memberId:string, silent=false) {
    if (!active || disposed || member()!==memberId) return;
    const signature=queryKey(), sameQuery=appliedMember===memberId && appliedQuery===signature;
    const previousPages=sameQuery ? new Map(Object.entries(pages.value).map(([key,page])=>[key,page.keys.length])) : new Map<string,number>();
    const previousOpen=sameQuery ? new Set(opened.value) : new Set<string>();
    const previousVisible=new Set(visibleCharts.value);
    cancel();
    if(!sameQuery)manuallyClosed.clear();
    let sequence=generation;
    if (!silent || appliedMember!==memberId) loading.value=true;else filtering.value=true;
    error.value='';
    try {
      const response=await fetchData<TrendSnapshotOverview>(`trends/snapshot?${params(memberId)}`);
      if (!active || disposed || generation!==sequence || member()!==memberId || queryKey()!==signature) return;
      const retain=version.value===response.version && appliedMember===memberId;
      const prior=retain ? new Map(series.value.map(item=>[keyOf(item),item])) : new Map<string,TrendSnapshotItem>();
      const preparedItems=new Map<string,TrendSnapshotItem>();
      const preparedPages:Record<string,TrendSectionPage>={};
      const preparePage=(key:string,page:TrendSnapshotPage,append=false)=>{
        for(const item of page.items){
          const key=keyOf(item),previous=prior.get(key);
          preparedItems.set(key,previous ? {...item,
            points:previous.chartLoaded?previous.points:item.points,chartLoaded:previous.chartLoaded,
            excludedPoints:previous.detailLoaded?previous.excludedPoints:item.excludedPoints,detailLoaded:previous.detailLoaded} : item);
        }
        preparedPages[key]={keys:[...new Set([...(append?preparedPages[key]?.keys || []:[]),...page.items.map(keyOf)])],
          cursor:page.nextCursor,started:true,loading:false,error:''};
      };
      const nextOpen=new Set([...previousOpen].filter(key=>key==='pinned'?response.pinnedCount>0:response.sections.some(section=>section.key===key)));
      if(response.pinned){preparePage('pinned',response.pinned);if(response.pinnedCount>0 && !manuallyClosed.has('pinned'))nextOpen.add('pinned');}
      if(response.firstSection){
        preparePage(response.firstSection.key,response.firstSection);
        if((!sameQuery || ![...previousOpen].some(key=>nextOpen.has(key))) && !manuallyClosed.has(response.firstSection.key))nextOpen.add(response.firstSection.key);
      }
      // Prepare restored pages without shrinking the rendered list while requests
      // are pending. Otherwise the browser clamps the retained scroll position.
      if(response.version)for(const [key,count] of previousPages){
        if(!nextOpen.has(key))continue;
        while(!preparedPages[key]?.started || preparedPages[key].cursor && preparedPages[key].keys.length<count){
          const page=preparedPages[key] || emptyPage(),append=page.started;
          const extras:Record<string,string>={version:String(response.version),pin:key==='pinned'?'only':'exclude',limit:'12'};
          if(key!=='pinned')extras.section=key;
          if(append && page.cursor)extras.cursor=page.cursor;
          try{
            const next=await fetchData<TrendSnapshotPage>(`trends/snapshot/series?${params(memberId,extras)}`);
            if(generation!==sequence || !active || member()!==memberId)return;
            if(next.version!==response.version)throw new ApiRequestError('趋势数据已更新，请重新加载',{status:409});
            preparePage(key,next,append);
            if(preparedPages[key].keys.length===page.keys.length)break;
          }catch(cause){
            if(generation!==sequence || !active || member()!==memberId)return;
            if(cause instanceof ApiRequestError && [401,403,404].includes(cause.status))throw cause;
            preparedPages[key]={...page,loading:false,error:cause instanceof Error?cause.message:'分组加载失败'};
            break;
          }
        }
      }
      if(generation!==sequence || !active || member()!==memberId)return;
      // Discard chart requests made against the previous version during refresh.
      cancel();sequence=generation;
      version.value=response.version;status.value=response.status;
      total.value=response.total;pointCount.value=response.pointCount;pinnedCount.value=response.pinnedCount;pinnedAbnormalCount.value=(response.pinned?.sections || []).reduce((sum,section)=>sum+section.abnormalCount,0);
      groups.value=response.groups;sections.value=response.sections;
      series.value=response.version?[...preparedItems.values()]:[];
      pages.value=response.version?preparedPages:{};opened.value=nextOpen;
      chartErrors.value={};detailErrors.value={};
      appliedMember=memberId;appliedQuery=signature;
      visibleCharts.value=new Set([...previousVisible].filter(key=>Boolean(itemFor(key))));
      await nextTick();
      for(const key of visibleCharts.value)queueChart(key);
      schedulePoll();
    } catch(cause) {
      if (active && generation===sequence && member()===memberId) {
        if(clearDenied(cause))throw cause;
        schedulePoll();
        error.value=cause instanceof Error?cause.message:'趋势加载失败';
        throw cause;
      }
    } finally { if(generation===sequence){loading.value=false;filtering.value=false;} }
  }

  async function stale(target:ReturnType<typeof context>) {
    if(!current(target) || refreshing || !target.memberId)return;
    refreshing=true;
    try{await load(target.memberId,true);}finally{refreshing=false;}
  }
  async function loadSection(key:string, append=false) {
    const target=context();if(!active || disposed || !target.memberId || !target.version)return;
    const page=pages.value[key] || emptyPage();
    if(page.loading || append && !page.cursor || !append && page.started && !page.error)return;
    pages.value[key]={...page,loading:true,error:''};
    const extras:Record<string,string>={version:String(target.version),pin:key==='pinned'?'only':'exclude',limit:'12'};
    if(key!=='pinned')extras.section=key;
    if(append && page.cursor)extras.cursor=page.cursor;
    try {
      const response=await fetchData<TrendSnapshotPage>(`trends/snapshot/series?${params(target.memberId,extras)}`);
      if(!current(target))return;
      if(response.version!==target.version){await stale(target);return;}
      acceptPage(key,response,append);
    }catch(cause){
      if(!current(target))return;
      if(clearDenied(cause))return;
      pages.value[key]={...pages.value[key],loading:false,error:cause instanceof Error?cause.message:'分组加载失败'};
      if(cause instanceof ApiRequestError && cause.status===409)await stale(target);
    }
  }
  async function toggleSection(key:string) {
    const next=new Set(opened.value);
    if(next.has(key)){next.delete(key);manuallyClosed.add(key);}
    else {next.add(key);manuallyClosed.delete(key);}
    opened.value=next;
    if(next.has(key))await loadSection(key);
  }
  async function prefetchNext(key:string) {
    const order=[...(pinnedCount.value?['pinned']:[]),...sections.value.map(section=>section.key)];
    const next=order[order.indexOf(key)+1];
    if(!next || manuallyClosed.has(next) || !opened.value.has(key))return;
    if(!opened.value.has(next))opened.value=new Set([...opened.value,next]);
    await loadSection(next);
  }

  function queueChart(key:string) {
    if(!active || !itemFor(key) || itemFor(key)?.chartLoaded || chartPending.value.has(key) || chartErrors.value[key])return;
    queuedCharts.add(key);
    if(chartRun===null && !chartTimer)chartTimer=setTimeout(()=>{chartTimer=null;void flushCharts();},30);
  }
  function setChartVisible(item:TrendSeries, visible:boolean) {
    const key=keyOf(item),next=new Set(visibleCharts.value);
    if(visible){next.add(key);queueChart(key);}else next.delete(key);
    if(visibleCharts.value.has(key)!==visible)visibleCharts.value=next;
  }
  async function flushCharts() {
    const target=context();if(chartRun!==null || !target.memberId || !target.version || !active)return;
    for(const key of queuedCharts)if((!visibleCharts.value.has(key) && !forcedCharts.has(key)) || !itemFor(key))queuedCharts.delete(key);
    const keys=[...queuedCharts].filter(key=>(visibleCharts.value.has(key) || forcedCharts.has(key)) && !itemFor(key)?.chartLoaded).slice(0,12);
    for(const key of keys)queuedCharts.delete(key);
    if(!keys.length)return;
    chartRun=target.generation;chartPending.value=new Set([...chartPending.value,...keys]);
    try{
      const response=await fetchData<{version:number;items:Array<{key:string;data:TrendPoint[]}>}>('trends/snapshot/charts',{
        method:'POST',body:JSON.stringify({memberId:target.memberId,version:target.version,keys})
      });
      if(!current(target))return;
      if(response.version!==target.version){await stale(target);return;}
      const requested=new Set(keys),data=new Map(response.items.filter(item=>requested.has(item.key)).map(item=>[item.key,item.data]));
      series.value=series.value.map(item=>data.has(keyOf(item))?{...item,points:data.get(keyOf(item))!,chartLoaded:true}:item);
      for(const key of keys)if(!data.has(key))chartErrors.value[key]='图表结果不完整，请重试';
    }catch(cause){
      if(!current(target))return;
      if(clearDenied(cause))return;
      for(const key of keys)chartErrors.value[key]=cause instanceof Error?cause.message:'图表加载失败';
      if(cause instanceof ApiRequestError && cause.status===409)await stale(target);
    }finally{
      if(chartRun===target.generation)chartRun=null;
      if(current(target)){settleCharts(keys,target.generation);const next=new Set(chartPending.value);keys.forEach(key=>next.delete(key));chartPending.value=next;}
      if(active && queuedCharts.size && chartRun===null && !chartTimer)chartTimer=setTimeout(()=>{chartTimer=null;void flushCharts();},0);
    }
  }
  function ensureChart(item:TrendSeries) {
    const key=keyOf(item),target=context();
    if(!current(target) || !target.version || !itemFor(key) || itemFor(key)?.chartLoaded)return Promise.resolve();
    const existing=chartWaiters.get(key);if(existing)return existing.promise;
    let resolve!:()=>void;
    const promise=new Promise<void>(finish=>{resolve=finish;});
    chartWaiters.set(key,{generation:target.generation,promise,resolve});forcedCharts.add(key);
    delete chartErrors.value[key];queueChart(key);
    return promise;
  }
  function ensureDetails(item:TrendSeries) {
    const key=keyOf(item),target=context();
    if(itemFor(key)?.detailLoaded || !target.memberId || !target.version)return Promise.resolve();
    const pending=detailRequests.get(key);if(pending)return pending;
    detailPending.value=new Set([...detailPending.value,key]);delete detailErrors.value[key];
    const promise=(async()=>{
      try{
        const response=await fetchData<{version:number;items:Array<{key:string;data:{excludedPoints:TrendExcludedPoint[]}}>}>('trends/snapshot/details',{
          method:'POST',body:JSON.stringify({memberId:target.memberId,version:target.version,keys:[key]})
        });
        if(!current(target))return;
        const next=response.items.find(item=>item.key===key);
        if(response.version!==target.version || !next){await stale(target);return;}
        series.value=series.value.map(item=>keyOf(item)===key?{...item,excludedPoints:next.data.excludedPoints,detailLoaded:true}:item);
      }catch(cause){
        if(!current(target))return;
        if(clearDenied(cause))return;
        detailErrors.value[key]=cause instanceof Error?cause.message:'整理详情加载失败';
        if(cause instanceof ApiRequestError && cause.status===409)await stale(target);
      }finally{
        if(current(target)){detailRequests.delete(key);const next=new Set(detailPending.value);next.delete(key);detailPending.value=next;}
      }
    })();detailRequests.set(key,promise);return promise;
  }
  function pause() {active=false;resumeWanted=true;cancel();}
  function resume() {
    active=true;
    if(resumeWanted && member()){resumeWanted=false;void load(member()!,true).catch(()=>{});}
    else schedulePoll();
  }
  onDeactivated(pause);onActivated(resume);
  onBeforeUnmount(()=>{disposed=true;active=false;cancel();});
  const orderedSections=computed(()=>[
    ...(pinnedCount.value?[{key:'pinned',name:'我的关注',sortOrder:0,count:pinnedCount.value,pointCount:0,abnormalCount:pinnedAbnormalCount.value,subgroups:[]}]:[]),
    ...sections.value
  ]);
  return {series,groups,sections:orderedSections,pages,opened,version,status,total,pointCount,pinnedCount,loading,filtering,error,
    visibleCharts,chartErrors,detailErrors,chartPending,detailPending,keyOf,itemFor,reset,cancel,load,loadSection,toggleSection,prefetchNext,
    setChartVisible,ensureChart,ensureDetails,
    sectionItems:(key:string)=>(pages.value[key]?.keys || []).map(itemFor).filter((item):item is TrendSnapshotItem=>Boolean(item)),
    retryChart:(item:TrendSeries)=>{delete chartErrors.value[keyOf(item)];setChartVisible(item,true);},
    invalidate:()=>{cancel();filtering.value=true;}
  };
}
