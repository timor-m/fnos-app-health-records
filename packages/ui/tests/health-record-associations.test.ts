import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { ref } from 'vue';
import type { HealthFeedEntry } from '../../shared/health-categories';
import type { RecordAssociation } from '../../shared/health-record-associations';
const mocks=vi.hoisted(()=>({request:vi.fn(),ask:vi.fn(),toast:vi.fn()}));
const app={selectedMemberId:ref('member'),selectedMember:ref({id:'member',permission:'manager'}),dataVersion:ref(0),notifyDataChanged:vi.fn()};
vi.mock('../src/utils/api',()=>({request:mocks.request}));
vi.mock('../src/composables/useAppContext',()=>({useAppContext:()=>app}));
vi.mock('../src/composables/useConfirm',()=>({useConfirm:()=>({ask:mocks.ask,state:ref(null),cancel:vi.fn()})}));
vi.mock('../src/composables/useToast',()=>({useToast:()=>({show:mocks.toast})}));
vi.mock('vue-router',()=>({useRoute:()=>({fullPath:'/events?category=symptom'}),RouterLink:{props:['to'],template:'<a><slot/></a>'}}));
import Associations from '../src/components/HealthRecordAssociations.vue';
import Picker from '../src/components/HealthRecordPicker.vue';
import SymptomDetail from '../src/components/HealthSymptomDetail.vue';
import FormSelect from '../src/components/FormSelect.vue';
import ReportAssociation from '../src/components/ReportProcessAssociation.vue';
const entry=(id='report'):HealthFeedEntry=>({id:`report:${id}`,kind:'report',resourceId:id,memberId:'member',category:'report',title:'合成报告 '+id,date:'2026-01-01',subtype:'laboratory',description:null,status:'ready',institution:null,documents:[],processIds:[]});
const result=():RecordAssociation=>({memberId:'member',subject:{kind:'symptom',id:'symptom'},title:'合成症状',processes:[{id:'process',memberId:'member',title:'合成阶段',startedAt:'2026-01-01',latestAt:null,recordCount:2,summary:null,aiState:'unconfigured',manuallyEdited:false}],records:[],evidence:[]});
const wrappers:ReturnType<typeof mount>[]=[];
function render(){const wrapper=mount(Associations,{props:{subject:{kind:'symptom',id:'symptom'},memberId:'member'},global:{stubs:{FormSelect:true,teleport:true}}});wrappers.push(wrapper);return wrapper;}
function button(wrapper:ReturnType<typeof mount>,text:string){return wrapper.findAll('button').find(item=>item.text()===text)!;}
beforeEach(()=>{vi.clearAllMocks();app.selectedMemberId.value='member';app.selectedMember.value={id:'member',permission:'manager'};
 mocks.request.mockImplementation(async(path:string,options?:RequestInit)=>{
  if(path.startsWith('health-records?'))return {items:[entry()],nextCursor:null,hasMore:false};
  if(options?.method){const body=JSON.parse(String(options.body));return body.preview?{token:'token',processTitle:'合成阶段',moves:[],recordCount:2,recordTitles:['合成症状','合成报告']}:result();}
  return {...result(),processes:[]};
 });});
afterEach(()=>{wrappers.splice(0).forEach(wrapper=>wrapper.unmount());vi.useRealTimers();});

it.each(['report','medication_document','symptom','medication','intake','vaccination'] as const)('%s detail shows shared process membership without related reports, direct links or management',async kind=>{
 const data=result();data.subject={kind,id:'current'};data.records=[{entry:entry('direct'),directlyLinked:true},{entry:entry('indirect'),directlyLinked:false}];data.evidence=[{ref:{kind:'report',id:'proof'},title:'合成来源',label:'来源'}];mocks.request.mockResolvedValue(data);
 const wrapper=mount(Associations,{props:{subject:data.subject,memberId:'member',compact:true,openInPlace:true}});wrappers.push(wrapper);await flushPromises();
 expect(wrapper.get('.association-process-entry').text()).toContain('合成阶段');expect(wrapper.get('.association-process-entry').text()).toContain('2 条记录');expect(wrapper.get('.association-process-entry').text()).toContain('查看历程');
 expect(wrapper.find('.association-records').exists()).toBe(false);expect(wrapper.find('.association-evidence').exists()).toBe(false);expect(wrapper.find('button').exists()).toBe(false);expect(wrapper.text()).not.toContain('相关记录');expect(wrapper.text()).not.toContain('合成报告');
});
it('keeps the shared process entry through refresh failures and retry',async()=>{
 const data=result();data.records=[{entry:entry(),directlyLinked:false}];mocks.request.mockResolvedValue(data);
 const wrapper=render();await flushPromises();const process=wrapper.get('.association-process-entry').element;
 mocks.request.mockRejectedValueOnce(Error('合成刷新失败'));app.dataVersion.value++;await flushPromises();expect(wrapper.get('.association-process-entry').element).toBe(process);
 expect(wrapper.get('[role="alert"]').text()).toContain('合成刷新失败');mocks.request.mockResolvedValue(data);await button(wrapper,'重试').trigger('click');await flushPromises();expect(wrapper.find('[role="alert"]').exists()).toBe(false);
});
it('report details show only the process summary and entry, leaving records and management in the process',async()=>{
 const data=result();data.records=[{entry:entry('direct'),directlyLinked:true},{entry:entry('indirect'),directlyLinked:false}];data.evidence=[{ref:{kind:'report',id:'source'},title:'合成来源',label:'来源'}];mocks.request.mockResolvedValue(data);
 const wrapper=mount(ReportAssociation,{props:{reportId:'report',memberId:'member'}});wrappers.push(wrapper);await flushPromises();
 expect(wrapper.get('.association-process-entry').text()).toContain('合成阶段');expect(wrapper.get('.association-process-entry').text()).toContain('2 条记录');expect(wrapper.get('.association-process-entry').text()).toContain('查看历程');
 expect(wrapper.find('.association-records').exists()).toBe(false);expect(wrapper.find('.association-evidence').exists()).toBe(false);expect(wrapper.text()).not.toContain('解除关联');expect(wrapper.findAll('button')).toHaveLength(0);
});
it('a report without a process retains the first association entry and refreshes into a summary after saving',async()=>{
 const data=result();data.subject={kind:'report',id:'report'};data.processes=[];mocks.request.mockResolvedValue(data);
 const wrapper=mount(ReportAssociation,{props:{reportId:'report',memberId:'member'},global:{stubs:{HealthRecordAssociationModal:true}}});wrappers.push(wrapper);await flushPromises();
 await button(wrapper,'关联历程').trigger('click');await flushPromises();
 const saved=result();saved.subject=data.subject;mocks.request.mockResolvedValueOnce(saved);
 wrapper.findComponent({name:'HealthRecordAssociationModal'}).vm.$emit('confirm',[{kind:'symptom',id:'symptom'}]);await flushPromises();
 expect(wrapper.get('.association-process-entry').text()).toContain('查看历程');expect(wrapper.find('.association-records').exists()).toBe(false);expect(button(wrapper,'关联历程')).toBeUndefined();expect(wrapper.emitted('updated')).toHaveLength(1);
});
it('saves selected record links in one step without process selection or naming',async()=>{
 const wrapper=render();await flushPromises();await button(wrapper,'关联历程').trigger('click');await flushPromises();
 expect(wrapper.findComponent(FormSelect).exists()).toBe(false);expect(wrapper.find('input[maxlength="120"]').exists()).toBe(false);
 await wrapper.get('.record-picker-option input').setValue(true);await wrapper.get('form').trigger('submit');await flushPromises();
 const saves=mocks.request.mock.calls.filter(([,options])=>options?.method);expect(saves).toHaveLength(1);const body=JSON.parse(saves[0][1].body);
 expect(body).toMatchObject({subject:{kind:'symptom',id:'symptom'},records:[{kind:'report',id:'report'}],action:'attach'});expect(body).not.toHaveProperty('episodeId');expect(body).not.toHaveProperty('preview');expect(body.requestKey).toBeTruthy();expect(wrapper.emitted('updated')).toHaveLength(1);
});
it('save failures preserve selected records and retries retain their idempotency key',async()=>{
 const wrapper=render();await flushPromises();await button(wrapper,'关联历程').trigger('click');await flushPromises();await wrapper.get('.record-picker-option input').setValue(true);
 mocks.request.mockRejectedValueOnce(Error('合成保存失败'));await wrapper.get('form').trigger('submit');await flushPromises();expect(wrapper.get('[role="alert"]').text()).toContain('合成保存失败');expect(wrapper.getComponent(Picker).props('modelValue')).toHaveLength(1);
 await wrapper.get('form').trigger('submit');await flushPromises();const saves=mocks.request.mock.calls.filter(([,options])=>options?.method).map(([,options])=>JSON.parse(options.body));expect(saves[0].requestKey).toBe(saves[1].requestKey);
});
it('viewer can open the process but cannot edit links; member changes reject stale replies',async()=>{
 mocks.request.mockResolvedValue(result());app.selectedMember.value.permission='viewer';const wrapper=render();await flushPromises();expect(wrapper.find('button').exists()).toBe(false);expect(wrapper.get('.association-process-entry').text()).toContain('查看历程');
 let resolve!:(value:RecordAssociation)=>void;mocks.request.mockReturnValue(new Promise(done=>resolve=done));await wrapper.setProps({subject:{kind:'symptom',id:'next'}});app.selectedMemberId.value='other';await flushPromises();resolve(result());await flushPromises();expect(wrapper.text()).not.toContain('合成阶段');
});
it('record picker filters clinical dates and rejects foreign results',async()=>{
 const wrapper=mount(Picker,{props:{memberId:'member',modelValue:[]}});wrappers.push(wrapper);await flushPromises();expect(wrapper.findAll('.record-picker-filters button').at(-1)!.text()).toBe('影像');expect(button(wrapper,'影像').attributes('disabled')).toBeDefined();await button(wrapper,'报告').trigger('click');await flushPromises();expect(mocks.request.mock.calls.at(-1)![0]).toContain('category=report');
 vi.useFakeTimers();await wrapper.get('[type="search"]').setValue('2026-01');await vi.advanceTimersByTimeAsync(260);await flushPromises();expect(mocks.request.mock.calls.at(-1)![0]).toContain('q=2026-01');vi.useRealTimers();
 mocks.request.mockResolvedValue({items:[{...entry(),memberId:'other'}],nextCursor:null});await button(wrapper,'全部').trigger('click');await flushPromises();expect(wrapper.find('.record-picker-option').exists()).toBe(false);
});
it('actual symptom detail loads encoded legacy IDs, renders the record, and retries errors',async()=>{
 let failed=true;const id='legacy-symptom:old';mocks.request.mockImplementation(async(path:string)=>{expect(path).toBe('symptoms/legacy-symptom%3Aold');if(failed)throw Error('合成临时错误');return {symptomId:id,episode:{id:'process',memberId:'member',symptoms:[{id,name:'合成旧症状'}]}};});
 const wrapper=mount(SymptomDetail,{props:{recordId:id},global:{stubs:{HealthRecordAssociations:true,ProcessSymptomTracker:{props:['episode'],template:'<p>{{episode.symptoms[0].name}}</p>'}}}});wrappers.push(wrapper);await flushPromises();expect(wrapper.get('[role="alert"]').text()).toContain('合成临时错误');failed=false;await button(wrapper,'重试').trigger('click');await flushPromises();expect(wrapper.text()).toContain('合成旧症状');expect(wrapper.find('[role="alert"]').exists()).toBe(false);expect(wrapper.emitted('heading')?.at(-1)).toEqual([{title:'合成旧症状',category:'symptom'}]);
});

it('a symptom omitted from an otherwise valid detail response shows an actionable error instead of empty content',async()=>{
 mocks.request.mockResolvedValue({symptomId:'missing',episode:{id:'process',memberId:'member',symptoms:[]}});
 const wrapper=mount(SymptomDetail,{props:{recordId:'missing'},global:{stubs:{HealthRecordAssociations:true,ProcessSymptomTracker:true}}});wrappers.push(wrapper);await flushPromises();
 expect(wrapper.get('[role="alert"]').text()).toContain('症状已移除或数据不完整');expect(button(wrapper,'重试').exists()).toBe(true);expect(wrapper.findComponent({name:'ProcessSymptomTracker'}).exists()).toBe(false);
});
