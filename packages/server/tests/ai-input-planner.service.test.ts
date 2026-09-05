import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nodeTest, { after } from "node:test";

const test = (name: string, fn: () => void) =>
  nodeTest(name, { concurrency: false }, fn);
import { closeDatabaseForTests, getDatabase } from "../database/client.ts";
import {
  aiInputPlanningPolicy,
  localObservationsForLine,
  patientSexFromOcrText,
  planRebuiltOcrPages,
  rebuildOcrPages,
  redactAiInputText,
  splitAiExtractionUnit,
} from "../services/ai-input-planner.service.ts";
import { buildAiExtractionInput } from "../services/ai-extraction.service.ts";
import { installRemoteDictionarySnapshotForTests } from "../services/indicator-dictionary.service.ts";

const plannerStorageDir = mkdtempSync(
  join(tmpdir(), "health-records-ai-planner-"),
);
process.env.STORAGE_DIR = plannerStorageDir;
/* 专科/低频指标（激素、血流变、TCD 等）已迁入 remote 层，
   测试需要与线上一致的 core+remote 完整字典环境。 */
installRemoteDictionarySnapshotForTests();
after(() => {
  closeDatabaseForTests();
  delete process.env.STORAGE_DIR;
  rmSync(plannerStorageDir, { recursive: true, force: true });
});

function page(pageNumber: number, lines: string[]) {
  return {
    pageId: `page-${pageNumber}`,
    pageNumber,
    linesJson: JSON.stringify(
      lines.map((text, index) => ({
        id: `p${pageNumber}-line-${index + 1}`,
        text,
        confidence: 0.98,
        box: [0, index * 12, 100, index * 12 + 10],
      })),
    ),
  };
}

test("packs sparse indicator pages together without a small fixed page split", () => {
  const rows = Array.from({ length: 10 }, (_, index) =>
    page(index + 1, [
      `第${index + 1}页说明 ${"内容".repeat(150)}`,
      `指标${index + 1} ${index + 1}.2 mmol/L 参考范围 1.0-20.0`,
    ]),
  );
  const rebuilt = rebuildOcrPages(rows);
  const plan = planRebuiltOcrPages("report", rebuilt);
  const scalarUnits = plan.units.filter((unit) => unit.route === "scalar");

  assert.equal(plan.pageCount, 10);
  assert.equal(plan.unitCount, 2);
  assert.deepEqual(
    scalarUnits.map((unit) => unit.pageNumbers),
    [[1, 2, 3, 4, 5, 6, 7, 8, 9, 10]],
  );
  assert.equal(plan.units[0].route, "document");
  assert.doesNotMatch(plan.units[0].text, /本地分类|checkup/);
  assert.ok(plan.units.every((unit) => unit.unitType === "complete_pages"));
  assert.ok(
    scalarUnits.every(
      (unit) => unit.characterCount <= aiInputPlanningPolicy.targetCharacters,
    ),
  );
  assert.ok(
    scalarUnits.every(
      (unit) =>
        unit.pageNumbers.length <= aiInputPlanningPolicy.maxPagesPerUnit,
    ),
  );
});

test("keeps a dense oversized page intact instead of splitting original page content", () => {
  const lines = [
    "项目 | 结果 | 单位 | 参考范围",
    ...Array.from(
      { length: 130 },
      (_, index) =>
        `检验项目${index + 1} ${index + 1}.2 mmol/L 参考 ${index}.0-${index + 2}.0`,
    ),
  ];
  const rebuilt = rebuildOcrPages([page(4, lines)]);
  const plan = planRebuiltOcrPages("report", rebuilt);

  const scalar = plan.units.find((unit) => unit.route === "scalar");
  assert.equal(plan.unitCount, 2);
  assert.ok(scalar);
  assert.equal(scalar.unitType, "complete_pages");
  assert.equal(scalar.candidateRowCount, 130);
  assert.ok(
    scalar.estimatedOutputTokens > aiInputPlanningPolicy.targetOutputTokens,
  );
  assert.equal(scalar.lineCount, rebuilt[0].lineCount);
  assert.match(scalar.text, /检验项目130/);
});

test("splits an oversized single-page unit by line ranges as a truncation fallback", () => {
  const lines = [
    "项目 | 结果 | 单位 | 参考范围",
    ...Array.from(
      { length: 130 },
      (_, index) =>
        `检验项目${index + 1} ${index + 1}.2 mmol/L 参考 ${index}.0-${index + 2}.0`,
    ),
  ];
  const plan = planRebuiltOcrPages(
    "dense-split",
    rebuildOcrPages([page(4, lines)]),
  );
  const scalar = plan.units.find((unit) => unit.route === "scalar");
  assert.ok(scalar);
  assert.equal(scalar.pageRanges.length, 1);

  const children = splitAiExtractionUnit(plan, scalar);
  assert.equal(children.length, 2);
  assert.ok(children.every((child) => child.unitType === "page_chunk"));
  assert.deepEqual(
    children.map((child) => [
      child.pageRanges[0].chunkIndex,
      child.pageRanges[0].chunkCount,
    ]),
    [
      [1, 2],
      [2, 2],
    ],
  );
  assert.ok(
    children[0].pageRanges[0].lineEnd < children[1].pageRanges[0].lineStart,
  );
  assert.equal(
    children.reduce((sum, child) => sum + child.candidateRowCount, 0),
    scalar.candidateRowCount,
  );
  assert.match(children[0].text, /内容分块 1\/2/);
  assert.match(children[1].text, /内容分块 2\/2/);
});

test("uses conservative output estimates to plan a dense 24-page report before provider calls", () => {
  const candidateCounts = [
    1, 16, 2, 8, 1, 25, 4, 1, 23, 71, 41, 40, 47, 3, 1, 2, 1, 14, 1, 9, 18, 2,
    1, 1,
  ];
  const rows = candidateCounts.map((count, pageIndex) =>
    page(pageIndex + 1, [
      `第 ${pageIndex + 1} 页检查`,
      "项目 | 结果 | 单位 | 参考范围",
      ...Array.from(
        { length: count },
        (_, itemIndex) =>
          `指标${pageIndex + 1}-${itemIndex + 1} ${itemIndex + 1}.2 mmol/L 参考范围 1.0-200.0`,
      ),
    ]),
  );
  const plan = planRebuiltOcrPages("dense-report", rebuildOcrPages(rows));

  assert.equal(plan.pageCount, 24);
  const scalarUnits = plan.units.filter((unit) => unit.route === "scalar");
  assert.equal(plan.unitCount, 8);
  assert.equal(scalarUnits.length, 7);
  assert.equal(
    scalarUnits.flatMap((unit) => unit.pageNumbers).join(","),
    candidateCounts.map((_, index) => index + 1).join(","),
  );
  assert.ok(
    scalarUnits.every(
      (unit) =>
        unit.pageNumbers.length <= aiInputPlanningPolicy.maxPagesPerUnit,
    ),
  );
  assert.ok(
    scalarUnits.every(
      (unit) =>
        unit.candidateRowCount <=
          aiInputPlanningPolicy.maxCandidateRowsPerUnit ||
        unit.pageNumbers.length === 1,
    ),
  );
  assert.ok(
    scalarUnits.every(
      (unit) =>
        unit.estimatedOutputTokens <=
          aiInputPlanningPolicy.targetOutputTokens ||
        unit.pageNumbers.length === 1,
    ),
  );
});

test("preserves oversized page sections and produces stable content hashes", () => {
  const rows = [
    page(8, [
      "一般检查",
      ...Array.from(
        { length: 30 },
        (_, index) => `一般检查说明${index + 1} ${"内容".repeat(120)}`,
      ),
      "血常规",
      "项目 结果 单位 参考范围",
      ...Array.from(
        { length: 70 },
        (_, index) =>
          `白细胞分项${index + 1} ${index + 1}.1 mmol/L 参考范围 1.0-20.0`,
      ),
    ]),
  ];
  const first = planRebuiltOcrPages("report", rebuildOcrPages(rows));
  const second = planRebuiltOcrPages("report", rebuildOcrPages(rows));
  const changed = planRebuiltOcrPages(
    "report",
    rebuildOcrPages([
      page(8, [
        ...JSON.parse(rows[0].linesJson).map(
          (line: { text: string }) => line.text,
        ),
        "新增检查说明",
      ]),
    ]),
  );

  assert.equal(first.planHash, second.planHash);
  assert.deepEqual(
    first.units.map((unit) => unit.unitKey),
    second.units.map((unit) => unit.unitKey),
  );
  assert.notEqual(first.planHash, changed.planHash);
  assert.equal(first.unitCount, 2);
  const scalar = first.units.find((unit) => unit.route === "scalar");
  assert.ok(scalar);
  assert.match(scalar.text, /血常规/);
  assert.match(scalar.text, /白细胞分项70/);
  assert.doesNotMatch(scalar.text, /一般检查说明30/);
});

test("redacts direct patient identity while retaining business identifiers", () => {
  const text = redactAiInputText(
    [
      "姓名：张三 报告号：R-20260729",
      "李小明 | 男 | 36岁",
      "身份证号：440101199001011234 体检号：PE-100",
      "手机号：13800138000 检查号：EX-200",
      "邮箱：patient@example.com",
      "出生日期：1990-01-01 性别：男 年龄：36岁",
      "住院号：IP-300 标本号：SP-400 条码号：BC-500",
    ].join("\n"),
  );

  assert.doesNotMatch(
    text,
    /张三|李小明|440101199001011234|13800138000|patient@example\.com|1990-01-01/,
  );
  assert.match(text, /R-20260729|PE-100|EX-200|IP-300|SP-400|BC-500/);
  assert.match(text, /男 \| 36岁/);
  assert.match(text, /性别：男 年龄：36岁/);
});

test("redacts an unlabeled patient name after OCR cells are merged into a visual row", () => {
  const rebuilt = rebuildOcrPages([
    {
      pageId: "identity-row",
      pageNumber: 1,
      linesJson: JSON.stringify([
        { id: "name", text: "王小明", confidence: 0.99, box: [10, 10, 80, 20] },
        { id: "sex", text: "男", confidence: 0.99, box: [100, 10, 120, 20] },
        { id: "age", text: "36岁", confidence: 0.99, box: [140, 10, 180, 20] },
        {
          id: "report",
          text: "报告号：R-20260731",
          confidence: 0.99,
          box: [10, 40, 180, 50],
        },
      ]),
    },
  ]);
  assert.doesNotMatch(rebuilt[0].text, /王小明/);
  assert.match(rebuilt[0].text, /患者个资已过滤.*男.*36岁/);
  assert.match(rebuilt[0].text, /R-20260731/);
});

test("reconstructs OCR table cells by coordinates and attaches dictionary candidates", () => {
  const rebuilt = rebuildOcrPages([
    {
      pageId: "page-layout",
      pageNumber: 1,
      linesJson: JSON.stringify([
        {
          id: "name",
          text: "总胆固醇",
          confidence: 0.98,
          box: [
            [10, 20],
            [90, 20],
            [90, 40],
            [10, 40],
          ],
        },
        {
          id: "value",
          text: "5.3",
          confidence: 0.99,
          box: [
            [120, 20],
            [160, 20],
            [160, 40],
            [120, 40],
          ],
        },
        {
          id: "unit",
          text: "mmol/L",
          confidence: 0.99,
          box: [
            [180, 20],
            [240, 20],
            [240, 40],
            [180, 40],
          ],
        },
        {
          id: "range",
          text: "0-5.2",
          confidence: 0.97,
          box: [
            [260, 20],
            [320, 20],
            [320, 40],
            [260, 40],
          ],
        },
      ]),
    },
  ]);

  assert.equal(rebuilt[0].lines.length, 1);
  assert.equal(rebuilt[0].lines[0].text, "总胆固醇 | 5.3 | mmol/L | 0-5.2");
  assert.deepEqual(rebuilt[0].lines[0].sourceLineIds, [
    "name",
    "value",
    "unit",
    "range",
  ]);
  assert.equal(rebuilt[0].lines[0].candidateKind, "scalar");
  assert.ok(
    rebuilt[0].lines[0].dictionaryFacts.some(
      (fact) => fact.displayName === "总胆固醇",
    ),
  );
});

/*
 * 微量元素类检验报告常见“序号 | 项目 | 结果 | 参考范围 | 单位”五列表格：
 * 序号占首格、项目名是单字（钙/镁/铁），部分行单位还会被 OCR 识别坏。
 * 这些行必须保持 scalar 候选资格，否则 AI 提取的正确结果会在证据校验阶段
 * 被全部拒绝，最终报告没有任何指标。
 */
test("keeps serial-numbered single-character laboratory rows as scalar candidates", () => {
  const cell = (id: string, text: string, left: number, top: number) => ({
    id,
    text,
    confidence: 0.98,
    box: [
      [left, top],
      [left + 80, top],
      [left + 80, top + 18],
      [left, top + 18],
    ],
  });
  const tableRow = (rowIndex: number, cells: string[]) =>
    cells.map((text, cellIndex) =>
      cell(`r${rowIndex}c${cellIndex}`, text, 40 + cellIndex * 120, 100 + rowIndex * 28),
    );
  const rebuilt = rebuildOcrPages([
    {
      pageId: "page-trace-elements",
      pageNumber: 1,
      linesJson: JSON.stringify([
        ...tableRow(0, ["序号", "检测项目", "结果", "提示参考范围", "单位"]),
        ...tableRow(1, ["1", "钙", "1.626", "1.4-2.08", "mmol/L"]),
        ...tableRow(2, ["2", "镁", "1.983", "1.2-2.2", "mmol/L"]),
        ...tableRow(3, ["8", "钼", "8660", "<3.3", "μ8/"]),
        ...tableRow(4, ["10", "铅", "2.818", "<100", "ug/L"]),
      ]),
    },
  ]);

  const lines = rebuilt[0].lines;
  const calcium = lines.find((line) => line.text.includes("钙"));
  assert.equal(calcium?.candidateKind, "scalar");
  assert.ok(
    calcium?.dictionaryFacts.some((fact) => fact.displayName === "钙"),
  );
  assert.ok(
    localObservationsForLine(calcium!).some(
      (observation) =>
        observation.itemName === "钙" && observation.resultText === "1.626",
    ),
  );
  /* 单位被 OCR 识别坏（μ8/）的单字项目行仍保留候选资格，交 AI 与证据校验把关 */
  const molybdenum = lines.find((line) => line.text.includes("钼"));
  assert.equal(molybdenum?.candidateKind, "scalar");
  for (const text of ["镁", "铅"]) {
    assert.equal(
      lines.find((line) => line.text.includes(text))?.candidateKind,
      "scalar",
      text,
    );
  }
});

test("does not shift purely numeric leading cells into false candidates", () => {
  const cell = (id: string, text: string, left: number, top: number) => ({
    id,
    text,
    confidence: 0.98,
    box: [
      [left, top],
      [left + 80, top],
      [left + 80, top + 18],
      [left, top + 18],
    ],
  });
  const rebuilt = rebuildOcrPages([
    {
      pageId: "page-numeric-rows",
      pageNumber: 1,
      linesJson: JSON.stringify([
        cell("n1", "3", 40, 100),
        cell("n2", "150", 160, 100),
        cell("n3", "98", 280, 100),
        cell("n4", "120", 40, 140),
        cell("n5", "80", 160, 140),
      ]),
    },
  ]);

  for (const line of rebuilt[0].lines) {
    assert.equal(line.candidateKind, null, line.text);
  }
});

test("detects candidate rows with units supplied only by the indicator dictionary", () => {
  const db = getDatabase();
  db.prepare(
    `
    INSERT INTO indicator_catalog (
      id, canonical_key, display_name, category, default_unit, allowed_units_json, source
    ) VALUES (?, ?, ?, ?, ?, ?, 'user')
  `,
  ).run(
    "test-dynamic-unit-indicator",
    "test_dynamic_unit_indicator",
    "测试动态单位指标",
    "测试",
    "zUq/L",
    JSON.stringify(["zUq/L"]),
  );
  try {
    const rebuilt = rebuildOcrPages([
      page(1, ["【专项检验】", "陌生代谢指标 12.5 zUq/L"]),
    ]);
    const candidate = rebuilt[0].lines.find((line) =>
      line.text.includes("陌生代谢指标"),
    );

    assert.equal(candidate?.candidateKind, "scalar");
    assert.equal(candidate?.dictionaryFacts.length, 0);
  } finally {
    db.prepare("DELETE FROM indicator_catalog WHERE id = ?").run(
      "test-dynamic-unit-indicator",
    );
  }
});

test("splits OCR-concatenated date and time so datetime fields stay parseable", () => {
  const rebuilt = rebuildOcrPages([
    page(1, [
      "采样时间：2024-01-0911:07报告时间：2024-01-0912:41打印时间：2024-01-0912:41:12第1页，共1页",
    ]),
  ]);

  assert.match(rebuilt[0].lines[0].text, /2024-01-09 11:07/);
  assert.match(rebuilt[0].lines[0].text, /2024-01-09 12:41/);
});

test("keeps report timestamps when a footer disclaimer merges into the same visual row", () => {
  const rebuilt = rebuildOcrPages([
    {
      pageId: "page-1",
      pageNumber: 1,
      linesJson: JSON.stringify([
        {
          id: "p1-line-1",
          text: "采样时间：2024-01-0911:07报告时间：2024-01-0912:41打印时间：2024-01-0912:41:12第1页，共1页",
          confidence: 0.98,
          box: [0, 0, 300, 10],
        },
        {
          id: "p1-line-2",
          text: "本报告仅对该样本负责，结果供医师参考，如有疑问请一周内与检验科联系。",
          confidence: 0.98,
          box: [320, 0, 600, 10],
        },
      ]),
    },
  ]);

  const line = rebuilt[0].lines.find((item) => item.text.includes("报告时间"));
  assert.ok(line);
  assert.match(line.text, /报告时间：2024-01-09 12:41/);
  assert.doesNotMatch(line.text, /本报告仅|打印时间|第\s*1\s*页/);
  assert.equal(rebuilt[0].removedLineCount, 0);
});

test("treats blood type qualitative rows as scalar candidates", () => {
  const rebuilt = rebuildOcrPages([
    page(1, [
      "项目名称 | 结果 | 单位 | 参考区间 | 检测方法",
      "ABO血型(BG) | O型 | 微柱凝莎法",
      "Rh(D)血型(Rh(D)) | 阳性(+) | 微柱凝胶法",
    ]),
  ]);
  const abo = rebuilt[0].lines.find((line) => line.text.includes("ABO血型"));
  const rh = rebuilt[0].lines.find((line) => line.text.includes("Rh(D)血型"));

  assert.equal(abo?.candidateKind, "scalar");
  assert.equal(rh?.candidateKind, "scalar");
});

test("creates separate scalar and morphology extraction routes", () => {
  const plan = planRebuiltOcrPages(
    "routed-report",
    rebuildOcrPages([
      page(1, [
        "血脂",
        "总胆固醇 5.3 mmol/L 参考范围 0-5.2",
        "超声检查",
        "右肾见囊肿，大小约 8×6 mm",
      ]),
    ]),
  );

  assert.deepEqual(
    plan.units.map((unit) => unit.route),
    ["document", "morphology"],
  );
  assert.match(plan.units[0].text, /总胆固醇/);
  assert.match(plan.units[1].text, /右肾见囊肿/);
  assert.ok(
    plan.units[0].candidateFacts.every((fact) => fact.kind === "scalar"),
  );
  assert.ok(
    plan.units[1].candidateFacts.every((fact) => fact.kind === "morphology"),
  );
});

test("keeps single-page laboratory indicators while excluding density-name false positives", () => {
  const plan = planRebuiltOcrPages(
    "single-lab",
    rebuildOcrPages([
      page(1, [
        "检验报告单",
        "项目 | 结果 | 单位 | 参考范围",
        "钾 | 4.2 | mmol/L | 3.5~5.3",
        "高密度脂蛋白胆固醇 | 1.2 | mmol/L | >1.0",
      ]),
    ]),
  );
  assert.equal(plan.unitCount, 1);
  assert.equal(plan.units[0].extractionMode, "scalar");
  assert.equal(plan.units[0].allowDocumentFields, true);
  assert.equal(plan.units[0].candidateRowCount, 0);
  assert.equal(plan.localObservationCount, 2);
  const localFacts = plan.pages[0].lines.flatMap((line) =>
    line.localObservation ? [line.localObservation] : [],
  );
  assert.deepEqual(
    localFacts.map((fact) => ({
      name: fact.normalizedName,
      value: fact.numericValue,
      unit: fact.unit,
      low: fact.referenceLow,
      high: fact.referenceHigh,
    })),
    [
      { name: "钾", value: 4.2, unit: "mmol/L", low: 3.5, high: 5.3 },
      {
        name: "高密度脂蛋白胆固醇",
        value: 1.2,
        unit: "mmol/L",
        low: 1,
        high: null,
      },
    ],
  );
  assert.equal(plan.morphologyCandidateCount, 0);
});

test("keeps pure narrative medical sections in a dedicated route", () => {
  const plan = planRebuiltOcrPages(
    "inpatient-narrative",
    rebuildOcrPages([
      page(1, [
        "出院小结",
        "住院号：ZY-20260730",
        "住院经过：患者入院后完成相关检查并接受治疗。",
        "出院医嘱：按门诊安排复诊。",
      ]),
    ]),
  );

  assert.deepEqual(
    plan.units.map((unit) => unit.route),
    ["document", "narrative"],
  );
  const narrative = plan.units[1];
  assert.match(narrative.text, /住院经过/);
  assert.match(narrative.text, /出院医嘱/);
  assert.equal(narrative.candidateRowCount, 0);
  assert.ok(plan.narrativeLineCount >= 2);
});

test("does not dump whole misclassified exam pages into checkup narrative units", () => {
  const plan = planRebuiltOcrPages(
    "checkup-narrative-gate",
    rebuildOcrPages([
      page(1, [
        "健康体检报告",
        "总检结论",
        "本次体检未见明显异常。",
        "建议坚持每年健康体检，践行健康生活方式。",
      ]),
      // 体检内的体格检查表格页带“既往史/体格检查”字样，易被页面级分类误判为门诊病历；
      // 文档主类型是体检时不允许整页倒入 narrative 单元。
      page(2, [
        "体格检查",
        "外科",
        "既往史(外) 无特殊",
        "皮肤 未见异常",
        "浅表淋巴结 未触及肿大",
        "脊柱 未见异常",
        "四肢关节 未见异常",
        "眼科",
        "外眼检查 未见异常",
      ]),
    ]),
  );

  const narrative = plan.units.find((unit) => unit.route === "narrative");
  assert.ok(narrative);
  assert.match(narrative.text, /建议坚持每年健康体检/);
  assert.deepEqual(narrative.pageNumbers, [1]);
  assert.ok(!narrative.text.includes("外眼检查"));
});

test("rejects repeated brand-plus-id headers and device fragments as candidates", () => {
  const rebuilt = rebuildOcrPages([
    page(1, [
      "健康体检报告",
      "RICI HEALTH CHECKUP | 0951112606143052",
      "总胆固醇 5.2 mmol/L 参考范围 2.8-5.2",
    ]),
    page(2, [
      "RICI HEALTH CHECKUP | 0951112606143052",
      "甘油三酯 1.6 mmol/L 参考范围 0.4-1.7",
    ]),
    page(3, ["L0.15cm"]),
  ]);
  const lines = rebuilt.flatMap((item) => item.lines);
  const byText = (fragment: string) =>
    lines.filter((line) => line.text.includes(fragment));
  // 品牌+长编号页眉：裸字母 L 不得被当作单位而放行成长编号候选
  for (const line of byText("RICI HEALTH CHECKUP")) {
    assert.equal(line.candidate, false, line.text);
  }
  // 设备界面残留的无名测量片段不作为候选
  for (const line of byText("L0.15cm")) {
    assert.equal(line.candidate, false, line.text);
  }
  // 真实指标行不受影响
  for (const line of byText("总胆固醇")) {
    assert.equal(line.candidate, true, line.text);
  }
  for (const line of byText("甘油三酯")) {
    assert.equal(line.candidate, true, line.text);
  }
});

test("plans institution-neutral report layouts from structural evidence", () => {
  const cases = [
    {
      id: "table-lab",
      lines: [
        "生化检验报告",
        "项目 | 结果 | 单位 | 参考范围",
        "葡萄糖 | 5.6 | mmol/L | 3.9~6.1",
      ],
      modeCount: 1,
    },
    {
      id: "inline-lab",
      lines: ["血液检验", "WBC 5.2 10^9/L 参考范围 3.5-9.5"],
      modeCount: 1,
    },
    {
      id: "categorical-lab",
      lines: ["尿常规", "尿蛋白 阴性"],
      modeCount: 1,
    },
    {
      id: "imaging-finding",
      lines: ["甲状腺超声检查", "甲状腺左叶见低回声结节，大小约 6×4 mm"],
      modeCount: 2,
    },
  ];
  for (const item of cases) {
    const plan = planRebuiltOcrPages(
      item.id,
      rebuildOcrPages([page(1, item.lines)]),
    );
    assert.equal(plan.units[0].allowDocumentFields, true, item.id);
    assert.equal(plan.unitCount, item.modeCount, item.id);
    assert.ok(plan.candidateRowCount >= 1, item.id);
  }
});

test("does not send health education prose as indicator candidates", () => {
  const plan = planRebuiltOcrPages(
    "education-report",
    rebuildOcrPages([
      page(1, [
        "检验报告单",
        "项目 | 结果 | 单位 | 参考范围",
        "总胆固醇 | 4.8 | mmol/L | <5.2",
      ]),
      page(2, [
        "专家健康宣教",
        "总胆固醇超过 5.2 mmol/L 时应关注生活方式，建议结合医生意见复查。",
      ]),
    ]),
  );
  assert.equal(plan.unitCount, 1);
  assert.equal(plan.candidateRowCount, 1);
  assert.equal(plan.units[0].candidateFacts.length, 0);
  assert.equal(plan.localObservationCount, 1);
});

test("recognizes bracketed report sections and preserves a dash as the current table result", () => {
  const lines = [
    { text: "【便常规】", box: [0, 0, 100, 10] },
    { text: "项目", box: [0, 20, 30, 30] },
    { text: "本次结果", box: [40, 20, 70, 30] },
    { text: "参考值", box: [80, 20, 110, 30] },
    { text: "白细胞", box: [0, 40, 30, 50] },
    { text: "-", box: [40, 40, 70, 50] },
    { text: "0~5", box: [80, 40, 110, 50] },
    { text: "红细胞", box: [0, 60, 30, 70] },
    { text: "-", box: [40, 60, 70, 70] },
    { text: "0~3", box: [80, 60, 110, 70] },
    { text: "【尿常规15项】", box: [0, 80, 100, 90] },
    { text: "酸碱度 | 6.0 | 5.0~8.0", box: [0, 100, 110, 110] },
  ];
  const rebuilt = rebuildOcrPages([
    {
      pageId: "page-1",
      pageNumber: 1,
      linesJson: JSON.stringify(
        lines.map((line, index) => ({
          id: `line-${index + 1}`,
          text: line.text,
          confidence: 0.98,
          box: line.box,
        })),
      ),
    },
  ]);
  const sent = rebuilt[0].text;
  assert.match(sent, /【便常规】/);
  assert.match(sent, /白细胞\s*\|\s*-\s*\|\s*0~5/);
  assert.match(sent, /红细胞\s*\|\s*-\s*\|\s*0~3/);
  assert.match(sent, /【尿常规15项】/);
  assert.equal(
    rebuilt[0].lines.find((line) => line.text.includes("白细胞"))?.candidate,
    true,
  );
  assert.equal(
    rebuilt[0].lines.find((line) => line.text.includes("酸碱度"))?.candidate,
    true,
  );
});

test("excludes historical result sections from scalar and morphology candidates", () => {
  const plan = planRebuiltOcrPages(
    "historical-report",
    rebuildOcrPages([
      page(1, [
        "腹部超声检查报告",
        "中度脂肪肝",
        "【历史检查结果（2025-07-12）】",
        "轻度脂肪肝",
        "总胆固醇 | 5.8 | mmol/L | <5.2",
      ]),
    ]),
  );
  const sent = plan.pages[0].text;
  assert.match(sent, /中度脂肪肝/);
  assert.doesNotMatch(sent, /轻度脂肪肝|总胆固醇|2025-07-12/);
  assert.equal(plan.pages[0].morphologyCandidateCount, 1);
  assert.equal(plan.pages[0].candidateRowCount, 1);
});

test("keeps health education continuation pages out of the candidate plan", () => {
  const plan = planRebuiltOcrPages(
    "education-continuation",
    rebuildOcrPages([
      page(1, [
        "检验报告单",
        "项目 | 结果 | 单位 | 参考范围",
        "总胆固醇 | 4.8 | mmol/L | <5.2",
      ]),
      page(2, ["专家健康宣教", "总胆固醇超过 5.2 mmol/L 时应关注生活方式。"]),
      page(3, [
        "尿酸和体重管理",
        "尿酸高于 420 μmol/L 时建议咨询医生，体重应保持在合理范围。",
      ]),
    ]),
  );
  assert.equal(plan.candidateRowCount, 1);
  assert.equal(plan.pages[1].candidateRowCount, 0);
  assert.equal(plan.pages[2].candidateRowCount, 0);
  assert.equal(plan.pages[2].lines.length, 0);
});

test("includes common ECG vascular tumor-marker and urine microscopy measurements as candidates", () => {
  const plan = planRebuiltOcrPages(
    "functional-report",
    rebuildOcrPages([
      page(1, [
        "【心电图】",
        "PR间期 | 158 | ms | 120~200",
        "QRS时限 | 92 | ms | 60~110",
        "QTc间期 | 410 | ms | <450",
      ]),
      page(2, [
        "【动脉粥样硬化指数】",
        "右侧ABI | 1.08 | 0.9~1.4",
        "右侧baPWV | 1420 | cm/s | <1400",
        "DOB | 0.42 | 0.1~1.0",
      ]),
      page(3, ["【肿瘤标志物】", "f-PSA/T-PSA | 22.0 | % | >20"]),
      page(4, ["【尿常规】", "镜检管型 | 0 | Cast/LP | 0~1"]),
    ]),
  );
  const candidates = [
    ...plan.units.flatMap((unit) =>
      unit.candidateFacts.map((fact) => fact.sourceText),
    ),
    ...plan.pages.flatMap((item) =>
      item.lines.flatMap((line) =>
        line.localObservation ? [line.localObservation.sourceText] : [],
      ),
    ),
  ];
  for (const name of [
    "PR间期",
    "QRS时限",
    "QTc间期",
    "右侧ABI",
    "右侧baPWV",
    "DOB",
    "f-PSA/T-PSA",
    "镜检管型",
  ]) {
    assert.equal(
      candidates.some((line) => line.includes(name)),
      true,
      name,
    );
  }
});

test("excludes instrument settings chart legends and interpretation prose from scalar candidates", () => {
  const plan = planRebuiltOcrPages(
    "technical-noise",
    rebuildOcrPages([
      page(1, [
        "【心电图】",
        "增益: 10mm/mV 走速: 25mm/s | 窦性心律",
        "心率: 73 bpm",
        "PR间期: 153 ms",
      ]),
      page(2, [
        "13C呼气试验Hp检验报告",
        "试剂名称：13c尿素 | 纯度：99%",
        "指标：DOB值 | 检测值：0.7 | 检验结果：阴性",
      ]),
      page(3, [
        "动脉阻塞与僵硬度检测报告单",
        "右：1315 | 左：1395 | PWV(cm/s)",
        "*baPWV主要检测肢体 | 1000",
        "反映脑血管或心脏 | 800",
        "异常区域 | 正常区域",
        "双侧下肢静态ABI在正常范围",
        "四肢动脉脉搏波形未见异常。",
      ]),
    ]),
  );
  const facts = plan.units.flatMap((unit) =>
    unit.candidateFacts.map((fact) => fact.sourceText),
  );
  assert.equal(
    facts.some((line) =>
      /增益|走速|试剂名称|主要检测|反映脑血管|异常区域|未见异常/.test(line),
    ),
    false,
  );
  /* DOB 带标签三元组已由字典和本地解析闭环，不再发送给 AI。 */
  assert.equal(
    facts.some((line) => line.includes("DOB值")),
    false,
  );
  assert.equal(
    facts.some((line) => line.includes("右：1315")),
    true,
  );
  /* “心率: 73 bpm”“PR间期: 153 ms”是完整测量值，已由本地解析接管，不再占用 AI 候选。 */
  assert.equal(
    facts.some((line) => line.includes("心率: 73")),
    false,
  );
  assert.equal(
    facts.some((line) => line.includes("PR间期: 153")),
    false,
  );
  const localTexts = plan.pages
    .flatMap((item) => item.lines)
    .filter((line) => line.localObservation)
    .map((line) => line.text);
  assert.equal(
    localTexts.some((line) => line.includes("心率: 73")),
    true,
  );
  assert.equal(
    localTexts.some((line) => line.includes("PR间期: 153")),
    true,
  );
});

test("matches only the first table cell against dictionary aliases", () => {
  const rebuilt = rebuildOcrPages([
    page(1, [
      "【血糖】",
      "项目 | 本次结果 | 单位 | 参考范围",
      "糖化血红蛋白 | 5.4 | % | 4.0~6.0",
    ]),
  ]);
  const line = rebuilt[0].lines.find((item) =>
    item.text.includes("糖化血红蛋白"),
  );
  assert.ok(line);
  assert.equal(
    line.dictionaryFacts.some((item) => item.canonicalKey === "cbc_hgb"),
    false,
  );
});

test("removes repeated page noise while preserving table headers and medical rows", () => {
  const rebuilt = rebuildOcrPages(
    Array.from({ length: 6 }, (_, index) =>
      page(index + 1, [
        "示例健康体检中心",
        `第 ${index + 1} 页 / 共 6 页`,
        "姓名：张三",
        "报告号：REPORT-100",
        "项目 | 结果 | 单位 | 参考范围",
        `白细胞计数 ${5 + index / 10} 10^9/L 参考范围 3.5-9.5`,
        "本报告仅供临床参考",
      ]),
    ),
  );
  const plan = planRebuiltOcrPages("report", rebuilt);
  const sent = plan.pages.map((item) => item.text).join("\n");

  assert.equal((sent.match(/示例健康体检中心/g) || []).length, 1);
  assert.equal((sent.match(/报告号：REPORT-100/g) || []).length, 1);
  assert.equal(
    (sent.match(/项目 \| 结果 \| 单位 \| 参考范围/g) || []).length,
    6,
  );
  assert.equal((sent.match(/白细胞计数/g) || []).length, 6);
  assert.doesNotMatch(sent, /张三|本报告仅供临床参考|共 6 页/);
  assert.equal(plan.candidateRowCount, 6);
  assert.ok(plan.repeatedRemovedLineCount >= 10);
  assert.ok(plan.noiseRemovedLineCount >= 6);
  assert.equal(plan.sourceLineCount, 36);
  assert.ok(plan.removedLineCount >= 16);
});

test("keeps the current single-request adapter while exposing the full OCR plan", () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-ai-plan-"));
  process.env.STORAGE_DIR = storageDir;
  try {
    const db = getDatabase();
    db.exec(`
      INSERT INTO users (id, display_name) VALUES ('owner', '管理员');
      INSERT INTO health_members (id, display_name, created_by) VALUES ('member', '本人', 'owner');
      INSERT INTO reports (id, member_id, created_by, report_type, title, status)
      VALUES ('report', 'member', 'owner', 'checkup', '长体检报告', 'processing');
    `);
    const insertPage = db.prepare(`
      INSERT INTO report_pages (
        id, report_id, page_number, original_name, mime_type, storage_path, file_size, sha256
      ) VALUES (?, 'report', ?, ?, 'image/png', ?, 1, ?)
    `);
    const insertJob = db.prepare(`
      INSERT INTO processing_jobs (
        id, report_id, page_id, job_type, status, pipeline_version, deduplication_key
      ) VALUES (?, 'report', ?, 'ocr', 'completed', 'test', ?)
    `);
    const insertOcr = db.prepare(`
      INSERT INTO ocr_results (
        id, job_id, page_id, engine, model_version, lines_json, text_length
      ) VALUES (?, ?, ?, 'test', 'test-v1', ?, ?)
    `);
    for (let index = 1; index <= 12; index += 1) {
      const pageId = `page-${index}`;
      const jobId = `job-${index}`;
      const text = `第${index}页 ${"完整报告内容".repeat(1_200)}`;
      insertPage.run(
        pageId,
        index,
        `${index}.png`,
        `originals/${index}.png`,
        `hash-${index}`,
      );
      insertJob.run(jobId, pageId, `ocr-${index}`);
      insertOcr.run(
        `ocr-${index}`,
        jobId,
        pageId,
        JSON.stringify([{ id: "line-1", text }]),
        text.length,
      );
    }

    const input = buildAiExtractionInput("report");
    assert.equal(input.pageCount, 12);
    assert.equal(input.plannedUnits, 1);
    assert.ok((input.sourceInputCharacters || 0) > 80_000);
    assert.equal(input.inputCharacters, 80_000);
    assert.equal(input.compatibilityTruncated, true);
    assert.match(input.planHash || "", /^[a-f0-9]{64}$/);
  } finally {
    closeDatabaseForTests();
    rmSync(storageDir, { recursive: true, force: true });
    process.env.STORAGE_DIR = plannerStorageDir;
  }
});

test("parses only unambiguous dictionary rows when OCR loses the table header", () => {
  const rebuilt = rebuildOcrPages([
    page(1, [
      "【一般检查】",
      "身高 | 175.5 cm | 175.0 cm",
      "体重 | 76.7 kg | 76.1 kg",
      "体重指数BMI | 24.9 ↑ | 18.5~23.9 | 24.8 ↑",
    ]),
  ]);
  const facts = rebuilt[0].lines.flatMap((line) =>
    line.localObservation ? [line.localObservation] : [],
  );

  assert.deepEqual(
    facts.map((fact) => ({
      name: fact.normalizedName,
      value: fact.numericValue,
      unit: fact.unit,
      low: fact.referenceLow,
      high: fact.referenceHigh,
    })),
    [],
  );
  const ambiguousRows = rebuilt[0].lines.filter((line) =>
    /^(?:身高|体重|体重指数BMI)/.test(line.text),
  );
  assert.equal(
    ambiguousRows.every((line) => line.candidate),
    true,
  );
  assert.equal(
    ambiguousRows.every(
      (line) => line.candidateResolutionReason === "supplement_required",
    ),
    true,
  );
  const plan = planRebuiltOcrPages("local-table", rebuilt);
  assert.equal(plan.units[0].route, "document");
  assert.equal(plan.units[0].candidateRowCount, 3);
});

test("parses simple categorical table rows locally without turning value rows into headings", () => {
  const rebuilt = rebuildOcrPages([
    page(1, [
      "【内科】",
      "主诉 | 无特殊",
      "面容 | 正常 | 正常",
      "心音 | 正常 | 正常",
      "腹部 | 未见异常 | 未见异常",
      "【便常规】",
      "虫卵 | -",
    ]),
  ]);
  const rows = rebuilt[0].lines.filter((line) =>
    /主诉|面容|心音|腹部|虫卵/.test(line.text),
  );
  const facts = rows.flatMap((line) =>
    line.localObservation ? [line.localObservation] : [],
  );

  assert.equal(
    rows.find((line) => line.text.startsWith("主诉"))?.boundary,
    null,
  );
  assert.deepEqual(
    facts.map((fact) => [fact.itemName, fact.resultText, fact.sectionName]),
    [
      ["面容", "正常", "内科"],
      ["心音", "正常", "内科"],
      ["腹部", "未见异常", "内科"],
      ["虫卵", "-", "便常规"],
    ],
  );
});

test("merges wrapped morphology and recommendation lines before candidate planning", () => {
  const rebuilt = rebuildOcrPages([
    page(1, [
      "超声描述",
      "肝脏形态较饱满，回声细密，深部回声衰减。肝右叶见强回声，直径约7m",
      "m，后方无声影，未见胆管扩张。",
      "双叶甲状腺形态大小正常，左叶内见混合回声，大小约2×2mm，水平位（0分）生",
      "长，边缘光整，其内未见点状强回声。",
      "超声提示",
      "肝右叶局灶性钙化灶",
      "左叶甲状腺结节，C-TIRADS 3类",
    ]),
  ]);

  assert.equal(
    rebuilt[0].lines.some((line) =>
      line.text.includes("直径约7mm，后方无声影"),
    ),
    true,
  );
  assert.equal(
    rebuilt[0].lines.some((line) =>
      line.text.includes("水平位（0分）生长，边缘光整"),
    ),
    true,
  );
  assert.equal(
    rebuilt[0].lines.some(
      (line) => line.text === "m，后方无声影，未见胆管扩张。",
    ),
    false,
  );
});

test("does not attach single-character electrolyte facts to real recommendation or morphology text", () => {
  const golden = JSON.parse(
    readFileSync(
      new URL(
        "./fixtures/p3-short-chinese-alias-context-golden.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as {
    source: {
      pages: Array<{
        pageId: string;
        pageNumber: number;
        lines: Array<{
          id: string;
          text: string;
          confidence: number;
          box: unknown;
        }>;
      }>;
    };
    expected: {
      excludedDictionaryFacts: Array<{
        pageNumber: number;
        sourceLineId: string;
        canonicalKey: string;
        reason: string;
      }>;
      retainedSemantics: Array<{
        pageNumber: number;
        sourceLineId: string;
        contentRole: string;
        candidate: boolean;
        candidateKind?: string;
      }>;
    };
  };
  const rebuilt = rebuildOcrPages(
    golden.source.pages.map((sourcePage) => ({
      pageId: sourcePage.pageId,
      pageNumber: sourcePage.pageNumber,
      linesJson: JSON.stringify(sourcePage.lines),
    })),
  );
  const sourceLine = (pageNumber: number, sourceLineId: string) =>
    rebuilt
      .find((page) => page.pageNumber === pageNumber)
      ?.lines.find((line) => line.sourceLineIds.includes(sourceLineId));

  for (const excluded of golden.expected.excludedDictionaryFacts) {
    const line = sourceLine(excluded.pageNumber, excluded.sourceLineId);
    assert.ok(
      line,
      `真实 OCR 行未重建：${excluded.pageNumber}/${excluded.sourceLineId}`,
    );
    assert.equal(
      line.dictionaryFacts.some(
        (fact) => fact.canonicalKey === excluded.canonicalKey,
      ),
      false,
      excluded.reason,
    );
    assert.equal(
      line.localObservations.some((observation) =>
        line.dictionaryFacts.some(
          (fact) =>
            fact.canonicalKey === excluded.canonicalKey &&
            fact.displayName === observation.normalizedName,
        ),
      ),
      false,
      `${excluded.reason}，且不得生成本地 observation`,
    );
  }

  for (const retained of golden.expected.retainedSemantics) {
    const line = sourceLine(retained.pageNumber, retained.sourceLineId);
    assert.ok(line);
    assert.equal(line.contentRole, retained.contentRole);
    assert.equal(line.candidate, retained.candidate);
    if (retained.candidateKind)
      assert.equal(line.candidateKind, retained.candidateKind);
  }

  const plan = planRebuiltOcrPages("real-short-alias-context", rebuilt);
  const plannedFacts = plan.units.flatMap((unit) => unit.candidateFacts);
  for (const excluded of golden.expected.excludedDictionaryFacts) {
    assert.equal(
      plannedFacts.some(
        (candidate) =>
          candidate.pageNumber === excluded.pageNumber &&
          candidate.dictionaryFacts.some(
            (fact) => fact.canonicalKey === excluded.canonicalKey,
          ),
      ),
      false,
      `${excluded.reason}，且不得进入 AI 规范化提示事实`,
    );
  }
});

test("parses an inline categorical examination result locally", () => {
  const rebuilt = rebuildOcrPages([
    page(1, ["13C呼气试验Hp检验报告单", "13c呼气试验Hp检验报告结果：阴性"]),
  ]);
  const fact = rebuilt[0].lines.find((line) =>
    /结果/.test(line.text),
  )?.localObservation;

  assert.equal(fact?.resultText, "阴性");
  assert.match(fact?.sectionName || "", /13C呼气试验/);
  assert.equal(
    planRebuiltOcrPages("inline-result", rebuilt).units.some(
      (unit) => unit.route === "scalar",
    ),
    false,
  );
});

test("disambiguates multi-meaning aliases with the current section hints", () => {
  const rebuilt = rebuildOcrPages([
    page(1, [
      "【内科】",
      "心率 | 72 | 次/分 | 60-100",
      "【心电图】",
      "心率 | 75 | 次/分 | 60-100",
      "【血液常规（五分类）】",
      "白细胞 | 6.5 | 10^9/L | 3.5-9.5",
    ]),
  ]);
  const facts = rebuilt[0].lines.flatMap((line) =>
    line.localObservation ? [line.localObservation] : [],
  );

  assert.deepEqual(
    facts.map((fact) => [fact.itemName, fact.normalizedName, fact.sectionName]),
    [
      ["心率", "脉搏", "内科"],
      ["心率", "心电图心率", "心电图"],
      ["白细胞", "白细胞计数", "血液常规（五分类）"],
    ],
  );
});

test("uses a departmental report heading to disambiguate aliases", () => {
  const rebuilt = rebuildOcrPages([
    page(1, ["心电图报告单", "心率 | 75 | 次/分 | 60-100"]),
  ]);
  const fact = rebuilt[0].lines.find((line) =>
    line.text.startsWith("心率"),
  )?.localObservation;

  assert.equal(fact?.normalizedName, "心电图心率");
});

test("parses inline name-value measurement lines with an exact dictionary re-lookup", () => {
  const rebuilt = rebuildOcrPages([
    page(1, [
      "心电图检查报告单",
      "心率: 87 bpm | 正常心电图",
      "PR间期: 154 ms",
      "QRS时限: 96 ms",
      "QT间期: 360 ms",
      "QTC间期: 407 ms",
      "P电轴: 56 Angle",
      "QRS电轴: 79 Angle",
      "T电轴: 40 Angle",
      "RV5: 1.046 mv",
      "SV1: 0.493 mv",
    ]),
  ]);
  const byText = new Map(
    rebuilt[0].lines.map((line) => [line.text, line.localObservation]),
  );

  assert.deepEqual(
    [
      "心率: 87 bpm | 正常心电图",
      "PR间期: 154 ms",
      "QRS时限: 96 ms",
      "QT间期: 360 ms",
      "QTC间期: 407 ms",
      "P电轴: 56 Angle",
      "QRS电轴: 79 Angle",
      "T电轴: 40 Angle",
      "RV5: 1.046 mv",
      "SV1: 0.493 mv",
    ].map((text) => [
      byText.get(text)?.normalizedName,
      byText.get(text)?.numericValue,
      byText.get(text)?.unit,
    ]),
    [
      ["心电图心率", 87, "bpm"],
      ["PR 间期", 154, "ms"],
      ["QRS 时限", 96, "ms"],
      ["QT 间期", 360, "ms"],
      ["QTc 间期", 407, "ms"],
      ["P 电轴", 56, "Angle"],
      ["QRS 电轴", 79, "Angle"],
      ["T 电轴", 40, "Angle"],
      ["RV5 振幅", 1.046, "mv"],
      ["SV1 振幅", 0.493, "mv"],
    ],
  );
});

test("treats the value glued in the name cell as the result, not the following reference cell", () => {
  const rebuilt = rebuildOcrPages([
    page(1, ["心电图检查报告单", "PR间期: 154 ms | 120-200"]),
  ]);
  const fact = rebuilt[0].lines.find((line) =>
    line.text.startsWith("PR间期"),
  )?.localObservation;

  assert.equal(fact?.normalizedName, "PR 间期");
  assert.equal(fact?.numericValue, 154);
  assert.equal(fact?.unit, "ms");
  assert.deepEqual([fact?.referenceLow, fact?.referenceHigh], [120, 200]);
});

test("locally splits an explicit blood-pressure tuple despite trailing narration", () => {
  const rebuilt = rebuildOcrPages([
    page(1, [
      "【一般检查】",
      "血压：133/89mmHg，血压正常高值；建议低盐富钾饮食，定期复查血压。",
      "OPR:",
    ]),
  ]);
  const bloodPressure = rebuilt[0].lines.find((line) =>
    line.text.startsWith("血压："),
  );

  assert.deepEqual(
    bloodPressure?.localObservations.map((fact) => ({
      itemName: fact.itemName,
      normalizedName: fact.normalizedName,
      resultText: fact.resultText,
      numericValue: fact.numericValue,
      unit: fact.unit,
      abnormalFlag: fact.abnormalFlag,
    })),
    [
      {
        itemName: "收缩压",
        normalizedName: "收缩压",
        resultText: "133",
        numericValue: 133,
        unit: "mmHg",
        abnormalFlag: null,
      },
      {
        itemName: "舒张压",
        normalizedName: "舒张压",
        resultText: "89",
        numericValue: 89,
        unit: "mmHg",
        abnormalFlag: null,
      },
    ],
  );
  assert.equal(
    bloodPressure?.localObservations.every(
      (fact) => fact.sourceLineId === bloodPressure.id,
    ),
    true,
  );
  const plan = planRebuiltOcrPages("blood-pressure-tuple", rebuilt);
  assert.equal(
    plan.units
      .flatMap((unit) => unit.candidateFacts)
      .filter((fact) => fact.kind === "scalar").length,
    0,
  );
});

test("rejects implausible or unitless blood-pressure tuples from local parsing", () => {
  const rebuilt = rebuildOcrPages([
    page(1, [
      "【一般检查】",
      "血压：40/20mmHg",
      "血压：89/133mmHg",
      "血压：133/89",
    ]),
  ]);

  assert.equal(
    rebuilt[0].lines.some((line) => line.localObservations.length > 0),
    false,
  );
});

test("stays conservative when a multi-meaning alias has no usable section context", () => {
  const rebuilt = rebuildOcrPages([page(1, ["心率 | 72 | 次/分 | 60-100"])]);

  assert.equal(
    rebuilt[0].lines.some((line) => line.localObservation),
    false,
  );
});

test("ignores institution names and short ASCII substrings inside pulmonary composite codes", () => {
  const compositeRows = [
    "VC/HT | 2.41 | 限制性 | 正常",
    "FVC/HT | 2.62 | 限制性 | 正常",
    "FEV1/HT | 2.18 | 正常 | 正常",
    "FEF50/HT | 3.96 | 正常 | 正常",
  ];
  const rebuilt = rebuildOcrPages([
    page(1, [
      "深圳瑞慈瑞新健康体检中心肺功能报告单",
      "项目 | 结果 | 提示 | 参考",
      ...compositeRows,
    ]),
  ]);

  for (const text of compositeRows) {
    const row = rebuilt[0].lines.find((line) => line.text === text);
    assert.ok(row, `missing rebuilt OCR row: ${text}`);
    assert.equal(
      row.dictionaryFacts.length,
      0,
      `${text} 不应命中 VC、HT 等短别名`,
    );
    assert.equal(
      row.localObservation ?? null,
      null,
      `${text} 不应生成本地 observation`,
    );
    assert.equal(row.candidate, false, `${text} 不应再进入 AI 候选`);
    assert.equal(row.candidateKind, null);
    assert.equal(row.role, "noise");
    assert.equal(row.contentRole, "environment");
    assert.equal(row.candidateResolutionReason, "filtered_noise");
  }
});

test("matches dictionary aliases through serum prefixes and assay suffixes", () => {
  const rebuilt = rebuildOcrPages([
    page(1, [
      "【肝功能七项】",
      "血清总胆红素 | 12.40 μmol/L | 2~20.4 μmol/L",
      "血清碱性磷酸酶 | 148.00 U/L ↑ | 46~134 U/L",
      "【肾功能】",
      "血清胱抑素C测定 | 1.06 mg/L ↑ | 0.01~1.02 mg/L",
    ]),
  ]);
  const facts = rebuilt[0].lines.flatMap((line) =>
    line.localObservation ? [line.localObservation] : [],
  );

  assert.deepEqual(
    facts.map((fact) => [
      fact.itemName,
      fact.normalizedName,
      fact.numericValue,
      fact.unit,
      fact.abnormalFlag,
    ]),
    [
      ["血清总胆红素", "总胆红素", 12.4, "μmol/L", null],
      ["血清碱性磷酸酶", "碱性磷酸酶", 148, "U/L", "high"],
      ["血清胱抑素C测定", "胱抑素C", 1.06, "mg/L", "high"],
    ],
  );
});

test("keeps audited hormone units and bracketed eye laterality in deterministic OCR facts", () => {
  const rebuilt = rebuildOcrPages([
    page(1, [
      "【性激素】",
      "TESTO | 420 ng/dL | 200~800 ng/dL",
      "PRL | 20 μg/L | 5~25 μg/L",
      "【眼科】",
      "眼压(右) | 18 mmHg | 10~21 mmHg",
      "IOP(L) | 17 mmHg | 10~21 mmHg",
    ]),
  ]);
  const byText = new Map(
    rebuilt[0].lines.map((line) => [line.text, line.localObservation]),
  );

  assert.deepEqual(
    byText.get("TESTO | 420 ng/dL | 200~800 ng/dL") && [
      byText.get("TESTO | 420 ng/dL | 200~800 ng/dL")?.normalizedName,
      byText.get("TESTO | 420 ng/dL | 200~800 ng/dL")?.unit,
    ],
    ["睾酮", "ng/dL"],
  );
  assert.deepEqual(
    byText.get("PRL | 20 μg/L | 5~25 μg/L") && [
      byText.get("PRL | 20 μg/L | 5~25 μg/L")?.normalizedName,
      byText.get("PRL | 20 μg/L | 5~25 μg/L")?.unit,
    ],
    ["泌乳素", "μg/L"],
  );
  assert.equal(
    byText.get("眼压(右) | 18 mmHg | 10~21 mmHg")?.normalizedName,
    "右眼眼压",
  );
  assert.equal(
    byText.get("IOP(L) | 17 mmHg | 10~21 mmHg")?.normalizedName,
    "左眼眼压",
  );
});

test("parses structurally complete rows while keeping unknown unitless indices conservative", () => {
  const rebuilt = rebuildOcrPages([
    page(1, [
      "【眼科】",
      "右眼眼压 | 19 mmHg | 10~21 mmHg",
      "【血粘度】",
      "全血粘度（低切） | 16.53 MPa.s ↑ | 9.5~15.2 MPa.s",
      "血浆黏度（旋转法） | 1.42 cP | 1.10~1.80 cP",
      "红细胞沉降率 | 6.00 mm/hr | 0.00~15.00 mm/hr",
      "全血高切相对指数 | 3.92 | 2.23~4.6",
      "未收录血流变相对指数 | 3.92 | 2.23~4.6",
    ]),
  ]);
  const byText = new Map(
    rebuilt[0].lines.map((line) => [line.text, line.localObservation]),
  );
  const eyePressure = byText.get("右眼眼压 | 19 mmHg | 10~21 mmHg");
  const viscosity = byText.get(
    "全血粘度（低切） | 16.53 MPa.s ↑ | 9.5~15.2 MPa.s",
  );
  const plasmaViscosity = byText.get(
    "血浆黏度（旋转法） | 1.42 cP | 1.10~1.80 cP",
  );
  const sedimentation = byText.get(
    "红细胞沉降率 | 6.00 mm/hr | 0.00~15.00 mm/hr",
  );

  assert.deepEqual(
    eyePressure && [
      eyePressure.normalizedName,
      eyePressure.numericValue,
      eyePressure.unit,
      eyePressure.referenceLow,
      eyePressure.referenceHigh,
      eyePressure.sectionName,
    ],
    ["右眼眼压", 19, "mmHg", 10, 21, "眼科"],
  );
  assert.deepEqual(
    viscosity && [
      viscosity.normalizedName,
      viscosity.numericValue,
      viscosity.unit,
      viscosity.referenceLow,
      viscosity.referenceHigh,
      viscosity.abnormalFlag,
    ],
    // 别名「全血粘度（低切）」命中字典后输出规范名「全血低切黏度」（无剪切档位编号版本）
    ["全血低切黏度", 16.53, "MPa.s", 9.5, 15.2, "high"],
  );
  assert.deepEqual(
    plasmaViscosity && [
      plasmaViscosity.numericValue,
      plasmaViscosity.unit,
      plasmaViscosity.referenceLow,
      plasmaViscosity.referenceHigh,
    ],
    [1.42, "cP", 1.1, 1.8],
  );
  assert.equal(sedimentation?.unit, "mm/hr");
  assert.deepEqual(
    byText.get("全血高切相对指数 | 3.92 | 2.23~4.6") && [
      byText.get("全血高切相对指数 | 3.92 | 2.23~4.6")?.normalizedName,
      byText.get("全血高切相对指数 | 3.92 | 2.23~4.6")?.numericValue,
      byText.get("全血高切相对指数 | 3.92 | 2.23~4.6")?.unit,
      byText.get("全血高切相对指数 | 3.92 | 2.23~4.6")?.referenceLow,
      byText.get("全血高切相对指数 | 3.92 | 2.23~4.6")?.referenceHigh,
    ],
    ["全血高切相对指数", 3.92, null, 2.23, 4.6],
  );
  // 缺单位且没有字典定义的无量纲行仍保持保守，交给 AI。
  assert.equal(
    byText.get("未收录血流变相对指数 | 3.92 | 2.23~4.6") ?? null,
    null,
  );
});

test("parses reference ranges without swallowing glued measurement units", () => {
  const rebuilt = rebuildOcrPages([
    page(1, [
      "【血常规】",
      "血小板 | 241 10^9/L | 125~350 10^9/L",
      "白细胞计数 | 5.88 10^9/L | 3.5~9.5 10^9/L",
      "【甲状腺功能】",
      "促甲状腺激素(TSH) | 3.95 mIU/L | 0.27~4.2 mIU/L",
    ]),
  ]);
  const byText = new Map(
    rebuilt[0].lines.map((line) => [line.text, line.localObservation]),
  );
  const platelet = byText.get("血小板 | 241 10^9/L | 125~350 10^9/L");
  const leukocyte = byText.get("白细胞计数 | 5.88 10^9/L | 3.5~9.5 10^9/L");
  const tsh = byText.get("促甲状腺激素(TSH) | 3.95 mIU/L | 0.27~4.2 mIU/L");

  assert.deepEqual(
    platelet && [platelet.referenceLow, platelet.referenceHigh],
    [125, 350],
  );
  assert.deepEqual(
    leukocyte && [leukocyte.referenceLow, leukocyte.referenceHigh],
    [3.5, 9.5],
  );
  assert.deepEqual(tsh && [tsh.unit, tsh.referenceLow, tsh.referenceHigh], [
    "mIU/L",
    0.27,
    4.2,
  ]);
});

test("does not mistake value-summary sentences for table headers", () => {
  const rebuilt = rebuildOcrPages([
    page(1, [
      "【肾功能】",
      "血清胱抑素C测定值偏高(1.06mg/L)(参考值0.01--1.02)；建议肾内科随诊。",
      "尿蛋白 | 阴性 | 阴性",
    ]),
  ]);
  const summary = rebuilt[0].lines.find((line) =>
    line.text.includes("胱抑素C测定值偏高"),
  );

  assert.equal(summary?.boundary ?? null, null);
  assert.notEqual(summary?.role, "table_header");
  const plan = planRebuiltOcrPages("summary-not-header", rebuilt);
  const narrative = plan.units.find((unit) => unit.route === "narrative");
  assert.match(narrative?.text || "", /建议肾内科随诊/);
  // 表头上下文不被汇总行污染，后续行仍可正常本地解析
  const urine = rebuilt[0].lines.find((line) => line.text.startsWith("尿蛋白"));
  assert.equal(urine?.localObservation?.resultText, "阴性");
});

test("injects the inherited table header into scalar units for continued pages", () => {
  const rebuilt = rebuildOcrPages([
    page(1, [
      "【血粘度】",
      "项目 | 结果 | 参考值",
      "全血粘度（低切） | 16.53 | 9.5~15.2",
    ]),
    page(2, ["未收录血流变相对指数 | 3.92 | 2.23~4.6"]),
  ]);
  const continued = rebuilt[1].lines.find((line) =>
    line.text.includes("未收录血流变相对指数"),
  );
  assert.equal(continued?.tableHeaderText, "项目 | 结果 | 参考值");

  const plan = planRebuiltOcrPages("continued-table", rebuilt);
  const scalar = plan.units.find((unit) => unit.route === "scalar");
  assert.ok(scalar);
  const pageTwoBlock = scalar.text.split(/\[第 \d+ 页[^\]]*\]/).at(-1) || "";
  assert.match(
    pageTwoBlock,
    /\[表头：项目 \| 结果 \| 参考值\]\n未收录血流变相对指数/,
  );
  // 首页和续页统一使用标准化上下文标记，不再发送原始边界行。
  const pageOneBlock = scalar.text.split(/\[第 \d+ 页[^\]]*\]/)[1] || "";
  assert.match(pageOneBlock, /\[章节：血粘度\]/);
  assert.match(pageOneBlock, /\[表头：项目 \| 结果 \| 参考值\]/);
  assert.doesNotMatch(pageOneBlock, /【血粘度】/);
});

test("limits scalar AI context to the candidate's nearest section and table header", () => {
  const rebuilt = rebuildOcrPages([
    page(1, [
      "【血常规】",
      "项目 | 结果 | 单位 | 参考范围",
      "白细胞计数 | 5.2 | 10^9/L | 3.5~9.5",
      "【肾功能】",
      "名称 | 检查结果 | 参考范围",
      "泽塔相位参数 | 7.1 | 3.0~8.0",
    ]),
    page(2, ["报告结束"]),
  ]);
  const plan = planRebuiltOcrPages("scoped-scalar-context", rebuilt);
  const scalar = plan.units.find((unit) => unit.route === "scalar");

  assert.ok(scalar);
  assert.match(scalar.text, /\[章节：肾功能\]/);
  assert.match(scalar.text, /\[表头：名称 \| 检查结果 \| 参考范围\]/);
  assert.match(scalar.text, /泽塔相位参数/);
  assert.doesNotMatch(scalar.text, /血常规/);
  assert.doesNotMatch(scalar.text, /项目 \| 结果 \| 单位 \| 参考范围/);
});

test("keeps bounded neighboring description lines for morphology candidates", () => {
  const plan = planRebuiltOcrPages(
    "morphology-neighbor-context",
    rebuildOcrPages([
      page(1, [
        "【甲状腺超声检查】",
        "甲状腺右叶见低回声结节，大小约 8×6 mm。",
        "建议结合临床，6个月后复查。",
        "本页其他无关说明文字。",
      ]),
    ]),
  );
  const morphology = plan.units.find((unit) => unit.route === "morphology");

  assert.ok(morphology);
  assert.match(morphology.text, /\[章节：甲状腺超声检查\]/);
  assert.match(morphology.text, /甲状腺右叶见低回声结节/);
  assert.match(morphology.text, /建议结合临床，6个月后复查/);
  assert.doesNotMatch(morphology.text, /本页其他无关说明文字/);
});

test("keeps patient identity rows in the document unit when headings overflow the budget", () => {
  const rows = Array.from({ length: 30 }, (_, pageIndex) =>
    page(pageIndex + 1, [
      `第${pageIndex + 1}页抬头`,
      ...Array.from(
        { length: 20 },
        (_, headingIndex) =>
          `【第${pageIndex + 1}页第${headingIndex + 1}项专科检查标题】`,
      ),
    ]),
  );
  rows[0] = page(1, [
    "示例健康体检报告",
    "张三 | 男 | 36 岁",
    ...Array.from(
      { length: 20 },
      (_, index) => `【首页专科检查标题${index + 1}】`,
    ),
  ]);
  const plan = planRebuiltOcrPages("identity-priority", rebuildOcrPages(rows));
  const document = plan.units.find((unit) => unit.route === "document");

  assert.ok(document);
  assert.ok(
    document.characterCount > aiInputPlanningPolicy.targetCharacters * 0.9,
  );
  // 姓名占位符在行处理阶段会被清除，性别/年龄单元格必须留在文档单元里
  assert.match(document.text, /男 \| 36 岁/);
});

test("strips chart axis ticks from row tails while preserving data cells", () => {
  const rebuilt = rebuildOcrPages([
    page(1, [
      "【肺功能】",
      "FEV1.0%(G) | 99.45 | 79.48 | 125.1 | 10 | 15 | 20 | 25 | 30 | 35 | 40 | 45 | 50 | 55 | 60 | (SEC)",
      "【人体成分】",
      "体重指数 | 24.6 | 18.5-23.9 | 12 | 15 | 18 | 21 | 27",
      "体重对比 | 70 | 72 | 75 | 78 | 80",
    ]),
  ]);
  const fev = rebuilt[0].lines.find((line) =>
    line.text.startsWith("FEV1.0%(G)"),
  );
  const bmi = rebuilt[0].lines.find((line) => line.text.startsWith("体重指数"));
  const compare = rebuilt[0].lines.find((line) =>
    line.text.startsWith("体重对比"),
  );

  assert.equal(fev?.text, "FEV1.0%(G) | 99.45 | 79.48 | 125.1");
  assert.equal(bmi?.text, "体重指数 | 24.6 | 18.5-23.9");
  // 步长无一致规律的递增数列不是坐标刻度，完整保留
  assert.equal(compare?.text, "体重对比 | 70 | 72 | 75 | 78 | 80");
});

test("resolves gender-specific reference ranges with the patient sex", () => {
  const rows = [
    page(1, [
      "【激素测定】",
      "睾酮测定 | 3.28 ng/mL | 男：1.79~8.14|女：<0.99 ng/mL",
      "血清泌乳素测定 | 24.11 ng/ml | 男：2.7~13|女：绝经前：3.4~26.5；绝经后：2.8~19.5 ng/ml",
    ]),
  ];
  const pick = (pages: ReturnType<typeof rebuildOcrPages>, name: string) =>
    pages[0].lines.find((line) => line.text.startsWith(name))?.localObservation;

  const male = rebuildOcrPages(rows, { patientSex: "male" });
  assert.deepEqual(
    pick(male, "睾酮测定") && [
      pick(male, "睾酮测定")?.referenceLow,
      pick(male, "睾酮测定")?.referenceHigh,
    ],
    [1.79, 8.14],
  );
  assert.deepEqual(
    pick(male, "血清泌乳素测定") && [
      pick(male, "血清泌乳素测定")?.referenceLow,
      pick(male, "血清泌乳素测定")?.referenceHigh,
    ],
    [2.7, 13],
  );

  const female = rebuildOcrPages(rows, { patientSex: "female" });
  assert.deepEqual(
    pick(female, "睾酮测定") && [
      pick(female, "睾酮测定")?.referenceLow,
      pick(female, "睾酮测定")?.referenceHigh,
    ],
    [null, 0.99],
  );
  // 绝经前/后子分段需要年龄才能再选：保留可核验结果，但不猜参考范围。
  assert.deepEqual(
    pick(female, "血清泌乳素测定") && [
      pick(female, "血清泌乳素测定")?.numericValue,
      pick(female, "血清泌乳素测定")?.referenceLow,
      pick(female, "血清泌乳素测定")?.referenceHigh,
    ],
    [24.11, null, null],
  );

  // 性别未知不猜参考范围，但稳定字典指标仍可保留可核验结果。
  const unknown = rebuildOcrPages(rows);
  assert.deepEqual(
    pick(unknown, "睾酮测定") && [
      pick(unknown, "睾酮测定")?.numericValue,
      pick(unknown, "睾酮测定")?.referenceLow,
      pick(unknown, "睾酮测定")?.referenceHigh,
    ],
    [3.28, null, null],
  );
});

test("treats double hyphens between positive reference bounds as a separator", () => {
  const rebuilt = rebuildOcrPages([
    page(4, [
      "【异常汇总】",
      "血清丙氨酸氨基转移酶值偏高(59.30U/L)(参考值0--40)；建议复查。",
      "淀粉酶值偏高(113.00U/L)(参考值25.8--103.2)；建议复查。",
      "血清胱抑素C测定值偏高(1.06mg/L)(参考值0.01--1.02)；建议复查。",
    ]),
  ]);

  assert.deepEqual(
    rebuilt[0].lines
      .flatMap((line) => line.localObservations)
      .map((fact) => [
        fact.normalizedName,
        fact.referenceLow,
        fact.referenceHigh,
      ]),
    [
      ["丙氨酸氨基转移酶", 0, 40],
      ["淀粉酶", 25.8, 103.2],
      ["胱抑素C", 0.01, 1.02],
    ],
  );
});

test("parses a long gender-segmented prolactin reference in an explicit summary", () => {
  const rows = [
    page(4, [
      "【实验室检查】",
      "血清泌乳素测定值偏高(24.11ng/ml)(参考值男：2.7-13|女：绝经前：3.4-26.5；绝经后：2.8-19.5)；建议内分泌科复查。",
    ]),
  ];
  const pick = (pages: ReturnType<typeof rebuildOcrPages>) =>
    pages[0].lines.find((line) => line.text.startsWith("血清泌乳素"))
      ?.localObservations[0];

  const unknown = pick(rebuildOcrPages(rows));
  assert.deepEqual(
    unknown && [
      unknown.normalizedName,
      unknown.numericValue,
      unknown.unit,
      unknown.referenceLow,
      unknown.referenceHigh,
      unknown.abnormalFlag,
    ],
    ["泌乳素", 24.11, "ng/ml", null, null, "high"],
  );

  const male = pick(rebuildOcrPages(rows, { patientSex: "male" }));
  assert.deepEqual(
    male && [male.referenceLow, male.referenceHigh, male.referenceText],
    [2.7, 13, "2.7-13"],
  );
});

test("classifies date metadata and quantitative-ultrasound device parameters independently", () => {
  const rebuilt = rebuildOcrPages([
    page(1, [
      "超声骨密度检测报告",
      "出生日期 | 1992-06-11 | 测量部位（左/右）",
      "测量日期：2025-07-12 07：50:39 | 测量编号：1/1",
      "骨质指数：44.6 | 同龄比 | 84.2",
    ]),
  ]);
  const birth = rebuilt[0].lines.find((line) => line.text.includes("出生日期"));
  const measure = rebuilt[0].lines.find((line) =>
    line.text.includes("测量日期"),
  );
  const bone = rebuilt[0].lines.find((line) => line.text.includes("骨质指数"));

  assert.equal(birth?.candidate, false);
  assert.equal(birth?.role, "metadata");
  assert.equal(measure?.candidate, false);
  assert.equal(measure?.role, "metadata");
  // 超声骨检测的设备派生参数保留原文，但不进入家庭趋势或 scalar AI。
  assert.equal(bone?.candidate, false);
  assert.equal(bone?.role, "noise");
  assert.equal(bone?.contentRole, "environment");
  assert.equal(bone?.candidateResolutionReason, "filtered_noise");
});

test("normalizes only QUS-context T/Z scores and keeps generic bone scores separate", () => {
  const qus = rebuildOcrPages([
    page(1, ["超声骨密度检测报告", "T值 | -1.9", "Z值 | -1.7"]),
  ]);
  assert.deepEqual(
    qus[0].lines
      .flatMap((line) => line.localObservations)
      .map((observation) => [
        observation.normalizedName,
        observation.numericValue,
      ]),
    [
      ["超声骨密度 T 值", -1.9],
      ["超声骨密度 Z 值", -1.7],
    ],
  );

  const genericBoneDensity = rebuildOcrPages([
    page(1, ["骨密度检查报告", "T值 | -1.0", "Z值 | -0.8"]),
  ]);
  assert.equal(genericBoneDensity[0].localObservationCount, 0);
});

test("classifies report heading rows with bare date/time labels as metadata", () => {
  const rebuilt = rebuildOcrPages([
    page(1, [
      "超声经颅多普勒报告单 | 日期：2025/7/12 | 11:37",
      "右侧大脑中动脉 | 56 | 98 | 61",
    ]),
  ]);
  const heading = rebuilt[0].lines.find((line) =>
    line.text.includes("超声经颅多普勒"),
  );
  const artery = rebuilt[0].lines.find((line) =>
    line.text.includes("右侧大脑中动脉"),
  );

  assert.equal(heading?.candidate, false);
  assert.equal(heading?.role, "metadata");
  // 含真实数值结果的行不受影响
  assert.equal(artery?.candidate, true);
});

test("accepts prefixed name columns like 测定项目 in table headers", () => {
  const rebuilt = rebuildOcrPages([
    page(1, [
      "测定项目 | 测定值 | 参考值 | 以下 | 标准 | 标准以上",
      "体重指数 | 24.6 | 18.5-23.9",
    ]),
  ]);
  const fact = rebuilt[0].lines.find((line) =>
    line.text.startsWith("体重指数"),
  )?.localObservation;

  assert.equal(fact?.normalizedName, "体重指数");
  assert.equal(fact?.numericValue, 24.6);
  assert.deepEqual([fact?.referenceLow, fact?.referenceHigh], [18.5, 23.9]);
});

test("detects patient sex from OCR identity cells as a fallback", () => {
  const lines = (texts: string[]) =>
    JSON.stringify(texts.map((text, index) => ({ id: `l${index}`, text })));

  assert.equal(
    patientSexFromOcrText([lines(["示例体检报告", "男", "33岁"])]),
    "male",
  );
  assert.equal(patientSexFromOcrText([lines(["张三 | 女 | 29 岁"])]), "female");
  assert.equal(
    patientSexFromOcrText([lines(["性别：女", "体检编号 R-1"])]),
    "female",
  );
  // 孤立的性别字没有年龄上下文，不采信
  assert.equal(patientSexFromOcrText([lines(["男科检查", "未见异常"])]), null);
  assert.equal(
    patientSexFromOcrText([lines(["男女通用参考说明", "男"])]),
    null,
  );
});

test("routes bilingual checkup summaries and functional conclusions as narrative blocks", () => {
  const plan = planRebuiltOcrPages(
    "checkup-summary",
    rebuildOcrPages([
      page(1, [
        "个人健康体检报告",
        "异常结果与健康建议 | Abnormal Findings and Health Recommendations",
        "【一般检查】",
        "体重指数BMI值偏高(24.9)(参考值18.5~23.9)；建议合理膳食并控制体重。",
      ]),
      page(2, [
        "动脉阻塞与僵硬度检测报告单 | 身高：175.5cm | 体重：76.7kg | BMI:24.9",
        "检查所见 | 诊断所见",
        "双侧下肢静态ABI未见异常。",
        "双侧baPWV正常范围。",
      ]),
    ]),
  );
  const narrative = plan.units.find((unit) => unit.route === "narrative");

  assert.ok(narrative);
  assert.match(narrative.text, /异常结果与健康建议/);
  assert.match(narrative.text, /建议合理膳食并控制体重/);
  assert.match(narrative.text, /双侧下肢静态ABI未见异常/);
  assert.match(narrative.text, /双侧baPWV正常范围/);
});

test("resets section context at a new report page while preserving explicit table continuation", () => {
  const pages = rebuildOcrPages([
    page(1, [
      "【肿瘤标志物】",
      "项目 | 本次结果 | 单位 | 参考值",
      "癌胚抗原 | 2.1 | ng/mL | <5",
    ]),
    page(2, ["心电图检查报告单", "PR间期 | 158 | ms | 120~200"]),
    page(3, ["【尿常规】", "尿蛋白 | 阴性 | | 阴性"]),
    page(4, [
      "项目 | 参考值",
      "2026-06-14 | 2025-07-12",
      "镜检白细胞 | 2 | Cell/HP | 0~5",
    ]),
  ]);

  assert.match(
    pages[1].lines.find((line) => line.text.startsWith("PR间期"))
      ?.sectionName || "",
    /心电图/,
  );
  assert.doesNotMatch(
    pages[1].lines.find((line) => line.text.startsWith("PR间期"))
      ?.sectionName || "",
    /肿瘤/,
  );
  assert.match(
    pages[3].lines.find((line) => line.text.startsWith("镜检白细胞"))
      ?.sectionName || "",
    /尿常规/,
  );
});

test("assigns stable content roles and filters non-measurement numeric noise before AI planning", () => {
  const rebuilt = rebuildOcrPages([
    page(1, [
      "报告时间：2026-08-05 10:30",
      "参考范围说明：0-5 正常，5-10 偏高",
      "建议每日饮水 2000 mL，并每周运动 150 分钟。",
      "时间(s) | 0 | 5 | 10 | 15 | 20 | 25",
      "环境温度：25 ℃ | 湿度：60%",
      "总胆固醇 5.3 mmol/L 参考范围 0-5.2",
    ]),
  ]);
  const byText = (part: string) =>
    rebuilt[0].lines.find((line) => line.text.includes(part));

  assert.equal(byText("报告时间")?.contentRole, "metadata");
  assert.equal(byText("参考范围说明")?.contentRole, "reference");
  assert.equal(byText("建议每日饮水")?.contentRole, "recommendation");
  assert.equal(byText("时间(s)")?.contentRole, "chart_axis");
  assert.equal(byText("环境温度")?.contentRole, "environment");
  assert.equal(byText("总胆固醇")?.contentRole, "measurement");
  assert.equal(byText("总胆固醇")?.candidateKind, "scalar");
  for (const part of [
    "报告时间",
    "参考范围说明",
    "建议每日饮水",
    "时间(s)",
    "环境温度",
  ]) {
    assert.equal(byText(part)?.candidate, false, part);
    assert.equal(
      byText(part)?.candidateResolutionReason,
      "filtered_noise",
      part,
    );
  }
  assert.equal(rebuilt[0].candidateRowCount, 1);
});

test("marks unsupported multidimensional reference matrices without supplement eligibility", () => {
  const rebuilt = rebuildOcrPages([
    page(1, [
      "风险等级 | 0-5 | 6-10 | 11-20 | 21-30",
      "专项指标 12.5 U/L 参考范围 0-10",
    ]),
  ]);
  const matrix = rebuilt[0].lines.find((line) =>
    line.text.startsWith("风险等级"),
  );
  const measurement = rebuilt[0].lines.find((line) =>
    line.text.startsWith("专项指标"),
  );

  assert.equal(matrix?.candidate, false);
  assert.equal(matrix?.contentRole, "reference");
  assert.equal(matrix?.candidateResolutionReason, "unsupported_complex_table");
  assert.equal(measurement?.candidate, true);
  assert.equal(measurement?.candidateResolutionReason, "supplement_required");
});

test("filters negated morphology clauses while retaining a later positive finding", () => {
  const rebuilt = rebuildOcrPages([
    page(1, [
      "超声检查",
      "未见结节或占位。",
      "未发现囊肿。",
      "未提示明显斑块。",
      "未检出结石。",
      "无明显积液。",
      "不考虑肿块。",
      "已排除占位性病变。",
      "未见明显异常，但可见右肾结节，大小约 8×6 mm。",
    ]),
  ]);
  const negativeLines = rebuilt[0].lines.filter(
    (line) =>
      /未见结节|未发现囊肿|未提示明显斑块|未检出结石|无明显积液|不考虑肿块|已排除占位/.test(
        line.text,
      ) && !/但可见/.test(line.text),
  );
  const positive = rebuilt[0].lines.find((line) =>
    /但可见右肾结节/.test(line.text),
  );

  assert.equal(
    negativeLines.every((line) => line.candidateKind !== "morphology"),
    true,
  );
  assert.equal(positive?.candidateKind, "morphology");
  assert.equal(positive?.contentRole, "measurement");
});

test("filters complete recommendation sentences even when they mention dictionary indicators and numbers", () => {
  const rebuilt = rebuildOcrPages([
    page(1, ["建议每日监测总胆固醇 1 次，并结合结果调整饮食。"]),
  ]);
  const line = rebuilt[0].lines[0];

  assert.equal(line.contentRole, "recommendation");
  assert.equal(line.candidate, false);
  assert.equal(line.candidateKind, null);
  assert.equal(line.dictionaryFacts.length, 0);
  assert.equal(line.candidateResolutionReason, "filtered_noise");
});

test("classifies labelled comparison rules as reference guidance instead of measurements", () => {
  const rebuilt = rebuildOcrPages([
    page(1, ["低风险 < 6% | 中风险 6%～10% | 高风险 ≥ 10%"]),
  ]);
  const line = rebuilt[0].lines[0];

  assert.equal(line.contentRole, "reference");
  assert.equal(line.candidate, false);
  assert.equal(line.candidateResolutionReason, "filtered_noise");
});

test("classifies two comparison rules with short outcome suffixes as reference guidance", () => {
  const rebuilt = rebuildOcrPages([page(1, ["ABC<4.0为阴性 | ABC≥4.0为阳性"])]);
  const line = rebuilt[0].lines[0];

  assert.equal(line.contentRole, "reference");
  assert.equal(line.candidate, false);
  assert.equal(line.candidateResolutionReason, "filtered_noise");
});

test("does not filter a single comparison measurement as reference guidance", () => {
  const rebuilt = rebuildOcrPages([page(1, ["陌生专项指标 | < 4.0 | U/L"])]);
  const line = rebuilt[0].lines[0];

  assert.equal(line.contentRole, "measurement");
  assert.equal(line.candidate, true);
  assert.notEqual(line.candidateResolutionReason, "filtered_noise");
});

test("blocks age and percentage multidimensional matrices even when cells contain measurement units", () => {
  const rebuilt = rebuildOcrPages([
    page(1, [
      "年龄分层 | 20-29岁 | 30-39岁 | 40-49岁 | 50-59岁 | 风险百分比",
      "18-39岁 | -20% | 21-34% | 35-39%",
    ]),
  ]);

  for (const line of rebuilt[0].lines) {
    assert.equal(line.contentRole, "reference", line.text);
    assert.equal(line.candidate, false, line.text);
    assert.equal(
      line.candidateResolutionReason,
      "unsupported_complex_table",
      line.text,
    );
  }
});

test("does not mistake a named percentage measurement for an age-band reference row", () => {
  const rebuilt = rebuildOcrPages([
    page(1, ["年龄修正指数 | -20% | 参考范围 | -30%~-10%"]),
  ]);
  const line = rebuilt[0].lines[0];

  assert.equal(line.contentRole, "measurement");
  assert.equal(line.candidate, true);
  assert.notEqual(line.candidateResolutionReason, "unsupported_complex_table");
});

test("keeps multi-value OCR joins auditable but prevents automatic supplement extraction", () => {
  const rebuilt = rebuildOcrPages([
    page(1, [
      "测量汇总 | 12.1 | 13.2 | 14.3",
      "测量汇总 | 左侧:12.1 | 右侧:13.2",
      "采样日期 | 2026-08-05 08:30 | 陌生值:12.5",
      "28.5kg | 14.4kg",
    ]),
  ]);

  for (const line of rebuilt[0].lines) {
    assert.equal(line.contentRole, "measurement", line.text);
    assert.equal(line.candidate, true, line.text);
    assert.equal(line.candidateResolutionReason, "ambiguous_layout", line.text);
  }
});

test("filters timestamp rows followed only by orphan field labels", () => {
  const rebuilt = rebuildOcrPages([
    page(1, ["时间：2025-07-1208:03:29 | 调节说明（kg） | 基础代谢"]),
  ]);
  const line = rebuilt[0].lines[0];

  assert.equal(line.contentRole, "metadata");
  assert.equal(line.candidate, false);
  assert.equal(line.candidateResolutionReason, "filtered_noise");
});

test("does not filter timestamp rows when a later cell contains an actual result", () => {
  const rebuilt = rebuildOcrPages([
    page(1, ["时间：2025-07-12 08:03:29 | 调节说明（kg） | 陌生值:12.5"]),
  ]);
  const line = rebuilt[0].lines[0];

  assert.equal(line.contentRole, "measurement");
  assert.equal(line.candidate, true);
  assert.equal(line.candidateResolutionReason, "ambiguous_layout");
});

test("marks joined labelled values ambiguous even under an inherited result table header", () => {
  const rebuilt = rebuildOcrPages([
    page(1, [
      "测定项目 | 测定值 | 参考值 | 以下 | 标准 | 标准以上",
      "左侧量：2.8kg | 右侧量：3.0kg",
    ]),
  ]);
  const line = rebuilt[0].lines.find((item) => item.text.startsWith("左侧量"));

  assert.equal(line?.contentRole, "measurement");
  assert.equal(line?.candidate, true);
  assert.equal(line?.candidateResolutionReason, "ambiguous_layout");
});

test("matches the anonymous P2 unknown-scalar governance golden cases", () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL("./fixtures/p2-unknown-scalar-golden.json", import.meta.url),
      "utf8",
    ),
  ) as {
    cases: Array<{
      id: string;
      lines: string[];
      targetPrefix: string;
      expectedReason: "ambiguous_layout" | "supplement_required";
    }>;
  };

  for (const golden of fixture.cases) {
    const rebuilt = rebuildOcrPages([page(1, golden.lines)]);
    const line = rebuilt[0].lines.find((item) =>
      item.text.startsWith(golden.targetPrefix),
    );
    assert.ok(line, golden.id);
    assert.equal(line.contentRole, "measurement", golden.id);
    assert.equal(line.candidate, true, golden.id);
    assert.equal(
      line.candidateResolutionReason,
      golden.expectedReason,
      golden.id,
    );
  }
});

test("keeps opaque repeated device-range codes auditable without automatic supplement extraction", () => {
  const rebuilt = rebuildOcrPages([
    page(1, ["功能检查", "ABC18-70(ABC1) | 0.603"]),
  ]);
  const line = rebuilt[0].lines.find((item) =>
    item.text.startsWith("ABC18-70"),
  );

  assert.equal(line?.contentRole, "measurement");
  assert.equal(line?.candidate, true);
  assert.equal(line?.candidateResolutionReason, "ambiguous_layout");
  assert.equal(line?.localObservations.length, 0);
});

test("does not generalize opaque device-range ambiguity to ordinary cold metrics", () => {
  const rebuilt = rebuildOcrPages([page(1, ["功能检查", "FEF25-75 | 1.23"])]);
  const line = rebuilt[0].lines.find((item) =>
    item.text.startsWith("FEF25-75"),
  );

  assert.equal(line?.contentRole, "measurement");
  assert.equal(line?.candidate, true);
  assert.equal(line?.candidateResolutionReason, "supplement_required");
});

test("preserves structurally complete measurement rows and local parsing after ambiguity filtering", () => {
  const rebuilt = rebuildOcrPages([
    page(1, [
      "【专项检验】",
      "项目 | 结果 | 单位 | 参考范围",
      "陌生专项指标 | 12.5 | U/L | 0-10",
    ]),
  ]);
  const line = rebuilt[0].lines.find((item) =>
    item.text.startsWith("陌生专项指标"),
  );

  assert.equal(line?.contentRole, "measurement");
  assert.equal(line?.candidate, true);
  assert.notEqual(line?.candidateResolutionReason, "ambiguous_layout");
  assert.ok(line?.localObservation);
  assert.equal(line?.localObservation?.numericValue, 12.5);
});

test("retains a positive morphology finding when the same sentence also contains follow-up advice", () => {
  const rebuilt = rebuildOcrPages([
    page(1, ["右肾见结节，大小约 8×6 mm；建议复查。"]),
  ]);
  const line = rebuilt[0].lines[0];

  assert.equal(line.contentRole, "measurement");
  assert.equal(line.candidate, true);
  assert.equal(line.candidateKind, "morphology");
  assert.equal(line.candidateResolutionReason, "supplement_required");
});

test("does not discard a scalar result clause merely because follow-up advice appears later", () => {
  const rebuilt = rebuildOcrPages([
    page(1, [
      "体重指数BMI值偏高(24.9)(参考值18.5~23.9)；建议合理膳食并控制体重。",
    ]),
  ]);
  const line = rebuilt[0].lines[0];

  assert.equal(line.contentRole, "measurement");
  assert.equal(line.candidate, true);
  assert.equal(line.candidateKind, "scalar");
});

test("maps reconstructed table cells to exact OCR source lines and drops chart-axis sources", () => {
  const positionedPage = {
    pageId: "source-map-page",
    pageNumber: 1,
    linesJson: JSON.stringify(
      [
        ["项目", "历史结果", "本次结果", "单位", "参考范围"],
        [
          "总胆固醇",
          "5.0",
          "5.3",
          "mmol/L",
          "0-5.2",
          "0",
          "5",
          "10",
          "15",
          "20",
          "25",
          "SEC",
        ],
      ].flatMap((row, rowIndex) =>
        row.map((text, cellIndex) => ({
          id: `r${rowIndex + 1}c${cellIndex + 1}`,
          text,
          confidence: 0.99,
          box: [
            cellIndex * 90,
            rowIndex * 24,
            cellIndex * 90 + 70,
            rowIndex * 24 + 16,
          ],
        })),
      ),
    ),
  };
  const rebuilt = rebuildOcrPages([positionedPage]);
  const line = rebuilt[0].lines.find((item) =>
    item.text.startsWith("总胆固醇"),
  );
  const fact = line?.localObservations[0];

  assert.ok(line);
  assert.equal(line.sourceCells.length, 5);
  assert.deepEqual(
    line.sourceCells.map((cell) => cell.sourceLineIds),
    [["r2c1"], ["r2c2"], ["r2c3"], ["r2c4"], ["r2c5"]],
  );
  assert.deepEqual(fact?.sourceMap.item.sourceLineIds, ["r2c1"]);
  assert.deepEqual(fact?.sourceMap.result.sourceLineIds, ["r2c3"]);
  assert.deepEqual(fact?.sourceMap.unit?.sourceLineIds, ["r2c4"]);
  assert.deepEqual(fact?.sourceMap.reference?.sourceLineIds, ["r2c5"]);
  assert.deepEqual(fact?.sourceMap.result.headerSourceLineIds, ["r1c3"]);
  assert.equal(fact?.sourceMap.result.headerText, "本次结果");
  assert.equal(fact?.sourceMap.unit?.headerText, "单位");
  assert.equal(fact?.sourceMap.reference?.headerText, "参考范围");
  assert.equal(
    line.sourceCells.some((cell) =>
      cell.sourceLineIds.some((id) => /^r2c(?:6|7|8|9|10|11|12)$/.test(id)),
    ),
    false,
  );
});

test("extracts both repeated CBC panels by coordinates and sends partial rows to AI", () => {
  const columns = [0, 220, 320, 440, 620, 840, 940, 1060];
  const rawLines: Array<{
    id: string;
    text: string;
    confidence: number;
    box: number[];
  }> = [];
  const addRow = (
    row: number,
    cells: Array<{ id: string; text: string; column?: number; x?: number }>,
  ) => {
    for (const cell of cells) {
      const left = cell.x ?? columns[cell.column ?? 0];
      rawLines.push({
        id: cell.id,
        text: cell.text,
        confidence: 0.99,
        box: [left, row * 28, left + 80, row * 28 + 16],
      });
    }
  };

  addRow(0, [{ id: "cbc-title", text: "血常规五分类检验报告单" }]);
  addRow(
    1,
    ["项目", "结果", "单位", "参考范围", "项目", "结果", "单位", "参考范围"].map(
      (text, column) => ({ id: `header-${column + 1}`, text, column }),
    ),
  );
  addRow(2, [
    { id: "wbc-item", text: "白细胞数目(WBC)", column: 0 },
    { id: "wbc-marker", text: "【深圳HR】", x: 120 },
    { id: "wbc-result", text: "5.0", column: 1 },
    { id: "wbc-unit", text: "10^9/L", column: 2 },
    { id: "wbc-reference", text: "3.5-9.5", column: 3 },
    { id: "baso-item", text: "嗜碱性粒细胞百分比(BASO%)", column: 4 },
    { id: "baso-damaged-result", text: "8'0", column: 5 },
    { id: "baso-reference", text: "0.0-1.0", column: 7 },
  ]);
  addRow(3, [
    { id: "rbc-item", text: "红细胞数目(RBC)", column: 0 },
    { id: "rbc-result", text: "5.56", column: 1 },
    { id: "rbc-unit", text: "10^12/L", column: 2 },
    { id: "rbc-reference", text: "4.3-5.8", column: 3 },
    { id: "neut-count-item", text: "中性粒细胞绝对值(NEUT#)", column: 4 },
    { id: "neut-count-result", text: "1.96", column: 5 },
    { id: "neut-count-unit", text: "10^9/L", column: 6 },
    { id: "neut-count-reference", text: "1.8-6.3", column: 7 },
  ]);
  addRow(4, [
    { id: "neut-percent-item", text: "中性粒细胞百分比(NEUT%)", column: 0 },
    { id: "neut-percent-reference", text: "40-75", column: 3 },
    { id: "pct-item", text: "血小板压积(PCT)", column: 4 },
    { id: "pct-result", text: "0.23", column: 5 },
    { id: "pct-reference", text: "0.19-0.36", column: 7 },
  ]);
  addRow(5, [
    { id: "lymph-percent-item", text: "淋巴细胞百分比(LYMPH%)", column: 0 },
    { id: "lymph-percent-result", text: "49.1", column: 1 },
    { id: "lymph-percent-reference", text: "20-50", column: 3 },
    { id: "pdw-item", text: "血小板体积分布宽度(PDVW)", column: 4 },
    { id: "pdw-damaged-result", text: "↑76", column: 5 },
    { id: "pdw-reference", text: "9.8-15.2", column: 7 },
  ]);
  addRow(6, [
    { id: "mchc-item", text: "平均红细胞血红蛋白浓度(MCHC)", column: 0 },
    { id: "mchc-result", text: "342", column: 1 },
    { id: "mchc-damaged-unit", text: "9/L", column: 2 },
    { id: "mchc-reference", text: "316-354", column: 3 },
  ]);

  const rebuilt = rebuildOcrPages([
    {
      pageId: "repeated-cbc-page",
      pageNumber: 1,
      linesJson: JSON.stringify(rawLines),
    },
  ]);
  const reportPage = rebuilt[0];
  const facts = reportPage.lines.flatMap((line) => line.localObservations);
  const byName = new Map(facts.map((fact) => [fact.itemName, fact]));
  const plan = planRebuiltOcrPages("repeated-cbc-report", rebuilt);
  const scalar =
    plan.units.find((unit) => unit.route === "scalar") || plan.units[0];
  const wbcLine = reportPage.lines.find((line) =>
    line.sourceLineIds.includes("wbc-item"),
  );
  const rbcLine = reportPage.lines.find((line) =>
    line.sourceLineIds.includes("rbc-item"),
  );

  assert.ok(wbcLine);
  assert.doesNotMatch(wbcLine.text, /深圳HR/);
  assert.equal(wbcLine.sourceLineIds.includes("wbc-marker"), false);
  assert.equal(
    wbcLine.expectedLocalObservationCount,
    2,
    JSON.stringify({
      text: wbcLine.text,
      candidate: wbcLine.candidate,
      candidateKind: wbcLine.candidateKind,
      role: wbcLine.role,
      boundary: wbcLine.boundary,
      tableHeaderText: wbcLine.tableHeaderText,
      localObservationCount: wbcLine.localObservations.length,
    }),
  );
  assert.deepEqual(
    [
      byName.get("白细胞数目(WBC)")?.numericValue,
      byName.get("红细胞数目(RBC)")?.numericValue,
      byName.get("中性粒细胞绝对值(NEUT#)")?.numericValue,
      byName.get("血小板压积(PCT)")?.numericValue,
      byName.get("淋巴细胞百分比(LYMPH%)")?.numericValue,
    ],
    [5, 5.56, 1.96, 0.23, 49.1],
  );
  assert.equal(rbcLine?.localObservations.length, 2);
  assert.equal(byName.has("血小板体积分布宽度(PDVW)"), false);
  assert.equal(byName.get("平均红细胞血红蛋白浓度(MCHC)")?.unit, null);
  assert.deepEqual(byName.get("白细胞数目(WBC)")?.sourceMap.result.sourceLineIds, [
    "wbc-result",
  ]);
  assert.deepEqual(
    byName.get("中性粒细胞绝对值(NEUT#)")?.sourceMap.result.headerSourceLineIds,
    ["header-6"],
  );
  assert.ok(scalar);
  assert.equal(scalar.candidateRowCount, 4);
  const aiCandidateText = scalar.candidateFacts
    .map((fact) => fact.sourceText)
    .join("\n");
  assert.match(aiCandidateText, /嗜碱性粒细胞百分比/);
  assert.match(aiCandidateText, /中性粒细胞百分比/);
  assert.match(aiCandidateText, /血小板体积分布宽度/);
  assert.doesNotMatch(aiCandidateText, /红细胞数目\(RBC\)/);
});

test("inherits the actual previous-page table-header source ids", () => {
  const rebuilt = rebuildOcrPages([
    page(1, [
      "项目 | 本次结果 | 单位 | 参考范围",
      "总胆固醇 | 5.1 | mmol/L | 0-5.2",
    ]),
    page(2, ["甘油三酯 | 1.2 | mmol/L | 0-1.7"]),
  ]);
  const fact = rebuilt[1].lines.find((line) => line.text.startsWith("甘油三酯"))
    ?.localObservations[0];

  assert.ok(fact);
  assert.deepEqual(fact.sourceMap.result.headerSourceLineIds, ["p1-line-1"]);
  assert.deepEqual(fact.sourceMap.unit?.headerSourceLineIds, ["p1-line-1"]);
  assert.deepEqual(fact.sourceMap.reference?.headerSourceLineIds, [
    "p1-line-1",
  ]);
  assert.equal(fact.sourceMap.result.headerText, "本次结果");
  assert.equal(fact.sourceMap.unit?.headerText, "单位");
  assert.equal(fact.sourceMap.reference?.headerText, "参考范围");
});

test("locally extracts exact dictionary names with a parenthesized code", () => {
  const rebuilt = rebuildOcrPages([
    page(1, [
      "血脂",
      "项目 | 检查结果 | 参考值",
      "动脉硬化指数（AI） | 3.0 | 1.0~4.0",
    ]),
  ]);
  const line = rebuilt[0].lines.find((item) =>
    item.text.startsWith("动脉硬化指数"),
  );
  const fact = line?.localObservations[0];

  assert.ok(line);
  assert.ok(fact);
  assert.equal(fact.normalizedName, "动脉硬化指数");
  assert.equal(fact.numericValue, 3);
  assert.equal(fact.referenceLow, 1);
  assert.equal(fact.referenceHigh, 4);
  assert.equal(fact.sourceMap.result.headerText, "检查结果");
});

test("recognizes pulmonary actual-versus-predicted headers and selects only the actual column", () => {
  const rebuilt = rebuildOcrPages([
    page(1, [
      "肺功能",
      "项目 | 实测 | 预测 | %预测",
      "FVC | 3.21 | 3.80 | 84.5",
    ]),
  ]);
  const line = rebuilt[0].lines.find((item) => item.text.startsWith("FVC"));
  const fact = line?.localObservations[0];

  assert.ok(line);
  assert.equal(line.tableHeaderText, "项目 | 实测 | 预测 | %预测");
  assert.ok(fact);
  assert.equal(fact.numericValue, 3.21);
  assert.notEqual(fact.numericValue, 3.8);
  assert.deepEqual(fact.sourceMap.result.cellIndices, [1]);
  assert.equal(fact.sourceMap.result.headerText, "实测");
  assert.deepEqual(fact.sourceMap.result.headerSourceLineIds, ["p1-line-2"]);
});

test("recognizes split pulmonary headers that only label actual and predicted columns", () => {
  const rebuilt = rebuildOcrPages([
    page(1, ["肺功能", "PRE | 实测 | 预测", "FVC | 3.21 | 3.80 | 84.5"]),
  ]);
  const line = rebuilt[0].lines.find((item) => item.text.startsWith("FVC"));
  const fact = line?.localObservations[0];

  assert.ok(line);
  assert.equal(line.tableHeaderText, "PRE | 实测 | 预测");
  assert.equal(fact?.numericValue, 3.21);
  assert.deepEqual(fact?.sourceMap.result.cellIndices, [1]);
  assert.equal(fact?.sourceMap.result.headerText, "实测");
});

test("splits fully labelled multi-value cells and excludes the source row from scalar AI units", () => {
  const plan = planRebuiltOcrPages(
    "multi-labelled",
    rebuildOcrPages([page(1, ["身高: 170 cm | 体重: 65 kg"])]),
  );
  const line = plan.pages[0].lines[0];

  assert.deepEqual(
    line.localObservations.map((fact) => fact.normalizedName),
    ["身高", "体重"],
  );
  assert.equal(
    new Set(line.localObservations.map((fact) => fact.observationKey)).size,
    2,
  );
  assert.equal(plan.localObservationCount, 2);
  assert.equal(
    plan.units.some(
      (unit) => unit.route === "scalar" && unit.text.includes(line.text),
    ),
    false,
  );
});

test("splits strict item-value pairs without guessing isolated numeric cells", () => {
  const rebuilt = rebuildOcrPages([
    page(1, ["身高 | 170 cm | 体重 | 65 kg", "身高 | 170 | 171 | 172"]),
  ]);
  const paired = rebuilt[0].lines.find((line) =>
    line.text.startsWith("身高 | 170 cm"),
  );
  const ambiguous = rebuilt[0].lines.find(
    (line) => line.text === "身高 | 170 | 171 | 172",
  );

  assert.deepEqual(
    paired?.localObservations.map((fact) => fact.normalizedName),
    ["身高", "体重"],
  );
  assert.equal(ambiguous?.localObservations.length, 0);
  assert.equal(ambiguous?.candidate, true);
});

test("splits bilateral values only when left and right columns align exactly with the header", () => {
  const rebuilt = rebuildOcrPages([
    page(1, [
      "项目 | 结果 | 左 | 右 | 单位 | 参考范围",
      "身高 | | 170 | 171 | cm | 100-220",
    ]),
  ]);
  const line = rebuilt[0].lines.find((item) => item.text.startsWith("身高"));

  assert.deepEqual(
    line?.localObservations.map((fact) => fact.normalizedName),
    ["身高（左）", "身高（右）"],
  );
  assert.equal(
    new Set(line?.localObservations.map((fact) => fact.observationKey)).size,
    2,
  );
  assert.deepEqual(
    line?.localObservations.map((fact) => fact.sourceMap.result.cellIndices),
    [[2], [3]],
  );
  assert.deepEqual(
    line?.localObservations.map(
      (fact) => fact.sourceMap.qualifier?.headerSourceLineIds,
    ),
    [["p1-line-1"], ["p1-line-1"]],
  );
});

test("does not infer a current observation when all result columns are historical", () => {
  const rebuilt = rebuildOcrPages([
    page(1, [
      "项目 | 历史结果 | 上次结果 | 单位",
      "总胆固醇 | 5.1 | 5.2 | mmol/L",
    ]),
  ]);
  const line = rebuilt[0].lines.find((item) =>
    item.text.startsWith("总胆固醇"),
  );

  assert.equal(line?.localObservations.length, 0);
  assert.equal(line?.candidate, true);
});

test("prefers the explicit current-result column and never emits the history value", () => {
  const rebuilt = rebuildOcrPages([
    page(1, [
      "项目 | 历史结果 | 本次结果 | 单位 | 参考范围",
      "总胆固醇 | 5.0 | 5.3 | mmol/L | 0-5.2",
    ]),
  ]);
  const facts =
    rebuilt[0].lines.find((item) => item.text.startsWith("总胆固醇"))
      ?.localObservations || [];

  assert.equal(facts.length, 1);
  assert.equal(facts[0].resultText, "5.3");
  assert.deepEqual(facts[0].sourceMap.result.cellIndices, [2]);
});

test("repairs only OCR decimal-point whitespace inside numeric tokens", () => {
  const rebuilt = rebuildOcrPages([
    page(1, ["FEV1/FVC | 0. 42", "普通说明. 42 天后复查"]),
  ]);

  assert.equal(
    rebuilt[0].lines.some((line) => line.text === "FEV1/FVC | 0.42"),
    true,
  );
  assert.equal(
    rebuilt[0].lines.some((line) => line.text === "普通说明. 42 天后复查"),
    true,
  );
});

test("recognizes body-composition report headings and resets inherited report context", () => {
  const rebuilt = rebuildOcrPages([
    page(1, ["骨密度检查报告", "T值 | -1.0"]),
    page(2, ["人体成份分析报告", "肌肉量：52 kg"]),
  ]);
  const measurement = rebuilt[1].lines.find((line) =>
    line.text.startsWith("肌肉量"),
  );

  assert.equal(measurement?.reportSectionName, "人体成份分析报告");
  assert.equal(measurement?.sectionName, "人体成份分析报告");
  assert.equal(measurement?.localObservations[0]?.itemName, "肌肉量");
  assert.equal(measurement?.localObservations[0]?.unit, "kg");
});

test("filters strict administrative presets and misaligned gender metadata rows", () => {
  const rebuilt = rebuildOcrPages([
    page(1, ["门诊 | P 12.5", "性别 | 168 | 调节"]),
  ]);

  for (const line of rebuilt[0].lines) {
    assert.equal(line.candidate, false, line.text);
    assert.equal(line.contentRole, "metadata", line.text);
    assert.equal(line.candidateResolutionReason, "filtered_noise", line.text);
  }
});

test("merges strict negative ultrasound continuations instead of creating a positive fragment", () => {
  const rebuilt = rebuildOcrPages([
    page(1, ["超声检查报告", "肝胆检查未见胆", "管扩张，未见异常血流信号"]),
  ]);
  const merged = rebuilt[0].lines.find((line) =>
    line.text.includes("未见胆管扩张"),
  );

  assert.ok(merged);
  assert.equal(merged.candidateKind, null);
  assert.equal(
    rebuilt[0].lines.some((line) => line.text.startsWith("管扩张")),
    false,
  );
});

test("keeps independent ultrasound conclusions separate from following negative organs", () => {
  const rebuilt = rebuildOcrPages([
    page(18, [
      "超声检查报告",
      "超声提示：",
      "脂肪肝（轻度）",
      "肝右叶局灶性钙化灶",
      "胆、胰、脾、肾目前未见明显占位性病变",
      "前列腺未见明显异常",
      "双叶甲状腺未见明显异常，C-TIRADS 1类",
    ]),
  ]);
  const lines = rebuilt[0].lines;
  const calcification = lines.find(
    (line) => line.text === "肝右叶局灶性钙化灶",
  );

  assert.ok(calcification);
  assert.deepEqual(calcification.sourceLineIds, ["p18-line-4"]);
  assert.equal(calcification.candidateKind, "morphology");
  assert.equal(
    lines.some((line) => line.text.includes("钙化灶胆、胰、脾、肾")),
    false,
  );
  for (const negativeText of [
    "胆、胰、脾、肾目前未见明显占位性病变",
    "前列腺未见明显异常",
    "双叶甲状腺未见明显异常，C-TIRADS 1类",
  ]) {
    const negative = lines.find((line) => line.text === negativeText);
    assert.ok(negative, negativeText);
    assert.equal(negative.candidateKind, null, negativeText);
    assert.deepEqual(negative.localObservations, [], negativeText);
  }
  assert.deepEqual(
    lines
      .filter((line) => line.candidateKind === "morphology")
      .map((line) => line.text),
    ["脂肪肝（轻度）", "肝右叶局灶性钙化灶"],
  );
});

test("requires a short time unit to follow its numeric result", () => {
  const rebuilt = rebuildOcrPages([
    page(1, [
      "APTT | 30.2 | s | 25.0-35.0",
      "双叶甲状腺未见明显异常，C-TIRADS 1类",
    ]),
  ]);
  assert.equal(rebuilt[0].lines[0].candidateKind, "scalar");
  assert.equal(rebuilt[0].lines[0].dictionaryFacts[0]?.canonicalKey, "coagulation_aptt");
  assert.equal(rebuilt[0].lines[1].candidateKind, null);
});

test("closes real page 4 scalars and keeps page 18 ultrasound evidence clean", () => {
  const golden = JSON.parse(
    readFileSync(
      new URL(
        "./fixtures/p3-ultrasound-summary-detail-planner-golden.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as {
    source: {
      reportId: string;
      patientSex: "male" | "female";
      pages: Array<{
        pageId: string;
        pageNumber: number;
        lines: Array<{
          id: string;
          text: string;
          confidence: number;
          box: unknown;
          variant?: string;
        }>;
      }>;
    };
    expected: {
      localObservationCount: number;
      unresolvedScalarCandidateCount: number;
      observations: Array<{
        sourceLineId: string;
        normalizedName: string;
        numericValue: number;
        unit: string;
        referenceLow: number | null;
        referenceHigh: number | null;
        abnormalFlag: string | null;
      }>;
      morphologyCandidates: Array<{
        pageNumber: number;
        sourceLineIds: string[];
        text: string;
      }>;
      filteredNegativeConclusions: Array<{
        sourceLineId: string;
        text: string;
      }>;
      prohibitedMorphologyAiTexts: string[];
      excludedDictionaryCanonicalKeys: string[];
    };
  };
  const rebuilt = rebuildOcrPages(
    golden.source.pages.map((sourcePage) => ({
      pageId: sourcePage.pageId,
      pageNumber: sourcePage.pageNumber,
      linesJson: JSON.stringify(sourcePage.lines),
    })),
    { patientSex: golden.source.patientSex },
  );
  const allLines = rebuilt.flatMap((sourcePage) => sourcePage.lines);
  const observations = allLines.flatMap((line) => line.localObservations);

  assert.equal(
    observations.length,
    golden.expected.localObservationCount,
    "真实第 4 页全部明确 scalar 应在 Planner 本地闭环",
  );
  for (const expected of golden.expected.observations) {
    const fact = observations.find(
      (observation) =>
        observation.sourceLineId.includes(expected.sourceLineId) &&
        observation.normalizedName === expected.normalizedName,
    );
    assert.ok(fact, `${expected.sourceLineId}/${expected.normalizedName}`);
    assert.deepEqual(
      {
        numericValue: fact.numericValue,
        unit: fact.unit,
        referenceLow: fact.referenceLow,
        referenceHigh: fact.referenceHigh,
        abnormalFlag: fact.abnormalFlag,
      },
      {
        numericValue: expected.numericValue,
        unit: expected.unit,
        referenceLow: expected.referenceLow,
        referenceHigh: expected.referenceHigh,
        abnormalFlag: expected.abnormalFlag,
      },
    );
  }

  const actualMorphology = rebuilt.flatMap((sourcePage) =>
    sourcePage.lines
      .filter((line) => line.candidateKind === "morphology")
      .map((line) => ({
        pageNumber: sourcePage.pageNumber,
        sourceLineIds: line.sourceLineIds,
        text: line.text,
      })),
  );
  assert.deepEqual(actualMorphology, golden.expected.morphologyCandidates);

  const ultrasoundPage = rebuilt.find(
    (sourcePage) => sourcePage.pageNumber === 18,
  );
  assert.ok(ultrasoundPage);
  for (const expected of golden.expected.filteredNegativeConclusions) {
    const negativeLine: (typeof ultrasoundPage.lines)[number] | undefined =
      ultrasoundPage.lines.find(
        (entry) =>
          entry.sourceLineIds.includes(expected.sourceLineId) &&
          entry.text === expected.text,
      );
    assert.ok(negativeLine, `${expected.sourceLineId}/${expected.text}`);
    assert.equal(negativeLine.candidate, false, expected.text);
    assert.equal(negativeLine.candidateKind, null, expected.text);
    assert.deepEqual(negativeLine.localObservations, [], expected.text);
  }

  for (const canonicalKey of golden.expected.excludedDictionaryCanonicalKeys) {
    assert.equal(
      allLines.some((line) =>
        line.dictionaryFacts.some((fact) => fact.canonicalKey === canonicalKey),
      ),
      false,
      `${canonicalKey} 不得由“富钾饮食/钙化灶”误触发`,
    );
  }

  const plan = planRebuiltOcrPages(golden.source.reportId, rebuilt);
  const unresolvedScalar = plan.units.flatMap((unit) =>
    unit.candidateFacts.filter((fact) => fact.kind === "scalar"),
  );
  assert.equal(
    unresolvedScalar.length,
    golden.expected.unresolvedScalarCandidateCount,
  );
  const morphologyUnit = plan.units.find((unit) => unit.route === "morphology");
  assert.ok(morphologyUnit);
  assert.equal(
    morphologyUnit.candidateFacts.length,
    golden.expected.morphologyCandidates.length,
  );
  for (const prohibited of golden.expected.prohibitedMorphologyAiTexts) {
    assert.doesNotMatch(
      morphologyUnit.text,
      new RegExp(prohibited.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      `负性器官结论不得污染 morphology AI 输入：${prohibited}`,
    );
  }
  assert.match(morphologyUnit.text, /肝右叶见强回声区，直径约5mm/);
  assert.match(morphologyUnit.text, /脂肪肝（轻度）/);
  assert.match(morphologyUnit.text, /肝右叶局灶性钙化灶/);
});

test("keeps normal grade-one imaging statements negative but retains real lesions", () => {
  const negative = rebuildOcrPages([
    page(1, ["超声检查报告", "未见明显异常", "C-TIRADS 1类"]),
  ]);
  const sameLineNegative = rebuildOcrPages([
    page(1, ["超声检查报告", "双侧检查正常，C-TIRADS 1类"]),
  ]);
  const positive = rebuildOcrPages([
    page(1, ["超声检查报告", "可见甲状腺结节，C-TIRADS 1类"]),
  ]);

  assert.equal(
    negative[0].lines.some((line) => line.candidateKind === "morphology"),
    false,
  );
  assert.equal(
    sameLineNegative[0].lines.some(
      (line) => line.candidateKind === "morphology",
    ),
    false,
  );
  assert.equal(
    positive[0].lines.some((line) => line.candidateKind === "morphology"),
    true,
  );
});

test("filters an unqualified body-fat segment without suppressing explicit totals", () => {
  const rebuilt = rebuildOcrPages([
    page(1, [
      "人体成分分析报告",
      "脂肪：3.2 kg",
      "体脂肪量：18.4 kg",
      "除脂肪量：54.6 kg",
    ]),
  ]);
  const segment = rebuilt[0].lines.find((line) => line.text.startsWith("脂肪"));
  const explicitTotal = rebuilt[0].lines.find((line) =>
    line.text.startsWith("体脂肪量"),
  );
  const safeTotal = rebuilt[0].lines.find((line) =>
    line.text.startsWith("除脂肪量"),
  );

  assert.equal(segment?.candidate, false);
  assert.equal(segment?.candidateKind, null);
  assert.equal(segment?.candidateResolutionReason, "filtered_noise");
  assert.equal(segment?.localObservations.length, 0);
  assert.notEqual(explicitTotal?.candidateResolutionReason, "filtered_noise");
  assert.equal(explicitTotal?.localObservations[0]?.itemName, "体脂肪量");
  assert.equal(safeTotal?.localObservations[0]?.itemName, "除脂肪量");
});

test("filters body-composition score and age-standard reference rows from family trends", () => {
  const rebuilt = rebuildOcrPages([
    page(1, [
      "人体成分分析报告",
      "成人体脂率标准 10-20% | 测试意见：正常 | 综合得分：88",
      "成人体脂率标准 10-20% | 测试意见：正常 | 综合得分：108",
    ]),
  ]);

  for (const line of rebuilt[0].lines.filter((item) =>
    item.text.includes("综合得分"),
  )) {
    assert.equal(line.candidate, false);
    assert.equal(line.candidateResolutionReason, "filtered_noise");
    assert.deepEqual(line.localObservations, []);
  }
});

test("reads H and L only from an explicit abnormal-marker column", () => {
  const rebuilt = rebuildOcrPages([
    page(1, [
      "【血常规】",
      "项目 | 本次结果 | 单位 | 参考范围 | 异常标记",
      "白细胞计数 | 11.2 | 10^9/L | 3.5~9.5 | H",
      "红细胞计数 | 3.2 | 10^12/L | 3.8~5.1 | L",
    ]),
  ]);
  const white = rebuilt[0].lines.find((line) =>
    line.text.startsWith("白细胞计数"),
  )?.localObservation;
  const red = rebuilt[0].lines.find((line) =>
    line.text.startsWith("红细胞计数"),
  )?.localObservation;

  assert.equal(white?.abnormalFlag, "high");
  assert.equal(red?.abnormalFlag, "low");
});

test("does not infer reference bounds from historical predicted target or device-range columns", () => {
  for (const unsafeHeader of [
    "历史结果",
    "预测值",
    "目标值",
    "仪器范围",
    "检测范围",
  ]) {
    const rebuilt = rebuildOcrPages([
      page(1, [
        `项目 | 本次结果 | ${unsafeHeader}`,
        "总胆固醇 | 5.3 | 1.0-4.0",
      ]),
    ]);
    const fact = rebuilt[0].lines.find((line) =>
      line.text.startsWith("总胆固醇"),
    )?.localObservations[0];

    assert.ok(fact, unsafeHeader);
    assert.equal(fact.referenceLow, null, unsafeHeader);
    assert.equal(fact.referenceHigh, null, unsafeHeader);
    assert.equal(fact.referenceText, null, unsafeHeader);
    assert.equal(fact.sourceMap.reference, undefined, unsafeHeader);
  }
});

test("accepts explicit and unlabeled strict reference shapes but rejects reversed bounds", () => {
  const explicit = rebuildOcrPages([
    page(1, [
      "项目 | 本次结果 | 参考范围",
      "总胆固醇 | 5.3 | 1.0-5.2",
      "甘油三酯 | 1.2 | <1.7",
    ]),
  ]);
  const cholesterol = explicit[0].lines.find((line) =>
    line.text.startsWith("总胆固醇"),
  )?.localObservations[0];
  const triglyceride = explicit[0].lines.find((line) =>
    line.text.startsWith("甘油三酯"),
  )?.localObservations[0];
  assert.deepEqual(
    cholesterol && [cholesterol.referenceLow, cholesterol.referenceHigh],
    [1, 5.2],
  );
  assert.deepEqual(
    triglyceride && [triglyceride.referenceLow, triglyceride.referenceHigh],
    [null, 1.7],
  );

  const unlabeled = rebuildOcrPages([
    page(1, ["总胆固醇 | 5.3 | 1.0-5.2", "甘油三酯 | 1.2 | 5.0-1.0"]),
  ]);
  const unlabeledCholesterol = unlabeled[0].lines.find((line) =>
    line.text.startsWith("总胆固醇"),
  )?.localObservations[0];
  const reversed = unlabeled[0].lines.find((line) =>
    line.text.startsWith("甘油三酯"),
  )?.localObservations[0];
  assert.deepEqual(
    unlabeledCholesterol && [
      unlabeledCholesterol.referenceLow,
      unlabeledCholesterol.referenceHigh,
    ],
    [1, 5.2],
  );
  assert.deepEqual(
    reversed && [reversed.referenceLow, reversed.referenceHigh],
    [null, null],
  );
  assert.equal(reversed?.referenceText, "5.0-1.0");
});

test("restores a dictionary indicator split across real PDF text lines", () => {
  const golden = JSON.parse(
    readFileSync(
      new URL(
        "./fixtures/p3-cross-line-indicator-continuation-golden.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as {
    source: {
      pageNumber: number;
      lines: Array<{
        id: string;
        text: string;
        confidence: number;
        box: number[];
      }>;
    };
    expected: {
      mergedSourceLineIds: string[];
      mergedTextFragment: string;
      dictionaryKeys: string[];
      observations: Array<{
        normalizedName: string;
        numericValue: number;
        unit: string;
        referenceLow: number | null;
        referenceHigh: number | null;
        abnormalFlag: string;
      }>;
    };
  };
  const rebuilt = rebuildOcrPages([
    {
      pageId: "real-pdf-page-4",
      pageNumber: golden.source.pageNumber,
      linesJson: JSON.stringify(golden.source.lines),
    },
  ]);
  const merged = rebuilt[0].lines.find((line) =>
    golden.expected.mergedSourceLineIds.every((id) =>
      line.sourceLineIds.includes(id),
    ),
  );

  assert.ok(merged);
  assert.deepEqual(merged.sourceLineIds, golden.expected.mergedSourceLineIds);
  assert.ok(merged.text.includes(golden.expected.mergedTextFragment));
  assert.equal(
    rebuilt[0].lines.some(
      (line) => line.sourceLineIds.length === 1 && line.text.startsWith("醇值"),
    ),
    false,
  );
  assert.deepEqual(
    merged.dictionaryFacts.map((fact) => fact.canonicalKey).sort(),
    [...golden.expected.dictionaryKeys].sort(),
  );
  assert.deepEqual(
    merged.localObservations.map((fact) => ({
      normalizedName: fact.normalizedName,
      numericValue: fact.numericValue,
      unit: fact.unit,
      referenceLow: fact.referenceLow,
      referenceHigh: fact.referenceHigh,
      abnormalFlag: fact.abnormalFlag,
    })),
    golden.expected.observations,
  );
  assert.ok(
    merged.localObservations.every((fact) =>
      golden.expected.mergedSourceLineIds.every((id) =>
        fact.sourceMap.result.sourceLineIds.includes(id),
      ),
    ),
  );
});

test("does not merge adjacent prose, section boundaries, or incomplete measurements", () => {
  const rebuilt = rebuildOcrPages([
    page(1, [
      "内分泌",
      "代谢科随诊。",
      "建议优生优",
      "育科做备孕评估。",
      "低密度脂蛋白胆固",
      "【肝胆功能】",
      "低密度脂蛋白胆固",
      "醇值偏高，建议复查。",
    ]),
  ]);

  assert.equal(
    rebuilt[0].lines.some((line) => line.sourceLineIds.length > 1),
    false,
  );
  assert.equal(rebuilt[0].localObservationCount, 0);
});

test("locally closes real page 10 hemorheology indices with stable canonical names", () => {
  const golden = JSON.parse(
    readFileSync(
      new URL(
        "./fixtures/p3-hemorheology-index-planner-golden.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as {
    source: {
      reportId: string;
      pageNumber: number;
      lines: Array<{
        id: string;
        text: string;
        confidence: number;
        box: unknown;
      }>;
    };
    expected: {
      sectionName: string;
      tableHeaderText: string;
      observations: Array<{
        canonicalKey: string;
        normalizedName: string;
        sourceText: string;
        numericValue: number;
        unit: null;
        referenceLow: number;
        referenceHigh: number;
        itemSourceLineId: string;
        resultSourceLineId: string;
        referenceSourceLineId: string;
      }>;
    };
  };
  const rebuilt = rebuildOcrPages([
    {
      pageId: "real-hemorheology-page-10",
      pageNumber: golden.source.pageNumber,
      linesJson: JSON.stringify(golden.source.lines),
    },
  ]);
  const hemorheologyPage = rebuilt[0];

  for (const expected of golden.expected.observations) {
    const line = hemorheologyPage.lines.find(
      (entry) => entry.text === expected.sourceText,
    );
    assert.ok(line, `真实血液流变行未重建：${expected.sourceText}`);
    assert.equal(line.sectionName, golden.expected.sectionName);
    assert.equal(line.tableHeaderText, golden.expected.tableHeaderText);
    assert.equal(
      line.dictionaryFacts.some(
        (fact) => fact.canonicalKey === expected.canonicalKey,
      ),
      true,
      expected.sourceText,
    );
    assert.equal(line.localObservations.length, 1, expected.sourceText);
    const observation = line.localObservations[0];
    assert.deepEqual(
      [
        observation.normalizedName,
        observation.numericValue,
        observation.unit,
        observation.referenceLow,
        observation.referenceHigh,
      ],
      [
        expected.normalizedName,
        expected.numericValue,
        expected.unit,
        expected.referenceLow,
        expected.referenceHigh,
      ],
      expected.sourceText,
    );
    assert.deepEqual(observation.sourceMap.item.sourceLineIds, [
      expected.itemSourceLineId,
    ]);
    assert.deepEqual(observation.sourceMap.result.sourceLineIds, [
      expected.resultSourceLineId,
    ]);
    assert.deepEqual(observation.sourceMap.reference?.sourceLineIds, [
      expected.referenceSourceLineId,
    ]);
  }

  const plan = planRebuiltOcrPages(golden.source.reportId, rebuilt);
  const aiCandidateTexts = plan.units.flatMap((unit) =>
    unit.candidateFacts.map((fact) => fact.sourceText),
  );
  for (const expected of golden.expected.observations) {
    assert.equal(
      aiCandidateTexts.includes(expected.sourceText),
      false,
      `${expected.sourceText} 已本地闭环，不应进入 AI 补提取`,
    );
  }
});

test("locally closes real ECG measurements with stable canonical units and source evidence", () => {
  const golden = JSON.parse(
    readFileSync(
      new URL(
        "./fixtures/p3-ecg-measurement-planner-golden.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as {
    source: {
      reportId: string;
      pageNumber: number;
      lines: Array<{
        id: string;
        text: string;
        confidence: number;
        box: unknown;
      }>;
    };
    expected: {
      sectionName: string;
      observations: Array<{
        canonicalKey: string;
        normalizedName: string;
        sourceText: string;
        numericValue: number;
        sourceUnit: string;
        canonicalUnit: string;
        itemSourceLineId: string;
        resultSourceLineId: string;
        unitSourceLineId: string;
      }>;
    };
  };
  const rebuilt = rebuildOcrPages([
    {
      pageId: "real-ecg-page",
      pageNumber: golden.source.pageNumber,
      linesJson: JSON.stringify(golden.source.lines),
    },
  ]);
  const ecgPage = rebuilt[0];

  for (const expected of golden.expected.observations) {
    const line = ecgPage.lines.find(
      (entry) => entry.text === expected.sourceText,
    );
    assert.ok(line, `真实 ECG 行未重建：${expected.sourceText}`);
    assert.equal(line.sectionName, golden.expected.sectionName);
    assert.equal(line.localObservations.length, 1, expected.sourceText);
    const observation = line.localObservations[0];
    assert.deepEqual(
      [
        observation.normalizedName,
        observation.numericValue,
        observation.unit,
        observation.referenceLow,
        observation.referenceHigh,
      ],
      [
        expected.normalizedName,
        expected.numericValue,
        expected.sourceUnit,
        null,
        null,
      ],
      expected.sourceText,
    );
    assert.deepEqual(observation.sourceMap.item.sourceLineIds, [
      expected.itemSourceLineId,
    ]);
    assert.deepEqual(observation.sourceMap.result.sourceLineIds, [
      expected.resultSourceLineId,
    ]);
    assert.deepEqual(observation.sourceMap.unit?.sourceLineIds, [
      expected.unitSourceLineId,
    ]);
    const catalog = getDatabase()
      .prepare(
        `SELECT canonical_key AS canonicalKey, default_unit AS defaultUnit
         FROM indicator_catalog WHERE display_name = ?`,
      )
      .get(observation.normalizedName) as
      { canonicalKey: string; defaultUnit: string | null } | undefined;
    assert.deepEqual(
      [catalog?.canonicalKey, catalog?.defaultUnit],
      [expected.canonicalKey, expected.canonicalUnit],
      expected.sourceText,
    );
  }

  const plan = planRebuiltOcrPages(golden.source.reportId, rebuilt);
  const aiCandidateTexts = plan.units.flatMap((unit) =>
    unit.candidateFacts.map((fact) => fact.sourceText),
  );
  for (const expected of golden.expected.observations) {
    assert.equal(
      aiCandidateTexts.includes(expected.sourceText),
      false,
      `${expected.sourceText} 已本地闭环，不应进入 AI 补提取`,
    );
  }
});

test("locally closes the real 13C breath-test DOB tuple and named thresholds", () => {
  const golden = JSON.parse(
    readFileSync(
      new URL("./fixtures/p3-breath-test-planner-golden.json", import.meta.url),
      "utf8",
    ),
  ) as {
    source: {
      reportId: string;
      pageNumber: number;
      lines: Array<{
        id: string;
        text: string;
        confidence: number;
        box: unknown;
      }>;
    };
    expected: {
      sectionName: string;
      quantitative: {
        canonicalKey: string;
        normalizedName: string;
        sourceText: string;
        itemName: string;
        resultText: string;
        numericValue: number;
        sourceUnit: null;
        canonicalUnit: string;
        abnormalFlag: "normal";
        referenceLow: null;
        referenceHigh: number;
        referenceText: string;
        itemSourceLineIds: string[];
        resultSourceLineIds: string[];
        referenceSourceLineIds: string[];
      };
      categorical: {
        canonicalKey: string;
        normalizedName: string;
        sourceText: string;
        itemName: string;
        resultText: string;
        numericValue: null;
        unit: null;
        abnormalFlag: "normal";
        sourceLineIds: string[];
      };
    };
  };
  const rebuilt = rebuildOcrPages([
    {
      pageId: "real-breath-test-page-20",
      pageNumber: golden.source.pageNumber,
      linesJson: JSON.stringify(golden.source.lines),
    },
  ]);
  const breathTestPage = rebuilt[0];
  assert.equal(breathTestPage.localObservationCount, 2);

  const quantitativeLine = breathTestPage.lines.find(
    (line) => line.text === golden.expected.quantitative.sourceText,
  );
  assert.ok(quantitativeLine);
  assert.equal(quantitativeLine.sectionName, golden.expected.sectionName);
  assert.equal(quantitativeLine.localObservations.length, 1);
  const quantitative = quantitativeLine.localObservations[0];
  assert.deepEqual(
    {
      itemName: quantitative.itemName,
      normalizedName: quantitative.normalizedName,
      resultText: quantitative.resultText,
      numericValue: quantitative.numericValue,
      unit: quantitative.unit,
      abnormalFlag: quantitative.abnormalFlag,
      referenceLow: quantitative.referenceLow,
      referenceHigh: quantitative.referenceHigh,
      referenceText: quantitative.referenceText,
    },
    {
      itemName: golden.expected.quantitative.itemName,
      normalizedName: golden.expected.quantitative.normalizedName,
      resultText: golden.expected.quantitative.resultText,
      numericValue: golden.expected.quantitative.numericValue,
      unit: golden.expected.quantitative.sourceUnit,
      abnormalFlag: golden.expected.quantitative.abnormalFlag,
      referenceLow: golden.expected.quantitative.referenceLow,
      referenceHigh: golden.expected.quantitative.referenceHigh,
      referenceText: golden.expected.quantitative.referenceText,
    },
  );
  assert.deepEqual(
    quantitative.sourceMap.item.sourceLineIds,
    golden.expected.quantitative.itemSourceLineIds,
  );
  assert.deepEqual(
    quantitative.sourceMap.result.sourceLineIds,
    golden.expected.quantitative.resultSourceLineIds,
  );
  assert.deepEqual(
    quantitative.sourceMap.reference?.sourceLineIds,
    golden.expected.quantitative.referenceSourceLineIds,
  );

  const categoricalLine = breathTestPage.lines.find(
    (line) => line.text === golden.expected.categorical.sourceText,
  );
  assert.ok(categoricalLine);
  assert.equal(categoricalLine.sectionName, golden.expected.sectionName);
  assert.equal(categoricalLine.localObservations.length, 1);
  const categorical = categoricalLine.localObservations[0];
  assert.deepEqual(
    {
      itemName: categorical.itemName,
      normalizedName: categorical.normalizedName,
      resultText: categorical.resultText,
      numericValue: categorical.numericValue,
      unit: categorical.unit,
      abnormalFlag: categorical.abnormalFlag,
    },
    {
      itemName: golden.expected.categorical.itemName,
      normalizedName: golden.expected.categorical.normalizedName,
      resultText: golden.expected.categorical.resultText,
      numericValue: golden.expected.categorical.numericValue,
      unit: golden.expected.categorical.unit,
      abnormalFlag: golden.expected.categorical.abnormalFlag,
    },
  );
  assert.deepEqual(
    categorical.sourceMap.item.sourceLineIds,
    golden.expected.categorical.sourceLineIds,
  );
  assert.equal(
    categoricalLine.dictionaryFacts.some(
      (fact) => fact.canonicalKey === golden.expected.categorical.canonicalKey,
    ),
    true,
  );

  const quantitativeCatalog = getDatabase()
    .prepare(
      `SELECT canonical_key AS canonicalKey, default_unit AS defaultUnit
       FROM indicator_catalog WHERE display_name = ?`,
    )
    .get(quantitative.normalizedName) as
    { canonicalKey: string; defaultUnit: string | null } | undefined;
  assert.deepEqual(
    [quantitativeCatalog?.canonicalKey, quantitativeCatalog?.defaultUnit],
    [
      golden.expected.quantitative.canonicalKey,
      golden.expected.quantitative.canonicalUnit,
    ],
  );
  const categoricalCatalog = getDatabase()
    .prepare(
      `SELECT canonical_key AS canonicalKey
       FROM indicator_catalog WHERE display_name = ?`,
    )
    .get(categorical.normalizedName) as { canonicalKey: string } | undefined;
  assert.equal(
    categoricalCatalog?.canonicalKey,
    golden.expected.categorical.canonicalKey,
  );

  const plan = planRebuiltOcrPages(golden.source.reportId, rebuilt);
  assert.equal(plan.localObservationCount, 2);
  assert.equal(
    plan.units.some((unit) =>
      unit.candidateFacts.some(
        (fact) => fact.pageNumber === golden.source.pageNumber,
      ),
    ),
    false,
    "第 20 页两个已闭环事实均不得再进入 AI candidateFacts",
  );
});

test("filters real pulmonary device-derived rows before AI while retaining core indicators", () => {
  const golden = JSON.parse(
    readFileSync(
      new URL(
        "./fixtures/p3-pulmonary-device-parameter-planner-golden.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as {
    source: {
      pageNumber: number;
      lines: Array<{
        id: string;
        text: string;
        confidence: number;
        box: unknown;
      }>;
    };
    expected: {
      filteredRows: string[];
      retainedCanonicalKeys: string[];
      recoveredObservation: {
        canonicalKey: string;
        sourceText: string;
        numericValue: number;
        itemSourceLineId: string;
        resultSourceLineId: string;
        detachedAxisSourceLineId: string;
      };
    };
  };
  const rebuilt = rebuildOcrPages([
    {
      pageId: "real-pulmonary-page-22",
      pageNumber: golden.source.pageNumber,
      linesJson: JSON.stringify(golden.source.lines),
    },
  ]);
  const pulmonaryPage = rebuilt[0];

  for (const itemName of golden.expected.filteredRows) {
    const line = pulmonaryPage.lines.find(
      (entry) =>
        entry.text === itemName || entry.text.startsWith(`${itemName} |`),
    );
    assert.ok(line, `真实肺功能行未重建：${itemName}`);
    assert.equal(line.candidate, false, line.text);
    assert.equal(line.candidateKind, null, line.text);
    assert.equal(line.role, "noise", line.text);
    assert.equal(line.contentRole, "environment", line.text);
    assert.equal(line.candidateResolutionReason, "filtered_noise", line.text);
    assert.deepEqual(line.dictionaryFacts, [], line.text);
    assert.deepEqual(line.localObservations, [], line.text);
  }

  const retainedKeys = new Set(
    pulmonaryPage.lines.flatMap((line) =>
      line.localObservations.map(
        (fact) =>
          line.dictionaryFacts.find(
            (candidate) => candidate.displayName === fact.normalizedName,
          )?.canonicalKey,
      ),
    ),
  );
  for (const canonicalKey of golden.expected.retainedCanonicalKeys) {
    assert.equal(
      retainedKeys.has(canonicalKey),
      true,
      `核心肺功能指标被误过滤：${canonicalKey}`,
    );
  }

  const recovered = golden.expected.recoveredObservation;
  const recoveredLine = pulmonaryPage.lines.find((line) =>
    line.sourceLineIds.includes(recovered.itemSourceLineId),
  );
  assert.ok(recoveredLine, "真实 FVC 指标行未重建");
  assert.equal(recoveredLine.text, recovered.sourceText);
  assert.equal(recoveredLine.candidate, true);
  assert.equal(
    recoveredLine.dictionaryFacts.some(
      (fact) => fact.canonicalKey === recovered.canonicalKey,
    ),
    true,
  );
  assert.equal(
    recoveredLine.sourceLineIds.includes(recovered.resultSourceLineId),
    true,
  );
  assert.equal(
    recoveredLine.sourceLineIds.includes(recovered.detachedAxisSourceLineId),
    false,
    "图表刻度不得并入 FVC 数据行",
  );
  const recoveredFact = recoveredLine.localObservations.find(
    (fact) => fact.numericValue === recovered.numericValue,
  );
  assert.ok(recoveredFact, "FVC 实测值必须恢复为 3.63");
  assert.deepEqual(recoveredFact.sourceMap.item.sourceLineIds, [
    recovered.itemSourceLineId,
  ]);
  assert.deepEqual(recoveredFact.sourceMap.result.sourceLineIds, [
    recovered.resultSourceLineId,
  ]);
  assert.equal(
    recoveredFact.sourceMap.result.sourceLineIds.includes(
      recovered.detachedAxisSourceLineId,
    ),
    false,
  );

  const detachedAxis = pulmonaryPage.lines.find(
    (line) =>
      line.sourceLineIds.length === 1 &&
      line.sourceLineIds[0] === recovered.detachedAxisSourceLineId,
  );
  assert.ok(detachedAxis, "远右图表刻度必须保留为独立审计证据");
  assert.equal(detachedAxis.text, "80");
  assert.equal(detachedAxis.candidate, false);
  assert.equal(detachedAxis.role, "noise");
  assert.equal(detachedAxis.contentRole, "chart_axis");
  assert.equal(detachedAxis.candidateResolutionReason, "filtered_noise");
  assert.deepEqual(detachedAxis.localObservations, []);

  const fef7585 = pulmonaryPage.lines.find((line) =>
    line.text.startsWith("FEF75-85 |"),
  );
  assert.ok(fef7585);
  assert.equal(
    fef7585.dictionaryFacts.some(
      (fact) => fact.canonicalKey === "pulmonary_fef75",
    ),
    false,
    "FEF75-85 不得再因 FEF75 子串生成错误趋势 observation",
  );

  const plan = planRebuiltOcrPages("real-pulmonary-report", rebuilt);
  const aiCandidateTexts = plan.units.flatMap((unit) =>
    unit.candidateFacts.map((fact) => fact.sourceText),
  );
  for (const itemName of golden.expected.filteredRows) {
    assert.equal(
      aiCandidateTexts.some(
        (text) => text === itemName || text.startsWith(`${itemName} |`),
      ),
      false,
      `${itemName} 不得进入任何 AI candidateFacts`,
    );
  }
});

test("locally closes the real TCD sparse matrix and filters duplicated device evidence", () => {
  const golden = JSON.parse(
    readFileSync(
      new URL("./fixtures/p3-tcd-planner-golden.json", import.meta.url),
      "utf8",
    ),
  ) as {
    source: {
      reportId: string;
      pageNumber: number;
      lines: Array<{
        id: string;
        text: string;
        confidence: number;
        box: unknown;
      }>;
    };
    expected: {
      tableHeader: { text: string; sourceLineIds: string[] };
      observations: Array<{
        itemName: string;
        normalizedName: string;
        canonicalKey: string;
        numericValue: number;
        sourceUnit: string | null;
        canonicalUnit: string | null;
        itemSourceLineId: string;
        resultSourceLineId: string;
        resultHeaderSourceLineId: string;
        resultHeaderText: string;
      }>;
      devicePanelRows: string[];
      chartAxisRows: Array<{ text: string; sourceLineIds: string[] }>;
      strippedNarrative: {
        text: string;
        sourceLineIds: string[];
        removedGraphicSourceLineId: string;
      };
      unresolvedScalarCandidateCount: number;
    };
  };

  const rebuilt = rebuildOcrPages([
    {
      pageId: "real-tcd-page-21",
      pageNumber: golden.source.pageNumber,
      linesJson: JSON.stringify(golden.source.lines),
    },
  ]);
  const tcdPage = rebuilt[0];
  const tableHeader = tcdPage.lines.find(
    (line) => line.boundary === "table_header",
  );
  assert.ok(tableHeader, "真实 TCD 多列表头必须被识别");
  assert.equal(tableHeader.text, golden.expected.tableHeader.text);
  assert.deepEqual(
    tableHeader.sourceLineIds,
    golden.expected.tableHeader.sourceLineIds,
  );

  const observations = tcdPage.lines.flatMap((line) =>
    line.localObservations.map((observation) => ({ line, observation })),
  );
  assert.equal(observations.length, golden.expected.observations.length);
  for (const expected of golden.expected.observations) {
    const found = observations.find(
      ({ observation }) => observation.itemName === expected.itemName,
    );
    assert.ok(found, `TCD 核心指标未闭环：${expected.itemName}`);
    assert.deepEqual(
      {
        normalizedName: found.observation.normalizedName,
        numericValue: found.observation.numericValue,
        unit: found.observation.unit,
        itemSourceLineIds: found.observation.sourceMap.item.sourceLineIds,
        resultSourceLineIds: found.observation.sourceMap.result.sourceLineIds,
        resultHeaderSourceLineIds:
          found.observation.sourceMap.result.headerSourceLineIds,
        resultHeaderText: found.observation.sourceMap.result.headerText,
      },
      {
        normalizedName: expected.normalizedName,
        numericValue: expected.numericValue,
        unit: expected.sourceUnit,
        itemSourceLineIds: [expected.itemSourceLineId],
        resultSourceLineIds: [expected.resultSourceLineId],
        resultHeaderSourceLineIds: [expected.resultHeaderSourceLineId],
        resultHeaderText: expected.resultHeaderText,
      },
    );
    const catalog = getDatabase()
      .prepare(
        `SELECT canonical_key AS canonicalKey, default_unit AS defaultUnit
         FROM indicator_catalog WHERE canonical_key = ?`,
      )
      .get(expected.canonicalKey) as
      { canonicalKey: string; defaultUnit: string | null } | undefined;
    assert.deepEqual(
      [catalog?.canonicalKey, catalog?.defaultUnit],
      [expected.canonicalKey, expected.canonicalUnit],
    );
  }

  for (const expectedText of golden.expected.devicePanelRows) {
    const line = tcdPage.lines.find((entry) => entry.text === expectedText);
    assert.ok(line, `TCD 设备复写行未重建：${expectedText}`);
    assert.equal(line.candidate, false, line.text);
    assert.equal(line.candidateKind, null, line.text);
    assert.equal(line.role, "noise", line.text);
    assert.equal(line.contentRole, "environment", line.text);
    assert.equal(line.candidateResolutionReason, "filtered_noise", line.text);
    assert.deepEqual(line.dictionaryFacts, [], line.text);
    assert.deepEqual(line.localObservations, [], line.text);
  }

  for (const expected of golden.expected.chartAxisRows) {
    const line = tcdPage.lines.find((entry) => entry.text === expected.text);
    assert.ok(line, `TCD 图形刻度/缩写未保留：${expected.text}`);
    assert.deepEqual(line.sourceLineIds, expected.sourceLineIds);
    assert.equal(line.candidate, false, line.text);
    assert.equal(line.role, "noise", line.text);
    assert.equal(line.contentRole, "chart_axis", line.text);
    assert.equal(line.candidateResolutionReason, "filtered_noise", line.text);
    assert.deepEqual(line.localObservations, [], line.text);
  }

  const narrative = tcdPage.lines.find(
    (line) => line.text === golden.expected.strippedNarrative.text,
  );
  assert.ok(narrative, "检查所见正文必须保留");
  assert.deepEqual(
    narrative.sourceLineIds,
    golden.expected.strippedNarrative.sourceLineIds,
  );
  assert.equal(
    narrative.sourceLineIds.includes(
      golden.expected.strippedNarrative.removedGraphicSourceLineId,
    ),
    false,
    "同基线频谱缩写不得污染送 AI 的检查所见正文",
  );

  const plan = planRebuiltOcrPages(golden.source.reportId, rebuilt);
  const unresolved = plan.units.flatMap((unit) =>
    unit.candidateFacts.filter(
      (fact) =>
        fact.pageNumber === golden.source.pageNumber && fact.kind === "scalar",
    ),
  );
  assert.equal(
    unresolved.length,
    golden.expected.unresolvedScalarCandidateCount,
    "第 21 页已本地闭环的 TCD 行不得再进入 scalar AI",
  );
});

test("filters the real ultrasound acoustic safety-index overlay without losing OCR evidence", () => {
  const golden = JSON.parse(
    readFileSync(
      new URL(
        "./fixtures/p3-ultrasound-device-overlay-planner-golden.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as {
    source: {
      reportId: string;
      pageNumber: number;
      lines: Array<{
        id: string;
        text: string;
        confidence: number;
        box: unknown;
      }>;
    };
    expected: {
      sectionName: string;
      filteredSafetyIndexRow: {
        text: string;
        sourceLineIds: string[];
        sourceCellTexts: string[];
      };
      candidateRowCount: number;
      localObservationCount: number;
      unresolvedScalarCandidateCount: number;
      prohibitedAiSourceTexts: string[];
    };
  };

  const rebuilt = rebuildOcrPages([
    {
      pageId: "real-ultrasound-image-page-17",
      pageNumber: golden.source.pageNumber,
      linesJson: JSON.stringify(golden.source.lines),
    },
  ]);
  const ultrasoundPage = rebuilt[0];
  const filtered = ultrasoundPage.lines.find(
    (line) => line.text === golden.expected.filteredSafetyIndexRow.text,
  );
  assert.ok(filtered, "真实超声设备安全指数行必须保留审计轨迹");
  assert.equal(filtered.sectionName, golden.expected.sectionName);
  assert.deepEqual(
    filtered.sourceLineIds,
    golden.expected.filteredSafetyIndexRow.sourceLineIds,
  );
  assert.deepEqual(
    filtered.sourceCells.map((cell) => cell.text),
    golden.expected.filteredSafetyIndexRow.sourceCellTexts,
  );
  assert.equal(filtered.candidate, false);
  assert.equal(filtered.candidateKind, null);
  assert.equal(filtered.role, "noise");
  assert.equal(filtered.contentRole, "environment");
  assert.equal(filtered.candidateResolutionReason, "filtered_noise");
  assert.deepEqual(filtered.dictionaryFacts, []);
  assert.deepEqual(filtered.localObservations, []);
  assert.equal(
    ultrasoundPage.candidateRowCount,
    golden.expected.candidateRowCount,
  );
  assert.equal(
    ultrasoundPage.localObservationCount,
    golden.expected.localObservationCount,
  );

  const plan = planRebuiltOcrPages(golden.source.reportId, rebuilt);
  const unresolved = plan.units.flatMap((unit) =>
    unit.candidateFacts.filter(
      (fact) =>
        fact.pageNumber === golden.source.pageNumber && fact.kind === "scalar",
    ),
  );
  assert.equal(
    unresolved.length,
    golden.expected.unresolvedScalarCandidateCount,
  );
  const aiCandidateText = plan.units
    .flatMap((unit) => unit.candidateFacts)
    .map((fact) => fact.sourceText)
    .join("\n");
  for (const sourceText of golden.expected.prohibitedAiSourceTexts) {
    assert.equal(
      aiCandidateText.includes(sourceText),
      false,
      `${sourceText} 不得进入 AI candidateFacts`,
    );
  }
});

test("keeps clinical ultrasound measurements outside the conservative safety-index filter", () => {
  const rebuilt = rebuildOcrPages([
    page(1, [
      "超声检查报告单",
      "甲状腺结节 | 6×4 mm | C-TIRADS 3类",
      "子宫内膜厚度 | 8 mm",
      "TIs 0.1 | 甲状腺结节 | 6 mm",
    ]),
    page(2, ["设备测试记录", "TIs 0.1 | TIb 0.2 | MI 0.8"]),
  ]);

  for (const expectedText of [
    "甲状腺结节 | 6×4 mm | C-TIRADS 3类",
    "子宫内膜厚度 | 8 mm",
    "TIs 0.1 | 甲状腺结节 | 6 mm",
  ]) {
    const line = rebuilt[0].lines.find((entry) => entry.text === expectedText);
    assert.ok(line, `真实超声测量行未保留：${expectedText}`);
    assert.equal(line.candidate, true, expectedText);
    assert.equal(line.contentRole, "measurement", expectedText);
    assert.notEqual(line.candidateResolutionReason, "filtered_noise");
  }

  const outsideUltrasound = rebuilt[1].lines.find((line) =>
    line.text.includes("TIs 0.1"),
  );
  assert.ok(outsideUltrasound);
  assert.notEqual(
    outsideUltrasound.candidateResolutionReason,
    "filtered_noise",
  );
  assert.notEqual(outsideUltrasound.contentRole, "environment");
});

test("extracts the real ophthalmology summary and filters routine negative exam evidence", () => {
  const golden = JSON.parse(
    readFileSync(
      new URL(
        "./fixtures/p3-ophthalmology-summary-planner-golden.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as {
    source: {
      reportId: string;
      pageNumber: number;
      lines: Array<{
        id: string;
        text: string;
        confidence: number;
        box: unknown;
      }>;
    };
    expected: {
      filteredNegativeExamRow: {
        text: string;
        sourceLineIds: string[];
        sourceCellTexts: string[];
      };
      visionObservation: {
        lineText: string;
        sourceLineIds: string[];
        removedAdministrativeSourceLineId: string;
        itemName: string;
        normalizedName: string;
        canonicalKey: string;
        numericValue: number;
        unit: string | null;
        referenceLow: number;
        referenceHigh: number;
        abnormalFlag: "low";
      };
      candidateRowCount: number;
      localObservationCount: number;
      unresolvedScalarCandidateCount: number;
      prohibitedAiSourceTexts: string[];
    };
  };

  const rebuilt = rebuildOcrPages([
    {
      pageId: "real-ophthalmology-page-8",
      pageNumber: golden.source.pageNumber,
      linesJson: JSON.stringify(golden.source.lines),
    },
  ]);
  const page = rebuilt[0];
  const filtered = page.lines.find(
    (line) => line.text === golden.expected.filteredNegativeExamRow.text,
  );
  assert.ok(filtered, "真实裂隙灯阴性查体行必须保留审计轨迹");
  assert.deepEqual(
    filtered.sourceLineIds,
    golden.expected.filteredNegativeExamRow.sourceLineIds,
  );
  assert.deepEqual(
    filtered.sourceCells.map((cell) => cell.text),
    golden.expected.filteredNegativeExamRow.sourceCellTexts,
  );
  assert.equal(filtered.candidate, false);
  assert.equal(filtered.candidateKind, null);
  assert.equal(filtered.role, "noise");
  assert.equal(filtered.contentRole, "environment");
  assert.equal(filtered.candidateResolutionReason, "filtered_noise");
  assert.deepEqual(filtered.dictionaryFacts, []);
  assert.deepEqual(filtered.localObservations, []);

  const visionLine = page.lines.find(
    (line) => line.text === golden.expected.visionObservation.lineText,
  );
  assert.ok(visionLine, "真实视力小结必须去除横向误并入的检查医师空标签");
  assert.deepEqual(
    visionLine.sourceLineIds,
    golden.expected.visionObservation.sourceLineIds,
  );
  assert.equal(
    visionLine.sourceLineIds.includes(
      golden.expected.visionObservation.removedAdministrativeSourceLineId,
    ),
    false,
  );
  assert.equal(visionLine.localObservations.length, 1);
  const observation = visionLine.localObservations[0];
  assert.deepEqual(
    {
      itemName: observation.itemName,
      normalizedName: observation.normalizedName,
      numericValue: observation.numericValue,
      unit: observation.unit,
      referenceLow: observation.referenceLow,
      referenceHigh: observation.referenceHigh,
      abnormalFlag: observation.abnormalFlag,
      itemSourceLineIds: observation.sourceMap.item.sourceLineIds,
      resultSourceLineIds: observation.sourceMap.result.sourceLineIds,
      referenceSourceLineIds:
        observation.sourceMap.reference?.sourceLineIds ?? [],
    },
    {
      itemName: golden.expected.visionObservation.itemName,
      normalizedName: golden.expected.visionObservation.normalizedName,
      numericValue: golden.expected.visionObservation.numericValue,
      unit: golden.expected.visionObservation.unit,
      referenceLow: golden.expected.visionObservation.referenceLow,
      referenceHigh: golden.expected.visionObservation.referenceHigh,
      abnormalFlag: golden.expected.visionObservation.abnormalFlag,
      itemSourceLineIds: golden.expected.visionObservation.sourceLineIds,
      resultSourceLineIds: golden.expected.visionObservation.sourceLineIds,
      referenceSourceLineIds: golden.expected.visionObservation.sourceLineIds,
    },
  );
  assert.match(
    observation.observationKey,
    new RegExp(`:${golden.expected.visionObservation.canonicalKey}$`),
  );
  assert.equal(page.candidateRowCount, golden.expected.candidateRowCount);
  assert.equal(
    page.localObservationCount,
    golden.expected.localObservationCount,
  );

  const unresolved = page.lines.filter(
    (line) =>
      line.candidate &&
      line.candidateKind === "scalar" &&
      line.localObservations.length === 0,
  );
  assert.equal(
    unresolved.length,
    golden.expected.unresolvedScalarCandidateCount,
  );
  const plan = planRebuiltOcrPages(golden.source.reportId, rebuilt);
  const aiCandidateText = plan.units
    .flatMap((unit) => unit.candidateFacts)
    .map((fact) => fact.sourceText)
    .join("\n");
  for (const sourceText of golden.expected.prohibitedAiSourceTexts) {
    assert.equal(
      aiCandidateText.includes(sourceText),
      false,
      `${sourceText} 不得进入 AI candidateFacts`,
    );
  }
});

test("filters non-comparable quantitative-ultrasound bone device parameters from the real page", () => {
  const golden = JSON.parse(
    readFileSync(
      new URL(
        "./fixtures/p3-quantitative-ultrasound-bone-planner-golden.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as {
    source: {
      reportId: string;
      pageNumber: number;
      lines: Array<{
        id: string;
        text: string;
        confidence: number;
        box: unknown;
      }>;
    };
    expected: {
      sectionName: string;
      filteredRows: Array<{ text: string; sourceLineIds: string[] }>;
      preservedConclusionTexts: string[];
      coreScoreRow: {
        text: string;
        sourceLineIds: string[];
        observations: Array<{
          normalizedName: string;
          numericValue: number;
          itemSourceLineIds: string[];
          resultSourceLineIds: string[];
        }>;
      };
      candidateRowCount: number;
      localObservationCount: number;
      unresolvedScalarCandidateCount: number;
      prohibitedAiSourceTexts: string[];
    };
  };

  const rebuilt = rebuildOcrPages([
    {
      pageId: "real-quantitative-ultrasound-bone-page-23",
      pageNumber: golden.source.pageNumber,
      linesJson: JSON.stringify(golden.source.lines),
    },
  ]);
  const page = rebuilt[0];
  const scoreRow = page.lines.find(
    (entry) => entry.text === golden.expected.coreScoreRow.text,
  );
  assert.ok(scoreRow, "QUS T/Z 核心值未按真实坐标完成配对");
  assert.equal(scoreRow.sectionName, golden.expected.sectionName);
  assert.deepEqual(
    scoreRow.sourceLineIds,
    golden.expected.coreScoreRow.sourceLineIds,
  );
  assert.equal(scoreRow.candidateKind, "scalar");
  assert.deepEqual(
    scoreRow.localObservations.map((observation) => ({
      normalizedName: observation.normalizedName,
      numericValue: observation.numericValue,
      itemSourceLineIds: observation.sourceMap.item.sourceLineIds,
      resultSourceLineIds: observation.sourceMap.result.sourceLineIds,
    })),
    golden.expected.coreScoreRow.observations,
  );
  for (const expected of golden.expected.filteredRows) {
    const line = page.lines.find((entry) => entry.text === expected.text);
    assert.ok(line, `超声骨检测设备参数行未保留审计轨迹：${expected.text}`);
    assert.equal(line.sectionName, golden.expected.sectionName);
    assert.deepEqual(line.sourceLineIds, expected.sourceLineIds);
    assert.equal(line.candidate, false, line.text);
    assert.equal(line.candidateKind, null, line.text);
    assert.equal(line.role, "noise", line.text);
    assert.equal(line.contentRole, "environment", line.text);
    assert.equal(line.candidateResolutionReason, "filtered_noise", line.text);
    assert.deepEqual(line.dictionaryFacts, [], line.text);
    assert.deepEqual(line.localObservations, [], line.text);
  }
  for (const text of golden.expected.preservedConclusionTexts) {
    const line = page.lines.find((entry) => entry.text === text);
    assert.ok(line, `超声骨检测临床结论不得丢失：${text}`);
    assert.notEqual(line.candidateResolutionReason, "filtered_noise", text);
    assert.notEqual(line.contentRole, "environment", text);
  }
  assert.equal(page.candidateRowCount, golden.expected.candidateRowCount);
  assert.equal(
    page.localObservationCount,
    golden.expected.localObservationCount,
  );

  const unresolved = page.lines.filter(
    (line) =>
      line.candidate &&
      line.candidateKind === "scalar" &&
      line.localObservations.length === 0,
  );
  assert.equal(
    unresolved.length,
    golden.expected.unresolvedScalarCandidateCount,
  );
  const plan = planRebuiltOcrPages(golden.source.reportId, rebuilt);
  const aiCandidateText = plan.units
    .flatMap((unit) => unit.candidateFacts)
    .map((fact) => fact.sourceText)
    .join("\n");
  assert.equal(plan.localObservationCount, 2);
  assert.equal(
    aiCandidateText.includes(golden.expected.coreScoreRow.text),
    false,
    "已本地闭环的 QUS T/Z 不得再次发送 AI",
  );
  for (const sourceText of golden.expected.prohibitedAiSourceTexts) {
    assert.equal(
      aiCandidateText.includes(sourceText),
      false,
      `${sourceText} 不得进入 AI candidateFacts`,
    );
  }
});

test("keeps only nine trend-ready observations from the real body-composition page", () => {
  const golden = JSON.parse(
    readFileSync(
      new URL(
        "./fixtures/p3-body-composition-planner-golden.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as {
    source: {
      reportId: string;
      pageNumber: number;
      lines: Array<{
        id: string;
        text: string;
        confidence: number;
        box: unknown;
      }>;
    };
    expected: {
      observations: Array<{
        itemName: string;
        normalizedName: string;
        canonicalKey: string;
        numericValue: number;
        unit: string | null;
        referenceLow: number | null;
        referenceHigh: number | null;
        itemSourceLineIds: string[];
        resultSourceLineIds: string[];
        referenceSourceLineIds: string[];
      }>;
      duplicateEvidence: Array<{ text: string; sourceLineIds: string[] }>;
      filteredEvidence: Array<{ text: string; sourceLineIds: string[] }>;
      prohibitedObservationPatterns: string[];
      unresolvedScalarCandidateCount: number;
      candidateRowCount: number;
      localObservationCount: number;
    };
  };

  const rebuilt = rebuildOcrPages([
    {
      pageId: "real-body-composition-page-24",
      pageNumber: golden.source.pageNumber,
      linesJson: JSON.stringify(golden.source.lines),
    },
  ]);
  const page = rebuilt[0];
  const observations = page.lines.flatMap((line) =>
    line.localObservations.map((observation) => ({ line, observation })),
  );

  assert.equal(page.candidateRowCount, golden.expected.candidateRowCount);
  assert.equal(
    page.localObservationCount,
    golden.expected.localObservationCount,
  );
  assert.equal(observations.length, golden.expected.observations.length);

  for (const expected of golden.expected.observations) {
    const matching = observations.filter(
      ({ observation }) =>
        observation.normalizedName === expected.normalizedName &&
        observation.numericValue === expected.numericValue,
    );
    assert.equal(
      matching.length,
      1,
      `人体成分核心指标必须且只能保留一条：${expected.normalizedName}`,
    );
    const found = matching[0];
    assert.deepEqual(
      {
        itemName: found.observation.itemName,
        normalizedName: found.observation.normalizedName,
        numericValue: found.observation.numericValue,
        unit: found.observation.unit,
        referenceLow: found.observation.referenceLow,
        referenceHigh: found.observation.referenceHigh,
        itemSourceLineIds: found.observation.sourceMap.item.sourceLineIds,
        resultSourceLineIds: found.observation.sourceMap.result.sourceLineIds,
        referenceSourceLineIds:
          found.observation.sourceMap.reference?.sourceLineIds ?? [],
      },
      {
        itemName: expected.itemName,
        normalizedName: expected.normalizedName,
        numericValue: expected.numericValue,
        unit: expected.unit,
        referenceLow: expected.referenceLow,
        referenceHigh: expected.referenceHigh,
        itemSourceLineIds: expected.itemSourceLineIds,
        resultSourceLineIds: expected.resultSourceLineIds,
        referenceSourceLineIds: expected.referenceSourceLineIds,
      },
    );
    assert.equal(
      found.line.dictionaryFacts.some(
        (fact) => fact.canonicalKey === expected.canonicalKey,
      ),
      true,
      `${expected.normalizedName} 必须绑定标准 canonical key`,
    );
  }

  const observationText = observations
    .map(({ line, observation }) => `${line.text} ${observation.itemName}`)
    .join("\n");
  for (const pattern of golden.expected.prohibitedObservationPatterns) {
    assert.equal(
      observationText.includes(pattern),
      false,
      `${pattern} 不得生成家庭趋势 observation`,
    );
  }

  for (const expected of golden.expected.duplicateEvidence) {
    const line = page.lines.find(
      (entry) =>
        entry.text === expected.text &&
        entry.sourceLineIds.length === expected.sourceLineIds.length &&
        entry.sourceLineIds.every(
          (sourceLineId, index) =>
            sourceLineId === expected.sourceLineIds[index],
        ),
    );
    assert.ok(line, `重复人体成分证据未保留审计轨迹：${expected.text}`);
    assert.equal(line.candidate, false, line.text);
    assert.equal(line.candidateKind, null, line.text);
    assert.equal(
      line.candidateResolutionReason,
      "duplicate_evidence",
      line.text,
    );
    assert.deepEqual(line.dictionaryFacts, [], line.text);
    assert.deepEqual(line.localObservations, [], line.text);
  }

  for (const expected of golden.expected.filteredEvidence) {
    const line = page.lines.find(
      (entry) =>
        entry.text === expected.text &&
        entry.sourceLineIds.length === expected.sourceLineIds.length &&
        entry.sourceLineIds.every(
          (sourceLineId, index) =>
            sourceLineId === expected.sourceLineIds[index],
        ),
    );
    assert.ok(line, `人体成分非趋势行未按金标过滤：${expected.text}`);
    assert.equal(line.candidate, false, line.text);
    assert.equal(line.candidateKind, null, line.text);
    assert.equal(line.candidateResolutionReason, "filtered_noise", line.text);
    assert.deepEqual(line.dictionaryFacts, [], line.text);
    assert.deepEqual(line.localObservations, [], line.text);
  }

  const unresolved = page.lines.filter(
    (line) =>
      line.candidate &&
      line.candidateKind === "scalar" &&
      line.localObservations.length === 0,
  );
  assert.equal(
    unresolved.length,
    golden.expected.unresolvedScalarCandidateCount,
    "人体成分页 scalar candidate 必须全部本地闭环",
  );

  const plan = planRebuiltOcrPages(golden.source.reportId, rebuilt);
  const aiCandidateText = plan.units
    .flatMap((unit) => unit.candidateFacts)
    .map((fact) => fact.sourceText)
    .join("\n");
  for (const expected of golden.expected.filteredEvidence) {
    for (const sourceLineId of expected.sourceLineIds) {
      const rawText = golden.source.lines.find(
        (line) => line.id === sourceLineId,
      )?.text;
      if (rawText) {
        assert.equal(
          aiCandidateText.includes(rawText),
          false,
          `${rawText} 不得进入 AI candidateFacts`,
        );
      }
    }
  }
});

test("defaults to the detailed extraction depth and records it on the plan", () => {
  const plan = planRebuiltOcrPages(
    "depth-default",
    rebuildOcrPages([
      page(1, [
        "检验报告单",
        "项目 | 结果 | 单位 | 参考范围",
        "总胆固醇 | 4.8 | mmol/L | <5.2",
      ]),
    ]),
  );
  assert.equal(plan.extractionDepth, "detailed");
});

test("overview depth keeps scalar and morphology extraction but drops narrative units", () => {
  const rows = [
    page(1, [
      "出院小结",
      "住院号：ZY-20260730",
      "住院经过：患者入院后完成相关检查并接受治疗。",
      "出院医嘱：按门诊安排复诊。",
    ]),
    page(2, [
      "血脂",
      "总胆固醇 5.3 mmol/L 参考范围 0-5.2",
      "超声检查",
      "右肾见囊肿，大小约 8×6 mm",
    ]),
  ];
  const detailed = planRebuiltOcrPages("depth-routes", rebuildOcrPages(rows));
  const overview = planRebuiltOcrPages(
    "depth-routes",
    rebuildOcrPages(rows),
    "overview",
  );

  assert.equal(detailed.extractionDepth, "detailed");
  assert.ok(detailed.units.some((unit) => unit.route === "narrative"));
  assert.ok(detailed.units.some((unit) => unit.route === "morphology"));

  assert.equal(overview.extractionDepth, "overview");
  assert.deepEqual(
    overview.units.map((unit) => unit.route).sort(),
    ["document", "morphology", "scalar"],
  );
  const overviewScalar = overview.units.find(
    (unit) => unit.route === "scalar",
  );
  assert.ok(overviewScalar);
  assert.ok(overviewScalar.candidateRowCount >= 1);
  assert.notEqual(overview.planHash, detailed.planHash);
});

test("overview depth packs scalar pages under doubled limits", () => {
  const candidateCounts = [
    1, 16, 2, 8, 1, 25, 4, 1, 23, 71, 41, 40, 47, 3, 1, 2, 1, 14, 1, 9, 18, 2,
    1, 1,
  ];
  const rows = candidateCounts.map((count, pageIndex) =>
    page(pageIndex + 1, [
      `第 ${pageIndex + 1} 页检查`,
      "项目 | 结果 | 单位 | 参考范围",
      ...Array.from(
        { length: count },
        (_, itemIndex) =>
          `指标${pageIndex + 1}-${itemIndex + 1} ${itemIndex + 1}.2 mmol/L 参考范围 1.0-200.0`,
      ),
    ]),
  );
  const detailed = planRebuiltOcrPages("depth-packing", rebuildOcrPages(rows));
  const overview = planRebuiltOcrPages(
    "depth-packing",
    rebuildOcrPages(rows),
    "overview",
  );

  const detailedScalars = detailed.units.filter(
    (unit) => unit.route === "scalar",
  );
  const overviewScalars = overview.units.filter(
    (unit) => unit.route === "scalar",
  );
  assert.ok(detailedScalars.length >= 2);
  assert.ok(overviewScalars.length < detailedScalars.length);
  assert.equal(
    overviewScalars.flatMap((unit) => unit.pageNumbers).join(","),
    candidateCounts.map((_, index) => index + 1).join(","),
  );
  for (const unit of overviewScalars) {
    assert.ok(
      unit.pageNumbers.length <= aiInputPlanningPolicy.maxPagesPerUnit * 2,
    );
    assert.ok(
      unit.characterCount <= aiInputPlanningPolicy.targetCharacters * 2,
    );
  }
});
