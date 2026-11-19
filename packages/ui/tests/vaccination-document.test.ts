import { mount,flushPromises } from '@vue/test-utils';
import { beforeEach,afterEach,expect,it,vi } from 'vitest';
import { ref } from 'vue';
import Document from '../src/components/VaccinationDocument.vue';
import Editor from '../src/components/VaccinationEditor.vue';
import Detail from '../src/components/VaccinationDetail.vue';
import ReportDetail from '../src/components/ReportDetail.vue';
const mocks=vi.hoisted(()=>({request:vi.fn()}));
const app={selectedMemberId:ref('member'),selectedMember:ref({permission:'manager'})};
vi.mock('../src/utils/api',()=>({request:mocks.request}));vi.mock('../src/composables/useAppContext',()=>({useAppContext:()=>app}));
vi.mock('../src/components/VaccinationEditor.vue',()=>({default:{name:'VaccinationEditor',props:['source','report'],emits:['saved','cancel'],template:'<form class="synthetic-editor"/>'}}));
vi.mock('../src/components/VaccinationDetail.vue',()=>({default:{name:'VaccinationDetail',props:['recordId','initialEntry','associationSubject'],emits:['heading','updated','changed'],template:'<section class="synthetic-detail"/>'}}));
vi.mock('../src/components/ReportDetail.vue',()=>({default:{name:'ReportDetail',props:{originalsOnly:Boolean,hideTitle:Boolean,hideTrashAction:Boolean,expectedMemberId:String},emits:['loaded'],template:'<div class="synthetic-report"/>'}}));
const report={id:'document',memberId:'member',status:'ready',title:'合成原件',hospitalName:'合成机构',vaccinations:[{id:'fact',vaccineName:'合成疫苗',administeredAt:'2026-01-01',doseNumber:'第 1 剂'}]};
const entry={id:'saved',memberId:'member',sourceReportId:'document',sourceFactId:'fact',vaccineName:'合成疫苗',administeredAt:'2026-01-01'};
let wrapper:ReturnType<typeof mount>;
beforeEach(()=>{app.selectedMemberId.value='member';app.selectedMember.value={permission:'manager'};vi.clearAllMocks();mocks.request.mockImplementation(async(path:string)=>path==='reports/document'?report:[]);});afterEach(()=>wrapper?.unmount());
async function open(){wrapper=mount(Document,{props:{reportId:'document'}});await flushPromises();}
it('shows pending vaccination facts and its original attachment directly, using the shared editor',async()=>{
 await open();expect(wrapper.text()).toContain('待完善');expect(wrapper.text()).toContain('第 1 剂');expect(wrapper.text()).not.toContain('接种凭证');
 expect(wrapper.getComponent(ReportDetail).props()).toMatchObject({originalsOnly:true,hideTitle:true,hideTrashAction:true,expectedMemberId:'member'});
 await wrapper.findAll('button').find(item=>item.text()==='完善接种')!.trigger('click');expect(wrapper.getComponent(Editor).props('source')).toMatchObject({vaccineName:'合成疫苗',organizationName:'合成机构',sourceFactId:'fact'});
 wrapper.getComponent(Editor).vm.$emit('cancel');await flushPromises();expect(wrapper.findComponent(ReportDetail).exists()).toBe(true);
});
it('saves directly into vaccination detail without an intermediate credential screen',async()=>{
 await open();await wrapper.findAll('button').find(item=>item.text()==='完善接种')!.trigger('click');wrapper.getComponent(Editor).vm.$emit('saved',entry);await flushPromises();
 expect(wrapper.getComponent(Detail).props('recordId')).toBe('saved');expect(wrapper.text()).not.toContain('返回');expect(wrapper.findComponent(Editor).exists()).toBe(false);expect(wrapper.emitted('updated')).toHaveLength(1);
});
it('opens existing vaccination detail immediately for viewers as well',async()=>{
 mocks.request.mockImplementation(async(path:string)=>path==='reports/document'?report:[entry]);app.selectedMember.value.permission='viewer';await open();
 expect(wrapper.getComponent(Detail).props('recordId')).toBe('saved');expect(wrapper.getComponent(Detail).props('associationSubject')).toEqual({kind:'report',id:'document'});expect(wrapper.text()).not.toContain('已记录 · 查看');expect(wrapper.findComponent(Editor).exists()).toBe(false);
});
it('switches vaccinations sharing one original without adding a second detail layer',async()=>{
 const second={...report.vaccinations[0],id:'fact2',vaccineName:'合成第二疫苗',doseNumber:'第 2 剂'};
 mocks.request.mockImplementation(async(path:string)=>path==='reports/document'?{...report,vaccinations:[...report.vaccinations,second]}:[entry]);await open();
 const changed={...entry,vaccineName:'合成校对后名称',revision:2};wrapper.getComponent(Detail).vm.$emit('changed',changed);await flushPromises();
 expect(wrapper.get('[aria-pressed="true"]').text()).toContain(changed.vaccineName);
 await wrapper.get('[aria-pressed="false"]').trigger('click');await flushPromises();expect(wrapper.text()).toContain('第 2 剂');expect(wrapper.findComponent(Detail).exists()).toBe(false);
 await wrapper.findAll('button').find(button=>button.text()==='完善接种')!.trigger('click');expect(wrapper.getComponent(Editor).props('source')).toMatchObject({sourceFactId:'fact2',doseNumber:'第 2 剂'});
 wrapper.getComponent(Editor).vm.$emit('cancel');await flushPromises();await wrapper.findAll('[aria-pressed="false"]')[0].trigger('click');await flushPromises();expect(wrapper.getComponent(Detail).props('initialEntry')).toMatchObject(changed);
});
it('rejects another member’s original and vaccination data',async()=>{
 mocks.request.mockImplementation(async(path:string)=>path==='reports/document'?{...report,memberId:'other'}:[entry]);await open();expect(wrapper.text()).toContain('不属于当前成员');expect(wrapper.text()).not.toContain('合成疫苗');expect(wrapper.findComponent(ReportDetail).exists()).toBe(false);
});
it('keeps attachments readable but blocks editing when saved vaccinations cannot be checked',async()=>{
 mocks.request.mockImplementation(async(path:string)=>{if(path==='reports/document')return report;throw Error('unavailable');});await open();expect(wrapper.getComponent(ReportDetail).exists()).toBe(true);expect(wrapper.text()).toContain('请重试后编辑');expect(wrapper.findAll('button').find(button=>button.text()==='完善接种')!.attributes('disabled')).toBeDefined();
});
it('retains processing status and one icon-only deletion action for pending vaccination',async()=>{
 mocks.request.mockImplementation(async(path:string)=>path==='reports/document'?{...report,status:'queued'}:[]);
 await open();expect(wrapper.get('.record-detail-toolbar .preview-heading').text()).toBe('排队中');expect(wrapper.findAll('[aria-label="移入回收站"]')).toHaveLength(1);
 app.selectedMember.value.permission='viewer';await flushPromises();expect(wrapper.find('[aria-label="移入回收站"]').exists()).toBe(false);expect(wrapper.findAll('button').some(button=>button.text()==='完善接种')).toBe(false);
});

it('updates pending facts when the attachment finishes recognition',async()=>{
 mocks.request.mockImplementation(async(path:string)=>path==='reports/document'?{...report,status:'queued',vaccinations:[]}:[]);await open();
 wrapper.getComponent(ReportDetail).vm.$emit('loaded',report);await flushPromises();
 expect(wrapper.text()).toContain('待完善');expect(wrapper.text()).toContain('第 1 剂');
 expect(wrapper.emitted('heading')?.at(-1)?.[0]).toMatchObject({title:'合成疫苗',category:'vaccination'});
});

it('stays on saved vaccination detail when its original attachment changes',async()=>{
 mocks.request.mockImplementation(async(path:string)=>path==='reports/document'?report:[entry]);await open();
 const changed={...entry,sourceReportId:'another-original',sourceFactId:'another-fact',revision:2};
 wrapper.getComponent(Detail).vm.$emit('changed',changed);await flushPromises();
 expect(wrapper.getComponent(Detail).props('initialEntry')).toMatchObject(changed);
 expect(wrapper.getComponent(Detail).props('recordId')).toBe(entry.id);
});
