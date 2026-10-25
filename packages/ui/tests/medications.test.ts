import { DOMWrapper, flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { KeepAlive, defineComponent, ref } from 'vue';
import MedicationRecords from '../src/components/MedicationRecords.vue';
import MedicationRecordModal from '../src/components/MedicationRecordModal.vue';
import MedicationEditor from '../src/components/MedicationEditor.vue';
import MedicationUnitPicker from '../src/components/MedicationUnitPicker.vue';
import MedicationContextPicker from '../src/components/MedicationContextPicker.vue';
import FormSelect from '../src/components/FormSelect.vue';
import DateTimePicker from '../src/components/DateTimePicker.vue';
import ReportMedicationUseButton from '../src/components/ReportMedicationUseButton.vue';
import ReportDetailModal from '../src/components/ReportDetailModal.vue';

const mocks=vi.hoisted(()=>({request:vi.fn(),ask:vi.fn()}));
const app={selectedMemberId:ref('member'),selectedMember:ref({id:'member',permission:'manager'}),dataVersion:ref(0),notifyDataChanged:vi.fn()};
vi.mock('vue-router',()=>({RouterLink:{props:['to'],template:'<a :href="to"><slot /></a>'}}));
vi.mock('../src/utils/api',()=>({request:mocks.request}));
vi.mock('../src/composables/useAppContext',()=>({useAppContext:()=>app}));
vi.mock('../src/composables/useConfirm',()=>({useConfirm:()=>({ask:mocks.ask})}));
vi.mock('../src/components/ReportDetailModal.vue',()=>({default:{name:'ReportDetailModal',props:['open','reportId'],template:'<div v-if="open" class="source-preview">{{reportId}}</div>'}}));
vi.mock('../src/components/HealthRecordAssociations.vue',()=>({default:{name:'HealthRecordAssociations',template:'<div />'}}));
vi.mock('../src/components/DateTimePicker.vue',()=>({default:{props:['modelValue','showTime'],emits:['update:modelValue'],template:'<input class="date-input" :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />'}}));
const fields={medicationName:'合成药品',specification:'合成规格',dosageForm:'片剂',dose:'1',doseUnit:'片',frequency:'每日一次',route:'口服',instructions:'合成用法'};
const documentRecord={id:'report',memberId:'member',title:'合成用药单',reportType:'prescription',status:'ready',date:'2025-01-01',medicationCount:1,medicationNames:['合成药品']};
const source={...fields,reportId:'report',reportTitle:'合成报告',reportIssuedAt:'2025-01-01',medicationId:'source',duration:null,
  confirmedCourseIds:[]};
const course={...fields,id:'course',memberId:'member',status:'active',startedAt:'2025-01-01',lastChangedAt:'2025-01-01',stoppedAt:null,revision:1,
  sourceReportId:'report',source,changes:[{id:'change',action:'start',occurredAt:'2025-01-01',revision:1,note:null,snapshot:{...fields,status:'active'}}]};
const intake={id:'intake',memberId:'member',courseId:'course',medicationName:'合成药品',specification:'当时规格',dosageForm:'片剂',route:'口服',
  takenAt:'2025-01-02T08:00',amount:'1',amountUnit:'片',note:null,revision:3,history:[]};
let overview:Record<string,unknown>;
beforeEach(()=>{
  vi.clearAllMocks();app.selectedMemberId.value='member';app.selectedMember.value={id:'member',permission:'manager'};app.dataVersion.value=0;
  overview={courses:[],intakes:[]};
  mocks.request.mockImplementation(async(path:string,options?:RequestInit)=>{
    if(options?.method)return {};
    if(path.startsWith('medications/documents'))return structuredClone([documentRecord]);
    if(path.startsWith('medications/report-history'))return structuredClone([source]);
    if(path.startsWith('medications?'))return structuredClone(overview);
    if(path.startsWith('episodes?'))return [{id:'episode',title:'合成过程'}];
    if(path.startsWith('events?'))return [{id:'event',title:'合成就诊',startedAt:'2025-01-01'}];
    if(path.startsWith('health-records?'))return {items:[],hasMore:false,nextCursor:null};
    return [];
  });
});
function mountRecords(props:{courseId?:string;intakeId?:string;processId?:string;reportId?:string;add?:'course'|'intake'}={courseId:'course'}){return mount(MedicationRecords,{props});}
function button(wrapper:ReturnType<typeof mount>,text:string){return wrapper.findAll('button').find(item=>item.text()===text)!;}
const entryDialogs:ReturnType<typeof mount>[]=[];
afterEach(()=>{entryDialogs.splice(0).forEach(wrapper=>wrapper.unmount());});
it('medication common choices save directly while imported and manually typed values stay intact',async()=>{
 const wrapper=mount(MedicationEditor,{props:{memberId:'member',mode:'course',source:{...source,frequency:'合成报告原频次 / bid',doseUnit:'合成特殊单位'}},attachTo:document.body});entryDialogs.push(wrapper);await flushPromises();
 expect(wrapper.get('input[name=frequency]').element.value).toBe('合成报告原频次 / bid');
 expect(wrapper.get('input[name=doseUnit]').element.value).toBe('合成特殊单位');
 await wrapper.get('[aria-label="选择用药频次常用值"]').trigger('click');await flushPromises();
 const menu=new DOMWrapper(document.querySelector('.form-select-panel')!);
 await menu.findAll('[role=option]').find(option=>option.text()==='每日两次')!.trigger('click');
 await wrapper.get('input[name=route]').setValue('合成自定义途径');await wrapper.get('form').trigger('submit');await flushPromises();
 const body=JSON.parse(mocks.request.mock.calls.find(([path,options])=>path==='medications'&&options?.method==='POST')![1].body);
 expect(body).toMatchObject({frequency:'每日两次',doseUnit:'合成特殊单位',route:'合成自定义途径',dose:'1'});
 expect(document.querySelector('.form-select-layer')).toBeNull();
});
async function openEntryChooser(){const wrapper=mount(MedicationRecordModal,{props:{open:true,add:'course',processId:'process'},attachTo:document.body});entryDialogs.push(wrapper);await flushPromises();return wrapper;}
const visibleEntryDialogs=()=>[...document.querySelectorAll<HTMLElement>('.medication-record-modal[role="dialog"]')].map(element=>new DOMWrapper(element)).filter(dialog=>dialog.isVisible());
const currentEntryDialog=(_wrapper:ReturnType<typeof mount>)=>visibleEntryDialogs()[0]!;
it('process identity survives the medication chooser and is submitted by the independent editor',async()=>{
 const wrapper=mount(MedicationRecordModal,{props:{open:true,add:'course',processId:'process'},attachTo:document.body});entryDialogs.push(wrapper);await flushPromises();await currentEntryDialog(wrapper).get('[data-medication-entry="course"]').trigger('click');await flushPromises();
 const dialog=currentEntryDialog(wrapper);expect(dialog.text()).toContain('保存后加入当前健康历程');await dialog.get('[name="medicationName"]').setValue('合成历程用药');await dialog.get('form').trigger('submit');await flushPromises();const call=mocks.request.mock.calls.find(([path,options])=>path==='medications'&&options?.method==='POST')!;expect(JSON.parse(call[1].body).processId).toBe('process');
});

it.each([['report','从报告带入'],['course','手动添加用药'],['intake','记一次已服药']] as const)('opens %s in a separate dialog and returns to the chooser with focus',async(mode,title)=>{
 const wrapper=await openEntryChooser();const chooser=currentEntryDialog(wrapper);
 await chooser.get(`[data-medication-entry="${mode}"]`).trigger('click');await flushPromises();
 const dialog=currentEntryDialog(wrapper);expect(dialog.element).not.toBe(chooser.element);expect(dialog.attributes('aria-label')).toBe(title);
 expect(visibleEntryDialogs()).toHaveLength(1);expect(dialog.find('.medication-start').exists()).toBe(false);
 if(mode==='report')expect(dialog.find('[aria-label="搜索报告用药"]').exists()).toBe(true);
 else {expect(dialog.find('.medication-editor > header').exists()).toBe(false);expect(dialog.find('[name="medicationName"]').exists()).toBe(true);}
 await dialog.get('[aria-label="关闭用药记录"]').trigger('click');await flushPromises();expect(currentEntryDialog(wrapper).attributes('aria-label')).toBe('记录用药');expect(document.activeElement?.getAttribute('data-medication-entry')).toBe(mode);expect(wrapper.emitted('close')).toBeUndefined();
});
it('opens report confirmation in another dialog and keeps the report search when canceled',async()=>{
 const wrapper=await openEntryChooser();await currentEntryDialog(wrapper).get('[data-medication-entry="report"]').trigger('click');await flushPromises();
 const reports=currentEntryDialog(wrapper);await reports.get('[aria-label="搜索报告用药"]').setValue('合成');
 await reports.findAll('button').find(item=>item.text()==='确认开始用药')!.trigger('click');await flushPromises();
 const editor=currentEntryDialog(wrapper);expect(editor.element).not.toBe(reports.element);expect(editor.attributes('aria-label')).toBe('确认开始用药');expect(editor.get('[name="medicationName"]').element.value).toBe('合成药品');
 expect(wrapper.findAllComponents(MedicationEditor).at(-1)!.props('initialContext')).toEqual({processId:'process'});
 await editor.findAll('button').find(item=>item.text()==='取消')!.trigger('click');await flushPromises();expect(currentEntryDialog(wrapper).attributes('aria-label')).toBe('从报告带入');expect(currentEntryDialog(wrapper).get('[aria-label="搜索报告用药"]').element.value).toBe('合成');
});
it('protects unsaved input when closing an independent medication form',async()=>{
 const wrapper=await openEntryChooser();await currentEntryDialog(wrapper).get('[data-medication-entry="course"]').trigger('click');await flushPromises();const editor=currentEntryDialog(wrapper);
 await editor.get('[name="medicationName"]').setValue('尚未保存的合成药品');await editor.get('[aria-label="关闭用药记录"]').trigger('click');await flushPromises();
 expect(mocks.ask).toHaveBeenCalledOnce();expect(currentEntryDialog(wrapper).element).toBe(editor.element);mocks.ask.mock.calls[0][0].onCancel();await flushPromises();expect(editor.get('[name="medicationName"]').element.value).toBe('尚未保存的合成药品');
 await editor.get('[aria-label="关闭用药记录"]').trigger('click');await flushPromises();mocks.ask.mock.calls[1][0].run();await flushPromises();expect(currentEntryDialog(wrapper).attributes('aria-label')).toBe('记录用药');
});
it('closes the add flow after saving instead of turning the form dialog into a record list',async()=>{
 const fallback=mocks.request.getMockImplementation()!;mocks.request.mockImplementation(async(path:string,options?:RequestInit)=>path==='medications'&&options?.method==='POST'?structuredClone(course):fallback(path,options));
 const wrapper=await openEntryChooser();await currentEntryDialog(wrapper).get('[data-medication-entry="course"]').trigger('click');await flushPromises();const editor=currentEntryDialog(wrapper);
 await editor.get('[name="medicationName"]').setValue('合成药品');await editor.get('form').trigger('submit');await flushPromises();expect(wrapper.emitted('close')).toHaveLength(1);expect(wrapper.emitted('updated')).toHaveLength(1);expect(app.notifyDataChanged).toHaveBeenCalledOnce();
});
it('retains the process entry anchor when a one-time intake selects an existing course',async()=>{
 const wrapper=mount(MedicationEditor,{props:{memberId:'member',mode:'intake',courses:[course],initialContext:{relatedRecords:[{kind:'report',id:'anchor'}]}}});entryDialogs.push(wrapper);
 await flushPromises();const select=wrapper.getComponent(FormSelect);select.vm.$emit('update:modelValue','course');await wrapper.vm.$nextTick();select.vm.$emit('change','course');await wrapper.vm.$nextTick();
 await wrapper.get('[name="amount"]').setValue('1');await wrapper.get('form').trigger('submit');await flushPromises();
 const save=mocks.request.mock.calls.find(([path,options])=>path==='medications/intakes'&&options?.method==='POST')!;
 expect(JSON.parse(String(save[1].body))).toMatchObject({courseId:'course',relatedRecords:[{kind:'report',id:'anchor'}]});
});
it('discards every child dialog on a member switch',async()=>{
 const wrapper=await openEntryChooser();await currentEntryDialog(wrapper).get('[data-medication-entry="intake"]').trigger('click');await flushPromises();app.selectedMemberId.value='second';app.selectedMember.value={id:'second',permission:'manager'};await flushPromises();expect(visibleEntryDialogs()).toHaveLength(0);expect(wrapper.findComponent(MedicationEditor).exists()).toBe(false);expect(document.body.style.overflow).toBe('');
});

it('historical prescriptions stay separate and a viewer can preview the source without write controls',async()=>{
  app.selectedMember.value.permission='viewer';
  const wrapper=mountRecords({add:'course'});await flushPromises();
  await button(wrapper,'查看报告中的用药').trigger('click');await flushPromises();
  expect(wrapper.text()).toContain('不代表目前正在使用');
  expect(wrapper.text()).not.toContain('开始用药');expect(wrapper.text()).not.toContain('记录使用');
  expect(mocks.request.mock.calls.every(([,options])=>!options?.method)).toBe(true);
  await wrapper.get('.medication-source-link').trigger('click');
  expect(wrapper.getComponent(ReportDetailModal).props()).toMatchObject({open:true,reportId:'report'});
  wrapper.unmount();
});

it('confirming a historical prescription preserves specification and explicitly selected contexts',async()=>{
  const wrapper=mountRecords({});await flushPromises();
  await button(wrapper,'从报告带入').trigger('click');await flushPromises();
  await button(wrapper,'确认开始用药').trigger('click');await flushPromises();
  const form=wrapper.getComponent(MedicationEditor);
  expect((form.get('input[name="specification"]').element as HTMLInputElement).value).toBe('合成规格');
  expect(form.getComponent(MedicationContextPicker).props('modelValue')).toEqual({});
  expect(mocks.request.mock.calls.every(([,options])=>!options?.method)).toBe(true);
  await form.get('.date-input').setValue('2025-01-02T09:00');await form.get('form').trigger('submit');await flushPromises();
  const call=mocks.request.mock.calls.find(([path,options])=>path==='medications' && options?.method==='POST')!;
  expect(JSON.parse(call[1].body)).toMatchObject({memberId:'member',medicationName:'合成药品',specification:'合成规格',dosageForm:'片剂',sourceMedicationId:'source',
    startedAt:'2025-01-02T09:00',confirmed:true});
  expect(app.notifyDataChanged).toHaveBeenCalledOnce();wrapper.unmount();
});

it('actual intake editing uses PATCH and removal uses the shared recycle bin after confirmation',async()=>{
  overview={courses:[course],intakes:[intake]};const wrapper=mountRecords({intakeId:'intake'});await flushPromises();
  await button(wrapper,'编辑').trigger('click');await flushPromises();
  const editor=wrapper.getComponent(MedicationEditor);await editor.get('input[name="amount"]').setValue('0.5');await editor.get('form').trigger('submit');await flushPromises();
  const call=mocks.request.mock.calls.find(([path,options])=>path==='medications/intakes/intake' && options?.method==='PATCH')!;
  expect(JSON.parse(call[1].body)).toMatchObject({revision:3,amount:'0.5',specification:'当时规格',takenAt:'2025-01-02T08:00'});
  expect(mocks.request.mock.calls.some(([path,options])=>path==='medications/intakes' && options?.method==='POST')).toBe(false);
  await wrapper.get('[aria-label="移入回收站"]').trigger('click');expect(mocks.request.mock.calls.some(([path])=>path==='health-records/trash')).toBe(false);
  await mocks.ask.mock.calls[0][0].run();
  expect(mocks.request).toHaveBeenCalledWith('health-records/trash',{method:'POST',body:JSON.stringify({kind:'intake',id:'intake',revision:3,operation:'trash'})});
  expect(mocks.request.mock.calls.some(([,options])=>options?.method==='DELETE')).toBe(false);expect(wrapper.findAll('button').some(item=>item.text()==='撤销')).toBe(false);wrapper.unmount();
});

it('pause/resume and actual dose remain explicit independent actions',async()=>{
  overview={courses:[course],intakes:[]};const wrapper=mountRecords();await flushPromises();
  await button(wrapper,'暂停').trigger('click');await flushPromises();
  await wrapper.getComponent(MedicationEditor).get('.date-input').setValue('2025-01-03T09:00');
  await wrapper.getComponent(MedicationEditor).get('form').trigger('submit');await flushPromises();
  const pause=mocks.request.mock.calls.find(([path,options])=>path==='medications/course/changes' && options?.method==='POST')!;
  expect(JSON.parse(pause[1].body)).toMatchObject({action:'pause',revision:1,occurredAt:'2025-01-03T09:00'});
  await wrapper.get('.medication-detail-toolbar [aria-label="记一次已服药"]').trigger('click');await flushPromises();
  expect((wrapper.get('input[name="amount"]').element as HTMLInputElement).value).toBe('');
  expect(mocks.request.mock.calls.some(([path,options])=>path==='medications/intakes' && options?.method==='POST')).toBe(false);wrapper.unmount();
});

it('switching members discards an old load, editor, and pending destructive confirmation',async()=>{
  overview={courses:[course],intakes:[intake]};const wrapper=mountRecords({intakeId:'intake'});await flushPromises();
  await wrapper.get('[aria-label="移入回收站"]').trigger('click');const confirm=mocks.ask.mock.calls[0][0];
  await button(wrapper,'编辑').trigger('click');await flushPromises();
  let release!:(value:unknown)=>void;
  const base=mocks.request.getMockImplementation()!;
  mocks.request.mockImplementation((path:string,options?:RequestInit)=>path==='medications?memberId=second' ? new Promise(resolve=>release=resolve) : base(path,options));
  app.selectedMemberId.value='second';app.selectedMember.value={id:'second',permission:'manager'};await flushPromises();
  expect(wrapper.findComponent(MedicationEditor).exists()).toBe(false);
  await confirm.run();expect(mocks.request.mock.calls.some(([path])=>path==='health-records/trash')).toBe(false);
  app.selectedMemberId.value='third';app.selectedMember.value={id:'third',permission:'manager'};overview={courses:[],intakes:[]};await flushPromises();
  release({courses:[{...course,medicationName:'旧成员迟到结果'}],intakes:[]});await flushPromises();
  expect(wrapper.text()).not.toContain('旧成员迟到结果');wrapper.unmount();
});


it('source selection does not introduce a separate process-selection step',async()=>{
 const wrapper=mount(MedicationEditor,{props:{memberId:'member',mode:'course',source}});await flushPromises();
 expect(wrapper.find('.medication-context-confirm').exists()).toBe(false);expect(wrapper.text()).not.toContain('核对关联');expect(wrapper.findAll('[type="submit"]')[0].attributes('disabled')).toBeUndefined();wrapper.unmount();
});

it('quick-add starts with source choices and manual entry retains explicit process context',async()=>{
  const wrapper=mountRecords({processId:'process',add:'course'});await flushPromises();
  expect(mocks.request).toHaveBeenCalledWith('medications?memberId=member');
  expect(wrapper.findComponent(MedicationEditor).exists()).toBe(false);
  await button(wrapper,'手动添加用药').trigger('click');await flushPromises();
  expect(wrapper.getComponent(MedicationEditor).getComponent(MedicationContextPicker).props('modelValue')).toEqual({processId:'process'});
  expect(wrapper.text()).toContain('保存后加入当前健康历程');
  expect(mocks.request.mock.calls.some(([,options])=>options?.method==='POST')).toBe(false);wrapper.unmount();
});

it('a failed create retry reuses its receipt while a deliberately changed draft gets a new key',async()=>{
  const base=mocks.request.getMockImplementation()!;
  mocks.request.mockImplementation((path:string,options?:RequestInit)=>options?.method==='POST' ? Promise.reject(new Error('连接中断')) : base(path,options));
  const wrapper=mount(MedicationEditor,{props:{memberId:'member',mode:'intake'}});await flushPromises();
  await wrapper.get('input[name="medicationName"]').setValue('合成药品');await wrapper.get('input[name="amount"]').setValue('1');
  await wrapper.get('form').trigger('submit');await flushPromises();await wrapper.get('form').trigger('submit');await flushPromises();
  await wrapper.get('input[name="amount"]').setValue('2');await wrapper.get('form').trigger('submit');await flushPromises();
  const keys=mocks.request.mock.calls.filter(([,options])=>options?.method==='POST').map(([,options])=>JSON.parse(options.body).requestKey);
  expect(keys[0]).toMatch(/^[a-zA-Z0-9_-]{16,100}$/);expect(keys[1]).toBe(keys[0]);expect(keys[2]).not.toBe(keys[0]);wrapper.unmount();
});

it('leaving a kept-alive medication page invalidates its open editor and pending recycle-bin confirmation',async()=>{
  overview={courses:[course],intakes:[intake]};const shown=ref(true);
  const host=defineComponent({components:{MedicationRecords,KeepAlive},setup:()=>({shown}),template:'<KeepAlive><MedicationRecords v-if="shown" intake-id="intake" /></KeepAlive>'});
  const wrapper=mount(host);await flushPromises();
  await wrapper.get('[aria-label="移入回收站"]').trigger('click');const confirm=mocks.ask.mock.calls[0][0];
  await button(wrapper,'编辑').trigger('click');await flushPromises();expect(wrapper.findComponent(MedicationEditor).exists()).toBe(true);
  shown.value=false;await flushPromises();await confirm.run();expect(mocks.request.mock.calls.some(([path])=>path==='health-records/trash')).toBe(false);
  shown.value=true;await flushPromises();expect(wrapper.findComponent(MedicationEditor).exists()).toBe(false);wrapper.unmount();
});


it('a course opened from the timeline shows only its own history and actual intakes',async()=>{
  overview={courses:[course,{...course,id:'other-course',medicationName:'无关用药过程'}],intakes:[intake,{...intake,id:'other-intake',courseId:'other-course',medicationName:'无关实际服药'}]};
  const wrapper=mountRecords({courseId:'course'});await flushPromises();
  expect(wrapper.text()).toContain('合成药品');expect(wrapper.text()).toContain('查看使用历史（1）');
  expect(wrapper.text()).toContain('当时规格');expect(wrapper.text()).not.toContain('无关用药过程');expect(wrapper.text()).not.toContain('无关实际服药');
  expect(wrapper.text()).not.toContain('浏览报告中的用药');
  expect(mocks.request.mock.calls.some(([path])=>String(path).startsWith('medications/report-history'))).toBe(false);
  await button(wrapper,'调整').trigger('click');expect(wrapper.getComponent(MedicationEditor).props('course')).toMatchObject({id:'course'});wrapper.unmount();
});

it('an intake opened from a process targets only that original record and its edit history',async()=>{
 overview={courses:[course],intakes:[{...intake,history:[{operation:'edit',recordedAt:'2025-01-03',snapshot:{...intake}}]},{...intake,id:'different-intake',medicationName:'其他剂次'}]};
 const wrapper=mountRecords({intakeId:'intake'});await flushPromises();expect(wrapper.text()).toContain('已服用');expect(wrapper.text()).toContain('修订记录（1）');expect(wrapper.text()).not.toContain('其他剂次');expect(wrapper.text()).not.toContain('撤销');wrapper.unmount();
});

it('a missing target or mismatched member never exposes unrelated medications',async()=>{
  overview={courses:[course],intakes:[intake]};const wrapper=mountRecords({courseId:'missing'});await flushPromises();
  expect(wrapper.get('[role="alert"]').text()).toContain('这条用药记录已变化');expect(wrapper.text()).not.toContain('合成药品');
  overview={courses:[{...course,memberId:'someone-else'}],intakes:[]};await wrapper.setProps({courseId:'course'});await flushPromises();
  expect(wrapper.get('[role="alert"]').text()).toContain('当前成员不一致');expect(wrapper.text()).not.toContain('合成药品');wrapper.unmount();
});

it('an unscoped add offers source choices then reports a manual save without listing unrelated records',async()=>{
  overview={courses:[course],intakes:[intake]};const wrapper=mountRecords({add:'course'});await flushPromises();
  expect(wrapper.findComponent(MedicationEditor).exists()).toBe(false);
  expect(button(wrapper,'从报告带入').exists()).toBe(true);
  await button(wrapper,'手动添加用药').trigger('click');await flushPromises();
  expect(wrapper.findComponent(MedicationEditor).exists()).toBe(true);expect(wrapper.text()).not.toContain('当前用药过程');
  expect(mocks.request.mock.calls.some(([path])=>String(path).startsWith('medications/report-history'))).toBe(false);
  await wrapper.getComponent(MedicationEditor).get('input[name="medicationName"]').setValue('新合成记录');
  await wrapper.getComponent(MedicationEditor).get('form').trigger('submit');await flushPromises();
  expect(wrapper.findComponent(MedicationEditor).exists()).toBe(false);expect(wrapper.get('.medication-saved').text()).toContain('已同步到记录列表');
  expect(wrapper.emitted('updated')).toHaveLength(1);wrapper.unmount();
});

it('a modal closes and releases scroll lock when the selected member changes',async()=>{
  const wrapper=mount(MedicationRecordModal,{props:{open:true,courseId:'course'},global:{stubs:{Teleport:true,MedicationRecords:true}}});await flushPromises();
  expect(wrapper.get('[role="dialog"]').attributes('aria-label')).toBe('用药记录');expect(document.body.style.overflow).toBe('hidden');
  app.selectedMemberId.value='other';app.selectedMember.value={id:'other',permission:'manager'};await flushPromises();
  expect(wrapper.emitted('close')).toHaveLength(1);expect(wrapper.find('[role="dialog"]').exists()).toBe(false);expect(document.body.style.overflow).toBe('');wrapper.unmount();
});


it('a report opens its current prescription and all confirmed courses, including an obsolete source medication id',async()=>{
  overview={courses:[{...course,source:{...source,medicationId:'old-source'},medicationName:'曾确认的药品'},
    {...course,id:'unrelated',sourceReportId:'other-report',medicationName:'无关报告药品'}],intakes:[intake]};
  const base=mocks.request.getMockImplementation()!;
  mocks.request.mockImplementation((path:string,options?:RequestInit)=>path.startsWith('medications/report-history') ? Promise.resolve([
    {...source,medicationId:'reparsed-source',medicationName:'当前识别药品'},
    {...source,medicationId:'unrelated-source',reportId:'other-report',medicationName:'无关处方药品'}]) : base(path,options));
  const wrapper=mountRecords({reportId:'report'});await flushPromises();
  expect(wrapper.emitted('heading')?.at(-1)).toEqual([{title:'合成用药单',category:'medication'}]);expect(wrapper.find('.medication-report-heading').exists()).toBe(false);expect(wrapper.text()).toContain('曾确认的药品');expect(wrapper.text()).toContain('当前识别药品');
  expect(wrapper.text()).not.toContain('无关报告药品');expect(wrapper.text()).not.toContain('无关处方药品');
  expect(wrapper.text()).toContain('这张报告已有 1 项确认用药');expect(button(wrapper,'调整').exists()).toBe(true);
  await wrapper.findAll('.medication-source-link')[0].trigger('click');expect(wrapper.getComponent(ReportDetailModal).props()).toMatchObject({open:true,reportId:'report'});
  expect(mocks.request.mock.calls.some(([,options])=>options?.method)).toBe(false);wrapper.unmount();
});

it('an unparsed prescription supports manual entry without inheriting retired event groups',async()=>{
  const base=mocks.request.getMockImplementation()!;
  mocks.request.mockImplementation((path:string,options?:RequestInit)=>path.startsWith('medications/report-history') ? Promise.resolve([]) : base(path,options));
  const wrapper=mountRecords({reportId:'report'});await flushPromises();
  expect(wrapper.text()).toContain('暂未识别出药品');expect(wrapper.text()).not.toContain('已确认的用药');expect(wrapper.text()).not.toContain('服用补充');
  await button(wrapper,'手动添加用药').trigger('click');await flushPromises();
  const editor=wrapper.getComponent(MedicationEditor);expect(editor.props('source')).toBeUndefined();
  expect(editor.getComponent(MedicationContextPicker).props('modelValue')).toEqual({});
  expect((editor.get('input[name="medicationName"]').element as HTMLInputElement).value).toBe('');
  await editor.get('input[name="medicationName"]').setValue('手写合成药品');await editor.get('form').trigger('submit');await flushPromises();
  const call=mocks.request.mock.calls.find(([path,options])=>path==='medications' && options?.method==='POST')!;
  expect(JSON.parse(call[1].body).sourceMedicationId).toBeUndefined();wrapper.unmount();
});

it('a report from another member cannot reveal source controls or allow a manual record',async()=>{
  const base=mocks.request.getMockImplementation()!;
  mocks.request.mockImplementation((path:string,options?:RequestInit)=>path.startsWith('medications/documents') ? Promise.resolve([{...documentRecord,memberId:'other-member'}]) : base(path,options));
  const wrapper=mountRecords({reportId:'report'});await flushPromises();
  expect(wrapper.get('[role="alert"]').text()).toContain('不属于当前成员');expect(wrapper.text()).not.toContain('合成药品');
  expect(wrapper.findAll('button').map(item=>item.text())).toEqual(['重试']);expect(wrapper.findComponent(MedicationEditor).exists()).toBe(false);
  expect(wrapper.findComponent(ReportDetailModal).exists()).toBe(false);wrapper.unmount();
});

it('confirmed prescriptions offer their existing record first and repeated starts require a separate acknowledgement',async()=>{
  overview={courses:[course],intakes:[]};const confirmed={...source,confirmedCourseIds:['course']};
  const base=mocks.request.getMockImplementation()!;
  mocks.request.mockImplementation((path:string,options?:RequestInit)=>path.startsWith('medications/report-history') ? Promise.resolve([confirmed]) : base(path,options));
  const wrapper=mountRecords({reportId:'report'});await flushPromises();
  expect(wrapper.text()).toContain('已有确认记录');expect(button(wrapper,'查看已确认用药').exists()).toBe(true);
  expect(wrapper.findAll('button').some(item=>item.text()==='确认开始用药')).toBe(false);
  const repeat=wrapper.get('.medication-actions > .medication-repeat');expect(repeat.text()).toBe('再次开始用药');expect(repeat.element.closest('details')).toBeNull();
  await repeat.trigger('click');await flushPromises();
  const editor=wrapper.getComponent(MedicationEditor);expect(editor.get('button[type="submit"]').attributes('disabled')).toBeDefined();
  await editor.get('form').trigger('submit');await flushPromises();expect(mocks.request.mock.calls.some(([,options])=>options?.method==='POST')).toBe(false);
  await editor.get('.medication-repeat-confirm input').setValue(true);await editor.get('form').trigger('submit');await flushPromises();
  expect(mocks.request.mock.calls.some(([path,options])=>path==='medications' && options?.method==='POST')).toBe(true);wrapper.unmount();
});

it('a successful manual create focuses the saved record instead of reopening a blank form',async()=>{
  const created={...course,id:'new-course',medicationName:'刚保存的合成药品'};overview={courses:[course],intakes:[]};
  const base=mocks.request.getMockImplementation()!;
  mocks.request.mockImplementation((path:string,options?:RequestInit)=>{
    if(path==='medications' && options?.method==='POST'){overview={courses:[course,created],intakes:[]};return Promise.resolve(created);}
    return base(path,options);
  });
  const wrapper=mountRecords({add:'course'});await flushPromises();await button(wrapper,'手动添加用药').trigger('click');await flushPromises();
  const editor=wrapper.getComponent(MedicationEditor);await editor.get('input[name="medicationName"]').setValue(created.medicationName);
  await editor.get('form').trigger('submit');await flushPromises();
  expect(wrapper.text()).toContain('刚保存的合成药品');expect(wrapper.findComponent(MedicationEditor).exists()).toBe(false);
  expect(wrapper.get('.medication-saved').text()).toContain('已保存');expect(button(wrapper,'调整').exists()).toBe(true);wrapper.unmount();
});

it('new medication links actual records without loading or choosing process containers',async()=>{
 const wrapper=mount(MedicationContextPicker,{props:{memberId:'member',modelValue:{relatedRecords:[{kind:'symptom',id:'symptom'}]}}});await flushPromises();
 expect(wrapper.get('.record-association-field').text()).toContain('已选择 1 条相关记录');expect(wrapper.find('input[type="checkbox"]').exists()).toBe(false);expect(wrapper.emitted('update:modelValue')).toBeUndefined();
 await button(wrapper,'调整历程关联').trigger('click');await flushPromises();expect(document.querySelector('.record-association-modal .health-record-picker')).not.toBeNull();expect(wrapper.find('.health-record-picker').exists()).toBe(false);expect(wrapper.text()).not.toContain('既有关联');wrapper.unmount();
});

it('the shared course selector fills drug facts without inventing an actual dose',async()=>{
  const wrapper=mount(MedicationEditor,{props:{memberId:'member',mode:'intake',courses:[course]}});await flushPromises();
  const picker=wrapper.getComponent(FormSelect);picker.vm.$emit('update:modelValue','course');await flushPromises();picker.vm.$emit('change','course');await flushPromises();
  expect((wrapper.get('input[name="medicationName"]').element as HTMLInputElement).value).toBe('合成药品');
  expect((wrapper.get('input[name="amount"]').element as HTMLInputElement).value).toBe('');
  expect(wrapper.getComponent(MedicationContextPicker).props('modelValue')).toEqual({});
  picker.vm.$emit('update:modelValue','');await flushPromises();picker.vm.$emit('change','');await flushPromises();
  expect(wrapper.getComponent(MedicationContextPicker).props('modelValue')).toEqual({});
  wrapper.getComponent(MedicationContextPicker).vm.$emit('update:modelValue',{relatedRecords:[{kind:'symptom',id:'manual-symptom'}]});await flushPromises();
  picker.vm.$emit('update:modelValue','course');await flushPromises();picker.vm.$emit('change','course');await flushPromises();
  expect(wrapper.getComponent(MedicationContextPicker).props('modelValue')).toEqual({relatedRecords:[{kind:'symptom',id:'manual-symptom'}]});
  picker.vm.$emit('update:modelValue','');await flushPromises();picker.vm.$emit('change','');await flushPromises();
  expect(wrapper.getComponent(MedicationContextPicker).props('modelValue')).toEqual({relatedRecords:[{kind:'symptom',id:'manual-symptom'}]});
  expect(wrapper.get('.medication-extra').attributes('open')).toBeUndefined();expect(wrapper.text()).toContain('补充药品信息（选填）');wrapper.unmount();
});

it('a source report offers an existing course without silently creating another one',async()=>{
  const base=mocks.request.getMockImplementation()!;
  mocks.request.mockImplementation((path:string,options?:RequestInit)=>path.startsWith('medications/report-history') ? Promise.resolve([{...source,confirmedCourseIds:['course']}]) : base(path,options));
  const wrapper=mount(ReportMedicationUseButton,{props:{memberId:'member',medicationId:'source'},global:{stubs:{MedicationRecordModal:true}}});
  await button(wrapper,'确认实际使用').trigger('click');await flushPromises();
  expect(wrapper.findComponent(MedicationEditor).exists()).toBe(false);await button(wrapper,'查看已确认用药').trigger('click');
  expect(wrapper.getComponent(MedicationRecordModal).props()).toMatchObject({open:true,courseId:'course'});
  expect(mocks.request.mock.calls.some(([,options])=>options?.method)).toBe(false);wrapper.unmount();
});

it('the modal focuses its close control, traps Tab, closes on Escape and restores the invoking control',async()=>{
  const trigger=document.createElement('button');document.body.appendChild(trigger);trigger.focus();
  const target=document.createElement('div');document.body.appendChild(target);
  const wrapper=mount(MedicationRecordModal,{attachTo:target,props:{open:true,courseId:'course'},global:{stubs:{Teleport:true,MedicationRecords:{template:'<button class="last-control">内容末尾</button>'}}}});await flushPromises();
  expect(document.activeElement).toBe(wrapper.get('[aria-label="关闭用药记录"]').element);
  (wrapper.get('.last-control').element as HTMLElement).focus();window.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',bubbles:true}));
  expect(document.activeElement).toBe(wrapper.get('[aria-label="关闭用药记录"]').element);
  const layer=document.createElement('div');layer.className='form-select-layer';document.body.appendChild(layer);
  window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));expect(wrapper.emitted('close')).toBeUndefined();layer.remove();
  window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await flushPromises();expect(wrapper.emitted('close')).toHaveLength(1);
  await wrapper.setProps({open:false});expect(document.activeElement).toBe(trigger);wrapper.unmount();target.remove();trigger.remove();
});


it.each(['adjust','pause','resume','stop'] as const)('a same-day %s preserves time precision after an existing timestamped change',async(action)=>{
  vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-10-23T10:15:00'));
  const previous={...course,status:action==='resume' ? 'paused' as const : 'active' as const,startedAt:'2026-10-23T09:00',lastChangedAt:'2026-10-23T09:30'};
  const base=mocks.request.getMockImplementation()!;
  mocks.request.mockImplementation((path:string,options?:RequestInit)=>{
    if(path==='medications/course/changes' && options?.method==='POST'){
      const payload=JSON.parse(String(options.body));
      if(Date.parse(payload.occurredAt)<Date.parse(previous.lastChangedAt))return Promise.reject(new Error('变更时间不能早于上次变更'));
      return Promise.resolve({...previous,lastChangedAt:payload.occurredAt});
    }
    return base(path,options);
  });
  const wrapper=mount(MedicationEditor,{props:{memberId:'member',mode:'course',course:previous,action}});
  try{
    await flushPromises();expect(wrapper.getComponent(DateTimePicker).props('showTime')).toBe(true);
    expect((wrapper.get('.date-input').element as HTMLInputElement).value).toBe('2026-10-23T10:15');
    await wrapper.get('form').trigger('submit');await flushPromises();
    const call=mocks.request.mock.calls.find(([path,options])=>path==='medications/course/changes' && options?.method==='POST')!;
    expect(JSON.parse(call[1].body)).toMatchObject({action,occurredAt:'2026-10-23T10:15',revision:1});
    expect(wrapper.emitted('saved')).toHaveLength(1);expect(wrapper.find('[role="alert"]').exists()).toBe(false);
  }finally{wrapper.unmount();vi.useRealTimers();}
});

it.each(['2026-10-23T01:15:30Z','2026-10-23T09:15:30+08:00'])('editing an intake with %s displays local time while preserving its original instant and seconds',async(takenAt)=>{
  const wrapper=mount(MedicationEditor,{props:{memberId:'member',mode:'intake',intake:{...intake,takenAt}}});await flushPromises();
  const displayed=(wrapper.get('.date-input').element as HTMLInputElement).value;
  expect(displayed).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  expect(Date.parse(displayed)).toBe(Date.parse(takenAt)-30_000);
  await wrapper.get('input[name="amount"]').setValue('0.5');await wrapper.get('form').trigger('submit');await flushPromises();
  const call=mocks.request.mock.calls.find(([path,options])=>path==='medications/intakes/intake' && options?.method==='PATCH')!;
  expect(JSON.parse(call[1].body)).toMatchObject({takenAt,amount:'0.5',revision:3});wrapper.unmount();
});


it('targeted medication details use labeled facts without aggregate headings and return after editing',async()=>{
  overview={courses:[course],intakes:[intake]};
  const wrapper=mountRecords({courseId:'course'});await flushPromises();
  const facts=wrapper.get('.medication-detail .preview-facts');
  expect(facts.text()).toContain('药品规格合成规格');expect(facts.text()).toContain('每次用量1 片');
  expect(facts.text()).toContain('用药频次每日一次');expect(facts.text()).toContain('来源报告合成报告');
  expect(wrapper.find('.medication-section').exists()).toBe(false);
  expect(wrapper.find('.medication-detail-name').exists()).toBe(false);
  expect(wrapper.text()).not.toContain('服用补充（选填）');
  expect(wrapper.get('.medication-detail-intakes').text()).toContain('当时规格');
  await button(wrapper,'合成报告').trigger('click');
  expect(wrapper.getComponent(ReportDetailModal).props()).toMatchObject({open:true,reportId:'report'});
  await button(wrapper,'调整').trigger('click');await flushPromises();
  expect(wrapper.find('.medication-detail').exists()).toBe(false);
  wrapper.getComponent(MedicationEditor).vm.$emit('cancel');await flushPromises();
  expect(wrapper.find('.medication-detail').exists()).toBe(true);wrapper.unmount();
});

it.each(['paused','stopped'] as const)('targeted %s courses retain the matching actions and optional source snapshot',async(status)=>{
  overview={courses:[{...course,status,lastChangedAt:'2025-01-03',stoppedAt:status==='stopped'?'2025-01-03':null,sourceReportId:null}],intakes:[]};
  const wrapper=mountRecords({courseId:'course'});await flushPromises();
  expect(wrapper.text()).toContain(status==='paused'?'已暂停':'已停止');
  expect(wrapper.text()).toContain('原报告不可用，已保留确认时快照');
  expect(wrapper.text()).toContain('确认时的处方');
  expect(wrapper.find('.medication-detail-intakes').exists()).toBe(false);
  if(status==='paused'){
    expect(wrapper.get('.preview-facts').text()).toContain('最近变更');
    await button(wrapper,'恢复').trigger('click');
    expect(wrapper.getComponent(MedicationEditor).props('action')).toBe('resume');
  }else{
    expect(wrapper.get('.preview-facts').text()).toContain('停止用药');
    expect(wrapper.findAll('button').some(item=>item.text()==='调整'||item.text()==='停止')).toBe(false);
    await wrapper.get('[aria-label="补记一次已服药"]').trigger('click');
    expect(wrapper.getComponent(MedicationEditor).props()).toMatchObject({mode:'intake',course:{id:'course'}});
  }
  wrapper.unmount();
});

it('single intake detail shows its own snapshot rather than current course facts and supports editing',async()=>{
  overview={courses:[course],intakes:[{...intake,note:'合成服用备注'}]};
  const wrapper=mountRecords({intakeId:'intake'});await flushPromises();
  const facts=wrapper.get('.medication-detail .preview-facts');
  expect(facts.text()).toContain('药品规格当时规格');expect(facts.text()).toContain('服用量1 片');
  expect(facts.text()).toContain('合成服用备注');expect(facts.text()).not.toContain('每日一次');
  expect(wrapper.text()).not.toContain('已确认的用药');expect(wrapper.text()).not.toContain('开始用药');
  await button(wrapper,'编辑').trigger('click');await flushPromises();
  expect(wrapper.getComponent(MedicationEditor).props('intake')).toMatchObject({id:'intake',specification:'当时规格'});wrapper.unmount();
});

it('viewers see current course intakes with no removal or edit controls',async()=>{
 app.selectedMember.value.permission='viewer';overview={courses:[course],intakes:[intake]};const wrapper=mountRecords({courseId:'course'});await flushPromises();
 expect(wrapper.find('.medication-detail-intake').exists()).toBe(true);expect(wrapper.find('.medication-detail-checkbox').exists()).toBe(false);
 expect(wrapper.findAll('button').some(item=>item.text()==='编辑'||item.text()==='撤销')).toBe(false);wrapper.unmount();
});

it('direct medication dialogs use the loaded record name and forward a detail close',async()=>{
  overview={courses:[course],intakes:[]};
  const wrapper=mount(MedicationRecordModal,{props:{open:true,courseId:'course'},global:{stubs:{Teleport:true}}});
  await flushPromises();expect(wrapper.get('[role="dialog"]').attributes('aria-label')).toBe('合成药品');
  expect(wrapper.get('.report-scrolling-title').text()).toBe('合成药品');
  expect(wrapper.find('.medication-detail-name').exists()).toBe(false);
  wrapper.getComponent(MedicationRecords).vm.$emit('close');await flushPromises();
  expect(wrapper.emitted('close')).toHaveLength(1);wrapper.unmount();
});


it.each(['course','intake'] as const)('%s details keep their status and deletion in one toolbar, including read-only views',async kind=>{
 overview={courses:[course],intakes:[intake]};
 const wrapper=mountRecords(kind==='course'?{courseId:'course'}:{intakeId:'intake'});await flushPromises();
 const toolbar=wrapper.get('.medication-detail > .record-detail-toolbar');
 expect(toolbar.get('.preview-heading').text()).toContain(kind==='course'?'用药中':'已服用');
 expect(toolbar.get('[aria-label="移入回收站"]').exists()).toBe(true);
 expect(toolbar.get('.medication-toolbar-actions').findAll('button').map(item=>item.text())).toEqual(kind==='course'?['记服药','调整','暂停','停止']:['编辑']);
 expect(wrapper.find('.medication-detail > .medication-detail-actions').exists()).toBe(false);
 // History entries still edit their own intake, not the parent course.
 if(kind==='course'){const row=wrapper.get('.medication-detail-intake .medication-detail-actions');expect(row.text()).toBe('编辑');expect(row.get('[aria-label="移入回收站"]').exists()).toBe(true);}
 expect(wrapper.findAll('.medication-detail > .record-detail-toolbar')).toHaveLength(1);
 expect(wrapper.findAll('button').some(item=>item.text()==='撤销')).toBe(false);
 app.selectedMember.value.permission='viewer';await flushPromises();
 expect(wrapper.get('.record-detail-toolbar .preview-heading').text()).toContain(kind==='course'?'用药中':'已服用');
 expect(wrapper.find('[aria-label="移入回收站"]').exists()).toBe(false);wrapper.unmount();
});

it('the merged medication toolbar still trashes its exact course and closes the detail',async()=>{
 overview={courses:[course],intakes:[intake]};const wrapper=mountRecords({courseId:'course'});await flushPromises();
 await wrapper.get('.record-detail-toolbar [aria-label="移入回收站"]').trigger('click');
 await mocks.ask.mock.calls[0][0].run();await flushPromises();
 expect(mocks.request).toHaveBeenCalledWith('health-records/trash',{method:'POST',body:JSON.stringify({kind:'medication',id:'course',revision:1,operation:'trash'})});
 expect(wrapper.emitted('close')).toHaveLength(1);wrapper.unmount();
});


it.each(['list','course'] as const)('%s removes only the chosen intake through the recycle bin and refreshes in place',async view=>{
 overview={courses:[course],intakes:[intake,{...intake,id:'other-intake'}]};const base=mocks.request.getMockImplementation()!;
 mocks.request.mockImplementation((path:string,options?:RequestInit)=>{
  if(path==='health-records/trash'&&options?.method==='POST'){const {id}=JSON.parse(String(options.body));overview={...overview,intakes:(overview.intakes as typeof intake[]).filter(item=>item.id!==id)};return Promise.resolve({});}
  return base(path,options);
 });
 const wrapper=mountRecords(view==='course'?{courseId:'course'}:{reportId:'report'});await flushPromises();
 const removal=wrapper.findAll('.medication-intake-toolbar [aria-label="移入回收站"]')[0];await removal.trigger('click');await flushPromises();
 expect(mocks.request.mock.calls.some(([path])=>path==='health-records/trash')).toBe(false);
 const confirm=mocks.ask.mock.calls[0][0];expect(confirm.title).toBe('移入回收站');expect(confirm.message).toContain('保留 30 天');await confirm.run();await flushPromises();
 expect(mocks.request).toHaveBeenCalledWith('health-records/trash',{method:'POST',body:JSON.stringify({kind:'intake',id:'intake',revision:3,operation:'trash'})});
 expect(wrapper.findAll('.medication-intake-toolbar')).toHaveLength(1);expect(wrapper.emitted('close')).toBeUndefined();expect(wrapper.emitted('updated')).toHaveLength(1);
 if(view==='course')expect(wrapper.find('.medication-detail > .record-detail-toolbar').exists()).toBe(true);
 expect(mocks.request.mock.calls.some(([,options])=>options?.method==='DELETE')).toBe(false);wrapper.unmount();
});

it('single-intake detail opens its exact source prescription and retains a parent medication entry',async()=>{
 overview={courses:[course],intakes:[{...intake,sourceReportId:'report',source}]};
 const wrapper=mount(MedicationRecords,{props:{intakeId:'intake',openRelatedInPlace:true}});entryDialogs.push(wrapper);await flushPromises();
 const facts=wrapper.get('.medication-detail .record-detail-facts');expect(facts.text()).toContain('所属用药');expect(facts.text()).toContain('来源用药单');
 await facts.findAll('button').find(item=>item.text()===source.reportTitle)!.trigger('click');await flushPromises();
 expect(wrapper.get('.source-preview').text()).toBe('report');
 await facts.findAll('button').find(item=>item.text().includes(course.medicationName))!.trigger('click');
 expect(wrapper.emitted('openRecord')).toEqual([[{kind:'medication',id:'course'}]]);
});
it('intake source snapshots remain readable without offering inaccessible report links',async()=>{
 overview={courses:[],intakes:[{...intake,courseId:null,sourceReportId:null,source}]};
 const wrapper=mountRecords({intakeId:'intake'});entryDialogs.push(wrapper);await flushPromises();
 const facts=wrapper.get('.medication-detail .record-detail-facts');expect(facts.text()).toContain('原报告不可用，已保留来源快照');expect(facts.findAll('button')).toHaveLength(0);
 expect(facts.text()).not.toContain('所属用药');
});
it('an intake brought from a prescription submits the concrete source without confirming a course',async()=>{
 const wrapper=mount(MedicationEditor,{props:{memberId:'member',mode:'intake',source}});entryDialogs.push(wrapper);await flushPromises();
 expect(wrapper.get('input[name=amount]').element.value).toBe('');await wrapper.get('input[name=amount]').setValue('2');await wrapper.get('form').trigger('submit');await flushPromises();
 const call=mocks.request.mock.calls.find(([path,options])=>path==='medications/intakes'&&options?.method==='POST')!;
 expect(JSON.parse(call[1].body)).toMatchObject({sourceMedicationId:'source',courseId:null,amount:'2'});
 expect(JSON.parse(call[1].body).confirmed).toBeUndefined();expect(wrapper.text()).not.toContain('列为正在用药');
});


it.each(['course','intake'] as const)('keeps the first %s draft mounted during a background refresh',async(mode)=>{
 const wrapper=mount(MedicationRecords,{props:{entryMode:mode}});entryDialogs.push(wrapper);await flushPromises();
 const editor=wrapper.getComponent(MedicationEditor);
 await editor.get('[name="medicationName"]').setValue('合成未保存药品');
 await editor.get('[name="specification"]').setValue('合成未保存规格');
 if(mode==='intake')await editor.get('[name="amount"]').setValue('0.5');
 let release!:(value:unknown)=>void;
 const fallback=mocks.request.getMockImplementation()!;
 mocks.request.mockImplementation((path:string,options?:RequestInit)=>path.startsWith('medications?')?new Promise(resolve=>release=resolve):fallback(path,options));
 app.dataVersion.value++;await flushPromises();
 expect(wrapper.findComponent(MedicationEditor).exists()).toBe(true);
 expect(wrapper.getComponent(MedicationEditor).element).toBe(editor.element);
 release({courses:[],intakes:[]});await flushPromises();
 expect(wrapper.get('[name="medicationName"]').element.value).toBe('合成未保存药品');
 expect(wrapper.get('[name="specification"]').element.value).toBe('合成未保存规格');
 if(mode==='intake')expect(wrapper.get('[name="amount"]').element.value).toBe('0.5');
});

it('clears the actual dose when switching to a different drug without losing the selected process',async()=>{
 const other={...course,id:'second-course',medicationName:'合成另一药品',specification:'合成另一规格'};
 const wrapper=mount(MedicationEditor,{props:{memberId:'member',mode:'intake',courses:[course,other],initialContext:{processId:'process'}}});entryDialogs.push(wrapper);await flushPromises();
 const picker=wrapper.getComponent(FormSelect);
 const choose=async(id:string)=>{picker.vm.$emit('update:modelValue',id);await flushPromises();picker.vm.$emit('change',id);await flushPromises();};
 await choose('course');await wrapper.get('[name="amount"]').setValue('0.5');await wrapper.getComponent(MedicationUnitPicker).findAll('button').find(b=>b.text()==='片')!.trigger('click');
 await choose('course');expect(wrapper.get('[name="amount"]').element.value).toBe('0.5');
 await choose('second-course');
 expect(wrapper.get('[name="medicationName"]').element.value).toBe('合成另一药品');
 expect(wrapper.get('[name="amount"]').element.value).toBe('');expect(wrapper.getComponent(MedicationUnitPicker).props('modelValue')).toBe('');
 expect(wrapper.getComponent(MedicationContextPicker).props('modelValue')).toEqual({processId:'process'});
 await wrapper.get('[name="amount"]').setValue('1');await wrapper.getComponent(MedicationUnitPicker).findAll('button').find(b=>b.text()==='粒')!.trigger('click');
 await choose('');expect(wrapper.get('[name="amount"]').element.value).toBe('1');
});


it('changing the selected course on an existing intake clears its previous actual dose',async()=>{
 const wrapper=mount(MedicationEditor,{props:{memberId:'member',mode:'intake',intake,courses:[course,{...course,id:'other',medicationName:'合成另一药品'}]}});entryDialogs.push(wrapper);await flushPromises();
 expect(wrapper.get('[name="amount"]').element.value).toBe('1');
 const picker=wrapper.getComponent(FormSelect);picker.vm.$emit('update:modelValue','other');await flushPromises();picker.vm.$emit('change','other');await flushPromises();
 expect(wrapper.get('[name="amount"]').element.value).toBe('');expect(wrapper.getComponent(MedicationUnitPicker).props('modelValue')).toBe('');
 expect(wrapper.get('[type="submit"]').text()).toBe('保存修改');
});

it.each(['course','intake'] as const)('blocks duplicate %s saves and keeps failed drafts available for retry',async(mode)=>{
 let reject!:(error:Error)=>void;const fallback=mocks.request.getMockImplementation()!;
 mocks.request.mockImplementation((path:string,options?:RequestInit)=>options?.method==='POST'?new Promise((_resolve,fail)=>reject=fail):fallback(path,options));
 const wrapper=mount(MedicationEditor,{props:{memberId:'member',mode,source,initialContext:{processId:'process'},hideHeader:true}});entryDialogs.push(wrapper);await flushPromises();
 if(mode==='intake')await wrapper.get('[name="amount"]').setValue('0.5');
 await wrapper.get('form').trigger('submit');await wrapper.get('form').trigger('submit');await flushPromises();
 expect(mocks.request.mock.calls.filter(([,options])=>options?.method==='POST')).toHaveLength(1);
 expect(wrapper.get('[type="submit"]').attributes('disabled')).toBeDefined();
 reject(new Error('合成连接中断'));await flushPromises();
 expect(wrapper.get('[role="alert"]').text()).toBe('合成连接中断');
 expect(wrapper.get('[name="medicationName"]').element.value).toBe(source.medicationName);
 expect(wrapper.getComponent(MedicationContextPicker).props('modelValue')).toEqual({processId:'process'});
 expect(wrapper.get('[type="submit"]').attributes('disabled')).toBeUndefined();
 if(mode==='intake'){expect(wrapper.get('[name="amount"]').element.value).toBe('0.5');expect(wrapper.get('[type="submit"]').text()).toBe('新增服药记录');}
});


it('a report drug opens the shared independent confirmation dialog and returns the saved course',async()=>{
 const wrapper=mount(ReportMedicationUseButton,{props:{memberId:'member',medicationId:'source'},global:{stubs:{MedicationRecordModal:true}}});entryDialogs.push(wrapper);
 await button(wrapper,'确认实际使用').trigger('click');await flushPromises();
 const editor=wrapper.findAllComponents(MedicationRecordModal).find(dialog=>dialog.props('entryMode')==='course')!;
 expect(editor.props()).toMatchObject({open:true,entryMode:'course',entrySource:source});
 expect(wrapper.findComponent(MedicationEditor).exists()).toBe(false);
 editor.vm.$emit('close');await flushPromises();expect(button(wrapper,'确认实际使用').exists()).toBe(true);
 await button(wrapper,'确认实际使用').trigger('click');await flushPromises();
 wrapper.findAllComponents(MedicationRecordModal).find(dialog=>dialog.props('entryMode')==='course')!.vm.$emit('completed',course);await flushPromises();
 expect(wrapper.findAllComponents(MedicationRecordModal).find(dialog=>dialog.props('courseId')===course.id)?.props('open')).toBe(true);
});


it('completes a report confirmation through the shared modal and opens the resulting medication',async()=>{
 const fallback=mocks.request.getMockImplementation()!;
 mocks.request.mockImplementation(async(path:string,options?:RequestInit)=>{
  if(path==='medications'&&options?.method==='POST'){overview={courses:[course],intakes:[]};return structuredClone(course);}
  return fallback(path,options);
 });
 const wrapper=mount(ReportMedicationUseButton,{props:{memberId:'member',medicationId:'source'},attachTo:document.body});entryDialogs.push(wrapper);
 await button(wrapper,'确认实际使用').trigger('click');await flushPromises();
 const dialog=visibleEntryDialogs()[0]!;expect(dialog.attributes('aria-label')).toBe('确认开始用药');
 expect(dialog.get('[name="medicationName"]').element.value).toBe(source.medicationName);
 await dialog.get('form').trigger('submit');await flushPromises();
 expect(visibleEntryDialogs()).toHaveLength(1);expect(visibleEntryDialogs()[0]!.attributes('aria-label')).toBe(course.medicationName);
 expect(visibleEntryDialogs()[0]!.find('.medication-editor').exists()).toBe(false);
 expect(app.notifyDataChanged).toHaveBeenCalledOnce();
});


it.each(['course','intake'] as const)('saves a directly selected %s dose unit without opening a dropdown or submitting early',async(mode)=>{
 const wrapper=mount(MedicationEditor,{props:{memberId:'member',mode,source}});entryDialogs.push(wrapper);await flushPromises();
 const picker=wrapper.getComponent(MedicationUnitPicker);expect(picker.find('.form-select').exists()).toBe(false);
 await picker.findAll('button').find(b=>b.text()==='粒')!.trigger('click');await flushPromises();
 expect(mocks.request.mock.calls.some(([,options])=>options?.method)).toBe(false);
 if(mode==='intake')await wrapper.get('[name="amount"]').setValue('1');
 await wrapper.get('form').trigger('submit');await flushPromises();
 const call=mocks.request.mock.calls.find(([,options])=>options?.method==='POST')!;
 expect(JSON.parse(String(call[1].body))[mode==='course'?'doseUnit':'amountUnit']).toBe('粒');
});
