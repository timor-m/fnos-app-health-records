import { createError } from 'h3';

export function trendFilterKeys(query: Record<string, unknown>, name: 'groupKeys' | 'indicatorKeys') {
  const raw = query[`${name}[]`] ?? query[name];
  if (raw === undefined) return [];
  const values = Array.isArray(raw) ? raw : [raw];
  if (values.length > 200 || values.some(v => typeof v !== 'string' || !v.trim() || v.length > 256)) {
    throw createError({ statusCode: 400, statusMessage: '分组筛选参数无效' });
  }
  return [...new Set(values as string[])];
}
