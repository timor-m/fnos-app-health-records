import { fetchWithTimeout } from "../utils/outbound-request";

export type AiRuntimeMessage = {
  role: "system" | "user" | "assistant";
  content: string | Array<Record<string, unknown>>;
};

export type AiRuntimeConfig = {
  provider: string;
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

export async function executeAiChatCompletion(
  config: AiRuntimeConfig,
  request: AiRuntimeRequest
): Promise<AiRuntimeResponse> {
  const started = Date.now();
  const requestBody = {
    model: config.model,
    temperature: request.temperature ?? 0,
    max_tokens: request.maxOutputTokens,
    ...(request.responseFormat === "json_object"
      ? { response_format: { type: "json_object" as const } }
      : {}),
    messages: request.messages
  };
  const response = await fetchWithTimeout(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.apiKey}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(requestBody)
  }, {
    timeoutMs: request.timeoutMs,
    timeoutCode: request.timeoutCode || "AI_REQUEST_TIMEOUT",
    timeoutMessage: request.timeoutMessage || "AI 服务请求超时",
    networkCode: request.networkCode || "AI_NETWORK_ERROR",
    networkMessage: request.networkMessage || "无法连接 AI 服务"
  });

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
      };
    }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const contentValue = payload.choices?.[0]?.message?.content;
  const content = typeof contentValue === "string"
    ? contentValue
    : Array.isArray(contentValue)
      ? contentValue.map((item) => item.text || "").join("")
      : "";
  const reasoningContent = payload.choices?.[0]?.message?.reasoning_content || null;
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
