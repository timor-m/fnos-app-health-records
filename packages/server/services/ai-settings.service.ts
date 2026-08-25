import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createError } from "h3";
import { getDatabase } from "../database/client";
import { writeLog } from "../utils/logger";
import { getAppConfig } from "../utils/runtime-config";
import {
  aiProviderCatalog,
  aiProviderHasRequiredApiKey,
  normalizeAiProvider,
  resolveAiTemperature,
  type AiProviderKey
} from "./ai-provider";
import { listAiTasks, type AiTaskKey } from "./ai-task-registry";
import { executeAiChatCompletion } from "./ai-runtime.service";

const settingKey = "ai.provider";

export type AiSettings = {
  enabled: boolean;
  provider: AiProviderKey;
  visionEnabled: boolean;
  baseUrl: string;
  textModel: string;
  visionModel: string;
  apiKey: string;
};

export type AiTaskBinding = {
  provider?: AiProviderKey;
  model?: string;
};

export type AiSettingsInput = Partial<AiSettings> & {
  clearApiKey?: boolean;
  testVision?: boolean;
  taskBindings?: Partial<Record<AiTaskKey, AiTaskBinding | null>>;
};

type ProviderSettings = Omit<AiSettings, "enabled" | "provider">;
type StoredProviderSettings = Omit<ProviderSettings, "apiKey"> & {
  apiKey?: string;
  apiKeyEncrypted?: string;
};
type StoredAiSettings = Partial<StoredProviderSettings> & {
  enabled?: boolean;
  provider?: string;
  providers?: Partial<Record<AiProviderKey, StoredProviderSettings>>;
  taskBindings?: Partial<Record<AiTaskKey, { provider?: string; model?: string }>>;
};
type ParsedAiSettings = {
  enabled: boolean;
  provider: AiProviderKey;
  providers: Partial<Record<AiProviderKey, ProviderSettings>>;
  taskBindings: Partial<Record<AiTaskKey, AiTaskBinding>>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function keyPath() {
  return join(getAppConfig().storageDir, "secrets", "ai-settings.key");
}

function encryptionKey() {
  const path = keyPath();
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, randomBytes(32), { mode: 0o600 });
  }
  return readFileSync(path);
}

function encrypt(value: string) {
  if (!value) return "";
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64");
}

function decrypt(value: string) {
  if (!value) return "";
  const data = Buffer.from(value, "base64");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), data.subarray(0, 12));
  decipher.setAuthTag(data.subarray(12, 28));
  return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString("utf8");
}

function providerDefaults(provider: AiProviderKey): ProviderSettings {
  const defaults = aiProviderCatalog[provider];
  return {
    visionEnabled: false,
    baseUrl: defaults.defaultBaseUrl,
    textModel: defaults.defaultTextModel,
    visionModel: defaults.defaultVisionModel,
    apiKey: ""
  };
}

function parseProviderSettings(value: StoredProviderSettings | undefined): Partial<ProviderSettings> | undefined {
  if (!value) return undefined;
  const parsed: Partial<ProviderSettings> = {};
  if (typeof value.visionEnabled === "boolean") parsed.visionEnabled = value.visionEnabled;
  if (typeof value.baseUrl === "string") parsed.baseUrl = value.baseUrl;
  if (typeof value.textModel === "string") parsed.textModel = value.textModel;
  if (typeof value.visionModel === "string") parsed.visionModel = value.visionModel;
  if (typeof value.apiKeyEncrypted === "string") parsed.apiKey = decrypt(value.apiKeyEncrypted);
  else if (typeof value.apiKey === "string") parsed.apiKey = value.apiKey;
  return parsed;
}

export function parseStoredSettings(): ParsedAiSettings {
  const row = getDatabase().prepare("SELECT value_json AS valueJson FROM app_settings WHERE setting_key = ?")
    .get(settingKey) as { valueJson: string } | undefined;
  if (!row) return { enabled: false, provider: "deepseek", providers: {}, taskBindings: {} };

  try {
    const stored = JSON.parse(row.valueJson) as StoredAiSettings;
    const provider = normalizeAiProvider(stored.provider);
    const providers: ParsedAiSettings["providers"] = {};
    if (isRecord(stored.providers)) {
      for (const key of Object.keys(aiProviderCatalog) as AiProviderKey[]) {
        const raw = stored.providers[key];
        if (isRecord(raw)) providers[key] = parseProviderSettings(raw as StoredProviderSettings) as ProviderSettings;
      }
    }
    const taskBindings: ParsedAiSettings["taskBindings"] = {};
    if (isRecord(stored.taskBindings)) {
      for (const task of listAiTasks()) {
        const raw = stored.taskBindings[task.key];
        if (!isRecord(raw)) continue;
        const provider = typeof raw.provider === "string" && raw.provider in aiProviderCatalog
          ? raw.provider as AiProviderKey
          : undefined;
        const model = typeof raw.model === "string" ? raw.model.trim() : "";
        if (provider || model) taskBindings[task.key] = { provider, ...(model ? { model } : {}) };
      }
    }

    // The original release stored one flat provider configuration. Merge it into
    // the selected provider so upgrading never discards its models or API key.
    const hasLegacySettings = Boolean(
      stored.baseUrl || stored.textModel || stored.visionModel || stored.apiKey || stored.apiKeyEncrypted
    );
    if (hasLegacySettings) {
      const legacy = parseProviderSettings(stored as StoredProviderSettings);
      providers[provider] = {
        ...legacy,
        ...providers[provider],
        apiKey: providers[provider]?.apiKey ?? legacy?.apiKey ?? ""
      } as ProviderSettings;
    }
    return { enabled: stored.enabled === true, provider, providers, taskBindings };
  } catch {
    return { enabled: false, provider: "deepseek", providers: {}, taskBindings: {} };
  }
}

function normalizeProviderBaseUrl(provider: AiProviderKey, value: string) {
  try {
    const parsed = new URL(value);
    if (provider === "ollama" && parsed.pathname.replace(/\/+$/, "") === "") parsed.pathname = "/v1";
    if (
      provider === "kimi"
      && parsed.hostname === "api.kimi.com"
      && parsed.pathname.replace(/\/+$/, "") === "/coding"
    ) {
      parsed.pathname = "/coding/v1";
    }
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return value;
  }
}

export function resolveProvider(provider: AiProviderKey, parsed: ParsedAiSettings): ProviderSettings {
  const resolved = { ...providerDefaults(provider), ...parsed.providers[provider] };
  return {
    ...resolved,
    baseUrl: normalizeProviderBaseUrl(provider, resolved.baseUrl)
  };
}

function normalizeBaseUrl(value: unknown, fallback: string) {
  const baseUrl = String(value || fallback).trim().replace(/\/+$/, "");
  try {
    const parsed = new URL(baseUrl);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error();
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    throw createError({ statusCode: 400, statusMessage: "AI API 地址无效" });
  }
}

function maskApiKey(apiKey: string) {
  if (!apiKey) return "";
  if (apiKey.length <= 8) return "••••••••";
  return `${apiKey.slice(0, 3)}••••${apiKey.slice(-4)}`;
}

function serializeSettings(parsed: ParsedAiSettings) {
  const providers: Partial<Record<AiProviderKey, StoredProviderSettings>> = {};
  for (const key of Object.keys(aiProviderCatalog) as AiProviderKey[]) {
    const value = parsed.providers[key];
    if (!value) continue;
    providers[key] = {
      visionEnabled: value.visionEnabled === true,
      baseUrl: value.baseUrl,
      textModel: value.textModel,
      visionModel: value.visionModel,
      apiKeyEncrypted: encrypt(value.apiKey)
    };
  }
  return {
    enabled: parsed.enabled,
    provider: parsed.provider,
    providers,
    taskBindings: parsed.taskBindings
  };
}

function publicSettings(parsed: ParsedAiSettings) {
  const active = resolveProvider(parsed.provider, parsed);
  const providerSettings = Object.fromEntries(
    (Object.keys(aiProviderCatalog) as AiProviderKey[]).map((key) => {
      const value = resolveProvider(key, parsed);
      return [key, {
        visionEnabled: value.visionEnabled,
        baseUrl: value.baseUrl,
        textModel: value.textModel,
        visionModel: value.visionModel,
        apiKeyConfigured: Boolean(value.apiKey),
        apiKeyMasked: maskApiKey(value.apiKey)
      }];
    })
  );
  return {
    enabled: parsed.enabled,
    provider: parsed.provider,
    visionEnabled: active.visionEnabled,
    baseUrl: active.baseUrl,
    textModel: active.textModel,
    visionModel: active.visionModel,
    apiKey: "",
    apiKeyConfigured: Boolean(active.apiKey),
    apiKeyMasked: maskApiKey(active.apiKey),
    providerSettings,
    providers: Object.entries(aiProviderCatalog).map(([key, value]) => ({ key, ...value })),
    tasks: listAiTasks(),
    taskBindings: Object.fromEntries(listAiTasks().map((task) => {
      const binding = parsed.taskBindings[task.key];
      const provider = binding?.provider || parsed.provider;
      const providerSettings = resolveProvider(provider, parsed);
      return [task.key, {
        provider,
        model: binding?.model || providerSettings.textModel,
        inherited: !binding,
        implemented: task.implemented
      }];
    }))
  };
}

export function getAiSettings(includeSecret = false) {
  const parsed = parseStoredSettings();
  const active = resolveProvider(parsed.provider, parsed);
  return {
    ...publicSettings(parsed),
    apiKey: includeSecret ? active.apiKey : ""
  };
}

export function getAiTaskSettings(taskKey: AiTaskKey, includeSecret = false) {
  const parsed = parseStoredSettings();
  const binding = parsed.taskBindings[taskKey];
  const provider = binding?.provider || parsed.provider;
  const providerSettings = resolveProvider(provider, parsed);
  return {
    enabled: parsed.enabled,
    taskKey,
    provider,
    baseUrl: providerSettings.baseUrl,
    model: binding?.model || providerSettings.textModel,
    visionModel: providerSettings.visionModel,
    visionEnabled: providerSettings.visionEnabled,
    apiKey: includeSecret ? providerSettings.apiKey : "",
    inherited: !binding
  };
}

export function saveAiSettings(input: AiSettingsInput) {
  const parsed = parseStoredSettings();
  const provider = normalizeAiProvider(input.provider || parsed.provider);
  const current = resolveProvider(provider, parsed);
  const submittedKey = typeof input.apiKey === "string" ? input.apiKey.trim() : "";
  const apiKey = input.clearApiKey === true ? "" : submittedKey || current.apiKey;
  const visionEnabled = input.visionEnabled === undefined ? current.visionEnabled : input.visionEnabled === true;
  const visionModel = String(input.visionModel ?? current.visionModel).trim();
  if (visionEnabled && !visionModel) {
    throw createError({ statusCode: 400, statusMessage: "已开启视觉增强，请先填写视觉模型名称" });
  }
  const next: ParsedAiSettings = {
    enabled: input.enabled === undefined ? parsed.enabled : input.enabled === true,
    provider,
    providers: {
      ...parsed.providers,
      [provider]: {
        visionEnabled,
        baseUrl: normalizeProviderBaseUrl(provider, normalizeBaseUrl(input.baseUrl, current.baseUrl)),
        textModel: String(input.textModel || current.textModel).trim(),
        visionModel,
        apiKey
      }
    },
    taskBindings: { ...parsed.taskBindings }
  };
  if (input.taskBindings) {
    for (const task of listAiTasks()) {
      if (!(task.key in input.taskBindings)) continue;
      const value = input.taskBindings[task.key];
      if (!value) {
        delete next.taskBindings[task.key];
        continue;
      }
      const bindingProvider = value.provider
        ? normalizeAiProvider(value.provider)
        : undefined;
      const model = String(value.model || "").trim();
      next.taskBindings[task.key] = {
        ...(bindingProvider ? { provider: bindingProvider } : {}),
        ...(model ? { model } : {})
      };
    }
  }
  getDatabase().prepare(`
    INSERT INTO app_settings (setting_key, value_json) VALUES (?, ?)
    ON CONFLICT(setting_key) DO UPDATE SET value_json = excluded.value_json, updated_at = CURRENT_TIMESTAMP
  `).run(settingKey, JSON.stringify(serializeSettings(next)));
  return publicSettings(next);
}

export async function testAiConnection(input: AiSettingsInput = {}) {
  const parsed = parseStoredSettings();
  const provider = normalizeAiProvider(input.provider || parsed.provider);
  const current = resolveProvider(provider, parsed);
  const apiKey = typeof input.apiKey === "string" && input.apiKey.trim() ? input.apiKey.trim() : current.apiKey;
  const textModel = String(input.textModel || current.textModel).trim();
  const testVision = input.testVision === true;
  const model = testVision ? String(input.visionModel || current.visionModel).trim() : textModel;
  if ((aiProviderHasRequiredApiKey(provider) && !apiKey) || !model) {
    throw createError({
      statusCode: 400,
      statusMessage: aiProviderCatalog[provider].apiKeyRequired === false
        ? `请先配置 ${aiProviderCatalog[provider].label} ${testVision ? "视觉" : "文本"}模型`
        : `请先配置 ${aiProviderCatalog[provider].label} API Key 和${testVision ? "视觉" : "文本"}模型`
    });
  }
  const baseUrl = normalizeProviderBaseUrl(provider, normalizeBaseUrl(input.baseUrl, current.baseUrl));
  const started = Date.now();
  try {
    await executeAiChatCompletion({
      provider,
      baseUrl,
      apiKey,
      model
    }, {
      messages: [{
        role: "user",
        content: testVision
          ? [
              { type: "text", text: "Reply with OK if you can read this image." },
              { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/Sc7u7QAAAABJRU5ErkJggg==" } }
            ]
          : "reply ok"
      }],
      temperature: resolveAiTemperature(provider, model),
      maxOutputTokens: 4,
      timeoutMs: 15_000,
      timeoutCode: "AI_CONNECTION_TEST_TIMEOUT",
      timeoutMessage: "连接 AI 服务超时",
      networkCode: "AI_CONNECTION_TEST_NETWORK_ERROR",
      networkMessage: "NAS 无法连接 AI 服务"
    });
  } catch (cause) {
    const error = cause as Error & {
      code?: string;
      upstreamStatus?: number;
      upstreamDetail?: string;
      cause?: { code?: string; message?: string; cause?: { code?: string; message?: string } };
    };
    const code = error.code || error.cause?.code || "";
    const detail = [code, error.message, error.cause?.message, error.cause?.cause?.message]
      .filter(Boolean).join(" · ");
    const timedOut = /TIMEOUT|TIMEDOUT/i.test(`${code} ${detail}`);
    const dnsFailed = /ENOTFOUND|EAI_AGAIN/i.test(`${code} ${detail}`);
    const tlsFailed = /CERT|TLS|SSL|SELF_SIGNED/i.test(`${code} ${detail}`);
    await writeLog("warn", "ai-connection-test-failed", {
      provider,
      host: new URL(baseUrl).host,
      model,
      errorCode: code,
      detail: detail.slice(0, 600)
    });
    if (error.upstreamStatus) {
      const summary = error.upstreamStatus === 401 || error.upstreamStatus === 403
        ? "AI 服务认证失败，请检查 API Key 和账号权限"
        : error.upstreamStatus === 404
          ? "AI API 地址或文本模型不存在"
          : error.upstreamStatus === 429
            ? "AI 服务请求受限，请检查调用频率、额度或余额"
            : error.upstreamStatus >= 500
              ? "AI 服务暂时不可用"
              : "AI 服务拒绝了测试请求，请检查模型名称和接口兼容性";
      const suffix = error.upstreamDetail ? `：${error.upstreamDetail.slice(0, 240)}` : "";
      throw createError({
        statusCode: 502,
        statusMessage: `${summary}（上游 ${error.upstreamStatus}）${suffix}`
      });
    }
    const statusMessage = timedOut
      ? "连接 AI 服务超时，请检查 NAS 外网连接、代理或服务地址"
      : dnsFailed
        ? "NAS 无法解析 AI 服务域名，请检查 DNS 和外网连接"
        : tlsFailed
          ? "AI 服务 TLS 证书校验失败，请检查 NAS 时间、证书或代理设置"
          : "NAS 无法连接 AI 服务，请检查外网连接、代理、DNS 和 API 地址";
    throw createError({ statusCode: timedOut ? 504 : 502, statusMessage });
  }
    return { ok: true, provider, model, vision: testVision, elapsedMs: Date.now() - started };
}
