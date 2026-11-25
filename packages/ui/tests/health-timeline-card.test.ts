import { mount } from '@vue/test-utils';
import { expect,it,vi } from 'vitest';
import HealthTimelineCard from '../src/components/HealthTimelineCard.vue';
import { healthCategoryImages } from '../src/utils/health-record-presentation';
import { healthCategoryLabels } from '../../shared/health-categories';
import { feedEntries,feedEntry } from './fixtures/health-feed';
const render=(entry:any)=>mount(HealthTimelineCard,{props:{entry},global:{stubs:{RouterLink:{props:['to'],template:'<a :href="to"><slot/></a>'}}}});
it.each([['high','高度重复'],['possible','疑似重复']] as const)('shows the saved %s duplicate tier without replacing processing status',async(level,label)=>{
 const wrapper=render({...feedEntry('report','report'),status:'needs_review',duplicateHint:level});
 expect(wrapper.get('.health-timeline-duplicate').text()).toBe(label);
 expect(wrapper.get('.health-timeline-status').text()).toBe('待确认');
 expect(wrapper.get('a').attributes('href')).toContain('/events/detail/report/');
 await wrapper.setProps({entry:feedEntry('report','report')});
 expect(wrapper.find('.health-timeline-duplicate').exists()).toBe(false);wrapper.unmount();
});
it('keeps the original filter in a vaccination detail link for desktop navigation',()=>{
 const wrapper=mount(HealthTimelineCard,{props:{entry:feedEntry('vaccination','vaccination'),returnTo:'/events?category=vaccination&subtype=administered'},global:{stubs:{RouterLink:{props:['to'],template:'<a :href="JSON.stringify(to)"><slot/></a>'}}}});
 expect(JSON.parse(wrapper.get('a').attributes('href')).query.returnTo).toBe('/events?category=vaccination&subtype=administered');wrapper.unmount();
});
it.each(feedEntries)('$category uses its public category, with detail labels separate',entry=>{const wrapper=render(entry);expect(wrapper.get('.health-timeline-type').text()).toBe(healthCategoryLabels[entry.category]);expect(wrapper.attributes('data-category')).toBe(entry.category);expect(wrapper.get('a').attributes('href')).toBe(`/events/detail/${entry.kind}/${entry.resourceId}`);expect(wrapper.get('.health-timeline-icon img').attributes('src')).toBe(healthCategoryImages[entry.category]);wrapper.unmount();});
it.each(['checkup','laboratory','pathology','functional','outpatient','inpatient','billing','other'])('document subtype %s remains a report, not a second event category',subtype=>{const wrapper=render({...feedEntry('report','report'),subtype});expect(wrapper.get('.health-timeline-type').text()).toBe('报告');expect(wrapper.find('.health-timeline-meta').exists()).toBe(true);wrapper.unmount();});
it('a report bundle keeps its institution and process link without a redundant document count',()=>{const wrapper=render({...feedEntry('report','report'),date:null,institution:'合成机构',documents:[{id:'one'},{id:'two'}],processIds:['process']});expect(wrapper.text()).not.toContain('2 份资料');expect(wrapper.get('.health-timeline-summary').text()).toBe('合成机构');expect(wrapper.find('.health-timeline-summary .health-timeline-meta').exists()).toBe(false);expect(wrapper.get('.health-timeline-date').text()).toContain('日期待确认');expect(wrapper.text()).toContain('关联 1 个健康历程');wrapper.unmount();});
it('unconfirmed prescription evidence does not imply active medication',()=>{const wrapper=render({...feedEntry('medication','medication_document'),confirmedCount:0,activeCount:0,medicationCount:2});expect(wrapper.text()).toContain('使用情况未确认');expect(wrapper.text()).not.toContain('正在使用');expect(wrapper.get('.health-timeline-type').text()).toBe('用药');wrapper.unmount();});
it('retains actual dose time and emits the exact clicked record',async()=>{const entry={...feedEntry('medication','intake'),date:'2026-01-02T08:20'};const wrapper=render(entry);expect(wrapper.text()).toContain('08:20');await wrapper.get('a').trigger('click');expect(wrapper.emitted('activate')?.[0][0]).toEqual(entry);wrapper.unmount();});
it('symptom cards show the place, severity, and a clock time when the record has one',()=>{
 const wrapper=render({...feedEntry('symptom','symptom'),status:'active',date:'2026-11-21T10:17',description:'头部 · 程度 4/10'});
 expect(wrapper.get('.health-timeline-status').text()).toBe('持续跟踪');
 expect(wrapper.get('.health-timeline-description').text()).toBe('头部 · 程度 4/10');
 expect(wrapper.get('.health-timeline-date-main').text()).toBe('11-21');
 expect(wrapper.get('.health-timeline-date-detail').text()).toBe('10:17');
 wrapper.unmount();
});
it('shows MM-DD and HH:mm on the card while retaining the full date for accessibility',()=>{
 const wrapper=render({...feedEntry('medication','intake'),date:'2026-09-20T20:09'});
 expect(wrapper.get('.health-timeline-date-main').text()).toBe('09-20');
 expect(wrapper.get('.health-timeline-date-detail').text()).toBe('20:09');
 expect(wrapper.get('.health-timeline-date').attributes('aria-label')).toBe('2026-09-20 20:09');
 wrapper.unmount();
});
it('uses the record card date format in upload previews and retains the full accessible date',async()=>{
 const wrapper=render({...feedEntry('report','report'),date:'2020-01-02'});
 await wrapper.setProps({dateLabel:'报告日期'});
 expect(wrapper.get('.health-timeline-date-main').text()).toBe('01-02');
 expect(wrapper.get('.health-timeline-date').attributes('aria-label')).toBe('报告日期：2020-01-02');
 expect(wrapper.get('.health-timeline-heading .health-timeline-date').exists()).toBe(true);
 await wrapper.setProps({entry:{...feedEntry('report','report'),date:'2020-01-02T08:20'}});
 expect(wrapper.get('.health-timeline-date-main').text()).toBe('01-02');
 expect(wrapper.get('.health-timeline-date-detail').text()).toBe('08:20');
 expect(wrapper.get('.health-timeline-date').attributes('aria-label')).toBe('报告日期：2020-01-02 08:20');
 await wrapper.setProps({entry:{...feedEntry('report','report'),date:null}});
 expect(wrapper.get('.health-timeline-date-main').text()).toBe('待确认');
 wrapper.unmount();
});
it.each([
 ['today',new Date(2026,9,26,14,32),'今天 14:32'],
 ['yesterday',new Date(2026,9,25,9,15),'昨天 09:15'],
 ['older',new Date(2025,11,31,8,5),'2025-12-31 08:05']
] as const)('shows %s upload time separately from the historical report date',async(_name,uploaded,expected)=>{
 vi.useFakeTimers();vi.setSystemTime(new Date(2026,9,26,16));
 const wrapper=render({...feedEntry('report','report'),date:'2020-01-02',uploadedAt:uploaded.toISOString()});
 try{
  await wrapper.setProps({dateLabel:'报告日期'});
  const time=wrapper.get('.health-timeline-upload-time');
  expect(time.text()).toBe(`上传时间：${expected}`);
  expect(time.attributes('datetime')).toBe(uploaded.toISOString());
  expect(time.attributes('title')).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  expect(wrapper.get('.health-timeline-date-main').text()).toBe('01-02');
  expect(wrapper.get('.health-timeline-date').attributes('aria-label')).toBe('报告日期：2020-01-02');
  expect(wrapper.find('.health-timeline-heading .health-timeline-upload-time').exists()).toBe(false);
  expect(wrapper.get('.health-timeline-copy > .health-timeline-upload-time').element).toBe(time.element);
  expect(wrapper.get('.health-timeline-copy').element.lastElementChild).toBe(time.element);
 }finally{wrapper.unmount();vi.useRealTimers();}
});
it('recognizes yesterday across a year boundary using the viewer calendar',async()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date(2026,0,1,0,10));
 const wrapper=render({...feedEntry('report','report'),uploadedAt:new Date(2025,11,31,23,55).toISOString()});
 try{
  await wrapper.setProps({dateLabel:'报告日期'});
  expect(wrapper.get('.health-timeline-upload-time').text()).toBe('上传时间：昨天 23:55');
 }finally{wrapper.unmount();vi.useRealTimers();}
});
it('omits missing or invalid upload times and leaves timeline cards unchanged',async()=>{
 const wrapper=render({...feedEntry('report','report'),uploadedAt:'2026-01-02T08:00:00Z'});
 expect(wrapper.find('.health-timeline-upload-time').exists()).toBe(false);
 await wrapper.setProps({dateLabel:'报告日期',entry:{...feedEntry('report','report'),uploadedAt:'invalid'}});
 expect(wrapper.find('.health-timeline-upload-time').exists()).toBe(false);
 await wrapper.setProps({entry:feedEntry('report','report')});
 expect(wrapper.find('.health-timeline-upload-time').exists()).toBe(false);
 wrapper.unmount();
});
it('selected state is independent of category and status',()=>{const wrapper=render({...feedEntry('medication','medication'),status:'paused'});wrapper.setProps({selected:true});expect(wrapper.get('.health-timeline-type').text()).toBe('用药');expect(wrapper.text()).toContain('已暂停');wrapper.unmount();});

it('a mixed report bundle lists the real source subtypes without implying a single examination',()=>{
 const wrapper=render({...feedEntry('report','report'),documents:[{id:'one',reportType:'checkup'},{id:'two',reportType:'laboratory'},{id:'three',reportType:'laboratory'}]});
 expect(wrapper.get('.health-timeline-heading .health-timeline-meta').text()).toBe('体检 · 检验');expect(wrapper.find('.health-timeline-summary').exists()).toBe(false);wrapper.unmount();
});
it('symptom, imaging and monitoring cards do not repeat their category as a redundant subtype row',()=>{
 for(const [category,kind,subtype] of [['symptom','symptom','symptom'],['imaging','report','imaging'],['monitoring','measurement','manual']] as const){
  const wrapper=render({...feedEntry(category,kind),subtype});
  expect(wrapper.get('.health-timeline-type').text()).toBe(healthCategoryLabels[category]);
  expect(wrapper.find('.health-timeline-meta').exists()).toBe(false);
  wrapper.unmount();
 }
});
it('monitoring cards keep the public type and show readings instead of a processing status chip',()=>{
 const wrapper=render({...feedEntry('monitoring','measurement'),title:'血压',subtype:'device',status:'device',institution:'设备',description:'128/82 mmHg',metrics:[{label:'血压',value:'128/82',unit:'mmHg'},{label:'脉搏',value:'72',unit:'次/分'}]});
 expect(wrapper.get('.health-timeline-type').text()).toBe('监测');
 expect(wrapper.attributes('data-category')).toBe('monitoring');
 expect(wrapper.find('.health-timeline-status').exists()).toBe(false);
 expect(wrapper.find('.health-timeline-title').exists()).toBe(false);
 expect(wrapper.get('.health-timeline-meta').text()).toBe('血压');
 expect(wrapper.get('.health-timeline-channel').text()).toBe('设备');
 expect(wrapper.find('.health-timeline-summary').exists()).toBe(false);
 expect(wrapper.findAll('.health-timeline-metric').map(item=>item.text())).toEqual(['128/82血压 · mmHg','72脉搏 · 次/分']);
 expect(wrapper.get('a').attributes('href')).toContain('/events/detail/measurement/');
 wrapper.unmount();
});
it('monitoring cards keep a device name when the source is not just the channel',()=>{
 const wrapper=render({...feedEntry('monitoring','measurement'),title:'血压',institution:'合成设备',metrics:[{label:'血压',value:'120/80',unit:'mmHg'}]});
 expect(wrapper.get('.health-timeline-summary').text()).toBe('合成设备');
 expect(wrapper.find('.health-timeline-channel').exists()).toBe(false);
 wrapper.unmount();
});

it.each([['medication','course'],['intake','intake']] as const)('labels %s as a medication record without hiding the detail route', (kind,subtype)=>{
 const wrapper=render({...feedEntry('medication',kind),subtype,intakeCount:kind==='medication'?2:undefined});
 expect(wrapper.get('.health-timeline-meta').text()).toBe('用药记录');expect(wrapper.text()).not.toContain('用药过程');expect(wrapper.text()).not.toContain('实际服药');
 if(kind==='medication')expect(wrapper.text()).toContain('2 次服用补充');
 expect(wrapper.get('a').attributes('href')).toContain(`/events/detail/${kind}/`);wrapper.unmount();
});

it('keeps a recorded vaccination compact without exposing the internal administered label',()=>{
 const wrapper=render({...feedEntry('vaccination','vaccination'),title:'合成疫苗',doseNumber:'2',note:'合成备注',institution:'合成接种点',description:'2 · 合成备注',documents:[{id:'proof'}]});
 expect(wrapper.get('.health-timeline-heading .health-timeline-status').text()).toBe('已接种');
 expect(wrapper.find('.health-timeline-meta').exists()).toBe(false);expect(wrapper.text()).not.toContain('实际接种');
 expect(wrapper.get('.health-timeline-title-text').text()).toBe('合成疫苗');expect(wrapper.get('.health-timeline-labels .health-timeline-dose').text()).toBe('第 2 剂');expect(wrapper.find('.health-timeline-title .health-timeline-dose').exists()).toBe(false);
 expect(wrapper.get('.health-timeline-summary').text()).toContain('合成接种点');expect(wrapper.get('.health-timeline-note').text()).toBe('合成备注');
 expect(wrapper.find('.health-timeline-description').exists()).toBe(false);expect(wrapper.find('.health-timeline-footer').exists()).toBe(false);
 wrapper.unmount();
});
it.each(['加强针','第 3 剂'])('preserves the recorded dose wording %s and omits absent supporting rows',doseNumber=>{
 const wrapper=render({...feedEntry('vaccination','vaccination'),doseNumber});expect(wrapper.get('.health-timeline-dose').text()).toBe(doseNumber);
 expect(wrapper.find('.health-timeline-summary').exists()).toBe(false);expect(wrapper.find('.health-timeline-description').exists()).toBe(false);wrapper.unmount();
});
it('an uploaded vaccination credential does not imply that vaccination has been registered',()=>{
 const wrapper=render({...feedEntry('vaccination','report'),subtype:'vaccination',status:'needs_review',documents:[{id:'proof'}]});
 expect(wrapper.find('.health-timeline-meta').exists()).toBe(false);expect(wrapper.get('.health-timeline-status').text()).toBe('待完善');
 expect(wrapper.text()).not.toContain('已接种');expect(wrapper.find('.health-timeline-footer').exists()).toBe(false);expect(wrapper.find('.health-timeline-dose').exists()).toBe(false);wrapper.unmount();
});

it('does not invent a dose when none was recorded',()=>{
 const wrapper=render(feedEntry('vaccination','vaccination'));expect(wrapper.find('.health-timeline-dose').exists()).toBe(false);
 expect(wrapper.get('.health-timeline-labels').text()).toBe('已接种');wrapper.unmount();
});

it.each([
 ['report','report','ready','已归档','chip--green'],
 ['imaging','report','ready','已归档','chip--green'],
 ['medication','medication_document','ready','已归档','chip--green'],
 ['vaccination','report','ready','待完善','chip--amber'],
 ['report','report','needs_review','待确认','chip--amber'],
 ['report','report','queued','排队中','chip--info'],
 ['report','report','uploading','上传中','chip--info'],
 ['report','report','processing','处理中','chip--info'],
 ['report','report','failed','识别失败','chip--red'],
 ['symptom','symptom','unknown','状态未知','chip--plain'],
 ['symptom','symptom','active','持续跟踪','chip--green'],
 ['symptom','symptom','resolved','已消失','chip--green'],
 ['medication','medication','paused','已暂停','chip--plain'],
 ['medication','medication','stopped','已停止','chip--plain']
] as const)('%s %s status %s uses the shared status color without changing the record category',(category,kind,status,label,tone)=>{
 const wrapper=render({...feedEntry(category,kind),status});const badge=wrapper.get('.health-timeline-status');
 expect(badge.text()).toBe(label);expect(badge.classes()).toContain(tone);
 expect(wrapper.get('.health-timeline-type').text()).toBe(healthCategoryLabels[category]);wrapper.unmount();
});


it.each(['ready','needs_review'])('shows a confirmed historical vaccination original as vaccinated when its document is %s',status=>{
 const wrapper=render({...feedEntry('vaccination','report'),subtype:'vaccination',status,confirmedCount:1});
 expect(wrapper.get('.health-timeline-status').text()).toBe('已接种');expect(wrapper.get('.health-timeline-status').classes()).toContain('chip--green');
 expect(wrapper.get('a').attributes('href')).toContain('/events/detail/report/');wrapper.unmount();
});
it.each([['queued','排队中'],['processing','处理中'],['failed','识别失败']])('keeps the original %s state visible despite an existing registration',(status,label)=>{
 const wrapper=render({...feedEntry('vaccination','report'),status,confirmedCount:1});
 expect(wrapper.get('.health-timeline-status').text()).toBe(label);wrapper.unmount();
});
it('an original without an active registration remains incomplete',()=>{
 const wrapper=render({...feedEntry('vaccination','report'),status:'ready',confirmedCount:0});
 expect(wrapper.get('.health-timeline-status').text()).toBe('待完善');wrapper.unmount();
});


it('shows an ultrasound document under reports with its ultrasound subtype',()=>{
 const wrapper=render({...feedEntry('report','report'),subtype:'ultrasound',status:'ready',documents:[{id:'u',reportType:'ultrasound'}]});
 expect(wrapper.get('.health-timeline-type').text()).toBe('报告');expect(wrapper.get('.health-timeline-meta').text()).toBe('超声检查');expect(wrapper.get('a').attributes('href')).toContain('/events/detail/report/');wrapper.unmount();
});
