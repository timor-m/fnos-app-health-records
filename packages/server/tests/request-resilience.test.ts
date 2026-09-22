import {createMember} from "../services/member.service";
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { H3, type H3Event } from 'h3';
import { closeDatabaseForTests, getDatabase } from '../database/client';
import { getRequestUser } from '../utils/request-user';
import { bootstrapLocalAdministrator } from '../services/auth.service';
import { listReports, listAuditLogs, listUserOperationAuditLogs, getAiAuditSummary } from '../services/records.service';
import { getAiSettings, saveAiSettings } from '../services/ai-settings.service';
import { createUpload, createUploadFromStagedFiles } from '../services/upload.service';
import notifications from '../routes/api/notifications/[id].put';
import reminders from '../routes/api/reminders/[id].put';
import errorHandler from '../error-handler';
import { toApiErrorPayload } from '../utils/api-error';
import { writeFileSync } from 'node:fs';

function gateway(admin = true, name = '测试账号') {
  return { context: {}, node: { req: { healthAccessMode: 'gateway', headers: {
    'x-trim-userid': 'test-user', 'x-trim-username': name, 'x-trim-isadmin': String(admin)
  } } } } as unknown as H3Event;
}
async function withStorage(run: (dir: string) => unknown) {
  const dir = mkdtempSync(join(tmpdir(), 'request-resilience-'));
  process.env.STORAGE_DIR = dir;
  process.env.AUTH_MODE = 'fnos';
  try { await run(dir); }
  finally { closeDatabaseForTests(); delete process.env.STORAGE_DIR; delete process.env.AUTH_MODE; rmSync(dir, { recursive: true, force: true }); }
}

test('unchanged gateway identity works on a read-only database; new requests refresh roles and names', () => withStorage(() => {
  const first = gateway();
  const user = getRequestUser(first);
  const db = getDatabase();
  db.exec('PRAGMA query_only=ON');
  assert.equal(getRequestUser(first), user);
  assert.equal(getRequestUser(gateway()).id, user.id);
  assert.throws(() => getRequestUser(gateway(false)), e => toApiErrorPayload(e).status === 503);
  db.exec('PRAGMA query_only=OFF');
  const changed = getRequestUser(gateway(false, '更新账号'));
  assert.equal(changed.isAdmin, false);
  assert.equal((db.prepare('SELECT is_gateway_admin AS admin FROM users WHERE id=?').get(user.id) as {admin:number}).admin, 0);
  assert.equal(db.prepare("SELECT count(*) AS n FROM health_members").get()!.n,0);
}));

test('local session last-seen failures do not block reads; revocation and expiry still take effect', () => withStorage(() => {
  process.env.AUTH_MODE = 'local';
  bootstrapLocalAdministrator();
  const db = getDatabase();
  const {id} = db.prepare('SELECT id FROM users').get() as {id:string};
  const hash = createHash('sha256').update('test-session').digest('hex');
  db.prepare("INSERT INTO auth_sessions (id,user_id,token_hash,expires_at,last_seen_at) VALUES ('session',?,?,datetime('now','+1 day'),datetime('now','-1 hour'))").run(id,hash);
  const event = () => ({ context: {}, node: {req:{headers:{cookie:'health_session=test-session'}}} } as unknown as H3Event);
  db.exec('PRAGMA query_only=ON');
  assert.equal(getRequestUser(event()).id,id);
  db.exec('PRAGMA query_only=OFF');
  assert.equal(getRequestUser(event()).id,id);
  assert.equal((db.prepare("SELECT last_seen_at > datetime('now','-5 minutes') AS recent FROM auth_sessions").get() as {recent:number}).recent,1);
  db.exec('UPDATE users SET is_gateway_admin=0');
  assert.equal(getRequestUser(event()).isAdmin,false);
  db.exec("UPDATE auth_sessions SET revoked_at=CURRENT_TIMESTAMP");
  assert.equal(getRequestUser(event()).authenticated,false);
  db.exec("UPDATE auth_sessions SET revoked_at=NULL,expires_at=datetime('now','-1 day')");
  assert.equal(getRequestUser(event()).authenticated,false);
  db.exec("UPDATE auth_sessions SET expires_at=datetime('now','+1 day'); UPDATE local_accounts SET disabled_at=CURRENT_TIMESTAMP");
  assert.equal(getRequestUser(event()).authenticated,false);
}));

test('invalid list limits and AI profiles return 400 and preserve saved settings', () => withStorage(() => {
  const user=getRequestUser(gateway());
  for (const limit of [NaN, Infinity, -Infinity]) for (const list of [listReports,listAuditLogs,listUserOperationAuditLogs,getAiAuditSummary]) {
    assert.throws(() => list(user,limit), e => toApiErrorPayload(e).status === 400);
  }
  const before=getAiSettings();
  for(const input of [null,[], 'x',{profiles:[null]},{profiles:[3]},{profiles:[{provider:"__proto__"}]},{profiles:{}},{taskBindings:[]}]) {
    assert.throws(() => saveAiSettings(input as never), e => toApiErrorPayload(e).status === 400);
  }
  assert.deepEqual(getAiSettings(),before);
  assert.ok(Array.isArray(listReports(user,2).items));
}));

test('notification and reminder reject null or non-object request bodies', async () => {
  for(const handler of [notifications,reminders]) for(const body of ['null','[]','"x"']) {
    const app=new H3({onError:errorHandler}); app.put('/api/items/:id',handler);
    const response=await app.request('http://localhost/api/items/test', {method:'PUT',headers:{'content-type':'application/json'},body});
    assert.equal(response.status,400);
  }
});

test('upload receipts can be retried without writing report storage, while verifying content and permissions', () => withStorage(dir => {
  const user=getRequestUser(gateway()); const db=getDatabase();
  const {id:memberId}=createMember(user,{displayName:'合成测试',createSelf:true});
  const file={originalName:'test.pdf',data:Buffer.from('%PDF-1.4\n%%EOF')};
  const key='request-retry-0001'; const first=createUpload(user,memberId,[file],key);
  const path=join(dir,'source.pdf'); writeFileSync(path,file.data);
  const memberDir=join(dir,'reports',memberId); chmodSync(memberDir,0o500);
  db.exec('PRAGMA query_only=ON');
  try {
    assert.deepEqual(createUpload(user,memberId,[file],key),first);
    assert.deepEqual(createUploadFromStagedFiles(user,memberId,[{originalName:file.originalName,sourcePath:path}],key),first);
    assert.throws(() => createUpload(user,memberId,[{...file,data:Buffer.from('%PDF-1.4\nchanged')}],key), e => toApiErrorPayload(e).status===409);
    writeFileSync(path,Buffer.from('%PDF-1.4\nchanged'));
    assert.throws(() => createUploadFromStagedFiles(user,memberId,[{originalName:file.originalName,sourcePath:path}],key), e => toApiErrorPayload(e).status===409);
  } finally { chmodSync(memberDir,0o700); db.exec('PRAGMA query_only=OFF'); }
  db.prepare("UPDATE member_permissions SET permission='viewer',can_manage_sharing=0 WHERE user_id=?").run(user.id);
  assert.throws(() => createUpload({...user,isAdmin:false,isGatewayAdmin:false},memberId,[file],key), e => toApiErrorPayload(e).status===403);
  db.prepare("UPDATE member_permissions SET permission='manager' WHERE user_id=?").run(user.id);
  db.prepare('UPDATE upload_receipts SET report_id=NULL').run();
  assert.throws(() => createUpload(user,memberId,[file],key), e => toApiErrorPayload(e).status===409);
  assert.equal((db.prepare('SELECT count(*) AS count FROM reports').get() as {count:number}).count,1);
}));
