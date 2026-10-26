import {snapshotOverview} from './helpers/trend-snapshot';
import {beforeEach,describe,expect,it,vi} from 'vitest';
import {flushPromises,shallowMount} from '@vue/test-utils';
import {ref,nextTick} from 'vue';
import TrendsPage from '../src/pages/TrendsPage.vue';
const {request,context}=vi.hoisted(()=>({request:vi.fn(),context:{app:null as any}}));
vi.mock('../src/utils/api',async original=>({...await original<typeof import('../src/utils/api')>(),request,apiUrl:(path:string)=>path}));
vi.mock('../src/composables/useAppContext',()=>({useAppContext:()=>context.app}));
vi.mock('../src/composables/useRefreshOnActivate',()=>({useRefreshOnActivate:()=>{}}));
vi.mock('vue-router',()=>({useRoute:()=>({path:'/trends',query:{}})}));
beforeEach(()=>{
 context.app={selectedMemberId:ref('member-a'),session:ref({isAdmin:false}),setTopbarSubtitle:vi.fn(),clearTopbarSubtitle:vi.fn(),setTopbarSearch:vi.fn(),clearTopbarSearch:vi.fn()};
 request.mockReset();
 request.mockImplementation(async(path:string)=>path.startsWith('trends/pending?')?[{reportId:'report-a',reportTitle:'合成待核对报告',examinationCount:2,observationCount:4}]:snapshotOverview([]));
});
describe('trend page keeps confirmation prompts in overview',()=>{
 it('does not request or display the duplicate pending panel, including after member changes',async()=>{
  request.mockImplementation(async(path:string)=>{
   if(path.startsWith('trends/pending?'))throw new Error('Pending endpoint must not block trends');
   return snapshotOverview([]);
  });
  const wrapper=shallowMount(TrendsPage,{global:{stubs:{RouterLink:true}}});
  await flushPromises();
  expect(wrapper.find('.trend-pending-panel').exists()).toBe(false);
  expect(wrapper.find('.inline-panel-error').exists()).toBe(false);
  expect(wrapper.findComponent({name:'EmptyState'}).props('title')).toBe('暂无可比较指标');
  context.app.selectedMemberId.value='member-b';await nextTick();await flushPromises();
  expect(request.mock.calls.some(([path])=>path.startsWith('trends/pending?'))).toBe(false);
  expect(request.mock.calls.some(([path])=>path.startsWith('trends/snapshot?memberId=member-b'))).toBe(true);
  wrapper.unmount();
 });
});
