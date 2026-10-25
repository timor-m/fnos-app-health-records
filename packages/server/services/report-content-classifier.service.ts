export const reportContentTypes = [
  "checkup",
  "laboratory",
  "imaging",
  "functional",
  "pathology",
  "outpatient",
  "inpatient",
  "prescription",
  "billing",
  "vaccination",
  "other"
] as const;

export const reportContentClassifierVersion = "local-content-router-v2-medications";

const medicationHeading = /处方笺|处方信息|(?:普通|电子|门诊|住院)处方|用药清单|药物清单|用药记录|出院用药|出院带药|用药医嘱|长期医嘱|临时医嘱|当前用药/;
const medicationUsage = /用法(?:用量)?|每次剂量|给药途径|(?:口服|静滴|静注|外用|皮下注射|肌内注射|局部封闭).{0,30}(?:每日|每次|即刻|\b(?:qd|bid|tid|qid|prn|stat)\b)/i;
const medicationProduct = /[\u3400-\u9fffA-Za-z]{2,}(?:片|胶囊|颗粒|注射液|口服液|滴眼液|软膏|乳膏)|药品名称|药物名称/;
const nonMedicationDocument = /药品说明书|药物说明书|不良反应.{0,80}禁忌/;

function medicationText(value: string) {
  return value.normalize("NFKC").replace(/(?<=[\u3400-\u9fff])\s+(?=[\u3400-\u9fff])/g, "").replace(/\s+/g, " ");
}

/** Routing signals only: never infer a drug, a dose, or a treatment from them. */
export function hasMedicationContent(value: string) {
  const text = medicationText(value);
  if (nonMedicationDocument.test(text)) return false;
  if (medicationHeading.test(text)) return true;
  const usage = medicationUsage.test(text);
  // Purchasing a drug does not establish a prescription or administration.
  if (/收费|费用清单|结算单|发票/.test(text) && !usage) return false;
  return medicationProduct.test(text) && (usage ||
    /(?:药品名称|药物名称).{0,60}规格.{0,60}数量/.test(text));
}

export function hasMedicationContinuation(value: string) {
  const text = medicationText(value);
  return !nonMedicationDocument.test(text) &&
    !/过敏史|过敏原|药物过敏/.test(text) &&
    (medicationUsage.test(text) || (medicationProduct.test(text) && /\d+(?:\.\d+)?\s*(?:mg|g|ml|μg|ug|片|粒|支|袋)(?![A-Za-z])/i.test(text)));
}

export type ReportContentType = typeof reportContentTypes[number];

export type ReportContentClassification = {
  primaryType: ReportContentType;
  contentTypes: ReportContentType[];
  confidence: number;
  scores: Partial<Record<ReportContentType, number>>;
  reasons: string[];
};

type ClassificationRule = {
  type: Exclude<ReportContentType, "other">;
  signals: Array<{ pattern: RegExp; weight: number; reason: string }>;
};

const rules: ClassificationRule[] = [
  {
    type: "checkup",
    signals: [
      { pattern: /健康体检(?:报告|档案)|体检报告|体检套餐/, weight: 10, reason: "体检报告标题" },
      { pattern: /总检结论|体检综述|阳性发现|异常汇总/, weight: 8, reason: "体检汇总章节" },
      { pattern: /一般检查|基础测量|人体成分|体检编号/, weight: 5, reason: "体检基础项目" }
    ]
  },
  {
    type: "laboratory",
    signals: [
      { pattern: /检验报告|化验报告|医学检验|临床检验/, weight: 9, reason: "检验报告标题" },
      { pattern: /标本(?:类型|名称|性状|编号)|采样时间|检验方法/, weight: 5, reason: "检验标本信息" },
      { pattern: /(?:项目|名称).{0,20}(?:结果|测定值).{0,30}(?:参考|范围|单位)/, weight: 7, reason: "检验结果表格" },
      { pattern: /血常规|尿常规|便常规|肝功能|肾功能|血脂|血糖|电解质|甲状腺功能|肿瘤标志物/, weight: 4, reason: "检验分组" }
    ]
  },
  {
    type: "imaging",
    signals: [
      { pattern: /超声|彩超|CT|MRI|磁共振|DR\b|X线|放射|影像检查/, weight: 9, reason: "影像检查方式" },
      { pattern: /影像所见|超声所见|检查所见|影像学诊断/, weight: 6, reason: "影像报告章节" },
      { pattern: /回声|密度影|血流信号|强化扫描|扫描序列/, weight: 4, reason: "影像描述" }
    ]
  },
  {
    type: "functional",
    signals: [
      { pattern: /心电图|动态心电|肺功能|骨密度|脑电图|肌电图|动脉硬化|ABI|baPWV|呼气试验/, weight: 9, reason: "功能检查项目" },
      { pattern: /心率|PR间期|QRS|QTc|FEV1|FVC|T值|Z值/, weight: 4, reason: "功能检查测量" }
    ]
  },
  {
    type: "pathology",
    signals: [
      { pattern: /病理报告|病理诊断|组织病理|细胞病理/, weight: 10, reason: "病理报告标题" },
      { pattern: /镜下所见|肉眼所见|免疫组化|切片|蜡块/, weight: 7, reason: "病理检查内容" },
      { pattern: /分化程度|病理分级|TNM分期/, weight: 5, reason: "病理分级分期" }
    ]
  },
  {
    type: "outpatient",
    signals: [
      { pattern: /门诊病历|门诊记录|门诊诊断|门诊号/, weight: 9, reason: "门诊记录标识" },
      { pattern: /主诉|现病史|既往史|体格检查|处理意见|处置/, weight: 4, reason: "门诊病历章节" }
    ]
  },
  {
    type: "inpatient",
    signals: [
      { pattern: /入院记录|出院记录|出院小结|住院病案|住院号/, weight: 10, reason: "住院文书标识" },
      { pattern: /入院诊断|出院诊断|住院经过|出院医嘱/, weight: 7, reason: "住院文书章节" },
      { pattern: /病区|床号|手术经过|入院日期|出院日期/, weight: 4, reason: "住院信息" }
    ]
  },
  {
    type: "prescription",
    signals: [
      { pattern: /处\s*方\s*笺|电子处方|门诊处方|住院处方|普通处方|处方信息|用药清单|药物清单/, weight: 10, reason: "处方标题" },
      { pattern: /药品名称|药物名称|用法用量|每次剂量|给药途径/, weight: 6, reason: "处方字段" },
      { pattern: /规格.{0,20}(?:剂量|频次|数量)|(?:口服|静滴|静注|外用).{0,20}(?:每日|每次)/, weight: 4, reason: "用药信息" }
    ]
  },
  {
    type: "billing",
    signals: [
      { pattern: /医疗收费票据|医疗票据|收费收据|费用清单|结算单/, weight: 10, reason: "医疗票据标题" },
      { pattern: /总金额|合计金额|医保支付|统筹支付|个人自付|自费金额/, weight: 7, reason: "费用汇总" },
      { pattern: /收费项目|项目金额|票据号|发票号/, weight: 4, reason: "票据字段" }
    ]
  },
  {
    type: "vaccination",
    signals: [
      { pattern: /预防接种|疫苗接种|接种记录|接种凭证/, weight: 10, reason: "疫苗接种标题" },
      { pattern: /疫苗名称|接种剂次|第\d+剂|疫苗批号|接种部位/, weight: 7, reason: "疫苗接种字段" },
      { pattern: /生产企业|疫苗厂家|下次接种/, weight: 4, reason: "疫苗生产和计划信息" }
    ]
  }
];

function normalizedText(value: string) {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim();
}

function scoreText(value: string) {
  const text = normalizedText(value);
  const scores: Partial<Record<ReportContentType, number>> = {};
  const reasons = new Map<ReportContentType, string[]>();
  for (const rule of rules) {
    if (rule.type === "prescription" && !hasMedicationContent(value)) continue;
    let score = 0;
    const matchedReasons: string[] = [];
    for (const signal of rule.signals) {
      if (!signal.pattern.test(text)) continue;
      score += signal.weight;
      matchedReasons.push(signal.reason);
    }
    if (!score) continue;
    scores[rule.type] = score;
    reasons.set(rule.type, matchedReasons);
  }
  if (hasMedicationContent(value)) {
    scores.prescription = Math.max(scores.prescription || 0, 8);
    if (!reasons.has("prescription")) reasons.set("prescription", ["明确用药内容"]);
    // Embedded medication tables must not rename the enclosing clinical record.
    for (const [type, title] of [
      ["outpatient", /门诊病历|门诊记录/],
      ["inpatient", /入院记录|出院记录|出院小结|住院病案/],
    ] as const) {
      if (title.test(text)) scores[type] = Math.max(scores[type] || 0, scores.prescription + 1);
    }
  }
  return { scores, reasons };
}

function rankedTypes(scores: Partial<Record<ReportContentType, number>>) {
  return reportContentTypes
    .filter((type) => type !== "other" && (scores[type] || 0) > 0)
    .sort((left, right) => (scores[right] || 0) - (scores[left] || 0)
      || reportContentTypes.indexOf(left) - reportContentTypes.indexOf(right));
}

function finalizeClassification(
  scores: Partial<Record<ReportContentType, number>>,
  reasonsByType: Map<ReportContentType, string[]>
): ReportContentClassification {
  const ranked = rankedTypes(scores);
  if (!ranked.length) {
    return {
      primaryType: "other",
      contentTypes: ["other"],
      confidence: 0,
      scores: {},
      reasons: ["没有命中可靠的本地分类信号"]
    };
  }
  const primaryType = ranked[0];
  const primaryScore = scores[primaryType] || 0;
  const secondaryScore = scores[ranked[1]] || 0;
  const contentTypes = ranked
    .filter((type, index) => index === 0 || (scores[type] || 0) >= Math.max(6, primaryScore * 0.55))
    .slice(0, 2);
  const confidence = Math.max(0.25, Math.min(1,
    primaryScore / Math.max(1, primaryScore + secondaryScore * 0.65)
  ));
  return {
    primaryType,
    contentTypes,
    confidence: Number(confidence.toFixed(3)),
    scores,
    reasons: (reasonsByType.get(primaryType) || []).slice(0, 4)
  };
}

export function classifyReportContent(text: string): ReportContentClassification {
  const scored = scoreText(text);
  return finalizeClassification(scored.scores, scored.reasons);
}

export function classifyReportDocument(
  pages: Array<{ pageNumber: number; text: string; classification?: ReportContentClassification }>
): ReportContentClassification {
  const aggregate: Partial<Record<ReportContentType, number>> = {};
  const reasons = new Map<ReportContentType, string[]>();
  for (const page of pages) {
    const classification = page.classification || classifyReportContent(page.text);
    const positionWeight = page.pageNumber <= 2 ? 1.4 : 1;
    for (const [type, rawScore] of Object.entries(classification.scores) as Array<[ReportContentType, number]>) {
      aggregate[type] = (aggregate[type] || 0) + rawScore * positionWeight;
    }
    const currentReasons = reasons.get(classification.primaryType) || [];
    for (const reason of classification.reasons) {
      if (!currentReasons.includes(reason)) currentReasons.push(reason);
    }
    reasons.set(classification.primaryType, currentReasons);
  }

  const checkupAnchor = pages.some((page) =>
    /健康体检(?:报告|档案)|体检报告|总检结论|体检综述/.test(page.text)
  );
  if (checkupAnchor) {
    const bestOther = Math.max(0, ...Object.entries(aggregate)
      .filter(([type]) => type !== "checkup")
      .map(([, score]) => score || 0));
    aggregate.checkup = Math.max(aggregate.checkup || 0, bestOther + 1);
    const current = reasons.get("checkup") || [];
    if (!current.includes("整份文档包含体检封面或总检章节")) {
      current.unshift("整份文档包含体检封面或总检章节");
    }
    reasons.set("checkup", current);
  }
  return finalizeClassification(aggregate, reasons);
}

export function mergeContentClassifications(
  classifications: ReportContentClassification[]
): ReportContentClassification {
  const scores: Partial<Record<ReportContentType, number>> = {};
  const reasons = new Map<ReportContentType, string[]>();
  for (const classification of classifications) {
    for (const [type, score] of Object.entries(classification.scores) as Array<[ReportContentType, number]>) {
      scores[type] = (scores[type] || 0) + score;
    }
    const current = reasons.get(classification.primaryType) || [];
    for (const reason of classification.reasons) {
      if (!current.includes(reason)) current.push(reason);
    }
    reasons.set(classification.primaryType, current);
  }
  return finalizeClassification(scores, reasons);
}


/** Preserve explicit vaccination sections in mixed clinical documents. */
export function hasVaccinationContent(value:string){
 const text=medicationText(value);
 return /接种记录|接种凭证|疫苗名称|接种日期|接种剂次|疫苗批号|预防接种/.test(text);
}
