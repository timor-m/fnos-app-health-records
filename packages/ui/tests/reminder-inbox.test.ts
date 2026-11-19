import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {flushPromises,mount} from '@vue/test-utils';
import {ref} from 'vue';
import Inbox from '../src/components/ReminderInbox.vue';
const mocks=vi.hoisted(()=>({request:vi.fn(),context:null as any}));vi.mock('../src/utils/api',()=>({request:mocks.request}));
vi.mock('../src/composables/useAppContext',()=>({useAppContext:()=>mocks.context}));
vi.mock('../src/composables/useToast',()=>({useToast:()=>({show:vi.fn()})}));
const item=(id:string,extra={})=>({id,memberId:'member',title:'合成提醒 '+id,dueAt:'2026-11-01',status:'pending',source:'manual',...extra});
const link={name:'RouterLink',props:['to'],template:'<a><slot/></a>'};let wrapper:ReturnType<typeof mount>;
beforeEach(()=>{vi.clearAllMocks();mocks.context={selectedMemberId:ref('member'),selectedMember:ref({permission:'manager'}),notifyDataChanged:vi.fn(),refreshReminderCount:vi.fn()};});afterEach(()=>wrapper?.unmount());
it('keeps only basic status actions and plain source navigation',async()=>{
 mocks.request.mockResolvedValue([item('process',{processes:[{id:'p',title:'合成历程'}]}),item('report',{reportId:'r'})]);
 wrapper=mount(Inbox,{props:{memberId:'member'},global:{stubs:{RouterLink:link}}});await flushPromises();
 const links=wrapper.findAllComponents(link).map(entry=>entry.props('to'));
 expect(links).toContainEqual({path:'/health-processes/p',query:{memberId:'member',returnTo:'/reminders'}});
 expect(links).toContainEqual({path:'/events/detail/report/r',query:{memberId:'member',returnTo:'/reminders'}});
 expect(wrapper.find('form').exists()).toBe(false);
 expect(wrapper.text()).not.toContain('记录复查');expect(wrapper.text()).not.toContain('延期');
 await wrapper.findAll('button').find(b=>b.text()==='手工标记完成')!.trigger('click');await flushPromises();
 expect(mocks.request).toHaveBeenCalledWith('reminders/process',{method:'PUT',body:JSON.stringify({status:'completed'})});
});
it('hides writes from viewers',async()=>{
 mocks.context.selectedMember.value.permission='viewer';mocks.request.mockResolvedValue([item('r',{reportId:'report'})]);wrapper=mount(Inbox,{props:{memberId:'member'},global:{stubs:{RouterLink:link}}});await flushPromises();
 expect(wrapper.findAll('button')).toHaveLength(0);expect(wrapper.text()).toContain('查看来源');
});
it('discards previous member responses and shows an empty state instead of other member data',async()=>{
 let resolve!:(value:unknown)=>void;mocks.request.mockReturnValueOnce(new Promise(done=>{resolve=done;})).mockResolvedValue([]);wrapper=mount(Inbox,{props:{memberId:'old'},global:{stubs:{RouterLink:link}}});await wrapper.setProps({memberId:'member'});await flushPromises();resolve([item('old',{memberId:'old'})]);await flushPromises();expect(wrapper.text()).toContain('暂无复查与待办');expect(wrapper.text()).not.toContain('合成提醒 old');
});

it.each([['忽略','dismissed','pending'],['恢复待处理','pending','dismissed']])('saves basic %s action in inbox',async(label,status,initial)=>{
 mocks.request.mockResolvedValue([item('basic',{status:initial})]);wrapper=mount(Inbox,{props:{memberId:'member'},global:{stubs:{RouterLink:link}}});await flushPromises();
 await wrapper.findAll('button').find(button=>button.text()===label)!.trigger('click');await flushPromises();
 expect(mocks.request).toHaveBeenCalledWith('reminders/basic',{method:'PUT',body:JSON.stringify({status})});
});
