import { afterEach, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import QuickAddMenu from '../src/components/QuickAddMenu.vue';

function menuRouter() {
  return createRouter({ history: createMemoryHistory(), routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div/>' } }] });
}

let wrapper: ReturnType<typeof mount>;
const panel = () => document.querySelector<HTMLElement>('.quick-add-panel--inline')!;
const number = (value: string) => Number.parseFloat(value);
function render(rect: DOMRect, width = 390, height = 640) {
  vi.stubGlobal('innerWidth', width);vi.stubGlobal('innerHeight', height);
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(420);
  wrapper = mount(QuickAddMenu, { attachTo: document.body,
    props: { placement: 'inline', canManage: true, label: '补充记录', routeKey: '/health-processes/process', processId: 'process', memberId: 'member' },
    global: { plugins: [menuRouter()], stubs: { RouterLink: { props: ['to'], template: '<a href="#"><slot /></a>' } } },
  });
  return vi.spyOn(wrapper.get('.quick-add-trigger').element, 'getBoundingClientRect').mockReturnValue(rect);
}
async function open() { await wrapper.get('.quick-add-trigger').trigger('click');await flushPromises(); }
afterEach(() => { wrapper?.unmount();vi.restoreAllMocks();vi.unstubAllGlobals();document.body.innerHTML = ''; });

it('opens above a low trigger, stays inside the right edge, and escapes the page container', async () => {
  render(new DOMRect(300, 560, 70, 32));await open();
  const menu = panel();expect(menu.parentElement).toBe(document.body);
  expect(number(menu.style.left)).toBeGreaterThanOrEqual(12);
  expect(number(menu.style.left) + number(menu.style.width)).toBeLessThanOrEqual(378);
  expect(number(menu.style.top) + 422).toBeLessThan(560);
  expect(menu.style.visibility).toBe('visible');expect(document.body.style.overflow).toBe('hidden');
  const trigger = wrapper.get('.quick-add-trigger').element;
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));await flushPromises();
  expect(panel()).toBeNull();expect(document.body.style.overflow).toBe('');expect(document.activeElement).toBe(trigger);
});

it('uses space below a high trigger and limits a tall menu to a scrollable visible area', async () => {
  render(new DOMRect(12, 24, 100, 32), 390, 300);await open();
  expect(number(panel().style.top)).toBeGreaterThanOrEqual(56);
  expect(number(panel().style.maxHeight)).toBeLessThan(420);
  expect(number(panel().style.top) + number(panel().style.maxHeight)).toBeLessThanOrEqual(288);
  expect(panel().querySelectorAll('[role=menuitem]')).toHaveLength(7);
});

it('repositions when the viewport changes and stops listening after closing', async () => {
  const measure = render(new DOMRect(260, 440, 100, 32));await open();
  const originalTop = panel().style.top;
  measure.mockReturnValue(new DOMRect(12, 20, 100, 32));
  vi.stubGlobal('innerWidth', 320);vi.stubGlobal('innerHeight', 280);
  window.dispatchEvent(new Event('resize'));await flushPromises();
  expect(panel().style.top).not.toBe(originalTop);
  expect(number(panel().style.width)).toBeLessThanOrEqual(296);
  expect(number(panel().style.top) + number(panel().style.maxHeight)).toBeLessThanOrEqual(268);
  document.querySelector<HTMLElement>('.quick-add-backdrop--inline')!.click();await flushPromises();
  const calls = measure.mock.calls.length;
  window.dispatchEvent(new Event('resize'));await flushPromises();expect(measure).toHaveBeenCalledTimes(calls);
});

it('stays in the visual viewport when keyboard or zoom changes its size and offset', async () => {
  const viewport = Object.assign(new EventTarget(), { width: 320, height: 300, offsetLeft: 30, offsetTop: 100 });
  vi.stubGlobal('visualViewport', viewport);
  render(new DOMRect(330, 340, 60, 32));await open();
  expect(number(panel().style.left)).toBeGreaterThanOrEqual(42);
  expect(number(panel().style.left) + number(panel().style.width)).toBeLessThanOrEqual(338);
  expect(number(panel().style.top)).toBeGreaterThanOrEqual(112);
  viewport.height = 180;viewport.dispatchEvent(new Event('resize'));await flushPromises();
  expect(number(panel().style.maxHeight)).toBeLessThanOrEqual(156);
  expect(number(panel().style.top)).toBeGreaterThanOrEqual(112);
  expect(number(panel().style.top) + Math.min(422, number(panel().style.maxHeight))).toBeLessThanOrEqual(268);
});
