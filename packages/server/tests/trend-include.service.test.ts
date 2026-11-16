import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { closeDatabaseForTests, getDatabase } from "../database/client";
import { normalizeReportObservations } from "../services/indicator-normalization.service";
import { includeObservationInTrend } from "../services/observation-field-overrides.service";
import { listTrendSeries } from "../services/records.service";

const manager = {
  id: "include-user", displayName: "合成用户", authenticated: true, provider: "development", isGatewayAdmin: true,
} as const;
const viewer = { ...manager, id: "include-viewer", isGatewayAdmin: false };

test("manual include confirms one matched point without bypassing unit or pending time", () => {
  const dir = mkdtempSync(join(tmpdir(), "health-trend-include-"));
  process.env.STORAGE_DIR = dir;
  try {
    const db = getDatabase();
    db.prepare("INSERT INTO users (id, display_name) VALUES (?, ?)").run(manager.id, manager.displayName);
    db.prepare("INSERT INTO users (id, display_name) VALUES (?, ?)").run(viewer.id, "只读用户");
    db.prepare("INSERT INTO health_members (id, display_name, relationship, created_by) VALUES ('include-member', '合成成员', 'self', ?)").run(manager.id);
    db.prepare("INSERT INTO member_permissions (member_id, user_id, permission, granted_by) VALUES ('include-member', ?, 'manager', ?)").run(manager.id, manager.id);
    db.prepare("INSERT INTO member_permissions (member_id, user_id, permission, granted_by) VALUES ('include-member', ?, 'viewer', ?)").run(viewer.id, manager.id);
    db.prepare(`INSERT INTO reports (id, member_id, created_by, title, report_type, status, report_issued_at, hospital_name_raw)
      VALUES ('include-report', 'include-member', ?, '合成报告', 'laboratory', 'ready', '2026-03-01', '合成机构')`).run(manager.id);
    db.prepare(`INSERT INTO processing_jobs (id, report_id, job_type, status, attempts, pipeline_version, deduplication_key, finished_at)
      VALUES ('include-job', 'include-report', 'ai_extract', 'completed', 1, 'test', 'include-job', CURRENT_TIMESTAMP)`).run();
    db.prepare(`INSERT INTO report_extractions (id, report_id, job_id, provider, model, prompt_version, fields_json, evidence_json, confidence_json, raw_response_json)
      VALUES ('include-extraction', 'include-report', 'include-job', 'test', 'test', 'test', '{}', '{}', '{}', '{}')`).run();
    const insert = db.prepare(`INSERT INTO observations (id, report_id, item_name, result_text, numeric_value, unit, evidence_json)
      VALUES (?, 'include-report', '丙氨酸氨基转移酶', ?, ?, ?, ?)`);
    insert.run("alt-ready", "40", 40, "U/L", JSON.stringify([{ pageNumber: 1, quote: "丙氨酸氨基转移酶 40 U/L" }]));
    insert.run("alt-hidden", "42", 42, "U/L", JSON.stringify([{ pageNumber: 1, quote: "丙氨酸氨基转移酶 U/L" }]));
    insert.run("alt-unit", "7", 7, "kg", JSON.stringify([{ pageNumber: 1, quote: "丙氨酸氨基转移酶 7 kg" }]));
    db.prepare(`INSERT INTO reports (id, member_id, created_by, title, report_type, status, report_issued_at, hospital_name_raw)
      VALUES ('include-time-report', 'include-member', ?, '合成报告', 'laboratory', 'ready', '2026-03-02', '合成机构')`).run(manager.id);
    db.prepare(`INSERT INTO processing_jobs (id, report_id, job_type, status, attempts, pipeline_version, deduplication_key, finished_at)
      VALUES ('include-time-job', 'include-time-report', 'ai_extract', 'completed', 1, 'test', 'include-time-job', CURRENT_TIMESTAMP)`).run();
    db.prepare(`INSERT INTO report_extractions (id, report_id, job_id, provider, model, prompt_version, fields_json, evidence_json, confidence_json, raw_response_json)
      VALUES ('include-time-extraction', 'include-time-report', 'include-time-job', 'test', 'test', 'test', '{}', '{}', '{}', '{}')`).run();
    db.prepare(`INSERT INTO observations (id, report_id, item_name, result_text, numeric_value, unit, evidence_json)
      VALUES ('alt-time', 'include-time-report', '丙氨酸氨基转移酶', '9', 9, 'U/L', ?)`).run(JSON.stringify([{ pageNumber: 1, quote: "丙氨酸氨基转移酶 U/L" }]));
    db.prepare(`INSERT INTO report_examinations (id, report_id, source_key, confirmation_status)
      VALUES ('include-exam', 'include-time-report', 'synthetic-time', 'pending')`).run();
    db.prepare(`INSERT INTO observation_examinations (observation_id, examination_id, assignment_source)
      VALUES ('alt-time', 'include-exam', 'manual')`).run();
    normalizeReportObservations("include-report");
    normalizeReportObservations("include-time-report");

    const series = () => listTrendSeries(manager, "include-member").find((item) => item.indicatorKey === "liver_alt");
    const excluded = () => series()?.excludedPoints.map((point) => point.observationId) || [];
    const plotted = () => series()?.points.map((point) => point.observationId) || [];
    assert.deepEqual(plotted(), ["alt-ready"]);
    assert.deepEqual(excluded().sort(), ["alt-hidden", "alt-time", "alt-unit"]);

    assert.throws(() => includeObservationInTrend(viewer, "include-report", "alt-hidden", { canonicalKey: "liver_alt" }), /管理权限/);
    assert.throws(() => includeObservationInTrend(manager, "include-report", "alt-hidden", { canonicalKey: "liver_ast" }), /尚未归到当前标准指标/);
    assert.deepEqual(plotted(), ["alt-ready"]);

    const included = includeObservationInTrend(manager, "include-report", "alt-hidden", { canonicalKey: "liver_alt" });
    assert.equal(included.included, true);
    assert.equal(included.pendingTime, false);
    assert.equal(included.reason, null);
    assert.equal(included.canonicalName, "丙氨酸氨基转移酶");
    assert.ok(plotted().includes("alt-hidden"));
    assert.equal(excluded().includes("alt-hidden"), false);

    const incompatible = includeObservationInTrend(manager, "include-report", "alt-unit", { canonicalKey: "liver_alt" });
    assert.equal(incompatible.included, false);
    assert.match(incompatible.reason || "", /单位与标准指标不兼容/);
    assert.equal(plotted().includes("alt-unit"), false);
    assert.ok(excluded().includes("alt-unit"));

    const pending = includeObservationInTrend(manager, "include-time-report", "alt-time", { canonicalKey: "liver_alt" });
    assert.equal(pending.included, false);
    assert.equal(pending.pendingTime, true);
    assert.match(pending.reason || "", /检查时间/);
    assert.equal(plotted().includes("alt-time"), false);
    assert.equal(excluded().includes("alt-time"), false);
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});
