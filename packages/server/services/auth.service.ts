import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { createError, getRequestIP, setCookie, deleteCookie, type H3Event } from "h3";
import { rollbackAfterError, getDatabase } from "../database/client";
import { isAdministrator, type RequestUser } from "../domain/request-user";
import { getAppConfig } from "../utils/runtime-config";
import { classifySystemError } from "../utils/api-error";
import { createId } from "../utils/identifier";

function requiredText(value: unknown, label: string) {
  if (typeof value !== "string" || !value.trim()) {
    throw createError({ statusCode: 400, statusMessage: `${label}不能为空` });
  }
  return value.trim();
}

function sessionToken(event: H3Event) {
  const encoded = event.node!.req!.headers.cookie?.match(/(?:^|;\s*)health_session=([^;]+)/)?.[1];
  if (!encoded) return "";
  try {
    return decodeURIComponent(encoded);
  } catch {
    return "";
  }
}

function tokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function cleanBootstrapUsername(value: string) {
  const username = value.trim();
  if (!/^[a-zA-Z0-9._-]{3,64}$/.test(username)) {
    throw new Error("LOCAL_ADMIN_USERNAME must be 3-64 characters using letters, numbers, dot, underscore or hyphen");
  }
  return username;
}

function cleanPassword(value: string) {
  const password = value.trim();
  if (password.length < 8 || password.length > 128) {
    throw new Error("Local password must contain 8-128 characters");
  }
  return password;
}

const defaultLocalAdminUsername = "admin";
const defaultLocalAdminPassword = "admin";

export function localAuthSetupRequired() {
  if (getAppConfig().authMode !== "local") return false;
  const row = getDatabase().prepare(`
    SELECT COUNT(*) AS count FROM local_accounts WHERE disabled_at IS NULL
  `).get() as { count: number };
  return Number(row.count) === 0;
}

export function bootstrapLocalAdministrator() {
  if (getAppConfig().authMode !== "local" || !localAuthSetupRequired()) {
    return { created: false, setupRequired: false };
  }
  const username = cleanBootstrapUsername(process.env.LOCAL_ADMIN_USERNAME || defaultLocalAdminUsername);
  const displayName = String(process.env.LOCAL_ADMIN_DISPLAY_NAME || username).trim().slice(0, 40) || username;
  /* 环境变量仍兼容旧部署；新部署无需 Secret，空数据库固定使用 admin/admin。 */
  const configuredPassword = String(process.env.LOCAL_ADMIN_PASSWORD || "").trim();
  const password = configuredPassword ? cleanPassword(configuredPassword) : defaultLocalAdminPassword;
  const passwordValue = hashPassword(password);
  const userId = createId("user");
  const db = getDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    const account = db.prepare(`SELECT 1 FROM local_accounts WHERE disabled_at IS NULL LIMIT 1`).get();
    if (account) {
      db.exec("COMMIT");
      return { created: false, setupRequired: false };
    }
    db.prepare(`
      INSERT INTO users (id, display_name, is_gateway_admin) VALUES (?, ?, 1)
    `).run(userId, displayName);
    db.prepare(`
      INSERT INTO user_identities (id, user_id, provider, subject) VALUES (?, ?, 'local', ?)
    `).run(createId("identity"), userId, username);
    db.prepare(`
      INSERT INTO local_accounts (id, user_id, username, password_hash, password_salt, must_change_password)
      VALUES (?, ?, ?, ?, ?, 1)
    `).run(createId("account"), userId, username, passwordValue.hash, passwordValue.salt);
    const memberId = createId("member");
    db.prepare(`
      INSERT INTO health_members (id, display_name, relationship, created_by)
      VALUES (?, ?, 'self', ?)
    `).run(memberId, displayName, userId);
    db.prepare(`
      INSERT INTO member_permissions (member_id, user_id, permission, granted_by)
      VALUES (?, ?, 'manager', ?)
    `).run(memberId, userId, userId);
    db.prepare(`
      INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, detail_json)
      VALUES (?, ?, 'auth.local_admin_bootstrap', 'user', ?, ?)
    `).run(createId("audit"), userId, userId, JSON.stringify({ username }));
    db.exec("COMMIT");
    return { created: true, setupRequired: false, username };
  } catch (cause) {
    rollbackAfterError(db);
    throw cause;
  }
}

export function getLocalSessionUser(event: H3Event): RequestUser | null {
  if (getAppConfig().authMode !== "local") return null;
  const token = sessionToken(event);
  if (!token) return null;
  const hash = tokenHash(token);
  const db = getDatabase();
  const row = db.prepare(`
    SELECT u.id, u.display_name AS displayName, u.is_gateway_admin AS isAdmin,
      la.must_change_password AS mustChangePassword,
      s.last_seen_at < datetime('now', '-5 minutes') AS needsTouch
    FROM auth_sessions s
    JOIN users u ON u.id = s.user_id
    JOIN local_accounts la ON la.user_id = u.id AND la.disabled_at IS NULL
    WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > CURRENT_TIMESTAMP
  `).get(hash) as { id: string; displayName: string; isAdmin: number; mustChangePassword: number; needsTouch: number } | undefined;
  if (!row) return null;
  if (row.needsTouch) {
    try {
      db.prepare(`UPDATE auth_sessions SET last_seen_at = CURRENT_TIMESTAMP
        WHERE token_hash = ? AND last_seen_at < datetime('now', '-5 minutes')`).run(hash);
    } catch (cause) {
      // Last-seen is informational; session validity and permissions were read above.
      const code = classifySystemError(cause)?.code;
      if (code !== "DATABASE_UNAVAILABLE" && code !== "STORAGE_UNAVAILABLE") throw cause;
    }
  }
  return {
    id: row.id,
    displayName: row.displayName,
    provider: "local",
    authenticated: true,
    isAdmin: Boolean(row.isAdmin),
    mustChangePassword: Boolean(row.mustChangePassword),
    isGatewayAdmin: Boolean(row.isAdmin)
  };
}

export function hashPassword(password: string, salt = randomBytes(16).toString("hex")) {
  return { salt, hash: scryptSync(password, salt, 64).toString("hex") };
}

/* 浏览器会拒收 HTTP 明文连接下发的 Secure cookie，按请求实际协议（含网关上送的 X-Forwarded-Proto）决定 */
function isHttpsRequest(event: H3Event) {
  const request = event.node!.req!;
  const forwarded = request.headers["x-forwarded-proto"];
  if (getAppConfig().trustProxy && typeof forwarded === "string" && forwarded.trim()) {
    const proto = forwarded.split(",", 1)[0];
    return typeof proto === "string" && proto.trim().toLowerCase() === "https";
  }
  return Boolean((request.socket as { encrypted?: boolean }).encrypted);
}

function verifyPassword(password: string, salt: string, expectedHex: string) {
  const expected = Buffer.from(expectedHex, "hex");
  const actual = scryptSync(password, salt, expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function login(event: H3Event, body: Record<string, unknown>) {
  if (getAppConfig().authMode !== "local") {
    throw createError({ statusCode: 410, statusMessage: "当前部署使用 fnOS 账号体系，不提供独立登录" });
  }
  if (localAuthSetupRequired()) throw createError({ statusCode: 503, data: { code: "AUTH_REQUIRED" }, statusMessage: "本地管理员尚未初始化，请重启应用" });
  const username = requiredText(body.username, "用户名");
  const password = requiredText(body.password, "密码");
  const ip = getRequestIP(event, { xForwardedFor: getAppConfig().trustProxy }) || "unknown";
  const db = getDatabase();
  const recentFailures = db.prepare(`
    SELECT COUNT(*) AS count FROM login_attempts
    WHERE username = ? AND ip_address = ? AND succeeded = 0
      AND attempted_at >= datetime('now', '-15 minutes')
  `).get(username, ip) as { count: number };
  if (Number(recentFailures.count) >= 5) {
    throw createError({ statusCode: 429, statusMessage: "登录失败次数过多，请稍后再试" });
  }

  const account = db.prepare(`
    SELECT la.user_id AS userId, la.password_hash AS passwordHash, la.password_salt AS passwordSalt,
      la.must_change_password AS mustChangePassword
    FROM local_accounts la WHERE la.username = ? AND la.disabled_at IS NULL
  `).get(username) as { userId: string; passwordHash: string; passwordSalt: string; mustChangePassword: number } | undefined;
  const succeeded = Boolean(account && verifyPassword(password, account.passwordSalt, account.passwordHash));
  db.prepare("INSERT INTO login_attempts (username, ip_address, succeeded) VALUES (?, ?, ?)")
    .run(username, ip, succeeded ? 1 : 0);
  if (!succeeded || !account) {
    throw createError({ statusCode: 401, statusMessage: "用户名或密码错误" });
  }

  const token = randomBytes(32).toString("base64url");
  const hash = tokenHash(token);
  db.prepare(`
    INSERT INTO auth_sessions (id, user_id, token_hash, expires_at)
    VALUES (?, ?, ?, datetime('now', '+12 hours'))
  `).run(createId("session"), account.userId, hash);
  db.prepare("DELETE FROM login_attempts WHERE attempted_at < datetime('now', '-1 day')").run();
  db.prepare("DELETE FROM auth_sessions WHERE expires_at <= CURRENT_TIMESTAMP OR revoked_at IS NOT NULL").run();
  setCookie(event, "health_session", token, {
    httpOnly: true,
    secure: process.env.NODE_ENV !== "development" && isHttpsRequest(event),
    sameSite: "lax",
    path: "/",
    maxAge: 12 * 60 * 60
  });
  return { authenticated: true, mustChangePassword: Boolean(account.mustChangePassword) };
}

export function logout(event: H3Event) {
  const token = sessionToken(event);
  if (token) {
    getDatabase().prepare("UPDATE auth_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE token_hash = ?").run(tokenHash(token));
  }
  deleteCookie(event, "health_session", { path: "/" });
  return { authenticated: false };
}

export function changeLocalPassword(event: H3Event, user: RequestUser, body: Record<string, unknown>) {
  if (getAppConfig().authMode !== "local") {
    throw createError({ statusCode: 410, statusMessage: "当前部署使用 fnOS 账号体系，密码由 fnOS 统一管理" });
  }
  if (!user.authenticated) throw createError({ statusCode: 401, statusMessage: "请先登录" });
  if (user.provider !== "local") throw createError({ statusCode: 403, statusMessage: "仅本地账号可修改密码" });

  const currentPassword = typeof body.currentPassword === "string" ? body.currentPassword.trim() : "";
  let newPassword = "";
  try {
    newPassword = cleanPassword(requiredText(body.newPassword, "新密码"));
  } catch {
    throw createError({
      statusCode: 400,
      statusMessage: "新密码长度必须为 8-128 个字符"
    });
  }
  const confirmation = requiredText(body.confirmPassword, "确认密码");
  if (newPassword !== confirmation) {
    throw createError({ statusCode: 400, statusMessage: "两次输入的新密码不一致" });
  }
  if (newPassword === currentPassword) {
    throw createError({ statusCode: 400, statusMessage: "新密码不能与当前密码相同" });
  }

  const db = getDatabase();
  const account = db.prepare(`
    SELECT id, username, password_hash AS passwordHash, password_salt AS passwordSalt,
      must_change_password AS mustChangePassword
    FROM local_accounts WHERE user_id = ? AND disabled_at IS NULL
  `).get(user.id) as {
    id: string;
    username: string;
    passwordHash: string;
    passwordSalt: string;
    mustChangePassword: number;
  } | undefined;
  const forcedChange = Boolean(user.mustChangePassword) && Boolean(account?.mustChangePassword);
  if (!account || (!forcedChange && (!currentPassword || !verifyPassword(currentPassword, account.passwordSalt, account.passwordHash)))) {
    throw createError({ statusCode: 400, statusMessage: "当前密码不正确" });
  }

  const next = hashPassword(newPassword);
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`
      UPDATE local_accounts
      SET password_hash = ?, password_salt = ?, must_change_password = 0, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(next.hash, next.salt, account.id);
    db.prepare(`
      UPDATE auth_sessions SET revoked_at = CURRENT_TIMESTAMP
      WHERE user_id = ? AND revoked_at IS NULL
    `).run(user.id);
    db.prepare("DELETE FROM login_attempts WHERE username = ?").run(account.username);
    db.prepare(`
      INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, detail_json)
      VALUES (?, ?, ?, 'user', ?, ?)
    `).run(createId("audit"), user.id, forcedChange ? "auth.local_password_first_changed" : "auth.local_password_changed", user.id, JSON.stringify({ username: account.username, sessionsRevoked: true }));
    db.exec("COMMIT");
  } catch (cause) {
    rollbackAfterError(db);
    throw cause;
  }
  deleteCookie(event, "health_session", { path: "/" });
  return { changed: true, reauthenticationRequired: true };
}

function requireLocalAdministrator(user: RequestUser) {
  if (getAppConfig().authMode !== "local") {
    throw createError({ statusCode: 410, statusMessage: "当前部署使用 fnOS 账号体系，账号密码由 fnOS 统一管理" });
  }
  if (!user.authenticated) throw createError({ statusCode: 401, statusMessage: "请先登录" });
  if (user.provider !== "local" || !isAdministrator(user)) {
    throw createError({ statusCode: 403, statusMessage: "仅本地管理员可管理账号" });
  }
}

export function listLocalAccounts(user: RequestUser) {
  requireLocalAdministrator(user);
  return getDatabase().prepare(`
    SELECT la.id, la.user_id AS userId, la.username, u.display_name AS displayName,
      u.is_gateway_admin AS isAdmin, la.must_change_password AS mustChangePassword,
      la.disabled_at AS disabledAt
    FROM local_accounts la
    JOIN users u ON u.id = la.user_id
    ORDER BY u.is_gateway_admin DESC, u.display_name, la.username
  `).all();
}

export function createLocalAccount(actor: RequestUser, body: Record<string, unknown>) {
  requireLocalAdministrator(actor);
  let username = "";
  try {
    username = cleanBootstrapUsername(requiredText(body.username, "用户名"));
  } catch (cause) {
    if (cause && typeof cause === "object" && "statusCode" in cause) throw cause;
    throw createError({ statusCode: 400, statusMessage: "用户名需为 3-64 位字母、数字、点、下划线或短横线" });
  }
  const displayName = requiredText(body.displayName, "显示名称").slice(0, 40);
  const db = getDatabase();
  if (db.prepare("SELECT 1 FROM local_accounts WHERE username = ?").get(username)) {
    throw createError({ statusCode: 409, statusMessage: "用户名已存在" });
  }
  const userId = createId("user");
  const passwordValue = hashPassword(defaultLocalAdminPassword);
  const memberId = createId("member");
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("INSERT INTO users (id, display_name, is_gateway_admin) VALUES (?, ?, 0)").run(userId, displayName);
    db.prepare("INSERT INTO user_identities (id, user_id, provider, subject) VALUES (?, ?, 'local', ?)").run(createId("identity"), userId, username);
    db.prepare(`
      INSERT INTO local_accounts (id, user_id, username, password_hash, password_salt, must_change_password)
      VALUES (?, ?, ?, ?, ?, 1)
    `).run(createId("account"), userId, username, passwordValue.hash, passwordValue.salt);
    db.prepare("INSERT INTO health_members (id, display_name, relationship, created_by) VALUES (?, ?, 'self', ?)").run(memberId, displayName, userId);
    db.prepare("INSERT INTO member_permissions (member_id, user_id, permission, granted_by) VALUES (?, ?, 'manager', ?)").run(memberId, userId, userId);
    db.prepare(`
      INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, detail_json)
      VALUES (?, ?, 'auth.local_account_created', 'user', ?, ?)
    `).run(createId("audit"), actor.id, userId, JSON.stringify({ username, displayName, temporaryPassword: true }));
    db.exec("COMMIT");
  } catch (cause) {
    rollbackAfterError(db);
    throw cause;
  }
  return { created: true, userId, username, displayName, temporaryPassword: defaultLocalAdminPassword, mustChangePassword: true };
}

export function resetLocalAccountPassword(actor: RequestUser, body: Record<string, unknown>) {
  requireLocalAdministrator(actor);
  const userId = typeof body.userId === "string" ? body.userId.trim() : "";
  const username = typeof body.username === "string" ? body.username.trim() : "";
  if (!userId && !username) throw createError({ statusCode: 400, statusMessage: "请选择要重置的账号" });
  const requestedPassword = typeof body.newPassword === "string" ? body.newPassword.trim() : "";
  let password = defaultLocalAdminPassword;
  if (requestedPassword) {
    try {
      password = cleanPassword(requestedPassword);
    } catch {
      throw createError({ statusCode: 400, statusMessage: "密码长度必须为 8-128 个字符" });
    }
    const confirmation = requiredText(body.confirmPassword, "确认密码");
    if (password !== confirmation) throw createError({ statusCode: 400, statusMessage: "两次输入的密码不一致" });
  }
  const db = getDatabase();
  const account = db.prepare(`
    SELECT la.id, la.user_id AS userId, la.username, u.display_name AS displayName
    FROM local_accounts la JOIN users u ON u.id = la.user_id
    WHERE ${userId ? "la.user_id = ?" : "la.username = ?"} AND la.disabled_at IS NULL
  `).get(userId || username) as { id: string; userId: string; username: string; displayName: string } | undefined;
  if (!account) throw createError({ statusCode: 404, statusMessage: "本地账号不存在或已停用" });
  const next = hashPassword(password);
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`
      UPDATE local_accounts SET password_hash = ?, password_salt = ?, must_change_password = 1,
        updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `).run(next.hash, next.salt, account.id);
    db.prepare("UPDATE auth_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE user_id = ? AND revoked_at IS NULL").run(account.userId);
    db.prepare("DELETE FROM login_attempts WHERE username = ?").run(account.username);
    db.prepare(`
      INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, detail_json)
      VALUES (?, ?, 'auth.local_account_password_reset', 'user', ?, ?)
    `).run(createId("audit"), actor.id, account.userId, JSON.stringify({ username: account.username, sessionsRevoked: true, mustChangePassword: true }));
    db.exec("COMMIT");
  } catch (cause) {
    rollbackAfterError(db);
    throw cause;
  }
  return {
    reset: true,
    username: account.username,
    displayName: account.displayName,
    ...(requestedPassword ? {} : { temporaryPassword: defaultLocalAdminPassword }),
    mustChangePassword: true
  };
}

function findLocalAccountByUserId(userId: string) {
  return getDatabase().prepare(`
    SELECT la.id, la.user_id AS userId, la.username, u.display_name AS displayName,
      u.is_gateway_admin AS isAdmin, la.disabled_at AS disabledAt
    FROM local_accounts la JOIN users u ON u.id = la.user_id
    WHERE la.user_id = ?
  `).get(userId) as {
    id: string;
    userId: string;
    username: string;
    displayName: string;
    isAdmin: number;
    disabledAt: string | null;
  } | undefined;
}

export function renameLocalAccount(actor: RequestUser, body: Record<string, unknown>) {
  requireLocalAdministrator(actor);
  const userId = requiredText(body.userId, "账号");
  let username = "";
  try {
    username = cleanBootstrapUsername(requiredText(body.username, "用户名"));
  } catch (cause) {
    if (cause && typeof cause === "object" && "statusCode" in cause) throw cause;
    throw createError({ statusCode: 400, statusMessage: "用户名需为 3-64 位字母、数字、点、下划线或短横线" });
  }
  const db = getDatabase();
  const account = findLocalAccountByUserId(userId);
  if (!account) throw createError({ statusCode: 404, statusMessage: "本地账号不存在" });
  if (account.username === username) {
    throw createError({ statusCode: 400, statusMessage: "新用户名与当前用户名相同" });
  }
  if (db.prepare("SELECT 1 FROM local_accounts WHERE username = ? AND user_id <> ?").get(username, userId)) {
    throw createError({ statusCode: 409, statusMessage: "用户名已存在" });
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("UPDATE local_accounts SET username = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(username, account.id);
    db.prepare("UPDATE user_identities SET subject = ? WHERE user_id = ? AND provider = 'local'").run(username, userId);
    db.prepare("DELETE FROM login_attempts WHERE username = ?").run(account.username);
    db.prepare(`
      INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, detail_json)
      VALUES (?, ?, 'auth.local_account_renamed', 'user', ?, ?)
    `).run(createId("audit"), actor.id, userId, JSON.stringify({ previousUsername: account.username, username }));
    db.exec("COMMIT");
  } catch (cause) {
    rollbackAfterError(db);
    throw cause;
  }
  return { renamed: true, userId, previousUsername: account.username, username, displayName: account.displayName };
}

export function updateLocalAccountDisplayName(actor: RequestUser, body: Record<string, unknown>) {
  requireLocalAdministrator(actor);
  const userId = requiredText(body.userId, "账号");
  const displayName = requiredText(body.displayName, "显示名称").slice(0, 40);
  const db = getDatabase();
  const account = findLocalAccountByUserId(userId);
  if (!account) throw createError({ statusCode: 404, statusMessage: "本地账号不存在" });
  if (account.displayName === displayName) {
    throw createError({ statusCode: 400, statusMessage: "新显示名称与当前相同" });
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("UPDATE users SET display_name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(displayName, userId);
    db.prepare(`
      INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, detail_json)
      VALUES (?, ?, 'auth.local_account_display_name_changed', 'user', ?, ?)
    `).run(createId("audit"), actor.id, userId, JSON.stringify({ previousDisplayName: account.displayName, displayName, username: account.username }));
    db.exec("COMMIT");
  } catch (cause) {
    rollbackAfterError(db);
    throw cause;
  }
  return { updated: true, userId, username: account.username, previousDisplayName: account.displayName, displayName };
}

export function setLocalAccountDisabled(actor: RequestUser, body: Record<string, unknown>) {
  requireLocalAdministrator(actor);
  const userId = requiredText(body.userId, "账号");
  if (typeof body.disabled !== "boolean") {
    throw createError({ statusCode: 400, statusMessage: "请指定停用或启用" });
  }
  const disabled = body.disabled;
  const db = getDatabase();
  const account = findLocalAccountByUserId(userId);
  if (!account) throw createError({ statusCode: 404, statusMessage: "本地账号不存在" });
  if (disabled && Number(account.isAdmin)) {
    throw createError({ statusCode: 400, statusMessage: "管理员账号不能停用" });
  }
  if (disabled === Boolean(account.disabledAt)) {
    return { userId, username: account.username, displayName: account.displayName, disabled, changed: false };
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    if (disabled) {
      db.prepare("UPDATE local_accounts SET disabled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(account.id);
      db.prepare("UPDATE auth_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE user_id = ? AND revoked_at IS NULL").run(userId);
      db.prepare("DELETE FROM login_attempts WHERE username = ?").run(account.username);
    } else {
      db.prepare("UPDATE local_accounts SET disabled_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(account.id);
    }
    db.prepare(`
      INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, detail_json)
      VALUES (?, ?, ?, 'user', ?, ?)
    `).run(createId("audit"), actor.id, disabled ? "auth.local_account_disabled" : "auth.local_account_enabled", userId, JSON.stringify({ username: account.username, sessionsRevoked: disabled }));
    db.exec("COMMIT");
  } catch (cause) {
    rollbackAfterError(db);
    throw cause;
  }
  return { userId, username: account.username, displayName: account.displayName, disabled, changed: true };
}

export function deleteLocalAccount(actor: RequestUser, body: Record<string, unknown>) {
  requireLocalAdministrator(actor);
  const userId = requiredText(body.userId, "账号");
  const db = getDatabase();
  const account = findLocalAccountByUserId(userId);
  if (!account) throw createError({ statusCode: 404, statusMessage: "本地账号不存在" });
  if (Number(account.isAdmin)) {
    throw createError({ statusCode: 400, statusMessage: "管理员账号不能删除" });
  }
  /* 仅该账号持有权限的成员会在删除后变成无人可访问的孤儿数据，删除前要求显式确认 */
  const force = body.force === true;
  const exclusiveMembers = db.prepare(`
    SELECT hm.id FROM health_members hm
    JOIN member_permissions mp ON mp.member_id = hm.id AND mp.user_id = ?
    WHERE hm.deleted_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM member_permissions other WHERE other.member_id = hm.id AND other.user_id <> ?)
  `).all(userId, userId) as Array<{ id: string }>;
  let exclusiveReportCount = 0;
  if (exclusiveMembers.length) {
    const placeholders = exclusiveMembers.map(() => "?").join(", ");
    exclusiveReportCount = Number((db.prepare(`
      SELECT COUNT(*) AS count FROM reports WHERE deleted_at IS NULL AND member_id IN (${placeholders})
    `).get(...exclusiveMembers.map(member => member.id)) as { count: number }).count);
  }
  if (!force && exclusiveReportCount > 0) {
    throw createError({
      statusCode: 409,
      statusMessage: `该账号名下有 ${exclusiveMembers.length} 个仅其管理的成员档案，共 ${exclusiveReportCount} 份报告；删除账号后这些数据将无法访问但仍占用存储。如确认不再使用，请选择“仍要删除”`
    });
  }
  /* 仅移除登录身份与会话，保留 users/成员档案与健康数据，避免误删医疗资料 */
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("DELETE FROM local_accounts WHERE user_id = ?").run(userId);
    db.prepare("DELETE FROM user_identities WHERE user_id = ? AND provider = 'local'").run(userId);
    db.prepare("DELETE FROM auth_sessions WHERE user_id = ?").run(userId);
    db.prepare("DELETE FROM login_attempts WHERE username = ?").run(account.username);
    db.prepare("DELETE FROM member_permissions WHERE user_id = ?").run(userId);
    db.prepare(`
      INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, detail_json)
      VALUES (?, ?, 'auth.local_account_deleted', 'user', ?, ?)
    `).run(createId("audit"), actor.id, userId, JSON.stringify({ username: account.username, displayName: account.displayName, forced: force, exclusiveMemberCount: exclusiveMembers.length, exclusiveReportCount }));
    db.exec("COMMIT");
  } catch (cause) {
    rollbackAfterError(db);
    throw cause;
  }
  return { deleted: true, userId, username: account.username, displayName: account.displayName, exclusiveMemberCount: exclusiveMembers.length, exclusiveReportCount };
}
