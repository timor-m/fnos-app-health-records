import { getDatabase } from "../database/client";
import { loadProcessingBatchForJob } from "./processing-job-batches.service";

export type ProcessingDiagnosticStage =
  | "local_processing"
  | "ocr"
  | "ai_planning"
  | "ai_call"
  | "supplement"
  | "post_processing"
  | "completed";

export type ProcessingDiagnosticOutcome = "running" | "success" | "warning" | "failed" | "empty";

export type ProcessingDiagnosticReasonCode =
  | "OCR_RUNTIME_UNAVAILABLE"
  | "OCR_FAILED"
  | "OCR_EMPTY"
  | "OCR_LOW_QUALITY"
  | "AI_CALL_FAILED"
  | "AI_INVALID_OUTPUT"
  | "AI_TRUNCATED_OUTPUT"
  | "AI_PARTIAL_RESULT"
  | "TABLE_STRUCTURE_UNRELIABLE"
  | "SUPPLEMENT_REQUIRED"
  | "SUPPLEMENT_UNRESOLVED"
  | "POSTPROCESS_REDUNDANT"
  | "POSTPROCESS_IGNORED"
  | "POSTPROCESS_UNVERIFIED";

export type ProcessingDiagnosticReason = {
  code: ProcessingDiagnosticReasonCode;
  severity: "info" | "warning" | "error";
  message: string;
  pages: number[];
};

export type ProcessingDiagnosticReviewItem = {
  id: string;
  issueType: "ocr_content" | "ai_missing" | "layout_ambiguity" | "evidence_rejected";
  severity: "warning" | "error";
  title: string;
  description: string;
  pages: number[];
  candidateKind: "scalar" | "morphology" | null;
  sourceLineIds: string[];
  resultSummary: string;
  reason: string;
};

export type ProcessingJobDiagnostics = {
  stage: ProcessingDiagnosticStage;
  outcome: ProcessingDiagnosticOutcome;
  headline: string;
  reasons: ProcessingDiagnosticReason[];
  reviewItems: ProcessingDiagnosticReviewItem[];
  metrics: {
    pageCount: number;
    ocrCompletedPages: number;
    ocrEmptyPages: number;
    ocrWeakPages: number;
    ocrFailedPages: number;
    plannedUnits: number;
    completedUnits: number;
    warningUnits: number;
    failedUnits: number;
    supplementUnits: number;
    supplementPages: number[];
    inputCharacters: number;
    candidateCount: number;
    matchedCount: number;
    resolvedCandidateCount: number;
    candidateClosurePercent: number;
    localExtractedCount: number;
    aiExtractedCount: number;
    redundantCount: number;
    ignoredCount: number;
    unresolvedCount: number;
    persistedObservationCount: number;
    trendReadyObservationCount: number;
    trendSeriesCount: number;
    aiRequestCount: number;
    aiFailureCount: number;
    postprocessRejectedCount: number;
    rejectedObservations: number;
    rejectedMorphologyFindings: number;
    rejectedClinicalFacts: number;
    rejectedStructuredSections: number;
  };
  supplement: {
    required: boolean;
    pages: number[];
    reason: string | null;
  };
};

type DiagnosticJob = {
  id: string;
  reportId: string;
  jobType: "pdf_extract" | "thumbnail" | "ocr" | "ai_extract";
  status: string;
  errorCode: string | null;
  errorMessage: string | null;
};

type DiagnosticEvent = {
  detail?: Record<string, unknown>;
};

export type DiagnosticAiUnit = {
  unitKey?: string;
  unitIndex?: number;
  unitType: "complete_pages" | "page_chunk" | "supplement";
  pageNumbers: number[];
  status: "planned" | "processing" | "completed" | "warning" | "failed";
  characterCount: number;
  candidateCount: number;
  matchedCount: number;
};

type OcrDiagnosticRow = {
  id: string;
  status: string;
  pageNumber: number | null;
  textLength: number | null;
  qualityLevel: "good" | "weak" | "poor" | null;
};

type CandidateDiagnosticRow = {
  id: string;
  status: "local_extracted" | "ai_extracted" | "redundant" | "ignored" | "unresolved";
  pageNumber: number;
  sourceLineIdsJson: string;
  kind: "scalar" | "morphology";
  matchedEntityKey: string | null;
  reason: string | null;
};

type AttemptDiagnosticRow = {
  status: "completed" | "failed";
  errorCode: string | null;
};

function uniquePages(values: Array<number | null | undefined>) {
  return [...new Set(values.filter((value): value is number => typeof value === "number" && Number.isFinite(value)))]
    .sort((left, right) => left - right);
}

function parseStringArray(value: string | null | undefined) {
  try {
    const parsed = JSON.parse(value || "[]") as unknown;
    return Array.isArray(parsed)
      ? [...new Set(parsed.filter((item): item is string => typeof item === "string" && Boolean(item.trim())))]
      : [];
  } catch {
    return [];
  }
}

function candidateReasonText(value: string | null) {
  if (!value) return "候选没有形成可验证的结构化结果";
  const separator = value.indexOf(":");
  return separator >= 0 ? value.slice(separator + 1).trim() || value : value;
}

function queryOcrRows(job: DiagnosticJob) {
  const db = getDatabase();
  const { batchJobs } = loadProcessingBatchForJob(job.reportId, job.id);
  const batchOcrIds = batchJobs.filter((item) => item.jobType === "ocr").map((item) => item.id);
  if (batchOcrIds.length) {
    const placeholders = batchOcrIds.map(() => "?").join(", ");
    return db.prepare(`
      SELECT j.id, j.status, p.page_number AS pageNumber,
        o.text_length AS textLength, o.quality_level AS qualityLevel
      FROM processing_jobs j
      LEFT JOIN report_pages p ON p.id = j.page_id
      LEFT JOIN ocr_results o ON o.job_id = j.id
      WHERE j.id IN (${placeholders})
      ORDER BY p.page_number, j.created_at, j.rowid
    `).all(...batchOcrIds) as OcrDiagnosticRow[];
  }
  const rows = db.prepare(`
    SELECT j.id, j.status, p.page_number AS pageNumber,
      o.text_length AS textLength, o.quality_level AS qualityLevel
    FROM ocr_results o
    JOIN processing_jobs j ON j.id = o.job_id
    JOIN report_pages p ON p.id = o.page_id
    WHERE p.report_id = ? AND j.status = 'completed'
    ORDER BY p.page_number, COALESCE(j.finished_at, j.created_at) DESC,
      j.created_at DESC, j.rowid DESC
  `).all(job.reportId) as OcrDiagnosticRow[];
  const seenPages = new Set<number>();
  return rows.filter((row) => {
    if (row.pageNumber == null || seenPages.has(row.pageNumber)) return false;
    seenPages.add(row.pageNumber);
    return true;
  });
}

function persistedObservationCount(jobId: string) {
  const row = getDatabase().prepare(`
    SELECT fields_json AS fieldsJson FROM report_extractions WHERE job_id = ?
  `).get(jobId) as { fieldsJson: string } | undefined;
  if (!row) return 0;
  try {
    const fields = JSON.parse(row.fieldsJson) as { observations?: unknown };
    return Array.isArray(fields.observations) ? fields.observations.length : 0;
  } catch {
    return 0;
  }
}

/*
 * 表格结构增强诊断（OCR worker 的 tableDiagnostics 挂在 lines_json 首行）。
 * 只在失败/不完整时返回页码；未安装表格模块（无诊断字段）时不返回，不制造噪音。
 */
function queryUnreliableTablePages(reportId: string) {
  const rows = getDatabase().prepare(`
    SELECT p.page_number AS pageNumber, o.lines_json AS linesJson
    FROM ocr_results o
    JOIN processing_jobs j ON j.id = o.job_id
    JOIN report_pages p ON p.id = o.page_id
    WHERE p.report_id = ? AND j.status = 'completed'
    ORDER BY p.page_number, COALESCE(j.finished_at, j.created_at) DESC,
      j.created_at DESC, j.rowid DESC
  `).all(reportId) as Array<{ pageNumber: number | null; linesJson: string }>;
  const seenPages = new Set<number>();
  const unreliable: number[] = [];
  for (const row of rows) {
    if (row.pageNumber == null || seenPages.has(row.pageNumber)) continue;
    seenPages.add(row.pageNumber);
    try {
      const lines = JSON.parse(row.linesJson || "[]") as unknown;
      if (!Array.isArray(lines) || !lines.length) continue;
      const diagnostics = (lines[0] as { tableDiagnostics?: unknown })
        ?.tableDiagnostics;
      if (!diagnostics || typeof diagnostics !== "object") continue;
      const { status, mapped, unsafe } = diagnostics as {
        status?: unknown;
        mapped?: unknown;
        unsafe?: unknown;
      };
      const mappedCount = Number(mapped) || 0;
      const unsafeCount = Number(unsafe) || 0;
      const failed =
        status === "failed" ||
        status === "no_structure" ||
        (status === "partial" && unsafeCount > mappedCount);
      if (failed) unreliable.push(row.pageNumber);
    } catch {
      // 单页解析失败不影响其他页
    }
  }
  return unreliable;
}

function trendOutputMetrics(reportId: string, enabled: boolean) {
  if (!enabled) return { trendReadyObservationCount: 0, trendSeriesCount: 0 };
  return getDatabase().prepare(`
    SELECT COUNT(*) AS trendReadyObservationCount,
      COUNT(DISTINCT n.canonical_key || char(0) || COALESCE(n.canonical_unit, '')) AS trendSeriesCount
    FROM observations o
    JOIN observation_normalizations n ON n.observation_id = o.id
    WHERE o.report_id = ?
      AND n.quality IN ('high', 'medium')
      AND n.canonical_key IS NOT NULL
      AND n.canonical_name IS NOT NULL
      AND COALESCE(n.canonical_value, o.numeric_value) IS NOT NULL
  `).get(reportId) as { trendReadyObservationCount: number; trendSeriesCount: number };
}

function addReason(
  reasons: ProcessingDiagnosticReason[],
  code: ProcessingDiagnosticReasonCode,
  severity: ProcessingDiagnosticReason["severity"],
  message: string,
  pages: number[] = []
) {
  if (reasons.some((reason) => reason.code === code)) return;
  reasons.push({ code, severity, message, pages: uniquePages(pages) });
}

function failureReasonCode(code: string | null) {
  if (!code) return "AI_CALL_FAILED" as const;
  if (["AI_INVALID_JSON", "AI_EMPTY_RESPONSE", "AI_EMPTY_RESULT"].includes(code)) return "AI_INVALID_OUTPUT" as const;
  if (code === "AI_OUTPUT_TRUNCATED") return "AI_TRUNCATED_OUTPUT" as const;
  return "AI_CALL_FAILED" as const;
}

function diagnosticStage(job: DiagnosticJob, units: DiagnosticAiUnit[]): ProcessingDiagnosticStage {
  if (job.jobType === "ocr") return "ocr";
  if (job.jobType !== "ai_extract") return job.status === "completed" ? "completed" : "local_processing";
  if (job.status === "queued" || (!units.length && job.status === "processing")) return "ai_planning";
  if (units.some((unit) => unit.unitType === "supplement" && ["planned", "processing"].includes(unit.status))) {
    return "supplement";
  }
  if (job.status === "processing" || job.status === "failed") return "ai_call";
  if (units.some((unit) => unit.status === "warning" || unit.status === "failed")) return "post_processing";
  return "completed";
}

function stageHeadline(stage: ProcessingDiagnosticStage) {
  return {
    local_processing: "正在处理报告文件",
    ocr: "正在识别页面文字",
    ai_planning: "正在生成 AI 解析计划",
    ai_call: "正在执行 AI 解析单元",
    supplement: "正在补提取主解析遗漏的候选内容",
    post_processing: "正在校验并清理 AI 结果",
    completed: "处理已完成"
  }[stage];
}

export function buildProcessingJobDiagnostics(
  job: DiagnosticJob,
  events: DiagnosticEvent[],
  units: DiagnosticAiUnit[] = []
): ProcessingJobDiagnostics {
  const db = getDatabase();
  const pageCount = (db.prepare("SELECT COUNT(*) AS count FROM report_pages WHERE report_id = ?")
    .get(job.reportId) as { count: number }).count;
  const ocrRows = queryOcrRows(job);
  const ocrCompleted = ocrRows.filter((row) => row.status === "completed");
  const ocrEmptyRows = ocrCompleted.filter((row) => row.textLength != null && row.textLength < 1);
  const ocrWeakRows = ocrCompleted.filter((row) =>
    (row.qualityLevel === "weak" || row.qualityLevel === "poor")
    && !(row.textLength != null && row.textLength < 1)
  );
  const ocrFailedRows = ocrRows.filter((row) => row.status === "failed");

  const attemptRows = job.jobType === "ai_extract"
    ? db.prepare(`
        SELECT status, error_code AS errorCode
        FROM ai_extraction_attempts WHERE job_id = ? ORDER BY created_at, rowid
      `).all(job.id) as AttemptDiagnosticRow[]
    : [];
  const candidateRows = job.jobType === "ai_extract"
    ? db.prepare(`
        SELECT id, status, page_number AS pageNumber,
          source_line_ids_json AS sourceLineIdsJson, kind,
          matched_entity_key AS matchedEntityKey, reason
        FROM ai_extraction_candidates WHERE job_id = ? ORDER BY page_number, id
      `).all(job.id) as CandidateDiagnosticRow[]
    : [];

  const countCandidateStatus = (status: CandidateDiagnosticRow["status"]) =>
    candidateRows.filter((candidate) => candidate.status === status).length;
  const localExtractedCount = countCandidateStatus("local_extracted");
  const aiExtractedCount = countCandidateStatus("ai_extracted");
  const redundantCount = countCandidateStatus("redundant");
  const ignoredCount = countCandidateStatus("ignored");
  const unresolvedRows = candidateRows.filter((candidate) => candidate.status === "unresolved");
  const unresolvedCount = unresolvedRows.length;
  const supplementUnresolvedRows = unresolvedRows.filter((candidate) =>
    candidate.reason?.startsWith("supplement_required:")
  );
  const matchedCountFromRows = localExtractedCount + aiExtractedCount + redundantCount;
  const mainUnits = units.filter((unit) => unit.unitType !== "supplement");
  const plannedCandidateCount = mainUnits.reduce((sum, unit) => sum + Math.max(0, unit.candidateCount || 0), 0);
  const plannedMatchedCount = mainUnits.reduce((sum, unit) => sum + Math.max(0, unit.matchedCount || 0), 0);
  const candidateCount = candidateRows.length || plannedCandidateCount;
  const matchedCount = candidateRows.length ? matchedCountFromRows : plannedMatchedCount;
  const resolvedCandidateCount = candidateRows.length
    ? localExtractedCount + aiExtractedCount + redundantCount + ignoredCount
    : plannedMatchedCount;
  const candidateClosurePercent = candidateCount > 0
    ? Math.round(Math.min(candidateCount, resolvedCandidateCount) / candidateCount * 100)
    : job.status === "completed" ? 100 : 0;
  const supplementUnits = units.filter((unit) => unit.unitType === "supplement");
  const supplementPages = uniquePages(supplementUnits.flatMap((unit) => unit.pageNumbers));
  const unresolvedPages = uniquePages(candidateRows
    .filter((candidate) => candidate.status === "unresolved")
    .map((candidate) => candidate.pageNumber));

  const rejected = events.reduce((total, event) => {
    const detail = event.detail || {};
    total.observations += typeof detail.rejectedObservations === "number" ? detail.rejectedObservations : 0;
    total.morphology += typeof detail.rejectedMorphologyFindings === "number" ? detail.rejectedMorphologyFindings : 0;
    total.clinicalFacts += typeof detail.rejectedClinicalFacts === "number" ? detail.rejectedClinicalFacts : 0;
    total.structuredSections += typeof detail.rejectedStructuredSections === "number" ? detail.rejectedStructuredSections : 0;
    return total;
  }, { observations: 0, morphology: 0, clinicalFacts: 0, structuredSections: 0 });
  const postprocessRejectedCount = rejected.observations + rejected.morphology
    + rejected.clinicalFacts + rejected.structuredSections;
  const persistedCount = job.jobType === "ai_extract" ? persistedObservationCount(job.id) : 0;
  const trendMetrics = trendOutputMetrics(
    job.reportId,
    job.jobType === "ai_extract" && job.status === "completed" && persistedCount > 0
  );

  const metrics: ProcessingJobDiagnostics["metrics"] = {
    pageCount,
    ocrCompletedPages: uniquePages(ocrCompleted.map((row) => row.pageNumber)).length,
    ocrEmptyPages: uniquePages(ocrEmptyRows.map((row) => row.pageNumber)).length,
    ocrWeakPages: uniquePages(ocrWeakRows.map((row) => row.pageNumber)).length,
    ocrFailedPages: uniquePages(ocrFailedRows.map((row) => row.pageNumber)).length,
    plannedUnits: units.length,
    completedUnits: units.filter((unit) => unit.status === "completed").length,
    warningUnits: units.filter((unit) => unit.status === "warning").length,
    failedUnits: units.filter((unit) => unit.status === "failed").length,
    supplementUnits: supplementUnits.length,
    supplementPages,
    inputCharacters: units.reduce((sum, unit) => sum + Math.max(0, unit.characterCount || 0), 0),
    candidateCount,
    matchedCount,
    resolvedCandidateCount,
    candidateClosurePercent,
    localExtractedCount,
    aiExtractedCount,
    redundantCount,
    ignoredCount,
    unresolvedCount,
    persistedObservationCount: persistedCount,
    trendReadyObservationCount: trendMetrics.trendReadyObservationCount,
    trendSeriesCount: trendMetrics.trendSeriesCount,
    aiRequestCount: attemptRows.length,
    aiFailureCount: attemptRows.filter((attempt) => attempt.status === "failed").length,
    postprocessRejectedCount,
    rejectedObservations: rejected.observations,
    rejectedMorphologyFindings: rejected.morphology,
    rejectedClinicalFacts: rejected.clinicalFacts,
    rejectedStructuredSections: rejected.structuredSections
  };

  const reasons: ProcessingDiagnosticReason[] = [];
  if (job.jobType === "ocr") {
    const pages = uniquePages(ocrRows.map((row) => row.pageNumber));
    if (job.status === "failed") {
      const runtimeUnavailable = Boolean(job.errorCode?.startsWith("OCR_WORKER_") || job.errorCode === "OCR_RUNTIME_UNAVAILABLE");
      addReason(
        reasons,
        runtimeUnavailable ? "OCR_RUNTIME_UNAVAILABLE" : "OCR_FAILED",
        "error",
        runtimeUnavailable ? "OCR 运行环境不可用，页面文字识别未完成" : "OCR 页面处理失败，未生成可用文字结果",
        pages
      );
    }
  }
  if (job.jobType === "ocr" || job.jobType === "ai_extract") {
    if (ocrEmptyRows.length) {
      addReason(reasons, "OCR_EMPTY", "warning", "OCR 已完成，但部分页面没有识别到有效文字", uniquePages(ocrEmptyRows.map((row) => row.pageNumber)));
    }
    if (ocrWeakRows.length) {
      addReason(reasons, "OCR_LOW_QUALITY", "warning", "部分页面 OCR 文字较少或置信度偏低，可能影响后续提取", uniquePages(ocrWeakRows.map((row) => row.pageNumber)));
    }
    if (job.jobType === "ai_extract" && ocrFailedRows.length) {
      addReason(reasons, "OCR_FAILED", "warning", "同一处理批次中存在 OCR 失败页面，AI 输入可能不完整", uniquePages(ocrFailedRows.map((row) => row.pageNumber)));
    }
  }

  if (job.jobType === "ai_extract") {
    for (const attempt of attemptRows.filter((item) => item.status === "failed")) {
      const code = failureReasonCode(attempt.errorCode);
      const recovered = job.status === "completed";
      const message = code === "AI_INVALID_OUTPUT"
        ? "AI 曾返回空内容或非标准 JSON，系统已记录格式异常"
        : code === "AI_TRUNCATED_OUTPUT"
          ? "AI 输出曾达到长度上限，系统已扩大预算或拆分单元重试"
          : "AI 调用曾失败，系统已记录调用异常";
      addReason(reasons, code, recovered ? "info" : "error", message);
    }
    if (job.status === "failed" && !attemptRows.some((attempt) => attempt.status === "failed")) {
      const code = failureReasonCode(job.errorCode);
      addReason(reasons, code, "error", code === "AI_INVALID_OUTPUT"
        ? "AI 最终输出为空或不符合标准 JSON 结构"
        : code === "AI_TRUNCATED_OUTPUT"
          ? "AI 输出达到长度上限，拆分重试后仍未完成"
          : "AI 任务未完成，请查看失败单元和错误码");
    }
    if (supplementUnits.length) {
      addReason(
        reasons,
        "SUPPLEMENT_REQUIRED",
        "info",
        "主解析结果未覆盖全部测量候选，因此按遗漏所在页追加了补提取单元",
        supplementPages
      );
    }
    if (supplementUnits.some((unit) => unit.status === "warning" || unit.status === "failed") || supplementUnresolvedRows.length > 0) {
      const count = supplementUnresolvedRows.length || 1;
      const pages = uniquePages(supplementUnresolvedRows.map((candidate) => candidate.pageNumber));
      addReason(
        reasons,
        "SUPPLEMENT_UNRESOLVED",
        "warning",
        `补提取后仍有 ${count} 项候选无法与可验证结果匹配`,
        pages.length ? pages : supplementPages
      );
    }
    if (postprocessRejectedCount > 0) {
      addReason(reasons, "AI_PARTIAL_RESULT", "warning", `后处理基于原文证据拒绝了 ${postprocessRejectedCount} 项不可靠结果`);
    }
    /* 表格结构模型失败的页本身不是错（启发式重建通常够用），只在页上确有指标候选时
       提示"结构不可靠"，且仅出现在诊断抽屉，不进报告页提示，避免正常报告被打扰。 */
    const unreliableTablePages = queryUnreliableTablePages(job.reportId).filter((page) =>
      candidateRows.some((candidate) => candidate.pageNumber === page && candidate.kind === "scalar")
    );
    if (unreliableTablePages.length) {
      addReason(
        reasons,
        "TABLE_STRUCTURE_UNRELIABLE",
        "warning",
        "表格结构模型未能完整识别这些页的行列，指标行由文字位置重建，可能存在错列或缺行",
        unreliableTablePages
      );
    }
    if (redundantCount > 0) {
      addReason(reasons, "POSTPROCESS_REDUNDANT", "info", `${redundantCount} 项重复证据已合并，不会重复生成趋势指标`, uniquePages(candidateRows
        .filter((candidate) => candidate.status === "redundant").map((candidate) => candidate.pageNumber)));
    }
    if (ignoredCount > 0) {
      addReason(reasons, "POSTPROCESS_IGNORED", "info", `${ignoredCount} 项噪声或非指标内容已忽略`, uniquePages(candidateRows
        .filter((candidate) => candidate.status === "ignored").map((candidate) => candidate.pageNumber)));
    }
    const otherUnresolvedRows = unresolvedRows.filter((candidate) =>
      !candidate.reason?.startsWith("supplement_required:")
    );
    if (otherUnresolvedRows.length > 0) {
      addReason(
        reasons,
        "POSTPROCESS_UNVERIFIED",
        "warning",
        `${otherUnresolvedRows.length} 项候选因版面歧义或证据不足，已保留待核对`,
        uniquePages(otherUnresolvedRows.map((candidate) => candidate.pageNumber))
      );
    }
  }

  const reviewItems: ProcessingDiagnosticReviewItem[] = [];
  for (const reason of reasons.filter((item) =>
    item.code === "OCR_FAILED" || item.code === "OCR_EMPTY" || item.code === "OCR_LOW_QUALITY"
  )) {
    for (const pageNumber of reason.pages) {
      reviewItems.push({
        id: `ocr:${reason.code}:${pageNumber}`,
        issueType: "ocr_content",
        severity: reason.severity === "error" ? "error" : "warning",
        title: reason.code === "OCR_EMPTY"
          ? `第 ${pageNumber} 页没有识别到文字`
          : reason.code === "OCR_FAILED"
            ? `第 ${pageNumber} 页 OCR 处理失败`
            : `第 ${pageNumber} 页 OCR 质量偏低`,
        description: reason.message,
        pages: [pageNumber],
        candidateKind: null,
        sourceLineIds: [],
        resultSummary: "需要对照原件确认 OCR 内容",
        reason: reason.message
      });
    }
  }

  for (const candidate of unresolvedRows) {
    const ambiguous = candidate.reason?.startsWith("ambiguous_layout:") === true;
    const reason = candidateReasonText(candidate.reason);
    reviewItems.push({
      id: `candidate:${candidate.id}`,
      issueType: ambiguous ? "layout_ambiguity" : "ai_missing",
      severity: "warning",
      title: ambiguous
        ? `第 ${candidate.pageNumber} 页存在版面歧义`
        : `第 ${candidate.pageNumber} 页候选未完成提取`,
      description: reason,
      pages: [candidate.pageNumber],
      candidateKind: candidate.kind,
      sourceLineIds: parseStringArray(candidate.sourceLineIdsJson),
      resultSummary: candidate.matchedEntityKey
        ? "已关联到标准化候选，但未通过最终校验，未写入报告指标"
        : "未形成可验证结果，未写入报告指标",
      reason
    });
  }

  const unitByKey = new Map(units
    .filter((unit) => unit.unitKey)
    .map((unit) => [unit.unitKey as string, unit]));
  const unitsByIndex = new Map<number, DiagnosticAiUnit[]>();
  for (const unit of units) {
    if (unit.unitIndex == null) continue;
    const indexed = unitsByIndex.get(unit.unitIndex) || [];
    indexed.push(unit);
    unitsByIndex.set(unit.unitIndex, indexed);
  }
  events.forEach((event, index) => {
    const detail = event.detail || {};
    const rejectedCount = (typeof detail.rejectedObservations === "number" ? detail.rejectedObservations : 0)
      + (typeof detail.rejectedMorphologyFindings === "number" ? detail.rejectedMorphologyFindings : 0)
      + (typeof detail.rejectedClinicalFacts === "number" ? detail.rejectedClinicalFacts : 0)
      + (typeof detail.rejectedStructuredSections === "number" ? detail.rejectedStructuredSections : 0);
    if (rejectedCount < 1) return;
    const eventUnitKey = typeof detail.unitKey === "string" ? detail.unitKey : null;
    const eventUnitIndex = typeof detail.unitIndex === "number" ? detail.unitIndex : null;
    const indexedUnits = eventUnitIndex == null ? [] : unitsByIndex.get(eventUnitIndex) || [];
    const unit = eventUnitKey ? unitByKey.get(eventUnitKey) : indexedUnits.length === 1 ? indexedUnits[0] : undefined;
    const detailPages = Array.isArray(detail.pageNumbers)
      ? detail.pageNumbers.filter((item): item is number => typeof item === "number" && Number.isFinite(item))
      : [];
    const pages = uniquePages(detailPages.length ? detailPages : unit?.pageNumbers || []);
    const sampleNames = (Array.isArray(detail.rejectedObservationSamples) ? detail.rejectedObservationSamples : [])
      .flatMap((sample) => {
        if (!sample || typeof sample !== "object") return [];
        const itemName = (sample as { itemName?: unknown }).itemName;
        return typeof itemName === "string" && itemName.trim() ? [itemName.trim()] : [];
      })
      .slice(0, 3);
    reviewItems.push({
      id: `evidence:${eventUnitKey || eventUnitIndex || "general"}:${index}`,
      issueType: "evidence_rejected",
      severity: "warning",
      title: `${rejectedCount} 项 AI 结果未通过原文验证`,
      description: "AI 返回了结构化内容，但后处理无法在对应 OCR 原文中确认充分证据，因此未写入报告结果。",
      pages,
      candidateKind: null,
      sourceLineIds: [],
      resultSummary: sampleNames.length
        ? `拒绝 ${rejectedCount} 项（${sampleNames.join("、")}${rejectedCount > sampleNames.length ? " 等" : ""}），未写入正式结果`
        : `拒绝 ${rejectedCount} 项，未写入正式结果`,
      reason: "原文证据不足或结果与 OCR 内容不一致"
    });
  });

  let stage = diagnosticStage(job, units);
  if (
    job.jobType === "ai_extract"
    && job.status === "completed"
    && reasons.some((reason) => reason.severity === "warning" || reason.severity === "error")
  ) stage = "post_processing";
  let outcome: ProcessingDiagnosticOutcome;
  if (["queued", "processing"].includes(job.status)) outcome = "running";
  else if (job.status === "failed" || job.status === "cancelled") outcome = "failed";
  else if (job.jobType === "ocr" && metrics.ocrCompletedPages > 0 && metrics.ocrEmptyPages === metrics.ocrCompletedPages) outcome = "empty";
  else if (reasons.some((reason) => reason.severity === "warning" || reason.severity === "error")) outcome = "warning";
  else outcome = "success";

  let headline = stageHeadline(stage);
  if (outcome === "failed") headline = job.jobType === "ocr" ? "OCR 处理失败" : job.jobType === "ai_extract" ? "AI 整理失败" : "文件处理失败";
  else if (outcome === "empty") headline = "OCR 已完成，但没有识别到有效文字";
  else if (outcome === "warning") {
    headline = job.jobType === "ocr"
      ? "OCR 已完成，部分页面质量需要关注"
      : unresolvedCount || postprocessRejectedCount || metrics.warningUnits
        ? `AI 整理已完成，仍有 ${unresolvedCount || postprocessRejectedCount || metrics.warningUnits} 项需要核对`
        : "AI 整理已完成，但部分 OCR 页面质量需要关注";
  } else if (outcome === "success" && job.jobType === "ai_extract") {
    headline = supplementUnits.length ? "AI 整理完成，遗漏候选已自动补提取" : "AI 整理与结果校验已完成";
  } else if (outcome === "success" && job.jobType === "ocr") headline = "OCR 页面文字识别已完成";

  const supplementReason = supplementUnits.length
    ? supplementUnresolvedRows.length > 0
      ? `主解析后发现遗漏候选，已补提取第 ${supplementPages.join("、")} 页；仍有 ${supplementUnresolvedRows.length} 项待核对`
      : supplementUnits.some((unit) => unit.status === "warning" || unit.status === "failed")
        ? `主解析后发现遗漏候选，已补提取第 ${supplementPages.join("、")} 页；补提取执行异常，结果仍需核对`
        : `主解析后发现遗漏候选，已补提取第 ${supplementPages.join("、")} 页并完成验证`
    : null;

  return {
    stage,
    outcome,
    headline,
    reasons,
    reviewItems,
    metrics,
    supplement: {
      required: supplementUnits.length > 0,
      pages: supplementPages,
      reason: supplementReason
    }
  };
}
