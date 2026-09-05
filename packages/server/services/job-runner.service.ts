import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { createError } from "h3";
import { getDatabase } from "../database/client";
import type { RequestUser } from "../domain/request-user";
import { createId } from "../utils/identifier";
import { writeLog } from "../utils/logger";
import { getAppConfig } from "../utils/runtime-config";
import { assertMemberAccess, assertMemberManage } from "./member.service";
import {
  requestWorker,
  type WorkerRequest,
  type WorkerResponse,
} from "./ocr-worker-client";
import {
  isAiExtractionConfigured,
  persistAiExtraction,
  requestAiExtraction,
  type AiExecutor,
} from "./ai-extraction.service";
import { executeAiExtractionPlan } from "./ai-extraction-orchestrator.service";
import { rebuildMorphologyTrackingForReport } from "./morphology-finding.service";
import { normalizeReportObservations } from "./indicator-normalization.service";
import { listManualReportFieldKeys } from "./report-field-overrides.service";
import { findLocalDuplicateEvidence } from "./report-duplicate-precheck.service";
import {
  loadProcessingBatchForJob,
  loadReportProcessingBatchContext,
} from "./processing-job-batches.service";
import { buildProcessingJobDiagnostics } from "./processing-job-diagnostics.service";

type JobRow = {
  id: string;
  reportId: string;
  pageId: string | null;
  jobType: "pdf_extract" | "thumbnail" | "ocr" | "ai_extract";
  attempts: number;
  storagePath: string | null;
  fileSize: number | null;
  thumbnailPath: string | null;
  mimeType: string | null;
  pageNumber: number | null;
  sourcePageNumber: number | null;
  rotation: number | null;
};

export type WorkerExecutor = (
  request: WorkerRequest,
) => Promise<WorkerResponse>;

const maxAttempts = 3;
const retryDelays = [30, 120, 600];
const permanentSourceErrorCodes = new Set([
  "INPUT_FORMAT_MISMATCH",
  "IMAGE_DECODE_FAILED",
  "PDF_DECODE_FAILED",
]);
function leaseHeartbeatIntervalMs() {
  const value = Number(process.env.PROCESSING_JOB_LEASE_HEARTBEAT_INTERVAL_MS);
  if (!Number.isFinite(value)) return 60_000;
  return Math.min(4 * 60_000, Math.max(25, Math.round(value)));
}
let started = false;
let busy = false;
let timer: NodeJS.Timeout | null = null;
let lastRunAt: string | null = null;
let lastError: string | null = null;
let activeJob: { id: string; reportId: string } | null = null;

type JobEventType =
  | "queued"
  | "started"
  | "completed"
  | "retry_scheduled"
  | "failed"
  | "manual_retry"
  | "cancelled";

function safeDetailJson(detail?: Record<string, unknown>) {
  if (!detail) return "{}";
  return JSON.stringify(detail, (_key, value) => {
    if (typeof value === "string") return value.slice(0, 500);
    return value;
  });
}

function hasOcrRuntime(config = getAppConfig()) {
  if (!existsSync(config.ocrPythonBin) || !existsSync(config.ocrWorkerScript))
    return false;
  const markerPath = join(dirname(dirname(config.ocrPythonBin)), ".health-records-ocr-ready");
  if (!existsSync(markerPath))
    return false;
  if (process.arch === "arm64") {
    try {
      const marker = JSON.parse(readFileSync(markerPath, "utf8")) as {
        backend?: string;
        engine?: string;
      };
      if ((marker.engine || marker.backend) !== "rapidocr-onnxruntime") return false;
    } catch {
      return false;
    }
  }
  const statusPath = join(
    config.storageDir,
    "config",
    "ocr-install-status.json",
  );
  if (!existsSync(statusPath)) return true;
  try {
    const status = JSON.parse(readFileSync(statusPath, "utf8")) as {
      state?: string;
    };
    return status.state !== "failed";
  } catch {
    return false;
  }
}

function appendJobEvent(input: {
  jobId: string;
  reportId: string;
  eventType: JobEventType;
  status: string;
  attempt?: number;
  message?: string | null;
  detail?: Record<string, unknown>;
}) {
  getDatabase()
    .prepare(
      `
    INSERT INTO processing_job_events (
      id, job_id, report_id, event_type, status, attempt, message, detail_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `,
    )
    .run(
      createId("event"),
      input.jobId,
      input.reportId,
      input.eventType,
      input.status,
      Math.max(0, Math.round(input.attempt || 0)),
      input.message?.slice(0, 500) || null,
      safeDetailJson(input.detail),
    );
}

function appendDuplicateDetectedEvent(
  reportId: string,
  candidates: Array<{ reason: string }>,
  sourceJobId?: string,
) {
  const job = sourceJobId
    ? { id: sourceJobId }
    : (getDatabase()
        .prepare(
          `
        SELECT id FROM processing_jobs
        WHERE report_id = ? AND job_type = 'ocr' AND status = 'completed'
        ORDER BY finished_at DESC, created_at DESC, id DESC
        LIMIT 1
      `,
        )
        .get(reportId) as { id: string } | undefined);
  if (!job) return;
  const existing = getDatabase()
    .prepare(
      `
    SELECT 1 AS found FROM processing_job_events
    WHERE job_id = ? AND detail_json LIKE '%"stage":"duplicate_precheck"%'
    LIMIT 1
  `,
    )
    .get(job.id);
  if (existing) return;
  appendJobEvent({
    jobId: job.id,
    reportId,
    eventType: "completed",
    status: "completed",
    message: "本地重复检测发现高度重复候选，已暂缓自动 AI 整理",
    detail: {
      jobType: "ocr",
      stage: "duplicate_precheck",
      candidateCount: candidates.length,
      reasons: candidates.map((candidate) => candidate.reason),
    },
  });
}

function safeStoragePath(relativePath: string) {
  const root = resolve(getAppConfig().storageDir);
  const path = resolve(root, relativePath);
  if (path !== root && !path.startsWith(`${root}${sep}`)) {
    throw Object.assign(new Error("存储路径越界"), {
      code: "INVALID_STORAGE_PATH",
    });
  }
  return path;
}

export function claimNextJob() {
  const db = getDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    const expiredJobs = db
      .prepare(
        `
      SELECT j.id, j.report_id AS reportId, j.job_type AS jobType, j.attempts, r.status AS reportStatus
      FROM processing_jobs j JOIN reports r ON r.id = j.report_id
      WHERE j.status = 'processing'
        AND (lease_expires_at IS NULL OR lease_expires_at < CURRENT_TIMESTAMP)
    `,
      )
      .all() as Array<{
      id: string;
      reportId: string;
      jobType: JobRow["jobType"];
      attempts: number;
      reportStatus: string;
    }>;
    const reportsToReconcile = new Set<string>();
    for (const expired of expiredJobs) {
      if (expired.reportStatus === "trashed") {
        db.prepare(
          `
          UPDATE processing_jobs SET status = 'cancelled', locked_at = NULL, lease_expires_at = NULL,
            next_retry_at = NULL, finished_at = COALESCE(finished_at, CURRENT_TIMESTAMP)
          WHERE id = ? AND status = 'processing'
        `,
        ).run(expired.id);
        appendJobEvent({
          jobId: expired.id,
          reportId: expired.reportId,
          eventType: "cancelled",
          status: "cancelled",
          attempt: expired.attempts,
          message: "报告已进入回收站，过期任务不再恢复",
          detail: { jobType: expired.jobType, source: "lease_recovery" },
        });
        continue;
      }
      const finalFailure = expired.attempts >= maxAttempts;
      db.prepare(
        `
        UPDATE processing_jobs SET
          status = ?, error_code = CASE WHEN ? THEN 'LEASE_EXPIRED' ELSE error_code END,
          error_message = CASE WHEN ? THEN '任务执行超时' ELSE error_message END,
          locked_at = NULL, lease_expires_at = NULL,
          next_retry_at = CASE WHEN ? THEN NULL ELSE CURRENT_TIMESTAMP END,
          finished_at = CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE finished_at END
        WHERE id = ? AND status = 'processing'
      `,
      ).run(
        finalFailure ? "failed" : "queued",
        finalFailure ? 1 : 0,
        finalFailure ? 1 : 0,
        finalFailure ? 1 : 0,
        finalFailure ? 1 : 0,
        expired.id,
      );
      appendJobEvent({
        jobId: expired.id,
        reportId: expired.reportId,
        eventType: finalFailure ? "failed" : "retry_scheduled",
        status: finalFailure ? "failed" : "queued",
        attempt: expired.attempts,
        message: finalFailure
          ? "任务执行超时，已达到最大重试次数"
          : "任务租约过期，已自动恢复到队列",
        detail: {
          code: "LEASE_EXPIRED",
          jobType: expired.jobType,
          finalFailure,
          source: "lease_recovery",
        },
      });
      reportsToReconcile.add(expired.reportId);
    }
    const orphanedReports = db
      .prepare(
        `
      SELECT r.id
      FROM reports r
      WHERE r.status = 'processing'
        AND NOT EXISTS (
          SELECT 1 FROM processing_jobs j
          WHERE j.report_id = r.id AND j.status IN ('queued', 'processing')
        )
    `,
      )
      .all() as Array<{ id: string }>;
    for (const report of orphanedReports) reportsToReconcile.add(report.id);
    for (const reportId of reportsToReconcile)
      reconcileReportProcessingStatus(reportId);

    const candidate = db
      .prepare(
        `
      SELECT j.id FROM processing_jobs j
      JOIN reports r ON r.id = j.report_id AND r.status <> 'trashed'
      LEFT JOIN report_pages p ON p.id = j.page_id
      WHERE j.status = 'queued'
        AND (j.next_retry_at IS NULL OR j.next_retry_at <= CURRENT_TIMESTAMP)
      ORDER BY
        CASE j.job_type WHEN 'pdf_extract' THEN 0 WHEN 'thumbnail' THEN 1 WHEN 'ocr' THEN 2 ELSE 3 END,
        CASE
          WHEN j.job_type = 'ai_extract' THEN 0
          ELSE COALESCE((
            SELECT MAX(event.rowid)
            FROM processing_job_events event
            JOIN processing_jobs dispatched ON dispatched.id = event.job_id
            WHERE event.report_id = j.report_id
              AND event.event_type = 'started'
              AND dispatched.job_type = j.job_type
          ), 0)
        END,
        COALESCE(p.page_number, 2147483647),
        j.created_at, j.id
      LIMIT 1
    `,
      )
      .get() as { id: string } | undefined;
    if (!candidate) {
      db.exec("COMMIT");
      return null;
    }
    const claimed = db
      .prepare(
        `
      UPDATE processing_jobs SET status = 'processing', attempts = attempts + 1,
        locked_at = CURRENT_TIMESTAMP, lease_expires_at = datetime('now', '+5 minutes'),
        started_at = COALESCE(started_at, CURRENT_TIMESTAMP), next_retry_at = NULL
      WHERE id = ? AND status = 'queued'
    `,
      )
      .run(candidate.id);
    if (Number(claimed.changes) < 1) {
      db.exec("COMMIT");
      return null;
    }
    const job = db
      .prepare(
        `
      SELECT j.id, j.report_id AS reportId, j.page_id AS pageId, j.job_type AS jobType,
        j.attempts, p.storage_path AS storagePath, p.file_size AS fileSize,
        p.thumbnail_path AS thumbnailPath, p.mime_type AS mimeType,
        p.page_number AS pageNumber, p.source_page_number AS sourcePageNumber, p.rotation
      FROM processing_jobs j LEFT JOIN report_pages p ON p.id = j.page_id WHERE j.id = ?
    `,
      )
      .get(candidate.id) as JobRow;
    db.prepare(
      "UPDATE reports SET status = 'processing', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status <> 'trashed'",
    ).run(job.reportId);
    appendJobEvent({
      jobId: job.id,
      reportId: job.reportId,
      eventType: "started",
      status: "processing",
      attempt: job.attempts,
      detail: {
        jobType: job.jobType,
        pageId: job.pageId,
        pageNumber: job.pageNumber,
        schedulerPolicy: "report-round-robin-v1",
        schedulerLane: job.jobType,
      },
    });
    db.exec("COMMIT");
    return job;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function isJobStillProcessable(job: JobRow) {
  const row = getDatabase()
    .prepare(
      `
    SELECT j.status, j.report_id AS reportId, r.status AS reportStatus,
      j.page_id AS pageId, p.report_id AS pageReportId
    FROM processing_jobs j
    JOIN reports r ON r.id = j.report_id
    LEFT JOIN report_pages p ON p.id = j.page_id
    WHERE j.id = ?
  `,
    )
    .get(job.id) as
    | {
        status: string;
        reportId: string;
        reportStatus: string;
        pageId: string | null;
        pageReportId: string | null;
      }
    | undefined;
  if (!row || row.status !== "processing" || row.reportStatus === "trashed")
    return false;
  if (row.reportId !== job.reportId || row.pageId !== job.pageId) return false;
  return !row.pageId || row.pageReportId === row.reportId;
}

export function isReportJobActive(reportId: string) {
  return activeJob?.reportId === reportId;
}

function queueJob(
  reportId: string,
  pageId: string,
  jobType: "thumbnail" | "ocr",
) {
  const jobId = createId("job");
  const result = getDatabase()
    .prepare(
      `
    INSERT OR IGNORE INTO processing_jobs (
      id, report_id, page_id, job_type, pipeline_version, deduplication_key
    ) VALUES (?, ?, ?, ?, 'worker-v1', ?)
  `,
    )
    .run(
      jobId,
      reportId,
      pageId,
      jobType,
      `${reportId}:${pageId}:${jobType}:worker-v1`,
    );
  if (Number(result.changes) > 0) {
    appendJobEvent({
      jobId,
      reportId,
      eventType: "queued",
      status: "queued",
      detail: { jobType, pageId, source: "worker" },
    });
  }
}

function reportOcrTextLength(reportId: string) {
  /* text_length 列后加，旧行只按 lines_json 是否含文本估算，避免把历史报告误判为空 */
  const row = getDatabase()
    .prepare(
      `
    SELECT COALESCE(SUM(
      CASE
        WHEN o.text_length IS NOT NULL THEN o.text_length
        WHEN o.lines_json IS NOT NULL AND o.lines_json NOT IN ('', '[]') THEN 1
        ELSE 0
      END
    ), 0) AS total
    FROM ocr_results o JOIN report_pages p ON p.id = o.page_id
    WHERE p.report_id = ?
  `,
    )
    .get(reportId) as { total: number };
  return Number(row.total || 0);
}

function isLastActiveOcrJobForReport(job: JobRow) {
  if (job.jobType !== "ocr") return false;
  const row = getDatabase()
    .prepare(
      `
    SELECT COUNT(*) AS count
    FROM processing_jobs
    WHERE report_id = ? AND id <> ?
      AND job_type IN ('ocr', 'pdf_extract')
      AND status IN ('queued', 'processing')
  `,
    )
    .get(job.reportId, job.id) as { count: number };
  /*
   * A delayed PDF inspection can create more OCR pages later. Treating the
   * currently visible OCR as the report boundary would recycle the worker
   * between pages of the same mixed report and waste a costly model reload.
   */
  return Number(row.count || 0) === 0;
}

function readQueuedJobBatchId(reportId: string, jobId?: string) {
  if (!jobId) return null;
  const event = getDatabase()
    .prepare(
      `
    SELECT detail_json AS detailJson
    FROM processing_job_events
    WHERE report_id = ? AND job_id = ? AND event_type = 'queued'
    ORDER BY created_at, id
    LIMIT 1
  `,
    )
    .get(reportId, jobId) as { detailJson: string } | undefined;
  if (!event) return null;
  try {
    const detail = JSON.parse(event.detailJson) as { batchId?: unknown };
    return typeof detail.batchId === "string" && detail.batchId.trim()
      ? detail.batchId.trim()
      : null;
  } catch {
    return null;
  }
}

function queueAiJobIfReady(reportId: string, sourceJobId?: string) {
  if (!isAiExtractionConfigured()) return false;
  const db = getDatabase();
  const batchContext = sourceJobId
    ? loadProcessingBatchForJob(reportId, sourceJobId)
    : null;
  const batchJobs = batchContext?.batchJobs || [];
  const activeLocal = batchJobs.filter(
    (job) =>
      job.jobType !== "ai_extract" &&
      ["queued", "processing"].includes(job.status),
  ).length;
  const failedLocal = batchJobs.filter(
    (job) => job.jobType !== "ai_extract" && job.status === "failed",
  ).length;
  const completedOcr = batchJobs.filter(
    (job) => job.jobType === "ocr" && job.status === "completed",
  ).length;
  const activeAi = batchJobs.filter(
    (job) =>
      job.jobType === "ai_extract" &&
      ["queued", "processing"].includes(job.status),
  ).length;
  const completedAi = batchJobs.filter(
    (job) => job.jobType === "ai_extract" && job.status === "completed",
  ).length;
  if (activeLocal > 0 || failedLocal > 0 || completedOcr < 1) return false;
  if (reportOcrTextLength(reportId) < 1) return false;
  if (activeAi > 0) return false;
  const sourceJob = sourceJobId
    ? (db
        .prepare(
          `
        SELECT pipeline_version AS pipelineVersion
        FROM processing_jobs
        WHERE id = ? AND report_id = ?
      `,
        )
        .get(sourceJobId, reportId) as { pipelineVersion: string } | undefined)
    : undefined;
  const isManualRefresh =
    sourceJob?.pipelineVersion === "manual-reprocess-v1" ||
    sourceJob?.pipelineVersion === "manual-page-v1";
  const batchId = isManualRefresh
    ? readQueuedJobBatchId(reportId, sourceJobId)
    : null;
  const duplicateCandidates = findLocalDuplicateEvidence(reportId).filter(
    (candidate) => candidate.confidence === "high",
  );
  if (duplicateCandidates.length) {
    appendDuplicateDetectedEvent(reportId, duplicateCandidates, sourceJobId);
    return false;
  }
  if (!isManualRefresh && completedAi > 0) {
    const report = db
      .prepare("SELECT title FROM reports WHERE id = ?")
      .get(reportId) as { title: string } | undefined;
    if (report?.title !== "待识别报告") return false;
  }
  const pipelineVersion = isManualRefresh
    ? sourceJob?.pipelineVersion || "manual-reprocess-v1"
    : "health-record-v1";
  const result = db.prepare(`
    INSERT OR IGNORE INTO processing_jobs (
      id, report_id, page_id, job_type, pipeline_version, deduplication_key
    ) VALUES (?, ?, NULL, 'ai_extract', ?, ?)
  `);
  const jobId = createId("job");
  const deduplicationKey = batchId
    ? `${reportId}:ai_extract:auto:${batchId}:${jobId}`
    : `${reportId}:ai_extract:auto:${jobId}`;
  const queued = result.run(jobId, reportId, pipelineVersion, deduplicationKey);
  if (Number(queued.changes) > 0) {
    appendJobEvent({
      jobId,
      reportId,
      eventType: "queued",
      status: "queued",
      detail: {
        jobType: "ai_extract",
        source: "ocr_completed",
        ...(batchId ? { batchId } : {}),
        ...(batchContext?.previousReportStatus
          ? { previousReportStatus: batchContext.previousReportStatus }
          : {}),
      },
    });
  }
  return Number(queued.changes) > 0;
}

function expandPdf(job: JobRow, response: WorkerResponse) {
  if (!job.pageId || job.pageNumber === null)
    throw new Error("PDF 任务缺少页面信息");
  const pageCount = Math.round(Number(response.pageCount || 0));
  if (pageCount < 1 || pageCount > 500) {
    throw Object.assign(new Error("PDF 页数无效或超过 500 页"), {
      code: "INVALID_PDF_PAGE_COUNT",
    });
  }
  const inspectedPages = Array.isArray(response.pages) ? response.pages : [];
  const inspectedPageNumbers = inspectedPages
    .map((page) => Math.round(Number(page.pageNumber)))
    .filter((pageNumber) => Number.isFinite(pageNumber))
    .sort((left, right) => left - right);
  if (
    inspectedPageNumbers.length !== pageCount ||
    inspectedPageNumbers.some((pageNumber, index) => pageNumber !== index + 1)
  ) {
    throw Object.assign(
      new Error(
        `PDF 页数检查不完整：声明 ${pageCount} 页，实际返回 ${inspectedPageNumbers.length} 页`,
      ),
      { code: "PDF_INSPECTION_INCOMPLETE" },
    );
  }
  const db = getDatabase();
  const source = db
    .prepare(
      `
    SELECT original_name AS originalName, storage_path AS storagePath, mime_type AS mimeType,
      file_size AS fileSize, sha256, rotation, source_page_count AS sourcePageCount
    FROM report_pages WHERE id = ?
  `,
    )
    .get(job.pageId) as {
    originalName: string;
    storagePath: string;
    mimeType: string;
    fileSize: number;
    sha256: string;
    rotation: number;
    sourcePageCount: number | null;
  };
  db.exec("BEGIN IMMEDIATE");
  try {
    if (source.sourcePageCount && source.sourcePageCount !== pageCount) {
      throw Object.assign(
        new Error(
          `PDF 页数发生变化：已记录 ${source.sourcePageCount} 页，本次检查为 ${pageCount} 页`,
        ),
        { code: "PDF_PAGE_COUNT_MISMATCH" },
      );
    }
    if (!source.sourcePageCount) {
      if (pageCount > 1) {
        db.prepare(
          `
          UPDATE report_pages SET page_number = -page_number
          WHERE report_id = ? AND page_number > ?
        `,
        ).run(job.reportId, job.pageNumber);
        db.prepare(
          `
          UPDATE report_pages SET page_number = -page_number + ?
          WHERE report_id = ? AND page_number < 0
        `,
        ).run(pageCount - 1, job.reportId);
      }
      db.prepare(
        `
        UPDATE report_pages SET source_page_number = 1, source_page_count = ? WHERE id = ?
      `,
      ).run(pageCount, job.pageId);
      for (let sourcePage = 2; sourcePage <= pageCount; sourcePage += 1) {
        const pageId = createId("page");
        db.prepare(
          `
          INSERT INTO report_pages (
            id, report_id, page_number, original_name, storage_path, mime_type, file_size,
            sha256, rotation, source_page_number, source_page_count
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        ).run(
          pageId,
          job.reportId,
          job.pageNumber + sourcePage - 1,
          source.originalName,
          source.storagePath,
          source.mimeType,
          source.fileSize,
          source.sha256,
          source.rotation,
          sourcePage,
          pageCount,
        );
        queueJob(job.reportId, pageId, "thumbnail");
        queueJob(job.reportId, pageId, "ocr");
      }
      queueJob(job.reportId, job.pageId, "ocr");
    }
    const expandedPages = db
      .prepare(
        `
      SELECT source_page_number AS sourcePageNumber, source_page_count AS sourcePageCount
      FROM report_pages
      WHERE report_id = ? AND storage_path = ?
      ORDER BY source_page_number
    `,
      )
      .all(job.reportId, source.storagePath) as Array<{
      sourcePageNumber: number | null;
      sourcePageCount: number | null;
    }>;
    if (
      expandedPages.length !== pageCount ||
      expandedPages.some(
        (page, index) =>
          page.sourcePageNumber !== index + 1 ||
          page.sourcePageCount !== pageCount,
      )
    ) {
      throw Object.assign(
        new Error(
          `PDF 拆页记录不完整：应有 ${pageCount} 页，实际生成 ${expandedPages.length} 页`,
        ),
        { code: "PDF_PAGE_EXPANSION_INCOMPLETE" },
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function scoreOcrQuality(lines: Array<Record<string, unknown>>) {
  const texts = lines
    .map((line) => (typeof line.text === "string" ? line.text.trim() : ""))
    .filter(Boolean);
  const text = texts.join("\n");
  const textLength = text.length;
  const digitCount = (text.match(/\d/g) || []).length;
  const cjkCount = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const latinCount = (text.match(/[A-Za-z]/g) || []).length;
  const usefulRatio = textLength
    ? (digitCount + cjkCount + latinCount) / textLength
    : 0;
  const confidences = lines
    .map((line) => Number(line.confidence))
    .filter((value) => Number.isFinite(value) && value >= 0 && value <= 1);
  const avgConfidence = confidences.length
    ? confidences.reduce((sum, value) => sum + value, 0) / confidences.length
    : 0;
  let score = 0;
  if (texts.length >= 20) score += 30;
  else if (texts.length >= 8) score += 20;
  else if (texts.length >= 3) score += 10;
  if (textLength >= 800) score += 30;
  else if (textLength >= 300) score += 22;
  else if (textLength >= 80) score += 12;
  if (digitCount >= 20) score += 15;
  else if (digitCount >= 6) score += 8;
  if (usefulRatio >= 0.65) score += 15;
  else if (usefulRatio >= 0.45) score += 8;
  if (avgConfidence >= 0.85) score += 10;
  else if (avgConfidence >= 0.65) score += 6;
  const bounded = Math.max(0, Math.min(100, Math.round(score)));
  const level = bounded >= 70 ? "good" : bounded >= 40 ? "weak" : "poor";
  const reason = [
    `文本${textLength}字`,
    `${texts.length}行`,
    digitCount ? `数字${digitCount}个` : "数字少",
    confidences.length
      ? `均值置信度${Math.round(avgConfidence * 100)}%`
      : "无置信度",
  ].join(" · ");
  return { score: bounded, level, reason, textLength };
}

function completeJob(job: JobRow, response: WorkerResponse) {
  if (!job.pageId) throw new Error("页面任务缺少页面 ID");
  const db = getDatabase();
  const ocrMeta =
    typeof response.engineElapsed === "object" &&
    response.engineElapsed !== null
      ? (response.engineElapsed as Record<string, unknown>)
      : {};
  if (job.jobType === "pdf_extract") {
    expandPdf(job, response);
  } else if (job.jobType === "thumbnail") {
    const relativeThumbnail = `thumbnails/${job.reportId}/${job.pageId}.jpg`;
    db.prepare(
      `
      UPDATE report_pages SET thumbnail_path = ?, width = ?, height = ? WHERE id = ?
    `,
    ).run(
      relativeThumbnail,
      Number(response.width || 0) || null,
      Number(response.height || 0) || null,
      job.pageId,
    );
  } else if (job.jobType === "ocr") {
    const quality = scoreOcrQuality(response.lines || []);
    const coordWidth =
      typeof response.coordWidth === "number" &&
      Number.isFinite(response.coordWidth) &&
      response.coordWidth > 0
        ? response.coordWidth
        : null;
    const coordHeight =
      typeof response.coordHeight === "number" &&
      Number.isFinite(response.coordHeight) &&
      response.coordHeight > 0
        ? response.coordHeight
        : null;
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare(
        `
        INSERT INTO ocr_results (
          id, job_id, page_id, engine, model_version, lines_json,
          quality_score, quality_level, quality_reason, text_length, elapsed_ms,
          coord_width, coord_height
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(job_id) DO UPDATE SET
          engine = excluded.engine, model_version = excluded.model_version,
          lines_json = excluded.lines_json,
          quality_score = excluded.quality_score,
          quality_level = excluded.quality_level,
          quality_reason = excluded.quality_reason,
          text_length = excluded.text_length,
          elapsed_ms = excluded.elapsed_ms,
          coord_width = excluded.coord_width,
          coord_height = excluded.coord_height
      `,
      ).run(
        createId("ocr"),
        job.id,
        job.pageId,
        response.engine || "rapidocr-openvino",
        response.modelVersion || "unknown",
        JSON.stringify(response.lines || []),
        quality.score,
        quality.level,
        quality.reason,
        quality.textLength,
        response.elapsedMs || null,
        coordWidth,
        coordHeight,
      );
      db.prepare(
        "DELETE FROM ocr_results WHERE page_id = ? AND job_id <> ?",
      ).run(job.pageId, job.id);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  db.prepare(
    `
    UPDATE processing_jobs SET status = 'completed', locked_at = NULL, lease_expires_at = NULL,
      error_code = NULL, error_message = NULL, finished_at = CURRENT_TIMESTAMP WHERE id = ?
  `,
  ).run(job.id);
  appendJobEvent({
    jobId: job.id,
    reportId: job.reportId,
    eventType: "completed",
    status: "completed",
    attempt: job.attempts,
    detail: {
      jobType: job.jobType,
      pageId: job.pageId,
      pageNumber: job.pageNumber,
      pageCount: response.pageCount,
      width: response.width,
      height: response.height,
      engine: response.engine,
      modelVersion: response.modelVersion,
      ocrSource:
        typeof ocrMeta.source === "string" ? ocrMeta.source : undefined,
      renderScale:
        typeof ocrMeta.renderScale === "number"
          ? ocrMeta.renderScale
          : undefined,
      pdfTextLines:
        typeof ocrMeta.pdfTextLines === "number"
          ? ocrMeta.pdfTextLines
          : undefined,
      ocrLines:
        typeof ocrMeta.ocrLines === "number" ? ocrMeta.ocrLines : undefined,
      mergedLines:
        typeof ocrMeta.mergedLines === "number"
          ? ocrMeta.mergedLines
          : undefined,
      imageCoverage:
        typeof ocrMeta.imageCoverage === "number"
          ? ocrMeta.imageCoverage
          : undefined,
      elapsedMs: response.elapsedMs,
      workerRssBytes: response.workerRssBytes,
      workerPeakRssBytes: response.workerPeakRssBytes,
      workerRequestCount: response.workerRequestCount,
      workerOcrRequestCount: response.workerOcrRequestCount,
      workerRecycleRecommended: response.recycleRecommended,
      workerRecycleReason: response.recycleReason,
      workerHeartbeatCount: response.workerHeartbeatCount,
      workerLastHeartbeatElapsedMs: response.workerLastHeartbeatElapsedMs,
    },
  });
  if (job.jobType === "ocr") queueAiJobIfReady(job.reportId, job.id);
}

function reportHasUsableStructuredResult(reportId: string) {
  const row = getDatabase()
    .prepare(
      `
    SELECT
      EXISTS(SELECT 1 FROM observations WHERE report_id = ?) AS hasObservations,
      EXISTS(SELECT 1 FROM report_extractions WHERE report_id = ?) AS hasExtraction
  `,
    )
    .get(reportId, reportId) as {
    hasObservations: number;
    hasExtraction: number;
  };
  return Boolean(row.hasObservations || row.hasExtraction);
}

function preservedReportStatus(
  reportId: string,
  previousReportStatus: string | null,
) {
  if (
    previousReportStatus === "ready" ||
    previousReportStatus === "needs_review"
  )
    return previousReportStatus;
  return reportHasUsableStructuredResult(reportId) ? "needs_review" : "failed";
}

export function reconcileReportProcessingStatus(reportId: string) {
  const db = getDatabase();
  const previous = db
    .prepare(
      "SELECT status, member_id AS memberId, title FROM reports WHERE id = ?",
    )
    .get(reportId) as
    { status: string; memberId: string; title: string } | undefined;
  if (!previous || previous.status === "trashed")
    return previous?.status || null;

  const context = loadReportProcessingBatchContext(reportId);
  const currentJobs = context.currentBatch?.jobs || [];
  const hasActive = currentJobs.some((job) =>
    ["queued", "processing"].includes(job.status),
  );
  const hasFailure = currentJobs.some((job) => job.status === "failed");
  const hasCompleted = currentJobs.some((job) => job.status === "completed");
  const allCancelled =
    currentJobs.length > 0 &&
    currentJobs.every((job) => job.status === "cancelled");
  let status = previous.status;
  if (hasActive) {
    status = "processing";
  } else if (hasFailure) {
    status = preservedReportStatus(reportId, context.previousReportStatus);
  } else if (allCancelled) {
    status = preservedReportStatus(reportId, context.previousReportStatus);
  } else if (hasCompleted) {
    status = "needs_review";
  } else if (["queued", "processing", "uploading"].includes(previous.status)) {
    status = preservedReportStatus(reportId, context.previousReportStatus);
  }

  db.prepare(
    "UPDATE reports SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status <> 'trashed'",
  ).run(status, reportId);
  if (previous.status === status) return status;

  if (hasFailure && status !== "failed") {
    db.prepare(
      `
      INSERT INTO app_notifications (id, member_id, report_id, type, title, message, severity)
      VALUES (?, ?, ?, 'report_failed', ?, ?, 'warning')
    `,
    ).run(
      createId("notice"),
      previous.memberId,
      reportId,
      "重新处理失败，已保留原结果",
      `「${previous.title}」本轮处理未完成，上一版可用内容和趋势数据未被覆盖。可查看任务日志后重试。`,
    );
    return status;
  }

  if (status === "needs_review" && !hasFailure) {
    const hasAiResult = currentJobs.some(
      (job) => job.jobType === "ai_extract" && job.status === "completed",
    );
    const ocrTextEmpty = !hasAiResult && reportOcrTextLength(reportId) < 1;
    const duplicateCandidates =
      !hasAiResult && !ocrTextEmpty
        ? findLocalDuplicateEvidence(reportId).filter(
            (candidate) => candidate.confidence === "high",
          )
        : [];
    const duplicateDetected = duplicateCandidates.length > 0;
    if (duplicateDetected)
      appendDuplicateDetectedEvent(reportId, duplicateCandidates);
    db.prepare(
      `
      INSERT INTO app_notifications (id, member_id, report_id, type, title, message, severity)
      VALUES (?, ?, ?, 'report_processed', ?, ?, ?)
    `,
    ).run(
      createId("notice"),
      previous.memberId,
      reportId,
      ocrTextEmpty
        ? "报告未识别到文字"
        : duplicateDetected
          ? "发现可能重复报告"
          : "报告处理完成",
      ocrTextEmpty
        ? `「${previous.title}」OCR 未提取到任何文字，可能不是有效的体检报告。请确认原件清晰后重新上传，或手动录入报告内容。`
        : duplicateDetected
          ? `「${previous.title}」已完成 OCR，本地检测到 ${duplicateCandidates.length} 份高度重复候选${isAiExtractionConfigured() ? "，已暂缓自动 AI 整理" : ""}。请先核对已有报告，也可以在详情中手动继续 AI 整理。`
          : hasAiResult
            ? `「${previous.title}」已完成 OCR 和 AI 整理，等待确认归档。`
            : `「${previous.title}」已完成 OCR 识别，等待确认归档。`,
      ocrTextEmpty || duplicateDetected ? "warning" : "success",
    );
  } else if (status === "failed") {
    db.prepare(
      `
      INSERT INTO app_notifications (id, member_id, report_id, type, title, message, severity)
      VALUES (?, ?, ?, 'report_failed', ?, ?, 'error')
    `,
    ).run(
      createId("notice"),
      previous.memberId,
      reportId,
      "报告处理失败",
      `「${previous.title}」处理失败，可在报告详情中查看日志并重试。`,
    );
  }
  return status;
}

function sourceFileError(code: string, message: string) {
  return Object.assign(new Error(message), { code });
}

function assertSourceFileAvailable(job: JobRow, imagePath: string) {
  let stats;
  try {
    stats = lstatSync(imagePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") {
      throw sourceFileError(
        "SOURCE_FILE_MISSING",
        "报告原件文件不存在，请确认存储目录可用或重新上传原件",
      );
    }
    throw sourceFileError(
      "SOURCE_FILE_UNREADABLE",
      `报告原件无法读取：${error instanceof Error ? error.message : "文件系统访问失败"}`,
    );
  }
  if (!stats.isFile()) {
    throw sourceFileError("SOURCE_FILE_INVALID", "报告原件路径不是有效文件");
  }
  if (job.fileSize !== null && stats.size !== job.fileSize) {
    throw sourceFileError(
      "SOURCE_FILE_SIZE_MISMATCH",
      `报告原件大小不一致：预期 ${job.fileSize} 字节，实际 ${stats.size} 字节`,
    );
  }
}

function cancelQueuedJobsForPermanentSourceFailure(job: JobRow, code: string) {
  if (!job.storagePath) return 0;
  const db = getDatabase();
  const siblings = db
    .prepare(
      `
      SELECT j.id, j.page_id AS pageId, j.job_type AS jobType, j.attempts,
        p.page_number AS pageNumber
      FROM processing_jobs j
      JOIN report_pages p ON p.id = j.page_id
      WHERE j.report_id = ? AND p.storage_path = ? AND j.id <> ?
        AND j.status = 'queued' AND j.job_type IN ('pdf_extract', 'thumbnail', 'ocr')
    `,
    )
    .all(job.reportId, job.storagePath, job.id) as Array<{
    id: string;
    pageId: string;
    jobType: JobRow["jobType"];
    attempts: number;
    pageNumber: number;
  }>;
  for (const sibling of siblings) {
    db.prepare(
      `
      UPDATE processing_jobs SET status = 'cancelled', locked_at = NULL, lease_expires_at = NULL,
        next_retry_at = NULL, error_code = ?, error_message = ?, finished_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'queued'
    `,
    ).run(code, "同一原件已确认无法解码，已停止重复处理", sibling.id);
    appendJobEvent({
      jobId: sibling.id,
      reportId: job.reportId,
      eventType: "cancelled",
      status: "cancelled",
      attempt: sibling.attempts,
      message: "同一原件已确认无法解码，已停止重复处理",
      detail: {
        code,
        source: "permanent_source_failure",
        failedJobId: job.id,
        jobType: sibling.jobType,
        pageId: sibling.pageId,
        pageNumber: sibling.pageNumber,
      },
    });
  }
  return siblings.length;
}

function failJob(job: JobRow, error: unknown) {
  const message =
    error instanceof Error ? error.message.slice(0, 500) : "任务执行失败";
  const code = String(
    (error as { code?: string })?.code || "WORKER_TASK_FAILED",
  ).slice(0, 80);
  const permanentFailure = permanentSourceErrorCodes.has(code);
  const finalFailure = permanentFailure || job.attempts >= maxAttempts;
  const delay = retryDelays[Math.min(job.attempts - 1, retryDelays.length - 1)];
  getDatabase()
    .prepare(
      `
    UPDATE processing_jobs SET status = ?, locked_at = NULL, lease_expires_at = NULL,
      next_retry_at = CASE WHEN ? THEN NULL ELSE datetime('now', ?) END,
      error_code = ?, error_message = ?, finished_at = CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE NULL END
    WHERE id = ?
  `,
    )
    .run(
      finalFailure ? "failed" : "queued",
      finalFailure ? 1 : 0,
      `+${delay} seconds`,
      code,
      message,
      finalFailure ? 1 : 0,
      job.id,
    );
  const cancelledSiblingJobs = permanentFailure
    ? cancelQueuedJobsForPermanentSourceFailure(job, code)
    : 0;
  appendJobEvent({
    jobId: job.id,
    reportId: job.reportId,
    eventType: finalFailure ? "failed" : "retry_scheduled",
    status: finalFailure ? "failed" : "queued",
    attempt: job.attempts,
    message,
    detail: {
      code,
      jobType: job.jobType,
      pageId: job.pageId,
      pageNumber: job.pageNumber,
      finalFailure,
      permanentFailure,
      cancelledSiblingJobs,
      retryDelaySeconds: finalFailure ? null : delay,
    },
  });
}

export async function processNextJob(
  executor: WorkerExecutor = requestWorker,
  aiExecutor: AiExecutor = requestAiExtraction,
) {
  const job = claimNextJob();
  if (!job) return false;
  activeJob = { id: job.id, reportId: job.reportId };
  let rebuildMorphology = false;
  let thumbnailOutputPath: string | null = null;
  const cleanupPendingThumbnail = () => {
    if (!thumbnailOutputPath || job.thumbnailPath) return;
    try {
      rmSync(thumbnailOutputPath, { force: true });
    } catch {
      // Orphan scanning remains the fallback when the storage is temporarily unavailable.
    }
  };
  const renewLease = () => {
    getDatabase()
      .prepare(
        `
      UPDATE processing_jobs SET lease_expires_at = datetime('now', '+5 minutes')
      WHERE id = ? AND status = 'processing'
    `,
      )
      .run(job.id);
  };
  // Every processing job can outlive the five-minute lease on slower household
  // NAS devices. Renew local OCR/PDF jobs as well as AI jobs so another runner
  // cannot recover and duplicate work that is still actively executing.
  const leaseHeartbeat = setInterval(renewLease, leaseHeartbeatIntervalMs());
  leaseHeartbeat.unref();
  try {
    if (job.jobType === "ai_extract") {
      const persisted = getDatabase()
        .prepare("SELECT 1 AS found FROM report_extractions WHERE job_id = ?")
        .get(job.id) as { found: number } | undefined;
      if (!persisted) {
        const execution = await executeAiExtractionPlan(
          job.id,
          job.reportId,
          aiExecutor,
          {
            shouldContinue: () => isJobStillProcessable(job),
            onEvent: (unitEvent) => {
              renewLease();
              const eventType =
                unitEvent.type === "unit_completed"
                  ? "completed"
                  : ["unit_failed", "format_retry"].includes(unitEvent.type)
                    ? "retry_scheduled"
                    : "started";
              appendJobEvent({
                jobId: job.id,
                reportId: job.reportId,
                eventType,
                status: "processing",
                attempt: job.attempts,
                message: unitEvent.message,
                detail: {
                  jobType: "ai_extract",
                  stage: unitEvent.type,
                  ...unitEvent.detail,
                },
              });
            },
          },
        );
        const extraction = execution.result;
        if (!isJobStillProcessable(job)) return true;
        const indicatorNormalization = persistAiExtraction(
          job.reportId,
          job.id,
          extraction,
          execution.inputCharacters,
        );
        if (!isJobStillProcessable(job)) return true;
        appendJobEvent({
          jobId: job.id,
          reportId: job.reportId,
          eventType: "completed",
          status: "completed",
          attempt: job.attempts,
          detail: {
            jobType: "ai_extract",
            provider: extraction.provider,
            model: extraction.model,
            promptVersion: extraction.promptVersion,
            extractionDepth: execution.plan.extractionDepth,
            inputCharacters: execution.inputCharacters,
            planHash: execution.plan.planHash,
            plannedUnits: execution.plan.unitCount,
            processedPages: execution.plan.pageCount,
            warningUnits: execution.warningUnits,
            unmatchedCandidates: execution.unmatchedCandidates,
            promptTokens: extraction.promptTokens,
            completionTokens: extraction.completionTokens,
            elapsedMs: extraction.elapsedMs,
            indicatorNormalization,
          },
        });
      } else {
        const indicatorNormalization = normalizeReportObservations(
          job.reportId,
        );
        appendJobEvent({
          jobId: job.id,
          reportId: job.reportId,
          eventType: "completed",
          status: "completed",
          attempt: job.attempts,
          message: "已恢复指标归一化并完成任务",
          detail: {
            jobType: "ai_extract",
            resumedFromPersistedExtraction: true,
            indicatorNormalization,
          },
        });
      }
      getDatabase()
        .prepare(
          `
        UPDATE processing_jobs SET status = 'completed', locked_at = NULL, lease_expires_at = NULL,
          error_code = NULL, error_message = NULL, finished_at = CURRENT_TIMESTAMP WHERE id = ?
      `,
        )
        .run(job.id);
      rebuildMorphology = true;
    } else {
      if (!job.storagePath || !job.pageId)
        throw new Error("页面任务缺少原件信息");
      const imagePath = safeStoragePath(job.storagePath);
      assertSourceFileAvailable(job, imagePath);
      const request: WorkerRequest = {
        action: job.jobType === "pdf_extract" ? "inspect_pdf" : job.jobType,
        imagePath,
        mimeType: job.mimeType,
        pageNumber: job.sourcePageNumber,
        rotation: job.rotation || 0,
        recycleAfterResponse: isLastActiveOcrJobForReport(job),
      };
      if (job.jobType === "thumbnail") {
        const relativeThumbnail = `thumbnails/${job.reportId}/${job.pageId}.jpg`;
        const outputPath = safeStoragePath(relativeThumbnail);
        mkdirSync(dirname(outputPath), { recursive: true });
        thumbnailOutputPath = outputPath;
        request.outputPath = outputPath;
      }
      const response = await executor(request);
      if (!isJobStillProcessable(job)) {
        cleanupPendingThumbnail();
        return true;
      }
      if (!response.ok)
        throw Object.assign(
          new Error(response.errorMessage || "Worker 任务失败"),
          { code: response.errorCode },
        );
      completeJob(job, response);
    }
  } catch (error) {
    cleanupPendingThumbnail();
    if (!isJobStillProcessable(job)) return true;
    failJob(job, error);
    throw error;
  } finally {
    clearInterval(leaseHeartbeat);
    if (activeJob?.id === job.id) activeJob = null;
    reconcileReportProcessingStatus(job.reportId);
    if (rebuildMorphology) {
      try {
        rebuildMorphologyTrackingForReport(job.reportId);
      } catch (error) {
        await writeLog("warn", "morphology-tracking-rebuild-failed", {
          reportId: job.reportId,
          error: error instanceof Error ? error.message : "形态变化关联失败",
        });
      }
    }
  }
  return true;
}

async function tick() {
  if (busy) return;
  const config = getAppConfig();
  if (!hasOcrRuntime(config)) return;
  busy = true;
  try {
    lastRunAt = new Date().toISOString();
    lastError = null;
    await processNextJob();
  } catch (error) {
    lastError = error instanceof Error ? error.message : "任务执行失败";
    await writeLog("warn", "processing-job-failed", { error: lastError });
  } finally {
    busy = false;
  }
}

export function startJobRunner() {
  if (started || process.env.DISABLE_JOB_RUNNER === "true") return;
  started = true;
  timer = setInterval(() => {
    void tick();
  }, 1500);
  timer.unref();
  void tick();
}

export function stopJobRunner() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  started = false;
  return { busy };
}

export function getJobRunnerStatus() {
  const config = getAppConfig();
  const counts = getDatabase()
    .prepare(
      `
    SELECT
      SUM(status = 'queued') AS queued,
      SUM(status = 'processing') AS processing,
      SUM(status = 'failed') AS failed
    FROM processing_jobs
  `,
    )
    .get() as { queued: number; processing: number; failed: number };
  return {
    started,
    busy,
    runtimeAvailable: hasOcrRuntime(config),
    lastRunAt,
    lastError,
    queued: Number(counts.queued || 0),
    processing: Number(counts.processing || 0),
    failed: Number(counts.failed || 0),
  };
}

export function retryProcessingJob(user: RequestUser, jobId: string) {
  const job = getDatabase()
    .prepare(
      `
    SELECT j.id, j.report_id AS reportId, r.member_id AS memberId, j.status
    FROM processing_jobs j JOIN reports r ON r.id = j.report_id WHERE j.id = ? AND r.status <> 'trashed'
  `,
    )
    .get(jobId) as
    | { id: string; reportId: string; memberId: string; status: string }
    | undefined;
  if (!job)
    throw createError({ statusCode: 404, statusMessage: "处理任务不存在" });
  assertMemberManage(user, job.memberId);
  if (job.status !== "failed")
    throw createError({
      statusCode: 409,
      statusMessage: "只有失败任务可以重试",
    });
  getDatabase()
    .prepare(
      `
    UPDATE processing_jobs SET status = 'queued', attempts = 0, next_retry_at = CURRENT_TIMESTAMP,
      error_code = NULL, error_message = NULL, finished_at = NULL WHERE id = ?
  `,
    )
    .run(jobId);
  getDatabase()
    .prepare(
      "UPDATE reports SET status = 'processing', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    )
    .run(job.reportId);
  appendJobEvent({
    jobId,
    reportId: job.reportId,
    eventType: "manual_retry",
    status: "queued",
    attempt: 0,
    message: "用户手动重试任务",
  });
  return { id: jobId, status: "queued" };
}

export function queueManualAiExtraction(user: RequestUser, reportId: string) {
  const db = getDatabase();
  const report = db
    .prepare(
      "SELECT member_id AS memberId, status FROM reports WHERE id = ? AND status <> 'trashed'",
    )
    .get(reportId) as { memberId: string; status: string } | undefined;
  if (!report)
    throw createError({ statusCode: 404, statusMessage: "报告不存在" });
  assertMemberManage(user, report.memberId);
  if (!isAiExtractionConfigured()) {
    throw createError({
      statusCode: 409,
      statusMessage: "AI 解析尚未启用或配置不完整",
    });
  }
  const active = db
    .prepare(
      `
    SELECT
      SUM(job_type <> 'ai_extract' AND status IN ('queued', 'processing')) AS activeLocal,
      SUM(job_type = 'ai_extract' AND status IN ('queued', 'processing')) AS activeAi
    FROM processing_jobs WHERE report_id = ?
  `,
    )
    .get(reportId) as { activeLocal: number; activeAi: number };
  if (Number(active.activeLocal) > 0)
    throw createError({
      statusCode: 409,
      statusMessage: "本地识别仍在处理中，完成后再整理",
    });
  if (Number(active.activeAi) > 0)
    throw createError({
      statusCode: 409,
      statusMessage: "AI 整理任务已在队列中",
    });

  const context = loadReportProcessingBatchContext(reportId);
  const currentFailedLocal = context.currentBatch?.jobs.some(
    (job) => job.jobType !== "ai_extract" && job.status === "failed",
  );
  if (currentFailedLocal)
    throw createError({
      statusCode: 409,
      statusMessage: "本轮存在失败的 OCR/PDF 任务，请先重试本地识别",
    });
  const completedOcr = db
    .prepare(
      `
    SELECT COUNT(*) AS count
    FROM ocr_results o JOIN report_pages p ON p.id = o.page_id
    WHERE p.report_id = ?
  `,
    )
    .get(reportId) as { count: number };
  if (Number(completedOcr.count) < 1 || reportOcrTextLength(reportId) < 1) {
    throw createError({
      statusCode: 409,
      statusMessage: "暂无可用于 AI 整理的 OCR 文本",
    });
  }

  const failedAi = context.currentBatch?.jobs.find(
    (job) => job.jobType === "ai_extract" && job.status === "failed",
  );
  if (failedAi) return retryProcessingJob(user, failedAi.id);

  const jobId = createId("job");
  const batchId = `manual-ai:${jobId}`;
  db.prepare(
    `
    INSERT INTO processing_jobs (
      id, report_id, page_id, job_type, pipeline_version, deduplication_key
    ) VALUES (?, ?, NULL, 'ai_extract', 'manual-ai-v1', ?)
  `,
  ).run(jobId, reportId, `${reportId}:ai_extract:manual:${jobId}`);
  appendJobEvent({
    jobId,
    reportId,
    eventType: "queued",
    status: "queued",
    message: "用户手动触发 AI 整理",
    detail: {
      jobType: "ai_extract",
      source: "manual",
      batchId,
      previousReportStatus: report.status,
    },
  });
  db.prepare(
    "UPDATE reports SET status = 'processing', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status <> 'trashed'",
  ).run(reportId);
  return { id: jobId, status: "queued" };
}

/*
 * 用户主动中断报告的排队/处理中任务：排队的任务立即停止；
 * 正在执行的任务在下一个单元边界由 shouldContinue 检查发现状态变化后安静退出，
 * 已保存的上一版 OCR、指标和报告字段不会被覆盖。
 */
export function cancelReportProcessing(user: RequestUser, reportId: string) {
  const db = getDatabase();
  const report = db
    .prepare(
      `
    SELECT id, member_id AS memberId, title, status
    FROM reports WHERE id = ? AND status <> 'trashed'
  `,
    )
    .get(reportId) as
    { id: string; memberId: string; title: string; status: string } | undefined;
  if (!report)
    throw createError({ statusCode: 404, statusMessage: "报告不存在" });
  assertMemberManage(user, report.memberId);
  const active = db
    .prepare(
      `
    SELECT id, job_type AS jobType, attempts FROM processing_jobs
    WHERE report_id = ? AND status IN ('queued', 'processing')
  `,
    )
    .all(reportId) as Array<{
    id: string;
    jobType: JobRow["jobType"];
    attempts: number;
  }>;
  if (!active.length)
    throw createError({
      statusCode: 409,
      statusMessage: "这份报告当前没有排队或处理中的任务",
    });
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const job of active) {
      db.prepare(
        `
        UPDATE processing_jobs
        SET status = 'cancelled', locked_at = NULL, lease_expires_at = NULL,
          next_retry_at = NULL, finished_at = COALESCE(finished_at, CURRENT_TIMESTAMP)
        WHERE id = ? AND status IN ('queued', 'processing')
      `,
      ).run(job.id);
      appendJobEvent({
        jobId: job.id,
        reportId,
        eventType: "cancelled",
        status: "cancelled",
        attempt: job.attempts,
        message: "用户手动中断任务",
        detail: {
          jobType: job.jobType,
          source: "user_cancel",
          previousReportStatus: report.status,
        },
      });
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  const status = reconcileReportProcessingStatus(reportId);
  return { cancelled: active.length, status };
}

export function reprocessReportOcrAndAi(user: RequestUser, reportId: string) {
  const db = getDatabase();
  const report = db
    .prepare(
      `
    SELECT id, member_id AS memberId, title, status
    FROM reports WHERE id = ? AND status <> 'trashed'
  `,
    )
    .get(reportId) as
    { id: string; memberId: string; title: string; status: string } | undefined;
  if (!report)
    throw createError({ statusCode: 404, statusMessage: "报告不存在" });
  assertMemberManage(user, report.memberId);
  const pages = db
    .prepare(
      `
    SELECT id, page_number AS pageNumber FROM report_pages
    WHERE report_id = ? ORDER BY page_number
  `,
    )
    .all(reportId) as Array<{ id: string; pageNumber: number }>;
  if (!pages.length)
    throw createError({
      statusCode: 409,
      statusMessage: "这份报告没有可重新识别的原件页",
    });
  const running = db
    .prepare(
      `
    SELECT job_type AS jobType FROM processing_jobs
    WHERE report_id = ? AND status IN ('queued', 'processing')
    LIMIT 1
  `,
    )
    .get(reportId) as { jobType: string } | undefined;
  if (running) {
    throw createError({
      statusCode: 409,
      statusMessage: "这份报告已有任务在排队或处理中，请稍后再重新识别",
    });
  }

  const batchId = createId("batch");
  const cancellable = db
    .prepare(
      `
    SELECT id, job_type AS jobType, attempts FROM processing_jobs
    WHERE report_id = ? AND status = 'failed'
  `,
    )
    .all(reportId) as Array<{
    id: string;
    jobType: JobRow["jobType"];
    attempts: number;
  }>;
  const queuedOcrJobs: string[] = [];
  const manualFieldKeys = listManualReportFieldKeys(reportId);

  db.exec("BEGIN IMMEDIATE");
  try {
    for (const job of cancellable) {
      db.prepare(
        `
        UPDATE processing_jobs
        SET status = 'cancelled', locked_at = NULL, lease_expires_at = NULL,
          next_retry_at = NULL, finished_at = COALESCE(finished_at, CURRENT_TIMESTAMP)
        WHERE id = ?
      `,
      ).run(job.id);
      appendJobEvent({
        jobId: job.id,
        reportId,
        eventType: "cancelled",
        status: "cancelled",
        attempt: job.attempts,
        message: "重新识别报告时取消旧任务",
        detail: {
          jobType: job.jobType,
          source: "manual_reprocess",
          batchId,
          previousReportStatus: report.status,
        },
      });
    }
    /* 保留上一版可用 OCR、指标和报告字段，直到新一轮 AI 成功后原子替换。 */
    db.prepare(
      `
      UPDATE reports SET
        status = 'processing',
        source_version = source_version + 1,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `,
    ).run(reportId);
    for (const page of pages) {
      const jobId = createId("job");
      db.prepare(
        `
        INSERT INTO processing_jobs (
          id, report_id, page_id, job_type, pipeline_version, deduplication_key
        ) VALUES (?, ?, ?, 'ocr', 'manual-reprocess-v1', ?)
      `,
      ).run(
        jobId,
        reportId,
        page.id,
        `${reportId}:${page.id}:ocr:manual-reprocess:${batchId}:${jobId}`,
      );
      appendJobEvent({
        jobId,
        reportId,
        eventType: "queued",
        status: "queued",
        message: "用户重新识别报告",
        detail: {
          jobType: "ocr",
          pageId: page.id,
          pageNumber: page.pageNumber,
          source: "manual_reprocess",
          batchId,
          previousReportStatus: report.status,
        },
      });
      queuedOcrJobs.push(jobId);
    }
    db.prepare(
      `
      INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, detail_json)
      VALUES (?, ?, 'report.reprocess_ocr_ai', 'report', ?, ?)
    `,
    ).run(
      createId("audit"),
      user.id,
      reportId,
      JSON.stringify({
        memberId: report.memberId,
        previousStatus: report.status,
        previousTitle: report.title,
        pageCount: pages.length,
        queuedOcr: queuedOcrJobs.length,
        aiConfigured: isAiExtractionConfigured(),
        manualFieldKeys: [...manualFieldKeys],
        batchId,
      }),
    );
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  return {
    id: reportId,
    status: "processing" as const,
    batchId,
    queuedOcr: queuedOcrJobs.length,
    aiWillRun: isAiExtractionConfigured(),
  };
}

export function listProcessingJobEvents(user: RequestUser, jobId: string) {
  const job = getDatabase()
    .prepare(
      `
    SELECT j.id, j.report_id AS reportId, r.member_id AS memberId,
      j.job_type AS jobType, j.status, j.attempts, j.error_code AS errorCode,
      j.error_message AS errorMessage, j.created_at AS createdAt,
      j.started_at AS startedAt, j.finished_at AS finishedAt
    FROM processing_jobs j JOIN reports r ON r.id = j.report_id WHERE j.id = ?
  `,
    )
    .get(jobId) as
    | {
        id: string;
        reportId: string;
        memberId: string;
        jobType: JobRow["jobType"];
        status: string;
        attempts: number;
        errorCode: string | null;
        errorMessage: string | null;
        createdAt: string;
        startedAt: string | null;
        finishedAt: string | null;
      }
    | undefined;
  if (!job)
    throw createError({ statusCode: 404, statusMessage: "处理任务不存在" });
  assertMemberAccess(user, job.memberId);
  const rows = getDatabase()
    .prepare(
      `
    SELECT id, job_id AS jobId, report_id AS reportId, event_type AS eventType,
      status, attempt, message, detail_json AS detailJson, created_at AS createdAt
    FROM processing_job_events
    WHERE job_id = ?
    ORDER BY created_at, rowid
  `,
    )
    .all(jobId);
  if (!rows.length) {
    const eventType: JobEventType =
      job.status === "completed"
        ? "completed"
        : job.status === "failed"
          ? "failed"
          : job.status === "processing"
            ? "started"
            : "queued";
    return [
      {
        id: `${job.id}:snapshot`,
        jobId: job.id,
        reportId: job.reportId,
        eventType,
        status: job.status,
        attempt: job.attempts,
        message:
          job.errorMessage || "历史任务暂无详细事件日志，已显示当前状态快照",
        detail: {
          jobType: job.jobType,
          code: job.errorCode,
          startedAt: job.startedAt,
          finishedAt: job.finishedAt,
        },
        createdAt: job.finishedAt || job.startedAt || job.createdAt,
      },
    ];
  }
  return rows.map((row) => {
    const event = row as {
      id: string;
      jobId: string;
      reportId: string;
      eventType: JobEventType;
      status: string;
      attempt: number;
      message: string | null;
      detailJson: string;
      createdAt: string;
    };
    let detail: Record<string, unknown> = {};
    try {
      detail = JSON.parse(event.detailJson) as Record<string, unknown>;
    } catch {
      /* ignore malformed legacy detail */
    }
    return { ...event, detail, detailJson: undefined };
  });
}

type ProcessingJobEventItem = ReturnType<
  typeof listProcessingJobEvents
>[number];

function parseNumberArray(value: string) {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter(
          (item): item is number =>
            typeof item === "number" && Number.isFinite(item),
        )
      : [];
  } catch {
    return [];
  }
}

/**
 * AI jobs execute units concurrently, so raw event timestamps do not represent
 * the planned reading order. This projection keeps the raw history intact but
 * makes the extraction plan the primary progress model for clients.
 */
export function getProcessingJobEventDetail(user: RequestUser, jobId: string) {
  const db = getDatabase();
  const job = db
    .prepare(
      `
    SELECT j.id, j.report_id AS reportId, r.member_id AS memberId,
      j.job_type AS jobType, j.status, j.attempts, j.error_code AS errorCode,
      j.error_message AS errorMessage, j.created_at AS createdAt,
      j.started_at AS startedAt, j.finished_at AS finishedAt
    FROM processing_jobs j JOIN reports r ON r.id = j.report_id WHERE j.id = ?
  `,
    )
    .get(jobId) as
    | {
        id: string;
        reportId: string;
        memberId: string;
        jobType: JobRow["jobType"];
        status: string;
        attempts: number;
        errorCode: string | null;
        errorMessage: string | null;
        createdAt: string;
        startedAt: string | null;
        finishedAt: string | null;
      }
    | undefined;
  if (!job)
    throw createError({ statusCode: 404, statusMessage: "处理任务不存在" });
  assertMemberAccess(user, job.memberId);
  const { memberId: _memberId, ...publicJob } = job;

  const events = listProcessingJobEvents(user, jobId);
  if (job.jobType !== "ai_extract") {
    return {
      job: publicJob,
      units: [],
      generalEvents: events,
      diagnostics: buildProcessingJobDiagnostics(publicJob, events),
    };
  }

  const unitRows = db
    .prepare(
      `
    SELECT id, unit_key AS unitKey, unit_index AS unitIndex, unit_type AS unitType,
      page_numbers_json AS pageNumbersJson, status, attempts, model,
      character_count AS characterCount, candidate_count AS candidateCount,
      matched_count AS matchedCount,
      prompt_tokens AS promptTokens, completion_tokens AS completionTokens,
      elapsed_ms AS elapsedMs, error_code AS errorCode, error_message AS errorMessage,
      started_at AS startedAt, finished_at AS finishedAt
    FROM ai_extraction_units
    WHERE job_id = ? AND status <> 'superseded'
    ORDER BY CASE WHEN unit_type = 'supplement' THEN 1 ELSE 0 END, unit_index, id
  `,
    )
    .all(jobId) as Array<{
    id: string;
    unitKey: string;
    unitIndex: number;
    unitType: "complete_pages" | "page_chunk" | "supplement";
    pageNumbersJson: string;
    status: "planned" | "processing" | "completed" | "warning" | "failed";
    attempts: number;
    model: string | null;
    characterCount: number;
    candidateCount: number;
    matchedCount: number;
    promptTokens: number | null;
    completionTokens: number | null;
    elapsedMs: number | null;
    errorCode: string | null;
    errorMessage: string | null;
    startedAt: string | null;
    finishedAt: string | null;
  }>;
  const unitEvents = new Map<string, ProcessingJobEventItem[]>();
  const generalEvents: ProcessingJobEventItem[] = [];
  const unitKeys = new Set(unitRows.map((unit) => unit.unitKey));
  const unitsByIndex = new Map<number, typeof unitRows>();
  for (const unit of unitRows) {
    const matches = unitsByIndex.get(unit.unitIndex) || [];
    matches.push(unit);
    unitsByIndex.set(unit.unitIndex, matches);
  }
  for (const event of events) {
    const detail = (event.detail || {}) as Record<string, unknown>;
    const eventUnitKey =
      typeof detail.unitKey === "string" ? detail.unitKey : null;
    const eventUnitIndex =
      typeof detail.unitIndex === "number" ? detail.unitIndex : null;
    const legacyIndexMatch =
      eventUnitIndex == null ? null : unitsByIndex.get(eventUnitIndex);
    const resolvedKey =
      eventUnitKey && unitKeys.has(eventUnitKey)
        ? eventUnitKey
        : legacyIndexMatch?.length === 1
          ? legacyIndexMatch[0]?.unitKey
          : null;
    if (!resolvedKey) {
      generalEvents.push(event);
      continue;
    }
    const matched = unitEvents.get(resolvedKey) || [];
    matched.push(event);
    unitEvents.set(resolvedKey, matched);
  }

  const units = unitRows
    .map(({ pageNumbersJson, ...unit }) => ({
      ...unit,
      pageNumbers: parseNumberArray(pageNumbersJson),
      events: unitEvents.get(unit.unitKey) || [],
    }))
    .sort((left, right) => {
      const leftSupplement = left.unitType === "supplement" ? 1 : 0;
      const rightSupplement = right.unitType === "supplement" ? 1 : 0;
      return (
        leftSupplement - rightSupplement ||
        (left.pageNumbers[0] ?? Number.MAX_SAFE_INTEGER) -
          (right.pageNumbers[0] ?? Number.MAX_SAFE_INTEGER) ||
        left.unitIndex - right.unitIndex ||
        left.id.localeCompare(right.id)
      );
    });
  return {
    job: publicJob,
    units,
    generalEvents,
    diagnostics: buildProcessingJobDiagnostics(publicJob, events, units),
  };
}
