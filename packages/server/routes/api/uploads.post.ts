import {
  createError,
  defineEventHandler,
  setResponseStatus
} from "h3";
import { withMultipartUpload } from "../../utils/read-multipart-upload";
import { maxUploadFileBytes } from "../../../shared/upload-limits";
import { createUploadFromStagedFiles } from "../../services/upload.service";
import { ok } from "../../utils/api-response";
import { getRequestUser } from "../../utils/request-user";

const maxRequestBytes = 205 * 1024 * 1024;

export default defineEventHandler(async (event) => withMultipartUpload(event, {
  requestBytes: maxRequestBytes, fileBytes: maxUploadFileBytes, files: 1000,
  sizeMessage: '单文件上限 40 MB，单次请求上限 205 MB'
}, ({ fields, files: receivedFiles }) => {
  const memberId = (fields.memberId || "").trim();
  if (!memberId) throw createError({ statusCode: 400, data: { code: "UPLOAD_INVALID" }, statusMessage: "请选择报告所属成员" });

  let rotations: number[] = [];
  let expectedPages: Array<{ rotation?: number; size?: number }> | undefined;
  const manifest = fields.manifest;
  if (manifest) {
    try {
      const parsed = JSON.parse(manifest) as { pages?: Array<{ rotation?: number }> };
      expectedPages = parsed.pages;
      rotations = Array.isArray(parsed.pages) ? parsed.pages.map((page) => Number(page.rotation || 0)) : [];
    } catch {
      throw createError({ statusCode: 400, data: { code: "UPLOAD_INVALID" }, statusMessage: "页面顺序信息无效" });
    }
  }

  const files = receivedFiles.filter((part) => part.name === "files" && part.filename).map((part, index) => ({
    originalName: part.filename || `page-${index + 1}`,
    sourcePath: part.path,
    size: part.size,
    rotation: rotations[index] || 0
  }));
  const requestKey = fields.requestKey || undefined;
  if (requestKey && (!Array.isArray(expectedPages) || expectedPages.length !== files.length || expectedPages.some((page, index) => page.size !== files[index]?.size))) {
    throw createError({ statusCode: 400, data: { code: "UPLOAD_INVALID" }, statusMessage: '文件清单与接收内容不一致，请重试整份报告' });
  }
  const result = createUploadFromStagedFiles(getRequestUser(event), memberId, files, requestKey);
  setResponseStatus(event, 201);
  return ok(result);
}));
