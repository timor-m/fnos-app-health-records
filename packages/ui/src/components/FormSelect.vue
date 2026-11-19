<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { Check, ChevronDown } from "@lucide/vue";
import { useScrollLock } from "../composables/useScrollLock";

type Option = { value: string; label: string; disabled?: boolean };

const props = defineProps<{
  modelValue: string;
  options: Option[];
  placeholder?: string;
  disabled?: boolean;
  ariaLabel?: string;
  emptyText?: string;
  hint?: string;
  panelMinWidth?: number;
  panelMaxHeight?: string;
}>();
const emit = defineEmits<{ "update:modelValue": [value: string]; change: [value: string] }>();

const open = ref(false);
const root = ref<HTMLElement | null>(null);
const layer = ref<HTMLElement | null>(null);
const panel = ref<HTMLElement | null>(null);
const panelStyle = ref<Record<string, string>>({});
const panelHeightStyle = computed(() => props.panelMaxHeight ? {
  maxHeight: panelStyle.value.top
    ? `min(${props.panelMaxHeight}, calc(100vh - ${panelStyle.value.top} - 12px))`
    : props.panelMaxHeight
} : {});
const lockScroll = ref(false);
useScrollLock(computed(() => open.value && lockScroll.value));

const current = computed(() => props.options.find((option) => option.value === props.modelValue) || null);

// 桌面端面板跟随触发器定位；移动端走底部抽屉样式，不需要内联定位
function updatePanelPosition() {
  if (!open.value) return;
  const mobile = window.matchMedia("(max-width: 760px)").matches;
  lockScroll.value = mobile;
  if (mobile) {
    panelStyle.value = {};
    return;
  }
  const rect = root.value?.getBoundingClientRect();
  // Measure intrinsic content independently of the trigger's narrow width.
  // Include selected font weight so picking a long option needs no extra room.
  let contentWidth = 0;
  if (panel.value) {
    panel.value.style.width = 'max-content';
    const labels = [...panel.value.querySelectorAll<HTMLElement>('.form-select-option > span')];
    const weights = labels.map(label => label.style.fontWeight);
    labels.forEach(label => label.style.fontWeight = '600');
    contentWidth = panel.value.scrollWidth;
    labels.forEach((label, index) => label.style.fontWeight = weights[index]);
  }
  const width = rect ? Math.min(Math.max(rect.width, props.panelMinWidth || 0, contentWidth), window.innerWidth - 24) : 0;
  if (panel.value && rect) panel.value.style.width = `${width}px`;
  const below = rect ? window.innerHeight - rect.bottom - 18 : 0;
  const above = rect ? rect.top - 18 : 0;
  const flip = below < Math.min(panel.value?.scrollHeight || 240, 240) && above > below;
  const height = Math.max(0, Math.min(240, flip ? above : below));
  panelStyle.value = rect
    ? { position: "fixed", left: `${Math.max(12, Math.min(rect.left, window.innerWidth - width - 12))}px`,
      ...(flip ? { bottom: `${window.innerHeight - rect.top + 6}px` } : { top: `${rect.bottom + 6}px` }),
      maxHeight: `${height}px`, width: `${width}px` }
    : {};
}

watch(() => [props.options, props.panelMinWidth], () => { if (open.value) nextTick(updatePanelPosition); }, { deep: true });

function toggle() {
  if (props.disabled) return;
  // 打开前同步确定是否锁定滚动，避免等 nextTick 定位的那一拍出现滚动窗口
  if (!open.value) lockScroll.value = window.matchMedia("(max-width: 760px)").matches;
  open.value = !open.value;
}

function pick(option: Option) {
  if (props.disabled || option.disabled) return;
  emit("update:modelValue", option.value);
  emit("change", option.value);
  open.value = false;
  root.value?.querySelector<HTMLButtonElement>('button')?.focus();
}

watch(() => props.disabled, (disabled) => { if (disabled) open.value = false; });

function onDocPointerDown(event: Event) {
  const target = event.target as Node;
  if (root.value?.contains(target) || layer.value?.contains(target)) return;
  open.value = false;
}
function onKeydown(event: Event) {
  if (!(event instanceof KeyboardEvent) || !open.value) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    open.value = false;
    root.value?.querySelector<HTMLButtonElement>('button')?.focus();
    return;
  }
  const buttons = [...(panel.value?.querySelectorAll<HTMLButtonElement>('.form-select-option:not(:disabled)') || [])];
  if (!buttons.length || !panel.value?.contains(document.activeElement)) return;
  const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
  if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
      : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next]?.focus();
  } else if (event.key === 'Tab') {
    // Resume normal form tab order from the trigger, rather than the teleported panel.
    open.value = false;
    root.value?.querySelector<HTMLButtonElement>('button')?.focus();
  }
}

watch(open, (value) => {
  const action = value ? "addEventListener" : "removeEventListener";
  document[action]("mousedown", onDocPointerDown);
  document[action]("touchstart", onDocPointerDown);
  window[action]("keydown", onKeydown);
  window[action]("resize", updatePanelPosition);
  window[action]("scroll", updatePanelPosition, true);
  if (value) nextTick(() => {
    updatePanelPosition();
    (panel.value?.querySelector<HTMLButtonElement>('.form-select-option.selected:not(:disabled)')
      || panel.value?.querySelector<HTMLButtonElement>('.form-select-option:not(:disabled)'))?.focus();
  });
});
onBeforeUnmount(() => {
  document.removeEventListener("mousedown", onDocPointerDown);
  document.removeEventListener("touchstart", onDocPointerDown);
  window.removeEventListener("keydown", onKeydown);
  window.removeEventListener("resize", updatePanelPosition);
  window.removeEventListener("scroll", updatePanelPosition, true);
});
</script>

<template>
  <div ref="root" class="form-select" :class="{ open, disabled }">
    <button
      type="button" class="form-select-trigger" :disabled="disabled"
      :aria-label="ariaLabel" :aria-expanded="open" aria-haspopup="listbox"
      @click="toggle"
    >
      <span :class="{ placeholder: !current }" :title="current?.label || placeholder">{{ current?.label || placeholder || "请选择" }}</span>
      <ChevronDown :size="16" class="form-select-caret" />
    </button>
    <Teleport to="body">
      <!-- 用 click 关闭遮罩：mousedown/touchstart 提前关闭会让后续 click 透穿到底层元素 -->
      <div v-if="open" ref="layer" class="form-select-layer" @click.self="open = false">
        <div ref="panel" class="form-select-panel" :style="[panelStyle, panelHeightStyle]" role="listbox" :aria-label="ariaLabel">
          <span class="sheet-grabber" aria-hidden="true"></span>
          <slot name="panel" :pick="pick" :close="() => open = false">
          <p v-if="!options.length || hint" class="form-select-empty">{{ hint || emptyText || '暂无可选项' }}</p>
          <button
            v-for="option in options"
            :key="option.value"
            type="button"
            class="form-select-option"
            :class="{ selected: option.value === modelValue }"
            :disabled="option.disabled"
            role="option"
            :aria-selected="option.value === modelValue"
            @click="pick(option)"
          >
            <span :title="option.label">{{ option.label }}</span>
            <Check :size="16" class="form-select-check" :class="{ inactive: option.value !== modelValue }" aria-hidden="true" />
          </button>
          </slot>
        </div>
      </div>
    </Teleport>
  </div>
</template>
