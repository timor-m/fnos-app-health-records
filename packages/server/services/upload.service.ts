import { classifySystemError } from "../utils/api-error";
import { createHash } from "node:crypto";
import {
  closeSync, constants, fstatSync, mkdirSync, openSync, readSync, rmSync, statSync, writeFileSync, writeSync
} from "node:fs";
import { join } from "node:path";
import { createError } from "h3";
import { getDatabase } from "../database/client";
import type { RequestUser } from "../domain/request-user";
import { createId } from "../utils/identifier";
import { getAppConfig } from "../utils/runtime-config";
import { assertMemberAccess, assertMemberManage } from "./member.service";
import {
  deriveProcessingJobBatches, parseProcessingJobQueuedDetail,
  type ProcessingJobBatchSource, type ProcessingJobQueuedDetail
} from "./processing-job-batches.service";

const maxFileCount = 1000;
import { maxUploadFileBytes as maxFileBytes } from '../../shared/upload-limits';
const maxTotalBytes = 2 * 1024 * 1024 * 1024;
const pipelineVersion = "upload-v1";

export type UploadInputFile = {
  originalName: string;
  declaredType?: string;
  data: Uint8Array;
  rotation?: number;
};

export type LocalUploadInputFile = {
  originalName: string;
  sourcePath: string;
  rotation?: number;
};

type DetectedType = { mimeType: string; extension: string; kind: "image" | "pdf" };
type ValidatedUploadFile = {
  originalName: string;
  rotation: number;
  detected: DetectedType;
  fileSize: number;
  data?: Uint8Array;
  sourcePath?: string;
};

function startsWith(data: Uint8Array, bytes: number[]) {
  return bytes.every((byte, index) => data[index] === byte);
}

function ascii(data: Uint8Array, start: number, length: number) {
  return Buffer.from(data.subarray(start, start + length)).toString("ascii");
}

export function detectUploadType(data: Uint8Array): DetectedType | null {
  if (startsWith(data, [0xff, 0xd8, 0xff])) return { mimeType: "image/jpeg", extension: ".jpg", kind: "image" };
  if (startsWith(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { mimeType: "image/png", extension: ".png", kind: "image" };
  }
  if (ascii(data, 0, 4) === "RIFF" && ascii(data, 8, 4) === "WEBP") {
    return { mimeType: "image/webp", extension: ".webp", kind: "image" };
  }
  if (ascii(data, 0, 5) === "%PDF-") return { mimeType: "application/pdf", extension: ".pdf", kind: "pdf" };
  const heifBrand = ascii(data, 8, 4);
  if (ascii(data, 4, 4) === "ftyp" && ["heic", "heix", "hevc", "hevx", "mif1", "msf1"].includes(heifBrand)) {
    return { mimeType: "image/heic", extension: ".heic", kind: "image" };
  }
  return null;
}

function cleanOriginalName(value: string, index: number) {
  const name = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return (name || `第 ${index + 1} 页`).slice(0, 180);
}

function cleanRotation(value: number | undefined) {
  const rotation = Number(value || 0);
  if (![0, 90, 180, 270].includes(rotation)) {
    throw createError({ statusCode: 400, data: { code: "UPLOAD_INVALID" }, statusMessage: "页面旋转角度无效" });
  }
  return rotation;
}

function validateFiles(files: UploadInputFile[]) {
  if (!files.length) throw createError({ statusCode: 400, data: { code: "UPLOAD_INVALID" }, statusMessage: "请选择至少一个报告文件" });
  if (files.length > maxFileCount) {
    throw createError({ statusCode: 413, data: { code: "FILE_TOO_LARGE" }, statusMessage: `一次最多上传 ${maxFileCount} 个文件` });
  }
  let totalBytes = 0;
  return files.map((file, index) => {
    if (!file.data.byteLength) throw createError({ statusCode: 400, data: { code: "UPLOAD_INVALID" }, statusMessage: `第 ${index + 1} 个文件为空` });
    if (file.data.byteLength > maxFileBytes) {
      throw createError({ statusCode: 413, data: { code: "FILE_TOO_LARGE" }, statusMessage: `单个文件不能超过 ${maxFileBytes / 1024 / 1024} MB` });
    }
    totalBytes += file.data.byteLength;
    if (totalBytes > maxTotalBytes) {
      throw createError({ statusCode: 413, data: { code: "FILE_TOO_LARGE" }, statusMessage: `单次上传不能超过 ${maxTotalBytes / 1024 / 1024} MB` });
    }
    const detected = detectUploadType(file.data);
    if (!detected) {
      throw createError({ statusCode: 415, data: { code: "FILE_FORMAT_UNSUPPORTED" }, statusMessage: `不支持文件“${cleanOriginalName(file.originalName, index)}”的实际格式` });
    }
    return {
      ...file,
      originalName: cleanOriginalName(file.originalName, index),
      rotation: cleanRotation(file.rotation),
      fileSize: file.data.byteLength,
      detected
    };
  });
}

function readFileSignature(path: string) {
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const signature = Buffer.alloc(32);
    return signature.subarray(0, readSync(descriptor, signature, 0, signature.byteLength, 0));
  } finally {
    closeSync(descriptor);
  }
}

export function validateLocalFiles(files: LocalUploadInputFile[]): ValidatedUploadFile[] {
  if (!files.length) throw createError({ statusCode: 400, data: { code: "UPLOAD_INVALID" }, statusMessage: "请选择至少一个报告文件" });
  if (files.length > maxFileCount) {
    throw createError({ statusCode: 413, data: { code: "FILE_TOO_LARGE" }, statusMessage: `一次最多上传 ${maxFileCount} 个文件` });
  }
  let totalBytes = 0;
  return files.map((file, index) => {
    let stats: ReturnType<typeof statSync>;
    try {
      stats = statSync(file.sourcePath);
    } catch (cause) {
      if (classifySystemError(cause)) throw cause;
      throw createError({ statusCode: 409, data: { code: "UPLOAD_CONFLICT" }, statusMessage: `源文件“${cleanOriginalName(file.originalName, index)}”已不可读取，请重新选择` });
    }
    if (!stats.isFile()) throw createError({ statusCode: 400, data: { code: "UPLOAD_INVALID" }, statusMessage: `“${cleanOriginalName(file.originalName, index)}”不是普通文件` });
    if (!stats.size) throw createError({ statusCode: 400, data: { code: "UPLOAD_INVALID" }, statusMessage: `第 ${index + 1} 个文件为空` });
    if (stats.size > maxFileBytes) {
      throw createError({ statusCode: 413, data: { code: "FILE_TOO_LARGE" }, statusMessage: `单个文件不能超过 ${maxFileBytes / 1024 / 1024} MB` });
    }
    totalBytes += stats.size;
    if (totalBytes > maxTotalBytes) {
      throw createError({ statusCode: 413, data: { code: "FILE_TOO_LARGE" }, statusMessage: `单次上传不能超过 ${maxTotalBytes / 1024 / 1024} MB` });
    }
    let detected: DetectedType | null;
    try {
      detected = detectUploadType(readFileSignature(file.sourcePath));
    } catch (cause) {
      if (classifySystemError(cause)) throw cause;
      throw createError({ statusCode: 409, data: { code: "UPLOAD_CONFLICT" }, statusMessage: `源文件“${cleanOriginalName(file.originalName, index)}”已不可读取，请重新选择` });
    }
    if (!detected) {
      throw createError({ statusCode: 415, data: { code: "FILE_FORMAT_UNSUPPORTED" }, statusMessage: `不支持文件“${cleanOriginalName(file.originalName, index)}”的实际格式` });
    }
    return {
      originalName: cleanOriginalName(file.originalName, index),
      sourcePath: file.sourcePath,
      rotation: cleanRotation(file.rotation),
      fileSize: stats.size,
      detected
    };
  });
}

export function persistValidatedFile(file: ValidatedUploadFile, destination?: string) {
  if (file.data) {
    if (destination) writeFileSync(destination, file.data, { flag: "wx", mode: 0o600 });
    return createHash("sha256").update(file.data).digest("hex");
  }
  if (!file.sourcePath) throw new Error("Missing local import source path");

  const source = openSync(file.sourcePath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  let target: number | null = null;
  try {
    const sourceStats = fstatSync(source);
    if (!sourceStats.isFile() || sourceStats.size !== file.fileSize) {
      throw createError({ statusCode: 409, data: { code: "UPLOAD_CONFLICT" }, statusMessage: `源文件“${file.originalName}”已发生变化，请重新选择` });
    }
    if (destination) target = openSync(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    const hash = createHash("sha256");
    const chunk = Buffer.allocUnsafe(1024 * 1024);
    let copied = 0;
    while (true) {
      const bytesRead = readSync(source, chunk, 0, chunk.byteLength, null);
      if (!bytesRead) break;
      copied += bytesRead;
      if (copied > maxFileBytes || copied > file.fileSize) {
        throw createError({ statusCode: 409, data: { code: "UPLOAD_CONFLICT" }, statusMessage: `源文件“${file.originalName}”已发生变化，请重新选择` });
      }
      hash.update(chunk.subarray(0, bytesRead));
      let written = 0;
      while (target !== null && written < bytesRead) written += writeSync(target, chunk, written, bytesRead - written);
    }
    if (copied !== file.fileSize) {
      throw createError({ statusCode: 409, data: { code: "UPLOAD_CONFLICT" }, statusMessage: `源文件“${file.originalName}”已发生变化，请重新选择` });
    }
    return hash.digest("hex");
  } catch (error) {
    if (destination) { try { rmSync(destination, { force: true }); } catch { /* Preserve original failure. */ } }
    throw error;
  } finally {
    if (target !== null) closeSync(target);
    closeSync(source);
  }
}

function createValidatedUpload(
  user: RequestUser,
  memberId: string,
  validated: ValidatedUploadFile[],
  source: "browser_upload" | "nas_import",
  requestKey?: string
) {
  assertMemberManage(user, memberId);
  if (requestKey !== undefined && (typeof requestKey !== 'string' || !/^[a-zA-Z0-9_-]{16,100}$/.test(requestKey))) {
    throw createError({ statusCode: 400, data: { code: "UPLOAD_INVALID" }, statusMessage: "上传请求编号无效" });
  }
  const db = getDatabase();
  const readReceipt = () => requestKey ? db.prepare(
    'SELECT member_id, content_hash, report_id, response_json FROM upload_receipts WHERE user_id = ? AND request_key = ?'
  ).get(user.id, requestKey) as { member_id: string; content_hash: string; report_id: string | null; response_json: string } | undefined : undefined;
  const fingerprint = (files: Array<{sha256: string; originalName: string; rotation: number}>) =>
    createHash('sha256').update(JSON.stringify({ memberId, source, files: files.map(page => [page.sha256, page.originalName, page.rotation]) })).digest('hex');
  const receiptResult = (previous: NonNullable<ReturnType<typeof readReceipt>>, contentHash: string) => {
    if (previous.member_id !== memberId || previous.content_hash !== contentHash) throw createError({ statusCode: 409, data: { code: "UPLOAD_CONFLICT" }, statusMessage: '重试内容与原上传不一致，请重新创建上传任务' });
    if (!previous.report_id) throw createError({ statusCode: 409, data: { code: "UPLOAD_CONFLICT" }, statusMessage: '该上传对应的报告已删除，请重新创建上传任务' });
    return JSON.parse(previous.response_json) as UploadCreated;
  };
  const existing = readReceipt();
  if (existing) {
    // Hash the retry without creating another report directory or copying its files.
    return receiptResult(existing, fingerprint(validated.map(file => ({ ...file, sha256: persistValidatedFile(file) }))));
  }
  const reportTitle = "待识别报告";
  const reportId = createId("report");
  const relativeDirectory = join("reports", memberId, reportId);
  const absoluteDirectory = join(getAppConfig().storageDir, relativeDirectory);
  mkdirSync(absoluteDirectory, { recursive: true });

  try {
    const prepared = validated.map((file, index) => {
      const pageId = createId("page");
      const relativePath = join(relativeDirectory, `${pageId}${file.detected.extension}`);
      const sha256 = persistValidatedFile(file, join(getAppConfig().storageDir, relativePath));
      return {
        id: pageId,
        pageNumber: index + 1,
        originalName: file.originalName,
        storagePath: relativePath,
        mimeType: file.detected.mimeType,
        fileSize: file.fileSize,
        sha256,
        rotation: file.rotation,
        kind: file.detected.kind
      };
    });

    db.exec("BEGIN IMMEDIATE");
    const contentHash = fingerprint(prepared);
    // Another process may have committed the same key while files were being copied.
    const previous = readReceipt();
    if (previous) {
      const result = receiptResult(previous, contentHash);
      db.exec('COMMIT');
      rmSync(absoluteDirectory, { recursive: true, force: true });
      return result;
    }
    db.prepare(`
      INSERT INTO reports (id, member_id, created_by, report_type, title, status)
      VALUES (?, ?, ?, 'other', ?, 'queued')
    `).run(reportId, memberId, user.id, reportTitle);
    const insertPage = db.prepare(`
      INSERT INTO report_pages (
        id, report_id, page_number, original_name, storage_path, mime_type, file_size, sha256, rotation,
        source_page_number
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertJob = db.prepare(`
      INSERT INTO processing_jobs (
        id, report_id, page_id, job_type, pipeline_version, deduplication_key
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    const insertJobEvent = db.prepare(`
      INSERT INTO processing_job_events (
        id, job_id, report_id, event_type, status, attempt, detail_json
      ) VALUES (?, ?, ?, 'queued', 'queued', 0, ?)
    `);
    for (const page of prepared) {
      insertPage.run(
        page.id, reportId, page.pageNumber, page.originalName, page.storagePath,
        page.mimeType, page.fileSize, page.sha256, page.rotation, page.kind === "pdf" ? 1 : null
      );
      const jobTypes = page.kind === "pdf" ? ["pdf_extract", "thumbnail"] : ["thumbnail", "ocr"];
      for (const jobType of jobTypes) {
        const jobId = createId("job");
        insertJob.run(
          jobId, reportId, page.id, jobType, pipelineVersion,
          `${reportId}:${page.id}:${jobType}:${pipelineVersion}`
        );
        insertJobEvent.run(createId("event"), jobId, reportId, JSON.stringify({
          jobType,
          pageId: page.id,
          pageNumber: page.pageNumber,
          source: "upload"
        }));
      }
    }
    db.prepare(`
      INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, detail_json)
      VALUES (?, ?, 'report.upload', 'report', ?, ?)
    `).run(createId("audit"), user.id, reportId, JSON.stringify({
      memberId,
      source,
      fileCount: prepared.length,
      totalBytes: prepared.reduce((sum, page) => sum + page.fileSize, 0)
    }));
    const result = {
      reportId,
      memberId,
      status: "queued" as const,
      title: reportTitle,
      pageCount: prepared.length,
      jobCount: prepared.length * 2,
      pages: prepared.map(({ id, pageNumber, originalName, mimeType, fileSize, rotation }) => ({
        id, pageNumber, originalName, mimeType, fileSize, rotation
      }))
    };
    if (requestKey) db.prepare('INSERT INTO upload_receipts (user_id, request_key, member_id, content_hash, report_id, response_json) VALUES (?, ?, ?, ?, ?, ?)').run(user.id, requestKey, memberId, contentHash, reportId, JSON.stringify(result));
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* Transaction may not have started yet. */ }
    try { rmSync(absoluteDirectory, { recursive: true, force: true }); } catch { /* Preserve original failure. */ }
    throw error;
  }
}

type UploadCreated = { reportId: string; memberId: string; status: 'queued'; title: string; pageCount: number; jobCount: number; pages: Array<{ id: string; pageNumber: number; originalName: string; mimeType: string; fileSize: number; rotation: number }> };

export function createUpload(user: RequestUser, memberId: string, files: UploadInputFile[], requestKey?: string) {
  return createValidatedUpload(user, memberId, validateFiles(files), "browser_upload", requestKey);
}

export function createUploadFromLocalFiles(user: RequestUser, memberId: string, files: LocalUploadInputFile[], requestKey?: string) {
  return createValidatedUpload(user, memberId, validateLocalFiles(files), "nas_import", requestKey);
}

export function createUploadFromStagedFiles(user: RequestUser, memberId: string, files: LocalUploadInputFile[], requestKey?: string) {
  return createValidatedUpload(user, memberId, validateLocalFiles(files), "browser_upload", requestKey);
}


export function listProcessingJobs(user: RequestUser, reportId: string) {
  const db = getDatabase();
  const report = db.prepare("SELECT member_id AS memberId FROM reports WHERE id = ?").get(reportId) as
    | { memberId: string }
    | undefined;
  if (!report) throw createError({ statusCode: 404, statusMessage: "报告不存在" });
  assertMemberAccess(user, report.memberId);
  const jobs = db.prepare(`
    SELECT j.id, j.page_id AS pageId, p.page_number AS pageNumber, p.original_name AS originalName,
      j.job_type AS jobType, j.pipeline_version AS pipelineVersion,
      j.deduplication_key AS deduplicationKey, j.status, j.attempts,
      j.error_code AS errorCode, j.error_message AS errorMessage, j.created_at AS createdAt,
      j.rowid AS jobSequence, j.started_at AS startedAt, j.finished_at AS finishedAt,
      o.engine AS ocrEngine, o.model_version AS ocrModelVersion, o.elapsed_ms AS ocrElapsedMs,
      CASE
        WHEN o.text_length IS NOT NULL THEN o.text_length
        WHEN o.lines_json IS NOT NULL AND o.lines_json NOT IN ('', '[]') THEN 1
        ELSE 0
      END AS ocrTextLength,
      o.quality_level AS ocrQualityLevel,
      e.provider AS aiProvider, e.model AS aiModel, e.elapsed_ms AS aiElapsedMs,
      e.prompt_tokens AS promptTokens, e.completion_tokens AS completionTokens
    FROM processing_jobs j
    LEFT JOIN report_pages p ON p.id = j.page_id
    LEFT JOIN ocr_results o ON o.job_id = j.id
    LEFT JOIN report_extractions e ON e.job_id = j.id
    WHERE j.report_id = ?
    ORDER BY COALESCE(p.page_number, 999999), j.created_at, j.id
  `).all(reportId) as Array<Record<string, unknown> & {
    id: string;
    jobType: string;
    pipelineVersion: string;
    deduplicationKey: string;
    status: string;
    createdAt: string;
    jobSequence: number;
    ocrTextLength: number | null;
    errorCode: string | null;
    errorMessage: string | null;
  }>;
  const queuedEvents = db.prepare(`
    SELECT job_id AS jobId, detail_json AS detailJson
    FROM processing_job_events
    WHERE report_id = ? AND event_type = 'queued'
    ORDER BY created_at, rowid
  `).all(reportId) as Array<{ jobId: string; detailJson: string }>;
  const queuedEventDetails = new Map<string, ProcessingJobQueuedDetail>();
  for (const event of queuedEvents) {
    if (!queuedEventDetails.has(event.jobId)) queuedEventDetails.set(event.jobId, parseProcessingJobQueuedDetail(event.detailJson));
  }
  const jobBatches = deriveProcessingJobBatches(jobs as ProcessingJobBatchSource[], queuedEventDetails);
  const units = db.prepare(`
    SELECT job_id AS jobId, unit_type AS unitType, page_numbers_json AS pageNumbersJson,
      status, candidate_count AS candidateCount, matched_count AS matchedCount, unit_index AS unitIndex
    FROM ai_extraction_units
    WHERE report_id = ? AND status <> 'superseded'
    ORDER BY unit_index, id
  `).all(reportId) as Array<{
    jobId: string; unitType: string; pageNumbersJson: string; status: string;
    candidateCount: number; matchedCount: number; unitIndex: number;
  }>;
  const byJob = new Map<string, typeof units>();
  for (const unit of units) byJob.set(unit.jobId, [...(byJob.get(unit.jobId) || []), unit]);
  const aiAttempts = db.prepare(`
    SELECT job_id AS jobId, status, model, prompt_tokens AS promptTokens,
      completion_tokens AS completionTokens, elapsed_ms AS elapsedMs
    FROM ai_extraction_attempts
    WHERE report_id = ?
    ORDER BY created_at, id
  `).all(reportId) as Array<{
    jobId: string;
    status: string;
    model: string | null;
    promptTokens: number | null;
    completionTokens: number | null;
    elapsedMs: number | null;
  }>;
  const attemptsByJob = new Map<string, typeof aiAttempts>();
  for (const attempt of aiAttempts) {
    attemptsByJob.set(attempt.jobId, [...(attemptsByJob.get(attempt.jobId) || []), attempt]);
  }
  /* AI 整理任务级完成事件（detail 带 planHash 的那条）携带序号断档等规划期信号 */
  const aiCompletedEvents = db.prepare(`
    SELECT e.job_id AS jobId, e.detail_json AS detailJson
    FROM processing_job_events e
    JOIN processing_jobs j ON j.id = e.job_id
    WHERE e.report_id = ? AND e.event_type = 'completed' AND j.job_type = 'ai_extract'
      AND e.detail_json LIKE '%"planHash"%'
    ORDER BY e.created_at, e.rowid
  `).all(reportId) as Array<{ jobId: string; detailJson: string }>;
  const tableSerialGapPagesByJob = new Map<string, number[]>();
  for (const event of aiCompletedEvents) {
    try {
      const detail = JSON.parse(event.detailJson) as { tableSerialGapPages?: unknown };
      const pages = Array.isArray(detail.tableSerialGapPages)
        ? detail.tableSerialGapPages.filter((page): page is number => typeof page === "number" && Number.isFinite(page))
        : [];
      tableSerialGapPagesByJob.set(event.jobId, pages);
    } catch {
      // 事件详情解析失败时按无断档处理
    }
  }
  return jobs.map((job) => {
    const batch = jobBatches.get(job.id)!;
    const { deduplicationKey: _deduplicationKey, jobSequence: _jobSequence, ...visibleJob } = job;
    const failure = classifySystemError({ code: job.errorCode });
    if (failure && job.errorMessage) visibleJob.errorMessage = `${failure.message}\n错误码：${failure.code}`;
    if (job.jobType !== "ai_extract") return { ...visibleJob, ...batch };
    const jobUnits = byJob.get(job.id) || [];
    const jobAttempts = attemptsByJob.get(job.id) || [];
    const pageNumbers = (unit: typeof jobUnits[number]) => {
      try { return JSON.parse(unit.pageNumbersJson) as number[]; } catch { return []; }
    };
    const processing = jobUnits.filter((unit) => unit.status === "processing");
    const current = processing[0]
      || jobUnits.find((unit) => unit.status === "failed")
      || jobUnits.find((unit) => unit.status === "planned");
    const currentPages = processing.length
      ? [...new Set(processing.flatMap(pageNumbers))].sort((left, right) => left - right)
      : current ? pageNumbers(current) : [];
    const totalPages = new Set(jobUnits.flatMap(pageNumbers));
    const processedPages = new Set(jobUnits
      .filter((unit) => ["completed", "warning"].includes(unit.status))
      .flatMap(pageNumbers));
    return {
      ...visibleJob,
      ...batch,
      aiModel: jobAttempts.at(-1)?.model || job.aiModel || null,
      aiElapsedMs: jobAttempts.length
        ? jobAttempts.reduce((sum, attempt) => sum + (attempt.elapsedMs || 0), 0)
        : job.aiElapsedMs,
      promptTokens: jobAttempts.length
        ? jobAttempts.reduce((sum, attempt) => sum + (attempt.promptTokens || 0), 0)
        : job.promptTokens,
      completionTokens: jobAttempts.length
        ? jobAttempts.reduce((sum, attempt) => sum + (attempt.completionTokens || 0), 0)
        : job.completionTokens,
      aiRequestCount: jobAttempts.length,
      aiSuccessCount: jobAttempts.filter((attempt) => attempt.status === "completed").length,
      aiFailureCount: jobAttempts.filter((attempt) => attempt.status === "failed").length,
      plannedUnits: jobUnits.length,
      completedUnits: jobUnits.filter((unit) => unit.status === "completed").length,
      warningUnits: jobUnits.filter((unit) => unit.status === "warning").length,
      processedPages: processedPages.size,
      totalPages: totalPages.size,
      currentUnitType: current?.unitType || null,
      currentPages,
      unmatchedCandidates: jobUnits
        .filter((unit) => unit.unitType !== "supplement")
        .reduce((sum, unit) => sum + Math.max(0, unit.candidateCount - unit.matchedCount), 0),
      tableSerialGapPages: tableSerialGapPagesByJob.get(job.id) || []
    };
  });
}
