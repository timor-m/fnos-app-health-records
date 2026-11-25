import { afterEach, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import ReportOriginalText from '../src/components/ReportOriginalText.vue';
afterEach(()=>{document.body.innerHTML='';});
it('shows short original text in full without an expansion control',()=>{
 const wrapper=mount(ReportOriginalText,{props:{label:'结论',text:'合成原文。',manual:true}});
 try {expect(wrapper.get('p').text()).toBe('合成原文。');expect(wrapper.find('button').exists()).toBe(false);expect(wrapper.text()).toContain('人工校对');}
 finally {wrapper.unmount();}
});
it('previews long multi-section text and opens every source paragraph in a scrollable dialog',async()=>{
 const text=Array.from({length:100},(_,i)=>`【第 ${i+1} 页 · 科室小结】\n${'合成完整原文。'.repeat(25)}`).join('\n\n');
 const wrapper=mount(ReportOriginalText,{props:{label:'原报告概述',text},attachTo:document.body});
 try {
  expect(wrapper.get('p').text().length).toBeLessThan(365);
  (wrapper.get('button').element as HTMLButtonElement).focus();
  await wrapper.get('button').trigger('click');await nextTick();
  const dialog=document.querySelector('[role="dialog"]')!;
  expect(dialog.getAttribute('aria-label')).toBe('原报告概述全文');
  expect(dialog.querySelectorAll('.original-text-section')).toHaveLength(100);
  expect(Array.from(dialog.querySelectorAll('p')).map(p=>p.textContent)).toEqual(Array.from({length:100},()=> '合成完整原文。'.repeat(25)+'\n\n').map((line,i)=>i===99?line.trimEnd():line));
  expect(document.activeElement).toBe(dialog.querySelector('button'));
  expect(document.body.style.overflow).toBe('hidden');
  dialog.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',shiftKey:true,bubbles:true}));
  expect(document.activeElement).toBe(dialog.querySelector('.original-text-body'));
  dialog.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',bubbles:true}));
  expect(document.activeElement).toBe(dialog.querySelector('button'));
  dialog.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await nextTick();
  expect(document.querySelector('[role="dialog"]')).toBeNull();expect(document.body.style.overflow).toBe('');
  expect(document.activeElement).toBe(wrapper.get('button').element);
 }finally{wrapper.unmount();}
});
it('collapses many short lines and closes stale full text when reports change',async()=>{
 const wrapper=mount(ReportOriginalText,{props:{label:'医生建议',text:Array.from({length:12},(_,i)=>`条目 ${i}`).join('\n')},attachTo:document.body});
 try {
  await wrapper.get('button').trigger('click');expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  await wrapper.setProps({text:'新的短原文'});expect(document.querySelector('[role="dialog"]')).toBeNull();expect(wrapper.find('button').exists()).toBe(false);
 }finally{wrapper.unmount();}
});

it('displays the source problem above each recommendation in preview and full text',async()=>{
 const text='【第 1 页 · 医师建议】\n对应问题：1、合成问题甲。\n\n建议甲全文。\n\n【第 1 页 · 医师建议】\n对应问题：2、合成问题乙。\n\n'+'建议乙完整原文。'.repeat(80);
 const wrapper=mount(ReportOriginalText,{props:{label:'医生建议',text},attachTo:document.body});
 try {
  expect(wrapper.get('h4').text()).toBe('对应问题：1、合成问题甲。');
  await wrapper.get('button').trigger('click');await nextTick();
  const dialog=document.querySelector('[role="dialog"]')!;
  expect(Array.from(dialog.querySelectorAll('h4')).map(el=>el.textContent)).toEqual(['对应问题：1、合成问题甲。','对应问题：2、合成问题乙。']);
  expect(dialog.querySelectorAll('p')[1].textContent).toBe('建议乙完整原文。'.repeat(80));
 }finally{wrapper.unmount();}
});

it.each(['原报告概述','结论','检查所见','医生建议'])('groups %s by source examination or department in preview and full text',async label=>{
 const text='【第 1 页 · 呼吸内科 · 小结】\n甲科完整原文。\n\n【第 2 页 · 胸部CT · 结论】\n'+'乙检查原文。'.repeat(100);
 const wrapper=mount(ReportOriginalText,{props:{label,text},attachTo:document.body});
 try {
  expect(wrapper.get('.original-text-context').text()).toBe('呼吸内科');
  await wrapper.get('button').trigger('click');await nextTick();
  const dialog=document.querySelector('[role="dialog"]')!;
  expect(Array.from(dialog.querySelectorAll('.original-text-context')).map(el=>el.textContent)).toEqual(['呼吸内科','胸部CT']);
  expect(Array.from(dialog.querySelectorAll('.original-text-source')).map(el=>el.textContent)).toEqual(['第 1 页','第 2 页']);
  expect(dialog.querySelectorAll('p')[1].textContent).toBe('乙检查原文。'.repeat(100));
 }finally{wrapper.unmount();}
});
it('labels unscoped source sections as uncertain and retains legacy plain text without inventing a project',()=>{
 const wrapper=mount(ReportOriginalText,{props:{label:'结论',text:'【第 1 页 · 结论】\n完整原文。'}});
 try {
  expect(wrapper.get('h4').text()).toBe('项目或科室待确认');
  expect(wrapper.get('p').text()).toBe('完整原文。');
 }finally{wrapper.unmount();}
});
