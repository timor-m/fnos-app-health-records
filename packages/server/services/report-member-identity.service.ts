import { createError } from "h3";
import { getDatabase } from "../database/client";
import { createId } from "../utils/identifier";
import type { RequestUser } from "../domain/request-user";
import { patientSexFromOcrText } from "./ai-input-planner.service";
import { assertMemberManage, createMember } from "./member.service";

/*
 * 报告患者身份与成员档案匹配：上传时选错成员是家庭场景的高发误操作。
 * 系统刻意不存储患者姓名，因此只用性别和出生日期两个弱标识信号：
 * 二者均可在本地从 OCR 提取，与成员资料冲突时给出提醒，
 * 并支持一键归属到匹配成员或创建新成员后归属。
 */

export type PatientIdentity = {
  sex: "male" | "female" | null;
  birthDate: string | null;
  age: PatientAgeSignal | null;
};

/*
 * 年龄信号：儿童体检报告普遍只印“年龄：6个月”而不印出生日期，
 * 年龄是这类报告唯一的身份锚点。months 为折算后的月龄，
 * toleranceMonths 是对比容差（岁数取整 ±13 个月、月数 ±2 个月、天数 ±1 个月）。
 */
export type PatientAgeSignal = {
  months: number;
  toleranceMonths: number;
  text: string;
};

export type MemberIdentityAssessment = {
  patientSex: "male" | "female" | null;
  patientBirthDate: string | null;
  patientAgeText: string | null;
  patientApproxBirthDate: string | null;
  mismatchedFields: Array<"sex" | "birthDate">;
  candidates: Array<{
    id: string;
    displayName: string;
    relationship: string;
  }>;
};

const identityDismissedFieldKey = "member_identity_mismatch_dismissed";

function normalizeBirthDateText(value: string) {
  const match = value.match(
    /(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?/,
  );
  if (!match) return null;
  const [, year, month, day] = match;
  const normalized = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  const date = new Date(`${normalized}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== normalized)
    return null;
  if (normalized > new Date().toISOString().slice(0, 10)) return null;
  return normalized;
}

/*
 * 出生日期只在显式标签（出生日期/出生年月/生日）附近采信；
 * 独立出现的日期不猜，避免把检查日期、报告日期误判为出生日期。
 */
export function patientBirthDateFromOcrText(
  linesJsonValues: Array<string | null>,
): string | null {
  for (const value of linesJsonValues.slice(0, 3)) {
    let lines: Array<{ text?: unknown }> = [];
    try {
      const parsed = JSON.parse(value || "[]") as unknown;
      if (Array.isArray(parsed)) lines = parsed;
    } catch {
      continue;
    }
    for (const line of lines) {
      const text = String(line.text || "").trim();
      if (!text) continue;
      const labelIndex = text.search(/出生日期|出生年月|生日/);
      if (labelIndex < 0) continue;
      const birthDate = normalizeBirthDateText(text.slice(labelIndex));
      if (birthDate) return birthDate;
    }
  }
  return null;
}

/*
 * 患者年龄只在显式“年龄/龄”标签旁采信，与出生日期同一保守原则：
 * “3 个月后复查”一类叙述没有标签，不会被误认为年龄。
 */
export function patientAgeFromOcrText(
  linesJsonValues: Array<string | null>,
): PatientAgeSignal | null {
  for (const value of linesJsonValues.slice(0, 3)) {
    let lines: Array<{ text?: unknown }> = [];
    try {
      const parsed = JSON.parse(value || "[]") as unknown;
      if (Array.isArray(parsed)) lines = parsed;
    } catch {
      continue;
    }
    for (const line of lines) {
      const text = String(line.text || "").trim();
      if (!text) continue;
      const match = text.match(
        /(?:年龄|(?<![一-鿿])龄)\s*[:：]?\s*(\d+(?:\.\d+)?)\s*(周岁|岁|个月|月龄|月|天|日)/,
      );
      if (!match) continue;
      const amount = Number(match[1]);
      if (!Number.isFinite(amount)) continue;
      const unit = match[2];
      if (unit === "岁" || unit === "周岁") {
        if (amount > 130) continue;
        return {
          months: Math.round(amount * 12),
          toleranceMonths: 13,
          text: `${match[1]}${unit}`,
        };
      }
      if (unit === "个月" || unit === "月龄" || unit === "月") {
        if (amount > 240) continue;
        return {
          months: Math.round(amount),
          toleranceMonths: 2,
          text: `${match[1]}${unit}`,
        };
      }
      if (amount > 3650) continue;
      return {
        months: Math.max(1, Math.round(amount / 30)),
        toleranceMonths: 1,
        text: `${match[1]}${unit}`,
      };
    }
  }
  return null;
}

function reportOcrLinesJson(reportId: string) {
  return (
    getDatabase()
      .prepare(
        `
      SELECT o.lines_json AS linesJson
      FROM ocr_results o
      JOIN report_pages p ON p.id = o.page_id
      WHERE p.report_id = ?
      ORDER BY p.page_number
      LIMIT 3
    `,
      )
      .all(reportId) as Array<{ linesJson: string | null }>
  ).map((row) => row.linesJson);
}

export function patientIdentityForReport(reportId: string): PatientIdentity {
  const linesJsonValues = reportOcrLinesJson(reportId);
  return {
    sex: patientSexFromOcrText(linesJsonValues),
    birthDate: patientBirthDateFromOcrText(linesJsonValues),
    age: patientAgeFromOcrText(linesJsonValues),
  };
}

function ageMonthsBetween(birthDate: string, referenceDate: string) {
  const [birthYear, birthMonth] = birthDate.split("-").map(Number);
  const [refYear, refMonth] = referenceDate.split("-").map(Number);
  if (!birthYear || !birthMonth || !refYear || !refMonth) return null;
  return (refYear - birthYear) * 12 + (refMonth - birthMonth);
}

/*
 * 报告只印年龄时，按报告参考日期倒退月龄得到近似出生日期，
 * 用于“创建新成员并归属”表单的预填。仅月级精度（婴幼儿场景）可推，
 * 岁级年龄取整误差太大，给出假精确日期反而会误导用户确认。
 */
function approxBirthDateFromAge(
  referenceDate: string,
  age: PatientAgeSignal,
): string | null {
  if (age.toleranceMonths > 2) return null;
  const date = new Date(`${referenceDate}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  date.setUTCMonth(date.getUTCMonth() - age.months);
  return date.toISOString().slice(0, 10);
}

/*
 * 评估报告患者与当前成员是否可能不符：
 * - 成员资料没有性别和出生日期，或 OCR 提取不到任何信号时，不判断（返回 null）
 * - 性别冲突或出生日期冲突即视为可能不符；候选成员要求出生日期精确一致，
 *   仅性别一致太弱，不构成归属建议
 * - 用户已忽略的提醒不再返回
 */
export function assessReportMemberIdentity(
  user: RequestUser,
  reportId: string,
): MemberIdentityAssessment | null {
  const db = getDatabase();
  const report = db
    .prepare(
      `
    SELECT r.member_id AS memberId, m.sex AS memberSex, m.birth_date AS memberBirthDate,
      substr(COALESCE(r.sampled_at, r.examined_at, r.report_issued_at, r.created_at), 1, 10) AS referenceDate
    FROM reports r
    JOIN health_members m ON m.id = r.member_id
    WHERE r.id = ? AND r.status <> 'trashed' AND m.deleted_at IS NULL
  `,
    )
    .get(reportId) as
    | {
        memberId: string;
        memberSex: string | null;
        memberBirthDate: string | null;
        referenceDate: string;
      }
    | undefined;
  if (!report) return null;
  if (!report.memberSex && !report.memberBirthDate) return null;
  const dismissed = db
    .prepare(
      "SELECT 1 AS found FROM report_field_overrides WHERE report_id = ? AND field_key = ?",
    )
    .get(reportId, identityDismissedFieldKey);
  if (dismissed) return null;
  const patient = patientIdentityForReport(reportId);
  if (!patient.sex && !patient.birthDate && !patient.age) return null;
  const mismatchedFields: Array<"sex" | "birthDate"> = [];
  if (
    report.memberSex &&
    report.memberSex !== "unknown" &&
    patient.sex &&
    report.memberSex !== patient.sex
  )
    mismatchedFields.push("sex");
  if (
    report.memberBirthDate &&
    patient.birthDate &&
    report.memberBirthDate !== patient.birthDate
  )
    mismatchedFields.push("birthDate");
  /*
   * 报告只印年龄（儿童体检常见）时，按报告参考日期折算成员月龄做容差对比；
   * 有精确出生日期时优先精确对比，不走年龄推算。
   */
  if (
    !mismatchedFields.includes("birthDate") &&
    report.memberBirthDate &&
    !patient.birthDate &&
    patient.age
  ) {
    const memberAgeMonths = ageMonthsBetween(
      report.memberBirthDate,
      report.referenceDate,
    );
    if (
      memberAgeMonths !== null &&
      Math.abs(memberAgeMonths - patient.age.months) >
        patient.age.toleranceMonths
    )
      mismatchedFields.push("birthDate");
  }
  if (!mismatchedFields.length) return null;
  /*
   * 候选成员要求身份强一致：有精确出生日期时按日期等值匹配；
   * 只有年龄信号时按报告参考日期折算的月龄落在容差内匹配。
   */
  let candidates: Array<{
    id: string;
    displayName: string;
    relationship: string;
  }> = [];
  if (patient.birthDate) {
    candidates = db
      .prepare(
        `
      SELECT m.id, m.display_name AS displayName, m.relationship
      FROM health_members m
      JOIN member_permissions mp
        ON mp.member_id = m.id AND mp.user_id = ? AND mp.permission = 'manager'
      WHERE m.id <> ? AND m.deleted_at IS NULL AND m.birth_date = ?
      ORDER BY m.created_at
      LIMIT 3
    `,
      )
      .all(user.id, report.memberId, patient.birthDate) as typeof candidates;
  } else if (patient.age) {
    const manageable = db
      .prepare(
        `
      SELECT m.id, m.display_name AS displayName, m.relationship,
        m.birth_date AS birthDate
      FROM health_members m
      JOIN member_permissions mp
        ON mp.member_id = m.id AND mp.user_id = ? AND mp.permission = 'manager'
      WHERE m.id <> ? AND m.deleted_at IS NULL AND m.birth_date IS NOT NULL
      ORDER BY m.created_at
      LIMIT 20
    `,
      )
      .all(user.id, report.memberId) as Array<{
      id: string;
      displayName: string;
      relationship: string;
      birthDate: string;
    }>;
    candidates = manageable
      .filter((member) => {
        const memberAgeMonths = ageMonthsBetween(
          member.birthDate,
          report.referenceDate,
        );
        return (
          memberAgeMonths !== null &&
          Math.abs(memberAgeMonths - patient.age!.months) <=
            patient.age!.toleranceMonths
        );
      })
      .slice(0, 3)
      .map(({ id, displayName, relationship }) => ({
        id,
        displayName,
        relationship,
      }));
  }
  return {
    patientSex: patient.sex,
    patientBirthDate: patient.birthDate,
    patientAgeText: patient.age?.text || null,
    patientApproxBirthDate:
      !patient.birthDate && patient.age
        ? approxBirthDateFromAge(report.referenceDate, patient.age)
        : null,
    mismatchedFields,
    candidates,
  };
}

/*
 * 一键归属：把报告移到同账号下有管理权限的另一个成员。
 * 同时清理旧成员档案中来源是这份报告的血型（血型属于真实患者，不应留在错误成员上），
 * 报告相关通知一并迁移；指标、趋势、形态发现均按 report_id 关联，无需改动。
 */
export function assignReportMember(
  user: RequestUser,
  reportId: string,
  input:
    | { memberId: string }
    | {
        newMember: {
          displayName: string;
          relationship: string;
          sex?: string | null;
          birthDate?: string | null;
        };
      },
) {
  const db = getDatabase();
  const report = db
    .prepare(
      "SELECT id, member_id AS memberId FROM reports WHERE id = ? AND status <> 'trashed'",
    )
    .get(reportId) as { id: string; memberId: string } | undefined;
  if (!report) throw createError({ statusCode: 404, statusMessage: "报告不存在" });
  assertMemberManage(user, report.memberId);
  const targetMemberId =
    "memberId" in input
      ? input.memberId
      : createMember(user, input.newMember).id;
  if (targetMemberId === report.memberId)
    throw createError({ statusCode: 409, statusMessage: "报告已归属该成员" });
  assertMemberManage(user, targetMemberId);
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(
      "UPDATE reports SET member_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    ).run(targetMemberId, reportId);
    db.prepare(
      "UPDATE app_notifications SET member_id = ? WHERE report_id = ?",
    ).run(targetMemberId, reportId);
    db.prepare(
      `
      UPDATE health_members
      SET blood_type_abo = NULL, blood_type_rh = NULL, blood_type_source_report_id = NULL,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND blood_type_source_report_id = ?
    `,
    ).run(report.memberId, reportId);
    db.prepare(
      "DELETE FROM report_field_overrides WHERE report_id = ? AND field_key = ?",
    ).run(reportId, identityDismissedFieldKey);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { reportId, memberId: targetMemberId };
}

export function dismissReportMemberIdentity(user: RequestUser, reportId: string) {
  const db = getDatabase();
  const report = db
    .prepare(
      "SELECT id, member_id AS memberId FROM reports WHERE id = ? AND status <> 'trashed'",
    )
    .get(reportId) as { id: string; memberId: string } | undefined;
  if (!report) throw createError({ statusCode: 404, statusMessage: "报告不存在" });
  assertMemberManage(user, report.memberId);
  db.prepare(
    `
    INSERT INTO report_field_overrides (id, report_id, field_key, value_json, updated_by)
    VALUES (?, ?, ?, '{}', ?)
    ON CONFLICT(report_id, field_key) DO UPDATE SET updated_by = excluded.updated_by,
      updated_at = CURRENT_TIMESTAMP
  `,
  ).run(createId("override"), reportId, identityDismissedFieldKey, user.id);
  return { dismissed: true };
}
