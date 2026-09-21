import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createError } from "h3";
import { getDatabase } from "../database/client";
import { writeLog } from "../utils/logger";
import { getAppConfig } from "../utils/runtime-config";
import {
  aiProviderCatalog,
  isMiniMaxM2Model,
  aiProviderHasRequiredApiKey,
  normalizeAiProvider,
  resolveAiTemperature,
  type AiProviderKey
} from "./ai-provider";
import { listAiTasks, type AiTaskKey } from "./ai-task-registry";
import { aiVisionProbeImageUrl } from "./ai-vision-probe";
import { executeAiChatCompletion } from "./ai-runtime.service";

const settingKey = "ai.provider";
const defaultRequestTimeoutSeconds = 600;
const minRequestTimeoutSeconds = 30;
const maxRequestTimeoutSeconds = 3_600;

export type AiExtractionDepth = "overview" | "detailed";
const extractionDepthValues: AiExtractionDepth[] = ["overview", "detailed"];

export function normalizeAiExtractionDepth(value: unknown): AiExtractionDepth {
  return extractionDepthValues.includes(value as AiExtractionDepth)
    ? (value as AiExtractionDepth)
    : "overview";
}

/* 一份连接配置 = 服务商预设（驱动平台差异）+ 自定义名称 + 地址 + Key + 模型。
   默认模型和场景绑定都通过 profileId 引用具体配置。 */
export type AiProfile = {
  id: string;
  name: string;
  provider: AiProviderKey;
  visionEnabled: boolean;
  baseUrl: string;
  textModel: string;
  visionModel: string;
  apiKey: string;
};

export type AiTaskBinding = {
  profileId?: string;
  model?: string;
};

export type AiProfileInput = {
  id?: string;
  name?: string;
  provider?: string;
  visionEnabled?: boolean;
  baseUrl?: string;
  textModel?: string;
  visionModel?: string;
  apiKey?: string;
  clearApiKey?: boolean;
};

export type AiTaskBindingInput = {
  profileId?: string;
  model?: string;
  // 兼容旧版按服务商绑定场景的写法
  provider?: string;
};

export type AiSettingsInput = {
  enabled?: boolean;
  requestTimeoutSeconds?: number;
  extractionDepth?: string;
  defaultProfileId?: string;
  profileId?: string;
  profiles?: AiProfileInput[];
  taskBindings?: Partial<Record<AiTaskKey, AiTaskBindingInput | null>>;
  // 兼容旧版按服务商保存的表单字段
  provider?: string;
  visionEnabled?: boolean;
  baseUrl?: string;
  textModel?: string;
  visionModel?: string;
  apiKey?: string;
  clearApiKey?: boolean;
  testVision?: boolean;
};

type StoredAiProfile = {
  id?: string;
  name?: string;
  provider?: string;
  visionEnabled?: boolean;
  baseUrl?: string;
  textModel?: string;
  visionModel?: string;
  apiKey?: string;
  apiKeyEncrypted?: string;
};

// 旧版（v1）按服务商存储的结构，读取时自动迁移为 profiles 列表
type StoredProviderSettings = {
  visionEnabled?: boolean;
  baseUrl?: string;
  textModel?: string;
  visionModel?: string;
  apiKey?: string;
  apiKeyEncrypted?: string;
};

type StoredAiSettings = StoredProviderSettings & {
  enabled?: boolean;
  requestTimeoutSeconds?: number;
  extractionDepth?: string;
  defaultProfileId?: string;
  profiles?: StoredAiProfile[];
  provider?: string;
  providers?: Partial<Record<AiProviderKey, StoredProviderSettings>>;
  taskBindings?: Partial<Record<AiTaskKey, { profileId?: string; provider?: string; model?: string }>>;
};

type ParsedAiSettings = {
  enabled: boolean;
  requestTimeoutSeconds: number;
  extractionDepth: AiExtractionDepth;
  defaultProfileId: string;
  profiles: AiProfile[];
  taskBindings: Partial<Record<AiTaskKey, AiTaskBinding>>;
};

function legacyRequestTimeoutSeconds() {
  const milliseconds = Number(process.env.AI_REQUEST_TIMEOUT_MS);
  if (!Number.isFinite(milliseconds)) return defaultRequestTimeoutSeconds;
  return Math.min(maxRequestTimeoutSeconds, Math.max(minRequestTimeoutSeconds, Math.round(milliseconds / 1_000)));
}

function storedRequestTimeoutSeconds(value: unknown) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) return legacyRequestTimeoutSeconds();
  return Math.min(maxRequestTimeoutSeconds, Math.max(minRequestTimeoutSeconds, Math.round(seconds)));
}

function submittedRequestTimeoutSeconds(value: unknown, fallback: number) {
  if (value === undefined) return fallback;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < minRequestTimeoutSeconds || seconds > maxRequestTimeoutSeconds) {
    throw createError({
      statusCode: 400, data: { code: "AI_CONFIG_INVALID" },
      statusMessage: `AI 请求超时必须在 ${minRequestTimeoutSeconds} 至 ${maxRequestTimeoutSeconds} 秒之间`
    });
  }
  return Math.round(seconds);
}

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

function generateProfileId(taken: Set<string>) {
  let id = "";
  do {
    id = `pf_${randomBytes(4).toString("hex")}`;
  } while (taken.has(id));
  return id;
}

function providerDefaults(provider: AiProviderKey) {
  const defaults = aiProviderCatalog[provider];
  return {
    visionEnabled: false,
    baseUrl: defaults.defaultBaseUrl,
    textModel: defaults.defaultTextModel,
    visionModel: defaults.defaultVisionModel,
    apiKey: ""
  };
}

function emptySettings(): ParsedAiSettings {
  return {
    enabled: false,
    requestTimeoutSeconds: legacyRequestTimeoutSeconds(),
    extractionDepth: "overview",
    defaultProfileId: "",
    profiles: [],
    taskBindings: {}
  };
}

function parseStoredProfile(raw: StoredAiProfile, taken: Set<string>): AiProfile | null {
  const provider = typeof raw.provider === "string" && Object.hasOwn(aiProviderCatalog, raw.provider)
    ? raw.provider as AiProviderKey
    : null;
  if (!provider) return null;
  let id = typeof raw.id === "string" ? raw.id.trim() : "";
  if (!id || taken.has(id)) id = generateProfileId(taken);
  taken.add(id);
  const defaults = providerDefaults(provider);
  return {
    id,
    name: (typeof raw.name === "string" ? raw.name.trim() : "") || aiProviderCatalog[provider].label,
    provider,
    visionEnabled: raw.visionEnabled === true,
    baseUrl: normalizeProviderBaseUrl(provider, typeof raw.baseUrl === "string" ? raw.baseUrl : defaults.baseUrl),
    textModel: typeof raw.textModel === "string" ? raw.textModel : defaults.textModel,
    visionModel: typeof raw.visionModel === "string" ? raw.visionModel : defaults.visionModel,
    apiKey: typeof raw.apiKeyEncrypted === "string"
      ? decrypt(raw.apiKeyEncrypted)
      : typeof raw.apiKey === "string" ? raw.apiKey : ""
  };
}

// v1 按服务商存储的配置 -> 每服务商一份连接配置，id 稳定（legacy_<provider>），
// 保证迁移结果可回写且多次读取一致
function migrateLegacySettings(stored: StoredAiSettings): ParsedAiSettings {
  const selectedProvider = normalizeAiProvider(stored.provider);
  const legacyProviders: Partial<Record<AiProviderKey, Omit<AiProfile, "id" | "name" | "provider">>> = {};
  const parseLegacyProvider = (raw: StoredProviderSettings | undefined, provider: AiProviderKey) => {
    if (!raw) return undefined;
    const defaults = providerDefaults(provider);
    return {
      visionEnabled: raw.visionEnabled === true,
      baseUrl: normalizeProviderBaseUrl(provider, typeof raw.baseUrl === "string" ? raw.baseUrl : defaults.baseUrl),
      textModel: typeof raw.textModel === "string" ? raw.textModel : defaults.textModel,
      visionModel: typeof raw.visionModel === "string" ? raw.visionModel : defaults.visionModel,
      apiKey: typeof raw.apiKeyEncrypted === "string"
        ? decrypt(raw.apiKeyEncrypted)
        : typeof raw.apiKey === "string" ? raw.apiKey : ""
    };
  };
  if (isRecord(stored.providers)) {
    for (const key of Object.keys(aiProviderCatalog) as AiProviderKey[]) {
      const parsed = parseLegacyProvider(stored.providers[key], key);
      if (parsed) legacyProviders[key] = parsed;
    }
  }
  // 更早的版本只存一份扁平配置，并入当时选中的服务商
  const hasFlatSettings = Boolean(
    stored.baseUrl || stored.textModel || stored.visionModel || stored.apiKey || stored.apiKeyEncrypted
  );
  if (hasFlatSettings) {
    const flat = parseLegacyProvider(stored, selectedProvider);
    const merged = legacyProviders[selectedProvider];
    legacyProviders[selectedProvider] = {
      visionEnabled: merged?.visionEnabled ?? flat?.visionEnabled ?? false,
      baseUrl: merged?.baseUrl ?? flat?.baseUrl ?? "",
      textModel: merged?.textModel ?? flat?.textModel ?? "",
      visionModel: merged?.visionModel ?? flat?.visionModel ?? "",
      apiKey: merged?.apiKey ?? flat?.apiKey ?? ""
    };
  }

  const keys = new Set<AiProviderKey>();
  for (const key of Object.keys(aiProviderCatalog) as AiProviderKey[]) {
    if (legacyProviders[key]) keys.add(key);
  }
  keys.add(selectedProvider);

  const taskBindings: ParsedAiSettings["taskBindings"] = {};
  if (isRecord(stored.taskBindings)) {
    for (const task of listAiTasks()) {
      const raw = stored.taskBindings[task.key];
      if (!isRecord(raw)) continue;
      const provider = typeof raw.provider === "string" && Object.hasOwn(aiProviderCatalog, raw.provider)
        ? raw.provider as AiProviderKey
        : undefined;
      const model = typeof raw.model === "string" ? raw.model.trim() : "";
      if (provider) keys.add(provider);
      if (provider || model) {
        taskBindings[task.key] = {
          ...(provider ? { profileId: `legacy_${provider}` } : {}),
          ...(model ? { model } : {})
        };
      }
    }
  }

  const profiles: AiProfile[] = [...keys].map((key) => ({
    id: `legacy_${key}`,
    name: aiProviderCatalog[key].label,
    provider: key,
    ...(legacyProviders[key] || providerDefaults(key))
  }));

  return {
    enabled: stored.enabled === true,
    requestTimeoutSeconds: storedRequestTimeoutSeconds(stored.requestTimeoutSeconds),
    extractionDepth: normalizeAiExtractionDepth(stored.extractionDepth),
    defaultProfileId: `legacy_${selectedProvider}`,
    profiles,
    taskBindings
  };
}

function persistSettings(parsed: ParsedAiSettings) {
  getDatabase().prepare(`
    INSERT INTO app_settings (setting_key, value_json) VALUES (?, ?)
    ON CONFLICT(setting_key) DO UPDATE SET value_json = excluded.value_json, updated_at = CURRENT_TIMESTAMP
  `).run(settingKey, JSON.stringify(serializeSettings(parsed)));
}

export function parseStoredSettings(): ParsedAiSettings {
  const row = getDatabase().prepare("SELECT value_json AS valueJson FROM app_settings WHERE setting_key = ?")
    .get(settingKey) as { valueJson: string } | undefined;
  if (!row) return emptySettings();

  try {
    const stored = JSON.parse(row.valueJson) as StoredAiSettings;
    // 旧格式（v1 按服务商存储或更早的扁平配置）一次性迁移并回写为新结构
    if (!Array.isArray(stored.profiles)) {
      const migrated = migrateLegacySettings(stored);
      try {
        persistSettings(migrated);
      } catch {
        // 回写失败不阻塞读取，下次保存时仍会落盘
      }
      return migrated;
    }

    const taken = new Set<string>();
    const profiles = stored.profiles
      .map((raw) => isRecord(raw) ? parseStoredProfile(raw as StoredAiProfile, taken) : null)
      .filter((profile): profile is AiProfile => Boolean(profile));
    const taskBindings: ParsedAiSettings["taskBindings"] = {};
    if (isRecord(stored.taskBindings)) {
      for (const task of listAiTasks()) {
        const raw = stored.taskBindings[task.key];
        if (!isRecord(raw)) continue;
        const profileId = typeof raw.profileId === "string" ? raw.profileId.trim() : "";
        const model = typeof raw.model === "string" ? raw.model.trim() : "";
        if (profileId || model) {
          taskBindings[task.key] = { ...(profileId ? { profileId } : {}), ...(model ? { model } : {}) };
        }
      }
    }
    let defaultProfileId = typeof stored.defaultProfileId === "string" ? stored.defaultProfileId.trim() : "";
    if (defaultProfileId && !profiles.some((profile) => profile.id === defaultProfileId)) defaultProfileId = "";
    if (!defaultProfileId) defaultProfileId = profiles[0]?.id || "";
    return {
      enabled: stored.enabled === true,
      requestTimeoutSeconds: storedRequestTimeoutSeconds(stored.requestTimeoutSeconds),
      extractionDepth: normalizeAiExtractionDepth(stored.extractionDepth),
      defaultProfileId,
      profiles,
      taskBindings
    };
  } catch {
    return emptySettings();
  }
}

export function findAiProfile(parsed: ParsedAiSettings, profileId: string | undefined) {
  if (!profileId) return null;
  return parsed.profiles.find((profile) => profile.id === profileId) || null;
}

export function resolveActiveProfile(parsed: ParsedAiSettings) {
  return findAiProfile(parsed, parsed.defaultProfileId) || parsed.profiles[0] || null;
}

export function normalizeProviderBaseUrl(provider: AiProviderKey, value: string) {
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

function normalizeBaseUrl(value: unknown, fallback: string) {
  const baseUrl = String(value || fallback).trim().replace(/\/+$/, "");
  try {
    const parsed = new URL(baseUrl);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error();
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    throw createError({ statusCode: 400, data: { code: "AI_CONFIG_INVALID" }, statusMessage: "AI API 地址无效" });
  }
}

export function resolveAiBaseUrl(provider: AiProviderKey, value: unknown, fallback: string) {
  return normalizeProviderBaseUrl(provider, normalizeBaseUrl(value, fallback));
}

function maskApiKey(apiKey: string) {
  if (!apiKey) return "";
  if (apiKey.length <= 8) return "••••••••";
  return `${apiKey.slice(0, 3)}••••${apiKey.slice(-4)}`;
}

function serializeSettings(parsed: ParsedAiSettings) {
  return {
    enabled: parsed.enabled,
    requestTimeoutSeconds: parsed.requestTimeoutSeconds,
    extractionDepth: parsed.extractionDepth,
    defaultProfileId: parsed.defaultProfileId,
    profiles: parsed.profiles.map((profile) => ({
      id: profile.id,
      name: profile.name,
      provider: profile.provider,
      visionEnabled: profile.visionEnabled,
      baseUrl: profile.baseUrl,
      textModel: profile.textModel,
      visionModel: profile.visionModel,
      apiKeyEncrypted: encrypt(profile.apiKey)
    })),
    taskBindings: parsed.taskBindings
  };
}

function publicProfile(profile: AiProfile) {
  return {
    id: profile.id,
    name: profile.name,
    provider: profile.provider,
    providerLabel: aiProviderCatalog[profile.provider].label,
    visionEnabled: profile.visionEnabled,
    baseUrl: profile.baseUrl,
    textModel: profile.textModel,
    visionModel: profile.visionModel,
    apiKeyConfigured: Boolean(profile.apiKey),
    apiKeyMasked: maskApiKey(profile.apiKey)
  };
}

function bindingProfile(parsed: ParsedAiSettings, binding: AiTaskBinding | undefined) {
  return findAiProfile(parsed, binding?.profileId) || resolveActiveProfile(parsed);
}

function publicSettings(parsed: ParsedAiSettings) {
  const active = resolveActiveProfile(parsed);
  return {
    enabled: parsed.enabled,
    requestTimeoutSeconds: parsed.requestTimeoutSeconds,
    extractionDepth: parsed.extractionDepth,
    defaultProfileId: active?.id || "",
    // 旧版平铺字段镜像当前默认连接，兼容仍在读取旧字段的调用方
    provider: active?.provider || "deepseek",
    visionEnabled: active?.visionEnabled === true,
    baseUrl: active?.baseUrl || "",
    textModel: active?.textModel || "",
    visionModel: active?.visionModel || "",
    apiKeyConfigured: Boolean(active?.apiKey),
    apiKeyMasked: maskApiKey(active?.apiKey || ""),
    profiles: parsed.profiles.map(publicProfile),
    providers: Object.entries(aiProviderCatalog).map(([key, value]) => ({ key, ...value })),
    tasks: listAiTasks(),
    taskBindings: Object.fromEntries(listAiTasks().map((task) => {
      const binding = parsed.taskBindings[task.key];
      const profile = bindingProfile(parsed, binding);
      return [task.key, {
        profileId: profile?.id || "",
        model: binding?.model || profile?.textModel || "",
        inherited: !binding,
        implemented: task.implemented
      }];
    }))
  };
}

type PublicAiSettings = ReturnType<typeof publicSettings>;

export function getAiSettings(includeSecret?: false): PublicAiSettings;
export function getAiSettings(includeSecret: true): PublicAiSettings & { apiKey: string };
export function getAiSettings(includeSecret = false) {
  const parsed = parseStoredSettings();
  const settings = publicSettings(parsed);
  if (!includeSecret) return settings;
  return {
    ...settings,
    apiKey: resolveActiveProfile(parsed)?.apiKey || ""
  };
}

export function getAiProfileSecrets() {
  return new Map(parseStoredSettings().profiles.map((profile) => [profile.id, profile.apiKey]));
}

export function getAiTaskSettings(taskKey: AiTaskKey, includeSecret = false) {
  const parsed = parseStoredSettings();
  const binding = parsed.taskBindings[taskKey];
  const profile = bindingProfile(parsed, binding);
  return {
    enabled: parsed.enabled,
    taskKey,
    requestTimeoutSeconds: parsed.requestTimeoutSeconds,
    extractionDepth: parsed.extractionDepth,
    provider: profile?.provider || "deepseek",
    profileId: profile?.id || "",
    profileName: profile?.name || "",
    baseUrl: profile?.baseUrl || "",
    model: binding?.model || profile?.textModel || "",
    visionModel: profile?.visionModel || "",
    visionEnabled: profile?.visionEnabled === true,
    apiKey: includeSecret ? profile?.apiKey || "" : "",
    inherited: !binding
  };
}

/* AI 解析计划构建时读取当前解析程度；概览模式只减少单元数量与复核，不改变解析契约。 */
export function resolveAiExtractionDepth(): AiExtractionDepth {
  return parseStoredSettings().extractionDepth;
}

function hasLegacySaveFields(input: AiSettingsInput) {
  return !Array.isArray(input.profiles) && (
    typeof input.provider === "string"
    || input.baseUrl !== undefined
    || input.textModel !== undefined
    || input.visionModel !== undefined
    || input.visionEnabled !== undefined
    || typeof input.apiKey === "string"
    || input.clearApiKey === true
  );
}

function applyProfileInput(
  raw: AiProfileInput,
  existing: AiProfile | undefined,
  taken: Set<string>
): AiProfile {
  const provider = typeof raw.provider === "string" && Object.hasOwn(aiProviderCatalog, raw.provider)
    ? raw.provider as AiProviderKey
    : existing?.provider;
  if (!provider) {
    throw createError({ statusCode: 400, data: { code: "AI_CONFIG_INVALID" }, statusMessage: "连接配置的服务商类型无效" });
  }
  let id = typeof raw.id === "string" ? raw.id.trim() : "";
  if (id && existing && id !== existing.id) id = "";
  if (!id || taken.has(id)) id = generateProfileId(taken);
  taken.add(id);
  const defaults = providerDefaults(provider);
  // 新提交的 Key 优先；明确要求清除且没有新 Key 时清空；否则保留已存 Key
  const submittedKey = typeof raw.apiKey === "string" ? raw.apiKey.trim() : "";
  const apiKey = submittedKey || (raw.clearApiKey === true ? "" : existing?.apiKey || "");
  const visionEnabled = raw.visionEnabled === undefined ? existing?.visionEnabled === true : raw.visionEnabled === true;
  const visionModel = String(raw.visionModel ?? existing?.visionModel ?? defaults.visionModel).trim();
  if (isMiniMaxM2Model(visionModel) && visionEnabled) {
    throw createError({ statusCode: 400, data: { code: "AI_CONFIG_INVALID" }, statusMessage: "MiniMax M2 系列当前不支持视觉增强，请关闭视觉增强" });
  }
  if (visionEnabled && !visionModel) {
    throw createError({ statusCode: 400, data: { code: "AI_CONFIG_INVALID" }, statusMessage: "已开启视觉增强，请先填写视觉模型名称" });
  }
  return {
    id,
    name: (typeof raw.name === "string" ? raw.name.trim() : "") || existing?.name || aiProviderCatalog[provider].label,
    provider,
    visionEnabled,
    baseUrl: resolveAiBaseUrl(provider, raw.baseUrl, existing?.baseUrl || defaults.baseUrl),
    textModel: String(raw.textModel || existing?.textModel || defaults.textModel).trim(),
    visionModel,
    apiKey
  };
}

function applyTaskBindings(
  input: AiSettingsInput["taskBindings"],
  next: ParsedAiSettings,
  taken: Set<string>
) {
  if (!input) return;
  for (const task of listAiTasks()) {
    if (!(task.key in input)) continue;
    const value = input[task.key];
    if (!value) {
      delete next.taskBindings[task.key];
      continue;
    }
    let profileId = typeof value.profileId === "string" ? value.profileId.trim() : "";
    // 兼容旧版按服务商绑定：映射到该服务商的连接配置，缺省时按默认配置补建
    if (!profileId && typeof value.provider === "string" && Object.hasOwn(aiProviderCatalog, value.provider)) {
      const provider = value.provider as AiProviderKey;
      let profile = next.profiles.find((item) => item.provider === provider);
      if (!profile) {
        profile = {
          id: generateProfileId(taken),
          name: aiProviderCatalog[provider].label,
          provider,
          ...providerDefaults(provider)
        };
        taken.add(profile.id);
        next.profiles.push(profile);
      }
      profileId = profile.id;
    }
    const model = String(value.model || "").trim();
    if (profileId && !next.profiles.some((profile) => profile.id === profileId)) {
      throw createError({ statusCode: 400, data: { code: "AI_CONFIG_INVALID" }, statusMessage: `场景“${task.label}”引用的连接配置不存在` });
    }
    if (!profileId && !model) {
      delete next.taskBindings[task.key];
      continue;
    }
    next.taskBindings[task.key] = {
      ...(profileId ? { profileId } : {}),
      ...(model ? { model } : {})
    };
  }
}

function validateAndPersist(next: ParsedAiSettings) {
  if (next.enabled && !next.defaultProfileId) {
    throw createError({ statusCode: 400, data: { code: "AI_CONFIG_INVALID" }, statusMessage: "启用 AI 整理前请先添加连接配置" });
  }
  persistSettings(next);
  return publicSettings(next);
}

export function saveAiSettings(input: AiSettingsInput | undefined) {
  if (!input || !isRecord(input)
    || (input.profiles !== undefined && (!Array.isArray(input.profiles) || !input.profiles.every(isRecord)))
    || (input.taskBindings != null && (!isRecord(input.taskBindings)
      || !Object.values(input.taskBindings).every(value => value == null || isRecord(value))))) {
    throw createError({ statusCode: 400, data: { code: "AI_CONFIG_INVALID" }, statusMessage: "AI 配置格式无效，请检查连接配置和场景绑定" });
  }
  const parsed = parseStoredSettings();
  const taken = new Set(parsed.profiles.map((profile) => profile.id));
  const next: ParsedAiSettings = {
    enabled: input.enabled === undefined ? parsed.enabled : input.enabled === true,
    requestTimeoutSeconds: submittedRequestTimeoutSeconds(input.requestTimeoutSeconds, parsed.requestTimeoutSeconds),
    extractionDepth: normalizeAiExtractionDepth(
      input.extractionDepth === undefined ? parsed.extractionDepth : input.extractionDepth
    ),
    defaultProfileId: parsed.defaultProfileId,
    profiles: [...parsed.profiles],
    taskBindings: { ...parsed.taskBindings }
  };

  if (Array.isArray(input.profiles)) {
    // 全量提交：列表即最终状态，未出现的配置视为删除
    const existingById = new Map(parsed.profiles.map((profile) => [profile.id, profile]));
    const submitted = new Set<string>();
    next.profiles = input.profiles.map((raw) => {
      const existing = typeof raw.id === "string" ? existingById.get(raw.id.trim()) : undefined;
      const profile = applyProfileInput(raw, existing, submitted);
      return profile;
    });
    taken.clear();
    for (const profile of next.profiles) taken.add(profile.id);
    next.defaultProfileId = "";
  } else if (hasLegacySaveFields(input)) {
    // 旧版表单：按服务商更新或新建一份连接配置，并把它设为默认（旧版“当前服务商”语义）
    const provider = normalizeAiProvider(
      input.provider || resolveActiveProfile(parsed)?.provider || "deepseek"
    );
    const existing = next.profiles.find((profile) => profile.provider === provider);
    if (existing) taken.delete(existing.id);
    const updated = applyProfileInput(
      {
        id: existing?.id,
        provider,
        visionEnabled: input.visionEnabled,
        baseUrl: input.baseUrl,
        textModel: input.textModel,
        visionModel: input.visionModel,
        apiKey: input.apiKey,
        clearApiKey: input.clearApiKey
      },
      existing,
      taken
    );
    next.profiles = existing
      ? next.profiles.map((profile) => (profile.id === updated.id ? updated : profile))
      : [...next.profiles, updated];
    next.defaultProfileId = updated.id;
  }

  if (input.defaultProfileId !== undefined) {
    const defaultProfileId = String(input.defaultProfileId || "").trim();
    if (defaultProfileId && !next.profiles.some((profile) => profile.id === defaultProfileId)) {
      throw createError({ statusCode: 400, data: { code: "AI_CONFIG_INVALID" }, statusMessage: "默认连接配置不存在" });
    }
    next.defaultProfileId = defaultProfileId;
  }
  if (!next.defaultProfileId || !next.profiles.some((profile) => profile.id === next.defaultProfileId)) {
    next.defaultProfileId = next.profiles[0]?.id || "";
  }

  applyTaskBindings(input.taskBindings, next, taken);
  return validateAndPersist(next);
}

export async function testAiConnection(input: AiSettingsInput = {}) {
  const parsed = parseStoredSettings();
  const byId = typeof input.profileId === "string" ? findAiProfile(parsed, input.profileId.trim()) : null;
  const provider = normalizeAiProvider(
    input.provider || byId?.provider || resolveActiveProfile(parsed)?.provider || "deepseek"
  );
  const fallbackProfile = byId
    || (input.provider ? parsed.profiles.find((profile) => profile.provider === provider) : resolveActiveProfile(parsed));
  const current = fallbackProfile || { ...providerDefaults(provider) };
  const apiKey = typeof input.apiKey === "string" && input.apiKey.trim() ? input.apiKey.trim() : current.apiKey;
  const textModel = String(input.textModel || current.textModel).trim();
  const testVision = input.testVision === true;
  const model = testVision ? String(input.visionModel || current.visionModel).trim() : textModel;
  if (isMiniMaxM2Model(model) && testVision) {
    throw createError({ statusCode: 400, data: { code: "AI_CONFIG_INVALID" }, statusMessage: "MiniMax M2 系列当前不支持图片输入，请使用文本模型测试" });
  }
  if ((aiProviderHasRequiredApiKey(provider) && !apiKey) || !model) {
    throw createError({
      statusCode: 400, data: { code: "AI_CONFIG_INVALID" },
      statusMessage: aiProviderCatalog[provider].apiKeyRequired === false
        ? `请先配置 ${aiProviderCatalog[provider].label} ${testVision ? "视觉" : "文本"}模型`
        : `请先配置 ${aiProviderCatalog[provider].label} API Key 和${testVision ? "视觉" : "文本"}模型`
    });
  }
  const baseUrl = resolveAiBaseUrl(provider, input.baseUrl, current.baseUrl);
  const testStructuredOutput = !testVision && (provider === "ollama" || provider === "minimax");
  const started = Date.now();
  try {
    const response = await executeAiChatCompletion({
      provider,
      providerKey: provider,
      baseUrl,
      apiKey,
      model
    }, {
      messages: [{
        role: "user",
        content: testVision
          ? [
              { type: "text", text: "Reply with OK if you can read this image." },
              { type: "image_url", image_url: { url: aiVisionProbeImageUrl } }
            ]
          : testStructuredOutput ? "只返回 JSON 对象：{\"ok\":true}" : "reply ok"
      }],
      temperature: resolveAiTemperature(provider, model),
      responseFormat: testStructuredOutput ? "json_object" : "text",
      maxOutputTokens: testStructuredOutput ? 128 : 4,
      timeoutMs: provider === "ollama" ? 120_000 : 15_000,
      timeoutCode: "AI_CONNECTION_TEST_TIMEOUT",
      timeoutMessage: "连接 AI 服务超时",
      networkCode: "AI_CONNECTION_TEST_NETWORK_ERROR",
      networkMessage: "NAS 无法连接 AI 服务"
    });
    if (testStructuredOutput) {
      try {
        const clean = response.content.trim()
          .replace(/^```(?:json)?\s*/i, "")
          .replace(/\s*```$/, "");
        const parsed = JSON.parse(clean) as { ok?: unknown };
        if (!parsed || typeof parsed !== "object") throw new Error();
      } catch {
        throw Object.assign(new Error(`${aiProviderCatalog[provider].label} 模型未返回有效 JSON`), {
          code: "AI_STRUCTURED_JSON_UNSUPPORTED"
        });
      }
    }
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
      upstreamStatus: error.upstreamStatus
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
      throw createError({
        statusCode: 502, data: { code: "AI_UPSTREAM_ERROR", meta: { upstreamStatus: error.upstreamStatus } },
        statusMessage: summary
      });
    }
    const statusMessage = code === "AI_STRUCTURED_JSON_UNSUPPORTED"
      ? `${aiProviderCatalog[provider].label} 服务可以连接，但当前模型无法稳定返回结构化 JSON，请检查模型名称或更换指令遵循能力更强的文本模型`
      : timedOut
      ? provider === "ollama"
        ? "Ollama 模型启动或响应超时，请先在 Ollama 中运行该模型，并检查设备内存、模型名称和服务地址"
        : "连接 AI 服务超时，请检查 NAS 外网连接、代理或服务地址"
      : dnsFailed
        ? "NAS 无法解析 AI 服务域名，请检查 DNS 和外网连接"
        : tlsFailed
          ? "AI 服务 TLS 证书校验失败，请检查 NAS 时间、证书或代理设置"
          : "NAS 无法连接 AI 服务，请检查外网连接、代理、DNS 和 API 地址";
    throw createError({ statusCode: timedOut ? 504 : 502, data: { code: "AI_UPSTREAM_ERROR" }, statusMessage });
  }
    return { ok: true, provider, model, vision: testVision, elapsedMs: Date.now() - started };
}
