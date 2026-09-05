import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { closeDatabaseForTests, getDatabase } from "../database/client.ts";
import {
  aiExtractionExecutionPolicy,
  executeAiExtractionPlan,
  mergeAiExtractionResults
} from "../services/ai-extraction-orchestrator.service.ts";
import { buildAiExtractionPlan } from "../services/ai-input-planner.service.ts";
import { buildProcessingJobDiagnostics } from "../services/processing-job-diagnostics.service.ts";
import {
  deduplicateReportMorphologyFindings,
  deduplicateReportObservations,
  normalizeAiExtraction,
  persistAiExtraction,
  sanitizeReportObservations,
  aiExtractionPromptVersion,
  type AiExecutor,
  type AiExtractionResult,
  type AiMorphologyFinding
} from "../services/ai-extraction.service.ts";

const ultrasoundMorphologyGolden = JSON.parse(readFileSync(
  new URL(
    "./fixtures/p3-ultrasound-summary-detail-morphology-golden.json",
    import.meta.url
  ),
  "utf8"
)) as {
  source: { findings: AiMorphologyFinding[] };
  expected: {
    findingCount: number;
    findings: Array<{
      findingType: string;
      findingName: string;
      organ: string;
      region?: string;
      laterality: AiMorphologyFinding["laterality"];
      size?: { length: number; unit: string };
      measurement?: { key: string; value: number; unit: string };
      morphologyIncludes?: string[];
      attributeEntries: Record<string, string>;
      evidencePages: number[];
      evidenceQuotes: string[];
    }>;
    prohibitedFindingNames: string[];
  };
};

const processingDiagnosticsGolden = JSON.parse(readFileSync(
  new URL("./fixtures/p3-processing-diagnostics-golden.json", import.meta.url),
  "utf8"
)) as {
  denseProcessing: {
    pages: number;
    plannedUnits: number;
    candidates: number;
    resolvedCandidates: number;
    candidateClosurePercent: number;
    supplementUnits: number;
    unresolvedCandidates: number;
  };
};

async function withReport(
  pageCount: number,
  run: (context: { reportId: string; jobId: string }) => Promise<void>,
  linesForPage?: (pageNumber: number) => string[]
) {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-ai-units-"));
  process.env.STORAGE_DIR = storageDir;
  /* 打包阶段会按当前模型的输出上限做预算护栏；测试固定为高上限，
     让单元数量只取决于报告内容而不是环境变量 */
  const previousMaxOutputTokens = process.env.AI_MAX_OUTPUT_TOKENS;
  process.env.AI_MAX_OUTPUT_TOKENS = "384000";
  try {
    const db = getDatabase();
    db.exec(`
      INSERT INTO users (id, display_name) VALUES ('owner', '管理员');
      INSERT INTO health_members (id, display_name, created_by) VALUES ('member', '本人', 'owner');
      /* 本文件的用例覆盖完整解析管线（叙事章节、遗漏复核、补提取），
         显式固定详细模式，不随全局默认值变化 */
      INSERT INTO app_settings (setting_key, value_json)
      VALUES ('ai.provider', '{"extractionDepth":"detailed"}');
      INSERT INTO reports (id, member_id, created_by, report_type, title, status)
      VALUES ('report', 'member', 'owner', 'checkup', '长体检报告', 'processing');
      INSERT INTO processing_jobs (
        id, report_id, job_type, status, pipeline_version, deduplication_key
      ) VALUES ('ai-job', 'report', 'ai_extract', 'processing', 'unit-test', 'ai-job-key');
    `);
    const insertPage = db.prepare(`
      INSERT INTO report_pages (
        id, report_id, page_number, original_name, mime_type, storage_path, file_size, sha256
      ) VALUES (?, 'report', ?, ?, 'image/png', ?, 1, ?)
    `);
    const insertOcrJob = db.prepare(`
      INSERT INTO processing_jobs (
        id, report_id, page_id, job_type, status, pipeline_version, deduplication_key
      ) VALUES (?, 'report', ?, 'ocr', 'completed', 'unit-test', ?)
    `);
    const insertOcr = db.prepare(`
      INSERT INTO ocr_results (
        id, job_id, page_id, engine, model_version, lines_json, text_length
      ) VALUES (?, ?, ?, 'test', 'test-v1', ?, ?)
    `);
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      const pageId = `page-${pageNumber}`;
      const ocrJobId = `ocr-job-${pageNumber}`;
      const lineTexts = linesForPage?.(pageNumber) || [
        `第${pageNumber}页检查`,
        `指标${pageNumber} ${pageNumber}.2 mmol/L 参考范围 1.0-20.0`,
        `说明${pageNumber} ${"内容".repeat(450)}`
      ];
      const lines = lineTexts.map((text, index) => ({
        id: `${pageId}-line-${index + 1}`, text, confidence: 0.99
      }));
      const linesJson = JSON.stringify(lines);
      insertPage.run(pageId, pageNumber, `${pageNumber}.png`, `reports/${pageNumber}.png`, `hash-${pageNumber}`);
      insertOcrJob.run(ocrJobId, pageId, `ocr-${pageNumber}`);
      insertOcr.run(`ocr-${pageNumber}`, ocrJobId, pageId, linesJson, linesJson.length);
    }
    await run({ reportId: "report", jobId: "ai-job" });
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    if (previousMaxOutputTokens === undefined) delete process.env.AI_MAX_OUTPUT_TOKENS;
    else process.env.AI_MAX_OUTPUT_TOKENS = previousMaxOutputTokens;
    rmSync(storageDir, { recursive: true, force: true });
  }
}

function resultForInput(text: string, index: number): AiExtractionResult {
  const pages = [...text.matchAll(/\[第 (\d+) 页\]/g)].map((match) => Number(match[1]));
  const normalized = normalizeAiExtraction({
    reportType: "physical_exam",
    title: "年度体检报告",
    hospitalNameRaw: "示例体检中心",
    reportIssuedAt: "2026-07-29",
    summary: `单元${index}摘要`,
    observations: pages.map((pageNumber) => ({
      sectionName: "一般检查",
      itemName: `指标${pageNumber}`,
      resultText: `${pageNumber}.2`,
      numericValue: pageNumber + 0.2,
      unit: "mmol/L",
      referenceLow: 1,
      referenceHigh: 20,
      evidence: [{ pageNumber, quote: `指标${pageNumber} ${pageNumber}.2 mmol/L` }]
    }))
  });
  return {
    provider: "test-provider",
    model: "test-model",
    promptVersion: aiExtractionPromptVersion,
    ...normalized,
    rawResponseJson: JSON.stringify(normalized),
    promptTokens: 100,
    completionTokens: 20,
    elapsedMs: 10
  };
}

test("processes a long report as multiple persisted units and merges every page", async () => {
  await withReport(10, async ({ reportId, jobId }) => {
    getDatabase().prepare(`
      INSERT INTO observations (id, report_id, item_name, result_text)
      VALUES ('old-observation', ?, '旧指标', '旧结果')
    `).run(reportId);
    let calls = 0;
    const executor: AiExecutor = async (input) => resultForInput(input.text, ++calls);
    const execution = await executeAiExtractionPlan(jobId, reportId, executor);

    assert.ok(execution.plan.unitCount >= 2);
    assert.equal(calls, execution.plan.unitCount);
    assert.equal(execution.result.fields.observations.length, 10);
    assert.equal(execution.result.promptTokens, execution.plan.unitCount * 100);
    assert.equal(execution.result.fields.summary, "单元1摘要");
    assert.equal((getDatabase().prepare(`
      SELECT COUNT(*) AS count FROM observations WHERE id = 'old-observation'
    `).get() as { count: number }).count, 1);
    persistAiExtraction(reportId, jobId, execution.result, execution.inputCharacters);
    assert.equal((getDatabase().prepare(`
      SELECT COUNT(*) AS count FROM observations WHERE id = 'old-observation'
    `).get() as { count: number }).count, 0);
    assert.equal((getDatabase().prepare(`
      SELECT COUNT(*) AS count FROM observations WHERE report_id = ?
    `).get(reportId) as { count: number }).count, 10);
    const counts = getDatabase().prepare(`
      SELECT COUNT(*) AS total, SUM(status = 'completed') AS completed
      FROM ai_extraction_units WHERE job_id = ?
    `).get(jobId) as { total: number; completed: number };
    assert.equal(counts.total, execution.plan.unitCount);
    assert.equal(counts.completed, execution.plan.unitCount);
    const candidates = getDatabase().prepare(`
      SELECT COUNT(*) AS total,
        SUM(status = 'ai_extracted') AS aiExtracted,
        SUM(status = 'unresolved') AS unresolved
      FROM ai_extraction_candidates WHERE job_id = ?
    `).get(jobId) as { total: number; aiExtracted: number; unresolved: number };
    assert.equal(candidates.total, 10);
    assert.equal(candidates.aiExtracted, 10);
    assert.equal(candidates.unresolved, 0);
  });
});

test("keeps document title and type anchored to the first scalar unit", async () => {
  await withReport(7, async ({ reportId, jobId }) => {
    const permissions: boolean[] = [];
    const executor: AiExecutor = async (input) => {
      permissions.push(Boolean(input.allowDocumentFields));
      const isFirstUnit = input.pageNumbers?.includes(1);
      const normalized = normalizeAiExtraction({
        reportType: isFirstUnit ? "physical_exam" : "functional",
        title: isFirstUnit ? "综合健康体检报告" : "动脉阻塞与僵硬度检测报告",
        hospitalNameRaw: isFirstUnit ? "示例体检中心" : "专项检查机构",
        observations: []
      });
      return {
        provider: "test", model: "test", promptVersion: "test", ...normalized,
        rawResponseJson: "{}", promptTokens: 10, completionTokens: 5, elapsedMs: 1
      };
    };
    const execution = await executeAiExtractionPlan(jobId, reportId, executor);
    assert.equal(permissions[0], true);
    assert.equal(permissions.slice(1).every((allowed) => !allowed), true);
    assert.equal(execution.result.fields.reportType, "checkup");
    assert.equal(execution.result.fields.title, "综合健康体检报告");
    assert.equal(execution.result.fields.hospitalNameRaw, "示例体检中心");
  }, (pageNumber) => [
    pageNumber === 1 ? "个人健康体检报告" : `第${pageNumber}页专项检查`,
    `指标${pageNumber} ${pageNumber}.2 mmol/L 参考范围 1.0-20.0`
  ]);
});

test("fills business identifiers locally and does not persist a generic checkup body part", async () => {
  await withReport(1, async ({ reportId, jobId }) => {
    const executor: AiExecutor = async () => {
      const normalized = normalizeAiExtraction({
        reportType: "physical_exam",
        title: "综合健康体检报告",
        bodyParts: [{ raw: "综合体检", name: "综合体检", parent: null, laterality: "unspecified" }],
        identifiers: {}
      });
      return {
        provider: "test", model: "test", promptVersion: "test", ...normalized,
        rawResponseJson: "{}", promptTokens: 10, completionTokens: 5, elapsedMs: 1
      };
    };
    const execution = await executeAiExtractionPlan(jobId, reportId, executor);
    assert.equal(execution.result.fields.identifiers.physicalExamNo, "EXAM-2026-001");
    assert.deepEqual(execution.result.fields.bodyParts, []);
    persistAiExtraction(reportId, jobId, execution.result, execution.inputCharacters);
    const stored = getDatabase().prepare(`
      SELECT body_parts_json AS bodyPartsJson, identifiers_json AS identifiersJson
      FROM reports WHERE id = ?
    `).get(reportId) as { bodyPartsJson: string; identifiersJson: string };
    assert.deepEqual(JSON.parse(stored.bodyPartsJson), []);
    assert.equal(JSON.parse(stored.identifiersJson).physicalExamNo, "EXAM-2026-001");
  }, () => [
    "个人健康体检报告",
    "体检编号：EXAM-2026-001"
  ]);
});

test("keeps full document field extraction for a single-page laboratory report", async () => {
  await withReport(1, async ({ reportId, jobId }) => {
    let receivedAllowDocumentFields = false;
    const executor: AiExecutor = async (input) => {
      receivedAllowDocumentFields = Boolean(input.allowDocumentFields);
      const normalized = normalizeAiExtraction({
        reportType: "laboratory",
        title: "血常规检验报告",
        hospitalNameRaw: "示例医院",
        reportIssuedAt: "2026-07-30 08:30:00",
        observations: [{
          sectionName: "血常规",
          itemName: "白细胞计数",
          resultText: "5.0",
          numericValue: 5,
          unit: "10^9/L",
          referenceLow: 3.5,
          referenceHigh: 9.5,
          evidence: [{ pageNumber: 1, quote: "白细胞计数 | 5.0 | 10^9/L | 3.5-9.5" }]
        }]
      });
      return {
        provider: "test", model: "test", promptVersion: "test", ...normalized,
        rawResponseJson: "{}", promptTokens: 10, completionTokens: 5, elapsedMs: 1
      };
    };
    const execution = await executeAiExtractionPlan(jobId, reportId, executor);
    assert.equal(receivedAllowDocumentFields, true);
    assert.equal(execution.result.fields.reportType, "laboratory");
    assert.equal(execution.result.fields.title, "血常规检验报告");
    assert.equal(execution.result.fields.hospitalNameRaw, "示例医院");
    assert.equal(execution.result.fields.observations.length, 1);
  }, () => [
    "血常规检验报告",
    "项目 | 结果 | 单位 | 参考范围",
    "白细胞计数 | 5.0 | 10^9/L | 3.5-9.5"
  ]);
});

test("fills the nearest section and ignores abnormal markers from historical result columns", async () => {
  await withReport(1, async ({ reportId, jobId }) => {
    const executor: AiExecutor = async () => {
      const normalized = normalizeAiExtraction({
        reportType: "laboratory",
        observations: [{
          itemName: "低密度脂蛋白胆固醇",
          resultText: "3.04",
          numericValue: 3.04,
          unit: "mmol/L",
          referenceHigh: 3.37,
          abnormalFlag: "high",
          evidence: [{
            pageNumber: 1,
            quote: "低密度脂蛋白胆固醇 | 3.04 | mmol/L | <3.37 | 3.52↑"
          }]
        }]
      });
      return {
        provider: "test", model: "test", promptVersion: "test", ...normalized,
        rawResponseJson: "{}", promptTokens: 10, completionTokens: 5, elapsedMs: 1
      };
    };
    const execution = await executeAiExtractionPlan(jobId, reportId, executor);
    const observation = execution.result.fields.observations[0];
    assert.equal(observation.sectionName, "血脂");
    assert.equal(observation.abnormalFlag, null);
  }, () => [
    "血脂",
    "项目 | 本次结果 | 单位 | 参考范围 | 历史结果",
    "低密度脂蛋白胆固醇 | 3.04 | mmol/L | <3.37 | 3.52↑"
  ]);
});

test("keeps a dash as the current stool result instead of using the reference range", async () => {
  await withReport(1, async ({ reportId, jobId }) => {
    const executor: AiExecutor = async () => {
      const normalized = normalizeAiExtraction({
        reportType: "laboratory",
        observations: [{
          itemName: "白细胞",
          resultText: "0~5",
          numericValue: 0,
          referenceLow: 0,
          referenceHigh: 5,
          evidence: [{ pageNumber: 1, quote: "白细胞 | - | 0~5" }]
        }]
      });
      return {
        provider: "test", model: "test", promptVersion: "test", ...normalized,
        rawResponseJson: "{}", promptTokens: 10, completionTokens: 5, elapsedMs: 1
      };
    };
    const execution = await executeAiExtractionPlan(jobId, reportId, executor);
    const observation = execution.result.fields.observations[0];
    assert.equal(observation.sectionName, "便常规");
    assert.equal(observation.resultText, "-");
    assert.equal(observation.numericValue, null);
    assert.equal(observation.unit, null);
    assert.equal(observation.referenceLow, 0);
    assert.equal(observation.referenceHigh, 5);
  }, () => [
    "【便常规】",
    "项目 | 本次结果 | 参考值",
    "白细胞 | - | 0~5"
  ]);
});

test("corrects a historical numeric value to the table's current-result cell", async () => {
  await withReport(1, async ({ reportId, jobId }) => {
    const executor: AiExecutor = async () => {
      const normalized = normalizeAiExtraction({
        reportType: "physical_exam",
        observations: [{
          sectionName: "血常规",
          itemName: "体重指数BMI",
          resultText: "24.8",
          numericValue: 24.8,
          referenceLow: 18.5,
          referenceHigh: 23.9,
          abnormalFlag: "high",
          evidence: [{
            pageNumber: 1,
            quote: "体重指数BMI | 24.9 ↑ | 18.5~23.9 | 24.8 ↑"
          }]
        }]
      });
      return {
        provider: "test", model: "test", promptVersion: "test", ...normalized,
        rawResponseJson: "{}", promptTokens: 10, completionTokens: 5, elapsedMs: 1
      };
    };
    const execution = await executeAiExtractionPlan(jobId, reportId, executor);
    const observation = execution.result.fields.observations[0];
    assert.equal(observation.sectionName, "一般检查");
    assert.equal(observation.resultText, "24.9 ↑");
    assert.equal(observation.numericValue, 24.9);
    assert.equal(observation.abnormalFlag, "high");
  }, () => [
    "【一般检查】",
    "项目 | 本次结果 | 参考值 | 历史结果",
    "体重指数BMI | 24.9 ↑ | 18.5~23.9 | 24.8 ↑"
  ]);
});

test("inherits a urine section across page boundaries", async () => {
  await withReport(2, async ({ reportId, jobId }) => {
    const executor: AiExecutor = async () => {
      const normalized = normalizeAiExtraction({
        reportType: "laboratory",
        observations: [{
          itemName: "镜检白细胞",
          resultText: "2",
          numericValue: 2,
          unit: "Cell/HP",
          evidence: [{ pageNumber: 2, quote: "镜检白细胞 | 2 | Cell/HP | 0~5" }]
        }]
      });
      return {
        provider: "test", model: "test", promptVersion: "test", ...normalized,
        rawResponseJson: "{}", promptTokens: 10, completionTokens: 5, elapsedMs: 1
      };
    };
    const execution = await executeAiExtractionPlan(jobId, reportId, executor);
    assert.match(execution.result.fields.observations[0].sectionName || "", /尿常规/);
  }, (pageNumber) => pageNumber === 1 ? [
    "【尿常规15项】",
    "项目 | 本次结果 | 单位 | 参考值",
    "尿蛋白 | 阴性 | | 阴性"
  ] : [
    "镜检白细胞 | 2 | Cell/HP | 0~5"
  ]);
});

test("merges summary and detailed morphology for the same lesion while preserving distinct sizes", () => {
  const base = {
    sectionName: "超声检查",
    region: null,
    laterality: "right" as const,
    findingType: "斑块",
    findingName: "右侧锁骨下动脉斑块",
    presence: "present" as const,
    findingCount: 1,
    measurements: [],
    morphology: null,
    attributes: {},
    classification: null,
    comparisonText: null,
    confidence: 0.9
  };
  const merged = deduplicateReportMorphologyFindings([
    {
      ...base,
      region: "右侧",
      organ: "subclavian_artery",
      size: { length: null, width: null, height: null, unit: null },
      rawText: "右侧锁骨下动脉斑块",
      evidence: [{ pageNumber: 2, quote: "右侧锁骨下动脉斑块" }]
    },
    {
      ...base,
      region: "颈部",
      organ: "右侧锁骨下动脉",
      size: { length: 8, width: 2, height: null, unit: "mm" },
      morphology: "低回声斑块",
      rawText: "右侧锁骨下动脉起始段见 8×2 mm 低回声斑块",
      evidence: [{ pageNumber: 15, quote: "右侧锁骨下动脉起始段见 8×2 mm 低回声斑块" }]
    },
    {
      ...base,
      region: "颈部",
      organ: "右侧锁骨下动脉",
      size: { length: 4, width: 2, height: null, unit: "mm" },
      rawText: "右侧锁骨下动脉另见 4×2 mm 斑块",
      evidence: [{ pageNumber: 15, quote: "右侧锁骨下动脉另见 4×2 mm 斑块" }]
    }
  ]);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].organ, "锁骨下动脉");
  assert.equal(merged[0].size.length, 8);
  assert.deepEqual(merged[0].evidence.map((item) => item.pageNumber), [2, 15]);
});

test("merges morphology regions with and without the organ prefix", () => {
  const base = {
    sectionName: "腹部超声",
    organ: "肝脏",
    laterality: "right" as const,
    findingType: "钙化灶",
    findingName: "肝右叶钙化灶",
    presence: "present" as const,
    findingCount: 1,
    measurements: [],
    morphology: null,
    attributes: {},
    classification: null,
    comparisonText: null,
    confidence: 0.9
  };
  const merged = deduplicateReportMorphologyFindings([
    {
      ...base,
      region: "肝右叶",
      size: { length: null, width: null, height: null, unit: null },
      rawText: "肝右叶钙化灶",
      evidence: [{ pageNumber: 4, quote: "肝右叶钙化灶" }]
    },
    {
      ...base,
      region: "右叶",
      size: { length: 5, width: 4, height: null, unit: "mm" },
      rawText: "肝右叶可见钙化灶",
      evidence: [{ pageNumber: 18, quote: "肝右叶可见钙化灶" }]
    }
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].size.length, 5);
  assert.deepEqual(merged[0].evidence.map((item) => item.pageNumber), [4, 18]);
});

test("merges the real ultrasound summary and detail golden into two canonical findings", () => {
  const merged = deduplicateReportMorphologyFindings(
    ultrasoundMorphologyGolden.source.findings
  );
  assert.equal(merged.length, ultrasoundMorphologyGolden.expected.findingCount);
  for (const expected of ultrasoundMorphologyGolden.expected.findings) {
    const finding = merged.find((item) => item.findingType === expected.findingType);
    assert.ok(finding, `缺少标准 finding：${expected.findingType}`);
    assert.equal(finding.findingName, expected.findingName);
    assert.equal(finding.organ, expected.organ);
    assert.equal(finding.laterality, expected.laterality);
    if (expected.region) assert.equal(finding.region, expected.region);
    if (expected.size) {
      assert.equal(finding.size.length, expected.size.length);
      assert.equal(finding.size.unit, expected.size.unit);
    }
    if (expected.measurement) {
      assert.equal(
        finding.measurements.some(
          (item) =>
            item.key === expected.measurement?.key &&
            item.value === expected.measurement.value &&
            item.unit === expected.measurement.unit
        ),
        true
      );
    }
    for (const text of expected.morphologyIncludes || []) {
      assert.match(finding.morphology || "", new RegExp(text));
    }
    for (const [key, value] of Object.entries(expected.attributeEntries)) {
      assert.equal(finding.attributes[key], value);
    }
    assert.deepEqual(
      [...new Set(finding.evidence.map((item) => item.pageNumber))].sort(
        (left, right) => left - right
      ),
      expected.evidencePages
    );
    for (const quote of expected.evidenceQuotes) {
      assert.equal(
        finding.evidence.some((item) => item.quote === quote),
        true,
        `缺少原文证据：${quote}`
      );
    }
  }
  for (const prohibited of ultrasoundMorphologyGolden.expected.prohibitedFindingNames) {
    assert.equal(
      merged.some((item) => item.findingName === prohibited),
      false,
      `描述性别名不得形成独立 finding：${prohibited}`
    );
  }
});

test("sanitizes metadata fragments and qualitative results stored as units", () => {
  const base = {
    sectionName: "检验检查",
    itemCode: null,
    normalizedName: null,
    numericValue: null,
    referenceLow: null,
    referenceHigh: null,
    referenceText: null,
    abnormalFlag: null,
    method: null,
    evidence: [{ pageNumber: 1, quote: "检测结果" }]
  };
  const sanitized = sanitizeReportObservations([
    { ...base, itemName: "性别", resultText: "男", unit: null },
    { ...base, itemName: "P", resultText: "12", unit: null },
    { ...base, itemName: "某定性检查", resultText: "-", unit: "阴性" },
    { ...base, itemName: "另一项定性检查", resultText: "未检出", unit: "未检出" }
  ]);
  assert.equal(sanitized.length, 2);
  assert.deepEqual(sanitized.map((item) => ({
    itemName: item.itemName,
    resultText: item.resultText,
    unit: item.unit
  })), [
    { itemName: "某定性检查", resultText: "阴性", unit: null },
    { itemName: "另一项定性检查", resultText: "未检出", unit: null }
  ]);
});

test("repairs observation values, rejects date fragments, and withholds reversed reference bounds", () => {
  const base = {
    sectionName: "检验检查",
    itemCode: null,
    normalizedName: null,
    unit: "mmol/L",
    referenceText: "3.9-6.1",
    abnormalFlag: null,
    method: null,
    evidence: [
      { pageNumber: 1, quote: "空腹血糖 5.2 mmol/L 参考范围 3.9-6.1" },
      { pageNumber: 1, quote: "空腹血糖 5.2 mmol/L 参考范围 3.9-6.1" }
    ]
  };
  const sanitized = sanitizeReportObservations([
    {
      ...base,
      itemName: "空腹血糖",
      resultText: "5.2",
      numericValue: 9.9,
      referenceLow: 6.1,
      referenceHigh: 3.9
    },
    { ...base, itemName: "2026-08-05", resultText: "5.2", numericValue: 5.2, referenceLow: null, referenceHigh: null },
    { ...base, itemName: "3.9-6.1", resultText: "5.2", numericValue: 5.2, referenceLow: null, referenceHigh: null }
  ]);
  assert.equal(sanitized.length, 1);
  assert.equal(sanitized[0].numericValue, 5.2);
  assert.equal(sanitized[0].referenceLow, null);
  assert.equal(sanitized[0].referenceHigh, null);
  assert.equal(sanitized[0].referenceText, "3.9-6.1");
  assert.equal(sanitized[0].evidence.length, 1);
});

test("repairs damaged CBC OCR values and conservatively completes one missing differential percentage", () => {
  const evidence = (quote: string) => [{ pageNumber: 1, quote }];
  const base = {
    sectionName: "血常规五分类检验报告单",
    itemCode: null,
    normalizedName: null,
    referenceText: null,
    abnormalFlag: null,
    method: null,
  };
  const sanitized = sanitizeReportObservations([
    {
      ...base,
      itemName: "淋巴细胞百分比(LYMPH%)",
      resultText: "49.1",
      numericValue: 49.1,
      unit: null,
      referenceLow: 20,
      referenceHigh: 50,
      evidence: evidence("淋巴细胞百分比(LYMPH%) | 49.1 | 20-50"),
    },
    {
      ...base,
      itemName: "单核细胞百分比(MONO%)",
      resultText: "4.6",
      numericValue: 4.6,
      unit: null,
      referenceLow: 3,
      referenceHigh: 10,
      evidence: evidence("单核细胞百分比(MONO%) | 4.6 | 3-10"),
    },
    {
      ...base,
      itemName: "嗜酸性粒细胞百分比(EO%)",
      resultText: "6.2",
      numericValue: 6.2,
      unit: null,
      referenceLow: 0.4,
      referenceHigh: 8,
      evidence: evidence("嗜酸性粒细胞百分比(EO%) | 6.2 | 0.4-8.0"),
    },
    {
      ...base,
      itemName: "啫碱性粒细胞百分比(BASO%)",
      resultText: "8'0",
      numericValue: 8,
      unit: null,
      referenceLow: 0,
      referenceHigh: 1,
      abnormalFlag: "high",
      evidence: evidence("啫碱性粒细胞百分比(BASO%) | 8'0 | 0.0-1.0"),
    },
    {
      ...base,
      itemName: "血小板压积(PCT)",
      resultText: "0.23",
      numericValue: 0.23,
      unit: null,
      referenceLow: 0.19,
      referenceHigh: 0.36,
      evidence: evidence(
        "中性粒细胞百分比(NEUT%) | 40-75 | 血小板压积(PCT) | 0.23 | 0.19-0.36",
      ),
    },
    {
      ...base,
      itemName: "血红蛋白浓度(HGB)",
      resultText: "165",
      numericValue: 165,
      unit: "9/L",
      referenceLow: 130,
      referenceHigh: 175,
      evidence: evidence("血红蛋白浓度(HGB) | 165 | 9/L | 130-175"),
    },
    {
      ...base,
      itemName: "红细胞压积(HCT)",
      resultText: "0.49",
      numericValue: 0.49,
      unit: null,
      referenceLow: 0.4,
      referenceHigh: 0.5,
      evidence: evidence("红细胞压积(HCT) | 0.49 | 0.40-0.50"),
    },
    {
      ...base,
      itemName: "血小板体积分布宽度(PDVW)",
      resultText: "↑76",
      numericValue: 76,
      unit: null,
      referenceLow: 9.8,
      referenceHigh: 15.2,
      abnormalFlag: "high",
      evidence: evidence("血小板体积分布宽度(PDVW) | ↑76 | 9.8-15.2"),
    },
  ]);
  const byName = new Map(sanitized.map((item) => [item.itemName, item]));

  assert.equal(byName.get("啫碱性粒细胞百分比(BASO%)")?.resultText, "0.8");
  assert.equal(byName.get("啫碱性粒细胞百分比(BASO%)")?.numericValue, 0.8);
  assert.equal(byName.get("啫碱性粒细胞百分比(BASO%)")?.abnormalFlag, null);
  assert.equal(byName.get("血红蛋白浓度(HGB)")?.unit, "g/L");
  assert.equal(byName.get("红细胞压积(HCT)")?.unit, "L/L");
  assert.equal(byName.has("血小板体积分布宽度(PDVW)"), false);
  const neutrophil = byName.get("中性粒细胞百分比(NEUT%)");
  assert.equal(neutrophil?.numericValue, 39.3);
  assert.equal(neutrophil?.resultText, "39.3↓");
  assert.equal(neutrophil?.unit, "%");
  assert.equal(neutrophil?.referenceLow, 40);
  assert.equal(neutrophil?.referenceHigh, 75);
  assert.equal(neutrophil?.abnormalFlag, "low");
  assert.equal(
    neutrophil?.method,
    "calculated:differential_percentage_complement",
  );
});

test("repairs embedded numeric names and report-level qualitative headings safely", () => {
  const base = {
    itemCode: null,
    normalizedName: null,
    referenceLow: null,
    referenceHigh: null,
    referenceText: null,
    abnormalFlag: null,
    method: null,
    evidence: [{ pageNumber: 1, quote: "可核验检查结果" }]
  };
  const sanitized = sanitizeReportObservations([
    {
      ...base,
      sectionName: "骨密度检查",
      itemName: "BUA:22.1",
      resultText: "22.1",
      numericValue: 22.1,
      unit: null
    },
    {
      ...base,
      sectionName: "骨密度检查",
      itemName: "ABC:99",
      resultText: "22.1",
      numericValue: 22.1,
      unit: null
    },
    {
      ...base,
      sectionName: "某专项检验报告",
      itemName: "某专项检验报告",
      resultText: "阴性",
      numericValue: null,
      unit: null
    }
  ]);

  assert.equal(sanitized.length, 3);
  assert.equal(sanitized[0].itemName, "BUA");
  assert.equal(sanitized[0].numericValue, 22.1);
  assert.equal(sanitized[1].itemName, "ABC:99");
  assert.equal(sanitized[2].itemName, "某专项");
  assert.equal(sanitized[2].resultText, "阴性");
});

test("rejects unverified AI observations and downgrades fields that cannot close the OCR loop", async () => {
  await withReport(1, async ({ reportId, jobId }) => {
    const normalized = normalizeAiExtraction({
      reportType: "laboratory",
      observations: [
        {
          itemName: "空腹血糖", resultText: "5.2", numericValue: 5.2, unit: "mmol/L",
          referenceLow: 3.9, referenceHigh: 6.1,
          evidence: [{ pageNumber: 1, quote: "空腹血糖 5.2 mmol/L 参考范围 3.9-6.1" }]
        },
        {
          itemName: "总胆固醇", resultText: "5.3", numericValue: 5.3, unit: "mmol/L",
          referenceLow: 0, referenceHigh: 5.2,
          evidence: [{ pageNumber: 1, quote: "总胆固醇 5.3 mmol/L" }]
        },
        {
          itemName: "白细胞计数", resultText: "5.0", numericValue: 5, unit: "10^9/L",
          evidence: [{ pageNumber: 1, quote: "不存在的白细胞计数 5.0 10^9/L" }]
        },
        {
          itemName: "丙氨酸氨基转移酶", resultText: "20", numericValue: 99, unit: "U/L",
          evidence: [{ pageNumber: 1, quote: "丙氨酸氨基转移酶 20 U/L" }]
        }
      ]
    });
    persistAiExtraction(reportId, jobId, {
      provider: "test", model: "test", promptVersion: "test", ...normalized,
      rawResponseJson: "{}", promptTokens: 10, completionTokens: 5, elapsedMs: 1
    }, 100);
    const rows = getDatabase().prepare(`
      SELECT o.item_name AS itemName, o.numeric_value AS numericValue, o.evidence_json AS evidenceJson,
        n.quality, n.excluded_reason AS excludedReason
      FROM observations o
      JOIN observation_normalizations n ON n.observation_id = o.id
      WHERE o.report_id = ? ORDER BY o.item_name
    `).all(reportId) as Array<{
      itemName: string; numericValue: number; evidenceJson: string;
      quality: string; excludedReason: string | null;
    }>;
    const byName = Object.fromEntries(rows.map((row) => [row.itemName, row]));
    assert.equal(byName["空腹血糖"].quality, "high");
    assert.equal(byName["总胆固醇"].quality, "low");
    assert.match(byName["总胆固醇"].excludedReason || "", /参考范围下限/);
    assert.equal(byName["白细胞计数"], undefined);
    assert.equal(byName["丙氨酸氨基转移酶"].numericValue, 20);
    assert.equal(byName["丙氨酸氨基转移酶"].quality, "high");
  }, () => [
    "空腹血糖 5.2 mmol/L 参考范围 3.9-6.1",
    "总胆固醇 5.3 mmol/L",
    "白细胞计数 5.0 10^9/L",
    "丙氨酸氨基转移酶 20 U/L"
  ]);
});


test("accepts an exact deterministic preprocessed OCR row as persisted evidence", async () => {
  await withReport(1, async ({ reportId, jobId }) => {
    const rawLines = [
      { id: "name", text: "空腹血糖", confidence: 0.99, box: [10, 10, 100, 30] },
      { id: "value", text: "5.2", confidence: 0.99, box: [130, 10, 170, 30] },
      { id: "unit", text: "mmol/L", confidence: 0.99, box: [200, 10, 270, 30] },
      { id: "range", text: "3.9-6.1", confidence: 0.99, box: [300, 10, 380, 30] }
    ];
    getDatabase().prepare(`
      UPDATE ocr_results SET lines_json = ?, text_length = ? WHERE page_id = 'page-1'
    `).run(JSON.stringify(rawLines), JSON.stringify(rawLines).length);
    const plannedLine = buildAiExtractionPlan(reportId).pages[0].lines
      .find((line) => line.text.includes("空腹血糖") && line.text.includes("mmol/L"))?.text;
    assert.ok(plannedLine);
    assert.equal(rawLines.some((line) => line.text === plannedLine), false);

    const normalized = normalizeAiExtraction({
      reportType: "laboratory",
      observations: [{
        itemName: "空腹血糖", resultText: "5.2", numericValue: 5.2, unit: "mmol/L",
        referenceLow: 3.9, referenceHigh: 6.1,
        evidence: [{ pageNumber: 1, quote: plannedLine }]
      }]
    });
    persistAiExtraction(reportId, jobId, {
      provider: "test", model: "test", promptVersion: "test", ...normalized,
      rawResponseJson: "{}", promptTokens: 10, completionTokens: 5, elapsedMs: 1
    }, 100);
    const stored = getDatabase().prepare(`
      SELECT o.evidence_json AS evidenceJson, n.quality
      FROM observations o JOIN observation_normalizations n ON n.observation_id = o.id
      WHERE o.report_id = ?
    `).get(reportId) as { evidenceJson: string; quality: string };
    assert.equal(stored.quality, "high");
    assert.deepEqual(JSON.parse(stored.evidenceJson), [{ pageNumber: 1, quote: plannedLine }]);
  });
});

test("prefers final-review and examination dates from OCR when persisting a checkup", async () => {
  await withReport(1, async ({ reportId, jobId }) => {
    const normalized = normalizeAiExtraction({
      reportType: "physical_exam",
      title: "综合体检报告",
      reportIssuedAt: "2026-06-14",
      observations: []
    });
    persistAiExtraction(reportId, jobId, {
      provider: "test",
      model: "test",
      promptVersion: "test",
      ...normalized,
      rawResponseJson: "{}",
      promptTokens: 10,
      completionTokens: 5,
      elapsedMs: 1
    }, 100);
    const report = getDatabase().prepare(`
      SELECT report_issued_at AS reportIssuedAt, examined_at AS examinedAt
      FROM reports WHERE id = ?
    `).get(reportId) as { reportIssuedAt: string; examinedAt: string };
    assert.equal(report.reportIssuedAt, "2026-06-15 10:24:00");
    assert.equal(report.examinedAt, "2026-06-14");
  }, () => [
    "健康体检报告",
    "体检日期：2026年06月14日",
    "终检时间：2026-06-15 10:24"
  ]);
});

test("processes 24 pages and 200 dense indicators end to end without a real provider", async () => {
  await withReport(24, async ({ reportId, jobId }) => {
    let active = 0;
    let maximumActive = 0;
    let calls = 0;
    const executor: AiExecutor = async (input) => {
      calls += 1;
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      const lines = input.text.split("\n").filter((line) => /^指标\d+-\d+\s/.test(line));
      const normalized = normalizeAiExtraction({
        reportType: "physical_exam",
        title: "高密度综合体检报告",
        reportIssuedAt: "2026-07-29",
        observations: lines.map((line) => {
          const match = line.match(/^(指标\d+-\d+)\s+(\d+(?:\.\d+)?)\s+mmol\/L/);
          assert.ok(match);
          const pageNumber = Number(match[1].split("-")[0].replace("指标", ""));
          return {
            sectionName: "检验检查",
            itemName: match[1],
            resultText: match[2],
            numericValue: Number(match[2]),
            unit: "mmol/L",
            referenceLow: 1,
            referenceHigh: 200,
            evidence: [{ pageNumber, quote: line }]
          };
        })
      });
      return {
        provider: "test-provider",
        model: "test-model",
        promptVersion: "health-record-unit-v3",
        ...normalized,
        rawResponseJson: JSON.stringify(normalized),
        promptTokens: input.inputCharacters,
        completionTokens: lines.length * 40,
        elapsedMs: 5
      };
    };

    const execution = await executeAiExtractionPlan(jobId, reportId, executor);
    assert.equal(execution.plan.pageCount, 24);
    assert.equal(execution.plan.unitCount, 5);
    assert.equal(calls, 5);
    assert.equal(maximumActive, 3);
    assert.equal(execution.result.fields.observations.length, 200);
    assert.equal(execution.unmatchedCandidates, 0);
    persistAiExtraction(reportId, jobId, execution.result, execution.inputCharacters);
    const stored = getDatabase().prepare(`
      SELECT COUNT(*) AS count FROM observations WHERE report_id = ?
    `).get(reportId) as { count: number };
    assert.equal(stored.count, 200);
    getDatabase().prepare(`
      UPDATE processing_jobs SET status = 'completed', finished_at = CURRENT_TIMESTAMP WHERE id = ?
    `).run(jobId);
    const units = getDatabase().prepare(`
      SELECT unit_type AS unitType, page_numbers_json AS pageNumbersJson, status,
        character_count AS characterCount, candidate_count AS candidateCount,
        matched_count AS matchedCount
      FROM ai_extraction_units WHERE job_id = ? AND status <> 'superseded'
      ORDER BY unit_index, id
    `).all(jobId).map((row) => {
      const unit = row as {
        unitType: "complete_pages" | "page_chunk" | "supplement";
        pageNumbersJson: string;
        status: "planned" | "processing" | "completed" | "warning" | "failed";
        characterCount: number;
        candidateCount: number;
        matchedCount: number;
      };
      return { ...unit, pageNumbers: JSON.parse(unit.pageNumbersJson) as number[] };
    });
    const diagnostics = buildProcessingJobDiagnostics({
      id: jobId,
      reportId,
      jobType: "ai_extract",
      status: "completed",
      errorCode: null,
      errorMessage: null
    }, [], units);
    const golden = processingDiagnosticsGolden.denseProcessing;
    assert.equal(diagnostics.metrics.pageCount, golden.pages);
    assert.equal(diagnostics.metrics.plannedUnits, golden.plannedUnits);
    assert.equal(diagnostics.metrics.candidateCount, golden.candidates);
    assert.equal(diagnostics.metrics.resolvedCandidateCount, golden.resolvedCandidates);
    assert.equal(diagnostics.metrics.candidateClosurePercent, golden.candidateClosurePercent);
    assert.equal(diagnostics.metrics.supplementUnits, golden.supplementUnits);
    assert.equal(diagnostics.metrics.unresolvedCount, golden.unresolvedCandidates);
    assert.equal(diagnostics.metrics.persistedObservationCount, 200);
  }, (pageNumber) => {
    const count = pageNumber <= 8 ? 9 : 8;
    return [
      "项目 | 结果 | 单位 | 参考范围",
      ...Array.from({ length: count }, (_, index) =>
        `指标${pageNumber}-${index + 1} ${index + 1}.2 mmol/L 参考范围 1.0-200.0`
      )
    ];
  });
});

test("resumes a concurrently processed extraction without calling completed units again", async () => {
  await withReport(18, async ({ reportId, jobId }) => {
    let calls = 0;
    let failOnce = true;
    const executor: AiExecutor = async (input) => {
      calls += 1;
      if (failOnce && calls === 2) {
        failOnce = false;
        throw Object.assign(new Error("临时网络失败"), { code: "AI_NETWORK_ERROR" });
      }
      return resultForInput(input.text, calls);
    };

    await assert.rejects(() => executeAiExtractionPlan(jobId, reportId, executor), /临时网络失败/);
    const completedBeforeRetry = getDatabase().prepare(`
      SELECT COUNT(*) AS count FROM ai_extraction_units WHERE job_id = ? AND status = 'completed'
    `).get(jobId) as { count: number };
    assert.ok(completedBeforeRetry.count >= 1);

    const execution = await executeAiExtractionPlan(jobId, reportId, executor);
    assert.equal(calls, execution.plan.unitCount + 1);
    assert.equal(execution.result.fields.observations.length, 18);
    const attempts = getDatabase().prepare(`
      SELECT COUNT(*) AS count FROM ai_extraction_attempts WHERE job_id = ?
    `).get(jobId) as { count: number };
    assert.equal(attempts.count, execution.plan.unitCount + 1);
  });
});

test("runs at most three AI extraction units concurrently", async () => {
  await withReport(25, async ({ reportId, jobId }) => {
    let active = 0;
    let maximumActive = 0;
    const executor: AiExecutor = async (input) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
      return resultForInput(input.text, maximumActive);
    };
    const execution = await executeAiExtractionPlan(jobId, reportId, executor);
    assert.equal(maximumActive, aiExtractionExecutionPolicy.maxConcurrency);
    assert.equal(execution.result.fields.observations.length, 25);
  });
});

test("merges duplicate indicator variants that resolve to the same OCR source row", async () => {
  await withReport(9, async ({ reportId, jobId }) => {
    let calls = 0;
    let scalarCalls = 0;
    const executor: AiExecutor = async (input) => {
      calls += 1;
      if (input.route !== "scalar") {
        const normalized = normalizeAiExtraction({ reportType: "laboratory" });
        return {
          provider: "test", model: "test", promptVersion: "test", ...normalized,
          rawResponseJson: "{}", promptTokens: 10, completionTokens: 5, elapsedMs: 1
        };
      }
      scalarCalls += 1;
      const normalized = normalizeAiExtraction({
        reportType: "laboratory",
        observations: [{
          sectionName: "血常规",
          itemName: scalarCalls === 1 ? "白细胞数目(WBC)" : "白细胞数目",
          resultText: scalarCalls === 1 ? "5.00" : "5",
          numericValue: 5,
          unit: "10^9/L",
          referenceLow: scalarCalls === 1 ? 3.5 : null,
          referenceHigh: scalarCalls === 1 ? 9.5 : null,
          evidence: [{ pageNumber: 1, quote: "白细胞数目(WBC) 5.0 10^9/L 参考范围 3.5-9.5" }]
        }]
      });
      return {
        provider: "test", model: "test", promptVersion: "test", ...normalized,
        rawResponseJson: "{}", promptTokens: 10, completionTokens: 5, elapsedMs: 1
      };
    };
    const execution = await executeAiExtractionPlan(jobId, reportId, executor);
    assert.equal(calls, execution.plan.unitCount);
    assert.equal(execution.result.fields.observations.length, 1);
    assert.equal(execution.result.fields.observations[0].referenceLow, 3.5);
    assert.equal(execution.result.fields.observations[0].referenceHigh, 9.5);
  }, (pageNumber) => [
    pageNumber === 1
      ? "白细胞数目(WBC) 5.0 10^9/L 参考范围 3.5-9.5"
      : `第${pageNumber}页普通说明`
  ]);
});

test("deduplicates the same normalized indicator across report pages before persistence", async () => {
  await withReport(9, async ({ reportId, jobId }) => {
    const executor: AiExecutor = async (input) => {
      const variants = [
        { pageNumber: 1, itemName: "白细胞数目(WBC)", resultText: "5.0" },
        { pageNumber: 9, itemName: "白细胞数目", resultText: "5.00" }
      ].filter((item) => input.text.includes(`${item.itemName} ${item.resultText}`));
      const normalized = normalizeAiExtraction({
        reportType: "laboratory",
        observations: variants.map(({ pageNumber, itemName, resultText }) => ({
          sectionName: "血常规",
          itemName,
          resultText,
          numericValue: 5,
          unit: "10^9/L",
          referenceLow: pageNumber === 1 ? null : 3.5,
          referenceHigh: pageNumber === 1 ? null : 9.5,
          evidence: [{
            pageNumber,
            quote: `${itemName} ${resultText} 10^9/L 参考范围 3.5-9.5`
          }]
        }))
      });
      return {
        provider: "test", model: "test", promptVersion: "test", ...normalized,
        rawResponseJson: "{}", promptTokens: 10, completionTokens: 5, elapsedMs: 1
      };
    };
    const execution = await executeAiExtractionPlan(jobId, reportId, executor);
    assert.equal(execution.result.fields.observations.length, 2);
    persistAiExtraction(reportId, jobId, execution.result, execution.inputCharacters);

    const stored = getDatabase().prepare(`
      SELECT item_name AS itemName, numeric_value AS numericValue,
        reference_low AS referenceLow, reference_high AS referenceHigh,
        evidence_json AS evidenceJson
      FROM observations WHERE report_id = ?
    `).all(reportId) as Array<{
      itemName: string;
      numericValue: number;
      referenceLow: number | null;
      referenceHigh: number | null;
      evidenceJson: string;
    }>;
    assert.equal(stored.length, 1);
    assert.equal(stored[0].numericValue, 5);
    assert.equal(stored[0].referenceLow, 3.5);
    assert.equal(stored[0].referenceHigh, 9.5);
    assert.deepEqual(
      (JSON.parse(stored[0].evidenceJson) as Array<{ pageNumber: number }>).map((item) => item.pageNumber),
      [1, 9]
    );
  }, (pageNumber) => [
    pageNumber === 1
      ? "白细胞数目(WBC) 5.0 10^9/L 参考范围 3.5-9.5"
      : pageNumber === 9
        ? "白细胞数目 5.00 10^9/L 参考范围 3.5-9.5"
        : `第${pageNumber}页普通说明`
  ]);
});

test("blanks conflicting clinical fields instead of silently picking one when merging same-source duplicates", async () => {
  await withReport(1, async ({ reportId, jobId }) => {
    const executor: AiExecutor = async () => {
      const normalized = normalizeAiExtraction({
        reportType: "laboratory",
        observations: [
          {
            sectionName: "生化检验",
            itemName: "空腹血糖",
            resultText: "5.18",
            numericValue: 5.18,
            unit: "mmol/L",
            referenceLow: 3.9,
            referenceHigh: 6.1,
            abnormalFlag: "normal",
            evidence: [{ pageNumber: 1, quote: "空腹血糖 5.18 mmol/L 参考范围 3.9-6.1" }]
          },
          {
            sectionName: "生化检验",
            itemName: "空腹血糖",
            resultText: "5.18",
            numericValue: 5.18,
            unit: "mg/dL",
            referenceLow: 70,
            referenceHigh: 110,
            abnormalFlag: "high",
            evidence: [{ pageNumber: 1, quote: "空腹血糖 5.18 mmol/L 参考范围 3.9-6.1" }]
          }
        ]
      });
      return {
        provider: "test", model: "test", promptVersion: "test", ...normalized,
        rawResponseJson: "{}", promptTokens: 10, completionTokens: 5, elapsedMs: 1
      };
    };
    const execution = await executeAiExtractionPlan(jobId, reportId, executor);
    persistAiExtraction(reportId, jobId, execution.result, execution.inputCharacters);

    const stored = getDatabase().prepare(`
      SELECT item_name AS itemName, numeric_value AS numericValue, unit,
        reference_low AS referenceLow, reference_high AS referenceHigh,
        abnormal_flag AS abnormalFlag
      FROM observations WHERE report_id = ?
    `).all(reportId) as Array<{
      itemName: string;
      numericValue: number;
      unit: string | null;
      referenceLow: number | null;
      referenceHigh: number | null;
      abnormalFlag: string | null;
    }>;
    assert.equal(stored.length, 1);
    assert.equal(stored[0].numericValue, 5.18);
    // 单位、参考范围、异常标记两边冲突，合并结果必须置空而不是静默二选一
    assert.equal(stored[0].unit, null);
    assert.equal(stored[0].referenceLow, null);
    assert.equal(stored[0].referenceHigh, null);
    assert.equal(stored[0].abnormalFlag, null);
  }, () => ["空腹血糖 5.18 mmol/L 参考范围 3.9-6.1"]);
});

test("deduplicates low-quality summary and detail aliases using semantic fact identity", async () => {
  await withReport(1, async ({ reportId }) => {
    const base = {
      itemCode: null,
      normalizedName: null,
      resultText: "1.23",
      numericValue: 1.23,
      unit: "mg/L",
      referenceLow: null,
      referenceHigh: null,
      referenceText: null,
      abnormalFlag: null,
      method: null
    };
    const deduplicated = deduplicateReportObservations(reportId, [
      {
        ...base,
        sectionName: "异常指标汇总",
        itemName: "血清胱抑素C(CysC)",
        evidence: [{ pageNumber: 4, quote: "血清胱抑素C(CysC) 1.23 mg/L" }]
      },
      {
        ...base,
        sectionName: "肾功能检验明细",
        itemName: "胱抑素C",
        referenceLow: 0.5,
        referenceHigh: 1.0,
        evidence: [{ pageNumber: 10, quote: "胱抑素C 1.23 mg/L 参考范围 0.5-1.0" }]
      }
    ]);
    assert.equal(deduplicated.length, 1);
    assert.equal(deduplicated[0].itemName, "胱抑素C");
    assert.equal(deduplicated[0].referenceLow, 0.5);
    assert.equal(deduplicated[0].referenceHigh, 1.0);
    assert.deepEqual(deduplicated[0].evidence.map((item) => item.pageNumber), [4, 10]);
  });
});

test("does not merge distinct qualitative antibody tests that share IgM or IgG codes", async () => {
  await withReport(1, async ({ reportId }) => {
    const base = {
      sectionName: "抗体检查",
      itemCode: null,
      normalizedName: null,
      resultText: "阴性",
      numericValue: null,
      unit: "阴性",
      referenceLow: null,
      referenceHigh: null,
      referenceText: null,
      abnormalFlag: null,
      method: null,
      evidence: [{ pageNumber: 1, quote: "抗体检查结果" }]
    };
    const deduplicated = deduplicateReportObservations(reportId, [
      { ...base, itemName: "甲病原体抗体测定（IgM）" },
      { ...base, itemName: "乙病原体抗体测定（IgM）" },
      { ...base, itemName: "甲病原体抗体测定IgG" },
      { ...base, itemName: "乙病原体抗体测定IgG" }
    ]);
    assert.equal(deduplicated.length, 4);
    assert.equal(deduplicated.every((item) => item.unit === null), true);
  });
});

test("does not merge same-valued indicators when explicit methods conflict", async () => {
  await withReport(1, async ({ reportId }) => {
    const base = {
      sectionName: "检验检查",
      itemCode: null,
      itemName: "空腹血糖",
      normalizedName: null,
      resultText: "5.2",
      numericValue: 5.2,
      unit: "mmol/L",
      referenceLow: null,
      referenceHigh: null,
      referenceText: null,
      abnormalFlag: null,
      evidence: [{ pageNumber: 1, quote: "空腹血糖 5.2 mmol/L" }]
    };
    const deduplicated = deduplicateReportObservations(reportId, [
      { ...base, method: "己糖激酶法" },
      { ...base, method: "葡萄糖氧化酶法" }
    ]);
    assert.equal(deduplicated.length, 2);
  });
});

test("keeps distinct indicators from the same OCR source row while removing cross-unit repeats", async () => {
  await withReport(9, async ({ reportId, jobId }) => {
    const executor: AiExecutor = async () => {
      const normalized = normalizeAiExtraction({
        reportType: "physical_exam",
        observations: [
          {
            sectionName: "一般检查", itemName: "收缩压", resultText: "120",
            numericValue: 120, unit: "mmHg",
            evidence: [{ pageNumber: 1, quote: "血压 120/80 mmHg" }]
          },
          {
            sectionName: "一般检查", itemName: "舒张压", resultText: "80",
            numericValue: 80, unit: "mmHg",
            evidence: [{ pageNumber: 1, quote: "血压 120/80 mmHg" }]
          }
        ]
      });
      return {
        provider: "test", model: "test", promptVersion: "test", ...normalized,
        rawResponseJson: "{}", promptTokens: 10, completionTokens: 5, elapsedMs: 1
      };
    };
    const execution = await executeAiExtractionPlan(jobId, reportId, executor);
    assert.deepEqual(
      execution.result.fields.observations.map((item) => item.itemName).sort(),
      ["收缩压", "舒张压"]
    );
  }, (pageNumber) => [
    pageNumber === 1 ? "血压 120/80 mmHg" : `第${pageNumber}页普通说明`
  ]);
});

test("retries invalid JSON once with strict JSON mode", async () => {
  await withReport(1, async ({ reportId, jobId }) => {
    const modes: Array<string | undefined> = [];
    const executor: AiExecutor = async (input) => {
      modes.push(input.promptMode);
      if (modes.length === 1) {
        throw Object.assign(new Error("AI 返回内容不是有效 JSON"), { code: "AI_INVALID_JSON" });
      }
      return resultForInput(input.text, modes.length);
    };
    const execution = await executeAiExtractionPlan(jobId, reportId, executor);
    assert.deepEqual(modes, ["standard", "json_retry"]);
    assert.equal(execution.result.fields.observations.length, 1);
    const attempts = getDatabase().prepare(`
      SELECT attempt_type AS attemptType, status FROM ai_extraction_attempts
      WHERE job_id = ? ORDER BY created_at, id
    `).all(jobId) as Array<{ attemptType: string; status: string }>;
    assert.deepEqual(attempts.map((item) => item.attemptType).sort(), ["format_retry", "main"]);
    assert.deepEqual(attempts.map((item) => item.status).sort(), ["completed", "failed"]);
  });
});

test("persists provider token usage when a unit output is truncated", async () => {
  await withReport(1, async ({ reportId, jobId }) => {
    const executor: AiExecutor = async () => {
      throw Object.assign(new Error("AI 输出达到模型长度上限，当前解析单元需要缩小"), {
        code: "AI_OUTPUT_TRUNCATED",
        provider: "provider.example",
        model: "model-with-limit",
        promptTokens: 1800,
        completionTokens: 8192,
        elapsedMs: 65000
      });
    };
    await assert.rejects(
      () => executeAiExtractionPlan(jobId, reportId, executor),
      /输出达到模型长度上限/
    );
    const attempt = getDatabase().prepare(`
      SELECT provider, model, prompt_tokens AS promptTokens,
        completion_tokens AS completionTokens, elapsed_ms AS elapsedMs, error_code AS errorCode
      FROM ai_extraction_attempts WHERE job_id = ?
    `).get(jobId) as {
      provider: string; model: string; promptTokens: number;
      completionTokens: number; elapsedMs: number; errorCode: string;
    };
    assert.deepEqual({ ...attempt }, {
      provider: "provider.example",
      model: "model-with-limit",
      promptTokens: 1800,
      completionTokens: 8192,
      elapsedMs: 65000,
      errorCode: "AI_OUTPUT_TRUNCATED"
    });
  });
});

test("raises the output budget before splitting a truncated unit", async () => {
  await withReport(2, async ({ reportId, jobId }) => {
    const scales: number[] = [];
    const executor: AiExecutor = async (input) => {
      if (input.route !== "scalar") return resultForInput(input.text, 0);
      scales.push(input.outputTokenScale || 1);
      if (scales.length === 1) {
        throw Object.assign(new Error("AI 输出达到当前预算"), {
          code: "AI_OUTPUT_TRUNCATED",
          requestedMaxTokens: 16_384,
          modelMaxOutputTokens: 384_000
        });
      }
      return resultForInput(input.text, scales.length);
    };
    const execution = await executeAiExtractionPlan(jobId, reportId, executor);
    assert.deepEqual(scales, [1, 2]);
    assert.equal(execution.result.fields.observations.length, 2);
  });
});

test("splits only the current unit when a larger output budget is still truncated", async () => {
  await withReport(2, async ({ reportId, jobId }) => {
    const calls: Array<{ pages: number; scale: number }> = [];
    const executor: AiExecutor = async (input) => {
      if (input.route !== "scalar") return resultForInput(input.text, 0);
      calls.push({ pages: input.pageCount, scale: input.outputTokenScale || 1 });
      if (input.pageCount > 1) {
        throw Object.assign(new Error("AI 输出达到当前预算"), {
          code: "AI_OUTPUT_TRUNCATED",
          requestedMaxTokens: input.outputTokenScale === 2 ? 32_768 : 16_384,
          modelMaxOutputTokens: 384_000
        });
      }
      return resultForInput(input.text, calls.length);
    };
    const execution = await executeAiExtractionPlan(jobId, reportId, executor);
    assert.deepEqual(calls.slice(0, 2), [{ pages: 2, scale: 1 }, { pages: 2, scale: 2 }]);
    assert.equal(calls.filter((item) => item.pages === 1).length, 2);
    assert.equal(execution.result.fields.observations.length, 2);
    const splitUnits = getDatabase().prepare(`
      SELECT COUNT(*) AS count FROM ai_extraction_units
      WHERE job_id = ? AND unit_type = 'page_chunk' AND status = 'completed'
    `).get(jobId) as { count: number };
    assert.equal(splitUnits.count, 2);
  });
});

test("merges unit results without dropping observations above the old response limit", () => {
  const results = Array.from({ length: 3 }, (_, resultIndex) => {
    const normalized = normalizeAiExtraction({
      observations: Array.from({ length: 250 }, (_, itemIndex) => ({
        itemName: `指标-${resultIndex}-${itemIndex}`,
        resultText: String(itemIndex),
        numericValue: itemIndex,
        evidence: [{ pageNumber: resultIndex + 1, quote: `指标-${resultIndex}-${itemIndex}` }]
      }))
    });
    return {
      provider: "test", model: "test", promptVersion: "test", ...normalized,
      rawResponseJson: "{}", promptTokens: null, completionTokens: null, elapsedMs: 1
    } satisfies AiExtractionResult;
  });
  assert.equal(mergeAiExtractionResults(results).fields.observations.length, 750);
});

test("accepts the compact observation output used to reduce completion tokens", () => {
  const normalized = normalizeAiExtraction({
    reportType: "laboratory",
    observations: [{
      s: "血常规", c: "WBC", n: "白细胞数目(WBC)", r: "5.0",
      v: 5, u: "10^9/L", lo: 3.5, hi: 9.5, f: "normal",
      p: 3, q: "白细胞数目(WBC) 5.0 10^9/L 3.5-9.5"
    }]
  });
  assert.deepEqual(normalized.fields.observations[0], {
    sectionName: "血常规",
    itemCode: "WBC",
    itemName: "白细胞数目(WBC)",
    normalizedName: null,
    resultText: "5.0",
    numericValue: 5,
    unit: "10^9/L",
    referenceLow: 3.5,
    referenceHigh: 9.5,
    referenceText: null,
    abnormalFlag: "normal",
    method: null,
    evidence: [{ pageNumber: 3, quote: "白细胞数目(WBC) 5.0 10^9/L 3.5-9.5" }]
  });
});

test("accepts only known nonempty report sections with compact evidence", () => {
  const normalized = normalizeAiExtraction({
    reportSections: [
      {
        sectionKey: "pathology_immunohistochemistry",
        title: "免疫组化",
        content: "Ki-67 约5%",
        p: 2,
        q: "免疫组化：Ki-67 约5%"
      },
      {
        sectionKey: "unknown_section",
        title: "未知",
        content: "不应保留",
        p: 2,
        q: "未知：不应保留"
      },
      {
        sectionKey: "pathology_stage",
        title: "病理分期",
        content: ""
      }
    ]
  });
  assert.deepEqual(normalized.fields.reportSections, [{
    sectionKey: "pathology_immunohistochemistry",
    title: "免疫组化",
    content: "Ki-67 约5%",
    evidence: [{ pageNumber: 2, quote: "免疫组化：Ki-67 约5%" }]
  }]);
});

test("fills explicit basic measurements locally before omission supplements", async () => {
  await withReport(1, async ({ reportId, jobId }) => {
    let calls = 0;
    const executor: AiExecutor = async () => {
      calls += 1;
      const normalized = normalizeAiExtraction({ reportType: "physical_exam", observations: [] });
      return {
        provider: "test", model: "test", promptVersion: "test", ...normalized,
        rawResponseJson: "{}", promptTokens: 10, completionTokens: 5, elapsedMs: 1
      };
    };
    const execution = await executeAiExtractionPlan(jobId, reportId, executor);
    const values = Object.fromEntries(execution.result.fields.observations.map((item) => [item.itemName, item.numericValue]));
    assert.deepEqual(values, {
      身高: 170,
      体重: 65,
      体重指数: 22.5,
      腰围: 80,
      臀围: 92,
      脉搏: 72,
      收缩压: 120,
      舒张压: 80
    });
    assert.equal(calls, 1);
    assert.equal(execution.unmatchedCandidates, 0);
  }, () => [
    "一般检查",
    "身高 170 cm | 体重 65 kg | BMI 22.5 kg/m2",
    "腰围 80 cm | 臀围 92 cm | 脉搏 72 bpm | 血压 120/80 mmHg"
  ]);
});

test("does not treat a BMI-only line as a body-weight measurement", async () => {
  await withReport(1, async ({ reportId, jobId }) => {
    const executor: AiExecutor = async () => {
      const normalized = normalizeAiExtraction({ reportType: "physical_exam", observations: [] });
      return {
        provider: "test", model: "test", promptVersion: "test", ...normalized,
        rawResponseJson: "{}", promptTokens: 10, completionTokens: 5, elapsedMs: 1
      };
    };
    const execution = await executeAiExtractionPlan(jobId, reportId, executor);
    assert.deepEqual(execution.result.fields.observations.map((item) => ({
      itemName: item.itemName,
      numericValue: item.numericValue,
      unit: item.unit
    })), [{
      itemName: "体重指数",
      numericValue: 24.9,
      unit: "kg/m2"
    }]);
  }, () => [
    "一般检查",
    "体重指数 24.9 kg/m2"
  ]);
});

test("restores the full BMI item name and unit from table evidence", async () => {
  await withReport(1, async ({ reportId, jobId }) => {
    const executor: AiExecutor = async () => {
      const normalized = normalizeAiExtraction({
        reportType: "physical_exam",
        observations: [{
          itemName: "体重",
          normalizedName: "体重",
          resultText: "24.9",
          numericValue: 24.9,
          unit: "kg",
          evidence: [{
            pageNumber: 1,
            quote: "体重指数BMI | 24.9 kg/m2 | 18.5~23.9"
          }]
        }]
      });
      return {
        provider: "test", model: "test", promptVersion: "test", ...normalized,
        rawResponseJson: "{}", promptTokens: 10, completionTokens: 5, elapsedMs: 1
      };
    };
    const execution = await executeAiExtractionPlan(jobId, reportId, executor);
    assert.equal(execution.result.fields.observations.length, 1);
    assert.equal(execution.result.fields.observations[0].itemName, "体重指数BMI");
    assert.equal(execution.result.fields.observations[0].normalizedName, "体重指数");
    assert.equal(execution.result.fields.observations[0].numericValue, 24.9);
    assert.equal(execution.result.fields.observations.some((item) => item.itemName === "体重"), false);
  }, () => [
    "【一般检查】",
    "项目 | 本次结果 | 参考值",
    "体重指数BMI | 24.9 kg/m2 | 18.5~23.9"
  ]);
});

test("fills bilateral ABI and baPWV locally and removes a generic value from the same evidence", async () => {
  await withReport(1, async ({ reportId, jobId }) => {
    let calls = 0;
    const executor: AiExecutor = async () => {
      calls += 1;
      const normalized = normalizeAiExtraction({
        reportType: "functional",
        observations: [{
          itemName: "肱踝脉搏波传导速度",
          resultText: "1315",
          numericValue: 1315,
          unit: "cm/s",
          evidence: [{ pageNumber: 1, quote: "右：1315 | 左：1395 | PWV(cm/s)" }]
        }]
      });
      return {
        provider: "test", model: "test", promptVersion: "test", ...normalized,
        rawResponseJson: "{}", promptTokens: 10, completionTokens: 5, elapsedMs: 1
      };
    };
    const execution = await executeAiExtractionPlan(jobId, reportId, executor);
    const values = Object.fromEntries(execution.result.fields.observations.map((item) => [item.itemName, item.numericValue]));
    assert.deepEqual(values, {
      右侧肱踝脉搏波传导速度: 1315,
      左侧肱踝脉搏波传导速度: 1395,
      右侧踝肱指数: 1.07,
      左侧踝肱指数: 1.08
    });
    assert.equal(calls, 1);
    assert.equal(execution.unmatchedCandidates, 0);
  }, () => [
    "动脉阻塞与僵硬度检测报告单",
    "您的动脉硬化吗（baPWV）？",
    "右：1315 | 左：1395 | PWV(cm/s)",
    "您的动脉阻塞吗（ABI）？",
    "右踝：1.07 | 左踝：1.08"
  ]);
});

test("supplements only unmatched candidate rows once per page", async () => {
  await withReport(1, async ({ reportId, jobId }) => {
    const modes: Array<string | undefined> = [];
    const executor: AiExecutor = async (input) => {
      modes.push(input.promptMode);
      if (input.promptMode === "supplement") {
        assert.deepEqual((input.candidateFacts || []).map((fact) => fact.sourceText), [
          "总胆固醇 5.3 mmol/L 参考范围 0-5.2"
        ]);
        assert.doesNotMatch(input.text, /饮水|风险等级|环境温度|18-39岁|调节说明|基础代谢/);
      }
      const normalized = normalizeAiExtraction({
        reportType: "laboratory",
        observations: input.promptMode === "supplement" ? [{
          itemName: "总胆固醇", resultText: "5.3", numericValue: 5.3, unit: "mmol/L",
          referenceLow: 0, referenceHigh: 5.2,
          evidence: [{ pageNumber: 1, quote: "总胆固醇 5.3 mmol/L 参考范围 0-5.2" }]
        }] : []
      });
      return {
        provider: "test", model: "test", promptVersion: "test", ...normalized,
        rawResponseJson: "{}", promptTokens: 10, completionTokens: 5, elapsedMs: 1
      };
    };
    const execution = await executeAiExtractionPlan(jobId, reportId, executor);
    assert.equal(modes.filter((mode) => mode === "supplement").length, 1);
    assert.equal(modes.at(-1), "supplement");
    assert.equal(execution.result.fields.observations[0]?.itemName, "总胆固醇");
    assert.equal(execution.unmatchedCandidates, 0);
    const unitTypes = getDatabase().prepare(`
      SELECT unit_type AS unitType FROM ai_extraction_units WHERE job_id = ? ORDER BY unit_index
    `).all(jobId) as Array<{ unitType: string }>;
    assert.equal(unitTypes.filter((item) => item.unitType === "supplement").length, 1);
    assert.equal(unitTypes.at(-1)?.unitType, "supplement");
    const candidateCount = (getDatabase().prepare(`
      SELECT COUNT(*) AS count FROM ai_extraction_candidates WHERE job_id = ?
    `).get(jobId) as { count: number }).count;
    assert.equal(candidateCount, 1);
  }, () => [
    "血脂",
    "建议每日饮水 2000 mL，并每周运动 150 分钟。",
    "风险等级 | 0-5 | 6-10 | 11-20 | 21-30",
    "18-39岁 | -20% | 21-34% | 35-39%",
    "环境温度：25 ℃ | 湿度：60%",
    "时间：2025-07-1208:03:29 | 调节说明（kg） | 基础代谢",
    "总胆固醇 5.3 mmol/L 参考范围 0-5.2"
  ]);
});

test("treats a checkup summary as redundant when the detailed local table has the same indicator and result", async () => {
  await withReport(1, async ({ reportId, jobId }) => {
    const modes: Array<string | undefined> = [];
    const executor: AiExecutor = async (input) => {
      modes.push(input.promptMode);
      const normalized = normalizeAiExtraction({ reportType: "physical_exam", observations: [] });
      return {
        provider: "test", model: "test", promptVersion: "test", ...normalized,
        rawResponseJson: "{}", promptTokens: 10, completionTokens: 5, elapsedMs: 1
      };
    };
    const execution = await executeAiExtractionPlan(jobId, reportId, executor);
    assert.equal(modes.includes("supplement"), false);
    assert.equal(execution.unmatchedCandidates, 0);
    assert.equal(execution.result.fields.observations.some((item) =>
      /体重指数|BMI/i.test(item.itemName) && item.numericValue === 24.9
    ), true);
    const statuses = getDatabase().prepare(`
      SELECT status, reason, COUNT(*) AS count FROM ai_extraction_candidates
      WHERE job_id = ? GROUP BY status, reason
    `).all(jobId) as Array<{ status: string; reason: string | null; count: number }>;
    assert.equal(statuses.some((item) => item.status === "local_extracted" && item.count >= 1), true);
    assert.equal(statuses.some((item) =>
      item.status === "redundant" && item.count >= 1 && item.reason?.startsWith("duplicate_evidence:")
    ), true);
  }, () => [
    "异常结果与健康建议",
    "体重指数BMI值偏高(24.9)(参考值18.5~23.9)；建议合理膳食并控制体重。",
    "【一般检查】",
    "项目 | 本次结果 | 参考值 | 历史结果",
    "体重指数BMI | 24.9 ↑ | 18.5~23.9 | 24.8 ↑"
  ]);
});

test("processes every omission candidate when one page contains more than thirty rows", async () => {
  await withReport(1, async ({ reportId, jobId }) => {
    let supplementCalls = 0;
    const executor: AiExecutor = async (input) => {
      if (input.promptMode === "supplement") supplementCalls += 1;
      const normalized = normalizeAiExtraction({
        reportType: "laboratory",
        observations: input.promptMode === "supplement"
          ? (input.candidateFacts || []).map((fact) => {
            const match = fact.sourceText.match(/^(专项指标\d+)\s+(\d+(?:\.\d+)?)\s+U\/L/);
            assert.ok(match);
            return {
              itemName: match[1],
              resultText: match[2],
              numericValue: Number(match[2]),
              unit: "U/L",
              evidence: [{ pageNumber: fact.pageNumber, quote: fact.sourceText }]
            };
          })
          : []
      });
      return {
        provider: "test", model: "test", promptVersion: "test", ...normalized,
        rawResponseJson: "{}", promptTokens: 10, completionTokens: 5, elapsedMs: 1
      };
    };
    const execution = await executeAiExtractionPlan(jobId, reportId, executor);
    assert.ok(supplementCalls >= 2);
    assert.equal(execution.result.fields.observations.length, 65);
    assert.equal(execution.unmatchedCandidates, 0);
  }, () => [
    "【检验检查】",
    "项目 | 本次结果 | 单位 | 参考值",
    ...Array.from({ length: 65 }, (_, index) =>
      `专项指标${index + 1} ${index + 1}.2 U/L 参考范围 0~100`
    )
  ]);
});

test("does not create supplements for opaque repeated device-range rows", async () => {
  await withReport(1, async ({ reportId, jobId }) => {
    let supplementCalls = 0;
    const executor: AiExecutor = async (input) => {
      if (input.promptMode === "supplement") supplementCalls += 1;
      const normalized = normalizeAiExtraction({ reportType: "functional", observations: [] });
      return {
        provider: "test", model: "test", promptVersion: "test", ...normalized,
        rawResponseJson: "{}", promptTokens: 10, completionTokens: 5, elapsedMs: 1
      };
    };

    const execution = await executeAiExtractionPlan(jobId, reportId, executor);
    const unresolved = getDatabase().prepare(`
      SELECT status, reason FROM ai_extraction_candidates WHERE job_id = ?
    `).get(jobId) as { status: string; reason: string };

    assert.equal(supplementCalls, 0);
    assert.equal(execution.warningUnits, 0);
    assert.equal(execution.unmatchedCandidates, 1);
    assert.equal(unresolved.status, "unresolved");
    assert.match(unresolved.reason, /^ambiguous_layout:/);
  }, () => ["功能检查", "ABC18-70(ABC1) | 0.603"]);
});

test("finishes with a warning when an omission supplement still cannot be parsed", async () => {
  await withReport(1, async ({ reportId, jobId }) => {
    const executor: AiExecutor = async (input) => {
      if (input.promptMode === "supplement") {
        throw Object.assign(new Error("补提取失败"), { code: "AI_NETWORK_ERROR" });
      }
      const normalized = normalizeAiExtraction({ reportType: "laboratory", observations: [] });
      return {
        provider: "test", model: "test", promptVersion: "test", ...normalized,
        rawResponseJson: "{}", promptTokens: 10, completionTokens: 5, elapsedMs: 1
      };
    };
    const execution = await executeAiExtractionPlan(jobId, reportId, executor);
    assert.equal(execution.warningUnits, 1);
    assert.equal(execution.unmatchedCandidates, 1);
    assert.equal(execution.result.fields.observations.length, 0);
    const unresolved = getDatabase().prepare(`
      SELECT status, reason FROM ai_extraction_candidates WHERE job_id = ?
    `).get(jobId) as { status: string; reason: string };
    assert.equal(unresolved.status, "unresolved");
    assert.match(unresolved.reason, /^supplement_required:/);
  }, () => ["血脂", "总胆固醇 5.3 mmol/L 参考范围 0-5.2"]);
});

test("rejects fabricated observations and canonicalizes valid evidence to the OCR line", async () => {
  await withReport(1, async ({ reportId, jobId }) => {
    const executor: AiExecutor = async () => {
      const normalized = normalizeAiExtraction({
        reportType: "laboratory",
        observations: [
          {
            itemName: "总胆固醇", resultText: "5.3", numericValue: 5.3, unit: "mmol/L",
            evidence: [{ pageNumber: 1, quote: "总胆固醇 5.3" }]
          },
          {
            itemName: "不存在指标", resultText: "99", numericValue: 99, unit: "mmol/L",
            evidence: [{ pageNumber: 1, quote: "不存在指标 99 mmol/L" }]
          }
        ]
      });
      return {
        provider: "test", model: "test", promptVersion: "test", ...normalized,
        rawResponseJson: "{}", promptTokens: 10, completionTokens: 5, elapsedMs: 1
      };
    };
    const execution = await executeAiExtractionPlan(jobId, reportId, executor);
    assert.deepEqual(execution.result.fields.observations.map((item) => item.itemName), ["总胆固醇"]);
    assert.equal(
      execution.result.fields.observations[0].evidence[0].quote,
      "总胆固醇 5.3 mmol/L 参考范围 0-5.2"
    );
    assert.equal(execution.result.evidenceValidation?.rejectedObservations, 1);
    assert.deepEqual(execution.result.evidenceValidation?.rejectedObservationSamples, [
      { itemName: "不存在指标", resultText: "99", pageNumbers: [1] },
    ]);
    assert.equal(execution.warningUnits, 1);
  }, () => ["血脂", "总胆固醇 5.3 mmol/L 参考范围 0-5.2"]);
});

test("tolerates minor OCR text errors while requiring the actual result cell value", async () => {
  await withReport(1, async ({ reportId, jobId }) => {
    const executor: AiExecutor = async () => {
      const normalized = normalizeAiExtraction({
        reportType: "laboratory",
        observations: [
          {
            itemName: "血红蛋白", resultText: "135", numericValue: 135, unit: "g/L",
            evidence: [{ pageNumber: 1, quote: "血红蛋白 135 g/L" }]
          },
          {
            itemName: "血红蛋白", resultText: "150", numericValue: 150, unit: "g/L",
            evidence: [{ pageNumber: 1, quote: "血红蛋白 150 g/L" }]
          }
        ]
      });
      return {
        provider: "test", model: "test", promptVersion: "test", ...normalized,
        rawResponseJson: "{}", promptTokens: 10, completionTokens: 5, elapsedMs: 1
      };
    };
    const execution = await executeAiExtractionPlan(jobId, reportId, executor);
    assert.deepEqual(
      execution.result.fields.observations.map((item) => [item.itemName, item.numericValue]),
      [["血红蛋白", 135]]
    );
    assert.equal(
      execution.result.fields.observations[0].evidence[0].quote,
      "血红旦白 | 135 | g/L | 115-150"
    );
    assert.equal(execution.result.evidenceValidation?.rejectedObservations, 1);
  }, () => ["血常规", "血红旦白 | 135 | g/L | 115-150"]);
});

// 真实回归：报告单表头/测量区常被规划器拼成「名：值 | 名：值」多格行，
// 结果区域必须取同格余量（身高：175.5cm）或侧别片段格（右踝：1.07），
// 不得串到下一格取来相邻项目的值；左右错配的值必须拒绝。
test("accepts same-cell name:value pairs and laterality cells in joined lines", async () => {
  await withReport(1, async ({ reportId, jobId }) => {
    const executor: AiExecutor = async () => {
      const normalized = normalizeAiExtraction({
        reportType: "checkup",
        observations: [
          {
            itemName: "身高", resultText: "175.5", numericValue: 175.5, unit: "cm",
            evidence: [{ pageNumber: 1, quote: "身高：175.5cm" }]
          },
          {
            itemName: "PWV（右）", resultText: "1315", numericValue: 1315, unit: "cm/s",
            evidence: [{ pageNumber: 1, quote: "右：1315" }]
          },
          {
            itemName: "PWV（左）", resultText: "1395", numericValue: 1395, unit: "cm/s",
            evidence: [{ pageNumber: 1, quote: "左：1395" }]
          },
          {
            itemName: "踝臂指数（右踝）", resultText: "1.07", numericValue: 1.07, unit: null,
            evidence: [{ pageNumber: 1, quote: "右踝：1.07" }]
          },
          {
            itemName: "踝臂指数（左踝）", resultText: "1.08", numericValue: 1.08, unit: null,
            evidence: [{ pageNumber: 1, quote: "左踝：1.08" }]
          },
          // 左右错配：右踝的值不是 1.08，必须拒绝
          {
            itemName: "踝臂指数（右踝）", resultText: "1.08", numericValue: 1.08, unit: null,
            evidence: [{ pageNumber: 1, quote: "右踝：1.08" }]
          },
          // 幻觉值：身高不是 999
          {
            itemName: "身高", resultText: "999", numericValue: 999, unit: "cm",
            evidence: [{ pageNumber: 1, quote: "身高：999cm" }]
          }
        ]
      });
      return {
        provider: "test", model: "test", promptVersion: "test", ...normalized,
        rawResponseJson: "{}", promptTokens: 10, completionTokens: 5, elapsedMs: 1
      };
    };
    const execution = await executeAiExtractionPlan(jobId, reportId, executor);
    assert.deepEqual(
      execution.result.fields.observations.map((item) => [item.itemName, item.numericValue]),
      [
        ["身高", 175.5],
        ["PWV（右）", 1315],
        ["PWV（左）", 1395],
        ["踝臂指数（右踝）", 1.07],
        ["踝臂指数（左踝）", 1.08],
        // 规划器本地提取从同一拼接行解析出的正确补充
        ["体重", 76.7],
        ["体重指数", 24.9]
      ]
    );
    assert.deepEqual(
      execution.result.fields.observations[3].evidence[0].quote,
      "右踝：1.07 | 左踝：1.08"
    );
    assert.deepEqual(
      execution.result.evidenceValidation?.rejectedObservationSamples?.map(
        (sample) => [sample.itemName, sample.resultText]
      ),
      [["踝臂指数（右踝）", "1.08"], ["身高", "999"]]
    );
  }, () => [
    "动脉阻塞与僵硬度检测报告单",
    "动脉阻塞与僵硬度检测报告单 | 身高：175.5cm | 体重：76.7kg | BMI:24.9",
    "右：1315 | 左：1395 | 2000 | PWV(cm/s) | LD | 血管模型",
    "右踝：1.07 | 左踝：1.08",
    `说明 ${"内容".repeat(450)}`
  ]);
});

// 真实回归：名称在提示行、测量值在描述行且描述句被 OCR 断行时，带尺寸的形态发现不得被拒
test("keeps a measured morphology finding when name and measurement sit on different OCR lines", async () => {
  await withReport(1, async ({ reportId, jobId }) => {
    const executor: AiExecutor = async (input) => {
      const normalized = normalizeAiExtraction(
        input.extractionMode === "morphology" || input.promptMode === "supplement"
          ? {
              reportType: "ultrasound",
              morphologyFindings: [
                {
                  sectionName: "超声提示",
                  organ: "肝脏",
                  region: "右叶",
                  laterality: "right",
                  findingType: "钙化灶",
                  findingName: "肝右叶局灶性钙化灶",
                  presence: "present",
                  size: { length: 5, width: null, height: null, unit: "mm" },
                  rawText: "肝右叶局灶性钙化灶",
                  evidence: [{ pageNumber: 1, quote: "肝右叶局灶性钙化灶" }]
                },
                {
                  sectionName: "超声提示",
                  organ: "肝脏",
                  laterality: "unspecified",
                  findingType: "囊肿",
                  findingName: "肝囊肿",
                  presence: "present",
                  size: { length: 99, width: null, height: null, unit: "mm" },
                  rawText: "肝囊肿",
                  evidence: [{ pageNumber: 1, quote: "肝囊肿" }]
                }
              ]
            }
          : { reportType: "ultrasound" }
      );
      return {
        provider: "test",
        model: "test",
        promptVersion: "test",
        ...normalized,
        rawResponseJson: "{}",
        promptTokens: 10,
        completionTokens: 5,
        elapsedMs: 1
      };
    };
    const execution = await executeAiExtractionPlan(jobId, reportId, executor);
    const kept = execution.result.fields.morphologyFindings;
    const calcification = kept.find((item) => item.findingName.includes("钙化灶"));
    assert.equal(calcification?.size.length, 5, JSON.stringify(kept));
    assert.equal(
      kept.some((item) => item.findingName.includes("囊肿")),
      false,
      "文中不存在的发现仍应被拒绝"
    );
  }, () => [
    "超声描述：",
    "肝脏形态大小正常，实质回声细腻，稍增强，血管纹理清晰。肝右叶见强回声区，直径约5mm，后方无声影，未见胆",
    "管扩张。CDFI：未见明显异常血流信号。",
    "超声提示：",
    "肝右叶局灶性钙化灶"
  ]);
});

test("supplements a composite ultrasound detail and deterministically restores the calcification diameter", async () => {
  await withReport(1, async ({ reportId, jobId }) => {
    const detail =
      "肝脏形态大小正常，实质回声细腻，稍增强，考虑轻度脂肪肝。肝右叶见强回声区，直径约5mm，后方无声影，未见胆管扩张。CDFI：未见明显异常血流信号。";
    const supplementSources: string[] = [];
    const executor: AiExecutor = async (input) => {
      const isSupplement = input.promptMode === "supplement";
      if (isSupplement) {
        supplementSources.push(
          ...(input.candidateFacts || []).map((fact) => fact.sourceText),
        );
      }
      const normalized = normalizeAiExtraction(
        isSupplement
          ? {
              reportType: "ultrasound",
              morphologyFindings: [
                {
                  sectionName: "超声检查",
                  organ: "肝脏",
                  region: "右叶",
                  laterality: "right",
                  findingType: "钙化灶",
                  findingName: "肝右叶局灶性钙化灶",
                  presence: "present",
                  rawText: "肝右叶局灶性钙化灶",
                  evidence: [
                    { pageNumber: 1, quote: "肝右叶局灶性钙化灶" },
                  ],
                },
              ],
            }
          : input.extractionMode === "morphology"
            ? {
                reportType: "ultrasound",
                morphologyFindings: [
                  {
                    sectionName: "超声检查",
                    organ: "肝脏",
                    laterality: "unspecified",
                    findingType: "脂肪肝",
                    findingName: "脂肪肝（轻度）",
                    presence: "present",
                    rawText: detail,
                    evidence: [{ pageNumber: 1, quote: detail }],
                  },
                ],
              }
            : { reportType: "ultrasound" },
      );
      return {
        provider: "test",
        model: "test",
        promptVersion: "test",
        ...normalized,
        rawResponseJson: "{}",
        promptTokens: 10,
        completionTokens: 5,
        elapsedMs: 1,
      };
    };

    const execution = await executeAiExtractionPlan(jobId, reportId, executor);
    assert.equal(
      supplementSources.includes(detail),
      true,
      JSON.stringify(
        buildAiExtractionPlan(reportId).pages[0].lines.map((line) => ({
          text: line.text,
          kind: line.candidateKind,
          reason: line.candidateResolutionReason,
        })),
      ),
    );
    const calcifications = execution.result.fields.morphologyFindings.filter(
      (item) => item.findingName.includes("钙化"),
    );
    assert.equal(calcifications.length, 1);
    assert.deepEqual(calcifications[0].size, {
      length: 5,
      width: null,
      height: null,
      unit: "mm",
    });
    assert.equal(
      calcifications[0].measurements.some(
        (item) => item.key === "直径" && item.value === 5 && item.unit === "mm",
      ),
      true,
    );
    assert.deepEqual(
      calcifications[0].evidence.map((item) => item.quote),
      ["肝右叶局灶性钙化灶", detail],
    );
    const fattyLiver = execution.result.fields.morphologyFindings.find((item) =>
      item.findingName.includes("脂肪肝"),
    );
    assert.equal(fattyLiver?.size.length, null);
  }, () => [
    "超声检查",
    "肝脏形态大小正常，实质回声细腻，稍增强，考虑轻度脂肪肝。肝右叶见强回声区，直径约5mm，后方无声影，未见胆管扩张。CDFI：未见明显异常血流信号。",
    "检查结论",
    "脂肪肝（轻度）",
    "肝右叶局灶性钙化灶",
  ]);
});

test("keeps morphology size empty when two same-location detail candidates are ambiguous", async () => {
  await withReport(1, async ({ reportId, jobId }) => {
    const executor: AiExecutor = async (input) => {
      const normalized = normalizeAiExtraction(
        input.extractionMode === "morphology" || input.promptMode === "supplement"
          ? {
              reportType: "ultrasound",
              morphologyFindings: [
                {
                  sectionName: "超声检查",
                  organ: "肝脏",
                  region: "右叶",
                  laterality: "right",
                  findingType: "钙化灶",
                  findingName: "肝右叶局灶性钙化灶",
                  presence: "present",
                  rawText: "肝右叶局灶性钙化灶",
                  evidence: [
                    { pageNumber: 1, quote: "肝右叶局灶性钙化灶" },
                  ],
                },
              ],
            }
          : { reportType: "ultrasound" },
      );
      return {
        provider: "test",
        model: "test",
        promptVersion: "test",
        ...normalized,
        rawResponseJson: "{}",
        promptTokens: 10,
        completionTokens: 5,
        elapsedMs: 1,
      };
    };

    const execution = await executeAiExtractionPlan(jobId, reportId, executor);
    const calcification = execution.result.fields.morphologyFindings.find(
      (item) => item.findingName.includes("钙化"),
    );
    assert.equal(calcification?.size.length, null);
    assert.deepEqual(calcification?.measurements, []);
  }, () => [
    "超声检查",
    "肝右叶见强回声区，直径约5mm，后方无声影。",
    "肝右叶另见强回声区，直径约8mm，后方无声影。",
    "检查结论",
    "肝右叶局灶性钙化灶",
  ]);
});

test("tolerates minor morphology OCR errors but rejects fabricated measurements", async () => {
  await withReport(1, async ({ reportId, jobId }) => {
    const executor: AiExecutor = async () => {
      const normalized = normalizeAiExtraction({
        reportType: "ultrasound",
        morphologyFindings: [
          {
            sectionName: "超声检查", organ: "右肾", findingType: "囊肿", findingName: "右肾囊肿",
            presence: "present", size: { length: 8, width: 6, unit: "mm" },
            rawText: "右肾囊肿，大小约 8×6 mm",
            evidence: [{ pageNumber: 1, quote: "右肾囊肿，大小约 8×6 mm" }]
          },
          {
            sectionName: "超声检查", organ: "右肾", findingType: "囊肿", findingName: "右肾囊肿",
            presence: "present", size: { length: 8, width: 7, unit: "mm" },
            rawText: "右肾囊肿，大小约 8×7 mm",
            evidence: [{ pageNumber: 1, quote: "右肾囊肿，大小约 8×7 mm" }]
          }
        ]
      });
      return {
        provider: "test", model: "test", promptVersion: "test", ...normalized,
        rawResponseJson: "{}", promptTokens: 10, completionTokens: 5, elapsedMs: 1
      };
    };
    const execution = await executeAiExtractionPlan(jobId, reportId, executor);
    assert.equal(execution.result.fields.morphologyFindings.length, 1);
    assert.equal(execution.result.fields.morphologyFindings[0].findingName, "右肾囊肿");
    assert.equal(
      execution.result.fields.morphologyFindings[0].evidence[0].quote,
      "右贤囊肿，大小约 8x6 mm"
    );
    assert.ok((execution.result.evidenceValidation?.rejectedMorphologyFindings || 0) >= 1);
  }, () => ["超声检查", "右贤囊肿，大小约 8x6 mm"]);
});

test("passes dictionary facts and keeps scalar and morphology main output in separate calls", async () => {
  await withReport(1, async ({ reportId, jobId }) => {
    const calls: Array<{ mode: string | undefined; candidates: number }> = [];
    const executor: AiExecutor = async (input) => {
      calls.push({ mode: input.extractionMode, candidates: input.candidateFacts?.length || 0 });
      const normalized = normalizeAiExtraction(input.extractionMode === "morphology" ? {
        morphologyFindings: [{
          sectionName: "超声检查",
          organ: "右肾",
          findingType: "囊肿",
          findingName: "右肾囊肿",
          presence: "present",
          rawText: "右肾见囊肿，大小约 8×6 mm",
          evidence: [{ pageNumber: 1, quote: "右肾见囊肿，大小约 8×6 mm" }]
        }],
        observations: [{
          itemName: "错误注入指标", resultText: "1",
          evidence: [{ pageNumber: 1, quote: "右肾见囊肿，大小约 8×6 mm" }]
        }]
      } : {
        observations: [{
          itemName: "总胆固醇", resultText: "5.3", numericValue: 5.3, unit: "mmol/L",
          evidence: [{ pageNumber: 1, quote: "总胆固醇 5.3 mmol/L 参考范围 0-5.2" }]
        }],
        morphologyFindings: [{
          findingType: "错误形态", findingName: "错误形态",
          rawText: "总胆固醇 5.3 mmol/L 参考范围 0-5.2",
          evidence: [{ pageNumber: 1, quote: "总胆固醇 5.3 mmol/L 参考范围 0-5.2" }]
        }]
      });
      return {
        provider: "test", model: "test", promptVersion: "test", ...normalized,
        rawResponseJson: "{}", promptTokens: 10, completionTokens: 5, elapsedMs: 1
      };
    };
    const execution = await executeAiExtractionPlan(jobId, reportId, executor);
    assert.deepEqual(calls.map((call) => call.mode), ["scalar", "morphology"]);
    assert.ok(calls.every((call) => call.candidates > 0));
    assert.deepEqual(execution.result.fields.observations.map((item) => item.itemName), ["总胆固醇"]);
    assert.deepEqual(execution.result.fields.morphologyFindings.map((item) => item.findingName), ["右肾囊肿"]);
    assert.equal(execution.result.evidenceValidation?.rejectedObservations, 1);
    assert.equal(execution.result.evidenceValidation?.rejectedMorphologyFindings, 0);
  }, () => [
    "血脂",
    "总胆固醇 5.3 mmol/L 参考范围 0-5.2",
    "超声检查",
    "右肾见囊肿，大小约 8×6 mm"
  ]);
});

test("consolidates scalar and morphology omissions into one final verification call", async () => {
  await withReport(1, async ({ reportId, jobId }) => {
    const supplementRoutes: Array<string | undefined> = [];
    const executor: AiExecutor = async (input) => {
      if (input.promptMode !== "supplement") {
        const normalized = normalizeAiExtraction({ reportType: "physical_exam" });
        return {
          provider: "test", model: "test", promptVersion: "test", ...normalized,
          rawResponseJson: "{}", promptTokens: 10, completionTokens: 5, elapsedMs: 1
        };
      }
      supplementRoutes.push(input.route);
      assert.deepEqual(
        [...new Set((input.candidateFacts || []).map((fact) => fact.kind))].sort(),
        ["morphology", "scalar"]
      );
      const normalized = normalizeAiExtraction({
        reportType: "physical_exam",
        observations: (input.candidateFacts || []).filter((fact) => fact.kind === "scalar").map((fact) => ({
          itemName: "总胆固醇",
          resultText: "5.3",
          numericValue: 5.3,
          unit: "mmol/L",
          evidence: [{ pageNumber: fact.pageNumber, quote: fact.sourceText }]
        })),
        morphologyFindings: (input.candidateFacts || []).filter((fact) => fact.kind === "morphology").map((fact) => ({
          sectionName: "超声检查",
          organ: "右肾",
          findingType: "囊肿",
          findingName: "右肾囊肿",
          presence: "present" as const,
          rawText: fact.sourceText,
          evidence: [{ pageNumber: fact.pageNumber, quote: fact.sourceText }]
        }))
      });
      return {
        provider: "test", model: "test", promptVersion: "test", ...normalized,
        rawResponseJson: "{}", promptTokens: 20, completionTokens: 10, elapsedMs: 1
      };
    };
    const execution = await executeAiExtractionPlan(jobId, reportId, executor);
    assert.deepEqual(supplementRoutes, ["verification"]);
    assert.deepEqual(execution.result.fields.observations.map((item) => item.itemName), ["总胆固醇"]);
    assert.deepEqual(execution.result.fields.morphologyFindings.map((item) => item.findingName), ["右肾囊肿"]);
    assert.equal(execution.unmatchedCandidates, 0);
  }, () => [
    "血脂",
    "总胆固醇 5.3 mmol/L 参考范围 0-5.2",
    "超声检查",
    "右肾见囊肿，大小约 8×6 mm"
  ]);
});

test("routes and persists prescription facts without a separate classification request", async () => {
  await withReport(1, async ({ reportId, jobId }) => {
    let calls = 0;
    const executor: AiExecutor = async (input) => {
      calls += 1;
      assert.equal(input.primaryContentType, "prescription");
      assert.deepEqual(input.contentTypes, ["prescription"]);
      assert.equal(input.documentContentType, "prescription");
      const normalized = normalizeAiExtraction({
        reportType: "prescription",
        title: "门诊处方笺",
        medications: [{
          context: "prescription",
          medicationName: "阿莫西林胶囊",
          specification: "0.25g",
          dose: "0.5",
          doseUnit: "g",
          frequency: "每日3次",
          route: "口服",
          quantity: "24",
          quantityUnit: "粒",
          p: 1,
          q: "阿莫西林胶囊 | 0.25g | 每次0.5g | 每日3次 | 口服 | 24粒"
        }]
      });
      return {
        provider: "test", model: "test", promptVersion: "test", ...normalized,
        rawResponseJson: "{}", promptTokens: 10, completionTokens: 5, elapsedMs: 1
      };
    };
    const execution = await executeAiExtractionPlan(jobId, reportId, executor);
    assert.equal(calls, 2);
    assert.equal(execution.result.fields.medications.length, 1);
    persistAiExtraction(reportId, jobId, execution.result, execution.inputCharacters);
    const medication = getDatabase().prepare(`
      SELECT medication_name AS medicationName, frequency, route
      FROM report_medications WHERE report_id = ?
    `).get(reportId) as { medicationName: string; frequency: string; route: string };
    assert.deepEqual({ ...medication }, {
      medicationName: "阿莫西林胶囊",
      frequency: "每日3次",
      route: "口服"
    });
    const route = getDatabase().prepare(`
      SELECT r.primary_content_type AS primaryType, r.document_content_type AS documentType
      FROM ai_extraction_unit_routes r
      JOIN ai_extraction_units u ON u.id = r.unit_id
      WHERE u.job_id = ?
    `).get(jobId) as { primaryType: string; documentType: string };
    assert.deepEqual({ ...route }, { primaryType: "prescription", documentType: "prescription" });
  }, () => [
    "电子处方笺",
    "药品名称 | 规格 | 每次剂量 | 频次 | 给药途径 | 数量",
    "阿莫西林胶囊 | 0.25g | 每次0.5g | 每日3次 | 口服 | 24粒"
  ]);
});

test("routes and persists outpatient inpatient billing vaccination and pathology facts", async () => {
  const scenarios = [
    {
      type: "outpatient",
      lines: ["门诊病历", "门诊诊断：急性上呼吸道感染", "处置：雾化吸入治疗"],
      fields: {
        reportType: "outpatient",
        diagnoses: [{ diagnosisType: "outpatient", diagnosisText: "急性上呼吸道感染", p: 1, q: "门诊诊断：急性上呼吸道感染" }],
        procedures: [{ procedureType: "treatment", procedureName: "雾化吸入治疗", p: 1, q: "处置：雾化吸入治疗" }],
        reportSections: [{ sectionKey: "outpatient_disposition", title: "处置", content: "雾化吸入治疗", p: 1, q: "处置：雾化吸入治疗" }]
      },
      verify: () => {
        assert.equal((getDatabase().prepare("SELECT COUNT(*) AS count FROM report_diagnoses").get() as { count: number }).count, 1);
        assert.equal((getDatabase().prepare("SELECT COUNT(*) AS count FROM report_procedures").get() as { count: number }).count, 1);
        assert.equal((getDatabase().prepare("SELECT COUNT(*) AS count FROM report_structured_sections").get() as { count: number }).count, 1);
      }
    },
    {
      type: "inpatient",
      lines: ["出院小结", "出院诊断：社区获得性肺炎", "出院用药：阿莫西林胶囊"],
      fields: {
        reportType: "inpatient",
        diagnoses: [{ diagnosisType: "discharge", diagnosisText: "社区获得性肺炎", p: 1, q: "出院诊断：社区获得性肺炎" }],
        medications: [{ context: "discharge", medicationName: "阿莫西林胶囊", p: 1, q: "出院用药：阿莫西林胶囊" }],
        reportSections: [{ sectionKey: "inpatient_discharge_instructions", title: "出院医嘱", content: "按时复诊", p: 1, q: "出院用药：阿莫西林胶囊" }]
      },
      verify: () => {
        assert.equal((getDatabase().prepare("SELECT COUNT(*) AS count FROM report_diagnoses").get() as { count: number }).count, 1);
        assert.equal((getDatabase().prepare("SELECT COUNT(*) AS count FROM report_medications").get() as { count: number }).count, 1);
      }
    },
    {
      type: "billing",
      lines: ["医疗收费票据", "票据号 INV-001", "总金额 128.00 元", "检验费 28.00 元"],
      fields: {
        reportType: "billing",
        billingSummary: { invoiceNumber: "INV-001", totalAmount: 128, currency: "CNY", p: 1, q: "总金额 128.00 元" },
        billingItems: [{ itemName: "检验费", category: "检验", amount: 28, p: 1, q: "检验费 28.00 元" }]
      },
      verify: () => {
        assert.equal((getDatabase().prepare("SELECT total_amount AS total FROM billing_summaries").get() as { total: number }).total, 128);
        assert.equal((getDatabase().prepare("SELECT COUNT(*) AS count FROM billing_items").get() as { count: number }).count, 1);
      }
    },
    {
      type: "vaccination",
      lines: ["预防接种记录", "流感疫苗 第1剂", "接种部位：左上臂"],
      fields: {
        reportType: "vaccination",
        vaccinations: [{ vaccineName: "流感疫苗", doseNumber: "第1剂", administrationSite: "左上臂", p: 1, q: "流感疫苗 第1剂" }]
      },
      verify: () => {
        assert.equal((getDatabase().prepare("SELECT COUNT(*) AS count FROM vaccination_records").get() as { count: number }).count, 1);
      }
    },
    {
      type: "pathology",
      lines: ["病理报告", "病理诊断：结肠腺瘤", "免疫组化：Ki-67 约5%"],
      fields: {
        reportType: "pathology",
        diagnoses: [{ diagnosisType: "pathology", diagnosisText: "结肠腺瘤", p: 1, q: "病理诊断：结肠腺瘤" }],
        reportSections: [{ sectionKey: "pathology_immunohistochemistry", title: "免疫组化", content: "Ki-67 约5%", p: 1, q: "免疫组化：Ki-67 约5%" }]
      },
      verify: () => {
        assert.equal((getDatabase().prepare("SELECT diagnosis_type AS type FROM report_diagnoses").get() as { type: string }).type, "pathology");
        assert.equal((getDatabase().prepare("SELECT section_key AS key FROM report_structured_sections").get() as { key: string }).key, "pathology_immunohistochemistry");
      }
    }
  ] as const;

  for (const scenario of scenarios) {
    await withReport(1, async ({ reportId, jobId }) => {
      let routed = false;
      const executor: AiExecutor = async (input) => {
        if (input.extractionMode === "scalar") {
          routed = true;
          assert.equal(input.primaryContentType, scenario.type);
        }
        const normalized = normalizeAiExtraction(input.extractionMode === "scalar" ? scenario.fields : {});
        return {
          provider: "test", model: "test", promptVersion: "test", ...normalized,
          rawResponseJson: "{}", promptTokens: 10, completionTokens: 5, elapsedMs: 1
        };
      };
      const execution = await executeAiExtractionPlan(jobId, reportId, executor);
      assert.equal(routed, true);
      persistAiExtraction(reportId, jobId, execution.result, execution.inputCharacters);
      scenario.verify();
    }, () => [...scenario.lines]);
  }
});

test("rejects outpatient sections inferred from composite checkup table labels", async () => {
  await withReport(2, async ({ reportId, jobId }) => {
    let narrativeCalls = 0;
    const executor: AiExecutor = async (input) => {
      const fields = input.route === "narrative" ? {
        reportSections: [
          {
            sectionKey: "outpatient_history",
            title: "病史",
            content: "主诉 | 无特殊",
            p: 2,
            q: "主诉 | 无特殊"
          },
          {
            sectionKey: "outpatient_physical_examination",
            title: "体格检查",
            content: "营养 | 营养良好 | 营养良好",
            p: 2,
            q: "营养 | 营养良好 | 营养良好"
          }
        ]
      } : { reportType: "physical_exam", title: "个人健康体检报告" };
      if (input.route === "narrative") narrativeCalls += 1;
      const normalized = normalizeAiExtraction(fields);
      return {
        provider: "test", model: "test", promptVersion: aiExtractionPromptVersion,
        ...normalized, rawResponseJson: "{}", promptTokens: 10,
        completionTokens: 5, elapsedMs: 1
      };
    };
    const execution = await executeAiExtractionPlan(jobId, reportId, executor);
    assert.ok(narrativeCalls > 0);
    assert.deepEqual(execution.result.fields.reportSections, []);
    assert.equal(execution.result.evidenceValidation?.rejectedStructuredSections, 2);
    persistAiExtraction(reportId, jobId, execution.result, execution.inputCharacters);
    const stored = getDatabase().prepare(`
      SELECT COUNT(*) AS count FROM report_structured_sections WHERE report_id = ?
    `).get(reportId) as { count: number };
    assert.equal(stored.count, 0);
  }, (pageNumber) => pageNumber === 1 ? [
    "个人健康体检报告",
    "总检结论：本次体检完成"
  ] : [
    "主诉 | 无特殊",
    "个人史 | 无特殊",
    "体格检查",
    "营养 | 营养良好 | 营养良好"
  ]);
});

test("keeps every deterministic observation from one multi-value row while auditing the row once", async () => {
  await withReport(1, async ({ reportId, jobId }) => {
    const calls: Array<{ mode: string | undefined; candidateCount: number }> = [];
    const executor: AiExecutor = async (input) => {
      calls.push({ mode: input.promptMode, candidateCount: input.candidateFacts?.length || 0 });
      const normalized = normalizeAiExtraction({ reportType: "physical_exam", observations: [] });
      return {
        provider: "test", model: "test", promptVersion: "test", ...normalized,
        rawResponseJson: "{}", promptTokens: 10, completionTokens: 5, elapsedMs: 1
      };
    };

    const execution = await executeAiExtractionPlan(jobId, reportId, executor);
    const local = execution.result.fields.observations.filter((item) =>
      item.normalizedName === "身高" || item.normalizedName === "体重"
    );

    assert.deepEqual(local.map((item) => item.normalizedName).sort(), ["体重", "身高"]);
    assert.equal(new Set(local.map((item) => `${item.normalizedName}:${item.numericValue}`)).size, 2);
    assert.equal(execution.plan.localObservationCount, 2);
    assert.equal(execution.unmatchedCandidates, 0);
    assert.equal(calls.some((call) => call.mode === "supplement"), false);
    assert.equal(calls.every((call) => call.candidateCount === 0), true);

    persistAiExtraction(reportId, jobId, execution.result, execution.inputCharacters);
    persistAiExtraction(reportId, jobId, execution.result, execution.inputCharacters);
    const stored = getDatabase().prepare(`
      SELECT normalized_name AS normalizedName, numeric_value AS numericValue, evidence_json AS evidenceJson
      FROM observations WHERE report_id = ? ORDER BY normalized_name
    `).all(reportId) as Array<{ normalizedName: string; numericValue: number; evidenceJson: string }>;
    assert.deepEqual(stored.map((item) => [item.normalizedName, item.numericValue]), [
      ["体重", 65], ["身高", 170]
    ]);
    assert.equal(stored.every((item) => JSON.parse(item.evidenceJson).length === 1), true);

    const candidates = getDatabase().prepare(`
      SELECT status, matched_entity_key AS matchedEntityKey, reason
      FROM ai_extraction_candidates WHERE job_id = ?
    `).all(jobId) as Array<{ status: string; matchedEntityKey: string | null; reason: string | null }>;
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].status, "local_extracted");
    assert.match(candidates[0].matchedEntityKey || "", /身高/);
    assert.match(candidates[0].matchedEntityKey || "", /体重/);
    assert.match(candidates[0].reason || "", /拆分 2 项/);
  }, () => [
    "身高: 170 cm | 体重: 65 kg"
  ]);
});

test("reconciles a combined blood-pressure summary with both deterministic component observations", async () => {
  await withReport(1, async ({ reportId, jobId }) => {
    let supplementCalls = 0;
    const executor: AiExecutor = async (input) => {
      if (input.promptMode === "supplement") supplementCalls += 1;
      const normalized = normalizeAiExtraction({ reportType: "physical_exam", observations: [] });
      return {
        provider: "test", model: "test", promptVersion: "test", ...normalized,
        rawResponseJson: "{}", promptTokens: 10, completionTokens: 5, elapsedMs: 1
      };
    };
    const execution = await executeAiExtractionPlan(jobId, reportId, executor);
    const names = execution.result.fields.observations.map((item) => item.itemName).sort();
    const candidate = getDatabase().prepare(`
      SELECT status, reason FROM ai_extraction_candidates
      WHERE job_id = ? AND status = 'redundant'
    `).get(jobId) as { status: string; reason: string };

    assert.deepEqual(names, ["收缩压", "舒张压"]);
    assert.equal(supplementCalls, 0);
    assert.equal(execution.unmatchedCandidates, 0);
    assert.equal(candidate.status, "redundant");
    assert.match(candidate.reason, /^duplicate_evidence:/);
  }, () => [
    "一般检查",
    "项目 | 结果 | 单位 | 参考范围",
    "收缩压 | 132 | mmHg | 90-140",
    "舒张压 | 86 | mmHg | 60-90",
    "异常结果与健康建议",
    "血压值 132/86 mmHg；建议保持规律作息。"
  ]);
});


test("persists locally verified table evidence for pulmonary actual values and rejects AI-forged column provenance", async () => {
  await withReport(1, async ({ reportId, jobId }) => {
    const executor: AiExecutor = async () => {
      const normalized = normalizeAiExtraction({
        reportType: "functional",
        observations: []
      });
      return {
        provider: "test",
        model: "test",
        promptVersion: aiExtractionPromptVersion,
        ...normalized,
        rawResponseJson: "{}",
        promptTokens: 10,
        completionTokens: 5,
        elapsedMs: 1
      };
    };
    const execution = await executeAiExtractionPlan(jobId, reportId, executor);
    const pulmonary = execution.result.fields.observations.find(
      (item) => item.itemName === "FVC" || item.normalizedName?.includes("FVC")
    );

    assert.ok(pulmonary);
    assert.equal(pulmonary.numericValue, 3.21);
    assert.notEqual(pulmonary.numericValue, 3.8);
    pulmonary.evidence = pulmonary.evidence.map((evidence) => ({
      ...evidence,
      table: {
        headerText: "伪造表头",
        headerSourceLineIds: ["forged-header"],
        rowSourceLineIds: ["forged-row"],
        resultColumn: {
          index: 2,
          headerText: "预测",
          selectionBasis: "local_source_map"
        }
      }
    }));

    persistAiExtraction(
      reportId,
      jobId,
      execution.result,
      execution.inputCharacters
    );
    const stored = getDatabase().prepare(`
      SELECT item_name AS itemName, numeric_value AS numericValue,
        evidence_json AS evidenceJson
      FROM observations
      WHERE report_id = ?
    `).all(reportId) as Array<{
      itemName: string;
      numericValue: number;
      evidenceJson: string;
    }>;

    assert.equal(stored.length, 1);
    assert.equal(stored[0].numericValue, 3.21);
    const evidence = JSON.parse(stored[0].evidenceJson) as Array<{
      pageNumber: number;
      quote: string;
      table?: {
        headerText: string;
        headerSourceLineIds: string[];
        rowSourceLineIds: string[];
        resultColumn: {
          index: number;
          headerText: string | null;
          selectionBasis: string;
        } | null;
        sourceMap?: {
          result: {
            cellIndices: number[];
            headerText?: string;
          };
        };
      };
    }>;
    assert.equal(evidence.length, 1);
    assert.equal(evidence[0].table?.headerText, "项目 | 实测 | 预测 | %预测");
    assert.deepEqual(evidence[0].table?.headerSourceLineIds, ["page-1-line-2"]);
    assert.deepEqual(evidence[0].table?.rowSourceLineIds, ["page-1-line-3"]);
    assert.equal(evidence[0].table?.resultColumn?.index, 1);
    assert.equal(evidence[0].table?.resultColumn?.headerText, "实测");
    assert.equal(
      evidence[0].table?.resultColumn?.selectionBasis,
      "explicit_current_result_header"
    );
    assert.deepEqual(evidence[0].table?.sourceMap?.result.cellIndices, [1]);
    assert.equal(evidence[0].table?.sourceMap?.result.headerText, "实测");
  }, () => [
    "肺功能",
    "项目 | 实测 | 预测 | %预测",
    "FVC | 3.21 | 3.80 | 84.5"
  ]);
});
