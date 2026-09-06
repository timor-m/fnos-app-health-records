<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
  ChevronLeft, ChevronRight, CircleAlert, Crosshair, Download, LoaderCircle, Maximize2,
  RectangleHorizontal, RectangleVertical, Sparkles, X, ZoomIn, ZoomOut
} from "@lucide/vue";
import { useScrollLock } from "../composables/useScrollLock";
import OcrTextOverlay from "./OcrTextOverlay.vue";
import type { OcrPageDetail } from "../types/api";
import { downloadDirectUrl } from "../utils/download";

export type ImageViewerPage = {
  key: string;
  fullUrl: string;
  previewUrl?: string;
  label: string;
  downloadUrl?: string;
  downloadName?: string;
};

const props = defineProps<{
  pages: ImageViewerPage[];
  startIndex?: number;
  ocrDetail?: OcrPageDetail | null;
  highlightLineIds?: string[];
  accentLineIds?: string[];
  autoLocate?: boolean;
}>();
const emit = defineEmits<{ close: [] }>();

const viewerIndex = ref(0);
const viewerScale = ref(1);
const viewerRotation = ref(0);
const viewerImmersive = ref(false);
const viewerHighRes = ref(false);
const viewerLoading = ref(false);
const viewerLoadFailed = ref(false);
const viewerHighResLoading = ref(false);
const viewerPanX = ref(0);
const viewerPanY = ref(0);
const viewerGesturing = ref(false);
const viewerNaturalW = ref(0);
const viewerNaturalH = ref(0);
const viewerCanvasEl = ref<HTMLElement | null>(null);
const viewerCanvasW = ref(0);
const viewerCanvasH = ref(0);
const viewerImgEl = ref<HTMLImageElement | null>(null);
const ocrOn = ref(true);

const viewerPage = computed(() => props.pages[viewerIndex.value] || null);
const viewerUsingPreview = computed(() => Boolean(viewerPage.value?.previewUrl) && !viewerHighRes.value);
const viewerDisplaySrc = computed(() => {
  const page = viewerPage.value;
  if (!page) return "";
  return viewerUsingPreview.value && page.previewUrl ? page.previewUrl : page.fullUrl;
});
const viewerDownloadSrc = computed(() => viewerPage.value?.downloadUrl || viewerPage.value?.fullUrl || "");

async function downloadViewerPage() {
  const page = viewerPage.value;
  if (!page || !viewerDownloadSrc.value) return;
  await downloadDirectUrl(viewerDownloadSrc.value, page.downloadName || page.label);
}

function resetViewerTransform() {
  viewerScale.value = 1;
  viewerRotation.value = 0;
  viewerPanX.value = 0;
  viewerPanY.value = 0;
}

function resetViewerCanvasScroll() {
  const el = viewerCanvasEl.value;
  if (el) {
    el.scrollLeft = 0;
    el.scrollTop = 0;
  }
}

let viewerPreloadSeq = 0;
function prepareViewerPage(index: number) {
  viewerIndex.value = index;
  resetViewerTransform();
  resetViewerCanvasScroll();
  ocrOn.value = true;
  viewerHighRes.value = false;
  viewerNaturalW.value = 0;
  viewerNaturalH.value = 0;
  const page = viewerPage.value;
  const seq = ++viewerPreloadSeq;
  viewerLoadFailed.value = false;
  if (!page || !page.previewUrl) {
    viewerHighRes.value = true;
    viewerLoading.value = Boolean(page);
    viewerHighResLoading.value = false;
    return;
  }
  viewerLoading.value = false;
  viewerHighResLoading.value = true;
  const probe = new Image();
  probe.onload = () => {
    if (seq !== viewerPreloadSeq) return;
    viewerHighResLoading.value = false;
    viewerHighRes.value = true;
    viewerLoadFailed.value = false;
  };
  probe.onerror = () => {
    if (seq === viewerPreloadSeq) viewerHighResLoading.value = false;
  };
  probe.src = page.fullUrl;
}

function moveViewer(direction: -1 | 1) {
  if (!props.pages.length) return;
  prepareViewerPage((viewerIndex.value + direction + props.pages.length) % props.pages.length);
}

function setViewerScale(next: number) {
  viewerScale.value = Math.min(3, Math.max(0.5, Number(next.toFixed(2))));
  if (viewerScale.value === 1) {
    viewerPanX.value = 0;
    viewerPanY.value = 0;
    resetViewerCanvasScroll();
  }
}

function zoomViewer(direction: -1 | 1) {
  setViewerScale(viewerScale.value + direction * 0.25);
}

function toggleViewerOrientation() {
  viewerRotation.value = viewerRotation.value % 180 === 0 ? 90 : 0;
  setViewerScale(1);
  resetViewerCanvasScroll();
}

function enterViewerImmersive() {
  viewerImmersive.value = true;
}

/* 触屏手势：单指拖动/翻页、双指捏合缩放、点黑色区域退出全屏 */
const viewerGesture = {
  mode: "none" as "none" | "pan" | "pinch" | "swipe",
  startX: 0, startY: 0, startPanX: 0, startPanY: 0,
  startDist: 0, startScale: 1, moved: false
};

function touchDistance(a: Touch, b: Touch) {
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
}

function onViewerTouchStart(event: TouchEvent) {
  if (event.touches.length === 2) {
    viewerGesture.mode = "pinch";
    viewerGesture.startDist = touchDistance(event.touches[0], event.touches[1]);
    viewerGesture.startScale = viewerScale.value;
    viewerGesturing.value = true;
    return;
  }
  if (event.touches.length !== 1) return;
  const touch = event.touches[0];
  viewerGesture.mode = viewerScale.value > 1 ? "pan" : "swipe";
  viewerGesture.startX = touch.clientX;
  viewerGesture.startY = touch.clientY;
  viewerGesture.startPanX = viewerPanX.value;
  viewerGesture.startPanY = viewerPanY.value;
  viewerGesture.moved = false;
  viewerGesturing.value = true;
}

function onViewerTouchMove(event: TouchEvent) {
  if (viewerGesture.mode === "pinch" && event.touches.length === 2) {
    const ratio = touchDistance(event.touches[0], event.touches[1]) / (viewerGesture.startDist || 1);
    setViewerScale(viewerGesture.startScale * ratio);
    viewerGesture.moved = true;
    return;
  }
  if (event.touches.length !== 1) return;
  const touch = event.touches[0];
  if (Math.abs(touch.clientX - viewerGesture.startX) > 10 || Math.abs(touch.clientY - viewerGesture.startY) > 10) {
    viewerGesture.moved = true;
  }
  if (viewerGesture.mode !== "pan") return;
  viewerPanX.value = viewerGesture.startPanX + touch.clientX - viewerGesture.startX;
  viewerPanY.value = viewerGesture.startPanY + touch.clientY - viewerGesture.startY;
}

function isViewerBackground(target: EventTarget | null) {
  return target instanceof HTMLElement && target.classList.contains("original-viewer-canvas");
}

function onViewerTouchEnd(event: TouchEvent) {
  if (event.touches.length > 0) return;
  const mode = viewerGesture.mode;
  viewerGesture.mode = "none";
  viewerGesturing.value = false;
  if (mode !== "swipe" && mode !== "pan") return;
  if (!viewerGesture.moved) {
    if (viewerImmersive.value && isViewerBackground(event.target)) viewerImmersive.value = false;
    return;
  }
  if (mode === "swipe" && props.pages.length > 1) {
    const dx = event.changedTouches[0].clientX - viewerGesture.startX;
    const dy = event.changedTouches[0].clientY - viewerGesture.startY;
    if (Math.abs(dx) >= 56 && Math.abs(dx) > Math.abs(dy) * 1.5) moveViewer(dx < 0 ? 1 : -1);
  }
}

function onViewerCanvasClick(event: MouseEvent) {
  if (viewerImmersive.value && isViewerBackground(event.target)) viewerImmersive.value = false;
}

/* 按图片真实宽高比计算铺满尺寸：竖图按宽度铺满，横图按高度铺满，旋转后同样适配 */
const viewerFitSize = computed(() => {
  const nw = viewerNaturalW.value;
  const nh = viewerNaturalH.value;
  const cw = viewerCanvasW.value;
  const ch = viewerCanvasH.value;
  if (!nw || !nh || !cw || !ch) return null;
  const rotated = viewerRotation.value % 180 !== 0;
  const effW = rotated ? nh : nw;
  const effH = rotated ? nw : nh;
  const fit = Math.min(cw / effW, ch / effH);
  return {
    width: Math.max(1, Math.round(nw * fit)),
    height: Math.max(1, Math.round(nh * fit))
  };
});

const viewerFitStyle = computed(() => {
  const size = viewerFitSize.value;
  if (!size) return {};
  return {
    width: `${size.width}px`,
    height: `${size.height}px`,
    maxWidth: "none",
    maxHeight: "none"
  };
});

const ocrAvailable = computed(() => Boolean(props.ocrDetail?.lines?.length));

// 高亮行（优先结果单元格，其次整行）的并集包围盒，换算成页面坐标系下的
// 0-1 比例，供“定位到标记”把该行平移缩放到视口中心。
const highlightBoxFraction = computed(() => {
  const detail = props.ocrDetail;
  if (!detail) return null;
  const ids = new Set([
    ...(props.accentLineIds || []),
    ...(props.highlightLineIds || [])
  ]);
  if (!ids.size) return null;
  const refW = detail.coordWidth || viewerNaturalW.value;
  const refH = detail.coordHeight || viewerNaturalH.value;
  if (!refW || !refH) return null;
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const line of detail.lines) {
    if (!ids.has(line.id) || !line.box || line.box.length < 4) continue;
    left = Math.min(left, line.box[0]);
    top = Math.min(top, line.box[1]);
    right = Math.max(right, line.box[2]);
    bottom = Math.max(bottom, line.box[3]);
  }
  if (!Number.isFinite(left) || right <= left || bottom <= top) return null;
  return {
    cx: (left + right) / 2 / refW,
    cy: (top + bottom) / 2 / refH,
    width: (right - left) / refW,
    height: (bottom - top) / refH
  };
});

const hasHighlights = computed(() => Boolean(highlightBoxFraction.value));

function locateHighlight() {
  const target = highlightBoxFraction.value;
  if (!target) return;
  if (viewerRotation.value % 360 !== 0) viewerRotation.value = 0;
  const fit = viewerFitSize.value;
  if (!fit) return;
  // 目标行高度约占视口一半，密集表格也不会放得过大。
  const ideal = Math.min(2.5, Math.max(1.25, 0.5 / Math.max(target.height, 0.015)));
  // 触屏等窄视口下还要保证整行宽度完整可见：
  // 只按行高放大后行框两端会被裁出视口，所以缩放同时受行宽约束。
  const canvasW = viewerCanvasW.value;
  const widthFit = canvasW
    ? (canvasW * 0.9) / Math.max(target.width * fit.width, 1)
    : Infinity;
  const scale = Math.min(ideal, widthFit);
  setViewerScale(scale);
  const applied = viewerScale.value;
  let panX = -((target.cx - 0.5) * fit.width * applied);
  let panY = -((target.cy - 0.5) * fit.height * applied);
  /* 触屏窄视口下，把靠页面上方的标记行平移到视口正中心会把整页挂到视口
     下方、顶部露出大片黑边（图片看起来"偏下"）。按"缩放后的图片始终覆盖
     视口"的原则钳制平移量：行保持接近居中，页面边缘不被拉进视口。 */
  const maxPanX = Math.max(
    0,
    (fit.width * applied - viewerCanvasW.value) / 2,
  );
  const maxPanY = Math.max(
    0,
    (fit.height * applied - viewerCanvasH.value) / 2,
  );
  viewerPanX.value = Math.min(maxPanX, Math.max(-maxPanX, panX));
  viewerPanY.value = Math.min(maxPanY, Math.max(-maxPanY, panY));
}

// 趋势原图等场景打开时自动定位到标记行：等图片与 OCR 数据都就绪后执行一次。
let autoLocatedKey = "";
watch(
  [() => props.ocrDetail, viewerNaturalW, viewerCanvasW, viewerCanvasH],
  () => {
    if (!props.autoLocate) return;
    const key = `${viewerPage.value?.key || ""}:${props.ocrDetail?.pageId || ""}`;
    if (autoLocatedKey === key) return;
    if (!highlightBoxFraction.value || !viewerFitSize.value) return;
    autoLocatedKey = key;
    locateHighlight();
  },
  { flush: "post" }
);

function onViewerImageLoad(event: Event) {
  viewerLoading.value = false;
  viewerLoadFailed.value = false;
  const img = event.target as HTMLImageElement;
  viewerNaturalW.value = img.naturalWidth || 0;
  viewerNaturalH.value = img.naturalHeight || 0;
}

function onViewerImageError() {
  viewerLoading.value = false;
  viewerHighResLoading.value = false;
  viewerLoadFailed.value = true;
}

function retryViewerImage() {
  prepareViewerPage(viewerIndex.value);
}

let viewerCanvasObserver: ResizeObserver | null = null;

function handleViewerKeydown(event: KeyboardEvent) {
  if (event.key === "Escape") {
    if (viewerImmersive.value) viewerImmersive.value = false;
    else emit("close");
  }
  else if (event.key === "ArrowLeft") moveViewer(-1);
  else if (event.key === "ArrowRight") moveViewer(1);
  else if (event.key === "+" || event.key === "=") zoomViewer(1);
  else if (event.key === "-") zoomViewer(-1);
  else return;
  event.preventDefault();
}

useScrollLock(computed(() => true));

onMounted(async () => {
  prepareViewerPage(Math.min(Math.max(props.startIndex || 0, 0), Math.max(props.pages.length - 1, 0)));
  window.addEventListener("keydown", handleViewerKeydown);
  await nextTick();
  const el = viewerCanvasEl.value;
  if (el) {
    const measure = () => {
      viewerCanvasW.value = el.clientWidth;
      viewerCanvasH.value = el.clientHeight;
    };
    measure();
    viewerCanvasObserver = new ResizeObserver(measure);
    viewerCanvasObserver.observe(el);
  }
});
onBeforeUnmount(() => {
  viewerCanvasObserver?.disconnect();
  window.removeEventListener("keydown", handleViewerKeydown);
});
</script>

<template>
  <div class="original-viewer" :class="{ immersive: viewerImmersive }" role="dialog" aria-modal="true" @click.self="emit('close')">
    <header class="original-viewer-header">
      <div>
        <strong>{{ viewerPage?.label || "查看图片" }}</strong>
        <span v-if="pages.length > 1">第 {{ viewerIndex + 1 }} 页 / 共 {{ pages.length }} 页</span>
      </div>
      <div class="original-viewer-actions">
        <slot name="actions" />
        <template v-if="ocrAvailable">
          <button
            type="button"
            :title="ocrOn ? '隐藏 OCR 标记' : '显示 OCR 标记'"
            @click="ocrOn = !ocrOn"
          ><Sparkles :size="18" /></button>
          <button
            v-if="hasHighlights"
            type="button"
            title="定位到标记"
            @click="locateHighlight"
          ><Crosshair :size="18" /></button>
        </template>
        <button type="button" title="缩小" :disabled="viewerScale <= 0.5" @click="zoomViewer(-1)"><ZoomOut :size="18" /></button>
        <span>{{ Math.round(viewerScale * 100) }}%</span>
        <button type="button" title="放大" :disabled="viewerScale >= 3" @click="zoomViewer(1)"><ZoomIn :size="18" /></button>
        <button
          type="button"
          :title="viewerRotation % 180 === 0 ? '切换为横屏' : '切换为竖屏'"
          @click="toggleViewerOrientation"
        >
          <RectangleHorizontal v-if="viewerRotation % 180 === 0" :size="18" />
          <RectangleVertical v-else :size="18" />
        </button>
        <button type="button" title="下载" @click="downloadViewerPage"><Download :size="18" /></button>
      </div>
      <button class="viewer-close-button" type="button" title="关闭" @click="emit('close')"><X :size="20" /></button>
    </header>
    <main class="original-viewer-stage">
      <button v-if="pages.length > 1" class="viewer-nav-button viewer-nav-button--prev" type="button" title="上一页" @click="moveViewer(-1)">
        <ChevronLeft :size="24" />
      </button>
      <div
        ref="viewerCanvasEl"
        class="original-viewer-canvas"
        :class="{ 'is-preview': viewerUsingPreview, gesturing: viewerGesturing, fit: viewerScale === 1 }"
        @touchstart="onViewerTouchStart"
        @touchmove.prevent="onViewerTouchMove"
        @touchend="onViewerTouchEnd"
        @touchcancel="onViewerTouchEnd"
        @click="onViewerCanvasClick"
      >
        <div v-if="viewerLoading" class="viewer-loading"><LoaderCircle class="spin-icon" :size="18" />加载中</div>
        <div v-if="viewerLoadFailed" class="viewer-loading viewer-load-failed">
          <CircleAlert :size="18" />图片加载失败
          <button type="button" @click="retryViewerImage">重试</button>
        </div>
        <div v-if="viewerHighResLoading" class="viewer-preview-badge"><LoaderCircle class="spin-icon" :size="13" />正在加载高清图…</div>
        <div
          v-if="viewerPage && !viewerLoadFailed"
          class="viewer-image-frame"
          :style="[viewerFitStyle, { transform: `translate(-50%, -50%) translate3d(${viewerPanX}px, ${viewerPanY}px, 0) scale(${viewerScale}) rotate(${viewerRotation}deg)` }]"
        >
          <img
            ref="viewerImgEl"
            :src="viewerDisplaySrc"
            :alt="viewerPage.label"
            @load="onViewerImageLoad"
            @error="onViewerImageError"
          />
          <OcrTextOverlay
            v-if="ocrOn && ocrAvailable"
            :image="viewerImgEl"
            :lines="ocrDetail!.lines"
            :coord-width="ocrDetail!.coordWidth"
            :coord-height="ocrDetail!.coordHeight"
            :highlight-line-ids="highlightLineIds || []"
            :accent-line-ids="accentLineIds || []"
            :interactive="false"
          />
        </div>
        <button
          v-if="!viewerImmersive"
          class="viewer-fullscreen-button"
          type="button"
          title="全屏查看"
          @click.stop="enterViewerImmersive"
        >
          <Maximize2 :size="19" />
        </button>
        <button
          v-if="viewerImmersive"
          class="viewer-fullscreen-button viewer-orient-button"
          type="button"
          :title="viewerRotation % 180 === 0 ? '切换为横屏' : '切换为竖屏'"
          @click.stop="toggleViewerOrientation"
        >
          <RectangleHorizontal v-if="viewerRotation % 180 === 0" :size="19" />
          <RectangleVertical v-else :size="19" />
        </button>
      </div>
      <button v-if="pages.length > 1" class="viewer-nav-button viewer-nav-button--next" type="button" title="下一页" @click="moveViewer(1)">
        <ChevronRight :size="24" />
      </button>
    </main>
    <footer class="original-viewer-footer">
      <span class="viewer-hint-desktop">快捷键：←/→ 翻页，+/- 缩放，Esc 关闭</span>
      <span class="viewer-hint-touch">双指缩放 · 拖动查看 · 滑翻页 · 点黑边退出全屏</span>
    </footer>
  </div>
</template>
