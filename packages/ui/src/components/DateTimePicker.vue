<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { CalendarDays, Check, X } from "@lucide/vue";
import { useScrollLock } from "../composables/useScrollLock";
import { DATE_WHEEL_ITEM_HEIGHT, dateWheelStep, dateWheelIndex, clampCalendarDay } from "../utils/date-wheel";

const props = defineProps<{
  modelValue: string | null;
  label?: string;
  disabled?: boolean;
  showTime?: boolean;
  ariaLabel?: string;
  minYear?: number;
  maxYear?: number;
}>();
const emit = defineEmits<{ "update:modelValue": [value: string | null] }>();

const open = ref(false);
const root = ref<HTMLElement | null>(null);
const layer = ref<HTMLElement | null>(null);
const panelStyle = ref<Record<string, string>>({});
const lockScroll = ref(false);
useScrollLock(computed(() => open.value && lockScroll.value));

// 滚轮 DOM 引用
const wheelYear = ref<HTMLElement | null>(null);
const wheelMonth = ref<HTMLElement | null>(null);
const wheelDay = ref<HTMLElement | null>(null);
const wheelHour = ref<HTMLElement | null>(null);
const wheelMinute = ref<HTMLElement | null>(null);

const wheelRefs: Record<string, { value: HTMLElement | null }> = {
  year: wheelYear,
  month: wheelMonth,
  day: wheelDay,
  hour: wheelHour,
  minute: wheelMinute,
};

// 解析当前值
const parsedDate = computed(() => {
  if (!props.modelValue) return null;
  const match = props.modelValue.match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!match) return null;
  return {
    year: parseInt(match[1]),
    month: parseInt(match[2]),
    day: parseInt(match[3]),
    hour: match[4] ? parseInt(match[4]) : 0,
    minute: match[5] ? parseInt(match[5]) : 0,
  };
});

// 滚轮选中值
const selectedYear = ref(new Date().getFullYear());
const selectedMonth = ref(1);
const selectedDay = ref(1);
const selectedHour = ref(0);
const selectedMinute = ref(0);
const displayedYear = ref(selectedYear.value);
const displayedMonth = ref(selectedMonth.value);
const currentYear = new Date().getFullYear();

watch(open, (value) => {
  clearWheelState();
  if (value) {
    // 打开时初始化选中值
    if (parsedDate.value) {
      selectedYear.value = parsedDate.value.year;
      selectedMonth.value = parsedDate.value.month;
      selectedDay.value = parsedDate.value.day;
      selectedHour.value = parsedDate.value.hour;
      selectedMinute.value = parsedDate.value.minute;
    } else {
      const now = new Date();
      selectedYear.value = now.getFullYear();
      selectedMonth.value = now.getMonth() + 1;
      selectedDay.value = now.getDate();
      selectedHour.value = now.getHours();
      selectedMinute.value = now.getMinutes();
    }
    displayedYear.value = selectedYear.value;
    displayedMonth.value = selectedMonth.value;
    // 等待 DOM 更新后滚动到选中位置
    nextTick(() => {
      scrollToSelected();
    });
  }
});

// 生成滚轮数据
const years = computed(() => {
  const configuredMin = Number.isInteger(props.minYear) ? Number(props.minYear) : 1900;
  const configuredMax = Number.isInteger(props.maxYear) ? Number(props.maxYear) : currentYear + 20;
  const existingYear = parsedDate.value?.year;
  const start = Math.min(configuredMin, configuredMax, existingYear ?? configuredMin);
  const end = Math.max(configuredMin, configuredMax, existingYear ?? configuredMax);
  return Array.from({ length: end - start + 1 }, (_, i) => start + i);
});

const months = computed(() => Array.from({ length: 12 }, (_, i) => i + 1));

const days = computed(() => {
  const daysInMonth = new Date(displayedYear.value, displayedMonth.value, 0).getDate();
  return Array.from({ length: daysInMonth }, (_, i) => i + 1);
});

const hours = computed(() => Array.from({ length: 24 }, (_, i) => i));
const minutes = computed(() => Array.from({ length: 60 }, (_, i) => i));

// 格式化显示
function padZero(n: number): string {
  return n.toString().padStart(2, "0");
}

function formatValue(): string | null {
  const y = selectedYear.value;
  const m = padZero(selectedMonth.value);
  const d = padZero(selectedDay.value);
  if (!props.showTime) return `${y}-${m}-${d}`;
  const h = padZero(selectedHour.value);
  const min = padZero(selectedMinute.value);
  return `${y}-${m}-${d}T${h}:${min}`;
}

function displayValue(): string {
  if (!parsedDate.value) return props.label || "请选择";
  const { year, month, day, hour, minute } = parsedDate.value;
  if (!props.showTime) return `${year}-${padZero(month)}-${padZero(day)}`;
  return `${year}-${padZero(month)}-${padZero(day)} ${padZero(hour)}:${padZero(minute)}`;
}

// 滚轮滚动处理（带自动吸附）
let scrollTimers: Record<string, ReturnType<typeof setTimeout>> = {};
type WheelType = "year" | "month" | "day" | "hour" | "minute";
const ITEM_HEIGHT = DATE_WHEEL_ITEM_HEIGHT;
let positioned: Partial<Record<WheelType, number>> = {};
let wheelRemainder: Partial<Record<WheelType, number>> = {};
let wheelLastAt: Partial<Record<WheelType, number>> = {};
const touching = new Set<WheelType>();
let drag: { type: WheelType; element: HTMLElement; pointerId: number; startY: number; startTop: number } | null = null;
const BUFFER_SIZE = 100; // 循环缓冲项数量（足够大以实现平滑循环）

// 获取缓冲后的选项数组
function getBufferedOptions(type: "year" | "month" | "day" | "hour" | "minute"): number[] {
  let options: number[];
  switch (type) {
    case "year": options = years.value; break;
    case "month": options = months.value; break;
    case "day": options = days.value; break;
    case "hour": options = hours.value; break;
    case "minute": options = minutes.value; break;
  }
  // 关键：缓冲区大小不超过原始数组长度，避免重复
  const bufSize = Math.min(BUFFER_SIZE, options.length);
  const front = options.slice(-bufSize);
  const back = options.slice(0, bufSize);
  return [...front, ...options, ...back];
}

// 获取原始选项数组
function getOriginalOptions(type: "year" | "month" | "day" | "hour" | "minute"): number[] {
  switch (type) {
    case "year": return years.value;
    case "month": return months.value;
    case "day": return days.value;
    case "hour": return hours.value;
    case "minute": return minutes.value;
  }
}

// 获取实际缓冲区大小
function getBufSize(type: "year" | "month" | "day" | "hour" | "minute"): number {
  const options = getOriginalOptions(type);
  return Math.min(BUFFER_SIZE, options.length);
}

// 更新选中值
function updateSelectedValue(type: "year" | "month" | "day" | "hour" | "minute", value: number) {
  switch (type) {
    case "year": selectedYear.value = value; break;
    case "month": selectedMonth.value = value; break;
    case "day": selectedDay.value = value; break;
    case "hour": selectedHour.value = value; break;
    case "minute": selectedMinute.value = value; break;
  }
}

// 获取当前选中值
function getSelectedValue(type: "year" | "month" | "day" | "hour" | "minute"): number {
  switch (type) {
    case "year": return selectedYear.value;
    case "month": return selectedMonth.value;
    case "day": return selectedDay.value;
    case "hour": return selectedHour.value;
    case "minute": return selectedMinute.value;
  }
}

// Native touch scrolling only reads the selection. Recenter the loop after
// scrolling settles, never while momentum is still moving the column.
function onScroll(e: Event, type: WheelType) {
  const el = e.target as HTMLElement;
  if (!open.value || Math.abs(el.scrollTop - (positioned[type] ?? -10000)) < 0.5) return;
  delete positioned[type];
  const options = getOriginalOptions(type);
  const index = dateWheelIndex(Math.round(el.scrollTop / ITEM_HEIGHT) - getBufSize(type), options.length);
  updateSelectedValue(type, options[index]);
  clearTimeout(scrollTimers[type]);
  scrollTimers[type] = setTimeout(() => {
    if (!touching.has(type) && drag?.type !== type) snapToNearest(type);
  }, 180);
}

function positionColumn(type: WheelType) {
  const el = wheelRefs[type].value;
  if (!el || !open.value) return;
  const index = getOriginalOptions(type).indexOf(getSelectedValue(type));
  if (index < 0) return;
  const top = (index + getBufSize(type)) * ITEM_HEIGHT;
  positioned[type] = top;
  el.scrollTop = top;
}

function syncCalendarDays() {
  const previousLength = days.value.length;
  displayedYear.value = selectedYear.value;
  displayedMonth.value = selectedMonth.value;
  selectedDay.value = clampCalendarDay(selectedYear.value, selectedMonth.value, selectedDay.value);
  // Even an unchanged day needs repositioning when the front buffer shrinks.
  if (days.value.length !== previousLength) {
    clearTimeout(scrollTimers.day);
    nextTick(() => positionColumn("day"));
  }
}

function snapToNearest(type: WheelType) {
  clearTimeout(scrollTimers[type]);
  if (type === "year" || type === "month") syncCalendarDays();
  positionColumn(type);
}

function onWheel(event: WheelEvent, type: WheelType) {
  if (event.ctrlKey) return; // Preserve browser pinch-to-zoom.
  event.preventDefault();
  if (drag) return;
  if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
  const now = performance.now();
  const previous = now - (wheelLastAt[type] ?? 0) > 180 ? 0 : wheelRemainder[type] || 0;
  const result = dateWheelStep(previous, event.deltaY, event.deltaMode);
  wheelRemainder[type] = result.remainder;
  wheelLastAt[type] = now;
  if (!result.step) return;
  const options = getOriginalOptions(type);
  const index = dateWheelIndex(options.indexOf(getSelectedValue(type)) + result.step, options.length);
  updateSelectedValue(type, options[index]);
  snapToNearest(type);
}

function endTouch(type: WheelType) {
  touching.delete(type);
  clearTimeout(scrollTimers[type]);
  scrollTimers[type] = setTimeout(() => snapToNearest(type), 180);
}

function startDrag(event: PointerEvent, type: WheelType) {
  // Touch keeps browser-native momentum; mouse/pen use explicit capture so
  // releasing outside the column cannot leave it stuck in dragging state.
  if (event.pointerType === "touch" || event.button !== 0 || drag) return;
  const element = event.currentTarget as HTMLElement;
  event.preventDefault();
  clearTimeout(scrollTimers[type]);
  drag = { type, element, pointerId: event.pointerId, startY: event.clientY, startTop: element.scrollTop };
  element.setPointerCapture(event.pointerId);
}

function moveDrag(event: PointerEvent) {
  if (!drag || event.pointerId !== drag.pointerId) return;
  event.preventDefault();
  const { element, startTop, startY, type } = drag;
  element.scrollTop = startTop + startY - event.clientY;
  // Read immediately: pointerup can precede the browser's next scroll event.
  const options = getOriginalOptions(type);
  updateSelectedValue(type, options[dateWheelIndex(Math.round(element.scrollTop / ITEM_HEIGHT) - getBufSize(type), options.length)]);
}

function releaseDrag() {
  const current = drag;
  drag = null;
  if (current?.element.hasPointerCapture(current.pointerId)) current.element.releasePointerCapture(current.pointerId);
  return current;
}

function endDrag(event: PointerEvent) {
  if (!drag || event.pointerId !== drag.pointerId) return;
  const current = releaseDrag();
  if (current && open.value) snapToNearest(current.type);
}

function clearWheelState() {
  releaseDrag();
  Object.values(scrollTimers).forEach(clearTimeout);
  scrollTimers = {};
  positioned = {};
  wheelRemainder = {};
  wheelLastAt = {};
  touching.clear();
}

function scrollToSelected() {
  for (const type of ["year", "month", "day", ...(props.showTime ? ["hour", "minute"] : [])] as WheelType[]) {
    positionColumn(type);
  }
}

// 确认选择
function confirm() {
  syncCalendarDays();
  emit("update:modelValue", formatValue());
  open.value = false;
}

// 取消
function cancel() {
  open.value = false;
}

function updatePanelPosition() {
  if (!open.value || !root.value) return;
  const trigger = root.value.getBoundingClientRect();
  const panelWidth = Math.min(460, window.innerWidth - 32);
  const left = Math.max(16, Math.min(trigger.left, window.innerWidth - panelWidth - 16));
  panelStyle.value = {
    top: `${trigger.bottom + 8}px`,
    left: `${left}px`,
  };
}

// 点击外部关闭
function onDocPointerDown(event: Event) {
  const target = event.target as Node;
  if (root.value?.contains(target) || layer.value?.contains(target)) return;
  open.value = false;
}

watch(open, (value) => {
  const action = value ? "addEventListener" : "removeEventListener";
  document[action]("mousedown", onDocPointerDown);
  document[action]("touchstart", onDocPointerDown);
  window[action]("resize", updatePanelPosition);
  window[action]("scroll", updatePanelPosition, true);
  if (value) nextTick(updatePanelPosition);
});

onBeforeUnmount(() => {
  clearWheelState();
  document.removeEventListener("mousedown", onDocPointerDown);
  document.removeEventListener("touchstart", onDocPointerDown);
  window.removeEventListener("resize", updatePanelPosition);
  window.removeEventListener("scroll", updatePanelPosition, true);
});
</script>

<template>
  <div ref="root" class="datetime-picker" :class="{ disabled }">
    <button
      type="button"
      class="datetime-picker-trigger"
      :disabled="disabled"
      :aria-label="ariaLabel"
      @click="open = true"
    >
      <CalendarDays class="datetime-picker-trigger-icon" :size="17" aria-hidden="true" />
      <span :class="{ placeholder: !modelValue }">{{ displayValue() }}</span>
    </button>
    <Teleport to="body">
      <!-- click 关闭遮罩避免透穿；touchstart.prevent 阻止触屏合成 click 落到底层元素 -->
      <div v-if="open" ref="layer" class="datetime-picker-layer" @click.self="cancel" @touchstart.self.prevent="cancel">
        <div class="datetime-picker-panel" :style="panelStyle" role="dialog" aria-modal="true" :aria-label="label || '请选择时间'">
            <div class="datetime-picker-header">
              <button type="button" class="datetime-picker-cancel" @click="cancel">
                <X :size="18" />
              </button>
              <span class="datetime-picker-title">{{ label || "请选择时间" }}</span>
              <button type="button" class="datetime-picker-confirm" @click="confirm">
                <Check :size="18" />
              </button>
            </div>
            <div class="datetime-picker-wheels">
              <div class="datetime-picker-wheel">
                <span class="datetime-wheel-label">年</span>
                <div class="wheel-scroll-wrapper">
                  <div ref="wheelYear" class="wheel-scroll"
                    @pointerdown="startDrag($event, 'year')" @pointermove="moveDrag" @pointerup="endDrag" @pointercancel="endDrag" @lostpointercapture="endDrag" @scroll="onScroll($event, 'year')" @wheel="onWheel($event, 'year')" @touchstart.passive="touching.add('year')" @touchend="endTouch('year')" @touchcancel="endTouch('year')">
                    <div class="datetime-wheel-item" v-for="(y, idx) in getBufferedOptions('year')" :key="`year-${idx}`" :class="{ selected: y === selectedYear }">{{ y }}</div>
                  </div>
                </div>
              </div>
              <div class="datetime-picker-wheel">
                <span class="datetime-wheel-label">月</span>
                <div class="wheel-scroll-wrapper">
                  <div ref="wheelMonth" class="wheel-scroll"
                    @pointerdown="startDrag($event, 'month')" @pointermove="moveDrag" @pointerup="endDrag" @pointercancel="endDrag" @lostpointercapture="endDrag" @scroll="onScroll($event, 'month')" @wheel="onWheel($event, 'month')" @touchstart.passive="touching.add('month')" @touchend="endTouch('month')" @touchcancel="endTouch('month')">
                    <div class="datetime-wheel-item" v-for="(m, idx) in getBufferedOptions('month')" :key="`month-${idx}`" :class="{ selected: m === selectedMonth }">{{ padZero(m) }}</div>
                  </div>
                </div>
              </div>
              <div class="datetime-picker-wheel">
                <span class="datetime-wheel-label">日</span>
                <div class="wheel-scroll-wrapper">
                  <div ref="wheelDay" class="wheel-scroll"
                    @pointerdown="startDrag($event, 'day')" @pointermove="moveDrag" @pointerup="endDrag" @pointercancel="endDrag" @lostpointercapture="endDrag" @scroll="onScroll($event, 'day')" @wheel="onWheel($event, 'day')" @touchstart.passive="touching.add('day')" @touchend="endTouch('day')" @touchcancel="endTouch('day')">
                    <div class="datetime-wheel-item" v-for="(d, idx) in getBufferedOptions('day')" :key="`day-${idx}`" :class="{ selected: d === selectedDay }">{{ padZero(d) }}</div>
                  </div>
                </div>
              </div>
              <template v-if="showTime">
                <div class="datetime-picker-wheel">
                  <span class="datetime-wheel-label">时</span>
                  <div class="wheel-scroll-wrapper">
                    <div ref="wheelHour" class="wheel-scroll"
                    @pointerdown="startDrag($event, 'hour')" @pointermove="moveDrag" @pointerup="endDrag" @pointercancel="endDrag" @lostpointercapture="endDrag" @scroll="onScroll($event, 'hour')" @wheel="onWheel($event, 'hour')" @touchstart.passive="touching.add('hour')" @touchend="endTouch('hour')" @touchcancel="endTouch('hour')">
                      <div class="datetime-wheel-item" v-for="(h, idx) in getBufferedOptions('hour')" :key="`hour-${idx}`" :class="{ selected: h === selectedHour }">{{ padZero(h) }}</div>
                    </div>
                  </div>
                </div>
                <div class="datetime-picker-wheel">
                  <span class="datetime-wheel-label">分</span>
                  <div class="wheel-scroll-wrapper">
                    <div ref="wheelMinute" class="wheel-scroll"
                    @pointerdown="startDrag($event, 'minute')" @pointermove="moveDrag" @pointerup="endDrag" @pointercancel="endDrag" @lostpointercapture="endDrag" @scroll="onScroll($event, 'minute')" @wheel="onWheel($event, 'minute')" @touchstart.passive="touching.add('minute')" @touchend="endTouch('minute')" @touchcancel="endTouch('minute')">
                      <div class="datetime-wheel-item" v-for="(min, idx) in getBufferedOptions('minute')" :key="`minute-${idx}`" :class="{ selected: min === selectedMinute }">{{ padZero(min) }}</div>
                    </div>
                  </div>
                </div>
              </template>
            </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.datetime-picker { display: block; width: 100%; min-width: 0; }
.datetime-picker.compact-filter { width: auto; min-width: 0; padding: 0; background: transparent; box-shadow: none; }

.datetime-picker input {
  display: block; width: 100%; min-height: 44px; padding-block: 0;
  line-height: normal; text-align: left; font-variant-numeric: tabular-nums;
}

.datetime-picker-trigger {
  display: flex; align-items: center; width: 100%; min-height: 44px;
  padding: 0 12px; border: 1px solid var(--line); border-radius: 10px;
  background: var(--surface); color: var(--ink); font-size: 15px;
  text-align: left; cursor: pointer; transition: border-color .15s;
}
.datetime-picker-trigger-icon { flex: 0 0 auto; margin-right: 8px; color: var(--muted); }
.datetime-picker-trigger:focus { border-color: var(--brand); outline: none; }
.datetime-picker-trigger .placeholder { color: var(--muted); }
.datetime-picker.compact-filter .datetime-picker-trigger {
  min-height: 38px;
  padding-inline: 10px;
  border: 0;
  box-shadow: var(--shadow-s);
  font-size: 13px;
}

/* PC 上触发器同步收紧到桌面表单密度，移动端保持 44px 触控目标 */
@media (min-width: 761px) and (pointer: fine) {
  .datetime-picker-trigger { min-height: 36px; font-size: 13px; }
}
</style>
