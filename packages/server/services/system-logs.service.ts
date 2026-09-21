import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { createError } from "h3";
import { getDatabase } from "../database/client";
import { isAdministrator, type RequestUser } from "../domain/request-user";
import {
  clearSystemLogFiles,
  getLogRotationPolicy,
  redactLogText,
  writeLog,
  type LogLevel
} from "../utils/logger";
import { createId } from "../utils/identifier";

type SystemLogFilter = "important" | "all";

type RawSystemLog = {
  id?: unknown;
  ts?: unknown;
  level?: unknown;
  message?: unknown;
  extra?: unknown;
};

type SystemLogItem = {
  id: string;
  timestamp: string;
  level: LogLevel;
  category: string;
  title: string;
  detail: string;
  metadata: string[];
};

type SystemLogCursor = {
  timestamp: string;
  id: string;
};

function requireAdmin(user: RequestUser) {
  if (!user.authenticated) throw createError({ statusCode: 401, statusMessage: "请先登录" });
  if (!isAdministrator(user)) throw createError({ statusCode: 403, statusMessage: "仅管理员可查看系统日志" });
}

function requireAuthenticated(user: RequestUser) {
  if (!user.authenticated) throw createError({ statusCode: 401, statusMessage: "请先登录" });
}

function encodeCursor(cursor: SystemLogCursor) {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decodeCursor(value?: string): SystemLogCursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<SystemLogCursor>;
    return typeof parsed.timestamp === "string" && typeof parsed.id === "string"
      ? { timestamp: parsed.timestamp, id: parsed.id }
      : null;
  } catch {
    return null;
  }
}

function safeLevel(value: unknown): LogLevel {
  return value === "error" || value === "warn" ? value : "info";
}

function safeRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function safeText(value: unknown, maxLength = 300) {
  return redactLogText(value)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function stringValue(extra: Record<string, unknown>, key: string) {
  const value = extra[key];
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

function classifyLog(
  id: string,
  timestamp: string,
  level: LogLevel,
  message: string,
  extra: Record<string, unknown>
): SystemLogItem {
  const base = { id, timestamp, level };
  const method = stringValue(extra, "method").toUpperCase();
  const path = stringValue(extra, "route") || stringValue(extra, "path");
  const errorId = stringValue(extra, "errorId");
  const statusCode = stringValue(extra, "statusCode") || stringValue(extra, "upstreamStatus");
  const durationMs = stringValue(extra, "durationMs");
  const provider = stringValue(extra, "provider");
  const model = stringValue(extra, "model");
  const errorCode = stringValue(extra, "errorCode");

  if (message === "request") {
    return {
      ...base,
      category: "HTTP",
      title: level === "error" ? "接口请求失败" : "接口请求被拒绝",
      detail: [method, safeText(path)].filter(Boolean).join(" "),
      metadata: [
        statusCode ? `状态 ${statusCode}` : "",
        durationMs ? `耗时 ${durationMs} ms` : "",
        errorId ? `问题编号 ${safeText(errorId, 80)}` : ""
      ].filter(Boolean)
    };
  }
  if (message === "unhandled-request-error") {
    const errorType = safeText(extra.detail).match(/\b([A-Za-z][A-Za-z0-9.]*Error)\b/)?.[1] || "未知异常";
    return {
      ...base,
      category: "服务端",
      title: "服务请求异常",
      detail: [method, safeText(path)].filter(Boolean).join(" "),
      metadata: [
        statusCode ? `状态 ${statusCode}` : "",
        errorCode ? `错误码 ${safeText(errorCode, 80)}` : `异常类型 ${errorType}`,
        errorId ? `问题编号 ${safeText(errorId, 80)}` : "",
        stringValue(extra, "nativeCode") ? `系统码 ${safeText(extra.nativeCode, 80)}` : "",
        stringValue(extra, "sqliteCode") ? `SQLite ${safeText(extra.sqliteCode, 20)}` : ""
      ].filter(Boolean)
    };
  }
  if (message === "ai-connection-test-failed" || message === "ai-connection-test-rejected") {
    return {
      ...base,
      category: "AI",
      title: message.endsWith("rejected") ? "AI 服务拒绝连接测试" : "AI 连接测试失败",
      detail: safeText(extra.detail),
      metadata: [
        provider ? `服务商 ${safeText(provider, 80)}` : "",
        model ? `模型 ${safeText(model, 80)}` : "",
        statusCode ? `上游状态 ${statusCode}` : "",
        errorCode ? `错误码 ${safeText(errorCode, 80)}` : ""
      ].filter(Boolean)
    };
  }
  if (message === "processing-job-failed") {
    return {
      ...base,
      category: "任务",
      title: "报告处理任务失败",
      detail: safeText(extra.error),
      metadata: []
    };
  }
  if (message === "ocr-worker-invalid-output" || message === "ocr-worker-stderr") {
    return {
      ...base,
      category: "OCR Worker",
      title: message.endsWith("invalid-output") ? "OCR Worker 返回内容无效" : "OCR Worker 运行异常",
      detail: safeText(extra.message),
      metadata: []
    };
  }
  if (message === "client-unhandled-error") {
    return {
      ...base,
      category: "前端",
      title: "页面发生未处理异常",
      detail: safeText(extra.detail),
      metadata: []
    };
  }
  return {
    ...base,
    category: "系统",
    title: safeText(message, 80) || "系统事件",
    detail: "",
    metadata: []
  };
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function logFiles() {
  const policy = getLogRotationPolicy();
  try {
    const baseName = basename(policy.filePath);
    const archivePattern = new RegExp(`^${escapeRegex(baseName)}\\.\\d+$`);
    const entries = await readdir(dirname(policy.filePath), { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && (entry.name === baseName || archivePattern.test(entry.name)))
      .map((entry) => join(dirname(policy.filePath), entry.name));
  } catch {
    return [];
  }
}

async function readLogItems(files: string[]) {
  const items: SystemLogItem[] = [];
  for (const filePath of files) {
    let content = "";
    try {
      content = await readFile(filePath, "utf8");
    } catch {
      continue;
    }
    for (const line of content.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const raw = JSON.parse(line) as RawSystemLog;
        const timestamp = typeof raw.ts === "string" && !Number.isNaN(Date.parse(raw.ts)) ? raw.ts : "";
        if (!timestamp) continue;
        const id = typeof raw.id === "string" && raw.id
          ? raw.id
          : `legacy_${createHash("sha256").update(line).digest("hex").slice(0, 24)}`;
        items.push(classifyLog(
          id,
          timestamp,
          safeLevel(raw.level),
          typeof raw.message === "string" ? raw.message : "",
          safeRecord(raw.extra)
        ));
      } catch {
        // Ignore partially written or historical non-JSON lines.
      }
    }
  }
  return items;
}

async function logStats(files: string[]) {
  const policy = getLogRotationPolicy();
  const sizes = await Promise.all(files.map(async (filePath) => {
    try {
      return { name: basename(filePath), size: (await stat(filePath)).size };
    } catch {
      return { name: basename(filePath), size: 0 };
    }
  }));
  const currentName = basename(policy.filePath);
  return {
    totalBytes: sizes.reduce((sum, item) => sum + item.size, 0),
    currentFileBytes: sizes.find((item) => item.name === currentName)?.size || 0,
    fileCount: sizes.length,
    archiveCount: sizes.filter((item) => item.name !== currentName).length,
    maxFileBytes: policy.maxFileBytes,
    maxArchiveFiles: policy.maxArchiveFiles,
    maxTotalBytes: policy.maxTotalBytes
  };
}

export async function listSystemLogs(
  user: RequestUser,
  options: { limit?: number; cursor?: string; filter?: string } = {}
) {
  requireAdmin(user);
  const safeLimit = Math.min(100, Math.max(1, Math.round(options.limit || 30)));
  const filter: SystemLogFilter = options.filter === "all" ? "all" : "important";
  const cursor = decodeCursor(options.cursor);
  const files = await logFiles();
  const items = (await readLogItems(files))
    .filter((item) => filter === "all" || item.level === "warn" || item.level === "error")
    .filter((item) => !cursor
      || item.timestamp < cursor.timestamp
      || (item.timestamp === cursor.timestamp && item.id < cursor.id))
    .sort((left, right) => right.timestamp.localeCompare(left.timestamp) || right.id.localeCompare(left.id));
  const pageItems = items.slice(0, safeLimit);
  const hasMore = items.length > safeLimit;
  const last = pageItems.at(-1);
  return {
    items: pageItems,
    nextCursor: hasMore && last ? encodeCursor({ timestamp: last.timestamp, id: last.id }) : null,
    hasMore,
    filter,
    stats: await logStats(files)
  };
}

export async function clearSystemLogs(user: RequestUser) {
  requireAdmin(user);
  const result = await clearSystemLogFiles();
  getDatabase().prepare(`
    INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, detail_json)
    VALUES (?, ?, 'system.logs_clear', 'system_log', NULL, ?)
  `).run(createId("audit"), user.id, JSON.stringify(result));
  return result;
}

export async function recordClientSystemError(
  user: RequestUser,
  input: { source?: unknown; detail?: unknown }
) {
  requireAuthenticated(user);
  const source = input.source === "vue" || input.source === "promise" ? input.source : "browser";
  const detail = safeText(input.detail, 500);
  if (!detail) throw createError({ statusCode: 400, statusMessage: "缺少前端异常摘要" });
  await writeLog("error", "client-unhandled-error", { source, detail });
  return { recorded: true };
}
