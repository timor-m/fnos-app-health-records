import {afterEach,beforeEach, expect, it, vi} from 'vitest';
import {flushPromises, shallowMount} from '@vue/test-utils';
import {ref} from 'vue';
import TrendsPage from '../src/pages/TrendsPage.vue';
import {snapshotOverview,snapshotPage,snapshotParts,sampleTrend,autoChartViewport} from './helpers/trend-snapshot';
const {request,context}=vi.hoisted(()=>({request:vi.fn(),context:{app:null as any}}));
vi.mock('../src/utils/api',async original=>({...await original<typeof import('../src/utils/api')>(),request,apiUrl:(path:string)=>path}));
vi.mock('../src/composables/useAppContext',()=>({useAppContext:()=>context.app}));
vi.mock('vue-router',()=>({useRoute:()=>({path:'/trends',query:{}})}));
beforeEach(()=>{
 vi.useFakeTimers();autoChartViewport();localStorage.clear();
 context.app={selectedMemberId:ref('member'),session:ref({isAdmin:false}),dataVersion:ref(0),
  setTopbarSubtitle:vi.fn(),clearTopbarSubtitle:vi.fn(),setTopbarSearch:vi.fn(),clearTopbarSearch:vi.fn()};request.mockReset();
});
afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers();});
const render=()=>shallowMount(TrendsPage,{global:{stubs:{RouterLink:true,Teleport:true}}});
const tree=[{key:'group',name:'合成分组',indicatorCount:1,configuredIndicatorCount:1,indicatorKeys:['synthetic'],children:[],searchText:'合成'}];
it('reads a snapshot overview once and sends group filtering to the server while retaining both unit variants',async()=>{
 const item=sampleTrend(['2','3']),items=[item,{...item,unit:'mg/L'},{...item,indicatorKey:'another',name:'另一个指标'}];
 request.mockImplementation(async(path:string,init?:RequestInit)=>{
  if(path==='trends/snapshot/charts')return snapshotParts(items,init);
  const query=new URLSearchParams(path.split('?')[1]);
  return snapshotOverview(query.get('group')==='group'?items.slice(0,2):items,tree);
 });
 const wrapper=render();try{
  await flushPromises();expect(wrapper.findAll('.trend-card')).toHaveLength(3);
  const reads=()=>request.mock.calls.filter(([path])=>path.startsWith('trends/snapshot?'));
  expect(reads()).toHaveLength(1);
  wrapper.findComponent({name:'TrendGroupFilter'}).vm.$emit('update:modelValue','group');
  await vi.advanceTimersByTimeAsync(251);await flushPromises();
  expect(reads()).toHaveLength(2);expect(reads()[1][0]).toContain('group=group');
  expect(wrapper.findAll('.trend-card')).toHaveLength(2);
  wrapper.findComponent({name:'TrendGroupFilter'}).vm.$emit('update:modelValue','');
  await vi.advanceTimersByTimeAsync(251);await flushPromises();expect(wrapper.findAll('.trend-card')).toHaveLength(3);
  expect(request.mock.calls.some(([path])=>path.startsWith('trends?')||path.startsWith('trends/groups'))).toBe(false);
 }finally{wrapper.unmount();}
});
it('searches the full server snapshot and uses server counts rather than the loaded card count',async()=>{
 const initial=sampleTrend(['2']),target={...initial,indicatorKey:'elsewhere',name:'未展开分组指标',groupKey:'functional',groupName:'功能检查'};
 request.mockImplementation(async(path:string,init?:RequestInit)=>{
  if(path==='trends/snapshot/charts')return snapshotParts([initial,target],init);
  if(path.includes('query=' ) && new URLSearchParams(path.split('?')[1]).get('query')){
   const result=snapshotOverview([target],tree);result.total=37;result.sections[0].count=37;return result;
  }
  return snapshotOverview([initial],tree);
 });
 const wrapper=render();try{
  await flushPromises();expect(wrapper.text()).not.toContain(target.name);
  await wrapper.get('input[placeholder="搜索指标名"]').setValue('未展开');
  await vi.advanceTimersByTimeAsync(251);await flushPromises();
  expect(wrapper.text()).toContain(target.name);expect(wrapper.text()).toContain('共 37 项');
  expect(request.mock.calls.some(([path])=>path.includes('query=%E6%9C%AA%E5%B1%95%E5%BC%80'))).toBe(true);
 }finally{wrapper.unmount();}
});
it('ignores a late overview for the previous member',async()=>{
 let finish!:(value:unknown)=>void;
 request.mockImplementation(async(path:string)=>{
  if(path.startsWith('trends/snapshot?')&&path.includes('memberId=member&'))return new Promise(resolve=>finish=resolve);
  return snapshotOverview([{...sampleTrend(['4']),name:'当前成员指标'}],tree);
 });
 const wrapper=render();try{
  await flushPromises();context.app.selectedMemberId.value='current';await flushPromises();expect(wrapper.text()).toContain('当前成员指标');
  finish(snapshotOverview([{...sampleTrend(['2']),name:'旧成员指标'}]));await flushPromises();expect(wrapper.text()).not.toContain('旧成员指标');
 }finally{wrapper.unmount();}
});
it('defers maintenance statistics until the first snapshot is usable',async()=>{
 context.app.session.value={isAdmin:true};let finish!:(value:unknown)=>void;
 request.mockImplementation(async(path:string)=>{
  if(path.startsWith('trends/snapshot?'))return new Promise(resolve=>finish=resolve);
  if(path==='maintenance/indicator-normalization/metrics')return {totals:{issueGroups:3}};
  return [];
 });
 const wrapper=render();try{
  await flushPromises();expect(wrapper.find('.loading-list').exists()).toBe(true);
  expect(request.mock.calls.some(([path])=>path==='maintenance/indicator-normalization/metrics')).toBe(false);
  finish(snapshotOverview([sampleTrend(['2'])],tree));await flushPromises();await flushPromises();
  expect(wrapper.find('.loading-list').exists()).toBe(false);
  expect(request.mock.calls.filter(([path])=>path==='maintenance/indicator-normalization/metrics')).toHaveLength(1);
  expect(wrapper.find('.trend-admin-issue-entry').exists()).toBe(true);
 }finally{wrapper.unmount();}
});


it('centers initial group loading when every group was collapsed',async()=>{
 const first=sampleTrend(['2']),second={...first,indicatorKey:'second',name:'另一组指标',groupKey:'functional',groupName:'功能检查',groupOrder:2};
 let finish!:(value:unknown)=>void;
 request.mockImplementation(async(path:string,init?:RequestInit)=>path==='trends/snapshot/charts'?snapshotParts([first,second],init)
  :path.startsWith('trends/snapshot/series?')?new Promise(resolve=>finish=resolve):snapshotOverview([first,second]));
 const wrapper=render();try{
  await flushPromises();await wrapper.findAll('.trend-section-header')[0].trigger('click');
  expect(wrapper.findAll('.trend-section-body')).toHaveLength(0);
  await wrapper.findAll('.trend-section-header')[1].trigger('click');await flushPromises();
  expect(wrapper.get('.trend-group-loading').text()).toContain('正在读取分组');
  expect(wrapper.find('.trend-next-group-sentinel').exists()).toBe(false);
  expect(wrapper.find('.trend-filter-mask').exists()).toBe(false);
  finish(snapshotPage([second]));await flushPromises();
  expect(wrapper.find('.trend-group-loading').exists()).toBe(false);expect(wrapper.text()).toContain(second.name);
 }finally{wrapper.unmount();}
});

it('keeps filters above the mask and scrolls after results render before hiding it',async()=>{
 const first=sampleTrend(['2']),target={...first,name:'目标指标'};
 let finish!:(value:unknown)=>void;
 request.mockImplementation(async(path:string,init?:RequestInit)=>path==='trends/snapshot/charts'?snapshotParts([first,target],init)
  :new URLSearchParams(path.split('?')[1]).get('query')?new Promise(resolve=>finish=resolve):snapshotOverview([first]));
 const wrapper=render(),previous=Object.getOwnPropertyDescriptor(window,'scrollY');
 const scroll=vi.spyOn(window,'scrollTo').mockImplementation(()=>{
  expect(wrapper.text()).toContain(target.name);
  expect(wrapper.find('.trend-filter-mask').exists()).toBe(true);
  Object.defineProperty(window,'scrollY',{configurable:true,value:0});
 });
 try{
  await flushPromises();Object.defineProperty(window,'scrollY',{configurable:true,value:600});
  await wrapper.get('input[placeholder="搜索指标名"]').setValue('目标');
  expect(wrapper.get('.trend-filter-row').classes()).toContain('trend-filter-pending');
  expect(wrapper.find('.trend-filter-mask').exists()).toBe(true);
  expect(wrapper.get('input[placeholder="搜索指标名"]').attributes('disabled')).toBeUndefined();
  await vi.advanceTimersByTimeAsync(251);await flushPromises();
  expect(scroll).not.toHaveBeenCalled();expect(wrapper.text()).toContain(first.name);
  finish(snapshotOverview([target]));await flushPromises();
  expect(scroll).toHaveBeenCalledWith({top:0,behavior:'instant'});
  expect(wrapper.find('.trend-filter-mask').exists()).toBe(false);
 }finally{wrapper.unmount();scroll.mockRestore();if(previous)Object.defineProperty(window,'scrollY',previous);}
});

it('does not let an older search hide the mask for a newer search',async()=>{
 const first=sampleTrend(['2']);const pending=new Map<string,(value:unknown)=>void>();
 request.mockImplementation(async(path:string,init?:RequestInit)=>{
  if(path==='trends/snapshot/charts')return snapshotParts([first],init);
  const query=new URLSearchParams(path.split('?')[1]).get('query');
  return query?new Promise(resolve=>pending.set(query,resolve)):snapshotOverview([first]);
 });
 const wrapper=render();try{
  await flushPromises();const input=wrapper.get('input[placeholder="搜索指标名"]');
  await input.setValue('旧');await vi.advanceTimersByTimeAsync(251);
  await input.setValue('新');await vi.advanceTimersByTimeAsync(251);
  pending.get('旧')!(snapshotOverview([first]));await flushPromises();
  expect(wrapper.find('.trend-filter-mask').exists()).toBe(true);
  pending.get('新')!(snapshotOverview([first]));await flushPromises();
  expect(wrapper.find('.trend-filter-mask').exists()).toBe(false);
 }finally{wrapper.unmount();}
});

it('clears dropdown filtering feedback on failure without scrolling away from readable results',async()=>{
 const first=sampleTrend(['2']);let fail=false;
 request.mockImplementation(async(path:string,init?:RequestInit)=>{
  if(path==='trends/snapshot/charts')return snapshotParts([first],init);
  if(fail)throw new Error('筛选失败');return snapshotOverview([first],tree);
 });
 const wrapper=render(),scroll=vi.spyOn(window,'scrollTo');
 try{
  await flushPromises();fail=true;
  wrapper.findComponent({name:'TrendGroupFilter'}).vm.$emit('update:modelValue','group');await flushPromises();
  expect(wrapper.find('.trend-filter-mask').exists()).toBe(true);
  await vi.advanceTimersByTimeAsync(251);await flushPromises();
  expect(wrapper.find('.trend-filter-mask').exists()).toBe(false);
  expect(wrapper.text()).toContain('筛选失败');expect(wrapper.text()).toContain(first.name);
  expect(scroll).not.toHaveBeenCalled();
 }finally{wrapper.unmount();scroll.mockRestore();}
});
