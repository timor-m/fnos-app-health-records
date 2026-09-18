import { getDatabase } from "../database/client";
import { createHash } from "node:crypto";
import { createId } from "../utils/identifier";
import { cleanIndicatorName } from "../utils/indicator-name";
import { isAdministrator, type RequestUser } from "../domain/request-user";
import { createError } from "h3";
import {
  activeIndicatorDictionaryVersion,
  ensureCoreDictionaryMaterialized
} from "./indicator-dictionary.service";
import {
  deriveObservationDisplayAbnormal,
  parseDictionaryReferenceRange
} from "./observation-interpretation.service";
import { assertMemberManage } from "./member.service";
import { assessObservationReference } from "./observation-reference.service";
import { linkedObservationUnitQuotes } from "./observation-unit-evidence.service";

export function activeIndicatorNormalizationVersion() {
  return `indicator-normalization-p10-unit-provenance-v3-${activeIndicatorDictionaryVersion()}`;
}

function normalizationVersion() {
  return activeIndicatorNormalizationVersion();
}

type ObservationRow = {
  id: string;
  reportId: string;
  sectionName: string | null;
  itemCode: string | null;
  itemName: string;
  normalizedName: string | null;
  resultText: string;
  numericValue: number | null;
  unit: string | null;
  referenceLow?: number | null;
  referenceHigh?: number | null;
  referenceText: string | null;
  evidenceJson?: string;
  hasAiExtraction?: number;
  manualReviewed?: number;
  manualCanonicalKey?: string | null;
  manualReviewedBy?: string | null;
  manualReviewedAt?: string | null;
  reportType: string;
  hospitalName: string | null;
  reportIssuedAt?: string | null;
  performingDepartment: string | null;
  reportingDepartment: string | null;
};

type AliasRow = {
  indicatorId: string;
  canonicalKey: string;
  displayName: string;
  category: string;
  specimen: string | null;
  defaultUnit: string | null;
  valueType: "numeric" | "text" | "positive_negative";
  trendEnabled: number;
  explanation: string | null;
  aliasName: string;
  normalizedAlias: string;
  scope: string;
  aliasSource: "builtin" | "user" | "ai_suggestion";
  hospitalName: string | null;
  departmentName: string | null;
  reportType: string | null;
  confidence: number;
  allowedUnitsJson: string | null;
  sectionHintsJson: string | null;
};

export type NormalizationSourceOrigin =
  | "item_name"
  | "item_code"
  | "combined"
  | "ai_normalized_name"
  | "none"
  | "manual_confirmation"
  | "manual_exclusion"
  | "legacy";

export type NormalizationReviewStatus = "unreviewed" | "confirmed" | "excluded";

type AliasCandidate = {
  alias: AliasRow;
  sourceOrigin: Exclude<NormalizationSourceOrigin, "none" | "manual_confirmation" | "manual_exclusion" | "legacy">;
  sourceName: string;
};

export type NormalizationResult = {
  observationId: string;
  indicatorId: string | null;
  canonicalKey: string | null;
  canonicalName: string | null;
  canonicalValue: number | null;
  canonicalUnit: string | null;
  canonicalCategory: string | null;
  canonicalExplanation: string | null;
  confidence: number;
  quality: "high" | "medium" | "low" | "excluded";
  matchedBy: string;
  matchReason: string;
  excludedReason: string | null;
  sourceOrigin: NormalizationSourceOrigin;
  sourceName: string | null;
  aliasSource: "builtin" | "user" | "ai_suggestion" | null;
  reviewStatus: NormalizationReviewStatus;
  reviewedBy: string | null;
  reviewedAt: string | null;
};

export type IndicatorNormalizationMaintenanceResult = {
  scanned: number;
  normalized: number;
  high: number;
  medium: number;
  low: number;
  excluded: number;
  unknown: number;
  pinsMigrated?: number;
};

export type IndicatorNormalizationMaintenanceProgress = {
  totalReports: number;
  processedReports: number;
  result: IndicatorNormalizationMaintenanceResult;
};

export type BuiltinIndicatorBackfillResult = {
  scanned: number;
  updated: number;
  unmatched: number;
  pinsMigrated: number;
  version: string;
};

export type IndicatorNormalizationIssue = {
  fingerprint: string;
  representativeObservationId: string;
  reportId: string;
  canManage: boolean;
  trendEligible: boolean;
  pendingCount: number;
  rawName: string;
  normalizedName: string | null;
  resultText: string;
  unit: string | null;
  sectionName: string | null;
  hospitalName: string | null;
  status: "unknown" | "low" | "excluded";
  reason: string;
  count: number;
  latestReportIssuedAt: string | null;
  candidateCanonicalKey: string | null;
  candidateCanonicalName: string | null;
  candidateDefaultUnit: string | null;
  candidateQuality: "low" | "excluded" | null;
  matchedBy: string | null;
  sourceOrigin: NormalizationSourceOrigin;
};

export type IndicatorCatalogOption = {
  canonicalKey: string;
  displayName: string;
  category: string;
  defaultUnit: string | null;
  aliases: string[];
};

export type IndicatorNormalizationMetrics = {
  version: string;
  generatedAt: string;
  totals: {
    reports: number;
    observations: number;
    normalizationRows: number;
    mapped: number;
    trendEligible: number;
    needsReview: number;
    reviewed: number;
    issueGroups: number;
    decisions: number;
    userAliases: number;
  };
  quality: Record<"high" | "medium" | "low" | "excluded", number>;
  sourceOrigins: Array<{
    sourceOrigin: NormalizationSourceOrigin;
    count: number;
    trendEligible: number;
  }>;
  reportTypes: Array<{
    reportType: string;
    reports: number;
    observations: number;
    mapped: number;
    trendEligible: number;
    needsReview: number;
  }>;
};


export type IndicatorGovernanceResult = {
  pending: number;
  remainingReasons: Array<{ reason: string; count: number }>;
  fingerprint: string;
  action: "confirm" | "exclude";
  affectedObservations: number;
  normalized: number;
  excluded: number;
  aliasSaved: boolean;
  canonicalKey: string | null;
};

export type IndicatorGovernanceHistoryItem = {
  id: string;
  eventType: "apply" | "undo" | "alias_enable" | "alias_disable";
  fingerprint: string | null;
  decisionAction: "confirm" | "exclude" | null;
  rawName: string | null;
  canonicalKey: string | null;
  canonicalName: string | null;
  aliasId: string | null;
  aliasName: string | null;
  aliasScope: "global" | "hospital" | "department" | "report_type" | null;
  reportType: string | null;
  reason: string | null;
  affectedObservations: number;
  actorName: string | null;
  createdAt: string;
  canUndo: boolean;
};

export type IndicatorGovernanceUndoResult = {
  fingerprint: string;
  action: "confirm" | "exclude";
  affectedObservations: number;
  aliasDisabled: boolean;
  remainingMapped: number;
  reopenedIssues: number;
};

export type IndicatorAliasGovernanceItem = {
  id: string;
  aliasName: string;
  normalizedAlias: string;
  scope: "global" | "hospital" | "department" | "report_type";
  hospitalName: string | null;
  departmentName: string | null;
  reportType: string | null;
  canonicalKey: string;
  canonicalName: string;
  category: string;
  enabled: boolean;
  usageCount: number;
  conflictCount: number;
  createdAt: string;
  updatedAt: string;
};

export type IndicatorAliasConflict = {
  normalizedAlias: string;
  scope: "global" | "hospital" | "department" | "report_type";
  hospitalName: string | null;
  departmentName: string | null;
  reportType: string | null;
  targets: Array<{
    aliasId: string;
    aliasName: string;
    canonicalKey: string;
    canonicalName: string;
    source: "builtin" | "user" | "ai_suggestion";
  }>;
};

export type IndicatorAliasGovernanceOverview = {
  aliases: IndicatorAliasGovernanceItem[];
  conflicts: IndicatorAliasConflict[];
};

export type IndicatorAliasUpdateResult = {
  aliasId: string;
  enabled: boolean;
  affectedObservations: number;
  normalized: number;
  reopenedIssues: number;
};

function compactIndicatorKey(value: string | null | undefined) {
  return (value || "")
    .normalize("NFKC")
    .replace(/[(]\s*([GT])\s*[)]/gi, "§$1§")
    .replace(/[（(]\s*(\d+)\s*\/\s*s\s*[）)]/gi, "§$1/s§")
    .toLocaleLowerCase("zh-CN")
    .replace(/[（(].*?[）)]/g, "")
    .replace(/§([gt])§/g, "($1)")
    .replace(/§(\d+\/s)§/gi, "($1)")
    .replace(/\s+/g, "")
    .replace(/[：:，,。.;；、_\-]/g, "")
    .replace(/[＋]/g, "+")
    .trim();
}

const protectedIndicatorQualifiers = /高切|中切|低切|空腹|餐后|随机|卧位|立位|吸气|呼气|左侧|右侧|双侧|直接|间接|总量|定性|定量|绝对值|百分比|百分率|百分数|比例|比率|^\d+\s*\/\s*s$|^[GT]$|^Ig[GMAED]$/i;
const indicatorCodePattern = /^[A-Za-z][A-Za-z0-9.+-]{0,15}[#%]?$/;

/**
 * 生成跨机构通用名称候选。只拆解形如 WBC、NEUT%、ALT 的指标代码，
 * 不移除空腹/餐后、高切/低切、百分比/绝对值等医学条件。
 */
export function indicatorNameCandidates(value: string | null | undefined) {
  // Only remove edge footnote markers from lookup candidates; keep persisted source
  // names, internal operators and measurement qualifiers intact.
  const raw = cleanIndicatorName(value || "").name;
  if (!raw) return [];
  const candidates = new Set<string>();
  const add = (candidate: string | null | undefined) => {
    const compact = compactIndicatorKey(candidate);
    if (compact) candidates.add(compact);
  };
  // 部分报告会把表格序号 OCR 到指标名称前，序号不是指标语义的一部分。
  // 同时覆盖「3.项目」「3、项目」「（3）项目」「No.3 项目」和「3 项目」等变体。
  const withoutLeadingOrdinal = raw
    .replace(/^\s*(?:no\.?\s*)?\d{1,3}\s*[.、)）:：]?\s*/, "")
    .replace(/^\s*[（(]\s*\d{1,3}\s*[）)]\s*/, "");
  if (withoutLeadingOrdinal !== raw && withoutLeadingOrdinal.length >= 2) add(withoutLeadingOrdinal);
  // 报告常把“正常”标记放在项目名前：(N)癌胚抗原。它是状态标记，不是名称的一部分。
  const withoutNormalMarker = raw.replace(/^\s*[（(]\s*N\s*[）)]\s*/i, "");
  if (withoutNormalMarker !== raw && withoutNormalMarker.length >= 2) add(withoutNormalMarker);
  const brackets = [...raw.matchAll(/[（(]([^（）()]*)[）)]/g)];
  const protectedBracket = brackets.some((match) => protectedIndicatorQualifiers.test(match[1] || ""));
  if (protectedBracket) candidates.add(compactQualifiedIndicatorKey(raw));
  else add(raw);

  let withoutCodes = raw;
  for (const match of brackets) {
    const content = (match[1] || "").trim();
    if (/眼压|IOP/i.test(raw) && /^(?:左|右|L|R)$/i.test(content)) {
      add(raw.replace(match[0], content));
    }
    /**
     * 「PWV(右)」「踝臂指数（左）」这类括号侧别命名，字典别名通常是
     * 「右PWV」「右侧baPWV」的前置形式。把侧别词重排到基名前/后生成候选，
     * 侧别限定本身保留在候选里，不会把左右合并成通用项。
     */
    if (/^(?:左|右|左侧|右侧)$/.test(content)) {
      const base = raw.replace(match[0], " ").trim();
      if (base) {
        add(content + base);
        add(base + content);
      }
    }
    if (!indicatorCodePattern.test(content)) continue;
    add(content);
    withoutCodes = withoutCodes.replace(match[0], " ");
  }
  if (withoutCodes !== raw) add(withoutCodes);

  const prefixCode = raw.match(/^\s*([A-Za-z][A-Za-z0-9.+-]{0,15}[#%]?)\s*[-:：/\\]?\s*([\u3400-\u9fff].*)$/);
  if (prefixCode) {
    add(prefixCode[1]);
    add(prefixCode[2]);
  }
  const suffixCode = raw.match(/^(.+?[\u3400-\u9fff）)])\s*[-:：/\\]?\s*([A-Za-z][A-Za-z0-9.+-]{0,15}[#%]?)\s*$/);
  if (suffixCode) {
    add(suffixCode[1]);
    add(suffixCode[2]);
  }
  if (indicatorCodePattern.test(raw)) add(raw);
  /**
   * 「血清泌乳素测定值偏高(24.11ng/ml)(参考值男:2.7-13」「25-羟基维生素D17.23ng/mL:2026-06-15…」
   * 这类名称把结果值、参考范围（含截断未闭合括号）和报告日期粘进了项目名。
   * 值/参考/日期不是名称语义，截断后只追加候选不替换原名。
   */
  const boundarySources = new Set<string>();
  for (const source of [raw, withoutLeadingOrdinal, withoutNormalMarker]) {
    const truncated = source
      .replace(/\s*\d{4}\s*[-/年.]\s*\d{1,2}\s*[-/月.]\s*\d{1,2}.*$/u, "")
      .replace(/[（(][^（）()]*(?:参考值|参考范围|参考区间)[^（）()]*[）)]?/gu, " ")
      // 数字开头括号多为结果值，但 (5/s) 这类剪切率测量条件是指标本体，受保护不剥。
      .replace(/[（(]\s*[-+]?\d[\d.]*[^（）()]*[）)]?/gu, (match) => {
        const inner = match.replace(/^[（(]/, "").replace(/[）)]$/, "").trim();
        return protectedIndicatorQualifiers.test(inner) ? match : " ";
      })
      .replace(/[（(][^（）()]*$/u, " ")
      .trim();
    if (truncated !== source && truncated.length >= 2) boundarySources.add(truncated);
    // 名称与结果值无分隔直接粘连：「25-羟基维生素D17.23ng/mL」，取数值单位前的名称部分。
    const gluedValue = truncated.match(/^(.{2,}?[A-Za-z\u3400-\u9fff）)])[-+]?\d+\.\d+\s*(?:nmol|pmol|mmol|umol|µmol|μmol|mol|mIU|kIU|kU|mU|IU|ng|pg|μg|ug|µg|mg|mEq|mL|dL|g|U|L|%)(?![A-Za-z])/iu);
    if (gluedValue?.[1] && gluedValue[1].trim().length >= 2) boundarySources.add(gluedValue[1].trim());
  }
  for (const source of [...boundarySources]) {
    // 「型串联质谱检测:25-羟基维生素D」「20项过敏原测定:免疫球蛋白E」的检测方法前缀不是名称语义。
    const methodPrefixStripped = source.replace(/^[A-Za-z0-9\u3400-\u9fff,，、]{0,15}?(?:串联质谱|检测|测定|检验|检查|试验|法)\s*[:：]\s*/u, "").trim();
    if (methodPrefixStripped !== source && methodPrefixStripped.length >= 2) boundarySources.add(methodPrefixStripped);
  }
  for (const source of boundarySources) add(source);
  // 结构化结果偶尔被拼进项目名，例如“RV5+SV1:1.75mV”。仅在冒号右侧明显是
  // 数值/单位或异常状态时取左侧，避免破坏真正带冒号的医学名称。
  const cleanedSources = new Set([raw, withoutLeadingOrdinal, withoutNormalMarker, ...boundarySources]);
  for (const source of cleanedSources) {
    const resultSuffix = source.match(/^(.+?)\s*[：:]\s*[-+]?\d+(?:\.\d+)?\s*[A-Za-zμµ%°/²³^0-9·.*]*\s*$/);
    if (resultSuffix?.[1]) add(resultSuffix[1]);
    const reportConclusionPrefix = source.replace(/^您本次体检(?:一般检查)?示\s*/u, "").trim();
    if (reportConclusionPrefix !== source && reportConclusionPrefix.length >= 2) add(reportConclusionPrefix);
    // “血清尿素测定减低”是项目名与异常状态粘连，异常状态不参与字典匹配。
    const abnormalSuffix = source.replace(/(?:结果)?(?:偏高|偏低|升高|降低|增高|减少|减低|异常|正常)$/, "").trim();
    if (abnormalSuffix !== source && abnormalSuffix.length >= 2) {
      add(abnormalSuffix);
      const abnormalMeasurementStripped = abnormalSuffix.replace(/(?:测定|检测)(?:值)?$/, "").trim();
      if (abnormalMeasurementStripped.length >= 2) add(abnormalMeasurementStripped);
    }
    const measurementSuffix = source.replace(/(?:测定|检测)(?:值)?$/, "").trim();
    if (measurementSuffix !== source && measurementSuffix.length >= 2) add(measurementSuffix);
  }
  /**
   * 「血清尿酸值」「pH值」「尿酸测定值」这类命名里的「值/测定值」只是结果占位后缀，
   * 剥掉后才能命中字典别名（如「血清尿酸」）。只追加候选不替换原名，误伤面为零。
   */
  const valueSuffixStripped = raw.replace(/(?:测定|检测)(?:值)?$|值$/, "").trim();
  if (valueSuffixStripped.length >= 2 && valueSuffixStripped !== raw) {
    add(valueSuffixStripped);
  }
  return [...candidates];
}

/** 括号内的测量条件（如高切/低切/中切）是指标本体，不能剥掉后合并趋势。 */
function compactQualifiedIndicatorKey(value: string | null | undefined) {
  return (value || "")
    .normalize("NFKC")
    .replace(/[(]\s*([GT])\s*[)]/gi, "§$1§")
    .toLocaleLowerCase("zh-CN")
    .replace(/§([gt])§/g, "($1)")
    .replace(/\s+/g, "")
    .replace(/[：:，,。.;；、_\-]/g, "")
    .replace(/[＋]/g, "+")
    .trim();
}

function normalizeUnit(value: string | null | undefined) {
  if (!value) return null;
  const unit = value
    .normalize("NFKC")
    .replace(/\s+/g, "")
    .replace(/[／⁄]/g, "/")
    .replace(/[×xX*]/g, "×")
    .replace(/[μµ]/g, "μ")
    .replace(/﹪/g, "%")
    /* OCR 噪声：科学计数指数的上标或分隔符常丢失/误读（10⁹→109、10°9、10~6），
       在“10 + 指数 + /”的单位语境下统一补回 ^，如 ×109/L→×10^9/L、10~6/L→10^6/L */
    .replace(/^(×?)10[°˚~^]([1-9]\d?)(?=\/)/, "$110^$2")
    .replace(/^(×)10([1-9]\d?)(?=\/)/, "$110^$2")
    .replace(/^10([1-9]\d?)(?=\/[lμ])/i, "10^$1");
  const lower = unit.toLocaleLowerCase();
  return unitAliases[lower] || unit || null;
}

/*
 * 单位别名表（模块级）：normalizeUnit 归一化与证据锚定的反向查找共用。
 * 键为预处理（去空白、全角转半角、μ 归一）并小写后的形态，值为规范写法。
 */
const unitAliases: Record<string, string> = {
    "mmol/l": "mmol/L",
    "μmol/l": "μmol/L",
    "umol/l": "μmol/L",
    /* OCR 形近字：umo1/L（数字 1 代替字母 l）等 */
    "umo1/l": "μmol/L",
    "μmo1/l": "μmol/L",
    "mmo1/l": "mmol/L",
    /* μmoI/L（大写 I 代替字母 l） */
    "μmoi/l": "μmol/L",
    "umoi/l": "μmol/L",
    /* OCR 丢斜杠：mmolL→mmol/L 等（U/L、μL 折叠后歧义，不收） */
    "mmoll": "mmol/L",
    "umoll": "μmol/L",
    "μmoll": "μmol/L",
    "nmoll": "nmol/L",
    "pmoll": "pmol/L",
    "mgdl": "mg/dL",
    "mgl": "mg/L",
    "ngml": "ng/mL",
    "μgl": "μg/L",
    "ugl": "μg/L",
    "mg/dl": "mg/dL",
    "mg/l": "mg/L",
    "g/l": "g/L",
    "g/dl": "g/dL",
    "u/l": "U/L",
    "u/ml": "U/mL",
    "iu/l": "U/L",
    "miu/l": "mIU/L",
    "uiu/ml": "μIU/mL",
    "μiu/ml": "μIU/mL",
    "pmol/l": "pmol/L",
    "nmol/l": "nmol/L",
    "ng/ml": "ng/mL",
    "μg/l": "μg/L",
    "pg/ml": "pg/mL",
    "ng/dl": "ng/dL",
    "meq/l": "mEq/L",
    "iu/ml": "IU/mL",
    "kiu/l": "IU/mL",
    "copies/ml": "copies/mL",
    "kg/m2": "kg/m²",
    "kg/m²": "kg/m²",
    "kg/㎡": "kg/m²",
    "mmhg": "mmHg",
    "mv": "mV",
    "angle": "°",
    "deg": "°",
    "degree": "°",
    "°": "°",
    "bpm": "次/分",
    "次/min": "次/分",
    "次/分钟": "次/分",
    "次/分": "次/分",
    "fl": "fL",
    /* OCR 形近误读：f1（数字 1 代替字母 l） */
    "f1": "fL",
    "pg": "pg",
    "l": "L",
    "ml": "mL",
    "l/s": "L/s",
    "l/sec": "L/s",
    "l/秒": "L/s",
    "ml/s": "mL/s",
    "ml/sec": "mL/s",
    "ml/秒": "mL/s",
    "mpa.s": "mPa·s",
    "mpa·s": "mPa·s",
    "mpa*s": "mPa·s",
    "mpas": "mPa·s",
    "mm/hr": "mm/h",
    "mm/hour": "mm/h",
    "毫米/小时": "mm/h",
    "l/l": "L/L",
    "ml/min/1.73m2": "mL/min/1.73m²",
    "ml/min/1.73m²": "mL/min/1.73m²",
    "/hpf": "/HPF",
    "cell/hp": "/HPF",
    "/lpf": "/LPF",
    "/ul": "/μL",
    "/μl": "/μL",
    "cast/lp": "/LPF",
    "个/lpf": "/LPF",
    "个/hpf": "/HPF",
    "cells/hpf": "/HPF",
    "个/μl": "个/μL",
    "cells/μl": "个/μL",
    "kg": "kg",
    "千克": "kg",
    "公斤": "kg",
    "g": "g",
    "克": "g",
    "m": "m",
    "米": "m",
    "cm": "cm",
    "厘米": "cm",
    "mm": "mm",
    "毫米": "mm",
    "10^9/l": "10^9/L",
    "10*9/l": "10^9/L",
    "×10^9/l": "10^9/L",
    "10^12/l": "10^12/L",
    "10*12/l": "10^12/L",
    "×10^12/l": "10^12/L",
    "10^3/μl": "10^3/μL",
    "10^6/μl": "10^6/μL",
    /* OCR 形近误读：数字 1 代替字母 l/I（f1→fL、m1→mL、mg/d1→mg/dL、1U/L→IU/L 等）。
       独立 "u1" 不收——U/L 丢斜杠与 μL 误读无法区分。 */
    "m1": "mL",
    "g/1": "g/L",
    "mg/1": "mg/L",
    "ug/1": "μg/L",
    "μg/1": "μg/L",
    "g/d1": "g/dL",
    "mg/d1": "mg/dL",
    "ng/d1": "ng/dL",
    "μg/d1": "μg/dL",
    "ng/m1": "ng/mL",
    "pg/m1": "pg/mL",
    "mmol/1": "mmol/L",
    "umol/1": "μmol/L",
    "μmol/1": "μmol/L",
    "nmol/1": "nmol/L",
    "pmol/1": "pmol/L",
    "meq/1": "mEq/L",
    "u/1": "U/L",
    "l/1": "L/L",
    "1u/l": "IU/L",
    "lu/l": "IU/L",
    "m1u/l": "mIU/L",
    "uiu/m1": "μIU/mL",
    "μiu/m1": "μIU/mL",
    "10^9/1": "10^9/L",
    "10^12/1": "10^12/L",
    "×10^9/1": "×10^9/L",
    "×10^12/1": "×10^12/L",
    "10^3/u1": "10^3/μL",
    "10^6/u1": "10^6/μL",
    "/u1": "/μL",
    "个/u1": "个/μL",
    "cells/u1": "cells/μL",
    /* OCR 形近误读：数字 9 代替字母 g（p9→pg、mmH9→mmHg） */
    "p9": "pg",
    "p9/ml": "pg/mL",
    "mmh9": "mmHg",
    "%": "%"
  };

function parseNumericResultText(value: string | null | undefined) {
  if (!value) return null;
  const normalized = value.replace(/,/g, "").replace(/[<>≤≥]/g, " ");
  const match = normalized.match(/[-+]?\d+(?:\.\d+)?/);
  if (!match) return null;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

function observationEvidenceNumbers(value: unknown) {
  const normalized = String(value || "").normalize("NFKC").replace(/[−–—]/g, "-");
  return [...normalized.matchAll(/(?:^|[^\d.])([-+]?\d+(?:\.\d+)?)(?![\d.])/g)]
    .map((match) => Number(match[1]))
    .filter((number) => Number.isFinite(number));
}

function sameObservationEvidenceNumber(left: number, right: number) {
  return Math.abs(left - right) <= Math.max(1e-12, Math.abs(left) * 1e-12);
}

function compactObservationEvidence(value: unknown) {
  return String(value || "").normalize("NFKC").toLocaleLowerCase("zh-CN")
    .replace(/[μµ]/g, "u")
    .replace(/[×✕✖＊*]/g, "x")
    .replace(/[²㎡]/g, "2")
    .replace(/[³]/g, "3")
    .replace(/[–—−~～]/g, "-")
    .replace(/[≤≦]/g, "<=")
    .replace(/[≥≧]/g, ">=")
    .replace(/[（）()，,。.:：;；、|｜\s_]/g, "");
}

function observationEvidenceQuotes(row: Pick<ObservationRow, "evidenceJson">) {
  if (typeof row.evidenceJson !== "string") return [];
  try {
    const parsed = JSON.parse(row.evidenceJson) as Array<{ pageNumber?: unknown; quote?: unknown }>;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry) => {
      const quote = typeof entry?.quote === "string" ? entry.quote.trim() : "";
      const pageNumber = Number(entry?.pageNumber);
      return quote && Number.isFinite(pageNumber) && pageNumber > 0 ? [quote] : [];
    });
  } catch {
    return [];
  }
}

/**
 * 结果层质量闸门不删除 observation，只阻止缺少来源闭环或字段互相矛盾的结果进入默认趋势。
 * 人工治理仍可在后续明确确认或排除。
 */
function pulmonaryObservationContext(row: ObservationRow) {
  const context = [
    row.sectionName,
    row.reportType,
    row.performingDepartment,
    row.reportingDepartment
  ].filter(Boolean).join(" ");
  return /肺功能|肺通气|呼吸功能|肺量计|spirom/i.test(context);
}

function compactFunctionalObservationName(value: string | null | undefined) {
  return (value || "")
    .normalize("NFKC")
    .toUpperCase()
    .replace(/\s+/g, "")
    .replace(/[％﹪]/g, "%")
    .replace(/[／⁄]/g, "/")
    .replace(/[–—~～至]/g, "-");
}

/**
 * 功能检查设备会输出大量派生量和质量控制参数。它们仍保留为 observation 便于审计，
 * 但不进入未知指标队列或默认趋势，避免家庭用户看到设备内部参数堆积。
 */
function functionalDeviceObservationExclusionReason(row: ObservationRow) {
  if (!pulmonaryObservationContext(row)) return null;
  const name = compactFunctionalObservationName(row.itemName);
  if (!name) return null;
  if (/\/HT(?:$|[（(])/.test(name)) return "身高校正派生量不作为独立健康趋势";
  if (/^(?:PEF[-_]?TIME|FET|V[-_]?EXTRAP|EXTRAP[-_]?V)$/.test(name)) {
    return "肺功能设备质量控制参数不作为独立健康趋势";
  }
  if (/^(?:PRED(?:ICTED)?|%PRED|PRED%|预计值|预测值|参考值|实测值|本次结果)$/.test(name)) {
    return "预测值、参考值或列标签不是本次独立测量";
  }
  if (/^(?:FEF|MEF)\d+(?:\.\d+)?\/(?:FEF|FIF|MEF|MIF)\d+(?:\.\d+)?$/.test(name)) {
    return "分段流量比属于专用派生参数，不默认进入家庭趋势";
  }
  if (/\/VCPR(?:$|[（(])/.test(name)) {
    return "预测值派生比例不是本次独立测量";
  }
  if (/^FEV0[.]5$/.test(name)) {
    return "次要时段呼气容积不默认进入家庭趋势";
  }
  if (/^FEF\d+(?:\.\d+)?-\d+(?:\.\d+)?%?$/.test(name)
    && !/^FEF25-75%?$/.test(name)) {
    return "设备分段区间流量不默认进入家庭趋势";
  }
  if (/^([A-Z]{2,6})\d{1,3}-\d{1,3}[（(]\1\d{1,2}[）)]$/.test(name)) {
    return "不透明设备区间代码缺少可解释的医学指标语义";
  }
  return null;
}

function excludedFunctionalDeviceObservation(row: ObservationRow, reason: string): NormalizationResult {
  return {
    observationId: row.id,
    indicatorId: null,
    canonicalKey: null,
    canonicalName: null,
    canonicalValue: null,
    canonicalUnit: null,
    canonicalCategory: "功能检查",
    canonicalExplanation: null,
    confidence: 1,
    quality: "excluded",
    matchedBy: "functional_device_filter",
    matchReason: reason,
    excludedReason: reason,
    sourceOrigin: "item_name",
    sourceName: row.itemName,
    aliasSource: null,
    reviewStatus: "unreviewed",
    reviewedBy: null,
    reviewedAt: null
  };
}

export function isPolicyFilteredNormalization(matchedBy: string | null | undefined) {
  return matchedBy === "functional_device_filter" || matchedBy === "observation_noise_filter";
}

/**
 * AI/OCR 偶尔会把表头、章节标题和只有算法内部含义的短代码建成 observation。
 * 它们保留在原始结果中供审计，但不进入趋势或指标字典收录申请。
 */
function observationNoiseExclusionReason(row: ObservationRow) {
  const name = (row.itemName || "").normalize("NFKC").replace(/\s+/g, "").trim();
  if (!name) return null;
  if (/^切变率[（(]?1\/?S[）)]?\d+(?:\.\d+)?$/i.test(name)) {
    return "血流变表格的切变率条件标签不是独立健康指标";
  }
  if (/^(?:小结|血流变|血液流变|甲状腺激素)$/.test(name)) {
    return "报告章节标题或汇总标签不是独立健康指标";
  }
  const context = [row.sectionName, row.reportType, row.performingDepartment, row.reportingDepartment]
    .filter(Boolean)
    .join(" ");
  if (/^(?:UTN|UTL|SAAP)$/i.test(name) && /动脉|血管|ABI|PWV|功能检查/i.test(context)) {
    return "血管检查设备短代码缺少可解释且稳定的独立指标语义";
  }
  return null;
}

function excludedObservationNoise(row: ObservationRow, reason: string): NormalizationResult {
  return {
    observationId: row.id,
    indicatorId: null,
    canonicalKey: null,
    canonicalName: null,
    canonicalValue: null,
    canonicalUnit: null,
    canonicalCategory: null,
    canonicalExplanation: null,
    confidence: 1,
    quality: "excluded",
    matchedBy: "observation_noise_filter",
    matchReason: reason,
    excludedReason: reason,
    sourceOrigin: "item_name",
    sourceName: row.itemName,
    aliasSource: null,
    reviewStatus: "unreviewed",
    reviewedBy: null,
    reviewedAt: null
  };
}

export function assessPersistedObservationReference(row: {
  referenceLow?: number | null;
  referenceHigh?: number | null;
  referenceText?: string | null;
  evidenceJson?: string;
  hasAiExtraction?: number;
  manualReviewed?: number | boolean;
}) {
  const reference = assessObservationReference({
    low: row.referenceLow, high: row.referenceHigh, text: row.referenceText
  });
  if (reference.status !== "trusted" || !row.hasAiExtraction || row.manualReviewed) return reference;
  const numbers = observationEvidenceQuotes(row).flatMap(observationEvidenceNumbers);
  if ([reference.low, reference.high].some((bound) => bound !== null
    && !numbers.some((value) => sameObservationEvidenceNumber(value, bound)))) {
    return {
      ...reference, low: null, high: null, status: "raw_only" as const,
      reason: "参考范围无法回指 OCR 证据，已停止用于自动判定"
    };
  }
  return reference;
}

/**
 * 视觉复核来源的观测：数值与单位以页面图片为准，可能本就不存在于 OCR 文本
 * （OCR 误读正是复核要修正的场景）。此类观测的验收门已在视觉复核阶段锚定
 * 真实 OCR 候选行，这里识别"全部证据均为视觉来源"以跳过数值/单位回指。
 */
function visionOnlyEvidence(row: Pick<ObservationRow, "evidenceJson">) {
  if (typeof row.evidenceJson !== "string") return false;
  try {
    const parsed = JSON.parse(row.evidenceJson) as unknown;
    if (!Array.isArray(parsed) || !parsed.length) return false;
    return parsed.every((entry) => {
      if (!entry || typeof entry !== "object") return false;
      const item = entry as { source?: unknown; quote?: unknown; pageNumber?: unknown };
      return (
        item.source === "vision" &&
        typeof item.quote === "string" &&
        Boolean(item.quote.trim()) &&
        Number(item.pageNumber) > 0
      );
    });
  } catch {
    return false;
  }
}

function observationEvidenceQualityIssue(row: ObservationRow) {
  // 内存待落库项与未经过 AI 持久化链路的历史/手工数据不套用本闸门。
  if (row.evidenceJson === undefined || !row.hasAiExtraction) return null;
  const manuallyReviewed = Boolean(row.manualReviewed);
  // 纯视觉来源与人工确认同等对待：跳过名称/数值/单位的 OCR 回指，
  // 但仍要求存在可核验证据（验收门已保证 quote 是真实 OCR 候选行）。
  const anchorBypassed = manuallyReviewed || visionOnlyEvidence(row);
  const quotes = observationEvidenceQuotes(row);
  if (!quotes.length && !manuallyReviewed) return "缺少可核验的 OCR 证据，禁止进入默认趋势";
  const nameSearchQuotes = quotes.flatMap((quote) => [
    compactObservationEvidence(quote),
    compactIndicatorKey(quote),
  ]).filter(Boolean);
  const nameCandidates = [row.itemName, row.itemCode]
    .flatMap(indicatorNameCandidates)
    .map(compactObservationEvidence)
    .filter((value) => value.length >= 2);
  const numericValue = row.numericValue ?? parseNumericResultText(row.resultText);
  const sourceNumbers = quotes.flatMap(observationEvidenceNumbers);
  const nameBackReferenced = !nameCandidates.length || nameSearchQuotes.some((quote) =>
    nameCandidates.some((name) => quote.includes(name) || name.includes(quote))
  );
  if (!anchorBypassed && !nameBackReferenced) {
    // AI 常把原文口语化表述规范为标准名（如「左踝：1.08」→「左侧踝肱指数」），
    // 名称字面无法回指但数值锚点完整时，不否决整条证据链；
    // 仅当名称与数值都无法回指时才判定证据链断裂。
    const numericAnchored = numericValue !== null
      && sourceNumbers.some((value) => sameObservationEvidenceNumber(value, numericValue));
    if (!numericAnchored) return "项目名称无法回指 OCR 证据，禁止进入默认趋势";
  }

  const resultValue = parseNumericResultText(row.resultText);
  if (numericValue !== null && resultValue !== null && !sameObservationEvidenceNumber(numericValue, resultValue)) {
    return "结构化数值与结果文本不一致，禁止进入默认趋势";
  }
  if (!anchorBypassed && numericValue !== null && !sourceNumbers.some((value) => sameObservationEvidenceNumber(value, numericValue))) {
    return "结果数值无法回指 OCR 证据，禁止进入默认趋势";
  }

  const rawUnit = row.unit?.trim() || null;
  if (!anchorBypassed && rawUnit) {
    // A printed multiplication sign before a power-of-ten unit is notation, not a unit prefix.
    const compactUnit = (text: string | null) => compactObservationEvidence(text)
      .replace(/(?<![a-z])x(?=10\^\d+\/)/gi, '');
    /* 矫正后的规范单位需容忍原文中的 OCR 变体（fL 被识别为 f1 等），
       否则矫正越成功、单位越无法回指证据。变体从单位别名表反向生成，新增别名自动生效；
       normalizeUnit 的正则形态（109/L→10^9/L）同样反推去上标变体，
       否则 AI 规范化返回的单位无法锚定原文的丢上标写法。 */
    const normalizedRawUnit = normalizeUnit(rawUnit);
    const caretless = normalizedRawUnit
      ? normalizedRawUnit.replace(/^(×?)10\^([1-9]\d?)(?=\/)/i, "$110$2")
      : null;
    const unitCandidates = [...new Set(
      [rawUnit, normalizedRawUnit]
        .filter(Boolean)
        .concat(Object.keys(unitAliases).filter(variant => unitAliases[variant] === normalizedRawUnit))
        .concat(caretless && caretless !== normalizedRawUnit ? [caretless] : []),
    )].map(compactUnit);
    const containsUnit = (quote: string) => unitCandidates.some(unit => {
      const escaped = unit.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      // A smaller unit token must not match inside another prefix or compound unit (g/L in mg/L).
      const unitText = quote.split(/[（）()，,。:：;；、|｜]+/).map(compactUnit).join(' ');
      return new RegExp(`(?<![a-zµμ])${escaped}(?![a-zµμ/])`, 'i').test(unitText);
    });
    const unitAnchored = quotes.some(containsUnit)
      || linkedObservationUnitQuotes(row.reportId, row.evidenceJson)
        .some(containsUnit);
    if (!unitAnchored) {
      return "结果单位无法回指 OCR 证据，禁止进入默认趋势";
    }
  }
  // Reference validity affects interpretation, not the measured point's eligibility.
  return null;
}

/** Shared admission for report detail and trend publication. Dictionary confidence is not result evidence. */
export function assessTrendAdmission(input: {
  reportId: string; itemName: string; itemCode?: string | null; sectionName?: string | null;
  numericValue: number | null; resultText: string; unit: string | null; evidenceJson: string;
  normalizationQuality?: string | null; normalizationMatchedBy?: string | null;
  normalizationExcludedReason?: string | null; canonicalKey?: string | null; canonicalName?: string | null;
  hasAiExtraction?: number; manualReviewed?: number | boolean;
  hospitalName?: string | null; reportType?: string; reportIssuedAt?: string | null;
}) {
  const deny = (reason: string) => ({ eligible: false, kind: null, reason } as const);
  if (input.normalizationQuality === 'excluded' || isPolicyFilteredNormalization(input.normalizationMatchedBy || '')) {
    return deny(input.normalizationExcludedReason || '已排除或不适用数值趋势');
  }
  const value = input.numericValue ?? parseNumericResultText(input.resultText);
  if (value === null || !Number.isFinite(value)) return deny('不是可用的数值结果');
  const textValue = parseNumericResultText(input.resultText);
  if (textValue !== null && !sameObservationEvidenceNumber(value, textValue)) {
    return deny('结构化数值与结果文本不一致，请核对数值和结果文本');
  }
  const standard = Boolean(input.canonicalKey && input.canonicalName && ['high', 'medium'].includes(input.normalizationQuality || ''));
  if (!standard && (input.canonicalKey || input.canonicalName || input.normalizationMatchedBy !== 'none')) {
    return deny(input.normalizationExcludedReason || '标准身份、单位或结果仍需核对');
  }
  const row: ObservationRow = {
    ...input, numericValue: value, id: '', normalizedName: null, sectionName: input.sectionName || null, itemCode: input.itemCode || null,
    referenceText: null, reportType: input.reportType || '', hospitalName: input.hospitalName || null,
    performingDepartment: null, reportingDepartment: null, manualReviewed: input.manualReviewed ? 1 : 0,
    // Legacy standard records retain their existing admission; unknown records always require evidence or manual review.
    hasAiExtraction: standard ? input.hasAiExtraction : 1,
  };
  const issue = observationEvidenceQualityIssue(row);
  if (issue) return deny(issue);
  if (standard) return { eligible: true, kind: 'standard', reason: null } as const;
  const noise = functionalDeviceObservationExclusionReason(row) || observationNoiseExclusionReason(row);
  if (noise) return deny(noise);
  // 纯指标型报告可能整单没有机构名称：缺失时不阻断趋势，进入“机构未确认”隔离分组；
  // 后续补充机构后趋势键变化，该报告的点自动归入对应机构分组。
  if (!Number.isFinite(Date.parse(input.reportIssuedAt || ''))) return deny('请先确认报告日期');
  if (!input.unit?.trim()) return deny('未标准化结果需先确认单位');
  // 机构内数值必须是明确的单值结果：允许“5.30 (mmol/L)↑”这类数值+内联单位/箭头写法
  //（提取管线的常见输出），拒绝“<2”“5.3-6.1”等限值或区间表达；数值与文本一致性已在上方校验。
  if (textValue === null || !/^[+-]?\d+(?:\.\d+)?\s*(?:[(（][^)）]*[)）]\s*)?[↑↓▲▼⬆⬇]?$/.test(input.resultText.trim())) {
    return deny('结果不是明确数值或与结果文本不一致');
  }
  // Unknown names cannot borrow the standard-name evidence fallback (which tolerates AI synonyms).
  if (!input.manualReviewed && !observationEvidenceQuotes(row).some(quote => compactObservationEvidence(quote).includes(compactObservationEvidence(input.itemName)))) {
    return deny('未标准化项目名称无法回指 OCR 证据');
  }
  if (!input.manualReviewed && observationEvidenceQuotes(row).some(quote => {
    const bounds = quote.normalize('NFKC').matchAll(/[<>≤≥]\s*([-+]?\d+(?:\.\d+)?)/g);
    return [...bounds].some(match => Number(match[1]) === value);
  })) return deny('OCR 证据包含同值的限值表达，需人工确认是否为实测数值');
  return { eligible: true, kind: 'institution', reason: '机构内原始数值，未匹配标准字典' } as const;
}

function canConvertIndicatorUnit(canonicalKey: string, fromUnit: string, toUnit: string) {
  if (fromUnit === toUnit) return true;
  const pair = `${fromUnit}->${toUnit}`;
  if (["body_weight"].includes(canonicalKey) && ["g->kg", "kg->g"].includes(pair)) return true;
  if (["body_height", "body_waist_circumference", "body_hip_circumference"].includes(canonicalKey)
    && ["m->cm", "cm->m"].includes(pair)) return true;
  if (["cm->mm", "mm->cm"].includes(pair)) return true;
  if (["lipid_tc", "lipid_hdl_c", "lipid_ldl_c", "lipid_tg", "glucose_fasting",
    "glucose_postprandial_2h", "glucose_random"].includes(canonicalKey)
    && ["mg/dL->mmol/L", "mmol/L->mg/dL"].includes(pair)) return true;
  if (["cbc_hgb", "cbc_mchc", "liver_total_protein", "liver_albumin", "liver_globulin"].includes(canonicalKey)
    && ["g/dL->g/L", "g/L->g/dL"].includes(pair)) return true;
  if (canonicalKey === "cbc_hct" && ["L/L->%", "%->L/L"].includes(pair)) return true;
  if (["renal_creatinine", "renal_uric_acid", "liver_tbil", "liver_dbil", "liver_ibil"].includes(canonicalKey)
    && ["mg/dL->μmol/L", "μmol/L->mg/dL"].includes(pair)) return true;
  if (["renal_urea", "renal_bun"].includes(canonicalKey)
    && ["mg/dL->mmol/L", "mmol/L->mg/dL"].includes(pair)) return true;
  if (["pulmonary_vc", "pulmonary_ic", "pulmonary_tv", "pulmonary_irv", "pulmonary_erv",
    "pulmonary_fvc", "pulmonary_fev1"].includes(canonicalKey)
    && ["mL->L", "L->mL"].includes(pair)) return true;
  if (["pulmonary_pef", "pulmonary_fef25", "pulmonary_fef50", "pulmonary_fef75", "pulmonary_mmef"].includes(canonicalKey)
    && ["mL/s->L/s", "L/s->mL/s"].includes(pair)) return true;
  if (["laboratory_testosterone", "laboratory_prolactin", "laboratory_pepsinogen_i", "laboratory_pepsinogen_ii"].includes(canonicalKey)
    && ["μg/L->ng/mL", "ng/mL->μg/L"].includes(pair)) return true;
  if (canonicalKey === "laboratory_testosterone"
    && ["ng/dL->ng/mL", "ng/mL->ng/dL"].includes(pair)) return true;
  if (canonicalKey === "c_peptide_postprandial_2h"
    && ["μg/L->ng/mL", "ng/mL->μg/L", "ng/mL->nmol/L", "nmol/L->ng/mL",
      "μg/L->nmol/L", "nmol/L->μg/L"].includes(pair)) return true;
  return false;
}

function parseStringList(value: string | null | undefined) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function textHasAny(value: string, hints: string[]) {
  const compact = compactIndicatorKey(value);
  return hints.some((hint) => compact.includes(compactIndicatorKey(hint)));
}

function allowedUnitsFor(row: Pick<AliasRow, "allowedUnitsJson">) {
  return new Set(parseStringList(row.allowedUnitsJson).map((unit) => normalizeUnit(unit)).filter(Boolean));
}

function resolveIndicatorUnitCompatibility(
  canonicalKey: string,
  rawUnitValue: string | null | undefined,
  defaultUnitValue: string | null | undefined,
  allowedUnitsJson: string | null | undefined
) {
  const rawUnit = normalizeUnit(rawUnitValue);
  const defaultUnit = normalizeUnit(defaultUnitValue);
  const allowedUnits = allowedUnitsFor({ allowedUnitsJson: allowedUnitsJson || null });
  const compatible = !rawUnit
    || rawUnit === defaultUnit
    || allowedUnits.has(rawUnit)
    || Boolean(defaultUnit && canConvertIndicatorUnit(canonicalKey, rawUnit, defaultUnit));
  return {
    rawUnit,
    compatible,
    canonicalUnit: compatible ? defaultUnit || rawUnit : null
  };
}

export function convertUnit(canonicalKey: string, value: number, fromUnit: string | null, toUnit: string | null) {
  if (value === null || !fromUnit || !toUnit || fromUnit === toUnit) return value;
  const lipidKeys = new Set(["lipid_tc", "lipid_hdl_c", "lipid_ldl_c"]);
  if (lipidKeys.has(canonicalKey) && fromUnit === "mg/dL" && toUnit === "mmol/L") return value / 38.67;
  if (lipidKeys.has(canonicalKey) && fromUnit === "mmol/L" && toUnit === "mg/dL") return value * 38.67;
  if (canonicalKey === "lipid_tg" && fromUnit === "mg/dL" && toUnit === "mmol/L") return value / 88.57;
  if (canonicalKey === "lipid_tg" && fromUnit === "mmol/L" && toUnit === "mg/dL") return value * 88.57;
  if (["glucose_fasting", "glucose_postprandial_2h", "glucose_random"].includes(canonicalKey)
    && fromUnit === "mg/dL" && toUnit === "mmol/L") return value / 18.018;
  if (["glucose_fasting", "glucose_postprandial_2h", "glucose_random"].includes(canonicalKey)
    && fromUnit === "mmol/L" && toUnit === "mg/dL") return value * 18.018;
  if (["cbc_hgb", "cbc_mchc", "liver_total_protein", "liver_albumin", "liver_globulin"].includes(canonicalKey)
    && fromUnit === "g/dL" && toUnit === "g/L") return value * 10;
  if (["cbc_hgb", "cbc_mchc", "liver_total_protein", "liver_albumin", "liver_globulin"].includes(canonicalKey)
    && fromUnit === "g/L" && toUnit === "g/dL") return value / 10;
  if (canonicalKey === "cbc_hct" && fromUnit === "L/L" && toUnit === "%") return value * 100;
  if (canonicalKey === "cbc_hct" && fromUnit === "%" && toUnit === "L/L") return value / 100;
  if (canonicalKey === "renal_creatinine" && fromUnit === "mg/dL" && toUnit === "μmol/L") return value * 88.4;
  if (canonicalKey === "renal_creatinine" && fromUnit === "μmol/L" && toUnit === "mg/dL") return value / 88.4;
  if (canonicalKey === "renal_uric_acid" && fromUnit === "mg/dL" && toUnit === "μmol/L") return value * 59.48;
  if (canonicalKey === "renal_uric_acid" && fromUnit === "μmol/L" && toUnit === "mg/dL") return value / 59.48;
  if (canonicalKey === "renal_urea" && fromUnit === "mg/dL" && toUnit === "mmol/L") return value * 0.1665;
  if (canonicalKey === "renal_urea" && fromUnit === "mmol/L" && toUnit === "mg/dL") return value / 0.1665;
  if (canonicalKey === "renal_bun" && fromUnit === "mg/dL" && toUnit === "mmol/L") return value * 0.357;
  if (canonicalKey === "renal_bun" && fromUnit === "mmol/L" && toUnit === "mg/dL") return value / 0.357;
  if (["liver_tbil", "liver_dbil", "liver_ibil"].includes(canonicalKey)
    && fromUnit === "mg/dL" && toUnit === "μmol/L") return value * 17.104;
  if (["liver_tbil", "liver_dbil", "liver_ibil"].includes(canonicalKey)
    && fromUnit === "μmol/L" && toUnit === "mg/dL") return value / 17.104;
  if (canonicalKey === "body_weight" && fromUnit === "g" && toUnit === "kg") return value / 1000;
  if (canonicalKey === "body_weight" && fromUnit === "kg" && toUnit === "g") return value * 1000;
  if (["pulmonary_vc", "pulmonary_ic", "pulmonary_tv", "pulmonary_irv", "pulmonary_erv",
    "pulmonary_fvc", "pulmonary_fev1"].includes(canonicalKey)
    && fromUnit === "mL" && toUnit === "L") return value / 1000;
  if (["pulmonary_vc", "pulmonary_ic", "pulmonary_tv", "pulmonary_irv", "pulmonary_erv",
    "pulmonary_fvc", "pulmonary_fev1"].includes(canonicalKey)
    && fromUnit === "L" && toUnit === "mL") return value * 1000;
  if (["pulmonary_pef", "pulmonary_fef25", "pulmonary_fef50", "pulmonary_fef75", "pulmonary_mmef"].includes(canonicalKey)
    && fromUnit === "mL/s" && toUnit === "L/s") return value / 1000;
  if (["pulmonary_pef", "pulmonary_fef25", "pulmonary_fef50", "pulmonary_fef75", "pulmonary_mmef"].includes(canonicalKey)
    && fromUnit === "L/s" && toUnit === "mL/s") return value * 1000;
  if (["laboratory_testosterone", "laboratory_prolactin", "laboratory_pepsinogen_i", "laboratory_pepsinogen_ii"].includes(canonicalKey)
    && ((fromUnit === "μg/L" && toUnit === "ng/mL") || (fromUnit === "ng/mL" && toUnit === "μg/L"))) return value;
  if (canonicalKey === "laboratory_testosterone" && fromUnit === "ng/dL" && toUnit === "ng/mL") return value / 100;
  if (canonicalKey === "laboratory_testosterone" && fromUnit === "ng/mL" && toUnit === "ng/dL") return value * 100;
  if (canonicalKey === "c_peptide_postprandial_2h"
    && ((fromUnit === "μg/L" && toUnit === "ng/mL") || (fromUnit === "ng/mL" && toUnit === "μg/L"))) return value;
  // C 肽换算按分子量 3020：1 ng/mL（= 1 μg/L）= 0.331 nmol/L
  if (canonicalKey === "c_peptide_postprandial_2h"
    && (fromUnit === "ng/mL" || fromUnit === "μg/L") && toUnit === "nmol/L") return value * 0.331;
  if (canonicalKey === "c_peptide_postprandial_2h"
    && fromUnit === "nmol/L" && (toUnit === "ng/mL" || toUnit === "μg/L")) return value / 0.331;
  if (["body_height", "body_waist_circumference", "body_hip_circumference"].includes(canonicalKey)
    && fromUnit === "m" && toUnit === "cm") return value * 100;
  if (["body_height", "body_waist_circumference", "body_hip_circumference"].includes(canonicalKey)
    && fromUnit === "cm" && toUnit === "m") return value / 100;
  if (fromUnit === "cm" && toUnit === "mm") return value * 10;
  if (fromUnit === "mm" && toUnit === "cm") return value / 10;
  return value;
}

function classifyQuality(score: number, row: ObservationRow, indicator: AliasRow): NormalizationResult["quality"] {
  if (!indicator.trendEnabled || indicator.valueType !== "numeric") return "excluded";
  const numericValue = row.numericValue ?? parseNumericResultText(row.resultText);
  if (numericValue === null) return "excluded";
  if (score >= 90) return "high";
  if (score >= 65) return "medium";
  return "low";
}

/** 判断 genericKey 是否是 specificKey 的侧别通用父项（如 vascular_abi → vascular_abi_left）。 */
function isLateralityGenericParentOf(genericKey: string, specificKey: string) {
  return specificKey === `${genericKey}_left` || specificKey === `${genericKey}_right`;
}

function exclusionReason(row: ObservationRow, indicator: AliasRow, unitCompatible: boolean) {
  if (!indicator.trendEnabled) return "该指标属于状态型或文本型结果，不默认进入折线趋势";
  if (indicator.valueType !== "numeric") return "该指标不是数值型结果，不默认进入折线趋势";
  if ((row.numericValue ?? parseNumericResultText(row.resultText)) === null) return "没有可靠数值";
  if (!unitCompatible) return "单位与标准指标不兼容";
  return null;
}

/**
 * 已命中字典、但按指标定义（状态/文本型或非数值型）不进入折线趋势的结果。
 * 这是字典的既定守门而非待治理缺口，与 OCR 证据失败一样豁免出治理池。
 */
function isDesignGatedQualitativeExclusion(excludedReason: string | null | undefined) {
  return Boolean(excludedReason && excludedReason.includes("不默认进入折线趋势"));
}

export function ensureBuiltinIndicatorCatalog() {
  ensureCoreDictionaryMaterialized();
}

function candidateNameSet(values: Array<string | null | undefined>) {
  const names = new Set(values.flatMap(indicatorNameCandidates).filter(Boolean));
  for (const name of [...names]) {
    const withoutTirads = name
      .replace(/c?tirads\d+[a-z]?类?/gi, "")
      .replace(/甲状腺影像报告和数据系统\d+[a-z]?类?/g, "");
    if (withoutTirads && withoutTirads !== name) names.add(withoutTirads);
  }
  return names;
}

function aliasAppliesToObservation(alias: AliasRow, row: ObservationRow) {
  if (alias.scope === "global") return true;
  if (alias.scope === "report_type") {
    return compactIndicatorKey(alias.reportType) === compactIndicatorKey(row.reportType);
  }
  if (alias.scope === "hospital") {
    return compactIndicatorKey(alias.hospitalName) === compactIndicatorKey(row.hospitalName);
  }
  if (alias.scope === "department") {
    const expected = compactIndicatorKey(alias.departmentName);
    return Boolean(expected) && [row.performingDepartment, row.reportingDepartment]
      .some((value) => compactIndicatorKey(value) === expected);
  }
  return false;
}

function quantitativeUltrasoundBoneObservationContext(row: ObservationRow) {
  const context = [
    row.sectionName,
    row.reportType,
    row.performingDepartment,
    row.reportingDepartment
  ].filter(Boolean).join(" ");
  return /超声骨密度|超声骨质|定量超声骨|\bQUS\b/i.test(context);
}

function candidateAliases(row: ObservationRow): AliasCandidate[] {
  /*
   * P1 将每一个名称候选绑定到可审计来源。原始项目名/代码优先，
   * AI 预整理名称只能作为保守兜底，且不会因与原文候选重名而覆盖原文来源。
   */
  const origins: Array<{
    origin: AliasCandidate["sourceOrigin"];
    sourceName: string | null;
    names: Set<string>;
  }> = [
    { origin: "item_name", sourceName: row.itemName, names: candidateNameSet([row.itemName]) },
    { origin: "item_code", sourceName: row.itemCode, names: candidateNameSet([row.itemCode]) },
    {
      origin: "combined",
      sourceName: row.itemCode ? `${row.itemName}${row.itemCode}` : null,
      names: candidateNameSet([row.itemCode ? `${row.itemName}${row.itemCode}` : null])
    },
    {
      origin: "ai_normalized_name",
      sourceName: row.normalizedName,
      names: candidateNameSet([row.normalizedName, `${row.normalizedName || ""}${row.itemCode || ""}`])
    }
  ];
  const sourceByName = new Map<string, { origin: AliasCandidate["sourceOrigin"]; sourceName: string }>();
  for (const source of origins) {
    if (!source.sourceName) continue;
    for (const name of source.names) {
      if (!sourceByName.has(name)) sourceByName.set(name, { origin: source.origin, sourceName: source.sourceName });
    }
  }
  const names = [...sourceByName.keys()];
  if (!names.length) return [];
  const placeholders = names.map(() => "?").join(",");
  const rows = getDatabase().prepare(`
    SELECT a.indicator_id AS indicatorId, c.canonical_key AS canonicalKey, c.display_name AS displayName,
      c.category, c.specimen, c.default_unit AS defaultUnit, c.value_type AS valueType,
      c.trend_enabled AS trendEnabled, c.explanation, a.alias_name AS aliasName,
      a.normalized_alias AS normalizedAlias, a.scope, a.source AS aliasSource,
      a.hospital_name AS hospitalName, a.department_name AS departmentName, a.report_type AS reportType,
      a.confidence, c.allowed_units_json AS allowedUnitsJson, c.section_hints_json AS sectionHintsJson
    FROM indicator_aliases a
    JOIN indicator_catalog c ON c.id = a.indicator_id
    WHERE a.enabled = 1 AND a.normalized_alias IN (${placeholders})
  `).all(...names) as AliasRow[];
  return rows.flatMap((alias) => {
    if (!aliasAppliesToObservation(alias, row)) return [];
    if (["qus_bone_t_score", "qus_bone_z_score"].includes(alias.canonicalKey)
      && !quantitativeUltrasoundBoneObservationContext(row)) return [];
    const source = sourceByName.get(alias.normalizedAlias)
      || sourceByName.get(compactIndicatorKey(alias.normalizedAlias));
    return source ? [{ alias, sourceOrigin: source.origin, sourceName: source.sourceName }] : [];
  });
}

function normalizeObservationAutomatically(row: ObservationRow): NormalizationResult {
  const deviceExclusionReason = functionalDeviceObservationExclusionReason(row);
  if (deviceExclusionReason) return excludedFunctionalDeviceObservation(row, deviceExclusionReason);
  const noiseExclusionReason = observationNoiseExclusionReason(row);
  if (noiseExclusionReason) return excludedObservationNoise(row, noiseExclusionReason);
  // A contradictory specimen is an identity mismatch, not a confidence penalty.
  // Use the row's section first: a comprehensive report can contain several specimens.
  const specimenSection = getDatabase().prepare(`
    SELECT content_text AS content FROM report_structured_sections
    WHERE report_id = ? AND section_key = 'laboratory_specimen' AND is_deleted = 0
    ORDER BY CASE source WHEN 'manual' THEN 0 ELSE 1 END, updated_at DESC, id LIMIT 1
  `).get(row.reportId) as { content: string } | undefined;
  const specimenContext = (text: string) => {
    const urine = /尿常规|尿沉渣|尿镜检|尿液|尿标本|^尿$|\burine\b/i.test(text);
    const stool = /便常规|粪便|大便|\bstool\b/i.test(text);
    const blood = /血常规|全血|血清|血浆|\bblood\b/i.test(text);
    const count = Number(urine) + Number(stool) + Number(blood);
    return count === 1 ? urine ? 'urine' : stool ? 'stool' : 'blood'
      : count > 1 ? 'mixed' : null;
  };
  const specimen = specimenContext(row.sectionName || '')
    || specimenContext(specimenSection?.content || '')
    || specimenContext(row.reportType)
    || specimenContext((getDatabase().prepare('SELECT title FROM reports WHERE id = ?')
      .get(row.reportId) as { title: string } | undefined)?.title || '');
  const candidates = candidateAliases(row).filter(({ alias }) => {
    const blood = /^cbc_/.test(alias.canonicalKey) || ['whole_blood', 'serum', 'plasma'].includes(alias.specimen || '');
    const urine = alias.specimen === 'urine' || alias.canonicalKey.startsWith('urine_');
    const stool = alias.canonicalKey.startsWith('stool_');
    if (specimen === 'urine' && (blood || stool)) return false;
    if (specimen === 'stool' && (blood || urine)) return false;
    if (specimen === 'blood' && (urine || stool)) return false;
    // Instrument counts per volume must not borrow microscopy counts per field.
    // Do not discard arbitrary unit conflicts: those still require review.
    if (specimen === 'urine' && alias.canonicalKey === 'urine_casts'
      && /^(?:个)?\/(?:u|µ|μ)l$/i.test(normalizeUnit(row.unit) || '')
      && !resolveIndicatorUnitCompatibility(alias.canonicalKey, normalizeUnit(row.unit), alias.defaultUnit, alias.allowedUnitsJson).compatible) return false;
    return true;
  });
  if (!candidates.length) {
    return {
      observationId: row.id,
      indicatorId: null,
      canonicalKey: null,
      canonicalName: null,
      canonicalValue: null,
      canonicalUnit: null,
      canonicalCategory: null,
      canonicalExplanation: null,
      confidence: 0,
      quality: "low",
      matchedBy: "none",
      matchReason: "未命中内置指标字典",
      excludedReason: "未命中内置指标字典",
      sourceOrigin: "none",
      sourceName: row.itemName,
      aliasSource: null,
      reviewStatus: "unreviewed",
      reviewedBy: null,
      reviewedAt: null
    };
  }

  type ScoredCandidate = {
    alias: AliasRow;
    sourceOrigin: AliasCandidate["sourceOrigin"];
    sourceName: string;
    score: number;
    reasons: string[];
    unitCompatible: boolean;
    hasSectionHint: boolean;
    resultTypeCompatible: boolean;
  };
  const scoredCandidates: ScoredCandidate[] = [];
  const rawUnit = normalizeUnit(row.unit);
  const context = [row.sectionName, row.reportType, row.performingDepartment, row.reportingDepartment].filter(Boolean).join(" ");
  const stoolContext = /便常规|粪便|大便/.test(context);
  const urineContext = /尿常规|尿沉渣|尿镜检|尿液|尿标本/.test(context);
  const ecgContext = /心电图|心电检查|静态心电|动态心电/.test(context);
  const generalPulseContext = /一般检查|基础测量|生命体征|内科/.test(context);
  const pulmonaryContext = pulmonaryObservationContext(row);
  const quantitativeUltrasoundBoneContext = quantitativeUltrasoundBoneObservationContext(row);
  for (const candidate of candidates) {
    const alias = candidate.alias;
    const unitCompatibility = resolveIndicatorUnitCompatibility(
      alias.canonicalKey,
      rawUnit,
      alias.defaultUnit,
      alias.allowedUnitsJson
    );
    const unitCompatible = unitCompatibility.compatible;
    const strongSectionHints = parseStringList(alias.sectionHintsJson)
      .filter((hint) => !["体检", "检查", "检验"].includes(compactIndicatorKey(hint)));
    const hasSectionHint = textHasAny(context, strongSectionHints);
    let score = 55;
    const reasons = [`名称命中「${alias.aliasName}」`];
    if (candidate.sourceOrigin === "ai_normalized_name") {
      score -= 35;
      reasons.push("仅由 AI 预整理名称命中，按低置信度候选处理");
    }
    if (alias.scope !== "global") {
      score += 15;
      reasons.push("机构/上下文规则命中");
    }
    if (rawUnit && unitCompatible) {
      score += 25;
      reasons.push(`单位兼容「${rawUnit}」`);
    } else if (rawUnit && !unitCompatible) {
      score -= 55;
      reasons.push(`单位不兼容「${rawUnit}」`);
    }
    if (hasSectionHint) {
      score += 15;
      reasons.push(`报告章节匹配「${alias.category}」`);
    }
    if (alias.canonicalKey.startsWith("pulmonary_") && !pulmonaryContext) {
      score -= 140;
      reasons.push("肺功能缩写缺少肺功能章节上下文");
    }
    if (["qus_bone_t_score", "qus_bone_z_score"].includes(alias.canonicalKey)
      && !quantitativeUltrasoundBoneContext) {
      score -= 140;
      reasons.push("QUS 骨密度 T/Z 值缺少定量超声骨检查上下文");
    }
    const hasNumericResult = (row.numericValue ?? parseNumericResultText(row.resultText)) !== null;
    if (hasNumericResult && alias.valueType === "numeric") {
      score += 15;
      reasons.push("结果类型为数值");
    } else if (hasNumericResult && alias.valueType !== "numeric") {
      score -= 15;
      reasons.push("结果类型与定性指标不符");
    } else if (!hasNumericResult && alias.valueType !== "numeric") {
      score += 10;
      reasons.push("结果类型为定性");
    }
    if (alias.canonicalKey === "glucose_fasting" && /尿|尿常规|尿液/i.test(context + row.itemName + (row.normalizedName || ""))) {
      score -= 80;
      reasons.push("尿液上下文不归入血糖趋势");
    }
    if (alias.canonicalKey === "renal_uric_acid" && /尿常规|尿液/i.test(context)) {
      score -= 35;
      reasons.push("尿液上下文降低置信度");
    }
    if ((stoolContext || urineContext) && /^cbc_/.test(alias.canonicalKey)) {
      score -= 120;
      reasons.push(stoolContext ? "便常规项目不得归入血常规" : "尿液项目不得归入血常规");
    }
    if (stoolContext && !/^stool_/.test(alias.canonicalKey)
      && ["白细胞", "红细胞", "白细胞计数", "红细胞计数", "WBC", "RBC"].some((name) =>
        indicatorNameCandidates(row.itemName).includes(compactIndicatorKey(name))
      )) {
      score -= 80;
      reasons.push("便常规同名项目只匹配便检指标");
    }
    if (urineContext && /^stool_/.test(alias.canonicalKey)) {
      score -= 120;
      reasons.push("尿液项目不得归入便常规");
    }
    if (ecgContext && alias.canonicalKey === "vital_pulse") {
      score -= 120;
      reasons.push("心电图心率不得归入一般脉搏");
    }
    if (generalPulseContext && !ecgContext && alias.canonicalKey === "ecg_heart_rate") {
      score -= 120;
      reasons.push("一般检查脉搏不得归入心电图心率");
    }
    const resultTypeCompatible = hasNumericResult
      ? alias.valueType === "numeric"
      : alias.valueType !== "numeric";
    scoredCandidates.push({
      alias,
      sourceOrigin: candidate.sourceOrigin,
      sourceName: candidate.sourceName,
      score,
      reasons,
      unitCompatible,
      hasSectionHint,
      resultTypeCompatible
    });
  }

  /* 历史 AI 建议条目（ai_suggestion）与内置条目同名时不构成竞争：内置条目优先。
     这些重复条目是字典更新前自动建标的遗留，若与内置候选同时保留会触发多义守门，
     把本可高置信匹配的指标挡在趋势外。仅压制品名相同的 AI 建议候选，无内置同名时保留。 */
  const builtinDisplayNames = new Set(
    scoredCandidates
      .filter((candidate) => candidate.alias.aliasSource === "builtin")
      .map((candidate) => compactIndicatorKey(candidate.alias.displayName))
  );
  const effectiveCandidates = builtinDisplayNames.size === 0
    ? scoredCandidates
    : scoredCandidates.filter((candidate) =>
      candidate.alias.aliasSource !== "ai_suggestion"
      || !builtinDisplayNames.has(compactIndicatorKey(candidate.alias.displayName))
    );

  const sourcePriority: Record<AliasCandidate["sourceOrigin"], number> = {
    item_name: 4,
    item_code: 3,
    combined: 2,
    ai_normalized_name: 1
  };
  effectiveCandidates.sort((left, right) =>
    right.score - left.score
    || sourcePriority[right.sourceOrigin] - sourcePriority[left.sourceOrigin]
    || right.alias.confidence - left.alias.confidence
    || left.alias.canonicalKey.localeCompare(right.alias.canonicalKey, "en")
    || left.alias.aliasName.localeCompare(right.alias.aliasName, "zh-CN")
    || left.alias.indicatorId.localeCompare(right.alias.indicatorId, "en")
  );
  const bestCandidateByCanonical = new Map<string, ScoredCandidate>();
  for (const candidate of effectiveCandidates) {
    /* scoredCandidates 已按最佳证据优先排序；同一 canonical 只保留首个候选，
       禁止后续较弱的 AI 预整理名称或低优先级来源反向覆盖原始项目名命中。 */
    if (!bestCandidateByCanonical.has(candidate.alias.canonicalKey)) {
      bestCandidateByCanonical.set(candidate.alias.canonicalKey, candidate);
    }
  }
  const bestByCanonical = [...bestCandidateByCanonical.values()];
  const selected = bestByCanonical[0]!;
  const closeCompetingCandidates = bestByCanonical
    .slice(1)
    .filter((candidate) => selected.score - candidate.score <= 15)
    // 侧别家族中通用父项（如 vascular_abi）与侧别项（vascular_abi_left）不构成真歧义：
    // 能命中侧别项说明来源名称带侧别限定，父项只是同族的不精确映射。
    .filter((candidate) => !isLateralityGenericParentOf(candidate.alias.canonicalKey, selected.alias.canonicalKey));
  const hasUniqueSectionEvidence = selected.hasSectionHint
    && closeCompetingCandidates.every((candidate) => !candidate.hasSectionHint);
  const hasUniqueUnitEvidence = Boolean(rawUnit && selected.unitCompatible)
    && closeCompetingCandidates.every((candidate) => !candidate.unitCompatible);
  const hasUniqueResultTypeEvidence = selected.resultTypeCompatible
    && closeCompetingCandidates.every((candidate) => !candidate.resultTypeCompatible);
  const ambiguousCanonicalMatch = closeCompetingCandidates.length > 0
    && !hasUniqueSectionEvidence
    && !hasUniqueUnitEvidence
    && !hasUniqueResultTypeEvidence;
  const numericValue = row.numericValue ?? parseNumericResultText(row.resultText);
  let quality = classifyQuality(selected.score, row, selected.alias);
  let conservativeReason: string | null = null;
  if (quality !== "excluded" && rawUnit && !selected.unitCompatible) {
    quality = "low";
    conservativeReason = "单位与标准指标不兼容，禁止进入默认趋势";
  } else if (quality !== "excluded" && ambiguousCanonicalMatch) {
    quality = "low";
    const competingKeys = closeCompetingCandidates
      .map((candidate) => candidate.alias.canonicalKey)
      .sort((left, right) => left.localeCompare(right, "en"));
    conservativeReason = `多义名称缺少章节、单位或结果类型的唯一证据（候选：${competingKeys.join("、")}），禁止进入默认趋势`;
    selected.reasons.push(conservativeReason);
  } else if (
    quality !== "excluded"
    && !rawUnit
    && !selected.alias.defaultUnit
    && new Set(
      parseStringList(selected.alias.allowedUnitsJson)
        .map((unit) => normalizeUnit(unit))
        .filter(Boolean)
    ).size > 1
  ) {
    quality = "low";
    conservativeReason = "缺少单位，无法确定趋势计量口径，禁止进入默认趋势";
    selected.reasons.push(conservativeReason);
  } else if (quality !== "excluded" && selected.sourceOrigin === "ai_normalized_name") {
    quality = "low";
    conservativeReason = "仅由 AI 预整理名称命中，需人工确认后进入趋势";
  }
  const evidenceQualityIssue = quality === "excluded" ? null : observationEvidenceQualityIssue(row);
  if (evidenceQualityIssue) {
    quality = "low";
    conservativeReason = evidenceQualityIssue;
  }
  const canonicalUnit = resolveIndicatorUnitCompatibility(
    selected.alias.canonicalKey,
    rawUnit,
    selected.alias.defaultUnit,
    selected.alias.allowedUnitsJson
  ).canonicalUnit;
  const canonicalValue = numericValue === null || !selected.unitCompatible
    ? null
    : convertUnit(selected.alias.canonicalKey, numericValue, rawUnit, canonicalUnit);
  const excludedReason = quality === "excluded"
    ? exclusionReason(row, selected.alias, selected.unitCompatible)
    : conservativeReason;
  return {
    observationId: row.id,
    indicatorId: selected.alias.indicatorId,
    canonicalKey: selected.alias.canonicalKey,
    canonicalName: selected.alias.displayName,
    canonicalValue,
    canonicalUnit,
    canonicalCategory: selected.alias.category,
    canonicalExplanation: selected.alias.explanation,
    confidence: Math.max(0, Math.min(1, selected.score / 100)),
    quality,
    matchedBy: selected.sourceOrigin === "ai_normalized_name"
      ? "normalized_name_fallback"
      : selected.alias.aliasSource === "user"
        ? "user_alias"
        : selected.alias.aliasSource === "ai_suggestion"
          ? "ai_suggestion"
          : selected.alias.scope === "global"
            ? "builtin_alias"
            : `${selected.alias.scope}_alias`,
    matchReason: selected.reasons.join("；"),
    excludedReason,
    sourceOrigin: selected.sourceOrigin,
    sourceName: selected.sourceName,
    aliasSource: selected.alias.aliasSource,
    reviewStatus: "unreviewed",
    reviewedBy: null,
    reviewedAt: null
  };
}


type GovernanceDecisionRow = {
  action: "confirm" | "exclude";
  indicatorId: string | null;
  canonicalKey: string | null;
  saveAlias: number;
  aliasScope: "global" | "report_type" | null;
  aliasId: string | null;
  reason: string | null;
  createdBy: string | null;
  reviewedAt: string;
};

type CatalogIndicatorRow = {
  indicatorId: string;
  canonicalKey: string;
  displayName: string;
  category: string;
  defaultUnit: string | null;
  valueType: "numeric" | "text" | "positive_negative";
  trendEnabled: number;
  explanation: string | null;
  allowedUnitsJson: string | null;
};

function governanceDecisionForObservation(row: ObservationRow) {
  const fingerprint = unmatchedFingerprint(row.normalizedName || row.itemName, row.unit, row.sectionName);
  return getDatabase().prepare(`
    SELECT action, indicator_id AS indicatorId, canonical_key AS canonicalKey,
      save_alias AS saveAlias, alias_scope AS aliasScope, alias_id AS aliasId, reason,
      created_by AS createdBy, updated_at AS reviewedAt
    FROM indicator_governance_decisions
    WHERE fingerprint = ?
  `).get(fingerprint) as GovernanceDecisionRow | undefined;
}

function manuallyConfirmedNormalization(
  row: ObservationRow,
  decision: GovernanceDecisionRow,
  indicator: CatalogIndicatorRow
): NormalizationResult {
  const unitCompatibility = resolveIndicatorUnitCompatibility(
    indicator.canonicalKey,
    row.unit,
    indicator.defaultUnit,
    indicator.allowedUnitsJson
  );
  const numericValue = row.numericValue ?? parseNumericResultText(row.resultText);
  const pseudoAlias = {
    canonicalKey: indicator.canonicalKey,
    trendEnabled: indicator.trendEnabled,
    valueType: indicator.valueType
  } as AliasRow;
  const structuralExclusionReason = exclusionReason(row, pseudoAlias, true);
  const unitIssueReason = !structuralExclusionReason && !unitCompatibility.compatible
    ? "单位与标准指标不兼容，已保留人工确认的指标身份，但禁止进入默认趋势"
    : null;
  const quality: NormalizationResult["quality"] = structuralExclusionReason
    ? "excluded"
    : unitIssueReason
      ? "low"
      : "high";
  return {
    observationId: row.id,
    indicatorId: indicator.indicatorId,
    canonicalKey: indicator.canonicalKey,
    canonicalName: indicator.displayName,
    canonicalValue: numericValue === null || !unitCompatibility.compatible
      ? null
      : convertUnit(indicator.canonicalKey, numericValue, unitCompatibility.rawUnit, unitCompatibility.canonicalUnit),
    canonicalUnit: unitCompatibility.canonicalUnit,
    canonicalCategory: indicator.category,
    canonicalExplanation: indicator.explanation,
    confidence: 1,
    quality,
    matchedBy: "manual_confirmation",
    matchReason: decision.reason?.trim() || "管理员已确认该来源名称对应此标准指标",
    excludedReason: structuralExclusionReason || unitIssueReason,
    sourceOrigin: "manual_confirmation",
    sourceName: row.itemName,
    aliasSource: "user",
    reviewStatus: "confirmed",
    reviewedBy: decision.createdBy,
    reviewedAt: decision.reviewedAt
  };
}

function normalizeObservationWithReadyCatalog(row: ObservationRow): NormalizationResult {
  const automatic = normalizeObservationAutomatically(row);
  const decision = governanceDecisionForObservation(row);
  if (decision?.action === "exclude") {
    return {
      ...automatic, quality: "excluded", matchedBy: "manual_exclusion",
      matchReason: decision.reason?.trim() || "管理员已确认该来源项目不进入默认趋势",
      excludedReason: decision.reason?.trim() || "已由管理员排除",
      sourceOrigin: "manual_exclusion", sourceName: row.itemName,
      reviewStatus: "excluded", reviewedBy: decision.createdBy, reviewedAt: decision.reviewedAt
    };
  }
  if (row.manualCanonicalKey) {
    const indicator = getDatabase().prepare(`
      SELECT id AS indicatorId, canonical_key AS canonicalKey, display_name AS displayName,
        category, default_unit AS defaultUnit, value_type AS valueType,
        trend_enabled AS trendEnabled, explanation, allowed_units_json AS allowedUnitsJson
      FROM indicator_catalog WHERE canonical_key = ?
    `).get(row.manualCanonicalKey) as CatalogIndicatorRow | undefined;
    if (!indicator) {
      return {
        ...automatic,
        quality: "low",
        matchReason: `${automatic.matchReason}；报告中人工选择的本地标准指标已不存在`,
        excludedReason: "人工选择的本地标准指标已不存在，需重新选择",
        reviewStatus: "unreviewed",
        reviewedBy: null,
        reviewedAt: null
      };
    }
    return manuallyConfirmedNormalization(row, {
      action: "confirm",
      indicatorId: indicator.indicatorId,
      canonicalKey: indicator.canonicalKey,
      saveAlias: 0,
      aliasScope: null,
      aliasId: null,
      reason: "已在报告详情中选择本地标准指标",
      createdBy: row.manualReviewedBy || null,
      reviewedAt: row.manualReviewedAt || new Date().toISOString()
    }, indicator);
  }
  if (!decision) return automatic;
  const indicator = getDatabase().prepare(`
    SELECT id AS indicatorId, canonical_key AS canonicalKey, display_name AS displayName,
      category, default_unit AS defaultUnit, value_type AS valueType,
      trend_enabled AS trendEnabled, explanation, allowed_units_json AS allowedUnitsJson
    FROM indicator_catalog
    WHERE id = ? AND canonical_key = ?
  `).get(decision.indicatorId, decision.canonicalKey) as CatalogIndicatorRow | undefined;
  if (!indicator) {
    return {
      ...automatic,
      quality: "low",
      matchReason: `${automatic.matchReason}；已确认的标准指标已不存在，需重新治理`,
      excludedReason: "人工确认目标已不存在",
      reviewStatus: "unreviewed",
      reviewedBy: null,
      reviewedAt: null
    };
  }
  return manuallyConfirmedNormalization(row, decision, indicator);
}

export function normalizeObservation(row: ObservationRow): NormalizationResult {
  ensureBuiltinIndicatorCatalog();
  return normalizeObservationWithReadyCatalog(row);
}

function migrateTrendPinsAfterNormalizationChange(input: {
  memberId: string | null;
  oldCanonicalKey: string | null;
  oldCanonicalUnit: string | null;
  newCanonicalKey: string | null;
  newCanonicalUnit: string | null;
}) {
  if (!input.memberId || !input.oldCanonicalKey || !input.newCanonicalKey) return 0;
  const oldUnitKey = input.oldCanonicalUnit || "";
  const newUnitKey = input.newCanonicalUnit || "";
  if (input.oldCanonicalKey === input.newCanonicalKey && oldUnitKey === newUnitKey) return 0;
  const db = getDatabase();
  const remaining = db.prepare(`
    SELECT COUNT(*) AS count
    FROM observation_normalizations n
    JOIN observations o ON o.id = n.observation_id
    JOIN reports r ON r.id = o.report_id
    WHERE r.member_id = ?
      AND n.canonical_key = ?
      AND COALESCE(n.canonical_unit, '') = ?
  `).get(input.memberId, input.oldCanonicalKey, oldUnitKey) as { count: number };
  if (Number(remaining.count) > 0) return 0;
  const inserted = db.prepare(`
    INSERT OR IGNORE INTO user_trend_pins (
      user_id, member_id, indicator_key, unit_key, created_at, updated_at
    )
    SELECT user_id, member_id, ?, ?, created_at, CURRENT_TIMESTAMP
    FROM user_trend_pins
    WHERE member_id = ? AND indicator_key = ? AND unit_key = ?
  `).run(
    input.newCanonicalKey,
    newUnitKey,
    input.memberId,
    input.oldCanonicalKey,
    oldUnitKey
  );
  db.prepare(`
    DELETE FROM user_trend_pins
    WHERE member_id = ? AND indicator_key = ? AND unit_key = ?
  `).run(input.memberId, input.oldCanonicalKey, oldUnitKey);
  return Number(inserted.changes);
}

// 字典参考范围兜底：报告未提供参考边界时，用 canonical 指标的字典范围（如骨密度 T 值的 WHO 标准）
// 重算展示口径异常标记。批量归一化与人工治理等所有 canonical 变化路径都会经过这里。
function refreshDisplayFlagWithDictionaryReference(observationId: string, indicatorId: string | null) {
  const db = getDatabase();
  const row = db.prepare(`
    SELECT o.abnormal_flag AS abnormalFlag, o.result_text AS resultText,
      o.numeric_value AS numericValue, o.reference_low AS referenceLow,
      o.reference_high AS referenceHigh, o.reference_text AS referenceText,
      o.evidence_json AS evidenceJson,
      o.display_abnormal_flag AS displayAbnormalFlag, o.abnormal_conflict AS abnormalConflict,
      EXISTS (SELECT 1 FROM report_extractions e WHERE e.report_id = o.report_id) AS hasAiExtraction,
      EXISTS (SELECT 1 FROM observation_field_overrides v WHERE v.observation_id = o.id) AS manualReviewed,
      c.reference_range_json AS dictionaryReferenceJson
    FROM observations o
    LEFT JOIN indicator_catalog c ON c.id = ?
    WHERE o.id = ?
  `).get(indicatorId, observationId) as {
    abnormalFlag: "high" | "low" | "abnormal" | "normal" | null;
    resultText: string;
    numericValue: number | null;
    referenceLow: number | null;
    referenceHigh: number | null;
    referenceText: string | null;
    evidenceJson: string;
    displayAbnormalFlag: "high" | "low" | "abnormal" | "normal" | null;
    abnormalConflict: number;
    dictionaryReferenceJson: string | null;
    hasAiExtraction: number;
    manualReviewed: number;
  } | undefined;
  if (!row) return;
  const reference = assessPersistedObservationReference(row);
  const dictionaryReference = reference.status === "missing" && !reference.reason
    ? parseDictionaryReferenceRange(row.dictionaryReferenceJson) : null;
  let supportingText: Array<string | null> = [];
  try {
    const evidence = JSON.parse(row.evidenceJson) as unknown;
    if (Array.isArray(evidence)) {
      supportingText = evidence.map((entry) =>
        entry && typeof entry === "object"
          ? String((entry as { quote?: unknown }).quote || "") || null
          : null
      );
    }
  } catch {
    supportingText = [];
  }
  const derived = deriveObservationDisplayAbnormal({
    storedFlag: row.abnormalFlag,
    resultText: row.resultText,
    supportingText,
    numericValue: row.numericValue,
    referenceLow: reference.low,
    referenceHigh: reference.high,
    referenceText: reference.text,
    dictionaryReference
  });
  const conflict = derived.abnormalConflict ? 1 : 0;
  if (derived.displayAbnormalFlag === row.displayAbnormalFlag && conflict === row.abnormalConflict) return;
  db.prepare(`
    UPDATE observations SET display_abnormal_flag = ?, abnormal_conflict = ? WHERE id = ?
  `).run(derived.displayAbnormalFlag, conflict, observationId);
}

function upsertNormalization(result: NormalizationResult) {
  const db = getDatabase();
  const previous = db.prepare(`
    SELECT n.canonical_key AS canonicalKey, n.canonical_unit AS canonicalUnit, r.member_id AS memberId
    FROM observation_normalizations n
    JOIN observations o ON o.id = n.observation_id
    JOIN reports r ON r.id = o.report_id
    WHERE n.observation_id = ?
  `).get(result.observationId) as {
    canonicalKey: string | null;
    canonicalUnit: string | null;
    memberId: string;
  } | undefined;
  db.prepare(`
    INSERT INTO observation_normalizations (
      observation_id, indicator_id, canonical_key, canonical_name, canonical_value, canonical_unit,
      canonical_category, canonical_explanation, confidence, quality, matched_by, match_reason,
      excluded_reason, source_origin, source_name, alias_source, review_status, reviewed_by, reviewed_at,
      version, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(observation_id) DO UPDATE SET
      indicator_id = excluded.indicator_id,
      canonical_key = excluded.canonical_key,
      canonical_name = excluded.canonical_name,
      canonical_value = excluded.canonical_value,
      canonical_unit = excluded.canonical_unit,
      canonical_category = excluded.canonical_category,
      canonical_explanation = excluded.canonical_explanation,
      confidence = excluded.confidence,
      quality = excluded.quality,
      matched_by = excluded.matched_by,
      match_reason = excluded.match_reason,
      excluded_reason = excluded.excluded_reason,
      source_origin = excluded.source_origin,
      source_name = excluded.source_name,
      alias_source = excluded.alias_source,
      review_status = excluded.review_status,
      reviewed_by = excluded.reviewed_by,
      reviewed_at = excluded.reviewed_at,
      version = excluded.version,
      updated_at = CURRENT_TIMESTAMP
  `).run(
    result.observationId,
    result.indicatorId,
    result.canonicalKey,
    result.canonicalName,
    result.canonicalValue,
    result.canonicalUnit,
    result.canonicalCategory,
    result.canonicalExplanation,
    result.confidence,
    result.quality,
    result.matchedBy,
    result.matchReason,
    result.excludedReason,
    result.sourceOrigin,
    result.sourceName,
    result.aliasSource,
    result.reviewStatus,
    result.reviewedBy,
    result.reviewedAt,
    normalizationVersion()
  );
  const governedOrPolicyResolved = result.reviewStatus !== "unreviewed"
    || isPolicyFilteredNormalization(result.matchedBy)
    || Boolean(result.canonicalKey && ["high", "medium"].includes(result.quality))
    || Boolean(result.canonicalKey && isDesignGatedQualitativeExclusion(result.excludedReason));
  updateUnmatchedNameOccurrence(
    result.observationId,
    governedOrPolicyResolved ? result.canonicalKey || result.matchedBy || result.reviewStatus : null
  );
  refreshDisplayFlagWithDictionaryReference(result.observationId, result.indicatorId);
  return migrateTrendPinsAfterNormalizationChange({
    memberId: previous?.memberId || null,
    oldCanonicalKey: previous?.canonicalKey || null,
    oldCanonicalUnit: normalizeUnit(previous?.canonicalUnit),
    newCanonicalKey: result.canonicalKey,
    newCanonicalUnit: normalizeUnit(result.canonicalUnit)
  });
}

function unmatchedFingerprint(rawName: string, unit: string | null, sectionName: string | null) {
  const identity = [
    compactIndicatorKey(rawName),
    normalizeUnit(unit) || "",
    compactIndicatorKey(sectionName)
  ].join("\u0000");
  return createHash("sha256").update(identity).digest("hex");
}

function resolveEmptyUnmatchedPoolItem(fingerprint: string | null | undefined) {
  if (!fingerprint) return;
  const db = getDatabase();
  const remaining = db.prepare(`
    SELECT COUNT(*) AS count
    FROM indicator_unmatched_occurrences
    WHERE fingerprint = ?
  `).get(fingerprint) as { count: number };
  if (Number(remaining.count) === 0) {
    db.prepare(`
      UPDATE indicator_unmatched_names
      SET status = CASE WHEN status = 'open' THEN 'resolved' ELSE status END,
        updated_at = CURRENT_TIMESTAMP
      WHERE fingerprint = ?
    `).run(fingerprint);
  }
}

function updateUnmatchedNameOccurrence(observationId: string, canonicalKey: string | null) {
  const db = getDatabase();
  const previous = db.prepare(`
    SELECT fingerprint FROM indicator_unmatched_occurrences WHERE observation_id = ?
  `).get(observationId) as { fingerprint: string } | undefined;
  if (canonicalKey) {
    db.prepare("DELETE FROM indicator_unmatched_occurrences WHERE observation_id = ?").run(observationId);
    resolveEmptyUnmatchedPoolItem(previous?.fingerprint);
    return;
  }
  const row = db.prepare(`
    SELECT o.report_id AS reportId, o.item_name AS rawName, o.normalized_name AS normalizedName,
      o.unit, o.section_name AS sectionName, o.result_text AS resultText
    FROM observations o
    JOIN reports r ON r.id = o.report_id
    WHERE o.id = ? AND r.status <> 'trashed'
  `).get(observationId) as {
    reportId: string;
    rawName: string;
    normalizedName: string | null;
    unit: string | null;
    sectionName: string | null;
    resultText: string;
  } | undefined;
  if (!row) {
    db.prepare("DELETE FROM indicator_unmatched_occurrences WHERE observation_id = ?").run(observationId);
    resolveEmptyUnmatchedPoolItem(previous?.fingerprint);
    return;
  }
  const normalizedName = compactIndicatorKey(row.normalizedName || row.rawName);
  const fingerprint = unmatchedFingerprint(row.normalizedName || row.rawName, row.unit, row.sectionName);
  db.prepare(`
    INSERT INTO indicator_unmatched_names (
      fingerprint, normalized_name, raw_name, unit, section_name, sample_result,
      status, first_seen_at, last_seen_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'open', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(fingerprint) DO UPDATE SET
      normalized_name = excluded.normalized_name,
      raw_name = excluded.raw_name,
      unit = excluded.unit,
      section_name = excluded.section_name,
      sample_result = excluded.sample_result,
      status = CASE WHEN indicator_unmatched_names.status = 'resolved' THEN 'open' ELSE indicator_unmatched_names.status END,
      last_seen_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP
  `).run(
    fingerprint,
    normalizedName,
    row.rawName,
    normalizeUnit(row.unit),
    row.sectionName,
    row.resultText.slice(0, 300)
  );
  db.prepare(`
    INSERT INTO indicator_unmatched_occurrences (observation_id, fingerprint, report_id)
    VALUES (?, ?, ?)
    ON CONFLICT(observation_id) DO UPDATE SET
      fingerprint = excluded.fingerprint,
      report_id = excluded.report_id
  `).run(observationId, fingerprint, row.reportId);
  if (previous?.fingerprint && previous.fingerprint !== fingerprint) {
    resolveEmptyUnmatchedPoolItem(previous.fingerprint);
  }
}

function synchronizeUnmatchedNamePool() {
  const db = getDatabase();
  db.prepare(`
    DELETE FROM indicator_unmatched_occurrences
    WHERE observation_id IN (
      SELECT o.id
      FROM observations o
      JOIN reports r ON r.id = o.report_id
      LEFT JOIN observation_normalizations n ON n.observation_id = o.id
      WHERE r.status = 'trashed'
        OR n.review_status IN ('confirmed', 'excluded')
        OR n.matched_by IN ('functional_device_filter', 'observation_noise_filter')
        OR n.excluded_reason LIKE '%OCR 证据%'
        OR n.excluded_reason = '结构化数值与结果文本不一致，禁止进入默认趋势'
        OR n.excluded_reason = '参考范围上下界反向，禁止进入默认趋势'
        OR n.excluded_reason LIKE '%不默认进入折线趋势%'
        OR (n.canonical_key IS NOT NULL AND n.quality IN ('high', 'medium'))
    )
  `).run();
  const unmatched = db.prepare(`
    SELECT o.id
    FROM observations o
    JOIN reports r ON r.id = o.report_id
    LEFT JOIN observation_normalizations n ON n.observation_id = o.id
    WHERE r.status <> 'trashed'
      AND (n.observation_id IS NULL OR (
        n.review_status = 'unreviewed'
        AND n.matched_by NOT IN ('functional_device_filter', 'observation_noise_filter')
        AND COALESCE(n.excluded_reason, '') NOT LIKE '%OCR 证据%'
        AND COALESCE(n.excluded_reason, '') <> '结构化数值与结果文本不一致，禁止进入默认趋势'
        AND COALESCE(n.excluded_reason, '') <> '参考范围上下界反向，禁止进入默认趋势'
        AND COALESCE(n.excluded_reason, '') NOT LIKE '%不默认进入折线趋势%'
        AND (n.canonical_key IS NULL OR n.quality IN ('low', 'excluded'))
      ))
  `).all() as Array<{ id: string }>;
  for (const row of unmatched) updateUnmatchedNameOccurrence(row.id, null);
  db.prepare(`
    UPDATE indicator_unmatched_names
    SET status = 'resolved', updated_at = CURRENT_TIMESTAMP
    WHERE status = 'open'
      AND NOT EXISTS (
        SELECT 1 FROM indicator_unmatched_occurrences occurrence
        WHERE occurrence.fingerprint = indicator_unmatched_names.fingerprint
      )
  `).run();
}

function observationRowsForReport(reportId: string) {
  return getDatabase().prepare(`
    SELECT o.id, o.report_id AS reportId, o.section_name AS sectionName, o.item_code AS itemCode,
      o.item_name AS itemName, o.normalized_name AS normalizedName, o.result_text AS resultText,
      o.numeric_value AS numericValue, o.unit, o.reference_low AS referenceLow,
      o.reference_high AS referenceHigh, o.reference_text AS referenceText, o.evidence_json AS evidenceJson,
      EXISTS (SELECT 1 FROM report_extractions extraction WHERE extraction.report_id = o.report_id) AS hasAiExtraction,
      EXISTS (SELECT 1 FROM observation_field_overrides override WHERE override.observation_id = o.id) AS manualReviewed,
      (SELECT canonical_key FROM observation_field_overrides override WHERE override.observation_id = o.id) AS manualCanonicalKey,
      (SELECT updated_by FROM observation_field_overrides override WHERE override.observation_id = o.id) AS manualReviewedBy,
      (SELECT updated_at FROM observation_field_overrides override WHERE override.observation_id = o.id) AS manualReviewedAt,
      r.report_type AS reportType, r.hospital_name_raw AS hospitalName,
      COALESCE(r.report_issued_at, r.reviewed_at, r.received_at, r.examined_at, r.sampled_at, r.ordered_at) AS reportIssuedAt,
      r.performing_department AS performingDepartment, r.reporting_department AS reportingDepartment
    FROM observations o
    JOIN reports r ON r.id = o.report_id
    WHERE o.report_id = ?
  `).all(reportId) as ObservationRow[];
}

function staleBuiltinNormalizationRows() {
  return getDatabase().prepare(`
    SELECT o.id, o.report_id AS reportId, o.section_name AS sectionName, o.item_code AS itemCode,
      o.item_name AS itemName, o.normalized_name AS normalizedName, o.result_text AS resultText,
      o.numeric_value AS numericValue, o.unit, o.reference_low AS referenceLow,
      o.reference_high AS referenceHigh, o.reference_text AS referenceText, o.evidence_json AS evidenceJson,
      EXISTS (SELECT 1 FROM report_extractions extraction WHERE extraction.report_id = o.report_id) AS hasAiExtraction,
      EXISTS (SELECT 1 FROM observation_field_overrides override WHERE override.observation_id = o.id) AS manualReviewed,
      (SELECT canonical_key FROM observation_field_overrides override WHERE override.observation_id = o.id) AS manualCanonicalKey,
      (SELECT updated_by FROM observation_field_overrides override WHERE override.observation_id = o.id) AS manualReviewedBy,
      (SELECT updated_at FROM observation_field_overrides override WHERE override.observation_id = o.id) AS manualReviewedAt,
      r.report_type AS reportType, r.hospital_name_raw AS hospitalName,
      r.performing_department AS performingDepartment, r.reporting_department AS reportingDepartment,
      n.canonical_key AS existingCanonicalKey, n.matched_by AS existingMatchedBy
    FROM observations o
    JOIN reports r ON r.id = o.report_id
    LEFT JOIN observation_normalizations n ON n.observation_id = o.id
    WHERE r.status <> 'trashed'
      AND r.deleted_at IS NULL
      AND (
        n.observation_id IS NULL
        OR (n.canonical_key IS NULL AND n.matched_by NOT IN ('functional_device_filter', 'observation_noise_filter'))
        OR n.version <> ?
      )
    ORDER BY o.report_id, o.id
  `).all(normalizationVersion()) as Array<ObservationRow & {
    existingCanonicalKey: string | null;
    existingMatchedBy: string | null;
  }>;
}

function pendingObservationRowsForReport(reportId: string) {
  return getDatabase().prepare(`
    SELECT o.id, o.report_id AS reportId, o.section_name AS sectionName, o.item_code AS itemCode,
      o.item_name AS itemName, o.normalized_name AS normalizedName, o.result_text AS resultText,
      o.numeric_value AS numericValue, o.unit, o.reference_low AS referenceLow,
      o.reference_high AS referenceHigh, o.reference_text AS referenceText, o.evidence_json AS evidenceJson,
      EXISTS (SELECT 1 FROM report_extractions extraction WHERE extraction.report_id = o.report_id) AS hasAiExtraction,
      EXISTS (SELECT 1 FROM observation_field_overrides override WHERE override.observation_id = o.id) AS manualReviewed,
      (SELECT canonical_key FROM observation_field_overrides override WHERE override.observation_id = o.id) AS manualCanonicalKey,
      (SELECT updated_by FROM observation_field_overrides override WHERE override.observation_id = o.id) AS manualReviewedBy,
      (SELECT updated_at FROM observation_field_overrides override WHERE override.observation_id = o.id) AS manualReviewedAt,
      r.report_type AS reportType, r.hospital_name_raw AS hospitalName,
      r.performing_department AS performingDepartment, r.reporting_department AS reportingDepartment
    FROM observations o
    JOIN reports r ON r.id = o.report_id
    LEFT JOIN observation_normalizations n ON n.observation_id = o.id
    WHERE o.report_id = ?
      AND (
        n.observation_id IS NULL
        OR (n.canonical_key IS NULL AND n.matched_by NOT IN ('functional_device_filter', 'observation_noise_filter'))
      )
  `).all(reportId) as ObservationRow[];
}

function createEmptyMaintenanceResult(): IndicatorNormalizationMaintenanceResult {
  return {
    scanned: 0,
    normalized: 0,
    high: 0,
    medium: 0,
    low: 0,
    excluded: 0,
    unknown: 0
  };
}

function collectNormalizationResult(rows: ObservationRow[]): IndicatorNormalizationMaintenanceResult {
  ensureBuiltinIndicatorCatalog();
  const result = createEmptyMaintenanceResult();
  result.scanned = rows.length;
  for (const row of rows) {
    const normalized = normalizeObservationWithReadyCatalog(row);
    upsertNormalization(normalized);
    result[normalized.quality] += 1;
    if (!normalized.canonicalKey && !isPolicyFilteredNormalization(normalized.matchedBy)) result.unknown += 1;
    if (normalized.canonicalKey && ["high", "medium"].includes(normalized.quality)) result.normalized += 1;
  }
  return result;
}

function addMaintenanceResult(
  total: IndicatorNormalizationMaintenanceResult,
  partial: Pick<IndicatorNormalizationMaintenanceResult, "scanned" | "normalized" | "high" | "medium" | "low" | "excluded" | "unknown">
) {
  total.scanned += partial.scanned;
  total.normalized += partial.normalized;
  total.high += partial.high;
  total.medium += partial.medium;
  total.low += partial.low;
  total.excluded += partial.excluded;
  total.unknown += partial.unknown;
}

export function normalizeReportObservations(reportId: string): IndicatorNormalizationMaintenanceResult {
  return collectNormalizationResult(observationRowsForReport(reportId));
}

export function backfillBuiltinIndicatorNormalizations(): BuiltinIndicatorBackfillResult {
  ensureBuiltinIndicatorCatalog();
  const rows = staleBuiltinNormalizationRows();
  const result: BuiltinIndicatorBackfillResult = {
    scanned: rows.length,
    updated: 0,
    unmatched: 0,
    pinsMigrated: 0,
    version: activeIndicatorDictionaryVersion()
  };
  for (const row of rows) {
    const normalized = normalizeObservationWithReadyCatalog(row);
    if (normalized.canonicalKey) {
      result.pinsMigrated += upsertNormalization(normalized);
      result.updated += 1;
      continue;
    }
    result.unmatched += 1;
    upsertNormalization(normalized);
  }
  return result;
}

function normalizePendingReportObservations(reportId: string): IndicatorNormalizationMaintenanceResult {
  return collectNormalizationResult(pendingObservationRowsForReport(reportId));
}

export function normalizeAllObservations(user: RequestUser): IndicatorNormalizationMaintenanceResult {
  if (!isAdministrator(user)) throw createError({ statusCode: 403, statusMessage: "仅管理员可维护指标归一化" });
  ensureBuiltinIndicatorCatalog();
  const reportIds = getDatabase().prepare(`
    SELECT DISTINCT report_id AS reportId FROM observations ORDER BY report_id
  `).all() as Array<{ reportId: string }>;
  const total = createEmptyMaintenanceResult();
  for (const row of reportIds) {
    const partial = normalizeReportObservations(row.reportId);
    addMaintenanceResult(total, partial);
  }
  getDatabase().prepare(`
    INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, detail_json)
    VALUES (?, ?, 'maintenance.normalize_indicators', 'observation', NULL, ?)
  `).run(createId("audit"), user.id, JSON.stringify(total));
  return total;
}

type TrendPinMigrationSnapshot = {
  observationId: string;
  memberId: string;
  canonicalKey: string;
  canonicalUnit: string | null;
};

function snapshotTrendPinMappings(): TrendPinMigrationSnapshot[] {
  return getDatabase().prepare(`
    SELECT n.observation_id AS observationId, r.member_id AS memberId,
      n.canonical_key AS canonicalKey, n.canonical_unit AS canonicalUnit
    FROM observation_normalizations n
    JOIN observations o ON o.id = n.observation_id
    JOIN reports r ON r.id = o.report_id
    WHERE n.canonical_key IS NOT NULL
  `).all() as TrendPinMigrationSnapshot[];
}

function migrateTrendPinsFromFullNormalization(snapshot: TrendPinMigrationSnapshot[]) {
  if (!snapshot.length) return 0;
  const oldByObservation = new Map(snapshot.map((row) => [row.observationId, row]));
  const mappings = new Map<string, {
    memberId: string;
    oldCanonicalKey: string;
    oldCanonicalUnit: string | null;
    targets: Set<string>;
  }>();
  const current = getDatabase().prepare(`
    SELECT n.observation_id AS observationId, n.canonical_key AS canonicalKey,
      n.canonical_unit AS canonicalUnit
    FROM observation_normalizations n
    WHERE n.canonical_key IS NOT NULL
  `).all() as Array<{
    observationId: string;
    canonicalKey: string;
    canonicalUnit: string | null;
  }>;
  for (const row of current) {
    const old = oldByObservation.get(row.observationId);
    if (!old) continue;
    const sourceKey = JSON.stringify([old.memberId, old.canonicalKey, normalizeUnit(old.canonicalUnit) || ""]);
    const targetKey = JSON.stringify([row.canonicalKey, normalizeUnit(row.canonicalUnit) || ""]);
    const mapping = mappings.get(sourceKey) || {
      memberId: old.memberId,
      oldCanonicalKey: old.canonicalKey,
      oldCanonicalUnit: normalizeUnit(old.canonicalUnit),
      targets: new Set<string>()
    };
    mapping.targets.add(targetKey);
    mappings.set(sourceKey, mapping);
  }
  let migrated = 0;
  for (const mapping of mappings.values()) {
    if (mapping.targets.size !== 1) continue;
    const [newCanonicalKey, newCanonicalUnit] = JSON.parse([...mapping.targets][0]) as [string, string];
    migrated += migrateTrendPinsAfterNormalizationChange({
      memberId: mapping.memberId,
      oldCanonicalKey: mapping.oldCanonicalKey,
      oldCanonicalUnit: mapping.oldCanonicalUnit,
      newCanonicalKey,
      newCanonicalUnit: newCanonicalUnit || null
    });
  }
  return migrated;
}

export function previewIndicatorNormalization(user: RequestUser) {
  if (!isAdministrator(user)) throw createError({ statusCode: 403, statusMessage: "仅管理员可预览指标重评估" });
  ensureBuiltinIndicatorCatalog();
  const db = getDatabase();
  const reports = db.prepare(`SELECT DISTINCT r.id FROM reports r
    JOIN observations o ON o.report_id = r.id
    WHERE r.status <> 'trashed' AND r.deleted_at IS NULL ORDER BY r.id`).all() as Array<{ id: string }>;
  const existing = new Map((db.prepare(`SELECT observation_id AS id, canonical_key AS canonicalKey,
    canonical_name AS canonicalName, matched_by AS matchedBy, excluded_reason AS excludedReason,
    quality FROM observation_normalizations`).all() as Array<{
      id: string; canonicalKey: string | null; canonicalName: string | null;
      matchedBy: string; excludedReason: string | null; quality: string;
    }>).map(row => [row.id, row]));
  const summary = { scanned: 0, eligible: 0, recovered: 0, removed: 0, pending: 0, excluded: 0 };
  const reasons = new Map<string, number>();
  for (const report of reports) {
    for (const row of observationRowsForReport(report.id)) {
      // Use exactly the same rules and manual decisions as execution, without upserting results.
      const next = normalizeObservationWithReadyCatalog(row);
      const previous = existing.get(row.id);
      const admissionFor = (result: NonNullable<typeof previous>) => assessTrendAdmission({
        ...row, evidenceJson: row.evidenceJson || '[]',
        canonicalKey: result.canonicalKey, canonicalName: result.canonicalName,
        normalizationQuality: result.quality, normalizationMatchedBy: result.matchedBy,
        normalizationExcludedReason: result.excludedReason
      });
      const wasEligible = previous ? admissionFor(previous).eligible : false;
      const admission = admissionFor({ ...next, id: row.id });
      const eligible = admission.eligible;
      summary.scanned += 1;
      if (eligible) summary.eligible += 1;
      if (eligible && !wasEligible) summary.recovered += 1;
      if (!eligible && wasEligible) summary.removed += 1;
      if (!eligible) {
        if (next.quality === "excluded") summary.excluded += 1;
        else summary.pending += 1;
        const reason = admission.reason || "指标身份或结果仍需核对";
        reasons.set(reason, (reasons.get(reason) || 0) + 1);
      }
    }
  }
  return { ...summary, reasons: [...reasons].map(([reason, count]) => ({ reason, count })) };
}

export async function normalizeAllObservationsFromDictionary(
  user: RequestUser,
  options?: {
    full?: boolean;
    taskId?: string;
    onProgress?: (progress: IndicatorNormalizationMaintenanceProgress) => void;
  }
): Promise<IndicatorNormalizationMaintenanceResult> {
  if (!isAdministrator(user)) throw createError({ statusCode: 403, statusMessage: "仅管理员可维护指标归一化" });
  ensureBuiltinIndicatorCatalog();
  const trendPinSnapshot = options?.full ? snapshotTrendPinMappings() : [];
  if (options?.full) {
    getDatabase().prepare(`
      DELETE FROM observation_normalizations
      WHERE observation_id IN (
        SELECT observation.id
        FROM observations observation
        JOIN reports report ON report.id = observation.report_id
        WHERE report.status <> 'trashed' AND report.deleted_at IS NULL
      )
    `).run();
  }
  const reportIds = getDatabase().prepare(`
    SELECT DISTINCT observation.report_id AS reportId
    FROM observations observation
    JOIN reports report ON report.id = observation.report_id
    LEFT JOIN observation_normalizations normalization
      ON normalization.observation_id = observation.id
    WHERE report.status <> 'trashed'
      AND report.deleted_at IS NULL
      AND (normalization.observation_id IS NULL OR normalization.canonical_key IS NULL)
    ORDER BY observation.report_id
  `).all() as Array<{ reportId: string }>;
  const total = createEmptyMaintenanceResult();
  options?.onProgress?.({
    totalReports: reportIds.length,
    processedReports: 0,
    result: total
  });
  let processedReports = 0;
  for (const row of reportIds) {
    addMaintenanceResult(total, normalizePendingReportObservations(row.reportId));
    processedReports += 1;
    options?.onProgress?.({
      totalReports: reportIds.length,
      processedReports,
      result: total
    });
  }
  if (options?.full) total.pinsMigrated = migrateTrendPinsFromFullNormalization(trendPinSnapshot);
  synchronizeUnmatchedNamePool();
  getDatabase().prepare(`
    INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, detail_json)
    VALUES (?, ?, 'maintenance.normalize_indicators', 'observation', NULL, ?)
  `).run(createId("audit"), user.id, JSON.stringify({
    ...total,
    source: "indicator_dictionary",
    dictionaryVersion: activeIndicatorDictionaryVersion(),
    full: options?.full === true,
    taskId: options?.taskId || null
  }));
  return total;
}

export function getIndicatorNormalizationMetrics(user: RequestUser): IndicatorNormalizationMetrics {
  if (!isAdministrator(user)) throw createError({ statusCode: 403, statusMessage: "仅管理员可查看指标质量统计" });
  const db = getDatabase();
  synchronizeUnmatchedNamePool();
  const totalsRow = db.prepare(`
    SELECT
      COUNT(DISTINCT report.id) AS reports,
      COUNT(observation.id) AS observations,
      COUNT(normalization.observation_id) AS normalizationRows,
      SUM(CASE WHEN normalization.canonical_key IS NOT NULL THEN 1 ELSE 0 END) AS mapped,
      SUM(CASE
        WHEN normalization.canonical_key IS NOT NULL
          AND normalization.quality IN ('high', 'medium')
          AND normalization.canonical_value IS NOT NULL
        THEN 1 ELSE 0 END) AS trendEligible,
      SUM(CASE
        WHEN normalization.observation_id IS NULL
          OR (
            normalization.review_status = 'unreviewed'
            AND (normalization.canonical_key IS NULL OR normalization.quality IN ('low', 'excluded'))
            AND normalization.matched_by NOT IN ('functional_device_filter', 'observation_noise_filter')
            AND COALESCE(normalization.excluded_reason, '') NOT LIKE '%OCR 证据%'
            AND COALESCE(normalization.excluded_reason, '') <> '结构化数值与结果文本不一致，禁止进入默认趋势'
            AND COALESCE(normalization.excluded_reason, '') <> '参考范围上下界反向，禁止进入默认趋势'
            AND COALESCE(normalization.excluded_reason, '') NOT LIKE '%不默认进入折线趋势%'
          )
        THEN 1 ELSE 0 END) AS needsReview,
      SUM(CASE WHEN normalization.review_status IN ('confirmed', 'excluded') THEN 1 ELSE 0 END) AS reviewed,
      SUM(CASE WHEN normalization.quality = 'high' THEN 1 ELSE 0 END) AS high,
      SUM(CASE WHEN normalization.quality = 'medium' THEN 1 ELSE 0 END) AS medium,
      SUM(CASE WHEN normalization.quality = 'low' THEN 1 ELSE 0 END) AS low,
      SUM(CASE WHEN normalization.quality = 'excluded' THEN 1 ELSE 0 END) AS excluded
    FROM reports report
    JOIN observations observation ON observation.report_id = report.id
    LEFT JOIN observation_normalizations normalization ON normalization.observation_id = observation.id
    WHERE report.status <> 'trashed' AND report.deleted_at IS NULL
  `).get() as Record<string, number | null>;
  const issueGroups = db.prepare(`
    SELECT COUNT(DISTINCT unmatched.fingerprint) AS count
    FROM indicator_unmatched_names unmatched
    JOIN indicator_unmatched_occurrences occurrence ON occurrence.fingerprint = unmatched.fingerprint
    JOIN reports report ON report.id = occurrence.report_id
    WHERE unmatched.status = 'open' AND report.status <> 'trashed' AND report.deleted_at IS NULL
  `).get() as { count: number };
  const decisions = db.prepare("SELECT COUNT(*) AS count FROM indicator_governance_decisions").get() as { count: number };
  const userAliases = db.prepare(`
    SELECT COUNT(*) AS count FROM indicator_aliases WHERE source = 'user' AND enabled = 1
  `).get() as { count: number };
  const sourceOrigins = db.prepare(`
    SELECT normalization.source_origin AS sourceOrigin, COUNT(*) AS count,
      SUM(CASE
        WHEN normalization.canonical_key IS NOT NULL
          AND normalization.quality IN ('high', 'medium')
          AND normalization.canonical_value IS NOT NULL
        THEN 1 ELSE 0 END) AS trendEligible
    FROM observation_normalizations normalization
    JOIN observations observation ON observation.id = normalization.observation_id
    JOIN reports report ON report.id = observation.report_id
    WHERE report.status <> 'trashed' AND report.deleted_at IS NULL
    GROUP BY normalization.source_origin
    ORDER BY count DESC, normalization.source_origin
  `).all() as Array<{ sourceOrigin: NormalizationSourceOrigin; count: number; trendEligible: number }>;
  const reportTypes = db.prepare(`
    SELECT report.report_type AS reportType, COUNT(DISTINCT report.id) AS reports,
      COUNT(observation.id) AS observations,
      SUM(CASE WHEN normalization.canonical_key IS NOT NULL THEN 1 ELSE 0 END) AS mapped,
      SUM(CASE
        WHEN normalization.canonical_key IS NOT NULL
          AND normalization.quality IN ('high', 'medium')
          AND normalization.canonical_value IS NOT NULL
        THEN 1 ELSE 0 END) AS trendEligible,
      SUM(CASE
        WHEN normalization.observation_id IS NULL
          OR (
            normalization.review_status = 'unreviewed'
            AND (normalization.canonical_key IS NULL OR normalization.quality IN ('low', 'excluded'))
            AND normalization.matched_by NOT IN ('functional_device_filter', 'observation_noise_filter')
            AND COALESCE(normalization.excluded_reason, '') NOT LIKE '%OCR 证据%'
            AND COALESCE(normalization.excluded_reason, '') <> '结构化数值与结果文本不一致，禁止进入默认趋势'
            AND COALESCE(normalization.excluded_reason, '') <> '参考范围上下界反向，禁止进入默认趋势'
            AND COALESCE(normalization.excluded_reason, '') NOT LIKE '%不默认进入折线趋势%'
          )
        THEN 1 ELSE 0 END) AS needsReview
    FROM reports report
    JOIN observations observation ON observation.report_id = report.id
    LEFT JOIN observation_normalizations normalization ON normalization.observation_id = observation.id
    WHERE report.status <> 'trashed' AND report.deleted_at IS NULL
    GROUP BY report.report_type
    ORDER BY observations DESC, report.report_type
  `).all() as Array<{
    reportType: string;
    reports: number;
    observations: number;
    mapped: number;
    trendEligible: number;
    needsReview: number;
  }>;
  const numeric = (value: number | null | undefined) => Number(value || 0);
  return {
    version: activeIndicatorNormalizationVersion(),
    generatedAt: new Date().toISOString(),
    totals: {
      reports: numeric(totalsRow.reports),
      observations: numeric(totalsRow.observations),
      normalizationRows: numeric(totalsRow.normalizationRows),
      mapped: numeric(totalsRow.mapped),
      trendEligible: numeric(totalsRow.trendEligible),
      needsReview: numeric(totalsRow.needsReview),
      reviewed: numeric(totalsRow.reviewed),
      issueGroups: numeric(issueGroups.count),
      decisions: numeric(decisions.count),
      userAliases: numeric(userAliases.count)
    },
    quality: {
      high: numeric(totalsRow.high),
      medium: numeric(totalsRow.medium),
      low: numeric(totalsRow.low),
      excluded: numeric(totalsRow.excluded)
    },
    sourceOrigins: sourceOrigins.map((row) => ({
      sourceOrigin: row.sourceOrigin,
      count: numeric(row.count),
      trendEligible: numeric(row.trendEligible)
    })),
    reportTypes: reportTypes.map((row) => ({
      reportType: row.reportType,
      reports: numeric(row.reports),
      observations: numeric(row.observations),
      mapped: numeric(row.mapped),
      trendEligible: numeric(row.trendEligible),
      needsReview: numeric(row.needsReview)
    }))
  };
}

export function listIndicatorNormalizationIssues(user: RequestUser): IndicatorNormalizationIssue[] {
  if (!isAdministrator(user)) throw createError({ statusCode: 403, statusMessage: "仅管理员可查看指标理解状态" });
  ensureBuiltinIndicatorCatalog();
  synchronizeUnmatchedNamePool();
  const rows = getDatabase().prepare(`
    SELECT pool.fingerprint, occurrence.observation_id AS observationId,
      report.id AS reportId, observation.item_name AS itemName, observation.numeric_value AS numericValue,
      observation.evidence_json AS evidenceJson,
      EXISTS (SELECT 1 FROM report_extractions x WHERE x.report_id = report.id) AS hasAiExtraction,
      EXISTS (SELECT 1 FROM observation_field_overrides x WHERE x.observation_id = observation.id) AS manualReviewed,
      EXISTS (SELECT 1 FROM member_permissions mp WHERE mp.member_id = report.member_id AND mp.user_id = ? AND mp.permission = 'manager') AS canManage,
      pool.raw_name AS rawName, pool.normalized_name AS normalizedName,
      observation.result_text AS resultText, pool.unit, pool.section_name AS sectionName,
      report.hospital_name_raw AS hospitalName,
      COALESCE(report.report_issued_at, report.reviewed_at, report.received_at, report.examined_at, report.sampled_at, report.ordered_at) AS reportIssuedAt,
      normalization.canonical_key AS candidateCanonicalKey,
      normalization.canonical_name AS candidateCanonicalName,
      catalog.default_unit AS candidateDefaultUnit,
      normalization.quality AS candidateQuality,
      normalization.matched_by AS matchedBy,
      normalization.match_reason AS matchReason,
      normalization.excluded_reason AS excludedReason,
      normalization.source_origin AS sourceOrigin
    FROM indicator_unmatched_names pool
    JOIN indicator_unmatched_occurrences occurrence ON occurrence.fingerprint = pool.fingerprint
    JOIN reports report ON report.id = occurrence.report_id
    JOIN observations observation ON observation.id = occurrence.observation_id
    LEFT JOIN observation_normalizations normalization ON normalization.observation_id = occurrence.observation_id
    LEFT JOIN indicator_catalog catalog ON catalog.id = normalization.indicator_id
    WHERE pool.status = 'open'
    ORDER BY pool.last_seen_at DESC, report.report_issued_at DESC, occurrence.observation_id
  `).all(user.id) as Array<{
    fingerprint: string;
    reportId: string; itemName: string; numericValue: number | null; evidenceJson: string;
    hasAiExtraction: number; manualReviewed: number; canManage: number;
    observationId: string;
    rawName: string;
    normalizedName: string | null;
    resultText: string;
    unit: string | null;
    sectionName: string | null;
    hospitalName: string | null;
    reportIssuedAt: string | null;
    candidateCanonicalKey: string | null;
    candidateCanonicalName: string | null;
    candidateDefaultUnit: string | null;
    candidateQuality: "low" | "excluded" | null;
    matchedBy: string | null;
    matchReason: string | null;
    excludedReason: string | null;
    sourceOrigin: NormalizationSourceOrigin | null;
  }>;
  const grouped = new Map<string, IndicatorNormalizationIssue>();
  for (const row of rows) {
    const admission = assessTrendAdmission({ ...row,
      canonicalKey: row.candidateCanonicalKey, canonicalName: row.candidateCanonicalName,
      normalizationQuality: row.candidateQuality, normalizationMatchedBy: row.matchedBy,
      normalizationExcludedReason: row.excludedReason
    });
    const current = grouped.get(row.fingerprint);
    const status = row.candidateCanonicalKey
      ? row.candidateQuality === "excluded" ? "excluded" : "low"
      : "unknown";
    if (!current) {
      grouped.set(row.fingerprint, {
        fingerprint: row.fingerprint,
        representativeObservationId: row.observationId,
        reportId: row.reportId, canManage: Boolean(row.canManage), trendEligible: admission.eligible,
        pendingCount: admission.eligible ? 0 : 1,
        rawName: row.rawName,
        normalizedName: row.normalizedName,
        resultText: row.resultText,
        unit: row.unit,
        sectionName: row.sectionName,
        hospitalName: row.hospitalName,
        status,
        reason: admission.eligible ? "已可用于趋势，标准化为可选操作" : admission.reason || "请核对指标信息",
        count: 1,
        latestReportIssuedAt: row.reportIssuedAt,
        candidateCanonicalKey: row.candidateCanonicalKey,
        candidateCanonicalName: row.candidateCanonicalName,
        candidateDefaultUnit: row.candidateDefaultUnit,
        candidateQuality: row.candidateQuality,
        matchedBy: row.matchedBy,
        sourceOrigin: row.sourceOrigin || "none"
      });
      continue;
    }
    current.count += 1;
    if (!admission.eligible) current.pendingCount += 1;
    if ((current.trendEligible && !admission.eligible) || (current.trendEligible === admission.eligible && (row.reportIssuedAt || "") > (current.latestReportIssuedAt || ""))) {
      current.latestReportIssuedAt = row.reportIssuedAt;
      current.representativeObservationId = row.observationId;
      current.reportId = row.reportId;
      current.canManage = Boolean(row.canManage);
      current.resultText = row.resultText;
      current.unit = row.unit;
      current.hospitalName = row.hospitalName;
      current.reason = admission.eligible ? "已可用于趋势，标准化为可选操作" : admission.reason || "请核对指标信息";
    }
    current.trendEligible = current.trendEligible && admission.eligible;
    if (!current.candidateCanonicalKey && row.candidateCanonicalKey) {
      current.candidateCanonicalKey = row.candidateCanonicalKey;
      current.candidateCanonicalName = row.candidateCanonicalName;
      current.candidateDefaultUnit = row.candidateDefaultUnit;
      current.candidateQuality = row.candidateQuality;
      current.matchedBy = row.matchedBy;
      current.sourceOrigin = row.sourceOrigin || "none";
      current.status = status;
    }
  }
  return [...grouped.values()]
    .sort((left, right) => right.count - left.count
      || (right.latestReportIssuedAt || "").localeCompare(left.latestReportIssuedAt || ""))
    .slice(0, 100);
}

function searchIndicatorCatalogOptions(query = ""): IndicatorCatalogOption[] {
  ensureBuiltinIndicatorCatalog();
  const normalizedQuery = query.normalize("NFKC").trim().slice(0, 80);
  const like = `%${normalizedQuery.replace(/[\\%_]/g, (value) => `\\${value}`)}%`;
  const rows = getDatabase().prepare(`
    SELECT catalog.canonical_key AS canonicalKey, catalog.display_name AS displayName,
      catalog.category, catalog.default_unit AS defaultUnit,
      GROUP_CONCAT(DISTINCT alias.alias_name) AS aliases
    FROM indicator_catalog catalog
    LEFT JOIN indicator_aliases alias ON alias.indicator_id = catalog.id AND alias.enabled = 1
    WHERE ? = ''
      OR catalog.canonical_key LIKE ? ESCAPE '\\'
      OR catalog.display_name LIKE ? ESCAPE '\\'
      OR alias.alias_name LIKE ? ESCAPE '\\'
    GROUP BY catalog.id
    ORDER BY
      CASE WHEN catalog.display_name = ? OR catalog.canonical_key = ? THEN 0 ELSE 1 END,
      COALESCE(catalog.item_order, 999999), catalog.display_name
    LIMIT 100
  `).all(normalizedQuery, like, like, like, normalizedQuery, normalizedQuery) as Array<{
    canonicalKey: string;
    displayName: string;
    category: string;
    defaultUnit: string | null;
    aliases: string | null;
  }>;
  return rows.map((row) => ({
    ...row,
    aliases: row.aliases ? [...new Set(row.aliases.split(",").filter(Boolean))].slice(0, 8) : []
  }));
}

export function searchIndicatorCatalog(user: RequestUser, query = ""): IndicatorCatalogOption[] {
  if (!isAdministrator(user)) throw createError({ statusCode: 403, statusMessage: "仅管理员可查询标准指标" });
  return searchIndicatorCatalogOptions(query);
}

export function searchReportIndicatorCatalog(
  user: RequestUser,
  reportId: string,
  query = "",
): IndicatorCatalogOption[] {
  const report = getDatabase().prepare(`
    SELECT member_id AS memberId FROM reports WHERE id = ? AND status <> 'trashed'
  `).get(reportId) as { memberId: string } | undefined;
  if (!report) throw createError({ statusCode: 404, statusMessage: "报告不存在" });
  assertMemberManage(user, report.memberId);
  return searchIndicatorCatalogOptions(query);
}

function observationRowsForIds(observationIds: string[]) {
  if (!observationIds.length) return [];
  const placeholders = observationIds.map(() => "?").join(",");
  return getDatabase().prepare(`
    SELECT o.id, o.report_id AS reportId, o.section_name AS sectionName, o.item_code AS itemCode,
      o.item_name AS itemName, o.normalized_name AS normalizedName, o.result_text AS resultText,
      o.numeric_value AS numericValue, o.unit, o.reference_low AS referenceLow,
      o.reference_high AS referenceHigh, o.reference_text AS referenceText, o.evidence_json AS evidenceJson,
      EXISTS (SELECT 1 FROM report_extractions extraction WHERE extraction.report_id = o.report_id) AS hasAiExtraction,
      EXISTS (SELECT 1 FROM observation_field_overrides override WHERE override.observation_id = o.id) AS manualReviewed,
      (SELECT canonical_key FROM observation_field_overrides override WHERE override.observation_id = o.id) AS manualCanonicalKey,
      (SELECT updated_by FROM observation_field_overrides override WHERE override.observation_id = o.id) AS manualReviewedBy,
      (SELECT updated_at FROM observation_field_overrides override WHERE override.observation_id = o.id) AS manualReviewedAt,
      r.report_type AS reportType, r.hospital_name_raw AS hospitalName,
      r.performing_department AS performingDepartment, r.reporting_department AS reportingDepartment
    FROM observations o
    JOIN reports r ON r.id = o.report_id
    WHERE o.id IN (${placeholders}) AND r.status <> 'trashed' AND r.deleted_at IS NULL
  `).all(...observationIds) as ObservationRow[];
}

function allActiveObservationRows() {
  return getDatabase().prepare(`
    SELECT o.id, o.report_id AS reportId, o.section_name AS sectionName, o.item_code AS itemCode,
      o.item_name AS itemName, o.normalized_name AS normalizedName, o.result_text AS resultText,
      o.numeric_value AS numericValue, o.unit, o.reference_low AS referenceLow,
      o.reference_high AS referenceHigh, o.reference_text AS referenceText, o.evidence_json AS evidenceJson,
      EXISTS (SELECT 1 FROM report_extractions extraction WHERE extraction.report_id = o.report_id) AS hasAiExtraction,
      EXISTS (SELECT 1 FROM observation_field_overrides override WHERE override.observation_id = o.id) AS manualReviewed,
      (SELECT canonical_key FROM observation_field_overrides override WHERE override.observation_id = o.id) AS manualCanonicalKey,
      (SELECT updated_by FROM observation_field_overrides override WHERE override.observation_id = o.id) AS manualReviewedBy,
      (SELECT updated_at FROM observation_field_overrides override WHERE override.observation_id = o.id) AS manualReviewedAt,
      r.report_type AS reportType, r.hospital_name_raw AS hospitalName,
      r.performing_department AS performingDepartment, r.reporting_department AS reportingDepartment
    FROM observations o
    JOIN reports r ON r.id = o.report_id
    WHERE r.status <> 'trashed' AND r.deleted_at IS NULL
    ORDER BY o.id
  `).all() as ObservationRow[];
}

function observationRowsForFingerprint(fingerprint: string) {
  return allActiveObservationRows().filter((row) =>
    unmatchedFingerprint(row.normalizedName || row.itemName, row.unit, row.sectionName) === fingerprint
  );
}

function observationRowsForAlias(alias: AliasRow) {
  return allActiveObservationRows().filter((row) =>
    aliasAppliesToObservation(alias, row)
      && candidateNameSet([row.itemName, row.itemCode, row.itemCode ? `${row.itemName}${row.itemCode}` : null,
        row.normalizedName, `${row.normalizedName || ""}${row.itemCode || ""}`])
        .has(compactIndicatorKey(alias.normalizedAlias))
  );
}

function renormalizeRows(rows: ObservationRow[]) {
  let normalized = 0;
  let reopenedIssues = 0;
  for (const row of rows) {
    const result = normalizeObservationWithReadyCatalog(row);
    upsertNormalization(result);
    if (result.canonicalKey && ["high", "medium"].includes(result.quality)) normalized += 1;
    if (result.reviewStatus === "unreviewed" && (!result.canonicalKey || ["low", "excluded"].includes(result.quality))) {
      reopenedIssues += 1;
    }
  }
  return { normalized, reopenedIssues };
}

export function resolveIndicatorNormalizationIssue(
  user: RequestUser,
  input: {
    fingerprint: string;
    action: "confirm" | "exclude";
    canonicalKey?: string | null;
    saveAlias?: boolean;
    aliasScope?: "global" | "report_type";
    reason?: string | null;
  }
): IndicatorGovernanceResult {
  if (!isAdministrator(user)) throw createError({ statusCode: 403, statusMessage: "仅管理员可治理指标" });
  ensureBuiltinIndicatorCatalog();
  const fingerprint = input.fingerprint?.trim();
  if (!/^[a-f0-9]{64}$/i.test(fingerprint || "")) {
    throw createError({ statusCode: 400, statusMessage: "指标问题标识无效" });
  }
  if (!(["confirm", "exclude"] as const).includes(input.action)) {
    throw createError({ statusCode: 400, statusMessage: "治理操作无效" });
  }
  const db = getDatabase();
  const pool = db.prepare(`
    SELECT fingerprint, raw_name AS rawName, normalized_name AS normalizedName,
      unit, section_name AS sectionName
    FROM indicator_unmatched_names WHERE fingerprint = ?
  `).get(fingerprint) as {
    fingerprint: string;
    rawName: string;
    normalizedName: string;
    unit: string | null;
    sectionName: string | null;
  } | undefined;
  if (!pool) throw createError({ statusCode: 404, statusMessage: "指标问题不存在或已清理" });
  const occurrenceRows = db.prepare(`
    SELECT occurrence.observation_id AS observationId, report.report_type AS reportType
    FROM indicator_unmatched_occurrences occurrence
    JOIN reports report ON report.id = occurrence.report_id
    WHERE occurrence.fingerprint = ? AND report.status <> 'trashed' AND report.deleted_at IS NULL
    ORDER BY occurrence.observation_id
  `).all(fingerprint) as Array<{ observationId: string; reportType: string }>;
  if (!occurrenceRows.length) throw createError({ statusCode: 409, statusMessage: "该问题已没有可治理的数据" });

  const indicator = input.action === "confirm"
    ? db.prepare(`
        SELECT id AS indicatorId, canonical_key AS canonicalKey, display_name AS displayName
        FROM indicator_catalog WHERE canonical_key = ?
      `).get(input.canonicalKey?.trim() || "") as {
        indicatorId: string;
        canonicalKey: string;
        displayName: string;
      } | undefined
    : undefined;
  if (input.action === "confirm" && !indicator) {
    throw createError({ statusCode: 400, statusMessage: "请选择有效的标准指标" });
  }

  const aliasScope = input.saveAlias ? input.aliasScope || "report_type" : null;
  const reportTypes = [...new Set(occurrenceRows.map((row) => row.reportType).filter(Boolean))];
  if (aliasScope === "report_type" && reportTypes.length !== 1) {
    throw createError({ statusCode: 409, statusMessage: "该名称跨越多种报告类型，不能直接保存为报告类型别名" });
  }
  const normalizedAlias = compactIndicatorKey(pool.rawName);
  let aliasSaved = false;
  let aliasId: string | null = null;
  let aliasReportType: string | null = null;
  db.exec("BEGIN IMMEDIATE");
  try {
    if (input.action === "confirm" && input.saveAlias && indicator) {
      const reportType = aliasScope === "report_type" ? reportTypes[0] || null : null;
      aliasReportType = reportType;
      const conflict = db.prepare(`
        SELECT catalog.display_name AS displayName
        FROM indicator_aliases alias
        JOIN indicator_catalog catalog ON catalog.id = alias.indicator_id
        WHERE alias.enabled = 1 AND alias.normalized_alias = ? AND alias.scope = ?
          AND COALESCE(alias.report_type, '') = COALESCE(?, '')
          AND alias.indicator_id <> ?
        LIMIT 1
      `).get(normalizedAlias, aliasScope, reportType, indicator.indicatorId) as { displayName: string } | undefined;
      if (conflict) {
        throw createError({
          statusCode: 409,
          statusMessage: `该别名已映射到「${conflict.displayName}」，请先检查冲突`
        });
      }
      const existing = db.prepare(`
        SELECT id FROM indicator_aliases
        WHERE indicator_id = ? AND normalized_alias = ? AND scope = ?
          AND COALESCE(report_type, '') = COALESCE(?, '') AND source = 'user'
        LIMIT 1
      `).get(indicator.indicatorId, normalizedAlias, aliasScope, reportType) as { id: string } | undefined;
      if (existing) {
        aliasId = existing.id;
        db.prepare(`
          UPDATE indicator_aliases
          SET alias_name = ?, confidence = 1, enabled = 1, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(pool.rawName, existing.id);
      } else {
        aliasId = createId("alias");
        db.prepare(`
          INSERT INTO indicator_aliases (
            id, indicator_id, alias_name, normalized_alias, scope, report_type,
            source, confidence, enabled, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'user', 1, 1, CURRENT_TIMESTAMP)
        `).run(aliasId, indicator.indicatorId, pool.rawName, normalizedAlias, aliasScope, reportType);
      }
      aliasSaved = true;
    }

    db.prepare(`
      INSERT INTO indicator_governance_decisions (
        fingerprint, action, indicator_id, canonical_key, save_alias, alias_scope, alias_id,
        reason, created_by, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(fingerprint) DO UPDATE SET
        action = excluded.action,
        indicator_id = excluded.indicator_id,
        canonical_key = excluded.canonical_key,
        save_alias = excluded.save_alias,
        alias_scope = excluded.alias_scope,
        alias_id = excluded.alias_id,
        reason = excluded.reason,
        created_by = excluded.created_by,
        updated_at = CURRENT_TIMESTAMP
    `).run(
      fingerprint,
      input.action,
      indicator?.indicatorId || null,
      indicator?.canonicalKey || null,
      aliasSaved ? 1 : 0,
      aliasScope,
      aliasId,
      input.reason?.trim().slice(0, 300) || null,
      user.id
    );

    const rows = observationRowsForIds(occurrenceRows.map((row) => row.observationId));
    let normalized = 0;
    let excluded = 0;
    const remainingReasons = new Map<string, number>();
    for (const row of rows) {
      const result = normalizeObservationWithReadyCatalog(row);
      upsertNormalization(result);
      const admission = assessTrendAdmission({
        ...row, evidenceJson: row.evidenceJson || '[]',
        canonicalKey: result.canonicalKey, canonicalName: result.canonicalName,
        normalizationQuality: result.quality, normalizationMatchedBy: result.matchedBy,
        normalizationExcludedReason: result.excludedReason
      });
      if (admission.eligible) normalized += 1;
      if (result.quality === "excluded") excluded += 1;
      if (!admission.eligible) {
        const reason = admission.reason || "结果仍需核对";
        remainingReasons.set(reason, (remainingReasons.get(reason) || 0) + 1);
      }
    }
    db.prepare(`
      UPDATE indicator_unmatched_names
      SET status = ?, resolved_canonical_key = ?, updated_at = CURRENT_TIMESTAMP
      WHERE fingerprint = ?
    `).run(input.action === "confirm" ? "resolved" : "ignored", indicator?.canonicalKey || null, fingerprint);
    db.prepare(`
      INSERT INTO indicator_governance_history (
        id, event_type, fingerprint, decision_action, indicator_id, canonical_key,
        alias_id, alias_name, alias_scope, report_type, reason, affected_observations, created_by
      ) VALUES (?, 'apply', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      createId("indicator-governance-history"),
      fingerprint,
      input.action,
      indicator?.indicatorId || null,
      indicator?.canonicalKey || null,
      aliasId,
      aliasSaved ? pool.rawName : null,
      aliasScope,
      aliasReportType,
      input.reason?.trim().slice(0, 300) || null,
      rows.length,
      user.id
    );
    db.prepare(`
      INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, detail_json)
      VALUES (?, ?, 'maintenance.govern_indicator', 'indicator_issue', ?, ?)
    `).run(createId("audit"), user.id, fingerprint, JSON.stringify({
      action: input.action,
      canonicalKey: indicator?.canonicalKey || null,
      affectedObservations: rows.length,
      aliasSaved,
      aliasScope,
      reason: input.reason?.trim().slice(0, 300) || null
    }));
    db.exec("COMMIT");
    return {
      fingerprint,
      action: input.action,
      affectedObservations: rows.length,
      normalized,
      excluded,
      pending: rows.length - normalized - excluded,
      remainingReasons: [...remainingReasons].map(([reason, count]) => ({ reason, count })),
      aliasSaved,
      canonicalKey: indicator?.canonicalKey || null
    };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function governanceAliasRowById(aliasId: string) {
  return getDatabase().prepare(`
    SELECT alias.indicator_id AS indicatorId, catalog.canonical_key AS canonicalKey,
      catalog.display_name AS displayName, catalog.category, catalog.specimen,
      catalog.default_unit AS defaultUnit, catalog.value_type AS valueType,
      catalog.trend_enabled AS trendEnabled, catalog.explanation,
      alias.alias_name AS aliasName, alias.normalized_alias AS normalizedAlias,
      alias.scope, alias.source AS aliasSource, alias.hospital_name AS hospitalName,
      alias.department_name AS departmentName, alias.report_type AS reportType,
      alias.confidence, catalog.allowed_units_json AS allowedUnitsJson,
      catalog.section_hints_json AS sectionHintsJson
    FROM indicator_aliases alias
    JOIN indicator_catalog catalog ON catalog.id = alias.indicator_id
    WHERE alias.id = ?
  `).get(aliasId) as AliasRow | undefined;
}

function aliasContextKey(alias: Pick<AliasRow, "normalizedAlias" | "scope" | "hospitalName" | "departmentName" | "reportType">) {
  return [
    compactIndicatorKey(alias.normalizedAlias),
    alias.scope,
    compactIndicatorKey(alias.hospitalName),
    compactIndicatorKey(alias.departmentName),
    compactIndicatorKey(alias.reportType)
  ].join("\u0000");
}

export function listIndicatorGovernanceHistory(user: RequestUser, limit = 100): IndicatorGovernanceHistoryItem[] {
  if (!isAdministrator(user)) throw createError({ statusCode: 403, statusMessage: "仅管理员可查看治理历史" });
  const safeLimit = Math.max(1, Math.min(300, Math.trunc(limit || 100)));
  const rows = getDatabase().prepare(`
    SELECT history.id, history.event_type AS eventType, history.fingerprint,
      history.decision_action AS decisionAction, pool.raw_name AS rawName,
      history.canonical_key AS canonicalKey, catalog.display_name AS canonicalName,
      history.alias_id AS aliasId, history.alias_name AS aliasName,
      history.alias_scope AS aliasScope, history.report_type AS reportType,
      history.reason, history.affected_observations AS affectedObservations,
      users.display_name AS actorName, history.created_at AS createdAt,
      CASE
        WHEN history.event_type = 'apply'
          AND EXISTS (
            SELECT 1 FROM indicator_governance_decisions decision
            WHERE decision.fingerprint = history.fingerprint
              AND decision.action = history.decision_action
          )
          AND NOT EXISTS (
            SELECT 1 FROM indicator_governance_history newer
            WHERE newer.fingerprint = history.fingerprint
              AND newer.event_type IN ('apply', 'undo')
              AND newer.rowid > history.rowid
          )
        THEN 1 ELSE 0
      END AS canUndo
    FROM indicator_governance_history history
    LEFT JOIN indicator_unmatched_names pool ON pool.fingerprint = history.fingerprint
    LEFT JOIN indicator_catalog catalog ON catalog.id = history.indicator_id
    LEFT JOIN users ON users.id = history.created_by
    ORDER BY history.rowid DESC
    LIMIT ?
  `).all(safeLimit) as Array<Omit<IndicatorGovernanceHistoryItem, "canUndo"> & { canUndo: number }>;
  return rows.map((row) => ({ ...row, canUndo: row.canUndo === 1 }));
}

export function undoIndicatorGovernanceDecision(
  user: RequestUser,
  fingerprintInput: string,
  reason?: string | null
): IndicatorGovernanceUndoResult {
  if (!isAdministrator(user)) throw createError({ statusCode: 403, statusMessage: "仅管理员可撤销指标治理" });
  ensureBuiltinIndicatorCatalog();
  const fingerprint = fingerprintInput.trim();
  if (!/^[a-f0-9]{64}$/i.test(fingerprint)) {
    throw createError({ statusCode: 400, statusMessage: "指标问题标识无效" });
  }
  const db = getDatabase();
  const decision = db.prepare(`
    SELECT action, indicator_id AS indicatorId, canonical_key AS canonicalKey,
      save_alias AS saveAlias, alias_scope AS aliasScope, alias_id AS aliasId,
      reason, created_by AS createdBy, updated_at AS reviewedAt
    FROM indicator_governance_decisions
    WHERE fingerprint = ?
  `).get(fingerprint) as GovernanceDecisionRow | undefined;
  if (!decision) throw createError({ statusCode: 404, statusMessage: "当前没有可撤销的治理决策" });

  const pool = db.prepare(`
    SELECT raw_name AS rawName FROM indicator_unmatched_names WHERE fingerprint = ?
  `).get(fingerprint) as { rawName: string } | undefined;
  const fingerprintRows = observationRowsForFingerprint(fingerprint);
  let alias = decision.aliasId ? governanceAliasRowById(decision.aliasId) : undefined;
  let aliasId = decision.aliasId;
  if (!alias && decision.saveAlias && decision.indicatorId && pool) {
    const reportTypes = [...new Set(fingerprintRows.map((row) => row.reportType).filter(Boolean))];
    const reportType = decision.aliasScope === "report_type" && reportTypes.length === 1 ? reportTypes[0] : null;
    const legacyAlias = db.prepare(`
      SELECT id FROM indicator_aliases
      WHERE source = 'user' AND indicator_id = ? AND normalized_alias = ? AND scope = ?
        AND COALESCE(report_type, '') = COALESCE(?, '')
      ORDER BY updated_at DESC, id DESC LIMIT 1
    `).get(
      decision.indicatorId,
      compactIndicatorKey(pool.rawName),
      decision.aliasScope || "global",
      reportType
    ) as { id: string } | undefined;
    if (legacyAlias) {
      aliasId = legacyAlias.id;
      alias = governanceAliasRowById(legacyAlias.id);
    }
  }

  const rowsById = new Map(fingerprintRows.map((row) => [row.id, row]));
  if (alias) {
    for (const row of observationRowsForAlias(alias)) rowsById.set(row.id, row);
  }
  const rows = [...rowsById.values()];
  const undoReason = reason?.trim().slice(0, 300) || null;
  let aliasDisabled = false;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("DELETE FROM indicator_governance_decisions WHERE fingerprint = ?").run(fingerprint);
    if (aliasId) {
      const referenced = db.prepare(`
        SELECT COUNT(*) AS count FROM indicator_governance_decisions WHERE alias_id = ?
      `).get(aliasId) as { count: number };
      if (Number(referenced.count) === 0) {
        const updated = db.prepare(`
          UPDATE indicator_aliases
          SET enabled = 0, updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND source = 'user' AND enabled = 1
        `).run(aliasId);
        aliasDisabled = Number(updated.changes) > 0;
      }
    }
    const rerun = renormalizeRows(rows);
    db.prepare(`
      UPDATE indicator_unmatched_names
      SET status = CASE WHEN EXISTS (
          SELECT 1 FROM indicator_unmatched_occurrences occurrence
          WHERE occurrence.fingerprint = indicator_unmatched_names.fingerprint
        ) THEN 'open' ELSE 'resolved' END,
        resolved_canonical_key = NULL,
        updated_at = CURRENT_TIMESTAMP
      WHERE fingerprint = ?
    `).run(fingerprint);
    db.prepare(`
      INSERT INTO indicator_governance_history (
        id, event_type, fingerprint, decision_action, indicator_id, canonical_key,
        alias_id, alias_name, alias_scope, report_type, reason, affected_observations, created_by
      ) VALUES (?, 'undo', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      createId("indicator-governance-history"),
      fingerprint,
      decision.action,
      decision.indicatorId,
      decision.canonicalKey,
      aliasId,
      alias?.aliasName || pool?.rawName || null,
      alias?.scope || decision.aliasScope,
      alias?.reportType || null,
      undoReason,
      rows.length,
      user.id
    );
    db.prepare(`
      INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, detail_json)
      VALUES (?, ?, 'maintenance.undo_indicator_governance', 'indicator_issue', ?, ?)
    `).run(createId("audit"), user.id, fingerprint, JSON.stringify({
      decisionAction: decision.action,
      canonicalKey: decision.canonicalKey,
      affectedObservations: rows.length,
      aliasId,
      aliasDisabled,
      reason: undoReason
    }));
    db.exec("COMMIT");
    return {
      fingerprint,
      action: decision.action,
      affectedObservations: rows.length,
      aliasDisabled,
      remainingMapped: rerun.normalized,
      reopenedIssues: rerun.reopenedIssues
    };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function listIndicatorAliasGovernance(user: RequestUser): IndicatorAliasGovernanceOverview {
  if (!isAdministrator(user)) throw createError({ statusCode: 403, statusMessage: "仅管理员可管理指标别名" });
  ensureBuiltinIndicatorCatalog();
  const db = getDatabase();
  const allRows = db.prepare(`
    SELECT alias.id, alias.indicator_id AS indicatorId, catalog.canonical_key AS canonicalKey,
      catalog.display_name AS displayName, catalog.category, catalog.specimen,
      catalog.default_unit AS defaultUnit, catalog.value_type AS valueType,
      catalog.trend_enabled AS trendEnabled, catalog.explanation,
      alias.alias_name AS aliasName, alias.normalized_alias AS normalizedAlias,
      alias.scope, alias.source AS aliasSource, alias.hospital_name AS hospitalName,
      alias.department_name AS departmentName, alias.report_type AS reportType,
      alias.confidence, alias.enabled, alias.created_at AS createdAt, alias.updated_at AS updatedAt,
      catalog.allowed_units_json AS allowedUnitsJson, catalog.section_hints_json AS sectionHintsJson
    FROM indicator_aliases alias
    JOIN indicator_catalog catalog ON catalog.id = alias.indicator_id
    WHERE alias.source IN ('builtin', 'user', 'ai_suggestion')
    ORDER BY alias.updated_at DESC, alias.id DESC
  `).all() as Array<AliasRow & {
    id: string;
    enabled: number;
    createdAt: string;
    updatedAt: string;
  }>;
  const enabledGroups = new Map<string, typeof allRows>();
  for (const row of allRows.filter((item) => item.enabled === 1)) {
    const key = aliasContextKey(row);
    enabledGroups.set(key, [...(enabledGroups.get(key) || []), row]);
  }
  const conflicts: IndicatorAliasConflict[] = [];
  for (const group of enabledGroups.values()) {
    if (!group.some((row) => row.aliasSource === "user")) continue;
    if (new Set(group.map((row) => row.canonicalKey)).size < 2) continue;
    const first = group[0]!;
    conflicts.push({
      normalizedAlias: first.normalizedAlias,
      scope: first.scope as IndicatorAliasConflict["scope"],
      hospitalName: first.hospitalName,
      departmentName: first.departmentName,
      reportType: first.reportType,
      targets: group.map((row) => ({
        aliasId: row.id,
        aliasName: row.aliasName,
        canonicalKey: row.canonicalKey,
        canonicalName: row.displayName,
        source: row.aliasSource
      }))
    });
  }
  const conflictCounts = new Map<string, number>();
  for (const conflict of conflicts) {
    for (const target of conflict.targets) conflictCounts.set(target.aliasId, conflict.targets.length - 1);
  }
  const aliases = allRows.filter((row) => row.aliasSource === "user").map((row) => ({
    id: row.id,
    aliasName: row.aliasName,
    normalizedAlias: row.normalizedAlias,
    scope: row.scope as IndicatorAliasGovernanceItem["scope"],
    hospitalName: row.hospitalName,
    departmentName: row.departmentName,
    reportType: row.reportType,
    canonicalKey: row.canonicalKey,
    canonicalName: row.displayName,
    category: row.category,
    enabled: row.enabled === 1,
    usageCount: observationRowsForAlias(row).length,
    conflictCount: conflictCounts.get(row.id) || 0,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  }));
  return { aliases, conflicts };
}

export function setIndicatorAliasEnabled(
  user: RequestUser,
  aliasIdInput: string,
  enabled: boolean,
  reason?: string | null
): IndicatorAliasUpdateResult {
  if (!isAdministrator(user)) throw createError({ statusCode: 403, statusMessage: "仅管理员可管理指标别名" });
  ensureBuiltinIndicatorCatalog();
  const aliasId = aliasIdInput.trim();
  const db = getDatabase();
  const alias = governanceAliasRowById(aliasId);
  if (!alias || alias.aliasSource !== "user") {
    throw createError({ statusCode: 404, statusMessage: "本地指标别名不存在" });
  }
  const current = db.prepare("SELECT enabled FROM indicator_aliases WHERE id = ?").get(aliasId) as { enabled: number };
  if ((current.enabled === 1) === enabled) {
    return { aliasId, enabled, affectedObservations: 0, normalized: 0, reopenedIssues: 0 };
  }
  if (enabled) {
    const conflict = db.prepare(`
      SELECT catalog.display_name AS displayName
      FROM indicator_aliases other
      JOIN indicator_catalog catalog ON catalog.id = other.indicator_id
      WHERE other.id <> ? AND other.enabled = 1 AND other.normalized_alias = ? AND other.scope = ?
        AND COALESCE(other.hospital_name, '') = COALESCE(?, '')
        AND COALESCE(other.department_name, '') = COALESCE(?, '')
        AND COALESCE(other.report_type, '') = COALESCE(?, '')
        AND other.indicator_id <> ?
      LIMIT 1
    `).get(
      aliasId,
      alias.normalizedAlias,
      alias.scope,
      alias.hospitalName,
      alias.departmentName,
      alias.reportType,
      alias.indicatorId
    ) as { displayName: string } | undefined;
    if (conflict) {
      throw createError({ statusCode: 409, statusMessage: `该别名仍与「${conflict.displayName}」冲突，不能启用` });
    }
  }

  const rows = observationRowsForAlias(alias);
  const updateReason = reason?.trim().slice(0, 300) || null;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`
      UPDATE indicator_aliases SET enabled = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `).run(enabled ? 1 : 0, aliasId);
    const rerun = renormalizeRows(rows);
    db.prepare(`
      INSERT INTO indicator_governance_history (
        id, event_type, indicator_id, canonical_key, alias_id, alias_name,
        alias_scope, report_type, reason, affected_observations, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      createId("indicator-governance-history"),
      enabled ? "alias_enable" : "alias_disable",
      alias.indicatorId,
      alias.canonicalKey,
      aliasId,
      alias.aliasName,
      alias.scope,
      alias.reportType,
      updateReason,
      rows.length,
      user.id
    );
    db.prepare(`
      INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, detail_json)
      VALUES (?, ?, ?, 'indicator_alias', ?, ?)
    `).run(
      createId("audit"),
      user.id,
      enabled ? "maintenance.enable_indicator_alias" : "maintenance.disable_indicator_alias",
      aliasId,
      JSON.stringify({
        aliasName: alias.aliasName,
        canonicalKey: alias.canonicalKey,
        affectedObservations: rows.length,
        reason: updateReason
      })
    );
    db.exec("COMMIT");
    return {
      aliasId,
      enabled,
      affectedObservations: rows.length,
      normalized: rerun.normalized,
      reopenedIssues: rerun.reopenedIssues
    };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
