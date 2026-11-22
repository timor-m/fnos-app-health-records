import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** Consistent online snapshot, including committed WAL data. Never overwrite or copy a live main file. */
export function writeDatabaseSnapshot(db: DatabaseSync, path: string) {
  mkdirSync(dirname(path), { recursive: true });
  // Reserve the destination privately and exclusively; an existing snapshot must survive any failure.
  closeSync(openSync(path, 'wx', 0o600));
  try {
    db.exec(`VACUUM INTO '${path.replaceAll("'", "''")}'`);
    // VACUUM INTO 会按源库权限重建文件。源库在飞牛卷上可以是 000，快照必须改成所有者可读再校验。
    chmodSync(dirname(path), 0o700);
    chmodSync(path, 0o600);
    const snapshot = new DatabaseSync(path, { readOnly: true });
    try {
      const checks = snapshot.prepare('PRAGMA quick_check').all();
      if (checks.length !== 1 || checks[0].quick_check !== 'ok') {
        throw new Error('Database snapshot integrity check failed.');
      }
    } finally { snapshot.close(); }
    // VACUUM INTO does not promise to flush its output before returning.
    const descriptor = openSync(path, 'r');
    try { fsyncSync(descriptor); }
    finally { closeSync(descriptor); }
  } catch (error) {
    try { rmSync(path, { force: true }); } catch { /* Preserve the original snapshot failure. */ }
    throw error;
  }
}
