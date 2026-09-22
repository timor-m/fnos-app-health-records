import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { closeDatabaseForTests, getDatabase } from "../database/client.ts";
import type { RequestUser } from "../domain/request-user.ts";
import {
  getReportDuplicateMetrics,
  listDuplicateReportOperations
} from "../services/records.service.ts";

const memberId = "p2-observability-member";
const admin: RequestUser = {
  id: "p2-observability-admin",
  displayName: "P2 可观测性回归管理员",
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
    VALUES (?, 'P2 重复识别回归成员', 'self', ?)
  `).run(memberId, admin.id);
  db.prepare(`
    INSERT INTO member_permissions (member_id, user_id, permission, granted_by)
    VALUES (?, ?, 'manager', ?)
  `).run(memberId, admin.id, admin.id);
  return db;
}

function insertReport(id: string, title: string, hospitalName = "") {
  getDatabase().prepare(`
    INSERT INTO reports (
      id, member_id, created_by, report_type, title, status,
      hospital_name_raw, report_issued_at, body_parts_json, identifiers_json
    ) VALUES (?, ?, ?, 'checkup', ?, 'ready', ?, '2025-02-04', '[]', '{}')
  `).run(id, memberId, admin.id, title, hospitalName || null);
}


test("P2 duplicate scan operations stay aggregate-only and bound retained history", () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-p2-duplicate-observability-"));
  process.env.STORAGE_DIR = storageDir;
  try {
    const db = seedIdentity();
    insertReport("sensitive-report-id", "不应进入运行记录的敏感报告标题", "不应进入运行记录的敏感医院");
    const insertOperation = db.prepare(`
      INSERT INTO report_duplicate_operations (
        id, operation, member_id, rule_version, status, purpose, requested_by,
        stats_json, created_at, started_at, finished_at
      ) VALUES (?, 'scan', ?, 'p2-v2', 'completed', 'historical_test', ?, ?, ?, ?, ?)
    `);
    for (let index = 0; index < 205; index += 1) {
      const timestamp = `2020-01-${String((index % 28) + 1).padStart(2, "0")} 00:${String(index % 60).padStart(2, "0")}:00`;
      insertOperation.run(
        `historical-scan-${String(index).padStart(3, "0")}`,
        memberId,
        admin.id,
        JSON.stringify({
          sourceReportsScanned: 1,
          candidateComparisons: 0,
          candidatePairs: index % 4,
          scanDurationMs: 10 + (index % 30)
        }),
        timestamp,
        timestamp,
        timestamp
      );
    }

    const metrics = getReportDuplicateMetrics(admin, memberId);
    assert.equal(Number.isFinite(metrics.scanDurationMs), true);
    assert.equal(metrics.scanPolicy.sourceReportLimit > 0, true);

    const retained = db.prepare(`
      SELECT COUNT(*) AS count FROM report_duplicate_operations
      WHERE member_id = ? AND operation = 'scan'
    `).get(memberId) as { count: number };
    assert.equal(retained.count, 200);

    const operations = listDuplicateReportOperations(admin, memberId, 100);
    const latestScan = operations.find((operation) => operation.purpose === "metrics");
    assert.ok(latestScan);
    assert.equal(latestScan.status, "completed");
    assert.equal(latestScan.ruleVersion, "family-v2");
    assert.equal(typeof latestScan.stats.scanDurationMs, "number");
    const serialized = JSON.stringify(latestScan);
    for (const forbidden of [
      "sensitive-report-id",
      "不应进入运行记录的敏感报告标题",
      "不应进入运行记录的敏感医院",
      "hospitalName",
      "title",
      "requestedBy"
    ]) {
      assert.equal(serialized.includes(forbidden), false, `operation leaked ${forbidden}`);
    }
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
});
