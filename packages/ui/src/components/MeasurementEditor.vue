<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import {
  createMeasurementTemplateIds,
  isMeasurementCanonicalKey,
  measurementIndicatorMeta,
  measurementTemplateLabels,
  resolveMeasurementTemplate,
  type MeasurementCanonicalKey,
  type MeasurementSampleInput,
  type MeasurementSession,
  type MeasurementTemplateId,
} from '../../../shared/measurements';
import DateTimePicker from './DateTimePicker.vue';
import FormSelect from './FormSelect.vue';
import { useAppContext } from '../composables/useAppContext';
import { useUnsavedRecord } from '../composables/useUnsavedRecord';
import { request } from '../utils/api';
import { createUuid } from '../utils/uuid';

const props = defineProps<{
  entry?: MeasurementSession | null;
  templateId?: MeasurementTemplateId | null;
  processId?: string;
  relatedRecords?: Array<{ kind: string; id: string }>;
  allowContinue?: boolean;
}>();
const emit = defineEmits<{ saved: [value: MeasurementSession]; cancel: []; continued: [value: MeasurementSession] }>();
const app = useAppContext();
const busy = ref(false);
const error = ref('');
const requestKey = ref(createUuid());
function initialTemplate(): MeasurementTemplateId {
  if (props.entry) return resolveMeasurementTemplate(props.entry.templateId, props.entry.items);
  if (props.templateId && (createMeasurementTemplateIds as readonly string[]).includes(props.templateId)) {
    return props.templateId;
  }
  return 'blood_pressure';
}

const form = reactive({
  templateId: initialTemplate(),
  recordedAt: props.entry?.recordedAt || localNow(),
  note: props.entry?.note || '',
  systolic: '',
  diastolic: '',
  pulse: '',
  weight: '',
  height: '',
  waist: '',
  hip: '',
  bmi: '',
  glucoseType: 'glucose_fasting' as MeasurementCanonicalKey,
  glucose: '',
  temperature: '',
  spo2: '',
  singleKey: 'vital_pulse' as MeasurementCanonicalKey,
  singleValue: '',
});
const unsaved = useUnsavedRecord(() => JSON.stringify(form), busy);

const templateOptions = createMeasurementTemplateIds.map((id) => ({
  value: id,
  label: measurementTemplateLabels[id],
}));
const glucoseOptions = [
  { value: 'glucose_fasting', label: '空腹' },
  { value: 'glucose_postprandial_2h', label: '餐后 2 小时' },
  { value: 'glucose_random', label: '随机' },
];
/** Legacy custom_single only: leftovers not covered by dedicated create templates. */
const legacySingleOptions = (['vital_pulse', 'body_height', 'body_waist_circumference', 'body_bmi'] as const)
  .map((key) => ({ value: key, label: measurementIndicatorMeta[key].displayName }));

const templateModel = computed({
  get: () => form.templateId,
  set: (value: string) => {
    if ((createMeasurementTemplateIds as readonly string[]).includes(value)) {
      form.templateId = value as MeasurementTemplateId;
    }
  },
});
const glucoseTypeModel = computed({
  get: () => form.glucoseType,
  set: (value: string) => {
    if (isMeasurementCanonicalKey(value)) form.glucoseType = value;
  },
});
const singleKeyModel = computed({
  get: () => form.singleKey,
  set: (value: string) => {
    if (isMeasurementCanonicalKey(value)) form.singleKey = value;
  },
});
const showLegacySingle = computed(() => form.templateId === 'custom_single');

watch(() => props.entry, (entry) => {
  if (!entry) return;
  form.templateId = resolveMeasurementTemplate(entry.templateId, entry.items);
  form.recordedAt = entry.recordedAt;
  form.note = entry.note || '';
  const valueOf = (key: string) => entry.items.find((item) => item.canonicalKey === key && item.origin !== 'derived');
  form.systolic = String(valueOf('vital_systolic_bp')?.numericValue ?? '');
  form.diastolic = String(valueOf('vital_diastolic_bp')?.numericValue ?? '');
  form.pulse = String(valueOf('vital_pulse')?.numericValue ?? '');
  form.weight = String(valueOf('body_weight')?.numericValue ?? '');
  form.height = String(valueOf('body_height')?.numericValue ?? '');
  form.waist = String(valueOf('body_waist_circumference')?.numericValue ?? '');
  form.hip = String(valueOf('body_hip_circumference')?.numericValue ?? '');
  form.bmi = String(valueOf('body_bmi')?.numericValue ?? '');
  const glucose = entry.items.find((item) => item.canonicalKey.startsWith('glucose_'));
  if (glucose && isMeasurementCanonicalKey(glucose.canonicalKey)) {
    form.glucoseType = glucose.canonicalKey;
    form.glucose = String(glucose.numericValue);
  }
  form.temperature = String(valueOf('vital_body_temperature')?.numericValue ?? '');
  form.spo2 = String(valueOf('vital_spo2')?.numericValue ?? '');
  const single = entry.items.find((item) => item.origin !== 'derived');
  if (single && isMeasurementCanonicalKey(single.canonicalKey)) {
    form.singleKey = single.canonicalKey;
    form.singleValue = String(single.numericValue);
  }
  unsaved.reset();
}, { immediate: true });

function localNow() {
  const date = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function sample(canonicalKey: MeasurementCanonicalKey, value: string, unit?: string) {
  const trimmed = value.trim();
  if (!trimmed) return null;
  return { canonicalKey, value: trimmed, unit: unit || measurementIndicatorMeta[canonicalKey].defaultUnit };
}

function buildSamples() {
  const samples: MeasurementSampleInput[] = [];
  if (form.templateId === 'blood_pressure') {
    const systolic = sample('vital_systolic_bp', form.systolic);
    const diastolic = sample('vital_diastolic_bp', form.diastolic);
    if (systolic) samples.push({ ...systolic, pairGroup: 'bp' });
    if (diastolic) samples.push({ ...diastolic, pairGroup: 'bp' });
    const pulse = sample('vital_pulse', form.pulse);
    if (pulse) samples.push(pulse);
  } else if (form.templateId === 'body_metrics' || form.templateId === 'body_weight') {
    for (const [key, value] of [
      ['body_weight', form.weight],
      ['body_height', form.height],
      ['body_waist_circumference', form.waist],
      ['body_hip_circumference', form.hip],
      ['body_bmi', form.bmi],
    ] as const) {
      const item = sample(key, value);
      if (item) samples.push(item);
    }
  } else if (form.templateId === 'glucose') {
    const item = sample(form.glucoseType, form.glucose);
    if (item) samples.push(item);
  } else if (form.templateId === 'temperature') {
    const item = sample('vital_body_temperature', form.temperature);
    if (item) samples.push(item);
  } else if (form.templateId === 'oxygen') {
    const item = sample('vital_spo2', form.spo2);
    if (item) samples.push(item);
  } else {
    const item = sample(form.singleKey, form.singleValue);
    if (item) samples.push(item);
  }
  return samples;
}

const templateManagedKeys: Record<MeasurementTemplateId, readonly MeasurementCanonicalKey[]> = {
  blood_pressure: ['vital_systolic_bp', 'vital_diastolic_bp', 'vital_pulse'],
  body_weight: ['body_weight', 'body_height', 'body_waist_circumference', 'body_hip_circumference', 'body_bmi'],
  body_metrics: ['body_weight', 'body_height', 'body_waist_circumference', 'body_hip_circumference', 'body_bmi'],
  glucose: ['glucose_fasting', 'glucose_postprandial_2h', 'glucose_random'],
  temperature: ['vital_body_temperature'],
  oxygen: ['vital_spo2'],
  custom_single: [],
};

/** Keep indicators this form does not edit, so saving one template cannot drop the rest of the session. */
function samplesForSave() {
  const samples: MeasurementSampleInput[] = buildSamples();
  if (!props.entry) return samples;
  const managed = new Set<string>(form.templateId === 'custom_single' ? [form.singleKey] : templateManagedKeys[form.templateId]);
  for (const item of props.entry.items) {
    if (item.origin === 'derived' || managed.has(item.canonicalKey) || !isMeasurementCanonicalKey(item.canonicalKey)) continue;
    samples.push({
      canonicalKey: item.canonicalKey,
      value: String(item.numericValue),
      unit: item.unit,
      pairGroup: item.pairGroup,
      origin: 'entered' as const,
    });
  }
  return samples;
}

const formIssue = computed(() => {
  if (form.templateId !== 'blood_pressure') return '';
  const systolic = form.systolic.trim();
  const diastolic = form.diastolic.trim();
  if (!systolic && !diastolic && !form.pulse.trim()) return '';
  if (!systolic || !diastolic) return '血压请同时填写收缩压和舒张压';
  const high = Number(systolic);
  const low = Number(diastolic);
  if (Number.isFinite(high) && Number.isFinite(low) && high <= low) return '收缩压应高于舒张压';
  return '';
});

const derivedBmiLabel = computed(() => {
  if (form.bmi.trim() || (form.templateId !== 'body_metrics' && form.templateId !== 'body_weight')) return '';
  const derived = props.entry?.items.find((item) => item.canonicalKey === 'body_bmi' && item.origin === 'derived');
  return derived ? `${derived.numericValue} ${derived.unit}` : '';
});

const canSubmit = computed(() => Boolean(form.recordedAt && buildSamples().length && !formIssue.value));

watch(() => form.templateId, () => { error.value = ''; });

async function applyRecentHeight() {
  if (!app.selectedMemberId.value || busy.value) return;
  try {
    const recent = await request<{ value: number; unit: string } | null>(
      `measurements/recent-height?memberId=${encodeURIComponent(app.selectedMemberId.value)}`,
    );
    if (recent?.value) form.height = String(recent.value);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '无法读取最近身高';
  }
}

async function save(continueNext = false) {
  if (!canSubmit.value || busy.value || !app.selectedMemberId.value) return;
  busy.value = true;
  error.value = '';
  try {
    const body = {
      memberId: app.selectedMemberId.value,
      channel: 'manual',
      templateId: form.templateId,
      recordedAt: form.recordedAt,
      note: form.note.trim() || null,
      samples: samplesForSave(),
      requestKey: requestKey.value,
      ...(props.processId ? { processId: props.processId } : {}),
      ...(props.relatedRecords?.length ? { relatedRecords: props.relatedRecords } : {}),
      ...(props.entry ? { revision: props.entry.revision } : {}),
    };
    const saved = props.entry
      ? await request<MeasurementSession>(`measurements/${encodeURIComponent(props.entry.id)}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      })
      : await request<MeasurementSession>('measurements', { method: 'POST', body: JSON.stringify(body) });
    app.notifyDataChanged();
    if (continueNext && !props.entry) {
      form.systolic = ''; form.diastolic = ''; form.pulse = ''; form.weight = ''; form.height = '';
      form.waist = ''; form.hip = ''; form.bmi = ''; form.glucose = ''; form.temperature = ''; form.spo2 = ''; form.singleValue = '';
      form.note = ''; form.recordedAt = localNow(); requestKey.value = createUuid();
      unsaved.reset();
      emit('continued', saved);
    } else emit('saved', saved);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '保存失败';
    requestKey.value = createUuid();
  } finally {
    busy.value = false;
  }
}

async function cancel() {
  if (busy.value) return;
  if (!await unsaved.confirmLeave()) return;
  unsaved.reset();
  emit('cancel');
}
</script>

<template>
  <form class="measurement-editor" @submit.prevent="save(false)">
    <div class="measurement-grid" :class="{ 'is-single-meta': Boolean(entry) }">
      <label v-if="!entry" class="measurement-field">
        <span>测量类型</span>
        <FormSelect v-model="templateModel" :options="templateOptions" aria-label="测量类型" :disabled="busy" />
      </label>
      <label class="measurement-field" :class="{ 'is-full': Boolean(entry) }">
        <span>测量时间</span>
        <DateTimePicker v-model="form.recordedAt" show-time :disabled="busy" aria-label="测量时间" />
      </label>
    </div>

    <div v-if="form.templateId==='blood_pressure'" class="measurement-grid">
      <label class="measurement-field">
        <span>收缩压</span>
        <div class="measurement-value">
          <input v-model="form.systolic" inputmode="decimal" :disabled="busy" placeholder="高压" aria-label="收缩压" />
          <span>mmHg</span>
        </div>
      </label>
      <label class="measurement-field">
        <span>舒张压</span>
        <div class="measurement-value">
          <input v-model="form.diastolic" inputmode="decimal" :disabled="busy" placeholder="低压" aria-label="舒张压" />
          <span>mmHg</span>
        </div>
      </label>
      <label class="measurement-field">
        <span>脉搏（选填）</span>
        <div class="measurement-value">
          <input v-model="form.pulse" inputmode="decimal" :disabled="busy" aria-label="脉搏" />
          <span>次/分</span>
        </div>
      </label>
    </div>

    <template v-else-if="form.templateId==='body_metrics' || form.templateId==='body_weight'">
      <div class="measurement-grid">
        <label class="measurement-field">
          <span>体重</span>
          <div class="measurement-value">
            <input v-model="form.weight" inputmode="decimal" :disabled="busy" aria-label="体重" />
            <span>kg</span>
          </div>
        </label>
        <label class="measurement-field">
          <span class="measurement-field-heading">
            <span>身高（选填）</span>
            <button
              v-if="!entry"
              type="button"
              class="measurement-inline-action"
              :disabled="busy"
              @click="applyRecentHeight"
            >带入最近身高</button>
          </span>
          <div class="measurement-value">
            <input v-model="form.height" inputmode="decimal" :disabled="busy" aria-label="身高" />
            <span>cm</span>
          </div>
        </label>
        <label class="measurement-field">
          <span>腰围（选填）</span>
          <div class="measurement-value">
            <input v-model="form.waist" inputmode="decimal" :disabled="busy" aria-label="腰围" />
            <span>cm</span>
          </div>
        </label>
        <label class="measurement-field">
          <span>臀围（选填）</span>
          <div class="measurement-value">
            <input v-model="form.hip" inputmode="decimal" :disabled="busy" aria-label="臀围" />
            <span>cm</span>
          </div>
        </label>
        <label class="measurement-field">
          <span>BMI（选填）</span>
          <div class="measurement-value">
            <input v-model="form.bmi" inputmode="decimal" :disabled="busy" aria-label="BMI" />
            <span>kg/m²</span>
          </div>
        </label>
      </div>
      <p class="measurement-hint">只需填写本次量到的项；同次有身高和体重时会自动计算 BMI。<template v-if="derivedBmiLabel"> 当前自动计算 {{ derivedBmiLabel }}，留空会按本次身高和体重重新计算。</template></p>
    </template>

    <div v-else-if="form.templateId==='glucose'" class="measurement-grid">
      <label class="measurement-field">
        <span>血糖类型</span>
        <FormSelect v-model="glucoseTypeModel" :options="glucoseOptions" aria-label="血糖类型" :disabled="busy" />
      </label>
      <label class="measurement-field">
        <span>血糖</span>
        <div class="measurement-value">
          <input v-model="form.glucose" inputmode="decimal" :disabled="busy" aria-label="血糖" />
          <span>mmol/L</span>
        </div>
      </label>
    </div>

    <div v-else-if="form.templateId==='temperature'" class="measurement-grid is-single">
      <label class="measurement-field">
        <span>体温</span>
        <div class="measurement-value">
          <input v-model="form.temperature" inputmode="decimal" :disabled="busy" aria-label="体温" />
          <span>℃</span>
        </div>
      </label>
    </div>

    <div v-else-if="form.templateId==='oxygen'" class="measurement-grid is-single">
      <label class="measurement-field">
        <span>血氧饱和度</span>
        <div class="measurement-value">
          <input v-model="form.spo2" inputmode="decimal" :disabled="busy" aria-label="血氧饱和度" placeholder="如 98" />
          <span>%</span>
        </div>
      </label>
    </div>

    <div v-else-if="showLegacySingle" class="measurement-grid">
      <label class="measurement-field">
        <span>指标</span>
        <FormSelect v-model="singleKeyModel" :options="legacySingleOptions" aria-label="测量指标" :disabled="busy" />
      </label>
      <label class="measurement-field">
        <span>数值</span>
        <div class="measurement-value">
          <input v-model="form.singleValue" inputmode="decimal" :disabled="busy" aria-label="测量数值" />
          <span>{{ measurementIndicatorMeta[form.singleKey].defaultUnit }}</span>
        </div>
      </label>
    </div>

    <label class="measurement-field">
      <span>备注（选填）</span>
      <textarea v-model="form.note" rows="3" maxlength="2000" :disabled="busy" />
    </label>

    <p v-if="error || formIssue" class="inline-panel-error" role="alert">{{ error || formIssue }}</p>
    <div class="form-actions record-form-actions">
      <button type="button" :disabled="busy" @click="cancel">取消</button>
      <button
        v-if="allowContinue && !entry"
        type="button"
        class="soft-action-button"
        :disabled="busy || !canSubmit"
        @click="save(true)"
      >保存并继续</button>
      <button class="primary-button" type="submit" :disabled="busy || !canSubmit">
        {{ busy ? '保存中…' : entry ? '保存修改' : '保存' }}
      </button>
    </div>
  </form>
</template>

<style scoped>
.measurement-editor {
  display: grid;
  gap: 14px;
  width: min(720px, 100%);
  min-width: 0;
  margin-inline: auto;
}
.measurement-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px 14px;
  min-width: 0;
}
.measurement-grid.is-single,
.measurement-grid.is-single-meta {
  grid-template-columns: minmax(0, 1fr);
}
.measurement-field {
  display: grid;
  align-content: start;
  gap: 6px;
  min-width: 0;
  color: var(--muted);
  font-size: 12px;
}
.measurement-field.is-full {
  grid-column: 1 / -1;
}
.measurement-field-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
}
.measurement-inline-action {
  flex: 0 0 auto;
  min-height: 24px;
  padding: 0;
  border: 0;
  background: none;
  color: var(--brand-strong);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.measurement-inline-action:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.measurement-inline-action:focus-visible {
  outline: 2px solid var(--brand);
  outline-offset: 2px;
}
.measurement-value {
  display: flex;
  align-items: center;
  min-width: 0;
  background: var(--surface);
  border: 1px solid var(--line-strong);
  border-radius: 10px;
}
.measurement-value:focus-within {
  border-color: var(--brand);
  box-shadow: 0 0 0 3px var(--brand-soft);
}
.measurement-value > input {
  width: 0;
  flex: 1;
  min-width: 0;
  min-height: 44px;
  padding: 0 12px;
  border: 0;
  border-radius: 0;
  background: transparent;
  color: var(--ink);
  font: inherit;
  font-size: 14px;
  line-height: 20px;
  outline: none;
  box-shadow: none;
}
.measurement-value > span {
  flex-shrink: 0;
  padding-right: 12px;
  color: var(--muted);
  font-size: 12px;
  line-height: 18px;
  white-space: nowrap;
}
.measurement-field :deep(.form-select-trigger) {
  width: 100%;
  min-height: 44px;
}
.measurement-field :deep(.datetime-picker) {
  width: 100%;
}
.measurement-field textarea {
  width: 100%;
  min-height: 88px;
  padding: 11px 12px;
  border: 1px solid var(--line-strong);
  border-radius: 10px;
  background: var(--surface);
  color: var(--ink);
  font: inherit;
  font-size: 14px;
  line-height: 1.6;
  resize: vertical;
  outline: 0;
}
.measurement-field textarea:focus {
  border-color: var(--brand);
  box-shadow: 0 0 0 3px var(--brand-soft);
}
.measurement-hint {
  margin: -2px 0 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--muted);
}
@media (max-width: 760px) {
  .measurement-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
