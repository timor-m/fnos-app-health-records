import busboy from 'busboy';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { getHeader, HTTPError, type H3Event } from 'h3';
import { apiError, classifySystemError } from './api-error';
import { getAppConfig } from './runtime-config';

type UploadedPart = { name: string; filename: string; type: string; path: string; size: number };
type MultipartUpload = { fields: Record<string, string>; files: UploadedPart[] };
type UploadLimits = { requestBytes: number; fileBytes: number; files: number; sizeMessage: string };

/** Own the temporary files until the consumer finishes; never buffer the full request. */
export async function withMultipartUpload<T>(event: H3Event, limits: UploadLimits, consume: (upload: MultipartUpload) => T | Promise<T>): Promise<T> {
  const tooLarge = () => apiError(413, 'FILE_TOO_LARGE', limits.sizeMessage);
  const invalid = () => apiError(400, 'UPLOAD_INVALID', '上传数据读取失败，请重新选择文件后重试');
  if (Number(getHeader(event, 'content-length') || 0) > limits.requestBytes) throw tooLarge();
  if (!event.req.body) throw invalid();
  const contentType = getHeader(event, 'content-type') || '';
  if (!/^multipart\/form-data\s*;/i.test(contentType)) throw invalid();
  let parser: ReturnType<typeof busboy>;
  try {
    parser = busboy({ headers: { 'content-type': contentType }, defParamCharset: 'utf8',
      limits: { fileSize: limits.fileBytes + 1, files: limits.files, fields: 16, fieldSize: 1024 * 1024 } });
  } catch { throw invalid(); }

  // This directory lives on the archive volume, outside directories replaced by restore.
  const root = join(getAppConfig().storageDir, 'uploads');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(root, 'incoming-'));
  const controller = new AbortController();
  const writes: Promise<void>[] = [];
  const upload: MultipartUpload = { fields: Object.create(null), files: [] };
  let failure: unknown;
  const fail = (error: unknown) => {
    failure ??= error;
    // Busboy may still be pushing the current chunk while emitting a limit event.
    queueMicrotask(() => controller.abort());
  };
  parser.on('filesLimit', () => fail(tooLarge()));
  parser.on('fieldsLimit', () => fail(tooLarge()));
  parser.on('field', (name, value, info) => {
    if (info.nameTruncated || info.valueTruncated) fail(tooLarge());
    else upload.fields[name] ??= value;
  });
  parser.on('file', (name, file, info) => {
    const part = { name, filename: info.filename, type: info.mimeType, path: join(directory, String(upload.files.length)), size: 0 };
    upload.files.push(part);
    file.on('limit', () => fail(tooLarge()));
    const count = new Transform({ transform(chunk, _encoding, callback) {
      part.size += chunk.length;
      callback(part.size > limits.fileBytes ? tooLarge() : null, chunk);
    } });
    writes.push(pipeline(file, count, createWriteStream(part.path, { flags: 'wx', mode: 0o600 }), { signal: controller.signal }).catch(fail));
  });
  let received = 0;
  const countRequest = new Transform({ transform(chunk, _encoding, callback) {
    received += chunk.length;
    callback(received > limits.requestBytes ? tooLarge() : null, chunk);
  } });
  try {
    try {
      await pipeline(Readable.fromWeb(event.req.body as import('node:stream/web').ReadableStream), countRequest, parser, { signal: controller.signal });
    } catch (error) { fail(error); }
    await Promise.all(writes);
    if (failure) {
      if (HTTPError.isError(failure) || classifySystemError(failure)) throw failure;
      throw invalid();
    }
    if (!upload.files.length && !Object.keys(upload.fields).length) throw invalid();
    return await consume(upload);
  } finally {
    // Cleanup must not replace a storage error or a successfully committed upload.
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}
