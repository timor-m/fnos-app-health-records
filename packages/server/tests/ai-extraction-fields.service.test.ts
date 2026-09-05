import assert from "node:assert/strict";
import test from "node:test";
import { normalizeAiExtraction } from "../services/ai-extraction.service.ts";

test("summary strips bare section headers that have no content", () => {
  const { fields } = normalizeAiExtraction({
    summary: [
      "本次体检的异常结果汇总及建议",
      "【一般检查】",
      "体重指数BMI值偏高(24.8)，超重。",
      "【血脂、脂蛋白、载脂蛋白测定】",
      "总胆固醇值偏高(6.04mmol/L)。",
      "【肝胆功能】",
      "【胰脏功能】",
      "【肾脏功能】",
    ].join("\n"),
  });
  assert.equal(
    fields.summary,
    [
      "本次体检的异常结果汇总及建议",
      "【一般检查】",
      "体重指数BMI值偏高(24.8)，超重。",
      "【血脂、脂蛋白、载脂蛋白测定】",
      "总胆固醇值偏高(6.04mmol/L)。",
    ].join("\n"),
  );
});

test("summary keeps headers with inline or following content", () => {
  const { fields } = normalizeAiExtraction({
    summary: [
      "【肝胆功能】未见明显异常",
      "【胰脏功能】",
      "淀粉酶值偏高(113.00U/L)。",
    ].join("\n"),
  });
  assert.equal(
    fields.summary,
    ["【肝胆功能】未见明显异常", "【胰脏功能】", "淀粉酶值偏高(113.00U/L)。"].join(
      "\n",
    ),
  );
});

test("summary drops empty headers separated by blank lines and collapses gaps", () => {
  const { fields } = normalizeAiExtraction({
    summary: "总胆固醇值偏高。\n\n【肾脏功能】\n\n\n【超声检查】\n脂肪肝（轻度）。",
  });
  assert.equal(
    fields.summary,
    "总胆固醇值偏高。\n\n【超声检查】\n脂肪肝（轻度）。",
  );
});

test("summary becomes null when only an empty skeleton remains", () => {
  const { fields } = normalizeAiExtraction({
    summary: "【肝胆功能】\n【胰脏功能】\n【肾脏功能】",
  });
  assert.equal(fields.summary, null);
});

test("summary without section headers stays untouched", () => {
  const { fields } = normalizeAiExtraction({
    summary: "本次体检未见明显异常，建议每年复查。",
  });
  assert.equal(fields.summary, "本次体检未见明显异常，建议每年复查。");
});

