import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { flushPromises, mount, DOMWrapper } from '@vue/test-utils';
import { ref } from 'vue';
import { createMemoryHistory, createRouter, type RouteLocationRaw, type Router } from 'vue-router';
const mocks = vi.hoisted(() => ({ request: vi.fn(), requestUpload: vi.fn(), toast: vi.fn(), authMode: 'local' }));
const selectedMemberId=ref('synthetic-member');
vi.mock('../src/utils/api', () => ({ request: mocks.request, requestUpload: mocks.requestUpload, apiUrl: (path: string) => `/api/${path}` }));
vi.mock('../src/composables/useToast', () => ({ useToast: () => ({ show: mocks.toast }) }));
vi.mock('../src/composables/useAppContext', () => ({ useAppContext: () => ({
  session: ref({ authMode: mocks.authMode, isAdmin: true }), selectedMemberId,
  selectedMember: ref({ displayName: '合成成员', permission: 'manager' }), notifyDataChanged: vi.fn()
}) }));
import UploadPage from '../src/pages/UploadPage.vue';
import UploadOrganizer from '../src/components/UploadOrganizer.vue';
import UploadArchivePanel from '../src/components/UploadArchivePanel.vue';
let wrapper: ReturnType<typeof mount>;
let router: Router;
const file = (name: string, size = 1024) => ({ name, path: name, type: 'file', size, modifiedAt: '' });
type Entry = ReturnType<typeof file>;
let entries = [file('synthetic-1.jpg'), file('synthetic-2.jpg')];
let directories: Record<string, Entry[]> = {};
const folder = (name: string) => ({ ...file(name), type: 'directory' });
const stubs = { UploadArchivePanel: true, ImageViewer: true, IndicatorHint: true, FormSelect: true };
beforeEach(() => {
  selectedMemberId.value='synthetic-member';
  vi.clearAllMocks(); mocks.requestUpload.mockResolvedValue({reportId:'direct-report',memberId:'synthetic-member',pageCount:1,jobCount:2,status:'queued'}); directories = {}; mocks.authMode = 'local'; entries = [file('synthetic-1.jpg'), file('synthetic-2.jpg')];
  mocks.request.mockImplementation(async (path: string) => {
    if(path.startsWith('jobs?')) return [];
    if(path==='ocr/status') return {available:true};
    if (path === 'local-files/import') return { reportId: 'synthetic-report', status: 'queued' };
    const params = new URLSearchParams(path.split('?')[1]);
    return { roots: [{ id: 'root', label: '合成目录', path: '/reports' }], current: params.has('rootId') ? { rootId: 'root', path: params.get('path') || '' } : null,
      entries: directories[params.get('path') || ''] || entries, truncated: false, personalAuthorization: false, availability: { state: 'ready', configuredCount: 1, unavailableCount: 0, message: null } };
  });
});
afterEach(() => { wrapper?.unmount(); document.body.innerHTML = ''; });
const view = () => new DOMWrapper(document.body);
async function open(location: RouteLocationRaw = '/upload') {
  router = createRouter({
    history: createMemoryHistory(),
    routes: ['/upload', '/events', '/health-processes/:id', '/records', '/me/runtime'].map(path => ({ path, component: { template: '<div />' } }))
  });
  await router.push(location);
  await router.isReady();
  wrapper = mount(UploadPage, { attachTo: document.body, global: { plugins: [router], stubs } });
  await view().get('.nas-import-button').trigger('click'); await flushPromises();
}
const boxes = () => view().findAll('.local-entry input[type="checkbox"]');
const organizer = () => view().get('.local-file-modal .upload-organizer');

it('selects two JPGs, settles rendering and submits both in one merged report', async () => {
  await open();
  expect(wrapper.find('.upload-event-return').exists()).toBe(false);
  await boxes()[0].setValue(true);
  await boxes()[1].setValue(true); await flushPromises();
  expect(view().get('.local-file-footer').text()).toContain('已选 2 个文件');
  await organizer().findAll('.organizer-modes button')[1].trigger('click'); await flushPromises();
  expect(view().get('.local-file-footer .primary-button').attributes('disabled')).toBeUndefined();
  await view().get('.local-file-footer .primary-button').trigger('click'); await flushPromises();
  const imports = mocks.request.mock.calls.filter(([path]) => path === 'local-files/import');
  expect(imports).toHaveLength(1);
  expect(JSON.parse(imports[0][1].body).files).toEqual(entries.map(e => ({ rootId: 'root', path: e.path })));
});

it('does not expose the retired event return panel or pass event workflow context to uploads', async () => {
  await open({path:'/upload',query:{memberId:'synthetic-member',returnEventId:'retired',eventId:'retired',episodeId:'retired',followupEventId:'retired'}});
  expect(wrapper.find('.upload-event-return').exists()).toBe(false);
  await boxes()[0].setValue(true);await flushPromises();
  await view().get('.local-file-footer .primary-button').trigger('click');await flushPromises();
  const call=mocks.request.mock.calls.find(([path])=>path==='local-files/import')!;
  expect(JSON.parse(call[1].body).context).toEqual({});
});

async function selectAll() {
  await view().get('.local-file-selection-actions button').trigger('click'); await flushPromises();
}
async function openFolder(name: string) {
  await view().findAll('.is-directory').find(row => row.text().includes(name))!.trigger('click'); await flushPromises();
}
async function root() {
  await view().get('.local-file-toolbar nav button').trigger('click'); await flushPromises();
}

it.each(['local', 'fnos'])('supports current-directory selection and preserves other directories in %s mode', async (authMode) => {
  mocks.authMode = authMode;
  entries = [folder('child'), file('root-a.jpg'), file('root-b.pdf')];
  directories.child = [file('child/child-a.jpg'), file('child/child-b.jpg')];
  await open(); await boxes()[0].setValue(true); await selectAll();
  expect(view().get('.local-file-footer').text()).toContain('已选 2 个文件');
  await openFolder('child'); await selectAll();
  expect(view().get('.local-file-footer').text()).toContain('已选 4 个文件');
  await selectAll();
  expect(view().get('.local-file-footer').text()).toContain('已选 2 个文件');
  await root(); expect(boxes().every(box => (box.element as HTMLInputElement).checked)).toBe(true);
  await selectAll(); expect(view().get('.local-file-footer').text()).toContain('已选 0 个文件');
});

it('skips oversized files and rejects total-size overflow without partially changing the selection', async () => {
  entries = [file('valid.jpg'), file('oversized.jpg', 41 * 1024 * 1024), folder('large')];
  directories.large = Array.from({ length: 52 }, (_, n) => file(`large/${n}.jpg`, 40 * 1024 * 1024));
  await open(); await selectAll();
  expect(view().get('.local-file-footer').text()).toContain('已选 1 个文件');
  expect(view().get('.local-file-error').text()).toContain('已跳过 1 个');
  await openFolder('large'); await selectAll();
  expect(view().get('.local-file-error').text()).toContain('2 GB');
  expect(view().get('.local-file-footer').text()).toContain('已选 1 个文件');
  expect(boxes().some(box => (box.element as HTMLInputElement).checked)).toBe(false);
});

it('enforces the cumulative 1000-file limit across directories', async () => {
  entries = [folder('first'), folder('second'), folder('third')];
  for (const [name, count] of [['first', 500], ['second', 500], ['third', 1]] as const) {
    directories[name] = Array.from({ length: count }, (_, n) => file(`${name}/${n}.jpg`));
  }
  await open(); await openFolder('first'); await selectAll();
  await root(); await openFolder('second'); await selectAll();
  expect(view().get('.local-file-footer').text()).toContain('已选 1000 个文件');
  await root(); await openFolder('third'); await selectAll();
  expect(view().get('.local-file-error').text()).toContain('1000 个文件');
  expect(view().get('.local-file-footer').text()).toContain('已选 1000 个文件');
});

it('does not emit duplicate plans for equivalent file arrays, but updates order and removals', async () => {
  wrapper = mount(UploadOrganizer, { attachTo: document.body, props: { files: [{ id: 'a', name: 'a.jpg' }, { id: 'b', name: 'b.jpg' }] }, global: { stubs } });
  await view().findAll('.organizer-modes button')[1].trigger('click');
  const count = wrapper.emitted('plan')!.length;
  await wrapper.setProps({ files: [{ id: 'a', name: 'renamed.jpg' }, { id: 'b', name: 'b.jpg' }] });
  expect(wrapper.emitted('plan')).toHaveLength(count);
  await wrapper.setProps({ files: [{ id: 'b', name: 'b.jpg' }, { id: 'a', name: 'a.jpg' }] });
  expect(wrapper.emitted('plan')!.at(-1)).toEqual([[['b', 'a']]]);
  await wrapper.setProps({ files: [{ id: 'a', name: 'a.jpg' }] });
  expect(wrapper.emitted('plan')!.at(-1)).toEqual([[['a']]]);
});

it('preserves current process, source record and reminder context in each NAS batch task',async()=>{
  const query={memberId:'synthetic-member',processId:'process',relatedKind:'report',relatedId:'source',reminderId:'reminder'};
  await open({path:'/upload',query});await boxes()[0].setValue(true);await boxes()[1].setValue(true);await flushPromises();
  await organizer().findAll('.organizer-modes button')[0].trigger('click');await flushPromises();
  await view().get('.local-file-footer .primary-button').trigger('click');await flushPromises();
  const calls=mocks.request.mock.calls.filter(([path])=>path==='local-files/import');expect(calls).toHaveLength(2);
  for(const [,options] of calls)expect(JSON.parse(options.body).context).toEqual({processId:'process',relatedRecord:{kind:'report',id:'source'},reminderId:'reminder'});
  expect(new Set(calls.map(([,options])=>JSON.parse(options.body).requestKey)).size).toBe(2);
});
it('single browser upload includes context and retains the request key after an uncertain response',async()=>{
  await open({path:'/upload',query:{memberId:'synthetic-member',processId:'process'}});
  const picker=wrapper.get('input[aria-label="选择报告文件"]');
  const file=new File([new Uint8Array([1,2])],'synthetic.pdf',{type:'application/pdf'});
  Object.defineProperty(picker.element,'files',{value:[file],configurable:true});await picker.trigger('change');
  mocks.requestUpload.mockRejectedValueOnce(new Error('合成网络错误'));
  await wrapper.get('.upload-submit button').trigger('click');await flushPromises();
  await wrapper.get('.upload-submit button').trigger('click');await flushPromises();
  const bodies=mocks.requestUpload.mock.calls.map(([,body])=>body as FormData);expect(bodies).toHaveLength(2);
  expect(bodies[0].get('requestKey')).toBe(bodies[1].get('requestKey'));
  expect(JSON.parse(String(bodies[1].get('context')))).toEqual({processId:'process'});
  expect(JSON.parse(String(bodies[1].get('manifest'))).pages[0].size).toBe(2);
});

it('blocks uploads when the source member no longer matches until the source context is explicitly cleared',async()=>{
  await open({path:'/upload',query:{memberId:'another-member',relatedKind:'report',relatedId:'source',reminderId:'reminder'}});
  expect(wrapper.get('.upload-context-error').text()).toContain('来源成员不一致');
  await boxes()[0].setValue(true);await flushPromises();expect(view().get('.local-file-footer .primary-button').attributes('disabled')).toBeDefined();
  await wrapper.get('.upload-context-error button').trigger('click');await flushPromises();
  expect(wrapper.find('.upload-context-error').exists()).toBe(false);
  await view().get('.local-file-footer .primary-button').trigger('click');await flushPromises();
  const calls=mocks.request.mock.calls.filter(([path])=>path==='local-files/import');expect(calls).toHaveLength(1);expect(JSON.parse(calls[0][1].body).context).toEqual({});
});

it('separates imaging as a disabled upload entry while keeping report file inputs available', async()=>{
 await open();const types=wrapper.get('[aria-label="上传内容"]');expect(types.findAll('button').map(button=>button.text())).toEqual(['报告资料','影像 暂未开放']);
 expect(types.findAll('button')[1].attributes('disabled')).toBeDefined();expect(wrapper.get('input[aria-label="选择报告文件"]').attributes('disabled')).toBeUndefined();
 const count=mocks.requestUpload.mock.calls.length;await types.findAll('button')[1].trigger('click');await flushPromises();expect(mocks.requestUpload).toHaveBeenCalledTimes(count);
});

async function saveBrowserFile(name='synthetic.pdf') {
  const picker=wrapper.get('input[aria-label="选择报告文件"]');
  Object.defineProperty(picker.element,'files',{value:[new File([new Uint8Array([1,2])],name,{type:'application/pdf'})],configurable:true});
  await picker.trigger('change');await wrapper.get('.upload-submit button').trigger('click');await flushPromises();
}
it('keeps a fresh upload page free of historical archive panels, including old review links',async()=>{
 await open();expect(wrapper.findComponent(UploadArchivePanel).exists()).toBe(false);
 await router.replace('/upload?review=1');await flushPromises();expect(wrapper.findComponent(UploadArchivePanel).exists()).toBe(false);expect(mocks.request.mock.calls.some(([path])=>String(path).startsWith('uploads/workflow'))).toBe(false);
});
it('shows only the latest upload receipts after progress and keeps the records link available',async()=>{
 await open();await view().get('.local-file-modal header button').trigger('click');await saveBrowserFile();
 expect(wrapper.getComponent(UploadArchivePanel).props()).toMatchObject({reportIds:['direct-report'],memberId:'synthetic-member',currentBatch:true});expect(wrapper.get('.upload-success a').attributes('href')).toBe('/events');expect(wrapper.get('.upload-success a').text()).toBe('查看记录');
 expect(wrapper.get('.job-progress').element.compareDocumentPosition(wrapper.getComponent(UploadArchivePanel).element)&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
 mocks.requestUpload.mockResolvedValueOnce({reportId:'second-report',memberId:'synthetic-member',pageCount:1,jobCount:2,status:'queued'});await saveBrowserFile('second.pdf');expect(wrapper.getComponent(UploadArchivePanel).props('reportIds')).toEqual(['second-report']);
 selectedMemberId.value='another-member';await flushPromises();expect(wrapper.findComponent(UploadArchivePanel).exists()).toBe(false);expect(wrapper.find('.upload-success').exists()).toBe(false);expect(wrapper.find('.job-progress').exists()).toBe(false);
});
it('returns uploads created from a process to that process while retaining the record anchor',async()=>{
 await open({path:'/upload',query:{memberId:'synthetic-member',relatedKind:'report',relatedId:'source-report',returnTo:'/health-processes/source'}});
 await view().get('.local-file-modal header button').trigger('click');await saveBrowserFile();
 expect(wrapper.get('.upload-success a').attributes('href')).toBe('/health-processes/source');expect(wrapper.get('.upload-success a').text()).toBe('返回健康历程');
 expect(JSON.parse(mocks.requestUpload.mock.calls[0][1].get('context'))).toMatchObject({relatedRecord:{kind:'report',id:'source-report'}});
});
it('keeps successful batch receipts across a failed-task retry and clears them on continue',async()=>{
 const fallback=mocks.request.getMockImplementation()!;let imports=0;
 mocks.request.mockImplementation(async(path:string,...args:any[])=>{
  if(path!=='local-files/import')return fallback(path,...args);
  imports++;if(imports===2)throw Error('合成导入失败');return {reportId:imports===1?'first-report':'retried-report',memberId:'synthetic-member',status:'queued'};
 });
 await open();await boxes()[0].setValue(true);await boxes()[1].setValue(true);await flushPromises();await organizer().findAll('.organizer-modes button')[0].trigger('click');await flushPromises();await view().get('.local-file-footer .primary-button').trigger('click');await flushPromises();
 expect(wrapper.get('.upload-batch-results').text()).toContain('合成导入失败');expect(wrapper.findComponent(UploadArchivePanel).exists()).toBe(false);
 await wrapper.findAll('button').find(item=>item.text()==='重试失败报告')!.trigger('click');await flushPromises();expect(wrapper.getComponent(UploadArchivePanel).props('reportIds')).toEqual(['first-report','retried-report']);expect(wrapper.findAll('.upload-batch-results > article')).toHaveLength(0);expect(wrapper.get('.upload-batch-results a').attributes('href')).toBe('/events');
 await wrapper.findAll('button').find(item=>item.text()==='继续上传')!.trigger('click');await flushPromises();expect(wrapper.findComponent(UploadArchivePanel).exists()).toBe(false);expect(wrapper.find('.upload-batch-results').exists()).toBe(false);expect(wrapper.find('.drop-zone').exists()).toBe(true);
});

it('limits a staged browser batch to its own saved reports and resets the result for the next batch',async()=>{
 const fallback=mocks.request.getMockImplementation()!;let completed=0;
 mocks.request.mockImplementation(async(path:string,options?:RequestInit)=>{
  if(path==='uploads/staged')return {received:[]};
  if(path.startsWith('uploads/staged/')&&path.endsWith('/complete'))return {reportId:`staged-report-${++completed}`,memberId:'synthetic-member',status:'queued'};
  if(path.startsWith('uploads/staged/')&&options?.method==='DELETE')return {};
  return fallback(path,options);
 });
 await open();await view().get('.local-file-modal header button').trigger('click');const picker=wrapper.get('input[aria-label="选择报告文件"]');Object.defineProperty(picker.element,'files',{value:['one.pdf','two.pdf'].map(name=>new File([new Uint8Array([1,2])],name,{type:'application/pdf'})),configurable:true});await picker.trigger('change');await wrapper.findAll('.organizer-modes button')[0].trigger('click');await flushPromises();await wrapper.get('.upload-submit button').trigger('click');await flushPromises();
 expect(wrapper.getComponent(UploadArchivePanel).props('reportIds')).toEqual(['staged-report-1','staged-report-2']);expect(mocks.requestUpload.mock.calls.every(([path])=>String(path).startsWith('uploads/staged/'))).toBe(true);
 await wrapper.findAll('button').find(item=>item.text()==='继续上传')!.trigger('click');await flushPromises();expect(wrapper.findComponent(UploadArchivePanel).exists()).toBe(false);expect(wrapper.find('.upload-batch-results').exists()).toBe(false);expect(wrapper.find('.upload-pages').exists()).toBe(false);
});
