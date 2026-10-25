import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { getWechatGroup } from '../services/wechat-group.service';

const hour = 60 * 60 * 1000;
const serverTime = '2026-10-23T04:00:00.000Z';
const group = {
  id: 1, name: '合成交流群', description: '合成说明', revision: 1,
  qrContent: 'data:image/png;base64,AAAA',
  expiresAt: '2026-10-23T06:00:00.000Z',
};
const valid = { group, serverTime };

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'wechat-cache-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  // The application clock intentionally differs from the gateway clock.
  let time = Date.parse('2027-10-23T04:00:00.000Z');
  const cachePath = join(directory, 'wechat-group.json');
  return {
    directory, cachePath, now: () => new Date(time), advance: (milliseconds: number) => { time += milliseconds; },
    read: () => JSON.parse(readFileSync(cachePath, 'utf8')),
  };
}

function restartedResult(f: ReturnType<typeof fixture>) {
  const script = `
    import { getWechatGroup } from './packages/server/services/wechat-group.service.ts';
    const result = await getWechatGroup({
      cachePath: ${JSON.stringify(f.cachePath)},
      now: () => new Date(${JSON.stringify(f.now().toISOString())}),
      request: async () => { process.exitCode = 1; throw new Error('Unexpected remote request after restart'); }
    });
    process.stdout.write(JSON.stringify(result));
  `;
  return JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { encoding: 'utf8', stdio: 'pipe' }));
}

test('valid image persists across application restart without renewing its expiry', async t => {
  const f = fixture(t);
  let calls = 0;
  const request = async () => { calls++; return valid; };
  assert.deepEqual(await getWechatGroup({ ...f, request }), valid);
  f.advance(hour);
  const advanced = { group, serverTime: '2026-10-23T05:00:00.000Z' };
  assert.deepEqual(await getWechatGroup({ ...f, request }), advanced);
  assert.equal(calls, 1);
  assert.deepEqual(restartedResult(f), advanced);
  assert.deepEqual(f.read().result, valid);
});

test('expired images stay on disk, disappear from responses and are checked at most once an hour', async t => {
  const f = fixture(t);
  let calls = 0;
  const request = async () => { calls++; return valid; };
  await getWechatGroup({ ...f, request });
  f.advance(2 * hour);
  const expired = { group, serverTime: group.expiresAt };
  const check = async () => { calls++; return expired; };
  assert.equal((await getWechatGroup({ ...f, request: check })).group, null);
  assert.equal(calls, 2);
  assert.equal(restartedResult(f).group, null);
  assert.deepEqual(f.read().result, expired);
  f.advance(hour - 1);
  assert.equal((await getWechatGroup({ ...f, request: check })).group, null);
  assert.equal(calls, 2);
  f.advance(1);
  await getWechatGroup({ ...f, request: check });
  assert.equal(calls, 3);
});

test('new image atomically replaces all old metadata and image bytes without leaving extra files', async t => {
  const f = fixture(t);
  await getWechatGroup({ ...f, request: async () => valid });
  f.advance(2 * hour);
  const replacement = {
    group: { id: 2, name: '下一批测试群', description: '下一批测试说明', revision: 2,
      qrContent: 'data:image/webp;base64,UklGRg==', expiresAt: '2026-10-25T06:00:00.000Z' },
    serverTime: group.expiresAt,
  };
  assert.deepEqual(await getWechatGroup({ ...f, request: async () => replacement }), replacement);
  assert.deepEqual(f.read().result, replacement);
  assert.deepEqual(readdirSync(f.directory), ['wechat-group.json']);
  const contents = readFileSync(f.cachePath, 'utf8');
  assert.ok(!contents.includes(group.qrContent));
  assert.ok(!contents.includes(group.name));
  f.advance(hour);
  assert.deepEqual((await getWechatGroup({ ...f, request: async () => { throw new Error('Unexpected refresh'); } })).group, replacement.group);
});

test('empty and failed responses persist a retry deadline, including after restart', async t => {
  for (const response of ['empty', 'failure', 'invalid'] as const) {
    await t.test(response, async t => {
      const f = fixture(t);
      let calls = 0;
      const request = async () => {
        calls++;
        if (response === 'failure') throw new Error('Synthetic failure');
        return response === 'empty' ? { group: null, serverTime } : { invalid: true };
      };
      assert.equal((await getWechatGroup({ ...f, request })).group, null);
      assert.equal(f.read().result.group, null);
      assert.equal(f.read().nextCheckAt, f.now().getTime() + hour);
      f.advance(hour - 1);
      assert.equal((await getWechatGroup({ ...f, request })).group, null);
      assert.equal(calls, 1);
      assert.equal(restartedResult(f).group, null);
      f.advance(1);
      await getWechatGroup({ ...f, request });
      assert.equal(calls, 2);
    });
  }
});

test('gateway absence or failure retains the expired image and prevents repeated remote calls', async t => {
  for (const failure of [false, true]) {
    await t.test(failure ? 'request failure' : 'no group', async t => {
      const f = fixture(t);
      await getWechatGroup({ ...f, request: async () => valid });
      const original = f.read();
      f.advance(2 * hour);
      let calls = 0;
      const request = async () => {
        calls++;
        if (failure) throw new Error('Synthetic failure');
        return { group: null, serverTime: group.expiresAt };
      };
      assert.equal((await getWechatGroup({ ...f, request })).group, null);
      assert.deepEqual(f.read().result, original.result);
      assert.equal(f.read().requestedAt, original.requestedAt);
      f.advance(hour - 1);
      assert.equal((await getWechatGroup({ ...f, request })).group, null);
      assert.equal(calls, 1);
    });
  }
});

test('parallel page requests share one upstream request and release it before a subsequent refresh', async t => {
  const f = fixture(t);
  let calls = 0;
  const request = async () => { calls++; return valid; };
  const results = await Promise.all(Array.from({ length: 10 }, () => getWechatGroup({ ...f, request })));
  assert.equal(calls, 1);
  results.forEach(result => assert.deepEqual(result, valid));
  f.advance(2 * hour);
  await getWechatGroup({ ...f, request });
  assert.equal(calls, 2);
});

test('corrupt, oversized and clock-invalid cache files are replaced using validated upstream data', async t => {
  const f = fixture(t);
  await getWechatGroup({ ...f, request: async () => valid });
  const original = f.read();
  const damaged = [
    '{invalid', 'x'.repeat(8 * 1024 * 1024),
    JSON.stringify({ ...original, version: 2 }),
    JSON.stringify({ ...original, requestedAt: f.now().getTime() + 1 }),
    JSON.stringify({ ...original, nextCheckAt: -1 }),
    JSON.stringify({ ...original, result: { ...valid, group: { ...group, qrContent: 'https://invalid.test/image' } } }),
  ];
  for (const content of damaged) {
    writeFileSync(f.cachePath, content);
    let calls = 0;
    assert.deepEqual(await getWechatGroup({ ...f, request: async () => { calls++; return valid; } }), valid);
    assert.equal(calls, 1);
    assert.deepEqual(f.read().result, valid);
  }
});

test('network delay cannot extend a QR expiry and unavailable disk storage does not break the response', async t => {
  const f = fixture(t);
  const shortLived = { group: { ...group, expiresAt: '2026-10-23T04:00:01.000Z' }, serverTime };
  const result = await getWechatGroup({ ...f, request: async () => { f.advance(2000); return shortLived; } });
  assert.equal(result.group, null);
  assert.deepEqual(f.read().result, shortLived);
  assert.equal(f.read().nextCheckAt, f.now().getTime() + hour);
  assert.equal((await getWechatGroup({ ...f, request: async () => { throw new Error('Unexpected retry'); } })).group, null);
  // A regular file as the parent deterministically prevents writing a cache.
  assert.deepEqual(await getWechatGroup({ ...f, cachePath: join(f.cachePath, 'blocked.json'), request: async () => valid }), valid);
});
