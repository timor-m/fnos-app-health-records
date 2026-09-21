import { execFileSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { arch, platform, release, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createError } from "h3";
import { getDatabase, getDatabaseStatus } from "../database/client";
import { isAdministrator, type RequestUser } from "../domain/request-user";
import { createId } from "../utils/identifier";
import { getLogRotationPolicy, redactLogText, redactLogValue } from "../utils/logger";
import { getAppConfig } from "../utils/runtime-config";
import { getOcrStatus } from "./ocr-runtime.service";

const maxExportBytesPerLog = 2 * 1024 * 1024;

type DiagnosticLogSource = {
  key: "application" | "ocr-install" | "lifecycle";
  label: string;
  filePath: string;
  format: "jsonl" | "plain";
};

function requireAdmin(user: RequestUser) {
  if (!user.authenticated) throw createError({ statusCode: 401, statusMessage: "请先登录" });
  if (!isAdministrator(user)) throw createError({ statusCode: 403, statusMessage: "仅管理员可导出诊断包" });
}

function timestampForFilename(date: Date) {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z").replace(/[-:]/g, "").replace("T", "-");
}

function sourceFiles(source: DiagnosticLogSource) {
  const directory = dirname(source.filePath);
  const baseName = basename(source.filePath);
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && (entry.name === baseName || new RegExp(`^${baseName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.\\d+$`).test(entry.name)))
    .map((entry) => join(directory, entry.name))
    .sort((left, right) => {
      const rank = (path: string) => {
        const name = basename(path);
        return name === baseName ? 0 : Number(name.slice(baseName.length + 1)) || Number.MAX_SAFE_INTEGER;
      };
      return rank(left) - rank(right);
    });
}

function readFileTail(path: string) {
  const size = statSync(path).size;
  const length = Math.min(size, maxExportBytesPerLog);
  const buffer = Buffer.alloc(length);
  const descriptor = openSync(path, "r");
  try {
    readSync(descriptor, buffer, 0, length, Math.max(0, size - length));
  } finally {
    closeSync(descriptor);
  }
  return {
    content: buffer.toString("utf8"),
    originalBytes: size,
    exportedBytes: length,
    truncated: size > length
  };
}

function sanitizeJsonLines(content: string) {
  return content.split(/\r?\n/).filter(Boolean).map((line) => {
    try {
      return JSON.stringify(redactLogValue(JSON.parse(line)));
    } catch {
      return redactLogText(line);
    }
  }).join("\n");
}

function sanitizeLogContent(source: DiagnosticLogSource, content: string) {
  return source.format === "jsonl"
    ? sanitizeJsonLines(content)
    : redactLogText(content);
}

function lifecycleLogPath() {
  const config = getAppConfig();
  return process.env.TRIM_PKGVAR
    ? join(process.env.TRIM_PKGVAR, "info.log")
    : join(config.logDir, "info.log");
}

function writeJson(path: string, value: unknown) {
  writeFileSync(path, `${JSON.stringify(redactLogValue(value), null, 2)}\n`, { mode: 0o600 });
}

export function createDiagnosticBundle(user: RequestUser) {
  requireAdmin(user);
  const config = getAppConfig();
  const createdDate = new Date();
  const createdAt = createdDate.toISOString();
  const filename = `${config.appName}-diagnostics-${timestampForFilename(createdDate)}.tar.gz`;
  const temporaryRoot = mkdtempSync(join(tmpdir(), "health-records-diagnostics-"));
  const stagingRoot = join(temporaryRoot, "diagnostics");
  const archivePath = join(temporaryRoot, filename);
  const logsRoot = join(stagingRoot, "logs");
  const deploymentCopy = config.authMode === "fnos"
    ? { lifecycleLog: "飞牛应用启停日志", troubleshooting: "应用运行、OCR 安装和飞牛应用启停问题" }
    : config.authMode === "local"
      ? { lifecycleLog: "Docker 容器启动日志", troubleshooting: "应用运行、OCR 安装和 Docker 容器启动问题" }
      : { lifecycleLog: "应用启动日志", troubleshooting: "应用运行、OCR 安装和启动问题" };

  try {
    mkdirSync(logsRoot, { recursive: true });
    const applicationPolicy = getLogRotationPolicy();
    const sources: DiagnosticLogSource[] = [
      { key: "application", label: "应用运行日志", filePath: applicationPolicy.filePath, format: "jsonl" },
      { key: "ocr-install", label: "OCR 安装日志", filePath: join(config.logDir, "ocr-install.log"), format: "plain" },
      { key: "lifecycle", label: deploymentCopy.lifecycleLog, filePath: lifecycleLogPath(), format: "plain" }
    ];
    const includedLogs: Array<{
      source: string;
      file: string;
      originalBytes: number;
      exportedBytes: number;
      truncated: boolean;
    }> = [];

    for (const source of sources) {
      for (const filePath of sourceFiles(source)) {
        const tail = readFileTail(filePath);
        const outputName = `${source.key}-${basename(filePath)}`;
        const truncationNotice = tail.truncated
          ? `[诊断包仅保留该文件最后 ${tail.exportedBytes} 字节，原文件 ${tail.originalBytes} 字节]\n`
          : "";
        writeFileSync(
          join(logsRoot, outputName),
          `${truncationNotice}${sanitizeLogContent(source, tail.content)}${tail.content.endsWith("\n") ? "" : "\n"}`,
          { mode: 0o600 }
        );
        includedLogs.push({
          source: source.label,
          file: `logs/${outputName}`,
          originalBytes: tail.originalBytes,
          exportedBytes: tail.exportedBytes,
          truncated: tail.truncated
        });
      }
    }

    const database = getDatabaseStatus();
    const ocr = getOcrStatus();
    writeJson(join(stagingRoot, "environment.json"), {
      application: {
        id: config.appName,
        title: config.appTitle,
        version: config.appVersion,
        accessMode: config.accessMode,
        authMode: config.authMode,
        gatewayPrefix: config.gatewayPrefix,
        servicePort: config.servicePort
      },
      runtime: {
        node: process.version,
        platform: platform(),
        release: release(),
        arch: arch(),
        processUptimeSec: Math.floor(process.uptime())
      },
      database: {
        driver: database.driver,
        integrity: database.integrity,
        schemaVersion: database.schemaVersion,
        appliedSchemaVersion: database.appliedSchemaVersion,
        journalMode: database.journalMode
      },
      ocr: {
        available: ocr.available,
        installing: ocr.installing,
        installState: ocr.lastInstall?.state || "idle",
        runtimeReady: ocr.lastInstall?.runtimeReady ?? ocr.available,
        exitCode: ocr.lastInstall?.exitCode ?? null,
        error: ocr.lastInstall?.error || null,
        warning: ocr.lastInstall?.warning || null,
        runtime: ocr.runtime ? {
          pythonVersion: ocr.runtime.pythonVersion,
          backend: ocr.runtime.engine || ocr.runtime.backend,
          modelVersion: ocr.runtime.modelVersion,
          rapidocrVersion: ocr.runtime.rapidocrVersion,
          pymupdfVersion: ocr.runtime.pymupdfVersion,
          pillowVersion: ocr.runtime.pillowVersion,
          pillowHeifVersion: ocr.runtime.pillowHeifVersion,
          platform: ocr.runtime.platform,
          machine: ocr.runtime.machine
        } : null,
        runner: ocr.runner
      }
    });
    writeJson(join(stagingRoot, "manifest.json"), {
      formatVersion: 1,
      createdAt,
      application: config.appName,
      applicationVersion: config.appVersion,
      privacy: {
        sanitized: true,
        excluded: ["数据库", "报告原件", "OCR 报告内容", "AI 配置与密钥", "用户身份资料"],
        maxBytesPerLogFile: maxExportBytesPerLog
      },
      includedLogs
    });
    writeFileSync(
      join(stagingRoot, "README.txt"),
      [
        "健康档案诊断包",
        "",
        `该文件由管理员手动导出，用于排查${deploymentCopy.troubleshooting}。`,
        "日志已执行脱敏，每个日志文件最多保留末尾 2 MB。",
        "诊断包不包含数据库、报告原件、OCR 报告内容、AI 配置或密钥、用户身份资料。",
        ""
      ].join("\n"),
      { mode: 0o600 }
    );

    execFileSync("tar", ["-czf", archivePath, "-C", stagingRoot, "."], { stdio: "pipe" });
    chmodSync(archivePath, 0o600);
    const result = {
      filename,
      path: archivePath,
      sizeBytes: statSync(archivePath).size,
      createdAt,
      includedLogFiles: includedLogs.length
    };
    getDatabase().prepare(`
      INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, detail_json)
      VALUES (?, ?, 'system.diagnostics_export', 'system_log', NULL, ?)
    `).run(createId("audit"), user.id, JSON.stringify({
      sizeBytes: result.sizeBytes,
      includedLogFiles: result.includedLogFiles
    }));
    return {
      ...result,
      cleanup: () => rmSync(temporaryRoot, { recursive: true, force: true })
    };
  } catch (error) {
    rmSync(temporaryRoot, { recursive: true, force: true });
    if (error && typeof error === "object" && "status" in error) throw error;
    throw error;
  }
}
