import { mount } from '@vue/test-utils';
import { expect,it } from 'vitest';
import HealthTimelineCard from '../src/components/HealthTimelineCard.vue';
import { healthCategoryImages } from '../src/utils/health-record-presentation';
import { healthCategoryLabels } from '../../shared/health-categories';
import { feedEntries,feedEntry } from './fixtures/health-feed';
const render=(entry:any)=>mount(HealthTimelineCard,{props:{entry},global:{stubs:{RouterLink:{props:['to'],template:'<a :href="to"><slot/></a>'}}}});
it('keeps the original filter in a vaccination detail link for desktop navigation',()=>{
 const wrapper=mount(HealthTimelineCard,{props:{entry:feedEntry('vaccination','vaccination'),returnTo:'/events?category=vaccination&subtype=administered'},global:{stubs:{RouterLink:{props:['to'],template:'<a :href="JSON.stringify(to)"><slot/></a>'}}}});
 expect(JSON.parse(wrapper.get('a').attributes('href')).query.returnTo).toBe('/events?category=vaccination&subtype=administered');wrapper.unmount();
});
it.each(feedEntries)('$category uses its public category, with detail labels separate',entry=>{const wrapper=render(entry);expect(wrapper.get('.health-timeline-type').text()).toBe(healthCategoryLabels[entry.category]);expect(wrapper.attributes('data-category')).toBe(entry.category);expect(wrapper.get('a').attributes('href')).toBe(`/events/detail/${entry.kind}/${entry.resourceId}`);expect(wrapper.get('.health-timeline-icon img').attributes('src')).toBe(healthCategoryImages[entry.category]);wrapper.unmount();});
it.each(['checkup','laboratory','pathology','functional','outpatient','inpatient','billing','other'])('document subtype %s remains a report, not a second event category',subtype=>{const wrapper=render({...feedEntry('report','report'),subtype});expect(wrapper.get('.health-timeline-type').text()).toBe('报告');expect(wrapper.find('.health-timeline-meta').exists()).toBe(true);wrapper.unmount();});
it('a report bundle keeps its institution and process link without a redundant document count',()=>{const wrapper=render({...feedEntry('report','report'),date:null,institution:'合成机构',documents:[{id:'one'},{id:'two'}],processIds:['process']});expect(wrapper.text()).not.toContain('2 份资料');expect(wrapper.get('.health-timeline-summary').text()).toBe('合成机构');expect(wrapper.find('.health-timeline-summary .health-timeline-meta').exists()).toBe(false);expect(wrapper.get('.health-timeline-date').text()).toContain('日期待确认');expect(wrapper.text()).toContain('关联 1 个健康历程');wrapper.unmount();});
it('unconfirmed prescription evidence does not imply active medication',()=>{const wrapper=render({...feedEntry('medication','medication_document'),confirmedCount:0,activeCount:0,medicationCount:2});expect(wrapper.text()).toContain('使用情况未确认');expect(wrapper.text()).not.toContain('正在使用');expect(wrapper.get('.health-timeline-type').text()).toBe('用药');wrapper.unmount();});
it('retains actual dose time and emits the exact clicked record',async()=>{const entry={...feedEntry('medication','intake'),date:'2026-01-02T08:20'};const wrapper=render(entry);expect(wrapper.text()).toContain('08:20');await wrapper.get('a').trigger('click');expect(wrapper.emitted('activate')?.[0][0]).toEqual(entry);wrapper.unmount();});
it('shows MM-DD and HH:mm on the card while retaining the full date for accessibility',()=>{
 const wrapper=render({...feedEntry('medication','intake'),date:'2026-09-20T20:09'});
 expect(wrapper.get('.health-timeline-date-main').text()).toBe('09-20');
 expect(wrapper.get('.health-timeline-date-detail').text()).toBe('20:09');
 expect(wrapper.get('.health-timeline-date').attributes('aria-label')).toBe('2026-09-20 20:09');
 wrapper.unmount();
});
it('selected state is independent of category and status',()=>{const wrapper=render({...feedEntry('medication','medication'),status:'paused'});wrapper.setProps({selected:true});expect(wrapper.get('.health-timeline-type').text()).toBe('用药');expect(wrapper.text()).toContain('已暂停');wrapper.unmount();});

it('a mixed report bundle lists the real source subtypes without implying a single examination',()=>{
 const wrapper=render({...feedEntry('report','report'),documents:[{id:'one',reportType:'checkup'},{id:'two',reportType:'laboratory'},{id:'three',reportType:'laboratory'}]});
 expect(wrapper.get('.health-timeline-heading .health-timeline-meta').text()).toBe('体检 · 检验');expect(wrapper.find('.health-timeline-summary').exists()).toBe(false);wrapper.unmount();
});
it('symptom and imaging cards do not repeat their category as a redundant subtype row',()=>{
 for(const category of ['symptom','imaging'] as const){const wrapper=render({...feedEntry(category,category==='symptom'?'symptom':'report'),subtype:category});expect(wrapper.find('.health-timeline-meta').exists()).toBe(false);wrapper.unmount();}
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
 ['symptom','symptom','resolved','已缓解','chip--green'],
 ['medication','medication','paused','已暂停','chip--plain'],
 ['medication','medication','stopped','已停用','chip--plain']
] as const)('%s %s status %s uses the shared status color without changing the record category',(category,kind,status,label,tone)=>{
 const wrapper=render({...feedEntry(category,kind),status});const badge=wrapper.get('.health-timeline-status');
 expect(badge.text()).toBe(label);expect(badge.classes()).toContain(tone);
 expect(wrapper.get('.health-timeline-type').text()).toBe(healthCategoryLabels[category]);wrapper.unmount();
});
