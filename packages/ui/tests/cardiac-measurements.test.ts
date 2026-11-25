import {beforeEach,afterEach,expect,it,vi} from 'vitest';
import {shallowMount,flushPromises} from '@vue/test-utils';
import {ref} from 'vue';
import {snapshotOverview,snapshotParts,autoChartViewport,sampleTrend} from './helpers/trend-snapshot';
import TrendsPage from '../src/pages/TrendsPage.vue';
import {cardiacSeriesIdentity} from '../../shared/cardiac-measurements';
const {request,context}=vi.hoisted(()=>({request:vi.fn(),context:{app:null as any}}));
vi.mock('../src/utils/api',async original=>({...await original<typeof import('../src/utils/api')>(),request,apiUrl:(path:string)=>path}));
vi.mock('../src/composables/useAppContext',()=>({useAppContext:()=>context.app}));
vi.mock('../src/composables/useRefreshOnActivate',()=>({useRefreshOnActivate:()=>{}}));
vi.mock('vue-router',()=>({useRoute:()=>({path:'/trends',query:{}}),useRouter:()=>({push:vi.fn(),replace:vi.fn()})}));
beforeEach(()=>{request.mockReset();localStorage.clear();autoChartViewport();context.app={selectedMemberId:ref('member'),session:ref({isAdmin:false}),setTopbarSubtitle:vi.fn(),clearTopbarSubtitle:vi.fn(),setTopbarSearch:vi.fn(),clearTopbarSearch:vi.fn()};});
afterEach(()=>vi.unstubAllGlobals());
it('switches measurement contexts inside one card without mixing chart points and pins the selected published context',async()=>{
 let finishPin!:()=>void;
 const base=sampleTrend(['61','62','63']);
 const contexts=[['超声心动图','M型'],['超声心动图','二维Simpson双平面法'],['CT','M型'],['CT','二维Simpson双平面法']];
 const items=contexts.map(([mode,method],i)=>({...base,indicatorKey:cardiacSeriesIdentity('cardiac_lvef','left_ventricle',mode,method),name:`左室射血分数 · ${mode} · ${method}`,unit:'%',chartLoaded:true,points:base.points.map((p,j)=>({...p,observationId:`context-${mode}-${method}-${j}`,numericValue:61+i*5+j,resultText:String(61+i*5+j)}))}));
 request.mockImplementation(async(path:string,init?:RequestInit)=>{
  if(path==='trends/pins')return new Promise(resolve=>{finishPin=()=>resolve({pinned:true});});
  if(path.startsWith('trends/snapshot?'))return snapshotOverview(items);
  if(path.startsWith('trends/snapshot/'))return snapshotParts(items,init);
  return {};
 });
 const wrapper=shallowMount(TrendsPage,{global:{stubs:{RouterLink:true}}});await flushPromises();
 try{
  expect(wrapper.findAll('.trend-card')).toHaveLength(1);
  const modeButtons=()=>wrapper.get('[aria-label="检查方式切换"]').findAll('button');
  const methodButtons=()=>wrapper.get('[aria-label="测量方法切换"]').findAll('button');
  expect(modeButtons()).toHaveLength(2);expect(methodButtons()).toHaveLength(2);
  for(let i=0;i<items.length;i++){
   await modeButtons()[Math.floor(i/2)].trigger('click');await flushPromises();
   await methodButtons()[i%2].trigger('click');await flushPromises();
   expect(wrapper.findAll('.trend-card')).toHaveLength(1);
   expect(modeButtons().filter(button=>button.attributes('aria-pressed')==='true')).toHaveLength(1);
   expect(methodButtons().filter(button=>button.attributes('aria-pressed')==='true')).toHaveLength(1);
   expect(methodButtons()[i%2].classes()).toContain('active');
   await wrapper.get('.trend-chart-scroll').trigger('focusin');await new Promise(resolve=>setTimeout(resolve,45));await flushPromises();
   expect(wrapper.findAll('.trend-chart-node')).toHaveLength(3);
   expect(wrapper.findAll('.trend-chart-value').map(node=>Number(node.text()))).toEqual(items[i].points.map(p=>p.numericValue));
   const calls=request.mock.calls.filter(([path])=>String(path).includes('/charts'));
   expect(calls.some(([,init])=>JSON.parse(String(init.body)).keys.includes(JSON.stringify([items[i].indicatorKey,'%'])))).toBe(true);
  }
  await wrapper.get('.trend-pin-button').trigger('click');await flushPromises();
  const pin=request.mock.calls.find(([path])=>path==='trends/pins');expect(JSON.parse(String(pin?.[1].body)).indicatorKey).toBe(items[3].indicatorKey);
  await modeButtons()[0].trigger('click');await flushPromises();
  expect(methodButtons()[1].classes()).toContain('active');
  expect(wrapper.get('.trend-pin-button').attributes('disabled')).toBeDefined();
  await wrapper.get('.trend-pin-button').trigger('click');expect(request.mock.calls.filter(([path])=>path==='trends/pins')).toHaveLength(1);
  finishPin();await flushPromises();
 }finally{wrapper.unmount();}
});

it('shows unresolved RV under its raw name and exposes pending context without merging the other RV card',async()=>{
 const base=sampleTrend(['21','23','22']);
 const raw={...base,indicatorKey:'institution:synthetic-raw-rv',kind:'institution',name:'右室常规',unit:'mm',measurementContextPending:true,comparable:false,comparabilityStatus:'insufficient_evidence',comparabilityReason:'口径待核对：按原始项目独立展示，不默认连线或判断涨跌',changeAssessmentAllowed:false,latestChangeConclusionAllowed:false,trendConclusionAllowed:false,delta:null};
 const other={...base,indicatorKey:cardiacSeriesIdentity('cardiac_rv_diameter_unspecified','right_ventricle','超声心动图',null),name:'右室内径（径线未注明）',unit:'mm'};
 request.mockImplementation(async(path:string,init?:RequestInit)=>{if(path.startsWith('trends/snapshot?'))return snapshotOverview([raw,other]);if(path.startsWith('trends/snapshot/'))return snapshotParts([raw,other],init);return {};});
 const wrapper=shallowMount(TrendsPage,{global:{stubs:{RouterLink:true}}});await flushPromises();
 await wrapper.findAll('.trend-chart-scroll')[0]!.trigger('focusin');await new Promise(resolve=>setTimeout(resolve,45));await flushPromises();
 try{const cards=wrapper.findAll('.trend-card');expect(cards).toHaveLength(2);expect(cards[0].text()).toContain('右室常规');expect(cards[0].text()).toContain('口径待核对');expect(cards[0].text()).toContain('不自动判断涨跌');expect(cards[1].text()).toContain('右室内径');expect(cards[1].text()).not.toContain('原始项目独立展示');expect(cards[0].findAll('.trend-chart-node')).toHaveLength(3);expect(cards[0].findAll('polyline')).toHaveLength(0);expect(cards[0].text()).not.toContain('较上次 +');}finally{wrapper.unmount();}
});

it('only offers existing methods for each modality and falls back safely when the previous method is absent',async()=>{
 const contexts=[['超声心动图','M型'],['超声心动图','二维Simpson法'],['CT','容积法'],['','']];
 const items=contexts.map(([mode,method],i)=>({...sampleTrend([String(61+i)]),indicatorKey:cardiacSeriesIdentity('cardiac_lvef','left_ventricle',mode,method),name:`左室射血分数 · ${mode} · ${method}`,unit:'%'}));
 request.mockImplementation(async(path:string,init?:RequestInit)=>{if(path.startsWith('trends/snapshot?'))return snapshotOverview(items);if(path.startsWith('trends/snapshot/'))return snapshotParts(items,init);return {};});
 const wrapper=shallowMount(TrendsPage,{global:{stubs:{RouterLink:true}}});await flushPromises();
 const modes=()=>wrapper.get('[aria-label="检查方式切换"]').findAll('button');
 const methods=()=>wrapper.get('[aria-label="测量方法切换"]').findAll('button');
 try{
  await methods()[1].trigger('click');await flushPromises();expect(methods()[1].attributes('aria-pressed')).toBe('true');
  await modes()[1].trigger('click');await flushPromises();expect(wrapper.find('[aria-label="测量方法切换"]').exists()).toBe(false);
  await wrapper.get('.trend-chart-scroll').trigger('focusin');await new Promise(resolve=>setTimeout(resolve,45));await flushPromises();
  expect(wrapper.findAll('.trend-chart-value').map(b=>Number(b.text()))).toEqual([63]);
  await modes()[0].trigger('click');await flushPromises();expect(methods()).toHaveLength(2);expect(methods()[0].attributes('aria-pressed')).toBe('true');
  await modes()[2].trigger('click');await flushPromises();expect(modes()[2].text()).toBe('方式未注明');expect(wrapper.find('[aria-label="测量方法切换"]').exists()).toBe(false);
  expect(wrapper.findAll('.trend-card')).toHaveLength(1);
 }finally{wrapper.unmount();}
});


it.each([
 {contexts:[['超声心动图','M型'],['超声心动图','二维Simpson法']],showMode:false,showMethod:true},
 {contexts:[['超声心动图','M型'],['CT','容积法']],showMode:true,showMethod:false},
 {contexts:[['超声心动图','M型']],showMode:false,showMethod:false},
])('shows only dimensions with multiple options: $showMode / $showMethod',async({contexts,showMode,showMethod})=>{
 const items=contexts.map(([mode,method],i)=>({...sampleTrend([String(61+i)]),indicatorKey:cardiacSeriesIdentity('cardiac_lvef','left_ventricle',mode,method),name:`左室射血分数 · ${mode} · ${method}`,unit:'%'}));
 request.mockImplementation(async(path:string,init?:RequestInit)=>{if(path.startsWith('trends/snapshot?'))return snapshotOverview(items);if(path.startsWith('trends/snapshot/'))return snapshotParts(items,init);return {};});
 const wrapper=shallowMount(TrendsPage,{global:{stubs:{RouterLink:true}}});await flushPromises();
 try{
  expect(wrapper.find('[aria-label="检查方式切换"]').exists()).toBe(showMode);
  expect(wrapper.find('[aria-label="测量方法切换"]').exists()).toBe(showMethod);
  expect(wrapper.findAll('.trend-card')).toHaveLength(1);
  if(showMode || showMethod){
   await wrapper.get(`[aria-label="${showMode?'检查方式切换':'测量方法切换'}"]`).findAll('button')[1].trigger('click');await flushPromises();
  }
  await wrapper.get('.trend-chart-scroll').trigger('focusin');await new Promise(resolve=>setTimeout(resolve,45));await flushPromises();
  expect(wrapper.findAll('.trend-chart-value').map(b=>Number(b.text()))).toEqual([items.length>1?62:61]);
  expect(wrapper.find('[aria-label="检查方式切换"]').exists()).toBe(showMode);
  expect(wrapper.find('[aria-label="测量方法切换"]').exists()).toBe(showMethod);
 }finally{wrapper.unmount();}
});
