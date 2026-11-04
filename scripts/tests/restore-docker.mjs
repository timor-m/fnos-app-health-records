#!/usr/bin/env node
// Opt-in integration test. Uses only synthetic data, a temporary image/container and tmpfs storage.
// Prerequisite: GATEWAY_PREFIX=/ npm run build && npm run prepare:package; Docker must be running.
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, cpSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

const baseImage = process.argv[2];
if (!baseImage || !/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]*$/.test(baseImage)) throw new Error('Usage: node scripts/tests/restore-docker.mjs <local-node-runtime-image>');
const root = resolve(import.meta.dirname, '../..');
const launcher = join(root, '.fnos-build/package/app/server/serve.mjs');
if (!existsSync(launcher)) throw new Error('Run GATEWAY_PREFIX=/ npm run build && npm run prepare:package first');
const version=JSON.parse(readFileSync(join(root,'package.json'),'utf8')).version;
const temporary = mkdtempSync(join(tmpdir(), 'health-restore-container-'));
const image = `health-restore-smoke:${process.pid}`;
const name = `health-restore-smoke-${process.pid}`;
const socket = join(temporary, 'gateway.sock');
const docker = args => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
let source;
let sourceLog = '';
let containerStarted = false;
let imageBuilt = false;

async function gateway(path, init = {}, uid = '1000') {
  const request = new Request(`http://localhost/api/${path}`, init);
  const bytes = init.body ? Buffer.from(await request.arrayBuffer()) : undefined;
  const headers = Object.fromEntries(request.headers);
  Object.assign(headers, { 'x-trim-userid': uid, 'x-trim-username': 'synthetic', 'x-trim-isadmin': 'true' });
  if (bytes) headers['content-length'] = String(bytes.length);
  return new Promise((resolveResponse, reject) => {
    const req = httpRequest({ socketPath: socket, path: `/api/${path}`, method: request.method, headers }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolveResponse(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: res.headers })));
    });
    req.setTimeout(5000,()=>req.destroy(new Error('Gateway request timeout')));
    req.on('error', reject); req.end(bytes);
  });
}
const jsonBody = value => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
async function data(response) {
  const body = await response.json();
  assert.equal(response.ok, true, `HTTP ${response.status}: ${JSON.stringify(body)}`);
  assert.equal(body.ok, true); return body.data;
}
async function waitFor(probe) {
  for (let attempt = 0; attempt < 60; attempt++) {
    try { if (await probe()) return; } catch { /* startup */ }
    await delay(500);
  }
  throw new Error('Test service did not become ready');
}
try {
  docker(['info', '--format', '{{.ServerVersion}}']);
  docker(['image','inspect',baseImage]);
  console.log('Starting packaged fnOS gateway adapter with synthetic accounts');
  source = spawn(process.execPath, [launcher], { cwd: root, env: { ...process.env, COPYFILE_DISABLE: '1', NODE_ENV: 'production', AUTH_MODE: 'fnos', FNOS_SOCKET_PATH: socket, STORAGE_DIR: join(temporary, 'source'), GATEWAY_PREFIX: '/', DISABLE_JOB_RUNNER: 'true' }, stdio: ['ignore', 'pipe', 'pipe'] });
  source.stdout.on('data', chunk => { sourceLog += chunk; }); source.stderr.on('data', chunk => { sourceLog += chunk; });
  await waitFor(async () => (await gateway('session')).ok);
  const first = await data(await gateway('members', jsonBody({ displayName: 'synthetic-one', createSelf: true })));
  const second = await data(await gateway('members', jsonBody({ displayName: 'synthetic-two', createSelf: true }), '1001'));
  const upload = new FormData(); upload.set('memberId', first.id); upload.append('files', new Blob(['%PDF-1.4\n%%EOF'], { type: 'application/pdf' }), 'synthetic.pdf');
  const report = await data(await gateway('uploads', { method: 'POST', body: upload }));
  const backup = await data(await gateway('backups', { method: 'POST' }));
  const download = await gateway(`backups/${backup.id}/download`); assert.equal(download.ok, true);
  const archive = new Blob([await download.arrayBuffer()], { type: 'application/gzip' });

  console.log('Building isolated runtime image from current compiled application');
  const context = join(temporary, 'image'); mkdirSync(context);
  cpSync(join(root, '.server-dist'), join(context, '.server-dist'), { recursive: true });
  mkdirSync(join(context, 'scripts'));
  cpSync(join(root, 'scripts/start.mjs'), join(context, 'scripts/start.mjs'));
  for (const file of ['package.json', 'template.config.json']) cpSync(join(root, file), join(context, file));
  writeFileSync(join(context, 'Dockerfile'), `FROM ${baseImage}\nWORKDIR /app\nCOPY --chown=1000:1000 . /app/\nUSER 1000:1000\nENTRYPOINT []\nCMD ["node","scripts/start.mjs"]\n`);
  docker(['build', '-t', image, context]); imageBuilt = true;
  docker(['run', '-d', '--name', name, '--tmpfs', '/data:uid=1000,gid=1000,mode=0700', '-p', '127.0.0.1::3334', '-e', `APP_VERSION=${version}`, '-e', 'AUTH_MODE=local', '-e', 'NODE_ENV=production', '-e', 'GATEWAY_PREFIX=/', '-e', 'STORAGE_DIR=/data', '-e', 'HOST=0.0.0.0', '-e', 'PORT=3334', '-e', 'DISABLE_JOB_RUNNER=true', image]); containerStarted = true;
  const address = docker(['port', name, '3334/tcp']);
  const origin = `http://${address}`;
  await waitFor(async () => (await fetch(`${origin}/healthz`,{signal:AbortSignal.timeout(5000)})).ok);
  function client() {
    let cookie = '';
    return async (path, init = {}) => {
      const response = await fetch(`${origin}/api/${path}`, { ...init, signal:AbortSignal.timeout(60000), headers: { ...init.headers, ...(cookie ? { cookie } : {}) } });
      const setCookie = response.headers.get('set-cookie'); if (setCookie) cookie = setCookie.split(';')[0];
      return response;
    };
  }
  const admin = client();
  await data(await admin('auth/login', jsonBody({ username: 'admin', password: 'admin' })));
  const password = 'Synthetic-only-password-2026';
  await data(await admin('auth/password', { ...jsonBody({ currentPassword: 'admin', newPassword: password, confirmPassword: password }), method: 'PUT' }));
  await data(await admin('auth/login',jsonBody({username:'admin',password})));
  const form = token => { const body = new FormData(); body.append('backup', archive, 'synthetic.tar.gz'); if (token) body.append('token', token); return body; };
  console.log('Restoring through multipart HTTP API and re-authenticating');
  const plan = await data(await admin('backups/restore-upload', { method: 'POST', body: form() }));
  assert.equal(plan.sourceMode, 'fnos'); assert.equal(plan.accessPolicy, 'admin_takeover'); assert.equal(plan.memberCount, 2);
  const restored = await data(await admin('backups/restore-upload', { method: 'POST', body: form(plan.token) }));
  assert.equal(restored.identityRebind.memberPermissionCount, 2);
  assert.equal((await data(await admin('session'))).authenticated, false);
  await data(await admin('auth/login', jsonBody({ username: 'admin', password })));
  assert.deepEqual((await data(await admin('members'))).map(member => member.id).sort(), [first.id, second.id].sort());
  assert.equal((await data(await admin(`reports/${report.reportId}`))).id, report.reportId);
  const original=await admin(`reports/${report.reportId}/pages/${report.pages[0].id}/original`);
  assert.equal(original.ok,true);assert.equal(await original.text(),'%PDF-1.4\n%%EOF');
  const local = await data(await admin('auth/accounts', jsonBody({ username: 'synthetic-member', displayName: 'synthetic-member' })));
  const ordinary = client();
  await data(await ordinary('auth/login', jsonBody({ username: 'synthetic-member', password: 'admin' })));
  await data(await ordinary('auth/password', { ...jsonBody({ currentPassword: 'admin', newPassword: password, confirmPassword: password }), method: 'PUT' }));
  await data(await ordinary('auth/login',jsonBody({username:'synthetic-member',password})));
  assert.equal((await data(await ordinary('members'))).length, 0);
  const permissions = await data(await admin(`members/${first.id}/permissions`));
  const permissionVersion = permissions[0].version;
  await data(await admin(`members/${first.id}/permissions`, { ...jsonBody({ userId: local.userId, permission: 'viewer', version:permissionVersion }), method: 'PUT' }));
  assert.deepEqual((await data(await ordinary('members'))).map(member => member.id), [first.id]);
  assert.equal((await ordinary('backups/takeover-repair')).status, 403);
  assert.equal((await data(await admin('backups/takeover-repair'))).available, false);
  console.log('PASS: packaged gateway backup → Docker restore → login → member/report access → restricted sharing');
} catch (error) {
  console.error(error);
  if (sourceLog) console.error(sourceLog);
  if (containerStarted) { try { console.error(docker(['logs', name])); } catch { /* cleanup below */ } }
  process.exitCode = 1;
} finally {
  if (source && source.exitCode === null) {
    source.kill('SIGTERM');
    await Promise.race([new Promise(resolveExit => source.once('exit', resolveExit)), delay(4000)]);
    if (source.exitCode === null) source.kill('SIGKILL');
  }
  if (containerStarted) docker(['rm', '-f', name]);
  if (imageBuilt) docker(['image', 'rm', image]);
  rmSync(temporary, { recursive: true, force: true });
}
