import { runTrendSnapshotTasksOnce } from '../services/trend-snapshot-runner.service';
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { closeDatabaseForTests, getDatabase } from "../database/client.ts";
import type { RequestUser } from "../domain/request-user.ts";
import { normalizeReportObservations } from "../services/indicator-normalization.service.ts";
import { listTrendSeries, updateTrendPin } from "../services/records.service.ts";

const userA: RequestUser = {
  id: "trend-pin-user-a",
  displayName: "用户 A",
  provider: "fnos_gateway",
  authenticated: true,
  isGatewayAdmin: false
};

const userC: RequestUser = {
  id: "trend-pin-user-c",
  displayName: "用户 C",
  provider: "fnos_gateway",
  authenticated: true,
  isGatewayAdmin: false
};

test("keeps trend pins isolated by user and member", async () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-trend-pins-"));
  process.env.STORAGE_DIR = storageDir;
  try {
    const db = getDatabase();
    db.prepare("INSERT INTO users (id, display_name, is_gateway_admin) VALUES (?, ?, 0)")
      .run(userA.id, userA.displayName);
    db.prepare("INSERT INTO users (id, display_name, is_gateway_admin) VALUES (?, ?, 0)")
      .run(userC.id, userC.displayName);
    db.prepare(`
      INSERT INTO health_members (id, display_name, relationship, created_by)
      VALUES ('trend-pin-member', '家庭成员', 'other', ?)
    `).run(userA.id);
    const insertPermission = db.prepare(`
      INSERT INTO member_permissions (member_id, user_id, permission, granted_by)
      VALUES ('trend-pin-member', ?, 'viewer', ?)
    `);
    insertPermission.run(userA.id, userA.id);
    insertPermission.run(userC.id, userA.id);
    const insertReport = db.prepare(`
      INSERT INTO reports (id, member_id, created_by, report_type, title, status, report_issued_at)
      VALUES (?, 'trend-pin-member', ?, 'laboratory', ?, 'ready', ?)
    `);
    insertReport.run("trend-pin-report-old", userA.id, "血脂检查", "2025-01-01");
    insertReport.run("trend-pin-report-new", userA.id, "血糖检查", "2026-01-01");
    const insertObservation = db.prepare(`
      INSERT INTO observations (
        id, report_id, section_name, item_name, normalized_name,
        result_text, numeric_value, unit, abnormal_flag
      ) VALUES (?, ?, '生化检验', ?, ?, ?, ?, 'mmol/L', 'normal')
    `);
    insertObservation.run(
      "trend-pin-observation-old",
      "trend-pin-report-old",
      "总胆固醇",
      "总胆固醇",
      "4.2",
      4.2
    );
    insertObservation.run(
      "trend-pin-observation-new",
      "trend-pin-report-new",
      "空腹血糖",
      "空腹血糖",
      "5.1",
      5.1
    );
    normalizeReportObservations("trend-pin-report-old");
    normalizeReportObservations("trend-pin-report-new");

    const initialA = listTrendSeries(userA, "trend-pin-member");
    const initialC = listTrendSeries(userC, "trend-pin-member");
    assert.deepEqual(initialA.map((series) => series.name), ["总胆固醇", "空腹血糖"]);
    assert.deepEqual(initialC.map((series) => series.name), ["总胆固醇", "空腹血糖"]);

    const cholesterol = initialA.find((series) => series.name === "总胆固醇");
    assert.ok(cholesterol);
    await runTrendSnapshotTasksOnce();
    updateTrendPin(userA, {
      memberId: "trend-pin-member",
      indicatorKey: cholesterol.indicatorKey,
      unit: cholesterol.unit
    }, true);

    const pinnedA = listTrendSeries(userA, "trend-pin-member");
    const unchangedC = listTrendSeries(userC, "trend-pin-member");
    assert.equal(pinnedA[0]?.name, "总胆固醇");
    assert.equal(pinnedA[0]?.pinned, true);
    assert.deepEqual(unchangedC.map((series) => series.name), ["总胆固醇", "空腹血糖"]);
    assert.equal(unchangedC.some((series) => series.pinned), false);

    updateTrendPin(userA, {
      memberId: "trend-pin-member",
      indicatorKey: cholesterol.indicatorKey,
      unit: cholesterol.unit
    }, false);
    assert.deepEqual(
      listTrendSeries(userA, "trend-pin-member").map((series) => series.name),
      ["总胆固醇", "空腹血糖"]
    );
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
});
