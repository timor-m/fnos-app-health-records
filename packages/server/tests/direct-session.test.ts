import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { H3Event } from "h3";
import { closeDatabaseForTests, getDatabase } from "../database/client.ts";
import forcePasswordChange from "../middleware/03-password-change.ts";
import { getRequestUser } from "../utils/request-user.ts";
import {
  bootstrapLocalAdministrator,
  changeLocalPassword,
  createLocalAccount,
  localAuthSetupRequired,
  login,
  logout,
  resetLocalAccountPassword
} from "../services/auth.service.ts";

function localAuthEvent(options: { cookie?: string; forwardedProto?: string; clientAddress?: string; path?: string } = {}) {
  const nodeHeaders: Record<string, string> = {};
  if (options.cookie) nodeHeaders.cookie = options.cookie;
  if (options.forwardedProto) nodeHeaders["x-forwarded-proto"] = options.forwardedProto;
  const headers = new Headers(nodeHeaders);
  return {
    req: {
      headers,
      url: `http://health.test${options.path || "/api/auth/login"}`,
      context: { clientAddress: options.clientAddress || "127.0.0.1" }
    },
    res: { headers: new Headers() },
    node: { req: { headers: nodeHeaders, url: options.path || "/api/auth/login", socket: {} } }
  } as unknown as H3Event;
}

test("ignores historical local session cookies outside the fnOS gateway", () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-session-"));
  process.env.STORAGE_DIR = storageDir;
  try {
    const db = getDatabase();
    db.prepare(`
      INSERT INTO users (id, display_name, is_gateway_admin)
      VALUES ('local-direct-admin', 'admin', 1)
    `).run();

    const event = {
      node: {
        req: {
          healthAccessMode: "port",
          headers: { cookie: "health_session=legacy-local-session" }
        }
      }
    } as unknown as H3Event;

    assert.deepEqual(getRequestUser(event), {
      id: "anonymous",
      displayName: "未登录",
      provider: "fnos_gateway",
      authenticated: false,
      isAdmin: false,
      isGatewayAdmin: false
    });
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
});

test("keeps fnOS gateway identity and administrator permissions in fnOS mode", () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-fnos-auth-"));
  process.env.STORAGE_DIR = storageDir;
  process.env.AUTH_MODE = "fnos";
  try {
    const event = {
      node: {
        req: {
          healthAccessMode: "gateway",
          headers: {
            "x-trim-userid": "fnos-user-1000",
            "x-trim-username": "飞牛管理员",
            "x-trim-isadmin": "true"
          }
        }
      }
    } as unknown as H3Event;
    const resolved=getRequestUser(event);
    assert.notEqual(resolved.id,"fnos-user-1000");
    assert.deepEqual(resolved, {
      id: resolved.id,
      displayName: "飞牛管理员",
      provider: "fnos_gateway",
      authenticated: true,
      isAdmin: true,
      isGatewayAdmin: true
    });
    const stored = getDatabase().prepare(`
      SELECT display_name AS displayName, is_gateway_admin AS isAdmin FROM users WHERE id = ?
    `).get(resolved.id) as { displayName: string; isAdmin: number };
    assert.deepEqual({ ...stored }, { displayName: "飞牛管理员", isAdmin: 1 });
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    delete process.env.AUTH_MODE;
    rmSync(storageDir, { recursive: true, force: true });
  }
});

test("decodes mojibake gateway account names and heals stored display names", () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-fnos-mojibake-"));
  process.env.STORAGE_DIR = storageDir;
  process.env.AUTH_MODE = "fnos";
  try {
    // Node.js decodes header values as latin1, so the raw UTF-8 bytes written
    // by the gateway arrive as mojibake; older builds stored it directly.
    const mangled = Buffer.from("测试用户", "utf8").toString("latin1");
    const db = getDatabase();
    db.prepare(`
      INSERT INTO users (id, display_name, is_gateway_admin) VALUES ('fnos-user-1000', ?, 1)
    `).run(mangled);
    db.exec("INSERT INTO user_identities(id,user_id,provider,subject) VALUES('old-identity','fnos-user-1000','fnos_gateway','fnos-user-1000')");
    db.prepare(`
      INSERT INTO health_members (id, display_name, relationship, created_by)
      VALUES ('member-self', ?, 'self', 'fnos-user-1000')
    `).run(mangled);
    db.prepare(`
      INSERT INTO member_permissions (member_id, user_id, permission, granted_by)
      VALUES ('member-self', 'fnos-user-1000', 'manager', 'fnos-user-1000')
    `).run();
    db.prepare(`
      INSERT INTO health_members (id, display_name, relationship, created_by)
      VALUES ('member-family', '自定义成员', 'family', 'fnos-user-1000')
    `).run();

    const event = {
      node: {
        req: {
          healthAccessMode: "gateway",
          headers: {
            "x-trim-userid": "fnos-user-1000",
            "x-trim-username": mangled,
            "x-trim-isadmin": "true"
          }
        }
      }
    } as unknown as H3Event;
    assert.equal(getRequestUser(event).displayName, "测试用户");

    const storedUser = db.prepare(`
      SELECT display_name AS displayName FROM users WHERE id = 'fnos-user-1000'
    `).get() as { displayName: string };
    assert.equal(storedUser.displayName, "测试用户");
    const members = db.prepare(`
      SELECT id, display_name AS displayName FROM health_members ORDER BY id
    `).all() as Array<{ id: string; displayName: string }>;
    assert.deepEqual(members.map((member) => ({ ...member })), [
      { id: "member-family", displayName: "自定义成员" },
      { id: "member-self", displayName: mangled }
    ]);

    // A self member renamed away from the account name is left untouched.
    db.prepare(`UPDATE health_members SET display_name = '本人档案' WHERE id = 'member-self'`).run();
    db.prepare(`UPDATE users SET display_name = ? WHERE id = 'fnos-user-1000'`).run(mangled);
    assert.equal(getRequestUser(event).displayName, "测试用户");
    const renamed = db.prepare(`
      SELECT display_name AS displayName FROM health_members WHERE id = 'member-self'
    `).get() as { displayName: string };
    assert.equal(renamed.displayName, "本人档案");
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    delete process.env.AUTH_MODE;
    rmSync(storageDir, { recursive: true, force: true });
  }
});

test("bootstraps a Docker local administrator and resolves only its persisted session", () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-local-auth-"));
  process.env.STORAGE_DIR = storageDir;
  process.env.AUTH_MODE = "local";
  process.env.LOCAL_ADMIN_USERNAME = "docker-admin";
  process.env.LOCAL_ADMIN_DISPLAY_NAME = "Docker 管理员";
  process.env.LOCAL_ADMIN_PASSWORD = "local-admin-password-2026";
  try {
    assert.equal(localAuthSetupRequired(), true);
    const bootstrap = bootstrapLocalAdministrator();
    assert.equal(bootstrap.created, true);
    assert.equal(localAuthSetupRequired(), false);

    const db = getDatabase();
    const account = db.prepare(`
      SELECT la.user_id AS userId, la.username, u.display_name AS displayName,
        u.is_gateway_admin AS isAdmin
      FROM local_accounts la JOIN users u ON u.id = la.user_id
    `).get() as { userId: string; username: string; displayName: string; isAdmin: number };
    assert.deepEqual({
      username: account.username,
      displayName: account.displayName,
      isAdmin: account.isAdmin
    }, {
      username: "docker-admin",
      displayName: "Docker 管理员",
      isAdmin: 1
    });
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM health_members").get() as { count: number }).count, 0);

    const token = "persisted-local-session-token";
    const hash = createHash("sha256").update(token).digest("hex");
    db.prepare(`
      INSERT INTO auth_sessions (id, user_id, token_hash, expires_at)
      VALUES ('session-local-test', ?, ?, datetime('now', '+1 hour'))
    `).run(account.userId, hash);
    const event = {
      node: {
        req: {
          healthAccessMode: "port",
          headers: {
            cookie: `health_session=${token}`,
            "x-trim-userid": "spoofed-gateway-admin",
            "x-trim-isadmin": "true"
          }
        }
      }
    } as unknown as H3Event;
    assert.deepEqual(getRequestUser(event), {
      id: account.userId,
      displayName: "Docker 管理员",
      provider: "local",
      authenticated: true,
      isAdmin: true,
      mustChangePassword: true,
      isGatewayAdmin: true
    });

    const anonymousEvent = {
      node: { req: { healthAccessMode: "port", headers: { "x-trim-isadmin": "true" } } }
    } as unknown as H3Event;
    assert.deepEqual(getRequestUser(anonymousEvent), {
      id: "anonymous",
      displayName: "未登录",
      provider: "local",
      authenticated: false,
      isAdmin: false,
      isGatewayAdmin: false
    });
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    delete process.env.AUTH_MODE;
    delete process.env.LOCAL_ADMIN_USERNAME;
    delete process.env.LOCAL_ADMIN_DISPLAY_NAME;
    delete process.env.LOCAL_ADMIN_PASSWORD;
    rmSync(storageDir, { recursive: true, force: true });
  }
});

test("creates admin/admin on a fresh local deployment and requires the first password change", () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-local-default-"));
  process.env.STORAGE_DIR = storageDir;
  process.env.AUTH_MODE = "local";
  try {
    bootstrapLocalAdministrator();
    const loginEvent = localAuthEvent();
    assert.deepEqual(login(loginEvent, { username: "admin", password: "admin" }), {
      authenticated: true,
      mustChangePassword: true
    });
    const cookie = (loginEvent.res.headers.get("set-cookie") || "").split(";", 1)[0];
    const user = getRequestUser(localAuthEvent({ cookie }));
    assert.equal(user.mustChangePassword, true);
    assert.throws(() => forcePasswordChange(localAuthEvent({ cookie, path: "/api/overview" })),
      (error: unknown) => Number((error as { statusCode?: number }).statusCode) === 428);
    assert.doesNotThrow(() => forcePasswordChange(localAuthEvent({ cookie, path: "/api/session" })));
    assert.deepEqual(changeLocalPassword(localAuthEvent({ cookie }), user, {
      newPassword: "first-local-password-2026",
      confirmPassword: "first-local-password-2026"
    }), { changed: true, reauthenticationRequired: true });
    assert.throws(() => login(localAuthEvent(), { username: "admin", password: "admin" }), (error: unknown) => Number((error as { statusCode?: number }).statusCode) === 401);
    assert.deepEqual(login(localAuthEvent(), { username: "admin", password: "first-local-password-2026" }), {
      authenticated: true,
      mustChangePassword: false
    });
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    delete process.env.AUTH_MODE;
    rmSync(storageDir, { recursive: true, force: true });
  }
});

test("allows a local administrator to reset an ordinary local account", () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-local-account-reset-"));
  process.env.STORAGE_DIR = storageDir;
  process.env.AUTH_MODE = "local";
  try {
    bootstrapLocalAdministrator();
    const adminLogin = localAuthEvent();
    login(adminLogin, { username: "admin", password: "admin" });
    const adminCookie = (adminLogin.res.headers.get("set-cookie") || "").split(";", 1)[0];
    const db = getDatabase();
    const adminUser = getRequestUser(localAuthEvent({ cookie: adminCookie }));
    const created = createLocalAccount(adminUser, { username: "ordinary", displayName: "普通用户" });
    const ordinaryUserId = created.userId;
    assert.deepEqual(created.temporaryPassword, "admin");
    assert.deepEqual(resetLocalAccountPassword(getRequestUser(localAuthEvent({ cookie: adminCookie })), {
      userId: ordinaryUserId,
      newPassword: "ordinary-reset-password-2026",
      confirmPassword: "ordinary-reset-password-2026"
    }), { reset: true, username: "ordinary", displayName: "普通用户", mustChangePassword: true });
    assert.deepEqual(login(localAuthEvent(), { username: "ordinary", password: "ordinary-reset-password-2026" }), {
      authenticated: true,
      mustChangePassword: true
    });
    assert.equal((db.prepare("SELECT must_change_password AS value FROM local_accounts WHERE user_id = ?").get(ordinaryUserId) as { value: number }).value, 1);
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    delete process.env.AUTH_MODE;
    rmSync(storageDir, { recursive: true, force: true });
  }
});

test("logs in, revokes local sessions, trusts HTTPS proxy explicitly and rate limits failures", () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-local-login-"));
  process.env.STORAGE_DIR = storageDir;
  process.env.AUTH_MODE = "local";
  process.env.LOCAL_ADMIN_USERNAME = "docker-admin";
  process.env.LOCAL_ADMIN_PASSWORD = "local-admin-password-2026";
  try {
    bootstrapLocalAdministrator();
    const loginEvent = localAuthEvent();
    assert.deepEqual(login(loginEvent, {
      username: "docker-admin",
      password: "local-admin-password-2026"
    }), { authenticated: true, mustChangePassword: true });
    const setCookie = loginEvent.res.headers.get("set-cookie") || "";
    assert.match(setCookie, /^health_session=[^;]+;/);
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Lax/);
    assert.doesNotMatch(setCookie, /Secure/);
    const cookie = setCookie.split(";", 1)[0];
    assert.equal(getRequestUser(localAuthEvent({ cookie })).authenticated, true);

    assert.deepEqual(logout(localAuthEvent({ cookie })), { authenticated: false });
    assert.equal(getRequestUser(localAuthEvent({ cookie })).authenticated, false);

    process.env.TRUST_PROXY = "1";
    const httpsEvent = localAuthEvent({ forwardedProto: "https", clientAddress: "127.0.0.2" });
    login(httpsEvent, {
      username: "docker-admin",
      password: "local-admin-password-2026"
    });
    assert.match(httpsEvent.res.headers.get("set-cookie") || "", /Secure/);
    delete process.env.TRUST_PROXY;

    for (let attempt = 0; attempt < 5; attempt += 1) {
      assert.throws(() => login(localAuthEvent(), {
        username: "docker-admin",
        password: "incorrect-password"
      }), (error: unknown) => Number((error as { statusCode?: number }).statusCode) === 401);
    }
    assert.throws(() => login(localAuthEvent(), {
      username: "docker-admin",
      password: "incorrect-password"
    }), (error: unknown) => Number((error as { statusCode?: number }).statusCode) === 429);
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    delete process.env.AUTH_MODE;
    delete process.env.LOCAL_ADMIN_USERNAME;
    delete process.env.LOCAL_ADMIN_PASSWORD;
    delete process.env.TRUST_PROXY;
    rmSync(storageDir, { recursive: true, force: true });
  }
});

test("changes a local administrator password and revokes every existing session", () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-password-change-"));
  process.env.STORAGE_DIR = storageDir;
  process.env.AUTH_MODE = "local";
  process.env.LOCAL_ADMIN_USERNAME = "docker-admin";
  process.env.LOCAL_ADMIN_PASSWORD = "local-admin-password-2026";
  try {
    bootstrapLocalAdministrator();
    const firstLogin = localAuthEvent();
    login(firstLogin, { username: "docker-admin", password: "local-admin-password-2026" });
    const firstCookie = (firstLogin.res.headers.get("set-cookie") || "").split(";", 1)[0];
    const secondLogin = localAuthEvent({ clientAddress: "127.0.0.2" });
    login(secondLogin, { username: "docker-admin", password: "local-admin-password-2026" });
    const secondCookie = (secondLogin.res.headers.get("set-cookie") || "").split(";", 1)[0];
    const event = localAuthEvent({ cookie: firstCookie });
    const user = getRequestUser(event);

    assert.throws(() => changeLocalPassword(event, user, {
      currentPassword: "local-admin-password-2026",
      newPassword: "short7!",
      confirmPassword: "short7!"
    }), (error: unknown) => Number((error as { statusCode?: number }).statusCode) === 400);
    assert.deepEqual(changeLocalPassword(event, user, {
      currentPassword: "local-admin-password-2026",
      newPassword: "short8!!",
      confirmPassword: "short8!!"
    }), { changed: true, reauthenticationRequired: true });
    assert.match(event.res.headers.get("set-cookie") || "", /Max-Age=0/);
    assert.equal(getRequestUser(localAuthEvent({ cookie: firstCookie })).authenticated, false);
    assert.equal(getRequestUser(localAuthEvent({ cookie: secondCookie })).authenticated, false);
    assert.throws(() => login(localAuthEvent(), {
      username: "docker-admin",
      password: "local-admin-password-2026"
    }), (error: unknown) => Number((error as { statusCode?: number }).statusCode) === 401);
    assert.deepEqual(login(localAuthEvent(), {
      username: "docker-admin",
      password: "short8!!"
    }), { authenticated: true, mustChangePassword: false });
    const audit = getDatabase().prepare(`
      SELECT action FROM audit_logs WHERE action = 'auth.local_password_first_changed'
    `).get() as { action: string } | undefined;
    assert.equal(audit?.action, "auth.local_password_first_changed");
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    delete process.env.AUTH_MODE;
    delete process.env.LOCAL_ADMIN_USERNAME;
    delete process.env.LOCAL_ADMIN_PASSWORD;
    rmSync(storageDir, { recursive: true, force: true });
  }
});

test("does not expose local password management in fnOS mode", () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-fnos-password-"));
  process.env.STORAGE_DIR = storageDir;
  process.env.AUTH_MODE = "fnos";
  try {
    const user = {
      id: "fnos-admin",
      displayName: "飞牛管理员",
      provider: "fnos_gateway" as const,
      authenticated: true,
      isAdmin: true,
      isGatewayAdmin: true
    };
    assert.throws(() => changeLocalPassword(localAuthEvent(), user, {
      currentPassword: "irrelevant-password",
      newPassword: "new-local-password-2026",
      confirmPassword: "new-local-password-2026"
    }), (error: unknown) => Number((error as { statusCode?: number }).statusCode) === 410);
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    delete process.env.AUTH_MODE;
    rmSync(storageDir, { recursive: true, force: true });
  }
});

test("resets a forgotten local password through the offline Docker command", () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-password-reset-"));
  const passwordFile = join(storageDir, "reset-password.txt");
  process.env.STORAGE_DIR = storageDir;
  process.env.AUTH_MODE = "local";
  process.env.LOCAL_ADMIN_USERNAME = "docker-admin";
  process.env.LOCAL_ADMIN_PASSWORD = "local-admin-password-2026";
  try {
    bootstrapLocalAdministrator();
    closeDatabaseForTests();
    writeFileSync(passwordFile, "offline-reset-password-2026\n", { mode: 0o600 });
    const output = execFileSync(process.execPath, [
      join(process.cwd(), "scripts", "reset-local-admin-password.mjs"),
      "--password-file", passwordFile,
      "--username", "docker-admin"
    ], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, STORAGE_DIR: storageDir }
    });
    assert.match(output, /password reset completed/);
    assert.throws(() => login(localAuthEvent(), {
      username: "docker-admin",
      password: "local-admin-password-2026"
    }), (error: unknown) => Number((error as { statusCode?: number }).statusCode) === 401);
    assert.deepEqual(login(localAuthEvent(), {
      username: "docker-admin",
      password: "offline-reset-password-2026"
    }), { authenticated: true, mustChangePassword: true });
    const audit = getDatabase().prepare(`
      SELECT action FROM audit_logs WHERE action = 'auth.local_password_reset'
    `).get() as { action: string } | undefined;
    assert.equal(audit?.action, "auth.local_password_reset");
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    delete process.env.AUTH_MODE;
    delete process.env.LOCAL_ADMIN_USERNAME;
    delete process.env.LOCAL_ADMIN_PASSWORD;
    rmSync(storageDir, { recursive: true, force: true });
  }
});
