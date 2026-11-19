import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {DOMWrapper,flushPromises,mount} from '@vue/test-utils';
import {reactive,ref} from 'vue';
import Page from '../src/pages/HealthProcessDetailPage.vue';
import Picker from '../src/components/HealthRecordPicker.vue';
import FormSelect from '../src/components/FormSelect.vue';
import type {HealthProcessDetail} from '../../shared/health-process';
const mocks=vi.hoisted(()=>({request:vi.fn(),replace:vi.fn(),push:vi.fn(),ask:vi.fn(),touch:false}));
const app={selectedMemberId:ref('member'),selectedMember:ref({id:'member',permission:'manager'}),dataVersion:ref(0),notifyDataChanged:vi.fn()};
const route=reactive({path:'/health-processes/process',fullPath:'/health-processes/process',params:{id:'process'},query:{} as Record<string,string>});
vi.mock('../src/components/HealthProcessCarePanel.vue',()=>({default:{template:'<div/>'}}));
vi.mock('../src/utils/api',()=>({request:mocks.request}));
vi.mock('../src/composables/useAppContext',()=>({useAppContext:()=>app}));
vi.mock('../src/composables/useTouchRecordDetail',()=>({useTouchRecordDetail:()=>ref(false)}));
vi.mock('../src/composables/useConfirm',()=>({useConfirm:()=>({ask:mocks.ask})}));
vi.mock('vue-router',()=>({useRoute:()=>route,useRouter:()=>({push:mocks.push,replace:mocks.replace}),RouterLink:{props:['to'],template:'<a><slot/></a>'}}));
const sample=():HealthProcessDetail=>({id:'process',memberId:'member',title:'合成健康历程',summary:'已记录的过程摘要',startedAt:'2026-01-01',latestAt:'2026-01-03',recordCount:2,aiState:'unconfigured',manuallyEdited:false,fingerprint:'original',editToken:'edit-original',links:[{source:{kind:'report',id:'a'},target:{kind:'medication',id:'b'}}],highlights:[],records:[
 {ref:{kind:'report',id:'a'},title:'合成检查',date:'2026-01-01',latestDate:'2026-01-01',category:'report',stage:'examination',stageSource:'record',description:null,institution:'合成机构',version:'a'},
 {ref:{kind:'medication',id:'b'},title:'合成用药',date:'2026-01-03',latestDate:'2026-01-03',category:'medication',stage:'medication',stageSource:'record',description:'合成用法',institution:null,version:'b'}]});
const wrappers:ReturnType<typeof mount>[]=[];
function render(attach=false){const wrapper=mount(Page,{attachTo:attach?document.body:undefined,global:{stubs:{HealthRecordDetailModal:true,HealthProcessFollowups:true}}});wrappers.push(wrapper);return wrapper;}
const button=(wrapper:ReturnType<typeof mount>,text:string)=>wrapper.findAll('button').find(b=>b.text()===text)!;
const timelineViewKey='health-records:process-timeline-view';
beforeEach(()=>{vi.clearAllMocks();localStorage.removeItem(timelineViewKey);app.selectedMemberId.value='member';app.selectedMember.value={id:'member',permission:'manager'};route.path=route.fullPath='/health-processes/process';route.params.id='process';route.query={};mocks.request.mockResolvedValue(sample());});
afterEach(()=>{wrappers.splice(0).forEach(w=>w.unmount());vi.useRealTimers();vi.restoreAllMocks();localStorage.removeItem(timelineViewKey);});
it('shows stage groups and dates with links to original records, without creating a new record category',async()=>{
 const wrapper=render();await flushPromises();expect(wrapper.findAll('.process-stage h3').map(h=>h.text())).toEqual(['用药 1','检查 1']);expect(wrapper.findAll('.process-record strong').map(h=>h.text())).toEqual(['合成用药','合成检查']);expect(wrapper.get('.process-meta').text()).toContain('2 条记录');expect(wrapper.text()).toContain('合成机构');expect(wrapper.find('form').exists()).toBe(false);

});
it('reverses the workflow stages and sorts dates descending within each stage, with unknown dates last in their own stage',async()=>{
 const data=sample();data.records.push(
  {...data.records[0],ref:{kind:'report',id:'newer'},title:'合成二月检查',date:'2026-02-01'},
  {...data.records[0],ref:{kind:'vaccination',id:'vaccination'},category:'vaccination',stage:'vaccination',title:'合成一月接种',date:'2026-01-02'},
  {...data.records[0],ref:{kind:'symptom',id:'unknown'},category:'symptom',stage:'symptom',title:'合成未知日期症状',date:null,latestDate:'2026-03-05'},
  {...data.records[0],ref:{kind:'report',id:'timed'},title:'合成当日较晚检查',date:'2026-01-03T20:09:00'},
  {...data.records[0],ref:{kind:'report',id:'unknown-check'},title:'合成未知日期检查',date:null,latestDate:'2026-04-02'},
  {...data.records[0],ref:{kind:'report',id:'followup'},stage:'followup',title:'合成较早复查',date:'2025-12-31'}
 );data.recordCount=data.records.length;data.records[0].latestDate='2026-04-01';const original=JSON.stringify(data.records);mocks.request.mockResolvedValue(data);
 const wrapper=render();await flushPromises();
 expect(wrapper.findAll('.process-record strong').map(node=>node.text())).toEqual(['合成较早复查','合成一月接种','合成用药','合成二月检查','合成当日较晚检查','合成检查','合成未知日期检查','合成未知日期症状']);
 expect(wrapper.findAll('.process-stage h3').map(node=>node.text())).toEqual(['复查 1','接种 1','用药 1','检查 4','症状 1']);
 const examination=wrapper.findAll('.process-stage')[3];expect(examination.findAll('time').map(node=>node.text())).toEqual(['2026-02-01','2026-01-03 20:09','2026-01-01','日期未记录']);
 expect(wrapper.findAll('.process-record small').some(node=>node.text()==='接种 · 合成机构')).toBe(false);
 expect(wrapper.findAll('.process-stage time').at(-1)?.text()).toBe('日期未记录');expect(JSON.stringify(data.records)).toBe(original);
});
it('moves a record into its corrected workflow stage while preserving the stage sequence',async()=>{
 const data=sample();mocks.request.mockResolvedValue(data);const wrapper=render();await flushPromises();
 mocks.request.mockResolvedValue({...data,records:data.records.map(record=>record.ref.id==='a'?{...record,stage:'followup' as const}:record)});app.dataVersion.value++;await flushPromises();
 expect(wrapper.findAll('.process-stage h3').map(node=>node.text())).toEqual(['复查 1','用药 1']);expect(wrapper.findAll('.process-record strong').map(node=>node.text())).toEqual(['合成检查','合成用药']);
});
it('uses a stable reference order for equal dates even when a refreshed response changes source order',async()=>{
 const data=sample();data.records.forEach(record=>{record.date='2026-01-01';record.stage='examination';});mocks.request.mockResolvedValue(data);const wrapper=render();await flushPromises();
 const first=wrapper.findAll('.process-record strong').map(node=>node.text());mocks.request.mockResolvedValue({...data,records:[...data.records].reverse()});app.dataVersion.value++;await flushPromises();
 expect(wrapper.findAll('.process-record strong').map(node=>node.text())).toEqual(first);
});
it('switches between descending workflow and descending time without requesting or mutating source data',async()=>{
 const data=sample();data.records.push(
  {...data.records[0],ref:{kind:'vaccination',id:'vaccine'},category:'vaccination',stage:'vaccination',title:'合成接种',date:'2025-12-31'},
  {...data.records[0],ref:{kind:'symptom',id:'unknown'},category:'symptom',stage:'symptom',title:'合成未知日期症状',date:null,latestDate:'2026-04-01'}
 );const original=JSON.stringify(data);mocks.request.mockResolvedValue(data);const wrapper=render();await flushPromises();
 expect(button(wrapper,'流程').attributes('aria-pressed')).toBe('true');expect(button(wrapper,'时间').attributes('aria-pressed')).toBe('false');
 expect(wrapper.findAll('.process-stage h3').map(node=>node.text())).toEqual(['接种 1','用药 1','检查 1','症状 1']);
 const calls=mocks.request.mock.calls.length;await button(wrapper,'时间').trigger('click');await flushPromises();
 expect(wrapper.findAll('.process-record strong').map(node=>node.text())).toEqual(['合成用药','合成检查','合成接种','合成未知日期症状']);
 expect(wrapper.findAll('.process-stage h3').map(node=>node.text())).toEqual(['2026 年 1 月 2','2025 年 12 月 1','日期待确认 1']);
 expect(wrapper.findAll('.process-record small').some(node=>node.text()==='接种 · 合成机构')).toBe(true);
 expect(button(wrapper,'时间').attributes('aria-pressed')).toBe('true');expect(localStorage.getItem(timelineViewKey)).toBe('time');
 await button(wrapper,'流程').trigger('click');await flushPromises();
 expect(wrapper.findAll('.process-record strong').map(node=>node.text())).toEqual(['合成接种','合成用药','合成检查','合成未知日期症状']);
 expect(localStorage.getItem(timelineViewKey)).toBe('flow');expect(mocks.request).toHaveBeenCalledTimes(calls);expect(JSON.stringify(data)).toBe(original);
});
it('remembers the device preference for viewers and defaults to workflow for invalid saved values',async()=>{
 localStorage.setItem(timelineViewKey,'time');app.selectedMember.value.permission='viewer';const wrapper=render();await flushPromises();
 expect(button(wrapper,'时间').attributes('aria-pressed')).toBe('true');expect(wrapper.findAll('.process-stage h3').map(node=>node.text())).toEqual(['2026 年 1 月 2']);
 await button(wrapper,'流程').trigger('click');await flushPromises();expect(button(wrapper,'流程').attributes('aria-pressed')).toBe('true');
 localStorage.setItem(timelineViewKey,'unsupported');const next=render();await flushPromises();expect(button(next,'流程').attributes('aria-pressed')).toBe('true');
});
it('still switches when browser storage is unavailable',async()=>{
 vi.spyOn(console,'warn').mockImplementation(()=>{});vi.spyOn(Storage.prototype,'getItem').mockImplementation(()=>{throw Error('blocked storage');});vi.spyOn(Storage.prototype,'setItem').mockImplementation(()=>{throw Error('blocked storage');});
 const wrapper=render();await flushPromises();expect(button(wrapper,'流程').attributes('aria-pressed')).toBe('true');await button(wrapper,'时间').trigger('click');await flushPromises();
 expect(button(wrapper,'时间').attributes('aria-pressed')).toBe('true');expect(wrapper.findAll('.process-stage h3').map(node=>node.text())).toEqual(['2026 年 1 月 2']);
});
it('preserves the visible record when switching a timeline that has scrolled past its beginning',async()=>{
 const data=sample();data.records.push({...data.records[0],ref:{kind:'vaccination',id:'anchor'},category:'vaccination',stage:'vaccination',title:'合成可见记录',date:'2025-12-31'});mocks.request.mockResolvedValue(data);
 const wrapper=render();await flushPromises();const scroll=vi.spyOn(window,'scrollBy').mockImplementation(()=>{});
 vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockImplementation(function(this:HTMLElement){
  if(this.matches('.process-stages'))return new DOMRect(0,-100,300,800);
  if(this.dataset.processRecord==='vaccination:anchor')return new DOMRect(0,button(wrapper,'时间').attributes('aria-pressed')==='true'?230:30,300,100);
  return new DOMRect(0,900,300,100);
 });
 await button(wrapper,'时间').trigger('click');await flushPromises();expect(scroll).toHaveBeenCalledWith({top:200,behavior:'instant'});
});
it('edits title and stage using the current source fingerprint',async()=>{
 const wrapper=render();await flushPromises();await button(wrapper,'编辑信息与阶段').trigger('click');await new DOMWrapper(document.body).get('.process-editor input[maxlength="120"]').setValue('手工过程标题');
 wrapper.findAllComponents(FormSelect).find(select=>select.props('options').some(option=>option.value==='followup'))!.vm.$emit('update:modelValue','followup');await wrapper.vm.$nextTick();await new DOMWrapper(document.body).get('.process-editor').trigger('submit');await flushPromises();
 const call=mocks.request.mock.calls.find(([,options])=>options?.method==='PATCH')!;expect(JSON.parse(call[1].body)).toMatchObject({fingerprint:'original',title:'手工过程标题',stages:[{ref:{kind:'report',id:'a'},stage:'followup'}]});
});
it('links records directly and follows the surviving process after a merge',async()=>{
 const wrapper=render();await flushPromises();await wrapper.get('[aria-label="补充记录"]').trigger('click');await new DOMWrapper(document.body).get('.quick-add-associate').trigger('click');await flushPromises();wrapper.getComponent(Picker).vm.$emit('update:modelValue',[{kind:'report',id:'c'}]);await wrapper.vm.$nextTick();mocks.request.mockResolvedValueOnce({...sample(),id:'merged',records:[...sample().records,{...sample().records[0],ref:{kind:'report',id:'c'}}]});await new DOMWrapper(document.body).get('.record-association-modal form').trigger('submit');await flushPromises();
 const call=mocks.request.mock.calls.find(([url,options])=>url==='health-processes/process/records'&&options?.method==='POST')!;expect(JSON.parse(call[1].body)).toMatchObject({records:[{kind:'report',id:'c'}],fingerprint:'original',editToken:'edit-original'});expect(mocks.replace).toHaveBeenCalledWith({path:'/health-processes/merged',query:{returnTo:'/health-processes'}});
});
it('viewer can read the same process without editing or model actions',async()=>{
 app.selectedMember.value.permission='viewer';const wrapper=render();await flushPromises();expect(wrapper.text()).toContain('合成健康历程');expect(wrapper.find('.process-tools').exists()).toBe(false);expect(wrapper.find('.process-record-management').exists()).toBe(false);
});
it('member switches discard old content and late replies',async()=>{
 const wrapper=render();await flushPromises();let resolve!:(value:unknown)=>void;mocks.request.mockReturnValueOnce(new Promise(done=>resolve=done));app.selectedMemberId.value='other';await flushPromises();expect(wrapper.text()).not.toContain('合成健康历程');resolve(sample());await flushPromises();expect(wrapper.text()).not.toContain('合成健康历程');expect(wrapper.get('[role="alert"]').text()).toContain('不属于当前成员');
});
it('a background refresh failure retains visible records and offers retry',async()=>{
 const wrapper=render();await flushPromises();const node=wrapper.get('.process-stages').element;mocks.request.mockRejectedValueOnce(Error('合成刷新失败'));app.dataVersion.value++;await flushPromises();expect(wrapper.get('.process-stages').element).toBe(node);expect(wrapper.get('[role="alert"]').text()).toContain('合成刷新失败');
});
it('AI organize immediately shows a spinner and blocks duplicate requests, then restores the button without a duplicate status line',async()=>{
 const ready={...sample(),aiState:'ready' as const};mocks.request.mockResolvedValue(ready);const wrapper=render();await flushPromises();let finish!:(value:HealthProcessDetail)=>void;mocks.request.mockReturnValueOnce(new Promise(done=>{finish=done;}));
 const action=button(wrapper,'AI 整理');await action.trigger('click');expect(action.text()).toBe('正在整理…');expect(action.attributes('aria-busy')).toBe('true');expect(action.find('.spin-icon').exists()).toBe(true);expect(wrapper.find('.process-ai-status').exists()).toBe(false);await action.trigger('click');
 expect(mocks.request.mock.calls.filter(([path,options])=>path.endsWith('/organize')&&options?.method==='POST')).toHaveLength(1);finish(ready);await flushPromises();expect(action.attributes('disabled')).toBeUndefined();expect(action.text()).toBe('AI 整理');expect(button(wrapper,'AI 整理').attributes('aria-busy')).toBe('false');expect(wrapper.find('.process-ai-status').exists()).toBe(false);
});
it('AI errors restore the action, retain the current timeline, and allow a retry',async()=>{
 const ready={...sample(),aiState:'ready' as const};mocks.request.mockResolvedValue(ready);const wrapper=render();await flushPromises();const timeline=wrapper.get('.process-stages').element;mocks.request.mockRejectedValueOnce(Error('合成整理失败'));await button(wrapper,'AI 整理').trigger('click');await flushPromises();
 expect(wrapper.get('[role="alert"]').text()).toContain('合成整理失败');expect(wrapper.get('.process-stages').element).toBe(timeline);expect(button(wrapper,'AI 整理').attributes('disabled')).toBeUndefined();await button(wrapper,'AI 整理').trigger('click');await flushPromises();expect(button(wrapper,'AI 整理').attributes('aria-busy')).toBe('false');expect(wrapper.find('.process-ai-status').exists()).toBe(false);
});
it('AI completion keeps an unresolved title and usable summary without extra status copy',async()=>{
 mocks.request.mockResolvedValue({...sample(),aiState:'ready'});const wrapper=render();await flushPromises();
 mocks.request.mockResolvedValueOnce({...sample(),aiState:'ready',title:'待命名健康历程'});await button(wrapper,'AI 整理').trigger('click');await flushPromises();
 expect(wrapper.get('.subpage-header h2').text()).toBe('待命名健康历程');expect(wrapper.find('.process-ai-status').exists()).toBe(false);
 expect(wrapper.text()).toContain('已记录的过程摘要');expect(wrapper.get('.process-meta').text()).toContain('2 条记录');expect(button(wrapper,'AI 整理').attributes('disabled')).toBeUndefined();
});
it('a late AI result cannot update a different member or leave an old running indicator',async()=>{
 mocks.request.mockResolvedValue({...sample(),aiState:'ready'});const wrapper=render();await flushPromises();let finish!:(value:HealthProcessDetail)=>void;mocks.request.mockReturnValueOnce(new Promise(done=>{finish=done;}));await button(wrapper,'AI 整理').trigger('click');app.selectedMemberId.value='other';await flushPromises();finish({...sample(),aiState:'ready'});await flushPromises();expect(wrapper.find('button[aria-busy=true]').exists()).toBe(false);expect(wrapper.find('.process-ai-status').exists()).toBe(false);
});
const removeButton=(wrapper:ReturnType<typeof mount>)=>wrapper.get('[aria-label="移出历程：合成检查"]');
const removal=(process:HealthProcessDetail|null=null)=>({memberId:'member',removed:{kind:'report',id:'a'},process});
it('manages each record once with category and date, without exposing link pairs or a repeated anchor',async()=>{
 const wrapper=render();await flushPromises();const management=wrapper.get('.process-record-management');
 expect(management.attributes('open')).toBeUndefined();expect(management.get('summary').text()).toBe('管理历程记录 2');expect(management.findAll('li')).toHaveLength(2);
 expect(management.findAll('strong').map(item=>item.text())).toEqual(['合成检查','合成用药']);expect(management.findAll('small').map(item=>item.text())).toEqual(['报告 · 2026-01-01','用药 · 2026-01-03']);expect(management.text()).not.toContain('解除关联');expect(wrapper.find('.process-link-management').exists()).toBe(false);
});
it('confirms one record and returns safely when only a single record would remain',async()=>{
 route.query={returnTo:'/events?category=report'};const wrapper=render();await flushPromises();await removeButton(wrapper).trigger('click');
 expect(mocks.ask.mock.calls[0][0].message).toContain('合成检查');expect(mocks.ask.mock.calls[0][0].message).not.toContain('合成用药');expect(mocks.ask.mock.calls[0][0].message).toContain('两条原始记录都会保留');
 mocks.request.mockResolvedValueOnce(removal());await mocks.ask.mock.calls[0][0].run();await flushPromises();
 const call=mocks.request.mock.calls.find(([url,options])=>url==='health-processes/process/records/remove'&&options?.method==='POST')!;expect(JSON.parse(call[1].body)).toMatchObject({record:{kind:'report',id:'a'},fingerprint:'original',editToken:'edit-original'});
 expect(mocks.replace).toHaveBeenCalledWith('/events?category=report');expect(wrapper.find('.process-stages').exists()).toBe(false);
});
it('updates the remaining collection without navigating away from its process',async()=>{
 const before=sample();before.records.push({...before.records[1],ref:{kind:'medication',id:'c'},title:'合成补充用药'});before.recordCount=3;mocks.request.mockResolvedValue(before);
 const wrapper=render();await flushPromises();await removeButton(wrapper).trigger('click');expect(mocks.ask.mock.calls[0][0].message).toContain('其余记录仍在当前历程中');
 const after={...before,records:before.records.slice(1),recordCount:2};mocks.request.mockResolvedValueOnce(removal(after)).mockResolvedValue(after);await mocks.ask.mock.calls[0][0].run();await flushPromises();
 expect(mocks.replace).not.toHaveBeenCalled();expect(wrapper.get('.process-record-management').findAll('strong').map(e=>e.text())).toEqual(['合成用药','合成补充用药']);expect(app.notifyDataChanged).toHaveBeenCalled();
});
it('failed removal keeps the timeline and retry key',async()=>{
 const wrapper=render();await flushPromises();const timeline=wrapper.get('.process-stages').element;
 await removeButton(wrapper).trigger('click');mocks.request.mockRejectedValueOnce(Error('合成移出失败'));await mocks.ask.mock.calls[0][0].run();await flushPromises();expect(wrapper.get('[role="alert"]').text()).toContain('合成移出失败');expect(wrapper.get('.process-stages').element).toBe(timeline);
 await removeButton(wrapper).trigger('click');mocks.request.mockResolvedValueOnce(removal());await mocks.ask.mock.calls.at(-1)![0].run();await flushPromises();
 const calls=mocks.request.mock.calls.filter(([,options])=>options?.method==='POST');expect(JSON.parse(calls[0][1].body).requestKey).toBe(JSON.parse(calls[1][1].body).requestKey);
});
it('removal is unavailable while editing and background refresh does not silently cancel confirmation',async()=>{
 const wrapper=render();await flushPromises();await button(wrapper,'编辑信息与阶段').trigger('click');expect(removeButton(wrapper).attributes('disabled')).toBeDefined();await new DOMWrapper(document.body).get('.process-editor .soft-action-button').trigger('click');await flushPromises();
 await removeButton(wrapper).trigger('click');app.dataVersion.value++;await flushPromises();mocks.request.mockResolvedValueOnce(removal());await mocks.ask.mock.calls.at(-1)![0].run();await flushPromises();
 expect(mocks.request.mock.calls.filter(([,options])=>options?.method==='POST')).toHaveLength(1);
});
it('member switching invalidates pending confirmation and late successful removals',async()=>{
 const wrapper=render();await flushPromises();await removeButton(wrapper).trigger('click');const confirm=mocks.ask.mock.calls[0][0];
 app.selectedMemberId.value='other';await flushPromises();await confirm.run();expect(mocks.request.mock.calls.filter(([,options])=>options?.method==='POST')).toHaveLength(0);
 app.selectedMemberId.value='member';await flushPromises();await removeButton(wrapper).trigger('click');let finish!:(value:unknown)=>void;mocks.request.mockReturnValueOnce(new Promise(done=>finish=done));const saving=mocks.ask.mock.calls.at(-1)![0].run();
 app.selectedMemberId.value='other';await flushPromises();finish(removal());await saving;await flushPromises();expect(mocks.replace).not.toHaveBeenCalled();expect(app.notifyDataChanged).not.toHaveBeenCalled();
});
it('rejects a foreign or inconsistent saved response instead of changing the visible process',async()=>{
 const wrapper=render();await flushPromises();await removeButton(wrapper).trigger('click');mocks.request.mockResolvedValueOnce({...removal(),memberId:'other'});await mocks.ask.mock.calls[0][0].run();await flushPromises();expect(wrapper.get('[role="alert"]').text()).toContain('移出结果无效');expect(mocks.replace).not.toHaveBeenCalled();expect(wrapper.find('.process-stages').exists()).toBe(true);
});
it('prevents duplicate removal submissions while saving',async()=>{
 const wrapper=render();await flushPromises();await removeButton(wrapper).trigger('click');let finish!:(value:unknown)=>void;mocks.request.mockReturnValueOnce(new Promise(done=>finish=done));const action=mocks.ask.mock.calls[0][0].run;const saving=action();await action();
 expect(mocks.request.mock.calls.filter(([,options])=>options?.method==='POST')).toHaveLength(1);expect(removeButton(wrapper).attributes('disabled')).toBeDefined();finish(removal());await saving;
});

const associationDialog=()=>new DOMWrapper(document.body).get('.record-association-modal');
const recordChoice=()=>({id:'report:c',resourceId:'c',kind:'report',memberId:'member',category:'report',title:'合成待关联报告',date:'2026-01-02',status:'ready',subtype:'laboratory',description:null,institution:null,documents:[],processIds:[]});
async function openAssociation(){
 const base=mocks.request.getMockImplementation()!;mocks.request.mockImplementation((path:string,options?:RequestInit)=>path.startsWith('health-records?')?Promise.resolve({items:[recordChoice()],nextCursor:null,hasMore:false}):base(path,options));
 const wrapper=render();await flushPromises();await wrapper.get('[aria-label="补充记录"]').trigger('click');await new DOMWrapper(document.body).get('.quick-add-associate').trigger('click');await flushPromises();return wrapper;
}
it('process linking uses the shared dialog, retains choices on failure and reuses the save key on retry',async()=>{
 const wrapper=await openAssociation();const timeline=wrapper.get('.process-stages').element;
 expect(wrapper.find('.health-record-picker').exists()).toBe(false);expect(associationDialog().get('h3').text()).toBe('添加记录');
 expect(associationDialog().get('.association-draft-hint').text()).toBe('选择要加入当前健康历程的记录。');
 await associationDialog().get('.record-picker-option input').setValue(true);mocks.request.mockRejectedValueOnce(Error('合成关联失败'));await associationDialog().get('form').trigger('submit');await flushPromises();
 expect(associationDialog().get('[role=alert]').text()).toContain('合成关联失败');expect((associationDialog().get('.record-picker-option input').element as HTMLInputElement).checked).toBe(true);expect(wrapper.get('.process-stages').element).toBe(timeline);
 let finish!:(value:unknown)=>void;mocks.request.mockReturnValueOnce(new Promise(done=>{finish=done;}));await associationDialog().get('form').trigger('submit');await associationDialog().get('form').trigger('submit');
 const writes=mocks.request.mock.calls.filter(([url,options])=>url==='health-processes/process/records'&&options?.method==='POST');expect(writes).toHaveLength(2);expect(JSON.parse(writes[0][1].body).requestKey).toBe(JSON.parse(writes[1][1].body).requestKey);
 finish({...sample(),recordCount:3,records:[...sample().records,{...sample().records[0],ref:{kind:'report',id:'c'}}]});await flushPromises();expect(document.querySelector('.record-association-modal')).toBeNull();expect(app.notifyDataChanged).toHaveBeenCalledOnce();
});
it('process association cancel and member changes never save or apply old selections',async()=>{
 const wrapper=await openAssociation();await associationDialog().findAll('button').find(button=>button.text()==='取消')!.trigger('click');await flushPromises();expect(document.querySelector('.record-association-modal')).toBeNull();expect(mocks.request.mock.calls.filter(([,options])=>options?.method)).toHaveLength(0);
 await wrapper.get('[aria-label="补充记录"]').trigger('click');await new DOMWrapper(document.body).get('.quick-add-associate').trigger('click');await flushPromises();await associationDialog().get('.record-picker-option input').setValue(true);
 let finish!:(value:unknown)=>void;mocks.request.mockReturnValueOnce(new Promise(done=>{finish=done;}));await associationDialog().get('form').trigger('submit');app.selectedMemberId.value='other';await flushPromises();expect(document.querySelector('.record-association-modal')).toBeNull();
 finish({...sample(),records:[...sample().records,{...sample().records[0],ref:{kind:'report',id:'c'}}]});await flushPromises();expect(app.notifyDataChanged).not.toHaveBeenCalled();expect(mocks.replace).not.toHaveBeenCalled();
});
it('a process association response missing selected records remains an error without closing the modal',async()=>{
 const wrapper=await openAssociation();await associationDialog().get('.record-picker-option input').setValue(true);mocks.request.mockResolvedValueOnce(sample());await associationDialog().get('form').trigger('submit');await flushPromises();
 expect(associationDialog().get('[role=alert]').text()).toContain('保存结果无效');expect(app.notifyDataChanged).not.toHaveBeenCalled();
});

it('process linking restores focus to the retained add button while the refreshed timeline is still loading',async()=>{
 const current=sample();const linked={...current,recordCount:3,records:[...current.records,{...current.records[0],ref:{kind:'report' as const,id:'c'}}]};let finish!:(value:unknown)=>void;let processReads=0;
 mocks.request.mockImplementation((path:string,options?:RequestInit)=>{
  if(path.startsWith('health-records?'))return Promise.resolve({items:[recordChoice()],nextCursor:null,hasMore:false});
  if(options?.method==='POST')return Promise.resolve(linked);
  if(++processReads===1)return Promise.resolve(current);
  return new Promise(done=>{finish=done;});
 });
 const wrapper=render(true);await flushPromises();const trigger=wrapper.get('[aria-label="补充记录"]');await trigger.trigger('click');await new DOMWrapper(document.body).get('.quick-add-associate').trigger('click');await flushPromises();
 await associationDialog().get('.record-picker-option input').setValue(true);await associationDialog().get('form').trigger('submit');await flushPromises();
 expect(document.querySelector('.record-association-modal')).toBeNull();expect(document.activeElement).toBe(trigger.element);expect(trigger.attributes('disabled')).toBeUndefined();finish(linked);await flushPromises();
});

it('trashes a process with an icon, preserves originals in the confirmation and returns to the source',async()=>{
 const wrapper=render();await flushPromises();const trigger=wrapper.get('button[aria-label="移入回收站"]');expect(trigger.text()).toBe('');
 await trigger.trigger('click');await flushPromises();const confirmation=mocks.ask.mock.calls.at(-1)![0];expect(confirmation.title).toBe('移入回收站');expect(confirmation.message).toContain('保留 30 天');expect(confirmation.message).toContain('记录及附件全部保留');
 mocks.request.mockResolvedValueOnce({id:'process',memberId:'member',status:'trashed'});await confirmation.run();await flushPromises();
 const deletion=mocks.request.mock.calls.find(([,options])=>options?.method==='DELETE')!;expect(deletion[0]).toBe('health-processes/process');expect(JSON.parse(deletion[1].body)).toMatchObject({fingerprint:'original',editToken:'edit-original',requestKey:expect.any(String)});
 expect(mocks.replace).toHaveBeenCalledWith('/health-processes');expect(app.notifyDataChanged).toHaveBeenCalled();
});
it('process trash failures keep the page and allow a retry; a member change invalidates pending confirmation',async()=>{
 const wrapper=render();await flushPromises();await wrapper.get('button[aria-label="移入回收站"]').trigger('click');await flushPromises();const confirmation=mocks.ask.mock.calls.at(-1)![0];
 mocks.request.mockRejectedValueOnce(Error('合成删除失败'));await confirmation.run();await flushPromises();expect(wrapper.get('[role=alert]').text()).toContain('合成删除失败');expect(wrapper.find('.process-stages').exists()).toBe(true);expect(mocks.replace).not.toHaveBeenCalled();
 await wrapper.get('button[aria-label="移入回收站"]').trigger('click');await flushPromises();const retry=mocks.ask.mock.calls.at(-1)![0];app.selectedMemberId.value='other';await flushPromises();const count=mocks.request.mock.calls.filter(([,options])=>options?.method==='DELETE').length;await retry.run();expect(mocks.request.mock.calls.filter(([,options])=>options?.method==='DELETE')).toHaveLength(count);
});
it('process trash is unavailable to viewers and disabled during editing',async()=>{
 app.selectedMember.value={id:'member',permission:'viewer'};const wrapper=render();await flushPromises();expect(wrapper.find('button[aria-label="移入回收站"]').exists()).toBe(false);
 app.selectedMember.value={id:'member',permission:'manager'};await flushPromises();await button(wrapper,'编辑信息与阶段').trigger('click');expect(wrapper.get('button[aria-label="移入回收站"]').attributes('disabled')).toBeDefined();
});

it('opens editing in an independent dialog, protects unsaved input and clears modal state on member change',async()=>{
 const wrapper=render(true);await flushPromises();const trigger=button(wrapper,'编辑信息与阶段');await trigger.trigger('click');await flushPromises();const dialog=new DOMWrapper(document.body).get('.process-editor-modal');
 expect(dialog.attributes()).toMatchObject({role:'dialog','aria-modal':'true','aria-label':'编辑健康历程'});expect(wrapper.find('.process-overview form').exists()).toBe(false);expect(document.body.style.overflow).toBe('hidden');expect(document.activeElement).toBe(dialog.get('input').element);
 await dialog.get('input').setValue('合成未保存修改');await dialog.get('[aria-label="关闭历程编辑"]').trigger('click');expect(mocks.ask).toHaveBeenCalled();expect(document.querySelector('.process-editor-modal')).not.toBeNull();
 app.selectedMemberId.value='other';await flushPromises();expect(document.querySelector('.process-editor-modal')).toBeNull();expect(document.body.style.overflow).toBe('');
});
it('restores opener focus on a clean cancel and keeps failed edits in the dialog',async()=>{
 const wrapper=render(true);await flushPromises();const trigger=button(wrapper,'编辑信息与阶段');await trigger.trigger('click');await flushPromises();await new DOMWrapper(document.body).get('[aria-label="关闭历程编辑"]').trigger('click');await flushPromises();expect(document.activeElement).toBe(trigger.element);
 await trigger.trigger('click');await new DOMWrapper(document.body).get('.process-editor input').setValue('合成保存失败草稿');mocks.request.mockRejectedValueOnce(Error('合成保存失败'));await new DOMWrapper(document.body).get('.process-editor').trigger('submit');await flushPromises();const dialog=new DOMWrapper(document.body).get('.process-editor-modal');expect(dialog.text()).toContain('合成保存失败');expect((dialog.get('input').element as HTMLInputElement).value).toBe('合成保存失败草稿');
 app.selectedMember.value.permission='viewer';await flushPromises();expect(document.querySelector('.process-editor-modal')).toBeNull();expect(document.body.style.overflow).toBe('');
});

it('rehydrates organization status from the server and polls pending work through completion after reopening',async()=>{
 vi.useFakeTimers();mocks.request.mockResolvedValue({...sample(),aiState:'pending'});const wrapper=render();await flushPromises();const timeline=wrapper.get('.process-stages').element;
 expect(button(wrapper,'正在整理…').attributes('disabled')).toBeDefined();expect(button(wrapper,'正在整理…').attributes('aria-busy')).toBe('true');expect(wrapper.find('.process-ai-status').exists()).toBe(false);
 mocks.request.mockResolvedValue({...sample(),aiState:'ready',title:'合成整理后事项',summary:'合成更新摘要'});await vi.advanceTimersByTimeAsync(3000);await flushPromises();
 expect(button(wrapper,'AI 整理').attributes('aria-busy')).toBe('false');expect(wrapper.find('.process-ai-status').exists()).toBe(false);expect(wrapper.text()).toContain('合成更新摘要');expect(wrapper.get('.process-stages').element).toBe(timeline);expect(button(wrapper,'AI 整理').attributes('disabled')).toBeUndefined();
});
it('a fresh page displays completed or failed server organization status without depending on a local click',async()=>{
 mocks.request.mockResolvedValue({...sample(),aiState:'ready'});const ready=render();await flushPromises();expect(button(ready,'AI 整理').attributes('aria-busy')).toBe('false');expect(ready.find('.process-ai-status').exists()).toBe(false);ready.unmount();
 mocks.request.mockResolvedValue({...sample(),aiState:'failed'});const failed=render();await flushPromises();expect(failed.find('.process-ai-status').exists()).toBe(false);expect(button(failed,'重试 AI 整理').attributes('disabled')).toBeUndefined();
});
it('refreshing an existing process disables the AI action without extra copy or replacing the timeline',async()=>{
 mocks.request.mockResolvedValue({...sample(),aiState:'ready'});const wrapper=render();await flushPromises();const timeline=wrapper.get('.process-stages').element;
 let finish!:(value:HealthProcessDetail)=>void;mocks.request.mockReturnValueOnce(new Promise(done=>finish=done));app.dataVersion.value++;await flushPromises();expect(button(wrapper,'AI 整理').attributes('disabled')).toBeDefined();expect(wrapper.find('.process-ai-status').exists()).toBe(false);expect(wrapper.get('.process-stages').element).toBe(timeline);
 finish({...sample(),aiState:'ready'});await flushPromises();expect(button(wrapper,'AI 整理').attributes('aria-busy')).toBe('false');expect(wrapper.find('.process-ai-status').exists()).toBe(false);expect(button(wrapper,'AI 整理').attributes('disabled')).toBeUndefined();
});
it('a failed request response resynchronizes with a still-running server task and keeps polling without duplicate submissions',async()=>{
 vi.useFakeTimers();mocks.request.mockResolvedValue({...sample(),aiState:'ready'});const wrapper=render();await flushPromises();
 mocks.request.mockRejectedValueOnce(Error('合成响应中断')).mockResolvedValueOnce({...sample(),aiState:'pending'});await button(wrapper,'AI 整理').trigger('click');await flushPromises();
 const action=button(wrapper,'正在整理…');expect(action.attributes('disabled')).toBeDefined();expect(button(wrapper,'正在整理…').attributes('aria-busy')).toBe('true');expect(wrapper.find('.process-ai-status').exists()).toBe(false);await action.trigger('click');expect(mocks.request.mock.calls.filter(([,options])=>options?.method==='POST')).toHaveLength(1);
 mocks.request.mockResolvedValue({...sample(),aiState:'ready'});await vi.advanceTimersByTimeAsync(3000);await flushPromises();expect(button(wrapper,'AI 整理').attributes('aria-busy')).toBe('false');expect(wrapper.find('.process-ai-status').exists()).toBe(false);expect(wrapper.find('.health-process-page > .inline-panel-error').exists()).toBe(false);
});

it('starts auxiliary modules beside the primary request and shows the timeline without waiting for them',async()=>{
 let primary!:(value:HealthProcessDetail)=>void,activity!:(value:unknown)=>void;
 mocks.request.mockImplementation((path:string)=>path==='health-processes/process'?new Promise(resolve=>{primary=resolve;}):path.includes('/activity?')?new Promise(resolve=>{activity=resolve;}):Promise.reject(Error('unexpected individual module read')));
 const wrapper=render();expect(mocks.request.mock.calls.map(([path])=>path)).toEqual(['health-processes/process',expect.stringContaining('health-processes/process/activity?')]);
 primary(sample());await flushPromises();expect(wrapper.find('.process-stages').exists()).toBe(true);expect(wrapper.get('.process-observations [role=status]').text()).toContain('正在读取');
 activity({processId:'process',memberId:'member',fingerprint:'original',observations:{data:{processId:'process',memberId:'member',items:[],total:0,counts:{symptom:0,temperature:0,intake:0},nextCursor:null}}});await flushPromises();
 expect(wrapper.find('.process-observations').exists()).toBe(false);expect(mocks.request).toHaveBeenCalledTimes(2);
});
