import { createError } from "h3";
import { rollbackAfterError, getDatabase } from "../database/client";
import { isAdministrator, type RequestUser } from "../domain/request-user";
import { createId } from "../utils/identifier";

const relationships = new Set(["spouse", "child", "parent", "sibling", "other"]);
const sexes = new Set(["male", "female", "unknown"]);
const permissions = new Set(["viewer", "manager"]);
const bloodTypeAbos = new Set(["A", "B", "AB", "O"]);
const bloodTypeRhs = new Set(["positive", "negative"]);

type MemberInput = {
  displayName?: unknown;
  relationship?: unknown;
  birthDate?: unknown;
  sex?: unknown;
  bloodTypeAbo?: unknown;
  bloodTypeRh?: unknown;
};

type PermissionInput = {
  userId?: unknown;
  permission?: unknown;
};

function requireAuthenticated(user: RequestUser) {
  if (!user.authenticated) throw createError({ statusCode: 401, statusMessage: "请先登录" });
}

function requireAdmin(user: RequestUser) {
  requireAuthenticated(user);
  if (!isAdministrator(user)) {
    throw createError({ statusCode: 403, statusMessage: "仅管理员可管理成员授权" });
  }
}

function requireMemberManager(user: RequestUser, memberId: string) {
  requireAuthenticated(user);
  if (isAdministrator(user)) return;
  const permission = assertMemberAccess(user, memberId);
  if (permission !== "manager") {
    throw createError({ statusCode: 403, statusMessage: "仅有管理权限的账号可修改家庭成员" });
  }
}

function cleanName(value: unknown) {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name) throw createError({ statusCode: 400, statusMessage: "成员姓名不能为空" });
  if (name.length > 40) throw createError({ statusCode: 400, statusMessage: "成员姓名不能超过 40 个字符" });
  return name;
}

function cleanRelationship(value: unknown) {
  const relationship = typeof value === "string" ? value : "";
  if (!relationships.has(relationship)) {
    throw createError({ statusCode: 400, statusMessage: "请选择有效的家庭关系" });
  }
  return relationship;
}

function cleanBirthDate(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw createError({ statusCode: 400, statusMessage: "出生日期格式应为 YYYY-MM-DD" });
  }
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw createError({ statusCode: 400, statusMessage: "出生日期无效" });
  }
  if (value > new Date().toISOString().slice(0, 10)) {
    throw createError({ statusCode: 400, statusMessage: "出生日期不能晚于今天" });
  }
  return value;
}

function cleanSex(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || !sexes.has(value)) {
    throw createError({ statusCode: 400, statusMessage: "请选择有效的性别" });
  }
  return value;
}

function cleanBloodTypeAbo(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || !bloodTypeAbos.has(value)) {
    throw createError({ statusCode: 400, statusMessage: "请选择有效的 ABO 血型" });
  }
  return value;
}

function cleanBloodTypeRh(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || !bloodTypeRhs.has(value)) {
    throw createError({ statusCode: 400, statusMessage: "请选择有效的 Rh 血型" });
  }
  return value;
}

function memberRow(memberId: string) {
  return getDatabase().prepare(`
    SELECT id, display_name AS displayName, relationship, birth_date AS birthDate,
      sex, blood_type_abo AS bloodTypeAbo, blood_type_rh AS bloodTypeRh,
      blood_type_source_report_id AS bloodTypeSourceReportId,
      avatar_path AS avatarPath, created_by AS createdBy
    FROM health_members WHERE id = ? AND deleted_at IS NULL
  `).get(memberId) as {
    id: string;
    displayName: string;
    relationship: string;
    birthDate: string | null;
    sex: string | null;
    bloodTypeAbo: string | null;
    bloodTypeRh: string | null;
    bloodTypeSourceReportId: string | null;
    avatarPath: string | null;
    createdBy: string;
  } | undefined;
}

function requireMember(memberId: string) {
  const member = memberRow(memberId);
  if (!member) throw createError({ statusCode: 404, statusMessage: "家庭成员不存在" });
  return member;
}

const bloodTypeAboItemPattern = /^(?:ABO\s*)?血型(?:鉴定)?(?:[（(].*[）)])?$/i;
const bloodTypeAboResultPattern = /^\s*"?(AB|A|B|O)"?\s*型?\s*$/i;
const bloodTypeRhItemPattern = /Rh\s*(?:[（(]\s*D\s*[）)])?\s*血型/i;

/**
 * 血型是不可变的成员固有属性，不作为趋势指标。AI 提取出血型 observation 后，
 * 仅回填成员档案中仍为空的字段（人工设置与先前回填都不覆盖），并记录来源报告。
 */
export function backfillMemberBloodTypeFromReport(
  reportId: string,
  observations: Array<{ itemName: string | null; resultText: string | null }>,
) {
  let abo: string | null = null;
  let rh: string | null = null;
  for (const observation of observations) {
    const itemName = (observation.itemName || "").trim();
    const resultText = (observation.resultText || "").trim();
    if (!itemName || !resultText) continue;
    if (!abo && bloodTypeAboItemPattern.test(itemName)) {
      const match = resultText.match(bloodTypeAboResultPattern);
      if (match) abo = match[1].toUpperCase();
    }
    if (!rh && bloodTypeRhItemPattern.test(itemName)) {
      if (/阳性|positive|\+/i.test(resultText)) rh = "positive";
      else if (/阴性|negative|-/i.test(resultText)) rh = "negative";
    }
  }
  if (!abo && !rh) return null;
  const db = getDatabase();
  const report = db.prepare("SELECT member_id AS memberId FROM reports WHERE id = ?").get(reportId) as
    | { memberId: string }
    | undefined;
  if (!report) return null;
  const member = db.prepare(`
    SELECT blood_type_abo AS abo, blood_type_rh AS rh
    FROM health_members WHERE id = ? AND deleted_at IS NULL
  `).get(report.memberId) as { abo: string | null; rh: string | null } | undefined;
  if (!member) return null;
  const fillAbo = abo && !member.abo ? abo : null;
  const fillRh = rh && !member.rh ? rh : null;
  if (!fillAbo && !fillRh) return null;
  db.prepare(`
    UPDATE health_members SET
      blood_type_abo = COALESCE(blood_type_abo, ?),
      blood_type_rh = COALESCE(blood_type_rh, ?),
      blood_type_source_report_id = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(fillAbo, fillRh, reportId, report.memberId);
  return { memberId: report.memberId, bloodTypeAbo: fillAbo, bloodTypeRh: fillRh };
}

function audit(user: RequestUser, action: string, targetId: string, detail: Record<string, unknown> = {}) {
  getDatabase().prepare(`
    INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, detail_json)
    VALUES (?, ?, ?, 'health_member', ?, ?)
  `).run(createId("audit"), user.id, action, targetId, JSON.stringify(detail));
}

export function createMember(user: RequestUser, input: MemberInput) {
  requireAuthenticated(user);
  const member = {
    id: createId("member"),
    displayName: cleanName(input.displayName),
    relationship: cleanRelationship(input.relationship),
    birthDate: cleanBirthDate(input.birthDate),
    sex: cleanSex(input.sex),
    bloodTypeAbo: cleanBloodTypeAbo(input.bloodTypeAbo),
    bloodTypeRh: cleanBloodTypeRh(input.bloodTypeRh)
  };
  const db = getDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`
      INSERT INTO health_members (id, display_name, relationship, birth_date, sex, blood_type_abo, blood_type_rh, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(member.id, member.displayName, member.relationship, member.birthDate, member.sex, member.bloodTypeAbo, member.bloodTypeRh, user.id);
    db.prepare(`
      INSERT INTO member_permissions (member_id, user_id, permission, granted_by)
      VALUES (?, ?, 'manager', ?)
    `).run(member.id, user.id, user.id);
    audit(user, "member.create", member.id, { relationship: member.relationship });
    db.exec("COMMIT");
  } catch (error) {
    rollbackAfterError(db);
    throw error;
  }
  return { ...member, avatarPath: null, permission: "manager" as const };
}

export function updateMember(user: RequestUser, memberId: string, input: MemberInput) {
  const current = requireMember(memberId);
  requireMemberManager(user, memberId);
  const nextRelationship = input.relationship === undefined
    ? current.relationship
    : current.relationship === "self"
      ? "self"
      : cleanRelationship(input.relationship);
  const next = {
    displayName: input.displayName === undefined ? current.displayName : cleanName(input.displayName),
    relationship: nextRelationship,
    birthDate: input.birthDate === undefined ? current.birthDate : cleanBirthDate(input.birthDate),
    sex: input.sex === undefined ? current.sex : cleanSex(input.sex),
    bloodTypeAbo: input.bloodTypeAbo === undefined ? current.bloodTypeAbo : cleanBloodTypeAbo(input.bloodTypeAbo),
    bloodTypeRh: input.bloodTypeRh === undefined ? current.bloodTypeRh : cleanBloodTypeRh(input.bloodTypeRh)
  };
  /* 人工维护血型后清除报告来源标记：人工值优先，之后不再被自动回填覆盖 */
  const bloodTypeTouched = input.bloodTypeAbo !== undefined || input.bloodTypeRh !== undefined;
  getDatabase().prepare(`
    UPDATE health_members SET display_name = ?, relationship = ?, birth_date = ?, sex = ?,
      blood_type_abo = ?, blood_type_rh = ?,
      blood_type_source_report_id = CASE WHEN ? THEN NULL ELSE blood_type_source_report_id END,
      updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `).run(next.displayName, next.relationship, next.birthDate, next.sex, next.bloodTypeAbo, next.bloodTypeRh, bloodTypeTouched ? 1 : 0, memberId);
  audit(user, "member.update", memberId);
  const permission = getDatabase().prepare(`
    SELECT permission FROM member_permissions WHERE member_id = ? AND user_id = ?
  `).get(memberId, user.id) as { permission: "viewer" | "manager" } | undefined;
  return {
    ...current,
    ...next,
    bloodTypeSourceReportId: bloodTypeTouched ? null : current.bloodTypeSourceReportId,
    permission: permission?.permission || "manager"
  };
}

export function deleteMember(user: RequestUser, memberId: string) {
  const member = requireMember(memberId);
  requireMemberManager(user, memberId);
  if (member.relationship === "self") {
    throw createError({ statusCode: 409, statusMessage: "本人档案不能删除" });
  }
  getDatabase().prepare(`
    UPDATE health_members SET deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `).run(memberId);
  audit(user, "member.delete", memberId);
  return { id: memberId, deleted: true };
}

export function listAccessUsers(user: RequestUser) {
  requireAdmin(user);
  return getDatabase().prepare(`
    SELECT u.id, u.display_name AS displayName, u.is_gateway_admin AS isAdmin,
      GROUP_CONCAT(DISTINCT ui.provider) AS providers
    FROM users u
    JOIN user_identities ui ON ui.user_id = u.id AND ui.provider IN ('fnos_gateway', 'local', 'development')
    GROUP BY u.id
    ORDER BY u.is_gateway_admin DESC, u.display_name
  `).all();
}

export function listMemberPermissions(user: RequestUser, memberId: string) {
  requireAdmin(user);
  requireMember(memberId);
  return getDatabase().prepare(`
    SELECT u.id AS userId, u.display_name AS displayName, mp.permission,
      GROUP_CONCAT(DISTINCT ui.provider) AS providers
    FROM member_permissions mp
    JOIN users u ON u.id = mp.user_id
    LEFT JOIN user_identities ui ON ui.user_id = u.id
    WHERE mp.member_id = ?
    GROUP BY u.id, mp.permission
    ORDER BY u.display_name
  `).all(memberId);
}

export function setMemberPermission(user: RequestUser, memberId: string, input: PermissionInput) {
  requireAdmin(user);
  const member = requireMember(memberId);
  const userId = typeof input.userId === "string" ? input.userId.trim() : "";
    const target = getDatabase().prepare(`
      SELECT u.id FROM users u
      JOIN user_identities ui ON ui.user_id = u.id AND ui.provider IN ('fnos_gateway', 'local', 'development')
      WHERE u.id = ?
    `).get(userId);
  if (!target) throw createError({ statusCode: 404, statusMessage: "授权账号不存在" });
  if (member.relationship === "self" && member.createdBy === userId && input.permission === null) {
    throw createError({ statusCode: 409, statusMessage: "不能移除本人档案所有者的权限" });
  }
  if (input.permission !== null && (typeof input.permission !== "string" || !permissions.has(input.permission))) {
    throw createError({ statusCode: 400, statusMessage: "权限必须为查看或管理" });
  }
  const db = getDatabase();
  if (input.permission === null) {
    db.prepare("DELETE FROM member_permissions WHERE member_id = ? AND user_id = ?").run(memberId, userId);
    audit(user, "member.permission.remove", memberId, { userId });
  } else {
    db.prepare(`
      INSERT INTO member_permissions (member_id, user_id, permission, granted_by)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(member_id, user_id) DO UPDATE SET
        permission = excluded.permission, granted_by = excluded.granted_by, granted_at = CURRENT_TIMESTAMP
    `).run(memberId, userId, input.permission, user.id);
    audit(user, "member.permission.update", memberId, { userId, permission: input.permission });
  }
  return listMemberPermissions(user, memberId);
}

export function assertMemberAccess(user: RequestUser, memberId: string) {
  requireAuthenticated(user);
  const row = getDatabase().prepare(`
    SELECT mp.permission FROM member_permissions mp
    JOIN health_members hm ON hm.id = mp.member_id
    WHERE mp.member_id = ? AND mp.user_id = ? AND hm.deleted_at IS NULL
  `).get(memberId, user.id) as { permission: "viewer" | "manager" } | undefined;
  if (!row) throw createError({ statusCode: 403, statusMessage: "无权访问该成员档案" });
  return row.permission;
}

export function assertMemberManage(user: RequestUser, memberId: string) {
  const permission = assertMemberAccess(user, memberId);
  if (permission !== "manager") {
    throw createError({ statusCode: 403, statusMessage: "仅有管理权限的账号可添加报告" });
  }
}
