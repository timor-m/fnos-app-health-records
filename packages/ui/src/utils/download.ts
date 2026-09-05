import { apiUrl } from "./api";
import { describeTechnical } from "./error";

/* 内嵌 WebView（飞牛 App、卓易通/鸿蒙容器等）常忽略 <a download> 的合成点击，
   且页面内没有任何事件能确认下载是否开始。识别到 WebView 环境时，给容器一个
   短暂的处理窗口后降级 window.open，交给系统浏览器或下载器接管。 */
const WEBVIEW_DOWNLOAD_FALLBACK_DELAY_MS = 1000;

export function isEmbeddedWebView(userAgent: string = navigator.userAgent): boolean {
  if (/; wv\)/.test(userAgent)) return true; // Android WebView
  if (/Android/.test(userAgent) && /Version\/4\.0/.test(userAgent) && /Chrome\//.test(userAgent)) return true; // 旧版 Android WebView
  // iOS/iPadOS WKWebView：带 AppleWebKit 但无 Safari 标记（iOS Chrome/Firefox 等完整浏览器保留 Safari 标记，不受影响）
  return /AppleWebKit/.test(userAgent) && !/Safari\//.test(userAgent)
    && (/Mobile\//.test(userAgent) || /Macintosh/.test(userAgent));
}

function scheduleWebViewFallback(url: string) {
  if (!isEmbeddedWebView()) return;
  window.setTimeout(() => {
    window.open(url, "_blank", "noopener");
  }, WEBVIEW_DOWNLOAD_FALLBACK_DELAY_MS);
}

/* 用 location.href 直接下载时，服务端报错会把用户导航到裸 JSON 错误页、应用状态全丢；
   改为 fetch 先校验响应，再生成 Blob 触发浏览器下载，失败抛出让调用方提示 */
export async function downloadFile(path: string, fallbackName: string) {
  let response: Response;
  try {
    response = await fetch(apiUrl(path));
  } catch (cause) {
    throw new Error(`无法连接服务器，请检查网络与应用服务状态后重试（${describeTechnical(cause)}）`);
  }
  if (!response.ok) {
    let detail = "";
    try {
      const payload = await response.json() as { error?: { message?: string }; statusMessage?: string };
      detail = payload.error?.message || payload.statusMessage || "";
    } catch { /* 网关返回的非 JSON 错误页，状态码已足够定位 */ }
    throw new Error(`${detail || "文件下载失败"}（HTTP ${response.status}）`);
  }
  const blob = await response.blob();
  const disposition = response.headers.get("content-disposition") || "";
  const match = /filename\*?=(?:UTF-8''|")?([^";]+)/i.exec(disposition);
  const filename = match?.[1] ? decodeURIComponent(match[1].replace(/"/g, "")) : fallbackName;
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/* 大文件交给浏览器下载器边接收边落盘，避免 response.blob() 在内嵌 WebView 中
   长时间占用内存。HEAD 只校验权限和文件状态，不读取备份正文。 */
export async function downloadStreamedFile(path: string, fallbackName: string) {
  const url = apiUrl(path);
  let response: Response;
  try {
    response = await fetch(url, { method: "HEAD", cache: "no-store" });
  } catch (cause) {
    throw new Error(`无法连接服务器，请检查网络与应用服务状态后重试（${describeTechnical(cause)}）`);
  }
  if (!response.ok) {
    throw new Error(`备份文件下载准备失败（HTTP ${response.status}）`);
  }

  const disposition = response.headers.get("content-disposition") || "";
  const match = /filename\*?=(?:UTF-8''|")?([^";]+)/i.exec(disposition);
  const filename = match?.[1] ? decodeURIComponent(match[1].replace(/"/g, "")) : fallbackName;
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  /* WebView 若把点击当作普通导航，target=_blank 避免整页跳转丢失应用状态；
     桌面浏览器识别 download 属性时不会打开新窗口 */
  anchor.target = "_blank";
  anchor.rel = "noopener";
  anchor.style.display = "none";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  scheduleWebViewFallback(url);
}
