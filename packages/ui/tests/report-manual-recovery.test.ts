import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {flushPromises, mount} from '@vue/test-utils';
import {ref} from 'vue';
const state = vi.hoisted(()=>({permission:'manager',ask:vi.fn(),toast:vi.fn()}));
vi.mock('../src/composables/useAppContext',()=>({useAppContext:()=>({
  session:ref({authenticated:true,id:'synthetic-manager'}),allMembers:ref([{id:'m1',permission:state.permission}]),
  selectedMemberId:ref('m1'),selectedMember:ref({id:'m1',permission:state.permission}),refreshReminderCount:vi.fn()
})}));
vi.mock('../src/composables/useConfirm',()=>({useConfirm:()=>({ask:state.ask,state:ref(null),cancel:vi.fn()})}));
vi.mock('../src/composables/useToast',()=>({useToast:()=>({show:state.toast})}));
vi.mock('../src/composables/useScrollLock',()=>({useScrollLock:()=>{}}));
import ReportCombineDialog from '../src/components/ReportCombineDialog.vue';
import ReportDetail from '../src/components/ReportDetail.vue';
const base=()=>({id:'r1',memberId:'m1',title:'合成待核对报告',reportType:'laboratory',status:'failed',sourceVersion:1,
  pages:[],observations:[] as any[],morphologyFindings:[],diagnoses:[],medications:[],procedures:[],vaccinations:[],billingItems:[],structuredSections:[],duplicateCandidates:[]});
const json=(data:unknown)=>new Response(JSON.stringify({ok:true,data}),{headers:{'content-type':'application/json'}});
let detail:ReturnType<typeof base>,jobs:any[],fetchMock:ReturnType<typeof vi.fn>,wrapper:ReturnType<typeof mount>;
beforeEach(()=>{
  state.permission='manager';state.ask.mockReset();state.toast.mockReset();detail=base();jobs=[];
  fetchMock=vi.fn(async(input:unknown,init?:RequestInit)=>{
    const url=String(input).replace('?includeDuplicateCandidates=false','');
    if(url.endsWith('/confirm')) {detail.status='ready';return json({id:'r1',status:'ready'});}
    if(url.endsWith('/observations')&&init?.method==='POST') {
      detail.observations=[{id:'obs1',...JSON.parse(String(init.body)),displayTier:'secondary',evidence:null}];return json(detail);
    }
    if(url.endsWith('/reports/r1'))return json(detail);
    if(url.includes('/original/status'))return json({status:'ready'});
    if(url.includes('jobs'))return json(jobs);
    return json([]);
  });vi.stubGlobal('fetch',fetchMock);
});
afterEach(()=>{wrapper?.unmount();vi.unstubAllGlobals();document.body.innerHTML='';});
async function open(){wrapper=mount(ReportDetail,{attachTo:document.body,props:{reportId:'r1',variant:'panel'},
  global:{stubs:{teleport:true,RouterLink:true,ReportNotesPanel:true,ReportPageAppend:true}}});await flushPromises();await flushPromises();return wrapper;}
const button=(text:string)=>wrapper.findAll('button').find(b=>b.text()===text)!;
describe('识别失败后的手工处理',()=>{
  it('opens and saves the first manual indicator when AI produced no content',async()=>{
    await open();expect(wrapper.text()).toContain('AI 尚未整理出结构化内容');
    await button('补充指标').trigger('click');await flushPromises();
    const form=wrapper.get('.observation-add-modal form');
    const inputs=form.findAll('input');await inputs.find(x=>x.attributes('required')!==undefined)!.setValue('合成补录项目');
    await form.trigger('submit');await flushPromises();
    const call=fetchMock.mock.calls.find(([url,init])=>String(url).endsWith('/observations')&&init?.method==='POST')!;
    expect(JSON.parse(call[1].body)).toMatchObject({itemName:'合成补录项目',expectedSourceVersion:1});
    expect(wrapper.find('.observation-add-modal').exists()).toBe(false);expect(wrapper.text()).toContain('合成补录项目');
  });
  it('keeps the first-indicator entry when other structured content already exists',async()=>{
    Object.assign(detail,{summary:'合成摘要'});await open();expect(button('补充指标').exists()).toBe(true);
  });
  it('requires an explicit confirmation before manually archiving a failed report',async()=>{
    await open();await button('手动归档').trigger('click');
    expect(fetchMock.mock.calls.some(([url])=>String(url).endsWith('/confirm'))).toBe(false);
    expect(state.ask).toHaveBeenCalledWith(expect.objectContaining({title:'手动确认归档',confirmText:'确认归档'}));
    await state.ask.mock.calls[0][0].run();await flushPromises();
    expect(detail.status).toBe('ready');expect(wrapper.text()).not.toContain('手动归档');
  });
  it('opens the combine dialog from the retained report and refreshes after saving',async()=>{
    await open();await button('合并报告').trigger('click');await flushPromises();
    const dialog=wrapper.findComponent(ReportCombineDialog);expect(dialog.exists()).toBe(true);
    expect(dialog.props('report').id).toBe('r1');
    fetchMock.mockClear();dialog.vm.$emit('combined',{reportId:'r1',sourceReportId:'other',status:'needs_review',movedPages:1,movedObservations:1,movedOtherRecords:0});await flushPromises();
    expect(wrapper.findComponent(ReportCombineDialog).exists()).toBe(false);expect(wrapper.emitted('updated')).toHaveLength(1);
    expect(fetchMock.mock.calls.some(([url])=>String(url).includes('/reports/r1?'))).toBe(true);
    expect(fetchMock.mock.calls.some(([url])=>String(url).includes('jobs'))).toBe(true);
  });
  it('previews undo and sends it only after the user confirms',async()=>{
    Object.assign(detail,{combinationUndo:{id:'combination-1',sourceTitle:'合成来源报告',createdAt:'2026-01-01'}});
    const original=fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async(input,init)=>String(input).includes('/undo-combine-preview')?json({combinationId:'combination-1',fingerprint:'a'.repeat(64),source:{id:'other',title:'合成来源报告',pages:1,observations:1},target:{id:'r1',title:detail.title,pages:1,observations:0}}):String(input).endsWith('/undo-combine')?json({reportId:'r1',restoredReportId:'other',undone:true}):original(input,init));
    await open();
    const information=wrapper.get('[aria-label="合并信息"]');
    expect(information.text()).toContain('最近合并：合成来源报告');
    expect(information.text()).toContain('2026-01-01');
    expect(information.element.previousElementSibling?.tagName.toLowerCase()).toBe('report-notes-panel-stub');
    expect(wrapper.get('.report-action-row').text()).not.toContain('撤销合并');
    await information.get('button').trigger('click');await flushPromises();
    expect(state.ask).toHaveBeenCalledWith(expect.objectContaining({title:'撤销这次合并？',confirmText:'撤销合并',message:expect.stringContaining('合成来源报告')}));
    expect(fetchMock.mock.calls.some(([url,init])=>String(url).endsWith('/undo-combine')&&init?.method==='POST')).toBe(false);
    await state.ask.mock.calls[0][0].run();await flushPromises();
    const call=fetchMock.mock.calls.find(([url,init])=>String(url).endsWith('/undo-combine')&&init?.method==='POST')!;
    expect(JSON.parse(call[1].body)).toEqual({combinationId:'combination-1',fingerprint:'a'.repeat(64)});
    expect(wrapper.emitted('updated')).toHaveLength(1);expect(state.toast).toHaveBeenCalledWith('已撤销合并，两份报告已恢复');
  });
  it('pauses undo with a readable explanation after subsequent content changes',async()=>{
    Object.assign(detail,{combinationUndo:{id:'combination-1',sourceTitle:'合成来源报告',createdAt:'2026-01-01'}});
    const original=fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async(input,init)=>String(input).includes('/undo-combine-preview')?new Response(JSON.stringify({ok:false,error:{message:'合并后内容已有修改，暂不能撤销'}}),{status:409,headers:{'content-type':'application/json'}}):original(input,init));
    await open();await button('撤销合并').trigger('click');await flushPromises();
    expect(state.ask).not.toHaveBeenCalled();expect(state.toast).toHaveBeenCalledWith('合并后内容已有修改，暂不能撤销',6000);
    expect(fetchMock.mock.calls.some(([url])=>String(url).endsWith('/undo-combine'))).toBe(false);
  });
  it('hides write actions from a read-only member',async()=>{
    state.permission='viewer';Object.assign(detail,{combinationUndo:{id:'combination-1',sourceTitle:'合成来源',createdAt:'2026-01-01'}});await open();expect(button('补充指标')).toBeUndefined();expect(button('手动归档')).toBeUndefined();expect(button('合并报告')).toBeUndefined();expect(button('撤销合并')).toBeUndefined();
  });
  it('blocks manual archive and supplement while extraction is still active',async()=>{
    jobs=[{id:'j1',reportId:'r1',jobType:'ai_extract',status:'processing',createdAt:'2026-01-01',batchId:'batch',batchKind:'manual_ai',batchStartedAt:'2026-01-01',batchSequence:1}];await open();
    expect(button('手动归档').attributes('disabled')).toBeDefined();expect(button('补充指标').attributes('disabled')).toBeDefined();expect(button('合并报告').attributes('disabled')).toBeDefined();
  });
  it('keeps save corrections available on a failed report without automatically archiving it',async()=>{
    await open();await button('校对字段').trigger('click');await flushPromises();
    const form=wrapper.get('.report-edit-form');expect(form.find('button[type="submit"]').text()).toBe('保存校对');
    await form.get('input').setValue('合成人工标题');await form.trigger('submit');await flushPromises();
    expect(fetchMock.mock.calls.some(([url,init])=>String(url).endsWith('/reports/r1')&&init?.method==='PUT')).toBe(true);
    expect(detail.status).toBe('failed');
  });
});
