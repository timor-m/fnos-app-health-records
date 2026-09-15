import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDatabase, closeDatabaseForTests } from '../database/client.ts';
import { reportNotesSchemaSql } from '../database/report-notes-draft.ts';
import type { RequestUser } from '../domain/request-user.ts';
import { createId } from '../utils/identifier.ts';
import { stageReportNoteImage, saveReportNote, listReportNotes, deleteReportNote, getReportNoteImage, getStagedNoteImage } from '../services/report-note.service.ts';
import type { WorkerRequest } from '../services/ocr-worker-client.ts';
import { createBackup, restoreBackup, validateBackup, trashReport, restoreReport, purgeExpiredReports } from '../services/records.service.ts';
import { runFileGarbageCollection, scanOrphanStorageFiles } from '../services/file-gc.service.ts';
import { cleanupExpiredStagedUploads } from '../services/staged-upload.service.ts';
import { maxUploadFileBytes } from '../../shared/upload-limits.ts';

const manager: RequestUser = { id: 'manager', displayName: 'fixture', provider: 'fnos_gateway', authenticated: true, isGatewayAdmin: true };
const viewer = { ...manager, id: 'viewer', isGatewayAdmin: false };
const forbidden = { ...viewer, id: 'other' };
const status = (n: number) => (error: unknown) => (error as { statusCode: number }).statusCode === n;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jU1sAAAAASUVORK5CYII=', 'base64');
const render = async (request: WorkerRequest) => {
  assert.equal(request.action, 'thumbnail');
  writeFileSync(request.outputPath!, Buffer.from([255, 216, 255, 217]));
  return { ok: true, width: 1, height: 1 };
};
async function fixture(run: (root: string) => Promise<void> | void) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'report-notes-test-')));
  const previous = process.env.STORAGE_DIR;
  process.env.STORAGE_DIR = root;
  try {
    const db = getDatabase();
    db.exec(`INSERT INTO users(id, display_name, is_gateway_admin) VALUES ('manager','fixture',1),('viewer','fixture',0),('other','fixture',0);
      INSERT INTO health_members(id, display_name, created_by) VALUES ('member','fixture','manager');
      INSERT INTO member_permissions(member_id, user_id, permission, granted_by) VALUES ('member','manager','manager','manager'),('member','viewer','viewer','manager');
      INSERT INTO reports(id, member_id, created_by, report_type, title, status) VALUES ('report','member','manager','other','fixture','ready'),('other-report','member','manager','other','fixture','ready');`);
    await run(root);
  } finally { closeDatabaseForTests(); if (previous === undefined) delete process.env.STORAGE_DIR; else process.env.STORAGE_DIR = previous; rmSync(root, { recursive: true, force: true }); }
}
const stage = (data = png) => stageReportNoteImage(manager, 'report', { originalName: 'fixture.png', data }, render);

test('notes draft upgrades existing v17 with backup, indexes, FK and no schema renumbering', async () => fixture(root => {
  const db = getDatabase();
  db.exec('DROP TABLE report_note_assets; DROP TABLE report_notes');
  closeDatabaseForTests();
  const upgraded = getDatabase();
  assert.ok(readdirSync(join(root, 'backups/db')).length);
  assert.equal(upgraded.prepare('SELECT MAX(version) AS v FROM schema_migrations').get()?.v, 17);
  assert.equal(upgraded.prepare('SELECT COUNT(*) AS n FROM reports').get()?.n, 2);
  upgraded.exec(reportNotesSchemaSql); upgraded.exec(reportNotesSchemaSql);
  assert.ok(upgraded.prepare("SELECT name FROM sqlite_master WHERE name='report_notes_report_idx'").get());
  assert.ok(upgraded.prepare("SELECT name FROM sqlite_master WHERE name='report_note_assets_note_idx'").get());
  assert.throws(() => upgraded.prepare('INSERT INTO report_notes(id,report_id) VALUES (?,?)').run('bad','missing'), /FOREIGN KEY/);
  const note = saveReportNote(manager, 'report', { contentText: 'fixture', assets: [] });
  upgraded.exec("DELETE FROM member_permissions WHERE user_id='manager'");
  // creator deletion uses SET NULL independently from the report creator.
  upgraded.prepare("UPDATE report_notes SET created_by='viewer' WHERE id=?").run(note.id);
  upgraded.exec("DELETE FROM member_permissions WHERE user_id='viewer'; DELETE FROM users WHERE id='viewer'");
  assert.equal(upgraded.prepare('SELECT created_by FROM report_notes WHERE id=?').get(note.id)?.created_by, null);
}));

test('text, image-only, combined notes, safe retries, edits, order, soft delete and isolated pipeline', async () => fixture(async () => {
  const first = saveReportNote(manager, 'report', { contentText: 'fixture', assets: [] });
  const uploaded = await stage();
  const secondUpload = await stage(Buffer.concat([png, Buffer.from('second')]));
  const id = createId('note');
  const input = { id, contentText: '', assets: [{ uploadToken: uploaded.uploadToken }, { uploadToken: secondUpload.uploadToken }] };
  const images = saveReportNote(manager, 'report', input);
  assert.deepEqual(saveReportNote(manager, 'report', input), images);
  assert.equal(images.assets.length, 2);
  const changed = saveReportNote(manager, 'report', { contentText: 'edited fixture', updatedAt: images.updatedAt, assets: [...images.assets].reverse().map(asset => ({ id: asset.id })) }, images.id);
  assert.equal(changed.assets[0].id, images.assets[1].id);
  assert.notEqual(changed.updatedAt, images.updatedAt);
  assert.throws(() => saveReportNote(manager, 'report', { contentText: 'stale', updatedAt: images.updatedAt, assets: [] }, images.id), status(409));
  assert.equal(listReportNotes(viewer, 'report').canManage, false);
  assert.equal(listReportNotes(manager, 'report').notes.length, 2);
  assert.equal(getDatabase().prepare('SELECT COUNT(*) AS n FROM report_pages').get()?.n, 0);
  assert.equal(getDatabase().prepare('SELECT COUNT(*) AS n FROM processing_jobs').get()?.n, 0);
  assert.equal(getDatabase().prepare('SELECT COUNT(*) AS n FROM observations').get()?.n, 0);
  deleteReportNote(manager, 'report', first.id);
  assert.equal(listReportNotes(manager, 'report').notes.length, 1);
  assert.throws(() => saveReportNote(manager, 'report', { contentText: 'fixture', assets: [] }, first.id), status(404));
  const logs = getDatabase().prepare("SELECT action, detail_json FROM audit_logs WHERE action LIKE 'report.note.%'").all();
  assert.ok(logs.some(log => log.action === 'report.note.asset.upload'));
  for (const log of logs) assert.deepEqual(Object.keys(JSON.parse(String(log.detail_json))).sort(), ['assetCount', 'noteId', 'reportId']);
}));

test('permission enforced for all mutations, stages and originals, including revoked permission after rendering', async () => fixture(async () => {
  const upload = await stage();
  const note = saveReportNote(manager, 'report', { contentText: '', assets: [{ uploadToken: upload.uploadToken }] });
  for (const user of [viewer, forbidden, { ...manager, authenticated: false }]) {
    assert.throws(() => saveReportNote(user, 'report', { contentText: 'fixture', assets: [] }));
    assert.throws(() => deleteReportNote(user, 'report', note.id));
    await assert.rejects(stageReportNoteImage(user, 'report', { originalName: 'fixture.png', data: png }, render));
    assert.throws(() => getStagedNoteImage(user, 'report', upload.uploadToken));
  }
  assert.ok(existsSync(getReportNoteImage(viewer, 'report', note.id, note.assets[0].id, 'original').path));
  assert.throws(() => getReportNoteImage(forbidden, 'report', note.id, note.assets[0].id, 'original'), status(403));
  assert.throws(() => getReportNoteImage(viewer, 'other-report', note.id, note.assets[0].id, 'original'), status(404));
  assert.throws(() => listReportNotes(manager, 'missing'), status(404));
  assert.throws(() => saveReportNote(manager, 'other-report', { contentText: 'fixture', assets: [{ uploadToken: upload.uploadToken }] }), status(404));
  await assert.rejects(stageReportNoteImage(manager, 'report', { originalName: 'fixture.png', data: png }, async request => {
    const result = await render(request); getDatabase().exec("DELETE FROM member_permissions WHERE user_id='manager'"); return result;
  }), status(403));
}));

test('format signatures, declared MIME, bounds, duplicate images, invalid IDs and filename injection', async () => fixture(async root => {
  for (const [data, mime] of [[png,'image/png'], [Buffer.from([255,216,255,0]),'image/jpeg'], [Buffer.from('RIFF0000WEBP'),'image/webp'], [Buffer.from('\0\0\0\0ftypheic'),'image/heic']] as const) {
    const result = await stageReportNoteImage(manager, 'report', { originalName: '../../fixture', data, declaredType: mime }, render);
    assert.equal(result.originalName, 'fixture');
    const note = saveReportNote(manager, 'report', { contentText: '', assets: [{ uploadToken: result.uploadToken }] });
    assert.ok(getReportNoteImage(viewer, 'report', note.id, note.assets[0].id, 'original').path.startsWith(join(root, 'report-notes')));
    if (mime === 'image/heic') assert.equal(getReportNoteImage(viewer, 'report', note.id, note.assets[0].id, 'preview').mimeType, 'image/jpeg');
  }
  await assert.rejects(stageReportNoteImage(manager, 'report', { originalName: 'fixture.png', data: png, declaredType: 'text/html' }, render), status(415));
  for (const data of [Buffer.from('%PDF-1.4'), Buffer.from('<svg/>')]) await assert.rejects(stage(data), status(415));
  await assert.rejects(stage(Buffer.alloc(maxUploadFileBytes + 1)), status(413));
  assert.throws(() => saveReportNote(manager, 'report', { contentText: ' ', assets: [] }), status(400));
  assert.throws(() => saveReportNote(manager, 'report', { contentText: 'x'.repeat(10001), assets: [] }), status(400));
  assert.throws(() => saveReportNote(manager, 'report', { contentText: '', assets: Array(10).fill({ uploadToken: 'x' }) }), status(400));
  const upload = await stage();
  assert.throws(() => saveReportNote(manager, 'report', { contentText: '', assets: [{ uploadToken: upload.uploadToken }, { uploadToken: upload.uploadToken }] }), status(409));
  assert.throws(() => saveReportNote(manager, 'report', { contentText: '', assets: [{ uploadToken: '../../outside' }] }), status(400));
  assert.throws(() => saveReportNote(manager, 'report', { contentText: '', assets: [{ id: 'foreign-asset' }] }), status(404));
  const successfulCount = getDatabase().prepare('SELECT COUNT(*) AS n FROM report_notes').get()?.n;
  assert.equal(successfulCount, 4);
}));

test('asset removal, report recycle/restore, permanent deletion, backup round trip and orphan GC', async () => fixture(async root => {
  const upload = await stage();
  let note = saveReportNote(manager, 'report', { contentText: 'fixture', assets: [{ uploadToken: upload.uploadToken }] });
  const original = getReportNoteImage(viewer, 'report', note.id, note.assets[0].id, 'original').path;
  const backup = createBackup(manager);
  assert.equal(validateBackup(manager, backup.id).valid, true);
  note = saveReportNote(manager, 'report', { contentText: 'fixture', updatedAt: note.updatedAt, assets: [] }, note.id);
  getDatabase().exec("UPDATE file_gc_queue SET not_before=datetime('now','-1 minute')");
  assert.ok(runFileGarbageCollection().deleted >= 2);
  assert.equal(existsSync(original), false);
  restoreBackup(manager, backup.id);
  note = listReportNotes(manager, 'report').notes[0];
  assert.equal(note.assets.length, 1);
  assert.deepEqual(readFileSync(getReportNoteImage(viewer, 'report', note.id, note.assets[0].id, 'original').path), png);
  trashReport(manager, 'report');
  assert.equal(listReportNotes(manager, 'report').canManage, false);
  assert.throws(() => deleteReportNote(manager, 'report', note.id), status(409));
  restoreReport(manager, 'report');
  assert.equal(listReportNotes(manager, 'report').notes.length, 1);
  deleteReportNote(manager, 'report', note.id);
  assert.throws(() => getReportNoteImage(viewer, 'report', note.id, note.assets[0].id, 'original'), status(404));
  scanOrphanStorageFiles(-1); runFileGarbageCollection();
  assert.equal(existsSync(original), true); // soft-deleted attachments remain referenced
  trashReport(manager, 'report');
  getDatabase().exec("UPDATE reports SET purge_after=datetime('now','-1 minute') WHERE id='report'");
  assert.equal(purgeExpiredReports().deleted, 1);
  getDatabase().exec("UPDATE file_gc_queue SET not_before=datetime('now','-1 minute')");
  assert.ok(runFileGarbageCollection().deleted >= 2);
  assert.equal(existsSync(original), false);
  assert.equal(getDatabase().prepare('SELECT COUNT(*) AS n FROM report_note_assets').get()?.n, 0);
  assert.equal(getDatabase().prepare('SELECT COUNT(*) AS n FROM report_notes').get()?.n, 0);
  cleanupExpiredStagedUploads(Date.now() + 8 * 86400000);
  assert.equal(readdirSync(join(root, 'upload-staging')).length, 0);
}));

test('failed thumbnail leaves no stage; successful stages survive a later image failure', async () => fixture(async root => {
  const ready = await stage();
  await assert.rejects(stageReportNoteImage(manager, 'report', { originalName: 'fixture.png', data: png }, async () => { throw new Error('fixture'); }), status(422));
  assert.equal(readdirSync(join(root, 'upload-staging')).length, 1);
  assert.ok(existsSync(getStagedNoteImage(manager, 'report', ready.uploadToken).path));
  assert.equal(saveReportNote(manager, 'report', { contentText: '', assets: [{ uploadToken: ready.uploadToken }] }).assets.length, 1);
}));
