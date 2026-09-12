import assert from "node:assert/strict";
import test from "node:test";
import {
  detectVisualAcuityScale,
  isVisualAcuityCanonicalKey,
  visualAcuityToDecimal,
  visualAcuityToFivePoint
} from "../services/visual-acuity.service.ts";

test("visual acuity canonical keys cover uncorrected and corrected vision only", () => {
  assert.equal(isVisualAcuityCanonicalKey("vision_uncorrected_right"), true);
  assert.equal(isVisualAcuityCanonicalKey("vision_uncorrected_left"), true);
  assert.equal(isVisualAcuityCanonicalKey("vision_corrected_right"), true);
  assert.equal(isVisualAcuityCanonicalKey("vision_corrected_left"), true);
  assert.equal(isVisualAcuityCanonicalKey("body_weight"), false);
  assert.equal(isVisualAcuityCanonicalKey(null), false);
  assert.equal(isVisualAcuityCanonicalKey(undefined), false);
});

test("decimal and five-point ranges do not overlap and are detected by value", () => {
  assert.equal(detectVisualAcuityScale(0.1), "decimal");
  assert.equal(detectVisualAcuityScale(0.8), "decimal");
  assert.equal(detectVisualAcuityScale(1.0), "decimal");
  assert.equal(detectVisualAcuityScale(2.0), "decimal");
  assert.equal(detectVisualAcuityScale(4.0), "five_point");
  assert.equal(detectVisualAcuityScale(4.9), "five_point");
  assert.equal(detectVisualAcuityScale(5.3), "five_point");
});

test("five-point values convert to standard decimal chart steps", () => {
  const expected = new Map([
    [4.0, 0.1], [4.1, 0.12], [4.2, 0.15], [4.3, 0.2], [4.4, 0.25], [4.5, 0.3],
    [4.6, 0.4], [4.7, 0.5], [4.8, 0.6], [4.9, 0.8], [5.0, 1.0], [5.1, 1.2],
    [5.2, 1.5], [5.3, 2.0]
  ]);
  for (const [fivePoint, decimal] of expected) {
    assert.equal(visualAcuityToDecimal(fivePoint), decimal);
    // 官方档位换算回五分记录保持一位小数一致
    assert.equal(visualAcuityToFivePoint(decimal), fivePoint);
  }
});

test("decimal values pass through and non-standard five-point values fall back to log formula", () => {
  assert.equal(visualAcuityToDecimal(0.8), 0.8);
  assert.equal(visualAcuityToDecimal(1.5), 1.5);
  // 低视力扩展档（< 4.0）与表外数值按 L = 5 + log10(d) 换算
  assert.equal(visualAcuityToDecimal(3.7), 0.05);
  assert.equal(visualAcuityToDecimal(5.4), 2.512);
});
