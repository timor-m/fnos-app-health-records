import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import test from "node:test";
import { closeDatabaseForTests, getDatabase } from "../database/client.ts";
import type { RequestUser } from "../domain/request-user.ts";
import {
  getLocalImportPreviewSource,
  importAuthorizedFnosFiles,
  importLocalFiles,
  listLocalImportDirectory,
  listLocalImportDirectoryForUser
} from "../services/local-file-import.service.ts";

const administrator: RequestUser = {
  id: "local-import-admin",
  displayName: "导入管理员",
  provider: "local",
  authenticated: true,
  isAdmin: true,
  isGatewayAdmin: true
};

const fnosAdministrator: RequestUser = {
  ...administrator,
  id: "1000",
  provider: "fnos_gateway"
};

function pngBytes() {
  return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]);
}

test("browses configured roots and copies selected NAS files into private storage", () => {
  const testRoot = mkdtempSync(join(tmpdir(), "health-records-local-import-"));
  const importRoot = join(testRoot, "authorized-reports");
  const storageDir = join(testRoot, "storage");
  const outsideFile = join(testRoot, "outside.png");
  const sourceFile = join(importRoot, "report.png");
  process.env.STORAGE_DIR = storageDir;
  process.env.AUTH_MODE = "local";
  process.env.IMPORT_ROOTS = JSON.stringify([importRoot]);

  try {
    mkdirSync(importRoot, { recursive: true });
    writeFileSync(sourceFile, pngBytes());
    writeFileSync(join(importRoot, "ignored.txt"), "not a report");
    writeFileSync(outsideFile, pngBytes());
    symlinkSync(outsideFile, join(importRoot, "escaped.png"));

    const rootsResponse = listLocalImportDirectory();
    assert.equal(rootsResponse.roots.length, 1);
    const root = rootsResponse.roots[0]!;
    const directory = listLocalImportDirectory(root.id, "");
    assert.deepEqual(directory.entries.map((entry) => entry.name), ["report.png"]);
    const previewSource = getLocalImportPreviewSource(root.id, "report.png");
    assert.equal(previewSource.sourcePath, realpathSync(sourceFile));
    assert.equal(previewSource.mimeType, "image/png");

    assert.throws(
      () => listLocalImportDirectory(root.id, "../"),
      (error: unknown) => (error as { statusCode?: number }).statusCode === 400
    );
    assert.throws(
      () => importLocalFiles(administrator, "local-import-member", [{ rootId: root.id, path: "escaped.png" }]),
      (error: unknown) => (error as { statusCode?: number }).statusCode === 403
    );
    assert.throws(
      () => getLocalImportPreviewSource(root.id, "escaped.png"),
      (error: unknown) => (error as { statusCode?: number }).statusCode === 403
    );

    const db = getDatabase();
    db.prepare("INSERT INTO users (id, display_name, is_gateway_admin) VALUES (?, ?, 1)")
      .run(administrator.id, administrator.displayName);
    db.prepare(`
      INSERT INTO health_members (id, display_name, relationship, created_by)
      VALUES ('local-import-member', '本人', 'self', ?)
    `).run(administrator.id);
    db.prepare(`
      INSERT INTO member_permissions (member_id, user_id, permission, granted_by)
      VALUES ('local-import-member', ?, 'manager', ?)
    `).run(administrator.id, administrator.id);

    const result = importLocalFiles(administrator, "local-import-member", [
      { rootId: root.id, path: "report.png" }
    ]);
    assert.equal(result.pageCount, 1);
    const page = db.prepare(`
      SELECT storage_path AS storagePath, sha256 FROM report_pages WHERE report_id = ?
    `).get(result.reportId) as { storagePath: string; sha256: string };
    assert.equal(existsSync(join(storageDir, page.storagePath)), true);
    assert.deepEqual(readFileSync(join(storageDir, page.storagePath)), pngBytes());
    assert.deepEqual(readFileSync(sourceFile), pngBytes());
    const audit = db.prepare(`SELECT detail_json AS detailJson FROM audit_logs WHERE target_id = ?`)
      .get(result.reportId) as { detailJson: string };
    assert.equal(JSON.parse(audit.detailJson).source, "nas_import");
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    delete process.env.AUTH_MODE;
    delete process.env.IMPORT_ROOTS;
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("reloads the fnOS authorized-path snapshot and explains unavailable roots", async () => {
  const testRoot = mkdtempSync(join(tmpdir(), "health-records-fnos-paths-"));
  const firstRoot = join(testRoot, "first");
  const secondRoot = join(testRoot, "second");
  const storageDir = join(testRoot, "storage");
  const snapshotPath = join(storageDir, "config", "fnos-authorized-paths");
  process.env.STORAGE_DIR = storageDir;
  process.env.AUTH_MODE = "fnos";
  process.env.TRIM_DATA_ACCESSIBLE_PATHS = join(testRoot, "stale-startup-value");

  try {
    mkdirSync(firstRoot, { recursive: true });
    mkdirSync(secondRoot, { recursive: true });
    mkdirSync(join(storageDir, "config"), { recursive: true });
    writeFileSync(snapshotPath, `${firstRoot}:${secondRoot}`);

    const initial = listLocalImportDirectory();
    assert.deepEqual(initial.roots.map((root) => root.path), [realpathSync(firstRoot), realpathSync(secondRoot)]);
    assert.equal(initial.availability.state, "ready");
    const legacyAdmin = await listLocalImportDirectoryForUser(fnosAdministrator);
    assert.deepEqual(legacyAdmin.roots.map((root) => root.path), [realpathSync(firstRoot), realpathSync(secondRoot)]);
    assert.equal(legacyAdmin.personalAuthorization, false);

    writeFileSync(snapshotPath, join(testRoot, "missing"));
    const unavailable = listLocalImportDirectory();
    assert.equal(unavailable.roots.length, 0);
    assert.equal(unavailable.availability.state, "unavailable");
    assert.equal(unavailable.availability.configuredCount, 1);
    assert.equal(unavailable.availability.unavailableCount, 1);
    assert.match(unavailable.availability.message || "", /飞牛已提供 1 个授权目录/);

    writeFileSync(snapshotPath, "");
    const empty = listLocalImportDirectory();
    assert.equal(empty.availability.state, "not_configured");
    assert.match(empty.availability.message || "", /停止并重新启动/);
  } finally {
    delete process.env.STORAGE_DIR;
    delete process.env.AUTH_MODE;
    delete process.env.TRIM_DATA_ACCESSIBLE_PATHS;
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("lets a regular fnOS user browse and import only personally authorized files", async () => {
  const testRoot = mkdtempSync(join(tmpdir(), "health-records-user-import-"));
  const importRoot = join(testRoot, "personal-reports");
  const sourceFile = join(importRoot, "report.png");
  const blockedFile = join(importRoot, "blocked.png");
  const storageDir = join(testRoot, "storage");
  const socketPath = join(testRoot, "open-api.sock");
  const regularUser: RequestUser = {
    id: "1002",
    displayName: "普通用户",
    provider: "fnos_gateway",
    authenticated: true,
    isAdmin: false,
    isGatewayAdmin: false
  };
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { req?: string; reqId?: string; data?: { path?: string | string[] } };
      const paths = Array.isArray(body.data?.path) ? body.data.path : body.data?.path ? [body.data.path] : [];
      const data = body.req === "trim.file.getUserAccessibleFolders"
        ? { paths: [importRoot] }
        : paths.map((path) => ({ path, readable: !path.endsWith("blocked.png"), writable: false, deletable: false }));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ reqId: body.reqId, code: 0, msg: "", data }));
    });
  });
  process.env.STORAGE_DIR = storageDir;
  process.env.AUTH_MODE = "fnos";
  process.env.TRIM_API_TOKEN = "test-token";
  process.env.TRIM_OPEN_API_SOCKET = socketPath;
  process.env.TRIM_DATA_ACCESSIBLE_PATHS = "";

  try {
    mkdirSync(importRoot, { recursive: true });
    writeFileSync(sourceFile, pngBytes());
    writeFileSync(blockedFile, pngBytes());
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });

    const roots = await listLocalImportDirectoryForUser(regularUser);
    assert.equal(roots.personalAuthorization, true);
    assert.equal(roots.roots.length, 1);
    const directory = await listLocalImportDirectoryForUser(regularUser, roots.roots[0]!.id, "");
    assert.deepEqual(directory.entries.map((entry) => entry.name), ["report.png"]);

    const db = getDatabase();
    db.prepare("INSERT INTO users (id, display_name, is_gateway_admin) VALUES (?, ?, 0)")
      .run(regularUser.id, regularUser.displayName);
    db.prepare(`
      INSERT INTO health_members (id, display_name, relationship, created_by)
      VALUES ('regular-member', '本人', 'self', ?)
    `).run(regularUser.id);
    db.prepare(`
      INSERT INTO member_permissions (member_id, user_id, permission, granted_by)
      VALUES ('regular-member', ?, 'manager', ?)
    `).run(regularUser.id, regularUser.id);
    const imported = await importAuthorizedFnosFiles(regularUser, "regular-member", [sourceFile]);
    assert.equal(imported.pageCount, 1);
    await assert.rejects(
      () => importAuthorizedFnosFiles(regularUser, "regular-member", [blockedFile]),
      (error: unknown) => (error as { statusCode?: number }).statusCode === 403
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    delete process.env.AUTH_MODE;
    delete process.env.TRIM_API_TOKEN;
    delete process.env.TRIM_OPEN_API_SOCKET;
    delete process.env.TRIM_DATA_ACCESSIBLE_PATHS;
    rmSync(testRoot, { recursive: true, force: true });
  }
});
