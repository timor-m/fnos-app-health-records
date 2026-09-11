<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { RectangleHorizontal, RectangleVertical } from '@lucide/vue';
import { originalOrientationLayout } from '../utils/original-orientation';

const props = defineProps<{ image: HTMLImageElement | null; pageKey: string }>();
const rotated = ref(false);
const viewport = ref<HTMLElement | null>(null);
const size = ref({ width: 0, imageWidth: 0, imageHeight: 0 });
let observer: ResizeObserver | undefined;
function measure() {
  size.value = { width: viewport.value?.clientWidth || 0, imageWidth: props.image?.naturalWidth || 0, imageHeight: props.image?.naturalHeight || 0 };
}
watch(() => props.pageKey, () => { rotated.value = false; }, { flush: 'sync' });
watch(() => props.image, (image, old) => {
  old?.removeEventListener('load', measure);
  image?.addEventListener('load', measure);
  measure();
}, { flush: 'post' });
onMounted(() => {
  observer = new ResizeObserver(measure);
  if (viewport.value) observer.observe(viewport.value);
  props.image?.addEventListener('load', measure);
  measure();
});
onBeforeUnmount(() => { observer?.disconnect(); props.image?.removeEventListener('load', measure); });
const layout = computed(() => originalOrientationLayout(size.value.width, size.value.imageWidth, size.value.imageHeight, rotated.value));
const contentStyle = computed(() => layout.value ? {
  width: `${layout.value.width}px`, height: `${layout.value.height}px`,
  position: 'absolute' as const, left: '50%', top: '50%',
  transform: `translate(-50%, -50%) rotate(${rotated.value ? 90 : 0}deg) scale(${layout.value.scale})`
} : undefined);
</script>

<template>
  <div class="original-orientation">
    <div class="original-orientation-toolbar">
      <button class="plain-icon-button" type="button" :disabled="!layout" :aria-pressed="rotated"
        :title="rotated ? '切换为竖屏' : '切换为横屏'" :aria-label="rotated ? '切换为竖屏' : '切换为横屏'"
        @click.stop="rotated = !rotated" @keydown.stop>
        <RectangleVertical v-if="rotated" :size="18" /><RectangleHorizontal v-else :size="18" />
      </button>
    </div>
    <div ref="viewport" class="original-orientation-viewport" :style="layout ? { height: `${layout.stageHeight}px` } : undefined">
      <div class="original-orientation-content" :style="contentStyle"><slot /></div>
    </div>
  </div>
</template>

<style scoped>
.original-orientation { width: 100%; min-width: 0; }
.original-orientation-toolbar { display: flex; justify-content: flex-end; margin-bottom: 6px; }
.original-orientation-toolbar button { width: 36px; height: 36px; display: grid; place-items: center; }
.original-orientation-viewport { position: relative; width: 100%; overflow: hidden; }
.original-orientation-content { position: relative; transform-origin: center; }
.original-orientation .original-orientation-content :deep(> div) { width: 100%; min-height: 0; overflow: visible; margin: 0; }
.original-orientation .original-orientation-viewport .original-orientation-content :deep(img) { display: block; width: 100%; height: auto; max-height: none; }
</style>
