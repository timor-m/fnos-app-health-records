import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalValueForScale,
  describeValueScale
} from "../services/value-scale.service.ts";

test("registered scale keys convert to canonical values, others pass through", () => {
  assert.equal(canonicalValueForScale("vision_uncorrected_right", 4.9), 0.8);
  assert.equal(canonicalValueForScale("vision_corrected_left", 5.0), 1.0);
  assert.equal(canonicalValueForScale("vision_uncorrected_left", 0.8), 0.8);
  assert.equal(canonicalValueForScale("body_weight", 4.9), 4.9);
  assert.equal(canonicalValueForScale(null, 4.9), 4.9);
});

test("describeValueScale exposes type and notations for the trend payload", () => {
  assert.deepEqual(describeValueScale("vision_uncorrected_right"), {
    type: "visual_acuity",
    notations: [
      { key: "decimal", label: "小数", title: "小数记录法" },
      { key: "five_point", label: "五分", title: "五分记录法" }
    ]
  });
  assert.equal(describeValueScale("body_weight"), null);
  assert.equal(describeValueScale(null), null);
});
