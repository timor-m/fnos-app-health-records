<script setup lang="ts">
import DateTimePicker from './DateTimePicker.vue';
import type {SymptomMeasurementDefinition} from '../../../shared/symptom-measurements';
defineProps<{definition:SymptomMeasurementDefinition;issue?:string;disabled?:boolean}>();
const value=defineModel<string>('value',{required:true});
const recordedAt=defineModel<string|null>('recordedAt',{required:true});
</script>
<template><section class="symptom-measurement" :aria-label="`${definition.label}测量`">
              <div class="symptom-measurement-heading"><strong>{{definition.label}}测量</strong><span>选填 · 未测量可留空</span></div>
              <div class="symptom-measurement-fields">
                <label><span>{{definition.label}}</span><div class="symptom-measurement-value"><input v-model="value" :aria-label="definition.label" :data-measurement-input="definition.id" :aria-invalid="Boolean(issue)" inputmode="decimal" :disabled="disabled" maxlength="100" placeholder="填写测量值"/><span>{{definition.unit}}</span></div></label>
                <div class="create-field"><span>测量时间</span><DateTimePicker v-model="recordedAt" show-time :aria-label="`${definition.label}测量时间`" :disabled="disabled" /></div>
              </div><p>测量时间与症状开始日期分别记录。</p><p v-if="issue" class="form-error" role="alert">{{issue}}</p>
            </section></template>
<style scoped>
.symptom-measurement { display: grid; gap: 8px; min-width: 0; padding: 12px; border: 1px solid var(--line); border-radius: 10px; background: var(--fill-1); }
.symptom-measurement-heading { display: flex; align-items: baseline; flex-wrap: wrap; gap: 6px; }
.symptom-measurement-heading strong { font-size: 14px; font-weight: 500; color: var(--ink-2); }
.symptom-measurement-heading > span, .symptom-measurement > p { margin: 0; font-size: 12px; color: var(--muted); line-height: 18px; }
.symptom-measurement > .form-error { color: var(--danger); }
.symptom-measurement-fields { display: grid; grid-template-columns: minmax(90px, 1fr) minmax(0, 2fr); gap: 10px; }
.symptom-measurement-fields > label { display: grid; align-content: start; gap: 6px; color: var(--muted); font-size: 12px; min-width: 0; }
.symptom-measurement-value { display: flex; align-items: center; min-width: 0; background: var(--surface); border: 1px solid var(--line-strong); border-radius: 10px; }
.symptom-measurement-value:focus-within { border-color: var(--brand); box-shadow: 0 0 0 3px var(--brand-soft); }
.symptom-measurement .symptom-measurement-value > input { min-width: 0; width: 0; flex: 1; border: 0; border-radius:0; box-shadow: none; background: transparent; padding: 0 8px; min-height:42px; color:var(--ink); font:inherit; font-size:14px; line-height:21px; outline:none; }
.symptom-measurement-value > span { flex-shrink: 0; padding-right: 10px; font-size: 12px; color: var(--muted); }
@media (max-width: 420px) { .symptom-measurement-fields { grid-template-columns: minmax(0, 1fr); } }

.create-field{display:grid;gap:6px;min-width:0;color:var(--muted);font-size:12px}.create-field :deep(.datetime-picker-trigger){width:100%;min-height:44px}
</style>
