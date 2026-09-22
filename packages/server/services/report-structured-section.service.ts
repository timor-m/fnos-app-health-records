import { assertNoPageAppend } from "./page-append-lock.service";
import { createError } from "h3";
import { rollbackAfterError, getDatabase } from "../database/client";
import {
  reportStructuredSectionKeys,
  type ReportStructuredSectionKey
} from "../domain/health-record";
import type { RequestUser } from "../domain/request-user";
import { createId } from "../utils/identifier";
import { assertMemberManage } from "./member.service";

export const reportStructuredSectionLabels: Record<ReportStructuredSectionKey, string> = {
  checkup_package: "体检套餐",
  checkup_positive_findings: "阳性发现",
  checkup_abnormal_summary: "异常汇总",
  checkup_final_conclusion: "总检结论",
  checkup_original_recommendation: "原报告建议",
  laboratory_specimen: "检验标本",
  laboratory_method: "检验方法",
  imaging_modality: "检查方式",
  imaging_contrast: "增强信息",
  functional_method: "检查方法",
  functional_description: "检查描述",
  pathology_specimen: "病理标本",
  pathology_gross_findings: "肉眼所见",
  pathology_microscopic_findings: "镜下所见",
  pathology_immunohistochemistry: "免疫组化",
  pathology_grade: "病理分级",
  pathology_stage: "病理分期",
  outpatient_history: "病史",
  outpatient_physical_examination: "体格检查",
  outpatient_disposition: "处置",
  outpatient_advice: "医嘱",
  inpatient_course: "住院经过",
  inpatient_discharge_instructions: "出院医嘱"
};

export function reportStructuredSectionKey(value: unknown): ReportStructuredSectionKey {
  const key = String(value || "") as ReportStructuredSectionKey;
  if (!reportStructuredSectionKeys.includes(key)) {
    throw createError({ statusCode: 400, statusMessage: "报告专属内容类型无效" });
  }
  return key;
}

function reportForManage(user: RequestUser, reportId: string) {
  const row = getDatabase().prepare(`
    SELECT id, member_id AS memberId FROM reports
    WHERE id = ? AND status <> 'trashed'
  `).get(reportId) as { id: string; memberId: string } | undefined;
  if (!row) throw createError({ statusCode: 404, statusMessage: "报告不存在" });
  assertMemberManage(user, row.memberId);
  assertNoPageAppend(row.id);
  return row;
}

function sectionForManage(user: RequestUser, id: string) {
  const row = getDatabase().prepare(`
    SELECT s.id, s.report_id AS reportId, r.member_id AS memberId
    FROM report_structured_sections s
    JOIN reports r ON r.id = s.report_id
    WHERE s.id = ? AND r.status <> 'trashed'
  `).get(id) as { id: string; reportId: string; memberId: string } | undefined;
  if (!row) throw createError({ statusCode: 404, statusMessage: "报告专属内容不存在" });
  assertMemberManage(user, row.memberId);
  assertNoPageAppend(row.reportId);
  return row;
}

function cleanText(value: unknown, maxLength: number) {
  if (value === null || value === undefined) return null;
  return String(value).trim().slice(0, maxLength) || null;
}

function sectionValues(input: Record<string, unknown>, create: boolean) {
  const key = "sectionKey" in input || create ? reportStructuredSectionKey(input.sectionKey) : null;
  const title = "title" in input || create
    ? cleanText(input.title, 120) || (key ? reportStructuredSectionLabels[key] : null)
    : null;
  const content = "content" in input || create ? cleanText(input.content, 20_000) : null;
  if (create && !content) {
    throw createError({ statusCode: 400, statusMessage: "专属内容不能为空" });
  }
  if (!create && !("sectionKey" in input || "title" in input || "content" in input)) {
    throw createError({ statusCode: 400, statusMessage: "没有需要保存的专属内容" });
  }
  if ("content" in input && !content) {
    throw createError({ statusCode: 400, statusMessage: "专属内容不能为空" });
  }
  return { key, title, content };
}

function appendAudit(
  user: RequestUser,
  action: "create" | "update" | "delete",
  id: string,
  reportId: string,
  sectionKey: ReportStructuredSectionKey | null
) {
  getDatabase().prepare(`
    INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, detail_json)
    VALUES (?, ?, ?, 'report_structured_section', ?, ?)
  `).run(
    createId("audit"),
    user.id,
    `report_structured_section.${action}`,
    id,
    JSON.stringify({ reportId, sectionKey })
  );
}

export function createReportStructuredSection(
  user: RequestUser,
  reportId: string,
  input: Record<string, unknown>
) {
  reportForManage(user, reportId);
  const values = sectionValues(input, true);
  const id = createId("section");
  const db = getDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`
      INSERT INTO report_structured_sections (
        id, report_id, section_key, section_title, content_text,
        evidence_json, source, manual_fields_json, is_deleted
      ) VALUES (?, ?, ?, ?, ?, '[]', 'manual', '["*"]', 0)
    `).run(id, reportId, values.key, values.title, values.content);
    appendAudit(user, "create", id, reportId, values.key);
    db.exec("COMMIT");
  } catch (error) {
    rollbackAfterError(db);
    throw error;
  }
  return { id, reportId };
}

export function updateReportStructuredSection(
  user: RequestUser,
  id: string,
  input: Record<string, unknown>
) {
  const section = sectionForManage(user, id);
  const values = sectionValues(input, false);
  const assignments: string[] = [];
  const args: Array<string | null> = [];
  if ("sectionKey" in input) {
    assignments.push("section_key = ?");
    args.push(values.key);
  }
  if ("title" in input || "sectionKey" in input) {
    assignments.push("section_title = ?");
    args.push(values.title);
  }
  if ("content" in input) {
    assignments.push("content_text = ?");
    args.push(values.content);
  }
  const db = getDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`UPDATE report_structured_sections SET ${assignments.join(", ")},
      source = 'manual', manual_fields_json = '["*"]', is_deleted = 0,
      updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...args, id);
    appendAudit(user, "update", id, section.reportId, values.key);
    db.exec("COMMIT");
  } catch (error) {
    rollbackAfterError(db);
    throw error;
  }
  return { id, reportId: section.reportId };
}

export function deleteReportStructuredSection(user: RequestUser, id: string) {
  const section = sectionForManage(user, id);
  const db = getDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    const current = db.prepare(`
      SELECT section_key AS sectionKey FROM report_structured_sections WHERE id = ?
    `).get(id) as { sectionKey: ReportStructuredSectionKey };
    db.prepare(`UPDATE report_structured_sections SET
      source = 'manual', manual_fields_json = '["*","deleted"]', is_deleted = 1,
      updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(id);
    appendAudit(user, "delete", id, section.reportId, current.sectionKey);
    db.exec("COMMIT");
  } catch (error) {
    rollbackAfterError(db);
    throw error;
  }
  return { id, reportId: section.reportId };
}
