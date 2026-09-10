import { createHash } from "node:crypto";
import { createError } from "h3";
import { getDatabase } from "../database/client";
import type { RequestUser } from "../domain/request-user";
import { createId } from "../utils/identifier";
import { assertMemberManage } from "./member.service";
import { ensureBuiltinIndicatorCatalog, normalizeReportObservations } from "./indicator-normalization.service";
import { deriveObservationDisplayAbnormal } from "./observation-interpretation.service";

export type EditableObservationFields = {
  sectionName: string | null;
  itemCode: string | null;
  itemName: string;
  resultText: string;
  numericValue: number | null;
  unit: string | null;
  referenceLow: number | null;
  referenceHigh: number | null;
  referenceText: string | null;
  abnormalFlag: "high" | "low" | "abnormal" | "normal" | null;
};

export type PersistableObservation = EditableObservationFields & {
  normalizedName: string | null;
  method: string | null;
  evidence: Array<{ pageNumber?: number; quote?: string; [key: string]: unknown }>;
};

type OverrideRow = {
  id: string;
  sourceKey: string;
  observationId: string | null;
  fieldsJson: string;
  isManualCreated: number;
};

export type AppliedObservationOverride = {
  observation: PersistableObservation;
  overrideId: string | null;
  manualCreated: boolean;
};

function compactIdentity(value: unknown) {
  return String(value || "").normalize("NFKC").toLocaleLowerCase("zh-CN").replace(/\s+/g, "").trim();
}

export function observationSourceKey(input: EditableObservationFields & Partial<Pick<PersistableObservation, "evidence">>) {
  const evidence = (input.evidence || []).map((entry) => ({
    pageNumber: Number(entry.pageNumber) || 0,
    quote: compactIdentity(entry.quote),
  }));
  return createHash("sha256").update(JSON.stringify({
    sectionName: compactIdentity(input.sectionName),
    itemCode: compactIdentity(input.itemCode),
    itemName: compactIdentity(input.itemName),
    evidence,
  })).digest("hex");
}

function parseFields(value: string): EditableObservationFields | null {
  try {
    const parsed = JSON.parse(value) as EditableObservationFields;
    return parsed && typeof parsed.itemName === "string" && typeof parsed.resultText === "string" ? parsed : null;
  } catch {
    return null;
  }
}

export function applyObservationFieldOverrides(
  reportId: string,
  observations: PersistableObservation[],
): AppliedObservationOverride[] {
  const rows = getDatabase().prepare(`
    SELECT id, source_key AS sourceKey, observation_id AS observationId,
      fields_json AS fieldsJson, is_manual_created AS isManualCreated
    FROM observation_field_overrides WHERE report_id = ? ORDER BY created_at, id
  `).all(reportId) as OverrideRow[];
  const bySourceKey = new Map(rows.map((row) => [row.sourceKey, row]));
  const used = new Set<string>();
  const result = observations.map((observation) => {
    const override = bySourceKey.get(observationSourceKey(observation));
    const fields = override ? parseFields(override.fieldsJson) : null;
    if (!override || !fields || used.has(override.id)) {
      return { observation, overrideId: null, manualCreated: false };
    }
    used.add(override.id);
    return {
      observation: { ...observation, ...fields, normalizedName: null },
      overrideId: override.id,
      manualCreated: Boolean(override.isManualCreated),
    };
  });
  for (const row of rows) {
    if (used.has(row.id)) continue;
    const fields = parseFields(row.fieldsJson);
    if (!fields) continue;
    result.push({
      observation: { ...fields, normalizedName: null, method: "manual", evidence: [] },
      overrideId: row.id,
      manualCreated: Boolean(row.isManualCreated),
    });
  }
  return result;
}

export function bindObservationFieldOverride(overrideId: string, observationId: string) {
  getDatabase().prepare(`
    UPDATE observation_field_overrides SET observation_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `).run(observationId, overrideId);
}

function textValue(value: unknown, maxLength: number, required = false) {
  const text = typeof value === "string" ? value.trim().slice(0, maxLength) : "";
  if (required && !text) throw createError({ statusCode: 400, statusMessage: "指标名称不能为空" });
  return text || null;
}

function numberValue(value: unknown, label: string) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw createError({ statusCode: 400, statusMessage: `${label}必须是有效数字` });
  return parsed;
}

function validatedFields(input: Record<string, unknown>): EditableObservationFields {
  const referenceLow = numberValue(input.referenceLow, "参考下限");
  const referenceHigh = numberValue(input.referenceHigh, "参考上限");
  if (referenceLow !== null && referenceHigh !== null && referenceLow > referenceHigh) {
    throw createError({ statusCode: 400, statusMessage: "参考下限不能大于参考上限" });
  }
  const abnormalInput = textValue(input.abnormalFlag, 20);
  const abnormalFlag = abnormalInput && ["high", "low", "abnormal", "normal"].includes(abnormalInput)
    ? abnormalInput as EditableObservationFields["abnormalFlag"]
    : null;
  if (abnormalInput && !abnormalFlag) throw createError({ statusCode: 400, statusMessage: "异常标记无效" });
  return {
    sectionName: textValue(input.sectionName, 160),
    itemCode: textValue(input.itemCode, 100),
    itemName: textValue(input.itemName, 240, true)!,
    resultText: textValue(input.resultText, 500) || "",
    numericValue: numberValue(input.numericValue, "数值结果"),
    unit: textValue(input.unit, 100),
    referenceLow,
    referenceHigh,
    referenceText: textValue(input.referenceText, 500),
    abnormalFlag,
  };
}

function validatedCanonicalKey(input: Record<string, unknown>) {
  const canonicalKey = textValue(input.canonicalKey, 160);
  if (!canonicalKey) return null;
  ensureBuiltinIndicatorCatalog();
  const exists = getDatabase().prepare(`
    SELECT 1 AS found FROM indicator_catalog WHERE canonical_key = ?
  `).get(canonicalKey) as { found: number } | undefined;
  if (!exists) throw createError({ statusCode: 400, statusMessage: "所选本地标准指标不存在" });
  return canonicalKey;
}

function managedReport(user: RequestUser, reportId: string) {
  const row = getDatabase().prepare(`
    SELECT member_id AS memberId FROM reports WHERE id = ? AND status <> 'trashed'
  `).get(reportId) as { memberId: string } | undefined;
  if (!row) throw createError({ statusCode: 404, statusMessage: "报告不存在" });
  assertMemberManage(user, row.memberId);
  return row;
}

function insertObservation(reportId: string, observationId: string, fields: EditableObservationFields) {
  const display = deriveObservationDisplayAbnormal({
    storedFlag: fields.abnormalFlag,
    resultText: fields.resultText,
    supportingText: [],
    numericValue: fields.numericValue,
    referenceLow: fields.referenceLow,
    referenceHigh: fields.referenceHigh,
    referenceText: fields.referenceText,
  });
  getDatabase().prepare(`
    INSERT INTO observations (
      id, report_id, section_name, item_code, item_name, normalized_name, result_text,
      numeric_value, unit, reference_low, reference_high, reference_text, abnormal_flag,
      display_abnormal_flag, abnormal_conflict, method, evidence_json
    ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', '[]')
  `).run(
    observationId, reportId, fields.sectionName, fields.itemCode, fields.itemName,
    fields.resultText, fields.numericValue, fields.unit, fields.referenceLow,
    fields.referenceHigh, fields.referenceText, fields.abnormalFlag,
    display.displayAbnormalFlag, display.abnormalConflict ? 1 : 0,
  );
}

export function createManualObservation(user: RequestUser, reportId: string, input: Record<string, unknown>) {
  const report = managedReport(user, reportId);
  const fields = validatedFields(input);
  const canonicalKey = validatedCanonicalKey(input);
  const observationId = createId("obs");
  const overrideId = createId("observation-override");
  const db = getDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    insertObservation(reportId, observationId, fields);
    db.prepare(`
      INSERT INTO observation_field_overrides (
        id, report_id, source_key, observation_id, fields_json, canonical_key, is_manual_created, updated_by
      ) VALUES (?, ?, ?, ?, ?, ?, 1, ?)
    `).run(overrideId, reportId, `manual:${overrideId}`, observationId, JSON.stringify(fields), canonicalKey, user.id);
    db.prepare("UPDATE reports SET source_version = source_version + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(reportId);
    db.prepare(`
      INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, detail_json)
      VALUES (?, ?, 'observation.manual_create', 'observation', ?, ?)
    `).run(createId("audit"), user.id, observationId, JSON.stringify({
      memberId: report.memberId,
      reportId,
      fields: [...Object.keys(fields), ...(canonicalKey ? ["canonicalKey"] : [])],
    }));
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  normalizeReportObservations(reportId);
}

export function updateManualObservation(
  user: RequestUser,
  reportId: string,
  observationId: string,
  input: Record<string, unknown>,
) {
  const report = managedReport(user, reportId);
  const db = getDatabase();
  const current = db.prepare(`
    SELECT o.section_name AS sectionName, o.item_code AS itemCode, o.item_name AS itemName,
      o.result_text AS resultText, o.numeric_value AS numericValue, o.unit,
      o.reference_low AS referenceLow, o.reference_high AS referenceHigh,
      o.reference_text AS referenceText, o.abnormal_flag AS abnormalFlag,
      o.evidence_json AS evidenceJson, override.id AS overrideId,
      override.source_key AS sourceKey, override.canonical_key AS currentCanonicalKey,
      override.is_manual_created AS isManualCreated
    FROM observations o
    LEFT JOIN observation_field_overrides override ON override.observation_id = o.id
    WHERE o.id = ? AND o.report_id = ?
  `).get(observationId, reportId) as (EditableObservationFields & {
    evidenceJson: string; overrideId: string | null; sourceKey: string | null;
    currentCanonicalKey: string | null; isManualCreated: number | null;
  }) | undefined;
  if (!current) throw createError({ statusCode: 404, statusMessage: "指标不存在" });
  const excluded = db.prepare("SELECT 1 FROM observation_normalizations WHERE observation_id = ? AND matched_by = 'manual_exclusion'").get(observationId);
  if (excluded) throw createError({ statusCode: 409, statusMessage: "该指标已被人工排除，请先在指标治理中心撤销排除，再进行校对" });
  const fields = validatedFields(input);
  const canonicalKey = validatedCanonicalKey(input);
  let evidence: PersistableObservation["evidence"] = [];
  try {
    const parsed: unknown = JSON.parse(current.evidenceJson);
    evidence = Array.isArray(parsed) ? parsed as PersistableObservation["evidence"] : [];
  } catch { evidence = []; }
  const sourceKey = current.sourceKey || observationSourceKey({ ...current, evidence });
  const overrideId = current.overrideId || createId("observation-override");
  const changedFields = (Object.keys(fields) as Array<keyof EditableObservationFields>)
    .filter((key) => (current[key] ?? null) !== (fields[key] ?? null));
  if ((current.currentCanonicalKey || null) !== canonicalKey) changedFields.push("canonicalKey" as keyof EditableObservationFields);
  db.exec("BEGIN IMMEDIATE");
  try {
    const display = deriveObservationDisplayAbnormal({
      storedFlag: fields.abnormalFlag, resultText: fields.resultText, supportingText: [],
      numericValue: fields.numericValue, referenceLow: fields.referenceLow,
      referenceHigh: fields.referenceHigh, referenceText: fields.referenceText,
    });
    db.prepare(`
      UPDATE observations SET section_name = ?, item_code = ?, item_name = ?, normalized_name = NULL,
        result_text = ?, numeric_value = ?, unit = ?, reference_low = ?, reference_high = ?,
        reference_text = ?, abnormal_flag = ?, display_abnormal_flag = ?, abnormal_conflict = ?
      WHERE id = ? AND report_id = ?
    `).run(
      fields.sectionName, fields.itemCode, fields.itemName, fields.resultText, fields.numericValue,
      fields.unit, fields.referenceLow, fields.referenceHigh, fields.referenceText, fields.abnormalFlag,
      display.displayAbnormalFlag, display.abnormalConflict ? 1 : 0, observationId, reportId,
    );
    db.prepare(`
      INSERT INTO observation_field_overrides (
        id, report_id, source_key, observation_id, fields_json, canonical_key, is_manual_created, updated_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(report_id, source_key) DO UPDATE SET
        observation_id = excluded.observation_id, fields_json = excluded.fields_json,
        canonical_key = excluded.canonical_key, updated_by = excluded.updated_by,
        updated_at = CURRENT_TIMESTAMP
    `).run(
      overrideId, reportId, sourceKey, observationId, JSON.stringify(fields), canonicalKey,
      current.isManualCreated ? 1 : 0, user.id,
    );
    db.prepare("UPDATE reports SET source_version = source_version + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(reportId);
    db.prepare(`
      INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, detail_json)
      VALUES (?, ?, 'observation.manual_update', 'observation', ?, ?)
    `).run(createId("audit"), user.id, observationId, JSON.stringify({ memberId: report.memberId, reportId, fields: changedFields }));
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  normalizeReportObservations(reportId);
}
