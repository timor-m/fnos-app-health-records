import { apiError } from "./api-error";
import { HTTPError } from "h3";
import { createError, getHeader, type H3Event } from 'h3';
import { maxUploadFileBytes } from '../../shared/upload-limits';

/** Bound actual streamed bytes as well as Content-Length before parsing multipart. */
export async function readUploadFile(event: H3Event) {
  const limit = maxUploadFileBytes + 2 * 1024 * 1024;
  const tooLarge = () => createError({ statusCode: 413, data: { code: "FILE_TOO_LARGE" }, statusMessage: '单文件上限 40 MB' });
  if (Number(getHeader(event, 'content-length') || 0) > limit) throw tooLarge();
  const reader = event.req.body?.getReader();
  if (!reader) throw createError({ statusCode: 400, data: { code: "UPLOAD_INVALID" }, statusMessage: '缺少文件内容' });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > limit) { await reader.cancel(); throw tooLarge(); }
      chunks.push(chunk.value);
    }
  } catch (cause) {
    if (HTTPError.isError(cause)) throw cause;
    throw apiError(400, "UPLOAD_INVALID", "上传数据读取失败，请重新选择文件后重试");
  } finally { reader.releaseLock(); }
  let form: FormData;
  try { form = await new Response(Buffer.concat(chunks), { headers: { 'content-type': getHeader(event, 'content-type') || '' } }).formData(); }
  catch { throw createError({ statusCode: 400, data: { code: "UPLOAD_INVALID" }, statusMessage: '文件请求格式无效' }); }
  const files = form.getAll('file');
  if (files.length !== 1 || typeof files[0] === 'string') throw createError({ statusCode: 400, data: { code: "UPLOAD_INVALID" }, statusMessage: '每次只能传输一个文件' });
  if (files[0].size > maxUploadFileBytes) throw tooLarge();
  return files[0];
}
