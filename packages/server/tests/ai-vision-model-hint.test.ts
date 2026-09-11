import assert from "node:assert/strict";
import test from "node:test";
import { aiVisionModelHint } from "../../ui/src/utils/ai-vision-model-hint.ts";

test("does not label DeepSeek v4.1 Flash a text-only model", () => {
  for (const provider of ["deepseek", "custom"]) {
    for (const textModel of ["deepseek-v4-flash", "deepseek-v4.1-flash"]) {
      const hint = aiVisionModelHint(provider, textModel, "deepseek-v4.1-flash");
      assert.doesNotMatch(hint, /更像文本模型|不能用于|不支持/);
      assert.match(hint, /确认|验证/);
    }
  }
});

test("keeps known text-only warnings and requests verification for unknown models", () => {
  assert.match(aiVisionModelHint("minimax", "", "MiniMax-M2.7"), /不能用于视觉增强/);
  assert.match(aiVisionModelHint("ollama", "", "qwen2.5:7b"), /不能用于视觉增强/);
  assert.match(aiVisionModelHint("custom", "", "unknown-model"), /无法仅根据模型名称确认/);
  assert.match(aiVisionModelHint("deepseek", "", ""), /请填写视觉模型名称/);
});


test("warns for exact DeepSeek v4 Flash even when text and vision models match", () => {
  for (const textModel of ["", "deepseek-v4-flash"]) {
    assert.match(aiVisionModelHint("deepseek", textModel, "deepseek-v4-flash"), /是文本模型，不能用于视觉增强/);
    assert.doesNotMatch(aiVisionModelHint("deepseek", textModel, "deepseek-v4.1-flash"), /是文本模型|更像文本模型/);
  }
});
