import assert from 'node:assert/strict';
import test from 'node:test';
import { H3 } from 'h3';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import handler from '../routes/api/wechat-group.get';
import { getWechatGroup, isWechatGroupQrContent, parseWechatGroupResult } from '../services/wechat-group.service';
import { sendFeedbackRequest } from '../services/feedback-remote.service';
import { getFeedbackInstallation } from '../services/feedback-installation.service';
import { closeDatabaseForTests, getDatabase } from '../database/client';
import { getAppConfig } from '../utils/runtime-config';
import { deploymentType, feedbackUserAgent } from '../utils/deployment';

const serverTime = '2026-10-23T04:00:00.000Z';
const localNow = new Date('2027-10-23T04:00:00.000Z');
const group = {
  id: 7,
  name: '合成测试交流群',
  description: '合成说明',
  qrContent: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZuUAAAAASUVORK5CYII=',
  expiresAt: '2026-10-29T04:00:00.000Z',
  revision: 3,
};
const valid = { group, serverTime };
const unavailable = { group: null, serverTime: localNow.toISOString() };

test('group response preserves the original non-QR image and uses upstream time despite local clock skew', async () => {
  let calls = 0;
  const result = await getWechatGroup({
    cachePath: null,
    now: () => localNow,
    request: async (path, options) => {
      calls++;
      assert.equal(path, '/wechat-group');
      assert.ok(options?.signal instanceof AbortSignal);
      return { ...valid, privateField: 'ignored', group: { ...group, privateField: 'ignored' } };
    },
    timeoutSignal: milliseconds => {
      assert.equal(milliseconds, 5000);
      return new AbortController().signal;
    },
  });
  assert.equal(calls, 1);
  assert.deepEqual(result, valid);
  assert.equal(result.group?.qrContent, group.qrContent);
  assert.deepEqual(parseWechatGroupResult({ group: null, serverTime }, localNow), { group: null, serverTime });
});

test('group validity ends exactly at the server expiry boundary, including timezone offsets', () => {
  for (const expiresAt of [serverTime, '2026-10-23T12:00:00.000+08:00', '2026-10-23T03:59:59.999Z']) {
    assert.deepEqual(parseWechatGroupResult({ ...valid, group: { ...group, expiresAt } }, localNow), unavailable);
  }
  const future = { ...group, expiresAt: '2026-10-23T04:00:00.001Z' };
  assert.deepEqual(parseWechatGroupResult({ group: future, serverTime }, localNow), { group: future, serverTime });
});

test('malformed group payloads and impossible dates silently become unavailable', () => {
  for (const value of [null, undefined, [], {}, { group }, { ...valid, serverTime: 'bad' }, { ...valid, serverTime: '2026-02-30T00:00:00Z' }, { ...valid, group: [] }]) {
    assert.deepEqual(parseWechatGroupResult(value, localNow), unavailable);
  }
  for (const patch of [
    { id: 0 }, { id: '7' }, { id: Number.MAX_SAFE_INTEGER + 1 }, { revision: 0 }, { revision: 1.5 },
    { name: '' }, { name: '  ' }, { name: '字'.repeat(121) }, { description: null }, { description: '字'.repeat(1001) },
    { expiresAt: null }, { expiresAt: '2027-02-30T00:00:00Z' }, { expiresAt: '2026-13-01T00:00:00Z' },
    { expiresAt: '2026-10-29T24:00:00Z' }, { expiresAt: '2026-10-29T04:00:00+25:00' },
    { expiresAt: '2026-10-29' }, { expiresAt: '2026-10-29T04:00:00' }, { expiresAt: 'Infinity' },
  ]) assert.deepEqual(parseWechatGroupResult({ ...valid, group: { ...group, ...patch } }, localNow), unavailable);
});

test('image validation accepts raster data URLs without inspecting their QR content', () => {
  for (const content of [group.qrContent, 'data:image/jpeg;base64,/9j/2Q==', 'data:image/webp;base64,UklGRg==']) {
    assert.equal(isWechatGroupQrContent(content), true);
    assert.equal(parseWechatGroupResult({ ...valid, group: { ...group, qrContent: content } }, localNow).group?.qrContent, content);
  }
});

test('image validation rejects old URL records, SVG, unsupported MIME and malformed base64', () => {
  for (const qrContent of [
    '', null, 'javascript:alert(1)', 'https://weixin.qq.com/g/test', 'https://u.wechat.com/test',
    'data:image/svg+xml;base64,PHN2Zz4=', 'data:image/gif;base64,R0lGODlh', 'data:text/html;base64,dGVzdA==',
    'data:image/png,plain', 'data:image/png;base64,', 'data:image/png;base64,a',
    'data:image/png;base64,AAAA====', 'data:image/png;base64,AA A', 'data:image/png;base64,AA-A',
    'data:image/png;base64,====', 'data:image/png;base64,AAAA\n',
  ]) {
    assert.equal(isWechatGroupQrContent(qrContent), false);
    assert.deepEqual(parseWechatGroupResult({ ...valid, group: { ...group, qrContent } }, localNow), unavailable);
  }
});

test('image validation permits 5 MiB and rejects one byte above the limit', () => {
  const maxBytes = 5 * 1024 * 1024;
  const permitted = `data:image/png;base64,${Buffer.alloc(maxBytes).toString('base64')}`;
  const oversized = `data:image/png;base64,${Buffer.alloc(maxBytes + 1).toString('base64')}`;
  assert.equal(isWechatGroupQrContent(permitted), true);
  assert.equal(isWechatGroupQrContent(oversized), false);
  assert.deepEqual(parseWechatGroupResult({ ...valid, group: { ...group, qrContent: oversized } }, localNow), unavailable);
});

test('network errors, HTTP failures and invalid remote envelopes never escape or log', async () => {
  const originalError = console.error, originalWarn = console.warn;
  const logs: unknown[] = [];
  console.error = (...args) => { logs.push(args); };
  console.warn = (...args) => { logs.push(args); };
  try {
    const responses = [
      ...[401, 403, 404, 429, 500, 503].map(status => () => Response.json({ success: false, message: 'SYNTHETIC_PRIVATE' }, { status })),
      () => Response.json({ success: false, data: valid }),
      () => new Response('invalid JSON'),
      () => Response.json({ success: true, data: { group: null } }),
    ];
    for (const response of responses) {
      const result = await getWechatGroup({
        cachePath: null,
        now: () => localNow,
        request: (path, options) => sendFeedbackRequest(path, options, { identity: () => 'synthetic', fetch: async () => response() }),
      });
      assert.deepEqual(result, unavailable);
    }
    assert.deepEqual(await getWechatGroup({ cachePath: null, now: () => localNow, request: async () => { throw new Error('SYNTHETIC_PRIVATE'); } }), unavailable);
    assert.deepEqual(logs, []);
  } finally {
    console.error = originalError;
    console.warn = originalWarn;
  }
});

test('short upstream timeout aborts and returns an empty result without exposing failure', async () => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await getWechatGroup({
      cachePath: null,
      now: () => localNow,
      timeoutSignal: milliseconds => {
        assert.equal(milliseconds, 5000);
        const controller = new AbortController();
        timer = setTimeout(() => controller.abort(new DOMException('SYNTHETIC_PRIVATE', 'TimeoutError')), 1);
        return controller.signal;
      },
      request: (_path, options) => new Promise((_resolve, reject) => {
        options!.signal!.addEventListener('abort', () => reject(options!.signal!.reason), { once: true });
      }),
    });
    assert.deepEqual(result, unavailable);
  } finally { clearTimeout(timer); }
  assert.deepEqual(await getWechatGroup({ cachePath: null, now: () => localNow, timeoutSignal: () => AbortSignal.abort(), request: async () => valid }), unavailable);
});

test('local route retains login guard and browser no-store, reuses installation identity and caches upstream image in app storage', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wechat-group-route-'));
  const env = { ...process.env }, originalFetch = globalThis.fetch;
  process.env.STORAGE_DIR = dir;
  process.env.DISABLE_JOB_RUNNER = 'true';
  let authenticated = false, fail = false;
  const calls: { url: string; headers: Headers }[] = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), headers: new Headers(options?.headers) });
    assert.equal(options?.method, 'GET');
    assert.equal(options?.redirect, 'error');
    assert.ok(options?.signal instanceof AbortSignal);
    return fail ? Response.json({ success: false }, { status: 503 }) : Response.json({ success: true, data: valid });
  };
  const app = new H3();
  app.use(event => { event.context.requestUser = { id: 'synthetic', authenticated }; });
  app.get('/api/wechat-group', handler);
  try {
    assert.equal((await app.request('http://localhost/api/wechat-group')).status, 401);
    assert.equal(calls.length, 0);
    authenticated = true;
    const identity = getFeedbackInstallation(getDatabase());
    const response = await app.request('http://localhost/api/wechat-group', { headers: { 'x-client-id': 'forged', 'x-version': 'forged', 'User-Agent': 'private', Authorization: 'Bearer private', Cookie: 'private=1' } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const first = await response.json();
    assert.equal(first.ok, true);
    assert.deepEqual(first.data.group, group);
    assert.ok(Date.parse(first.data.serverTime) >= Date.parse(serverTime));
    const config = getAppConfig();
    assert.equal(calls[0].url, 'https://gateway.lby.link/health/v1/wechat-group');
    assert.equal(calls[0].headers.get('x-client-id'), identity);
    assert.equal(calls[0].headers.get('x-version'), config.appVersion);
    assert.equal(calls[0].headers.get('user-agent'), feedbackUserAgent(config.appVersion, deploymentType(config.authMode)));
    assert.equal(calls[0].headers.get('authorization'), null);
    assert.equal(calls[0].headers.get('cookie'), null);
    fail = true;
    const fallback = await app.request('http://localhost/api/wechat-group');
    assert.equal(fallback.status, 200);
    assert.equal(fallback.headers.get('cache-control'), 'no-store');
    const result = await fallback.json();
    assert.equal(result.ok, true);
    assert.deepEqual(result.data.group, group);
    assert.equal(calls.length, 1);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'cache', 'wechat-group.json'), 'utf8')).result.group, group);
    assert.ok(Number.isFinite(Date.parse(result.data.serverTime)));
  } finally {
    globalThis.fetch = originalFetch;
    closeDatabaseForTests();
    process.env = env;
    rmSync(dir, { recursive: true, force: true });
  }
});
