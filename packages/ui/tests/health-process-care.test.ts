import RecordLoading from '../src/components/RecordLoading.vue';
import { DOMWrapper,flushPromises,mount } from '@vue/test-utils';
import { afterEach,beforeEach,expect,it,vi } from 'vitest';
import { KeepAlive,defineComponent,ref } from 'vue';
import Panel from '../src/components/HealthProcessCarePanel.vue';
import type { HealthProcessDetail } from '../../shared/health-process';
import type { HealthProcessCare } from '../../shared/health-process-care';
const mocks=vi.hoisted(()=>({request:vi.fn(),copy:vi.fn(),ask:vi.fn(),toast:vi.fn()}));
const app={selectedMemberId:ref('member'),selectedMember:ref({id:'member',permission:'manager'}),notifyDataChanged:vi.fn()};
vi.mock('../src/utils/api',()=>({request:mocks.request}));vi.mock('../src/utils/clipboard',()=>({copyTextToClipboard:mocks.copy}));
vi.mock('../src/composables/useAppContext',()=>({useAppContext:()=>app}));vi.mock('../src/composables/useConfirm',()=>({useConfirm:()=>({ask:mocks.ask})}));vi.mock('../src/composables/useToast',()=>({useToast:()=>({show:mocks.toast})}));
const process:HealthProcessDetail={id:'process',memberId:'member',title:'合成历程',summary:null,startedAt:'2026-01-01',latestAt:'2026-01-03',recordCount:2,aiState:'unconfigured',manuallyEdited:false,fingerprint:'current',editToken:'edit',records:[],links:[],highlights:[]};
const sample=():HealthProcessCare=>({processId:'process',memberId:'member',fingerprint:'current',summaryText:'【就诊摘要】合成成员\n报告所列用药（不代表已服用）：合成处方\n实际服药：2次',symptoms:[{id:'symptom',name:'发热',status:'active',unit:'℃'}],medications:[{key:'course:drug',name:'合成药品',detail:'合成规格',origin:'course',status:'active',amount:'2',unit:'ml'}],temperature:{highest:{value:38.2,at:'2026-01-02T08:00',symptomId:'symptom',updateId:'update'},latest:{value:37.2,at:'2026-01-03T08:00',symptomId:'symptom',updateId:'last'},count:3,recordedDays:2,threshold:37.5,thresholdDays:1}});
const dateStub={props:['modelValue'],emits:['update:modelValue'],template:'<input class="quick-time" :value="modelValue" @input="$emit(\'update:modelValue\',$event.target.value)"/>'};
let wrapper:ReturnType<typeof mount>;
const modal=()=>new DOMWrapper(document.body).get('.process-quick-modal');
const summary=()=>new DOMWrapper(document.body).get('.process-doctor-summary-modal');
const saves=()=>mocks.request.mock.calls.filter(([,options])=>options?.method==='POST');
async function start(){wrapper=mount(Panel,{props:{process},attachTo:document.body,global:{stubs:{DateTimePicker:dateStub}}});await flushPromises();}
beforeEach(()=>{vi.clearAllMocks();app.selectedMemberId.value='member';app.selectedMember.value={id:'member',permission:'manager'};mocks.copy.mockResolvedValue(true);mocks.request.mockImplementation(async(path:string,options?:RequestInit)=>options?.method==='POST'?{processId:'process',memberId:'member',kind:JSON.parse(String(options.body)).kind==='symptom'?'symptom':'intake',id:'saved'}:sample());});
afterEach(()=>{wrapper?.unmount();document.body.innerHTML='';vi.restoreAllMocks();});
it('opens a separate doctor summary dialog and copies the complete text with manual fallback',async()=>{
 await start();expect(wrapper.get('.process-temperature').text()).toContain('38.2');expect(wrapper.get('.process-temperature').text()).toContain('≥37.5℃ 的记录天数');
 const trigger=wrapper.get('[aria-haspopup="dialog"]');await trigger.trigger('click');await flushPromises();
 expect(wrapper.find('pre').exists()).toBe(false);expect(summary().attributes()).toMatchObject({role:'dialog','aria-modal':'true'});
 expect(summary().get('pre').text()).toContain('不代表已服用');expect(document.body.style.overflow).toBe('hidden');expect(mocks.request).toHaveBeenCalledTimes(1);
 await summary().get('.primary-button').trigger('click');await flushPromises();expect(mocks.copy).toHaveBeenCalledWith(sample().summaryText);expect(summary().get('[role=status]').text()).toBe('已复制');
 mocks.copy.mockImplementationOnce(async()=>{(document.activeElement as HTMLElement)?.blur();return false;});const copyButton=summary().get('.primary-button');(copyButton.element as HTMLElement).focus();await copyButton.trigger('click');await flushPromises();expect(summary().get('[role=status]').text()).toContain('长按');expect(document.activeElement).toBe(copyButton.element);
 await summary().get('pre').trigger('click');expect(summary().exists()).toBe(true);
 await new DOMWrapper(document.body).get('.process-doctor-summary-backdrop').trigger('click');await flushPromises();
 expect(document.querySelector('.process-doctor-summary-modal')).toBeNull();expect(document.body.style.overflow).toBe('');expect(document.activeElement).toBe(trigger.element);
});
it('the day summary copies the selected layout and the curve uses only returned source readings',async()=>{
 const data=sample();data.summaryByDay='合成按天摘要\n2026-01-02 实际服药';data.temperature!.readings=[data.temperature!.highest,data.temperature!.latest];mocks.request.mockResolvedValue(data);
 await start();expect(wrapper.get('.process-temperature-chart svg').attributes('aria-label')).toContain('2 次记录');expect(wrapper.findAll('.process-temperature-chart circle')).toHaveLength(2);
 await wrapper.get('[aria-haspopup="dialog"]').trigger('click');await flushPromises();await summary().findAll('.process-summary-views button').find(b=>b.text()==='按天')!.trigger('click');
 expect(summary().get('pre').text()).toContain('合成按天摘要');await summary().get('.primary-button').trigger('click');await flushPromises();expect(mocks.copy).toHaveBeenCalledWith(data.summaryByDay);
});
it('opens the shared new symptom dialog with the current member and process',async()=>{
 await start();await wrapper.get('.process-add-symptom').trigger('click');await flushPromises();
 const dialog=wrapper.findComponent({name:'NewSymptomPage'});expect(dialog.exists()).toBe(true);
 expect(dialog.props()).toMatchObject({embedded:true,memberId:'member',processId:'process'});
 expect(wrapper.find('.process-common-symptoms').exists()).toBe(false);
 dialog.vm.$emit('saved');await flushPromises();expect(wrapper.findComponent({name:'NewSymptomPage'}).exists()).toBe(false);
 expect(wrapper.emitted('updated')).toHaveLength(1);
});

it('traps summary focus, closes on Escape or its close button and resets copy feedback on reopening',async()=>{
 await start();const trigger=wrapper.get('[aria-haspopup="dialog"]');await trigger.trigger('click');await flushPromises();
 const close=summary().get('[aria-label="关闭就诊摘要"]'),copy=summary().get('.primary-button');expect(document.activeElement).toBe(close.element);
 window.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',shiftKey:true,cancelable:true}));expect(document.activeElement).toBe(copy.element);
 window.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',cancelable:true}));expect(document.activeElement).toBe(close.element);
 await copy.trigger('click');await flushPromises();window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',cancelable:true}));await flushPromises();
 expect(document.querySelector('[role=dialog]')).toBeNull();expect(document.activeElement).toBe(trigger.element);
 await trigger.trigger('click');await flushPromises();expect(summary().find('[role=status]').exists()).toBe(false);
 await summary().get('[aria-label="关闭就诊摘要"]').trigger('click');await flushPromises();expect(document.body.style.overflow).toBe('');
});
it('closes the doctor summary on member changes and ignores a late clipboard response',async()=>{
 await start();await wrapper.get('[aria-haspopup="dialog"]').trigger('click');await flushPromises();
 let finish!:(value:boolean)=>void;mocks.copy.mockReturnValueOnce(new Promise(resolve=>finish=resolve));await summary().get('.primary-button').trigger('click');
 app.selectedMemberId.value='other';await flushPromises();expect(document.querySelector('[role=dialog]')).toBeNull();expect(document.body.style.overflow).toBe('');
 finish(true);await flushPromises();expect(document.body.textContent).not.toContain('已复制');expect(document.body.textContent).not.toContain('合成成员');
});
it('records another observation in an independent compact dialog without typing the symptom name',async()=>{
 await start();const trigger=wrapper.get('.process-symptom-choice');await trigger.trigger('click');await flushPromises();expect(modal().attributes('aria-label')).toBe('新增变化 · 发热');expect(modal().get('button[type=submit]').text()).toBe('新增记录');expect(modal().get('input[name=measurementValue]').element.value).toBe('');expect(modal().get('input[name=measurementUnit]').element.value).toBe('℃');
 await modal().get('input[name=measurementValue]').setValue('38.1');await modal().get('form').trigger('submit');await flushPromises();expect(saves()).toHaveLength(1);expect(JSON.parse(String(saves()[0][1].body))).toMatchObject({kind:'symptom',target:'symptom',fingerprint:'current',measurementValue:'38.1',measurementUnit:'℃',change:null});
 expect(new DOMWrapper(document.body).find('[role=dialog]').exists()).toBe(false);expect(wrapper.emitted('updated')).toHaveLength(1);expect(document.activeElement).toBe(trigger.element);expect(document.body.style.overflow).toBe('');
});
it('reuses the last actual intake amount and preserves the draft and retry key on failure',async()=>{
 await start();await wrapper.get('.process-medication-choice').trigger('click');await flushPromises();expect(modal().attributes('aria-label')).toBe('新增服药记录 · 合成药品');expect(modal().get('button[type=submit]').text()).toBe('新增记录');expect(modal().get('input[name=amount]').element.value).toBe('2');expect(modal().get('input[name=amountUnit]').element.value).toBe('ml');
 mocks.request.mockRejectedValueOnce(Error('合成保存失败'));await modal().get('input[name=amount]').setValue('3');await modal().get('form').trigger('submit');await flushPromises();expect(modal().get('[role=alert]').text()).toContain('合成保存失败');expect(modal().get('input[name=amount]').element.value).toBe('3');
 await modal().get('form').trigger('submit');await flushPromises();const bodies=saves().map(([,options])=>JSON.parse(String(options.body)));expect(bodies[0].requestKey).toBe(bodies[1].requestKey);expect(bodies[1]).toMatchObject({kind:'medication',target:'course:drug',amount:'3'});
});
it('restores the quick button focus after the parent timeline finishes its refresh',async()=>{
 await start();const trigger=wrapper.get('.process-medication-choice');await trigger.trigger('click');await flushPromises();await wrapper.setProps({disabled:true});await modal().get('form').trigger('submit');await flushPromises();
 expect(new DOMWrapper(document.body).find('[role=dialog]').exists()).toBe(false);await wrapper.setProps({disabled:false});await flushPromises();expect(document.activeElement).toBe(trigger.element);
});
it('protects a changed draft and traps focus; empty dates disable saving',async()=>{
 await start();await wrapper.get('.process-medication-choice').trigger('click');await flushPromises();await modal().get('input[name=amount]').setValue('3');await modal().get('.quick-time').setValue('');expect(modal().get('button[type=submit]').attributes('disabled')).toBeDefined();
 window.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',shiftKey:true,cancelable:true}));expect((document.activeElement as HTMLElement).textContent).toBe('取消');
 window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',cancelable:true}));expect(mocks.ask).toHaveBeenCalledOnce();mocks.ask.mock.calls[0][0].onCancel();await flushPromises();expect(modal().get('input[name=amount]').element.value).toBe('3');
});
it('blocks duplicate submits and ignores late saves after a member change',async()=>{
 await start();await wrapper.get('.process-medication-choice').trigger('click');await flushPromises();let finish!:(value:unknown)=>void;mocks.request.mockReturnValueOnce(new Promise(resolve=>finish=resolve));await modal().get('form').trigger('submit');await modal().get('form').trigger('submit');expect(saves()).toHaveLength(1);
 app.selectedMemberId.value='other';await flushPromises();expect(new DOMWrapper(document.body).find('[role=dialog]').exists()).toBe(false);expect(document.body.style.overflow).toBe('');finish({processId:'process',memberId:'member',kind:'intake',id:'old'});await flushPromises();expect(wrapper.emitted('updated')).toBeUndefined();expect(app.notifyDataChanged).not.toHaveBeenCalled();expect(wrapper.text()).not.toContain('38.2');
});
it('viewer retains summaries and temperature data but has no recording buttons',async()=>{
 app.selectedMember.value.permission='viewer';await start();expect(wrapper.find('.process-symptom-choice').exists()).toBe(false);expect(wrapper.find('.process-medication-choice').exists()).toBe(false);expect(wrapper.find('.process-temperature').exists()).toBe(true);await wrapper.get('[aria-expanded]').trigger('click');await flushPromises();expect(summary().get('pre').exists()).toBe(true);
});
it('failed reads retry without hiding the timeline and foreign payloads never render',async()=>{
 mocks.request.mockRejectedValueOnce(Error('合成读取失败'));await start();expect(wrapper.get('[role=alert]').text()).toContain('合成读取失败');await wrapper.get('.error-retry').trigger('click');await flushPromises();expect(wrapper.find('.process-temperature').exists()).toBe(true);
 mocks.request.mockResolvedValueOnce({...sample(),memberId:'other',summaryText:'其他成员内容'});await wrapper.setProps({process:{...process,fingerprint:'new'}});await flushPromises();expect(wrapper.get('[role=alert]').text()).toContain('不一致');expect(wrapper.text()).not.toContain('其他成员内容');
});
it('cached pages discard late responses while away and refresh on return',async()=>{
 const shown=ref(true);let finish!:(value:unknown)=>void;mocks.request.mockReturnValueOnce(new Promise(resolve=>finish=resolve));wrapper=mount(defineComponent({components:{Panel,KeepAlive},setup:()=>({shown,process}),template:'<KeepAlive><Panel v-if="shown" :process="process"/></KeepAlive>'}),{attachTo:document.body});await flushPromises();shown.value=false;await flushPromises();finish(sample());await flushPromises();shown.value=true;await flushPromises();expect(wrapper.find('.process-temperature').exists()).toBe(true);expect(mocks.request).toHaveBeenCalledTimes(2);
});
it('edits only the process concern and guides missing background to member information in the existing doctor dialog, then refreshes the summary',async()=>{
 const context={memberId:'member',processId:'process',version:'v1',allergies:'',history:'',medications:'',concern:''};
 mocks.request.mockImplementation(async(path:string,options?:RequestInit)=>{if(options?.method==='PATCH')return {...context,...JSON.parse(String(options.body))};return {...sample(),doctorContext:context};});
 await start();await wrapper.get('[aria-haspopup="dialog"]').trigger('click');await flushPromises();await summary().get('[data-edit-context]').trigger('click');
 expect(document.querySelectorAll('[role=dialog]')).toHaveLength(1);const fields=summary().findAll('textarea');expect(fields).toHaveLength(1);await fields[0].setValue('合成诉求');
 await summary().get('form').trigger('submit');await flushPromises();const write=mocks.request.mock.calls.find(([,options])=>options?.method==='PATCH')!;const body=JSON.parse(String(write[1].body));expect(body).toMatchObject({memberId:'member',version:'v1',concern:'合成诉求'});expect(body).not.toHaveProperty('allergies');expect(body).not.toHaveProperty('history');expect(body).not.toHaveProperty('medications');expect(body.requestKey).toBeTruthy();expect(summary().find('form').exists()).toBe(false);expect(document.activeElement).toBe(summary().get('[data-edit-context]').element);expect(mocks.request.mock.calls.filter(([path])=>String(path).includes('/care?'))).toHaveLength(2);
});
it('retains failed background edits for retry, protects unsaved input and never exposes the editor to a viewer',async()=>{
 const context={memberId:'member',processId:'process',version:'v1',allergies:'',history:'',medications:'',concern:''};mocks.request.mockResolvedValue({...sample(),doctorContext:context});await start();await wrapper.get('[aria-haspopup="dialog"]').trigger('click');await flushPromises();await summary().get('[data-edit-context]').trigger('click');await summary().findAll('textarea')[0].setValue('合成未保存诉求');
 mocks.request.mockRejectedValueOnce(Error('合成保存失败'));await summary().get('form').trigger('submit');await flushPromises();expect(summary().text()).toContain('合成保存失败');expect((summary().findAll('textarea')[0].element as HTMLTextAreaElement).value).toBe('合成未保存诉求');
 await summary().get('[aria-label="关闭就诊摘要"]').trigger('click');expect(mocks.ask).toHaveBeenCalled();expect(summary().find('form').exists()).toBe(true);
 app.selectedMember.value.permission='viewer';await flushPromises();expect(summary().find('form').exists()).toBe(false);expect(summary().find('[data-edit-context]').exists()).toBe(false);
});
it('refreshes the doctor summary after AI changes process metadata without changing original record fingerprints',async()=>{
 await start();const calls=mocks.request.mock.calls.length;mocks.request.mockResolvedValue({...sample(),summaryText:'合成 AI 整理后的就诊摘要'});
 await wrapper.setProps({process:{...process,title:'合成新事项',summary:'合成整理摘要',aiState:'ready'}});await flushPromises();expect(mocks.request.mock.calls.length).toBe(calls+1);
 await wrapper.get('[aria-haspopup="dialog"]').trigger('click');await flushPromises();expect(summary().text()).toContain('合成 AI 整理后的就诊摘要');
});
it('silent reads with unchanged process metadata do not reload the doctor summary',async()=>{
 await start();const calls=mocks.request.mock.calls.length;await wrapper.setProps({process:{...process}});await flushPromises();expect(mocks.request.mock.calls.length).toBe(calls);
});

it('offers a member information guide only for missing background and closes summary before handing off',async()=>{
 const context={memberId:'member',processId:'process',version:'v1',allergies:'明确无已知过敏',history:'',medications:'不清楚',concern:''};mocks.request.mockResolvedValue({...sample(),doctorContext:context});await start();await wrapper.get('[aria-haspopup="dialog"]').trigger('click');await flushPromises();expect(summary().get('.doctor-background-guide').text()).toContain('重要病史');expect(summary().get('.doctor-background-guide').text()).not.toContain('过敏及不良反应');await summary().get('.doctor-background-guide button').trigger('click');expect(wrapper.emitted('editMember')).toHaveLength(1);expect(document.querySelector('.process-doctor-summary-modal')).toBeNull();
});

it('explains when nothing is currently being tracked and keeps the new symptom action on the left',async()=>{
 mocks.request.mockResolvedValue({...sample(),symptoms:[],medications:[]});await start();
 expect(wrapper.get('.process-care-empty').text()).toBe('还没有正在跟踪的症状或用药。');
 expect(wrapper.get('.process-care-footer').classes()).toContain('is-empty');
 expect(wrapper.find('.process-history').exists()).toBe(false);
 expect(wrapper.get('.process-add-symptom').text()).toContain('新增症状');
});
it('shows last recorded facts, folds historical choices and keeps unrelated common symptoms collapsed',async()=>{
 const data=sample();data.symptoms[0].latest={recordedAt:'2026-01-02T08:00',change:'improved',measurementValue:'38.2',measurementUnit:'℃',severity:null};data.symptoms.push({id:'old',name:'合成历史症状',status:'resolved',unit:null});data.medications[0].lastTakenAt='2026-01-02T09:00';data.medications.push({...data.medications[0],key:'stopped',name:'合成历史药品',status:'stopped'});mocks.request.mockResolvedValue(data);await start();
 expect(wrapper.get('.process-symptom-choice').text()).toContain('上次记录 · 38.2 ℃');expect(wrapper.get('.process-medication-choice').text()).toContain('上次记录服药 · 2 ml');expect(wrapper.get('.process-add-symptom').text()).toContain('新增症状');expect(wrapper.get('.process-history').attributes('open')).toBeUndefined();expect(wrapper.findAll('.process-symptom-choice')).toHaveLength(1);expect(wrapper.findAll('.process-medication-choice')).toHaveLength(1);expect(wrapper.get('.process-history').text()).toContain('合成历史药品');expect(wrapper.find('.process-care-empty').exists()).toBe(false);expect(wrapper.get('.process-care-footer').classes()).not.toContain('is-empty');
});


it('saves a directly chosen unit in the quick intake without creating a dropdown step',async()=>{
 await start();await wrapper.get('.process-medication-choice').trigger('click');await flushPromises();
 const picker=modal().get('.medication-unit-picker');
 await picker.findAll('button').find(button=>button.text()==='片')!.trigger('click');
 await modal().get('form').trigger('submit');await flushPromises();
 expect(JSON.parse(String(saves()[0][1].body))).toMatchObject({kind:'medication',target:'course:drug',amount:'2',amountUnit:'片'});
});

it('uses the shared centered loader initially and retains quick records while refreshing',async()=>{
 let finish!:(value:HealthProcessCare)=>void;mocks.request.mockReturnValueOnce(new Promise(resolve=>{finish=resolve;}));
 await start();const loading=wrapper.getComponent(RecordLoading);expect(loading.props('label')).toContain('快速记录');expect(loading.attributes('role')).toBe('status');
 finish(sample());await flushPromises();expect(wrapper.findComponent(RecordLoading).exists()).toBe(false);
 mocks.request.mockReturnValueOnce(new Promise(resolve=>{finish=resolve;}));await wrapper.setProps({process:{...process,fingerprint:'refresh'}});
 expect(wrapper.findComponent(RecordLoading).exists()).toBe(false);expect(wrapper.find('.process-symptom-choice').exists()).toBe(true);
 finish(sample());await flushPromises();
});

it('consumes the early shared request and prepares the full summary only when opened, with retry and cache invalidation',async()=>{
 const quick={...sample(),summaryReady:false,summaryText:'',summaryByDay:undefined,doctorContext:undefined};
 let finish!:(value:HealthProcessCare)=>void;
 mocks.request.mockReturnValueOnce(new Promise(resolve=>{finish=resolve;}));
 wrapper=mount(Panel,{props:{process,initialLoad:Promise.resolve({processId:'process',memberId:'member',fingerprint:'current',care:{data:quick}} as any)},attachTo:document.body});await flushPromises();
 expect(mocks.request).not.toHaveBeenCalled();expect(wrapper.find('.process-symptom-choice').exists()).toBe(true);
 await wrapper.get('[aria-haspopup="dialog"]').trigger('click');await flushPromises();expect(mocks.request).toHaveBeenCalledTimes(1);expect(mocks.request.mock.calls[0][0]).not.toContain('view=quick');
 expect(summary().findComponent(RecordLoading).exists()).toBe(true);expect(summary().get('.primary-button').attributes('disabled')).toBeDefined();
 finish(sample());await flushPromises();expect(summary().get('pre').text()).toContain('就诊摘要');
 await summary().get('[aria-label="关闭就诊摘要"]').trigger('click');await wrapper.get('[aria-haspopup="dialog"]').trigger('click');await flushPromises();expect(mocks.request).toHaveBeenCalledTimes(1);
 await summary().get('[aria-label="关闭就诊摘要"]').trigger('click');mocks.request.mockResolvedValueOnce(quick);await wrapper.setProps({process:{...process,title:'合成事项更新'}});await flushPromises();
 mocks.request.mockRejectedValueOnce(Error('合成摘要读取失败'));await wrapper.get('[aria-haspopup="dialog"]').trigger('click');await flushPromises();expect(summary().get('[role=alert]').text()).toContain('合成摘要读取失败');
 mocks.request.mockResolvedValueOnce({...sample(),summaryText:'合成最新摘要'});await summary().get('.error-retry').trigger('click');await flushPromises();expect(summary().get('pre').text()).toBe('合成最新摘要');
});
it('ignores a late summary response after switching members',async()=>{
 mocks.request.mockResolvedValueOnce({...sample(),summaryReady:false,summaryText:''});await start();let finish!:(value:HealthProcessCare)=>void;mocks.request.mockReturnValueOnce(new Promise(resolve=>{finish=resolve;}));
 await wrapper.get('[aria-haspopup="dialog"]').trigger('click');await flushPromises();app.selectedMemberId.value='other';await flushPromises();finish({...sample(),summaryText:'合成过期摘要'});await flushPromises();
 expect(document.body.textContent).not.toContain('合成过期摘要');expect(document.querySelector('.process-doctor-summary-modal')).toBeNull();
});
