import { createError } from 'h3';
import type { TrendSnapshotFilters } from '../services/trend-snapshot-query.service';

export function snapshotQuery(query: Record<string, unknown>) {
  const fail = (): never => {throw createError({statusCode:400,statusMessage:'趋势查询参数无效'});};
  const text = (key: string, max: number) => {
    const value = query[key];
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || value.length > max) return fail();
    return value;
  };
  const number = (key: string) => {
    const value = query[key];
    if (value === undefined) return undefined;
    if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+$/.test(value))) return fail();
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 1) return fail();
    return parsed;
  };
  const memberId = text('memberId', 80);
  if (!memberId) return fail();
  const attention = text('attention', 40);
  const pin = text('pin', 20);
  if (attention && !['all','attention','unflagged','abnormal','near_boundary'].includes(attention)) return fail();
  if (pin && !['all','only','exclude'].includes(pin)) return fail();
  return {memberId,filters: {
    query:text('query',200),group:text('group',180),section:text('section',100),cursor:text('cursor',4000),
    limit:number('limit'),version:number('version'),
    attention:attention as TrendSnapshotFilters['attention'],pin:pin as TrendSnapshotFilters['pin']
  } satisfies TrendSnapshotFilters};
}
