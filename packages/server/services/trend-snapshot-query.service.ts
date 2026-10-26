import { createHash } from 'node:crypto';
import { createError } from 'h3';
import { getDatabase } from '../database/client';
import { assertMemberAccess } from './member.service';
import type { RequestUser } from '../domain/request-user';
import { buildTrendGroupTree } from './trend-groups.service';
import { flattenTrendGroups, resolveTrendGroupKeys, type TrendGroupNode } from '../../shared/trend-groups';
import type { ComputedTrendSeries } from './trend-snapshot-types';

export type TrendSnapshotFilters = {
  query?: string;
  group?: string;
  section?: string;
  attention?: 'all'|'attention'|'unflagged'|'abnormal'|'near_boundary';
  pin?: 'all'|'only'|'exclude';
  cursor?: string;
  limit?: number;
  version?: number;
};
type MemberState = {desired: number;active: number;invalidated: number;error: string|null};
type Available = {indicatorKey: string;name: string;searchText: string};
const normalize = (value: string) => value.normalize('NFKC').toLocaleLowerCase('zh-CN').replace(/\s+/g, '');
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('base64url');
const source = `FROM trend_snapshot_entries e JOIN trend_snapshot_series s USING(member_id,series_key,content_hash)`;

function context(user: RequestUser, memberId: string, version?: number) {
  if (!user.authenticated) throw createError({statusCode:401,statusMessage:'请先登录'});
  if (!memberId) throw createError({statusCode:400,statusMessage:'请选择成员'});
  assertMemberAccess(user, memberId);
  const db = getDatabase();
  const state = db.prepare(`SELECT desired_revision AS desired,active_revision AS active,
    invalidated,error_code AS error FROM trend_snapshot_members WHERE member_id=?`).get(memberId) as MemberState | undefined;
  const available = Boolean(state?.active && !state.invalidated);
  if (version !== undefined && (!Number.isSafeInteger(version) || version < 1 || !available || version !== state!.active)) {
    throw createError({statusCode:409,statusMessage:'趋势数据已更新，请重新加载',data:{code:'TREND_VERSION_CHANGED'}});
  }
  return {db, state, available, revision: available ? state!.active : null,
    status: state?.error ? 'retrying' as const : !available ? 'building' as const
      : state!.desired > state!.active ? 'updating' as const : 'ready' as const};
}

export function queryTrendSnapshotSeries(user: RequestUser, memberId: string, filters: TrendSnapshotFilters = {}) {
  const {db,state,available,revision,status} = context(user, memberId, filters.version);
  const limit = filters.limit ?? 12;
  if ((filters.query !== undefined && typeof filters.query !== 'string')
    || (filters.group !== undefined && (typeof filters.group !== 'string' || filters.group.length > 180))
    || (filters.section !== undefined && (typeof filters.section !== 'string' || filters.section.length > 100))
    || (filters.cursor !== undefined && (typeof filters.cursor !== 'string' || filters.cursor.length > 4000))
    || !Number.isSafeInteger(limit) || limit < 1 || limit > 48 || (filters.query?.length || 0) > 200
    || !['all','only','exclude'].includes(filters.pin || 'all')
    || !['all','attention','unflagged','abnormal','near_boundary'].includes(filters.attention || 'all')
) {
    throw createError({statusCode:400,statusMessage:'趋势查询参数无效'});
  }
  if (!available) return {version:revision,status,groups:[],sections:[],items:[],total:0,pointCount:0,pinnedCount:0,nextCursor:null,hasMore:false,
    desiredRevision:state?.desired || 0};
  const availableIndicators = db.prepare(`SELECT s.indicator_key AS indicatorKey,s.name,s.search_text AS searchText
    ${source} WHERE e.member_id=? AND e.revision=? ORDER BY e.sort_order`).all(memberId, revision!) as Available[];
  const tree = buildTrendGroupTree(availableIndicators.map(item => ({...item,searchAliases:[item.searchText]})), user.id, db, false);
  const keyword = normalize(filters.query || '');
  const matchingGroupKeys = new Set(keyword ? flattenTrendGroups(tree).filter(group => normalize(group.name).includes(keyword)).flatMap(group => group.indicatorKeys) : []);
  const groupKeys = filters.group ? [...resolveTrendGroupKeys(tree, [filters.group])] : null;
  const pins = db.prepare('SELECT indicator_key,unit_key FROM user_trend_pins WHERE member_id=? AND user_id=? ORDER BY indicator_key,unit_key').all(memberId,user.id);
  const signature = digest({memberId,version:revision,keyword,groupKeys,attention:filters.attention || 'all',
    matchingGroupKeys:[...matchingGroupKeys],section:filters.section || '',pin:filters.pin || 'all',pins,userId:user.id});
  let offset = 0;
  if (filters.cursor) {
    let cursor: {version?:number;query?:string;offset?:number};
    try { cursor = JSON.parse(Buffer.from(filters.cursor, 'base64url').toString()); }
    catch { throw createError({statusCode:400,statusMessage:'趋势加载位置无效'}); }
    if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) throw createError({statusCode:400,statusMessage:'趋势加载位置无效'});
    if (cursor.version !== revision || cursor.query !== signature) throw createError({statusCode:409,statusMessage:'趋势查询已变化，请重新加载'});
    if (!Number.isSafeInteger(cursor.offset) || cursor.offset! < 0 || cursor.offset! > 1000000) throw createError({statusCode:400,statusMessage:'趋势加载位置无效'});
    offset = cursor.offset!;
  }
  const pinned = `EXISTS(SELECT 1 FROM user_trend_pins p WHERE p.member_id=e.member_id
    AND p.user_id=? AND p.indicator_key=s.indicator_key AND p.unit_key=s.unit_key)`;
  const where = ['e.member_id=?','e.revision=?'];
  const values: Array<string|number> = [memberId,revision!];
  if (keyword) {
    where.push('(instr(s.search_text,?)>0 OR s.indicator_key IN (SELECT value FROM json_each(?)))');
    values.push(keyword,JSON.stringify([...matchingGroupKeys]));
  }
  if (filters.attention === 'attention') where.push("s.attention_priority<>'normal'");
  else if (filters.attention === 'unflagged') where.push("s.attention_priority='normal'");
  else if (filters.attention && filters.attention !== 'all') { where.push('s.attention_level=?');values.push(filters.attention); }
  if (filters.pin && filters.pin !== 'all') {where.push(filters.pin === 'only' ? pinned : `NOT ${pinned}`);values.push(user.id);}
  // Facet counts apply search/status/attention; choosing one group does not hide
  // the counts of other groups or double-count overlapping memberships.
  const matches = db.prepare(`SELECT s.indicator_key AS indicatorKey,s.series_key AS key,s.attention_level AS attentionLevel
    ${source} WHERE ${where.join(' AND ')}`).all(...values) as Array<{indicatorKey:string;key:string;attentionLevel:string|null}>;
  const groupView = (group: TrendGroupNode): TrendGroupNode & {seriesCount:number;matchCount:number;matchSeriesCount:number;abnormalCount:number} => {
    const keys = new Set(group.indicatorKeys);
    const rows = matches.filter(item => keys.has(item.indicatorKey));
    return {...group,children:group.children.map(groupView),seriesCount:availableIndicators.filter(item => keys.has(item.indicatorKey)).length,
      matchCount:new Set(rows.map(item => item.indicatorKey)).size,matchSeriesCount:rows.length,
      abnormalCount:rows.filter(item => item.attentionLevel === 'abnormal').length};
  };
  const groups = tree.map(groupView);
  if (groupKeys) {where.push('s.indicator_key IN (SELECT value FROM json_each(?))');values.push(JSON.stringify(groupKeys));}
  const sectionRows = db.prepare(`SELECT s.group_key AS key,s.group_name AS name,s.group_order AS sortOrder,
    COUNT(*) AS count,SUM(s.point_count) AS pointCount,SUM(s.attention_level='abnormal') AS abnormalCount
    ${source} WHERE ${where.join(' AND ')} GROUP BY s.group_key,s.group_name,s.group_order
    ORDER BY s.group_order,s.group_key`).all(...values) as Array<{key:string;name:string;sortOrder:number;count:number;pointCount:number;abnormalCount:number|null}>;
  const subgroupRows = db.prepare(`SELECT s.group_key AS groupKey,
    COALESCE(s.subgroup_key,'laboratory_other') AS key,COALESCE(s.subgroup_name,'其他检验') AS name,
    s.subgroup_order AS sortOrder,COUNT(*) AS count ${source} WHERE ${where.join(' AND ')}
    GROUP BY s.group_key,s.subgroup_key,s.subgroup_name,s.subgroup_order ORDER BY s.subgroup_order`)
    .all(...values) as Array<{groupKey:string;key:string;name:string;sortOrder:number;count:number}>;
  const pinnedCount = Number(db.prepare(`SELECT COUNT(*) AS n ${source} WHERE ${where.join(' AND ')} AND ${pinned}`).get(...values,user.id)!.n);
  if (filters.section) {where.push('s.group_key=?');values.push(filters.section);}
  const total = Number(db.prepare(`SELECT COUNT(*) AS n ${source} WHERE ${where.join(' AND ')}`).get(...values)!.n);
  const pointCount = Number(db.prepare(`SELECT COALESCE(SUM(s.point_count),0) AS n ${source} WHERE ${where.join(' AND ')}`).get(...values)!.n);
  const sort = 'e.sort_order';
  const rank = groupKeys ? 'COALESCE((SELECT CAST(key AS INTEGER) FROM json_each(?) WHERE value=s.indicator_key),2147483647),' : '';
  const rows = db.prepare(`SELECT s.series_key AS key,s.summary_json AS summary,${pinned} AS pinned
    ${source} WHERE ${where.join(' AND ')} ORDER BY pinned DESC,${rank}${sort} LIMIT ? OFFSET ?`)
    .all(user.id,...values,...(groupKeys ? [JSON.stringify(groupKeys)] : []),limit,offset) as Array<{key:string;summary:string;pinned:number}>;
  const items = rows.map(row => ({...JSON.parse(row.summary) as ComputedTrendSeries,
    snapshotKey:row.key,pinned:Boolean(row.pinned),chartLoaded:false,detailLoaded:false}));
  const next = offset + rows.length;
  return {version:revision,status,groups,sections:sectionRows.map(row => ({...row,abnormalCount:Number(row.abnormalCount || 0),subgroups:subgroupRows.filter(group => group.groupKey===row.key)})),items,total,pointCount,pinnedCount,hasMore:next<total,
    nextCursor:next<total ? Buffer.from(JSON.stringify({version:revision,query:signature,offset:next})).toString('base64url') : null,
    desiredRevision:state!.desired};
}

export function getTrendSnapshotStatus(user: RequestUser, memberId: string) {
  const {revision,status,state} = context(user,memberId);
  return {version:revision,status,desiredRevision:state?.desired || 0};
}

export function getTrendSnapshotOverview(user: RequestUser, memberId: string, filters: TrendSnapshotFilters = {}) {
  const base = {...filters,limit:1,cursor:undefined,section:undefined};
  const overview = queryTrendSnapshotSeries(user,memberId,{...base,pin:'all'});
  if (!overview.version) return {...overview,pinned:null,firstSection:null,items:[]};
  const version = overview.version;
  const pinned = queryTrendSnapshotSeries(user,memberId,{...base,version,pin:'only',limit:12});
  const normal = queryTrendSnapshotSeries(user,memberId,{...base,version,pin:'exclude'});
  const first = normal.sections.find(section => section.count > 0);
  const firstSection = first ? {key:first.key,...queryTrendSnapshotSeries(user,memberId,
    {...base,version,section:first.key,pin:'exclude',limit:12})} : null;
  return {...overview,sections:normal.sections,items:[],pinned,firstSection};
}

export function readTrendSnapshotParts(user: RequestUser, memberId: string, version: number, keys: string[], part: 'chart'|'detail') {
  if (!Number.isSafeInteger(version) || version < 1) throw createError({statusCode:400,statusMessage:'缺少有效的趋势版本'});
  const {db,revision,status} = context(user,memberId,version);
  if (!Array.isArray(keys) || keys.length < 1 || keys.length > 12 || keys.some(key => typeof key !== 'string' || key.length > 800)) {
    throw createError({statusCode:400,statusMessage:'请选择需要读取的指标'});
  }
  const unique = [...new Set(keys)];
  const column = part === 'chart' ? 'chart_json' : 'detail_json';
  const rows = db.prepare(`SELECT s.series_key AS key,s.${column} AS data ${source}
    WHERE e.member_id=? AND e.revision=? AND e.series_key IN (SELECT value FROM json_each(?))`)
    .all(memberId,revision!,JSON.stringify(unique)) as Array<{key:string;data:string}>;
  if (rows.length !== unique.length) throw createError({statusCode:409,statusMessage:'部分趋势已变化，请重新加载'});
  return {version:revision,status,items:rows.map(row => ({key:row.key,data:JSON.parse(row.data)}))};
}


// Compatibility for callers that still need the complete legacy response.
// The page uses the split endpoints; even this path never computes source data.
export function readLegacyTrendSnapshot(user: RequestUser, memberId: string) {
  const {db,revision,available} = context(user,memberId);
  if (!available) throw createError({statusCode:503,statusMessage:'趋势数据正在整理，请稍后重试',data:{code:'TREND_SNAPSHOT_BUILDING'}});
  const rows = db.prepare(`SELECT s.summary_json AS summary,s.chart_json AS chart,s.detail_json AS detail,
    EXISTS(SELECT 1 FROM user_trend_pins p WHERE p.member_id=e.member_id
      AND p.user_id=? AND p.indicator_key=s.indicator_key AND p.unit_key=s.unit_key) AS pinned
    ${source} WHERE e.member_id=? AND e.revision=? ORDER BY pinned DESC,e.sort_order`)
    .all(user.id,memberId,revision!) as Array<{summary:string;chart:string;detail:string;pinned:number}>;
  const series = rows.map(row => {
    const {excludedPointCount, ...summary} = JSON.parse(row.summary);
    return {...summary,points:JSON.parse(row.chart),...JSON.parse(row.detail),pinned:Boolean(row.pinned)} as ComputedTrendSeries;
  });
  return {series,groups:buildTrendGroupTree(series,user.id,db,false)};
}
