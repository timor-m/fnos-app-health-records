import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { getAppConfig } from '../utils/runtime-config';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getDatabase, closeDatabaseForTests } from '../database/client';
import { feedbackNotificationsSchemaSql } from '../database/feedback-notifications';
import { getFeedbackInstallation } from '../services/feedback-installation.service';
import { recordFeedbackStates, syncFeedbackUpdates, listFeedbackNotifications, updateFeedbackNotification } from '../services/feedback-sync.service';
import { listAppNotifications, updateAppNotificationStatus } from '../services/records.service';
import { sendFeedbackRequest } from '../services/feedback-remote.service';
import type { RequestUser } from '../domain/request-user';

async function setup(run: (db: ReturnType<typeof getDatabase>, id: string, admins: RequestUser[]) => void | Promise<void>) {
  const env = { ...process.env }, dir = mkdtempSync(join(tmpdir(),'feedback-sync-'));
  process.env.STORAGE_DIR=dir;process.env.AUTH_MODE='local';process.env.DISABLE_JOB_RUNNER='true';delete process.env.TRIM_SYS_MACHINE_ID;
  try {
    const db=getDatabase();
    const admins=['admin-a','admin-b'].map(id => ({id,displayName:'Synthetic',provider:'local',authenticated:true,isAdmin:true,isGatewayAdmin:true}) as RequestUser);
    for (const user of admins) db.prepare('INSERT INTO users(id,display_name,is_gateway_admin) VALUES (?,?,1)').run(user.id,user.displayName);
    await run(db,getFeedbackInstallation(db),admins);
  } finally { closeDatabaseForTests();process.env=env;rmSync(dir,{recursive:true,force:true}); }
}
const state=(status='received',version=1,number='B0001')=>({number,status,version});

test('first sync establishes baseline; replies, repeated and stale snapshots do not notify',()=>setup((db,id,admins)=>{
  recordFeedbackStates(db,id,[state()]);assert.equal(listFeedbackNotifications(admins[0],db).length,0);
  recordFeedbackStates(db,id,[state('received',2)]);assert.equal(listFeedbackNotifications(admins[0],db).length,0);
  recordFeedbackStates(db,id,[state('in_progress',3)]);
  recordFeedbackStates(db,id,[state('in_progress',3),state('received',1),state('closed',2)]);
  assert.equal(listFeedbackNotifications(admins[0],db).length,1);
  assert.equal(db.prepare('SELECT status,remote_version FROM feedback_sync_state').get()?.status,'in_progress');
  recordFeedbackStates(db,id,[state('received',4)]);assert.equal(listFeedbackNotifications(admins[0],db).length,2);
}));
test('only administrators can view and manage application notifications; read positions are per administrator',()=>setup((db,id,admins)=>{
  recordFeedbackStates(db,id,[state()]);recordFeedbackStates(db,id,[state('confirmed',2)]);
  const regular={...admins[0],isAdmin:false};
  assert.deepEqual(listFeedbackNotifications(regular,db),[]);assert.deepEqual(listAppNotifications(regular),[]);
  const notice=listAppNotifications(admins[0])[0];assert.equal(notice.memberId,null);assert.equal(notice.feedbackNumber,'B0001');
  assert.throws(()=>updateAppNotificationStatus(regular,String(notice.id),'read'),(e:any)=>e.status===403);
  updateAppNotificationStatus(admins[0],String(notice.id),'read');
  assert.equal(listFeedbackNotifications(admins[0],db)[0].status,'read');assert.equal(listFeedbackNotifications(admins[1],db)[0].status,'unread');
  updateFeedbackNotification(admins[0],String(notice.id),'archived',db);assert.equal(listAppNotifications(admins[0]).length,0);assert.equal(listAppNotifications(admins[1]).length,1);
  recordFeedbackStates(db,id,[state('confirmed',2)]);assert.equal(listAppNotifications(admins[0]).length,0);
}));
test('snapshot and notification roll back together on storage failure',()=>setup((db,id,admins)=>{
  recordFeedbackStates(db,id,[state()]);
  db.exec("CREATE TRIGGER reject_feedback_notice BEFORE INSERT ON feedback_notifications BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");
  assert.throws(()=>recordFeedbackStates(db,id,[state('confirmed',2)]));assert.equal(db.prepare('SELECT remote_version FROM feedback_sync_state').get()?.remote_version,1);
  db.exec('DROP TRIGGER reject_feedback_notice');recordFeedbackStates(db,id,[state('confirmed',2)]);assert.equal(listFeedbackNotifications(admins[0],db).length,1);
}));
test('own submission and resolution establish state without notifying; other installations stay isolated',()=>setup((db,id,admins)=>{
  recordFeedbackStates(db,id,[state()],false);recordFeedbackStates(db,id,[state('resolved',2)],false);
  assert.equal(listFeedbackNotifications(admins[0],db).length,0);
  recordFeedbackStates(db,'b'.repeat(43),[state()]);recordFeedbackStates(db,'b'.repeat(43),[state('closed',2)]);
  assert.equal(listFeedbackNotifications(admins[0],db).length,0);
  const foreign=db.prepare('SELECT id FROM feedback_notifications').get()!;
  assert.throws(()=>updateFeedbackNotification(admins[0],String(foreign.id),'read',db),(e:any)=>e.status===404);
}));
test('full pagination sees changed older feedback and concurrent callers share one sync',()=>setup(async(db,id,admins)=>{
  const items=Array.from({length:51},(_,i)=>state('received',1,`B${String(i+1).padStart(4,'0')}`));
  recordFeedbackStates(db,id,items);items[50]=state('confirmed',2,'B0051');
  let calls=0;
  const send:typeof sendFeedbackRequest=async path=>{calls++;await Promise.resolve();return {items:path.includes('page=1&')?items.slice(0,50):items.slice(50),total:51};};
  const a=syncFeedbackUpdates(db,send),b=syncFeedbackUpdates(db,send);assert.equal(a,b);
  assert.equal((await a).items.length,51);assert.equal(calls,2);assert.equal(listFeedbackNotifications(admins[0],db)[0].feedbackNumber,'B0051');
}));
test('failed or malformed later pages never commit a partial state or notify',()=>setup(async(db,id,admins)=>{
  recordFeedbackStates(db,id,[state()]);
  const send:typeof sendFeedbackRequest=async path=>{if(!path.includes('page=1&')) throw new Error('synthetic outage');return {items:[state('confirmed',2)],total:2};};
  await assert.rejects(syncFeedbackUpdates(db,send));assert.equal(listFeedbackNotifications(admins[0],db).length,0);
  assert.equal(db.prepare('SELECT status FROM feedback_sync_state').get()?.status,'received');
  await assert.rejects(syncFeedbackUpdates(db,async()=>({items:[state('unknown',3)],total:1})));
  assert.equal(db.prepare('SELECT status FROM feedback_sync_state').get()?.status,'received');
}));
test('identity changes while syncing discard results and notification tables survive repeat initialization',()=>setup(async(db,id,admins)=>{
  recordFeedbackStates(db,id,[state()]);
  const send:typeof sendFeedbackRequest=async()=>{db.prepare("UPDATE app_settings SET value_json=? WHERE setting_key='x-client-id'").run(JSON.stringify('b'.repeat(43)));return {items:[state('closed',2)],total:1};};
  await assert.rejects(syncFeedbackUpdates(db,send));assert.equal(listFeedbackNotifications(admins[0],db).length,0);
  db.exec(feedbackNotificationsSchemaSql);assert.equal(db.prepare('SELECT status FROM feedback_sync_state').get()?.status,'received');
}));
test('database reopen preserves status, notifications and independent read positions',()=>setup((db,id,admins)=>{
  recordFeedbackStates(db,id,[state()]);recordFeedbackStates(db,id,[state('confirmed',2)]);
  updateFeedbackNotification(admins[0],String(listFeedbackNotifications(admins[0],db)[0].id),'archived',db);
  closeDatabaseForTests();const reopened=getDatabase();recordFeedbackStates(reopened,id,[state('confirmed',2)]);
  assert.equal(listFeedbackNotifications(admins[0],reopened).length,0);assert.equal(listFeedbackNotifications(admins[1],reopened).length,1);
}));

test('old database gains draft tables after backup without losing report notification structure or schema version',()=>setup((db,id,admins)=>{
 const backups=join(getAppConfig().storageDir,'backups','db');
 const existingBackups=new Set(existsSync(backups) ? readdirSync(backups) : []);
 const before=db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()?.version;
 const definition=db.prepare("SELECT sql FROM sqlite_master WHERE name='app_notifications'").get()?.sql;
 db.exec('DROP TABLE feedback_notification_reads; DROP TABLE feedback_notifications; DROP TABLE feedback_sync_state');
 closeDatabaseForTests();const updated=getDatabase();
 assert.ok(readdirSync(backups).some(name=>!existingBackups.has(name)));
 assert.equal(updated.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()?.version,before);
 assert.equal(updated.prepare("SELECT sql FROM sqlite_master WHERE name='app_notifications'").get()?.sql,definition);
 recordFeedbackStates(updated,id,[state()]);assert.equal(listFeedbackNotifications(admins[0],updated).length,0);
}));

test('original 0.2.11 v18 upgrades to v19 with backup and retains original migration checksum',()=>setup((db,id)=>{
 const v18=db.prepare('SELECT * FROM schema_migrations WHERE version=18').get();
 db.exec('DROP TABLE feedback_notification_reads; DROP TABLE feedback_notifications; DROP TABLE feedback_sync_state; DELETE FROM schema_migrations WHERE version=19');
 closeDatabaseForTests();const upgraded=getDatabase();
 assert.equal(upgraded.prepare('SELECT MAX(version) AS v FROM schema_migrations').get()?.v,19);
 assert.deepEqual(upgraded.prepare('SELECT * FROM schema_migrations WHERE version=18').get(),v18);
 assert.ok(readdirSync(join(getAppConfig().storageDir,'backups','db')).some(name=>name.includes('v18-to-v19')));
 assert.equal(getFeedbackInstallation(upgraded),id);
 recordFeedbackStates(upgraded,id,[state()]);
}));
test('installed v18 feedback draft upgrades to v19 without losing notifications or read positions',()=>setup((db,id,admins)=>{
 recordFeedbackStates(db,id,[state()]);recordFeedbackStates(db,id,[state('confirmed',2)]);
 const notice=listFeedbackNotifications(admins[0],db)[0];updateFeedbackNotification(admins[0],String(notice.id),'archived',db);
 const v18=db.prepare('SELECT * FROM schema_migrations WHERE version=18').get();
 db.exec('DELETE FROM schema_migrations WHERE version=19');closeDatabaseForTests();const upgraded=getDatabase();
 assert.equal(upgraded.prepare('SELECT MAX(version) AS v FROM schema_migrations').get()?.v,19);
 assert.deepEqual(upgraded.prepare('SELECT * FROM schema_migrations WHERE version=18').get(),v18);
 assert.equal(listFeedbackNotifications(admins[0],upgraded).length,0);assert.equal(listFeedbackNotifications(admins[1],upgraded).length,1);
 recordFeedbackStates(upgraded,id,[state('confirmed',2)]);assert.equal(listFeedbackNotifications(admins[1],upgraded).length,1);
}));
