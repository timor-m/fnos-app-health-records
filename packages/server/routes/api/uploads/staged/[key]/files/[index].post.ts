import { createError, defineEventHandler, getHeader, getRouterParam } from 'h3';
import { getRequestUser } from '../../../../../../utils/request-user';
import { ok } from '../../../../../../utils/api-response';
import { storeStagedFile } from '../../../../../../services/staged-upload.service';
export default defineEventHandler(async event => {
  const user = getRequestUser(event);
  if (Number(getHeader(event, 'content-length') || 0) > 42 * 1024 * 1024) throw createError({ statusCode: 413, statusMessage: '单文件上限 40MB' });
  // Bound actual bytes, including requests without Content-Length; do not clone the stream.
  const reader = event.req.body?.getReader();
  if (!reader) throw createError({ statusCode: 400, statusMessage: '缺少文件内容' });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 42 * 1024 * 1024) {
        await reader.cancel();
        throw createError({ statusCode: 413, statusMessage: '单文件上限 40MB' });
      }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  let form: FormData;
  try { form = await new Response(Buffer.concat(chunks), { headers: { 'content-type': getHeader(event, 'content-type') || '' } }).formData(); }
  catch { throw createError({ statusCode: 400, statusMessage: '文件请求格式无效' }); }
  const files = form.getAll('file');
  if (files.length !== 1 || typeof files[0] === 'string' || files[0].size > 40 * 1024 * 1024) throw createError({ statusCode: 400, statusMessage: '每次只能传输一个文件' });
  return ok(storeStagedFile(user, getRouterParam(event, 'key') || '', Number(getRouterParam(event, 'index')), new Uint8Array(await files[0].arrayBuffer())));
});
