import { createError, defineEventHandler, getQuery } from "h3";
import { ok } from "../../../utils/api-response";
import { getRequestUser } from "../../../utils/request-user";
import { isAdministrator } from "../../../domain/request-user";
import { findAiProfile, parseStoredSettings, resolveActiveProfile, resolveAiBaseUrl } from "../../../services/ai-settings.service";
import { normalizeAiProvider, aiProviderCatalog } from "../../../services/ai-provider";
import { fetchWithTimeout } from "../../../utils/outbound-request";

export default defineEventHandler(async (event) => {
  if (!isAdministrator(getRequestUser(event))) throw createError({ statusCode: 403, statusMessage: "仅管理员可获取模型列表" });

  const query = getQuery(event);
  const parsed = parseStoredSettings();
  // profileId 指向已保存的连接配置时复用其地址和 Key；否则按查询参数测试未保存的编辑内容
  const profile = typeof query.profileId === "string" ? findAiProfile(parsed, query.profileId.trim()) : null;
  const provider = normalizeAiProvider(query.provider || profile?.provider || resolveActiveProfile(parsed)?.provider);
  const fallback = profile
    || (query.provider ? parsed.profiles.find((item) => item.provider === provider) : resolveActiveProfile(parsed));
  const current = fallback || { baseUrl: aiProviderCatalog[provider].defaultBaseUrl, apiKey: "" };

  // 获取 API Key（优先使用查询参数，否则使用已保存的配置）
  const apiKey = typeof query.apiKey === "string" && query.apiKey.trim()
    ? query.apiKey.trim()
    : current.apiKey;

  // 获取 Base URL
  const baseUrl = resolveAiBaseUrl(provider, query.baseUrl, current.baseUrl);

  if (aiProviderCatalog[provider].apiKeyRequired !== false && !apiKey) {
    throw createError({
      statusCode: 400, data: { code: "AI_CONFIG_INVALID" },
      statusMessage: `请先配置 ${aiProviderCatalog[provider].label} API Key`
    });
  }

  try {
    // 调用 OpenAI 兼容的 /v1/models 端点
    const modelsUrl = `${baseUrl}/models`;
    const response = await fetchWithTimeout(modelsUrl, {
      method: "GET",
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {}
    }, {
      timeoutMs: 10_000,
      timeoutCode: "AI_MODELS_TIMEOUT",
      timeoutMessage: "获取模型列表超时",
      networkCode: "AI_MODELS_NETWORK_ERROR",
      networkMessage: "无法连接 AI 服务获取模型列表"
    });

    if (!response.ok) {
      throw createError({
        statusCode: 502, data: { code: "AI_UPSTREAM_ERROR", meta: { upstreamStatus: response.status } },
        statusMessage: "获取模型列表失败，请检查 AI 服务状态和配置"
      });
    }

    const payload = await response.json() as {
      data?: Array<{ id?: string; name?: string; owned_by?: string }>;
    };

    // 标准化模型列表
    const models = (payload.data || [])
      .map((item) => ({
        id: item.id || "",
        name: item.name || item.id || "",
        ownedBy: item.owned_by || ""
      }))
      .filter((item) => item.id)
      .sort((a, b) => a.name.localeCompare(b.name));

    return ok({
      provider,
      models,
      total: models.length
    });
  } catch (cause) {
    const error = cause as Error & { code?: string; statusCode?: number };
    if (error.statusCode) throw error;

    const code = error.code || "";
    const timedOut = /TIMEOUT|TIMEDOUT/i.test(code);
    const dnsFailed = /ENOTFOUND|EAI_AGAIN/i.test(code);

    throw createError({
      statusCode: timedOut ? 504 : 502, data: { code: "AI_UPSTREAM_ERROR" },
      statusMessage: timedOut
        ? "获取模型列表超时，请检查网络连接"
        : dnsFailed
          ? "无法解析 AI 服务域名，请检查 DNS"
          : "获取模型列表失败，请检查 AI 服务状态和网络"
    });
  }
});
