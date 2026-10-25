import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DOMWrapper, flushPromises, mount } from '@vue/test-utils';
import { defineComponent, ref } from 'vue';
import FormSuggest from '../src/components/FormSuggest.vue';
import { medicationFrequencyOptions } from '../src/utils/record-form-options';

const wrappers: ReturnType<typeof mount>[] = [];
beforeEach(() => { vi.stubGlobal('matchMedia', () => ({ matches: false })); });
afterEach(() => { wrappers.splice(0).forEach(wrapper => wrapper.unmount()); vi.unstubAllGlobals(); });
function render(value = '') {
  const Host = defineComponent({ components: { FormSuggest }, props: { disabled: Boolean }, setup: () => ({ value: ref(value), options: medicationFrequencyOptions }),
    template: '<FormSuggest v-model="value" :options="options" :disabled="disabled" name="frequency" maxlength="200" label="用药频次" />' });
  const wrapper = mount(Host, { attachTo: document.body }); wrappers.push(wrapper); return wrapper;
}
function menu() { return new DOMWrapper(document.querySelector('.form-select-panel')!); }

it('keeps custom imported text unchanged, while supporting preset selection, direct editing and clearing', async () => {
  const wrapper = render('合成特殊频次 / bid');
  expect(wrapper.get('input').element.value).toBe('合成特殊频次 / bid');
  await wrapper.get('button').trigger('click'); await flushPromises();
  await menu().trigger('keydown', { key: 'Escape' }); await flushPromises();
  expect(wrapper.get('input').element.value).toBe('合成特殊频次 / bid');
  await wrapper.get('button').trigger('click'); await flushPromises();
  await menu().findAll('[role=option]').find(option => option.text() === '每日两次')!.trigger('click');
  expect(wrapper.get('input').element.value).toBe('每日两次');
  await wrapper.get('input').setValue('合成自定义频次');
  expect(wrapper.getComponent(FormSuggest).props('modelValue')).toBe('合成自定义频次');
  await wrapper.get('button').trigger('click'); await flushPromises();
  await menu().get('[role=option]').trigger('click');
  expect(wrapper.get('input').element.value).toBe('');
});

it('offers keyboard navigation and restores focus without submitting the surrounding form', async () => {
  const wrapper = render();
  await wrapper.get('input').trigger('keydown', { key: 'ArrowDown' }); await flushPromises();
  expect(document.activeElement?.textContent).toBe('不填写');
  await menu().trigger('keydown', { key: 'ArrowDown' });
  expect(document.activeElement?.textContent).toBe('每日一次');
  (document.activeElement as HTMLButtonElement).click(); await flushPromises();
  expect(wrapper.get('input').element.value).toBe('每日一次');
  expect(document.activeElement).toBe(wrapper.get('button').element);
  expect(document.querySelector('.form-select-layer')).toBeNull();
});

it('does not invent a default and closes an open picker when saving disables the field', async () => {
  const wrapper = render();
  expect(wrapper.get('input').element.value).toBe('');
  await wrapper.get('button').trigger('click'); await flushPromises();
  await wrapper.setProps({ disabled: true }); await flushPromises();
  expect(document.querySelector('.form-select-layer')).toBeNull();
  expect(wrapper.get('input').attributes('disabled')).toBeDefined();
  expect(wrapper.get('button').attributes('disabled')).toBeDefined();
});
