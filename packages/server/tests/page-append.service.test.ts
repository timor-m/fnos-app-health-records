import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDatabase, closeDatabaseForTests } from "../database/client";
import {
  startPageAppend,
  storePageAppendFile,
  getPageAppend,
  submitPageAppend,
  confirmPageAppend,
  cancelPageAppend,
  retryPageAppend,
  pageAppendPreview,
} from "../services/page-append.service";
import { processNextJob } from "../services/job-runner.service";
import {
  scanOrphanStorageFiles,
  runFileGarbageCollection,
} from "../services/file-gc.service";
import {
  updateReportPages,
  trashReport,
  restoreReport,
  getReportDetail,
} from "../services/records.service";
import type { RequestUser } from "../domain/request-user";
import type {
  WorkerRequest,
  WorkerResponse,
} from "../services/ocr-worker-client";
const user: RequestUser = {
  id: "append-user",
  provider: "fnos_gateway",
  authenticated: true,
  displayName: "Test",
  isGatewayAdmin: true,
};
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
const pdf = Buffer.from("%PDF-1.4\n%%EOF");
const status = (n: number) => (e: unknown) =>
  (e as { statusCode: number }).statusCode === n;
function setup() {
  const directory = mkdtempSync(join(tmpdir(), "page-append-"));
  process.env.STORAGE_DIR = directory;
  process.env.AUTH_MODE = "fnos";
  const db = getDatabase();
  db.exec(`INSERT INTO users(id,display_name) VALUES('append-user','Test'),('viewer','Viewer'),('other','Other');
 INSERT INTO user_identities(id,user_id,provider,subject) VALUES('i','append-user','fnos_gateway','append-user'),('v','viewer','fnos_gateway','viewer'),('o','other','fnos_gateway','other');
 INSERT INTO health_members(id,display_name,relationship,created_by) VALUES('member','Test','other','append-user');
 INSERT INTO member_permissions(member_id,user_id,permission,granted_by) VALUES('member','append-user','manager','append-user'),('member','viewer','viewer','append-user');
 INSERT INTO reports(id,member_id,created_by,title,report_type,status,report_issued_at) VALUES('report','member','append-user','Existing','lab','ready','2025-01-02');`);
  return {
    db,
    directory,
    cleanup() {
      closeDatabaseForTests();
      rmSync(directory, { recursive: true, force: true });
      delete process.env.STORAGE_DIR;
      delete process.env.AUTH_MODE;
    },
  };
}
function worker(calls: WorkerRequest[] = []) {
  return async (r: WorkerRequest): Promise<WorkerResponse> => {
    calls.push(r);
    if (r.outputPath) writeFileSync(r.outputPath, "preview");
    return {
      ok: true,
      pageCount: 3,
      engine: "mock",
      lines: [{ text: `Test observation ${r.pageNumber || 1} value 12 mg/L` }],
    };
  };
}
function start(data = png, key = "append-request-key-0001") {
  const b = startPageAppend(user, "report", {
    requestKey: key,
    files: [{ name: "page", size: data.length }],
  });
  return storePageAppendFile(user, "report", b.id, b.files[0]!.id, data);
}
test("staged pages are invisible; PDF subset keeps source identity; restart, duplicates and retry are idempotent", async () => {
  const env = setup();
  try {
    const calls: WorkerRequest[] = [];
    const b = start(pdf);
    assert.equal(getReportDetail(user, "report").pages.length, 0);
    await processNextJob(worker(calls));
    let ready = getPageAppend(user, "report", b.id);
    assert.equal(ready.state, "ready");
    assert.equal(ready.pages.length, 3);
    closeDatabaseForTests();
    ready = getPageAppend(user, "report", b.id);
    assert.equal(ready.pages.length, 3);
    const selection = [
      { id: ready.pages[2]!.id, rotation: 90 },
      { id: ready.pages[0]!.id, rotation: 0 },
    ];
    submitPageAppend(user, "report", b.id, selection);
    submitPageAppend(user, "report", b.id, selection);
    assert.throws(
      () => submitPageAppend(user, "report", b.id, selection.slice(1)),
      status(409),
    );
    await processNextJob(worker(calls));
    const completed = getPageAppend(user, "report", b.id);
    assert.equal(completed.state, "ocr_only");
    const rows = getDatabase()
      .prepare(
        "SELECT id,page_number,source_page_number,rotation FROM report_pages ORDER BY page_number",
      )
      .all();
    assert.deepEqual(
      rows.map((p) => [p.source_page_number, p.rotation]),
      [
        [3, 90],
        [1, 0],
      ],
    );
    assert.equal(calls.filter((c) => c.action === "ocr").length, 2);
    assert.equal(
      (
        getDatabase()
          .prepare("SELECT report_issued_at FROM reports WHERE id='report'")
          .get() as { report_issued_at: string }
      ).report_issued_at,
      "2025-01-02",
    );
    const dup = start(pdf, "append-request-key-0002");
    await processNextJob(worker());
    const draft = getPageAppend(user, "report", dup.id);
    submitPageAppend(
      user,
      "report",
      dup.id,
      draft.pages
        .filter((p) => p.sourcePageNumber !== 2)
        .map((p) => ({ id: p.id, rotation: 0 })),
    );
    assert.equal(getPageAppend(user, "report", dup.id).state, "noop");
    assert.equal(
      getDatabase().prepare("SELECT * FROM report_pages").all().length,
      2,
    );
  } finally {
    env.cleanup();
  }
});
test("viewer/admin cannot stage or preview, cross-account access denied; revocation stops unpublished work", async () => {
  const env = setup();
  try {
    const viewer = { ...user, id: "viewer" },
      other = { ...user, id: "other" };
    assert.throws(
      () =>
        startPageAppend(viewer, "report", {
          requestKey: "viewer-request-0001",
          files: [{ name: "x", size: png.length }],
        }),
      status(403),
    );
    assert.throws(
      () =>
        startPageAppend(other, "report", {
          requestKey: "other-request-0001",
          files: [{ name: "x", size: png.length }],
        }),
      status(403),
    );
    const b = start();
    await processNextJob(worker());
    assert.throws(() => getPageAppend(viewer, "report", b.id), status(403));
    assert.throws(
      () =>
        pageAppendPreview(
          viewer,
          "report",
          b.id,
          getPageAppend(user, "report", b.id).pages[0]!.id,
        ),
      status(403),
    );
    const ready = getPageAppend(user, "report", b.id);
    submitPageAppend(
      user,
      "report",
      b.id,
      ready.pages.map((p) => ({ id: p.id, rotation: 0 })),
    );
    env.db.exec("DELETE FROM member_permissions WHERE user_id='append-user'");
    let calls = 0;
    await processNextJob(async () => {
      calls++;
      return { ok: true };
    });
    assert.equal(calls, 0);
    assert.equal(env.db.prepare("SELECT * FROM report_pages").all().length, 0);
  } finally {
    env.cleanup();
  }
});
test("draft files survive orphan GC, conflicting operations are blocked, cancellation releases lock", async () => {
  const env = setup();
  try {
    const b = start();
    await processNextJob(worker());
    const ready = getPageAppend(user, "report", b.id);
    const path = pageAppendPreview(user, "report", b.id, ready.pages[0]!.id);
    assert.ok(existsSync(path));
    scanOrphanStorageFiles(-1);
    runFileGarbageCollection();
    assert.ok(existsSync(path));
    assert.throws(
      () => updateReportPages(user, "report", { pages: [] }),
      status(409),
    );
    cancelPageAppend(user, "report", b.id);
    assert.equal(getPageAppend(user, "report", b.id).state, "cancelled");
    assert.ok(start(png, "append-request-key-0002"));
  } finally {
    env.cleanup();
  }
});
test("failed OCR can resume without rerunning completed pages; conflicts wait for explicit confirmation", async () => {
  const env = setup();
  try {
    const b = start(pdf);
    await processNextJob(worker());
    let ready = getPageAppend(user, "report", b.id);
    submitPageAppend(
      user,
      "report",
      b.id,
      ready.pages.map((p) => ({ id: p.id, rotation: 0 })),
    );
    let n = 0;
    await processNextJob(async (r) => {
      n++;
      if (n === 2) throw new Error("failure");
      return worker()(r);
    });
    assert.equal(getPageAppend(user, "report", b.id).state, "failed");
    assert.equal(
      getPageAppend(user, "report", b.id).pages.filter((p) => p.ocrComplete)
        .length,
      1,
    );
    retryPageAppend(user, "report", b.id);
    const calls: WorkerRequest[] = [];
    await processNextJob(worker(calls));
    assert.equal(calls.length, 2);
    assert.equal(getPageAppend(user, "report", b.id).state, "ocr_only");
  } finally {
    env.cleanup();
  }
});

import { saveAiSettings } from "../services/ai-settings.service";
import {
  normalizeAiExtraction,
  persistAiExtraction,
  type AiExecutor,
} from "../services/ai-extraction.service";
import {
  deleteManualObservation,
  createManualObservation,
} from "../services/observation-field-overrides.service";
const oldQuote = "白细胞计数 5.0 10^9/L",
  newQuote = "红细胞计数 4.5 10^12/L";
function observation(
  name: string,
  value: number,
  unit: string,
  pageNumber: number,
  quote: string,
) {
  return {
    itemName: name,
    resultText: String(value),
    numericValue: value,
    unit,
    evidence: [{ pageNumber, quote }],
  };
}
function extraction(observations: unknown[]) {
  return {
    provider: "test",
    model: "test",
    promptVersion: "test",
    ...normalizeAiExtraction({ observations }),
    rawResponseJson: "{}",
    promptTokens: 1,
    completionTokens: 1,
    elapsedMs: 1,
  };
}
function seedOld() {
  const db = getDatabase();
  db.exec(`INSERT INTO report_pages(id,report_id,page_number,original_name,storage_path,mime_type,file_size,sha256) VALUES('old-page','report',1,'old','reports/old.png','image/png',9,'oldhash');
 INSERT INTO processing_jobs(id,report_id,page_id,job_type,pipeline_version,deduplication_key,status) VALUES('old-ocr','report','old-page','ocr','upload-v1','old-ocr','completed');
 INSERT INTO processing_jobs(id,report_id,job_type,pipeline_version,deduplication_key,status) VALUES('old-ai','report','ai_extract','upload-v1','old-ai','completed');`);
  db.prepare(
    "INSERT INTO ocr_results(id,job_id,page_id,engine,model_version,lines_json) VALUES(?,?,?,?,?,?)",
  ).run(
    "old-text",
    "old-ocr",
    "old-page",
    "mock",
    "mock",
    JSON.stringify([
      { text: oldQuote, confidence: 0.99, box: [0, 0, 200, 20] },
    ]),
  );
  persistAiExtraction(
    "report",
    "old-ai",
    extraction([observation("白细胞计数", 5, "10^9/L", 1, oldQuote)]),
    40,
  );
  assert.equal(db.prepare("SELECT * FROM observations").all().length, 1);
}
const newWorker = async (r: WorkerRequest): Promise<WorkerResponse> => {
  if (r.outputPath) writeFileSync(r.outputPath, "preview");
  return {
    ok: true,
    pageCount: 1,
    engine: "mock",
    lines: [{ text: newQuote, confidence: 0.99, box: [0, 0, 200, 20] }],
  };
};
async function publishNew(pageWorker = newWorker) {
  const b = start();
  await processNextJob(pageWorker);
  const ready = getPageAppend(user, "report", b.id);
  submitPageAppend(
    user,
    "report",
    b.id,
    ready.pages.map((p) => ({ id: p.id, rotation: 0 })),
  );
  await processNextJob(pageWorker);
  return b;
}
test("full pipeline sends old and new OCR to AI, publishes both observations and preserves dates", async () => {
  const env = setup();
  try {
    seedOld();
    saveAiSettings({
      enabled: true,
      baseUrl: "https://ai.example.test/v1",
      textModel: "test",
      apiKey: "test-secret",
    });
    const b = await publishNew();
    assert.equal(getPageAppend(user, "report", b.id).state, "ai");
    let input = "";
    const ai: AiExecutor = async (request) => {
      input += request.text;
      return extraction([
        observation("白细胞计数", 5, "10^9/L", 1, oldQuote),
        observation("红细胞计数", 4.5, "10^12/L", 2, newQuote),
      ]);
    };
    await processNextJob(newWorker, ai);
    assert.ok(input.includes("白细胞计数"));
    assert.ok(input.includes("红细胞计数"));
    assert.equal(getPageAppend(user, "report", b.id).state, "complete");
    const progress = getPageAppend(user, "report", b.id).aiProgress!;
    assert.ok(progress.total > 0);
    assert.equal(progress.completed, progress.total);
    assert.equal(env.db.prepare("SELECT * FROM observations").all().length, 2);
    assert.equal(getReportDetail(user, "report").pages.length, 2);
  } finally {
    env.cleanup();
  }
});
test("post-filter loss of old observation rolls back all candidate publication; AI failure retains data", async () => {
  const env = setup();
  try {
    seedOld();
    const before = env.db.prepare("SELECT * FROM observations").all();
    saveAiSettings({
      enabled: true,
      baseUrl: "https://ai.example.test/v1",
      textModel: "test",
      apiKey: "test-secret",
    });
    const b = await publishNew();
    const job = (
      env.db
        .prepare("SELECT job_id FROM report_page_appends WHERE id=?")
        .get(b.id) as { job_id: string }
    ).job_id;
    env.db
      .prepare(
        "INSERT INTO ai_extraction_units(id,job_id,report_id,plan_hash,unit_key,unit_index,unit_type,input_hash,character_count,status,result_json) VALUES('candidate-unit',?,'report','test','test',0,'complete_pages','test',1,'completed','{}')",
      )
      .run(job);
    assert.throws(
      () => persistAiExtraction("report", job, extraction([]), 30),
      status(409),
    );
    assert.deepEqual(
      env.db.prepare("SELECT * FROM observations").all(),
      before,
    );
    assert.equal(
      env.db.prepare("SELECT * FROM report_extractions WHERE job_id=?").all(job)
        .length,
      0,
    );
    await processNextJob(newWorker, async () => {
      throw new Error("provider unavailable");
    });
    assert.equal(getPageAppend(user, "report", b.id).state, "failed");
    assert.deepEqual(
      env.db.prepare("SELECT * FROM observations").all(),
      before,
    );
    assert.equal(getReportDetail(user, "report").pages.length, 2);
    retryPageAppend(user, "report", b.id, true);
    assert.equal(getPageAppend(user, "report", b.id).state, "ocr_only");
  } finally {
    env.cleanup();
  }
});
test("deleted observations have stable suppression across later AI extraction", () => {
  const env = setup();
  try {
    seedOld();
    const old = (
      env.db.prepare("SELECT id FROM observations").get() as { id: string }
    ).id;
    deleteManualObservation(user, "report", old);
    env.db.exec(
      "INSERT INTO processing_jobs(id,report_id,job_type,pipeline_version,deduplication_key,status) VALUES('later-ai','report','ai_extract','manual-ai-v1','later-ai','completed')",
    );
    persistAiExtraction(
      "report",
      "later-ai",
      extraction([observation("白细胞计数", 5, "10^9/L", 1, oldQuote)]),
      40,
    );
    assert.equal(env.db.prepare("SELECT * FROM observations").all().length, 0);
  } finally {
    env.cleanup();
  }
});

test("same-text cross-format pages require confirmation and remain invisible before it", async () => {
  const env = setup();
  try {
    seedOld();
    const b = start();
    const oldTextWorker = async (r: WorkerRequest) => ({
      ...(await worker()(r)),
      lines: [{ text: oldQuote, confidence: 0.99, box: [0, 0, 200, 20] }],
    });
    await processNextJob(oldTextWorker);
    let ready = getPageAppend(user, "report", b.id);
    submitPageAppend(
      user,
      "report",
      b.id,
      ready.pages.map((p) => ({ id: p.id, rotation: 0 })),
    );
    await processNextJob(oldTextWorker);
    ready = getPageAppend(user, "report", b.id);
    assert.equal(ready.state, "review");
    assert.equal(getReportDetail(user, "report").pages.length, 1);
    assert.ok(ready.conflicts.length);
    confirmPageAppend(user, "report", b.id);
    confirmPageAppend(user, "report", b.id);
    assert.equal(getReportDetail(user, "report").pages.length, 2);
  } finally {
    env.cleanup();
  }
});
test("identity conflict holds new pages; missing old OCR is repaired once", async () => {
  const env = setup();
  try {
    seedOld();
    env.db
      .prepare("UPDATE ocr_results SET lines_json=?")
      .run(JSON.stringify([{ text: "姓名：合成甲 报告编号：TEST-A" }]));
    const b = start();
    const conflicting = async (r: WorkerRequest) => ({
      ...(await worker()(r)),
      lines: [{ text: "姓名：合成乙 报告编号：TEST-B" }],
    });
    await processNextJob(conflicting);
    const ready = getPageAppend(user, "report", b.id);
    submitPageAppend(
      user,
      "report",
      b.id,
      ready.pages.map((p) => ({ id: p.id, rotation: 0 })),
    );
    await processNextJob(conflicting);
    assert.equal(getPageAppend(user, "report", b.id).state, "review");
    assert.ok(
      getPageAppend(user, "report", b.id).conflicts.some((c) =>
        c.includes("姓名"),
      ),
    );
    cancelPageAppend(user, "report", b.id);
    env.db.exec("DELETE FROM ocr_results");
    const another = start(Buffer.from([...png, 2]), "append-request-key-0003");
    await processNextJob(worker());
    const r = getPageAppend(user, "report", another.id);
    submitPageAppend(
      user,
      "report",
      another.id,
      r.pages.map((p) => ({ id: p.id, rotation: 0 })),
    );
    const calls: WorkerRequest[] = [];
    await processNextJob(worker(calls));
    assert.equal(calls.filter((c) => c.action === "ocr").length, 2);
  } finally {
    env.cleanup();
  }
});
test("concurrent SQL page edits and generic jobs are rejected by database; stale AI input is rejected", async () => {
  const env = setup();
  try {
    seedOld();
    saveAiSettings({
      enabled: true,
      baseUrl: "https://ai.example.test/v1",
      textModel: "test",
      apiKey: "test-secret",
    });
    const b = await publishNew();
    assert.throws(
      () =>
        env.db.exec("UPDATE report_pages SET rotation=90 WHERE id='old-page'"),
      /PAGE_APPEND_BUSY/,
    );
    assert.throws(
      () =>
        env.db.exec(
          "INSERT INTO processing_jobs(id,report_id,job_type,pipeline_version,deduplication_key) VALUES('race','report','ai_extract','manual-ai-v1','race')",
        ),
      /PAGE_APPEND_BUSY/,
    );
    const before = env.db.prepare("SELECT * FROM observations").all();
    await processNextJob(newWorker, async () => {
      env.db.exec("UPDATE reports SET summary='manual edit' WHERE id='report'");
      return extraction([
        observation("白细胞计数", 5, "10^9/L", 1, oldQuote),
        observation("红细胞计数", 4.5, "10^12/L", 2, newQuote),
      ]);
    });
    assert.equal(getPageAppend(user, "report", b.id).state, "failed");
    assert.deepEqual(
      env.db.prepare("SELECT * FROM observations").all(),
      before,
    );
    assert.equal(
      env.db.prepare("SELECT summary FROM reports WHERE id='report'").get()!
        .summary,
      "manual edit",
    );
  } finally {
    env.cleanup();
  }
});
import {
  createFullBackup,
  preflightStoredBackup,
  restoreBackup,
  listTrendSeries,
} from "../services/records.service";
import { readdirSync } from "node:fs";
test("backup and same-instance restore preserve draft files, owner and selected PDF pages", async () => {
  const env = setup();
  try {
    const b = start(pdf);
    await processNextJob(worker());
    const ready = getPageAppend(user, "report", b.id);
    const preview = pageAppendPreview(user, "report", b.id, ready.pages[0]!.id);
    const backup = createFullBackup(user);
    cancelPageAppend(user, "report", b.id);
    const plan = preflightStoredBackup(user, backup.id);
    restoreBackup(user, backup.id, plan.token);
    const restored = getPageAppend(user, "report", b.id);
    assert.equal(restored.state, "ready");
    assert.equal(restored.pages.length, 3);
    assert.ok(existsSync(preview));
    assert.equal(
      getDatabase().prepare("SELECT * FROM reports").all().length,
      1,
    );
  } finally {
    env.cleanup();
  }
});
test("existing v17 database receives unnumbered draft with backup and no schema increment", () => {
  const env = setup();
  try {
    env.db.exec(
      `DROP TRIGGER page_append_job_lock;DROP TRIGGER page_append_page_update_lock;DROP TRIGGER page_append_page_delete_lock;DROP TRIGGER page_append_report_lock;DROP TABLE observation_suppressions;DROP TABLE report_page_append_pages;DROP TABLE report_page_append_files;DROP TABLE report_page_appends;`,
    );
    closeDatabaseForTests();
    const db = getDatabase();
    assert.ok(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE name='report_page_appends'",
        )
        .get(),
    );
    assert.equal(
      db.prepare("SELECT MAX(version) AS n FROM schema_migrations").get()!.n,
      17,
    );
    assert.ok(
      readdirSync(join(env.directory, "backups/db")).some((name) =>
        name.includes("v17-to-v17"),
      ),
    );
    assert.equal(db.prepare("SELECT * FROM reports").all().length, 1);
  } finally {
    env.cleanup();
  }
});

import { updateManualObservation } from "../services/observation-field-overrides.service";
test("manual edits and manually added observations survive whole-report append recognition", async () => {
  const env = setup();
  try {
    seedOld();
    const id = env.db.prepare("SELECT id FROM observations").get()!
      .id as string;
    updateManualObservation(user, "report", id, {
      itemName: "白细胞计数",
      resultText: "人工校对 5",
      numericValue: 5,
      unit: "10^9/L",
    });
    createManualObservation(user, "report", {
      itemName: "合成手工项",
      resultText: "手动记录",
    });
    saveAiSettings({
      enabled: true,
      baseUrl: "https://ai.example.test/v1",
      textModel: "test",
      apiKey: "test-secret",
    });
    const b = await publishNew();
    await processNextJob(newWorker, async () =>
      extraction([
        observation("白细胞计数", 5, "10^9/L", 1, oldQuote),
        observation("红细胞计数", 4.5, "10^12/L", 2, newQuote),
      ]),
    );
    assert.equal(getPageAppend(user, "report", b.id).state, "complete");
    const observations = getReportDetail(user, "report").observations;
    assert.equal(observations.length, 3);
    assert.ok(observations.some((o) => o.resultText === "人工校对 5"));
    assert.ok(observations.some((o) => o.itemName === "合成手工项"));
    assert.ok(
      listTrendSeries(user, "member").some((series) =>
        series.points.some((point) => point.reportId === "report"),
      ),
    );
  } finally {
    env.cleanup();
  }
});
test("repeated callback after AI commit is idempotent and idle revoked drafts do not lock other managers", async () => {
  const env = setup();
  try {
    seedOld();
    saveAiSettings({
      enabled: true,
      baseUrl: "https://ai.example.test/v1",
      textModel: "test",
      apiKey: "test-secret",
    });
    const b = await publishNew();
    await processNextJob(newWorker, async () =>
      extraction([
        observation("白细胞计数", 5, "10^9/L", 1, oldQuote),
        observation("红细胞计数", 4.5, "10^12/L", 2, newQuote),
      ]),
    );
    const old = getReportDetail(user, "report");
    env.db
      .prepare(
        "UPDATE processing_jobs SET status='queued' WHERE id=(SELECT job_id FROM report_page_appends WHERE id=?)",
      )
      .run(b.id);
    let calls = 0;
    await processNextJob(newWorker, async () => {
      calls++;
      return extraction([]);
    });
    assert.equal(calls, 0);
    assert.equal(
      getReportDetail(user, "report").observations.length,
      old.observations.length,
    );
    const draft = start(png, "append-request-key-0010");
    await processNextJob(worker());
    env.db.exec(
      "UPDATE member_permissions SET permission='manager' WHERE user_id='viewer'; DELETE FROM member_permissions WHERE user_id='append-user'",
    );
    const replacement = startPageAppend({ ...user, id: "viewer" }, "report", {
      requestKey: "replacement-request-0001",
      files: [{ name: "x", size: png.length }],
    });
    assert.ok(replacement.id);
    assert.equal(
      env.db
        .prepare("SELECT state FROM report_page_appends WHERE id=?")
        .get(draft.id)!.state,
      "cancelled",
    );
  } finally {
    env.cleanup();
  }
});

import { importPageAppendFiles } from "../services/page-append.service";
import { listLocalImportRoots } from "../services/local-file-import.service";
import { readFileSync } from "node:fs";
test("authorized directory import copies into append staging and never modifies the source", async () => {
  const env = setup();
  const source = mkdtempSync(join(tmpdir(), "append-import-"));
  try {
    process.env.AUTH_MODE = "local";
    process.env.IMPORT_ROOTS = source;
    writeFileSync(join(source, "synthetic.png"), png);
    const root = listLocalImportRoots()[0]!;
    const b = await importPageAppendFiles(user, "report", {
      requestKey: "nas-append-request-0001",
      files: [{ rootId: root.id, path: "synthetic.png" }],
    });
    assert.equal(b.state, "preparing");
    assert.deepEqual(readFileSync(join(source, "synthetic.png")), png);
    assert.equal(env.db.prepare("SELECT * FROM reports").all().length, 1);
    assert.equal(env.db.prepare("SELECT * FROM report_pages").all().length, 0);
    await assert.rejects(
      importPageAppendFiles(user, "report", {
        requestKey: "nas-append-request-0002",
        files: [{ rootId: root.id, path: "../outside.png" }],
      }),
    );
  } finally {
    delete process.env.IMPORT_ROOTS;
    rmSync(source, { recursive: true, force: true });
    env.cleanup();
  }
});

test("expired leases surface retryable phase failure; cancellation fences in-flight OCR callbacks", async () => {
  const env = setup();
  try {
    const b = start();
    env.db
      .prepare(
        "UPDATE processing_jobs SET status='processing',attempts=3,lease_expires_at=datetime('now','-1 minute') WHERE id=(SELECT job_id FROM report_page_appends WHERE id=?)",
      )
      .run(b.id);
    await processNextJob(worker());
    assert.equal(getPageAppend(user, "report", b.id).state, "failed");
    retryPageAppend(user, "report", b.id);
    await processNextJob(worker());
    const ready = getPageAppend(user, "report", b.id);
    assert.equal(ready.state, "ready");
    submitPageAppend(
      user,
      "report",
      b.id,
      ready.pages.map((p) => ({ id: p.id, rotation: 0 })),
    );
    let done!: (value: WorkerResponse) => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const running = processNextJob(async () => {
      started();
      return new Promise<WorkerResponse>((resolve) => {
        done = resolve;
      });
    });
    await entered;
    cancelPageAppend(user, "report", b.id);
    done({ ok: true, lines: [{ text: "late callback" }] });
    await running;
    assert.equal(getPageAppend(user, "report", b.id).state, "cancelled");
    assert.equal(env.db.prepare("SELECT * FROM report_pages").all().length, 0);
  } finally {
    env.cleanup();
  }
});

test("review allows excluding suspect pages and enforces idempotent confirmation scope", async () => {
  const env = setup();
  try {
    seedOld();
    const b = start(pdf);
    const same = async (r: WorkerRequest) => ({
      ...(await worker()(r)),
      lines: [{ text: oldQuote, confidence: 0.99, box: [0, 0, 200, 20] }],
    });
    await processNextJob(same);
    const ready = getPageAppend(user, "report", b.id);
    submitPageAppend(
      user,
      "report",
      b.id,
      ready.pages.map((p) => ({ id: p.id, rotation: 0 })),
    );
    await processNextJob(same);
    assert.equal(getPageAppend(user, "report", b.id).state, "review");
    const kept = [ready.pages[1]!.id];
    confirmPageAppend(user, "report", b.id, kept);
    confirmPageAppend(user, "report", b.id, kept);
    assert.throws(
      () => confirmPageAppend(user, "report", b.id, [ready.pages[0]!.id]),
      status(409),
    );
    const detail = getReportDetail(user, "report");
    assert.equal(detail.pages.length, 2);
    assert.equal(detail.pages[0]!.id, "old-page");
    assert.equal(detail.pages[1]!.id, kept[0]);
  } finally {
    env.cleanup();
  }
});

test("a post-publication index failure retries indexing without repeating AI or claiming completion", async () => {
  const env = setup();
  try {
    seedOld();
    saveAiSettings({
      enabled: true,
      baseUrl: "https://ai.example.test/v1",
      textModel: "test",
      apiKey: "test-secret",
    });
    const b = await publishNew();
    env.db.exec(
      "CREATE TRIGGER fail_append_index BEFORE INSERT ON observation_normalizations BEGIN SELECT RAISE(ABORT,'synthetic index failure'); END",
    );
    await processNextJob(newWorker, async () =>
      extraction([
        observation("白细胞计数", 5, "10^9/L", 1, oldQuote),
        observation("红细胞计数", 4.5, "10^12/L", 2, newQuote),
      ]),
    );
    assert.equal(getPageAppend(user, "report", b.id).state, "failed");
    assert.equal(env.db.prepare("SELECT * FROM observations").all().length, 2);
    env.db.exec("DROP TRIGGER fail_append_index");
    retryPageAppend(user, "report", b.id);
    let calls = 0;
    await processNextJob(newWorker, async () => {
      calls++;
      return extraction([]);
    });
    assert.equal(calls, 0);
    assert.equal(getPageAppend(user, "report", b.id).state, "complete");
    assert.equal(
      env.db.prepare("SELECT * FROM observation_normalizations").all().length,
      2,
    );
  } finally {
    env.cleanup();
  }
});

import {
  snapshotPublishedRecords,
  assertPublishedRecordsRetained,
} from "../services/page-append-result-guard.service";
test("ablation: omitting the published baseline admits a destructive candidate, retaining it prevents loss", () => {
  const env = setup();
  try {
    seedOld();
    const baseline = snapshotPublishedRecords("report");
    env.db.exec("BEGIN IMMEDIATE");
    try {
      env.db.exec("DELETE FROM observations WHERE report_id='report'");
      assert.doesNotThrow(() => assertPublishedRecordsRetained("report", []));
      assert.throws(
        () => assertPublishedRecordsRetained("report", baseline),
        status(409),
      );
    } finally {
      env.db.exec("ROLLBACK");
    }
    assert.equal(env.db.prepare("SELECT * FROM observations").all().length, 1);
  } finally {
    env.cleanup();
  }
});

import { permanentlyDeleteReport } from "../services/records.service";
test("manual permanent deletion immediately collects cancelled append originals and previews", async () => {
  const env = setup();
  try {
    const b = start();
    await processNextJob(worker());
    const ready = getPageAppend(user, "report", b.id);
    const preview = pageAppendPreview(user, "report", b.id, ready.pages[0]!.id);
    const original = join(
      env.directory,
      env.db
        .prepare(
          "SELECT storage_path FROM report_page_append_files WHERE batch_id=?",
        )
        .get(b.id)!.storage_path as string,
    );
    cancelPageAppend(user, "report", b.id);
    trashReport(user, "report");
    const result = permanentlyDeleteReport(user, "report");
    assert.equal(result.pendingFileCount, 0);
    assert.equal(existsSync(original), false);
    assert.equal(existsSync(preview), false);
    assert.equal(
      env.db.prepare("SELECT * FROM report_page_appends").all().length,
      0,
    );
  } finally {
    env.cleanup();
  }
});

import {
  getReportOriginalDownload,
  getReportOriginalDownloadInfo,
  getReportOriginalExportStatus,
  getReportPageFile,
  getReportPageOriginalDownload,
} from "../services/records.service";
test("partial PDF cannot leak unselected source pages through either original download API", async () => {
  const env = setup();
  try {
    const b = start(pdf);
    await processNextJob(worker());
    const ready = getPageAppend(user, "report", b.id);
    const page = ready.pages[1]!;
    submitPageAppend(user, "report", b.id, [{ id: page.id, rotation: 0 }]);
    await processNextJob(worker());
    const viewer = { ...user, id: "viewer" };
    assert.equal(
      getReportOriginalDownloadInfo(viewer, "report").directPath,
      null,
    );
    assert.equal(
      getReportOriginalExportStatus(viewer, "report").status,
      "available",
    );
    await assert.rejects(
      getReportOriginalDownload(viewer, "report"),
      status(409),
    );
    assert.throws(
      () => getReportPageFile(viewer, "report", page.id, "original"),
      status(409),
    );
    const raw = env.db
      .prepare("SELECT storage_path FROM report_pages WHERE id=?")
      .get(page.id)!.storage_path as string;
    let calls = 0;
    const file = await getReportPageOriginalDownload(
      viewer,
      "report",
      page.id,
      async (request) => {
        calls++;
        assert.equal(request.action, "assemble_pdf");
        assert.equal(request.pages?.length, 1);
        assert.equal(request.pages?.[0]!.sourcePageNumber, 2);
        writeFileSync(request.outputPath!, "%PDF-selected-page-only");
        return { ok: true };
      },
    );
    assert.notEqual(file.path, join(env.directory, raw));
    assert.equal(readFileSync(file.path, "utf8"), "%PDF-selected-page-only");
    await getReportPageOriginalDownload(viewer, "report", page.id, async () => {
      calls++;
      return { ok: true };
    });
    assert.equal(calls, 1);
    assert.throws(
      () => getReportPageFile(viewer, "report", ready.pages[0]!.id, "original"),
      status(404),
    );
  } finally {
    env.cleanup();
  }
});

test("morphology guard permits rebuilding automatic tracking but preserves manual groups and findings", () => {
  const env = setup();
  try {
    env.db.exec(
      "INSERT INTO morphology_findings(id,report_id,finding_type,finding_name,raw_text,tracking_group_id,match_confidence) VALUES('finding','report','other','Synthetic finding','Synthetic finding','automatic-group',0.9)",
    );
    const baseline = snapshotPublishedRecords("report");
    env.db.exec(
      "UPDATE morphology_findings SET tracking_group_id=NULL,match_confidence=NULL",
    );
    assert.doesNotThrow(() =>
      assertPublishedRecordsRetained("report", baseline),
    );
    env.db.exec(
      "UPDATE morphology_findings SET finding_name='Changed finding'",
    );
    assert.throws(
      () => assertPublishedRecordsRetained("report", baseline),
      status(409),
    );
    env.db.exec(
      `UPDATE morphology_findings SET finding_name='Synthetic finding',tracking_group_id='manual-group',manual_fields_json='["trackingGroup"]'`,
    );
    const manual = snapshotPublishedRecords("report");
    env.db.exec("UPDATE morphology_findings SET tracking_group_id=NULL");
    assert.throws(
      () => assertPublishedRecordsRetained("report", manual),
      status(409),
    );
  } finally {
    env.cleanup();
  }
});

test("append retries only missing candidates once and publishes retained facts with review warnings", async () => {
  const env = setup();
  try {
    seedOld();
    saveAiSettings({
      enabled: true,
      baseUrl: "https://ai.example.test/v1",
      textModel: "test",
      apiKey: "test-secret",
      extractionDepth: "overview",
    });
    const extra = "神经元特异性烯醇化酶 12.5 ng/mL 参考范围 0-16.3";
    const pageWorker = async (r: WorkerRequest): Promise<WorkerResponse> => ({
      ...(await newWorker(r)),
      lines: [
        { text: newQuote, confidence: 0.99, box: [0, 0, 200, 20] },
        { text: extra, confidence: 0.99, box: [0, 30, 300, 50] },
      ],
    });
    const b = await publishNew(pageWorker);
    let main = 0,
      supplements = 0;
    await processNextJob(pageWorker, async (input) => {
      if (input.text.includes("遗漏候选补提取")) {
        supplements++;
        assert.ok(input.text.includes(extra));
        return extraction([]);
      }
      main++;
      return extraction([
        observation("白细胞计数", 5, "10^9/L", 1, oldQuote),
        observation("红细胞计数", 4.5, "10^12/L", 2, newQuote),
      ]);
    });
    const result = getPageAppend(user, "report", b.id);
    assert.equal(result.state, "complete");
    assert.equal(main, 1);
    assert.equal(supplements, 1);
    assert.ok(result.reviewWarnings.some((w) => w.includes("第 2 页")));
    assert.equal(env.db.prepare("SELECT * FROM observations").all().length, 2);
    assert.deepEqual(
      getReportDetail(user, "report").pageAppend?.reviewWarnings,
      result.reviewWarnings,
    );
    assert.equal(
      env.db
        .prepare(
          "SELECT status FROM processing_jobs WHERE id=(SELECT job_id FROM report_page_appends WHERE id=?)",
        )
        .get(b.id)!.status,
      "completed",
    );
    assert.doesNotThrow(() =>
      start(
        Buffer.concat([png, Buffer.from("another")]),
        "append-request-warning-next",
      ),
    );
  } finally {
    env.cleanup();
  }
});

test("a successful missing-fragment supplement completes without pending review", async () => {
  const env = setup();
  try {
    seedOld();
    saveAiSettings({
      enabled: true,
      baseUrl: "https://ai.example.test/v1",
      textModel: "test",
      apiKey: "test-secret",
      extractionDepth: "overview",
    });
    const extra = "神经元特异性烯醇化酶 12.5 ng/mL 参考范围 0-16.3";
    const pageWorker = async (r: WorkerRequest): Promise<WorkerResponse> => ({
      ...(await newWorker(r)),
      lines: [
        { text: newQuote, confidence: 0.99, box: [0, 0, 200, 20] },
        { text: extra, confidence: 0.99, box: [0, 30, 300, 50] },
      ],
    });
    const b = await publishNew(pageWorker);
    let supplements = 0;
    await processNextJob(pageWorker, async (input) => {
      if (input.text.includes("遗漏候选补提取")) {
        supplements++;
        return extraction([
          observation("神经元特异性烯醇化酶", 12.5, "ng/mL", 2, extra),
        ]);
      }
      return extraction([
        observation("白细胞计数", 5, "10^9/L", 1, oldQuote),
        observation("红细胞计数", 4.5, "10^12/L", 2, newQuote),
      ]);
    });
    assert.equal(supplements, 1);
    assert.equal(getPageAppend(user, "report", b.id).state, "complete");
    assert.deepEqual(getPageAppend(user, "report", b.id).reviewWarnings, []);
    assert.equal(env.db.prepare("SELECT * FROM observations").all().length, 3);
  } finally {
    env.cleanup();
  }
});

test("empty AI output without verifiable facts remains failed", async () => {
  const env = setup();
  try {
    saveAiSettings({
      enabled: true,
      baseUrl: "https://ai.example.test/v1",
      textModel: "test",
      apiKey: "test-secret",
    });
    const pageWorker = async (r: WorkerRequest): Promise<WorkerResponse> => ({
      ...(await newWorker(r)),
      lines: [
        {
          text: "神经元特异性烯醇化酶 12.5 ng/mL 参考范围 0-16.3",
          confidence: 0.99,
          box: [0, 0, 200, 20],
        },
      ],
    });
    const b = await publishNew(pageWorker);
    await processNextJob(pageWorker, async () => extraction([]));
    assert.equal(getPageAppend(user, "report", b.id).state, "failed");
    assert.match(getPageAppend(user, "report", b.id).error!, /未获得可验证/);
    assert.equal(
      env.db.prepare("SELECT * FROM report_extractions").all().length,
      0,
    );
  } finally {
    env.cleanup();
  }
});

test("trashing a report stops an in-flight append AI and rejects its late result after restore", async () => {
  const env = setup();
  try {
    seedOld();
    saveAiSettings({
      enabled: true,
      baseUrl: "https://ai.example.test/v1",
      textModel: "test",
      apiKey: "test-secret",
    });
    const b = await publishNew();
    let release!: (r: ReturnType<typeof extraction>) => void;
    let entered!: () => void;
    const started = new Promise<void>((r) => {
      entered = r;
    });
    const running = processNextJob(newWorker, async () => {
      entered();
      return new Promise<ReturnType<typeof extraction>>((r) => {
        release = r;
      });
    });
    await started;
    assert.throws(
      () => trashReport({ ...user, id: "viewer" }, "report"),
      status(403),
    );
    assert.equal(trashReport(user, "report").status, "trashed");
    assert.equal(
      env.db
        .prepare("SELECT state FROM report_page_appends WHERE id=?")
        .get(b.id)!.state,
      "ocr_only",
    );
    restoreReport(user, "report");
    release(
      extraction([
        observation("白细胞计数", 5, "10^9/L", 1, oldQuote),
        observation("红细胞计数", 4.5, "10^12/L", 2, newQuote),
      ]),
    );
    await running;
    assert.equal(env.db.prepare("SELECT * FROM observations").all().length, 1);
    assert.equal(
      env.db
        .prepare(
          "SELECT status FROM processing_jobs WHERE id=(SELECT job_id FROM report_page_appends WHERE id=?)",
        )
        .get(b.id)!.status,
      "cancelled",
    );
    assert.equal(
      env.db.prepare("SELECT status FROM reports WHERE id='report'").get()!
        .status,
      "needs_review",
    );
  } finally {
    env.cleanup();
  }
});

test("trashing failed or unpublished appends releases locks and permanent deletion removes their files", async () => {
  const env = setup();
  try {
    const b = start();
    await processNextJob(worker());
    const storage = env.db
      .prepare(
        "SELECT storage_path FROM report_page_append_files WHERE batch_id=?",
      )
      .get(b.id)!.storage_path as string;
    env.db
      .prepare("UPDATE report_page_appends SET state='failed' WHERE id=?")
      .run(b.id);
    env.db.exec(
      "CREATE TRIGGER prevent_test_trash BEFORE UPDATE OF status ON reports WHEN NEW.status='trashed' BEGIN SELECT RAISE(ABORT,'synthetic failure'); END",
    );
    assert.throws(() => trashReport(user, "report"));
    assert.equal(
      env.db
        .prepare("SELECT state FROM report_page_appends WHERE id=?")
        .get(b.id)!.state,
      "failed",
    );
    env.db.exec("DROP TRIGGER prevent_test_trash");
    trashReport(user, "report");
    assert.equal(
      env.db
        .prepare("SELECT state FROM report_page_appends WHERE id=?")
        .get(b.id)!.state,
      "cancelled",
    );
    assert.equal(permanentlyDeleteReport(user, "report").pendingFileCount, 0);
    assert.equal(existsSync(join(env.directory, storage)), false);
  } finally {
    env.cleanup();
  }
});

test("trashing during append OCR prevents late pages from being published", async () => {
  const env = setup();
  try {
    const b = start();
    await processNextJob(worker());
    const draft = getPageAppend(user, "report", b.id);
    submitPageAppend(
      user,
      "report",
      b.id,
      draft.pages.map((p) => ({ id: p.id, rotation: 0 })),
    );
    let release!: (r: WorkerResponse) => void;
    let enter!: () => void;
    const started = new Promise<void>((r) => {
      enter = r;
    });
    const running = processNextJob(async () => {
      enter();
      return new Promise<WorkerResponse>((r) => {
        release = r;
      });
    });
    await started;
    trashReport(user, "report");
    release({ ok: true, lines: [{ text: "Synthetic late OCR" }] });
    await running;
    assert.equal(
      env.db.prepare("SELECT status FROM reports WHERE id='report'").get()!
        .status,
      "trashed",
    );
    assert.equal(env.db.prepare("SELECT * FROM report_pages").all().length, 0);
    assert.equal(
      env.db
        .prepare("SELECT state FROM report_page_appends WHERE id=?")
        .get(b.id)!.state,
      "cancelled",
    );
  } finally {
    env.cleanup();
  }
});
