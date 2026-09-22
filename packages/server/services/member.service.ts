import { getAppConfig } from "../utils/runtime-config";
import { createError } from "h3";
import { rollbackAfterError, getDatabase, runInTransaction } from "../database/client";
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
  createSelf?: unknown;
  birthDate?: unknown;
  sex?: unknown;
  bloodTypeAbo?: unknown;
  bloodTypeRh?: unknown;
};

type PermissionInput = {
  userId?: unknown;
  permission?: unknown;
  canManageSharing?: unknown;
  version?: unknown;
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
    relationship: input.createSelf === true ? "self" : cleanRelationship(input.relationship),
    birthDate: cleanBirthDate(input.birthDate),
    sex: cleanSex(input.sex),
    bloodTypeAbo: cleanBloodTypeAbo(input.bloodTypeAbo),
    bloodTypeRh: cleanBloodTypeRh(input.bloodTypeRh)
  };
  const db = getDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    if (input.createSelf === true) {
      const existing = db.prepare('SELECT self_member_id AS id FROM account_preferences WHERE user_id=?').get(user.id) as {id:string|null}|undefined;
      if (existing?.id) { const permission=assertMemberAccess(user,existing.id); db.exec('COMMIT'); return {...requireMember(existing.id),permission}; }
      const candidates = db.prepare("SELECT id FROM health_members WHERE created_by=? AND relationship='self' AND deleted_at IS NULL").all(user.id);
      if(candidates.length) throw createError({statusCode:409,statusMessage:'已有本人候选档案，请先确认关联，避免重复建档'});
    }
    db.prepare(`
      INSERT INTO health_members (id, display_name, relationship, birth_date, sex, blood_type_abo, blood_type_rh, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(member.id, member.displayName, member.relationship, member.birthDate, member.sex, member.bloodTypeAbo, member.bloodTypeRh, user.id);
    db.prepare(`
      INSERT INTO member_permissions (member_id, user_id, permission, granted_by,can_manage_sharing)
      VALUES (?, ?, 'manager', ?,1)
    `).run(member.id, user.id, user.id);
    if (input.createSelf === true) db.prepare(`INSERT INTO account_preferences(user_id,self_member_id,self_profile_choice) VALUES (?,?,'created') ON CONFLICT(user_id) DO UPDATE SET self_member_id=excluded.self_member_id,self_profile_choice='created'`).run(user.id,member.id);
    audit(user, "member.create", member.id, { relationship: member.relationship });
    db.exec("COMMIT");
  } catch (error) {
    rollbackAfterError(db);
    throw error;
  }
  return { ...member, avatarPath: null, permission: "manager" as const };
}

export function updateMember(user: RequestUser, memberId: string, input: MemberInput) {
  requireMemberManager(user, memberId);
  const current = requireMember(memberId);
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
  assertMemberShare(user, memberId);
  const member = requireMember(memberId);
  if (member.relationship === "self" || getDatabase().prepare("SELECT 1 FROM account_preferences WHERE self_member_id=?").get(memberId)) {
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

export function isUsableMemberAccount(userId: string) {
 const db=getDatabase();
 const mode=getAppConfig().authMode;
 const provider=mode==='fnos'?'fnos_gateway':mode==='local'?'local':mode==='development'?'development':null;
 return Boolean(db.prepare(`SELECT 1 FROM user_identities i WHERE i.user_id=? AND (? IS NULL OR i.provider=?)
 AND NOT EXISTS(SELECT 1 FROM identity_recovery_pending r WHERE r.user_id=i.user_id  )
 AND (i.provider<>'local' OR EXISTS(SELECT 1 FROM local_accounts a WHERE a.user_id=i.user_id AND a.disabled_at IS NULL))`).get(userId,provider,provider));
}

export function assertMemberShare(user:RequestUser,memberId:string) {
 assertMemberManage(user,memberId);
 if(!getDatabase().prepare('SELECT 1 FROM member_permissions WHERE member_id=? AND user_id=? AND can_manage_sharing=1').get(memberId,user.id))
 throw createError({statusCode:403,statusMessage:'仅获准管理共享权限的账号可操作',data:{code:'MEMBER_SHARE_REQUIRED'}});
}
export function assertRemainingMemberManager(memberId:string,excludeUserId?:string) {
 const rows=getDatabase().prepare("SELECT user_id AS id FROM member_permissions WHERE member_id=? AND permission='manager' AND can_manage_sharing=1").all(memberId) as Array<{id:string}>;
 if(!rows.some(row=>row.id!==excludeUserId && isUsableMemberAccount(row.id))) throw createError({statusCode:409,statusMessage:'请先指定另一名可管理共享权限的档案管理者',data:{code:'MEMBER_LAST_MANAGER'}});
}
export function assertAccountCanLoseAccess(userId:string) {
 const members=getDatabase().prepare(`SELECT p.member_id AS id FROM member_permissions p JOIN health_members m ON m.id=p.member_id WHERE p.user_id=? AND p.permission='manager' AND p.can_manage_sharing=1 AND m.deleted_at IS NULL`).all(userId) as Array<{id:string}>;
 for(const member of members) assertRemainingMemberManager(member.id,userId);
}
export function listMemberPermissions(user:RequestUser,memberId:string) {
 assertMemberShare(user,memberId);
 return getDatabase().prepare(`SELECT p.user_id AS userId,u.display_name AS displayName,p.permission,p.can_manage_sharing AS canManageSharing,
 COALESCE(v.version,0) AS version FROM member_permissions p JOIN users u ON u.id=p.user_id
 LEFT JOIN member_permission_versions v ON v.member_id=p.member_id WHERE p.member_id=?`).all(memberId);
}
export function listMemberSharingAccounts(user: RequestUser, memberId: string) {
  assertMemberShare(user, memberId);
  const accounts = getDatabase().prepare(`
    SELECT u.id, u.display_name AS displayName
    FROM users u ORDER BY u.display_name, u.id
  `).all() as Array<{ id: string; displayName: string }>;
  return accounts.filter(account => isUsableMemberAccount(account.id));
}
function writeMemberPermission(user:RequestUser,memberId:string,input:PermissionInput) {
 const userId=typeof input.userId==='string'?input.userId:'';
 if(input.permission!==null && (typeof input.permission!=='string'||!permissions.has(input.permission))) throw createError({statusCode:400,statusMessage:'权限必须为查看或管理'});
 if(input.canManageSharing!==undefined && typeof input.canManageSharing!=='boolean') throw createError({statusCode:400,statusMessage:'共享管理设置无效'});
 const db=getDatabase();
  assertMemberShare(user,memberId);
  if(!isUsableMemberAccount(userId)) throw createError({statusCode:404,statusMessage:'授权账号不存在或已停用'});
  const version=(db.prepare('SELECT version FROM member_permission_versions WHERE member_id=?').get(memberId) as {version:number}|undefined)?.version||0;
  if(input.version!==version) throw createError({statusCode:409,statusMessage:'授权已变化，请刷新后重试',data:{code:'MEMBER_PERMISSION_CONFLICT'}});
  const before=db.prepare('SELECT permission,can_manage_sharing FROM member_permissions WHERE member_id=? AND user_id=?').get(memberId,userId);
  const sharing=input.permission==='manager' && input.canManageSharing===true?1:0;
  if(input.permission===null) db.prepare('DELETE FROM member_permissions WHERE member_id=? AND user_id=?').run(memberId,userId);
  else db.prepare(`INSERT INTO member_permissions(member_id,user_id,permission,granted_by,can_manage_sharing) VALUES(?,?,?,?,?)
   ON CONFLICT(member_id,user_id) DO UPDATE SET permission=excluded.permission,can_manage_sharing=excluded.can_manage_sharing,granted_by=excluded.granted_by,granted_at=CURRENT_TIMESTAMP`).run(memberId,userId,input.permission as string,user.id,sharing);
  assertRemainingMemberManager(memberId);
  db.prepare('INSERT INTO member_permission_versions(member_id,version) VALUES(?,1) ON CONFLICT(member_id) DO UPDATE SET version=version+1').run(memberId);
  audit(user,'member.permission.update',memberId,{userId,before,after:{permission:input.permission,canManageSharing:sharing},source:'sharing'});

 }

export function setMemberPermission(user:RequestUser,memberId:string,input:PermissionInput) {
 runInTransaction(getDatabase(),()=>writeMemberPermission(user,memberId,input));
 // Self-revocation must succeed without reading the now-forbidden permission list.
 const retained=getDatabase().prepare("SELECT 1 FROM member_permissions WHERE member_id=? AND user_id=? AND permission='manager' AND can_manage_sharing=1").get(memberId,user.id);
 return retained ? listMemberPermissions(user,memberId) : [];
}

export function setMembersPermission(user: RequestUser, input: PermissionInput & { members?: unknown }) {
 if (!Array.isArray(input.members) || !input.members.length || input.members.length > 100 ||
     input.members.some(item => !item || typeof item.memberId !== 'string' || !Number.isSafeInteger(item.version) || item.version < 0) ||
     new Set(input.members.map(item => item.memberId)).size !== input.members.length) {
   throw createError({statusCode:400,statusMessage:'请选择有效且不重复的成员范围（最多 100 位）'});
 }
 const members = input.members as Array<{memberId:string;version:number}>;
 runInTransaction(getDatabase(),()=>{
   for (const member of members) writeMemberPermission(user,member.memberId,{...input,version:member.version});
 });
 return {updated:members.length};
}

export function assertMemberAccess(user: RequestUser, memberId: string) {
  requireAuthenticated(user);
  if (getDatabase().prepare(`SELECT 1 FROM identity_recovery_pending WHERE user_id=?
    UNION ALL SELECT 1 FROM local_accounts WHERE user_id=? AND disabled_at IS NOT NULL`).get(user.id,user.id)) throw createError({statusCode:403,statusMessage:"当前账号身份不可用"});
  const row = getDatabase().prepare(`
    SELECT mp.permission FROM member_permissions mp
    JOIN health_members hm ON hm.id = mp.member_id
    WHERE mp.member_id = ? AND mp.user_id = ? AND hm.deleted_at IS NULL
  `).get(memberId, user.id) as { permission: "viewer" | "manager" } | undefined;
  if (!row) throw createError({ statusCode: 403, statusMessage: "无权访问该成员档案", data:{code:"MEMBER_ACCESS_DENIED"} });
  return row.permission;
}

export function assertMemberManage(user: RequestUser, memberId: string) {
  const permission = assertMemberAccess(user, memberId);
  if (permission !== "manager") {
    throw createError({ statusCode: 403, statusMessage: "仅有管理权限的账号可添加报告", data:{code:"MEMBER_MANAGE_REQUIRED"} });
  }
}

/** SQL predicates for aggregate endpoints; expression is a code-owned column, never request input. */
export function memberAccessSql(user:RequestUser,expression:string,manage=false) {
 if(!user.authenticated) return '0';
 const id="'"+user.id.replaceAll("'","''")+"'";
 return `EXISTS(SELECT 1 FROM member_permissions access JOIN health_members access_member ON access_member.id=access.member_id WHERE access.member_id=${expression} AND access.user_id=${id} AND access_member.deleted_at IS NULL ${manage?"AND access.permission='manager'":''})`;
}
