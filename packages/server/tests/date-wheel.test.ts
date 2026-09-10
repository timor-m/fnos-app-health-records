import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { dateWheelStep, dateWheelIndex, clampCalendarDay } from '../../ui/src/utils/date-wheel';

test('mouse wheel notches and large deltas advance at most one item', () => {
  for (const [delta, mode] of [[120, 0], [900, 0], [3, 1], [1, 2]]) {
    assert.deepEqual(dateWheelStep(0, delta, mode), { remainder: 0, step: 1 });
    assert.deepEqual(dateWheelStep(0, -delta, mode), { remainder: 0, step: -1 });
  }
});

test('trackpad deltas accumulate and reversal drops the previous direction', () => {
  let remainder = 0;
  for (let i = 0; i < 3; i++) {
    const result = dateWheelStep(remainder, 10, 0);
    assert.equal(result.step, 0);
    remainder = result.remainder;
  }
  assert.deepEqual(dateWheelStep(remainder, 10, 0), { remainder: 0, step: 1 });
  assert.deepEqual(dateWheelStep(remainder, -10, 0), { remainder: -10, step: 0 });
  assert.equal(dateWheelStep(0, Number.NaN, 0).step, 0);
  assert.equal(dateWheelStep(0, 0, 0).step, 0);
});

test('buffered columns wrap safely in both directions, including long gestures', () => {
  assert.equal(dateWheelIndex(-1, 12), 11);
  assert.equal(dateWheelIndex(12, 12), 0);
  assert.equal(dateWheelIndex(-25, 12), 11);
  assert.equal(dateWheelIndex(61, 60), 1);
});

test('month and year changes preserve valid days and clamp leap dates', () => {
  assert.equal(clampCalendarDay(2024, 2, 31), 29);
  assert.equal(clampCalendarDay(2025, 2, 29), 28);
  assert.equal(clampCalendarDay(2025, 4, 31), 30);
  assert.equal(clampCalendarDay(2025, 2, 15), 15);
});

test('picker has one snap owner and cleans pending work on close', () => {
  const source = readFileSync('packages/ui/src/components/DateTimePicker.vue', 'utf8');
  const css = readFileSync('packages/ui/src/components/DateTimePicker.css', 'utf8');
  assert.doesNotMatch(css, /scroll-snap-type|scroll-snap-align/);
  assert.doesNotMatch(source, /behavior: ['"]smooth/);
  assert.equal((source.match(/@wheel="onWheel/g) || []).length, 5);
  assert.match(source, /watch\(open, \(value\) => \{\s*clearWheelState\(\)/);
  assert.match(source, /onBeforeUnmount\(\(\) => \{\s*clearWheelState\(\)/);
  assert.match(source, /function confirm\(\) \{\s*syncCalendarDays\(\)/);
  assert.match(source, /if \(days.value.length !== previousLength\)/);
  assert.match(source, /!touching.has\(type\) && drag\?\.type !== type/);
});

test('all five columns capture mouse dragging without replacing touch momentum', () => {
  const source = readFileSync('packages/ui/src/components/DateTimePicker.vue', 'utf8');
  assert.equal((source.match(/@pointerdown="startDrag/g) || []).length, 5);
  assert.equal((source.match(/@lostpointercapture="endDrag"/g) || []).length, 5);
  assert.match(source, /event.pointerType === "touch" \|\| event.button !== 0/);
  assert.match(source, /element.setPointerCapture\(event.pointerId\)/);
  assert.match(source, /element.scrollTop = startTop \+ startY - event.clientY/);
  assert.match(source, /function clearWheelState\(\) \{\s*releaseDrag\(\)/);
  assert.match(source, /if \(current && open.value\) snapToNearest\(current.type\)/);
});
