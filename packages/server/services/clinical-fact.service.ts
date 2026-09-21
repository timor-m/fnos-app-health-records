import { rollbackAfterError, getDatabase } from "../database/client";
import { createError } from "h3";
import type { RequestUser } from "../domain/request-user";
import { createId } from "../utils/identifier";
import { assertMemberManage } from "./member.service";

export const clinicalFactTypes = [
  "diagnosis",
  "medication",
  "procedure",
  "vaccination",
  "billingSummary",
  "billingItem"
] as const;

export type ClinicalFactType = typeof clinicalFactTypes[number];

type FactConfig = {
  table: string;
  idPrefix: string;
};

const configs: Record<ClinicalFactType, FactConfig> = {
  diagnosis: { table: "report_diagnoses", idPrefix: "diagnosis" },
  medication: { table: "report_medications", idPrefix: "medication" },
  procedure: { table: "report_procedures", idPrefix: "procedure" },
  vaccination: { table: "vaccination_records", idPrefix: "vaccination" },
  billingSummary: { table: "billing_summaries", idPrefix: "billing" },
  billingItem: { table: "billing_items", idPrefix: "billingitem" }
};

function factType(value: unknown): ClinicalFactType {
  const type = String(value || "") as ClinicalFactType;
  if (!clinicalFactTypes.includes(type)) {
    throw createError({ statusCode: 400, statusMessage: "专属事实类型无效" });
  }
  return type;
}

function reportForManage(user: RequestUser, reportId: string) {
  const row = getDatabase().prepare(`
    SELECT id, member_id AS memberId FROM reports
    WHERE id = ? AND status <> 'trashed'
  `).get(reportId) as { id: string; memberId: string } | undefined;
  if (!row) throw createError({ statusCode: 404, statusMessage: "报告不存在" });
  assertMemberManage(user, row.memberId);
  return row;
}

function factForManage(user: RequestUser, type: ClinicalFactType, id: string) {
  const config = configs[type];
  const row = getDatabase().prepare(`
    SELECT f.id, f.report_id AS reportId, r.member_id AS memberId
    FROM ${config.table} f
    JOIN reports r ON r.id = f.report_id
    WHERE f.id = ? AND r.status <> 'trashed'
  `).get(id) as { id: string; reportId: string; memberId: string } | undefined;
  if (!row) throw createError({ statusCode: 404, statusMessage: "专属事实不存在" });
  assertMemberManage(user, row.memberId);
  return row;
}

function text(value: unknown, maxLength = 500) {
  if (value === null || value === undefined) return null;
  return String(value).trim().slice(0, maxLength) || null;
}

function number(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw createError({ statusCode: 400, statusMessage: "金额或数量必须是非负数" });
  }
  return parsed;
}

function enumValue(value: unknown, allowed: readonly string[], fallback: string) {
  const normalized = String(value || fallback);
  return allowed.includes(normalized) ? normalized : fallback;
}

function fieldsFor(type: ClinicalFactType, input: Record<string, unknown>, create: boolean) {
  const values = new Map<string, string | number | null>();
  const putText = (key: string, column: string, maxLength = 500, required = false) => {
    if (!(key in input) && !create) return;
    const value = text(input[key], maxLength);
    if (required && !value) throw createError({ statusCode: 400, statusMessage: `${key} 不能为空` });
    values.set(column, value);
  };
  const putEnum = (key: string, column: string, allowed: readonly string[], fallback: string) => {
    if (!(key in input) && !create) return;
    values.set(column, enumValue(input[key], allowed, fallback));
  };
  const putNumber = (key: string, column: string) => {
    if (!(key in input) && !create) return;
    values.set(column, number(input[key]));
  };

  if (type === "diagnosis") {
    putText("sectionName", "section_name", 200);
    putEnum("diagnosisType", "diagnosis_type", ["outpatient", "admission", "discharge", "pathology", "other"], "other");
    putText("diagnosisText", "diagnosis_text", 1000, true);
    putText("diagnosisCode", "diagnosis_code", 100);
    putText("codeSystem", "code_system", 100);
    if ("isPrimary" in input || create) values.set("is_primary", input.isPrimary ? 1 : 0);
  } else if (type === "medication") {
    putText("sectionName", "section_name", 200);
    putEnum("context", "medication_context", ["prescription", "outpatient", "inpatient", "discharge", "other"], "other");
    putText("medicationName", "medication_name", 300, true);
    putText("genericName", "generic_name", 300);
    putText("specification", "specification", 300);
    putText("dosageForm", "dosage_form", 100);
    putText("dose", "dose", 100);
    putText("doseUnit", "dose_unit", 60);
    putText("frequency", "frequency", 100);
    putText("route", "route", 100);
    putText("duration", "duration", 100);
    putText("quantity", "quantity", 100);
    putText("quantityUnit", "quantity_unit", 60);
    putText("instructions", "instructions", 2000);
  } else if (type === "procedure") {
    putText("sectionName", "section_name", 200);
    putEnum("procedureType", "procedure_type", ["examination", "treatment", "surgery", "other"], "other");
    putText("procedureName", "procedure_name", 500, true);
    putText("procedureCode", "procedure_code", 100);
    putText("bodyPart", "body_part", 300);
    putText("performedAt", "performed_at", 32);
    putText("resultText", "result_text", 2000);
  } else if (type === "vaccination") {
    putText("vaccineName", "vaccine_name", 300, true);
    putText("doseNumber", "dose_number", 100);
    putText("manufacturer", "manufacturer", 300);
    putText("lotNumber", "lot_number", 200);
    putText("administeredAt", "administered_at", 32);
    putText("administrationSite", "administration_site", 200);
    putText("nextDueAt", "next_due_at", 32);
  } else if (type === "billingSummary") {
    putText("invoiceNumber", "invoice_number", 200);
    putNumber("totalAmount", "total_amount");
    putNumber("insuranceAmount", "insurance_amount");
    putNumber("selfPayAmount", "self_pay_amount");
    if ("currency" in input || create) {
      values.set("currency", (text(input.currency, 8) || "CNY").toUpperCase());
    }
  } else {
    putText("category", "category", 200);
    putText("itemName", "item_name", 500, true);
    putNumber("amount", "amount");
    putNumber("quantity", "quantity");
  }
  if (!values.size) throw createError({ statusCode: 400, statusMessage: "没有需要保存的专属事实字段" });
  return values;
}

function appendAudit(
  user: RequestUser,
  action: "create" | "update" | "delete",
  type: ClinicalFactType,
  id: string,
  reportId: string,
  fields: string[]
) {
  getDatabase().prepare(`
    INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, detail_json)
    VALUES (?, ?, ?, 'clinical_fact', ?, ?)
  `).run(
    createId("audit"),
    user.id,
    `clinical_fact.${action}`,
    id,
    JSON.stringify({ reportId, factType: type, fields })
  );
}

export function createClinicalFact(
  user: RequestUser,
  reportId: string,
  rawType: unknown,
  input: Record<string, unknown>
) {
  const type = factType(rawType);
  reportForManage(user, reportId);
  const config = configs[type];
  const fields = fieldsFor(type, input, true);
  const id = createId(config.idPrefix);
  const db = getDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    if (type === "billingSummary") {
      const existing = db.prepare("SELECT id FROM billing_summaries WHERE report_id = ?").get(reportId) as
        | { id: string }
        | undefined;
      if (existing) {
        const assignments = [...fields.keys()].map((column) => `${column} = ?`);
        db.prepare(`UPDATE billing_summaries SET ${assignments.join(", ")},
          source = 'manual', manual_fields_json = '["*"]', is_deleted = 0,
          updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
          .run(...fields.values(), existing.id);
        appendAudit(user, "update", type, existing.id, reportId, [...fields.keys()]);
        db.exec("COMMIT");
        return { id: existing.id, reportId, type };
      }
    }
    const columns = [...fields.keys()];
    db.prepare(`INSERT INTO ${config.table} (
      id, report_id, ${columns.join(", ")}, evidence_json, source, manual_fields_json, is_deleted
    ) VALUES (?, ?, ${columns.map(() => "?").join(", ")}, '[]', 'manual', '["*"]', 0)`)
      .run(id, reportId, ...fields.values());
    appendAudit(user, "create", type, id, reportId, columns);
    db.exec("COMMIT");
  } catch (error) {
    rollbackAfterError(db);
    throw error;
  }
  return { id, reportId, type };
}

export function updateClinicalFact(
  user: RequestUser,
  rawType: unknown,
  id: string,
  input: Record<string, unknown>
) {
  const type = factType(rawType);
  const fact = factForManage(user, type, id);
  const fields = fieldsFor(type, input, false);
  const assignments = [...fields.keys()].map((column) => `${column} = ?`);
  const db = getDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`UPDATE ${configs[type].table} SET ${assignments.join(", ")},
      source = 'manual', manual_fields_json = '["*"]', is_deleted = 0,
      updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(...fields.values(), id);
    appendAudit(user, "update", type, id, fact.reportId, [...fields.keys()]);
    db.exec("COMMIT");
  } catch (error) {
    rollbackAfterError(db);
    throw error;
  }
  return { id, reportId: fact.reportId, type };
}

export function deleteClinicalFact(user: RequestUser, rawType: unknown, id: string) {
  const type = factType(rawType);
  const fact = factForManage(user, type, id);
  const db = getDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`UPDATE ${configs[type].table} SET
      source = 'manual', manual_fields_json = '["*","deleted"]', is_deleted = 1,
      updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(id);
    appendAudit(user, "delete", type, id, fact.reportId, []);
    db.exec("COMMIT");
  } catch (error) {
    rollbackAfterError(db);
    throw error;
  }
  return { id, reportId: fact.reportId, type };
}
