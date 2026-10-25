<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { medicationUnitOptions } from '../utils/record-form-options';

const props = defineProps<{
  modelValue: string; label: string; title?: string; name?: string;
  maxlength?: string | number; disabled?: boolean;
}>();
const emit = defineEmits<{ 'update:modelValue': [value: string] }>();
const common = ['片', '粒', '袋', 'mL', 'mg', 'g'];
const extra = medicationUnitOptions.filter(option => !common.includes(option.value));
const expanded = ref(false);
const input = ref<HTMLInputElement | null>(null);
// Preserve imported spelling and custom values exactly, including unit case.
watch(() => props.modelValue, value => {
  if (value && !common.includes(value)) expanded.value = true;
}, { immediate: true });
const visibleOptions = computed(() => {
  const options = common.map(value => ({ value, label: value }));
  if (!expanded.value && props.modelValue && !common.includes(props.modelValue)) {
    options.push({ value: props.modelValue, label: props.modelValue });
  }
  return options;
});
function choose(value: string) {
  if (props.disabled) return;
  if (common.includes(value)) expanded.value = false;
  emit('update:modelValue', props.modelValue === value ? '' : value);
}
async function toggleOther() {
  if (props.disabled) return;
  expanded.value = !expanded.value;
  if (expanded.value) { await nextTick(); input.value?.focus(); }
}
</script>

<template>
  <div class="medication-unit-picker" role="group" :aria-label="label">
    <span class="medication-unit-title">{{ title || label }}</span>
    <div class="medication-unit-tags">
      <button v-for="option in visibleOptions" :key="option.value" type="button" :disabled="disabled"
        :aria-pressed="modelValue === option.value" @click="choose(option.value)">{{ option.label }}</button>
      <button type="button" class="medication-unit-other" :disabled="disabled" :aria-expanded="expanded"
        @click="toggleOther">{{ expanded ? '收起' : '其他' }}</button>
    </div>
    <template v-if="expanded">
      <div class="medication-unit-tags">
        <button v-for="option in extra" :key="option.value" type="button" :disabled="disabled"
          :aria-pressed="modelValue === option.value" @click="choose(option.value)">{{ option.label }}</button>
      </div>
      <input ref="input" :value="modelValue" :name="name" :maxlength="maxlength" :disabled="disabled"
        :aria-label="label" placeholder="也可填写其他单位" autocomplete="off"
        @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)" />
    </template>
  </div>
</template>

<style scoped>
.medication-unit-picker { display: grid; align-content: start; gap: 6px; min-width: 0; }
.medication-unit-title { color: var(--muted); font-size: 12px; line-height: 20px; }
.medication-unit-tags { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; min-width: 0; }
.medication-unit-tags > button { min-height: 28px; min-width: 28px; max-width: 100%; margin: 0; padding: 2px 8px; border: 1px solid transparent; border-radius: 999px; background: var(--fill-2); color: var(--muted); font: inherit; font-size: 12px; line-height: 20px; overflow-wrap: anywhere; cursor: pointer; }
.medication-unit-tags > button[aria-pressed=true] { border-color: var(--brand); background: var(--brand-soft); color: var(--brand-strong); }
.medication-unit-tags > .medication-unit-other { background: transparent; color: var(--brand-strong); }
.medication-unit-tags > button:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; }
.medication-unit-tags > button:disabled { opacity: .55; cursor: default; }
.medication-unit-picker > input { width: 100%; min-width: 0; min-height: var(--medication-unit-input-height, 40px); padding: 8px 10px; border: 1px solid var(--line-strong); border-radius: 10px; background: var(--surface); color: var(--ink); font: inherit; font-size: 14px; line-height: 20px; }
.medication-unit-picker > input:focus { outline: 0; border-color: var(--brand); box-shadow: 0 0 0 3px var(--brand-soft); }
@media (hover: hover) { .medication-unit-tags > button:hover:not(:disabled):not([aria-pressed=true]) { background: var(--fill-3); color: var(--ink); } }
</style>
