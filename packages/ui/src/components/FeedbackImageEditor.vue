<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { Check, ChevronDown, Circle, Square, Pencil, RotateCcw, Undo2, X } from "@lucide/vue";
import { mosaicPixels } from "../utils/mosaic";
import { useScrollLock } from "../composables/useScrollLock";

const props = defineProps<{ file: File }>();
const emit = defineEmits<{ cancel: []; save: [file: File] }>();
type Point = { x: number; y: number };
type Stroke = { shape: "rectangle" | "ellipse"; mode: "draw" | "mask"; color: string; width: number; points: Point[] };
const canvas = ref<HTMLCanvasElement | null>(null);
const panel = ref<HTMLElement | null>(null);
const mode = ref<Stroke["mode"]>("draw");
const color = ref("#e5484d");
const size = ref(8);
const shape = ref<Stroke["shape"]>("rectangle");
const shapeMenuOpen = ref(false);
const brushSettingsOpen = ref(false);
let mosaic: HTMLCanvasElement | null = null;
function pickShape(value: Stroke["shape"]) { shape.value = value; shapeMenuOpen.value = false; }
function prepareMosaic() {
  if (mosaic || !original) return;
  const buffer = document.createElement("canvas");
  const scale = Math.min(1, 600 / Math.max(original.naturalWidth, original.naturalHeight));
  buffer.width = Math.max(1, Math.round(original.naturalWidth * scale));
  buffer.height = Math.max(1, Math.round(original.naturalHeight * scale));
  const context = buffer.getContext("2d");
  if (!context) throw new Error("当前浏览器无法生成模糊效果");
  context.drawImage(original, 0, 0, buffer.width, buffer.height);
  const pixels = context.getImageData(0, 0, buffer.width, buffer.height);
  pixels.data.set(mosaicPixels(pixels.data, buffer.width, buffer.height));
  context.putImageData(pixels, 0, 0);
  mosaic = buffer;
}
function openMaskMenu() {
  brushSettingsOpen.value = false;
  mode.value = "mask"; shapeMenuOpen.value = !shapeMenuOpen.value;
  try { prepareMosaic(); } catch { error.value = "马赛克生成失败，请重新打开图片后重试"; }
}
const strokes = ref<Stroke[]>([]);
const ready = ref(false);
const imageWidth = ref(1);
const imageHeight = ref(1);
const saving = ref(false);
const error = ref("");
const current = ref<Stroke | null>(null);
let pointerId: number | null = null;
const zoom = ref(1);
const pan = ref({ x: 0, y: 0 });
const touches = new Map<number, Point>();
let gesture: { distance: number; middle: Point; anchor: Point; zoom: number; pan: Point } | null = null;
let gestureActive = false;
function resetView() { zoom.value = 1; pan.value = { x: 0, y: 0 }; }
function beginGesture() {
  const [a, b] = [...touches.values()];
  if (!a || !b || !canvas.value) return;
  const rect = canvas.value.getBoundingClientRect();
  const middle = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  gesture = { distance: Math.max(1, Math.hypot(b.x - a.x, b.y - a.y)), middle, anchor: { x: (middle.x - rect.left) / zoom.value, y: (middle.y - rect.top) / zoom.value }, zoom: zoom.value, pan: { ...pan.value } };
  gestureActive = true;
  // The first finger may already have started a stroke. Never commit that stroke.
  current.value = null; pointerId = null; render();
}
function updateGesture() {
  if (!gesture || touches.size < 2) return;
  const [a, b] = [...touches.values()];
  const middle = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const nextZoom = Math.max(1, Math.min(5, gesture.zoom * Math.hypot(b.x - a.x, b.y - a.y) / gesture.distance));
  pan.value = {
    x: gesture.pan.x + middle.x - gesture.middle.x - gesture.anchor.x * (nextZoom - gesture.zoom),
    y: gesture.pan.y + middle.y - gesture.middle.y - gesture.anchor.y * (nextZoom - gesture.zoom)
  };
  zoom.value = nextZoom;
}
let original: HTMLImageElement | null = null;
let disposed = false;
const url = URL.createObjectURL(props.file);
const previousFocus = document.activeElement as HTMLElement | null;
useScrollLock(computed(() => true));
onBeforeUnmount(() => {
  disposed = true;
  if (original) { original.onload = null; original.onerror = null; }
  URL.revokeObjectURL(url);
  void nextTick(() => { if (previousFocus?.isConnected) previousFocus.focus(); });
});
function paintStroke(ctx: CanvasRenderingContext2D, stroke: Stroke) {
  if (!stroke.points.length) return;
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  ctx.strokeStyle = ctx.fillStyle = stroke.color;
  if (stroke.mode === "mask") {
    const first = stroke.points[0], last = stroke.points.at(-1)!;
    const x = Math.min(first.x, last.x), y = Math.min(first.y, last.y);
    const width = Math.abs(last.x - first.x), height = Math.abs(last.y - first.y);
    if (!width || !height) return;
    if (!mosaic) return;
    ctx.save(); ctx.beginPath();
    if (stroke.shape === "rectangle") ctx.rect(x, y, width, height);
    else ctx.ellipse(x + width / 2, y + height / 2, width / 2, height / 2, 0, 0, Math.PI * 2);
    ctx.clip();
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(mosaic, 0, 0, imageWidth.value, imageHeight.value);
    ctx.restore();
    return;
  }
  ctx.lineWidth = stroke.width;
  ctx.lineCap = "round"; ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.arc(stroke.points[0].x, stroke.points[0].y, stroke.width / 2, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath(); ctx.moveTo(stroke.points[0].x, stroke.points[0].y);
  for (const point of stroke.points.slice(1)) ctx.lineTo(point.x, point.y);
  ctx.stroke();
}
function render() {
  const el = canvas.value, ctx = el?.getContext("2d");
  if (!el || !ctx || !original) return;
  ctx.clearRect(0, 0, el.width, el.height);
  ctx.drawImage(original, 0, 0, el.width, el.height);
  for (const stroke of strokes.value) paintStroke(ctx, stroke);
  if (current.value) paintStroke(ctx, current.value);
}
onMounted(() => {
  panel.value?.focus();
  original = new Image();
  original.onload = () => {
    if (disposed || !canvas.value || !original) return;
    if (!original.naturalWidth || !original.naturalHeight) { error.value = "无法读取图片尺寸，请重新选择图片"; return; }
    const scale = Math.min(1, 2400 / Math.max(original.naturalWidth, original.naturalHeight));
    imageWidth.value = Math.max(1, Math.round(original.naturalWidth * scale));
    imageHeight.value = Math.max(1, Math.round(original.naturalHeight * scale));
    if (!canvas.value.getContext("2d")) { error.value = "当前浏览器无法编辑图片"; return; }
    ready.value = true; void nextTick(render);
  };
  original.onerror = () => { if (!disposed) error.value = "图片无法解码，请改用 JPG、PNG 或 WebP"; };
  original.src = url;
});
function point(event: PointerEvent): Point {
  const el = canvas.value!; const rect = el.getBoundingClientRect();
  return { x: Math.max(0, Math.min(el.width, (event.clientX - rect.left) * el.width / rect.width)), y: Math.max(0, Math.min(el.height, (event.clientY - rect.top) * el.height / rect.height)) };
}
function start(event: PointerEvent) {
  if (!ready.value || saving.value || event.button !== 0) return;
  if (event.pointerType === "touch") {
    touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
    canvas.value!.setPointerCapture(event.pointerId);
    if (touches.size >= 2) { beginGesture(); return; }
    if (gestureActive) return;
  }
  if (pointerId !== null || event.target !== canvas.value) return;
  if (mode.value === "mask" && !mosaic) return;
  shapeMenuOpen.value = false; brushSettingsOpen.value = false;
  const el = canvas.value!;
  pointerId = event.pointerId;
  el.setPointerCapture(event.pointerId);
  current.value = { shape: shape.value, mode: mode.value, color: color.value, width: Number(size.value) * el.width / el.getBoundingClientRect().width, points: [point(event)] };
  render();
}
function move(event: PointerEvent) {
  if (touches.has(event.pointerId)) {
    touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (gestureActive) { updateGesture(); return; }
  }
  if (pointerId !== event.pointerId || !current.value) return;
  if (current.value.mode === "mask") current.value.points[1] = point(event);
  else current.value.points.push(point(event));
  render();
}
function finish(event: PointerEvent) {
  touches.delete(event.pointerId);
  if (gestureActive) {
    if (touches.size < 2) gesture = null;
    if (!touches.size) gestureActive = false;
    if (canvas.value?.hasPointerCapture(event.pointerId)) canvas.value.releasePointerCapture(event.pointerId);
    return;
  }
  if (pointerId !== event.pointerId) return;
  if (current.value && event.type === "pointerup") {
    if (current.value.mode === "mask") current.value.points[1] = point(event);
    else current.value.points.push(point(event));
    const first = current.value.points[0], last = current.value.points.at(-1)!;
    if (current.value.mode === "draw" || (first.x !== last.x && first.y !== last.y)) strokes.value.push(current.value);
  }
  current.value = null; pointerId = null;
  if (canvas.value?.hasPointerCapture(event.pointerId)) canvas.value.releasePointerCapture(event.pointerId);
  render();
}
function undo() { strokes.value.pop(); render(); }
function reset() { strokes.value = []; render(); }
async function save() {
  if (!ready.value || saving.value || current.value) return;
  saving.value = true; error.value = "";
  try {
    render();
    const blob = await new Promise<Blob | null>(resolve => canvas.value!.toBlob(resolve, "image/png"));
    if (disposed) return;
    if (!blob || !blob.size) throw new Error("图片保存失败，请重试");
    if (blob.size > 10 * 1024 * 1024) throw new Error("编辑后的图片超过 10 MB，请先缩小图片再添加");
    // Export pixels only. No original file or reversible editing layers are retained.
    emit("save", new File([blob], "feedback-edited.png", { type: "image/png" }));
  } catch (cause) { error.value = cause instanceof Error ? cause.message : "图片保存失败，请重试"; }
  finally { saving.value = false; }
}
function keydown(event: KeyboardEvent) {
  event.stopPropagation();
  if (event.key === "Escape") { event.preventDefault(); if (shapeMenuOpen.value) shapeMenuOpen.value = false; else if (brushSettingsOpen.value) brushSettingsOpen.value = false; else if (!saving.value) emit("cancel"); }
  if (event.key !== "Tab") return;
  const controls = Array.from(panel.value?.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled)") || []).filter(element => element.getClientRects().length > 0);
  const first = controls[0], last = controls.at(-1);
  if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.value)) { event.preventDefault(); last?.focus(); }
  if (!event.shiftKey && (document.activeElement === last || document.activeElement === panel.value)) { event.preventDefault(); first?.focus(); }
}
</script>

<template>
  <Teleport to="body">
    <div class="sheet-backdrop image-editor-backdrop" @keydown="keydown">
      <section ref="panel" class="sheet-panel image-editor" role="dialog" aria-modal="true" aria-labelledby="image-editor-title" tabindex="-1">
        <span class="sheet-grabber" aria-hidden="true"></span>
        <header><div><h3 id="image-editor-title">编辑截图</h3><p>涂鸦标注问题，打码遮挡隐私</p></div><button class="editor-save mobile-save" :disabled="!ready || saving || !!current" @click="save">{{ saving ? '保存中…' : '完成' }}</button><button :disabled="saving" aria-label="关闭图片编辑" @click="emit('cancel')"><X :size="20" /></button></header>
        <div class="editor-toolbar">
          <div class="editor-modes"><button :aria-pressed="mode === 'draw'" :disabled="saving" @click="mode = 'draw'; shapeMenuOpen = false; brushSettingsOpen = !brushSettingsOpen"><Pencil :size="16" />涂鸦<ChevronDown class="brush-caret" :size="12" /></button><div class="mask-selector"><button :aria-pressed="mode === 'mask'" :aria-expanded="shapeMenuOpen" aria-haspopup="listbox" :disabled="saving || !ready || !!current" @click="openMaskMenu"><component :is="shape === 'rectangle' ? Square : Circle" :size="16" />打码<ChevronDown :size="14" /></button>
            <div v-if="shapeMenuOpen" class="mask-dropdown" role="listbox" aria-label="打码形状"><button role="option" :aria-selected="shape === 'rectangle'" @click="pickShape('rectangle')"><Square :size="16" /><span>矩形</span><Check v-if="shape === 'rectangle'" class="shape-check" :size="14" /></button><button role="option" :aria-selected="shape === 'ellipse'" @click="pickShape('ellipse')"><Circle :size="16" /><span>椭圆</span><Check v-if="shape === 'ellipse'" class="shape-check" :size="14" /></button></div></div></div>
          <div v-if="mode === 'draw'" class="draw-settings" :class="{ 'is-open': brushSettingsOpen }"><label class="color-picker">颜色<input v-model="color" type="color" :disabled="saving" aria-label="涂鸦颜色" /></label>
          <label class="width-picker">粗细<input v-model="size" type="range" min="3" max="24" :disabled="saving" aria-label="画笔粗细" /><span class="brush-size">{{ size }}</span></label></div>
          <button :disabled="!strokes.length || saving || !!current" class="undo-tool" aria-label="撤销上一步" @click="undo"><Undo2 :size="17" />撤销</button><button :disabled="!strokes.length || saving || !!current" class="reset-tool" @click="reset"><RotateCcw :size="16" />重置</button>
        </div>
        <div class="view-tools"><button :disabled="saving || !!current" class="reset-view" @click="resetView">{{ Math.round(zoom * 100) }}% · 恢复视图</button><span>双指缩放 · 单指编辑</span></div>
        <p class="editor-hint">{{ mode === 'mask' ? `拖动绘制${shape === 'rectangle' ? '矩形' : '椭圆'}，自动应用马赛克；双指可缩放和移动图片。` : '单指涂鸦，双指缩放和移动图片。' }}</p>
        <div class="editor-stage" @pointerdown.prevent="start" @pointermove.prevent="move" @pointerup="finish" @pointercancel="finish" @lostpointercapture="finish"><p v-if="!ready && !error">正在读取图片…</p><canvas ref="canvas" :width="imageWidth" :height="imageHeight" v-show="ready" aria-label="图片编辑画布" :style="{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }"></canvas></div>
        <p v-if="error" class="editor-error" role="alert">{{ error }}</p>
        <footer><p>仅本地处理 · 保存后替换附件<span class="export-size-note"> · 最长边不超过 2400 像素</span></p><div><button :disabled="saving" @click="emit('cancel')">取消</button><button class="editor-save" :disabled="!ready || saving || !!current" @click="save"><Check :size="16" />{{ saving ? '保存中…' : '保存图片' }}</button></div></footer>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.image-editor-backdrop { z-index: 320; }
.image-editor { width: min(900px, 100%); max-height: 94dvh; display: flex; flex-direction: column; overflow: hidden; outline: none; }
.image-editor header { display: flex; align-items: center; justify-content: space-between; padding: 18px 22px; border-bottom: 1px solid var(--line); }
h3,p { margin: 0; }h3 { font-size: 16px; }p { color: var(--muted); font-size: 12px; line-height: 1.6; }
button { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 38px; padding: 8px 12px; border: 1px solid var(--line); border-radius: 9px; background: var(--surface); color: var(--ink); font-size: 12px; cursor: pointer; }
button:disabled { opacity: .45; cursor: default; }button:focus-visible,input:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; }
.editor-toolbar { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; padding: 14px 22px 8px; }
.editor-modes { display: flex; gap: 5px; }button[aria-pressed="true"] { color: var(--brand-strong); background: var(--brand-soft); border-color: var(--brand-soft); }
label { display: inline-flex; align-items: center; gap: 6px; color: var(--muted); font-size: 12px; }input[type="color"] { width: 30px; height: 30px; padding: 2px; border: 1px solid var(--line); background: var(--surface); border-radius: 6px; }input[type="range"] { width: 90px; accent-color: var(--brand); }
.editor-hint { padding: 4px 22px 12px; }
.editor-stage { min-height: 0; overflow: auto; padding: 16px; background: var(--fill-1); text-align: center; overscroll-behavior: contain; touch-action: none; }
canvas { display: block; max-width: 100%; height: auto; margin: auto; touch-action: none; cursor: crosshair; transform-origin: top left; }
.editor-error { padding: 10px 22px; color: var(--danger); }
footer { flex-shrink: 0; padding: 16px 22px; display: flex; align-items: center; justify-content: space-between; gap: 12px; border-top: 1px solid var(--line); }footer > div { display: flex; gap: 8px; }.editor-save { background: var(--brand); color: white; border-color: var(--brand); }
@media (max-width:760px), (pointer:coarse) {
.image-editor-backdrop { padding: 0; place-items: end center; }.image-editor { width: 100%; max-height: 98dvh; border-radius: 20px 20px 0 0; animation: slide-up .22s ease; padding-bottom: 0; }.image-editor .sheet-grabber { display: block; width: 36px; height: 4px; margin: 8px auto 2px; border-radius: 999px; background: var(--grabber); flex-shrink: 0; }
.image-editor header { padding: 14px 16px; }.editor-toolbar { padding: 12px 16px 8px; gap: 8px; }.editor-hint { padding: 4px 16px 12px; }footer { padding: 14px 16px max(14px, env(safe-area-inset-bottom)); flex-wrap: wrap; }footer > div { margin-left: auto; }button { min-height: 42px; }
}
.mask-selector { position: relative; }
.mask-dropdown { position: absolute; top: calc(100% + 6px); left: 0; z-index: 6; min-width: 140px; padding: 5px; border: 1px solid var(--line); border-radius: 11px; background: var(--surface); box-shadow: var(--shadow-m); }
.mask-dropdown button { width: 100%; justify-content: flex-start; text-align: left; border: 0; }
.mask-dropdown button > svg { flex-shrink: 0; }
.mask-dropdown button[aria-selected="true"] { background: var(--brand-soft); color: var(--brand-strong); }
.mask-dropdown .shape-check { margin-left: auto; }
.draw-settings { display: flex; align-items: center; gap: 12px; }
.brush-size { min-width: 18px; text-align: right; font-variant-numeric: tabular-nums; }
.view-tools { display: flex; align-items: center; justify-content: space-between; padding: 0 22px 10px; gap: 12px; }
.view-tools > span { color: var(--muted); font-size: 12px; }
@media (max-width:760px), (pointer:coarse) {
  .image-editor { height: 98dvh; max-height: 98dvh; }
  .image-editor > .sheet-grabber { order: 0; }
  .image-editor > header { order: 1; padding: 10px 16px 12px; flex-shrink: 0; }
  .image-editor > header p { display: none; }
  .image-editor > .view-tools { order: 2; padding: 8px 16px; flex-shrink: 0; background: var(--fill-2); }
  .view-tools .reset-view { min-height: 32px; padding: 5px 9px; font-size: 12px; border: 0; background: var(--surface); }
  .image-editor > .editor-stage { order: 3; flex: 1 1 0; min-height: 100px; overflow: hidden; display: flex; align-items: center; justify-content: center; padding: 12px; }
  .editor-stage canvas { max-width: 100%; max-height: 100%; width: auto; height: auto; flex-shrink: 0; margin: 0; }
  .image-editor > .editor-hint { order: 4; padding: 8px 16px; font-size: 12px; flex-shrink: 0; }
  .image-editor > .editor-error { order: 5; padding: 4px 16px; font-size: 12px; flex-shrink: 0; }
  .image-editor > .editor-toolbar { order: 6; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; padding: 10px 16px; border-top: 1px solid var(--line); flex-shrink: 0; }
  .editor-toolbar > .editor-modes { display: contents; }
  .editor-modes > button, .mask-selector > button, .undo-tool, .reset-tool { width: 100%; min-height: 48px; padding: 8px 4px; border: 0; background: var(--fill-2); border-radius: 12px; font-size: 12px; }
  .editor-modes > button[aria-pressed="true"], .mask-selector > button[aria-pressed="true"] { background: var(--brand-soft); color: var(--brand-strong); }
  .editor-toolbar > .draw-settings { grid-column: 1 / -1; grid-row: 2; justify-content: space-between; gap: 16px; padding: 8px 10px; background: var(--fill-2); border-radius: 10px; }
  .draw-settings .color-picker { gap: 8px; }
  .draw-settings .width-picker { flex: 1; gap: 8px; }
  .draw-settings input[type="color"] { width: 34px; height: 34px; }
  .draw-settings input[type="range"] { flex: 1; min-width: 40px; width: 100%; height: 32px; }
  .mask-dropdown { top: auto; bottom: calc(100% + 8px); min-width: 150px; }
  .mask-dropdown button { min-height: 44px; }
  .image-editor > footer { order: 7; display: grid; grid-template-columns: 1fr; padding: 10px 16px max(12px, env(safe-area-inset-bottom)); gap: 8px; }
  footer > p { font-size: 12px; text-align: center; }
  .export-size-note { display: none; }
  footer > div { display: grid; grid-template-columns: 1fr 2fr; margin: 0; width: 100%; gap: 10px; }
  footer button { min-height: 44px; border-radius: 12px; }
}
@media (max-height: 540px) and (pointer: coarse) {
  .image-editor > .editor-hint, .image-editor footer > p { display: none; }
  .image-editor > .editor-toolbar { padding-block: 6px; gap: 5px; }
  .editor-toolbar > .draw-settings { padding-block: 2px; }
  .image-editor > header { padding-block: 6px; }
}
.mobile-save,.brush-caret { display: none; }
@media (max-width:760px), (pointer:coarse) {
  .image-editor { position: relative; }
  .image-editor > header { padding: 6px 12px 8px; gap: 8px; }
  .image-editor > header > div { flex: 1; }
  .image-editor header h3 { font-size: 16px; }
  .image-editor header button { min-height: 34px; padding: 6px 10px; border-radius: 8px; }
  .image-editor header .mobile-save { display: inline-flex; font-size: 12px; }
  .image-editor > .view-tools { padding: 0; position: absolute; z-index: 2; top: 68px; right: 10px; background: transparent; }
  .view-tools > span { display: none; }
  .view-tools .reset-view { min-height: 28px; padding: 4px 8px; box-shadow: var(--shadow-s); background: var(--surface); opacity: .9; }
  .image-editor > .editor-stage { padding: 4px; }
  .image-editor > .editor-hint,.image-editor > footer { display: none; }
  .image-editor > .editor-toolbar { position: relative; gap: 5px; padding: 7px 10px max(7px, env(safe-area-inset-bottom)); }
  .editor-modes > button,.mask-selector > button,.undo-tool,.reset-tool { min-height: 36px; padding: 6px 3px; border-radius: 8px; font-size: 12px; gap: 4px; }
  .editor-modes > button svg,.mask-selector > button svg,.undo-tool svg,.reset-tool svg { width: 15px; height: 15px; }
  .brush-caret { display: inline; }
  .editor-toolbar > .draw-settings { display: none; position: absolute; bottom: calc(100% + 8px); left: 10px; right: 10px; z-index: 6; padding: 10px 12px; border: 1px solid var(--line); border-radius: 12px; background: var(--surface); box-shadow: var(--shadow-m); }
  .editor-toolbar > .draw-settings.is-open { display: flex; }
  .draw-settings input[type="color"] { width: 28px; height: 28px; }
  .draw-settings input[type="range"] { height: 28px; }
}
</style>
