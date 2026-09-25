import assert from "node:assert/strict";
import test from "node:test";
import {
  deduplicateReportMorphologyFindings,
  normalizeAiExtraction,
  type AiMorphologyFinding,
} from "../services/ai-extraction.service.ts";

function finding(
  overrides: Partial<AiMorphologyFinding>,
): AiMorphologyFinding {
  return {
    sectionName: "超声提示",
    organ: "肝脏",
    region: "右叶",
    laterality: "right",
    findingType: "钙化灶",
    findingName: "肝右叶局灶性钙化灶",
    presence: "present",
    findingCount: 1,
    size: { length: null, width: null, height: null, unit: null },
    measurements: [],
    morphology: null,
    attributes: {},
    classification: null,
    comparisonText: null,
    rawText: "肝右叶局灶性钙化灶",
    evidence: [{ pageNumber: 18, quote: "肝右叶局灶性钙化灶" }],
    confidence: 0.96,
    ...overrides,
  };
}

function echoDescriptor(sizeMm: number, region = "肝右叶") {
  const rawText = `${region}见强回声区，直径约${sizeMm}mm，后方无声影。`;
  return finding({
    sectionName: "超声描述",
    region,
    findingType: "强回声区",
    findingName: `${region}强回声区`,
    size: { length: sizeMm, width: null, height: null, unit: "mm" },
    measurements: [{ key: "直径", value: sizeMm, unit: "mm" }],
    morphology: "强回声区，后方无声影",
    attributes: { 后方声影: "无" },
    rawText,
    evidence: [{ pageNumber: 18, quote: rawText }],
    confidence: 0.9,
  });
}

test("merges one uniquely matched ultrasound descriptor into the canonical calcification finding", () => {
  const result = deduplicateReportMorphologyFindings([
    finding({}),
    echoDescriptor(5),
  ]);

  assert.equal(result.length, 1);
  assert.equal(result[0].findingType, "钙化灶");
  assert.equal(result[0].findingName, "肝右叶局灶性钙化灶");
  assert.deepEqual(result[0].size, {
    length: 5,
    width: null,
    height: null,
    unit: "mm",
  });
  assert.equal(
    result[0].measurements.some(
      (item) => item.key === "直径" && item.value === 5 && item.unit === "mm",
    ),
    true,
  );
  assert.deepEqual(
    result[0].evidence.map((item) => item.quote),
    ["肝右叶局灶性钙化灶", "肝右叶见强回声区，直径约5mm，后方无声影。"],
  );
});

test("does not collapse two ambiguous same-side echo lesions into one generic conclusion", () => {
  const result = deduplicateReportMorphologyFindings([
    finding({}),
    echoDescriptor(5),
    echoDescriptor(8),
  ]);

  assert.equal(result.length, 3);
  assert.deepEqual(
    result
      .map((item) => item.size.length)
      .filter((value): value is number => value !== null)
      .sort((left, right) => left - right),
    [5, 8],
  );
  assert.equal(
    result.filter((item) => item.findingType === "钙化灶").length,
    1,
  );
});

test("does not merge a descriptor from the opposite side or a page without matching conclusion evidence", () => {
  const oppositeSide = echoDescriptor(5, "肝左叶");
  oppositeSide.laterality = "left";
  const differentPage = echoDescriptor(6);
  differentPage.evidence = [
    { pageNumber: 19, quote: "肝右叶见强回声区，直径约6mm。" },
  ];

  const result = deduplicateReportMorphologyFindings([
    finding({}),
    oppositeSide,
    differentPage,
  ]);

  assert.equal(result.length, 3);
  assert.equal(
    result.some(
      (item) => item.laterality === "left" && item.size.length === 5,
    ),
    true,
  );
  assert.equal(
    result.some(
      (item) =>
        item.laterality === "right" &&
        item.findingType === "回声改变" &&
        item.size.length === 6,
    ),
    true,
  );
});

test("keeps otherwise identical morphology findings from explicitly different examination dates", () => {
  const dated = (date: string) => finding({
    rawText: "肝右叶囊肿",
    evidence: [{
      pageNumber: 18,
      quote: "肝右叶囊肿",
      table: {
        headerText: `项目 | ${date}`,
        headerSourceLineIds: [],
        rowSourceLineIds: [],
        resultColumn: { index: 1, headerText: date, selectionBasis: "explicit_current_result_header" },
      },
    }],
  });
  assert.equal(deduplicateReportMorphologyFindings([dated("2026-09-01"), dated("2026-09-08")]).length, 2);
  assert.equal(deduplicateReportMorphologyFindings([dated("2026-09-01"), dated("2026-09-01")]).length, 1);
});


test("recovers a labeled single diameter from compatible evidence without leaking it into another finding", () => {
  const detail =
    "肝脏形态大小正常，实质回声稍增强，考虑轻度脂肪肝。肝右叶见强回声区，直径约5mm，后方无声影。";
  const normalized = normalizeAiExtraction({
    morphologyFindings: [
      {
        organ: "肝脏",
        region: "右叶",
        laterality: "right",
        findingType: "钙化灶",
        findingName: "肝右叶局灶性钙化灶",
        presence: "present",
        rawText: "肝右叶局灶性钙化灶",
        evidence: [
          { pageNumber: 18, quote: "肝右叶局灶性钙化灶" },
          { pageNumber: 18, quote: detail },
        ],
      },
      {
        organ: "肝脏",
        laterality: "unspecified",
        findingType: "脂肪肝",
        findingName: "脂肪肝（轻度）",
        presence: "present",
        rawText: detail,
        evidence: [{ pageNumber: 18, quote: detail }],
      },
    ],
  });

  const calcification = normalized.fields.morphologyFindings.find((item) =>
    item.findingName.includes("钙化"),
  );
  const fattyLiver = normalized.fields.morphologyFindings.find((item) =>
    item.findingName.includes("脂肪肝"),
  );
  assert.deepEqual(calcification?.size, {
    length: 5,
    width: null,
    height: null,
    unit: "mm",
  });
  assert.deepEqual(calcification?.measurements, [
    { key: "直径", value: 5, unit: "mm" },
  ]);
  assert.equal(fattyLiver?.size.length, null);
  assert.deepEqual(fattyLiver?.measurements, []);
});

test("preserves the explicit label for a single morphology measurement", () => {
  const normalized = normalizeAiExtraction({
    morphologyFindings: [
      {
        organ: "甲状腺",
        findingType: "结节",
        findingName: "甲状腺结节",
        presence: "present",
        rawText: "甲状腺结节厚度约5mm",
        evidence: [{ pageNumber: 1, quote: "甲状腺结节厚度约5mm" }],
      },
    ],
  });
  assert.deepEqual(normalized.fields.morphologyFindings[0].measurements, [
    { key: "厚度", value: 5, unit: "mm" },
  ]);
});

test("does not treat an unlabeled distance as a morphology size", () => {
  const normalized = normalizeAiExtraction({
    morphologyFindings: [
      {
        organ: "乳腺",
        findingType: "结节",
        findingName: "乳腺结节",
        presence: "present",
        rawText: "结节距皮肤约5mm",
        evidence: [{ pageNumber: 1, quote: "结节距皮肤约5mm" }],
      },
    ],
  });
  assert.equal(normalized.fields.morphologyFindings[0].size.length, null);
});
