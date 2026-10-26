import { Worker } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { getDatabase, getDatabasePath, runInTransaction, onDatabaseClosing } from '../database/client';
import { getAppConfig } from '../utils/runtime-config';
import { storageMigrationPaused } from '../utils/storage-migration-state';
import { isStorageNormalizationActive } from './indicator-normalization-task.service';
import { isStorageMaintenanceActive } from './maintenance-runner.service';
import { trendSnapshotAlgorithmVersion, type TrendSnapshotJob, type TrendSnapshotResult } from './trend-snapshot-types';
import { syncBuiltinTrendGroups } from './trend-groups.service';

type State = {memberId: string; desired: number; active: number; full: number; lease: string | null; attempts: number};
const workers = new Set<Worker>();

export function claimTrendSnapshotJob(db = getDatabase()): TrendSnapshotJob | null {
  return runInTransaction(db, () => {
    const row = db.prepare(`SELECT member_id AS memberId, desired_revision AS desired,
      active_revision AS active, full_rebuild AS full, lease_token AS lease, attempts
      FROM trend_snapshot_members WHERE desired_revision > active_revision AND lease_token IS NULL
      AND EXISTS(SELECT 1 FROM health_members m WHERE m.id=trend_snapshot_members.member_id AND m.deleted_at IS NULL)
      AND retry_at <= ? ORDER BY invalidated DESC, updated_at, member_id LIMIT 1`).get(Date.now()) as State | undefined;
    if (!row) return null;
    const token = randomUUID();
    db.prepare('UPDATE trend_snapshot_members SET lease_token=? WHERE member_id=?').run(token, row.memberId);
    const changedReports = (db.prepare('SELECT report_id AS id FROM trend_snapshot_dirty_reports WHERE member_id=? AND revision<=?')
      .all(row.memberId, row.desired) as Array<{id: string}>).map(item => item.id);
    const full = Boolean(row.full || !row.active || !changedReports.length);
    const previousKeys = full ? [] : (db.prepare(`SELECT DISTINCT series_key AS key FROM trend_snapshot_contributions
      WHERE member_id=? AND report_id IN (SELECT value FROM json_each(?))`).all(row.memberId, JSON.stringify(changedReports)) as Array<{key: string}>).map(item => item.key);
    return {memberId: row.memberId, revision: row.desired, token, full, changedReports, previousKeys,
      databasePath: getDatabasePath(), storageDir: getAppConfig().storageDir};
  });
}

export function publishTrendSnapshot(job: TrendSnapshotJob, result: TrendSnapshotResult, db = getDatabase()) {
  return runInTransaction(db, () => {
    const state = db.prepare(`SELECT desired_revision AS desired, active_revision AS active, lease_token AS lease
      FROM trend_snapshot_members WHERE member_id=?`).get(job.memberId) as State | undefined;
    if (!state || state.lease !== job.token) return false;
    if (state.desired !== job.revision || result.revision !== job.revision) {
      db.prepare('UPDATE trend_snapshot_members SET lease_token=NULL WHERE member_id=?').run(job.memberId);
      return false;
    }
    if (!job.full) {
      db.prepare(`INSERT INTO trend_snapshot_entries(member_id,revision,series_key,content_hash)
        SELECT member_id,?,series_key,content_hash FROM trend_snapshot_entries
        WHERE member_id=? AND revision=? AND series_key NOT IN (SELECT value FROM json_each(?))`)
        .run(job.revision, job.memberId, state.active, JSON.stringify(result.affectedKeys));
    }
    const insert = db.prepare(`INSERT INTO trend_snapshot_series(
      member_id,series_key,content_hash,indicator_key,unit_key,name,search_text,group_key,group_name,point_count,subgroup_key,subgroup_name,
      group_order,subgroup_order,item_order,attention_level,attention_priority,attention_conflict,last_date,summary_json,chart_json,detail_json)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(member_id,series_key,content_hash) DO NOTHING`);
    const entry = db.prepare('INSERT INTO trend_snapshot_entries(member_id,revision,series_key,content_hash) VALUES(?,?,?,?)');
    for (const item of result.records) {
      insert.run(job.memberId, item.key, item.hash, item.indicatorKey, item.unit, item.name, item.searchText,
        item.groupKey, item.groupName, item.pointCount, item.subgroupKey, item.subgroupName, item.groupOrder, item.subgroupOrder, item.itemOrder, item.attentionLevel,
        item.attentionPriority, item.attentionConflict, item.lastDate, item.summary, item.chart, item.detail);
      entry.run(job.memberId, job.revision, item.key, item.hash);
    }
    const position = db.prepare('UPDATE trend_snapshot_entries SET sort_order=? WHERE member_id=? AND revision=? AND series_key=?');
    result.order.forEach((key, index) => position.run(index, job.memberId, job.revision, key));
    if (job.full) db.prepare('DELETE FROM trend_snapshot_contributions WHERE member_id=?').run(job.memberId);
    else db.prepare(`DELETE FROM trend_snapshot_contributions WHERE member_id=? AND report_id IN
      (SELECT value FROM json_each(?))`).run(job.memberId, JSON.stringify(job.changedReports));
    const changed = new Set(job.changedReports);
    const contribution = db.prepare('INSERT OR IGNORE INTO trend_snapshot_contributions(member_id,report_id,series_key) VALUES(?,?,?)');
    for (const [reportId, key] of result.contributions) {
      if (job.full || changed.has(reportId)) contribution.run(job.memberId, reportId, key);
    }
    db.prepare(`UPDATE trend_snapshot_members SET active_revision=?, invalidated=0, full_rebuild=0,
      algorithm_version=?,lease_token=NULL,attempts=0,retry_at=0,error_code=NULL,updated_at=CURRENT_TIMESTAMP
      WHERE member_id=?`).run(job.revision, trendSnapshotAlgorithmVersion, job.memberId);
    db.prepare('DELETE FROM trend_snapshot_dirty_reports WHERE member_id=? AND revision<=?').run(job.memberId, job.revision);
    db.prepare('DELETE FROM trend_snapshot_entries WHERE member_id=? AND revision<>?').run(job.memberId, job.revision);
    db.prepare(`DELETE FROM trend_snapshot_series WHERE member_id=? AND NOT EXISTS
      (SELECT 1 FROM trend_snapshot_entries e WHERE e.member_id=trend_snapshot_series.member_id
      AND e.series_key=trend_snapshot_series.series_key AND e.content_hash=trend_snapshot_series.content_hash)`).run(job.memberId);
    return true;
  });
}

export function failTrendSnapshot(job: TrendSnapshotJob, db = getDatabase()) {
  db.prepare(`UPDATE trend_snapshot_members SET lease_token=NULL, attempts=attempts+1,
    retry_at=? + MIN(30000, 500 * (1 << MIN(attempts,6))), error_code='TREND_COMPUTATION_RETRY'
    WHERE member_id=? AND lease_token=?`).run(Date.now(), job.memberId, job.token);
}

/** Ownership changes discard derived data; business records are moved separately. */
export function discardMemberTrendSnapshots(memberIds: string[], db = getDatabase()) {
  for (const id of new Set(memberIds)) {
    for (const table of ['trend_snapshot_entries', 'trend_snapshot_series', 'trend_snapshot_contributions', 'trend_snapshot_dirty_reports']) {
      db.prepare(`DELETE FROM ${table} WHERE member_id=?`).run(id);
    }
    db.prepare(`UPDATE trend_snapshot_members SET desired_revision=desired_revision+1,
      active_revision=0,invalidated=1,full_rebuild=1,lease_token=NULL,attempts=0,retry_at=0,error_code=NULL
      WHERE member_id=?`).run(id);
  }
}

export function computeTrendSnapshotInWorker(job: TrendSnapshotJob, timeoutMs = 180000): Promise<TrendSnapshotResult> {
  const application = process.env.TRIM_APPDEST || process.cwd();
  const candidates = [join(application, 'server/server/trend-snapshot-worker.mjs'),
    resolve('.server-dist/server/trend-snapshot-worker.mjs')];
  const packaged = candidates.find(path => existsSync(path));
  const source = resolve('packages/server/workers/trend-snapshot.ts');
  let worker: Worker;
  if (process.env.NODE_ENV === 'production' || !existsSync(source)) {
    if (!packaged) return Promise.reject(new Error('TREND_WORKER_UNAVAILABLE'));
    worker = new Worker(packaged, {workerData: job});
  } else {
    // tsx is development-only; the production worker is bundled with the app.
    const bootstrap = `import('tsx/esm/api').then(({tsImport})=>tsImport(${JSON.stringify(pathToFileURL(source).href)},${JSON.stringify(pathToFileURL(resolve('package.json')).href)}));`;
    worker = new Worker(bootstrap, {eval: true, workerData: job});
  }
  workers.add(worker);
  return new Promise((resolveResult, reject) => {
    const timer = setTimeout(() => { void worker.terminate(); reject(new Error('TREND_WORKER_TIMEOUT')); }, timeoutMs);
    timer.unref();
    const finish = () => { clearTimeout(timer); workers.delete(worker); void worker.terminate(); };
    worker.once('message', message => {
      finish();
      if (message?.ok) resolveResult(message.result as TrendSnapshotResult);
      else reject(new Error('TREND_WORKER_FAILED'));
    });
    worker.once('error', () => { finish(); reject(new Error('TREND_WORKER_FAILED')); });
    worker.once('exit', () => { clearTimeout(timer); workers.delete(worker); reject(new Error('TREND_WORKER_EXIT')); });
  });
}

let initialized: DatabaseSync | null = null;
let running = false;
let timer: ReturnType<typeof setInterval> | null = null;
onDatabaseClosing(() => {
  initialized = null;
  for (const worker of workers) void worker.terminate();
  workers.clear();
});

export async function runTrendSnapshotTasksOnce() {
  if (running || storageMigrationPaused() || isStorageNormalizationActive() || isStorageMaintenanceActive() || getAppConfig().storageError) return;
  running = true;
  try {
    const db = getDatabase();
    if (initialized !== db) {
      db.prepare(`UPDATE trend_snapshot_members SET lease_token=NULL,
        desired_revision=CASE WHEN algorithm_version<>? AND desired_revision<=active_revision THEN active_revision+1 ELSE desired_revision END,
        full_rebuild=CASE WHEN algorithm_version<>? THEN 1 ELSE full_rebuild END, retry_at=0`)
        .run(trendSnapshotAlgorithmVersion, trendSnapshotAlgorithmVersion);
      initialized = db;
    }
    if (!db.prepare(`SELECT 1 FROM trend_snapshot_members WHERE desired_revision>active_revision
      AND lease_token IS NULL AND retry_at<=? LIMIT 1`).get(Date.now())) return;
    syncBuiltinTrendGroups(db);
    const job = claimTrendSnapshotJob(db);
    if (!job) return;
    try {
      const result = await computeTrendSnapshotInWorker(job);
      if (initialized === db && getDatabase() === db && !storageMigrationPaused()) publishTrendSnapshot(job, result, db);
    } catch {
      if (initialized === db && getDatabase() === db && !storageMigrationPaused()) failTrendSnapshot(job, db);
    }
  } finally { running = false; }
}

export function startTrendSnapshotRunner() {
  if (timer) return;
  timer = setInterval(() => { void runTrendSnapshotTasksOnce().catch(() => {}); }, 500);
  timer.unref();
}

export function stopTrendSnapshotRunner() {
  if (timer) clearInterval(timer);
  timer = null;
  initialized = null;
  for (const worker of workers) void worker.terminate();
  workers.clear();
}
