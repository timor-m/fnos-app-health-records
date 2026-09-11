import templateConfig from "../../../template.config.json" with { type: "json" };
import packageJson from "../../../package.json" with { type: "json" };
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { resolveArchiveLocation } from './archive-storage';

export type AppRuntimeConfig = {
  appName: string;
  appTitle: string;
  appVersion: string;
  accessMode: "gateway" | "port";
  authMode: "fnos" | "local" | "development" | "disabled";
  trustProxy: boolean;
  gatewayPrefix: string;
  appPort: number | null;
  logLevel: string;
  logDir: string;
  logMaxBytes: number;
  logMaxFiles: number;
  storageDir: string;
  runtimeDir: string;
  storageRelocated: boolean;
  storageError: string | null;
  servicePort: number;
  ocrPythonBin: string;
  ocrWorkerScript: string;
  ocrSetupScript: string;
};

type PersistedRuntimeConfig = {
  servicePort?: number;
  directPort?: number;
};

function boundedInteger(value: string | undefined, fallback: number, minimum: number, maximum: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.round(parsed)));
}

function normalizedGatewayPrefix(value: string) {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "/") return "";
  return `/${trimmed.replace(/^\/+|\/+$/g, "")}`;
}

function resolvedAuthMode(isDevelopment: boolean): AppRuntimeConfig["authMode"] {
  if (isDevelopment) return "development";
  const configured = String(process.env.AUTH_MODE || "").trim().toLowerCase();
  if (configured === "fnos" || configured === "local") return configured;
  if (configured) throw new Error("AUTH_MODE must be either fnos or local");
  if (process.env.FNOS_SOCKET_PATH) return "fnos";
  return "disabled";
}

function persistedConfig(storageDir: string): PersistedRuntimeConfig {
  const path = join(storageDir, "config", "runtime.json");
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as PersistedRuntimeConfig;
  } catch {
    return {};
  }
}

export function getAppConfig(): AppRuntimeConfig {
  const appName = process.env.APP_NAME || templateConfig.appName;
  const isDevelopment = process.env.NODE_ENV === "development" || Boolean(process.env.VITE_DEV_SERVER_URL);
  const developmentDataDir = resolve(process.cwd(), ".data");
  const productionDataDir = process.env.TRIM_PKGVAR
    ? resolve(process.env.TRIM_PKGVAR, "data")
    : `/var/apps/${appName}/var/data`;
  const runtimeDir = process.env.STORAGE_DIR || (isDevelopment ? developmentDataDir : productionDataDir);
  const authMode = resolvedAuthMode(isDevelopment);
  const location = resolveArchiveLocation(runtimeDir, authMode === 'fnos' || authMode === 'development');
  const { storageDir } = location;
  const stored = persistedConfig(runtimeDir);
  const applicationDir = process.env.TRIM_APPDEST || process.cwd();
  const ocrRoot = isDevelopment ? resolve(process.cwd(), "packages", "ocr-worker") : resolve(applicationDir, "ocr-worker");

  return {
    appName,
    appTitle: process.env.APP_TITLE || templateConfig.appTitle,
    appVersion: process.env.APP_VERSION || packageJson.version,
    accessMode: process.env.FNOS_SOCKET_PATH ? "gateway" : "port",
    authMode,
    trustProxy: process.env.TRUST_PROXY === "1" || process.env.TRUST_PROXY === "true",
    gatewayPrefix: normalizedGatewayPrefix(process.env.GATEWAY_PREFIX ?? templateConfig.gatewayPrefix),
    appPort: process.env.FNOS_SOCKET_PATH
      ? null
      : Number(process.env.NITRO_PORT || process.env.PORT || templateConfig.localDevPort),
    logLevel: process.env.LOG_LEVEL || templateConfig.logLevel,
    logDir: process.env.LOG_DIR || (isDevelopment ? join(developmentDataDir, "logs") : `/var/apps/${appName}/var/log`),
    logMaxBytes: boundedInteger(process.env.APP_LOG_MAX_BYTES, 5 * 1024 * 1024, 256 * 1024, 100 * 1024 * 1024),
    logMaxFiles: boundedInteger(process.env.APP_LOG_MAX_FILES, 5, 1, 20),
    storageDir,
    runtimeDir,
    storageRelocated: location.relocated,
    storageError: location.error,
    servicePort: Number(process.env.SERVICE_PORT || stored.servicePort || stored.directPort || templateConfig.localDevPort),
    ocrPythonBin: process.env.OCR_PYTHON_BIN || join(runtimeDir, "ocr-venv", "bin", "python"),
    ocrWorkerScript: process.env.OCR_WORKER_SCRIPT || join(ocrRoot, "worker.py"),
    ocrSetupScript: process.env.OCR_SETUP_SCRIPT || join(ocrRoot, "setup-runtime.sh")
  };
}
