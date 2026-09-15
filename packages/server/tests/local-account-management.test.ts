import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { H3Event } from "h3";
import { closeDatabaseForTests, getDatabase } from "../database/client.ts";
import { getRequestUser } from "../utils/request-user.ts";
import {
  bootstrapLocalAdministrator,
  createLocalAccount,
  deleteLocalAccount,
  listLocalAccounts,
  login,
  renameLocalAccount,
  setLocalAccountDisabled,
  updateLocalAccountDisplayName
} from "../services/auth.service.ts";

function localAuthEvent(options: { cookie?: string; path?: string } = {}) {
  const nodeHeaders: Record<string, string> = {};
  if (options.cookie) nodeHeaders.cookie = options.cookie;
  const headers = new Headers(nodeHeaders);
  return {
    req: {
      headers,
      url: `http://health.test${options.path || "/api/auth/login"}`,
      context: { clientAddress: "127.0.0.1" }
    },
    res: { headers: new Headers() },
    node: { req: { headers: nodeHeaders, url: options.path || "/api/auth/login", socket: {} } }
  } as unknown as H3Event;
}

function loginAs(username: string, password: string) {
  const event = localAuthEvent();
  login(event, { username, password });
  const cookie = (event.res.headers.get("set-cookie") || "").split(";", 1)[0];
  return { cookie, user: getRequestUser(localAuthEvent({ cookie })) };
}

function statusCode(error: unknown) {
  return Number((error as { statusCode?: number }).statusCode);
}

function setupLocalAdmin() {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-account-mgmt-"));
  process.env.STORAGE_DIR = storageDir;
  process.env.AUTH_MODE = "local";
  bootstrapLocalAdministrator();
  const admin = loginAs("admin", "admin");
  return { storageDir, admin };
}

function cleanup(storageDir: string) {
  closeDatabaseForTests();
  delete process.env.STORAGE_DIR;
  delete process.env.AUTH_MODE;
  rmSync(storageDir, { recursive: true, force: true });
}

test("renames local accounts including the administrator", () => {
  const { storageDir, admin } = setupLocalAdmin();
  try {
    const db = getDatabase();
    const created = createLocalAccount(admin.user, { username: "ordinary", displayName: "普通用户" });

    const renamed = renameLocalAccount(admin.user, { userId: created.userId, username: "ordinary-renamed" });
    assert.deepEqual(renamed, {
      renamed: true,
      userId: created.userId,
      previousUsername: "ordinary",
      username: "ordinary-renamed",
      displayName: "普通用户"
    });
    assert.equal(
      (db.prepare("SELECT subject FROM user_identities WHERE user_id = ? AND provider = 'local'").get(created.userId) as { subject: string }).subject,
      "ordinary-renamed"
    );
    assert.deepEqual(login(localAuthEvent(), { username: "ordinary-renamed", password: "admin" }), {
      authenticated: true,
      mustChangePassword: true
    });
    assert.throws(() => login(localAuthEvent(), { username: "ordinary", password: "admin" }), (error: unknown) => statusCode(error) === 401);

    const adminRename = renameLocalAccount(admin.user, { userId: admin.user.id, username: "root-admin" });
    assert.equal(adminRename.previousUsername, "admin");
    assert.equal(adminRename.username, "root-admin");
    assert.throws(() => login(localAuthEvent(), { username: "admin", password: "admin" }), (error: unknown) => statusCode(error) === 401);
    assert.deepEqual(login(localAuthEvent(), { username: "root-admin", password: "admin" }), {
      authenticated: true,
      mustChangePassword: true
    });

    assert.throws(
      () => renameLocalAccount(admin.user, { userId: created.userId, username: "root-admin" }),
      (error: unknown) => statusCode(error) === 409
    );
    assert.throws(
      () => renameLocalAccount(admin.user, { userId: created.userId, username: "ordinary-renamed" }),
      (error: unknown) => statusCode(error) === 400
    );
    assert.throws(
      () => renameLocalAccount(admin.user, { userId: created.userId, username: "ab" }),
      (error: unknown) => statusCode(error) === 400
    );
    assert.throws(
      () => renameLocalAccount(admin.user, { userId: created.userId, username: "has space" }),
      (error: unknown) => statusCode(error) === 400
    );
    assert.throws(
      () => renameLocalAccount(admin.user, { userId: "missing-user", username: "whatever" }),
      (error: unknown) => statusCode(error) === 404
    );

    const ordinary = loginAs("ordinary-renamed", "admin");
    assert.throws(
      () => renameLocalAccount(ordinary.user, { userId: created.userId, username: "another-name" }),
      (error: unknown) => statusCode(error) === 403
    );
  } finally {
    cleanup(storageDir);
  }
});

test("disables and re-enables ordinary local accounts", () => {
  const { storageDir, admin } = setupLocalAdmin();
  try {
    const created = createLocalAccount(admin.user, { username: "ordinary", displayName: "普通用户" });
    const ordinary = loginAs("ordinary", "admin");
    assert.equal(ordinary.user.authenticated, true);

    const disabled = setLocalAccountDisabled(admin.user, { userId: created.userId, disabled: true });
    assert.deepEqual(disabled, { userId: created.userId, username: "ordinary", displayName: "普通用户", disabled: true, changed: true });
    assert.equal(getRequestUser(localAuthEvent({ cookie: ordinary.cookie })).authenticated, false);
    assert.throws(() => login(localAuthEvent(), { username: "ordinary", password: "admin" }), (error: unknown) => statusCode(error) === 401);

    const listed = listLocalAccounts(admin.user) as Array<{ userId: string; disabledAt: string | null }>;
    assert.equal(listed.find(account => account.userId === created.userId)?.disabledAt !== null, true);

    assert.deepEqual(setLocalAccountDisabled(admin.user, { userId: created.userId, disabled: true }), {
      userId: created.userId,
      username: "ordinary",
      displayName: "普通用户",
      disabled: true,
      changed: false
    });
    assert.throws(
      () => setLocalAccountDisabled(admin.user, { userId: admin.user.id, disabled: true }),
      (error: unknown) => statusCode(error) === 400
    );
    assert.throws(
      () => setLocalAccountDisabled(admin.user, { userId: created.userId }),
      (error: unknown) => statusCode(error) === 400
    );
    assert.throws(
      () => setLocalAccountDisabled(admin.user, { userId: "missing-user", disabled: true }),
      (error: unknown) => statusCode(error) === 404
    );

    const enabled = setLocalAccountDisabled(admin.user, { userId: created.userId, disabled: false });
    assert.deepEqual(enabled, { userId: created.userId, username: "ordinary", displayName: "普通用户", disabled: false, changed: true });
    assert.deepEqual(login(localAuthEvent(), { username: "ordinary", password: "admin" }), {
      authenticated: true,
      mustChangePassword: true
    });

    const relogged = loginAs("ordinary", "admin");
    assert.throws(
      () => setLocalAccountDisabled(relogged.user, { userId: created.userId, disabled: true }),
      (error: unknown) => statusCode(error) === 403
    );
  } finally {
    cleanup(storageDir);
  }
});

test("deletes ordinary local accounts but keeps users and member data", () => {
  const { storageDir, admin } = setupLocalAdmin();
  try {
    const db = getDatabase();
    const created = createLocalAccount(admin.user, { username: "ordinary", displayName: "普通用户" });
    const ordinary = loginAs("ordinary", "admin");
    assert.equal(ordinary.user.authenticated, true);

    const deleted = deleteLocalAccount(admin.user, { userId: created.userId });
    assert.deepEqual(deleted, {
      deleted: true,
      userId: created.userId,
      username: "ordinary",
      displayName: "普通用户",
      exclusiveMemberCount: 1,
      exclusiveReportCount: 0
    });

    assert.throws(() => login(localAuthEvent(), { username: "ordinary", password: "admin" }), (error: unknown) => statusCode(error) === 401);
    assert.equal(getRequestUser(localAuthEvent({ cookie: ordinary.cookie })).authenticated, false);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM local_accounts WHERE user_id = ?").get(created.userId)!.count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM auth_sessions WHERE user_id = ?").get(created.userId)!.count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM user_identities WHERE user_id = ? AND provider = 'local'").get(created.userId)!.count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM member_permissions WHERE user_id = ?").get(created.userId)!.count, 0);

    /* 用户与成员档案保留，避免误删健康数据 */
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM users WHERE id = ?").get(created.userId)!.count, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM health_members WHERE created_by = ?").get(created.userId)!.count, 1);

    /* 用户名释放后可直接重建同名账号 */
    const recreated = createLocalAccount(admin.user, { username: "ordinary", displayName: "普通用户" });
    assert.equal(recreated.created, true);

    assert.throws(
      () => deleteLocalAccount(admin.user, { userId: admin.user.id }),
      (error: unknown) => statusCode(error) === 400
    );
    assert.throws(
      () => deleteLocalAccount(admin.user, { userId: "missing-user" }),
      (error: unknown) => statusCode(error) === 404
    );
    const actor = loginAs("ordinary", "admin");
    assert.throws(
      () => deleteLocalAccount(actor.user, { userId: recreated.userId }),
      (error: unknown) => statusCode(error) === 403
    );
  } finally {
    cleanup(storageDir);
  }
});

test("updates local account display names and reflects them in sessions", () => {
  const { storageDir, admin } = setupLocalAdmin();
  try {
    const db = getDatabase();
    const created = createLocalAccount(admin.user, { username: "ordinary", displayName: "普通用户" });

    const updated = updateLocalAccountDisplayName(admin.user, { userId: created.userId, displayName: "新名字" });
    assert.deepEqual(updated, {
      updated: true,
      userId: created.userId,
      username: "ordinary",
      previousDisplayName: "普通用户",
      displayName: "新名字"
    });
    assert.equal(
      (db.prepare("SELECT display_name AS name FROM users WHERE id = ?").get(created.userId) as { name: string }).name,
      "新名字"
    );
    const relogged = loginAs("ordinary", "admin");
    assert.equal(relogged.user.displayName, "新名字");

    assert.throws(
      () => updateLocalAccountDisplayName(admin.user, { userId: created.userId, displayName: "新名字" }),
      (error: unknown) => statusCode(error) === 400
    );
    assert.throws(
      () => updateLocalAccountDisplayName(admin.user, { userId: created.userId, displayName: "  " }),
      (error: unknown) => statusCode(error) === 400
    );
    assert.throws(
      () => updateLocalAccountDisplayName(admin.user, { userId: "missing-user", displayName: "任意" }),
      (error: unknown) => statusCode(error) === 404
    );
    assert.throws(
      () => updateLocalAccountDisplayName(relogged.user, { userId: created.userId, displayName: "另一个" }),
      (error: unknown) => statusCode(error) === 403
    );

    /* 管理员可修改自己的显示名称 */
    const selfUpdated = updateLocalAccountDisplayName(admin.user, { userId: admin.user.id, displayName: "超级管理员" });
    assert.equal(selfUpdated.displayName, "超级管理员");
  } finally {
    cleanup(storageDir);
  }
});

test("blocks deleting accounts that would orphan member data unless forced", () => {
  const { storageDir, admin } = setupLocalAdmin();
  try {
    const db = getDatabase();
    const created = createLocalAccount(admin.user, { username: "ordinary", displayName: "普通用户" });
    const member = db.prepare("SELECT id FROM health_members WHERE created_by = ?").get(created.userId) as { id: string };
    db.prepare("INSERT INTO reports (id, member_id, created_by, report_type, title) VALUES (?, ?, ?, ?, ?)")
      .run("report_orphan_1", member.id, created.userId, "exam", "体检报告");

    assert.throws(
      () => deleteLocalAccount(admin.user, { userId: created.userId }),
      (error: unknown) => statusCode(error) === 409 && String((error as Error).message).includes("1 份报告")
    );
    /* 阻断后账号仍可登录 */
    assert.deepEqual(login(localAuthEvent(), { username: "ordinary", password: "admin" }), {
      authenticated: true,
      mustChangePassword: true
    });

    const forced = deleteLocalAccount(admin.user, { userId: created.userId, force: true });
    assert.deepEqual(forced, {
      deleted: true,
      userId: created.userId,
      username: "ordinary",
      displayName: "普通用户",
      exclusiveMemberCount: 1,
      exclusiveReportCount: 1
    });
    /* 强制删除后成员与报告仍保留（孤儿数据，管理员知情） */
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM health_members WHERE id = ?").get(member.id)!.count, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM reports WHERE id = 'report_orphan_1'").get()!.count, 1);

    /* 成员同时授权给其他账号时不构成孤儿数据，无需强制确认 */
    const shared = createLocalAccount(admin.user, { username: "shared", displayName: "共享用户" });
    const sharedMember = db.prepare("SELECT id FROM health_members WHERE created_by = ?").get(shared.userId) as { id: string };
    db.prepare("INSERT INTO reports (id, member_id, created_by, report_type, title) VALUES (?, ?, ?, ?, ?)")
      .run("report_shared_1", sharedMember.id, shared.userId, "exam", "门诊报告");
    db.prepare("INSERT INTO member_permissions (member_id, user_id, permission, granted_by) VALUES (?, ?, 'manager', ?)")
      .run(sharedMember.id, admin.user.id, admin.user.id);
    const deletedShared = deleteLocalAccount(admin.user, { userId: shared.userId });
    assert.equal(deletedShared.exclusiveMemberCount, 0);
    assert.equal(deletedShared.exclusiveReportCount, 0);

    /* 无报告的成员档案不触发阻断 */
    const empty = createLocalAccount(admin.user, { username: "empty", displayName: "空档案" });
    const deletedEmpty = deleteLocalAccount(admin.user, { userId: empty.userId });
    assert.equal(deletedEmpty.exclusiveMemberCount, 1);
    assert.equal(deletedEmpty.exclusiveReportCount, 0);
  } finally {
    cleanup(storageDir);
  }
});
