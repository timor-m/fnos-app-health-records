import { fetchWithTimeout } from "../utils/outbound-request";

export type AiRuntimeMessage = {
  role: "system" | "user" | "assistant";
  content: string | Array<Record<string, unknown>>;
};

export type AiRuntimeConfig = {
  provider: string;
  providerKey?: string;
  baseUrl: string;
  apiKey: string;
  model: string;
};

export type AiRuntimeRequest = {
  messages: AiRuntimeMessage[];
  maxOutputTokens: number;
  temperature?: number;
  responseFormat?: "text" | "json_object";
  timeoutMs: number;
  timeoutCode?: string;
  timeoutMessage?: string;
  networkCode?: string;
  networkMessage?: string;
};

export type AiRuntimeResponse = {
  provider: string;
  model: string;
  content: string;
  reasoningContent: string | null;
  finishReason: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  elapsedMs: number;
};

function numericValue(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

async function upstreamError(response: Response) {
  let detail = "";
  try {
    const text = (await response.text()).trim();
    if (text) {
      try {
        const payload = JSON.parse(text) as { error?: { message?: unknown } | string; message?: unknown };
        detail = String(
          typeof payload.error === "object" ? payload.error?.message || "" : payload.error || payload.message || ""
        ).trim();
      } catch {
        detail = text;
      }
    }
  } catch {
    // Status and provider are still sufficient for callers to classify the failure.
  }
  return detail.slice(0, 600);
}

export function buildAiChatCompletionRequestBody(config: AiRuntimeConfig, request: AiRuntimeRequest) {
  const isMiniMax = config.providerKey === "minimax" || config.provider === "minimax";
  /* DeepSeek v4 默认开启思考模式（effort=high），思维链与回答共享输出预算：
     结构化提取属于誊写型任务，思考开销大且会把 max_tokens 耗尽导致 JSON 截断，
     因此显式关闭；旧模型不认识该参数时由 400 降级逻辑兜底。 */
  const isDeepSeek = config.providerKey === "deepseek";
  return {
    model: config.model,
    temperature: request.temperature ?? 0,
    ...(isMiniMax
      ? { max_completion_tokens: Math.min(2_048, request.maxOutputTokens), reasoning_split: true }
      : { max_tokens: request.maxOutputTokens }),
    ...(isDeepSeek ? { thinking: { type: "disabled" as const } } : {}),
    ...(!isMiniMax && request.responseFormat === "json_object"
      ? { response_format: { type: "json_object" as const } }
      : {}),
    messages: request.messages
  };
}

export async function executeAiChatCompletion(
  config: AiRuntimeConfig,
  request: AiRuntimeRequest
): Promise<AiRuntimeResponse> {
  const started = Date.now();
  const isMiniMax = config.providerKey === "minimax" || config.provider === "minimax";
  let requestBody = buildAiChatCompletionRequestBody(config, request);
  const endpoint = `${config.baseUrl}/chat/completions`;
  const requestOptions = {
    timeoutMs: request.timeoutMs,
    timeoutCode: request.timeoutCode || "AI_REQUEST_TIMEOUT",
    timeoutMessage: request.timeoutMessage || "AI 服务请求超时",
    networkCode: request.networkCode || "AI_NETWORK_ERROR",
    networkMessage: request.networkMessage || "无法连接 AI 服务"
  };
  const send = (body: Record<string, unknown>) => fetchWithTimeout(endpoint, {
    method: "POST",
    headers: {
      ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  }, requestOptions);
  let response = await send(requestBody);

  if (!response.ok && response.status === 400 && "thinking" in requestBody) {
    const detail = await upstreamError(response);
    if (/thinking/i.test(detail)) {
      const { thinking: _unsupported, ...fallbackBody } = requestBody;
      requestBody = fallbackBody;
      response = await send(requestBody);
    } else {
      throw Object.assign(new Error(`AI 服务返回 ${response.status}${detail ? `：${detail}` : ""}`), {
        code: `AI_HTTP_${response.status}`,
        upstreamStatus: response.status,
        upstreamDetail: detail,
        provider: config.provider,
        model: config.model,
        elapsedMs: Date.now() - started
      });
    }
  }

  if (!response.ok && response.status === 400 && "response_format" in requestBody) {
    const detail = await upstreamError(response);
    if (/response[_ ]format|json[_ ]object/i.test(detail)) {
      const { response_format: _unsupported, ...fallbackBody } = requestBody;
      response = await send(fallbackBody);
    } else {
      throw Object.assign(new Error(`AI 服务返回 ${response.status}${detail ? `：${detail}` : ""}`), {
        code: `AI_HTTP_${response.status}`,
        upstreamStatus: response.status,
        upstreamDetail: detail,
        provider: config.provider,
        model: config.model,
        elapsedMs: Date.now() - started
      });
    }
  }

  if (!response.ok) {
    const detail = await upstreamError(response);
    throw Object.assign(new Error(`AI 服务返回 ${response.status}${detail ? `：${detail}` : ""}`), {
      code: `AI_HTTP_${response.status}`,
      upstreamStatus: response.status,
      upstreamDetail: detail,
      provider: config.provider,
      model: config.model,
      elapsedMs: Date.now() - started
    });
  }

  const payload = await response.json() as {
    model?: string;
    choices?: Array<{
      finish_reason?: string;
      message?: {
        content?: string | Array<{ type?: string; text?: string }>;
        reasoning_content?: string;
        reasoning_details?: Array<{ text?: string }>;
      };
    }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const contentValue = payload.choices?.[0]?.message?.content;
  let content = typeof contentValue === "string"
    ? contentValue
    : Array.isArray(contentValue)
      ? contentValue.map((item) => item.text || "").join("")
      : "";
  const message = payload.choices?.[0]?.message;
  const inlineReasoning = isMiniMax
    ? [...content.matchAll(/<think>([\s\S]*?)<\/think>/gi)].map((match) => match[1]?.trim()).filter(Boolean).join("\n")
    : "";
  if (isMiniMax) content = content.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  const reasoningContent = message?.reasoning_content
    || message?.reasoning_details?.map((item) => item.text || "").filter(Boolean).join("\n")
    || inlineReasoning
    || null;
  return {
    provider: config.provider,
    model: payload.model || config.model,
    content,
    reasoningContent,
    finishReason: payload.choices?.[0]?.finish_reason || null,
    promptTokens: numericValue(payload.usage?.prompt_tokens),
    completionTokens: numericValue(payload.usage?.completion_tokens),
    elapsedMs: Date.now() - started
  };
}
