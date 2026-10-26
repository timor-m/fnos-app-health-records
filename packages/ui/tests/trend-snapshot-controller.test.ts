import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {defineComponent,h,ref} from 'vue';
import {flushPromises,mount} from '@vue/test-utils';
import {useTrendSnapshots} from '../src/composables/useTrendSnapshots';
import {ApiRequestError} from '../src/utils/api';
import {sampleTrend,snapshotOverview,snapshotPage,snapshotParts,snapshotKey} from './helpers/trend-snapshot';
import type {TrendSnapshotItem,TrendSnapshotOverview} from '../src/types/trend-snapshot';
const {request}=vi.hoisted(()=>({request:vi.fn()}));
vi.mock('../src/utils/api',async original=>({...await original<typeof import('../src/utils/api')>(),request}));
const deferred=<T,>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(finish=>resolve=finish);return {promise,resolve};};
let wrapper:ReturnType<typeof mount>;
let model:ReturnType<typeof useTrendSnapshots>;
let member=ref<string|null>('member');
let filters=ref({query:'',group:'',attention:'all'});
const first=sampleTrend(['2','3']);
const second={...first,indicatorKey:'second',name:'第二组',groupKey:'functional',groupName:'功能检查',groupOrder:2};
const third={...first,indicatorKey:'third',name:'第三组',groupKey:'other',groupName:'其他',groupOrder:3};
beforeEach(()=>{
 vi.useFakeTimers();member=ref('member');filters=ref({query:'',group:'',attention:'all'});request.mockReset();
 request.mockImplementation(async(path:string,init?:RequestInit)=>path==='trends/snapshot/charts'?snapshotParts([first,second,third],init):snapshotOverview([first,second,third]));
 wrapper=mount(defineComponent({setup(){model=useTrendSnapshots(()=>member.value,()=>filters.value);return ()=>h('div');}}));
});
afterEach(()=>{wrapper.unmount();vi.useRealTimers();});
const load=async()=>{await model.load('member');await flushPromises();};
const calls=(path:string)=>request.mock.calls.filter(([value])=>String(value).startsWith(path));
describe('snapshot controller',()=>{
 it('loads only the first section, and batches/deduplicates visible charts',async()=>{
  await load();expect(model.series.value).toHaveLength(1);expect(model.sections.value).toHaveLength(3);
  expect(model.opened.value.has('laboratory')).toBe(true);expect(calls('trends/snapshot/charts')).toHaveLength(0);
  const item=model.series.value[0];model.setChartVisible(item,true);model.setChartVisible(item,true);
  await vi.advanceTimersByTimeAsync(31);await flushPromises();
  expect(calls('trends/snapshot/charts')).toHaveLength(1);
  expect(model.series.value[0].chartLoaded).toBe(true);
  model.setChartVisible(model.series.value[0],false);model.setChartVisible(model.series.value[0],true);
  await vi.advanceTimersByTimeAsync(31);expect(calls('trends/snapshot/charts')).toHaveLength(1);
 });
 it('preloads only the adjacent section, merges concurrent clicks, and respects manual collapse',async()=>{
  const pending=deferred<any>();
  request.mockImplementation(async(path:string)=>path.startsWith('trends/snapshot/series?')?pending.promise:snapshotOverview([first,second,third]));
  await load();const prefetch=model.prefetchNext('laboratory');const duplicate=model.prefetchNext('laboratory');await flushPromises();
  expect(calls('trends/snapshot/series?')).toHaveLength(1);expect(model.opened.value.has('other')).toBe(false);
  pending.resolve(snapshotPage([second]));await prefetch;await duplicate;
  await model.toggleSection('functional');expect(model.opened.value.has('functional')).toBe(false);
  await model.prefetchNext('laboratory');expect(model.opened.value.has('functional')).toBe(false);
  expect(calls('trends/snapshot/series?')).toHaveLength(1);
 });
 it('appends group pages without duplicating cards',async()=>{
  const initial=snapshotOverview([first,second]);initial.firstSection!.nextCursor='next';initial.firstSection!.hasMore=true;
  const additional={...first,indicatorKey:'new',name:'新指标'};
  request.mockImplementation(async(path:string)=>path.startsWith('trends/snapshot/series?')?snapshotPage([first,additional]):initial);
  await load();await model.loadSection('laboratory',true);
  expect(model.sectionItems('laboratory').map(item=>item.indicatorKey)).toEqual(['synthetic','new']);
  expect(model.pages.value.laboratory.cursor).toBeNull();
 });
 it('ignores late charts after member change and does not make the new member wait for them',async()=>{
  const pending=deferred<any>();let chartReads=0;
  request.mockImplementation(async(path:string,init?:RequestInit)=>{
   if(path==='trends/snapshot/charts'){chartReads++;return chartReads===1?pending.promise:snapshotParts([second],init);}
   return path.includes('memberId=new')?snapshotOverview([second]):snapshotOverview([first]);
  });
  await load();model.setChartVisible(model.series.value[0],true);await vi.advanceTimersByTimeAsync(31);
  member.value='new';await model.load('new');model.setChartVisible(model.series.value[0],true);await vi.advanceTimersByTimeAsync(31);
  expect(chartReads).toBe(2);expect(model.series.value[0].chartLoaded).toBe(true);
  pending.resolve({version:1,items:[{key:snapshotKey(first),data:[{numericValue:999}]}]});await flushPromises();
  expect(model.series.value.some(item=>item.indicatorKey==='synthetic')).toBe(false);
 });
 it('does not accept a prior query response after invalidation',async()=>{
  const pending=deferred<any>();let reads=0;
  request.mockImplementation(async()=>++reads===1?pending.promise:snapshotOverview([second]));
  const old=model.load('member');filters.value={query:'第二',group:'',attention:'all'};model.invalidate();await model.load('member',true);
  pending.resolve(snapshotOverview([first]));await old;
  expect(model.sectionItems('functional')[0].name).toBe('第二组');expect(model.pages.value.laboratory).toBeUndefined();
 });
 it('automatically aligns a version-conflicting group read with the new snapshot',async()=>{
  let reads=0;
  request.mockImplementation(async(path:string)=>{
   if(path.startsWith('trends/snapshot/series?'))throw new ApiRequestError('changed',{status:409});
   return snapshotOverview([first,second],[],++reads);
  });
  await load();await model.toggleSection('functional');
  expect(model.version.value).toBe(2);expect(model.sectionItems('laboratory')).toHaveLength(1);
 });
 it('retains readable content on chart failure and supports a local retry',async()=>{
  let fail=true;
  request.mockImplementation(async(path:string,init?:RequestInit)=>{
   if(path==='trends/snapshot/charts'){if(fail)throw new Error('offline');return snapshotParts([first],init);}
   return snapshotOverview([first]);
  });
  await load();model.setChartVisible(model.series.value[0],true);await vi.advanceTimersByTimeAsync(31);
  expect(model.chartErrors.value[snapshotKey(first)]).toBe('offline');expect(model.series.value[0].name).toBe(first.name);
  fail=false;model.retryChart(model.series.value[0]);await vi.advanceTimersByTimeAsync(31);
  expect(model.series.value[0].chartLoaded).toBe(true);
 });
 it('an explicit history read completes even when its chart leaves the viewport',async()=>{
  await load();const item=model.series.value[0];const history=model.ensureChart(item);
  model.setChartVisible(item,false);await vi.advanceTimersByTimeAsync(31);await history;
  expect(model.series.value[0].chartLoaded).toBe(true);
 });
 it('deduplicates detail reads and does not require loading other charts',async()=>{
  const pending=deferred<any>();request.mockImplementation(async(path:string)=>path==='trends/snapshot/details'?pending.promise:snapshotOverview([first]));
  await load();const one=model.ensureDetails(model.series.value[0]);const two=model.ensureDetails(model.series.value[0]);
  expect(calls('trends/snapshot/details')).toHaveLength(1);
  pending.resolve({version:1,items:[{key:snapshotKey(first),data:{excludedPoints:[]}}]});await one;await two;
  expect(model.series.value[0].detailLoaded).toBe(true);expect(calls('trends/snapshot/charts')).toHaveLength(0);
 });
 it('opens the first nonempty section after initial background construction finishes',async()=>{
  let overviewReads=0;
  request.mockImplementation(async(path:string)=>{
   if(path.startsWith('trends/snapshot/status?'))return {version:1,status:'ready'};
   if(++overviewReads===1)return {...snapshotOverview([]),version:null,status:'building'};
   return snapshotOverview([first]);
  });
  await load();expect(model.version.value).toBeNull();
  await vi.advanceTimersByTimeAsync(1501);await flushPromises();
  expect(model.version.value).toBe(1);expect(model.opened.value.has('laboratory')).toBe(true);
 });
 it('restores open sections and loaded extent on refresh, but stops if a subsequent page fails',async()=>{
  const overview=snapshotOverview([first]);overview.firstSection!.nextCursor='next';
  let failed=false;const extra={...first,indicatorKey:'extra'};
  request.mockImplementation(async(path:string)=>{
   if(path.startsWith('trends/snapshot/series?')){if(failed)throw new Error('page offline');return snapshotPage([extra]);}
   return overview;
  });
  await load();await model.loadSection('laboratory',true);expect(model.pages.value.laboratory.keys).toHaveLength(2);
  failed=true;await model.load('member',true);
  expect(model.pages.value.laboratory.error).toBe('page offline');expect(model.filtering.value).toBe(false);
 });
 it('keeps the rendered extent intact until a silent refresh has restored every open page',async()=>{
  const overview=snapshotOverview([first]);overview.firstSection!.nextCursor='next';
  const extra={...first,indicatorKey:'extra'};let restoring=false;
  const pending=deferred<any>();
  request.mockImplementation(async(path:string)=>path.startsWith('trends/snapshot/series?')
    ? restoring?pending.promise:snapshotPage([extra]):overview);
  await load();await model.loadSection('laboratory',true);
  const oldKeys=[...model.pages.value.laboratory.keys];
  restoring=true;const refresh=model.load('member',true);await flushPromises();
  expect(model.pages.value.laboratory.keys).toEqual(oldKeys);
  expect(model.sectionItems('laboratory')).toHaveLength(2);
  pending.resolve(snapshotPage([extra]));await refresh;
  expect(model.pages.value.laboratory.keys).toEqual(oldKeys);
 });
 it('does not publish a prepared refresh after the user changes member during restoration',async()=>{
  const overview=snapshotOverview([first]);overview.firstSection!.nextCursor='next';
  const extra={...first,indicatorKey:'extra'};let restoring=false;
  const pending=deferred<any>();
  request.mockImplementation(async(path:string)=>path.includes('memberId=new')?snapshotOverview([second]):path.startsWith('trends/snapshot/series?')
    ? restoring?pending.promise:snapshotPage([extra]):overview);
  await load();await model.loadSection('laboratory',true);restoring=true;
  const refresh=model.load('member',true);await flushPromises();
  member.value='new';await model.load('new');pending.resolve(snapshotPage([extra]));await refresh;
  expect(model.sectionItems('functional')[0].indicatorKey).toBe('second');
  expect(model.series.value.some(item=>item.indicatorKey==='extra')).toBe(false);
 });

 it('clears cached data when a periodic permission check denies access',async()=>{
  await load();
  request.mockImplementation(async()=>{throw new ApiRequestError('没有访问权限',{status:403});});
  await vi.advanceTimersByTimeAsync(15001);await flushPromises();
  expect(model.series.value).toHaveLength(0);expect(model.groups.value).toHaveLength(0);
  expect(model.version.value).toBeNull();expect(model.error.value).toBe('没有访问权限');
  expect(model.loading.value).toBe(false);
 });
 it('clears cached data on denied detail reads while network failures retain readable content',async()=>{
  await load();
  request.mockImplementation(async()=>{throw new ApiRequestError('记录已删除',{status:404});});
  await model.ensureDetails(model.series.value[0]);
  expect(model.series.value).toHaveLength(0);expect(model.version.value).toBeNull();
  expect(model.error.value).toBe('记录已删除');expect(model.detailPending.value.size).toBe(0);
 });

 it('opens search results independently of folds made under a previous query',async()=>{
  await load();await model.toggleSection('laboratory');
  await model.load('member',true);expect(model.opened.value.has('laboratory')).toBe(false);
  filters.value={query:'合成',group:'',attention:'all'};
  await model.load('member',true);expect(model.opened.value.has('laboratory')).toBe(true);
 });

 it('limits concurrent group reads and releases queued work when the member changes',async()=>{
  const fourth={...first,indicatorKey:'fourth',groupKey:'fourth',groupName:'第四组',groupOrder:4};
  const pending:Array<ReturnType<typeof deferred<any>>>=[];
  request.mockImplementation(async(path:string)=>{
    if(path.startsWith('trends/snapshot/series?')){const next=deferred<any>();pending.push(next);return next.promise;}
    return snapshotOverview([first,second,third,fourth]);
  });
  await load();
  const oldReads=[model.toggleSection('functional'),model.toggleSection('other'),model.toggleSection('fourth')];
  await flushPromises();expect(calls('trends/snapshot/series?')).toHaveLength(2);
  pending[0].resolve(snapshotPage([second]));await flushPromises();
  expect(calls('trends/snapshot/series?')).toHaveLength(3,'a finished read must dispatch the next queued group');
  member.value='new';await model.load('new');
  const newRead=model.toggleSection('functional');await flushPromises();
  expect(calls('trends/snapshot/series?')).toHaveLength(4,'aborted requests must not occupy the new member slots');
  pending[3].resolve(snapshotPage([second]));await newRead;
  pending[1].resolve(snapshotPage([third]));pending[2].resolve(snapshotPage([fourth]));await Promise.all(oldReads);
  expect(model.sectionItems('functional')[0].indicatorKey).toBe('second');
  expect(model.pages.value.fourth).toBeUndefined();
 });

});
