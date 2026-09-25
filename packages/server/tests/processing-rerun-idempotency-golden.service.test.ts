import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { closeDatabaseForTests, getDatabase } from "../database/client.ts";
import type { RequestUser } from "../domain/request-user.ts";
import {
  getProcessingJobEventDetail,
  processNextJob,
  queueManualAiExtraction,
  reprocessReportOcrAndAi,
  type WorkerExecutor,
} from "../services/job-runner.service.ts";
import {
  normalizeAiExtraction,
  type AiExecutor,
  type AiExtractionInput,
} from "../services/ai-extraction.service.ts";
import { saveAiSettings } from "../services/ai-settings.service.ts";
import { listTrendSeries } from "../services/records.service.ts";
import { createUpload } from "../services/upload.service.ts";

const fixture = JSON.parse(
  readFileSync(
    new URL("./fixtures/p3-rerun-idempotency-golden.json", import.meta.url),
    "utf8",
  ),
) as {
  cycles: {
    manualAi: number;
    ocrAndAi: number;
  };
  expected: {
    reportType: string;
    title: string;
    observationCount: number;
    trendPointCount: number;
    ocrResultCount: number;
    reviewItemCount: number;
    forbiddenItemNameFragments: string[];
  };
};

const manager: RequestUser = {
  id: "p3-rerun-manager",
  displayName: "重跑金标管理员",
  provider: "development",
  authenticated: true,
  isGatewayAdmin: true,
};

const scalarLines = [
  {
    id: "golden_scalar_1",
    text: "空腹血糖 5.8 mmol/L 参考范围 3.9-6.1",
    itemName: "空腹血糖",
    resultText: "5.8",
    numericValue: 5.8,
    unit: "mmol/L",
    referenceLow: 3.9,
    referenceHigh: 6.1,
  },
  {
    id: "golden_scalar_2",
    text: "总胆固醇 4.6 mmol/L 参考范围 2.8-5.7",
    itemName: "总胆固醇",
    resultText: "4.6",
    numericValue: 4.6,
    unit: "mmol/L",
    referenceLow: 2.8,
    referenceHigh: 5.7,
  },
] as const;

function pngBytes() {
  return Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x25,
  ]);
}

async function withDatabase(run: () => Promise<void>) {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-p3-rerun-"));
  process.env.STORAGE_DIR = storageDir;
  try {
    const db = getDatabase();
    db.prepare(
      "INSERT INTO users (id, display_name, is_gateway_admin) VALUES (?, ?, 1)",
    ).run(manager.id, manager.displayName);
    db.prepare(
      `
      INSERT INTO health_members (id, display_name, relationship, created_by)
      VALUES ('p3-rerun-member', '匿名成员', 'self', ?)
    `,
    ).run(manager.id);
    db.prepare(
      `
      INSERT INTO member_permissions (member_id, user_id, permission, granted_by)
      VALUES ('p3-rerun-member', ?, 'manager', ?)
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
  return scalarLines
    .filter((line) => input.text.includes(line.text))
    .map((line) => ({
      sectionName: "生化检查",
      itemName: line.itemName,
      normalizedName: line.itemName,
      resultText: line.resultText,
      numericValue: line.numericValue,
      unit: line.unit,
      referenceLow: line.referenceLow,
      referenceHigh: line.referenceHigh,
      abnormalFlag: "normal" as const,
      evidence: [{ pageNumber: 1, quote: line.text }],
    }));
}

const ai: AiExecutor = async (input) => {
  const documentFields =
    input.route === "document" || input.allowDocumentFields
      ? {
          reportType: "laboratory",
          title: fixture.expected.title,
          hospitalNameRaw: "匿名示例医院",
          city: null,
          reportIssuedAt: "2026-08-06",
          summary: "匿名合成检验结果已完成结构化整理",
        }
      : {};
  const normalized = normalizeAiExtraction({
    ...documentFields,
    observations: observationsForInput(input),
  });
  return {
    provider: "golden-test-provider",
    model: "golden-test-model",
    promptVersion: "p3-rerun-golden-v1",
    ...normalized,
    rawResponseJson: JSON.stringify(normalized),
    promptTokens: 12,
    completionTokens: 10,
    elapsedMs: 8,
  };
};

const worker: WorkerExecutor = async (request) =>
  request.action === "thumbnail"
    ? { ok: true, width: 240, height: 320, elapsedMs: 4 }
    : {
        ok: true,
        engine: "golden-test-ocr",
        modelVersion: "golden-ocr-v1",
        lines: [
          {
            id: "golden_header",
            text: fixture.expected.title,
            confidence: 0.99,
            box: [0, 0, 120, 10],
          },
          {
            id: "golden_date",
            text: "报告编号：SYNTHETIC 报告日期 2026-08-06",
            confidence: 0.99,
            box: [0, 12, 120, 22],
          },
          ...scalarLines.map((line, index) => ({
            id: line.id,
            text: line.text,
            confidence: 0.99,
            box: [0, 24 + index * 12, 180, 34 + index * 12],
          })),
          {
            id: "golden_device_noise",
            text: "设备序列号 TEST-0001",
            confidence: 0.99,
            box: [0, 52, 180, 62],
          },
          {
            id: "golden_print_noise",
            text: "打印时间 2026-08-06 09:30",
            confidence: 0.99,
            box: [0, 64, 180, 74],
          },
          ...Array.from({ length: 16 }, (_, index) => ({
            id: `golden_context_${index + 1}`,
            text: "匿名检验信息完整确认",
            confidence: 0.99,
            box: [0, 76 + index * 10, 180, 84 + index * 10],
          })),
        ],
        elapsedMs: 6,
      };

async function drainJobs(maxJobs = 12) {
  let processed = 0;
  while (processed < maxJobs && (await processNextJob(worker, ai))) {
    processed += 1;
  }
  assert.ok(processed < maxJobs, "处理队列不应超过金标任务上限");
  return processed;
}

type SemanticSnapshot = ReturnType<typeof semanticSnapshot>;

function semanticSnapshot(reportId: string) {
  const db = getDatabase();
  const report = db
    .prepare(
      `
      SELECT title, report_type AS reportType, hospital_name_raw AS hospitalName,
        city, report_issued_at AS reportIssuedAt, summary, status
      FROM reports WHERE id = ?
    `,
    )
    .get(reportId) as Record<string, string | null>;
  const observations = db
    .prepare(
      `
      SELECT section_name AS sectionName, item_name AS itemName,
        normalized_name AS normalizedName, result_text AS resultText,
        numeric_value AS numericValue, unit, reference_low AS referenceLow,
        reference_high AS referenceHigh, abnormal_flag AS abnormalFlag
      FROM observations
      WHERE report_id = ?
      ORDER BY COALESCE(normalized_name, item_name), item_name, unit, numeric_value
    `,
    )
    .all(reportId);
  const trendPoints = listTrendSeries(manager, "p3-rerun-member")
    .flatMap((series) =>
      series.points.map((point) => ({
        ...point,
        unit: series.unit,
      })),
    )
    .filter((point) => point.reportId === reportId)
    .map((point) => ({
      numericValue: point.numericValue,
      resultText: point.resultText,
      unit: point.unit,
    }))
    .sort((left, right) =>
      `${left.unit}:${left.numericValue}:${left.resultText}`.localeCompare(
        `${right.unit}:${right.numericValue}:${right.resultText}`,
      ),
    );
  const ocr = db
    .prepare(
      `
      SELECT COUNT(*) AS count, MAX(lines_json) AS linesJson
      FROM ocr_results o
      JOIN report_pages p ON p.id = o.page_id
      WHERE p.report_id = ?
    `,
    )
    .get(reportId) as { count: number; linesJson: string };
  return {
    report,
    observations,
    trendPoints,
    ocr,
  };
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
  assert.ok(row, "应存在当前 AI 整理任务");
  return row.id;
}

function assertClosedAndDeduplicated(
  reportId: string,
  jobId: string,
  expected: SemanticSnapshot,
) {
  const db = getDatabase();
  const current = semanticSnapshot(reportId);
  assert.deepEqual(current, expected);
  assert.equal(current.report.reportType, fixture.expected.reportType);
  assert.equal(current.report.title, fixture.expected.title);
  assert.equal(current.observations.length, fixture.expected.observationCount);
  assert.equal(current.trendPoints.length, fixture.expected.trendPointCount);
  assert.equal(current.ocr.count, fixture.expected.ocrResultCount);

  const duplicateGroups = db
    .prepare(
      `
      SELECT COUNT(*) AS count FROM (
        SELECT COALESCE(normalized_name, item_name), COALESCE(unit, ''),
          COALESCE(CAST(numeric_value AS TEXT), result_text), COUNT(*) AS duplicates
        FROM observations
        WHERE report_id = ?
        GROUP BY COALESCE(normalized_name, item_name), COALESCE(unit, ''),
          COALESCE(CAST(numeric_value AS TEXT), result_text)
        HAVING COUNT(*) > 1
      )
    `,
    )
    .get(reportId) as { count: number };
  assert.equal(duplicateGroups.count, 0);

  const itemNames = current.observations.map((row) =>
    String((row as { itemName?: string }).itemName || ""),
  );
  for (const fragment of fixture.expected.forbiddenItemNameFragments) {
    assert.equal(
      itemNames.some((itemName) => itemName.includes(fragment)),
      false,
      `噪声字段不能被持久化为趋势指标：${fragment}`,
    );
  }

  const diagnostics = getProcessingJobEventDetail(manager, jobId).diagnostics;
  assert.equal(
    diagnostics.reviewItems.length,
    fixture.expected.reviewItemCount,
    "当前批次不应遗留未闭环诊断",
  );
}

test("keeps OCR+AI, repeated AI-only, and repeated full reruns semantically identical", async () => {
  await withDatabase(async () => {
    saveAiSettings({
      enabled: true,
      baseUrl: "https://ai.example.test/v1",
      textModel: "golden-test-model",
      apiKey: "test-secret",
    });
    const upload = createUpload(manager, "p3-rerun-member", [
      { originalName: "anonymous-golden-report.png", data: pngBytes() },
    ]);

    assert.equal(await drainJobs(), 3);
    const baseline = semanticSnapshot(upload.reportId);
    assertClosedAndDeduplicated(
      upload.reportId,
      latestAiJobId(upload.reportId),
      baseline,
    );

    const db = getDatabase();
    db.prepare(
      `
      UPDATE reports SET title = '过期生成标题', city = '过期生成城市', summary = '过期生成摘要'
      WHERE id = ?
    `,
    ).run(upload.reportId);
    db.prepare(
      `
      INSERT INTO observations (
        id, report_id, section_name, item_name, normalized_name,
        result_text, numeric_value, unit, evidence_json
      ) VALUES (
        'p3-rerun-stale-observation', ?, '设备信息', '设备序列号', '设备序列号',
        'TEST-0001', NULL, NULL, '[]'
      )
    `,
    ).run(upload.reportId);

    for (let index = 0; index < fixture.cycles.manualAi; index += 1) {
      const queued = queueManualAiExtraction(manager, upload.reportId);
      assert.equal(await drainJobs(), 1);
      assertClosedAndDeduplicated(upload.reportId, queued.id, baseline);
    }

    for (let index = 0; index < fixture.cycles.ocrAndAi; index += 1) {
      const queued = reprocessReportOcrAndAi(manager, upload.reportId);
      assert.equal(queued.queuedOcr, 1);
      assert.equal(queued.aiWillRun, true);
      assert.equal(await drainJobs(), 2);
      assertClosedAndDeduplicated(
        upload.reportId,
        latestAiJobId(upload.reportId),
        baseline,
      );
    }

    const extractionCount = db
      .prepare(
        "SELECT COUNT(*) AS count FROM report_extractions WHERE report_id = ?",
      )
      .get(upload.reportId) as { count: number };
    assert.equal(
      extractionCount.count,
      1 + fixture.cycles.manualAi + fixture.cycles.ocrAndAi,
      "每次 AI 运行只保留一份可审计提取记录，业务指标保持单份",
    );
  });
});
