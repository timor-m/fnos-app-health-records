import { createError, defineEventHandler, readBody } from "h3";
import { ok } from "../../../utils/api-response";
import { getRequestUser } from "../../../utils/request-user";
import { isAdministrator } from "../../../domain/request-user";
import { parseStoredSettings, resolveProvider } from "../../../services/ai-settings.service";
import { normalizeAiProvider, aiProviderCatalog } from "../../../services/ai-provider";
import { executeAiChatCompletion } from "../../../services/ai-runtime.service";

type TestStep = {
  name: string;
  status: "pending" | "success" | "failed";
  message: string;
  elapsedMs?: number;
};

type TestResult = {
  provider: string;
  steps: TestStep[];
  overallSuccess: boolean;
  totalElapsedMs: number;
};

// 用于多模态探测的 32x32 红色图片（base64）
const PROBE_IMAGE_B64 = "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAJ0lEQVR42u3NsQkAAAjAsP7/tF7hIASyp6lTCQQCgUAgEAgEgi/BAjLD/C5w/SM9AAAAAElFTkSuQmCC";

// 图片探测提示词
const IMAGE_PROBE_PROMPT = "What is the single dominant color of this image? Reply with ONLY the color name, nothing else.";

// 红色系关键词
const RED_KEYWORDS = ["red", "scarlet", "crimson", "vermilion", "maroon", "红"];

export default defineEventHandler(async (event) => {
  if (!isAdministrator(getRequestUser(event))) throw createError({ statusCode: 403, statusMessage: "仅管理员可测试 AI 配置" });

  const body = (await readBody(event)) as Record<string, unknown> || {};
  const provider = normalizeAiProvider(body.provider);
  const parsed = parseStoredSettings();
  const current = resolveProvider(provider, parsed);

  const apiKey = typeof body.apiKey === "string" && body.apiKey.trim()
    ? body.apiKey.trim()
    : current.apiKey;
  const textModel = String(body.textModel || current.textModel).trim();
  const visionModel = String(body.visionModel || current.visionModel).trim();
  const baseUrl = current.baseUrl;

  // 验证必填项
  if (aiProviderCatalog[provider].apiKeyRequired !== false && !apiKey) {
    throw createError({
      statusCode: 400,
      statusMessage: `请先配置 ${aiProviderCatalog[provider].label} API Key`
    });
  }

  if (!textModel) {
    throw createError({
      statusCode: 400,
      statusMessage: "请先配置文本模型"
    });
  }

  const steps: TestStep[] = [];
  const overallStartTime = Date.now();

  // 步骤 1：测试 API Key 可用性（通过获取模型列表）
  const step1Start = Date.now();
  steps.push({ name: "测试 API Key", status: "pending", message: "正在验证..." });

  try {
    const modelsUrl = `${baseUrl}/models`;
    const response = await fetch(modelsUrl, {
      method: "GET",
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(10_000)
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`HTTP ${response.status}: ${detail.slice(0, 200)}`);
    }

    steps[steps.length - 1] = {
      name: "测试 API Key",
      status: "success",
      message: "API Key 验证通过",
      elapsedMs: Date.now() - step1Start
    };
  } catch (cause) {
    const error = cause as Error & { code?: string };
    const code = error.code || "";
    const timedOut = /TIMEOUT|TIMEDOUT/i.test(code);

    steps[steps.length - 1] = {
      name: "测试 API Key",
      status: "failed",
      message: timedOut ? "连接超时" : `验证失败：${error.message}`,
      elapsedMs: Date.now() - step1Start
    };

    return ok({
      provider,
      steps,
      overallSuccess: false,
      totalElapsedMs: Date.now() - overallStartTime
    } as TestResult);
  }

  // 步骤 2：测试文本模型
  const step2Start = Date.now();
  steps.push({ name: "测试文本模型", status: "pending", message: `正在测试 ${textModel}...` });

  try {
    const result = await executeAiChatCompletion(
      { provider, baseUrl, apiKey, model: textModel },
      {
        messages: [{ role: "user", content: "reply ok" }],
        temperature: 0,
        maxOutputTokens: 4,
        timeoutMs: 15_000,
        timeoutCode: "TEXT_MODEL_TIMEOUT",
        timeoutMessage: "文本模型测试超时",
        networkCode: "TEXT_MODEL_NETWORK_ERROR",
        networkMessage: "无法连接文本模型"
      }
    );

    steps[steps.length - 1] = {
      name: "测试文本模型",
      status: "success",
      message: `模型可用，响应：${result.content.slice(0, 50)}`,
      elapsedMs: Date.now() - step2Start
    };
  } catch (cause) {
    const error = cause as Error & { upstreamStatus?: number; code?: string };
    const upstreamStatus = error.upstreamStatus;
    const code = error.code || "";
    const timedOut = /TIMEOUT|TIMEDOUT/i.test(code);

    let message = "测试失败";
    if (upstreamStatus === 404) {
      message = "模型 ID 不存在，请检查模型名称";
    } else if (upstreamStatus === 401 || upstreamStatus === 403) {
      message = "认证失败，请检查 API Key";
    } else if (upstreamStatus === 429) {
      message = "请求受限，请检查额度或余额";
    } else if (timedOut) {
      message = "连接超时，请检查网络";
    } else {
      message = `测试失败：${error.message}`;
    }

    steps[steps.length - 1] = {
      name: "测试文本模型",
      status: "failed",
      message,
      elapsedMs: Date.now() - step2Start
    };

    return ok({
      provider,
      steps,
      overallSuccess: false,
      totalElapsedMs: Date.now() - overallStartTime
    } as TestResult);
  }

  // 步骤 3：测试视觉模型（如果配置了）
  if (visionModel) {
    const step3Start = Date.now();
    steps.push({ name: "测试视觉模型", status: "pending", message: `正在测试 ${visionModel}...` });

    try {
      const result = await executeAiChatCompletion(
        { provider, baseUrl, apiKey, model: visionModel },
        {
          messages: [{
            role: "user",
            content: [
              { type: "text", text: "reply ok" },
              { type: "image_url", image_url: { url: `data:image/png;base64,${PROBE_IMAGE_B64}` } }
            ]
          }],
          temperature: 0,
          maxOutputTokens: 4,
          timeoutMs: 15_000,
          timeoutCode: "VISION_MODEL_TIMEOUT",
          timeoutMessage: "视觉模型测试超时",
          networkCode: "VISION_MODEL_NETWORK_ERROR",
          networkMessage: "无法连接视觉模型"
        }
      );

      steps[steps.length - 1] = {
        name: "测试视觉模型",
        status: "success",
        message: `模型可用，响应：${result.content.slice(0, 50)}`,
        elapsedMs: Date.now() - step3Start
      };
    } catch (cause) {
      const error = cause as Error & { upstreamStatus?: number; code?: string };
      const upstreamStatus = error.upstreamStatus;
      const code = error.code || "";
      const timedOut = /TIMEOUT|TIMEDOUT/i.test(code);

      let message = "测试失败";
      if (upstreamStatus === 404) {
        message = "模型 ID 不存在，请检查模型名称";
      } else if (upstreamStatus === 401 || upstreamStatus === 403) {
        message = "认证失败，请检查 API Key";
      } else if (upstreamStatus === 429) {
        message = "请求受限，请检查额度或余额";
      } else if (timedOut) {
        message = "连接超时，请检查网络";
      } else {
        message = `测试失败：${error.message}`;
      }

      steps[steps.length - 1] = {
        name: "测试视觉模型",
        status: "failed",
        message,
        elapsedMs: Date.now() - step3Start
      };

      return ok({
        provider,
        steps,
        overallSuccess: false,
        totalElapsedMs: Date.now() - overallStartTime
      } as TestResult);
    }

    // 步骤 4：校验视觉模型多模态能力
    const step4Start = Date.now();
    steps.push({ name: "校验多模态能力", status: "pending", message: "正在探测图片识别能力..." });

    try {
      const result = await executeAiChatCompletion(
        { provider, baseUrl, apiKey, model: visionModel },
        {
          messages: [{
            role: "user",
            content: [
              { type: "text", text: IMAGE_PROBE_PROMPT },
              { type: "image_url", image_url: { url: `data:image/png;base64,${PROBE_IMAGE_B64}` } }
            ]
          }],
          temperature: 0,
          maxOutputTokens: 200,
          timeoutMs: 15_000,
          timeoutCode: "MULTIMODAL_PROBE_TIMEOUT",
          timeoutMessage: "多模态探测超时",
          networkCode: "MULTIMODAL_PROBE_NETWORK_ERROR",
          networkMessage: "多模态探测失败"
        }
      );

      const answer = result.content.toLowerCase().trim();
      const reasoning = result.reasoningContent?.toLowerCase().trim() || "";
      
      // 参考 QwenPaw：同时检查 content 和 reasoning_content 字段
      const supportsMultimodal = 
        RED_KEYWORDS.some((kw) => answer.includes(kw)) ||
        (reasoning && RED_KEYWORDS.some((kw) => reasoning.includes(kw)));

      steps[steps.length - 1] = {
        name: "校验多模态能力",
        status: supportsMultimodal ? "success" : "failed",
        message: supportsMultimodal
          ? `多模态支持确认（回答：${result.content.slice(0, 50)}${reasoning ? '，推理内容包含识别结果' : ''}）`
          : `模型可能不支持多模态（回答：${result.content.slice(0, 100)}${reasoning ? `，推理内容：${reasoning.slice(0, 50)}` : ''}）`,
        elapsedMs: Date.now() - step4Start
      };
    } catch (cause) {
      const error = cause as Error;
      steps[steps.length - 1] = {
        name: "校验多模态能力",
        status: "failed",
        message: `探测失败：${error.message}`,
        elapsedMs: Date.now() - step4Start
      };
    }
  } else {
    steps.push({
      name: "测试视觉模型",
      status: "pending",
      message: "未配置视觉模型，跳过"
    });
  }

  const overallSuccess = steps.every((s) => s.status === "success" || s.status === "pending");

  return ok({
    provider,
    steps,
    overallSuccess,
    totalElapsedMs: Date.now() - overallStartTime
  } as TestResult);
});