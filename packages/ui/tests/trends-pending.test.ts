import {beforeEach,describe,expect,it,vi} from 'vitest';
import {flushPromises,shallowMount} from '@vue/test-utils';
import {ref,nextTick} from 'vue';
import TrendsPage from '../src/pages/TrendsPage.vue';
const {request,context}=vi.hoisted(()=>({request:vi.fn(),context:{app:null as any}}));
vi.mock('../src/utils/api',()=>({request,apiUrl:(path:string)=>path}));
vi.mock('../src/composables/useAppContext',()=>({useAppContext:()=>context.app}));
vi.mock('../src/composables/useRefreshOnActivate',()=>({useRefreshOnActivate:()=>{}}));
vi.mock('vue-router',()=>({useRoute:()=>({path:'/trends',query:{}})}));
beforeEach(()=>{
 context.app={selectedMemberId:ref('member-a'),session:ref({isAdmin:false}),setTopbarSubtitle:vi.fn(),clearTopbarSubtitle:vi.fn(),setTopbarSearch:vi.fn(),clearTopbarSearch:vi.fn()};
 request.mockReset();
 request.mockImplementation(async(path:string)=>path.startsWith('trends/pending?')?[{reportId:'report-a',reportTitle:'合成待核对报告',examinationCount:2,observationCount:4}]:[]);
});
describe('pending examination entry in trends',()=>{
 it('opens a source report when every result is pending and no trend series exists',async()=>{
  const wrapper=shallowMount(TrendsPage,{global:{stubs:{RouterLink:true}}});await flushPromises();
  expect(wrapper.find('[aria-label="待确认检查"]').exists()).toBe(true);
  expect(wrapper.text()).toContain('2 次检查 · 4 项结果');
  await wrapper.get('.trend-pending-panel button').trigger('click');
  expect(wrapper.findComponent({name:'ReportDetailModal'}).props()).toMatchObject({open:true,reportId:'report-a'});
  wrapper.unmount();
 });
 it('clears previous member results immediately and ignores a late response after switching',async()=>{
  const wrapper=shallowMount(TrendsPage,{global:{stubs:{RouterLink:true}}});await flushPromises();
  let resolveOld!:(value:unknown)=>void;
  request.mockImplementation((path:string)=>path.includes('member-b')?new Promise(resolve=>{if(path.startsWith('trends/pending?'))resolveOld=resolve;else resolve([])}):Promise.resolve([]));
  context.app.selectedMemberId.value='member-b';await nextTick();
  expect(wrapper.text()).not.toContain('合成待核对报告');
  context.app.selectedMemberId.value='member-c';await flushPromises();
  resolveOld([{reportId:'late',reportTitle:'迟到的其他成员结果',examinationCount:1,observationCount:1}]);await flushPromises();
  expect(wrapper.text()).not.toContain('迟到的其他成员结果');
  expect(wrapper.find('[aria-label="待确认检查"]').exists()).toBe(false);
  wrapper.unmount();
 });
});
