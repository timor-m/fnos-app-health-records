import assert from "node:assert/strict";
import test from "node:test";
import { isExplicitOcrTableHeader, mappedOcrUnit, mappedOcrResultCells, splitOcrTableCells } from "../services/ocr-table-columns";

test('unit recovery requires explicit row or shared header evidence across names', () => {
  for (const name of ['合成项甲', '合成项乙', '合成项丙']) {
    assert.equal(mappedOcrUnit(`${name} | 42 | U/L`, '项目 | 结果 | 单位'), 'U/L');
    assert.equal(mappedOcrUnit(`${name} | 42 |`, '项目 | 结果(U/L) | 单位'), 'U/L');
    assert.equal(mappedOcrUnit(`${name} | 42 | mg/L`, '项目 | 结果(U/L) | 单位'), null);
    assert.equal(mappedOcrUnit(`${name} | 42 | 9/L`, '项目 | 结果 | 单位'), '9/L');
    assert.equal(mappedOcrUnit(`${name} | 42 | 0-99`, '项目 | 结果 | 参考范围'), null);
    assert.equal(mappedOcrUnit(`${name} | | U/L`, '项目 | 结果 | 单位'), null);
  }
  assert.equal(isExplicitOcrTableHeader('项目 | 结果(U/L) | 单位'), true);
});

test("abnormal flag labels are headers, not qualitative results", () => {
  assert.equal(isExplicitOcrTableHeader("项目名称 | 缩写 | 结果 | 单位 | 异常 | 参考范围"), true);
  assert.equal(isExplicitOcrTableHeader("项目 | 结果异常 | 建议复查"), false);
});

test("result mapping preserves abbreviation and empty unit columns", () => {
  const header = "项目名称 | 缩写 | 结果 | 单位 | 异常 | 参考范围";
  assert.deepEqual(mappedOcrResultCells("测试项 | TEST | 7 | | | 0-9", header), ["7"]);
  assert.deepEqual(splitOcrTableCells("测试项 | | 7"), ["测试项", "", "7"]);
  assert.deepEqual(mappedOcrResultCells("测试项 | TEST | | | | 0-9", header), []);
});

test("history and reference values cannot replace the current result", () => {
  assert.deepEqual(mappedOcrResultCells("测试项 | 2 | 7 | 0-9", "项目 | 上次结果 | 本次结果 | 参考范围"), ["7"]);
  assert.deepEqual(mappedOcrResultCells("测试项 | 7", "项目 | 缩写 | 结果"), []);
  assert.deepEqual(mappedOcrResultCells("甲 | 1 | 乙 | 2", "项目 | 结果 | 项目 | 结果"), []);
  assert.equal(mappedOcrResultCells("测试项 | 7", null), null);
});
