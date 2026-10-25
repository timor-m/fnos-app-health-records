import { afterEach,beforeEach,expect,it,vi } from 'vitest';
import { flushPromises,mount } from '@vue/test-utils';
import { KeepAlive,defineComponent,ref } from 'vue';
import { createMemoryHistory,createRouter } from 'vue-router';
import Page from '../src/pages/HealthProcessesPage.vue';
import Detail from '../src/pages/HealthProcessDetailPage.vue';
import HealthProcessCard from '../src/components/HealthProcessCard.vue';
import { vaccinationReturnTo } from '../src/utils/vaccination';
import type { HealthProcessPage,HealthProcessSummary } from '../../shared/health-process';
const mocks=vi.hoisted(()=>({request:vi.fn()}));
const app={selectedMemberId:ref('member'),selectedMember:ref({id:'member',permission:'viewer'}),dataVersion:ref(0)};
vi.mock('../src/components/HealthProcessCarePanel.vue',()=>({default:{template:'<div/>'}}));
vi.mock('../src/utils/api',()=>({request:mocks.request}));
vi.mock('../src/composables/useAppContext',()=>({useAppContext:()=>app}));
const sample=(id='recent',memberId='member'):HealthProcessSummary=>({id,memberId,title:`合成历程 ${id}`,summary:id==='recent'?'复查摘要':null,startedAt:id==='unknown'?null:'2026-01-01',latestAt:id==='unknown'?null:'2026-01-03',recordCount:2,aiState:'unconfigured',manuallyEdited:false});
let wrapper:ReturnType<typeof mount>;let router:ReturnType<typeof createRouter>;
let intersect:IntersectionObserverCallback;const disconnect=vi.fn();
const page=(items:HealthProcessSummary[],nextCursor:string|null=null,total=items.length):HealthProcessPage=>({items,total,nextCursor,hasMore:Boolean(nextCursor)});
function response(items:HealthProcessSummary[],path:string){const query=new URLSearchParams(path.split('?')[1]);const q=(query.get('q')||'').toLocaleLowerCase();const filtered=items.filter(item=>`${item.title}\n${item.summary||''}`.toLocaleLowerCase().includes(q));const offset=Number((query.get('cursor')||'next0').slice(4));return page(filtered.slice(offset,offset+20),offset+20<filtered.length?`next${offset+20}`:null,filtered.length);}
const searchSettled=async()=>{await new Promise(resolve=>setTimeout(resolve,380));await flushPromises();};
function pull(target:Element=wrapper.get('.process-list-results').element){for(const [type,y] of [['touchstart',0],['touchmove',180],['touchend',180]] as const){const event=new Event(type,{bubbles:true,cancelable:true});Object.defineProperty(event,'touches',{value:type==='touchend'?[]:[{clientX:100,clientY:y}]});target.dispatchEvent(event);}}
function reachBottom(){intersect([{isIntersecting:true}] as IntersectionObserverEntry[],{} as IntersectionObserver);}

async function start(url='/health-processes',cached=false){
 router=createRouter({history:createMemoryHistory(),routes:[{path:'/health-processes',component:Page},{path:'/health-processes/:id',component:Detail},{path:'/overview',component:{template:'<div>概览</div>'}},{path:'/events',component:{template:'<div>记录</div>'}}]});
 await router.push(url);await router.isReady();
 wrapper=mount(defineComponent({components:{KeepAlive},template:cached?'<RouterView v-slot="{Component}"><KeepAlive><component :is="Component"/></KeepAlive></RouterView>':'<RouterView/>'}),{global:{plugins:[router],stubs:{HealthProcessFollowups:true}}});await flushPromises();
}
const settle=async()=>{await new Promise(resolve=>setTimeout(resolve,0));await flushPromises();};
beforeEach(()=>{vi.clearAllMocks();app.selectedMemberId.value='member';app.dataVersion.value=0;
 Object.defineProperty(window,'scrollY',{configurable:true,value:0});
 vi.stubGlobal('IntersectionObserver',class{constructor(callback:IntersectionObserverCallback){intersect=callback;}observe(){}disconnect=disconnect;});
 mocks.request.mockImplementation(async(path:string)=>response([sample(),sample('unknown')],path));});
afterEach(()=>{wrapper?.unmount();vi.unstubAllGlobals();});
it('lists current member summaries with dates, missing dates and a return path; it never offers creation',async()=>{
 await start();expect(mocks.request).toHaveBeenCalledWith('health-processes?memberId=member&limit=20');expect(wrapper.get('h2').text()).toBe('健康历程');
 const cards=wrapper.findAll('.process-list-card');expect(cards).toHaveLength(2);expect(cards[0].text()).toContain('2 条记录');expect(cards[0].text()).toContain('2026-01-01 ～ 2026-01-03');expect(cards[0].text()).toContain('复查摘要');expect(cards[1].text()).toContain('日期未记录');
 expect(wrapper.findAllComponents(HealthProcessCard)).toHaveLength(2);expect(wrapper.getComponent(HealthProcessCard).props()).toMatchObject({process:sample(),returnTo:'/health-processes'});expect(cards[0].attributes('aria-label')).toBe('查看历程：合成历程 recent');
 expect(cards[0].attributes('href')).toContain('returnTo=/health-processes');expect(wrapper.text()).not.toContain('新增历程');
});
it('searches the full collection on the server and restores the query after detail navigation',async()=>{
 mocks.request.mockImplementation(async(path:string)=>path.startsWith('health-processes?')?response([sample(),sample('unknown')],path):{...sample(),fingerprint:'source',editToken:'edit',highlights:[],links:[],records:[{ref:{kind:'report',id:'r'},title:'合成报告',date:null,latestDate:null,category:'report',stage:'examination',stageSource:'record',description:null,institution:null,version:'1'}]});
 await start('/health-processes?q=复查',true);expect(wrapper.findAll('.process-list-card')).toHaveLength(1);expect(wrapper.get('input').element.value).toBe('复查');const calls=mocks.request.mock.calls.length;
 await wrapper.get('input').setValue('unknown');await flushPromises();await searchSettled();expect(router.currentRoute.value.query.q).toBe('unknown');expect(wrapper.get('.process-list-card').text()).toContain('unknown');expect(mocks.request).toHaveBeenCalledTimes(calls+1);expect(mocks.request.mock.calls.at(-1)![0]).toContain('q=unknown');
 await wrapper.get('.process-list-card').trigger('click');await flushPromises();expect(router.currentRoute.value.query.returnTo).toBe('/health-processes?q=unknown');expect(wrapper.getComponent(Detail).findComponent({name:'SubPageHeader'}).props('backTo')).toBe('/health-processes?q=unknown');
 await wrapper.get('.subpage-back').trigger('click');await settle();expect(router.currentRoute.value.fullPath).toBe('/health-processes?q=unknown');expect(wrapper.get('input').element.value).toBe('unknown');
});
it('distinguishes empty data from no search matches and supports clearing the query',async()=>{
 await start('/health-processes?q=不存在');expect(wrapper.get('.empty-state').text()).toContain('没有匹配的历程');await wrapper.get('.empty-state button').trigger('click');await flushPromises();await searchSettled();expect(wrapper.findAll('.process-list-card')).toHaveLength(2);
 mocks.request.mockResolvedValue(page([]));app.dataVersion.value++;await flushPromises();expect(wrapper.get('.empty-state').text()).toContain('还没有健康历程');expect(wrapper.get('.empty-state a').attributes('href')).toBe('/events');
});
it('displays long collections incrementally without losing the revealed range after returning',async()=>{
 mocks.request.mockImplementation(async(path:string)=>response(Array.from({length:25},(_,i)=>sample(String(i))),path));await start('/health-processes?q=合成历程',true);expect(wrapper.findAll('.process-list-card')).toHaveLength(20);reachBottom();await flushPromises();expect(wrapper.findAll('.process-list-card')).toHaveLength(25);
 await router.push('/overview');await flushPromises();await router.push('/health-processes?q=合成历程');await flushPromises();expect(wrapper.findAll('.process-list-card')).toHaveLength(25);expect(wrapper.get('input').element.value).toBe('合成历程');
});
it('loads one page at a time on scroll, deduplicates records, stops on errors and supports retry',async()=>{
 mocks.request.mockResolvedValueOnce(page([sample('first')],'next20',3));await start();
 let finish!:(value:HealthProcessPage)=>void;mocks.request.mockReturnValueOnce(new Promise(resolve=>finish=resolve));
 const calls=mocks.request.mock.calls.length;reachBottom();reachBottom();await flushPromises();expect(mocks.request).toHaveBeenCalledTimes(calls+1);expect(wrapper.get('.process-list-more').text()).toBe('正在加载…');
 finish(page([sample('first'),sample('second')],'next40',3));await flushPromises();expect(wrapper.findAll('.process-list-card')).toHaveLength(2);expect(wrapper.get('.process-list-count').text()).toContain('共 3 个历程');
 mocks.request.mockRejectedValueOnce(Error('合成分页失败'));reachBottom();await flushPromises();expect(wrapper.get('[role=alert]').text()).toContain('合成分页失败');
 const failed=mocks.request.mock.calls.length;reachBottom();await flushPromises();expect(mocks.request).toHaveBeenCalledTimes(failed);
 mocks.request.mockResolvedValueOnce(page([sample('third')],null,3));await wrapper.get('.process-list-more').trigger('click');await flushPromises();expect(wrapper.findAll('.process-list-card')).toHaveLength(3);expect(wrapper.find('.process-list-pagination').exists()).toBe(false);
});
it('real pull gestures refresh the loaded window without replacing visible cards or making duplicate requests',async()=>{
 mocks.request.mockImplementation(async(path:string)=>response(Array.from({length:25},(_,i)=>sample(String(i))),path));await start();reachBottom();await flushPromises();
 const list=wrapper.get('.process-list').element;const calls=mocks.request.mock.calls.length;let finish!:(value:HealthProcessPage)=>void;
 mocks.request.mockReturnValueOnce(new Promise(resolve=>finish=resolve));pull();await flushPromises();expect(wrapper.get('.pull-refresh').text()).toContain('正在刷新');expect(wrapper.get('.process-list').element).toBe(list);
 pull();expect(mocks.request).toHaveBeenCalledTimes(calls+1);finish(response(Array.from({length:25},(_,i)=>sample(String(i))),'health-processes?limit=20'));await flushPromises();
 expect(mocks.request).toHaveBeenCalledTimes(calls+2);expect(wrapper.findAll('.process-list-card')).toHaveLength(25);expect(wrapper.get('.process-list').element).toBe(list);expect(wrapper.find('.pull-refresh').exists()).toBe(false);
});
it('limits the pull gesture and its indicator to results while leaving the title, search and count outside',async()=>{
 await start();const calls=mocks.request.mock.calls.length;
 for(const selector of ['.subpage-header','.process-list-search input','.process-list-count']){pull(wrapper.get(selector).element);await flushPromises();}
 expect(mocks.request).toHaveBeenCalledTimes(calls);expect(wrapper.find('.pull-refresh').exists()).toBe(false);
 for(const [type,y] of [['touchstart',0],['touchmove',180]] as const){const event=new Event(type,{bubbles:true,cancelable:true});Object.defineProperty(event,'touches',{value:[{clientX:100,clientY:y}]});wrapper.get('.process-list-card').element.dispatchEvent(event);}
 await flushPromises();const results=wrapper.get('.process-list-results');expect(results.get('.pull-refresh').text()).toContain('释放即可刷新');
 expect(results.find('.subpage-header').exists()).toBe(false);expect(results.find('.process-list-toolbar').exists()).toBe(false);expect(results.find('.process-list-count').exists()).toBe(false);expect(mocks.request).toHaveBeenCalledTimes(calls);
 const cancel=new Event('touchcancel',{bubbles:true});results.element.dispatchEvent(cancel);await flushPromises();expect(wrapper.find('.pull-refresh').exists()).toBe(false);
});
it('retains pull refresh in an empty collection and after a failed initial load',async()=>{
 mocks.request.mockResolvedValueOnce(page([]));await start();const results=wrapper.get('.process-list-results').element;
 mocks.request.mockResolvedValueOnce(page([sample()]));pull();await flushPromises();expect(wrapper.findAll('.process-list-card')).toHaveLength(1);expect(wrapper.get('.process-list-results').element).toBe(results);
 wrapper.unmount();mocks.request.mockRejectedValueOnce(Error('合成读取失败'));await start();expect(wrapper.find('.empty-state').exists()).toBe(false);mocks.request.mockResolvedValueOnce(page([sample()]));pull();await flushPromises();expect(wrapper.findAll('.process-list-card')).toHaveLength(1);expect(wrapper.find('[role=alert]').exists()).toBe(false);
});
it('invalidates pending pagination on a search change and does not allow old replies to replace results',async()=>{
 mocks.request.mockResolvedValueOnce(page([sample('old')],'next20',21));await start();let finish!:(value:HealthProcessPage)=>void;mocks.request.mockReturnValueOnce(new Promise(resolve=>finish=resolve));reachBottom();await flushPromises();
 await wrapper.get('input').setValue('new');await flushPromises();const calls=mocks.request.mock.calls.length;reachBottom();expect(mocks.request).toHaveBeenCalledTimes(calls);
 finish(page([sample('late')],null,21));await flushPromises();expect(wrapper.text()).not.toContain('合成历程 late');mocks.request.mockResolvedValueOnce(page([sample('new')]));await searchSettled();expect(wrapper.get('.process-list-card').text()).toContain('合成历程 new');
});
it('disconnects automatic pagination while cached away and ignores a late page after a member switch',async()=>{
 mocks.request.mockResolvedValueOnce(page([sample('first')],'next20',21));await start('/health-processes',true);const stale=intersect;
 await router.push('/overview');await flushPromises();expect(disconnect).toHaveBeenCalled();const calls=mocks.request.mock.calls.length;stale([{isIntersecting:true}] as IntersectionObserverEntry[],{} as IntersectionObserver);await flushPromises();expect(mocks.request).toHaveBeenCalledTimes(calls);
 mocks.request.mockResolvedValueOnce(page([sample('first')],'next20',21));await router.push('/health-processes');await flushPromises();let finish!:(value:HealthProcessPage)=>void;mocks.request.mockReturnValueOnce(new Promise(resolve=>finish=resolve));reachBottom();await flushPromises();
 mocks.request.mockResolvedValueOnce(page([sample('other','other')]));app.selectedMemberId.value='other';await flushPromises();finish(page([sample('late')]));await flushPromises();expect(wrapper.get('.process-list-card').text()).toContain('合成历程 other');expect(wrapper.text()).not.toContain('合成历程 late');
});
it('preserves the list on refresh failure and retries; initial failure is not an empty collection',async()=>{
 mocks.request.mockRejectedValueOnce(Error('读取失败'));await start();expect(wrapper.find('.empty-state').exists()).toBe(false);expect(wrapper.get('[role=alert]').text()).toContain('读取失败');await wrapper.get('.error-retry').trigger('click');await flushPromises();const card=wrapper.get('.process-list-card').element;
 mocks.request.mockRejectedValueOnce(Error('刷新失败'));app.dataVersion.value++;await flushPromises();expect(wrapper.get('.process-list-card').element).toBe(card);expect(wrapper.get('[role=alert]').text()).toContain('刷新失败');await wrapper.get('.error-retry').trigger('click');await flushPromises();expect(wrapper.find('[role=alert]').exists()).toBe(false);
});
it('clears data on member changes, ignores old replies and rejects foreign summaries',async()=>{
 await start();let finish!:(value:unknown)=>void;mocks.request.mockReturnValueOnce(new Promise(resolve=>finish=resolve));app.dataVersion.value++;await flushPromises();mocks.request.mockResolvedValueOnce(page([sample('other','other')]));app.selectedMemberId.value='other';await flushPromises();finish(page([sample('old')]));await flushPromises();expect(wrapper.text()).toContain('合成历程 other');expect(wrapper.text()).not.toContain('合成历程 old');
 mocks.request.mockResolvedValueOnce(page([sample()]));app.dataVersion.value++;await flushPromises();expect(wrapper.get('[role=alert]').text()).toContain('与当前成员不一致');expect(wrapper.text()).toContain('合成历程 other');
});
it('cached pages ignore late failures and data updates while away, then reload when activated',async()=>{
 await start('/health-processes',true);let fail!:(cause:Error)=>void;mocks.request.mockReturnValueOnce(new Promise((_,reject)=>fail=reject));app.dataVersion.value++;await flushPromises();await router.push('/overview');await flushPromises();fail(Error('过期错误'));await flushPromises();const calls=mocks.request.mock.calls.length;app.dataVersion.value++;await flushPromises();expect(mocks.request).toHaveBeenCalledTimes(calls);await router.push('/health-processes');await flushPromises();expect(wrapper.find('[role=alert]').exists()).toBe(false);expect(mocks.request).toHaveBeenCalledTimes(calls+1);
});
it('accepts the list and its search query as a safe local return target',()=>{
 expect(vaccinationReturnTo('/health-processes?q=复查')).toBe('/health-processes?q=%E5%A4%8D%E6%9F%A5');expect(vaccinationReturnTo('//external.invalid/health-processes')).toBe('/events');expect(vaccinationReturnTo('/health-processes/a/b')).toBe('/events');
});

it('clears the current view filters without leaving that view or clearing the other view search',async()=>{
 await start('/health-processes?q=复查');
 await wrapper.get('.process-filter-clear').trigger('click');await flushPromises();await searchSettled();
 expect(router.currentRoute.value.query.q).toBeUndefined();expect(wrapper.find('.process-filter-clear').exists()).toBe(false);
 mocks.request.mockImplementation(async(path:string)=>path.startsWith('health-record-index?')?{memberId:'member',kind:'symptom',name:null,entries:[],records:[],processes:[],total:0,nextCursor:null}:page([]));
 await router.push('/health-processes?view=index&indexKind=symptom&indexQuery=合成&q=保留');await flushPromises();
 await wrapper.get('.process-filter-clear').trigger('click');await flushPromises();
 expect(router.currentRoute.value.query).toEqual({view:'index',q:'保留'});
 expect(wrapper.get('[aria-label="历程查看方式"] button[aria-pressed=true]').text()).toBe('按疾病／症状看');
 expect(wrapper.get('[aria-label="索引类型"] button[aria-pressed=true]').text()).toBe('报告诊断');
});
