<script setup lang="ts">
import { nextTick, ref } from 'vue';

const props = withDefaults(defineProps<{
  modelValue: string; disabled?: boolean; label?: string; title?: string;
}>(), { label: '症状程度', title: '程度（0～10，选填）' });
const emit = defineEmits<{ 'update:modelValue': [value: string] }>();
const values = ref<HTMLElement | null>(null);
function choose(value: string) {
  if (!props.disabled) emit('update:modelValue', value);
}
async function clear() {
  if (props.disabled) return;
  emit('update:modelValue', '');
  await nextTick();
  if (!props.disabled && props.modelValue === '') values.value?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
}
function severityHue(value: number) {
  return value <= 5 ? 160 - value * 24 : 40 - (value - 5) * 8;
}
</script>

<template>
  <div class="symptom-severity-picker" role="group" :aria-label="label">
    <div class="symptom-severity-heading">
      <span>{{ title }}</span>
      <button v-if="modelValue !== ''" type="button" :disabled="disabled" aria-label="清除程度" @click="clear">清除</button>
    </div>
    <div ref="values" class="symptom-severity-values">
      <button v-for="value in 11" :key="value" type="button" :disabled="disabled"
        :style="{ '--severity-hue': severityHue(value - 1) }"
        :aria-label="`${value - 1} / 10`" :aria-pressed="modelValue === String(value - 1)"
        @click="choose(String(value - 1))">{{ value - 1 }}</button>
    </div>
  </div>
</template>

<style scoped>
.symptom-severity-picker { --severity-tone-lightness: 28%; --severity-text-lightness: 28%; display: grid; align-content: start; gap: 6px; min-width: 0; }
.symptom-severity-heading { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 24px; color: var(--muted); font-size: 12px; line-height: 20px; }
.symptom-severity-values { display: grid; grid-template-columns: repeat(11, minmax(0, 1fr)); gap: 4px; width: 100%; max-width: 348px; min-width: 0; }
.symptom-severity-picker button { min-width: 28px; min-height: 28px; margin: 0; padding: 2px 8px; border: 1px solid transparent; border-radius: 999px; background: var(--fill-2); color: var(--muted); font: inherit; font-size: 12px; line-height: 20px; cursor: pointer; }
.symptom-severity-heading button { flex-shrink: 0; min-height: 24px; padding: 1px 6px; background: transparent; color: var(--brand-strong); }
.symptom-severity-values > button { min-width: 0; padding: 2px 0; white-space: nowrap; border-color: hsla(var(--severity-hue), 62%, 50%, .26); background: hsla(var(--severity-hue), 62%, 50%, .10); color: hsl(var(--severity-hue), 62%, var(--severity-text-lightness)); }
.symptom-severity-values > button[aria-pressed=true] { border-color: hsl(var(--severity-hue), 62%, var(--severity-tone-lightness)); background: hsl(var(--severity-hue), 62%, var(--severity-tone-lightness)); color: var(--surface); font-weight: 600; box-shadow: inset 0 0 0 1px var(--surface); }
.symptom-severity-picker button:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; }
.symptom-severity-picker button:disabled { opacity: .55; cursor: default; }
@media (hover: hover) {
  .symptom-severity-heading button:hover:not(:disabled) { background: var(--brand-soft); }
  .symptom-severity-values > button:hover:not(:disabled):not([aria-pressed=true]) { border-color: hsl(var(--severity-hue), 62%, var(--severity-tone-lightness)); background: hsla(var(--severity-hue), 62%, 50%, .18); }
}
@media (prefers-color-scheme: dark) {
  :global(:root:not([data-theme="light"]) .symptom-severity-picker) { --severity-tone-lightness: 65%; --severity-text-lightness: 75%; }
}
:global(:root[data-theme="dark"] .symptom-severity-picker) { --severity-tone-lightness: 65%; --severity-text-lightness: 75%; }
</style>
