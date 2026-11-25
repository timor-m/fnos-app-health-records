import {beforeEach,afterEach,expect,it,vi} from 'vitest';
import {mount,shallowMount,flushPromises} from '@vue/test-utils';
import {ref} from 'vue';
import {snapshotOverview,snapshotParts,autoChartViewport,sampleTrend} from './helpers/trend-snapshot';
import BoneDensityEditor from '../src/components/BoneDensityEditor.vue';
import TrendsPage from '../src/pages/TrendsPage.vue';
import {boneSeriesIdentity} from '../../shared/bone-density';
const {request,context}=vi.hoisted(()=>({request:vi.fn(),context:{app:null as any}}));
vi.mock('../src/utils/api',async original=>({...await original<typeof import('../src/utils/api')>(),request,apiUrl:(path:string)=>path}));
vi.mock('../src/composables/useAppContext',()=>({useAppContext:()=>context.app}));
vi.mock('../src/composables/useRefreshOnActivate',()=>({useRefreshOnActivate:()=>{}}));
vi.mock('vue-router',()=>({useRoute:()=>({path:'/trends',query:{}}),useRouter:()=>({push:vi.fn(),replace:vi.fn()})}));
beforeEach(()=>{request.mockReset();localStorage.clear();autoChartViewport();context.app={selectedMemberId:ref('member'),session:ref({isAdmin:false}),setTopbarSubtitle:vi.fn(),clearTopbarSubtitle:vi.fn(),setTopbarSearch:vi.fn(),clearTopbarSearch:vi.fn()};});
afterEach(()=>vi.unstubAllGlobals());
it('adds optional DXA values in one version-checked request; failures keep the form',async()=>{
 const wrapper=mount(BoneDensityEditor,{props:{reportId:'r',sourceVersion:4,pages:[]},global:{stubs:{Teleport:true}}});
 await wrapper.get('input[aria-label="1 BMD"]').setValue('0.8');
 await wrapper.get('form').trigger('submit');await flushPromises();
 expect(request.mock.calls[0][0]).toBe('reports/r/bone-density');const body=JSON.parse(request.mock.calls[0][1].body);expect(body.expectedSourceVersion).toBe(4);expect(body.sites[0].dxa_z_score).toBe('');
 expect(wrapper.emitted('saved')).toHaveLength(1);
 request.mockRejectedValueOnce(new Error('报告已更新'));await wrapper.get('form').trigger('submit');await flushPromises();expect(wrapper.text()).toContain('报告已更新');expect((wrapper.get('input[aria-label="1 BMD"]').element as HTMLInputElement).value).toBe('0.8');wrapper.unmount();
});
it('keeps one card per site with stable position and separate units while switching metrics',async()=>{
 const base=sampleTrend(['1.1']);
 const items=['dxa_bmd','dxa_t_score','dxa_z_score'].map((metric,i)=>({...base,indicatorKey:boneSeriesIdentity(metric,'lumbar_l1','unspecified'),name:`DXA L1 ${metric}`,unit:i===0?'g/cm²':null,points:base.points.map(p=>({...p,numericValue:i===0?1.1:i===1?-1:0})),chartLoaded:true}));
 const ordinary={...base,indicatorKey:'hip_axis_length_left',name:'左侧髋关节中轴长度',unit:'mm'};
 const rightAxis={...ordinary,indicatorKey:'hip_axis_length_right',name:'右侧髋关节中轴长度'};
 request.mockImplementation(async(path:string,init?:RequestInit)=>{const all=[items[0],ordinary,rightAxis,...items.slice(1)];if(path.startsWith('trends/snapshot?'))return snapshotOverview(all);if(path.startsWith('trends/snapshot/'))return snapshotParts(all,init);return {};});
 const wrapper=shallowMount(TrendsPage,{global:{stubs:{RouterLink:true}}});await flushPromises();
 expect(wrapper.findAll('.trend-card')).toHaveLength(3);
 expect(wrapper.findAll('.trend-card')[1].find('[aria-label="骨密度测量值切换"]').exists()).toBe(false);
 expect(wrapper.findAll('.trend-card')[1].text()).toContain('mm');
 expect(wrapper.findAll('.trend-card')[1].text()).toContain('左侧髋关节中轴长度');
 expect(wrapper.findAll('.trend-card')[2].text()).toContain('右侧髋关节中轴长度');
 expect(wrapper.findAll('.trend-card')[2].find('[aria-label="骨密度测量值切换"]').exists()).toBe(false);
 const first=()=>wrapper.findAll('.trend-card')[0];expect(first().text()).toContain('g/cm²');
 await first().findAll('button').find(button=>button.text()==='T 值')!.trigger('click');await flushPromises();
 expect(wrapper.findAll('.trend-card')).toHaveLength(3);expect(first().text()).toContain('DXA · 腰椎 L1');expect(first().text()).toContain('无单位');expect(first().text()).not.toContain('g/cm²');
 await first().findAll('button').find(button=>button.text()==='Z 值')!.trigger('click');await flushPromises();expect(first().find('button[aria-pressed="true"]').text()).toBe('Z 值');wrapper.unmount();
});

it('keeps the site pin action pending when switching to another metric',async()=>{
 const base=sampleTrend(['1']);
 const items=['dxa_bmd','dxa_t_score','dxa_z_score'].map((metric,index)=>({...base,indicatorKey:boneSeriesIdentity(metric,'lumbar_l1','unspecified'),name:metric,unit:index===0?'g/cm²':null}));
 let resolvePin!:(value:unknown)=>void;
 const pending=new Promise(resolve=>{resolvePin=resolve;});
 request.mockImplementation(async(path:string,init?:RequestInit)=>{
  if(path==='trends/pins')return pending;
  if(path.startsWith('trends/snapshot?'))return snapshotOverview(items);
  if(path.startsWith('trends/snapshot/'))return snapshotParts(items,init);
  return {};
 });
 const wrapper=shallowMount(TrendsPage,{global:{stubs:{RouterLink:true}}});await flushPromises();
 await wrapper.get('.trend-pin-button').trigger('click');await flushPromises();
 await wrapper.find('.trend-card').findAll('button').find(button=>button.text()==='T 值')!.trigger('click');
 expect(wrapper.get('.trend-pin-button').attributes('disabled')).toBeDefined();
 await wrapper.get('.trend-pin-button').trigger('click');
 expect(request.mock.calls.filter(([path])=>path==='trends/pins')).toHaveLength(1);
 resolvePin({pinned:true});await flushPromises();wrapper.unmount();
});

it('keeps all seven left/right femoral cards separate and metric switching stays on the chosen side',async()=>{
 const sites=['femur_neck','femur_neck_upper','femur_neck_lower','femur_wards','femur_trochanter','femur_shaft','femur_total'];
 const metrics=['dxa_bmd','dxa_t_score','dxa_z_score'];
 const base=sampleTrend(['1']);
 const items=sites.flatMap(site=>['left','right'].flatMap(side=>metrics.map((metric,i)=>({...base,
  indicatorKey:boneSeriesIdentity(metric,site,side),name:`${side} ${site} ${metric}`,unit:i===0?'g/cm²':null,
  points:base.points.map(p=>({...p,observationId:`${side}-${site}-${metric}`,numericValue:side==='left'?1:2})),chartLoaded:true}))));
 request.mockImplementation(async(path:string,init?:RequestInit)=>{
  if(path.startsWith('trends/snapshot?'))return snapshotOverview(items);
  if(path.startsWith('trends/snapshot/'))return snapshotParts(items,init);
  return {};
 });
 const wrapper=shallowMount(TrendsPage,{global:{stubs:{RouterLink:true}}});await flushPromises();
 const cards=()=>wrapper.findAll('.trend-card');expect(cards()).toHaveLength(14);
 for(let i=0;i<7;i++){
  const left=cards()[i*2],right=cards()[i*2+1];
  expect(left.text()).toContain('左侧');expect(right.text()).toContain('右侧');
  await left.findAll('button').find(button=>button.text()==='T 值')!.trigger('click');await flushPromises();
  expect(cards()[i*2].find('button[aria-pressed="true"]').text()).toBe('T 值');
  expect(cards()[i*2+1].find('button[aria-pressed="true"]').text()).toBe('BMD');
  await right.findAll('button').find(button=>button.text()==='Z 值')!.trigger('click');await flushPromises();
  expect(cards()[i*2].find('button[aria-pressed="true"]').text()).toBe('T 值');expect(cards()[i*2+1].find('button[aria-pressed="true"]').text()).toBe('Z 值');
 }
 expect(cards()).toHaveLength(14);wrapper.unmount();
});

it('keeps bone method contexts in separate cards while each retains BMD/T/Z tabs',async()=>{
 const base=sampleTrend(['0.8']);
 const items=['合成方法A','合成方法B'].flatMap(method=>['dxa_bmd','dxa_t_score','dxa_z_score'].map((metric,i)=>({...base,indicatorKey:boneSeriesIdentity(metric,'femur_total','left','DXA',method),name:metric,unit:i===0?'g/cm²':null})));
 request.mockImplementation(async(path:string,init?:RequestInit)=>{if(path.startsWith('trends/snapshot?'))return snapshotOverview(items);if(path.startsWith('trends/snapshot/'))return snapshotParts(items,init);return {};});
 const wrapper=shallowMount(TrendsPage,{global:{stubs:{RouterLink:true}}});await flushPromises();
 try{
  const cards=()=>wrapper.findAll('.trend-card');expect(cards()).toHaveLength(2);expect(cards()[0].text()).toContain('合成方法a');expect(cards()[1].text()).toContain('合成方法b');
  await cards()[0].findAll('button').find(button=>button.text()==='T 值')!.trigger('click');await flushPromises();
  expect(cards()[0].find('button[aria-pressed="true"]').text()).toBe('T 值');expect(cards()[1].find('button[aria-pressed="true"]').text()).toBe('BMD');
 }finally{wrapper.unmount();}
});


it.each([
 ['dxa_bmd'],['dxa_t_score'],['dxa_z_score'],
 ['dxa_bmd','dxa_t_score'],['dxa_bmd','dxa_z_score'],['dxa_t_score','dxa_z_score'],
].map(metrics=>({metrics})))('only offers bone metrics with data and hides a single option: $metrics',async({metrics})=>{
 const labels:Record<string,string>={dxa_bmd:'BMD',dxa_t_score:'T 值',dxa_z_score:'Z 值'};
 const items=metrics.map(metric=>({...sampleTrend(metric==='dxa_bmd'?['0.8','0.9','0.85']:metric==='dxa_t_score'?['-1','-1.2','-1.1']:['0','0.1','0']),indicatorKey:boneSeriesIdentity(metric,'femur_total','right'),name:metric,unit:metric==='dxa_bmd'?'g/cm²':null}));
 const original=JSON.stringify(items);
 request.mockImplementation(async(path:string,init?:RequestInit)=>{if(path.startsWith('trends/snapshot?'))return snapshotOverview(items);if(path.startsWith('trends/snapshot/'))return snapshotParts(items,init);return {};});
 const wrapper=shallowMount(TrendsPage,{global:{stubs:{RouterLink:true}}});await flushPromises();
 try{
  expect(wrapper.findAll('.trend-card')).toHaveLength(1);
  expect(wrapper.find('[aria-label="骨密度测量值切换"]').exists()).toBe(metrics.length>1);
  if(metrics.length>1){
   const buttons=wrapper.get('[aria-label="骨密度测量值切换"]').findAll('button');
   expect(buttons.map(button=>button.text())).toEqual(metrics.map(metric=>labels[metric]));
   expect(buttons.every(button=>button.attributes('disabled')===undefined)).toBe(true);
  }
  for(let i=0;i<items.length;i++){
   if(metrics.length>1)await wrapper.get('[aria-label="骨密度测量值切换"]').findAll('button')[i].trigger('click');
   await wrapper.get('.trend-chart-scroll').trigger('focusin');await new Promise(resolve=>setTimeout(resolve,45));await flushPromises();
   expect(wrapper.findAll('.trend-chart-value').map(node=>Number(node.text()))).toEqual(items[i].points.map(point=>point.numericValue));
   expect(wrapper.findAll('.trend-card')).toHaveLength(1);
   expect(wrapper.text()).toContain('右侧股骨全部');
  }
  expect(JSON.stringify(items)).toBe(original);
 }finally{wrapper.unmount();}
});
