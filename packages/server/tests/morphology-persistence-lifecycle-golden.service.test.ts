import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { closeDatabaseForTests, getDatabase } from "../database/client.ts";
import type { RequestUser } from "../domain/request-user.ts";
import {
  aiExtractionPromptVersion,
  normalizeAiExtraction,
  persistAiExtraction,
  type AiExtractionResult,
  type AiMorphologyFinding,
} from "../services/ai-extraction.service.ts";
import {
  listMorphologyTracking,
  rebuildMorphologyTrackingForReport,
} from "../services/morphology-finding.service.ts";
import {
  getReportDetail,
  permanentlyDeleteReport,
  restoreReport,
  trashReport,
} from "../services/records.service.ts";

const golden = JSON.parse(
  readFileSync(
    new URL(
      "./fixtures/p3-ultrasound-summary-detail-morphology-golden.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as {
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

const manager: RequestUser = {
  id: "morphology-lifecycle-manager",
  displayName: "形态金标管理员",
  provider: "development",
  authenticated: true,
  isGatewayAdmin: true,
};

const reportId = "morphology-lifecycle-report";
const memberId = "morphology-lifecycle-member";

function extractionResult(): AiExtractionResult {
  const normalized = normalizeAiExtraction({
    reportType: "checkup",
    title: "真实超声摘要明细金标",
    reportIssuedAt: "2026-08-05",
    morphologyFindings: golden.source.findings,
  });
  return {
    provider: "fixed-golden",
    model: "fixed-structured-fixture",
    promptVersion: aiExtractionPromptVersion,
    ...normalized,
    rawResponseJson: JSON.stringify(normalized),
    promptTokens: 0,
    completionTokens: 0,
    elapsedMs: 0,
  };
}

type StoredFinding = {
  id: string;
  findingType: string;
  findingName: string;
  organ: string | null;
  region: string | null;
  laterality: AiMorphologyFinding["laterality"];
  sizeLength: number | null;
  sizeUnit: string | null;
  measurementsJson: string;
  morphology: string | null;
  attributesJson: string;
  evidenceJson: string;
  trackingGroupId: string | null;
};

function storedFindings() {
  return getDatabase()
    .prepare(
      `
      SELECT id, finding_type AS findingType, finding_name AS findingName,
        organ, region, laterality, size_length AS sizeLength, size_unit AS sizeUnit,
        measurements_json AS measurementsJson, morphology_text AS morphology,
        attributes_json AS attributesJson, evidence_json AS evidenceJson,
        tracking_group_id AS trackingGroupId
      FROM morphology_findings
      WHERE report_id = ?
      ORDER BY finding_type, finding_name
    `,
    )
    .all(reportId) as StoredFinding[];
}

function semanticSnapshot(rows = storedFindings()) {
  return rows.map((row) => ({
    findingType: row.findingType,
    findingName: row.findingName,
    organ: row.organ,
    region: row.region,
    laterality: row.laterality,
    sizeLength: row.sizeLength,
    sizeUnit: row.sizeUnit,
    measurements: JSON.parse(row.measurementsJson) as unknown,
    morphology: row.morphology,
    attributes: JSON.parse(row.attributesJson) as unknown,
    evidence: JSON.parse(row.evidenceJson) as unknown,
    trackingGroupId: row.trackingGroupId,
  }));
}

function assertGoldenPersisted(rows: StoredFinding[]) {
  assert.equal(rows.length, golden.expected.findingCount);
  for (const expected of golden.expected.findings) {
    const row = rows.find((item) => item.findingType === expected.findingType);
    assert.ok(row, `缺少持久化标准 finding：${expected.findingType}`);
    assert.equal(row.findingName, expected.findingName);
    assert.equal(row.organ, expected.organ);
    assert.equal(row.laterality, expected.laterality);
    if (expected.region) assert.equal(row.region, expected.region);
    if (expected.size) {
      assert.equal(row.sizeLength, expected.size.length);
      assert.equal(row.sizeUnit, expected.size.unit);
    }
    const measurements = JSON.parse(row.measurementsJson) as Array<{
      key: string;
      value: number;
      unit: string | null;
    }>;
    if (expected.measurement) {
      assert.equal(
        measurements.some(
          (item) =>
            item.key === expected.measurement?.key &&
            item.value === expected.measurement.value &&
            item.unit === expected.measurement.unit,
        ),
        true,
      );
    }
    for (const text of expected.morphologyIncludes || []) {
      assert.match(row.morphology || "", new RegExp(text));
    }
    const attributes = JSON.parse(row.attributesJson) as Record<string, string>;
    for (const [key, value] of Object.entries(expected.attributeEntries)) {
      assert.equal(attributes[key], value);
    }
    const evidence = JSON.parse(row.evidenceJson) as Array<{
      pageNumber: number;
      quote: string;
    }>;
    assert.deepEqual(
      [...new Set(evidence.map((item) => item.pageNumber))].sort(
        (left, right) => left - right,
      ),
      expected.evidencePages,
    );
    for (const quote of expected.evidenceQuotes) {
      assert.equal(
        evidence.some((item) => item.quote === quote),
        true,
        `持久化后缺少证据：${quote}`,
      );
    }
  }
  for (const prohibited of golden.expected.prohibitedFindingNames) {
    assert.equal(
      rows.some((item) => item.findingName === prohibited),
      false,
      `描述性别名不得形成持久化 finding：${prohibited}`,
    );
  }
}

function evidencePageForQuote(quote: string) {
  for (const finding of golden.source.findings) {
    const evidence = finding.evidence.find((item) => item.quote === quote);
    if (evidence) return evidence.pageNumber;
  }
  return null;
}

function assertGoldenReadContract() {
  const detail = getReportDetail(manager, reportId);
  assert.equal(detail.morphologyFindings.length, golden.expected.findingCount);
  for (const expected of golden.expected.findings) {
    const finding = detail.morphologyFindings.find(
      (item) => item.findingType === expected.findingType,
    );
    assert.ok(finding, `详情 API 缺少标准 finding：${expected.findingType}`);
    assert.equal(finding.findingName, expected.findingName);
    assert.deepEqual(
      [...new Set(finding.evidence.map((item) => item.pageNumber))].sort(
        (left, right) => left - right,
      ),
      expected.evidencePages,
    );
    for (const quote of expected.evidenceQuotes) {
      assert.equal(
        finding.evidence.some((item) => item.quote === quote),
        true,
        `详情 API 缺少证据：${quote}`,
      );
    }
  }
  for (const prohibited of golden.expected.prohibitedFindingNames) {
    assert.equal(
      detail.morphologyFindings.some((item) => item.findingName === prohibited),
      false,
      `详情 API 不得返回描述性别名：${prohibited}`,
    );
  }

  const tracking = listMorphologyTracking(manager, memberId);
  assert.equal(tracking.series.length, golden.expected.findingCount);
  assert.equal(tracking.summary.findings, golden.expected.findingCount);
  for (const expected of golden.expected.findings) {
    const series = tracking.series.find(
      (item) => item.points.some((point) => point.findingName === expected.findingName),
    );
    assert.ok(series, `趋势读取缺少标准 finding：${expected.findingName}`);
    assert.equal(series.pointCount, 1);
    assert.equal(series.points.length, 1);
    assert.equal(
      new Set(series.points.map((point) => point.reportId)).size,
      series.points.length,
      "同一趋势分组每份报告最多只能有一个点",
    );
    const point = series.points[0]!;
    assert.equal(point.findingName, expected.findingName);
    assert.equal(
      golden.expected.prohibitedFindingNames.includes(point.findingName),
      false,
    );
    assert.ok(point.sourcePage, `趋势点缺少来源页：${expected.findingName}`);
    assert.ok(point.evidenceQuote, `趋势点缺少证据原文：${expected.findingName}`);
    assert.equal(
      expected.evidenceQuotes.includes(point.evidenceQuote),
      true,
      `趋势证据不属于该 finding：${point.evidenceQuote}`,
    );
    assert.equal(
      point.sourcePage.pageNumber,
      evidencePageForQuote(point.evidenceQuote),
      "趋势来源页必须与 evidenceQuote 成对对应",
    );
    const rawTextPage = evidencePageForQuote(point.rawText);
    if (rawTextPage) {
      assert.equal(
        point.evidenceQuote,
        point.rawText,
        "合并 finding 应优先定位到承载完整 rawText 的证据，而不是依赖 evidence 数组顺序",
      );
      assert.equal(point.sourcePage.pageNumber, rawTextPage);
    }
  }
}

function insertAiJob(id: string, pipelineVersion: string) {
  getDatabase()
    .prepare(
      `
      INSERT INTO processing_jobs (
        id, report_id, job_type, status, pipeline_version, deduplication_key,
        started_at, finished_at
      ) VALUES (?, ?, 'ai_extract', 'completed', ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `,
    )
    .run(id, reportId, pipelineVersion, `${reportId}:ai:${id}`);
}

test("keeps the real ultrasound morphology golden idempotent across persistence, rerun, trash restore, and purge", () => {
  const storageDir = mkdtempSync(
    join(tmpdir(), "health-records-morphology-lifecycle-"),
  );
  process.env.STORAGE_DIR = storageDir;
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
    db.prepare(
      `
      INSERT INTO reports (
        id, member_id, created_by, report_type, title, status, report_issued_at
      ) VALUES (?, ?, ?, 'checkup', '真实超声摘要明细金标', 'ready', '2026-08-05')
    `,
    ).run(reportId, memberId, manager.id);
    const insertPage = db.prepare(
      `
      INSERT INTO report_pages (
        id, report_id, page_number, original_name, storage_path, mime_type,
        file_size, sha256
      ) VALUES (?, ?, ?, ?, ?, 'image/png', 1, ?)
    `,
    );
    const insertOcrJob = db.prepare(
      `
      INSERT INTO processing_jobs (
        id, report_id, page_id, job_type, status, pipeline_version,
        deduplication_key, started_at, finished_at
      ) VALUES (?, ?, ?, 'ocr', 'completed', 'fixed-golden', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `,
    );
    const insertOcr = db.prepare(
      `
      INSERT INTO ocr_results (
        id, job_id, page_id, engine, model_version, lines_json, text_length
      ) VALUES (?, ?, ?, 'stored-golden', 'fixed-v1', ?, ?)
    `,
    );
    const evidenceByPage = new Map<number, string[]>();
    for (const finding of golden.source.findings) {
      for (const evidence of finding.evidence) {
        const quotes = evidenceByPage.get(evidence.pageNumber) || [];
        if (!quotes.includes(evidence.quote)) quotes.push(evidence.quote);
        evidenceByPage.set(evidence.pageNumber, quotes);
      }
    }
    for (let pageNumber = 1; pageNumber <= 18; pageNumber += 1) {
      const pageId = `morphology-page-${pageNumber}`;
      const ocrJobId = `morphology-ocr-job-${pageNumber}`;
      const ocrId = `morphology-ocr-${pageNumber}`;
      insertPage.run(
        pageId,
        reportId,
        pageNumber,
        `page-${pageNumber}.png`,
        `reports/page-${pageNumber}.png`,
        `morphology-page-${pageNumber}-hash`,
      );
      insertOcrJob.run(
        ocrJobId,
        reportId,
        pageId,
        `${reportId}:ocr:${pageNumber}`,
      );
      const lines = (evidenceByPage.get(pageNumber) || []).map((text, index) => ({
        id: `morphology-page-${pageNumber}-line-${index + 1}`,
        text,
        confidence: 0.99,
      }));
      const linesJson = JSON.stringify(lines);
      insertOcr.run(ocrId, ocrJobId, pageId, linesJson, linesJson.length);
    }

    insertAiJob("morphology-ai-initial", "unit-test");
    const result = extractionResult();
    persistAiExtraction(reportId, "morphology-ai-initial", result, 0);
    rebuildMorphologyTrackingForReport(reportId);

    const initialRows = storedFindings();
    assertGoldenPersisted(initialRows);
    assert.equal(initialRows.every((row) => Boolean(row.trackingGroupId)), true);
    assert.equal(
      new Set(initialRows.map((row) => row.trackingGroupId)).size,
      golden.expected.findingCount,
    );
    const initialSnapshot = semanticSnapshot(initialRows);
    const initialIds = initialRows.map((row) => row.id);

    persistAiExtraction(reportId, "morphology-ai-initial", result, 0);
    assert.deepEqual(storedFindings().map((row) => row.id), initialIds);
    assert.deepEqual(semanticSnapshot(), initialSnapshot);

    insertAiJob("morphology-ai-rerun", "manual-ai-v1");
    persistAiExtraction(reportId, "morphology-ai-rerun", result, 0);
    rebuildMorphologyTrackingForReport(reportId);

    const rerunRows = storedFindings();
    assertGoldenPersisted(rerunRows);
    assert.deepEqual(semanticSnapshot(rerunRows), initialSnapshot);
    assert.equal(
      rerunRows.some((row) => initialIds.includes(row.id)),
      false,
      "重跑应替换无手工字段的生成记录，而不是追加重复记录",
    );
    const extractionCount = db
      .prepare(
        "SELECT COUNT(*) AS count FROM report_extractions WHERE report_id = ?",
      )
      .get(reportId) as { count: number };
    assert.equal(extractionCount.count, 2);

    const trackingBeforeTrash = listMorphologyTracking(manager, memberId);
    assert.equal(trackingBeforeTrash.summary.groups, golden.expected.findingCount);
    assert.equal(trackingBeforeTrash.summary.findings, golden.expected.findingCount);
    assert.equal(trackingBeforeTrash.summary.untracked, 0);
    assert.equal(
      trackingBeforeTrash.series.every((series) => series.pointCount === 1),
      true,
    );
    assertGoldenReadContract();

    const reverseEvidence = db.prepare(
      "UPDATE morphology_findings SET evidence_json = ? WHERE id = ?",
    );
    for (const row of storedFindings()) {
      const reversed = (JSON.parse(row.evidenceJson) as unknown[]).reverse();
      reverseEvidence.run(JSON.stringify(reversed), row.id);
    }
    assertGoldenReadContract();

    assert.equal(trashReport(manager, reportId).status, "trashed");
    const trackingInTrash = listMorphologyTracking(manager, memberId);
    assert.equal(trackingInTrash.summary.findings, 0);
    assert.equal(storedFindings().length, golden.expected.findingCount);

    assert.equal(restoreReport(manager, reportId).status, "needs_review");
    const trackingAfterRestore = listMorphologyTracking(manager, memberId);
    assert.equal(
      trackingAfterRestore.summary.findings,
      golden.expected.findingCount,
    );
    assertGoldenPersisted(storedFindings());

    assert.equal(trashReport(manager, reportId).status, "trashed");
    assert.deepEqual(permanentlyDeleteReport(manager, reportId), {
      id: reportId,
      deleted: true,
      pendingFileCount: 0,
    });
    const afterPurge = db
      .prepare(
        `
        SELECT
          (SELECT COUNT(*) FROM reports WHERE id = ?) AS reports,
          (SELECT COUNT(*) FROM report_pages WHERE report_id = ?) AS pages,
          (SELECT COUNT(*) FROM ocr_results) AS ocrResults,
          (SELECT COUNT(*) FROM morphology_findings WHERE report_id = ?) AS findings,
          (SELECT COUNT(*) FROM processing_jobs WHERE report_id = ?) AS jobs,
          (SELECT COUNT(*) FROM report_extractions WHERE report_id = ?) AS extractions
      `,
      )
      .get(reportId, reportId, reportId, reportId, reportId) as Record<
      string,
      number
    >;
    for (const count of Object.values(afterPurge)) assert.equal(count, 0);
    assert.equal(listMorphologyTracking(manager, memberId).summary.findings, 0);
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
});
