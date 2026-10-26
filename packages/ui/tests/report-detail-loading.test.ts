import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { ref } from 'vue';
vi.mock('../src/composables/useAppContext', () => ({ useAppContext: () => ({
 session: ref({authenticated:true,isAdmin:false}), selectedMemberId:ref(null),
 allMembers:ref([{id:'m1',permission:'manager'}]), refreshReminderCount:vi.fn()
}) }));
vi.mock('../src/composables/useConfirm', () => ({useConfirm:()=>({ask:vi.fn()})}));
vi.mock('../src/composables/useToast', () => ({useToast:()=>({show:vi.fn()})}));
vi.mock('../src/composables/useScrollLock', () => ({useScrollLock:()=>{}}));
import ReportDetail from '../src/components/ReportDetail.vue';
const report = (id='r1',status='needs_review') => ({id,memberId:'m1',title:`Synthetic ${id}`,reportType:'checkup',status,
 sourceVersion:1,updatedAt:'2026-01-01',pages:[],observations:[],morphologyFindings:[],diagnoses:[],medications:[],procedures:[],vaccinations:[],billingItems:[],structuredSections:[],duplicateCandidates:[],duplicateCandidatesPending:status==='needs_review'});
const json=(data:unknown,status=200)=>new Response(JSON.stringify({ok:status<400,data}),{status,headers:{'content-type':'application/json'}});
function deferred<T>() {let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>{resolve=r});return {promise,resolve};}
let wrapper:ReturnType<typeof mount>|undefined;
afterEach(()=>{wrapper?.unmount();wrapper=undefined;vi.unstubAllGlobals();vi.useRealTimers();});
async function open(fetcher:any) {vi.stubGlobal('fetch',fetcher);wrapper=mount(ReportDetail,{props:{reportId:'r1',variant:'panel'},global:{stubs:{RouterLink:true,ReportNotesPanel:true,ReportPageAppend:true}}});await flushPromises();await flushPromises();return wrapper;}
function archive(){return wrapper!.findAll('button').find(b=>b.text().includes('确认归档'))!;}
function fetcher(candidates:(id:string)=>Promise<Response>,status='needs_review',jobs:unknown[]=[]) {
 return vi.fn(async(input:unknown)=>{const url=String(input);const id=url.includes('/r2')?'r2':'r1';
 if(url.endsWith('/duplicate-candidates'))return candidates(id);
 if(url.includes('/original/status'))return json({status:'ready'});
 if(url.includes('jobs'))return json(jobs);
 if(url.endsWith('?includeDuplicateCandidates=false'))return json(report(id,status));
 return json({});});
}
const job=(status:string)=>({id:'j1',status,jobType:'ai_extract',reportId:'r1',createdAt:'2026-01-01',batchId:'b1',batchKind:'manual_ai',batchStartedAt:'2026-01-01',batchSequence:1});
describe('报告详情加载',()=>{
 it('shows content while duplicate checks and original export status are pending, then unlocks archive',async()=>{
  const pending=deferred<Response>();const original=deferred<Response>();
  const base=fetcher(()=>pending.promise);const fetch=vi.fn((input:unknown)=>String(input).includes('/original/status')?original.promise:base(input));
  const w=await open(fetch);expect(w.text()).toContain('Synthetic r1');expect(w.find('.report-detail-loading').exists()).toBe(false);
  expect(w.findAll('.mini-loading').some(x=>x.text().includes('正在读取报告详情'))).toBe(false);
  expect(archive().attributes('disabled')).toBeDefined();expect(w.text()).toContain('正在核对是否有重复报告');
  pending.resolve(json(report()));await flushPromises();expect(archive().attributes('disabled')).toBeUndefined();
  original.resolve(json({status:'ready'}));await flushPromises();
 });
 it('keeps content and archive blocked on failure and allows retry',async()=>{
  let failed=true;const fetch=fetcher(async()=>failed?json(null,500):json(report()));const w=await open(fetch);
  expect(w.text()).toContain('Synthetic r1');expect(archive().attributes('disabled')).toBeDefined();
  failed=false;await w.findAll('button').find(b=>b.text()==='重试核对')!.trigger('click');await flushPromises();
  expect(archive().attributes('disabled')).toBeUndefined();
 });
 it('discards duplicate responses after switching reports',async()=>{
  const pending=deferred<Response>();const fetch=fetcher(id=>id==='r1'?pending.promise:Promise.resolve(json(report('r2'))));const w=await open(fetch);
  await w.setProps({reportId:'r2'});await flushPromises();pending.resolve(json({...report(),duplicateCandidates:[{id:'old'}]}));await flushPromises();
  expect(w.text()).toContain('Synthetic r2');expect(w.find('.duplicate-check-state').exists()).toBe(false);
 });
 it.each([{sourceVersion:2},{updatedAt:'2026-02-01'},{memberId:'other'}])('rejects stale or mismatched candidate responses %j',async mismatch=>{
  const w=await open(fetcher(async()=>json({...report(),...mismatch})));
  expect(archive().attributes('disabled')).toBeDefined();expect(w.text()).toContain('重试核对');
 });
 it('does not refetch archived content for the first settled task history',async()=>{
  const fetch=fetcher(async()=>json(report()),'ready',[job('completed')]);
  await open(fetch);expect(fetch.mock.calls.filter(([url])=>String(url).includes('?includeDuplicateCandidates=false'))).toHaveLength(1);
  expect(fetch.mock.calls.some(([url])=>String(url).includes('/duplicate-candidates'))).toBe(false);
 });
});

it('preserves task completion refresh without hiding current content',async()=>{
 let status='processing';let reads=0;const pending=deferred<Response>();
 const fetch=vi.fn(async(input:unknown)=>{const url=String(input);
  if(url.includes('jobs'))return json([job(status)]);
  if(url.includes('?includeDuplicateCandidates=false')){reads++;return reads===1?json(report('r1','processing')):pending.promise;}
  return json({status:'ready'});
 });
 const w=await open(fetch);status='completed';await w.get('button[title="刷新处理进度"]').trigger('click');await flushPromises();
 expect(reads).toBe(2);expect(w.text()).toContain('Synthetic r1');expect(w.text()).toContain('正在更新报告内容');
 pending.resolve(json(report('r1','ready')));await flushPromises();expect(w.emitted('updated')).toHaveLength(1);
});
it('resumes polling if settled history arrives before a processing detail',async()=>{
 vi.useFakeTimers();let reads=0;const pending=deferred<Response>();
 const fetch=vi.fn(async(input:unknown)=>{const url=String(input);
  if(url.includes('jobs'))return json([job('completed')]);
  if(url.includes('?includeDuplicateCandidates=false')){reads++;return reads===1?pending.promise:json(report('r1','ready'));}
  return json({status:'ready'});
 });
 const w=await open(fetch);expect(reads).toBe(1);pending.resolve(json(report('r1','processing')));await flushPromises();
 await vi.advanceTimersByTimeAsync(12500);await flushPromises();expect(reads).toBe(2);expect(w.emitted('updated')).toHaveLength(1);
});
