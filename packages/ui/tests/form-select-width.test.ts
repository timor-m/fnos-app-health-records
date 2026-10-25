import { afterEach, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import FormSelect from '../src/components/FormSelect.vue';
let wrapper: ReturnType<typeof mount>;
afterEach(() => { wrapper?.unmount(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it('widens the menu for its content and keeps it within the viewport', async () => {
  vi.stubGlobal('innerWidth', 1000);
  vi.stubGlobal('matchMedia', () => ({matches:false}));
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(850, 100, 100, 36));
  vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(340);
  wrapper = mount(FormSelect, {props:{modelValue:'a', options:[{value:'a',label:'A long option'}]}});
  await wrapper.get('button').trigger('click'); await nextTick();
  const panel = document.querySelector<HTMLElement>('.form-select-panel')!;
  expect(panel.style.width).toBe('340px'); expect(panel.style.left).toBe('648px');
  vi.stubGlobal('innerWidth', 300); window.dispatchEvent(new Event('resize')); await nextTick();
  expect(panel.style.width).toBe('276px'); expect(panel.style.left).toBe('12px');
});

it('opens upward near the bottom so common values remain reachable on desktop', async () => {
  vi.stubGlobal('innerWidth', 1000); vi.stubGlobal('innerHeight', 700);
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(400, 610, 100, 40));
  wrapper = mount(FormSelect, { props: { modelValue: '', options: [{ value: 'a', label: '合成常用值' }] } });
  await wrapper.get('button').trigger('click'); await nextTick();
  const panel = document.querySelector<HTMLElement>('.form-select-panel')!;
  expect(panel.style.bottom).toBe('96px'); expect(panel.style.top).toBe('');
  expect(panel.style.maxHeight).toBe('240px');
});
