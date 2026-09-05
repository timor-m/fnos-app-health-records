import { getDatabase } from "../database/client";
import { createId } from "../utils/identifier";
import { getAiTaskSettings } from "./ai-settings.service";
import { backfillMemberBloodTypeFromReport } from "./member.service";
import { aiProviderHasRequiredApiKey, resolveAiMaxOutputTokens, resolveAiTemperature } from "./ai-provider";
import { executeAiTask } from "./ai-task.service";
import { buildAiChatCompletionRequestBody } from "./ai-runtime.service";
import {
  normalizeObservation,
  normalizeReportObservations,
} from "./indicator-normalization.service";
import {
  listManualReportFieldKeys,
  reportFieldDefinitions,
  type ReportFieldKey,
} from "./report-field-overrides.service";
import {
  applyObservationFieldOverrides,
  bindObservationFieldOverride,
} from "./observation-field-overrides.service";
import {
  buildAiExtractionPlan,
  localObservationsForLine,
  redactAiInputText,
} from "./ai-input-planner.service";
import type {
  DictionaryCandidateFact,
  LocalObservationFact,
  LocalObservationSourceMap,
  PlannedOcrLine,
} from "./ai-input-planner.service";
import { writeAiInputDebugLog } from "../utils/ai-input-debug-log";
import { isTrackableMorphologyFinding } from "../utils/morphology-rules";
import type { ReportContentType } from "./report-content-classifier.service";
import {
  reportStructuredSectionKeys,
  type ReportStructuredSectionKey,
} from "../domain/health-record";
import { reportStructuredSectionLabels } from "./report-structured-section.service";
import {
  deriveObservationDisplayAbnormal,
  inferObservationAbnormalFlag,
} from "./observation-interpretation.service";
import { assessObservationReference } from "./observation-reference.service";

export const aiExtractionPromptVersion = "health-record-routed-v8";
const maxInputCharacters = 80_000;
const reportTypeAliases: Record<string, string> = {
  physical_exam: "checkup",
  checkup: "checkup",
  laboratory: "laboratory",
  imaging: "imaging",
  functional: "functional",
  pathology: "pathology",
  outpatient: "outpatient",
  inpatient: "inpatient",
  prescription: "prescription",
  receipt: "billing",
  billing: "billing",
  vaccine: "vaccination",
  vaccination: "vaccination",
  other: "other",
};
const internalReportMetadataTokens = new Set([
  "physicalexam",
  "checkup",
  "laboratory",
  "imaging",
  "functional",
  "pathology",
  "outpatient",
  "inpatient",
  "prescription",
  "receipt",
  "billing",
  "vaccine",
  "vaccination",
  "other",
]);
const lateralityValues = new Set(["left", "right", "bilateral", "unspecified"]);
const morphologyLateralityValues = new Set([
  "left",
  "right",
  "bilateral",
  "midline",
  "unspecified",
]);
const morphologyPresenceValues = new Set(["present", "absent", "uncertain"]);
const abnormalFlags = new Set(["high", "low", "abnormal", "normal"]);
const diagnosisTypes = new Set([
  "outpatient",
  "admission",
  "discharge",
  "pathology",
  "other",
]);
const medicationContexts = new Set([
  "prescription",
  "outpatient",
  "inpatient",
  "discharge",
  "other",
]);
const procedureTypes = new Set([
  "examination",
  "treatment",
  "surgery",
  "other",
]);
const structuredSectionKeys = new Set<string>(reportStructuredSectionKeys);

const identifierKeys = new Set([
  "reportNo",
  "outpatientNo",
  "inpatientNo",
  "physicalExamNo",
  "examNo",
  "specimenNo",
  "barcodeNo",
]);
const clinicianKeys = new Set([
  "ordering",
  "examining",
  "reporting",
  "reviewing",
  "chief",
]);

export type AiTableEvidence = {
  headerText: string;
  headerSourceLineIds: string[];
  rowSourceLineIds: string[];
  resultColumn: {
    index: number;
    headerText: string | null;
    selectionBasis: "explicit_current_result_header" | "local_source_map";
  } | null;
  sourceMap?: LocalObservationSourceMap;
};

export type AiEvidence = {
  pageNumber: number;
  quote: string;
  table?: AiTableEvidence;
};
export type AiObservation = {
  sectionName: string | null;
  itemCode: string | null;
  itemName: string;
  normalizedName: string | null;
  resultText: string;
  numericValue: number | null;
  unit: string | null;
  referenceLow: number | null;
  referenceHigh: number | null;
  referenceText: string | null;
  abnormalFlag: "high" | "low" | "abnormal" | "normal" | null;
  method: string | null;
  evidence: AiEvidence[];
};

export type AiMorphologyMeasurement = {
  key: string;
  value: number;
  unit: string | null;
};

export type AiMorphologyFinding = {
  sectionName: string | null;
  organ: string | null;
  region: string | null;
  laterality: "left" | "right" | "bilateral" | "midline" | "unspecified";
  findingType: string;
  findingName: string;
  presence: "present" | "absent" | "uncertain";
  findingCount: number | null;
  size: {
    length: number | null;
    width: number | null;
    height: number | null;
    unit: string | null;
  };
  measurements: AiMorphologyMeasurement[];
  morphology: string | null;
  attributes: Record<string, string>;
  classification: {
    system: string | null;
    value: string | null;
    text: string | null;
  } | null;
  comparisonText: string | null;
  rawText: string;
  evidence: AiEvidence[];
  confidence: number | null;
};

export type AiDiagnosis = {
  sectionName: string | null;
  diagnosisType:
    "outpatient" | "admission" | "discharge" | "pathology" | "other";
  diagnosisText: string;
  diagnosisCode: string | null;
  codeSystem: string | null;
  isPrimary: boolean;
  evidence: AiEvidence[];
};

export type AiMedication = {
  sectionName: string | null;
  context: "prescription" | "outpatient" | "inpatient" | "discharge" | "other";
  medicationName: string;
  genericName: string | null;
  specification: string | null;
  dosageForm: string | null;
  dose: string | null;
  doseUnit: string | null;
  frequency: string | null;
  route: string | null;
  duration: string | null;
  quantity: string | null;
  quantityUnit: string | null;
  instructions: string | null;
  evidence: AiEvidence[];
};

export type AiProcedure = {
  sectionName: string | null;
  procedureType: "examination" | "treatment" | "surgery" | "other";
  procedureName: string;
  procedureCode: string | null;
  bodyPart: string | null;
  performedAt: string | null;
  resultText: string | null;
  evidence: AiEvidence[];
};

export type AiVaccination = {
  vaccineName: string;
  doseNumber: string | null;
  manufacturer: string | null;
  lotNumber: string | null;
  administeredAt: string | null;
  administrationSite: string | null;
  nextDueAt: string | null;
  evidence: AiEvidence[];
};

export type AiBillingSummary = {
  invoiceNumber: string | null;
  totalAmount: number | null;
  insuranceAmount: number | null;
  selfPayAmount: number | null;
  currency: string;
  evidence: AiEvidence[];
};

export type AiBillingItem = {
  category: string | null;
  itemName: string;
  amount: number | null;
  quantity: number | null;
  evidence: AiEvidence[];
};

export type AiReportStructuredSection = {
  sectionKey: ReportStructuredSectionKey;
  title: string;
  content: string;
  evidence: AiEvidence[];
};

export type AiExtractionFields = {
  reportType: string | null;
  reportSubtype: string | null;
  title: string | null;
  hospitalNameRaw: string | null;
  hospitalBranch: string | null;
  city: string | null;
  visitType: string | null;
  visitDepartment: string | null;
  orderingDepartment: string | null;
  performingDepartment: string | null;
  reportingDepartment: string | null;
  inpatientWard: string | null;
  bodyParts: Array<{
    raw: string;
    name: string;
    parent: string | null;
    laterality: string;
  }>;
  identifiers: Record<string, string>;
  reportIssuedAt: string | null;
  examinedAt: string | null;
  orderedAt: string | null;
  sampledAt: string | null;
  receivedAt: string | null;
  reviewedAt: string | null;
  admittedAt: string | null;
  dischargedAt: string | null;
  clinicians: Record<string, string>;
  clinicalDiagnosis: string | null;
  purpose: string | null;
  chiefComplaint: string | null;
  findings: string | null;
  impression: string | null;
  summary: string | null;
  recommendation: string | null;
  observations: AiObservation[];
  morphologyFindings: AiMorphologyFinding[];
  diagnoses: AiDiagnosis[];
  medications: AiMedication[];
  procedures: AiProcedure[];
  vaccinations: AiVaccination[];
  billingSummary: AiBillingSummary | null;
  billingItems: AiBillingItem[];
  reportSections: AiReportStructuredSection[];
};

export type AiExtractionInput = {
  reportId: string;
  text: string;
  inputCharacters: number;
  pageCount: number;
  planHash?: string;
  plannedUnits?: number;
  sourceInputCharacters?: number;
  compatibilityTruncated?: boolean;
  unitKey?: string;
  unitType?: "complete_pages" | "page_chunk" | "supplement";
  pageNumbers?: number[];
  promptMode?: "standard" | "json_retry" | "supplement";
  extractionMode?: "scalar" | "morphology";
  route?: "document" | "scalar" | "morphology" | "narrative" | "verification";
  allowDocumentFields?: boolean;
  primaryContentType?: ReportContentType;
  contentTypes?: ReportContentType[];
  classificationConfidence?: number;
  classificationReasons?: string[];
  documentContentType?: ReportContentType;
  candidateFacts?: Array<{
    pageNumber: number;
    kind: "scalar" | "morphology";
    sourceText: string;
    dictionaryFacts: DictionaryCandidateFact[];
  }>;
  candidateCount?: number;
  outputTokenScale?: number;
};

export type AiExtractionResult = {
  provider: string;
  model: string;
  promptVersion: string;
  fields: AiExtractionFields;
  evidence: Record<string, AiEvidence[]>;
  confidence: Record<string, number>;
  rawResponseJson: string;
  promptTokens: number | null;
  completionTokens: number | null;
  elapsedMs: number;
  evidenceValidation?: {
    rejectedObservations: number;
    rejectedMorphologyFindings: number;
    rejectedClinicalFacts?: number;
    rejectedStructuredSections?: number;
    /**
     * 被原文证据校验拒绝的观测样本（项目名/结果/AI 声称页码），随单元事件落库，
     * 用于事后回溯“拒绝了什么”。只截样保存，不是完整清单。
     */
    rejectedObservationSamples?: Array<{
      itemName: string;
      resultText: string;
      pageNumbers: number[];
    }>;
  };
};

export type AiExecutor = (
  input: AiExtractionInput,
) => Promise<AiExtractionResult>;

function roundUp(value: number, step: number) {
  return Math.ceil(value / step) * step;
}

export function calculateAiOutputTokenBudget(
  input: Pick<
    AiExtractionInput,
    | "text"
    | "inputCharacters"
    | "pageCount"
    | "candidateCount"
    | "promptMode"
    | "outputTokenScale"
  >,
  modelMaxOutputTokens: number,
) {
  const morphologyCandidates = input.text
    .split("\n")
    .filter((line) =>
      /(囊肿|结节|斑块|息肉|结石|钙化|占位|肿块|包块|积液|增生|萎缩|狭窄|扩张|病灶)/.test(
        line,
      ),
    ).length;
  const candidateCount = Math.max(0, input.candidateCount || 0);
  const inputCharacters = Math.max(
    0,
    input.inputCharacters || input.text.length,
  );
  const pageCount = Math.max(1, input.pageCount || 1);
  const supplement = input.promptMode === "supplement";
  const base = supplement ? 2_048 : 4_096;
  const estimate =
    base +
    candidateCount * (supplement ? 140 : 180) +
    morphologyCandidates * (supplement ? 420 : 700) +
    pageCount * (supplement ? 128 : 384) +
    Math.min(
      supplement ? 2_048 : 6_144,
      Math.ceil(inputCharacters * (supplement ? 0.1 : 0.2)),
    );
  const minimum = supplement ? 4_096 : 8_192;
  const scale = Math.max(1, Math.min(8, input.outputTokenScale || 1));
  const requested = roundUp(Math.max(minimum, estimate * 1.35) * scale, 1_024);
  return Math.max(1_024, Math.min(modelMaxOutputTokens, requested));
}

function redactSensitiveText(value: string) {
  if (
    /(身份证|证件号码|联系电话|手机号码|手机号|家庭住址|通讯地址|现住址)/i.test(
      value,
    )
  )
    return "";
  return value
    .replace(
      /(^|\D)[1-9]\d{5}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[0-9Xx](?!\d)/g,
      "$1[已过滤身份证号]",
    )
    .replace(/(^|\D)1[3-9]\d{9}(?!\d)/g, "$1[已过滤手机号]");
}

function textValue(value: unknown, maxLength = 4000) {
  if (typeof value !== "string") return null;
  const clean = redactSensitiveText(value).trim().slice(0, maxLength);
  return clean || null;
}

function numberValue(value: unknown) {
  const number =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : NaN;
  return Number.isFinite(number) ? number : null;
}

function dateValue(value: unknown) {
  const clean = textValue(value, 32);
  return clean &&
    /^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?$/.test(clean)
    ? clean
    : null;
}

function evidenceValue(value: unknown): AiEvidence[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 20).flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const pageNumber = Math.max(
      1,
      Math.round(
        numberValue((item as Record<string, unknown>).pageNumber) || 1,
      ),
    );
    const quote = textValue((item as Record<string, unknown>).quote, 500);
    return quote ? [{ pageNumber, quote }] : [];
  });
}

function factEvidence(row: Record<string, unknown>) {
  const evidence = evidenceValue(row.evidence);
  const pageNumber = numberValue(row.p);
  const quote = textValue(row.q, 500);
  if (!evidence.length && pageNumber !== null && pageNumber > 0 && quote) {
    evidence.push({ pageNumber: Math.round(pageNumber), quote });
  }
  return evidence;
}

function booleanValue(value: unknown) {
  if (value === true || value === 1 || value === "1") return true;
  if (typeof value === "string")
    return ["true", "yes", "是", "主要"].includes(value.trim().toLowerCase());
  return false;
}

function normalizeDiagnosis(value: unknown): AiDiagnosis | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const diagnosisText = textValue(row.diagnosisText ?? row.text ?? row.n, 500);
  if (!diagnosisText) return null;
  const rawType =
    textValue(row.diagnosisType ?? row.type ?? row.t, 40) || "other";
  return {
    sectionName: textValue(row.sectionName ?? row.s, 200),
    diagnosisType: diagnosisTypes.has(rawType)
      ? (rawType as AiDiagnosis["diagnosisType"])
      : "other",
    diagnosisText,
    diagnosisCode: textValue(row.diagnosisCode ?? row.code ?? row.c, 100),
    codeSystem: textValue(row.codeSystem ?? row.cs, 80),
    isPrimary: booleanValue(row.isPrimary ?? row.primary),
    evidence: factEvidence(row),
  };
}

function normalizeMedication(value: unknown): AiMedication | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const medicationName = textValue(
    row.medicationName ?? row.name ?? row.n,
    300,
  );
  if (!medicationName) return null;
  const rawContext = textValue(row.context ?? row.t, 40) || "other";
  return {
    sectionName: textValue(row.sectionName ?? row.s, 200),
    context: medicationContexts.has(rawContext)
      ? (rawContext as AiMedication["context"])
      : "other",
    medicationName,
    genericName: textValue(row.genericName ?? row.g, 300),
    specification: textValue(row.specification ?? row.spec, 200),
    dosageForm: textValue(row.dosageForm ?? row.form, 100),
    dose: textValue(row.dose, 100),
    doseUnit: textValue(row.doseUnit ?? row.du, 80),
    frequency: textValue(row.frequency ?? row.freq, 100),
    route: textValue(row.route, 100),
    duration: textValue(row.duration, 100),
    quantity: textValue(row.quantity ?? row.qty, 100),
    quantityUnit: textValue(row.quantityUnit ?? row.qu, 80),
    instructions: textValue(row.instructions ?? row.note, 500),
    evidence: factEvidence(row),
  };
}

function normalizeProcedure(value: unknown): AiProcedure | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const procedureName = textValue(row.procedureName ?? row.name ?? row.n, 300);
  if (!procedureName) return null;
  const rawType =
    textValue(row.procedureType ?? row.type ?? row.t, 40) || "other";
  return {
    sectionName: textValue(row.sectionName ?? row.s, 200),
    procedureType: procedureTypes.has(rawType)
      ? (rawType as AiProcedure["procedureType"])
      : "other",
    procedureName,
    procedureCode: textValue(row.procedureCode ?? row.code ?? row.c, 100),
    bodyPart: textValue(row.bodyPart ?? row.part, 200),
    performedAt: dateValue(row.performedAt ?? row.date),
    resultText: textValue(row.resultText ?? row.result, 1000),
    evidence: factEvidence(row),
  };
}

function normalizeVaccination(value: unknown): AiVaccination | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const vaccineName = textValue(row.vaccineName ?? row.name ?? row.n, 300);
  if (!vaccineName) return null;
  return {
    vaccineName,
    doseNumber: textValue(row.doseNumber ?? row.dose, 80),
    manufacturer: textValue(row.manufacturer ?? row.mfr, 300),
    lotNumber: textValue(row.lotNumber ?? row.lot, 120),
    administeredAt: dateValue(row.administeredAt ?? row.date),
    administrationSite: textValue(row.administrationSite ?? row.site, 120),
    nextDueAt: dateValue(row.nextDueAt ?? row.nextDate),
    evidence: factEvidence(row),
  };
}

function normalizeBillingSummary(value: unknown): AiBillingSummary | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const summary = {
    invoiceNumber: textValue(row.invoiceNumber ?? row.invoiceNo, 120),
    totalAmount: numberValue(row.totalAmount ?? row.total),
    insuranceAmount: numberValue(row.insuranceAmount ?? row.insurance),
    selfPayAmount: numberValue(row.selfPayAmount ?? row.selfPay),
    currency: textValue(row.currency, 20) || "CNY",
    evidence: factEvidence(row),
  };
  return summary.invoiceNumber ||
    summary.totalAmount !== null ||
    summary.insuranceAmount !== null ||
    summary.selfPayAmount !== null
    ? summary
    : null;
}

function normalizeBillingItem(value: unknown): AiBillingItem | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const itemName = textValue(row.itemName ?? row.name ?? row.n, 300);
  if (!itemName) return null;
  return {
    category: textValue(row.category ?? row.cat, 120),
    itemName,
    amount: numberValue(row.amount ?? row.a),
    quantity: numberValue(row.quantity ?? row.qty),
    evidence: factEvidence(row),
  };
}

function boundedNumber(value: unknown, minimum: number, maximum: number) {
  const number = numberValue(value);
  return number === null ? null : Math.min(maximum, Math.max(minimum, number));
}

function morphologyStringMap(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, 24)
      .flatMap(([key, item]) => {
        const cleanKey = textValue(key, 80);
        const cleanValue = textValue(item, 300);
        return cleanKey && cleanValue ? [[cleanKey, cleanValue]] : [];
      }),
  );
}

function inferMorphologyType(value: string) {
  const match = value.match(
    /囊肿|结节|斑块|息肉|结石|钙化灶?|占位|肿块|包块|团块|积液|增生|萎缩|狭窄|扩张|卵泡|脂肪肝|磨玻璃影|病灶|淋巴结/,
  );
  return match?.[0] || "形态发现";
}

function inferMorphologyOrgan(value: string) {
  const match = value.match(
    /甲状腺|乳腺|肝脏|肝左叶|肝右叶|胆囊|胆管|胰腺|脾脏|左肾|右肾|双肾|肾脏|膀胱|前列腺|子宫|左侧卵巢|右侧卵巢|卵巢|肺部|左肺|右肺|心脏|颈动脉|锁骨下动脉|淋巴结/,
  );
  return match?.[0] || null;
}

export function morphologySizeFromText(value: string) {
  const normalized = value.normalize("NFKC");
  const dimensions = normalized.match(
    /(\d+(?:\.\d+)?)\s*[×xX*]\s*(\d+(?:\.\d+)?)(?:\s*[×xX*]\s*(\d+(?:\.\d+)?))?\s*(mm|cm|m)\b/i,
  );
  if (dimensions) {
    return {
      length: Number(dimensions[1]),
      width: Number(dimensions[2]),
      height: dimensions[3] ? Number(dimensions[3]) : null,
      unit: dimensions[4].toLowerCase(),
    };
  }
  /* 单值尺寸只接受明确的尺寸标签，避免把“距皮肤 5 mm”等位置信息误当病灶大小。 */
  const diameter = normalized.match(
    /(?:直径|长径|短径|厚度|内径|大小)[^\d]{0,8}(\d+(?:\.\d+)?)\s*(mm|cm|m)\b/i,
  );
  if (!diameter)
    return { length: null, width: null, height: null, unit: null };
  return {
    length: Number(diameter[1]),
    width: null,
    height: null,
    unit: diameter[2].toLowerCase(),
  };
}

function morphologySizeSourceMatchesFinding(
  source: string,
  findingName: string,
  findingType: string | null,
) {
  if (!morphologySizeFromText(source).unit) return false;
  const findingText = `${findingType || ""} ${findingName}`;
  /* 脂肪肝属于弥漫性结论，不应从同一复合描述中的局灶病灶继承尺寸。 */
  if (/脂肪肝/.test(findingText)) return false;
  const directTypes = [
    "囊肿",
    "结节",
    "斑块",
    "息肉",
    "结石",
    "钙化",
    "占位",
    "肿块",
    "包块",
    "团块",
    "积液",
    "增生",
    "萎缩",
    "狭窄",
    "扩张",
    "卵泡",
    "脂肪肝",
    "磨玻璃影",
    "淋巴结",
  ];
  if (
    directTypes.some(
      (type) => findingText.includes(type) && source.includes(type),
    )
  )
    return true;
  return /钙化/.test(findingText) && /(?:强|高)回声(?:区|灶)/.test(source);
}

function isLikelyMorphologyObservation(observation: AiObservation) {
  const text = `${observation.sectionName || ""} ${observation.itemName} ${observation.resultText}`;
  return /(囊肿|结节|斑块|息肉|结石|钙化灶?|占位|肿块|包块|团块|积液|增生|萎缩|狭窄|扩张|卵泡|脂肪肝|磨玻璃影|病灶|血流信号|淋巴结)/.test(
    text,
  );
}

function morphologyFromObservation(
  observation: AiObservation,
): AiMorphologyFinding {
  const rawText =
    observation.evidence[0]?.quote ||
    [observation.itemName, observation.resultText].filter(Boolean).join("：");
  return {
    sectionName: observation.sectionName,
    organ: inferMorphologyOrgan(
      `${observation.itemName} ${observation.resultText}`,
    ),
    region: null,
    laterality: /双侧|双肾|双乳/.test(rawText)
      ? "bilateral"
      : /左侧|左叶|左肺|左肾|左乳/.test(rawText)
        ? "left"
        : /右侧|右叶|右肺|右肾|右乳/.test(rawText)
          ? "right"
          : "unspecified",
    findingType: inferMorphologyType(
      `${observation.itemName} ${observation.resultText}`,
    ),
    findingName: observation.itemName,
    presence: /未见|未发现|无明显/.test(observation.resultText)
      ? "absent"
      : "present",
    findingCount: null,
    size: morphologySizeFromText(observation.resultText),
    measurements: [],
    morphology: observation.resultText,
    attributes: {},
    classification: null,
    comparisonText: null,
    rawText,
    evidence: observation.evidence,
    confidence: null,
  };
}

function morphologyFindingValue(value: unknown): AiMorphologyFinding | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const organ = textValue(row.organ, 120);
  const findingType = textValue(row.findingType, 120);
  const morphology = textValue(row.morphology, 2000);
  const rawText = textValue(row.rawText, 3000);
  const evidence = evidenceValue(row.evidence);
  const findingName =
    textValue(row.findingName, 200) ||
    [organ, findingType].filter(Boolean).join("");
  if (!findingName || !(rawText || morphology || evidence.length)) return null;
  const rawSize =
    row.size && typeof row.size === "object" && !Array.isArray(row.size)
      ? (row.size as Record<string, unknown>)
      : {};
  const rawClassification =
    row.classification &&
    typeof row.classification === "object" &&
    !Array.isArray(row.classification)
      ? (row.classification as Record<string, unknown>)
      : null;
  const measurements = Array.isArray(row.measurements)
    ? row.measurements.slice(0, 24).flatMap((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return [];
        const measurement = item as Record<string, unknown>;
        const key = textValue(measurement.key, 120);
        const numericValue = numberValue(measurement.value);
        if (!key || numericValue === null) return [];
        return [
          { key, value: numericValue, unit: textValue(measurement.unit, 40) },
        ];
      })
    : [];
  const laterality = textValue(row.laterality, 20) || "unspecified";
  const presence = textValue(row.presence, 20) || "present";
  const size = {
    length: numberValue(rawSize.length),
    width: numberValue(rawSize.width),
    height: numberValue(rawSize.height),
    unit: textValue(rawSize.unit, 40),
  };
  const fallbackSizeSource = [
    rawText,
    morphology,
    ...evidence.map((entry) => entry.quote),
  ].find(
    (source): source is string =>
      Boolean(source) &&
      morphologySizeSourceMatchesFinding(source!, findingName, findingType),
  );
  const fallbackSize = morphologySizeFromText(fallbackSizeSource || "");
  const fallbackMeasurements =
    fallbackSize.length !== null && fallbackSize.unit
      ? [
          {
            key:
              fallbackSize.width === null && fallbackSize.height === null
                ? fallbackSizeSource?.match(
                    /(直径|长径|短径|厚度|内径|大小)[^\d]{0,8}\d+(?:\.\d+)?\s*(?:mm|cm|m)\b/i,
                  )?.[1] || "大小"
                : "大小",
            value: fallbackSize.length,
            unit: fallbackSize.unit,
          },
        ]
      : [];
  return {
    sectionName: textValue(row.sectionName, 200),
    organ,
    region: textValue(row.region, 120),
    laterality: morphologyLateralityValues.has(laterality)
      ? (laterality as AiMorphologyFinding["laterality"])
      : "unspecified",
    findingType: findingType || inferMorphologyType(findingName),
    findingName,
    presence: morphologyPresenceValues.has(presence)
      ? (presence as AiMorphologyFinding["presence"])
      : "present",
    findingCount:
      numberValue(row.findingCount) === null
        ? null
        : Math.max(0, Math.round(numberValue(row.findingCount)!)),
    size: {
      length: size.length ?? fallbackSize.length,
      width: size.width ?? fallbackSize.width,
      height: size.height ?? fallbackSize.height,
      unit: size.unit || fallbackSize.unit,
    },
    measurements: measurements.length ? measurements : fallbackMeasurements,
    morphology,
    attributes: morphologyStringMap(row.attributes),
    classification: rawClassification
      ? {
          system: textValue(rawClassification.system, 80),
          value: textValue(rawClassification.value, 80),
          text: textValue(rawClassification.text, 200),
        }
      : null,
    comparisonText: textValue(row.comparisonText, 1000),
    rawText: rawText || evidence[0]?.quote || morphology || findingName,
    evidence,
    confidence: boundedNumber(row.confidence, 0, 1),
  };
}

function objectStrings(value: unknown, allowedKeys: Set<string>) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, item]) => {
      if (!allowedKeys.has(key)) return [];
      const clean = textValue(item, 200);
      return clean ? [[key, clean]] : [];
    }),
  );
}

function normalizeReportStructuredSection(
  value: unknown,
): AiReportStructuredSection | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const sectionKey = textValue(row.sectionKey, 80);
  if (!sectionKey || !structuredSectionKeys.has(sectionKey)) return null;
  const content = textValue(row.content, 20_000);
  if (!content) return null;
  const evidence = evidenceValue(row.evidence);
  const compactPageNumber = numberValue(row.p);
  const compactQuote = textValue(row.q, 500);
  if (
    !evidence.length &&
    compactPageNumber !== null &&
    compactPageNumber > 0 &&
    compactQuote
  ) {
    evidence.push({
      pageNumber: Math.round(compactPageNumber),
      quote: compactQuote,
    });
  }
  const key = sectionKey as ReportStructuredSectionKey;
  return {
    sectionKey: key,
    title: reportStructuredSectionLabels[key],
    content,
    evidence,
  };
}

function metadataTokenKey(value: string | null | undefined) {
  return (
    value
      ?.normalize("NFKC")
      .trim()
      .toLowerCase()
      .replace(/[\s_-]+/g, "") || ""
  );
}

function meaningfulReportMetadata(value: string | null | undefined) {
  if (!value || internalReportMetadataTokens.has(metadataTokenKey(value)))
    return null;
  return value;
}

export function normalizeAiExtraction(value: unknown): {
  fields: AiExtractionFields;
  evidence: Record<string, AiEvidence[]>;
  confidence: Record<string, number>;
} {
  const source =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const rawType = textValue(source.reportType, 40);
  const reportType = rawType ? reportTypeAliases[rawType] || null : null;
  const bodyParts = Array.isArray(source.bodyParts)
    ? source.bodyParts.slice(0, 20).flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const row = item as Record<string, unknown>;
        const raw = meaningfulReportMetadata(textValue(row.raw, 120));
        const name = meaningfulReportMetadata(textValue(row.name, 120)) || raw;
        if (!name) return [];
        const laterality = textValue(row.laterality, 20) || "unspecified";
        return [
          {
            raw: raw || name,
            name,
            parent: meaningfulReportMetadata(textValue(row.parent, 120)),
            laterality: lateralityValues.has(laterality)
              ? laterality
              : "unspecified",
          },
        ];
      })
    : [];
  const observationCandidates = Array.isArray(source.observations)
    ? source.observations.flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const row = item as Record<string, unknown>;
        const itemName = textValue(row.itemName ?? row.n, 200);
        const resultText = textValue(row.resultText ?? row.r, 500);
        if (!itemName || !resultText) return [];
        const flag = textValue(row.abnormalFlag ?? row.f, 20);
        const evidence = evidenceValue(row.evidence);
        const compactPageNumber = numberValue(row.p);
        const compactQuote = textValue(row.q, 500);
        if (
          !evidence.length &&
          compactPageNumber !== null &&
          compactPageNumber > 0 &&
          compactQuote
        ) {
          evidence.push({
            pageNumber: Math.round(compactPageNumber),
            quote: compactQuote,
          });
        }
        const parsedFlag =
          flag && abnormalFlags.has(flag)
            ? (flag as AiObservation["abnormalFlag"])
            : null;
        return [
          {
            sectionName: textValue(row.sectionName ?? row.s, 200),
            itemCode: textValue(row.itemCode ?? row.c, 100),
            itemName,
            normalizedName: textValue(row.normalizedName, 200),
            resultText,
            numericValue: numberValue(row.numericValue ?? row.v),
            unit: textValue(row.unit ?? row.u, 80),
            referenceLow: numberValue(row.referenceLow ?? row.lo),
            referenceHigh: numberValue(row.referenceHigh ?? row.hi),
            referenceText: textValue(row.referenceText ?? row.ref, 300),
            abnormalFlag:
              parsedFlag ||
              inferObservationAbnormalFlag({
                resultText,
                supportingText: evidence.map((entry) => entry.quote),
              }),
            method: textValue(row.method ?? row.m, 200),
            evidence,
          },
        ];
      })
    : [];
  const explicitMorphologyFindings = Array.isArray(source.morphologyFindings)
    ? source.morphologyFindings.flatMap((item) => {
        const finding = morphologyFindingValue(item);
        return finding ? [finding] : [];
      })
    : [];
  const observations = observationCandidates.filter(
    (item) => !isLikelyMorphologyObservation(item),
  );
  const morphologyFindings = [
    ...explicitMorphologyFindings,
    ...observationCandidates
      .filter(isLikelyMorphologyObservation)
      .map(morphologyFromObservation),
  ]
    .filter(isTrackableMorphologyFinding)
    .filter((item, index, list) => {
      const key = [
        item.sectionName,
        item.organ,
        item.region,
        item.laterality,
        item.findingType,
        item.findingName,
        item.rawText,
      ]
        .join("\u0000")
        .toLocaleLowerCase("zh-CN");
      return (
        list.findIndex(
          (candidate) =>
            [
              candidate.sectionName,
              candidate.organ,
              candidate.region,
              candidate.laterality,
              candidate.findingType,
              candidate.findingName,
              candidate.rawText,
            ]
              .join("\u0000")
              .toLocaleLowerCase("zh-CN") === key,
        ) === index
      );
    });
  const diagnoses = Array.isArray(source.diagnoses)
    ? source.diagnoses.flatMap((item) => {
        const diagnosis = normalizeDiagnosis(item);
        return diagnosis ? [diagnosis] : [];
      })
    : [];
  const medications = Array.isArray(source.medications)
    ? source.medications.flatMap((item) => {
        const medication = normalizeMedication(item);
        return medication ? [medication] : [];
      })
    : [];
  const procedures = Array.isArray(source.procedures)
    ? source.procedures.flatMap((item) => {
        const procedure = normalizeProcedure(item);
        return procedure ? [procedure] : [];
      })
    : [];
  const vaccinations = Array.isArray(source.vaccinations)
    ? source.vaccinations.flatMap((item) => {
        const vaccination = normalizeVaccination(item);
        return vaccination ? [vaccination] : [];
      })
    : [];
  const billing =
    source.billing &&
    typeof source.billing === "object" &&
    !Array.isArray(source.billing)
      ? (source.billing as Record<string, unknown>)
      : {};
  const billingSummary = normalizeBillingSummary(
    source.billingSummary ?? billing.summary,
  );
  const rawBillingItems = Array.isArray(source.billingItems)
    ? source.billingItems
    : Array.isArray(billing.items)
      ? billing.items
      : [];
  const billingItems = rawBillingItems.flatMap((item) => {
    const billingItem = normalizeBillingItem(item);
    return billingItem ? [billingItem] : [];
  });
  const reportSections = Array.isArray(source.reportSections)
    ? source.reportSections.flatMap((item) => {
        const section = normalizeReportStructuredSection(item);
        return section ? [section] : [];
      })
    : [];
  const rawEvidence =
    source.evidence &&
    typeof source.evidence === "object" &&
    !Array.isArray(source.evidence)
      ? (source.evidence as Record<string, unknown>)
      : {};
  const evidence = Object.fromEntries(
    Object.entries(rawEvidence).flatMap(([key, item]) => {
      const entries = evidenceValue(item);
      return entries.length ? [[key.slice(0, 100), entries]] : [];
    }),
  );
  const rawConfidence =
    source.confidence &&
    typeof source.confidence === "object" &&
    !Array.isArray(source.confidence)
      ? (source.confidence as Record<string, unknown>)
      : {};
  const confidence = Object.fromEntries(
    Object.entries(rawConfidence).flatMap(([key, item]) => {
      const number = numberValue(item);
      return number === null
        ? []
        : [[key.slice(0, 100), Math.max(0, Math.min(1, number))]];
    }),
  );

  const fields: AiExtractionFields = {
    reportType,
    reportSubtype: meaningfulReportMetadata(
      textValue(source.reportSubtype, 120),
    ),
    title: textValue(source.title, 200),
    hospitalNameRaw: textValue(source.hospitalNameRaw, 300),
    hospitalBranch: textValue(source.hospitalBranch, 200),
    city: textValue(source.city, 120),
    visitType: textValue(source.visitType, 80),
    visitDepartment: textValue(source.visitDepartment, 200),
    orderingDepartment: textValue(source.orderingDepartment, 200),
    performingDepartment: textValue(source.performingDepartment, 200),
    reportingDepartment: textValue(source.reportingDepartment, 200),
    inpatientWard: textValue(source.inpatientWard, 200),
    bodyParts,
    identifiers: objectStrings(source.identifiers, identifierKeys),
    reportIssuedAt: dateValue(source.reportIssuedAt),
    examinedAt: dateValue(source.examinedAt),
    orderedAt: dateValue(source.orderedAt),
    sampledAt: dateValue(source.sampledAt),
    receivedAt: dateValue(source.receivedAt),
    reviewedAt: dateValue(source.reviewedAt),
    admittedAt: dateValue(source.admittedAt),
    dischargedAt: dateValue(source.dischargedAt),
    clinicians: objectStrings(source.clinicians, clinicianKeys),
    clinicalDiagnosis: textValue(source.clinicalDiagnosis),
    purpose: textValue(source.purpose),
    chiefComplaint: textValue(source.chiefComplaint),
    findings: textValue(source.findings, 12_000),
    impression: textValue(source.impression, 8000),
    summary: textValue(source.summary, 4000),
    recommendation: textValue(source.recommendation, 4000),
    observations,
    morphologyFindings,
    diagnoses,
    medications,
    procedures,
    vaccinations,
    billingSummary,
    billingItems,
    reportSections,
  };
  if (!fields.bodyParts.length)
    fields.bodyParts = inferDisplayBodyParts(fields);
  return { fields, evidence, confidence };
}

export function isAiExtractionConfigured() {
  const settings = getAiTaskSettings("report_extraction", true);
  return (
    settings.enabled &&
    Boolean(settings.model && settings.baseUrl) &&
    (!aiProviderHasRequiredApiKey(settings.provider) || Boolean(settings.apiKey))
  );
}

function compactParts(parts: Array<string | null | undefined>) {
  return parts
    .map((part) => part?.replace(/\s+/g, " ").trim())
    .filter((part): part is string => Boolean(part));
}

function primaryDepartment(fields: AiExtractionFields) {
  return (
    fields.visitDepartment ||
    fields.reportingDepartment ||
    fields.performingDepartment ||
    fields.orderingDepartment
  );
}

function primaryBodyPart(fields: AiExtractionFields) {
  return fields.bodyParts[0]?.name || fields.bodyParts[0]?.raw || null;
}

function primaryObservationName(fields: AiExtractionFields) {
  const names = fields.observations
    .map((item) => item.normalizedName || item.itemName)
    .filter((name, index, list) => name && list.indexOf(name) === index)
    .slice(0, 3);
  if (!names.length) return null;
  return names.length > 2
    ? `${names.slice(0, 2).join("、")}等`
    : names.join("、");
}

function primaryMedicationName(fields: AiExtractionFields) {
  const names = fields.medications
    .map((item) => item.medicationName)
    .filter((name, index, list) => name && list.indexOf(name) === index);
  if (!names.length) return null;
  return names.length > 1 ? `${names[0]}等` : names[0];
}

function primaryVaccinationName(fields: AiExtractionFields) {
  const names = fields.vaccinations
    .map((item) => item.vaccineName)
    .filter((name, index, list) => name && list.indexOf(name) === index);
  if (!names.length) return null;
  return names.length > 1 ? `${names[0]}等` : names[0];
}

function primarySectionName(fields: AiExtractionFields) {
  const sections = fields.observations
    .map((item) => item.sectionName?.replace(/\s+/g, "").trim())
    .filter((name): name is string =>
      Boolean(name && !["检验", "检查", "项目", "检验项目"].includes(name)),
    )
    .filter((name, index, list) => list.indexOf(name) === index)
    .slice(0, 2);
  return sections.length === 1 ? sections[0] : null;
}

function genericTitleKey(value: string) {
  return value
    .normalize("NFKC")
    .replace(/\s+/g, "")
    .replace(/[：:，,。.;；、_\-]/g, "");
}

export function isGenericReportTitle(value: string | null | undefined) {
  if (!value) return true;
  const key = genericTitleKey(value);
  return new Set([
    "报告",
    "报告单",
    "检查报告",
    "检查报告单",
    "检验报告",
    "检验报告单",
    "化验报告",
    "化验报告单",
    "医学检验报告单",
    "医学检验报告",
    "门诊检验报告单",
    "门诊检验报告",
    "住院检验报告单",
    "体检报告",
    "健康体检报告",
    "影像报告",
    "影像检查报告",
    "放射报告",
    "超声报告",
    "病理报告",
    "门诊病历",
    "门诊记录",
    "住院记录",
    "出院记录",
    "处方",
    "处方笺",
    "收费票据",
    "医疗票据",
  ]).has(key);
}

function bodyPart(raw: string) {
  return [{ raw, name: raw, parent: null, laterality: "unspecified" }];
}

export function inferDisplayBodyParts(fields: AiExtractionFields) {
  const subtype = meaningfulReportMetadata(fields.reportSubtype);
  const department = primaryDepartment(fields);
  const section = primarySectionName(fields);
  const observation = primaryObservationName(fields);
  switch (fields.reportType) {
    case "checkup":
      return bodyPart(subtype || "综合体检");
    case "laboratory":
      return bodyPart(subtype || section || observation || "检验项目");
    case "imaging":
      return subtype ? bodyPart(subtype) : [];
    case "functional":
      return bodyPart(primaryBodyPart(fields) || subtype || "功能检查");
    case "pathology":
      return bodyPart(primaryBodyPart(fields) || subtype || "病理标本");
    case "outpatient":
      return bodyPart(department || "门诊");
    case "inpatient":
      return bodyPart(fields.inpatientWard || department || "住院");
    case "prescription":
      return bodyPart("用药");
    case "billing":
      return bodyPart("费用");
    case "vaccination":
      return bodyPart(observation || "疫苗接种");
    default:
      return subtype ? bodyPart(subtype) : [];
  }
}

function reportTypeLabel(fields: AiExtractionFields) {
  const bodyPart = primaryBodyPart(fields);
  const department = primaryDepartment(fields);
  const subtype = meaningfulReportMetadata(fields.reportSubtype);
  const section = primarySectionName(fields);
  const observation = primaryObservationName(fields);
  switch (fields.reportType) {
    case "checkup":
      return compactParts([subtype || "综合", "体检报告"]).join("");
    case "laboratory": {
      const subject = subtype || section || observation;
      if (subject && /(检验|检查|报告)$/.test(subject))
        return `${subject}报告`.replace(/报告报告$/, "报告");
      return compactParts([subject, "检验报告"]).join("");
    }
    case "imaging":
      return compactParts([bodyPart, subtype || "影像", "报告"]).join("");
    case "functional":
      return compactParts([bodyPart || subtype, "功能检查报告"]).join("");
    case "pathology":
      return compactParts([bodyPart, "病理报告"]).join("");
    case "outpatient":
      return compactParts([department, "门诊记录"]).join("");
    case "inpatient":
      return compactParts([
        fields.inpatientWard || department,
        "住院记录",
      ]).join("");
    case "prescription":
      return compactParts([
        primaryMedicationName(fields) || department,
        "处方",
      ]).join("");
    case "billing":
      return "医疗票据";
    case "vaccination":
      return compactParts([
        primaryVaccinationName(fields) || observation,
        "接种记录",
      ]).join("");
    default:
      return subtype || fields.title || "健康报告";
  }
}

export function buildReportTitle(fields: AiExtractionFields) {
  const generated = reportTypeLabel(fields);
  const title = !isGenericReportTitle(fields.title) ? fields.title : generated;
  return (title || "健康报告").slice(0, 80);
}

export function buildAiExtractionInput(reportId: string): AiExtractionInput {
  const plan = buildAiExtractionPlan(reportId);
  const sourceText = plan.pages.map((page) => page.text).join("\n\n");
  const text = sourceText.slice(0, maxInputCharacters);
  return {
    reportId,
    text,
    inputCharacters: text.length,
    pageCount: plan.pageCount,
    planHash: plan.planHash,
    plannedUnits: plan.unitCount,
    sourceInputCharacters: sourceText.length,
    compatibilityTruncated: sourceText.length > text.length,
  };
}

function commonSystemPrompt() {
  return `你是健康报告结构化助手。只能提取输入中明确出现的事实，不得诊断、推测风险、解释病情或给出治疗建议。
只返回一个可被 JSON.parse 解析的 JSON 对象，不要 Markdown、注释或前后说明。日期统一为 YYYY-MM-DD 或 YYYY-MM-DD HH:mm:ss。
不得输出姓名、身份证号、电话、住址或其他已过滤个资。缺失字段直接省略，不输出 null、空字符串或无值占位。证据必须来自当前输入，p 为页码，q 为最长 160 字的最短可定位原文。`;
}

function documentContract(input: AiExtractionInput) {
  const includeObservations = Boolean(input.candidateCount);
  const checkupFields =
    input.documentContentType === "checkup"
      ? `\n综合体检通常跨多个科室和部位：没有报告原文明示的单一就诊科室时省略科室字段；reportSubtype 默认省略，只有报告标题明确写出职业体检等具体子类时才填原文；bodyParts 默认省略，不能把“体检”或各专项章节汇总成一个人体部位。`
      : "";
  return `当前任务只建立整份报告的文档概况。
允许字段：reportType、reportSubtype、title、hospitalNameRaw、hospitalBranch、city、visitType、visitDepartment、orderingDepartment、performingDepartment、reportingDepartment、inpatientWard、bodyParts、identifiers、reportIssuedAt、examinedAt、orderedAt、sampledAt、receivedAt、reviewedAt、admittedAt、dischargedAt、clinicians、clinicalDiagnosis、purpose、chiefComplaint、findings、impression、summary、recommendation、evidence、confidence${includeObservations ? "、observations" : ""}。
reportType 只能是 physical_exam、laboratory、imaging、functional、pathology、outpatient、inpatient、prescription、receipt、vaccine、other。
title 必须概括整份报告；泛标题应按主要项目、检查方式、部位或报告范围生成短标题，但不得生成疾病判断标题。综合体检中的专项页不能覆盖整份报告标题。
reportSubtype 只能填写报告上明确出现的具体检查方式或子类，不得重复 reportType 的枚举值。bodyParts 只能填写报告明确涉及的实际检查部位，不得填写 physical_exam、checkup、laboratory、imaging 等内部类型词；每项使用 raw、name、parent、laterality，laterality 只能是 left、right、bilateral、unspecified。identifiers 只允许 reportNo、outpatientNo、inpatientNo、physicalExamNo、examNo、specimenNo、barcodeNo。clinicians 只允许 ordering、examining、reporting、reviewing、chief。
summary 只能提取原报告明确存在的总结，不得为当前输入另写摘要。公共字段证据写入顶层 evidence，置信度写入 confidence。${checkupFields}${includeObservations ? `\n这是单页报告，同时逐项输出 observations，规则如下：\n${observationContract()}` : ""}`;
}

function observationContract() {
  return `只输出 observations。每项必填 n（原项目名）、r（原结果文本）、p、q；可选 s（最近章节）、c、v、u、lo、hi、ref、f、m。f 只能是 high、low、abnormal、normal。禁止输出 normalizedName。
严格按表头解释本次结果、单位、参考值和历史结果。本次结果为“-”“±”或阴阳性时必须原样保留，不得把参考值或历史值作为本次结果。历史章节和历史列不得输出。
项目名只能来自“项目/名称”列或当前行开头；本次结果列中的文字（包括“右侧外耳道耵聍堵塞”这类异常发现描述）就是结果文本，不得把结果文本提升为项目名后再从其他列另找结果。
只提取单值定量或定性指标。囊肿、结节、斑块、息肉、结石、占位、积液、器官形态、回声、密度、边界、血流及影像分级不得进入 observations。
一般检查中的身高、体重、BMI、腰围、臀围、脉搏和血压逐项输出；120/80 mmHg 拆成收缩压和舒张压，不得推算报告未写出的数据。异常标记只取本次结果旁的原报告标记。`;
}

function morphologyContract() {
  return `当前任务只输出 morphologyFindings。
每项表示一个可独立命名、可跨报告追踪的具体形态发现，字段包括 sectionName、organ、region、laterality、findingType、findingName、presence、findingCount、size、measurements、morphology、attributes、classification、comparisonText、rawText、evidence、confidence。
organ、findingType、findingName、presence、rawText、evidence 必须有明确原文。laterality 只能是 left、right、bilateral、midline、unspecified；presence 只能是 present、absent、uncertain。
size 只使用原文明确的 length、width、height、unit；measurements 每项使用 key、value、unit；classification 只保存原文明确的分级系统和值。不得判断良恶性或生成变化结论。
检查标题、占位名称、一般正常描述、检查方法和建议不得作为形态发现。presence=absent 仅限原文点名具体对象，例如“未见甲状腺结节”。
同一报告中的“异常汇总/总检结论”“超声提示/影像结论”和“检查所见/超声描述”可能重复同一发现：只输出一个 finding，结论文本用于标准化 findingName、findingType，并将“轻度”等原文程度写入 attributes，明细文本用于补充 region、size、measurements、morphology 和 attributes，evidence 合并保留各处原文。明确已有“脂肪肝”等诊断提示时，不得再把对应的“实质回声稍增强”等描述建立为第二个泛化 finding；不同器官、不同侧别、明确不同病灶或互不相容的尺寸仍须分开。
不得把一行阳性发现与后续其他器官的“未见异常/未见占位”负性结论合成一个 finding。没有符合项时返回 {"morphologyFindings":[]}。`;
}

function verificationContract() {
  return `当前任务是所有主解析单元完成后的统一遗漏核对，只输出 observations 和 morphologyFindings。
输入已按“指标遗漏候选”或“形态发现遗漏候选”标明类型；必须逐行核对，不能把形态发现写入 observations，也不能把定量、定性指标写入 morphologyFindings。

指标规则：
${observationContract().replace(/^只输出 observations。/, "")}

形态发现规则：
${morphologyContract().replace(/^当前任务只输出 morphologyFindings。/, "")}`;
}

function effectiveContentTypes(input: AiExtractionInput) {
  const source = input.contentTypes?.length
    ? input.contentTypes
    : [input.primaryContentType || "other"];
  const unique = source.filter(
    (type, index, list) => list.indexOf(type) === index,
  );
  if (input.documentContentType !== "checkup") return unique.slice(0, 2);
  /*
   * Composite checkups commonly contain table labels such as 主诉、既往史 and
   * 体格检查. They are checkup items, not embedded outpatient/inpatient records.
   * Strongly typed laboratory/imaging/etc. component pages remain available.
   */
  return [
    "checkup",
    ...unique.filter(
      (type) => !["checkup", "outpatient", "inpatient"].includes(type),
    ),
  ].slice(0, 2) as ReportContentType[];
}

function narrativeContract(input: AiExtractionInput) {
  const types = new Set(effectiveContentTypes(input));
  const parts = [
    `当前任务只整理原报告叙事章节，不输出 observations、morphologyFindings 或文档概况字段。所有 content 必须忠实保留原文，不得概括或补写。`,
  ];
  if (types.has("checkup")) {
    parts.push(
      `体检可输出 reportSections，sectionKey 仅限 checkup_package、checkup_positive_findings、checkup_abnormal_summary、checkup_final_conclusion、checkup_original_recommendation。`,
    );
  }
  if (types.has("laboratory")) {
    parts.push(
      `检验可输出 reportSections，sectionKey 仅限 laboratory_specimen、laboratory_method。`,
    );
  }
  if (types.has("imaging")) {
    parts.push(
      `影像可输出 findings、impression，以及 sectionKey 为 imaging_modality、imaging_contrast 的 reportSections。`,
    );
  }
  if (types.has("functional")) {
    parts.push(
      `功能检查可输出 findings、impression，以及 sectionKey 为 functional_method、functional_description 的 reportSections。`,
    );
  }
  if (types.has("pathology")) {
    parts.push(
      `病理可输出 diagnoses（diagnosisType=pathology），以及 sectionKey 为 pathology_specimen、pathology_gross_findings、pathology_microscopic_findings、pathology_immunohistochemistry、pathology_grade、pathology_stage 的 reportSections。`,
    );
  }
  if (types.has("outpatient")) {
    parts.push(
      `门诊可输出 chiefComplaint、clinicalDiagnosis、diagnoses、medications、procedures，以及 sectionKey 为 outpatient_history、outpatient_physical_examination、outpatient_disposition、outpatient_advice 的 reportSections。`,
    );
  }
  if (types.has("inpatient")) {
    parts.push(
      `住院可输出 clinicalDiagnosis、diagnoses、medications、procedures，以及 sectionKey 为 inpatient_course、inpatient_discharge_instructions 的 reportSections。`,
    );
  }
  if (types.has("prescription")) parts.push(`处方只输出 medications。`);
  if (types.has("billing"))
    parts.push(
      `票据只输出 billingSummary、billingItems，金额必须来自原文，不得自行计算。`,
    );
  if (types.has("vaccination")) parts.push(`接种记录只输出 vaccinations。`);
  parts.push(
    `diagnoses 每项使用 diagnosisText、diagnosisType、diagnosisCode、codeSystem、isPrimary、sectionName、p、q；medications 使用 medicationName、genericName、specification、dosageForm、dose、doseUnit、frequency、route、duration、quantity、quantityUnit、instructions、context、sectionName、p、q；procedures 使用 procedureName、procedureType、procedureCode、bodyPart、performedAt、resultText、sectionName、p、q；reportSections 使用 sectionKey、title、content、p、q，title 只写对应类型的简短中文标题，不得抄录英文副标题或整行双语页眉。只返回当前类型允许且原文明示的数组。`,
  );
  return parts.join("\n");
}

const contentTypeLabels: Record<ReportContentType, string> = {
  checkup: "体检",
  laboratory: "检验",
  imaging: "影像",
  functional: "功能检查",
  pathology: "病理",
  outpatient: "门诊",
  inpatient: "住院",
  prescription: "处方",
  billing: "票据",
  vaccination: "疫苗",
  other: "其他",
};

const typePromptPlugins: Partial<Record<ReportContentType, string>> = {
  checkup: `体检内容：重点检查一般检查、基础测量、各科分项、阳性发现、总检结论和原报告建议。综合体检中的检验、影像、功能检查仍按其原始章节提取，不要把专项页标题当作整份报告标题。
各科查体表（耳鼻喉、眼科、口腔、内外科等）多为“项目 | 本次结果 | 参考值 | 历史结果”结构：项目列（如耳、鼻、口咽）是项目名，本次结果列原样作为结果（“未见异常”或异常发现描述均可），历史结果列不得输出。`,
  laboratory: `检验内容：逐行提取当前结果、单位、参考范围、异常标记、标本和检测方法。严格区分本次结果列与历史结果列；项目名必须来自当前行，不得用表头或参考项目代替。`,
  imaging: `影像内容：重点提取检查方式、真实部位、左右侧、增强信息、检查所见和影像结论。结节、囊肿、斑块、息肉、结石、积液、占位及明确异常形态只进入 morphologyFindings。`,
  functional: `功能检查内容：提取心电图、肺功能、骨密度、动脉功能、呼气试验等明确测量和原报告结论。单值测量进入 observations，可追踪形态发现进入 morphologyFindings。
肺功能多列表格只取“实测/本次结果”列；预测值、预计值、预计百分比、参考值和曲线坐标不得作为本次 observation。多列表格的 q 必须同时包含最近表头和当前数据行，以便核验列语义。设备质控或算法派生参数（例如 PEF TIME、FET、V EXTRAP、EXTRAP V、名称以 /HT 结尾的身高校正量、分段流量比、FEV0.5、FEF75-85、FEF200-1200、名称以 /VCpr 结尾的预测派生比例）不要进入 observations。单位只在当前行或可明确继承的表头出现时填写，不得猜测。`,
  pathology: `病理内容：提取标本、肉眼所见、镜下所见、免疫组化、病理诊断及原报告明确分级分期。不得自行推断良恶性、分级或分期。`,
  outpatient: `门诊内容：重点提取主诉、现病史、体格检查、门诊诊断、处置和医嘱。只保留原文事实，不补写疾病解释。`,
  inpatient: `住院内容：重点提取入院和出院时间、入出院诊断、手术操作、住院经过、出院用药及出院医嘱。不得把既往诊断改写成当前诊断。`,
  prescription: `处方内容：重点识别药品名称、规格、剂型、每次剂量、频次、给药途径、疗程、数量和原文用药说明，不得生成用药建议。`,
  billing: `票据内容：重点识别票据号、总额、医保支付、自费金额、费用分类和收费明细。金额必须来自原文，不得自行汇总缺失项目。`,
  vaccination: `疫苗内容：重点识别疫苗名称、剂次、生产厂家、批号、接种日期、接种部位和明确写出的下次接种日期。`,
};

function routedPrompt(input: AiExtractionInput) {
  const types = effectiveContentTypes(input);
  const plugins = types.flatMap((type) =>
    typePromptPlugins[type] ? [typePromptPlugins[type]!] : [],
  );
  const routeSummary =
    `\n服务端本地分类：当前单元为${types.map((type) => contentTypeLabels[type]).join("、")}内容` +
    `；整份文档主类型为${contentTypeLabels[input.documentContentType || input.primaryContentType || "other"]}` +
    `；分类只用于选择提取规则，你仍须以 OCR 原文为准。`;
  return `${routeSummary}${plugins.length ? `\n${plugins.join("\n")}` : ""}`;
}

export function promptForInput(input: AiExtractionInput) {
  const unitInstruction = `\n当前输入只是服务端规划的一个解析单元。只提取当前输入明确出现的事实；不得重复页眉页脚，不得判断或声明页面覆盖率，不得因为缺少报告其他页面而拒绝输出。`;
  const route =
    input.route ||
    (input.extractionMode === "morphology"
      ? "morphology"
      : input.allowDocumentFields
        ? "document"
        : "scalar");
  const routeInstruction =
    route === "document"
      ? documentContract(input)
      : route === "morphology"
        ? morphologyContract()
        : route === "verification"
          ? verificationContract()
          : route === "narrative"
            ? narrativeContract(input)
            : observationContract();
  const formatInstruction =
    input.promptMode === "json_retry"
      ? `\n上一次返回不是有效 JSON。本次必须只返回一个语法完整、可被 JSON.parse 解析的 JSON 对象，不要代码块、注释、前后说明或尾随逗号。`
      : "";
  const supplementInstruction =
    input.promptMode === "supplement"
      ? `\n当前输入是服务端遗漏检查产生的少量候选行。逐行检查并提取其中明确存在的定量、定性指标或形态发现；不要补写输入中没有的事实。`
      : "";
  return `${commonSystemPrompt()}${routedPrompt(input)}${unitInstruction}\n${routeInstruction}${formatInstruction}${supplementInstruction}`;
}

function parseJsonContent(content: string) {
  const clean = content
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  return JSON.parse(clean) as unknown;
}

export const requestAiExtraction: AiExecutor = async (input) => {
  const settings = getAiTaskSettings("report_extraction", true);
  if (!settings.enabled || !settings.model || !settings.baseUrl ||
      (aiProviderHasRequiredApiKey(settings.provider) && !settings.apiKey)) {
    throw Object.assign(new Error("AI 解析尚未完整配置"), {
      code: "AI_NOT_CONFIGURED",
    });
  }
  const timeoutMs = settings.requestTimeoutSeconds * 1_000;
  const userContent = redactAiInputText(input.text);
  const modelMaxOutputTokens = resolveAiMaxOutputTokens(settings.provider);
  const maxOutputTokens = calculateAiOutputTokenBudget(
    input,
    modelMaxOutputTokens,
  );
  const temperature = resolveAiTemperature(settings.provider, settings.model);
  const messages = [
    { role: "system" as const, content: promptForInput(input) },
    { role: "user" as const, content: userContent },
  ];
  const requestBody = buildAiChatCompletionRequestBody({
    provider: new URL(settings.baseUrl).host,
    providerKey: settings.provider,
    baseUrl: settings.baseUrl,
    apiKey: "",
    model: settings.model,
  }, {
    messages,
    temperature,
    responseFormat: "json_object",
    maxOutputTokens,
    timeoutMs,
  });
  await writeAiInputDebugLog({
    provider: new URL(settings.baseUrl).host,
    model: settings.model,
    promptVersion: aiExtractionPromptVersion,
    inputCharacters: input.inputCharacters,
    pageCount: input.pageCount,
    plannedUnits: input.plannedUnits,
    planHash: input.planHash,
    compatibilityTruncated: input.compatibilityTruncated,
    unitKey: input.unitKey,
    unitType: input.unitType,
    pageNumbers: input.pageNumbers,
    promptMode: input.promptMode,
    route: input.route,
    primaryContentType: input.primaryContentType,
    contentTypes: input.contentTypes,
    classificationConfidence: input.classificationConfidence,
    documentContentType: input.documentContentType,
    requestBody,
  });
  const response = await executeAiTask("report_extraction", {
    messages,
    temperature,
    responseFormat: "json_object",
    maxOutputTokens,
    timeoutMs,
    timeoutCode: "AI_REQUEST_TIMEOUT",
    timeoutMessage: `当前 AI 解析单元在 ${Math.round(timeoutMs / 1000)} 秒内未完成`,
    networkCode: "AI_NETWORK_ERROR",
    networkMessage: "无法连接 AI 服务，请检查 NAS 网络、服务地址和模型状态",
  });
  if (response.finishReason === "length") {
    throw Object.assign(
      new Error("AI 输出达到模型长度上限，当前解析单元需要缩小"),
      {
        code: "AI_OUTPUT_TRUNCATED",
        provider: response.provider,
        model: response.model,
        promptTokens: response.promptTokens,
        completionTokens: response.completionTokens,
        elapsedMs: response.elapsedMs,
        finishReason: "length",
        requestedMaxTokens: maxOutputTokens,
        modelMaxOutputTokens,
      },
    );
  }
  const content = response.content;
  if (!content)
    throw Object.assign(new Error("AI 服务未返回结构化内容"), {
      code: "AI_EMPTY_RESPONSE",
    });
  let parsed: unknown;
  try {
    parsed = parseJsonContent(content);
  } catch {
    throw Object.assign(new Error("AI 返回内容不是有效 JSON"), {
      code: "AI_INVALID_JSON",
    });
  }
  const normalized = normalizeAiExtraction(parsed);
  return {
    provider: response.provider,
    model: response.model,
    promptVersion: aiExtractionPromptVersion,
    ...normalized,
    rawResponseJson: JSON.stringify({
      ...normalized.fields,
      evidence: normalized.evidence,
      confidence: normalized.confidence,
    }),
    promptTokens: response.promptTokens,
    completionTokens: response.completionTokens,
    elapsedMs: response.elapsedMs,
  };
};

type ProtectedMorphologyRow = {
  id: string;
  organ: string | null;
  region: string | null;
  laterality: AiMorphologyFinding["laterality"];
  findingType: string;
  findingName: string;
  presence: AiMorphologyFinding["presence"];
  findingCount: number | null;
  sizeLength: number | null;
  sizeWidth: number | null;
  sizeHeight: number | null;
  sizeUnit: string | null;
  morphology: string | null;
  classificationSystem: string | null;
  classificationValue: string | null;
  classificationText: string | null;
  rawText: string;
  evidenceJson: string;
  trackingGroupId: string | null;
  matchConfidence: number | null;
  manualFieldsJson: string;
};

function protectedMorphologyRows(reportId: string) {
  return getDatabase()
    .prepare(
      `
    SELECT id, organ, region, laterality, finding_type AS findingType,
      finding_name AS findingName, presence, finding_count AS findingCount,
      size_length AS sizeLength, size_width AS sizeWidth, size_height AS sizeHeight,
      size_unit AS sizeUnit, morphology_text AS morphology,
      classification_system AS classificationSystem,
      classification_value AS classificationValue,
      classification_text AS classificationText, raw_text AS rawText,
      evidence_json AS evidenceJson, tracking_group_id AS trackingGroupId,
      match_confidence AS matchConfidence, manual_fields_json AS manualFieldsJson
    FROM morphology_findings
    WHERE report_id = ? AND json_array_length(manual_fields_json) > 0
  `,
    )
    .all(reportId) as ProtectedMorphologyRow[];
}

function compactMorphologyMatch(value: unknown) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[（）()，,。.:：;；、\s_-]+/g, "");
}

function evidenceKeys(value: string | AiMorphologyFinding["evidence"]) {
  let evidence: AiMorphologyFinding["evidence"] = [];
  try {
    evidence = typeof value === "string" ? JSON.parse(value) : value;
  } catch {
    evidence = [];
  }
  return new Set(
    (Array.isArray(evidence) ? evidence : [])
      .map(
        (item) =>
          `${Number(item.pageNumber) || 0}|${compactMorphologyMatch(item.quote)}`,
      )
      .filter((item) => !item.endsWith("|")),
  );
}

function protectedMorphologyManualFields(row: ProtectedMorphologyRow) {
  try {
    const parsed = JSON.parse(row.manualFieldsJson) as unknown;
    return new Set(
      Array.isArray(parsed)
        ? parsed.filter((item): item is string => typeof item === "string")
        : [],
    );
  } catch {
    return new Set<string>();
  }
}

function protectedMorphologyIdentityCompatible(
  row: ProtectedMorphologyRow,
  finding: AiMorphologyFinding,
) {
  const manual = protectedMorphologyManualFields(row);
  const compatibleText = (
    field: string,
    oldValue: unknown,
    incomingValue: unknown,
  ) => {
    if (manual.has(field)) return true;
    const oldKey = compactMorphologyMatch(oldValue);
    const incomingKey = compactMorphologyMatch(incomingValue);
    return !oldKey || !incomingKey || oldKey === incomingKey;
  };
  if (!compatibleText("organ", row.organ, finding.organ)) return false;
  if (!compatibleText("findingType", row.findingType, finding.findingType)) {
    return false;
  }
  if (!compatibleText("findingName", row.findingName, finding.findingName)) {
    return false;
  }
  if (!compatibleText("region", row.region, finding.region)) return false;
  if (
    !manual.has("laterality") &&
    row.laterality !== "unspecified" &&
    finding.laterality !== "unspecified" &&
    row.laterality !== finding.laterality
  ) {
    return false;
  }
  return true;
}

function matchProtectedMorphology(
  finding: AiMorphologyFinding,
  candidates: ProtectedMorphologyRow[],
  used: Set<string>,
) {
  const incomingEvidence = evidenceKeys(finding.evidence);
  const ranked = candidates
    .filter(
      (row) =>
        !used.has(row.id) &&
        protectedMorphologyIdentityCompatible(row, finding),
    )
    .map((row) => {
      const oldEvidence = evidenceKeys(row.evidenceJson);
      const evidenceMatches = [...incomingEvidence].filter((key) =>
        oldEvidence.has(key),
      ).length;
      let score = evidenceMatches * 100;
      if (
        compactMorphologyMatch(row.organ) ===
        compactMorphologyMatch(finding.organ)
      )
        score += 20;
      if (
        compactMorphologyMatch(row.findingType) ===
        compactMorphologyMatch(finding.findingType)
      )
        score += 20;
      if (row.laterality === finding.laterality) score += 12;
      if (
        compactMorphologyMatch(row.region) ===
        compactMorphologyMatch(finding.region)
      )
        score += 8;
      if (
        compactMorphologyMatch(row.findingName) ===
        compactMorphologyMatch(finding.findingName)
      )
        score += 15;
      if (
        compactMorphologyMatch(row.rawText) ===
        compactMorphologyMatch(finding.rawText)
      )
        score += 40;
      return { row, score };
    })
    .sort((left, right) => right.score - left.score);
  if (
    !ranked[0] ||
    ranked[0].score < 52 ||
    ranked[0].score === ranked[1]?.score
  )
    return null;
  return ranked[0].row;
}

function protectedFindingValues(
  finding: AiMorphologyFinding,
  old: ProtectedMorphologyRow | null,
) {
  const manual = old
    ? protectedMorphologyManualFields(old)
    : new Set<string>();
  const value = <T>(key: string, aiValue: T, oldValue: T) =>
    manual.has(key) ? oldValue : aiValue;
  return {
    id: old?.id || createId("finding"),
    organ: value("organ", finding.organ, old?.organ ?? finding.organ),
    region: value("region", finding.region, old?.region ?? finding.region),
    laterality: value(
      "laterality",
      finding.laterality,
      old?.laterality ?? finding.laterality,
    ),
    findingType: value(
      "findingType",
      finding.findingType,
      old?.findingType ?? finding.findingType,
    ),
    findingName: value(
      "findingName",
      finding.findingName,
      old?.findingName ?? finding.findingName,
    ),
    presence: value(
      "presence",
      finding.presence,
      old?.presence ?? finding.presence,
    ),
    findingCount: value(
      "findingCount",
      finding.findingCount,
      old?.findingCount ?? finding.findingCount,
    ),
    size: manual.has("size")
      ? {
          length: old?.sizeLength ?? null,
          width: old?.sizeWidth ?? null,
          height: old?.sizeHeight ?? null,
          unit: old?.sizeUnit ?? null,
        }
      : finding.size,
    morphology: value(
      "morphology",
      finding.morphology,
      old?.morphology ?? finding.morphology,
    ),
    classification: manual.has("classification")
      ? {
          system: old?.classificationSystem ?? null,
          value: old?.classificationValue ?? null,
          text: old?.classificationText ?? null,
        }
      : finding.classification,
    trackingGroupId: old?.trackingGroupId || null,
    matchConfidence: old?.matchConfidence ?? null,
    manualFieldsJson: old?.manualFieldsJson || "[]",
    source: old ? "manual" : "ai",
  };
}

function compactObservationIdentity(value: unknown) {
  return String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
    .replace(/[（）()，,。.:：;；、|\s_\-]+/g, "");
}

function observationResultIdentity(value: number | null, text: string) {
  const numericValue =
    value ??
    (() => {
      const match = text.match(/[-+]?\d+(?:\.\d+)?/);
      if (!match) return null;
      const parsed = Number(match[0]);
      return Number.isFinite(parsed) ? parsed : null;
    })();
  return numericValue === null
    ? `text:${compactObservationIdentity(text)}`
    : `number:${Number(numericValue.toPrecision(12))}`;
}

function observationContext(item: AiObservation) {
  const text = [
    item.sectionName,
    item.itemName,
    item.resultText,
    item.method,
    ...item.evidence.map((entry) => entry.quote),
  ]
    .filter(Boolean)
    .join(" ");
  const historical =
    /(历史|既往|上次|前次|往年|去年|前年|历次|复查前)/.test(text) &&
    !/(本次|当前)/.test(text);
  const dateTime =
    text.match(
      /\b(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})(?:日)?(?:\s+(\d{1,2})[:：](\d{2}))?/,
    ) || text.match(/\b(\d{1,2})[:：](\d{2})\b/);
  const specimen =
    (
      [
        ["whole_blood", /全血/],
        ["serum", /血清/],
        ["plasma", /血浆/],
        ["urine", /尿液|尿标本|尿常规/],
        ["stool", /便常规|粪便|大便/],
        ["sputum", /痰液|痰标本/],
        ["cerebrospinal_fluid", /脑脊液/],
      ] satisfies Array<[string, RegExp]>
    ).find(([, pattern]) => pattern.test(text))?.[0] || null;
  return {
    temporalKind: historical ? "historical" : "current",
    measuredAt: dateTime?.[0] || null,
    specimen,
    method: compactObservationIdentity(item.method),
  };
}

function reportObservationCompleteness(item: AiObservation) {
  const values = [
    item.sectionName,
    item.itemCode,
    item.normalizedName,
    item.numericValue,
    item.unit,
    item.referenceLow,
    item.referenceHigh,
    item.referenceText,
    item.abnormalFlag,
    item.method,
  ];
  return (
    item.evidence.length +
    values.filter(
      (value) => value !== null && value !== undefined && value !== "",
    ).length
  );
}

function compactMorphologyIdentity(value: unknown) {
  return String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
    .replace(/[（）()，,。.:：;；、|\s_\-]+/g, "");
}

function standardizedMorphologyOrgan(finding: AiMorphologyFinding) {
  const raw = compactMorphologyIdentity(
    `${finding.organ || ""}${finding.region || ""}${finding.rawText}`,
  );
  const mappings: Array<[string, RegExp]> = [
    ["甲状腺", /thyroid|甲状腺/],
    ["乳腺", /breast|乳腺/],
    ["锁骨下动脉", /subclavianartery|锁骨下动脉/],
    ["颈动脉", /carotidartery|颈动脉/],
    ["肝脏", /liver|肝脏|肝左叶|肝右叶/],
    ["胆囊", /gallbladder|胆囊/],
    ["胰腺", /pancreas|胰腺/],
    ["脾脏", /spleen|脾脏/],
    ["肾脏", /kidney|肾脏|左肾|右肾|双肾/],
    ["膀胱", /bladder|膀胱/],
    ["前列腺", /prostate|前列腺/],
    ["子宫", /uterus|子宫/],
    ["卵巢", /ovary|卵巢/],
    ["肺", /lung|肺部|左肺|右肺/],
    ["心脏", /heart|心脏/],
  ];
  return (
    mappings.find(([, pattern]) => pattern.test(raw))?.[0] ||
    finding.organ?.trim() ||
    inferMorphologyOrgan(finding.rawText) ||
    null
  );
}

function standardizedMorphologyType(finding: AiMorphologyFinding) {
  const structured = [
    finding.findingType,
    finding.findingName,
    finding.morphology,
  ]
    .filter(Boolean)
    .join(" ");
  if (/脂肪肝/.test(structured)) return "脂肪肝";
  if (/钙化/.test(structured)) return "钙化灶";
  const inferred = inferMorphologyType(
    `${finding.findingType} ${finding.findingName}`,
  );
  if (inferred !== "形态发现") return inferred;
  /* 一条超声原文可能同时包含多个 finding。结构化名称已明确为回声描述时，
     不得再从整行 rawText 中拾取后续“未见胆管扩张”等其他对象词作为类型。 */
  if (/回声/.test(structured)) return "回声改变";
  return inferMorphologyType(finding.rawText);
}

function standardizedMorphologyLaterality(finding: AiMorphologyFinding) {
  if (finding.laterality !== "unspecified") return finding.laterality;
  /* laterality 只从当前 finding 的结构化字段判断。rawText 可能是一整行复合描述，
     其中其他病灶的“右叶/左侧”不能污染当前 finding。 */
  const structured = [
    finding.organ,
    finding.region,
    finding.findingName,
    finding.morphology,
  ]
    .filter(Boolean)
    .join(" ");
  if (/双侧|双叶|双肾/.test(structured)) return "bilateral" as const;
  if (/左侧|左叶|左肾|左肺/.test(structured)) return "left" as const;
  if (/右侧|右叶|右肾|右肺/.test(structured)) return "right" as const;
  return finding.laterality;
}

function normalizedMorphologySize(finding: AiMorphologyFinding) {
  const unit = finding.size.unit?.toLocaleLowerCase() || null;
  const scale = unit === "cm" ? 10 : unit === "m" ? 1000 : 1;
  const dimensions = [
    finding.size.length,
    finding.size.width,
    finding.size.height,
  ]
    .filter((value): value is number => value !== null)
    .map((value) => Number((value * scale).toFixed(3)))
    .sort((left, right) => right - left);
  return dimensions;
}

function standardizedMorphologyRegion(finding: AiMorphologyFinding) {
  const organ = standardizedMorphologyOrgan(finding);
  let region = compactMorphologyIdentity(finding.region);
  if (!region) return "";
  const organPrefixes = [
    organ,
    organ === "肝脏" ? "肝" : null,
    organ === "肾脏" ? "肾" : null,
    organ === "肺" ? "肺部" : null,
  ]
    .map(compactMorphologyIdentity)
    .filter(Boolean);
  for (const prefix of organPrefixes.sort(
    (left, right) => right.length - left.length,
  )) {
    if (region.startsWith(prefix) && region.length > prefix.length) {
      region = region.slice(prefix.length);
      break;
    }
  }
  region = region
    .replace(/^(?:左侧|右侧|双侧)(?=叶|段|部|区)/, (side) => side.slice(0, 1))
    .replace(/^(?:左|右|双)侧$/, "");
  if (/^(?:左侧|右侧|双侧|左|右|双)$/.test(region)) return "";
  return region;
}

function morphologyFindingCompleteness(finding: AiMorphologyFinding) {
  return (
    [
      finding.sectionName,
      finding.organ,
      finding.region,
      finding.findingName,
      finding.findingCount,
      ...normalizedMorphologySize(finding),
      finding.morphology,
      finding.classification?.value,
      finding.comparisonText,
      ...Object.values(finding.attributes),
      ...finding.measurements,
    ].filter((value) => value !== null && value !== undefined && value !== "")
      .length +
    finding.evidence.length * 2 +
    Math.min(4, Math.floor(finding.rawText.length / 40))
  );
}

function preferredMorphologyFindingName(
  primary: AiMorphologyFinding,
  fallback: AiMorphologyFinding,
) {
  const type = standardizedMorphologyType(primary);
  const canonicalPattern =
    type === "脂肪肝"
      ? /脂肪肝/
      : type === "钙化灶"
        ? /钙化/
        : new RegExp(type.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const primaryCanonical = canonicalPattern.test(primary.findingName);
  const fallbackCanonical = canonicalPattern.test(fallback.findingName);
  if (primaryCanonical !== fallbackCanonical)
    return primaryCanonical ? primary.findingName : fallback.findingName;
  return primary.findingName || fallback.findingName;
}

function morphologyEvidencePages(finding: AiMorphologyFinding) {
  return new Set(
    finding.evidence
      .map((entry) => entry.pageNumber)
      .filter((pageNumber) => Number.isFinite(pageNumber) && pageNumber > 0),
  );
}

function sharesMorphologyEvidencePage(
  left: AiMorphologyFinding,
  right: AiMorphologyFinding,
) {
  const leftPages = morphologyEvidencePages(left);
  return right.evidence.some((entry) => leftPages.has(entry.pageNumber));
}

function compatibleMorphologyLocation(
  left: AiMorphologyFinding,
  right: AiMorphologyFinding,
) {
  if (
    compactMorphologyIdentity(standardizedMorphologyOrgan(left)) !==
    compactMorphologyIdentity(standardizedMorphologyOrgan(right))
  )
    return false;
  const leftLaterality = standardizedMorphologyLaterality(left);
  const rightLaterality = standardizedMorphologyLaterality(right);
  if (
    leftLaterality !== "unspecified" &&
    rightLaterality !== "unspecified" &&
    leftLaterality !== rightLaterality
  )
    return false;
  const leftRegion = standardizedMorphologyRegion(left);
  const rightRegion = standardizedMorphologyRegion(right);
  return !leftRegion || !rightRegion || leftRegion === rightRegion;
}

function descriptiveMorphologyTargetType(finding: AiMorphologyFinding) {
  if (finding.presence !== "present") return null;
  const text = [
    finding.findingType,
    finding.findingName,
    finding.morphology,
    ...Object.values(finding.attributes),
  ]
    .filter(Boolean)
    .join(" ")
    .normalize("NFKC");
  const fattyLiverDescription =
    /(?:肝实质|实质).{0,16}回声.{0,16}(?:增强|增粗|致密)/.test(text) &&
    !/(?:局灶|结节|肿块|包块|团块|钙化|强回声区|高回声区)/.test(text);
  const focalCalcificationDescription =
    /(?:强|高)回声(?:区|灶)/.test(text) &&
    (normalizedMorphologySize(finding).length > 0 ||
      /(?:局灶|右叶|左叶|直径)/.test(text));
  if (fattyLiverDescription === focalCalcificationDescription) return null;
  return fattyLiverDescription ? "脂肪肝" : "钙化灶";
}

/* 明确结论提供稳定命名，描述 finding 提供尺寸、形态和属性。仅在同器官、位置兼容、
   至少共享一个证据页且目标唯一时归并，避免把不同病灶强行关联。 */
function reconcileDescriptiveMorphologyFindings(
  findings: AiMorphologyFinding[],
) {
  const reconciled = [...findings];
  const matches = findings.flatMap((descriptor, descriptorIndex) => {
    const targetType = descriptiveMorphologyTargetType(descriptor);
    if (!targetType || standardizedMorphologyType(descriptor) === targetType)
      return [];
    const targetIndexes = findings.flatMap((candidate, candidateIndex) => {
      if (
        candidateIndex === descriptorIndex ||
        standardizedMorphologyType(candidate) !== targetType ||
        !compatibleMorphologyLocation(candidate, descriptor) ||
        !sharesMorphologyEvidencePage(candidate, descriptor)
      )
        return [];
      return [candidateIndex];
    });
    return [{ descriptorIndex, targetType, targetIndexes }];
  });
  const descriptorCountByTarget = new Map<number, number>();
  for (const match of matches) {
    if (match.targetIndexes.length !== 1) continue;
    const targetIndex = match.targetIndexes[0];
    descriptorCountByTarget.set(
      targetIndex,
      (descriptorCountByTarget.get(targetIndex) || 0) + 1,
    );
  }

  const consumed = new Set<number>();
  for (const match of matches) {
    if (match.targetIndexes.length !== 1) continue;
    const targetIndex = match.targetIndexes[0];
    /* 双向唯一：一个描述只能命中一个结论，一个结论也只能被一个描述补充。
       若同侧存在多个描述性病灶，宁可保留待审，也不能把多个尺寸吞成一条。 */
    if (descriptorCountByTarget.get(targetIndex) !== 1) continue;
    const descriptor = reconciled[match.descriptorIndex];
    const target = reconciled[targetIndex];
    const combined = mergeMorphologyFindingPair(target, descriptor);
    reconciled[targetIndex] = {
      ...combined,
      organ: standardizedMorphologyOrgan(target),
      region: target.region || combined.region,
      laterality:
        standardizedMorphologyLaterality(target) !== "unspecified"
          ? standardizedMorphologyLaterality(target)
          : combined.laterality,
      findingType: match.targetType,
      findingName: target.findingName,
    };
    consumed.add(match.descriptorIndex);
  }
  return reconciled.filter((_, index) => !consumed.has(index));
}

function mergeMorphologyFindingPair(
  left: AiMorphologyFinding,
  right: AiMorphologyFinding,
) {
  const primary =
    morphologyFindingCompleteness(right) > morphologyFindingCompleteness(left)
      ? right
      : left;
  const fallback = primary === left ? right : left;
  const fill = <K extends keyof AiMorphologyFinding>(key: K) => {
    const value = primary[key];
    return value === null || value === undefined || value === ""
      ? fallback[key]
      : value;
  };
  const evidence = [...left.evidence, ...right.evidence].filter(
    (entry, index, entries) =>
      entries.findIndex(
        (candidate) =>
          candidate.pageNumber === entry.pageNumber &&
          compactMorphologyIdentity(candidate.quote) ===
            compactMorphologyIdentity(entry.quote),
      ) === index,
  );
  const measurements = [
    ...primary.measurements,
    ...fallback.measurements,
  ].filter(
    (item, index, entries) =>
      entries.findIndex(
        (candidate) =>
          compactMorphologyIdentity(candidate.key) ===
            compactMorphologyIdentity(item.key) &&
          candidate.value === item.value &&
          compactMorphologyIdentity(candidate.unit) ===
            compactMorphologyIdentity(item.unit),
      ) === index,
  );
  return {
    ...primary,
    sectionName: fill("sectionName"),
    organ:
      standardizedMorphologyOrgan(primary) ||
      standardizedMorphologyOrgan(fallback),
    region: fill("region"),
    laterality: standardizedMorphologyLaterality(primary),
    findingName: preferredMorphologyFindingName(primary, fallback),
    findingCount: fill("findingCount"),
    size: normalizedMorphologySize(primary).length
      ? primary.size
      : fallback.size,
    measurements,
    morphology: fill("morphology"),
    attributes: { ...fallback.attributes, ...primary.attributes },
    classification: primary.classification || fallback.classification,
    comparisonText: fill("comparisonText"),
    rawText:
      primary.rawText.length >= fallback.rawText.length
        ? primary.rawText
        : fallback.rawText,
    evidence,
    confidence:
      Math.max(primary.confidence || 0, fallback.confidence || 0) || null,
  } satisfies AiMorphologyFinding;
}

/**
 * 综合体检常在总检摘要和专项明细重复描述同一病灶。没有尺寸的摘要可与有尺寸的
 * 明细合并；两个明确且不同尺寸的病灶继续分别保留。
 */
export function deduplicateReportMorphologyFindings(
  findings: AiMorphologyFinding[],
) {
  const merged: AiMorphologyFinding[] = [];
  const identities: Array<{
    organ: string;
    type: string;
    laterality: string;
    region: string;
    size: number[];
  }> = [];
  for (const finding of findings) {
    const identity = {
      organ: compactMorphologyIdentity(standardizedMorphologyOrgan(finding)),
      type: compactMorphologyIdentity(standardizedMorphologyType(finding)),
      laterality: standardizedMorphologyLaterality(finding),
      region: standardizedMorphologyRegion(finding),
      size: normalizedMorphologySize(finding),
    };
    const existingIndex = identities.findIndex((candidate) => {
      if (
        candidate.organ !== identity.organ ||
        candidate.type !== identity.type ||
        candidate.laterality !== identity.laterality ||
        (candidate.region &&
          identity.region &&
          candidate.region !== identity.region)
      )
        return false;
      if (!candidate.size.length || !identity.size.length) return true;
      return (
        candidate.size.length === identity.size.length &&
        candidate.size.every(
          (value, index) => Math.abs(value - identity.size[index]) <= 0.5,
        )
      );
    });
    const standardized = {
      ...finding,
      organ: standardizedMorphologyOrgan(finding),
      laterality: standardizedMorphologyLaterality(finding),
      findingType: standardizedMorphologyType(finding),
    };
    if (existingIndex < 0) {
      merged.push(standardized);
      identities.push(identity);
      continue;
    }
    merged[existingIndex] = mergeMorphologyFindingPair(
      merged[existingIndex],
      standardized,
    );
    identities[existingIndex] = {
      ...identities[existingIndex],
      organ: compactMorphologyIdentity(
        standardizedMorphologyOrgan(merged[existingIndex]),
      ),
      region: standardizedMorphologyRegion(merged[existingIndex]),
      size: normalizedMorphologySize(merged[existingIndex]),
    };
  }
  return reconcileDescriptiveMorphologyFindings(merged);
}

function normalizedReportDate(value: string) {
  const dateMatch = value.match(
    /(20\d{2})\s*[年/.~-]\s*(\d{1,2})\s*[月/.~-]\s*(\d{1,2})\s*日?/,
  );
  if (!dateMatch) return null;
  const date = `${dateMatch[1]}-${dateMatch[2].padStart(2, "0")}-${dateMatch[3].padStart(2, "0")}`;
  const timeMatch = value
    .slice((dateMatch.index || 0) + dateMatch[0].length)
    .match(/(\d{1,2})\s*[:：]\s*(\d{2})(?:\s*[:：]\s*(\d{2}))?/);
  if (!timeMatch) return date;
  return `${date} ${timeMatch[1].padStart(2, "0")}:${timeMatch[2]}:${timeMatch[3] || "00"}`;
}

function deterministicReportDates(reportId: string) {
  let text = "";
  try {
    text = buildAiExtractionPlan(reportId)
      .pages.map((page) => page.text)
      .join("\n");
  } catch (error) {
    if ((error as { code?: string })?.code !== "EMPTY_REPORT_PAGES")
      throw error;
  }
  const find = (labels: string[]) => {
    for (const label of labels) {
      const match = text.match(
        new RegExp(`${label}\\s*[:：]?\\s*([^\\n]{6,32})`, "i"),
      );
      const value = match ? normalizedReportDate(match[1]) : null;
      if (value) return value;
    }
    return null;
  };
  return {
    reportIssuedAt: find([
      "终检时间",
      "报告时间",
      "报告日期",
      "审核时间",
      "审核日期",
    ]),
    examinedAt: find(["体检日期", "检查日期", "检查时间"]),
  };
}

function reportObservationSourcePriority(item: AiObservation) {
  const text = [item.sectionName, ...item.evidence.map((entry) => entry.quote)]
    .filter(Boolean)
    .join(" ");
  if (/(健康建议|生活建议|复查建议|医生建议)/.test(text)) return 0;
  if (/(总检|汇总|综述|小结|异常指标汇总|体检结论)/.test(text)) return 1;
  if (/(检验|血常规|尿常规|生化|肝功能|肾功能|血脂|血糖|专项|明细)/.test(text))
    return 3;
  return 2;
}

function mergeReportObservationPair(left: AiObservation, right: AiObservation) {
  const leftPriority = reportObservationSourcePriority(left);
  const rightPriority = reportObservationSourcePriority(right);
  const primary =
    rightPriority !== leftPriority
      ? rightPriority > leftPriority
        ? right
        : left
      : reportObservationCompleteness(right) >
          reportObservationCompleteness(left)
        ? right
        : left;
  const fallback = primary === left ? right : left;
  const fill = <K extends keyof AiObservation>(key: K) => {
    const value = primary[key];
    return value === null || value === undefined || value === ""
      ? fallback[key]
      : value;
  };
  const evidence = [...left.evidence, ...right.evidence].filter(
    (entry, index, entries) =>
      entries.findIndex(
        (candidate) =>
          candidate.pageNumber === entry.pageNumber &&
          compactObservationIdentity(candidate.quote) ===
            compactObservationIdentity(entry.quote),
      ) === index,
  );
  return {
    ...primary,
    sectionName: fill("sectionName"),
    itemCode: fill("itemCode"),
    normalizedName: fill("normalizedName"),
    numericValue: fill("numericValue"),
    unit: fill("unit"),
    referenceLow: fill("referenceLow"),
    referenceHigh: fill("referenceHigh"),
    referenceText: fill("referenceText"),
    abnormalFlag: fill("abnormalFlag"),
    method: fill("method"),
    evidence,
  } satisfies AiObservation;
}

const observationMetadataNames = new Set(
  [
    "姓名",
    "性别",
    "年龄",
    "出生日期",
    "检查日期",
    "体检日期",
    "报告日期",
    "报告时间",
    "检查时间",
    "检测时间",
    "门诊号",
    "住院号",
    "体检号",
    "体检编号",
    "报告编号",
    "样本编号",
  ].map(compactObservationIdentity),
);

const qualitativeResultUnitPattern =
  /^(?:阴性|阳性|弱阳性|可疑阳性|未检出|未见|正常|异常|未见异常|未见明显异常)$/i;
const invalidObservationNamePattern =
  /^(?:(?:20\d{2}|19\d{2})[年./-]\d{1,2}(?:[月./-]\d{1,2}日?)?|\d{1,3}岁|[-+]?\d+(?:\.\d+)?\s*(?:~|～|至|[-–—])\s*[-+]?\d+(?:\.\d+)?|参考范围|参考值|正常范围|正常值)$/i;
const strictNumericObservationResultPattern =
  /^\s*(?:<=|>=|<|>|≤|≥)?\s*([-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)\s*(?:[%‰↑↓▲▼⬆⬇]|偏高|偏低|高|低|正常|异常)?\s*$/i;

function sameObservationNumber(left: number, right: number) {
  return Math.abs(left - right) <= Math.max(1e-12, Math.abs(left) * 1e-12);
}

function strictNumericObservationResult(value: string) {
  const match = value
    .normalize("NFKC")
    .match(strictNumericObservationResultPattern);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

function uniqueObservationEvidence(evidence: AiEvidence[]) {
  return evidence
    .filter((entry) => entry.pageNumber > 0 && entry.quote.trim())
    .filter(
      (entry, index, entries) =>
        entries.findIndex(
          (candidate) =>
            candidate.pageNumber === entry.pageNumber &&
            compactObservationIdentity(candidate.quote) ===
              compactObservationIdentity(entry.quote),
        ) === index,
    );
}

function repairedTransposedDecimal(
  resultText: string,
  referenceLow: number | null,
  referenceHigh: number | null,
) {
  const match = resultText.match(/^(\d+)[`'’](\d+)$/);
  if (!match || (referenceLow === null && referenceHigh === null)) return null;
  const candidates = [
    Number(`${match[1]}.${match[2]}`),
    Number(`${match[2]}.${match[1]}`),
  ].filter(
    (value, index, values) =>
      Number.isFinite(value) &&
      values.indexOf(value) === index &&
      (referenceLow === null || value >= referenceLow) &&
      (referenceHigh === null || value <= referenceHigh),
  );
  return candidates.length === 1 ? candidates[0] : null;
}

function isCorruptedPlateletDistributionWidth(
  itemName: string,
  resultText: string,
  numericValue: number | null,
  unit: string | null,
  referenceHigh: number | null,
) {
  return Boolean(
    /(?:血小板.*分布宽度|\bPDV?W\b)/i.test(itemName) &&
      /^[↑↓▲▼⬆⬇]/.test(resultText) &&
      numericValue !== null &&
      !unit &&
      referenceHigh !== null &&
      numericValue > referenceHigh * 3,
  );
}

const cbcDifferentialPercentageSpecs = [
  {
    itemCode: "NEUT%",
    itemName: "中性粒细胞百分比(NEUT%)",
    normalizedName: "中性粒细胞百分比",
    pattern: /(?:中性粒细胞百分比|NEUT%)/i,
  },
  {
    itemCode: "LYMPH%",
    itemName: "淋巴细胞百分比(LYMPH%)",
    normalizedName: "淋巴细胞百分比",
    pattern: /(?:淋巴细胞百分比|LYMPH%)/i,
  },
  {
    itemCode: "MONO%",
    itemName: "单核细胞百分比(MONO%)",
    normalizedName: "单核细胞百分比",
    pattern: /(?:单核细胞百分比|MONO%)/i,
  },
  {
    itemCode: "EO%",
    itemName: "嗜酸性粒细胞百分比(EO%)",
    normalizedName: "嗜酸性粒细胞百分比",
    pattern: /(?:(?:嗜|啫)酸性粒细胞百分比|EO%)/i,
  },
  {
    itemCode: "BASO%",
    itemName: "嗜碱性粒细胞百分比(BASO%)",
    normalizedName: "嗜碱性粒细胞百分比",
    pattern: /(?:(?:嗜|啫)碱性粒细胞百分比|BASO%)/i,
  },
] as const;

function completeCbcDifferentialPercentages(observations: AiObservation[]) {
  const matched = cbcDifferentialPercentageSpecs.map((spec) => ({
    spec,
    observation: observations.find(
      (observation) =>
        spec.pattern.test(observation.itemName) ||
        spec.pattern.test(observation.normalizedName || ""),
    ),
  }));
  const present = matched.filter(
    (entry) =>
      entry.observation && entry.observation.numericValue !== null,
  );
  const missing = matched.filter((entry) => !entry.observation);
  if (present.length !== 4 || missing.length !== 1) return observations;
  const reliableInputs = present.every((entry) => {
    const observation = entry.observation!;
    const value = observation.numericValue!;
    return (
      value >= 0 &&
      value <= 100 &&
      (observation.referenceHigh === null ||
        value <=
          Math.max(
            observation.referenceHigh * 3,
            observation.referenceHigh + 20,
          ))
    );
  });
  if (!reliableInputs) return observations;
  const sourceEvidence = observations
    .flatMap((observation) => observation.evidence)
    .find((evidence) => missing[0].spec.pattern.test(evidence.quote));
  if (!sourceEvidence) return observations;
  const sum = present.reduce(
    (total, entry) => total + (entry.observation?.numericValue || 0),
    0,
  );
  const numericValue = Number((100 - sum).toFixed(1));
  if (!Number.isFinite(numericValue) || numericValue < 0 || numericValue > 100)
    return observations;
  const cells = sourceEvidence.quote
    .split(/[|｜]/)
    .map((cell) => cell.trim());
  const itemIndex = cells.findIndex((cell) =>
    missing[0].spec.pattern.test(cell),
  );
  if (/^[-+]?\d+(?:\.\d+)?[↑↓▲▼⬆⬇]?$/.test(cells[itemIndex + 1] || ""))
    return observations;
  const referenceMatch = cells
    .slice(itemIndex + 1)
    .find((cell) =>
      /^[-+]?\d+(?:\.\d+)?\s*[-~～]\s*[-+]?\d+(?:\.\d+)?$/.test(
        cell,
      ),
    )
    ?.match(
      /([-+]?\d+(?:\.\d+)?)\s*[-~～]\s*([-+]?\d+(?:\.\d+)?)/,
    );
  const referenceLow = referenceMatch ? Number(referenceMatch[1]) : null;
  const referenceHigh = referenceMatch ? Number(referenceMatch[2]) : null;
  const abnormalFlag =
    referenceLow !== null && numericValue < referenceLow
      ? ("low" as const)
      : referenceHigh !== null && numericValue > referenceHigh
        ? ("high" as const)
        : null;
  return [
    ...observations,
    {
      sectionName: present[0].observation?.sectionName || null,
      itemCode: missing[0].spec.itemCode,
      itemName: missing[0].spec.itemName,
      normalizedName: missing[0].spec.normalizedName,
      resultText: `${numericValue}${abnormalFlag === "low" ? "↓" : abnormalFlag === "high" ? "↑" : ""}`,
      numericValue,
      unit: "%",
      referenceLow,
      referenceHigh,
      referenceText: referenceMatch?.[0] || null,
      abnormalFlag,
      method: "calculated:differential_percentage_complement",
      evidence: [sourceEvidence],
    },
  ];
}

/**
 * 最终落库前执行不会改变数据库结构的最小安全校验：拒绝明确的元数据/日期/区间残片，
 * 修复结果数值与上下界结构，并把错误放入 unit 的定性结果移回 resultText。
 */
export function sanitizeReportObservations(observations: AiObservation[]) {
  const sanitized = observations.flatMap((observation) => {
    const normalizedItemName = observation.itemName.normalize("NFKC").trim();
    const embeddedValue = normalizedItemName.match(
      /^(.+?)[：:]\s*(?:<=|>=|<|>|≤|≥)?\s*([-+]?\d+(?:\.\d+)?)(?:\s*[^\s]+)?$/,
    );
    const embeddedNumber = embeddedValue ? Number(embeddedValue[2]) : null;
    const observationNumber =
      observation.numericValue ??
      strictNumericObservationResult(observation.resultText);
    const withoutEmbeddedValue =
      embeddedValue &&
      embeddedNumber !== null &&
      Number.isFinite(embeddedNumber) &&
      observationNumber !== null &&
      sameObservationNumber(embeddedNumber, observationNumber)
        ? embeddedValue[1].trim()
        : normalizedItemName;
    const sameAsSection =
      compactObservationIdentity(withoutEmbeddedValue) ===
      compactObservationIdentity(observation.sectionName);
    const reportLevelQualitativeResult = qualitativeResultUnitPattern.test(
      observation.resultText.normalize("NFKC").trim(),
    );
    const strippedReportHeading =
      sameAsSection && reportLevelQualitativeResult
        ? withoutEmbeddedValue
            .replace(/(?:检验|检查|检测)?报告(?:单)?$/i, "")
            .trim()
        : withoutEmbeddedValue;
    const itemName = strippedReportHeading || withoutEmbeddedValue;
    const compactName = compactObservationIdentity(itemName);
    if (
      !compactName ||
      observationMetadataNames.has(compactName) ||
      invalidObservationNamePattern.test(itemName)
    )
      return [];
    if (/^[a-z]$/i.test(itemName) || /^[^\p{L}\p{N}]+$/u.test(itemName))
      return [];

    const rawUnit = observation.unit?.normalize("NFKC").trim() || null;
    let unit = /^9\/[lL]$/.test(rawUnit || "") ? "g/L" : rawUnit;
    const placeholderResult = /^(?:[-—–\/\\]|无|未填写)$/i.test(
      observation.resultText.trim(),
    );
    const qualitativeUnit = Boolean(
      unit && qualitativeResultUnitPattern.test(unit),
    );
    let resultText =
      qualitativeUnit && placeholderResult
        ? unit!
        : observation.resultText.normalize("NFKC").trim();
    const repairedDecimal = repairedTransposedDecimal(
      resultText,
      observation.referenceLow,
      observation.referenceHigh,
    );
    if (repairedDecimal !== null) resultText = String(repairedDecimal);
    const parsedResult = strictNumericObservationResult(resultText);
    const numericValue =
      repairedDecimal ??
      (parsedResult !== null &&
      (observation.numericValue === null ||
        !sameObservationNumber(observation.numericValue, parsedResult))
        ? parsedResult
        : observation.numericValue);
    const reference = assessObservationReference({
      low: observation.referenceLow,
      high: observation.referenceHigh,
      text: observation.referenceText,
    });
    if (
      !unit &&
      /(?:红细胞压积|\bHCT\b)/i.test(itemName) &&
      numericValue !== null &&
      numericValue <= 1.5 &&
      (reference.high === null || reference.high <= 1.5)
    ) {
      unit = "L/L";
    }
    if (
      isCorruptedPlateletDistributionWidth(
        itemName,
        resultText,
        numericValue,
        unit,
        reference.high,
      )
    )
      return [];
    const explicitHigh = /[↑▲⬆]|偏高/.test(resultText);
    const explicitLow = /[↓▼⬇]|偏低/.test(resultText);
    const inRange =
      numericValue !== null &&
      (reference.low === null || numericValue >= reference.low) &&
      (reference.high === null || numericValue <= reference.high) &&
      (reference.low !== null || reference.high !== null);
    let abnormalFlag = observation.abnormalFlag;
    if (inRange && abnormalFlag === "high" && !explicitHigh) abnormalFlag = null;
    if (inRange && abnormalFlag === "low" && !explicitLow) abnormalFlag = null;

    return [
      {
        ...observation,
        itemName,
        resultText,
        numericValue,
        unit: qualitativeUnit ? null : unit,
        referenceLow: reference.low,
        referenceHigh: reference.high,
        referenceText: reference.text,
        abnormalFlag,
        evidence: uniqueObservationEvidence(observation.evidence),
      },
    ];
  });
  return completeCbcDifferentialPercentages(sanitized);
}

function compactPersistedEvidence(value: unknown) {
  return String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
    .replace(/[μµ]/g, "u")
    .replace(/[×✕✖＊*]/g, "x")
    .replace(/[–—−~～]/g, "-")
    .replace(/[≤≦]/g, "<=")
    .replace(/[≥≧]/g, ">=")
    .replace(/[（）()，,。.:：;；、|｜\s_]/g, "");
}

/**
 * 持久化前只保留能回指当前报告 OCR 来源的证据。原始 OCR 行可直接命中；经过本地表格重排、
 * 相邻单元拼接后形成的预处理行，必须与当前规划器产出的行完全一致才可信，避免 AI 通过
 * “伪造前缀 + 一小段真实 OCR”绕过校验。没有命中的 evidence 会被清空；当报告存在已完成
 * OCR 时，后续持久化门禁会拒绝没有任何可核验证据的 AI observation。
 */
function validatePersistedObservationEvidence(
  reportId: string,
  observations: AiObservation[],
) {
  const rows = getDatabase()
    .prepare(
      `
    SELECT p.page_number AS pageNumber, result.lines_json AS linesJson
    FROM report_pages p
    JOIN ocr_results result ON result.page_id = p.id
    JOIN processing_jobs job ON job.id = result.job_id AND job.status = 'completed'
    WHERE p.report_id = ?
    ORDER BY p.page_number, result.created_at DESC, result.id DESC
  `,
    )
    .all(reportId) as Array<{ pageNumber: number; linesJson: string }>;
  if (!rows.length) return observations;

  const pages = new Map<number, string[]>();
  for (const row of rows) {
    if (pages.has(row.pageNumber)) continue;
    try {
      const lines = JSON.parse(row.linesJson) as Array<{ text?: unknown }>;
      pages.set(
        row.pageNumber,
        lines.map((line) => String(line.text || "").trim()).filter(Boolean),
      );
    } catch {
      pages.set(row.pageNumber, []);
    }
  }
  const plannedPages = new Map<number, string[]>();
  try {
    for (const page of buildAiExtractionPlan(reportId).pages) {
      plannedPages.set(
        page.pageNumber,
        page.lines.map((line) => line.text.trim()).filter(Boolean),
      );
    }
  } catch (error) {
    if (
      (error as { code?: string })?.code !== "EMPTY_REPORT_PAGES" &&
      (error as { code?: string })?.code !== "EMPTY_REPORT_TEXT"
    )
      throw error;
  }
  return observations.map((observation) => ({
    ...observation,
    evidence: uniqueObservationEvidence(
      observation.evidence.flatMap((evidence) => {
        const quote = compactPersistedEvidence(evidence.quote);
        if (quote.length < 2) return [];
        const plannedCandidates = (
          plannedPages.get(evidence.pageNumber) || []
        ).flatMap((line) =>
          compactPersistedEvidence(line) === quote ? [{ line, score: 4 }] : [],
        );
        const rawCandidates = (pages.get(evidence.pageNumber) || [])
          .map((line) => {
            const source = compactPersistedEvidence(line);
            if (!source) return null;
            if (source === quote) return { line, score: 3 };
            if (source.includes(quote))
              return { line, score: 1 + quote.length / source.length };
            return null;
          })
          .filter((candidate): candidate is { line: string; score: number } =>
            Boolean(candidate),
          );
        const candidates = [...plannedCandidates, ...rawCandidates].sort(
          (left, right) =>
            right.score - left.score ||
            left.line.localeCompare(right.line, "zh-CN"),
        );
        return candidates[0]
          ? [{ pageNumber: evidence.pageNumber, quote: candidates[0].line }]
          : [];
      }),
    ),
  }));
}

/**
 * AI observation 必须形成 OCR 闭环后才可进入业务表。报告尚没有已完成 OCR 的兼容场景
 * 保持旧行为；正常 OCR + AI 流程中，无证据项仍保留在 report_extractions 原始结果内供审计，
 * 但不会污染报告详情、治理池和后续趋势计算。
 */
export function filterPersistableAiObservations(
  reportId: string,
  observations: AiObservation[],
) {
  const hasCompletedOcr = Boolean(
    getDatabase()
      .prepare(
        `
        SELECT 1 AS found
        FROM report_pages page
        JOIN ocr_results result ON result.page_id = page.id
        JOIN processing_jobs job ON job.id = result.job_id AND job.status = 'completed'
        WHERE page.report_id = ?
        LIMIT 1
      `,
      )
      .get(reportId),
  );
  if (!hasCompletedOcr) return observations;
  return observations.filter((observation) => observation.evidence.length > 0);
}

const currentResultHeaderPattern =
  /(?:实测|本次结果|检查结果|检验结果|测定值|当前结果|现结果|结果)/i;
const nonCurrentResultHeaderPattern =
  /(?:预测|预计|参考|正常|历史|既往|上次|前次|往年|百分比|%\s*pred|predicted)/i;

function tableHeaderCells(value: string | null | undefined) {
  return String(value || "")
    .normalize("NFKC")
    .split(/[|｜]/)
    .map((cell) => cell.trim());
}

function explicitCurrentResultColumn(line: PlannedOcrLine) {
  const cells = tableHeaderCells(line.tableHeaderText);
  const index = cells.findIndex(
    (cell) =>
      currentResultHeaderPattern.test(cell) &&
      !nonCurrentResultHeaderPattern.test(cell),
  );
  return index >= 0 ? { index, headerText: cells[index] } : null;
}

function localFactMatchScore(
  observation: AiObservation,
  fact: LocalObservationFact,
) {
  const observationNames = new Set(
    [observation.itemName, observation.normalizedName]
      .map(compactObservationIdentity)
      .filter(Boolean),
  );
  const factNames = new Set(
    [fact.itemName, fact.normalizedName]
      .map(compactObservationIdentity)
      .filter(Boolean),
  );
  const nameMatched = [...observationNames].some((name) => factNames.has(name));
  const resultMatched =
    compactObservationIdentity(observation.resultText) ===
    compactObservationIdentity(fact.resultText);
  const numericMatched =
    observation.numericValue !== null &&
    fact.numericValue !== null &&
    sameObservationNumber(observation.numericValue, fact.numericValue);
  return (
    (nameMatched ? 4 : 0) + (resultMatched ? 3 : 0) + (numericMatched ? 2 : 0)
  );
}

function bestLocalFact(observation: AiObservation, line: PlannedOcrLine) {
  return (
    localObservationsForLine(line)
      .map((fact) => ({ fact, score: localFactMatchScore(observation, fact) }))
      .filter((candidate) => candidate.score >= 5)
      .sort(
        (left, right) =>
          right.score - left.score ||
          left.fact.observationKey.localeCompare(right.fact.observationKey),
      )[0]?.fact || null
  );
}

function structuredTableEvidence(
  line: PlannedOcrLine,
  observation: AiObservation,
): AiTableEvidence | null {
  if (!line.tableHeaderText) return null;
  const fact = bestLocalFact(observation, line);
  const explicitResult = explicitCurrentResultColumn(line);
  const explicitCell =
    explicitResult === null
      ? null
      : line.sourceCells[explicitResult.index]?.text ||
        line.text.split(/[|｜]/)[explicitResult.index]?.trim() ||
        null;
  const explicitCellNumber = explicitCell?.match(
    /^(?:<|<=|≤|>|>=|≥)?\s*([-+]?\d+(?:\.\d+)?)/,
  )?.[1];
  const explicitMatchesObservation = Boolean(
    explicitCell &&
    (compactObservationIdentity(explicitCell) ===
      compactObservationIdentity(observation.resultText) ||
      (explicitCellNumber !== undefined &&
        observation.numericValue !== null &&
        sameObservationNumber(
          Number(explicitCellNumber),
          observation.numericValue,
        ))),
  );
  const verifiedExplicitResult = explicitMatchesObservation
    ? explicitResult
    : null;
  const resultIndex =
    fact?.sourceMap.result.cellIndices[0] ??
    verifiedExplicitResult?.index ??
    null;
  const resultHeader =
    fact?.sourceMap.result.headerText ||
    verifiedExplicitResult?.headerText ||
    null;
  return {
    headerText: line.tableHeaderText,
    headerSourceLineIds: [...new Set(line.tableHeaderSourceLineIds || [])],
    rowSourceLineIds: [...new Set(line.sourceLineIds)],
    resultColumn:
      resultIndex === null
        ? null
        : {
            index: resultIndex,
            headerText: resultHeader,
            selectionBasis:
              verifiedExplicitResult &&
              verifiedExplicitResult.index === resultIndex
                ? "explicit_current_result_header"
                : "local_source_map",
          },
    ...(fact ? { sourceMap: fact.sourceMap } : {}),
  };
}

/**
 * 证据完成 OCR 回指校验、观察项去重和最终结构清洗后，再从同一版输入规划中补充
 * 表头及列来源。模型返回的任何同名扩展字段都会在 evidenceValue 中被剥离，因此
 * 这里落库的结构化证据只能由本地 OCR 规划器生成，不信任 AI 自报的列位置。
 */
function enrichPersistedObservationEvidence(
  reportId: string,
  observations: AiObservation[],
) {
  let plannedPages: ReturnType<typeof buildAiExtractionPlan>["pages"] = [];
  try {
    plannedPages = buildAiExtractionPlan(reportId).pages;
  } catch (error) {
    if (
      (error as { code?: string })?.code !== "EMPTY_REPORT_PAGES" &&
      (error as { code?: string })?.code !== "EMPTY_REPORT_TEXT"
    )
      throw error;
  }
  const linesByPage = new Map<number, PlannedOcrLine[]>();
  for (const page of plannedPages) linesByPage.set(page.pageNumber, page.lines);
  return observations.map((observation) => ({
    ...observation,
    evidence: observation.evidence.map((evidence) => {
      const quote = compactPersistedEvidence(evidence.quote);
      const line = (linesByPage.get(evidence.pageNumber) || []).find(
        (candidate) => compactPersistedEvidence(candidate.text) === quote,
      );
      if (!line) return evidence;
      const table = structuredTableEvidence(line, observation);
      return table ? { ...evidence, table } : evidence;
    }),
  }));
}

function semanticObservationNames(observation: AiObservation) {
  const names = new Set<string>();
  const protectedSubtype = /^(?:igg|igm|iga|ige|igd|i型|ii型|ⅰ型|ⅱ型)$/i;
  const add = (value: string | null | undefined) => {
    const raw = value?.normalize("NFKC").trim();
    if (!raw) return;
    const variants = new Set([raw]);
    for (const match of raw.matchAll(/[（(]([^（）()]*)[）)]/g)) {
      const content = (match[1] || "").trim();
      if (!content || protectedSubtype.test(content)) continue;
      if (/^[A-Za-z][A-Za-z0-9.+#%\-]{0,15}$/.test(content)) {
        variants.add(raw.replace(match[0], " "));
      }
    }
    for (const variant of variants) {
      const semantic = compactObservationIdentity(variant)
        .replace(/^(?:血清|血浆|全血|尿液|尿)/, "")
        .replace(/(?:检测|测定|定量|检查|检验|结果)$/g, "");
      if (semantic.length >= 2) names.add(semantic);
    }
  };
  add(observation.itemName);
  add(observation.normalizedName);
  return names;
}

function observationNamesOverlap(left: Set<string>, right: Set<string>) {
  for (const name of left) {
    if (right.has(name)) return true;
  }
  return false;
}

function hasDescriptiveChineseObservationName(names: Set<string>) {
  return [...names].some(
    (name) => (name.match(/[\u3400-\u9fff]/g) || []).length >= 2,
  );
}

function observationIdentityNamesMatch(
  leftNames: Set<string>,
  rightNames: Set<string>,
  leftCanonicalKey: string | null,
  rightCanonicalKey: string | null,
) {
  if (observationNamesOverlap(leftNames, rightNames)) return true;
  return Boolean(
    leftCanonicalKey &&
    leftCanonicalKey === rightCanonicalKey &&
    (!hasDescriptiveChineseObservationName(leftNames) ||
      !hasDescriptiveChineseObservationName(rightNames)),
  );
}

/**
 * 单篇报告可能在汇总页和明细页重复展示同一结果。最终落库前按标准指标和值合并，
 * 同时保留所有来源页证据；明确的历史结果、标本或检测方法冲突不会被合并。
 */
export function deduplicateReportObservations(
  reportId: string,
  observations: AiObservation[],
) {
  observations = sanitizeReportObservations(observations);
  if (observations.length < 2) return observations;
  const report = getDatabase()
    .prepare(
      `
    SELECT report_type AS reportType, hospital_name_raw AS hospitalName,
      performing_department AS performingDepartment, reporting_department AS reportingDepartment
    FROM reports WHERE id = ?
  `,
    )
    .get(reportId) as
    | {
        reportType: string;
        hospitalName: string | null;
        performingDepartment: string | null;
        reportingDepartment: string | null;
      }
    | undefined;
  if (!report) return observations;

  const merged: AiObservation[] = [];
  const identities: Array<{
    names: Set<string>;
    canonicalKey: string | null;
    result: string;
    unit: string | null;
    temporalKind: string;
    measuredAt: string | null;
    specimen: string | null;
    method: string;
  }> = [];
  for (const [index, observation] of observations.entries()) {
    const normalized = normalizeObservation({
      id: `pending-${index}`,
      reportId,
      sectionName: observation.sectionName,
      itemCode: observation.itemCode,
      itemName: observation.itemName,
      normalizedName: observation.normalizedName,
      resultText: observation.resultText,
      numericValue: observation.numericValue,
      unit: observation.unit,
      referenceText: observation.referenceText,
      ...report,
    });
    const usesCanonicalValue = Boolean(
      normalized.canonicalKey &&
      ["high", "medium"].includes(normalized.quality),
    );
    const context = observationContext(observation);
    const safeDedupCanonicalKey = usesCanonicalValue
      ? normalized.canonicalKey
      : null;
    const identity = {
      names: semanticObservationNames(observation),
      canonicalKey: safeDedupCanonicalKey,
      result: observationResultIdentity(
        usesCanonicalValue
          ? normalized.canonicalValue
          : observation.numericValue,
        observation.resultText,
      ),
      unit:
        compactObservationIdentity(
          usesCanonicalValue ? normalized.canonicalUnit : observation.unit,
        ) || null,
      ...context,
    };
    const existingIndex = identities.findIndex(
      (candidate) =>
        observationIdentityNamesMatch(
          candidate.names,
          identity.names,
          candidate.canonicalKey,
          identity.canonicalKey,
        ) &&
        candidate.result === identity.result &&
        (!candidate.unit ||
          !identity.unit ||
          candidate.unit === identity.unit) &&
        candidate.temporalKind === identity.temporalKind &&
        (!candidate.measuredAt ||
          !identity.measuredAt ||
          candidate.measuredAt === identity.measuredAt) &&
        (!candidate.specimen ||
          !identity.specimen ||
          candidate.specimen === identity.specimen) &&
        (!candidate.method ||
          !identity.method ||
          candidate.method === identity.method),
    );
    if (existingIndex < 0) {
      merged.push(observation);
      identities.push(identity);
      continue;
    }
    merged[existingIndex] = mergeReportObservationPair(
      merged[existingIndex],
      observation,
    );
    identities[existingIndex] = {
      ...identities[existingIndex],
      names: new Set([...identities[existingIndex].names, ...identity.names]),
      canonicalKey:
        identities[existingIndex].canonicalKey || identity.canonicalKey,
      unit: identities[existingIndex].unit || identity.unit,
      measuredAt: identities[existingIndex].measuredAt || identity.measuredAt,
      specimen: identities[existingIndex].specimen || identity.specimen,
      method: identities[existingIndex].method || identity.method,
    };
  }
  return merged;
}

type ProtectedClinicalFact = {
  identity: string;
  evidenceJson: string;
};

function clinicalIdentity(...parts: Array<string | number | null | undefined>) {
  return parts
    .map((part) =>
      String(part ?? "")
        .normalize("NFKC")
        .toLowerCase()
        .replace(/[\s（）()·:：,，。]/g, ""),
    )
    .join("|");
}

function clinicalEvidenceKeys(value: string | AiEvidence[]) {
  let evidence: AiEvidence[] = [];
  try {
    evidence =
      typeof value === "string" ? (JSON.parse(value) as AiEvidence[]) : value;
  } catch {
    evidence = [];
  }
  return new Set(
    evidence.map(
      (item) =>
        `${item.pageNumber}|${item.quote.normalize("NFKC").replace(/\s+/g, "").slice(0, 180)}`,
    ),
  );
}

function clinicalFactProtected(
  protectedRows: ProtectedClinicalFact[],
  identity: string,
  evidence: AiEvidence[],
) {
  const incomingEvidence = clinicalEvidenceKeys(evidence);
  return protectedRows.some((row) => {
    if (row.identity === identity) return true;
    const protectedEvidence = clinicalEvidenceKeys(row.evidenceJson);
    return [...incomingEvidence].some((key) => protectedEvidence.has(key));
  });
}

function protectedClinicalFacts(reportId: string) {
  const db = getDatabase();
  const where =
    "report_id = ? AND (source = 'manual' OR json_array_length(manual_fields_json) > 0)";
  return {
    diagnoses: (
      db
        .prepare(
          `
      SELECT diagnosis_type AS type, diagnosis_text AS name, diagnosis_code AS code,
        evidence_json AS evidenceJson FROM report_diagnoses WHERE ${where}
    `,
        )
        .all(reportId) as Array<{
        type: string;
        name: string;
        code: string | null;
        evidenceJson: string;
      }>
    ).map((row) => ({
      identity: clinicalIdentity(row.type, row.name, row.code),
      evidenceJson: row.evidenceJson,
    })),
    medications: (
      db
        .prepare(
          `
      SELECT medication_context AS type, medication_name AS name,
        evidence_json AS evidenceJson FROM report_medications WHERE ${where}
    `,
        )
        .all(reportId) as Array<{
        type: string;
        name: string;
        evidenceJson: string;
      }>
    ).map((row) => ({
      identity: clinicalIdentity(row.type, row.name),
      evidenceJson: row.evidenceJson,
    })),
    procedures: (
      db
        .prepare(
          `
      SELECT procedure_type AS type, procedure_name AS name, procedure_code AS code,
        evidence_json AS evidenceJson FROM report_procedures WHERE ${where}
    `,
        )
        .all(reportId) as Array<{
        type: string;
        name: string;
        code: string | null;
        evidenceJson: string;
      }>
    ).map((row) => ({
      identity: clinicalIdentity(row.type, row.name, row.code),
      evidenceJson: row.evidenceJson,
    })),
    vaccinations: (
      db
        .prepare(
          `
      SELECT vaccine_name AS name, dose_number AS dose, administered_at AS date,
        evidence_json AS evidenceJson FROM vaccination_records WHERE ${where}
    `,
        )
        .all(reportId) as Array<{
        name: string;
        dose: string | null;
        date: string | null;
        evidenceJson: string;
      }>
    ).map((row) => ({
      identity: clinicalIdentity(row.name, row.dose, row.date),
      evidenceJson: row.evidenceJson,
    })),
    billingItems: (
      db
        .prepare(
          `
      SELECT category, item_name AS name, evidence_json AS evidenceJson
      FROM billing_items WHERE ${where}
    `,
        )
        .all(reportId) as Array<{
        category: string | null;
        name: string;
        evidenceJson: string;
      }>
    ).map((row) => ({
      identity: clinicalIdentity(row.category, row.name),
      evidenceJson: row.evidenceJson,
    })),
    billingSummary: db
      .prepare(
        `
      SELECT id FROM billing_summaries WHERE ${where} LIMIT 1
    `,
      )
      .get(reportId) as { id: string } | undefined,
  };
}

function protectedStructuredSections(reportId: string) {
  return (
    getDatabase()
      .prepare(
        `
    SELECT section_key AS sectionKey, evidence_json AS evidenceJson
    FROM report_structured_sections
    WHERE report_id = ? AND (source = 'manual' OR json_array_length(manual_fields_json) > 0)
  `,
      )
      .all(reportId) as Array<{ sectionKey: string; evidenceJson: string }>
  ).map((row) => ({
    identity: clinicalIdentity(row.sectionKey),
    evidenceJson: row.evidenceJson,
  }));
}

export function persistAiExtraction(
  reportId: string,
  jobId: string,
  result: AiExtractionResult,
  inputCharacters: number,
) {
  const db = getDatabase();
  const existing = db
    .prepare("SELECT 1 AS found FROM report_extractions WHERE job_id = ?")
    .get(jobId) as { found: number } | undefined;
  if (existing) return normalizeReportObservations(reportId);
  const initial = normalizeAiExtraction({
    ...result.fields,
    evidence: result.evidence,
    confidence: result.confidence,
  });
  const normalized = normalizeAiExtraction({
    ...initial.fields,
    observations: deduplicateReportObservations(
      reportId,
      filterPersistableAiObservations(
        reportId,
        validatePersistedObservationEvidence(
          reportId,
          initial.fields.observations,
        ),
      ),
    ),
    morphologyFindings: deduplicateReportMorphologyFindings(
      initial.fields.morphologyFindings,
    ),
    evidence: initial.evidence,
    confidence: initial.confidence,
  });
  const fields = {
    ...normalized.fields,
    observations: enrichPersistedObservationEvidence(
      reportId,
      normalized.fields.observations,
    ),
  };
  const observationsWithOverrides = applyObservationFieldOverrides(
    reportId,
    fields.observations,
  );
  const deterministicDates = deterministicReportDates(reportId);
  const protectedRows = protectedMorphologyRows(reportId);
  const protectedClinical = protectedClinicalFacts(reportId);
  const protectedSections = protectedStructuredSections(reportId);
  const usedProtected = new Set<string>();
  const manualFieldKeys = listManualReportFieldKeys(reportId);
  const job = db
    .prepare(
      `
    SELECT pipeline_version AS pipelineVersion, deduplication_key AS deduplicationKey
    FROM processing_jobs
    WHERE id = ? AND report_id = ?
  `,
    )
    .get(jobId, reportId) as
    | {
        pipelineVersion: string;
        deduplicationKey: string;
      }
    | undefined;
  const replacesGeneratedFields =
    job?.pipelineVersion === "manual-reprocess-v1" ||
    job?.pipelineVersion === "manual-ai-v1" ||
    job?.deduplicationKey.includes(":ai_extract:manual:") === true;
  const resetFields = replacesGeneratedFields
    ? reportFieldDefinitions.filter((field) => !manualFieldKeys.has(field.key))
    : [];
  const updates: string[] = [];
  const values: Array<string | number> = [];
  const set = (
    fieldKey: ReportFieldKey,
    column: string,
    value: string | number | null | undefined,
  ) => {
    if (manualFieldKeys.has(fieldKey)) return;
    if (value === null || value === undefined || value === "") return;
    updates.push(`${column} = ?`);
    values.push(value);
  };
  const generatedTitle = buildReportTitle(fields);
  if (fields.reportType === "checkup") {
    fields.bodyParts = fields.bodyParts.filter(
      (item) =>
        !/^(?:综合体检|健康体检|体检|physicalexam|checkup)$/i.test(
          `${item.name || item.raw}`.normalize("NFKC").replace(/[\s_-]+/g, ""),
        ),
    );
  }
  if (!manualFieldKeys.has("title")) {
    updates.push(
      replacesGeneratedFields
        ? "title = ?"
        : "title = CASE WHEN title = '待识别报告' THEN ? ELSE title END",
    );
    values.push(generatedTitle);
  }
  set("reportType", "report_type", fields.reportType);
  set("reportSubtype", "report_subtype", fields.reportSubtype);
  set("hospitalName", "hospital_name_raw", fields.hospitalNameRaw);
  set("hospitalBranch", "hospital_branch", fields.hospitalBranch);
  set("city", "city", fields.city);
  set("visitType", "visit_type", fields.visitType);
  set("departmentName", "visit_department", fields.visitDepartment);
  set("orderingDepartment", "ordering_department", fields.orderingDepartment);
  set(
    "performingDepartment",
    "performing_department",
    fields.performingDepartment,
  );
  set(
    "reportingDepartment",
    "reporting_department",
    fields.reportingDepartment,
  );
  set("inpatientWard", "inpatient_ward", fields.inpatientWard);
  set("bodyParts", "body_parts_json", JSON.stringify(fields.bodyParts));
  set("identifiers", "identifiers_json", JSON.stringify(fields.identifiers));
  set(
    "reportIssuedAt",
    "report_issued_at",
    deterministicDates.reportIssuedAt || fields.reportIssuedAt,
  );
  set(
    "examinedAt",
    "examined_at",
    deterministicDates.examinedAt || fields.examinedAt,
  );
  set("orderedAt", "ordered_at", fields.orderedAt);
  set("sampledAt", "sampled_at", fields.sampledAt);
  set("receivedAt", "received_at", fields.receivedAt);
  set("reviewedAt", "reviewed_at", fields.reviewedAt);
  set("admittedAt", "admitted_at", fields.admittedAt);
  set("dischargedAt", "discharged_at", fields.dischargedAt);
  if (Object.keys(fields.clinicians).length)
    set("clinicians", "clinicians_json", JSON.stringify(fields.clinicians));
  set("clinicalDiagnosis", "clinical_diagnosis", fields.clinicalDiagnosis);
  set("purpose", "purpose", fields.purpose);
  set("chiefComplaint", "chief_complaint", fields.chiefComplaint);
  set("findings", "findings", fields.findings);
  set("impression", "impression", fields.impression);
  set("summary", "summary", fields.summary);
  set("recommendation", "recommendation", fields.recommendation);

  db.exec("BEGIN IMMEDIATE");
  try {
    if (resetFields.length) {
      db.prepare(
        `
        UPDATE reports SET
          ${resetFields.map((field) => `${field.column} = ?`).join(",\n          ")},
          organization_id = NULL
        WHERE id = ?
      `,
      ).run(...resetFields.map((field) => field.resetValue), reportId);
    }
    db.prepare(
      `UPDATE reports SET ${updates.length ? `${updates.join(", ")}, ` : ""}source_version = source_version + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    ).run(...values, reportId);
    db.prepare("DELETE FROM observations WHERE report_id = ?").run(reportId);
    for (const applied of observationsWithOverrides) {
      const observation = applied.observation;
      const observationId = createId("obs");
      const displayAbnormal = deriveObservationDisplayAbnormal({
        storedFlag: observation.abnormalFlag,
        resultText: observation.resultText,
        supportingText: observation.evidence.map((entry) => entry.quote || null),
        numericValue: observation.numericValue,
        referenceLow: observation.referenceLow,
        referenceHigh: observation.referenceHigh,
        referenceText: observation.referenceText,
      });
      db.prepare(
        `
        INSERT INTO observations (
          id, report_id, section_name, item_code, item_name, normalized_name, result_text,
          numeric_value, unit, reference_low, reference_high, reference_text, abnormal_flag,
          display_abnormal_flag, abnormal_conflict, method, evidence_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      ).run(
        observationId,
        reportId,
        observation.sectionName,
        observation.itemCode,
        observation.itemName,
        observation.normalizedName,
        observation.resultText,
        observation.numericValue,
        observation.unit,
        observation.referenceLow,
        observation.referenceHigh,
        observation.referenceText,
        observation.abnormalFlag,
        displayAbnormal.displayAbnormalFlag,
        displayAbnormal.abnormalConflict ? 1 : 0,
        observation.method,
        JSON.stringify(observation.evidence),
      );
      if (applied.overrideId) {
        bindObservationFieldOverride(applied.overrideId, observationId);
      }
    }
    /* 血型等成员固有属性随提取结果沉淀到成员档案（仅填空、人工优先） */
    backfillMemberBloodTypeFromReport(
      reportId,
      observationsWithOverrides.map((item) => item.observation),
    );
    db.prepare(
      `
      DELETE FROM report_diagnoses
      WHERE report_id = ? AND source <> 'manual' AND json_array_length(manual_fields_json) = 0
    `,
    ).run(reportId);
    for (const diagnosis of fields.diagnoses) {
      if (
        clinicalFactProtected(
          protectedClinical.diagnoses,
          clinicalIdentity(
            diagnosis.diagnosisType,
            diagnosis.diagnosisText,
            diagnosis.diagnosisCode,
          ),
          diagnosis.evidence,
        )
      )
        continue;
      db.prepare(
        `
        INSERT INTO report_diagnoses (
          id, report_id, section_name, diagnosis_type, diagnosis_text,
          diagnosis_code, code_system, is_primary, evidence_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      ).run(
        createId("diagnosis"),
        reportId,
        diagnosis.sectionName,
        diagnosis.diagnosisType,
        diagnosis.diagnosisText,
        diagnosis.diagnosisCode,
        diagnosis.codeSystem,
        diagnosis.isPrimary ? 1 : 0,
        JSON.stringify(diagnosis.evidence),
      );
    }
    db.prepare(
      `
      DELETE FROM report_medications
      WHERE report_id = ? AND source <> 'manual' AND json_array_length(manual_fields_json) = 0
    `,
    ).run(reportId);
    for (const medication of fields.medications) {
      if (
        clinicalFactProtected(
          protectedClinical.medications,
          clinicalIdentity(medication.context, medication.medicationName),
          medication.evidence,
        )
      )
        continue;
      db.prepare(
        `
        INSERT INTO report_medications (
          id, report_id, section_name, medication_context, medication_name, generic_name,
          specification, dosage_form, dose, dose_unit, frequency, route, duration,
          quantity, quantity_unit, instructions, evidence_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      ).run(
        createId("medication"),
        reportId,
        medication.sectionName,
        medication.context,
        medication.medicationName,
        medication.genericName,
        medication.specification,
        medication.dosageForm,
        medication.dose,
        medication.doseUnit,
        medication.frequency,
        medication.route,
        medication.duration,
        medication.quantity,
        medication.quantityUnit,
        medication.instructions,
        JSON.stringify(medication.evidence),
      );
    }
    db.prepare(
      `
      DELETE FROM report_procedures
      WHERE report_id = ? AND source <> 'manual' AND json_array_length(manual_fields_json) = 0
    `,
    ).run(reportId);
    for (const procedure of fields.procedures) {
      if (
        clinicalFactProtected(
          protectedClinical.procedures,
          clinicalIdentity(
            procedure.procedureType,
            procedure.procedureName,
            procedure.procedureCode,
          ),
          procedure.evidence,
        )
      )
        continue;
      db.prepare(
        `
        INSERT INTO report_procedures (
          id, report_id, section_name, procedure_type, procedure_name, procedure_code,
          body_part, performed_at, result_text, evidence_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      ).run(
        createId("procedure"),
        reportId,
        procedure.sectionName,
        procedure.procedureType,
        procedure.procedureName,
        procedure.procedureCode,
        procedure.bodyPart,
        procedure.performedAt,
        procedure.resultText,
        JSON.stringify(procedure.evidence),
      );
    }
    db.prepare(
      `
      DELETE FROM vaccination_records
      WHERE report_id = ? AND source <> 'manual' AND json_array_length(manual_fields_json) = 0
    `,
    ).run(reportId);
    for (const vaccination of fields.vaccinations) {
      if (
        clinicalFactProtected(
          protectedClinical.vaccinations,
          clinicalIdentity(
            vaccination.vaccineName,
            vaccination.doseNumber,
            vaccination.administeredAt,
          ),
          vaccination.evidence,
        )
      )
        continue;
      db.prepare(
        `
        INSERT INTO vaccination_records (
          id, report_id, vaccine_name, dose_number, manufacturer, lot_number,
          administered_at, administration_site, next_due_at, evidence_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      ).run(
        createId("vaccination"),
        reportId,
        vaccination.vaccineName,
        vaccination.doseNumber,
        vaccination.manufacturer,
        vaccination.lotNumber,
        vaccination.administeredAt,
        vaccination.administrationSite,
        vaccination.nextDueAt,
        JSON.stringify(vaccination.evidence),
      );
    }
    db.prepare(
      `
      DELETE FROM billing_items
      WHERE report_id = ? AND source <> 'manual' AND json_array_length(manual_fields_json) = 0
    `,
    ).run(reportId);
    db.prepare(
      `
      DELETE FROM billing_summaries
      WHERE report_id = ? AND source <> 'manual' AND json_array_length(manual_fields_json) = 0
    `,
    ).run(reportId);
    if (fields.billingSummary && !protectedClinical.billingSummary) {
      db.prepare(
        `
        INSERT INTO billing_summaries (
          id, report_id, invoice_number, total_amount, insurance_amount,
          self_pay_amount, currency, evidence_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      ).run(
        createId("billing"),
        reportId,
        fields.billingSummary.invoiceNumber,
        fields.billingSummary.totalAmount,
        fields.billingSummary.insuranceAmount,
        fields.billingSummary.selfPayAmount,
        fields.billingSummary.currency,
        JSON.stringify(fields.billingSummary.evidence),
      );
    }
    for (const item of fields.billingItems) {
      if (
        clinicalFactProtected(
          protectedClinical.billingItems,
          clinicalIdentity(item.category, item.itemName),
          item.evidence,
        )
      )
        continue;
      db.prepare(
        `
        INSERT INTO billing_items (
          id, report_id, category, item_name, amount, quantity, evidence_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      ).run(
        createId("billingitem"),
        reportId,
        item.category,
        item.itemName,
        item.amount,
        item.quantity,
        JSON.stringify(item.evidence),
      );
    }
    db.prepare(
      `
      DELETE FROM report_structured_sections
      WHERE report_id = ? AND source <> 'manual' AND json_array_length(manual_fields_json) = 0
    `,
    ).run(reportId);
    for (const section of fields.reportSections) {
      if (
        clinicalFactProtected(
          protectedSections,
          clinicalIdentity(section.sectionKey),
          section.evidence,
        )
      )
        continue;
      db.prepare(
        `
        INSERT INTO report_structured_sections (
          id, report_id, section_key, section_title, content_text, evidence_json
        ) VALUES (?, ?, ?, ?, ?, ?)
      `,
      ).run(
        createId("section"),
        reportId,
        section.sectionKey,
        section.title,
        section.content,
        JSON.stringify(section.evidence),
      );
    }
    db.prepare(
      `
      DELETE FROM morphology_findings
      WHERE report_id = ? AND json_array_length(manual_fields_json) = 0
    `,
    ).run(reportId);
    for (const finding of fields.morphologyFindings) {
      const old = matchProtectedMorphology(
        finding,
        protectedRows,
        usedProtected,
      );
      if (old) usedProtected.add(old.id);
      const protectedValue = protectedFindingValues(finding, old);
      db.prepare(
        `
        INSERT INTO morphology_findings (
          id, report_id, section_name, organ, region, laterality, finding_type, finding_name,
          presence, finding_count, size_length, size_width, size_height, size_unit,
          measurements_json, morphology_text, attributes_json, classification_system,
          classification_value, classification_text, comparison_text, raw_text,
          evidence_json, confidence, tracking_group_id, match_confidence, source, manual_fields_json
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        )
        ON CONFLICT(id) DO UPDATE SET
          section_name = excluded.section_name, organ = excluded.organ, region = excluded.region,
          laterality = excluded.laterality, finding_type = excluded.finding_type,
          finding_name = excluded.finding_name, presence = excluded.presence,
          finding_count = excluded.finding_count, size_length = excluded.size_length,
          size_width = excluded.size_width, size_height = excluded.size_height,
          size_unit = excluded.size_unit, measurements_json = excluded.measurements_json,
          morphology_text = excluded.morphology_text, attributes_json = excluded.attributes_json,
          classification_system = excluded.classification_system,
          classification_value = excluded.classification_value,
          classification_text = excluded.classification_text, comparison_text = excluded.comparison_text,
          raw_text = excluded.raw_text, evidence_json = excluded.evidence_json,
          confidence = excluded.confidence, tracking_group_id = excluded.tracking_group_id,
          match_confidence = excluded.match_confidence, source = excluded.source,
          manual_fields_json = excluded.manual_fields_json, updated_at = CURRENT_TIMESTAMP
      `,
      ).run(
        protectedValue.id,
        reportId,
        finding.sectionName,
        protectedValue.organ,
        protectedValue.region,
        protectedValue.laterality,
        protectedValue.findingType,
        protectedValue.findingName,
        protectedValue.presence,
        protectedValue.findingCount,
        protectedValue.size.length,
        protectedValue.size.width,
        protectedValue.size.height,
        protectedValue.size.unit,
        JSON.stringify(finding.measurements),
        protectedValue.morphology,
        JSON.stringify(finding.attributes),
        protectedValue.classification?.system || null,
        protectedValue.classification?.value || null,
        protectedValue.classification?.text || null,
        finding.comparisonText,
        finding.rawText,
        JSON.stringify(finding.evidence),
        finding.confidence,
        protectedValue.trackingGroupId,
        protectedValue.matchConfidence,
        protectedValue.source,
        protectedValue.manualFieldsJson,
      );
    }
    db.prepare(
      `
      INSERT INTO report_extractions (
        id, report_id, job_id, provider, model, prompt_version, fields_json, evidence_json,
        confidence_json, raw_response_json, input_characters, prompt_tokens, completion_tokens, elapsed_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(job_id) DO UPDATE SET
        provider = excluded.provider, model = excluded.model, prompt_version = excluded.prompt_version,
        fields_json = excluded.fields_json, evidence_json = excluded.evidence_json,
        confidence_json = excluded.confidence_json, raw_response_json = excluded.raw_response_json,
        input_characters = excluded.input_characters, prompt_tokens = excluded.prompt_tokens,
        completion_tokens = excluded.completion_tokens, elapsed_ms = excluded.elapsed_ms
    `,
    ).run(
      createId("extract"),
      reportId,
      jobId,
      result.provider,
      result.model,
      result.promptVersion,
      JSON.stringify(fields),
      JSON.stringify(normalized.evidence),
      JSON.stringify(normalized.confidence),
      JSON.stringify({
        ...fields,
        evidence: normalized.evidence,
        confidence: normalized.confidence,
      }),
      inputCharacters,
      result.promptTokens,
      result.completionTokens,
      result.elapsedMs,
    );
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return normalizeReportObservations(reportId);
}
