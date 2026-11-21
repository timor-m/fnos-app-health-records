import { afterEach,beforeEach,expect,it,vi } from 'vitest';
import { flushPromises,mount } from '@vue/test-utils';
import { defineComponent,KeepAlive,reactive,ref } from 'vue';
import Page from '../src/pages/OverviewPage.vue';
import HealthProcessCard from '../src/components/HealthProcessCard.vue';
import { feedEntries,feedEntry } from './fixtures/health-feed';
import type { HealthOverview } from '../../shared/health-overview';
const mocks=vi.hoisted(()=>({request:vi.fn(),push:vi.fn(),replace:vi.fn(),back:vi.fn(),toast:vi.fn(),touch:null as any}));
const route=reactive({path:'/overview',fullPath:'/overview',query:{} as Record<string,string>});
const history=reactive({state:{} as Record<string,unknown>});
const app={selectedMemberId:ref('member'),selectedMember:ref({id:'member',displayName:'合成成员',permission:'manager'}),dataVersion:ref(0),refreshReminderCount:vi.fn(),topbarSubtitles:ref<Record<string,string>>({}),setTopbarSubtitle:vi.fn((key:string,value:string)=>{app.topbarSubtitles.value={...app.topbarSubtitles.value,[key]:value};}),clearTopbarSubtitle:vi.fn((key:string)=>{const next={...app.topbarSubtitles.value};delete next[key];app.topbarSubtitles.value=next;})};
vi.mock('../src/utils/api',()=>({request:mocks.request}));vi.mock('../src/composables/useAppContext',()=>({useAppContext:()=>app}));vi.mock('../src/composables/useTouchRecordDetail',()=>({useTouchRecordDetail:()=>mocks.touch}));vi.mock('../src/composables/useToast',()=>({useToast:()=>({show:mocks.toast})}));
vi.mock('vue-router',()=>({useRoute:()=>route,useRouter:()=>({push:mocks.push,replace:mocks.replace,back:mocks.back,options:{history}}),RouterLink:{name:'RouterLink',props:['to'],template:'<a :href="typeof to===\'string\'?to:to.path"><slot/></a>'}}));
vi.mock('../src/components/HealthRecordDetailModal.vue',()=>({default:{props:['open','kind','recordId'],emits:['close','updated','openReport'],template:'<div v-if="open" role="dialog"><button @click="$emit(\'close\')">关闭详情</button>{{kind}}:{{recordId}}</div>'}}));
const Link={name:'RouterLink',props:['to'],template:'<a :href="typeof to===\'string\'?to:to.path"><slot/></a>'};
const sample=(memberId='member'):HealthOverview=>({memberId,recordCount:6,categoryCounts:{report:1,imaging:1,symptom:1,monitoring:1,medication:1,vaccination:1},pending:{reminderCount:7,reminders:[{id:'reminder',memberId,title:'合成接种待办',dueAt:'2026-12-01',reportId:null,reportTitle:null,vaccinationId:'vaccine'}],reviewCount:2,processingCount:3,failedCount:1,documents:[]},attention:{symptomCount:1,medicationCount:1,symptoms:[{...feedEntry('symptom','symptom'),memberId}],medications:[{...feedEntry('medication','medication'),memberId}]},processes:[],recentRecords:feedEntries.map(entry=>({...entry,memberId}))});
const wrappers:any[]=[];const render=()=>{const wrapper=mount(Page,{global:{stubs:{RouterLink:Link}}});wrappers.push(wrapper);return wrapper;};
beforeEach(()=>{vi.clearAllMocks();mocks.touch=ref(false);route.path='/overview';route.query={};history.state={};app.selectedMemberId.value='member';app.selectedMember.value={id:'member',displayName:'合成成员',permission:'manager'};app.dataVersion.value=0;app.topbarSubtitles.value={};mocks.request.mockImplementation(async(path:string)=>sample(new URLSearchParams(path.split('?')[1]).get('memberId')||'member'));});
afterEach(()=>wrappers.splice(0).forEach(wrapper=>wrapper.unmount()));
async function pullRefresh(wrapper:any){
 for(const [name,y] of [['touchstart',0],['touchmove',180],['touchend',180]] as const){const event=new Event(name,{bubbles:true,cancelable:true});Object.defineProperty(event,'touches',{value:[{clientY:y}]});wrapper.element.dispatchEvent(event);}
 await flushPromises();
}

it('shows category counts, exact navigation filters, true reminder total and recent records',async()=>{const wrapper=render();await flushPromises();const categories=wrapper.findAll('.overview-types .overview-type');expect(categories.map(link=>link.text())).toEqual(['报告1','症状1','监测1','用药1','接种1','影像—']);expect(categories.at(-1)!.attributes('disabled')).toBeDefined();expect(categories.at(-1)!.element.tagName).toBe('BUTTON');for(const link of wrapper.findAllComponents(Link).filter(link=>link.element.closest('.overview-types')))expect(link.props('to')).toMatchObject({path:'/events',query:{category:link.attributes('data-category')}});expect(wrapper.text()).toContain('近期提醒 7');expect(wrapper.get('.overview-focus-counts').text()).toContain('正在使用的药物 1 项');expect(wrapper.get('.overview-processing').text()).toContain('待确认2 份');const cards=wrapper.findAll('.overview-panel').at(-1)!.findAll('.health-timeline-card');expect(cards).toHaveLength(6);expect(wrapper.text()).not.toContain('报告总数');expect(wrapper.text()).not.toContain('待识别报告');});
it('keeps server upload order and labels report dates in both document previews only',async()=>{
 const value=sample();
 const recent={...feedEntry('report','report','new-upload'),title:'合成新上传',date:'2020-01-02',uploadedAt:'2026-01-03T08:00:00Z',status:'processing',duplicateHint:'possible' as const};
 const older={...feedEntry('report','report','old-upload'),title:'合成旧上传',date:'2026-01-02',status:'failed'};
 value.recentRecords=[recent,older];value.pending.documents=[recent,{...older,date:null}];
 mocks.request.mockResolvedValue(value);
 const wrapper=render();await flushPromises();
 expect(wrapper.get('.overview-recent-uploads h3').text()).toBe('最近上传');
 for(const selector of ['.overview-recent-uploads','.overview-pending-list']){
  const cards=wrapper.get(selector).findAll('.health-timeline-card');
  expect(cards.map(card=>card.get('strong').text())).toEqual([recent.title,older.title]);
  expect(cards[0].get('.health-timeline-date-main').text()).toBe('01-02');
  expect(cards[0].get('.health-timeline-upload-time').text()).toContain('上传时间：');
  expect(cards[0].get('.health-timeline-upload-time').attributes('datetime')).toBe(recent.uploadedAt);
  expect(cards[0].get('.health-timeline-duplicate').text()).toBe('疑似重复');
  expect(cards[0].attributes('href')).toContain('/events/detail/report/new-upload');
 }
 expect(wrapper.get('.overview-pending-list').findAll('.health-timeline-date-main')[1].text()).toBe('待确认');
 expect(wrapper.get('.overview-attention').text()).not.toContain('报告日期');
});
it('shows a noninteractive layout skeleton on first load and member switch, preserving cards during refresh',async()=>{
 let finish!:(value:HealthOverview)=>void;mocks.request.mockReturnValueOnce(new Promise(resolve=>finish=resolve));const wrapper=render();await flushPromises();
 const skeleton=wrapper.get('.overview-skeleton');expect(skeleton.attributes('role')).toBe('status');expect(skeleton.attributes('aria-label')).toBe('正在加载概览');expect(skeleton.attributes('aria-busy')).toBe('true');
 expect(skeleton.findAll('.overview-type')).toHaveLength(6);expect(skeleton.findAll('.overview-panel')).toHaveLength(3);expect(skeleton.find('a,button,input,img').exists()).toBe(false);expect(wrapper.find('.loading-list').exists()).toBe(false);
 finish(sample());await flushPromises();expect(wrapper.find('.overview-skeleton').exists()).toBe(false);const cards=wrapper.get('.overview-types').element;
 mocks.request.mockReturnValueOnce(new Promise(resolve=>finish=resolve));app.dataVersion.value++;await flushPromises();expect(wrapper.find('.overview-skeleton').exists()).toBe(false);expect(wrapper.get('.overview-types').element).toBe(cards);finish(sample());await flushPromises();
 mocks.request.mockReturnValueOnce(new Promise(resolve=>finish=resolve));app.selectedMemberId.value='second';await flushPromises();expect(wrapper.find('.overview-skeleton').exists()).toBe(true);expect(wrapper.find('.health-timeline-card').exists()).toBe(false);finish(sample('second'));await flushPromises();expect(wrapper.find('.overview-skeleton').exists()).toBe(false);
});
it('replaces the initial skeleton with an error and restores it only while retrying',async()=>{
 mocks.request.mockRejectedValueOnce(Error('合成读取失败'));const wrapper=render();await flushPromises();expect(wrapper.find('.overview-skeleton').exists()).toBe(false);expect(wrapper.get('[role=alert]').text()).toContain('合成读取失败');
 let finish!:(value:HealthOverview)=>void;mocks.request.mockReturnValueOnce(new Promise(resolve=>finish=resolve));await wrapper.get('.error-retry').trigger('click');expect(wrapper.find('.overview-skeleton').exists()).toBe(true);finish(sample());await flushPromises();expect(wrapper.find('.overview-skeleton').exists()).toBe(false);
});
it('manual-only content is shown without requiring any uploaded report',async()=>{const value=sample();value.recordCount=3;value.categoryCounts.report=0;value.categoryCounts.imaging=0;value.recentRecords=[];mocks.request.mockResolvedValue(value);const wrapper=render();await flushPromises();expect(wrapper.find('.empty-state').exists()).toBe(false);expect(wrapper.text()).toContain('合成symptom');expect(wrapper.find('.overview-recent-uploads').exists()).toBe(false);expect(wrapper.get('.overview-type[data-category=vaccination]').text()).toContain('接种1');});
it('shows the process entry with its actual date range and hides the module when no linked process remains',async()=>{
 const value=sample();value.processes=[{id:'process',memberId:'member',title:'合成过程预览',summary:'合成过程摘要',startedAt:'2026-01-01',latestAt:'2026-01-03',recordCount:2,aiState:'unconfigured',manuallyEdited:false}];
 mocks.request.mockResolvedValue(value);const wrapper=render();await flushPromises();
 expect(wrapper.get('.overview-processes h3').text()).toBe('健康历程');expect(wrapper.get('.overview-processes header a').text()).toBe('查看全部历程');expect(wrapper.get('.overview-processes header a').attributes('href')).toBe('/health-processes');
 expect(wrapper.get('.overview-process').text()).toContain('2 条记录 · 2026-01-01 ～ 2026-01-03');expect(wrapper.get('.overview-process').text()).toContain('合成过程摘要');
 expect(wrapper.getComponent(HealthProcessCard).props()).toEqual({process:value.processes[0],returnTo:'/overview'});
 expect(wrapper.findAllComponents(Link).find(link=>link.classes().includes('overview-process'))!.props('to')).toEqual({path:'/health-processes/process',query:{returnTo:'/overview'}});
 mocks.request.mockResolvedValue(sample());await pullRefresh(wrapper);expect(wrapper.find('.overview-processes').exists()).toBe(false);
});
it('a member with reminders but no records retains reminders and gets the correct empty state',async()=>{const value=sample();value.recordCount=0;value.categoryCounts={report:0,imaging:0,symptom:0,medication:0,vaccination:0};value.recentRecords=[];value.attention={symptomCount:0,medicationCount:0,symptoms:[],medications:[]};Object.assign(value.pending,{reviewCount:0,processingCount:0,failedCount:0});mocks.request.mockResolvedValue(value);const wrapper=render();await flushPromises();expect(wrapper.text()).toContain('合成接种待办');expect(wrapper.get('.empty-state').text()).toContain('还没有健康记录');expect(wrapper.find('.overview-attention').exists()).toBe(false);expect(wrapper.find('.overview-processing').exists()).toBe(false);});
it('viewer sees source records and reminders without a write-only next dose link or upload CTA',async()=>{app.selectedMember.value.permission='viewer';const wrapper=render();await flushPromises();expect(wrapper.text()).not.toContain('填写下一剂');expect(wrapper.text()).toContain('查看提醒');});
it('late previous-member replies cannot repopulate data or errors and cross-member payloads are rejected',async()=>{let finish!:(value:unknown)=>void;mocks.request.mockReturnValueOnce(new Promise(resolve=>finish=resolve));const wrapper=render();app.selectedMemberId.value='second';app.selectedMember.value={id:'second',displayName:'合成其他成员',permission:'manager'};await flushPromises();const old=sample();old.recentRecords[0].title='旧成员内容';finish(old);await flushPromises();expect(wrapper.text()).not.toContain('旧成员内容');mocks.request.mockResolvedValueOnce(sample('member'));await pullRefresh(wrapper);expect(wrapper.get('[role="alert"]').text()).toContain('概览与当前成员不一致');});
it('refresh failure preserves existing content and has a working retry',async()=>{const wrapper=render();await flushPromises();const node=wrapper.get('.overview-types').element;mocks.request.mockRejectedValueOnce(Error('临时不可用'));await pullRefresh(wrapper);expect(wrapper.get('.overview-types').element).toBe(node);expect(wrapper.get('[role="alert"]').text()).toContain('临时不可用');await wrapper.get('.error-retry').trigger('click');await flushPromises();expect(wrapper.find('[role="alert"]').exists()).toBe(false);});
it('touch cards open on the overview, close by owned browser history, and clear on member change',async()=>{mocks.touch.value=true;const wrapper=render();await flushPromises();await wrapper.get('.health-timeline-card').trigger('click');const target=mocks.push.mock.calls.at(-1)![0];expect(target.path).toBe('/overview');expect(target.query.recordKind).toBe('symptom');history.state=target.state;route.query=target.query;await flushPromises();expect(wrapper.get('[role="dialog"]').text()).toContain('symptom');await wrapper.get('[role="dialog"] button').trigger('click');expect(mocks.back).toHaveBeenCalledOnce();app.selectedMemberId.value='second';await flushPromises();expect(wrapper.find('[role="dialog"]').exists()).toBe(false);});
it('cached overview ignores changes while away and refreshes on return',async()=>{const visible=ref(true);const wrapper=mount(defineComponent({components:{Page,KeepAlive},setup:()=>({visible}),template:'<KeepAlive><Page v-if="visible"/></KeepAlive>'}),{global:{stubs:{RouterLink:Link}}});wrappers.push(wrapper);await flushPromises();expect(app.topbarSubtitles.value.overview).toBe('共 6 条记录');visible.value=false;route.path='/events';await flushPromises();expect(app.topbarSubtitles.value.overview).toBeUndefined();const before=mocks.request.mock.calls.length;app.dataVersion.value++;await flushPromises();expect(mocks.request).toHaveBeenCalledTimes(before);route.path='/overview';visible.value=true;await flushPromises();expect(mocks.request.mock.calls.length).toBe(before+1);expect(app.topbarSubtitles.value.overview).toBe('共 6 条记录');});

it('hides zero-count task panels while keeping records and current focus visible',async()=>{
 const value=sample();value.pending={reminderCount:0,reminders:[],reviewCount:0,processingCount:0,failedCount:0,documents:[]};mocks.request.mockResolvedValue(value);const wrapper=render();await flushPromises();expect(wrapper.find('.overview-columns').exists()).toBe(false);expect(wrapper.text()).toContain('当前关注');expect(wrapper.text()).toContain('最近上传');
});

it('hides the entire attention and processing sections when only historical records remain',async()=>{
 const value=sample();value.pending={reminderCount:0,reminders:[],reviewCount:0,processingCount:0,failedCount:0,documents:[]};value.attention={symptomCount:0,medicationCount:0,symptoms:[],medications:[]};mocks.request.mockResolvedValue(value);
 const wrapper=render();await flushPromises();expect(wrapper.text()).not.toContain('当前关注');expect(wrapper.text()).not.toContain('资料处理');expect(wrapper.find('.overview-columns').exists()).toBe(false);expect(wrapper.text()).toContain('最近上传');expect(wrapper.findAll('.overview-types a')).toHaveLength(5);
});

it.each(['symptom','medication'] as const)('shows only the nonempty %s attention filter and expands its sole card',async category=>{
 const value=sample();const onlySymptom=category==='symptom';value.attention={symptomCount:onlySymptom?1:0,medicationCount:onlySymptom?0:1,symptoms:onlySymptom?value.attention.symptoms:[],medications:onlySymptom?[]:value.attention.medications};mocks.request.mockResolvedValue(value);
 const wrapper=render();await flushPromises();expect(wrapper.findAll('.overview-focus-counts a')).toHaveLength(1);expect(wrapper.get('.overview-focus-counts').text()).toContain(onlySymptom?'持续跟踪的症状 1 项':'正在使用的药物 1 项');expect(wrapper.get('.overview-focus-list').classes()).toContain('single-item');expect(wrapper.findAll('.overview-attention .health-timeline-card')).toHaveLength(1);
});

it('removes cleared modules on refresh without hiding reminders or recent history',async()=>{
 const wrapper=render();await flushPromises();expect(wrapper.find('.overview-attention').exists()).toBe(true);expect(wrapper.find('.overview-processing').exists()).toBe(true);
 const value=sample();Object.assign(value.pending,{reviewCount:0,processingCount:0,failedCount:0,documents:[]});value.attention={symptomCount:0,medicationCount:0,symptoms:[],medications:[]};mocks.request.mockResolvedValueOnce(value);
 await pullRefresh(wrapper);expect(wrapper.find('.overview-attention').exists()).toBe(false);expect(wrapper.find('.overview-processing').exists()).toBe(false);expect(wrapper.findAll('.overview-columns > .overview-panel')).toHaveLength(1);expect(wrapper.get('.overview-columns h3').text()).toBe('近期提醒 7');expect(wrapper.text()).toContain('近期提醒 7');expect(wrapper.text()).toContain('最近上传');
});

it('pull refresh preserves visible overview cards and does not occupy a blank grid row while idle',async()=>{
 const wrapper=render();await flushPromises();const cards=wrapper.get('.overview-types').element;expect(wrapper.find('.pull-refresh').exists()).toBe(false);const count=mocks.request.mock.calls.length;
 for(const [name,y] of [['touchstart',0],['touchmove',180],['touchend',180]] as const){const event=new Event(name,{bubbles:true,cancelable:true});Object.defineProperty(event,'touches',{value:[{clientY:y}]});wrapper.element.dispatchEvent(event);}
 await flushPromises();expect(mocks.request.mock.calls.length).toBe(count+1);expect(wrapper.get('.overview-types').element).toBe(cards);expect(wrapper.find('.pull-refresh').exists()).toBe(false);
});

it('publishes only the current member total to the topbar and removes the duplicated page heading',async()=>{
 const wrapper=render();await flushPromises();expect(app.topbarSubtitles.value.overview).toBe('共 6 条记录');expect(wrapper.find('.overview-heading').exists()).toBe(false);
 let finish!:(value:unknown)=>void;mocks.request.mockReturnValueOnce(new Promise(resolve=>finish=resolve));app.selectedMemberId.value='second';expect(app.topbarSubtitles.value.overview).toBeUndefined();await flushPromises();const next=sample('second');next.recordCount=0;finish(next);await flushPromises();expect(app.topbarSubtitles.value.overview).toBe('共 0 条记录');
 wrapper.unmount();expect(app.topbarSubtitles.value.overview).toBeUndefined();
});

it('keeps category labels separate from complete zero and multi-digit counts, including the disabled category',async()=>{
 const value=sample();value.categoryCounts={report:1234,symptom:98,monitoring:0,medication:0,vaccination:12345,imaging:100};mocks.request.mockResolvedValue(value);const wrapper=render();await flushPromises();
 const expected=[['report','报告','1234'],['symptom','症状','98'],['monitoring','监测','0'],['medication','用药','0'],['vaccination','接种','12345'],['imaging','影像','—']];
 for(const [category,label,count] of expected){const card=wrapper.get(`.overview-type[data-category="${category}"]`);expect(card.get('.overview-type-label').text()).toBe(label);expect(card.get('.overview-type-count').text()).toBe(count);expect(card.get('img').attributes('data-health-category')).toBe(category);}
 expect(wrapper.get('.overview-type[data-category="imaging"]').attributes('disabled')).toBeDefined();
});

it('opens a pending document over the overview and retains its history entry',async()=>{
 const value=sample();value.pending.documents=[{...feedEntry('report','report'),memberId:'member'}];
 mocks.request.mockResolvedValue(value);mocks.touch.value=true;
 const wrapper=render();await flushPromises();
 await wrapper.get('.overview-pending-list .health-timeline-card').trigger('click');await flushPromises();
 expect(mocks.push).toHaveBeenCalledOnce();
 const target=mocks.push.mock.calls[0][0];
 expect(target.query).toMatchObject({recordKind:'report',recordId:value.pending.documents[0].resourceId});
 route.query=target.query;history.state=target.state;await flushPromises();
 expect(wrapper.get('[role="dialog"]').text()).toContain('report:');
});
