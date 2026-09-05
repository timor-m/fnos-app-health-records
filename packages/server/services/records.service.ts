import {
  checkpointDatabase,
  closeDatabase,
  getDatabase,
  getDatabasePath,
  getDatabaseStatus,
} from "../database/client";
import { createError } from "h3";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { isAdministrator, type RequestUser } from "../domain/request-user";
import type {
  CursorPage,
  DuplicateReportCandidate,
  DuplicateReportGroup,
  ReportDuplicateComparison,
  DuplicateReportOverview,
  ReportDuplicateMetrics,
  ReportDuplicateOperationRecord,
  BillingItem,
  BillingSummary,
  MorphologyFinding,
  Observation,
  ReportDiagnosis,
  ReportDetail,
  ReportMedication,
  ReportPage,
  ReportProcedure,
  ReportStructuredSection,
  ReportSummary,
  VaccinationRecord,
} from "../domain/health-record";
import { isAiReportStructuredSectionCompatible } from "../domain/health-record";
import { getAppConfig } from "../utils/runtime-config";
import { createId } from "../utils/identifier";
import { schemaVersion } from "../database/schema";
import { assertMemberAccess, assertMemberManage } from "./member.service";
import { assessReportMemberIdentity } from "./report-member-identity.service";
import {
  defaultOcrPdfRenderScale,
  requestWorker,
} from "./ocr-worker-client";
import { isGenericReportTitle } from "./ai-extraction.service";
import {
  trendPlacementFor,
  type TrendPlacement,
} from "../domain/indicator-dictionary/trend-taxonomy";
import {
  convertUnit,
  ensureBuiltinIndicatorCatalog,
  isPolicyFilteredNormalization,
} from "./indicator-normalization.service";
import {
  getJobRunnerStatus,
  isReportJobActive,
  startJobRunner,
  stopJobRunner,
} from "./job-runner.service";
import { enqueueFileGarbage } from "./file-gc.service";
import {
  captureRestoringAdministratorCredential,
  rebindRestoredAdministrator,
} from "./restore-identity.service";
import {
  listManualReportFieldKeys,
  reportFieldDefinitions,
  upsertManualReportFieldOverrides,
  type ReportFieldKey,
} from "./report-field-overrides.service";
import { findLocalDuplicateEvidence } from "./report-duplicate-precheck.service";
import {
  listReportDuplicateDecisions,
  recordReportDuplicateMerge,
  reportDuplicatePairKey,
  reportFileSignature,
  shouldCollapseReportPair,
} from "./report-duplicate-governance.service";
import { reportStructuredSectionLabels } from "./report-structured-section.service";
import {
  assessObservationInterpretation,
  parseDictionaryReferenceRange,
  type ObservationAbnormalSource,
  type ObservationAbnormalStatus,
} from "./observation-interpretation.service";
import {
  assessObservationReference,
  type ObservationReferenceStatus,
} from "./observation-reference.service";
import { assessTrendComparability } from "./trend-comparability.service";
import { assessTrendChange } from "./trend-change-assessment.service";
import { assessTrendAbnormalContinuity } from "./trend-abnormal-continuity.service";
import {
  reportDuplicateRuleConfig,
  resolveReportDuplicateRuleSelection,
  type ReportDuplicateRuleSelection,
  type ReportDuplicateRuleSnapshot,
  type ReportDuplicateRuleVersion,
} from "./report-duplicate-rules.service";

type ReportCursor = { sortDate: string | null; id: string };
export type ReportSort = "report_date_desc" | "report_date_asc" | "created_desc";
export type ReportFilters = {
  memberId?: string;
  cursor?: string;
  query?: string;
  reportType?: string;
  status?: string;
  dateFrom?: string;
  dateTo?: string;
  ocrQuery?: string;
  trash?: boolean;
  sort?: ReportSort;
};

const displayDepartmentSql = `
  COALESCE(
    r.performing_department,
    r.visit_department,
    r.reporting_department,
    r.ordering_department,
    CASE WHEN r.report_type = 'checkup' THEN '综合体检' END
  )
`;

/* 报告级异常计数按标准化指标去重：同一 canonical 指标在报告内出现多次
   （如两套身高/体重/BMI 测量值）只计 1 项；未匹配的观察按自身 id 计数。 */
const reportAbnormalCountSql = `
  (SELECT COUNT(DISTINCT COALESCE(NULLIF(n.canonical_key, ''), o.id))
   FROM observations o
   LEFT JOIN observation_normalizations n ON n.observation_id = o.id
   WHERE o.report_id = r.id AND o.display_abnormal_flag IN ('high', 'low', 'abnormal') AND o.abnormal_conflict = 0) AS abnormalCount
 `;

/* 报告展示日期：部分报告缺少“报告时间”（OCR 粘连或版式缺失），按审核→接收→检查→采样→申请
   依次借用同报告的真实时间，避免列表、详情与趋势点出现“日期待确认”。 */
const reportDisplayDateSql = `
  COALESCE(r.report_issued_at, r.reviewed_at, r.received_at, r.examined_at, r.sampled_at, r.ordered_at)
`;

function decodeCursor(value?: string): ReportCursor | null {
  if (!value) return null;
  try {
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    const separator = decoded.lastIndexOf("|");
    if (separator < 0) return null;
    const sortDate = decoded.slice(0, separator) || null;
    const id = decoded.slice(separator + 1);
    return id ? { sortDate, id } : null;
  } catch {
    return null;
  }
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function storagePath(relativePath: string) {
  const root = resolve(getAppConfig().storageDir);
  const target = resolve(root, relativePath);
  if (target !== root && !target.startsWith(`${root}/`)) {
    throw createError({ statusCode: 400, statusMessage: "文件路径无效" });
  }
  return target;
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

function normalizeContentKey(value: string | null | undefined) {
  return (value || "")
    .toLocaleLowerCase("zh-CN")
    .replace(/\s+/g, "")
    .replace(/[（）()[\]【】{}<>《》:：,，.。;；、/\\|_-]/g, "")
    .trim();
}

function hospitalNamesEquivalent(
  current: string | null | undefined,
  candidate: string | null | undefined,
) {
  const left = normalizeContentKey(current);
  const right = normalizeContentKey(candidate);
  if (!left || !right) return false;
  if (left === right) return true;

  const shorter = left.length < right.length ? left : right;
  const longer = left.length < right.length ? right : left;
  /* 仅识别“地区/院区前缀 + 完整机构名”这类保守包含关系。
     短品牌名或“人民医院”等泛称不能单独作为同一机构依据。 */
  return (
    shorter.length >= 6 &&
    shorter.length / longer.length >= 0.55 &&
    longer.includes(shorter)
  );
}

function datePart(value: string | null | undefined) {
  return (value || "").slice(0, 10);
}

function firstBodyPart(value: string | null | undefined) {
  const parts = parseJson<Array<{ name?: string; raw?: string }>>(value, []);
  return parts[0]?.name || parts[0]?.raw || null;
}

function sharedIdentifierMatches(
  current: Record<string, string>,
  candidate: Record<string, string>,
) {
  return Object.entries(current)
    .filter(([, value]) => normalizeContentKey(value).length >= 3)
    .flatMap(([key, value]) => {
      const candidateValue = candidate[key];
      if (!candidateValue) return [];
      return normalizeContentKey(value) === normalizeContentKey(candidateValue)
        ? [key]
        : [];
    });
}

function textSimilarityMatched(
  current: string | null | undefined,
  candidate: string | null | undefined,
) {
  const left = normalizeContentKey(current);
  const right = normalizeContentKey(candidate);
  if (left.length < 12 || right.length < 12) return false;
  return (
    left === right ||
    left.includes(right.slice(0, Math.min(40, right.length))) ||
    right.includes(left.slice(0, Math.min(40, left.length)))
  );
}

function isInformativeDuplicateTitle(value: string | null | undefined) {
  const title = (value || "").trim();
  const normalized = normalizeContentKey(title);
  if (normalized.length < 6) return false;
  if (
    [
      "待识别报告",
      "报告",
      "检查报告",
      "检查报告单",
      "检验报告",
      "检验报告单",
      "体检报告",
      "体检报告单",
    ].includes(title)
  )
    return false;
  return !isGenericReportTitle(title);
}

function titleSimilarityMatched(
  current: string | null | undefined,
  candidate: string | null | undefined,
) {
  if (
    !isInformativeDuplicateTitle(current) ||
    !isInformativeDuplicateTitle(candidate)
  )
    return false;
  const left = normalizeContentKey(current);
  const right = normalizeContentKey(candidate);
  if (left === right) return true;
  const shorter = left.length < right.length ? left : right;
  const longer = left.length < right.length ? right : left;
  return shorter.length >= 8 && longer.includes(shorter);
}

function observationSignature(
  reportId: string,
  cache?: Map<string, Set<string>>,
) {
  const cached = cache?.get(reportId);
  if (cached) return cached;
  const signature = new Set(
    getDatabase()
      .prepare(
        `
    SELECT
      CASE
        WHEN n.quality IN ('high', 'medium') AND n.canonical_key IS NOT NULL THEN n.canonical_key
        ELSE COALESCE(NULLIF(TRIM(o.normalized_name), ''), o.item_name)
      END AS name,
      o.result_text AS resultText,
      CASE
        WHEN n.quality IN ('high', 'medium') THEN COALESCE(n.canonical_value, o.numeric_value)
        ELSE o.numeric_value
      END AS numericValue
    FROM observations o
    LEFT JOIN observation_normalizations n ON n.observation_id = o.id
    WHERE o.report_id = ?
    ORDER BY o.section_name, o.item_name, o.id
    LIMIT 200
  `,
      )
      .all(reportId)
      .flatMap((row) => {
        const item = row as {
          name: string;
          resultText: string;
          numericValue: number | null;
        };
        const name = normalizeContentKey(item.name);
        const parsedNumber =
          item.numericValue ?? parseNumericResultText(item.resultText);
        const result =
          parsedNumber === null
            ? normalizeContentKey(item.resultText)
            : String(parsedNumber);
        if (!name || !result) return [];
        return [`${name}:${result}`];
      }),
  );
  cache?.set(reportId, signature);
  return signature;
}

function sharedObservationStats(
  currentReportId: string,
  candidateReportId: string,
  cache?: Map<string, Set<string>>,
) {
  const current = observationSignature(currentReportId, cache);
  if (!current.size) {
    return {
      shared: 0,
      currentSize: 0,
      candidateSize: 0,
      overlapRatio: 0,
      largerOverlapRatio: 0,
    };
  }
  const candidate = observationSignature(candidateReportId, cache);
  let count = 0;
  for (const item of candidate) {
    if (current.has(item)) count += 1;
  }
  return {
    shared: count,
    currentSize: current.size,
    candidateSize: candidate.size,
    overlapRatio: count / Math.max(1, Math.min(current.size, candidate.size)),
    largerOverlapRatio:
      count / Math.max(1, Math.max(current.size, candidate.size)),
  };
}

function hasStrongObservationOverlap(
  stats: ReturnType<typeof sharedObservationStats>,
) {
  if (stats.shared >= 10) return true;
  if (
    stats.shared >= 6 &&
    stats.overlapRatio >= 0.75 &&
    stats.largerOverlapRatio >= 0.3
  )
    return true;
  return (
    stats.shared >= 3 &&
    stats.overlapRatio >= 0.9 &&
    stats.largerOverlapRatio >= 0.5
  );
}

type DuplicateSourceRow = ReportSummary & {
  city: string | null;
  visitType: string | null;
  orderingDepartment: string | null;
  performingDepartment: string | null;
  reportingDepartment: string | null;
  bodyPartsJson: string;
  identifiersJson: string;
  examinedAt: string | null;
  sampledAt: string | null;
  receivedAt: string | null;
  reviewedAt: string | null;
  findings: string | null;
  impression: string | null;
  summary: string | null;
  sourceVersion: number;
  updatedAt: string;
};

export const duplicateReportScanPolicy = {
  sourceReportLimit: 300,
  candidateWindowLimit: 80,
  automaticCandidateReturnLimit: 5,
} as const;

function normalizedDuplicateSignals(matchedFields: unknown) {
  if (!Array.isArray(matchedFields)) return [];
  return [
    ...new Set(
      matchedFields.flatMap((item) => {
        const signal = String(item || "").trim();
        if (!signal || signal === "人工治理") return [];
        if (/^指标\d+项$/.test(signal)) return ["指标重叠"];
        if (["报告日期", "检查日期", "报告/检查日期"].includes(signal))
          return ["报告/检查日期"];
        if (signal === "医疗编号" || signal.startsWith("编号:"))
          return ["医疗编号"];
        return [signal];
      }),
    ),
  ].sort((left, right) => left.localeCompare(right, "zh-CN"));
}

function duplicateDecisionsByPartner(memberId: string, reportId: string) {
  const rows = getDatabase()
    .prepare(
      `
    SELECT left_report_id AS leftReportId, right_report_id AS rightReportId,
      decision, reason, evidence_json AS evidenceJson
    FROM report_duplicate_decisions
    WHERE member_id = ? AND (left_report_id = ? OR right_report_id = ?)
    ORDER BY updated_at DESC, pair_key
  `,
    )
    .all(memberId, reportId, reportId) as Array<{
    leftReportId: string;
    rightReportId: string;
    decision: "duplicate" | "distinct";
    reason: string | null;
    evidenceJson: string;
  }>;
  return new Map(
    rows.map((row) => [
      row.leftReportId === reportId ? row.rightReportId : row.leftReportId,
      {
        decision: row.decision,
        reason: row.reason,
        evidenceJson: row.evidenceJson,
      },
    ]),
  );
}

function governedDuplicateReportIds(memberId: string) {
  const rows = getDatabase()
    .prepare(
      `
    SELECT left_report_id AS leftReportId, right_report_id AS rightReportId
    FROM report_duplicate_decisions
    WHERE member_id = ? AND decision = 'duplicate'
    ORDER BY updated_at DESC, pair_key
  `,
    )
    .all(memberId) as Array<{ leftReportId: string; rightReportId: string }>;
  return [
    ...new Set(rows.flatMap((row) => [row.leftReportId, row.rightReportId])),
  ];
}

function duplicateSourceRowsByIds(memberId: string, reportIds: string[]) {
  if (!reportIds.length) return [];
  const placeholders = reportIds.map(() => "?").join(", ");
  return getDatabase()
    .prepare(
      `
    SELECT r.id, r.member_id AS memberId, r.title, r.report_type AS reportType, r.status,
      r.hospital_name_raw AS hospitalName, r.hospital_branch AS hospitalBranch,
      ${displayDepartmentSql} AS departmentName,
      json_extract(r.body_parts_json, '$[0].name') AS bodyPart,
      ${reportDisplayDateSql} AS reportIssuedAt,
      ${reportAbnormalCountSql},
      (SELECT COUNT(*) FROM report_pages p WHERE p.report_id = r.id) AS pageCount,
      r.city, r.visit_type AS visitType, r.ordering_department AS orderingDepartment,
      r.performing_department AS performingDepartment, r.reporting_department AS reportingDepartment,
      r.body_parts_json AS bodyPartsJson, r.identifiers_json AS identifiersJson,
      r.examined_at AS examinedAt, r.sampled_at AS sampledAt, r.received_at AS receivedAt,
      r.reviewed_at AS reviewedAt, r.findings, r.impression, r.summary,
      r.source_version AS sourceVersion, r.updated_at AS updatedAt
    FROM reports r
    WHERE r.member_id = ? AND r.status <> 'trashed' AND r.id IN (${placeholders})
  `,
    )
    .all(memberId, ...reportIds) as DuplicateSourceRow[];
}

function appendGovernedDuplicateRows(
  rows: DuplicateSourceRow[],
  memberId: string,
  reportIds: string[],
) {
  const existingIds = new Set(rows.map((row) => row.id));
  const missingIds = reportIds.filter((reportId) => !existingIds.has(reportId));
  if (!missingIds.length) return rows;
  return [...rows, ...duplicateSourceRowsByIds(memberId, missingIds)];
}

type DuplicateScanStats = {
  sourceReportsScanned: number;
  candidateComparisons: number;
  governedCandidateOverrides: number;
  scanDurationMs: number;
};

type DuplicateScanContext = {
  stats: DuplicateScanStats;
  fileSignatures: Map<string, string | null>;
  observationSignatures: Map<string, Set<string>>;
  ruleSelection: ReportDuplicateRuleSelection;
};

function cachedReportFileSignature(
  reportId: string,
  cache?: Map<string, string | null>,
) {
  if (cache?.has(reportId)) return cache.get(reportId) ?? null;
  const signature = reportFileSignature(reportId);
  cache?.set(reportId, signature);
  return signature;
}

type AutomaticDuplicateEvaluation = {
  confidence: "high" | "medium";
  matchedFields: string[];
  reason: string;
  ruleSnapshot: ReportDuplicateRuleSnapshot;
} | null;

function duplicateRuleSnapshot(
  version: ReportDuplicateRuleVersion,
  ruleId: string,
  matchedFields: string[],
): ReportDuplicateRuleSnapshot {
  const signals = normalizedDuplicateSignals(matchedFields);
  return {
    version,
    ruleId,
    signals,
    signalProfileKey: signals.join("|"),
  };
}

function evaluateAutomaticDuplicatePair(
  current: DuplicateSourceRow,
  candidate: DuplicateSourceRow,
  context: DuplicateScanContext,
  localMatch: ReturnType<typeof findLocalDuplicateEvidence>[number] | undefined,
  currentFileSignature: string | null,
): AutomaticDuplicateEvaluation {
  const version = context.ruleSelection.version;
  const config = reportDuplicateRuleConfig();
  const currentIdentifiers = parseJson<Record<string, string>>(
    current.identifiersJson,
    {},
  );
  const candidateIdentifiers = parseJson<Record<string, string>>(
    candidate.identifiersJson,
    {},
  );
  const identifierMatches = sharedIdentifierMatches(
    currentIdentifiers,
    candidateIdentifiers,
  );
  const currentHospital = normalizeContentKey(current.hospitalName);
  const candidateHospital = normalizeContentKey(candidate.hospitalName);
  const currentBranch = normalizeContentKey(current.hospitalBranch);
  const candidateBranch = normalizeContentKey(candidate.hospitalBranch);
  const currentDate = datePart(
    current.reportIssuedAt ||
      current.examinedAt ||
      current.sampledAt ||
      current.receivedAt ||
      current.reviewedAt,
  );
  const candidateDate = datePart(
    candidate.reportIssuedAt ||
      candidate.examinedAt ||
      candidate.sampledAt ||
      candidate.receivedAt ||
      candidate.reviewedAt,
  );
  const currentDepartment = normalizeContentKey(
    current.performingDepartment ||
      current.departmentName ||
      current.reportingDepartment ||
      current.orderingDepartment,
  );
  const candidateDepartment = normalizeContentKey(
    candidate.performingDepartment ||
      candidate.departmentName ||
      candidate.reportingDepartment ||
      candidate.orderingDepartment,
  );
  const currentBodyPart = normalizeContentKey(
    current.bodyPart || firstBodyPart(current.bodyPartsJson),
  );
  const candidateBodyPart = normalizeContentKey(
    candidate.bodyPart || firstBodyPart(candidate.bodyPartsJson),
  );
  const matchedFields: string[] = [];
  const hasSameOriginal = Boolean(
    currentFileSignature &&
    currentFileSignature ===
      cachedReportFileSignature(candidate.id, context.fileSignatures),
  );
  if (hasSameOriginal) matchedFields.push("原始文件");
  if (titleSimilarityMatched(current.title, candidate.title))
    matchedFields.push("标题");
  if (current.reportType === candidate.reportType)
    matchedFields.push("报告类型");
  const exactHospital = Boolean(
    currentHospital &&
    candidateHospital &&
    currentHospital === candidateHospital,
  );
  const equivalentHospital =
    config.allowEquivalentHospitalNames &&
    hospitalNamesEquivalent(current.hospitalName, candidate.hospitalName);
  const hasEquivalentHospital = exactHospital || equivalentHospital;
  if (exactHospital) matchedFields.push("医院");
  else if (equivalentHospital) matchedFields.push("医院名称近似");
  if (currentBranch && candidateBranch && currentBranch === candidateBranch)
    matchedFields.push("院区");
  if (currentDate && candidateDate && currentDate === candidateDate)
    matchedFields.push("报告/检查日期");
  if (
    currentDepartment &&
    candidateDepartment &&
    currentDepartment === candidateDepartment
  )
    matchedFields.push("科室");
  if (
    currentBodyPart &&
    candidateBodyPart &&
    currentBodyPart === candidateBodyPart
  )
    matchedFields.push("检查部位");
  if (textSimilarityMatched(current.impression, candidate.impression))
    matchedFields.push("结论");
  else if (textSimilarityMatched(current.summary, candidate.summary))
    matchedFields.push("摘要");
  else if (textSimilarityMatched(current.findings, candidate.findings))
    matchedFields.push("检查所见");
  const observationStats = sharedObservationStats(
    current.id,
    candidate.id,
    context.observationSignatures,
  );
  if (observationStats.shared > 0)
    matchedFields.push(`指标${observationStats.shared}项`);
  if (localMatch) matchedFields.push(...localMatch.matchedFields);

  if (hasSameOriginal) {
    return {
      confidence: "high",
      matchedFields,
      reason: "上传原件内容完全一致",
      ruleSnapshot: duplicateRuleSnapshot(
        version,
        "original.same-file",
        matchedFields,
      ),
    };
  }
  const hasSameHospitalAndDate =
    hasEquivalentHospital && matchedFields.includes("报告/检查日期");
  const hasSameCore =
    matchedFields.includes("报告类型") && hasSameHospitalAndDate;
  if (
    identifierMatches.length &&
    (hasSameHospitalAndDate || matchedFields.includes("报告类型"))
  ) {
    const signals = [
      ...new Set([
        ...matchedFields,
        ...identifierMatches.map((key) => `编号:${key}`),
      ]),
    ];
    return {
      confidence: "high",
      matchedFields: signals,
      reason: `医疗编号一致（${identifierMatches.join("、")}）`,
      ruleSnapshot: duplicateRuleSnapshot(
        version,
        "identifier.same-medical-id",
        signals,
      ),
    };
  }
  if (localMatch) {
    const signals = [...new Set(matchedFields)];
    return {
      confidence: localMatch.confidence,
      matchedFields: signals,
      reason: localMatch.reason,
      ruleSnapshot: duplicateRuleSnapshot(
        version,
        `local-precheck.${localMatch.confidence}`,
        signals,
      ),
    };
  }
  const hasStrongTextAnchor = matchedFields.some((field) =>
    ["结论", "摘要", "检查所见"].includes(field),
  );
  const hasStrongObservationAnchor =
    hasStrongObservationOverlap(observationStats);
  const hasTitleAndClinicalAnchor =
    matchedFields.includes("标题") &&
    (matchedFields.includes("检查部位") || hasStrongObservationAnchor);
  const hasContentAnchor =
    hasStrongTextAnchor ||
    hasStrongObservationAnchor ||
    hasTitleAndClinicalAnchor;
  if (!hasSameCore || !hasContentAnchor) return null;
  return {
    confidence: "medium",
    matchedFields,
    reason:
      hasStrongTextAnchor || hasStrongObservationAnchor
        ? `${matchedFields.includes("医院名称近似") ? "机构名称近似，" : ""}医院、日期、类型及核心报告内容一致`
        : `${matchedFields.includes("医院名称近似") ? "机构名称近似，" : ""}医院、日期、类型、标题及临床字段一致`,
    ruleSnapshot: duplicateRuleSnapshot(
      version,
      "core.same-context-content",
      matchedFields,
    ),
  };
}

function findDuplicateCandidates(
  current: DuplicateSourceRow,
  context?: DuplicateScanContext,
): DuplicateReportCandidate[] {
  const scanContext = context || {
    stats: {
      sourceReportsScanned: 1,
      candidateComparisons: 0,
      governedCandidateOverrides: 0,
      scanDurationMs: 0,
    },
    fileSignatures: new Map<string, string | null>(),
    observationSignatures: new Map<string, Set<string>>(),
    ruleSelection: resolveReportDuplicateRuleSelection(),
  };
  const currentIdentifiers = parseJson<Record<string, string>>(
    current.identifiersJson,
    {},
  );
  const currentHospital = normalizeContentKey(current.hospitalName);
  const currentDate = datePart(
    current.reportIssuedAt ||
      current.examinedAt ||
      current.sampledAt ||
      current.receivedAt ||
      current.reviewedAt,
  );
  const currentFileSignature = cachedReportFileSignature(
    current.id,
    scanContext.fileSignatures,
  );
  const localEvidence = new Map(
    findLocalDuplicateEvidence(current.id).map((candidate) => [
      candidate.reportId,
      candidate,
    ]),
  );
  const governanceDecisions = duplicateDecisionsByPartner(
    current.memberId,
    current.id,
  );
  const governedPartnerIds = [...governanceDecisions.entries()]
    .filter(([, decision]) => decision.decision === "duplicate")
    .map(([reportId]) => reportId);

  if (
    !currentFileSignature &&
    !currentHospital &&
    !currentDate &&
    !Object.keys(currentIdentifiers).length &&
    !localEvidence.size &&
    !governedPartnerIds.length
  )
    return [];

  const automaticRows = getDatabase()
    .prepare(
      `
    SELECT r.id, r.member_id AS memberId, r.title, r.report_type AS reportType, r.status,
      r.hospital_name_raw AS hospitalName, r.hospital_branch AS hospitalBranch,
      ${displayDepartmentSql} AS departmentName,
      json_extract(r.body_parts_json, '$[0].name') AS bodyPart,
      ${reportDisplayDateSql} AS reportIssuedAt,
      ${reportAbnormalCountSql},
      (SELECT COUNT(*) FROM report_pages p WHERE p.report_id = r.id) AS pageCount,
      r.city, r.visit_type AS visitType, r.ordering_department AS orderingDepartment,
      r.performing_department AS performingDepartment, r.reporting_department AS reportingDepartment,
      r.body_parts_json AS bodyPartsJson, r.identifiers_json AS identifiersJson,
      r.examined_at AS examinedAt, r.sampled_at AS sampledAt, r.received_at AS receivedAt,
      r.reviewed_at AS reviewedAt, r.findings, r.impression, r.summary,
      r.source_version AS sourceVersion, r.updated_at AS updatedAt
    FROM reports r
    WHERE r.member_id = ? AND r.id <> ? AND r.status <> 'trashed'
      AND (r.status IN ('needs_review', 'ready') OR r.report_issued_at IS NOT NULL OR r.identifiers_json <> '{}')
    ORDER BY r.updated_at DESC
    LIMIT ?
  `,
    )
    .all(
      current.memberId,
      current.id,
      duplicateReportScanPolicy.candidateWindowLimit,
    ) as DuplicateSourceRow[];
  const automaticIds = new Set(automaticRows.map((row) => row.id));
  const governedOverrides = governedPartnerIds.filter(
    (reportId) => !automaticIds.has(reportId),
  ).length;
  const rows = appendGovernedDuplicateRows(
    automaticRows,
    current.memberId,
    governedPartnerIds,
  );
  scanContext.stats.candidateComparisons += rows.length;
  scanContext.stats.governedCandidateOverrides += governedOverrides;

  const candidates: DuplicateReportCandidate[] = [];
  for (const candidate of rows) {
    const pairKey = reportDuplicatePairKey(current.id, candidate.id);
    const governanceDecision = governanceDecisions.get(candidate.id);
    if (governanceDecision?.decision === "distinct") continue;
    if (governanceDecision?.decision === "duplicate") {
      const evidence = parseJson<Record<string, unknown>>(
        governanceDecision.evidenceJson,
        {},
      );
      const snapshot =
        evidence.ruleSnapshot && typeof evidence.ruleSnapshot === "object"
          ? (evidence.ruleSnapshot as ReportDuplicateRuleSnapshot)
          : duplicateRuleSnapshot(
              scanContext.ruleSelection.version,
              "manual.governance",
              ["人工治理"],
            );
      candidates.push({
        ...candidate,
        pairKey,
        governanceDecision: "duplicate",
        confidence: "high",
        matchedFields: ["人工治理"],
        reason: governanceDecision.reason
          ? `人工已确认重复：${governanceDecision.reason}`
          : "人工已确认重复",
        ruleSnapshot: snapshot,
      });
      continue;
    }

    const evaluation = evaluateAutomaticDuplicatePair(
      current,
      candidate,
      scanContext,
      localEvidence.get(candidate.id),
      currentFileSignature,
    );
    if (!evaluation) continue;
    candidates.push({
      ...candidate,
      pairKey,
      governanceDecision: null,
      confidence: evaluation.confidence,
      matchedFields: evaluation.matchedFields,
      reason: evaluation.reason,
      ruleSnapshot: evaluation.ruleSnapshot,
    });
  }
  const governedCandidates = candidates.filter(
    (candidate) => candidate.governanceDecision === "duplicate",
  );
  const automaticCandidates = candidates
    .filter((candidate) => candidate.governanceDecision !== "duplicate")
    .sort((left, right) => {
      return (
        Number(right.confidence === "high") - Number(left.confidence === "high")
      );
    });
  return [
    ...governedCandidates,
    ...automaticCandidates.slice(
      0,
      duplicateReportScanPolicy.automaticCandidateReturnLimit,
    ),
  ];
}
function duplicateSourceRowsForMember(user: RequestUser, memberId: string) {
  assertMemberAccess(user, memberId);
  const automaticRows = getDatabase()
    .prepare(
      `
    SELECT r.id, r.member_id AS memberId, r.title, r.report_type AS reportType, r.status,
      r.hospital_name_raw AS hospitalName, r.hospital_branch AS hospitalBranch,
      ${displayDepartmentSql} AS departmentName,
      json_extract(r.body_parts_json, '$[0].name') AS bodyPart,
      ${reportDisplayDateSql} AS reportIssuedAt,
      ${reportAbnormalCountSql},
      (SELECT COUNT(*) FROM report_pages p WHERE p.report_id = r.id) AS pageCount,
      r.city, r.visit_type AS visitType, r.ordering_department AS orderingDepartment,
      r.performing_department AS performingDepartment, r.reporting_department AS reportingDepartment,
      r.body_parts_json AS bodyPartsJson, r.identifiers_json AS identifiersJson,
      r.examined_at AS examinedAt, r.sampled_at AS sampledAt, r.received_at AS receivedAt,
      r.reviewed_at AS reviewedAt, r.findings, r.impression, r.summary,
      r.source_version AS sourceVersion, r.updated_at AS updatedAt
    FROM reports r
    JOIN member_permissions mp ON mp.member_id = r.member_id AND mp.user_id = ?
    WHERE r.member_id = ? AND r.status <> 'trashed'
      AND (r.status IN ('needs_review', 'ready') OR r.report_issued_at IS NOT NULL OR r.identifiers_json <> '{}')
    ORDER BY r.report_issued_at DESC, r.updated_at DESC
    LIMIT ?
  `,
    )
    .all(
      user.id,
      memberId,
      duplicateReportScanPolicy.sourceReportLimit,
    ) as DuplicateSourceRow[];
  return appendGovernedDuplicateRows(
    automaticRows,
    memberId,
    governedDuplicateReportIds(memberId),
  );
}

const allowedReportTypes = new Set([
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
  "other",
]);
const allowedReportStatuses = new Set([
  "needs_review",
  "ready",
  "failed",
  "queued",
  "processing",
]);
const pdfPreviewMaxSize = 2800;
const pdfPreviewQuality = 92;
const pdfPreviewRenderScale = 3;

function pdfPreviewRelativePath(reportId: string, pageId: string) {
  return join("previews", reportId, `${pageId}.jpg`);
}

function hasUsableJpegPreview(path: string) {
  try {
    const stats = lstatSync(path);
    if (!stats.isFile() || stats.size < 3) return false;
    const signature = readFileSync(path).subarray(0, 3);
    return (
      signature.length === 3 &&
      signature[0] === 0xff &&
      signature[1] === 0xd8 &&
      signature[2] === 0xff
    );
  } catch {
    return false;
  }
}

function isPermanentPreviewDecodeFailure(error: unknown) {
  return [
    "INPUT_FORMAT_MISMATCH",
    "IMAGE_DECODE_FAILED",
    "PDF_DECODE_FAILED",
  ].includes(String((error as { code?: string })?.code || ""));
}

function textInput(value: unknown, max = 500) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text.slice(0, max) : null;
}

function dateInput(value: unknown) {
  const text = textInput(value, 24);
  if (!text) return null;
  if (!/^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?$/.test(text)) {
    throw createError({
      statusCode: 400,
      statusMessage: "日期格式应为 YYYY-MM-DD 或 YYYY-MM-DD HH:mm:ss",
    });
  }
  return text.replace("T", " ");
}

function reportPageRows(reportId: string) {
  return getDatabase()
    .prepare(
      `
    SELECT id, storage_path AS storagePath, thumbnail_path AS thumbnailPath, page_number AS pageNumber
    FROM report_pages WHERE report_id = ? ORDER BY page_number
  `,
    )
    .all(reportId) as Array<{
    id: string;
    storagePath: string;
    thumbnailPath: string | null;
    pageNumber: number;
  }>;
}

export function listMembers(user: RequestUser) {
  if (!user.authenticated) return [];
  return getDatabase()
    .prepare(
      `
    SELECT hm.id, hm.display_name AS displayName, hm.relationship, hm.birth_date AS birthDate,
      hm.sex, hm.blood_type_abo AS bloodTypeAbo, hm.blood_type_rh AS bloodTypeRh,
      hm.blood_type_source_report_id AS bloodTypeSourceReportId,
      hm.avatar_path AS avatarPath, mp.permission
    FROM health_members hm
    JOIN member_permissions mp ON mp.member_id = hm.id AND mp.user_id = ?
    WHERE hm.deleted_at IS NULL
    ORDER BY CASE hm.relationship WHEN 'self' THEN 0 ELSE 1 END, hm.created_at
  `,
    )
    .all(user.id);
}

export function listReports(
  user: RequestUser,
  limit = 30,
  memberIdOrFilters?: string | ReportFilters,
  cursorValue?: string,
): CursorPage<ReportSummary> {
  if (!user.authenticated)
    return { items: [], nextCursor: null, hasMore: false };
  const filters: ReportFilters =
    typeof memberIdOrFilters === "object"
      ? memberIdOrFilters
      : { memberId: memberIdOrFilters, cursor: cursorValue };
  const memberId = filters.memberId;
  if (memberId) assertMemberAccess(user, memberId);
  const safeLimit = Math.min(50, Math.max(1, Math.round(limit)));
  const cursor = decodeCursor(filters.cursor);
  const cursorId = cursor?.id ?? null;
  const sort = filters.sort || "report_date_desc";
  const sortDateSql = sort === "created_desc" ? "r.created_at" : `COALESCE(${reportDisplayDateSql}, r.created_at)`;
  const sortDirection = sort === "report_date_asc" ? "ASC" : "DESC";
  const cursorSortDate = cursor?.sortDate ?? null;

  const where = ["(? IS NULL OR r.member_id = ?)"];
  const params: Array<string | number | null> = [
    user.id,
    memberId || null,
    memberId || null,
  ];
  if (filters.trash) where.push("r.status = 'trashed'");
  else where.push("r.status <> 'trashed'");
  if (filters.status && filters.status !== "all") {
    if (filters.status === "unfiled") {
      where.push("r.status <> 'ready'");
    } else {
      where.push("r.status = ?");
      params.push(filters.status);
    }
  }
  if (filters.reportType && filters.reportType !== "all") {
    where.push("r.report_type = ?");
    params.push(filters.reportType);
  }
  if (filters.dateFrom) {
    where.push(`COALESCE(${reportDisplayDateSql}, r.created_at) >= ?`);
    params.push(filters.dateFrom);
  }
  if (filters.dateTo) {
    where.push(`COALESCE(${reportDisplayDateSql}, r.created_at) <= ?`);
    params.push(filters.dateTo);
  }
  const query = normalizeContentKey(filters.query);
  if (query) {
    where.push(`(
      lower(COALESCE(r.title, '')) LIKE ?
      OR lower(COALESCE(r.hospital_name_raw, '')) LIKE ?
      OR lower(COALESCE(r.hospital_branch, '')) LIKE ?
      OR lower(COALESCE(r.visit_department, '')) LIKE ?
      OR lower(COALESCE(r.performing_department, '')) LIKE ?
      OR lower(COALESCE(r.reporting_department, '')) LIKE ?
      OR lower(COALESCE(r.body_parts_json, '')) LIKE ?
    )`);
    const like = `%${query}%`;
    params.push(like, like, like, like, like, like, like);
  }
  const ocrQuery = (filters.ocrQuery || "").trim();
  if (ocrQuery) {
    where.push(`EXISTS (
      SELECT 1 FROM report_pages fp
      JOIN ocr_results fo ON fo.page_id = fp.id
      WHERE fp.report_id = r.id AND fo.lines_json LIKE ?
    )`);
    params.push(`%${ocrQuery}%`);
  }
  /* 游标必须与 ORDER BY 使用同一个有效日期，避免 NULL 报告日期跨页错位。 */
  if (cursor) {
    const comparison = sortDirection === "ASC" ? ">" : "<";
    where.push(`(${sortDateSql} ${comparison} ? OR (${sortDateSql} = ? AND r.id ${comparison} ?))`);
    params.push(cursorSortDate, cursorSortDate, cursorId);
  }
  params.push(safeLimit + 1);

  const rows = getDatabase()
    .prepare(
      `
    SELECT r.id, r.member_id AS memberId, r.title, r.report_type AS reportType, r.status,
      r.hospital_name_raw AS hospitalName, r.hospital_branch AS hospitalBranch,
      ${displayDepartmentSql} AS departmentName,
      json_extract(r.body_parts_json, '$[0].name') AS bodyPart,
      ${reportDisplayDateSql} AS reportIssuedAt,
      ${sortDateSql} AS sortDate,
      ${reportAbnormalCountSql},
      (SELECT COUNT(*) FROM report_pages p WHERE p.report_id = r.id) AS pageCount
    FROM reports r
    JOIN member_permissions mp ON mp.member_id = r.member_id AND mp.user_id = ?
    WHERE ${where.join(" AND ")}
    ORDER BY ${sortDateSql} ${sortDirection}, r.id ${sortDirection}
    LIMIT ?
  `,
    )
    .all(...params) as ReportSummary[];
  const hasMore = rows.length > safeLimit;
  const items = hasMore ? rows.slice(0, safeLimit) : rows;
  const last = items.at(-1) as (ReportSummary & { sortDate?: string | null }) | undefined;
  return {
    items,
    hasMore,
    nextCursor:
      hasMore && last
        ? Buffer.from(`${last.sortDate || ""}|${last.id}`).toString(
            "base64url",
          )
        : null,
  };
}

export function getReportSummaryStats(user: RequestUser, memberId?: string) {
  if (!user.authenticated) {
    return {
      totalReports: 0,
      readyReports: 0,
      needsReviewReports: 0,
      processingReports: 0,
      failedReports: 0,
      totalPages: 0,
      observationCount: 0,
      abnormalObservationCount: 0,
      latestReportIssuedAt: null,
    };
  }
  if (memberId) assertMemberAccess(user, memberId);
  const row = getDatabase()
    .prepare(
      `
    SELECT
      COUNT(DISTINCT r.id) AS totalReports,
      COUNT(DISTINCT CASE WHEN r.status = 'ready' THEN r.id END) AS readyReports,
      COUNT(DISTINCT CASE WHEN r.status = 'needs_review' THEN r.id END) AS needsReviewReports,
      COUNT(DISTINCT CASE WHEN r.status IN ('queued', 'processing', 'uploading') THEN r.id END) AS processingReports,
      COUNT(DISTINCT CASE WHEN r.status = 'failed' THEN r.id END) AS failedReports,
      COUNT(DISTINCT p.id) AS totalPages,
      COUNT(DISTINCT o.id) AS observationCount,
      COUNT(DISTINCT CASE WHEN o.display_abnormal_flag IN ('high', 'low', 'abnormal') AND o.abnormal_conflict = 0 THEN COALESCE(NULLIF(n.canonical_key, ''), o.id) END) AS abnormalObservationCount,
      MAX(r.report_issued_at) AS latestReportIssuedAt
    FROM reports r
    JOIN member_permissions mp ON mp.member_id = r.member_id AND mp.user_id = ?
    LEFT JOIN report_pages p ON p.report_id = r.id
    LEFT JOIN observations o ON o.report_id = r.id
    LEFT JOIN observation_normalizations n ON n.observation_id = o.id
    WHERE r.status <> 'trashed' AND (? IS NULL OR r.member_id = ?)
  `,
    )
    .get(user.id, memberId || null, memberId || null) as {
    totalReports: number;
    readyReports: number;
    needsReviewReports: number;
    processingReports: number;
    failedReports: number;
    totalPages: number;
    observationCount: number;
    abnormalObservationCount: number;
    latestReportIssuedAt: string | null;
  };
  return {
    totalReports: Number(row.totalReports || 0),
    readyReports: Number(row.readyReports || 0),
    needsReviewReports: Number(row.needsReviewReports || 0),
    processingReports: Number(row.processingReports || 0),
    failedReports: Number(row.failedReports || 0),
    totalPages: Number(row.totalPages || 0),
    observationCount: Number(row.observationCount || 0),
    abnormalObservationCount: Number(row.abnormalObservationCount || 0),
    latestReportIssuedAt: row.latestReportIssuedAt,
  };
}

export function getOverview(user: RequestUser, memberId?: string) {
  if (!user.authenticated) {
    return {
      stats: getReportSummaryStats(user, memberId),
      pendingReminders: [],
      recentReadyReports: [],
      unfiledReports: [],
    };
  }
  if (memberId) assertMemberAccess(user, memberId);
  const pendingStatuses = ["needs_review", "processing", "queued", "failed"];
  const stats = getReportSummaryStats(user, memberId);
  const pendingReminders = listReminders(user, memberId)
    .filter((item) => (item as { status: string }).status === "pending")
    .slice(0, 3);
  const recentReadyReports = listReports(user, 3, {
    memberId,
    status: "ready",
  }).items;
  const seen = new Set<string>();
  const unfiledReports = pendingStatuses
    .flatMap((status) => listReports(user, 3, { memberId, status }).items)
    .filter((item) => {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    })
    .sort((left, right) => {
      const dateCompare = String(right.reportIssuedAt || "").localeCompare(
        String(left.reportIssuedAt || ""),
      );
      return dateCompare || right.id.localeCompare(left.id);
    })
    .slice(0, 3);
  return { stats, pendingReminders, recentReadyReports, unfiledReports };
}

export function classifyObservationDisplay(input: {
  normalizationQuality: Observation["normalizationQuality"];
  normalizationExcludedReason: string | null;
  normalizationMatchedBy: string | null;
  canonicalName: string | null;
  evidence: unknown;
  itemName?: string | null;
  sectionName?: string | null;
  numericValue?: number | null;
  unit?: string | null;
  resultText?: string | null;
  manualReviewed?: boolean;
}): Pick<Observation, "displayTier" | "displayCategory" | "displayReason"> {
  if (
    input.normalizationQuality === "excluded" ||
    isPolicyFilteredNormalization(input.normalizationMatchedBy)
  ) {
    return {
      displayTier: "governance_only",
      displayCategory: "governance_noise",
      displayReason:
        input.normalizationExcludedReason ||
        "设备或计算过程参数，不作为家庭健康指标展示",
    };
  }
  const hasVerifiableEvidence =
    Array.isArray(input.evidence) &&
    input.evidence.some((entry) => {
      if (!entry || typeof entry !== "object") return false;
      const evidence = entry as { pageNumber?: unknown; quote?: unknown };
      return (
        Number.isInteger(evidence.pageNumber) &&
        Number(evidence.pageNumber) > 0 &&
        typeof evidence.quote === "string" &&
        evidence.quote.trim().length >= 2
      );
    });
  const evidenceFailure =
    /(?:缺少可核验的 OCR 证据|无法回指 OCR 证据|结构化数值与结果文本不一致|参考范围上下界反向)/.test(
      input.normalizationExcludedReason || "",
    );
  if ((!hasVerifiableEvidence && !input.manualReviewed) || evidenceFailure) {
    return {
      displayTier: "governance_only",
      displayCategory: "governance_noise",
      displayReason:
        input.normalizationExcludedReason || "缺少可核验的 OCR 证据",
    };
  }
  if (["high", "medium"].includes(String(input.normalizationQuality))) {
    return {
      displayTier: "primary",
      displayCategory: "standardized",
      displayReason: null,
    };
  }

  const itemName = String(input.itemName || "")
    .normalize("NFKC")
    .trim();
  const sectionName = String(input.sectionName || "")
    .normalize("NFKC")
    .trim();
  const resultText = String(input.resultText || "")
    .normalize("NFKC")
    .trim();
  const context = `${sectionName} ${itemName}`;
  const qualitativeResult =
    input.numericValue == null &&
    !String(input.unit || "").trim() &&
    /^(?:阴性|阳性|弱阳性|可疑阳性|未检出|未见|正常|异常|未见异常|未见明显异常|[-—–－])$/i.test(
      resultText,
    );
  const evidenceQuotes = Array.isArray(input.evidence)
    ? input.evidence.flatMap((entry) => {
        if (!entry || typeof entry !== "object") return [];
        const quote = (entry as { quote?: unknown }).quote;
        return typeof quote === "string" ? [quote] : [];
      })
    : [];
  const reportHeadingObservation = Boolean(
    itemName &&
    itemName === sectionName &&
    /(?:报告|检验单|检查单)/.test(itemName),
  );
  const narrativeNameFragment = Boolean(
    /^[\u3400-\u9fff]{1,3}值$/.test(itemName) &&
    evidenceQuotes.some((quote) =>
      /(?:建议|诊治|控制|生活方式|复查|随访)/.test(quote),
    ),
  );
  const structuralNoise = Boolean(
    (reportHeadingObservation && !qualitativeResult) ||
    /^[A-Za-z]{2,8}\s*[:：]\s*[+-]?\d/.test(itemName) ||
    narrativeNameFragment,
  );
  if (structuralNoise) {
    return {
      displayTier: "governance_only",
      displayCategory: "governance_noise",
      displayReason: narrativeNameFragment
        ? "项目名称来自结论句残片，等待结构治理"
        : "报告标题或值被混入项目名称，等待结构治理",
    };
  }
  /**
   * 查体表常把「耳 | 右侧外耳道耵聍堵塞 | （历史结果列）未见异常」并排印刷，AI 容易把
   * 阳性发现文本当作项目名、再从历史结果列取来「未见异常」。项目名本身是阳性发现描述
   * 而结果却是缺如类结论，语义自相矛盾，不能作为定性记录展示。带筛查/试验/标志物等
   * 检测语义的名称（如「肿瘤标志物」）缺如类结果合法，不误伤。
   */
  const absenceOfFindingResult =
    /^(?:未见异常|未见明显异常|未见明显|无异常|正常|未见)$/.test(resultText);
  const findingLikeName =
    /(?:堵塞|炎|肿大|增生|息肉|结石|糜烂|积液|结节|囊肿|萎缩|肥厚|充血|水肿|溃疡|狭窄|畸形|占位|硬化|脓肿|出血|瘤)/.test(
      itemName,
    ) &&
    !/(?:筛查|检查|试验|检测|测定|标志物|抗原|抗体|化验|测试)/.test(itemName);
  if (
    input.numericValue == null &&
    !String(input.unit || "").trim() &&
    absenceOfFindingResult &&
    findingLikeName
  ) {
    return {
      displayTier: "governance_only",
      displayCategory: "governance_noise",
      displayReason:
        "项目名称是阳性发现描述，与「未见异常」类结果自相矛盾，疑似取到历史结果列，待人工核对",
    };
  }
  if (
    /(?:人体成[份分]|血粘度|血液流变|骨密度|心电图|ECG|呼气试验|呼气检测)/i.test(
      context,
    )
  ) {
    return {
      displayTier: "secondary",
      displayCategory: "technical_measurement",
      displayReason: "已核验的专业技术参数，默认不进入家庭趋势",
    };
  }
  if (
    input.numericValue == null &&
    !String(input.unit || "").trim() &&
    (qualitativeResult ||
      /(?:^|\s)(?:内科|外科|眼科)(?:检查)?(?:\s|$)|裂隙灯|查体/.test(context))
  ) {
    return {
      displayTier: "secondary",
      displayCategory: "qualitative_finding",
      displayReason: "已核验的定性检查记录，保留在报告详情中",
    };
  }
  return {
    displayTier: "secondary",
    displayCategory: "medical_candidate",
    displayReason: input.manualReviewed
      ? input.canonicalName
        ? "已人工校对，但单位或语义尚未达到趋势发布标准"
        : "已人工校对，尚未匹配标准指标"
      : input.canonicalName
        ? "OCR 证据完整，但单位或语义尚未达到趋势发布标准"
        : "OCR 证据完整，尚未匹配标准指标",
  };
}

function duplicateMeasurementAnchorKey(value: number, entry: unknown) {
  if (!entry || typeof entry !== "object") return null;
  const evidence = entry as { pageNumber?: unknown; quote?: unknown };
  if (!Number.isInteger(evidence.pageNumber) || Number(evidence.pageNumber) <= 0) return null;
  if (typeof evidence.quote !== "string" || evidence.quote.trim().length < 2) return null;
  return `${Number(evidence.pageNumber)}|${value}|${evidence.quote.trim().replace(/\s+/g, "")}`;
}

/**
 * 同一行原文（如「右踝：1.07 | 左踝：1.08」）可能被 AI 同时拆出标准化条目和
 * 裸名称残片（如「左踝 1.08」）。残片未命中字典，且与标准化条目同值、同页、同证据，
 * 属于重复测量候选：详情展示层抑制，原始数据保留供审计。
 */
export function suppressDuplicateMeasurementCandidates(observations: Observation[]): Observation[] {
  const standardizedAnchors = new Set<string>();
  for (const observation of observations) {
    const value = observation.numericValue;
    if (observation.displayTier !== "primary" || value === null) continue;
    for (const entry of Array.isArray(observation.evidence) ? (observation.evidence as unknown[]) : []) {
      const key = duplicateMeasurementAnchorKey(value, entry);
      if (key) standardizedAnchors.add(key);
    }
  }
  if (!standardizedAnchors.size) return observations;
  return observations.map((observation) => {
    const value = observation.numericValue;
    if (observation.displayTier !== "secondary" || observation.canonicalName || value === null) {
      return observation;
    }
    const entries = Array.isArray(observation.evidence) ? (observation.evidence as unknown[]) : [];
    const duplicated = entries.some((entry) => {
      const key = duplicateMeasurementAnchorKey(value, entry);
      return key !== null && standardizedAnchors.has(key);
    });
    if (!duplicated) return observation;
    return {
      ...observation,
      displayTier: "governance_only" as const,
      displayCategory: "governance_noise" as const,
      displayReason: "与标准化指标同值同证据的重复测量候选，已合并展示",
    };
  });
}

export function getReportDetail(
  user: RequestUser,
  reportId: string,
): ReportDetail {
  const row = getDatabase()
    .prepare(
      `
    SELECT r.id, r.member_id AS memberId, r.title, r.report_type AS reportType, r.status,
      r.hospital_name_raw AS hospitalName, r.hospital_branch AS hospitalBranch, r.city,
      r.visit_type AS visitType,
      ${displayDepartmentSql} AS departmentName,
      r.visit_department AS visitDepartment,
      r.ordering_department AS orderingDepartment, r.performing_department AS performingDepartment,
      r.reporting_department AS reportingDepartment, r.inpatient_ward AS inpatientWard,
      json_extract(r.body_parts_json, '$[0].name') AS bodyPart,
      r.body_parts_json AS bodyPartsJson, r.identifiers_json AS identifiersJson,
      ${reportDisplayDateSql} AS reportIssuedAt, r.examined_at AS examinedAt,
      r.ordered_at AS orderedAt, r.sampled_at AS sampledAt, r.received_at AS receivedAt,
      r.reviewed_at AS reviewedAt, r.admitted_at AS admittedAt, r.discharged_at AS dischargedAt,
      r.clinicians_json AS cliniciansJson, r.clinical_diagnosis AS clinicalDiagnosis,
      r.purpose, r.chief_complaint AS chiefComplaint, r.findings, r.impression, r.summary,
      r.recommendation, r.source_version AS sourceVersion, r.updated_at AS updatedAt,
      r.created_at AS createdAt,
      ${reportAbnormalCountSql},
      (SELECT COUNT(*) FROM report_pages p WHERE p.report_id = r.id) AS pageCount
    FROM reports r
    JOIN member_permissions mp ON mp.member_id = r.member_id AND mp.user_id = ?
    WHERE r.id = ? AND r.status <> 'trashed'
  `,
    )
    .get(user.id, reportId) as
    | (DuplicateSourceRow & {
        createdAt: string;
        city: string | null;
        visitType: string | null;
        visitDepartment: string | null;
        orderingDepartment: string | null;
        performingDepartment: string | null;
        reportingDepartment: string | null;
        inpatientWard: string | null;
        bodyPartsJson: string;
        identifiersJson: string;
        examinedAt: string | null;
        orderedAt: string | null;
        sampledAt: string | null;
        receivedAt: string | null;
        reviewedAt: string | null;
        admittedAt: string | null;
        dischargedAt: string | null;
        cliniciansJson: string;
        clinicalDiagnosis: string | null;
        purpose: string | null;
        chiefComplaint: string | null;
        recommendation: string | null;
      })
    | undefined;
  if (!row) {
    const exists = getDatabase()
      .prepare("SELECT member_id AS memberId FROM reports WHERE id = ?")
      .get(reportId) as { memberId: string } | undefined;
    if (exists) assertMemberAccess(user, exists.memberId);
    throw createError({ statusCode: 404, statusMessage: "报告不存在" });
  }
  const pages = getDatabase()
    .prepare(
      `
    SELECT id, report_id AS reportId, page_number AS pageNumber, original_name AS originalName,
      mime_type AS mimeType, file_size AS fileSize, width, height, rotation,
      source_page_number AS sourcePageNumber, source_page_count AS sourcePageCount,
      thumbnail_path IS NOT NULL AS hasThumbnail
    FROM report_pages WHERE report_id = ? ORDER BY page_number
  `,
    )
    .all(reportId) as unknown as ReportPage[];
  const detailOcrLineCache = new Map<string, Array<{ id: string; text: string }>>();
  const observations = suppressDuplicateMeasurementCandidates(getDatabase()
    .prepare(
      `
    SELECT o.id, o.report_id AS reportId, o.section_name AS sectionName, o.item_code AS itemCode,
      o.item_name AS itemName, o.normalized_name AS normalizedName, o.result_text AS resultText,
      o.numeric_value AS numericValue, o.unit,
      o.reference_low AS referenceLow, o.reference_high AS referenceHigh,
      o.reference_text AS referenceText,
      o.abnormal_flag AS abnormalFlag, o.evidence_json AS evidenceJson,
      n.canonical_key AS canonicalKey, n.canonical_name AS canonicalName, n.canonical_value AS canonicalValue,
      n.canonical_unit AS canonicalUnit, n.quality AS normalizationQuality,
      n.confidence AS normalizationConfidence, n.match_reason AS normalizationReason,
      n.excluded_reason AS normalizationExcludedReason, n.matched_by AS normalizationMatchedBy,
      c.explanation AS canonicalExplanation, c.reference_range_json AS dictionaryReferenceJson,
      manual_override.id IS NOT NULL AS manualReviewed,
      COALESCE(manual_override.is_manual_created, 0) AS manualCreated,
      manual_override.canonical_key AS manualCanonicalKey
    FROM observations o
    LEFT JOIN observation_normalizations n ON n.observation_id = o.id
    LEFT JOIN indicator_catalog c ON c.id = n.indicator_id
    LEFT JOIN observation_field_overrides manual_override ON manual_override.observation_id = o.id
    WHERE o.report_id = ? ORDER BY o.section_name, o.id LIMIT 200
  `,
    )
    .all(reportId)
    .map((item) => {
      const row = item as unknown as Observation & {
        evidenceJson: string;
        normalizationMatchedBy: string | null;
        dictionaryReferenceJson: string | null;
      };
      const evidence = parseJson<Array<{ pageNumber?: number; quote?: string; confidence?: number }> | null>(
        row.evidenceJson,
        null,
      );
      const display = classifyObservationDisplay({
        normalizationQuality: row.normalizationQuality,
        normalizationExcludedReason: row.normalizationExcludedReason,
        normalizationMatchedBy: row.normalizationMatchedBy,
        canonicalName: row.canonicalName,
        evidence,
        itemName: row.itemName,
        sectionName: row.sectionName,
        numericValue: row.numericValue,
        unit: row.unit,
        resultText: row.resultText,
        manualReviewed: Boolean(row.manualReviewed),
      });
      const reference = assessObservationReference({
        low: row.referenceLow,
        high: row.referenceHigh,
        text: row.referenceText,
      });
      const interpretation = assessObservationInterpretation({
        storedFlag: row.abnormalFlag,
        resultText: row.resultText,
        supportingText: (Array.isArray(evidence) ? evidence : []).map(
          (entry) => entry.quote || null,
        ),
        numericValue:
          row.numericValue ?? parseNumericResultText(row.resultText),
        referenceLow: reference.low,
        referenceHigh: reference.high,
        dictionaryReference: parseDictionaryReferenceRange(
          row.dictionaryReferenceJson,
        ),
      });
      const firstEvidence = Array.isArray(evidence) && evidence.length
        ? evidence[0]
        : null;
      const evidencePageNumber = firstEvidence && Number.isInteger(firstEvidence.pageNumber)
        ? Number(firstEvidence.pageNumber)
        : null;
      const evidencePage = evidencePageNumber
        ? pages.find((page) => page.pageNumber === evidencePageNumber)
        : null;
      const tableEvidence = observationTableEvidence(row.evidenceJson);
      const matchedEvidence = tableEvidence?.rowLineIds.length
        ? { rowLineIds: tableEvidence.rowLineIds }
        : evidencePageNumber && firstEvidence?.quote
          ? matchQuoteToOcrLines(
              firstEvidence.quote,
              row.itemName,
              row.resultText,
              row.numericValue,
              ocrLinesForTrendEvidence(
                detailOcrLineCache,
                row.reportId,
                evidencePageNumber,
              ),
            )
          : null;
      const detailEvidence = evidencePage
        ? {
            pageId: evidencePage.id,
            lineIds: matchedEvidence?.rowLineIds || [],
            sourceText: firstEvidence?.quote || "",
            confidence: null,
          }
        : null;
      const {
        normalizationMatchedBy: _normalizationMatchedBy,
        dictionaryReferenceJson: _dictionaryReferenceJson,
        ...observation
      } = row;
      return {
        ...observation,
        manualReviewed: Boolean(row.manualReviewed),
        manualCreated: Boolean(row.manualCreated),
        referenceLow: reference.low,
        referenceHigh: reference.high,
        referenceText: reference.text,
        abnormalFlag: interpretation.rawFlag,
        reportedAbnormalFlag: interpretation.rawFlag,
        displayAbnormalFlag: interpretation.effectiveFlag,
        abnormalSource: interpretation.source,
        abnormalStatus: interpretation.status,
        abnormalConflict: interpretation.conflict,
        abnormalReason: interpretation.reason,
        evidence: detailEvidence,
        evidenceJson: undefined,
        ...display,
      };
    }) as Observation[]);
  const morphologyFindings = getDatabase()
    .prepare(
      `
    SELECT id, report_id AS reportId, section_name AS sectionName, organ, region, laterality,
      finding_type AS findingType, finding_name AS findingName, presence,
      finding_count AS findingCount, size_length AS sizeLength, size_width AS sizeWidth,
      size_height AS sizeHeight, size_unit AS sizeUnit, measurements_json AS measurementsJson,
      morphology_text AS morphology, attributes_json AS attributesJson,
      classification_system AS classificationSystem,
      classification_value AS classificationValue,
      classification_text AS classificationText, comparison_text AS comparisonText,
      raw_text AS rawText, evidence_json AS evidenceJson, confidence,
      tracking_group_id AS trackingGroupId, match_confidence AS matchConfidence,
      source, manual_fields_json AS manualFieldsJson
    FROM morphology_findings
    WHERE report_id = ?
    ORDER BY section_name, organ, finding_type, id
    LIMIT 200
  `,
    )
    .all(reportId)
    .map((item) => {
      const finding = item as {
        id: string;
        reportId: string;
        sectionName: string | null;
        organ: string | null;
        region: string | null;
        laterality: MorphologyFinding["laterality"];
        findingType: string;
        findingName: string;
        presence: MorphologyFinding["presence"];
        findingCount: number | null;
        sizeLength: number | null;
        sizeWidth: number | null;
        sizeHeight: number | null;
        sizeUnit: string | null;
        measurementsJson: string;
        morphology: string | null;
        attributesJson: string;
        classificationSystem: string | null;
        classificationValue: string | null;
        classificationText: string | null;
        comparisonText: string | null;
        rawText: string;
        evidenceJson: string;
        confidence: number | null;
        trackingGroupId: string | null;
        matchConfidence: number | null;
        source: MorphologyFinding["source"];
        manualFieldsJson: string;
      };
      const hasClassification = Boolean(
        finding.classificationSystem ||
        finding.classificationValue ||
        finding.classificationText,
      );
      return {
        id: finding.id,
        reportId: finding.reportId,
        examDate: row.examinedAt || row.reportIssuedAt,
        sectionName: finding.sectionName,
        organ: finding.organ,
        region: finding.region,
        laterality: finding.laterality,
        findingType: finding.findingType,
        findingName: finding.findingName,
        presence: finding.presence,
        findingCount: finding.findingCount,
        size: {
          length: finding.sizeLength,
          width: finding.sizeWidth,
          height: finding.sizeHeight,
          unit: finding.sizeUnit,
        },
        measurements: parseJson(finding.measurementsJson, []),
        morphology: finding.morphology,
        attributes: parseJson(finding.attributesJson, {}),
        classification: hasClassification
          ? {
              system: finding.classificationSystem,
              value: finding.classificationValue,
              text: finding.classificationText,
            }
          : null,
        comparisonText: finding.comparisonText,
        rawText: finding.rawText,
        evidence: parseJson(finding.evidenceJson, []),
        confidence: finding.confidence,
        trackingGroupId: finding.trackingGroupId,
        matchConfidence: finding.matchConfidence,
        source: finding.source,
        manualFields: parseJson(finding.manualFieldsJson, []),
      };
    }) as MorphologyFinding[];
  const diagnoses = getDatabase()
    .prepare(
      `
    SELECT id, report_id AS reportId, section_name AS sectionName,
      diagnosis_type AS diagnosisType, diagnosis_text AS diagnosisText,
      diagnosis_code AS diagnosisCode, code_system AS codeSystem,
      is_primary AS isPrimary, evidence_json AS evidenceJson, source,
      manual_fields_json AS manualFieldsJson
    FROM report_diagnoses WHERE report_id = ? AND is_deleted = 0
    ORDER BY is_primary DESC, diagnosis_type, id
  `,
    )
    .all(reportId)
    .map((item) => {
      const fact = item as unknown as Omit<
        ReportDiagnosis,
        "isPrimary" | "evidence" | "manualFields"
      > & {
        isPrimary: number;
        evidenceJson: string;
        manualFieldsJson: string;
      };
      return {
        ...fact,
        isPrimary: Boolean(fact.isPrimary),
        evidence: parseJson(fact.evidenceJson, []),
        manualFields: parseJson(fact.manualFieldsJson, []),
        evidenceJson: undefined,
        manualFieldsJson: undefined,
      };
    }) as ReportDiagnosis[];
  const medications = getDatabase()
    .prepare(
      `
    SELECT id, report_id AS reportId, section_name AS sectionName,
      medication_context AS context, medication_name AS medicationName,
      generic_name AS genericName, specification, dosage_form AS dosageForm,
      dose, dose_unit AS doseUnit, frequency, route, duration, quantity,
      quantity_unit AS quantityUnit, instructions, evidence_json AS evidenceJson,
      source, manual_fields_json AS manualFieldsJson
    FROM report_medications WHERE report_id = ? AND is_deleted = 0
    ORDER BY medication_context, section_name, id
  `,
    )
    .all(reportId)
    .map((item) => {
      const fact = item as Omit<
        ReportMedication,
        "evidence" | "manualFields"
      > & {
        evidenceJson: string;
        manualFieldsJson: string;
      };
      return {
        ...fact,
        evidence: parseJson(fact.evidenceJson, []),
        manualFields: parseJson(fact.manualFieldsJson, []),
        evidenceJson: undefined,
        manualFieldsJson: undefined,
      };
    }) as ReportMedication[];
  const procedures = getDatabase()
    .prepare(
      `
    SELECT id, report_id AS reportId, section_name AS sectionName,
      procedure_type AS procedureType, procedure_name AS procedureName,
      procedure_code AS procedureCode, body_part AS bodyPart,
      performed_at AS performedAt, result_text AS resultText,
      evidence_json AS evidenceJson, source, manual_fields_json AS manualFieldsJson
    FROM report_procedures WHERE report_id = ? AND is_deleted = 0
    ORDER BY performed_at, procedure_type, id
  `,
    )
    .all(reportId)
    .map((item) => {
      const fact = item as Omit<
        ReportProcedure,
        "evidence" | "manualFields"
      > & {
        evidenceJson: string;
        manualFieldsJson: string;
      };
      return {
        ...fact,
        evidence: parseJson(fact.evidenceJson, []),
        manualFields: parseJson(fact.manualFieldsJson, []),
        evidenceJson: undefined,
        manualFieldsJson: undefined,
      };
    }) as ReportProcedure[];
  const vaccinations = getDatabase()
    .prepare(
      `
    SELECT id, report_id AS reportId, vaccine_name AS vaccineName,
      dose_number AS doseNumber, manufacturer, lot_number AS lotNumber,
      administered_at AS administeredAt, administration_site AS administrationSite,
      next_due_at AS nextDueAt, evidence_json AS evidenceJson, source,
      manual_fields_json AS manualFieldsJson
    FROM vaccination_records WHERE report_id = ? AND is_deleted = 0
    ORDER BY administered_at, id
  `,
    )
    .all(reportId)
    .map((item) => {
      const fact = item as Omit<
        VaccinationRecord,
        "evidence" | "manualFields"
      > & {
        evidenceJson: string;
        manualFieldsJson: string;
      };
      return {
        ...fact,
        evidence: parseJson(fact.evidenceJson, []),
        manualFields: parseJson(fact.manualFieldsJson, []),
        evidenceJson: undefined,
        manualFieldsJson: undefined,
      };
    }) as VaccinationRecord[];
  const billingSummaryRow = getDatabase()
    .prepare(
      `
    SELECT id, report_id AS reportId, invoice_number AS invoiceNumber,
      total_amount AS totalAmount, insurance_amount AS insuranceAmount,
      self_pay_amount AS selfPayAmount, currency, evidence_json AS evidenceJson,
      source, manual_fields_json AS manualFieldsJson
    FROM billing_summaries WHERE report_id = ? AND is_deleted = 0
  `,
    )
    .get(reportId) as
    | (Omit<BillingSummary, "evidence" | "manualFields"> & {
        evidenceJson: string;
        manualFieldsJson: string;
      })
    | undefined;
  const billingSummary = billingSummaryRow
    ? {
        ...billingSummaryRow,
        evidence: parseJson(billingSummaryRow.evidenceJson, []),
        manualFields: parseJson(billingSummaryRow.manualFieldsJson, []),
        evidenceJson: undefined,
        manualFieldsJson: undefined,
      }
    : null;
  const billingItems = getDatabase()
    .prepare(
      `
    SELECT id, report_id AS reportId, category, item_name AS itemName,
      amount, quantity, evidence_json AS evidenceJson
      , source, manual_fields_json AS manualFieldsJson
    FROM billing_items WHERE report_id = ? AND is_deleted = 0
    ORDER BY category, id
  `,
    )
    .all(reportId)
    .map((item) => {
      const fact = item as Omit<BillingItem, "evidence" | "manualFields"> & {
        evidenceJson: string;
        manualFieldsJson: string;
      };
      return {
        ...fact,
        evidence: parseJson(fact.evidenceJson, []),
        manualFields: parseJson(fact.manualFieldsJson, []),
        evidenceJson: undefined,
        manualFieldsJson: undefined,
      };
    }) as BillingItem[];
  const structuredSectionOrder = [
    "checkup_package",
    "checkup_positive_findings",
    "checkup_abnormal_summary",
    "checkup_final_conclusion",
    "checkup_original_recommendation",
    "laboratory_specimen",
    "laboratory_method",
    "imaging_modality",
    "imaging_contrast",
    "functional_method",
    "functional_description",
    "pathology_specimen",
    "pathology_gross_findings",
    "pathology_microscopic_findings",
    "pathology_immunohistochemistry",
    "pathology_grade",
    "pathology_stage",
    "outpatient_history",
    "outpatient_physical_examination",
    "outpatient_disposition",
    "outpatient_advice",
    "inpatient_course",
    "inpatient_discharge_instructions",
  ];
  const structuredSections = getDatabase()
    .prepare(
      `
    SELECT id, report_id AS reportId, section_key AS sectionKey,
      section_title AS title, content_text AS content, content_json AS contentJson,
      evidence_json AS evidenceJson, source, manual_fields_json AS manualFieldsJson
    FROM report_structured_sections
    WHERE report_id = ? AND is_deleted = 0
  `,
    )
    .all(reportId)
    .map((item) => {
      const section = item as Omit<
        ReportStructuredSection,
        "contentData" | "evidence" | "manualFields"
      > & {
        contentJson: string | null;
        evidenceJson: string;
        manualFieldsJson: string;
      };
      return {
        ...section,
        title: section.source === "manual"
          ? section.title
          : reportStructuredSectionLabels[section.sectionKey],
        contentData: parseJson<Record<string, unknown> | null>(
          section.contentJson,
          null,
        ),
        evidence: parseJson(section.evidenceJson, []),
        manualFields: parseJson(section.manualFieldsJson, []),
        contentJson: undefined,
        evidenceJson: undefined,
        manualFieldsJson: undefined,
      };
    })
    .filter(
      (section) =>
        section.source === "manual" ||
        isAiReportStructuredSectionCompatible(
          row.reportType,
          section.sectionKey,
        ),
    )
    .sort((left, right) => {
      const leftIndex = structuredSectionOrder.indexOf(left.sectionKey);
      const rightIndex = structuredSectionOrder.indexOf(right.sectionKey);
      return (
        (leftIndex < 0 ? 999 : leftIndex) -
          (rightIndex < 0 ? 999 : rightIndex) ||
        left.title.localeCompare(right.title, "zh-CN")
      );
    }) as ReportStructuredSection[];
  return {
    ...row,
    bodyParts: parseJson(row.bodyPartsJson, []),
    identifiers: parseJson(row.identifiersJson, {}),
    clinicians: parseJson(row.cliniciansJson, {}),
    pages,
    observations,
    morphologyFindings,
    diagnoses,
    medications,
    procedures,
    vaccinations,
    billingSummary,
    billingItems,
    structuredSections,
    manualFieldKeys: [...listManualReportFieldKeys(reportId)],
    duplicateCandidates: findDuplicateCandidates(row),
    memberIdentityAssessment: assessReportMemberIdentity(user, reportId),
  };
}

export function getReportPageFile(
  user: RequestUser,
  reportId: string,
  pageId: string,
  variant: "original" | "thumbnail",
) {
  const row = getDatabase()
    .prepare(
      `
    SELECT r.member_id AS memberId, p.original_name AS originalName, p.mime_type AS mimeType,
      p.storage_path AS storagePath, p.thumbnail_path AS thumbnailPath
    FROM report_pages p
    JOIN reports r ON r.id = p.report_id
    WHERE p.id = ? AND p.report_id = ? AND r.status <> 'trashed'
  `,
    )
    .get(pageId, reportId) as
    | {
        memberId: string;
        originalName: string;
        mimeType: string;
        storagePath: string;
        thumbnailPath: string | null;
      }
    | undefined;
  if (!row)
    throw createError({ statusCode: 404, statusMessage: "报告原件不存在" });
  assertMemberAccess(user, row.memberId);
  const relativePath =
    variant === "thumbnail" ? row.thumbnailPath : row.storagePath;
  if (!relativePath)
    throw createError({ statusCode: 404, statusMessage: "页面缩略图不存在" });
  const path = storagePath(relativePath);
  if (!existsSync(path))
    throw createError({ statusCode: 404, statusMessage: "报告文件不存在" });
  return {
    path,
    mimeType: variant === "thumbnail" ? "image/jpeg" : row.mimeType,
    filename: row.originalName,
  };
}

type ReportOriginalDownload = {
  path: string;
  mimeType: "application/pdf";
  filename: string;
};

const reportOriginalExportTasks = new Map<string, Promise<void>>();

function reportDownloadFilename(title: string, fallback: string) {
  const base = (title || fallback)
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return `${base || "健康报告"}.pdf`;
}

function reportOriginalExportKey(pages: Array<{ id: string; pageNumber: number; storagePath: string; sha256: string; rotation: number }>) {
  return createHash("sha256").update(JSON.stringify(pages.map((page) => [
    page.id, page.pageNumber, page.storagePath, page.sha256, page.rotation,
  ]))).digest("hex").slice(0, 32);
}

function reportOriginalExportPath(reportId: string, key: string) {
  const directory = join(getAppConfig().storageDir, "report-exports");
  mkdirSync(directory, { recursive: true });
  return join(directory, `${reportId}-${key}.pdf`);
}

function reportOriginalPages(user: RequestUser, reportId: string) {
  const db = getDatabase();
  const report = db.prepare(
    "SELECT member_id AS memberId, title FROM reports WHERE id = ? AND status <> 'trashed'",
  ).get(reportId) as { memberId: string; title: string } | undefined;
  if (!report) throw createError({ statusCode: 404, statusMessage: "报告不存在" });
  assertMemberAccess(user, report.memberId);
  const pages = db.prepare(`
    SELECT id, page_number AS pageNumber, original_name AS originalName,
      storage_path AS storagePath, mime_type AS mimeType, source_page_number AS sourcePageNumber,
      source_page_count AS sourcePageCount, rotation, sha256
    FROM report_pages WHERE report_id = ? ORDER BY page_number
  `).all(reportId) as Array<{
    id: string; pageNumber: number; originalName: string; storagePath: string;
    mimeType: string; sourcePageNumber: number | null; sourcePageCount: number | null; rotation: number; sha256: string;
  }>;
  if (!pages.length) throw createError({ statusCode: 404, statusMessage: "报告没有可导出的原件" });
  return { report, pages };
}

export async function getReportOriginalDownload(user: RequestUser, reportId: string): Promise<ReportOriginalDownload> {
  const { report, pages } = reportOriginalPages(user, reportId);
  const filename = reportDownloadFilename(report.title, pages[0].originalName.replace(/\.[^.]+$/, ""));
  const pdfPages = pages.filter((page) => page.mimeType === "application/pdf");
  const isSinglePdfSource = pdfPages.length === pages.length
    && new Set(pages.map((page) => page.storagePath)).size === 1
    && pages.every((page) => page.sourcePageNumber !== null);
  if (isSinglePdfSource) {
    const path = storagePath(pages[0].storagePath);
    if (!existsSync(path)) throw createError({ statusCode: 404, statusMessage: "报告原件文件不存在" });
    return { path, mimeType: "application/pdf", filename };
  }

  const outputPath = reportOriginalExportPath(reportId, reportOriginalExportKey(pages));
  if (existsSync(outputPath)) return { path: outputPath, mimeType: "application/pdf", filename };
  throw createError({ statusCode: 409, statusMessage: "PDF 正在生成，请稍后刷新后下载" });
}

async function generateReportOriginalExport(user: RequestUser, reportId: string) {
  const { pages } = reportOriginalPages(user, reportId);
  const workerPages = pages.map((page) => ({
    path: storagePath(page.storagePath), mimeType: page.mimeType,
    sourcePageNumber: page.sourcePageNumber, rotation: page.rotation,
  }));
  for (const page of workerPages) {
    if (!existsSync(page.path)) throw new Error("报告原件文件不存在");
  }
  const outputPath = reportOriginalExportPath(reportId, reportOriginalExportKey(pages));
  if (existsSync(outputPath)) return;
  try {
    const result = await requestWorker({
      action: "assemble_pdf", imagePath: workerPages[0].path, mimeType: workerPages[0].mimeType,
      outputPath, pages: workerPages,
    });
    if (!result.ok || !existsSync(outputPath)) throw new Error(result.errorMessage || "报告原件 PDF 导出失败");
  } catch (error) {
    rmSync(outputPath, { force: true });
    throw error;
  }
}

export function getReportOriginalExportStatus(user: RequestUser, reportId: string) {
  const { report, pages } = reportOriginalPages(user, reportId);
  const filename = reportDownloadFilename(report.title, pages[0].originalName.replace(/\.[^.]+$/, ""));
  const isPdf = pages.every((page) => page.mimeType === "application/pdf")
    && new Set(pages.map((page) => page.storagePath)).size === 1;
  if (isPdf) return { status: "ready" as const, filename };
  const key = reportOriginalExportKey(pages);
  const outputPath = reportOriginalExportPath(reportId, key);
  if (existsSync(outputPath)) return { status: "ready" as const, filename };
  return { status: reportOriginalExportTasks.has(`${reportId}:${key}`) ? "generating" as const : "available" as const, filename };
}

export function queueReportOriginalExport(user: RequestUser, reportId: string) {
  const status = getReportOriginalExportStatus(user, reportId);
  if (status.status !== "available") return status;
  const { pages } = reportOriginalPages(user, reportId);
  const taskKey = `${reportId}:${reportOriginalExportKey(pages)}`;
  if (!reportOriginalExportTasks.has(taskKey)) {
    const task = generateReportOriginalExport(user, reportId)
      .catch(() => undefined)
      .finally(() => reportOriginalExportTasks.delete(taskKey));
    reportOriginalExportTasks.set(taskKey, task);
  }
  return { ...status, status: "generating" as const };
}

export function getReportOriginalDownloadInfo(user: RequestUser, reportId: string) {
  const { report, pages } = reportOriginalPages(user, reportId);
  const sourceIsPdf = pages.length && pages.every((page) => page.mimeType === "application/pdf")
    && new Set(pages.map((page) => page.storagePath)).size === 1;
  const cachedPath = reportOriginalExportPath(reportId, reportOriginalExportKey(pages));
  return {
    filename: reportDownloadFilename(report.title, pages[0].originalName.replace(/\.[^.]+$/, "")),
    directPath: sourceIsPdf ? storagePath(pages[0].storagePath) : existsSync(cachedPath) ? cachedPath : null,
  };
}

export async function getReportPagePreviewFile(
  user: RequestUser,
  reportId: string,
  pageId: string,
) {
  const row = getDatabase()
    .prepare(
      `
    SELECT r.member_id AS memberId, p.id AS pageId, p.original_name AS originalName,
      p.mime_type AS mimeType, p.storage_path AS storagePath, p.thumbnail_path AS thumbnailPath,
      p.source_page_number AS sourcePageNumber, p.page_number AS pageNumber, p.rotation
    FROM report_pages p
    JOIN reports r ON r.id = p.report_id
    WHERE p.id = ? AND p.report_id = ? AND r.status <> 'trashed'
  `,
    )
    .get(pageId, reportId) as
    | {
        memberId: string;
        pageId: string;
        originalName: string;
        mimeType: string;
        storagePath: string;
        thumbnailPath: string | null;
        sourcePageNumber: number | null;
        pageNumber: number;
        rotation: number;
      }
    | undefined;
  if (!row)
    throw createError({ statusCode: 404, statusMessage: "报告页面不存在" });
  assertMemberAccess(user, row.memberId);

  if (row.mimeType !== "application/pdf") {
    return getReportPageFile(user, reportId, pageId, "original");
  }

  const previewRelativePath = pdfPreviewRelativePath(reportId, pageId);
  const previewPath = storagePath(previewRelativePath);
  if (hasUsableJpegPreview(previewPath)) {
    return {
      path: previewPath,
      mimeType: "image/jpeg",
      filename: `${row.originalName}-第${row.pageNumber}页.jpg`,
    };
  }
  if (existsSync(previewPath)) rmSync(previewPath, { force: true });

  const originalPath = storagePath(row.storagePath);
  let previewError: unknown = null;
  try {
    await requestWorker({
      action: "thumbnail",
      imagePath: originalPath,
      mimeType: row.mimeType,
      outputPath: previewPath,
      pageNumber: row.sourcePageNumber || row.pageNumber,
      rotation: row.rotation,
      maxSize: pdfPreviewMaxSize,
      quality: pdfPreviewQuality,
      renderScale: pdfPreviewRenderScale,
    });
    if (hasUsableJpegPreview(previewPath)) {
      return {
        path: previewPath,
        mimeType: "image/jpeg",
        filename: `${row.originalName}-第${row.pageNumber}页.jpg`,
      };
    }
    if (existsSync(previewPath)) rmSync(previewPath, { force: true });
  } catch (error) {
    previewError = error;
    if (existsSync(previewPath)) rmSync(previewPath, { force: true });
    // 如果运行环境暂不可用，降级到已生成的缩略图，避免看图模式因整份 PDF 加载而卡住。
  }

  if (row.thumbnailPath) {
    const thumbnailPath = storagePath(row.thumbnailPath);
    if (hasUsableJpegPreview(thumbnailPath)) {
      return {
        path: thumbnailPath,
        mimeType: "image/jpeg",
        filename: `${row.originalName}-第${row.pageNumber}页-preview.jpg`,
      };
    }
  }
  if (isPermanentPreviewDecodeFailure(previewError)) {
    throw createError({
      statusCode: 422,
      statusMessage: "报告原件损坏或格式不匹配，无法生成预览",
    });
  }
  throw createError({ statusCode: 503, statusMessage: "当前页预览图尚未生成" });
}

export function listReportOcrText(user: RequestUser, reportId: string) {
  const report = getDatabase()
    .prepare(
      "SELECT member_id AS memberId FROM reports WHERE id = ? AND status <> 'trashed'",
    )
    .get(reportId) as { memberId: string } | undefined;
  if (!report)
    throw createError({ statusCode: 404, statusMessage: "报告不存在" });
  assertMemberAccess(user, report.memberId);
  return getDatabase()
    .prepare(
      `
    SELECT p.id AS pageId, p.page_number AS pageNumber, p.original_name AS originalName,
      o.engine, o.model_version AS modelVersion, o.elapsed_ms AS elapsedMs, o.lines_json AS linesJson,
      o.quality_score AS qualityScore, o.quality_level AS qualityLevel, o.quality_reason AS qualityReason
    FROM report_pages p
    LEFT JOIN ocr_results o ON o.page_id = p.id
    WHERE p.report_id = ?
    ORDER BY p.page_number
  `,
    )
    .all(reportId)
    .map((row) => {
      const item = row as {
        pageId: string;
        pageNumber: number;
        originalName: string;
        engine: string | null;
        modelVersion: string | null;
        elapsedMs: number | null;
        linesJson: string | null;
        qualityScore: number | null;
        qualityLevel: "good" | "weak" | "poor" | null;
        qualityReason: string | null;
      };
      const lines = parseJson<Array<Record<string, unknown>>>(
        item.linesJson,
        [],
      )
        .map((line) =>
          typeof line.text === "string"
            ? redactSensitiveText(line.text).trim()
            : "",
        )
        .filter(Boolean);
      return {
        pageId: item.pageId,
        pageNumber: item.pageNumber,
        originalName: item.originalName,
        engine: item.engine,
        modelVersion: item.modelVersion,
        elapsedMs: item.elapsedMs,
        qualityScore: item.qualityScore,
        qualityLevel: item.qualityLevel,
        qualityReason: item.qualityReason,
        lineCount: lines.length,
        text: lines.join("\n"),
      };
    });
}

export type OcrLineDetail = {
  id: string;
  text: string;
  confidence: number;
  box: number[] | null;
};

export type OcrPageDetail = {
  pageId: string;
  pageNumber: number;
  engine: string | null;
  modelVersion: string | null;
  coordWidth: number | null;
  coordHeight: number | null;
  lines: OcrLineDetail[];
};

function normalizeOcrBox(
  value: unknown,
): [number, number, number, number] | null {
  if (!Array.isArray(value)) return null;
  const points: Array<{ x: number; y: number }> = [];
  if (value.length >= 4 && value.every((item) => typeof item === "number")) {
    points.push(
      { x: Number(value[0]), y: Number(value[1]) },
      { x: Number(value[2]), y: Number(value[3]) },
    );
  } else if (Array.isArray(value[0])) {
    for (const point of value) {
      if (Array.isArray(point) && point.length >= 2) {
        points.push({ x: Number(point[0]), y: Number(point[1]) });
      }
    }
  }
  if (
    !points.length ||
    points.some(
      (point) => !Number.isFinite(point.x) || !Number.isFinite(point.y),
    )
  )
    return null;
  return [
    Math.min(...points.map((point) => point.x)),
    Math.min(...points.map((point) => point.y)),
    Math.max(...points.map((point) => point.x)),
    Math.max(...points.map((point) => point.y)),
  ];
}

function rotateOcrPointBox(
  box: [number, number, number, number],
  rotation: number,
  width: number,
  height: number,
): [number, number, number, number] {
  const normalized = ((rotation % 360) + 360) % 360;
  if (!normalized) return box;
  const [x1, y1, x2, y2] = box;
  const corners: Array<[number, number]> = [
    [x1, y1],
    [x2, y1],
    [x2, y2],
    [x1, y2],
  ];
  // 与缩略图管线的 Image.rotate(-rotation, expand=True) 保持同一变换，
  // 让内嵌文本框落到旋转后的页面坐标系。
  let points: Array<[number, number]>;
  if (normalized === 90)
    points = corners.map(([x, y]) => [height - y, x]);
  else if (normalized === 180)
    points = corners.map(([x, y]) => [width - x, height - y]);
  else if (normalized === 270)
    points = corners.map(([x, y]) => [y, width - x]);
  else return box;
  const xs = points.map((point) => point[0]);
  const ys = points.map((point) => point[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

function legacyOcrRenderScale(reportId: string, pageId: string) {
  const row = getDatabase()
    .prepare(
      `
    SELECT detail_json AS detailJson FROM processing_job_events
    WHERE report_id = ? AND event_type = 'completed'
      AND json_extract(detail_json, '$.pageId') = ?
    ORDER BY rowid DESC LIMIT 1
  `,
    )
    .get(reportId, pageId) as { detailJson: string | null } | undefined;
  const detail = parseJson<Record<string, unknown>>(row?.detailJson, {});
  const scale = Number(detail.renderScale);
  if (Number.isFinite(scale) && scale >= 2 && scale <= 4) return scale;
  return defaultOcrPdfRenderScale();
}

type OcrPageRow = {
  pageId: string;
  pageNumber: number;
  rotation: number;
  mimeType: string;
  storagePath: string;
  sourcePageNumber: number | null;
  ocrResultId: string | null;
  engine: string | null;
  modelVersion: string | null;
  linesJson: string | null;
  coordWidth: number | null;
  coordHeight: number | null;
};

// 历史 OCR 结果的坐标系不统一：内嵌 PDF 文本框是页面点坐标，OCR 行是渲染
// 像素坐标（×renderScale），叠加层无法直接对齐。首次访问时把整页归一到
// 页面点坐标（含用户旋转角度），并把参考尺寸写回 ocr_results，之后按新
// 格式直接读取。
async function healLegacyOcrCoordSpace(
  reportId: string,
  row: OcrPageRow,
  rawLines: Array<Record<string, unknown>>,
  workerExecutor: typeof requestWorker,
): Promise<{
  lines: Array<Record<string, unknown>>;
  coordWidth: number;
  coordHeight: number;
} | null> {
  if (!row.ocrResultId || !row.linesJson) return null;
  const isPdf =
    row.mimeType === "application/pdf" ||
    row.storagePath.toLowerCase().endsWith(".pdf");
  if (!isPdf) return null;
  const sourcePageNumber = row.sourcePageNumber || row.pageNumber;
  let pageWidth = 0;
  let pageHeight = 0;
  try {
    const inspection = await workerExecutor({
      action: "inspect_pdf",
      imagePath: storagePath(row.storagePath),
      mimeType: row.mimeType,
    });
    const inspected = inspection.pages?.find(
      (page) => page.pageNumber === sourcePageNumber,
    );
    if (inspected && inspected.width > 0 && inspected.height > 0) {
      pageWidth = inspected.width;
      pageHeight = inspected.height;
    }
  } catch {
    return null;
  }
  if (!pageWidth || !pageHeight) return null;
  const rotation = ((row.rotation % 360) + 360) % 360;
  const renderScale = legacyOcrRenderScale(reportId, row.pageId);
  const normalizedLines = rawLines.map((line) => {
    const box = line.box;
    let pointBox: [number, number, number, number] | null = null;
    if (
      Array.isArray(box) &&
      box.length >= 4 &&
      box.every((value) => typeof value === "number")
    ) {
      // 扁平 bbox 来自 PDF 内嵌文本层，本来就是页面点坐标。
      pointBox = [
        Number(box[0]),
        Number(box[1]),
        Number(box[2]),
        Number(box[3]),
      ];
    } else if (Array.isArray(box) && Array.isArray(box[0])) {
      // 四点坐标来自渲染位图上的 OCR，需要折算回页面点坐标。
      const xs: number[] = [];
      const ys: number[] = [];
      for (const point of box) {
        if (Array.isArray(point) && point.length >= 2) {
          xs.push(Number(point[0]) / renderScale);
          ys.push(Number(point[1]) / renderScale);
        }
      }
      if (xs.length)
        pointBox = [
          Math.min(...xs),
          Math.min(...ys),
          Math.max(...xs),
          Math.max(...ys),
        ];
    }
    if (!pointBox) return line;
    const rotated = rotateOcrPointBox(
      pointBox,
      rotation,
      pageWidth,
      pageHeight,
    ).map((value) => Math.round(value * 100) / 100);
    return { ...line, box: rotated };
  });
  const [coordWidth, coordHeight] =
    rotation % 180 ? [pageHeight, pageWidth] : [pageWidth, pageHeight];
  getDatabase()
    .prepare(
      `
    UPDATE ocr_results SET lines_json = ?, coord_width = ?, coord_height = ?
    WHERE id = ? AND coord_width IS NULL
  `,
    )
    .run(
      JSON.stringify(normalizedLines),
      coordWidth,
      coordHeight,
      row.ocrResultId,
    );
  return { lines: normalizedLines, coordWidth, coordHeight };
}

export async function getReportPageOcrDetail(
  user: RequestUser,
  reportId: string,
  pageId: string,
  workerExecutor: typeof requestWorker = requestWorker,
): Promise<OcrPageDetail | null> {
  const report = getDatabase()
    .prepare(
      "SELECT member_id AS memberId FROM reports WHERE id = ? AND status <> 'trashed'",
    )
    .get(reportId) as { memberId: string } | undefined;
  if (!report)
    throw createError({ statusCode: 404, statusMessage: "报告不存在" });
  assertMemberAccess(user, report.memberId);
  const row = getDatabase()
    .prepare(
      `
    SELECT p.id AS pageId, p.page_number AS pageNumber,
      p.rotation, p.mime_type AS mimeType, p.storage_path AS storagePath,
      p.source_page_number AS sourcePageNumber,
      o.id AS ocrResultId, o.engine, o.model_version AS modelVersion,
      o.lines_json AS linesJson, o.coord_width AS coordWidth,
      o.coord_height AS coordHeight
    FROM report_pages p
    LEFT JOIN ocr_results o ON o.page_id = p.id
    WHERE p.id = ? AND p.report_id = ?
  `,
    )
    .get(pageId, reportId) as OcrPageRow | undefined;
  if (!row) return null;
  let rawLines = parseJson<Array<Record<string, unknown>>>(row.linesJson, []);
  let coordWidth =
    typeof row.coordWidth === "number" && row.coordWidth > 0
      ? row.coordWidth
      : null;
  let coordHeight =
    typeof row.coordHeight === "number" && row.coordHeight > 0
      ? row.coordHeight
      : null;
  if ((!coordWidth || !coordHeight) && rawLines.length) {
    const healed = await healLegacyOcrCoordSpace(
      reportId,
      row,
      rawLines,
      workerExecutor,
    );
    if (healed) {
      rawLines = healed.lines;
      coordWidth = healed.coordWidth;
      coordHeight = healed.coordHeight;
    }
  }
  const lines = rawLines
    .map((line, index): OcrLineDetail | null => {
      const text =
        typeof line.text === "string"
          ? redactSensitiveText(line.text).trim()
          : "";
      if (!text) return null;
      const id =
        typeof line.id === "string" && line.id.trim()
          ? line.id.trim()
          : `page_${row.pageNumber}_line_${index + 1}`;
      const confidence =
        typeof line.confidence === "number" ? line.confidence : 0;
      const box = normalizeOcrBox(line.box);
      return { id, text, confidence, box };
    })
    .filter((line): line is OcrLineDetail => line !== null);
  return {
    pageId: row.pageId,
    pageNumber: row.pageNumber,
    engine: row.engine,
    modelVersion: row.modelVersion,
    coordWidth,
    coordHeight,
    lines,
  };
}

export function confirmReportReady(user: RequestUser, reportId: string) {
  const report = getDatabase()
    .prepare(
      "SELECT member_id AS memberId, status FROM reports WHERE id = ? AND status <> 'trashed'",
    )
    .get(reportId) as { memberId: string; status: string } | undefined;
  if (!report)
    throw createError({ statusCode: 404, statusMessage: "报告不存在" });
  assertMemberManage(user, report.memberId);
  if (report.status === "ready") return { id: reportId, status: "ready" };
  if (report.status !== "needs_review") {
    throw createError({
      statusCode: 409,
      statusMessage: "只有待确认报告可以归档",
    });
  }
  const db = getDatabase();
  db.prepare(
    "UPDATE reports SET status = 'ready', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
  ).run(reportId);
  db.prepare(
    `
    INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, detail_json)
    VALUES (?, ?, 'report.confirm_ready', 'report', ?, ?)
  `,
  ).run(
    createId("audit"),
    user.id,
    reportId,
    JSON.stringify({ memberId: report.memberId }),
  );
  const reminder = createReportSuggestionReminder(user, reportId);
  return {
    id: reportId,
    status: "ready",
    ...(reminder ? { reminderCreated: true } : {}),
  };
}

export function trashReport(user: RequestUser, reportId: string) {
  const report = getDatabase()
    .prepare(
      "SELECT member_id AS memberId, status FROM reports WHERE id = ? AND status <> 'trashed'",
    )
    .get(reportId) as { memberId: string; status: string } | undefined;
  if (!report)
    throw createError({ statusCode: 404, statusMessage: "报告不存在" });
  assertMemberManage(user, report.memberId);
  const db = getDatabase();
  db.prepare(
    `
    UPDATE reports
    SET status = 'trashed',
      deleted_at = CURRENT_TIMESTAMP,
      purge_after = datetime('now', '+30 days'),
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `,
  ).run(reportId);
  db.prepare(
    `
    UPDATE processing_jobs
    SET status = 'cancelled',
      finished_at = COALESCE(finished_at, CURRENT_TIMESTAMP)
    WHERE report_id = ? AND status IN ('queued', 'processing')
  `,
  ).run(reportId);
  db.prepare(
    `
    INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, detail_json)
    VALUES (?, ?, 'report.trash', 'report', ?, ?)
  `,
  ).run(
    createId("audit"),
    user.id,
    reportId,
    JSON.stringify({
      memberId: report.memberId,
      previousStatus: report.status,
    }),
  );
  return { id: reportId, status: "trashed" as const, purgeAfterDays: 30 };
}

export function restoreReport(user: RequestUser, reportId: string) {
  const report = getDatabase()
    .prepare("SELECT member_id AS memberId, status FROM reports WHERE id = ?")
    .get(reportId) as { memberId: string; status: string } | undefined;
  if (!report)
    throw createError({ statusCode: 404, statusMessage: "报告不存在" });
  assertMemberManage(user, report.memberId);
  if (report.status !== "trashed")
    return { id: reportId, status: report.status };
  getDatabase()
    .prepare(
      `
    UPDATE reports SET status = 'needs_review', deleted_at = NULL, purge_after = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `,
    )
    .run(reportId);
  getDatabase()
    .prepare(
      `
    INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, detail_json)
    VALUES (?, ?, 'report.restore', 'report', ?, ?)
  `,
    )
    .run(
      createId("audit"),
      user.id,
      reportId,
      JSON.stringify({ memberId: report.memberId }),
    );
  return { id: reportId, status: "needs_review" as const };
}

export function permanentlyDeleteReport(user: RequestUser, reportId: string) {
  const report = getDatabase()
    .prepare(
      "SELECT member_id AS memberId, title, status FROM reports WHERE id = ?",
    )
    .get(reportId) as
    { memberId: string; title: string; status: string } | undefined;
  if (!report)
    throw createError({ statusCode: 404, statusMessage: "报告不存在" });
  assertMemberManage(user, report.memberId);
  if (report.status !== "trashed")
    throw createError({
      statusCode: 409,
      statusMessage: "只有回收站报告可以永久删除",
    });
  return purgeTrashedReport(reportId, user.id, false);
}

function purgeTrashedReport(
  reportId: string,
  actorUserId: string | null,
  automatic: boolean,
) {
  const report = getDatabase()
    .prepare(
      "SELECT member_id AS memberId, title, status FROM reports WHERE id = ?",
    )
    .get(reportId) as
    { memberId: string; title: string; status: string } | undefined;
  if (!report || report.status !== "trashed") {
    throw createError({
      statusCode: 409,
      statusMessage: "只有回收站报告可以永久删除",
    });
  }
  if (isReportJobActive(reportId)) {
    throw createError({
      statusCode: 409,
      statusMessage: "报告任务仍在结束处理中，请稍后再永久删除",
    });
  }
  const pages = reportPageRows(reportId);
  const db = getDatabase();
  const governanceSnapshot = db
    .prepare(
      `
    SELECT
      COUNT(*) AS activeDecisions,
      SUM(CASE WHEN decision = 'duplicate' THEN 1 ELSE 0 END) AS duplicateDecisions,
      SUM(CASE WHEN decision = 'distinct' THEN 1 ELSE 0 END) AS distinctDecisions
    FROM report_duplicate_decisions
    WHERE left_report_id = ? OR right_report_id = ?
  `,
    )
    .get(reportId, reportId) as {
    activeDecisions: number;
    duplicateDecisions: number | null;
    distinctDecisions: number | null;
  };
  const governanceHistory = db
    .prepare(
      `
    SELECT COUNT(*) AS count
    FROM report_duplicate_history
    WHERE left_report_id = ? OR right_report_id = ?
  `,
    )
    .get(reportId, reportId) as { count: number };
  const reportFingerprint = createHash("sha256")
    .update(`${report.memberId}\u0000${reportId}\u0000${report.title}`)
    .digest("base64url");
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(
      `
      INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, detail_json)
      VALUES (?, ?, 'report.purge', 'report', ?, ?)
    `,
    ).run(
      createId("audit"),
      actorUserId,
      reportId,
      JSON.stringify({
        memberId: report.memberId,
        reportFingerprint,
        pageCount: pages.length,
        automatic,
        governanceSnapshot: {
          activeDecisions: Number(governanceSnapshot.activeDecisions || 0),
          duplicateDecisions: Number(
            governanceSnapshot.duplicateDecisions || 0,
          ),
          distinctDecisions: Number(governanceSnapshot.distinctDecisions || 0),
          historyEvents: Number(governanceHistory.count || 0),
        },
      }),
    );
    db.prepare("DELETE FROM reports WHERE id = ?").run(reportId);
    enqueueFileGarbage(
      pages.flatMap((page) => [
        { storagePath: page.storagePath, fileKind: "original" as const },
        { storagePath: page.thumbnailPath, fileKind: "thumbnail" as const },
      ]),
      automatic ? "recycle_bin_expired" : "report_purge",
      db,
    );
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { id: reportId, deleted: true };
}

export function purgeExpiredReports(limit = 50) {
  const rows = getDatabase()
    .prepare(
      `
    SELECT id FROM reports
    WHERE status = 'trashed' AND purge_after IS NOT NULL AND purge_after <= CURRENT_TIMESTAMP
    ORDER BY purge_after, id
    LIMIT ?
  `,
    )
    .all(Math.min(200, Math.max(1, Math.round(limit)))) as Array<{
    id: string;
  }>;
  let deleted = 0;
  const errors: Array<{ reportId: string; message: string }> = [];
  for (const row of rows) {
    try {
      purgeTrashedReport(row.id, null, true);
      deleted += 1;
    } catch (error) {
      errors.push({
        reportId: row.id,
        message: error instanceof Error ? error.message : "自动清理失败",
      });
    }
  }
  return { checked: rows.length, deleted, failed: errors.length, errors };
}

type DuplicateOperationInput = {
  operation: ReportDuplicateOperationRecord["operation"];
  memberId: string;
  ruleVersion: ReportDuplicateRuleVersion | null;
  purpose: string;
  requestedBy: string | null;
  stats?: Record<string, unknown>;
};

const duplicateScanOperationRetentionLimit = 200;

function startDuplicateOperation(input: DuplicateOperationInput) {
  const id = createId("duplicate-operation");
  getDatabase()
    .prepare(
      `
    INSERT INTO report_duplicate_operations (
      id, operation, member_id, rule_version, status, purpose, requested_by, stats_json
    ) VALUES (?, ?, ?, ?, 'running', ?, ?, ?)
  `,
    )
    .run(
      id,
      input.operation,
      input.memberId,
      input.ruleVersion,
      input.purpose,
      input.requestedBy,
      JSON.stringify(input.stats || {}),
    );
  return id;
}

function notifyDuplicateOperationFailure(
  operationId: string,
  memberId: string,
  operation: string,
) {
  getDatabase()
    .prepare(
      `
    INSERT INTO app_notifications (id, member_id, report_id, type, title, message, severity)
    VALUES (?, ?, NULL, 'report_failed', '重复报告治理任务失败', ?, 'error')
  `,
    )
    .run(
      createId("notice"),
      memberId,
      `重复报告治理任务（${operation}）未完成，系统已保留聚合运行记录。请由管理员检查后重试。`,
    );
  getDatabase()
    .prepare(
      `
    INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, detail_json)
    VALUES (?, NULL, 'report.duplicate_operation_failed', 'report_duplicate_operation', ?, ?)
  `,
    )
    .run(
      createId("audit"),
      operationId,
      JSON.stringify({ operationId, memberId, operation }),
    );
}

function finishDuplicateOperation(
  operationId: string,
  stats: Record<string, unknown>,
  error?: unknown,
) {
  const errorMessage = error
    ? error instanceof Error
      ? error.message
      : String(error)
    : null;
  const db = getDatabase();
  const operation = db
    .prepare(
      `
    SELECT member_id AS memberId, operation
    FROM report_duplicate_operations
    WHERE id = ?
  `,
    )
    .get(operationId) as { memberId: string; operation: string } | undefined;
  db.prepare(
    `
    UPDATE report_duplicate_operations
    SET status = ?, stats_json = ?, error_message = ?, finished_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `,
  ).run(
    errorMessage ? "failed" : "completed",
    JSON.stringify(stats),
    errorMessage,
    operationId,
  );
  if (errorMessage && operation) {
    notifyDuplicateOperationFailure(
      operationId,
      operation.memberId,
      operation.operation,
    );
  }
}

export function recoverTimedOutDuplicateReportOperations(timeoutMinutes = 30) {
  const normalizedTimeout = Math.min(
    1_440,
    Math.max(5, Math.round(timeoutMinutes)),
  );
  const db = getDatabase();
  const rows = db
    .prepare(
      `
    SELECT id, member_id AS memberId, operation, rule_version AS ruleVersion, started_at AS startedAt
    FROM report_duplicate_operations
    WHERE status = 'running'
      AND started_at < datetime('now', ?)
    ORDER BY started_at, id
    LIMIT 500
  `,
    )
    .all(`-${normalizedTimeout} minutes`) as Array<{
    id: string;
    memberId: string;
    operation: string;
    ruleVersion: string | null;
    startedAt: string;
  }>;
  const recovered: Array<{
    operationId: string;
    memberId: string;
    operation: string;
  }> = [];
  db.exec("BEGIN IMMEDIATE");
  try {
    const markFailed = db.prepare(`
      UPDATE report_duplicate_operations
      SET status = 'failed', error_message = '任务超时，已由维护任务回收',
        stats_json = json_set(COALESCE(NULLIF(stats_json, ''), '{}'), '$.recoveredByMaintenance', 1),
        finished_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'running'
    `);
    for (const row of rows) {
      const result = markFailed.run(row.id);
      if (!Number(result.changes || 0)) continue;
      notifyDuplicateOperationFailure(row.id, row.memberId, row.operation);
      recovered.push({
        operationId: row.id,
        memberId: row.memberId,
        operation: row.operation,
      });
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return {
    timeoutMinutes: normalizedTimeout,
    checked: rows.length,
    recovered: recovered.length,
    operations: recovered,
  };
}

function pruneDuplicateScanOperations(memberId: string) {
  getDatabase()
    .prepare(
      `
    DELETE FROM report_duplicate_operations
    WHERE id IN (
      SELECT id
      FROM report_duplicate_operations
      WHERE member_id = ? AND operation = 'scan'
      ORDER BY created_at DESC, id DESC
      LIMIT -1 OFFSET ?
    )
  `,
    )
    .run(memberId, duplicateScanOperationRetentionLimit);
}

function recordDuplicateScanOperation(
  operationId: string,
  memberId: string,
  ruleSelection: ReportDuplicateRuleSelection,
  stats: DuplicateScanStats,
  candidatePairs: number,
) {
  finishDuplicateOperation(operationId, {
    sourceReportsScanned: stats.sourceReportsScanned,
    candidateComparisons: stats.candidateComparisons,
    candidatePairs,
    governedCandidateOverrides: stats.governedCandidateOverrides,
    scanDurationMs: stats.scanDurationMs,
    ruleSelectionSource: ruleSelection.source,
    activeVersion: ruleSelection.activeVersion,
    candidateVersion: ruleSelection.candidateVersion,
  });
  pruneDuplicateScanOperations(memberId);
}

export function listDuplicateReportOperations(
  user: RequestUser,
  memberId: string,
  limit = 20,
): ReportDuplicateOperationRecord[] {
  if (!memberId)
    throw createError({ statusCode: 400, statusMessage: "请选择成员" });
  assertMemberAccess(user, memberId);
  const rows = getDatabase()
    .prepare(
      `
    SELECT id, operation, member_id AS memberId, rule_version AS ruleVersion,
      status, purpose, stats_json AS statsJson, error_message AS errorMessage,
      created_at AS createdAt, started_at AS startedAt, finished_at AS finishedAt
    FROM report_duplicate_operations
    WHERE member_id = ?
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `,
    )
    .all(memberId, Math.min(100, Math.max(1, Math.round(limit)))) as Array<{
    id: string;
    operation: ReportDuplicateOperationRecord["operation"];
    memberId: string;
    ruleVersion: string | null;
    status: ReportDuplicateOperationRecord["status"];
    purpose: string;
    statsJson: string;
    errorMessage: string | null;
    createdAt: string;
    startedAt: string;
    finishedAt: string | null;
  }>;
  return rows.map((row) => ({
    id: row.id,
    operation: row.operation,
    memberId: row.memberId,
    ruleVersion: row.ruleVersion,
    status: row.status,
    purpose: row.purpose,
    stats: parseJson(row.statsJson, {}),
    errorMessage: row.errorMessage,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
  }));
}

function scanDuplicateReportGroups(
  user: RequestUser,
  memberId: string,
  purpose = "manual_scan",
) {
  if (!memberId)
    throw createError({ statusCode: 400, statusMessage: "请选择成员" });
  const startedAt = Date.now();
  const rows = duplicateSourceRowsForMember(user, memberId);
  const stats: DuplicateScanStats = {
    sourceReportsScanned: rows.length,
    candidateComparisons: 0,
    governedCandidateOverrides: 0,
    scanDurationMs: 0,
  };
  const context: DuplicateScanContext = {
    stats,
    fileSignatures: new Map(),
    observationSignatures: new Map(),
    ruleSelection: resolveReportDuplicateRuleSelection(),
  };
  const operationId = startDuplicateOperation({
    operation: "scan",
    memberId,
    ruleVersion: context.ruleSelection.version,
    purpose,
    requestedBy: user.id,
    stats: {},
  });
  try {
    const seenPairs = new Set<string>();
    const groups: DuplicateReportGroup[] = [];
    for (const report of rows) {
      const candidates = findDuplicateCandidates(report, context).filter(
        (candidate) => {
          const key = [report.id, candidate.id].sort().join(":");
          if (seenPairs.has(key)) return false;
          seenPairs.add(key);
          return true;
        },
      );
      if (candidates.length) groups.push({ report, candidates });
    }
    stats.scanDurationMs = Date.now() - startedAt;
    recordDuplicateScanOperation(
      operationId,
      memberId,
      context.ruleSelection,
      stats,
      groups.reduce((sum, group) => sum + group.candidates.length, 0),
    );
    return { groups, stats, ruleSelection: context.ruleSelection };
  } catch (error) {
    stats.scanDurationMs = Date.now() - startedAt;
    finishDuplicateOperation(
      operationId,
      {
        sourceReportsScanned: stats.sourceReportsScanned,
        candidateComparisons: stats.candidateComparisons,
        scanDurationMs: stats.scanDurationMs,
        ruleSelectionSource: context.ruleSelection.source,
        activeVersion: context.ruleSelection.activeVersion,
        candidateVersion: context.ruleSelection.candidateVersion,
      },
      error,
    );
    pruneDuplicateScanOperations(memberId);
    throw error;
  }
}

export function listDuplicateReportGroups(
  user: RequestUser,
  memberId: string,
): DuplicateReportGroup[] {
  return scanDuplicateReportGroups(user, memberId).groups;
}

function duplicateReportMetrics(
  memberId: string,
  groups: DuplicateReportGroup[],
  stats: DuplicateScanStats,
): ReportDuplicateMetrics {
  const db = getDatabase();
  const decisionCounts = db
    .prepare(
      `
    SELECT
      SUM(CASE WHEN decision = 'duplicate' THEN 1 ELSE 0 END) AS duplicateCount,
      SUM(CASE WHEN decision = 'distinct' THEN 1 ELSE 0 END) AS distinctCount
    FROM report_duplicate_decisions
    WHERE member_id = ?
  `,
    )
    .get(memberId) as {
    duplicateCount: number | null;
    distinctCount: number | null;
  };
  const historyCounts = db
    .prepare(
      `
    SELECT COUNT(*) AS totalCount,
      COUNT(DISTINCT CASE
        WHEN json_extract(evidence_json, '$.source') = 'merge' THEN pair_key
        ELSE NULL
      END) AS mergedPairs
    FROM report_duplicate_history
    WHERE member_id = ?
  `,
    )
    .get(memberId) as { totalCount: number; mergedPairs: number };
  const candidates = groups.flatMap((group) => group.candidates);
  const manualDuplicateDecisions = Number(decisionCounts.duplicateCount || 0);
  const manualDistinctDecisions = Number(decisionCounts.distinctCount || 0);
  const decisionTotal = manualDuplicateDecisions + manualDistinctDecisions;
  return {
    candidateGroups: groups.length,
    candidatePairs: candidates.length,
    highCandidates: candidates.filter(
      (candidate) => candidate.confidence === "high",
    ).length,
    mediumCandidates: candidates.filter(
      (candidate) => candidate.confidence === "medium",
    ).length,
    sameOriginalCandidates: candidates.filter((candidate) =>
      candidate.matchedFields.includes("原始文件"),
    ).length,
    manualDuplicateDecisions,
    manualDistinctDecisions,
    totalDecisionHistory: Number(historyCounts.totalCount || 0),
    duplicateConfirmRate: decisionTotal
      ? manualDuplicateDecisions / decisionTotal
      : 0,
    distinctRejectRate: decisionTotal
      ? manualDistinctDecisions / decisionTotal
      : 0,
    mergedPairs: Number(historyCounts.mergedPairs || 0),
    ...stats,
    scanPolicy: { ...duplicateReportScanPolicy },
  };
}

export type DuplicateReportOverviewOptions = {
  query?: string;
  confidence?: "high" | "medium";
  reportType?: string;
  hospital?: string;
  page?: number;
  pageSize?: number;
};

function filterDuplicateReportGroups(
  groups: DuplicateReportGroup[],
  options: DuplicateReportOverviewOptions,
) {
  const query = String(options.query || "")
    .trim()
    .toLocaleLowerCase();
  const reportType = String(options.reportType || "").trim();
  const hospital = String(options.hospital || "").trim();
  return groups.flatMap((group) => {
    const candidates = group.candidates.filter((candidate) => {
      if (options.confidence && candidate.confidence !== options.confidence)
        return false;
      if (
        reportType &&
        group.report.reportType !== reportType &&
        candidate.reportType !== reportType
      )
        return false;
      if (
        hospital &&
        group.report.hospitalName !== hospital &&
        candidate.hospitalName !== hospital
      )
        return false;
      if (!query) return true;
      return [
        group.report.title,
        candidate.title,
        group.report.hospitalName,
        candidate.hospitalName,
        candidate.reason,
      ]
        .filter(Boolean)
        .join(" ")
        .toLocaleLowerCase()
        .includes(query);
    });
    return candidates.length ? [{ report: group.report, candidates }] : [];
  });
}

export function getDuplicateReportOverview(
  user: RequestUser,
  memberId: string,
  options: DuplicateReportOverviewOptions = {},
): DuplicateReportOverview {
  const { groups, stats } = scanDuplicateReportGroups(
    user,
    memberId,
    "overview",
  );
  const filteredGroups = filterDuplicateReportGroups(groups, options);
  const pageSize = Math.min(
    100,
    Math.max(1, Math.round(options.pageSize || 20)),
  );
  const totalGroups = filteredGroups.length;
  const totalPairs = filteredGroups.reduce(
    (sum, group) => sum + group.candidates.length,
    0,
  );
  const totalPages = Math.max(1, Math.ceil(totalGroups / pageSize));
  const page = Math.min(totalPages, Math.max(1, Math.round(options.page || 1)));
  return {
    groups: filteredGroups.slice((page - 1) * pageSize, page * pageSize),
    decisions: listReportDuplicateDecisions(user, memberId),
    metrics: duplicateReportMetrics(memberId, groups, stats),
    operations: listDuplicateReportOperations(user, memberId, 12),
    pagination: { page, pageSize, totalGroups, totalPairs, totalPages },
    filterOptions: {
      reportTypes: [
        ...new Set(
          groups.flatMap((group) => [
            group.report.reportType,
            ...group.candidates.map((candidate) => candidate.reportType),
          ]),
        ),
      ].sort(),
      hospitals: [
        ...new Set(
          groups
            .flatMap((group) => [
              group.report.hospitalName,
              ...group.candidates.map((candidate) => candidate.hospitalName),
            ])
            .filter((item): item is string => Boolean(item)),
        ),
      ].sort((left, right) => left.localeCompare(right, "zh-CN")),
    },
  };
}

export function getReportDuplicateMetrics(
  user: RequestUser,
  memberId: string,
): ReportDuplicateMetrics {
  const { groups, stats } = scanDuplicateReportGroups(
    user,
    memberId,
    "metrics",
  );
  return duplicateReportMetrics(memberId, groups, stats);
}

type DuplicateComparisonReportRow = ReportSummary & {
  summary: string | null;
  findings: string | null;
  impression: string | null;
};

function duplicateComparisonReport(reportId: string) {
  return getDatabase()
    .prepare(
      `
    SELECT r.id, r.member_id AS memberId, r.title, r.report_type AS reportType, r.status,
      r.hospital_name_raw AS hospitalName, r.hospital_branch AS hospitalBranch,
      ${displayDepartmentSql} AS departmentName,
      json_extract(r.body_parts_json, '$[0].name') AS bodyPart,
      ${reportDisplayDateSql} AS reportIssuedAt,
      ${reportAbnormalCountSql},
      (SELECT COUNT(*) FROM report_pages p WHERE p.report_id = r.id) AS pageCount,
      r.summary, r.findings, r.impression
    FROM reports r
    WHERE r.id = ?
  `,
    )
    .get(reportId) as DuplicateComparisonReportRow | undefined;
}

type DuplicateComparisonObservation = {
  key: string;
  itemName: string;
  result: string;
};

function duplicateComparisonObservations(reportId: string) {
  const rows = getDatabase()
    .prepare(
      `
    SELECT
      COALESCE(NULLIF(n.canonical_key, ''), NULLIF(TRIM(o.normalized_name), ''), o.item_name) AS itemKey,
      COALESCE(NULLIF(n.canonical_name, ''), NULLIF(TRIM(o.normalized_name), ''), o.item_name) AS itemName,
      o.result_text AS resultText, o.numeric_value AS numericValue, o.unit,
      n.canonical_value AS canonicalValue, n.canonical_unit AS canonicalUnit,
      n.quality AS normalizationQuality
    FROM observations o
    LEFT JOIN observation_normalizations n ON n.observation_id = o.id
    WHERE o.report_id = ?
    ORDER BY o.section_name, o.item_name, o.id
    LIMIT 501
  `,
    )
    .all(reportId) as Array<{
    itemKey: string;
    itemName: string;
    resultText: string;
    numericValue: number | null;
    unit: string | null;
    canonicalValue: number | null;
    canonicalUnit: string | null;
    normalizationQuality: string | null;
  }>;
  const truncated = rows.length > 500;
  const items = rows
    .slice(0, 500)
    .flatMap((row): DuplicateComparisonObservation[] => {
      const key = normalizeContentKey(row.itemKey);
      if (!key) return [];
      const useCanonical =
        ["high", "medium"].includes(row.normalizationQuality || "") &&
        row.canonicalValue !== null;
      const value = useCanonical ? row.canonicalValue : row.numericValue;
      const unit = normalizeContentKey(
        useCanonical ? row.canonicalUnit : row.unit,
      );
      const result =
        value === null
          ? normalizeContentKey(row.resultText)
          : `${value}${unit ? ` ${unit}` : ""}`;
      return result ? [{ key, itemName: row.itemName, result }] : [];
    });
  const byKey = new Map<string, { itemName: string; results: Set<string> }>();
  for (const item of items) {
    const existing = byKey.get(item.key) || {
      itemName: item.itemName,
      results: new Set<string>(),
    };
    existing.results.add(item.result);
    byKey.set(item.key, existing);
  }
  return { rowCount: Math.min(rows.length, 500), truncated, byKey };
}

function comparisonText(value: unknown, maxLength = 240) {
  if (value === null || value === undefined || value === "") return null;
  const text = String(value).trim();
  if (!text) return null;
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

export function getReportDuplicateComparison(
  user: RequestUser,
  leftReportId: string,
  rightReportId: string,
): ReportDuplicateComparison {
  const pair =
    leftReportId === rightReportId
      ? null
      : {
          left: duplicateComparisonReport(leftReportId),
          right: duplicateComparisonReport(rightReportId),
        };
  if (!pair?.left || !pair.right)
    throw createError({ statusCode: 404, statusMessage: "报告不存在" });
  if (pair.left.memberId !== pair.right.memberId) {
    throw createError({
      statusCode: 409,
      statusMessage: "只能比较同一成员的报告",
    });
  }
  assertMemberAccess(user, pair.left.memberId);

  const fieldDefinitions: Array<[string, string, unknown, unknown]> = [
    ["title", "报告标题", pair.left.title, pair.right.title],
    ["reportType", "报告类型", pair.left.reportType, pair.right.reportType],
    ["hospitalName", "医院", pair.left.hospitalName, pair.right.hospitalName],
    [
      "hospitalBranch",
      "院区",
      pair.left.hospitalBranch,
      pair.right.hospitalBranch,
    ],
    [
      "reportIssuedAt",
      "报告日期",
      datePart(pair.left.reportIssuedAt),
      datePart(pair.right.reportIssuedAt),
    ],
    [
      "departmentName",
      "科室",
      pair.left.departmentName,
      pair.right.departmentName,
    ],
    ["bodyPart", "检查部位", pair.left.bodyPart, pair.right.bodyPart],
    ["pageCount", "原件页数", pair.left.pageCount, pair.right.pageCount],
    ["summary", "摘要", pair.left.summary, pair.right.summary],
    ["findings", "检查所见", pair.left.findings, pair.right.findings],
    ["impression", "结论", pair.left.impression, pair.right.impression],
  ];
  const fields = fieldDefinitions.map(([key, label, left, right]) => {
    const leftText = comparisonText(left);
    const rightText = comparisonText(right);
    return {
      key,
      label,
      left: leftText,
      right: rightText,
      equal: normalizeContentKey(leftText) === normalizeContentKey(rightText),
    };
  });

  const leftObservations = duplicateComparisonObservations(pair.left.id);
  const rightObservations = duplicateComparisonObservations(pair.right.id);
  const keys = [
    ...new Set([
      ...leftObservations.byKey.keys(),
      ...rightObservations.byKey.keys(),
    ]),
  ].sort();
  let shared = 0;
  let conflicts = 0;
  let leftOnly = 0;
  let rightOnly = 0;
  const differences: ReportDuplicateComparison["observations"]["differences"] =
    [];
  for (const key of keys) {
    const left = leftObservations.byKey.get(key);
    const right = rightObservations.byKey.get(key);
    if (!left) {
      rightOnly += 1;
      differences.push({
        key,
        itemName: right!.itemName,
        status: "right_only",
        leftResult: null,
        rightResult: [...right!.results].join("、"),
      });
      continue;
    }
    if (!right) {
      leftOnly += 1;
      differences.push({
        key,
        itemName: left.itemName,
        status: "left_only",
        leftResult: [...left.results].join("、"),
        rightResult: null,
      });
      continue;
    }
    const leftResult = [...left.results].sort().join("、");
    const rightResult = [...right.results].sort().join("、");
    if (leftResult === rightResult) {
      shared += 1;
    } else {
      conflicts += 1;
      differences.push({
        key,
        itemName: left.itemName || right.itemName,
        status: "conflict",
        leftResult,
        rightResult,
      });
    }
  }

  const summarySide = (report: DuplicateComparisonReportRow) => ({
    id: report.id,
    title: report.title,
    reportType: report.reportType,
    status: report.status,
    hospitalName: report.hospitalName,
    hospitalBranch: report.hospitalBranch,
    departmentName: report.departmentName,
    bodyPart: report.bodyPart,
    reportIssuedAt: report.reportIssuedAt,
    pageCount: report.pageCount,
  });
  return {
    left: summarySide(pair.left),
    right: summarySide(pair.right),
    fields,
    observations: {
      leftCount: leftObservations.rowCount,
      rightCount: rightObservations.rowCount,
      shared,
      conflicts,
      leftOnly,
      rightOnly,
      truncated:
        leftObservations.truncated ||
        rightObservations.truncated ||
        differences.length > 100,
      differences: differences.slice(0, 100),
    },
  };
}

export function mergeDuplicateReport(
  user: RequestUser,
  sourceReportId: string,
  targetReportId: string,
) {
  if (sourceReportId === targetReportId)
    throw createError({
      statusCode: 400,
      statusMessage: "不能合并到同一份报告",
    });
  const rows = getDatabase()
    .prepare(
      `
    SELECT id, member_id AS memberId, status, title FROM reports
    WHERE id IN (?, ?) AND status <> 'trashed'
  `,
    )
    .all(sourceReportId, targetReportId) as Array<{
    id: string;
    memberId: string;
    status: string;
    title: string;
  }>;
  const source = rows.find((row) => row.id === sourceReportId);
  const target = rows.find((row) => row.id === targetReportId);
  if (!source || !target)
    throw createError({ statusCode: 404, statusMessage: "报告不存在" });
  if (source.memberId !== target.memberId)
    throw createError({
      statusCode: 409,
      statusMessage: "只能合并同一成员的报告",
    });
  assertMemberManage(user, source.memberId);
  const active = getDatabase()
    .prepare(
      `
    SELECT report_id AS reportId FROM processing_jobs
    WHERE report_id IN (?, ?) AND status IN ('queued', 'processing')
    LIMIT 1
  `,
    )
    .get(sourceReportId, targetReportId) as { reportId: string } | undefined;
  if (
    active ||
    isReportJobActive(sourceReportId) ||
    isReportJobActive(targetReportId)
  ) {
    throw createError({
      statusCode: 409,
      statusMessage: "报告仍有识别任务在处理，请完成或取消后再合并",
    });
  }

  const sourcePages = reportPageRows(sourceReportId);
  if (!sourcePages.length)
    throw createError({
      statusCode: 409,
      statusMessage: "源报告没有可合并的原件页",
    });
  const targetMaxPage = getDatabase()
    .prepare(
      "SELECT COALESCE(MAX(page_number), 0) AS maxPage FROM report_pages WHERE report_id = ?",
    )
    .get(targetReportId) as { maxPage: number };
  const db = getDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    sourcePages.forEach((page, index) => {
      db.prepare(
        "UPDATE report_pages SET report_id = ?, page_number = ? WHERE id = ?",
      ).run(
        targetReportId,
        Number(targetMaxPage.maxPage || 0) + index + 1,
        page.id,
      );
      db.prepare(
        "UPDATE processing_jobs SET report_id = ? WHERE page_id = ?",
      ).run(targetReportId, page.id);
      db.prepare(
        "UPDATE processing_job_events SET report_id = ? WHERE job_id IN (SELECT id FROM processing_jobs WHERE page_id = ?)",
      ).run(targetReportId, page.id);
    });
    db.prepare(
      `
      UPDATE reports
      SET status = 'trashed', deleted_at = CURRENT_TIMESTAMP, purge_after = datetime('now', '+30 days'), updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `,
    ).run(sourceReportId);
    db.prepare(
      `
      UPDATE processing_jobs
      SET status = 'cancelled', finished_at = COALESCE(finished_at, CURRENT_TIMESTAMP)
      WHERE report_id = ? AND page_id IS NULL AND status IN ('queued', 'processing')
    `,
    ).run(sourceReportId);
    db.prepare(
      "UPDATE reports SET status = 'needs_review', source_version = source_version + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    ).run(targetReportId);
    const pairKey = recordReportDuplicateMerge(db, {
      memberId: source.memberId,
      sourceReportId,
      targetReportId,
      movedPages: sourcePages.length,
      decidedBy: user.id,
    });
    db.prepare(
      `
      INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, detail_json)
      VALUES (?, ?, 'report.merge_duplicate', 'report', ?, ?)
    `,
    ).run(
      createId("audit"),
      user.id,
      targetReportId,
      JSON.stringify({
        memberId: source.memberId,
        sourceReportId,
        targetReportId,
        movedPages: sourcePages.length,
        pairKey,
      }),
    );
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return {
    sourceReportId,
    targetReportId,
    movedPages: sourcePages.length,
    sourceStatus: "trashed",
    targetStatus: "needs_review",
  };
}

export function updateReportFields(
  user: RequestUser,
  reportId: string,
  input: Record<string, unknown>,
) {
  const db = getDatabase();
  const report = db
    .prepare(
      `
    SELECT member_id AS memberId, status, ${reportFieldDefinitions.map((field) => field.column).join(", ")}
    FROM reports
    WHERE id = ? AND status <> 'trashed'
  `,
    )
    .get(reportId) as
    | ({ memberId: string; status: string } & Record<string, string | null>)
    | undefined;
  if (!report)
    throw createError({ statusCode: 404, statusMessage: "报告不存在" });
  assertMemberManage(user, report.memberId);
  const reportType = textInput(input.reportType, 40);
  if (reportType && !allowedReportTypes.has(reportType))
    throw createError({ statusCode: 400, statusMessage: "报告类型无效" });
  const bodyPart = textInput(input.bodyPart, 120);
  const bodyPartsValue = bodyPart
    ? JSON.stringify([
        {
          raw: bodyPart,
          name: bodyPart,
          parent: null,
          laterality: "unspecified",
        },
      ])
    : "[]";
  const updates = [
    {
      fieldKey: "title",
      column: "title",
      value: textInput(input.title, 180),
      overrideValue: textInput(input.title, 180),
    },
    {
      fieldKey: "reportType",
      column: "report_type",
      value: reportType,
      overrideValue: reportType,
    },
    {
      fieldKey: "hospitalName",
      column: "hospital_name_raw",
      value: textInput(input.hospitalName, 180),
      overrideValue: textInput(input.hospitalName, 180),
    },
    {
      fieldKey: "hospitalBranch",
      column: "hospital_branch",
      value: textInput(input.hospitalBranch, 120),
      overrideValue: textInput(input.hospitalBranch, 120),
    },
    {
      fieldKey: "city",
      column: "city",
      value: textInput(input.city, 80),
      overrideValue: textInput(input.city, 80),
    },
    {
      fieldKey: "visitType",
      column: "visit_type",
      value: textInput(input.visitType, 80),
      overrideValue: textInput(input.visitType, 80),
    },
    {
      fieldKey: "departmentName",
      column: "visit_department",
      value: textInput(input.departmentName, 120),
      overrideValue: textInput(input.departmentName, 120),
    },
    {
      fieldKey: "orderingDepartment",
      column: "ordering_department",
      value: textInput(input.orderingDepartment, 120),
      overrideValue: textInput(input.orderingDepartment, 120),
    },
    {
      fieldKey: "performingDepartment",
      column: "performing_department",
      value: textInput(input.performingDepartment, 120),
      overrideValue: textInput(input.performingDepartment, 120),
    },
    {
      fieldKey: "reportingDepartment",
      column: "reporting_department",
      value: textInput(input.reportingDepartment, 120),
      overrideValue: textInput(input.reportingDepartment, 120),
    },
    {
      fieldKey: "reportIssuedAt",
      column: "report_issued_at",
      value: dateInput(input.reportIssuedAt),
      overrideValue: dateInput(input.reportIssuedAt),
    },
    {
      fieldKey: "examinedAt",
      column: "examined_at",
      value: dateInput(input.examinedAt),
      overrideValue: dateInput(input.examinedAt),
    },
    {
      fieldKey: "clinicalDiagnosis",
      column: "clinical_diagnosis",
      value: textInput(input.clinicalDiagnosis, 500),
      overrideValue: textInput(input.clinicalDiagnosis, 500),
    },
    {
      fieldKey: "purpose",
      column: "purpose",
      value: textInput(input.purpose, 500),
      overrideValue: textInput(input.purpose, 500),
    },
    {
      fieldKey: "findings",
      column: "findings",
      value: textInput(input.findings, 2000),
      overrideValue: textInput(input.findings, 2000),
    },
    {
      fieldKey: "impression",
      column: "impression",
      value: textInput(input.impression, 2000),
      overrideValue: textInput(input.impression, 2000),
    },
    {
      fieldKey: "summary",
      column: "summary",
      value: textInput(input.summary, 1000),
      overrideValue: textInput(input.summary, 1000),
    },
    {
      fieldKey: "recommendation",
      column: "recommendation",
      value: textInput(input.recommendation, 1000),
      overrideValue: textInput(input.recommendation, 1000),
    },
    {
      fieldKey: "bodyParts",
      column: "body_parts_json",
      value: bodyPartsValue,
      overrideValue: bodyPart
        ? [
            {
              raw: bodyPart,
              name: bodyPart,
              parent: null,
              laterality: "unspecified",
            },
          ]
        : [],
    },
  ] satisfies Array<{
    fieldKey: ReportFieldKey;
    column: string;
    value: string | null;
    overrideValue: unknown;
  }>;
  const changedManualFields = updates
    .filter((field) => (report[field.column] ?? null) !== (field.value ?? null))
    .map((field) => ({ fieldKey: field.fieldKey, value: field.overrideValue }));
  const setClauses = updates.map((field) => `${field.column} = ?`);
  const values = updates.map((field) => field.value);
  setClauses.push(
    "source_version = source_version + 1",
    "updated_at = CURRENT_TIMESTAMP",
  );
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`UPDATE reports SET ${setClauses.join(", ")} WHERE id = ?`).run(
      ...values,
      reportId,
    );
    upsertManualReportFieldOverrides({
      reportId,
      userId: user.id,
      fields: changedManualFields,
    });
    db.prepare(
      `
      INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, detail_json)
      VALUES (?, ?, 'report.manual_update', 'report', ?, ?)
    `,
    ).run(
      createId("audit"),
      user.id,
      reportId,
      JSON.stringify({
        memberId: report.memberId,
        fields: updates.map((field) => field.column),
        manualFieldKeys: changedManualFields.map((field) => field.fieldKey),
      }),
    );
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return getReportDetail(user, reportId);
}

const reportEvidenceTables = [
  "observations",
  "morphology_findings",
  "report_diagnoses",
  "report_medications",
  "report_procedures",
  "vaccination_records",
  "billing_summaries",
  "billing_items",
  "report_structured_sections",
] as const;

const removableEvidenceTables = new Set<string>(reportEvidenceTables);
const manualEvidenceTables = new Set<string>([
  "morphology_findings",
  "report_diagnoses",
  "report_medications",
  "report_procedures",
  "vaccination_records",
  "billing_summaries",
  "billing_items",
  "report_structured_sections",
]);

const removedEvidence = Symbol("removed-evidence");

type RemappedEvidence = {
  value: unknown;
  originalReferenceCount: number;
  remainingReferenceCount: number;
};

function remapEvidenceValue(
  value: unknown,
  pageNumbers: Map<number, number | null>,
): RemappedEvidence {
  if (Array.isArray(value)) {
    let originalReferenceCount = 0;
    let remainingReferenceCount = 0;
    const entries: unknown[] = [];
    for (const entry of value) {
      const remapped = remapEvidenceValue(entry, pageNumbers);
      originalReferenceCount += remapped.originalReferenceCount;
      remainingReferenceCount += remapped.remainingReferenceCount;
      if (remapped.value !== removedEvidence) entries.push(remapped.value);
    }
    return { value: entries, originalReferenceCount, remainingReferenceCount };
  }
  if (!value || typeof value !== "object") {
    return { value, originalReferenceCount: 0, remainingReferenceCount: 0 };
  }
  const record = value as Record<string, unknown>;
  const pageNumber = Number(record.pageNumber);
  const isEvidenceReference =
    Number.isInteger(pageNumber) && pageNumber > 0 && "quote" in record;
  if (isEvidenceReference && pageNumbers.has(pageNumber)) {
    const nextPageNumber = pageNumbers.get(pageNumber);
    if (nextPageNumber === null) {
      return {
        value: removedEvidence,
        originalReferenceCount: 1,
        remainingReferenceCount: 0,
      };
    }
    return {
      value: { ...record, pageNumber: nextPageNumber },
      originalReferenceCount: 1,
      remainingReferenceCount: 1,
    };
  }
  let originalReferenceCount = isEvidenceReference ? 1 : 0;
  let remainingReferenceCount = isEvidenceReference ? 1 : 0;
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) {
    const remapped = remapEvidenceValue(entry, pageNumbers);
    originalReferenceCount += remapped.originalReferenceCount;
    remainingReferenceCount += remapped.remainingReferenceCount;
    if (remapped.value !== removedEvidence) output[key] = remapped.value;
  }
  return { value: output, originalReferenceCount, remainingReferenceCount };
}

function remapReportEvidencePageNumbers(
  db: DatabaseSync,
  reportId: string,
  pageNumbers: Map<number, number | null>,
) {
  for (const table of reportEvidenceTables) {
    const rows = db
      .prepare(
        `SELECT id, evidence_json AS evidenceJson FROM ${table} WHERE report_id = ?`,
      )
      .all(reportId) as Array<{ id: string; evidenceJson: string }>;
    const update = db.prepare(
      `UPDATE ${table} SET evidence_json = ? WHERE id = ?`,
    );
    const remove = removableEvidenceTables.has(table)
      ? db.prepare(`DELETE FROM ${table} WHERE id = ?`)
      : null;
    for (const row of rows) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.evidenceJson);
      } catch {
        continue;
      }
      const remapped = remapEvidenceValue(parsed, pageNumbers);
      if (
        remove &&
        remapped.originalReferenceCount > 0 &&
        remapped.remainingReferenceCount === 0
      ) {
        if (manualEvidenceTables.has(table)) {
          const result = db
            .prepare(
              `DELETE FROM ${table} WHERE id = ? AND source <> 'manual' AND json_array_length(manual_fields_json) = 0`,
            )
            .run(row.id);
          if (Number(result.changes) > 0) continue;
        } else {
          remove.run(row.id);
          continue;
        }
      }
      update.run(JSON.stringify(remapped.value), row.id);
    }
  }

  const extractionRows = db
    .prepare(
      `
    SELECT id, fields_json AS fieldsJson, evidence_json AS evidenceJson,
      raw_response_json AS rawResponseJson
    FROM report_extractions WHERE report_id = ?
  `,
    )
    .all(reportId) as Array<{
    id: string;
    fieldsJson: string;
    evidenceJson: string;
    rawResponseJson: string;
  }>;
  const updateExtraction = db.prepare(`
    UPDATE report_extractions
    SET fields_json = ?, evidence_json = ?, raw_response_json = ?
    WHERE id = ?
  `);
  for (const row of extractionRows) {
    const remapJson = (json: string) => {
      try {
        return JSON.stringify(
          remapEvidenceValue(JSON.parse(json), pageNumbers).value,
        );
      } catch {
        return json;
      }
    };
    updateExtraction.run(
      remapJson(row.fieldsJson),
      remapJson(row.evidenceJson),
      remapJson(row.rawResponseJson),
      row.id,
    );
  }
}

function cancelActivePageChangeJobs(
  db: DatabaseSync,
  reportId: string,
  batchId: string,
  source: "manual_page_edit" | "manual_page_delete",
) {
  const jobs = db
    .prepare(
      `
    SELECT id, job_type AS jobType, attempts
    FROM processing_jobs
    WHERE report_id = ? AND status IN ('queued', 'processing')
  `,
    )
    .all(reportId) as Array<{ id: string; jobType: string; attempts: number }>;
  for (const job of jobs) {
    db.prepare(
      `
      UPDATE processing_jobs
      SET status = 'cancelled', locked_at = NULL, lease_expires_at = NULL,
        next_retry_at = NULL, finished_at = COALESCE(finished_at, CURRENT_TIMESTAMP)
      WHERE id = ? AND status IN ('queued', 'processing')
    `,
    ).run(job.id);
    db.prepare(
      `
      INSERT INTO processing_job_events (
        id, job_id, report_id, event_type, status, attempt, message, detail_json
      ) VALUES (?, ?, ?, 'cancelled', 'cancelled', ?, ?, ?)
    `,
    ).run(
      createId("event"),
      job.id,
      reportId,
      job.attempts,
      source === "manual_page_delete"
        ? "删除页面时取消旧处理任务"
        : "调整页面时取消旧处理任务",
      JSON.stringify({ jobType: job.jobType, source, batchId }),
    );
  }
}

function queuePageRefreshJobs(
  db: DatabaseSync,
  reportId: string,
  pageId: string,
  batchId: string,
  previousReportStatus: string,
  source: "manual_page_edit" | "manual_page_delete",
) {
  for (const jobType of ["thumbnail", "ocr"]) {
    const jobId = createId("job");
    db.prepare(
      `
      INSERT INTO processing_jobs (id, report_id, page_id, job_type, pipeline_version, deduplication_key)
      VALUES (?, ?, ?, ?, 'manual-page-v1', ?)
    `,
    ).run(
      jobId,
      reportId,
      pageId,
      jobType,
      `${reportId}:${pageId}:${jobType}:manual:${batchId}:${jobId}`,
    );
    db.prepare(
      `
      INSERT INTO processing_job_events (id, job_id, report_id, event_type, status, attempt, detail_json)
      VALUES (?, ?, ?, 'queued', 'queued', 0, ?)
    `,
    ).run(
      createId("event"),
      jobId,
      reportId,
      JSON.stringify({
        jobType,
        pageId,
        source,
        batchId,
        previousReportStatus,
      }),
    );
  }
}

export function updateReportPages(
  user: RequestUser,
  reportId: string,
  input: Record<string, unknown>,
) {
  const report = getDatabase()
    .prepare(
      "SELECT member_id AS memberId, status FROM reports WHERE id = ? AND status <> 'trashed'",
    )
    .get(reportId) as { memberId: string; status: string } | undefined;
  if (!report)
    throw createError({ statusCode: 404, statusMessage: "报告不存在" });
  assertMemberManage(user, report.memberId);
  const pages = Array.isArray(input.pages)
    ? (input.pages as Array<Record<string, unknown>>)
    : [];
  if (!pages.length)
    throw createError({ statusCode: 400, statusMessage: "页面列表不能为空" });
  const existing = new Map(
    reportPageRows(reportId).map((page) => [page.id, page]),
  );
  const seen = new Set<string>();
  const normalized = pages.map((page, index) => {
    const id = textInput(page.id, 80);
    if (!id || !existing.has(id) || seen.has(id))
      throw createError({ statusCode: 400, statusMessage: "页面列表无效" });
    seen.add(id);
    const rotation = Number(page.rotation || 0);
    if (![0, 90, 180, 270].includes(rotation))
      throw createError({ statusCode: 400, statusMessage: "页面旋转角度无效" });
    return { id, pageNumber: index + 1, rotation };
  });
  if (seen.size !== existing.size) {
    throw createError({
      statusCode: 400,
      statusMessage: "页面列表必须包含报告的全部页面",
    });
  }
  const db = getDatabase();
  const batchId = createId("batch");
  const pageNumberMapping = new Map<number, number | null>();
  for (const page of normalized) {
    pageNumberMapping.set(existing.get(page.id)!.pageNumber, page.pageNumber);
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    cancelActivePageChangeJobs(db, reportId, batchId, "manual_page_edit");
    db.prepare(
      "UPDATE report_pages SET page_number = -page_number WHERE report_id = ?",
    ).run(reportId);
    for (const page of normalized) {
      db.prepare(
        "UPDATE report_pages SET page_number = ?, rotation = ? WHERE id = ? AND report_id = ?",
      ).run(page.pageNumber, page.rotation, page.id, reportId);
      queuePageRefreshJobs(
        db,
        reportId,
        page.id,
        batchId,
        report.status,
        "manual_page_edit",
      );
    }
    remapReportEvidencePageNumbers(db, reportId, pageNumberMapping);
    db.prepare(
      "UPDATE reports SET status = 'processing', source_version = source_version + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    ).run(reportId);
    db.prepare(
      `
      INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, detail_json)
      VALUES (?, ?, 'report.pages.update', 'report', ?, ?)
    `,
    ).run(
      createId("audit"),
      user.id,
      reportId,
      JSON.stringify({
        memberId: report.memberId,
        pageCount: normalized.length,
      }),
    );
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return getReportDetail(user, reportId);
}

export function deleteReportPage(
  user: RequestUser,
  reportId: string,
  pageId: string,
) {
  const report = getDatabase()
    .prepare(
      "SELECT member_id AS memberId, status FROM reports WHERE id = ? AND status <> 'trashed'",
    )
    .get(reportId) as { memberId: string; status: string } | undefined;
  if (!report)
    throw createError({ statusCode: 404, statusMessage: "报告不存在" });
  assertMemberManage(user, report.memberId);
  const pages = reportPageRows(reportId);
  if (pages.length <= 1)
    throw createError({
      statusCode: 409,
      statusMessage: "至少需要保留一页原件",
    });
  const page = pages.find((item) => item.id === pageId);
  if (!page)
    throw createError({ statusCode: 404, statusMessage: "页面不存在" });
  const db = getDatabase();
  const batchId = createId("batch");
  const remaining = pages.filter((item) => item.id !== pageId);
  const pageNumberMapping = new Map<number, number | null>([
    [page.pageNumber, null],
    ...remaining.map((item, index) => [item.pageNumber, index + 1] as const),
  ]);
  db.exec("BEGIN IMMEDIATE");
  try {
    cancelActivePageChangeJobs(db, reportId, batchId, "manual_page_delete");
    db.prepare("DELETE FROM report_pages WHERE id = ? AND report_id = ?").run(
      pageId,
      reportId,
    );
    db.prepare(
      "UPDATE report_pages SET page_number = -page_number WHERE report_id = ?",
    ).run(reportId);
    remaining.forEach((item, index) => {
      db.prepare("UPDATE report_pages SET page_number = ? WHERE id = ?").run(
        index + 1,
        item.id,
      );
      queuePageRefreshJobs(
        db,
        reportId,
        item.id,
        batchId,
        report.status,
        "manual_page_delete",
      );
    });
    remapReportEvidencePageNumbers(db, reportId, pageNumberMapping);
    enqueueFileGarbage(
      [
        { storagePath: page.storagePath, fileKind: "original" },
        { storagePath: page.thumbnailPath, fileKind: "thumbnail" },
      ],
      "report_page_delete",
      db,
    );
    db.prepare(
      "UPDATE reports SET status = 'processing', source_version = source_version + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    ).run(reportId);
    db.prepare(
      `
      INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, detail_json)
      VALUES (?, ?, 'report.page.delete', 'report_page', ?, ?)
    `,
    ).run(
      createId("audit"),
      user.id,
      pageId,
      JSON.stringify({ reportId, memberId: report.memberId }),
    );
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return getReportDetail(user, reportId);
}

function parseNumericResultText(value: string | null | undefined) {
  if (!value) return null;
  const normalized = value.replace(/,/g, "").replace(/[<>≤≥]/g, " ");
  const match = normalized.match(/[-+]?\d+(?:\.\d+)?/);
  if (!match) return null;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

function compactTrendKey(value: string) {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[（(].*?[）)]/g, "")
    .replace(/\s+/g, "")
    .replace(/[：:，,。.;；、_\-]/g, "");
}

const trendNameAliases = new Map<string, string>(
  [
    ["wbc", "白细胞计数"],
    ["白细胞", "白细胞计数"],
    ["白细胞数", "白细胞计数"],
    ["白细胞计数", "白细胞计数"],
    ["rbc", "红细胞计数"],
    ["红细胞", "红细胞计数"],
    ["红细胞数", "红细胞计数"],
    ["红细胞计数", "红细胞计数"],
    ["hgb", "血红蛋白"],
    ["hb", "血红蛋白"],
    ["血红蛋白", "血红蛋白"],
    ["血色素", "血红蛋白"],
    ["plt", "血小板计数"],
    ["血小板", "血小板计数"],
    ["血小板数", "血小板计数"],
    ["血小板计数", "血小板计数"],
    ["glu", "空腹血糖"],
    ["glucose", "空腹血糖"],
    ["空腹血糖", "空腹血糖"],
    ["血糖", "空腹血糖"],
    ["tc", "总胆固醇"],
    ["总胆固醇", "总胆固醇"],
    ["胆固醇", "总胆固醇"],
    ["tg", "甘油三酯"],
    ["甘油三酯", "甘油三酯"],
    ["三酰甘油", "甘油三酯"],
    ["hdl", "高密度脂蛋白胆固醇"],
    ["hdl-c", "高密度脂蛋白胆固醇"],
    ["高密度脂蛋白", "高密度脂蛋白胆固醇"],
    ["高密度脂蛋白胆固醇", "高密度脂蛋白胆固醇"],
    ["ldl", "低密度脂蛋白胆固醇"],
    ["ldl-c", "低密度脂蛋白胆固醇"],
    ["低密度脂蛋白", "低密度脂蛋白胆固醇"],
    ["低密度脂蛋白胆固醇", "低密度脂蛋白胆固醇"],
    ["ua", "尿酸"],
    ["尿酸", "尿酸"],
    ["肌酐", "肌酐"],
    ["crea", "肌酐"],
    ["creatinine", "肌酐"],
    ["尿素氮", "尿素氮"],
    ["bun", "尿素氮"],
    ["alt", "丙氨酸氨基转移酶"],
    ["谷丙转氨酶", "丙氨酸氨基转移酶"],
    ["丙氨酸氨基转移酶", "丙氨酸氨基转移酶"],
    ["ast", "天门冬氨酸氨基转移酶"],
    ["谷草转氨酶", "天门冬氨酸氨基转移酶"],
    ["天门冬氨酸氨基转移酶", "天门冬氨酸氨基转移酶"],
    ["ggt", "γ-谷氨酰转肽酶"],
    ["γ谷氨酰转肽酶", "γ-谷氨酰转肽酶"],
    ["γ-谷氨酰转肽酶", "γ-谷氨酰转肽酶"],
    ["总胆红素", "总胆红素"],
    ["tbil", "总胆红素"],
  ].map(([key, value]) => [compactTrendKey(key), value]),
);

function normalizeTrendName(value: string) {
  const key = compactTrendKey(value);
  return trendNameAliases.get(key) || value.replace(/\s+/g, " ").trim();
}

function normalizeTrendUnit(value: string | null) {
  if (!value) return null;
  const unit = value
    .normalize("NFKC")
    .replace(/\s+/g, "")
    .replace(/[／⁄]/g, "/")
    .replace(/[×xX*]/g, "×")
    .replace(/[μµ]/g, "μ");
  const lower = unit.toLocaleLowerCase();
  const aliases: Record<string, string> = {
    "mmol/l": "mmol/L",
    "μmol/l": "μmol/L",
    "umol/l": "μmol/L",
    "mg/dl": "mg/dL",
    "mg/l": "mg/L",
    "g/l": "g/L",
    "u/l": "U/L",
    "iu/l": "U/L",
    "iu/ml": "IU/mL",
    "kiu/l": "IU/mL",
    "10^9/l": "10^9/L",
    "10^12/l": "10^12/L",
    "×10^9/l": "10^9/L",
    "×10^12/l": "10^12/L",
  };
  return aliases[lower] || unit || null;
}

function inferTrendUnitFromResultText(value: string | null | undefined) {
  const normalized = (value || "")
    .normalize("NFKC")
    .trim()
    .replace(/(?:\s+[HL]|[↑↓]|偏高|偏低)\s*$/i, "");
  const match = normalized.match(
    /[-+]?\d+(?:\.\d+)?\s*([a-zA-Zμµ%][a-zA-Z0-9μµ%/^.×*·-]{0,23})$/,
  );
  return match ? normalizeTrendUnit(match[1]) : null;
}

function firstObservationEvidence(value: string) {
  const entries = parseJson<Array<{ pageNumber?: unknown; quote?: unknown }>>(
    value,
    [],
  );
  for (const entry of Array.isArray(entries) ? entries : []) {
    const pageNumber = Math.max(1, Math.round(Number(entry.pageNumber || 0)));
    const quote =
      typeof entry.quote === "string" ? entry.quote.trim().slice(0, 300) : "";
    if (pageNumber) return { pageNumber, quote: quote || null };
  }
  return null;
}

function evidenceLineIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((id): id is string => typeof id === "string" && id.trim().length > 0)
    .map((id) => id.trim());
}

/* 表格溯源证据：找第一个带表格行级 OCR 行号的证据条目。趋势原图叠加层靠它
   把数据点精确定位到表格行和结果单元格；没有表格证据时退回首个证据页。 */
function observationTableEvidence(value: string) {
  const entries = parseJson<Array<Record<string, unknown>>>(value, []);
  for (const entry of Array.isArray(entries) ? entries : []) {
    const pageNumber = Math.max(1, Math.round(Number(entry.pageNumber || 0)));
    const table = entry.table;
    if (!pageNumber || !table || typeof table !== "object") continue;
    const rowLineIds = evidenceLineIds(
      (table as Record<string, unknown>).rowSourceLineIds,
    );
    if (!rowLineIds.length) continue;
    const sourceMap = (table as Record<string, unknown>).sourceMap;
    const sourceMapRecord =
      sourceMap && typeof sourceMap === "object"
        ? (sourceMap as Record<string, unknown>)
        : null;
    const result =
      sourceMapRecord && typeof sourceMapRecord.result === "object"
        ? sourceMapRecord.result
        : null;
    const resultLineIds = evidenceLineIds(
      result && typeof result === "object"
        ? (result as Record<string, unknown>).sourceLineIds
        : null,
    );
    const scopedLineIds = sourceMapRecord
      ? ["item", "result", "unit", "reference", "qualifier"].flatMap(
          (key) => {
            const entry = sourceMapRecord[key];
            return entry && typeof entry === "object"
              ? evidenceLineIds(
                  (entry as Record<string, unknown>).sourceLineIds,
                )
              : [];
          },
        )
      : [];
    return {
      pageNumber,
      rowLineIds: [...new Set(scopedLineIds)],
      resultLineIds,
      fallbackRowLineIds: rowLineIds,
    };
  }
  return null;
}

function normalizeOcrMatchText(value: string | null | undefined) {
  return (value || "")
    .normalize("NFKC")
    .replace(/\s+/g, "")
    .toLowerCase();
}

/* 引用文本 → OCR 行回退匹配：没有表格结构证据时，把证据 quote 按表格单元格
   分隔符拆成片段，与证据页 OCR 行做规范化匹配（优先整行相等，其次互相包含），
   让历史数据点也能在原件上标出位置。仅用于定位标记，匹配失败则不标记，
   不影响数值本身。 */
function matchQuoteToOcrLines(
  quote: string | null,
  itemName: string | null,
  resultText: string | null,
  numericValue: number | null,
  lines: Array<{ id: string; text: string }>,
) {
  if (!quote || !lines.length) return null;
  const allFragments = quote
    .split(/[|｜]/)
    .map((fragment) => fragment.trim())
    .filter((fragment) => normalizeOcrMatchText(fragment).length >= 2);
  if (!allFragments.length) return null;
  const normalizedLines = lines
    .map((line) => ({
      id: line.id,
      normalized: normalizeOcrMatchText(line.text),
    }))
    .filter((line) => line.normalized);
  const resultCore = (
    normalizeOcrMatchText(resultText).replace(/(偏高|偏低|[↑↓])+$/, "") ||
    (numericValue !== null && Number.isFinite(numericValue)
      ? String(numericValue)
      : "")
  ).trim();
  const itemCore = normalizeOcrMatchText(itemName);
  const itemIndex = itemCore
    ? allFragments.findIndex((fragment) => {
        const normalized = normalizeOcrMatchText(fragment);
        return normalized.includes(itemCore) || itemCore.includes(normalized);
      })
    : -1;
  const resultIndex =
    itemIndex >= 0 && resultCore
      ? allFragments.findIndex(
          (fragment, index) =>
            index > itemIndex &&
            normalizeOcrMatchText(fragment).includes(resultCore),
        )
      : -1;
  let fragments = allFragments;
  if (itemIndex >= 0) {
    const focused = [allFragments[itemIndex]];
    if (resultIndex >= 0) {
      focused.push(allFragments[resultIndex]);
      for (
        let index = resultIndex + 1;
        index < allFragments.length && index <= resultIndex + 2;
        index += 1
      ) {
        if (/[㐀-鿿]{2,}/u.test(allFragments[index])) break;
        focused.push(allFragments[index]);
      }
    }
    fragments = focused;
  }
  const rowLineIds = new Set<string>();
  const resultLineIds = new Set<string>();
  for (const fragment of fragments) {
    const normalizedFragment = normalizeOcrMatchText(fragment);
    const exact = normalizedLines.filter(
      (line) => line.normalized === normalizedFragment,
    );
    // OCR 可能把多个单元格合并成一行、或把一个单元格拆成多行；
    // 整行相等失败时退到包含匹配。反向包含要求行至少 3 个字符，
    // 避免单独的单位行（如 "kg"）被多个片段反复命中。
    const candidates = exact.length
      ? exact
      : normalizedLines.filter(
          (line) =>
            line.normalized.includes(normalizedFragment) ||
            (line.normalized.length >= 3 &&
              normalizedFragment.includes(line.normalized)),
        );
    const isResultFragment =
      resultCore.length >= 2 && normalizedFragment.includes(resultCore);
    const isItemFragment =
      itemCore.length >= 2 &&
      (normalizedFragment.includes(itemCore) ||
        itemCore.includes(normalizedFragment));
    if (candidates.length > 1 && !isItemFragment && !isResultFragment)
      continue;
    for (const line of candidates) {
      rowLineIds.add(line.id);
      if (isResultFragment) resultLineIds.add(line.id);
    }
  }
  if (!rowLineIds.size) return null;
  return {
    rowLineIds: [...rowLineIds],
    resultLineIds: [...resultLineIds],
  };
}

/* 按需加载证据页 OCR 行（id 生成规则与 getReportPageOcrDetail 一致），
   供 quote 回退匹配使用；按 报告:页 缓存避免重复查询。 */
function ocrLinesForTrendEvidence(
  cache: Map<string, Array<{ id: string; text: string }>>,
  reportId: string,
  pageNumber: number,
) {
  const key = `${reportId}:${pageNumber}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const row = getDatabase()
    .prepare(
      `
    SELECT o.lines_json AS linesJson
    FROM report_pages p
    JOIN ocr_results o ON o.page_id = p.id
    WHERE p.report_id = ? AND p.page_number = ?
  `,
    )
    .get(reportId, pageNumber) as { linesJson: string | null } | undefined;
  const parsed = parseJson<Array<{ id?: unknown; text?: unknown }>>(
    row?.linesJson,
    [],
  );
  const lines = (Array.isArray(parsed) ? parsed : []).map((line, index) => ({
    id:
      typeof line.id === "string" && line.id.trim()
        ? line.id.trim()
        : `page_${pageNumber}_line_${index + 1}`,
    text: typeof line.text === "string" ? line.text : "",
  }));
  cache.set(key, lines);
  return lines;
}

function sourcePagesForTrendPoints(keys: Set<string>) {
  if (!keys.size)
    return new Map<
      string,
      {
        id: string;
        pageNumber: number;
        originalName: string;
        mimeType: string;
        sourcePageNumber: number | null;
      }
    >();
  const pairs = [...keys].flatMap((key) => {
    const separator = key.lastIndexOf(":");
    const reportId = key.slice(0, separator);
    const pageNumber = Number(key.slice(separator + 1));
    return reportId && Number.isFinite(pageNumber)
      ? [{ reportId, pageNumber }]
      : [];
  });
  if (!pairs.length) return new Map();
  const clauses = pairs
    .map(() => "(report_id = ? AND page_number = ?)")
    .join(" OR ");
  const values = pairs.flatMap((pair) => [pair.reportId, pair.pageNumber]);
  const rows = getDatabase()
    .prepare(
      `
    SELECT id, report_id AS reportId, page_number AS pageNumber, original_name AS originalName,
      mime_type AS mimeType, source_page_number AS sourcePageNumber
    FROM report_pages
    WHERE ${clauses}
  `,
    )
    .all(...values) as Array<{
    id: string;
    reportId: string;
    pageNumber: number;
    originalName: string;
    mimeType: string;
    sourcePageNumber: number | null;
  }>;
  return new Map(
    rows.map((row) => [
      `${row.reportId}:${row.pageNumber}`,
      {
        id: row.id,
        pageNumber: row.pageNumber,
        originalName: row.originalName,
        mimeType: row.mimeType,
        sourcePageNumber: row.sourcePageNumber,
      },
    ]),
  );
}

function comparisonContextsForReports(reportIds: Set<string>) {
  if (!reportIds.size)
    return new Map<
      string,
      { specimen: string | null; method: string | null }
    >();
  const placeholders = [...reportIds].map(() => "?").join(", ");
  const rows = getDatabase()
    .prepare(
      `
    SELECT report_id AS reportId, section_key AS sectionKey, content_text AS content,
      source, updated_at AS updatedAt, id
    FROM report_structured_sections
    WHERE is_deleted = 0
      AND report_id IN (${placeholders})
      AND section_key IN ('laboratory_specimen', 'laboratory_method', 'functional_method')
    ORDER BY CASE source WHEN 'manual' THEN 0 ELSE 1 END, updated_at DESC, id
  `,
    )
    .all(...reportIds) as Array<{
    reportId: string;
    sectionKey:
      "laboratory_specimen" | "laboratory_method" | "functional_method";
    content: string;
  }>;
  const contexts = new Map<
    string,
    { specimen: string | null; method: string | null }
  >();
  for (const row of rows) {
    const context = contexts.get(row.reportId) || {
      specimen: null,
      method: null,
    };
    const content = row.content?.trim() || null;
    if (row.sectionKey === "laboratory_specimen" && !context.specimen)
      context.specimen = content;
    if (
      (row.sectionKey === "laboratory_method" ||
        row.sectionKey === "functional_method") &&
      !context.method
    ) {
      context.method = content;
    }
    contexts.set(row.reportId, context);
  }
  return contexts;
}

type TrendAttentionLevel = "abnormal" | "near_boundary";
type TrendAttentionBoundary = "upper" | "lower";

export function classifyTrendAttention(point: {
  numericValue: number;
  referenceLow: number | null;
  referenceHigh: number | null;
  abnormalFlag: "high" | "low" | "abnormal" | "normal" | null;
  displayAbnormalFlag?: "high" | "low" | "abnormal" | "normal" | null;
  abnormalStatus?: ObservationAbnormalStatus;
  abnormalConflict?: boolean;
  abnormalReason?: string | null;
}) {
  const rawLow = Number.isFinite(point.referenceLow)
    ? point.referenceLow
    : null;
  const rawHigh = Number.isFinite(point.referenceHigh)
    ? point.referenceHigh
    : null;
  const invalidRange = rawLow !== null && rawHigh !== null && rawHigh <= rawLow;
  if (invalidRange) {
    return {
      level: null,
      boundary: null,
      reason: "报告参考范围上下界无效，暂不判定",
      conflict: true,
    };
  }

  const interpretation = point.abnormalStatus
    ? {
        effectiveFlag: point.displayAbnormalFlag ?? null,
        status: point.abnormalStatus,
        conflict: Boolean(point.abnormalConflict),
        reason: point.abnormalReason ?? null,
      }
    : assessObservationInterpretation({
        storedFlag: point.abnormalFlag,
        numericValue: point.numericValue,
        referenceLow: rawLow,
        referenceHigh: rawHigh,
      });
  if (interpretation.conflict) {
    return {
      level: null,
      boundary: null,
      reason: interpretation.reason,
      conflict: true,
    };
  }

  const effectiveFlag = interpretation.effectiveFlag;
  if (["high", "low", "abnormal"].includes(effectiveFlag || "")) {
    const boundary: TrendAttentionBoundary | null =
      effectiveFlag === "high"
        ? "upper"
        : effectiveFlag === "low"
          ? "lower"
          : null;
    return {
      level: "abnormal" as TrendAttentionLevel,
      boundary,
      reason: interpretation.reason,
      conflict: false,
    };
  }

  const low = rawLow;
  const high = rawHigh;
  let boundary: TrendAttentionBoundary | null = null;
  if (
    low !== null &&
    high !== null &&
    high > low &&
    point.numericValue >= low &&
    point.numericValue <= high
  ) {
    const span = high - low;
    const lowerDistance = (point.numericValue - low) / span;
    const upperDistance = (high - point.numericValue) / span;
    if (Math.min(lowerDistance, upperDistance) <= 0.1) {
      boundary = lowerDistance <= upperDistance ? "lower" : "upper";
    }
  } else if (high !== null && high !== 0 && point.numericValue <= high) {
    if ((high - point.numericValue) / Math.abs(high) <= 0.1) boundary = "upper";
  } else if (low !== null && low !== 0 && point.numericValue >= low) {
    if ((point.numericValue - low) / Math.abs(low) <= 0.1) boundary = "lower";
  }
  return boundary
    ? {
        level: "near_boundary" as TrendAttentionLevel,
        boundary,
        reason:
          boundary === "upper"
            ? "本次结果接近报告参考上限"
            : "本次结果接近报告参考下限",
        conflict: false,
      }
    : { level: null, boundary: null, reason: null, conflict: false };
}

function trustedTrendAliases() {
  const rows = getDatabase()
    .prepare(
      `
    SELECT c.canonical_key AS canonicalKey, a.alias_name AS aliasName
    FROM indicator_aliases a
    JOIN indicator_catalog c ON c.id = a.indicator_id
    WHERE a.enabled = 1
      AND a.source IN ('builtin', 'user')
      AND a.confidence >= 0.9
    ORDER BY c.canonical_key, a.alias_name
  `,
    )
    .all() as Array<{ canonicalKey: string; aliasName: string }>;
  const aliases = new Map<string, Set<string>>();
  for (const row of rows) {
    if (!aliases.has(row.canonicalKey))
      aliases.set(row.canonicalKey, new Set());
    aliases.get(row.canonicalKey)!.add(row.aliasName);
  }
  return aliases;
}

function placementVoteKey(value: TrendPlacement) {
  return `${value.groupKey}\u0000${value.subgroupKey || ""}`;
}

type TrendSourcePreference = {
  preferredSections: string[];
  discouragedSections: string[];
  discouragedPenalty: number;
};

// 同名指标可能出现在一份报告的多个章节，趋势代表点的章节优先级由指标字典 trendSourcePreference 驱动。
function parseTrendSourcePreference(value: string | null | undefined): TrendSourcePreference | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as {
      preferredSections?: unknown;
      discouragedSections?: unknown;
      discouragedPenalty?: unknown;
    };
    const preferred = Array.isArray(parsed.preferredSections)
      ? parsed.preferredSections.map((item) => String(item || "").trim()).filter(Boolean)
      : [];
    const discouraged = Array.isArray(parsed.discouragedSections)
      ? parsed.discouragedSections.map((item) => String(item || "").trim()).filter(Boolean)
      : [];
    if (!preferred.length && !discouraged.length) return null;
    const penalty = Number(parsed.discouragedPenalty);
    return {
      preferredSections: preferred,
      discouragedSections: discouraged,
      discouragedPenalty: Number.isFinite(penalty) && penalty > 0 ? Math.min(100, Math.round(penalty)) : 30,
    };
  } catch {
    return null;
  }
}

function activeTrendCatalog() {
  ensureBuiltinIndicatorCatalog();
  const rows = getDatabase()
    .prepare(
      `
    SELECT catalog.canonical_key AS canonicalKey, catalog.category,
      catalog.explanation, catalog.item_order AS itemOrder,
      catalog.trend_source_preference_json AS trendSourcePreferenceJson,
      category.group_key AS groupKey, groups.name AS groupName,
      groups.item_order AS groupOrder, category.subgroup_key AS subgroupKey,
      subgroups.name AS subgroupName, subgroups.item_order AS subgroupOrder
    FROM indicator_catalog catalog
    JOIN indicator_taxonomy_categories category ON category.category_key = catalog.category_key
    JOIN indicator_taxonomy_groups groups ON groups.group_key = category.group_key
    LEFT JOIN indicator_taxonomy_subgroups subgroups ON subgroups.subgroup_key = category.subgroup_key
    WHERE catalog.source = 'builtin' AND catalog.trend_enabled = 1
  `,
    )
    .all() as Array<{
    canonicalKey: string;
    category: string;
    explanation: string | null;
    itemOrder: number | null;
    trendSourcePreferenceJson: string;
    groupKey: string;
    groupName: string;
    groupOrder: number;
    subgroupKey: string | null;
    subgroupName: string | null;
    subgroupOrder: number | null;
  }>;
  return new Map(
    rows.map((row) => [
      row.canonicalKey,
      {
        category: row.category,
        explanation: row.explanation,
        itemOrder: row.itemOrder ?? 9999,
        sourcePreference: parseTrendSourcePreference(row.trendSourcePreferenceJson),
        placement: {
          groupKey: row.groupKey,
          groupName: row.groupName,
          groupOrder: row.groupOrder,
          subgroupKey: row.subgroupKey,
          subgroupName: row.subgroupName,
          subgroupOrder: row.subgroupOrder ?? 9999,
        } satisfies TrendPlacement,
      },
    ]),
  );
}

export function listTrendSeries(user: RequestUser, memberId?: string) {
  if (!user.authenticated) return [];
  if (memberId) assertMemberAccess(user, memberId);
  const trendCatalog = activeTrendCatalog();
  const pinnedKeys = memberId
    ? new Set(
        (
          getDatabase()
            .prepare(
              `
        SELECT indicator_key AS indicatorKey, unit_key AS unitKey
        FROM user_trend_pins
        WHERE user_id = ? AND member_id = ?
      `,
            )
            .all(user.id, memberId) as Array<{
            indicatorKey: string;
            unitKey: string;
          }>
        ).map((row) => `${row.indicatorKey}\u0000${row.unitKey}`),
      )
    : new Set<string>();
  const rows = getDatabase()
    .prepare(
      `
    SELECT
      o.id AS observationId,
      COALESCE(NULLIF(TRIM(o.normalized_name), ''), o.item_name) AS name,
      o.item_name AS itemName,
      o.section_name AS sectionName,
      o.unit,
      o.result_text AS resultText,
      o.numeric_value AS numericValue,
      o.reference_low AS referenceLow,
      o.reference_high AS referenceHigh,
      o.reference_text AS referenceText,
      o.abnormal_flag AS abnormalFlag,
      o.method,
      o.evidence_json AS evidenceJson,
      n.canonical_key AS canonicalKey,
      n.canonical_name AS canonicalName,
      n.canonical_value AS canonicalValue,
      n.canonical_unit AS canonicalUnit,
      n.canonical_category AS normalizationCategory,
      n.canonical_explanation AS normalizationExplanation,
      n.quality AS normalizationQuality,
      n.confidence AS normalizationConfidence,
      n.match_reason AS normalizationReason,
      n.excluded_reason AS normalizationExcludedReason,
      c.category AS catalogCategory,
      c.default_unit AS catalogDefaultUnit,
      c.explanation AS catalogExplanation,
      c.reference_range_json AS dictionaryReferenceJson,
      r.id AS reportId,
      r.title AS reportTitle,
      r.report_type AS reportType,
      r.status AS reportStatus,
      ${reportDisplayDateSql} AS reportIssuedAt,
      COALESCE(${reportDisplayDateSql}, r.created_at) AS sortDate,
      r.hospital_name_raw AS hospitalName,
      hm.birth_date AS memberBirthDate
    FROM observations o
    LEFT JOIN observation_normalizations n ON n.observation_id = o.id
    LEFT JOIN indicator_catalog c ON c.id = n.indicator_id
    JOIN reports r ON r.id = o.report_id
    JOIN health_members hm ON hm.id = r.member_id
    JOIN member_permissions mp ON mp.member_id = r.member_id AND mp.user_id = ?
    WHERE COALESCE(NULLIF(TRIM(o.normalized_name), ''), NULLIF(TRIM(o.item_name), '')) IS NOT NULL
      AND r.status <> 'trashed'
      AND (? IS NULL OR r.member_id = ?)
      AND n.canonical_key IS NOT NULL
      AND n.canonical_name IS NOT NULL
      AND n.quality IN ('high', 'medium', 'low', 'excluded')
    ORDER BY COALESCE(${reportDisplayDateSql}, r.created_at), r.id, o.id
  `,
    )
    .all(user.id, memberId || null, memberId || null) as Array<{
    observationId: string;
    name: string;
    itemName: string;
    sectionName: string | null;
    unit: string | null;
    resultText: string;
    numericValue: number | null;
    referenceLow: number | null;
    referenceHigh: number | null;
    referenceText: string | null;
    abnormalFlag: "high" | "low" | "abnormal" | "normal" | null;
    method: string | null;
    evidenceJson: string;
    canonicalKey: string | null;
    canonicalName: string | null;
    canonicalValue: number | null;
    canonicalUnit: string | null;
    normalizationCategory: string | null;
    normalizationExplanation: string | null;
    normalizationQuality: "high" | "medium" | "low" | "excluded" | null;
    normalizationConfidence: number | null;
    normalizationReason: string | null;
    normalizationExcludedReason: string | null;
    catalogCategory: string | null;
    catalogDefaultUnit: string | null;
    catalogExplanation: string | null;
    dictionaryReferenceJson: string | null;
    reportId: string;
    reportTitle: string;
    reportType: string;
    reportStatus: string;
    reportIssuedAt: string | null;
    sortDate: string | null;
    hospitalName: string | null;
    memberBirthDate: string | null;
  }>;

  const comparisonContexts = comparisonContextsForReports(
    new Set(rows.map((row) => row.reportId)),
  );
  const enrichedRows = rows.map((row) => {
    const numericValue =
      row.numericValue ?? parseNumericResultText(row.resultText);
    const usesCanonical = Boolean(
      row.canonicalKey &&
      row.normalizationQuality &&
      ["high", "medium"].includes(row.normalizationQuality),
    );
    const evidence = firstObservationEvidence(row.evidenceJson);
    const rawTrendUnit =
      normalizeTrendUnit(row.unit) ||
      inferTrendUnitFromResultText(row.resultText);
    const reference = assessObservationReference({
      low: row.referenceLow,
      high: row.referenceHigh,
      text: row.referenceText,
    });
    const trendNumericValue =
      numericValue === null
        ? null
        : usesCanonical
          ? (row.canonicalValue ?? numericValue)
          : numericValue;
    const convertedReferenceLow =
      numericValue === null || reference.low === null
        ? null
        : usesCanonical
          ? convertUnit(
              row.canonicalKey!,
              reference.low,
              normalizeTrendUnit(row.unit),
              row.canonicalUnit,
            )
          : reference.low;
    const convertedReferenceHigh =
      numericValue === null || reference.high === null
        ? null
        : usesCanonical
          ? convertUnit(
              row.canonicalKey!,
              reference.high,
              normalizeTrendUnit(row.unit),
              row.canonicalUnit,
            )
          : reference.high;
    const referenceConversionFailed =
      usesCanonical &&
      ((reference.low !== null && convertedReferenceLow === null) ||
        (reference.high !== null && convertedReferenceHigh === null));
    const trendReferenceLow = referenceConversionFailed
      ? null
      : convertedReferenceLow;
    const trendReferenceHigh = referenceConversionFailed
      ? null
      : convertedReferenceHigh;
    const trendReferenceStatus: ObservationReferenceStatus =
      referenceConversionFailed ? "raw_only" : reference.status;
    const trendReferenceReason = referenceConversionFailed
      ? "参考范围单位无法可靠换算，已停止用于跨报告自动比较"
      : reference.reason;
    const interpretation = assessObservationInterpretation({
      storedFlag: row.abnormalFlag,
      resultText: row.resultText,
      supportingText: [evidence?.quote || null],
      numericValue: trendNumericValue,
      referenceLow: trendReferenceLow,
      referenceHigh: trendReferenceHigh,
      // 仅在报告完全没有参考范围时才用字典公认范围兜底；
      // 报告自带范围但单位换算失败时不混用，避免跨单位误判。
      dictionaryReference:
        reference.low === null && reference.high === null
          ? parseDictionaryReferenceRange(row.dictionaryReferenceJson)
          : null,
    });
    return {
      ...row,
      abnormalFlag: interpretation.rawFlag,
      reportedAbnormalFlag: interpretation.rawFlag,
      displayAbnormalFlag: interpretation.effectiveFlag,
      abnormalSource: interpretation.source,
      abnormalStatus: interpretation.status,
      abnormalConflict: interpretation.conflict,
      abnormalReason: interpretation.reason,
      parsedNumericValue: numericValue,
      trendNumericValue,
      trendName: usesCanonical
        ? row.canonicalName!
        : normalizeTrendName(row.name),
      trendUnit: usesCanonical ? row.canonicalUnit : rawTrendUnit,
      trendKey: usesCanonical
        ? row.canonicalKey!
        : normalizeTrendName(row.name),
      trendQuality: usesCanonical ? row.normalizationQuality! : "raw",
      trendConfidence: usesCanonical ? row.normalizationConfidence : null,
      trendReason: usesCanonical
        ? row.normalizationReason
        : "未归一化，按原始名称和单位保守展示",
      trendCategory: usesCanonical
        ? row.normalizationCategory || row.catalogCategory
        : null,
      trendExplanation: usesCanonical
        ? row.normalizationExplanation || row.catalogExplanation
        : null,
      trendReferenceLow,
      trendReferenceHigh,
      referenceStatus: trendReferenceStatus,
      referenceReason: trendReferenceReason,
      comparisonMethod:
        row.method || comparisonContexts.get(row.reportId)?.method || null,
      comparisonSpecimen:
        comparisonContexts.get(row.reportId)?.specimen || null,
      trendReferenceText:
        usesCanonical &&
        rawTrendUnit &&
        row.canonicalUnit &&
        rawTrendUnit !== normalizeTrendUnit(row.canonicalUnit) &&
        (reference.low !== null || reference.high !== null)
          ? null
          : reference.text,
      evidencePageNumber: evidence?.pageNumber || null,
      evidenceQuote: evidence?.quote || null,
      evidenceTable: observationTableEvidence(row.evidenceJson),
    };
  });
  /* P0：默认趋势只发布已经稳定归一化的数值指标。原始名、未知项和 low/excluded
     继续留在治理池或正式序列的 excludedPoints 中，不再生成 raw 趋势。 */
  const pointsWithEvidence = enrichedRows.filter((row) =>
    Boolean(
      row.canonicalKey &&
      row.canonicalName &&
      row.trendNumericValue !== null &&
      row.normalizationQuality &&
      ["high", "medium"].includes(row.normalizationQuality),
    ),
  );
  const excludedRows = enrichedRows.filter((row) =>
    Boolean(
      row.canonicalKey &&
      row.canonicalName &&
      row.normalizationQuality &&
      ["low", "excluded"].includes(row.normalizationQuality),
    ),
  );
  const pageKeys = new Set(
    [...pointsWithEvidence, ...excludedRows]
      .map((row) => {
        const pageNumber = row.evidenceTable?.pageNumber || row.evidencePageNumber;
        return pageNumber ? `${row.reportId}:${pageNumber}` : null;
      })
      .filter((key): key is string => Boolean(key)),
  );
  const sourcePages = sourcePagesForTrendPoints(pageKeys);
  const trustedAliases = trustedTrendAliases();
  /* 行级标记证据：优先用表格结构证据里的行号；没有表格证据的历史数据
     退回 quote 文本与证据页 OCR 行匹配，能标多少标多少，标不出就不标。 */
  const ocrLineCache = new Map<string, Array<{ id: string; text: string }>>();
  const lineEvidenceForRow = (
    row: (typeof enrichedRows)[number],
  ): { rowLineIds: string[]; resultLineIds: string[] } => {
    if (row.evidenceTable?.rowLineIds.length) {
      return {
        rowLineIds: row.evidenceTable.rowLineIds,
        resultLineIds: row.evidenceTable.resultLineIds,
      };
    }
    const evidencePageNumber =
      row.evidenceTable?.pageNumber || row.evidencePageNumber;
    if (!evidencePageNumber || !row.evidenceQuote) {
      return { rowLineIds: [], resultLineIds: [] };
    }
    const matched =
      matchQuoteToOcrLines(
        row.evidenceQuote,
        row.itemName,
        row.resultText,
        row.parsedNumericValue,
        ocrLinesForTrendEvidence(
          ocrLineCache,
          row.reportId,
          evidencePageNumber,
        ),
      ) || null;
    return (
      matched || {
        rowLineIds: row.evidenceTable?.fallbackRowLineIds || [],
        resultLineIds: row.evidenceTable?.resultLineIds || [],
      }
    );
  };
  const excludedByKey = new Map<
    string,
    Array<{
      observationId: string;
      reportId: string;
      reportTitle: string;
      reportIssuedAt: string | null;
      hospitalName: string | null;
      itemName: string;
      resultText: string;
      numericValue: number | null;
      unit: string | null;
      reason: string;
      quality: "low" | "excluded";
      evidenceQuote: string | null;
      sourceLineIds: string[];
      resultLineIds: string[];
      sourcePage: {
        id: string;
        pageNumber: number;
        originalName: string;
        mimeType: string;
        sourcePageNumber: number | null;
      } | null;
    }>
  >();
  for (const row of excludedRows) {
    const key = `${row.canonicalKey}\u0000${row.canonicalUnit || normalizeTrendUnit(row.catalogDefaultUnit) || ""}`;
    const sourcePageNumber =
      row.evidenceTable?.pageNumber || row.evidencePageNumber;
    const sourcePage = sourcePageNumber
      ? sourcePages.get(`${row.reportId}:${sourcePageNumber}`) || null
      : null;
    const lineEvidence = lineEvidenceForRow(row);
    if (!excludedByKey.has(key)) excludedByKey.set(key, []);
    excludedByKey.get(key)!.push({
      observationId: row.observationId,
      reportId: row.reportId,
      reportTitle: row.reportTitle,
      reportIssuedAt: row.reportIssuedAt,
      hospitalName: row.hospitalName,
      itemName: row.itemName,
      resultText: row.resultText,
      numericValue: row.parsedNumericValue,
      unit: row.unit,
      reason:
        row.normalizationExcludedReason ||
        row.normalizationReason ||
        "趋势质量不足，未纳入默认趋势",
      quality: row.normalizationQuality as "low" | "excluded",
      evidenceQuote: row.evidenceQuote,
      sourceLineIds: lineEvidence.rowLineIds,
      resultLineIds: lineEvidence.resultLineIds,
      sourcePage,
    });
  }
  const groups = new Map<
    string,
    {
      indicatorKey: string;
      name: string;
      unit: string | null;
      sectionName: string | null;
      quality: string;
      confidence: number | null;
      explanation: string | null;
      explanationConfidence: number;
      fixedPlacement: TrendPlacement | null;
      sourcePreference: TrendSourcePreference | null;
      placementVotes: Map<
        string,
        { placement: TrendPlacement; count: number; maxConfidence: number }
      >;
      itemOrder: number;
      matchReasons: Set<string>;
      rawNames: Set<string>;
      excludedPoints: Array<{
        observationId: string;
        reportId: string;
        reportTitle: string;
        reportIssuedAt: string | null;
        hospitalName: string | null;
        itemName: string;
        resultText: string;
        numericValue: number | null;
        unit: string | null;
        reason: string;
        quality: "low" | "excluded";
        evidenceQuote: string | null;
        sourceLineIds: string[];
        resultLineIds: string[];
        sourcePage: {
          id: string;
          pageNumber: number;
          originalName: string;
          mimeType: string;
          sourcePageNumber: number | null;
        } | null;
      }>;
      points: Array<{
        observationId: string;
        reportId: string;
        reportTitle: string;
        reportType: string;
        reportStatus: string;
        reportIssuedAt: string | null;
        sortDate: string | null;
        hospitalName: string | null;
        sourceSectionName: string | null;
        itemName: string;
        resultText: string;
        numericValue: number;
        referenceLow: number | null;
        referenceHigh: number | null;
        referenceText: string | null;
        referenceStatus: ObservationReferenceStatus;
        referenceReason: string | null;
        comparisonMethod: string | null;
        comparisonSpecimen: string | null;
        memberBirthDate: string | null;
        abnormalFlag: "high" | "low" | "abnormal" | "normal" | null;
        reportedAbnormalFlag: "high" | "low" | "abnormal" | "normal" | null;
        displayAbnormalFlag: "high" | "low" | "abnormal" | "normal" | null;
        abnormalSource: ObservationAbnormalSource;
        abnormalStatus: ObservationAbnormalStatus;
        abnormalConflict: boolean;
        abnormalReason: string | null;
        evidenceQuote: string | null;
        normalizationQuality: string | null;
        normalizationConfidence: number | null;
        normalizationReason: string | null;
        sourceLineIds: string[];
        resultLineIds: string[];
        sourcePage: {
          id: string;
          pageNumber: number;
          originalName: string;
          mimeType: string;
          sourcePageNumber: number | null;
        } | null;
      }>;
    }
  >();
  for (const row of pointsWithEvidence) {
    const key = `${row.trendKey}\u0000${row.trendUnit || ""}`;
    const builtin = trendCatalog.get(row.trendKey) || null;
    const rowPlacement = trendPlacementFor({
      category: builtin?.category || row.trendCategory,
      sectionName: row.sectionName,
      reportType: row.reportType,
    });
    if (!groups.has(key)) {
      groups.set(key, {
        indicatorKey: row.trendKey,
        name: row.trendName,
        unit: row.trendUnit,
        sectionName: row.sectionName,
        quality: row.trendQuality,
        confidence: row.trendConfidence,
        explanation: builtin?.explanation || row.trendExplanation,
        explanationConfidence: builtin ? 1 : Number(row.trendConfidence || 0),
        fixedPlacement: builtin?.placement || null,
        sourcePreference: builtin?.sourcePreference || null,
        placementVotes: new Map(),
        itemOrder: builtin?.itemOrder ?? 9999,
        matchReasons: new Set(),
        rawNames: new Set(),
        excludedPoints: excludedByKey.get(key) || [],
        points: [],
      });
    }
    const group = groups.get(key)!;
    const voteKey = placementVoteKey(rowPlacement);
    const existingVote = group.placementVotes.get(voteKey);
    if (existingVote) {
      existingVote.count += 1;
      existingVote.maxConfidence = Math.max(
        existingVote.maxConfidence,
        Number(row.trendConfidence || 0),
      );
    } else {
      group.placementVotes.set(voteKey, {
        placement: rowPlacement,
        count: 1,
        maxConfidence: Number(row.trendConfidence || 0),
      });
    }
    if (!builtin && row.trendExplanation) {
      const explanationConfidence = Number(row.trendConfidence || 0);
      if (
        explanationConfidence > group.explanationConfidence ||
        (explanationConfidence === group.explanationConfidence &&
          row.trendExplanation.localeCompare(group.explanation || "", "zh-CN") <
            0)
      ) {
        group.explanation = row.trendExplanation;
        group.explanationConfidence = explanationConfidence;
      }
    }
    if (row.trendReason) group.matchReasons.add(row.trendReason);
    group.rawNames.add(row.itemName);
    const sourcePageNumber =
      row.evidenceTable?.pageNumber || row.evidencePageNumber;
    const sourcePage = sourcePageNumber
      ? sourcePages.get(`${row.reportId}:${sourcePageNumber}`) || null
      : null;
    const lineEvidence = lineEvidenceForRow(row);
    group.points.push({
      observationId: row.observationId,
      reportId: row.reportId,
      reportTitle: row.reportTitle,
      reportType: row.reportType,
      reportStatus: row.reportStatus,
      reportIssuedAt: row.reportIssuedAt,
      sortDate: row.sortDate,
      hospitalName: row.hospitalName,
      sourceSectionName: row.sectionName,
      itemName: row.itemName,
      resultText: row.resultText,
      numericValue: row.trendNumericValue!,
      referenceLow: row.trendReferenceLow,
      referenceHigh: row.trendReferenceHigh,
      referenceText: row.trendReferenceText,
      referenceStatus: row.referenceStatus,
      referenceReason: row.referenceReason,
      comparisonMethod: row.comparisonMethod,
      comparisonSpecimen: row.comparisonSpecimen,
      memberBirthDate: row.memberBirthDate,
      abnormalFlag: row.abnormalFlag,
      reportedAbnormalFlag: row.reportedAbnormalFlag,
      displayAbnormalFlag: row.displayAbnormalFlag,
      abnormalSource: row.abnormalSource,
      abnormalStatus: row.abnormalStatus,
      abnormalConflict: row.abnormalConflict,
      abnormalReason: row.abnormalReason,
      evidenceQuote: row.evidenceQuote,
      normalizationQuality: row.normalizationQuality,
      normalizationConfidence: row.normalizationConfidence,
      normalizationReason: row.trendReason,
      sourceLineIds: lineEvidence.rowLineIds,
      resultLineIds: lineEvidence.resultLineIds,
      sourcePage,
    });
  }

  const reportCollapseCache = new Map<string, boolean>();
  const shouldCollapseReports = (
    leftReportId: string,
    rightReportId: string,
  ) => {
    const key = [leftReportId, rightReportId].sort().join("\u0000");
    const cached = reportCollapseCache.get(key);
    if (cached !== undefined) return cached;
    const collapse = shouldCollapseReportPair(leftReportId, rightReportId);
    reportCollapseCache.set(key, collapse);
    return collapse;
  };

  return Array.from(groups.values())
    .map((group) => {
      /* P0：同一份报告对同一 canonical identity 最多发布一个点。
       优先已确认状态、强章节、原始项目名精确命中和更高归一化置信度；内容键负责稳定决胜，ID 只处理完全等价项。 */
      const qualityRank = (quality: string | null) =>
        ({ high: 0, medium: 1, low: 2 })[quality || ""] ?? 3;
      const pointPreferenceScore = (point: (typeof group.points)[number]) => {
        let score = point.reportStatus === "ready" ? 100 : 0;
        score +=
          point.normalizationQuality === "high"
            ? 30
            : point.normalizationQuality === "medium"
              ? 15
              : 0;
        score += Number(point.normalizationConfidence || 0) * 20;
        const section = point.sourceSectionName || "";
        if (section && !/未标注|未知/.test(section)) score += 20;
        if (
          normalizeContentKey(point.itemName) ===
          normalizeContentKey(group.name)
        )
          score += 15;
        if (point.evidenceQuote) {
          score += 2;
          /*
           * 同一指标常在「检验单表格行」和「小结叙述句」各出现一次。
           * 表格行（分格证据）是原始定量来源，叙述句是二次转述；
           * 值冲突时必须偏好表格行，值相同也不影响展示。
           */
          if (point.evidenceQuote.includes(" | ")) score += 10;
          else if (
            point.evidenceQuote.length > 30 &&
            /[，；。]/.test(point.evidenceQuote)
          )
            score -= 10;
        }
        const sourcePreference = group.sourcePreference;
        if (sourcePreference && section) {
          if (sourcePreference.preferredSections.some((hint) => section.includes(hint)))
            score += 50;
          if (sourcePreference.discouragedSections.some((hint) => section.includes(hint)))
            score -= sourcePreference.discouragedPenalty;
        }
        return score;
      };
      const pointStableKey = (point: (typeof group.points)[number]) =>
        [
          normalizeContentKey(point.sourceSectionName || ""),
          normalizeContentKey(point.itemName),
          normalizeContentKey(point.resultText),
          String(point.numericValue),
          String(point.referenceLow ?? ""),
          String(point.referenceHigh ?? ""),
          normalizeContentKey(point.referenceText || ""),
          point.abnormalFlag || "",
          normalizeContentKey(point.evidenceQuote || ""),
        ].join("\u0000");
      const comparePointPreference = (
        left: (typeof group.points)[number],
        right: (typeof group.points)[number],
      ) =>
        pointPreferenceScore(right) - pointPreferenceScore(left) ||
        pointStableKey(left).localeCompare(pointStableKey(right), "zh-CN") ||
        left.observationId.localeCompare(right.observationId);
      const pointByReport = new Map<string, (typeof group.points)[number]>();
      for (const point of group.points) {
        const current = pointByReport.get(point.reportId);
        if (!current || comparePointPreference(point, current) < 0) {
          pointByReport.set(point.reportId, point);
        }
      }
      const sortedPoints = [...pointByReport.values()].sort(
        (left, right) =>
          String(left.sortDate || "").localeCompare(
            String(right.sortDate || ""),
          ) ||
          (left.reportStatus === "ready" ? 0 : 1) -
            (right.reportStatus === "ready" ? 0 : 1) ||
          qualityRank(left.normalizationQuality) -
            qualityRank(right.normalizationQuality) ||
          left.reportId.localeCompare(right.reportId) ||
          left.observationId.localeCompare(right.observationId),
      );
      /* 重复报告与趋势发布解耦：只有上传原件完全一致，或人工治理明确确认为重复时，
       才折叠跨报告趋势点。医院、日期、标题和指标重合仅用于生成治理候选，
       不再直接删除趋势数据；人工标记为“不同报告”时始终保留。 */
      const points = sortedPoints.filter(
        (point, index) =>
          !sortedPoints.some(
            (other, otherIndex) =>
              otherIndex < index &&
              other.reportId !== point.reportId &&
              shouldCollapseReports(other.reportId, point.reportId),
          ),
      );
      const values = points.map((point) => point.numericValue);
      const metadataRepresentative =
        [...points].sort(
          (left, right) =>
            qualityRank(left.normalizationQuality) -
              qualityRank(right.normalizationQuality) ||
            Number(right.normalizationConfidence || 0) -
              Number(left.normalizationConfidence || 0) ||
            comparePointPreference(left, right),
        )[0] || null;
      const latest = points.at(-1) || null;
      const previous = points.length > 1 ? points.at(-2) || null : null;
      const placement =
        group.fixedPlacement ||
        [...group.placementVotes.values()].sort(
          (left, right) =>
            right.count - left.count ||
            right.maxConfidence - left.maxConfidence ||
            left.placement.groupOrder - right.placement.groupOrder ||
            left.placement.subgroupOrder - right.placement.subgroupOrder,
        )[0]?.placement ||
        trendPlacementFor({});
      const comparability = assessTrendComparability(
        points.map((point) => ({
          referenceLow: point.referenceLow,
          referenceHigh: point.referenceHigh,
          referenceStatus: point.referenceStatus,
          method: point.comparisonMethod,
          specimen: point.comparisonSpecimen,
          reportIssuedAt: point.reportIssuedAt,
          memberBirthDate: point.memberBirthDate,
        })),
      );
      const changeAssessment = assessTrendChange(
        points.map((point) => ({
          observationId: point.observationId,
          numericValue: point.numericValue,
          reportIssuedAt: point.reportIssuedAt,
          referenceLow: point.referenceLow,
          referenceHigh: point.referenceHigh,
        })),
        {
          latestComparisonAllowed: comparability.changeAssessmentAllowed,
          seriesComparisonAllowed: ![
            "range_drift",
            "condition_mismatch",
          ].includes(comparability.status),
        },
      );
      const outlierPointIds = new Set(changeAssessment.outlierPointIds);
      const attention = latest
        ? classifyTrendAttention({
            numericValue: latest.numericValue,
            referenceLow: latest.referenceLow,
            referenceHigh: latest.referenceHigh,
            abnormalFlag: latest.abnormalFlag,
            displayAbnormalFlag: latest.displayAbnormalFlag,
            abnormalStatus: latest.abnormalStatus,
            abnormalConflict: latest.abnormalConflict,
            abnormalReason: latest.abnormalReason,
          })
        : { level: null, boundary: null, reason: null, conflict: false };
      const abnormalContinuity = assessTrendAbnormalContinuity(
        points.map((point) => ({
          numericValue: point.numericValue,
          referenceLow: point.referenceLow,
          referenceHigh: point.referenceHigh,
          referenceStatus: point.referenceStatus,
          displayAbnormalFlag: point.displayAbnormalFlag,
          abnormalStatus: point.abnormalStatus,
          abnormalConflict: point.abnormalConflict,
        })),
        {
          latestNearBoundary: attention.level === "near_boundary",
        },
      );
      return {
        indicatorKey: group.indicatorKey,
        name: group.name,
        unit: group.unit,
        pinned: pinnedKeys.has(
          `${group.indicatorKey}\u0000${group.unit || ""}`,
        ),
        groupKey: placement.groupKey,
        groupName: placement.groupName,
        groupOrder: placement.groupOrder,
        subgroupKey: placement.subgroupKey,
        subgroupName: placement.subgroupName,
        subgroupOrder: placement.subgroupOrder,
        itemOrder: group.itemOrder,
        sectionName: metadataRepresentative
          ? metadataRepresentative.sourceSectionName
          : group.sectionName,
        quality: metadataRepresentative?.normalizationQuality || group.quality,
        confidence:
          metadataRepresentative?.normalizationConfidence ?? group.confidence,
        explanation: group.explanation,
        searchAliases: [...(trustedAliases.get(group.indicatorKey) || [])]
          .filter((alias) => alias !== group.name)
          .sort((left, right) => left.localeCompare(right, "zh-CN"))
          .slice(0, 20),
        attentionLevel: attention.level,
        attentionReason: attention.reason,
        attentionBoundary: attention.boundary,
        attentionConflict: attention.conflict,
        abnormalContinuityStatus: abnormalContinuity.status,
        abnormalContinuityReason: abnormalContinuity.reason,
        latestAbnormal: abnormalContinuity.latestAbnormal,
        latestAbnormalDirection: abnormalContinuity.latestDirection,
        consecutiveAbnormalCount: abnormalContinuity.consecutiveAbnormalCount,
        totalAbnormalCount: abnormalContinuity.totalAbnormalCount,
        previousAbnormalCount: abnormalContinuity.previousAbnormalCount,
        recoveredFromAbnormal: abnormalContinuity.recoveredFromAbnormal,
        abnormalConflictPointCount: abnormalContinuity.conflictPointCount,
        attentionPriority: abnormalContinuity.attentionPriority,
        comparable: comparability.comparable,
        comparabilityStatus: comparability.status,
        comparabilityReason: comparability.reason,
        referenceProfileKey: comparability.referenceProfileKey,
        referenceProfileCount: comparability.referenceProfileCount,
        latestPairComparabilityStatus: comparability.latestPairStatus,
        changeAssessmentAllowed: comparability.changeAssessmentAllowed,
        latestChangeStatus: changeAssessment.latestChangeStatus,
        latestChangeMagnitude: changeAssessment.latestChangeMagnitude,
        latestChangeReason: changeAssessment.latestChangeReason,
        latestChangeConclusionAllowed:
          changeAssessment.latestChangeConclusionAllowed,
        latestIntervalDays: changeAssessment.latestIntervalDays,
        latestIntervalBucket: changeAssessment.latestIntervalBucket,
        trendStatus: changeAssessment.trendStatus,
        trendReason: changeAssessment.trendReason,
        trendConclusionAllowed: changeAssessment.trendConclusionAllowed,
        trendDurationDays: changeAssessment.trendDurationDays,
        trendIntervalRegularity: changeAssessment.trendIntervalRegularity,
        analysisPointCount: changeAssessment.analysisPointCount,
        outlierCount: changeAssessment.outlierCount,
        typicalMinValue: changeAssessment.typicalMinValue,
        typicalMaxValue: changeAssessment.typicalMaxValue,
        matchReasons: [...group.matchReasons]
          .sort((left, right) => left.localeCompare(right, "zh-CN"))
          .slice(0, 3),
        sourceNames: [...group.rawNames]
          .sort((left, right) => left.localeCompare(right, "zh-CN"))
          .slice(0, 8),
        excludedPoints: group.excludedPoints
          .sort(
            (left, right) =>
              String(right.reportIssuedAt || "").localeCompare(
                String(left.reportIssuedAt || ""),
              ) ||
              left.reportId.localeCompare(right.reportId) ||
              normalizeContentKey(left.itemName).localeCompare(
                normalizeContentKey(right.itemName),
                "zh-CN",
              ) ||
              normalizeContentKey(left.resultText).localeCompare(
                normalizeContentKey(right.resultText),
                "zh-CN",
              ) ||
              left.observationId.localeCompare(right.observationId),
          )
          .slice(0, 8),
        pointCount: points.length,
        firstDate: points[0]?.reportIssuedAt || null,
        lastDate: latest?.reportIssuedAt || null,
        latestValue: latest?.numericValue ?? null,
        previousValue: previous?.numericValue ?? null,
        delta: changeAssessment.latestDelta,
        minValue: values.length ? Math.min(...values) : null,
        maxValue: values.length ? Math.max(...values) : null,
        points: points.map(
          ({
            sortDate,
            reportType,
            sourceSectionName,
            comparisonMethod,
            comparisonSpecimen,
            memberBirthDate,
            ...point
          }) => ({
            ...point,
            trendOutlier: outlierPointIds.has(point.observationId),
            trendOutlierReason: outlierPointIds.has(point.observationId)
              ? "该点与其余记录差异较大，原值保留但不用于自动趋势结论"
              : null,
          }),
        ),
      };
    })
    .sort(
      (left, right) =>
        Number(right.pinned) - Number(left.pinned) ||
        left.groupOrder - right.groupOrder ||
        left.subgroupOrder - right.subgroupOrder ||
        left.itemOrder - right.itemOrder ||
        left.name.localeCompare(right.name, "zh-CN") ||
        String(left.unit || "").localeCompare(
          String(right.unit || ""),
          "zh-CN",
        ),
    );
}

export function updateTrendPin(
  user: RequestUser,
  input: { memberId?: unknown; indicatorKey?: unknown; unit?: unknown },
  pinned: boolean,
) {
  const memberId = textInput(input.memberId, 80);
  const indicatorKey = textInput(input.indicatorKey, 180);
  const unitKey = textInput(input.unit, 60) || "";
  if (!memberId || !indicatorKey) {
    throw createError({ statusCode: 400, statusMessage: "指标置顶参数不完整" });
  }
  assertMemberAccess(user, memberId);
  if (pinned) {
    // 轻量存在性校验：与 listTrendSeries 的发布口径一致（已归一化 high/medium、
    // 规范单位匹配、存在可用数值），避免为一次置顶整算全部趋势。
    const exists = Boolean(
      getDatabase()
        .prepare(
          `
      SELECT 1
      FROM observation_normalizations n
      JOIN observations o ON o.id = n.observation_id
      JOIN reports r ON r.id = o.report_id
      JOIN member_permissions mp ON mp.member_id = r.member_id AND mp.user_id = ?
      WHERE r.member_id = ? AND r.status <> 'trashed'
        AND n.canonical_key = ? AND n.canonical_name IS NOT NULL
        AND n.quality IN ('high', 'medium')
        AND COALESCE(n.canonical_unit, '') = ?
        AND (
          n.canonical_value IS NOT NULL OR o.numeric_value IS NOT NULL
          OR o.result_text GLOB '*[0-9]*'
        )
      LIMIT 1
    `,
        )
        .get(user.id, memberId, indicatorKey, unitKey),
    );
    if (!exists)
      throw createError({
        statusCode: 404,
        statusMessage: "指标趋势不存在或已发生变化",
      });
    getDatabase()
      .prepare(
        `
      INSERT INTO user_trend_pins (user_id, member_id, indicator_key, unit_key)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id, member_id, indicator_key, unit_key) DO UPDATE SET
        updated_at = CURRENT_TIMESTAMP
    `,
      )
      .run(user.id, memberId, indicatorKey, unitKey);
  } else {
    getDatabase()
      .prepare(
        `
      DELETE FROM user_trend_pins
      WHERE user_id = ? AND member_id = ? AND indicator_key = ? AND unit_key = ?
    `,
      )
      .run(user.id, memberId, indicatorKey, unitKey);
  }
  return { memberId, indicatorKey, unit: unitKey || null, pinned };
}

export function listReminders(user: RequestUser, memberId?: string) {
  if (!user.authenticated) return [];
  if (memberId) assertMemberAccess(user, memberId);
  return getDatabase()
    .prepare(
      `
    SELECT re.id, re.member_id AS memberId, CASE WHEN r.id IS NULL THEN NULL ELSE re.report_id END AS reportId, re.title,
      re.due_at AS dueAt, re.status, re.source,
      r.title AS reportTitle, r.hospital_name_raw AS reportHospitalName,
      ${reportDisplayDateSql} AS reportIssuedAt
    FROM reminders re
    JOIN member_permissions mp ON mp.member_id = re.member_id AND mp.user_id = ?
    LEFT JOIN reports r ON r.id = re.report_id AND r.status <> 'trashed'
    WHERE (? IS NULL OR re.member_id = ?)
    ORDER BY re.status = 'pending' DESC, re.due_at
  `,
    )
    .all(user.id, memberId || null, memberId || null);
}

export function createReminder(
  user: RequestUser,
  input: Record<string, unknown>,
) {
  const memberId = textInput(input.memberId, 80);
  if (!memberId)
    throw createError({ statusCode: 400, statusMessage: "请选择提醒所属成员" });
  assertMemberManage(user, memberId);
  const title = textInput(input.title, 180);
  const dueAt = dateInput(input.dueAt);
  if (!title || !dueAt)
    throw createError({
      statusCode: 400,
      statusMessage: "请填写提醒标题和日期",
    });
  const reportId = textInput(input.reportId, 80);
  if (reportId) {
    const report = getDatabase()
      .prepare(
        "SELECT member_id AS memberId FROM reports WHERE id = ? AND status <> 'trashed'",
      )
      .get(reportId) as { memberId: string } | undefined;
    if (!report || report.memberId !== memberId)
      throw createError({ statusCode: 400, statusMessage: "关联报告无效" });
  }
  const id = createId("reminder");
  getDatabase()
    .prepare(
      `
    INSERT INTO reminders (id, member_id, report_id, title, due_at, source, created_by)
    VALUES (?, ?, ?, ?, ?, 'manual', ?)
  `,
    )
    .run(id, memberId, reportId, title, dueAt, user.id);
  getDatabase()
    .prepare(
      `
    INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, detail_json)
    VALUES (?, ?, 'reminder.create', 'reminder', ?, ?)
  `,
    )
    .run(
      createId("audit"),
      user.id,
      id,
      JSON.stringify({ memberId, reportId }),
    );
  return {
    id,
    memberId,
    reportId,
    title,
    dueAt,
    status: "pending",
    source: "manual",
  };
}

export function updateReminderStatus(
  user: RequestUser,
  reminderId: string,
  status: string,
) {
  if (!["pending", "completed", "dismissed"].includes(status))
    throw createError({ statusCode: 400, statusMessage: "提醒状态无效" });
  const reminder = getDatabase()
    .prepare("SELECT member_id AS memberId FROM reminders WHERE id = ?")
    .get(reminderId) as { memberId: string } | undefined;
  if (!reminder)
    throw createError({ statusCode: 404, statusMessage: "提醒不存在" });
  assertMemberManage(user, reminder.memberId);
  getDatabase()
    .prepare(
      "UPDATE reminders SET status = ?, confirmed_at = CASE WHEN ? = 'pending' THEN NULL ELSE CURRENT_TIMESTAMP END WHERE id = ?",
    )
    .run(status, status, reminderId);
  getDatabase()
    .prepare(
      `
    INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, detail_json)
    VALUES (?, ?, 'reminder.status', 'reminder', ?, ?)
  `,
    )
    .run(
      createId("audit"),
      user.id,
      reminderId,
      JSON.stringify({ status, memberId: reminder.memberId }),
    );
  return { id: reminderId, status };
}

export function listAppNotifications(user: RequestUser, memberId?: string) {
  if (!user.authenticated) return [];
  if (memberId) assertMemberAccess(user, memberId);
  return getDatabase()
    .prepare(
      `
    SELECT n.id, n.member_id AS memberId, n.report_id AS reportId, n.type, n.title,
      n.message, n.severity, n.status, n.created_at AS createdAt, n.read_at AS readAt,
      r.title AS reportTitle
    FROM app_notifications n
    JOIN member_permissions mp ON mp.member_id = n.member_id AND mp.user_id = ?
    LEFT JOIN reports r ON r.id = n.report_id
    WHERE n.status <> 'archived'
      AND (? IS NULL OR n.member_id = ?)
    ORDER BY n.status = 'unread' DESC, n.created_at DESC, n.id DESC
    LIMIT 100
  `,
    )
    .all(user.id, memberId || null, memberId || null);
}

export function updateAppNotificationStatus(
  user: RequestUser,
  notificationId: string,
  status: string,
) {
  if (!["unread", "read", "archived"].includes(status))
    throw createError({ statusCode: 400, statusMessage: "通知状态无效" });
  const notification = getDatabase()
    .prepare("SELECT member_id AS memberId FROM app_notifications WHERE id = ?")
    .get(notificationId) as { memberId: string } | undefined;
  if (!notification)
    throw createError({ statusCode: 404, statusMessage: "通知不存在" });
  assertMemberAccess(user, notification.memberId);
  getDatabase()
    .prepare(
      `
    UPDATE app_notifications
    SET status = ?, read_at = CASE WHEN ? = 'unread' THEN NULL ELSE COALESCE(read_at, CURRENT_TIMESTAMP) END
    WHERE id = ?
  `,
    )
    .run(status, status, notificationId);
  return { id: notificationId, status };
}

function recommendationDueDate(
  reportIssuedAt: string | null,
  recommendation: string,
) {
  const explicit = recommendation.match(
    /(20\d{2})[年\-/.](\d{1,2})[月\-/.](\d{1,2})/,
  );
  if (explicit) {
    const [, year, month, day] = explicit;
    return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  }
  const months = recommendation.match(/(\d{1,2})\s*个?月(?:后|内)?/);
  const days = recommendation.match(/(\d{1,3})\s*天(?:后|内)?/);
  const base = new Date(
    `${datePart(reportIssuedAt) || new Date().toISOString().slice(0, 10)}T00:00:00`,
  );
  if (months) base.setMonth(base.getMonth() + Number(months[1]));
  else if (days) base.setDate(base.getDate() + Number(days[1]));
  else base.setMonth(base.getMonth() + 3);
  return base.toISOString().slice(0, 10);
}

function createReportSuggestionReminder(user: RequestUser, reportId: string) {
  const report = getDatabase()
    .prepare(
      `
    SELECT member_id AS memberId, title, recommendation,
      COALESCE(report_issued_at, reviewed_at, received_at, examined_at, sampled_at, ordered_at) AS reportIssuedAt
    FROM reports WHERE id = ? AND status <> 'trashed'
  `,
    )
    .get(reportId) as
    | {
        memberId: string;
        title: string;
        recommendation: string | null;
        reportIssuedAt: string | null;
      }
    | undefined;
  if (!report?.recommendation) return null;
  const existing = getDatabase()
    .prepare(
      "SELECT id FROM reminders WHERE report_id = ? AND source = 'report_suggestion'",
    )
    .get(reportId) as { id: string } | undefined;
  if (existing) return existing;
  const id = createId("reminder");
  getDatabase()
    .prepare(
      `
    INSERT INTO reminders (id, member_id, report_id, title, due_at, source, created_by)
    VALUES (?, ?, ?, ?, ?, 'report_suggestion', ?)
  `,
    )
    .run(
      id,
      report.memberId,
      reportId,
      `${report.title}：复查提醒`,
      recommendationDueDate(report.reportIssuedAt, report.recommendation),
      user.id,
    );
  return { id };
}

export function listAuditLogs(user: RequestUser, limit = 80) {
  if (!isAdministrator(user))
    throw createError({
      statusCode: 403,
      statusMessage: "仅管理员可查看审计日志",
    });
  const rows = getDatabase()
    .prepare(
      `
    SELECT a.id, a.action, a.target_type AS targetType, a.target_id AS targetId,
      u.display_name AS actorName, a.detail_json AS detailJson, a.created_at AS createdAt
    FROM audit_logs a
    LEFT JOIN users u ON u.id = a.actor_user_id
    ORDER BY a.created_at DESC, a.id DESC
    LIMIT ?
  `,
    )
    .all(Math.min(200, Math.max(1, Math.round(limit)))) as Array<{
    id: string;
    action: string;
    targetType: string | null;
    targetId: string | null;
    actorName: string | null;
    detailJson: string;
    createdAt: string;
  }>;
  return rows.map((item) => ({
    ...item,
    detail: parseJson(item.detailJson, {}),
    detailJson: undefined,
  }));
}

type AuditCursor = { createdAt: string; id: string };

function encodeAuditCursor(row: AuditCursor) {
  return Buffer.from(`${row.createdAt}|${row.id}`).toString("base64url");
}

function decodeAuditCursor(value?: string): AuditCursor | null {
  if (!value) return null;
  try {
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    const separator = decoded.lastIndexOf("|");
    if (separator < 0) return null;
    const createdAt = decoded.slice(0, separator);
    const id = decoded.slice(separator + 1);
    return createdAt && id ? { createdAt, id } : null;
  } catch {
    return null;
  }
}

const auditActionTitles: Record<string, string> = {
  "report.upload": "上传报告",
  "report.confirm_ready": "确认归档报告",
  "report.trash": "移入回收站",
  "report.restore": "恢复报告",
  "report.purge": "永久删除报告",
  "report.merge_duplicate": "合并重复报告",
  "report.reprocess_ocr_ai": "重新识别报告",
  "report.manual_update": "校对报告字段",
  "report.pages.update": "调整报告页面",
  "report.page.delete": "删除报告页面",
  "reminder.create": "创建提醒",
  "reminder.status": "更新提醒状态",
  "member.create": "新增家庭成员",
  "member.update": "更新成员资料",
  "member.delete": "删除成员",
  "member.permission.update": "更新成员授权",
  "member.permission.remove": "移除成员授权",
  "backup.create": "创建完整备份",
  "backup.restore": "恢复完整备份",
  "backup.identity_rebind": "接管恢复数据权限",
  "backup.delete": "删除完整备份",
  "maintenance.regenerate_report_titles": "批量清理报告标题",
  "maintenance.regenerate_pdf_previews": "重新生成 PDF 单页图",
  "maintenance.normalize_indicators": "重新归一化历史指标",
  "maintenance.rebuild_morphology_tracking": "重新关联历史形态发现",
  "morphology.update": "校对形态发现",
  "morphology.link": "关联形态变化",
  "morphology.separate": "建立独立形态变化",
  "morphology.ignore": "忽略形态误提取",
  "morphology.merge": "合并形态变化线",
  "morphology.split": "拆分形态变化线",
  "clinical_fact.create": "新增报告分类信息",
  "clinical_fact.update": "校对报告分类信息",
  "clinical_fact.delete": "删除报告分类信息",
  "report_structured_section.create": "新增报告专属内容",
  "report_structured_section.update": "校对报告专属内容",
  "report_structured_section.delete": "删除报告专属内容",
  "system.user_audit_clear": "清理用户操作日志",
  "system.logs_clear": "清理系统日志",
  "system.diagnostics_export": "导出系统诊断包",
  "dictionary.update": "更新指标字典",
  "dictionary.rollback": "回滚指标字典",
};

const auditTargetLabels: Record<string, string> = {
  report: "报告",
  report_page: "报告页面",
  reminder: "提醒",
  health_member: "家庭成员",
  member: "家庭成员",
  backup: "备份",
  observation: "指标",
  morphology_finding: "形态发现",
  clinical_fact: "报告分类信息",
  report_structured_section: "报告专属内容",
  user_audit_log: "用户操作日志",
  system_log: "系统日志",
  indicator_dictionary: "指标字典",
  user: "用户账号",
};

/** 审计 detail 中的状态值统一翻译成中文，覆盖提醒/通知/报告三类状态 */
const auditStatusLabels: Record<string, string> = {
  pending: "待处理",
  completed: "已完成",
  dismissed: "已忽略",
  unread: "未读",
  archived: "已归档",
  uploading: "上传中",
  queued: "排队中",
  processing: "处理中",
  needs_review: "待确认",
  ready: "已归档",
  failed: "识别失败",
  trashed: "回收站",
};

function shortAuditId(value: string) {
  return value.length > 14 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;
}

function collectAuditReferenceIds(
  rows: Array<{
    targetType: string | null;
    targetId: string | null;
    detailJson: string;
  }>,
) {
  const userIds = new Set<string>();
  const memberIds = new Set<string>();
  const reportIds = new Set<string>();
  const pageIds = new Set<string>();
  const reminderIds = new Set<string>();
  const morphologyFindingIds = new Set<string>();
  const backupIds = new Set<string>();
  for (const row of rows) {
    const detail = parseJson<Record<string, unknown>>(row.detailJson, {});
    if (row.targetId) {
      if (row.targetType === "report") reportIds.add(row.targetId);
      else if (row.targetType === "report_page") pageIds.add(row.targetId);
      else if (
        row.targetType === "health_member" ||
        row.targetType === "member"
      )
        memberIds.add(row.targetId);
      else if (row.targetType === "reminder") reminderIds.add(row.targetId);
      else if (row.targetType === "morphology_finding")
        morphologyFindingIds.add(row.targetId);
      else if (row.targetType === "backup") backupIds.add(row.targetId);
      else if (row.targetType === "user") userIds.add(row.targetId);
    }
    if (typeof detail.userId === "string") userIds.add(detail.userId);
    for (const key of ["memberId"] as const) {
      if (typeof detail[key] === "string") memberIds.add(detail[key]);
    }
    for (const key of [
      "reportId",
      "sourceReportId",
      "targetReportId",
    ] as const) {
      if (typeof detail[key] === "string") reportIds.add(detail[key]);
    }
    if (typeof detail.reminderId === "string")
      reminderIds.add(detail.reminderId);
  }
  return {
    userIds,
    memberIds,
    reportIds,
    pageIds,
    reminderIds,
    morphologyFindingIds,
    backupIds,
  };
}

function rowsById<T extends { id: string }>(
  table:
    | "users"
    | "health_members"
    | "reports"
    | "reminders"
    | "morphology_findings",
  ids: Set<string>,
  select: string,
) {
  if (!ids.size) return new Map<string, T>();
  const placeholders = [...ids].map(() => "?").join(",");
  const rows = getDatabase()
    .prepare(`SELECT ${select} FROM ${table} WHERE id IN (${placeholders})`)
    .all(...ids) as T[];
  return new Map(rows.map((row) => [row.id, row]));
}

function reportPagesById(ids: Set<string>) {
  if (!ids.size)
    return new Map<
      string,
      { id: string; reportTitle: string; pageNumber: number }
    >();
  const placeholders = [...ids].map(() => "?").join(",");
  const rows = getDatabase()
    .prepare(
      `
    SELECT p.id, r.title AS reportTitle, p.page_number AS pageNumber
    FROM report_pages p
    JOIN reports r ON r.id = p.report_id
    WHERE p.id IN (${placeholders})
  `,
    )
    .all(...ids) as Array<{
    id: string;
    reportTitle: string;
    pageNumber: number;
  }>;
  return new Map(rows.map((row) => [row.id, row]));
}

function userAuditDescription(
  action: string,
  detail: Record<string, unknown>,
  names: {
    users: Map<string, { id: string; displayName: string }>;
    members: Map<string, { id: string; displayName: string }>;
    reports: Map<string, { id: string; title: string }>;
    reminders: Map<string, { id: string; title: string }>;
  },
) {
  const memberName = (id: string) =>
    names.members.get(id)?.displayName || shortAuditId(id);
  const reportName = (id: string) =>
    names.reports.get(id)?.title || shortAuditId(id);
  const reminderName = (id: string) =>
    names.reminders.get(id)?.title || shortAuditId(id);
  const parts: string[] = [];
  if (typeof detail.memberId === "string")
    parts.push(`成员 ${memberName(detail.memberId)}`);
  if (typeof detail.reportId === "string")
    parts.push(`报告 ${reportName(detail.reportId)}`);
  if (typeof detail.sourceReportId === "string")
    parts.push(`来源 ${reportName(detail.sourceReportId)}`);
  if (typeof detail.targetReportId === "string")
    parts.push(`目标 ${reportName(detail.targetReportId)}`);
  if (typeof detail.reminderId === "string")
    parts.push(`提醒 ${reminderName(detail.reminderId)}`);
  if (typeof detail.filename === "string")
    parts.push(`文件 ${detail.filename}`);
  if (typeof detail.fileCount === "number")
    parts.push(`${detail.fileCount} 个文件`);
  if (typeof detail.pageCount === "number")
    parts.push(`${detail.pageCount} 页`);
  if (typeof detail.queuedOcr === "number")
    parts.push(`重新 OCR ${detail.queuedOcr} 页`);
  if (typeof detail.movedPages === "number")
    parts.push(`合并 ${detail.movedPages} 页`);
  if (typeof detail.reportCount === "number")
    parts.push(`${detail.reportCount} 份报告`);
  if (typeof detail.memberCount === "number")
    parts.push(`${detail.memberCount} 位成员`);
  if (typeof detail.deletedFiles === "number")
    parts.push(`清理 ${detail.deletedFiles} 个日志文件`);
  if (typeof detail.deletedCount === "number")
    parts.push(`清理 ${detail.deletedCount} 条记录`);
  if (typeof detail.freedBytes === "number") {
    const freed =
      detail.freedBytes < 1024 * 1024
        ? `${Math.round(detail.freedBytes / 1024)} KB`
        : `${(detail.freedBytes / 1024 / 1024).toFixed(1)} MB`;
    parts.push(`释放 ${freed}`);
  }
  if (typeof detail.safetyBackupId === "string")
    parts.push(`安全备份 ${shortAuditId(detail.safetyBackupId)}`);
  if (typeof detail.updated === "number")
    parts.push(`更新 ${detail.updated} 条`);
  if (action.startsWith("dictionary.")) {
    if (detail.layer === "core") parts.push("内置字典");
    else if (detail.layer === "remote") parts.push("远程字典");
    if (typeof detail.revision === "number")
      parts.push(`版本 ${detail.revision}`);
    if (typeof detail.indicators === "number")
      parts.push(`${detail.indicators} 个指标`);
    if (typeof detail.aliases === "number")
      parts.push(`${detail.aliases} 个别名`);
  }
  if (typeof detail.status === "string")
    parts.push(`状态 ${auditStatusLabels[detail.status] || "未知状态"}`);
  if (typeof detail.factType === "string") {
    const labels: Record<string, string> = {
      diagnosis: "诊断",
      medication: "用药",
      procedure: "诊疗操作",
      vaccination: "疫苗",
      billingSummary: "费用汇总",
      billingItem: "费用明细",
    };
    parts.push(labels[detail.factType] || "其他分类信息");
  }
  if (typeof detail.sectionKey === "string") {
    parts.push(
      reportStructuredSectionLabels[
        detail.sectionKey as keyof typeof reportStructuredSectionLabels
      ] || "其他专属内容",
    );
  }
  if (Array.isArray(detail.fields) && detail.fields.length)
    parts.push(`字段 ${detail.fields.length} 项`);
  return parts.join(" · ") || auditActionTitles[action] || "未提供操作详情";
}

function userAuditTitle(action: string, detail: Record<string, unknown>) {
  if (action === "dictionary.update" && detail.layer === "core")
    return "同步内置指标字典";
  if (action === "dictionary.update" && detail.layer === "remote")
    return "更新远程指标字典";
  if (action === "dictionary.rollback") return "回滚远程指标字典";
  return auditActionTitles[action] || "未知操作";
}

export function listUserOperationAuditLogs(
  user: RequestUser,
  limit = 30,
  cursorValue?: string,
): CursorPage<{
  id: string;
  action: string;
  title: string;
  description: string;
  targetLabel: string;
  targetId: string | null;
  targetName: string | null;
  actorName: string | null;
  createdAt: string;
  detail: Record<string, unknown>;
}> {
  if (!isAdministrator(user))
    throw createError({
      statusCode: 403,
      statusMessage: "仅管理员可查看用户操作日志",
    });
  const safeLimit = Math.min(50, Math.max(1, Math.round(limit)));
  const cursor = decodeAuditCursor(cursorValue);
  const rows = getDatabase()
    .prepare(
      `
    SELECT a.id, a.action, a.target_type AS targetType, a.target_id AS targetId,
      u.display_name AS actorName, a.detail_json AS detailJson, a.created_at AS createdAt
    FROM audit_logs a
    LEFT JOIN users u ON u.id = a.actor_user_id
    WHERE (
      ? IS NULL
      OR a.created_at < ?
      OR (a.created_at = ? AND a.id < ?)
    )
    ORDER BY a.created_at DESC, a.id DESC
    LIMIT ?
  `,
    )
    .all(
      cursor?.id ?? null,
      cursor?.createdAt ?? null,
      cursor?.createdAt ?? null,
      cursor?.id ?? null,
      safeLimit + 1,
    ) as Array<{
    id: string;
    action: string;
    targetType: string | null;
    targetId: string | null;
    actorName: string | null;
    detailJson: string;
    createdAt: string;
  }>;
  const hasMore = rows.length > safeLimit;
  const pageRows = hasMore ? rows.slice(0, safeLimit) : rows;
  const refs = collectAuditReferenceIds(pageRows);
  const names = {
    users: rowsById<{ id: string; displayName: string }>(
      "users",
      refs.userIds,
      "id, display_name AS displayName",
    ),
    members: rowsById<{ id: string; displayName: string }>(
      "health_members",
      refs.memberIds,
      "id, display_name AS displayName",
    ),
    reports: rowsById<{ id: string; title: string }>(
      "reports",
      refs.reportIds,
      "id, title",
    ),
    pages: reportPagesById(refs.pageIds),
    reminders: rowsById<{ id: string; title: string }>(
      "reminders",
      refs.reminderIds,
      "id, title",
    ),
    morphologyFindings: rowsById<{
      id: string;
      organ: string | null;
      findingName: string;
    }>(
      "morphology_findings",
      refs.morphologyFindingIds,
      "id, organ, finding_name AS findingName",
    ),
  };
  const targetName = (
    targetType: string | null,
    targetId: string | null,
    detail: Record<string, unknown>,
  ) => {
    if (!targetId) return null;
    if (targetType === "report") {
      return (
        names.reports.get(targetId)?.title ||
        (typeof detail.reportTitle === "string" ? detail.reportTitle : null) ||
        "已删除报告"
      );
    }
    if (targetType === "report_page") {
      const page = names.pages.get(targetId);
      if (page) return `${page.reportTitle} · 第 ${page.pageNumber} 页`;
      if (typeof detail.reportId === "string")
        return `${names.reports.get(detail.reportId)?.title || shortAuditId(detail.reportId)} · 报告页面`;
      return "报告页面";
    }
    if (targetType === "health_member" || targetType === "member")
      return names.members.get(targetId)?.displayName || "已删除成员";
    if (targetType === "reminder")
      return names.reminders.get(targetId)?.title || "已删除提醒";
    if (targetType === "user")
      return names.users.get(targetId)?.displayName || "未知用户";
    if (targetType === "backup") return "完整备份";
    if (targetType === "observation") return "指标记录";
    if (targetType === "morphology_finding") {
      const finding = names.morphologyFindings.get(targetId);
      return finding
        ? [finding.organ, finding.findingName].filter(Boolean).join(" · ")
        : "形态发现";
    }
    if (targetType === "indicator_dictionary") {
      const layer =
        detail.layer === "core"
          ? "内置字典"
          : detail.layer === "remote"
            ? "远程字典"
            : "指标字典";
      return typeof detail.revision === "number"
        ? `${layer}版本 ${detail.revision}`
        : layer;
    }
    if (targetType === "clinical_fact" && typeof detail.reportId === "string") {
      const labels: Record<string, string> = {
        diagnosis: "诊断",
        medication: "用药",
        procedure: "诊疗操作",
        vaccination: "疫苗",
        billingSummary: "费用汇总",
        billingItem: "费用明细",
      };
      const reportTitle =
        names.reports.get(detail.reportId)?.title ||
        shortAuditId(detail.reportId);
      const factLabel =
        typeof detail.factType === "string"
          ? labels[detail.factType] || "其他分类信息"
          : "分类信息";
      return `${reportTitle} · ${factLabel}`;
    }
    if (
      targetType === "report_structured_section" &&
      typeof detail.reportId === "string"
    ) {
      const reportTitle =
        names.reports.get(detail.reportId)?.title ||
        shortAuditId(detail.reportId);
      const sectionLabel =
        typeof detail.sectionKey === "string"
          ? reportStructuredSectionLabels[
              detail.sectionKey as keyof typeof reportStructuredSectionLabels
            ] || "其他专属内容"
          : "专属内容";
      return `${reportTitle} · ${sectionLabel}`;
    }
    return shortAuditId(targetId);
  };
  const items = pageRows.map((item) => {
    const detail = parseJson<Record<string, unknown>>(item.detailJson, {});
    return {
      id: item.id,
      action: item.action,
      title: userAuditTitle(item.action, detail),
      description: userAuditDescription(item.action, detail, names),
      targetLabel: item.targetType
        ? auditTargetLabels[item.targetType] || "其他对象"
        : "系统",
      targetId: item.targetId,
      targetName: targetName(item.targetType, item.targetId, detail),
      actorName: item.actorName,
      createdAt: item.createdAt,
      detail,
    };
  });
  const last = items.at(-1);
  return {
    items,
    hasMore,
    nextCursor:
      hasMore && last
        ? encodeAuditCursor({ createdAt: last.createdAt, id: last.id })
        : null,
  };
}

export function clearUserOperationAuditLogs(user: RequestUser) {
  if (!isAdministrator(user))
    throw createError({
      statusCode: 403,
      statusMessage: "仅管理员可清理用户操作日志",
    });

  const db = getDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = db.prepare("DELETE FROM audit_logs").run();
    const deletedCount = Number(result.changes);
    db.prepare(`
      INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, detail_json)
      VALUES (?, ?, 'system.user_audit_clear', 'user_audit_log', NULL, ?)
    `).run(createId("audit"), user.id, JSON.stringify({ deletedCount }));
    db.exec("COMMIT");
    return { deletedCount };
  } catch (cause) {
    db.exec("ROLLBACK");
    throw cause;
  }
}

export function getAiAuditSummary(
  user: RequestUser,
  limit = 30,
  cursorValue?: string,
) {
  if (!isAdministrator(user))
    throw createError({
      statusCode: 403,
      statusMessage: "仅管理员可查看 AI 审计",
    });
  const safeLimit = Math.min(50, Math.max(1, Math.round(limit)));
  const cursor = decodeAuditCursor(cursorValue);
  const summary = getDatabase()
    .prepare(
      `
    WITH ai_rows AS (
      SELECT j.id, 'report_extraction' AS source, j.status,
        COALESCE(NULLIF((SELECT COUNT(*) FROM ai_extraction_attempts aa WHERE aa.job_id = j.id), 0), j.attempts) AS attempts,
        e.prompt_tokens AS promptTokens, e.completion_tokens AS completionTokens, e.elapsed_ms AS elapsedMs
      FROM processing_jobs j
      LEFT JOIN report_extractions e ON e.job_id = j.id
      WHERE j.job_type = 'ai_extract'
      UNION ALL
      SELECT a.id, a.source, a.status, a.attempts,
        a.prompt_tokens AS promptTokens, a.completion_tokens AS completionTokens, a.elapsed_ms AS elapsedMs
      FROM ai_audit_events a
    )
    SELECT
      COUNT(*) AS jobCount,
      COALESCE(SUM(attempts), 0) AS callCount,
      SUM(status = 'completed') AS successJobs,
      SUM(status = 'failed') AS failedJobs,
      SUM(status = 'queued') AS queuedJobs,
      SUM(status = 'processing') AS processingJobs,
      COALESCE(SUM(promptTokens), 0) AS promptTokens,
      COALESCE(SUM(completionTokens), 0) AS completionTokens,
      COALESCE(AVG(elapsedMs), 0) AS avgElapsedMs
    FROM ai_rows
  `,
    )
    .get() as {
    jobCount: number;
    callCount: number;
    successJobs: number | null;
    failedJobs: number | null;
    queuedJobs: number | null;
    processingJobs: number | null;
    promptTokens: number;
    completionTokens: number;
    avgElapsedMs: number;
  };
  const rows = getDatabase()
    .prepare(
      `
    WITH ai_rows AS (
      SELECT j.id, 'report_extraction' AS source, j.report_id AS reportId, r.title AS reportTitle, r.member_id AS memberId,
        j.status,
        COALESCE(NULLIF((SELECT COUNT(*) FROM ai_extraction_attempts aa WHERE aa.job_id = j.id), 0), j.attempts) AS attempts,
        j.error_code AS errorCode, j.error_message AS errorMessage,
        j.created_at AS createdAt, j.started_at AS startedAt, j.finished_at AS finishedAt,
        e.provider, e.model, e.prompt_tokens AS promptTokens, e.completion_tokens AS completionTokens,
        e.elapsed_ms AS elapsedMs, e.input_characters AS inputCharacters,
        (
          SELECT ur.document_content_type
          FROM ai_extraction_unit_routes ur
          JOIN ai_extraction_units uu ON uu.id = ur.unit_id
          WHERE uu.job_id = j.id
          ORDER BY uu.unit_index
          LIMIT 1
        ) AS documentContentType,
        (
          SELECT GROUP_CONCAT(DISTINCT ur.primary_content_type)
          FROM ai_extraction_unit_routes ur
          JOIN ai_extraction_units uu ON uu.id = ur.unit_id
          WHERE uu.job_id = j.id
        ) AS routedContentTypes
      FROM processing_jobs j
      JOIN reports r ON r.id = j.report_id
      LEFT JOIN report_extractions e ON e.job_id = j.id
      WHERE j.job_type = 'ai_extract'
      UNION ALL
      SELECT a.id, a.source, a.report_id AS reportId, COALESCE(r.title, a.target_title) AS reportTitle, r.member_id AS memberId,
        a.status, a.attempts, a.error_code AS errorCode, a.error_message AS errorMessage,
        a.created_at AS createdAt, a.created_at AS startedAt, a.created_at AS finishedAt,
        a.provider, a.model, a.prompt_tokens AS promptTokens, a.completion_tokens AS completionTokens,
        a.elapsed_ms AS elapsedMs, a.input_characters AS inputCharacters,
        NULL AS documentContentType, NULL AS routedContentTypes
      FROM ai_audit_events a
      LEFT JOIN reports r ON r.id = a.report_id
    )
    SELECT * FROM ai_rows
    WHERE (
      ? IS NULL
      OR createdAt < ?
      OR (createdAt = ? AND id < ?)
    )
    ORDER BY createdAt DESC, id DESC
    LIMIT ?
  `,
    )
    .all(
      cursor?.id ?? null,
      cursor?.createdAt ?? null,
      cursor?.createdAt ?? null,
      cursor?.id ?? null,
      safeLimit + 1,
    ) as Array<{
    id: string;
    source: string;
    reportId: string | null;
    reportTitle: string;
    memberId: string | null;
    status: string;
    attempts: number;
    errorCode: string | null;
    errorMessage: string | null;
    createdAt: string;
    startedAt: string | null;
    finishedAt: string | null;
    provider: string | null;
    model: string | null;
    promptTokens: number | null;
    completionTokens: number | null;
    elapsedMs: number | null;
    inputCharacters: number | null;
    documentContentType: string | null;
    routedContentTypes: string | null;
  }>;
  const hasMore = rows.length > safeLimit;
  const recent = hasMore ? rows.slice(0, safeLimit) : rows;
  const last = recent.at(-1);
  return {
    summary: {
      jobCount: Number(summary.jobCount || 0),
      callCount: Number(summary.callCount || 0),
      successJobs: Number(summary.successJobs || 0),
      failedJobs: Number(summary.failedJobs || 0),
      queuedJobs: Number(summary.queuedJobs || 0),
      processingJobs: Number(summary.processingJobs || 0),
      promptTokens: Number(summary.promptTokens || 0),
      completionTokens: Number(summary.completionTokens || 0),
      totalTokens:
        Number(summary.promptTokens || 0) +
        Number(summary.completionTokens || 0),
      avgElapsedMs: Math.round(Number(summary.avgElapsedMs || 0)),
    },
    recent,
    hasMore,
    nextCursor:
      hasMore && last
        ? encodeAuditCursor({ createdAt: last.createdAt, id: last.id })
        : null,
  };
}

export function buildMemberExportManifest(user: RequestUser, memberId: string) {
  assertMemberAccess(user, memberId);
  const reports = listReports(user, 50, { memberId }).items.map((report) =>
    getReportDetail(user, report.id),
  );
  return {
    exportedAt: new Date().toISOString(),
    memberId,
    reports: reports.map((report) => ({
      id: report.id,
      title: report.title,
      reportType: report.reportType,
      status: report.status,
      hospitalName: report.hospitalName,
      departmentName: report.departmentName,
      bodyPart: report.bodyPart,
      reportIssuedAt: report.reportIssuedAt,
      pages: report.pages,
      observations: report.observations,
      morphologyFindings: report.morphologyFindings,
      diagnoses: report.diagnoses,
      medications: report.medications,
      procedures: report.procedures,
      vaccinations: report.vaccinations,
      billingSummary: report.billingSummary,
      billingItems: report.billingItems,
      structuredSections: report.structuredSections,
    })),
  };
}

export async function regeneratePdfPagePreviews(user: RequestUser) {
  if (!isAdministrator(user))
    throw createError({
      statusCode: 403,
      statusMessage: "仅管理员可重新生成 PDF 单页图",
    });
  const rows = getDatabase()
    .prepare(
      `
    SELECT p.id AS pageId, p.report_id AS reportId, p.original_name AS originalName,
      p.storage_path AS storagePath, p.source_page_number AS sourcePageNumber,
      p.page_number AS pageNumber, p.rotation
    FROM report_pages p
    JOIN reports r ON r.id = p.report_id
    JOIN member_permissions mp ON mp.member_id = r.member_id AND mp.user_id = ?
    WHERE p.mime_type = 'application/pdf' AND r.status <> 'trashed'
    ORDER BY r.updated_at DESC, p.report_id, p.page_number
    LIMIT 1000
  `,
    )
    .all(user.id) as Array<{
    pageId: string;
    reportId: string;
    originalName: string;
    storagePath: string;
    sourcePageNumber: number | null;
    pageNumber: number;
    rotation: number;
  }>;

  let regenerated = 0;
  let removedLegacy = 0;
  const failures: Array<{ pageId: string; reportId: string; message: string }> =
    [];
  for (const row of rows) {
    const previewPath = storagePath(
      pdfPreviewRelativePath(row.reportId, row.pageId),
    );
    if (existsSync(previewPath)) {
      rmSync(previewPath, { force: true });
      removedLegacy += 1;
    }

    try {
      await requestWorker({
        action: "thumbnail",
        imagePath: storagePath(row.storagePath),
        mimeType: "application/pdf",
        outputPath: previewPath,
        pageNumber: row.sourcePageNumber || row.pageNumber,
        rotation: row.rotation,
        maxSize: pdfPreviewMaxSize,
        quality: pdfPreviewQuality,
        renderScale: pdfPreviewRenderScale,
      });
      if (existsSync(previewPath)) regenerated += 1;
      else
        failures.push({
          pageId: row.pageId,
          reportId: row.reportId,
          message: "预览图未生成",
        });
    } catch (error) {
      failures.push({
        pageId: row.pageId,
        reportId: row.reportId,
        message: error instanceof Error ? error.message : "生成失败",
      });
    }
  }

  getDatabase()
    .prepare(
      `
    INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, detail_json)
    VALUES (?, ?, 'maintenance.regenerate_pdf_previews', 'report_page', NULL, ?)
  `,
    )
    .run(
      createId("audit"),
      user.id,
      JSON.stringify({
        scanned: rows.length,
        regenerated,
        failed: failures.length,
        removedLegacy,
        sample: failures.slice(0, 20),
      }),
    );

  return {
    scanned: rows.length,
    regenerated,
    failed: failures.length,
    removedLegacy,
    failures: failures.slice(0, 20),
  };
}

export function createBackup(user: RequestUser) {
  return createFullBackup(user);
}

export type BackupSummary = {
  id: string;
  filename: string;
  createdAt: string;
  sizeBytes: number;
  appVersion: string;
  schemaVersion: number;
  reportCount: number;
  memberCount: number;
  includes: string[];
  reason: "manual" | "pre_restore";
  fileCount?: number;
};

export type BackupManifestFile = {
  path: string;
  sizeBytes: number;
  sha256: string;
};

type BackupManifest = {
  formatVersion: number;
  id?: string;
  appName?: string;
  appTitle?: string;
  appVersion?: string;
  schemaVersion?: number;
  appliedSchemaVersion?: number;
  createdAt?: string;
  reason?: "manual" | "pre_restore";
  storageLayout?: {
    database?: string;
    directories?: string[];
  };
  counts?: {
    reportCount?: number;
    memberCount?: number;
  };
  files?: BackupManifestFile[];
  notes?: string;
};

export type BackupValidationResult = {
  valid: boolean;
  checksumAvailable: boolean;
  fileCount: number;
  checkedCount: number;
  missingFiles: string[];
  mismatchedFiles: Array<{
    path: string;
    expectedSha256?: string;
    actualSha256?: string;
    expectedSizeBytes?: number;
    actualSizeBytes?: number;
  }>;
  extraFiles: string[];
  warnings: string[];
  errors: string[];
  manifest: {
    id: string | null;
    appName: string | null;
    appTitle: string | null;
    appVersion: string | null;
    schemaVersion: number | null;
    createdAt: string | null;
    reason: string | null;
    reportCount: number | null;
    memberCount: number | null;
  } | null;
};

export type BackupDownload = BackupSummary & {
  path: string;
};

export type CreatedBackup = BackupSummary & {
  path: string;
};

const backupFormatVersion = 1;
const backupIncludedDirectories = [
  "reports",
  "thumbnails",
  "config",
  "secrets",
] as const;

function sqlString(value: string) {
  return `'${value.replaceAll("'", "''")}'`;
}

function timestampForFilename(date = new Date()) {
  const [datePart, timePart = ""] = date.toISOString().split("T");
  const [clock = "", milliseconds = "000Z"] = timePart.split(".");
  return `${datePart.replaceAll("-", "")}-${clock.replaceAll(":", "")}-${milliseconds.replace("Z", "")}`;
}

function assertGatewayAdmin(user: RequestUser, action: string) {
  if (!isAdministrator(user))
    throw createError({
      statusCode: 403,
      statusMessage: `仅管理员可${action}`,
    });
}

function backupDirectory() {
  const directory = join(getAppConfig().storageDir, "backups", "full");
  mkdirSync(directory, { recursive: true });
  return directory;
}

function assertSafeBackupId(id: string) {
  if (!/^backup_[a-f0-9]{32}$/.test(id)) {
    throw createError({ statusCode: 400, statusMessage: "备份 ID 无效" });
  }
}

function backupArchivePath(id: string) {
  assertSafeBackupId(id);
  const directory = backupDirectory();
  const metadata = readBackupMetadata(backupMetadataPath(id));
  if (metadata?.filename) {
    assertSafeBackupFilename(metadata.filename);
    return join(directory, metadata.filename);
  }
  return join(directory, `${id}.tar.gz`);
}

function backupMetadataPath(id: string) {
  assertSafeBackupId(id);
  return join(backupDirectory(), `${id}.metadata.json`);
}

function readBackupMetadata(path: string): BackupSummary | null {
  try {
    const metadata = JSON.parse(readFileSync(path, "utf8")) as BackupSummary;
    return metadata?.id ? metadata : null;
  } catch {
    return null;
  }
}

function assertSafeBackupFilename(filename: string) {
  if (
    basename(filename) !== filename ||
    !/^[a-zA-Z0-9._-]+\.tar\.gz$/.test(filename)
  ) {
    throw createError({ statusCode: 400, statusMessage: "备份文件名无效" });
  }
}

function createBackupArchiveFilename(appName: string, date: Date, id: string) {
  const base = `${appName}-backup-${timestampForFilename(date)}.tar.gz`;
  const archivePath = join(backupDirectory(), base);
  if (!existsSync(archivePath)) return base;
  return `${appName}-backup-${timestampForFilename(date)}-${id.slice(-8)}.tar.gz`;
}

function safeStorageTarget(relativePath: string) {
  const storageRoot = resolve(getAppConfig().storageDir);
  const target = resolve(storageRoot, relativePath);
  if (target !== storageRoot && !target.startsWith(`${storageRoot}/`)) {
    throw createError({ statusCode: 400, statusMessage: "备份路径无效" });
  }
  return target;
}

function copyDirectoryForBackup(
  stagingRoot: string,
  directoryName: (typeof backupIncludedDirectories)[number],
) {
  const source = safeStorageTarget(directoryName);
  const target = join(stagingRoot, directoryName);
  if (existsSync(source)) {
    cpSync(source, target, { recursive: true, force: true });
  } else {
    mkdirSync(target, { recursive: true });
  }
}

function normalizeArchiveRelativePath(path: string) {
  return path.split(sep).join("/");
}

function assertSafeArchiveRelativePath(path: string) {
  if (!path || path.startsWith("/") || path.includes("\0")) return false;
  const normalized = normalizeArchiveRelativePath(path);
  return !normalized.split("/").some((part) => part === "..");
}

function listFilesForChecksum(root: string) {
  const results: string[] = [];
  function walk(directory: string) {
    for (const name of readdirSync(directory).sort()) {
      const absolutePath = join(directory, name);
      const stats = lstatSync(absolutePath);
      if (stats.isSymbolicLink()) continue;
      if (stats.isDirectory()) {
        walk(absolutePath);
        continue;
      }
      if (!stats.isFile()) continue;
      const relativePath = normalizeArchiveRelativePath(
        relative(root, absolutePath),
      );
      if (relativePath === "manifest.json") continue;
      results.push(relativePath);
    }
  }
  walk(root);
  return results.sort();
}

function sha256File(path: string) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function createBackupFileManifest(stagingRoot: string): BackupManifestFile[] {
  return listFilesForChecksum(stagingRoot).map((path) => {
    const absolutePath = join(stagingRoot, path);
    return {
      path,
      sizeBytes: statSync(absolutePath).size,
      sha256: sha256File(absolutePath),
    };
  });
}

function copyDatabaseSnapshot(snapshotPath: string) {
  const db = getDatabase();
  checkpointDatabase();
  mkdirSync(dirname(snapshotPath), { recursive: true });
  try {
    db.exec(`VACUUM INTO ${sqlString(snapshotPath)}`);
  } catch {
    copyFileSync(getDatabasePath(), snapshotPath);
  }
  chmodSync(snapshotPath, 0o600);
}

function createTarArchive(sourceDirectory: string, archivePath: string) {
  execFileSync("tar", ["-czf", archivePath, "-C", sourceDirectory, "."], {
    stdio: "pipe",
  });
  chmodSync(archivePath, 0o600);
}

function extractTarArchive(archivePath: string, targetDirectory: string) {
  mkdirSync(targetDirectory, { recursive: true });
  execFileSync("tar", ["-xzf", archivePath, "-C", targetDirectory], {
    stdio: "pipe",
  });
}

function countBackupSourceRows() {
  const db = getDatabase();
  const reports = db
    .prepare("SELECT COUNT(*) AS count FROM reports WHERE status <> 'trashed'")
    .get() as { count: number };
  const members = db
    .prepare(
      "SELECT COUNT(*) AS count FROM health_members WHERE deleted_at IS NULL",
    )
    .get() as { count: number };
  return { reportCount: reports.count, memberCount: members.count };
}

export function createFullBackup(
  user: RequestUser,
  reason: "manual" | "pre_restore" = "manual",
): CreatedBackup {
  assertGatewayAdmin(user, "创建备份");
  const config = getAppConfig();
  const id = createId("backup");
  const createdDate = new Date();
  const createdAt = createdDate.toISOString();
  const filename = createBackupArchiveFilename(config.appName, createdDate, id);
  const archivePath = join(backupDirectory(), filename);
  const metadataPath = backupMetadataPath(id);
  const stagingRoot = mkdtempSync(join(tmpdir(), "health-records-backup-"));

  try {
    mkdirSync(join(stagingRoot, "db"), { recursive: true });
    const databaseStatus = getDatabaseStatus();
    const counts = countBackupSourceRows();
    copyDatabaseSnapshot(join(stagingRoot, "db", "health-records.sqlite"));
    for (const directoryName of backupIncludedDirectories)
      copyDirectoryForBackup(stagingRoot, directoryName);

    const manifestFiles = createBackupFileManifest(stagingRoot);
    const manifest: BackupManifest = {
      formatVersion: backupFormatVersion,
      id,
      appName: config.appName,
      appTitle: config.appTitle,
      appVersion: config.appVersion,
      schemaVersion: databaseStatus.schemaVersion,
      appliedSchemaVersion: databaseStatus.appliedSchemaVersion,
      createdAt,
      reason,
      storageLayout: {
        database: "db/health-records.sqlite",
        directories: [...backupIncludedDirectories],
      },
      counts,
      files: manifestFiles,
      notes:
        "完整备份包含健康档案数据库、报告原件、分页/缩略图、运行配置和 AI 加密密钥，请仅在可信设备保存。",
    };
    writeFileSync(
      join(stagingRoot, "manifest.json"),
      JSON.stringify(manifest, null, 2),
      { mode: 0o600 },
    );
    createTarArchive(stagingRoot, archivePath);

    const metadata: CreatedBackup = {
      id,
      filename,
      createdAt,
      sizeBytes: statSync(archivePath).size,
      appVersion: config.appVersion,
      schemaVersion:
        databaseStatus.appliedSchemaVersion || databaseStatus.schemaVersion,
      reportCount: counts.reportCount,
      memberCount: counts.memberCount,
      includes: ["数据库", "报告原件", "分页/缩略图", "运行配置", "AI 密钥"],
      reason,
      fileCount: manifestFiles.length,
      path: archivePath,
    };
    writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), {
      mode: 0o600,
    });

    getDatabase()
      .prepare(
        `
      INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, detail_json)
      VALUES (?, ?, 'backup.create', 'backup', ?, ?)
    `,
      )
      .run(
        createId("audit"),
        user.id,
        id,
        JSON.stringify({
          reportCount: metadata.reportCount,
          memberCount: metadata.memberCount,
          sizeBytes: metadata.sizeBytes,
          reason,
        }),
      );
    return metadata;
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true });
  }
}

export function listBackups(user: RequestUser): BackupSummary[] {
  assertGatewayAdmin(user, "查看备份");
  const directory = backupDirectory();
  const results = new Map<string, BackupSummary>();
  const filenames = readdirSync(directory);

  for (const metadataFilename of filenames.filter((name) =>
    /^backup_[a-f0-9]{32}\.metadata\.json$/.test(name),
  )) {
    const id = metadataFilename.replace(/\.metadata\.json$/, "");
    const metadata = readBackupMetadata(join(directory, metadataFilename));
    if (!metadata?.filename) continue;
    assertSafeBackupFilename(metadata.filename);
    const archivePath = join(directory, metadata.filename);
    if (!existsSync(archivePath)) continue;
    const archiveStat = statSync(archivePath);
    results.set(id, {
      ...metadata,
      sizeBytes: archiveStat.size,
    });
  }

  for (const filename of filenames.filter((name) =>
    /^backup_[a-f0-9]{32}\.tar\.gz$/.test(name),
  )) {
    const id = filename.replace(/\.tar\.gz$/, "");
    if (results.has(id)) continue;
    const archivePath = join(directory, filename);
    const archiveStat = statSync(archivePath);
    const metadata = readBackupMetadata(backupMetadataPath(id));
    results.set(id, {
      id,
      filename,
      createdAt: metadata?.createdAt || archiveStat.birthtime.toISOString(),
      sizeBytes: archiveStat.size,
      appVersion: metadata?.appVersion || "未知",
      schemaVersion: metadata?.schemaVersion || 0,
      reportCount: metadata?.reportCount || 0,
      memberCount: metadata?.memberCount || 0,
      includes: metadata?.includes || ["数据库", "报告原件"],
      reason: metadata?.reason || "manual",
    });
  }

  return [...results.values()].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  );
}

export function getBackupDownload(
  user: RequestUser,
  id: string,
): BackupDownload {
  assertGatewayAdmin(user, "下载备份");
  const archivePath = backupArchivePath(id);
  if (!existsSync(archivePath))
    throw createError({ statusCode: 404, statusMessage: "备份不存在" });
  const metadata = listBackups(user).find((item) => item.id === id) || {
    id,
    filename: basename(archivePath),
    createdAt: statSync(archivePath).birthtime.toISOString(),
    sizeBytes: statSync(archivePath).size,
    appVersion: "未知",
    schemaVersion: 0,
    reportCount: 0,
    memberCount: 0,
    includes: ["数据库", "报告原件"],
    reason: "manual" as const,
  };
  return { ...metadata, path: archivePath };
}

export function deleteBackup(user: RequestUser, id: string) {
  assertGatewayAdmin(user, "删除备份");
  const backup = getBackupDownload(user, id);
  const metadataPath = backupMetadataPath(id);
  rmSync(backup.path, { force: true });
  rmSync(metadataPath, { force: true });
  getDatabase()
    .prepare(
      `
    INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, detail_json)
    VALUES (?, ?, 'backup.delete', 'backup', ?, ?)
  `,
    )
    .run(
      createId("audit"),
      user.id,
      id,
      JSON.stringify({
        filename: backup.filename,
        sizeBytes: backup.sizeBytes,
        reason: backup.reason,
      }),
    );
  return { id, deleted: true };
}

function emptyBackupValidationResult(): BackupValidationResult {
  return {
    valid: false,
    checksumAvailable: false,
    fileCount: 0,
    checkedCount: 0,
    missingFiles: [],
    mismatchedFiles: [],
    extraFiles: [],
    warnings: [],
    errors: [],
    manifest: null,
  };
}

function manifestSummary(
  manifest: BackupManifest,
): BackupValidationResult["manifest"] {
  return {
    id: manifest.id || null,
    appName: manifest.appName || null,
    appTitle: manifest.appTitle || null,
    appVersion: manifest.appVersion || null,
    schemaVersion:
      manifest.appliedSchemaVersion || manifest.schemaVersion || null,
    createdAt: manifest.createdAt || null,
    reason: manifest.reason || null,
    reportCount: manifest.counts?.reportCount ?? null,
    memberCount: manifest.counts?.memberCount ?? null,
  };
}

function readExtractedBackupManifest(extractRoot: string): {
  manifest?: BackupManifest;
  result: BackupValidationResult;
} {
  const manifestPath = join(extractRoot, "manifest.json");
  const result = emptyBackupValidationResult();
  if (!existsSync(manifestPath)) {
    result.errors.push("备份清单缺失");
    return { result };
  }
  try {
    const manifest = JSON.parse(
      readFileSync(manifestPath, "utf8"),
    ) as BackupManifest;
    result.manifest = manifestSummary(manifest);
    return { manifest, result };
  } catch {
    result.errors.push("备份清单损坏");
    return { result };
  }
}

function validateBackupDatabase(
  databasePath: string,
  manifest: BackupManifest,
  result: BackupValidationResult,
) {
  let database: DatabaseSync | null = null;
  try {
    database = new DatabaseSync(databasePath, { readOnly: true });
    const quickCheck = database.prepare("PRAGMA quick_check").get() as
      { quick_check?: string } | undefined;
    if (quickCheck?.quick_check !== "ok")
      result.errors.push("备份数据库完整性检查未通过");

    const foreignKeyErrors = database.prepare("PRAGMA foreign_key_check").all();
    if (foreignKeyErrors.length) {
      result.errors.push(
        `备份数据库存在 ${foreignKeyErrors.length} 条外键不一致`,
      );
    }

    const tables = new Set(
      (
        database
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
          .all() as Array<{ name: string }>
      ).map((row) => row.name),
    );
    for (const required of [
      "users",
      "health_members",
      "reports",
      "report_pages",
    ]) {
      if (!tables.has(required))
        result.errors.push(`备份数据库缺少核心表：${required}`);
    }

    let actualSchemaVersion = 0;
    if (tables.has("schema_migrations")) {
      const versions = (
        database
          .prepare("SELECT version FROM schema_migrations ORDER BY version")
          .all() as Array<{ version: number }>
      ).map((row) => Number(row.version));
      actualSchemaVersion = versions.at(-1) || 0;
      if (actualSchemaVersion <= schemaVersion) {
        const versionSet = new Set(versions);
        const missingVersion = Array.from(
          { length: actualSchemaVersion },
          (_, index) => index + 1,
        ).find((version) => !versionSet.has(version));
        if (missingVersion)
          result.errors.push(
            `备份数据库迁移记录不连续，缺少 v${missingVersion}`,
          );
      }
    } else if (tables.has("reports")) {
      actualSchemaVersion = 1;
    }

    if (actualSchemaVersion < 1) result.errors.push("无法识别备份数据库版本");
    if (actualSchemaVersion > schemaVersion) {
      result.errors.push(
        `备份数据库版本 v${actualSchemaVersion} 高于当前应用支持的 v${schemaVersion}`,
      );
    }
    const declaredSchemaVersion = Number(
      manifest.appliedSchemaVersion || manifest.schemaVersion || 0,
    );
    if (declaredSchemaVersion > schemaVersion) {
      result.errors.push(
        `备份清单要求数据库 v${declaredSchemaVersion}，当前应用仅支持到 v${schemaVersion}`,
      );
    }
    if (
      declaredSchemaVersion > 0 &&
      actualSchemaVersion > 0 &&
      declaredSchemaVersion !== actualSchemaVersion
    ) {
      result.errors.push(
        `备份清单数据库版本 v${declaredSchemaVersion} 与实际 v${actualSchemaVersion} 不一致`,
      );
    }
  } catch (error) {
    result.errors.push(
      `备份数据库无法读取：${error instanceof Error ? error.message : "未知错误"}`,
    );
  } finally {
    database?.close();
  }
}

function validateExtractedBackup(extractRoot: string): BackupValidationResult {
  const { manifest, result } = readExtractedBackupManifest(extractRoot);
  const databasePath = join(extractRoot, "db", "health-records.sqlite");
  if (!manifest) return result;
  if (manifest.appName !== getAppConfig().appName) {
    result.errors.push("备份不属于当前应用");
  }
  if (manifest.formatVersion !== backupFormatVersion) {
    result.errors.push("备份格式版本不兼容");
  }
  if (!existsSync(databasePath)) {
    result.errors.push("备份数据库缺失");
  } else {
    validateBackupDatabase(databasePath, manifest, result);
  }
  if (!Array.isArray(manifest.files)) {
    result.warnings.push("旧备份没有文件校验清单，仅完成基础兼容性校验");
    result.valid = result.errors.length === 0;
    return result;
  }

  result.checksumAvailable = true;
  result.fileCount = manifest.files.length;
  const expectedPaths = new Set<string>();
  for (const file of manifest.files) {
    if (!file || !assertSafeArchiveRelativePath(file.path)) {
      result.errors.push(`备份清单包含非法路径：${file?.path || "空路径"}`);
      continue;
    }
    expectedPaths.add(file.path);
    const target = join(extractRoot, file.path);
    if (!existsSync(target)) {
      result.missingFiles.push(file.path);
      continue;
    }
    const stats = lstatSync(target);
    if (!stats.isFile()) {
      result.mismatchedFiles.push({
        path: file.path,
        expectedSha256: file.sha256,
        expectedSizeBytes: file.sizeBytes,
      });
      continue;
    }
    const actualSha256 = sha256File(target);
    result.checkedCount += 1;
    if (stats.size !== file.sizeBytes || actualSha256 !== file.sha256) {
      result.mismatchedFiles.push({
        path: file.path,
        expectedSha256: file.sha256,
        actualSha256,
        expectedSizeBytes: file.sizeBytes,
        actualSizeBytes: stats.size,
      });
    }
  }
  for (const actualPath of listFilesForChecksum(extractRoot)) {
    if (!expectedPaths.has(actualPath)) result.extraFiles.push(actualPath);
  }
  if (result.extraFiles.length) {
    result.errors.push(`备份包包含 ${result.extraFiles.length} 个未登记文件`);
  }
  if (result.missingFiles.length) {
    result.errors.push(`备份包缺失 ${result.missingFiles.length} 个文件`);
  }
  if (result.mismatchedFiles.length) {
    result.errors.push(
      `备份包有 ${result.mismatchedFiles.length} 个文件校验不一致`,
    );
  }
  result.valid = result.errors.length === 0;
  return result;
}

function ensureBackupValidationPassed(result: BackupValidationResult) {
  if (result.valid) return;
  throw createError({
    statusCode: 400,
    statusMessage: result.errors[0]
      ? `备份校验失败：${result.errors[0]}`
      : "备份校验失败，无法恢复",
  });
}

function validateBackupArchivePath(
  archivePath: string,
): BackupValidationResult {
  if (!existsSync(archivePath)) {
    return { ...emptyBackupValidationResult(), errors: ["备份不存在"] };
  }
  const extractRoot = mkdtempSync(
    join(tmpdir(), "health-records-backup-check-"),
  );
  try {
    extractTarArchive(archivePath, extractRoot);
    return validateExtractedBackup(extractRoot);
  } catch (error) {
    const result = emptyBackupValidationResult();
    result.errors.push(
      error instanceof Error
        ? `备份包无法解压：${error.message}`
        : "备份包无法解压",
    );
    return result;
  } finally {
    rmSync(extractRoot, { recursive: true, force: true });
  }
}

export function validateBackup(
  user: RequestUser,
  id: string,
): BackupValidationResult {
  assertGatewayAdmin(user, "校验备份");
  const archivePath = backupArchivePath(id);
  return validateBackupArchivePath(archivePath);
}

function replaceStorageDirectory(
  directoryName: (typeof backupIncludedDirectories)[number],
  extractRoot: string,
) {
  const source = join(extractRoot, directoryName);
  const target = safeStorageTarget(directoryName);
  rmSync(target, { recursive: true, force: true });
  if (existsSync(source)) {
    cpSync(source, target, { recursive: true, force: true });
  } else {
    mkdirSync(target, { recursive: true });
  }
}

function replaceDatabaseFromBackup(extractRoot: string) {
  const targetDatabase = getDatabasePath();
  const safetyDirectory = safeStorageTarget(join("backups", "restore-safety"));
  mkdirSync(safetyDirectory, { recursive: true });
  for (const suffix of ["", "-wal", "-shm"]) {
    const target = `${targetDatabase}${suffix}`;
    if (existsSync(target)) {
      renameSync(
        target,
        join(
          safetyDirectory,
          `restore-current-${timestampForFilename()}${suffix || ".sqlite"}`,
        ),
      );
    }
  }
  mkdirSync(dirname(targetDatabase), { recursive: true });
  copyFileSync(
    join(extractRoot, "db", "health-records.sqlite"),
    targetDatabase,
  );
  chmodSync(targetDatabase, 0o600);
}

function insertRestoreAudit(
  actorUserId: string,
  backupId: string,
  safetyBackupId: string,
) {
  const db = getDatabase();
  const actor = db
    .prepare("SELECT id FROM users WHERE id = ?")
    .get(actorUserId) as { id: string } | undefined;
  db.prepare(
    `
    INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, detail_json)
    VALUES (?, ?, 'backup.restore', 'backup', ?, ?)
  `,
  ).run(
    createId("audit"),
    actor?.id || null,
    backupId,
    JSON.stringify({ safetyBackupId }),
  );
}

function restoreBackupFromArchive(
  user: RequestUser,
  archivePath: string,
  backupId: string,
) {
  assertGatewayAdmin(user, "恢复备份");
  if (!existsSync(archivePath))
    throw createError({ statusCode: 404, statusMessage: "备份不存在" });
  const runnerStatus = getJobRunnerStatus();
  if (runnerStatus.busy) {
    throw createError({
      statusCode: 409,
      statusMessage: "后台识别任务正在执行，请稍后再恢复备份",
    });
  }
  const extractRoot = mkdtempSync(join(tmpdir(), "health-records-restore-"));
  let shouldRestartRunner = false;
  const localCredential = captureRestoringAdministratorCredential(user);

  try {
    extractTarArchive(archivePath, extractRoot);
    const validation = validateExtractedBackup(extractRoot);
    ensureBackupValidationPassed(validation);
    shouldRestartRunner = runnerStatus.started;
    stopJobRunner();
    const safetyBackup = createFullBackup(user, "pre_restore");
    closeDatabase();
    for (const directoryName of backupIncludedDirectories)
      replaceStorageDirectory(directoryName, extractRoot);
    replaceDatabaseFromBackup(extractRoot);
    getDatabase();
    const identityRebind = rebindRestoredAdministrator(user, localCredential);
    insertRestoreAudit(user.id, backupId, safetyBackup.id);
    return {
      restored: true,
      backupId,
      safetyBackupId: safetyBackup.id,
      identityRebind,
      validation,
    };
  } finally {
    rmSync(extractRoot, { recursive: true, force: true });
    if (shouldRestartRunner) startJobRunner();
  }
}

export function restoreBackup(user: RequestUser, id: string) {
  const archivePath = backupArchivePath(id);
  return restoreBackupFromArchive(user, archivePath, id);
}

export function restoreUploadedBackup(user: RequestUser, archivePath: string) {
  const validation = validateBackupArchivePath(archivePath);
  ensureBackupValidationPassed(validation);
  const manifestId =
    validation.manifest?.id &&
    /^backup_[a-f0-9]{32}$/.test(validation.manifest.id)
      ? validation.manifest.id
      : createId("backup");
  return restoreBackupFromArchive(user, archivePath, manifestId);
}
