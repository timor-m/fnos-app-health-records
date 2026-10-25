<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { RotateCw } from '@lucide/vue';
import { originalOrientationLayout } from '../utils/original-orientation';

const props = defineProps<{ image: HTMLImageElement | null; pageKey: string; initialRotation?: number; toolbarTarget?: HTMLElement | null }>();
const emit = defineEmits<{ rotationChange: [rotation: number] }>();
const rotation = ref(props.initialRotation || 0);
watch(rotation, value => emit("rotationChange",value), {immediate:true});
const viewport = ref<HTMLElement | null>(null);
const size = ref({ width: 0, imageWidth: 0, imageHeight: 0 });
let observer: ResizeObserver | undefined;
function measure() {
  size.value = { width: viewport.value?.clientWidth || 0, imageWidth: props.image?.naturalWidth || 0, imageHeight: props.image?.naturalHeight || 0 };
}
watch(() => [props.pageKey, props.initialRotation], () => { rotation.value = props.initialRotation || 0; }, { flush: 'sync' });
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
const layout = computed(() => originalOrientationLayout(size.value.width, size.value.imageWidth, size.value.imageHeight, rotation.value % 180 !== 0));
const contentStyle = computed(() => layout.value ? {
  width: `${layout.value.width}px`, height: `${layout.value.height}px`,
  position: 'absolute' as const, left: '50%', top: '50%',
  transform: `translate(-50%, -50%) rotate(${rotation.value}deg) scale(${layout.value.scale})`
} : undefined);
</script>

<template>
  <div class="original-orientation">
    <Teleport :to="toolbarTarget || 'body'" :disabled="!toolbarTarget">
    <div class="original-orientation-toolbar">
      <button class="plain-icon-button" type="button" :disabled="!layout"
        title="顺时针旋转 90°" aria-label="顺时针旋转 90°"
        @click.stop="rotation = (rotation + 90) % 360" @keydown.stop>
        <RotateCw :size="18" />
      </button>
    </div>
    </Teleport>
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
