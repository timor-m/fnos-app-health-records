import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import Title from "../src/components/ReportScrollingTitle.vue";
let resize: () => void;
let touch = true;
let reduced = false;
const cancel = vi.fn();
const animate = vi.fn(() => ({ cancel }));
const disconnect = vi.fn();
let wrapper: ReturnType<typeof mount>;
beforeEach(() => {
  touch = true;
  reduced = false;
  vi.clearAllMocks();
  vi.spyOn(window, "matchMedia").mockImplementation(
    (query) =>
      ({
        matches: query.includes("reduced-motion") ? reduced : touch,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }) as unknown as MediaQueryList,
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        resize = callback;
      }
      observe() {}
      disconnect = disconnect;
    },
  );
});
afterEach(() => {
  wrapper?.unmount();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function prepare(width: number) {
  wrapper = mount(Title, { props: { text: "Synthetic long report title" } });
  await flushPromises();
  Object.defineProperty(wrapper.element, "clientWidth", { value: 200 });
  const span = wrapper.get("span").element;
  Object.defineProperty(span, "scrollWidth", {
    value: width,
    configurable: true,
  });
  Object.defineProperty(span, "animate", { value: animate });
  resize();
}
it("moves only the overflowing distance, pauses five seconds at each end, and loops", async () => {
  await prepare(380);
  const [frames, options] = animate.mock.calls.at(-1)! as unknown as [
    Keyframe[],
    KeyframeAnimationOptions,
  ];
  expect(frames[1]!.transform).toBe("translateX(-180px)");
  expect(options.duration).toBe(30000);
  expect(options.iterations).toBe(Infinity);
  expect(
    (Number(frames[2]!.offset) - Number(frames[1]!.offset)) *
      Number(options.duration),
  ).toBeCloseTo(5000);
  expect(
    (1 - Number(frames[3]!.offset)) * Number(options.duration),
  ).toBeCloseTo(5000);
  wrapper.unmount();
  expect(cancel).toHaveBeenCalled();
  expect(disconnect).toHaveBeenCalled();
});
it("keeps short titles still and cancels scrolling when the title fits after resize", async () => {
  await prepare(180);
  expect(animate).not.toHaveBeenCalled();
  Object.defineProperty(wrapper.get("span").element, "scrollWidth", {
    value: 360,
  });
  resize();
  expect(animate).toHaveBeenCalledTimes(1);
  Object.defineProperty(wrapper.get("span").element, "scrollWidth", {
    value: 180,
  });
  resize();
  expect(cancel).toHaveBeenCalled();
  expect(animate).toHaveBeenCalledTimes(1);
});
it("does not animate when reduced motion is requested", async () => {
  reduced = true;
  await prepare(500);
  expect(animate).not.toHaveBeenCalled();
});
it("does not animate desktop mouse layouts", async () => {
  touch = false;
  await prepare(500);
  expect(animate).not.toHaveBeenCalled();
});
