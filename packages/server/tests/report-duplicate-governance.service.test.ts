import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { closeDatabaseForTests, getDatabase } from "../database/client.ts";
import type { RequestUser } from "../domain/request-user.ts";
import { normalizeAllObservations } from "../services/indicator-normalization.service.ts";
import {
  listReportDuplicateDecisions,
  reportDuplicatePairKey,
  setReportDuplicateDecision,
  setReportDuplicateDecisionsBatch,
  shouldCollapseReportPair,
  undoReportDuplicateDecision,
  undoReportDuplicateDecisionsBatch
} from "../services/report-duplicate-governance.service.ts";
import {
  getDuplicateReportOverview,
  getReportDetail,
  getReportDuplicateComparison,
  listTrendSeries
} from "../services/records.service.ts";

type GoldenObservation = {
  id: string;
  name: string;
  normalizedName?: string;
  resultText: string;
  numericValue: number;
  unit: string | null;
};

type GoldenReport = {
  id: string;
  title: string;
  reportType: string;
  status: "ready" | "needs_review";
  hospitalName: string;
  reportIssuedAt: string;
  bodyParts: string[];
  fileSignature: string;
  observations: GoldenObservation[];
};

type GoldenFixture = {
  member: { id: string; displayName: string };
  reports: GoldenReport[];
};

const fixture = JSON.parse(readFileSync(
  new URL("./fixtures/p2-report-duplicate-golden.json", import.meta.url),
  "utf8"
)) as GoldenFixture;

const admin: RequestUser = {
  id: "p2-duplicate-admin",
  displayName: "重复报告回归管理员",
  provider: "development",
  authenticated: true,
  isGatewayAdmin: true
};

function seedFixture() {
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
      id, member_id, created_by, report_type, title, status,
      hospital_name_raw, body_parts_json, report_issued_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertPage = db.prepare(`
    INSERT INTO report_pages (
      id, report_id, page_number, original_name, storage_path,
      mime_type, file_size, sha256, source_page_number, source_page_count
    ) VALUES (?, ?, 1, ?, ?, 'image/png', 128, ?, 1, 1)
  `);
  const insertObservation = db.prepare(`
    INSERT INTO observations (
      id, report_id, section_name, item_name, normalized_name,
      result_text, numeric_value, unit, abnormal_flag
    ) VALUES (?, ?, '生化检验', ?, ?, ?, ?, ?, 'normal')
  `);

  for (const report of fixture.reports) {
    insertReport.run(
      report.id,
      fixture.member.id,
      admin.id,
      report.reportType,
      report.title,
      report.status,
      report.hospitalName,
      JSON.stringify(report.bodyParts.map((name) => ({ raw: name, name, parent: null, laterality: "unspecified" }))),
      report.reportIssuedAt
    );
    insertPage.run(
      `${report.id}-page-1`,
      report.id,
      `${report.id}.png`,
      `originals/${report.id}.png`,
      report.fileSignature
    );
    for (const observation of report.observations) {
      insertObservation.run(
        observation.id,
        report.id,
        observation.name,
        observation.normalizedName || observation.name,
        observation.resultText,
        observation.numericValue,
        observation.unit
      );
    }
  }
  normalizeAllObservations(admin);
  return db;
}

function trendReportIds(name: string) {
  const series = listTrendSeries(admin, fixture.member.id).find((item) => item.name === name);
  assert.ok(series, `missing trend series ${name}`);
  return series.points.map((point) => point.reportId);
}

test("P2 duplicate golden set keeps candidate detection independent from trend collapse", () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-p2-duplicate-golden-"));
  process.env.STORAGE_DIR = storageDir;
  try {
    const db = seedFixture();

    const sameOriginal = getReportDetail(admin, "same-original-right").duplicateCandidates
      .find((candidate) => candidate.id === "same-original-left");
    assert.ok(sameOriginal);
    assert.equal(sameOriginal.confidence, "high");
    assert.equal(sameOriginal.governanceDecision, null);
    assert.match(sameOriginal.reason, /原件内容完全一致/);
    assert.equal(shouldCollapseReportPair("same-original-left", "same-original-right"), true);
    const cholesterolIds = trendReportIds("总胆固醇");
    assert.equal(cholesterolIds.filter((id) => id.startsWith("same-original-")).length, 1);

    const hospitalAlias = getReportDetail(admin, "hospital-alias-right").duplicateCandidates
      .find((candidate) => candidate.id === "hospital-alias-left");
    assert.equal(hospitalAlias, undefined); // Background overlap alone is no longer a machine duplicate.
    assert.equal(shouldCollapseReportPair("hospital-alias-left", "hospital-alias-right"), false);
    assert.deepEqual(
      new Set(trendReportIds("甘油三酯").filter((id) => id.startsWith("hospital-alias-"))),
      new Set(["hospital-alias-left", "hospital-alias-right"])
    );

    assert.equal(
      getReportDetail(admin, "different-panel-right").duplicateCandidates
        .some((candidate) => candidate.id === "different-panel-left"),
      false
    );

    const applied = setReportDuplicateDecision(admin, {
      reportId: "hospital-alias-left",
      candidateReportId: "hospital-alias-right",
      decision: "duplicate",
      reason: "金标回归：等价机构名称且六项指标完全重合",
      evidence: { source: "manual-review" }
    });
    assert.ok(applied);
    assert.equal(applied.pairKey, reportDuplicatePairKey("hospital-alias-left", "hospital-alias-right"));
    assert.equal(shouldCollapseReportPair("hospital-alias-left", "hospital-alias-right"), true);
    assert.deepEqual(
      trendReportIds("甘油三酯").filter((id) => id.startsWith("hospital-alias-")),
      ["hospital-alias-left"]
    );
    const governedCandidate = getReportDetail(admin, "hospital-alias-right").duplicateCandidates
      .find((candidate) => candidate.id === "hospital-alias-left");
    assert.equal(governedCandidate?.governanceDecision, "duplicate");
    assert.match(governedCandidate?.reason || "", /人工已确认重复/);

    const distinct = setReportDuplicateDecision(admin, {
      reportId: "hospital-alias-left",
      candidateReportId: "hospital-alias-right",
      decision: "distinct",
      reason: "金标回归：人工确认是两次独立检查"
    });
    assert.ok(distinct);
    assert.equal(shouldCollapseReportPair("hospital-alias-left", "hospital-alias-right"), false);
    assert.equal(
      getReportDetail(admin, "hospital-alias-right").duplicateCandidates
        .some((candidate) => candidate.id === "hospital-alias-left"),
      false
    );
    assert.deepEqual(
      new Set(trendReportIds("甘油三酯").filter((id) => id.startsWith("hospital-alias-"))),
      new Set(["hospital-alias-left", "hospital-alias-right"])
    );

    const decisions = listReportDuplicateDecisions(admin, fixture.member.id);
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0].decision, "distinct");
    assert.equal(decisions[0].decidedByName, admin.displayName);

    undoReportDuplicateDecision(admin, distinct.pairKey);
    assert.equal(listReportDuplicateDecisions(admin, fixture.member.id).length, 0);
    assert.equal(
      getReportDetail(admin, "hospital-alias-right").duplicateCandidates
        .some((candidate) => candidate.id === "hospital-alias-left"),
      false
    );
    assert.equal(shouldCollapseReportPair("hospital-alias-left", "hospital-alias-right"), false);

    const history = db.prepare(`
      SELECT event_type AS eventType, decision
      FROM report_duplicate_history
      WHERE pair_key = ?
      ORDER BY created_at, rowid
    `).all(distinct.pairKey) as Array<{ eventType: string; decision: string }>;
    assert.deepEqual(history.map((row) => ({ ...row })), [
      { eventType: "apply", decision: "duplicate" },
      { eventType: "apply", decision: "distinct" },
      { eventType: "undo", decision: "distinct" }
    ]);
    const auditCount = db.prepare(`
      SELECT COUNT(*) AS count FROM audit_logs
      WHERE target_type = 'report_pair' AND target_id = ?
    `).get(distinct.pairKey) as { count: number };
    assert.equal(auditCount.count, 3);
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
});

test("P2 quality closure batches decisions atomically and previews structured differences before merge", () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-p2-duplicate-quality-"));
  process.env.STORAGE_DIR = storageDir;
  try {
    const db = seedFixture();
    const aliasComparison = getReportDuplicateComparison(admin, "hospital-alias-left", "hospital-alias-right");
    assert.equal(aliasComparison.observations.shared, 6);
    assert.equal(aliasComparison.observations.conflicts, 0);
    assert.equal(aliasComparison.observations.leftOnly, 0);
    assert.equal(aliasComparison.observations.rightOnly, 0);
    assert.equal(aliasComparison.fields.find((field) => field.key === "hospitalName")?.equal, false);

    const differentComparison = getReportDuplicateComparison(admin, "different-panel-left", "different-panel-right");
    assert.equal(differentComparison.observations.shared, 1);
    assert.equal(differentComparison.observations.leftOnly, 5);
    assert.equal(differentComparison.observations.rightOnly, 5);
    assert.equal(differentComparison.observations.differences.length, 10);

    const batch = setReportDuplicateDecisionsBatch(admin, [
      {
        reportId: "same-original-left",
        candidateReportId: "same-original-right",
        decision: "duplicate",
        reason: "批量金标：原件一致",
        evidence: { confidence: "high", matchedFields: ["原始文件", "报告类型"] }
      },
      {
        reportId: "different-panel-left",
        candidateReportId: "different-panel-right",
        decision: "distinct",
        reason: "批量金标：检验面板不同",
        evidence: { confidence: "medium", matchedFields: ["医院", "报告日期", "报告类型"] }
      }
    ]);
    assert.equal(batch.applied, 2);
    assert.equal(batch.duplicateCount, 1);
    assert.equal(batch.distinctCount, 1);
    assert.equal(new Set(batch.pairKeys).size, 2);

    const decisions = listReportDuplicateDecisions(admin, fixture.member.id);
    assert.equal(decisions.length, 2);
    assert.equal(decisions.every((decision) => decision.evidence.governanceSource === "batch"), true);
    const historyCount = db
      .prepare("SELECT COUNT(*) AS count FROM report_duplicate_history")
      .get() as { count: number };
    const batchAuditCount = db
      .prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'report.duplicate_batch'")
      .get() as { count: number };
    assert.equal(historyCount.count, 2);
    assert.equal(batchAuditCount.count, 1);

    const overview = getDuplicateReportOverview(admin, fixture.member.id);
    assert.equal(overview.metrics.manualDuplicateDecisions, 1);
    assert.equal(overview.metrics.manualDistinctDecisions, 1);
    assert.equal(overview.metrics.scanDurationMs >= 0, true);
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
});


test("P2 duplicate overview filters and paginates candidates without changing full scan metrics", () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-p2-duplicate-pagination-"));
  process.env.STORAGE_DIR = storageDir;
  try {
    seedFixture();
    // Keep pagination coverage using an explicit human decision instead of the retired alias heuristic.
    setReportDuplicateDecision(admin,{reportId:"hospital-alias-left",candidateReportId:"hospital-alias-right",decision:"duplicate"});
    const firstPage = getDuplicateReportOverview(admin, fixture.member.id, { page: 1, pageSize: 1 });
    assert.equal(firstPage.pagination.totalGroups, 2);
    assert.equal(firstPage.pagination.totalPairs, 2);
    assert.equal(firstPage.pagination.totalPages, 2);
    assert.equal(firstPage.groups.length, 1);
    assert.equal(firstPage.metrics.candidateGroups, 2);
    assert.equal(firstPage.metrics.candidatePairs, 2);

    const secondPage = getDuplicateReportOverview(admin, fixture.member.id, { page: 2, pageSize: 1 });
    assert.equal(secondPage.pagination.page, 2);
    assert.equal(secondPage.groups.length, 1);
    assert.notEqual(secondPage.groups[0].report.id, firstPage.groups[0].report.id);
    assert.equal(secondPage.metrics.candidateGroups, firstPage.metrics.candidateGroups);

    const highOnly = getDuplicateReportOverview(admin, fixture.member.id, { confidence: "high" });
    assert.equal(highOnly.pagination.totalPairs, 2);
    assert.equal(highOnly.groups[0].candidates[0].confidence, "high");
    const mediumOnly = getDuplicateReportOverview(admin, fixture.member.id, { confidence: "medium" });
    assert.equal(mediumOnly.pagination.totalPairs, 0);
    const hospitalOnly = getDuplicateReportOverview(admin, fixture.member.id, { hospital: "安徽滨湖国宾健康体检中心" });
    assert.equal(hospitalOnly.pagination.totalPairs, 1);
    const searched = getDuplicateReportOverview(admin, fixture.member.id, { query: "国宾" });
    assert.equal(searched.pagination.totalPairs, 1);
    assert.equal(firstPage.filterOptions.hospitals.includes("安徽滨湖国宾健康体检中心"), true);
    assert.equal(firstPage.filterOptions.reportTypes.includes("laboratory"), true);
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
});

test("P2 batch undo is atomic and records per-pair plus batch audit history", () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-p2-duplicate-batch-undo-"));
  process.env.STORAGE_DIR = storageDir;
  try {
    const db = seedFixture();
    const applied = setReportDuplicateDecisionsBatch(admin, [
      {
        reportId: "same-original-left",
        candidateReportId: "same-original-right",
        decision: "duplicate",
        evidence: { confidence: "high", matchedFields: ["原始文件"] }
      },
      {
        reportId: "different-panel-left",
        candidateReportId: "different-panel-right",
        decision: "distinct",
        evidence: { confidence: "medium", matchedFields: ["医院", "报告类型"] }
      }
    ]);
    const undone = undoReportDuplicateDecisionsBatch(admin, applied.pairKeys);
    assert.equal(undone.undone, 2);
    assert.deepEqual(undone.pairKeys, applied.pairKeys);
    assert.equal(listReportDuplicateDecisions(admin, fixture.member.id).length, 0);

    const history = db.prepare(`
      SELECT event_type AS eventType, COUNT(*) AS count
      FROM report_duplicate_history
      GROUP BY event_type
      ORDER BY event_type
    `).all() as Array<{ eventType: string; count: number }>;
    assert.deepEqual(history.map((row) => ({ ...row })), [
      { eventType: "apply", count: 2 },
      { eventType: "undo", count: 2 }
    ]);
    const perPairUndoAudits = db.prepare(`
      SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'report.duplicate_decision_undo'
    `).get() as { count: number };
    const batchUndoAudits = db.prepare(`
      SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'report.duplicate_batch_undo'
    `).get() as { count: number };
    assert.equal(perPairUndoAudits.count, 2);
    assert.equal(batchUndoAudits.count, 1);

    const reapplied = setReportDuplicateDecisionsBatch(admin, [
      { reportId: "same-original-left", candidateReportId: "same-original-right", decision: "duplicate" },
      { reportId: "hospital-alias-left", candidateReportId: "hospital-alias-right", decision: "distinct" }
    ]);
    assert.throws(
      () => undoReportDuplicateDecisionsBatch(admin, [reapplied.pairKeys[0], "missing:pair"]),
      /不存在/
    );
    assert.equal(listReportDuplicateDecisions(admin, fixture.member.id).length, 2);
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
});


