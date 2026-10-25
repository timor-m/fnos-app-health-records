import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { writeDatabaseSnapshot } from '../database/snapshot';

test('online snapshots retain committed WAL rows even while a reader prevents checkpointing', () => {
  const root = mkdtempSync(join(tmpdir(), 'database-snapshot-'));
  const path = join(root, 'live.sqlite');
  const target = join(root, 'snapshot.sqlite');
  const writer = new DatabaseSync(path);
  let reader: DatabaseSync | undefined;
  try {
    writer.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE synthetic(id INTEGER PRIMARY KEY); INSERT INTO synthetic VALUES(1)");
    reader = new DatabaseSync(path);
    reader.exec('BEGIN');
    assert.equal(reader.prepare('SELECT COUNT(*) AS count FROM synthetic').get()!.count, 1);
    writer.exec('INSERT INTO synthetic VALUES(2)');
    assert.equal(writer.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()!.busy, 1);

    writeDatabaseSnapshot(writer, target);
    const snapshot = new DatabaseSync(target, { readOnly: true });
    try { assert.deepEqual(snapshot.prepare('SELECT id FROM synthetic ORDER BY id').all().map(row => row.id), [1, 2]); }
    finally { snapshot.close(); }
    assert.equal(statSync(target).mode & 0o777, 0o600);

    const original = readFileSync(target);
    assert.throws(() => writeDatabaseSnapshot(writer, target), /EEXIST/);
    assert.deepEqual(readFileSync(target), original);
  } finally {
    reader?.close();
    writer.close();
    rmSync(root, { recursive: true, force: true });
  }
});
