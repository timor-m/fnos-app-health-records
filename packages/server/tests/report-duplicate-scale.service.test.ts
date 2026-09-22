import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { closeDatabaseForTests, getDatabase } from "../database/client.ts";
import type { RequestUser } from "../domain/request-user.ts";
import {
  listReportDuplicateDecisions,
  reportDuplicatePairKey,
  setReportDuplicateDecision
} from "../services/report-duplicate-governance.service.ts";
import { familyReportDuplicateRuleVersion } from "../services/report-duplicate-rules.service.ts";
import {
  duplicateReportScanPolicy,
  getDuplicateReportOverview,
  getReportDetail,
  mergeDuplicateReport
} from "../services/records.service.ts";

type ScaleFixture = {
  member: { id: string; displayName: string };
  scan: {
    totalReports: number;
    sourceReportLimit: number;
    candidateWindowLimit: number;
    oldLeftReportId: string;
    oldRightReportId: string;
    expectedSourceReportsWithGovernedPair: number;
    expectedGovernedCandidateOverrides: number;
    maximumCandidateComparisons: number;
  };
  benchmark: {
    totalReports: number;
    expectedSourceReports: number;
    maximumCandidateComparisons: number;
    maximumScanDurationMs: number;
  };
  candidateBenchmark: {
    totalReports: number;
    evidenceReports: number;
    expectedSourceReports: number;
    expectedCandidateComparisons: number;
    maximumCandidatePairs: number;
    maximumScanDurationMs: number;
  };
  merge: {
    sourceReportId: string;
    targetReportId: string;
    distinctLeftReportId: string;
    distinctRightReportId: string;
  };
};

const fixture = JSON.parse(readFileSync(
  new URL("./fixtures/p2-report-duplicate-scale-golden.json", import.meta.url),
  "utf8"
)) as ScaleFixture;

const admin: RequestUser = {
  id: "p2-duplicate-scale-admin",
  displayName: "P2 重复治理规模化管理员",
  provider: "development",
  authenticated: true,
  isGatewayAdmin: true
};

function seedIdentity() {
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
  return db;
}

function insertReport(id: string, title: string, updatedAt: string) {
  getDatabase().prepare(`
    INSERT INTO reports (
      id, member_id, created_by, report_type, title, status,
      body_parts_json, identifiers_json, updated_at
    ) VALUES (?, ?, ?, 'laboratory', ?, 'ready', '[]', '{}', ?)
  `).run(id, fixture.member.id, admin.id, title, updatedAt);
}

function insertEvidenceReport(id: string, updatedAt: string) {
  const db = getDatabase();
  db.prepare(`
    INSERT INTO reports (
      id, member_id, created_by, report_type, title, status, hospital_name_raw,
      report_issued_at, body_parts_json, identifiers_json, updated_at
    ) VALUES (?, ?, ?, 'laboratory', ?, 'ready', '匿名负载测试医院',
      '2026-08-02', '[]', '{}', ?)
  `).run(id, fixture.member.id, admin.id, `负载候选 ${id}`, updatedAt);
  const pageId=`${id}-page`,jobId=`${id}-ocr`;
  db.prepare("UPDATE reports SET title='合成检验面板', identifiers_json='{\"reportNo\":\"SYN-SCALE\"}' WHERE id=?").run(id);
  db.prepare("INSERT INTO report_pages(id,report_id,page_number,original_name,storage_path,mime_type,file_size,sha256) VALUES(?,?,1,'synthetic.png',?,'image/png',1,?)").run(pageId,id,pageId,id);
  db.prepare("INSERT INTO processing_jobs(id,report_id,page_id,job_type,status,pipeline_version,deduplication_key) VALUES(?,?,?,'ocr','completed','test',?)").run(jobId,id,pageId,jobId);
  const lines=['机构：合成负载测试医院','报告名称：合成检验面板','报告号：SYN-SCALE','采样时间：2026-08-02 09:00',...['甲','乙','丙','丁','戊','己'].map((name,i)=>`合成项目${name} ${i+1}.10 mmol/L 0-100`)].map((text,i)=>({id:`line-${i}`,text,confidence:.99,box:[0,i*20,520,i*20+14]}));
  db.prepare("INSERT INTO ocr_results(id,job_id,page_id,engine,model_version,lines_json) VALUES(?,?,?,'test','test',?)").run(`${id}-result`,jobId,pageId,JSON.stringify(lines));
  const insertObservation = db.prepare(`
    INSERT INTO observations (
      id, report_id, section_name, item_name, normalized_name, result_text, numeric_value, unit, abnormal_flag
    ) VALUES (?, ?, '生化检验', ?, ?, ?, ?, ?, 'normal')
  `);
  const observations = [
    ["总胆固醇", "4.26", 4.26, "mmol/L"],
    ["甘油三酯", "0.87", 0.87, "mmol/L"],
    ["高密度脂蛋白胆固醇", "1.42", 1.42, "mmol/L"],
    ["低密度脂蛋白胆固醇", "2.31", 2.31, "mmol/L"],
    ["空腹血糖", "5.18", 5.18, "mmol/L"],
    ["尿酸", "326", 326, "umol/L"]
  ] as const;
  for (const [index, observation] of observations.entries()) {
    insertObservation.run(
      `${id}-observation-${index}`,
      id,
      observation[0],
      observation[0],
      observation[1],
      observation[2],
      observation[3]
    );
  }
}

test("P2 scale golden keeps governed duplicate pairs visible beyond the 80/300 automatic windows", () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-p2-duplicate-scale-"));
  process.env.STORAGE_DIR = storageDir;
  try {
    seedIdentity();
    assert.equal(duplicateReportScanPolicy.sourceReportLimit, fixture.scan.sourceReportLimit);
    assert.equal(duplicateReportScanPolicy.candidateWindowLimit, fixture.scan.candidateWindowLimit);

    insertReport(fixture.scan.oldLeftReportId, "历史报告甲", "2020-01-01 00:00:01");
    insertReport(fixture.scan.oldRightReportId, "历史报告乙", "2020-01-01 00:00:02");
    for (let index = 0; index < fixture.scan.totalReports - 2; index += 1) {
      const day = String((index % 28) + 1).padStart(2, "0");
      const second = String(index % 60).padStart(2, "0");
      insertReport(
        `scale-filler-${String(index).padStart(3, "0")}`,
        `普通存档 ${index + 1}`,
        `2026-07-${day} 12:00:${second}`
      );
    }

    setReportDuplicateDecision(admin, {
      reportId: fixture.scan.oldLeftReportId,
      candidateReportId: fixture.scan.oldRightReportId,
      decision: "duplicate",
      reason: "规模化金标确认的历史重复关系"
    });

    const detailCandidate = getReportDetail(admin, fixture.scan.oldLeftReportId).duplicateCandidates
      .find((candidate) => candidate.id === fixture.scan.oldRightReportId);
    assert.ok(detailCandidate);
    assert.equal(detailCandidate.governanceDecision, "duplicate");
    assert.match(detailCandidate.reason, /人工已确认重复/);

    const overview = getDuplicateReportOverview(admin, fixture.member.id);
    const governedPair = overview.groups.flatMap((group) => group.candidates.map((candidate) => ({
      reportId: group.report.id,
      candidateId: candidate.id,
      governanceDecision: candidate.governanceDecision
    }))).find((pair) => new Set([pair.reportId, pair.candidateId]).has(fixture.scan.oldLeftReportId)
      && new Set([pair.reportId, pair.candidateId]).has(fixture.scan.oldRightReportId));
    assert.ok(governedPair);
    assert.equal(governedPair.governanceDecision, "duplicate");
    assert.equal(overview.metrics.sourceReportsScanned, fixture.scan.expectedSourceReportsWithGovernedPair);
    assert.equal(overview.metrics.governedCandidateOverrides, fixture.scan.expectedGovernedCandidateOverrides);
    assert.equal(overview.metrics.candidateComparisons, fixture.scan.maximumCandidateComparisons);
    assert.equal(overview.metrics.candidateGroups, 1);
    assert.equal(overview.metrics.candidatePairs, 1);
    assert.equal(overview.metrics.manualDuplicateDecisions, 1);
    assert.deepEqual(overview.metrics.scanPolicy, duplicateReportScanPolicy);
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
});

test("P2 bounded scan benchmark keeps 1,200 archived reports within the configured source window", (t) => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-p2-duplicate-benchmark-"));
  process.env.STORAGE_DIR = storageDir;
  try {
    seedIdentity();
    for (let index = 0; index < fixture.benchmark.totalReports; index += 1) {
      insertReport(
        `benchmark-report-${String(index).padStart(4, "0")}`,
        `基准存档 ${index + 1}`,
        `2026-08-01 12:${String(index % 60).padStart(2, "0")}:${String((index * 7) % 60).padStart(2, "0")}`
      );
    }
    const overview = getDuplicateReportOverview(admin, fixture.member.id);
    assert.equal(overview.metrics.sourceReportsScanned, fixture.benchmark.expectedSourceReports);
    assert.equal(overview.metrics.candidateComparisons, fixture.benchmark.maximumCandidateComparisons);
    assert.equal(overview.metrics.candidateGroups, 0);
    const duration = overview.metrics.scanDurationMs;
    const budget = fixture.benchmark.maximumScanDurationMs;
    t.diagnostic(`Duplicate scan: ${duration} ms; isolated benchmark budget: ${budget} ms`);
    // Wall time under the parallel full suite measures contention as well as scan work.
    // CI enforces the unchanged budget separately via test:duplicates:benchmark.
    if (process.env.DUPLICATE_SCAN_BENCHMARK === "1") {
      assert.ok(duration <= budget, `Duplicate scan took ${duration} ms, exceeding ${budget} ms`);
    }
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
});


test("P2 candidate benchmark exercises bounded comparisons across 1,200 reports with realistic structured evidence", (t) => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-p2-duplicate-candidate-benchmark-"));
  process.env.STORAGE_DIR = storageDir;
  try {
    seedIdentity();
    const fillerReports = fixture.candidateBenchmark.totalReports - fixture.candidateBenchmark.evidenceReports;
    for (let index = 0; index < fillerReports; index += 1) {
      insertReport(
        `candidate-filler-${String(index).padStart(4, "0")}`,
        `无候选存档 ${index + 1}`,
        `2026-08-01 10:${String(index % 60).padStart(2, "0")}:${String((index * 11) % 60).padStart(2, "0")}`
      );
    }
    for (let index = 0; index < fixture.candidateBenchmark.evidenceReports; index += 1) {
      insertEvidenceReport(
        `candidate-evidence-${String(index).padStart(3, "0")}`,
        `2026-08-02 10:${String(index % 60).padStart(2, "0")}:${String((index * 13) % 60).padStart(2, "0")}`
      );
    }

    const overview = getDuplicateReportOverview(admin, fixture.member.id);
    assert.equal(overview.metrics.sourceReportsScanned, fixture.candidateBenchmark.expectedSourceReports);
    assert.equal(overview.metrics.candidateComparisons, fixture.candidateBenchmark.expectedCandidateComparisons);
    assert.equal(overview.metrics.candidateGroups > 0, true);
    assert.equal(overview.metrics.candidatePairs > 0, true);
    assert.equal(overview.metrics.candidatePairs <= fixture.candidateBenchmark.maximumCandidatePairs, true);
    assert.equal(overview.metrics.highCandidates, overview.metrics.candidatePairs);
    const duration = overview.metrics.scanDurationMs;
    const budget = fixture.candidateBenchmark.maximumScanDurationMs;
    t.diagnostic(`Duplicate scan: ${duration} ms; isolated benchmark budget: ${budget} ms`);
    // Wall time under the parallel full suite measures contention as well as scan work.
    // CI enforces the unchanged budget separately via test:duplicates:benchmark.
    if (process.env.DUPLICATE_SCAN_BENCHMARK === "1") {
      assert.ok(duration <= budget, `Duplicate scan took ${duration} ms, exceeding ${budget} ms`);
    }
    assert.equal(overview.pagination.totalGroups, overview.metrics.candidateGroups);
    assert.equal(overview.pagination.totalPairs, overview.metrics.candidatePairs);
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
});

test("P2 scale golden records merge governance, audit evidence, and observable decision metrics", () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-p2-duplicate-merge-audit-"));
  process.env.STORAGE_DIR = storageDir;
  try {
    const db = seedIdentity();
    insertReport(fixture.merge.sourceReportId, "待合并重复报告", "2026-07-01 10:00:00");
    insertReport(fixture.merge.targetReportId, "保留目标报告", "2026-07-02 10:00:00");
    insertReport(fixture.merge.distinctLeftReportId, "不同报告甲", "2026-07-03 10:00:00");
    insertReport(fixture.merge.distinctRightReportId, "不同报告乙", "2026-07-04 10:00:00");
    db.prepare(`
      INSERT INTO report_pages (
        id, report_id, page_number, original_name, storage_path,
        mime_type, file_size, sha256, source_page_number, source_page_count
      ) VALUES (?, ?, 1, 'source.png', 'originals/source.png', 'image/png', 128, 'merge-source-sha', 1, 1)
    `).run("scale-merge-source-page", fixture.merge.sourceReportId);
    db.prepare(`
      INSERT INTO report_pages (
        id, report_id, page_number, original_name, storage_path,
        mime_type, file_size, sha256, source_page_number, source_page_count
      ) VALUES (?, ?, 1, 'target.png', 'originals/target.png', 'image/png', 128, 'merge-target-sha', 1, 1)
    `).run("scale-merge-target-page", fixture.merge.targetReportId);

    setReportDuplicateDecision(admin, {
      reportId: fixture.merge.distinctLeftReportId,
      candidateReportId: fixture.merge.distinctRightReportId,
      decision: "distinct",
      reason: "规模化金标确认的不同检查"
    });
    const mergeResult = mergeDuplicateReport(admin, fixture.merge.sourceReportId, fixture.merge.targetReportId);
    assert.equal(mergeResult.movedPages, 1);

    const mergePairKey = reportDuplicatePairKey(fixture.merge.sourceReportId, fixture.merge.targetReportId);
    const decisions = listReportDuplicateDecisions(admin, fixture.member.id);
    const mergeDecision = decisions.find((decision) => decision.pairKey === mergePairKey);
    assert.ok(mergeDecision);
    assert.equal(mergeDecision.decision, "duplicate");
    assert.equal(mergeDecision.leftStatus === "trashed" || mergeDecision.rightStatus === "trashed", true);
    assert.equal(mergeDecision.evidence.source, "merge");
    assert.equal(mergeDecision.evidence.sourceReportId, fixture.merge.sourceReportId);
    assert.equal(mergeDecision.evidence.targetReportId, fixture.merge.targetReportId);
    assert.equal(mergeDecision.evidence.movedPages, 1);
    assert.equal(mergeDecision.ruleVersion, familyReportDuplicateRuleVersion);
    assert.equal(mergeDecision.ruleSnapshot.ruleId, "manual.merge");

    const history = db.prepare(`
      SELECT event_type AS eventType, decision, reason, evidence_json AS evidenceJson
      FROM report_duplicate_history
      WHERE pair_key = ?
      ORDER BY created_at, rowid
    `).all(mergePairKey) as Array<{
      eventType: string;
      decision: string;
      reason: string;
      evidenceJson: string;
    }>;
    assert.equal(history.length, 1);
    assert.equal(history[0].eventType, "apply");
    assert.equal(history[0].decision, "duplicate");
    assert.equal(JSON.parse(history[0].evidenceJson).source, "merge");

    const auditActions = db.prepare(`
      SELECT action FROM audit_logs
      WHERE (target_type = 'report_pair' AND target_id = ?)
         OR (action = 'report.merge_duplicate' AND target_id = ?)
      ORDER BY action
    `).all(mergePairKey, fixture.merge.targetReportId) as Array<{ action: string }>;
    assert.deepEqual(auditActions.map((row) => row.action), [
      "report.duplicate_merge",
      "report.merge_duplicate"
    ]);

    const overview = getDuplicateReportOverview(admin, fixture.member.id);
    assert.equal(overview.metrics.manualDuplicateDecisions, 1);
    assert.equal(overview.metrics.manualDistinctDecisions, 1);
    assert.equal(overview.metrics.totalDecisionHistory, 2);
    assert.equal(overview.metrics.mergedPairs, 1);
    assert.equal(overview.metrics.duplicateConfirmRate, 0.5);
    assert.equal(overview.metrics.distinctRejectRate, 0.5);
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
});
