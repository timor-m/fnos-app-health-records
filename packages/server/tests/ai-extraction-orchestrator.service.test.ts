import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { closeDatabaseForTests, getDatabase } from "../database/client.ts";
import {
  aiExtractionExecutionPolicy,
  detectTableSerialGapPages,
  executeAiExtractionPlan,
  mergeAiExtractionResults,
  visionReviewCandidates
} from "../services/ai-extraction-orchestrator.service.ts";
import { buildAiExtractionPlan, type AiExtractionPlan, type PlannedOcrLine } from "../services/ai-input-planner.service.ts";
import { listProcessingJobs } from "../services/upload.service.ts";
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

test('paired project groups accept their own AI results and reject cross-group substitutions', async () => {
  await withReport(1, async ({ reportId, jobId }) => {
    const raw = [
      ['项目名称', '', '结果', '单位', '参考区间', '项目名称', '结果', '单位', '参考区间'],
      ['合成项目甲', '【深圳HR】', '12', 'U/L', '0-30', '合成项目乙', '24', 'mg/L', '0-40'],
    ].flatMap((cells, row) => cells.flatMap((text, column) => text ? [{
      id: `row-${row}-${column}`, text, confidence: .99,
      box: [column * 200, row * 40, column * 200 + 100, row * 40 + 20],
      tableCell: { table: 'table_0', row, column, columns: 9 },
    }] : []));
    getDatabase().prepare('UPDATE ocr_results SET lines_json = ?').run(JSON.stringify(raw));
    const executor: AiExecutor = async () => ({
      provider: 'test', model: 'test', promptVersion: 'test',
      ...normalizeAiExtraction({ observations: [
        { itemName: '合成项目甲', resultText: '12', numericValue: 12, unit: 'U/L', evidence: [{ pageNumber: 1, quote: '合成项目甲 12 U/L' }] },
        { itemName: '合成项目乙', resultText: '24', numericValue: 24, unit: 'mg/L', evidence: [{ pageNumber: 1, quote: '合成项目乙 24 mg/L' }] },
        { itemName: '合成项目甲', resultText: '24', numericValue: 24, unit: 'U/L', evidence: [{ pageNumber: 1, quote: '合成项目甲 24 U/L' }] },
      ] }),
      rawResponseJson: '{}', promptTokens: 1, completionTokens: 1, elapsedMs: 1,
    });
    const execution = await executeAiExtractionPlan(jobId, reportId, executor);
    assert.equal(execution.result.fields.observations.length, 2);
    assert.ok((execution.result.evidenceValidation?.rejectedObservations || 0) >= 1);
    assert.equal(execution.result.fields.observations.find(item => item.itemName === '合成项目甲')?.numericValue, 12);
  });
});

test('overview mode backfills candidates when the main pass returns nothing', async () => {
  await withReport(1, async ({ reportId, jobId }) => {
    getDatabase().prepare("UPDATE app_settings SET value_json = '{\"extractionDepth\":\"overview\"}' WHERE setting_key = 'ai.provider'").run();
    let calls = 0;
    const executor: AiExecutor = async (input) => {
      calls += 1;
      const supplement = input.text.includes("遗漏候选补提取");
      return {
        provider: 'test', model: 'test', promptVersion: 'test',
        ...normalizeAiExtraction(supplement ? {
          observations: [{ itemName: '神经元特异性烯醇化酶', resultText: '12.5', numericValue: 12.5, unit: 'ng/mL', evidence: [{ pageNumber: 1, quote: '神经元特异性烯醇化酶 12.5 ng/mL 参考范围 0-16.3' }] }],
        } : {}),
        rawResponseJson: '{}', promptTokens: 1, completionTokens: 1, elapsedMs: 1,
      };
    };
    const execution = await executeAiExtractionPlan(jobId, reportId, executor);
    assert.equal(calls, 2);
    assert.equal(execution.plan.units.some((unit) => unit.unitType === 'supplement'), true);
    assert.equal(execution.result.fields.observations.length, 1);
    assert.equal(execution.result.fields.observations[0]?.itemName, '神经元特异性烯醇化酶');
  }, () => ['肿瘤标志物检测', '神经元特异性烯醇化酶 12.5 ng/mL 参考范围 0-16.3', `备注 ${'内容'.repeat(200)}`]);
});

test('overview mode skips supplements when the main pass extracted observations', async () => {
  await withReport(1, async ({ reportId, jobId }) => {
    getDatabase().prepare("UPDATE app_settings SET value_json = '{\"extractionDepth\":\"overview\"}' WHERE setting_key = 'ai.provider'").run();
    let calls = 0;
    const executor: AiExecutor = async (input) => {
      calls += 1;
      return {
        provider: 'test', model: 'test', promptVersion: 'test',
        ...normalizeAiExtraction({
          observations: [{ itemName: '神经元特异性烯醇化酶', resultText: '12.5', numericValue: 12.5, unit: 'ng/mL', evidence: [{ pageNumber: 1, quote: '神经元特异性烯醇化酶 12.5 ng/mL 参考范围 0-16.3' }] }],
        }),
        rawResponseJson: '{}', promptTokens: 1, completionTokens: 1, elapsedMs: 1,
      };
    };
    const execution = await executeAiExtractionPlan(jobId, reportId, executor);
    assert.equal(calls, 1);
    assert.equal(execution.plan.units.some((unit) => unit.unitType === 'supplement'), false);
    assert.equal(execution.result.fields.observations.length, 1);
  }, () => ['肿瘤标志物检测', '神经元特异性烯醇化酶 12.5 ng/mL 参考范围 0-16.3', `备注 ${'内容'.repeat(200)}`]);
});

test('recovered header rows pass evidence validation but reference substitutions do not', async () => {
  await withReport(1, async ({ reportId, jobId }) => {
    const raw = [
      ['缩写', '项目名称', '结果', '单位', '参考区间', '方法学'],
      ...Array.from({ length: 20 }, (_, i) => [`S${i}`, `合成检测项${i}`, String(i + 1), 'U/L', '0-99', '方法甲']),
    ].flatMap((cells, row) => cells.map((text, column) => ({
      id: `row-${row}-${column}`, text, confidence: .99, tableUnsafe: true,
      box: [column * 200, row * 40, column * 200 + 100, row * 40 + 20],
    })));
    getDatabase().prepare('UPDATE ocr_results SET lines_json = ?').run(JSON.stringify(raw));
    const executor: AiExecutor = async () => ({
      provider: 'test', model: 'test', promptVersion: 'test',
      ...normalizeAiExtraction({ observations: [
        ...Array.from({ length: 20 }, (_, i) => ({ itemName: `合成检测项${i}`, resultText: String(i + 1), numericValue: i + 1, unit: 'U/L',
          evidence: [{ pageNumber: 1, quote: `合成检测项${i} ${i + 1} U/L` }] })),
        { itemName: '合成检测项0', resultText: '99', numericValue: 99, unit: 'U/L', evidence: [{ pageNumber: 1, quote: '合成检测项0 0-99' }] },
      ] }),
      rawResponseJson: '{}', promptTokens: 1, completionTokens: 1, elapsedMs: 1,
    });
    const execution = await executeAiExtractionPlan(jobId, reportId, executor);
    assert.equal(execution.result.fields.observations.length, 20);
    assert.ok((execution.result.evidenceValidation?.rejectedObservations || 0) >= 1);
    assert.equal(execution.result.fields.observations.some(item => item.numericValue === 99), false);
  });
});

test('unsafe table rows accept AI evidence only when the quote anchors to the line', async () => {
  await withReport(1, async ({ reportId, jobId }) => {
    // 表格结构识别 partial 且无坐标可恢复：行保持 tableUnsafe。
    // 引文逐字锚定到该行的放行；名称结果命中但引文锚不上的仍拒绝。
    const rows = [
      '检测指标 | 结果 | 参考值',
      '★谷丙转氨酶 | 98(U/L)↑ | (0-40)',
      '总胆红素 | 13.3 (umol/L) | (3.4-20.5)',
      '★谷草转氨酶 | 53.3(U/L）↑ | (0-40)',
    ];
    const raw = rows.map((text, index) => ({
      id: `line-${index + 1}`, text, confidence: .99, tableUnsafe: true,
    }));
    getDatabase().prepare('UPDATE ocr_results SET lines_json = ?').run(JSON.stringify(raw));
    const executor: AiExecutor = async (input) => ({
      provider: 'test', model: 'test', promptVersion: 'test',
      ...normalizeAiExtraction(input.promptMode === 'supplement' ? {} : { observations: [
        { itemName: '谷丙转氨酶', resultText: '98', numericValue: 98, unit: 'U/L',
          evidence: [{ pageNumber: 1, quote: '★谷丙转氨酶 | 98(U/L)↑ | (0-40)' }] },
        { itemName: '总胆红素', resultText: '13.3', numericValue: 13.3, unit: 'umol/L',
          evidence: [{ pageNumber: 1, quote: '总胆红素 | 13.3 (umol/L) | (3.4-20.5)' }] },
        { itemName: '谷草转氨酶', resultText: '53.3', numericValue: 53.3, unit: 'U/L',
          evidence: [{ pageNumber: 1, quote: '★总蛋白 | 76.4(g/L) | (60-83)' }] },
      ] }),
      rawResponseJson: '{}', promptTokens: 1, completionTokens: 1, elapsedMs: 1,
    });
    const execution = await executeAiExtractionPlan(jobId, reportId, executor);
    const names = execution.result.fields.observations.map((item) => item.itemName);
    assert.ok(names.some((name) => name.includes('谷丙转氨酶')));
    assert.ok(names.some((name) => name.includes('总胆红素')));
    assert.ok(!names.some((name) => name.includes('谷草转氨酶')));
    assert.equal(execution.result.evidenceValidation?.rejectedObservations, 1);
  });
});

test('unsafe coordinate rows accept a detached result cell but reject a reference value', async () => {
  await withReport(1, async ({ jobId, reportId }) => {
    const cells = [
      { id: 'coord-name', text: '总胆固醇', box: [50, 100, 220, 125] },
      { id: 'coord-result', text: '5.3', box: [300, 100, 350, 125] },
      { id: 'coord-reference', text: '0-5.2', box: [450, 100, 540, 125] },
      { id: 'coord-unit', text: 'mmol/L', box: [650, 100, 730, 125] },
    ].map((line) => ({ ...line, confidence: .99, tableUnsafe: true }));
    getDatabase().prepare('UPDATE ocr_results SET lines_json = ?').run(JSON.stringify(cells));
    const executor: AiExecutor = async () => ({
      provider: 'test', model: 'test', promptVersion: 'test',
      ...normalizeAiExtraction({ observations: [
        { itemName: '总胆固醇', resultText: '5.3', numericValue: 5.3, unit: 'mmol/L',
          evidence: [{ pageNumber: 1, quote: '总胆固醇 5.3 mmol/L' }] },
        { itemName: '总胆固醇', resultText: '5.2', numericValue: 5.2, unit: 'mmol/L',
          evidence: [{ pageNumber: 1, quote: '总胆固醇 5.2 mmol/L' }] },
      ] }),
      rawResponseJson: '{}', promptTokens: 1, completionTokens: 1, elapsedMs: 1,
    });
    const execution = await executeAiExtractionPlan(jobId, reportId, executor);
    assert.equal(execution.result.fields.observations.length, 1);
    assert.equal(execution.result.fields.observations[0]?.numericValue, 5.3);
    assert.equal(execution.result.evidenceValidation?.rejectedObservations, 1);
  });
});

test('single-result headers allow coordinate recovery when text column mapping misses the result', async () => {
  await withReport(1, async ({ jobId, reportId }) => {
    const raw = [
      ['项目名称', '单位', '结果', '参考范围'],
      ['总胆固醇', '5.3', 'mmol/L', '0-5.2'],
    ].flatMap((row, rowIndex) => row.map((text, columnIndex) => ({
      id: `header-row-${rowIndex}-${columnIndex}`,
      text,
      confidence: .99,
      box: [50 + columnIndex * 180, 100 + rowIndex * 40, 150 + columnIndex * 180, 124 + rowIndex * 40],
    })));
    getDatabase().prepare('UPDATE ocr_results SET lines_json = ?').run(JSON.stringify(raw));
    const executor: AiExecutor = async () => ({
      provider: 'test', model: 'test', promptVersion: 'test',
      ...normalizeAiExtraction({ observations: [
        { itemName: '总胆固醇', resultText: '5.3', numericValue: 5.3, unit: 'mmol/L',
          evidence: [{ pageNumber: 1, quote: '总胆固醇 5.3 mmol/L' }] },
        { itemName: '总胆固醇', resultText: '5.2', numericValue: 5.2, unit: 'mmol/L',
          evidence: [{ pageNumber: 1, quote: '总胆固醇 5.2 mmol/L' }] },
      ] }),
      rawResponseJson: '{}', promptTokens: 1, completionTokens: 1, elapsedMs: 1,
    });
    const execution = await executeAiExtractionPlan(jobId, reportId, executor);
    assert.equal(execution.result.fields.observations.length, 1);
    assert.equal(execution.result.fields.observations[0]?.numericValue, 5.3);
    assert.equal(execution.result.evidenceValidation?.rejectedObservations, 1);
    persistAiExtraction(reportId, jobId, execution.result, execution.inputCharacters);
    const persisted = getDatabase().prepare(`
      SELECT numeric_value AS numericValue, evidence_json AS evidenceJson
      FROM observations WHERE report_id = ?
    `).all(reportId) as Array<{ numericValue: number; evidenceJson: string }>;
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0]?.numericValue, 5.3);
    assert.equal(JSON.parse(persisted[0]!.evidenceJson)[0].coordinateVerified, true);
  });
});

test('result cell units keep the full text instead of partial hardcoded matches', async () => {
  await withReport(1, async ({ reportId, jobId }) => {
    // 回归：硬编码单位清单缺少 umol/L，L/L 在 (umol/L) 内提前匹配导致落库为 l/L；
    // mmolL 是 OCR 丢斜杠形态，应矫正为 mmol/L。
    const rows = [
      '检测指标 | 结果 | 参考值',
      '★肌酐 | 82(umol/L) | (30-97)',
      '★尿酸 | 443(umol/L)↑ | (200-420)',
      '★甘油三酯 | 1.89(mmolL)↑ | (0.3-1.71)',
    ];
    const raw = rows.map((text, index) => ({
      id: `line-${index + 1}`, text, confidence: .99, tableUnsafe: true,
    }));
    getDatabase().prepare('UPDATE ocr_results SET lines_json = ?').run(JSON.stringify(raw));
    const executor: AiExecutor = async (input) => ({
      provider: 'test', model: 'test', promptVersion: 'test',
      ...normalizeAiExtraction(input.promptMode === 'supplement' ? {} : { observations: [
        { itemName: '肌酐', resultText: '82', numericValue: 82, unit: 'umol/L',
          evidence: [{ pageNumber: 1, quote: '★肌酐 | 82(umol/L) | (30-97)' }] },
        { itemName: '尿酸', resultText: '443', numericValue: 443, unit: 'umol/L',
          evidence: [{ pageNumber: 1, quote: '★尿酸 | 443(umol/L)↑ | (200-420)' }] },
        { itemName: '甘油三酯', resultText: '1.89', numericValue: 1.89, unit: 'mm',
          evidence: [{ pageNumber: 1, quote: '★甘油三酯 | 1.89(mmolL)↑ | (0.3-1.71)' }] },
      ] }),
      rawResponseJson: '{}', promptTokens: 1, completionTokens: 1, elapsedMs: 1,
    });
    const execution = await executeAiExtractionPlan(jobId, reportId, executor);
    const units = execution.result.fields.observations.map((item) => item.unit);
    assert.deepEqual(units, ['umol/L', 'umol/L', 'mmol/L']);
  });
});

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

test("fills business identifiers locally and persists a single checkup body part", async () => {
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
    assert.deepEqual(execution.result.fields.bodyParts, [{ raw: "综合体检", name: "综合体检", parent: null, laterality: "unspecified" }]);
    persistAiExtraction(reportId, jobId, execution.result, execution.inputCharacters);
    const stored = getDatabase().prepare(`
      SELECT body_parts_json AS bodyPartsJson, identifiers_json AS identifiersJson
      FROM reports WHERE id = ?
    `).get(reportId) as { bodyPartsJson: string; identifiersJson: string };
    assert.deepEqual(JSON.parse(stored.bodyPartsJson), [{ raw: "综合体检", name: "综合体检", parent: null, laterality: "unspecified" }]);
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

test("preserves uncertain OCR without guessing units, values or missing differential percentages", () => {
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

  assert.equal(byName.get("啫碱性粒细胞百分比(BASO%)")?.resultText, "8'0");
  assert.equal(byName.get("啫碱性粒细胞百分比(BASO%)")?.numericValue, null);
  assert.equal(byName.get("啫碱性粒细胞百分比(BASO%)")?.abnormalFlag, "high");
  assert.equal(byName.get("血红蛋白浓度(HGB)")?.unit, "9/L");
  assert.equal(byName.get("红细胞压积(HCT)")?.unit, null);
  assert.equal(byName.has("血小板体积分布宽度(PDVW)"), true);
  const neutrophil = byName.get("中性粒细胞百分比(NEUT%)");
  assert.equal(neutrophil, undefined);
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
    assert.equal(byName["总胆固醇"].quality, "high");
    assert.equal(byName["总胆固醇"].excludedReason, null);
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
    assert.deepEqual(JSON.parse(stored.evidenceJson), [{ pageNumber: 1, quote: plannedLine, pageId: "page-1" }]);
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

test("merges same-examination source rows with matching indicator values during persistence", async () => {
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
      JSON.parse(stored[0].evidenceJson).map((entry: { pageNumber: number }) => entry.pageNumber).sort((a: number, b: number) => a - b),
      [1, 9],
    );
  }, (pageNumber) => [
    "报告编号：SYNTHETIC-EXAM", "采样时间：2026-09-01",
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

test("preserves summary and detail aliases when their examination identity cannot be verified", async () => {
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
    assert.equal(deduplicated.length, 2);
    assert.deepEqual(deduplicated.map(item=>item.numericValue),[1.23,1.23]);
    assert.deepEqual(deduplicated.flatMap(item=>item.evidence.map(e=>e.pageNumber)),[4,10]);
    assert.equal(deduplicated.find(item=>item.itemName==="胱抑素C")?.referenceLow,0.5);
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

test("deduplicates AI partial evidence against a deterministic full-row table fallback", async () => {
  await withReport(1, async ({ reportId, jobId }) => {
    const raw = [
      ["缩写", "项目名称", "结果", "单位", "参考区间", "方法学"],
      ["17", "HDL-C★高密度脂蛋白胆固醇", "1.60", "mmol/L", "≥1", "直接法"],
      ["GLO", "血清球蛋白", "26.7", "g/L", "20-40", "计算法"],
      ["GLU", "血糖", "4.96", "mmol/L", "3.9-6.1", "已糖激酶法"],
      ["eGFR", "肾小球滤过率（估算）", "124.71", "mL/min/1.73m²", "≥90", "估算法"],
    ].flatMap((cells, row) => cells.map((text, column) => ({
      id: `hdl-${row}-${column}`, text, confidence: .99,
      box: [column * 200, row * 40, column * 200 + 100, row * 40 + 20],
      tableCell: { table: "hdl-table", row, column, columns: 6 },
    })));
    getDatabase().prepare("UPDATE ocr_results SET lines_json = ?").run(JSON.stringify(raw));
    const plan = buildAiExtractionPlan(reportId);
    const localNames = plan.pages.flatMap((page) =>
      page.lines.flatMap((line) =>
        line.localObservations?.length
          ? line.localObservations
          : line.localObservation
            ? [line.localObservation]
            : [],
      ),
    ).map((item) => item.itemName);
    for (const name of ["血清球蛋白", "血糖", "肾小球滤过率（估算）"])
      assert.ok(localNames.some((candidate) => candidate.includes(name)), `${name}: ${localNames.join(" / ")}`);
    const executor: AiExecutor = async () => {
      const normalized = normalizeAiExtraction({
        reportType: "laboratory",
        observations: [
          ["HDL-C★高密度脂蛋白胆固醇", "1.60", 1.6, "mmol/L"],
          ["血清球蛋白", "26.7", 26.7, "g/L"],
          ["血糖", "4.96", 4.96, "mmol/L"],
          ["肾小球滤过率（估算）", "124.71", 124.71, "mL/min/1.73m²"],
        ].map(([itemName, resultText, numericValue, unit]) => ({
          itemName: String(itemName),
          resultText: String(resultText),
          numericValue: Number(numericValue),
          unit: String(unit),
          evidence: [{ pageNumber: 1, quote: `${itemName} | ${resultText}` }],
        })),
      });
      return {
        provider: "test", model: "test", promptVersion: "test", ...normalized,
        rawResponseJson: "{}", promptTokens: 10, completionTokens: 5, elapsedMs: 1,
      };
    };
    const execution = await executeAiExtractionPlan(jobId, reportId, executor);
    const expected = new Map([
      ["血清球蛋白", 26.7],
      ["血糖", 4.96],
      ["肾小球滤过率", 124.71],
    ]);
    for (const [name, value] of expected) {
      const matches = execution.result.fields.observations.filter((item) =>
        item.itemName.includes(name) && item.numericValue === value,
      );
      assert.equal(matches.length, 1, `${name} should only appear once`);
    }
  }, () => [
    "缩写 | 项目名称 | 结果 | 单位 | 参考区间 | 方法学",
    "17 | HDL-C★高密度脂蛋白胆固醇 | 1.60 | mmol/L | ≥1 | 直接法",
    "GLO | 血清球蛋白 | 26.7 | g/L | 20-40 | 计算法",
    "GLU | 血糖 | 4.96 | mmol/L | 3.9-6.1 | 已糖激酶法",
    "eGFR | 肾小球滤过率（估算） | 124.71 | mL/min/1.73m² | ≥90 | 估算法",
  ]);
});

test("validates actual result column after abbreviation with an abnormal flag header", async () => {
  await withReport(1, async ({ reportId, jobId }) => {
    const executor: AiExecutor = async () => ({
      provider: "test", model: "test", promptVersion: "test",
      ...normalizeAiExtraction({ reportType: "laboratory", observations: [{
        itemName: "尿比重", resultText: "1.015", numericValue: 1.015,
        evidence: [{ pageNumber: 1, quote: "尿比重 | SG | 1.015 | | | 1.005-1.030" }],
      }] }),
      rawResponseJson: "{}", promptTokens: 10, completionTokens: 5, elapsedMs: 1,
    });
    const plan = buildAiExtractionPlan(reportId);
    assert.equal(plan.pages[0].lines.find(line => line.text.startsWith("尿比重"))?.tableHeaderText,
      "项目名称 | 缩写 | 结果 | 单位 | 异常 | 参考范围");
    const execution = await executeAiExtractionPlan(jobId, reportId, executor);
    assert.ok(execution.result.fields.observations.some(item => item.itemName === "尿比重" && item.numericValue === 1.015));
  }, () => ["【尿常规】", "项目名称 | 缩写 | 结果 | 单位 | 异常 | 参考范围", "尿比重 | SG | 1.015 | | | 1.005-1.030"]);
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


test('vision review supplements unresolved scalar candidates and closes them before persistence', async () => {
  await withReport(1, async ({ reportId, jobId }) => {
    const events: string[] = [];
    let visionCandidateTexts: string[] = [];
    const executor: AiExecutor = async (input) => ({
      provider: 'test', model: 'test', promptVersion: 'test',
      ...normalizeAiExtraction(input.text.includes('遗漏候选补提取') ? {} : {
        observations: [{
          itemName: '合成指标一', resultText: '1.2', numericValue: 1.2, unit: 'mmol/L',
          evidence: [{ pageNumber: 1, quote: '合成指标一 1.2 mmol/L 参考范围 1.0-20.0' }],
        }],
      }),
      rawResponseJson: '{}', promptTokens: 1, completionTokens: 1, elapsedMs: 1,
    });
    const execution = await executeAiExtractionPlan(jobId, reportId, executor, {
      onEvent: (event) => events.push(event.type),
      visionReview: async (input, options) => {
        visionCandidateTexts = input.candidates.map((candidate) => candidate.line.text);
        options?.onEvent?.({
          type: 'vision_review_completed',
          message: '视觉复核完成：复核 1 页，补充 1 项指标',
          detail: { accepted: 1 },
        });
        return {
          provider: 'test-vision', model: 'vision-model', promptVersion: 'vision-review-v1',
          ...normalizeAiExtraction({
            observations: [{
              itemName: '血小板计数', resultText: '205', numericValue: 205, unit: '10^9/L',
              evidence: [{
                pageNumber: 1,
                quote: '血小板计数 205 10^9/L 参考范围 125-350',
                source: 'vision' as const,
              }],
            }],
          }),
          rawResponseJson: '{}', promptTokens: 100, completionTokens: 20, elapsedMs: 50,
        };
      },
    });

    // 文本链路未覆盖的候选行进入视觉复核
    assert.deepEqual(visionCandidateTexts, ['血小板计数 205 10^9/L 参考范围 125-350']);
    // 视觉补充的指标合入最终结果，来源标记穿透合并重归一
    const supplemented = execution.result.fields.observations.find(
      (item) => item.itemName === '血小板计数',
    );
    assert.ok(supplemented);
    assert.equal(supplemented.evidence[0]?.source, 'vision');
    assert.equal(supplemented.evidence[0]?.quote, '血小板计数 205 10^9/L 参考范围 125-350');
    assert.ok(execution.result.fields.observations.some((item) => item.itemName === '合成指标一'));
    // 视觉 token 计入任务总量
    assert.equal(execution.result.promptTokens, 102);
    assert.equal(execution.result.completionTokens, 22);
    assert.ok(events.includes('vision_review_completed'));
    // 复核合并在候选闭环之前：视觉补充的指标正常闭环候选
    const unresolvedRows = getDatabase().prepare(
      "SELECT COUNT(*) AS count FROM ai_extraction_candidates WHERE job_id = ? AND status = 'unresolved'",
    ).get(jobId) as { count: number };
    assert.equal(unresolvedRows.count, 0);
    assert.equal(execution.unmatchedCandidates, 0);

    // 落库链路（sanitize/证据校验/插入）保留视觉来源标记
    persistAiExtraction(reportId, jobId, execution.result, execution.inputCharacters);
    const persisted = getDatabase().prepare(
      "SELECT evidence_json AS evidenceJson FROM observations WHERE report_id = ? AND item_name = '血小板计数'",
    ).get(reportId) as { evidenceJson: string } | undefined;
    assert.ok(persisted);
    const evidence = JSON.parse(persisted.evidenceJson) as Array<{ source?: string }>;
    assert.equal(evidence[0]?.source, 'vision');
  }, () => [
    '检验报告',
    '合成指标一 1.2 mmol/L 参考范围 1.0-20.0',
    '血小板计数 205 10^9/L 参考范围 125-350',
  ]);
});

test('vision review is skipped in overview depth even with unresolved candidates', async () => {
  await withReport(1, async ({ reportId, jobId }) => {
    getDatabase().prepare("UPDATE app_settings SET value_json = '{\"extractionDepth\":\"overview\"}' WHERE setting_key = 'ai.provider'").run();
    let visionCalled = false;
    const executor: AiExecutor = async () => ({
      provider: 'test', model: 'test', promptVersion: 'test',
      ...normalizeAiExtraction({
        observations: [{
          itemName: '合成指标一', resultText: '1.2', numericValue: 1.2, unit: 'mmol/L',
          evidence: [{ pageNumber: 1, quote: '合成指标一 1.2 mmol/L 参考范围 1.0-20.0' }],
        }],
      }),
      rawResponseJson: '{}', promptTokens: 1, completionTokens: 1, elapsedMs: 1,
    });
    const execution = await executeAiExtractionPlan(jobId, reportId, executor, {
      visionReview: async () => {
        visionCalled = true;
        return null;
      },
    });
    assert.equal(visionCalled, false);
    assert.ok(execution.unmatchedCandidates > 0);
  }, () => [
    '检验报告',
    '合成指标一 1.2 mmol/L 参考范围 1.0-20.0',
    '血小板计数 205 10^9/L 参考范围 125-350',
  ]);
});


/* ---------- 表格序号断档检测与视觉复核候选放宽 ---------- */

function syntheticLine(
  id: string,
  text: string,
  overrides: Partial<PlannedOcrLine> = {},
): PlannedOcrLine {
  return {
    id,
    text,
    sourceLineIds: [id],
    index: 0,
    candidate: false,
    candidateKind: null,
    boundary: null,
    localObservation: null,
    localObservations: [],
    dictionaryFacts: [],
    ...overrides,
  } as PlannedOcrLine;
}

function syntheticPlan(
  pages: Array<{ pageNumber: number; tableStructureStatus?: string | null; lines: PlannedOcrLine[] }>,
): AiExtractionPlan {
  return {
    reportId: "synthetic",
    extractionDepth: "detailed",
    units: [],
    pages: pages.map((page) => ({ pageId: `page-${page.pageNumber}`, ...page })),
  } as unknown as AiExtractionPlan;
}

function emptyExtractionResult(): AiExtractionResult {
  return {
    provider: "test", model: "test", promptVersion: "test",
    ...normalizeAiExtraction({}),
    rawResponseJson: "{}", promptTokens: 0, completionTokens: 0, elapsedMs: 0,
  };
}

test('detectTableSerialGapPages flags lost numbered rows and stays quiet on complete tables', () => {
  const header = "项目 | 结果 | 单位 | 参考范围";
  const gapPlan = syntheticPlan([{
    pageNumber: 1,
    lines: [
      syntheticLine("h", header, { boundary: "table_header" }),
      syntheticLine("r1", "1 | 指标甲 | 1.1 | U/L | 0-5", { candidate: true, candidateKind: "scalar", tableHeaderText: header }),
      syntheticLine("r2", "2 | 指标乙 | 2.2 | U/L | 0-5", { candidate: true, candidateKind: "scalar", tableHeaderText: header }),
      syntheticLine("r3", "3 | 指标丙 | 3.3 | U/L | 0-5", { candidate: true, candidateKind: "scalar", tableHeaderText: header }),
      // 序号 4 的行被规则误杀成噪声：在页面里但没进提取通道
      syntheticLine("r4", "4 | 指标丁 | 4.4 | U/L | 0-5", { candidate: false, tableHeaderText: header }),
      syntheticLine("r5", "5 | 指标戊 | 5.5 | U/L | 0-9", { candidate: true, candidateKind: "scalar", tableHeaderText: header }),
      syntheticLine("r6", "6 | 指标己 | 6.6 | U/L | 0-9", { candidate: true, candidateKind: "scalar", tableHeaderText: header }),
    ],
  }]);
  assert.deepEqual(detectTableSerialGapPages(gapPlan), [1]);

  // 全部进入提取通道 → 无断档（序号被 OCR 误读成字母的行仍计入行数）
  const completePlan = syntheticPlan([{
    pageNumber: 1,
    lines: [
      syntheticLine("h", header, { boundary: "table_header" }),
      syntheticLine("r1", "1 | 指标甲 | 1.1 | U/L | 0-5", { candidate: true, candidateKind: "scalar", tableHeaderText: header }),
      syntheticLine("r2", "2 | 指标乙 | 2.2 | U/L | 0-5", { candidate: true, candidateKind: "scalar", tableHeaderText: header }),
      syntheticLine("r3", "LC | 指标丙 | 3.3 | U/L | 0-5", { candidate: true, candidateKind: "scalar", tableHeaderText: header }),
    ],
  }]);
  assert.deepEqual(detectTableSerialGapPages(completePlan), []);

  // 序号行太少（<3）不启用断档判定，避免零散数字误报
  const fewSerials = syntheticPlan([{
    pageNumber: 1,
    lines: [
      syntheticLine("r1", "1 | 指标甲 | 1.1 | U/L | 0-5", { candidate: true, candidateKind: "scalar", tableHeaderText: header }),
      syntheticLine("r9", "9 | 指标壬 | 9.9 | U/L | 0-15", { candidate: true, candidateKind: "scalar", tableHeaderText: header }),
    ],
  }]);
  assert.deepEqual(detectTableSerialGapPages(fewSerials), []);
});

test('vision candidates widen to measurement-shaped noise lines only on table-unreliable pages', () => {
  const noiseRow = syntheticLine(
    "n1",
    "8 | 中性粒细胞百分数（NEU%） | 14.7 | % | 40~75",
    { tableHeaderText: "项 | 结果 | 单位 | 参考区间 | 方法" },
  );
  const chartJunk = syntheticLine("n2", "BASO | RBC | PLT | DIFF");
  const shortJunk = syntheticLine("n3", "备注 | 无");
  // 人员签名行：格子里混着设备型号数字，但没有"整格数值"的结果格，不应入选
  const personnelJunk = syntheticLine("n4", "采样者：某某 | 检验者：某某 | 审核者：某某CAL8000血球仪");
  const unreliablePlan = syntheticPlan([{
    pageNumber: 1,
    tableStructureStatus: "no_structure",
    lines: [noiseRow, chartJunk, shortJunk, personnelJunk],
  }]);
  assert.deepEqual(
    visionReviewCandidates(unreliablePlan, emptyExtractionResult()).map((item) => item.line.id),
    ["n1"],
  );

  // 表格模型正常完成的页不做噪声放宽
  const reliablePlan = syntheticPlan([{
    pageNumber: 1,
    tableStructureStatus: "applied",
    lines: [noiseRow],
  }]);
  assert.deepEqual(visionReviewCandidates(reliablePlan, emptyExtractionResult()), []);
});

test('serial gap surfaces through the ai_extract completion event into the jobs API', async () => {
  await withReport(1, async ({ reportId, jobId }) => {
    const executor: AiExecutor = async () => ({
      provider: 'test', model: 'test', promptVersion: 'test',
      ...normalizeAiExtraction({
        observations: ['指标甲', '指标乙', '指标丙', '指标戊', '指标己'].map((name, index) => ({
          itemName: name,
          resultText: `${index + 1}.1`,
          numericValue: index + 1.1,
          unit: 'U/L',
          evidence: [{ pageNumber: 1, quote: `${index + 1} | ${name} | ${index + 1}.1 | U/L | 0-5` }],
        })),
      }),
      rawResponseJson: '{}', promptTokens: 1, completionTokens: 1, elapsedMs: 1,
    });
    const execution = await executeAiExtractionPlan(jobId, reportId, executor);
    // 序号 1,2,3,5,6 全部进入提取通道，最大序号 6 → 序号 4 的整行丢失被标记
    assert.deepEqual(execution.tableSerialGapPages, [1]);

    // 模拟 job-runner 的最终完成事件，验证 jobs 接口透出断档页
    getDatabase().prepare(`
      INSERT INTO processing_job_events (id, job_id, report_id, event_type, status, attempt, detail_json)
      VALUES ('evt-final', ?, ?, 'completed', 'completed', 1, ?)
    `).run(jobId, reportId, JSON.stringify({
      jobType: 'ai_extract',
      planHash: execution.plan.planHash,
      tableSerialGapPages: execution.tableSerialGapPages,
    }));
    const manager = { id: 'owner', displayName: '管理员', authenticated: true, provider: 'development', isGatewayAdmin: true } as const;
    getDatabase().prepare(
      "INSERT INTO member_permissions (member_id, user_id, permission, granted_by) VALUES ('member', 'owner', 'manager', 'owner')",
    ).run();
    const jobs = listProcessingJobs(manager, reportId) as Array<{ jobType: string; tableSerialGapPages?: number[] }>;
    assert.deepEqual(
      jobs.find((job) => job.jobType === 'ai_extract')?.tableSerialGapPages,
      [1],
    );
  }, () => [
    '检验报告',
    '项目 | 结果 | 单位 | 参考范围',
    '1 | 指标甲 | 1.1 | U/L | 0-5',
    '2 | 指标乙 | 2.2 | U/L | 0-5',
    '3 | 指标丙 | 3.3 | U/L | 0-5',
    '5 | 指标戊 | 5.5 | U/L | 0-9',
    '6 | 指标己 | 6.6 | U/L | 0-9',
  ]);
});

test('diagnostics warn about unreliable table structure only when the page carries scalar candidates', async () => {
  await withReport(1, async ({ reportId, jobId }) => {
    const executor: AiExecutor = async () => ({
      provider: 'test', model: 'test', promptVersion: 'test',
      ...normalizeAiExtraction({
        observations: [{
          itemName: '指标1', resultText: '1.2', numericValue: 1.2, unit: 'mmol/L',
          evidence: [{ pageNumber: 1, quote: '指标1 1.2 mmol/L 参考范围 1.0-20.0' }],
        }],
      }),
      rawResponseJson: '{}', promptTokens: 1, completionTokens: 1, elapsedMs: 1,
    });
    await executeAiExtractionPlan(jobId, reportId, executor);
    getDatabase().prepare(
      "UPDATE processing_jobs SET status = 'completed', finished_at = CURRENT_TIMESTAMP WHERE id = ?",
    ).run(jobId);
    const units = (getDatabase().prepare(`
      SELECT unit_type AS unitType, page_numbers_json AS pageNumbersJson, status,
        character_count AS characterCount, candidate_count AS candidateCount,
        matched_count AS matchedCount
      FROM ai_extraction_units WHERE job_id = ? AND status <> 'superseded'
      ORDER BY unit_index, id
    `).all(jobId) as Array<Record<string, unknown>>).map((unit) => ({
      ...unit,
      pageNumbers: JSON.parse(String(unit.pageNumbersJson)) as number[],
    }));
    const job = {
      id: jobId, reportId, jobType: "ai_extract" as const,
      status: "completed", errorCode: null, errorMessage: null,
    };

    // 无表格诊断字段（未安装模块）时不提示
    let diagnostics = buildProcessingJobDiagnostics(job, [], units as never);
    assert.equal(
      diagnostics.reasons.some((reason) => reason.code === "TABLE_STRUCTURE_UNRELIABLE"),
      false,
    );

    // 表格模型失败且页上有指标候选 → 诊断抽屉提示
    const ocrRow = getDatabase().prepare(
      "SELECT id, lines_json AS linesJson FROM ocr_results WHERE page_id = 'page-1'",
    ).get() as { id: string; linesJson: string };
    const lines = JSON.parse(ocrRow.linesJson) as Array<Record<string, unknown>>;
    lines[0].tableDiagnostics = { status: "no_structure", mapped: 0, unsafe: 12 };
    getDatabase().prepare("UPDATE ocr_results SET lines_json = ? WHERE id = ?")
      .run(JSON.stringify(lines), ocrRow.id);
    diagnostics = buildProcessingJobDiagnostics(job, [], units as never);
    const reason = diagnostics.reasons.find((item) => item.code === "TABLE_STRUCTURE_UNRELIABLE");
    assert.ok(reason);
    assert.equal(reason.severity, "warning");
    assert.deepEqual(reason.pages, [1]);
  }, () => [
    '检验报告',
    '指标1 1.2 mmol/L 参考范围 1.0-20.0',
  ]);
});


test('drops findings that merely enumerate extracted observations', async () => {
  await withReport(1, async ({ reportId, jobId }) => {
    const executor: AiExecutor = async () => ({
      provider: 'test', model: 'test', promptVersion: 'test',
      ...normalizeAiExtraction({
        findings: '指标甲 1.1 U/L（参考0-5）；指标乙 2.2 U/L（参考0-5）；指标丙 3.3 U/L（参考0-5）',
        observations: [
          { itemName: '指标甲', resultText: '1.1', numericValue: 1.1, unit: 'U/L', evidence: [{ pageNumber: 1, quote: '指标甲 1.1 U/L 参考范围 0-5' }] },
          { itemName: '指标乙', resultText: '2.2', numericValue: 2.2, unit: 'U/L', evidence: [{ pageNumber: 1, quote: '指标乙 2.2 U/L 参考范围 0-5' }] },
          { itemName: '指标丙', resultText: '3.3', numericValue: 3.3, unit: 'U/L', evidence: [{ pageNumber: 1, quote: '指标丙 3.3 U/L 参考范围 0-5' }] },
        ],
      }),
      rawResponseJson: '{}', promptTokens: 1, completionTokens: 1, elapsedMs: 1,
    });
    const execution = await executeAiExtractionPlan(jobId, reportId, executor);
    persistAiExtraction(reportId, jobId, execution.result, execution.inputCharacters);
    const row = getDatabase().prepare("SELECT findings FROM reports WHERE id = ?").get(reportId) as { findings: string | null };
    assert.equal(row.findings, null);
    // 指标本身正常落库，过滤只影响叙事字段
    const stored = getDatabase().prepare("SELECT COUNT(*) AS c FROM observations WHERE report_id = ?").get(reportId) as { c: number };
    assert.equal(stored.c, 3);
  }, () => [
    '检验报告',
    '指标甲 1.1 U/L 参考范围 0-5',
    '指标乙 2.2 U/L 参考范围 0-5',
    '指标丙 3.3 U/L 参考范围 0-5',
  ]);
});

test('keeps narrative findings and interpretive text that only names indicators', async () => {
  await withReport(1, async ({ reportId, jobId }) => {
    const executor: AiExecutor = async () => ({
      provider: 'test', model: 'test', promptVersion: 'test',
      ...normalizeAiExtraction({
        findings: '白细胞总数及中性粒细胞总数升高，提示炎症可能，建议结合临床复查。',
        observations: [
          { itemName: '白细胞总数', resultText: '29.59', numericValue: 29.59, unit: '109/L', evidence: [{ pageNumber: 1, quote: '白细胞总数 29.59 109/L 参考范围 3.5-9.5' }] },
          { itemName: '中性粒细胞总数', resultText: '4.36', numericValue: 4.36, unit: '109/L', evidence: [{ pageNumber: 1, quote: '中性粒细胞总数 4.36 109/L 参考范围 1.8-6.3' }] },
          { itemName: '血红蛋白', resultText: '153', numericValue: 153, unit: 'g/L', evidence: [{ pageNumber: 1, quote: '血红蛋白 153 g/L 参考范围 130-175' }] },
        ],
      }),
      rawResponseJson: '{}', promptTokens: 1, completionTokens: 1, elapsedMs: 1,
    });
    const execution = await executeAiExtractionPlan(jobId, reportId, executor);
    persistAiExtraction(reportId, jobId, execution.result, execution.inputCharacters);
    const row = getDatabase().prepare("SELECT findings FROM reports WHERE id = ?").get(reportId) as { findings: string | null };
    assert.equal(row.findings, '白细胞总数及中性粒细胞总数升高，提示炎症可能，建议结合临床复查。');
  }, () => [
    '检验报告',
    '白细胞总数 29.59 109/L 参考范围 3.5-9.5',
    '中性粒细胞总数 4.36 109/L 参考范围 1.8-6.3',
    '血红蛋白 153 g/L 参考范围 130-175',
  ]);
});

test('omitted multi-date table rows are recovered locally and published with independent dates', async () => {
  for (const structuredCells of [false,true]) await withReport(1, async ({ reportId,jobId }) => {
    if (structuredCells) {
      const cells=[['项目','2026-09-01','2026-09-08','单位','参考范围'],['丙氨酸氨基转移酶','120','80','U/L','0-40']].flatMap((row,r)=>row.map((text,c)=>({id:`cell-${r}-${c}`,text,confidence:.99,box:[c*100,r*40,c*100+90,r*40+20],tableCell:{table:'synthetic-table',row:r,column:c,columns:5}})));
      getDatabase().prepare('UPDATE ocr_results SET lines_json=? WHERE page_id IN (SELECT id FROM report_pages WHERE report_id=?)').run(JSON.stringify([{text:'报告编号：SYNTHETIC',box:[0,-40,200,-20]},...cells]),reportId);
    }
    const executor:AiExecutor=async()=>({provider:'test',model:'test',promptVersion:'test',...normalizeAiExtraction({reportType:'laboratory',observations:[]}),rawResponseJson:'{}',promptTokens:1,completionTokens:1,elapsedMs:1});
    const execution=await executeAiExtractionPlan(jobId,reportId,executor);
    assert.deepEqual(execution.result.fields.observations.map(o=>[o.numericValue,o.examination?.timeText]),[[120,'2026-09-01'],[80,'2026-09-08']]);
    persistAiExtraction(reportId,jobId,execution.result,execution.inputCharacters);
    const rows=getDatabase().prepare(`SELECT o.numeric_value AS value,e.occurred_at AS time FROM observations o JOIN observation_examinations l ON l.observation_id=o.id JOIN report_examinations e ON e.id=l.examination_id WHERE o.report_id=? ORDER BY e.occurred_at`).all(reportId);
    assert.deepEqual(rows.map(r=>[r.value,r.time]),[[120,'2026-09-01'],[80,'2026-09-08']]);
  },()=>['报告编号：SYNTHETIC','肝功能','项目 | 2026-09-01 | 2026-09-08 | 单位 | 参考范围','丙氨酸氨基转移酶 | 120 | 80 | U/L | 0-40']);
});
