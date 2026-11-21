import { flushPromises,mount } from '@vue/test-utils';
import { beforeEach,afterEach,expect,it,vi } from 'vitest';
import { computed,defineComponent,KeepAlive,reactive,ref } from 'vue';
import Page from '../src/pages/HealthEventsPage.vue';
import { feedEntries,feedEntry } from './fixtures/health-feed';
const mocks=vi.hoisted(()=>({request:vi.fn(),replace:vi.fn(),push:vi.fn(),back:vi.fn(),touch:null as any}));
const route=reactive({path:'/events',query:{} as Record<string,string>,get fullPath():string{const query=new URLSearchParams(this.query).toString();return this.path+(query?'?'+query:'');}});
const app={selectedMemberId:ref('member'),selectedMember:ref({id:'member',permission:'manager'}),dataVersion:ref(0),setTopbarSearch:vi.fn(),clearTopbarSearch:vi.fn()};
vi.mock('../src/utils/api',()=>({request:mocks.request}));vi.mock('../src/composables/useAppContext',()=>({useAppContext:()=>app}));vi.mock('../src/composables/useTouchRecordDetail',()=>({useTouchRecordDetail:()=>mocks.touch}));
vi.mock('vue-router',()=>({useRoute:()=>route,useRouter:()=>({push:mocks.push,replace:mocks.replace,back:mocks.back,options:{history:{state:{}}}}),RouterLink:{props:['to'],template:'<a :href="to"><slot/></a>'}}));
vi.mock('../src/components/HealthRecordDetailModal.vue',()=>({default:{props:['open','kind','recordId'],emits:['close','updated'],template:'<div v-if="open" role="dialog"><button @click="$emit(\'close\')">关闭</button>{{kind}}:{{recordId}}</div>'}}));
vi.mock('../src/components/MedicationRecordModal.vue',()=>({default:{props:['open','add'],emits:['close'],template:'<div v-if="open" class="medication-modal"/>'}}));
const wrappers:any[]=[];const render=()=>{const value=mount(Page);wrappers.push(value);return value;};
let intersect:IntersectionObserverCallback;const disconnect=vi.fn();
beforeEach(()=>{vi.clearAllMocks();mocks.touch=ref(false);route.path='/events';route.query={};app.selectedMemberId.value='member';app.selectedMember.value={id:'member',permission:'manager'};app.dataVersion.value=0;
 vi.stubGlobal('IntersectionObserver',class{constructor(callback:IntersectionObserverCallback){intersect=callback;}observe(){}disconnect=disconnect;});
 mocks.request.mockImplementation(async(path:string)=>{const query=new URLSearchParams(path.split('?')[1]);let items=feedEntries.map(item=>({...item,memberId:query.get('memberId')||'member'}));if(query.get('category'))items=items.filter(item=>item.category===query.get('category'));if(query.get('q'))items=items.filter(item=>item.title.includes(query.get('q')!));return {items,nextCursor:null,hasMore:false};});});
afterEach(()=>{wrappers.splice(0).forEach(value=>value.unmount());vi.useRealTimers();vi.unstubAllGlobals();});
it('restores a URL search and gives every desktop card a return destination with the active filters',async()=>{
 route.query={category:'medication',subtype:'record',q:'medication'};const wrapper=render();await flushPromises();
 expect((wrapper.get('[aria-label="搜索记录"]').element as HTMLInputElement).value).toBe('medication');expect(mocks.request.mock.calls.at(-1)![0]).toContain('q=medication');
 const card=wrapper.findComponent({name:'HealthTimelineCard'});expect(card.props('returnTo')).toBeDefined();
});
it('commits typed search to the URL and blocks pagination while the new query is pending',async()=>{
 mocks.request.mockResolvedValue({items:[feedEntries[0]],nextCursor:'next',hasMore:true});vi.useFakeTimers();const wrapper=render();await flushPromises();
 const count=mocks.request.mock.calls.length;await wrapper.get('[aria-label="搜索记录"]').setValue('new');
 intersect([{isIntersecting:true}] as IntersectionObserverEntry[],{} as IntersectionObserver);await flushPromises();expect(mocks.request).toHaveBeenCalledTimes(count);
 await vi.advanceTimersByTimeAsync(350);await flushPromises();expect(mocks.replace).toHaveBeenLastCalledWith({path:'/events',query:{q:'new'}});expect(mocks.request.mock.calls.at(-1)![0]).toContain('q=new');
});
it('refreshes the complete loaded window without discarding later pages or duplicating cards',async()=>{
 mocks.request.mockImplementation(async(path:string)=>path.includes('cursor=next')?{items:feedEntries.slice(2,4),nextCursor:null,hasMore:false}:{items:feedEntries.slice(0,2),nextCursor:'next',hasMore:true});
 const wrapper=render();await flushPromises();await wrapper.get('.load-more-indicator button').trigger('click');await flushPromises();expect(wrapper.findAll('.health-timeline-card')).toHaveLength(4);
 app.dataVersion.value++;await flushPromises();expect(wrapper.findAll('.health-timeline-card')).toHaveLength(4);expect(mocks.request.mock.calls.at(-1)![0]).toContain('cursor=next');
});
it('filter failures do not leave unrelated cards under the newly selected category',async()=>{
 const wrapper=render();await flushPromises();mocks.request.mockRejectedValueOnce(Error('合成筛选错误'));await wrapper.findAll('[aria-label="记录分类"] button')[1].trigger('click');await flushPromises();
 expect(wrapper.findAll('.health-timeline-card')).toHaveLength(0);expect(wrapper.get('[role="alert"]').text()).toContain('合成筛选错误');
});
it('uses the public category filters and displays every category card including monitoring',async()=>{const wrapper=render();await flushPromises();expect(wrapper.findAll('[aria-label="记录分类"] button').map(button=>button.text())).toEqual(['全部','报告','症状','监测','用药','接种','影像']);expect(wrapper.findAll('.health-timeline-card').map(card=>card.attributes('data-category'))).toEqual(['report','imaging','symptom','monitoring','medication','vaccination']);expect(wrapper.text()).not.toContain('健康体检记录');expect(wrapper.find('.event-page-links a').exists()).toBe(false);});
it('filters through the server and separates subtype filters from category filters',async()=>{const wrapper=render();await flushPromises();await wrapper.findAll('[aria-label="记录分类"] button')[1].trigger('click');await flushPromises();expect(wrapper.findAll('.health-timeline-card')).toHaveLength(1);expect(mocks.request.mock.calls.at(-1)?.[0]).toContain('category=report');const second=wrapper.get('[aria-label="细分类型"]');expect(second.text()).toContain('体检');await second.findAll('button')[1].trigger('click');await flushPromises();expect(mocks.request.mock.calls.at(-1)?.[0]).toContain('subtype=checkup');});
it('debounces typed searches and never reloads on focus/blur or unchanged submission',async()=>{vi.useFakeTimers();const wrapper=render();await flushPromises();const input=wrapper.get('[aria-label="搜索记录"]');const count=mocks.request.mock.calls.length;await input.trigger('focus');await input.trigger('blur');await input.trigger('keydown.enter');expect(mocks.request).toHaveBeenCalledTimes(count);await input.setValue('imaging');await vi.advanceTimersByTimeAsync(350);await flushPromises();expect(wrapper.findAll('.health-timeline-card')).toHaveLength(1);expect(mocks.request.mock.calls.at(-1)?.[0]).toContain('q=imaging');});
it('late requests cannot replace the new member or expose cross-member rows',async()=>{let done!:(value:unknown)=>void;mocks.request.mockReturnValueOnce(new Promise(resolve=>done=resolve));const wrapper=render();app.selectedMemberId.value='second';app.selectedMember.value={id:'second',permission:'manager'};await flushPromises();done({items:[{...feedEntry('report','report'),title:'旧成员秘密'}],nextCursor:null});await flushPromises();expect(wrapper.text()).not.toContain('旧成员秘密');expect(wrapper.findAll('.health-timeline-card')).toHaveLength(6);mocks.request.mockResolvedValueOnce({items:[feedEntry('report','report')],nextCursor:null});await wrapper.get('[title="刷新"]').trigger('click');await flushPromises();expect(wrapper.text()).toContain('记录与当前成员不一致');});
it('keeps existing DOM mounted while refresh is pending and retains results after failure',async()=>{const wrapper=render();await flushPromises();const list=wrapper.get('.events-list').element;let reject!:(cause:Error)=>void;mocks.request.mockReturnValueOnce(new Promise((_resolve,fail)=>reject=fail));await wrapper.get('[title="刷新"]').trigger('click');await flushPromises();expect(wrapper.find('.loading-list').exists()).toBe(false);expect(wrapper.get('.events-list').element).toBe(list);reject(Error('刷新失败'));await flushPromises();expect(wrapper.text()).toContain('刷新失败');expect(wrapper.get('.events-list').element).toBe(list);});
it('restores automatic pagination, prevents concurrent requests, and stops automatic retry on error',async()=>{mocks.request.mockResolvedValueOnce({items:[feedEntries[0]],nextCursor:'next',hasMore:true});const wrapper=render();await flushPromises();mocks.request.mockRejectedValueOnce(Error('更多失败'));intersect([{isIntersecting:true}] as IntersectionObserverEntry[],{} as IntersectionObserver);await flushPromises();expect(wrapper.text()).toContain('更多失败');const count=mocks.request.mock.calls.length;intersect([{isIntersecting:true}] as IntersectionObserverEntry[],{} as IntersectionObserver);await flushPromises();expect(mocks.request).toHaveBeenCalledTimes(count);mocks.request.mockResolvedValueOnce({items:[feedEntries[1]],nextCursor:null});await wrapper.get('.load-more-indicator button').trigger('click');await flushPromises();expect(wrapper.findAll('.health-timeline-card')).toHaveLength(2);expect(wrapper.find('.load-more-indicator').exists()).toBe(false);});
it('actual pull gestures refresh without replacing the visible list',async()=>{const wrapper=render();await flushPromises();const list=wrapper.get('.events-list').element;const count=mocks.request.mock.calls.length;for(const [name,y] of [['touchstart',0],['touchmove',180],['touchend',180]] as const){const event=new Event(name,{bubbles:true,cancelable:true});Object.defineProperty(event,'touches',{value:[{clientY:y}]});wrapper.element.dispatchEvent(event);}await flushPromises();expect(mocks.request.mock.calls.length).toBe(count+1);expect(wrapper.get('.events-list').element).toBe(list);});
it.each(['记录分类','细分类型'])('swiping %s cannot move the refresh indicator or reload the list',async label=>{
 route.query={category:'report'};const wrapper=render();await flushPromises();const target=wrapper.get(`[aria-label="${label}"] button`).element;const count=mocks.request.mock.calls.length;
 for(const [name,x,y] of [['touchstart',200,10],['touchmove',150,25],['touchmove',100,180],['touchend',100,180]] as const){const event=new Event(name,{bubbles:true,cancelable:true});Object.defineProperty(event,'touches',{value:name==='touchend'?[]:[{clientX:x,clientY:y}]});target.dispatchEvent(event);expect(event.defaultPrevented).toBe(false);await flushPromises();expect(wrapper.get('.pull-refresh').attributes('style')).toContain('height: 0px');}
 expect(mocks.request).toHaveBeenCalledTimes(count);
});
it('registers the live topbar model and cleans up cached pages and observers',async()=>{const shown=ref(true);const wrapper=mount(defineComponent({components:{Page,KeepAlive},setup:()=>({shown}),template:'<KeepAlive><Page v-if="shown"/></KeepAlive>'}));wrappers.push(wrapper);await flushPromises();const config=app.setTopbarSearch.mock.calls.at(-1)![0];expect(config.key).toBe('events');shown.value=false;await flushPromises();expect(app.clearTopbarSearch).toHaveBeenCalledWith('events');const count=mocks.request.mock.calls.length;app.dataVersion.value++;await flushPromises();expect(mocks.request).toHaveBeenCalledTimes(count);});
it('direct touch details close by replace and member changes discard all previous dialogs',async()=>{mocks.touch.value=true;route.query={recordKind:'symptom',recordId:'symptom',q:'kept'};const wrapper=render();await flushPromises();expect(wrapper.get('[role="dialog"]').text()).toContain('symptom');await wrapper.get('[role="dialog"] button').trigger('click');expect(mocks.replace).toHaveBeenCalledWith({path:'/events',query:{q:'kept'}});app.selectedMemberId.value='second';await flushPromises();expect(wrapper.find('[role="dialog"]').exists()).toBe(false);});

it('overview category and status links select the intended filters, and changing category clears stale restrictions',async()=>{
 route.query={category:'medication',subtype:'record',status:'active'};const wrapper=render();await flushPromises();
 const path=mocks.request.mock.calls.at(-1)![0];expect(path).toContain('category=medication');expect(path).toContain('subtype=record');expect(path).toContain('status=active');expect(wrapper.find('.active-status-filter').exists()).toBe(true);
 await wrapper.findAll('[aria-label="记录分类"] button')[1].trigger('click');await flushPromises();const next=mocks.request.mock.calls.at(-1)![0];expect(next).toContain('category=report');expect(next).not.toContain('subtype=');expect(next).not.toContain('status=');
 route.query={status:'failed'};await flushPromises();expect(mocks.request.mock.calls.at(-1)![0]).toContain('status=failed');await wrapper.get('[aria-label="清除筛选"]').trigger('click');await flushPromises();expect(mocks.request.mock.calls.at(-1)![0]).not.toContain('status=');
});

it('clears all active filters from the fixed action while retaining search context',async()=>{
 route.query={category:'report',subtype:'laboratory',status:'needs_review',q:'kept'};const wrapper=render();await flushPromises();
 expect(wrapper.get('.secondary-filters .active-status-filter').text()).toBe('待确认资料');
 await wrapper.get('[aria-label="搜索记录"]').setValue('kept');
 await wrapper.get('.timeline-filter-bar > [aria-label="清除筛选"]').trigger('click');await flushPromises();
 const path=mocks.request.mock.calls.at(-1)![0];expect(path).not.toContain('category=');expect(path).not.toContain('subtype=');expect(path).not.toContain('status=');expect(path).toContain('q=kept');
 expect(mocks.replace).toHaveBeenLastCalledWith({path:'/events',query:{q:'kept'}});
 expect(wrapper.find('.timeline-filter-clear').exists()).toBe(false);
});

it.each([{category:'report'},{category:'symptom'},{subtype:'laboratory'},{status:'failed'}])('shows clear for any active filter %j',async query=>{
 route.query={...query};const wrapper=render();await flushPromises();expect(wrapper.get('[aria-label="清除筛选"]').text()).toBe('清除');
 await wrapper.get('[aria-label="清除筛选"]').trigger('click');await flushPromises();expect(wrapper.find('.timeline-filter-clear').exists()).toBe(false);
 expect(wrapper.get('[aria-label="记录分类"] button').attributes('aria-pressed')).toBe('true');
});
it('keeps clear hidden until a category is selected during normal browsing',async()=>{
 const wrapper=render();await flushPromises();expect(wrapper.find('.timeline-filter-clear').exists()).toBe(false);
 await wrapper.findAll('[aria-label="记录分类"] button')[1].trigger('click');await flushPromises();expect(wrapper.get('[aria-label="清除筛选"]').isVisible()).toBe(true);
});

it.each(['category','subtype','clear'])('touch %s changes reveal the first result below the sticky header without resetting horizontal filters',async action=>{
 mocks.touch.value=true;route.query={category:'report'};const scrollTo=vi.fn();vi.stubGlobal('scrollTo',scrollTo);vi.stubGlobal('scrollY',480);vi.stubGlobal('getComputedStyle',()=>({top:'58px'}));
 const wrapper=render();await flushPromises();vi.spyOn(wrapper.element,'getBoundingClientRect').mockReturnValue({top:-418} as DOMRect);
 const primary=wrapper.get('.timeline-filters').element;primary.scrollLeft=64;
 if(action==='category')await wrapper.findAll('[aria-label="记录分类"] button')[3].trigger('click');
 else if(action==='subtype')await wrapper.findAll('[aria-label="细分类型"] button')[2].trigger('click');
 else await wrapper.get('[aria-label="清除筛选"]').trigger('click');
 await flushPromises();expect(scrollTo).toHaveBeenCalledExactlyOnceWith({top:4,behavior:'instant'});expect(primary.scrollLeft).toBe(64);
});

it('does not reposition desktop filters, unchanged touch selections, or restored route filters',async()=>{
 const scrollTo=vi.fn();vi.stubGlobal('scrollTo',scrollTo);route.query={category:'report'};
 const wrapper=render();await flushPromises();vi.spyOn(wrapper.element,'getBoundingClientRect').mockReturnValue({top:-418} as DOMRect);
 await wrapper.findAll('[aria-label="记录分类"] button')[3].trigger('click');await flushPromises();expect(scrollTo).not.toHaveBeenCalled();
 mocks.touch.value=true;await wrapper.findAll('[aria-label="记录分类"] button')[3].trigger('click');await flushPromises();expect(scrollTo).not.toHaveBeenCalled();
 route.query={category:'report',subtype:'laboratory'};await flushPromises();expect(scrollTo).not.toHaveBeenCalled();
});

it.each(['course','intake'])('ignores retired medication subtype %s',async oldSubtype=>{
 route.query={category:'medication',subtype:oldSubtype};const wrapper=render();await flushPromises();
 expect(wrapper.findAll('[aria-label="细分类型"] button').map(button=>button.text())).toEqual(['全部类型','用药单','用药记录']);
 expect(wrapper.get('[aria-label="细分类型"] [aria-pressed="true"]').text()).toBe('全部类型');
 expect(mocks.request.mock.calls.at(-1)?.[0]).not.toContain('subtype=');
});

it('places the unavailable imaging filter last and does not issue a request when it is clicked',async()=>{
 const wrapper=render();await flushPromises();const buttons=wrapper.findAll('[aria-label="记录分类"] button');const imaging=buttons.at(-1)!;
 expect(imaging.text()).toBe('影像');expect(imaging.attributes('disabled')).toBeDefined();const count=mocks.request.mock.calls.length;
 await imaging.trigger('click');await flushPromises();expect(mocks.request).toHaveBeenCalledTimes(count);expect(buttons[0].attributes('aria-pressed')).toBe('true');
 expect(wrapper.find('[data-category="imaging"].health-timeline-card').exists()).toBe(true);
});

it('returns a saved vaccination overlay to its original filtered list',async()=>{
 mocks.touch.value=true;route.query={recordKind:'vaccination',recordId:'new',returnTo:'/events?category=vaccination&subtype=administered'};const wrapper=render();await flushPromises();await wrapper.get('[role="dialog"] button').trigger('click');
 expect(mocks.replace).toHaveBeenCalledWith('/events?category=vaccination&subtype=administered');
});

it('unifies legacy vaccination filters under one vaccination category',async()=>{
 route.query={category:'vaccination',subtype:'administered'};const wrapper=render();await flushPromises();
 expect(wrapper.find('[aria-label="细分类型"]').exists()).toBe(false);
 expect(mocks.request.mock.calls.at(-1)![0]).toContain('category=vaccination');
 expect(mocks.request.mock.calls.at(-1)![0]).not.toContain('subtype=');
});
