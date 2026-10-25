import type { HealthFeedEntry } from '../../../shared/health-categories';
import { compareMedicationDates, formatMedicationDate } from './medication-date';

export function timelineDateParts(value: string | null | undefined) {
  if (compareMedicationDates(value, null) === 0) return null;
  const formatted = formatMedicationDate(value);
  const match = /^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}:\d{2}))?$/.exec(formatted);
  if (!match) return null;
  return {
    year: match[1], month: match[2], day: `${match[2]}-${match[3]}`,
    time: match[4] || '', full: formatted, monthKey: `${match[1]}-${match[2]}`
  };
}

/** Entries are already sorted; grouping must not reorder them or use upload dates. */
export function groupHealthTimeline<T extends Pick<HealthFeedEntry, 'date'>>(entries: T[]) {
  const groups = new Map<string, { key: string; label: string; entries: T[] }>();
  for (const entry of entries) {
    const date = timelineDateParts(entry.date);
    const key = date?.monthKey || 'unknown';
    let group = groups.get(key);
    if (!group) {
      group = { key, label: date ? `${date.year} 年 ${Number(date.month)} 月` : '日期待确认', entries: [] };
      groups.set(key, group);
    }
    group.entries.push(entry);
  }
  return [...groups.values()];
}
