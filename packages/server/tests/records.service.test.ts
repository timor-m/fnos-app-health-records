import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { closeDatabaseForTests, getDatabase } from "../database/client.ts";
import { schemaVersion } from "../database/schema.ts";
import type { RequestUser } from "../domain/request-user.ts";
import {
  classifyObservationDisplay,
  clearUserOperationAuditLogs,
  createBackup,
  createReminder,
  confirmReportReady,
  deleteBackup,
  deleteReportPage,
  getReportDetail,
  getReportPageFile,
  getReportPageOcrDetail,
  getReportSummaryStats,
  getAiAuditSummary,
  getBackupDownload,
  listAppNotifications,
  listAuditLogs,
  listBackups,
  listDuplicateReportGroups,
  listReportOcrText,
  listReports,
  listReminders,
  listTrendSeries,
  listUserOperationAuditLogs,
  mergeDuplicateReport,
  permanentlyDeleteReport,
  restoreBackup as restoreFullBackup,
  restoreUploadedBackup,
  restoreReport,
  suppressDuplicateMeasurementCandidates,
  trashReport,
  updateReminderStatus,
  updateAppNotificationStatus,
  updateReportFields,
  updateReportPages,
  validateBackup
} from "../services/records.service.ts";
import {
  listIndicatorNormalizationIssues,
  normalizeAllObservations,
  normalizeAllObservationsFromDictionary
} from "../services/indicator-normalization.service.ts";
import {
  setReportDuplicateDecision,
  undoReportDuplicateDecision
} from "../services/report-duplicate-governance.service.ts";
import { createUpload } from "../services/upload.service.ts";
import { installRemoteDictionarySnapshotForTests } from "../services/indicator-dictionary.service.ts";
import { hashPassword } from "../services/auth.service.ts";
import {
  applyObservationFieldOverrides,
  createManualObservation,
  updateManualObservation
} from "../services/observation-field-overrides.service.ts";

const manager: RequestUser = {
  id: "records-manager",
  displayName: "档案管理员",
  provider: "fnos_gateway",
  authenticated: true,
  isGatewayAdmin: true
};
const samplePhone = ["138", "0013", "8000"].join("");

function pngBytes() {
  return Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]);
}

function anotherPngBytes() {
  return Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x02, 0x03]);
}

function thirdPngBytes() {
  return Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x04, 0x05, 0x06]);
}

test("classifies report observations into standardized, candidate, technical, qualitative and governance display groups", () => {
  const evidence = [{ pageNumber: 1, quote: "可核验证据" }];
  assert.deepEqual(classifyObservationDisplay({
    normalizationQuality: "high",
    normalizationExcludedReason: null,
    normalizationMatchedBy: "builtin_alias",
    canonicalName: "标准指标",
    evidence
  }), { displayTier: "primary", displayCategory: "standardized", displayReason: null });

  assert.deepEqual(classifyObservationDisplay({
    normalizationQuality: "high",
    normalizationExcludedReason: null,
    normalizationMatchedBy: "builtin_alias",
    canonicalName: "人工确认指标",
    evidence: [],
    manualReviewed: true
  }), { displayTier: "primary", displayCategory: "standardized", displayReason: null });

  const unknown = classifyObservationDisplay({
    normalizationQuality: "low",
    normalizationExcludedReason: "未命中内置指标字典",
    normalizationMatchedBy: "none",
    canonicalName: null,
    evidence,
    itemName: "待补医学项目",
    sectionName: "专项检验",
    numericValue: 1.2,
    unit: "U/L"
  });
  assert.equal(unknown.displayTier, "secondary");
  assert.equal(unknown.displayCategory, "medical_candidate");
  assert.match(unknown.displayReason || "", /尚未匹配标准指标/);

  const technical = classifyObservationDisplay({
    normalizationQuality: "low",
    normalizationExcludedReason: "未命中内置指标字典",
    normalizationMatchedBy: "none",
    canonicalName: null,
    evidence,
    itemName: "专业参数",
    sectionName: "心电图检查",
    numericValue: 42,
    unit: "ms"
  });
  assert.equal(technical.displayTier, "secondary");
  assert.equal(technical.displayCategory, "technical_measurement");

  const qualitative = classifyObservationDisplay({
    normalizationQuality: "low",
    normalizationExcludedReason: "未命中内置指标字典",
    normalizationMatchedBy: "none",
    canonicalName: null,
    evidence,
    itemName: "查体记录",
    sectionName: "内科",
    numericValue: null,
    unit: null
  });
  assert.equal(qualitative.displayTier, "secondary");
  assert.equal(qualitative.displayCategory, "qualitative_finding");

  const device = classifyObservationDisplay({
    normalizationQuality: "excluded",
    normalizationExcludedReason: "设备过程参数",
    normalizationMatchedBy: "functional_device_filter",
    canonicalName: null,
    evidence
  });
  assert.deepEqual(device, {
    displayTier: "governance_only",
    displayCategory: "governance_noise",
    displayReason: "设备过程参数"
  });

  for (const unverified of [
    classifyObservationDisplay({
      normalizationQuality: "low",
      normalizationExcludedReason: "未命中内置指标字典",
      normalizationMatchedBy: "none",
      canonicalName: null,
      evidence: []
    }),
    classifyObservationDisplay({
      normalizationQuality: "high",
      normalizationExcludedReason: null,
      normalizationMatchedBy: "builtin_alias",
      canonicalName: "标准指标",
      evidence: [{ quote: "" }, { pageNumber: 0, quote: "无有效页码" }]
    }),
    classifyObservationDisplay({
      normalizationQuality: "low",
      normalizationExcludedReason: "项目名称无法回指 OCR 证据，禁止进入默认趋势",
      normalizationMatchedBy: "builtin_alias",
      canonicalName: "待核验标准指标",
      evidence
    })
  ]) {
    assert.equal(unverified.displayTier, "governance_only");
    assert.equal(unverified.displayCategory, "governance_noise");
  }

  const laboratoryQualitative = classifyObservationDisplay({
    normalizationQuality: "low",
    normalizationExcludedReason: "未命中内置指标字典",
    normalizationMatchedBy: "none",
    canonicalName: null,
    evidence,
    itemName: "专项筛查结果",
    sectionName: "专项筛查",
    resultText: "阴性",
    numericValue: null,
    unit: null
  });
  assert.equal(laboratoryQualitative.displayTier, "secondary");
  assert.equal(laboratoryQualitative.displayCategory, "qualitative_finding");

  const breathMeasurement = classifyObservationDisplay({
    normalizationQuality: "low",
    normalizationExcludedReason: "未命中内置指标字典",
    normalizationMatchedBy: "none",
    canonicalName: null,
    evidence,
    itemName: "原始测量值",
    sectionName: "呼气试验",
    resultText: "0.5",
    numericValue: 0.5,
    unit: null
  });
  assert.equal(breathMeasurement.displayTier, "secondary");
  assert.equal(breathMeasurement.displayCategory, "technical_measurement");

  const reportLevelQualitative = classifyObservationDisplay({
    normalizationQuality: "low",
    normalizationExcludedReason: "未命中内置指标字典",
    normalizationMatchedBy: "none",
    canonicalName: null,
    evidence,
    itemName: "专项检查报告",
    sectionName: "专项检查报告",
    resultText: "阴性",
    numericValue: null,
    unit: null
  });
  assert.equal(reportLevelQualitative.displayTier, "secondary");
  assert.equal(reportLevelQualitative.displayCategory, "qualitative_finding");

  const narrativeFragment = classifyObservationDisplay({
    normalizationQuality: "low",
    normalizationExcludedReason: "未命中内置指标字典",
    normalizationMatchedBy: "none",
    canonicalName: null,
    evidence: [{ pageNumber: 1, quote: "某值偏高，建议控制饮食并复查" }],
    itemName: "某值",
    sectionName: "检查结论",
    resultText: "3.7",
    numericValue: 3.7,
    unit: null
  });
  assert.equal(narrativeFragment.displayTier, "governance_only");
  assert.equal(narrativeFragment.displayCategory, "governance_noise");
  assert.match(narrativeFragment.displayReason || "", /结论句残片/);

  const structuralNoise = classifyObservationDisplay({
    normalizationQuality: "low",
    normalizationExcludedReason: "未命中内置指标字典",
    normalizationMatchedBy: "none",
    canonicalName: null,
    evidence,
    itemName: "专项检查报告",
    sectionName: "专项检查报告"
  });
  assert.equal(structuralNoise.displayTier, "governance_only");
  assert.equal(structuralNoise.displayCategory, "governance_noise");

  // 查体表「项目 | 本次结果 | 历史结果」并排印刷时，AI 可能把阳性发现文本当作
  // 项目名、再从历史结果列取来「未见异常」，语义自相矛盾，必须拦到治理区。
  const contradictoryFinding = classifyObservationDisplay({
    normalizationQuality: "low",
    normalizationExcludedReason: "未命中内置指标字典",
    normalizationMatchedBy: "none",
    canonicalName: null,
    evidence: [{ pageNumber: 8, quote: "右侧外耳道耵聍堵塞 | 未见异常" }],
    itemName: "右侧外耳道耵聍堵塞",
    sectionName: "耳鼻喉",
    resultText: "未见异常",
    numericValue: null,
    unit: null
  });
  assert.equal(contradictoryFinding.displayTier, "governance_only");
  assert.equal(contradictoryFinding.displayCategory, "governance_noise");
  assert.match(contradictoryFinding.displayReason || "", /矛盾/);

  // 普通查体条目（腹部 | 未见异常）不含阳性发现词，保持定性记录展示。
  const physicalExamNormal = classifyObservationDisplay({
    normalizationQuality: "low",
    normalizationExcludedReason: "未命中内置指标字典",
    normalizationMatchedBy: "none",
    canonicalName: null,
    evidence: [{ pageNumber: 7, quote: "腹部 | 未见异常" }],
    itemName: "腹部",
    sectionName: "外科",
    resultText: "未见异常",
    numericValue: null,
    unit: null
  });
  assert.equal(physicalExamNormal.displayTier, "secondary");
  assert.equal(physicalExamNormal.displayCategory, "qualitative_finding");

  // 带检测语义的名称（肿瘤标志物）缺如类结果合法，不得误伤。
  const screeningPanel = classifyObservationDisplay({
    normalizationQuality: "low",
    normalizationExcludedReason: "未命中内置指标字典",
    normalizationMatchedBy: "none",
    canonicalName: null,
    evidence,
    itemName: "肿瘤标志物",
    sectionName: "专项筛查",
    resultText: "正常",
    numericValue: null,
    unit: null
  });
  assert.equal(screeningPanel.displayTier, "secondary");
  assert.equal(screeningPanel.displayCategory, "qualitative_finding");

  // 便常规中「-」是合法的定性缺如结果（未检出），应归为定性记录而非未匹配候选。
  const dashQualitative = classifyObservationDisplay({
    normalizationQuality: "low",
    normalizationExcludedReason: "未命中内置指标字典",
    normalizationMatchedBy: "none",
    canonicalName: null,
    evidence: [{ pageNumber: 12, quote: "虫卵 | -" }],
    itemName: "虫卵",
    sectionName: "便常规",
    resultText: "-",
    numericValue: null,
    unit: null
  });
  assert.equal(dashQualitative.displayTier, "secondary");
  assert.equal(dashQualitative.displayCategory, "qualitative_finding");
});

test("suppresses bare-name measurement fragments duplicated by standardized entries", () => {
  type ObservationList = Parameters<typeof suppressDuplicateMeasurementCandidates>[0];
  const sharedEvidence = [{ pageNumber: 21, quote: "右踝：1.07 | 左踝：1.08" }];
  const base = {
    id: "base",
    reportId: "report",
    itemName: "条目",
    numericValue: null as number | null,
    canonicalName: null as string | null,
    evidence: null as unknown,
    displayTier: "secondary",
    displayCategory: "medical_candidate",
    displayReason: null as string | null,
  };
  const standardized = {
    ...base,
    id: "std-left-abi",
    itemName: "左侧踝肱指数",
    canonicalName: "左侧踝肱指数",
    numericValue: 1.08,
    evidence: sharedEvidence,
    displayTier: "primary",
    displayCategory: "standardized",
  };
  const fragment = { ...base, id: "frag", itemName: "左踝", numericValue: 1.08, evidence: sharedEvidence };
  const orphanValue = { ...base, id: "orphan", itemName: "未知碎片", numericValue: 9.99, evidence: sharedEvidence };
  const differentQuote = {
    ...base,
    id: "other-quote",
    itemName: "左踝",
    numericValue: 1.08,
    evidence: [{ pageNumber: 21, quote: "踝肱指数检查结果 1.08" }],
  };
  const result = suppressDuplicateMeasurementCandidates([
    standardized,
    fragment,
    orphanValue,
    differentQuote,
  ] as unknown as ObservationList);
  const byId = new Map(result.map((row) => [row.id, row]));

  // 与标准化条目同值同证据的裸名称残片被抑制，标准化条目本身不受影响。
  assert.equal(byId.get("frag")?.displayTier, "governance_only");
  assert.equal(byId.get("frag")?.displayCategory, "governance_noise");
  assert.match(byId.get("frag")?.displayReason || "", /重复测量候选/);
  assert.equal(byId.get("std-left-abi")?.displayTier, "primary");
  // 同证据但数值无标准化锚点、或同值但证据不同的条目保持原样。
  assert.equal(byId.get("orphan")?.displayTier, "secondary");
  assert.equal(byId.get("other-quote")?.displayTier, "secondary");
});

test("lists reports with cursors and returns detail pages with original files", () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-records-"));
  process.env.STORAGE_DIR = storageDir;
  try {
    const db = getDatabase();
    db.prepare("INSERT INTO users (id, display_name, is_gateway_admin) VALUES (?, ?, 1)")
      .run(manager.id, manager.displayName);
    db.prepare(`
      INSERT INTO health_members (id, display_name, relationship, created_by)
      VALUES ('records-member', '本人', 'self', ?)
    `).run(manager.id);
    db.prepare(`
      INSERT INTO member_permissions (member_id, user_id, permission, granted_by)
      VALUES ('records-member', ?, 'manager', ?)
    `).run(manager.id, manager.id);

    const newer = createUpload(manager, "records-member", [{ originalName: "new.png", data: pngBytes() }]);
    const older = createUpload(manager, "records-member", [{ originalName: "old.png", data: pngBytes() }]);
    db.prepare(`
      UPDATE reports SET title = ?, report_type = 'laboratory', status = 'ready',
        hospital_name_raw = '示例医院', performing_department = '彩超室', report_issued_at = ?
      WHERE id = ?
    `).run("较新的报告", "2026-07-21", newer.reportId);
    db.prepare(`
      UPDATE reports SET title = ?, report_type = 'imaging', status = 'ready',
        hospital_name_raw = '示例医院', report_issued_at = ?
      WHERE id = ?
    `).run("较早的报告", "2026-06-01", older.reportId);

    const firstPage = listReports(manager, 1, "records-member");
    assert.equal(firstPage.items.length, 1);
    assert.equal(firstPage.items[0]?.title, "较新的报告");
    assert.equal(firstPage.items[0]?.departmentName, "彩超室");
    assert.equal(firstPage.hasMore, true);
    assert.ok(firstPage.nextCursor);

    const secondPage = listReports(manager, 1, "records-member", firstPage.nextCursor || undefined);
    assert.equal(secondPage.items.length, 1);
    assert.equal(secondPage.items[0]?.title, "较早的报告");

    const detail = getReportDetail(manager, newer.reportId);
    assert.equal(detail.pages.length, 1);
    assert.equal(detail.hospitalName, "示例医院");
    assert.equal(detail.departmentName, "彩超室");
    assert.equal(detail.visitDepartment, null);

    const file = getReportPageFile(manager, newer.reportId, detail.pages[0].id, "original");
    assert.equal(file.mimeType, "image/png");
    assert.equal(existsSync(file.path), true);
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
});

test("manual report field edits are tracked as field overrides", () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-records-overrides-"));
  process.env.STORAGE_DIR = storageDir;
  try {
    const db = getDatabase();
    db.prepare("INSERT INTO users (id, display_name, is_gateway_admin) VALUES (?, ?, 1)")
      .run(manager.id, manager.displayName);
    db.prepare(`
      INSERT INTO health_members (id, display_name, relationship, created_by)
      VALUES ('records-member', '本人', 'self', ?)
    `).run(manager.id);
    db.prepare(`
      INSERT INTO member_permissions (member_id, user_id, permission, granted_by)
      VALUES ('records-member', ?, 'manager', ?)
    `).run(manager.id, manager.id);

    const upload = createUpload(manager, "records-member", [{ originalName: "manual.png", data: pngBytes() }]);
    db.prepare(`
      UPDATE reports SET title = 'AI血糖报告', report_type = 'laboratory', status = 'needs_review',
        hospital_name_raw = 'AI医院', visit_department = '检验科', report_issued_at = '2026-07-21',
        impression = 'AI结论'
      WHERE id = ?
    `).run(upload.reportId);

    const detail = updateReportFields(manager, upload.reportId, {
      title: "AI血糖报告",
      reportType: "laboratory",
      hospitalName: "人工医院",
      hospitalBranch: "",
      city: "",
      visitType: "",
      departmentName: "检验科",
      orderingDepartment: "",
      performingDepartment: "",
      reportingDepartment: "",
      bodyPart: "",
      reportIssuedAt: "2026-07-21",
      examinedAt: "",
      clinicalDiagnosis: "",
      purpose: "",
      findings: "",
      impression: "人工结论",
      summary: "",
      recommendation: ""
    });

    assert.equal(detail.hospitalName, "人工医院");
    assert.equal(detail.impression, "人工结论");
    assert.deepEqual([...detail.manualFieldKeys].sort(), ["hospitalName", "impression"]);
    const rows = db.prepare(`
      SELECT field_key AS fieldKey, value_json AS valueJson FROM report_field_overrides
      WHERE report_id = ? ORDER BY field_key
    `).all(upload.reportId) as Array<{ fieldKey: string; valueJson: string }>;
    assert.deepEqual(rows.map((row) => [row.fieldKey, JSON.parse(row.valueJson)]), [
      ["hospitalName", "人工医院"],
      ["impression", "人工结论"]
    ]);
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
});

test("manual observation edits are prefilled, normalized and retained across extraction rebuilds", () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-observation-overrides-"));
  process.env.STORAGE_DIR = storageDir;
  try {
    const db = getDatabase();
    db.prepare("INSERT INTO users (id, display_name, is_gateway_admin) VALUES (?, ?, 1)")
      .run(manager.id, manager.displayName);
    db.prepare(`
      INSERT INTO health_members (id, display_name, relationship, created_by)
      VALUES ('records-member', '本人', 'self', ?)
    `).run(manager.id);
    db.prepare(`
      INSERT INTO member_permissions (member_id, user_id, permission, granted_by)
      VALUES ('records-member', ?, 'manager', ?)
    `).run(manager.id, manager.id);
    const upload = createUpload(manager, "records-member", [{ originalName: "manual-observation.png", data: pngBytes() }]);
    db.prepare("UPDATE reports SET report_type = 'laboratory', status = 'ready' WHERE id = ?").run(upload.reportId);

    createManualObservation(manager, upload.reportId, {
      sectionName: "血常规", itemCode: "WBC", itemName: "白细胞计数",
      resultText: "5.2", numericValue: 5.2, unit: "10^9/L",
      referenceLow: 3.5, referenceHigh: 9.5, referenceText: "3.5-9.5",
      abnormalFlag: "normal"
    });
    let detail = getReportDetail(manager, upload.reportId);
    const manual = detail.observations.find((item) => item.itemCode === "WBC");
    assert.ok(manual);
    assert.equal(manual.manualReviewed, true);
    assert.equal(manual.manualCreated, true);
    assert.equal(manual.numericValue, 5.2);

    updateManualObservation(manager, upload.reportId, manual.id, {
      sectionName: "血常规", itemCode: "WBC", itemName: "白细胞计数",
      resultText: "5.7", numericValue: 5.7, unit: "10^9/L",
      referenceLow: 3.5, referenceHigh: 9.5, referenceText: "3.5-9.5",
      abnormalFlag: "normal", canonicalKey: "cbc_wbc"
    });
    detail = getReportDetail(manager, upload.reportId);
    const corrected = detail.observations.find((item) => item.id === manual.id);
    assert.equal(corrected?.numericValue, 5.7);
    assert.equal(corrected?.canonicalKey, "cbc_wbc");
    assert.equal(corrected?.manualCanonicalKey, "cbc_wbc");
    assert.equal(corrected?.normalizationQuality, "high");

    const rebuilt = applyObservationFieldOverrides(upload.reportId, []);
    assert.equal(rebuilt.length, 1);
    assert.equal(rebuilt[0]?.observation.numericValue, 5.7);
    assert.equal(rebuilt[0]?.manualCreated, true);

    const audit = db.prepare(`
      SELECT detail_json AS detailJson FROM audit_logs
      WHERE action = 'observation.manual_update' AND target_id = ?
    `).get(manual.id) as { detailJson: string };
    assert.deepEqual(JSON.parse(audit.detailJson).fields, ["resultText", "numericValue", "canonicalKey"]);
    assert.equal(audit.detailJson.includes("5.7"), false);
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
});

test("detects duplicate report candidates from extracted content instead of file hash", () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-records-duplicates-"));
  process.env.STORAGE_DIR = storageDir;
  try {
    const db = getDatabase();
    db.prepare("INSERT INTO users (id, display_name, is_gateway_admin) VALUES (?, ?, 1)")
      .run(manager.id, manager.displayName);
    db.prepare(`
      INSERT INTO health_members (id, display_name, relationship, created_by)
      VALUES ('records-member', '本人', 'self', ?)
    `).run(manager.id);
    db.prepare(`
      INSERT INTO member_permissions (member_id, user_id, permission, granted_by)
      VALUES ('records-member', ?, 'manager', ?)
    `).run(manager.id, manager.id);

    const existing = createUpload(manager, "records-member", [{ originalName: "first.png", data: pngBytes() }]);
    const incoming = createUpload(manager, "records-member", [{ originalName: "second.png", data: anotherPngBytes() }]);
    db.prepare(`
      UPDATE reports SET title = ?, report_type = 'laboratory', status = 'ready',
        hospital_name_raw = '示例医院', report_issued_at = '2026-07-21',
        visit_department = '检验科', identifiers_json = '{"reportNo":"LAB-20260721-001"}'
      WHERE id = ?
    `).run("血常规报告", existing.reportId);
    db.prepare(`
      UPDATE reports SET title = ?, report_type = 'laboratory', status = 'needs_review',
        hospital_name_raw = '示例医院', report_issued_at = '2026-07-21',
        visit_department = '检验科', identifiers_json = '{"reportNo":"LAB-20260721-001"}'
      WHERE id = ?
    `).run("血常规报告", incoming.reportId);

    const firstPage = getReportDetail(manager, existing.reportId).pages[0];
    const secondPage = getReportDetail(manager, incoming.reportId).pages[0];
    assert.notEqual(firstPage.fileSize, secondPage.fileSize);

    const detail = getReportDetail(manager, incoming.reportId);
    assert.equal(detail.duplicateCandidates.length, 1);
    assert.equal(detail.duplicateCandidates[0].id, existing.reportId);
    assert.equal(detail.duplicateCandidates[0].confidence, "high");
    assert.match(detail.duplicateCandidates[0].reason, /reportNo/);
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
});

test("detects an identical uploaded original despite divergent AI titles and body parts", () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-records-duplicates-file-"));
  process.env.STORAGE_DIR = storageDir;
  try {
    const db = getDatabase();
    db.prepare("INSERT INTO users (id, display_name, is_gateway_admin) VALUES (?, ?, 1)")
      .run(manager.id, manager.displayName);
    db.prepare(`
      INSERT INTO health_members (id, display_name, relationship, created_by)
      VALUES ('records-member', '本人', 'self', ?)
    `).run(manager.id);
    db.prepare(`
      INSERT INTO member_permissions (member_id, user_id, permission, granted_by)
      VALUES ('records-member', ?, 'manager', ?)
    `).run(manager.id, manager.id);

    const existing = createUpload(manager, "records-member", [{ originalName: "first.png", data: pngBytes() }]);
    const incoming = createUpload(manager, "records-member", [{ originalName: "second.png", data: pngBytes() }]);
    db.prepare(`
      UPDATE reports SET title = '血脂生化检查', report_type = 'laboratory', status = 'ready',
        hospital_name_raw = '示例健康体检中心', report_issued_at = '2026-07-21',
        body_parts_json = '[{"raw":"血脂","name":"血脂","parent":null,"laterality":"unspecified"}]'
      WHERE id = ?
    `).run(existing.reportId);
    db.prepare(`
      UPDATE reports SET title = '综合体检报告', report_type = 'checkup', status = 'needs_review',
        hospital_name_raw = '示例健康体检中心', report_issued_at = '2026-07-21',
        body_parts_json = '[{"raw":"综合体检","name":"综合体检","parent":null,"laterality":"unspecified"}]'
      WHERE id = ?
    `).run(incoming.reportId);
    db.prepare(`
      INSERT INTO observations (
        id, report_id, section_name, item_name, normalized_name, result_text, numeric_value, unit
      ) VALUES ('same-file-existing-tc', ?, '生化检验', '总胆固醇', '总胆固醇', '4.26 mmol/L', 4.26, 'mmol/L')
    `).run(existing.reportId);
    db.prepare(`
      INSERT INTO observations (
        id, report_id, section_name, item_name, normalized_name, result_text, numeric_value, unit
      ) VALUES ('same-file-incoming-tc', ?, '血脂检查', '血清胆固醇', '总胆固醇', '4.26', 4.26, 'mmol/L')
    `).run(incoming.reportId);
    normalizeAllObservations(manager);

    const detail = getReportDetail(manager, incoming.reportId);
    assert.equal(detail.duplicateCandidates.length, 1);
    assert.equal(detail.duplicateCandidates[0].id, existing.reportId);
    assert.equal(detail.duplicateCandidates[0].confidence, "high");
    assert.match(detail.duplicateCandidates[0].reason, /原件内容完全一致/);
    assert.equal(detail.duplicateCandidates[0].matchedFields.includes("标题"), false);
    assert.equal(detail.duplicateCandidates[0].matchedFields.includes("检查部位"), false);
    const cholesterol = listTrendSeries(manager, "records-member")
      .find((series) => series.name === "总胆固醇");
    assert.ok(cholesterol);
    assert.equal(cholesterol.pointCount, 1);
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
});

test("detects duplicate candidates without report numbers when core extracted content matches", () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-records-duplicates-core-"));
  process.env.STORAGE_DIR = storageDir;
  try {
    const db = getDatabase();
    db.prepare("INSERT INTO users (id, display_name, is_gateway_admin) VALUES (?, ?, 1)")
      .run(manager.id, manager.displayName);
    db.prepare(`
      INSERT INTO health_members (id, display_name, relationship, created_by)
      VALUES ('records-member', '本人', 'self', ?)
    `).run(manager.id);
    db.prepare(`
      INSERT INTO member_permissions (member_id, user_id, permission, granted_by)
      VALUES ('records-member', ?, 'manager', ?)
    `).run(manager.id, manager.id);

    const existing = createUpload(manager, "records-member", [{ originalName: "first.png", data: pngBytes() }]);
    const incoming = createUpload(manager, "records-member", [{ originalName: "second.png", data: anotherPngBytes() }]);
    const bodyParts = JSON.stringify([{ raw: "甲状腺", name: "甲状腺", parent: null, laterality: "unspecified" }]);
    db.prepare(`
      UPDATE reports SET title = ?, report_type = 'imaging', status = 'ready',
        hospital_name_raw = '示例医院', report_issued_at = '2026-07-21',
        performing_department = '超声科', body_parts_json = ?,
        impression = '甲状腺双叶回声欠均匀，右叶可见低回声结节，建议结合临床随访复查。'
      WHERE id = ?
    `).run("甲状腺超声报告", bodyParts, existing.reportId);
    db.prepare(`
      UPDATE reports SET title = ?, report_type = 'imaging', status = 'needs_review',
        hospital_name_raw = '示例医院', report_issued_at = '2026-07-21',
        performing_department = '超声科', body_parts_json = ?,
        impression = '甲状腺双叶回声欠均匀，右叶可见低回声结节，建议结合临床随访复查。'
      WHERE id = ?
    `).run("甲状腺超声报告", bodyParts, incoming.reportId);

    const detail = getReportDetail(manager, incoming.reportId);
    assert.equal(detail.duplicateCandidates.length, 1);
    assert.equal(detail.duplicateCandidates[0].id, existing.reportId);
    assert.equal(detail.duplicateCandidates[0].confidence, "medium");
    assert.match(detail.duplicateCandidates[0].reason, /核心报告内容一致/);
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
});

test("detects duplicate checkups across equivalent institution names without merging different panels", () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-records-duplicates-hospital-alias-"));
  process.env.STORAGE_DIR = storageDir;
  try {
    const db = getDatabase();
    db.prepare("INSERT INTO users (id, display_name, is_gateway_admin) VALUES (?, ?, 1)")
      .run(manager.id, manager.displayName);
    db.prepare(`
      INSERT INTO health_members (id, display_name, relationship, created_by)
      VALUES ('records-member', '本人', 'self', ?)
    `).run(manager.id);
    db.prepare(`
      INSERT INTO member_permissions (member_id, user_id, permission, granted_by)
      VALUES ('records-member', ?, 'manager', ?)
    `).run(manager.id, manager.id);

    const original = createUpload(manager, "records-member", [{ originalName: "full-name.png", data: pngBytes() }]);
    const duplicate = createUpload(manager, "records-member", [{ originalName: "short-name.png", data: anotherPngBytes() }]);
    const different = createUpload(manager, "records-member", [{ originalName: "different-panel.png", data: thirdPngBytes() }]);
    const updateReport = db.prepare(`
      UPDATE reports SET title = ?, report_type = 'checkup', status = ?,
        hospital_name_raw = ?, report_issued_at = '2025-01-04'
      WHERE id = ?
    `);
    updateReport.run("年度健康体检报告", "ready", "安徽滨湖国宾健康体检中心", original.reportId);
    updateReport.run("健康检查结果汇总", "needs_review", "国宾健康体检中心", duplicate.reportId);
    updateReport.run("专项检查报告", "ready", "国宾健康体检中心", different.reportId);

    const insertObservation = db.prepare(`
      INSERT INTO observations (
        id, report_id, section_name, item_name, normalized_name, result_text, numeric_value, unit, abnormal_flag
      ) VALUES (?, ?, '生化检验', ?, ?, ?, ?, ?, 'normal')
    `);
    const sharedItems: Array<[string, string, number, string]> = [
      ["甘油三酯", "0.87", 0.87, "mmol/L"],
      ["总胆固醇", "4.26", 4.26, "mmol/L"],
      ["高密度脂蛋白胆固醇", "1.42", 1.42, "mmol/L"],
      ["低密度脂蛋白胆固醇", "2.31", 2.31, "mmol/L"],
      ["空腹血糖", "5.18", 5.18, "mmol/L"],
      ["尿酸", "326", 326, "umol/L"]
    ];
    sharedItems.forEach(([name, resultText, numericValue, unit], index) => {
      insertObservation.run(`alias-original-${index}`, original.reportId, name, name, resultText, numericValue, unit);
      insertObservation.run(
        `alias-duplicate-${index}`,
        duplicate.reportId,
        name,
        name,
        `${resultText} ${unit}`,
        numericValue,
        null
      );
    });
    insertObservation.run("alias-different-triglyceride", different.reportId, "甘油三酯", "甘油三酯", "0.87", 0.87, "mmol/L");
    [
      ["促甲状腺激素", "2.16", 2.16, "mIU/L"],
      ["游离甲状腺素", "16.4", 16.4, "pmol/L"],
      ["甲胎蛋白", "2.8", 2.8, "ng/mL"],
      ["癌胚抗原", "1.9", 1.9, "ng/mL"],
      ["糖类抗原125", "8.6", 8.6, "U/mL"]
    ].forEach(([name, resultText, numericValue, unit], index) => {
      insertObservation.run(`alias-different-${index}`, different.reportId, name, name, resultText, numericValue, unit);
    });
    normalizeAllObservations(manager);

    const duplicateDetail = getReportDetail(manager, duplicate.reportId);
    assert.equal(duplicateDetail.duplicateCandidates.some((candidate) => candidate.id === original.reportId), true);
    assert.match(
      duplicateDetail.duplicateCandidates.find((candidate) => candidate.id === original.reportId)?.reason || "",
      /机构名称近似/
    );

    const differentDetail = getReportDetail(manager, different.reportId);
    assert.equal(differentDetail.duplicateCandidates.length, 0);

    const triglycerideSeries = listTrendSeries(manager, "records-member")
      .filter((series) => series.name === "甘油三酯");
    assert.equal(
      triglycerideSeries.length,
      1,
      JSON.stringify(triglycerideSeries.map((series) => ({ unit: series.unit, pointCount: series.pointCount })))
    );
    const triglyceride = triglycerideSeries[0];
    assert.ok(triglyceride);
    assert.equal(triglyceride.pointCount, 3);
    assert.deepEqual(
      new Set(triglyceride.points.map((point: { reportId: string }) => point.reportId)),
      new Set([original.reportId, duplicate.reportId, different.reportId])
    );

    const duplicateDecision = setReportDuplicateDecision(manager, {
      reportId: original.reportId,
      candidateReportId: duplicate.reportId,
      decision: "duplicate",
      reason: "金标回归：等价机构名且六项指标完全重合"
    });
    assert.ok(duplicateDecision);
    const collapsed = listTrendSeries(manager, "records-member")
      .find((series) => series.name === "甘油三酯");
    assert.ok(collapsed);
    assert.equal(collapsed.pointCount, 2);
    assert.deepEqual(
      new Set(collapsed.points.map((point: { reportId: string }) => point.reportId)),
      new Set([original.reportId, different.reportId])
    );

    setReportDuplicateDecision(manager, {
      reportId: original.reportId,
      candidateReportId: duplicate.reportId,
      decision: "distinct",
      reason: "金标回归：人工确认是两次独立检查"
    });
    assert.equal(
      getReportDetail(manager, duplicate.reportId).duplicateCandidates
        .some((candidate) => candidate.id === original.reportId),
      false
    );
    const preserved = listTrendSeries(manager, "records-member")
      .find((series) => series.name === "甘油三酯");
    assert.ok(preserved);
    assert.equal(preserved.pointCount, 3);

    undoReportDuplicateDecision(manager, duplicateDecision.pairKey);
    assert.equal(
      getReportDetail(manager, duplicate.reportId).duplicateCandidates
        .some((candidate) => candidate.id === original.reportId),
      true
    );
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
});

test("does not flag different reports as duplicates when only hospital date type and department match", () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-records-duplicates-loose-"));
  process.env.STORAGE_DIR = storageDir;
  try {
    const db = getDatabase();
    db.prepare("INSERT INTO users (id, display_name, is_gateway_admin) VALUES (?, ?, 1)")
      .run(manager.id, manager.displayName);
    db.prepare(`
      INSERT INTO health_members (id, display_name, relationship, created_by)
      VALUES ('records-member', '本人', 'self', ?)
    `).run(manager.id);
    db.prepare(`
      INSERT INTO member_permissions (member_id, user_id, permission, granted_by)
      VALUES ('records-member', ?, 'manager', ?)
    `).run(manager.id, manager.id);

    const existing = createUpload(manager, "records-member", [{ originalName: "heart.png", data: pngBytes() }]);
    const incoming = createUpload(manager, "records-member", [{ originalName: "lung.png", data: anotherPngBytes() }]);
    const bodyParts = JSON.stringify([{ raw: "常规检查", name: "常规检查", parent: null, laterality: "unspecified" }]);
    db.prepare(`
      UPDATE reports SET title = ?, report_type = 'functional', status = 'ready',
        hospital_name_raw = '示例医院', report_issued_at = '2026-07-21',
        performing_department = '功能检查科', body_parts_json = ?,
        impression = '窦性心律，心电轴不偏，未见明显 ST-T 异常。'
      WHERE id = ?
    `).run("心电图报告", bodyParts, existing.reportId);
    db.prepare(`
      UPDATE reports SET title = ?, report_type = 'functional', status = 'needs_review',
        hospital_name_raw = '示例医院', report_issued_at = '2026-07-21',
        performing_department = '功能检查科', body_parts_json = ?,
        impression = '肺通气功能大致正常，支气管舒张试验阴性。'
      WHERE id = ?
    `).run("肺功能报告", bodyParts, incoming.reportId);

    const detail = getReportDetail(manager, incoming.reportId);
    assert.equal(detail.duplicateCandidates.length, 0);
    assert.equal(listDuplicateReportGroups(manager, "records-member").length, 0);
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
});

test("does not flag same-day laboratory reports as duplicates when only a few common indicators overlap", () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-records-duplicates-observations-"));
  process.env.STORAGE_DIR = storageDir;
  try {
    const db = getDatabase();
    db.prepare("INSERT INTO users (id, display_name, is_gateway_admin) VALUES (?, ?, 1)")
      .run(manager.id, manager.displayName);
    db.prepare(`
      INSERT INTO health_members (id, display_name, relationship, created_by)
      VALUES ('records-member', '本人', 'self', ?)
    `).run(manager.id);
    db.prepare(`
      INSERT INTO member_permissions (member_id, user_id, permission, granted_by)
      VALUES ('records-member', ?, 'manager', ?)
    `).run(manager.id, manager.id);

    const liver = createUpload(manager, "records-member", [{ originalName: "liver.png", data: pngBytes() }]);
    const kidney = createUpload(manager, "records-member", [{ originalName: "kidney.png", data: anotherPngBytes() }]);
    db.prepare(`
      UPDATE reports SET title = ?, report_type = 'laboratory', status = 'ready',
        hospital_name_raw = '示例体检中心', report_issued_at = '2026-07-21',
        performing_department = '检验科'
      WHERE id = ?
    `).run("肝功能检验报告", liver.reportId);
    db.prepare(`
      UPDATE reports SET title = ?, report_type = 'laboratory', status = 'needs_review',
        hospital_name_raw = '示例体检中心', report_issued_at = '2026-07-21',
        performing_department = '检验科'
      WHERE id = ?
    `).run("肾功能检验报告", kidney.reportId);

    const insertObservation = db.prepare(`
      INSERT INTO observations (id, report_id, section_name, item_name, normalized_name, result_text, unit, abnormal_flag)
      VALUES (?, ?, '生化检验', ?, ?, ?, 'U/L', 'normal')
    `);
    const shared = [
      ["白蛋白", "白蛋白", "42"],
      ["总蛋白", "总蛋白", "70"],
      ["球蛋白", "球蛋白", "28"]
    ];
    const liverOnly = [
      ["丙氨酸氨基转移酶", "丙氨酸氨基转移酶", "21"],
      ["天门冬氨酸氨基转移酶", "天门冬氨酸氨基转移酶", "19"],
      ["总胆红素", "总胆红素", "12"],
      ["直接胆红素", "直接胆红素", "4"],
      ["碱性磷酸酶", "碱性磷酸酶", "65"]
    ];
    const kidneyOnly = [
      ["肌酐", "肌酐", "72"],
      ["尿素", "尿素", "5.2"],
      ["尿酸", "尿酸", "330"],
      ["胱抑素C", "胱抑素C", "0.82"],
      ["估算肾小球滤过率", "估算肾小球滤过率", "98"]
    ];
    [...shared, ...liverOnly].forEach(([itemName, normalizedName, resultText], index) => {
      insertObservation.run(`obs-liver-${index}`, liver.reportId, itemName, normalizedName, resultText);
    });
    [...shared, ...kidneyOnly].forEach(([itemName, normalizedName, resultText], index) => {
      insertObservation.run(`obs-kidney-${index}`, kidney.reportId, itemName, normalizedName, resultText);
    });

    const detail = getReportDetail(manager, kidney.reportId);
    assert.equal(detail.duplicateCandidates.length, 0);
    assert.equal(listDuplicateReportGroups(manager, "records-member").length, 0);
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
});

test("scans duplicate groups and merges source pages into the target report", () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-records-duplicates-merge-"));
  process.env.STORAGE_DIR = storageDir;
  try {
    const db = getDatabase();
    db.prepare("INSERT INTO users (id, display_name, is_gateway_admin) VALUES (?, ?, 1)")
      .run(manager.id, manager.displayName);
    db.prepare(`
      INSERT INTO health_members (id, display_name, relationship, created_by)
      VALUES ('records-member', '本人', 'self', ?)
    `).run(manager.id);
    db.prepare(`
      INSERT INTO member_permissions (member_id, user_id, permission, granted_by)
      VALUES ('records-member', ?, 'manager', ?)
    `).run(manager.id, manager.id);

    const target = createUpload(manager, "records-member", [{ originalName: "target.png", data: pngBytes() }]);
    const source = createUpload(manager, "records-member", [{ originalName: "source.png", data: anotherPngBytes() }]);
    db.prepare(`
      UPDATE reports SET title = ?, report_type = 'imaging', status = ?,
        hospital_name_raw = '示例医院', report_issued_at = '2026-07-21',
        performing_department = '超声科', body_parts_json = ?
      WHERE id = ?
    `);
    const bodyParts = JSON.stringify([{ raw: "甲状腺", name: "甲状腺", parent: null, laterality: "unspecified" }]);
    db.prepare(`
      UPDATE reports SET title = ?, report_type = 'imaging', status = ?,
        hospital_name_raw = '示例医院', report_issued_at = '2026-07-21',
        performing_department = '超声科', body_parts_json = ?,
        impression = '甲状腺右叶结节，边界清，建议随访复查。'
      WHERE id = ?
    `).run("目标甲状腺超声报告", "ready", bodyParts, target.reportId);
    db.prepare(`
      UPDATE reports SET title = ?, report_type = 'imaging', status = ?,
        hospital_name_raw = '示例医院', report_issued_at = '2026-07-21',
        performing_department = '超声科', body_parts_json = ?,
        impression = '甲状腺右叶结节，边界清，建议随访复查。'
      WHERE id = ?
    `).run("重复甲状腺超声报告", "needs_review", bodyParts, source.reportId);
    assert.throws(() => mergeDuplicateReport(manager, source.reportId, target.reportId), /仍有识别任务/);
    db.prepare(`
      UPDATE processing_jobs SET status = 'completed', finished_at = CURRENT_TIMESTAMP
      WHERE report_id IN (?, ?)
    `).run(source.reportId, target.reportId);

    const groups = listDuplicateReportGroups(manager, "records-member");
    assert.equal(groups.length, 1);
    assert.equal(groups[0].candidates.length, 1);

    const result = mergeDuplicateReport(manager, source.reportId, target.reportId);
    assert.equal(result.movedPages, 1);
    const targetDetail = getReportDetail(manager, target.reportId);
    assert.equal(targetDetail.pages.length, 2);
    assert.equal(targetDetail.status, "needs_review");
    assert.equal(listReports(manager, 30, { memberId: "records-member", trash: true }).items.some((item) => item.id === source.reportId), true);
    assert.equal(listDuplicateReportGroups(manager, "records-member").length, 0);
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
});

test("moves a duplicate report to the 30 day recycle bin without deleting originals", () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-records-trash-"));
  process.env.STORAGE_DIR = storageDir;
  try {
    const db = getDatabase();
    db.prepare("INSERT INTO users (id, display_name, is_gateway_admin) VALUES (?, ?, 1)")
      .run(manager.id, manager.displayName);
    db.prepare(`
      INSERT INTO health_members (id, display_name, relationship, created_by)
      VALUES ('records-member', '本人', 'self', ?)
    `).run(manager.id);
    db.prepare(`
      INSERT INTO member_permissions (member_id, user_id, permission, granted_by)
      VALUES ('records-member', ?, 'manager', ?)
    `).run(manager.id, manager.id);

    const upload = createUpload(manager, "records-member", [{ originalName: "duplicate.png", data: pngBytes() }]);
    const page = getReportDetail(manager, upload.reportId).pages[0];
    const file = getReportPageFile(manager, upload.reportId, page.id, "original");
    assert.equal(existsSync(file.path), true);

    assert.deepEqual(trashReport(manager, upload.reportId), { id: upload.reportId, status: "trashed", purgeAfterDays: 30 });
    assert.equal(existsSync(file.path), true);
    assert.equal(listReports(manager, 30, "records-member").items.some((report) => report.id === upload.reportId), false);
    assert.throws(() => getReportDetail(manager, upload.reportId), /报告不存在/);

    const row = db.prepare("SELECT status, deleted_at AS deletedAt, purge_after AS purgeAfter FROM reports WHERE id = ?")
      .get(upload.reportId) as { status: string; deletedAt: string | null; purgeAfter: string | null };
    assert.equal(row.status, "trashed");
    assert.ok(row.deletedAt);
    assert.ok(row.purgeAfter);
    const activeJobs = db.prepare("SELECT COUNT(*) AS count FROM processing_jobs WHERE report_id = ? AND status IN ('queued', 'processing')")
      .get(upload.reportId) as { count: number };
    assert.equal(activeJobs.count, 0);
    const audit = db.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE target_id = ? AND action = 'report.trash'")
      .get(upload.reportId) as { count: number };
    assert.equal(audit.count, 1);
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
});

test("permanent deletion keeps a redacted duplicate-governance snapshot without report titles", () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-records-purge-governance-"));
  process.env.STORAGE_DIR = storageDir;
  try {
    const db = getDatabase();
    db.prepare("INSERT INTO users (id, display_name, is_gateway_admin) VALUES (?, ?, 1)")
      .run(manager.id, manager.displayName);
    db.prepare(`
      INSERT INTO health_members (id, display_name, relationship, created_by)
      VALUES ('records-member', '本人', 'self', ?)
    `).run(manager.id);
    db.prepare(`
      INSERT INTO member_permissions (member_id, user_id, permission, granted_by)
      VALUES ('records-member', ?, 'manager', ?)
    `).run(manager.id, manager.id);

    const sensitiveTitle = "不应进入审计的敏感报告标题";
    const source = createUpload(manager, "records-member", [{ originalName: "source.png", data: pngBytes() }]);
    const target = createUpload(manager, "records-member", [{ originalName: "target.png", data: anotherPngBytes() }]);
    db.prepare("UPDATE reports SET title = ? WHERE id = ?").run(sensitiveTitle, source.reportId);
    const decision = setReportDuplicateDecision(manager, {
      reportId: source.reportId,
      candidateReportId: target.reportId,
      decision: "duplicate",
      reason: "永久删除前治理快照",
      evidence: { confidence: "high", matchedFields: ["原始文件"] }
    });
    assert.ok(decision);
    trashReport(manager, source.reportId);
    assert.deepEqual(permanentlyDeleteReport(manager, source.reportId), { id: source.reportId, deleted: true });

    const reportCount = db.prepare("SELECT COUNT(*) AS count FROM reports WHERE id = ?")
      .get(source.reportId) as { count: number };
    const decisionCount = db.prepare("SELECT COUNT(*) AS count FROM report_duplicate_decisions WHERE pair_key = ?")
      .get(decision.pairKey) as { count: number };
    const historyCount = db.prepare("SELECT COUNT(*) AS count FROM report_duplicate_history WHERE pair_key = ?")
      .get(decision.pairKey) as { count: number };
    assert.equal(reportCount.count, 0);
    assert.equal(decisionCount.count, 0);
    assert.equal(historyCount.count, 1);

    const audit = db.prepare(`
      SELECT detail_json AS detailJson FROM audit_logs
      WHERE action = 'report.purge' AND target_id = ?
    `).get(source.reportId) as { detailJson: string };
    const detail = JSON.parse(audit.detailJson) as Record<string, any>;
    assert.equal("reportTitle" in detail, false);
    assert.equal(audit.detailJson.includes(sensitiveTitle), false);
    assert.match(String(detail.reportFingerprint), /^[A-Za-z0-9_-]{43}$/);
    assert.equal(detail.pageCount, 1);
    assert.deepEqual(detail.governanceSnapshot, {
      activeDecisions: 1,
      duplicateDecisions: 1,
      distinctDecisions: 0,
      historyEvents: 1
    });
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
});

test("supports manual review edits, page edits, search filters, reminders, backups and audit", () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-records-workflows-"));
  process.env.STORAGE_DIR = storageDir;
  try {
    const db = getDatabase();
    db.prepare("INSERT INTO users (id, display_name, is_gateway_admin) VALUES (?, ?, 1)")
      .run(manager.id, manager.displayName);
    db.prepare(`
      INSERT INTO health_members (id, display_name, relationship, created_by)
      VALUES ('records-member', '本人', 'self', ?)
    `).run(manager.id);
    db.prepare(`
      INSERT INTO member_permissions (member_id, user_id, permission, granted_by)
      VALUES ('records-member', ?, 'manager', ?)
    `).run(manager.id, manager.id);

    const upload = createUpload(manager, "records-member", [
      { originalName: "first.png", data: pngBytes() },
      { originalName: "second.png", data: anotherPngBytes() }
    ]);
    const ocrJob = db.prepare("SELECT id FROM processing_jobs WHERE page_id = ? AND job_type = 'ocr' LIMIT 1")
      .get(upload.pages[0].id) as { id: string };
    db.prepare(`
      INSERT INTO ocr_results (id, job_id, page_id, engine, model_version, lines_json)
      VALUES ('ocr-search', NULL, ?, 'test', 'v1', ?)
    `.replace("NULL", "?")).run(ocrJob.id, upload.pages[0].id, JSON.stringify([{ text: "甲状腺彩超 复查" }]));

    const edited = updateReportFields(manager, upload.reportId, {
      title: "人工校对报告",
      reportType: "imaging",
      hospitalName: "校对医院",
      departmentName: "超声科",
      bodyPart: "甲状腺",
      reportIssuedAt: "2026-07-21",
      recommendation: "3个月后复查"
    });
    assert.equal(edited.title, "人工校对报告");
    assert.equal(edited.bodyPart, "甲状腺");
    assert.equal(listReports(manager, 30, { memberId: "records-member", query: "校对医院", reportType: "imaging" }).items.length, 1);
    assert.equal(listReports(manager, 30, { memberId: "records-member", ocrQuery: "甲状腺彩超" }).items.length, 1);

    const reversed = updateReportPages(manager, upload.reportId, {
      pages: [
        { id: upload.pages[1].id, rotation: 90 },
        { id: upload.pages[0].id, rotation: 0 }
      ]
    });
    assert.equal(reversed.pages[0].id, upload.pages[1].id);
    assert.equal(reversed.pages[0].rotation, 90);
    deleteReportPage(manager, upload.reportId, upload.pages[0].id);

	    const reminder = createReminder(manager, { memberId: "records-member", title: "手工复查", dueAt: "2026-10-21" });
	    assert.equal((listReminders(manager, "records-member") as Array<{ id: string }>).some((item) => item.id === reminder.id), true);
	    assert.deepEqual(updateReminderStatus(manager, reminder.id, "completed"), { id: reminder.id, status: "completed" });
	    db.prepare(`
	      INSERT INTO app_notifications (id, member_id, report_id, type, title, message, severity)
	      VALUES ('notice-records-done', 'records-member', ?, 'report_processed', '报告处理完成', '报告已完成识别', 'success')
	    `).run(upload.reportId);
	    const notices = listAppNotifications(manager, "records-member") as Array<{ id: string; status: string; type: string }>;
	    assert.equal(notices.some((item) => item.id === "notice-records-done" && item.type === "report_processed"), true);
	    assert.deepEqual(updateAppNotificationStatus(manager, "notice-records-done", "archived"), { id: "notice-records-done", status: "archived" });
	    assert.equal((listAppNotifications(manager, "records-member") as Array<{ id: string }>).some((item) => item.id === "notice-records-done"), false);

	    db.prepare("UPDATE reports SET status = 'needs_review' WHERE id = ?").run(upload.reportId);
    assert.deepEqual(confirmReportReady(manager, upload.reportId), { id: upload.reportId, status: "ready", reminderCreated: true });
    const reportReminders = listReminders(manager, "records-member") as Array<{
      source: string;
      reportId: string | null;
      reportTitle: string | null;
      reportHospitalName: string | null;
      reportIssuedAt: string | null;
    }>;
    assert.equal(reportReminders.some((item) => item.source === "report_suggestion"), true);
    assert.equal(reportReminders.some((item) => item.reportId === upload.reportId && item.reportTitle === "人工校对报告" && item.reportHospitalName === "校对医院" && item.reportIssuedAt === "2026-07-21"), true);

    const trashed = trashReport(manager, upload.reportId);
    assert.equal(trashed.status, "trashed");
    assert.equal(listReports(manager, 30, { memberId: "records-member", trash: true }).items.length, 1);
    assert.equal(restoreReport(manager, upload.reportId).status, "needs_review");

    db.prepare(`
      INSERT INTO processing_jobs (
        id, report_id, page_id, job_type, status, attempts, pipeline_version, deduplication_key, created_at, finished_at
      ) VALUES ('ai-audit-job', ?, NULL, 'ai_extract', 'completed', 1, 'test', 'ai-audit-job-key', '2026-07-21 12:00:00', CURRENT_TIMESTAMP)
    `).run(upload.reportId);
    db.prepare(`
      INSERT INTO processing_jobs (
        id, report_id, page_id, job_type, status, attempts, pipeline_version, deduplication_key, error_code, error_message, created_at, finished_at
      ) VALUES ('ai-audit-job-old', ?, NULL, 'ai_extract', 'failed', 2, 'test', 'ai-audit-job-old-key', 'AI_ERROR', '模型返回异常', '2026-07-20 12:00:00', CURRENT_TIMESTAMP)
    `).run(upload.reportId);
    db.prepare(`
      INSERT INTO report_extractions (
        id, report_id, job_id, provider, model, prompt_version, fields_json,
        evidence_json, confidence_json, raw_response_json, input_characters,
        prompt_tokens, completion_tokens, elapsed_ms
      ) VALUES ('ai-audit-extract', ?, 'ai-audit-job', 'test-provider', 'test-model', 'test',
        '{}', '{}', '{}', '{}', 1200, 80, 40, 900)
    `).run(upload.reportId);
    const aiAudit = getAiAuditSummary(manager);
    assert.equal(aiAudit.summary.callCount, 3);
    assert.equal(aiAudit.summary.successJobs, 1);
    assert.equal(aiAudit.summary.failedJobs, 1);
    assert.equal(aiAudit.summary.totalTokens, 120);
    const firstAiAuditPage = getAiAuditSummary(manager, 1);
    assert.equal(firstAiAuditPage.recent.length, 1);
    assert.equal(firstAiAuditPage.hasMore, true);
    assert.equal(firstAiAuditPage.nextCursor !== null, true);
    const secondAiAuditPage = getAiAuditSummary(manager, 1, firstAiAuditPage.nextCursor || undefined);
    assert.equal(secondAiAuditPage.recent[0].id, "ai-audit-job-old");
    assert.equal(secondAiAuditPage.hasMore, false);

    const backup = createBackup(manager);
    assert.equal(existsSync(backup.path), true);
    assert.equal((listAuditLogs(manager, 20) as Array<{ action: string }>).some((item) => item.action === "backup.create"), true);
    const auditPage = listUserOperationAuditLogs(manager, 3);
    assert.equal(auditPage.items.length, 3);
    assert.equal(auditPage.hasMore, true);
    assert.ok(auditPage.nextCursor);
    assert.equal(listUserOperationAuditLogs(manager, 3, auditPage.nextCursor || undefined).items.length > 0, true);
    const readableAudit = listUserOperationAuditLogs(manager, 20).items;
    assert.equal(readableAudit.some((item) => item.title === "创建完整备份"), true);
    const uploadAudit = readableAudit.find((item) => item.action === "report.upload");
    assert.ok(uploadAudit);
    assert.match(uploadAudit.description, /成员 本人/);
    assert.equal(uploadAudit.targetName, "人工校对报告");
    assert.doesNotMatch(uploadAudit.description, /member_[a-z0-9]+/);
    const pageDeleteAudit = readableAudit.find((item) => item.action === "report.page.delete");
    assert.ok(pageDeleteAudit);
    assert.equal(pageDeleteAudit.targetName, "人工校对报告 · 报告页面");
    const reminderStatusAudit = readableAudit.find((item) => item.action === "reminder.status");
    assert.ok(reminderStatusAudit);
    assert.match(reminderStatusAudit.description, /状态 已完成/);
    assert.doesNotMatch(reminderStatusAudit.description, /completed/);
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
});

test("renders dictionary and unknown user audit actions without leaking internal English labels", () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-readable-audit-"));
  process.env.STORAGE_DIR = storageDir;
  try {
    const db = getDatabase();
    db.prepare("INSERT INTO users (id, display_name, is_gateway_admin) VALUES (?, ?, 1)")
      .run(manager.id, manager.displayName);
    db.prepare(`
      INSERT INTO audit_logs (
        id, actor_user_id, action, target_type, target_id, detail_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      "audit-dictionary",
      manager.id,
      "dictionary.update",
      "indicator_dictionary",
      "dictionary-snapshot",
      JSON.stringify({ layer: "core", revision: 7, indicators: 115, aliases: 496 }),
      "2026-07-31 12:00:00"
    );
    db.prepare(`
      INSERT INTO audit_logs (
        id, actor_user_id, action, target_type, target_id, detail_json, created_at
      ) VALUES (?, ?, ?, ?, NULL, '{}', ?)
    `).run(
      "audit-unknown",
      manager.id,
      "future.internal_action",
      "internal_entity",
      "2026-07-31 11:00:00"
    );
    db.prepare(`
      INSERT INTO audit_logs (
        id, actor_user_id, action, target_type, target_id, detail_json, created_at
      ) VALUES (?, ?, ?, ?, ?, '{}', ?)
    `).run(
      "audit-deleted-backup",
      manager.id,
      "backup.delete",
      "backup",
      "backup_internal_identifier",
      "2026-07-31 10:00:00"
    );

    const logs = listUserOperationAuditLogs(manager, 10).items;
    const dictionary = logs.find((item) => item.id === "audit-dictionary");
    assert.ok(dictionary);
    assert.equal(dictionary.title, "同步内置指标字典");
    assert.equal(dictionary.targetLabel, "指标字典");
    assert.equal(dictionary.targetName, "内置字典版本 7");
    assert.equal(dictionary.description, "内置字典 · 版本 7 · 115 个指标 · 496 个别名");
    assert.doesNotMatch(
      `${dictionary.title}${dictionary.description}${dictionary.targetLabel}${dictionary.targetName}`,
      /dictionary\.update|indicator_dictionary/
    );

    const unknown = logs.find((item) => item.id === "audit-unknown");
    assert.ok(unknown);
    assert.equal(unknown.title, "未知操作");
    assert.equal(unknown.description, "未提供操作详情");
    assert.equal(unknown.targetLabel, "其他对象");
    assert.doesNotMatch(`${unknown.title}${unknown.description}${unknown.targetLabel}`, /future|internal/i);

    const deletedBackup = logs.find((item) => item.id === "audit-deleted-backup");
    assert.ok(deletedBackup);
    assert.equal(deletedBackup.targetName, "完整备份");
    assert.doesNotMatch(
      `${deletedBackup.title}${deletedBackup.description}${deletedBackup.targetLabel}${deletedBackup.targetName}`,
      /backup_internal_identifier/
    );
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
});

test("only administrators can clear user operation logs and the cleanup remains auditable", () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-clear-user-audit-"));
  process.env.STORAGE_DIR = storageDir;
  try {
    const db = getDatabase();
    db.prepare("INSERT INTO users (id, display_name, is_gateway_admin) VALUES (?, ?, 1)")
      .run(manager.id, manager.displayName);
    db.prepare(`
      INSERT INTO audit_logs (id, actor_user_id, action, target_type, detail_json)
      VALUES ('audit-first', ?, 'report.upload', 'report', '{}'),
             ('audit-second', ?, 'backup.create', 'backup', '{}')
    `).run(manager.id, manager.id);

    const regularUser: RequestUser = {
      id: "regular-user",
      displayName: "普通用户",
      provider: "fnos_gateway",
      authenticated: true,
      isGatewayAdmin: false
    };
    assert.throws(
      () => clearUserOperationAuditLogs(regularUser),
      /仅管理员可清理用户操作日志/
    );
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM audit_logs").get() as { count: number }).count, 2);

    assert.deepEqual(clearUserOperationAuditLogs(manager), { deletedCount: 2 });
    const remaining = listUserOperationAuditLogs(manager, 10).items;
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].action, "system.user_audit_clear");
    assert.equal(remaining[0].title, "清理用户操作日志");
    assert.equal(remaining[0].description, "清理 2 条记录");
    assert.equal(remaining[0].actorName, manager.displayName);
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
});

test("creates, lists, downloads and restores a full app backup", () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-full-backup-"));
  process.env.STORAGE_DIR = storageDir;
  try {
    const db = getDatabase();
    db.prepare("INSERT INTO users (id, display_name, is_gateway_admin) VALUES (?, ?, 1)")
      .run(manager.id, manager.displayName);
    db.prepare(`
      INSERT INTO health_members (id, display_name, relationship, created_by)
      VALUES ('records-member', '本人', 'self', ?)
    `).run(manager.id);
    db.prepare(`
      INSERT INTO member_permissions (member_id, user_id, permission, granted_by)
      VALUES ('records-member', ?, 'manager', ?)
    `).run(manager.id, manager.id);

    const upload = createUpload(manager, "records-member", [{ originalName: "backup-source.png", data: pngBytes() }]);
    db.prepare(`
      UPDATE reports SET title = '备份前报告', report_type = 'laboratory', status = 'ready',
        hospital_name_raw = '备份医院', report_issued_at = '2026-07-22'
      WHERE id = ?
    `).run(upload.reportId);
    const detailBefore = getReportDetail(manager, upload.reportId);
    const originalBefore = getReportPageFile(manager, upload.reportId, detailBefore.pages[0].id, "original");
    assert.equal(existsSync(originalBefore.path), true);

    const backup = createBackup(manager);
    assert.equal(existsSync(backup.path), true);
    assert.match(backup.filename, /^fnos-app-health-records-backup-\d{8}-\d{6}-\d{3}\.tar\.gz$/);
    assert.equal(listBackups(manager).some((item) => item.id === backup.id && item.reportCount === 1), true);
    const validation = validateBackup(manager, backup.id);
    assert.equal(validation.valid, true);
    assert.equal(validation.checksumAvailable, true);
    assert.ok(validation.fileCount > 0);
    assert.equal(validation.checkedCount, validation.fileCount);
    const extractRoot = mkdtempSync(join(tmpdir(), "health-records-backup-manifest-"));
    try {
      execFileSync("tar", ["-xzf", backup.path, "-C", extractRoot], { stdio: "pipe" });
      const manifestPath = join(extractRoot, "manifest.json");
      const databasePath = join(extractRoot, "db", "health-records.sqlite");
      const originalManifest = readFileSync(manifestPath, "utf8");
      const originalDatabase = readFileSync(databasePath);
      const manifest = JSON.parse(originalManifest) as {
        schemaVersion: number;
        appliedSchemaVersion: number;
        files: Array<{ path: string; sha256: string; sizeBytes: number }>;
      };
      assert.ok(manifest.files.some((item) => item.path === "db/health-records.sqlite" && /^[a-f0-9]{64}$/.test(item.sha256)));

      const forwardDatabase = new DatabaseSync(databasePath);
      forwardDatabase.prepare("INSERT INTO schema_migrations (version, name, checksum) VALUES (?, ?, ?)")
        .run(schemaVersion + 1, "future_schema", "test:future-schema");
      forwardDatabase.close();
      manifest.schemaVersion = schemaVersion + 1;
      manifest.appliedSchemaVersion = schemaVersion + 1;
      const databaseFile = manifest.files.find((item) => item.path === "db/health-records.sqlite")!;
      databaseFile.sizeBytes = statSync(databasePath).size;
      databaseFile.sha256 = createHash("sha256").update(readFileSync(databasePath)).digest("hex");
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
      const forwardArchive = join(storageDir, "future-backup.tar.gz");
      execFileSync("tar", ["-czf", forwardArchive, "-C", extractRoot, "."], { stdio: "pipe" });
      assert.throws(() => restoreUploadedBackup(manager, forwardArchive), /高于当前应用支持/);

      writeFileSync(databasePath, originalDatabase);
      writeFileSync(manifestPath, originalManifest);
      writeFileSync(databasePath, "tampered backup");
      const tamperedArchive = join(storageDir, "tampered-backup.tar.gz");
      execFileSync("tar", ["-czf", tamperedArchive, "-C", extractRoot, "."], { stdio: "pipe" });
      assert.throws(() => restoreUploadedBackup(manager, tamperedArchive), /备份校验失败/);
    } finally {
      rmSync(extractRoot, { recursive: true, force: true });
    }
    const download = getBackupDownload(manager, backup.id);
    assert.equal(download.filename, backup.filename);
    assert.equal(existsSync(download.path), true);

    db.prepare("UPDATE reports SET title = '被误改的报告' WHERE id = ?").run(upload.reportId);
    const restoredAdmin: RequestUser = {
      id: "new-device-admin",
      displayName: "新设备管理员",
      provider: "fnos_gateway",
      authenticated: true,
      isGatewayAdmin: true
    };
    db.prepare("INSERT INTO users (id, display_name, is_gateway_admin) VALUES (?, ?, 1)")
      .run(restoredAdmin.id, restoredAdmin.displayName);
    rmSync(join(storageDir, "reports"), { recursive: true, force: true });
    assert.equal(existsSync(originalBefore.path), false);

    const restored = restoreFullBackup(restoredAdmin, backup.id);
    assert.equal(restored.restored, true);
    assert.ok(restored.safetyBackupId);
    assert.equal(restored.identityRebind.userId, restoredAdmin.id);
    const restoredDb = getDatabase();
    const adminRows = restoredDb.prepare("SELECT id, is_gateway_admin AS isAdmin FROM users ORDER BY id")
      .all() as Array<{ id: string; isAdmin: number }>;
    assert.equal(adminRows.find((row) => row.id === restoredAdmin.id)?.isAdmin, 1);
    assert.equal(adminRows.find((row) => row.id === manager.id)?.isAdmin, 0);
    const restoredPermission = restoredDb.prepare(`
      SELECT permission FROM member_permissions WHERE member_id = 'records-member' AND user_id = ?
    `).get(restoredAdmin.id) as { permission: string } | undefined;
    assert.equal(restoredPermission?.permission, "manager");
    const detailAfter = getReportDetail(restoredAdmin, upload.reportId);
    assert.equal(detailAfter.title, "备份前报告");
    const originalAfter = getReportPageFile(restoredAdmin, upload.reportId, detailAfter.pages[0].id, "original");
    assert.equal(existsSync(originalAfter.path), true);
    assert.equal(listBackups(restoredAdmin).some((item) => item.id === restored.safetyBackupId && item.reason === "pre_restore"), true);
    assert.equal((listAuditLogs(restoredAdmin, 20) as Array<{ action: string }>).some((item) => item.action === "backup.restore"), true);
    assert.equal((listAuditLogs(restoredAdmin, 20) as Array<{ action: string }>).some((item) => item.action === "backup.identity_rebind"), true);
    const safetyBackup = getBackupDownload(restoredAdmin, restored.safetyBackupId);
    assert.equal(existsSync(safetyBackup.path), true);
    assert.deepEqual(deleteBackup(restoredAdmin, restored.safetyBackupId), { id: restored.safetyBackupId, deleted: true });
    assert.equal(existsSync(safetyBackup.path), false);
    assert.equal(listBackups(restoredAdmin).some((item) => item.id === restored.safetyBackupId), false);
    assert.equal((listAuditLogs(restoredAdmin, 20) as Array<{ action: string }>).some((item) => item.action === "backup.delete"), true);
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
});

test("preserves the current Docker administrator credential when restoring another deployment backup", () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-local-backup-restore-"));
  process.env.STORAGE_DIR = storageDir;
  process.env.AUTH_MODE = "local";
  const backupOwner: RequestUser = {
    id: "backup-local-admin",
    displayName: "备份设备管理员",
    provider: "local",
    authenticated: true,
    isGatewayAdmin: true
  };
  const restoringAdmin: RequestUser = {
    id: "current-local-admin",
    displayName: "当前设备管理员",
    provider: "local",
    authenticated: true,
    isGatewayAdmin: true
  };
  try {
    const db = getDatabase();
    const oldPassword = hashPassword("backup-device-password");
    db.prepare("INSERT INTO users (id, display_name, is_gateway_admin) VALUES (?, ?, 1)")
      .run(backupOwner.id, backupOwner.displayName);
    db.prepare(`
      INSERT INTO user_identities (id, user_id, provider, subject)
      VALUES ('backup-local-identity', ?, 'local', 'backup-admin')
    `).run(backupOwner.id);
    db.prepare(`
      INSERT INTO local_accounts (id, user_id, username, password_hash, password_salt)
      VALUES ('backup-local-account', ?, 'backup-admin', ?, ?)
    `).run(backupOwner.id, oldPassword.hash, oldPassword.salt);
    db.prepare(`
      INSERT INTO health_members (id, display_name, relationship, created_by)
      VALUES ('local-restore-member', '本人', 'self', ?)
    `).run(backupOwner.id);
    db.prepare(`
      INSERT INTO member_permissions (member_id, user_id, permission, granted_by)
      VALUES ('local-restore-member', ?, 'manager', ?)
    `).run(backupOwner.id, backupOwner.id);

    const backup = createBackup(backupOwner);
    const currentPassword = hashPassword("current-device-password");
    db.prepare("INSERT INTO users (id, display_name, is_gateway_admin) VALUES (?, ?, 1)")
      .run(restoringAdmin.id, restoringAdmin.displayName);
    db.prepare(`
      INSERT INTO user_identities (id, user_id, provider, subject)
      VALUES ('current-local-identity', ?, 'local', 'current-admin')
    `).run(restoringAdmin.id);
    db.prepare(`
      INSERT INTO local_accounts (id, user_id, username, password_hash, password_salt)
      VALUES ('current-local-account', ?, 'current-admin', ?, ?)
    `).run(restoringAdmin.id, currentPassword.hash, currentPassword.salt);

    const restored = restoreFullBackup(restoringAdmin, backup.id);
    assert.equal(restored.restored, true);
    assert.equal(restored.identityRebind.userId, restoringAdmin.id);
    assert.equal(restored.identityRebind.disabledLocalAccountCount, 1);

    const restoredDb = getDatabase();
    const currentAccount = restoredDb.prepare(`
      SELECT username, password_hash AS passwordHash, password_salt AS passwordSalt, disabled_at AS disabledAt
      FROM local_accounts WHERE user_id = ?
    `).get(restoringAdmin.id) as {
      username: string;
      passwordHash: string;
      passwordSalt: string;
      disabledAt: string | null;
    };
    assert.deepEqual({ ...currentAccount }, {
      username: "current-admin",
      passwordHash: currentPassword.hash,
      passwordSalt: currentPassword.salt,
      disabledAt: null
    });
    const oldAccount = restoredDb.prepare(`
      SELECT disabled_at AS disabledAt FROM local_accounts WHERE user_id = ?
    `).get(backupOwner.id) as { disabledAt: string | null };
    assert.ok(oldAccount.disabledAt);
    assert.equal(Number((restoredDb.prepare(`
      SELECT COUNT(*) AS count FROM member_permissions
      WHERE user_id = ? AND permission = 'manager'
    `).get(restoringAdmin.id) as { count: number }).count), 1);
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    delete process.env.AUTH_MODE;
    rmSync(storageDir, { recursive: true, force: true });
  }
});

test("confirms a reviewed report and returns redacted OCR text", async () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-records-review-"));
  process.env.STORAGE_DIR = storageDir;
  try {
    const db = getDatabase();
    db.prepare("INSERT INTO users (id, display_name, is_gateway_admin) VALUES (?, ?, 1)")
      .run(manager.id, manager.displayName);
    db.prepare(`
      INSERT INTO health_members (id, display_name, relationship, created_by)
      VALUES ('records-member', '本人', 'self', ?)
    `).run(manager.id);
    db.prepare(`
      INSERT INTO member_permissions (member_id, user_id, permission, granted_by)
      VALUES ('records-member', ?, 'manager', ?)
    `).run(manager.id, manager.id);
    const upload = createUpload(manager, "records-member", [{ originalName: "ocr.png", data: pngBytes() }]);
    const page = db.prepare("SELECT id FROM report_pages WHERE report_id = ?").get(upload.reportId) as { id: string };
    const job = db.prepare("SELECT id FROM processing_jobs WHERE report_id = ? AND job_type = 'ocr'")
      .get(upload.reportId) as { id: string };
    db.prepare(`
      INSERT INTO ocr_results (id, job_id, page_id, engine, model_version, lines_json, elapsed_ms)
      VALUES ('ocr-test', ?, ?, 'test-ocr', 'v1', ?, 8)
    `).run(job.id, page.id, JSON.stringify([
      { id: "source-title", text: "示例医院 检验报告", confidence: 0.98, box: [10, 10, 200, 32] },
      { id: "source-private", text: `联系电话 ${samplePhone}`, confidence: 0.97, box: [10, 40, 200, 62] },
      { text: "空腹血糖 5.2 mmol/L", confidence: 0.95 }
    ]));
    db.prepare("UPDATE reports SET status = 'needs_review' WHERE id = ?").run(upload.reportId);

    const ocr = listReportOcrText(manager, upload.reportId) as Array<{ text: string; lineCount: number }>;
    assert.equal(ocr.length, 1);
    assert.equal(ocr[0].lineCount, 2);
    assert.match(ocr[0].text, /示例医院|空腹血糖/);
    assert.doesNotMatch(ocr[0].text, new RegExp(`${samplePhone}|联系电话`));

    const pageOcr = await getReportPageOcrDetail(manager, upload.reportId, page.id);
    // 图片类历史数据无法可靠反推坐标系，保持 null 让前端按预览图自然尺寸换算。
    assert.equal(pageOcr?.coordWidth, null);
    assert.equal(pageOcr?.coordHeight, null);
    assert.deepEqual(pageOcr?.lines, [
      { id: "source-title", text: "示例医院 检验报告", confidence: 0.98, box: [10, 10, 200, 32] },
      { id: "page_1_line_3", text: "空腹血糖 5.2 mmol/L", confidence: 0.95, box: null }
    ]);

    assert.deepEqual(confirmReportReady(manager, upload.reportId), { id: upload.reportId, status: "ready" });
    const status = db.prepare("SELECT status FROM reports WHERE id = ?").get(upload.reportId) as { status: string };
    assert.equal(status.status, "ready");
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
});

test("heals legacy PDF OCR coordinate space on first read", async () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-ocr-coord-"));
  process.env.STORAGE_DIR = storageDir;
  try {
    const db = getDatabase();
    db.prepare("INSERT INTO users (id, display_name, is_gateway_admin) VALUES (?, ?, 1)")
      .run(manager.id, manager.displayName);
    db.prepare(`
      INSERT INTO health_members (id, display_name, relationship, created_by)
      VALUES ('records-member', '本人', 'self', ?)
    `).run(manager.id);
    db.prepare(`
      INSERT INTO member_permissions (member_id, user_id, permission, granted_by)
      VALUES ('records-member', ?, 'manager', ?)
    `).run(manager.id, manager.id);
    const upload = createUpload(manager, "records-member", [{ originalName: "ocr.png", data: pngBytes() }]);
    const page = db.prepare("SELECT id FROM report_pages WHERE report_id = ?").get(upload.reportId) as { id: string };
    // 模拟历史 PDF 页：坐标系未记录，内嵌文本框（点坐标）与 OCR 四点框（渲染像素）混存。
    db.prepare("UPDATE report_pages SET mime_type = 'application/pdf', storage_path = 'reports/legacy/source.pdf', source_page_number = 1, rotation = 0 WHERE id = ?")
      .run(page.id);
    const job = db.prepare("SELECT id FROM processing_jobs WHERE report_id = ? AND job_type = 'ocr'")
      .get(upload.reportId) as { id: string };
    db.prepare(`
      INSERT INTO ocr_results (id, job_id, page_id, engine, model_version, lines_json, elapsed_ms)
      VALUES ('ocr-legacy', ?, ?, 'test-ocr', 'v1', ?, 8)
    `).run(job.id, page.id, JSON.stringify([
      { id: "pdf-text", text: "内嵌文本行", confidence: 1, box: [10, 10, 200, 32] },
      { id: "ocr-line", text: "扫描行", confidence: 0.9, box: [[300, 120], [600, 120], [600, 180], [300, 180]] }
    ]));
    let inspectCalls = 0;
    const worker = async () => {
      inspectCalls += 1;
      return { pageCount: 1, pages: [{ pageNumber: 1, width: 600, height: 840 }] };
    };

    const detail = await getReportPageOcrDetail(manager, upload.reportId, page.id, worker as never);
    assert.equal(detail?.coordWidth, 600);
    assert.equal(detail?.coordHeight, 840);
    assert.deepEqual(detail?.lines, [
      { id: "pdf-text", text: "内嵌文本行", confidence: 1, box: [10, 10, 200, 32] },
      // 渲染像素按默认 renderScale=3 折算回页面点坐标
      { id: "ocr-line", text: "扫描行", confidence: 0.9, box: [100, 40, 200, 60] }
    ]);
    const persisted = db.prepare("SELECT lines_json AS linesJson, coord_width AS w, coord_height AS h FROM ocr_results WHERE id = 'ocr-legacy'")
      .get() as { linesJson: string; w: number; h: number };
    assert.equal(persisted.w, 600);
    assert.equal(persisted.h, 840);
    assert.deepEqual((JSON.parse(persisted.linesJson) as Array<{ box: number[] }>)[1].box, [100, 40, 200, 60]);

    // 第二次读取直接命中已归一的数据，不再调用 worker。
    const again = await getReportPageOcrDetail(manager, upload.reportId, page.id, worker as never);
    assert.equal(again?.coordWidth, 600);
    assert.equal(inspectCalls, 1);
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
});

test("heals legacy PDF OCR coordinate space with page rotation", async () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-ocr-coord-rot-"));
  process.env.STORAGE_DIR = storageDir;
  try {
    const db = getDatabase();
    db.prepare("INSERT INTO users (id, display_name, is_gateway_admin) VALUES (?, ?, 1)")
      .run(manager.id, manager.displayName);
    db.prepare(`
      INSERT INTO health_members (id, display_name, relationship, created_by)
      VALUES ('records-member', '本人', 'self', ?)
    `).run(manager.id);
    db.prepare(`
      INSERT INTO member_permissions (member_id, user_id, permission, granted_by)
      VALUES ('records-member', ?, 'manager', ?)
    `).run(manager.id, manager.id);
    const upload = createUpload(manager, "records-member", [{ originalName: "ocr.png", data: pngBytes() }]);
    const page = db.prepare("SELECT id FROM report_pages WHERE report_id = ?").get(upload.reportId) as { id: string };
    db.prepare("UPDATE report_pages SET mime_type = 'application/pdf', storage_path = 'reports/legacy/source.pdf', source_page_number = 1, rotation = 90 WHERE id = ?")
      .run(page.id);
    const job = db.prepare("SELECT id FROM processing_jobs WHERE report_id = ? AND job_type = 'ocr'")
      .get(upload.reportId) as { id: string };
    db.prepare(`
      INSERT INTO ocr_results (id, job_id, page_id, engine, model_version, lines_json, elapsed_ms)
      VALUES ('ocr-legacy-rot', ?, ?, 'test-ocr', 'v1', ?, 8)
    `).run(job.id, page.id, JSON.stringify([
      { id: "pdf-text", text: "内嵌文本行", confidence: 1, box: [10, 10, 200, 32] }
    ]));
    const worker = async () => ({ pageCount: 1, pages: [{ pageNumber: 1, width: 600, height: 840 }] });

    const detail = await getReportPageOcrDetail(manager, upload.reportId, page.id, worker as never);
    // 旋转 90° 后坐标系宽高互换，文本框同步落到旋转后的页面空间。
    assert.equal(detail?.coordWidth, 840);
    assert.equal(detail?.coordHeight, 600);
    assert.deepEqual(detail?.lines[0]?.box, [808, 10, 830, 200]);
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
});

test("falls back to other report timestamps for display when reportIssuedAt is missing", () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-display-date-"));
  process.env.STORAGE_DIR = storageDir;
  try {
    const db = getDatabase();
    db.prepare("INSERT INTO users (id, display_name) VALUES (?, ?)").run(manager.id, manager.displayName);
    db.prepare(`
      INSERT INTO health_members (id, display_name, relationship, created_by)
      VALUES ('display-date-member', '本人', 'self', ?)
    `).run(manager.id);
    db.prepare(`
      INSERT INTO member_permissions (member_id, user_id, permission, granted_by)
      VALUES ('display-date-member', ?, 'manager', ?)
    `).run(manager.id, manager.id);
    // 报告时间为空但有接收时间：展示日期借用接收时间
    db.prepare(`
      INSERT INTO reports (id, member_id, created_by, report_type, title, status, received_at)
      VALUES ('display-date-fallback', 'display-date-member', ?, 'laboratory', '血型鉴定', 'ready', '2024-01-09 11:11:00')
    `).run(manager.id);
    // 全部时间为空：展示日期保持为空，不借用上传时间
    db.prepare(`
      INSERT INTO reports (id, member_id, created_by, report_type, title, status)
      VALUES ('display-date-empty', 'display-date-member', ?, 'laboratory', '无时间报告', 'ready')
    `).run(manager.id);
    db.prepare(`
      INSERT INTO reports (id, member_id, created_by, report_type, title, status, report_issued_at)
      VALUES ('display-date-issued', 'display-date-member', ?, 'laboratory', '报告日期明确', 'ready', '2023-01-01')
    `).run(manager.id);
    db.prepare(`
      INSERT INTO reports (id, member_id, created_by, report_type, title, status, examined_at)
      VALUES ('display-date-fallback-later', 'display-date-member', ?, 'laboratory', '检查日期较晚', 'ready', '2025-01-01')
    `).run(manager.id);

    const list = listReports(manager, 30, 'display-date-member');
    const fallback = list.items.find((item) => item.id === 'display-date-fallback');
    const empty = list.items.find((item) => item.id === 'display-date-empty');
    assert.equal(fallback?.reportIssuedAt, '2024-01-09 11:11:00');
    assert.equal(empty?.reportIssuedAt, null);
    assert.deepEqual(list.items.map((item) => item.id), [
      'display-date-empty',
      'display-date-fallback-later',
      'display-date-fallback',
      'display-date-issued'
    ]);

    const ascending = listReports(manager, 30, { memberId: 'display-date-member', sort: 'report_date_asc' });
    assert.deepEqual(ascending.items.map((item) => item.id), [
      'display-date-issued',
      'display-date-fallback',
      'display-date-fallback-later',
      'display-date-empty'
    ]);
    const firstPage = listReports(manager, 2, { memberId: 'display-date-member' });
    const secondPage = listReports(manager, 2, {
      memberId: 'display-date-member',
      cursor: firstPage.nextCursor || undefined
    });
    assert.deepEqual([...firstPage.items, ...secondPage.items].map((item) => item.id), list.items.map((item) => item.id));

    const detail = getReportDetail(manager, 'display-date-fallback');
    assert.equal(detail.reportIssuedAt, '2024-01-09 11:11:00');
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
});

test("sanitizes stored reference bounds when reading report detail", () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-reference-detail-"));
  process.env.STORAGE_DIR = storageDir;
  try {
    const db = getDatabase();
    db.prepare("INSERT INTO users (id, display_name) VALUES (?, ?)").run(manager.id, manager.displayName);
    db.prepare(`
      INSERT INTO health_members (id, display_name, relationship, created_by)
      VALUES ('reference-detail-member', '本人', 'self', ?)
    `).run(manager.id);
    db.prepare(`
      INSERT INTO member_permissions (member_id, user_id, permission, granted_by)
      VALUES ('reference-detail-member', ?, 'manager', ?)
    `).run(manager.id, manager.id);
    db.prepare(`
      INSERT INTO reports (id, member_id, created_by, report_type, title, status, report_issued_at)
      VALUES ('reference-detail-report', 'reference-detail-member', ?, 'laboratory', '参考范围读取测试', 'ready', '2026-08-01')
    `).run(manager.id);
    const insertObservation = db.prepare(`
      INSERT INTO observations (
        id, report_id, section_name, item_name, result_text, numeric_value, unit,
        reference_low, reference_high, reference_text, evidence_json
      ) VALUES (?, 'reference-detail-report', '检验', ?, ?, ?, 'U/L', ?, ?, ?, '[]')
    `);
    insertObservation.run('reference-detail-reversed', '项目甲', '7', 7, 10, 5, '10-5');
    insertObservation.run('reference-detail-unsafe', '项目乙', '7', 7, 4, 10, '预测范围 4-10');
    insertObservation.run('reference-detail-one-sided', '项目丙', '7', 7, null, 10, '≤10');

    const observations = getReportDetail(manager, 'reference-detail-report').observations;
    const reversed = observations.find((item) => item.id === 'reference-detail-reversed');
    const unsafe = observations.find((item) => item.id === 'reference-detail-unsafe');
    const oneSided = observations.find((item) => item.id === 'reference-detail-one-sided');
    assert.ok(reversed);
    assert.equal(reversed.referenceLow, null);
    assert.equal(reversed.referenceHigh, null);
    assert.equal(reversed.referenceText, '10-5');
    assert.ok(unsafe);
    assert.equal(unsafe.referenceLow, null);
    assert.equal(unsafe.referenceHigh, null);
    assert.equal(unsafe.referenceText, '预测范围 4-10');
    assert.ok(oneSided);
    assert.equal(oneSided.referenceLow, null);
    assert.equal(oneSided.referenceHigh, 10);
    assert.equal(oneSided.referenceText, '≤10');
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
});

test("derives conflict-safe abnormal display fields when reading report detail", () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-abnormal-detail-"));
  process.env.STORAGE_DIR = storageDir;
  try {
    const db = getDatabase();
    db.prepare("INSERT INTO users (id, display_name) VALUES (?, ?)").run(manager.id, manager.displayName);
    db.prepare(`
      INSERT INTO health_members (id, display_name, relationship, created_by)
      VALUES ('abnormal-detail-member', '本人', 'self', ?)
    `).run(manager.id);
    db.prepare(`
      INSERT INTO member_permissions (member_id, user_id, permission, granted_by)
      VALUES ('abnormal-detail-member', ?, 'manager', ?)
    `).run(manager.id, manager.id);
    db.prepare(`
      INSERT INTO reports (id, member_id, created_by, report_type, title, status, report_issued_at)
      VALUES ('abnormal-detail-report', 'abnormal-detail-member', ?, 'laboratory', '异常解释读取测试', 'ready', '2026-08-01')
    `).run(manager.id);
    const insertObservation = db.prepare(`
      INSERT INTO observations (
        id, report_id, section_name, item_name, result_text, numeric_value, unit,
        reference_low, reference_high, reference_text, abnormal_flag, evidence_json
      ) VALUES (?, 'abnormal-detail-report', '检验', ?, ?, ?, 'U/L', 4, 10, '4-10', ?, ?)
    `);
    insertObservation.run('abnormal-detail-conflict', '项目甲', '7', 7, 'high', '[]');
    insertObservation.run('abnormal-detail-computed', '项目乙', '11', 11, null, '[]');
    insertObservation.run('abnormal-detail-inferred', '项目丙', '3 ↓', 3, null, JSON.stringify([{ quote: '项目丙 3 ↓' }]));

    const observations = getReportDetail(manager, 'abnormal-detail-report').observations;
    const conflict = observations.find((item) => item.id === 'abnormal-detail-conflict');
    const computed = observations.find((item) => item.id === 'abnormal-detail-computed');
    const inferred = observations.find((item) => item.id === 'abnormal-detail-inferred');
    assert.ok(conflict);
    assert.equal(conflict.abnormalFlag, 'high');
    assert.equal(conflict.reportedAbnormalFlag, 'high');
    assert.equal(conflict.displayAbnormalFlag, null);
    assert.equal(conflict.abnormalStatus, 'conflict');
    assert.equal(conflict.abnormalConflict, true);
    assert.ok(computed);
    assert.equal(computed.reportedAbnormalFlag, null);
    assert.equal(computed.displayAbnormalFlag, 'high');
    assert.equal(computed.abnormalSource, 'reference_range');
    assert.equal(computed.abnormalStatus, 'computed');
    assert.ok(inferred);
    assert.equal(inferred.reportedAbnormalFlag, 'low');
    assert.equal(inferred.displayAbnormalFlag, 'low');
    assert.equal(inferred.abnormalSource, 'result_marker');
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
});

test("returns concrete trend values from reviewed and archived reports", () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-records-trends-"));
  process.env.STORAGE_DIR = storageDir;
  try {
    const db = getDatabase();
    db.prepare("INSERT INTO users (id, display_name, is_gateway_admin) VALUES (?, ?, 1)")
      .run(manager.id, manager.displayName);
    db.prepare(`
      INSERT INTO health_members (id, display_name, relationship, created_by)
      VALUES ('records-member', '本人', 'self', ?)
    `).run(manager.id);
    db.prepare(`
      INSERT INTO member_permissions (member_id, user_id, permission, granted_by)
      VALUES ('records-member', ?, 'manager', ?)
    `).run(manager.id, manager.id);

    const first = createUpload(manager, "records-member", [{ originalName: "first.png", data: pngBytes() }]);
    const second = createUpload(manager, "records-member", [{ originalName: "second.png", data: anotherPngBytes() }]);
    const urine = createUpload(manager, "records-member", [{ originalName: "urine.png", data: thirdPngBytes() }]);
    db.prepare(`
      UPDATE reports SET title = ?, report_type = 'laboratory', status = ?, hospital_name_raw = '示例医院', report_issued_at = ?
      WHERE id = ?
    `).run("第一次血糖", "ready", "2026-06-01", first.reportId);
    db.prepare(`
      UPDATE reports SET title = ?, report_type = 'laboratory', status = ?, hospital_name_raw = '示例医院', report_issued_at = ?
      WHERE id = ?
    `).run("第二次血糖", "needs_review", "2026-07-21", second.reportId);
    db.prepare(`
      UPDATE reports SET title = ?, report_type = 'laboratory', status = ?, hospital_name_raw = '示例医院', report_issued_at = ?
      WHERE id = ?
    `).run("尿常规", "ready", "2026-07-22", urine.reportId);
    const insertObservation = db.prepare(`
      INSERT INTO observations (
        id, report_id, section_name, item_name, normalized_name, result_text, numeric_value, unit,
        reference_text, abnormal_flag, evidence_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertObservation.run("obs-first", first.reportId, "生化检验", "空腹血糖", "空腹血糖", "5.2 mmol/L", null, "MMOL/L", "3.9-6.1", "normal", JSON.stringify([{ pageNumber: 1, quote: "空腹血糖 5.2 mmol/L" }]));
    insertObservation.run("obs-second", second.reportId, "生化检验", "血糖", "血糖", "6.8", 6.8, "mmol/L", "3.9-6.1", "high", JSON.stringify([{ pageNumber: 1, quote: "血糖 6.8 mmol/L" }]));
    insertObservation.run("obs-urine-glu", urine.reportId, "尿常规", "GLU", "GLU", "阴性", null, null, "阴性", "normal", JSON.stringify([{ pageNumber: 1, quote: "GLU 阴性" }]));
    /* 同一报告重复上传（一份待确认、一份已归档），趋势应只保留已归档那份的点 */
    const duplicate = createUpload(manager, "records-member", [{ originalName: "duplicate.png", data: anotherPngBytes() }]);
    db.prepare(`
      UPDATE reports SET title = ?, report_type = 'laboratory', status = ?, hospital_name_raw = '示例医院', report_issued_at = ?
      WHERE id = ?
    `).run("重复血糖", "ready", "2026-07-21", duplicate.reportId);
    /* abnormal_flag 为 NULL 但证据原文带 ↑ 时，读取侧兜底推导为 high */
    insertObservation.run("obs-duplicate", duplicate.reportId, "生化检验", "血糖", "血糖", "6.8", 6.8, "mmol/L", "3.9--6.1", null, JSON.stringify([{ pageNumber: 1, quote: "血糖 6.8 mmol/L ↑" }]));
    const normalized = normalizeAllObservations(manager);
    assert.equal(normalized.normalized, 3);

    const trends = listTrendSeries(manager, "records-member") as Array<{
      name: string;
      unit: string;
      quality: string;
      sourceNames: string[];
      excludedPoints: Array<{ itemName: string; resultText: string; reason: string; sourcePage: { id: string } | null }>;
      pointCount: number;
      latestValue: number;
      delta: number;
      points: Array<{
        observationId: string;
        reportId: string;
        numericValue: number;
        reportStatus: string;
        abnormalFlag: string;
        evidenceQuote: string | null;
        sourcePage: { id: string; pageNumber: number; originalName: string } | null;
      }>;
    }>;
    assert.equal(trends.length, 1);
    assert.equal(trends[0].name, "空腹血糖");
    assert.equal(trends[0].unit, "mmol/L");
    assert.equal(trends[0].quality, "high");
    assert.deepEqual(new Set(trends[0].sourceNames), new Set(["空腹血糖", "血糖"]));
    // A urine result has no blood-glucose identity, even as an excluded point.
    assert.equal(trends[0].excludedPoints.length, 0);
    assert.equal(trends[0].pointCount, 2);
    assert.equal(trends[0].latestValue, 6.8);
    assert.equal(Number(trends[0].delta.toFixed(1)), 1.6);
	    assert.deepEqual(trends[0].points.map((point) => point.numericValue), [5.2, 6.8]);
	    assert.deepEqual(trends[0].points.map((point) => point.observationId), ["obs-first", "obs-duplicate"]);
	    assert.equal(trends[0].points[1].reportStatus, "ready");
    assert.equal(trends[0].points[1].abnormalFlag, "high");
    assert.equal(trends[0].points[1].evidenceQuote, "血糖 6.8 mmol/L ↑");
    assert.equal(trends[0].points[1].sourcePage?.pageNumber, 1);
    assert.equal(trends[0].points[1].sourcePage?.originalName, "duplicate.png");

    const issues = listIndicatorNormalizationIssues(manager);
    assert.equal(
      issues.some((item) => item.rawName === "GLU"),
      true,
      "low/excluded 的字典命中仍应留在治理池，避免被误认为可进入正式趋势"
    );
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
});

test("limits trend OCR evidence to the selected panel and result cell", () => {
  const storageDir = mkdtempSync(
    join(tmpdir(), "health-records-trend-panel-evidence-"),
  );
  process.env.STORAGE_DIR = storageDir;
  try {
    const db = getDatabase();
    db.prepare(
      "INSERT INTO users (id, display_name, is_gateway_admin) VALUES (?, ?, 1)",
    ).run(manager.id, manager.displayName);
    db.prepare(`
      INSERT INTO health_members (id, display_name, relationship, created_by)
      VALUES ('records-member', '本人', 'self', ?)
    `).run(manager.id);
    db.prepare(`
      INSERT INTO member_permissions (member_id, user_id, permission, granted_by)
      VALUES ('records-member', ?, 'manager', ?)
    `).run(manager.id, manager.id);
    const upload = createUpload(manager, "records-member", [
      { originalName: "two-panel.png", data: pngBytes() },
    ]);
    db.prepare(`
      UPDATE reports SET title = '双栏血常规', report_type = 'laboratory',
        status = 'ready', report_issued_at = '2026-08-10'
      WHERE id = ?
    `).run(upload.reportId);
    const pageRow = db
      .prepare("SELECT id FROM report_pages WHERE report_id = ?")
      .get(upload.reportId) as { id: string };
    const ocrJob = db
      .prepare(
        "SELECT id FROM processing_jobs WHERE report_id = ? AND job_type = 'ocr'",
      )
      .get(upload.reportId) as { id: string };
    db.prepare(
      "UPDATE processing_jobs SET status = 'completed', finished_at = CURRENT_TIMESTAMP WHERE id = ?",
    ).run(ocrJob.id);
    const ocrLines = [
      ["left-name", "白细胞数(WBC)"],
      ["left-result", "5.0"],
      ["left-unit", "10^9/L"],
      ["left-reference", "3.5-9.5"],
      ["right-name", "红细胞体积分布宽度(RDW-SD)"],
      ["right-result", "37.2↓"],
      ["right-unit", "fL"],
      ["right-reference", "39.9-52.2"],
    ].map(([id, text], index) => ({
      id,
      text,
      confidence: 0.99,
      box: [index * 100, 20, index * 100 + 80, 40],
    }));
    db.prepare(`
      INSERT INTO ocr_results (
        id, job_id, page_id, engine, model_version, lines_json,
        quality_score, quality_level, text_length, coord_width, coord_height
      ) VALUES ('panel-ocr', ?, ?, 'test', 'test', ?, 100, 'good', 80, 800, 100)
    `).run(ocrJob.id, pageRow.id, JSON.stringify(ocrLines));
    const quote =
      "白细胞数(WBC) | 5.0 | 10^9/L | 3.5-9.5 | 红细胞体积分布宽度(RDW-SD) | 37.2↓ | fL | 39.9-52.2";
    const insertObservation = db.prepare(`
      INSERT INTO observations (
        id, report_id, section_name, item_name, normalized_name, result_text,
        numeric_value, unit, reference_low, reference_high, abnormal_flag, evidence_json
      ) VALUES (?, ?, '血常规', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertObservation.run(
      "panel-wbc",
      upload.reportId,
      "白细胞数(WBC)",
      "白细胞计数",
      "5.0",
      5,
      "10^9/L",
      3.5,
      9.5,
      null,
      JSON.stringify([
        {
          pageNumber: 1,
          quote,
          table: {
            rowSourceLineIds: ocrLines.map((line) => line.id),
            sourceMap: {
              item: { sourceLineIds: ["left-name"] },
              result: { sourceLineIds: ["left-result"] },
              unit: { sourceLineIds: ["left-unit"] },
              reference: { sourceLineIds: ["left-reference"] },
            },
          },
        },
      ]),
    );
    insertObservation.run(
      "panel-rdw",
      upload.reportId,
      "红细胞体积分布宽度(RDW-SD)",
      "红细胞分布宽度标准差",
      "37.2↓",
      37.2,
      "fL",
      39.9,
      52.2,
      "low",
      JSON.stringify([
        {
          pageNumber: 1,
          quote,
          table: { rowSourceLineIds: ocrLines.map((line) => line.id) },
        },
      ]),
    );
    const insertNormalization = db.prepare(`
      INSERT INTO observation_normalizations (
        observation_id, canonical_key, canonical_name, canonical_value,
        canonical_unit, canonical_category, confidence, quality, matched_by,
        match_reason, version, source_origin
      ) VALUES (?, ?, ?, ?, ?, '血常规', 1, 'high', 'test', 'test', 'test', 'item_name')
    `);
    insertNormalization.run(
      "panel-wbc",
      "cbc_wbc",
      "白细胞计数",
      5,
      "10^9/L",
    );
    insertNormalization.run(
      "panel-rdw",
      "cbc_rdw_sd",
      "红细胞分布宽度标准差",
      37.2,
      "fL",
    );

    const trends = listTrendSeries(manager, "records-member") as Array<{
      name: string;
      points: Array<{
        sourceLineIds: string[];
        resultLineIds: string[];
      }>;
    }>;
    const wbc = trends.find((trend) => trend.name === "白细胞计数")?.points[0];
    const rdw = trends.find(
      (trend) => trend.name === "红细胞分布宽度标准差",
    )?.points[0];
    assert.deepEqual(wbc?.sourceLineIds, [
      "left-name",
      "left-result",
      "left-unit",
      "left-reference",
    ]);
    assert.deepEqual(wbc?.resultLineIds, ["left-result"]);
    assert.deepEqual(rdw?.sourceLineIds, [
      "right-name",
      "right-result",
      "right-unit",
      "right-reference",
    ]);
    assert.deepEqual(rdw?.resultLineIds, ["right-result"]);
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
});

test("uses the preferred same-report point for deterministic trend metadata", () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-trend-metadata-deterministic-"));
  process.env.STORAGE_DIR = storageDir;
  try {
    const db = getDatabase();
    db.prepare("INSERT INTO users (id, display_name, is_gateway_admin) VALUES (?, ?, 1)")
      .run(manager.id, manager.displayName);
    db.prepare(`
      INSERT INTO health_members (id, display_name, relationship, created_by)
      VALUES ('records-member', '本人', 'self', ?)
    `).run(manager.id);
    db.prepare(`
      INSERT INTO member_permissions (member_id, user_id, permission, granted_by)
      VALUES ('records-member', ?, 'manager', ?)
    `).run(manager.id, manager.id);

    const report = createUpload(manager, "records-member", [{ originalName: "trend.png", data: pngBytes() }]);
    db.prepare(`
      UPDATE reports SET title = '趋势确定性测试', report_type = 'checkup', status = 'ready',
        report_issued_at = '2026-07-20'
      WHERE id = ?
    `).run(report.reportId);
    db.prepare(`
      INSERT INTO observations (
        id, report_id, section_name, item_name, normalized_name, result_text, numeric_value, unit, evidence_json
      ) VALUES
        ('a-medium-weight', ?, '未标注', '身体重量', '体重', '70 kg', 70, 'kg', '[]'),
        ('z-high-weight', ?, '一般检查', '体重', '体重', '70 kg', 70, 'kg', '[{"pageNumber":1,"quote":"体重 70 kg"}]')
    `).run(report.reportId, report.reportId);
    db.prepare(`
      INSERT INTO observation_normalizations (
        observation_id, canonical_key, canonical_name, canonical_value, canonical_unit,
        confidence, quality, matched_by, match_reason, version
      ) VALUES
        ('a-medium-weight', 'body_weight', '体重', 70, 'kg', 0.7, 'medium', 'dictionary', '别名匹配', 'test-v1'),
        ('z-high-weight', 'body_weight', '体重', 70, 'kg', 1.0, 'high', 'dictionary', '精确匹配', 'test-v1')
    `).run();

    const trend = listTrendSeries(manager, "records-member")
      .find((series) => series.indicatorKey === "body_weight");
    assert.ok(trend);
    assert.equal(trend.pointCount, 1);
    assert.equal(trend.points[0].observationId, "z-high-weight");
    assert.equal(trend.quality, "high");
    assert.equal(trend.confidence, 1);
    assert.equal(trend.sectionName, "一般检查");
    assert.deepEqual(trend.sourceNames, ["身体重量", "体重"]);
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
});

test("prefers tabular result rows over narrative summary quotes for same-report trend points", () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-trend-tabular-vs-narrative-"));
  process.env.STORAGE_DIR = storageDir;
  try {
    const db = getDatabase();
    db.prepare("INSERT INTO users (id, display_name, is_gateway_admin) VALUES (?, ?, 1)")
      .run(manager.id, manager.displayName);
    db.prepare(`
      INSERT INTO health_members (id, display_name, relationship, created_by)
      VALUES ('records-member', '本人', 'self', ?)
    `).run(manager.id);
    db.prepare(`
      INSERT INTO member_permissions (member_id, user_id, permission, granted_by)
      VALUES ('records-member', ?, 'manager', ?)
    `).run(manager.id, manager.id);

    const report = createUpload(manager, "records-member", [{ originalName: "trend.png", data: pngBytes() }]);
    db.prepare(`
      UPDATE reports SET title = '表格行优选测试', report_type = 'checkup', status = 'ready',
        report_issued_at = '2026-07-20'
      WHERE id = ?
    `).run(report.reportId);
    db.prepare(`
      INSERT INTO observations (
        id, report_id, section_name, item_name, normalized_name, result_text, numeric_value, unit, evidence_json
      ) VALUES
        ('tabular-uric-acid', ?, '肾功三项', '血清尿酸', '尿酸', '454 μmol/L ↑', 454, 'μmol/L',
          '[{"pageNumber":11,"quote":"血清尿酸 | 454 μmol/L ↑ | 208~428 μmol/L"}]'),
        ('narrative-uric-acid', ?, '肾脏功能', '血清尿酸值', '尿酸', '454', 454, 'μmol/L',
          '[{"pageNumber":4,"quote":"血清尿酸值(454μmol/L)(参考值208-428)，高尿酸血症；建议调整饮食结构，以低嘌呤食物为主，内分泌代谢科随诊。"}]')
    `).run(report.reportId, report.reportId);
    db.prepare(`
      INSERT INTO observation_normalizations (
        observation_id, canonical_key, canonical_name, canonical_value, canonical_unit,
        confidence, quality, matched_by, match_reason, version
      ) VALUES
        ('tabular-uric-acid', 'renal_uric_acid', '尿酸', 454, 'μmol/L', 0.95, 'high', 'dictionary', '别名匹配', 'test-v1'),
        ('narrative-uric-acid', 'renal_uric_acid', '尿酸', 454, 'μmol/L', 1.0, 'high', 'dictionary', '章节匹配', 'test-v1')
    `).run();

    const trend = listTrendSeries(manager, "records-member")
      .find((series) => series.indicatorKey === "renal_uric_acid");
    assert.ok(trend);
    assert.equal(trend.pointCount, 1);
    // 叙述句 confidence 更高（1.0 vs 0.95），但表格行是原始定量来源，必须胜出
    assert.equal(trend.points[0].observationId, "tabular-uric-acid");
    assert.equal(trend.sectionName, "肾功三项");
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
});

test("normalizes common health checkup issue-pool indicators", () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-indicator-issues-"));
  process.env.STORAGE_DIR = storageDir;
  try {
    const db = getDatabase();
    installRemoteDictionarySnapshotForTests();
    db.prepare("INSERT INTO users (id, display_name, is_gateway_admin) VALUES (?, ?, 1)")
      .run(manager.id, manager.displayName);
    db.prepare(`
      INSERT INTO health_members (id, display_name, relationship, created_by)
      VALUES ('records-member', '本人', 'self', ?)
    `).run(manager.id);
    db.prepare(`
      INSERT INTO member_permissions (member_id, user_id, permission, granted_by)
      VALUES ('records-member', ?, 'manager', ?)
    `).run(manager.id, manager.id);

    const report = createUpload(manager, "records-member", [{ originalName: "checkup.png", data: pngBytes() }]);
    db.prepare(`
      UPDATE reports SET title = '年度体检', report_type = 'checkup', status = 'ready',
        hospital_name_raw = '深圳瑞慈瑞新健康体检中心', report_issued_at = '2026-06-15'
      WHERE id = ?
    `).run(report.reportId);
    const insertObservation = db.prepare(`
      INSERT INTO observations (
        id, report_id, section_name, item_name, normalized_name, result_text, numeric_value, unit, abnormal_flag
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertObservation.run("issue-bmi", report.reportId, "一般检查", "体重指数BMI", "体重指数", "23.4", 23.4, null, "normal");
    insertObservation.run("issue-weight", report.reportId, "一般检查", "身体重量", "体重", "72 公斤", 72, "公斤", "normal");
    insertObservation.run("issue-height", report.reportId, "基础测量", "Height", "身高", "1.75 m", 1.75, "m", "normal");
    insertObservation.run("issue-waist", report.reportId, "体格检查", "腰部周径", "腰围", "860 mm", 860, "mm", "normal");
    insertObservation.run("issue-uric", report.reportId, "肾脏功能", "血清尿酸", "血清尿酸", "450", 450, "μmol/L", "high");
    insertObservation.run("issue-endo", report.reportId, "检查所见", "内膜厚度", "子宫内膜厚度", "0.8", 0.8, "cm", "normal");
    insertObservation.run("issue-thyroid", report.reportId, "超声成像检查", "左叶甲状腺结节，C-TIRADS 3类", "甲状腺结节", "左叶甲状腺结节，C-TIRADS 3类", null, null, "abnormal");
    insertObservation.run("issue-hbv-dna", report.reportId, "乙型肝炎病毒核酸定量", "乙型肝炎病毒核酸定量", "乙型肝炎病毒核酸定量", "1200", 1200, "IU/ML", "abnormal");
    insertObservation.run("issue-hbsag", report.reportId, "乙肝两对半", "乙型肝炎表面抗原（定性）", "乙型肝炎表面抗原", "阴性", null, null, "normal");

    normalizeAllObservations(manager);
    const rows = db.prepare(`
      SELECT observation_id AS observationId, canonical_key AS canonicalKey, canonical_name AS canonicalName,
        canonical_value AS canonicalValue, canonical_unit AS canonicalUnit, quality, excluded_reason AS excludedReason
      FROM observation_normalizations
      WHERE observation_id LIKE 'issue-%'
    `).all() as Array<{
      observationId: string;
      canonicalKey: string | null;
      canonicalName: string | null;
      canonicalValue: number | null;
      canonicalUnit: string | null;
      quality: string;
      excludedReason: string | null;
    }>;
    const byId = new Map(rows.map((row) => [row.observationId, row]));

    assert.equal(byId.get("issue-bmi")?.canonicalKey, "body_bmi");
    assert.equal(byId.get("issue-bmi")?.quality, "medium");
    assert.equal(byId.get("issue-weight")?.canonicalKey, "body_weight");
    assert.equal(byId.get("issue-weight")?.canonicalValue, 72);
    assert.equal(byId.get("issue-weight")?.canonicalUnit, "kg");
    assert.equal(byId.get("issue-weight")?.quality, "high");
    assert.equal(byId.get("issue-height")?.canonicalKey, "body_height");
    assert.equal(byId.get("issue-height")?.canonicalValue, 175);
    assert.equal(byId.get("issue-height")?.canonicalUnit, "cm");
    assert.equal(byId.get("issue-waist")?.canonicalKey, "body_waist_circumference");
    assert.equal(byId.get("issue-waist")?.canonicalValue, 86);
    assert.equal(byId.get("issue-waist")?.canonicalUnit, "cm");
    assert.equal(byId.get("issue-uric")?.canonicalKey, "renal_uric_acid");
    assert.equal(byId.get("issue-uric")?.quality, "high");
    assert.equal(byId.get("issue-endo")?.canonicalKey, "gyn_endometrium_thickness");
    assert.equal(byId.get("issue-endo")?.canonicalUnit, "mm");
    assert.equal(byId.get("issue-endo")?.canonicalValue, 8);
    assert.equal(byId.get("issue-thyroid")?.canonicalKey, null);
    assert.equal(byId.get("issue-thyroid")?.quality, "low");
    assert.equal(byId.get("issue-hbv-dna")?.canonicalKey, "infectious_hbv_dna");
    assert.equal(byId.get("issue-hbv-dna")?.canonicalUnit, "IU/mL");
    assert.equal(byId.get("issue-hbsag")?.canonicalKey, "infectious_hbsag");
    assert.equal(byId.get("issue-hbsag")?.quality, "excluded");
    const trends = listTrendSeries(manager, "records-member") as Array<{
      name: string;
      unit: string | null;
      latestValue: number | null;
    }>;
    assert.equal(trends.some((item) => item.name === "体重" && item.unit === "kg" && item.latestValue === 72), true);
    assert.equal(trends.some((item) => item.name === "身高" && item.unit === "cm" && item.latestValue === 175), true);
    assert.equal(trends.some((item) => item.name === "腰围" && item.unit === "cm" && item.latestValue === 86), true);
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
});

test("keeps unknown indicators in the dictionary issue pool without AI-created catalog entries", async () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-dictionary-only-normalization-"));
  process.env.STORAGE_DIR = storageDir;
  try {
    const db = getDatabase();
    db.prepare("INSERT INTO users (id, display_name, is_gateway_admin) VALUES (?, ?, 1)")
      .run(manager.id, manager.displayName);
    db.prepare(`
      INSERT INTO health_members (id, display_name, relationship, created_by)
      VALUES ('records-member', '本人', 'self', ?)
    `).run(manager.id);
    db.prepare(`
      INSERT INTO member_permissions (member_id, user_id, permission, granted_by)
      VALUES ('records-member', ?, 'manager', ?)
    `).run(manager.id, manager.id);
    const report = createUpload(manager, "records-member", [{ originalName: "unknown.png", data: pngBytes() }]);
    db.prepare(`
      UPDATE reports SET title = '字典匹配测试', report_type = 'laboratory',
        status = 'ready', report_issued_at = '2026-07-21'
      WHERE id = ?
    `).run(report.reportId);
    db.prepare(`
      INSERT INTO observations (
        id, report_id, section_name, item_name, normalized_name,
        result_text, numeric_value, unit
      ) VALUES
        ('dictionary-known', ?, '血常规', '白细胞数目(WBC)', '白细胞数目', '6.2', 6.2, '10^9/L'),
        ('dictionary-unknown', ?, '特殊检查', '待维护新指标', '待维护新指标', '7.2', 7.2, 'U/L')
    `).run(report.reportId, report.reportId);

    const result = await normalizeAllObservationsFromDictionary(manager);
    assert.equal(result.normalized, 1);
    assert.equal(result.unknown, 1);
    const unknown = db.prepare(`
      SELECT canonical_key AS canonicalKey, matched_by AS matchedBy
      FROM observation_normalizations WHERE observation_id = 'dictionary-unknown'
    `).get() as { canonicalKey: string | null; matchedBy: string };
    assert.deepEqual({ ...unknown }, { canonicalKey: null, matchedBy: "none" });
    assert.equal(listIndicatorNormalizationIssues(manager).some((item) => item.rawName === "待维护新指标"), true);
    assert.equal(Number((db.prepare(`
      SELECT COUNT(*) AS count FROM indicator_catalog WHERE ai_managed = 1
    `).get() as { count: number }).count), 0);
    assert.equal(Number((db.prepare(`
      SELECT COUNT(*) AS count FROM ai_audit_events WHERE source = 'indicator_normalization'
    `).get() as { count: number }).count), 0);
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
});

test("summarizes report counts for the current member archive board", () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-records-summary-"));
  process.env.STORAGE_DIR = storageDir;
  try {
    const db = getDatabase();
    db.prepare("INSERT INTO users (id, display_name, is_gateway_admin) VALUES (?, ?, 1)")
      .run(manager.id, manager.displayName);
    db.prepare(`
      INSERT INTO health_members (id, display_name, relationship, created_by)
      VALUES ('records-member', '本人', 'self', ?)
    `).run(manager.id);
    db.prepare(`
      INSERT INTO member_permissions (member_id, user_id, permission, granted_by)
      VALUES ('records-member', ?, 'manager', ?)
    `).run(manager.id, manager.id);

    const ready = createUpload(manager, "records-member", [{ originalName: "ready.png", data: pngBytes() }]);
    const review = createUpload(manager, "records-member", [{ originalName: "review.png", data: pngBytes() }]);
    const processing = createUpload(manager, "records-member", [{ originalName: "processing.png", data: pngBytes() }]);
    db.prepare("UPDATE reports SET status = 'ready', report_issued_at = '2026-06-01' WHERE id = ?").run(ready.reportId);
    db.prepare("UPDATE reports SET status = 'needs_review', report_issued_at = '2026-07-21' WHERE id = ?").run(review.reportId);
    db.prepare("UPDATE reports SET status = 'processing' WHERE id = ?").run(processing.reportId);
    db.prepare(`
      INSERT INTO observations (id, report_id, item_name, normalized_name, result_text, numeric_value, unit, abnormal_flag, display_abnormal_flag, abnormal_conflict)
      VALUES ('summary-obs-1', ?, '血糖', '血糖', '6.8', 6.8, 'mmol/L', 'high', 'high', 0)
    `).run(review.reportId);

    const stats = getReportSummaryStats(manager, "records-member");
    assert.deepEqual(stats, {
      totalReports: 3,
      readyReports: 1,
      needsReviewReports: 1,
      processingReports: 1,
      failedReports: 0,
      totalPages: 3,
      observationCount: 1,
      abnormalObservationCount: 1,
      latestReportIssuedAt: "2026-07-21"
    });
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
});

test("deduplicates report abnormal counts by canonical indicator", () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-abnormal-dedup-"));
  process.env.STORAGE_DIR = storageDir;
  try {
    const db = getDatabase();
    db.prepare("INSERT INTO users (id, display_name, is_gateway_admin) VALUES (?, ?, 1)")
      .run(manager.id, manager.displayName);
    db.prepare(`
      INSERT INTO health_members (id, display_name, relationship, created_by)
      VALUES ('records-member', '本人', 'self', ?)
    `).run(manager.id);
    db.prepare(`
      INSERT INTO member_permissions (member_id, user_id, permission, granted_by)
      VALUES ('records-member', ?, 'manager', ?)
    `).run(manager.id, manager.id);

    const report = createUpload(manager, "records-member", [{ originalName: "checkup.png", data: pngBytes() }]);
    db.prepare("UPDATE reports SET status = 'ready', report_issued_at = '2026-07-21' WHERE id = ?").run(report.reportId);
    // 两套测量值：两个 BMI 观察都偏高且归一到同一 canonical 指标，应只计 1 项
    db.prepare(`
      INSERT INTO observations (id, report_id, item_name, result_text, numeric_value, unit, display_abnormal_flag, abnormal_conflict)
      VALUES
        ('dedup-bmi-1', ?, '体重指数BMI', '24.8', 24.8, 'kg/m²', 'high', 0),
        ('dedup-bmi-2', ?, '体重指数', '24.6', 24.6, 'kg/m²', 'high', 0),
        ('dedup-unmatched', ?, '特殊指标', '9.9', 9.9, 'U/L', 'low', 0),
        ('dedup-conflict', ?, '冲突指标', '5.0', 5.0, 'mmol/L', 'high', 1)
    `).run(report.reportId, report.reportId, report.reportId, report.reportId);
    db.prepare(`
      INSERT INTO observation_normalizations (
        observation_id, indicator_id, canonical_key, canonical_name,
        confidence, quality, matched_by, match_reason, version, source_origin, review_status
      ) VALUES
        ('dedup-bmi-1', NULL, 'body_bmi', '体重指数', 0.99, 'high', 'builtin_alias', 'test', 'v1', 'item_name', 'unreviewed'),
        ('dedup-bmi-2', NULL, 'body_bmi', '体重指数', 0.99, 'high', 'builtin_alias', 'test', 'v1', 'item_name', 'unreviewed'),
        ('dedup-conflict', NULL, 'metabolic_fpg', '空腹血糖', 0.99, 'high', 'builtin_alias', 'test', 'v1', 'item_name', 'unreviewed')
    `).run();

    // BMI 去重为 1 项 + 未匹配异常 1 项 = 2；冲突暂停项不计入
    const detail = getReportDetail(manager, report.reportId);
    assert.equal(detail.abnormalCount, 2);

    const listed = listReports(manager, 10, "records-member");
    assert.equal(listed.items.find((item) => item.id === report.reportId)?.abnormalCount, 2);

    const stats = getReportSummaryStats(manager, "records-member");
    assert.equal(stats.abnormalObservationCount, 2);
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
});
