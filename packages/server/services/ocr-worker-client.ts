import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readSync,
  rmSync,
} from "node:fs";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createId } from "../utils/identifier";
import { writeLog } from "../utils/logger";
import { getAppConfig } from "../utils/runtime-config";

export type WorkerRequest = {
  action: "inspect_pdf" | "thumbnail" | "ocr" | "assemble_pdf";
  imagePath: string;
  mimeType?: string | null;
  outputPath?: string;
  pageNumber?: number | null;
  rotation?: number;
  maxSize?: number;
  quality?: number;
  renderScale?: number;
  pages?: Array<{
    path: string;
    mimeType: string;
    sourcePageNumber?: number | null;
    rotation?: number;
  }>;
  recycleAfterResponse?: boolean;
};

export type WorkerResponse = {
  ok: boolean;
  errorCode?: string;
  errorMessage?: string;
  pageCount?: number;
  pages?: Array<{ pageNumber: number; width: number; height: number }>;
  width?: number;
  height?: number;
  engine?: string;
  modelVersion?: string;
  lines?: Array<Record<string, unknown>>;
  coordWidth?: number;
  coordHeight?: number;
  engineElapsed?: unknown;
  elapsedMs?: number;
  outputPath?: string;
  workerRssBytes?: number;
  workerPeakRssBytes?: number;
  workerRequestCount?: number;
  workerOcrRequestCount?: number;
  recycleRecommended?: boolean;
  recycleReason?:
    "report_boundary" | "memory_high_water" | "request_limit" | null;
  workerHeartbeatCount?: number;
  workerLastHeartbeatElapsedMs?: number;
};

type PendingRequest = {
  resolve: (response: WorkerResponse) => void;
  reject: (error: Error) => void;
  inactivityTimer: NodeJS.Timeout;
  hardTimeoutTimer: NodeJS.Timeout;
  process: ChildProcessWithoutNullStreams;
  payload: WorkerRequest;
  heartbeatCount: number;
  lastHeartbeatElapsedMs?: number;
};

type WorkerEnvelope = Partial<WorkerResponse> & {
  id?: unknown;
  type?: unknown;
  action?: unknown;
};

let child: ChildProcessWithoutNullStreams | null = null;
let starting: Promise<void> | null = null;
let requestTail: Promise<void> = Promise.resolve();
let stopGeneration = 0;
const pending = new Map<string, PendingRequest>();
const liveProcesses = new Set<ChildProcessWithoutNullStreams>();
const terminatingProcesses = new WeakSet<ChildProcessWithoutNullStreams>();
const retiringProcesses = new WeakSet<ChildProcessWithoutNullStreams>();

function workerError(message: string, code = "OCR_WORKER_UNAVAILABLE") {
  return Object.assign(new Error(message), { code });
}

// onnxruntime prints this once per process when the sandboxed HOME is not
// writable and falls back to an in-memory telemetry identifier; OCR output is
// unaffected, so the line must not surface as a worker runtime warning.
const benignWorkerStderrPatterns = [/failed to persist telemetry device id/i];

function isBenignWorkerStderr(message: string) {
  return benignWorkerStderrPatterns.some((pattern) => pattern.test(message));
}

function rejectPending(
  error: Error,
  targetProcess?: ChildProcessWithoutNullStreams,
) {
  for (const [id, request] of pending.entries()) {
    if (targetProcess && request.process !== targetProcess) continue;
    clearTimeout(request.inactivityTimer);
    clearTimeout(request.hardTimeoutTimer);
    if (request.payload.outputPath) {
      cleanupInvalidOutputFile(request.payload.outputPath);
    }
    request.reject(error);
    pending.delete(id);
  }
}

function terminateWorkerProcess(
  process: ChildProcessWithoutNullStreams,
  error: Error,
) {
  if (child === process) child = null;
  rejectPending(error, process);
  if (process.exitCode !== null || process.signalCode !== null) {
    liveProcesses.delete(process);
    return;
  }
  if (terminatingProcesses.has(process)) return;
  terminatingProcesses.add(process);
  try {
    process.kill("SIGTERM");
  } catch {
    liveProcesses.delete(process);
    return;
  }
  const forceKillTimer = setTimeout(() => {
    if (process.exitCode !== null || process.signalCode !== null) return;
    try {
      process.kill("SIGKILL");
    } catch {
      liveProcesses.delete(process);
    }
  }, 5_000);
  forceKillTimer.unref();
  process.once("exit", () => clearTimeout(forceKillTimer));
}

function retireWorkerProcess(process: ChildProcessWithoutNullStreams) {
  if (child === process) child = null;
  if (process.exitCode !== null || process.signalCode !== null) {
    liveProcesses.delete(process);
    return;
  }
  if (retiringProcesses.has(process)) return;
  retiringProcesses.add(process);
  try {
    process.stdin.end();
  } catch {
    terminateWorkerProcess(
      process,
      workerError("OCR Worker 回收失败", "OCR_WORKER_RECYCLE_FAILED"),
    );
    return;
  }
  const forceRetireTimer = setTimeout(() => {
    if (process.exitCode !== null || process.signalCode !== null) return;
    terminateWorkerProcess(
      process,
      workerError("OCR Worker 回收超时", "OCR_WORKER_RECYCLE_TIMEOUT"),
    );
  }, 5_000);
  forceRetireTimer.unref();
  process.once("exit", () => clearTimeout(forceRetireTimer));
}

function workerRequestTimeoutMs() {
  const value = Number(process.env.OCR_WORKER_TIMEOUT_MS);
  if (!Number.isFinite(value)) return 2 * 60_000;
  return Math.min(30 * 60_000, Math.max(100, Math.round(value)));
}

function workerHardTimeoutMs(inactivityTimeoutMs: number) {
  const value = Number(process.env.OCR_WORKER_HARD_TIMEOUT_MS);
  const fallback = 30 * 60_000;
  const bounded = Number.isFinite(value)
    ? Math.min(60 * 60_000, Math.max(250, Math.round(value)))
    : fallback;
  return Math.max(inactivityTimeoutMs, bounded);
}

function workerStartupTimeoutMs() {
  const value = Number(process.env.OCR_WORKER_STARTUP_TIMEOUT_MS);
  if (!Number.isFinite(value)) return 20_000;
  return Math.min(60_000, Math.max(100, Math.round(value)));
}

function boundedWorkerLimit(
  environmentName: string,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  const value = Number(process.env[environmentName]);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.round(value)));
}

function workerMaxOutputLineBytes() {
  return boundedWorkerLimit(
    "OCR_WORKER_MAX_OUTPUT_LINE_BYTES",
    8 * 1024 * 1024,
    256,
    64 * 1024 * 1024,
  );
}

function workerMaxInputFileBytes() {
  return boundedWorkerLimit(
    "OCR_WORKER_MAX_INPUT_FILE_BYTES",
    40 * 1024 * 1024,
    1,
    1024 * 1024 * 1024,
  );
}

function workerMaxOutputFileBytes() {
  return boundedWorkerLimit(
    "OCR_WORKER_MAX_OUTPUT_FILE_BYTES",
    10 * 1024 * 1024,
    1,
    256 * 1024 * 1024,
  );
}

function workerMaxPdfPages() {
  return boundedWorkerLimit("OCR_WORKER_MAX_PDF_PAGES", 500, 1, 10_000);
}

function workerMaxPdfPageRenderPixels() {
  return boundedWorkerLimit(
    "OCR_WORKER_MAX_PDF_PAGE_RENDER_PIXELS",
    80_000_000,
    1_000_000,
    500_000_000,
  );
}

function workerPdfRenderScale() {
  const value = Number(process.env.OCR_PDF_RENDER_SCALE || 3);
  if (!Number.isFinite(value)) return 3;
  return Math.min(4, Math.max(2, value));
}

// 历史 OCR 结果未记录坐标系尺寸，读取端按当时的渲染比例把渲染像素坐标
// 折算回页面点坐标；与 worker 默认渲染比例保持同一处配置来源。
export function defaultOcrPdfRenderScale() {
  return workerPdfRenderScale();
}

function thumbnailMaxSize(payload: WorkerRequest) {
  const requested = Number(payload.maxSize || 480);
  const finite = Number.isFinite(requested) ? Math.round(requested) : 480;
  return Math.max(240, Math.min(2400, finite));
}

function workerMaxOcrLines() {
  return boundedWorkerLimit("OCR_WORKER_MAX_OCR_LINES", 10_000, 1, 100_000);
}

function workerMaxOcrLineCharacters() {
  return boundedWorkerLimit(
    "OCR_WORKER_MAX_OCR_LINE_CHARACTERS",
    16_000,
    16,
    1_000_000,
  );
}

function workerMaxOcrTotalCharacters() {
  return boundedWorkerLimit(
    "OCR_WORKER_MAX_OCR_TOTAL_CHARACTERS",
    2_000_000,
    64,
    16_000_000,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type ResponseValidation =
  | { response: WorkerResponse; error?: never }
  | { response?: never; error: Error };

function validateWorkerInputFile(payload: WorkerRequest) {
  if (!existsSync(payload.imagePath)) return;
  let stats;
  try {
    stats = lstatSync(payload.imagePath);
  } catch {
    throw workerError("OCR 输入文件无法读取", "OCR_WORKER_INPUT_INVALID");
  }
  if (!stats.isFile()) {
    throw workerError("OCR 输入路径不是普通文件", "OCR_WORKER_INPUT_INVALID");
  }
  if (stats.size < 1) {
    throw workerError("OCR 输入文件为空", "OCR_WORKER_INPUT_EMPTY");
  }
  if (stats.size > workerMaxInputFileBytes()) {
    throw workerError("OCR 输入文件超过安全限制", "OCR_WORKER_INPUT_TOO_LARGE");
  }
}

function cleanupInvalidOutputFile(path: string) {
  try {
    const stats = lstatSync(path);
    if (stats.isFile()) rmSync(path, { force: true });
  } catch {
    // Missing and concurrently removed output files need no further cleanup.
  }
}

function validateThumbnailOutputFile(payload: WorkerRequest) {
  if (!payload.outputPath) return;
  let stats;
  try {
    stats = lstatSync(payload.outputPath);
  } catch {
    throw workerError("缩略图输出文件未生成", "OCR_WORKER_OUTPUT_FILE_INVALID");
  }
  if (!stats.isFile() || stats.size < 3) {
    cleanupInvalidOutputFile(payload.outputPath);
    throw workerError("缩略图输出文件无效", "OCR_WORKER_OUTPUT_FILE_INVALID");
  }
  if (stats.size > workerMaxOutputFileBytes()) {
    cleanupInvalidOutputFile(payload.outputPath);
    throw workerError(
      "缩略图输出文件超过安全限制",
      "OCR_WORKER_OUTPUT_FILE_TOO_LARGE",
    );
  }

  const signature = Buffer.allocUnsafe(3);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(payload.outputPath, "r");
    const bytesRead = readSync(descriptor, signature, 0, 3, 0);
    if (
      bytesRead !== 3 ||
      signature[0] !== 0xff ||
      signature[1] !== 0xd8 ||
      signature[2] !== 0xff
    ) {
      throw new Error("invalid jpeg signature");
    }
  } catch {
    cleanupInvalidOutputFile(payload.outputPath);
    throw workerError(
      "缩略图输出不是有效 JPEG 文件",
      "OCR_WORKER_OUTPUT_FILE_INVALID",
    );
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function validatePdfOutputFile(payload: WorkerRequest) {
  if (!payload.outputPath) throw workerError("PDF 输出路径缺失", "OCR_WORKER_OUTPUT_FILE_INVALID");
  let stats;
  try {
    stats = lstatSync(payload.outputPath);
  } catch {
    throw workerError("PDF 输出文件未生成", "OCR_WORKER_OUTPUT_FILE_INVALID");
  }
  if (!stats.isFile() || stats.size < 5) {
    cleanupInvalidOutputFile(payload.outputPath);
    throw workerError("PDF 输出文件无效", "OCR_WORKER_OUTPUT_FILE_INVALID");
  }
  if (stats.size > workerMaxOutputFileBytes()) {
    cleanupInvalidOutputFile(payload.outputPath);
    throw workerError("PDF 输出文件超过安全限制", "OCR_WORKER_OUTPUT_FILE_TOO_LARGE");
  }
  const signature = Buffer.alloc(5);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(payload.outputPath, "r");
    const bytesRead = readSync(descriptor, signature, 0, signature.length, 0);
    if (bytesRead !== signature.length || signature.toString("ascii") !== "%PDF-") {
      cleanupInvalidOutputFile(payload.outputPath);
      throw workerError("PDF 输出文件格式无效", "OCR_WORKER_OUTPUT_FILE_INVALID");
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function validOcrBox(value: unknown) {
  if (!Array.isArray(value)) return false;
  if (
    value.length === 4 &&
    value.every(
      (coordinate) =>
        typeof coordinate === "number" && Number.isFinite(coordinate),
    )
  ) {
    return true;
  }
  return (
    value.length === 4 &&
    value.every(
      (point) =>
        Array.isArray(point) &&
        point.length >= 2 &&
        typeof point[0] === "number" &&
        Number.isFinite(point[0]) &&
        typeof point[1] === "number" &&
        Number.isFinite(point[1]),
    )
  );
}

function validateOcrResponse(response: WorkerEnvelope): ResponseValidation {
  if (!Array.isArray(response.lines)) {
    return {
      error: workerError("OCR 响应缺少文本行数组", "OCR_WORKER_PROTOCOL_ERROR"),
    };
  }
  if (response.lines.length > workerMaxOcrLines()) {
    return {
      error: workerError(
        "OCR 响应文本行数量超过安全限制",
        "OCR_WORKER_RESPONSE_LIMIT_EXCEEDED",
      ),
    };
  }

  let totalCharacters = 0;
  const usedIds = new Set<string>();
  const lines: Array<Record<string, unknown>> = [];
  for (const [index, rawLine] of response.lines.entries()) {
    if (!isRecord(rawLine) || typeof rawLine.text !== "string") {
      return {
        error: workerError(
          `OCR 响应第 ${index + 1} 行格式无效`,
          "OCR_WORKER_PROTOCOL_ERROR",
        ),
      };
    }
    if (rawLine.text.length > workerMaxOcrLineCharacters()) {
      return {
        error: workerError(
          `OCR 响应第 ${index + 1} 行文本超过安全限制`,
          "OCR_WORKER_RESPONSE_LIMIT_EXCEEDED",
        ),
      };
    }
    totalCharacters += rawLine.text.length;
    if (totalCharacters > workerMaxOcrTotalCharacters()) {
      return {
        error: workerError(
          "OCR 响应总文本量超过安全限制",
          "OCR_WORKER_RESPONSE_LIMIT_EXCEEDED",
        ),
      };
    }
    if (
      rawLine.confidence !== undefined &&
      (typeof rawLine.confidence !== "number" ||
        !Number.isFinite(rawLine.confidence) ||
        rawLine.confidence < 0 ||
        rawLine.confidence > 1)
    ) {
      return {
        error: workerError(
          `OCR 响应第 ${index + 1} 行置信度无效`,
          "OCR_WORKER_PROTOCOL_ERROR",
        ),
      };
    }
    if (
      rawLine.box !== undefined &&
      rawLine.box !== null &&
      !validOcrBox(rawLine.box)
    ) {
      return {
        error: workerError(
          `OCR 响应第 ${index + 1} 行坐标无效`,
          "OCR_WORKER_PROTOCOL_ERROR",
        ),
      };
    }
    if (rawLine.id !== undefined && typeof rawLine.id !== "string") {
      return {
        error: workerError(
          `OCR 响应第 ${index + 1} 行标识无效`,
          "OCR_WORKER_PROTOCOL_ERROR",
        ),
      };
    }
    const requestedId = typeof rawLine.id === "string" ? rawLine.id.trim() : "";
    if (requestedId.length > 256) {
      return {
        error: workerError(
          `OCR 响应第 ${index + 1} 行标识超过安全限制`,
          "OCR_WORKER_RESPONSE_LIMIT_EXCEEDED",
        ),
      };
    }
    let id = requestedId || `line_${index + 1}`;
    if (usedIds.has(id)) id = `line_${index + 1}`;
    while (usedIds.has(id)) id = `${id}_${index + 1}`;
    usedIds.add(id);

    const line: Record<string, unknown> = { id, text: rawLine.text };
    if (rawLine.tableUnsafe === true) line.tableUnsafe = true;
    if (isRecord(rawLine.tableDiagnostics)) {
      const { status, mapped, unsafe } = rawLine.tableDiagnostics;
      if (["disabled", "unavailable", "applied", "partial", "no_structure", "failed"].includes(String(status))
        && Number.isInteger(mapped) && Number(mapped) >= 0 && Number(mapped) <= workerMaxOcrLines()
        && Number.isInteger(unsafe) && Number(unsafe) >= 0 && Number(unsafe) <= workerMaxOcrLines()) {
        line.tableDiagnostics = { status, mapped, unsafe };
      }
    }
    if (validOcrTableCell(rawLine.tableCell)) {
      const { table, row, column, columns } = rawLine.tableCell;
      line.tableCell = { table, row, column, columns };
    }
    if (rawLine.confidence !== undefined) {
      line.confidence = rawLine.confidence;
    }
    if (rawLine.box !== undefined) line.box = rawLine.box;
    if (typeof rawLine.variant === "string" && rawLine.variant.length <= 64) {
      line.variant = rawLine.variant;
    }
    lines.push(line);
  }

  if (
    response.engine !== undefined &&
    (typeof response.engine !== "string" || response.engine.length > 128)
  ) {
    return {
      error: workerError("OCR 响应引擎标识无效", "OCR_WORKER_PROTOCOL_ERROR"),
    };
  }
  if (
    response.modelVersion !== undefined &&
    (typeof response.modelVersion !== "string" ||
      response.modelVersion.length > 128)
  ) {
    return {
      error: workerError("OCR 响应模型版本无效", "OCR_WORKER_PROTOCOL_ERROR"),
    };
  }
  if (
    response.elapsedMs !== undefined &&
    (typeof response.elapsedMs !== "number" ||
      !Number.isFinite(response.elapsedMs) ||
      response.elapsedMs < 0)
  ) {
    return {
      error: workerError("OCR 响应耗时无效", "OCR_WORKER_PROTOCOL_ERROR"),
    };
  }
  for (const field of ["coordWidth", "coordHeight"] as const) {
    const value = response[field];
    if (
      value !== undefined &&
      (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
    ) {
      return {
        error: workerError(
          `OCR 响应坐标系参考尺寸 ${field} 无效`,
          "OCR_WORKER_PROTOCOL_ERROR",
        ),
      };
    }
  }
  if (
    (response.coordWidth === undefined) !==
    (response.coordHeight === undefined)
  ) {
    return {
      error: workerError(
        "OCR 响应坐标系参考尺寸不完整",
        "OCR_WORKER_PROTOCOL_ERROR",
      ),
    };
  }

  return {
    response: {
      ...(response as WorkerResponse),
      lines,
    },
  };
}

function validateSuccessfulResponse(
  payload: WorkerRequest,
  response: WorkerEnvelope,
): ResponseValidation {
  for (const field of [
    "workerRssBytes",
    "workerPeakRssBytes",
    "workerRequestCount",
    "workerOcrRequestCount",
  ] as const) {
    const value = response[field];
    if (
      value !== undefined &&
      (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    ) {
      return {
        error: workerError(
          `OCR Worker 生命周期字段 ${field} 无效`,
          "OCR_WORKER_PROTOCOL_ERROR",
        ),
      };
    }
  }
  if (
    response.recycleRecommended !== undefined &&
    typeof response.recycleRecommended !== "boolean"
  ) {
    return {
      error: workerError(
        "OCR Worker 回收标记无效",
        "OCR_WORKER_PROTOCOL_ERROR",
      ),
    };
  }
  const allowedRecycleReasons = new Set([
    "report_boundary",
    "memory_high_water",
    "request_limit",
  ]);
  if (
    response.recycleReason !== undefined &&
    response.recycleReason !== null &&
    (typeof response.recycleReason !== "string" ||
      !allowedRecycleReasons.has(response.recycleReason))
  ) {
    return {
      error: workerError(
        "OCR Worker 回收原因无效",
        "OCR_WORKER_PROTOCOL_ERROR",
      ),
    };
  }
  if (response.recycleRecommended === true && !response.recycleReason) {
    return {
      error: workerError(
        "OCR Worker 回收响应缺少原因",
        "OCR_WORKER_PROTOCOL_ERROR",
      ),
    };
  }
  if (response.recycleRecommended !== true && response.recycleReason) {
    return {
      error: workerError(
        "OCR Worker 回收原因与标记不一致",
        "OCR_WORKER_PROTOCOL_ERROR",
      ),
    };
  }
  if (payload.action === "thumbnail") {
    if (
      !Number.isFinite(response.width) ||
      Number(response.width) <= 0 ||
      !Number.isFinite(response.height) ||
      Number(response.height) <= 0
    ) {
      if (payload.outputPath) cleanupInvalidOutputFile(payload.outputPath);
      return {
        error: workerError(
          "缩略图响应缺少有效尺寸",
          "OCR_WORKER_PROTOCOL_ERROR",
        ),
      };
    }
    const maxSize = thumbnailMaxSize(payload);
    if (Number(response.width) > maxSize || Number(response.height) > maxSize) {
      cleanupInvalidOutputFile(payload.outputPath || "");
      return {
        error: workerError(
          "缩略图响应尺寸超过请求限制",
          "OCR_WORKER_PROTOCOL_ERROR",
        ),
      };
    }
    try {
      validateThumbnailOutputFile(payload);
    } catch (error) {
      return { error: error as Error };
    }
  } else if (payload.action === "assemble_pdf") {
    try {
      validatePdfOutputFile(payload);
    } catch (error) {
      return { error: error as Error };
    }
  } else if (payload.action === "ocr") {
    return validateOcrResponse(response);
  } else {
    if (
      !Number.isInteger(response.pageCount) ||
      Number(response.pageCount) < 1 ||
      Number(response.pageCount) > workerMaxPdfPages() ||
      !Array.isArray(response.pages) ||
      response.pages.length !== Number(response.pageCount)
    ) {
      return {
        error: workerError(
          "PDF 检查响应缺少有效页数或完整页面清单",
          "OCR_WORKER_PROTOCOL_ERROR",
        ),
      };
    }
    const renderScale = workerPdfRenderScale();
    const maxRenderPixels = workerMaxPdfPageRenderPixels();
    for (const [index, page] of response.pages.entries()) {
      if (
        !isRecord(page) ||
        page.pageNumber !== index + 1 ||
        typeof page.width !== "number" ||
        !Number.isFinite(page.width) ||
        page.width <= 0 ||
        typeof page.height !== "number" ||
        !Number.isFinite(page.height) ||
        page.height <= 0
      ) {
        return {
          error: workerError(
            `PDF 检查响应第 ${index + 1} 页尺寸或页码无效`,
            "OCR_WORKER_PROTOCOL_ERROR",
          ),
        };
      }
      if (
        page.width * page.height * renderScale * renderScale >
        maxRenderPixels
      ) {
        return {
          error: workerError(
            `PDF 检查响应第 ${index + 1} 页尺寸超过安全限制`,
            "OCR_WORKER_RESPONSE_LIMIT_EXCEEDED",
          ),
        };
      }
    }
  }
  return { response: response as WorkerResponse };
}

async function startWorker() {
  if (starting) return starting;
  if (child) return;
  starting = new Promise<void>((resolve, reject) => {
    const config = getAppConfig();
    if (
      !existsSync(config.ocrPythonBin) ||
      !existsSync(config.ocrWorkerScript)
    ) {
      reject(workerError("OCR 运行环境尚未安装"));
      return;
    }
    const process = spawn(config.ocrPythonBin, [config.ocrWorkerScript], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...globalThis.process.env, STORAGE_DIR: config.runtimeDir },
    });
    child = process;
    liveProcesses.add(process);
    let startupSettled = false;
    const settleStartup = (error?: Error) => {
      if (startupSettled) return;
      startupSettled = true;
      clearTimeout(startupTimer);
      if (error) reject(error);
      else resolve();
    };
    const startupTimer = setTimeout(() => {
      const error = workerError(
        "OCR Worker 启动超时",
        "OCR_WORKER_STARTUP_TIMEOUT",
      );
      terminateWorkerProcess(process, error);
      settleStartup(error);
    }, workerStartupTimeoutMs());
    const maxOutputLineBytes = workerMaxOutputLineBytes();
    let outputBuffer = "";
    let invalidOutputLogCount = 0;
    let invalidOutputSuppressed = false;
    let stderrLogCount = 0;
    let stderrSuppressed = false;
    const writeLimitedWorkerLog = (
      kind: "invalid-output" | "stderr",
      extra?: Record<string, unknown>,
    ) => {
      const isInvalidOutput = kind === "invalid-output";
      const count = isInvalidOutput ? invalidOutputLogCount : stderrLogCount;
      if (count < 5) {
        if (isInvalidOutput) invalidOutputLogCount += 1;
        else stderrLogCount += 1;
        void writeLog(
          "warn",
          isInvalidOutput ? "ocr-worker-invalid-output" : "ocr-worker-stderr",
          extra,
        );
        return;
      }
      const suppressed = isInvalidOutput
        ? invalidOutputSuppressed
        : stderrSuppressed;
      if (suppressed) return;
      if (isInvalidOutput) invalidOutputSuppressed = true;
      else stderrSuppressed = true;
      void writeLog(
        "warn",
        isInvalidOutput
          ? "ocr-worker-invalid-output-suppressed"
          : "ocr-worker-stderr-suppressed",
        { limit: 5 },
      );
    };
    const failOversizedOutput = () => {
      const error = workerError(
        "OCR Worker 输出超过单行安全限制",
        "OCR_WORKER_OUTPUT_TOO_LARGE",
      );
      outputBuffer = "";
      terminateWorkerProcess(process, error);
      settleStartup(error);
    };
    const failPendingRequest = (
      id: string,
      request: PendingRequest,
      error: Error,
    ) => {
      if (pending.get(id) !== request) return;
      pending.delete(id);
      clearTimeout(request.inactivityTimer);
      clearTimeout(request.hardTimeoutTimer);
      request.reject(error);
      terminateWorkerProcess(process, error);
    };
    const armInactivityTimer = (id: string, request: PendingRequest) => {
      clearTimeout(request.inactivityTimer);
      request.inactivityTimer = setTimeout(() => {
        failPendingRequest(
          id,
          request,
          workerError(
            "Worker 长时间没有响应，OCR 进程已重新启动",
            "WORKER_TIMEOUT",
          ),
        );
      }, workerRequestTimeoutMs());
      request.inactivityTimer.unref();
    };
    const handleOutputLine = (line: string) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        writeLimitedWorkerLog("invalid-output");
        return;
      }
      if (!isRecord(parsed)) {
        writeLimitedWorkerLog("invalid-output");
        return;
      }
      const response = parsed as WorkerEnvelope;
      if (response.type === "ready") {
        if (typeof response.ok !== "boolean") {
          const error = workerError(
            "OCR Worker 启动响应格式无效",
            "OCR_WORKER_PROTOCOL_ERROR",
          );
          terminateWorkerProcess(process, error);
          settleStartup(error);
        } else if (response.ok) {
          settleStartup();
        } else {
          const error = workerError(
            typeof response.errorMessage === "string"
              ? response.errorMessage.slice(0, 2_000)
              : "OCR Worker 启动失败",
            typeof response.errorCode === "string" &&
              response.errorCode.length <= 128
              ? response.errorCode
              : "OCR_WORKER_START_FAILED",
          );
          terminateWorkerProcess(process, error);
          settleStartup(error);
        }
        return;
      }
      if (response.type === "heartbeat") {
        if (typeof response.id !== "string" || !response.id) {
          writeLimitedWorkerLog("invalid-output");
          return;
        }
        const request = pending.get(response.id);
        if (!request || request.process !== process) return;
        if (
          typeof response.elapsedMs !== "number" ||
          !Number.isSafeInteger(response.elapsedMs) ||
          response.elapsedMs < 0 ||
          (response.action !== undefined &&
            response.action !== request.payload.action)
        ) {
          const error = workerError(
            "OCR Worker 心跳响应格式无效",
            "OCR_WORKER_PROTOCOL_ERROR",
          );
          failPendingRequest(response.id, request, error);
          return;
        }
        request.heartbeatCount += 1;
        request.lastHeartbeatElapsedMs = response.elapsedMs;
        armInactivityTimer(response.id, request);
        return;
      }
      if (typeof response.id !== "string" || !response.id) {
        writeLimitedWorkerLog("invalid-output");
        return;
      }
      const request = pending.get(response.id);
      if (!request || request.process !== process) return;
      pending.delete(response.id);
      clearTimeout(request.inactivityTimer);
      clearTimeout(request.hardTimeoutTimer);
      if (typeof response.ok !== "boolean") {
        const error = workerError(
          "OCR Worker 响应格式无效",
          "OCR_WORKER_PROTOCOL_ERROR",
        );
        request.reject(error);
        terminateWorkerProcess(process, error);
        return;
      }
      if (response.ok) {
        const validation = validateSuccessfulResponse(
          request.payload,
          response,
        );
        if (validation.error) {
          request.reject(validation.error);
          terminateWorkerProcess(process, validation.error);
          return;
        }
        if (
          request.payload.recycleAfterResponse ||
          validation.response.recycleRecommended
        ) {
          retireWorkerProcess(process);
        }
        request.resolve({
          ...validation.response,
          workerHeartbeatCount: request.heartbeatCount,
          workerLastHeartbeatElapsedMs: request.lastHeartbeatElapsedMs,
        });
      } else {
        if (request.payload.outputPath) {
          cleanupInvalidOutputFile(request.payload.outputPath);
        }
        request.reject(
          workerError(
            typeof response.errorMessage === "string"
              ? response.errorMessage.slice(0, 2_000)
              : "Worker 任务失败",
            typeof response.errorCode === "string" &&
              response.errorCode.length <= 128
              ? response.errorCode
              : "WORKER_TASK_FAILED",
          ),
        );
      }
    };
    process.stdout.setEncoding("utf8");
    process.stdout.on("data", (chunk: string) => {
      if (terminatingProcesses.has(process)) return;
      outputBuffer += chunk;
      while (true) {
        const newlineIndex = outputBuffer.indexOf("\n");
        if (newlineIndex < 0) {
          if (Buffer.byteLength(outputBuffer, "utf8") > maxOutputLineBytes) {
            failOversizedOutput();
          }
          return;
        }
        let line = outputBuffer.slice(0, newlineIndex);
        outputBuffer = outputBuffer.slice(newlineIndex + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (Buffer.byteLength(line, "utf8") > maxOutputLineBytes) {
          failOversizedOutput();
          return;
        }
        handleOutputLine(line);
        if (terminatingProcesses.has(process)) return;
      }
    });
    process.stderr.on("data", (chunk) => {
      const messages = String(chunk)
        .split(/\r?\n/)
        .map((message) => message.trim())
        .filter(Boolean);
      for (const message of messages) {
        if (isBenignWorkerStderr(message)) continue;
        writeLimitedWorkerLog("stderr", { message: message.slice(0, 1_000) });
      }
    });
    process.once("error", (error) => {
      const wrapped = workerError(
        `OCR Worker 进程启动失败：${error.message}`,
        "OCR_WORKER_START_FAILED",
      );
      terminateWorkerProcess(process, wrapped);
      settleStartup(wrapped);
    });
    process.once("exit", (code, signal) => {
      liveProcesses.delete(process);
      const error = workerError(
        `OCR Worker 已退出（${code ?? signal ?? "unknown"}）`,
        "OCR_WORKER_EXITED",
      );
      if (child === process) child = null;
      rejectPending(error, process);
      settleStartup(error);
    });
  }).finally(() => {
    starting = null;
  });
  return starting;
}

async function executeWorkerRequest(payload: WorkerRequest) {
  validateWorkerInputFile(payload);
  await startWorker();
  if (!child) throw workerError("OCR Worker 不可用");
  const process = child;
  const id = createId("worker");
  try {
    return await new Promise<WorkerResponse>((resolve, reject) => {
      const inactivityTimeoutMs = workerRequestTimeoutMs();
      const request = {
        resolve,
        reject,
        inactivityTimer: setTimeout(() => undefined, 0),
        hardTimeoutTimer: setTimeout(() => undefined, 0),
        process,
        payload,
        heartbeatCount: 0,
      } satisfies PendingRequest;
      clearTimeout(request.inactivityTimer);
      clearTimeout(request.hardTimeoutTimer);
      const failRequest = (error: Error) => {
        if (pending.get(id) !== request) return;
        pending.delete(id);
        clearTimeout(request.inactivityTimer);
        clearTimeout(request.hardTimeoutTimer);
        reject(error);
        terminateWorkerProcess(process, error);
      };
      const armInactivityTimer = () => {
        clearTimeout(request.inactivityTimer);
        request.inactivityTimer = setTimeout(() => {
          failRequest(
            workerError(
              "Worker 长时间没有响应，OCR 进程已重新启动",
              "WORKER_TIMEOUT",
            ),
          );
        }, inactivityTimeoutMs);
        request.inactivityTimer.unref();
      };
      armInactivityTimer();
      request.hardTimeoutTimer = setTimeout(() => {
        failRequest(
          workerError(
            "Worker 已超过单任务最长执行时间，OCR 进程已重新启动",
            "OCR_WORKER_HARD_TIMEOUT",
          ),
        );
      }, workerHardTimeoutMs(inactivityTimeoutMs));
      request.hardTimeoutTimer.unref();
      pending.set(id, request);
      process.stdin.write(
        `${JSON.stringify({ id, ...payload })}\n`,
        (error) => {
          if (!error) return;
          const wrapped = workerError(
            `OCR Worker 请求写入失败：${error.message}`,
            "OCR_WORKER_WRITE_FAILED",
          );
          failRequest(wrapped);
        },
      );
    });
  } finally {
    if (payload.recycleAfterResponse && child === process) {
      retireWorkerProcess(process);
    }
  }
}

export function requestWorker(payload: WorkerRequest) {
  const generation = stopGeneration;
  const task = requestTail.then(async () => {
    if (generation !== stopGeneration) {
      throw workerError("OCR Worker 已停止", "OCR_WORKER_STOPPED");
    }
    return executeWorkerRequest(payload);
  });
  requestTail = task.then(
    () => undefined,
    () => undefined,
  );
  return task;
}

export function stopWorker() {
  stopGeneration += 1;
  const error = workerError("OCR Worker 已停止", "OCR_WORKER_STOPPED");
  child = null;
  for (const process of [...liveProcesses]) {
    terminateWorkerProcess(process, error);
  }
}

process.once("exit", stopWorker);
import { validOcrTableCell } from "./ocr-table-structure";
