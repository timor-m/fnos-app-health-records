import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { ref } from 'vue';

const memberPermission=vi.hoisted(()=>({value:'manager'}));

vi.mock('../src/composables/useAppContext', () => ({ useAppContext: () => ({
  session: ref({ authenticated: true, id: 'test-user', isAdmin: false }),
  selectedMemberId: ref('m1'),
  allMembers: ref([{ id: 'm1', permission: memberPermission.value }, { id: 'm2', permission: 'manager' }]),
  refreshReminderCount: vi.fn()
}) }));
vi.mock('../src/composables/useConfirm', () => ({ useConfirm: () => ({ ask: vi.fn() }) }));
vi.mock('../src/composables/useToast', () => ({ useToast: () => ({ show: vi.fn() }) }));
vi.mock('../src/composables/useScrollLock', () => ({ useScrollLock: () => {} }));

import ReportDetail from '../src/components/ReportDetail.vue';

const detailPayload = (id = 'r1', memberId = 'm1') => ({
  id, memberId, reportType: 'checkup', status: 'ready', sourceVersion: 1, title: `合成档案 ${id}`,
  observations: [], pages: [], morphologyFindings: [], diagnoses: [], medications: [], procedures: [],
  vaccinations: [], billingItems: [], billingSummary: null, structuredSections: [], duplicateCandidates: []
});
const json = (data: unknown) => new Response(JSON.stringify({ ok: true, data }), { headers: { 'content-type': 'application/json' } });
let fetchMock: ReturnType<typeof vi.fn>;
const wrappers: ReturnType<typeof mount>[] = [];
function render(summary?: any, extraProps: Record<string,unknown> = {}) {
  const wrapper = mount(ReportDetail, {
    props: { reportId: 'r1', expectedMemberId: 'm1', summary, variant: 'panel', ...extraProps },
    global: { stubs: {
      teleport: true, RouterLink: true, ReportNotesPanel: true, ReportEventAssociation: true, ReportProcessAssociation:true, ReportMedicationUseButton: true,
      ReportPageAppend: { name:'ReportPageAppend', props:['label'], emits: ['stateChanged'], template: '<button data-refresh @click="$emit(\'stateChanged\', \'ocr\')">Refresh</button>' }
    } }
  });
  wrappers.push(wrapper);
  return wrapper;
}
async function openEditor(wrapper: ReturnType<typeof render>) {
  await wrapper.findAll('button').find(button => button.text() === '校对字段')!.trigger('click');
  await flushPromises();
}

beforeEach(() => {
  memberPermission.value='manager';
  fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input).replace('?includeDuplicateCandidates=false', '');
    if (url.endsWith('/api/reports/r1')) return json(detailPayload());
    if (url.endsWith('/api/reports/r2')) return json(detailPayload('r2'));
    if (url.includes('/original/status')) return json({ status: 'ready' });
    if (url.includes('jobs')) return json([]);
    return json({});
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { wrappers.splice(0).forEach(wrapper => wrapper.unmount()); vi.unstubAllGlobals(); });

describe('ReportDetail expected member context', () => {
  it('rejects a cross-member detail despite access to both members and clears the preflight summary', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => String(input).replace('?includeDuplicateCandidates=false', '').endsWith('/api/reports/r1')
      ? json({ ...detailPayload('r1', 'm2'), title: '其他成员合成档案', pages: [{ id: 'other-page', mimeType: 'image/png', pageNumber: 1 }] }) : json([]));
    const wrapper = render(detailPayload());
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toContain('不属于当前成员');
    expect(wrapper.text()).not.toContain('其他成员合成档案');
    expect(wrapper.text()).not.toContain('合成档案 r1');
    expect(wrapper.find('.preview-stack').exists()).toBe(false);
    expect(wrapper.find('img').exists()).toBe(false);
    expect(fetchMock.mock.calls.some(([input]) => String(input).replace('?includeDuplicateCandidates=false', '').includes('/original'))).toBe(false);
  });

  it('rechecks ownership on a later refresh and closes an already opened editor', async () => {
    let memberId = 'm1';
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input).replace('?includeDuplicateCandidates=false', '').endsWith('/api/reports/r1')) return json(detailPayload('r1', memberId));
      if (String(input).replace('?includeDuplicateCandidates=false', '').includes('jobs')) return json([]);
      return json({ status: 'ready' });
    });
    const wrapper = render(detailPayload());
    await flushPromises();
    await openEditor(wrapper);
    expect(wrapper.find('.report-edit-form').exists()).toBe(true);
    memberId = 'm2';
    await wrapper.get('[data-refresh]').trigger('click');
    await flushPromises();
    expect(wrapper.find('.report-edit-form').exists()).toBe(false);
    expect(wrapper.find('.preview-stack').exists()).toBe(false);
    expect(wrapper.get('[role="alert"]').text()).toContain('不属于当前成员');
  });

  it('validates full-detail mutation responses before displaying or emitting success', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).replace('?includeDuplicateCandidates=false', '').endsWith('/api/reports/r1')) return json(detailPayload('r1', init?.method === 'PUT' ? 'm2' : 'm1'));
      if (String(input).replace('?includeDuplicateCandidates=false', '').includes('jobs')) return json([]);
      return json({ status: 'ready' });
    });
    const wrapper = render();
    await flushPromises();
    await openEditor(wrapper);
    await wrapper.get('.report-edit-form').trigger('submit');
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toContain('不属于当前成员');
    expect(wrapper.find('.preview-stack').exists()).toBe(false);
    expect(wrapper.emitted('updated')).toBeUndefined();
  });

  it('ignores a late mutation after selecting a different report', async () => {
    let resolveSave!: (value: Response) => void;
    const saveResponse = new Promise<Response>(resolve => { resolveSave = resolve; });
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).replace('?includeDuplicateCandidates=false', '').endsWith('/api/reports/r1') && init?.method === 'PUT') return saveResponse;
      if (String(input).replace('?includeDuplicateCandidates=false', '').endsWith('/api/reports/r1')) return json(detailPayload());
      if (String(input).replace('?includeDuplicateCandidates=false', '').endsWith('/api/reports/r2')) return json(detailPayload('r2'));
      if (String(input).replace('?includeDuplicateCandidates=false', '').includes('jobs')) return json([]);
      return json({ status: 'ready' });
    });
    const wrapper = render();
    await flushPromises();
    await openEditor(wrapper);
    await wrapper.get('.report-edit-form').trigger('submit');
    await wrapper.setProps({ reportId: 'r2' });
    await flushPromises();
    resolveSave(json(detailPayload()));
    await flushPromises();
    expect(wrapper.text()).toContain('合成档案 r2');
    expect(wrapper.text()).not.toContain('合成档案 r1');
    expect(wrapper.emitted('updated')).toBeUndefined();
  });
});

it('omits a duplicate medication document title while retaining document actions and medication confirmation',async()=>{
 fetchMock.mockImplementation(async(input:RequestInfo|URL)=>String(input).replace('?includeDuplicateCandidates=false', '').endsWith('/api/reports/r1') ? json({...detailPayload(),reportType:'prescription',medications:[{id:'medication',medicationName:'合成药品',manualFields:[],evidence:[]}]}) : json([]));
 const wrapper=render();await wrapper.setProps({hideTitle:true});await flushPromises();
 expect(wrapper.find('.report-card-title').exists()).toBe(false);
 expect(wrapper.text()).toContain('合成药品');expect(wrapper.findComponent({name:'ReportMedicationUseButton'}).exists()).toBe(true);
 expect(wrapper.findAll('button').some(button=>button.text()==='校对字段')).toBe(true);
 await wrapper.setProps({hideTitle:false});expect(wrapper.get('.report-card-title').text()).toBe('合成档案 r1');
});

it('omits the inapplicable body part from medication documents and correction forms without clearing stored metadata',async()=>{
 const payload={...detailPayload(),reportType:'prescription',bodyPart:'用药',hospitalName:'合成机构',medications:[{id:'medication',medicationName:'合成药品',manualFields:[],evidence:[]}]};
 fetchMock.mockImplementation(async(input:RequestInfo|URL)=>String(input).replace('?includeDuplicateCandidates=false', '').endsWith('/api/reports/r1')?json(payload):json([]));
 const wrapper=render();await flushPromises();
 expect(wrapper.findAll('.preview-facts dt').map(label=>label.text())).not.toContain('部位');
 expect(wrapper.text()).toContain('合成药品');expect(wrapper.text()).toContain('合成机构');
 await openEditor(wrapper);
 expect(wrapper.findAll('.report-edit-form label').some(label=>label.text().includes('检查部位'))).toBe(false);
 await wrapper.get('.report-edit-form').trigger('submit');await flushPromises();
 const save=fetchMock.mock.calls.find(([,options])=>options?.method==='PUT');
 expect(save).toBeDefined();expect(JSON.parse(String(save![1]!.body))).toMatchObject({bodyPart:'用药',reportType:'prescription',expectedSourceVersion:1});
});

it('retains the body part display and correction field for examination reports',async()=>{
 fetchMock.mockImplementation(async(input:RequestInfo|URL)=>String(input).replace('?includeDuplicateCandidates=false', '').endsWith('/api/reports/r1')?json({...detailPayload(),reportType:'imaging',bodyPart:'合成检查部位'}):json([]));
 const wrapper=render();await flushPromises();
 expect(wrapper.findAll('.preview-facts > div').find(row=>row.find('dt').text()==='部位')?.get('dd').text()).toBe('合成检查部位');
 await openEditor(wrapper);
 const field=wrapper.findAll('.report-edit-form label').find(label=>label.text().includes('检查部位'));
 expect((field?.get('input').element as HTMLInputElement).value).toBe('合成检查部位');
});


it('report details group type, status and deletion into a single toolbar for managers and viewers',async()=>{
 const manager=render();await flushPromises();
 expect(manager.get('.record-detail-toolbar .preview-heading .chip--type').text()).not.toBe('');
 expect(manager.get('.record-detail-toolbar [aria-label="移入回收站"]').exists()).toBe(true);
 expect(manager.findAll('.preview-heading')).toHaveLength(1);
 expect(manager.find('.preview-card > .preview-heading').exists()).toBe(false);
 memberPermission.value='viewer';
 const viewer=render();await flushPromises();
 expect(viewer.get('.record-detail-toolbar .preview-heading').text()).toContain('已归档');
 expect(viewer.find('[aria-label="移入回收站"]').exists()).toBe(false);
});

it.each(['prescription','vaccination','imaging'])('merges the %s document heading into the shared toolbar',async reportType=>{
 fetchMock.mockImplementation(async(input:RequestInfo|URL)=>String(input).replace('?includeDuplicateCandidates=false', '').endsWith('/api/reports/r1')?json({...detailPayload(),reportType}):json([]));
 const wrapper=render();await flushPromises();
 expect(wrapper.get('.record-detail-toolbar .preview-heading').text()).toContain('已归档');
 expect(wrapper.find('.preview-card > .preview-heading').exists()).toBe(false);
 expect(wrapper.findAll('[aria-label="移入回收站"]')).toHaveLength(1);
});

it('nested report originals keep their original heading and suppress a duplicate deletion action',async()=>{
 const wrapper=render();await wrapper.setProps({hideTrashAction:true});await flushPromises();
 expect(wrapper.get('.preview-card > .preview-heading').text()).toContain('已归档');
 expect(wrapper.find('.record-detail-toolbar').exists()).toBe(false);
});

it('attachment-only mode reuses originals without showing another report header or processing controls',async()=>{
 const wrapper=render(undefined,{originalsOnly:true,hideTrashAction:true});await flushPromises();
 expect(wrapper.get('.originals-card h4').text()).toBe('原件附件');
 expect(wrapper.find('.record-detail-toolbar').exists()).toBe(false);
 expect(wrapper.find('.report-card-title').exists()).toBe(false);
 expect(wrapper.find('#report-processing-section').exists()).toBe(false);
 expect(wrapper.findComponent({name:'ReportNotesPanel'}).exists()).toBe(false);

});

it('attachment-only originals expose an upload action while ordinary reports keep their existing append action',async()=>{
 const wrapper=render(undefined,{originalsOnly:true,hideTrashAction:true});await flushPromises();
 expect(wrapper.getComponent({name:'ReportPageAppend'}).props('label')).toBe('上传附件');
 await wrapper.setProps({originalsOnly:false});expect(wrapper.getComponent({name:'ReportPageAppend'}).props('label')).toBeUndefined();
});

it.each([
  ['prescription', false],
  ['prescription', true],
  ['checkup', false]
])('places %s actions below report facts, outside the status/delete toolbar (hidden trash: %s)', async (reportType, hideTrashAction) => {
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => String(input).replace('?includeDuplicateCandidates=false', '').endsWith('/api/reports/r1')
    ? json({ ...detailPayload(), reportType }) : json([]));
  const wrapper = render(undefined, { hideTrashAction });
  await flushPromises();
  expect(wrapper.findAll('.report-action-row')).toHaveLength(1);
  expect(wrapper.find('.record-detail-toolbar .report-action-row').exists()).toBe(false);
  expect(wrapper.get('.report-action-row').element.previousElementSibling?.classList.contains('preview-facts')).toBe(true);
  expect(wrapper.findAll('button').filter(button => button.text() === '校对字段')).toHaveLength(1);
  await openEditor(wrapper);
  expect(wrapper.find('[role="dialog"]').exists()).toBe(true);
});

it.each(['prescription','checkup'])('keeps %s read-only document actions below its facts without manager controls',async reportType=>{
 memberPermission.value='viewer';
 fetchMock.mockImplementation(async(input:RequestInfo|URL)=>String(input).replace('?includeDuplicateCandidates=false', '').endsWith('/api/reports/r1')?json({...detailPayload(),reportType,status:'needs_review',pages:[{id:'pdf',reportId:'r1',mimeType:'application/pdf',pageNumber:1}]}):json([]));
 const wrapper=render();await flushPromises();const actions=wrapper.get('.preview-card > .report-action-row');
 expect(actions.findAll('button').map(button=>button.text())).toEqual(['查看 OCR','查看 PDF']);
 expect(wrapper.get('.record-detail-toolbar').find('button').exists()).toBe(false);
 expect(wrapper.findAll('.report-action-row')).toHaveLength(1);
});

it('renders the expanded opening detail without refetching and refreshes from the server after an update',async()=>{
 const wrapper=render(undefined,{initialDetail:detailPayload()});await flushPromises();
 expect(wrapper.text()).toContain('合成档案 r1');
 expect(fetchMock.mock.calls.filter(([input])=>String(input).replace('?includeDuplicateCandidates=false', '').endsWith('/api/reports/r1'))).toHaveLength(0);
 await wrapper.get('[data-refresh]').trigger('click');await flushPromises();
 expect(fetchMock.mock.calls.filter(([input])=>String(input).replace('?includeDuplicateCandidates=false', '').endsWith('/api/reports/r1'))).toHaveLength(1);
});

it('rejects a cross-member opening detail without rendering or probing originals',async()=>{
 const wrapper=render(undefined,{initialDetail:detailPayload('r1','m2')});await flushPromises();
 expect(wrapper.get('[role="alert"]').text()).toContain('不属于当前成员');
 expect(wrapper.find('.preview-stack').exists()).toBe(false);
 expect(fetchMock.mock.calls.some(([input])=>String(input).replace('?includeDuplicateCandidates=false', '').includes('/original'))).toBe(false);
});

it('does not keep the detail loading indicator waiting for PDF export status',async()=>{
 let finish!:(value:Response)=>void;
 fetchMock.mockImplementation(async(input:RequestInfo|URL)=>{
  if(String(input).replace('?includeDuplicateCandidates=false', '').includes('/original/status'))return new Promise<Response>(resolve=>finish=resolve);
  if(String(input).replace('?includeDuplicateCandidates=false', '').endsWith('/api/reports/r1'))return json(detailPayload());
  if(String(input).replace('?includeDuplicateCandidates=false', '').includes('jobs'))return json([]);
  return json({});
 });
 const wrapper=render();await flushPromises();
 expect(wrapper.text()).toContain('合成档案 r1');expect(wrapper.text()).not.toContain('正在读取档案详情');
 finish(json({status:'ready'}));await flushPromises();
});

const syntheticProcessingJob=(status:string)=>({id:'synthetic-job',reportId:'r1',jobType:'ai_extract',status,createdAt:'2026-01-01',batchId:'synthetic-batch',batchKind:'manual_ai',batchStartedAt:'2026-01-01',batchSequence:1});

it('does not restart a pending first detail read when its completed job history arrives',async()=>{
 let finish!:(value:Response)=>void;
 fetchMock.mockImplementation(async(input:RequestInfo|URL)=>{
  const url=String(input).replace('?includeDuplicateCandidates=false', '');
  if(url.endsWith('/api/reports/r1'))return new Promise<Response>(resolve=>finish=resolve);
  if(url.includes('jobs'))return json([syntheticProcessingJob('completed')]);
  return json({status:'ready'});
 });
 const wrapper=render();await flushPromises();
 expect(fetchMock.mock.calls.filter(([input])=>String(input).replace('?includeDuplicateCandidates=false', '').endsWith('/api/reports/r1'))).toHaveLength(1);
 finish(json(detailPayload()));await flushPromises();
 expect(wrapper.text()).toContain('合成档案 r1');expect(wrapper.find('.mini-loading').exists()).toBe(false);
 expect(wrapper.emitted('updated')).toBeUndefined();
});

it('does not show a second loading phase for a ready report with completed historical jobs',async()=>{
 fetchMock.mockImplementation(async(input:RequestInfo|URL)=>{
  const url=String(input).replace('?includeDuplicateCandidates=false', '');
  if(url.endsWith('/api/reports/r1'))return json(detailPayload());
  if(url.includes('jobs'))return json([syntheticProcessingJob('completed')]);
  return json({status:'ready'});
 });
 const wrapper=render(undefined,{initialDetail:detailPayload()});await flushPromises();
 expect(fetchMock.mock.calls.filter(([input])=>String(input).replace('?includeDuplicateCandidates=false', '').endsWith('/api/reports/r1'))).toHaveLength(0);
 expect(wrapper.find('.mini-loading').exists()).toBe(false);expect(wrapper.emitted('updated')).toBeUndefined();
});

it('refreshes real task completion while keeping the loaded report visible',async()=>{
 let status='processing';let finish!:(value:Response)=>void;
 fetchMock.mockImplementation(async(input:RequestInfo|URL)=>{
  const url=String(input).replace('?includeDuplicateCandidates=false', '');
  if(url.endsWith('/api/reports/r1'))return new Promise<Response>(resolve=>finish=resolve);
  if(url.includes('jobs'))return json([syntheticProcessingJob(status)]);
  return json({status:'ready'});
 });
 const wrapper=render(undefined,{initialDetail:{...detailPayload(),status:'processing'}});await flushPromises();
 expect(fetchMock.mock.calls.filter(([input])=>String(input).replace('?includeDuplicateCandidates=false', '').endsWith('/api/reports/r1'))).toHaveLength(0);
 status='completed';await wrapper.get('button[title="刷新处理进度"]').trigger('click');await flushPromises();
 expect(fetchMock.mock.calls.filter(([input])=>String(input).replace('?includeDuplicateCandidates=false', '').endsWith('/api/reports/r1'))).toHaveLength(1);
 expect(wrapper.text()).toContain('合成档案 r1');expect(wrapper.get('.mini-loading').text()).toBe('正在更新报告内容');
 expect(wrapper.find('.report-detail-loading').exists()).toBe(false);
 finish(json(detailPayload()));await flushPromises();
 expect(wrapper.find('.mini-loading').exists()).toBe(false);expect(wrapper.emitted('updated')).toHaveLength(1);
});

it('refreshes an opening processing report when its first task snapshot has already completed',async()=>{
 fetchMock.mockImplementation(async(input:RequestInfo|URL)=>{
  const url=String(input).replace('?includeDuplicateCandidates=false', '');
  if(url.endsWith('/api/reports/r1'))return json(detailPayload());
  if(url.includes('jobs'))return json([syntheticProcessingJob('completed')]);
  return json({status:'ready'});
 });
 const wrapper=render(undefined,{initialDetail:{...detailPayload(),status:'processing'}});await flushPromises();
 expect(fetchMock.mock.calls.filter(([input])=>String(input).replace('?includeDuplicateCandidates=false', '').endsWith('/api/reports/r1'))).toHaveLength(1);
 expect(wrapper.emitted('updated')).toHaveLength(1);expect(wrapper.find('.mini-loading').exists()).toBe(false);
});

it('resumes synchronization when task history arrives before a still-processing detail',async()=>{
 vi.useFakeTimers();let finish!:(value:Response)=>void;let reads=0;
 fetchMock.mockImplementation(async(input:RequestInfo|URL)=>{
  const url=String(input).replace('?includeDuplicateCandidates=false', '');
  if(url.endsWith('/api/reports/r1')){
   reads++;return reads===1?new Promise<Response>(resolve=>finish=resolve):json(detailPayload());
  }
  if(url.includes('jobs'))return json([syntheticProcessingJob('completed')]);
  return json({status:'ready'});
 });
 const wrapper=render();
 try{
  await flushPromises();expect(reads).toBe(1);
  finish(json({...detailPayload(),status:'processing'}));await flushPromises();
  await vi.advanceTimersByTimeAsync(12500);await flushPromises();
  expect(reads).toBe(2);expect(wrapper.emitted('updated')).toHaveLength(1);
 }finally{wrapper.unmount();vi.useRealTimers();}
});

it('shows report content while duplicate checks run and waits to enable archive confirmation',async()=>{
 let finish!:(value:Response)=>void;
 const initial={...detailPayload(),status:'needs_review',updatedAt:'2026-01-01 00:00:00',duplicateCandidatesPending:true};
 fetchMock.mockImplementation(async(input:RequestInfo|URL)=>{
  if(String(input).endsWith('/duplicate-candidates'))return new Promise<Response>(resolve=>finish=resolve);
  if(String(input).includes('jobs'))return json([]);
  return json({status:'ready'});
 });
 const wrapper=render(undefined,{initialDetail:initial});await flushPromises();
 expect(wrapper.text()).toContain(initial.title);expect(wrapper.find('.report-detail-loading').exists()).toBe(false);
 expect(wrapper.text()).not.toContain('正在读取档案详情');expect(wrapper.get('.duplicate-check-state').text()).toContain('报告内容已可查看');
 const archive=()=>wrapper.findAll('button').find(button=>button.text()==='确认归档')!;
 expect(archive().attributes('disabled')).toBeDefined();
 finish(json({id:'r1',memberId:'m1',sourceVersion:1,updatedAt:initial.updatedAt,duplicateCandidates:[]}));await flushPromises();
 expect(wrapper.find('.duplicate-check-state').exists()).toBe(false);expect(archive().attributes('disabled')).toBeUndefined();
});

it('keeps content readable and retries a failed duplicate check without treating it as no duplicates',async()=>{
 const initial={...detailPayload(),status:'needs_review',updatedAt:'2026-01-01',duplicateCandidatesPending:true};let checks=0;
 fetchMock.mockImplementation(async(input:RequestInfo|URL)=>{
  const url=String(input);
  if(url.endsWith('/duplicate-candidates')){checks++;if(checks===1)throw Error('synthetic unavailable');return json({...initial,duplicateCandidates:[]});}
  if(url.includes('/api/reports/r1?'))return json(initial);
  if(url.includes('jobs'))return json([]);
  return json({status:'ready'});
 });
 const wrapper=render(undefined,{initialDetail:initial});await flushPromises();
 expect(wrapper.text()).toContain(initial.title);expect(wrapper.get('.duplicate-check-state').attributes('role')).toBe('alert');
 expect(wrapper.findAll('button').find(button=>button.text()==='确认归档')!.attributes('disabled')).toBeDefined();
 await wrapper.findAll('button').find(button=>button.text()==='重试核对')!.trigger('click');await flushPromises();
 expect(checks).toBe(2);expect(wrapper.find('.duplicate-check-state').exists()).toBe(false);
});

it('discards a late duplicate result after switching reports',async()=>{
 let finish!:(value:Response)=>void;const initial={...detailPayload(),status:'needs_review',duplicateCandidatesPending:true};
 fetchMock.mockImplementation(async(input:RequestInfo|URL)=>{
  const url=String(input);
  if(url.endsWith('/duplicate-candidates'))return new Promise<Response>(resolve=>finish=resolve);
  if(url.includes('/api/reports/r2?'))return json(detailPayload('r2'));
  if(url.includes('jobs'))return json([]);
  return json({status:'ready'});
 });
 const wrapper=render(undefined,{initialDetail:initial});await flushPromises();await wrapper.setProps({reportId:'r2'});await flushPromises();
 finish(json({...initial,duplicateCandidates:[{id:'old',title:'不应展示的合成候选'}]}));await flushPromises();
 expect(wrapper.text()).toContain('合成档案 r2');expect(wrapper.text()).not.toContain('不应展示的合成候选');expect(wrapper.find('.duplicate-check-state').exists()).toBe(false);
});

it('does not accept duplicate results for a different report revision',async()=>{
 const initial={...detailPayload(),status:'needs_review',updatedAt:'2026-01-01',duplicateCandidatesPending:true};
 fetchMock.mockImplementation(async(input:RequestInfo|URL)=>{
  if(String(input).endsWith('/duplicate-candidates'))return json({...initial,sourceVersion:2,duplicateCandidates:[]});
  if(String(input).includes('jobs'))return json([]);
  return json({status:'ready'});
 });
 const wrapper=render(undefined,{initialDetail:initial});await flushPromises();
 expect(wrapper.get('.duplicate-check-state').text()).toContain('报告内容已更新');
 expect(wrapper.findAll('button').find(button=>button.text()==='确认归档')!.attributes('disabled')).toBeDefined();
});

it('requests the nonblocking content view and skips duplicate comparisons for archived reports',async()=>{
 const wrapper=render();await flushPromises();
 expect(wrapper.text()).toContain('合成档案 r1');
 expect(fetchMock.mock.calls.some(([input])=>String(input).endsWith('/api/reports/r1?includeDuplicateCandidates=false'))).toBe(true);
 expect(fetchMock.mock.calls.some(([input])=>String(input).endsWith('/duplicate-candidates'))).toBe(false);
});
