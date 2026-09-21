import { readFile } from 'node:fs/promises';
import type { H3Event } from 'h3';
import { maxUploadFileBytes } from '../../shared/upload-limits';
import { apiError } from './api-error';
import { withMultipartUpload } from './read-multipart-upload';

export async function readUploadFile(event: H3Event) {
  return withMultipartUpload(event, {
    requestBytes: maxUploadFileBytes + 2 * 1024 * 1024,
    fileBytes: maxUploadFileBytes, files: 1, sizeMessage: '单文件上限 40 MB'
  }, async ({ files }) => {
    const file = files[0];
    if (!file || file.name !== 'file') throw apiError(400, 'UPLOAD_INVALID', '每次只能传输一个文件');
    return new File([await readFile(file.path)], file.filename, { type: file.type });
  });
}
