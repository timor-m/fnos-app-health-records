import { afterEach,beforeEach,expect,it,vi } from 'vitest';
import { flushPromises,mount } from '@vue/test-utils';
import { ref } from 'vue';
const mocks=vi.hoisted(()=>({request:vi.fn(),ask:vi.fn(),push:vi.fn()}));
vi.mock('../src/utils/api',()=>({request:mocks.request,apiUrl:(path:string)=>path}));
vi.mock('../src/composables/useConfirm',()=>({useConfirm:()=>({ask:mocks.ask,state:ref(null),cancel:vi.fn()})}));
vi.mock('../src/composables/useToast',()=>({useToast:()=>({show:vi.fn()})}));
vi.mock('vue-router',()=>({useRoute:()=>({path:'/events',fullPath:'/events'}),useRouter:()=>({push:mocks.push})}));
import Clinical from '../src/components/ClinicalFactEditor.vue';
import Section from '../src/components/ReportStructuredSectionEditor.vue';
import Morphology from '../src/components/MorphologyFindingEditor.vue';
import Time from '../src/components/ObservationTimeEditor.vue';
import DateTimePicker from '../src/components/DateTimePicker.vue';
import { confirmUnsavedRecordChanges } from '../src/utils/record-edit-guards';
const wrappers:ReturnType<typeof mount>[]=[];
function render(component:any,props:any){const wrapper=mount(component,{props,global:{stubs:{Teleport:true,FormSelect:true,DateTimePicker:true}}});wrappers.push(wrapper);return wrapper;}
beforeEach(()=>{vi.clearAllMocks();mocks.request.mockResolvedValue({});});
afterEach(()=>{wrappers.splice(0).forEach(wrapper=>wrapper.unmount());});
const finding={id:'finding',organ:'合成部位',region:'',laterality:'unknown',findingType:'other',findingName:'合成发现',presence:'present',findingCount:null,size:{length:null,width:null,height:null,unit:null},classification:null};
it.each([
 ['clinical',Clinical,{open:true,reportId:'report',type:'diagnosis',fact:null},'input[required]'],
 ['section',Section,{open:true,reportId:'report',reportType:'outpatient',section:null},'textarea'],
 ['morphology',Morphology,{open:true,finding},'input']
] as const)('%s protects edits on close, while opening and hiding unchanged data never leaves a stale guard',async(_name,component,props,selector)=>{
 const wrapper=render(component,props);await flushPromises();expect(await confirmUnsavedRecordChanges()).toBe(true);await wrapper.get(selector).setValue('合成修改');
 await wrapper.findAll('button').find(button=>button.text()==='取消')!.trigger('click');expect(mocks.ask).toHaveBeenCalledOnce();expect(wrapper.emitted('close')).toBeUndefined();
 mocks.ask.mock.calls[0][0].onCancel();await flushPromises();expect(wrapper.emitted('close')).toBeUndefined();await wrapper.setProps({open:false});await flushPromises();expect(await confirmUnsavedRecordChanges()).toBe(true);
});
it.each([['clinical',Clinical,{open:true,reportId:'report',type:'diagnosis',fact:null}],['section',Section,{open:true,reportId:'report',reportType:'outpatient',section:null}]] as const)('%s keeps the create key on lost-response retries and blocks duplicate submits',async(_name,component,props)=>{
 const wrapper=render(component,props);await flushPromises();await wrapper.get(component===Clinical?'input[required]':'textarea').setValue('合成新增');let reject!:(error:Error)=>void;mocks.request.mockReturnValueOnce(new Promise((_resolve,fail)=>{reject=fail;}));
 await wrapper.get('form').trigger('submit');await wrapper.get('form').trigger('submit');expect(mocks.request).toHaveBeenCalledOnce();reject(Error('合成响应丢失'));await flushPromises();
 mocks.request.mockRejectedValueOnce(Error('合成重试失败'));await wrapper.get('form').trigger('submit');await flushPromises();const bodies=mocks.request.mock.calls.map(([,options])=>JSON.parse(options.body));expect(bodies[0].requestKey).toBeTruthy();expect(bodies[1].requestKey).toBe(bodies[0].requestKey);
});
it('a late clinical save cannot close a replacement report editor',async()=>{
 const wrapper=render(Clinical,{open:true,reportId:'first',type:'diagnosis',fact:null});await wrapper.get('input[required]').setValue('合成旧内容');let resolve!:(value:unknown)=>void;mocks.request.mockReturnValueOnce(new Promise(done=>{resolve=done;}));await wrapper.get('form').trigger('submit');
 await wrapper.setProps({reportId:'second',fact:{diagnosisText:'合成新报告'}});resolve({});await flushPromises();expect(wrapper.emitted('close')).toBeUndefined();expect(wrapper.emitted('saved')).toBeUndefined();expect((wrapper.get('input[required]').element as HTMLInputElement).value).toBe('合成新报告');
});
it('an open report editor retains its original write version across background refreshes',async()=>{
 const wrapper=render(Clinical,{open:true,reportId:'report',type:'diagnosis',fact:null,expectedSourceVersion:7});await wrapper.get('input[required]').setValue('合成编辑');
 await wrapper.setProps({expectedSourceVersion:8});mocks.request.mockRejectedValueOnce(Error('合成版本冲突'));await wrapper.get('form').trigger('submit');await flushPromises();
 expect(JSON.parse(mocks.request.mock.calls[0][1].body).expectedSourceVersion).toBe(7);expect(wrapper.emitted('close')).toBeUndefined();
});
it('time correction preserves a retry key and ignores a late response from another observation',async()=>{
 mocks.request.mockResolvedValue({version:1,reportVersion:1,examinations:[]});const wrapper=render(Time,{reportId:'report',observation:{id:'obs'},canManage:true});await wrapper.get('button').trigger('click');await flushPromises();wrapper.getComponent(DateTimePicker).vm.$emit('update:modelValue','2026-01-01');await flushPromises();
 mocks.request.mockRejectedValueOnce(Error('合成响应丢失'));await wrapper.get('form').trigger('submit');await flushPromises();mocks.request.mockRejectedValueOnce(Error('合成重试'));await wrapper.get('form').trigger('submit');await flushPromises();const bodies=mocks.request.mock.calls.filter(([,options])=>options?.method).map(([,options])=>JSON.parse(options.body));expect(bodies[0].requestKey).toBe(bodies[1].requestKey);
 await wrapper.setProps({observation:{id:'next'}});expect(wrapper.find('form').exists()).toBe(false);expect(await confirmUnsavedRecordChanges()).toBe(true);
});


it('retains an imported medication unit until a tag is explicitly selected during report correction',async()=>{
 const wrapper=render(Clinical,{open:true,reportId:'report',type:'medication',fact:{id:'medication',medicationName:'合成药品',doseUnit:'合成原单位'},expectedSourceVersion:7});await flushPromises();
 const picker=wrapper.get('.medication-unit-picker');expect(picker.get('input').element.value).toBe('合成原单位');
 await picker.findAll('button').find(button=>button.text()==='片')!.trigger('click');
 mocks.request.mockResolvedValueOnce({id:'medication'});await wrapper.get('form').trigger('submit');await flushPromises();
 const call=mocks.request.mock.calls.find(([,options])=>options?.method==='PUT')!;
 expect(call[0]).toBe('clinical-facts/medication/medication');
 expect(JSON.parse(String(call[1].body))).toMatchObject({doseUnit:'片',expectedSourceVersion:7});
});
