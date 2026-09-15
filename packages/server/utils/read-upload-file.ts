import { createError, getHeader, type H3Event } from 'h3';
import { maxUploadFileBytes } from '../../shared/upload-limits';

/** Bound actual streamed bytes as well as Content-Length before parsing multipart. */
export async function readUploadFile(event: H3Event) {
  const limit = maxUploadFileBytes + 2 * 1024 * 1024;
  const tooLarge = () => createError({ statusCode: 413, statusMessage: '单文件上限 40 MB' });
  if (Number(getHeader(event, 'content-length') || 0) > limit) throw tooLarge();
  const reader = event.req.body?.getReader();
  if (!reader) throw createError({ statusCode: 400, statusMessage: '缺少文件内容' });
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
  } finally { reader.releaseLock(); }
  let form: FormData;
  try { form = await new Response(Buffer.concat(chunks), { headers: { 'content-type': getHeader(event, 'content-type') || '' } }).formData(); }
  catch { throw createError({ statusCode: 400, statusMessage: '文件请求格式无效' }); }
  const files = form.getAll('file');
  if (files.length !== 1 || typeof files[0] === 'string') throw createError({ statusCode: 400, statusMessage: '每次只能传输一个文件' });
  if (files[0].size > maxUploadFileBytes) throw tooLarge();
  return files[0];
}
