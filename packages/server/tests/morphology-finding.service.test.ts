import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { closeDatabaseForTests, getDatabase } from "../database/client.ts";
import {
  backfillLegacyMorphologyFindings,
  ignoreMorphologyFinding,
  listMorphologyTracking,
  mergeMorphologyTrackingGroups,
  rebuildMorphologyTrackingForAdministrator,
  rebuildMorphologyTrackingForMember,
  rebuildMorphologyTrackingIfNeeded,
  setMorphologyTracking,
  updateMorphologyFinding
} from "../services/morphology-finding.service.ts";
import type { RequestUser } from "../domain/request-user.ts";
import { normalizeAiExtraction, persistAiExtraction } from "../services/ai-extraction.service.ts";

test("moves only clear unmatched legacy morphology rows and remains idempotent", () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-morphology-"));
  process.env.STORAGE_DIR = storageDir;
  try {
    const db = getDatabase();
    db.exec(`
      INSERT INTO users (id, display_name) VALUES ('user-1', '测试用户');
      INSERT INTO health_members (id, display_name, created_by) VALUES ('member-1', '本人', 'user-1');
      INSERT INTO member_permissions (member_id, user_id, permission, granted_by)
      VALUES ('member-1', 'user-1', 'manager', 'user-1');
      INSERT INTO reports (
        id, member_id, created_by, report_type, title, status, report_issued_at
      ) VALUES (
        'report-1', 'member-1', 'user-1', 'checkup', '体检报告', 'ready', '2026-07-28'
      );
      INSERT INTO observations (
        id, report_id, section_name, item_name, result_text, evidence_json
      ) VALUES (
        'obs-morphology', 'report-1', '腹部彩超', '肝右叶囊肿',
        '大小约3.2×2.8cm，边界清晰', '[{"pageNumber":4,"quote":"肝右叶囊肿大小约3.2×2.8cm，边界清晰"}]'
      );
      INSERT INTO observations (
        id, report_id, section_name, item_name, result_text, numeric_value, unit
      ) VALUES (
        'obs-weight', 'report-1', '一般检查', '体重', '68', 68, 'kg'
      );
      INSERT INTO observations (
        id, report_id, section_name, item_name, result_text
      ) VALUES (
        'obs-protected', 'report-1', '腹部彩超', '胆囊结石', '阳性'
      );
      INSERT INTO indicator_catalog (
        id, canonical_key, display_name, category, source
      ) VALUES (
        'indicator-protected', 'protected_metric', '受保护指标', '其他检查', 'user'
      );
      INSERT INTO observation_normalizations (
        observation_id, indicator_id, canonical_key, canonical_name, confidence,
        quality, matched_by, match_reason, version
      ) VALUES (
        'obs-protected', 'indicator-protected', 'protected_metric', '受保护指标', 1,
        'high', 'manual', '测试保护', 'test'
      );
    `);

    const first = backfillLegacyMorphologyFindings();
    assert.deepEqual(first, { scanned: 2, migrated: 1, alreadyCompleted: false });
    const finding = db.prepare(`
      SELECT organ, laterality, finding_type AS findingType, finding_name AS findingName,
        size_length AS sizeLength, size_width AS sizeWidth, size_unit AS sizeUnit,
        raw_text AS rawText, source
      FROM morphology_findings WHERE report_id = 'report-1'
    `).get() as {
      organ: string;
      laterality: string;
      findingType: string;
      findingName: string;
      sizeLength: number;
      sizeWidth: number;
      sizeUnit: string;
      rawText: string;
      source: string;
    };
    assert.deepEqual({ ...finding }, {
      organ: "肝脏",
      laterality: "right",
      findingType: "囊肿",
      findingName: "肝右叶囊肿",
      sizeLength: 3.2,
      sizeWidth: 2.8,
      sizeUnit: "cm",
      rawText: "肝右叶囊肿大小约3.2×2.8cm，边界清晰",
      source: "legacy_migration"
    });
    const remaining = db.prepare("SELECT id FROM observations ORDER BY id").all() as Array<{ id: string }>;
    assert.deepEqual(remaining.map((row) => row.id), ["obs-protected", "obs-weight"]);
    assert.deepEqual(
      backfillLegacyMorphologyFindings(),
      { scanned: 0, migrated: 0, alreadyCompleted: true }
    );
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
});

test("keeps manual morphology edits and tracking decisions across rebuilds", () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-morphology-manual-"));
  process.env.STORAGE_DIR = storageDir;
  const owner: RequestUser = {
    id: "owner", displayName: "管理员", provider: "development", authenticated: true, isGatewayAdmin: true
  };
  const viewer: RequestUser = {
    id: "viewer", displayName: "查看者", provider: "development", authenticated: true, isGatewayAdmin: false
  };
  try {
    const db = getDatabase();
    db.exec(`
      INSERT INTO users (id, display_name) VALUES ('owner', '管理员'), ('viewer', '查看者');
      INSERT INTO health_members (id, display_name, created_by) VALUES ('member', '本人', 'owner');
      INSERT INTO member_permissions (member_id, user_id, permission, granted_by) VALUES
        ('member', 'owner', 'manager', 'owner'), ('member', 'viewer', 'viewer', 'owner');
      INSERT INTO reports (id, member_id, created_by, report_type, title, status, report_issued_at) VALUES
        ('r1', 'member', 'owner', 'imaging', '报告1', 'ready', '2024-01-01'),
        ('r2', 'member', 'owner', 'imaging', '报告2', 'ready', '2025-01-01'),
        ('r3', 'member', 'owner', 'imaging', '报告3', 'ready', '2026-01-01');
      INSERT INTO morphology_findings (
        id, report_id, organ, laterality, finding_type, finding_name, raw_text
      ) VALUES
        ('left-1', 'r1', '肾脏', 'left', '囊肿', '左肾囊肿', '左肾囊肿'),
        ('left-2', 'r2', '肾脏', 'left', '囊肿', '肾囊性灶', '左肾囊性灶'),
        ('right-1', 'r3', '肾脏', 'right', '囊肿', '右肾囊肿', '右肾囊肿'),
        ('unknown', 'r3', NULL, 'unspecified', '检查发现', '低回声区', '低回声区待确认'),
        ('generic-normal', 'r3', '前列腺', 'unspecified', '检查发现', '未见明显异常', '前列腺未见明显异常');
    `);

    rebuildMorphologyTrackingForMember("member");
    let result = listMorphologyTracking(owner, "member");
    assert.ok(!result.series.some((series) => series.points.some((point) => point.findingId === "generic-normal")));
    assert.ok(!result.untracked.some((item) => item.findingId === "generic-normal"));
    const leftGroup = result.series.find((item) => item.name === "左肾囊肿")?.trackingGroupId;
    const rightGroup = result.series.find((item) => item.name === "右肾囊肿")?.trackingGroupId;
    assert.ok(leftGroup);
    assert.ok(rightGroup);

    updateMorphologyFinding(owner, "unknown", {
      organ: "肝脏", findingType: "囊肿", findingName: "肝囊肿", sizeLength: 8, sizeUnit: "mm"
    });
    const edited = db.prepare(`SELECT source, manual_fields_json AS manualFieldsJson FROM morphology_findings WHERE id = 'unknown'`)
      .get() as { source: string; manualFieldsJson: string };
    assert.equal(edited.source, "manual");
    assert.deepEqual(JSON.parse(edited.manualFieldsJson).sort(), ["findingName", "findingType", "organ", "size"].sort());

    setMorphologyTracking(owner, "unknown", { mode: "separate" });
    const manualGroup = db.prepare(`SELECT tracking_group_id AS groupId FROM morphology_findings WHERE id = 'unknown'`)
      .get() as { groupId: string };
    assert.match(manualGroup.groupId, /^manual_morph_/);
    rebuildMorphologyTrackingForMember("member");
    assert.equal((db.prepare(`SELECT tracking_group_id AS groupId FROM morphology_findings WHERE id = 'unknown'`).get() as { groupId: string }).groupId, manualGroup.groupId);

    assert.throws(
      () => setMorphologyTracking(owner, "right-1", { mode: "existing", trackingGroupId: leftGroup }),
      /左右侧明确冲突/
    );
    setMorphologyTracking(owner, "left-2", { mode: "separate" });
    const splitGroup = (db.prepare(`SELECT tracking_group_id AS groupId FROM morphology_findings WHERE id = 'left-2'`).get() as { groupId: string }).groupId;
    assert.notEqual(splitGroup, leftGroup);
    mergeMorphologyTrackingGroups(owner, "member", splitGroup, leftGroup!);
    assert.equal((db.prepare(`SELECT tracking_group_id AS groupId FROM morphology_findings WHERE id = 'left-2'`).get() as { groupId: string }).groupId, leftGroup);

    ignoreMorphologyFinding(owner, "unknown");
    result = listMorphologyTracking(owner, "member");
    assert.ok(!result.series.some((series) => series.points.some((point) => point.findingId === "unknown")));
    assert.ok(!result.untracked.some((item) => item.findingId === "unknown"));
    assert.throws(() => updateMorphologyFinding(viewer, "left-1", { findingName: "无权修改" }), /仅有管理权限/);

    const actions = db.prepare(`SELECT action FROM audit_logs WHERE action LIKE 'morphology.%' ORDER BY action`).all() as unknown as Array<{ action: string }>;
    assert.deepEqual(new Set(actions.map((item) => item.action)), new Set([
      "morphology.ignore", "morphology.merge", "morphology.split", "morphology.update"
    ]));
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
});

test("keeps the selected morphology project name and shows manually separated pending findings", () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-morphology-project-actions-"));
  process.env.STORAGE_DIR = storageDir;
  const owner: RequestUser = {
    id: "owner", displayName: "管理员", provider: "development", authenticated: true, isGatewayAdmin: true
  };
  try {
    const db = getDatabase();
    db.exec(`
      INSERT INTO users (id, display_name) VALUES ('owner', '管理员');
      INSERT INTO health_members (id, display_name, created_by) VALUES ('member', '本人', 'owner');
      INSERT INTO member_permissions (member_id, user_id, permission, granted_by)
      VALUES ('member', 'owner', 'manager', 'owner');
      INSERT INTO reports (id, member_id, created_by, report_type, title, status, report_issued_at) VALUES
        ('source-report', 'member', 'owner', 'imaging', '较早报告', 'ready', '2024-01-01'),
        ('link-report', 'member', 'owner', 'imaging', '待归入报告', 'ready', '2024-06-01'),
        ('target-report', 'member', 'owner', 'imaging', '较新报告', 'ready', '2025-01-01'),
        ('pending-report', 'member', 'owner', 'imaging', '待确认报告', 'ready', '2026-01-01');
      INSERT INTO morphology_findings (
        id, report_id, organ, region, laterality, finding_type, finding_name,
        raw_text, tracking_group_id, match_confidence, manual_fields_json
      ) VALUES
        ('source', 'source-report', '肾脏', '下极', 'left', '囊肿', '左肾下极囊肿',
          '左肾下极囊肿', 'source-group', 1, '["trackingGroup"]'),
        ('target', 'target-report', '肾脏', '上极', 'left', '囊肿', '左肾上极囊肿',
          '左肾上极囊肿', 'target-group', 1, '["trackingGroup"]'),
        ('link', 'link-report', '肾脏', '中部', 'left', '囊肿', '左肾中部囊肿',
          '左肾中部囊肿', NULL, NULL, '[]'),
        ('pending', 'pending-report', NULL, NULL, 'unspecified', '检查发现', '低回声区',
          '低回声区待确认', NULL, NULL, '[]');
    `);

    const beforeMerge = listMorphologyTracking(owner, "member");
    const targetName = beforeMerge.series.find((item) => item.trackingGroupId === "target-group")?.name;
    assert.equal(targetName, "左肾上极囊肿");

    const linked = setMorphologyTracking(owner, "link", {
      mode: "existing", trackingGroupId: "target-group"
    });
    assert.equal(linked.series.find((item) => item.trackingGroupId === "target-group")?.name, targetName);

    const merged = mergeMorphologyTrackingGroups(owner, "member", "source-group", "target-group");
    const mergedSeries = merged.series.find((item) => item.trackingGroupId === "target-group");
    assert.equal(mergedSeries?.name, targetName);
    assert.deepEqual(mergedSeries?.points.map((point) => point.findingId), ["source", "link", "target"]);

    const separated = setMorphologyTracking(owner, "pending", { mode: "separate" });
    const pendingSeries = separated.series.find((item) =>
      item.points.some((point) => point.findingId === "pending")
    );
    assert.equal(pendingSeries?.name, "低回声区");
    assert.equal(pendingSeries?.pointCount, 1);
    assert.ok(!separated.untracked.some((item) => item.findingId === "pending"));
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
});

test("preserves matched manual morphology fields when AI extraction is persisted again", () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-morphology-ai-protection-"));
  process.env.STORAGE_DIR = storageDir;
  try {
    const db = getDatabase();
    db.exec(`
      INSERT INTO users (id, display_name) VALUES ('owner', '管理员');
      INSERT INTO health_members (id, display_name, created_by) VALUES ('member', '本人', 'owner');
      INSERT INTO reports (id, member_id, created_by, report_type, title, status)
      VALUES ('report', 'member', 'owner', 'imaging', '报告', 'processing');
      INSERT INTO processing_jobs (id, report_id, job_type, pipeline_version, deduplication_key)
      VALUES ('ai-job', 'report', 'ai_extract', 'test', 'manual-protection-test');
      INSERT INTO morphology_findings (
        id, report_id, organ, region, laterality, finding_type, finding_name,
        size_length, size_unit, raw_text, evidence_json, tracking_group_id,
        match_confidence, source, manual_fields_json
      ) VALUES (
        'protected', 'report', '肝脏', '右叶', 'right', '囊肿', '人工名称',
        8, 'mm', '肝右叶囊肿约8mm', '[{"pageNumber":1,"quote":"肝右叶囊肿约8mm"}]',
        'manual_group', 1, 'manual', '["findingName","size","trackingGroup"]'
      );
    `);
    const normalized = normalizeAiExtraction({
      reportType: "imaging",
      morphologyFindings: [{
        organ: "肝脏", region: "右叶", laterality: "right", findingType: "囊肿",
        findingName: "AI 新名称", presence: "present",
        size: { length: 12, unit: "mm" }, morphology: "边界清晰",
        rawText: "肝右叶囊肿约8mm",
        evidence: [{ pageNumber: 1, quote: "肝右叶囊肿约8mm" }]
      }]
    });
    persistAiExtraction("report", "ai-job", {
      provider: "test", model: "test", promptVersion: "test",
      ...normalized, rawResponseJson: "{}", promptTokens: 1, completionTokens: 1, elapsedMs: 1
    }, 100);
    const row = db.prepare(`
      SELECT id, finding_name AS findingName, size_length AS sizeLength,
        morphology_text AS morphology, tracking_group_id AS trackingGroupId,
        manual_fields_json AS manualFieldsJson
      FROM morphology_findings WHERE report_id = 'report'
    `).get() as {
      id: string; findingName: string; sizeLength: number; morphology: string;
      trackingGroupId: string; manualFieldsJson: string;
    };
    assert.deepEqual({
      id: row.id, findingName: row.findingName, sizeLength: row.sizeLength,
      morphology: row.morphology, trackingGroupId: row.trackingGroupId,
      manualFields: JSON.parse(row.manualFieldsJson)
    }, {
      id: "protected", findingName: "人工名称", sizeLength: 8,
      morphology: "边界清晰", trackingGroupId: "manual_group",
      manualFields: ["findingName", "size", "trackingGroup"]
    });
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
});

test("conservatively links morphology findings into member-scoped timelines", () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-morphology-tracking-"));
  process.env.STORAGE_DIR = storageDir;
  const owner: RequestUser = {
    id: "user-1",
    displayName: "测试管理员",
    provider: "development",
    authenticated: true,
    isGatewayAdmin: true
  };
  try {
    const db = getDatabase();
    db.exec(`
      INSERT INTO users (id, display_name, is_gateway_admin) VALUES
        ('user-1', '测试管理员', 1),
        ('user-2', '其他用户', 0);
      INSERT INTO health_members (id, display_name, created_by) VALUES
        ('member-1', '本人', 'user-1'),
        ('member-2', '其他成员', 'user-2');
      INSERT INTO member_permissions (member_id, user_id, permission, granted_by) VALUES
        ('member-1', 'user-1', 'manager', 'user-1'),
        ('member-2', 'user-2', 'manager', 'user-2');
    `);

    const insertReport = db.prepare(`
      INSERT INTO reports (
        id, member_id, created_by, report_type, title, status,
        hospital_name_raw, report_issued_at
      ) VALUES (?, ?, ?, 'checkup', ?, ?, ?, ?)
    `);
    insertReport.run("report-2023", "member-1", "user-1", "2023 体检", "ready", "示例健康管理中心", "2023-07-01");
    insertReport.run("report-2024", "member-1", "user-1", "2024 体检", "ready", "示例医院体检中心", "2024-07-01");
    insertReport.run("report-2025", "member-1", "user-1", "2025 体检", "needs_review", "示例医院健康管理中心", "2025-07-01");
    insertReport.run("report-trash", "member-1", "user-1", "回收站报告", "trashed", "示例医院", "2026-07-01");
    insertReport.run("report-other", "member-2", "user-2", "其他成员报告", "ready", "示例医院", "2025-07-01");

    const insertFinding = db.prepare(`
      INSERT INTO morphology_findings (
        id, report_id, organ, region, laterality, finding_type, finding_name,
        presence, size_length, size_width, size_unit, morphology_text,
        classification_system, classification_value, classification_text,
        raw_text, evidence_json, confidence
      ) VALUES (
        @id, @reportId, @organ, @region, @laterality, @findingType, @findingName,
        @presence, @sizeLength, @sizeWidth, @sizeUnit, @morphology,
        @classificationSystem, @classificationValue, @classificationText,
        @rawText, '[]', @confidence
      )
    `);
    const addFinding = (input: {
      id: string;
      reportId: string;
      organ: string | null;
      region?: string | null;
      laterality?: string;
      findingType: string;
      findingName: string;
      presence?: string;
      sizeLength?: number | null;
      sizeWidth?: number | null;
      sizeUnit?: string | null;
      morphology?: string | null;
      classificationSystem?: string | null;
      classificationValue?: string | null;
      classificationText?: string | null;
      rawText?: string;
      confidence?: number;
    }) => insertFinding.run({
      region: null,
      laterality: "unspecified",
      presence: "present",
      sizeLength: null,
      sizeWidth: null,
      sizeUnit: null,
      morphology: null,
      classificationSystem: null,
      classificationValue: null,
      classificationText: null,
      rawText: input.findingName,
      confidence: 0.95,
      ...input
    });

    addFinding({
      id: "liver-2024", reportId: "report-2024", organ: "肝", findingType: "囊性灶",
      findingName: "肝脏囊性灶", sizeLength: 3.2, sizeWidth: 2.8, sizeUnit: "cm"
    });
    addFinding({
      id: "liver-2025", reportId: "report-2025", organ: "肝脏", findingType: "囊肿",
      findingName: "肝囊肿", sizeLength: 38, sizeWidth: 30, sizeUnit: "mm"
    });
    addFinding({
      id: "liver-trash", reportId: "report-trash", organ: "肝脏", findingType: "囊肿",
      findingName: "肝囊肿", sizeLength: 60, sizeUnit: "mm"
    });

    addFinding({
      id: "renal-left", reportId: "report-2024", organ: "肾脏", laterality: "left",
      findingType: "囊肿", findingName: "左肾囊肿"
    });
    addFinding({
      id: "renal-right", reportId: "report-2025", organ: "肾脏", laterality: "right",
      findingType: "囊肿", findingName: "右肾囊肿"
    });

    addFinding({
      id: "thyroid-left", reportId: "report-2023", organ: "甲状腺", region: "左叶",
      findingType: "结节", findingName: "甲状腺左叶结节"
    });
    addFinding({
      id: "thyroid-right", reportId: "report-2024", organ: "甲状腺", region: "右叶",
      findingType: "结节", findingName: "甲状腺右叶结节"
    });
    addFinding({
      id: "thyroid-unspecified", reportId: "report-2025", organ: "甲状腺",
      findingType: "结节", findingName: "甲状腺结节"
    });

    addFinding({
      id: "polyp-a", reportId: "report-2024", organ: "胆囊", findingType: "息肉",
      findingName: "胆囊息肉", sizeLength: 4, sizeUnit: "mm", rawText: "胆囊息肉约4mm"
    });
    addFinding({
      id: "polyp-b", reportId: "report-2024", organ: "胆囊", findingType: "息肉",
      findingName: "胆囊息肉", sizeLength: 4, sizeUnit: "mm", rawText: "胆囊息肉约4mm"
    });

    addFinding({
      id: "breast-a", reportId: "report-2025", organ: "乳腺", laterality: "left",
      findingType: "结节", findingName: "左乳结节", sizeLength: 5, sizeUnit: "mm"
    });
    addFinding({
      id: "breast-b", reportId: "report-2025", organ: "乳腺", laterality: "left",
      findingType: "结节", findingName: "左乳结节", sizeLength: 9, sizeUnit: "mm"
    });

    addFinding({
      id: "prostate-2024", reportId: "report-2024", organ: "前列腺", findingType: "结节",
      findingName: "前列腺结节", classificationSystem: "PI-RADS", classificationValue: "2"
    });
    addFinding({
      id: "prostate-2025", reportId: "report-2025", organ: "前列腺", findingType: "结节",
      findingName: "前列腺结节", classificationSystem: "PI-RADS", classificationValue: "3"
    });

    addFinding({
      id: "other-member", reportId: "report-other", organ: "肝脏", findingType: "囊肿",
      findingName: "肝囊肿"
    });

    const rebuilt = rebuildMorphologyTrackingForMember("member-1");
    assert.equal(rebuilt.scanned, 13);
    assert.equal(rebuilt.linked, 10);
    assert.equal(rebuilt.untracked, 3);
    assert.equal(rebuilt.ambiguous, 3);

    const result = listMorphologyTracking(owner, "member-1");
    const liver = result.series.find((item) => item.name === "肝脏囊肿");
    assert.ok(liver);
    assert.equal(liver.pointCount, 2);
    assert.deepEqual(liver.points.map((point) => point.size.primaryMm), [32, 38]);
    assert.equal(liver.changeKind, "size_increased");
    assert.equal(liver.changeSummary, "原报告最大径较上次增加 6.0 mm");

    const renalSeries = result.series.filter((item) => item.organ === "肾脏");
    assert.deepEqual(renalSeries.map((item) => item.name).sort(), ["右肾囊肿", "左肾囊肿"]);
    assert.equal(result.series.find((item) => item.name === "胆囊息肉")?.pointCount, 1);
    assert.equal(result.series.find((item) => item.name === "前列腺结节")?.changeKind, "classification_changed");
    assert.equal(result.untracked.length, 3);
    assert.ok(result.untracked.some((item) => item.findingId === "thyroid-unspecified"));
    assert.ok(result.untracked.some((item) => item.findingId === "breast-a"));
    assert.ok(!result.series.some((item) => item.points.some((point) => point.reportId === "report-trash")));

    assert.throws(
      () => listMorphologyTracking(owner, "member-2"),
      /没有查看该成员形态变化的权限/
    );

    const firstStartupRebuild = rebuildMorphologyTrackingIfNeeded();
    assert.ok(firstStartupRebuild);
    assert.equal(rebuildMorphologyTrackingIfNeeded(), null);

    const adminResult = rebuildMorphologyTrackingForAdministrator(owner);
    assert.equal(adminResult.members, 2);
    const audit = db.prepare(`
      SELECT action, target_type AS targetType
      FROM audit_logs WHERE action = 'maintenance.rebuild_morphology_tracking'
    `).get() as { action: string; targetType: string };
    assert.deepEqual({ ...audit }, {
      action: "maintenance.rebuild_morphology_tracking",
      targetType: "morphology_finding"
    });
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
});
