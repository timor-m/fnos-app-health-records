<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { OcrLineDetail } from "../types/api";
import { copyTextToClipboard } from "../utils/clipboard";

// interactive 必须显式给默认值 true：type-only 声明的可选 boolean prop
// 会被 Vue 按布尔转型成 false，导致未传该 prop 的校对弹窗叠加层
// 误入静态模式（衬底消失、点击复制失效）。
const props = withDefaults(
  defineProps<{
    image: HTMLImageElement | null;
    lines: OcrLineDetail[];
    coordWidth?: number | null;
    coordHeight?: number | null;
    highlightLineIds?: string[];
    accentLineIds?: string[];
    interactive?: boolean;
  }>(),
  { interactive: true },
);

const imageSize = ref({ width: 0, height: 0, naturalWidth: 0, naturalHeight: 0 });
let resizeObserver: ResizeObserver | null = null;

const sortedLines = computed(() =>
  props.lines.filter((line): line is OcrLineDetail & { box: number[] } => Array.isArray(line.box) && line.box.length >= 4)
    .sort((left, right) => {
      const leftBox = left.box;
      const rightBox = right.box;
      return leftBox[1] - rightBox[1] || leftBox[0] - rightBox[0];
    })
);
const highlightedLineIds = computed(() => new Set(props.highlightLineIds || []));
const accentedLineIds = computed(() => new Set(props.accentLineIds || []));

/* 高亮行按纵向重叠聚成"表格行"：同一行里的指标名、结果值、参考值等单元格
   合并成一个矩形框整体标记，避免每个单元格各自盖一块颜色挡住原文。 */
const highlightGroups = computed(() => {
  const groups: Array<{ box: [number, number, number, number]; ids: string[] }> = [];
  for (const line of sortedLines.value) {
    if (!highlightedLineIds.value.has(line.id)) continue;
    const [left, top, right, bottom] = line.box;
    const target = groups.find((group) => {
      const [, groupTop, , groupBottom] = group.box;
      const overlap = Math.min(bottom, groupBottom) - Math.max(top, groupTop);
      const minHeight = Math.min(bottom - top, groupBottom - groupTop);
      return minHeight > 0 && overlap > minHeight * 0.4;
    });
    if (target) {
      target.box = [
        Math.min(target.box[0], left),
        Math.min(target.box[1], top),
        Math.max(target.box[2], right),
        Math.max(target.box[3], bottom),
      ];
      target.ids.push(line.id);
    } else {
      groups.push({ box: [left, top, right, bottom], ids: [line.id] });
    }
  }
  return groups;
});

const copiedLineId = ref("");
let copiedTimer: ReturnType<typeof setTimeout> | undefined;
const toastPosition = ref({ left: 0, top: 0 });

async function copyLineText(line: OcrLineDetail) {
  const copied = await copyTextToClipboard(line.text);
  if (!copied) return;
  copiedLineId.value = line.id;
  // 原图通常比视口高，toast 定位到图片在视口内可见部分的中心，避免落在视口外。
  const image = props.image;
  if (image) {
    const rect = image.getBoundingClientRect();
    const visibleTop = Math.max(rect.top, 0);
    const visibleBottom = Math.min(rect.bottom, window.innerHeight);
    toastPosition.value = {
      left: rect.left + rect.width / 2,
      top: visibleBottom > visibleTop
        ? (visibleTop + visibleBottom) / 2
        : window.innerHeight / 2,
    };
  } else {
    toastPosition.value = { left: window.innerWidth / 2, top: window.innerHeight / 2 };
  }
  clearTimeout(copiedTimer);
  copiedTimer = setTimeout(() => {
    copiedLineId.value = "";
  }, 1200);
}

function updateSize() {
  const image = props.image;
  if (!image) return;
  imageSize.value = {
    width: image.clientWidth,
    height: image.clientHeight,
    naturalWidth: image.naturalWidth,
    naturalHeight: image.naturalHeight,
  };
}

function lineStyle(box: [number, number, number, number]) {
  const [left, top, right, bottom] = box;
  // box 坐标以 OCR 坐标系参考尺寸为基准（PDF 页面点坐标 / 校正后图片像素），
  // 与预览图像素尺寸可能不同；缺失时退化为按预览图自然尺寸换算。
  const refWidth = props.coordWidth || imageSize.value.naturalWidth;
  const refHeight = props.coordHeight || imageSize.value.naturalHeight;
  if (!refWidth || !refHeight) return { display: "none" };
  return {
    left: `${(left / refWidth) * 100}%`,
    top: `${(top / refHeight) * 100}%`,
    width: `${((right - left) / refWidth) * 100}%`,
    height: `${((bottom - top) / refHeight) * 100}%`,
  };
}

function groupStyle(box: [number, number, number, number]) {
  const refWidth = props.coordWidth || imageSize.value.naturalWidth;
  const refHeight = props.coordHeight || imageSize.value.naturalHeight;
  if (!refWidth || !refHeight) return { display: "none" };
  // 行框比文字略外扩，框住整行而不压在字形上。
  const padX = Math.max(2, refWidth * 0.006);
  const padY = Math.max(1.5, (box[3] - box[1]) * 0.22);
  const left = Math.max(0, box[0] - padX);
  const top = Math.max(0, box[1] - padY);
  const right = Math.min(refWidth, box[2] + padX);
  const bottom = Math.min(refHeight, box[3] + padY);
  return {
    left: `${(left / refWidth) * 100}%`,
    top: `${(top / refHeight) * 100}%`,
    width: `${((right - left) / refWidth) * 100}%`,
    height: `${((bottom - top) / refHeight) * 100}%`,
  };
}

function onImageLoad() {
  updateSize();
}

onMounted(() => {
  const image = props.image;
  if (!image) return;
  image.addEventListener("load", onImageLoad);
  if (image.complete) updateSize();
  resizeObserver = new ResizeObserver(() => updateSize());
  resizeObserver.observe(image);
});

onBeforeUnmount(() => {
  props.image?.removeEventListener("load", onImageLoad);
  resizeObserver?.disconnect();
  clearTimeout(copiedTimer);
});

watch(() => props.image, (newImage, oldImage) => {
  oldImage?.removeEventListener("load", onImageLoad);
  resizeObserver?.disconnect();
  if (!newImage) return;
  newImage.addEventListener("load", onImageLoad);
  resizeObserver = new ResizeObserver(() => updateSize());
  resizeObserver.observe(newImage);
  if (newImage.complete) updateSize();
});
</script>

<template>
  <div class="ocr-text-overlay" @click.stop>
    <span
      v-for="(group, index) in highlightGroups"
      :key="`group-${index}`"
      class="ocr-highlight-group"
      :style="groupStyle(group.box)"
    ></span>
    <span
      v-for="line in sortedLines"
      :key="line.id"
      class="ocr-text-line"
      :class="{
        'is-highlighted': highlightedLineIds.has(line.id),
        'is-accented': accentedLineIds.has(line.id),
        'is-copied': copiedLineId === line.id,
        'is-static': interactive === false
      }"
      :title="interactive === false ? line.text : `${line.text}（点击复制）`"
      :style="lineStyle(line.box as [number, number, number, number])"
      @click.stop="interactive === false ? undefined : copyLineText(line)"
    >{{ line.text }}</span>
    <Teleport to="body">
    <span
      class="ocr-copy-toast"
      :class="{ 'is-visible': copiedLineId }"
      :style="{ left: `${toastPosition.left}px`, top: `${toastPosition.top}px` }"
    >已复制</span>
    </Teleport>
  </div>
</template>

<style scoped>
.ocr-text-overlay {
  position: absolute;
  inset: 0;
  pointer-events: none;
  user-select: text;
}

.ocr-text-line {
  position: absolute;
  display: block;
  white-space: nowrap;
  overflow: hidden;
  color: transparent;
  text-shadow: 0 0 2px rgba(0, 0, 0, 0.85);
  font-size: 0;
  line-height: 1;
  border-radius: 2px;
  pointer-events: auto;
  cursor: text;
  /* 叠加层开启时给所有文字行一层淡色衬底，让用户能直接看到可选区域；
     否则开关切换在图上毫无反馈，容易被误认为没生效 */
  background-color: rgba(59, 130, 246, 0.13);
  box-shadow: inset 0 0 0 1px rgba(59, 130, 246, 0.18);
  transition: background-color 0.15s, color 0.15s, text-shadow 0.15s;
}

.ocr-text-line:hover {
  color: #fff;
  background-color: rgba(59, 130, 246, 0.55);
  text-shadow: 0 0 2px rgba(0, 0, 0, 0.9);
}

/* 表格行整体标记：同一行的指标名、结果值、参考值合并成一个描边矩形框，
   用描边 + 极淡底色代替实心填充，不再遮挡原文内容。
   出现时阴影呼吸三次（大小、透明度、颜色联动渐变）引导视线，之后静止。 */
.ocr-highlight-group {
  position: absolute;
  display: block;
  border: 1.5px solid rgba(217, 119, 6, 0.85);
  border-radius: 4px;
  background-color: rgba(251, 191, 36, 0.08);
  pointer-events: none;
  box-shadow: 0 0 4px 0 rgba(245, 158, 11, 0.25);
  animation: ocr-shadow-breathe 1.6s ease-in-out 3;
}

@keyframes ocr-shadow-breathe {
  0%, 100% {
    box-shadow: 0 0 4px 0 rgba(245, 158, 11, 0.25);
  }
  50% {
    box-shadow: 0 0 16px 4px rgba(233, 151, 48, 0.5);
  }
}

/* 行框承担整行的标记语义后，单个高亮行本身保持透明，
   交互模式下悬停/复制的反馈仍走基础样式。 */
.ocr-text-line.is-highlighted {
  background-color: transparent;
  box-shadow: none;
}

.ocr-text-line.is-static {
  pointer-events: none;
  /* 静态回显（趋势原件定位）下行不可交互，蓝色衬底只是噪音：
     只保留行框标记。 */
  background-color: transparent;
  box-shadow: none;
}

/* 趋势溯源中结果格使用更明确的内框；半栏外框负责说明指标范围，结果内框负责
   指出实际进入趋势的数值，避免双栏报告中用户无法判断选中了哪一个结果。 */
.ocr-text-line.is-accented {
  background-color: rgba(245, 158, 11, 0.2);
  box-shadow: inset 0 0 0 1.5px rgba(217, 119, 6, 0.95);
}

.ocr-text-line::selection {
  background-color: rgba(59, 130, 246, 0.65);
  color: #fff;
  text-shadow: none;
}

.ocr-text-line.is-copied {
  background-color: rgba(22, 163, 74, 0.5);
  box-shadow: inset 0 0 0 1px rgba(22, 163, 74, 0.65);
}

.ocr-copy-toast {
  /* 图片往往高于可视区域，用 fixed 保证提示落在视口内 */
  position: fixed;
  z-index: 160;
  transform: translate(-50%, calc(-50% + 6px));
  padding: 7px 16px;
  border-radius: 999px;
  background: rgba(17, 20, 24, 0.88);
  color: #fff;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0;
  /* 与全局 toast 同一规则：显式 max-content 避免 left 偏移压缩 shrink-to-fit 可用宽，
     内容最大占屏宽 90%，超出才换行 */
  width: max-content;
  max-width: 90vw;
  text-align: center;
  pointer-events: none;
  opacity: 0;
  transition: opacity 0.18s, transform 0.18s;
}

.ocr-copy-toast.is-visible {
  opacity: 1;
  transform: translate(-50%, -50%);
}
</style>
