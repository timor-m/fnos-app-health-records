import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { getDatabase, closeDatabaseForTests, getDatabaseStatus } from '../database/client';
import { needsReportCombinationDraft } from '../database/report-combination-draft';
test('undo journal is additive, backed up before completion, and preserves v19 data across repeated startup', () => {
    const root = mkdtempSync(join(tmpdir(), 'report-combination-schema-')), previous = process.env.STORAGE_DIR;
    process.env.STORAGE_DIR = root;
    try {
        let db = getDatabase();
        assert.equal(needsReportCombinationDraft(db), false);
        assert.equal(getDatabaseStatus().appliedSchemaVersion, 19);
        db.exec("INSERT INTO users(id,display_name) VALUES('synthetic-owner','合成管理员'); INSERT INTO health_members(id,display_name,created_by) VALUES('synthetic-member','合成档案','synthetic-owner'); INSERT INTO reports(id,member_id,created_by,title,report_type,status) VALUES('synthetic-source','synthetic-member','synthetic-owner','合成报告','laboratory','ready'),('synthetic-target','synthetic-member','synthetic-owner','合成报告','laboratory','ready')");
        const migrations = db.prepare('SELECT * FROM schema_migrations ORDER BY version').all();
        // This is the previous release's table set: only the independent new journal is absent.
        db.exec('DROP TABLE report_combinations');
        closeDatabaseForTests();
        db = getDatabase();
        assert.equal(needsReportCombinationDraft(db), false);
        assert.deepEqual(db.prepare('SELECT * FROM schema_migrations ORDER BY version').all(), migrations);
        assert.equal(db.prepare('SELECT COUNT(*) n FROM reports').get()?.n, 2);
        const backups = readdirSync(join(root, 'backups', 'db'));
        assert.ok(backups.length > 0);
        const old = new DatabaseSync(join(root, 'backups', 'db', backups[0]), { readOnly: true });
        assert.equal(old.prepare("SELECT 1 FROM sqlite_master WHERE name='report_combinations'").get(), undefined);
        assert.equal(old.prepare('SELECT COUNT(*) n FROM reports').get()?.n, 2);
        old.close();
        db.exec("INSERT INTO report_combinations(id,target_report_id,source_report_id,before_json,after_fingerprint) VALUES('synthetic-journal','synthetic-target','synthetic-source','{}','synthetic')");
        closeDatabaseForTests();
        db = getDatabase();
        assert.equal(db.prepare('SELECT id FROM report_combinations').get()?.id, 'synthetic-journal');
        assert.equal(readdirSync(join(root, 'backups', 'db')).length, backups.length);
        assert.equal(getDatabaseStatus().appliedSchemaVersion, 19);
        // The old application's report writes and foreign-key cleanup still work.
        db.exec("UPDATE reports SET title='合成旧版校对' WHERE id='synthetic-target'; DELETE FROM reports WHERE id='synthetic-source'");
        assert.equal(db.prepare('SELECT COUNT(*) n FROM report_combinations').get()?.n, 0);
        assert.equal(db.prepare('PRAGMA foreign_key_check').get(), undefined);
    }
    finally {
        closeDatabaseForTests();
        if (previous === undefined)
            delete process.env.STORAGE_DIR;
        else
            process.env.STORAGE_DIR = previous;
        rmSync(root, { recursive: true, force: true });
    }
});
test('an incompatible journal fails startup without deleting existing reports', () => {
    const root = mkdtempSync(join(tmpdir(), 'report-combination-invalid-schema-')), previous = process.env.STORAGE_DIR;
    process.env.STORAGE_DIR = root;
    try {
        const db = getDatabase();
        db.exec("INSERT INTO users(id,display_name) VALUES('synthetic-owner','合成管理员'); INSERT INTO health_members(id,display_name,created_by) VALUES('synthetic-member','合成档案','synthetic-owner'); INSERT INTO reports(id,member_id,created_by,title,report_type) VALUES('synthetic-report','synthetic-member','synthetic-owner','合成报告','laboratory'); DROP TABLE report_combinations; CREATE TABLE report_combinations(id TEXT PRIMARY KEY)");
        closeDatabaseForTests();
        assert.throws(() => getDatabase(), /column|structure/i);
        closeDatabaseForTests();
        const preserved = new DatabaseSync(join(root, 'db', 'health-records.sqlite'), { readOnly: true });
        assert.equal(preserved.prepare('SELECT title FROM reports WHERE id=?').get('synthetic-report')?.title, '合成报告');
        preserved.close();
        assert.ok(readdirSync(join(root, 'backups', 'db')).length > 0);
    }
    finally {
        closeDatabaseForTests();
        if (previous === undefined)
            delete process.env.STORAGE_DIR;
        else
            process.env.STORAGE_DIR = previous;
        rmSync(root, { recursive: true, force: true });
    }
});
test('missing-journal completion cannot proceed if its safety backup fails', () => {
    const root = mkdtempSync(join(tmpdir(), 'report-combination-backup-failure-')), previous = process.env.STORAGE_DIR;
    process.env.STORAGE_DIR = root;
    try {
        const db = getDatabase();
        db.exec('DROP TABLE report_combinations');
        closeDatabaseForTests();
        writeFileSync(join(root, 'backups', 'db'), 'synthetic-backup-path-conflict');
        assert.throws(() => getDatabase(), /EEXIST|ENOTDIR/);
        closeDatabaseForTests();
        const original = new DatabaseSync(join(root, 'db', 'health-records.sqlite'), { readOnly: true });
        assert.equal(original.prepare("SELECT 1 FROM sqlite_master WHERE name='report_combinations'").get(), undefined);
        assert.equal(original.prepare('SELECT MAX(version) v FROM schema_migrations').get()?.v, 19);
        original.close();
    }
    finally {
        closeDatabaseForTests();
        if (previous === undefined)
            delete process.env.STORAGE_DIR;
        else
            process.env.STORAGE_DIR = previous;
        rmSync(root, { recursive: true, force: true });
    }
});
