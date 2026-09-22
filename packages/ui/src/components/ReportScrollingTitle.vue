<script setup lang="ts">
import {
  nextTick,
  onActivated,
  onBeforeUnmount,
  onDeactivated,
  onMounted,
  ref,
  watch,
} from "vue";

const props = defineProps<{ text: string }>();
const heading = ref<HTMLElement>();
const label = ref<HTMLElement>();
let observer: ResizeObserver | undefined;
let animation: Animation | undefined;
let touch: MediaQueryList | undefined;
let reduced: MediaQueryList | undefined;
let active = true;

function measure() {
  animation?.cancel();
  animation = undefined;
  if (
    !active ||
    !touch?.matches ||
    reduced?.matches ||
    !heading.value ||
    !label.value
  )
    return;
  const distance = label.value.scrollWidth - heading.value.clientWidth;
  if (distance <= 1 || !label.value.animate) return;
  // Roughly 18 px per second; pause for five seconds at each end.
  const travel = Math.max(4000, (distance / 18) * 1000);
  const duration = travel * 2 + 10000;
  animation = label.value.animate(
    [
      { transform: "translateX(0)", offset: 0, easing: "ease-in-out" },
      { transform: `translateX(-${distance}px)`, offset: travel / duration },
      {
        transform: `translateX(-${distance}px)`,
        offset: (travel + 5000) / duration,
        easing: "ease-in-out",
      },
      { transform: "translateX(0)", offset: (travel * 2 + 5000) / duration },
      { transform: "translateX(0)", offset: 1 },
    ],
    { duration, iterations: Infinity },
  );
}
watch(
  () => props.text,
  async () => {
    await nextTick();
    measure();
  },
);
onMounted(() => {
  touch = window.matchMedia("(max-width: 760px), (pointer: coarse)");
  reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  touch.addEventListener("change", measure);
  reduced.addEventListener("change", measure);
  observer = new ResizeObserver(measure);
  if (heading.value) observer.observe(heading.value);
  if (label.value) observer.observe(label.value);
  void document.fonts?.ready.then(measure);
  measure();
});
onDeactivated(() => {
  active = false;
  animation?.cancel();
});
onActivated(async () => {
  active = true;
  await nextTick();
  measure();
});
onBeforeUnmount(() => {
  active = false;
  observer?.disconnect();
  animation?.cancel();
  touch?.removeEventListener("change", measure);
  reduced?.removeEventListener("change", measure);
});
</script>

<template>
  <h3 ref="heading" class="report-scrolling-title" :title="text">
    <span ref="label">{{ text }}</span>
  </h3>
</template>

<style scoped>
.report-scrolling-title {
  flex: 1 1 0;
  min-width: 0;
  overflow: hidden;
  text-overflow: clip;
  white-space: nowrap;
}
.report-scrolling-title > span {
  display: block;
  width: max-content;
}
@media (min-width: 761px) and (pointer: fine) {
  .report-scrolling-title > span {
    width: auto;
    overflow: hidden;
    text-overflow: ellipsis;
  }
}
@media (prefers-reduced-motion: reduce) {
  .report-scrolling-title {
    white-space: normal;
  }
  .report-scrolling-title > span {
    width: auto;
    overflow-wrap: anywhere;
    white-space: normal;
  }
}
</style>
