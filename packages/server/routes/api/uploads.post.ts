import {
  createError,
  defineEventHandler,
  getHeader,
  readMultipartFormData,
  setResponseStatus
} from "h3";
import { createUpload } from "../../services/upload.service";
import { ok } from "../../utils/api-response";
import { getRequestUser } from "../../utils/request-user";

const maxRequestBytes = 205 * 1024 * 1024;

function textPart(parts: Awaited<ReturnType<typeof readMultipartFormData>>, name: string) {
  const part = parts.find((item) => item.name === name && !item.filename);
  return part ? Buffer.from(part.data).toString("utf8") : "";
}

export default defineEventHandler(async (event) => {
  // NOTE: 不使用 h3 的 assertBodySize — 它会通过 req.clone() 读取整个请求体来测量大小，
  // 而 srvx 的 clone() 实现与原始请求共享 body stream，导致后续 readMultipartFormData
  // 报 "Body has already been read" 错误。改为仅检查 Content-Length header。
  const contentLength = Number(getHeader(event, "content-length") || 0);
  if (contentLength > maxRequestBytes) {
    throw createError({
      statusCode: 413,
      statusMessage: `请求体大小超过限制（最大 ${Math.round(maxRequestBytes / 1024 / 1024)}MB）`
    });
  }
  const parts = await readMultipartFormData(event);
  const memberId = textPart(parts, "memberId").trim();
  if (!memberId) throw createError({ statusCode: 400, statusMessage: "请选择报告所属成员" });

  let rotations: number[] = [];
  let expectedPages: Array<{ rotation?: number; size?: number }> | undefined;
  const manifest = textPart(parts, "manifest");
  if (manifest) {
    try {
      const parsed = JSON.parse(manifest) as { pages?: Array<{ rotation?: number }> };
      expectedPages = parsed.pages;
      rotations = Array.isArray(parsed.pages) ? parsed.pages.map((page) => Number(page.rotation || 0)) : [];
    } catch {
      throw createError({ statusCode: 400, statusMessage: "页面顺序信息无效" });
    }
  }

  const files = parts.filter((part) => part.name === "files" && part.filename).map((part, index) => ({
    originalName: part.filename || `page-${index + 1}`,
    declaredType: part.type,
    data: part.data,
    rotation: rotations[index] || 0
  }));
  const requestKey = textPart(parts, 'requestKey') || undefined;
  if (requestKey && (!Array.isArray(expectedPages) || expectedPages.length !== files.length || expectedPages.some((page, index) => page.size !== files[index]?.data.byteLength))) {
    throw createError({ statusCode: 400, statusMessage: '文件清单与接收内容不一致，请重试整份报告' });
  }
  const result = createUpload(getRequestUser(event), memberId, files, requestKey);
  setResponseStatus(event, 201);
  return ok(result);
});
