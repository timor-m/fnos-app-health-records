/** Self-monitoring measurements: one session may contain multiple indicators. */

export const measurementChannels = ['manual', 'device', 'import'] as const;
export type MeasurementChannel = (typeof measurementChannels)[number];

export const measurementTemplateIds = [
  'blood_pressure',
  'body_weight',
  'body_metrics',
  'glucose',
  'temperature',
  'oxygen',
  'custom_single',
] as const;
export type MeasurementTemplateId = (typeof measurementTemplateIds)[number];

/** Templates shown when creating a new session. `body_weight` / `custom_single` are legacy-only. */
export const createMeasurementTemplateIds = [
  'blood_pressure',
  'body_metrics',
  'glucose',
  'temperature',
  'oxygen',
] as const satisfies readonly MeasurementTemplateId[];

export const measurementWhitelist = [
  'vital_systolic_bp',
  'vital_diastolic_bp',
  'vital_pulse',
  'body_weight',
  'body_height',
  'body_bmi',
  'body_waist_circumference',
  'body_hip_circumference',
  'glucose_fasting',
  'glucose_postprandial_2h',
  'glucose_random',
  'vital_body_temperature',
  'vital_spo2',
] as const;
export type MeasurementCanonicalKey = (typeof measurementWhitelist)[number];

export const measurementIndicatorMeta: Record<
  MeasurementCanonicalKey,
  { displayName: string; defaultUnit: string; allowedUnits: readonly string[] }
> = {
  vital_systolic_bp: { displayName: '收缩压', defaultUnit: 'mmHg', allowedUnits: ['mmHg'] },
  vital_diastolic_bp: { displayName: '舒张压', defaultUnit: 'mmHg', allowedUnits: ['mmHg'] },
  vital_pulse: { displayName: '脉搏', defaultUnit: '次/分', allowedUnits: ['次/分', '次/min', 'bpm'] },
  body_weight: { displayName: '体重', defaultUnit: 'kg', allowedUnits: ['kg', '千克', '公斤', 'g', '克'] },
  body_height: { displayName: '身高', defaultUnit: 'cm', allowedUnits: ['cm', '厘米', 'm', '米', 'mm', '毫米'] },
  body_bmi: { displayName: '体重指数', defaultUnit: 'kg/m²', allowedUnits: ['kg/m²', 'kg/m2', 'kg/㎡'] },
  body_waist_circumference: {
    displayName: '腰围',
    defaultUnit: 'cm',
    allowedUnits: ['cm', '厘米', 'm', '米', 'mm', '毫米'],
  },
  body_hip_circumference: {
    displayName: '臀围',
    defaultUnit: 'cm',
    allowedUnits: ['cm', '厘米', 'm', '米'],
  },
  glucose_fasting: { displayName: '空腹血糖', defaultUnit: 'mmol/L', allowedUnits: ['mmol/L', 'mg/dL'] },
  glucose_postprandial_2h: { displayName: '餐后2小时血糖', defaultUnit: 'mmol/L', allowedUnits: ['mmol/L', 'mg/dL'] },
  glucose_random: { displayName: '随机血糖', defaultUnit: 'mmol/L', allowedUnits: ['mmol/L', 'mg/dL'] },
  vital_body_temperature: { displayName: '体温', defaultUnit: '℃', allowedUnits: ['℃', '°C', 'C', '摄氏度'] },
  vital_spo2: { displayName: '血氧饱和度', defaultUnit: '%', allowedUnits: ['%'] },
};

export const measurementTemplateLabels: Record<MeasurementTemplateId, string> = {
  blood_pressure: '血压',
  body_weight: '体重',
  body_metrics: '体格',
  glucose: '血糖',
  temperature: '体温',
  oxygen: '血氧',
  custom_single: '其他',
};

/** Map a stored session onto a create-time template when possible, so edit UI matches dedicated forms. */
export function resolveMeasurementTemplate(
  templateId: MeasurementTemplateId | null | undefined,
  items: Array<{ canonicalKey: string }>,
): MeasurementTemplateId {
  if (templateId === 'body_weight') return 'body_metrics';
  if (templateId && templateId !== 'custom_single') return templateId;
  const keys = new Set(items.map((item) => item.canonicalKey));
  if (keys.has('vital_systolic_bp') || keys.has('vital_diastolic_bp')) return 'blood_pressure';
  if ([...keys].some((key) => key.startsWith('glucose_'))) return 'glucose';
  if (keys.has('vital_body_temperature') && keys.size === 1) return 'temperature';
  if (keys.has('vital_spo2') && keys.size === 1) return 'oxygen';
  if (
    keys.has('body_weight')
    || keys.has('body_height')
    || keys.has('body_waist_circumference')
    || keys.has('body_hip_circumference')
    || keys.has('body_bmi')
  ) return 'body_metrics';
  if (templateId === 'custom_single') return 'custom_single';
  return 'blood_pressure';
}

export const measurementChannelLabels: Record<MeasurementChannel, string> = {
  manual: '自测',
  device: '设备',
  import: '导入',
};

export type MeasurementSampleInput = {
  canonicalKey: MeasurementCanonicalKey | string;
  value: number | string;
  unit: string;
  pairGroup?: string | null;
  origin?: 'entered' | 'derived';
};

export type MeasurementObservation = {
  id: string;
  sessionId: string;
  memberId: string;
  canonicalKey: string;
  displayName: string;
  resultText: string;
  numericValue: number;
  unit: string;
  canonicalValue: number | null;
  canonicalUnit: string | null;
  pairGroup: string | null;
  sortOrder: number;
  origin: 'entered' | 'derived';
  quality: 'high' | 'medium' | 'low' | 'excluded';
};

export type MeasurementSession = {
  id: string;
  memberId: string;
  recordedAt: string;
  channel: MeasurementChannel;
  templateId: MeasurementTemplateId | null;
  note: string | null;
  deviceVendor: string | null;
  deviceModel: string | null;
  deviceId: string | null;
  deviceFirmware: string | null;
  externalRef: string | null;
  revision: number;
  deletedAt: string | null;
  items: MeasurementObservation[];
};

export function isMeasurementCanonicalKey(value: unknown): value is MeasurementCanonicalKey {
  return typeof value === 'string' && (measurementWhitelist as readonly string[]).includes(value);
}

export function isMeasurementTemplateId(value: unknown): value is MeasurementTemplateId {
  return typeof value === 'string' && (measurementTemplateIds as readonly string[]).includes(value);
}

export function isMeasurementChannel(value: unknown): value is MeasurementChannel {
  return typeof value === 'string' && (measurementChannels as readonly string[]).includes(value);
}

export type MeasurementCardMetric = { label: string; value: string; unit: string };

/** One card cell per reading. Blood pressure collapses to a single 128/82 value. */
export function formatMeasurementMetrics(items: Array<Pick<MeasurementObservation, 'canonicalKey' | 'numericValue' | 'unit' | 'displayName'>>): MeasurementCardMetric[] {
  if (!items.length) return [];
  const systolic = items.find((item) => item.canonicalKey === 'vital_systolic_bp');
  const diastolic = items.find((item) => item.canonicalKey === 'vital_diastolic_bp');
  const rest = items.filter(
    (item) => item.canonicalKey !== 'vital_systolic_bp' && item.canonicalKey !== 'vital_diastolic_bp',
  );
  const metrics: MeasurementCardMetric[] = [];
  if (systolic && diastolic) {
    metrics.push({
      label: '血压',
      value: `${formatNumber(systolic.numericValue)}/${formatNumber(diastolic.numericValue)}`,
      unit: systolic.unit || 'mmHg',
    });
  } else {
    if (systolic) metrics.push({ label: systolic.displayName, value: formatNumber(systolic.numericValue), unit: systolic.unit });
    if (diastolic) metrics.push({ label: diastolic.displayName, value: formatNumber(diastolic.numericValue), unit: diastolic.unit });
  }
  for (const item of rest) metrics.push({ label: item.displayName, value: formatNumber(item.numericValue), unit: item.unit });
  return metrics;
}

/** Card / feed summary for a session (blood pressure collapses to 128/82). */
export function formatMeasurementSessionDescription(items: Array<Pick<MeasurementObservation, 'canonicalKey' | 'numericValue' | 'unit' | 'displayName' | 'pairGroup'>>): string {
  if (!items.length) return '';
  const systolic = items.find((item) => item.canonicalKey === 'vital_systolic_bp');
  const diastolic = items.find((item) => item.canonicalKey === 'vital_diastolic_bp');
  const rest = items.filter(
    (item) => item.canonicalKey !== 'vital_systolic_bp' && item.canonicalKey !== 'vital_diastolic_bp',
  );
  const parts: string[] = [];
  if (systolic && diastolic) parts.push(`${formatNumber(systolic.numericValue)}/${formatNumber(diastolic.numericValue)} ${systolic.unit || 'mmHg'}`);
  else {
    if (systolic) parts.push(`${systolic.displayName} ${formatNumber(systolic.numericValue)} ${systolic.unit}`);
    if (diastolic) parts.push(`${diastolic.displayName} ${formatNumber(diastolic.numericValue)} ${diastolic.unit}`);
  }
  for (const item of rest.slice(0, 3 - parts.length)) {
    parts.push(`${item.displayName} ${formatNumber(item.numericValue)} ${item.unit}`.trim());
  }
  if (rest.length > 3 - (systolic && diastolic ? 1 : 0)) {
    const shown = (systolic && diastolic ? 1 : 0) + Math.min(rest.length, 3 - (systolic && diastolic ? 1 : 0));
    const total = (systolic ? 1 : 0) + (diastolic ? 1 : 0) + rest.length;
    if (total > shown) parts.push(`等 ${total} 项`);
  }
  return parts.join(' · ');
}

export function formatMeasurementSessionTitle(
  templateId: MeasurementTemplateId | null | undefined,
  items: Array<Pick<MeasurementObservation, 'canonicalKey' | 'displayName'>>,
): string {
  if (templateId && templateId !== 'custom_single') return measurementTemplateLabels[templateId];
  if (items.some((item) => item.canonicalKey === 'vital_systolic_bp' || item.canonicalKey === 'vital_diastolic_bp')) {
    return measurementTemplateLabels.blood_pressure;
  }
  if (items.length === 1) return items[0].displayName;
  if (items.length > 1) return '测量记录';
  return '测量记录';
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100);
}

/** Names, values and the note, including readings omitted from the short card summary. */
export function measurementSearchText(session: {
  items: Array<Pick<MeasurementObservation, 'displayName' | 'numericValue' | 'unit'>>;
  note?: string | null;
}): string {
  return [
    ...session.items.flatMap((item) => [item.displayName, formatNumber(item.numericValue), item.unit]),
    session.note?.trim() || '',
  ].filter(Boolean).join(' ');
}
