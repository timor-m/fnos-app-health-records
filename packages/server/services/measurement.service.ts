import { createError } from 'h3';
import { getDatabase, runInTransaction } from '../database/client';
import type { RequestUser } from '../domain/request-user';
import { assertMemberAccess, assertMemberManage } from './member.service';
import { assertOccurredDate, dateInput, textInput } from './health-event-input';
import { createId } from '../utils/identifier';
import { runHealthWorkflowRequest } from './health-workflow-request.service';
import { associateMedicationSelections } from './health-record-association.service';
import { convertUnit } from './indicator-normalization.service';
import {
  formatMeasurementMetrics,
  formatMeasurementSessionDescription,
  formatMeasurementSessionTitle,
  isMeasurementCanonicalKey,
  isMeasurementChannel,
  isMeasurementTemplateId,
  measurementIndicatorMeta,
  type MeasurementCanonicalKey,
  type MeasurementChannel,
  type MeasurementObservation,
  type MeasurementSampleInput,
  type MeasurementSession,
  type MeasurementTemplateId,
} from '../../shared/measurements';

const sessionColumns = `id,member_id AS memberId,recorded_at AS recordedAt,channel,template_id AS templateId,note,
  device_vendor AS deviceVendor,device_model AS deviceModel,device_id AS deviceId,device_firmware AS deviceFirmware,
  external_ref AS externalRef,revision,deleted_at AS deletedAt`;

function fail(statusCode: number, statusMessage: string): never {
  throw createError({ statusCode, statusMessage });
}

function normalizeInputUnit(unit: string): string {
  let value = unit.normalize('NFKC').trim().replace(/\s+/g, '');
  value = value.replace(/μ/g, 'µ');
  if (['c', '°c', '摄氏度'].includes(value.toLowerCase())) return '℃';
  if (value === 'kg/m2' || value === 'kg/㎡') return 'kg/m²';
  if (value === '千克' || value === '公斤') return 'kg';
  if (value === '厘米') return 'cm';
  if (value === '米') return 'm';
  if (value === '克') return 'g';
  if (value === 'bpm' || value === '次/min') return '次/分';
  return value;
}

function parseNumeric(value: unknown, label: string): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value.normalize('NFKC').trim())) {
    return Number(value.normalize('NFKC').trim());
  }
  return fail(400, `请填写有效的${label}`);
}

function validateRange(key: MeasurementCanonicalKey, value: number): void {
  const ranges: Partial<Record<MeasurementCanonicalKey, [number, number]>> = {
    vital_systolic_bp: [60, 250],
    vital_diastolic_bp: [40, 150],
    vital_pulse: [20, 250],
    body_weight: [1, 500],
    body_height: [20, 250],
    body_bmi: [5, 80],
    body_waist_circumference: [20, 300],
    body_hip_circumference: [20, 300],
    glucose_fasting: [0.5, 40],
    glucose_postprandial_2h: [0.5, 40],
    glucose_random: [0.5, 40],
    vital_body_temperature: [30, 45],
    vital_spo2: [50, 100],
  };
  const range = ranges[key];
  if (range && (value < range[0] || value > range[1])) {
    fail(400, `${measurementIndicatorMeta[key].displayName}数值超出合理范围`);
  }
}

function resolveSample(sample: MeasurementSampleInput, sortOrder: number): Omit<MeasurementObservation, 'id' | 'sessionId' | 'memberId'> {
  if (!isMeasurementCanonicalKey(sample.canonicalKey)) fail(400, '暂不支持该测量指标');
  const meta = measurementIndicatorMeta[sample.canonicalKey];
  const numericValue = parseNumeric(sample.value, meta.displayName);
  const unit = normalizeInputUnit(typeof sample.unit === 'string' ? sample.unit : meta.defaultUnit);
  const allowed = new Set(meta.allowedUnits.map((item) => normalizeInputUnit(item)));
  if (!allowed.has(unit) && !meta.allowedUnits.includes(unit)) {
    const convertible = convertUnit(sample.canonicalKey, 1, unit, meta.defaultUnit);
    if (convertible === null) fail(400, `${meta.displayName}单位无效`);
  }
  const canonicalUnit = meta.defaultUnit;
  const canonicalValue = unit === canonicalUnit
    ? numericValue
    : convertUnit(sample.canonicalKey, numericValue, unit, canonicalUnit);
  if (canonicalValue === null) fail(400, `${meta.displayName}单位无法换算`);
  validateRange(sample.canonicalKey, canonicalValue);
  const origin = sample.origin === 'derived' ? 'derived' : 'entered';
  return {
    canonicalKey: sample.canonicalKey,
    displayName: meta.displayName,
    resultText: String(numericValue),
    numericValue,
    unit,
    canonicalValue,
    canonicalUnit,
    pairGroup: sample.pairGroup || (sample.canonicalKey.startsWith('vital_') && sample.canonicalKey.includes('bp') ? 'bp' : null),
    sortOrder,
    origin,
    quality: 'high',
  };
}

function deriveBmi(samples: Array<Omit<MeasurementObservation, 'id' | 'sessionId' | 'memberId'>>) {
  if (samples.some((item) => item.canonicalKey === 'body_bmi')) return samples;
  const weight = samples.find((item) => item.canonicalKey === 'body_weight');
  const height = samples.find((item) => item.canonicalKey === 'body_height');
  if (!weight || !height || weight.canonicalValue == null || height.canonicalValue == null) return samples;
  const heightM = height.canonicalUnit === 'cm' ? height.canonicalValue / 100 : height.canonicalValue;
  if (!(heightM > 0)) return samples;
  const bmi = Math.round((weight.canonicalValue / (heightM * heightM)) * 100) / 100;
  return [
    ...samples,
    resolveSample({ canonicalKey: 'body_bmi', value: bmi, unit: 'kg/m²', origin: 'derived' }, samples.length),
  ];
}

function normalizeSamples(input: unknown): Array<Omit<MeasurementObservation, 'id' | 'sessionId' | 'memberId'>> {
  if (!Array.isArray(input) || !input.length || input.length > 20) fail(400, '请至少填写一项测量值');
  const resolved = input.map((sample, index) => resolveSample(sample as MeasurementSampleInput, index));
  const keys = new Set<string>();
  for (const sample of resolved) {
    if (keys.has(sample.canonicalKey)) fail(400, `同一测量中不能重复填写${sample.displayName}`);
    keys.add(sample.canonicalKey);
  }
  const systolic = resolved.find((item) => item.canonicalKey === 'vital_systolic_bp');
  const diastolic = resolved.find((item) => item.canonicalKey === 'vital_diastolic_bp');
  if ((systolic && !diastolic) || (!systolic && diastolic)) fail(400, '血压请同时填写收缩压和舒张压');
  if (systolic && diastolic && (systolic.canonicalValue ?? systolic.numericValue) <= (diastolic.canonicalValue ?? diastolic.numericValue)) {
    fail(400, '收缩压应高于舒张压');
  }
  return deriveBmi(resolved);
}

function assertBloodPressureTemplate(
  templateId: MeasurementTemplateId | null,
  samples: Array<Omit<MeasurementObservation, 'id' | 'sessionId' | 'memberId'>>,
) {
  if (templateId !== 'blood_pressure') return;
  const keys = new Set(samples.map((item) => item.canonicalKey));
  if (!keys.has('vital_systolic_bp') || !keys.has('vital_diastolic_bp')) fail(400, '血压请同时填写收缩压和舒张压');
}

function loadItems(sessionId: string): MeasurementObservation[] {
  return getDatabase().prepare(`
    SELECT id,session_id AS sessionId,member_id AS memberId,canonical_key AS canonicalKey,display_name AS displayName,
      result_text AS resultText,numeric_value AS numericValue,unit,canonical_value AS canonicalValue,canonical_unit AS canonicalUnit,
      pair_group AS pairGroup,sort_order AS sortOrder,origin,quality
    FROM measurement_observations WHERE session_id=? ORDER BY sort_order,id
  `).all(sessionId) as MeasurementObservation[];
}

function sessionRow(id: string, includeDeleted = false) {
  const row = getDatabase().prepare(`
    SELECT ${sessionColumns} FROM measurement_sessions WHERE id=? ${includeDeleted ? '' : 'AND deleted_at IS NULL'}
  `).get(id) as Omit<MeasurementSession, 'items'> | undefined;
  if (!row) fail(404, '测量记录不存在');
  return row;
}

export function getMeasurement(user: RequestUser, id: string): MeasurementSession {
  const row = sessionRow(id);
  assertMemberAccess(user, row.memberId);
  return { ...row, templateId: row.templateId as MeasurementTemplateId | null, channel: row.channel as MeasurementChannel, items: loadItems(id) };
}

export function listMeasurements(user: RequestUser, memberId: string) {
  assertMemberAccess(user, memberId);
  const rows = getDatabase().prepare(`
    SELECT ${sessionColumns} FROM measurement_sessions
    WHERE member_id=? AND deleted_at IS NULL ORDER BY recorded_at DESC,id
  `).all(memberId) as Array<Omit<MeasurementSession, 'items'>>;
  return rows.map((row) => ({
    ...row,
    templateId: row.templateId as MeasurementTemplateId | null,
    channel: row.channel as MeasurementChannel,
    items: loadItems(row.id),
  }));
}

function markTrendsDirty(memberId: string) {
  const db = getDatabase();
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='trend_snapshot_members'").get()) return;
  db.prepare(`
    INSERT INTO trend_snapshot_members(member_id, desired_revision, invalidated, full_rebuild)
      VALUES(?,1,1,1)
    ON CONFLICT(member_id) DO UPDATE SET
      desired_revision = desired_revision + 1,
      invalidated = 1,
      full_rebuild = 1,
      retry_at = 0
  `).run(memberId);
}

function audit(user: RequestUser, id: string, action: string, detail: Record<string, unknown> = {}) {
  getDatabase().prepare(`
    INSERT INTO audit_logs(id,actor_user_id,action,target_type,target_id,detail_json)
    VALUES(?,?,?,'measurement',?,?)
  `).run(createId('audit'), user.id, action, id, JSON.stringify(detail));
}

function insertItems(sessionId: string, memberId: string, samples: Array<Omit<MeasurementObservation, 'id' | 'sessionId' | 'memberId'>>) {
  const db = getDatabase();
  const insert = db.prepare(`
    INSERT INTO measurement_observations(
      id,session_id,member_id,canonical_key,display_name,result_text,numeric_value,unit,
      canonical_value,canonical_unit,pair_group,sort_order,origin,quality
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  for (const sample of samples) {
    insert.run(
      createId('mobs'), sessionId, memberId, sample.canonicalKey, sample.displayName, sample.resultText,
      sample.numericValue, sample.unit, sample.canonicalValue, sample.canonicalUnit, sample.pairGroup,
      sample.sortOrder, sample.origin, sample.quality,
    );
  }
}

function parseDevice(input: Record<string, unknown>) {
  const device = input.device && typeof input.device === 'object' ? input.device as Record<string, unknown> : null;
  return {
    deviceVendor: textInput(device?.vendor, '设备厂商', 120),
    deviceModel: textInput(device?.model, '设备型号', 120),
    deviceId: textInput(device?.deviceId, '设备编号', 120),
    deviceFirmware: textInput(device?.firmware, '设备固件', 120),
  };
}

export function createMeasurement(user: RequestUser, input: Record<string, unknown>) {
  const memberId = textInput(input.memberId, '成员', 100, true)!;
  assertMemberManage(user, memberId);
  return runHealthWorkflowRequest(user, memberId, 'measurement.create', input, () => {
    if (!isMeasurementChannel(input.channel)) fail(400, '测量来源无效');
    const channel = input.channel;
    const templateId = input.templateId == null || input.templateId === ''
      ? null
      : (isMeasurementTemplateId(input.templateId) ? input.templateId : fail(400, '测量模板无效'));
    const recordedAt = dateInput(input.recordedAt, '测量时间');
    if (!recordedAt) fail(400, '请填写测量时间');
    assertOccurredDate(recordedAt, '测量时间');
    const note = textInput(input.note, '备注', 2000);
    const externalRef = textInput(input.externalRef, '外部编号', 200);
    const requestKey = textInput(input.requestKey, '请求编号', 100);
    const device = parseDevice(input);
    const samples = normalizeSamples(input.samples);
    assertBloodPressureTemplate(templateId, samples);
    const db = getDatabase();
    let sessionId = '';
    runInTransaction(db, () => {
      if (requestKey) {
        const existing = db.prepare(`
          SELECT id FROM measurement_sessions WHERE member_id=? AND request_key=? AND deleted_at IS NULL
        `).get(memberId, requestKey) as { id: string } | undefined;
        if (existing) { sessionId = existing.id; return; }
      }
      if (externalRef && device.deviceId) {
        const existing = db.prepare(`
          SELECT id FROM measurement_sessions
          WHERE member_id=? AND device_id=? AND external_ref=? AND deleted_at IS NULL
        `).get(memberId, device.deviceId, externalRef) as { id: string } | undefined;
        if (existing) { sessionId = existing.id; return; }
      }
      sessionId = createId('measurement');
      db.prepare(`
        INSERT INTO measurement_sessions(
          id,member_id,recorded_at,channel,template_id,note,device_vendor,device_model,device_id,device_firmware,
          external_ref,request_key,created_by
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        sessionId, memberId, recordedAt, channel, templateId, note, device.deviceVendor, device.deviceModel,
        device.deviceId, device.deviceFirmware, externalRef, requestKey, user.id,
      );
      insertItems(sessionId, memberId, samples);
      associateMedicationSelections(user, { kind: 'measurement', id: sessionId }, input.relatedRecords, input.processId);
      markTrendsDirty(memberId);
      audit(user, sessionId, 'measurement.create', { channel, templateId, itemCount: samples.length });
    });
    return getMeasurement(user, sessionId);
  }, (saved) => getMeasurement(user, saved.id));
}

export function updateMeasurement(user: RequestUser, id: string, input: Record<string, unknown>) {
  const previous = getMeasurement(user, id);
  assertMemberManage(user, previous.memberId);
  if (input.memberId !== undefined && input.memberId !== previous.memberId) fail(400, '不能修改测量所属成员');
  if (input.revision !== previous.revision) fail(409, '测量记录已更新，请刷新后重试');
  const recordedAt = dateInput(input.recordedAt !== undefined ? input.recordedAt : previous.recordedAt, '测量时间');
  if (!recordedAt) fail(400, '请填写测量时间');
  assertOccurredDate(recordedAt, '测量时间');
  const note = input.note !== undefined ? textInput(input.note, '备注', 2000) : previous.note;
  const templateId = input.templateId !== undefined
    ? (input.templateId == null || input.templateId === ''
      ? null
      : (isMeasurementTemplateId(input.templateId) ? input.templateId : fail(400, '测量模板无效')))
    : previous.templateId;
  const samples = input.samples !== undefined
    ? normalizeSamples(input.samples)
    : previous.items.map((item, index) => resolveSample({
      canonicalKey: item.canonicalKey,
      value: item.numericValue,
      unit: item.unit,
      pairGroup: item.pairGroup,
      origin: item.origin,
    }, index));
  assertBloodPressureTemplate(templateId, samples);
  const db = getDatabase();
  runInTransaction(db, () => {
    const result = db.prepare(`
      UPDATE measurement_sessions SET recorded_at=?,template_id=?,note=?,revision=revision+1,updated_at=CURRENT_TIMESTAMP
      WHERE id=? AND revision=? AND deleted_at IS NULL
    `).run(recordedAt, templateId, note, id, previous.revision);
    if (!result.changes) fail(409, '测量记录已更新，请刷新后重试');
    db.prepare('DELETE FROM measurement_observations WHERE session_id=?').run(id);
    insertItems(id, previous.memberId, samples);
    associateMedicationSelections(user, { kind: 'measurement', id }, input.relatedRecords, input.processId);
    markTrendsDirty(previous.memberId);
    audit(user, id, 'measurement.update', { itemCount: samples.length });
  });
  return getMeasurement(user, id);
}

export function feedTitleForSession(session: Pick<MeasurementSession, 'templateId' | 'items'>) {
  return formatMeasurementSessionTitle(session.templateId, session.items);
}

export function feedDescriptionForSession(session: Pick<MeasurementSession, 'items'>) {
  return formatMeasurementSessionDescription(session.items);
}

export function feedMetricsForSession(session: Pick<MeasurementSession, 'items'>) {
  return formatMeasurementMetrics(session.items);
}

export function recentMeasurementHeight(user: RequestUser, memberId: string): { value: number; unit: string; recordedAt: string } | null {
  assertMemberAccess(user, memberId);
  const row = getDatabase().prepare(`
    SELECT o.canonical_value AS value, o.canonical_unit AS unit, s.recorded_at AS recordedAt
    FROM measurement_observations o
    JOIN measurement_sessions s ON s.id=o.session_id
    WHERE o.member_id=? AND o.canonical_key='body_height' AND s.deleted_at IS NULL
      AND o.canonical_value IS NOT NULL
    ORDER BY s.recorded_at DESC, s.id DESC LIMIT 1
  `).get(memberId) as { value: number; unit: string; recordedAt: string } | undefined;
  return row || null;
}
