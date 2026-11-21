import { mount,flushPromises } from '@vue/test-utils';
import { beforeEach,afterEach,expect,it,vi } from 'vitest';
import { reactive,ref } from 'vue';
import Editor from '../src/components/VaccinationEditor.vue';
import Detail from '../src/components/VaccinationDetail.vue';
import NewPage from '../src/pages/NewVaccinationPage.vue';
import DateTimePicker from '../src/components/DateTimePicker.vue';
import FormSelect from '../src/components/FormSelect.vue';
import ReminderEditor from '../src/components/VaccinationReminderEditor.vue';
const mocks=vi.hoisted(()=>({request:vi.fn(),upload:vi.fn(),ask:vi.fn(),push:vi.fn(),replace:vi.fn()}));
const app={selectedMemberId:ref('member'),selectedMember:ref({id:'member',permission:'manager'}),notifyDataChanged:vi.fn()};
const route=reactive({path:'/add/vaccination',query:{} as Record<string,string>});
vi.mock('../src/utils/api',()=>({request:mocks.request,requestUpload:mocks.upload}));vi.mock('../src/composables/useAppContext',()=>({useAppContext:()=>app}));vi.mock('../src/composables/useConfirm',()=>({useConfirm:()=>({ask:mocks.ask})}));vi.mock('vue-router',()=>({useRoute:()=>route,useRouter:()=>({push:mocks.push,replace:mocks.replace}),RouterLink:{name:'RouterLink',props:['to'],template:'<a :href="to"><slot/></a>'}}));
const entry={id:'v1',memberId:'member',vaccineName:'合成疫苗',doseNumber:'1',administeredAt:'2026-01-01',organizationName:'合成机构',manufacturer:null,lotNumber:null,administrationSite:null,note:null,nextDueAt:'2026-02-01',reminderId:'reminder',completedReminderId:null,sourceReportId:null,sourceFactId:null,episodeId:null,revision:1,deletedAt:null};
const wrappers:any[]=[];function render(component:any,props:any={}){const wrapper=mount(component,{props,global:{stubs:{ReportDetail:{name:'ReportDetail',props:{reportId:String,expectedMemberId:String,originalsOnly:Boolean,hideTrashAction:Boolean},emits:['loaded'],template:'<div class="attachment-originals"/>'}}}});wrappers.push(wrapper);return wrapper;}
beforeEach(()=>{vi.clearAllMocks();mocks.upload.mockResolvedValue({...entry,sourceReportId:'new-original'});route.path='/add/vaccination';route.query={};app.selectedMemberId.value='member';app.selectedMember.value={id:'member',permission:'manager'};mocks.request.mockImplementation(async(path:string,options:any)=>options?.method?entry:path==='vaccinations/v1'?entry:path.startsWith('vaccinations/documents')?[{id:'document',title:'合成接种凭证'}]:path==='reports/document'?{id:'document',memberId:'member',vaccinations:[]}:[]);});
afterEach(()=>wrappers.splice(0).forEach(wrapper=>wrapper.unmount()));
async function fill(wrapper:any){await wrapper.get('input[required]').setValue('合成疫苗');wrapper.findAllComponents(DateTimePicker)[0].vm.$emit('update:modelValue','2026-01-01');await wrapper.vm.$nextTick();}
it('a vaccination added from a process submits the process identity without a baseline record',async()=>{
 route.query={memberId:'member',processId:'process',returnTo:'/health-processes/process'};const wrapper=render(NewPage);await flushPromises();const editor=wrapper.getComponent(Editor);expect(editor.props('processId')).toBe('process');expect(editor.text()).toContain('保存后加入当前健康历程');await fill(editor);await editor.get('form').trigger('submit');await flushPromises();
 const call=mocks.request.mock.calls.find(([path,options])=>path==='vaccinations'&&options?.method==='POST')!;expect(JSON.parse(call[1].body)).toMatchObject({processId:'process',relatedRecords:[]});
});
it('supports actual vaccination without any uploaded document or event',async()=>{const wrapper=render(Editor);await flushPromises();await fill(wrapper);await wrapper.get('form').trigger('submit');await flushPromises();const call=mocks.request.mock.calls.find(([path,options])=>path==='vaccinations'&&options?.method==='POST')!;expect(JSON.parse(call[1].body)).toMatchObject({memberId:'member',vaccineName:'合成疫苗',administeredAt:'2026-01-01',sourceReportId:null,sourceFactId:null});expect(wrapper.emitted('saved')?.[0][0]).toMatchObject({id:'v1'});});
it('can link an existing credential while preserving the real source fact',async()=>{const wrapper=render(Editor,{source:{...entry,sourceReportId:'document',sourceFactId:'fact'}});await flushPromises();await wrapper.get('form').trigger('submit');await flushPromises();const body=JSON.parse(mocks.request.mock.calls.find(([,options])=>options?.method==='POST')![1].body);expect(body.sourceReportId).toBe('document');expect(body.sourceFactId).toBe('fact');});
it('clears the old fact identity when the user selects another credential',async()=>{const wrapper=render(Editor,{source:{...entry,sourceReportId:'previous',sourceFactId:'previous-fact'}});await flushPromises();wrapper.findAllComponents(FormSelect).find(control=>control.props('ariaLabel')==='接种原件')!.vm.$emit('update:modelValue','document');await flushPromises();await fill(wrapper);await wrapper.get('form').trigger('submit');await flushPromises();const body=JSON.parse(mocks.request.mock.calls.find(([,options])=>options?.method==='POST')![1].body);expect(body.sourceFactId).toBeNull();expect(body.sourceReportId).toBe('document');});
it('editing submits its revision and never creates a second entry',async()=>{const wrapper=render(Editor,{entry});await flushPromises();await wrapper.get('form').trigger('submit');await flushPromises();const call=mocks.request.mock.calls.find(([,options])=>options?.method==='PATCH')!;expect(call[0]).toBe('vaccinations/v1');expect(JSON.parse(call[1].body).revision).toBe(1);expect(mocks.request.mock.calls.some(([,options])=>options?.method==='POST')).toBe(false);});
it('retains the same idempotency key and user input when retrying an unchanged failed save',async()=>{const wrapper=render(Editor);await flushPromises();await fill(wrapper);mocks.request.mockRejectedValueOnce(Error('保存中断'));await wrapper.get('form').trigger('submit');await flushPromises();expect(wrapper.get('[role="alert"]').text()).toContain('保存中断');await wrapper.get('form').trigger('submit');await flushPromises();const saves=mocks.request.mock.calls.filter(([,options])=>options?.method==='POST').map(([,options])=>JSON.parse(options.body));expect(saves).toHaveLength(2);expect(saves[0].requestKey).toBe(saves[1].requestKey);expect(saves[1].vaccineName).toBe('合成疫苗');});
it('late successful saves cannot navigate or notify another member',async()=>{const wrapper=render(Editor);await flushPromises();await fill(wrapper);let resolve!:(value:unknown)=>void;mocks.request.mockReturnValueOnce(new Promise(done=>resolve=done));await wrapper.get('form').trigger('submit');app.selectedMemberId.value='second';app.selectedMember.value={id:'second',permission:'manager'};await flushPromises();resolve(entry);await flushPromises();expect(wrapper.emitted('saved')).toBeUndefined();expect(app.notifyDataChanged).not.toHaveBeenCalled();});
it('only managers see edit and delete actions, while viewers can inspect the dose',async()=>{app.selectedMember.value.permission='viewer';const wrapper=render(Detail,{recordId:'v1'});await flushPromises();expect(wrapper.text()).toContain('合成疫苗');expect(wrapper.text()).not.toContain('编辑接种');expect(wrapper.text()).not.toContain('移入回收站');});
it('deletion requires an in-app confirmation and sends the exact revision',async()=>{const wrapper=render(Detail,{recordId:'v1'});await flushPromises();await wrapper.get('[aria-label="移入回收站"]').trigger('click');await flushPromises();expect(mocks.ask).toHaveBeenCalledOnce();expect(mocks.ask.mock.calls[0][0]).toMatchObject({title:'移入回收站',confirmText:'移入回收站',danger:true});expect(mocks.ask.mock.calls[0][0].message).toContain('保留 30 天');expect(mocks.ask.mock.calls[0][0].message).toContain('期间可以恢复');expect(mocks.ask.mock.calls[0][0].message).toContain('编辑接种');expect(mocks.ask.mock.calls[0][0].message).not.toContain('接种凭证');expect(mocks.request.mock.calls.some(([,options])=>options?.method==='DELETE')).toBe(false);await mocks.ask.mock.calls[0][0].run();await flushPromises();expect(mocks.request).toHaveBeenCalledWith('vaccinations/v1',{method:'DELETE',body:JSON.stringify({revision:1})});expect(wrapper.emitted('close')).toHaveLength(1);});
it('a next-dose reminder carries vaccine identity but never copies an already administered dose or old credential',async()=>{route.query={sourceVaccinationId:'v1',reminderId:'reminder'};const wrapper=render(NewPage);await flushPromises();const editor=wrapper.getComponent(Editor);expect(editor.props('source')).toMatchObject({vaccineName:'合成疫苗',completedReminderId:'reminder'});expect(editor.props('source').administeredAt).toBeUndefined();expect(editor.props('source').doseNumber).toBeUndefined();expect(editor.props('source').sourceReportId).toBeUndefined();});
it('refuses a reminder whose source entry belongs to another member',async()=>{route.query={sourceVaccinationId:'v1',reminderId:'reminder'};mocks.request.mockResolvedValueOnce({...entry,memberId:'second'});const wrapper=render(NewPage);await flushPromises();expect(wrapper.findComponent(Editor).exists()).toBe(false);expect(wrapper.get('[role="alert"]').text()).toContain('不一致');});
it('does not redirect a cached page after the user has left the entry flow',async()=>{const wrapper=render(NewPage);await flushPromises();route.path='/events';wrapper.getComponent(Editor).vm.$emit('saved',entry);expect(mocks.push).not.toHaveBeenCalled();});

it('starts with only core fields open and validates required dates before sending a save',async()=>{
 const wrapper=render(Editor);await flushPromises();expect(wrapper.findAll('details').every(item=>item.attributes('open')===undefined)).toBe(true);
 await wrapper.get('form').trigger('submit');await flushPromises();expect(wrapper.text()).toContain('请填写疫苗名称');expect(wrapper.text()).toContain('请选择接种日期');
 expect(mocks.request.mock.calls.some(([,options])=>options?.method==='POST')).toBe(false);
 await wrapper.get('input[required]').setValue('合成疫苗');wrapper.findAllComponents(DateTimePicker)[0].vm.$emit('update:modelValue','2099-01-01');await wrapper.get('form').trigger('submit');await flushPromises();
 expect(wrapper.text()).toContain('接种日期不能晚于今天');expect(mocks.request.mock.calls.some(([,options])=>options?.method==='POST')).toBe(false);
});
it('uses the today shortcut without asking the user to open a date wheel',async()=>{
 const wrapper=render(Editor);await flushPromises();await wrapper.findAll('button').find(button=>button.text()==='今天')!.trigger('click');
 expect(wrapper.findAllComponents(DateTimePicker)[0].props('modelValue')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
});
it('does not let a failed optional credential list or process list block manual vaccination',async()=>{
 mocks.request.mockImplementation(async(path:string,options:any)=>options?.method?entry:Promise.reject(Error('合成列表失败')));
 const wrapper=render(Editor);await flushPromises();await fill(wrapper);await wrapper.get('form').trigger('submit');await flushPromises();
 expect(wrapper.emitted('saved')).toHaveLength(1);expect(mocks.request.mock.calls.some(([path,options])=>path==='vaccinations'&&options?.method==='POST')).toBe(true);
});
it('autofills a selected credential, keeps manual text and preserves the exact fact identity',async()=>{
 const fallback=mocks.request.getMockImplementation()!;
 mocks.request.mockImplementation(async(path:string,options:any)=>path==='reports/document'?{id:'document',memberId:'member',hospitalName:'合成接种机构',vaccinations:[{id:'fact-1',vaccineName:'凭证疫苗',doseNumber:'第 2 剂',administeredAt:'2026-01-01',manufacturer:'合成厂家'}]}:fallback(path,options));
 const wrapper=render(Editor);await flushPromises();await wrapper.get('input[required]').setValue('手动核对的疫苗名称');
 wrapper.findAllComponents(FormSelect).find(item=>item.props('ariaLabel')==='接种原件')!.vm.$emit('update:modelValue','document');await flushPromises();
 expect(wrapper.get('[aria-label="疫苗名称"]').element.value).toBe('手动核对的疫苗名称');expect(wrapper.get('[aria-label="接种机构"]').element.value).toBe('合成接种机构');
 expect(wrapper.findAllComponents(DateTimePicker)[0].props('modelValue')).toBe('2026-01-01');await wrapper.get('form').trigger('submit');await flushPromises();
 const body=JSON.parse(mocks.request.mock.calls.find(([path,options])=>path==='vaccinations'&&options?.method==='POST')![1].body);
 expect(body).toMatchObject({sourceReportId:'document',sourceFactId:'fact-1',vaccineName:'手动核对的疫苗名称',doseNumber:'第 2 剂',manufacturer:'合成厂家'});
});
it('keeps a credential time written with a space when the selected day is unchanged',async()=>{
 const fallback=mocks.request.getMockImplementation()!;
 mocks.request.mockImplementation(async(path:string,options:any)=>path==='reports/document'?{id:'document',memberId:'member',hospitalName:null,vaccinations:[{id:'fact-1',vaccineName:'凭证疫苗',administeredAt:'2026-01-01 09:30:00',nextDueAt:'2026-02-01 08:00'}]}:fallback(path,options));
 const wrapper=render(Editor);await flushPromises();
 wrapper.findAllComponents(FormSelect).find(item=>item.props('ariaLabel')==='接种原件')!.vm.$emit('update:modelValue','document');await flushPromises();
 expect(wrapper.findAllComponents(DateTimePicker)[0].props('modelValue')).toBe('2026-01-01');
 await wrapper.get('form').trigger('submit');await flushPromises();
 const body=JSON.parse(mocks.request.mock.calls.find(([path,options])=>path==='vaccinations'&&options?.method==='POST')![1].body);
 expect(body.administeredAt).toBe('2026-01-01 09:30:00');expect(body.nextDueAt).toBe('2026-02-01 08:00');
});
it('requires choosing a fact when one credential describes multiple vaccinations',async()=>{
 const fallback=mocks.request.getMockImplementation()!;
 mocks.request.mockImplementation(async(path:string,options:any)=>path==='reports/document'?{id:'document',memberId:'member',hospitalName:null,vaccinations:[{id:'fact-1',vaccineName:'合成甲',administeredAt:'2026-01-01'},{id:'fact-2',vaccineName:'合成乙',administeredAt:'2026-01-02'}]}:fallback(path,options));
 const wrapper=render(Editor);await flushPromises();wrapper.findAllComponents(FormSelect).find(item=>item.props('ariaLabel')==='接种原件')!.vm.$emit('update:modelValue','document');await flushPromises();
 await fill(wrapper);await wrapper.get('form').trigger('submit');expect(wrapper.text()).toContain('请选择原件中的接种条目');expect(wrapper.emitted('saved')).toBeUndefined();
 await wrapper.get('[aria-label="原件中的接种条目"]').findAll('button')[1].trigger('click');await wrapper.get('form').trigger('submit');await flushPromises();
 expect(JSON.parse(mocks.request.mock.calls.find(([path,options])=>path==='vaccinations'&&options?.method==='POST')![1].body).sourceFactId).toBe('fact-2');
});
it('discards a late credential response after switching members',async()=>{
 const fallback=mocks.request.getMockImplementation()!;let release!:(value:any)=>void;
 mocks.request.mockImplementation((path:string,options:any)=>path==='reports/document'?new Promise(resolve=>release=resolve):fallback(path,options));
 const wrapper=render(Editor);await flushPromises();wrapper.findAllComponents(FormSelect).find(item=>item.props('ariaLabel')==='接种原件')!.vm.$emit('update:modelValue','document');
 app.selectedMemberId.value='second';await flushPromises();release({id:'document',memberId:'member',hospitalName:'旧成员机构',vaccinations:[{id:'fact',vaccineName:'旧成员疫苗',administeredAt:'2026-01-01'}]});await flushPromises();
 expect(wrapper.get('input[required]').element.value).toBe('');expect(wrapper.text()).not.toContain('旧成员');
});
it('validates the optional reminder inline and can explicitly remove an existing reminder',async()=>{
 const wrapper=render(Editor,{entry});await flushPromises();wrapper.findAllComponents(DateTimePicker)[1].vm.$emit('update:modelValue','2025-01-01');await wrapper.get('form').trigger('submit');await flushPromises();
 expect(wrapper.text()).toContain('请选择不早于本次接种的下一剂日期');expect(mocks.request.mock.calls.some(([,options])=>options?.method==='PATCH')).toBe(false);
 await wrapper.get('.vaccination-reminder-toggle input').setValue(false);await wrapper.get('form').trigger('submit');await flushPromises();
 expect(JSON.parse(mocks.request.mock.calls.find(([,options])=>options?.method==='PATCH')![1].body).nextDueAt).toBeNull();
});
it('protects changed fields on cancel but does not prompt for an unchanged form',async()=>{
 const wrapper=render(Editor);await flushPromises();const cancel=wrapper.findAll('button').find(button=>button.text()==='取消')!;
 await cancel.trigger('click');await flushPromises();expect(wrapper.emitted('cancel')).toHaveLength(1);expect(mocks.ask).not.toHaveBeenCalled();
 await wrapper.get('input[required]').setValue('未保存的合成名称');await cancel.trigger('click');expect(mocks.ask).toHaveBeenCalledOnce();expect(wrapper.emitted('cancel')).toHaveLength(1);
 mocks.ask.mock.calls.at(-1)![0].onCancel();await flushPromises();expect(wrapper.get('input[required]').element.value).toBe('未保存的合成名称');
 await cancel.trigger('click');mocks.ask.mock.calls.at(-1)![0].run();await flushPromises();expect(wrapper.emitted('cancel')).toHaveLength(2);
});
it('only displays populated detail fields and offers next-dose entry from a pending reminder',async()=>{
 mocks.request.mockResolvedValueOnce({...entry,reminderStatus:'pending'});const wrapper=render(Detail,{recordId:'v1'});await flushPromises();
 expect(wrapper.text()).not.toContain('未填写');expect(wrapper.text()).not.toContain('生产厂家');
 const link=wrapper.findAllComponents({name:'RouterLink'}).find(item=>item.props('to')?.path==='/add/vaccination');
 // The next-dose route retains the original detail as its return target.
 expect(link?.props('to')).toMatchObject({path:'/add/vaccination',query:{sourceVaccinationId:'v1',reminderId:'reminder'}});
});
it('a completed next dose has a view link instead of another registration action',async()=>{
 mocks.request.mockResolvedValueOnce({...entry,reminderStatus:'completed',nextVaccinationId:'next'});const wrapper=render(Detail,{recordId:'v1'});await flushPromises();
 expect(wrapper.text()).toContain('已登记下一剂');expect(wrapper.text()).toContain('查看下一剂记录');expect(wrapper.text()).not.toContain('记录下一剂');
 expect(wrapper.text()).not.toContain('调整提醒');
});
it('restores a dismissed reminder directly without rewriting the vaccination',async()=>{
 const fallback=mocks.request.getMockImplementation()!;
 mocks.request.mockImplementation((path:string,options:any)=>path==='vaccinations/v1'?Promise.resolve({...entry,reminderStatus:'dismissed'}):fallback(path,options));
 const wrapper=render(Detail,{recordId:'v1'});await flushPromises();await wrapper.findAll('button').find(button=>button.text()==='恢复提醒')!.trigger('click');await flushPromises();
 expect(mocks.request).toHaveBeenCalledWith('reminders/reminder',{method:'PUT',body:JSON.stringify({status:'pending'})});expect(mocks.request.mock.calls.some(([path,options])=>path==='vaccinations/v1'&&options?.method==='PATCH')).toBe(false);
});
it('returns to the originating filter after saving and rejects external return targets',async()=>{
 route.query={returnTo:'/events?category=vaccination&subtype=administered'};const wrapper=render(NewPage);await flushPromises();wrapper.getComponent(Editor).vm.$emit('saved',entry);await flushPromises();
 expect(mocks.replace).toHaveBeenCalledWith({path:'/events/detail/vaccination/v1',query:{returnTo:'/events?category=vaccination&subtype=administered'}});
 route.query={returnTo:'https://example.invalid/'};await flushPromises();expect(wrapper.getComponent({name:'SubPageHeader'}).props('backTo')).toBe('/events');
});

it('opens the credential list directly from the upper-right picker without leaving the form',async()=>{
 const wrapper=render(Editor);await flushPromises();await wrapper.get('[aria-label="疫苗名称"]').setValue('手动名称');
 await wrapper.findAll('button').find(button=>button.text()==='关联原件')!.trigger('click');await flushPromises();
 expect(wrapper.get('.vaccination-source-toolbar [aria-label="接种原件"]').attributes('aria-expanded')).toBe('true');expect(document.querySelector('[role="listbox"][aria-label="接种原件"]')?.textContent).toContain('合成接种凭证');expect(wrapper.get('[aria-label="疫苗名称"]').element.value).toBe('手动名称');expect(wrapper.text()).not.toContain('凭证与备注');
 expect(wrapper.get('datalist').findAll('option').map(option=>option.attributes('value'))).toEqual(['第 1 剂','第 2 剂','第 3 剂','加强剂']);
});
it('does not describe a canceled reminder as active when editing clinical fields',async()=>{
 const wrapper=render(Editor,{entry:{...entry,reminderStatus:'dismissed'}});await flushPromises();
 expect(wrapper.get('.vaccination-reminder-toggle').text()).toContain('提醒已取消');
 await wrapper.get('form').trigger('submit');await flushPromises();
 expect(JSON.parse(mocks.request.mock.calls.find(([,options])=>options?.method==='PATCH')![1].body).nextDueAt).toBe(entry.nextDueAt);
});
it('adjusts a reminder inline without opening the full clinical editor and saves only its date and revision',async()=>{
 mocks.request.mockResolvedValueOnce({...entry,reminderStatus:'pending'});const wrapper=render(Detail,{recordId:'v1'});await flushPromises();
 await wrapper.findAll('button').find(button=>button.text()==='调整提醒')!.trigger('click');expect(wrapper.findComponent(Editor).exists()).toBe(false);
 const form=wrapper.getComponent(ReminderEditor);form.getComponent(DateTimePicker).vm.$emit('update:modelValue','2025-01-01');await form.get('form').trigger('submit');await flushPromises();expect(form.text()).toContain('不早于本次接种');
 form.getComponent(DateTimePicker).vm.$emit('update:modelValue','2026-03-01');await form.get('form').trigger('submit');await flushPromises();
 expect(mocks.request).toHaveBeenCalledWith('vaccinations/v1',{method:'PATCH',body:JSON.stringify({revision:1,nextDueAt:'2026-03-01'})});expect(wrapper.emitted('changed')).toHaveLength(1);
});
it('can cancel a pending reminder directly while leaving the vaccination intact',async()=>{
 mocks.request.mockResolvedValueOnce({...entry,reminderStatus:'pending'});const wrapper=render(Detail,{recordId:'v1'});await flushPromises();
 await wrapper.findAll('button').find(button=>button.text()==='取消提醒')!.trigger('click');await flushPromises();
 expect(mocks.request).toHaveBeenCalledWith('reminders/reminder',{method:'PUT',body:JSON.stringify({status:'dismissed'})});expect(wrapper.text()).toContain('提醒已取消');expect(wrapper.text()).toContain('恢复提醒');
 expect(mocks.request.mock.calls.some(([,options])=>options?.method==='DELETE')).toBe(false);
});
it('keeps reminder date input when saving fails, and protects changed input on cancel',async()=>{
 const wrapper=render(ReminderEditor,{entry});await flushPromises();wrapper.getComponent(DateTimePicker).vm.$emit('update:modelValue','2026-03-01');await wrapper.vm.$nextTick();
 mocks.request.mockRejectedValueOnce(Error('合成保存中断'));await wrapper.get('form').trigger('submit');await flushPromises();expect(wrapper.get('[role="alert"]').text()).toContain('合成保存中断');
 expect(wrapper.getComponent(DateTimePicker).props('modelValue')).toBe('2026-03-01');
 await wrapper.findAll('button').find(button=>button.text()==='取消')!.trigger('click');expect(mocks.ask).toHaveBeenCalledOnce();expect(wrapper.emitted('cancel')).toBeUndefined();mocks.ask.mock.calls[0][0].onCancel();await flushPromises();expect(wrapper.getComponent(DateTimePicker).props('modelValue')).toBe('2026-03-01');
});
it('a late reminder save never updates another member or closes their form',async()=>{
 const wrapper=render(ReminderEditor,{entry});await flushPromises();let finish!:(value:any)=>void;
 mocks.request.mockImplementationOnce(()=>new Promise(resolve=>finish=resolve));await wrapper.get('form').trigger('submit');
 app.selectedMemberId.value='second';await flushPromises();finish(entry);await flushPromises();expect(wrapper.emitted('saved')).toBeUndefined();expect(app.notifyDataChanged).not.toHaveBeenCalled();
});
it('clears values autofilled from a previous credential when the replacement lacks them, while retaining manual text',async()=>{
 const fallback=mocks.request.getMockImplementation()!;
 mocks.request.mockImplementation(async(path:string,options:any)=>path==='reports/document'?{id:'document',memberId:'member',hospitalName:'合成机构',vaccinations:[{id:'first',vaccineName:'合成甲',administeredAt:'2026-01-01',lotNumber:'SYNTHETIC-LOT'}]}:path==='reports/second'?{id:'second',memberId:'member',hospitalName:null,vaccinations:[{id:'second-fact',vaccineName:'合成乙'}]}:fallback(path,options));
 const wrapper=render(Editor);await flushPromises();const select=wrapper.findAllComponents(FormSelect).find(item=>item.props('ariaLabel')==='接种原件')!;
 select.vm.$emit('update:modelValue','document');await flushPromises();await wrapper.get('[aria-label="疫苗名称"]').setValue('手动核对名称');
 select.vm.$emit('update:modelValue','second');await flushPromises();expect(wrapper.get('[aria-label="疫苗名称"]').element.value).toBe('手动核对名称');expect(wrapper.get('[aria-label="接种机构"]').element.value).toBe('');expect(wrapper.findAllComponents(DateTimePicker)[0].props('modelValue')).toBeNull();
});

it('selecting a credential from the dropdown fills its facts and can clear the link without clearing manual input',async()=>{
 const fallback=mocks.request.getMockImplementation()!;
 mocks.request.mockImplementation((path:string,options:any)=>path==='reports/document'?Promise.resolve({id:'document',memberId:'member',hospitalName:'合成机构',vaccinations:[{id:'fact',vaccineName:'凭证疫苗',doseNumber:'第 2 剂',administeredAt:'2026-01-01'}]}):fallback(path,options));
 const wrapper=render(Editor);await flushPromises();await wrapper.get('[aria-label="疫苗名称"]').setValue('手动名称');
 const picker=wrapper.findAllComponents(FormSelect).find(item=>item.props('ariaLabel')==='接种原件')!;
 await picker.get('button').trigger('click');await flushPromises();
 document.querySelector<HTMLButtonElement>('[role="listbox"][aria-label="接种原件"] [role="option"]')!.click();await flushPromises();
 expect(picker.get('button').attributes('aria-expanded')).toBe('false');expect(picker.text()).toContain('合成接种凭证');
 expect(wrapper.get('[aria-label="疫苗名称"]').element.value).toBe('手动名称');expect(wrapper.get('[aria-label="剂次"]').element.value).toBe('第 2 剂');
 expect(wrapper.findAllComponents(DateTimePicker)[0].props('modelValue')).toBe('2026-01-01');expect(wrapper.get('.vaccination-source-feedback').text()).toContain('已带入');
 expect(mocks.request.mock.calls.some(([,options])=>options?.method)).toBe(false);
 await picker.get('button').trigger('click');await flushPromises();
 const clear=[...document.querySelectorAll<HTMLButtonElement>('[role="listbox"][aria-label="接种原件"] [role="option"]')].find(item=>item.textContent?.includes('不关联原件'))!;clear.click();await flushPromises();
 expect(picker.text()).toContain('关联原件');expect(wrapper.get('[aria-label="疫苗名称"]').element.value).toBe('手动名称');
 await wrapper.get('form').trigger('submit');await flushPromises();
 const body=JSON.parse(mocks.request.mock.calls.find(([,options])=>options?.method==='POST')![1].body);expect(body.sourceReportId).toBeNull();expect(body.sourceFactId).toBeNull();
});
it('a failed credential list remains retryable and does not block manual entry',async()=>{
 const fallback=mocks.request.getMockImplementation()!;
 mocks.request.mockImplementation((path:string,options:any)=>path.startsWith('vaccinations/documents')?Promise.reject(Error('连接中断')):fallback(path,options));
 const wrapper=render(Editor);await flushPromises();expect(wrapper.get('.vaccination-source-feedback').text()).toContain('原件列表暂时无法读取');
 await wrapper.get('[aria-label="疫苗名称"]').setValue('手动疫苗');expect(wrapper.get('[aria-label="疫苗名称"]').element.value).toBe('手动疫苗');
 mocks.request.mockImplementation(fallback);await wrapper.get('.vaccination-source-feedback button').trigger('click');await flushPromises();
 expect(wrapper.find('.vaccination-source-feedback').exists()).toBe(false);expect(wrapper.get('[aria-label="疫苗名称"]').element.value).toBe('手动疫苗');
});

it('new vaccination places its live credential picker beside the page title without an extra form row',async()=>{
 const wrapper=render(NewPage);await flushPromises();
 expect(wrapper.get('.subpage-header h2').text()).toBe('记录接种');
 const trigger=wrapper.get('.subpage-header .vaccination-header-actions [aria-label="接种原件"]');
 expect(wrapper.getComponent(Editor).find('.vaccination-fields .vaccination-source-toolbar').exists()).toBe(false);
 await wrapper.get('[aria-label="疫苗名称"]').setValue('手动疫苗');await trigger.trigger('click');await flushPromises();
 expect(trigger.attributes('aria-expanded')).toBe('true');
 document.querySelector<HTMLButtonElement>('[role="listbox"][aria-label="接种原件"] [role="option"]')!.click();await flushPromises();
 expect(trigger.text()).toContain('合成接种凭证');expect(wrapper.get('[aria-label="疫苗名称"]').element.value).toBe('手动疫苗');
 expect(mocks.request).toHaveBeenCalledWith('reports/document');expect(mocks.request.mock.calls.some(([,options])=>options?.method)).toBe(false);
});

it('deletion explains the retained credential and both reminder effects when those links exist',async()=>{
 mocks.request.mockResolvedValueOnce({...entry,sourceReportId:'document',completedReminderId:'previous-reminder'});
 const wrapper=render(Detail,{recordId:'v1'});await flushPromises();await wrapper.get('[aria-label="移入回收站"]').trigger('click');
 const confirmation=mocks.ask.mock.calls[0][0];expect(confirmation.message).toContain('原件附件会保留');expect(confirmation.message).toContain('下一剂提醒也会取消');expect(confirmation.message).toContain('前一剂提醒若已完成，将恢复为待接种');
 expect(mocks.request.mock.calls.some(([,options])=>options?.method==='DELETE')).toBe(false);
});


it('vaccination details place edit before deletion in the shared toolbar and keep the status for viewers',async()=>{
 const wrapper=render(Detail,{recordId:'v1'});await flushPromises();
 expect(wrapper.get('.record-detail-toolbar .preview-heading').text()).toBe('已接种');
 expect(wrapper.get('.record-detail-toolbar').findAll('button').map(button=>button.attributes('aria-label') || button.text())).toEqual(['编辑接种','移入回收站']);
 expect(wrapper.findAll('button').filter(button=>button.text()==='编辑接种')).toHaveLength(1);
 expect(wrapper.findAll('[aria-label="移入回收站"]')).toHaveLength(1);
 app.selectedMember.value.permission='viewer';await flushPromises();
 expect(wrapper.get('.record-detail-toolbar .preview-heading').text()).toBe('已接种');
 expect(wrapper.find('[aria-label="移入回收站"]').exists()).toBe(false);
});

it('renders linked originals inline without reopening a credential detail',async()=>{
 const attached={...entry,sourceReportId:'document'};mocks.request.mockResolvedValue(attached);
 const wrapper=render(Detail,{recordId:'v1'});await flushPromises();
 expect(wrapper.getComponent({name:'ReportDetail'}).props()).toMatchObject({reportId:'document',expectedMemberId:'member',originalsOnly:true,hideTrashAction:true});
 expect(wrapper.text()).not.toContain('查看接种凭证');expect(wrapper.findAll('.record-detail-toolbar')).toHaveLength(1);
});

it('keeps other vaccinations in a shared original reachable without changing its direct preview',async()=>{
 mocks.request.mockImplementation(async(path:string)=>path==='vaccinations/v1'?{...entry,sourceReportId:'document'}:[]);
 const wrapper=render(Detail,{recordId:'v1'});await flushPromises();
 wrapper.getComponent({name:'ReportDetail'}).vm.$emit('loaded',{id:'document',memberId:'member',vaccinations:[{id:'first'},{id:'second'}]});await flushPromises();
 await wrapper.findAll('button').find(button=>button.text()==='查看同份原件中的其他接种')!.trigger('click');
 expect(wrapper.emitted('openReport')).toEqual([['document']]);
 expect(wrapper.getComponent({name:'ReportDetail'}).props('originalsOnly')).toBe(true);
});

async function selectAttachment(wrapper:any,file=new File(['synthetic image'],'合成附件.png',{type:'image/png'})) {
 Object.defineProperty(wrapper.get('input[type="file"]').element,'files',{configurable:true,value:[file]});
 await wrapper.get('input[type="file"]').trigger('change');
}
it('uploads selected attachments with manual vaccination only when saving',async()=>{
 const wrapper=render(Editor);await flushPromises();await fill(wrapper);await selectAttachment(wrapper);
 expect(wrapper.text()).toContain('合成附件.png');expect(mocks.upload).not.toHaveBeenCalled();
 await wrapper.get('form').trigger('submit');await flushPromises();
 const [path,data]=mocks.upload.mock.calls[0];expect(path).toBe('vaccinations/with-original');
 expect(JSON.parse(data.get('payload'))).toMatchObject({memberId:'member',vaccineName:'合成疫苗',administeredAt:'2026-01-01'});
 expect(data.getAll('files').map((file:File)=>file.name)).toEqual(['合成附件.png']);
 expect(wrapper.emitted('saved')?.[0][0]).toMatchObject({sourceReportId:'new-original'});
 expect(mocks.request.mock.calls.some(([,options])=>options?.method==='POST')).toBe(false);
});
it('an existing manual vaccination keeps its id and revision when adding an attachment',async()=>{
 const wrapper=render(Editor,{entry});await flushPromises();await selectAttachment(wrapper);await wrapper.get('form').trigger('submit');await flushPromises();
 expect(JSON.parse(mocks.upload.mock.calls[0][1].get('payload'))).toMatchObject({id:'v1',revision:1});
});
it('removing a pending attachment returns to saving without uploading files',async()=>{
 const wrapper=render(Editor);await flushPromises();await fill(wrapper);await selectAttachment(wrapper);
 await wrapper.get('[aria-label="移除附件：合成附件.png"]').trigger('click');await wrapper.get('form').trigger('submit');await flushPromises();
 expect(mocks.upload).not.toHaveBeenCalled();expect(mocks.request.mock.calls.some(([path,options])=>path==='vaccinations'&&options?.method==='POST')).toBe(true);
});
it('failed attachment saves retain selected files and reuse the same retry key',async()=>{
 const wrapper=render(Editor);await flushPromises();await fill(wrapper);await selectAttachment(wrapper);
 mocks.upload.mockRejectedValueOnce(Error('合成上传中断'));await wrapper.get('form').trigger('submit');await flushPromises();
 expect(wrapper.text()).toContain('合成上传中断');expect(wrapper.text()).toContain('合成附件.png');
 await wrapper.get('form').trigger('submit');await flushPromises();
 const keys=mocks.upload.mock.calls.map(([,data])=>JSON.parse(data.get('payload')).requestKey);expect(keys[0]).toBe(keys[1]);
});
it('leaving a file-only edit asks about unsaved changes without persisting an attachment',async()=>{
 const wrapper=render(Editor);await flushPromises();await selectAttachment(wrapper);
 await wrapper.findAll('button').find(button=>button.text()==='取消')!.trigger('click');
 expect(mocks.ask).toHaveBeenCalledOnce();expect(wrapper.emitted('cancel')).toBeUndefined();
 await mocks.ask.mock.calls[0][0].run();await flushPromises();expect(wrapper.emitted('cancel')).toHaveLength(1);expect(mocks.upload).not.toHaveBeenCalled();
});
it('rejects unsupported attachments before upload and ignores a late upload response after member switching',async()=>{
 const wrapper=render(Editor);await flushPromises();await fill(wrapper);
 await selectAttachment(wrapper,new File(['synthetic'],'test.txt',{type:'text/plain'}));expect(wrapper.text()).toContain('请选择图片或 PDF 附件');expect(mocks.upload).not.toHaveBeenCalled();
 await selectAttachment(wrapper);let resolve!:(value:unknown)=>void;mocks.upload.mockReturnValueOnce(new Promise(done=>resolve=done));
 await wrapper.get('form').trigger('submit');app.selectedMemberId.value='second';app.selectedMember.value={id:'second',permission:'manager'};await flushPromises();
 resolve({...entry,sourceReportId:'new-original'});await flushPromises();expect(wrapper.emitted('saved')).toBeUndefined();expect(app.notifyDataChanged).not.toHaveBeenCalled();
});

it('uploads attachments directly from vaccination detail without entering the editor',async()=>{
 mocks.upload.mockResolvedValue({...entry,revision:2,sourceReportId:'new-original'});
 const wrapper=render(Detail,{recordId:'v1'});await flushPromises();expect(wrapper.findComponent(Editor).exists()).toBe(false);
 expect(wrapper.get('.vaccination-original-upload').text()).toContain('上传附件');await selectAttachment(wrapper);await flushPromises();
 const [path,data]=mocks.upload.mock.calls[0];expect(path).toBe('vaccinations/with-original');
 expect(JSON.parse(data.get('payload'))).toMatchObject({id:'v1',memberId:'member',revision:1});expect(JSON.parse(data.get('payload'))).not.toHaveProperty('vaccineName');
 expect(wrapper.getComponent({name:'ReportDetail'}).props('reportId')).toBe('new-original');expect(wrapper.findComponent(Editor).exists()).toBe(false);
 expect(wrapper.emitted('changed')?.[0][0]).toMatchObject({id:'v1',revision:2,sourceReportId:'new-original'});
});
it('direct attachment uploads protect other record actions and retain files for retry on failure',async()=>{
 const wrapper=render(Detail,{recordId:'v1'});await flushPromises();let reject!:(error:Error)=>void;
 mocks.upload.mockReturnValueOnce(new Promise((_resolve,fail)=>reject=fail));await selectAttachment(wrapper);
 expect(wrapper.get('.vaccination-toolbar-edit').attributes('disabled')).toBeDefined();expect(wrapper.get('[aria-label="移入回收站"]').attributes('disabled')).toBeDefined();
 reject(Error('合成上传失败'));await flushPromises();expect(wrapper.text()).toContain('合成附件.png');expect(wrapper.text()).toContain('合成上传失败');
 expect(wrapper.get('.vaccination-toolbar-edit').attributes('disabled')).toBeUndefined();
 await wrapper.findAll('button').find(button=>button.text()==='重试上传')!.trigger('click');await flushPromises();
 const keys=mocks.upload.mock.calls.map(([,data])=>JSON.parse(data.get('payload')).requestKey);expect(keys[0]).toBe(keys[1]);
});
it('viewers have no direct attachment upload and late uploads do not update another member',async()=>{
 app.selectedMember.value.permission='viewer';const viewer=render(Detail,{recordId:'v1'});await flushPromises();expect(viewer.text()).not.toContain('上传附件');viewer.unmount();
 app.selectedMember.value.permission='manager';const wrapper=render(Detail,{recordId:'v1'});await flushPromises();let resolve!:(value:unknown)=>void;
 mocks.upload.mockReturnValueOnce(new Promise(done=>resolve=done));await selectAttachment(wrapper);app.selectedMemberId.value='second';app.selectedMember.value={id:'second',permission:'manager'};await flushPromises();
 resolve({...entry,sourceReportId:'new-original'});await flushPromises();expect(wrapper.emitted('changed')).toBeUndefined();expect(app.notifyDataChanged).not.toHaveBeenCalled();
});
