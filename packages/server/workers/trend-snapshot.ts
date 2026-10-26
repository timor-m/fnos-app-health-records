import { parentPort, workerData } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { attachTrendComputationDatabase, closeDatabase } from '../database/client';
import { computeTrendSeries } from '../services/records.service';
import { trendSeriesKey, type TrendSnapshotJob, type TrendSnapshotResult } from '../services/trend-snapshot-types';

const job = workerData as TrendSnapshotJob;
process.env.STORAGE_DIR = job.storageDir;
try {
  const db = attachTrendComputationDatabase(job.databasePath);
  db.exec('BEGIN');
  try {
    const state = db.prepare('SELECT desired_revision,active_revision FROM trend_snapshot_members WHERE member_id=?').get(job.memberId);
    if (Number(state?.desired_revision) !== job.revision) throw new Error('Superseded');
    const contributions = new Map<string, [string, string]>();
    const affected = new Set(job.previousKeys);
    const changed = new Set(job.changedReports);
    const series = computeTrendSeries({memberId: job.memberId, readOnly: true,
      changedReports: job.full ? undefined : changed, previousKeys: affected,
      contribution(reportId, key) {
        contributions.set(JSON.stringify([reportId, key]), [reportId, key]);
        if (job.full || changed.has(reportId)) affected.add(key);
      }
    });
    const result: TrendSnapshotResult = {revision: job.revision, affectedKeys: [...affected], order: [],
      contributions: [...contributions.values()], records: series.map(item => {
        const {points, excludedPoints, ...metadata} = item;
        const summary = JSON.stringify({...metadata, points: points.slice(-6), excludedPoints: [], excludedPointCount: excludedPoints.length});
        const chart = JSON.stringify(points);
        const detail = JSON.stringify({excludedPoints});
        const searchText = [item.name, ...item.searchAliases, ...item.sourceNames, item.sectionName || '']
          .map(value => value.normalize('NFKC').toLocaleLowerCase('zh-CN').replace(/\s+/g, '')).join('\n');
        return {key: trendSeriesKey(item.indicatorKey, item.unit),
          hash: createHash('sha256').update(summary).update(chart).update(detail).update(searchText).digest('hex'),
          indicatorKey: item.indicatorKey, unit: item.unit || '', name: item.name,
          searchText,
          groupKey: item.groupKey, groupName: item.groupName, pointCount: item.pointCount, subgroupKey: item.subgroupKey, subgroupName: item.subgroupName,
          groupOrder: item.groupOrder, subgroupOrder: item.subgroupOrder,
          itemOrder: item.itemOrder, attentionLevel: item.attentionLevel, attentionPriority: item.attentionPriority, attentionConflict: Number(item.attentionConflict),
          lastDate: item.lastDate, summary, chart, detail};
      })};
    const retained = job.full ? [] : (db.prepare(`SELECT s.series_key AS key,s.name,s.unit_key AS unit,
      s.group_order AS groupOrder,s.subgroup_order AS subgroupOrder,s.item_order AS itemOrder
      FROM trend_snapshot_entries e JOIN trend_snapshot_series s USING(member_id,series_key,content_hash)
      WHERE e.member_id=? AND e.revision=? ORDER BY e.sort_order`).all(job.memberId, Number(state!.active_revision)) as Array<{
        key:string;name:string;unit:string;groupOrder:number;subgroupOrder:number;itemOrder:number
      }>).filter(item => !affected.has(item.key));
    result.order = [...retained, ...result.records].sort((a,b) => a.groupOrder-b.groupOrder
      || a.subgroupOrder-b.subgroupOrder || a.itemOrder-b.itemOrder
      || a.name.localeCompare(b.name, 'zh-CN') || a.unit.localeCompare(b.unit, 'zh-CN') || a.key.localeCompare(b.key))
      .map(item => item.key);
    db.exec('COMMIT');
    parentPort!.postMessage({ok: true, result});
  } catch {
    if (db.isTransaction) db.exec('ROLLBACK');
    parentPort!.postMessage({ok: false, code: 'TREND_COMPUTATION_RETRY'});
  }
} catch {
  parentPort!.postMessage({ok: false, code: 'TREND_COMPUTATION_UNAVAILABLE'});
} finally {
  closeDatabase();
}
