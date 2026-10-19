import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {flushPromises,mount} from '@vue/test-utils';
import {createMemoryHistory,createRouter} from 'vue-router';
import Feedback from '../src/pages/settings/FeedbackSettingsPage.vue';
const mocks=vi.hoisted(()=>({request:vi.fn(),toast:vi.fn()}));
vi.mock('../src/utils/api',()=>({request:mocks.request}));
vi.mock('../src/composables/useAppContext',()=>({useAppContext:()=>({refreshReminderCount:vi.fn()})}));
vi.mock('../src/composables/useToast',()=>({useToast:()=>({show:mocks.toast})}));
vi.mock('../src/composables/useScrollLock',()=>({useScrollLock:()=>{}}));
const ticket={number:'B0001',title:'合成反馈',category:'problem',status:'received',version:1,description:'合成说明',createdAt:'2026-10-19',updatedAt:'2026-10-19',events:[],attachments:[]};
let wrapper:ReturnType<typeof mount>;
let detail:()=>Promise<unknown>;
const detailCalls=()=>mocks.request.mock.calls.filter(([path])=>path.startsWith('feedback/tickets/B0001'));
beforeEach(()=>{
 vi.clearAllMocks();detail=async()=>ticket;
 mocks.request.mockImplementation(async(path:string)=>{
  if(path.startsWith('feedback/tickets?'))return {items:[ticket],total:1};
  if(path.startsWith('feedback/tickets/B0001'))return detail();
  throw new Error('Unexpected synthetic request');
 });
});
afterEach(()=>wrapper?.unmount());
async function open(){
 const router=createRouter({history:createMemoryHistory(),routes:[{path:'/',component:Feedback}]});
 await router.push('/');await router.isReady();
 wrapper=mount(Feedback,{global:{plugins:[router],stubs:{SubPageHeader:true,FeedbackImageEditor:true}}});
 await flushPromises();await wrapper.get('.feedback-row').trigger('click');await flushPromises();
 expect(mocks.toast).not.toHaveBeenCalled();
}
it('acknowledges a pending refresh, prevents duplicates and confirms success even without changes',async()=>{
 await open();
 let finish!:(value:unknown)=>void;
 detail=()=>new Promise(resolve=>{finish=resolve;});
 const button=wrapper.get('button[aria-label="刷新进度"]');
 await button.trigger('click');
 expect(button.attributes('disabled')).toBeDefined();
 expect(button.attributes('aria-busy')).toBe('true');
 expect(button.attributes('aria-label')).toBe('正在刷新进度');
 expect(button.get('svg').classes()).toContain('spin-icon');
 await button.trigger('click');expect(detailCalls()).toHaveLength(2);
 finish(ticket);await flushPromises();
 expect(button.attributes('disabled')).toBeUndefined();
 expect(button.attributes('aria-busy')).toBe('false');
 expect(button.get('svg').classes()).not.toContain('spin-icon');
 expect(mocks.toast).toHaveBeenCalledExactlyOnceWith('处理进度已刷新');
});
it('shows errors without a success toast and permits a retry that updates progress',async()=>{
 await open();detail=async()=>{throw new Error('合成网络错误');};
 const button=wrapper.get('button[aria-label="刷新进度"]');
 await button.trigger('click');await flushPromises();
 expect(wrapper.get('[role="alert"]').text()).toBe('合成网络错误');
 expect(button.attributes('disabled')).toBeUndefined();expect(mocks.toast).not.toHaveBeenCalled();
 detail=async()=>({...ticket,status:'in_progress',version:2});
 await button.trigger('click');await flushPromises();
 expect(wrapper.find('[role="alert"]').exists()).toBe(false);
 expect(wrapper.get('.feedback-status').text()).toBe('处理中');
 expect(mocks.toast).toHaveBeenCalledExactlyOnceWith('处理进度已刷新');
});
