import { appendFile, chmod, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAppConfig } from "./runtime-config";

const defaultMaxFileBytes = 10 * 1024 * 1024;
const defaultMaxArchiveFiles = 2;
let debugLogQueue = Promise.resolve();

function boundedInteger(value: string | undefined, fallback: number, minimum: number, maximum: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.round(parsed)));
}

function booleanSetting(value: string | undefined, fallback: boolean) {
  if (value === undefined || value.trim() === "") return fallback;
  return !["0", "false", "off", "no"].includes(value.trim().toLowerCase());
}

export function isAiInputDebugLogEnabled() {
  const isDevelopment = process.env.NODE_ENV === "development" || Boolean(process.env.VITE_DEV_SERVER_URL);
  return booleanSetting(process.env.AI_INPUT_DEBUG_LOG, isDevelopment);
}

export function getAiInputDebugLogPolicy() {
  const config = getAppConfig();
  return {
    filePath: join(config.logDir, "ai-input-debug.log"),
    maxFileBytes: boundedInteger(
      process.env.AI_INPUT_DEBUG_LOG_MAX_BYTES,
      defaultMaxFileBytes,
      256 * 1024,
      100 * 1024 * 1024
    ),
    maxArchiveFiles: boundedInteger(
      process.env.AI_INPUT_DEBUG_LOG_MAX_FILES,
      defaultMaxArchiveFiles,
      1,
      10
    )
  };
}

async function rotateIfNeeded(
  policy: ReturnType<typeof getAiInputDebugLogPolicy>,
  incomingBytes: number
) {
  let currentBytes = 0;
  try {
    currentBytes = (await stat(policy.filePath)).size;
  } catch {
    return;
  }
  if (currentBytes + incomingBytes <= policy.maxFileBytes) return;

  await rm(`${policy.filePath}.${policy.maxArchiveFiles}`, { force: true });
  for (let index = policy.maxArchiveFiles - 1; index >= 1; index -= 1) {
    try {
      await rename(`${policy.filePath}.${index}`, `${policy.filePath}.${index + 1}`);
    } catch {
      // Missing archive slots are expected.
    }
  }
  try {
    await rename(policy.filePath, `${policy.filePath}.1`);
  } catch {
    // Another writer may already have rotated the current file.
  }

  const entries = await readdir(dirname(policy.filePath), { withFileTypes: true });
  await Promise.all(entries
    .filter((entry) => entry.isFile() && /^ai-input-debug\.log\.\d+$/.test(entry.name))
    .filter((entry) => Number(entry.name.slice("ai-input-debug.log.".length)) > policy.maxArchiveFiles)
    .map((entry) => rm(join(dirname(policy.filePath), entry.name), { force: true })));
}

export type AiInputDebugEntry = {
  requestId?: string;
  provider: string;
  model: string;
  promptVersion: string;
  inputCharacters: number;
  pageCount: number;
  plannedUnits?: number;
  planHash?: string;
  compatibilityTruncated?: boolean;
  unitKey?: string;
  unitType?: string;
  pageNumbers?: number[];
  promptMode?: string;
  route?: string;
  primaryContentType?: string;
  contentTypes?: string[];
  classificationConfidence?: number;
  documentContentType?: string;
  requestBody: Record<string, unknown>;
};

export type AiOutputDebugEntry = {
  requestId: string;
  provider: string;
  model: string;
  status: "completed" | "failed";
  responseContent?: string;
  finishReason?: string | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  elapsedMs?: number | null;
  errorCode?: string;
  upstreamStatus?: number;
};

async function appendDebugBlock(kind: "AI INPUT" | "AI OUTPUT", entry: Record<string, unknown>, summary: Record<string, unknown>) {
  if (!isAiInputDebugLogEnabled()) return;
  const operation = async () => {
    try {
      const policy = getAiInputDebugLogPolicy();
      const timestamp = new Date().toISOString();
      let serialized = JSON.stringify(entry, null, 2);
      if (Buffer.byteLength(serialized, "utf8") > policy.maxFileBytes) {
        serialized = JSON.stringify(summary, null, 2);
      }
      const content = [`===== ${kind} ${timestamp} =====`, serialized, `===== END ${kind} =====`, ""].join("\n");
      const incomingBytes = Buffer.byteLength(content, "utf8");
      await mkdir(dirname(policy.filePath), { recursive: true });
      await rotateIfNeeded(policy, incomingBytes);
      await appendFile(policy.filePath, content, { encoding: "utf8", mode: 0o600 });
      await chmod(policy.filePath, 0o600);
    } catch {
      // Debug logging must never interrupt report processing.
    }
  };
  const result = debugLogQueue.then(operation, operation);
  debugLogQueue = result.then(() => undefined, () => undefined);
  await result;
}

export async function writeAiInputDebugLog(entry: AiInputDebugEntry) {
  await appendDebugBlock("AI INPUT", entry as unknown as Record<string, unknown>, {
    requestId: entry.requestId, provider: entry.provider, model: entry.model,
    promptVersion: entry.promptVersion, inputCharacters: entry.inputCharacters,
    pageCount: entry.pageCount, plannedUnits: entry.plannedUnits,
    planHash: entry.planHash, compatibilityTruncated: entry.compatibilityTruncated,
    omitted: true, reason: "AI 请求体超过调试日志单条大小上限"
  });
}

export async function writeAiOutputDebugLog(entry: AiOutputDebugEntry) {
  await appendDebugBlock("AI OUTPUT", entry as unknown as Record<string, unknown>, {
    requestId: entry.requestId, provider: entry.provider, model: entry.model,
    status: entry.status, finishReason: entry.finishReason,
    promptTokens: entry.promptTokens, completionTokens: entry.completionTokens,
    elapsedMs: entry.elapsedMs, errorCode: entry.errorCode,
    upstreamStatus: entry.upstreamStatus, omitted: true,
    reason: "AI 响应内容超过调试日志单条大小上限"
  });
}
