import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { closeDatabaseForTests, getDatabase } from "../database/client.ts";
import { schemaVersion } from "../database/schema.ts";
import type { RequestUser } from "../domain/request-user.ts";
import {
  getProcessingJobEventDetail,
  listProcessingJobEvents,
  processNextJob,
  claimNextJob,
  queueManualAiExtraction,
  type WorkerExecutor,
} from "../services/job-runner.service.ts";
import {
  aiExtractionPromptVersion,
  normalizeAiExtraction,
  type AiExecutor,
  type AiExtractionInput,
} from "../services/ai-extraction.service.ts";
import { saveAiSettings } from "../services/ai-settings.service.ts";
import { executeAiExtractionPlan } from "../services/ai-extraction-orchestrator.service.ts";
import { listTrendSeries } from "../services/records.service.ts";
import { createUpload } from "../services/upload.service.ts";

const fixture = JSON.parse(
  readFileSync(
    new URL("./fixtures/p3-process-restart-recovery-golden.json", import.meta.url),
    "utf8",
  ),
) as {
  expected: {
    pages: number;
    minimumPersistedAiUnits: number;
    observationCount: number;
    trendPointCount: number;
    duplicateGroups: number;
    persistedRecoveryAiCalls: number;
    persistedRecoveryEvents: number;
    activeJobsAfterRecovery: number;
    settledReportStatus: string;
    reviewItemCountAfterRecovery: number;
  };
};

const manager: RequestUser = {
  id: "p3-restart-manager",
  displayName: "进程重启金标管理员",
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
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-p3-restart-"));
  process.env.STORAGE_DIR = storageDir;
  try {
    const db = getDatabase();
    db.prepare(
      "INSERT INTO users (id, display_name, is_gateway_admin) VALUES (?, ?, 1)",
    ).run(manager.id, manager.displayName);
    db.prepare(
      `
      INSERT INTO health_members (id, display_name, relationship, created_by)
      VALUES ('p3-restart-member', '匿名成员', 'self', ?)
    `,
    ).run(manager.id);
    db.prepare(
      `
      INSERT INTO member_permissions (member_id, user_id, permission, granted_by)
      VALUES ('p3-restart-member', ?, 'manager', ?)
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
          title: "匿名进程重启检验报告",
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
    provider: "restart-test-provider",
    model: "restart-test-model",
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
      engine: "restart-test-ocr",
      modelVersion: `restart-ocr-v${controller.generation}`,
      lines: [
        {
          id: `restart_header_${pageNumber}`,
          text: `匿名进程重启检验报告 第${pageNumber}页`,
          confidence: 0.99,
          box: [0, 0, 180, 10],
        },
        {
          id: `restart_scalar_${pageNumber}`,
          text: page.scalarText,
          confidence: 0.99,
          box: [0, 12, 180, 22],
        },
        {
          id: `restart_generation_${pageNumber}`,
          text: `离线重启批次 ${controller.generation}`,
          confidence: 0.99,
          box: [0, 24, 180, 34],
        },
        ...Array.from({ length: 17 }, (_, index) => ({
          id: `restart_context_${pageNumber}_${index + 1}`,
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
  assert.ok(processed < maxJobs, "处理队列不应超过进程重启金标上限");
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
  const trendPoints = listTrendSeries(manager, "p3-restart-member")
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


function expireProcessingJob(jobId: string) {
  getDatabase()
    .prepare(
      `
      UPDATE processing_jobs SET status = 'processing',
        lease_expires_at = datetime('now', '-1 minute'),
        locked_at = datetime('now', '-10 minutes'), finished_at = NULL
      WHERE id = ?
    `,
    )
    .run(jobId);
}

function reopenDatabase() {
  closeDatabaseForTests();
  return getDatabase();
}

function duplicateObservationGroups(reportId: string) {
  return (
    getDatabase()
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
      .get(reportId) as { count: number }
  ).count;
}

test("recovers OCR, AI units, persisted extraction, and orphaned report state across process restarts", async () => {
  const previousConcurrency = process.env.AI_EXTRACTION_CONCURRENCY;
  process.env.AI_EXTRACTION_CONCURRENCY = "1";
  try {
    await withDatabase(async () => {
      saveAiSettings({
        enabled: true,
        baseUrl: "https://ai.example.test/v1",
        textModel: "restart-test-model",
        apiKey: "test-secret",
      });
      const upload = createUpload(
        manager,
        "p3-restart-member",
        pages.map((page) => ({
          originalName: `anonymous-restart-${page.pageNumber}.png`,
          data: pngBytes(page.pageNumber),
        })),
      );
      const storagePaths = new Map(
        (
          getDatabase()
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
      const initialAi = controlledAi(initialAiController);

      // Thumbnail jobs remain queued on disk while the first OCR job is claimed.
      for (let index = 0; index < fixture.expected.pages; index += 1) {
        assert.equal(await processNextJob(worker, initialAi), true);
      }
      const claimedOcr = claimNextJob();
      assert.ok(claimedOcr);
      assert.equal(claimedOcr.jobType, "ocr");
      expireProcessingJob(claimedOcr.id);
      reopenDatabase();

      assert.equal(await processNextJob(worker, initialAi), true);
      assert.equal(
        await drainJobs(worker, initialAi),
        fixture.expected.pages,
        "重启后应继续处理剩余 OCR 并只创建一次自动 AI 任务",
      );
      assert.equal(workerController.ocrCalls, fixture.expected.pages);
      assert.equal(
        listProcessingJobEvents(manager, claimedOcr.id).filter((event) =>
          JSON.stringify(event.detail).includes("lease_recovery"),
        ).length,
        1,
      );
      const baseline = semanticSnapshot(upload.reportId);
      assert.equal(baseline.observations.length, fixture.expected.observationCount);
      assert.equal(baseline.trendPoints.length, fixture.expected.trendPointCount);
      assert.equal(
        duplicateObservationGroups(upload.reportId),
        fixture.expected.duplicateGroups,
      );

      // Simulate a hard process exit after one AI unit has been committed, without
      // letting processNextJob convert the still-running job into a normal retry.
      const restartedAiJob = queueManualAiExtraction(manager, upload.reportId);
      const claimedAi = claimNextJob();
      assert.ok(claimedAi);
      assert.equal(claimedAi.id, restartedAiJob.id);
      assert.equal(claimedAi.jobType, "ai_extract");
      const interruptedAiController: AiController = {
        callsByUnit: new Map(),
        totalCalls: 0,
        failOnceAtCall: 2,
        failAlwaysUnitKey: null,
      };
      await assert.rejects(
        () =>
          executeAiExtractionPlan(
            restartedAiJob.id,
            upload.reportId,
            controlledAi(interruptedAiController),
          ),
        /模拟 AI 单元临时中断/,
      );
      const completedBeforeRestart = getDatabase()
        .prepare(
          `
          SELECT unit_key AS unitKey FROM ai_extraction_units
          WHERE job_id = ? AND status = 'completed'
          ORDER BY unit_index, id
        `,
        )
        .all(restartedAiJob.id) as Array<{ unitKey: string }>;
      assert.ok(
        completedBeforeRestart.length >= fixture.expected.minimumPersistedAiUnits,
      );
      const callsBeforeRestart = new Map(interruptedAiController.callsByUnit);
      expireProcessingJob(restartedAiJob.id);
      reopenDatabase();

      assert.equal(
        await processNextJob(worker, controlledAi(interruptedAiController)),
        true,
      );
      for (const unit of completedBeforeRestart) {
        assert.equal(
          interruptedAiController.callsByUnit.get(unit.unitKey),
          callsBeforeRestart.get(unit.unitKey),
          "进程重启后不能重复调用已经持久化完成的 AI 单元",
        );
      }
      assert.deepEqual(semanticSnapshot(upload.reportId), baseline);
      assert.equal(
        duplicateObservationGroups(upload.reportId),
        fixture.expected.duplicateGroups,
      );

      // Simulate a crash after report_extractions/observations committed but before
      // the processing job and report status were finalized.
      const idsBeforePersistedRecovery = observationIds(upload.reportId);
      expireProcessingJob(restartedAiJob.id);
      getDatabase()
        .prepare("UPDATE reports SET status = 'processing' WHERE id = ?")
        .run(upload.reportId);
      reopenDatabase();
      let unexpectedAiCalls = 0;
      const neverAi: AiExecutor = async () => {
        unexpectedAiCalls += 1;
        throw new Error("持久化恢复阶段不应再次调用 AI");
      };
      assert.equal(await processNextJob(worker, neverAi), true);
      assert.equal(unexpectedAiCalls, fixture.expected.persistedRecoveryAiCalls);
      assert.deepEqual(observationIds(upload.reportId), idsBeforePersistedRecovery);
      assert.deepEqual(semanticSnapshot(upload.reportId), baseline);
      assert.equal(
        listProcessingJobEvents(manager, restartedAiJob.id).filter((event) =>
          JSON.stringify(event.detail).includes(
            '"resumedFromPersistedExtraction":true',
          ),
        ).length,
        fixture.expected.persistedRecoveryEvents,
      );

      // Simulate a crash after the job is complete but before report reconciliation.
      getDatabase()
        .prepare("UPDATE reports SET status = 'processing' WHERE id = ?")
        .run(upload.reportId);
      reopenDatabase();
      assert.equal(claimNextJob(), null);
      const settled = getDatabase()
        .prepare("SELECT status FROM reports WHERE id = ?")
        .get(upload.reportId) as { status: string };
      assert.equal(settled.status, fixture.expected.settledReportStatus);

      const activeJobs = getDatabase()
        .prepare(
          `
          SELECT COUNT(*) AS count FROM processing_jobs
          WHERE report_id = ? AND status IN ('queued', 'processing')
        `,
        )
        .get(upload.reportId) as { count: number };
      assert.equal(activeJobs.count, fixture.expected.activeJobsAfterRecovery);
      assert.equal(
        duplicateObservationGroups(upload.reportId),
        fixture.expected.duplicateGroups,
      );
      assert.equal(
        getProcessingJobEventDetail(manager, restartedAiJob.id).diagnostics
          .reviewItems.length,
        fixture.expected.reviewItemCountAfterRecovery,
      );
      const schema = getDatabase()
        .prepare("SELECT MAX(version) AS version FROM schema_migrations")
        .get() as { version: number };
      assert.equal(schema.version, schemaVersion);
    });
  } finally {
    if (previousConcurrency === undefined) {
      delete process.env.AI_EXTRACTION_CONCURRENCY;
    } else {
      process.env.AI_EXTRACTION_CONCURRENCY = previousConcurrency;
    }
  }
});
