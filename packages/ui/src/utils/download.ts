import { apiUrl } from "./api";
import { copyTextToClipboard } from "./clipboard";
import { describeTechnical } from "./error";
import { useToast } from "../composables/useToast";

/* 内嵌 WebView（飞牛 App、卓易通/鸿蒙容器等）无法走浏览器的下载流程：
   合成 <a download> 点击常被忽略；window.open/锚点跳转 attachment 地址在 iOS WKWebView
   会被 WebKit 策略中断（WebKitErrorDomain 102）并整页显示错误。可用路径是 Web Share API
   分享文件（系统分享菜单可"存储到文件"），不支持时复制链接引导用户去系统浏览器下载。 */
const WEBVIEW_SHARE_MAX_BYTES = 100 * 1024 * 1024;

export function isEmbeddedWebView(userAgent: string = navigator.userAgent): boolean {
  if (/; wv\)/.test(userAgent)) return true; // Android WebView
  if (/Android/.test(userAgent) && /Version\/4\.0/.test(userAgent) && /Chrome\//.test(userAgent)) return true; // 旧版 Android WebView
  // iOS/iPadOS WKWebView：带 AppleWebKit 但无 Safari 标记（iOS Chrome/Firefox 等完整浏览器保留 Safari 标记，不受影响）
  return /AppleWebKit/.test(userAgent) && !/Safari\//.test(userAgent)
    && (/Mobile\//.test(userAgent) || /Macintosh/.test(userAgent));
}

/* iOS/iPadOS 平台（含飞牛 App 的 WKWebView）：容器可能自定义 UA 并带上 Safari 标记，
   靠 UA 无法可靠区分 Safari 与内嵌容器；而 iOS 上任何 attachment 导航都可能触发
   WebKitErrorDomain 102 错误页。因此 iOS 整体改走分享/复制链接路径——系统分享菜单
   在 Safari 里同样可用（可直接"存储到文件"），体验不差于浏览器下载。 */
function isIosLike(userAgent: string = navigator.userAgent): boolean {
  return /iPhone|iPad|iPod/.test(userAgent) || (/Macintosh/.test(userAgent) && /Mobile\//.test(userAgent));
}

function useWebSharePath() {
  return isEmbeddedWebView() || isIosLike();
}

function canShareFiles() {
  if (typeof navigator.canShare !== "function" || typeof navigator.share !== "function") return false;
  try {
    return navigator.canShare({ files: [new File([" "], "probe.pdf", { type: "application/pdf" })] });
  } catch {
    return false;
  }
}

async function copyLinkWithToast(url: string) {
  const toast = useToast();
  if (await copyTextToClipboard(url)) {
    toast.show("已复制下载链接，请在系统浏览器中打开下载", 3600);
  } else {
    toast.show("当前环境无法直接下载，请在系统浏览器中打开应用后重试", 3600);
  }
}

async function shareBlobInWebView(blob: Blob, filename: string, fallbackUrl: string) {
  if (canShareFiles() && blob.size <= WEBVIEW_SHARE_MAX_BYTES) {
    const file = new File([blob], filename, { type: blob.type || "application/octet-stream" });
    if (navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: filename });
        return;
      } catch (cause) {
        if (cause instanceof DOMException && cause.name === "AbortError") return; // 用户主动取消分享
        /* 分享失败则退回复制链接 */
      }
    }
  }
  await copyLinkWithToast(fallbackUrl);
}

async function downloadInWebView(url: string, filename: string, contentLength: number | null) {
  const sizeKnown = contentLength !== null && Number.isFinite(contentLength);
  if (canShareFiles() && (!sizeKnown || (contentLength as number) <= WEBVIEW_SHARE_MAX_BYTES)) {
    try {
      const response = await fetch(url, { cache: "no-store" });
      if (response.ok) {
        await shareBlobInWebView(await response.blob(), filename, url);
        return;
      }
    } catch { /* 拉取失败则退回复制链接 */ }
  }
  await copyLinkWithToast(url);
}

function triggerAnchorDownload(url: string, filename: string) {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  /* 个别浏览器忽略 download 属性时，target=_blank 避免整页跳转丢失应用状态；
     识别 download 属性时不会打开新窗口 */
  anchor.target = "_blank";
  anchor.rel = "noopener";
  anchor.style.display = "none";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}

/* 已有完整 URL 的下载入口（如 PDF 原件查看器）：WebView 走分享/复制链接，浏览器走锚点下载。 */
export async function downloadDirectUrl(url: string, filename: string) {
  if (useWebSharePath()) {
    await downloadInWebView(url, filename, null);
    return;
  }
  triggerAnchorDownload(url, filename);
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
  if (useWebSharePath()) {
    await shareBlobInWebView(blob, filename, apiUrl(path));
    return;
  }
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
  if (useWebSharePath()) {
    const sizeHeader = response.headers.get("content-length");
    const contentLength = sizeHeader === null ? null : Number(sizeHeader);
    await downloadInWebView(url, filename, contentLength);
    return;
  }
  triggerAnchorDownload(url, filename);
}
