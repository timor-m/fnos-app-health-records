import type { TrendSeries, TrendPoint } from "../types/api";

export function trendMeasurementTime(point: Pick<TrendPoint,'reportIssuedAt'|'examinationId'|'timePrecision'>) {
  if (!point.reportIssuedAt) return '日期待确认';
  const length = !point.examinationId || point.timePrecision === 'date' ? 10 : point.timePrecision === 'minute' ? 16 : 19;
  return point.reportIssuedAt.slice(0,length).replace('T',' ');
}

export function trendTimeSource(point: Pick<TrendPoint,'examinationId'|'timeKind'|'timeStatus'>) {
  if (!point.examinationId) return '沿用报告时间';
  const kind: Record<string,string> = {sampled:'采样时间',examined:'检查时间',issued:'签发时间',manual:'人工确认时间'};
  return `${kind[point.timeKind || ''] || '时间待确认'}${point.timeStatus === 'confirmed' ? ' · 已核对' : ''}`;
}

export function normalizedTrendSearch(value: string | null | undefined) {
  return (value || "").normalize("NFKC").toLocaleLowerCase("zh-CN").replace(/\s+/g, "");
}

export function matchTrendSearch(item: Pick<TrendSeries, "name" | "searchAliases">, query: string) {
  const keyword = normalizedTrendSearch(query);
  if (!keyword) return { matches: true, alias: null as string | null };
  if (normalizedTrendSearch(item.name).includes(keyword)) return { matches: true, alias: null as string | null };
  const alias = item.searchAliases.find((value) => normalizedTrendSearch(value).includes(keyword)) || null;
  return { matches: Boolean(alias), alias };
}
