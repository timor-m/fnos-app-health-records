import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { closeDatabaseForTests, getDatabase, getDatabasePath, getUnreleasedSchemaMaintenance, repairUnreleasedSchemaVersions } from "../database/client.ts";
import type { RequestUser } from "../domain/request-user.ts";
import { claimNextJob, isReportJobActive, processNextJob } from "../services/job-runner.service.ts";
import { createMember } from "../services/member.service.ts";
import type { WorkerResponse } from "../services/ocr-worker-client.ts";
import { getReportNoteImage, getStagedNoteImage, saveReportNote, stageReportNoteImage } from "../services/report-note.service.ts";
import { createUpload } from "../services/upload.service.ts";
import { syncBuiltinTrendGroups } from "../services/trend-groups.service.ts";
import { toApiErrorPayload } from "../utils/api-error.ts";
import { createId } from "../utils/identifier.ts";
import { writeLog } from "../utils/logger.ts";

const manager: RequestUser = {
  id: "recovery-manager", displayName: "fixture", provider: "development",
  authenticated: true, isGatewayAdmin: true
};
const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);

async function withDatabase(run: (root: string) => void | Promise<void>) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "service-failure-recovery-")));
  const previous = {
    STORAGE_DIR: process.env.STORAGE_DIR,
    LOG_DIR: process.env.LOG_DIR,
    PROCESSING_JOB_LEASE_HEARTBEAT_INTERVAL_MS: process.env.PROCESSING_JOB_LEASE_HEARTBEAT_INTERVAL_MS
  };
  process.env.STORAGE_DIR = root;
  process.env.LOG_DIR = join(root, "logs");
  process.env.PROCESSING_JOB_LEASE_HEARTBEAT_INTERVAL_MS = "25";
  try {
    const db = getDatabase();
    db.exec(`
      INSERT INTO users(id, display_name, is_gateway_admin) VALUES ('recovery-manager', 'fixture', 1);
      INSERT INTO health_members(id, display_name, created_by) VALUES ('recovery-member', 'fixture', 'recovery-manager');
      INSERT INTO member_permissions(member_id, user_id, permission, granted_by)
        VALUES ('recovery-member', 'recovery-manager', 'manager', 'recovery-manager');
      INSERT INTO reports(id, member_id, created_by, report_type, title, status)
        VALUES ('recovery-report', 'recovery-member', 'recovery-manager', 'other', 'fixture', 'ready');
    `);
    await run(root);
  } finally {
    closeDatabaseForTests();
    // Wait for any heartbeat warning to finish before removing its temporary log directory.
    await writeLog("info", "recovery-test-finished");
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
}

test("retries initialization after a migration backup failure without exposing a partial schema", async () => withDatabase(root => {
  getDatabase().exec("DROP TABLE upload_receipts");
  closeDatabaseForTests();
  const obstruction = join(root, "backups", "db");
  writeFileSync(obstruction, "fixture");
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.throws(() => getDatabase(), (error: unknown) => (error as NodeJS.ErrnoException).code === "EEXIST");
  }
  rmSync(obstruction);
  const recovered = getDatabase();
  assert.ok(recovered.prepare("SELECT name FROM sqlite_master WHERE name = 'upload_receipts'").get());
  assert.equal(recovered.prepare("SELECT COUNT(*) AS n FROM reports").get()?.n, 1);
  assert.equal(recovered.prepare("PRAGMA foreign_keys").get()?.foreign_keys, 1);
  assert.equal(recovered.prepare("PRAGMA journal_mode").get()?.journal_mode, "wal");
  assert.ok(readdirSync(obstruction).some(name => name.endsWith(".sqlite")));
  assert.equal(getDatabase(), recovered);
}));

test("never reuses a connection rejected for an unsupported schema version", async () => withDatabase(() => {
  const db = getDatabase();
  db.exec("INSERT INTO schema_migrations(version) VALUES (999)");
  closeDatabaseForTests();
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.throws(() => getDatabase(), /newer than this app supports/);
  }
}));

test("closes an explicitly repaired connection when migration fails and safely reopens after recovery", async () => withDatabase(() => {
  const db = getDatabase();
  db.exec(`UPDATE schema_migrations SET checksum = '' WHERE version = 17;
    INSERT INTO schema_migrations(version) VALUES (19);
    CREATE TRIGGER fail_migration BEFORE INSERT ON schema_migrations WHEN NEW.version = 17
    BEGIN SELECT RAISE(ABORT, 'fixture migration failure'); END`);
  closeDatabaseForTests();
  getDatabase();
  assert.equal(getUnreleasedSchemaMaintenance()?.databaseVersion, 19);
  assert.throws(() => repairUnreleasedSchemaVersions(), /fixture migration failure/);
  assert.throws(() => getDatabase(), /fixture migration failure/);
  const repair = new DatabaseSync(getDatabasePath());
  try { repair.exec("DROP TRIGGER fail_migration"); } finally { repair.close(); }
  const recovered = getDatabase();
  assert.equal(getUnreleasedSchemaMaintenance(), null);
  assert.equal(recovered.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()?.version, 17);
  assert.equal(recovered.prepare("SELECT COUNT(*) AS n FROM reports").get()?.n, 1);
}));

test("preserves an automatic rollback error and leaves member creation atomic and retryable", async () => withDatabase(() => {
  const db = getDatabase();
  db.exec(`CREATE TRIGGER fail_permission BEFORE INSERT ON member_permissions
    BEGIN SELECT RAISE(ROLLBACK, 'fixture permission failure'); END`);
  const input = { displayName: "fixture", relationship: "other" };
  assert.throws(() => createMember(manager, input), /fixture permission failure/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM health_members").get()?.n, 1);
  db.exec("DROP TRIGGER fail_permission");
  const created = createMember(manager, input);
  assert.ok(db.prepare("SELECT id FROM health_members WHERE id = ?").get(created.id));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM member_permissions").get()?.n, 2);
}));

for (const failure of ["ABORT", "ROLLBACK"]) {
  test(`trend group savepoint preserves the ${failure} error and the enclosing transaction semantics`, async () => withDatabase(() => {
    const db = getDatabase();
    db.exec(`INSERT INTO indicator_groups(id, group_key, display_name) VALUES ('fixture-group', 'fixture-group', 'fixture');
      CREATE TRIGGER fail_group BEFORE UPDATE OF enabled ON indicator_groups
      BEGIN SELECT RAISE(${failure}, 'fixture group failure'); END;
      BEGIN IMMEDIATE;
      UPDATE reports SET title = 'transaction-fixture' WHERE id = 'recovery-report';`);
    assert.throws(() => syncBuiltinTrendGroups(db), /fixture group failure/);
    if (failure === "ABORT") db.exec("COMMIT");
    assert.equal(db.prepare("SELECT title FROM reports WHERE id = 'recovery-report'").get()?.title,
      failure === "ABORT" ? "transaction-fixture" : "fixture");
    assert.equal(db.prepare("SELECT enabled FROM indicator_groups WHERE id = 'fixture-group'").get()?.enabled, 1);
    db.exec("DROP TRIGGER fail_group; BEGIN IMMEDIATE");
    syncBuiltinTrendGroups(db);
    db.exec("COMMIT");
    assert.equal(db.prepare("SELECT enabled FROM indicator_groups WHERE id = 'fixture-group'").get()?.enabled, 0);
  }));
}

test("keeps SQLITE_FULL, cleans copied note images, and saves the same input after capacity recovers", async () => withDatabase(async root => {
  const db = getDatabase();
  const existing = saveReportNote(manager, "recovery-report", { contentText: "fixture", assets: [] });
  const staged = await stageReportNoteImage(manager, "recovery-report", { originalName: "fixture.png", data: png }, async request => {
    writeFileSync(request.outputPath!, Uint8Array.from([255, 216, 255, 217]));
    return { ok: true, width: 1, height: 1 };
  });
  db.exec("CREATE TABLE capacity_fixture(payload BLOB)");
  const maximum = db.prepare("PRAGMA max_page_count").get()!.max_page_count;
  const pages = db.prepare("PRAGMA page_count").get()!.page_count;
  db.exec(`PRAGMA max_page_count = ${pages}`);
  const isFull = (error: unknown) => (error as { errcode?: number }).errcode === 13;
  assert.throws(() => {
    for (let count = 0; count < 10_000; count++) db.exec("INSERT INTO capacity_fixture VALUES (zeroblob(3000))");
  }, isFull);
  const input = { id: createId("note"), contentText: "x".repeat(10_000), assets: [{ uploadToken: staged.uploadToken }] };
  assert.throws(() => saveReportNote(manager, "recovery-report", input), (error: unknown) => {
    assert.ok(isFull(error));
    assert.equal(toApiErrorPayload(error).code, "STORAGE_UNAVAILABLE");
    assert.equal(toApiErrorPayload(error).status, 503);
    return true;
  });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM report_notes").get()?.n, 1);
  assert.equal(db.prepare("SELECT content_text AS text FROM report_notes WHERE id = ?").get(existing.id)?.text, "fixture");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM report_note_assets").get()?.n, 0);
  assert.equal(readdirSync(join(root, "report-notes"), { recursive: true, withFileTypes: true }).filter(entry => entry.isFile()).length, 0);
  assert.ok(existsSync(getStagedNoteImage(manager, "recovery-report", staged.uploadToken).path));
  db.exec(`PRAGMA max_page_count = ${maximum}`);
  const saved = saveReportNote(manager, "recovery-report", input);
  assert.equal(saved.assets.length, 1);
  assert.deepEqual(saveReportNote(manager, "recovery-report", input), saved);
}));

test("a read failure after note commit preserves saved images and allows an idempotent retry", async context => withDatabase(async () => {
  const staged = await stageReportNoteImage(manager, "recovery-report", { originalName: "fixture.png", data: png }, async request => {
    writeFileSync(request.outputPath!, Uint8Array.from([255, 216, 255, 217]));
    return { ok: true, width: 1, height: 1 };
  });
  const input = { id: createId("note"), contentText: "fixture", assets: [{ uploadToken: staged.uploadToken }] };
  const db = getDatabase();
  const prepare = db.prepare.bind(db);
  const readFailure = new Error("fixture post-commit read failure");
  const mocked = context.mock.method(db, "prepare", (sql: string) => {
    if (sql.includes("SELECT id, content_text AS contentText")) throw readFailure;
    return prepare(sql);
  });
  try {
    assert.throws(() => saveReportNote(manager, "recovery-report", input), error => error === readFailure);
  } finally { mocked.mock.restore(); }
  const saved = saveReportNote(manager, "recovery-report", input);
  const image = getReportNoteImage(manager, "recovery-report", saved.id, saved.assets[0].id, "original");
  assert.ok(existsSync(image.path));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM report_notes").get()?.n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM report_note_assets").get()?.n, 1);
}));

for (const recoverBeforeCompletion of [true, false]) {
  test(`lease write failure stays contained when storage recovers ${recoverBeforeCompletion ? "during" : "after"} the job`, async context => withDatabase(async () => {
    const db = getDatabase();
    const upload = createUpload(manager, "recovery-member", [{ originalName: "fixture.png", data: png }]);
    db.prepare("UPDATE processing_jobs SET status = 'cancelled' WHERE report_id = ? AND job_type = 'ocr'").run(upload.reportId);
    let release!: (response: WorkerResponse) => void;
    const response = new Promise<WorkerResponse>(resolve => { release = resolve; });
    context.mock.timers.enable({ apis: ["setInterval"] });
    const running = processNextJob(async () => response);
    const outcome = running.then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
    try {
      const job = db.prepare("SELECT id FROM processing_jobs WHERE report_id = ? AND job_type = 'thumbnail'").get(upload.reportId)!;
      db.prepare("UPDATE processing_jobs SET lease_expires_at = datetime('now', '-1 minute') WHERE id = ?").run(job.id);
      db.exec("PRAGMA query_only = ON");
      assert.doesNotThrow(() => context.mock.timers.tick(25));
      assert.doesNotThrow(() => context.mock.timers.tick(25));
      assert.equal(isReportJobActive(upload.reportId), true);
      assert.equal(db.prepare("SELECT status FROM processing_jobs WHERE id = ?").get(job.id)?.status, "processing");
      if (recoverBeforeCompletion) {
        db.exec("PRAGMA query_only = OFF");
        context.mock.timers.tick(25);
        assert.equal(db.prepare("SELECT lease_expires_at > CURRENT_TIMESTAMP AS fresh FROM processing_jobs WHERE id = ?").get(job.id)?.fresh, 1);
        assert.equal(claimNextJob(), null);
      }
      release({ ok: true, width: 1, height: 1 });
      const result = await outcome;
      assert.equal(isReportJobActive(upload.reportId), false);
      if (recoverBeforeCompletion) {
        assert.equal(result.value, true);
      } else {
        assert.ok(result.error);
        assert.equal(toApiErrorPayload(result.error).code, "DATABASE_UNAVAILABLE");
        db.exec("PRAGMA query_only = OFF");
        assert.equal(await processNextJob(async () => ({ ok: true, width: 1, height: 1 })), true);
      }
      const completed = db.prepare("SELECT status, attempts FROM processing_jobs WHERE id = ?").get(job.id)!;
      assert.equal(completed.status, "completed");
      assert.equal(completed.attempts, recoverBeforeCompletion ? 1 : 2);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM report_pages WHERE report_id = ?").get(upload.reportId)?.n, 1);
      // Completing/failing the worker must also stop its heartbeat.
      db.exec("PRAGMA query_only = ON");
      assert.doesNotThrow(() => context.mock.timers.tick(100));
    } finally {
      db.exec("PRAGMA query_only = OFF");
      release({ ok: true, width: 1, height: 1 });
      await outcome;
      context.mock.timers.reset();
    }
  }));
}
