export const DATE_WHEEL_ITEM_HEIGHT = 40;

// Mouse notches move one item; small trackpad deltas accumulate instead of
// turning every high-frequency event into a date change.
export function dateWheelStep(previous: number, deltaY: number, deltaMode: number) {
  const delta = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 40 : deltaY;
  if (!Number.isFinite(delta) || delta === 0) return { remainder: previous, step: 0 };
  const total = (Math.sign(previous) === Math.sign(delta) ? previous : 0) + delta;
  if (Math.abs(total) < DATE_WHEEL_ITEM_HEIGHT) return { remainder: total, step: 0 };
  return { remainder: 0, step: Math.sign(total) };
}

export function dateWheelIndex(index: number, length: number) {
  return ((index % length) + length) % length;
}

export function clampCalendarDay(year: number, month: number, day: number) {
  return Math.min(day, new Date(year, month, 0).getDate());
}
