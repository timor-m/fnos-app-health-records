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

  if (!businessError) {
    await writeLog("error", "unhandled-request-error", {
      method: event.method,
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
