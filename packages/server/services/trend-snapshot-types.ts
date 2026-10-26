import type { computeTrendSeries } from './records.service';

export const trendSnapshotAlgorithmVersion = 'trend-analysis-1';
export type ComputedTrendSeries = ReturnType<typeof computeTrendSeries>[number];
export type TrendSnapshotJob = {
  memberId: string;
  revision: number;
  token: string;
  databasePath: string;
  storageDir: string;
  full: boolean;
  changedReports: string[];
  previousKeys: string[];
};
export type TrendSnapshotRecord = {
  key: string;
  hash: string;
  indicatorKey: string;
  unit: string;
  name: string;
  searchText: string;
  groupKey: string;
  groupName: string;
  pointCount: number;
  subgroupKey: string | null;
  subgroupName: string | null;
  groupOrder: number;
  subgroupOrder: number;
  itemOrder: number;
  attentionLevel: string | null;
  attentionPriority: string;
  attentionConflict: number;
  lastDate: string | null;
  summary: string;
  chart: string;
  detail: string;
};
export type TrendSnapshotResult = {
  revision: number;
  records: TrendSnapshotRecord[];
  contributions: Array<[string, string]>;
  affectedKeys: string[];
  order: string[];
};
export const trendSeriesKey = (indicatorKey: string, unit: string | null) => JSON.stringify([indicatorKey, unit || '']);
