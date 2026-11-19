import { afterEach, expect, it } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import Picker from '../src/components/SymptomSeverityPicker.vue';

const wrappers: ReturnType<typeof mount>[] = [];
afterEach(() => wrappers.splice(0).forEach(wrapper => wrapper.unmount()));
function render(value = '', disabled = false) {
  const wrapper = mount(Picker, { attachTo: document.body, props: { modelValue: value, disabled,
    'onUpdate:modelValue': (value: string) => wrapper.setProps({ modelValue: value }) } });
  wrappers.push(wrapper);
  return wrapper;
}

it('keeps zero distinct from unrecorded and never submits its parent form', async () => {
  const wrapper = render();
  expect(wrapper.find('[aria-pressed=true]').exists()).toBe(false);
  expect(wrapper.find('[aria-label="清除程度"]').exists()).toBe(false);
  expect(wrapper.findAll('button').every(button => button.attributes('type') === 'button')).toBe(true);
  await wrapper.get('[aria-label="0 / 10"]').trigger('click');
  expect(wrapper.props('modelValue')).toBe('0');
  expect(wrapper.get('[aria-pressed=true]').text()).toBe('0');
  expect(wrapper.get('[aria-label="清除程度"]').text()).toBe('清除');
  expect(wrapper.get('[aria-label="清除程度"]').attributes('aria-pressed')).toBeUndefined();
  await wrapper.get('[aria-label="清除程度"]').trigger('click');await flushPromises();
  expect(wrapper.props('modelValue')).toBe('');
  expect(document.activeElement).toBe(wrapper.get('[aria-label="0 / 10"]').element);
  expect(wrapper.find('[aria-pressed=true]').exists()).toBe(false);
  expect(wrapper.find('[aria-label="清除程度"]').exists()).toBe(false);
});

it('preserves a saved value, supports the maximum score and disables changes while saving', async () => {
  const wrapper = render('6');
  expect(wrapper.get('[aria-pressed=true]').text()).toBe('6');
  expect(wrapper.emitted('update:modelValue')).toBeUndefined();
  await wrapper.get('[aria-label="10 / 10"]').trigger('click');
  expect(wrapper.props('modelValue')).toBe('10');
  await wrapper.setProps({ disabled: true });
  expect(wrapper.findAll('button').every(button => button.attributes('disabled') !== undefined)).toBe(true);
  await wrapper.get('[aria-label="0 / 10"]').trigger('click');
  await wrapper.get('[aria-label="清除程度"]').trigger('click');
  expect(wrapper.props('modelValue')).toBe('10');
});
