<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { CalendarDays, Check, X } from "@lucide/vue";
import { useScrollLock } from "../composables/useScrollLock";

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
const ITEM_HEIGHT = 40;
const HIGHLIGHT_TOP = 0; // 高亮框距离顶部的距离
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

// 滚轮滚动处理（带自动吸附和循环）
function onScroll(e: Event, type: "year" | "month" | "day" | "hour" | "minute") {
  const el = e.target as HTMLElement;
  const scrollTop = el.scrollTop;
  const originalOptions = getOriginalOptions(type);
  const originalLength = originalOptions.length;
  const bufSize = getBufSize(type);

  // 计算当前选中的索引（考虑高亮框偏移）
  const adjustedScrollTop = scrollTop - HIGHLIGHT_TOP;
  let bufferedIndex = Math.round(adjustedScrollTop / ITEM_HEIGHT);
  
  // 计算原始索引（减去缓冲偏移）
  let originalIndex = bufferedIndex - bufSize;
  
  // 循环跳转：如果超出原始范围，立即跳转到另一端
  if (originalIndex < 0) {
    // 到达顶部，跳转到底部（保持在缓冲区内）
    originalIndex = originalLength + originalIndex;
    const newBufferedIndex = originalIndex + bufSize;
    el.scrollTop = newBufferedIndex * ITEM_HEIGHT + HIGHLIGHT_TOP;
  } else if (originalIndex >= originalLength) {
    // 到达底部，跳转到顶部（保持在缓冲区内）
    originalIndex = originalIndex - originalLength;
    const newBufferedIndex = originalIndex + bufSize;
    el.scrollTop = newBufferedIndex * ITEM_HEIGHT + HIGHLIGHT_TOP;
  }
  
  // 更新选中值
  updateSelectedValue(type, originalOptions[originalIndex]);

  // 清除之前的定时器
  if (scrollTimers[type]) {
    clearTimeout(scrollTimers[type]);
  }

  // 设置新的定时器，滚动停止后自动吸附
  scrollTimers[type] = setTimeout(() => {
    snapToNearest(type);
  }, 100);
}

// 自动吸附到最近的选项
function snapToNearest(type: "year" | "month" | "day" | "hour" | "minute") {
  const el = wheelRefs[type].value;
  if (!el) return;

  const currentValue = getSelectedValue(type);
  const originalOptions = getOriginalOptions(type);
  const originalIndex = originalOptions.indexOf(currentValue);
  const bufSize = getBufSize(type);

  // 计算目标滚动位置，使选项居中在高亮框内
  const bufferedIndex = originalIndex + bufSize;
  const targetScrollTop = bufferedIndex * ITEM_HEIGHT + HIGHLIGHT_TOP;

  // 月份滚动完成后才刷新日列，避免日列跟随每个滚动事件反复重排。
  if (type === "year" || type === "month") {
    const nextYear = type === "year" ? currentValue : selectedYear.value;
    const nextMonth = type === "month" ? currentValue : selectedMonth.value;
    displayedYear.value = nextYear;
    displayedMonth.value = nextMonth;
    const daysInMonth = new Date(nextYear, nextMonth, 0).getDate();
    const dayWasClamped = selectedDay.value > daysInMonth;
    if (dayWasClamped) {
      selectedDay.value = daysInMonth;
      nextTick(() => {
        const dayEl = wheelDay.value;
        if (!dayEl) return;
        const dayIndex = days.value.indexOf(selectedDay.value);
        const dayBufSize = getBufSize("day");
        dayEl.scrollTop = (dayIndex + dayBufSize) * ITEM_HEIGHT + HIGHLIGHT_TOP;
      });
    }
  }
  
  // 平滑滚动到目标位置
  el.scrollTo({
    top: targetScrollTop,
    behavior: 'smooth'
  });
}

// 滚动到选中位置
function scrollToSelected() {
  const types: ("year" | "month" | "day" | "hour" | "minute")[] = ['year', 'month', 'day'];
  if (props.showTime) {
    types.push('hour', 'minute');
  }

  types.forEach(type => {
    const el = wheelRefs[type].value;
    if (!el) return;

    const currentValue = getSelectedValue(type);
    const originalOptions = getOriginalOptions(type);
    const originalIndex = originalOptions.indexOf(currentValue);
    const bufSize = getBufSize(type);
    
    if (originalIndex >= 0) {
      // 计算缓冲后的索引
      const bufferedIndex = originalIndex + bufSize;
      // 滚动到对应位置（立即滚动，不使用动画）
      el.scrollTop = bufferedIndex * ITEM_HEIGHT + HIGHLIGHT_TOP;
    }
  });
}

// 确认选择
function confirm() {
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
      <div v-if="open" ref="layer" class="datetime-picker-layer" @mousedown.self="cancel" @touchstart.self.prevent="cancel">
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
                  <div ref="wheelYear" class="wheel-scroll" @scroll="onScroll($event, 'year')">
                    <div class="datetime-wheel-item" v-for="(y, idx) in getBufferedOptions('year')" :key="`year-${idx}`" :class="{ selected: y === selectedYear }">{{ y }}</div>
                  </div>
                </div>
              </div>
              <div class="datetime-picker-wheel">
                <span class="datetime-wheel-label">月</span>
                <div class="wheel-scroll-wrapper">
                  <div ref="wheelMonth" class="wheel-scroll" @scroll="onScroll($event, 'month')">
                    <div class="datetime-wheel-item" v-for="(m, idx) in getBufferedOptions('month')" :key="`month-${idx}`" :class="{ selected: m === selectedMonth }">{{ padZero(m) }}</div>
                  </div>
                </div>
              </div>
              <div class="datetime-picker-wheel">
                <span class="datetime-wheel-label">日</span>
                <div class="wheel-scroll-wrapper">
                  <div ref="wheelDay" class="wheel-scroll" @scroll="onScroll($event, 'day')">
                    <div class="datetime-wheel-item" v-for="(d, idx) in getBufferedOptions('day')" :key="`day-${idx}`" :class="{ selected: d === selectedDay }">{{ padZero(d) }}</div>
                  </div>
                </div>
              </div>
              <template v-if="showTime">
                <div class="datetime-picker-wheel">
                  <span class="datetime-wheel-label">时</span>
                  <div class="wheel-scroll-wrapper">
                    <div ref="wheelHour" class="wheel-scroll" @scroll="onScroll($event, 'hour')">
                      <div class="datetime-wheel-item" v-for="(h, idx) in getBufferedOptions('hour')" :key="`hour-${idx}`" :class="{ selected: h === selectedHour }">{{ padZero(h) }}</div>
                    </div>
                  </div>
                </div>
                <div class="datetime-picker-wheel">
                  <span class="datetime-wheel-label">分</span>
                  <div class="wheel-scroll-wrapper">
                    <div ref="wheelMinute" class="wheel-scroll" @scroll="onScroll($event, 'minute')">
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
</style>
