import { afterEach, describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import Picker from '../src/components/DateTimePicker.vue';
let wrapper: ReturnType<typeof mount>;
afterEach(() => wrapper?.unmount());
function render(props = {}) { wrapper = mount(Picker, { attachTo: document.body, props: { modelValue: '2026-10-12', ...props } }); return wrapper.get('input'); }
describe('date text input', () => {
 it('keeps typing separate from selection and commits normalized dates on blur', async () => {
  const input = render(); await input.setValue('2024/2/29');
  expect(wrapper.emitted('update:modelValue')).toBeUndefined();
  expect(document.querySelector('[role=dialog]')).toBeNull();
  await input.trigger('blur'); expect(wrapper.emitted('update:modelValue')).toEqual([['2024-02-29']]);
 });
 it.each(['2025-02-29','2026-04-31','2026-13-01','1899-12-31','2026-10'])('rejects invalid date %s without overwriting the saved value', async value => {
  const input = render(); await input.setValue(value); await input.trigger('blur');
  expect(wrapper.emitted('update:modelValue')).toBeUndefined();
  expect(input.element.validity.valid).toBe(false); expect(document.querySelector('[role=tooltip]')).not.toBeNull();
 });
 it('supports time entry, enter to commit, and clearing', async () => {
  const input = render({ showTime: true }); await input.setValue('2026-10-12 23:59'); await input.trigger('keydown', { key: 'Enter' });
  expect(wrapper.emitted('update:modelValue')?.[0]).toEqual(['2026-10-12T23:59']);
  await input.setValue('2026-10-12 24:00'); await input.trigger('blur'); expect(input.element.validity.valid).toBe(false);
  await input.setValue(''); await input.trigger('blur'); expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual([null]);
 });
 it('can correct invalid text using the existing picker', async () => {
  const input = render(); await input.setValue('2026-13-01'); await input.trigger('blur');
  await wrapper.get('.datetime-picker-trigger').trigger('click'); await nextTick();
  document.querySelector<HTMLButtonElement>('.datetime-picker-confirm')!.click(); await nextTick();
  expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual(['2026-10-12']);
  expect(input.element.value).toBe('2026-10-12'); expect(input.element.validity.valid).toBe(true);
 });
 it('rejects letters, Chinese, and mixed pasted edits without changing the previous date', async () => {
  const input = render();
  for (const value of ['abc', '中文', '2026-10-12备注', '2026-10-12 12:30']) {
   await input.setValue(value); expect(input.element.value).toBe('2026-10-12');
  }
  expect(wrapper.emitted('update:modelValue')).toBeUndefined();
  const event = new InputEvent('beforeinput', {data:'a', cancelable:true});
  input.element.dispatchEvent(event); expect(event.defaultPrevented).toBe(true);
 });
 it('rejects Chinese input after composition and preserves valid time punctuation', async () => {
  const input = render({showTime:true, modelValue:'2026-10-12T12:30'});
  await input.trigger('compositionstart');
  input.element.value='2026-10-12 12:30中文'; await input.trigger('input', {isComposing:true});
  await input.trigger('compositionend'); expect(input.element.value).toBe('2026-10-12 12:30');
  await input.setValue('2026/10/12 09:05'); await input.trigger('blur');
  expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual(['2026-10-12T09:05']);
 });
 it('shows a floating error, dismisses it with Escape and removes it after correction', async () => {
  const input = render(); await input.setValue('2026-13-01'); await input.trigger('blur');
  const tooltip = document.querySelector('[role=tooltip]')!;
  expect(input.attributes('aria-describedby')).toBe(tooltip.id);
  expect(wrapper.find('[role=tooltip]').exists()).toBe(false);
  await input.trigger('keydown', {key:'Escape'}); expect(document.querySelector('[role=tooltip]')).toBeNull();
  await input.trigger('focus'); expect(document.querySelector('[role=tooltip]')).not.toBeNull();
  await input.setValue('2026-12-01'); expect(document.querySelector('[role=tooltip]')).toBeNull();
 });
 it('names a date-only picker as a date and a timed picker as date and time', async () => {
  render();
  expect(wrapper.get('.datetime-picker-trigger').attributes('aria-label')).toBe('选择日期');
  await wrapper.get('.datetime-picker-trigger').trigger('click'); await nextTick();
  expect(document.querySelector('.datetime-picker-title')?.textContent).toBe('请选择日期');
  expect(document.querySelector('.datetime-picker-panel')?.getAttribute('aria-label')).toBe('请选择日期');
  document.querySelector<HTMLButtonElement>('.datetime-picker-cancel')!.click(); await nextTick();
  wrapper.unmount();
  render({showTime:true, modelValue:'2026-10-12T08:30'});
  expect(wrapper.get('.datetime-picker-trigger').attributes('aria-label')).toBe('选择日期和时间');
  await wrapper.get('.datetime-picker-trigger').trigger('click'); await nextTick();
  expect(document.querySelector('.datetime-picker-title')?.textContent).toBe('请选择时间');
 });
 it('updates external values and disables both controls', async () => {
  const input = render(); await wrapper.setProps({modelValue:'2024-01-02'}); expect(input.element.value).toBe('2024-01-02');
  await wrapper.setProps({disabled:true}); expect(input.attributes('disabled')).toBeDefined(); expect(wrapper.get('button').attributes('disabled')).toBeDefined();
 });
});
