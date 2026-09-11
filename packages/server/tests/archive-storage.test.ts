import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync, renameSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { archiveIdentityFile, archiveLocationFile, resolveArchiveLocation } from '../utils/archive-storage';
import { getAppConfig } from '../utils/runtime-config';
import { getArchiveStorageStatus } from '../services/archive-storage.service';
import { closeDatabaseForTests, getDatabase } from '../database/client';

test('archive inspection preserves legacy roots and does not initialize directories', async () => {
  const root = mkdtempSync(join(tmpdir(), 'archive-legacy-'));
  const old = { STORAGE_DIR: process.env.STORAGE_DIR, NODE_ENV: process.env.NODE_ENV };
  try {
    process.env.STORAGE_DIR = root;
    process.env.NODE_ENV = 'development';
    const config = getAppConfig();
    assert.equal(config.storageDir, root);
    assert.equal(config.runtimeDir, root);
    assert.equal(config.ocrPythonBin, process.env.OCR_PYTHON_BIN || join(root, 'ocr-venv/bin/python'));
    const status = await getArchiveStorageStatus({ id: 'test', displayName: '测试', provider: 'development', authenticated: true, isAdmin: true, isGatewayAdmin: true });
    assert.equal(status.storageDir, root);
    assert.equal(status.state, 'ready');
    assert.deepEqual(readdirSync(root), []);
    assert.equal(resolveArchiveLocation(join(root, 'missing'), true).storageDir, join(root, 'missing'));
    assert.deepEqual(readdirSync(root), []);
    await assert.rejects(getArchiveStorageStatus({ id: 'test', displayName: '测试', provider: 'development', authenticated: true, isAdmin: false, isGatewayAdmin: false }));
  } finally {
    for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(root, { recursive: true, force: true });
  }
});

test('configured archive identity and missing disks fail closed without changing OCR paths', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'archive-identity-')));
  const runtime = join(root, 'runtime');
  const archive = join(root, 'raid');
  const archiveId = '11111111-1111-4111-8111-111111111111';
  const old = { STORAGE_DIR: process.env.STORAGE_DIR, NODE_ENV: process.env.NODE_ENV };
  try {
    mkdirSync(join(runtime, 'config'), { recursive: true });
    mkdirSync(join(archive, 'db'), { recursive: true });
    const db = new DatabaseSync(join(archive, 'db/health-records.sqlite'));
    db.exec('CREATE TABLE synthetic (id INTEGER PRIMARY KEY)');
    db.close();
    writeFileSync(join(archive, archiveIdentityFile), JSON.stringify({ version: 1, archiveId }));
    const configPath = join(runtime, 'config', archiveLocationFile);
    writeFileSync(configPath, JSON.stringify({ version: 1, archiveId, path: archive }));
    assert.equal(resolveArchiveLocation(runtime, true).storageDir, archive);
    assert.equal(resolveArchiveLocation(runtime, true).error, null);
    assert.equal(resolveArchiveLocation(runtime, false).storageDir, runtime);
    process.env.STORAGE_DIR = runtime;
    process.env.NODE_ENV = 'development';
    assert.equal(getAppConfig().storageDir, archive);
    assert.equal(getAppConfig().runtimeDir, runtime);
    assert.equal(getAppConfig().ocrPythonBin, process.env.OCR_PYTHON_BIN || join(runtime, 'ocr-venv/bin/python'));
    renameSync(archive, join(root, 'offline'));
    assert.ok(resolveArchiveLocation(runtime, true).error);
    assert.throws(() => getDatabase());
    assert.deepEqual(readdirSync(runtime), ['config']);
    assert.equal(readdirSync(root).includes('raid'), false);
    mkdirSync(archive);
    assert.ok(resolveArchiveLocation(runtime, true).error);
    assert.throws(() => getDatabase());
    assert.deepEqual(readdirSync(archive), []);
    symlinkSync(join(root, 'offline/db'), join(archive, 'db'));
    writeFileSync(join(archive, archiveIdentityFile), JSON.stringify({ version: 1, archiveId: 'other' }));
    assert.ok(resolveArchiveLocation(runtime, true).error);
    writeFileSync(configPath, '{broken');
    assert.ok(resolveArchiveLocation(runtime, true).error);
    assert.throws(() => getDatabase());
  } finally {
    closeDatabaseForTests();
    for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(root, { recursive: true, force: true });
  }
});

test('a changed archive cannot reuse the old database connection before an explicit close', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'archive-switch-')));
  const old = { STORAGE_DIR: process.env.STORAGE_DIR, NODE_ENV: process.env.NODE_ENV };
  const runtime = join(root, 'runtime');
  const archive = join(root, 'archive');
  const archiveId = '11111111-1111-4111-8111-111111111111';
  try {
    process.env.NODE_ENV = 'development';
    for (const [dir, label] of [[runtime, 'old'], [archive, 'new']]) {
      process.env.STORAGE_DIR = dir;
      const db = getDatabase();
      db.exec('CREATE TABLE acceptance_probe (label TEXT)');
      db.prepare('INSERT INTO acceptance_probe VALUES (?)').run(label);
      closeDatabaseForTests();
    }
    process.env.STORAGE_DIR = runtime;
    getDatabase();
    writeFileSync(join(archive, archiveIdentityFile), JSON.stringify({ version: 1, archiveId }));
    writeFileSync(join(runtime, 'config', archiveLocationFile), JSON.stringify({ version: 1, archiveId, path: archive }));
    assert.equal(getAppConfig().storageDir, archive);
    assert.throws(() => getDatabase(), /安全切换/);
    closeDatabaseForTests();
    assert.equal(getDatabase().prepare('SELECT label FROM acceptance_probe').get()?.label, 'new');
  } finally {
    closeDatabaseForTests();
    for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(root, { recursive: true, force: true });
  }
});
