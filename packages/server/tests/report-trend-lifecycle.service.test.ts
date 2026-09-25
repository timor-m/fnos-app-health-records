import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { closeDatabaseForTests, getDatabase } from "../database/client.ts";
import type { RequestUser } from "../domain/request-user.ts";
import { normalizeAiExtraction, type AiExecutor } from "../services/ai-extraction.service.ts";
import { saveAiSettings } from "../services/ai-settings.service.ts";
import { processNextJob, type WorkerExecutor } from "../services/job-runner.service.ts";
import {
  confirmReportReady,
  listTrendSeries,
  permanentlyDeleteReport,
  restoreReport,
  trashReport
} from "../services/records.service.ts";
import { createUpload } from "../services/upload.service.ts";

const manager: RequestUser = {
  id: "trend-lifecycle-manager",
  displayName: "生命周期管理员",
  provider: "fnos_gateway",
  authenticated: true,
  isGatewayAdmin: true
};

function pngBytes() {
  return Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x31]);
}

test("keeps trend data reversible in trash and removes the complete report graph on permanent deletion", async () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-trend-lifecycle-"));
  process.env.STORAGE_DIR = storageDir;
  try {
    const db = getDatabase();
    db.prepare("INSERT INTO users (id, display_name, is_gateway_admin) VALUES (?, ?, 1)")
      .run(manager.id, manager.displayName);
    db.prepare(`
      INSERT INTO health_members (id, display_name, relationship, created_by)
      VALUES ('trend-lifecycle-member', '本人', 'self', ?)
    `).run(manager.id);
    db.prepare(`
      INSERT INTO member_permissions (member_id, user_id, permission, granted_by)
      VALUES ('trend-lifecycle-member', ?, 'manager', ?)
    `).run(manager.id, manager.id);
    saveAiSettings({
      enabled: true,
      baseUrl: "https://ai.example.test/v1",
      textModel: "health-structurer",
      apiKey: "test-secret"
    });

    const upload = createUpload(manager, "trend-lifecycle-member", [
      { originalName: "trend-lifecycle.png", data: pngBytes() }
    ]);
    const worker: WorkerExecutor = async (request) => request.action === "thumbnail"
      ? { ok: true, width: 240, height: 320, elapsedMs: 5 }
      : {
          ok: true,
          engine: "test-ocr",
          modelVersion: "lifecycle-v1",
          lines: [
            { text: "报告编号：SYNTHETIC 采样时间：2026-07-22 08:30", confidence: 0.99 },
            { text: "检验结果 血糖 5.1 mmol/L", confidence: 0.99 }
          ],
          elapsedMs: 6
        };
    const ai: AiExecutor = async () => {
      const normalized = normalizeAiExtraction({
        reportType: "laboratory",
        title: "生命周期检验报告",
        reportIssuedAt: "2026-07-23",
        observations: [{
          itemName: "血糖",
          normalizedName: "血糖",
          resultText: "5.1",
          numericValue: 5.1,
          unit: "mmol/L",
          abnormalFlag: "normal",
          evidence: [{ pageNumber: 1, quote: "检验结果 血糖 5.1 mmol/L" }]
        }]
      });
      return {
        provider: "test-provider",
        model: "test-model",
        promptVersion: "test-v1",
        ...normalized,
        rawResponseJson: JSON.stringify(normalized),
        promptTokens: 10,
        completionTokens: 8,
        elapsedMs: 12
      };
    };

    assert.equal(await processNextJob(worker, ai), true);
    assert.equal(await processNextJob(worker, ai), true);
    assert.equal(await processNextJob(worker, ai), true);
    assert.equal(confirmReportReady(manager, upload.reportId).status, "ready");

    const initialPoints = listTrendSeries(manager, "trend-lifecycle-member")
      .flatMap((series) => series.points)
      .filter((point) => point.reportId === upload.reportId);
    assert.equal(initialPoints.length, 1);
    assert.equal(initialPoints[0]?.numericValue, 5.1);
    assert.equal(initialPoints[0]?.reportStatus, "ready");
    assert.equal(initialPoints[0]?.reportIssuedAt, "2026-07-22 08:30");
    assert.equal(initialPoints[0]?.timeKind, "sampled");
    const examinationId = initialPoints[0]?.examinationId;
    assert.ok(examinationId);

    const beforeDelete = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM reports WHERE id = ?) AS reports,
        (SELECT COUNT(*) FROM report_pages WHERE report_id = ?) AS pages,
        (SELECT COUNT(*) FROM ocr_results o JOIN report_pages p ON p.id = o.page_id WHERE p.report_id = ?) AS ocrResults,
        (SELECT COUNT(*) FROM observations WHERE report_id = ?) AS observations,
        (SELECT COUNT(*) FROM observation_normalizations n JOIN observations o ON o.id = n.observation_id WHERE o.report_id = ?) AS normalizations,
        (SELECT COUNT(*) FROM processing_jobs WHERE report_id = ?) AS jobs,
        (SELECT COUNT(*) FROM report_extractions WHERE report_id = ?) AS extractions
    `).get(
      upload.reportId,
      upload.reportId,
      upload.reportId,
      upload.reportId,
      upload.reportId,
      upload.reportId,
      upload.reportId
    ) as Record<string, number>;
    assert.equal(beforeDelete.reports, 1);
    assert.equal(beforeDelete.pages, 1);
    assert.equal(beforeDelete.ocrResults, 1);
    assert.equal(beforeDelete.observations, 1);
    assert.equal(beforeDelete.normalizations, 1);
    assert.equal(beforeDelete.jobs, 3);
    assert.equal(beforeDelete.extractions, 1);

    assert.equal(trashReport(manager, upload.reportId).status, "trashed");
    assert.equal(listTrendSeries(manager, "trend-lifecycle-member")
      .flatMap((series) => series.points)
      .some((point) => point.reportId === upload.reportId), false);

    assert.equal(restoreReport(manager, upload.reportId).status, "needs_review");
    const restoredPoints = listTrendSeries(manager, "trend-lifecycle-member")
      .flatMap((series) => series.points)
      .filter((point) => point.reportId === upload.reportId);
    assert.equal(restoredPoints.length, 1);
    assert.equal(restoredPoints[0]?.numericValue, 5.1);
    assert.equal(restoredPoints[0]?.reportStatus, "needs_review");
    assert.equal(restoredPoints[0]?.examinationId, examinationId);
    assert.equal(restoredPoints[0]?.reportIssuedAt, "2026-07-22 08:30");

    trashReport(manager, upload.reportId);
    assert.deepEqual(permanentlyDeleteReport(manager, upload.reportId), {
      id: upload.reportId,
      deleted: true,
      pendingFileCount: 0
    });
    const afterDelete = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM reports WHERE id = ?) AS reports,
        (SELECT COUNT(*) FROM report_pages WHERE report_id = ?) AS pages,
        (SELECT COUNT(*) FROM ocr_results WHERE page_id IN (SELECT id FROM report_pages WHERE report_id = ?)) AS ocrResults,
        (SELECT COUNT(*) FROM observations WHERE report_id = ?) AS observations,
        (SELECT COUNT(*) FROM observation_normalizations n JOIN observations o ON o.id = n.observation_id WHERE o.report_id = ?) AS normalizations,
        (SELECT COUNT(*) FROM processing_jobs WHERE report_id = ?) AS jobs,
        (SELECT COUNT(*) FROM report_extractions WHERE report_id = ?) AS extractions
    `).get(
      upload.reportId,
      upload.reportId,
      upload.reportId,
      upload.reportId,
      upload.reportId,
      upload.reportId,
      upload.reportId
    ) as Record<string, number>;
    for (const count of Object.values(afterDelete)) assert.equal(count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM report_examinations").get()?.n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM observation_examinations").get()?.n, 0);
    assert.equal(listTrendSeries(manager, "trend-lifecycle-member")
      .flatMap((series) => series.points)
      .some((point) => point.reportId === upload.reportId), false);
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
});
