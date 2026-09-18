import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { getDatabase } from "../database/client";
import { getAppConfig } from "../utils/runtime-config";
import { writeAiInputDebugLog } from "../utils/ai-input-debug-log";
import { getAiTaskSettings } from "./ai-settings.service";
import {
  aiProviderHasRequiredApiKey,
  resolveAiTemperature,
} from "./ai-provider";
import {
  buildAiChatCompletionRequestBody,
  executeAiChatCompletion,
  type AiRuntimeConfig,
  type AiRuntimeRequest,
  type AiRuntimeResponse,
} from "./ai-runtime.service";
import { requestWorker } from "./ocr-worker-client";
import {
  redactAiInputText,
  type PlannedOcrLine,
} from "./ai-input-planner.service";
import {
  normalizeAiExtraction,
  type AiExtractionResult,
  type AiObservation,
} from "./ai-extraction.service";

/*
 * AI 视觉复核：文本解析（含遗漏补提取）结束后，把仍存在未确认指标候选的页面原图
 * 发送给视觉模型逐行核对，补充文本链路漏掉的指标。
 *
 * 反幻觉设计：模型只允许核对服务端给出的候选行，验收门要求返回的 q 必须逐字命中
 * 某一候选行（宽白/标点不敏感），命中后证据固定为该 OCR 候选行原文并标记
 * source: "vision"；数值与单位以图片为准，因此归一化证据闸门对纯视觉来源跳过
 * 数值/单位回指（见 indicator-normalization.service.ts 的 visionOnlyEvidence）。
 *
 * 隐私边界：页面原图无法像文本一样自动脱敏，设置页开关旁有明确告知；
 * 只在"详细"解析程度下触发，单份报告默认最多 3 页。
 */
export const aiVisionReviewPolicy = {
  maxPagesPerReport: 3,
  maxCandidatesPerPage: 12,
  imageMaxSize: 2400,
  imageQuality: 92,
  pdfRenderScale: 3,
  maxImageBytes: 8 * 1024 * 1024,
  maxOutputTokens: 2_048,
} as const;

export const aiVisionReviewPromptVersion = "vision-review-v1";

export type AiVisionReviewEvent = {
  type: "vision_review_started" | "vision_review_completed" | "vision_review_failed";
  message: string;
  detail: Record<string, unknown>;
};

export type VisionReviewCandidateLine = {
  pageId: string;
  pageNumber: number;
  line: PlannedOcrLine;
};

export type AiVisionReviewInput = {
  reportId: string;
  /** 文本解析（含遗漏补提取）合并后的结果，用于同名指标去重 */
  result: AiExtractionResult;
  /** 文本链路仍未确认的指标候选行（由编排层用候选闭环语义筛出） */
  candidates: VisionReviewCandidateLine[];
};

export type VisionReviewImage = {
  dataUrl: string;
  bytes: number;
};

export type AiVisionReviewOptions = {
  onEvent?: (event: AiVisionReviewEvent) => void;
  shouldContinue?: () => boolean;
  /** 测试注入点：页面取图与 AI 调用 */
  loadImage?: (reportId: string, pageId: string) => Promise<VisionReviewImage | null>;
  chat?: (
    config: AiRuntimeConfig,
    request: AiRuntimeRequest,
  ) => Promise<AiRuntimeResponse>;
};

export type AiVisionReviewExecutor = (
  input: AiVisionReviewInput,
  options?: AiVisionReviewOptions,
) => Promise<AiExtractionResult | null>;

function configuredMaxPages() {
  const parsed = Number(process.env.AI_VISION_REVIEW_MAX_PAGES);
  if (!Number.isFinite(parsed)) return aiVisionReviewPolicy.maxPagesPerReport;
  // 允许 0：作为紧急停用开关，不重启发版即可关闭视觉复核
  return Math.max(0, Math.min(10, Math.floor(parsed)));
}

type VisionReviewPageGroup = {
  pageId: string;
  pageNumber: number;
  lines: PlannedOcrLine[];
  omittedCandidates: number;
};

export function groupVisionReviewPages(
  candidates: VisionReviewCandidateLine[],
  maxPages = configuredMaxPages(),
) {
  const byPage = new Map<string, VisionReviewPageGroup>();
  for (const candidate of candidates) {
    const existing = byPage.get(candidate.pageId);
    if (existing) {
      existing.lines.push(candidate.line);
    } else {
      byPage.set(candidate.pageId, {
        pageId: candidate.pageId,
        pageNumber: candidate.pageNumber,
        lines: [candidate.line],
        omittedCandidates: 0,
      });
    }
  }
  return [...byPage.values()]
    .sort(
      (left, right) =>
        right.lines.length - left.lines.length ||
        left.pageNumber - right.pageNumber,
    )
    .slice(0, Math.max(0, maxPages))
    .map((group) => {
      /* 页内保持输入序：编排层先给真正的未闭环候选，再给表格失败页的疑似噪声行，
         截断时优先保留可信候选。 */
      const lines = group.lines;
      return {
        ...group,
        lines: lines.slice(0, aiVisionReviewPolicy.maxCandidatesPerPage),
        omittedCandidates: Math.max(
          0,
          lines.length - aiVisionReviewPolicy.maxCandidatesPerPage,
        ),
      };
    })
    .sort((left, right) => left.pageNumber - right.pageNumber);
}

/* 与编排层 compactEvidence 同族：比较"模型指向的是哪一行"，不用于数值锚定。 */
function compactQuoteText(value: string) {
  return String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
    .replace(/^\[\d+\]\s*/, "")
    .replace(/[（）()，,。.:：;；、|\s_\-]+/g, "");
}

function compactNameText(value: string | null | undefined) {
  return String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
    .replace(/[\s（）()，,。.:：;；、|_\-]+/g, "");
}

function resolveStoragePath(relativePath: string) {
  const root = resolve(getAppConfig().storageDir);
  const target = resolve(root, relativePath);
  if (target !== root && !target.startsWith(`${root}/`)) {
    throw new Error("文件路径无效");
  }
  return target;
}

function usableJpeg(path: string) {
  try {
    return existsSync(path) && statSync(path).size > 0;
  } catch {
    return false;
  }
}

/*
 * 页面取图统一走 OCR worker 的 thumbnail 管线（PDF 渲染页 / 图片缩放旋转都支持），
 * 输出控制在 2400px JPEG，避免把多 MB 原图直接塞进请求体。
 * PDF 页复用报告查看器的预览缓存（同路径同参数，先到先生成）；图片页用独立缓存，
 * 缓存键带 rotation，页面旋转后自动失效重渲染。
 */
async function loadVisionReviewImage(
  reportId: string,
  pageId: string,
): Promise<VisionReviewImage | null> {
  const row = getDatabase()
    .prepare(
      `
    SELECT mime_type AS mimeType, storage_path AS storagePath,
      source_page_number AS sourcePageNumber, page_number AS pageNumber, rotation
    FROM report_pages WHERE report_id = ? AND id = ?
  `,
    )
    .get(reportId, pageId) as
    | {
        mimeType: string;
        storagePath: string;
        sourcePageNumber: number | null;
        pageNumber: number;
        rotation: number;
      }
    | undefined;
  if (!row) return null;

  const isPdf = row.mimeType === "application/pdf";
  const cacheRelative = isPdf
    ? join("previews", reportId, `${pageId}.jpg`)
    : join("previews", "vision", reportId, `${pageId}.r${row.rotation || 0}.jpg`);
  const cachePath = resolveStoragePath(cacheRelative);
  if (!usableJpeg(cachePath)) {
    try {
      await requestWorker({
        action: "thumbnail",
        imagePath: resolveStoragePath(row.storagePath),
        mimeType: row.mimeType,
        outputPath: cachePath,
        pageNumber: row.sourcePageNumber || row.pageNumber,
        rotation: row.rotation,
        maxSize: aiVisionReviewPolicy.imageMaxSize,
        quality: aiVisionReviewPolicy.imageQuality,
        renderScale: isPdf ? aiVisionReviewPolicy.pdfRenderScale : undefined,
      });
    } catch {
      // worker 暂不可用时图片页降级读原图；PDF 页无法本地解码，跳过该页
      if (isPdf) return null;
    }
  }
  const sourcePath = usableJpeg(cachePath)
    ? cachePath
    : !isPdf && existsSync(resolveStoragePath(row.storagePath))
      ? resolveStoragePath(row.storagePath)
      : null;
  if (!sourcePath) return null;
  const buffer = await readFile(sourcePath);
  if (!buffer.length || buffer.length > aiVisionReviewPolicy.maxImageBytes) {
    return null;
  }
  const mimeType = sourcePath === cachePath ? "image/jpeg" : row.mimeType;
  return {
    dataUrl: `data:${mimeType};base64,${buffer.toString("base64")}`,
    bytes: buffer.length,
  };
}

function visionReviewSystemPrompt() {
  return `你是体检报告复核助手。用户提供报告单页的原件图片，以及该页 OCR 识别出的候选行；这些候选行疑似包含健康指标，但文本解析未能确认。
任务：对照图片逐行核对候选行。候选行确实是定量或定性指标（有项目名和本次结果）时输出该指标；候选行是表头、注释、叙述或参考说明时不要输出。
数值、单位、参考范围以图片为准；候选行文本与图片不一致时以图片为准；图片中看不清的值不得推测。
q 必须原样填写对应候选行的文本，不得改写、合并候选行，不得输出候选行以外的内容。
只返回一个可被 JSON.parse 解析的 JSON 对象 {"observations":[...]}：每项必填 n（项目名）、r（结果文本）、p（页码）、q（候选行原文）；可选 s（章节）、c（项目代码）、v（数值）、u（单位）、lo、hi（参考上下限）、ref（参考文本）、f（异常标记，只能是 high、low、abnormal、normal）、m（方法）。没有可确认的指标时返回 {"observations":[]}。不要 Markdown、注释或前后说明。`;
}

function visionReviewUserText(group: VisionReviewPageGroup) {
  const redacted = group.lines.map((line) => redactAiInputText(line.text));
  return [
    `第 ${group.pageNumber} 页候选行（共 ${group.lines.length} 行）：`,
    ...redacted.map((text, index) => `[${index + 1}] ${text}`),
    group.omittedCandidates
      ? `（另有 ${group.omittedCandidates} 行候选超出本次复核范围，无需处理）`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function parseVisionJson(content: string) {
  const clean = content
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  return JSON.parse(clean) as unknown;
}

/*
 * 验收门：只接受能把 q 逐字回指到本页某一候选行的指标；证据统一改写成
 * 候选行原文 + source:"vision"。同名指标已在文本结果中出现于本页时视为重复，拒收。
 */
export function acceptVisionObservations(
  parsed: AiObservation[],
  group: VisionReviewPageGroup,
  result: AiExtractionResult,
) {
  const accepted: AiObservation[] = [];
  let rejected = 0;
  const existingNames = new Set(
    result.fields.observations
      .filter((item) =>
        item.evidence.some((entry) => entry.pageNumber === group.pageNumber),
      )
      .map((item) => compactNameText(item.itemName)),
  );
  for (const observation of parsed) {
    const quotes = observation.evidence.map((entry) => entry.quote);
    /* 模型看到的是脱敏后的候选行；匹配时原文与脱敏形态都认，
       命中后证据统一存 OCR 原文行（与持久化证据校验口径一致）。 */
    const matched = group.lines.find((line) =>
      quotes.some((quote) => {
        const compact = compactQuoteText(quote);
        return (
          compact === compactQuoteText(line.text) ||
          compact === compactQuoteText(redactAiInputText(line.text))
        );
      }),
    );
    if (!matched) {
      rejected += 1;
      continue;
    }
    const name = compactNameText(observation.itemName);
    if (
      existingNames.has(name) ||
      accepted.some((item) => compactNameText(item.itemName) === name)
    ) {
      rejected += 1;
      continue;
    }
    accepted.push({
      ...observation,
      evidence: [
        { pageNumber: group.pageNumber, quote: matched.text, source: "vision" },
      ],
    });
  }
  return { accepted, rejected };
}

function sanitizedVisionLogBody(
  body: Record<string, unknown>,
  imageBytes: number,
) {
  const messages = (body.messages as Array<Record<string, unknown>>).map(
    (message) => {
      if (!Array.isArray(message.content)) return message;
      return {
        ...message,
        content: message.content.map((part) =>
          part?.type === "image_url"
            ? { type: "image_url", image_url: { url: `[页面图片 ${imageBytes} bytes]` } }
            : part,
        ),
      };
    },
  );
  return { ...body, messages };
}

export const runVisionReview: AiVisionReviewExecutor = async (
  input,
  options = {},
) => {
  const settings = getAiTaskSettings("report_extraction", true);
  if (
    !settings.enabled ||
    !settings.visionEnabled ||
    !settings.visionModel ||
    !settings.baseUrl ||
    (aiProviderHasRequiredApiKey(settings.provider) && !settings.apiKey)
  ) {
    return null;
  }
  const pages = groupVisionReviewPages(input.candidates);
  if (!pages.length) return null;
  const loadImage = options.loadImage || loadVisionReviewImage;
  const chat = options.chat || executeAiChatCompletion;
  const emit = (event: AiVisionReviewEvent) => options.onEvent?.(event);
  const candidateCount = pages.reduce((sum, page) => sum + page.lines.length, 0);

  emit({
    type: "vision_review_started",
    message: `视觉复核：${pages.length} 页存在 ${candidateCount} 个未确认指标候选，发送页面图给 ${settings.visionModel} 核对`,
    detail: {
      model: settings.visionModel,
      pageNumbers: pages.map((page) => page.pageNumber),
      candidates: candidateCount,
    },
  });

  const config: AiRuntimeConfig = {
    provider: new URL(settings.baseUrl).host,
    providerKey: settings.provider,
    baseUrl: settings.baseUrl,
    apiKey: settings.apiKey,
    model: settings.visionModel,
  };
  const acceptedAll: AiObservation[] = [];
  let rejectedAll = 0;
  let reviewedPages = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let elapsedMs = 0;
  let tokensSeen = false;
  const failures: string[] = [];

  for (const group of pages) {
    if (options.shouldContinue && !options.shouldContinue()) {
      throw Object.assign(new Error("报告任务已取消"), {
        code: "AI_TASK_CANCELLED",
      });
    }
    const started = Date.now();
    try {
      const image = await loadImage(input.reportId, group.pageId);
      if (!image) throw new Error("页面图片不可用");
      const request: AiRuntimeRequest = {
        messages: [
          { role: "system", content: visionReviewSystemPrompt() },
          {
            role: "user",
            content: [
              { type: "text", text: visionReviewUserText(group) },
              { type: "image_url", image_url: { url: image.dataUrl } },
            ],
          },
        ],
        temperature: resolveAiTemperature(
          settings.provider,
          settings.visionModel,
          0,
        ),
        responseFormat: "json_object",
        maxOutputTokens: aiVisionReviewPolicy.maxOutputTokens,
        timeoutMs: settings.requestTimeoutSeconds * 1_000,
        timeoutCode: "AI_REQUEST_TIMEOUT",
        timeoutMessage: `视觉复核第 ${group.pageNumber} 页在 ${settings.requestTimeoutSeconds} 秒内未完成`,
        networkCode: "AI_NETWORK_ERROR",
        networkMessage: "无法连接 AI 服务，请检查 NAS 网络、服务地址和模型状态",
      };
      const requestBody = buildAiChatCompletionRequestBody(config, request);
      await writeAiInputDebugLog({
        provider: config.provider,
        model: config.model,
        promptVersion: aiVisionReviewPromptVersion,
        inputCharacters: request.messages[1]
          ? ((request.messages[1].content as Array<{ text?: string }>)[0]?.text || "")
              .length
          : 0,
        pageCount: 1,
        unitType: "vision_review",
        route: "vision_review",
        pageNumbers: [group.pageNumber],
        requestBody: sanitizedVisionLogBody(requestBody, image.bytes),
      });
      const response = await chat(config, request);
      elapsedMs += response.elapsedMs;
      if (response.promptTokens !== null || response.completionTokens !== null) {
        tokensSeen = true;
        promptTokens += response.promptTokens || 0;
        completionTokens += response.completionTokens || 0;
      }
      if (response.finishReason === "length") {
        throw new Error("视觉模型输出达到长度上限");
      }
      if (!response.content) throw new Error("视觉模型未返回内容");
      const parsed = normalizeAiExtraction(parseVisionJson(response.content));
      const { accepted, rejected } = acceptVisionObservations(
        parsed.fields.observations,
        group,
        input.result,
      );
      acceptedAll.push(...accepted);
      rejectedAll += rejected;
      reviewedPages += 1;
    } catch (error) {
      if ((error as { code?: string })?.code === "AI_TASK_CANCELLED") throw error;
      const message = (error instanceof Error ? error.message : "视觉复核失败").slice(0, 200);
      failures.push(`第 ${group.pageNumber} 页：${message}`);
      elapsedMs += Date.now() - started;
    }
  }

  if (!reviewedPages) {
    emit({
      type: "vision_review_failed",
      message: `视觉复核未完成（不影响文本解析结果）：${failures[0] || "页面图片不可用"}`,
      detail: {
        model: settings.visionModel,
        pageNumbers: pages.map((page) => page.pageNumber),
        failures,
      },
    });
    return null;
  }

  emit({
    type: "vision_review_completed",
    message: `视觉复核完成：复核 ${reviewedPages} 页，补充 ${acceptedAll.length} 项指标${
      rejectedAll ? `，${rejectedAll} 项未通过核验` : ""
    }${failures.length ? `，${failures.length} 页复核失败` : ""}`,
    detail: {
      model: settings.visionModel,
      pageNumbers: pages.map((page) => page.pageNumber),
      reviewedPages,
      candidates: candidateCount,
      accepted: acceptedAll.length,
      rejected: rejectedAll,
      failures,
      promptTokens: tokensSeen ? promptTokens : null,
      completionTokens: tokensSeen ? completionTokens : null,
      elapsedMs,
    },
  });

  return {
    provider: config.provider,
    model: config.model,
    promptVersion: aiVisionReviewPromptVersion,
    ...normalizeAiExtraction({ observations: acceptedAll }),
    rawResponseJson: JSON.stringify({ observations: acceptedAll }),
    promptTokens: tokensSeen ? promptTokens : null,
    completionTokens: tokensSeen ? completionTokens : null,
    elapsedMs,
  };
};
