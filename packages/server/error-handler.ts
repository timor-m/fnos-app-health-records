import { randomUUID } from "node:crypto";
import { type H3Event } from "h3";
import { toApiErrorPayload, unwrapHttpError } from "./utils/api-error";
import { writeLog } from "./utils/logger";
import { getAppConfig } from "./utils/runtime-config";

function baseURL() {
  const prefix = getAppConfig().gatewayPrefix;
  return prefix ? `${prefix}/` : "/";
}

/*
 * 全局错误兜底：
 * - 业务错误（createError 抛出的 HTTPError）原样透传中文提示；
 * - 未预期错误（代码 bug、依赖异常）记录错误分类便于定位，对外只返回通用提示，不泄露内部细节；
 * - 保留基座路径之外请求的 302 重定向行为（fnOS 网关挂载需要）。
 */
export default async function errorHandler(error: unknown, event: H3Event) {
  const businessError = unwrapHttpError(error);
  const body = toApiErrorPayload(error);
  const path = event.url?.pathname || (event.req?.url ? new URL(event.req.url).pathname : "");
  // A guessed resource ID must not reveal whether an inaccessible archive exists.
  if (/\/api\/(?:reports|members)\//.test(path) && (body.code === 'MEMBER_ACCESS_DENIED' || body.status === 404)) {
    body.status = 404;
    body.code = 'RESOURCE_NOT_FOUND';
    body.message = '资源不存在或无权访问';
  }
  const status = body.status;

  if (status === 404) {
    const url = event.url || new URL(event.req.url);
    const appBase = baseURL();
    if (appBase !== "/" && !url.pathname.startsWith(appBase)) {
      return new Response(null, {
        status: 302,
        headers: {
          location: `${appBase}${url.pathname.slice(1)}${url.search}`
        }
      });
    }
  }

  if (!businessError || status >= 500) {
    body.errorId = randomUUID();
    if (event.context) event.context.errorId = body.errorId;
    let cause = error;
    let nativeCode: string | undefined;
    let sqliteCode: number | undefined;
    const seen = new Set<unknown>();
    for (let depth = 0; cause && typeof cause === "object" && depth < 10 && !seen.has(cause); depth++) {
      seen.add(cause);
      const item = cause as { code?: unknown; errcode?: unknown; cause?: unknown };
      if (typeof item.code === "string" && /^(?:ERR_SQLITE_ERROR|SQLITE_[A-Z_]+|E[A-Z]{2,16}|AI_HTTP_[0-9]{3}|OCR_WORKER_[A-Z_]+)$/.test(item.code)) nativeCode = item.code;
      if (typeof item.errcode === "number" && Number.isSafeInteger(item.errcode)) sqliteCode = item.errcode;
      cause = item.cause;
    }
    await writeLog("error", "unhandled-request-error", {
      method: event.method,
      route: event.context?.matchedRoute?.route || "unmatched",
      errorId: body.errorId,
      statusCode: status,
      nativeCode,
      sqliteCode,
      errorCode: body.code,
      // Do not log exception messages: they may embed report content or upstream responses.
      detail: error instanceof Error ? error.stack?.split("\n").filter(line => /^\s+at /.test(line)).join("\n").slice(0, 2000) : undefined
    });
  }
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}
