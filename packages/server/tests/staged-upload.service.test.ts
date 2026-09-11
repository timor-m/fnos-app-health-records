import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { getDatabase, closeDatabaseForTests } from '../database/client.ts';
import { uploadReceiptSchemaSql } from '../database/migrations.ts';
import { startStagedUpload, storeStagedFile, completeStagedUpload, discardStagedUpload, cleanupExpiredStagedUploads } from '../services/staged-upload.service.ts';
import type { RequestUser } from '../domain/request-user.ts';
import type { H3Event } from 'h3';
import storeFileRoute from '../routes/api/uploads/staged/[key]/files/[index].post.ts';

const user: RequestUser = { id: 'staging-user', displayName: 'Test', provider: 'fnos_gateway', authenticated: true, isGatewayAdmin: true };
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
const hasStatus = (status: number) => (error: unknown) => (error as { statusCode: number }).statusCode === status;

test('30 images plus PDF finalize atomically, preserve order and retry without duplicate reports after restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'staged-upload-test-'));
  process.env.STORAGE_DIR = directory;
  const previousAuthMode = process.env.AUTH_MODE;
  process.env.AUTH_MODE = 'fnos';
  try {
    let db = getDatabase();
    db.prepare('INSERT INTO users (id, display_name) VALUES (?, ?)').run(user.id, 'Test');
    db.exec("INSERT INTO health_members (id, display_name, relationship, created_by) VALUES ('member', 'Test', 'self', 'staging-user')");
    db.exec("INSERT INTO member_permissions (member_id, user_id, permission, granted_by) VALUES ('member', 'staging-user', 'manager', 'staging-user')");
    // Exercise the previous-version migration independently, without changing old migrations.
    db.exec('DROP TABLE upload_receipts');
    closeDatabaseForTests(); db = getDatabase();
    assert.ok(readdirSync(join(directory, 'backups', 'db')).some(name => name.includes('v17-to-v17')));
    assert.equal((db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number }).version, 17);
    db.exec(uploadReceiptSchemaSql); db.exec(uploadReceiptSchemaSql);
    const key = 'test-upload-request-0001';
    const buffers = [...Array.from({ length: 30 }, () => png), Buffer.from('%PDF-1.4\n%%EOF')];
    const manifest = { memberId: 'member', files: buffers.map((data, index) => ({ originalName: `${index}.${index === 30 ? 'pdf' : 'png'}`, size: data.length, rotation: index === 0 ? 90 : 0 })) };
    assert.deepEqual(startStagedUpload(user, key, manifest).received, []);
    assert.throws(() => completeStagedUpload(user, key), hasStatus(409));
    assert.throws(() => storeStagedFile(user, key, 0, Buffer.from('bad')), hasStatus(400));
    buffers.slice(0, 30).forEach((data, index) => storeStagedFile(user, key, index, data));
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM processing_jobs').get() as { n: number }).n, 0);
    assert.throws(() => completeStagedUpload(user, key), hasStatus(409));
    assert.equal(startStagedUpload(user, key, manifest).received.length, 30);
    const body = new FormData(); body.append('file', new Blob([buffers[30]]), '30.pdf');
    const req = new Request('http://localhost/upload', { method: 'POST', body });
    await storeFileRoute({ req, headers: req.headers, context: { params: { key, index: '30' } }, node: { req: { healthAccessMode: 'gateway', headers: { 'x-trim-userid': user.id, 'x-trim-username': 'Test', 'x-trim-isadmin': 'true' } } } } as unknown as H3Event);
    const first = completeStagedUpload(user, key);
    assert.equal(first.pageCount, 31);
    assert.equal(first.jobCount, 62);
    assert.deepEqual(first.pages.map(page => page.originalName), manifest.files.map(file => file.originalName));
    assert.equal(first.pages[0].rotation, 90);
    closeDatabaseForTests(); db = getDatabase();
    assert.deepEqual(completeStagedUpload(user, key), first);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM reports').get() as { n: number }).n, 1);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM processing_jobs').get() as { n: number }).n, 62);
    assert.equal(readdirSync(join(directory, 'reports', 'member')).length, 1);
    assert.throws(() => startStagedUpload(user, key, { ...manifest, files: [...manifest.files].reverse() }), hasStatus(409));
    assert.throws(() => completeStagedUpload({ ...user, id: 'other' }, key), hasStatus(404));
    db.exec("DELETE FROM member_permissions WHERE member_id = 'member'");
    assert.throws(() => completeStagedUpload({ ...user, isGatewayAdmin: false }, key), hasStatus(403));
    db.exec("INSERT INTO member_permissions (member_id, user_id, permission, granted_by) VALUES ('member', 'staging-user', 'manager', 'staging-user')");
    discardStagedUpload(user, key);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM reports').get() as { n: number }).n, 1);
    startStagedUpload(user, key, manifest);
    cleanupExpiredStagedUploads(Date.now() + 8 * 24 * 60 * 60 * 1000);
    assert.equal(readdirSync(join(directory, 'upload-staging')).length, 0);
    assert.equal(existsSync(join(directory, 'reports', 'member', first.reportId)), true);
  } finally {
    closeDatabaseForTests(); delete process.env.STORAGE_DIR;
    if (previousAuthMode === undefined) delete process.env.AUTH_MODE;
    else process.env.AUTH_MODE = previousAuthMode;
    rmSync(directory, { recursive: true, force: true });
  }
});
