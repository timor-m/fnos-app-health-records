<script setup lang="ts">
import { ref } from 'vue';
import FormSelect from './FormSelect.vue';

const props = defineProps<{
  modelValue: string;
  options: { value: string; label: string }[];
  label: string;
  name?: string;
  maxlength?: string | number;
  placeholder?: string;
  disabled?: boolean;
}>();
const emit = defineEmits<{ 'update:modelValue': [value: string] }>();
const root = ref<HTMLElement | null>(null);
function openOptions() {
  root.value?.querySelector<HTMLButtonElement>('.form-select-trigger')?.click();
}
</script>

<template>
  <div ref="root" class="form-suggest" :class="{ disabled }">
    <input :value="modelValue" :name="name" :maxlength="maxlength" :disabled="disabled"
      :aria-label="label" :placeholder="placeholder || '选择或填写'" autocomplete="off"
      @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)"
      @keydown.down.prevent="openOptions" />
    <FormSelect :model-value="modelValue" :options="[{ value: '', label: '不填写' }, ...props.options]"
      :disabled="disabled" :ariaLabel="`选择${label}常用值`" :panel-min-width="220"
      @update:model-value="emit('update:modelValue', $event)" />
  </div>
</template>

<style scoped>
.form-suggest { display: flex; align-items: stretch; width: 100%; min-width: 0; min-height: var(--form-suggest-height,44px); border: 1px solid var(--line-strong); border-radius: 10px; background: var(--surface); color: var(--ink); }
.form-suggest:focus-within { border-color: var(--brand); box-shadow: 0 0 0 3px var(--brand-soft); }
.form-suggest > input { display: block; flex: 1; width: 0; min-width: 0; min-height: 0; margin: 0; padding: var(--form-suggest-padding,11px) 0 var(--form-suggest-padding,11px) 12px; border: 0; border-radius: 10px 0 0 10px; background: transparent; box-shadow: none; color: inherit; font: inherit; font-size: 14px; line-height: 20px; }
.form-suggest > input:focus { outline: 0; box-shadow: none; }
.form-suggest > input::placeholder { color: var(--arrow-muted); }
.form-suggest > :deep(.form-select) { flex: 0 0 36px; width: 36px; }
.form-suggest :deep(.form-select-trigger) { height: 100%; min-height: calc(var(--form-suggest-height,44px) - 2px); padding: 0; justify-content: center; gap: 0; border: 0; border-radius: 0 10px 10px 0; background: transparent; box-shadow: none; }
.form-suggest :deep(.form-select-trigger > span) { display: none; }
.form-suggest :deep(.form-select-trigger:hover:not(:disabled)) { background: var(--fill-2); }
.form-suggest.disabled { opacity: .55; }
.form-suggest :deep(.form-select.disabled .form-select-trigger) { opacity: 1; }
</style>
