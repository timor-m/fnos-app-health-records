import { createHash } from "node:crypto";
import {
  measurementUnitPattern,
  inferUnknownUnit,
} from "./measurement-units.service";
import { createError } from "h3";
import { getDatabase } from "../database/client";
import type { RequestUser } from "../domain/request-user";
import { assertMemberManage } from "./member.service";
import {
  resolveAiExtractionDepth,
  getAiTaskSettings,
  type AiExtractionDepth,
} from "./ai-settings.service";
import { resolveAiMaxOutputTokens } from "./ai-provider";
import { ensureCoreDictionaryMaterialized } from "./indicator-dictionary.service";
import { inferObservationAbnormalFlag } from "./observation-interpretation.service";
import {
  assessObservationReference,
  canUseAdjacentReferenceCell,
  hasExplicitReferenceValueShape,
  referenceColumnRole,
} from "./observation-reference.service";
import {
  classifyReportContent,
  classifyReportDocument,
  mergeContentClassifications,
  type ReportContentClassification,
  type ReportContentType,
} from "./report-content-classifier.service";

export const aiInputPlanningPolicy = {
  version: "ocr-unit-plan-v20",
  targetCharacters: 8_000,
  maxPagesPerUnit: 12,
  maxSparsePagesPerUnit: 24,
  targetOutputTokens: 12_000,
  maxCandidateRowsPerUnit: 60,
} as const;

type RawOcrLine = {
  id?: unknown;
  text?: unknown;
  confidence?: unknown;
  box?: unknown;
};

export type DictionaryCandidateFact = {
  canonicalKey: string;
  displayName: string;
  kind: "quantitative" | "categorical";
  valueType: "numeric" | "text" | "positive_negative";
  alias: string;
  sectionHints: string[];
};

export type OcrLineRole =
  | "metadata"
  | "scalar"
  | "morphology"
  | "narrative"
  | "table_header"
  | "section_heading"
  | "noise"
  | "uncertain";

/**
 * 面向内容治理的稳定语义角色。`OcrLineRole` 继续负责技术路由，避免把表头、
 * 章节标题等实现细节混进业务分类；`contentRole` 则用于候选门禁和质量诊断。
 */
export type OcrContentRole =
  | "measurement"
  | "reference"
  | "recommendation"
  | "metadata"
  | "chart_axis"
  | "environment"
  | "narrative";

export type CandidateResolutionReason =
  | "supplement_required"
  | "filtered_noise"
  | "duplicate_evidence"
  | "unsupported_complex_table"
  | "ambiguous_layout";

export type PlannedOcrCell = {
  index: number;
  text: string;
  sourceLineIds: string[];
  box: unknown;
};

export type LocalObservationSourceRef = {
  text: string;
  sourceLineIds: string[];
  cellIndices: number[];
  inherited: boolean;
  headerSourceLineIds?: string[];
  headerText?: string;
};

export type LocalObservationSourceMap = {
  item: LocalObservationSourceRef;
  result: LocalObservationSourceRef;
  unit?: LocalObservationSourceRef;
  reference?: LocalObservationSourceRef;
  qualifier?: LocalObservationSourceRef;
};

export type LocalObservationFact = {
  pageNumber: number;
  sourceLineId: string;
  sectionName: string | null;
  itemName: string;
  normalizedName: string;
  resultText: string;
  numericValue: number | null;
  unit: string | null;
  referenceLow: number | null;
  referenceHigh: number | null;
  referenceText: string | null;
  abnormalFlag: "high" | "low" | "abnormal" | "normal" | null;
  sourceText: string;
  observationKey: string;
  sourceMap: LocalObservationSourceMap;
};

export type PlannedOcrLine = {
  id: string;
  sourceLineIds: string[];
  sourceCells: PlannedOcrCell[];
  index: number;
  text: string;
  confidence: number | null;
  box: unknown;
  candidate: boolean;
  candidateKind: "scalar" | "morphology" | null;
  dictionaryFacts: DictionaryCandidateFact[];
  boundary: "section" | "table_header" | null;
  role: OcrLineRole;
  contentRole: OcrContentRole;
  candidateResolutionReason: CandidateResolutionReason | null;
  localObservation: LocalObservationFact | null;
  localObservations: LocalObservationFact[];
  sectionName?: string | null;
  reportSectionName?: string | null;
  tableHeaderText?: string | null;
  tableHeaderSourceLineIds?: string[];
  expectedLocalObservationCount?: number;
};

export function localObservationsForLine(
  line: Pick<PlannedOcrLine, "localObservation" | "localObservations">,
) {
  if (line.localObservations?.length) return line.localObservations;
  return line.localObservation ? [line.localObservation] : [];
}

function lineNeedsAiScalarExtraction(line: PlannedOcrLine) {
  const localCount = localObservationsForLine(line).length;
  return (
    line.candidateKind === "scalar" &&
    (localCount === 0 ||
      (line.expectedLocalObservationCount || 0) > localCount)
  );
}

export type RebuiltOcrPage = {
  pageId: string;
  pageNumber: number;
  lineCount: number;
  characterCount: number;
  candidateRowCount: number;
  morphologyCandidateCount: number;
  narrativeLineCount: number;
  localObservationCount: number;
  sourceLineCount: number;
  removedLineCount: number;
  repeatedRemovedLineCount: number;
  noiseRemovedLineCount: number;
  text: string;
  lines: PlannedOcrLine[];
  classification: ReportContentClassification;
};

export type AiExtractionUnit = {
  unitKey: string;
  inputHash: string;
  unitType: "complete_pages" | "page_chunk" | "supplement";
  extractionMode: "scalar" | "morphology";
  route: "document" | "scalar" | "morphology" | "narrative" | "verification";
  allowDocumentFields: boolean;
  classification: ReportContentClassification;
  pageNumbers: number[];
  pageRanges: Array<{
    pageId: string;
    pageNumber: number;
    lineStart: number;
    lineEnd: number;
    chunkIndex: number;
    chunkCount: number;
  }>;
  characterCount: number;
  candidateRowCount: number;
  morphologyCandidateCount: number;
  localObservationCount: number;
  estimatedOutputTokens: number;
  lineCount: number;
  text: string;
  candidateFacts: Array<{
    pageNumber: number;
    kind: "scalar" | "morphology";
    sourceText: string;
    dictionaryFacts: DictionaryCandidateFact[];
  }>;
};

export type AiExtractionPlan = {
  policy: typeof aiInputPlanningPolicy;
  extractionDepth: AiExtractionDepth;
  reportId: string;
  pageCount: number;
  sourceCharacterCount: number;
  candidateRowCount: number;
  morphologyCandidateCount: number;
  narrativeLineCount: number;
  localObservationCount: number;
  sourceLineCount: number;
  removedLineCount: number;
  repeatedRemovedLineCount: number;
  noiseRemovedLineCount: number;
  unitCount: number;
  planHash: string;
  documentClassification: ReportContentClassification;
  pages: RebuiltOcrPage[];
  units: AiExtractionUnit[];
};

const sectionHeadingPattern =
  /^(一般检查|基础测量|体格检查|内科|外科|眼科|耳鼻喉科?|口腔科?|妇科|检验检查|血液常规|血常规|便常规|尿常规|肝功能|肾功能|血脂|血糖|电解质|甲状腺功能|动脉粥样硬化指数|肿瘤标志物|功能检查|影像检查|超声检查|彩超|心电图|肺功能|骨密度|呼气试验|检查所见|检查结论|影像所见|影像结论|诊断意见|总检结论|体检综述|阳性发现|异常汇总|异常结果与健康建议|本次体检的异常结果汇总及建议|建议|主诉|现病史|既往史|门诊诊断|处理意见|处置|入院诊断|出院诊断|住院经过|手术经过|出院用药|出院医嘱|病理诊断|肉眼所见|镜下所见|免疫组化|病理分级|病理分期|处方)(?:[（(].*?[）)]|[一二三四五六七八九十\d]+项|[:：]|\s|$)/;
const tableHeaderPattern =
  /(?:项目|名称|参数).{0,20}(?:结果|测定值|检查结果).{0,30}(?:参考|范围|单位|历史|既往|上次|前次|预测|预计|目标|仪器范围|测量范围|检测范围|线性范围)|(?:结果|测定值).{0,20}(?:单位|参考)|(?:项目|名称|参数).{0,20}(?:实测值?|测量值).{0,30}(?:预测|预计|%\s*预测|单位|参考)|(?:实测值?|测量值).{0,20}(?:预测|预计)|(?:预测|预计).{0,20}(?:实测值?|测量值)/;
const tcdTableHeaderPattern =
  /(?:^|[|｜])\s*血管名称\s*(?:[|｜].*)?(?:^|[|｜])\s*V[mM]\s*(?:[|｜].*)?(?:^|[|｜])\s*PI\s*(?:[|｜]|$)/i;
/*
 * 表头是纯标签行：只有列名。出现数值、句读、建议类叙述或单元格边界上的结果词，
 * 说明是数据行或汇总叙述行（如“XX测定值偏高(1.06)(参考值…)；建议随诊。”），
 * 不能当表头——否则会污染后续行的表头上下文，并把建议文本挡在叙述通道之外。
 */
const tableHeaderContentPattern =
  /\d|[。；;]|建议|随诊|复查|诊治|(?:^|[|｜\s(（:：])(?:阴性|阳性|弱阳性|正常|异常|未见|偏高|偏低)(?=[|｜\s)）:：]|$)/;

function isTableHeaderRow(text: string) {
  return (
    (tableHeaderPattern.test(text) || tcdTableHeaderPattern.test(text)) &&
    !tableHeaderContentPattern.test(text)
  );
}

const morphologyPattern =
  /(脂肪肝|囊肿|囊性(?:回声|灶)|结节|斑块|息肉|结石|钙化|占位|肿块|包块|积液|增生|萎缩|狭窄|扩张|病灶|(?:低|高|强|混合)回声|回声(?:不均|欠均|增强|减低|异常|团|区|灶)|(?:高|低|混合)?密度(?:影|灶|区|结节)|(?:边界|边缘)(?:不清|欠清|模糊|毛糙)|血流信号(?:丰富|增多|减少|异常|紊乱)|(?:BI-RADS|C-TIRADS|LI-RADS|Bosniak)\s*\d|分级\s*[:：]?\s*\d)/i;
const metadataCandidatePattern =
  /(?:报告号|门诊号|住院号|体检号|检查号|标本号|条码号|二维码|申请日期|报告日期|检查日期|采样日期|接收日期|审核日期|打印日期|打印时间|姓名|性别|年龄|出生日期|身份证|手机号|电话|地址|科室|病区|床号|医生)\s*[:：]/;
const redactionPlaceholderPattern =
  /\[(?:患者个资已过滤|已过滤身份证号|已过滤手机号|已过滤邮箱)\]/g;
const pageMarkerPattern =
  /^(?:第?\s*\d+\s*页(?:\s*[/／]?\s*共\s*\d+\s*页)?|\d+\s*[/／]\s*\d+\s*页?|页码\s*[:：]?\s*\d+(?:\s*[/／]\s*\d+)?)$/i;
const footerNoisePattern =
  /(?:本报告仅供|仅供临床参考|仅供参考|如有疑问.{0,16}(?:咨询|联系)|打印时间|打印日期|打印人|制表时间|客服电话|服务热线|官方网址|微信公众号|扫码关注|未经.*不得|报告声明)/;
/*
 * 页脚噪声片段（打印时间、页码、送检声明）常与采样/报告时间同处一行、
 * 或与元数据行视觉合并成一行。逐片段剥离而不是整行丢弃，
 * 避免连带丢失报告时间等元数据。整行剥离后为空时保留原文，
 * 交给既有噪声分类处理，维持噪声统计口径不变。
 */
const footerNoiseFragmentPatterns = [
  /打印(?:时间|日期|人)\s*[:：]?\s*\d{4}[-/.]\d{1,2}[-/.]\d{1,2}(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?/g,
  /第\s*\d+\s*页\s*[,，/／]?\s*共\s*\d+\s*页/g,
  /本报告仅[^|｜。]*。/g,
  /如有疑问[^|｜。]*(?:咨询|联系)[^|｜。]*。?/g,
];

const footerFragmentSentinel = "\u0000";

function stripFooterNoiseFragments(text: string) {
  let stripped = text;
  for (const pattern of footerNoiseFragmentPatterns) {
    stripped = stripped.replace(pattern, footerFragmentSentinel);
  }
  if (!stripped.includes(footerFragmentSentinel)) return text.trim();
  /* 只丢弃被剥离片段留下的空单元格，保留行内原本就存在的空单元格（如“身高 | | 170”），
     避免破坏表头列对齐。 */
  return stripped
    .split(/[|｜]/)
    .map((cell) => ({
      hadFragment: cell.includes(footerFragmentSentinel),
      cleaned: cell.split(footerFragmentSentinel).join(" ").trim(),
    }))
    .filter((cell) => cell.cleaned.length > 0 || !cell.hadFragment)
    .map((cell) => cell.cleaned)
    .join(" | ")
    .replace(/\s{2,}/g, " ")
    .trim();
}
const educationHeadingPattern =
  /^(?:专家)?健康(?:宣教|教育)|^疾病知识|^健康知识|^科普知识|^温馨提示/;
const historicalSectionPattern =
  /^(?:历史|既往|往年|历年|上次|前次)(?:检查|检测|检验|体检|报告)?结果(?:[（(]\d+[）)])?/;
const reportContentRestartPattern =
  /(?:检验|检查|体检|超声|心电图|病理|门诊|住院|出院|处方|疫苗|票据).{0,12}(?:报告|报告单)$|^(?:项目|名称).{0,20}(?:结果|测定值|检查结果)/;
const directoryLinePattern = /^(?:目录|contents?)$|[.．·•…]{2,}\s*\d{1,3}\s*$/i;
const businessNumberOnlyPattern = /^(?:[A-Z]{0,6}[-/]?)?\d{8,}(?:[-/]\d+)?$/i;
const metadataRowPattern =
  /(?:体检机构|体检编号|病历号|采样时间|报告时间|打印时间|初审时间|终检时间|申请时间|审核时间|报告医师)\s*[:：]/;
const referenceOnlyPattern = /^(?:参考值|参考范围|正常范围)\s*[:：]/;
const tableOfContentsRowPattern =
  /^\s*\d{1,2}\s*[|｜]\s*[^|｜]{2,80}\s*[|｜]\s*\d{1,3}\s*$/;
const nonResultTechnicalPattern =
  /(?:^|[|｜])\s*(?:增益|走速|纸速|试剂名称|试剂纯度|纯度)\s*[:：]|^\*?\s*baPWV主要检测|^反映脑血管或心脏|^(?:异常区域|正常区域)(?:\s*[|｜]\s*(?:异常区域|正常区域))?$/i;
const mutualRecognitionMarkerPattern =
  /^[【[]\s*(?:深圳)?(?:HR|R)\s*[】\]]$/i;
const interpretationOnlyPattern = /(?:正常范围|未见异常)[。.]?$/;
const narrativeSectionHeadingPattern =
  /^(?:检查所见|检查结论|影像所见|影像结论|诊断意见|总检结论|体检综述|阳性发现|异常汇总|异常结果与健康建议|本次体检的异常结果汇总及建议|建议|主诉|现病史|既往史|门诊诊断|处理意见|处置|入院诊断|出院诊断|住院经过|手术经过|出院用药|出院医嘱|病理诊断|肉眼所见|镜下所见|免疫组化|病理分级|病理分期)(?:[：:]|\s|$)/;
const narrativeInlinePattern =
  /^(?:主诉|现病史|既往史|检查所见|检查结论|影像所见|影像结论|诊断意见|总检结论|体检综述|阳性发现|异常汇总|建议|处理意见|处置|住院经过|手术经过|出院医嘱|肉眼所见|镜下所见|免疫组化)\s*[:：]/;
const documentAnchorHeadingPattern =
  /^(?:总检结论|体检综述|阳性发现|异常汇总|异常结果与健康建议|本次体检的异常结果汇总及建议|建议|检查结论|影像结论|病理诊断|出院诊断|出院医嘱|住院经过)(?:[：:]|\s|$)/;
const morphologyNegativeCuePattern =
  /(?:未见|未发现|未提示|未检出|未观察到|未显示|无(?:明显)?|不考虑|已排除|予以排除|可以排除|可排除)/;
const morphologyPositiveCuePattern =
  /(?:可见|见到|(?<!未)发现|(?<!未)提示|(?<!不)考虑|存在|伴有|(?<!未)显示|探及|(?<!未)检出|不排除|不能排除|疑似)/;
const recommendationLeadPattern =
  /^(?:健康)?(?:建议|医嘱|注意事项|复查建议|随访建议)\s*[:：]?|^(?:请|宜|应|需|需要|推荐|定期|继续|保持|避免|控制|增加|减少|适量|每日|每天|每周)/;
const recommendationBodyPattern =
  /(?:建议|复查|随诊|随访|健康管理|生活方式|合理膳食|控制体重|适量运动|戒烟|限酒|定期观察)/;
const referenceGuidancePattern =
  /^(?:参考值|参考范围|正常范围|判定标准|判断标准|分级标准|评分标准|风险等级|风险分层|结果解释|指标说明|参考说明)\s*[:：]?/;
const referenceMatrixLabelPattern =
  /(?:参考值说明|参考范围说明|判定标准|判断标准|分级标准|评分标准|风险等级|风险分层|结果解释|数值区间|临界值|正常值范围)/;
const environmentPattern =
  /(?:^|[|｜])\s*(?:环境温度|环境湿度|室温|湿度|气压|海拔|增益|走速|纸速|扫描速度|采样频率|滤波|仪器型号|设备型号|试剂名称|试剂批号|试剂纯度|纯度|检测方法)\s*[:：|｜]/i;

function morphologyPositiveSegments(text: string) {
  return text
    .replace(
      /(?:大小|形态大小|内部回声|血流信号)[^。；，,]{0,20}(?:正常|均匀|良好)/g,
      "",
    )
    .split(/[。；;，,]|(?:但是|但|然而|而)(?=[^，,。；;])/)
    .map((segment) => segment.trim())
    .filter((segment) => {
      if (!segment || !morphologyPattern.test(segment)) return false;
      /* “不排除/不能排除”是阳性不确定事实，不能被“排除”二字误杀。 */
      if (morphologyPositiveCuePattern.test(segment)) {
        const positiveIndex = segment.search(morphologyPositiveCuePattern);
        const negativeIndex = segment.search(morphologyNegativeCuePattern);
        if (
          positiveIndex >= 0 &&
          (negativeIndex < 0 || positiveIndex >= negativeIndex)
        )
          return true;
      }
      const findingIndex = segment.search(morphologyPattern);
      const negativeIndex = segment.search(morphologyNegativeCuePattern);
      return (
        negativeIndex < 0 || findingIndex < 0 || negativeIndex > findingIndex
      );
    });
}

const normalGradeOneImagingPattern = /(?:BI-RADS|C-TIRADS)\s*1\s*类?/gi;

function isMorphologyCandidate(text: string) {
  if (!morphologyPattern.test(text)) return false;
  /* BI-RADS / C-TIRADS 1 类本身是正常分级，不应仅因分级词命中形态学候选。
     先移除正常分级，再判断同句是否还存在独立的阳性或不确定病灶；这样既能
     过滤“检查正常，分级 1 类”，也不会误杀“可见结节，分级 1 类”这类矛盾但
     必须保留复核的 OCR 事实。 */
  const withoutNormalGradeOne = text.replace(normalGradeOneImagingPattern, " ");
  if (
    withoutNormalGradeOne !== text &&
    !morphologyPositiveSegments(withoutNormalGradeOne).some((segment) =>
      morphologyPattern.test(segment),
    )
  ) {
    return false;
  }
  return morphologyPositiveSegments(text).some((segment) =>
    morphologyPattern.test(segment),
  );
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

type DictionaryAliasRow = Omit<DictionaryCandidateFact, "sectionHints"> & {
  normalizedAlias: string;
  sectionHintsJson: string;
};

type PreparedDictionaryAlias = DictionaryAliasRow & {
  compact: string;
  asciiCode: boolean;
  shortAsciiCode: boolean;
  singleHanAlias: boolean;
  asciiPattern: RegExp | null;
  firstChar: string;
  sectionHints: string[];
};

function compactDictionaryText(value: string) {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
    .replace(/[（）()：:，,。.;；、|\s_\-]/g, "")
    .replace(/[＋]/g, "+")
    .trim();
}

function activeDictionaryAliases() {
  ensureCoreDictionaryMaterialized();
  return getDatabase()
    .prepare(
      `
    SELECT c.canonical_key AS canonicalKey, c.display_name AS displayName,
      CASE WHEN c.observation_kind = 'categorical' THEN 'categorical' ELSE 'quantitative' END AS kind,
      c.value_type AS valueType, a.alias_name AS alias, a.normalized_alias AS normalizedAlias,
      c.section_hints_json AS sectionHintsJson
    FROM indicator_aliases a
    JOIN indicator_catalog c ON c.id = a.indicator_id
    WHERE a.enabled = 1
    ORDER BY LENGTH(a.normalized_alias) DESC, c.canonical_key
  `,
    )
    .all() as DictionaryAliasRow[];
}

/*
 * 别名匹配是全 pipeline 的热点：每页几十行 × 上千条别名。
 * 压缩串、ASCII 判定和边界正则只随字典变化，预计算一次；
 * 表行（等值匹配）用 Map 直接命中，非表行按别名首字符剪枝，避免全表扫描。
 */
function prepareDictionaryAliases(aliases: DictionaryAliasRow[]) {
  const prepared: PreparedDictionaryAlias[] = [];
  const exactByCompact = new Map<string, PreparedDictionaryAlias[]>();
  for (const row of aliases) {
    const compact = compactDictionaryText(row.normalizedAlias || row.alias);
    if (!compact) continue;
    const asciiCode = /^[a-z][a-z0-9.+#%]{0,15}$/i.test(compact);
    if (asciiCode && compact.length < 2) continue;
    const shortAsciiCode = asciiCode && compact.length <= 3;
    const singleHanAlias = /^[\u3400-\u9fff]$/u.test(compact);
    let sectionHints: string[] = [];
    try {
      const parsed = JSON.parse(row.sectionHintsJson || "[]") as unknown;
      if (Array.isArray(parsed))
        sectionHints = parsed.filter(
          (hint): hint is string =>
            typeof hint === "string" && Boolean(hint.trim()),
        );
    } catch {
      /* 字典提示损坏时按无提示处理，由 AI 兜底 */
    }
    const item: PreparedDictionaryAlias = {
      ...row,
      compact,
      asciiCode,
      shortAsciiCode,
      singleHanAlias,
      asciiPattern: asciiCode
        ? new RegExp(
            shortAsciiCode
              ? `(?:^|[（(\\s])${compact.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:$|[）)\\s])`
              : `(?:^|[^a-z0-9])${compact.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:$|[^a-z0-9])`,
            "i",
          )
        : null,
      firstChar: compact[0],
      sectionHints,
    };
    prepared.push(item);
    const bucket = exactByCompact.get(compact) || [];
    bucket.push(item);
    exactByCompact.set(compact, bucket);
  }
  return { prepared, exactByCompact };
}

type PreparedDictionaryAliases = ReturnType<typeof prepareDictionaryAliases>;

/*
 * 单字中文别名（当前主要是钾、钠、氯、钙、磷、镁）不能在叙述文本中做
 * 任意子串匹配，否则“富钾饮食”“钙化灶”会被误认为电解质指标。
 * 非表格场景只接受行首的明确“指标名 + 当前结果”形态；表格首列仍走精确匹配。
 */
function hasExplicitSingleHanMeasurement(text: string, alias: string) {
  const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const indicator = `(?:血清|血)?${escaped}(?:离子)?(?:测定)?(?:值|结果)?`;
  const numeric = String.raw`(?:<|<=|≤|>|>=|≥)?\s*[-+]?\d+(?:\.\d+)?`;
  const categorical = String.raw`(?:阴性|阳性|弱阳性|正常|异常)`;
  return new RegExp(
    `^\\s*${indicator}\\s*(?:(?:[:：=]\\s*)?(?:${numeric}|${categorical})|(?:偏高|偏低|升高|降低|异常)\\s*[（(]?\\s*${numeric})`,
    "iu",
  ).test(text.normalize("NFKC"));
}

function dictionaryFactsForText(
  text: string,
  aliases: PreparedDictionaryAliases,
) {
  const firstCell = text.split(/[|｜]/)[0]?.trim() || text;
  const tableRow = /[|｜]/.test(text);
  /* 表格行以“项目名格”做字典匹配：首列为序号时顺延到真正的名称格。 */
  const nameCell = tableRow
    ? skipLeadingSerialCell(splitTableCells(text).filter(Boolean))[0] ||
      firstCell
    : firstCell;
  // 章节标题可能包含“脂蛋白/载脂蛋白”等字典词，但没有当前结果，不能生成候选指标。
  if (!tableRow && /^【[^】]+】$/.test(firstCell.trim())) return [];
  const compact = compactDictionaryText(tableRow ? nameCell : text);
  if (!compact) return [];
  /*
   * “名称: 值”内联行先按冒号前的完整名称做等值匹配。这样 RV5/SV1
   * 等短代码既能保留 canonical 证据，也不会把“QRS电轴”误归到别名 QRS。
   */
  if (!tableRow) {
    const inlineName = firstCell.match(/^(.{1,40}?)\s*[:：]/)?.[1]?.trim();
    if (inlineName) {
      const exactFacts = exactDictionaryFactsForName(inlineName, aliases);
      if (exactFacts.length) return exactFacts;
    }
  }
  const facts = new Map<string, DictionaryCandidateFact>();
  const addFact = (row: PreparedDictionaryAlias) => {
    if (facts.has(row.canonicalKey)) return;
    facts.set(row.canonicalKey, {
      canonicalKey: row.canonicalKey,
      displayName: row.displayName,
      kind: row.kind,
      valueType: row.valueType,
      alias: row.alias,
      sectionHints: row.sectionHints,
    });
  };
  if (tableRow) {
    /*
     * 检验项目常带“血清”前缀或“测定”后缀（血清总胆红素、血清胱抑素C测定），
     * 等值查不到时剥离后再查 Map，仍是精确匹配，不引入子串误命中。
     */
    const stripPrefix = compact.replace(/^血清/, "");
    const stripSuffix = compact.replace(/测定$/, "");
    const variants = [
      ...new Set(
        [stripPrefix.replace(/测定$/, ""), stripPrefix, stripSuffix].filter(
          (variant) => variant && variant !== compact,
        ),
      ),
    ];
    let bucket = aliases.exactByCompact.get(compact) || [];
    if (!bucket.length) {
      for (const variant of variants) {
        bucket = aliases.exactByCompact.get(variant) || [];
        if (bucket.length) break;
      }
    }
    for (const row of bucket) {
      addFact(row);
      if (facts.size >= 8) return [...facts.values()];
    }
    /*
     * 表格项目名已有精确命中时，不再追加内部 ASCII 子项：例如 FEV1/FVC
     * 只能作为比例指标，不能同时拆成 FEV1、FVC。未登记的纯 ASCII 复合代码
     * （如 FEV1/HT）同样不能按斜杠边界误命中 FEV1 或 HT，应交给后续治理。
     */
    if (facts.size > 0) return [...facts.values()];
    const normalizedFirstCell = nameCell.normalize("NFKC");
    if (/^[A-Z0-9.+#%]+(?:\/[A-Z0-9.+#%]+)+$/i.test(normalizedFirstCell.trim()))
      return [];
    /* 表行也可能在完整项目名中包含 ASCII 缩写（如 HbA1c），再走边界正则。 */
    for (const row of aliases.prepared) {
      if (
        !row.asciiCode ||
        row.shortAsciiCode ||
        !compact.includes(row.firstChar)
      )
        continue;
      if (!row.asciiPattern!.test(normalizedFirstCell)) continue;
      addFact(row);
      if (facts.size >= 8) return [...facts.values()];
    }
    return [...facts.values()];
  }
  let normalizedFirstCell: string | null = null;
  for (const row of aliases.prepared) {
    if (facts.has(row.canonicalKey)) continue;
    if (!compact.includes(row.firstChar)) continue;
    if (
      row.singleHanAlias &&
      !hasExplicitSingleHanMeasurement(firstCell, row.compact)
    )
      continue;
    const matched = row.asciiCode
      ? row.asciiPattern!.test(
          (normalizedFirstCell ??= firstCell.normalize("NFKC")),
        )
      : compact.includes(row.compact);
    if (!matched) continue;
    addFact(row);
    if (facts.size >= 8) break;
  }
  return [...facts.values()];
}

/*
 * 按名称做等值字典重查（含“血清”前缀/“测定”后缀剥离变体），
 * 用于“名称: 值”内联行。不做子串匹配——整行子串事实对这类行不可靠
 * （“QRS电轴: 79 Angle”会误中别名“QRS”=QRS时限）。
 */
function exactDictionaryFactsForName(
  name: string,
  aliases: PreparedDictionaryAliases,
): DictionaryCandidateFact[] {
  const normalized = name.normalize("NFKC").trim();
  const codeMatches = [...normalized.matchAll(/\(([^()]*)\)/g)]
    .map((match) => match[1].trim())
    .filter((value) => /^[A-Za-z][A-Za-z0-9.+#%]{0,15}$/.test(value));
  const withoutCodes = codeMatches.length
    ? normalized.replace(/\([^()]*\)/g, " ").trim()
    : normalized;
  const nameCandidates = [
    normalized,
    ...(withoutCodes !== normalized ? [withoutCodes] : []),
    ...codeMatches,
  ];
  const variants = [
    ...new Set(
      nameCandidates.flatMap((candidate) => {
        const compact = compactDictionaryText(candidate);
        if (!compact) return [];
        const stripPrefix = compact.replace(/^血清/, "");
        const stripSuffix = compact.replace(/测定$/, "");
        return [
          compact,
          stripPrefix.replace(/测定$/, ""),
          stripPrefix,
          stripSuffix,
        ].filter((variant) => Boolean(variant));
      }),
    ),
  ];
  for (const variant of variants) {
    const bucket = aliases.exactByCompact.get(variant) || [];
    if (!bucket.length) continue;
    const facts = new Map<string, DictionaryCandidateFact>();
    for (const row of bucket) {
      if (facts.has(row.canonicalKey)) continue;
      facts.set(row.canonicalKey, {
        canonicalKey: row.canonicalKey,
        displayName: row.displayName,
        kind: row.kind,
        valueType: row.valueType,
        alias: row.alias,
        sectionHints: row.sectionHints,
      });
    }
    return [...facts.values()];
  }
  return [];
}

type BoxRect = { left: number; top: number; right: number; bottom: number };

function boxRect(value: unknown): BoxRect | null {
  if (!Array.isArray(value)) return null;
  const points = Array.isArray(value[0])
    ? value.flatMap((point) =>
        Array.isArray(point) && point.length >= 2
          ? [{ x: Number(point[0]), y: Number(point[1]) }]
          : [],
      )
    : value.length >= 4
      ? [
          { x: Number(value[0]), y: Number(value[1]) },
          { x: Number(value[2]), y: Number(value[3]) },
        ]
      : [];
  if (
    !points.length ||
    points.some(
      (point) => !Number.isFinite(point.x) || !Number.isFinite(point.y),
    )
  )
    return null;
  return {
    left: Math.min(...points.map((point) => point.x)),
    top: Math.min(...points.map((point) => point.y)),
    right: Math.max(...points.map((point) => point.x)),
    bottom: Math.max(...points.map((point) => point.y)),
  };
}

function rectHeight(rect: BoxRect) {
  return Math.max(1, rect.bottom - rect.top);
}

function verticalOverlap(left: BoxRect, right: BoxRect) {
  return (
    Math.max(
      0,
      Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top),
    ) / Math.max(1, Math.min(rectHeight(left), rectHeight(right)))
  );
}

function horizontalOverlap(left: BoxRect, right: BoxRect) {
  const width = (rect: BoxRect) => Math.max(1, rect.right - rect.left);
  return (
    Math.max(
      0,
      Math.min(left.right, right.right) - Math.max(left.left, right.left),
    ) / Math.max(1, Math.min(width(left), width(right)))
  );
}

function numericAxisSequence(cells: string[]) {
  const values = cells
    .map((cell) => cell.replace(/[%％]/g, "").trim())
    .filter((cell) => /^[-+]?\d+(?:\.\d+)?$/.test(cell))
    .map(Number);
  if (values.length < 5 || values.length < Math.ceil(cells.length * 0.7))
    return false;
  const increasing = values
    .slice(1)
    .every((value, index) => value > values[index]);
  const decreasing = values
    .slice(1)
    .every((value, index) => value < values[index]);
  if (!increasing && !decreasing) return false;
  const steps = values
    .slice(1)
    .map((value, index) => Math.abs(value - values[index]));
  const rounded = steps.map((step) => Number(step.toPrecision(6)));
  const counts = new Map<number, number>();
  for (const step of rounded) counts.set(step, (counts.get(step) || 0) + 1);
  return Math.max(...counts.values()) >= Math.ceil(steps.length * 0.6);
}

function isChartAxisRow(text: string) {
  const cells = splitTableCells(text).filter(Boolean);
  if (numericAxisSequence(cells)) return true;
  if (cells.length >= 5 && numericAxisSequence(cells.slice(1))) return true;
  return /^(?:时间|秒|分钟|年龄|百分位|预测值|实测值|流量|容量|压力)\s*[（(]?(?:s|sec|min|%|L|ml|mmHg)?[)）]?\s*(?:[|｜]\s*[-+]?\d+(?:\.\d+)?){4,}$/i.test(
    text.trim(),
  );
}

function isEnvironmentRow(text: string) {
  return (
    environmentPattern.test(text.trim()) ||
    nonResultTechnicalPattern.test(text.trim())
  );
}

function hasEmbeddedBodyCompositionResult(text: string) {
  return /(?:^|[|｜])\s*(?:测试意见|综合得分)\s*[:：]\s*[^|｜]{1,40}(?=[|｜]|$)/.test(
    text,
  );
}

function isReferenceGuidanceRow(text: string, unitPattern: RegExp) {
  const trimmed = text.trim();
  if (
    referenceOnlyPattern.test(trimmed) ||
    referenceGuidancePattern.test(trimmed)
  )
    return true;
  /* 人体成分页会把参考说明、测试意见和综合得分 OCR 到同一视觉行。
     该行含明确的当前结果，不能因为首格是参考说明就整行过滤。 */
  if (hasEmbeddedBodyCompositionResult(trimmed)) return false;
  const cells = splitTableCells(trimmed).filter(Boolean);
  if (
    referenceMatrixLabelPattern.test(trimmed) &&
    !/(?:本次|当前|检查|检验|测定)结果/.test(trimmed)
  )
    return true;
  if (cells.length < 2) return false;
  const firstCellIsAgeBand = /^\d{1,3}\s*(?:[-~～—–]|至)\s*\d{1,3}\s*岁$/.test(
    cells[0] || "",
  );
  const firstCellIsDimensionLabel =
    firstCellIsAgeBand ||
    /^(?:年龄|性别|风险|等级|分级|评分|区间|百分位)/.test(cells[0] || "");
  const hasDirectMeasurementResult =
    !firstCellIsDimensionLabel &&
    /^(?:<|<=|≤|>|>=|≥)?\s*[-+]?\d+(?:\.\d+)?(?:\s*[^\d|｜]{1,20})?[↑↓▲▼⬆⬇]?$/.test(
      cells[1] || "",
    );
  if (hasDirectMeasurementResult) return false;
  const unitSuffix = `(?:\\s*(?:${unitPattern.source}|%|％|岁))?`;
  /* 阈值格常在数值后附“为阴性/为阳性/正常/偏高”等短说明。后缀只允许
     无数字、无比较符的短文本，避免把下一条测量值吞进规则。 */
  const ruleExplanationSuffix = String.raw`(?:\s*[^\d<>≤≥~～—–|｜]{1,12})?`;
  const labelledPrefix = String.raw`(?:[^\d<>≤≥~～—–]{0,24})`;
  const comparisonRulePattern = new RegExp(
    `^${labelledPrefix}(?:<|<=|≤|>|>=|≥)\\s*[-+]?\\d+(?:\\.\\d+)?${unitSuffix}${ruleExplanationSuffix}$`,
    "iu",
  );
  const rangeRulePattern = new RegExp(
    `^${labelledPrefix}[-+]?\\d+(?:\\.\\d+)?${unitSuffix}\\s*(?:[~～—–-]|至)\\s*[-+]?\\d+(?:\\.\\d+)?${unitSuffix}${ruleExplanationSuffix}$`,
    "iu",
  );
  const categoryRulePattern =
    /^(?:正常|异常|偏高|偏低|低风险|中风险|高风险|轻度|中度|重度|I{1,3}|IV)$/i;
  const isRuleCell = (cell: string) =>
    comparisonRulePattern.test(cell.trim()) ||
    rangeRulePattern.test(cell.trim()) ||
    categoryRulePattern.test(cell.trim());
  const ruleCells = cells.filter(isRuleCell).length;
  const firstCellDefinesRule =
    isRuleCell(cells[0]) || /(?:风险|等级|分级|评分|区间)/.test(cells[0]);
  return (
    ruleCells >= 2 &&
    (firstCellDefinesRule || ruleCells === cells.length) &&
    !/(?:本次|当前|检查|检验|测定)结果/.test(trimmed)
  );
}

function isRecommendationRow(
  text: string,
  dictionaryFacts: DictionaryCandidateFact[],
  morphology: boolean,
) {
  const trimmed = text.trim();
  if (morphology) return false;
  const completeSentence = /[。；;！!？?]$/.test(trimmed);
  const explicitRecommendationLead =
    /^(?:健康)?(?:建议|医嘱|注意事项|复查建议|随访建议)\s*[:：]?/.test(trimmed);
  const recommendationIndex = trimmed.search(recommendationBodyPattern);
  const leadingClause =
    recommendationIndex > 0 ? trimmed.slice(0, recommendationIndex) : "";
  const hasLeadingMeasurement =
    Boolean(leadingClause) &&
    /\d/.test(leadingClause) &&
    (dictionaryFacts.length > 0 ||
      /(?:值|结果|偏高|偏低|异常|参考|[↑↓▲▼⬆⬇])/.test(leadingClause));
  return (
    explicitRecommendationLead ||
    (recommendationLeadPattern.test(trimmed) && completeSentence) ||
    (!hasLeadingMeasurement &&
      recommendationBodyPattern.test(trimmed) &&
      /[。；;]/.test(trimmed))
  );
}

function hasCurrentResultColumn(text: string) {
  return splitTableCells(text).some((cell) =>
    /^(?:(?:本次|当前|检查|检验|测定)?结果|测定值|检查值|实测值?|测量值)$/.test(
      cell.trim(),
    ),
  );
}

function countRangeCells(cells: string[]) {
  return cells.filter((cell) =>
    /(?:<|<=|≤|>|>=|≥)\s*[-+]?\d+(?:\.\d+)?|[-+]?\d+(?:\.\d+)?\s*(?:[~～—–-]|至)\s*[-+]?\d+(?:\.\d+)?/.test(
      cell,
    ),
  ).length;
}

function isUnsupportedComplexTable(
  text: string,
  dictionaryFacts: DictionaryCandidateFact[],
  unitPattern: RegExp,
  tableHeader: string[] | null = null,
) {
  if (hasEmbeddedBodyCompositionResult(text)) return false;
  const cells = splitTableCells(text).filter(Boolean);
  const headerText = tableHeader?.join(" | ") || "";
  /* TCD 的“血管 × 参数”稀疏矩阵由本地坐标解析器闭环，不属于需要 AI 猜测的
     参考矩阵。缺列必须按横坐标保留为空，不能按文本数组顺序左移。 */
  if (headerText && tcdTableHeaderPattern.test(headerText)) return false;
  const matrixSource = headerText || text;
  const matrixLabel = referenceMatrixLabelPattern.test(matrixSource);
  const dimensionalHeader =
    /(?:年龄|性别|风险|等级|分级|评分|区间|百分位).*(?:年龄|性别|风险|等级|分级|评分|区间|百分位)/.test(
      matrixSource,
    );
  const currentResultHeader =
    hasCurrentResultColumn(headerText) ||
    /(?:本次|当前|检查|检验|测定)结果/.test(matrixSource);
  const numericCells = cells.filter((cell) =>
    /[-+]?\d+(?:\.\d+)?/.test(cell),
  ).length;
  const valueColumns =
    tableHeader?.filter((cell) =>
      /(?:年龄|性别|风险|等级|分级|评分|区间|百分位|男|女)/.test(cell),
    ).length || 0;
  const dimensionCells = cells.filter((cell) =>
    /(?:年龄|性别|风险|等级|分级|评分|区间|百分位|\d+\s*岁|%|％|^男$|^女$)/.test(
      cell,
    ),
  ).length;
  const rangeCells = countRangeCells(cells);
  const firstCellIsAgeBand = /^\d{1,3}\s*(?:[-~～—–]|至)\s*\d{1,3}\s*岁$/.test(
    cells[0] || "",
  );
  const firstCellIsDimensionLabel =
    firstCellIsAgeBand ||
    /^(?:年龄|性别|风险|等级|分级|评分|区间|百分位)/.test(cells[0] || "");
  const hasDirectMeasurementResult =
    !firstCellIsDimensionLabel &&
    /^(?:<|<=|≤|>|>=|≥)?\s*[-+]?\d+(?:\.\d+)?(?:\s*[^\d|｜]{1,20})?[↑↓▲▼⬆⬇]?$/.test(
      cells[1] || "",
    );
  const strongMatrixStructure =
    matrixLabel ||
    dimensionalHeader ||
    valueColumns >= 2 ||
    dimensionCells >= 2 ||
    (cells.length >= 6 && rangeCells >= 2);
  const strongHeaderMatrix =
    Boolean(headerText) &&
    (matrixLabel || dimensionalHeader || valueColumns >= 2);
  return (
    cells.length >= 4 &&
    numericCells >= 3 &&
    !currentResultHeader &&
    (!hasDirectMeasurementResult || strongHeaderMatrix) &&
    strongMatrixStructure &&
    (dictionaryFacts.length === 0 ||
      matrixLabel ||
      dimensionalHeader ||
      valueColumns >= 2 ||
      dimensionCells >= 2)
  );
}

function looksLikeStandardMeasurementRow(cells: string[], unitPattern: RegExp) {
  /* 首列序号顺延后再按“名称 | 结果 | 参考/单位/标记”的标准测量行判定。 */
  const measurementCells = skipLeadingSerialCell(cells);
  if (
    measurementCells.length < 2 ||
    !resultCellPattern.test(measurementCells[1])
  )
    return false;
  return measurementCells.slice(2).every((cell) => {
    const trimmed = cell.trim();
    const pureUnit = !/\d/.test(trimmed) && unitPattern.test(trimmed);
    const reference =
      /(?:<|<=|≤|>|>=|≥)\s*[-+]?\d+(?:\.\d+)?/.test(trimmed) ||
      /[-+]?\d+(?:\.\d+)?\s*(?:[~～—–-]|至)\s*[-+]?\d+(?:\.\d+)?/.test(trimmed);
    const flag =
      /^(?:正常|异常|偏高|偏低|高|低|阴性|阳性|弱阳性|[↑↓▲▼⬆⬇])$/.test(trimmed);
    return pureUnit || reference || flag;
  });
}

function isWholeMeasurementValueCell(cell: string, unitPattern: RegExp) {
  /* 已知单位优先；字典外兜底单位只接受拉丁/希腊字母和常见单位符号，
     不接受中文叙述，避免把“25-羟维生素D”一类指标名当成结果值。 */
  const genericUnit = String.raw`[A-Za-zμµΩ°℃%‰/·²³^()]+(?:[A-Za-z0-9μµΩ°℃%‰/·²³^()]*)`;
  return new RegExp(
    `^(?:<|<=|≤|>|>=|≥)?\\s*[-+]?\\d+(?:\\.\\d+)?(?:\\s*(?:${unitPattern.source}|${genericUnit}))?\\s*[↑↓▲▼⬆⬇]?$`,
    "iu",
  ).test(cell.trim());
}

function isAmbiguousMeasurementLayout(
  text: string,
  dictionaryFacts: DictionaryCandidateFact[],
  unitPattern: RegExp,
  tableHeader: string[] | null = null,
) {
  const genericSegmentFat =
    /^(?:脂肪)\s*[:：]?\s*(?:<|<=|≤|>|>=|≥)?\s*[-+]?\d+(?:\.\d+)?\s*kg\s*$/i.test(
      text.trim(),
    );
  /* “脂肪”没有总量/体脂肪量或身体部位限定时无法确定是哪个分段值。
     即使字典碰巧命中，也只保留审计，不允许自动补提取。 */
  if (genericSegmentFat) return true;
  const cells = splitTableCells(text).filter(Boolean);
  if (dictionaryFacts.length || cells.length < 2) return false;
  const hasExplicitResultCue = /(?:本次|当前|检查|检验|测定)结果/.test(text);
  const hasCurrentResultHeader = tableHeader?.length
    ? hasCurrentResultColumn(tableHeader.join(" | "))
    : false;
  /* 部分功能检查设备会把曲线/分段代码重建成“ABC18-70(ABC1) | 0.603”一类行：
     名称格同时含数值区间和重复的不透明设备代码，且没有字典、单位或明确“本次结果”表头。
     这种行可能是冷门测量，也可能是曲线分段/参考标签；主 AI 仍可识别，但禁止遗漏补提取
     对同一歧义证据反复追问并持久化不稳定指标。重复代码约束可避免误伤 FEF25-75 等
     常见但名称中含区间的真实肺功能指标。 */
  const opaqueDeviceRangeLabel =
    /^([A-Z]{2,6})\s*\d{1,3}\s*(?:[-~～—–]|至)\s*\d{1,3}\s*[（(]\s*\1\s*\d{1,2}\s*[）)]$/i;
  const opaqueDeviceRangeRow =
    cells.length === 2 &&
    opaqueDeviceRangeLabel.test(cells[0]) &&
    isWholeMeasurementValueCell(cells[1], unitPattern) &&
    !hasExplicitResultCue &&
    !hasCurrentResultHeader;
  if (opaqueDeviceRangeRow) return true;
  if (looksLikeStandardMeasurementRow(cells, unitPattern)) return false;
  const numericCells = cells.filter((cell) =>
    /[-+]?\d+(?:\.\d+)?/.test(cell),
  ).length;
  const labelledValues = cells.filter((cell) =>
    /^[^|｜:：]{1,30}\s*[:：]\s*(?:<|<=|≤|>|>=|≥)?\s*[-+]?\d+(?:\.\d+)?/.test(
      cell,
    ),
  ).length;
  const measurementValueCells = cells.filter((cell) =>
    isWholeMeasurementValueCell(cell, unitPattern),
  ).length;
  const dateMetadataCells = cells.filter(
    (cell) =>
      metadataCellValuePattern.test(cell.trim()) ||
      /(?:日期|时间)\s*[:：]?\s*\d{4}[-/.年]\d{1,2}(?:[-/.月]\d{1,2}日?)?(?:\s*\d{1,2}[:：]?\d{2}(?::?\d{2})?)?/.test(
        cell,
      ),
  ).length;
  const rangeCells = countRangeCells(cells);
  const strongJoinedLayout =
    labelledValues >= 2 ||
    measurementValueCells >= 2 ||
    (dateMetadataCells >= 1 && cells.length >= 3) ||
    (cells.length >= 4 && rangeCells >= 2);
  if (strongJoinedLayout) return !hasExplicitResultCue;
  if (hasCurrentResultHeader) return false;
  return (
    !hasExplicitResultCue &&
    ((cells.length >= 3 && numericCells >= 2) ||
      (dateMetadataCells >= 1 && numericCells >= 2))
  );
}

type ContentRoleInput = {
  text: string;
  boundary: PlannedOcrLine["boundary"];
  metadata: boolean;
  candidate: boolean;
  morphology: boolean;
  dictionaryFacts: DictionaryCandidateFact[];
  narrative: boolean;
  regionRole?: OcrContentRole | null;
  tableHeader?: string[] | null;
  unitPattern: RegExp;
};

function classifyOcrContent(input: ContentRoleInput): {
  contentRole: OcrContentRole;
  candidateResolutionReason: CandidateResolutionReason | null;
} {
  const chartAxis = isChartAxisRow(input.text);
  const complexTable =
    !chartAxis &&
    isUnsupportedComplexTable(
      input.text,
      input.dictionaryFacts,
      input.unitPattern,
      input.tableHeader,
    );
  let contentRole: OcrContentRole;
  if (input.metadata) contentRole = "metadata";
  else if (chartAxis) contentRole = "chart_axis";
  else if (isEnvironmentRow(input.text)) contentRole = "environment";
  else if (
    complexTable ||
    isReferenceGuidanceRow(input.text, input.unitPattern)
  )
    contentRole = "reference";
  else if (
    isRecommendationRow(input.text, input.dictionaryFacts, input.morphology)
  )
    contentRole = "recommendation";
  else if (
    input.regionRole &&
    input.regionRole !== "measurement" &&
    !input.candidate
  )
    contentRole = input.regionRole;
  else if (input.candidate || input.morphology) contentRole = "measurement";
  else contentRole = "narrative";

  if (complexTable)
    return {
      contentRole,
      candidateResolutionReason: "unsupported_complex_table",
    };
  if (contentRole !== "measurement") {
    return {
      contentRole,
      candidateResolutionReason: [
        "metadata",
        "chart_axis",
        "environment",
        "reference",
        "recommendation",
      ].includes(contentRole)
        ? "filtered_noise"
        : null,
    };
  }
  return {
    contentRole,
    candidateResolutionReason: isAmbiguousMeasurementLayout(
      input.text,
      input.dictionaryFacts,
      input.unitPattern,
      input.tableHeader,
    )
      ? "ambiguous_layout"
      : input.candidate
        ? "supplement_required"
        : null,
  };
}

function regionRoleForHeading(text: string): OcrContentRole | null {
  const heading = cleanContextLabel(text);
  if (/(?:建议|医嘱|健康管理|注意事项)/.test(heading)) return "recommendation";
  if (referenceMatrixLabelPattern.test(heading)) return "reference";
  if (/(?:环境|仪器|设备|试剂|检测条件)/.test(heading)) return "environment";
  if (narrativeSectionHeadingPattern.test(text)) return "narrative";
  return null;
}

function visualSourceCells(
  ordered: PlannedOcrLine[],
  finalText: string,
): PlannedOcrCell[] {
  const expanded = ordered.flatMap((line) => {
    const parts = splitTableCells(line.text);
    return parts.map((text, index): PlannedOcrCell => ({
      index,
      text,
      sourceLineIds: [...line.sourceLineIds],
      box: line.box,
    }));
  });
  const finalCells = splitTableCells(finalText);
  const fallbackSourceLineIds = [
    ...new Set(ordered.flatMap((line) => line.sourceLineIds)),
  ];
  return finalCells.map((text, index) => ({
    index,
    text,
    sourceLineIds: expanded[index]?.sourceLineIds || fallbackSourceLineIds,
    box: expanded[index]?.box ?? ordered[0]?.box ?? null,
  }));
}

const bodyCompositionSyntheticLinePrefix = "body_composition_layout_";
const quantitativeUltrasoundBoneSyntheticLinePrefix =
  "quantitative_ultrasound_bone_layout_";

function isCoordinateSyntheticLine(line: Pick<PlannedOcrLine, "id">) {
  return (
    line.id.startsWith(bodyCompositionSyntheticLinePrefix) ||
    line.id.startsWith(quantitativeUltrasoundBoneSyntheticLinePrefix)
  );
}

type BodyCompositionCoordinatePair = {
  itemName: string;
  itemPattern: RegExp;
  unit: "cm" | "kg" | "kcal";
  allowValueAbove?: boolean;
};

const bodyCompositionCoordinatePairs: BodyCompositionCoordinatePair[] = [
  {
    itemName: "身高",
    itemPattern: /^身高$/,
    unit: "cm",
    allowValueAbove: true,
  },
  { itemName: "体重", itemPattern: /^体重$/, unit: "kg" },
  { itemName: "体脂肪量", itemPattern: /^体脂(?:含量|肪量)$/, unit: "kg" },
  { itemName: "基础代谢", itemPattern: /^基础代谢(?:率|量)?$/, unit: "kcal" },
];

function bodyCompositionValueText(text: string, unit: string) {
  const normalized = text.normalize("NFKC").replace(/\s+/g, "").trim();
  const matched = normalized.match(
    /^([-+]?\d+(?:\.\d+)?)(cm|厘米|kg|千克|公斤|kcal|千卡)?$/i,
  );
  if (!matched) return null;
  const explicitUnit = matched[2]?.toLocaleLowerCase("zh-CN") || "";
  const compatible =
    !explicitUnit ||
    (unit === "cm" && /^(?:cm|厘米)$/i.test(explicitUnit)) ||
    (unit === "kg" && /^(?:kg|千克|公斤)$/i.test(explicitUnit)) ||
    (unit === "kcal" && /^(?:kcal|千卡)$/i.test(explicitUnit));
  if (!compatible) return null;
  return `${matched[1]}${unit}`;
}

function bodyCompositionVerticalGap(left: BoxRect, right: BoxRect) {
  if (left.bottom < right.top) return right.top - left.bottom;
  if (right.bottom < left.top) return left.top - right.bottom;
  return 0;
}

/*
 * 设备首页把“字段名”和“字段值”排成同一竖列，却可能落在相邻 OCR 基线：
 * 身高值甚至位于竖排“身高”标签上方。这里仅对明确报告标题、明确核心字段、
 * 纯数值和真实 x/y 对齐做配对；不按数组位置猜值，也不处理目标/建议字段。
 */
function repairBodyCompositionCoordinatePairs(lines: PlannedOcrLine[]) {
  if (
    !lines.some((line) => bodyCompositionReportContextPattern.test(line.text))
  )
    return lines;
  const consumed = new Set<string>();
  const synthetic: PlannedOcrLine[] = [];
  for (const spec of bodyCompositionCoordinatePairs) {
    const label = lines.find(
      (line) =>
        !consumed.has(line.id) &&
        spec.itemPattern.test(line.text.normalize("NFKC").trim()),
    );
    const labelRect = label ? boxRect(label.box) : null;
    if (!label || !labelRect) continue;
    const labelCenter = (labelRect.left + labelRect.right) / 2;
    const candidates = lines.flatMap((line) => {
      if (line.id === label.id || consumed.has(line.id)) return [];
      const valueText = bodyCompositionValueText(line.text, spec.unit);
      const rect = boxRect(line.box);
      if (!valueText || !rect) return [];
      const valueCenter = (rect.left + rect.right) / 2;
      const gap = bodyCompositionVerticalGap(labelRect, rect);
      const rowHeight = Math.max(rectHeight(labelRect), rectHeight(rect));
      const horizontallyAligned =
        horizontalOverlap(labelRect, rect) >= 0.45 ||
        Math.abs(labelCenter - valueCenter) <=
          Math.max(labelRect.right - labelRect.left, rect.right - rect.left) *
            0.55;
      const valueAbove = rect.bottom <= labelRect.top;
      if (
        !horizontallyAligned ||
        gap > Math.max(36, rowHeight * 0.8) ||
        (valueAbove && !spec.allowValueAbove)
      )
        return [];
      return [
        {
          line,
          rect,
          valueText,
          gap,
          centerGap: Math.abs(labelCenter - valueCenter),
        },
      ];
    });
    candidates.sort(
      (left, right) => left.gap - right.gap || left.centerGap - right.centerGap,
    );
    const selected = candidates[0];
    if (!selected) continue;
    consumed.add(label.id);
    consumed.add(selected.line.id);
    const sourceLineIds = [
      ...new Set([...label.sourceLineIds, ...selected.line.sourceLineIds]),
    ];
    synthetic.push({
      ...label,
      id: `${bodyCompositionSyntheticLinePrefix}${label.id}_${selected.line.id}`,
      sourceLineIds,
      sourceCells: [
        {
          index: 0,
          text: spec.itemName,
          sourceLineIds: [...label.sourceLineIds],
          box: label.box,
        },
        {
          index: 1,
          text: selected.valueText,
          sourceLineIds: [...selected.line.sourceLineIds],
          box: selected.line.box,
        },
      ],
      text: `${spec.itemName} | ${selected.valueText}`,
      confidence:
        label.confidence !== null && selected.line.confidence !== null
          ? (label.confidence + selected.line.confidence) / 2
          : null,
      box: [
        Math.min(labelRect.left, selected.rect.left),
        Math.min(labelRect.top, selected.rect.top),
        Math.max(labelRect.right, selected.rect.right),
        Math.max(labelRect.bottom, selected.rect.bottom),
      ],
    });
  }
  return [...lines.filter((line) => !consumed.has(line.id)), ...synthetic];
}

function quantitativeUltrasoundBoneScoreValue(text: string) {
  const normalized = text
    .normalize("NFKC")
    .replace(/(?<=\d)\s*[.]\s*(?=\d)/g, ".")
    .replace(/\s+/g, "")
    .trim();
  if (!/^[-+]?\d+(?:\.\d+)?$/.test(normalized)) return null;
  const value = Number(normalized);
  if (!Number.isFinite(value) || value < -10 || value > 10) return null;
  return { text: normalized, value };
}

/*
 * 部分 QUS 设备把 T/Z 标签放在图表表头，把两个结果纵向排在参数区末尾，
 * OCR 因而无法按同行关系重建。这里只在同时满足以下强条件时配对：
 * 明确 QUS 报告标题、T/Z 标签成对出现、结果分析标题形成下边界、边界内恰有
 * 两个同列且相邻的 -10～10 纯数值。设备参数和图表刻度仍保留原过滤策略。
 */
function repairQuantitativeUltrasoundBoneScorePairs(lines: PlannedOcrLine[]) {
  if (
    !lines.some((line) =>
      quantitativeUltrasoundBoneContextPattern.test(line.text),
    )
  )
    return lines;
  const labelFor = (pattern: RegExp) =>
    lines.find((line) => pattern.test(line.text.normalize("NFKC").trim()));
  const tLabel = labelFor(/^(?:T\s*值|T[-\s]?score)$/i);
  const zLabel = labelFor(/^(?:Z\s*值|Z[-\s]?score)$/i);
  const tRect = tLabel ? boxRect(tLabel.box) : null;
  const zRect = zLabel ? boxRect(zLabel.box) : null;
  if (!tLabel || !zLabel || !tRect || !zRect) return lines;
  if (verticalOverlap(tRect, zRect) < 0.55 || tRect.left >= zRect.left)
    return lines;

  const labelBottom = Math.max(tRect.bottom, zRect.bottom);
  const resultHeading = lines
    .flatMap((line) => {
      if (!/^(?:结果分析|分析结果|结果判定|检测结果)$/.test(line.text.trim()))
        return [];
      const rect = boxRect(line.box);
      return rect && rect.top > labelBottom ? [{ line, rect }] : [];
    })
    .sort((left, right) => left.rect.top - right.rect.top)[0];
  if (!resultHeading || resultHeading.rect.top - labelBottom > 420)
    return lines;

  const scores = lines
    .flatMap((line) => {
      if (line.id === tLabel.id || line.id === zLabel.id) return [];
      const score = quantitativeUltrasoundBoneScoreValue(line.text);
      const rect = boxRect(line.box);
      if (
        !score ||
        !rect ||
        rect.top <= labelBottom ||
        rect.bottom >= resultHeading.rect.top
      )
        return [];
      return [{ line, rect, ...score }];
    })
    .sort((left, right) => left.rect.top - right.rect.top);
  if (scores.length !== 2) return lines;
  const [tScore, zScore] = scores;
  const tCenter = (tScore.rect.left + tScore.rect.right) / 2;
  const zCenter = (zScore.rect.left + zScore.rect.right) / 2;
  const scoreColumnAligned =
    horizontalOverlap(tScore.rect, zScore.rect) >= 0.7 ||
    Math.abs(tCenter - zCenter) <=
      Math.max(
        tScore.rect.right - tScore.rect.left,
        zScore.rect.right - zScore.rect.left,
      ) *
        0.35;
  const scoreGap = Math.max(0, zScore.rect.top - tScore.rect.bottom);
  const maxScoreHeight = Math.max(
    rectHeight(tScore.rect),
    rectHeight(zScore.rect),
  );
  if (
    !scoreColumnAligned ||
    scoreGap > Math.max(56, maxScoreHeight * 1.6) ||
    resultHeading.rect.top - zScore.rect.bottom > 120
  )
    return lines;

  const sourceLineIds = [
    ...new Set([
      ...tLabel.sourceLineIds,
      ...tScore.line.sourceLineIds,
      ...zLabel.sourceLineIds,
      ...zScore.line.sourceLineIds,
    ]),
  ];
  const synthetic: PlannedOcrLine = {
    ...tLabel,
    id: `${quantitativeUltrasoundBoneSyntheticLinePrefix}${tLabel.id}_${tScore.line.id}_${zLabel.id}_${zScore.line.id}`,
    sourceLineIds,
    sourceCells: [
      {
        index: 0,
        text: "T值",
        sourceLineIds: [...tLabel.sourceLineIds],
        box: tLabel.box,
      },
      {
        index: 1,
        text: tScore.text,
        sourceLineIds: [...tScore.line.sourceLineIds],
        box: tScore.line.box,
      },
      {
        index: 2,
        text: "Z值",
        sourceLineIds: [...zLabel.sourceLineIds],
        box: zLabel.box,
      },
      {
        index: 3,
        text: zScore.text,
        sourceLineIds: [...zScore.line.sourceLineIds],
        box: zScore.line.box,
      },
    ],
    text: `T值 | ${tScore.text} | Z值 | ${zScore.text}`,
    confidence: [
      tLabel.confidence,
      tScore.line.confidence,
      zLabel.confidence,
      zScore.line.confidence,
    ].every((value) => value !== null)
      ? (
          [
            tLabel.confidence,
            tScore.line.confidence,
            zLabel.confidence,
            zScore.line.confidence,
          ] as number[]
        ).reduce((sum, value) => sum + value, 0) / 4
      : null,
    box: [
      Math.min(tRect.left, zRect.left),
      Math.min(tRect.top, zRect.top),
      Math.max(tRect.right, zRect.right),
      Math.max(tRect.bottom, zRect.bottom),
    ],
  };
  const consumed = new Set([
    tLabel.id,
    zLabel.id,
    tScore.line.id,
    zScore.line.id,
  ]);
  return [...lines.filter((line) => !consumed.has(line.id)), synthetic];
}

function rebuildBodyCompositionCells(
  line: PlannedOcrLine,
  cells: Array<{ sourceIndex: number; text: string }>,
  aliases: PreparedDictionaryAliases,
  unitPattern: RegExp,
) {
  const sourceCells = cells.map(({ sourceIndex, text }, index) => ({
    ...(line.sourceCells[sourceIndex] || {
      sourceLineIds: [...line.sourceLineIds],
      box: line.box,
    }),
    index,
    text,
  }));
  const rebuilt = mergeVisualRow(
    [
      {
        ...line,
        id: `${bodyCompositionSyntheticLinePrefix}${line.id}`,
        text: sourceCells.map((cell) => cell.text).join(" | "),
        sourceLineIds: [
          ...new Set(sourceCells.flatMap((cell) => cell.sourceLineIds)),
        ],
        sourceCells,
      },
    ],
    line.index,
    aliases,
    unitPattern,
  );
  return { ...rebuilt, id: line.id, index: line.index };
}

const bodyCompositionMainTableItems = [
  { pattern: /^体重(?:[（(]kg[）)])?$/i, itemName: "体重", unit: "kg" },
  {
    pattern: /^体脂肪量(?:[（(]kg[）)])?$/i,
    itemName: "体脂肪量",
    unit: "kg",
  },
  {
    pattern: /^体脂肪率(?:[（(]%[）)])?$/i,
    itemName: "体脂肪率",
    unit: "%",
  },
  { pattern: /^体重指数(?:[（(].*[）)])?$/i, itemName: "体重指数", unit: null },
  {
    pattern: /^(?:肌肉量|肌内量)(?:[（(]kg[）)])?$/i,
    itemName: "肌肉量",
    unit: "kg",
  },
  {
    pattern: /^体水分量(?:[（(]kg[）)])?$/i,
    itemName: "体水分量",
    unit: "kg",
  },
] as const;

function withBodyCompositionUnit(value: string, unit: string | null) {
  const normalized = value.normalize("NFKC").replace(/\s+/g, "").trim();
  if (!unit || /[A-Za-z%％千克公斤厘米]/.test(normalized)) return normalized;
  return /^[-+]?\d+(?:\.\d+)?$/.test(normalized)
    ? `${normalized}${unit}`
    : normalized;
}

/* 裁掉人体成分主表右侧图表刻度，并从左右肢体分段列中保留中间的全身主表列。 */
function normalizeBodyCompositionLayout(
  lines: PlannedOcrLine[],
  aliases: PreparedDictionaryAliases,
  unitPattern: RegExp,
) {
  if (
    !lines.some((line) => bodyCompositionReportContextPattern.test(line.text))
  )
    return lines;
  return lines.map((line) => {
    const cells = splitTableCells(line.text).map((cell) => cell.trim());
    if (
      cells.length >= 3 &&
      /^(?:测定)?项目$/.test(cells[0]) &&
      /^测定值$/.test(cells[1]) &&
      /^参考值$/.test(cells[2])
    ) {
      return rebuildBodyCompositionCells(
        line,
        cells.slice(0, 3).map((text, sourceIndex) => ({ sourceIndex, text })),
        aliases,
        unitPattern,
      );
    }

    const inlineCore = cells
      .map((cell, sourceIndex) => ({ cell, sourceIndex }))
      .filter(({ cell }) =>
        /^(?:除脂肪量|肌肉量|体水分量)\s*[:：]\s*[-+]?\d+(?:\.\d+)?\s*(?:kg|千克|公斤)$/i.test(
          cell.normalize("NFKC"),
        ),
      );
    const labelledBodyComponentCells = cells.filter((cell) =>
      /^(?:除脂肪量|肌肉量|肌内量|体水分量|脂肪)\s*[:：]\s*[-+]?\d+(?:\.\d+)?\s*(?:kg|千克|公斤)$/i.test(
        cell.normalize("NFKC"),
      ),
    );
    if (
      cells.length > 1 &&
      inlineCore.length === 1 &&
      labelledBodyComponentCells.length === 1
    ) {
      return rebuildBodyCompositionCells(
        line,
        [{ sourceIndex: inlineCore[0].sourceIndex, text: inlineCore[0].cell }],
        aliases,
        unitPattern,
      );
    }

    for (
      let sourceIndex = 0;
      sourceIndex < cells.length - 1;
      sourceIndex += 1
    ) {
      const spec = bodyCompositionMainTableItems.find((item) =>
        item.pattern.test(cells[sourceIndex].normalize("NFKC")),
      );
      if (!spec) continue;
      const result = withBodyCompositionUnit(cells[sourceIndex + 1], spec.unit);
      if (!/^[-+]?\d+(?:\.\d+)?(?:kg|%)?$/i.test(result)) continue;
      const selected = [
        { sourceIndex, text: spec.itemName },
        { sourceIndex: sourceIndex + 1, text: result },
      ];
      const reference = cells[sourceIndex + 2] || "";
      if (
        /^(?:[-+]?\d+(?:\.\d+)?)(?:\s*[-~～至]\s*[-+]?\d+(?:\.\d+)?)?%?$/.test(
          reference,
        )
      ) {
        selected.push({ sourceIndex: sourceIndex + 2, text: reference });
      }
      return rebuildBodyCompositionCells(line, selected, aliases, unitPattern);
    }
    return line;
  });
}

function mergeVisualRow(
  lines: PlannedOcrLine[],
  index: number,
  aliases: PreparedDictionaryAliases,
  unitPattern: RegExp,
): PlannedOcrLine {
  const visuallyOrdered = [...lines].sort(
    (left, right) =>
      (boxRect(left.box)?.left ?? left.index) -
      (boxRect(right.box)?.left ?? right.index),
  );
  /* 检验报告会在项目与结果之间印“【深圳HR】”等结果互认标记。它是装饰列，
     不是表头定义的数据列；若保留，结果会从第 2 格错移到第 3 格，整行因此退出
     指标候选。只在同一视觉行还有其它内容时剥离，页脚里的互认说明仍会保留。 */
  const withoutRecognitionMarkers = visuallyOrdered.filter(
    (line) => !mutualRecognitionMarkerPattern.test(line.text.trim()),
  );
  const ordered = withoutRecognitionMarkers.length
    ? withoutRecognitionMarkers
    : visuallyOrdered;
  const rects = ordered
    .map((line) => boxRect(line.box))
    .filter((rect): rect is BoxRect => Boolean(rect));
  const joinedText = redactAiInputText(
    ordered.map((line) => line.text).join(" | "),
  );
  /* 合并行里的页脚声明等噪声片段会把整行拖入噪声分类，剥离后保住同行的报告时间等元数据 */
  const text = stripChartAxisTicks(
    stripFooterNoiseFragments(joinedText) || joinedText,
  );
  const sourceCells =
    ordered.length === 1 && isCoordinateSyntheticLine(ordered[0])
      ? ordered[0].sourceCells.map((cell, index) => ({ ...cell, index }))
      : visualSourceCells(ordered, text);
  const boundary = boundaryFor(text);
  const rawDictionaryFacts = dictionaryFactsForText(text, aliases);
  const morphology = isMorphologyCandidate(text);
  const nonResultNoise = isNonResultNoise(text);
  const metadataRow = isMetadataRow(text);
  const metadata =
    metadataRow ||
    metadataCandidatePattern.test(text) ||
    metadataRowPattern.test(text);
  const dictionaryResult =
    boundary !== "section" &&
    !nonResultNoise &&
    !metadataRow &&
    rawDictionaryFacts.length > 0 &&
    /\d|阴性|阳性|弱阳性|正常|异常|未见|可见|(?:AB|A|B|O)型/.test(text) &&
    !metadataCandidatePattern.test(text) &&
    !metadataRowPattern.test(text);
  const provisionalCandidate =
    boundary === "section" || nonResultNoise || metadataRow
      ? false
      : morphology || isCandidateRow(text, unitPattern) || dictionaryResult;
  const content = classifyOcrContent({
    text,
    boundary,
    metadata,
    candidate: provisionalCandidate,
    morphology,
    dictionaryFacts: rawDictionaryFacts,
    narrative: narrativeInlinePattern.test(text),
    unitPattern,
  });
  const candidate =
    content.contentRole === "measurement" && provisionalCandidate;
  const candidateKind =
    candidate && morphology ? "morphology" : candidate ? "scalar" : null;
  const dictionaryFacts = candidate ? rawDictionaryFacts : [];
  const role: OcrLineRole =
    nonResultNoise ||
    ["chart_axis", "environment", "reference"].includes(content.contentRole)
      ? "noise"
      : boundary === "table_header"
        ? "table_header"
        : boundary === "section"
          ? "section_heading"
          : metadata
            ? "metadata"
            : candidateKind === "morphology"
              ? "morphology"
              : candidateKind === "scalar"
                ? "scalar"
                : content.contentRole === "recommendation" ||
                    narrativeInlinePattern.test(text)
                  ? "narrative"
                  : "uncertain";
  return {
    id:
      ordered.length === 1
        ? ordered[0].id
        : `layout_row_${ordered.map((line) => line.id).join("_")}`,
    sourceLineIds: ordered.flatMap((line) => line.sourceLineIds),
    sourceCells,
    index,
    text,
    confidence: ordered.every((line) => line.confidence !== null)
      ? ordered.reduce((sum, line) => sum + (line.confidence || 0), 0) /
        ordered.length
      : null,
    box: rects.length
      ? [
          Math.min(...rects.map((rect) => rect.left)),
          Math.min(...rects.map((rect) => rect.top)),
          Math.max(...rects.map((rect) => rect.right)),
          Math.max(...rects.map((rect) => rect.bottom)),
        ]
      : ordered[0].box,
    candidate,
    candidateKind,
    dictionaryFacts,
    boundary,
    role,
    contentRole: content.contentRole,
    candidateResolutionReason: content.candidateResolutionReason,
    localObservation: null,
    localObservations: [],
  };
}

function isNonResultNoise(text: string) {
  const trimmed = text.trim();
  if (nonResultTechnicalPattern.test(trimmed)) return true;
  return (
    interpretationOnlyPattern.test(trimmed) &&
    !/[|｜]/.test(trimmed) &&
    !/(?:检验|检查|报告)?结果\s*[:：]/.test(trimmed)
  );
}

/*
 * PDF 原生文本会在版心边界把指标名拆成两行，例如：
 * “低密度脂蛋白胆固” + “醇值偏高(3.76mmol/L)…”。下一行本身带数值，
 * 通用换行合并会刻意避开它。这里只在跨行片段能够精确拼成启用中的字典别名、
 * 且续行具有明确测量语义时放行；不把“醇值”等残片加入字典，避免脱离上下文误归一化。
 */
function isDictionaryMeasurementContinuation(
  previousText: string,
  currentText: string,
  aliases: PreparedDictionaryAliases,
  unitPattern: RegExp,
) {
  if (
    /[|｜]/.test(previousText) ||
    /[|｜]/.test(currentText) ||
    /[。！？；;:：]\s*$/.test(previousText) ||
    !/\d/.test(currentText) ||
    !(
      /(?:值|结果|偏高|偏低|增高|降低).{0,16}\d/.test(currentText) &&
      (unitPattern.test(currentText) ||
        /(?:参考值|参考范围|正常范围)/.test(currentText))
    )
  ) {
    return false;
  }
  const previousCompact = compactDictionaryText(previousText);
  const currentCompact = compactDictionaryText(currentText);
  if (!previousCompact || !currentCompact) return false;

  let longestMatch = 0;
  for (const alias of aliases.prepared) {
    if (alias.asciiCode || alias.compact.length < 4) continue;
    for (let split = 2; split < alias.compact.length; split += 1) {
      const leftFragment = alias.compact.slice(0, split);
      const rightFragment = alias.compact.slice(split);
      if (
        previousCompact.endsWith(leftFragment) &&
        currentCompact.startsWith(rightFragment)
      ) {
        longestMatch = Math.max(longestMatch, alias.compact.length);
      }
    }
  }
  return longestMatch >= 4;
}

type PositionedVisualRow = {
  lines: PlannedOcrLine[];
  rects: BoxRect[];
  bounds: BoxRect;
  detachedChartAxis?: boolean;
};

const strictVisualNumericCellPattern =
  /^[-+]?(?:\d+(?:\.\d+)?|\.\d+)(?:\s*[%％])?$/;

function positionedVisualRow(
  lines: PlannedOcrLine[],
  detachedChartAxis = false,
): PositionedVisualRow {
  const rects = lines
    .map((line) => boxRect(line.box))
    .filter((rect): rect is BoxRect => Boolean(rect));
  return {
    lines,
    rects,
    bounds: rects.length
      ? {
          left: Math.min(...rects.map((rect) => rect.left)),
          top: Math.min(...rects.map((rect) => rect.top)),
          right: Math.max(...rects.map((rect) => rect.right)),
          bottom: Math.max(...rects.map((rect) => rect.bottom)),
        }
      : { left: 0, top: 0, right: 0, bottom: 0 },
    detachedChartAxis,
  };
}

function visualLinesByLeft(row: PositionedVisualRow) {
  return [...row.lines].sort(
    (left, right) =>
      (boxRect(left.box)?.left ?? left.index) -
      (boxRect(right.box)?.left ?? right.index),
  );
}

function isStrictVisualNumericCell(line: PlannedOcrLine) {
  return strictVisualNumericCellPattern.test(line.text.trim());
}

function isVisualParameterLabel(
  line: PlannedOcrLine,
  aliases: PreparedDictionaryAliases,
) {
  if (exactDictionaryFactsForName(line.text, aliases).length > 0) return true;
  return /^[A-Za-z][A-Za-z0-9./%()+\-]{1,24}$/.test(line.text.trim());
}

/*
 * 设备图表和结果表共用横向版面时，图表刻度可能与左侧指标名垂直重叠，
 * 而真正的实测/预测值因基线偏移被 OCR 聚到下一视觉行。典型真实证据是：
 *   FVC(x=251) + 80(x=1177，图表刻度)
 *   3.63(x=441) + 86.6(x=617，主表结果列)
 *   FEV0.5(x=251，下一参数)
 *
 * 这里只在“精确字典指标 + 远右孤立数字 + 下一行纯数值 + 再下一行新参数”
 * 同时满足严格坐标关系时恢复错行。远右刻度不删除，拆成独立 chart_axis 证据；
 * 避免靠文本猜测列归属，也避免把正常多列表格的数字跨行搬移。
 */
function repairDetachedMeasurementValueRows(
  rows: PositionedVisualRow[],
  aliases: PreparedDictionaryAliases,
) {
  const repaired: PositionedVisualRow[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const current = rows[index];
    const values = rows[index + 1];
    const following = rows[index + 2];
    if (!values || !following || current.lines.length !== 2) {
      repaired.push(current);
      continue;
    }

    const currentLines = visualLinesByLeft(current);
    const valueLines = visualLinesByLeft(values);
    const followingLines = visualLinesByLeft(following);
    const indicator = currentLines[0];
    const detachedTick = currentLines[1];
    const nextParameter = followingLines[0];
    const indicatorRect = boxRect(indicator?.box);
    const tickRect = boxRect(detachedTick?.box);
    const nextParameterRect = boxRect(nextParameter?.box);
    const valueRects = valueLines.map((line) => boxRect(line.box));
    if (
      !indicator ||
      !detachedTick ||
      !nextParameter ||
      !indicatorRect ||
      !tickRect ||
      !nextParameterRect ||
      valueLines.length < 1 ||
      valueLines.length > 3 ||
      valueRects.some((rect) => rect === null) ||
      exactDictionaryFactsForName(indicator.text, aliases).length !== 1 ||
      !isStrictVisualNumericCell(detachedTick) ||
      !valueLines.every(isStrictVisualNumericCell) ||
      !isVisualParameterLabel(nextParameter, aliases)
    ) {
      repaired.push(current);
      continue;
    }

    const strictValueRects = valueRects as BoxRect[];
    const rowHeight = Math.max(
      rectHeight(indicatorRect),
      ...strictValueRects.map(rectHeight),
    );
    const firstValueLeft = Math.min(
      ...strictValueRects.map((rect) => rect.left),
    );
    const lastValueRight = Math.max(
      ...strictValueRects.map((rect) => rect.right),
    );
    const indicatorToValuesTop = values.bounds.top - current.bounds.top;
    const valuesToNextTop = following.bounds.top - values.bounds.top;
    const alignedNextParameter =
      Math.abs(nextParameterRect.left - indicatorRect.left) <= rowHeight * 2;
    const valuesInsideMainTable =
      firstValueLeft >= indicatorRect.right + rowHeight &&
      lastValueRight <= tickRect.left - rowHeight * 4;
    const tickClearlyDetached =
      verticalOverlap(indicatorRect, tickRect) >= 0.5 &&
      tickRect.left >= lastValueRight + rowHeight * 4 &&
      tickRect.left >= indicatorRect.right + rowHeight * 10;
    const adjacentRows =
      indicatorToValuesTop >= rowHeight * 0.45 &&
      indicatorToValuesTop <= rowHeight * 1.35 &&
      valuesToNextTop >= rowHeight * 0.45 &&
      valuesToNextTop <= rowHeight * 1.5;

    if (
      !alignedNextParameter ||
      !valuesInsideMainTable ||
      !tickClearlyDetached ||
      !adjacentRows
    ) {
      repaired.push(current);
      continue;
    }

    repaired.push(positionedVisualRow([indicator, ...valueLines]));
    repaired.push(positionedVisualRow([detachedTick], true));
    index += 1;
  }
  return repaired;
}

function reconstructPageLayout(
  lines: PlannedOcrLine[],
  aliases: PreparedDictionaryAliases,
  unitPattern: RegExp,
) {
  /* 每行坐标只解析一次；行包围盒随行合并增量维护，避免排序和行匹配里重复 boxRect。 */
  const rects = lines.map((line) => boxRect(line.box));
  const positioned = rects.filter((rect) => rect !== null);
  if (positioned.length < Math.max(2, Math.ceil(lines.length * 0.6))) {
    return lines.map((line, index) =>
      mergeVisualRow([line], index, aliases, unitPattern),
    );
  }
  const sorted = lines
    .map((line, index) => ({ line, rect: rects[index] }))
    .sort((left, right) => {
      const leftRect = left.rect;
      const rightRect = right.rect;
      if (!leftRect || !rightRect) return left.line.index - right.line.index;
      const topDifference = leftRect.top - rightRect.top;
      if (
        Math.abs(topDifference) >
        Math.min(rectHeight(leftRect), rectHeight(rightRect)) * 0.45
      ) {
        return topDifference;
      }
      return leftRect.left - rightRect.left;
    });
  const rows: PositionedVisualRow[] = [];
  for (const { line, rect } of sorted) {
    if (!rect) {
      rows.push({
        lines: [line],
        rects: [],
        bounds: { left: 0, top: 0, right: 0, bottom: 0 },
      });
      continue;
    }
    if (isCoordinateSyntheticLine(line)) {
      rows.push({ lines: [line], rects: [rect], bounds: { ...rect } });
      continue;
    }
    let row: (typeof rows)[number] | undefined;
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      const candidate = rows[index];
      if (!candidate.rects.length) continue;
      if (candidate.lines.some((item) => isCoordinateSyntheticLine(item)))
        continue;
      if (
        verticalOverlap(candidate.bounds, rect) >= 0.55 &&
        candidate.rects.every((item) => horizontalOverlap(item, rect) < 0.25)
      ) {
        row = candidate;
        break;
      }
    }
    if (row) {
      row.lines.push(line);
      row.rects.push(rect);
      row.bounds = {
        left: Math.min(row.bounds.left, rect.left),
        top: Math.min(row.bounds.top, rect.top),
        right: Math.max(row.bounds.right, rect.right),
        bottom: Math.max(row.bounds.bottom, rect.bottom),
      };
    } else {
      rows.push({ lines: [line], rects: [rect], bounds: { ...rect } });
    }
  }
  const reconstructed = repairDetachedMeasurementValueRows(rows, aliases).map(
    (row, index) => {
      const merged = mergeVisualRow(row.lines, index, aliases, unitPattern);
      if (!row.detachedChartAxis) return merged;
      return {
        ...merged,
        candidate: false,
        candidateKind: null,
        dictionaryFacts: [],
        role: "noise" as const,
        contentRole: "chart_axis" as const,
        candidateResolutionReason: "filtered_noise" as const,
        localObservation: null,
        localObservations: [],
      };
    },
  );
  return normalizeBodyCompositionLayout(reconstructed, aliases, unitPattern);
}

/*
 * 超声“提示/结论”常是一行一个器官结论，行尾通常没有句号。当前一行已经是
 * 完整阳性发现，而下一行从新器官（或器官列表）开始并明确写“未见/无异常”时，
 * 两行是独立事实，不是 OCR 折行。阻止把阳性病灶与后续多器官负性结论串成
 * 一个 morphology candidate；真正的断词续行（如“未见胆” + “管扩张”）不命中。
 */
function startsIndependentNegativeImagingConclusion(text: string) {
  const normalized = text.normalize("NFKC").trim();
  const organLead =
    /^(?:(?:肝|胆|胰|脾|肾)(?:[、,，](?:肝|胆|胰|脾|肾))+|(?:双侧|双叶|左侧|右侧|左叶|右叶)?(?:甲状腺|乳腺|卵巢|肾脏?|肺(?:部)?|眼|耳)|前列腺|子宫|膀胱|输尿管|颈动脉|椎动脉|心脏|胆囊|胰腺|脾脏|肝脏)/;
  if (!organLead.test(normalized)) return false;
  return morphologyNegativeCuePattern.test(normalized);
}

function mergeWrappedPageLines(
  lines: PlannedOcrLine[],
  aliases: PreparedDictionaryAliases,
  unitPattern: RegExp,
) {
  const merged: PlannedOcrLine[] = [];
  for (const line of lines) {
    const previous = merged.at(-1);
    const combinedText = previous ? `${previous.text}${line.text}` : "";
    const strictNegativeContinuation =
      Boolean(previous) &&
      ((/未见胆\s*$/.test(previous!.text) && /^管扩张/.test(line.text)) ||
        (/未见(?:明显)?异常[。.]?\s*$/.test(previous!.text) &&
          /^(?:C-TIRADS|BI-RADS)\s*1\s*类?[。.]?$/i.test(line.text.trim())));
    const dictionaryMeasurementContinuation = Boolean(
      previous &&
      !previous.boundary &&
      !line.boundary &&
      isDictionaryMeasurementContinuation(
        previous.text,
        line.text,
        aliases,
        unitPattern,
      ),
    );
    const independentNegativeImagingConclusion = Boolean(
      previous &&
      previous.candidateKind === "morphology" &&
      isMorphologyCandidate(previous.text) &&
      startsIndependentNegativeImagingConclusion(line.text),
    );
    const shouldMerge = Boolean(
      previous &&
      !independentNegativeImagingConclusion &&
      (strictNegativeContinuation ||
        dictionaryMeasurementContinuation ||
        (!/[|｜]/.test(previous.text) &&
          !/[|｜]/.test(line.text) &&
          !previous.boundary &&
          !line.boundary &&
          !/[。！？；;:：]$/.test(previous.text) &&
          (!isCandidateRow(line.text, unitPattern) ||
            /(?:直径约\d+[a-z]?|水平位(?:[（(][^）)]*[）)])?生|血流充盈)$/i.test(
              previous.text,
            )) &&
          (previous.text.length >= 24 ||
            previous.candidateKind === "morphology" ||
            /(?:直径约\d+[a-z]?|水平位(?:[（(][^）)]*[）)])?生|血流充盈|回声|建议|复查|随诊)$/i.test(
              previous.text,
            )) &&
          (isMorphologyCandidate(combinedText) ||
            /(?:建议|复查|随诊|定期观察)/.test(combinedText) ||
            /^[a-zA-Z，,、）)；;。]/.test(line.text) ||
            previous.text.length >= 36))),
    );
    if (!previous || !shouldMerge) {
      merged.push(line);
      continue;
    }
    const rebuilt = mergeVisualRow(
      [{ ...previous, text: combinedText }],
      previous.index,
      aliases,
      unitPattern,
    );
    merged[merged.length - 1] = {
      ...rebuilt,
      id: `wrapped_${previous.id}_${line.id}`,
      sourceLineIds: [...previous.sourceLineIds, ...line.sourceLineIds],
      sourceCells: [
        {
          index: 0,
          text: rebuilt.text,
          sourceLineIds: [...previous.sourceLineIds, ...line.sourceLineIds],
          box: previous.box,
        },
      ],
      confidence:
        previous.confidence !== null && line.confidence !== null
          ? (previous.confidence + line.confidence) / 2
          : (previous.confidence ?? line.confidence),
      box: previous.box,
    };
  }
  return merged.map((line, index) => ({ ...line, index }));
}

type PageLineContext = {
  section: string | null;
  reportSection: string | null;
  narrativeActive: boolean;
  tableHeader: string[] | null;
  tableHeaderCells: PlannedOcrCell[] | null;
  contentRegion: OcrContentRole | null;
  pageNumber: number | null;
  endedWithCandidate: boolean;
};

function cleanSectionHeading(value: string) {
  return (
    value
      .replace(/^【\s*|\s*】$/g, "")
      .replace(/[:：]$/, "")
      .trim() || null
  );
}

function cleanContextLabel(value: string) {
  return value
    .replace(/^【\s*|\s*】$/g, "")
    .replace(/[:：]$/, "")
    .trim();
}

function splitTableCells(value: string) {
  return value.split(/[|｜]/).map((cell) => cell.trim());
}

/*
 * 检验表格常在首列印序号（1、2、3…），序号不是指标名。
 * 所有按“首格=项目名”的判定统一经这里取真正的测量单元格：
 * 首格是 1～2 位纯数字、后面还有名称格和结果格时顺延一格，
 * 否则“1 | 钙 | 1.626 | …”整表会退出候选，AI 提取的正确结果
 * 也会因没有 scalar 候选行可挂而被证据校验全部拒绝。
 * 纯数字第二格（如“120 | 80”）不可能是项目名，不做顺延。
 */
function skipLeadingSerialCell(cells: string[]) {
  if (
    cells.length >= 3 &&
    /^\d{1,2}$/.test(cells[0].trim()) &&
    /[\p{L}㐀-鿿]/u.test(cells[1])
  )
    return cells.slice(1);
  return cells;
}

/*
 * 图表页（肺功能、人体成分等）常把坐标轴刻度 OCR 进行尾：
 * “… | 10 | 15 | 20 | 25 | 30 | (SEC)”。刻度的形态是 ≥5 个严格递增、
 * 步长占多数一致的纯数字单元格（可带 ≤2 个标签尾巴）；检验值列通常 ≤3 个
 * 数字格且不严格递增，历年对比值列步长无规律，形态上可区分。
 * 剥掉尾段刻度，保留数据主体，减少 AI 输入噪声和证据引用长度。
 */
function stripChartAxisTicks(text: string) {
  if (!/[|｜]/.test(text)) return text;
  const cells = splitTableCells(text);
  let end = cells.length;
  let labelTail = 0;
  while (
    end > 0 &&
    labelTail < 2 &&
    /^[(（]?[A-Za-z一-鿿%]{1,8}[)）]?$/.test(cells[end - 1]) &&
    !/^[-+]?\d/.test(cells[end - 1])
  ) {
    end -= 1;
    labelTail += 1;
  }
  const values: number[] = [];
  for (let index = end - 1; index >= 0; index -= 1) {
    if (!/^[-+]?\d+(?:\.\d+)?$/.test(cells[index])) break;
    values.unshift(Number(cells[index]));
  }
  /* 数据值列也可能恰好是纯数字（99.45 | 79.48 | 125.1），刻度是数字尾段里
     最长的严格递增后缀——真实数据列很少构成递增后缀，刻度则是天然递增序列。 */
  let suffixStart = values.length - 1;
  while (suffixStart > 0 && values[suffixStart - 1] < values[suffixStart])
    suffixStart -= 1;
  const ticks = values.slice(suffixStart);
  if (ticks.length < 5) return text;
  const steps = ticks.slice(1).map((value, index) => value - ticks[index]);
  const stepCounts = new Map<number, number>();
  for (const step of steps)
    stepCounts.set(step, (stepCounts.get(step) || 0) + 1);
  const dominantStep = Math.max(...stepCounts.values());
  if (dominantStep <= steps.length / 2) return text;
  const keep = cells.length - ticks.length - labelTail;
  if (keep < 2) return text;
  return cells.slice(0, keep).join(" | ");
}

/*
 * 元数据行的结构判定：每个单元格都是标签（…日期/…编号/…部位等）、
 * 日期/时间/序号类值、性别年龄值或报告标题。与具体标签词表无关，
 * 避免“出生日期 | 1992-06-11 | 测量部位（左/右）”这类无冒号行被误判为指标候选。
 * 指标行必然含有不匹配这些模式的数值结果格，不会整行命中。
 */
const metadataCellLabelPattern =
  /^(?:[一-鿿]{0,8}(?:日期|时间|编号|部位|姓名|性别|年龄|民族|婚姻|职业|科室|病区|床号|医生|医师|医院|仪器|方法|样本|标本|条码))\s*[:：]?\s*[^|｜]{0,30}$/;
const metadataCellValuePattern =
  /^(?:\d{4}[-/.年]\d{1,2}(?:[-/.月]\d{1,2}日?)?(?:\s*\d{1,2}[:：]\d{2}(?:[:：]\d{2})?)?|\d{1,2}[:：]\d{2}(?:[:：]\d{2})?|\d{1,3}\s*岁|男|女|男性|女性|\d+\s*\/\s*\d+)$/;
const timestampMetadataCellPattern =
  /^(?:采样|检测|检查|测定|报告|打印)?时间\s*[:：]?\s*\d{4}[-/.年]\d{1,2}(?:[-/.月]\d{1,2}日?)?(?:\s*\d{1,2}[:：]\d{2}(?:[:：]\d{2})?)?$/;
const labelOnlyResidualCellPattern =
  /^[^\d|｜:：]{0,24}(?:调节|代谢|说明|目标|项目|名称|测定|评估)(?:\s*[（(][^）)\d]{1,12}[）)])?$/;

function isAdministrativeDevicePresetRow(cells: string[]) {
  return (
    cells.length === 2 &&
    /^(?:门诊|住院|急诊|病房|体检)(?:患者|场景|模式)?$/.test(cells[0].trim()) &&
    /^[A-Za-z]\s*[:：]?\s*[-+]?\d+(?:\.\d+)?$/.test(cells[1].trim())
  );
}

function isMisalignedGenderMetadataRow(cells: string[]) {
  return (
    cells.length >= 3 &&
    /^性别\s*[:：]?$/.test(cells[0].trim()) &&
    /^(?!男$|女$|男性$|女性$)[-+]?\d+(?:\.\d+)?$/.test(cells[1].trim()) &&
    cells
      .slice(2)
      .every((cell) => labelOnlyResidualCellPattern.test(cell.trim()))
  );
}

function isTimestampLabelOnlyRow(cells: string[]) {
  if (
    cells.length < 2 ||
    !timestampMetadataCellPattern.test(
      cells[0].replace(/(?<=\d{2})(?=\d{2}:)/, " "),
    )
  ) {
    return false;
  }
  /* 时间戳后的格子若只有字段名、没有实际结果值，是 OCR 将表单标签横向拼接后的残行。
     单位只能出现在括号中；任何额外数字或定性结果都会退出该规则，继续保守交给候选审计。 */
  return cells
    .slice(1)
    .every(
      (cell) =>
        !/\d/.test(cell) &&
        !/(?:正常|异常|阴性|阳性|偏高|偏低)/.test(cell) &&
        labelOnlyResidualCellPattern.test(cell.trim()),
    );
}

function isMetadataRow(text: string) {
  const cells = splitTableCells(text).filter(Boolean);
  if (cells.length < 2) return false;
  if (isTimestampLabelOnlyRow(cells)) return true;
  if (
    isAdministrativeDevicePresetRow(cells) ||
    isMisalignedGenderMetadataRow(cells)
  )
    return true;
  return cells.every(
    (cell) =>
      metadataCellLabelPattern.test(cell) ||
      metadataCellValuePattern.test(cell) ||
      reportHeadingPattern.test(cell),
  );
}

const resultCellPattern =
  /^(?:<|<=|≤|>|>=|≥)?\s*(?:[-+±]+|[-+]?\d+(?:\.\d+)?|阴性|阳性|弱阳性|正常|异常|未见(?:异常)?|可见|无特殊)(?:\s|$|[↑↓▲▼⬆⬇])/;
const reportHeadingPattern =
  /(?:(?:检验|检查|体检|超声|心电图|病理|门诊|住院|出院|动脉阻塞|动脉功能).{0,18}|人体成(?:分|份)(?:分析)?)(?:报告|报告单)$/;

const pulmonaryReportContextPattern = /肺功能|肺通气|呼吸功能|肺量计|spirom/i;
const tcdReportContextPattern = /经颅多普勒|\bTCD\b|脑血流/i;
const ultrasoundReportContextPattern =
  /超声|彩超|(?:^|[^A-Za-z])B超|ultrasound|sonograph/i;
const bodyCompositionReportContextPattern =
  /人体成(?:分|份)(?:分析)?报告|身体组成分析报告|body\s*composition\s*analysis/i;
const quantitativeUltrasoundBoneContextPattern =
  /超声骨(?:密度|质)|定量超声骨|quantitative\s+ultrasound|(?:^|[^A-Za-z])QUS(?:[^A-Za-z]|$)/i;

function hasBodyCompositionReportContext(
  section: string | null,
  reportSection: string | null,
) {
  return bodyCompositionReportContextPattern.test(
    [section, reportSection].filter(Boolean).join(" "),
  );
}

/*
 * 人体成分设备报告同时包含全身趋势、调节目标、身体部位分段值、年龄标准表和
 * 活动热量换算。后四类内容仍保留在 OCR 原文中，但不进入家庭趋势或 AI 补提取。
 * 规则只在明确的人体成分报告标题下生效，避免影响普通体检和营养报告。
 */
function isBodyCompositionNonTrendRow(
  text: string,
  section: string | null,
  reportSection: string | null,
) {
  if (!hasBodyCompositionReportContext(section, reportSection)) return false;
  const normalized = text.normalize("NFKC").trim();
  const cells = splitTableCells(normalized).filter(Boolean);
  if (
    /(?:理想|理相)体重|(?:体重|脂肪|肌肉)调节|建议每日摄取卡路里/.test(
      normalized,
    )
  )
    return true;
  if (
    /^(?:躯干|左臂|右臂|左腿|右腿)(?:[（(]|[:：]|$)/.test(normalized) ||
    cells.some((cell) => /^(?:左臂|右臂|左腿|右腿)(?:[（(]|$)/.test(cell))
  )
    return true;
  if (/^(?:脂肪|肌内量)\s*[:：]/.test(normalized)) return true;
  if (
    cells.filter((cell) => /^(?:肌肉量|肌内量)\s*[:：]/.test(cell)).length > 1
  )
    return true;
  if (/(?:细胞内液|细胞外液|蛋白质|骨骼量|内脏脂肪等级)/.test(normalized))
    return true;
  if (
    cells.length >= 2 &&
    cells.every((cell) => /^[-+]?\d+(?:\.\d+)?\s*(?:kg|千克|公斤)$/i.test(cell))
  )
    return true;
  if (
    /(?:成人体脂肪率标准|年龄范围|测试意见|综合得分|活动耗热参考|活动项目|卡\/公斤\/小时|洗碗、打字|扫地、走路|下楼梯|游泳)/.test(
      normalized,
    )
  )
    return true;
  return false;
}

/*
 * 定量超声骨检测页会展示 SOS、BUA、骨质指数以及成人/同龄比等设备测量或
 * 派生参数。它们依赖设备算法、测量部位和参考数据库，跨报告直接建立家庭趋势
 * 容易制造不可比的“新指标”；原文继续保留给报告详情和文档级总结，但不进入
 * scalar AI 补提取。规则仅在明确的超声骨检测报告上下文且命中参数标签时生效，
 * 不影响 DXA 报告中的 BMD、T 值、Z 值等标准结果。
 */
function isQuantitativeUltrasoundBoneDeviceParameterRow(
  text: string,
  section: string | null,
  reportSection: string | null,
) {
  const context = [section, reportSection].filter(Boolean).join(" ");
  if (!quantitativeUltrasoundBoneContextPattern.test(context)) return false;
  return /(?:^|[|｜])\s*(?:骨质指数|成人比|同龄比|SOS|BUA|OPR)\s*(?:[:：]|[|｜]|$)/i.test(
    text.normalize("NFKC"),
  );
}

/*
 * “检查项目 | 未见异常”属于报告中的阴性查体证据，而不是适合跨期绘图的趋势指标。
 * 仅过滤名称明确以“检查/查体”结尾、结果为纯阴性描述且没有字典定义的二列表格行；
 * 数值、阳性发现、已标准化的分类检验均不会命中，仍按原流程处理。
 */
function isGenericNegativeExamEvidenceRow(
  text: string,
  tableHeader: string[] | null,
  dictionaryFacts: DictionaryCandidateFact[],
) {
  if (
    dictionaryFacts.length ||
    !tableHeader?.some((cell) => /检查结果/.test(cell))
  )
    return false;
  const cells = splitTableCells(text).filter(Boolean);
  if (cells.length !== 2) return false;
  const item = cells[0].trim();
  const result = cells[1].trim().replace(/[。.]$/, "");
  return (
    /(?:检查|查体)$/.test(item) &&
    /^(?:未见(?:明显)?异常|无明显异常|未发现异常)$/.test(result)
  );
}

function compactFunctionalParameterName(value: string) {
  return value
    .normalize("NFKC")
    .toUpperCase()
    .replace(/\s+/g, "")
    .replace(/[％﹪]/g, "%")
    .replace(/[／⁄]/g, "/")
    .replace(/[–—~～至]/g, "-");
}

/*
 * 肺功能设备会输出大量身高校正量、质控量和不透明分段算法参数。
 * 这些参数保留在 OCR 页面证据中，但不进入 scalar AI 补提取：结果层本来就会
 * 以 functional_device_filter 排除它们，若仍发送给 AI 只会浪费 token，并增加
 * 把设备内部参数误建为家庭趋势指标的风险。规则必须保持保守：仅在明确肺功能
 * 上下文生效，且明确保留 FEF25-75（MMEF）等核心临床指标。
 */
function isPulmonaryDeviceDerivedParameter(
  text: string,
  section: string | null,
  reportSection: string | null,
) {
  if (
    !pulmonaryReportContextPattern.test(
      [section, reportSection].filter(Boolean).join(" "),
    )
  )
    return false;
  const name = compactFunctionalParameterName(splitTableCells(text)[0] || "");
  if (!name) return false;
  if (/\/HT(?:$|[（(])/.test(name)) return true;
  if (/^(?:PEF[-_]?TIME|FET|V[-_]?EXTRAP|EXTRAP[-_]?V)$/.test(name))
    return true;
  if (/^(?:FEF|MEF)\d+(?:\.\d+)?\/(?:FEF|FIF|MEF|MIF)\d+(?:\.\d+)?$/.test(name))
    return true;
  if (/\/VCPR(?:$|[（(])/.test(name)) return true;
  if (/^FEV0[.]5$/.test(name)) return true;
  if (
    /^FEF\d+(?:\.\d+)?-\d+(?:\.\d+)?%?$/.test(name) &&
    !/^FEF25-75%?$/.test(name)
  )
    return true;
  return /^([A-Z]{2,6})\d{1,3}-\d{1,3}[（(]\1\d{1,2}[）)]$/.test(name);
}

/*
 * 超声图像页会把设备声学输出安全指数叠印在图像边缘，例如 TIs/TIb/TIc
 * （热指数）和 MI（机械指数）。这些数值描述的是设备当前输出状态，不是受检者
 * 的临床测量；OCR 还常把大写 I 识别成小写 l/数字 1，并将同一图像行横向拼接。
 * 仅在明确超声报告上下文、同一重建行至少出现两个安全指数且其余格子均为短设备
 * 叠印代码时过滤，避免误伤“结节 6 mm / C-TIRADS 3 类”等真实超声结果。
 */
function isUltrasoundSafetyIndexCell(text: string) {
  const compact = text
    .normalize("NFKC")
    .toUpperCase()
    .replace(/\s+/g, "")
    .replace(/[：:＝=]/g, "");
  return /^(?:T(?:I|L|1)[SBC]|MI)[<≤]?\d+(?:\.\d+)?$/.test(compact);
}

function isUltrasoundDeviceOverlayCompanionCell(text: string) {
  if (isUltrasoundSafetyIndexCell(text)) return true;
  const compact = text.normalize("NFKC").trim().toUpperCase();
  if (!compact || compact.length > 12) return false;
  return (
    /^[-+]?\d+(?:\.\d+)?$/.test(compact) ||
    /^[A-Z]{1,3}\s*\d+(?:\.\d+)?$/.test(compact) ||
    /^[A-Z][\u3400-\u9FFF]{1,3}$/.test(compact) ||
    /^(?:门诊|住院|急诊|病房|体检|成人|儿童)$/.test(compact)
  );
}

function isUltrasoundDeviceSafetyIndexRow(
  text: string,
  section: string | null,
  reportSection: string | null,
) {
  if (
    !ultrasoundReportContextPattern.test(
      [section, reportSection].filter(Boolean).join(" "),
    )
  )
    return false;
  const cells = splitTableCells(text).filter(Boolean);
  if (cells.length < 2) return false;
  if (cells.filter(isUltrasoundSafetyIndexCell).length < 2) return false;
  return cells.every(isUltrasoundDeviceOverlayCompanionCell);
}

/*
 * TCD 报告的频谱图下方通常会再次打印当前选中血管、探测方式和一组
 * “深度/Vp/Vm/Vd/PI/RI/S-D/HR”参数。这些内容与上方明细表属于同一次测量的
 * 设备面板复写，不是第二组独立健康事实；保留在 OCR 原文中，但不再进入 AI
 * 候选或趋势。只在明确 TCD 报告上下文且每个单元格都有设备标签时生效。
 */

function isTcdDevicePanelRow(
  text: string,
  section: string | null,
  reportSection: string | null,
) {
  if (
    !tcdReportContextPattern.test(
      [section, reportSection].filter(Boolean).join(" "),
    )
  )
    return false;
  const cells = splitTableCells(text).filter(Boolean);
  if (cells.length < 2) return false;
  return cells.every((cell) =>
    /^(?:血管|方式|方向|深度|Vp|Vm|Vd|PI|RI|S\/?D|HR)\s*[:：]/i.test(
      cell.trim(),
    ),
  );
}

function isTcdGraphicVesselLabelText(text: string) {
  const tokens = text
    .normalize("NFKC")
    .trim()
    .toUpperCase()
    .split(/\s+/)
    .filter(Boolean);
  if (!tokens.length || !tokens.every((token) => /^[A-Z]{2,12}$/.test(token)))
    return false;
  return tokens.some((token) =>
    /^(?:(?:L|R)(?:ICA|ACA|MCA|PCA|VA|CCA|ECA)|BA)$/.test(token),
  );
}

function isTcdGraphicLabelRow(
  line: PlannedOcrLine,
  section: string | null,
  reportSection: string | null,
) {
  if (
    !tcdReportContextPattern.test(
      [section, reportSection].filter(Boolean).join(" "),
    )
  )
    return false;
  const text = line.text.trim();
  const cells = splitTableCells(text).filter(Boolean);
  if (cells.length && cells.every(isTcdGraphicVesselLabelText)) return true;
  if (!/^\d{1,3}(?:\.\d+)?$/.test(text)) return false;
  const rect = boxRect(line.sourceCells[0]?.box ?? line.box);
  return Boolean(rect && rect.left < 360);
}

/*
 * 频谱图缩写有时与左侧“检查所见”正文处在同一 OCR 基线，布局重建会把二者
 * 合并成一行。仅在明确 TCD 上下文中从 AI 重建行剥离纯英文血管图形标签；
 * 原始 OCR 行仍保留在 linesJson，临床正文和其证据坐标不受影响。
 */
function stripTcdGraphicLabelCells(
  line: PlannedOcrLine,
  section: string | null,
  reportSection: string | null,
) {
  if (
    line.sourceCells.length < 2 ||
    !tcdReportContextPattern.test(
      [section, reportSection].filter(Boolean).join(" "),
    )
  )
    return line;
  const retainedCells = line.sourceCells.filter(
    (cell) => !isTcdGraphicVesselLabelText(cell.text),
  );
  if (!retainedCells.length || retainedCells.length === line.sourceCells.length)
    return line;
  return {
    ...line,
    text: retainedCells.map((cell) => cell.text).join(" | "),
    sourceLineIds: [
      ...new Set(retainedCells.flatMap((cell) => cell.sourceLineIds)),
    ],
    sourceCells: retainedCells.map((cell, index) => ({ ...cell, index })),
  };
}

/*
 * 表单尾部的“检查医师/报告医师”空标签可能与同基线的小结横向合并。
 * 标签本身没有结果值，保留会阻断严格的小结解析并浪费 AI 输入；仅当同一重建行
 * 至少还有一个包含明确结果形态的单元格时剥离，原始 OCR 坐标仍保留在存档中。
 */
function stripTrailingAdministrativeLabelCells(line: PlannedOcrLine) {
  if (line.sourceCells.length < 2) return line;
  const retainedCells = [...line.sourceCells];
  while (
    retainedCells.length > 1 &&
    /^(?:(?:检查|报告|审核|复核|主检|总检)医师|医生签名|医师签名)$/.test(
      retainedCells[retainedCells.length - 1].text.trim(),
    )
  ) {
    retainedCells.pop();
  }
  if (retainedCells.length === line.sourceCells.length) return line;
  const retainedText = retainedCells.map((cell) => cell.text).join(" | ");
  if (
    !/\d|阴性|阳性|正常|异常|未见|可见|偏高|偏低|增高|降低|参考值|参考范围/.test(
      retainedText,
    )
  ) {
    return line;
  }
  return {
    ...line,
    text: retainedText,
    sourceLineIds: [
      ...new Set(retainedCells.flatMap((cell) => cell.sourceLineIds)),
    ],
    sourceCells: retainedCells.map((cell, index) => ({ ...cell, index })),
  };
}

/*
 * “名称: 值”内联格式的值部分：必须是完整测量值——
 * 数值 + 可选已知单位 + 可选趋势箭头，或纯分类词。
 * 双值（120/80mmHg）或值后粘连叙述（“，建议复查”）不匹配，保持交 AI。
 */
const inlineCategoricalValuePattern =
  /^(?:[-+±]+|阴性|阳性|弱阳性|正常|异常|未见(?:异常)?|可见)$/;
function inlineNumericValuePattern(unitPattern: RegExp) {
  return new RegExp(
    `^(?:<|<=|≤|>|>=|≥)?\\s*[-+]?\\d+(?:\\.\\d+)?(?:\\s*(?:${unitPattern.source}))?\\s*[↑↓▲▼⬆⬇]?\\s*$`,
    "i",
  );
}

type PatientSex = "male" | "female";

/*
 * 成员档案未填性别时，从报告前两页 OCR 文本推断：
 * 显式“性别：男”，或性别单元格（独立行或表格行内的 男/女 格）+
 * 同页年龄上下文（33岁/年龄/出生）同时成立才采信，避免叙述文本误判。
 */
export function patientSexFromOcrText(
  linesJsonValues: Array<string | null>,
): PatientSex | null {
  for (const value of linesJsonValues.slice(0, 2)) {
    let lines: Array<{ text?: unknown }> = [];
    try {
      const parsed = JSON.parse(value || "[]") as unknown;
      if (Array.isArray(parsed)) lines = parsed;
    } catch {
      continue;
    }
    const texts = lines
      .map((line) => String(line.text || "").trim())
      .filter(Boolean);
    const explicit = texts
      .map((text) => text.match(/性别\s*[:：|｜]?\s*(男|女)/))
      .find((match): match is RegExpMatchArray => Boolean(match));
    if (explicit) return explicit[1] === "男" ? "male" : "female";
    const hasAgeContext = texts.some((text) =>
      /\d{1,3}\s*岁|年龄|出生/.test(text),
    );
    if (!hasAgeContext) continue;
    for (const text of texts) {
      const cell = splitTableCells(text).find((item) =>
        /^(?:男|女)$/.test(item),
      );
      if (cell) return cell === "男" ? "male" : "female";
    }
  }
  return null;
}

/*
 * 性别分段参考范围（男：1.79~8.14|女：<0.99）按患者性别选段。
 * 性别未知、或段内还有绝经前/后子分段（需要年龄才能再选）时不猜，
 * 返回空段由上层保守放弃本地解析，交给 AI 结合上下文处理。
 */
function genderedReferenceSegment(
  clean: string,
  patientSex: PatientSex | null | undefined,
) {
  if (!/(?:男|女)\s*[:：]/.test(clean)) return null;
  const segment =
    patientSex === "male"
      ? clean.match(/男\s*[:：]\s*([^|｜;；]+)/)?.[1]
      : patientSex === "female"
        ? clean.match(/女\s*[:：]\s*([^|｜;；]+)/)?.[1]
        : null;
  if (segment && /绝经/.test(segment)) return "";
  return segment ?? "";
}

/* 性别分段参考范围用 | 分段（男：…|女：…），会被单元格切分拆开。
   参考列以性别段开头时把后续单元格拼回再解析。 */
function referenceCellText(cells: string[], index: number) {
  const cell = cells[index];
  if (cell && /^(?:男|女)\s*[:：]/.test(cell.trim()))
    return cells.slice(index).join(" | ");
  return cell;
}

function parseReferenceCell(
  value: string,
  unitPattern: RegExp,
  patientSex?: PatientSex | null,
) {
  /*
   * 参考范围常带粘连单位（125~350 10^9/L），不先剥离的话
   * "10^9/L" 的数字会被并进上限（35010）。先去掉已知单位再解析数值。
   */
  const clean = value
    .normalize("NFKC")
    .replace(new RegExp(unitPattern.source, "gi"), "")
    .replace(/\s+/g, "")
    .trim();
  if (!clean) return { low: null, high: null, text: null };
  /* 分类参考（阴性/阳性等）和文本引用（见附页等）保留原文，不阻塞指标提取 */
  if (/^(?:阴性|阳性|弱阳性|正常|异常|未见(?:异常)?|可见)$/.test(clean)) {
    return { low: null, high: null, text: clean };
  }
  if (/^(?:见附页|见报告|详见|参考值|参考范围|正常范围)/.test(clean)) {
    return { low: null, high: null, text: clean };
  }
  const gendered = genderedReferenceSegment(clean, patientSex);
  if (gendered !== null) {
    if (!gendered) return { low: null, high: null, text: clean };
    return parseReferenceCell(gendered, unitPattern);
  }
  /* 多段组合（1.0-2.0 或 >3.0）取第一段数值范围。部分体检 PDF 用
     “0--40 / 25.8--103.2”表示正数区间；先识别双连字符，避免把上限
     错读为负数。两端均要求无负号，不改变真正负数范围的既有解析。 */
  const firstSegment = clean.split(/[或;；]/)[0].trim();
  const doubleHyphenRange = firstSegment.match(
    /^(\+?\d+(?:\.\d+)?)--+(\+?\d+(?:\.\d+)?)/,
  );
  if (doubleHyphenRange) {
    return {
      low: Number(doubleHyphenRange[1]),
      high: Number(doubleHyphenRange[2]),
      text: clean,
    };
  }
  const range = firstSegment.match(
    /^([-+]?\d+(?:\.\d+)?)\s*(?:-|~|～|—|至)\s*([-+]?\d+(?:\.\d+)?)/,
  );
  if (range) {
    return { low: Number(range[1]), high: Number(range[2]), text: clean };
  }
  const upper = firstSegment.match(/^(?:<|≤|小于|不高于)([-+]?\d+(?:\.\d+)?)/);
  if (upper) return { low: null, high: Number(upper[1]), text: clean };
  const lower = firstSegment.match(/^(?:>|≥|大于|不低于)([-+]?\d+(?:\.\d+)?)/);
  if (lower) return { low: Number(lower[1]), high: null, text: clean };
  return { low: null, high: null, text: clean };
}

function localAbnormalFlag(
  value: string,
  markerText?: string | null,
): LocalObservationFact["abnormalFlag"] {
  return inferObservationAbnormalFlag({ resultText: value, markerText });
}

function sectionHintMatches(section: string, hint: string) {
  if (section.includes(hint) || hint.includes(section)) return true;
  /* “血液常规/血常规”“心电图室/心电图”这类写法差异，去掉通用品类字后再比一次。 */
  const simplify = (value: string) => value.replace(/[液检查科部室\s]/g, "");
  const sectionSimple = simplify(section);
  const hintSimple = simplify(hint);
  return (
    sectionSimple.length > 1 &&
    hintSimple.length > 1 &&
    (sectionSimple.includes(hintSimple) || hintSimple.includes(sectionSimple))
  );
}

/* 同名多义别名（如“心率”=脉搏/心电图心率、“白细胞”=血常规/便常规）按当前章节提示消歧；
   无法唯一确定时保持保守返回 null，交给 AI 结合上下文处理。 */
function preferSectionDictionaryFact(
  facts: DictionaryCandidateFact[],
  section: string | null,
) {
  if (!section) return null;
  const matched = facts.filter((fact) =>
    fact.sectionHints.some((hint) => sectionHintMatches(section, hint)),
  );
  return matched.length === 1 ? matched[0] : null;
}

const institutionContextPattern =
  /(?:健康体检|健康管理|体检|中心|医院|卫生院|诊所|检验所|实验室|有限公司|股份有限公司|集团)/g;

/* 表格化的患者信息行（姓名脱敏后形如“男 | 36 岁”）：
   性别单元格 + 年龄单元格同时出现才算，叙述文本里的“男，36岁”不匹配。 */
function isPatientInfoRow(text: string) {
  return (
    /(?:^|[|｜\s])(?:男|女|男性|女性)(?=[|｜\s]|$)/.test(text) &&
    /\d{1,3}\s*岁/.test(text)
  );
}

/*
 * 消歧上下文只用科室小节标题；没有小节时退回报告标题，但先剥掉机构名
 * （“XX健康体检中心肺功能报告单”里的“体检”是机构名而非科室，直接参与匹配会误消歧）。
 */
function disambiguationSectionFor(
  section: string | null,
  reportSection: string | null,
) {
  if (section) return section;
  if (!reportSection) return null;
  return reportSection.replace(institutionContextPattern, "").trim() || null;
}

/*
 * 字典外单位只在强表格结构中兜底保留。要求片段具有明确“单位形态”（拉丁/希腊字母、
 * 斜杠、百分号或温度符号），并排除高低/正常等结果解释，避免把备注误当单位。
 */
function conservativeUnknownUnit(value: string) {
  const inferred = inferUnknownUnit(value);
  if (!inferred) return null;
  if (!/[A-Za-zμµΩ°℃%‰/·²³]/u.test(inferred)) return null;
  if (
    /(?:参考|范围|正常|异常|偏高|偏低|增高|降低|阴性|阳性|未见|可见|建议)/.test(
      inferred,
    )
  )
    return null;
  if (/^[（(].*[）)]$/.test(inferred)) return null;
  return inferred;
}

function knownUnitFromResult(value: string, unitPattern: RegExp) {
  const matched = value.match(unitPattern)?.[0];
  return matched ? matched.replace(/\s+/g, "") : null;
}

function sourceRefForCells(
  line: PlannedOcrLine,
  cellIndices: number[],
  text: string,
  options: {
    inherited?: boolean;
    headerCells?: PlannedOcrCell[] | null;
    headerIndices?: number[];
  } = {},
): LocalObservationSourceRef {
  const cells = cellIndices.flatMap((index) =>
    line.sourceCells[index] ? [line.sourceCells[index]] : [],
  );
  const sourceLineIds = [
    ...new Set(cells.flatMap((cell) => cell.sourceLineIds)),
  ];
  const headerCells = (options.headerIndices || []).flatMap((index) =>
    options.headerCells?.[index] ? [options.headerCells[index]] : [],
  );
  const headerSourceLineIds = [
    ...new Set(headerCells.flatMap((cell) => cell.sourceLineIds)),
  ];
  const headerText = headerCells
    .map((cell) => cell.text.trim())
    .filter(Boolean)
    .join(" | ");
  return {
    text,
    sourceLineIds: sourceLineIds.length
      ? sourceLineIds
      : [...line.sourceLineIds],
    cellIndices,
    inherited: Boolean(options.inherited),
    ...(headerSourceLineIds.length ? { headerSourceLineIds } : {}),
    ...(headerText ? { headerText } : {}),
  };
}

function inheritedHeaderSourceRef(
  headerCells: PlannedOcrCell[],
  headerIndex: number,
  text: string,
): LocalObservationSourceRef {
  const sourceLineIds = headerCells[headerIndex]?.sourceLineIds || [];
  return {
    text,
    sourceLineIds: [...sourceLineIds],
    cellIndices: [headerIndex],
    inherited: true,
    headerSourceLineIds: [...sourceLineIds],
    headerText: headerCells[headerIndex]?.text.trim() || undefined,
  };
}

function embeddedHeaderUnit(value: string, unitPattern: RegExp) {
  const withoutLabel = value.replace(/^(?:结果)?单位\s*[:：]?/i, "").trim();
  const matched =
    withoutLabel.match(new RegExp(`(?:${unitPattern.source})`, "iu"))?.[0] ||
    null;
  if (!matched || /^(?:结果)?单位$/i.test(withoutLabel)) return null;
  return matched.replace(/\s+/g, "");
}

function embeddedHeaderReference(
  value: string,
  unitPattern: RegExp,
  patientSex?: PatientSex | null,
) {
  const withoutLabel = value
    .replace(/^(?:参考值|参考范围|正常范围|区间)\s*[:：]?/i, "")
    .trim();
  if (!withoutLabel || withoutLabel === value.trim())
    return { low: null, high: null, text: null };
  const parsed = parseReferenceCell(withoutLabel, unitPattern, patientSex);
  return parsed.low !== null || parsed.high !== null
    ? parsed
    : { low: null, high: null, text: null };
}

function parseLocalObservation(
  line: PlannedOcrLine,
  pageNumber: number,
  section: string | null,
  tableHeader: string[] | null,
  tableHeaderCells: PlannedOcrCell[] | null,
  disambiguationSection: string | null,
  aliases: PreparedDictionaryAliases,
  unitPattern: RegExp,
  patientSex?: PatientSex | null,
): LocalObservationFact | null {
  if (
    line.candidateKind !== "scalar" ||
    (line.confidence !== null && line.confidence < 0.65)
  )
    return null;
  let dictionary =
    line.dictionaryFacts.length > 1
      ? preferSectionDictionaryFact(line.dictionaryFacts, disambiguationSection)
      : line.dictionaryFacts[0] || null;
  if (line.dictionaryFacts.length > 1 && !dictionary) return null;
  const inlineResult = line.text.match(
    /^(.{2,60}?)(?:检验|检查)?结果\s*[:：]\s*(阴性|阳性|弱阳性|正常|异常|未见异常|未见|可见)\s*[。.]?$/i,
  );
  if (inlineResult && !/[|｜]/.test(line.text) && (section || dictionary)) {
    const itemText = inlineResult[1].trim();
    const resultText = inlineResult[2];
    const sourceRef = sourceRefForCells(line, [0], line.text);
    return {
      pageNumber,
      sourceLineId: line.id,
      sectionName: section,
      itemName: itemText,
      normalizedName: dictionary?.displayName || itemText,
      resultText,
      numericValue: null,
      unit: null,
      referenceLow: null,
      referenceHigh: null,
      referenceText: null,
      abnormalFlag: localAbnormalFlag(resultText),
      sourceText: line.text,
      observationKey: `${line.id}:0`,
      sourceMap: { item: sourceRef, result: sourceRef },
    };
  }
  const cells = splitTableCells(line.text);
  const singleCell = cells.length < 2;
  /* 名称列兼容“测定项目/检测项目/项目名称”等写法；含结果/单位/参考语义的列不算名称列。 */
  const headerNameIndex = singleCell
    ? -1
    : (tableHeader?.findIndex(
        (cell) =>
          /(?:项目|名称|参数)/.test(cell) &&
          !/(?:结果|单位|参考|预测|预计|实测|测量)/.test(cell),
      ) ?? -1);
  const nameIndex = singleCell ? 0 : headerNameIndex >= 0 ? headerNameIndex : 0;
  const headerResultIndex = singleCell
    ? -1
    : (tableHeader?.findIndex(
        (cell) =>
          /(?:本次结果|检查结果|检验结果|测定值|实测值?|测量值|结果)/.test(
            cell,
          ) && !/(?:历史|既往|上次|前次|往年|预测|预计|%\s*预测)/.test(cell),
      ) ?? -1);
  const onlyHistoricalResultColumns =
    !singleCell &&
    headerResultIndex < 0 &&
    Boolean(
      tableHeader?.some((cell) =>
        /(?:历史|既往|上次|前次|往年).{0,8}(?:结果|数值)|(?:结果|数值).{0,8}(?:历史|既往|上次|前次|往年)/.test(
          cell,
        ),
      ),
    );
  if (nameIndex < 0 || onlyHistoricalResultColumns) return null;
  /*
   * 裸 T/Z 值只在定量超声骨（QUS）报告上下文可信；DXA 等其它骨密度场景的
   * T/Z 值临床口径不同、不可合并。与归一化服务的 QUS 上下文扣分门保持一致：
   * 本地解析不猜，交 AI 结合全文上下文处理。
   */
  const qusContext = quantitativeUltrasoundBoneContextPattern.test(
    [section, disambiguationSection].filter(Boolean).join(" "),
  );
  const unlabeledValueCells = cells.flatMap((cell, index) => {
    if (index === nameIndex) return [];
    const value = localValueParts(cell, unitPattern);
    return value
      ? [value.resultText.replace(/\s+/g, "").toLocaleLowerCase("zh-CN")]
      : [];
  });
  /* 没有明确“本次结果”列时，不同的多个独立值可能是左右侧、不同时间点或矩阵数据。
     明确标签/严格成对/左右表头已由多值解析器提前处理；其余一律不猜。
     完全相同的重复分类词（如“正常 | 正常”）不影响结果语义，可继续按单值处理。 */
  if (headerResultIndex < 0 && new Set(unlabeledValueCells).size > 1)
    return null;
  let resultIndex = headerResultIndex >= 0 ? headerResultIndex : nameIndex + 1;
  const nameCell = (cells[nameIndex] || "").trim();
  if (!dictionary && nameCell) {
    const exactFacts = exactDictionaryFactsForName(nameCell, aliases);
    dictionary =
      exactFacts.length > 1
        ? preferSectionDictionaryFact(exactFacts, disambiguationSection)
        : exactFacts[0] || null;
    if (exactFacts.length > 1 && !dictionary) return null;
  }
  /*
   * “名称: 值”内联格式（心电图“PR间期: 154 ms”、人体成分“肌肉量：55.5kg”）：
   * 名称与结果粘在同一格。整行可能是单格，后续格也可能是结论词（“心率: 87 bpm | 正常心电图”）
   * 或参考范围（“PR间期: 154 ms | 120-200”）——名称格里的值才是结果，优先按内联拆分，
   * 否则后续格会被误当结果值。值必须是完整测量值（数值+可选已知单位，或纯分类词），
   * 双值（120/80mmHg）或值后粘连叙述的不匹配，保持交 AI。
   * 拆分后按名称等值重查字典——整行子串事实对这类行不可靠（“QRS电轴”会误中别名“QRS”）。
   */
  const inlineMatch = nameCell.match(/^(.{1,40}?)\s*[:：]\s*(.+)$/);
  const inlineValue = inlineMatch?.[2]?.trim() || "";
  const inlineApplies =
    Boolean(inlineMatch) &&
    (inlineNumericValuePattern(unitPattern).test(inlineValue) ||
      inlineCategoricalValuePattern.test(inlineValue));
  const compactMatch = singleCell
    ? nameCell.match(
        /^(.{1,40}?)\s+((?:<|<=|≤|>|>=|≥)?\s*[-+]?\d+(?:\.\d+)?(?:\s*[^\d\s]{0,20})?\s*[↑↓▲▼⬆⬇]?)$/,
      )
    : null;
  const compactValue = compactMatch?.[2]?.trim() || "";
  const compactFacts =
    compactMatch && inlineNumericValuePattern(unitPattern).test(compactValue)
      ? exactDictionaryFactsForName(compactMatch[1].trim(), aliases)
      : [];
  const compactDictionary =
    compactFacts.length > 1
      ? preferSectionDictionaryFact(compactFacts, disambiguationSection)
      : compactFacts[0] || null;
  const compactApplies = Boolean(compactMatch && compactDictionary);
  let itemName = nameCell;
  let resultText = singleCell ? "" : (cells[resultIndex] || "").trim();
  if (inlineApplies) {
    itemName = inlineMatch![1].trim();
    resultText = inlineValue;
    resultIndex = nameIndex;
    const inlineFacts = exactDictionaryFactsForName(itemName, aliases);
    dictionary =
      inlineFacts.length > 1
        ? preferSectionDictionaryFact(inlineFacts, disambiguationSection)
        : inlineFacts[0] || null;
    if (inlineFacts.length > 1 && !dictionary) return null;
  } else if (compactApplies) {
    itemName = compactMatch![1].trim();
    resultText = compactValue;
    resultIndex = nameIndex;
    dictionary = compactDictionary;
  } else {
    if (singleCell || resultIndex < 0 || !nameCell || !resultText) return null;
    if (
      !resultCellPattern.test(resultText) ||
      /^\d{4}[-/.年]\d{1,2}/.test(resultText)
    )
      return null;
  }
  const unitIndex = tableHeader?.findIndex((cell) => /单位/.test(cell)) ?? -1;
  const referenceIndex =
    tableHeader?.findIndex(
      (cell) => referenceColumnRole(cell) === "explicit",
    ) ?? -1;
  const abnormalIndex =
    tableHeader?.findIndex((cell) =>
      /(?:异常|标志|标记|提示|状态)/.test(cell),
    ) ?? -1;
  const abnormalMarker =
    abnormalIndex >= 0 ? cells[abnormalIndex]?.trim() || null : null;
  const adjacentReferenceIndex = resultIndex + 1;
  const adjacentReferenceValue = cells[adjacentReferenceIndex] || null;
  const adjacentReferenceHeader = tableHeader?.[adjacentReferenceIndex] || null;
  const inferredReference =
    referenceIndex < 0 &&
    adjacentReferenceValue &&
    canUseAdjacentReferenceCell({
      header: adjacentReferenceHeader,
      value: adjacentReferenceValue,
    })
      ? parseReferenceCell(
          referenceCellText(cells, adjacentReferenceIndex),
          unitPattern,
          patientSex,
        )
      : { low: null, high: null, text: null };
  const inheritedReference =
    referenceIndex >= 0 && tableHeader?.[referenceIndex]
      ? embeddedHeaderReference(
          tableHeader[referenceIndex],
          unitPattern,
          patientSex,
        )
      : { low: null, high: null, text: null };
  const parsedReference =
    referenceIndex >= 0 && cells[referenceIndex]
      ? parseReferenceCell(
          referenceCellText(cells, referenceIndex),
          unitPattern,
          patientSex,
        )
      : inferredReference.low !== null || inferredReference.high !== null
        ? inferredReference
        : inheritedReference.low !== null || inheritedReference.high !== null
          ? inheritedReference
          : { low: null, high: null, text: null };
  const reference = assessObservationReference(parsedReference);
  const inheritedUnit =
    unitIndex >= 0 && tableHeader?.[unitIndex]
      ? embeddedHeaderUnit(tableHeader[unitIndex], unitPattern)
      : null;
  const unit =
    unitIndex >= 0 && cells[unitIndex]
      ? cells[unitIndex].trim() || null
      : knownUnitFromResult(resultText, unitPattern) ||
        conservativeUnknownUnit(resultText) ||
        inheritedUnit;
  const numericMatch = resultText.match(
    /^(?:<|<=|≤|>|>=|≥)?\s*([-+]?\d+(?:\.\d+)?)/,
  );
  const numericValue = numericMatch ? Number(numericMatch[1]) : null;
  if (!dictionary) {
    const categorical =
      /^(?:[-+±]+|阴性|阳性|弱阳性|正常|异常|未见(?:异常)?|可见)$/.test(
        resultText,
      );
    const safeBodyCompositionTotal = Boolean(
      inlineApplies &&
      section &&
      /人体成(?:分|份)/.test(section) &&
      /^(?:肌肉量|除脂肪量|去脂体重|体水分量|身体总水分)$/.test(itemName) &&
      /^kg$/i.test((unit || "").replace(/\s+/g, "")) &&
      numericValue !== null,
    );
    /*
     * 字典未覆盖的项目（血粘度、眼压等），科室上下文 + 数值 + 单位 + 数值参考范围
     * 已是足够强的指标行信号，可按原文项目名本地解析；
     * 归一化阶段会走未匹配指标流程，行为与 AI 提取一致。缺任何一项仍交给 AI。
     */
    const structural =
      numericValue !== null &&
      Boolean(unit) &&
      (reference.low !== null || reference.high !== null);
    if (!section || (!categorical && !structural && !safeBodyCompositionTotal))
      return null;
  }
  if (dictionary && dictionary.canonicalKey.startsWith("qus_bone_") && !qusContext)
    return null;
  const headerOptions = (index: number) => ({
    headerCells: tableHeaderCells,
    headerIndices: index >= 0 ? [index] : [],
  });
  const itemSource = sourceRefForCells(
    line,
    [nameIndex],
    itemName,
    headerOptions(nameIndex),
  );
  const resultSource = sourceRefForCells(
    line,
    [resultIndex],
    resultText,
    headerOptions(resultIndex),
  );
  const explicitUnit = unitIndex >= 0 && Boolean(cells[unitIndex]);
  const resultCarriesUnit = Boolean(
    knownUnitFromResult(resultText, unitPattern) ||
    conservativeUnknownUnit(resultText),
  );
  const unitSource = unit
    ? explicitUnit
      ? sourceRefForCells(line, [unitIndex], unit, headerOptions(unitIndex))
      : resultCarriesUnit
        ? sourceRefForCells(
            line,
            [resultIndex],
            unit,
            headerOptions(resultIndex),
          )
        : tableHeaderCells && unitIndex >= 0
          ? inheritedHeaderSourceRef(tableHeaderCells, unitIndex, unit)
          : undefined
    : undefined;
  const explicitReference =
    referenceIndex >= 0 && Boolean(cells[referenceIndex]);
  const inferredReferenceIndex =
    referenceIndex < 0 &&
    cells[resultIndex + 1] &&
    (inferredReference.low !== null || inferredReference.high !== null)
      ? resultIndex + 1
      : -1;
  const referenceSource = reference.text
    ? explicitReference
      ? sourceRefForCells(
          line,
          [referenceIndex],
          reference.text,
          headerOptions(referenceIndex),
        )
      : inferredReferenceIndex >= 0
        ? sourceRefForCells(line, [inferredReferenceIndex], reference.text)
        : tableHeaderCells && referenceIndex >= 0
          ? inheritedHeaderSourceRef(
              tableHeaderCells,
              referenceIndex,
              reference.text,
            )
          : undefined
    : undefined;
  return {
    pageNumber,
    sourceLineId: line.id,
    sectionName: section,
    itemName,
    normalizedName: dictionary?.displayName || itemName,
    resultText,
    numericValue:
      numericValue !== null && Number.isFinite(numericValue)
        ? numericValue
        : null,
    unit,
    referenceLow: reference.low,
    referenceHigh: reference.high,
    referenceText: reference.text,
    abnormalFlag: localAbnormalFlag(resultText, abnormalMarker),
    sourceText: line.text,
    observationKey: `${line.id}:${resultIndex}`,
    sourceMap: {
      item: itemSource,
      result: resultSource,
      ...(unitSource ? { unit: unitSource } : {}),
      ...(referenceSource ? { reference: referenceSource } : {}),
    },
  };
}

function exactLocalDictionary(
  name: string,
  aliases: PreparedDictionaryAliases,
  disambiguationSection: string | null,
) {
  const facts = exactDictionaryFactsForName(name, aliases);
  return facts.length > 1
    ? preferSectionDictionaryFact(facts, disambiguationSection)
    : facts[0] || null;
}

function localValueParts(value: string, unitPattern: RegExp) {
  const resultText = value.trim();
  if (
    !inlineNumericValuePattern(unitPattern).test(resultText) &&
    !inlineCategoricalValuePattern.test(resultText)
  ) {
    return null;
  }
  const numericMatch = resultText.match(
    /^(?:<|<=|≤|>|>=|≥)?\s*([-+]?\d+(?:\.\d+)?)/,
  );
  const numericValue = numericMatch ? Number(numericMatch[1]) : null;
  return {
    resultText,
    numericValue:
      numericValue !== null && Number.isFinite(numericValue)
        ? numericValue
        : null,
    unit:
      knownUnitFromResult(resultText, unitPattern) ||
      conservativeUnknownUnit(resultText),
    abnormalFlag: localAbnormalFlag(resultText),
  };
}

function explicitMultiValueObservation(input: {
  line: PlannedOcrLine;
  pageNumber: number;
  section: string | null;
  itemName: string;
  dictionary: DictionaryCandidateFact;
  resultText: string;
  itemIndex: number;
  itemHeaderIndex?: number;
  resultIndex: number;
  resultHeaderIndex?: number;
  unit: string | null;
  unitIndex?: number;
  unitHeaderIndex?: number;
  reference?: {
    low: number | null;
    high: number | null;
    text: string | null;
  };
  referenceIndex?: number;
  referenceHeaderIndex?: number;
  qualifier?: string;
  qualifierHeaderIndex?: number;
  tableHeaderCells?: PlannedOcrCell[] | null;
  unitPattern: RegExp;
}): LocalObservationFact | null {
  const value = localValueParts(input.resultText, input.unitPattern);
  if (!value) return null;
  const qualifierSuffix = input.qualifier ? `（${input.qualifier}）` : "";
  const itemName = `${input.itemName}${qualifierSuffix}`;
  const normalizedName = `${input.dictionary.displayName}${qualifierSuffix}`;
  const headerOptions = (index: number) => ({
    headerCells: input.tableHeaderCells,
    headerIndices: index >= 0 ? [index] : [],
  });
  const itemSource = sourceRefForCells(
    input.line,
    [input.itemIndex],
    input.itemName,
    headerOptions(input.itemHeaderIndex ?? input.itemIndex),
  );
  const resultSource = sourceRefForCells(
    input.line,
    [input.resultIndex],
    value.resultText,
    headerOptions(input.resultHeaderIndex ?? input.resultIndex),
  );
  const unit = input.unit || value.unit;
  const unitSource = unit
    ? input.unitIndex !== undefined
      ? sourceRefForCells(
          input.line,
          [input.unitIndex],
          unit,
          headerOptions(input.unitHeaderIndex ?? input.unitIndex),
        )
      : sourceRefForCells(
          input.line,
          [input.resultIndex],
          unit,
          headerOptions(input.resultHeaderIndex ?? input.resultIndex),
        )
    : undefined;
  const reference = input.reference || { low: null, high: null, text: null };
  const referenceSource =
    reference.text && input.referenceIndex !== undefined
      ? sourceRefForCells(
          input.line,
          [input.referenceIndex],
          reference.text,
          headerOptions(input.referenceHeaderIndex ?? input.referenceIndex),
        )
      : undefined;
  const qualifierSource =
    input.qualifier &&
    input.qualifierHeaderIndex !== undefined &&
    input.tableHeaderCells
      ? inheritedHeaderSourceRef(
          input.tableHeaderCells,
          input.qualifierHeaderIndex,
          input.qualifier,
        )
      : undefined;
  return {
    pageNumber: input.pageNumber,
    sourceLineId: input.line.id,
    sectionName: input.section,
    itemName,
    normalizedName,
    resultText: value.resultText,
    numericValue: value.numericValue,
    unit,
    referenceLow: reference.low,
    referenceHigh: reference.high,
    referenceText: reference.text,
    abnormalFlag: value.abnormalFlag,
    sourceText: input.line.text,
    observationKey: `${input.line.id}:${input.resultIndex}:${input.qualifier || input.itemName}`,
    sourceMap: {
      item: itemSource,
      result: resultSource,
      ...(unitSource ? { unit: unitSource } : {}),
      ...(referenceSource ? { reference: referenceSource } : {}),
      ...(qualifierSource ? { qualifier: qualifierSource } : {}),
    },
  };
}

const bodyCompositionCoreCanonicalKeys = new Set([
  "body_height",
  "body_weight",
  "body_bmi",
  "body_fat_mass",
  "body_fat_percentage",
  "body_muscle_mass",
  "body_fat_free_mass",
  "body_total_water",
  "body_basal_metabolic_rate",
]);

function isCompatibleBodyCompositionUnit(
  canonicalKey: string,
  unit: string | null,
) {
  const normalized = (unit || "")
    .normalize("NFKC")
    .replace(/\s+/g, "")
    .toLocaleLowerCase("zh-CN");
  if (canonicalKey === "body_bmi") {
    return !normalized || /^(?:kg\/m(?:2|²)|kg\/㎡)$/.test(normalized);
  }
  if (!normalized) return false;
  if (canonicalKey === "body_height")
    return /^(?:cm|厘米|m|米|mm|毫米)$/.test(normalized);
  if (canonicalKey === "body_fat_percentage")
    return /^(?:%|％)$/.test(normalized);
  if (canonicalKey === "body_basal_metabolic_rate")
    return /^(?:kcal|千卡|kcal\/(?:d|day)|千卡\/日)$/.test(normalized);
  return /^(?:kg|千克|公斤|g|克)$/.test(normalized);
}

/*
 * 人体成分核心行已经由坐标层裁成“项目 | 测定值 | 可选参考范围”。通用解析器
 * 为避免多列表误读，不接受“数值紧贴单位”的分栏结果；这里在明确报告标题、核心
 * canonical 指标和合法单位三重约束下本地闭环。单个普通数字不当作参考范围，避免
 * 把右侧图表刻度（如 708090）或设备目标值写进趋势。
 */
function parseBodyCompositionCoreObservation(
  line: PlannedOcrLine,
  pageNumber: number,
  section: string | null,
  disambiguationSection: string | null,
  aliases: PreparedDictionaryAliases,
  unitPattern: RegExp,
  patientSex?: PatientSex | null,
): LocalObservationFact | null {
  if (
    line.candidateKind !== "scalar" ||
    !section ||
    !bodyCompositionReportContextPattern.test(section) ||
    (line.confidence !== null && line.confidence < 0.65)
  )
    return null;
  const cells = splitTableCells(line.text).map((cell) => cell.trim());
  if (cells.length < 2 || cells.length > 3) return null;
  const dictionary = exactLocalDictionary(
    cells[0],
    aliases,
    disambiguationSection,
  );
  if (
    !dictionary ||
    !bodyCompositionCoreCanonicalKeys.has(dictionary.canonicalKey)
  )
    return null;
  const value = localValueParts(cells[1], unitPattern);
  if (
    !value ||
    value.numericValue === null ||
    !isCompatibleBodyCompositionUnit(dictionary.canonicalKey, value.unit)
  )
    return null;
  const hasReference =
    cells.length === 3 && hasExplicitReferenceValueShape(cells[2]);
  const reference = hasReference
    ? assessObservationReference(
        parseReferenceCell(cells[2], unitPattern, patientSex),
      )
    : undefined;
  return explicitMultiValueObservation({
    line,
    pageNumber,
    section,
    itemName: cells[0],
    dictionary,
    resultText: value.resultText,
    itemIndex: 0,
    resultIndex: 1,
    unit: value.unit,
    ...(reference
      ? {
          reference,
          referenceIndex: 2,
        }
      : {}),
    unitPattern,
  });
}

const bodyCompositionCoreNormalizedNames = new Set([
  "身高",
  "体重",
  "体重指数",
  "体脂肪量",
  "体脂肪率",
  "肌肉量",
  "除脂肪量",
  "体水分量",
  "基础代谢",
]);

function bodyCompositionEvidenceScore(
  line: PlannedOcrLine,
  observation: LocalObservationFact,
) {
  let score = 0;
  if (observation.referenceLow !== null || observation.referenceHigh !== null)
    score += 20;
  if (observation.sourceMap.unit) score += 8;
  if (line.id.startsWith(bodyCompositionSyntheticLinePrefix)) score += 4;
  if (line.sourceCells.length === 2) score += 3;
  if (
    line.sourceCells.length === 3 &&
    (observation.referenceLow !== null || observation.referenceHigh !== null)
  )
    score += 4;
  if (line.candidateResolutionReason !== "ambiguous_layout") score += 1;
  score += line.confidence || 0;
  return score;
}

/* 同页相同核心指标和数值只保留最佳证据，避免首页摘要与主表重复制造趋势点。 */
function deduplicateBodyCompositionCoreEvidence(lines: PlannedOcrLine[]) {
  const entries = lines.flatMap((line, lineIndex) =>
    localObservationsForLine(line).flatMap((observation, observationIndex) => {
      if (
        observation.numericValue === null ||
        !bodyCompositionCoreNormalizedNames.has(observation.normalizedName) ||
        !bodyCompositionReportContextPattern.test(
          [line.reportSectionName, line.sectionName].filter(Boolean).join(" "),
        )
      )
        return [];
      return [
        {
          lineIndex,
          observationIndex,
          key: `${observation.normalizedName}\u0000${observation.numericValue}`,
          score: bodyCompositionEvidenceScore(line, observation),
        },
      ];
    }),
  );
  const grouped = new Map<string, typeof entries>();
  for (const entry of entries) {
    grouped.set(entry.key, [...(grouped.get(entry.key) || []), entry]);
  }
  const duplicateIndices = new Map<number, Set<number>>();
  for (const group of grouped.values()) {
    if (group.length < 2) continue;
    const [winner, ...duplicates] = [...group].sort(
      (left, right) =>
        right.score - left.score ||
        left.lineIndex - right.lineIndex ||
        left.observationIndex - right.observationIndex,
    );
    void winner;
    for (const duplicate of duplicates) {
      const indices = duplicateIndices.get(duplicate.lineIndex) || new Set();
      indices.add(duplicate.observationIndex);
      duplicateIndices.set(duplicate.lineIndex, indices);
    }
  }
  return lines.map((line, lineIndex) => {
    const removed = duplicateIndices.get(lineIndex);
    if (!removed?.size) return line;
    const localObservations = localObservationsForLine(line).filter(
      (_observation, observationIndex) => !removed.has(observationIndex),
    );
    if (localObservations.length) {
      return {
        ...line,
        localObservation: localObservations[0] || null,
        localObservations,
      };
    }
    return {
      ...line,
      candidate: false,
      candidateKind: null,
      dictionaryFacts: [],
      candidateResolutionReason: "duplicate_evidence" as const,
      localObservation: null,
      localObservations: [],
    };
  });
}

function compactTcdColumnName(value: string) {
  return value
    .normalize("NFKC")
    .toUpperCase()
    .replace(/\s+/g, "")
    .replace(/[（(].*?[）)]/g, "")
    .replace(/[^A-Z\u4e00-\u9fff/]/g, "");
}

function tcdHeaderIndexForCell(
  cell: PlannedOcrCell,
  tableHeaderCells: PlannedOcrCell[],
) {
  const cellRect = boxRect(cell.box);
  if (!cellRect) return null;
  const center = (cellRect.left + cellRect.right) / 2;
  const headers = tableHeaderCells.flatMap((header, index) => {
    const rect = boxRect(header.box);
    return rect ? [{ index, center: (rect.left + rect.right) / 2 }] : [];
  });
  if (!headers.length) return null;
  headers.sort((left, right) => left.center - right.center);
  const nearest = [...headers].sort(
    (left, right) =>
      Math.abs(left.center - center) - Math.abs(right.center - center),
  )[0];
  const position = headers.findIndex(
    (header) => header.index === nearest.index,
  );
  const leftBoundary =
    position > 0
      ? (headers[position - 1].center + nearest.center) / 2
      : Number.NEGATIVE_INFINITY;
  const rightBoundary =
    position < headers.length - 1
      ? (nearest.center + headers[position + 1].center) / 2
      : Number.POSITIVE_INFINITY;
  return center >= leftBoundary && center < rightBoundary
    ? nearest.index
    : null;
}

/*
 * TCD 明细表允许任意单元格缺失：不能要求数据格数量等于表头数量，也不能用数组
 * 下标解释列。这里只提取报告结论实际用于判断的两类核心趋势——平均血流速度 Vm
 * 与搏动指数 PI。深度属于采样位置；Vp/Vd、RI、S/D 是同次频谱的辅助/派生参数；
 * HR 是设备同步上下文。它们完整保留在 OCR 证据中，但不制造家庭趋势噪声。
 */
function parseTcdCoreTableObservations(
  line: PlannedOcrLine,
  pageNumber: number,
  section: string | null,
  tableHeader: string[] | null,
  tableHeaderCells: PlannedOcrCell[] | null,
  disambiguationSection: string | null,
  aliases: PreparedDictionaryAliases,
  unitPattern: RegExp,
) {
  if (
    line.candidateKind !== "scalar" ||
    (line.confidence !== null && line.confidence < 0.65) ||
    !tableHeader ||
    !tableHeaderCells ||
    !tcdReportContextPattern.test(
      [section, disambiguationSection].filter(Boolean).join(" "),
    ) ||
    !tcdTableHeaderPattern.test(tableHeader.join(" | "))
  )
    return [];

  const headerNames = tableHeader.map(compactTcdColumnName);
  const vesselHeaderIndex = headerNames.findIndex(
    (name) => name === "血管名称",
  );
  if (vesselHeaderIndex < 0) return [];
  const aligned = new Map<number, number>();
  for (
    let sourceIndex = 0;
    sourceIndex < line.sourceCells.length;
    sourceIndex += 1
  ) {
    const headerIndex = tcdHeaderIndexForCell(
      line.sourceCells[sourceIndex],
      tableHeaderCells,
    );
    if (headerIndex === null || aligned.has(headerIndex)) continue;
    aligned.set(headerIndex, sourceIndex);
  }
  const vesselSourceIndex = aligned.get(vesselHeaderIndex);
  if (vesselSourceIndex === undefined) return [];
  const vesselName = line.sourceCells[vesselSourceIndex]?.text.trim() || "";
  if (!/^(?:左侧|右侧)?(?:大脑中动脉|椎动脉)$|^基底动脉$/.test(vesselName))
    return [];

  const supportedColumns = [
    { header: "VM", alias: "Vm" },
    { header: "PI", alias: "PI" },
  ];
  return supportedColumns.flatMap(({ header, alias }) => {
    const resultHeaderIndex = headerNames.findIndex((name) => name === header);
    if (resultHeaderIndex < 0) return [];
    const resultSourceIndex = aligned.get(resultHeaderIndex);
    if (resultSourceIndex === undefined) return [];
    const resultText = line.sourceCells[resultSourceIndex]?.text.trim() || "";
    const value = localValueParts(resultText, unitPattern);
    const dictionary = exactLocalDictionary(
      `${vesselName}${alias}`,
      aliases,
      disambiguationSection,
    );
    if (!value || value.numericValue === null || !dictionary) return [];
    const observation = explicitMultiValueObservation({
      line,
      pageNumber,
      section,
      itemName: `${vesselName}${alias}`,
      dictionary,
      resultText: value.resultText,
      itemIndex: vesselSourceIndex,
      itemHeaderIndex: vesselHeaderIndex,
      resultIndex: resultSourceIndex,
      resultHeaderIndex,
      unit: null,
      tableHeaderCells,
      unitPattern,
    });
    return observation ? [observation] : [];
  });
}

/*
 * 结构化设备/检验报告常把一个事实拆成带标签的横向单元格：
 * “指标：X | 检测值：1.2 | 检验结果：阴性”。这不同于“项目: 值”多指标行，
 * 三个标签共同描述同一个定量指标。仅在项目名精确命中字典、检测值为单一数值时
 * 本地闭环；定性结论只用于异常标志和结果证据，不额外猜测第二个指标。
 */
function parseLabelledMeasurementTupleObservation(
  line: PlannedOcrLine,
  pageNumber: number,
  section: string | null,
  disambiguationSection: string | null,
  aliases: PreparedDictionaryAliases,
  unitPattern: RegExp,
): LocalObservationFact | null {
  if (
    line.candidateKind !== "scalar" ||
    (line.confidence !== null && line.confidence < 0.65)
  )
    return null;
  const cells = splitTableCells(line.text).map((cell) => cell.trim());
  if (cells.length < 2) return null;
  const labelled = cells.map((cell, index) => {
    const match = cell.match(/^([^:：]{1,20})\s*[:：]\s*(.+)$/);
    return match
      ? { index, label: match[1].trim(), value: match[2].trim() }
      : null;
  });
  if (labelled.some((cell) => !cell)) return null;
  const values = labelled as Array<{
    index: number;
    label: string;
    value: string;
  }>;
  const item = values.find((cell) =>
    /^(?:指标|项目|检测项目|检验项目|检查项目|测定项目|项目名称)$/.test(
      cell.label,
    ),
  );
  const measurement = values.find((cell) =>
    /^(?:检测值|检验值|检查值|测定值|测量值|实测值|结果值|数值)$/.test(
      cell.label,
    ),
  );
  if (!item || !measurement || item.index === measurement.index) return null;
  const dictionary = exactLocalDictionary(
    item.value,
    aliases,
    disambiguationSection,
  );
  if (!dictionary || dictionary.kind !== "quantitative") return null;
  const parsedValue = localValueParts(measurement.value, unitPattern);
  if (!parsedValue || parsedValue.numericValue === null) return null;
  const outcome = values.find((cell) =>
    /^(?:检验结果|检查结果|检测结果|测定结果|结果|结论)$/.test(cell.label),
  );
  const outcomeValue = outcome?.value || null;
  if (outcomeValue && !inlineCategoricalValuePattern.test(outcomeValue))
    return null;
  const explicitUnit = values.find((cell) =>
    /^(?:单位|计量单位)$/.test(cell.label),
  );
  const explicitUnitValue = explicitUnit?.value.trim() || null;
  const unit = explicitUnitValue || parsedValue.unit;
  const referenceCell = values.find((cell) =>
    /^(?:参考值|参考范围|正常范围|判断值|阳性判断值)$/.test(cell.label),
  );
  const reference = referenceCell
    ? parseReferenceCell(referenceCell.value, unitPattern)
    : { low: null, high: null, text: null };
  const itemSource = sourceRefForCells(line, [item.index], item.value);
  const resultIndices = [
    measurement.index,
    ...(outcome ? [outcome.index] : []),
  ];
  const resultSource = sourceRefForCells(
    line,
    resultIndices,
    resultIndices.map((index) => cells[index]).join(" | "),
  );
  const unitSource =
    explicitUnit && explicitUnitValue
      ? sourceRefForCells(line, [explicitUnit.index], explicitUnitValue)
      : parsedValue.unit
        ? sourceRefForCells(line, [measurement.index], parsedValue.unit)
        : undefined;
  const referenceSource =
    referenceCell && reference.text
      ? sourceRefForCells(line, [referenceCell.index], reference.text)
      : undefined;
  return {
    pageNumber,
    sourceLineId: line.id,
    sectionName: section,
    itemName: item.value,
    normalizedName: dictionary.displayName,
    resultText: parsedValue.resultText,
    numericValue: parsedValue.numericValue,
    unit,
    referenceLow: reference.low,
    referenceHigh: reference.high,
    referenceText: reference.text,
    abnormalFlag: outcomeValue
      ? localAbnormalFlag(outcomeValue)
      : parsedValue.abnormalFlag,
    sourceText: line.text,
    observationKey: `${line.id}:${measurement.index}:labelled-tuple`,
    sourceMap: {
      item: itemSource,
      result: resultSource,
      ...(unitSource ? { unit: unitSource } : {}),
      ...(referenceSource ? { reference: referenceSource } : {}),
    },
  };
}

function parseQuantitativeUltrasoundBoneCoreObservations(
  line: PlannedOcrLine,
  pageNumber: number,
  section: string | null,
  disambiguationSection: string | null,
  aliases: PreparedDictionaryAliases,
  unitPattern: RegExp,
): LocalObservationFact[] {
  if (
    line.candidateKind !== "scalar" ||
    !quantitativeUltrasoundBoneContextPattern.test(section || "") ||
    (line.confidence !== null && line.confidence < 0.65)
  )
    return [];
  const cells = splitTableCells(line.text).map((cell) => cell.trim());
  if (cells.length < 2 || cells.length % 2 !== 0) return [];
  const definitions = {
    T: {
      label: /^(?:T\s*值|T[-\s]?score)$/i,
      dictionaryName: "超声骨密度 T 值",
      key: "t-score",
    },
    Z: {
      label: /^(?:Z\s*值|Z[-\s]?score)$/i,
      dictionaryName: "超声骨密度 Z 值",
      key: "z-score",
    },
  } as const;
  const observations: LocalObservationFact[] = [];
  const seen = new Set<keyof typeof definitions>();
  for (let index = 0; index < cells.length; index += 2) {
    const definition = Object.entries(definitions).find(([, item]) =>
      item.label.test(cells[index]),
    ) as
      | [
          keyof typeof definitions,
          (typeof definitions)[keyof typeof definitions],
        ]
      | undefined;
    if (!definition || seen.has(definition[0])) return [];
    const score = quantitativeUltrasoundBoneScoreValue(cells[index + 1]);
    const dictionary = exactLocalDictionary(
      definition[1].dictionaryName,
      aliases,
      disambiguationSection,
    );
    if (!score || !dictionary) return [];
    const fact = explicitMultiValueObservation({
      line,
      pageNumber,
      section,
      itemName: cells[index],
      dictionary,
      resultText: score.text,
      itemIndex: index,
      resultIndex: index + 1,
      unit: null,
      unitPattern,
    });
    if (!fact) return [];
    observations.push({
      ...fact,
      abnormalFlag: null,
      observationKey: `${line.id}:${definition[1].key}`,
    });
    seen.add(definition[0]);
  }
  return observations;
}

type RepeatedMeasurementHeaderGroup = {
  nameHeaderIndex: number;
  resultHeaderIndex: number;
  unitHeaderIndex: number | null;
  referenceHeaderIndex: number | null;
};

function repeatedMeasurementHeaderGroups(tableHeader: string[] | null) {
  if (!tableHeader) return [];
  const nameIndexes = tableHeader.flatMap((cell, index) =>
    /(?:项目|名称|参数)/.test(cell) &&
    !/(?:结果|单位|参考|预测|预计|实测|测量)/.test(cell)
      ? [index]
      : [],
  );
  if (nameIndexes.length < 2) return [];
  return nameIndexes.flatMap((nameHeaderIndex, groupIndex) => {
    const end = nameIndexes[groupIndex + 1] ?? tableHeader.length;
    const indexes = Array.from(
      { length: end - nameHeaderIndex },
      (_, index) => nameHeaderIndex + index,
    );
    const resultHeaderIndex = indexes.find((index) =>
      /(?:本次结果|检查结果|检验结果|测定值|实测值?|测量值|结果)/.test(
        tableHeader[index],
      ),
    );
    if (resultHeaderIndex === undefined) return [];
    return [
      {
        nameHeaderIndex,
        resultHeaderIndex,
        unitHeaderIndex:
          indexes.find((index) => /单位/.test(tableHeader[index])) ?? null,
        referenceHeaderIndex:
          indexes.find(
            (index) => referenceColumnRole(tableHeader[index]) === "explicit",
          ) ?? null,
      } satisfies RepeatedMeasurementHeaderGroup,
    ];
  });
}

function alignedRowCellIndexes(
  line: PlannedOcrLine,
  tableHeader: string[],
  tableHeaderCells: PlannedOcrCell[],
) {
  const rowCells = splitTableCells(line.text);
  const headerCenters = tableHeaderCells.map((cell) => {
    const rect = boxRect(cell.box);
    return rect ? (rect.left + rect.right) / 2 : null;
  });
  const rowCenters = line.sourceCells.map((cell) => {
    const rect = boxRect(cell.box);
    return rect ? (rect.left + rect.right) / 2 : null;
  });
  if (
    headerCenters.length === tableHeader.length &&
    rowCenters.length === rowCells.length &&
    headerCenters.every((center) => center !== null) &&
    rowCenters.every((center) => center !== null)
  ) {
    const result = new Map<number, number>();
    for (let rowIndex = 0; rowIndex < rowCenters.length; rowIndex += 1) {
      const center = rowCenters[rowIndex] as number;
      let nearestHeaderIndex = 0;
      let nearestDistance = Number.POSITIVE_INFINITY;
      for (
        let headerIndex = 0;
        headerIndex < headerCenters.length;
        headerIndex += 1
      ) {
        const distance = Math.abs(
          center - (headerCenters[headerIndex] as number),
        );
        if (distance < nearestDistance) {
          nearestDistance = distance;
          nearestHeaderIndex = headerIndex;
        }
      }
      if (result.has(nearestHeaderIndex)) return null;
      result.set(nearestHeaderIndex, rowIndex);
    }
    return result;
  }
  if (rowCells.length !== tableHeader.length) return null;
  return new Map(tableHeader.map((_, index) => [index, index]));
}

function credibleRepeatedTableUnit(value: string, unitPattern: RegExp) {
  const normalized = value.normalize("NFKC").replace(/\s+/g, "").trim();
  /* g/L 的 g 被 OCR 成 9 后会形成 9/L；它不是可信单位，宁可留空也不能入库。 */
  if (/^9\/[lL]$/.test(normalized)) return null;
  return (
    knownUnitFromResult(normalized, unitPattern) ||
    conservativeUnknownUnit(normalized)
  );
}

function parseRepeatedMeasurementPanelObservations(
  line: PlannedOcrLine,
  pageNumber: number,
  section: string | null,
  tableHeader: string[] | null,
  tableHeaderCells: PlannedOcrCell[] | null,
  disambiguationSection: string | null,
  aliases: PreparedDictionaryAliases,
  unitPattern: RegExp,
  patientSex?: PatientSex | null,
) {
  const groups = repeatedMeasurementHeaderGroups(tableHeader);
  if (!tableHeader || !tableHeaderCells || groups.length < 2) return [];
  const rowIndexByHeader = alignedRowCellIndexes(
    line,
    tableHeader,
    tableHeaderCells,
  );
  if (!rowIndexByHeader) return [];
  const cells = splitTableCells(line.text);
  return groups.flatMap((group): LocalObservationFact[] => {
    const itemIndex = rowIndexByHeader.get(group.nameHeaderIndex);
    const resultIndex = rowIndexByHeader.get(group.resultHeaderIndex);
    if (itemIndex === undefined || resultIndex === undefined) return [];
    const itemName = cells[itemIndex]?.trim() || "";
    const resultText = cells[resultIndex]?.trim() || "";
    const dictionary = exactLocalDictionary(
      itemName,
      aliases,
      disambiguationSection,
    );
    if (!dictionary || !localValueParts(resultText, unitPattern)) return [];

    const unitIndex =
      group.unitHeaderIndex === null
        ? undefined
        : rowIndexByHeader.get(group.unitHeaderIndex);
    const unit =
      unitIndex === undefined
        ? null
        : credibleRepeatedTableUnit(cells[unitIndex] || "", unitPattern);
    const referenceIndex =
      group.referenceHeaderIndex === null
        ? undefined
        : rowIndexByHeader.get(group.referenceHeaderIndex);
    const reference =
      referenceIndex === undefined
        ? undefined
        : assessObservationReference(
            parseReferenceCell(
              cells[referenceIndex] || "",
              unitPattern,
              patientSex,
            ),
          );
    const fact = explicitMultiValueObservation({
      line,
      pageNumber,
      section,
      itemName,
      dictionary,
      resultText,
      itemIndex,
      itemHeaderIndex: group.nameHeaderIndex,
      resultIndex,
      resultHeaderIndex: group.resultHeaderIndex,
      unit,
      ...(unit
        ? {
            unitIndex,
            unitHeaderIndex: group.unitHeaderIndex ?? undefined,
          }
        : {}),
      reference,
      ...(reference?.text
        ? {
            referenceIndex,
            referenceHeaderIndex: group.referenceHeaderIndex ?? undefined,
          }
        : {}),
      tableHeaderCells,
      unitPattern,
    });
    return fact ? [fact] : [];
  });
}

function parseExplicitMultiValueObservations(
  line: PlannedOcrLine,
  pageNumber: number,
  section: string | null,
  tableHeader: string[] | null,
  tableHeaderCells: PlannedOcrCell[] | null,
  disambiguationSection: string | null,
  aliases: PreparedDictionaryAliases,
  unitPattern: RegExp,
  patientSex?: PatientSex | null,
): LocalObservationFact[] {
  if (
    line.candidateKind !== "scalar" ||
    (line.confidence !== null && line.confidence < 0.65)
  )
    return [];
  const cells = splitTableCells(line.text).map((cell) => cell.trim());

  const repeatedPanel = parseRepeatedMeasurementPanelObservations(
    line,
    pageNumber,
    section,
    tableHeader,
    tableHeaderCells,
    disambiguationSection,
    aliases,
    unitPattern,
    patientSex,
  );
  if (repeatedPanel.length) return repeatedPanel;

  /* 每格都是“明确项目名: 完整值”时可安全拆分；任何一格不完整即整体回退 AI。 */
  if (cells.length >= 2) {
    const labelled = cells.map((cell, index) => {
      const match = cell.match(/^(.{1,40}?)\s*[:：]\s*(.+)$/);
      if (!match) return null;
      const dictionary = exactLocalDictionary(
        match[1].trim(),
        aliases,
        disambiguationSection,
      );
      const value = localValueParts(match[2], unitPattern);
      if (!dictionary || !value) return null;
      return explicitMultiValueObservation({
        line,
        pageNumber,
        section,
        itemName: match[1].trim(),
        dictionary,
        resultText: value.resultText,
        itemIndex: index,
        resultIndex: index,
        unit: value.unit,
        unitPattern,
      });
    });
    if (labelled.every((fact) => fact !== null))
      return labelled as LocalObservationFact[];
  }

  /* 明确的“项目 | 值 | 项目 | 值”成对结构；不接受孤立数字或猜测第一/最后一列。 */
  if (cells.length >= 4 && cells.length % 2 === 0) {
    const paired: LocalObservationFact[] = [];
    for (let index = 0; index < cells.length; index += 2) {
      const dictionary = exactLocalDictionary(
        cells[index],
        aliases,
        disambiguationSection,
      );
      const value = localValueParts(cells[index + 1], unitPattern);
      if (!dictionary || !value) {
        paired.length = 0;
        break;
      }
      const fact = explicitMultiValueObservation({
        line,
        pageNumber,
        section,
        itemName: cells[index],
        dictionary,
        resultText: value.resultText,
        itemIndex: index,
        resultIndex: index + 1,
        unit: value.unit,
        unitPattern,
      });
      if (!fact) {
        paired.length = 0;
        break;
      }
      paired.push(fact);
    }
    if (paired.length >= 2) return paired;
  }

  /* 左/右两列只有在表头、行单元格数量和列位置全部一一对应时拆分。 */
  if (tableHeader && tableHeaderCells && tableHeader.length === cells.length) {
    const nameIndex = tableHeader.findIndex(
      (cell) => /(?:项目|名称)/.test(cell) && !/(?:结果|单位|参考)/.test(cell),
    );
    const sideColumns = tableHeader
      .map((cell, index) => ({
        index,
        qualifier: /^(?:左|左侧|左眼|左耳)$/.test(cell.trim())
          ? "左"
          : /^(?:右|右侧|右眼|右耳)$/.test(cell.trim())
            ? "右"
            : null,
      }))
      .filter((item): item is { index: number; qualifier: string } =>
        Boolean(item.qualifier),
      );
    if (
      nameIndex >= 0 &&
      sideColumns.length === 2 &&
      new Set(sideColumns.map((item) => item.qualifier)).size === 2
    ) {
      const itemName = cells[nameIndex];
      const dictionary = exactLocalDictionary(
        itemName,
        aliases,
        disambiguationSection,
      );
      const unitIndex = tableHeader.findIndex((cell) => /单位/.test(cell));
      const referenceIndex = tableHeader.findIndex((cell) =>
        /(?:参考|正常范围)/.test(cell),
      );
      const unit =
        unitIndex >= 0 && cells[unitIndex]
          ? cells[unitIndex].trim() || null
          : unitIndex >= 0
            ? embeddedHeaderUnit(tableHeader[unitIndex], unitPattern)
            : null;
      const reference =
        referenceIndex >= 0 && cells[referenceIndex]
          ? parseReferenceCell(
              referenceCellText(cells, referenceIndex),
              unitPattern,
              patientSex,
            )
          : referenceIndex >= 0
            ? embeddedHeaderReference(
                tableHeader[referenceIndex],
                unitPattern,
                patientSex,
              )
            : { low: null, high: null, text: null };
      if (
        dictionary &&
        sideColumns.every(({ index }) =>
          Boolean(localValueParts(cells[index], unitPattern)),
        )
      ) {
        return sideColumns.flatMap(({ index, qualifier }) => {
          const fact = explicitMultiValueObservation({
            line,
            pageNumber,
            section,
            itemName,
            dictionary,
            resultText: cells[index],
            itemIndex: nameIndex,
            resultIndex: index,
            unit,
            ...(unitIndex >= 0 && cells[unitIndex] ? { unitIndex } : {}),
            reference,
            ...(referenceIndex >= 0 && cells[referenceIndex]
              ? { referenceIndex }
              : {}),
            qualifier,
            qualifierHeaderIndex: index,
            tableHeaderCells,
            unitPattern,
          });
          return fact ? [fact] : [];
        });
      }
    }
  }
  return [];
}

function summaryAbnormalFlag(value: string) {
  if (/(?:偏高|增高)/.test(value)) return "high" as const;
  if (/(?:偏低|降低)/.test(value)) return "low" as const;
  if (/正常/.test(value)) return "normal" as const;
  return "abnormal" as const;
}

/*
 * 体检综述中的“项目值偏高(结果)(参考值…)”是明确的结构化事实，并非建议文本。
 * 只接受完整括号结构、精确字典名称和可解析测量值，借此稳定提取同一行的多个指标，
 * 同时让跨行恢复后的 LDL 等指标无需再以残片进入 AI 补提取。
 */
function parseExplicitSummaryObservations(
  line: PlannedOcrLine,
  pageNumber: number,
  section: string | null,
  disambiguationSection: string | null,
  aliases: PreparedDictionaryAliases,
  unitPattern: RegExp,
  patientSex?: PatientSex | null,
) {
  if (
    line.candidateKind !== "scalar" ||
    (line.confidence !== null && line.confidence < 0.65)
  ) {
    return [];
  }
  const normalized = line.text
    .normalize("NFKC")
    .replace(/^(?:体检|检查)?小结\s*[:：]\s*/, "")
    .replace(/^总结\s*[:：]\s*/, "");
  const pattern =
    /(?:^|[;；])\s*([^;；,，。()]{2,50}?)(?:测定)?值\s*(偏高|偏低|增高|降低|正常|异常)\s*\(\s*([^()]{1,40}?)\s*\)\s*\(\s*(?:参考值|参考范围|正常范围)\s*[:：]?\s*([^()]{1,120}?)\s*\)/g;
  const observations: LocalObservationFact[] = [];
  for (const match of normalized.matchAll(pattern)) {
    const itemName = match[1].trim();
    const dictionary = exactLocalDictionary(
      itemName,
      aliases,
      disambiguationSection,
    );
    const value = localValueParts(match[3], unitPattern);
    if (!dictionary || !value || value.numericValue === null) continue;
    const reference = parseReferenceCell(match[4], unitPattern, patientSex);
    const fact = explicitMultiValueObservation({
      line,
      pageNumber,
      section,
      itemName,
      dictionary,
      resultText: value.resultText,
      itemIndex: 0,
      resultIndex: 0,
      unit: value.unit,
      reference,
      referenceIndex: 0,
      unitPattern,
    });
    if (!fact) continue;
    observations.push({
      ...fact,
      abnormalFlag: summaryAbnormalFlag(match[2]),
      observationKey: `${line.id}:summary:${match.index ?? observations.length}:${dictionary.canonicalKey}`,
    });
  }
  return observations;
}

/*
 * 血压是唯一常见且语义固定的双值生命体征。只接受显式“血压/BP + 收缩压/舒张压
 * + mmHg”形态，并校验生理范围与高值大于低值；不根据“正常高值”等总结文字
 * 推断单项异常标记。这样可在 Planner 层直接闭环两个标准趋势指标。
 */
function parseExplicitBloodPressureObservations(
  line: PlannedOcrLine,
  pageNumber: number,
  section: string | null,
  aliases: PreparedDictionaryAliases,
  unitPattern: RegExp,
) {
  if (
    line.candidateKind !== "scalar" ||
    (line.confidence !== null && line.confidence < 0.65) ||
    /[|｜]/.test(line.text)
  ) {
    return [];
  }
  const match = line.text
    .normalize("NFKC")
    .trim()
    .match(
      /^(?:血压|BP)\s*[:：=]?\s*(\d{2,3})\s*[\/／]\s*(\d{2,3})\s*(mm\s*Hg|毫米汞柱)(?=$|[，,。；;\s])/i,
    );
  if (!match) return [];
  const systolic = Number(match[1]);
  const diastolic = Number(match[2]);
  if (
    !Number.isFinite(systolic) ||
    !Number.isFinite(diastolic) ||
    systolic < 50 ||
    systolic > 280 ||
    diastolic < 30 ||
    diastolic > 180 ||
    systolic <= diastolic
  ) {
    return [];
  }
  const definitions = [
    {
      canonicalName: "收缩压",
      value: systolic,
      key: "systolic",
    },
    {
      canonicalName: "舒张压",
      value: diastolic,
      key: "diastolic",
    },
  ] as const;
  const observations: LocalObservationFact[] = [];
  for (const definition of definitions) {
    const dictionary = exactLocalDictionary(
      definition.canonicalName,
      aliases,
      section,
    );
    if (!dictionary) return [];
    const fact = explicitMultiValueObservation({
      line,
      pageNumber,
      section,
      itemName: "血压",
      dictionary,
      resultText: String(definition.value),
      itemIndex: 0,
      resultIndex: 0,
      unit: "mmHg",
      unitPattern,
    });
    if (!fact) return [];
    observations.push({
      ...fact,
      itemName: dictionary.displayName,
      abnormalFlag: null,
      observationKey: `${line.id}:blood-pressure:${definition.key}`,
    });
  }
  return observations;
}

function parseLocalObservations(
  line: PlannedOcrLine,
  pageNumber: number,
  section: string | null,
  tableHeader: string[] | null,
  tableHeaderCells: PlannedOcrCell[] | null,
  disambiguationSection: string | null,
  aliases: PreparedDictionaryAliases,
  unitPattern: RegExp,
  patientSex?: PatientSex | null,
) {
  const bloodPressure = parseExplicitBloodPressureObservations(
    line,
    pageNumber,
    section,
    aliases,
    unitPattern,
  );
  if (bloodPressure.length) return bloodPressure;
  const summary = parseExplicitSummaryObservations(
    line,
    pageNumber,
    section,
    disambiguationSection,
    aliases,
    unitPattern,
    patientSex,
  );
  if (summary.length) return summary;
  const bodyCompositionCore = parseBodyCompositionCoreObservation(
    line,
    pageNumber,
    section,
    disambiguationSection,
    aliases,
    unitPattern,
    patientSex,
  );
  if (bodyCompositionCore) return [bodyCompositionCore];
  const labelledTuple = parseLabelledMeasurementTupleObservation(
    line,
    pageNumber,
    section,
    disambiguationSection,
    aliases,
    unitPattern,
  );
  if (labelledTuple) return [labelledTuple];
  const tcdCore = parseTcdCoreTableObservations(
    line,
    pageNumber,
    section,
    tableHeader,
    tableHeaderCells,
    disambiguationSection,
    aliases,
    unitPattern,
  );
  if (tcdCore.length) return tcdCore;
  const quantitativeUltrasoundBoneCore =
    parseQuantitativeUltrasoundBoneCoreObservations(
      line,
      pageNumber,
      section,
      disambiguationSection,
      aliases,
      unitPattern,
    );
  if (quantitativeUltrasoundBoneCore.length)
    return quantitativeUltrasoundBoneCore;
  const multiple = parseExplicitMultiValueObservations(
    line,
    pageNumber,
    section,
    tableHeader,
    tableHeaderCells,
    disambiguationSection,
    aliases,
    unitPattern,
    patientSex,
  );
  if (multiple.length) return multiple;
  const single = parseLocalObservation(
    line,
    pageNumber,
    section,
    tableHeader,
    tableHeaderCells,
    disambiguationSection,
    aliases,
    unitPattern,
    patientSex,
  );
  return single ? [single] : [];
}

type NamedReferenceThreshold = {
  itemKey: string;
  operator: "<" | "<=" | "≤" | ">" | ">=" | "≥";
  value: number;
  outcome: string;
  cellIndex: number;
};

function compactReferenceIndicatorName(value: string) {
  return compactDictionaryText(value)
    .replace(/^(?:指标|项目)/, "")
    .replace(/(?:测定|检测|检验|检查)?值$/, "");
}

function namedReferenceThresholds(line: PlannedOcrLine) {
  return splitTableCells(line.text).flatMap(
    (cell, cellIndex): NamedReferenceThreshold[] => {
      const match = cell
        .trim()
        .match(
          /^(.{1,40}?)(<=|≤|<|>=|≥|>)\s*([-+]?\d+(?:\.\d+)?)\s*为?\s*(阴性|阳性|弱阳性|正常|异常)$/i,
        );
      if (!match) return [];
      const value = Number(match[3]);
      const itemKey = compactReferenceIndicatorName(match[1]);
      if (!itemKey || !Number.isFinite(value)) return [];
      return [
        {
          itemKey,
          operator: match[2] as NamedReferenceThreshold["operator"],
          value,
          outcome: match[4],
          cellIndex,
        },
      ];
    },
  );
}

function referenceMatchesObservation(
  threshold: NamedReferenceThreshold,
  observation: LocalObservationFact,
) {
  const names = [observation.itemName, observation.normalizedName]
    .map(compactReferenceIndicatorName)
    .filter((value) => value.length >= 2);
  return names.some(
    (name) =>
      name === threshold.itemKey ||
      name.endsWith(threshold.itemKey) ||
      threshold.itemKey.endsWith(name),
  );
}

/*
 * 某些报告把数值行和判定阈值分成相邻区块。只在参考行显式重复指标名，且明确写出
 * “<阈值为阴性/正常”或“>阈值为阴性/正常”时回填数值边界；保留完整原文，
 * 不从只有“阳性/异常”的阈值反推正常范围。
 */
function enrichLocalObservationsWithNamedReferences(lines: PlannedOcrLine[]) {
  return lines.map((line, lineIndex): PlannedOcrLine => {
    const observations = localObservationsForLine(line);
    if (
      observations.every(
        (observation) =>
          observation.numericValue === null ||
          observation.referenceLow !== null ||
          observation.referenceHigh !== null,
      )
    )
      return line;
    let referenceLine: PlannedOcrLine | null = null;
    for (
      let lookahead = lineIndex + 1;
      lookahead < Math.min(lines.length, lineIndex + 4);
      lookahead += 1
    ) {
      const candidate = lines[lookahead];
      if (candidate.boundary || candidate.candidate) break;
      if (candidate.sectionName !== line.sectionName) break;
      if (candidate.contentRole === "reference") {
        referenceLine = candidate;
        break;
      }
    }
    if (!referenceLine) return line;
    const thresholds = namedReferenceThresholds(referenceLine);
    if (!thresholds.length) return line;
    const enriched = observations.map((observation) => {
      if (
        observation.numericValue === null ||
        observation.referenceLow !== null ||
        observation.referenceHigh !== null
      )
        return observation;
      const matching = thresholds.filter((threshold) =>
        referenceMatchesObservation(threshold, observation),
      );
      const normal = matching.filter((threshold) =>
        /^(?:阴性|正常)$/.test(threshold.outcome),
      );
      const upper = normal.find((threshold) =>
        ["<", "<=", "≤"].includes(threshold.operator),
      );
      const lower = normal.find((threshold) =>
        [">", ">=", "≥"].includes(threshold.operator),
      );
      if (!upper && !lower) return observation;
      const cellIndices = [...new Set(matching.map((item) => item.cellIndex))];
      const referenceText = cellIndices
        .map((index) => splitTableCells(referenceLine!.text)[index])
        .join(" | ");
      return {
        ...observation,
        referenceLow: lower?.value ?? null,
        referenceHigh: upper?.value ?? null,
        referenceText,
        sourceMap: {
          ...observation.sourceMap,
          reference: sourceRefForCells(
            referenceLine!,
            cellIndices,
            referenceText,
          ),
        },
      };
    });
    return {
      ...line,
      localObservation: enriched[0] || null,
      localObservations: enriched,
    };
  });
}

function annotatePageLines(
  lines: PlannedOcrLine[],
  pageNumber: number,
  previous: PageLineContext,
  aliases: PreparedDictionaryAliases,
  unitPattern: RegExp,
  patientSex?: PatientSex | null,
) {
  const firstContent = lines.find((line) => line.role !== "noise");
  const hasNewBoundary = lines
    .slice(0, 8)
    .some(
      (line) =>
        line.boundary === "section" ||
        line.boundary === "table_header" ||
        reportHeadingPattern.test(cleanContextLabel(line.text)),
    );
  const inheritContext =
    previous.pageNumber === pageNumber - 1 &&
    previous.endedWithCandidate &&
    Boolean(firstContent?.candidate) &&
    !hasNewBoundary;
  let section = inheritContext ? previous.section : null;
  let reportSection = inheritContext ? previous.reportSection : null;
  let narrativeActive = false;
  let tableHeader = inheritContext ? previous.tableHeader : null;
  let tableHeaderCells = inheritContext ? previous.tableHeaderCells : null;
  let contentRegion = inheritContext ? previous.contentRegion : null;
  const annotated = lines.map((line): PlannedOcrLine => {
    let role = line.role;
    if (line.boundary === "section") {
      const heading = cleanSectionHeading(line.text);
      if (heading && reportHeadingPattern.test(heading)) {
        reportSection = heading;
        section = null;
      } else {
        section = heading;
      }
      narrativeActive = narrativeSectionHeadingPattern.test(line.text);
      contentRegion = regionRoleForHeading(line.text);
      tableHeader = null;
      tableHeaderCells = null;
      role = "section_heading";
    } else if (line.boundary === "table_header") {
      tableHeader = splitTableCells(line.text);
      tableHeaderCells = line.sourceCells;
      narrativeActive = false;
      contentRegion = isReferenceGuidanceRow(line.text, unitPattern)
        ? "reference"
        : null;
      role = "table_header";
    } else if (
      reportHeadingPattern.test(
        cleanContextLabel(splitTableCells(line.text)[0] || ""),
      )
    ) {
      reportSection = cleanContextLabel(splitTableCells(line.text)[0] || "");
      section = null;
      tableHeader = null;
      tableHeaderCells = null;
      contentRegion = null;
    } else if (narrativeInlinePattern.test(line.text)) {
      narrativeActive = true;
      role = "narrative";
    } else if (
      /(?:建议|复查|随诊|定期观察|健康管理)/.test(line.text) &&
      /[。；;]/.test(line.text)
    ) {
      role = "narrative";
    } else if ((role === "uncertain" || role === "noise") && narrativeActive) {
      role = "narrative";
    }

    const sectionName =
      section && reportSection && !section.includes(reportSection)
        ? `${reportSection} / ${section}`
        : section || reportSection;
    const effectiveLine = stripTrailingAdministrativeLabelCells(
      stripTcdGraphicLabelCells(line, section, reportSection),
    );
    const filteredDeviceParameter =
      isPulmonaryDeviceDerivedParameter(
        effectiveLine.text,
        section,
        reportSection,
      ) ||
      isQuantitativeUltrasoundBoneDeviceParameterRow(
        effectiveLine.text,
        section,
        reportSection,
      ) ||
      isGenericNegativeExamEvidenceRow(
        effectiveLine.text,
        tableHeader,
        effectiveLine.dictionaryFacts,
      ) ||
      isTcdDevicePanelRow(effectiveLine.text, section, reportSection) ||
      isUltrasoundDeviceSafetyIndexRow(
        effectiveLine.text,
        section,
        reportSection,
      ) ||
      isBodyCompositionNonTrendRow(effectiveLine.text, section, reportSection);
    const filteredTcdGraphicLabel = isTcdGraphicLabelRow(
      effectiveLine,
      section,
      reportSection,
    );
    const preservedChartAxis =
      filteredTcdGraphicLabel ||
      (line.role === "noise" &&
        line.contentRole === "chart_axis" &&
        !line.candidate);
    const content = preservedChartAxis
      ? {
          contentRole: "chart_axis" as const,
          candidateResolutionReason: "filtered_noise" as const,
        }
      : classifyOcrContent({
          text: effectiveLine.text,
          boundary: line.boundary,
          metadata:
            role === "metadata" ||
            metadataCandidatePattern.test(effectiveLine.text) ||
            metadataRowPattern.test(effectiveLine.text),
          candidate: line.candidate,
          morphology:
            line.candidateKind === "morphology" ||
            isMorphologyCandidate(effectiveLine.text),
          dictionaryFacts: line.dictionaryFacts,
          narrative: role === "narrative" || narrativeActive,
          regionRole: contentRegion,
          tableHeader,
          unitPattern,
        });
    const candidate =
      !filteredDeviceParameter &&
      content.contentRole === "measurement" &&
      effectiveLine.candidate;
    const candidateKind = candidate ? effectiveLine.candidateKind : null;
    const dictionaryFacts = candidate ? effectiveLine.dictionaryFacts : [];
    if (filteredDeviceParameter) role = "noise";
    if (
      !candidate &&
      line.boundary !== "section" &&
      line.boundary !== "table_header"
    ) {
      if (content.contentRole === "metadata") role = "metadata";
      else if (content.contentRole === "recommendation") role = "narrative";
      else if (
        ["chart_axis", "environment", "reference"].includes(content.contentRole)
      )
        role = "noise";
      else if (
        role === "narrative" ||
        narrativeActive ||
        contentRegion === "narrative"
      )
        role = "narrative";
    }
    const withRole: PlannedOcrLine = {
      ...effectiveLine,
      role,
      contentRole: filteredDeviceParameter
        ? "environment"
        : content.contentRole,
      candidate,
      candidateKind,
      dictionaryFacts,
      candidateResolutionReason: filteredDeviceParameter
        ? "filtered_noise"
        : content.candidateResolutionReason,
      localObservation: null,
      localObservations: [],
    };
    const localObservations = parseLocalObservations(
      withRole,
      pageNumber,
      sectionName,
      tableHeader,
      tableHeaderCells,
      disambiguationSectionFor(section, reportSection),
      aliases,
      unitPattern,
      patientSex,
    );
    const expectedLocalObservationCount =
      candidateKind === "scalar"
        ? repeatedMeasurementHeaderGroups(tableHeader).length
        : 0;
    return {
      ...withRole,
      sectionName,
      reportSectionName: reportSection,
      tableHeaderText: tableHeader?.join(" | ") || null,
      tableHeaderSourceLineIds: tableHeaderCells
        ? [...new Set(tableHeaderCells.flatMap((cell) => cell.sourceLineIds))]
        : [],
      localObservation: localObservations[0] || null,
      localObservations,
      ...(expectedLocalObservationCount >= 2
        ? { expectedLocalObservationCount }
        : {}),
    };
  });
  const enriched = deduplicateBodyCompositionCoreEvidence(
    enrichLocalObservationsWithNamedReferences(annotated),
  );
  let lastCandidateIndex = -1;
  for (let index = enriched.length - 1; index >= 0; index -= 1) {
    if (!enriched[index].candidate) continue;
    lastCandidateIndex = index;
    break;
  }
  const hasLaterBoundary =
    lastCandidateIndex >= 0 &&
    enriched
      .slice(lastCandidateIndex + 1)
      .some(
        (line) =>
          line.boundary === "section" || line.boundary === "table_header",
      );
  return {
    lines: enriched,
    context: {
      section,
      reportSection,
      narrativeActive,
      tableHeader,
      tableHeaderCells,
      contentRegion,
      pageNumber,
      endedWithCandidate:
        lastCandidateIndex >= 0 &&
        !hasLaterBoundary &&
        enriched.length - lastCandidateIndex <= 24,
    } satisfies PageLineContext,
  };
}

export function estimateAiUnitOutputTokens(input: {
  pageCount: number;
  characterCount: number;
  candidateRowCount: number;
  morphologyCandidateCount: number;
  candidateCharacters?: number;
}) {
  const narrativeAllowance = Math.min(
    768,
    Math.ceil(Math.max(0, input.characterCount) / 8),
  );
  /*
   * 每条观察结果的 JSON 字段开销约 60 token，证据引用约等于原文长度。
   * 行偏长时按内容加权上调估算（只升不降），避免低估触发输出截断。
   */
  const candidateAllowance =
    input.candidateCharacters !== undefined
      ? Math.max(
          Math.max(0, input.candidateRowCount) * 100,
          Math.max(0, input.candidateRowCount) * 60 +
            Math.max(0, input.candidateCharacters),
        )
      : Math.max(0, input.candidateRowCount) * 100;
  return (
    768 +
    Math.max(1, input.pageCount) * 96 +
    candidateAllowance +
    Math.max(0, input.morphologyCandidateCount) * 180 +
    narrativeAllowance
  );
}

/*
 * 单元在严格证据契约下的请求侧输出量估算（不含安全余量）。
 * 与 ai-extraction.service 的请求预算计算共用同一内核：
 * 打包阶段据此把单元控制在当前模型的输出能力之内，
 * 让“截断→拆分”只作为意外兜底，而不是常态路径。
 */
export function estimateAiUnitRequestOutput(input: {
  pageCount: number;
  characterCount: number;
  candidateRowCount: number;
  morphologyCandidateCount?: number;
  supplement?: boolean;
}) {
  const supplement = input.supplement === true;
  return (
    (supplement ? 2_048 : 4_096) +
    Math.max(0, input.candidateRowCount) * (supplement ? 140 : 180) +
    Math.max(0, input.morphologyCandidateCount || 0) * (supplement ? 420 : 700) +
    Math.max(1, input.pageCount) * (supplement ? 128 : 384) +
    Math.min(
      supplement ? 2_048 : 6_144,
      Math.ceil(Math.max(0, input.characterCount) * (supplement ? 0.1 : 0.2)),
    )
  );
}

function unitRequestOutputEstimate(unit: AiExtractionUnit) {
  return estimateAiUnitRequestOutput({
    pageCount: unit.pageNumbers.length,
    characterCount: unit.characterCount,
    candidateRowCount: unit.candidateRowCount,
    morphologyCandidateCount: unit.morphologyCandidateCount,
  });
}

function unitFromRanges(
  unitType: AiExtractionUnit["unitType"],
  ranges: AiExtractionUnit["pageRanges"],
  pages: RebuiltOcrPage[],
  route: AiExtractionUnit["route"],
  allowDocumentFields = false,
  documentPrimaryType?: ReportContentType | null,
  /* 概览单请求模式：document 路由也按指标通道统计候选行，
     使合并单元保持候选覆盖追踪与证据校验能力 */
  documentScalarCandidates = false,
): AiExtractionUnit {
  const extractionMode: AiExtractionUnit["extractionMode"] =
    route === "morphology" ? "morphology" : "scalar";
  const rendered = ranges
    .map((range) => {
      const page = pages.find((item) => item.pageId === range.pageId);
      if (!page) return "";
      const rangeLines = page.lines.filter(
        (line) => line.index >= range.lineStart && line.index <= range.lineEnd,
      );
      const candidates = rangeLines.filter((line) =>
        route === "morphology"
          ? line.candidateKind === "morphology"
          : route === "scalar"
            ? lineNeedsAiScalarExtraction(line)
            : false,
      );
      // 整页叙事只适用于页面类型与文档主类型一致的病历类页面；
      // 体检报告里被误判为门诊/住院的检查表格页不再整页送入 narrative 单元。
      const narrativeWholePage =
        route === "narrative" &&
        page.classification.contentTypes.some(
          (type) =>
            [
              "outpatient",
              "inpatient",
              "pathology",
              "prescription",
              "billing",
              "vaccination",
            ].includes(type) &&
            (documentPrimaryType === undefined || type === documentPrimaryType),
        );
      const texts: string[] = [];
      if (route === "scalar" || route === "morphology") {
        /*
         * 指标通道不再携带“本页所有历史章节/表头”。每个待 AI 处理的候选只带其已经
         * 注释好的最近章节和表头；形态候选额外保留前后各一条非边界描述。这样既避免
         * 旧表头串扰，也让跨页继承上下文和分块上下文使用同一标准格式。
         */
        const emittedLineIndexes = new Set<number>();
        let renderedSection: string | null | undefined;
        let renderedHeader: string | null | undefined;
        for (const candidate of candidates) {
          if (candidate.sectionName !== renderedSection) {
            if (candidate.sectionName)
              texts.push(`[章节：${candidate.sectionName}]`);
            else if (renderedSection !== undefined)
              texts.push("[章节：未标注]");
            renderedSection = candidate.sectionName ?? null;
          }
          if (candidate.tableHeaderText !== renderedHeader) {
            if (candidate.tableHeaderText)
              texts.push(`[表头：${candidate.tableHeaderText}]`);
            else if (renderedHeader !== undefined) texts.push("[表头：未标注]");
            renderedHeader = candidate.tableHeaderText ?? null;
          }
          const contextLines =
            route === "morphology"
              ? rangeLines.filter(
                  (line) =>
                    Math.abs(line.index - candidate.index) <= 1 &&
                    !line.boundary &&
                    line.role !== "noise" &&
                    (line.index === candidate.index ||
                      !startsIndependentNegativeImagingConclusion(line.text)) &&
                    (!line.candidate || line.candidateKind === "morphology"),
                )
              : [candidate];
          for (const line of contextLines) {
            if (emittedLineIndexes.has(line.index)) continue;
            emittedLineIndexes.add(line.index);
            texts.push(line.text);
          }
        }
      } else {
        const lines =
          route === "narrative"
            ? rangeLines.filter(
                (line) =>
                  (narrativeWholePage &&
                    !["noise", "morphology"].includes(line.role)) ||
                  line.role === "narrative" ||
                  (line.role === "section_heading" &&
                    narrativeSectionHeadingPattern.test(line.text)),
              )
            : rangeLines;
        texts.push(...lines.map((line) => line.text));
      }
      const chunkLabel =
        range.chunkCount > 1
          ? ` · 内容分块 ${range.chunkIndex}/${range.chunkCount}`
          : "";
      return `[第 ${range.pageNumber} 页${chunkLabel}]\n${texts.join("\n")}`;
    })
    .filter(Boolean);
  const routeLabel =
    route === "morphology"
      ? "形态发现"
      : route === "narrative"
        ? "原文章节"
        : route === "document"
          ? "文档概况"
          : "指标";
  const text = `[解析任务：${routeLabel}]\n${rendered.join("\n\n")}`;
  const inputHash = sha256(
    [
      aiInputPlanningPolicy.version,
      unitType,
      route,
      allowDocumentFields ? "document" : "facts",
      documentScalarCandidates ? "with-scalars" : "",
      text,
    ].join("\u0000"),
  );
  const rangeKey = ranges
    .map(
      (range) =>
        `${range.pageNumber}:${range.lineStart}-${range.lineEnd}:${range.chunkIndex}/${range.chunkCount}`,
    )
    .join("|");
  const selectedLines = ranges.flatMap((range) => {
    const page = pages.find((item) => item.pageId === range.pageId);
    return (
      page?.lines.filter(
        (line) => line.index >= range.lineStart && line.index <= range.lineEnd,
      ) || []
    );
  });
  const scalarAiCandidateCount = selectedLines.filter(
    (line) =>
      line.candidateKind === "scalar" && lineNeedsAiScalarExtraction(line),
  ).length;
  const candidateRowCount =
    route === "scalar"
      ? scalarAiCandidateCount
      : route === "morphology"
        ? selectedLines.filter((line) => line.candidateKind === "morphology")
            .length
        : route === "document" && documentScalarCandidates
          ? scalarAiCandidateCount
          : 0;
  const morphologyCandidateCount =
    route === "morphology"
      ? candidateRowCount
      : /* 概览合并单元：形态候选计入输出量估算，保证单请求预算覆盖形态输出 */
        route === "document" && documentScalarCandidates
        ? selectedLines.filter((line) => line.candidateKind === "morphology")
            .length
        : 0;
  const localObservationCount = selectedLines.reduce(
    (sum, line) => sum + localObservationsForLine(line).length,
    0,
  );
  const pageCount = new Set(ranges.map((range) => range.pageNumber)).size;
  const candidateFacts =
    route === "scalar" ||
    route === "morphology" ||
    (route === "document" && documentScalarCandidates)
      ? ranges.flatMap((range) => {
          const page = pages.find((item) => item.pageId === range.pageId);
          return (page?.lines || [])
            .filter(
              (line) =>
                line.index >= range.lineStart &&
                line.index <= range.lineEnd &&
                line.candidateKind === extractionMode &&
                (route === "morphology" || lineNeedsAiScalarExtraction(line)),
            )
            .map((line) => ({
              pageNumber: range.pageNumber,
              kind: line.candidateKind as "scalar" | "morphology",
              sourceText: line.text,
              dictionaryFacts: line.dictionaryFacts,
            }));
        })
      : [];
  const classification = mergeContentClassifications(
    ranges.flatMap((range) => {
      const page = pages.find((item) => item.pageId === range.pageId);
      return page ? [page.classification] : [];
    }),
  );
  return {
    unitKey: `unit_${sha256(`${unitType}|${route}|${rangeKey}|${inputHash}`).slice(0, 24)}`,
    inputHash,
    unitType,
    extractionMode,
    route,
    allowDocumentFields,
    classification,
    pageNumbers: [...new Set(ranges.map((range) => range.pageNumber))],
    pageRanges: ranges,
    characterCount: text.length,
    candidateRowCount,
    morphologyCandidateCount,
    localObservationCount,
    estimatedOutputTokens: estimateAiUnitOutputTokens({
      pageCount,
      characterCount: text.length,
      candidateRowCount,
      morphologyCandidateCount,
      candidateCharacters: candidateFacts.reduce(
        (sum, fact) => sum + fact.sourceText.length,
        0,
      ),
    }),
    lineCount: ranges.reduce(
      (sum, range) => sum + Math.max(0, range.lineEnd - range.lineStart + 1),
      0,
    ),
    text,
    candidateFacts,
  };
}

export function splitAiExtractionUnit(
  plan: AiExtractionPlan,
  unit: AiExtractionUnit,
) {
  const documentPrimaryType = plan.documentClassification?.primaryType ?? null;
  if (unit.pageRanges.length > 1) {
    const midpoint = Math.ceil(unit.pageRanges.length / 2);
    return [
      unitFromRanges(
        "page_chunk",
        unit.pageRanges.slice(0, midpoint),
        plan.pages,
        unit.route,
        unit.allowDocumentFields,
        documentPrimaryType,
      ),
      unitFromRanges(
        "page_chunk",
        unit.pageRanges.slice(midpoint),
        plan.pages,
        unit.route,
        unit.allowDocumentFields,
        documentPrimaryType,
      ),
    ].filter((item) => item.text.trim());
  }
  /*
   * 单页单元按行区间二分（pageRanges 的 lineStart/lineEnd 机制现成）。
   * 超密单页输出截断时的最后退路；行数太少则拆无可拆，交回上层报错。
   */
  if (unit.pageRanges.length === 1) {
    const [range] = unit.pageRanges;
    const span = range.lineEnd - range.lineStart + 1;
    if (span < 8) return [];
    const midpoint = range.lineStart + Math.ceil(span / 2);
    const halves = [
      { ...range, lineEnd: midpoint - 1, chunkIndex: 1, chunkCount: 2 },
      { ...range, lineStart: midpoint, chunkIndex: 2, chunkCount: 2 },
    ];
    return halves
      .map((half) =>
        unitFromRanges(
          "page_chunk",
          [half],
          plan.pages,
          unit.route,
          unit.allowDocumentFields,
          documentPrimaryType,
        ),
      )
      .filter(
        (item) =>
          item.text.trim() &&
          (item.candidateRowCount > 0 ||
            !["scalar", "morphology"].includes(item.route)),
      );
  }
  return [];
}

function redactUnlabeledPatientNameRows(value: string) {
  const name = "[患者个资已过滤]";
  return value
    .replace(
      /(^|\n)(\s*)[\u3400-\u9fff·•]{2,20}(\s*[|｜]\s*(?:男|女|男性|女性)\s*[|｜]\s*\d{1,3}\s*岁(?=\s*(?:[|｜]|\n|$)))/g,
      `$1$2${name}$3`,
    )
    .replace(
      /(^|\n)(\s*)[\u3400-\u9fff·•]{2,20}(\s*[|｜]\s*\d{1,3}\s*岁\s*[|｜]\s*(?:男|女|男性|女性)(?=\s*(?:[|｜]|\n|$)))/g,
      `$1$2${name}$3`,
    );
}

export function redactAiInputText(value: string) {
  return redactUnlabeledPatientNameRows(value)
    .replace(
      /((?:患者)?姓名|受检者|病人姓名)\s*[:：]?\s*[^\s,，;；|]{1,20}/gi,
      "[患者个资已过滤]",
    )
    .replace(
      /(身份证(?:号)?|证件号码?)\s*[:：]?\s*[0-9Xx-]{8,24}/gi,
      "[患者个资已过滤]",
    )
    .replace(
      /(联系电话|手机号码?|手机号|电话)\s*[:：]?\s*[+\d()\s-]{7,24}/gi,
      "[患者个资已过滤]",
    )
    .replace(
      /(家庭住址|通讯地址|现住址|联系地址|地址)\s*[:：]?\s*[^|,，;；]{3,80}?(?=(?:报告号|门诊号|住院号|体检号|检查号|标本号|条码号)\s*[:：]|[|,，;；]|$)/gi,
      "[患者个资已过滤] ",
    )
    .replace(
      /(电子邮箱|邮箱|E-?mail)\s*[:：]?\s*[^\s,，;；|]+/gi,
      "[患者个资已过滤]",
    )
    .replace(
      /(出生日期|出生年月|出生时间)\s*[:：]?\s*\d{4}[-/.年]\d{1,2}(?:[-/.月]\d{1,2}日?)?/gi,
      "[患者个资已过滤]",
    )
    .replace(
      /(^|\D)[1-9]\d{5}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[0-9Xx](?!\d)/g,
      "$1[已过滤身份证号]",
    )
    .replace(/(^|\D)1[3-9]\d{9}(?!\d)/g, "$1[已过滤手机号]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[已过滤邮箱]");
}

function boundaryFor(text: string): PlannedOcrLine["boundary"] {
  const compact = text.trim();
  if (isTableHeaderRow(compact)) return "table_header";
  const cells = splitTableCells(compact).filter(Boolean);
  if (cells.length > 1) {
    const first = cleanContextLabel(cells[0]);
    const allHeadings = cells.every(
      (cell) =>
        sectionHeadingPattern.test(cleanContextLabel(cell)) ||
        /^(?:诊断所见|诊断结果|检查描述|检查提示)$/.test(
          cleanContextLabel(cell),
        ),
    );
    const bilingualHeading =
      (sectionHeadingPattern.test(first) || reportHeadingPattern.test(first)) &&
      cells
        .slice(1)
        .every((cell) => /^[A-Za-z][A-Za-z\s&/()-]{2,}$/.test(cell));
    if (allHeadings || bilingualHeading) return "section";
    return null;
  }
  const sectionText = compact
    .replace(/^【\s*|\s*】$/g, "")
    .replace(/[:：]$/, "")
    .trim();
  if (
    compact.length <= 48 &&
    (/^【[^】]{1,40}】$/.test(compact) ||
      sectionHeadingPattern.test(sectionText) ||
      historicalSectionPattern.test(sectionText) ||
      reportContentRestartPattern.test(sectionText) ||
      (/[:：]$/.test(compact) && !/\d/.test(compact)))
  )
    return "section";
  return null;
}

function isCandidateRow(text: string, unitPattern: RegExp) {
  const trimmed = text.trim();
  if (isNonResultNoise(trimmed)) return false;
  if (isTableHeaderRow(text)) return false;
  if (
    metadataCandidatePattern.test(text) ||
    pageMarkerPattern.test(text.trim())
  )
    return false;
  if (metadataRowPattern.test(text) || referenceOnlyPattern.test(trimmed))
    return false;
  if (
    directoryLinePattern.test(trimmed) ||
    businessNumberOnlyPattern.test(trimmed)
  )
    return false;
  if (tableOfContentsRowPattern.test(trimmed)) return false;
  // 设备界面残留的“字母紧贴数字+单位”片段（如超声图上的 L0.15cm），
  // 整行没有任何指标名，AI 也无法对齐验证，不应成为候选。
  if (
    !/\s/.test(trimmed) &&
    new RegExp(
      `^[A-Za-z]{1,2}[-+]?\\d+(?:\\.\\d+)?(?:${unitPattern.source})$`,
      "i",
    ).test(trimmed)
  )
    return false;
  // 长编号行（体检号/条码等）不是测量值；单位判定必须紧贴数字，
  // 防止英文机构名里的裸字母（如 HEALTH 中的 L）被误判为单位而绕过拦截。
  // 行内含中文项目名时放行给后续常规候选判定，避免误伤“编号+指标”合并行。
  if (
    /\d{12,}/.test(text) &&
    !new RegExp(`\\d\\s*(?:${unitPattern.source})`, "i").test(text) &&
    !/[一-鿿]/.test(text) &&
    !/(参考值|参考范围|正常范围)/.test(text)
  ) {
    return false;
  }
  const cells = trimmed
    .split(/[|｜]/)
    .map((cell) => cell.trim())
    .filter(Boolean);
  /* 首列为序号的表格行顺延到真正的项目名格，其余行保持首格语义。 */
  const measurementCells = skipLeadingSerialCell(cells);
  const firstCell = measurementCells[0]?.trim() || "";
  const hasIndicatorName =
    /[\p{L}\u3400-\u9fff]{2,}/u.test(firstCell) ||
    (/[\u3400-\u9fff]/u.test(firstCell) &&
      (unitPattern.test(text) ||
        (measurementCells.length >= 2 &&
          resultCellPattern.test(measurementCells[1]))));
  if (!hasIndicatorName) return false;
  if (/^(?:正常|异常|阴性|阳性|未见|可见)$/.test(firstCell)) return false;
  if (text.length > 240 && !/[|｜]/.test(text)) return false;
  if (
    hasEmbeddedBodyCompositionResult(text) &&
    /(?:^|[|｜])\s*综合得分\s*[:：]\s*\d{1,3}(?:\.\d+)?\s*(?=[|｜]|$)/.test(
      text,
    )
  ) {
    return true;
  }
  if (isMorphologyCandidate(text)) return true;
  if (
    measurementCells.length >= 2 &&
    /[\p{L}\u3400-\u9fff]{1,}/u.test(firstCell) &&
    /^(?:[-+±]+|(?:<|<=|≤|>|>=|≥)?\s*[-+]?\d+(?:\.\d+)?(?:\s|$)|阴性|阳性|弱阳性|正常|异常|未见|可见|(?:AB|A|B|O)型)/.test(
      measurementCells[1],
    )
  )
    return true;
  // 单位必须紧跟测量数值；否则单字母单位 s 会误中 C-TIRADS 等报告代码。
  if (
    new RegExp(
      `[-+]?\\d+(?:\\.\\d+)?\\s*(?:${unitPattern.source})(?=$|[^A-Za-z])`,
      "i",
    ).test(text)
  )
    return true;
  if (/[↑↓▲▼]/.test(text) && /\d/.test(text)) return true;
  if (
    /(?:检验)?结果\s*[:：]\s*(?:阴性|阳性|弱阳性|正常|异常|未见|可见|(?:AB|A|B|O)型)/.test(
      text,
    )
  )
    return true;
  if (
    /^[^|｜，。；:：]{1,30}\s+(?:阴性|阳性|弱阳性|正常|异常|未见|可见|(?:AB|A|B|O)型)$/.test(
      trimmed,
    )
  )
    return true;
  if (
    /[|｜]/.test(text) &&
    /(?:^|[|｜])\s*(?:阴性|阳性|弱阳性|正常|异常|未见|可见|(?:AB|A|B|O)型)\s*(?:[|｜]|$)/.test(
      text,
    ) &&
    !/(?:异常|正常)区域/.test(text)
  )
    return true;
  if (/(参考值|参考范围|正常范围)/.test(text) && /\d/.test(text)) return true;
  if (
    !/\b20\d{2}-\d{1,2}(?:-\d{1,2})?\b/.test(text) &&
    /\d(?:\.\d+)?\s*[~～-]\s*\d/.test(text)
  )
    return true;
  return /(?:^|[|｜])[^|｜]{1,24}[:：]\s*[-+]?\d+(?:\.\d+)?/.test(text);
}

function parseLines(
  value: string,
  pageNumber: number,
  aliases: PreparedDictionaryAliases,
  unitPattern: RegExp,
) {
  let parsed: RawOcrLine[] = [];
  try {
    const candidate = JSON.parse(value) as unknown;
    parsed = Array.isArray(candidate) ? (candidate as RawOcrLine[]) : [];
  } catch {
    parsed = [];
  }
  const lines = parsed.flatMap((line, index): PlannedOcrLine[] => {
    const rawText = typeof line.text === "string" ? line.text.trim() : "";
    const text = redactAiInputText(rawText)
      .replace(redactionPlaceholderPattern, " ")
      .replace(/^[\s|,，;；:：]+|[\s|,，;；:：]+$/g, "")
      .replace(/(?<=\d)\.\s+(?=\d)/g, ".")
      /* OCR 常把日期与时间粘连（如“2024-01-0912:41”），不拆开 AI 难以稳定解析报告时间等字段 */
      .replace(/(\d{4}-\d{1,2}-\d{1,2})(?=\d{1,2}:\d{2})/g, "$1 ")
      /* 同理，时间与后续中文标签粘连（如“10:10接收时间”）也需要拆开 */
      .replace(/(\d{1,2}:\d{2}(?::\d{2})?)(?=[一-鿿])/g, "$1 ")
      .replace(/\s{2,}/g, " ")
      .trim();
    const plannedText = stripFooterNoiseFragments(text) || text;
    if (!plannedText) return [];
    const confidence = Number(line.confidence);
    return [
      {
        id:
          typeof line.id === "string" && line.id.trim()
            ? line.id.trim()
            : `page_${pageNumber}_line_${index + 1}`,
        sourceLineIds: [
          typeof line.id === "string" && line.id.trim()
            ? line.id.trim()
            : `page_${pageNumber}_line_${index + 1}`,
        ],
        sourceCells: [
          {
            index: 0,
            text: plannedText,
            sourceLineIds: [
              typeof line.id === "string" && line.id.trim()
                ? line.id.trim()
                : `page_${pageNumber}_line_${index + 1}`,
            ],
            box: line.box ?? null,
          },
        ],
        index,
        text: plannedText,
        confidence: Number.isFinite(confidence)
          ? Math.max(0, Math.min(1, confidence))
          : null,
        box: line.box ?? null,
        candidate: false,
        candidateKind: null,
        dictionaryFacts: [],
        boundary: boundaryFor(text),
        role: "uncertain",
        contentRole: "narrative",
        candidateResolutionReason: null,
        localObservation: null,
        localObservations: [],
      },
    ];
  });
  return mergeWrappedPageLines(
    reconstructPageLayout(
      repairQuantitativeUltrasoundBoneScorePairs(
        repairBodyCompositionCoordinatePairs(lines),
      ),
      aliases,
      unitPattern,
    ),
    aliases,
    unitPattern,
  );
}

function repeatedLineFingerprint(value: string) {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
    .replace(/第?\s*\d+\s*页(?:\s*[/／共]\s*\d+\s*页?)?/g, "#页码#")
    .replace(/\s+/g, "")
    .replace(/[|｜,，;；:：_\-—]+/g, "");
}

function isLowValueNoise(line: PlannedOcrLine) {
  const text = line.text.trim();
  if (!text) return true;
  if (pageMarkerPattern.test(text) || footerNoisePattern.test(text))
    return true;
  if (!/[\p{L}\p{N}\u3400-\u9fff]/u.test(text)) return true;
  if (
    line.confidence !== null &&
    line.confidence < 0.35 &&
    text.length <= 16 &&
    !line.candidate &&
    !line.boundary
  )
    return true;
  return false;
}

function isEducationPage(lines: PlannedOcrLine[]) {
  const heading = lines
    .slice(0, 5)
    .some((line) => educationHeadingPattern.test(line.text.trim()));
  if (!heading) return false;
  return !lines.some((line) => line.boundary === "table_header");
}

function cleanRebuiltPages(pages: RebuiltOcrPage[]) {
  const frequency = new Map<string, Set<number>>();
  for (const page of pages) {
    for (const line of page.lines) {
      const fingerprint = repeatedLineFingerprint(line.text);
      if (!fingerprint) continue;
      const pageNumbers = frequency.get(fingerprint) || new Set<number>();
      pageNumbers.add(page.pageNumber);
      frequency.set(fingerprint, pageNumbers);
    }
  }
  const repeatedThreshold = Math.max(3, Math.ceil(pages.length * 0.2));
  const seenRepeated = new Set<string>();
  return pages.map((page): RebuiltOcrPage => {
    let repeatedRemovedLineCount = 0;
    let noiseRemovedLineCount = 0;
    const lines = page.lines.filter((line) => {
      if (isLowValueNoise(line)) {
        noiseRemovedLineCount += 1;
        return false;
      }
      const fingerprint = repeatedLineFingerprint(line.text);
      const repeated =
        (frequency.get(fingerprint)?.size || 0) >= repeatedThreshold;
      const edgeLine =
        line.index <= 4 || line.index >= Math.max(0, page.sourceLineCount - 4);
      if (
        repeated &&
        edgeLine &&
        line.text.length <= 200 &&
        !line.candidate &&
        line.boundary !== "table_header" &&
        line.boundary !== "section"
      ) {
        if (seenRepeated.has(fingerprint)) {
          repeatedRemovedLineCount += 1;
          return false;
        }
        seenRepeated.add(fingerprint);
      }
      return true;
    });
    const text = renderCompletePage({ pageNumber: page.pageNumber, lines });
    return {
      ...page,
      lineCount: lines.length,
      characterCount: text.length,
      candidateRowCount: lines.filter((line) => line.candidate).length,
      morphologyCandidateCount: lines.filter(
        (line) => line.candidateKind === "morphology",
      ).length,
      narrativeLineCount: lines.filter(
        (line) =>
          line.role === "narrative" ||
          (line.role === "section_heading" &&
            narrativeSectionHeadingPattern.test(line.text)),
      ).length,
      localObservationCount: lines.reduce(
        (sum, line) => sum + localObservationsForLine(line).length,
        0,
      ),
      removedLineCount:
        page.removedLineCount + page.lines.length - lines.length,
      repeatedRemovedLineCount,
      noiseRemovedLineCount,
      text,
      lines,
      classification: classifyReportContent(text),
    };
  });
}

function repairCrossPageContexts(pages: RebuiltOcrPage[]) {
  let previousLastCandidate: PlannedOcrLine | null = null;
  return pages.map((page): RebuiltOcrPage => {
    const firstBoundaryIndex = page.lines.findIndex((line) =>
      Boolean(line.boundary),
    );
    const continuationLines =
      firstBoundaryIndex < 0
        ? page.lines
        : page.lines.slice(0, firstBoundaryIndex);
    let beforeBoundary = Boolean(
      continuationLines.some((line) => line.candidate) &&
      previousLastCandidate?.candidate &&
      previousLastCandidate.sectionName,
    );
    const lines = page.lines.map((line) => {
      if (line.boundary) beforeBoundary = false;
      if (!beforeBoundary || !line.candidate || line.sectionName) return line;
      const sectionName = previousLastCandidate?.sectionName || null;
      return {
        ...line,
        sectionName,
        reportSectionName: previousLastCandidate?.reportSectionName || null,
        tableHeaderText:
          line.tableHeaderText ||
          previousLastCandidate?.tableHeaderText ||
          null,
        localObservation: localObservationsForLine(line)[0]
          ? { ...localObservationsForLine(line)[0], sectionName }
          : null,
        localObservations: localObservationsForLine(line).map((fact) => ({
          ...fact,
          sectionName,
        })),
      };
    });
    previousLastCandidate =
      [...lines].reverse().find((line) => line.candidate) || null;
    return { ...page, lines };
  });
}

function renderCompletePage(
  page: Pick<RebuiltOcrPage, "pageNumber" | "lines">,
) {
  return `[第 ${page.pageNumber} 页]\n${page.lines.map((line) => line.text).join("\n")}`;
}

export function rebuildOcrPages(
  rows: Array<{ pageId: string; pageNumber: number; linesJson: string }>,
  options?: { patientSex?: PatientSex | null },
) {
  const aliases = prepareDictionaryAliases(activeDictionaryAliases());
  // 一个报告重建周期只读取一次动态单位字典，避免逐行候选检测重复访问数据库。
  const unitPattern = measurementUnitPattern();
  let educationContinuation = false;
  let lineContext: PageLineContext = {
    section: null,
    reportSection: null,
    narrativeActive: false,
    tableHeader: null,
    tableHeaderCells: null,
    contentRegion: null,
    pageNumber: null,
    endedWithCandidate: false,
  };
  const pages = rows.map((row): RebuiltOcrPage => {
    const parsed = parseLines(
      row.linesJson,
      row.pageNumber,
      aliases,
      unitPattern,
    );
    const annotated = annotatePageLines(
      parsed,
      row.pageNumber,
      lineContext,
      aliases,
      unitPattern,
      options?.patientSex,
    );
    const parsedLines = annotated.lines;
    lineContext = annotated.context;
    const historicalIndex = parsedLines.findIndex((line) =>
      historicalSectionPattern.test(
        line.text.replace(/^【\s*|\s*】$/g, "").trim(),
      ),
    );
    const startsEducation = isEducationPage(parsedLines);
    const restartsReportContent = parsedLines
      .slice(0, 12)
      .some(
        (line) =>
          line.boundary === "table_header" ||
          reportContentRestartPattern.test(line.text.trim()) ||
          documentAnchorHeadingPattern.test(
            cleanContextLabel(splitTableCells(line.text)[0] || ""),
          ),
      );
    if (educationContinuation && restartsReportContent)
      educationContinuation = false;
    if (startsEducation) educationContinuation = true;
    let lines =
      historicalIndex >= 0
        ? parsedLines.slice(0, historicalIndex)
        : parsedLines;
    if (educationContinuation) {
      lines = startsEducation
        ? parsedLines
            .slice(0, 10)
            .filter((line) => educationHeadingPattern.test(line.text.trim()))
        : [];
    }
    lines = lines.map((line) => ({
      ...line,
      candidate: educationContinuation ? false : line.candidate,
      candidateKind: educationContinuation ? null : line.candidateKind,
      dictionaryFacts: educationContinuation ? [] : line.dictionaryFacts,
      role: educationContinuation ? ("noise" as const) : line.role,
      contentRole: educationContinuation
        ? ("narrative" as const)
        : line.contentRole,
      candidateResolutionReason: educationContinuation
        ? ("filtered_noise" as const)
        : line.candidateResolutionReason,
      localObservation: educationContinuation ? null : line.localObservation,
      localObservations: educationContinuation
        ? []
        : localObservationsForLine(line),
    }));
    const text = renderCompletePage({ pageNumber: row.pageNumber, lines });
    return {
      pageId: row.pageId,
      pageNumber: row.pageNumber,
      lineCount: lines.length,
      characterCount: text.length,
      candidateRowCount: lines.filter((line) => line.candidate).length,
      morphologyCandidateCount: lines.filter(
        (line) => line.candidateKind === "morphology",
      ).length,
      narrativeLineCount: lines.filter(
        (line) =>
          line.role === "narrative" ||
          (line.role === "section_heading" &&
            narrativeSectionHeadingPattern.test(line.text)),
      ).length,
      localObservationCount: lines.reduce(
        (sum, line) => sum + localObservationsForLine(line).length,
        0,
      ),
      sourceLineCount: parsedLines.length,
      removedLineCount: parsedLines.length - lines.length,
      repeatedRemovedLineCount: 0,
      noiseRemovedLineCount: 0,
      text,
      lines,
      classification: classifyReportContent(text),
    };
  });
  return repairCrossPageContexts(cleanRebuiltPages(pages));
}

function unitFromPages(pages: RebuiltOcrPage[]): AiExtractionUnit {
  const text = pages.map((page) => page.text).join("\n\n");
  const inputHash = sha256(text);
  const candidateRowCount = pages.reduce(
    (sum, page) => sum + page.candidateRowCount,
    0,
  );
  const morphologyCandidateCount = pages.reduce(
    (sum, page) => sum + page.morphologyCandidateCount,
    0,
  );
  const localObservationCount = pages.reduce(
    (sum, page) => sum + page.localObservationCount,
    0,
  );
  const candidateFacts = pages.flatMap((page) =>
    page.lines
      .filter((line) => line.candidateKind)
      .map((line) => ({
        pageNumber: page.pageNumber,
        kind: line.candidateKind as "scalar" | "morphology",
        sourceText: line.text,
        dictionaryFacts: line.dictionaryFacts,
      })),
  );
  const classification = mergeContentClassifications(
    pages.map((page) => page.classification),
  );
  return {
    unitKey: `unit_${sha256(`complete_pages|${pages.map((page) => page.pageNumber).join(",")}|${inputHash}`).slice(0, 24)}`,
    inputHash,
    unitType: "complete_pages",
    extractionMode: "scalar",
    route: "scalar",
    allowDocumentFields: false,
    classification,
    pageNumbers: pages.map((page) => page.pageNumber),
    pageRanges: pages.map((page) => ({
      pageId: page.pageId,
      pageNumber: page.pageNumber,
      lineStart: page.lines[0]?.index ?? 0,
      lineEnd: page.lines.at(-1)?.index ?? 0,
      chunkIndex: 1,
      chunkCount: 1,
    })),
    characterCount: text.length,
    candidateRowCount,
    morphologyCandidateCount,
    localObservationCount,
    estimatedOutputTokens: estimateAiUnitOutputTokens({
      pageCount: pages.length,
      characterCount: text.length,
      candidateRowCount,
      morphologyCandidateCount,
      candidateCharacters: candidateFacts.reduce(
        (sum, fact) => sum + fact.sourceText.length,
        0,
      ),
    }),
    lineCount: pages.reduce((sum, page) => sum + page.lineCount, 0),
    text,
    candidateFacts,
  };
}

type AiUnitPackingLimits = {
  maxPagesPerUnit: number;
  targetCharacters: number;
  targetOutputTokens: number;
  maxCandidateRowsPerUnit: number;
  /* 当前模型的请求侧输出量上限（estimateAiUnitRequestOutput 口径）；
     undefined 表示不做预算护栏（测试与默认路径保持既有行为） */
  maxRequestOutput?: number;
};

const defaultUnitPackingLimits: AiUnitPackingLimits = {
  maxPagesPerUnit: aiInputPlanningPolicy.maxPagesPerUnit,
  targetCharacters: aiInputPlanningPolicy.targetCharacters,
  targetOutputTokens: aiInputPlanningPolicy.targetOutputTokens,
  maxCandidateRowsPerUnit: aiInputPlanningPolicy.maxCandidateRowsPerUnit,
};

/*
 * 概览模式放宽指标单元打包上限：单元更大、请求更少。输出超限时由 orchestrator
 * 现有的扩容→拆分恢复路径兜底，指标单元拆分后的子单元仍保留完整指标语义。
 */
function overviewUnitPackingLimits(
  maxRequestOutput: number | undefined,
): AiUnitPackingLimits {
  return {
    maxPagesPerUnit: aiInputPlanningPolicy.maxPagesPerUnit * 2,
    targetCharacters: aiInputPlanningPolicy.targetCharacters * 2,
    targetOutputTokens: aiInputPlanningPolicy.targetOutputTokens * 2,
    maxCandidateRowsPerUnit: aiInputPlanningPolicy.maxCandidateRowsPerUnit * 2,
    maxRequestOutput,
  };
}

/*
 * 把模型的输出上限换算成打包阶段的请求侧估算上限：预留 15% 余量，
 * 保证 calculateAiOutputTokenBudget 算出的请求预算落在模型能力之内。
 */
function requestOutputBudgetGuard(maxOutputTokens: number | undefined) {
  if (!Number.isFinite(maxOutputTokens)) return undefined;
  return Math.max(1_024, Math.floor(Number(maxOutputTokens) * 0.85));
}

/*
 * 概览单请求模式：整份报告（文档字段 + 全部指标）合并为一个解析单元，
 * 一次请求完成基础内容。仅当输入规模与请求侧输出估算都在模型能力之内时启用，
 * 否则退回“文档概况 + 指标单元”的常规概览路径。
 */
const overviewMergedUnitMaxCharacters = 40_000;

function overviewMergedUnit(
  pages: RebuiltOcrPage[],
  classification: ReportContentClassification,
  maxRequestOutput: number | undefined,
): AiExtractionUnit | null {
  if (pages.length < 2 || maxRequestOutput === undefined) return null;
  const unit = unitFromRanges(
    "complete_pages",
    pages.map((page) => ({
      pageId: page.pageId,
      pageNumber: page.pageNumber,
      lineStart: page.lines[0]?.index ?? 0,
      lineEnd: page.lines.at(-1)?.index ?? 0,
      chunkIndex: 1,
      chunkCount: 1,
    })),
    pages,
    "document",
    true,
    classification.primaryType,
    true,
  );
  if (unit.characterCount > overviewMergedUnitMaxCharacters) return null;
  if (unitRequestOutputEstimate(unit) > maxRequestOutput) return null;
  if (
    unit.candidateRowCount >
    aiInputPlanningPolicy.maxCandidateRowsPerUnit * 2
  )
    return null;
  return unit;
}

function packScalarUnits(
  baseUnits: AiExtractionUnit[],
  pages: RebuiltOcrPage[],
  limits: AiUnitPackingLimits = defaultUnitPackingLimits,
) {
  const ranges = baseUnits
    .flatMap((unit) => unit.pageRanges)
    .filter((range) => {
      const page = pages.find((item) => item.pageId === range.pageId);
      return page?.lines.some(
        (line) =>
          line.index >= range.lineStart &&
          line.index <= range.lineEnd &&
          lineNeedsAiScalarExtraction(line),
      );
    });
  const units: AiExtractionUnit[] = [];
  let pending: typeof ranges = [];
  const flush = () => {
    if (!pending.length) return;
    units.push(
      unitFromRanges("complete_pages", pending, pages, "scalar", false),
    );
    pending = [];
  };
  for (const range of ranges) {
    const combined = unitFromRanges(
      "complete_pages",
      [...pending, range],
      pages,
      "scalar",
      false,
    );
    if (
      pending.length &&
      (combined.pageNumbers.length > limits.maxPagesPerUnit ||
        combined.characterCount > limits.targetCharacters ||
        combined.estimatedOutputTokens >
          limits.targetOutputTokens ||
        combined.candidateRowCount >
          limits.maxCandidateRowsPerUnit ||
        (limits.maxRequestOutput !== undefined &&
          unitRequestOutputEstimate(combined) > limits.maxRequestOutput))
    )
      flush();
    pending.push(range);
  }
  flush();
  return units.filter((unit) => unit.candidateRowCount > 0);
}

function packMorphologyUnits(
  baseUnits: AiExtractionUnit[],
  pages: RebuiltOcrPage[],
) {
  const ranges = baseUnits.flatMap((unit) =>
    unit.pageRanges.filter((range) => {
      const page = pages.find((item) => item.pageId === range.pageId);
      return page?.lines.some(
        (line) =>
          line.index >= range.lineStart &&
          line.index <= range.lineEnd &&
          line.candidateKind === "morphology",
      );
    }),
  );
  const units: AiExtractionUnit[] = [];
  let pending: typeof ranges = [];
  const flush = () => {
    if (!pending.length) return;
    units.push(
      unitFromRanges("complete_pages", pending, pages, "morphology", false),
    );
    pending = [];
  };
  for (const range of ranges) {
    const combined = unitFromRanges(
      "complete_pages",
      [...pending, range],
      pages,
      "morphology",
      false,
    );
    if (
      pending.length &&
      (combined.pageNumbers.length > aiInputPlanningPolicy.maxPagesPerUnit ||
        combined.characterCount > aiInputPlanningPolicy.targetCharacters ||
        combined.estimatedOutputTokens >
          aiInputPlanningPolicy.targetOutputTokens ||
        combined.candidateRowCount >
          aiInputPlanningPolicy.maxCandidateRowsPerUnit)
    )
      flush();
    pending.push(range);
  }
  flush();
  return units.filter((unit) => unit.candidateRowCount > 0);
}

function packNarrativeUnits(
  baseUnits: AiExtractionUnit[],
  pages: RebuiltOcrPage[],
  documentPrimaryType: ReportContentType,
) {
  const ranges = baseUnits
    .flatMap((unit) => unit.pageRanges)
    .filter((range) => {
      const narrative = unitFromRanges(
        "complete_pages",
        [range],
        pages,
        "narrative",
        false,
        documentPrimaryType,
      );
      return Boolean(
        narrative.text
          .replace(
            /\[解析任务：原文章节\]|\[第 \d+ 页(?: · 内容分块 \d+\/\d+)?\]/g,
            "",
          )
          .trim(),
      );
    });
  const units: AiExtractionUnit[] = [];
  let pending: typeof ranges = [];
  const flush = () => {
    if (!pending.length) return;
    units.push(
      unitFromRanges(
        "complete_pages",
        pending,
        pages,
        "narrative",
        false,
        documentPrimaryType,
      ),
    );
    pending = [];
  };
  for (const range of ranges) {
    const combined = unitFromRanges(
      "complete_pages",
      [...pending, range],
      pages,
      "narrative",
      false,
      documentPrimaryType,
    );
    if (
      pending.length &&
      (combined.pageNumbers.length >
        aiInputPlanningPolicy.maxSparsePagesPerUnit ||
        combined.characterCount > aiInputPlanningPolicy.targetCharacters ||
        combined.estimatedOutputTokens >
          aiInputPlanningPolicy.targetOutputTokens)
    )
      flush();
    pending.push(range);
  }
  flush();
  return units;
}

function documentProfileUnit(
  pages: RebuiltOcrPage[],
  classification: ReportContentClassification,
  includeSinglePageScalars: boolean,
) {
  const candidates = new Map<
    string,
    {
      page: RebuiltOcrPage;
      line: PlannedOcrLine;
      priority: number;
    }
  >();
  const add = (
    page: RebuiltOcrPage,
    line: PlannedOcrLine,
    priority: number,
  ) => {
    const key = `${page.pageId}:${line.id}`;
    const existing = candidates.get(key);
    if (!existing || priority < existing.priority)
      candidates.set(key, { page, line, priority });
  };

  for (const page of pages) {
    if (page.pageNumber <= 2) {
      for (const line of page.lines.slice(0, page.pageNumber === 1 ? 32 : 16)) {
        if (
          line.role !== "noise" &&
          (includeSinglePageScalars ||
            !["scalar", "morphology", "table_header"].includes(line.role))
        )
          add(page, line, page.pageNumber === 1 ? 2 : 3);
      }
    }
    for (const line of page.lines) {
      /* 患者信息行与 metadata 同级：文档单元超预算时先丢低优先级行，
         性别/年龄一旦丢失，文档字段（及后续按性别解读参考范围）就无从谈起。 */
      if (
        line.role === "metadata" ||
        line.role === "section_heading" ||
        isPatientInfoRow(line.text)
      ) {
        add(page, line, 1);
      }
    }
    for (let index = 0; index < page.lines.length; index += 1) {
      if (!documentAnchorHeadingPattern.test(page.lines[index].text)) continue;
      for (const line of page.lines.slice(index, index + 7)) add(page, line, 0);
    }
    if (includeSinglePageScalars) {
      for (const line of page.lines) {
        if (line.role === "scalar" || line.role === "table_header")
          add(page, line, 1);
      }
    }
  }

  // Internal classifier enums are routing metadata, not report content. Sending
  // values such as "checkup" in the OCR body can make a model copy them into
  // reportSubtype or bodyParts.
  const heading = `[文档概况]\n总页数：${pages.length}`;
  const selected = new Map<number, PlannedOcrLine[]>();
  let selectedCharacters = heading.length;
  for (const candidate of [...candidates.values()].sort(
    (left, right) =>
      left.priority - right.priority ||
      left.page.pageNumber - right.page.pageNumber ||
      left.line.index - right.line.index,
  )) {
    const addition = candidate.line.text.length + 1;
    if (
      selectedCharacters + addition > aiInputPlanningPolicy.targetCharacters &&
      selected.size
    )
      continue;
    const current = selected.get(candidate.page.pageNumber) || [];
    current.push(candidate.line);
    selected.set(candidate.page.pageNumber, current);
    selectedCharacters += addition;
  }

  const rendered: string[] = [heading];
  const ranges: AiExtractionUnit["pageRanges"] = [];
  const candidateFacts: AiExtractionUnit["candidateFacts"] = [];
  for (const page of pages) {
    const lines = (selected.get(page.pageNumber) || []).sort(
      (left, right) => left.index - right.index,
    );
    if (!lines.length) continue;
    rendered.push(
      `[第 ${page.pageNumber} 页]\n${lines.map((line) => line.text).join("\n")}`,
    );
    ranges.push({
      pageId: page.pageId,
      pageNumber: page.pageNumber,
      lineStart: Math.min(...lines.map((line) => line.index)),
      lineEnd: Math.max(...lines.map((line) => line.index)),
      chunkIndex: 1,
      chunkCount: 1,
    });
    if (includeSinglePageScalars) {
      candidateFacts.push(
        ...lines
          .filter(
            (line) => lineNeedsAiScalarExtraction(line),
          )
          .map((line) => ({
            pageNumber: page.pageNumber,
            kind: "scalar" as const,
            sourceText: line.text,
            dictionaryFacts: line.dictionaryFacts,
          })),
      );
    }
  }
  const text = rendered.join("\n\n");
  const inputHash = sha256(
    [
      aiInputPlanningPolicy.version,
      "document",
      includeSinglePageScalars ? "with-scalars" : "profile",
      text,
    ].join("\u0000"),
  );
  return {
    unitKey: `unit_${sha256(`document|${inputHash}`).slice(0, 24)}`,
    inputHash,
    unitType: "complete_pages" as const,
    extractionMode: "scalar" as const,
    route: "document" as const,
    allowDocumentFields: true,
    classification,
    pageNumbers: ranges.map((range) => range.pageNumber),
    pageRanges: ranges,
    characterCount: text.length,
    candidateRowCount: candidateFacts.length,
    morphologyCandidateCount: 0,
    localObservationCount: pages.reduce(
      (sum, page) => sum + page.localObservationCount,
      0,
    ),
    estimatedOutputTokens: estimateAiUnitOutputTokens({
      pageCount: ranges.length,
      characterCount: text.length,
      candidateRowCount: candidateFacts.length,
      morphologyCandidateCount: 0,
      candidateCharacters: candidateFacts.reduce(
        (sum, fact) => sum + fact.sourceText.length,
        0,
      ),
    }),
    lineCount: [...selected.values()].reduce(
      (sum, lines) => sum + lines.length,
      0,
    ),
    text,
    candidateFacts,
  } satisfies AiExtractionUnit;
}

export function planRebuiltOcrPages(
  reportId: string,
  pages: RebuiltOcrPage[],
  extractionDepth: AiExtractionDepth = "detailed",
  options: { maxOutputTokens?: number } = {},
): AiExtractionPlan {
  const baseUnits: AiExtractionUnit[] = [];
  let pendingPages: RebuiltOcrPage[] = [];
  const flushPending = () => {
    if (!pendingPages.length) return;
    baseUnits.push(unitFromPages(pendingPages));
    pendingPages = [];
  };

  for (const page of pages) {
    const combinedPages = [...pendingPages, page];
    const combinedText = combinedPages.map((item) => item.text).join("\n\n");
    const combinedCandidates = combinedPages.reduce(
      (sum, item) => sum + item.candidateRowCount,
      0,
    );
    const combinedMorphologyCandidates = combinedPages.reduce(
      (sum, item) => sum + item.morphologyCandidateCount,
      0,
    );
    const estimatedOutputTokens = estimateAiUnitOutputTokens({
      pageCount: combinedPages.length,
      characterCount: combinedText.length,
      candidateRowCount: combinedCandidates,
      morphologyCandidateCount: combinedMorphologyCandidates,
    });
    if (
      pendingPages.length &&
      (pendingPages.length >= aiInputPlanningPolicy.maxPagesPerUnit ||
        combinedText.length > aiInputPlanningPolicy.targetCharacters ||
        estimatedOutputTokens > aiInputPlanningPolicy.targetOutputTokens ||
        combinedCandidates > aiInputPlanningPolicy.maxCandidateRowsPerUnit)
    )
      flushPending();
    // A page is the minimum extraction boundary. Oversized pages stay intact so
    // table and section relationships are never broken across AI requests.
    pendingPages.push(page);
  }
  flushPending();

  if (!baseUnits.length) {
    throw Object.assign(new Error("报告没有可用于 AI 整理的文字"), {
      code: "EMPTY_REPORT_TEXT",
    });
  }
  const documentClassification = classifyReportDocument(pages);
  const singlePageEstimate =
    pages.length === 1
      ? estimateAiUnitOutputTokens({
          pageCount: 1,
          characterCount: pages[0].characterCount,
          candidateRowCount: pages[0].candidateRowCount,
          morphologyCandidateCount: 0,
        })
      : Number.POSITIVE_INFINITY;
  const includeSinglePageScalars =
    pages.length === 1 &&
    pages[0].characterCount <= aiInputPlanningPolicy.targetCharacters &&
    pages[0].candidateRowCount <=
      aiInputPlanningPolicy.maxCandidateRowsPerUnit &&
    singlePageEstimate <= aiInputPlanningPolicy.targetOutputTokens;
  const maxRequestOutput = requestOutputBudgetGuard(options.maxOutputTokens);
  /*
   * 概览单请求模式：整份报告能装进当前模型的输出能力时，
   * 文档字段与全部指标合并为一个单元，一次请求完成基础内容。
   */
  const mergedOverviewUnit =
    extractionDepth === "overview" && !includeSinglePageScalars
      ? overviewMergedUnit(pages, documentClassification, maxRequestOutput)
      : null;
  const documentUnit = mergedOverviewUnit
    ? null
    : documentProfileUnit(pages, documentClassification, includeSinglePageScalars);
  const scalarUnits =
    includeSinglePageScalars || mergedOverviewUnit
      ? []
      : packScalarUnits(
          baseUnits,
          pages,
          extractionDepth === "overview"
            ? overviewUnitPackingLimits(maxRequestOutput)
            : { ...defaultUnitPackingLimits, maxRequestOutput },
        );
  /*
   * 概览模式：指标仍逐行提取（与详细模式同一解析契约），并保留形态发现单元；
   * 不生成叙事章节单元，也不做补充复核；文档概况单元保持现状。
   * 合并单元已在同一契约内输出形态发现，不再单独生成形态单元。
   */
  const narrativeUnits = extractionDepth === "overview"
    ? []
    : packNarrativeUnits(baseUnits, pages, documentClassification.primaryType);
  const morphologyUnits =
    extractionDepth === "overview" && mergedOverviewUnit
      ? []
      : packMorphologyUnits(baseUnits, pages);
  const units = mergedOverviewUnit
    ? [mergedOverviewUnit]
    : [documentUnit!, ...scalarUnits, ...narrativeUnits, ...morphologyUnits];
  const localFactsHash = sha256(
    JSON.stringify(
      pages.flatMap((page) =>
        page.lines.flatMap((line) => localObservationsForLine(line)),
      ),
    ),
  );
  const planHash = sha256(
    [
      extractionDepth,
      String(maxRequestOutput ?? "unguarded"),
      units.map((unit) => `${unit.unitKey}:${unit.inputHash}`).join("|"),
      localFactsHash,
    ].join("\u0000"),
  );
  return {
    policy: aiInputPlanningPolicy,
    extractionDepth,
    reportId,
    pageCount: pages.length,
    sourceCharacterCount: pages.reduce(
      (sum, page) => sum + page.characterCount,
      0,
    ),
    candidateRowCount: pages.reduce(
      (sum, page) => sum + page.candidateRowCount,
      0,
    ),
    morphologyCandidateCount: pages.reduce(
      (sum, page) => sum + page.morphologyCandidateCount,
      0,
    ),
    narrativeLineCount: pages.reduce(
      (sum, page) => sum + page.narrativeLineCount,
      0,
    ),
    localObservationCount: pages.reduce(
      (sum, page) => sum + page.localObservationCount,
      0,
    ),
    sourceLineCount: pages.reduce((sum, page) => sum + page.sourceLineCount, 0),
    removedLineCount: pages.reduce(
      (sum, page) => sum + page.removedLineCount,
      0,
    ),
    repeatedRemovedLineCount: pages.reduce(
      (sum, page) => sum + page.repeatedRemovedLineCount,
      0,
    ),
    noiseRemovedLineCount: pages.reduce(
      (sum, page) => sum + page.noiseRemovedLineCount,
      0,
    ),
    unitCount: units.length,
    planHash,
    documentClassification,
    pages,
    units,
  };
}

export function buildAiExtractionPlan(reportId: string) {
  const rows = getDatabase()
    .prepare(
      `
    SELECT p.id AS pageId, p.page_number AS pageNumber, p.mime_type AS mimeType,
      p.storage_path AS storagePath, p.source_page_number AS sourcePageNumber,
      p.source_page_count AS sourcePageCount,
      (
        SELECT o.lines_json FROM ocr_results o
        WHERE o.page_id = p.id
        ORDER BY o.created_at DESC, o.id DESC
        LIMIT 1
      ) AS linesJson
    FROM report_pages p
    WHERE p.report_id = ?
    ORDER BY p.page_number
  `,
    )
    .all(reportId) as Array<{
    pageId: string;
    pageNumber: number;
    mimeType: string;
    storagePath: string;
    sourcePageNumber: number | null;
    sourcePageCount: number | null;
    linesJson: string | null;
  }>;
  if (!rows.length) {
    throw Object.assign(new Error("报告没有可用于 AI 整理的页面"), {
      code: "EMPTY_REPORT_PAGES",
    });
  }
  if (rows.some((row, index) => row.pageNumber !== index + 1)) {
    throw Object.assign(new Error("报告页面序号不连续，请重新生成报告分页"), {
      code: "REPORT_PAGE_SEQUENCE_INVALID",
    });
  }
  const pdfSources = new Map<string, typeof rows>();
  for (const row of rows.filter(
    (item) => item.mimeType === "application/pdf",
  )) {
    pdfSources.set(row.storagePath, [
      ...(pdfSources.get(row.storagePath) || []),
      row,
    ]);
  }
  for (const sourceRows of pdfSources.values()) {
    const expected = sourceRows[0]?.sourcePageCount || 0;
    const sourcePageNumbers = sourceRows
      .map((row) => row.sourcePageNumber)
      .filter((pageNumber): pageNumber is number =>
        Number.isInteger(pageNumber),
      )
      .sort((left, right) => left - right);
    const invalidSourceSet =
      expected < 1 ||
      sourceRows.some((row) => row.sourcePageCount !== expected) ||
      sourcePageNumbers.length !== sourceRows.length ||
      sourcePageNumbers.some(
        (pageNumber, index) =>
          pageNumber < 1 ||
          pageNumber > expected ||
          (index > 0 && pageNumber === sourcePageNumbers[index - 1]),
      );
    if (invalidSourceSet) {
      throw Object.assign(
        new Error(
          `PDF 分页身份异常：原文件共 ${expected || "未知"} 页，当前记录 ${sourceRows.length} 页`,
        ),
        { code: "PDF_PAGE_SET_INCOMPLETE" },
      );
    }
  }
  const missingOcrPages = rows
    .filter((row) => row.linesJson === null)
    .map((row) => row.pageNumber);
  if (missingOcrPages.length) {
    throw Object.assign(
      new Error(
        `OCR 页面结果不完整：第 ${missingOcrPages.join("、")} 页尚未完成`,
      ),
      { code: "OCR_PAGE_SET_INCOMPLETE", pageNumbers: missingOcrPages },
    );
  }
  /* 患者性别用于性别分段参考范围（男：…|女：…）选段；
     档案未填时从报告前两页 OCR 文本推断，均无则保持保守现状。 */
  const member = getDatabase()
    .prepare(
      `
    SELECT m.sex AS sex FROM reports r
    JOIN health_members m ON m.id = r.member_id
    WHERE r.id = ?
  `,
    )
    .get(reportId) as { sex: string | null } | undefined;
  const patientSex =
    member?.sex === "male" || member?.sex === "female"
      ? member.sex
      : patientSexFromOcrText(rows.map((row) => row.linesJson));
  return planRebuiltOcrPages(
    reportId,
    rebuildOcrPages(
      rows.map((row) => ({
        pageId: row.pageId,
        pageNumber: row.pageNumber,
        linesJson: row.linesJson || "[]",
      })),
      { patientSex },
    ),
    resolveAiExtractionDepth(),
    {
      /* 规划阶段感知当前模型的输出能力：单元按预算打包，
         避免“规划合法但请求必截断”的错配 */
      maxOutputTokens: resolveAiMaxOutputTokens(
        getAiTaskSettings("report_extraction").provider,
      ),
    },
  );
}

export function previewAiExtractionPlan(user: RequestUser, reportId: string) {
  const report = getDatabase()
    .prepare(
      `
    SELECT member_id AS memberId FROM reports WHERE id = ? AND status <> 'trashed'
  `,
    )
    .get(reportId) as { memberId: string } | undefined;
  if (!report)
    throw createError({ statusCode: 404, statusMessage: "报告不存在" });
  assertMemberManage(user, report.memberId);
  return buildAiExtractionPlan(reportId);
}
