// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { compareMedicationDates, formatMedicationDate } from '../src/utils/medication-date';

it('orders timestamp facts by their instant instead of their written timezone', () => {
  const earlier = '2025-01-01T23:30:00+08:00';
  const later = '2025-01-01T16:00:00Z';
  expect(compareMedicationDates(earlier, later)).toBe(-1);
  expect(compareMedicationDates(later, earlier)).toBe(1);
  expect(compareMedicationDates(earlier, '2025-01-01T15:30:00Z')).toBe(0);
  expect(compareMedicationDates('2025-01-01T08:00:00-08:00', later)).toBe(0);
});

it('leaves unknown dates unknown and does not roll invalid calendar dates into another day', () => {
  expect([null, '2025-01-02', undefined, '2025-01-01', 'invalid'].sort((a, b) => compareMedicationDates(b, a)))
    .toEqual(['2025-01-02', '2025-01-01', null, 'invalid', undefined]);
  expect(compareMedicationDates(null, '')).toBe(0);
  expect(compareMedicationDates('2025-02-30', null)).toBe(0);
  expect(compareMedicationDates('2025-02-30T10:00:00Z', null)).toBe(0);
  expect(formatMedicationDate(null)).toBe('');
  expect(formatMedicationDate(undefined)).toBe('');
  expect(formatMedicationDate('invalid')).toBe('invalid');
  expect(formatMedicationDate('2025-01-01')).toBe('2025-01-01');
});

it.each([
  ['Asia/Shanghai', '2024-12-31T20:00:00Z', -1, '2025-01-02 00:00'],
  ['America/Los_Angeles', '2025-01-01T01:00:00Z', 1, '2025-01-01 08:00']
] as const)('uses local days and local timestamp display in %s', (timezone, timestamp, comparison, formatted) => {
  const moduleUrl = new URL('../src/utils/medication-date.ts', import.meta.url).href;
  const code = `import { compareMedicationDates, formatMedicationDate } from ${JSON.stringify(moduleUrl)};
    console.log(JSON.stringify({
      comparison: compareMedicationDates('2025-01-01', ${JSON.stringify(timestamp)}),
      day: formatMedicationDate('2025-01-01'),
      localTimestamp: formatMedicationDate('2025-01-01T08:15'),
      timestamp: formatMedicationDate('2025-01-01T16:00:00Z')
    }));`;
  const result = JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
    env: { ...process.env, TZ: timezone }, encoding: 'utf8'
  }));
  expect(result).toEqual({ comparison, day: '2025-01-01', localTimestamp: '2025-01-01 08:15', timestamp: formatted });
});
