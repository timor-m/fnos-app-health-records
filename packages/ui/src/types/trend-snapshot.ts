import type { TrendSeries } from './api';
import type { TrendGroupNode } from '../../../shared/trend-groups';

export type TrendSnapshotItem = TrendSeries & {
  snapshotKey: string;
  excludedPointCount: number;
  chartLoaded: boolean;
  detailLoaded: boolean;
};
export type TrendSnapshotSection = {
  key: string; name: string; sortOrder: number; count: number; pointCount: number; abnormalCount: number;
  subgroups: Array<{key:string;name:string;sortOrder:number;count:number}>;
};
export type TrendSnapshotStatus = 'building'|'ready'|'updating'|'retrying';
export type TrendSnapshotPage = {
  version: number|null; status: TrendSnapshotStatus; desiredRevision:number;
  groups: TrendGroupNode[]; sections: TrendSnapshotSection[];
  items: TrendSnapshotItem[]; total:number; pointCount:number; pinnedCount:number;
  hasMore:boolean; nextCursor:string|null;
};
export type TrendSnapshotOverview = TrendSnapshotPage & {
  pinned: TrendSnapshotPage|null;
  firstSection: (TrendSnapshotPage & {key:string})|null;
};
export type TrendSectionPage = {
  keys:string[]; cursor:string|null; started:boolean; loading:boolean; error:string;
};
