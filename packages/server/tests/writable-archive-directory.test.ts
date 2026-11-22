import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ensureWritableArchiveDirectory, removeOrRetireDirectory } from '../utils/writable-archive-directory';

function withStorage(run: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'writable-archive-'));
  const previous = process.env.STORAGE_DIR;
  process.env.STORAGE_DIR = dir;
  try {
    run(dir);
  } finally {
    if (previous === undefined) delete process.env.STORAGE_DIR;
    else process.env.STORAGE_DIR = previous;
    unlock(dir);
    rmSync(dir, { recursive: true, force: true });
  }
}

function unlock(path: string) {
  try { chmodSync(path, 0o700); } catch { return; }
  let names: string[] = [];
  try { names = readdirSync(path); } catch { return; }
  for (const name of names) unlock(join(path, name));
}

function asOtherUser<T>(run: () => T) {
  const original = process.getuid;
  Object.defineProperty(process, 'getuid', { configurable: true, value: () => 1 });
  try { return run(); } finally {
    Object.defineProperty(process, 'getuid', { configurable: true, value: original });
  }
}

test('a directory owned by this process stays in place when it is not writable', () => {
  if (process.getuid?.() === 0) return;
  withStorage(dir => {
    const backups = join(dir, 'backups');
    mkdirSync(backups, { mode: 0o500 });
    assert.throws(() => ensureWritableArchiveDirectory(backups), (error: NodeJS.ErrnoException) => error.code === 'EACCES');
    assert.equal(readdirSync(dir).some(name => name.startsWith('backups.unwritable-')), false);
    chmodSync(backups, 0o700);
  });
});

test('a foreign unwritable backup directory is kept aside and readable archives are copied back', () => {
  if (process.getuid?.() === 0) return;
  withStorage(dir => {
    const full = join(dir, 'backups', 'full');
    mkdirSync(full, { recursive: true });
    const archive = 'backup_' + 'a'.repeat(32) + '.tar.gz';
    writeFileSync(join(full, archive), 'synthetic-archive', { mode: 0o644 });
    chmodSync(full, 0o555);
    if (process.platform !== 'linux') {
      assert.throws(() => asOtherUser(() => ensureWritableArchiveDirectory(full)), (error: NodeJS.ErrnoException) => error.code === 'EACCES');
      assert.equal(readdirSync(join(dir, 'backups')).some(name => name.startsWith('full.unwritable-')), false);
      return;
    }
    asOtherUser(() => ensureWritableArchiveDirectory(full));
    assert.ok(readdirSync(join(dir, 'backups')).some(name => name.startsWith('full.unwritable-')));
    assert.equal(readdirSync(full).includes(archive), true);
  });
});

test('a foreign unwritable uploads directory is replaced so a new file can be created inside it', () => {
  if (process.getuid?.() === 0) return;
  withStorage(dir => {
    const uploads = join(dir, 'uploads');
    mkdirSync(uploads, { mode: 0o555 });
    if (process.platform !== 'linux') {
      assert.throws(() => asOtherUser(() => ensureWritableArchiveDirectory(uploads)), (error: NodeJS.ErrnoException) => error.code === 'EACCES');
      assert.equal(readdirSync(dir).some(name => name.startsWith('uploads.unwritable-')), false);
      return;
    }
    asOtherUser(() => ensureWritableArchiveDirectory(uploads));
    assert.ok(readdirSync(dir).some(name => name.startsWith('uploads.unwritable-')));
    mkdirSync(join(uploads, 'incoming-ok'));
  });
});

test('a writable data directory is removed and the storage root is never moved', () => {
  withStorage(dir => {
    const reports = join(dir, 'reports');
    mkdirSync(reports);
    writeFileSync(join(reports, 'page.bin'), 'synthetic');
    assert.equal(removeOrRetireDirectory(reports), null);
    assert.equal(readdirSync(dir).includes('reports'), false);
    assert.throws(() => removeOrRetireDirectory(dir), (error: NodeJS.ErrnoException) => error.code === 'EPERM');
    assert.equal(readdirSync(dir).includes('reports'), false);
  });
});

test('a data directory owned by this process stays in place when it cannot be removed', () => {
  if (process.getuid?.() === 0) return;
  withStorage(dir => {
    const reports = join(dir, 'reports');
    mkdirSync(reports);
    writeFileSync(join(reports, 'page.bin'), 'keep');
    chmodSync(reports, 0o500);
    assert.throws(() => removeOrRetireDirectory(reports), (error: NodeJS.ErrnoException) => error.code === 'EACCES');
    assert.equal(readdirSync(dir).some(name => name.startsWith('reports.unwritable-')), false);
    chmodSync(reports, 0o700);
    assert.equal(readdirSync(reports).includes('page.bin'), true);
  });
});

test('a foreign unwritable data directory is kept aside so restore can write a new one', () => {
  if (process.getuid?.() === 0) return;
  withStorage(dir => {
    const reports = join(dir, 'reports');
    mkdirSync(reports);
    writeFileSync(join(reports, 'page.bin'), 'synthetic', { mode: 0o644 });
    chmodSync(reports, 0o555);
    if (process.platform !== 'linux') {
      assert.throws(() => asOtherUser(() => removeOrRetireDirectory(reports)), (error: NodeJS.ErrnoException) => error.code === 'EACCES');
      assert.equal(readdirSync(dir).some(name => name.startsWith('reports.unwritable-')), false);
      return;
    }
    const retired = asOtherUser(() => removeOrRetireDirectory(reports));
    assert.equal(typeof retired, 'string');
    assert.equal(readdirSync(dir).includes('reports'), false);
    assert.ok(String(retired).startsWith(reports + '.unwritable-'));
    mkdirSync(reports);
  });
});
