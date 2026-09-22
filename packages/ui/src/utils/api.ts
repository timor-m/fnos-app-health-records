import type { ApiResponse } from "../types/api";
import { describeTechnical } from "./error";

const appBasePath = import.meta.env.BASE_URL.endsWith("/") ? import.meta.env.BASE_URL : `${import.meta.env.BASE_URL}/`;
const apiBase = new URL("api/", new URL(appBasePath, window.location.origin));

export class ApiRequestError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly errorId?: string;
  readonly meta?: Record<string, unknown>;
  constructor(message: string, options: { status: number; code?: string; errorId?: string; meta?: Record<string, unknown> }) {
    super([message, options.code && `错误码：${options.code}`, options.errorId && `问题编号：${options.errorId}`].filter(Boolean).join("\n"));
    this.name = "ApiRequestError";
    this.status = options.status;
    this.code = options.code;
    this.errorId = options.errorId;
    this.meta = options.meta;
  }
}

export function apiUrl(path: string) {
  return new URL(path.replace(/^\//, ""), apiBase).toString();
}

function networkError() {
  /* fetch 自身抛出的 TypeError 是英文技术串，转换为可理解的提示，避免显示底层细节 */
  return new Error("无法连接服务器，请检查网络与应用服务状态后重试");
}

export function parseApiPayload<T>(status: number, okFlag: boolean, text: string): T {
  let payload: ApiResponse<T>;
  try {
    payload = JSON.parse(text) as ApiResponse<T>;
    if (!payload || typeof payload !== "object") throw new Error();
  } catch {
    /* 网关/代理异常时可能返回 HTML 错误页，JSON 解析失败的原始报错对用户无意义 */
    throw new ApiRequestError("服务器返回了无法识别的数据，请稍后重试", { status });
  }
  if (!okFlag || !payload.ok) {
    /* 服务端错误体为 { error: true, status, statusText, message }（h3 v2），兼容旧版 statusMessage 与 fail() 的 error.message */
    const message = (typeof payload.error === "object" ? payload.error?.message : "")
      || payload.message
      || payload.statusText
      || payload.statusMessage
      || "请求失败";
    const nested = typeof payload.error === "object" ? payload.error : undefined;
    throw new ApiRequestError(message, { status, code: payload.code || nested?.code,
      errorId: payload.errorId || nested?.errorId, meta: payload.meta });
  }
  return payload.data;
}

export async function request<T>(path: string, init?: RequestInit) {
  let response: Response;
  try {
    response = await fetch(apiUrl(path), {
      ...init,
      headers: {
        ...(typeof init?.body === "string" ? { "content-type": "application/json" } : {}),
        ...init?.headers
      }
    });
  } catch (cause) {
    throw networkError();
  }
  if([401,403,404].includes(response.status) && typeof window!=="undefined") window.dispatchEvent(new Event("health-access-denied"));
  return parseApiPayload<T>(response.status, response.ok, await response.text());
}

function xhrUpload<T>(path: string, body: FormData, onProgress?: (percent: number) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", apiUrl(path));
    xhr.timeout = 10 * 60 * 1000;
    if (onProgress) xhr.upload.onprogress = event => {
      if (event.lengthComputable) onProgress(Math.round(event.loaded / event.total * 100));
    };
    xhr.onload = () => {
      try {
        resolve(parseApiPayload<T>(xhr.status, xhr.status >= 200 && xhr.status < 300, xhr.responseText));
      } catch (cause) {
        reject(cause);
      }
    };
    xhr.onerror = () => reject(new TypeError("XHR upload failed"));
    xhr.ontimeout = () => reject(new TypeError("XHR upload timeout"));
    xhr.send(body);
  });
}

export async function requestUpload<T>(path: string, body: FormData, onProgress?: (percent: number) => void): Promise<T> {
  if (onProgress) {
    try { return await xhrUpload<T>(path, body, onProgress); }
    catch (cause) { if (cause instanceof TypeError) throw networkError(); throw cause; }
  }
  let response: Response;
  try {
    response = await fetch(apiUrl(path), { method: "POST", body });
  } catch (cause) {
    /* 部分内嵌 WebView（卓易通/纯血鸿蒙容器）会在 fetch 上传 FormData 时被网络层直接断开，
       XHR 走不同的上传实现，作为兼容性回退再试一次；仍失败则报原始网络错误。 */
    try {
      return await xhrUpload<T>(path, body);
    } catch (fallbackCause) {
      if (fallbackCause instanceof ApiRequestError) throw fallbackCause;
      throw networkError();
    }
  }
  if([401,403,404].includes(response.status) && typeof window!=="undefined") window.dispatchEvent(new Event("health-access-denied"));
  return parseApiPayload<T>(response.status, response.ok, await response.text());
}

export function reportClientSystemError(source: "vue" | "promise", cause: unknown) {
  const detail = describeTechnical(cause).slice(0, 500);
  if (!detail) return;
  void fetch(apiUrl("audit/system/client"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source, detail }),
    keepalive: true
  }).catch(() => {
    // A disconnected server cannot receive its own frontend diagnostic event.
  });
}
