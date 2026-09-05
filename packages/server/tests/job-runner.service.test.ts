import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { closeDatabaseForTests, getDatabase } from "../database/client.ts";
import type { RequestUser } from "../domain/request-user.ts";
import {
  cancelReportProcessing,
  claimNextJob,
  getProcessingJobEventDetail,
  listProcessingJobEvents,
  processNextJob,
  queueManualAiExtraction,
  reconcileReportProcessingStatus,
  reprocessReportOcrAndAi,
  retryProcessingJob,
  type WorkerExecutor,
} from "../services/job-runner.service.ts";
import {
  buildReportTitle,
  normalizeAiExtraction,
  type AiExecutor,
} from "../services/ai-extraction.service.ts";
import { saveAiSettings } from "../services/ai-settings.service.ts";
import {
  createUpload,
  listProcessingJobs,
} from "../services/upload.service.ts";
import {
  getReportDetail,
  listTrendSeries,
  permanentlyDeleteReport,
  trashReport,
  updateReportFields,
} from "../services/records.service.ts";

const manager: RequestUser = {
  id: "runner-manager",
  displayName: "任务管理员",
  provider: "fnos_gateway",
  authenticated: true,
  isGatewayAdmin: true,
};
const samplePhone = ["138", "0013", "8000"].join("");
const sampleIdentityCard = ["110105", "19491231", "002X"].join("");
const sensitiveSamplePattern = new RegExp(
  `${samplePhone}|${sampleIdentityCard}|家庭住址|联系电话|身份证号`,
);

function pngBytes() {
  return Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01,
  ]);
}

function anotherPngBytes() {
  return Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x02, 0x03,
  ]);
}

async function withDatabase(run: () => Promise<void>) {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-runner-"));
  process.env.STORAGE_DIR = storageDir;
  try {
    const db = getDatabase();
    db.prepare(
      "INSERT INTO users (id, display_name, is_gateway_admin) VALUES (?, ?, 1)",
    ).run(manager.id, manager.displayName);
    db.prepare(
      `
      INSERT INTO health_members (id, display_name, relationship, created_by)
      VALUES ('runner-member', '本人', 'self', ?)
    `,
    ).run(manager.id);
    db.prepare(
      `
      INSERT INTO member_permissions (member_id, user_id, permission, granted_by)
      VALUES ('runner-member', ?, 'manager', ?)
    `,
    ).run(manager.id, manager.id);
    await run();
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
}

test("completes thumbnail and OCR jobs then marks the report for review", async () => {
  await withDatabase(async () => {
    const upload = createUpload(manager, "runner-member", [
      { originalName: "report.png", data: pngBytes() },
    ]);
    const executor: WorkerExecutor = async (request) =>
      request.action === "thumbnail"
        ? { ok: true, width: 240, height: 320, elapsedMs: 8 }
        : {
            ok: true,
            engine: "test-ocr",
            modelVersion: "test-v1",
            lines: [
              {
                id: "line_1",
                text: "检查日期 2026-07-21",
                confidence: 0.99,
                box: [0, 0, 10, 10],
              },
            ],
            elapsedMs: 12,
          };
    assert.equal(await processNextJob(executor), true);
    assert.equal(await processNextJob(executor), true);
    assert.equal(await processNextJob(executor), false);

    const report = getDatabase()
      .prepare("SELECT status FROM reports WHERE id = ?")
      .get(upload.reportId) as { status: string };
    assert.equal(report.status, "needs_review");
    const notice = getDatabase()
      .prepare(
        `
      SELECT type, status, title, severity FROM app_notifications WHERE report_id = ?
    `,
      )
      .get(upload.reportId) as {
      type: string;
      status: string;
      title: string;
      severity: string;
    };
    assert.equal(notice.type, "report_processed");
    assert.equal(notice.status, "unread");
    assert.equal(notice.title, "报告处理完成");
    assert.equal(notice.severity, "success");
    const page = getDatabase()
      .prepare(
        `
      SELECT thumbnail_path AS thumbnailPath, width, height FROM report_pages WHERE report_id = ?
    `,
      )
      .get(upload.reportId) as {
      thumbnailPath: string;
      width: number;
      height: number;
    };
    assert.match(page.thumbnailPath, /^thumbnails\//);
    assert.deepEqual(
      { width: page.width, height: page.height },
      { width: 240, height: 320 },
    );
    const ocr = getDatabase()
      .prepare("SELECT engine, lines_json AS linesJson FROM ocr_results")
      .get() as {
      engine: string;
      linesJson: string;
    };
    assert.equal(ocr.engine, "test-ocr");
    assert.equal(JSON.parse(ocr.linesJson)[0].text, "检查日期 2026-07-21");
  });
});

test("pauses automatic AI extraction when local OCR precheck finds a high-confidence duplicate", async () => {
  await withDatabase(async () => {
    const ocrLines = [
      "健康体检检验结果汇总",
      "白细胞计数 5.62 10^9/L 3.50-9.50",
      "红细胞计数 4.83 10^12/L 4.30-5.80",
      "血红蛋白 151 g/L 130-175",
      "血小板计数 226 10^9/L 125-350",
      "空腹血糖 5.18 mmol/L 3.90-6.10",
      "总胆固醇 4.26 mmol/L 0.00-5.20",
      "甘油三酯 1.12 mmol/L 0.00-1.70",
      "谷丙转氨酶 22 U/L 9-50",
      "肌酐 78 μmol/L 57-111",
    ].map((text, index) => ({
      id: `line_${index + 1}`,
      text,
      confidence: 0.99,
      box: [0, index * 20, 520, index * 20 + 14],
    }));
    const worker: WorkerExecutor = async (request) =>
      request.action === "thumbnail"
        ? { ok: true, width: 900, height: 1200, elapsedMs: 5 }
        : {
            ok: true,
            engine: "test-ocr",
            modelVersion: "test-v1",
            lines: ocrLines,
            elapsedMs: 12,
          };

    const existing = createUpload(manager, "runner-member", [
      { originalName: "existing.png", data: pngBytes() },
    ]);
    assert.equal(await processNextJob(worker), true);
    assert.equal(await processNextJob(worker), true);
    getDatabase()
      .prepare(
        "UPDATE reports SET status = 'ready', title = '既有体检报告' WHERE id = ?",
      )
      .run(existing.reportId);

    saveAiSettings({
      enabled: true,
      baseUrl: "https://ai.example.test/v1",
      textModel: "health-structurer",
      apiKey: "test-secret",
    });
    const incoming = createUpload(manager, "runner-member", [
      { originalName: "rescanned.png", data: anotherPngBytes() },
    ]);
    assert.equal(await processNextJob(worker), true);
    assert.equal(await processNextJob(worker), true);

    const queuedAi = getDatabase()
      .prepare(
        `
      SELECT COUNT(*) AS count FROM processing_jobs
      WHERE report_id = ? AND job_type = 'ai_extract'
    `,
      )
      .get(incoming.reportId) as { count: number };
    assert.equal(queuedAi.count, 0);

    const detail = getReportDetail(manager, incoming.reportId);
    assert.equal(detail.status, "needs_review");
    assert.equal(detail.duplicateCandidates.length, 1);
    assert.equal(detail.duplicateCandidates[0].id, existing.reportId);
    assert.equal(detail.duplicateCandidates[0].confidence, "high");
    assert.match(detail.duplicateCandidates[0].reason, /OCR.*高度一致/);

    const notice = getDatabase()
      .prepare(
        `
      SELECT title, severity, message FROM app_notifications
      WHERE report_id = ? ORDER BY created_at DESC LIMIT 1
    `,
      )
      .get(incoming.reportId) as {
      title: string;
      severity: string;
      message: string;
    };
    assert.equal(notice.title, "发现可能重复报告");
    assert.equal(notice.severity, "warning");
    assert.match(notice.message, /暂缓自动 AI 整理/);

    const incomingOcrJob = getDatabase()
      .prepare(
        `
      SELECT id FROM processing_jobs
      WHERE report_id = ? AND job_type = 'ocr'
      ORDER BY created_at DESC LIMIT 1
    `,
      )
      .get(incoming.reportId) as { id: string };
    const events = listProcessingJobEvents(manager, incomingOcrJob.id);
    assert.equal(
      events.some(
        (event) =>
          (event.detail as Record<string, unknown>)?.stage ===
          "duplicate_precheck",
      ),
      true,
      JSON.stringify(events),
    );

    const manualAi = queueManualAiExtraction(manager, incoming.reportId);
    assert.equal(manualAi.status, "queued");
  });
});

test("discards an in-flight worker result after the report is moved to trash", async () => {
  await withDatabase(async () => {
    const upload = createUpload(manager, "runner-member", [
      { originalName: "cancelled.png", data: pngBytes() },
    ]);
    let finishWorker!: (response: Awaited<ReturnType<WorkerExecutor>>) => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const executor: WorkerExecutor = async () =>
      new Promise((resolve) => {
        finishWorker = resolve;
        markStarted();
      });

    const processing = processNextJob(executor);
    await started;
    trashReport(manager, upload.reportId);
    assert.throws(
      () => permanentlyDeleteReport(manager, upload.reportId),
      /结束处理中/,
    );
    finishWorker({ ok: true, width: 240, height: 320, elapsedMs: 8 });
    assert.equal(await processing, true);

    const report = getDatabase()
      .prepare("SELECT status FROM reports WHERE id = ?")
      .get(upload.reportId) as { status: string };
    const job = getDatabase()
      .prepare(
        `
      SELECT status FROM processing_jobs WHERE report_id = ? AND job_type = 'thumbnail'
    `,
      )
      .get(upload.reportId) as { status: string };
    const page = getDatabase()
      .prepare(
        `
      SELECT thumbnail_path AS thumbnailPath FROM report_pages WHERE report_id = ?
    `,
      )
      .get(upload.reportId) as { thumbnailPath: string | null };
    assert.equal(report.status, "trashed");
    assert.equal(job.status, "cancelled");
    assert.equal(page.thumbnailPath, null);
  });
});

test("skips AI extraction and warns when OCR extracts no text", async () => {
  await withDatabase(async () => {
    saveAiSettings({
      enabled: true,
      baseUrl: "https://ai.example.test/v1",
      textModel: "health-structurer",
      apiKey: "test-secret",
    });
    const upload = createUpload(manager, "runner-member", [
      { originalName: "blank.png", data: pngBytes() },
    ]);
    const worker: WorkerExecutor = async (request) =>
      request.action === "thumbnail"
        ? { ok: true, width: 240, height: 320, elapsedMs: 5 }
        : {
            ok: true,
            engine: "test-ocr",
            modelVersion: "test-v1",
            lines: [],
            elapsedMs: 6,
          };
    let aiCalls = 0;
    const ai: AiExecutor = async () => {
      aiCalls += 1;
      throw new Error("AI should not be called for empty OCR text");
    };

    assert.equal(await processNextJob(worker, ai), true);
    assert.equal(await processNextJob(worker, ai), true);
    assert.equal(await processNextJob(worker, ai), false);
    assert.equal(aiCalls, 0);

    const aiJobs = getDatabase()
      .prepare(
        `
      SELECT COUNT(*) AS count FROM processing_jobs WHERE report_id = ? AND job_type = 'ai_extract'
    `,
      )
      .get(upload.reportId) as { count: number };
    assert.equal(aiJobs.count, 0);
    const report = getDatabase()
      .prepare("SELECT status FROM reports WHERE id = ?")
      .get(upload.reportId) as { status: string };
    assert.equal(report.status, "needs_review");
    const notice = getDatabase()
      .prepare(
        `
      SELECT type, title, severity FROM app_notifications WHERE report_id = ?
    `,
      )
      .get(upload.reportId) as {
      type: string;
      title: string;
      severity: string;
    };
    assert.deepEqual(
      { type: notice.type, title: notice.title, severity: notice.severity },
      {
        type: "report_processed",
        title: "报告未识别到文字",
        severity: "warning",
      },
    );
    assert.throws(
      () => queueManualAiExtraction(manager, upload.reportId),
      /暂无可用于 AI 整理的 OCR 文本/,
    );
  });
});

test("treats legacy OCR rows without text_length as having content", async () => {
  await withDatabase(async () => {
    saveAiSettings({
      enabled: true,
      baseUrl: "https://ai.example.test/v1",
      textModel: "health-structurer",
      apiKey: "test-secret",
    });
    const upload = createUpload(manager, "runner-member", [
      { originalName: "legacy.png", data: pngBytes() },
    ]);
    const worker: WorkerExecutor = async (request) =>
      request.action === "thumbnail"
        ? { ok: true, width: 240, height: 320, elapsedMs: 5 }
        : {
            ok: true,
            engine: "test-ocr",
            modelVersion: "test-v1",
            lines: [
              {
                text: "空腹血糖 5.2 mmol/L",
                confidence: 0.99,
                box: [0, 0, 10, 10],
              },
            ],
            elapsedMs: 6,
          };
    assert.equal(await processNextJob(worker), true);
    assert.equal(await processNextJob(worker), true);
    getDatabase()
      .prepare(
        "DELETE FROM processing_jobs WHERE report_id = ? AND job_type = 'ai_extract'",
      )
      .run(upload.reportId);
    /* 模拟 text_length 列加入之前的历史数据：只有 lines_json */
    getDatabase().prepare("UPDATE ocr_results SET text_length = NULL").run();

    const jobs = listProcessingJobs(manager, upload.reportId) as Array<{
      jobType: string;
      ocrTextLength: number | null;
    }>;
    assert.equal(jobs.find((job) => job.jobType === "ocr")?.ocrTextLength, 1);
    const manual = queueManualAiExtraction(manager, upload.reportId);
    assert.equal(manual.status, "queued");
  });
});

test("expands a multi-page PDF and queues work for every source page", async () => {
  await withDatabase(async () => {
    const upload = createUpload(manager, "runner-member", [
      { originalName: "report.pdf", data: Buffer.from("%PDF-1.4\n%%EOF") },
    ]);
    const recycleFlags: Array<boolean | undefined> = [];
    const executor: WorkerExecutor = async (request) => {
      if (request.action === "inspect_pdf") {
        return {
          ok: true,
          pageCount: 3,
          pages: [
            { pageNumber: 1, width: 595, height: 842 },
            { pageNumber: 2, width: 595, height: 842 },
            { pageNumber: 3, width: 595, height: 842 },
          ],
        };
      }
      if (request.action === "thumbnail")
        return { ok: true, width: 240, height: 320 };
      recycleFlags.push(request.recycleAfterResponse);
      return {
        ok: true,
        engine: "test-ocr",
        modelVersion: "test-v1",
        lines: [
          {
            id: "line_1",
            text: "检查结果",
            confidence: 0.99,
            box: [0, 0, 10, 10],
          },
        ],
      };
    };
    assert.equal(await processNextJob(executor), true);
    const pages = getDatabase()
      .prepare(
        `
      SELECT page_number AS pageNumber, source_page_number AS sourcePageNumber,
        source_page_count AS sourcePageCount
      FROM report_pages WHERE report_id = ? ORDER BY page_number
    `,
      )
      .all(upload.reportId) as Array<{
      pageNumber: number;
      sourcePageNumber: number;
      sourcePageCount: number;
    }>;
    assert.deepEqual(
      pages.map((page) => page.sourcePageNumber),
      [1, 2, 3],
    );
    assert.equal(
      pages.every((page) => page.sourcePageCount === 3),
      true,
    );
    const jobCount = getDatabase()
      .prepare(
        `
      SELECT COUNT(*) AS count FROM processing_jobs WHERE report_id = ?
    `,
      )
      .get(upload.reportId) as { count: number };
    assert.equal(jobCount.count, 7);
    for (let index = 0; index < 6; index += 1) {
      assert.equal(await processNextJob(executor), true);
    }
    assert.deepEqual(recycleFlags, [false, false, true]);
  });
});

test("rejects an incomplete PDF inspection before creating partial page records", async () => {
  await withDatabase(async () => {
    const upload = createUpload(manager, "runner-member", [
      { originalName: "incomplete.pdf", data: Buffer.from("%PDF-1.4\n%%EOF") },
    ]);
    const executor: WorkerExecutor = async () => ({
      ok: true,
      pageCount: 3,
      pages: [
        { pageNumber: 1, width: 595, height: 842 },
        { pageNumber: 3, width: 595, height: 842 },
      ],
    });

    await assert.rejects(
      () => processNextJob(executor),
      (error: unknown) =>
        (error as { code?: string }).code === "PDF_INSPECTION_INCOMPLETE",
    );
    const pages = getDatabase()
      .prepare(
        `
      SELECT source_page_count AS sourcePageCount
      FROM report_pages WHERE report_id = ?
    `,
      )
      .all(upload.reportId) as Array<{ sourcePageCount: number | null }>;
    assert.equal(pages.length, 1);
    assert.equal(pages[0]?.sourcePageCount, null);
  });
});

test("allows a manager to retry a failed processing job", async () => {
  await withDatabase(async () => {
    const upload = createUpload(manager, "runner-member", [
      { originalName: "report.png", data: pngBytes() },
    ]);
    const job = getDatabase()
      .prepare(
        `
      SELECT id FROM processing_jobs WHERE report_id = ? LIMIT 1
    `,
      )
      .get(upload.reportId) as { id: string };
    getDatabase()
      .prepare(
        `
      UPDATE processing_jobs SET status = 'failed', attempts = 3, error_code = 'TEST' WHERE id = ?
    `,
      )
      .run(job.id);
    assert.deepEqual(retryProcessingJob(manager, job.id), {
      id: job.id,
      status: "queued",
    });
    const retried = getDatabase()
      .prepare(
        `
      SELECT status, attempts, error_code AS errorCode FROM processing_jobs WHERE id = ?
    `,
      )
      .get(job.id) as {
      status: string;
      attempts: number;
      errorCode: string | null;
    };
    assert.equal(retried.status, "queued");
    assert.equal(retried.attempts, 0);
    assert.equal(retried.errorCode, null);
    const events = listProcessingJobEvents(manager, job.id) as Array<{
      eventType: string;
      status: string;
      message: string | null;
    }>;
    assert.equal(
      events.some(
        (event) =>
          event.eventType === "manual_retry" && event.status === "queued",
      ),
      true,
    );
  });
});

test("records processing job event history for attempts and failures", async () => {
  await withDatabase(async () => {
    const upload = createUpload(manager, "runner-member", [
      { originalName: "report.png", data: pngBytes() },
    ]);
    const job = getDatabase()
      .prepare(
        `
      SELECT id FROM processing_jobs WHERE report_id = ? AND job_type = 'thumbnail'
    `,
      )
      .get(upload.reportId) as { id: string };
    const executor: WorkerExecutor = async () => {
      throw Object.assign(new Error("缩略图生成失败"), {
        code: "TEST_THUMBNAIL_FAILED",
      });
    };
    await assert.rejects(() => processNextJob(executor), /缩略图生成失败/);
    const events = listProcessingJobEvents(manager, job.id) as Array<{
      eventType: string;
      status: string;
      attempt: number;
      message: string | null;
      detail: Record<string, unknown>;
    }>;
    assert.deepEqual(
      events.map((event) => event.eventType),
      ["queued", "started", "retry_scheduled"],
    );
    assert.equal(events[1].attempt, 1);
    assert.equal(events[2].status, "queued");
    assert.equal(events[2].message, "缩略图生成失败");
    assert.equal(events[2].detail.code, "TEST_THUMBNAIL_FAILED");
  });
});

test("projects concurrent AI events onto the stable planned unit order", async () => {
  await withDatabase(async () => {
    const upload = createUpload(manager, "runner-member", [
      { originalName: "ordered-ai-report.png", data: pngBytes() },
    ]);
    const job = getDatabase()
      .prepare(
        `
      SELECT id FROM processing_jobs WHERE report_id = ? AND job_type = 'thumbnail'
    `,
      )
      .get(upload.reportId) as { id: string };
    getDatabase()
      .prepare(
        `
      UPDATE processing_jobs SET job_type = 'ai_extract', status = 'processing', started_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `,
      )
      .run(job.id);
    const insertUnit = getDatabase().prepare(`
      INSERT INTO ai_extraction_units (
        id, job_id, report_id, plan_hash, unit_key, unit_index, unit_type,
        page_numbers_json, input_hash, status, attempts, elapsed_ms
      ) VALUES (?, ?, ?, 'plan', ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertUnit.run(
      "unit-second",
      job.id,
      upload.reportId,
      "key-second",
      1,
      "complete_pages",
      "[3,4]",
      "hash-2",
      "completed",
      1,
      900,
    );
    // Split child indexes can be much larger than later top-level units; page order remains authoritative for display.
    insertUnit.run(
      "unit-first",
      job.id,
      upload.reportId,
      "key-first",
      1001,
      "page_chunk",
      "[1,2]",
      "hash-1",
      "processing",
      2,
      null,
    );
    insertUnit.run(
      "unit-supplement",
      job.id,
      upload.reportId,
      "key-supplement",
      99,
      "supplement",
      "[2]",
      "hash-3",
      "planned",
      0,
      null,
    );
    const insertEvent = getDatabase().prepare(`
      INSERT INTO processing_job_events (
        id, job_id, report_id, event_type, status, attempt, message, detail_json, created_at
      ) VALUES (?, ?, ?, ?, 'processing', 1, ?, ?, ?)
    `);
    insertEvent.run(
      "event-second",
      job.id,
      upload.reportId,
      "completed",
      "第二单元先完成",
      JSON.stringify({
        unitKey: "key-second",
        unitIndex: 1,
        pageNumbers: [3, 4],
      }),
      "2026-07-31 10:00:00",
    );
    insertEvent.run(
      "event-first",
      job.id,
      upload.reportId,
      "started",
      "第一单元仍在处理",
      JSON.stringify({
        unitKey: "key-first",
        unitIndex: 1001,
        pageNumbers: [1, 2],
      }),
      "2026-07-31 10:00:01",
    );

    const detail = getProcessingJobEventDetail(manager, job.id);
    assert.deepEqual(
      detail.units.map((unit) => unit.unitKey),
      ["key-first", "key-second", "key-supplement"],
    );
    assert.deepEqual(
      detail.units.map((unit) => unit.status),
      ["processing", "completed", "planned"],
    );
    assert.deepEqual(
      detail.units[0]?.events.map((event) => event.id),
      ["event-first"],
    );
    assert.deepEqual(
      detail.units[1]?.events.map((event) => event.id),
      ["event-second"],
    );
    assert.equal(detail.units[0]?.characterCount, 0);
    assert.equal(detail.units[0]?.candidateCount, 0);
    assert.equal(detail.units[0]?.matchedCount, 0);
    assert.equal(
      detail.generalEvents.some((event) => event.eventType === "queued"),
      true,
    );
    assert.equal(detail.diagnostics.stage, "supplement");
    assert.equal(detail.diagnostics.metrics.supplementUnits, 1);
    assert.deepEqual(detail.diagnostics.supplement.pages, [2]);
    assert.equal(
      detail.diagnostics.reasons.some(
        (reason) => reason.code === "SUPPLEMENT_REQUIRED",
      ),
      true,
    );
  });
});

test("summarizes recovered AI failures, supplement pages, candidate cleanup, and evidence rejection", async () => {
  await withDatabase(async () => {
    const upload = createUpload(manager, "runner-member", [
      { originalName: "diagnostic-ai.png", data: pngBytes() },
    ]);
    const db = getDatabase();
    const job = db
      .prepare(
        `
      SELECT id FROM processing_jobs WHERE report_id = ? AND job_type = 'thumbnail'
    `,
      )
      .get(upload.reportId) as { id: string };
    db.prepare(
      `
      UPDATE processing_jobs SET job_type = 'ai_extract', status = 'completed', attempts = 1,
        started_at = CURRENT_TIMESTAMP, finished_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `,
    ).run(job.id);
    const insertUnit = db.prepare(`
      INSERT INTO ai_extraction_units (
        id, job_id, report_id, plan_hash, unit_key, unit_index, unit_type,
        page_numbers_json, input_hash, character_count, candidate_count, matched_count,
        status, attempts, elapsed_ms
      ) VALUES (?, ?, ?, 'plan', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertUnit.run(
      "diagnostic-main",
      job.id,
      upload.reportId,
      "diagnostic-main-key",
      0,
      "complete_pages",
      "[1]",
      "diagnostic-main-hash",
      1800,
      4,
      3,
      "completed",
      2,
      1200,
    );
    insertUnit.run(
      "diagnostic-supplement",
      job.id,
      upload.reportId,
      "diagnostic-supplement-key",
      1,
      "supplement",
      "[1]",
      "diagnostic-supplement-hash",
      420,
      1,
      0,
      "warning",
      1,
      500,
    );
    const insertAttempt = db.prepare(`
      INSERT INTO ai_extraction_attempts (
        id, unit_id, job_id, report_id, attempt_number, attempt_type, status,
        input_characters, error_code, error_message
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertAttempt.run(
      "diagnostic-attempt-failed",
      "diagnostic-main",
      job.id,
      upload.reportId,
      1,
      "main",
      "failed",
      1800,
      "AI_OUTPUT_TRUNCATED",
      "output truncated",
    );
    insertAttempt.run(
      "diagnostic-attempt-ok",
      "diagnostic-main",
      job.id,
      upload.reportId,
      2,
      "split",
      "completed",
      1800,
      null,
      null,
    );
    const insertCandidate = db.prepare(`
      INSERT INTO ai_extraction_candidates (
        id, job_id, unit_id, report_id, candidate_key, source_hash, page_number,
        source_line_ids_json, kind, status, matched_entity_key, reason
      ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, 'scalar', ?, ?, ?)
    `);
    insertCandidate.run(
      "candidate-local",
      job.id,
      "diagnostic-main",
      upload.reportId,
      "candidate-local-key",
      "candidate-local-hash",
      "[]",
      "local_extracted",
      "local:key",
      "local_extracted:本地结构化提取",
    );
    insertCandidate.run(
      "candidate-ai",
      job.id,
      "diagnostic-main",
      upload.reportId,
      "candidate-ai-key",
      "candidate-ai-hash",
      "[]",
      "ai_extracted",
      "ai:key",
      "ai_extracted:AI 结果已通过原文证据匹配",
    );
    insertCandidate.run(
      "candidate-redundant",
      job.id,
      "diagnostic-main",
      upload.reportId,
      "candidate-redundant-key",
      "candidate-redundant-hash",
      "[]",
      "redundant",
      "ai:key",
      "duplicate_evidence:同指标同结果已覆盖",
    );
    insertCandidate.run(
      "candidate-unresolved",
      job.id,
      "diagnostic-supplement",
      upload.reportId,
      "candidate-unresolved-key",
      "candidate-unresolved-hash",
      '["page_1_line_3"]',
      "unresolved",
      null,
      "supplement_required:补提取后仍未找到可验证的对应事实",
    );
    insertCandidate.run(
      "candidate-ambiguous",
      job.id,
      "diagnostic-supplement",
      upload.reportId,
      "candidate-ambiguous-key",
      "candidate-ambiguous-hash",
      '["page_1_line_4"]',
      "unresolved",
      null,
      "ambiguous_layout:项目与结果列无法可靠对应",
    );
    db.prepare(
      `
      INSERT INTO processing_job_events (
        id, job_id, report_id, event_type, status, attempt, message, detail_json
      ) VALUES (?, ?, ?, 'completed', 'processing', 1, 'unit completed', ?)
    `,
    ).run(
      "diagnostic-unit-event",
      job.id,
      upload.reportId,
      JSON.stringify({
        unitKey: "diagnostic-main-key",
        unitIndex: 0,
        rejectedObservations: 1,
        rejectedMorphologyFindings: 0,
        rejectedClinicalFacts: 1,
        rejectedStructuredSections: 0,
        rejectedObservationSamples: [
          { itemName: "血清淀粉样蛋白", resultText: "99.9", pageNumbers: [1] },
        ],
      }),
    );

    const detail = getProcessingJobEventDetail(manager, job.id);
    assert.equal(detail.diagnostics.outcome, "warning");
    assert.equal(detail.diagnostics.stage, "post_processing");
    assert.equal(detail.diagnostics.metrics.inputCharacters, 2220);
    assert.equal(detail.diagnostics.metrics.candidateCount, 5);
    assert.equal(detail.diagnostics.metrics.matchedCount, 3);
    assert.equal(detail.diagnostics.metrics.redundantCount, 1);
    assert.equal(detail.diagnostics.metrics.unresolvedCount, 2);
    assert.equal(detail.diagnostics.metrics.aiRequestCount, 2);
    assert.equal(detail.diagnostics.metrics.aiFailureCount, 1);
    assert.equal(detail.diagnostics.metrics.postprocessRejectedCount, 2);
    assert.deepEqual(detail.diagnostics.supplement.pages, [1]);
    assert.match(detail.diagnostics.supplement.reason || "", /仍有 1 项待核对/);
    assert.equal(
      detail.diagnostics.reasons.some(
        (reason) =>
          reason.code === "AI_TRUNCATED_OUTPUT" && reason.severity === "info",
      ),
      true,
    );
    assert.equal(
      detail.diagnostics.reasons.some(
        (reason) => reason.code === "SUPPLEMENT_UNRESOLVED",
      ),
      true,
    );
    assert.equal(
      detail.diagnostics.reasons.some(
        (reason) => reason.code === "POSTPROCESS_REDUNDANT",
      ),
      true,
    );
    assert.equal(
      detail.diagnostics.reasons.some(
        (reason) => reason.code === "AI_PARTIAL_RESULT",
      ),
      true,
    );
    const aiMissing = detail.diagnostics.reviewItems.find(
      (item) => item.issueType === "ai_missing",
    );
    assert.deepEqual(aiMissing?.pages, [1]);
    assert.deepEqual(aiMissing?.sourceLineIds, ["page_1_line_3"]);
    assert.match(aiMissing?.resultSummary || "", /未写入报告指标/);
    const layoutAmbiguity = detail.diagnostics.reviewItems.find(
      (item) => item.issueType === "layout_ambiguity",
    );
    assert.deepEqual(layoutAmbiguity?.sourceLineIds, ["page_1_line_4"]);
    const evidenceRejected = detail.diagnostics.reviewItems.find(
      (item) => item.issueType === "evidence_rejected",
    );
    assert.deepEqual(evidenceRejected?.pages, [1]);
    assert.match(evidenceRejected?.resultSummary || "", /未写入正式结果/);
    assert.match(evidenceRejected?.resultSummary || "", /血清淀粉样蛋白/);
  });
});

test("distinguishes empty OCR output from an unavailable OCR runtime", async () => {
  await withDatabase(async () => {
    const upload = createUpload(manager, "runner-member", [
      { originalName: "diagnostic-ocr-empty.png", data: pngBytes() },
      { originalName: "diagnostic-ocr-failed.png", data: pngBytes() },
    ]);
    const db = getDatabase();
    const jobs = db
      .prepare(
        `
      SELECT j.id, j.page_id AS pageId, p.page_number AS pageNumber
      FROM processing_jobs j JOIN report_pages p ON p.id = j.page_id
      WHERE j.report_id = ? AND j.job_type = 'ocr' ORDER BY p.page_number
    `,
      )
      .all(upload.reportId) as Array<{
      id: string;
      pageId: string;
      pageNumber: number;
    }>;
    const emptyJob = jobs[0]!;
    const failedJob = jobs[1]!;
    db.prepare(
      `
      UPDATE processing_jobs SET status = 'completed', attempts = 1, finished_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `,
    ).run(emptyJob.id);
    db.prepare(
      `
      INSERT INTO ocr_results (
        id, job_id, page_id, engine, model_version, lines_json,
        quality_score, quality_level, quality_reason, text_length, elapsed_ms
      ) VALUES ('diagnostic-empty-ocr', ?, ?, 'test-ocr', 'test-v1', '[]', 0, 'poor', 'empty', 0, 10)
    `,
    ).run(emptyJob.id, emptyJob.pageId);
    db.prepare(
      `
      UPDATE processing_jobs SET status = 'failed', attempts = 3,
        error_code = 'OCR_WORKER_UNAVAILABLE', error_message = 'runtime unavailable',
        finished_at = CURRENT_TIMESTAMP WHERE id = ?
    `,
    ).run(failedJob.id);

    const emptyDetail = getProcessingJobEventDetail(manager, emptyJob.id);
    assert.equal(emptyDetail.diagnostics.outcome, "empty");
    assert.equal(
      emptyDetail.diagnostics.reasons.some(
        (reason) => reason.code === "OCR_EMPTY",
      ),
      true,
    );
    assert.equal(
      emptyDetail.diagnostics.reasons.some(
        (reason) => reason.code === "OCR_RUNTIME_UNAVAILABLE",
      ),
      false,
    );
    assert.equal(
      emptyDetail.diagnostics.metrics.ocrWeakPages,
      0,
      "空内容只归入 OCR_EMPTY，不能重复计为低质量页",
    );
    assert.deepEqual(
      emptyDetail.diagnostics.reviewItems.map((item) => [
        item.issueType,
        item.pages,
      ]),
      [["ocr_content", [1]]],
    );

    const failedDetail = getProcessingJobEventDetail(manager, failedJob.id);
    assert.equal(failedDetail.diagnostics.outcome, "failed");
    assert.equal(
      failedDetail.diagnostics.reasons.some(
        (reason) => reason.code === "OCR_RUNTIME_UNAVAILABLE",
      ),
      true,
    );
    assert.equal(failedDetail.diagnostics.metrics.ocrEmptyPages, 1);
    assert.equal(failedDetail.diagnostics.metrics.ocrFailedPages, 1);
  });
});

test("uses the latest completed OCR snapshot for an independent AI rerun", async () => {
  await withDatabase(async () => {
    const upload = createUpload(manager, "runner-member", [
      { originalName: "diagnostic-latest-ocr.png", data: pngBytes() },
    ]);
    const db = getDatabase();
    const page = db
      .prepare(
        `
      SELECT id FROM report_pages WHERE report_id = ?
    `,
      )
      .get(upload.reportId) as { id: string };
    const originalOcrJob = db
      .prepare(
        `
      SELECT id FROM processing_jobs WHERE report_id = ? AND job_type = 'ocr'
    `,
      )
      .get(upload.reportId) as { id: string };
    db.prepare(
      `
      UPDATE processing_jobs SET status = 'completed', finished_at = '2026-08-01 09:00:00'
      WHERE id = ?
    `,
    ).run(originalOcrJob.id);
    db.prepare(
      `
      INSERT INTO ocr_results (
        id, job_id, page_id, engine, model_version, lines_json,
        quality_score, quality_level, quality_reason, text_length, elapsed_ms, created_at
      ) VALUES ('diagnostic-old-weak-ocr', ?, ?, 'test-ocr', 'test-v1', '[]',
        0.4, 'weak', 'historical weak result', 30, 10, '2026-08-01 09:00:00')
    `,
    ).run(originalOcrJob.id, page.id);
    db.prepare(
      `
      INSERT INTO processing_jobs (
        id, report_id, page_id, job_type, status, pipeline_version,
        deduplication_key, finished_at, created_at
      ) VALUES (
        'diagnostic-new-good-job', ?, ?, 'ocr', 'completed', 'manual-page-v1',
        'diagnostic-new-good-key', '2026-08-02 09:00:00', '2026-08-02 09:00:00'
      )
    `,
    ).run(upload.reportId, page.id);
    db.prepare(
      `
      INSERT INTO ocr_results (
        id, job_id, page_id, engine, model_version, lines_json,
        quality_score, quality_level, quality_reason, text_length, elapsed_ms, created_at
      ) VALUES (
        'diagnostic-new-good-ocr', 'diagnostic-new-good-job', ?, 'test-ocr', 'test-v2',
        '[{"id":"line-1","text":"匿名有效内容","confidence":0.99}]',
        0.99, 'good', NULL, 64, 8, '2026-08-02 09:00:00'
      )
    `,
    ).run(page.id);
    db.prepare(
      `
      INSERT INTO processing_jobs (
        id, report_id, job_type, status, pipeline_version, deduplication_key,
        finished_at, created_at
      ) VALUES (
        'diagnostic-independent-ai', ?, 'ai_extract', 'completed', 'manual-ai-v1',
        ? || ':ai_extract:manual:diagnostic', '2026-08-03 09:00:00', '2026-08-03 09:00:00'
      )
    `,
    ).run(upload.reportId, upload.reportId);

    const detail = getProcessingJobEventDetail(
      manager,
      "diagnostic-independent-ai",
    );
    assert.equal(detail.diagnostics.metrics.ocrCompletedPages, 1);
    assert.equal(detail.diagnostics.metrics.ocrWeakPages, 0);
    assert.equal(detail.diagnostics.metrics.ocrEmptyPages, 0);
    assert.equal(
      detail.diagnostics.reasons.some(
        (reason) => reason.code === "OCR_LOW_QUALITY",
      ),
      false,
    );
  });
});

test("queues AI extraction after OCR, redacts identity data, and persists validated fields", async () => {
  await withDatabase(async () => {
    saveAiSettings({
      enabled: true,
      baseUrl: "https://ai.example.test/v1",
      textModel: "health-structurer",
      apiKey: "test-secret",
    });
    const upload = createUpload(manager, "runner-member", [
      { originalName: "laboratory.png", data: pngBytes() },
    ]);
    const worker: WorkerExecutor = async (request) =>
      request.action === "thumbnail"
        ? { ok: true, width: 300, height: 400, elapsedMs: 4 }
        : {
            ok: true,
            engine: "test-ocr",
            modelVersion: "test-v1",
            lines: [
              {
                text: "示例市第一医院 检验报告",
                confidence: 0.99,
                box: [0, 0, 20, 10],
              },
              {
                text: "报告日期 2026-07-21",
                confidence: 0.99,
                box: [0, 12, 20, 22],
              },
              {
                text: `联系电话 ${samplePhone}`,
                confidence: 0.99,
                box: [0, 24, 20, 34],
              },
              {
                text: `身份证号 ${sampleIdentityCard}`,
                confidence: 0.99,
                box: [0, 36, 20, 46],
              },
              {
                text: "家庭住址 示例路 1 号",
                confidence: 0.99,
                box: [0, 48, 20, 58],
              },
              {
                text: "空腹血糖 5.2 mmol/L",
                confidence: 0.99,
                box: [0, 60, 20, 70],
              },
              { text: "腹部彩超", confidence: 0.99, box: [0, 72, 20, 82] },
              {
                text: "肝右叶见3.2×2.8cm囊性回声，边界清晰，无血流信号",
                confidence: 0.99,
                box: [0, 84, 20, 94],
              },
            ],
            elapsedMs: 7,
          };
    let aiInput = "";
    let aiCalls = 0;
    const ai: AiExecutor = async (input) => {
      aiCalls += 1;
      aiInput += `\n${input.text}`;
      const normalized = normalizeAiExtraction(
        input.extractionMode === "morphology"
          ? {
              morphologyFindings: [
                {
                  sectionName: "腹部彩超",
                  organ: "肝脏",
                  region: "右叶",
                  laterality: "right",
                  findingType: "囊肿",
                  findingName: "肝右叶囊肿",
                  presence: "present",
                  size: { length: 3.2, width: 2.8, unit: "cm" },
                  morphology: "边界清晰，无血流信号",
                  classification: null,
                  rawText: "肝右叶见3.2×2.8cm囊性回声，边界清晰，无血流信号",
                  evidence: [
                    {
                      pageNumber: 1,
                      quote: "肝右叶见3.2×2.8cm囊性回声，边界清晰，无血流信号",
                    },
                  ],
                  confidence: 0.96,
                },
              ],
            }
          : {
              reportType: "laboratory",
              title: "血糖检验报告",
              hospitalNameRaw: "示例市第一医院",
              reportIssuedAt: "2026-07-21",
              identifiers: {
                reportNo: "R-100",
                identityCard: sampleIdentityCard,
                phone: samplePhone,
              },
              summary: "空腹血糖结果 5.2 mmol/L。",
              observations: [
                {
                  sectionName: "生化检验",
                  itemName: "空腹血糖",
                  normalizedName: "空腹血糖",
                  resultText: "5.2",
                  numericValue: 5.2,
                  unit: "mmol/L",
                  referenceLow: 3.9,
                  referenceHigh: 6.1,
                  abnormalFlag: "normal",
                  evidence: [{ pageNumber: 1, quote: "空腹血糖 5.2 mmol/L" }],
                },
              ],
              evidence: {
                reportIssuedAt: [
                  { pageNumber: 1, quote: "报告日期 2026-07-21" },
                ],
              },
              confidence: { reportIssuedAt: 0.98 },
            },
      );
      return {
        provider: "test-provider",
        model: "test-model",
        promptVersion: "test-v1",
        ...normalized,
        rawResponseJson: JSON.stringify(normalized),
        promptTokens: 120,
        completionTokens: 80,
        elapsedMs: 25,
      };
    };

    assert.equal(await processNextJob(worker, ai), true);
    assert.equal(await processNextJob(worker, ai), true);
    const queuedAi = getDatabase()
      .prepare(
        `
      SELECT id, status FROM processing_jobs WHERE report_id = ? AND job_type = 'ai_extract'
    `,
      )
      .get(upload.reportId) as { id: string; status: string };
    assert.equal(queuedAi.status, "queued");
    assert.equal(await processNextJob(worker, ai), true);
    assert.equal(await processNextJob(worker, ai), false);

    assert.match(aiInput, /示例市第一医院/);
    assert.doesNotMatch(aiInput, sensitiveSamplePattern);
    const report = getDatabase()
      .prepare(
        `
      SELECT title, report_type AS reportType, hospital_name_raw AS hospitalName,
        report_issued_at AS reportIssuedAt, identifiers_json AS identifiersJson, status
      FROM reports WHERE id = ?
    `,
      )
      .get(upload.reportId) as {
      title: string;
      reportType: string;
      hospitalName: string;
      reportIssuedAt: string;
      identifiersJson: string;
      status: string;
    };
    assert.deepEqual(
      {
        title: report.title,
        reportType: report.reportType,
        hospitalName: report.hospitalName,
        reportIssuedAt: report.reportIssuedAt,
        status: report.status,
      },
      {
        title: "血糖检验报告",
        reportType: "laboratory",
        hospitalName: "示例市第一医院",
        reportIssuedAt: "2026-07-21",
        status: "needs_review",
      },
    );
    assert.deepEqual(JSON.parse(report.identifiersJson), { reportNo: "R-100" });
    const observation = getDatabase()
      .prepare(
        `
      SELECT item_name AS itemName, numeric_value AS numericValue, unit,
        reference_low AS referenceLow, reference_high AS referenceHigh,
        abnormal_flag AS abnormalFlag
      FROM observations WHERE report_id = ?
    `,
      )
      .get(upload.reportId) as {
      itemName: string;
      numericValue: number;
      unit: string;
      referenceLow: number | null;
      referenceHigh: number | null;
      abnormalFlag: string | null;
    };
    assert.deepEqual(
      {
        itemName: observation.itemName,
        numericValue: observation.numericValue,
        unit: observation.unit,
        referenceLow: observation.referenceLow,
        referenceHigh: observation.referenceHigh,
        abnormalFlag: observation.abnormalFlag,
      },
      {
        itemName: "空腹血糖",
        numericValue: 5.2,
        unit: "mmol/L",
        referenceLow: null,
        referenceHigh: null,
        abnormalFlag: null,
      },
    );
    const finding = getDatabase()
      .prepare(
        `
      SELECT organ, region, finding_type AS findingType, finding_name AS findingName,
        size_length AS sizeLength, size_width AS sizeWidth, size_unit AS sizeUnit,
        morphology_text AS morphology, tracking_group_id AS trackingGroupId,
        match_confidence AS matchConfidence
      FROM morphology_findings WHERE report_id = ?
    `,
      )
      .get(upload.reportId) as {
      organ: string;
      region: string;
      findingType: string;
      findingName: string;
      sizeLength: number;
      sizeWidth: number;
      sizeUnit: string;
      morphology: string;
      trackingGroupId: string;
      matchConfidence: number;
    };
    assert.deepEqual(
      {
        organ: finding.organ,
        region: finding.region,
        findingType: finding.findingType,
        findingName: finding.findingName,
        sizeLength: finding.sizeLength,
        sizeWidth: finding.sizeWidth,
        sizeUnit: finding.sizeUnit,
        morphology: finding.morphology,
      },
      {
        organ: "肝脏",
        region: "右叶",
        findingType: "囊肿",
        findingName: "肝右叶囊肿",
        sizeLength: 3.2,
        sizeWidth: 2.8,
        sizeUnit: "cm",
        morphology: "边界清晰，无血流信号",
      },
    );
    assert.match(finding.trackingGroupId, /^morph_[a-f0-9]{24}$/);
    assert.equal(finding.matchConfidence > 0.8, true);
    const detail = getReportDetail(manager, upload.reportId);
    assert.equal(detail.morphologyFindings.length, 1);
    assert.deepEqual(detail.morphologyFindings[0]?.size, {
      length: 3.2,
      width: 2.8,
      height: null,
      unit: "cm",
    });
    assert.equal(detail.morphologyFindings[0]?.examDate, "2026-07-21");
    assert.equal(detail.morphologyFindings[0]?.evidence[0]?.pageNumber, 1);
    const normalization = getDatabase()
      .prepare(
        `
      SELECT canonical_name AS canonicalName, quality, canonical_value AS canonicalValue, canonical_unit AS canonicalUnit
      FROM observation_normalizations WHERE observation_id = (
        SELECT id FROM observations WHERE report_id = ? LIMIT 1
      )
    `,
      )
      .get(upload.reportId) as {
      canonicalName: string;
      quality: string;
      canonicalValue: number;
      canonicalUnit: string;
    };
    assert.deepEqual(
      {
        canonicalName: normalization.canonicalName,
        quality: normalization.quality,
        canonicalValue: normalization.canonicalValue,
        canonicalUnit: normalization.canonicalUnit,
      },
      {
        canonicalName: "空腹血糖",
        quality: "high",
        canonicalValue: 5.2,
        canonicalUnit: "mmol/L",
      },
    );
    const extraction = getDatabase()
      .prepare(
        `
      SELECT model, input_characters AS inputCharacters, prompt_tokens AS promptTokens,
        completion_tokens AS completionTokens, raw_response_json AS rawResponseJson
      FROM report_extractions WHERE report_id = ?
    `,
      )
      .get(upload.reportId) as {
      model: string;
      inputCharacters: number;
      promptTokens: number;
      completionTokens: number;
      rawResponseJson: string;
    };
    assert.equal(extraction.model, "test-model");
    assert.equal(extraction.inputCharacters > 0, true);
    assert.deepEqual(
      {
        promptTokens: extraction.promptTokens,
        completionTokens: extraction.completionTokens,
      },
      { promptTokens: 240, completionTokens: 160 },
    );
    assert.doesNotMatch(
      extraction.rawResponseJson,
      new RegExp(`${samplePhone}|${sampleIdentityCard}`),
    );

    getDatabase()
      .prepare(
        `
      DELETE FROM observation_normalizations
      WHERE observation_id IN (SELECT id FROM observations WHERE report_id = ?)
    `,
      )
      .run(upload.reportId);
    getDatabase()
      .prepare("UPDATE processing_jobs SET status = 'queued' WHERE id = ?")
      .run(queuedAi.id);
    assert.equal(await processNextJob(worker, ai), true);
    assert.equal(aiCalls, 2);
    const observationCount = getDatabase()
      .prepare("SELECT COUNT(*) AS count FROM observations WHERE report_id = ?")
      .get(upload.reportId) as { count: number };
    assert.equal(observationCount.count, 1);
    const restoredNormalization = getDatabase()
      .prepare(
        `
      SELECT COUNT(*) AS count FROM observation_normalizations
      WHERE observation_id IN (SELECT id FROM observations WHERE report_id = ?)
    `,
      )
      .get(upload.reportId) as { count: number };
    assert.equal(restoredNormalization.count, 1);
  });
});

test("allows manual AI extraction again when a previous AI job produced no structured content", async () => {
  await withDatabase(async () => {
    saveAiSettings({
      enabled: true,
      baseUrl: "https://ai.example.test/v1",
      textModel: "health-structurer",
      apiKey: "test-secret",
    });
    const upload = createUpload(manager, "runner-member", [
      { originalName: "empty-ai.png", data: pngBytes() },
    ]);
    const worker: WorkerExecutor = async (request) =>
      request.action === "thumbnail"
        ? { ok: true, width: 240, height: 320, elapsedMs: 5 }
        : {
            ok: true,
            engine: "test-ocr",
            modelVersion: "test-v1",
            lines: [
              { text: "体检报告", confidence: 0.99, box: [0, 0, 10, 10] },
            ],
            elapsedMs: 6,
          };

    assert.equal(await processNextJob(worker), true);
    assert.equal(await processNextJob(worker), true);
    const autoAi = getDatabase()
      .prepare(
        `
      SELECT id FROM processing_jobs WHERE report_id = ? AND job_type = 'ai_extract'
    `,
      )
      .get(upload.reportId) as { id: string };
    getDatabase()
      .prepare(
        `
      UPDATE processing_jobs SET status = 'completed', attempts = 1, finished_at = CURRENT_TIMESTAMP WHERE id = ?
    `,
      )
      .run(autoAi.id);

    const manual = queueManualAiExtraction(manager, upload.reportId);
    assert.equal(manual.status, "queued");
    assert.notEqual(manual.id, autoAi.id);
    const queuedManualCount = getDatabase()
      .prepare(
        `
      SELECT COUNT(*) AS count FROM processing_jobs
      WHERE report_id = ? AND job_type = 'ai_extract' AND status = 'queued'
    `,
      )
      .get(upload.reportId) as { count: number };
    assert.equal(queuedManualCount.count, 1);
    const visibleJobs = listProcessingJobs(manager, upload.reportId);
    const visibleManual = visibleJobs.find((job) => job.id === manual.id);
    assert.equal(visibleManual?.batchId, `manual-ai:${manual.id}`);
    assert.equal(visibleManual?.batchKind, "manual_ai");
    assert.equal(
      visibleJobs
        .filter((job) => job.id !== manual.id)
        .every((job) => job.batchId === "initial-upload"),
      true,
    );
  });
});

test("queues a new AI job for a completed report without deleting the current structured content", async () => {
  await withDatabase(async () => {
    saveAiSettings({
      enabled: true,
      baseUrl: "https://ai.example.test/v1",
      textModel: "health-structurer",
      apiKey: "test-secret",
    });
    const upload = createUpload(manager, "runner-member", [
      { originalName: "completed-ai.png", data: pngBytes() },
    ]);
    const worker: WorkerExecutor = async (request) =>
      request.action === "thumbnail"
        ? { ok: true, width: 240, height: 320, elapsedMs: 5 }
        : {
            ok: true,
            engine: "test-ocr",
            modelVersion: "test-v1",
            lines: [
              {
                text: "体检报告 血糖 5.2 mmol/L",
                confidence: 0.99,
                box: [0, 0, 10, 10],
              },
            ],
            elapsedMs: 6,
          };
    assert.equal(await processNextJob(worker), true);
    assert.equal(await processNextJob(worker), true);
    const db = getDatabase();
    const completedAi = db
      .prepare(
        `
      SELECT id FROM processing_jobs WHERE report_id = ? AND job_type = 'ai_extract'
    `,
      )
      .get(upload.reportId) as { id: string };
    db.prepare(
      `
      UPDATE processing_jobs SET status = 'completed', finished_at = CURRENT_TIMESTAMP WHERE id = ?
    `,
    ).run(completedAi.id);
    db.prepare(
      `
      INSERT INTO observations (id, report_id, item_name, result_text, numeric_value)
      VALUES ('existing-observation', ?, '现有指标', '5.2', 5.2)
    `,
    ).run(upload.reportId);

    const queued = queueManualAiExtraction(manager, upload.reportId);
    assert.equal(queued.status, "queued");
    assert.notEqual(queued.id, completedAi.id);
    assert.equal(
      (
        db
          .prepare(
            `
      SELECT COUNT(*) AS count FROM observations WHERE id = 'existing-observation'
    `,
          )
          .get() as { count: number }
      ).count,
      1,
    );
  });
});

test("manual AI rerun atomically replaces generated results, preserves manual fields, and closes current diagnostics", async () => {
  await withDatabase(async () => {
    const upload = createUpload(manager, "runner-member", [
      { originalName: "manual-ai-closure.png", data: pngBytes() },
    ]);
    const worker: WorkerExecutor = async (request) =>
      request.action === "thumbnail"
        ? { ok: true, width: 240, height: 320, elapsedMs: 4 }
        : {
            ok: true,
            engine: "test-ocr",
            modelVersion: "test-v1",
            lines: [
              {
                id: "page_1_line_1",
                text: "空腹血糖 5.8 mmol/L",
                confidence: 0.99,
                box: [0, 0, 20, 8],
              },
              {
                id: "page_1_line_2",
                text: "检验报告",
                confidence: 0.99,
                box: [0, 10, 20, 18],
              },
              {
                id: "page_1_line_3",
                text: "报告日期 2026-08-06",
                confidence: 0.99,
                box: [0, 20, 20, 28],
              },
              ...Array.from({ length: 17 }, (_, index) => ({
                id: `page_1_context_${index + 1}`,
                text: "检验信息完整确认",
                confidence: 0.99,
                box: [0, 30 + index * 10, 20, 38 + index * 10],
              })),
            ],
            elapsedMs: 5,
          };
    assert.equal(await processNextJob(worker), true);
    assert.equal(await processNextJob(worker), true);

    const db = getDatabase();
    db.prepare(
      `
      UPDATE reports SET title = '旧检验报告', report_type = 'laboratory', hospital_name_raw = '旧医院',
        city = '旧城市', summary = '旧摘要', status = 'ready'
      WHERE id = ?
    `,
    ).run(upload.reportId);
    db.prepare(
      `
      INSERT INTO observations (
        id, report_id, section_name, item_name, normalized_name, result_text, numeric_value, unit,
        evidence_json
      ) VALUES ('manual-ai-old-observation', ?, '生化检查', '空腹血糖', '空腹血糖', '5.2', 5.2, 'mmol/L', ?)
    `,
    ).run(
      upload.reportId,
      JSON.stringify([{ pageNumber: 1, quote: "空腹血糖 5.2 mmol/L" }]),
    );
    const edited = updateReportFields(manager, upload.reportId, {
      title: "旧检验报告",
      reportType: "laboratory",
      hospitalName: "人工医院",
      hospitalBranch: "",
      city: "旧城市",
      visitType: "",
      departmentName: "",
      orderingDepartment: "",
      performingDepartment: "",
      reportingDepartment: "",
      bodyPart: "",
      reportIssuedAt: "",
      examinedAt: "",
      clinicalDiagnosis: "",
      purpose: "",
      findings: "",
      impression: "",
      summary: "人工摘要",
      recommendation: "",
    });
    assert.deepEqual([...edited.manualFieldKeys].sort(), [
      "hospitalName",
      "summary",
    ]);

    const oldJobId = "manual-ai-old-diagnostic-job";
    const oldUnitId = "manual-ai-old-diagnostic-unit";
    db.prepare(
      `
      INSERT INTO processing_jobs (
        id, report_id, page_id, job_type, status, attempts, pipeline_version, deduplication_key,
        started_at, finished_at
      ) VALUES (?, ?, NULL, 'ai_extract', 'completed', 1, 'health-record-v1', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `,
    ).run(
      oldJobId,
      upload.reportId,
      `${upload.reportId}:ai_extract:old-diagnostic`,
    );
    db.prepare(
      `
      INSERT INTO processing_job_events (
        id, job_id, report_id, event_type, status, attempt, message, detail_json
      ) VALUES (?, ?, ?, 'queued', 'queued', 0, '历史 AI 整理', ?)
    `,
    ).run(
      "manual-ai-old-diagnostic-event",
      oldJobId,
      upload.reportId,
      JSON.stringify({
        jobType: "ai_extract",
        source: "manual",
        batchId: `manual-ai:${oldJobId}`,
        previousReportStatus: "ready",
      }),
    );
    db.prepare(
      `
      INSERT INTO ai_extraction_units (
        id, job_id, report_id, plan_hash, unit_key, unit_index, unit_type,
        page_numbers_json, input_hash, character_count, candidate_count, matched_count,
        status, attempts, elapsed_ms
      ) VALUES (?, ?, ?, 'old-plan', 'old-unit-key', 0, 'complete_pages', '[1]', 'old-input', 32, 1, 0,
        'warning', 1, 10)
    `,
    ).run(oldUnitId, oldJobId, upload.reportId);
    db.prepare(
      `
      INSERT INTO ai_extraction_candidates (
        id, job_id, unit_id, report_id, candidate_key, source_hash, page_number,
        source_line_ids_json, kind, status, matched_entity_key, reason
      ) VALUES ('manual-ai-old-candidate', ?, ?, ?, 'old-candidate-key', 'old-source-hash', 1,
        '["page_1_line_1"]', 'scalar', 'unresolved', NULL, 'supplement_required:历史任务仍有遗漏')
    `,
    ).run(oldJobId, oldUnitId, upload.reportId);
    const oldDiagnostics = getProcessingJobEventDetail(
      manager,
      oldJobId,
    ).diagnostics;
    assert.equal(
      oldDiagnostics.reviewItems.some(
        (item) => item.issueType === "ai_missing",
      ),
      true,
    );

    saveAiSettings({
      enabled: true,
      baseUrl: "https://ai.example.test/v1",
      textModel: "health-structurer",
      apiKey: "test-secret",
    });
    const queued = queueManualAiExtraction(manager, upload.reportId);
    const queuedJob = listProcessingJobs(manager, upload.reportId).find(
      (job) => job.id === queued.id,
    );
    assert.equal(queuedJob?.batchKind, "manual_ai");
    assert.equal(queuedJob?.batchId, `manual-ai:${queued.id}`);
    assert.equal(
      (
        db
          .prepare(
            `
      SELECT COUNT(*) AS count FROM observations WHERE id = 'manual-ai-old-observation'
    `,
          )
          .get() as { count: number }
      ).count,
      1,
      "排队阶段不能提前删除旧指标",
    );

    const ai: AiExecutor = async () => {
      const normalized = normalizeAiExtraction({
        reportType: "laboratory",
        title: "新检验报告",
        hospitalNameRaw: "新模型医院",
        city: null,
        summary: "新模型摘要",
        observations: [
          {
            sectionName: "生化检查",
            itemName: "空腹血糖",
            normalizedName: "空腹血糖",
            resultText: "5.8",
            numericValue: 5.8,
            unit: "mmol/L",
            abnormalFlag: "normal",
            evidence: [{ pageNumber: 1, quote: "空腹血糖 5.8 mmol/L" }],
          },
        ],
      });
      return {
        provider: "test-provider",
        model: "test-model",
        promptVersion: "test-v1",
        ...normalized,
        rawResponseJson: JSON.stringify(normalized),
        promptTokens: 10,
        completionTokens: 8,
        elapsedMs: 12,
      };
    };
    assert.equal(await processNextJob(worker, ai), true);

    const refreshed = getReportDetail(manager, upload.reportId);
    assert.equal(refreshed.title, "新检验报告");
    assert.equal(refreshed.hospitalName, "人工医院");
    assert.equal(refreshed.summary, "人工摘要");
    assert.equal(refreshed.city, null);
    assert.deepEqual([...refreshed.manualFieldKeys].sort(), [
      "hospitalName",
      "summary",
    ]);
    assert.equal(
      (
        db
          .prepare(
            `
      SELECT COUNT(*) AS count FROM observations WHERE id = 'manual-ai-old-observation'
    `,
          )
          .get() as { count: number }
      ).count,
      0,
    );
    const replacement = db
      .prepare(
        `
      SELECT id, numeric_value AS numericValue FROM observations
      WHERE report_id = ? AND item_name = '空腹血糖' LIMIT 1
    `,
      )
      .get(upload.reportId) as { id: string; numericValue: number };
    assert.equal(replacement.numericValue, 5.8);
    const trendPoints = listTrendSeries(manager, "runner-member")
      .flatMap((series) => series.points)
      .filter((point) => point.reportId === upload.reportId);
    assert.equal(trendPoints.length, 1);
    assert.equal(trendPoints[0]?.observationId, replacement.id);
    assert.equal(trendPoints[0]?.numericValue, 5.8);

    const currentDiagnostics = getProcessingJobEventDetail(
      manager,
      queued.id,
    ).diagnostics;
    assert.equal(
      currentDiagnostics.reviewItems.length,
      0,
      "新任务成功后不能继承历史任务的待核对项",
    );
    assert.equal(
      getProcessingJobEventDetail(manager, oldJobId).diagnostics.reviewItems
        .length,
      1,
      "历史日志仍应保留当时的诊断证据",
    );
    const visibleJobs = listProcessingJobs(manager, upload.reportId);
    assert.equal(
      visibleJobs.find((job) => job.id === queued.id)?.status,
      "completed",
    );
    assert.equal(
      visibleJobs.find((job) => job.id === oldJobId)?.batchKind,
      "manual_ai",
    );
  });
});

test("keeps the current report usable until reprocessed OCR and AI atomically replace it", async () => {
  await withDatabase(async () => {
    saveAiSettings({
      enabled: true,
      baseUrl: "https://ai.example.test/v1",
      textModel: "health-structurer",
      apiKey: "test-secret",
    });
    const upload = createUpload(manager, "runner-member", [
      { originalName: "checkup.png", data: pngBytes() },
    ]);
    let aiRound = 0;
    const worker: WorkerExecutor = async (request) =>
      request.action === "thumbnail"
        ? { ok: true, width: 240, height: 320, elapsedMs: 5 }
        : {
            ok: true,
            engine: "test-ocr",
            modelVersion: `test-v${aiRound + 1}`,
            lines: [
              {
                text:
                  aiRound === 0
                    ? "旧体检报告 血糖 5.2 mmol/L"
                    : "新体检报告 血糖 5.8 mmol/L",
                confidence: 0.99,
              },
            ],
            elapsedMs: 6,
          };
    const ai: AiExecutor = async (input) => {
      aiRound += 1;
      const normalized = normalizeAiExtraction({
        reportType: "laboratory",
        title: aiRound === 1 ? "旧血糖报告" : "新血糖报告",
        hospitalNameRaw: "示例医院",
        city: aiRound === 1 ? "旧城市" : null,
        reportIssuedAt: "2026-07-21",
        summary: input.text.includes("新体检报告")
          ? "新识别结果"
          : "旧识别结果",
        observations: [
          {
            itemName: "血糖",
            normalizedName: "血糖",
            resultText: aiRound === 1 ? "5.2" : "5.8",
            numericValue: aiRound === 1 ? 5.2 : 5.8,
            unit: "mmol/L",
            abnormalFlag: "normal",
            evidence: [
              {
                pageNumber: 1,
                quote:
                  aiRound === 1
                    ? "旧体检报告 血糖 5.2 mmol/L"
                    : "新体检报告 血糖 5.8 mmol/L",
              },
            ],
          },
        ],
      });
      return {
        provider: "test-provider",
        model: "test-model",
        promptVersion: "test-v1",
        ...normalized,
        rawResponseJson: JSON.stringify(normalized),
        promptTokens: 10,
        completionTokens: 8,
        elapsedMs: 12,
      };
    };

    assert.equal(await processNextJob(worker, ai), true);
    assert.equal(await processNextJob(worker, ai), true);
    assert.equal(await processNextJob(worker, ai), true);
    assert.equal(aiRound, 1);

    const beforeManualEdit = getReportDetail(manager, upload.reportId);
    const manuallyEdited = updateReportFields(manager, upload.reportId, {
      title: "旧血糖报告",
      reportType: "laboratory",
      hospitalName: "人工医院",
      hospitalBranch: "",
      city: beforeManualEdit.city || "",
      visitType: "",
      departmentName: "",
      orderingDepartment: "",
      performingDepartment: "",
      reportingDepartment: "",
      bodyPart: beforeManualEdit.bodyPart || "",
      reportIssuedAt: "2026-07-21",
      examinedAt: "",
      clinicalDiagnosis: "",
      purpose: "",
      findings: "",
      impression: "",
      summary: "人工摘要",
      recommendation: "",
    });
    assert.deepEqual([...manuallyEdited.manualFieldKeys].sort(), [
      "hospitalName",
      "reportType",
      "summary",
    ]);

    const oldObservation = getDatabase()
      .prepare(
        `
      SELECT id, numeric_value AS numericValue FROM observations WHERE report_id = ? LIMIT 1
    `,
      )
      .get(upload.reportId) as { id: string; numericValue: number };
    const reset = reprocessReportOcrAndAi(manager, upload.reportId);
    assert.equal(reset.queuedOcr, 1);
    assert.equal(reset.aiWillRun, true);
    assert.throws(
      () => reprocessReportOcrAndAi(manager, upload.reportId),
      (error: unknown) =>
        (error as { statusCode?: number; message?: string }).statusCode ===
          409 &&
        (error as { message?: string }).message ===
          "这份报告已有任务在排队或处理中，请稍后再重新识别",
    );
    const preserved = getDatabase()
      .prepare(
        `
      SELECT title, report_type AS reportType, hospital_name_raw AS hospitalName, city, summary, status,
        (SELECT COUNT(*) FROM ocr_results o JOIN report_pages p ON p.id = o.page_id WHERE p.report_id = reports.id) AS ocrCount,
        (SELECT COUNT(*) FROM observations WHERE report_id = reports.id) AS observationCount,
        (SELECT COUNT(*) FROM report_extractions WHERE report_id = reports.id) AS extractionCount
      FROM reports WHERE id = ?
    `,
      )
      .get(upload.reportId) as {
      title: string;
      reportType: string;
      hospitalName: string | null;
      city: string | null;
      summary: string | null;
      status: string;
      ocrCount: number;
      observationCount: number;
      extractionCount: number;
    };
    assert.deepEqual(
      {
        title: preserved.title,
        reportType: preserved.reportType,
        hospitalName: preserved.hospitalName,
        city: preserved.city,
        summary: preserved.summary,
        status: preserved.status,
        ocrCount: preserved.ocrCount,
        observationCount: preserved.observationCount,
        extractionCount: preserved.extractionCount,
      },
      {
        title: "旧血糖报告",
        reportType: "laboratory",
        hospitalName: "人工医院",
        city: "旧城市",
        summary: "人工摘要",
        status: "processing",
        ocrCount: 1,
        observationCount: 1,
        extractionCount: 1,
      },
    );
    const preservedTrendPoints = listTrendSeries(manager, "runner-member")
      .flatMap((series) => series.points)
      .filter((point) => point.reportId === upload.reportId);
    assert.equal(preservedTrendPoints.length, 1);
    assert.equal(preservedTrendPoints[0]?.observationId, oldObservation.id);
    assert.equal(
      preservedTrendPoints[0]?.numericValue,
      oldObservation.numericValue,
    );
    const queuedOcr = getDatabase()
      .prepare(
        `
      SELECT COUNT(*) AS count FROM processing_jobs
      WHERE report_id = ? AND job_type = 'ocr' AND status = 'queued' AND pipeline_version = 'manual-reprocess-v1'
    `,
      )
      .get(upload.reportId) as { count: number };
    assert.equal(queuedOcr.count, 1);
    const visibleReprocessJob = listProcessingJobs(
      manager,
      upload.reportId,
    ).find((job) => job.jobType === "ocr" && job.status === "queued");
    assert.equal(visibleReprocessJob?.pipelineVersion, "manual-reprocess-v1");
    assert.equal(visibleReprocessJob?.batchId, reset.batchId);
    assert.equal(visibleReprocessJob?.batchKind, "manual_reprocess");

    assert.equal(await processNextJob(worker, ai), true);
    const queuedAi = getDatabase()
      .prepare(
        `
      SELECT COUNT(*) AS count FROM processing_jobs
      WHERE report_id = ? AND job_type = 'ai_extract' AND status = 'queued'
        AND pipeline_version = 'manual-reprocess-v1'
    `,
      )
      .get(upload.reportId) as { count: number };
    assert.equal(queuedAi.count, 1);
    const visibleBatchJobs = listProcessingJobs(
      manager,
      upload.reportId,
    ).filter((job) => job.pipelineVersion === "manual-reprocess-v1");
    assert.equal(
      visibleBatchJobs.some((job) => job.jobType === "ai_extract"),
      true,
    );
    assert.deepEqual(
      [...new Set(visibleBatchJobs.map((job) => job.batchId))],
      [reset.batchId],
    );
    assert.equal(
      visibleBatchJobs.every((job) => job.batchKind === "manual_reprocess"),
      true,
    );
    const currentOcr = getDatabase()
      .prepare(
        `
      SELECT COUNT(*) AS count, MAX(lines_json) AS linesJson
      FROM ocr_results o JOIN report_pages p ON p.id = o.page_id
      WHERE p.report_id = ?
    `,
      )
      .get(upload.reportId) as { count: number; linesJson: string };
    assert.equal(currentOcr.count, 1);
    assert.match(currentOcr.linesJson, /新体检报告/);
    assert.equal(await processNextJob(worker, ai), true);
    assert.equal(aiRound, 2);
    const refreshed = getDatabase()
      .prepare(
        `
      SELECT title, report_type AS reportType, hospital_name_raw AS hospitalName, city, summary,
        (SELECT numeric_value FROM observations WHERE report_id = ? AND item_name = '血糖' ORDER BY created_at DESC LIMIT 1) AS glucose,
        (SELECT COUNT(*) FROM report_extractions WHERE report_id = ?) AS extractionCount
      FROM reports WHERE id = ?
    `,
      )
      .get(upload.reportId, upload.reportId, upload.reportId) as {
      title: string;
      reportType: string;
      hospitalName: string;
      city: string | null;
      summary: string;
      glucose: number;
      extractionCount: number;
    };
    assert.equal(refreshed.title, "新血糖报告");
    assert.equal(refreshed.reportType, "laboratory");
    assert.equal(refreshed.hospitalName, "人工医院");
    assert.equal(refreshed.city, null);
    assert.equal(refreshed.summary, "人工摘要");
    assert.equal(refreshed.glucose, 5.8);
    assert.equal(refreshed.extractionCount, 2);
    assert.equal(
      (
        getDatabase()
          .prepare(
            `
      SELECT COUNT(*) AS count FROM observations WHERE id = ?
    `,
          )
          .get(oldObservation.id) as { count: number }
      ).count,
      0,
    );
    const refreshedTrendPoints = listTrendSeries(manager, "runner-member")
      .flatMap((series) => series.points)
      .filter((point) => point.reportId === upload.reportId);
    assert.equal(refreshedTrendPoints.length, 1);
    assert.equal(refreshedTrendPoints[0]?.numericValue, 5.8);
    const audits = getDatabase()
      .prepare(
        `
      SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'report.reprocess_ocr_ai' AND target_id = ?
    `,
      )
      .get(upload.reportId) as { count: number };
    assert.equal(audits.count, 1);
  });
});

test("keeps the previous OCR, observations, and trend when reprocessing exhausts its retries", async () => {
  await withDatabase(async () => {
    saveAiSettings({
      enabled: true,
      baseUrl: "https://ai.example.test/v1",
      textModel: "health-structurer",
      apiKey: "test-secret",
    });
    const upload = createUpload(manager, "runner-member", [
      { originalName: "reprocess-failure.png", data: pngBytes() },
    ]);
    const initialWorker: WorkerExecutor = async (request) =>
      request.action === "thumbnail"
        ? { ok: true, width: 240, height: 320, elapsedMs: 5 }
        : {
            ok: true,
            engine: "test-ocr",
            modelVersion: "stable-v1",
            lines: [{ text: "检验结果 血糖 4.9 mmol/L", confidence: 0.99 }],
            elapsedMs: 6,
          };
    const initialAi: AiExecutor = async () => {
      const normalized = normalizeAiExtraction({
        reportType: "laboratory",
        title: "稳定检验报告",
        reportIssuedAt: "2026-07-22",
        observations: [
          {
            itemName: "血糖",
            normalizedName: "血糖",
            resultText: "4.9",
            numericValue: 4.9,
            unit: "mmol/L",
            abnormalFlag: "normal",
            evidence: [{ pageNumber: 1, quote: "检验结果 血糖 4.9 mmol/L" }],
          },
        ],
      });
      return {
        provider: "test-provider",
        model: "test-model",
        promptVersion: "test-v1",
        ...normalized,
        rawResponseJson: JSON.stringify(normalized),
        promptTokens: 10,
        completionTokens: 8,
        elapsedMs: 12,
      };
    };

    assert.equal(await processNextJob(initialWorker, initialAi), true);
    assert.equal(await processNextJob(initialWorker, initialAi), true);
    assert.equal(await processNextJob(initialWorker, initialAi), true);
    const db = getDatabase();
    const previous = db
      .prepare(
        `
      SELECT o.id AS observationId, o.numeric_value AS numericValue, r.title,
        (SELECT x.id FROM ocr_results x JOIN report_pages p ON p.id = x.page_id
          WHERE p.report_id = r.id LIMIT 1) AS ocrId,
        (SELECT COUNT(*) FROM processing_jobs j WHERE j.report_id = r.id AND j.job_type = 'ai_extract') AS aiJobs
      FROM reports r JOIN observations o ON o.report_id = r.id
      WHERE r.id = ? LIMIT 1
    `,
      )
      .get(upload.reportId) as {
      observationId: string;
      numericValue: number;
      title: string;
      ocrId: string;
      aiJobs: number;
    };

    reprocessReportOcrAndAi(manager, upload.reportId);
    const failingWorker: WorkerExecutor = async () => {
      throw Object.assign(new Error("模拟 OCR 重跑失败"), {
        code: "TEST_REPROCESS_OCR_FAILED",
      });
    };
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      if (attempt > 1) {
        db.prepare(
          `
          UPDATE processing_jobs SET next_retry_at = CURRENT_TIMESTAMP
          WHERE report_id = ? AND job_type = 'ocr' AND status = 'queued'
            AND pipeline_version = 'manual-reprocess-v1'
        `,
        ).run(upload.reportId);
      }
      await assert.rejects(
        () => processNextJob(failingWorker, initialAi),
        /模拟 OCR 重跑失败/,
      );
    }

    const failed = db
      .prepare(
        `
      SELECT r.title, r.status,
        (SELECT COUNT(*) FROM observations WHERE report_id = r.id) AS observationCount,
        (SELECT COUNT(*) FROM ocr_results x JOIN report_pages p ON p.id = x.page_id WHERE p.report_id = r.id) AS ocrCount,
        (SELECT x.id FROM ocr_results x JOIN report_pages p ON p.id = x.page_id WHERE p.report_id = r.id LIMIT 1) AS ocrId,
        (SELECT COUNT(*) FROM processing_jobs j WHERE j.report_id = r.id AND j.job_type = 'ai_extract') AS aiJobs
      FROM reports r WHERE r.id = ?
    `,
      )
      .get(upload.reportId) as {
      title: string;
      status: string;
      observationCount: number;
      ocrCount: number;
      ocrId: string;
      aiJobs: number;
    };
    assert.equal(failed.title, previous.title);
    assert.equal(failed.status, "needs_review");
    assert.equal(failed.observationCount, 1);
    assert.equal(failed.ocrCount, 1);
    assert.equal(failed.ocrId, previous.ocrId);
    assert.equal(failed.aiJobs, previous.aiJobs);
    const observation = db
      .prepare(
        `
      SELECT id, numeric_value AS numericValue FROM observations WHERE report_id = ? LIMIT 1
    `,
      )
      .get(upload.reportId) as { id: string; numericValue: number };
    assert.equal(observation.id, previous.observationId);
    assert.equal(observation.numericValue, previous.numericValue);
    const trendPoints = listTrendSeries(manager, "runner-member")
      .flatMap((series) => series.points)
      .filter((point) => point.reportId === upload.reportId);
    assert.equal(trendPoints.length, 1);
    assert.equal(trendPoints[0]?.observationId, previous.observationId);
    assert.equal(trendPoints[0]?.numericValue, previous.numericValue);
    assert.equal(trendPoints[0]?.reportStatus, "needs_review");
  });
});

test("preserves a ready report when a manual AI batch fails", async () => {
  await withDatabase(async () => {
    const upload = createUpload(manager, "runner-member", [
      { originalName: "manual-ai-status.png", data: pngBytes() },
    ]);
    const worker: WorkerExecutor = async (request) =>
      request.action === "thumbnail"
        ? { ok: true, width: 240, height: 320, elapsedMs: 4 }
        : {
            ok: true,
            engine: "test-ocr",
            modelVersion: "test-v1",
            lines: [{ text: "检验结果 4.9 mmol/L", confidence: 0.99 }],
            elapsedMs: 5,
          };
    assert.equal(await processNextJob(worker), true);
    assert.equal(await processNextJob(worker), true);
    const db = getDatabase();
    db.prepare("UPDATE reports SET status = 'ready' WHERE id = ?").run(
      upload.reportId,
    );
    saveAiSettings({
      enabled: true,
      baseUrl: "https://ai.example.test/v1",
      textModel: "health-structurer",
      apiKey: "test-secret",
    });

    const queued = queueManualAiExtraction(manager, upload.reportId);
    db.prepare(
      `
      UPDATE processing_jobs SET status = 'failed', attempts = 3,
        error_code = 'TEST_AI_FAILED', error_message = '模拟 AI 失败', finished_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `,
    ).run(queued.id);
    assert.equal(reconcileReportProcessingStatus(upload.reportId), "ready");

    const report = db
      .prepare("SELECT status FROM reports WHERE id = ?")
      .get(upload.reportId) as { status: string };
    assert.equal(report.status, "ready");
    const notice = db
      .prepare(
        `
      SELECT title, severity FROM app_notifications
      WHERE report_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1
    `,
      )
      .get(upload.reportId) as { title: string; severity: string };
    assert.equal(notice.title, "重新处理失败，已保留原结果");
    assert.equal(notice.severity, "warning");
  });
});

test("uses only the latest processing batch after an earlier rerun failed", async () => {
  await withDatabase(async () => {
    const upload = createUpload(manager, "runner-member", [
      { originalName: "batch-status.png", data: pngBytes() },
    ]);
    const worker: WorkerExecutor = async (request) =>
      request.action === "thumbnail"
        ? { ok: true, width: 240, height: 320, elapsedMs: 4 }
        : {
            ok: true,
            engine: "test-ocr",
            modelVersion: "test-v2",
            lines: [{ text: "复查结果 5.1 mmol/L", confidence: 0.99 }],
            elapsedMs: 5,
          };
    assert.equal(await processNextJob(worker), true);
    assert.equal(await processNextJob(worker), true);
    const db = getDatabase();
    db.prepare("UPDATE reports SET status = 'ready' WHERE id = ?").run(
      upload.reportId,
    );

    reprocessReportOcrAndAi(manager, upload.reportId);
    db.prepare(
      `
      UPDATE processing_jobs SET status = 'failed', attempts = 3, finished_at = CURRENT_TIMESTAMP
      WHERE report_id = ? AND pipeline_version = 'manual-reprocess-v1' AND status = 'queued'
    `,
    ).run(upload.reportId);
    assert.equal(reconcileReportProcessingStatus(upload.reportId), "ready");

    reprocessReportOcrAndAi(manager, upload.reportId);
    assert.equal(await processNextJob(worker), true);
    const report = db
      .prepare("SELECT status FROM reports WHERE id = ?")
      .get(upload.reportId) as { status: string };
    assert.equal(report.status, "needs_review");
    const historicalFailures = db
      .prepare(
        `
      SELECT COUNT(*) AS count FROM processing_jobs
      WHERE report_id = ? AND pipeline_version = 'manual-reprocess-v1' AND status = 'failed'
    `,
      )
      .get(upload.reportId) as { count: number };
    assert.equal(historicalFailures.count, 0);
  });
});

test("recovers expired leases and settles orphaned processing reports", async () => {
  await withDatabase(async () => {
    const upload = createUpload(manager, "runner-member", [
      { originalName: "lease-recovery.png", data: pngBytes() },
    ]);
    const db = getDatabase();
    const jobs = db
      .prepare("SELECT id FROM processing_jobs WHERE report_id = ? ORDER BY id")
      .all(upload.reportId) as Array<{ id: string }>;
    db.prepare(
      "UPDATE processing_jobs SET status = 'cancelled', finished_at = CURRENT_TIMESTAMP WHERE report_id = ?",
    ).run(upload.reportId);
    db.prepare(
      `
      UPDATE processing_jobs SET status = 'processing', attempts = 3,
        lease_expires_at = datetime('now', '-1 minute'), finished_at = NULL
      WHERE id = ?
    `,
    ).run(jobs[0]!.id);
    db.prepare("UPDATE reports SET status = 'processing' WHERE id = ?").run(
      upload.reportId,
    );

    assert.equal(claimNextJob(), null);
    const expired = db
      .prepare(
        "SELECT status, error_code AS errorCode FROM processing_jobs WHERE id = ?",
      )
      .get(jobs[0]!.id) as { status: string; errorCode: string };
    assert.equal(expired.status, "failed");
    assert.equal(expired.errorCode, "LEASE_EXPIRED");
    const failedReport = db
      .prepare("SELECT status FROM reports WHERE id = ?")
      .get(upload.reportId) as { status: string };
    assert.equal(failedReport.status, "failed");

    db.prepare(
      "UPDATE processing_jobs SET status = 'completed' WHERE report_id = ?",
    ).run(upload.reportId);
    db.prepare("UPDATE reports SET status = 'processing' WHERE id = ?").run(
      upload.reportId,
    );
    assert.equal(claimNextJob(), null);
    const repaired = db
      .prepare("SELECT status FROM reports WHERE id = ?")
      .get(upload.reportId) as { status: string };
    assert.equal(repaired.status, "needs_review");
  });
});

test("never revives an expired task for a trashed report", async () => {
  await withDatabase(async () => {
    const upload = createUpload(manager, "runner-member", [
      { originalName: "trashed-lease.png", data: pngBytes() },
    ]);
    const db = getDatabase();
    const job = db
      .prepare("SELECT id FROM processing_jobs WHERE report_id = ? LIMIT 1")
      .get(upload.reportId) as { id: string };
    db.prepare(
      "UPDATE processing_jobs SET status = 'cancelled' WHERE report_id = ?",
    ).run(upload.reportId);
    db.prepare(
      `
      UPDATE processing_jobs SET status = 'processing', attempts = 1,
        lease_expires_at = datetime('now', '-1 minute') WHERE id = ?
    `,
    ).run(job.id);
    db.prepare("UPDATE reports SET status = 'trashed' WHERE id = ?").run(
      upload.reportId,
    );

    assert.equal(claimNextJob(), null);
    const report = db
      .prepare("SELECT status FROM reports WHERE id = ?")
      .get(upload.reportId) as { status: string };
    const recoveredJob = db
      .prepare("SELECT status FROM processing_jobs WHERE id = ?")
      .get(job.id) as { status: string };
    assert.equal(report.status, "trashed");
    assert.equal(recoveredJob.status, "cancelled");
  });
});

test("builds deterministic titles from extracted report fields", () => {
  const imaging = normalizeAiExtraction({
    reportType: "imaging",
    reportSubtype: "CT",
    hospitalNameRaw: "示例市第一医院",
    reportIssuedAt: "2026-07-21",
    bodyParts: [{ raw: "胸部", name: "胸部", laterality: "unspecified" }],
  }).fields;
  assert.equal(buildReportTitle(imaging), "胸部CT报告");

  const outpatient = normalizeAiExtraction({
    reportType: "outpatient",
    hospitalNameRaw: "示例儿童医院",
    examinedAt: "2026-07-20 09:30:00",
    visitDepartment: "儿科",
  }).fields;
  assert.equal(buildReportTitle(outpatient), "儿科门诊记录");

  const genericLaboratory = normalizeAiExtraction({
    reportType: "laboratory",
    title: "检验报告单",
    observations: [
      {
        sectionName: "生化检验",
        itemName: "空腹血糖",
        resultText: "5.6",
        numericValue: 5.6,
        unit: "mmol/L",
      },
      {
        sectionName: "生化检验",
        itemName: "总胆固醇",
        resultText: "4.8",
        numericValue: 4.8,
        unit: "mmol/L",
      },
    ],
  }).fields;
  assert.equal(buildReportTitle(genericLaboratory), "生化检验报告");
  assert.equal(genericLaboratory.bodyParts[0]?.name, "生化检验");

  const genericCheckup = normalizeAiExtraction({
    reportType: "checkup",
    reportSubtype: "checkup",
  }).fields;
  assert.equal(genericCheckup.reportSubtype, null);
  assert.equal(genericCheckup.bodyParts[0]?.name, "综合体检");
  assert.equal(buildReportTitle(genericCheckup), "综合体检报告");

  const leakedBodyPart = normalizeAiExtraction({
    reportType: "physical_exam",
    reportSubtype: "physical_exam",
    bodyParts: [{ raw: "checkup", name: "checkup", laterality: "unspecified" }],
  }).fields;
  assert.equal(leakedBodyPart.reportSubtype, null);
  assert.equal(leakedBodyPart.bodyParts[0]?.name, "综合体检");

  const meaningfulSubtype = normalizeAiExtraction({
    reportType: "imaging",
    reportSubtype: "腹部彩超",
  }).fields;
  assert.equal(meaningfulSubtype.bodyParts[0]?.name, "腹部彩超");
});

test("keeps scalar indicators separate from structured morphology findings", () => {
  const normalized = normalizeAiExtraction({
    reportType: "imaging",
    observations: [
      {
        sectionName: "一般检查",
        itemName: "体重",
        resultText: "68 kg",
        numericValue: 68,
        unit: "kg",
      },
      {
        sectionName: "腹部彩超",
        itemName: "肝右叶囊肿",
        resultText: "3.2×2.8 cm，边界清晰",
        evidence: [{ pageNumber: 4, quote: "肝右叶囊肿3.2×2.8 cm，边界清晰" }],
      },
    ],
    morphologyFindings: [
      {
        sectionName: "甲状腺彩超",
        organ: "甲状腺",
        laterality: "left",
        findingType: "结节",
        findingName: "甲状腺左叶结节",
        presence: "present",
        size: { length: 6, width: 4, unit: "mm" },
        classification: {
          system: "C-TIRADS",
          value: "3",
          text: "C-TIRADS 3类",
        },
        morphology: "边界清晰",
        rawText: "甲状腺左叶结节6×4mm，C-TIRADS 3类",
        evidence: [
          { pageNumber: 5, quote: "甲状腺左叶结节6×4mm，C-TIRADS 3类" },
        ],
      },
      {
        sectionName: "前列腺彩超",
        organ: "前列腺",
        findingType: "检查发现",
        findingName: "未见明显异常",
        presence: "absent",
        rawText: "前列腺未见明显异常",
        evidence: [{ pageNumber: 6, quote: "前列腺未见明显异常" }],
      },
      {
        sectionName: "前列腺彩超",
        organ: "前列腺",
        findingType: "形态发现",
        findingName: "形态规则",
        presence: "present",
        rawText: "前列腺大小正常，形态规则，边界清晰",
        evidence: [
          { pageNumber: 6, quote: "前列腺大小正常，形态规则，边界清晰" },
        ],
      },
      {
        sectionName: "前列腺彩超",
        organ: "前列腺",
        findingType: "检查发现",
        findingName: "检查发现",
        presence: "uncertain",
        rawText: "前列腺超声检查",
        evidence: [{ pageNumber: 6, quote: "前列腺超声检查" }],
      },
      {
        sectionName: "甲状腺彩超",
        organ: "甲状腺",
        findingType: "结节",
        findingName: "未见甲状腺结节",
        presence: "absent",
        rawText: "双侧甲状腺未见明确结节",
        evidence: [{ pageNumber: 5, quote: "双侧甲状腺未见明确结节" }],
      },
    ],
  }).fields;

  assert.deepEqual(
    normalized.observations.map((item) => item.itemName),
    ["体重"],
  );
  assert.equal(normalized.morphologyFindings.length, 3);
  assert.deepEqual(
    normalized.morphologyFindings.map((item) => ({
      name: item.findingName,
      type: item.findingType,
      length: item.size.length,
      width: item.size.width,
      unit: item.size.unit,
    })),
    [
      { name: "甲状腺左叶结节", type: "结节", length: 6, width: 4, unit: "mm" },
      {
        name: "未见甲状腺结节",
        type: "结节",
        length: null,
        width: null,
        unit: null,
      },
      { name: "肝右叶囊肿", type: "囊肿", length: 3.2, width: 2.8, unit: "cm" },
    ],
  );
});

test("cancels queued and processing jobs on user request and reconciles report status", async () => {
  await withDatabase(async () => {
    const upload = createUpload(manager, "runner-member", [
      { originalName: "report.png", data: pngBytes() },
    ]);
    const db = getDatabase();
    db.prepare(
      "UPDATE processing_jobs SET status = 'processing' WHERE report_id = ? AND job_type = 'ocr'",
    ).run(upload.reportId);

    const result = cancelReportProcessing(manager, upload.reportId);
    assert.ok(result.cancelled >= 1);
    assert.equal(
      (
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM processing_jobs WHERE report_id = ? AND status IN ('queued', 'processing')",
          )
          .get(upload.reportId) as { n: number }
      ).n,
      0,
    );
    assert.equal(
      (
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM processing_jobs WHERE report_id = ? AND status = 'cancelled'",
          )
          .get(upload.reportId) as { n: number }
      ).n,
      result.cancelled,
    );
    const cancelEvent = db
      .prepare(
        `SELECT message, detail_json FROM processing_job_events
         WHERE report_id = ? AND event_type = 'cancelled' ORDER BY created_at DESC LIMIT 1`,
      )
      .get(upload.reportId) as { message: string; detail_json: string };
    assert.equal(cancelEvent.message, "用户手动中断任务");
    assert.match(cancelEvent.detail_json, /user_cancel/);
    /* 首次处理即被中断、没有可用结果的报告回到 failed，可重新触发 */
    assert.equal(
      (
        db
          .prepare("SELECT status FROM reports WHERE id = ?")
          .get(upload.reportId) as { status: string }
      ).status,
      "failed",
    );
    assert.throws(
      () => cancelReportProcessing(manager, upload.reportId),
      /没有排队或处理中的任务/,
    );
  });
});
