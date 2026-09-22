import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {flushPromises,mount} from '@vue/test-utils';
import {ref,nextTick,defineComponent,h,KeepAlive} from 'vue';
const mocks=vi.hoisted(()=>({request:vi.fn(),ask:vi.fn(),toast:vi.fn()}));
const app={selectedMemberId:ref('m'),allMembers:ref([{id:'m',permission:'manager'},{id:'n',permission:'manager'}]),session:ref({id:'u',authenticated:true}),accessVersion:ref(0),dataVersion:ref(0)};
vi.mock('../src/composables/useAppContext',()=>({useAppContext:()=>app}));
vi.mock('../src/composables/useConfirm',()=>({useConfirm:()=>({ask:mocks.ask})}));
vi.mock('../src/composables/useToast',()=>({useToast:()=>({show:mocks.toast})}));
vi.mock('../src/utils/api',()=>({request:mocks.request,ApiRequestError:class extends Error {status:number;constructor(status:number){super('fixture');this.status=status;}}}));
vi.mock('vue-router',()=>({useRouter:()=>({back:vi.fn()})}));
import Trash from '../src/pages/settings/TrashSettingsPage.vue';
import {ApiRequestError} from '../src/utils/api';
const empty={items:[],hasMore:false,nextCursor:null};
const pending={memberId:'m',serverTime:'2026-09-21T00:00:00Z',pendingFileCount:2,retryingFileCount:1,status:'retrying',reasonMessage:'等待后台重试',nextCleanupCheckAt:'2026-09-21T06:00:00Z'};
const report={id:'r',memberId:'m',title:'合成测试',deletedAt:'2026-09-01T00:00:00Z',purgeAfter:'2026-09-02T00:00:00Z'};
let wrapper:ReturnType<typeof mount>;
beforeEach(()=>{
 vi.useFakeTimers();vi.clearAllMocks();app.session.value={id:'u',authenticated:true};app.selectedMemberId.value='m';app.allMembers.value=[{id:'m',permission:'manager'},{id:'n',permission:'manager'}];app.accessVersion.value=0;
 Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});
 mocks.request.mockImplementation(async(path:string)=>path.includes('trash-cleanup')?pending:empty);
});
afterEach(()=>{wrapper?.unmount();vi.useRealTimers();});
it('empty recycle bin still shows pending files; completed tasks disappear and stop polling',async()=>{
 wrapper=mount(Trash);await flushPromises();expect(wrapper.text()).toContain('回收站为空');expect(wrapper.text()).toContain('关联文件待清理：2');
 mocks.request.mockImplementation(async(path:string)=>path.includes('trash-cleanup')?{...pending,status:'none',pendingFileCount:0}:empty);
 await vi.advanceTimersByTimeAsync(30000);await flushPromises();expect(wrapper.find('.trash-cleanup-status').exists()).toBe(false);
 const count=mocks.request.mock.calls.length;await vi.advanceTimersByTimeAsync(60000);expect(mocks.request.mock.calls.length).toBe(count);
});
it('query failures stay visible, viewers do not request cleanup, revoked access clears data and stops retries',async()=>{
 mocks.request.mockImplementation(async(path:string)=>{if(path.includes('trash-cleanup'))throw new Error('fixture');return empty;});
 wrapper=mount(Trash);await flushPromises();expect(wrapper.text()).toContain('清理状态暂时无法获取');expect(wrapper.text()).not.toContain('待清理：0');
 app.allMembers.value=[{id:'m',permission:'viewer'}];await nextTick();await flushPromises();const count=mocks.request.mock.calls.filter(([path])=>path.includes('trash-cleanup')).length;
 await vi.advanceTimersByTimeAsync(30000);expect(mocks.request.mock.calls.filter(([path])=>path.includes('trash-cleanup'))).toHaveLength(count);expect(wrapper.text()).not.toContain('清理状态暂时无法获取');
 app.allMembers.value=[{id:'m',permission:'manager'}];mocks.request.mockRejectedValue(Object.assign(new ApiRequestError('fixture', {status:403}),{status:403}));await nextTick();await flushPromises();
 const stopped=mocks.request.mock.calls.length;await vi.advanceTimersByTimeAsync(60000);expect(mocks.request.mock.calls.length).toBe(stopped);expect(wrapper.find('.trash-cleanup-status').exists()).toBe(false);
});
it('successful deletion is not reported as failed when subsequent refresh fails; expired report remains recoverable',async()=>{
 mocks.request.mockImplementation(async(path:string,init?:RequestInit)=>init?.method==='DELETE'?{pendingFileCount:2}:path.includes('trash-cleanup')?pending:{...empty,items:[report]});
 wrapper=mount(Trash);await flushPromises();expect(wrapper.text()).toContain('保留期已到');expect(wrapper.findAll('button').find(button=>button.text()==='恢复')?.attributes('disabled')).toBeUndefined();
 await wrapper.findAll('button').find(button=>button.text()==='永久删除')!.trigger('click');
 mocks.request.mockImplementation(async(_path:string,init?:RequestInit)=>{if(init?.method==='DELETE')return {pendingFileCount:2};throw new Error('refresh failed');});
 await mocks.ask.mock.calls[0][0].run();await flushPromises();expect(mocks.toast).toHaveBeenCalledWith('报告已永久删除，部分文件等待后台清理。');expect(wrapper.text()).toContain('清理状态暂时无法获取');expect(mocks.toast.mock.calls.some(([text])=>text.includes('删除失败'))).toBe(false);
});
it('late old-member requests cannot overwrite new member and hidden/deactivated pages stop polling',async()=>{
 let resolveOld:(value:unknown)=>void=()=>{};
 mocks.request.mockImplementation((path:string)=>path.includes('memberId=m')?new Promise(resolve=>{if(path.includes('trash-cleanup'))resolveOld=resolve;}):Promise.resolve(path.includes('trash-cleanup')?{...pending,memberId:'n',pendingFileCount:7}:empty));
 wrapper=mount(Trash);app.selectedMemberId.value='n';await nextTick();await flushPromises();expect(wrapper.text()).toContain('待清理：7');resolveOld(pending);await flushPromises();expect(wrapper.text()).toContain('待清理：7');
 Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});document.dispatchEvent(new Event('visibilitychange'));const count=mocks.request.mock.calls.length;await vi.advanceTimersByTimeAsync(60000);expect(mocks.request.mock.calls.length).toBe(count);
});
it('KeepAlive deactivation stops polling and reactivation refreshes',async()=>{
 const show=ref(true);const Host=defineComponent(()=>()=>h(KeepAlive,null,{default:()=>show.value?h(Trash):null}));
 wrapper=mount(Host);await flushPromises();show.value=false;await nextTick();const count=mocks.request.mock.calls.length;await vi.advanceTimersByTimeAsync(60000);expect(mocks.request.mock.calls.length).toBe(count);
 show.value=true;await nextTick();await flushPromises();expect(mocks.request.mock.calls.length).toBeGreaterThan(count);
});

it('logout clears previous management data and makes no further requests',async()=>{
 wrapper=mount(Trash);await flushPromises();expect(wrapper.find('.trash-cleanup-status').exists()).toBe(true);
 const count=mocks.request.mock.calls.length;app.session.value={id:'',authenticated:false};await nextTick();await flushPromises();
 expect(wrapper.find('.trash-cleanup-status').exists()).toBe(false);await vi.advanceTimersByTimeAsync(60000);expect(mocks.request.mock.calls.length).toBe(count);
});
