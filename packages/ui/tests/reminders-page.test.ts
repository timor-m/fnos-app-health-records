import {beforeEach,afterEach,expect,it,vi} from 'vitest';
import {mount,flushPromises} from '@vue/test-utils';
import {ref} from 'vue';
import {createRouter,createMemoryHistory} from 'vue-router';
import RemindersPage from '../src/pages/RemindersPage.vue';
const mocks=vi.hoisted(()=>({request:vi.fn(),context:null as any}));
vi.mock('../src/utils/api',()=>({request:mocks.request}));
vi.mock('../src/composables/useAppContext',()=>({useAppContext:()=>mocks.context}));
vi.mock('../src/composables/useRefreshOnActivate',()=>({useRefreshOnActivate:()=>{}}));
vi.mock('../src/composables/usePullRefresh',()=>({usePullRefresh:()=>({pullDistance:ref(0),refreshing:ref(false)})}));
vi.mock('../src/composables/useToast',()=>({useToast:()=>({show:vi.fn()})}));
let wrapper:ReturnType<typeof mount>;
beforeEach(()=>{vi.clearAllMocks();mocks.context={selectedMemberId:ref('first'),selectedMember:ref({permission:'manager'}),session:ref({isAdmin:true}),refreshReminderCount:vi.fn()};});
afterEach(()=>wrapper?.unmount());
it('renders current member notifications and rejects a late response after switching members',async()=>{
 let resolveFirst:(value:unknown)=>void=()=>{};
 mocks.request.mockImplementation((path:string)=>path.includes('first')?new Promise(resolve=>{resolveFirst=resolve;}):Promise.resolve([{id:'second-notice',memberId:'second',title:'合成新通知',type:'report_processed',severity:'info',status:'unread',createdAt:'2026-10-22',reportId:null}]));
 const router=createRouter({history:createMemoryHistory(),routes:[{path:'/',component:{template:'<div/>'}}]});await router.push('/');
 wrapper=mount(RemindersPage,{global:{plugins:[router],stubs:{ReminderInbox:true,PullIndicator:true,ReportDetailModal:true}}});
 mocks.context.selectedMemberId.value='second';await flushPromises();
 resolveFirst([{id:'first-notice',title:'旧成员通知',type:'report_failed',severity:'warning',status:'unread',createdAt:'2026-10-22'}]);await flushPromises();
 expect(wrapper.text()).toContain('合成新通知');expect(wrapper.text()).not.toContain('旧成员通知');
 expect(wrapper.findComponent({name:'ReminderInbox'}).props('memberId')).toBe('second');
});

it('routes report notifications to their record detail without mounting business forms',async()=>{
 mocks.request.mockResolvedValue([{id:'notice',memberId:'first',title:'合成处理完成',type:'report_processed',severity:'info',status:'unread',createdAt:'2026-10-22',reportId:'report'}]);const router=createRouter({history:createMemoryHistory(),routes:[{path:'/reminders',component:{template:'<div/>'}},{path:'/events/detail/report/:id',component:{template:'<div/>'}}]});await router.push('/reminders');wrapper=mount(RemindersPage,{global:{plugins:[router],stubs:{ReminderInbox:true,PullIndicator:true}}});await flushPromises();expect(wrapper.find('form').exists()).toBe(false);expect(wrapper.findComponent({name:'ReportDetailModal'}).exists()).toBe(false);await wrapper.findAll('button').find(button=>button.text()==='查看报告')!.trigger('click');await flushPromises();expect(router.currentRoute.value.path).toBe('/events/detail/report/report');expect(router.currentRoute.value.query.returnTo).toBe('/reminders');
});
