import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getDatabase, closeDatabaseForTests } from "../database/client.ts";

test("v17 rule migration preserves manual associations and defaults to disabled", () => {
  const dir = mkdtempSync(join(tmpdir(), 'institution-v17-upgrade-'));
  process.env.STORAGE_DIR = dir;
  try {
    const db = getDatabase();
    db.exec(`DROP TABLE institution_trend_auto_decisions; DROP TABLE institution_trend_auto_rules;
      DELETE FROM schema_migrations WHERE version = 18;
      INSERT INTO users(id,display_name) VALUES ('u','fixture');
      INSERT INTO health_members(id,display_name,created_by) VALUES ('m','fixture','u');
      INSERT INTO institution_trend_projects(id,member_id,hospital_name,name,method,specimen,unit)
        VALUES ('p','m','fixture','fixture','fixture','fixture','U/L');`);
    closeDatabaseForTests();
    const upgraded = getDatabase();
    assert.ok(upgraded.prepare("SELECT id FROM institution_trend_projects WHERE id = 'p'").get());
    assert.equal((upgraded.prepare('SELECT COUNT(*) AS n FROM institution_trend_auto_rules').get() as {n:number}).n,0);
    assert.ok(readdirSync(join(dir,'backups','db')).some(name => name.includes('v17-to-v18')));
  } finally { closeDatabaseForTests(); delete process.env.STORAGE_DIR; rmSync(dir,{recursive:true,force:true}); }
});


test("v16 upgrades with backup and preserves existing rows; latest schema reopens normally", () => {
  const dir = mkdtempSync(join(tmpdir(), "institution-upgrade-"));
  process.env.STORAGE_DIR = dir;
  try {
    const db = getDatabase();
    db.exec(`DROP TABLE institution_trend_auto_rules; DROP TABLE institution_trend_auto_decisions;
      DROP TABLE institution_trend_observations; DROP TABLE institution_trend_projects;
      DELETE FROM schema_migrations WHERE version >= 17;
      INSERT INTO users (id, display_name) VALUES ('keep', 'fixture');`);
    closeDatabaseForTests();
    const upgraded = getDatabase();
    assert.ok(upgraded.prepare("SELECT id FROM users WHERE id = 'keep'").get());
    assert.ok(upgraded.prepare("SELECT name FROM sqlite_master WHERE name = 'institution_trend_projects'").get());
    assert.equal((upgraded.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as { v: number }).v, 18);
    assert.ok(readdirSync(join(dir, 'backups', 'db')).some(name => name.includes('v16-to-v18')));
    closeDatabaseForTests();
    assert.ok(getDatabase().prepare("SELECT id FROM users WHERE id = 'keep'").get());
  } finally {
    closeDatabaseForTests(); delete process.env.STORAGE_DIR; rmSync(dir, { recursive: true, force: true });
  }
});
