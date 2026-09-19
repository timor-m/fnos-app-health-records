import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { closeDatabaseForTests, getDatabase } from "../database/client.ts";
import type { RequestUser } from "../domain/request-user.ts";
import {
  countIndicatorGovernanceHistory,
  getIndicatorNormalizationMetrics,
  listIndicatorAliasGovernance,
  listIndicatorGovernanceHistory,
  listIndicatorNormalizationIssues,
  normalizeAllObservationsFromDictionary,
  normalizeReportObservations,
  previewIndicatorNormalization,
  resolveIndicatorNormalizationIssue,
  searchIndicatorCatalog,
  setIndicatorAliasEnabled,
  undoIndicatorGovernanceDecision
} from "../services/indicator-normalization.service.ts";
import { listTrendSeries } from "../services/records.service.ts";
import { installRemoteDictionarySnapshotForTests } from "../services/indicator-dictionary.service.ts";

const admin: RequestUser = {
  id: "governance-admin",
  displayName: "治理管理员",
  provider: "development",
  authenticated: true,
  isGatewayAdmin: true
};

function insertReport(id: string, issuedAt: string) {
  getDatabase().prepare(`
    INSERT INTO reports (id, member_id, created_by, report_type, title, status, report_issued_at)
    VALUES (?, 'governance-member', ?, 'laboratory', ?, 'ready', ?)
  `).run(id, admin.id, `匿名报告-${id}`, issuedAt);
}

test("persists indicator confirmations, exclusions and report-type aliases across full reruns", async () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-indicator-governance-"));
  process.env.STORAGE_DIR = storageDir;
  try {
    const db = getDatabase();
    db.prepare("INSERT INTO users (id, display_name, is_gateway_admin) VALUES (?, ?, 1)")
      .run(admin.id, admin.displayName);
    db.prepare(`
      INSERT INTO health_members (id, display_name, relationship, created_by)
      VALUES ('governance-member', '匿名成员', 'self', ?)
    `).run(admin.id);
    db.prepare(`
      INSERT INTO member_permissions (member_id, user_id, permission, granted_by)
      VALUES ('governance-member', ?, 'manager', ?)
    `).run(admin.id, admin.id);

    insertReport("governance-report-1", "2026-07-01");
    db.prepare(`
      INSERT INTO observations (
        id, report_id, section_name, item_name, normalized_name, result_text, numeric_value, unit
      ) VALUES (
        'governance-confirmed', 'governance-report-1', '血常规',
        '机构自定义白细胞', '机构自定义白细胞', '6.2', 6.2, '10^9/L'
      )
    `).run();
    normalizeReportObservations("governance-report-1");

    const issue = listIndicatorNormalizationIssues(admin)
      .find((item) => item.rawName === "机构自定义白细胞");
    assert.ok(issue);
    const catalog = searchIndicatorCatalog(admin, "白细胞计数");
    assert.equal(catalog.some((item) => item.canonicalKey === "cbc_wbc"), true);

    const confirmed = resolveIndicatorNormalizationIssue(admin, {
      fingerprint: issue.fingerprint,
      action: "confirm",
      canonicalKey: "cbc_wbc",
      saveAlias: true,
      aliasScope: "report_type",
      reason: "金标人工确认"
    });
    assert.deepEqual(confirmed, {
      fingerprint: issue.fingerprint,
      action: "confirm",
      affectedObservations: 1,
      normalized: 1,
      excluded: 0,
      pending: 0,
      remainingReasons: [],
      aliasSaved: true,
      canonicalKey: "cbc_wbc"
    });
    const confirmedRow = db.prepare(`
      SELECT canonical_key AS canonicalKey, quality, matched_by AS matchedBy,
        source_origin AS sourceOrigin, source_name AS sourceName, alias_source AS aliasSource,
        review_status AS reviewStatus, reviewed_by AS reviewedBy
      FROM observation_normalizations WHERE observation_id = 'governance-confirmed'
    `).get() as Record<string, unknown>;
    assert.deepEqual({ ...confirmedRow }, {
      canonicalKey: "cbc_wbc",
      quality: "high",
      matchedBy: "manual_confirmation",
      sourceOrigin: "manual_confirmation",
      sourceName: "机构自定义白细胞",
      aliasSource: "user",
      reviewStatus: "confirmed",
      reviewedBy: admin.id
    });
    assert.equal(listIndicatorNormalizationIssues(admin).some((item) => item.fingerprint === issue.fingerprint), false);

    insertReport("governance-report-2", "2026-08-01");
    db.prepare(`
      INSERT INTO observations (
        id, report_id, section_name, item_name, normalized_name, result_text, numeric_value, unit
      ) VALUES (
        'governance-alias', 'governance-report-2', '复查结果',
        '机构自定义白细胞', NULL, '7.1', 7.1, '10^9/L'
      )
    `).run();
    normalizeReportObservations("governance-report-2");
    const aliasRow = db.prepare(`
      SELECT canonical_key AS canonicalKey, quality, matched_by AS matchedBy,
        source_origin AS sourceOrigin, alias_source AS aliasSource, review_status AS reviewStatus
      FROM observation_normalizations WHERE observation_id = 'governance-alias'
    `).get() as Record<string, unknown>;
    assert.deepEqual({ ...aliasRow }, {
      canonicalKey: "cbc_wbc",
      quality: "high",
      matchedBy: "user_alias",
      sourceOrigin: "item_name",
      aliasSource: "user",
      reviewStatus: "unreviewed"
    });

    db.prepare(`
      INSERT INTO observations (
        id, report_id, section_name, item_name, normalized_name, result_text, numeric_value, unit
      ) VALUES (
        'governance-excluded', 'governance-report-2', '特殊检查',
        '仅供描述的内部评分', '仅供描述的内部评分', '8', 8, '分'
      )
    `).run();
    normalizeReportObservations("governance-report-2");
    const excludedIssue = listIndicatorNormalizationIssues(admin)
      .find((item) => item.rawName === "仅供描述的内部评分");
    assert.ok(excludedIssue);
    const excluded = resolveIndicatorNormalizationIssue(admin, {
      fingerprint: excludedIssue.fingerprint,
      action: "exclude",
      reason: "该评分没有跨报告趋势意义"
    });
    assert.equal(excluded.excluded, 1);

    const beforePreview = db.prepare("SELECT * FROM observation_normalizations ORDER BY observation_id").all();
    const decisionsBefore = db.prepare("SELECT * FROM indicator_governance_decisions ORDER BY fingerprint").all();
    const preview = previewIndicatorNormalization(admin);
    assert.equal(preview.scanned, 3);
    assert.equal(preview.eligible, 2);
    assert.equal(preview.excluded, 1);
    assert.equal(preview.removed, 0);
    assert.deepEqual(db.prepare("SELECT * FROM observation_normalizations ORDER BY observation_id").all(), beforePreview);
    assert.deepEqual(db.prepare("SELECT * FROM indicator_governance_decisions ORDER BY fingerprint").all(), decisionsBefore);
    assert.throws(() => previewIndicatorNormalization({ ...admin, isGatewayAdmin: false, provider: "fnos_gateway" }), /仅管理员/);
    const executed = await normalizeAllObservationsFromDictionary(admin, { full: true });
    assert.equal(executed.normalized, preview.eligible);
    db.prepare("UPDATE observation_normalizations SET quality = 'low' WHERE observation_id = 'governance-confirmed'").run();
    const stalePreview = previewIndicatorNormalization(admin);
    assert.equal(stalePreview.recovered, 1);
    assert.equal(stalePreview.removed, 0);
    assert.equal((db.prepare("SELECT quality FROM observation_normalizations WHERE observation_id = 'governance-confirmed'").get() as { quality: string }).quality, 'low');
    await normalizeAllObservationsFromDictionary(admin, { full: true });
    const afterRerun = db.prepare(`
      SELECT observation_id AS observationId, canonical_key AS canonicalKey,
        quality, matched_by AS matchedBy, source_origin AS sourceOrigin, review_status AS reviewStatus
      FROM observation_normalizations
      WHERE observation_id IN ('governance-confirmed', 'governance-excluded')
      ORDER BY observation_id
    `).all() as Array<Record<string, unknown>>;
    assert.deepEqual(afterRerun.map((row) => ({ ...row })), [
      {
        observationId: "governance-confirmed",
        canonicalKey: "cbc_wbc",
        quality: "high",
        matchedBy: "manual_confirmation",
        sourceOrigin: "manual_confirmation",
        reviewStatus: "confirmed"
      },
      {
        observationId: "governance-excluded",
        canonicalKey: null,
        quality: "excluded",
        matchedBy: "manual_exclusion",
        sourceOrigin: "manual_exclusion",
        reviewStatus: "excluded"
      }
    ]);
    assert.equal(listIndicatorNormalizationIssues(admin).some((item) =>
      item.rawName === "机构自定义白细胞" || item.rawName === "仅供描述的内部评分"
    ), false);

    const wbcTrend = listTrendSeries(admin, "governance-member")
      .find((series) => series.indicatorKey === "cbc_wbc");
    assert.deepEqual(wbcTrend?.points.map((point) => point.numericValue), [6.2, 7.1]);

    const metrics = getIndicatorNormalizationMetrics(admin);
    assert.deepEqual(metrics.totals, {
      reports: 2,
      observations: 3,
      normalizationRows: 3,
      mapped: 2,
      trendEligible: 2,
      needsReview: 0,
      reviewed: 2,
      issueGroups: 0,
      decisions: 2,
      userAliases: 1
    });
    assert.deepEqual(metrics.quality, { high: 2, medium: 0, low: 0, excluded: 1 });


    const appliedHistory = listIndicatorGovernanceHistory(admin);
    assert.equal(appliedHistory.filter((item) => item.eventType === "apply").length, 2);
    assert.equal(appliedHistory.find((item) => item.fingerprint === issue.fingerprint)?.canUndo, true);
    const aliasOverview = listIndicatorAliasGovernance(admin);
    assert.equal(aliasOverview.aliases.length, 1);
    assert.equal(aliasOverview.aliases[0]?.enabled, true);
    assert.equal(aliasOverview.aliases[0]?.usageCount, 2);
    assert.equal(aliasOverview.conflicts.length, 0);

    const undoExcluded = undoIndicatorGovernanceDecision(admin, excludedIssue.fingerprint, "撤销排除回归");
    assert.deepEqual(undoExcluded, {
      fingerprint: excludedIssue.fingerprint,
      action: "exclude",
      affectedObservations: 1,
      aliasDisabled: false,
      remainingMapped: 0,
      reopenedIssues: 1
    });
    assert.equal(listIndicatorNormalizationIssues(admin).some((item) =>
      item.fingerprint === excludedIssue.fingerprint && item.status === "unknown"
    ), true);

    const undoConfirmed = undoIndicatorGovernanceDecision(admin, issue.fingerprint, "撤销确认回归");
    assert.deepEqual(undoConfirmed, {
      fingerprint: issue.fingerprint,
      action: "confirm",
      affectedObservations: 2,
      aliasDisabled: true,
      remainingMapped: 0,
      reopenedIssues: 2
    });
    assert.equal(listIndicatorAliasGovernance(admin).aliases[0]?.enabled, false);
    assert.equal(listIndicatorNormalizationIssues(admin)
      .filter((item) => item.rawName === "机构自定义白细胞")
      .reduce((total, item) => total + item.count, 0), 2);
    assert.equal(listTrendSeries(admin, "governance-member").some((series) => series.indicatorKey === "cbc_wbc"), false);
    const finalHistory = listIndicatorGovernanceHistory(admin);
    assert.equal(finalHistory.filter((item) => item.eventType === "undo").length, 2);
    assert.equal(finalHistory.some((item) => item.canUndo), false);
    assert.equal(countIndicatorGovernanceHistory(admin), finalHistory.length);
    const pagedHistory = listIndicatorGovernanceHistory(admin, 2, 2);
    assert.deepEqual(pagedHistory.map((item) => item.id), finalHistory.slice(2).map((item) => item.id));
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
});


test("keeps evidence-failure observations out of the dictionary governance pool", () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-indicator-evidence-gate-"));
  process.env.STORAGE_DIR = storageDir;
  try {
    const db = getDatabase();
    db.prepare("INSERT INTO users (id, display_name, is_gateway_admin) VALUES (?, ?, 1)")
      .run(admin.id, admin.displayName);
    db.prepare(`
      INSERT INTO health_members (id, display_name, relationship, created_by)
      VALUES ('governance-member', '匿名成员', 'self', ?)
    `).run(admin.id);
    db.prepare(`
      INSERT INTO member_permissions (member_id, user_id, permission, granted_by)
      VALUES ('governance-member', ?, 'manager', ?)
    `).run(admin.id, admin.id);
    insertReport("governance-evidence-report", "2026-08-01");
    db.prepare(`
      INSERT INTO observations (
        id, report_id, section_name, item_name, normalized_name, result_text, numeric_value, unit
      ) VALUES (
        'governance-evidence-failure', 'governance-evidence-report', '特殊检查',
        '证据失败候选', '证据失败候选', '7.2', 7.2, 'U/L'
      )
    `).run();
    normalizeReportObservations("governance-evidence-report");
    assert.equal(listIndicatorNormalizationIssues(admin).some((item) => item.rawName === "证据失败候选"), true);

    db.prepare(`
      UPDATE observation_normalizations
      SET quality = 'low', excluded_reason = '结果数值无法回指 OCR 证据，禁止进入默认趋势'
      WHERE observation_id = 'governance-evidence-failure'
    `).run();
    assert.equal(listIndicatorNormalizationIssues(admin).some((item) => item.rawName === "证据失败候选"), false);
    assert.equal(getIndicatorNormalizationMetrics(admin).totals.needsReview, 0);
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
});

test("keeps design-gated qualitative indicators out of the dictionary governance pool", () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-indicator-qualitative-gate-"));
  process.env.STORAGE_DIR = storageDir;
  try {
    const db = getDatabase();
    db.prepare("INSERT INTO users (id, display_name, is_gateway_admin) VALUES (?, ?, 1)")
      .run(admin.id, admin.displayName);
    db.prepare(`
      INSERT INTO health_members (id, display_name, relationship, created_by)
      VALUES ('governance-member', '匿名成员', 'self', ?)
    `).run(admin.id);
    db.prepare(`
      INSERT INTO member_permissions (member_id, user_id, permission, granted_by)
      VALUES ('governance-member', ?, 'manager', ?)
    `).run(admin.id, admin.id);
    insertReport("governance-qualitative-report", "2026-08-02");
    db.prepare(`
      INSERT INTO observations (
        id, report_id, section_name, item_name, normalized_name, result_text, numeric_value, unit
      ) VALUES (
        'governance-qualitative-protein', 'governance-qualitative-report', '尿常规',
        '尿蛋白', '尿蛋白', '阴性', null, null
      )
    `).run();
    normalizeReportObservations("governance-qualitative-report");

    const normalized = db.prepare(`
      SELECT canonical_key AS canonicalKey, quality, excluded_reason AS excludedReason
      FROM observation_normalizations
      WHERE observation_id = 'governance-qualitative-protein'
    `).get() as { canonicalKey: string | null; quality: string; excludedReason: string | null };
    assert.equal(normalized.canonicalKey, "urine_protein");
    assert.equal(normalized.quality, "excluded");
    assert.match(normalized.excludedReason || "", /不默认进入折线趋势/);

    // 定性守门是字典的既定口径而非治理缺口：不入池、不计入待治理统计
    assert.equal(listIndicatorNormalizationIssues(admin).some((item) => item.rawName === "尿蛋白"), false);
    const metrics = getIndicatorNormalizationMetrics(admin);
    assert.equal(metrics.totals.needsReview, 0);
    assert.equal(metrics.totals.issueGroups, 0);
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
});

test("detects conflicting user aliases and records safe enable or disable changes", () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-indicator-alias-conflict-"));
  process.env.STORAGE_DIR = storageDir;
  try {
    const db = getDatabase();
    db.prepare("INSERT INTO users (id, display_name, is_gateway_admin) VALUES (?, ?, 1)")
      .run(admin.id, admin.displayName);
    searchIndicatorCatalog(admin, "白细胞");
    const indicators = db.prepare(`
      SELECT id, canonical_key AS canonicalKey FROM indicator_catalog
      WHERE canonical_key IN ('cbc_wbc', 'cbc_hct')
      ORDER BY canonical_key
    `).all() as Array<{ id: string; canonicalKey: string }>;
    const indicatorIds = new Map(indicators.map((row) => [row.canonicalKey, row.id]));
    db.prepare(`
      INSERT INTO indicator_aliases (
        id, indicator_id, alias_name, normalized_alias, scope, report_type,
        source, confidence, enabled
      ) VALUES (?, ?, ?, ?, 'report_type', 'laboratory', 'user', 1, 1)
    `).run("alias-conflict-wbc", indicatorIds.get("cbc_wbc")!, "机构冲突代码", "机构冲突代码");
    db.prepare(`
      INSERT INTO indicator_aliases (
        id, indicator_id, alias_name, normalized_alias, scope, report_type,
        source, confidence, enabled
      ) VALUES (?, ?, ?, ?, 'report_type', 'laboratory', 'user', 1, 1)
    `).run("alias-conflict-hct", indicatorIds.get("cbc_hct")!, "机构冲突代码", "机构冲突代码");

    const conflicted = listIndicatorAliasGovernance(admin);
    assert.equal(conflicted.conflicts.length, 1);
    assert.equal(conflicted.conflicts[0]?.targets.length, 2);
    assert.equal(conflicted.aliases.every((item) => item.conflictCount === 1), true);

    const disabled = setIndicatorAliasEnabled(admin, "alias-conflict-hct", false, "保留白细胞映射");
    assert.deepEqual(disabled, {
      aliasId: "alias-conflict-hct",
      enabled: false,
      affectedObservations: 0,
      normalized: 0,
      reopenedIssues: 0
    });
    assert.equal(listIndicatorAliasGovernance(admin).conflicts.length, 0);
    assert.throws(
      () => setIndicatorAliasEnabled(admin, "alias-conflict-hct", true),
      /冲突/
    );
    assert.equal(listIndicatorGovernanceHistory(admin)[0]?.eventType, "alias_disable");
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
});

test("keeps incompatible units raw across manual confirmation, saved aliases, reruns and undo", async () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-indicator-unit-governance-"));
  process.env.STORAGE_DIR = storageDir;
  try {
    const db = getDatabase();
    installRemoteDictionarySnapshotForTests();
    db.prepare("INSERT INTO users (id, display_name, is_gateway_admin) VALUES (?, ?, 1)")
      .run(admin.id, admin.displayName);
    db.prepare(`
      INSERT INTO health_members (id, display_name, relationship, created_by)
      VALUES ('governance-member', '匿名成员', 'self', ?)
    `).run(admin.id);
    db.prepare(`
      INSERT INTO member_permissions (member_id, user_id, permission, granted_by)
      VALUES ('governance-member', ?, 'manager', ?)
    `).run(admin.id, admin.id);

    const insertObservation = db.prepare(`
      INSERT INTO observations (
        id, report_id, section_name, item_name, normalized_name, result_text, numeric_value, unit
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    insertReport("unit-governance-report-1", "2026-05-01");
    insertObservation.run(
      "unit-governance-manual-incompatible",
      "unit-governance-report-1",
      "内分泌初筛",
      "机构自定义泌乳素",
      "机构自定义泌乳素",
      "480",
      480,
      "mIU/L"
    );
    normalizeReportObservations("unit-governance-report-1");

    const issue = listIndicatorNormalizationIssues(admin)
      .find((item) => item.rawName === "机构自定义泌乳素");
    assert.ok(issue);
    assert.equal(issue.resultText, "480");
    assert.equal(issue.unit, "mIU/L");

    const confirmed = resolveIndicatorNormalizationIssue(admin, {
      fingerprint: issue.fingerprint,
      action: "confirm",
      canonicalKey: "laboratory_prolactin",
      saveAlias: true,
      aliasScope: "report_type",
      reason: "只确认指标身份，不猜测单位换算"
    });
    assert.equal(confirmed.normalized, 0);
    assert.equal(confirmed.excluded, 0);
    assert.equal(confirmed.pending, confirmed.affectedObservations - confirmed.normalized);
    assert.ok(confirmed.pending > 0);
    assert.ok(confirmed.remainingReasons.some(item => /单位/.test(item.reason) && item.count > 0));
    assert.equal(confirmed.aliasSaved, true);

    insertReport("unit-governance-report-2", "2026-06-01");
    insertObservation.run(
      "unit-governance-alias-compatible",
      "unit-governance-report-2",
      "内分泌复查",
      "机构自定义泌乳素",
      null,
      "20",
      20,
      "μg/L"
    );
    normalizeReportObservations("unit-governance-report-2");

    insertReport("unit-governance-report-3", "2026-07-01");
    insertObservation.run(
      "unit-governance-alias-incompatible",
      "unit-governance-report-3",
      "内分泌随访",
      "机构自定义泌乳素",
      null,
      "510",
      510,
      "mIU/L"
    );
    normalizeReportObservations("unit-governance-report-3");

    const readRows = () => db.prepare(`
      SELECT observation_id AS observationId, canonical_key AS canonicalKey,
        canonical_value AS canonicalValue, canonical_unit AS canonicalUnit,
        quality, matched_by AS matchedBy, review_status AS reviewStatus,
        excluded_reason AS excludedReason
      FROM observation_normalizations
      WHERE observation_id LIKE 'unit-governance-%'
      ORDER BY observation_id
    `).all().map((row) => ({ ...(row as Record<string, unknown>) }));

    const expectedRows = [
      {
        observationId: "unit-governance-alias-compatible",
        canonicalKey: "laboratory_prolactin",
        canonicalValue: 20,
        canonicalUnit: "ng/mL",
        quality: "high",
        matchedBy: "user_alias",
        reviewStatus: "unreviewed",
        excludedReason: null
      },
      {
        observationId: "unit-governance-alias-incompatible",
        canonicalKey: "laboratory_prolactin",
        canonicalValue: null,
        canonicalUnit: null,
        quality: "low",
        matchedBy: "user_alias",
        reviewStatus: "unreviewed",
        excludedReason: "单位与标准指标不兼容，禁止进入默认趋势"
      },
      {
        observationId: "unit-governance-manual-incompatible",
        canonicalKey: "laboratory_prolactin",
        canonicalValue: null,
        canonicalUnit: null,
        quality: "low",
        matchedBy: "manual_confirmation",
        reviewStatus: "confirmed",
        excludedReason: "单位与标准指标不兼容，已保留人工确认的指标身份，但禁止进入默认趋势"
      }
    ];
    assert.deepEqual(readRows(), expectedRows);

    const openIssue = listIndicatorNormalizationIssues(admin)
      .find((item) => item.representativeObservationId === "unit-governance-alias-incompatible");
    assert.ok(openIssue);
    assert.equal(openIssue.resultText, "510");
    assert.equal(openIssue.unit, "mIU/L");
    assert.equal(openIssue.candidateCanonicalKey, "laboratory_prolactin");
    assert.equal(openIssue.candidateDefaultUnit, "ng/mL");
    assert.match(openIssue.reason, /单位与标准指标不兼容/);

    const trendsBeforeRerun = listTrendSeries(admin, "governance-member");
    assert.equal(trendsBeforeRerun.length, 1);
    assert.equal(trendsBeforeRerun[0]?.indicatorKey, "laboratory_prolactin");
    assert.deepEqual(trendsBeforeRerun[0]?.points.map((point) => point.observationId), [
      "unit-governance-alias-compatible"
    ]);
    assert.deepEqual(
      trendsBeforeRerun[0]?.excludedPoints.map((point) => point.observationId).sort(),
      ["unit-governance-alias-incompatible", "unit-governance-manual-incompatible"]
    );
    assert.deepEqual(
      trendsBeforeRerun[0]?.excludedPoints
        .map((point) => ({ resultText: point.resultText, unit: point.unit }))
        .sort((left, right) => left.resultText.localeCompare(right.resultText)),
      [
        { resultText: "480", unit: "mIU/L" },
        { resultText: "510", unit: "mIU/L" }
      ]
    );

    await normalizeAllObservationsFromDictionary(admin, { full: true });
    assert.deepEqual(readRows(), expectedRows);
    const trendsAfterRerun = listTrendSeries(admin, "governance-member");
    assert.deepEqual(
      trendsAfterRerun[0]?.excludedPoints.map((point) => point.observationId).sort(),
      ["unit-governance-alias-incompatible", "unit-governance-manual-incompatible"]
    );

    const undone = undoIndicatorGovernanceDecision(admin, issue.fingerprint, "撤销单位治理金标");
    assert.equal(undone.aliasDisabled, true);
    assert.equal(undone.remainingMapped, 0);
    assert.equal(listTrendSeries(admin, "governance-member").length, 0);
    const afterUndo = readRows();
    assert.equal(afterUndo.every((row) => row.canonicalKey === null), true);
    assert.equal(afterUndo.every((row) => row.canonicalValue === null && row.canonicalUnit === null), true);
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
});
