import { onBeforeUnmount, onDeactivated, onMounted, ref, type Ref } from "vue";

export const PULL_TRIGGER = 56;
const PULL_MAX = 92;
const DIRECTION_SLOP = 8;

/** Touch pull-to-refresh bound to a page root element; only engages at window scroll top. */
export function usePullRefresh(root: Ref<HTMLElement | null>, onRefresh: () => Promise<void> | void) {
  const pullDistance = ref(0);
  const refreshing = ref(false);
  let touchStartY = 0;
  let touchStartX = 0;
  let pulling = false;
  let direction: 'pending' | 'vertical' | 'ignored' = 'pending';
  let boundRoot: HTMLElement | null = null;

  async function refresh() {
    if (refreshing.value) return;
    refreshing.value = true;
    try { await onRefresh(); }
    catch (cause) {
      /* 调用方一般会自行提示；这里兜底，避免漏 catch 时变成未捕获 rejection 且毫无痕迹 */
      console.warn("[health-records] 下拉刷新执行失败", cause);
    }
    finally { refreshing.value = false; }
  }

  function onTouchStart(event: TouchEvent) {
    reset();
    if (refreshing.value || window.scrollY > 0 || event.touches.length !== 1) return;
    if (event.target instanceof Element && event.target.closest('[data-pull-refresh-ignore]')) return;
    touchStartY = event.touches[0].clientY;
    touchStartX = event.touches[0].clientX || 0;
    pulling = true;
  }
  function onTouchMove(event: TouchEvent) {
    if (!pulling || refreshing.value) return;
    if (event.touches.length !== 1 || window.scrollY > 0) { reset(); return; }
    const delta = event.touches[0].clientY - touchStartY;
    const deltaX = (event.touches[0].clientX || 0) - touchStartX;
    if (direction === 'pending') {
      if (Math.max(Math.abs(deltaX), Math.abs(delta)) < DIRECTION_SLOP) return;
      direction = Math.abs(deltaX) >= Math.abs(delta) || delta <= 0 ? 'ignored' : 'vertical';
    }
    if (direction !== 'vertical' || delta <= 0) {
      pullDistance.value = 0;
      return;
    }
    if (event.cancelable) event.preventDefault();
    pullDistance.value = Math.min(delta * 0.45, PULL_MAX);
  }
  function reset() {
    pulling = false;
    direction = 'pending';
    pullDistance.value = 0;
  }
  function onTouchEnd() {
    if (!pulling) return;
    const shouldRefresh = direction === 'vertical' && pullDistance.value >= PULL_TRIGGER;
    reset();
    if (shouldRefresh) void refresh();
  }

  onMounted(() => {
    const el = root.value;
    if (!el) return;
    boundRoot = el;
    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("touchend", onTouchEnd, { passive: true });
    el.addEventListener("touchcancel", reset, { passive: true });
  });
  onDeactivated(reset);
  onBeforeUnmount(() => {
    const el = boundRoot;
    if (!el) return;
    el.removeEventListener("touchstart", onTouchStart);
    el.removeEventListener("touchmove", onTouchMove);
    el.removeEventListener("touchend", onTouchEnd);
    el.removeEventListener("touchcancel", reset);
  });

  return { pullDistance, refreshing, refresh };
}
