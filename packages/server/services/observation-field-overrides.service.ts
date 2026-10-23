import {sourceRegion} from "../../shared/source-region";
import { assertNoPageAppend } from "./page-append-lock.service";
import { consumeUnverifiedPreviousObservation } from './extraction-review.service';
import type { ExaminationInput } from "../domain/examination";
import { createHash } from "node:crypto";
import { createError } from "h3";
import { rollbackAfterError, getDatabase } from "../database/client";
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
  examination?: ExaminationInput;
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
  evidenceJson?: string | null;
};

export type AppliedObservationOverride = {
  observation: PersistableObservation;
  overrideId: string | null;
  manualCreated: boolean;
};

function compactIdentity(value: unknown) {
  return String(value || "").normalize("NFKC").toLocaleLowerCase("zh-CN").replace(/\s+/g, "").trim();
}

export function observationSourceKey(input: EditableObservationFields & Partial<Pick<PersistableObservation, "evidence" | "method">>, reportId?: string, normalizeSeparators = true) {
  const evidence = (input.evidence || []).map((entry) => ({
    pageNumber: reportId ? (entry.pageId || (getDatabase().prepare("SELECT id FROM report_pages WHERE report_id=? AND page_number=?").get(reportId,Number(entry.pageNumber)||0) as {id:string}|undefined)?.id || Number(entry.pageNumber) || 0) : Number(entry.pageNumber) || 0,
    quote: normalizeSeparators ? compactIdentity(entry.quote).replace(/[|｜:：]/g, "") : compactIdentity(entry.quote),
    ...(typeof entry.examinationSourceKey==='string' ? {examinationSourceKey:entry.examinationSourceKey} : {}),
  }));
  return createHash("sha256").update(JSON.stringify({
    sectionName: compactIdentity(input.sectionName),
    itemCode: compactIdentity(input.itemCode),
    itemName: compactIdentity(input.itemName),
    ...(reportId ? {unit:compactIdentity(input.unit),method:compactIdentity(input.method)} : {}),
    evidence,
  })).digest("hex");
}

function sourceKeyVariants(input: PersistableObservation, reportId: string) {
  return [observationSourceKey(input, reportId), observationSourceKey(input),
    observationSourceKey(input, reportId, false), observationSourceKey(input, undefined, false)];
}

function parseFields(value: string): EditableObservationFields | null {
  try {
    const parsed = JSON.parse(value) as EditableObservationFields;
    return parsed && typeof parsed.itemName === "string" && typeof parsed.resultText === "string" ? parsed : null;
  } catch {
    return null;
  }
}

function savedSourceEvidence(row: Pick<OverrideRow, 'fieldsJson' | 'evidenceJson'>, reportId: string): PersistableObservation['evidence'] {
  try {
    const saved = JSON.parse(row.fieldsJson)._sourceEvidence;
    const current = JSON.parse(row.evidenceJson || '[]');
    const evidence = Array.isArray(saved) ? saved : Array.isArray(current) ? current : [];
    return evidence.map(entry => {
      const page = entry.pageId
        ? getDatabase().prepare('SELECT id, page_number AS pageNumber FROM report_pages WHERE report_id=? AND id=?').get(reportId, entry.pageId)
        : getDatabase().prepare('SELECT id, page_number AS pageNumber FROM report_pages WHERE report_id=? AND page_number=?').get(reportId, Number(entry.pageNumber) || 0);
      return page ? {...entry, pageId: page.id, pageNumber: page.pageNumber} : entry.pageId ? {...entry, pageNumber: undefined} : entry;
    });
  } catch { return []; }
}

export function applyObservationFieldOverrides(
  reportId: string,
  observations: PersistableObservation[],
): AppliedObservationOverride[] {
  const rows = getDatabase().prepare(`
    SELECT override.id, source_key AS sourceKey, observation_id AS observationId,
      fields_json AS fieldsJson, is_manual_created AS isManualCreated, o.evidence_json AS evidenceJson
    FROM observation_field_overrides override LEFT JOIN observations o ON o.id=override.observation_id
    WHERE override.report_id = ? ORDER BY override.created_at, override.id
  `).all(reportId) as OverrideRow[];
  const bySourceKey = new Map(rows.map((row) => [row.sourceKey, row]));
  const used = new Set<string>();
  const suppressed = new Set((getDatabase().prepare('SELECT source_key FROM observation_suppressions WHERE report_id=?').all(reportId) as {source_key:string}[]).map(row=>row.source_key));
  const result = observations.filter(observation=>!sourceKeyVariants(observation, reportId).some(key => suppressed.has(key))).map((observation) => {
    // One quote can contain several items. Only a full source identity may bind an
    // override; unmatched manual values are retained separately below.
    const override = sourceKeyVariants(observation, reportId).map(key => bySourceKey.get(key)).find(Boolean);
    const fields = override ? parseFields(override.fieldsJson) : null;
    if (!override || !fields || used.has(override.id)) {
      return { observation, overrideId: null, manualCreated: false };
    }
    used.add(override.id);
    return {
      observation: { ...observation, ...fields, normalizedName: null, ...(JSON.parse(override.fieldsJson)._manualSourceChanged ? {evidence:savedSourceEvidence(override,reportId)} : {}) },
      overrideId: override.id,
      manualCreated: Boolean(override.isManualCreated),
    };
  });
  for (const row of rows) {
    if (used.has(row.id)) continue;
    const fields = parseFields(row.fieldsJson);
    if (!fields) continue;
    result.push({
      observation: { ...fields, normalizedName: null, method: "manual", evidence: savedSourceEvidence(row, reportId) },
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
  assertNoPageAppend(reportId);
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

function selectedSourceEvidence(reportId: string, input: Record<string, unknown>) {
  const pageId = input.sourcePageId;
  if (pageId === undefined) {
    if (input.sourceRegion != null) throw createError({statusCode:400,statusMessage:"请先选择框选区域的来源页"});
    return undefined;
  }
  if (pageId === null || pageId === '') {
    if (input.sourceRegion != null) throw createError({statusCode:400,statusMessage:'请先选择框选区域的来源页'});
    return [];
  }
  if (typeof pageId !== 'string') throw createError({statusCode:400,statusMessage:'来源页无效'});
  const page = getDatabase().prepare('SELECT id,page_number AS pageNumber,sha256,rotation,mime_type AS mimeType FROM report_pages WHERE report_id=? AND id=?').get(reportId,pageId) as {id:string;pageNumber:number;sha256:string;rotation:number;mimeType:string}|undefined;
  if (!page) throw createError({statusCode:400,statusMessage:'来源页不存在或不属于当前报告'});
  const region = input.sourceRegion == null ? null : sourceRegion(input.sourceRegion);
  if (input.sourceRegion != null && !region) throw createError({statusCode:400,statusMessage:'框选区域无效，请重新选择'});
  if (region && region.rotation !== (page.mimeType==='application/pdf' ? page.rotation : 0)) throw createError({statusCode:409,statusMessage:'页面方向已变化，请重新选择区域'});
  return [{pageId:page.id,pageNumber:page.pageNumber,quote:'',...(region ? {manualRegion:{...region,pageSha256:page.sha256}} : {})}];
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
    if (input.expectedSourceVersion !== undefined && input.previousObservationIndex == null) {
      const version = db.prepare('SELECT source_version AS version FROM reports WHERE id=?').get(reportId) as {version:number};
      if (!Number.isInteger(input.expectedSourceVersion) || input.expectedSourceVersion !== version.version) {
        throw createError({ statusCode: 409, statusMessage: "报告已更新，请刷新后重新补充，当前输入尚未保存" });
      }
    }
    const selectedEvidence = selectedSourceEvidence(reportId,input);
    insertObservation(reportId, observationId, fields);
    const reviewed = input.previousObservationIndex === undefined || input.previousObservationIndex === null ? null
      : consumeUnverifiedPreviousObservation(reportId,input.previousObservationIndex,input.expectedSourceVersion);
    const reviewedEvidence = selectedEvidence ? JSON.stringify(selectedEvidence)
      : reviewed ? JSON.stringify([{pageNumber:reviewed.pageNumber || 1,quote:reviewed.sourceText}]) : '[]';
    if (reviewed || selectedEvidence) db.prepare('UPDATE observations SET evidence_json=? WHERE id=?').run(reviewedEvidence,observationId);
    db.prepare(`
      INSERT INTO observation_field_overrides (
        id, report_id, source_key, observation_id, fields_json, canonical_key, is_manual_created, updated_by
      ) VALUES (?, ?, ?, ?, ?, ?, 1, ?)
    `).run(overrideId, reportId, `manual:${overrideId}`, observationId, JSON.stringify({...fields,...((reviewed || selectedEvidence) ? {_sourceEvidence:JSON.parse(reviewedEvidence)} : {})}), canonicalKey, user.id);
    db.prepare("UPDATE reports SET source_version = source_version + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(reportId);
    db.prepare(`
      INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, detail_json)
      VALUES (?, ?, 'observation.manual_create', 'observation', ?, ?)
    `).run(createId("audit"), user.id, observationId, JSON.stringify({
      memberId: report.memberId,
      reportId,
      fields: [...Object.keys(fields), ...(canonicalKey ? ["canonicalKey"] : []), ...(selectedEvidence !== undefined ? ["source"] : [])],
    }));
    db.exec("COMMIT");
  } catch (error) {
    rollbackAfterError(db);
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
      o.evidence_json AS evidenceJson, o.method, override.id AS overrideId,
      override.source_key AS sourceKey, override.canonical_key AS currentCanonicalKey,
      override.is_manual_created AS isManualCreated, override.fields_json AS fieldsJson
    FROM observations o
    LEFT JOIN observation_field_overrides override ON override.observation_id = o.id
    WHERE o.id = ? AND o.report_id = ?
  `).get(observationId, reportId) as (EditableObservationFields & {
    evidenceJson: string; method: string | null; overrideId: string | null; sourceKey: string | null;
    currentCanonicalKey: string | null; isManualCreated: number | null; fieldsJson: string | null;
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
  const sourceKey = current.sourceKey || observationSourceKey({ ...current, evidence }, reportId);
  const overrideId = current.overrideId || createId("observation-override");
  const changedFields = (Object.keys(fields) as Array<keyof EditableObservationFields>)
    .filter((key) => (current[key] ?? null) !== (fields[key] ?? null));
  if ((current.currentCanonicalKey || null) !== canonicalKey) changedFields.push("canonicalKey" as keyof EditableObservationFields);
  db.exec("BEGIN IMMEDIATE");
  try {
    if (input.expectedSourceVersion !== undefined) {
      const version = db.prepare('SELECT source_version AS version FROM reports WHERE id=?').get(reportId) as {version:number};
      if (!Number.isInteger(input.expectedSourceVersion) || input.expectedSourceVersion !== version.version) {
        throw createError({ statusCode: 409, statusMessage: "报告已更新，请刷新后重新校对，当前输入尚未保存" });
      }
    }
    const changedSource = selectedSourceEvidence(reportId,input);
    if (changedSource !== undefined) db.prepare("UPDATE observations SET evidence_json=? WHERE id=?").run(JSON.stringify(changedSource),observationId);
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
      overrideId, reportId, sourceKey, observationId, JSON.stringify({ ...fields,
        _manualSourceChanged: changedSource !== undefined || Boolean(JSON.parse(current.fieldsJson || '{}')._manualSourceChanged),
        _sourceEvidence: changedSource ?? savedSourceEvidence({fieldsJson:current.fieldsJson || '{}',evidenceJson:current.evidenceJson}, reportId) }), canonicalKey,
      current.isManualCreated ? 1 : 0, user.id,
    );
    db.prepare("UPDATE reports SET source_version = source_version + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(reportId);
    db.prepare(`
      INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, detail_json)
      VALUES (?, ?, 'observation.manual_update', 'observation', ?, ?)
    `).run(createId("audit"), user.id, observationId, JSON.stringify({ memberId: report.memberId, reportId, fields: changedFields }));
    db.exec("COMMIT");
  } catch (error) {
    rollbackAfterError(db);
    throw error;
  }
  normalizeReportObservations(reportId);
}

export function deleteManualObservation(user: RequestUser, reportId: string, observationId: string) {
  managedReport(user, reportId);
  const db = getDatabase();
  db.exec('BEGIN IMMEDIATE');
  try {
    if (!db.prepare('SELECT 1 FROM observations WHERE id = ? AND report_id = ?').get(observationId, reportId)) {
      throw createError({ statusCode: 404, statusMessage: '指标不存在' });
    }
    const deleted = db.prepare(`SELECT section_name AS sectionName,item_code AS itemCode,item_name AS itemName,result_text AS resultText,unit,method,evidence_json AS evidenceJson FROM observations WHERE id=? AND report_id=?`).get(observationId,reportId) as EditableObservationFields & {evidenceJson:string;method:string|null};
    const original = db.prepare('SELECT source_key FROM observation_field_overrides WHERE observation_id=? AND report_id=?').get(observationId,reportId) as {source_key:string}|undefined;
    const parsed = JSON.parse(deleted.evidenceJson);
    const sourceKey = observationSourceKey({...deleted,evidence:Array.isArray(parsed)?parsed:[]},reportId);
    db.prepare('INSERT OR IGNORE INTO observation_suppressions(report_id,source_key) VALUES(?,?)').run(reportId,sourceKey);
    if(original) db.prepare('INSERT OR IGNORE INTO observation_suppressions(report_id,source_key) VALUES(?,?)').run(reportId,original.source_key);
    // Keep a source tombstone so future full-report extraction cannot resurrect it.
    db.prepare('DELETE FROM observation_field_overrides WHERE observation_id = ? AND report_id = ?').run(observationId, reportId);
    db.prepare('DELETE FROM observations WHERE id = ? AND report_id = ?').run(observationId, reportId);
    db.prepare('UPDATE reports SET source_version = source_version + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(reportId);
    db.prepare(`INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, detail_json)
      VALUES (?, ?, 'observation.manual_delete', 'observation', ?, '{}')`).run(createId('audit'), user.id, observationId);
    db.exec('COMMIT');
  } catch (error) {
    rollbackAfterError(db);
    throw error;
  }
  normalizeReportObservations(reportId);
}
