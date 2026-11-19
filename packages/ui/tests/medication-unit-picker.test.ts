import { afterEach, expect, it } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import MedicationUnitPicker from '../src/components/MedicationUnitPicker.vue';

const wrappers: ReturnType<typeof mount>[] = [];
afterEach(() => wrappers.splice(0).forEach(wrapper => wrapper.unmount()));
function render(value = '', disabled = false) {
  const wrapper = mount(MedicationUnitPicker, {
    props: { modelValue: value, label: '用量单位', name: 'doseUnit', disabled,
      'onUpdate:modelValue': (value: string) => wrapper.setProps({ modelValue: value }) },
    attachTo: document.body,
  });
  wrappers.push(wrapper);
  return wrapper;
}

it('offers compact direct choices without a default and permits clearing a selected unit', async () => {
  const wrapper = render();
  expect(wrapper.findAll('[aria-pressed=true]')).toHaveLength(0);
  expect(wrapper.find('input').exists()).toBe(false);
  expect(wrapper.findAll('button').map(button => button.text())).toEqual(['片', '粒', '袋', 'mL', 'mg', 'g', '其他']);
  await wrapper.findAll('button')[0]!.trigger('click');
  expect(wrapper.props('modelValue')).toBe('片');
  expect(wrapper.get('[aria-pressed=true]').text()).toBe('片');
  await wrapper.get('[aria-pressed=true]').trigger('click');
  expect(wrapper.props('modelValue')).toBe('');
});

it.each(['ml', '合成特殊单位'])('preserves imported %s exactly and keeps it visible when other units are collapsed', async value => {
  const wrapper = render(value);
  expect(wrapper.get('input[name=doseUnit]').element.value).toBe(value);
  expect(wrapper.emitted('update:modelValue')).toBeUndefined();
  await wrapper.get('[aria-expanded=true]').trigger('click');
  expect(wrapper.get('[aria-pressed=true]').text()).toBe(value);
  expect(wrapper.find('input').exists()).toBe(false);
  await wrapper.findAll('button').find(button => button.text() === '片')!.trigger('click');
  expect(wrapper.props('modelValue')).toBe('片');
});

it('expands less frequent units and a focused custom input without changing the saved value', async () => {
  const wrapper = render();
  await wrapper.get('[aria-expanded=false]').trigger('click');await flushPromises();
  expect(document.activeElement).toBe(wrapper.get('input').element);
  expect(wrapper.emitted('update:modelValue')).toBeUndefined();
  await wrapper.findAll('button').find(button => button.text() === '滴')!.trigger('click');
  expect(wrapper.props('modelValue')).toBe('滴');
  await wrapper.get('input').setValue('合成自定义单位');
  expect(wrapper.props('modelValue')).toBe('合成自定义单位');
  await wrapper.setProps({ modelValue: '' });
  expect(wrapper.findAll('[aria-pressed=true]')).toHaveLength(0);
});

it('disables both choices and custom entry while saving', async () => {
  const wrapper = render('合成单位', true);
  expect(wrapper.findAll('button').every(button => button.attributes('disabled') !== undefined)).toBe(true);
  expect(wrapper.get('input').attributes('disabled')).toBeDefined();
  await wrapper.findAll('button')[0]!.trigger('click');
  expect(wrapper.emitted('update:modelValue')).toBeUndefined();
});
