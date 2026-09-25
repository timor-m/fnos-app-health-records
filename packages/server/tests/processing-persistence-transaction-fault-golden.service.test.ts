import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Worker } from "node:worker_threads";
import {
  closeDatabaseForTests,
  getDatabase,
  getDatabasePath,
} from "../database/client.ts";
import type { RequestUser } from "../domain/request-user.ts";
import {
  processNextJob,
  queueManualAiExtraction,
  reprocessReportOcrAndAi,
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
      "./fixtures/p3-persistence-transaction-fault-golden.json",
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
    failedExtractionCount: number;
    retryAttempts: number;
    lockHoldMilliseconds: number;
  };
};

const manager: RequestUser = {
  id: "p3-persistence-manager",
  displayName: "事务故障金标管理员",
  provider: "development",
  authenticated: true,
  isGatewayAdmin: true,
};

const memberId = "p3-persistence-member";
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
  return {
    pageNumber,
    itemName,
    unit,
    referenceLow,
    referenceHigh,
    numericValue,
    resultText,
    scalarText: `${itemName} ${resultText} ${unit} 参考范围 ${referenceLow}-${referenceHigh}`,
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
    0x60 + index,
  ]);
}

async function withDatabase(run: () => Promise<void>) {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-p3-tx-fault-"));
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
      VALUES (?, '匿名成员', 'self', ?)
    `,
    ).run(memberId, manager.id);
    db.prepare(
      `
      INSERT INTO member_permissions (member_id, user_id, permission, granted_by)
      VALUES (?, ?, 'manager', ?)
    `,
    ).run(memberId, manager.id, manager.id);
    await run();
  } finally {
    closeDatabaseForTests();
    if (previousConcurrency === undefined) {
      delete process.env.AI_EXTRACTION_CONCURRENCY;
    } else {
      process.env.AI_EXTRACTION_CONCURRENCY = previousConcurrency;
    }
    delete process.env.STORAGE_DIR;
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
      engine: "persistence-golden-ocr",
      modelVersion: `persistence-ocr-v${generation}`,
      lines: [
        {
          id: `persistence_header_${generation}_${pageNumber}`,
          text: `匿名事务报告 第${pageNumber}页 报告编号：SYNTHETIC 报告日期：2026-08-06`,
          confidence: 0.99,
          box: [0, 0, 180, 10],
        },
        {
          id: `persistence_scalar_${generation}_${pageNumber}`,
          text: page.scalarText,
          confidence: 0.99,
          box: [0, 12, 180, 22],
        },
        {
          id: `persistence_generation_${generation}_${pageNumber}`,
          text: `有效处理批次 ${generation}`,
          confidence: 0.99,
          box: [0, 24, 180, 34],
        },
        ...Array.from({ length: 12 }, (_, index) => ({
          id: `persistence_context_${generation}_${pageNumber}_${index + 1}`,
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

function aiResult(input: AiExtractionInput, documentGeneration?: number) {
  const dataGeneration = generationForInput(input);
  const titleGeneration = documentGeneration ?? dataGeneration;
  const pageNumbers = input.pageNumbers || [];
  const observations = indicatorDefinitions.flatMap((_, index) => {
    const page = pageData(index + 1, dataGeneration);
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
          title: `匿名事务报告 ${titleGeneration}`,
          hospitalNameRaw: "匿名示例医院",
          reportIssuedAt: "2026-08-06",
          summary: `匿名事务批次 ${titleGeneration} 已完成`,
        }
      : {};
  const normalized = normalizeAiExtraction({
    ...documentFields,
    observations,
  });
  return {
    provider: "persistence-golden-provider",
    model: "persistence-golden-model",
    promptVersion: aiExtractionPromptVersion,
    ...normalized,
    rawResponseJson: JSON.stringify(normalized),
    promptTokens: 18,
    completionTokens: 14,
    elapsedMs: 8,
  };
}

type AiController = {
  totalCalls: number;
  callsByUnit: Map<string, number>;
};

function controlledAi(
  controller: AiController,
  documentGeneration?: number,
): AiExecutor {
  return async (input) => {
    controller.totalCalls += 1;
    const unitKey = input.unitKey || "unknown";
    controller.callsByUnit.set(
      unitKey,
      (controller.callsByUnit.get(unitKey) || 0) + 1,
    );
    return aiResult(input, documentGeneration);
  };
}

async function drainJobs(
  worker: WorkerExecutor,
  ai: AiExecutor = async (input) => aiResult(input),
  maximum = 30,
) {
  let count = 0;
  while (count < maximum && (await processNextJob(worker, ai))) count += 1;
  assert.ok(count < maximum, "事务故障金标任务不应无限循环");
  return count;
}

function retryNow(jobId: string) {
  getDatabase()
    .prepare(
      "UPDATE processing_jobs SET next_retry_at = CURRENT_TIMESTAMP WHERE id = ?",
    )
    .run(jobId);
}

function jobState(jobId: string) {
  return getDatabase()
    .prepare(
      `
      SELECT status, attempts, error_code AS errorCode, error_message AS errorMessage
      FROM processing_jobs WHERE id = ?
    `,
    )
    .get(jobId) as {
    status: string;
    attempts: number;
    errorCode: string | null;
    errorMessage: string | null;
  };
}

function contentSnapshot(reportId: string) {
  const db = getDatabase();
  const report = db
    .prepare(
      `
      SELECT report_type AS reportType, title, hospital_name_raw AS hospitalNameRaw,
        report_issued_at AS reportIssuedAt, summary
      FROM reports WHERE id = ?
    `,
    )
    .get(reportId);
  const observations = db
    .prepare(
      `
      SELECT id, COALESCE(normalized_name, item_name) AS itemName,
        numeric_value AS numericValue, result_text AS resultText, unit,
        reference_low AS referenceLow, reference_high AS referenceHigh,
        evidence_json AS evidenceJson
      FROM observations WHERE report_id = ? ORDER BY id
    `,
    )
    .all(reportId);
  const trends = listTrendSeries(manager, memberId)
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
  return { report, observations, trends };
}

function ocrSnapshot(reportId: string) {
  return getDatabase()
    .prepare(
      `
      SELECT p.page_number AS pageNumber, o.id, o.job_id AS jobId,
        o.engine, o.model_version AS modelVersion, o.lines_json AS linesJson
      FROM ocr_results o JOIN report_pages p ON p.id = o.page_id
      WHERE p.report_id = ? ORDER BY p.page_number
    `,
    )
    .all(reportId);
}

function assertCleanResult(reportId: string, dataGeneration: number) {
  const current = contentSnapshot(reportId);
  assert.equal(current.observations.length, fixture.expected.observationCount);
  assert.equal(current.trends.length, fixture.expected.trendPointCount);
  const expectedValues = indicatorDefinitions
    .map((_, index) => pageData(index + 1, dataGeneration).numericValue)
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
  const duplicates = getDatabase()
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

function extractionCount(jobId: string) {
  return (
    getDatabase()
      .prepare(
        "SELECT COUNT(*) AS count FROM report_extractions WHERE job_id = ?",
      )
      .get(jobId) as { count: number }
  ).count;
}

async function createReadyReport() {
  const upload = createUpload(
    manager,
    memberId,
    Array.from({ length: fixture.expected.pages }, (_, index) => ({
      originalName: `anonymous-persistence-${index + 1}.png`,
      data: pngBytes(index + 1),
    })),
  );
  const paths = storagePageNumbers(upload.reportId);
  await drainJobs(workerForGeneration(1, paths));
  assertCleanResult(upload.reportId, 1);
  return { reportId: upload.reportId, paths };
}

async function lockDatabaseFor(milliseconds: number) {
  const worker = new Worker(
    `
      const { parentPort, workerData } = require("node:worker_threads");
      const { DatabaseSync } = require("node:sqlite");
      const db = new DatabaseSync(workerData.path);
      db.exec("PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE");
      parentPort.postMessage("locked");
      setTimeout(() => {
        db.exec("COMMIT");
        db.close();
        parentPort.postMessage("released");
      }, workerData.milliseconds);
    `,
    {
      eval: true,
      workerData: { path: getDatabasePath(), milliseconds },
    },
  );
  const [message] = (await once(worker, "message")) as [string];
  assert.equal(message, "locked");
  return worker;
}

test("rolls back OCR and AI persistence failures, reuses completed AI units, and survives a short SQLite write lock", async () => {
  await withDatabase(async () => {
    saveAiSettings({
      enabled: true,
      baseUrl: "https://ai.example.test/v1",
      textModel: "persistence-golden-model",
      apiKey: "test-secret",
    });
    const { reportId, paths } = await createReadyReport();

    const generationOneContent = contentSnapshot(reportId);
    const generationOneOcr = ocrSnapshot(reportId);
    const reprocess = reprocessReportOcrAndAi(manager, reportId);
    assert.equal(reprocess.queuedOcr, fixture.expected.pages);
    const firstOcrJob = getDatabase()
      .prepare(
        `
        SELECT job.id
        FROM processing_jobs job
        JOIN report_pages page ON page.id = job.page_id
        WHERE job.report_id = ? AND job.job_type = 'ocr' AND job.status = 'queued'
        ORDER BY page.page_number, job.created_at, job.id LIMIT 1
      `,
      )
      .get(reportId) as { id: string };
    getDatabase().exec(`
      CREATE TEMP TRIGGER fail_ocr_insert
      BEFORE INSERT ON ocr_results
      WHEN NEW.job_id = '${firstOcrJob.id}'
      BEGIN
        SELECT RAISE(ABORT, 'TEST_OCR_TX_FAILURE');
      END;
    `);
    await assert.rejects(
      processNextJob(workerForGeneration(2, paths)),
      /TEST_OCR_TX_FAILURE/,
    );
    assert.deepEqual(contentSnapshot(reportId), generationOneContent);
    assert.deepEqual(ocrSnapshot(reportId), generationOneOcr);
    assert.deepEqual({ ...jobState(firstOcrJob.id) }, {
      status: "queued",
      attempts: 1,
      errorCode: "ERR_SQLITE_ERROR",
      errorMessage: "TEST_OCR_TX_FAILURE",
    });

    getDatabase().exec("DROP TRIGGER fail_ocr_insert");
    retryNow(firstOcrJob.id);
    assert.equal(await processNextJob(workerForGeneration(2, paths)), true);
    assert.equal(jobState(firstOcrJob.id).status, "completed");
    await drainJobs(workerForGeneration(2, paths));
    assertCleanResult(reportId, 2);
    assert.equal(
      ocrSnapshot(reportId).every((row) =>
        (row as { linesJson: string }).linesJson.includes("有效处理批次 2"),
      ),
      true,
    );

    const generationTwoContent = contentSnapshot(reportId);
    const observationFaultJob = queueManualAiExtraction(manager, reportId);
    const observationController: AiController = {
      totalCalls: 0,
      callsByUnit: new Map(),
    };
    getDatabase().exec(`
      CREATE TEMP TRIGGER fail_observation_insert
      BEFORE INSERT ON observations
      BEGIN
        SELECT RAISE(ABORT, 'TEST_AI_OBSERVATION_TX_FAILURE');
      END;
    `);
    await assert.rejects(
      processNextJob(
        workerForGeneration(2, paths),
        controlledAi(observationController, 3),
      ),
      /TEST_AI_OBSERVATION_TX_FAILURE/,
    );
    const callsAfterObservationFailure = observationController.totalCalls;
    assert.ok(callsAfterObservationFailure > 0);
    assert.deepEqual(contentSnapshot(reportId), generationTwoContent);
    assert.equal(
      extractionCount(observationFaultJob.id),
      fixture.expected.failedExtractionCount,
    );
    assert.equal(jobState(observationFaultJob.id).status, "queued");

    getDatabase().exec("DROP TRIGGER fail_observation_insert");
    retryNow(observationFaultJob.id);
    assert.equal(
      await processNextJob(
        workerForGeneration(2, paths),
        controlledAi(observationController, 3),
      ),
      true,
    );
    assert.equal(
      observationController.totalCalls,
      callsAfterObservationFailure,
      "事务失败重试必须复用已完成 AI 单元，不得重复调用 AI",
    );
    assert.equal(extractionCount(observationFaultJob.id), 1);
    assert.equal(jobState(observationFaultJob.id).attempts, fixture.expected.retryAttempts);
    assert.equal(
      (contentSnapshot(reportId).report as { title: string }).title,
      "匿名事务报告 3",
    );
    assertCleanResult(reportId, 2);

    const generationThreeContent = contentSnapshot(reportId);
    const extractionFaultJob = queueManualAiExtraction(manager, reportId);
    const extractionController: AiController = {
      totalCalls: 0,
      callsByUnit: new Map(),
    };
    getDatabase().exec(`
      CREATE TEMP TRIGGER fail_extraction_insert
      BEFORE INSERT ON report_extractions
      WHEN NEW.job_id = '${extractionFaultJob.id}'
      BEGIN
        SELECT RAISE(ABORT, 'TEST_AI_EXTRACTION_TX_FAILURE');
      END;
    `);
    await assert.rejects(
      processNextJob(
        workerForGeneration(2, paths),
        controlledAi(extractionController, 4),
      ),
      /TEST_AI_EXTRACTION_TX_FAILURE/,
    );
    const callsAfterExtractionFailure = extractionController.totalCalls;
    assert.ok(callsAfterExtractionFailure > 0);
    assert.deepEqual(contentSnapshot(reportId), generationThreeContent);
    assert.equal(
      extractionCount(extractionFaultJob.id),
      fixture.expected.failedExtractionCount,
    );

    getDatabase().exec("DROP TRIGGER fail_extraction_insert");
    retryNow(extractionFaultJob.id);
    assert.equal(
      await processNextJob(
        workerForGeneration(2, paths),
        controlledAi(extractionController, 4),
      ),
      true,
    );
    assert.equal(extractionController.totalCalls, callsAfterExtractionFailure);
    assert.equal(extractionCount(extractionFaultJob.id), 1);
    assert.equal(
      (contentSnapshot(reportId).report as { title: string }).title,
      "匿名事务报告 4",
    );
    assertCleanResult(reportId, 2);

    const lockJob = queueManualAiExtraction(manager, reportId);
    const lockController: AiController = { totalCalls: 0, callsByUnit: new Map() };
    const locker = await lockDatabaseFor(fixture.expected.lockHoldMilliseconds);
    const released = once(locker, "message");
    assert.equal(
      await processNextJob(
        workerForGeneration(2, paths),
        controlledAi(lockController, 5),
      ),
      true,
    );
    const [releasedMessage] = (await released) as [string];
    assert.equal(releasedMessage, "released");
    await once(locker, "exit");
    assert.equal(jobState(lockJob.id).status, "completed");
    assert.equal(extractionCount(lockJob.id), 1);
    assert.ok(lockController.totalCalls > 0);
    assert.equal(
      (contentSnapshot(reportId).report as { title: string }).title,
      "匿名事务报告 5",
    );
    assertCleanResult(reportId, 2);
  });
});
