import { mount, flushPromises } from '@vue/test-utils';
import { afterEach, expect, it, vi } from 'vitest';
import { defineComponent, ref } from 'vue';
import { usePullRefresh } from '../src/composables/usePullRefresh';

let wrapper: ReturnType<typeof mount>;
let pull: ReturnType<typeof usePullRefresh>;
const refresh = vi.fn();
function show() {
  refresh.mockReset();
  refresh.mockResolvedValue(undefined);
  Object.defineProperty(window, 'scrollY', { configurable: true, value: 0 });
  wrapper = mount(defineComponent({
    setup() { const root = ref<HTMLElement | null>(null); pull = usePullRefresh(root, refresh); return { root }; },
    template: '<section ref="root"><div data-pull-refresh-ignore><button>筛选</button></div><div class="list">列表</div></section>'
  }));
}
function touch(type: string, x: number, y: number, target: Element = wrapper.element, count = type === 'touchend' || type === 'touchcancel' ? 0 : 1) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'touches', { value: Array.from({length: count}, () => ({ clientX: x, clientY: y })) });
  target.dispatchEvent(event);
  return event;
}
afterEach(() => { wrapper?.unmount(); Object.defineProperty(window, 'scrollY', { configurable: true, value: 0 }); });

it('keeps normal downward refresh and ignores tiny movement before choosing an axis', async () => {
  show(); touch('touchstart', 100, 0); const small = touch('touchmove', 101, 6);
  expect(small.defaultPrevented).toBe(false); expect(pull.pullDistance.value).toBe(0);
  expect(touch('touchmove', 103, 140).defaultPrevented).toBe(true); expect(pull.pullDistance.value).toBe(63);
  touch('touchmove', 103, 400); expect(pull.pullDistance.value).toBe(92);
  touch('touchend', 103, 400); await flushPromises(); expect(refresh).toHaveBeenCalledOnce(); expect(pull.pullDistance.value).toBe(0);
});
it('locks a horizontal gesture out of refresh even if the finger later drifts downward', async () => {
  show(); touch('touchstart', 200, 10); const first = touch('touchmove', 160, 14); const drift = touch('touchmove', 130, 200);
  expect(first.defaultPrevented).toBe(false); expect(drift.defaultPrevented).toBe(false); expect(pull.pullDistance.value).toBe(0);
  touch('touchend', 130, 200); await flushPromises(); expect(refresh).not.toHaveBeenCalled();
});
it('never starts pull-to-refresh from an opted-out filter or its nested button', async () => {
  show(); const button = wrapper.get('[data-pull-refresh-ignore] button').element;
  touch('touchstart', 200, 10, button); expect(touch('touchmove', 190, 200, button).defaultPrevented).toBe(false);
  touch('touchend', 190, 200, button); await flushPromises(); expect(pull.pullDistance.value).toBe(0); expect(refresh).not.toHaveBeenCalled();
  touch('touchstart', 100, 0); touch('touchmove', 100, 160); touch('touchend', 100, 160); await flushPromises(); expect(refresh).toHaveBeenCalledOnce();
});
it('cancels a long pull without refreshing when the browser takes over the touch sequence', async () => {
  show(); touch('touchstart', 100, 0); touch('touchmove', 100, 160); expect(pull.pullDistance.value).toBeGreaterThan(56);
  touch('touchcancel', 100, 160); touch('touchend', 100, 160); await flushPromises(); expect(pull.pullDistance.value).toBe(0); expect(refresh).not.toHaveBeenCalled();
});
it('does not turn an upward scroll into refresh when the finger reverses direction', async () => {
  show(); touch('touchstart', 100, 100); touch('touchmove', 100, 70); touch('touchmove', 100, 260); touch('touchend', 100, 260);
  await flushPromises(); expect(pull.pullDistance.value).toBe(0); expect(refresh).not.toHaveBeenCalled();
});
it('stops pulling when another finger joins or the page leaves its scroll origin', async () => {
  show(); touch('touchstart', 100, 0); touch('touchmove', 100, 160, wrapper.element, 2); touch('touchend', 100, 160); await flushPromises(); expect(refresh).not.toHaveBeenCalled();
  touch('touchstart', 100, 0); Object.defineProperty(window, 'scrollY', { configurable: true, value: 20 }); touch('touchmove', 100, 160);
  Object.defineProperty(window, 'scrollY', { configurable: true, value: 0 }); touch('touchmove', 100, 180); touch('touchend', 100, 180); await flushPromises(); expect(refresh).not.toHaveBeenCalled();
});
it('keeps an in-flight refresh singular while further touches arrive', async () => {
  show(); let finish!: () => void; refresh.mockImplementation(() => new Promise<void>(resolve => finish = resolve));
  touch('touchstart', 100, 0); touch('touchmove', 100, 160); touch('touchend', 100, 160); expect(pull.refreshing.value).toBe(true);
  touch('touchstart', 100, 0); touch('touchmove', 100, 160); touch('touchend', 100, 160); expect(refresh).toHaveBeenCalledOnce();
  finish(); await flushPromises(); expect(pull.refreshing.value).toBe(false);
});
