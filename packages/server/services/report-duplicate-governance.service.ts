import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { createError } from "h3";
import { rollbackAfterError, getDatabase } from "../database/client";
import type { RequestUser } from "../domain/request-user";
import { createId } from "../utils/identifier";
import { assertMemberAccess, assertMemberManage } from "./member.service";
import {
  currentReportDuplicateRuleVersion,
  normalizeReportDuplicateRuleSnapshot,
  type ReportDuplicateRuleSnapshot
} from "./report-duplicate-rules.service";

export type ReportDuplicateDecision = "duplicate" | "distinct";

export type ReportDuplicateDecisionRecord = {
  pairKey: string;
  memberId: string;
  leftReportId: string;
  leftTitle: string;
  leftStatus: string;
  rightReportId: string;
  rightTitle: string;
  rightStatus: string;
  decision: ReportDuplicateDecision;
  reason: string | null;
  evidence: Record<string, unknown>;
  ruleVersion: string;
  ruleSnapshot: ReportDuplicateRuleSnapshot;
  decidedBy: string | null;
  decidedByName: string | null;
  createdAt: string;
  updatedAt: string;
};

function parseJsonRecord(value: string | null | undefined) {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

export function orderedReportPair(leftReportId: string, rightReportId: string) {
  if (!leftReportId || !rightReportId || leftReportId === rightReportId) {
    throw createError({ statusCode: 400, statusMessage: "请选择两份不同的报告" });
  }
  return leftReportId < rightReportId
    ? { leftReportId, rightReportId }
    : { leftReportId: rightReportId, rightReportId: leftReportId };
}

export function reportDuplicatePairKey(leftReportId: string, rightReportId: string) {
  const pair = orderedReportPair(leftReportId, rightReportId);
  return createHash("sha256")
    .update(`${pair.leftReportId}\u0000${pair.rightReportId}`)
    .digest("base64url");
}

export function reportFileSignature(reportId: string) {
  const pages = getDatabase().prepare(`
    SELECT sha256, source_page_number AS sourcePageNumber, source_page_count AS sourcePageCount
    FROM report_pages
    WHERE report_id = ?
    ORDER BY page_number, id
  `).all(reportId) as Array<{
    sha256: string;
    sourcePageNumber: number | null;
    sourcePageCount: number | null;
  }>;
  if (!pages.length || pages.some((page) => !page.sha256)) return null;
  return pages
    .map((page) => `${page.sha256}:${page.sourcePageNumber || 0}:${page.sourcePageCount || 0}`)
    .sort()
    .join("|");
}

export function getReportDuplicateDecision(leftReportId: string, rightReportId: string) {
  const pairKey = reportDuplicatePairKey(leftReportId, rightReportId);
  return getDatabase().prepare(`
    SELECT decision, reason, evidence_json AS evidenceJson
    FROM report_duplicate_decisions
    WHERE pair_key = ?
  `).get(pairKey) as {
    decision: ReportDuplicateDecision;
    reason: string | null;
    evidenceJson: string;
  } | undefined;
}

export function shouldCollapseReportPair(leftReportId: string, rightReportId: string) {
  const decision = getReportDuplicateDecision(leftReportId, rightReportId);
  if (decision?.decision === "distinct") return false;
  if (decision?.decision === "duplicate") return true;
  const leftSignature = reportFileSignature(leftReportId);
  return Boolean(leftSignature && leftSignature === reportFileSignature(rightReportId));
}

function decisionRecord(pairKey: string) {
  const row = getDatabase().prepare(`
    SELECT decision.pair_key AS pairKey, decision.member_id AS memberId,
      decision.left_report_id AS leftReportId, left_report.title AS leftTitle, left_report.status AS leftStatus,
      decision.right_report_id AS rightReportId, right_report.title AS rightTitle, right_report.status AS rightStatus,
      decision.decision, decision.reason, decision.evidence_json AS evidenceJson,
      decision.rule_version AS ruleVersion, decision.rule_snapshot_json AS ruleSnapshotJson,
      decision.decided_by AS decidedBy, actor.display_name AS decidedByName,
      decision.created_at AS createdAt, decision.updated_at AS updatedAt
    FROM report_duplicate_decisions decision
    JOIN reports left_report ON left_report.id = decision.left_report_id
    JOIN reports right_report ON right_report.id = decision.right_report_id
    LEFT JOIN users actor ON actor.id = decision.decided_by
    WHERE decision.pair_key = ?
  `).get(pairKey) as Omit<ReportDuplicateDecisionRecord, "evidence" | "ruleSnapshot"> & {
    evidenceJson: string;
    ruleSnapshotJson: string;
  } | undefined;
  if (!row) return null;
  const { evidenceJson, ruleSnapshotJson, ...record } = row;
  return {
    ...record,
    evidence: parseJsonRecord(evidenceJson),
    ruleSnapshot: normalizeReportDuplicateRuleSnapshot(parseJsonRecord(ruleSnapshotJson))
  };
}

export function listReportDuplicateDecisions(user: RequestUser, memberId: string) {
  if (!memberId) throw createError({ statusCode: 400, statusMessage: "请选择成员" });
  assertMemberAccess(user, memberId);
  const rows = getDatabase().prepare(`
    SELECT decision.pair_key AS pairKey, decision.member_id AS memberId,
      decision.left_report_id AS leftReportId, left_report.title AS leftTitle, left_report.status AS leftStatus,
      decision.right_report_id AS rightReportId, right_report.title AS rightTitle, right_report.status AS rightStatus,
      decision.decision, decision.reason, decision.evidence_json AS evidenceJson,
      decision.rule_version AS ruleVersion, decision.rule_snapshot_json AS ruleSnapshotJson,
      decision.decided_by AS decidedBy, actor.display_name AS decidedByName,
      decision.created_at AS createdAt, decision.updated_at AS updatedAt
    FROM report_duplicate_decisions decision
    JOIN reports left_report ON left_report.id = decision.left_report_id
    JOIN reports right_report ON right_report.id = decision.right_report_id
    LEFT JOIN users actor ON actor.id = decision.decided_by
    WHERE decision.member_id = ?
    ORDER BY decision.updated_at DESC, decision.rowid DESC
  `).all(memberId) as Array<Omit<ReportDuplicateDecisionRecord, "evidence" | "ruleSnapshot"> & {
    evidenceJson: string;
    ruleSnapshotJson: string;
  }>;
  return rows.map((row) => {
    const { evidenceJson, ruleSnapshotJson, ...record } = row;
    return {
      ...record,
      evidence: parseJsonRecord(evidenceJson),
      ruleSnapshot: normalizeReportDuplicateRuleSnapshot(parseJsonRecord(ruleSnapshotJson))
    };
  });
}

type PersistReportDuplicateDecisionInput = {
  memberId: string;
  leftReportId: string;
  rightReportId: string;
  decision: ReportDuplicateDecision;
  reason: string | null;
  evidence: Record<string, unknown>;
  decidedBy: string;
  auditAction: "report.duplicate_decision" | "report.duplicate_merge";
};

function persistReportDuplicateDecision(db: DatabaseSync, input: PersistReportDuplicateDecisionInput) {
  const pair = orderedReportPair(input.leftReportId, input.rightReportId);
  const pairKey = reportDuplicatePairKey(pair.leftReportId, pair.rightReportId);
  const ruleSnapshot = normalizeReportDuplicateRuleSnapshot(input.evidence.ruleSnapshot);
  const evidence = { ...input.evidence, ruleSnapshot };
  const evidenceJson = JSON.stringify(evidence);
  const ruleSnapshotJson = JSON.stringify(ruleSnapshot);
  db.prepare(`
    INSERT INTO report_duplicate_decisions (
      pair_key, member_id, left_report_id, right_report_id, decision,
      reason, evidence_json, rule_version, rule_snapshot_json, decided_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(pair_key) DO UPDATE SET
      decision = excluded.decision,
      reason = excluded.reason,
      evidence_json = excluded.evidence_json,
      rule_version = excluded.rule_version,
      rule_snapshot_json = excluded.rule_snapshot_json,
      decided_by = excluded.decided_by,
      updated_at = CURRENT_TIMESTAMP
  `).run(
    pairKey,
    input.memberId,
    pair.leftReportId,
    pair.rightReportId,
    input.decision,
    input.reason,
    evidenceJson,
    ruleSnapshot.version,
    ruleSnapshotJson,
    input.decidedBy
  );
  db.prepare(`
    INSERT INTO report_duplicate_history (
      id, pair_key, member_id, left_report_id, right_report_id,
      event_type, decision, reason, evidence_json, rule_version, rule_snapshot_json, created_by
    ) VALUES (?, ?, ?, ?, ?, 'apply', ?, ?, ?, ?, ?, ?)
  `).run(
    createId("duplicate_history"),
    pairKey,
    input.memberId,
    pair.leftReportId,
    pair.rightReportId,
    input.decision,
    input.reason,
    evidenceJson,
    ruleSnapshot.version,
    ruleSnapshotJson,
    input.decidedBy
  );
  db.prepare(`
    INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, detail_json)
    VALUES (?, ?, ?, 'report_pair', ?, ?)
  `).run(createId("audit"), input.decidedBy, input.auditAction, pairKey, JSON.stringify({
    memberId: input.memberId,
    leftReportId: pair.leftReportId,
    rightReportId: pair.rightReportId,
    decision: input.decision,
    reason: input.reason,
    evidence,
    ruleVersion: ruleSnapshot.version,
    ruleSnapshot
  }));
  return pairKey;
}

export function recordReportDuplicateMerge(db: DatabaseSync, input: {
  memberId: string;
  sourceReportId: string;
  targetReportId: string;
  movedPages: number;
  decidedBy: string;
}) {
  return persistReportDuplicateDecision(db, {
    memberId: input.memberId,
    leftReportId: input.sourceReportId,
    rightReportId: input.targetReportId,
    decision: "duplicate",
    reason: "报告原件已人工合并",
    evidence: {
      source: "merge",
      sourceReportId: input.sourceReportId,
      targetReportId: input.targetReportId,
      movedPages: input.movedPages,
      ruleSnapshot: {
        version: currentReportDuplicateRuleVersion,
        ruleId: "manual.merge",
        signals: ["人工合并"],
        signalProfileKey: "人工合并"
      }
    },
    decidedBy: input.decidedBy,
    auditAction: "report.duplicate_merge"
  });
}

export function setReportDuplicateDecision(user: RequestUser, input: {
  reportId: string;
  candidateReportId: string;
  decision: ReportDuplicateDecision;
  reason?: string | null;
  evidence?: Record<string, unknown> | null;
}) {
  if (!user.authenticated) throw createError({ statusCode: 401, statusMessage: "请先登录" });
  if (!(["duplicate", "distinct"] as string[]).includes(input.decision)) {
    throw createError({ statusCode: 400, statusMessage: "重复报告判断无效" });
  }
  const pair = orderedReportPair(input.reportId, input.candidateReportId);
  const reports = getDatabase().prepare(`
    SELECT id, member_id AS memberId, status
    FROM reports
    WHERE id IN (?, ?)
  `).all(pair.leftReportId, pair.rightReportId) as Array<{
    id: string;
    memberId: string;
    status: string;
  }>;
  if (reports.length !== 2) throw createError({ statusCode: 404, statusMessage: "报告不存在" });
  if (reports[0].memberId !== reports[1].memberId) {
    throw createError({ statusCode: 409, statusMessage: "只能治理同一成员的报告" });
  }
  const memberId = reports[0].memberId;
  assertMemberManage(user, memberId);
  const pairKey = reportDuplicatePairKey(pair.leftReportId, pair.rightReportId);
  const reason = String(input.reason || "").trim().slice(0, 500) || null;
  const evidence = input.evidence && typeof input.evidence === "object" ? input.evidence : {};
  const db = getDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    persistReportDuplicateDecision(db, {
      memberId,
      leftReportId: pair.leftReportId,
      rightReportId: pair.rightReportId,
      decision: input.decision,
      reason,
      evidence,
      decidedBy: user.id,
      auditAction: "report.duplicate_decision"
    });
    db.exec("COMMIT");
  } catch (error) {
    rollbackAfterError(db);
    throw error;
  }
  return decisionRecord(pairKey);
}

export function setReportDuplicateDecisionsBatch(user: RequestUser, inputs: Array<{
  reportId: string;
  candidateReportId: string;
  decision: ReportDuplicateDecision;
  reason?: string | null;
  evidence?: Record<string, unknown> | null;
}>) {
  if (!user.authenticated) throw createError({ statusCode: 401, statusMessage: "请先登录" });
  if (!Array.isArray(inputs) || !inputs.length) {
    throw createError({ statusCode: 400, statusMessage: "请选择需要批量治理的候选" });
  }
  if (inputs.length > 100) {
    throw createError({ statusCode: 400, statusMessage: "单次最多处理 100 组重复候选" });
  }

  const prepared = inputs.map((input, index) => {
    if (!(input && (["duplicate", "distinct"] as string[]).includes(input.decision))) {
      throw createError({ statusCode: 400, statusMessage: `第 ${index + 1} 条重复报告判断无效` });
    }
    const pair = orderedReportPair(String(input.reportId || ""), String(input.candidateReportId || ""));
    return {
      ...pair,
      pairKey: reportDuplicatePairKey(pair.leftReportId, pair.rightReportId),
      decision: input.decision,
      reason: String(input.reason || "").trim().slice(0, 500) || null,
      evidence: input.evidence && typeof input.evidence === "object" && !Array.isArray(input.evidence)
        ? input.evidence
        : {}
    };
  });
  const pairKeys = new Set<string>();
  for (const item of prepared) {
    if (pairKeys.has(item.pairKey)) {
      throw createError({ statusCode: 409, statusMessage: "批量列表中存在重复的报告组合" });
    }
    pairKeys.add(item.pairKey);
  }

  const reportIds = [...new Set(prepared.flatMap((item) => [item.leftReportId, item.rightReportId]))];
  const placeholders = reportIds.map(() => "?").join(", ");
  const reportRows = getDatabase().prepare(`
    SELECT id, member_id AS memberId
    FROM reports
    WHERE id IN (${placeholders})
  `).all(...reportIds) as Array<{ id: string; memberId: string }>;
  if (reportRows.length !== reportIds.length) {
    throw createError({ statusCode: 404, statusMessage: "批量列表中存在已删除或不存在的报告" });
  }
  const memberByReport = new Map(reportRows.map((row) => [row.id, row.memberId]));
  const memberIds = new Set<string>();
  for (const item of prepared) {
    const leftMemberId = memberByReport.get(item.leftReportId);
    const rightMemberId = memberByReport.get(item.rightReportId);
    if (!leftMemberId || leftMemberId !== rightMemberId) {
      throw createError({ statusCode: 409, statusMessage: "只能批量治理同一成员的报告" });
    }
    memberIds.add(leftMemberId);
  }
  if (memberIds.size !== 1) {
    throw createError({ statusCode: 409, statusMessage: "单次批量操作只能处理同一成员" });
  }
  const memberId = [...memberIds][0];
  assertMemberManage(user, memberId);

  const db = getDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const [index, item] of prepared.entries()) {
      persistReportDuplicateDecision(db, {
        memberId,
        leftReportId: item.leftReportId,
        rightReportId: item.rightReportId,
        decision: item.decision,
        reason: item.reason,
        evidence: {
          ...item.evidence,
          governanceSource: "batch",
          batchIndex: index + 1,
          batchSize: prepared.length
        },
        decidedBy: user.id,
        auditAction: "report.duplicate_decision"
      });
    }
    db.prepare(`
      INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, detail_json)
      VALUES (?, ?, 'report.duplicate_batch', 'member', ?, ?)
    `).run(createId("audit"), user.id, memberId, JSON.stringify({
      applied: prepared.length,
      duplicateCount: prepared.filter((item) => item.decision === "duplicate").length,
      distinctCount: prepared.filter((item) => item.decision === "distinct").length,
      pairKeys: prepared.map((item) => item.pairKey)
    }));
    db.exec("COMMIT");
  } catch (error) {
    rollbackAfterError(db);
    throw error;
  }
  return {
    memberId,
    applied: prepared.length,
    duplicateCount: prepared.filter((item) => item.decision === "duplicate").length,
    distinctCount: prepared.filter((item) => item.decision === "distinct").length,
    pairKeys: prepared.map((item) => item.pairKey)
  };
}

function persistReportDuplicateDecisionUndo(
  db: DatabaseSync,
  existing: ReportDuplicateDecisionRecord,
  actorUserId: string
) {
  db.prepare("DELETE FROM report_duplicate_decisions WHERE pair_key = ?").run(existing.pairKey);
  db.prepare(`
    INSERT INTO report_duplicate_history (
      id, pair_key, member_id, left_report_id, right_report_id,
      event_type, decision, reason, evidence_json, rule_version, rule_snapshot_json, created_by
    ) VALUES (?, ?, ?, ?, ?, 'undo', ?, ?, ?, ?, ?, ?)
  `).run(
    createId("duplicate_history"),
    existing.pairKey,
    existing.memberId,
    existing.leftReportId,
    existing.rightReportId,
    existing.decision,
    existing.reason,
    JSON.stringify(existing.evidence),
    existing.ruleVersion,
    JSON.stringify(existing.ruleSnapshot),
    actorUserId
  );
  db.prepare(`
    INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, detail_json)
    VALUES (?, ?, 'report.duplicate_decision_undo', 'report_pair', ?, ?)
  `).run(createId("audit"), actorUserId, existing.pairKey, JSON.stringify({
    memberId: existing.memberId,
    leftReportId: existing.leftReportId,
    rightReportId: existing.rightReportId,
    previousDecision: existing.decision,
    ruleVersion: existing.ruleVersion,
    ruleSnapshot: existing.ruleSnapshot
  }));
}

export function undoReportDuplicateDecisionsBatch(user: RequestUser, pairKeys: string[]) {
  if (!user.authenticated) throw createError({ statusCode: 401, statusMessage: "请先登录" });
  const normalizedPairKeys = [...new Set((Array.isArray(pairKeys) ? pairKeys : [])
    .map((pairKey) => String(pairKey || "").trim())
    .filter(Boolean))];
  if (!normalizedPairKeys.length) {
    throw createError({ statusCode: 400, statusMessage: "请选择需要撤销的治理记录" });
  }
  if (normalizedPairKeys.length > 100) {
    throw createError({ statusCode: 400, statusMessage: "单次最多撤销 100 条治理记录" });
  }
  if (normalizedPairKeys.length !== pairKeys.length) {
    throw createError({ statusCode: 409, statusMessage: "批量撤销列表中存在重复或无效记录" });
  }
  const records = normalizedPairKeys.map((pairKey) => decisionRecord(pairKey));
  if (records.some((record) => !record)) {
    throw createError({ statusCode: 404, statusMessage: "批量列表中存在已撤销或不存在的治理记录" });
  }
  const existingRecords = records as ReportDuplicateDecisionRecord[];
  const memberIds = new Set(existingRecords.map((record) => record.memberId));
  if (memberIds.size !== 1) {
    throw createError({ statusCode: 409, statusMessage: "单次批量撤销只能处理同一成员" });
  }
  const memberId = existingRecords[0].memberId;
  assertMemberManage(user, memberId);

  const db = getDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const existing of existingRecords) {
      persistReportDuplicateDecisionUndo(db, existing, user.id);
    }
    db.prepare(`
      INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, detail_json)
      VALUES (?, ?, 'report.duplicate_batch_undo', 'member', ?, ?)
    `).run(createId("audit"), user.id, memberId, JSON.stringify({
      undone: existingRecords.length,
      pairKeys: normalizedPairKeys
    }));
    db.exec("COMMIT");
  } catch (error) {
    rollbackAfterError(db);
    throw error;
  }
  return { memberId, undone: existingRecords.length, pairKeys: normalizedPairKeys };
}

export function undoReportDuplicateDecision(user: RequestUser, pairKey: string) {
  if (!user.authenticated) throw createError({ statusCode: 401, statusMessage: "请先登录" });
  const existing = decisionRecord(pairKey);
  if (!existing) throw createError({ statusCode: 404, statusMessage: "重复报告治理记录不存在" });
  assertMemberManage(user, existing.memberId);
  const db = getDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    persistReportDuplicateDecisionUndo(db, existing, user.id);
    db.exec("COMMIT");
  } catch (error) {
    rollbackAfterError(db);
    throw error;
  }
  return { pairKey, undone: true };
}
