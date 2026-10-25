import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {DOMWrapper,flushPromises,mount} from '@vue/test-utils';
import {reactive,ref} from 'vue';
import Page from '../src/pages/NewSymptomPage.vue';
import DateTimePicker from '../src/components/DateTimePicker.vue';
import FormSelect from '../src/components/FormSelect.vue';
import SymptomSeverityPicker from '../src/components/SymptomSeverityPicker.vue';
import Picker from '../src/components/HealthRecordPicker.vue';
const mocks=vi.hoisted(()=>({request:vi.fn(),push:vi.fn(),ask:vi.fn()}));
const route=reactive({path:'/add/symptom',fullPath:'/add/symptom',query:{} as Record<string,string>});
const app={selectedMemberId:ref('member'),selectedMember:ref({id:'member',permission:'manager'}),notifyDataChanged:vi.fn()};
vi.mock('../src/utils/api',()=>({request:mocks.request}));vi.mock('../src/composables/useAppContext',()=>({useAppContext:()=>app}));vi.mock('../src/composables/useConfirm',()=>({useConfirm:()=>({ask:mocks.ask})}));
vi.mock('vue-router',()=>({useRoute:()=>route,useRouter:()=>({push:mocks.push}),RouterLink:{props:['to'],template:'<a><slot/></a>'}}));
const wrappers:ReturnType<typeof mount>[]=[];const render=()=>{const wrapper=mount(Page);wrappers.push(wrapper);return wrapper;};
const settleCandidates=async()=>{await new Promise(resolve=>setTimeout(resolve,200));await flushPromises();};
const saves=()=>mocks.request.mock.calls.filter(([path,options])=>path==='symptoms'&&options?.method==='POST').map(([,options])=>JSON.parse(options.body));
beforeEach(()=>{vi.clearAllMocks();route.path=route.fullPath='/add/symptom';route.query={};app.selectedMemberId.value='member';app.selectedMember.value={id:'member',permission:'manager'};mocks.request.mockImplementation(async(path,options)=>path==='symptoms/candidates'?{memberId:JSON.parse(options.body).memberId,scope:'member',items:[],total:0}:path.startsWith('health-records?')?{items:[],nextCursor:null,hasMore:false}:{id:'created',memberId:'member'});});
afterEach(()=>wrappers.splice(0).forEach(w=>w.unmount()));
it('saves just the symptom name with unknown optional dates and no process setup',async()=>{
 const wrapper=render();expect(mocks.request).not.toHaveBeenCalled();await wrapper.get('input[required]').setValue('合成症状');await wrapper.get('form').trigger('submit');await flushPromises();
 expect(saves()[0]).toMatchObject({memberId:'member',name:'合成症状',startedAt:null,severity:null,relatedRecords:[]});expect(saves()[0]).not.toHaveProperty('episodeId');expect(wrapper.text()).not.toContain('关联已有健康历程');expect(mocks.push).toHaveBeenCalledWith({path:'/events/detail/symptom/created',query:{returnTo:'/events'}});
});
it('retains zero severity, date and supplemental fields when their section closes',async()=>{
 const wrapper=render();await wrapper.get('input[required]').setValue('合成症状');wrapper.getComponent(DateTimePicker).vm.$emit('update:modelValue','2026-01-01');
 await wrapper.getComponent(SymptomSeverityPicker).get('[aria-label="0 / 10"]').trigger('click');await wrapper.get('input[aria-label="症状发生频率"]').setValue('合成频率');await wrapper.get('form').trigger('submit');await flushPromises();expect(saves()[0]).toMatchObject({startedAt:'2026-01-01',severity:0,frequency:'合成频率'});
});
it('prefills a process record context and carries it in the same create request',async()=>{
 route.query={memberId:'member',relatedKind:'report',relatedId:'anchor',returnTo:'/health-processes/process'};const wrapper=render();await wrapper.get('input[required]').setValue('合成症状');await wrapper.get('form').trigger('submit');await flushPromises();
 expect(saves()[0].relatedRecords).toEqual([{kind:'report',id:'anchor'}]);expect(mocks.push).toHaveBeenCalledWith({path:'/events/detail/symptom/created',query:{returnTo:'/health-processes/process'}});
});
it('creates a symptom in the explicit process without selecting a record as its anchor',async()=>{
 route.query={memberId:'member',processId:'process',returnTo:'/health-processes/process'};const wrapper=render();expect(wrapper.text()).toContain('保存后加入当前健康历程');expect(wrapper.findComponent(Picker).exists()).toBe(false);
 await wrapper.get('input[required]').setValue('合成历程症状');await wrapper.get('form').trigger('submit');await flushPromises();expect(saves()[0]).toMatchObject({processId:'process',relatedRecords:[]});
});
it('opens the shared association dialog and stages confirmed choices until the symptom is saved',async()=>{
 const wrapper=render();expect(mocks.request).not.toHaveBeenCalled();
 await wrapper.findAll('button').find(button=>button.text()==='关联历程')!.trigger('click');await flushPromises();
 const dialog=new DOMWrapper(document.body).get('.record-association-modal');expect(dialog.get('h3').text()).toBe('关联历程');
 expect(dialog.get('.association-draft-hint').text()).toBe('选择同一健康事项的相关记录，保存后形成或加入健康历程。');
 expect(wrapper.find('.health-record-picker').exists()).toBe(false);expect(wrapper.findComponent(Picker).exists()).toBe(true);
 wrapper.getComponent(Picker).vm.$emit('update:modelValue',[{kind:'medication',id:'course'}]);await flushPromises();
 expect(saves()).toHaveLength(0);await dialog.get('form').trigger('submit');await flushPromises();expect(saves()).toHaveLength(0);
 expect(document.querySelector('.record-association-modal')).toBeNull();expect(wrapper.text()).toContain('已选择 1 条相关记录');
 await wrapper.get('input[required]').setValue('合成症状');await wrapper.get('form').trigger('submit');await flushPromises();expect(saves()[0].relatedRecords).toEqual([{kind:'medication',id:'course'}]);
});
it('failed unchanged saves preserve input and their retry key; editing changes the key',async()=>{
 const wrapper=render();await wrapper.get('input[required]').setValue('合成症状');await settleCandidates();mocks.request.mockRejectedValueOnce(Error('合成保存失败'));await wrapper.get('form').trigger('submit');await flushPromises();expect(wrapper.get('[role="alert"]').text()).toContain('合成保存失败');expect((wrapper.get('input[required]').element as HTMLInputElement).value).toBe('合成症状');
 await settleCandidates();mocks.request.mockRejectedValueOnce(Error('合成保存失败'));await wrapper.get('form').trigger('submit');await flushPromises();expect(saves()[0].requestKey).toBe(saves()[1].requestKey);
 await wrapper.get('input[required]').setValue('合成症状更正');await wrapper.get('form').trigger('submit');await flushPromises();expect(saves()[2].requestKey).not.toBe(saves()[0].requestKey);
});
it('viewer cannot create records',()=>{app.selectedMember.value.permission='viewer';const wrapper=render();expect(wrapper.find('form').exists()).toBe(false);expect(wrapper.text()).toContain('只有查看权限');});
it.each([{memberId:'other',relatedKind:'report',relatedId:'anchor'},{relatedKind:'process',relatedId:'anchor'}])('rejects a foreign or invalid source context %j',async query=>{
 route.query=query;const wrapper=render();await flushPromises();expect(wrapper.find('form').exists()).toBe(false);expect(wrapper.get('[role="alert"]').text()).toContain('关联来源');expect(mocks.request).not.toHaveBeenCalled();
});
it('does not navigate from a late old-member success and clears its visible draft',async()=>{
 const wrapper=render();await wrapper.get('input[required]').setValue('合成旧草稿');let finish!:(value:unknown)=>void;await settleCandidates();mocks.request.mockReturnValueOnce(new Promise(done=>finish=done));await wrapper.get('form').trigger('submit');await flushPromises();app.selectedMemberId.value='other';app.selectedMember.value={id:'other',permission:'manager'};await flushPromises();
 finish({id:'old',memberId:'member'});await flushPromises();expect(mocks.push).not.toHaveBeenCalled();expect((wrapper.get('input[required]').element as HTMLInputElement).value).toBe('');
});
it('member changes cannot silently reuse an entry anchor without an explicit member parameter',async()=>{
 route.query={relatedKind:'report',relatedId:'anchor'};const wrapper=render();app.selectedMemberId.value='other';await flushPromises();expect(wrapper.find('form').exists()).toBe(false);expect(wrapper.get('[role="alert"]').text()).toContain('当前成员');
});
it('rejects a cross-member save response while preserving the form for retry',async()=>{
 const wrapper=render();await wrapper.get('input[required]').setValue('合成症状');await settleCandidates();mocks.request.mockResolvedValueOnce({id:'foreign',memberId:'other'});await wrapper.get('form').trigger('submit');await flushPromises();expect(mocks.push).not.toHaveBeenCalled();expect(wrapper.get('[role="alert"]').text()).toContain('保存结果');expect(wrapper.get('form').exists()).toBe(true);
});

it('offers body-specific symptom choices without saving or prefilling dates, while keeping custom names editable',async()=>{
 const wrapper=render();const areas=wrapper.get('[aria-label="不适部位"]');
 await areas.findAll('button').find(button=>button.text()==='腹部')!.trigger('click');
 const presets=wrapper.get('[aria-label="腹部常用症状"]');
 expect(presets.text()).toContain('腹痛');expect(presets.text()).toContain('腹泻');expect(presets.text()).not.toContain('头痛');
 await presets.findAll('button').find(button=>button.text()==='腹痛')!.trigger('click');
 expect((wrapper.get('input[required]').element as HTMLInputElement).value).toBe('腹痛');expect(presets.get('[aria-pressed=true]').text()).toBe('腹痛');expect(saves()).toHaveLength(0);
 await wrapper.get('input[required]').setValue('合成自定义症状');expect(presets.find('[aria-pressed=true]').exists()).toBe(false);
 await wrapper.get('form').trigger('submit');await flushPromises();expect(saves()[0]).toMatchObject({name:'合成自定义症状',startedAt:null,severity:null,bodyArea:'腹部',description:''});
});
it('changes only the previous preset when switching areas; custom text survives and non-location symptoms do not invent an area',async()=>{
 const wrapper=render();const area=(name:string)=>wrapper.get('[aria-label="不适部位"]').findAll('button').find(button=>button.text()===name)!;
 await area('头部').trigger('click');await wrapper.get('[aria-label="头部常用症状"]').findAll('button')[0].trigger('click');
 await area('腹部').trigger('click');expect((wrapper.get('input[required]').element as HTMLInputElement).value).toBe('');
 await wrapper.get('input[required]').setValue('合成自定义不适');await area('胸部').trigger('click');expect((wrapper.get('input[required]').element as HTMLInputElement).value).toBe('合成自定义不适');
 await area('全身／不确定').trigger('click');await wrapper.get('[aria-label="全身／不确定常用症状"]').findAll('button')[0].trigger('click');
 await wrapper.get('form').trigger('submit');await flushPromises();expect(saves()[0]).toMatchObject({name:'发热',bodyArea:'',startedAt:null,severity:null});
});
it('expands all body regions, retains a less-common selection after collapse, and supports a custom area',async()=>{
 const wrapper=render();await wrapper.get('[aria-expanded="false"]').trigger('click');
 const areas=()=>wrapper.get('[aria-label="不适部位"]');expect(areas().text()).toContain('眼部');expect(areas().text()).toContain('泌尿部位');expect(areas().text()).toContain('生殖部位');
 await areas().findAll('button').find(button=>button.text()==='眼部')!.trigger('click');expect(wrapper.get('.symptom-more-areas').attributes('aria-expanded')).toBe('false');
 expect(areas().get('[aria-pressed=true]').text()).toBe('眼部');expect(wrapper.get('[aria-label="眼部常用症状"]').text()).toContain('视物模糊');
 await wrapper.get('.symptom-more-areas').trigger('click');await areas().findAll('button').find(button=>button.text()==='其他部位')!.trigger('click');
 await wrapper.get('[aria-label="其他身体部位"]').setValue('合成特殊部位');await wrapper.get('input[required]').setValue('合成不适');
 await wrapper.get('form').trigger('submit');await flushPromises();expect(saves()[0]).toMatchObject({bodyArea:'合成特殊部位',name:'合成不适'});
});
it('offers date shortcuts, multi-select companions and editable preset fields without replacing custom text',async()=>{
 const wrapper=render();await wrapper.get('input[required]').setValue('合成主症状');
 const dateButtons=wrapper.get('[aria-label="开始日期快捷选择"]').findAll('button');await dateButtons[0].trigger('click');expect(wrapper.getComponent(DateTimePicker).props('modelValue')).toMatch(/^\d{4}-\d{2}-\d{2}$/);await dateButtons[2].trigger('click');
 await wrapper.get('.create-more summary').trigger('click');
 const companions=wrapper.get('[aria-label="伴随症状快捷选择"]').findAll('button');await wrapper.get('[aria-label="伴随症状"]').setValue('合成伴随');
 await companions[0].trigger('click');await companions[1].trigger('click');await companions[0].trigger('click');
 expect((wrapper.get('[aria-label="伴随症状"]').element as HTMLInputElement).value).toBe('合成伴随、乏力');
 await wrapper.get('[aria-label="可能诱因"]').setValue('合成诱因');await wrapper.get('[aria-label="缓解因素"]').setValue('合成缓解');
 await wrapper.get('form').trigger('submit');await flushPromises();expect(saves()[0]).toMatchObject({startedAt:null,triggerText:'合成诱因',relievingText:'合成缓解',associatedSymptomsText:'合成伴随、乏力'});
});
it('resets area and preset state on member changes and disables suggestion controls while saving',async()=>{
 const wrapper=render();await wrapper.get('[aria-label="不适部位"]').findAll('button').find(button=>button.text()==='腹部')!.trigger('click');await wrapper.get('[aria-label="腹部常用症状"]').findAll('button')[0].trigger('click');
 let finish!:(value:unknown)=>void;await settleCandidates();mocks.request.mockReturnValueOnce(new Promise(resolve=>finish=resolve));await wrapper.get('form').trigger('submit');await flushPromises();
 expect(wrapper.get('fieldset').attributes('disabled')).toBeDefined();app.selectedMemberId.value='other';app.selectedMember.value={id:'other',permission:'manager'};await flushPromises();
 expect(wrapper.get('[aria-label="不适部位"] [aria-pressed=true]').text()).toBe('全身／不确定');expect((wrapper.get('input[required]').element as HTMLInputElement).value).toBe('');
 finish({id:'old',memberId:'member'});await flushPromises();expect(mocks.push).not.toHaveBeenCalled();
});

it('saves chosen detailed location, frequency, trigger and relief without typing any free text',async()=>{
 const wrapper=render();await wrapper.get('[aria-label="不适部位"]').findAll('button').find(button=>button.text()==='腹部')!.trigger('click');
 await wrapper.get('[aria-label="腹部常用症状"]').findAll('button').find(button=>button.text()==='腹痛')!.trigger('click');
 const choose=(label:string,value:string)=>wrapper.findAllComponents(FormSelect).find(select=>select.props('ariaLabel')===label)!.vm.$emit('update:modelValue',value);
 choose('选择具体身体部位常用值','左下腹');choose('选择症状发生频率常用值','间歇性');choose('选择可能诱因常用值','进食后');choose('选择缓解因素常用值','休息后缓解');
 await flushPromises();await wrapper.get('form').trigger('submit');await flushPromises();
 expect(saves()[0]).toMatchObject({name:'腹痛',bodyArea:'左下腹',frequency:'间歇性',triggerText:'进食后',relievingText:'休息后缓解',description:'',severity:null,startedAt:null});
});

it('summarizes filled optional data, including zero severity, when the section is closed',async()=>{
 const wrapper=render();expect(wrapper.get('.create-more summary').text()).toContain('选填');
 const select=(label:string,value:string)=>wrapper.findAllComponents(FormSelect).find(item=>item.props('ariaLabel')===label)!.vm.$emit('update:modelValue',value);
 await wrapper.getComponent(SymptomSeverityPicker).get('[aria-label="0 / 10"]').trigger('click');select('选择症状发生频率常用值','间歇性');await flushPromises();
 expect(wrapper.get('.create-more summary').text()).toContain('程度 0/10');expect(wrapper.get('.create-more summary').text()).toContain('间歇性');
 await wrapper.get('[aria-label="可能诱因"]').setValue('合成诱因');expect(wrapper.get('.create-more summary').text()).toContain('另 1 项');
});

it('reselecting the current expanded region closes the chooser without losing a detailed location',async()=>{
 const wrapper=render();await wrapper.get('[aria-label="不适部位"]').findAll('button').find(button=>button.text()==='腹部')!.trigger('click');
 await wrapper.get('[aria-label="具体身体部位"]').setValue('左下腹');await wrapper.get('.symptom-more-areas').trigger('click');
 await wrapper.get('[aria-label="不适部位"]').findAll('button').find(button=>button.text()==='腹部')!.trigger('click');
 expect(wrapper.get('.symptom-more-areas').attributes('aria-expanded')).toBe('false');expect((wrapper.get('[aria-label="具体身体部位"]').element as HTMLInputElement).value).toBe('左下腹');
});

it('shows optional temperature only for matching symptoms and saves it with its own timestamp',async()=>{
 const wrapper=render();expect(wrapper.find('[aria-label="体温测量"]').exists()).toBe(false);
 await wrapper.get('[aria-label="全身／不确定常用症状"]').findAll('button').find(button=>button.text()==='发热')!.trigger('click');
 expect(wrapper.get('[aria-label="体温测量"]').text()).toContain('℃');const pickers=wrapper.findAllComponents(DateTimePicker);
 const measured=pickers.find(picker=>picker.props('ariaLabel')==='体温测量时间')!;expect(measured.props('modelValue')).toMatch(/^\d{4}-\d{2}-\d{2}T/);
 await wrapper.get('[aria-label="体温"]').setValue('38.2');measured.vm.$emit('update:modelValue','2026-01-02T08:30:00');
 pickers.find(picker=>picker.props('ariaLabel')==='症状开始日期')!.vm.$emit('update:modelValue','2026-01-01');
 await wrapper.get('form').trigger('submit');await flushPromises();expect(saves()[0]).toMatchObject({name:'发热',startedAt:'2026-01-01',initialMeasurements:[{kind:'temperature',value:'38.2',recordedAt:'2026-01-02T08:30:00'}]});
});
it('keeps fever entry optional, never sends hidden measurements for another symptom, and resets them on member changes',async()=>{
 const wrapper=render();await wrapper.get('input[required]').setValue('发热');await wrapper.get('[aria-label="体温"]').setValue('38.2');
 await wrapper.get('input[required]').setValue('合成其他不适');expect(wrapper.find('[aria-label="体温测量"]').exists()).toBe(false);
 await settleCandidates();mocks.request.mockRejectedValueOnce(Error('合成保存失败'));await wrapper.get('form').trigger('submit');await flushPromises();expect(saves()[0]).not.toHaveProperty('initialMeasurements');
 app.selectedMemberId.value='other';app.selectedMember.value={id:'other',permission:'manager'};await flushPromises();await wrapper.get('input[required]').setValue('发热');expect((wrapper.get('[aria-label="体温"]').element as HTMLInputElement).value).toBe('');
 await wrapper.get('form').trigger('submit');await flushPromises();expect(saves()[1]).not.toHaveProperty('initialMeasurements');
});
it('validates an entered value and its measurement time before submitting and retains the same measurement on retries',async()=>{
 const wrapper=render();await wrapper.get('input[required]').setValue('发热');await wrapper.get('[aria-label="体温"]').setValue('很高');
 await wrapper.get('form').trigger('submit');await flushPromises();expect(saves()).toHaveLength(0);expect(wrapper.get('[role="alert"]').text()).toContain('体温数值');
 await wrapper.get('[aria-label="体温"]').setValue('38.1');const picker=wrapper.findAllComponents(DateTimePicker).find(picker=>picker.props('ariaLabel')==='体温测量时间')!;picker.vm.$emit('update:modelValue',null);await flushPromises();
 await wrapper.get('form').trigger('submit');await flushPromises();expect(saves()).toHaveLength(0);expect(wrapper.get('[role="alert"]').text()).toContain('测量时间');
 picker.vm.$emit('update:modelValue','2026-01-02T08:30:00');await settleCandidates();mocks.request.mockRejectedValueOnce(Error('合成响应丢失'));await wrapper.get('form').trigger('submit');await flushPromises();
 await settleCandidates();mocks.request.mockRejectedValueOnce(Error('合成重试失败'));await wrapper.get('form').trigger('submit');await flushPromises();expect(saves()[0].requestKey).toBe(saves()[1].requestKey);expect(saves()[0].initialMeasurements).toEqual(saves()[1].initialMeasurements);
});

it('continues a chosen same-name symptom and offers immediate correction without creating another symptom',async()=>{
 const candidate={id:'source',memberId:'member',name:'发热',bodyArea:'合成部位',startedAt:'2026-01-01',latestAt:'2026-01-02',status:'active',unit:'℃'};
 const observation={ref:{kind:'symptom',id:'observation'},record:{kind:'symptom',id:'source'},memberId:'member',name:'发热',recordedAt:'2026-01-03T08:00:00',revision:1,category:'temperature',change:null,severity:null,measurementValue:'38.2',measurementUnit:'℃',amount:null,amountUnit:null,description:null};
 mocks.request.mockImplementation(async(path:string,options:any)=>path==='symptoms/candidates'?{memberId:'member',scope:'process',items:[candidate],total:1}:path==='symptoms/source/observations'?observation:path.startsWith('health-observations/')?{...observation,...(options?.method==='PATCH'?{measurementValue:'37.8',revision:2}:{})}:{id:'created',memberId:'member'});
 const wrapper=render();await wrapper.get('input[required]').setValue('发热');await settleCandidates();expect(wrapper.get('[aria-label="已有同名症状"]').text()).toContain('合成部位');
 await wrapper.get('[aria-label="体温"]').setValue('38.2');await wrapper.get('.symptom-candidate button').trigger('click');await flushPromises();
 const body=new DOMWrapper(document.body);const dialog=body.get('.observation-editor-modal');expect(dialog.text()).toContain('补充这个症状的变化');expect((dialog.get('input[name=measurementValue]').element as HTMLInputElement).value).toBe('38.2');
 await dialog.get('form').trigger('submit');await flushPromises();expect(saves()).toHaveLength(0);expect(wrapper.get('.observation-receipt').text()).toContain('38.2');expect((wrapper.get('input[required]').element as HTMLInputElement).value).toBe('');
 await wrapper.get('.observation-receipt button').trigger('click');await flushPromises();await body.get('.observation-editor-modal input[name=measurementValue]').setValue('37.8');await body.get('.observation-editor-modal form').trigger('submit');await flushPromises();
 expect(wrapper.get('.observation-receipt').text()).toContain('37.8');expect(mocks.request.mock.calls.find(([path,options])=>path==='health-observations/symptom/observation'&&options?.method==='PATCH')).toBeTruthy();expect(saves()).toHaveLength(0);
});
it('multiple matches require a choice and a separate explicit action can still create a new episode of discomfort',async()=>{
 const candidate={id:'source',memberId:'member',name:'发热',bodyArea:null,startedAt:null,latestAt:null,status:'active',unit:'℃'};
 mocks.request.mockImplementation(async(path:string)=>path==='symptoms/candidates'?{memberId:'member',scope:'member',items:[candidate,{...candidate,id:'second'}],total:2}:{id:'created',memberId:'member'});
 const wrapper=render();await wrapper.get('input[required]').setValue('发热');await settleCandidates();await wrapper.get('form').trigger('submit');await flushPromises();expect(saves()).toHaveLength(0);expect(document.querySelector('.observation-editor-modal')).toBeNull();
 await wrapper.get('.symptom-create-another').trigger('click');await flushPromises();expect(saves()).toHaveLength(1);expect(saves()[0].name).toBe('发热');
});
it('concurrent submits share one candidate lookup and create at most once; late old-member candidates stay hidden',async()=>{
 let finish!:(value:unknown)=>void;const promise=new Promise(resolve=>finish=resolve);mocks.request.mockImplementation(async(path:string,options:any)=>path==='symptoms/candidates'?promise:{id:'created',memberId:'member'});
 const wrapper=render();await wrapper.get('input[required]').setValue('合成症状');await wrapper.get('form').trigger('submit');await wrapper.get('form').trigger('submit');expect(mocks.request.mock.calls.filter(([path])=>path==='symptoms/candidates')).toHaveLength(1);
 finish({memberId:'member',scope:'member',items:[],total:0});await flushPromises();expect(saves()).toHaveLength(1);
});
it('ignores a candidate lookup that returns after changing members',async()=>{
 let finish!:(value:unknown)=>void;mocks.request.mockImplementationOnce(()=>new Promise(resolve=>finish=resolve));const wrapper=render();await wrapper.get('input[required]').setValue('发热');await settleCandidates();
 app.selectedMemberId.value='other';app.selectedMember.value={id:'other',permission:'manager'};await flushPromises();finish({memberId:'member',scope:'member',items:[{id:'old',memberId:'member',name:'发热'}],total:1});await flushPromises();expect(wrapper.find('[aria-label="已有同名症状"]').exists()).toBe(false);expect(wrapper.find('.observation-editor-modal').exists()).toBe(false);
});
it('creates inside an independent dialog and associates the current process without leaving it',async()=>{
 route.path=route.fullPath='/health-processes/process';
 const wrapper=mount(Page,{props:{embedded:true,memberId:'member',processId:'process'},attachTo:document.body});wrappers.push(wrapper);
 const dialog=new DOMWrapper(document.body).get('.process-editor-modal');
 expect(dialog.attributes('aria-label')).toBe('新增症状');expect(dialog.text()).toContain('保存后加入当前健康历程');
 expect(dialog.find('.subpage-header').exists()).toBe(false);
 await dialog.get('[aria-label="症状名称"]').setValue('合成弹窗症状');await dialog.get('form').trigger('submit');await flushPromises();
 expect(saves()[0]).toMatchObject({memberId:'member',processId:'process',name:'合成弹窗症状',relatedRecords:[]});
 expect(wrapper.emitted('saved')).toHaveLength(1);expect(mocks.push).not.toHaveBeenCalled();
});
it('retains a failed dialog draft and closes cleanly through the existing unsaved guard',async()=>{
 route.path=route.fullPath='/health-processes/process';
 mocks.request.mockImplementation(async(path:string)=>{if(path==='symptoms/candidates')return {memberId:'member',scope:'process',items:[],total:0};throw Error('合成新增失败');});
 const wrapper=mount(Page,{props:{embedded:true,memberId:'member',processId:'process'},attachTo:document.body});wrappers.push(wrapper);
 const dialog=new DOMWrapper(document.body).get('.process-editor-modal');
 await dialog.get('[aria-label="症状名称"]').setValue('合成失败草稿');await dialog.get('form').trigger('submit');await flushPromises();
 expect(dialog.text()).toContain('合成新增失败');expect((dialog.get('[aria-label="症状名称"]').element as HTMLInputElement).value).toBe('合成失败草稿');
 expect(wrapper.emitted('saved')).toBeUndefined();expect(mocks.push).not.toHaveBeenCalled();
 await dialog.get('[aria-label="关闭新增症状"]').trigger('click');expect(mocks.ask).toHaveBeenCalled();expect(wrapper.emitted('close')).toBeUndefined();
});
it('completes same-name continuation in the process dialog without creating another symptom or navigating',async()=>{
 route.path=route.fullPath='/health-processes/process';
 const candidate={id:'source',memberId:'member',name:'发热',bodyArea:null,startedAt:'2026-01-01',latestAt:null,status:'active',unit:'℃'};
 const observation={ref:{kind:'symptom',id:'observation'},record:{kind:'symptom',id:'source'},memberId:'member',name:'发热',recordedAt:'2026-01-03T08:00:00',revision:1,category:'temperature',change:null,severity:null,measurementValue:'38.2',measurementUnit:'℃',amount:null,amountUnit:null,description:null};
 mocks.request.mockImplementation(async(path:string)=>path==='symptoms/candidates'?{memberId:'member',scope:'process',items:[candidate],total:1}:observation);
 const wrapper=mount(Page,{props:{embedded:true,memberId:'member',processId:'process'},attachTo:document.body});wrappers.push(wrapper);
 const dialog=new DOMWrapper(document.body).get('.process-editor-modal');
 await dialog.get('[aria-label="症状名称"]').setValue('发热');await settleCandidates();
 await dialog.get('[aria-label="体温"]').setValue('38.2');await dialog.get('.symptom-candidate button').trigger('click');await flushPromises();
 const continuation=new DOMWrapper(document.body).get('.observation-editor-modal');await continuation.get('form').trigger('submit');await flushPromises();
 expect(saves()).toHaveLength(0);expect(wrapper.emitted('saved')).toHaveLength(1);expect(mocks.push).not.toHaveBeenCalled();
 const request=mocks.request.mock.calls.find(([path])=>path==='symptoms/source/observations')!;
 expect(JSON.parse(request[1].body)).toMatchObject({processId:'process',memberId:'member',measurementValue:'38.2'});
});

it('shows primary fever measurement before same-name suggestions in the process dialog and deduplicates companion fever',async()=>{
 route.path=route.fullPath='/health-processes/process';
 mocks.request.mockImplementation(async(path:string)=>path==='symptoms/candidates'?{memberId:'member',scope:'process',items:[{id:'source',memberId:'member',name:'发热',unit:'℃',status:'active'}],total:1}:{id:'created',memberId:'member'});
 const wrapper=mount(Page,{props:{embedded:true,memberId:'member',processId:'process'},attachTo:document.body});wrappers.push(wrapper);const dialog=new DOMWrapper(document.body).get('.process-editor-modal');
 await dialog.get('[aria-label="全身／不确定常用症状"]').findAll('button').find(item=>item.text()==='发热')!.trigger('click');await settleCandidates();
 expect(dialog.findAll('[aria-label="体温测量"]')).toHaveLength(1);expect(dialog.get('[aria-label="体温测量"]').element.compareDocumentPosition(dialog.get('.symptom-continuations').element)&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
 await dialog.get('[aria-label="伴随症状快捷选择"]').findAll('button').find(item=>item.text()==='发热')!.trigger('click');
 expect(dialog.findAll('[aria-label="体温测量"]')).toHaveLength(1);expect(dialog.find('.symptom-associated-measurements').exists()).toBe(false);
});
it('expands temperature below companion fever tags and saves the measurement with the original symptom and process',async()=>{
 route.path=route.fullPath='/health-processes/process';const wrapper=mount(Page,{props:{embedded:true,memberId:'member',processId:'process'},attachTo:document.body});wrappers.push(wrapper);const dialog=new DOMWrapper(document.body).get('.process-editor-modal');
 await dialog.get('[aria-label="症状名称"]').setValue('咳嗽');expect(dialog.find('[aria-label="体温测量"]').exists()).toBe(false);
 const details=dialog.get('.create-more');(details.element as HTMLDetailsElement).open=true;await details.trigger('toggle');
 await dialog.get('[aria-label="伴随症状快捷选择"]').findAll('button').find(item=>item.text()==='发热')!.trigger('click');await flushPromises();
 expect(dialog.get('.symptom-associated-measurements [aria-label="体温测量"]').exists()).toBe(true);expect(dialog.findAll('[aria-label="体温测量"]')).toHaveLength(1);
 await dialog.get('[aria-label="体温"]').setValue('38.2');wrapper.findAllComponents(DateTimePicker).find(item=>item.props('ariaLabel')==='体温测量时间')!.vm.$emit('update:modelValue','2026-01-02T08:30:00');
 await dialog.get('form').trigger('submit');await flushPromises();expect(saves()[0]).toMatchObject({name:'咳嗽',associatedSymptomsText:'发热',processId:'process',initialMeasurements:[{kind:'temperature',value:'38.2',recordedAt:'2026-01-02T08:30:00'}]});expect(wrapper.emitted('saved')).toHaveLength(1);
});
it('recognizes exact fever aliases among companions and provides explicit temperature entry for other symptoms',async()=>{
 const wrapper=render();await wrapper.get('[aria-label="症状名称"]').setValue('头痛');await wrapper.get('[aria-label="伴随症状"]').setValue('无发热、乏力');expect(wrapper.find('[aria-label="体温测量"]').exists()).toBe(false);
 await wrapper.get('[aria-label="伴随症状"]').setValue(' 发烧，乏力 ');expect(wrapper.get('.symptom-associated-measurements [aria-label="体温测量"]').exists()).toBe(true);
 await wrapper.get('[aria-label="伴随症状"]').setValue('');expect(wrapper.find('[aria-label="体温测量"]').exists()).toBe(false);
 await wrapper.get('.symptom-initial-temperature-add').trigger('click');expect(wrapper.get('[aria-label="体温测量"]').exists()).toBe(true);await wrapper.get('[aria-label="体温"]').setValue('37.5');
 await wrapper.get('form').trigger('submit');await flushPromises();expect(saves()[0]).toMatchObject({name:'头痛',associatedSymptomsText:'',initialMeasurements:[{kind:'temperature',value:'37.5'}]});
});
it('continues a non-fever symptom with attached temperature instead of treating it as a generic measurement or creating another symptom',async()=>{
 const candidate={id:'source',memberId:'member',name:'咳嗽',bodyArea:null,startedAt:null,latestAt:null,status:'active',unit:null};
 mocks.request.mockImplementation(async(path:string)=>path==='symptoms/candidates'?{memberId:'member',scope:'member',items:[candidate],total:1}:{ref:{kind:'symptom',id:'saved'},record:{kind:'symptom',id:'source'},memberId:'member',name:'咳嗽',recordedAt:'2026-01-02T08:30:00',temperatureValue:'38.2',category:'temperature'});
 const wrapper=render();await wrapper.get('[aria-label="症状名称"]').setValue('咳嗽');await wrapper.get('[aria-label="伴随症状"]').setValue('发热');await wrapper.get('[aria-label="体温"]').setValue('38.2');await settleCandidates();await wrapper.get('.symptom-candidate button').trigger('click');await flushPromises();
 const dialog=new DOMWrapper(document.body).get('.observation-editor-modal');expect((dialog.get('input[name=temperatureValue]').element as HTMLInputElement).value).toBe('38.2');await dialog.get('form').trigger('submit');await flushPromises();
 const saved=mocks.request.mock.calls.find(([path])=>path==='symptoms/source/observations')!;expect(JSON.parse(saved[1].body)).toMatchObject({temperatureValue:'38.2',measurementValue:''});expect(saves()).toHaveLength(0);
});
