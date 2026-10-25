import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {flushPromises,mount} from '@vue/test-utils';
import {ref,nextTick,defineComponent,h,KeepAlive} from 'vue';
const mocks=vi.hoisted(()=>({request:vi.fn(),ask:vi.fn(),toast:vi.fn()}));
const app={selectedMemberId:ref('m'),allMembers:ref([{id:'m',permission:'manager'},{id:'n',permission:'manager'}]),session:ref({id:'u',authenticated:true}),accessVersion:ref(0),dataVersion:ref(0),notifyDataChanged:vi.fn(),refreshReminderCount:vi.fn()};
vi.mock('../src/composables/useAppContext',()=>({useAppContext:()=>app}));
vi.mock('../src/composables/useConfirm',()=>({useConfirm:()=>({ask:mocks.ask})}));
vi.mock('../src/composables/useToast',()=>({useToast:()=>({show:mocks.toast})}));
vi.mock('../src/utils/api',()=>({request:mocks.request,ApiRequestError:class extends Error {status:number;constructor(status:number){super('fixture');this.status=status;}}}));
vi.mock('vue-router',()=>({useRouter:()=>({back:vi.fn()})}));
import Trash from '../src/pages/settings/TrashSettingsPage.vue';
import {ApiRequestError} from '../src/utils/api';
const empty={items:[],hasMore:false,nextCursor:null};
const pending={memberId:'m',serverTime:'2026-09-21T00:00:00Z',pendingFileCount:2,retryingFileCount:1,status:'retrying',reasonMessage:'等待后台重试',nextCleanupCheckAt:'2026-09-21T06:00:00Z'};
const report={kind:'report',date:null,institution:null,revision:null,id:'r',memberId:'m',title:'合成测试',deletedAt:'2026-09-01T00:00:00Z',purgeAfter:'2026-09-02T00:00:00Z'};
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

const dose={...report,kind:'vaccination',id:'dose',title:'合成接种',doseNumber:'2',revision:4,purgeAfter:null};
it('restores a vaccination without a recorded retention deadline using its revision and refreshes record counts',async()=>{
 let removed=false;mocks.request.mockImplementation(async(path:string,init?:RequestInit)=>{
  if(init?.method==='POST'){removed=true;return {id:'dose',reminderNeedsReview:true};}
  return path.includes('trash-cleanup')?{...pending,status:'none',pendingFileCount:0}:{...empty,items:removed?[]:[dose]};
 });
 wrapper=mount(Trash);await flushPromises();expect(wrapper.text()).toContain('保留期限未记录，可恢复或手动删除');expect(wrapper.text()).toContain('第 2 剂');
 expect(mocks.request.mock.calls.some(([path])=>path.startsWith('health-records/trash?'))).toBe(true);
 await wrapper.findAll('button').find(button=>button.text()==='恢复')!.trigger('click');await flushPromises();
 expect(mocks.request).toHaveBeenCalledWith('vaccinations/dose/restore',{method:'POST',body:JSON.stringify({revision:4})});expect(mocks.toast).toHaveBeenCalledWith('接种记录已恢复，请在详情核对下一剂提醒');expect(app.notifyDataChanged).toHaveBeenCalledOnce();expect(wrapper.text()).toContain('回收站为空');
});
it('mixed trash uses distinct restore and permanent-delete endpoints, and viewers cannot mutate either kind',async()=>{
 mocks.request.mockImplementation(async(path:string)=>path.includes('trash-cleanup')?pending:{...empty,items:[report,dose]});
 wrapper=mount(Trash);await flushPromises();expect(wrapper.findAll('article')).toHaveLength(2);
 await wrapper.findAll('article')[1].findAll('button').find(button=>button.text()==='永久删除')!.trigger('click');
 expect(mocks.ask.mock.calls[0][0].title).toBe('永久删除接种记录');expect(mocks.ask.mock.calls[0][0].message).toContain('原件和其他记录会保留');expect(mocks.request.mock.calls.some(([,init])=>init?.method==='DELETE')).toBe(false);
 mocks.request.mockImplementation(async(path:string,init?:RequestInit)=>init?.method==='DELETE'?{deleted:true,pendingFileCount:0}:path.includes('trash-cleanup')?pending:empty);
 await mocks.ask.mock.calls[0][0].run();await flushPromises();expect(mocks.request).toHaveBeenCalledWith('vaccinations/dose?permanent=1',{method:'DELETE',body:JSON.stringify({revision:4})});expect(mocks.toast).toHaveBeenCalledWith('接种记录已永久删除。');
 app.allMembers.value=[{id:'m',permission:'viewer'}];mocks.request.mockResolvedValue({...empty,items:[report,dose]});await nextTick();await flushPromises();expect(wrapper.findAll('.trash-report-actions button')).toHaveLength(0);
});
it('a conflicting vaccination restore keeps the recoverable entry visible and reports the conflict',async()=>{
 mocks.request.mockImplementation(async(path:string,init?:RequestInit)=>{if(init?.method==='POST')throw new Error('合成重复接种，请核对已有记录');return path.includes('trash-cleanup')?pending:{...empty,items:[dose]};});
 wrapper=mount(Trash);await flushPromises();await wrapper.findAll('button').find(button=>button.text()==='恢复')!.trigger('click');await flushPromises();expect(wrapper.text()).toContain('合成接种');expect(mocks.toast).toHaveBeenCalledWith('合成重复接种，请核对已有记录');expect(app.notifyDataChanged).not.toHaveBeenCalled();
});
it('a late vaccination restore cannot clear another member or notify its counts',async()=>{
 let finish!:(value:unknown)=>void;mocks.request.mockImplementation(async(path:string,init?:RequestInit)=>init?.method==='POST'?new Promise(resolve=>finish=resolve):path.includes('trash-cleanup')?pending:{...empty,items:[dose]});
 wrapper=mount(Trash);await flushPromises();await wrapper.findAll('button').find(button=>button.text()==='恢复')!.trigger('click');
 app.selectedMemberId.value='n';mocks.request.mockResolvedValue(empty);await nextTick();await flushPromises();finish({id:'dose'});await flushPromises();expect(app.notifyDataChanged).not.toHaveBeenCalled();expect(mocks.toast).not.toHaveBeenCalled();
});

it.each(['symptom','medication','intake'] as const)('%s restores from the same bin using its own version and operation',async kind=>{
 let restored=false;const row={...dose,kind,id:kind};mocks.request.mockImplementation(async(path:string,init?:RequestInit)=>{if(init?.method==='POST'){restored=true;return {id:kind};}return path.includes('trash-cleanup')?pending:{...empty,items:restored?[]:[row]};});wrapper=mount(Trash);await flushPromises();await wrapper.findAll('button').find(button=>button.text()==='恢复')!.trigger('click');await flushPromises();expect(mocks.request).toHaveBeenCalledWith('health-records/trash',{method:'POST',body:JSON.stringify({kind,id:kind,revision:4,operation:'restore'})});expect(wrapper.text()).toContain('回收站为空');
});

it('restores and permanently removes a trashed process through the shared endpoint while explaining original record preservation',async()=>{
 const process={...report,id:'synthetic-process',kind:'process',title:'合成历程',revision:3};
 mocks.request.mockImplementation(async(path:string,options?:RequestInit)=>options?.method?{}:path.includes('trash-cleanup')?{...pending,status:'none'}:{items:[process],hasMore:false,nextCursor:null});
 wrapper=mount(Trash);await flushPromises();expect(wrapper.text()).toContain('健康历程');expect(wrapper.text()).toContain('原始记录和附件保留');
 await wrapper.findAll('button').find(button=>button.text()==='恢复')!.trigger('click');await flushPromises();
 expect(mocks.request.mock.calls.find(([,options])=>options?.method==='POST')![1]).toMatchObject({body:JSON.stringify({kind:'process',id:process.id,revision:3,operation:'restore'})});
 await wrapper.findAll('button').find(button=>button.text()==='永久删除')!.trigger('click');const confirmation=mocks.ask.mock.calls.at(-1)![0];expect(confirmation.message).toContain('仅删除历程分组与整理信息');await confirmation.run();await flushPromises();
 expect(mocks.request.mock.calls.filter(([,options])=>options?.method==='POST').at(-1)![1].body).toBe(JSON.stringify({kind:'process',id:process.id,revision:3,operation:'purge'}));
});
