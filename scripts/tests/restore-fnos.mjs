#!/usr/bin/env node
// Synthetic-only acceptance: two isolated packaged fnOS adapters, normal upload/backup/restore APIs.
// Prerequisite: GATEWAY_PREFIX=/ npm run build && npm run prepare:package
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve(import.meta.dirname, '../..');
const launcher = join(root, '.fnos-build/package/app/server/serve.mjs');
if (!existsSync(launcher)) throw new Error('Build with GATEWAY_PREFIX=/ and run prepare:package first');
const temporary = mkdtempSync('/tmp/health-nas-');
const children = [];
const keep = process.argv.includes('--keep');
async function start(name) {
  const socket = join(temporary, `${name}.sock`);
  const child = spawn(process.execPath, [launcher], { cwd: root, env: {
    ...process.env, NODE_ENV: 'production', AUTH_MODE: 'fnos', FNOS_SOCKET_PATH: socket,
    STORAGE_DIR: join(temporary, name), GATEWAY_PREFIX: '/',
    COPYFILE_DISABLE: '1', DISABLE_JOB_RUNNER: 'true',
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  let log = '';
  child.stdout.on('data', bytes => { log += bytes; }); child.stderr.on('data', bytes => { log += bytes; });
  const gateway = async (path, init = {}, uid = '1000', admin = true) => {
    const input = new Request(`http://localhost/api/${path}`, init);
    const bytes = init.body ? Buffer.from(await input.arrayBuffer()) : undefined;
    const headers = { ...Object.fromEntries(input.headers), 'x-trim-userid': uid, 'x-trim-username': 'synthetic', 'x-trim-isadmin': String(admin) };
    if (bytes) headers['content-length'] = String(bytes.length);
    return new Promise((resolveResponse, reject) => {
      const req = request({ socketPath: socket, path: `/api/${path}`, method: input.method, headers }, res => {
        const chunks = []; res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolveResponse(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: res.headers })));
      });
      req.setTimeout(10000, () => req.destroy(new Error('Synthetic gateway timeout')));
      req.on('error', reject); req.end(bytes);
    });
  };
  for (let i = 0; i < 60; i++) {
    if (child.exitCode !== null) throw new Error(`Synthetic ${name} exited: ${log}`);
    try { if ((await gateway('session')).ok) return gateway; } catch { /* startup */ }
    await delay(250);
  }
  throw new Error(`Synthetic ${name} was not ready: ${log}`);
}
async function data(response) {
  const body = await response.json();
  assert.equal(response.ok, true, `HTTP ${response.status}: ${JSON.stringify(body)}`);
  assert.equal(body.ok, true); return body.data;
}
const json = (value, method = 'POST') => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
try {
  const source = await start('source');
  const target = await start('target');
  const sourceSession = await data(await source('session'));
  const targetSession = await data(await target('session'));
  assert.notEqual(sourceSession.id, targetSession.id, 'equal gateway UIDs must remain deployment scoped');
  const first = await data(await source('members', json({ displayName: 'B0009 synthetic-one', createSelf: true })));
  const second = await data(await source('members', json({ displayName: 'B0009 synthetic-two', createSelf: true }), '1001'));
  const upload = new FormData(); upload.set('memberId', first.id);
  const original = '%PDF-1.4\n%%EOF';
  upload.append('files', new Blob([original], { type: 'application/pdf' }), 'synthetic.pdf');
  const report = await data(await source('uploads', { method: 'POST', body: upload }));
  const backup = await data(await source('backups', { method: 'POST' }));
  const download = await source(`backups/${backup.id}/download`); assert.equal(download.ok, true);
  const archive = Buffer.from(await download.arrayBuffer());
  writeFileSync(join(temporary, 'source-backup.tar.gz'), archive);
  const form = fields => {
    const body = new FormData(); body.append('backup', new Blob([archive]), 'synthetic.tar.gz');
    for (const [key, value] of Object.entries(fields || {})) body.append(key, value);
    return { method: 'POST', body };
  };
  const initial = await data(await target('backups/restore-upload', form()));
  assert.equal(initial.sourceMode, 'fnos'); assert.equal(initial.targetMode, 'fnos');
  assert.equal(initial.accessPolicy, 'isolate'); assert.equal(initial.canChooseTakeover, true);
  assert.equal((await target('backups/restore-upload', form({ takeover: 'true' }), '1001', false)).status, 403);
  const chosen = await data(await target('backups/restore-upload', form({ takeover: 'true' })));
  assert.notEqual(chosen.token, initial.token); assert.equal(chosen.accessPolicy, 'admin_takeover');
  const result = await data(await target('backups/restore-upload', form({ token: chosen.token })));
  assert.equal(result.identityRebind.memberPermissionCount, 2);
  const login = await data(await target('session'));
  assert.equal(login.id, result.identityRebind.userId);
  assert.deepEqual((await data(await target('members'))).map(member => member.id).sort(), [first.id, second.id].sort());
  assert.equal((await data(await target(`reports/${report.reportId}`))).id, report.reportId);
  const recovered = await target(`reports/${report.reportId}/pages/${report.pages[0].id}/original`);
  assert.equal(recovered.ok, true); assert.equal(await recovered.text(), original);
  assert.equal((await data(await target('members', {}, '1001', false))).length, 0);
  const other = await data(await target('session', {}, '1001', false));
  const grants = await data(await target(`members/${first.id}/permissions`));
  await data(await target(`members/${first.id}/permissions`, json({ userId: other.id, permission: 'viewer', version: grants[0].version }, 'PUT')));
  assert.deepEqual((await data(await target('members', {}, '1001', false))).map(member => member.id), [first.id]);
  assert.equal((await target('backups/restore-upload', form({ token: chosen.token }))).status, 409);
  writeFileSync(join(temporary, 'verification.json'), JSON.stringify({ ticket: 'B0009', synthetic: true, sourceMemberIds: [first.id, second.id], reportId: report.reportId, safetyBackupId: result.safetyBackupId, checked: ['isolation-default', 'explicit-preflight', 'administrator-only', 'gateway-reentry', 'original-file', 'restricted-sharing', 'single-use-token'] }, null, 2));
  console.log('PASS: NAS adapter backup → explicit NAS takeover → gateway reentry → original report → restricted sharing');
} finally {
  for (const child of children) if (child.exitCode === null) {
    child.kill('SIGTERM');
    await Promise.race([new Promise(resolveExit => child.once('exit', resolveExit)), delay(4000)]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  if (keep) console.log(`Synthetic verification data retained: ${temporary}`);
  else rmSync(temporary, { recursive: true, force: true });
}
