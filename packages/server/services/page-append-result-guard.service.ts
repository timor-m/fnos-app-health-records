import { createError } from "h3";
import { getDatabase } from "../database/client";
// Compare the published records after all evidence filters and manual overrides, inside
// the publication transaction. An incomplete candidate rolls back every structured table.
const tables = [
  "observations",
  "report_diagnoses",
  "report_medications",
  "report_procedures",
  "vaccination_records",
  "billing_items",
  "billing_summaries",
  "report_structured_sections",
  "morphology_findings",
] as const;
const ignored = new Set([
  "id",
  "created_at",
  "updated_at",
  "normalized_name",
  "display_abnormal_flag",
  "abnormal_conflict",
  "evidence_json",
  "confidence",
  "source",
  "manual_fields_json",
  "updated_by",
  "created_by",
  "examination_id",
]);
const compact = (value: unknown) => typeof value === "string"
  ? value.normalize("NFKC").replace(/[\s（）()，,。.:：;；、|_\-]+/g, "").toLowerCase()
  : value;
function sameObservationMeasurement(left: Record<string, unknown>, right: Record<string, unknown>, sameLegacySource: boolean) {
  const sameExamination = Boolean(left.examination_id && left.examination_id === right.examination_id);
  if (!sameExamination && !(sameLegacySource && !left.examination_id)) return false;
  const leftNames = [left.item_name, left.normalized_name].map(compact);
  const rightNames = [right.item_name, right.normalized_name].map(compact);
  if (!leftNames.some((name) => name && rightNames.includes(name))) return false;
  const leftValue = typeof left.numeric_value === "number" ? left.numeric_value : null;
  const rightValue = typeof right.numeric_value === "number" ? right.numeric_value : null;
  const sameValue = leftValue !== null && rightValue !== null
    ? Math.abs(leftValue - rightValue) <= Math.max(1, Math.abs(leftValue), Math.abs(rightValue)) * 1e-10
    : compact(left.result_text) === compact(right.result_text);
  if (!sameValue) return false;
  for (const key of ["unit", "method"] as const) {
    const a = compact(left[key]);
    const b = compact(right[key]);
    if (a && b && a !== b) return false;
  }
  return true;
}
export function snapshotPublishedRecords(reportId: string) {
  const db = getDatabase();
  return tables.map((table) => ({
    table,
    rows: table === "observations"
      ? db.prepare(`SELECT o.*,l.examination_id AS examination_id FROM observations o
          LEFT JOIN observation_examinations l ON l.observation_id=o.id WHERE o.report_id=?`).all(reportId)
      : db.prepare(`SELECT * FROM ${table} WHERE report_id=?`).all(reportId),
  }));
}
export function assertPublishedRecordsRetained(
  reportId: string,
  before: ReturnType<typeof snapshotPublishedRecords>,
) {
  const db = getDatabase();
  const compact = (v: unknown) =>
    typeof v === "string"
      ? v.normalize("NFKC").replace(/\s+/g, "").toLowerCase()
      : v;
  for (const { table, rows } of before) {
    const after = table === "observations"
      ? db.prepare(`SELECT o.*,l.examination_id AS examination_id FROM observations o
          LEFT JOIN observation_examinations l ON l.observation_id=o.id WHERE o.report_id=?`).all(reportId)
      : db.prepare(`SELECT * FROM ${table} WHERE report_id=?`).all(reportId);
    const sourcePages = (row: Record<string, unknown>) => {
      const evidence = JSON.parse(String(row.evidence_json || "[]"));
      return Array.isArray(evidence)
        ? evidence
            .map(
              (e) =>
                e.pageId ||
                (
                  db
                    .prepare(
                      "SELECT id FROM report_pages WHERE report_id=? AND page_number=?",
                    )
                    .get(reportId, Number(e.pageNumber) || 0) as
                    { id: string } | undefined
                )?.id,
            )
            .filter(Boolean)
        : [];
    };
    for (const old of rows) {
      const match = after.findIndex(
        (next) =>
          (table !== "observations" ||
            !sourcePages(old).length ||
            sourcePages(old).every((id) => sourcePages(next).includes(id))) &&
          Object.keys(old)
            .filter(
              (k) =>
                !ignored.has(k) &&
                !(
                  table === "morphology_findings" &&
                  (k === "tracking_group_id" || k === "match_confidence") &&
                  !JSON.parse(String(old.manual_fields_json || "[]")).includes(
                    "trackingGroup",
                  )
                ),
            )
            .every((k) => compact(old[k]) === compact(next[k])),
      );
      const equivalentObservation = table === "observations" && match < 0
        ? after.findIndex((next) => sameObservationMeasurement(old, next,
            sourcePages(old).length > 0 && sourcePages(old).some((id) => sourcePages(next).includes(id))))
        : -1;
      if (match < 0 && equivalentObservation < 0)
        throw Object.assign(
          createError({
            statusCode: 409,
            data: { code: "UPLOAD_CONFLICT" },
            statusMessage:
              "新识别结果缺少或改变了已有记录，已保留上一版结果，请人工核对",
          }),
          { appendCandidateRejected: true },
        );
      after.splice(match >= 0 ? match : equivalentObservation, 1);
    }
  }
}

/** Read existing candidate/unit audit records; never expose report text in warnings. */
export function appendReviewWarnings(jobId: string | null): string[] {
  if (!jobId) return [];
  const db = getDatabase();
  const warnings = (
    db
      .prepare(
        `SELECT page_number AS page,COUNT(*) AS count
    FROM ai_extraction_candidates WHERE job_id=? AND status='unresolved'
    GROUP BY page_number ORDER BY page_number`,
      )
      .all(jobId) as Array<{ page: number; count: number }>
  ).map(
    (row) =>
      `本次识别第 ${row.page} 页有 ${row.count} 项内容未完整匹配，请对照原件核对`,
  );
  const units = db
    .prepare(
      `SELECT page_numbers_json AS pages FROM ai_extraction_units
    WHERE job_id=? AND (status='warning' OR
    COALESCE(json_extract(result_json,'$.evidenceValidation.rejectedObservations'),0)
    + COALESCE(json_extract(result_json,'$.evidenceValidation.rejectedMorphologyFindings'),0)
    + COALESCE(json_extract(result_json,'$.evidenceValidation.rejectedClinicalFacts'),0)
    + COALESCE(json_extract(result_json,'$.evidenceValidation.rejectedStructuredSections'),0)>0)`,
    )
    .all(jobId) as Array<{ pages: string }>;
  for (const unit of units) {
    const pages = JSON.parse(unit.pages || "[]") as number[];
    warnings.push(
      `本次识别第 ${pages.join("、")} 页有内容未通过证据校验或补识别未完成，请人工核对`,
    );
  }
  return [...new Set(warnings)];
}
