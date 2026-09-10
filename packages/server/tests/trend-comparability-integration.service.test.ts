import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { closeDatabaseForTests, getDatabase } from "../database/client";
import { normalizeReportObservations } from "../services/indicator-normalization.service";
import { listTrendSeries } from "../services/records.service";

const manager = {
  id: "trend-comparability-user",
  displayName: "管理员",
  authenticated: true,
  provider: "development",
  isGatewayAdmin: true,
} as const;

test("keeps points while governing cross-report range and condition drift", () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-trend-comparability-"));
  process.env.STORAGE_DIR = storageDir;
  try {
    const db = getDatabase();
    db.prepare("INSERT INTO users (id, display_name) VALUES (?, ?)").run(manager.id, manager.displayName);
    db.prepare(`
      INSERT INTO health_members (id, display_name, relationship, birth_date, created_by)
      VALUES ('trend-comparability-member', '本人', 'self', '1990-01-01', ?)
    `).run(manager.id);
    db.prepare(`
      INSERT INTO member_permissions (member_id, user_id, permission, granted_by)
      VALUES ('trend-comparability-member', ?, 'manager', ?)
    `).run(manager.id, manager.id);

    const insertReport = db.prepare(`
      INSERT INTO reports (id, member_id, created_by, report_type, title, status, report_issued_at)
      VALUES (?, 'trend-comparability-member', ?, 'laboratory', '检验报告', 'ready', ?)
    `);
    const insertObservation = db.prepare(`
      INSERT INTO observations (
        id, report_id, section_name, item_name, normalized_name, result_text,
        numeric_value, unit, reference_low, reference_high, reference_text, method
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const cases = [
      ["compare-weight-old", "2025-01-01", "compare-weight-old-point", "一般检查", "体重", "体重", "60 kg", 60, "kg", 50, 80, "50-80", null],
      ["compare-weight-new", "2026-01-01", "compare-weight-new-point", "一般检查", "体重", "体重", "65 kg", 65, "kg", 70, 100, "70-100", null],
      ["compare-glucose-old", "2025-02-01", "compare-glucose-old-point", "生化检验", "空腹血糖", "空腹血糖", "90 mg/dL", 90, "mg/dL", 70, 100, "70-100 mg/dL", null],
      ["compare-glucose-new", "2026-02-01", "compare-glucose-new-point", "生化检验", "空腹血糖", "空腹血糖", "5 mmol/L", 5, "mmol/L", 3.885, 5.55, "3.885-5.55 mmol/L", null],
      ["compare-wbc-old", "2025-03-01", "compare-wbc-old-point", "血常规", "白细胞计数", "白细胞计数", "6", 6, "10^9/L", 4, 10, "4-10", null],
      ["compare-wbc-new", "2026-03-01", "compare-wbc-new-point", "血常规", "白细胞计数", "白细胞计数", "6.2", 6.2, "10^9/L", 4, 10, "预测范围 4-10", null],
      ["compare-alt-old", "2025-04-01", "compare-alt-old-point", "肝功能", "ALT", "ALT", "20", 20, "U/L", null, 40, "≤40", null],
      ["compare-alt-new", "2026-04-01", "compare-alt-new-point", "肝功能", "ALT", "ALT", "21", 21, "U/L", 7, 40, "7-40", null],
      ["compare-ck-old", "2025-05-01", "compare-ck-old-point", "生化检验", "肌酸激酶", "肌酸激酶", "100", 100, "U/L", 40, 200, "40-200", null],
      ["compare-ck-new", "2026-05-01", "compare-ck-new-point", "生化检验", "肌酸激酶", "肌酸激酶", "110", 110, "U/L", 40, 200, "40-200", null],
    ] as const;
    for (const [reportId, date, observationId, section, itemName, normalizedName, result, value, unit, low, high, reference, method] of cases) {
      insertReport.run(reportId, manager.id, date);
      insertObservation.run(observationId, reportId, section, itemName, normalizedName, result, value, unit, low, high, reference, method);
      normalizeReportObservations(reportId);
    }

    const insertStructuredSection = db.prepare(`
      INSERT INTO report_structured_sections (
        id, report_id, section_key, section_title, content_text, evidence_json, source
      ) VALUES (?, ?, 'laboratory_specimen', '检验标本', ?, '[]', 'ai')
    `);
    insertStructuredSection.run('compare-ck-old-specimen', 'compare-ck-old', '血清');
    insertStructuredSection.run('compare-ck-new-specimen', 'compare-ck-new', '血浆');

    const trends = listTrendSeries(manager, "trend-comparability-member");
    const byKey = new Map(trends.map((series) => [series.indicatorKey, series]));

    const weight = byKey.get("body_weight");
    assert.ok(weight, `missing body_weight; keys=${[...byKey.keys()].join(",")}`);
    assert.equal(weight.pointCount, 2, "range drift must not delete trend points");
    assert.equal(weight.comparabilityStatus, "range_drift");
    assert.equal(weight.changeAssessmentAllowed, false);
    assert.equal(weight.points[0].referenceLow, 50);
    assert.equal(weight.points[1].referenceLow, 70, "each point must keep its own report range");
    assert.equal(weight.attentionLevel, "abnormal", "latest attention must use the latest report range");
    assert.equal(weight.attentionReason, "数值低于报告参考下限");
    assert.equal(weight.latestAbnormal, true, "range drift must not hide the latest point abnormality");
    assert.equal(weight.latestAbnormalDirection, "low");
    assert.equal(weight.abnormalContinuityStatus, "latest_abnormal");
    assert.equal(weight.attentionPriority, "attention");

    const glucose = byKey.get("glucose_fasting");
    assert.ok(glucose);
    assert.equal(glucose.comparabilityStatus, "comparable", "canonical-unit ranges should compare after conversion");
    assert.equal(glucose.changeAssessmentAllowed, true);

    const wbc = byKey.get("cbc_wbc");
    assert.ok(wbc);
    assert.equal(wbc.comparabilityStatus, "insufficient_evidence");
    assert.equal(wbc.changeAssessmentAllowed, true, "missing range evidence alone must not invent a conflict");
    assert.equal(wbc.points[1].referenceStatus, "raw_only");
    assert.equal(wbc.points[1].referenceLow, null);
    assert.equal(wbc.points[1].referenceHigh, null);

    const alt = byKey.get("liver_alt");
    assert.ok(alt, `missing liver_alt; keys=${[...byKey.keys()].join(",")}`);
    assert.equal(alt.comparabilityStatus, "comparable", "a stable shared upper boundary remains comparable");

    const ck = byKey.get("laboratory_ck");
    assert.ok(ck, `missing laboratory_ck; keys=${[...byKey.keys()].join(",")}`);
    assert.equal(ck.pointCount, 2);
    assert.equal(ck.comparabilityStatus, "condition_mismatch");
    assert.equal(ck.changeAssessmentAllowed, false);

    db.prepare("UPDATE observations SET method = 'fixture method a' WHERE id = 'compare-ck-new-point'").run();
    insertObservation.run('compare-ck-method-b', 'compare-ck-new', '生化检验', '肌酸激酶', '肌酸激酶', '120', 120, 'U/L', 40, 200, '40-200', 'fixture method b');
    normalizeReportObservations('compare-ck-new');
    const multiMethod = listTrendSeries(manager, 'trend-comparability-member').find(item => item.indicatorKey === 'laboratory_ck');
    assert.equal(multiMethod?.points.filter(point => point.reportId === 'compare-ck-new').length, 2, 'different methods within a report must survive deduplication');
    assert.deepEqual(multiMethod?.points.filter(point => point.reportId === 'compare-ck-new').map(point => point.comparisonMethod).sort(), ['fixture method a', 'fixture method b']);
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
});
