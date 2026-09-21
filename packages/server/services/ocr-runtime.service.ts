import { apiError } from "../utils/api-error";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { getDatabase } from "../database/client";
import { getAppConfig } from "../utils/runtime-config";
import { getJobRunnerStatus } from "./job-runner.service";

let installing = false;
const tableEnhancementRevision = "rapid-table-3.0.2-layout-1.2.1-v1";
function tableEnhancementStatus(storageDir: string) {
  try {
    const root = join(storageDir, "ocr-table");
    const active = JSON.parse(readFileSync(join(root, "active.json"), "utf8"));
    const baseReady = active.revision === tableEnhancementRevision
      && /^runtime-[\w-]+$/.test(active.directory)
      && existsSync(join(root, active.directory, "bin/python"));
    const entries = Object.entries(active.modelHashes || {}) as Array<[string, string]>;
    const hashValid = (name: string, digest: string) =>
      /^lib\/python[\d.]+\/site-packages\/rapid_(table|layout)\/models\/[\w.-]+\.onnx$/.test(name)
      && createHash("sha256").update(readFileSync(join(root, active.directory, name))).digest("hex") === digest;
    const moduleReady = (module: "table" | "layout") =>
      baseReady && entries.some(([name, digest]) => name.includes(`rapid_${module}/`) && hashValid(name, digest));
    const tableModel = moduleReady("table");
    const layoutModel = moduleReady("layout");
    const available = tableModel && layoutModel
      && entries.length >= 2
      && entries.every(([name, digest]) => hashValid(name, digest));
    return { available, tableModel, layoutModel };
  } catch {
    return { available: false, tableModel: false, layoutModel: false };
  }
}
function tableEnhancementAvailable(storageDir: string) {
  return tableEnhancementStatus(storageDir).available;
}
let installLastOutputAt: string | null = null;
let installHeartbeatTimer: ReturnType<typeof setInterval> | null = null;

type OcrInstallState = "idle" | "installing" | "success" | "failed";

type OcrInstallStatus = {
  state: OcrInstallState;
  startedAt?: string;
  finishedAt?: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  error?: string;
  warning?: string;
  runtimeReady?: boolean;
  missing?: string[];
  logPath?: string;
  logTail?: string[];
};

type OcrRuntimeInfo = {
  createdAt?: string;
  python?: string;
  pythonVersion?: string;
  backend?: string;
  engine?: string;
  modelVersion?: string;
  rapidocrVersion?: string;
  pymupdfVersion?: string;
  pillowVersion?: string;
  pillowHeifVersion?: string;
  platform?: string;
  machine?: string;
};

type OcrPipMirrorKey = "official" | "tsinghua" | "aliyun" | "tencent" | "huaweicloud" | "custom";

type OcrInstallSettings = {
  pipMirror: OcrPipMirrorKey;
  customPipIndexUrl: string;
};

const ocrInstallSettingKey = "ocr.install";
/** 面向国内 fnOS 设备，首次安装默认走清华镜像，避免用户忽略配置导致 PyPI 直连超时 */
const defaultPipMirror: OcrPipMirrorKey = "tsinghua";
const pipMirrorCatalog: Array<{ key: OcrPipMirrorKey; label: string; indexUrl: string; description: string }> = [
  { key: "official", label: "官方 PyPI", indexUrl: "", description: "使用 pip 默认源，适合海外网络或已配置系统 pip 镜像的设备" },
  { key: "tsinghua", label: "清华大学", indexUrl: "https://pypi.tuna.tsinghua.edu.cn/simple", description: "国内常用 PyPI 镜像，新安装的默认源" },
  { key: "aliyun", label: "阿里云", indexUrl: "https://mirrors.aliyun.com/pypi/simple", description: "阿里云 PyPI 镜像" },
  { key: "tencent", label: "腾讯云", indexUrl: "https://mirrors.cloud.tencent.com/pypi/simple", description: "腾讯云 PyPI 镜像" },
  { key: "huaweicloud", label: "华为云", indexUrl: "https://repo.huaweicloud.com/repository/pypi/simple", description: "华为云 PyPI 镜像" },
  { key: "custom", label: "自定义", indexUrl: "", description: "填写可访问的 PyPI simple API 地址" }
];

function readyMarkerPath(pythonBin: string) {
  return join(dirname(dirname(pythonBin)), ".health-records-ocr-ready");
}

function requiresArm64OnnxRuntime() {
  return process.arch === "arm64";
}

function hasVerifiedRuntime() {
  return runtimeReadiness().ready;
}

function runtimeReadiness() {
  const config = getAppConfig();
  const marker = readyMarkerPath(config.ocrPythonBin);
  const runtime = readRuntimeInfo(marker);
  const backend = runtime?.engine || runtime?.backend;
  const checks = [
    { key: "pythonBin", path: config.ocrPythonBin, ok: existsSync(config.ocrPythonBin) },
    { key: "workerScript", path: config.ocrWorkerScript, ok: existsSync(config.ocrWorkerScript) },
    { key: "readyMarker", path: marker, ok: existsSync(marker) },
    ...(requiresArm64OnnxRuntime()
      ? [{ key: "backend", path: `${marker} (rapidocr-onnxruntime)`, ok: backend === "rapidocr-onnxruntime" }]
      : [])
  ];
  return {
    ready: checks.every((item) => item.ok),
    checks,
    missing: checks.filter((item) => !item.ok).map((item) => `${item.key}: ${item.path}`)
  };
}

function installStatusPath(storageDir: string) {
  return join(storageDir, "config", "ocr-install-status.json");
}

function installLogPath(logDir: string) {
  return join(logDir, "ocr-install.log");
}

function readLogTail(path: string, maxLines = 80) {
  if (!existsSync(path)) return [];
  try {
    return readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean).slice(-maxLines);
  } catch {
    return [];
  }
}

function readInstallStatus(): OcrInstallStatus {
  const config = getAppConfig();
  const path = installStatusPath(config.runtimeDir);
  const logPath = installLogPath(config.logDir);
  let status: OcrInstallStatus = { state: "idle", logPath };
  if (existsSync(path)) {
    try {
      status = { ...status, ...(JSON.parse(readFileSync(path, "utf8")) as OcrInstallStatus) };
    } catch {
      status = { state: "failed", error: "OCR 安装状态文件读取失败", logPath };
    }
  }
  return { ...status, logPath, logTail: readLogTail(logPath) };
}

function readRuntimeInfo(readyMarker: string): OcrRuntimeInfo | null {
  if (!existsSync(readyMarker)) return null;
  try {
    return JSON.parse(readFileSync(readyMarker, "utf8")) as OcrRuntimeInfo;
  } catch {
    return null;
  }
}

function isPipMirrorKey(value: unknown): value is OcrPipMirrorKey {
  return typeof value === "string" && pipMirrorCatalog.some((item) => item.key === value);
}

function normalizePipIndexUrl(value: unknown) {
  const url = String(value || "").trim().replace(/\/+$/, "");
  if (!url) return "";
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error();
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    throw apiError(400, "REQUEST_INVALID", "PyPI 镜像地址无效，请填写 http(s)://.../simple 格式地址");
  }
}

function readOcrInstallSettings(): OcrInstallSettings {
  const row = getDatabase().prepare("SELECT value_json AS valueJson FROM app_settings WHERE setting_key = ?")
    .get(ocrInstallSettingKey) as { valueJson: string } | undefined;
  if (!row) return { pipMirror: defaultPipMirror, customPipIndexUrl: "" };
  try {
    const stored = JSON.parse(row.valueJson) as Partial<OcrInstallSettings>;
    return {
      pipMirror: isPipMirrorKey(stored.pipMirror) ? stored.pipMirror : defaultPipMirror,
      customPipIndexUrl: normalizePipIndexUrl(stored.customPipIndexUrl)
    };
  } catch {
    return { pipMirror: defaultPipMirror, customPipIndexUrl: "" };
  }
}

function resolvedPipIndexUrl(settings: OcrInstallSettings) {
  if (settings.pipMirror === "custom") return settings.customPipIndexUrl;
  return pipMirrorCatalog.find((item) => item.key === settings.pipMirror)?.indexUrl || "";
}

export function getOcrInstallSettings() {
  const settings = readOcrInstallSettings();
  return {
    ...settings,
    resolvedPipIndexUrl: resolvedPipIndexUrl(settings),
    mirrors: pipMirrorCatalog
  };
}

export function saveOcrInstallSettings(input: Partial<OcrInstallSettings>) {
  const pipMirror = isPipMirrorKey(input.pipMirror) ? input.pipMirror : defaultPipMirror;
  const customPipIndexUrl = normalizePipIndexUrl(input.customPipIndexUrl);
  if (pipMirror === "custom" && !customPipIndexUrl) throw apiError(400, "REQUEST_INVALID", "请选择自定义镜像源地址");
  const settings: OcrInstallSettings = { pipMirror, customPipIndexUrl };
  getDatabase().prepare(`
    INSERT INTO app_settings (setting_key, value_json) VALUES (?, ?)
    ON CONFLICT(setting_key) DO UPDATE SET value_json = excluded.value_json, updated_at = CURRENT_TIMESTAMP
  `).run(ocrInstallSettingKey, JSON.stringify(settings));
  return getOcrInstallSettings();
}

function writeInstallStatus(status: OcrInstallStatus) {
  const config = getAppConfig();
  const path = installStatusPath(config.runtimeDir);
  const { logTail: _logTail, ...persisted } = status;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(persisted, null, 2)}\n`, "utf8");
}

function appendInstallLog(line: string) {
  const config = getAppConfig();
  const path = installLogPath(config.logDir);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, line, "utf8");
}

function appendChunk(stream: "stdout" | "stderr", chunk: Buffer | string) {
  installLastOutputAt = new Date().toISOString();
  const text = String(chunk);
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    appendInstallLog(`${new Date().toISOString()} [${stream}] ${line}\n`);
  }
}

function startInstallHeartbeat(startedAt: string) {
  if (installHeartbeatTimer) clearInterval(installHeartbeatTimer);
  installLastOutputAt = startedAt;
  installHeartbeatTimer = setInterval(() => {
    if (!installing) return;
    const now = Date.now();
    const startedMs = Date.parse(startedAt);
    const lastOutputMs = installLastOutputAt ? Date.parse(installLastOutputAt) : startedMs;
    const elapsedSeconds = Math.max(0, Math.round((now - startedMs) / 1000));
    const quietSeconds = Math.max(0, Math.round((now - lastOutputMs) / 1000));
    appendInstallLog(
      `${new Date().toISOString()} [info] OCR runtime installation still running, elapsed ${elapsedSeconds}s, no new pip output for ${quietSeconds}s. Large wheel downloads may take several minutes on slow networks.\n`
    );
  }, 30_000);
}

function stopInstallHeartbeat() {
  if (!installHeartbeatTimer) return;
  clearInterval(installHeartbeatTimer);
  installHeartbeatTimer = null;
}

export function getOcrStatus() {
  const config = getAppConfig();
  let lastInstall = readInstallStatus();
  const readiness = runtimeReadiness();
  const readyMarker = readyMarkerPath(config.ocrPythonBin);
  const available = readiness.ready;
  const runtime = readRuntimeInfo(readyMarker);
  const arm64MigrationWarning =
    requiresArm64OnnxRuntime() && existsSync(readyMarker) &&
    (runtime?.engine || runtime?.backend) !== "rapidocr-onnxruntime"
      ? "当前 ARM64 OCR 环境使用了不兼容的 OpenVINO 后端，请重新安装 OCR 环境以切换到 ONNXRuntime。"
      : undefined;
  if (arm64MigrationWarning && !lastInstall.warning) {
    lastInstall = { ...lastInstall, warning: arm64MigrationWarning };
  }
  if (lastInstall.state === "failed" && lastInstall.exitCode === 0) {
    lastInstall = {
      ...lastInstall,
      state: "success",
      error: undefined,
      warning: available
        ? undefined
        : arm64MigrationWarning || `安装脚本已成功退出，但服务端运行路径校验未完全通过：${readiness.missing.join("；")}`,
      runtimeReady: available,
      missing: readiness.missing
    };
    writeInstallStatus(lastInstall);
    appendInstallLog(`${new Date().toISOString()} [info] OCR runtime status repaired to success because setup process exited with code 0\n`);
  }
  return {
    available,
    tableEnhancementAvailable: tableEnhancementAvailable(config.runtimeDir),
    tableEnhancement: tableEnhancementStatus(config.runtimeDir),
    installing,
    workerScript: config.ocrWorkerScript,
    pythonBin: config.ocrPythonBin,
    setupScript: config.ocrSetupScript,
    readyMarker,
    readiness,
    runtime,
    lastInstall,
    runner: getJobRunnerStatus()
  };
}

export function installOcrRuntime() {
  if (installing) return getOcrStatus();
  const config = getAppConfig();
  const startedAt = new Date().toISOString();
  const logPath = installLogPath(config.logDir);
  const installSettings = readOcrInstallSettings();
  const pipIndexUrl = resolvedPipIndexUrl(installSettings);
  installing = true;
  installLastOutputAt = startedAt;
  writeInstallStatus({ state: "installing", startedAt, logPath });
  appendInstallLog(`${startedAt} [info] OCR runtime installation started\n`);
  startInstallHeartbeat(startedAt);
  const child = spawn("sh", [join(dirname(config.ocrSetupScript), "upgrade-runtime.sh")], {
    detached: false,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      STORAGE_DIR: config.runtimeDir,
      OCR_PYTHON_BIN: config.ocrPythonBin,
      ...(pipIndexUrl ? { PIP_INDEX_URL: pipIndexUrl } : {})
    }
  });

  child.stdout?.on("data", (chunk) => appendChunk("stdout", chunk));
  child.stderr?.on("data", (chunk) => appendChunk("stderr", chunk));
  let finalized = false;
  const finalize = (status: OcrInstallStatus, logLine: string) => {
    if (finalized) return;
    finalized = true;
    installing = false;
    stopInstallHeartbeat();
    writeInstallStatus(status);
    appendInstallLog(logLine);
  };

  child.once("close", (code, signal) => {
    const finishedAt = new Date().toISOString();
    const readiness = runtimeReadiness();
    const processSucceeded = code === 0;
    const warning =
      processSucceeded && !readiness.ready
        ? `安装脚本已成功退出，但服务端运行路径校验未完全通过：${readiness.missing.join("；")}`
        : undefined;
    const status: OcrInstallStatus = processSucceeded
      ? {
          state: "success",
          startedAt,
          finishedAt,
          exitCode: code,
          signal,
          warning,
          runtimeReady: readiness.ready,
          missing: readiness.missing,
          logPath
        }
      : {
          state: "failed",
          startedAt,
          finishedAt,
          exitCode: code,
          signal,
          runtimeReady: readiness.ready,
          missing: readiness.missing,
          error: `OCR 安装进程退出码 ${code ?? "unknown"}${signal ? `，信号 ${signal}` : ""}`,
          logPath
        };
    finalize(
      status,
      `${finishedAt} [info] OCR runtime installation ${processSucceeded ? "succeeded" : "failed"} with exit code ${code ?? "unknown"}${signal ? ` and signal ${signal}` : ""}\n`
    );
  });
  child.once("error", (error) => {
    const finishedAt = new Date().toISOString();
    finalize(
      { state: "failed", startedAt, finishedAt, exitCode: null, signal: null, error: error.message, logPath },
      `${finishedAt} [error] ${error.message}\n`
    );
  });
  return getOcrStatus();
}
