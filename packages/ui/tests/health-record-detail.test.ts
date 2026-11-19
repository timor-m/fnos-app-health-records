import { afterEach,beforeEach,expect,it,vi } from 'vitest';
import { flushPromises,mount } from '@vue/test-utils';
import { computed,reactive,ref } from 'vue';
const mocks=vi.hoisted(()=>({request:vi.fn(),push:vi.fn(),replace:vi.fn()}));
const app={selectedMemberId:ref('member'),selectedMember:ref({id:'member',permission:'manager'}),notifyDataChanged:vi.fn()};
const route=reactive({path:'/events/detail/report/r1',params:{kind:'report',id:'r1'},query:{} as Record<string,string>});const touch=ref(false);
vi.mock('../src/utils/api',()=>({request:mocks.request}));vi.mock('../src/composables/useAppContext',()=>({useAppContext:()=>app}));vi.mock('../src/composables/useTouchRecordDetail',()=>({useTouchRecordDetail:()=>touch}));vi.mock('vue-router',()=>({useRoute:()=>route,useRouter:()=>({push:mocks.push,replace:mocks.replace})}));
vi.mock('../src/components/ReportDetail.vue',()=>({default:{name:'ReportDetail',props:['reportId','expectedMemberId','variant','hideTitle','initialDetail'],emits:['close','updated','openCandidate','heading'],template:'<div class="report">{{reportId}}</div>'}}));
vi.mock('../src/components/VaccinationDocument.vue',()=>({default:{name:'VaccinationDocument',props:['reportId','hideTitle'],emits:['updated','heading'],template:'<div class="vaccination-document"/>'}}));
vi.mock('../src/components/MedicationRecords.vue',()=>({default:{name:'MedicationRecords',props:['courseId','intakeId','reportId'],emits:['updated','heading'],template:'<div class="medication"/>'}}));
vi.mock('../src/components/HealthSymptomDetail.vue',()=>({default:{name:'HealthSymptomDetail',props:['recordId','openRelatedInPlace'],emits:['updated','heading','openRecord'],template:'<div class="symptom"/>'}}));
vi.mock('../src/components/VaccinationDetail.vue',()=>({default:{name:'VaccinationDetail',props:['recordId'],emits:['close','updated','openReport','heading'],template:'<div class="vaccination"/>'}}));
import Content from '../src/components/HealthRecordDetailContent.vue';
import Bundle from '../src/components/ReportBundleDetail.vue';
import Page from '../src/pages/HealthRecordDetailPage.vue';
import ReportDetail from '../src/components/ReportDetail.vue';
import VaccinationDocument from '../src/components/VaccinationDocument.vue';
import MedicationRecords from '../src/components/MedicationRecords.vue';
import HealthSymptomDetail from '../src/components/HealthSymptomDetail.vue';
import VaccinationDetail from '../src/components/VaccinationDetail.vue';
const wrappers:any[]=[];function render(component:any,props:any={}){const wrapper=mount(component,{props});wrappers.push(wrapper);return wrapper;}

it('forwards related-record navigation from the symptom and supplies its name in the desktop heading',async()=>{
 const wrapper=render(Content,{kind:'symptom',recordId:'symptom',openRelatedInPlace:true});
 expect(wrapper.getComponent(HealthSymptomDetail).props('openRelatedInPlace')).toBe(true);
 wrapper.getComponent(HealthSymptomDetail).vm.$emit('openRecord',{kind:'report',id:'related'});
 expect(wrapper.emitted('openRecord')).toEqual([[{kind:'report',id:'related'}]]);
 route.path='/events/detail/symptom/symptom';route.params={kind:'symptom',id:'symptom'};const page=render(Page);await flushPromises();
 page.getComponent(HealthSymptomDetail).vm.$emit('heading',{category:'symptom',title:'合成症状名称'});await flushPromises();expect(page.get('h2').text()).toBe('合成症状名称');
});
beforeEach(()=>{vi.clearAllMocks();touch.value=false;app.selectedMemberId.value='member';app.selectedMember.value={id:'member',permission:'manager'};route.path='/events/detail/report/r1';route.params={kind:'report',id:'r1'};route.query={};vi.spyOn(HTMLElement.prototype,'scrollIntoView').mockImplementation(()=>{});mocks.request.mockResolvedValue({memberId:'member',category:'report',documents:[{id:'r1',title:'合成报告一'},{id:'r2',title:'合成报告二'}]});});afterEach(()=>{wrappers.splice(0).forEach(wrapper=>wrapper.unmount());vi.restoreAllMocks();});
it.each([['symptom',HealthSymptomDetail,'recordId'],['vaccination',VaccinationDetail,'recordId'],['medication',MedicationRecords,'courseId'],['intake',MedicationRecords,'intakeId']] as const)('routes %s to its exact actual resource',async(kind,component,prop)=>{const wrapper=render(Content,{kind,recordId:'target'});expect(wrapper.getComponent(component).props(prop)).toBe('target');wrapper.getComponent(component).vm.$emit('updated');expect(wrapper.emitted('updated')).toHaveLength(1);});
it('report grouping preflights ownership and opens only the selected source document',async()=>{const wrapper=render(Bundle,{recordId:'r1'});await flushPromises();const child=wrapper.getComponent(ReportDetail);expect(child.props()).toMatchObject({reportId:'r1',expectedMemberId:'member',variant:'panel'});expect(wrapper.findAll('[aria-label="同次资料"] button').map(button=>button.attributes('aria-pressed'))).toEqual(['true','false']);await wrapper.findAll('[aria-label="同次资料"] button')[1].trigger('click');expect(wrapper.findAll('[aria-label="同次资料"] button').map(button=>button.attributes('aria-pressed'))).toEqual(['false','true']);expect(wrapper.getComponent(ReportDetail).props('reportId')).toBe('r2');wrapper.getComponent(ReportDetail).vm.$emit('openCandidate',{id:'duplicate'});expect(wrapper.emitted('openReport')).toEqual([['duplicate']]);});
it('rejects another member before mounting report originals or actions',async()=>{mocks.request.mockResolvedValue({memberId:'second',category:'report',documents:[{id:'secret',title:'不应展示'}]});const wrapper=render(Bundle,{recordId:'r1'});await flushPromises();expect(wrapper.findComponent(ReportDetail).exists()).toBe(false);expect(wrapper.text()).not.toContain('不应展示');expect(wrapper.get('[role="alert"]').text()).toContain('不属于当前成员');});
it('late document metadata cannot replace the current member or record',async()=>{let resolve!:(value:unknown)=>void;mocks.request.mockReturnValueOnce(new Promise(done=>resolve=done));const wrapper=render(Bundle,{recordId:'r1'});await wrapper.setProps({recordId:'r2'});await flushPromises();resolve({memberId:'member',category:'report',documents:[{id:'old',title:'旧资料'}]});await flushPromises();expect(wrapper.getComponent(ReportDetail).props('reportId')).toBe('r2');expect(wrapper.text()).not.toContain('旧资料');});
it('vaccination evidence uses the confirmation form while retaining the original document',async()=>{mocks.request.mockResolvedValue({memberId:'member',category:'vaccination',documents:[{id:'r1',title:'合成接种凭证'}]});const wrapper=render(Bundle,{recordId:'r1'});await flushPromises();expect(wrapper.getComponent(VaccinationDocument).props('reportId')).toBe('r1');expect(wrapper.findComponent(ReportDetail).exists()).toBe(false);});
it('member changes remount the detail content instead of reusing stale editors',async()=>{const wrapper=render(Content,{kind:'vaccination',recordId:'v1'});const child=wrapper.getComponent(VaccinationDetail).vm;app.selectedMemberId.value='second';await flushPromises();expect(wrapper.getComponent(VaccinationDetail).vm).not.toBe(child);});
it('desktop keeps a fixed internal back target and resets content when the selected kind changes',async()=>{const wrapper=render(Page);await flushPromises();expect(wrapper.get('h2').text()).toBe('资料详情');await wrapper.get('[aria-label="返回记录"]').trigger('click');expect(mocks.push).toHaveBeenCalledWith('/events');route.path='/events/detail/symptom/s1';route.params={kind:'symptom',id:'s1'};await flushPromises();expect(wrapper.getComponent(HealthSymptomDetail).props('recordId')).toBe('s1');});
it.each(['event','episode','__proto__','unsupported'])('does not expose removed or invalid standalone card kind %s',async kind=>{route.path=`/events/detail/${kind}/id`;route.params={kind,id:'id'};const wrapper=render(Page);await flushPromises();expect(wrapper.text()).toContain('记录链接无效');expect(wrapper.findComponent(Content).exists()).toBe(false);});
it('direct touch URLs open the same record over the timeline with query context retained',async()=>{touch.value=true;route.query={q:'kept'};const wrapper=render(Page);await flushPromises();expect(mocks.replace).toHaveBeenCalledWith({path:'/events',query:{q:'kept',recordKind:'report',recordId:'r1'}});expect(wrapper.findComponent(Content).exists()).toBe(false);});

it('touch redirection and route teardown never flash an invalid record warning',async()=>{
 touch.value=true;const wrapper=render(Page);await flushPromises();expect(wrapper.find('.health-record-detail-page').exists()).toBe(false);
 route.path='/events';route.params={kind:'',id:''};await flushPromises();expect(wrapper.text()).not.toContain('记录链接无效');
});

it('overview detail links return to overview on desktop and redirect to the same overview modal on touch',async()=>{
 route.query={from:'overview'};const wrapper=render(Page);await flushPromises();await wrapper.get('[aria-label="返回概览"]').trigger('click');expect(mocks.push).toHaveBeenCalledWith('/overview');
 touch.value=true;await flushPromises();expect(mocks.replace).toHaveBeenCalledWith({path:'/overview',query:{from:'overview',recordKind:'report',recordId:'r1'}});
});

it('publishes the selected document heading and forwards refreshed source titles',async()=>{
 const wrapper=render(Bundle,{recordId:'r1'});await flushPromises();
 expect(wrapper.emitted('heading')?.at(-1)).toEqual([{title:'合成报告一',category:'report'}]);
 await wrapper.findAll('[aria-label="同次资料"] button')[1].trigger('click');
 expect(wrapper.emitted('heading')?.at(-1)).toEqual([{title:'合成报告二',category:'report'}]);
 wrapper.getComponent(ReportDetail).vm.$emit('heading',{title:'编辑后的合成标题',category:'report'});
 expect(wrapper.emitted('heading')?.at(-1)).toEqual([{title:'编辑后的合成标题',category:'report'}]);
});
it('omits report body titles inside the modal across document switches while retaining standalone titles',async()=>{
 const wrapper=render(Content,{kind:'report',recordId:'r1',hideReportTitle:true});await flushPromises();
 expect(wrapper.getComponent(ReportDetail).props('hideTitle')).toBe(true);
 await wrapper.findAll('[aria-label="同次资料"] button')[1].trigger('click');
 expect(wrapper.getComponent(ReportDetail).props()).toMatchObject({reportId:'r2',hideTitle:true});
 expect(wrapper.emitted('heading')?.at(-1)).toEqual([{title:'合成报告二',category:'report'}]);
 await wrapper.setProps({hideReportTitle:false});expect(wrapper.getComponent(ReportDetail).props('hideTitle')).toBe(false);
});
it('passes the modal title setting to vaccination source documents',async()=>{
 mocks.request.mockResolvedValue({memberId:'member',category:'vaccination',documents:[{id:'r1',title:'合成接种凭证'}]});
 const wrapper=render(Content,{kind:'report',recordId:'r1',hideReportTitle:true});await flushPromises();
 expect(wrapper.getComponent(VaccinationDocument).props('hideTitle')).toBe(true);
});
it.each([['symptom',HealthSymptomDetail,'symptom'],['vaccination',VaccinationDetail,'vaccination'],['medication',MedicationRecords,'medication']] as const)('forwards %s heading metadata through the shared detail host',async(kind,component,category)=>{
 const wrapper=render(Content,{kind,recordId:'target'});wrapper.getComponent(component).vm.$emit('heading',{title:'合成记录标题',category});
 expect(wrapper.emitted('heading')).toEqual([[{title:'合成记录标题',category}]]);
});

it('opens a medication document directly in the report detail without an intermediate medication summary',async()=>{
 mocks.request.mockResolvedValue({memberId:'member',category:'medication',documents:[{id:'prescription',title:'合成用药单'}]});
 const wrapper=render(Content,{kind:'medication_document',recordId:'prescription'});await flushPromises();
 expect(mocks.request).toHaveBeenCalledWith('health-records/documents/prescription?includeDetail=true');
 expect(wrapper.getComponent(ReportDetail).props()).toMatchObject({reportId:'prescription',expectedMemberId:'member',variant:'panel',hideTitle:true});
 expect(wrapper.findComponent(MedicationRecords).exists()).toBe(false);
 expect(wrapper.emitted('heading')?.at(-1)).toEqual([{title:'合成用药单',category:'medication'}]);
 wrapper.getComponent(ReportDetail).vm.$emit('updated');expect(wrapper.emitted('updated')).toHaveLength(1);
});
it('rejects a medication document from another member before mounting report details',async()=>{
 mocks.request.mockResolvedValue({memberId:'second',category:'medication',documents:[{id:'prescription',title:'不应展示'}]});
 const wrapper=render(Content,{kind:'medication_document',recordId:'prescription'});await flushPromises();
 expect(wrapper.findComponent(ReportDetail).exists()).toBe(false);expect(wrapper.text()).not.toContain('不应展示');
 expect(wrapper.get('[role="alert"]').text()).toContain('不属于当前成员');
});

it('desktop medication document keeps the actual title in the page header when the body title is omitted',async()=>{
 route.path='/events/detail/medication_document/prescription';route.params={kind:'medication_document',id:'prescription'};
 mocks.request.mockResolvedValue({memberId:'member',category:'medication',documents:[{id:'prescription',title:'合成用药单'}]});
 const wrapper=render(Page);await flushPromises();
 expect(wrapper.get('h2').text()).toBe('合成用药单');expect(wrapper.getComponent(ReportDetail).props('hideTitle')).toBe(true);
 wrapper.getComponent(ReportDetail).vm.$emit('heading',{title:'校对后的用药单',category:'medication'});await flushPromises();expect(wrapper.get('h2').text()).toBe('校对后的用药单');
});

it('keeps the originating filter when a newly saved vaccination opens its touch detail',async()=>{
 touch.value=true;route.path='/events/detail/vaccination/new';route.params={kind:'vaccination',id:'new'};route.query={returnTo:'/events?category=vaccination&subtype=administered'};render(Page);await flushPromises();
 expect(mocks.replace).toHaveBeenCalledWith({path:'/events',query:{category:'vaccination',subtype:'administered',returnTo:'/events?category=vaccination&subtype=administered',recordKind:'vaccination',recordId:'new'}});
});
it('uses the record overlay after saving from a reminder and retains its return destination',async()=>{
 touch.value=true;route.path='/events/detail/vaccination/new';route.params={kind:'vaccination',id:'new'};route.query={returnTo:'/reminders'};render(Page);await flushPromises();
 expect(mocks.replace).toHaveBeenCalledWith({path:'/events',query:{returnTo:'/reminders',recordKind:'vaccination',recordId:'new'}});
});

it('passes the expanded opening detail once and discards it when switching documents',async()=>{
 const detail={id:'r1',memberId:'member',title:'合成首份资料'};
 mocks.request.mockResolvedValue({memberId:'member',category:'report',documents:[{id:'r1',title:'合成一'},{id:'r2',title:'合成二'}],detail});
 const wrapper=render(Bundle,{recordId:'r1'});await flushPromises();
 expect(mocks.request).toHaveBeenCalledTimes(1);
 expect(mocks.request).toHaveBeenCalledWith('health-records/documents/r1?includeDetail=true');
 expect(wrapper.getComponent(ReportDetail).props('initialDetail')).toEqual(detail);
 await wrapper.findAll('[aria-label="同次资料"] button')[1].trigger('click');
 expect(wrapper.getComponent(ReportDetail).props('initialDetail')).toBeNull();
 await wrapper.findAll('[aria-label="同次资料"] button')[0].trigger('click');
 expect(wrapper.getComponent(ReportDetail).props('initialDetail')).toBeNull();
});

it('rejects a mismatched expanded report before mounting its originals',async()=>{
 mocks.request.mockResolvedValue({memberId:'member',category:'report',documents:[{id:'r1',title:'合成一'}],detail:{id:'r1',memberId:'other'}});
 const wrapper=render(Bundle,{recordId:'r1'});await flushPromises();
 expect(wrapper.findComponent(ReportDetail).exists()).toBe(false);expect(wrapper.get('[role="alert"]').text()).toContain('不属于当前成员');
});
