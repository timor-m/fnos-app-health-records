import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { closeDatabaseForTests, getDatabase } from '../database/client';
import { schemaSql } from '../database/schema';
import { healthRecordEntries } from '../services/health-record-feed.service';
import { assertMemberAccess, assertMemberManage } from '../services/member.service';
import { listReminders } from '../services/records.service';

function fixture(run: (root: string, path: string) => void) {
  const previous = process.env.STORAGE_DIR;
  const root = mkdtempSync(join(tmpdir(), 'database-upgrade-safety-'));
  const path = join(root, 'db', 'health-records.sqlite');
  process.env.STORAGE_DIR = root;
  mkdirSync(join(root, 'db'));
  const old = new DatabaseSync(path);
  try {
    old.exec(readFileSync(new URL('./fixtures/0.2.15-schema.sql', import.meta.url), 'utf8'));
    old.exec(`
      INSERT INTO users(id,display_name) VALUES('synthetic','Synthetic');
      INSERT INTO health_members(id,display_name,created_by) VALUES('synthetic','Synthetic','synthetic');
      INSERT INTO reports(id,member_id,created_by,title,report_type,status)
        VALUES('synthetic','synthetic','synthetic','Synthetic','laboratory','ready');
      INSERT INTO app_settings(setting_key,value_json) VALUES('system.last_app_version','"0.2.15"');
    `);
  } finally { old.close(); }
  try { run(root, path); }
  finally {
    closeDatabaseForTests();
    if (previous === undefined) delete process.env.STORAGE_DIR;
    else process.env.STORAGE_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
}

function assertBaseline(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    assert.ok(db.prepare("SELECT 1 FROM reports WHERE id='synthetic'").get());
    assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='health_events'").get(), undefined);
    assert.equal(db.prepare('PRAGMA table_info(health_members)').all().some(row => row.name === 'care_history'), false);
    assert.equal(db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()!.version, 19);
    assert.equal(db.prepare("SELECT value_json FROM app_settings WHERE setting_key='system.last_app_version'").get()!.value_json, '"0.2.15"');
    assert.equal(db.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok');
  } finally { db.close(); }
}

function snapshots(root: string) {
  const dir = join(root, 'backups', 'db');
  return readdirSync(dir).map(name => join(dir, name));
}

test('direct upgrade preserves all old columns, original files, clinical facts, permissions and queued jobs', () => fixture((root, path) => {
  const old = new DatabaseSync(path);
  old.exec(`
    INSERT INTO users(id,display_name) VALUES('synthetic-viewer','Synthetic viewer');
    INSERT INTO member_permissions(member_id,user_id,permission,granted_by)
      VALUES('synthetic','synthetic','manager','synthetic'),('synthetic','synthetic-viewer','viewer','synthetic');
    INSERT INTO reports(id,member_id,created_by,title,report_type,status) VALUES
      ('synthetic-rx','synthetic','synthetic','Synthetic prescription','prescription','ready'),
      ('synthetic-vax','synthetic','synthetic','Synthetic vaccination','vaccination','ready');
    INSERT INTO report_medications(id,report_id,medication_name,source,manual_fields_json)
      VALUES('synthetic-rx-item','synthetic-rx','Synthetic medication','manual','["*"]');
    INSERT INTO vaccination_records(id,report_id,vaccine_name,source)
      VALUES('synthetic-vax-item','synthetic-vax','Synthetic vaccine','manual');
    INSERT INTO observations(id,report_id,item_name,result_text,numeric_value)
      VALUES('synthetic-observation','synthetic','Synthetic metric','1',1);
    INSERT INTO processing_jobs(id,report_id,job_type,status,pipeline_version,deduplication_key)
      VALUES('synthetic-job','synthetic','ai_extract','queued','synthetic','synthetic');
    INSERT INTO reminders(id,member_id,report_id,title,due_at,source,created_by)
      VALUES('synthetic-reminder','synthetic','synthetic','Synthetic reminder','2026-12-01','report_suggestion','synthetic');
  `);
  const tables = old.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
  const baseline = tables.map(({ name }) => {
    const columns = old.prepare(`PRAGMA table_info("${name}")`).all().map(row => `"${row.name}"`).join(',');
    return { name, columns, rows: old.prepare(`SELECT ${columns} FROM "${name}" ORDER BY rowid`).all() };
  });
  old.close();
  mkdirSync(join(root, 'reports'));
  const original = join(root, 'reports', 'synthetic.bin');
  writeFileSync(original, 'Synthetic original only');
  const bytes = readFileSync(original);
  const db = getDatabase();
  for (const table of baseline) {
    if (table.name === 'app_settings' || table.name === 'app_upgrade_history') continue;
    assert.deepEqual(db.prepare(`SELECT ${table.columns} FROM "${table.name}" ORDER BY rowid`).all(), table.rows, String(table.name));
  }
  assert.deepEqual(readFileSync(original), bytes);
  const owner = { id: 'synthetic', displayName: 'Synthetic', provider: 'development' as const, authenticated: true, isGatewayAdmin: false };
  const viewer = { ...owner, id: 'synthetic-viewer' };
  assert.equal(assertMemberAccess(viewer, 'synthetic'), 'viewer');
  assert.throws(() => assertMemberManage(viewer, 'synthetic'));
  assert.equal(healthRecordEntries(owner, { memberId: 'synthetic' }).length, 3);
  assert.deepEqual(listReminders(owner, 'synthetic')[0].relatedRecord, { kind: 'report', id: 'synthetic' });
}));

test('same-second failed upgrade retries preserve distinct pristine pre-upgrade snapshots', context => fixture((root, path) => {
  context.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-01-01T00:00:00Z') });
  const exec = DatabaseSync.prototype.exec;
  DatabaseSync.prototype.exec = function(sql) {
    const result = exec.call(this, sql);
    if (sql === schemaSql) throw new Error('Synthetic interruption after DDL');
    return result;
  };
  try {
    assert.throws(() => getDatabase(), /Synthetic interruption/);
    const [first] = snapshots(root);
    const hash = createHash('sha256').update(readFileSync(first)).digest('hex');
    assertBaseline(path);
    assert.throws(() => getDatabase(), /Synthetic interruption/);
    assert.equal(snapshots(root).length, 2);
    assert.equal(createHash('sha256').update(readFileSync(first)).digest('hex'), hash);
    for (const backup of snapshots(root)) assertBaseline(backup);
  } finally {
    DatabaseSync.prototype.exec = exec;
    context.mock.timers.reset();
  }
  assert.ok(getDatabase().prepare("SELECT 1 FROM sqlite_master WHERE name='health_record_links'").get());
  assert.equal(getDatabase().prepare('PRAGMA foreign_key_check').all().length, 0);
  const count = snapshots(root).length;
  closeDatabaseForTests();
  getDatabase();
  assert.equal(snapshots(root).length, count);
}));

test('failed online snapshot cannot fall back to copying the database and proceeding with upgrade', () => fixture((root, path) => {
  const exec = DatabaseSync.prototype.exec;
  DatabaseSync.prototype.exec = function(sql) {
    if (sql.startsWith('VACUUM INTO ')) throw new Error('Synthetic snapshot failure');
    return exec.call(this, sql);
  };
  try { assert.throws(() => getDatabase(), /Synthetic snapshot failure/); }
  finally { DatabaseSync.prototype.exec = exec; }
  assertBaseline(path);
  assert.deepEqual(snapshots(root), []);
  getDatabase();
  assert.equal(snapshots(root).length, 1);
}));

test('late additive-field failure rolls back all new tables, fields and the app version', () => fixture((_root, path) => {
  const exec = DatabaseSync.prototype.exec;
  DatabaseSync.prototype.exec = function(sql) {
    const result = exec.call(this, sql);
    if (sql === 'ALTER TABLE health_members ADD COLUMN care_medications TEXT') throw new Error('Synthetic late upgrade failure');
    return result;
  };
  try { assert.throws(() => getDatabase(), /Synthetic late upgrade failure/); }
  finally { DatabaseSync.prototype.exec = exec; }
  assertBaseline(path);
  const db = getDatabase();
  assert.ok(db.prepare('PRAGMA table_info(health_members)').all().some(row => row.name === 'care_history'));
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
}));

test('SQLite disk-full during upgrade leaves the baseline intact and permits a later retry', () => fixture((root, path) => {
  const exec = DatabaseSync.prototype.exec;
  DatabaseSync.prototype.exec = function(sql) {
    const result = exec.call(this, sql);
    if (sql === 'PRAGMA busy_timeout = 5000') {
      const pages = Number(this.prepare('PRAGMA page_count').get()!.page_count);
      exec.call(this, `PRAGMA max_page_count=${pages + 10}`);
    }
    return result;
  };
  try { assert.throws(() => getDatabase(), /database or disk is full/); }
  finally { DatabaseSync.prototype.exec = exec; }
  assertBaseline(path);
  assert.equal(snapshots(root).length, 1);
  assertBaseline(snapshots(root)[0]);
  getDatabase();
  assert.equal(getDatabase().prepare('PRAGMA foreign_key_check').all().length, 0);
}));

test('an integrity failure prevents the upgraded structure and completion marker from committing', () => fixture((_root, path) => {
  const exec = DatabaseSync.prototype.exec;
  DatabaseSync.prototype.exec = function(sql) {
    const result = exec.call(this, sql);
    if (sql === schemaSql) exec.call(this, `
      PRAGMA defer_foreign_keys=ON;
      INSERT INTO health_record_processes(id,member_id) VALUES('synthetic-invalid','missing-member');
    `);
    return result;
  };
  try { assert.throws(() => getDatabase(), /Database upgrade integrity check failed/); }
  finally { DatabaseSync.prototype.exec = exec; }
  assertBaseline(path);
  getDatabase();
  assert.equal(getDatabase().prepare('PRAGMA foreign_key_check').all().length, 0);
}));

test('a process killed after DDL recovers the unchanged old database before retrying upgrade', () => fixture((root, path) => {
  const script = join(root, 'interrupted.mjs');
  writeFileSync(script, `
    import { DatabaseSync } from 'node:sqlite';
    import { getDatabase } from ${JSON.stringify(new URL('../database/client.ts', import.meta.url).href)};
    import { schemaSql } from ${JSON.stringify(new URL('../database/schema.ts', import.meta.url).href)};
    const exec = DatabaseSync.prototype.exec;
    DatabaseSync.prototype.exec = function(sql) {
      const result = exec.call(this, sql);
      if (sql === schemaSql) process.kill(process.pid, 'SIGKILL');
      return result;
    };
    getDatabase();
  `);
  const child = spawnSync(process.execPath, ['--import', 'tsx', script], {
    env: { ...process.env, STORAGE_DIR: root }, encoding: 'utf8', timeout: 30_000
  });
  assert.equal(child.signal, 'SIGKILL', child.stderr);
  assertBaseline(path);
  assertBaseline(snapshots(root)[0]);
  getDatabase();
  assert.equal(getDatabase().prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok');
  assert.equal(getDatabase().prepare('PRAGMA foreign_key_check').all().length, 0);
}));
