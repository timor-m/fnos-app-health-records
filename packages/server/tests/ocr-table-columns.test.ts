import assert from "node:assert/strict";
import test from "node:test";
import { isExplicitOcrTableHeader, mappedOcrMeasurement, mappedOcrUnit, mappedOcrResultCells, splitOcrTableCells } from "../services/ocr-table-columns";

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

test("row-number prefix realigns rows when the header has no index column", () => {
  const header = "项 | 结果 | 单位 | 参考区间 | 方法";
  // 序号独立成格：尾列"方法"为空被丢弃，行格数恰好等于表头数
  assert.deepEqual(
    mappedOcrResultCells("1 | 超敏C-反应蛋白（FR-CRP） | 4.57 | mg/L | 0~10", header),
    ["4.57"],
  );
  // 序号独立成格且尾列空格保留（行格数比表头多一）
  assert.deepEqual(
    mappedOcrResultCells("2 | 白细胞总数（WBC） | 29.59 | 109/L | 3.5~9.5 | ", header),
    ["29.59"],
  );
  // 序号被 OCR 误读为字母（"5"→"LC"）
  assert.deepEqual(
    mappedOcrResultCells("LC | 单核细胞总数（MONO） | 0.58 | 109/L | 0.1~0.6", header),
    ["0.58"],
  );
  // 序号与名称粘连、整行少一格：尾部补齐后对齐全
  assert.deepEqual(
    mappedOcrResultCells("26大型血小板比率（P-LCR） | 15.5 | % | 11~45", header),
    ["15.5"],
  );
  // 名称与结果列同步对齐，序号格不会错当结果
  assert.deepEqual(
    mappedOcrMeasurement("1 | 超敏C-反应蛋白（FR-CRP） | 4.57 | mg/L | 0~10", header),
    { name: "超敏C-反应蛋白（FR-CRP）", result: "4.57" },
  );
  assert.equal(
    mappedOcrUnit("1 | 超敏C-反应蛋白（FR-CRP） | 4.57 | mg/L | 0~10", header),
    "mg/L",
  );
});

test("row-number alignment never misfires on real content", () => {
  const header = "项目 | 结果 | 单位 | 参考区间";
  // 数字开头的项目名（含连接符）不按序号处理
  assert.deepEqual(
    mappedOcrResultCells("25-羟维生素D | 12.5 | ng/mL | 30-100", header),
    ["12.5"],
  );
  // 恰好少一格的常规行尾部补齐，名称保持完整
  assert.deepEqual(
    mappedOcrResultCells("24小时尿蛋白定量 | 0.12 | g/24h", header),
    ["0.12"],
  );
  assert.deepEqual(
    mappedOcrMeasurement("24小时尿蛋白定量 | 0.12 | g/24h", header)?.name,
    "24小时尿蛋白定量",
  );
  // 表头自带序号列时行已对齐，不再左移
  assert.deepEqual(
    mappedOcrResultCells("1 | 白细胞计数 | 29.59 | 109/L", "序号 | 项目 | 结果 | 单位"),
    ["29.59"],
  );
  // 表头自带缩写列时，首格字母是缩写而不是序号噪声
  assert.deepEqual(
    mappedOcrResultCells("WBC | 白细胞计数 | 29.59 | 109/L", "缩写 | 项目 | 结果 | 单位"),
    ["29.59"],
  );
  // 叙述短行不满足数据行形态，保持"不猜测"
  assert.deepEqual(mappedOcrResultCells("备注：无 | 特殊", "项目 | 结果 | 单位"), []);
  // 缺名称格的纯数值行不允许左移出"假名称"
  assert.deepEqual(mappedOcrResultCells("1 | 4.57 | mg/L", header), []);
});
