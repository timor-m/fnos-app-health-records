import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { RequestUser } from "../domain/request-user.ts";
import { closeDatabaseForTests, getDatabase } from "../database/client.ts";
import {
  getIndicatorNormalizationMetrics,
  listIndicatorNormalizationIssues,
  normalizeReportObservations
} from "../services/indicator-normalization.service.ts";
import { listTrendSeries } from "../services/records.service.ts";

type FixtureObservation = {
  id: string;
  sectionName: string;
  itemCode: string | null;
  itemName: string;
  normalizedName: string | null;
  resultText: string;
  numericValue: number | null;
  unit: string | null;
};

type FixtureReport = {
  id: string;
  reportType: string;
  title: string;
  reportIssuedAt: string;
  observations: FixtureObservation[];
};

const fixture = JSON.parse(readFileSync(
  new URL("./fixtures/p2-multi-report-golden.json", import.meta.url),
  "utf8"
)) as {
  member: { id: string; displayName: string };
  reports: FixtureReport[];
};

const admin: RequestUser = {
  id: "p2-golden-user",
  displayName: "回归管理员",
  provider: "development",
  authenticated: true,
  isGatewayAdmin: true
};

test("keeps multi-report normalization, provenance and aggregate quality metrics stable", () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-p2-multi-golden-"));
  process.env.STORAGE_DIR = storageDir;
  try {
    const db = getDatabase();
    db.prepare("INSERT INTO users (id, display_name, is_gateway_admin) VALUES (?, ?, 1)")
      .run(admin.id, admin.displayName);
    db.prepare(`
      INSERT INTO health_members (id, display_name, relationship, created_by)
      VALUES (?, ?, 'self', ?)
    `).run(fixture.member.id, fixture.member.displayName, admin.id);
    db.prepare(`
      INSERT INTO member_permissions (member_id, user_id, permission, granted_by)
      VALUES (?, ?, 'manager', ?)
    `).run(fixture.member.id, admin.id, admin.id);
    const insertReport = db.prepare(`
      INSERT INTO reports (
        id, member_id, created_by, report_type, title, status, report_issued_at
      ) VALUES (?, ?, ?, ?, ?, 'ready', ?)
    `);
    const insertObservation = db.prepare(`
      INSERT INTO observations (
        id, report_id, section_name, item_code, item_name, normalized_name,
        result_text, numeric_value, unit
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const results = [];
    for (const report of fixture.reports) {
      insertReport.run(
        report.id,
        fixture.member.id,
        admin.id,
        report.reportType,
        report.title,
        report.reportIssuedAt
      );
      for (const observation of report.observations) {
        insertObservation.run(
          observation.id,
          report.id,
          observation.sectionName,
          observation.itemCode,
          observation.itemName,
          observation.normalizedName,
          observation.resultText,
          observation.numericValue,
          observation.unit
        );
      }
      results.push(normalizeReportObservations(report.id));
    }

    assert.deepEqual(results, [
      { scanned: 5, normalized: 5, high: 5, medium: 0, low: 0, excluded: 0, unknown: 0 },
      { scanned: 3, normalized: 3, high: 3, medium: 0, low: 0, excluded: 0, unknown: 0 },
      { scanned: 3, normalized: 1, high: 1, medium: 0, low: 1, excluded: 1, unknown: 1 }
    ]);

    const trends = listTrendSeries(admin, fixture.member.id);
    const byKey = new Map(trends.map((series) => [series.indicatorKey, series]));
    assert.deepEqual(byKey.get("cbc_wbc")?.points.map((point) => point.numericValue), [5.2, 6.1]);
    assert.equal(byKey.get("cbc_wbc")?.latestChangeStatus, "increase");
    assert.equal(byKey.get("cbc_wbc")?.trendStatus, "insufficient_evidence", "two points must not be described as a sustained trend");
    assert.equal(byKey.get("cbc_wbc")?.outlierCount, 0);
    assert.equal(byKey.get("cbc_wbc")?.latestAbnormal, false);
    assert.equal(byKey.get("cbc_wbc")?.attentionPriority, "normal");
    // 身体质量指数 24.8 无报告参考范围，按字典中国成人标准（18.5~23.9）判为计算型偏高；
    // 其余指标没有可靠越界证据，不得虚构异常状态
    assert.deepEqual(
      trends.filter((series) => series.latestAbnormal).map((series) => series.indicatorKey),
      ["body_bmi"],
      "golden reports must not manufacture abnormal states without reliable evidence"
    );
    assert.deepEqual(byKey.get("cbc_hct")?.points.map((point) => point.numericValue), [48, 49]);
    assert.deepEqual(byKey.get("glucose_fasting")?.points.map((point) => point.numericValue), [5.4]);
    assert.deepEqual(byKey.get("urine_wbc")?.points.map((point) => point.numericValue), [12]);
    assert.equal(byKey.get("cbc_wbc")?.points.some((point) => point.reportId === "p2-urinalysis-2025"), false);
    assert.equal(trends.some((series) => series.indicatorKey === "urine_protein"), false);
    assert.equal(trends.some((series) => series.quality === "raw"), false);

    const urineWbc = db.prepare(`
      SELECT canonical_key AS canonicalKey, quality, source_origin AS sourceOrigin
      FROM observation_normalizations WHERE observation_id = 'p2-urine-wbc'
    `).get() as { canonicalKey: string; quality: string; sourceOrigin: string };
    assert.deepEqual({ ...urineWbc }, {
      canonicalKey: "urine_wbc",
      quality: "high",
      sourceOrigin: "item_name"
    });

    const issues = listIndicatorNormalizationIssues(admin);
    assert.deepEqual(issues.map((issue) => ({ rawName: issue.rawName, status: issue.status, count: issue.count })), [
      { rawName: "机构尿液内部评分", status: "unknown", count: 1 }
    ]);

    const metrics = getIndicatorNormalizationMetrics(admin);
    assert.deepEqual(metrics.totals, {
      reports: 3,
      observations: 11,
      normalizationRows: 11,
      mapped: 10,
      trendEligible: 9,
      needsReview: 1,
      reviewed: 0,
      issueGroups: 1,
      decisions: 0,
      userAliases: 0
    });
    assert.deepEqual(metrics.quality, { high: 9, medium: 0, low: 1, excluded: 1 });
    assert.deepEqual(metrics.reportTypes, [
      { reportType: "laboratory", reports: 2, observations: 6, mapped: 5, trendEligible: 4, needsReview: 1 },
      { reportType: "checkup", reports: 1, observations: 5, mapped: 5, trendEligible: 5, needsReview: 0 }
    ]);
    assert.equal(metrics.sourceOrigins.reduce((sum, row) => sum + row.count, 0), 11);
    assert.equal(metrics.sourceOrigins.reduce((sum, row) => sum + row.trendEligible, 0), 9);
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
});
