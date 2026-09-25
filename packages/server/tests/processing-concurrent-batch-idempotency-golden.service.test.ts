import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { closeDatabaseForTests, getDatabase } from "../database/client.ts";
import type { RequestUser } from "../domain/request-user.ts";
import {
  listProcessingJobEvents,
  processNextJob,
  queueManualAiExtraction,
  reprocessReportOcrAndAi,
  retryProcessingJob,
  type WorkerExecutor,
} from "../services/job-runner.service.ts";
import {
  aiExtractionPromptVersion,
  normalizeAiExtraction,
  type AiExecutor,
  type AiExtractionInput,
} from "../services/ai-extraction.service.ts";
import { saveAiSettings } from "../services/ai-settings.service.ts";
import { listTrendSeries } from "../services/records.service.ts";
import { createUpload } from "../services/upload.service.ts";

const fixture = JSON.parse(
  readFileSync(
    new URL(
      "./fixtures/p3-concurrent-batch-idempotency-golden.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as {
  expected: {
    pages: number;
    observationCount: number;
    trendPointCount: number;
    duplicateGroups: number;
    maximumActiveAiJobs: number;
    manualRetryEvents: number;
    staleExtractionCount: number;
  };
};

const manager: RequestUser = {
  id: "p3-concurrency-manager",
  displayName: "并发批次金标管理员",
  provider: "development",
  authenticated: true,
  isGatewayAdmin: true,
};

const indicatorDefinitions = [
  ["空腹血糖", "mmol/L", 3.9, 6.1, 5.1],
  ["总胆固醇", "mmol/L", 2.8, 5.7, 4.1],
  ["白细胞计数", "10^9/L", 3.5, 9.5, 5.2],
] as const;

function pageData(pageNumber: number, generation: number) {
  const [itemName, unit, referenceLow, referenceHigh, baseValue] =
    indicatorDefinitions[pageNumber - 1]!;
  const numericValue = Number((baseValue + (generation - 1) * 0.4).toFixed(1));
  const resultText = numericValue.toFixed(1);
  const scalarText = `${itemName} ${resultText} ${unit} 参考范围 ${referenceLow}-${referenceHigh}`;
  return {
    pageNumber,
    itemName,
    unit,
    referenceLow,
    referenceHigh,
    numericValue,
    resultText,
    scalarText,
  };
}

function pngBytes(index: number) {
  return Uint8Array.from([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    0x50 + index,
  ]);
}

async function withDatabase(run: () => Promise<void>) {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-p3-concurrency-"));
  const previousConcurrency = process.env.AI_EXTRACTION_CONCURRENCY;
  process.env.STORAGE_DIR = storageDir;
  process.env.AI_EXTRACTION_CONCURRENCY = "1";
  try {
    const db = getDatabase();
    db.prepare(
      "INSERT INTO users (id, display_name, is_gateway_admin) VALUES (?, ?, 1)",
    ).run(manager.id, manager.displayName);
    db.prepare(
      `
      INSERT INTO health_members (id, display_name, relationship, created_by)
      VALUES ('p3-concurrency-member', '匿名成员', 'self', ?)
    `,
    ).run(manager.id);
    db.prepare(
      `
      INSERT INTO member_permissions (member_id, user_id, permission, granted_by)
      VALUES ('p3-concurrency-member', ?, 'manager', ?)
    `,
    ).run(manager.id, manager.id);
    await run();
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    if (previousConcurrency === undefined) {
      delete process.env.AI_EXTRACTION_CONCURRENCY;
    } else {
      process.env.AI_EXTRACTION_CONCURRENCY = previousConcurrency;
    }
    rmSync(storageDir, { recursive: true, force: true });
  }
}

function storagePageNumbers(reportId: string) {
  const rows = getDatabase()
    .prepare(
      `
      SELECT storage_path AS storagePath, page_number AS pageNumber
      FROM report_pages WHERE report_id = ?
    `,
    )
    .all(reportId) as Array<{ storagePath: string; pageNumber: number }>;
  return new Map(rows.map((row) => [row.storagePath, row.pageNumber]));
}

function pageNumberForPath(imagePath: string, paths: Map<string, number>) {
  const entry = [...paths.entries()].find(([path]) => imagePath.endsWith(path));
  assert.ok(entry, `无法定位匿名测试页：${imagePath}`);
  return entry[1];
}

function workerForGeneration(
  generation: number,
  paths: Map<string, number>,
): WorkerExecutor {
  return async (request) => {
    if (request.action === "thumbnail") {
      return { ok: true, width: 240, height: 320, elapsedMs: 3 };
    }
    const pageNumber = pageNumberForPath(request.imagePath, paths);
    const page = pageData(pageNumber, generation);
    return {
      ok: true,
      engine: "concurrency-golden-ocr",
      modelVersion: `concurrency-ocr-v${generation}`,
      lines: [
        {
          id: `concurrency_header_${generation}_${pageNumber}`,
          text: `匿名并发批次报告 第${pageNumber}页 报告编号：SYNTHETIC 报告日期：2026-08-06`,
          confidence: 0.99,
          box: [0, 0, 180, 10],
        },
        {
          id: `concurrency_scalar_${generation}_${pageNumber}`,
          text: page.scalarText,
          confidence: 0.99,
          box: [0, 12, 180, 22],
        },
        {
          id: `concurrency_generation_${generation}_${pageNumber}`,
          text: `有效处理批次 ${generation}`,
          confidence: 0.99,
          box: [0, 24, 180, 34],
        },
        ...Array.from({ length: 12 }, (_, index) => ({
          id: `concurrency_context_${generation}_${pageNumber}_${index + 1}`,
          text: "匿名检验上下文完整确认",
          confidence: 0.99,
          box: [0, 36 + index * 10, 180, 44 + index * 10],
        })),
      ],
      elapsedMs: 5,
    };
  };
}

function generationForInput(input: AiExtractionInput) {
  for (let generation = 9; generation >= 1; generation -= 1) {
    if (input.text.includes(`有效处理批次 ${generation}`)) return generation;
    if (
      indicatorDefinitions.some((_, index) =>
        input.text.includes(pageData(index + 1, generation).scalarText),
      )
    ) {
      return generation;
    }
  }
  return 1;
}

function aiResult(input: AiExtractionInput) {
  const generation = generationForInput(input);
  const pageNumbers = input.pageNumbers || [];
  const observations = indicatorDefinitions.flatMap((_, index) => {
    const page = pageData(index + 1, generation);
    if (
      !pageNumbers.includes(page.pageNumber) ||
      !input.text.includes(page.scalarText)
    ) {
      return [];
    }
    return [
      {
        sectionName: page.pageNumber <= 2 ? "生化检查" : "血常规",
        itemName: page.itemName,
        normalizedName: page.itemName,
        resultText: page.resultText,
        numericValue: page.numericValue,
        unit: page.unit,
        referenceLow: page.referenceLow,
        referenceHigh: page.referenceHigh,
        abnormalFlag: "normal" as const,
        evidence: [{ pageNumber: page.pageNumber, quote: page.scalarText }],
      },
    ];
  });
  const documentFields =
    input.route === "document" || input.allowDocumentFields
      ? {
          reportType: "laboratory",
          title: `匿名并发批次报告 ${generation}`,
          hospitalNameRaw: "匿名示例医院",
          reportIssuedAt: "2026-08-06",
          summary: `匿名处理批次 ${generation} 已完成`,
        }
      : {};
  const normalized = normalizeAiExtraction({
    ...documentFields,
    observations,
  });
  return {
    provider: "concurrency-golden-provider",
    model: "concurrency-golden-model",
    promptVersion: aiExtractionPromptVersion,
    ...normalized,
    rawResponseJson: JSON.stringify(normalized),
    promptTokens: 18,
    completionTokens: 14,
    elapsedMs: 8,
  };
}

const aiExecutor: AiExecutor = async (input) => aiResult(input);

async function drainJobs(
  worker: WorkerExecutor,
  ai: AiExecutor = aiExecutor,
  maximum = 30,
) {
  let count = 0;
  while (count < maximum && (await processNextJob(worker, ai))) count += 1;
  assert.ok(count < maximum, "并发批次金标任务不应无限循环");
  return count;
}

function expectConflict(run: () => unknown, message: RegExp) {
  assert.throws(
    run,
    (error: unknown) =>
      (error as { statusCode?: number }).statusCode === 409 &&
      message.test((error as { message?: string }).message || ""),
  );
}

function snapshot(reportId: string) {
  const db = getDatabase();
  const observations = db
    .prepare(
      `
      SELECT COALESCE(normalized_name, item_name) AS itemName,
        numeric_value AS numericValue, result_text AS resultText, unit
      FROM observations WHERE report_id = ?
      ORDER BY COALESCE(normalized_name, item_name), unit
    `,
    )
    .all(reportId);
  const trends = listTrendSeries(manager, "p3-concurrency-member")
    .flatMap((series) =>
      series.points
        .filter((point) => point.reportId === reportId)
        .map((point) => ({
          itemName: series.name,
          numericValue: point.numericValue,
          resultText: point.resultText,
          unit: series.unit,
        })),
    )
    .sort((left, right) =>
      `${left.itemName}:${left.unit}`.localeCompare(
        `${right.itemName}:${right.unit}`,
      ),
    );
  return { observations, trends };
}

function assertCleanResult(reportId: string, generation: number) {
  const db = getDatabase();
  const current = snapshot(reportId);
  assert.equal(current.observations.length, fixture.expected.observationCount);
  assert.equal(current.trends.length, fixture.expected.trendPointCount);
  const expectedValues = indicatorDefinitions
    .map((_, index) => pageData(index + 1, generation).numericValue)
    .sort((left, right) => left - right);
  assert.deepEqual(
    current.observations
      .map((row) => Number((row as { numericValue: number }).numericValue))
      .sort((left, right) => left - right),
    expectedValues,
  );
  assert.deepEqual(
    current.trends
      .map((row) => Number(row.numericValue))
      .sort((left, right) => left - right),
    expectedValues,
  );
  const duplicates = db
    .prepare(
      `
      SELECT COUNT(*) AS count FROM (
        SELECT COALESCE(normalized_name, item_name), COALESCE(unit, ''),
          COALESCE(CAST(numeric_value AS TEXT), result_text)
        FROM observations WHERE report_id = ?
        GROUP BY COALESCE(normalized_name, item_name), COALESCE(unit, ''),
          COALESCE(CAST(numeric_value AS TEXT), result_text)
        HAVING COUNT(*) > 1
      )
    `,
    )
    .get(reportId) as { count: number };
  assert.equal(duplicates.count, fixture.expected.duplicateGroups);
}

function createDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function cancelActiveJobs(reportId: string) {
  getDatabase()
    .prepare(
      `
      UPDATE processing_jobs SET status = 'cancelled', locked_at = NULL,
        lease_expires_at = NULL, next_retry_at = NULL,
        finished_at = COALESCE(finished_at, CURRENT_TIMESTAMP)
      WHERE report_id = ? AND status IN ('queued', 'processing')
    `,
    )
    .run(reportId);
}

function activeJobCount(reportId: string, jobType?: string) {
  const row = getDatabase()
    .prepare(
      `
      SELECT COUNT(*) AS count FROM processing_jobs
      WHERE report_id = ? AND status IN ('queued', 'processing')
        AND (? IS NULL OR job_type = ?)
    `,
    )
    .get(reportId, jobType || null, jobType || null) as { count: number };
  return row.count;
}

async function createReadyReport() {
  const upload = createUpload(
    manager,
    "p3-concurrency-member",
    Array.from({ length: fixture.expected.pages }, (_, index) => ({
      originalName: `anonymous-concurrency-${index + 1}.png`,
      data: pngBytes(index + 1),
    })),
  );
  const paths = storagePageNumbers(upload.reportId);
  await drainJobs(workerForGeneration(1, paths));
  assertCleanResult(upload.reportId, 1);
  return { reportId: upload.reportId, paths };
}

test("rejects duplicate triggers and prevents a cancelled AI job from overwriting a newer OCR+AI batch", async () => {
  await withDatabase(async () => {
    saveAiSettings({
      enabled: true,
      baseUrl: "https://ai.example.test/v1",
      textModel: "concurrency-golden-model",
      apiKey: "test-secret",
    });
    const { reportId, paths } = await createReadyReport();
    const staleAiJob = queueManualAiExtraction(manager, reportId);
    expectConflict(
      () => queueManualAiExtraction(manager, reportId),
      /AI 整理任务已在队列中/,
    );
    expectConflict(
      () => reprocessReportOcrAndAi(manager, reportId),
      /已有任务在排队或处理中/,
    );
    assert.equal(
      activeJobCount(reportId, "ai_extract"),
      fixture.expected.maximumActiveAiJobs,
    );

    const started = createDeferred();
    const release = createDeferred();
    let signalled = false;
    const pausedAi: AiExecutor = async (input) => {
      if (!signalled) {
        signalled = true;
        started.resolve();
      }
      await release.promise;
      return aiResult(input);
    };
    const staleRun = processNextJob(workerForGeneration(1, paths), pausedAi);
    await started.promise;
    expectConflict(
      () => queueManualAiExtraction(manager, reportId),
      /AI 整理任务已在队列中/,
    );
    expectConflict(
      () => reprocessReportOcrAndAi(manager, reportId),
      /已有任务在排队或处理中/,
    );

    cancelActiveJobs(reportId);
    const freshBatch = reprocessReportOcrAndAi(manager, reportId);
    assert.equal(freshBatch.queuedOcr, fixture.expected.pages);
    expectConflict(
      () => queueManualAiExtraction(manager, reportId),
      /本地识别仍在处理中/,
    );
    expectConflict(
      () => reprocessReportOcrAndAi(manager, reportId),
      /已有任务在排队或处理中/,
    );

    await drainJobs(workerForGeneration(2, paths));
    assertCleanResult(reportId, 2);
    const freshSnapshot = snapshot(reportId);

    release.resolve();
    assert.equal(await staleRun, true);
    assert.deepEqual(snapshot(reportId), freshSnapshot);
    const staleExtraction = getDatabase()
      .prepare(
        "SELECT COUNT(*) AS count FROM report_extractions WHERE job_id = ?",
      )
      .get(staleAiJob.id) as { count: number };
    assert.equal(
      staleExtraction.count,
      fixture.expected.staleExtractionCount,
    );
    const staleStatus = getDatabase()
      .prepare("SELECT status FROM processing_jobs WHERE id = ?")
      .get(staleAiJob.id) as { status: string };
    assert.equal(staleStatus.status, "cancelled");

    const retryJob = queueManualAiExtraction(manager, reportId);
    getDatabase()
      .prepare(
        `
        UPDATE processing_jobs SET status = 'failed', attempts = 3,
          error_code = 'TEST_FINAL_FAILURE', error_message = '匿名模拟失败',
          finished_at = CURRENT_TIMESTAMP WHERE id = ?
      `,
      )
      .run(retryJob.id);
    assert.deepEqual(retryProcessingJob(manager, retryJob.id), {
      id: retryJob.id,
      status: "queued",
    });
    expectConflict(
      () => retryProcessingJob(manager, retryJob.id),
      /只有失败任务可以重试/,
    );
    expectConflict(
      () => queueManualAiExtraction(manager, reportId),
      /AI 整理任务已在队列中/,
    );
    const manualRetryEvents = listProcessingJobEvents(manager, retryJob.id).filter(
      (event) => event.eventType === "manual_retry",
    );
    assert.equal(
      manualRetryEvents.length,
      fixture.expected.manualRetryEvents,
    );
    assert.equal(
      await processNextJob(workerForGeneration(2, paths), aiExecutor),
      true,
    );
    assertCleanResult(reportId, 2);
  });
});

test("prevents a cancelled OCR response from replacing a newer completed OCR batch", async () => {
  await withDatabase(async () => {
    saveAiSettings({
      enabled: true,
      baseUrl: "https://ai.example.test/v1",
      textModel: "concurrency-golden-model",
      apiKey: "test-secret",
    });
    const { reportId, paths } = await createReadyReport();
    const staleBatch = reprocessReportOcrAndAi(manager, reportId);
    assert.equal(staleBatch.queuedOcr, fixture.expected.pages);

    const started = createDeferred();
    const release = createDeferred();
    let signalled = false;
    const staleWorker: WorkerExecutor = async (request) => {
      if (request.action === "thumbnail") {
        return { ok: true, width: 240, height: 320, elapsedMs: 3 };
      }
      if (!signalled) {
        signalled = true;
        started.resolve();
      }
      await release.promise;
      return workerForGeneration(9, paths)(request);
    };
    const staleRun = processNextJob(staleWorker, aiExecutor);
    await started.promise;
    expectConflict(
      () => reprocessReportOcrAndAi(manager, reportId),
      /已有任务在排队或处理中/,
    );
    expectConflict(
      () => queueManualAiExtraction(manager, reportId),
      /本地识别仍在处理中/,
    );

    cancelActiveJobs(reportId);
    const freshBatch = reprocessReportOcrAndAi(manager, reportId);
    assert.equal(freshBatch.queuedOcr, fixture.expected.pages);
    await drainJobs(workerForGeneration(2, paths));
    assertCleanResult(reportId, 2);
    const freshSnapshot = snapshot(reportId);
    const ocrBeforeLateReturn = getDatabase()
      .prepare(
        `
        SELECT o.lines_json AS linesJson FROM ocr_results o
        JOIN report_pages p ON p.id = o.page_id
        WHERE p.report_id = ? ORDER BY p.page_number
      `,
      )
      .all(reportId) as Array<{ linesJson: string }>;
    assert.equal(
      ocrBeforeLateReturn.every((row) => row.linesJson.includes("有效处理批次 2")),
      true,
    );

    release.resolve();
    assert.equal(await staleRun, true);
    assert.deepEqual(snapshot(reportId), freshSnapshot);
    const ocrAfterLateReturn = getDatabase()
      .prepare(
        `
        SELECT o.lines_json AS linesJson FROM ocr_results o
        JOIN report_pages p ON p.id = o.page_id
        WHERE p.report_id = ? ORDER BY p.page_number
      `,
      )
      .all(reportId) as Array<{ linesJson: string }>;
    assert.deepEqual(ocrAfterLateReturn, ocrBeforeLateReturn);
    assert.equal(
      ocrAfterLateReturn.some((row) => row.linesJson.includes("有效处理批次 9")),
      false,
    );
    const aiJobs = getDatabase()
      .prepare(
        `
        SELECT COUNT(*) AS count FROM processing_jobs
        WHERE report_id = ? AND job_type = 'ai_extract'
      `,
      )
      .get(reportId) as { count: number };
    assert.equal(aiJobs.count, 2, "旧 OCR 批次不得补建 AI 任务");
  });
});
