import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { originalOrientationLayout } from '../../ui/src/utils/original-orientation.ts';

test('original orientation fits portrait and landscape pages without clipping rotated bounds', () => {
  for (const [iw, ih] of [[1200, 800], [800, 1200], [900, 900]]) {
    for (const width of [280, 420, 900]) {
      const normal = originalOrientationLayout(width, iw, ih, false)!;
      assert.equal(normal.width, width);
      assert.equal(normal.stageHeight, width * ih / iw);
      const rotated = originalOrientationLayout(width, iw, ih, true)!;
      assert.ok(Math.abs(rotated.height * rotated.scale - width) < 0.001);
      assert.equal(rotated.stageHeight, rotated.width * rotated.scale);
      assert.deepEqual(originalOrientationLayout(width, iw, ih, false), normal);
    }
  }
  assert.equal(originalOrientationLayout(0, 1200, 800, true), null);
  assert.equal(originalOrientationLayout(400, 0, 0, true), null);
});

test('all original comparison views rotate image and OCR together without persisting page changes', () => {
  const source = readFileSync('packages/ui/src/components/ReportDetail.vue', 'utf8');
  const component = readFileSync('packages/ui/src/components/OriginalOrientation.vue', 'utf8');
  assert.equal((source.match(/<OriginalOrientation\b/g) || []).length, 3);
  for (const region of source.matchAll(/<OriginalOrientation\b[\s\S]*?<\/OriginalOrientation>/g)) {
    assert.match(region[0], /<img\b/);
    assert.match(region[0], /<OcrTextOverlay\b/);
  }
  assert.match(component, /watch\(\(\) => props.pageKey, \(\) => \{ rotated.value = false;/);
  assert.match(component, /@click.stop="rotated = !rotated"/);
  assert.match(component, /RectangleVertical/);
  assert.match(component, /RectangleHorizontal/);
  assert.doesNotMatch(component, /request\(|fetch\(|rotateSavedPage/);
});
