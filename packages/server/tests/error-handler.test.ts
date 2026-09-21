import assert from "node:assert/strict";
import test from "node:test";
import { createError, type H3Event } from "h3";
import errorHandler from "../error-handler";

test("redirects unprefixed routes with a valid relative Location header", async () => {
  const event = {
    url: new URL("http://127.0.0.1:3534/healthz?probe=1")
  } as H3Event;

  const response = await errorHandler(
    createError({ statusCode: 404, statusMessage: "Not Found" }),
    event
  );

  assert.equal(response.status, 302);
  assert.equal(
    response.headers.get("location"),
    "/app/fnos-app-health-records/healthz?probe=1"
  );
});

import { HTTPError } from 'h3';
import { apiError, toApiErrorPayload } from '../utils/api-error';
import { fail } from '../utils/api-response';

const apiEvent = { method: 'POST', url: new URL('http://localhost/app/fnos-app-health-records/api/test') } as H3Event;
for (const [status, code] of [[400, 'REQUEST_INVALID'], [401, 'AUTH_REQUIRED'], [403, 'PERMISSION_DENIED'],
  [404, 'RESOURCE_NOT_FOUND'], [409, 'RESOURCE_CONFLICT'], [413, 'FILE_TOO_LARGE'],
  [415, 'FILE_FORMAT_UNSUPPORTED'], [429, 'RATE_LIMITED']] as const) {
  test(`legacy H3 ${status} preserves Chinese and supplies ${code}`, async () => {
    const response = await errorHandler(createError({ statusCode: status, statusMessage: '原有中文提示' }), apiEvent);
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), { error: true, status, code, message: '原有中文提示' });
  });
}

test('explicit domain code survives H3 adapter wrapping and preserves metadata', async () => {
  const error = apiError(503, 'FILE_DECODE_FAILED', '文件内容与实际格式不匹配', { retryable: false });
  const wrapped = new HTTPError({ unhandled: true, cause: error });
  const response = await errorHandler(wrapped, apiEvent);
  const body = await response.json();
  assert.match(body.errorId, /^[a-f0-9-]{36}$/);
  delete body.errorId;
  assert.deepEqual(body, { error: true, status: 503, code: 'FILE_DECODE_FAILED',
    message: '文件内容与实际格式不匹配', meta: { retryable: false } });
});

test('unknown error is safe, including wrapped error, and generates a correlation ID', async () => {
  for (const error of [new Error('something internal /private/report'), new HTTPError({ unhandled: true, cause: new Error('secret') })]) {
    const response = await errorHandler(error, apiEvent);
    assert.equal(response.status, 500);
    const body = await response.json();
    assert.equal(body.code, 'INTERNAL_ERROR');
    assert.match(body.message, /系统处理异常/);
    assert.match(body.errorId, /^[a-f0-9-]{36}$/);
    assert.doesNotMatch(JSON.stringify(body), /something internal|private|secret|stack/);
  }
});

const cases = [
  ['ENOSPC', 'STORAGE_UNAVAILABLE', '存储空间不足'], ['EDQUOT', 'STORAGE_UNAVAILABLE', '存储空间不足'],
  ['EACCES', 'STORAGE_UNAVAILABLE', '不可写'], ['EPERM', 'STORAGE_UNAVAILABLE', '不可写'],
  ['EROFS', 'STORAGE_UNAVAILABLE', '不可写'], ['EIO', 'STORAGE_UNAVAILABLE', '读写异常'],
  ['EMFILE', 'STORAGE_UNAVAILABLE', '打开文件'], ['ENFILE', 'STORAGE_UNAVAILABLE', '打开文件'],
  ['SQLITE_BUSY', 'DATABASE_UNAVAILABLE', '繁忙'], ['SQLITE_READONLY', 'DATABASE_UNAVAILABLE', '不可写'],
  ['SQLITE_FULL', 'STORAGE_UNAVAILABLE', '存储空间不足'], ['SQLITE_IOERR_READ', 'DATABASE_UNAVAILABLE', '读写异常'],
  ['SQLITE_CORRUPT', 'DATABASE_UNAVAILABLE', '状态异常'],
  ['PDF_DECODE_FAILED', 'FILE_DECODE_FAILED', 'PDF 文件无法读取'],
  ['IMAGE_DECODE_FAILED', 'FILE_DECODE_FAILED', '图片内容无法读取'],
  ['INPUT_FORMAT_MISMATCH', 'FILE_DECODE_FAILED', '格式不匹配'],
  ['OCR_WORKER_UNAVAILABLE', 'OCR_UNAVAILABLE', 'OCR 识别服务暂不可用'],
  ['AI_HTTP_429', 'AI_UPSTREAM_ERROR', '请求受限']
];
for (const [systemCode, code, message] of cases) {
  test(`classifies ${systemCode} without exposing internal content`, async () => {
    const error = Object.assign(new Error('private input /secret/path'), { code: systemCode, upstreamStatus: 429 });
    const response = await errorHandler(new HTTPError({ unhandled: true, cause: error }), apiEvent);
    const body = await response.json();
    assert.equal(body.code, code);
    assert.ok(body.message.includes(message));
    assert.doesNotMatch(JSON.stringify(body), /private input|secret\/path/);
  });
}

test('SQLite native errcode and exact lock message are supported without broad guessing', () => {
  assert.equal(toApiErrorPayload(Object.assign(new Error('hidden'), { code: 'ERR_SQLITE_ERROR', errcode: 261 })).code, 'DATABASE_UNAVAILABLE');
  assert.equal(toApiErrorPayload(new Error('database is locked')).code, 'DATABASE_UNAVAILABLE');
  assert.equal(toApiErrorPayload(new Error('some database is locked perhaps')).code, 'INTERNAL_ERROR');
  const cycle = new Error('unknown'); cycle.cause = cycle;
  assert.equal(toApiErrorPayload(cycle).code, 'INTERNAL_ERROR');
});

test('business errors take priority over cause classification; 503 is not guessed', () => {
  const error = createError({ statusCode: 409, message: '已有资源冲突', cause: Object.assign(new Error(), { code: 'ENOSPC' }) });
  assert.equal(toApiErrorPayload(error).code, 'RESOURCE_CONFLICT');
  assert.equal(toApiErrorPayload(createError({ statusCode: 503, message: '旧业务提示' })).code, 'INTERNAL_ERROR');
});

test('fail preserves old envelope and metadata with the same top-level code', () => {
  const body = fail('维护中', { status: 503, code: 'DATABASE_UNAVAILABLE', maintenance: { supportedVersion: 1 } });
  assert.equal(body.error.message, '维护中');
  assert.equal(body.code, body.error.code);
  assert.equal(body.status, 503);
  assert.deepEqual(body.meta?.maintenance, { supportedVersion: 1 });
  assert.equal(fail('旧提示').error.message, '旧提示');
});

test('error response and persisted diagnostics share one ID without recording request values or exception text', async () => {
  const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const directory = mkdtempSync(join(tmpdir(), 'error-correlation-'));
  process.env.LOG_DIR = directory;
  try {
    const event = { method: 'GET', url: new URL('http://localhost/api/reports/private-report?query=private-query'),
      context: { matchedRoute: { route: '/api/reports/:id' } } } as H3Event;
    const error = Object.assign(new Error('private-error-text'), { code: 'ERR_SQLITE_ERROR', errcode: 261 });
    const first = await errorHandler(new HTTPError({ unhandled: true, cause: error }), event);
    const body = await first.json();
    const second = await errorHandler(error, event);
    assert.notEqual((await second.json()).errorId, body.errorId);
    const lines = readFileSync(join(directory, 'app.log'), 'utf8');
    const record = JSON.parse(lines.trim().split('\n')[0]);
    assert.equal(record.extra.errorId, body.errorId);
    assert.equal(record.extra.route, '/api/reports/:id');
    assert.equal(record.extra.nativeCode, 'ERR_SQLITE_ERROR');
    assert.equal(record.extra.sqliteCode, 261);
    assert.doesNotMatch(lines, /private-report|private-query|private-error-text/);
    const { listSystemLogs } = await import('../services/system-logs.service');
    const logs = await listSystemLogs({ id: 'test-admin', displayName: 'Test', authenticated: true, isGatewayAdmin: true, provider: 'development' });
    const visible = logs.items.find(item => item.metadata.includes(`问题编号 ${body.errorId}`));
    assert.equal(visible?.detail, 'GET /api/reports/:id');
    assert.ok(visible?.metadata.includes('系统码 ERR_SQLITE_ERROR'));
  } finally { delete process.env.LOG_DIR; rmSync(directory, { recursive: true, force: true }); }
});
