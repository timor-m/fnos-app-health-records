import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyReportContent,
  hasMedicationContent,
  classifyReportDocument
} from "../services/report-content-classifier.service.ts";
import {
  normalizeAiExtraction,
  promptForInput
} from "../services/ai-extraction.service.ts";
import { medicationLayouts, nonMedicationLayouts } from "./fixtures/medication-layouts.ts";

test("dispensing headings require medication context and tolerate OCR spacing", () => {
  for (const heading of ["药材调剂单（代煎）", "调 剂 单", "配药单", "发药单"]) {
    const text = `${heading}\n剂数：3\n合成药甲 8g`;
    assert.equal(hasMedicationContent(text), true);
    assert.equal(classifyReportContent(text).primaryType, "prescription");
  }
  for (const text of ["医疗收费票据 中药调剂服务费 10元", "调剂单号：123 剂数：3", "调剂单 业务统计", "药品说明书 调剂单 代煎"]) {
    assert.equal(hasMedicationContent(text), false, text);
  }
});

test("recognizes medication layouts while preserving clinical document types", () => {
  for (const layout of medicationLayouts) {
    assert.equal(hasMedicationContent(layout.pages[0].join("\n")), true, layout.name);
    assert.equal(classifyReportDocument(layout.pages.map((lines, index) => ({
      pageNumber: index + 1, text: lines.join("\n"),
    }))).primaryType, layout.type, layout.name);
  }
  for (const lines of nonMedicationLayouts) {
    assert.equal(hasMedicationContent(lines.join("\n")), false);
    assert.ok(!classifyReportContent(lines.join("\n")).contentTypes.includes("prescription"));
  }
});

test("medication contract handles layout boundaries and original treatment status", () => {
  const prompt = promptForInput({ reportId: "report", text: "当前用药", inputCharacters: 4,
    pageCount: 1, route: "narrative", includesMedicationContent: true,
    primaryContentType: "checkup", documentContentType: "checkup" });
  for (const rule of ["medications", "调剂单", "每味克数不是检验指标", "不推算频次", "多栏", "跨页证据分别保留页码", "规格不是每次剂量", "停用", "过敏史", "context=discharge"]) {
    assert.ok(prompt.includes(rule), rule);
  }
});

test("classifies common single-page medical documents without an AI call", () => {
  assert.equal(classifyReportContent([
    "血常规检验报告",
    "标本类型：全血",
    "项目 | 结果 | 单位 | 参考范围"
  ].join("\n")).primaryType, "laboratory");

  assert.equal(classifyReportContent([
    "电子处方笺",
    "药品名称 | 规格 | 用法用量 | 数量",
    "阿莫西林胶囊 | 0.25g | 口服 每日3次 | 24粒"
  ].join("\n")).primaryType, "prescription");

  assert.equal(classifyReportContent([
    "医疗收费票据",
    "票据号：P20260730001",
    "总金额：128.00 医保支付：80.00 个人自付：48.00"
  ].join("\n")).primaryType, "billing");

  assert.equal(classifyReportContent([
    "预防接种凭证",
    "疫苗名称：流感疫苗 接种剂次：第1剂",
    "疫苗批号：LOT-2026 接种部位：左上臂"
  ].join("\n")).primaryType, "vaccination");
});

test("keeps a composite checkup as the document type while classifying component pages", () => {
  const pages = [
    {
      pageNumber: 1,
      text: "健康体检报告\n体检编号：T20260730\n总检结论"
    },
    {
      pageNumber: 2,
      text: "血常规\n项目 | 结果 | 单位 | 参考范围\n白细胞计数 | 5.2 | 10^9/L | 3.5-9.5"
    },
    {
      pageNumber: 3,
      text: "腹部彩超\n超声所见：肝脏回声均匀\n检查结论：未见明显异常"
    }
  ].map((page) => ({ ...page, classification: classifyReportContent(page.text) }));
  assert.equal(pages[1].classification.primaryType, "laboratory");
  assert.equal(pages[2].classification.primaryType, "ultrasound");
  assert.equal(classifyReportDocument(pages).primaryType, "checkup");
});

test("builds a routed prompt from the local content classification", () => {
  const prompt = promptForInput({
    reportId: "report",
    text: "[第 1 页]\n电子处方笺\n阿莫西林胶囊 0.25g 口服 每日3次",
    inputCharacters: 42,
    pageCount: 1,
    primaryContentType: "prescription",
    contentTypes: ["prescription"],
    classificationConfidence: 0.95,
    documentContentType: "prescription",
    extractionMode: "scalar",
    route: "narrative",
    allowDocumentFields: false
  });
  assert.match(prompt, /服务端本地分类：当前单元为处方内容/);
  assert.match(prompt, /药品名称、规格、剂型、每次剂量/);
  assert.match(prompt, /medications/);
  assert.match(prompt, /当前任务只整理原报告叙事章节/);
  assert.doesNotMatch(prompt, /billingSummary、billingItems/);
  assert.doesNotMatch(prompt, /票据内容：重点识别/);
});

test("does not treat checkup history and physical-exam rows as an outpatient record", () => {
  const prompt = promptForInput({
    reportId: "report",
    text: "[第 6 页]\n主诉 | 无特殊\n体格检查\n营养 | 营养良好",
    inputCharacters: 42,
    pageCount: 1,
    primaryContentType: "outpatient",
    contentTypes: ["outpatient"],
    classificationConfidence: 0.8,
    documentContentType: "checkup",
    extractionMode: "scalar",
    route: "narrative",
    allowDocumentFields: false
  });
  assert.match(prompt, /当前单元为体检内容/);
  assert.match(prompt, /整份文档主类型为体检/);
  assert.doesNotMatch(prompt, /outpatient_history/);
  assert.doesNotMatch(prompt, /门诊内容：重点提取/);
});

test("uses a minimal output contract for scalar units", () => {
  const prompt = promptForInput({
    reportId: "report",
    text: "[第 1 页]\n血常规\n白细胞计数 | 5.0 | 10^9/L | 3.5-9.5",
    inputCharacters: 50,
    pageCount: 1,
    primaryContentType: "laboratory",
    contentTypes: ["laboratory"],
    documentContentType: "laboratory",
    extractionMode: "scalar",
    route: "scalar",
    allowDocumentFields: false
  });
  assert.match(prompt, /只输出 observations/);
  assert.doesNotMatch(prompt, /medications 使用/);
  assert.doesNotMatch(prompt, /billingSummary 使用/);
  assert.doesNotMatch(prompt, /morphologyFindings.size/);
});

test("constrains pulmonary multi-column tables to current results and filters device parameters", () => {
  const prompt = promptForInput({
    reportId: "report",
    text: "[第 1 页]\n肺功能检查\n项目 | 实测 | 预测\nFVC | 2.22 | 3.33",
    inputCharacters: 54,
    pageCount: 1,
    primaryContentType: "functional",
    contentTypes: ["functional"],
    documentContentType: "checkup",
    extractionMode: "scalar",
    route: "scalar",
    allowDocumentFields: false
  });
  assert.match(prompt, /实测\/本次结果/);
  assert.match(prompt, /预测值/);
  assert.match(prompt, /最近表头/);
  assert.match(prompt, /PEF TIME/);
  assert.match(prompt, /\/HT/);
  assert.match(prompt, /单位只在当前行或可明确继承的表头出现时填写/);
});

test("uses one typed contract for consolidated omission verification", () => {
  const prompt = promptForInput({
    reportId: "report",
    text: "[第 1 页 · 指标遗漏候选补提取]\n总胆固醇 5.3 mmol/L\n[第 2 页 · 形态发现遗漏候选补提取]\n右肾囊肿 8×6 mm",
    inputCharacters: 88,
    pageCount: 2,
    promptMode: "supplement",
    extractionMode: "scalar",
    route: "verification",
    primaryContentType: "checkup",
    contentTypes: ["checkup", "imaging"],
    documentContentType: "checkup"
  });
  assert.match(prompt, /统一遗漏核对/);
  assert.match(prompt, /只输出 observations 和 morphologyFindings/);
  assert.match(prompt, /不能把形态发现写入 observations/);
});

test("keeps internal checkup routing metadata out of document fields", () => {
  const prompt = promptForInput({
    reportId: "report",
    text: "[文档概况]\n总页数：23\n[第 1 页]\n个人健康体检报告",
    inputCharacters: 36,
    pageCount: 1,
    primaryContentType: "checkup",
    contentTypes: ["checkup"],
    documentContentType: "checkup",
    extractionMode: "scalar",
    route: "document",
    allowDocumentFields: true
  });
  assert.match(prompt, /综合体检通常跨多个科室和部位/);
  assert.match(prompt, /reportSubtype 默认省略/);
  assert.match(prompt, /bodyParts 默认省略/);
  assert.doesNotMatch(prompt, /本地分类：checkup/);
});

test("normalizes report-type-specific facts into stable structures", () => {
  const result = normalizeAiExtraction({
    reportType: "inpatient",
    diagnoses: [{
      diagnosisType: "discharge", diagnosisText: "社区获得性肺炎",
      isPrimary: true, p: 2, q: "出院诊断：社区获得性肺炎"
    }],
    procedures: [{
      procedureType: "treatment", procedureName: "雾化吸入治疗",
      performedAt: "2026-07-29 09:30:00", p: 3, q: "给予雾化吸入治疗"
    }],
    vaccinations: [{
      vaccineName: "流感疫苗", doseNumber: "第1剂", lotNumber: "LOT-2026",
      administeredAt: "2026-07-30", p: 1, q: "流感疫苗 第1剂 批号 LOT-2026"
    }],
    billingSummary: {
      invoiceNumber: "P20260730001", totalAmount: 128, insuranceAmount: 80,
      selfPayAmount: 48, p: 1, q: "总金额 128.00 医保支付 80.00 个人自付 48.00"
    },
    billingItems: [{
      category: "检验费", itemName: "血常规", amount: 25,
      p: 1, q: "检验费 血常规 25.00"
    }]
  }).fields;
  assert.equal(result.diagnoses[0].diagnosisType, "discharge");
  assert.equal(result.diagnoses[0].isPrimary, true);
  assert.equal(result.procedures[0].performedAt, "2026-07-29 09:30:00");
  assert.equal(result.vaccinations[0].lotNumber, "LOT-2026");
  assert.equal(result.billingSummary?.totalAmount, 128);
  assert.equal(result.billingItems[0].itemName, "血常规");
});

test('clinical narrative tasks retain explicitly documented vaccinations and disambiguate dates and continuation rows',()=>{
 for(const type of ['outpatient','inpatient'] as const){
  const prompt=promptForInput({reportId:'synthetic',text:'合成接种记录',inputCharacters:6,pageCount:3,route:'narrative',primaryContentType:type,contentTypes:[type,'prescription'],documentContentType:type});
  for(const key of ['vaccinations','administeredAt','nextDueAt','lotNumber','不能用就诊','同编号明确续表'])assert.ok(prompt.includes(key),key);
 }
});


test('ultrasound is a report subtype without reclassifying CT/MRI or functional reports',()=>{
 assert.equal(classifyReportContent('心血管彩色超声检查报告单 超声描述 超声提示 血流信号').primaryType,'ultrasound');
 assert.equal(classifyReportContent('CT检查报告 影像所见 密度影 强化扫描').primaryType,'imaging');
 assert.equal(classifyReportContent('MRI检查报告 扫描序列 影像学诊断').primaryType,'imaging');
 assert.equal(classifyReportContent('骨密度检查 T值 Z值').primaryType,'functional');
 const normalized=normalizeAiExtraction({reportType:'ultrasound',reportSubtype:'心脏超声',observations:[]});
 assert.equal(normalized.fields.reportType,'ultrasound');assert.equal(normalized.fields.reportSubtype,'心脏超声');
});
