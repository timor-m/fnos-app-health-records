import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { closeDatabaseForTests, getDatabase } from '../database/client';
import { databaseMigrations } from '../database/migrations';
import type { RequestUser } from '../domain/request-user';
import { processNextJob } from '../services/job-runner.service';
import { getReportDetail, getReportPageOcrDetail, getReportPagePreviewFile, rotateReportPage } from '../services/records.service';
import { createUpload } from '../services/upload.service';

const owner: RequestUser = { id: 'orientation-owner', displayName: '合成账号', provider: 'development', authenticated: true, isGatewayAdmin: true };
const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]);

async function withCoordinatePage(run: (db: DatabaseSync, reportId: string, pageId: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'ocr-orientation-coordinates-'));
  const previous = process.env.STORAGE_DIR;
  process.env.STORAGE_DIR = dir;
  try {
    const db = getDatabase();
    db.prepare('INSERT INTO users(id,display_name,is_gateway_admin) VALUES(?,?,1)').run(owner.id, owner.displayName);
    db.prepare("INSERT INTO health_members(id,display_name,relationship,created_by) VALUES('orientation-member','合成成员','self',?)").run(owner.id);
    db.prepare("INSERT INTO member_permissions(member_id,user_id,permission,granted_by) VALUES('orientation-member',?,'manager',?)").run(owner.id, owner.id);
    const upload = createUpload(owner, 'orientation-member', [{ originalName: 'synthetic.png', data: png }]);
    const pageId = upload.pages[0].id;
    const job = db.prepare("SELECT id FROM processing_jobs WHERE page_id=? AND job_type='ocr'").get(pageId)!;
    db.prepare("INSERT INTO ocr_results(id,job_id,page_id,engine,model_version,lines_json,coord_width,coord_height) VALUES('coordinate-ocr',?,?,'test','v1','[]',200,300)").run(job.id, pageId);
    await run(db, upload.reportId, pageId);
  } finally {
    closeDatabaseForTests();
    if (previous === undefined) delete process.env.STORAGE_DIR; else process.env.STORAGE_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}

const orientations = [
  { angle: 0, width: 200, height: 300, box: [10, 20, 40, 60] },
  { angle: 90, width: 300, height: 200, box: [240, 10, 280, 40] },
  { angle: 180, width: 200, height: 300, box: [160, 240, 190, 280] },
  { angle: 270, width: 300, height: 200, box: [20, 160, 60, 190] },
];

test('all OCR and viewing angle combinations align image originals and PDF previews without rewriting recognition or line IDs', async () => {
  await withCoordinatePage(async (db, reportId, pageId) => {
    const noWorker = async () => { throw new Error('Complete coordinates must not invoke a worker'); };
    for (const mimeType of ['image/png', 'application/pdf']) {
      for (const source of orientations) {
        const [left, top, right, bottom] = source.box;
        const linesJson = JSON.stringify([
          { id: 'stable-line', text: '合成文字', confidence: 0.96, box: source.box },
          { id: 'stable-polygon', text: '合成四点框', confidence: 0.94, box: [[left, top], [right, top], [right, bottom], [left, bottom]] },
        ]);
        db.prepare("UPDATE ocr_results SET lines_json=?,coord_width=?,coord_height=? WHERE id='coordinate-ocr'").run(linesJson, source.width, source.height);
        for (const target of [...orientations, orientations[0]!]) {
          db.prepare('UPDATE report_pages SET mime_type=?,rotation=?,ocr_rotation=? WHERE id=?').run(mimeType, target.angle, source.angle, pageId);
          const detail = await getReportPageOcrDetail(owner, reportId, pageId, noWorker as never);
          const expected = mimeType === 'application/pdf' ? target : orientations[0]!;
          assert.equal(detail?.orientationChanged, false);
          assert.equal(detail?.coordWidth, expected.width);
          assert.equal(detail?.coordHeight, expected.height);
          assert.deepEqual(detail?.lines.map(line => line.box), [expected.box, expected.box]);
          assert.deepEqual(detail?.lines.map(line => line.readingBox ?? line.box), [source.box, source.box]);
          assert.deepEqual(detail?.lines.map(line => line.id), ['stable-line', 'stable-polygon']);
          assert.deepEqual(detail?.lines.map(line => line.confidence), [0.96, 0.94]);
          assert.equal(getReportDetail(owner, reportId).pages[0]?.ocrStale, false);
          assert.equal(db.prepare("SELECT lines_json FROM ocr_results WHERE id='coordinate-ocr'").get()!.lines_json, linesJson);
          assert.equal(db.prepare('SELECT ocr_rotation FROM report_pages WHERE id=?').get(pageId)!.ocr_rotation, source.angle);
        }
      }
    }
  });
});

test('legacy PDF coordinates are healed in recognition orientation before adapting to a changed display orientation', async () => {
  await withCoordinatePage(async (db, reportId, pageId) => {
    db.prepare("UPDATE report_pages SET mime_type='application/pdf',rotation=180,ocr_rotation=90 WHERE id=?").run(pageId);
    db.prepare("UPDATE ocr_results SET lines_json=?,coord_width=NULL,coord_height=NULL WHERE id='coordinate-ocr'")
      .run(JSON.stringify([{ id: 'stable-line', text: '合成文字', box: orientations[0]!.box }]));
    assert.equal(getReportDetail(owner, reportId).pages[0]?.ocrStale, true);
    let inspectCalls = 0;
    const inspect = async () => {
      ++inspectCalls;
      return { pages: [{ pageNumber: 1, width: 200, height: 300 }] };
    };
    const detail = await getReportPageOcrDetail(owner, reportId, pageId, inspect as never);
    assert.equal(detail?.orientationChanged, false);
    assert.deepEqual(detail?.lines[0]?.box, orientations[2]!.box);
    const stored = db.prepare("SELECT lines_json,coord_width,coord_height FROM ocr_results WHERE id='coordinate-ocr'").get()!;
    assert.deepEqual(JSON.parse(String(stored.lines_json))[0].box, orientations[1]!.box);
    assert.equal(stored.coord_width, 300);
    assert.equal(stored.coord_height, 200);
    assert.equal(getReportDetail(owner, reportId).pages[0]?.ocrStale, false);
    db.prepare('UPDATE report_pages SET rotation=270 WHERE id=?').run(pageId);
    const again = await getReportPageOcrDetail(owner, reportId, pageId, inspect as never);
    assert.deepEqual(again?.lines[0]?.box, orientations[3]!.box);
    assert.equal(inspectCalls, 1);
    assert.deepEqual(db.prepare("SELECT lines_json,coord_width,coord_height FROM ocr_results WHERE id='coordinate-ocr'").get(), stored);
  });
});

test('unreliable historical coordinates remain hidden with text preserved, while unrotated image coordinates need no dimensions', async () => {
  await withCoordinatePage(async (db, reportId, pageId) => {
    const raw = JSON.stringify([{ id: 'stable-line', text: '合成文字', box: orientations[0]!.box }]);
    db.prepare("UPDATE ocr_results SET lines_json=?,coord_width=NULL,coord_height=NULL WHERE id='coordinate-ocr'").run(raw);
    db.prepare('UPDATE report_pages SET rotation=90,ocr_rotation=0 WHERE id=?').run(pageId);
    const noDimensions = async () => { throw new Error('Synthetic inspection unavailable'); };
    const image = await getReportPageOcrDetail(owner, reportId, pageId, noDimensions as never);
    assert.equal(image?.orientationChanged, false);
    assert.deepEqual(image?.lines[0]?.box, orientations[0]!.box);
    for (const [mimeType, ocrRotation] of [['application/pdf', 0], ['image/png', 90], ['image/png', null]] as const) {
      db.prepare('UPDATE report_pages SET mime_type=?,ocr_rotation=? WHERE id=?').run(mimeType, ocrRotation, pageId);
      const detail = await getReportPageOcrDetail(owner, reportId, pageId, noDimensions as never);
      assert.equal(detail?.orientationChanged, true);
      assert.deepEqual(detail?.lines[0], { id: 'stable-line', text: '合成文字', confidence: 0, box: null });
      assert.equal(getReportDetail(owner, reportId).pages[0]?.ocrStale, true);
      assert.equal(db.prepare("SELECT lines_json FROM ocr_results WHERE id='coordinate-ocr'").get()!.lines_json, raw);
    }
  });
});

test('saving one page orientation preserves OCR and AI results without queuing recognition for any page', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'page-orientation-'));
  const previous = process.env.STORAGE_DIR;
  process.env.STORAGE_DIR = dir;
  try {
    const db = getDatabase();
    db.prepare("INSERT INTO users(id,display_name,is_gateway_admin) VALUES(?,?,1)").run(owner.id, owner.displayName);
    db.prepare("INSERT INTO health_members(id,display_name,relationship,created_by) VALUES('orientation-member','合成成员','self',?)").run(owner.id);
    db.prepare("INSERT INTO member_permissions(member_id,user_id,permission,granted_by) VALUES('orientation-member',?,'manager',?)").run(owner.id, owner.id);
    const upload = createUpload(owner, 'orientation-member', [
      { originalName: 'one.png', data: png },
      { originalName: 'two.png', data: Uint8Array.from([...png, 0x02]) },
    ]);
    const pageId = upload.pages[0].id;
    const secondId = upload.pages[1].id;
    const ocrJob = db.prepare("SELECT id FROM processing_jobs WHERE page_id=? AND job_type='ocr'").get(pageId) as { id: string };
    db.prepare("INSERT INTO ocr_results(id,job_id,page_id,engine,model_version,lines_json,coord_width,coord_height) VALUES('old-ocr',?,?,'test','v1',?,100,100)")
      .run(ocrJob.id, pageId, JSON.stringify([{ text: '合成文字', box: [1, 2, 20, 30] }]));
    db.prepare("UPDATE report_pages SET ocr_rotation=0 WHERE id=?").run(pageId);
    db.prepare("UPDATE processing_jobs SET status='completed',finished_at=CURRENT_TIMESTAMP WHERE report_id=?").run(upload.reportId);
    db.prepare("UPDATE reports SET status='needs_review' WHERE id=?").run(upload.reportId);
    db.prepare("INSERT INTO processing_jobs(id,report_id,job_type,status,pipeline_version,deduplication_key,finished_at) VALUES('old-ai',?,'ai_extract','completed','health-record-v1','old-ai',CURRENT_TIMESTAMP)").run(upload.reportId);
    db.prepare("INSERT INTO report_extractions(id,report_id,job_id,provider,model,prompt_version,fields_json,raw_response_json) VALUES('old-extraction',?,'old-ai','test','test','v1','{}','{}')").run(upload.reportId);
    const sourceVersion = db.prepare("SELECT source_version AS version FROM reports WHERE id=?").get(upload.reportId)!.version;
    const before = db.prepare("SELECT job_type AS type,COUNT(*) AS n FROM processing_jobs WHERE report_id=? GROUP BY job_type").all(upload.reportId);

    const result = rotateReportPage(owner, upload.reportId, pageId, { expectedRotation: 0, rotation: 90 });
    assert.equal(result.status, 'needs_review');
    assert.equal(result.pages.find(page => page.id === pageId)?.rotation, 90);
    assert.equal(result.pages.find(page => page.id === pageId)?.ocrStale, false);
    assert.equal(result.pages.find(page => page.id === secondId)?.rotation, 0);
    const added = db.prepare("SELECT page_id AS pageId,job_type AS jobType,pipeline_version AS pipelineVersion,status FROM processing_jobs WHERE report_id=? AND pipeline_version='page-orientation-v1'").all(upload.reportId);
    assert.deepEqual(added.map(row => ({ ...row })), [{ pageId, jobType: 'thumbnail', pipelineVersion: 'page-orientation-v1', status: 'queued' }]);
    assert.deepEqual(db.prepare("SELECT job_type AS type,COUNT(*) AS n FROM processing_jobs WHERE report_id=? AND pipeline_version<>'page-orientation-v1' GROUP BY job_type").all(upload.reportId).map(row => ({ ...row })), before.map(row => ({ ...row })));
    assert.equal(db.prepare("SELECT lines_json AS lines FROM ocr_results WHERE id='old-ocr'").get()!.lines,
      JSON.stringify([{ text: '合成文字', box: [1, 2, 20, 30] }]));
    assert.equal(db.prepare("SELECT fields_json AS fields FROM report_extractions WHERE id='old-extraction'").get()!.fields, '{}');
    assert.equal(db.prepare("SELECT source_version AS version FROM reports WHERE id=?").get(upload.reportId)!.version, sourceVersion);
    const detail = await getReportPageOcrDetail(owner, upload.reportId, pageId);
    assert.equal(detail?.orientationChanged, false);
    assert.equal(detail?.lines[0]?.text, '合成文字');
    assert.deepEqual(detail?.lines[0]?.box, [1, 2, 20, 30]);
    const previewDir = join(dir, 'previews', upload.reportId);
    mkdirSync(previewDir, { recursive: true });
    writeFileSync(join(previewDir, `${pageId}.jpg`), Uint8Array.from([0xff, 0xd8, 0xff, 0x01]));
    writeFileSync(join(previewDir, `${pageId}.r90.jpg`), Uint8Array.from([0xff, 0xd8, 0xff, 0x02]));
    db.prepare("UPDATE report_pages SET mime_type='application/pdf' WHERE id=?").run(pageId);
    assert.equal((await getReportPagePreviewFile(owner, upload.reportId, pageId)).path, join(previewDir, `${pageId}.r90.jpg`));
    db.prepare("UPDATE report_pages SET mime_type='image/png' WHERE id=?").run(pageId);
    assert.throws(() => rotateReportPage(owner, upload.reportId, pageId, { expectedRotation: 90, rotation: 180 }),
      error => (error as { status?: number }).status === 409);
    let thumbnailCalls = 0;
    assert.equal(await processNextJob(async request => {
      thumbnailCalls += 1;
      assert.equal(request.action, 'thumbnail');
      assert.equal(request.rotation, 90);
      assert.equal(db.prepare("SELECT status FROM reports WHERE id=?").get(upload.reportId)!.status, 'needs_review');
      writeFileSync(request.outputPath!, Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]));
      return { ok: true, width: 100, height: 200 };
    }, async () => { throw new Error('AI must not run for orientation changes'); }), true);
    assert.equal(thumbnailCalls, 1);
    assert.equal(db.prepare("SELECT status FROM reports WHERE id=?").get(upload.reportId)!.status, 'needs_review');
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM processing_jobs WHERE report_id=? AND job_type='ai_extract'").get(upload.reportId)!.n, 1);
    const restored = rotateReportPage(owner, upload.reportId, pageId, { expectedRotation: 90, rotation: 0 });
    assert.equal(restored.pages.find(page => page.id === pageId)?.ocrStale, false);
  } finally {
    closeDatabaseForTests();
    if (previous === undefined) delete process.env.STORAGE_DIR;
    else process.env.STORAGE_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('formal v18 migration backfills old OCR orientation once and preserves installed drafts', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec("CREATE TABLE report_pages(id TEXT PRIMARY KEY,rotation INTEGER); CREATE TABLE ocr_results(page_id TEXT); INSERT INTO report_pages VALUES('old',90); INSERT INTO ocr_results VALUES('old')");
    databaseMigrations.find(m => m.version === 18)!.up(db);
    assert.deepEqual({ ...db.prepare("SELECT rotation,ocr_rotation AS ocrRotation FROM report_pages WHERE id='old'").get() }, { rotation: 90, ocrRotation: 90 });
    db.prepare("UPDATE report_pages SET rotation=180 WHERE id='old'").run();
    databaseMigrations.find(m => m.version === 18)!.up(db);
    assert.equal(db.prepare("SELECT ocr_rotation FROM report_pages WHERE id='old'").get()!.ocr_rotation, 90);
  } finally { db.close(); }
});


test('v17 installation upgrades through v18 to v19 with a backup and preserves data on repeat startup', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orientation-v18-upgrade-'));
  const previous = process.env.STORAGE_DIR;
  process.env.STORAGE_DIR = dir;
  try {
    const db = getDatabase();
    db.exec("DELETE FROM schema_migrations WHERE version>=18; ALTER TABLE report_pages DROP COLUMN ocr_rotation; INSERT INTO users(id,display_name) VALUES('migration-fixture','fixture')");
    closeDatabaseForTests();
    const upgraded = getDatabase();
    assert.equal(upgraded.prepare('SELECT MAX(version) AS v FROM schema_migrations').get()!.v, 19);
    assert.ok(upgraded.prepare('PRAGMA table_info(report_pages)').all().some(c => c.name === 'ocr_rotation'));
    assert.ok(upgraded.prepare("SELECT id FROM users WHERE id='migration-fixture'").get());
    assert.ok(readdirSync(join(dir, 'backups/db')).some(name => name.includes('v17-to-v19')));
    closeDatabaseForTests();
    assert.ok(getDatabase().prepare("SELECT id FROM users WHERE id='migration-fixture'").get());
  } finally {
    closeDatabaseForTests();
    if (previous === undefined) delete process.env.STORAGE_DIR; else process.env.STORAGE_DIR = previous;
    rmSync(dir, {recursive:true, force:true});
  }
});
