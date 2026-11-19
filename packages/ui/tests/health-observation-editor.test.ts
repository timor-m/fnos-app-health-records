import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {DOMWrapper,flushPromises,mount} from '@vue/test-utils';
import {ref} from 'vue';
import Modal from '../src/components/ObservationEditorModal.vue';
import type {HealthObservation} from '../../shared/health-observations';
const mocks=vi.hoisted(()=>({request:vi.fn(),ask:vi.fn()}));
const app={selectedMemberId:ref('member'),selectedMember:ref({id:'member',permission:'manager'}),notifyDataChanged:vi.fn()};
vi.mock('../src/utils/api',()=>({request:mocks.request}));vi.mock('../src/composables/useAppContext',()=>({useAppContext:()=>app}));vi.mock('../src/composables/useConfirm',()=>({useConfirm:()=>({ask:mocks.ask})}));vi.mock('../src/composables/useToast',()=>({useToast:()=>({show:vi.fn()})}));
const entry=(kind:'symptom'|'intake'='symptom'):HealthObservation=>({ref:{kind,id:'saved'},record:{kind,id:kind==='symptom'?'source':'saved'},memberId:'member',name:'合成记录',recordedAt:'2026-01-02T08:00:00',revision:1,category:kind==='symptom'?'temperature':'intake',change:null,severity:null,measurementValue:kind==='symptom'?'38.2':null,measurementUnit:kind==='symptom'?'℃':null,amount:kind==='intake'?'1':null,amountUnit:kind==='intake'?'片':null,description:'合成说明'});
let wrapper:ReturnType<typeof mount>;const dialog=()=>new DOMWrapper(document.body).get('.observation-editor-modal');
const stubDate={props:['modelValue'],emits:['update:modelValue'],template:'<input aria-label="变化记录时间" :value="modelValue" @input="$emit(\'update:modelValue\',$event.target.value)"/>'};
async function render(props:any={target:{kind:'symptom',id:'saved'}}){wrapper=mount(Modal,{props:{memberId:'member',...props},attachTo:document.body,global:{stubs:{DateTimePicker:stubDate}}});await flushPromises();}
beforeEach(()=>{vi.clearAllMocks();app.selectedMemberId.value='member';app.selectedMember.value={id:'member',permission:'manager'};mocks.request.mockImplementation(async(path:string,options?:RequestInit)=>({...entry(path.includes('/intake/')?'intake':'symptom'),...(options?.method==='PATCH'?{revision:2}:{})}));});
afterEach(()=>{wrapper?.unmount();document.body.innerHTML='';});
it.each(['symptom','intake'] as const)('loads the exact %s observation and edits its original identity and revision',async kind=>{
 await render({target:{kind,id:'saved'},processId:'process'});expect(dialog().attributes('aria-label')).toBe('修改记录 · 合成记录');expect(dialog().get('button[type=submit]').text()).toBe('保存修改');expect(mocks.request.mock.calls[0][0]).toContain(`health-observations/${kind}/saved?memberId=member&processId=process`);
 await dialog().get(kind==='symptom'?'input[name="legacyMeasurementValue"]':'input[aria-label="实际服用量"]').setValue(kind==='symptom'?'37.8':'2');
 await dialog().get('form').trigger('submit');await flushPromises();const call=mocks.request.mock.calls.find(([,options])=>options?.method==='PATCH')!;
 expect(call[0]).toBe(`health-observations/${kind}/saved`);expect(JSON.parse(call[1].body)).toMatchObject({memberId:'member',processId:'process',revision:1,recordedAt:'2026-01-02T08:00:00'});expect(wrapper.emitted('saved')?.[0][0]).toMatchObject({ref:{kind,id:'saved'},revision:2});
});
it('continues the explicitly chosen symptom, carries selected associations and never edits baseline fields',async()=>{
 mocks.request.mockResolvedValue(entry());await render({symptom:{id:'source',memberId:'member',name:'发热',bodyArea:null,startedAt:'2026-01-01',latestAt:null,status:'active',unit:'℃'},initial:{measurementValue:'38.2',recordedAt:'2026-01-02T08:00:00'},relatedRecords:[{kind:'report',id:'report'}]});
 expect(dialog().attributes('aria-label')).toBe('新增变化 · 发热');expect(dialog().get('button[type=submit]').text()).toBe('新增记录'); await dialog().get('form').trigger('submit');await flushPromises();const call=mocks.request.mock.calls.find(([,options])=>options?.method==='POST')!;expect(call[0]).toBe('symptoms/source/observations');const body=JSON.parse(call[1].body);expect(body).toMatchObject({memberId:'member',measurementValue:'38.2',measurementUnit:'℃',relatedRecords:[{kind:'report',id:'report'}]});expect(body).not.toHaveProperty('startedAt');expect(body).not.toHaveProperty('bodyArea');expect(wrapper.emitted('saved')).toHaveLength(1);
});
it('keeps failed edits and the same retry key, and protects unsaved changes on close',async()=>{
 await render();await dialog().get('[name="legacyMeasurementValue"]').setValue('37.8');mocks.request.mockRejectedValueOnce(Error('合成响应丢失'));await dialog().get('form').trigger('submit');await flushPromises();
 expect(dialog().get('[role=alert]').text()).toContain('合成响应丢失');expect((dialog().get('[name="legacyMeasurementValue"]').element as HTMLInputElement).value).toBe('37.8');
 mocks.request.mockRejectedValueOnce(Error('合成重试失败'));await dialog().get('form').trigger('submit');await flushPromises();const patches=mocks.request.mock.calls.filter(([,options])=>options?.method==='PATCH');expect(JSON.parse(patches[0][1].body).requestKey).toBe(JSON.parse(patches[1][1].body).requestKey);
 await dialog().get('[aria-label="关闭记录编辑"]').trigger('click');expect(mocks.ask).toHaveBeenCalledOnce();expect(wrapper.emitted('close')).toBeUndefined();mocks.ask.mock.calls[0][0].onCancel();await flushPromises();expect(wrapper.emitted('close')).toBeUndefined();
});
it('closes on a member or permission change and ignores a late save from the old member',async()=>{
 await render();let finish!:(value:unknown)=>void;mocks.request.mockReturnValueOnce(new Promise(resolve=>finish=resolve));await dialog().get('form').trigger('submit');app.selectedMemberId.value='other';app.selectedMember.value={id:'other',permission:'manager'};await flushPromises();finish(entry());await flushPromises();expect(wrapper.emitted('saved')).toBeUndefined();expect(wrapper.emitted('close')).toHaveLength(1);expect(document.querySelector('.observation-editor-modal')).toBeNull();
});
it('restores the opener focus when a clean dialog is closed',async()=>{
 const button=document.createElement('button');document.body.appendChild(button);await render({target:{kind:'symptom',id:'saved'},returnFocus:button});await dialog().get('[aria-label="关闭记录编辑"]').trigger('click');expect(wrapper.emitted('close')).toHaveLength(1);wrapper.unmount();await flushPromises();expect(document.activeElement).toBe(button);
});


it('changes an actual intake unit through tags while retaining its original identity and revision',async()=>{
 await render({target:{kind:'intake',id:'saved'},processId:'process'});
 const picker=dialog().get('.medication-unit-picker');expect(picker.get('[aria-pressed=true]').text()).toBe('片');
 await picker.findAll('button').find(button=>button.text()==='粒')!.trigger('click');
 await dialog().get('form').trigger('submit');await flushPromises();
 const call=mocks.request.mock.calls.find(([,options])=>options?.method==='PATCH')!;
 expect(call[0]).toBe('health-observations/intake/saved');
 expect(JSON.parse(String(call[1].body))).toMatchObject({amount:'1',amountUnit:'粒',revision:1});
});
it('offers explicitly named optional body temperature for headache without an ambiguous generic measurement field',async()=>{
 await render({symptom:{id:'source',memberId:'member',name:'头痛',bodyArea:null,startedAt:'2026-01-01',latestAt:null,status:'active',unit:null}});
 expect(dialog().find('[name="temperatureValue"]').exists()).toBe(false);await dialog().get('.symptom-temperature-add').trigger('click');expect(dialog().text()).toContain('附带体温（选填）');expect(dialog().find('[name="legacyMeasurementValue"]').exists()).toBe(false);
 await dialog().get('[name="temperatureValue"]').setValue('37.6');await dialog().get('form').trigger('submit');await flushPromises();
 const call=mocks.request.mock.calls.find(([,options])=>options?.method==='POST')!;
 expect(JSON.parse(String(call[1].body))).toMatchObject({temperatureValue:'37.6',measurementValue:'',measurementUnit:''});
});
it('preserves an old non-temperature measurement separately when attaching body temperature',async()=>{
 mocks.request.mockResolvedValue({...entry(),name:'头痛',measurementValue:'3',measurementUnit:'次'});
 await render();await dialog().get('.symptom-temperature-add').trigger('click');await dialog().get('[name="temperatureValue"]').setValue('37.4');await dialog().get('form').trigger('submit');await flushPromises();
 const call=mocks.request.mock.calls.find(([,options])=>options?.method==='PATCH')!;
 expect(JSON.parse(String(call[1].body))).toMatchObject({measurementValue:'3',measurementUnit:'次',temperatureValue:'37.4'});
});

it('shows an existing attached temperature immediately when editing',async()=>{
 mocks.request.mockResolvedValue({...entry(),name:'头痛',measurementValue:null,measurementUnit:null,temperatureValue:'37.6'});
 await render();expect(dialog().find('.symptom-temperature-add').exists()).toBe(false);
 expect((dialog().get('[name="temperatureValue"]').element as HTMLInputElement).value).toBe('37.6');
});
