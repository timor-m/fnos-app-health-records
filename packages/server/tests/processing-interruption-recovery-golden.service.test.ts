import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { closeDatabaseForTests, getDatabase } from "../database/client.ts";
import type { RequestUser } from "../domain/request-user.ts";
import {
  getProcessingJobEventDetail,
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
    new URL("./fixtures/p3-interruption-recovery-golden.json", import.meta.url),
    "utf8",
  ),
) as {
  expected: {
    pages: number;
    minimumAiUnits: number;
    observationCount: number;
    trendPointCount: number;
    duplicateGroups: number;
    reviewItemCountAfterRecovery: number;
  };
};

const manager: RequestUser = {
  id: "p3-recovery-manager",
  displayName: "异常恢复金标管理员",
  provider: "development",
  authenticated: true,
  isGatewayAdmin: true,
};

const indicators = [
  ["空腹血糖", "5.8", 5.8, "mmol/L", "3.9-6.1", 3.9, 6.1],
  ["总胆固醇", "4.6", 4.6, "mmol/L", "2.8-5.7", 2.8, 5.7],
  ["甘油三酯", "1.3", 1.3, "mmol/L", "0.3-1.7", 0.3, 1.7],
  ["高密度脂蛋白胆固醇", "1.4", 1.4, "mmol/L", "1.0-2.0", 1, 2],
  ["低密度脂蛋白胆固醇", "2.6", 2.6, "mmol/L", "0.0-3.4", 0, 3.4],
  ["白细胞计数", "5.2", 5.2, "10^9/L", "3.5-9.5", 3.5, 9.5],
  ["红细胞计数", "4.7", 4.7, "10^12/L", "3.8-5.8", 3.8, 5.8],
  ["血红蛋白", "142", 142, "g/L", "115-175", 115, 175],
  ["血小板计数", "228", 228, "10^9/L", "125-350", 125, 350],
] as const;

const pages = indicators.map((indicator, index) => {
  const [
    itemName,
    resultText,
    numericValue,
    unit,
    referenceText,
    referenceLow,
    referenceHigh,
  ] = indicator;
  return {
    pageNumber: index + 1,
    itemName,
    resultText,
    numericValue,
    unit,
    referenceLow,
    referenceHigh,
    scalarText: `${itemName} ${resultText} ${unit} 参考范围 ${referenceText}`,
  };
});

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
    0x40 + index,
  ]);
}

async function withDatabase(run: () => Promise<void>) {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-p3-recovery-"));
  process.env.STORAGE_DIR = storageDir;
  try {
    const db = getDatabase();
    db.prepare(
      "INSERT INTO users (id, display_name, is_gateway_admin) VALUES (?, ?, 1)",
    ).run(manager.id, manager.displayName);
    db.prepare(
      `
      INSERT INTO health_members (id, display_name, relationship, created_by)
      VALUES ('p3-recovery-member', '匿名成员', 'self', ?)
    `,
    ).run(manager.id);
    db.prepare(
      `
      INSERT INTO member_permissions (member_id, user_id, permission, granted_by)
      VALUES ('p3-recovery-member', ?, 'manager', ?)
    `,
    ).run(manager.id, manager.id);
    await run();
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
}

function observationsForInput(input: AiExtractionInput) {
  if (
    input.route !== "scalar" &&
    input.route !== "verification" &&
    input.route !== "document"
  ) {
    return [];
  }
  const pageNumbers = input.pageNumbers || [];
  return pages
    .filter(
      (page) =>
        pageNumbers.includes(page.pageNumber) &&
        input.text.includes(page.scalarText),
    )
    .map((page) => ({
      sectionName: page.pageNumber <= 5 ? "生化检查" : "血常规",
      itemName: page.itemName,
      normalizedName: page.itemName,
      resultText: page.resultText,
      numericValue: page.numericValue,
      unit: page.unit,
      referenceLow: page.referenceLow,
      referenceHigh: page.referenceHigh,
      abnormalFlag: "normal" as const,
      evidence: [{ pageNumber: page.pageNumber, quote: page.scalarText }],
    }));
}

function successfulAiResult(input: AiExtractionInput) {
  const documentFields =
    input.route === "document" || input.allowDocumentFields
      ? {
          reportType: "laboratory",
          title: "匿名异常恢复检验报告",
          hospitalNameRaw: "匿名示例医院",
          city: null,
          reportIssuedAt: "2026-08-06",
          summary: "匿名多页检验报告已完成结构化整理",
        }
      : {};
  const normalized = normalizeAiExtraction({
    ...documentFields,
    observations: observationsForInput(input),
  });
  return {
    provider: "recovery-test-provider",
    model: "recovery-test-model",
    promptVersion: aiExtractionPromptVersion,
    ...normalized,
    rawResponseJson: JSON.stringify(normalized),
    promptTokens: 20,
    completionTokens: 16,
    elapsedMs: 10,
  };
}

type AiController = {
  callsByUnit: Map<string, number>;
  totalCalls: number;
  failOnceAtCall: number | null;
  failAlwaysUnitKey: string | null;
};

function controlledAi(controller: AiController): AiExecutor {
  return async (input) => {
    const unitKey = input.unitKey;
    if (!unitKey) throw new Error("测试 AI 输入缺少 unitKey");
    controller.totalCalls += 1;
    controller.callsByUnit.set(
      unitKey,
      (controller.callsByUnit.get(unitKey) || 0) + 1,
    );
    if (
      controller.failOnceAtCall !== null &&
      controller.totalCalls === controller.failOnceAtCall
    ) {
      controller.failOnceAtCall = null;
      throw Object.assign(new Error("模拟 AI 单元临时中断"), {
        code: "TEST_AI_UNIT_INTERRUPTED",
      });
    }
    if (controller.failAlwaysUnitKey === input.unitKey) {
      throw Object.assign(new Error("模拟 AI 最终失败"), {
        code: "TEST_AI_FINAL_FAILURE",
      });
    }
    return successfulAiResult(input);
  };
}

type WorkerController = {
  generation: number;
  ocrCalls: number;
  failAtOcrCall: number | null;
};

function pageNumberForImagePath(
  imagePath: string,
  storagePaths: Map<string, number>,
) {
  const match = [...storagePaths.entries()].find(([storagePath]) =>
    imagePath.endsWith(storagePath),
  );
  assert.ok(match, `无法定位测试页面：${imagePath}`);
  return match[1];
}

function controlledWorker(
  controller: WorkerController,
  storagePaths: Map<string, number>,
): WorkerExecutor {
  return async (request) => {
    if (request.action === "thumbnail") {
      return { ok: true, width: 240, height: 320, elapsedMs: 4 };
    }
    controller.ocrCalls += 1;
    if (
      controller.failAtOcrCall !== null &&
      controller.ocrCalls === controller.failAtOcrCall
    ) {
      controller.failAtOcrCall = null;
      throw Object.assign(new Error("模拟单页 OCR 中断"), {
        code: "TEST_OCR_PAGE_INTERRUPTED",
      });
    }
    const pageNumber = pageNumberForImagePath(request.imagePath, storagePaths);
    const page = pages[pageNumber - 1]!;
    return {
      ok: true,
      engine: "recovery-test-ocr",
      modelVersion: `recovery-ocr-v${controller.generation}`,
      lines: [
        {
          id: `recovery_header_${pageNumber}`,
          text: `匿名异常恢复检验报告 第${pageNumber}页 报告编号：SYNTHETIC 报告日期：2026-08-06`,
          confidence: 0.99,
          box: [0, 0, 180, 10],
        },
        {
          id: `recovery_scalar_${pageNumber}`,
          text: page.scalarText,
          confidence: 0.99,
          box: [0, 12, 180, 22],
        },
        {
          id: `recovery_generation_${pageNumber}`,
          text: `离线恢复批次 ${controller.generation}`,
          confidence: 0.99,
          box: [0, 24, 180, 34],
        },
        ...Array.from({ length: 17 }, (_, index) => ({
          id: `recovery_context_${pageNumber}_${index + 1}`,
          text: "匿名检验信息完整确认",
          confidence: 0.99,
          box: [0, 36 + index * 10, 180, 44 + index * 10],
        })),
      ],
      elapsedMs: 6,
    };
  };
}

async function drainJobs(worker: WorkerExecutor, ai: AiExecutor, maxJobs = 40) {
  let processed = 0;
  while (processed < maxJobs && (await processNextJob(worker, ai))) {
    processed += 1;
  }
  assert.ok(processed < maxJobs, "处理队列不应超过异常恢复金标上限");
  return processed;
}

function semanticSnapshot(reportId: string) {
  const db = getDatabase();
  const report = db
    .prepare(
      `
      SELECT title, report_type AS reportType, hospital_name_raw AS hospitalName,
        city, report_issued_at AS reportIssuedAt, summary
      FROM reports WHERE id = ?
    `,
    )
    .get(reportId);
  const observations = db
    .prepare(
      `
      SELECT section_name AS sectionName, item_name AS itemName,
        normalized_name AS normalizedName, result_text AS resultText,
        numeric_value AS numericValue, unit, reference_low AS referenceLow,
        reference_high AS referenceHigh, abnormal_flag AS abnormalFlag
      FROM observations WHERE report_id = ?
      ORDER BY COALESCE(normalized_name, item_name), unit, numeric_value
    `,
    )
    .all(reportId);
  const trendPoints = listTrendSeries(manager, "p3-recovery-member")
    .flatMap((series) =>
      series.points.map((point) => ({
        reportId: point.reportId,
        numericValue: point.numericValue,
        resultText: point.resultText,
        unit: series.unit,
      })),
    )
    .filter((point) => point.reportId === reportId)
    .sort((left, right) =>
      `${left.unit}:${left.numericValue}:${left.resultText}`.localeCompare(
        `${right.unit}:${right.numericValue}:${right.resultText}`,
      ),
    );
  return { report, observations, trendPoints };
}

function observationIds(reportId: string) {
  return (
    getDatabase()
      .prepare("SELECT id FROM observations WHERE report_id = ? ORDER BY id")
      .all(reportId) as Array<{ id: string }>
  ).map((row) => row.id);
}

function latestAiJobId(reportId: string) {
  const row = getDatabase()
    .prepare(
      `
      SELECT id FROM processing_jobs
      WHERE report_id = ? AND job_type = 'ai_extract'
      ORDER BY rowid DESC LIMIT 1
    `,
    )
    .get(reportId) as { id: string } | undefined;
  assert.ok(row);
  return row.id;
}

function assertBusinessResult(
  reportId: string,
  expected: ReturnType<typeof semanticSnapshot>,
  jobId?: string,
) {
  const db = getDatabase();
  const current = semanticSnapshot(reportId);
  assert.deepEqual(current, expected);
  assert.equal(current.observations.length, fixture.expected.observationCount);
  assert.equal(current.trendPoints.length, fixture.expected.trendPointCount);
  const duplicateGroups = db
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
  assert.equal(duplicateGroups.count, fixture.expected.duplicateGroups);
  if (jobId) {
    assert.equal(
      getProcessingJobEventDetail(manager, jobId).diagnostics.reviewItems
        .length,
      fixture.expected.reviewItemCountAfterRecovery,
    );
  }
}

function forceQueuedJobsReady(reportId: string, jobType?: string) {
  getDatabase()
    .prepare(
      `
      UPDATE processing_jobs SET next_retry_at = CURRENT_TIMESTAMP
      WHERE report_id = ? AND status = 'queued'
        AND (? IS NULL OR job_type = ?)
    `,
    )
    .run(reportId, jobType || null, jobType || null);
}

test("preserves old results through AI unit interruption, lease recovery, OCR interruption, and final AI failure", async () => {
  await withDatabase(async () => {
    saveAiSettings({
      enabled: true,
      baseUrl: "https://ai.example.test/v1",
      textModel: "recovery-test-model",
      apiKey: "test-secret",
    });
    const upload = createUpload(
      manager,
      "p3-recovery-member",
      pages.map((page) => ({
        originalName: `anonymous-recovery-${page.pageNumber}.png`,
        data: pngBytes(page.pageNumber),
      })),
    );
    const db = getDatabase();
    const storagePaths = new Map(
      (
        db
          .prepare(
            `
            SELECT storage_path AS storagePath, page_number AS pageNumber
            FROM report_pages WHERE report_id = ?
          `,
          )
          .all(upload.reportId) as Array<{
          storagePath: string;
          pageNumber: number;
        }>
      ).map((row) => [row.storagePath, row.pageNumber]),
    );
    const workerController: WorkerController = {
      generation: 1,
      ocrCalls: 0,
      failAtOcrCall: null,
    };
    const worker = controlledWorker(workerController, storagePaths);
    const initialAiController: AiController = {
      callsByUnit: new Map(),
      totalCalls: 0,
      failOnceAtCall: null,
      failAlwaysUnitKey: null,
    };
    assert.equal(
      await drainJobs(worker, controlledAi(initialAiController)),
      fixture.expected.pages * 2 + 1,
    );
    assert.ok(
      initialAiController.callsByUnit.size >= fixture.expected.minimumAiUnits,
    );
    const baseline = semanticSnapshot(upload.reportId);
    assertBusinessResult(
      upload.reportId,
      baseline,
      latestAiJobId(upload.reportId),
    );

    const aiOnly = queueManualAiExtraction(manager, upload.reportId);
    const idsBeforeAiInterruption = observationIds(upload.reportId);
    const interruptedAiController: AiController = {
      callsByUnit: new Map(),
      totalCalls: 0,
      failOnceAtCall: 2,
      failAlwaysUnitKey: null,
    };
    const interruptedAi = controlledAi(interruptedAiController);
    await assert.rejects(
      () => processNextJob(worker, interruptedAi),
      /模拟 AI 单元临时中断/,
    );
    assert.deepEqual(observationIds(upload.reportId), idsBeforeAiInterruption);
    assert.deepEqual(semanticSnapshot(upload.reportId), baseline);
    const completedUnits = db
      .prepare(
        `
        SELECT unit_key AS unitKey FROM ai_extraction_units
        WHERE job_id = ? AND status IN ('completed', 'warning')
      `,
      )
      .all(aiOnly.id) as Array<{ unitKey: string }>;
    assert.ok(completedUnits.length >= 1);
    const callsBeforeLeaseRecovery = new Map(
      interruptedAiController.callsByUnit,
    );
    db.prepare(
      `
      UPDATE processing_jobs SET status = 'processing', lease_expires_at = datetime('now', '-1 minute')
      WHERE id = ?
    `,
    ).run(aiOnly.id);
    assert.equal(await processNextJob(worker, interruptedAi), true);
    for (const unit of completedUnits) {
      assert.equal(
        interruptedAiController.callsByUnit.get(unit.unitKey),
        callsBeforeLeaseRecovery.get(unit.unitKey),
        "租约恢复后不能重复调用已完成 AI 单元",
      );
    }
    assert.equal(
      listProcessingJobEvents(manager, aiOnly.id).some((event) =>
        JSON.stringify(event.detail).includes("lease_recovery"),
      ),
      true,
    );
    assertBusinessResult(upload.reportId, baseline, aiOnly.id);

    const idsBeforeOcrInterruption = observationIds(upload.reportId);
    const ocrBatch = reprocessReportOcrAndAi(manager, upload.reportId);
    assert.equal(ocrBatch.queuedOcr, fixture.expected.pages);
    workerController.ocrCalls = 0;
    workerController.failAtOcrCall = 3;
    assert.equal(
      await processNextJob(worker, controlledAi(initialAiController)),
      true,
    );
    assert.equal(
      await processNextJob(worker, controlledAi(initialAiController)),
      true,
    );
    await assert.rejects(
      () => processNextJob(worker, controlledAi(initialAiController)),
      /模拟单页 OCR 中断/,
    );
    assert.deepEqual(observationIds(upload.reportId), idsBeforeOcrInterruption);
    assert.deepEqual(semanticSnapshot(upload.reportId), baseline);
    assert.equal(
      await drainJobs(worker, controlledAi(initialAiController)),
      fixture.expected.pages - 3,
    );
    assert.equal(
      (
        db
          .prepare(
            `
            SELECT COUNT(*) AS count FROM processing_jobs
            WHERE report_id = ? AND pipeline_version = 'manual-reprocess-v1'
              AND job_type = 'ai_extract' AND status IN ('queued', 'processing')
          `,
          )
          .get(upload.reportId) as { count: number }
      ).count,
      0,
    );
    forceQueuedJobsReady(upload.reportId, "ocr");
    assert.equal(
      await processNextJob(worker, controlledAi(initialAiController)),
      true,
    );
    assert.deepEqual(observationIds(upload.reportId), idsBeforeOcrInterruption);
    assert.equal(
      await processNextJob(worker, controlledAi(initialAiController)),
      true,
    );
    assertBusinessResult(
      upload.reportId,
      baseline,
      latestAiJobId(upload.reportId),
    );

    const idsBeforeFinalAiFailure = observationIds(upload.reportId);
    workerController.generation = 2;
    workerController.ocrCalls = 0;
    workerController.failAtOcrCall = null;
    const finalFailureBatch = reprocessReportOcrAndAi(manager, upload.reportId);
    assert.equal(finalFailureBatch.queuedOcr, fixture.expected.pages);
    for (let index = 0; index < fixture.expected.pages; index += 1) {
      assert.equal(
        await processNextJob(worker, controlledAi(initialAiController)),
        true,
      );
    }
    const finalFailureJobId = latestAiJobId(upload.reportId);
    const failController: AiController = {
      callsByUnit: new Map(),
      totalCalls: 0,
      failOnceAtCall: null,
      failAlwaysUnitKey: null,
    };
    const failAi = controlledAi(failController);
    await assert.rejects(async () => {
      failController.failAlwaysUnitKey = null;
      const firstCall = failController.totalCalls;
      const original = failController.failOnceAtCall;
      failController.failOnceAtCall = firstCall + 2;
      try {
        await processNextJob(worker, failAi);
      } finally {
        failController.failOnceAtCall = original;
      }
    }, /模拟 AI 单元临时中断/);
    const failedUnit = db
      .prepare(
        `
        SELECT unit_key AS unitKey FROM ai_extraction_units
        WHERE job_id = ? AND status = 'failed' LIMIT 1
      `,
      )
      .get(finalFailureJobId) as { unitKey: string };
    failController.failAlwaysUnitKey = failedUnit.unitKey;
    for (let attempt = 2; attempt <= 3; attempt += 1) {
      forceQueuedJobsReady(upload.reportId, "ai_extract");
      await assert.rejects(
        () => processNextJob(worker, failAi),
        /模拟 AI 最终失败/,
      );
    }
    const failedJob = db
      .prepare("SELECT status, attempts FROM processing_jobs WHERE id = ?")
      .get(finalFailureJobId) as { status: string; attempts: number };
    assert.equal(failedJob.status, "failed");
    assert.equal(failedJob.attempts, 3);
    assert.deepEqual(observationIds(upload.reportId), idsBeforeFinalAiFailure);
    assert.deepEqual(semanticSnapshot(upload.reportId), baseline);
    const latestOcr = db
      .prepare(
        `
        SELECT COUNT(*) AS count FROM ocr_results o
        JOIN report_pages p ON p.id = o.page_id
        WHERE p.report_id = ? AND o.lines_json LIKE '%离线恢复批次 2%'
      `,
      )
      .get(upload.reportId) as { count: number };
    assert.equal(latestOcr.count, fixture.expected.pages);

    const completedBeforeManualRetry = db
      .prepare(
        `
        SELECT unit_key AS unitKey FROM ai_extraction_units
        WHERE job_id = ? AND status IN ('completed', 'warning')
      `,
      )
      .all(finalFailureJobId) as Array<{ unitKey: string }>;
    const callsBeforeManualRetry = new Map(failController.callsByUnit);
    retryProcessingJob(manager, finalFailureJobId);
    failController.failAlwaysUnitKey = null;
    assert.equal(await processNextJob(worker, failAi), true);
    for (const unit of completedBeforeManualRetry) {
      assert.equal(
        failController.callsByUnit.get(unit.unitKey),
        callsBeforeManualRetry.get(unit.unitKey),
        "人工恢复后不能重复调用已完成 AI 单元",
      );
    }
    assertBusinessResult(upload.reportId, baseline, finalFailureJobId);
  });
});
