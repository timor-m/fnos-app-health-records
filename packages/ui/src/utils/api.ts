import type { ApiResponse } from "../types/api";
import { describeTechnical } from "./error";

const appBasePath = import.meta.env.BASE_URL.endsWith("/") ? import.meta.env.BASE_URL : `${import.meta.env.BASE_URL}/`;
const apiBase = new URL("api/", new URL(appBasePath, window.location.origin));

export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly meta?: Record<string, unknown>
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

export function apiUrl(path: string) {
  return new URL(path.replace(/^\//, ""), apiBase).toString();
}

function networkError(cause: unknown) {
  /* fetch 自身抛出的 TypeError 是英文技术串，转换为可理解的提示并保留细节供排查 */
  return new Error(`无法连接服务器，请检查网络与应用服务状态后重试（${describeTechnical(cause)}）`);
}

function parseApiPayload<T>(status: number, okFlag: boolean, text: string): T {
  let payload: ApiResponse<T>;
  try {
    payload = JSON.parse(text) as ApiResponse<T>;
  } catch {
    /* 网关/代理异常时可能返回 HTML 错误页，JSON 解析失败的原始报错对用户无意义 */
    throw new Error(`服务器返回了无法识别的数据，请稍后重试（HTTP ${status}）`);
  }
  if (!okFlag || !payload.ok) {
    /* 服务端错误体为 { error: true, status, statusText, message }（h3 v2），兼容旧版 statusMessage 与 fail() 的 error.message */
    const message = (typeof payload.error === "object" ? payload.error?.message : "")
      || payload.message
      || payload.statusText
      || payload.statusMessage
      || "请求失败";
    throw new ApiRequestError(okFlag ? message : `${message}（HTTP ${status}）`, status, payload.meta);
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
    throw networkError(cause);
  }
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
    catch (cause) { if (cause instanceof TypeError) throw networkError(cause); throw cause; }
  }
  let response: Response;
  try {
    response = await fetch(apiUrl(path), { method: "POST", body });
  } catch (cause) {
    /* 部分内嵌 WebView（卓易通/纯血鸿蒙容器）会在 fetch 上传 FormData 时被网络层直接断开，
       XHR 走不同的上传实现，作为兼容性回退再试一次；仍失败则报原始网络错误。 */
    try {
      return await xhrUpload<T>(path, body);
    } catch {
      throw networkError(cause);
    }
  }
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
