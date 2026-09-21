import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const directory = mkdtempSync(join(tmpdir(), 'upload-api-error-'));
before(() => { process.env.STORAGE_DIR = directory; });
after(() => { delete process.env.STORAGE_DIR; rmSync(directory, { recursive: true, force: true }); });
import { H3, type H3Event } from 'h3';
import uploads from '../routes/api/uploads.post';
import errorHandler from '../error-handler';
import { readUploadFile } from '../utils/read-upload-file';
import { toApiErrorPayload } from '../utils/api-error';

for (const body of ['', 'broken multipart', '{}']) {
  test(`multipart route rejects malformed or empty payload (${body.length} bytes)`, async () => {
    const app = new H3({ onError: errorHandler });
    app.post('/api/uploads', uploads);
    const response = await app.request('http://localhost/api/uploads', {
      method: 'POST', headers: { 'content-type': 'multipart/form-data; boundary=test' }, body
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: true, status: 400, code: 'UPLOAD_INVALID', message: '上传数据读取失败，请重新选择文件后重试' });
  });
}
test('upload size retains FILE_TOO_LARGE and Chinese message', async () => {
  const req = new Request('http://localhost/upload', { method: 'POST', headers: { 'content-length': String(45 * 1024 * 1024) } });
  await assert.rejects(() => readUploadFile({ req, headers: req.headers } as H3Event), (error: unknown) => {
    assert.deepEqual(toApiErrorPayload(error), { error: true, status: 413, code: 'FILE_TOO_LARGE', message: '单文件上限 40 MB' });
    return true;
  });
});
test('interrupted upload stream becomes UPLOAD_INVALID', async () => {
  const body = new ReadableStream({ pull(controller) { controller.error(new Error('private stream detail')); } });
  const req = new Request('http://localhost/upload', { method: 'POST', body, duplex: 'half' } as RequestInit);
  await assert.rejects(() => readUploadFile({ req, headers: req.headers } as H3Event), (error: unknown) => {
    const payload = toApiErrorPayload(error);
    assert.equal(payload.status, 400);
    assert.equal(payload.code, 'UPLOAD_INVALID');
    assert.doesNotMatch(payload.message, /private stream/);
    return true;
  });
});
