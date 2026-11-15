import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {flushPromises,mount} from '@vue/test-utils';
import ReportCombineDialog from '../src/components/ReportCombineDialog.vue';
import ConfirmDialog from '../src/components/ConfirmDialog.vue';
import {useConfirm} from '../src/composables/useConfirm';
const report={id:'target',memberId:'m',title:'合成保留报告',reportIssuedAt:'2026-01-01',hospitalName:'合成机构'};
const source={...report,id:'source',title:'合成并入报告',status:'ready',pageCount:2};
const preview={source,target:report,fingerprint:'a'.repeat(64),sourceCounts:{pages:2,observations:2,otherRecords:1},targetCounts:{pages:1,observations:1,otherRecords:0},sameReportDate:true,repeatedPageCount:0};
const json=(data:unknown,status=200)=>new Response(JSON.stringify(status===200?{ok:true,data}:{ok:false,error:{message:'报告内容已变化，请重新预览'}}),{status,headers:{'content-type':'application/json'}});
let confirmation:ReturnType<typeof mount>;
let wrapper:ReturnType<typeof mount>,fetchMock:ReturnType<typeof vi.fn>;
beforeEach(()=>{
 useConfirm().cancel();
 fetchMock=vi.fn(async(input:unknown)=>String(input).includes('combine-preview')?json(preview):String(input).endsWith('/combine')?json({reportId:'target',sourceReportId:'source',status:'needs_review',movedPages:2,movedObservations:2,movedOtherRecords:1}):json({items:[report,source,{...source,id:'busy',title:'合成处理中报告',status:'processing'}],nextCursor:null,hasMore:false}));
 vi.stubGlobal('fetch',fetchMock);
});
afterEach(()=>{wrapper?.unmount();useConfirm().cancel();confirmation?.unmount();vi.unstubAllGlobals();vi.useRealTimers();document.body.innerHTML='';});
async function open(){confirmation=mount(ConfirmDialog,{attachTo:document.body,global:{stubs:{teleport:true}}});wrapper=mount(ReportCombineDialog,{attachTo:document.body,props:{report},global:{stubs:{teleport:true}}});await flushPromises();}
const button=(text:string)=>wrapper.findAll('button').find(b=>b.text()===text)!;
async function approve(){await button('确认合并').trigger('click');await flushPromises();expect(confirmation.find('[role=alertdialog]').exists()).toBe(true);await confirmation.get('button.primary-button').trigger('click');await flushPromises();}
describe('合并已有报告',()=>{
 it('retains the opened report, excludes it from candidates, and never merges by date alone',async()=>{
  await open();expect(wrapper.text()).toContain('保留当前报告');expect(wrapper.findAll('.report-combine-option')).toHaveLength(2);
  expect(wrapper.findAll('.report-combine-option')[1].attributes('disabled')).toBeDefined();
  expect(button('确认合并').attributes('disabled')).toBeDefined();expect(fetchMock.mock.calls).toHaveLength(1);
  expect(String(fetchMock.mock.calls[0][0])).not.toContain('dateFrom');
 });
 it('previews the selected report, then saves the explicit direction and emits a refresh only after success',async()=>{
  await open();await wrapper.findAll('.report-combine-option')[0].trigger('click');await flushPromises();
  expect(wrapper.text()).toContain('将「合成并入报告」并入当前报告');expect(wrapper.text()).toContain('3 页原件 · 3 项指标');
  expect(fetchMock.mock.calls.some(([,init])=>init?.method==='POST')).toBe(false);
  await approve();
  const call=fetchMock.mock.calls.find(([url])=>String(url).endsWith('/combine'))!;
  expect(JSON.parse(String(call[1].body))).toMatchObject({sourceReportId:'source',fingerprint:preview.fingerprint,requestKey:expect.any(String)});
  expect(String(call[0])).toContain('/reports/target/combine');expect(wrapper.emitted('combined')?.length).toBe(1);
 });
 it('reuses the request key after a lost response, avoiding a second merge',async()=>{
  let attempts=0;fetchMock.mockImplementation(async(input:unknown)=>String(input).endsWith('/combine')?(++attempts===1?Promise.reject(new TypeError('synthetic disconnect')):json({reportId:'target'})):String(input).includes('combine-preview')?json(preview):json({items:[source],hasMore:false,nextCursor:null}));
  await open();await wrapper.get('.report-combine-option').trigger('click');await flushPromises();
  await approve();expect(wrapper.text()).toContain('无法连接服务器');
  await approve();
  const posts=fetchMock.mock.calls.filter(([url])=>String(url).endsWith('/combine'));expect(posts).toHaveLength(2);expect(posts[0][1].body).toBe(posts[1][1].body);
 });
 it('invalidates stale previews on conflict and requires a fresh preview',async()=>{
  const original=fetchMock.getMockImplementation()!;fetchMock.mockImplementation((input,...args)=>String(input).endsWith('/combine')?Promise.resolve(json(null,409)):original(input,...args));
  await open();await wrapper.findAll('.report-combine-option')[0].trigger('click');await flushPromises();await approve();
  expect(button('确认合并').attributes('disabled')).toBeDefined();expect(wrapper.text()).toContain('报告内容已变化');
  await button('重新预览').trigger('click');await flushPromises();expect(button('确认合并').attributes('disabled')).toBeUndefined();
 });
 it('ignores an older preview response when another report has been selected',async()=>{
  let resolveOld:(value:Response)=>void=()=>{};
  fetchMock.mockImplementation(async(input:unknown)=>String(input).includes('sourceReportId=old')?new Promise<Response>(r=>resolveOld=r):String(input).includes('combine-preview')?json(preview):json({items:[{...source,id:'old',title:'合成旧选择'},source],hasMore:false,nextCursor:null}));
  await open();const options=wrapper.findAll('.report-combine-option');await options[0].trigger('click');await options[1].trigger('click');await flushPromises();resolveOld(json({...preview,source:{...source,id:'old',title:'合成旧选择'}}));await flushPromises();
  expect(wrapper.get('.report-combine-preview').text()).toContain('合成并入报告');expect(wrapper.get('.report-combine-preview').text()).not.toContain('合成旧选择');
 });
 it('clears the selection when filtering and allows same-day search without auto selection',async()=>{
  await open();await wrapper.findAll('.report-combine-option')[0].trigger('click');await flushPromises();
  vi.useFakeTimers();await button('全部日期').trigger('click');expect(button('确认合并').attributes('disabled')).toBeDefined();
  await vi.advanceTimersByTimeAsync(250);await flushPromises();expect(String(fetchMock.mock.calls.at(-1)![0])).toContain('dateFrom=2026-01-01');expect(button('确认合并').attributes('disabled')).toBeDefined();
 });
 it('blocks closing and repeat submits while saving, and restores focus and scroll on unmount',async()=>{
  const trigger=document.createElement('button');document.body.append(trigger);trigger.focus();
  let finish:(value:Response)=>void=()=>{};const original=fetchMock.getMockImplementation()!;fetchMock.mockImplementation((input,...args)=>String(input).endsWith('/combine')?new Promise<Response>(r=>finish=r):original(input,...args));
  await open();expect(document.body.style.overflow).toBe('hidden');
  await wrapper.findAll('.report-combine-option')[0].trigger('click');await flushPromises();await approve();
  expect(button('取消').attributes('disabled')).toBeDefined();await wrapper.get('[role="dialog"]').trigger('keydown',{key:'Escape'});expect(wrapper.emitted('close')).toBeUndefined();
  finish(json({reportId:'target'}));await flushPromises();wrapper.unmount();expect(document.activeElement).toBe(trigger);expect(document.body.style.overflow).toBe('');
 });

 it('shows an explicit confirmation and keeps both reports unchanged when cancelled',async()=>{
  await open();await wrapper.findAll('.report-combine-option')[0].trigger('click');await flushPromises();
  await button('确认合并').trigger('click');await flushPromises();
  const alert=confirmation.get('[role="alertdialog"]');
  expect(alert.text()).toContain('合成并入报告');expect(alert.text()).toContain('合成保留报告');
  expect(alert.text()).toContain('撤销最近一次合并');expect(alert.text()).toContain('移入回收站');
  expect(fetchMock.mock.calls.some(([,init])=>init?.method==='POST')).toBe(false);
  expect(wrapper.get('[role="dialog"]').attributes('inert')).toBeDefined();
  expect(document.activeElement).toBe(confirmation.findAll('button')[0].element);
  await confirmation.findAll('button')[0].trigger('click');await flushPromises();
  expect(confirmation.find('[role="alertdialog"]').exists()).toBe(false);
  expect(wrapper.find('.report-combine-preview').exists()).toBe(true);expect(wrapper.emitted('close')).toBeUndefined();
  expect(fetchMock.mock.calls.some(([,init])=>init?.method==='POST')).toBe(false);
  expect(wrapper.get('[role="dialog"]').attributes('inert')).toBeUndefined();
  expect(button('确认合并').attributes('disabled')).toBeUndefined();
 });
 it('keeps keyboard focus within confirmation and Escape only cancels that confirmation',async()=>{
  await open();await wrapper.findAll('.report-combine-option')[0].trigger('click');await flushPromises();
  await button('确认合并').trigger('click');await flushPromises();
  const cancel=confirmation.findAll('button')[0],submit=confirmation.get('button.primary-button');
  submit.element.focus();await submit.trigger('keydown',{key:'Tab'});expect(document.activeElement).toBe(cancel.element);
  await cancel.trigger('keydown',{key:'Tab',shiftKey:true});expect(document.activeElement).toBe(submit.element);
  await submit.trigger('keydown',{key:'Escape'});await flushPromises();
  expect(confirmation.find('[role="alertdialog"]').exists()).toBe(false);expect(wrapper.emitted('close')).toBeUndefined();
  expect(fetchMock.mock.calls.some(([,init])=>init?.method==='POST')).toBe(false);
 });
 it('removes a pending confirmation if the report dialog is closed externally',async()=>{
  await open();await wrapper.findAll('.report-combine-option')[0].trigger('click');await flushPromises();
  await button('确认合并').trigger('click');await flushPromises();wrapper.unmount();await flushPromises();
  expect(confirmation.find('[role="alertdialog"]').exists()).toBe(false);expect(useConfirm().state.value).toBe(null);
  expect(fetchMock.mock.calls.some(([,init])=>init?.method==='POST')).toBe(false);
 });
 it('provides a list retry and empty state',async()=>{
  fetchMock.mockRejectedValueOnce(new TypeError('synthetic network failure'));await open();expect(wrapper.text()).toContain('无法连接服务器');
  fetchMock.mockResolvedValueOnce(json({items:[],hasMore:false,nextCursor:null}));await button('重试').trigger('click');await flushPromises();expect(wrapper.text()).toContain('没有可合并的其他报告');
 });
});
