import {linkProcessRecords,recordProcesses,getRecordProcess} from '../services/health-record-process.service';
import { createVaccination,getVaccination } from '../services/vaccination.service';
import { createHealthEpisode } from '../services/health-episode.service';
import { validateHealthWorkflowDatabase } from '../services/health-workflow-integrity.service';
import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync,readdirSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {closeDatabaseForTests,getDatabase} from '../database/client';
import {listMergeCandidates,getMergeSelection,previewMemberMerge,executeMemberMerge,getMemberMerge} from '../services/member-merge.service';
import {assertMemberAccess} from '../services/member.service';
import type {RequestUser} from '../domain/request-user';
const admin:RequestUser={id:'merge-admin',displayName:'fixture',provider:'fnos_gateway',authenticated:true,isGatewayAdmin:true};
const ordinary:RequestUser={...admin,id:'owner',isGatewayAdmin:false};
const choices={display_name:'target',birth_date:'target',sex:'target',blood_type_abo:'target',blood_type_rh:'target'};
const input=()=>({sourceId:'source',targetId:'target',choices,grants:[{userId:'owner',permission:'manager',canManageSharing:true}]});
function fixture(run:(dir:string)=>void) {
 const dir=mkdtempSync(join(tmpdir(),'member-merge-'));const old=process.env.STORAGE_DIR;const mode=process.env.AUTH_MODE;process.env.STORAGE_DIR=dir;process.env.AUTH_MODE='fnos';
 try {const db=getDatabase();
 for(const id of ['merge-admin','owner','viewer']) {db.prepare('INSERT INTO users(id,display_name,is_gateway_admin) VALUES(?,?,?)').run(id,'fixture',Number(id===admin.id));db.prepare("INSERT INTO user_identities(id,user_id,provider,subject) VALUES(?,?,'fnos_gateway',?)").run(id,id,id);}
 db.exec(`INSERT INTO health_members(id,display_name,created_by) VALUES('source','fixture','owner'),('target','fixture','owner');
 INSERT INTO member_permissions(member_id,user_id,permission,can_manage_sharing,granted_by) VALUES('source','owner','manager',1,'owner'),('target','owner','manager',1,'owner'),('source','viewer','viewer',0,'owner');
 INSERT INTO account_preferences(user_id,self_member_id,default_member_id) VALUES('owner','source','source'),('viewer',NULL,'source');
 INSERT INTO reports(id,member_id,created_by,title,status,report_type) VALUES('report-source','source','owner','private fixture','ready','laboratory'),('report-target','target','owner','private fixture','ready','laboratory');`);
 run(dir);
 }finally{closeDatabaseForTests();if(old===undefined)delete process.env.STORAGE_DIR;else process.env.STORAGE_DIR=old;if(mode===undefined)delete process.env.AUTH_MODE;else process.env.AUTH_MODE=mode;rmSync(dir,{recursive:true,force:true});}
}
test('administrator can list summaries and merge without being granted report access; retries survive restart',()=>fixture(dir=>{
 const db=getDatabase();
 const list=listMergeCandidates(admin);assert.equal(list.total,2);assert.ok(!JSON.stringify(list).includes('private fixture'));
 assert.throws(()=>assertMemberAccess(admin,'source'));
 const selection=getMergeSelection(admin,'source','target');assert.equal(selection.sourceAccounts.length,2);
 const preview=previewMemberMerge(admin,input());const result=executeMemberMerge(admin,preview.token);
 assert.equal(result.reportCount,1);assert.equal(db.prepare("SELECT member_id FROM reports WHERE id='report-source'").get()!.member_id,'target');
 assert.equal(db.prepare("SELECT self_member_id FROM account_preferences WHERE user_id='owner'").get()!.self_member_id,'target');
 assert.equal(db.prepare("SELECT default_member_id FROM account_preferences WHERE user_id='viewer'").get()!.default_member_id,null);
 assert.throws(()=>assertMemberAccess(admin,'target'));assert.throws(()=>assertMemberAccess({...ordinary,id:'viewer'},'target'));assert.throws(()=>assertMemberAccess(ordinary,'source'));
 assert.equal(listMergeCandidates(admin).total,1);assert.ok(readdirSync(join(dir,'backups/full')).some(n=>n.endsWith('.tar.gz')));
 assert.deepEqual(executeMemberMerge(admin,preview.token),result);closeDatabaseForTests();assert.deepEqual(executeMemberMerge(admin,preview.token),result);
 assert.equal(getDatabase().prepare('PRAGMA foreign_key_check').get(),undefined);
}));
test('non-admin is rejected by all merge operations even with member management permission',()=>fixture(()=>{
 assert.throws(()=>listMergeCandidates(ordinary),/仅管理员/);assert.throws(()=>getMergeSelection(ordinary,'source','target'),/仅管理员/);assert.throws(()=>previewMemberMerge(ordinary,input()),/仅管理员/);assert.throws(()=>executeMemberMerge(ordinary,'x'),/仅管理员/);assert.throws(()=>getMemberMerge(ordinary,'x'),/仅管理员/);
}));
test('stale preview and token used by another administrator cannot execute',()=>fixture(()=>{
 const p=previewMemberMerge(admin,input());getDatabase().prepare("UPDATE health_members SET display_name='changed' WHERE id='source'").run();assert.throws(()=>executeMemberMerge(admin,p.token),/变化/);
 getDatabase().exec("UPDATE users SET is_gateway_admin=1 WHERE id='owner'");assert.throws(()=>executeMemberMerge({...ordinary,isGatewayAdmin:true},p.token),/失效/);
 assert.equal(getDatabase().prepare("SELECT member_id FROM reports WHERE id='report-source'").get()!.member_id,'source');
}));
test('ambiguous self identity, missing self access, last manager and injected grants are blocked',()=>fixture(()=>{
 assert.throws(()=>previewMemberMerge(admin,{...input(),sourceId:'target'}));
 assert.throws(()=>previewMemberMerge(admin,{...input(),grants:[{userId:'viewer',permission:'manager',canManageSharing:true}]}),/本人/);
 assert.throws(()=>previewMemberMerge(admin,{...input(),grants:[{userId:'owner',permission:'viewer',canManageSharing:false}]}),/管理者/);
 assert.throws(()=>previewMemberMerge(admin,{...input(),grants:[{userId:admin.id,permission:'manager',canManageSharing:true}]}),/无效/);
 getDatabase().exec("UPDATE account_preferences SET self_member_id='target' WHERE user_id='viewer'");assert.throws(()=>previewMemberMerge(admin,input()),/明确选择/);
}));
test('busy jobs and unsupported member references block preflight',()=>fixture(()=>{
 const db=getDatabase();db.exec("CREATE TABLE future_member_records(member_id TEXT)");assert.throws(()=>previewMemberMerge(admin,input()),/尚未支持/);db.exec('DROP TABLE future_member_records');
 db.exec("INSERT INTO processing_jobs(id,report_id,job_type,status,pipeline_version,deduplication_key) VALUES('busy','report-source','ai_extract','queued','fixture','fixture')");assert.throws(()=>previewMemberMerge(admin,input()),/未完成/);db.exec("UPDATE processing_jobs SET status='processing' WHERE id='busy'");assert.throws(()=>previewMemberMerge(admin,input()),/未完成/);
}));
test('mid-transaction failure rolls back reports, grants, self mapping and tombstone; backup retained',()=>fixture(dir=>{
 const db=getDatabase(),p=previewMemberMerge(admin,input());db.exec("CREATE TRIGGER fail_merge BEFORE INSERT ON member_merges BEGIN SELECT RAISE(ABORT,'fixture failure'); END");
 assert.throws(()=>executeMemberMerge(admin,p.token),/fixture failure/);
 assert.equal(db.prepare("SELECT member_id FROM reports WHERE id='report-source'").get()!.member_id,'source');assert.equal(db.prepare("SELECT deleted_at FROM health_members WHERE id='source'").get()!.deleted_at,null);
 assert.equal(db.prepare("SELECT self_member_id FROM account_preferences WHERE user_id='owner'").get()!.self_member_id,'source');assert.equal(assertMemberAccess({...ordinary,id:'viewer'},'source'),'viewer');assert.equal(db.prepare('SELECT COUNT(*) n FROM member_merges').get()!.n,0);
 assert.ok(readdirSync(join(dir,'backups/full')).length);db.exec('DROP TRIGGER fail_merge');assert.equal(executeMemberMerge(admin,p.token).status,'completed');
}));
test('colliding personal preferences keep target values; trash reports retain state',()=>fixture(()=>{
 const db=getDatabase();db.exec(`INSERT INTO member_user_preferences(user_id,member_id,hidden_at) VALUES('owner','source','2020'),('owner','target',NULL);
 INSERT INTO user_trend_pins(user_id,member_id,indicator_key,unit_key) VALUES('owner','source','fixture','U'),('owner','target','fixture','U');
 UPDATE reports SET deleted_at='2020',purge_after='2099' WHERE id='report-source';`);
 executeMemberMerge(admin,previewMemberMerge(admin,input()).token);
 assert.equal(db.prepare("SELECT hidden_at FROM member_user_preferences WHERE user_id='owner' AND member_id='target'").get()!.hidden_at,null);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM user_trend_pins').get()!.n,1);assert.equal(db.prepare("SELECT deleted_at FROM reports WHERE id='report-source'").get()!.deleted_at,'2020');
}));


test('upgrade adds merge table with backup and does not change schema version',()=>fixture(dir=>{
 const db=getDatabase();const version=db.prepare('SELECT MAX(version) AS n FROM schema_migrations').get()!.n;
 db.exec('DROP TABLE member_merges');closeDatabaseForTests();
 const reopened=getDatabase();assert.ok(reopened.prepare("SELECT name FROM sqlite_master WHERE name='member_merges'").get());
 assert.equal(reopened.prepare('SELECT MAX(version) AS n FROM schema_migrations').get()!.n,version);
 assert.ok(readdirSync(join(dir,'backups/db')).length);
}));
test('expired preview and revoked administrator cannot execute',t=>fixture(()=>{
 const p=previewMemberMerge(admin,input());const now=Date.now();t.mock.method(Date,'now',()=>now+11*60000);assert.throws(()=>executeMemberMerge(admin,p.token),/失效/);t.mock.restoreAll();
 const fresh=previewMemberMerge(admin,input());getDatabase().exec("UPDATE users SET is_gateway_admin=0 WHERE id='merge-admin'");assert.throws(()=>executeMemberMerge(admin,fresh.token),/不可用/);
}));

test('backup failure does not alter any source data',()=>fixture(dir=>{
 const db=getDatabase(),p=previewMemberMerge(admin,input());mkdirSync(join(dir,'backups'),{recursive:true});writeFileSync(join(dir,'backups/full'),'fixture');
 assert.throws(()=>executeMemberMerge(admin,p.token));assert.equal(db.prepare("SELECT member_id FROM reports WHERE id='report-source'").get()!.member_id,'source');assert.equal(db.prepare('SELECT COUNT(*) n FROM member_merges').get()!.n,0);
}));

test('attachments and manual fields retain their IDs and content after merge',()=>fixture(()=>{
 const db=getDatabase();db.exec(`INSERT INTO report_pages(id,report_id,page_number,original_name,storage_path,mime_type,file_size,sha256) VALUES('page','report-source',1,'fixture.png','reports/fixture.png','image/png',1,'fixture');
 INSERT INTO report_notes(id,report_id,content_text,created_by) VALUES('note','report-source','fixture note','owner');
 INSERT INTO report_field_overrides(id,report_id,field_key,value_json,updated_by) VALUES('override','report-source','title','"fixture correction"','owner');`);
 const before=['report_pages','report_notes','report_field_overrides'].map(table=>db.prepare(`SELECT * FROM ${table}`).all());
 executeMemberMerge(admin,previewMemberMerge(admin,input()).token);
 assert.deepEqual(['report_pages','report_notes','report_field_overrides'].map(table=>db.prepare(`SELECT * FROM ${table}`).all()),before);
}));


test('events and episodes move before reports without disabling ownership triggers or losing links',()=>fixture(()=>{
 const db=getDatabase();
 db.exec(`INSERT INTO health_events(id,member_id,event_type,title) VALUES('event','source','other','fixture');
 INSERT INTO health_episodes(id,member_id,episode_type,title) VALUES('episode','source','other','fixture');
 INSERT INTO health_event_resources(id,event_id,resource_type,resource_id) VALUES('resource','event','report','report-source');`);
 const p=previewMemberMerge(admin,input());db.exec("UPDATE health_events SET title='updated fixture' WHERE id='event'");
 assert.throws(()=>executeMemberMerge(admin,p.token),/变化/);
 const links=db.prepare('SELECT * FROM health_event_resources').all();
 const retry=previewMemberMerge(admin,input());
 db.exec("CREATE TRIGGER legacy_merge_failure BEFORE INSERT ON member_merges BEGIN SELECT RAISE(ABORT,'fixture rollback'); END");
 assert.throws(()=>executeMemberMerge(admin,retry.token),/fixture rollback/);
 assert.equal(db.prepare("SELECT member_id FROM health_events WHERE id='event'").get()!.member_id,'source');
 assert.equal(db.prepare("SELECT member_id FROM health_episodes WHERE id='episode'").get()!.member_id,'source');
 db.exec('DROP TRIGGER legacy_merge_failure');
 executeMemberMerge(admin,retry.token);
 assert.equal(db.prepare("SELECT member_id FROM health_events WHERE id='event'").get()!.member_id,'target');
 assert.equal(db.prepare("SELECT member_id FROM health_episodes WHERE id='episode'").get()!.member_id,'target');
 assert.equal(db.prepare("SELECT member_id FROM reports WHERE id='report-source'").get()!.member_id,'target');
 assert.deepEqual(db.prepare('SELECT * FROM health_event_resources').all(),links);
 assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name='health_event_report_member_change'").get());
 assert.equal(db.prepare('PRAGMA foreign_key_check').get(),undefined);
}));


test('explicit self resolution preserves both accounts and data, and rolls back both associations on failure',()=>fixture(()=>{
 const db=getDatabase();db.exec("UPDATE account_preferences SET self_member_id='target' WHERE user_id='viewer'");
 const request={...input(),selfUserId:'viewer',grants:[...input().grants,{userId:'viewer',permission:'viewer',canManageSharing:false}]};
 const p=previewMemberMerge(admin,request);assert.equal(p.selfResolution.retained?.userId,'viewer');assert.equal(p.selfResolution.released[0].userId,'owner');
 const before=db.prepare('SELECT * FROM account_preferences ORDER BY user_id').all();
 db.exec("CREATE TRIGGER self_failure BEFORE INSERT ON member_merges BEGIN SELECT RAISE(ABORT,'self rollback'); END");
 assert.throws(()=>executeMemberMerge(admin,p.token),/self rollback/);assert.deepEqual(db.prepare('SELECT * FROM account_preferences ORDER BY user_id').all(),before);
 db.exec('DROP TRIGGER self_failure');executeMemberMerge(admin,p.token);
 assert.equal(db.prepare("SELECT self_member_id FROM account_preferences WHERE user_id='owner'").get()!.self_member_id,null);
 assert.equal(db.prepare("SELECT self_member_id FROM account_preferences WHERE user_id='viewer'").get()!.self_member_id,'target');
 assert.equal(db.prepare('SELECT COUNT(*) n FROM users').get()!.n,3);assert.equal(db.prepare("SELECT COUNT(*) n FROM reports WHERE member_id='target'").get()!.n,2);
 assert.equal(assertMemberAccess(ordinary,'target'),'manager');
}));
test('unusable backup identity can be explicitly released without name matching or deleting its account',()=>fixture(()=>{
 const db=getDatabase();db.exec("UPDATE account_preferences SET self_member_id='target' WHERE user_id='viewer'; DELETE FROM user_identities WHERE user_id='viewer'");
 assert.equal(getMergeSelection(admin,'source','target').selfAccounts.find(a=>a.userId==='viewer')!.usable,false);
 assert.throws(()=>previewMemberMerge(admin,{...input(),selfUserId:'viewer'}),/不可用/);
 assert.throws(()=>previewMemberMerge(admin,{...input(),selfUserId:admin.id}),/无效/);
 const p=previewMemberMerge(admin,{...input(),selfUserId:null});assert.equal(p.selfResolution.released.length,2);executeMemberMerge(admin,p.token);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM account_preferences WHERE self_member_id IS NOT NULL').get()!.n,0);
 assert.ok(db.prepare("SELECT id FROM users WHERE id='viewer'").get());assert.equal(db.prepare('SELECT COUNT(*) n FROM reports').get()!.n,2);
}));
test('self association changes after preview invalidate the confirmed plan',()=>fixture(()=>{
 const p=previewMemberMerge(admin,{...input(),selfUserId:'owner'});
 getDatabase().exec("UPDATE account_preferences SET self_member_id='target' WHERE user_id='viewer'");
 assert.throws(()=>executeMemberMerge(admin,p.token),/变化/);
 assert.equal(getDatabase().prepare("SELECT member_id FROM reports WHERE id='report-source'").get()!.member_id,'source');
}));

test('pending backup identity is not reactivated and recovery metadata remains intact',()=>fixture(()=>{
 const db=getDatabase();db.exec("UPDATE account_preferences SET self_member_id='target' WHERE user_id='viewer'; INSERT INTO identity_recovery_pending(user_id,source_json) VALUES('viewer','{}')");
 const before=db.prepare('SELECT * FROM identity_recovery_pending').all();
 assert.throws(()=>previewMemberMerge(admin,{...input(),selfUserId:'viewer'}),/不可用/);
 executeMemberMerge(admin,previewMemberMerge(admin,{...input(),selfUserId:'owner'}).token);
 assert.deepEqual(db.prepare('SELECT * FROM identity_recovery_pending').all(),before);
 assert.equal(db.prepare("SELECT self_profile_choice FROM account_preferences WHERE user_id='viewer'").get()!.self_profile_choice,'skipped');
}));
test('unexpected preference constraint failure rolls back instead of dropping source preferences',()=>fixture(()=>{
 const db=getDatabase();db.exec("INSERT INTO member_user_preferences(user_id,member_id) VALUES('owner','source'); CREATE TRIGGER reject_preference BEFORE INSERT ON member_user_preferences WHEN NEW.member_id='target' BEGIN SELECT RAISE(ABORT,'preference constraint'); END");
 const p=previewMemberMerge(admin,input());assert.throws(()=>executeMemberMerge(admin,p.token),/preference constraint/);
 assert.ok(db.prepare("SELECT * FROM member_user_preferences WHERE member_id='source'").get());
 assert.equal(db.prepare("SELECT member_id FROM reports WHERE id='report-source'").get()!.member_id,'source');
}));

test('five-category vaccination ownership, reminders and direct document/process links survive member merge',()=>fixture(()=>{
 const episode=createHealthEpisode(ordinary,{memberId:'source',episodeType:'other',title:'合成过程'});
 const vaccine=createVaccination(ordinary,{memberId:'source',vaccineName:'合成疫苗',administeredAt:'2026-01-01',nextDueAt:'2026-02-01',sourceReportId:'report-source',episodeId:episode.id});
 const process=linkProcessRecords(ordinary,{kind:'report',id:'report-source'},[{kind:'vaccination',id:vaccine.id}])[0];
 const plan=previewMemberMerge(admin,input());executeMemberMerge(admin,plan.token);
 assert.equal(getVaccination(ordinary,vaccine.id).memberId,'target');
 assert.equal(getDatabase().prepare('SELECT member_id FROM reminders WHERE id=?').get(vaccine.reminderId!)?.member_id,'target');
 assert.equal(getDatabase().prepare('SELECT COUNT(*) AS n FROM health_record_links').get()?.n,1);assert.equal(getRecordProcess(ordinary,process.id).memberId,'target');
 assert.deepEqual(validateHealthWorkflowDatabase(getDatabase()),[]);
}));
test('member merge explicitly selects health background and detects background changes after preview',()=>fixture(()=>{
 const db=getDatabase();db.exec("UPDATE health_members SET care_allergies='Synthetic source allergy',care_history='Synthetic source history' WHERE id='source'; UPDATE health_members SET care_allergies='Synthetic target allergy' WHERE id='target'");
 assert.throws(()=>previewMemberMerge(admin,input()),e=>(e as {statusCode:number}).statusCode===400);
 const data={...input(),choices:{...choices,care_allergies:'source',care_history:'source',care_medications:'target'}};
 const preview=previewMemberMerge(admin,data);assert.equal(preview.resolvedFields.care_allergies,'Synthetic source allergy');db.exec("UPDATE health_members SET care_history='Synthetic updated history' WHERE id='source'");assert.throws(()=>executeMemberMerge(admin,preview.token));
 const fresh=previewMemberMerge(admin,data);executeMemberMerge(admin,fresh.token);const target=db.prepare("SELECT care_allergies,care_history FROM health_members WHERE id='target'").get()!;assert.equal(target.care_allergies,'Synthetic source allergy');assert.equal(target.care_history,'Synthetic updated history');
}));
