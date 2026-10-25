type MedicationDate = string | null | undefined;

function localDate(date: Date) {
  return `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function parseMedicationDate(value: MedicationDate): Date | null {
  if (!value) return null;
  // Clinical dates have no timezone. Treat their day boundary as local, unlike Date.parse(YYYY-MM-DD).
  const day = /^\d{4}-\d{2}-\d{2}(?:$|[T ])/.test(value) ? value.slice(0, 10) : null;
  if (day) {
    const localDay = new Date(`${day}T00:00:00`);
    if (!Number.isFinite(localDay.getTime()) || localDate(localDay) !== day) return null;
  }
  const date = new Date(day === value ? `${value}T00:00:00` : value);
  return Number.isFinite(date.getTime()) ? date : null;
}

/** Ascending order; missing or invalid dates sort before known dates without inventing a date. */
export function compareMedicationDates(a: MedicationDate, b: MedicationDate): number {
  const first = parseMedicationDate(a)?.getTime();
  const second = parseMedicationDate(b)?.getTime();
  if (first === undefined) return second === undefined ? 0 : -1;
  if (second === undefined) return 1;
  return first === second ? 0 : first < second ? -1 : 1;
}

/** Keep date-only facts as written; render timestamp facts in the viewer's local timezone. */
export function formatMedicationDate(value: MedicationDate): string {
  if (!value || /^\d{4}-\d{2}-\d{2}$/.test(value)) return value || '';
  const date = parseMedicationDate(value);
  if (!date) return value;
  return `${localDate(date)} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}
