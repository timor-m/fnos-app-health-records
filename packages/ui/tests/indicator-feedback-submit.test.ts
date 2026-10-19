import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {defineComponent} from 'vue';
import {flushPromises,mount} from '@vue/test-utils';
import {createMemoryHistory,createRouter,type Router} from 'vue-router';
import Issues from '../src/pages/settings/IndicatorIssuesSettingsPage.vue';
import Feedback from '../src/pages/settings/FeedbackSettingsPage.vue';
import {takeFeedbackDraft} from '../src/utils/feedback-service';
const mocks=vi.hoisted(()=>({request:vi.fn(),toast:vi.fn(),copy:vi.fn(),refresh:vi.fn()}));
vi.mock('../src/utils/api',()=>({request:mocks.request}));
vi.mock('../src/composables/useAppContext',()=>({useAppContext:()=>({refreshReminderCount:mocks.refresh})}));
vi.mock('../src/composables/useToast',()=>({useToast:()=>({show:mocks.toast})}));
vi.mock('../src/composables/useScrollLock',()=>({useScrollLock:()=>{}}));
vi.mock('../src/utils/clipboard',()=>({copyTextToClipboard:mocks.copy}));
const issue=(rawName:string,index:number,status='unknown')=>({fingerprint:String(index),rawName,status,trendEligible:false,count:1,latestReportIssuedAt:null,sourceOrigin:'item_name',resultText:'synthetic-private-result',unit:'synthetic-unit',representativeObservationId:'private-observation',reportId:'private-report',sectionName:'private-section',canManage:true});
let rows=[issue('合成指标甲',1),issue('合成指标乙',2),issue('合成指标丙 7.2',3),issue('合成低可信项',4,'low_confidence')];
let wrapper:ReturnType<typeof mount>,router:Router,fail=false;
const submitted=()=>mocks.request.mock.calls.filter(([path,init])=>path==='feedback/tickets'&&init?.method==='POST');
async function click(text:string){const button=wrapper.findAll('button').find(b=>b.text()===text);expect(button).toBeDefined();await button!.trigger('click');await flushPromises();await flushPromises();}
async function render(path='/issues'){
 router=createRouter({history:createMemoryHistory(),routes:[{path:'/issues',component:Issues},{path:'/me/feedback',component:Feedback}]});
 await router.push(path);await router.isReady();
 wrapper=mount(defineComponent({template:'<RouterView v-slot="{Component}"><KeepAlive><component :is="Component"/></KeepAlive></RouterView>'}),{global:{plugins:[router],stubs:{teleport:true,ReportDetail:true,SubPageHeader:true,FeedbackImageEditor:true}}});
 await flushPromises();
}
beforeEach(()=>{
 vi.clearAllMocks();takeFeedbackDraft();fail=false;
 rows=[issue('合成指标甲',1),issue('合成指标乙',2),issue('合成指标丙 7.2',3),issue('合成低可信项',4,'low_confidence')];
 mocks.copy.mockResolvedValue(true);
 mocks.request.mockImplementation(async(path:string,init?:RequestInit)=>{
  if(path.endsWith('/issues'))return rows;
  if(path.endsWith('/metrics'))return null;
  if(path.includes('/history'))return {items:[],total:0};
  if(path.endsWith('/aliases'))return {aliases:[],conflicts:[]};
  if(path==='about')return {appVersion:'0.2.15',database:{schemaVersion:19,appliedSchemaVersion:19}};
  if(path==='feedback-diagnostics')return {appVersion:'0.2.15',deployment:'fnOS',accessMode:'gateway',runtime:{platform:'linux',arch:'arm64',node:'v24'},database:{appliedSchemaVersion:19},ai:{enabled:true,visionEnabled:false,provider:'custom',model:'namespace/report-v1',extractionDepth:'detailed'}};
  if(path.startsWith('feedback/tickets?'))return {items:[],total:0};
  if(path==='feedback/tickets'&&init?.method==='POST') {if(fail)throw new Error('反馈服务暂不可用');return {number:'O0001',status:'received',version:1,createdAt:'2026-10-19'};}
  throw new Error('unexpected request');
 });
});
afterEach(()=>{wrapper?.unmount();takeFeedbackDraft();});
describe('indicator applications use the normal feedback form',()=>{
 it('opens the existing form with other feedback and submits the normal environment payload only after user action',async()=>{
  await render();const checks=wrapper.findAll('.indicator-issue-check input');
  expect(checks[2].attributes('disabled')).toBeDefined();expect(checks[3].attributes('disabled')).toBeDefined();
  await checks[0].setValue(true);await checks[1].setValue(true);await click('申请收录 2 项');
  expect(router.currentRoute.value.fullPath).toBe('/me/feedback?compose=indicator');
  expect(router.currentRoute.value.fullPath).not.toMatch(/合成|private/);
  expect(wrapper.find('[role=alertdialog]').exists()).toBe(false);
  expect(wrapper.get('[role=dialog]').text()).toContain('提交反馈');
  expect(wrapper.findAll('.type-options button')[2].attributes('aria-pressed')).toBe('true');
  expect((wrapper.get('.feedback-form input[required]').element as HTMLInputElement).value).toBe('指标字典收录申请（2 项）');
  const description=wrapper.get('.feedback-form textarea');
  expect((description.element as HTMLTextAreaElement).value).toContain('- 合成指标甲\n- 合成指标乙');
  expect((description.element as HTMLTextAreaElement).value).not.toMatch(/synthetic-private-result|synthetic-unit|private-report|private-section/);
  expect(wrapper.get('.environment-info').text()).toContain('0.2.15');expect(submitted()).toHaveLength(0);
  expect(wrapper.get('.environment-info').text()).toContain('namespace/report-v1');
  await description.setValue((description.element as HTMLTextAreaElement).value+'\n合成补充说明');
  await wrapper.get('.feedback-form').trigger('submit');await flushPromises();
  const body=JSON.parse(submitted()[0][1].body);
  expect(body.category).toBe('other');expect(body.description).toContain('合成补充说明');expect(body.attachmentIds).toEqual([]);
  expect(body.environment).toMatchObject({app:{version:'0.2.15'},database:{schemaVersion:19},server:{platform:'linux'},deployment:{type:'fnos'}});
  expect(body.environment.ai).toEqual({enabled:true,visionEnabled:false,provider:'custom',model:'namespace/report-v1',extractionDepth:'detailed'});
  expect(body).not.toHaveProperty('names');expect(body.environment).not.toHaveProperty('userAgent');
  expect(wrapper.find('.success-card').text()).toContain('O0001');
  expect(mocks.request.mock.calls.some(([path])=>path==='feedback/indicator-requests')).toBe(false);
 });
 it('preserves the prefilled form on cancellation and reuses normal submit keys after failure',async()=>{
  await render();await wrapper.get('.indicator-issue-check input').setValue(true);await click('申请收录 1 项');
  await wrapper.get('.modal-close').trigger('click');expect(submitted()).toHaveLength(0);
  await wrapper.get('.feedback-primary').trigger('click');await flushPromises();
  fail=true;await wrapper.get('.feedback-form').trigger('submit');await flushPromises();
  expect(wrapper.find('.success-card').exists()).toBe(false);
  expect(wrapper.findAll('[role=alert]').map(item=>item.text()).join('')).toContain('反馈服务暂不可用');
  expect((wrapper.get('.feedback-form input[required]').element as HTMLInputElement).value).toBe('指标字典收录申请（1 项）');
  fail=false;await wrapper.get('.feedback-form').trigger('submit');await flushPromises();
  expect(submitted()).toHaveLength(2);
  expect(submitted()[0][1].headers['idempotency-key']).toBe(submitted()[1][1].headers['idempotency-key']);
  expect(submitted()[0][1].body).toBe(submitted()[1][1].body);
 });
 it('protects an existing feedback draft when returning to a cached feedback page',async()=>{
  await render('/me/feedback');await wrapper.get('.feedback-primary').trigger('click');await flushPromises();
  await wrapper.get('.feedback-form input[required]').setValue('原有草稿');await wrapper.get('.feedback-form textarea').setValue('原有说明');
  await router.push('/issues');await flushPromises();
  await wrapper.get('.indicator-issue-check input').setValue(true);await click('申请收录 1 项');
  expect((wrapper.get('.feedback-form input[required]').element as HTMLInputElement).value).toBe('原有草稿');
  expect(wrapper.text()).toContain('已保留当前未提交的反馈');expect(submitted()).toHaveLength(0);
  await click('替换当前草稿为指标申请');
  expect((wrapper.get('.feedback-form input[required]').element as HTMLInputElement).value).toBe('指标字典收录申请（1 项）');
  expect(wrapper.findAll('.type-options button')[2].attributes('aria-pressed')).toBe('true');
 });
 it('does not open an empty composer from a stale URL and rejects oversized name handoffs',async()=>{
  await render('/me/feedback?compose=indicator');expect(wrapper.find('[role=dialog]').exists()).toBe(false);
  rows=Array.from({length:40},(_,i)=>issue('合成指标'.repeat(20)+String.fromCharCode(0x4e00+i),i));
  await router.push('/issues');await flushPromises();await click('全选');await click('申请收录 40 项');
  expect(wrapper.get('[role=alert]').text()).toContain('3000');expect(router.currentRoute.value.path).toBe('/issues');expect(submitted()).toHaveLength(0);
 });
});
