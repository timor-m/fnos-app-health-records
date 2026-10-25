import RecordLoading from '../src/components/RecordLoading.vue';
import { beforeEach,afterEach,expect,it,vi } from 'vitest';
import { DOMWrapper,mount,flushPromises } from '@vue/test-utils';
import {ref} from 'vue';
import AssociationModal from '../src/components/HealthRecordAssociationModal.vue';
import HealthProcessFollowups from '../src/components/HealthProcessFollowups.vue';
const mocks=vi.hoisted(()=>({request:vi.fn(),toast:vi.fn(),context:null as any}));
vi.mock('../src/utils/api',()=>({request:mocks.request}));
vi.mock('../src/composables/useAppContext',()=>({useAppContext:()=>mocks.context}));
vi.mock('../src/composables/useToast',()=>({useToast:()=>({show:mocks.toast})}));
vi.mock('../src/composables/useRefreshOnActivate',()=>({useRefreshOnActivate:()=>{}}));
const link={name:'RouterLink',props:['to'],template:'<a><slot/></a>'};
const picker={props:['modelValue'],emits:['update:modelValue'],template:'<input :value="modelValue" @input="$emit(\'update:modelValue\',$event.target.value)" />'};
const reminder=(id='planned',extra={})=>({id,memberId:'member',title:'合成复查',dueAt:'2026-11-01',status:'pending',source:'manual',reportId:null,reportTitle:null,reportHospitalName:null,reportIssuedAt:null,processes:[{id:'process',title:'合成过程'}],relatedRecord:{kind:'report',id:'source-report'},...extra});
let rows:any[]=[];let wrapper:ReturnType<typeof mount>;
beforeEach(()=>{vi.clearAllMocks();rows=[reminder()];mocks.context={selectedMemberId:ref('member'),selectedMember:ref({permission:'manager'}),members:ref([]),notifyDataChanged:vi.fn(),refreshReminderCount:vi.fn()};mocks.request.mockImplementation(async(path:string,options?:any)=>{
 if(!options)return rows;
 if(options.method==='PUT'){const input=JSON.parse(options.body);rows=rows.map(r=>({...r,...input}));return {};}
 return {};
});});
afterEach(()=>wrapper?.unmount());
async function open(props={memberId:'member',processId:'process',anchorRecord:{kind:'report',id:'source-report'}}){wrapper=mount(HealthProcessFollowups,{props,global:{stubs:{RouterLink:link,DateTimePicker:picker,ReportDetailModal:true,HealthRecordAssociationModal:true}}});await flushPromises();}
const button=(text:string)=>new DOMWrapper(document.body).findAll('button').concat(wrapper.findAll('button')).find(b=>b.text()===text)!;
const reschedule=()=>new DOMWrapper(document.body).get('.followup-reschedule');
async function chooseReport(){await button('记录复查').trigger('click');await flushPromises();await button('选择已有报告').trigger('click');await flushPromises();}
it('routes a planned follow-up through the real source record without creating a record early',async()=>{
 await open();await button('记录复查').trigger('click');await flushPromises();const links=wrapper.findAllComponents(link);
 expect(links.find(l=>l.text()==='上传新资料')!.props('to')).toEqual({path:'/upload',query:{memberId:'member',reminderId:'planned',relatedKind:'report',relatedId:'source-report',returnTo:'/health-processes/process'}});
 expect(links.some(l=>l.text()==='无报告记录')).toBe(false);
 expect(mocks.request.mock.calls.every(([,options])=>!options)).toBe(true);
});
it('creates a scoped future reminder, without creating a future record',async()=>{
 await open();await button('添加提醒').trigger('click');const form=new DOMWrapper(document.body).get('.followup-create-form');
 await form.findAll('input')[0].setValue('合成待办');await form.findAll('input')[1].setValue('2026-12-01');await form.trigger('submit');await flushPromises();
 const post=mocks.request.mock.calls.find(([,options])=>options?.method==='POST')!;
 expect(post[0]).toBe('reminders');expect(JSON.parse(post[1].body)).toEqual({memberId:'member',title:'合成待办',dueAt:'2026-12-01',relatedRecord:{kind:'report',id:'source-report'}});
});
it('reschedules, marks completed manually and restores, while showing whether an actual record is linked',async()=>{
 await open();await button('延期').trigger('click');await reschedule().get('input').setValue('2026-12-03');await reschedule().trigger('submit');await flushPromises();
 let puts=mocks.request.mock.calls.filter(([,options])=>options?.method==='PUT');expect(JSON.parse(puts[0][1].body)).toEqual({status:'pending',dueAt:'2026-12-03'});
 await button('手工标记完成').trigger('click');await flushPromises();await wrapper.get('.followup-history-toggle').trigger('click');expect(wrapper.text()).toContain('已完成 · 手工标记');
 await button('恢复待处理').trigger('click');await flushPromises();expect(wrapper.text()).toContain('记录复查');
 rows=[reminder('planned',{status:'completed',completedRecord:{kind:'report',id:'actual'}})];await (wrapper.vm as any).refresh();await flushPromises();
 expect(wrapper.text()).toContain('已完成 · 已关联复查记录');expect(wrapper.findAllComponents(link).find(l=>l.text()==='复查资料')!.props('to')).toBe('/events/detail/report/actual');
});
it('viewer has report and context links but no mutation controls',async()=>{
 mocks.context.selectedMember.value={permission:'viewer'};rows=[reminder('planned',{reportId:'report'})];await open();
 expect(wrapper.text()).toContain('来源记录');expect(wrapper.text()).toContain('来源记录');
 for(const text of ['添加提醒','记录复查','无报告记录','延期','手工标记完成','忽略'])expect(wrapper.findAll('button,a').some(n=>n.text()===text)).toBe(false);
});
it('ignores late previous-member responses and clears previous form and report preview',async()=>{
 let oldResolve:(value:unknown)=>void=()=>{};mocks.request.mockImplementationOnce(()=>new Promise(resolve=>{oldResolve=resolve;}));
 wrapper=mount(HealthProcessFollowups,{props:{memberId:'old'},global:{stubs:{RouterLink:link,DateTimePicker:picker,ReportDetailModal:true,HealthRecordAssociationModal:true}}});
 rows=[reminder('new',{memberId:'member'})];await wrapper.setProps({memberId:'member'});await flushPromises();oldResolve([reminder('old',{title:'旧成员记录',memberId:'old'})]);await flushPromises();
 expect(wrapper.text()).not.toContain('旧成员记录');expect(wrapper.find('[data-reminder=new]').exists()).toBe(true);
});
it('does not close the new member form when a previous member save finishes',async()=>{
 await open();await button('添加提醒').trigger('click');await new DOMWrapper(document.body).get('.followup-create-form input').setValue('旧草稿');await new DOMWrapper(document.body).get('.followup-create-form').findAll('input')[1].setValue('2026-12-01');
 let finish:()=>void=()=>{};mocks.request.mockImplementationOnce(()=>new Promise(resolve=>{finish=()=>resolve({});}));
 await new DOMWrapper(document.body).get('.followup-create-form').trigger('submit');mocks.context.selectedMemberId.value='new';
 await wrapper.setProps({memberId:'new',processId:undefined});await flushPromises();await button('添加提醒').trigger('click');await new DOMWrapper(document.body).get('.followup-create-form input').setValue('新草稿');
 finish();await flushPromises();expect((new DOMWrapper(document.body).get('.followup-create-form input').element as HTMLInputElement).value).toBe('新草稿');expect(mocks.toast).not.toHaveBeenCalled();
});

it('completed vaccinations link the actual dose and cannot be reopened as an unfilled reminder',async()=>{
 rows=[reminder('vaccine',{status:'completed',vaccinationId:'first-dose',completedVaccinationId:'second-dose'})];
 await open({memberId:'member',processId:undefined} as any);await wrapper.get('.followup-history-toggle').trigger('click');
 expect(wrapper.text()).toContain('已完成 · 已关联接种');expect(wrapper.text()).toContain('本次接种');
 for(const label of ['恢复待处理','记录复查','无报告记录','填写下一剂接种'])expect(wrapper.findAll('button,a').some(item=>item.text()===label)).toBe(false);
});

it('compact process view shows pending plans with completion and ignore actions directly',async()=>{
 rows=[reminder('pending'),reminder('done',{status:'completed'}),reminder('other',{processes:[{id:'other'}]})];
 await open({memberId:'member',processId:'process',compact:true} as any);
 expect(wrapper.classes()).toContain('is-compact');expect(wrapper.findAll('[data-reminder]')).toHaveLength(1);
 expect(wrapper.find('details').exists()).toBe(false);expect(button('手工标记完成').exists()).toBe(true);expect(button('忽略').exists()).toBe(true);
 await button('延期').trigger('click');
 expect(document.querySelector('.followup-reschedule')).not.toBeNull();await button('取消').trigger('click');await button('记录复查').trigger('click');await flushPromises();expect(wrapper.findAllComponents(link).find(l=>l.text()==='上传新资料')!.props('to').query.returnTo).toBe('/health-processes/process');
});

it('compact empty content retains its heading, empty state and create action',async()=>{
 rows=[];await open({memberId:'member',processId:'process',compact:true} as any);expect(wrapper.find('.health-followups').exists()).toBe(true);expect(wrapper.text()).toContain('暂无复查与待办');expect(button('添加提醒').exists()).toBe(true);
 (wrapper.vm as any).openCreate();await flushPromises();expect(document.querySelector('.followup-create-form')).not.toBeNull();expect(wrapper.find('.followup-heading').exists()).toBe(true);
});
it('completed plans are folded in the process and retain linked-result versus manual-completion labels',async()=>{
 rows=[reminder('done',{status:'completed',completedRecord:{kind:'report',id:'result'}}),reminder('manual',{status:'completed'})];await open({memberId:'member',processId:'process',compact:true} as any);
 expect(wrapper.findAll('[data-reminder]')).toHaveLength(0);await wrapper.get('.followup-history-toggle').trigger('click');expect(wrapper.findAll('[data-reminder]')).toHaveLength(2);expect(wrapper.text()).toContain('已完成 · 手工标记');expect(wrapper.text()).toContain('已完成 · 已关联复查记录');
});
it('existing report selection is single-report, revision checked, retry safe and refreshes the completed result',async()=>{
 await open({memberId:'member',processId:'process',processFingerprint:'source-v1',processEditToken:'edit-v1',compact:true} as any);await chooseReport();
 const dialog=wrapper.getComponent(AssociationModal);expect(dialog.props()).toMatchObject({reportOnly:true,maxSelections:1,title:'选择复查报告'});
 mocks.request.mockRejectedValueOnce(Error('合成保存失败'));dialog.vm.$emit('confirm',[{kind:'report',id:'result'}]);await flushPromises();expect(dialog.props('error')).toContain('合成保存失败');
 mocks.request.mockImplementationOnce(async()=>{rows=[reminder('planned',{status:'completed',completedRecord:{kind:'report',id:'result'}})];return {id:'planned',memberId:'member',status:'completed',completedRecord:{kind:'report',id:'result'},processId:'merged'};});
 dialog.vm.$emit('confirm',[{kind:'report',id:'result'}]);await flushPromises();const posts=mocks.request.mock.calls.filter(([,options])=>options?.method==='POST');expect(posts).toHaveLength(2);const inputs=posts.map(([,options])=>JSON.parse(options.body));expect(inputs[0]).toMatchObject({memberId:'member',record:{kind:'report',id:'result'},processId:'process',fingerprint:'source-v1',editToken:'edit-v1'});expect(inputs[0].requestKey).toBe(inputs[1].requestKey);
 expect(wrapper.findComponent(AssociationModal).exists()).toBe(false);expect(wrapper.text()).toContain('已关联复查记录');expect(wrapper.emitted('completed')).toEqual([['merged']]);
});
it('report completion ignores a late response after member or process scope changes',async()=>{
 await open();await chooseReport();let finish!:(value:unknown)=>void;mocks.request.mockReturnValueOnce(new Promise(done=>finish=done));wrapper.getComponent(AssociationModal).vm.$emit('confirm',[{kind:'report',id:'result'}]);await flushPromises();
 await wrapper.setProps({processId:'other-process'});await flushPromises();finish({id:'planned',memberId:'member',status:'completed',completedRecord:{kind:'report',id:'result'},processId:'old'});await flushPromises();expect(wrapper.emitted('completed')).toBeUndefined();expect(mocks.toast).not.toHaveBeenCalled();
});

it('creates reminders in a separate compact dialog with shortcuts and a selectable source',async()=>{
 await open({...{memberId:'member',processId:'process',anchorRecord:{kind:'report',id:'source-report'}},sourceRecords:[{ref:{kind:'report',id:'source-report'},title:'合成初诊资料',date:'2026-01-01'},{ref:{kind:'report',id:'second'},title:'合成复诊资料',date:'2026-01-02'}]} as any);
 await button('添加提醒').trigger('click');await flushPromises();const dialog=new DOMWrapper(document.body).get('.process-editor-modal');expect(dialog.attributes('aria-label')).toBe('添加复查与待办');expect(wrapper.find('.reminder-form').exists()).toBe(false);expect(document.body.style.overflow).toBe('hidden');
 await dialog.findAll('.followup-shortcuts button').find(button=>button.text()==='复诊')!.trigger('click');await dialog.findAll('.followup-shortcuts button').find(button=>button.text()==='7 天后')!.trigger('click');expect((dialog.findAll('input')[1].element as HTMLInputElement).value).toMatch(/^\d{4}-\d{2}-\d{2}$/);
 const select=wrapper.findComponent({name:'FormSelect'});select.vm.$emit('update:modelValue','report:second');await flushPromises();await dialog.get('form').trigger('submit');await flushPromises();const post=mocks.request.mock.calls.find(([,options])=>options?.method==='POST')!;expect(JSON.parse(post[1].body)).toMatchObject({title:'复诊',relatedRecord:{kind:'report',id:'second'}});expect(document.querySelector('.followup-create-form')).toBeNull();expect(document.body.style.overflow).toBe('');
});
it('keeps a failed creation draft and displays the error inside the dialog',async()=>{
 await open();await button('添加提醒').trigger('click');const dialog=new DOMWrapper(document.body).get('.process-editor-modal');await dialog.get('input').setValue('合成失败草稿');await dialog.findAll('input')[1].setValue('2026-12-01');mocks.request.mockRejectedValueOnce(Error('合成提醒保存失败'));await dialog.get('form').trigger('submit');await flushPromises();expect(dialog.text()).toContain('合成提醒保存失败');expect((dialog.get('input').element as HTMLInputElement).value).toBe('合成失败草稿');
 mocks.context.selectedMember.value.permission='viewer';await flushPromises();expect(document.querySelector('.followup-create-form')).toBeNull();expect(document.body.style.overflow).toBe('');
});

it('keeps the module visible when all reminders are dismissed, including for viewers',async()=>{
 rows=[reminder('ignored',{status:'dismissed'})];mocks.context.selectedMember.value.permission='viewer';await open({memberId:'member',processId:'process',compact:true} as any);expect(wrapper.find('.health-followups').exists()).toBe(true);expect(wrapper.text()).toContain('暂无待处理事项');expect(wrapper.text()).toContain('已忽略 1 项');expect(wrapper.findAll('button').some(item=>item.text()==='添加提醒')).toBe(false);
});
it('clears unsaved state after successfully postponing a reminder',async()=>{
 await open();await button('延期').trigger('click');await reschedule().get('input').setValue('2026-12-03');await reschedule().trigger('submit');await flushPromises();expect(wrapper.find('.followup-reschedule').exists()).toBe(false);const event=new Event('beforeunload',{cancelable:true});window.dispatchEvent(event);expect(event.defaultPrevented).toBe(false);
});


it('expands all pending plans in place in date order without navigating to the inbox',async()=>{
 rows=[reminder('late',{dueAt:'2026-12-01'}),reminder('first',{dueAt:'2026-10-01'}),reminder('middle',{dueAt:'2026-11-01'}),reminder('last',{dueAt:'2027-01-01'})];
 await open({memberId:'member',processId:'process',compact:true} as any);
 expect(wrapper.findAll('[data-reminder]').map(row=>row.attributes('data-reminder'))).toEqual(['first','middle','late']);
 await button('查看全部 4 项待办').trigger('click');expect(wrapper.findAll('[data-reminder]')).toHaveLength(4);
 expect(wrapper.findAllComponents(link).some(link=>link.props('to')==='/reminders')).toBe(false);
});
it('keeps ignored plans accessible for restoration in their own collapsed group',async()=>{
 rows=[reminder('ignored',{status:'dismissed'})];await open({memberId:'member',processId:'process',compact:true} as any);
 expect(wrapper.findAll('[data-reminder]')).toHaveLength(0);
 await wrapper.get('.followup-history-toggle').trigger('click');await button('恢复待处理').trigger('click');await flushPromises();
 expect(mocks.request).toHaveBeenCalledWith('reminders/ignored',{method:'PUT',body:JSON.stringify({status:'pending'})});
});
it('opens postponement separately and keeps failed edits in that dialog',async()=>{
 await open();await button('延期').trigger('click');expect(wrapper.find('.followup-reschedule').exists()).toBe(false);
 await reschedule().get('input').setValue('2026-12-03');mocks.request.mockRejectedValueOnce(Error('合成延期失败'));await reschedule().trigger('submit');await flushPromises();
 expect(reschedule().text()).toContain('合成延期失败');expect((reschedule().get('input').element as HTMLInputElement).value).toBe('2026-12-03');
});

it('uses the shared centered loader initially and keeps existing reminders during refresh',async()=>{
 let finish!:(value:any[])=>void;mocks.request.mockReturnValueOnce(new Promise(resolve=>{finish=resolve;}));await open();
 expect(wrapper.getComponent(RecordLoading).props('label')).toBe('正在读取复查提醒…');finish(rows);await flushPromises();expect(wrapper.findComponent(RecordLoading).exists()).toBe(false);
 mocks.request.mockReturnValueOnce(new Promise(resolve=>{finish=resolve;}));const refreshing=(wrapper.vm as any).refresh();await flushPromises();
 expect(wrapper.findComponent(RecordLoading).exists()).toBe(false);expect(wrapper.find('[data-reminder=planned]').exists()).toBe(true);finish(rows);await refreshing;await flushPromises();
});

it('reuses the shared reminder snapshot and refreshes empty scoped results without flashing a loader',async()=>{
 wrapper=mount(HealthProcessFollowups,{props:{memberId:'member',processId:'process',initialLoad:Promise.resolve({processId:'process',memberId:'member',fingerprint:'source',reminders:{data:[]}} as any)},global:{stubs:{RouterLink:link,DateTimePicker:picker,ReportDetailModal:true,HealthRecordAssociationModal:true}}});await flushPromises();
 expect(mocks.request).not.toHaveBeenCalled();expect(wrapper.text()).toContain('暂无复查与待办');
 let finish!:(value:any[])=>void;mocks.request.mockReturnValueOnce(new Promise(resolve=>{finish=resolve;}));const refreshing=(wrapper.vm as any).refresh();await flushPromises();
 expect(mocks.request.mock.calls[0][0]).toBe('health-processes/process/followups');expect(wrapper.findComponent(RecordLoading).exists()).toBe(false);expect(wrapper.text()).toContain('暂无复查与待办');finish([]);await refreshing;
});
