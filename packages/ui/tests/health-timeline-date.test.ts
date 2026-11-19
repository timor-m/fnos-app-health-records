// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { groupHealthTimeline, timelineDateParts } from '../src/utils/health-timeline';
import { feedEntry } from './fixtures/health-feed';

it('keeps missing and invalid dates in the unknown group without substituting today', () => {
  for (const value of [null, undefined, '', 'invalid', '2026-02-30']) {
    expect(timelineDateParts(value)).toBeNull();
  }
  const entry = {...feedEntry('report','report'),date:null};
  expect(groupHealthTimeline([entry])).toEqual([{ key: 'unknown', label: '日期待确认', entries: [entry] }]);
});

it.each([
  ['Asia/Shanghai', '2027-01', '01-01', '00:30'],
  ['America/Los_Angeles', '2026-12', '12-31', '08:30']
] as const)('groups and displays timestamp facts in the same local month in %s', (timezone, month, day, time) => {
  const moduleUrl = new URL('../src/utils/health-timeline.ts', import.meta.url).href;
  const code = `import { groupHealthTimeline, timelineDateParts } from ${JSON.stringify(moduleUrl)};
    const date = '2026-12-31T16:30:00Z';
    const entry = {kind:'medication_document', date};
    console.log(JSON.stringify({group:groupHealthTimeline([entry])[0].key, timestamp:timelineDateParts(date), day:timelineDateParts('2026-12-31')}));`;
  const result = JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
    env: { ...process.env, TZ: timezone }, encoding: 'utf8'
  }));
  expect(result.group).toBe(month);
  expect(result.timestamp).toMatchObject({ monthKey: month, day, time });
  expect(result.day).toMatchObject({ monthKey: '2026-12', day: '12-31', time: '' });
});

it.each([
  ['2026-09-20', '09-20', ''],
  ['2026-09-20T20:09', '09-20', '20:09'],
  ['2026-01-02T03:04', '01-02', '03:04'],
  ['2026-09-20T20:09:58', '09-20', '20:09']
])('formats %s as a two-digit month-day and 24-hour time', (input, day, time) => {
  expect(timelineDateParts(input)).toMatchObject({ day, time });
});
