import { createError } from "h3";
import { rollbackAfterError, getDatabase } from "../database/client";
import { isAdministrator, type RequestUser } from "../domain/request-user";
import { createId } from "../utils/identifier";
import { writeLog } from "../utils/logger";
import { getAppConfig } from "../utils/runtime-config";
import { storageMigrationPaused } from '../utils/storage-migration-state';
import {
  normalizeAllObservationsFromDictionary,
  type IndicatorNormalizationMaintenanceResult
} from "./indicator-normalization.service";

type TaskStatus = "queued" | "running" | "completed" | "failed";
type TaskMode = "incremental" | "full";

type TaskRow = {
  id: string;
  mode: TaskMode;
  status: TaskStatus;
  requestedBy: string | null;
  totalUnits: number;
  completedUnits: number;
  attempts: number;
  resultJson: string | null;
  errorMessage: string | null;
  createdAt: string;
  startedAt: string | null;
  updatedAt: string;
  finishedAt: string | null;
};

export type IndicatorNormalizationTask = {
  id: string;
  mode: TaskMode;
  status: TaskStatus;
  totalReports: number;
  processedReports: number;
  progressPercent: number;
  attempts: number;
  result: IndicatorNormalizationMaintenanceResult | null;
  errorMessage: string | null;
  createdAt: string;
  startedAt: string | null;
  updatedAt: string;
  finishedAt: string | null;
};

let runnerPromise: Promise<number> | null = null;
let runnerStarted = false;
let runnerInterval: ReturnType<typeof setInterval> | null = null;
let runnerKickTimer: ReturnType<typeof setTimeout> | null = null;

function assertAdministrator(user: RequestUser) {
  if (!isAdministrator(user)) {
    throw createError({ statusCode: 403, statusMessage: "仅管理员可维护指标归一化" });
  }
}

function parseResult(value: string | null) {
  if (!value) return null;
  try {
    return JSON.parse(value) as IndicatorNormalizationMaintenanceResult;
  } catch {
    return null;
  }
}

function taskView(row: TaskRow): IndicatorNormalizationTask {
  const totalReports = Math.max(0, Number(row.totalUnits || 0));
  const processedReports = Math.max(0, Math.min(totalReports || Number.MAX_SAFE_INTEGER, Number(row.completedUnits || 0)));
  return {
    id: row.id,
    mode: row.mode,
    status: row.status,
    totalReports,
    processedReports,
    progressPercent: totalReports > 0
      ? Math.min(100, Math.round((processedReports / totalReports) * 100))
      : row.status === "completed" ? 100 : 0,
    attempts: Number(row.attempts || 0),
    result: parseResult(row.resultJson),
    errorMessage: row.errorMessage,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    updatedAt: row.updatedAt,
    finishedAt: row.finishedAt
  };
}

function taskSelect(where: string) {
  return `
    SELECT id, mode, status, requested_by AS requestedBy,
      total_units AS totalUnits, completed_units AS completedUnits,
      attempts, result_json AS resultJson, error_message AS errorMessage,
      created_at AS createdAt, started_at AS startedAt,
      updated_at AS updatedAt, finished_at AS finishedAt
    FROM maintenance_tasks
    WHERE task_type = 'indicator_normalization' ${where}
  `;
}

function taskById(id: string) {
  return getDatabase().prepare(`${taskSelect("AND id = ?")} LIMIT 1`).get(id) as TaskRow | undefined;
}

function latestTask() {
  return getDatabase().prepare(`
    ${taskSelect("")}
    ORDER BY status IN ('queued', 'running') DESC, created_at DESC, id DESC
    LIMIT 1
  `).get() as TaskRow | undefined;
}

export function getIndicatorNormalizationTask(user: RequestUser, id?: string) {
  assertAdministrator(user);
  const row = id ? taskById(id) : latestTask();
  return row ? taskView(row) : null;
}

export function enqueueIndicatorNormalizationTask(user: RequestUser, options?: { full?: boolean }) {
  assertAdministrator(user);
  const db = getDatabase();
  let createdId: string | null = null;
  db.exec("BEGIN IMMEDIATE");
  try {
    const existing = db.prepare(`
      ${taskSelect("AND status IN ('queued', 'running')")}
      ORDER BY created_at, id
      LIMIT 1
    `).get() as TaskRow | undefined;
    if (existing) {
      db.exec("COMMIT");
      return { ...taskView(existing), reused: true };
    }
    createdId = createId("maintenance");
    db.prepare(`
      INSERT INTO maintenance_tasks (id, task_type, mode, requested_by)
      VALUES (?, 'indicator_normalization', ?, ?)
    `).run(createdId, options?.full ? "full" : "incremental", user.id);
    db.prepare(`
      DELETE FROM maintenance_tasks
      WHERE task_type = 'indicator_normalization'
        AND status IN ('completed', 'failed')
        AND id NOT IN (
          SELECT id FROM maintenance_tasks
          WHERE task_type = 'indicator_normalization' AND status IN ('completed', 'failed')
          ORDER BY created_at DESC, id DESC
          LIMIT 50
        )
    `).run();
    db.exec("COMMIT");
  } catch (error) {
    rollbackAfterError(db);
    throw error;
  }
  const task = createdId ? taskById(createdId) : null;
  if (!task) throw new Error("指标归一化任务创建失败");
  kickIndicatorNormalizationTaskRunner();
  return { ...taskView(task), reused: false };
}

function claimNextTask() {
  const db = getDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    const row = db.prepare(`
      ${taskSelect("AND status = 'queued'")}
      ORDER BY created_at, id
      LIMIT 1
    `).get() as TaskRow | undefined;
    if (!row) {
      db.exec("COMMIT");
      return null;
    }
    const changed = db.prepare(`
      UPDATE maintenance_tasks
      SET status = 'running', attempts = attempts + 1,
        started_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP,
        finished_at = NULL, error_message = NULL
      WHERE id = ? AND status = 'queued'
    `).run(row.id);
    db.exec("COMMIT");
    return changed.changes ? taskById(row.id) || null : null;
  } catch (error) {
    rollbackAfterError(db);
    throw error;
  }
}

function taskUser(row: TaskRow): RequestUser {
  if (!row.requestedBy) throw new Error("任务发起用户不存在");
  const user = getDatabase().prepare(`
    SELECT id, display_name AS displayName, is_gateway_admin AS isAdmin
    FROM users WHERE id = ?
  `).get(row.requestedBy) as { id: string; displayName: string; isAdmin: number } | undefined;
  if (!user || !user.isAdmin) throw new Error("任务发起用户已不再具备管理员权限");
  return {
    id: user.id,
    displayName: user.displayName,
    provider: getAppConfig().authMode === "local" ? "local" : "fnos_gateway",
    authenticated: true,
    isAdmin: true,
    isGatewayAdmin: true
  };
}

async function executeTask(row: TaskRow) {
  try {
    const result = await normalizeAllObservationsFromDictionary(taskUser(row), {
      full: row.mode === "full",
      taskId: row.id,
      onProgress(progress) {
        getDatabase().prepare(`
          UPDATE maintenance_tasks
          SET total_units = ?, completed_units = ?, result_json = ?,
            updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND status = 'running'
        `).run(
          progress.totalReports,
          progress.processedReports,
          JSON.stringify(progress.result),
          row.id
        );
      }
    });
    getDatabase().prepare(`
      UPDATE maintenance_tasks
      SET status = 'completed', result_json = ?, completed_units = total_units,
        error_message = NULL, updated_at = CURRENT_TIMESTAMP,
        finished_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'running'
    `).run(JSON.stringify(result), row.id);
    await writeLog("info", "indicator normalization maintenance task completed", {
      taskId: row.id,
      mode: row.mode,
      result
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    getDatabase().prepare(`
      UPDATE maintenance_tasks
      SET status = 'failed', error_message = ?, updated_at = CURRENT_TIMESTAMP,
        finished_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'running'
    `).run(message.slice(0, 1000), row.id);
    await writeLog("error", "indicator normalization maintenance task failed", {
      taskId: row.id,
      mode: row.mode,
      error: message
    });
  }
}

async function drainTasks() {
  let processed = 0;
  while (true) {
    if (getAppConfig().storageError || storageMigrationPaused()) break;
    const task = claimNextTask();
    if (!task) break;
    await executeTask(task);
    processed += 1;
  }
  return processed;
}

export function runIndicatorNormalizationTasks() {
  if (runnerPromise) return runnerPromise;
  if (runnerKickTimer) clearTimeout(runnerKickTimer);
  runnerKickTimer = null;
  runnerPromise = drainTasks().finally(() => {
    runnerPromise = null;
  });
  return runnerPromise;
}

export function isStorageNormalizationActive() { return Boolean(runnerPromise); }

export function kickIndicatorNormalizationTaskRunner() {
  if (runnerPromise || runnerKickTimer) return;
  runnerKickTimer = setTimeout(() => {
    runnerKickTimer = null;
    void runIndicatorNormalizationTasks().catch((error) => {
      void writeLog("error", "indicator normalization task runner failed", {
        error: error instanceof Error ? error.message : String(error)
      });
    });
  }, 0);
  runnerKickTimer.unref?.();
}

export function startIndicatorNormalizationTaskRunner() {
  if (runnerStarted) return;
  runnerStarted = true;
  getDatabase().prepare(`
    UPDATE maintenance_tasks
    SET status = 'queued', error_message = '应用重启后继续执行',
      updated_at = CURRENT_TIMESTAMP
    WHERE task_type = 'indicator_normalization' AND status = 'running'
  `).run();
  kickIndicatorNormalizationTaskRunner();
  runnerInterval = setInterval(kickIndicatorNormalizationTaskRunner, 15_000);
  runnerInterval.unref?.();
}
