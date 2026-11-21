import { createError } from 'h3';

export function enumInput<T extends string>(value: unknown, choices: readonly T[], label: string): T {
  if (typeof value !== 'string' || !choices.includes(value as T))
    throw createError({ statusCode: 400, statusMessage: `${label}无效` });
  return value as T;
}

export function textInput(value: unknown, label: string, maxLength: number, required = false): string | null {
  if (value === null || value === undefined || value === '') {
    if (required) throw createError({ statusCode: 400, statusMessage: `${label}不能为空` });
    return null;
  }
  if (typeof value !== 'string') throw createError({ statusCode: 400, statusMessage: `${label}无效` });
  const text = value.trim();
  if (!text && required) throw createError({ statusCode: 400, statusMessage: `${label}不能为空` });
  if (text.length > maxLength) throw createError({ statusCode: 400, statusMessage: `${label}不能超过 ${maxLength} 个字符` });
  return text || null;
}

export function dateInput(value: unknown, label: string): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})?)?$/.test(value))
    throw createError({ statusCode: 400, statusMessage: `${label}格式无效` });
  const parsed = Date.parse(value);
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const time = value.length > 10 ? value.slice(11, 19).split(':').map(Number) : [];
  if (!Number.isFinite(parsed) || year < 1 || month < 1 || month > 12 || day < 1 || day > days[month - 1]
    || time[0] > 23 || time[1] > 59 || (time.length > 2 && time[2] > 59))
    throw createError({ statusCode: 400, statusMessage: `${label}无效` });
  return value;
}

export function localToday(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function assertOccurredDate(value: string | null, label: string) {
  if (value && (value.length === 10 ? value > localToday() : Date.parse(value) > Date.now()))
    throw createError({ statusCode: 400, statusMessage: `${label}不能晚于当前时间；计划复查请使用提醒` });
}

export function assertDateOrder(startedAt: string | null, endedAt: string | null) {
  if (startedAt && endedAt && Date.parse(endedAt) < Date.parse(startedAt))
    throw createError({ statusCode: 400, statusMessage: '结束时间不能早于开始时间' });
}

export function orderInput(value: unknown): number {
  if (value === undefined || value === null) return 0;
  if (!Number.isInteger(value) || Number(value) < 0 || Number(value) > 100000)
    throw createError({ statusCode: 400, statusMessage: '排序值无效' });
  return Number(value);
}

export function hasInput(input: Record<string, unknown>, key: string) {
  return Object.prototype.hasOwnProperty.call(input, key);
}
