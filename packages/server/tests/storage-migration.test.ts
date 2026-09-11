import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { H3, type H3Event } from 'h3';
import { execFileSync } from 'node:child_process';
import { createBackup, restoreBackup } from '../services/records.service';
import { createUpload } from '../services/upload.service';
import { getArchiveStorageStatus } from '../services/archive-storage.service';
import storageHandler from '../middleware/00-archive-storage';
import { closeDatabase, getDatabase } from '../database/client';
import { getAppConfig } from '../utils/runtime-config';
import { listLocalImportRoots } from '../services/local-file-import.service';
import { startStorageMigration, waitForStorageMigration, getStorageMigration, cancelStorageMigration, resumeStorageMigration, previewStorageMigration, previewStorageCleanup, cleanupStorageSource } from '../services/storage-migration.service';
import { trackStorageRequest, finishStorageRequest, storageMigrationPaused, writeStorageMigration, atomicStorageJson } from '../utils/storage-migration-state';

async function fixture(run: (source: string, target: string, rootId: string) => Promise<void>) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'storage-migration-test-')));
  const source = join(base, 'source'), target = join(base, 'target');
  const previous = Object.fromEntries(['STORAGE_DIR', 'IMPORT_ROOTS', 'NODE_ENV', 'AUTH_MODE', 'DISABLE_JOB_RUNNER'].map(key => [key, process.env[key]]));
  closeDatabase();
  try {
    process.env.STORAGE_DIR = source; process.env.IMPORT_ROOTS = target;
    process.env.NODE_ENV = 'development'; delete process.env.AUTH_MODE;
    process.env.DISABLE_JOB_RUNNER = 'true';
    mkdirSync(target);
    getDatabase().exec('CREATE TABLE migration_probe (value TEXT); INSERT INTO migration_probe VALUES (\'synthetic\')');
    mkdirSync(join(source, 'reports'), { recursive: true });
    writeFileSync(join(source, 'reports', 'synthetic.txt'), 'synthetic content');
    mkdirSync(join(source, 'ocr-venv'), { recursive: true });
    writeFileSync(join(source, 'ocr-venv', 'keep-runtime.txt'), 'runtime');
    await run(source, target, listLocalImportRoots()[0].id);
  } finally {
    await waitForStorageMigration(); closeDatabase();
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(base, { recursive: true, force: true });
  }
}

test('migration drains requests, verifies copies, switches database and retains original/runtime', async () => {
  await fixture(async (source, _target, rootId) => {
    const request = {};
    trackStorageRequest(request);
    try {
      const preview = await previewStorageMigration(rootId);
      assert.ok(preview.files >= 2);
      await startStorageMigration(rootId);
      assert.equal(storageMigrationPaused(), true);
      assert.equal(getStorageMigration()?.phase, 'waiting');
      assert.equal(getAppConfig().storageDir, source);
    } finally { finishStorageRequest(request); }
    await waitForStorageMigration();
    const state = getStorageMigration()!;
    assert.equal(state.phase, 'completed', state.error || 'migration failed');
    assert.equal(basename(state.target), getAppConfig().appName);
    assert.equal(storageMigrationPaused(), false);
    assert.equal(getAppConfig().storageDir, state.target);
    assert.equal(getDatabase().prepare('SELECT value FROM migration_probe').get()?.value, 'synthetic');
    assert.equal(readFileSync(join(state.target, 'reports/synthetic.txt'), 'utf8'), 'synthetic content');
    assert.equal(existsSync(join(source, 'db/health-records.sqlite')), true);
    assert.equal(existsSync(join(source, 'ocr-venv/keep-runtime.txt')), true);
    assert.equal(existsSync(join(state.target, 'ocr-venv')), false);
    assert.equal(existsSync(join(state.target, 'config/archive-migration.json')), false);
    // Simulate interruption after pointer commit: newer target writes must survive resume.
    getDatabase().prepare('UPDATE migration_probe SET value = ?').run('new target value');
    closeDatabase();
    writeStorageMigration({ ...state, phase: 'switching' });
    assert.equal(storageMigrationPaused(), true);
    resumeStorageMigration(); await waitForStorageMigration();
    assert.equal(getStorageMigration()?.phase, 'completed');
    assert.equal(getDatabase().prepare('SELECT value FROM migration_probe').get()?.value, 'new target value');
    rmSync(join(source, 'config/archive-location.json'));
    assert.equal(storageMigrationPaused(), true, 'lost pointer must not reactivate stale source');
  });
});

test('fixed app directory never overwrites an existing directory or dangling link', async () => {
  await fixture(async (_source, target, rootId) => {
    const destination = join(target, getAppConfig().appName);
    mkdirSync(destination);
    writeFileSync(join(destination, 'keep.txt'), 'keep');
    await assert.rejects(startStorageMigration(rootId), /同名目录/);
    assert.equal(readFileSync(join(destination, 'keep.txt'), 'utf8'), 'keep');
    rmSync(destination, { recursive: true });
    symlinkSync(join(target, 'missing'), destination);
    await assert.rejects(previewStorageMigration(rootId), /同名目录/);
  });
});

test('legacy UUID directory journals still support recovery', async () => {
  await fixture(async (source, target, rootId) => {
    await startStorageMigration(rootId); await waitForStorageMigration();
    const state = getStorageMigration()!;
    assert.equal(state.phase, 'completed');
    closeDatabase();
    const legacy = join(target, `health-records-${state.id}`);
    renameSync(state.target, legacy);
    atomicStorageJson(join(source, 'config/archive-location.json'), { version: 1, path: legacy, archiveId: state.archiveId });
    writeStorageMigration({ ...state, target: legacy, phase: 'switching' });
    assert.equal(getStorageMigration()?.target, legacy);
    resumeStorageMigration(); await waitForStorageMigration();
    assert.equal(getStorageMigration()?.phase, 'completed');
    assert.equal(getAppConfig().storageDir, legacy);
  });
});

test('cancelling while draining retains the source and never switches', async () => {
  await fixture(async (source, _target, rootId) => {
    const request = {}; trackStorageRequest(request);
    try { await startStorageMigration(rootId); cancelStorageMigration(); }
    finally { finishStorageRequest(request); }
    await waitForStorageMigration();
    assert.equal(getStorageMigration()?.phase, 'cancelled');
    assert.equal(storageMigrationPaused(), false);
    assert.equal(getAppConfig().storageDir, source);
    assert.equal(existsSync(join(source, 'config/archive-location.json')), false);
  });
});

test('preflight rejects unauthorized roots and source symlinks without switching', async () => {
  await fixture(async (source, target, rootId) => {
    await assert.rejects(previewStorageMigration('unknown'), /授权/);
    symlinkSync(target, join(source, 'reports', 'unsafe'));
    await assert.rejects(previewStorageMigration(rootId), /符号链接/);
    assert.equal(getAppConfig().storageDir, source);
  });
});

test('invalid persisted migration fails closed and atomic writes do not follow legacy temp symlinks', async () => {
  await fixture(async (source) => {
    const path = join(source, 'config/archive-migration.json');
    const victim = join(source, 'reports/synthetic.txt');
    symlinkSync(victim, `${path}.tmp`);
    atomicStorageJson(path, { version: 1, phase: 'copying', source: '/' });
    assert.equal(readFileSync(victim, 'utf8'), 'synthetic content');
    assert.equal(storageMigrationPaused(), true);
    assert.throws(() => resumeStorageMigration(), /无效/);
  });
});

test('storage controls reject CSRF and remain available during maintenance without initializing users', async () => {
  await fixture(async (_source, _target, rootId) => {
    const app = new H3(); app.use(storageHandler);
    const count = () => getDatabase().prepare('SELECT COUNT(*) AS count FROM users').get()?.count;
    const before = count();
    const status = await app.request('http://localhost/api/storage');
    assert.equal(status.status, 200);
    assert.equal(count(), before);
    assert.equal((await app.request('http://localhost/api/storage/migrate', { method: 'POST' })).status, 403);
    assert.equal((await app.request('http://localhost/api/storage/migrate', { method: 'POST', headers: { 'x-storage-operation': '1', 'sec-fetch-site': 'cross-site' } })).status, 403);
    const request = {}; trackStorageRequest(request);
    try {
      await startStorageMigration(rootId);
      assert.equal((await app.request('http://localhost/api/storage')).status, 200);
      assert.equal((await app.request('http://localhost/api/reports')).status, 503);
      const page = await app.request('http://localhost/me/storage');
      assert.match(await page.text(), /继续迁移/);
      const cancel = await app.request('http://localhost/api/storage/cancel', { method: 'POST', headers: { 'x-storage-operation': '1' } });
      assert.equal(cancel.status, 200);
    } finally { finishStorageRequest(request); }
    await waitForStorageMigration();
    assert.equal(getStorageMigration()?.phase, 'cancelled');
  });
});

test('fnOS storage requires trusted gateway admin identity, not user supplied headers', async () => {
  await fixture(async () => {
    process.env.NODE_ENV = 'production'; process.env.AUTH_MODE = 'fnos';
    let accessMode = 'direct', isAdmin = 'true';
    const app = new H3();
    app.use(event => storageHandler(new Proxy(event, {
      get(object, key) {
        if (key === 'node') return { req: { healthAccessMode: accessMode, headers: { 'x-trim-userid': 'test-admin', 'x-trim-isadmin': isAdmin } } };
        return Reflect.get(object, key);
      }
    }) as H3Event));
    assert.equal((await app.request('http://localhost/api/storage')).status, 403);
    accessMode = 'gateway'; isAdmin = 'false';
    assert.equal((await app.request('http://localhost/api/storage')).status, 403);
    isAdmin = 'true';
    assert.equal((await app.request('http://localhost/api/storage')).status, 200);
    assert.equal(getDatabase().prepare('SELECT COUNT(*) AS n FROM users').get()?.n, 0);
  });
});

test('Docker cannot invoke archive migration and ignores fnOS journals', async () => {
  await fixture(async (_source, _target, rootId) => {
    process.env.NODE_ENV = 'production'; process.env.AUTH_MODE = 'local';
    await assert.rejects(startStorageMigration(rootId), /数据卷/);
    await assert.rejects(getArchiveStorageStatus({ id: 'test', displayName: 'Test', provider: 'local', authenticated: true, isAdmin: true, isGatewayAdmin: false }), error => (error as { statusCode: number }).statusCode === 404);
    assert.equal(storageMigrationPaused(), false);
  });
});

test('business backup excludes machine migration state and restore preserves the current state', async () => {
  await fixture(async source => {
    getDatabase().exec("INSERT INTO users (id, display_name, is_gateway_admin) VALUES ('backup-admin', 'Test', 1)");
    const user = { id: 'backup-admin', displayName: 'Test', provider: 'development' as const, authenticated: true, isAdmin: true, isGatewayAdmin: true };
    const journal = join(source, 'config/archive-migration.json');
    writeFileSync(journal, 'synthetic machine-local state');
    const backup = createBackup(user);
    const listing = execFileSync('tar', ['-tzf', backup.path], { encoding: 'utf8' });
    assert.doesNotMatch(listing, /archive-migration\.json/);
    writeFileSync(journal, 'current machine-local state');
    restoreBackup(user, backup.id);
    assert.equal(readFileSync(journal, 'utf8'), 'current machine-local state');
  });
});

test('missing original prevents switch; repairing it permits retry without deleting source', async () => {
  await fixture(async (source, _target, rootId) => {
    const db = getDatabase();
    db.exec("INSERT INTO users (id, display_name) VALUES ('test', 'Test'); INSERT INTO health_members (id, display_name, created_by) VALUES ('member', 'Test', 'test'); INSERT INTO member_permissions (member_id, user_id, permission, granted_by) VALUES ('member', 'test', 'manager', 'test')");
    const user = { id: 'test', displayName: 'Test', provider: 'development' as const, authenticated: true, isAdmin: true, isGatewayAdmin: true };
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
    const report = createUpload(user, 'member', [{ originalName: 'test.png', data: png }]);
    const path = join(source, String(db.prepare('SELECT storage_path FROM report_pages WHERE report_id = ?').get(report.reportId)?.storage_path));
    rmSync(path);
    await startStorageMigration(rootId); await waitForStorageMigration();
    assert.equal(getStorageMigration()?.phase, 'failed');
    assert.equal(getAppConfig().storageDir, source);
    assert.equal(existsSync(join(source, 'config/archive-location.json')), false);
    writeFileSync(path, png);
    resumeStorageMigration(); await waitForStorageMigration();
    assert.equal(getStorageMigration()?.phase, 'completed', getStorageMigration()?.error || 'retry failed');
    assert.equal(existsSync(path), true);
  });
});

test('legacy runtime directory may use a stable symlink alias', async () => {
  await fixture(async (source, target, rootId) => {
    const alias = join(target, '..', 'runtime-alias');
    symlinkSync(source, alias); closeDatabase(); process.env.STORAGE_DIR = alias;
    await startStorageMigration(rootId); await waitForStorageMigration();
    assert.equal(getStorageMigration()?.phase, 'completed', getStorageMigration()?.error || 'alias migration failed');
    assert.equal(getAppConfig().storageDir, getStorageMigration()?.target);
  });
});

test('cleanup removes only verified old files, retaining runtime, backups, new files and active archive', async () => {
  await fixture(async (source, _target, rootId) => {
    for (const dir of ['backups', 'secrets', 'config']) {
      mkdirSync(join(source, dir), { recursive: true });
      writeFileSync(join(source, dir, 'keep.txt'), 'keep');
    }
    await startStorageMigration(rootId); await waitForStorageMigration();
    const state = getStorageMigration()!;
    assert.equal(state.phase, 'completed', state.error || 'migration failed');
    writeFileSync(join(source, 'reports/new.txt'), 'new file');
    getDatabase().prepare('UPDATE migration_probe SET value = ?').run('new target data');
    const preview = await previewStorageCleanup(state.id);
    assert.equal(preview.files, 2);
    const result = await cleanupStorageSource(state.id);
    assert.equal(result.deletedFiles, 2);
    assert.equal(existsSync(join(source, 'db/health-records.sqlite')), false);
    assert.equal(existsSync(join(source, 'reports/synthetic.txt')), false);
    assert.equal(readFileSync(join(source, 'reports/new.txt'), 'utf8'), 'new file');
    for (const dir of ['backups', 'secrets', 'config']) assert.equal(readFileSync(join(source, dir, 'keep.txt'), 'utf8'), 'keep');
    assert.equal(existsSync(join(source, 'ocr-venv/keep-runtime.txt')), true);
    assert.equal(getDatabase().prepare('SELECT value FROM migration_probe').get()?.value, 'new target data');
    assert.equal(existsSync(join(state.target, 'reports/synthetic.txt')), true);
    assert.ok(getStorageMigration()?.cleanupCompletedAt);
    writeFileSync(join(source, 'reports/synthetic.txt'), 'synthetic content');
    assert.equal((await cleanupStorageSource(state.id)).deletedFiles, 0, 'completed cleanup must be idempotent');
    assert.equal(existsSync(join(source, 'reports/synthetic.txt')), true);
  });
});

test('cleanup retains changed files, rejects active old DB, missing manifest and mismatched task', async () => {
  await fixture(async (source, _target, rootId) => {
    await startStorageMigration(rootId); await waitForStorageMigration();
    const state = getStorageMigration()!;
    await assert.rejects(cleanupStorageSource('different-task'));
    writeFileSync(join(source, 'db/health-records.sqlite-wal'), 'synthetic active writer');
    await assert.rejects(cleanupStorageSource(state.id), /旧数据库可能仍被使用/);
    assert.equal(existsSync(join(source, 'reports/synthetic.txt')), true);
    rmSync(join(source, 'db/health-records.sqlite-wal'));
    writeFileSync(join(source, 'reports/synthetic.txt'), 'changed source');
    assert.equal((await previewStorageCleanup(state.id)).skipped, 1);
    const result = await cleanupStorageSource(state.id);
    assert.equal(result.deletedFiles, 1);
    assert.equal(result.skipped, 1);
    assert.equal(readFileSync(join(source, 'reports/synthetic.txt'), 'utf8'), 'changed source');
    assert.equal(getStorageMigration()?.cleanupCompletedAt, undefined);
    rmSync(join(source, 'config/archive-cleanup.json'));
    assert.equal(getStorageMigration()?.cleanupAvailable, false);
    await assert.rejects(cleanupStorageSource(state.id), /缺少有效/);
  });
});

test('cleanup cannot follow a replaced source folder or run without explicit API confirmation', async () => {
  await fixture(async (source, target, rootId) => {
    await startStorageMigration(rootId); await waitForStorageMigration();
    const state = getStorageMigration()!;
    const app = new H3(); app.use(storageHandler);
    const response = await app.request('http://localhost/api/storage/cleanup', {
      method: 'POST', headers: { 'x-storage-operation': '1', 'content-type': 'application/json' }, body: JSON.stringify({ migrationId: state.id })
    });
    assert.equal(response.status, 400);
    renameSync(join(source, 'reports'), join(source, 'reports-retained'));
    symlinkSync(join(state.target, 'reports'), join(source, 'reports'));
    const result = await cleanupStorageSource(state.id);
    assert.equal(result.skipped, 1);
    assert.equal(existsSync(join(state.target, 'reports/synthetic.txt')), true);
    assert.equal(existsSync(join(source, 'reports-retained/synthetic.txt')), true);
    assert.equal(existsSync(target), true);
  });
});
