import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync,rmSync,readFileSync,writeFileSync,existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { getDatabase,closeDatabaseForTests } from '../database/client';
import { ensureMemberSharingDraft } from '../database/member-sharing-draft';
import { bootstrapLocalAdministrator,createLocalAccount,setLocalAccountDisabled,deleteLocalAccount } from '../services/auth.service';
import { createMember,setMemberPermission,assertMemberAccess,assertMemberManage,assertMemberShare,updateMember,listMemberSharingAccounts,setMembersPermission } from '../services/member.service';
import { getAccountPreferences,updateAccountPreferences,setMemberHidden } from '../services/member-preferences.service';
import { listMembers,listReports,createFullBackup,preflightStoredBackup,restoreBackup,getReportDetail } from '../services/records.service';
import { getReportExaminations,saveReportExamination } from '../services/report-examination.service';
import { setExaminationDuplicateDecision,examinationDuplicateResolver } from '../services/examination-duplicate.service';
import { getDeploymentIdentity } from '../utils/deployment-identity';
import { getRequestUser } from '../utils/request-user';
import type { H3Event } from 'h3';
import type { RequestUser } from '../domain/request-user';

function setup(run:(dir:string,admin:RequestUser,a:RequestUser,b:RequestUser)=>void) {
 const dir=mkdtempSync(join(tmpdir(),'sharing-restore-'));
 const env={...process.env};process.env.STORAGE_DIR=dir;process.env.AUTH_MODE='local';process.env.DISABLE_JOB_RUNNER='true';
 try {
  bootstrapLocalAdministrator(); const db=getDatabase();
  const row=db.prepare('SELECT id FROM users').get() as {id:string};
  const admin:RequestUser={id:row.id,displayName:'测试维护账号',provider:'local',authenticated:true,isAdmin:true,isGatewayAdmin:true};
  const first=createLocalAccount(admin,{username:'account-a',displayName:'测试 A'});
  const second=createLocalAccount(admin,{username:'account-b',displayName:'测试 B'});
  run(dir,admin,{...admin,id:first.userId,isAdmin:false},{...admin,id:second.userId,isAdmin:false});
 } finally {closeDatabaseForTests();process.env=env;rmSync(dir,{recursive:true,force:true});}
}
function status(code:number){return (error:unknown)=>(error as {status?:number}).status===code;}

test('sharing applies to all reports; admin has no implicit read/write/share; last manager and versions are enforced',()=>setup((_dir,admin,a,b)=>{
 const father=createMember(a,{displayName:'测试成员一',relationship:'parent'});
 const mother=createMember(a,{displayName:'测试成员二',relationship:'parent'});
 assert.equal(listMembers(admin).length,0);
 assert.throws(()=>updateMember(admin,father.id,{displayName:'非法'}),status(403));
 assert.throws(()=>setMemberPermission(admin,father.id,{userId:admin.id,permission:'manager',version:0}),status(403));
 setMemberPermission(a,father.id,{userId:b.id,permission:'viewer',version:0});
 assert.equal(assertMemberAccess(b,father.id),'viewer');assert.throws(()=>assertMemberManage(b,father.id),status(403));
 assert.throws(()=>assertMemberAccess(b,mother.id),status(403));
 const db=getDatabase();
 for(const id of ['before','after']) db.prepare("INSERT INTO reports(id,member_id,created_by,report_type,title) VALUES(?,?,?,'exam','合成测试')").run(id,father.id,a.id);
 assert.equal(listReports(b,30,father.id).items.length,2);assert.equal(listReports(admin).items.length,0);
 assert.throws(()=>getReportDetail(admin,'before'),status(403));
 setMemberPermission(a,father.id,{userId:b.id,permission:'manager',version:1});assert.throws(()=>assertMemberShare(b,father.id),status(403));
 assert.throws(()=>setMemberPermission(a,father.id,{userId:a.id,permission:'viewer',version:2}),status(409));
 assert.throws(()=>setMemberPermission(a,father.id,{userId:b.id,permission:'viewer',version:1}),status(409));
 setMemberPermission(a,father.id,{userId:b.id,permission:'manager',canManageSharing:true,version:2});
 setMemberPermission(a,father.id,{userId:a.id,permission:null,version:3});
 assert.throws(()=>assertMemberAccess(a,father.id),status(403));
 assert.throws(()=>setLocalAccountDisabled(admin,{userId:b.id,disabled:true}),status(409));
 assert.throws(()=>deleteLocalAccount(admin,{userId:b.id,force:true}),status(409));
}));

test('optional self is idempotent; hidden is per account and neither relationship nor preference grants access',()=>setup((_dir,admin,a,b)=>{
 assert.equal(getDatabase().prepare('SELECT COUNT(*) AS n FROM health_members').get()!.n,0);
 updateAccountPreferences(a,{selfProfileChoice:'skipped'});assert.equal(getAccountPreferences(a)!.selfProfileChoice,'skipped');
 const self=createMember(a,{displayName:'测试本人',createSelf:true});
 assert.equal(createMember(a,{displayName:'重复请求',createSelf:true}).id,self.id);
 setMemberPermission(a,self.id,{userId:b.id,permission:'viewer',version:0});
 assert.equal(listMembers(b)[0].relationship,'shared');assert.equal(listMembers(a)[0].isSelf,1);
 setMemberHidden(b,self.id,true);assert.equal(listMembers(b)[0].hidden,1);assert.equal(listMembers(a)[0].hidden,0);
 assert.ok(listMemberSharingAccounts(a,self.id).some(account=>account.id===b.id));
 assert.throws(()=>listMemberSharingAccounts(admin,self.id),status(403));
 assert.throws(()=>updateAccountPreferences(admin,{selfMemberId:self.id}),status(403));
 ensureMemberSharingDraft(getDatabase());assert.equal(getAccountPreferences(a)!.selfMemberId,self.id);assert.equal(listMembers(b)[0].hidden,1);
}));

test('same-instance restore preserves ordinary credentials, viewer grants, preferences, and clears sessions',()=>setup((_dir,admin,a,b)=>{
 const self=createMember(a,{displayName:'合成档案',createSelf:true});
 setMemberPermission(a,self.id,{userId:admin.id,permission:'viewer',version:0});
 setMemberHidden(admin,self.id,true);updateAccountPreferences(b,{selfProfileChoice:'skipped'});
 const db=getDatabase();const accountBefore=db.prepare('SELECT * FROM local_accounts WHERE user_id=?').get(a.id);
 db.prepare("INSERT INTO reports(id,member_id,created_by,report_type,title,status) VALUES('examination-report',?,?,'laboratory','合成检查','ready')").run(self.id,a.id);
 db.exec("INSERT INTO observations(id,report_id,item_name,result_text) VALUES('examination-observation','examination-report','合成指标','80')");
 const initial=getReportExaminations(a,'examination-report');
 const examinationBefore=saveReportExamination(a,'examination-report',{version:initial.version,reportVersion:initial.reportVersion,requestKey:'restore-test',examination:{sampledAt:'2026-09-08',examinationType:'检验',timeText:'采样日期：2026-09-08'},observationIds:['examination-observation']});
 const backup=createFullBackup(admin);
 db.prepare("UPDATE local_accounts SET username='renamed-admin' WHERE user_id=?").run(admin.id);
 db.prepare("UPDATE user_identities SET subject='renamed-admin' WHERE user_id=? AND provider='local'").run(admin.id);
 const plan=preflightStoredBackup(admin,backup.id);assert.equal(plan.strategy,'same');
 db.prepare("UPDATE health_members SET display_name='备份之后' WHERE id=?").run(self.id);
 const result=restoreBackup(admin,backup.id,plan.token);assert.equal(result.identityRebind.memberPermissionCount,0);
 assert.deepEqual(getReportExaminations(a,'examination-report'),examinationBefore);
 assert.deepEqual(getReportExaminations(admin,'examination-report'),examinationBefore);
 assert.equal(assertMemberAccess(admin,self.id),'viewer');assert.throws(()=>assertMemberManage(admin,self.id),status(403));
 assert.deepEqual(getDatabase().prepare('SELECT * FROM local_accounts WHERE user_id=?').get(a.id),accountBefore);
 assert.equal(getAccountPreferences(a)!.selfMemberId,self.id);assert.equal(listMembers(admin)[0].hidden,1);
 assert.equal(getDatabase().prepare('SELECT COUNT(*) AS n FROM auth_sessions').get()!.n,0);
 assert.equal(getDatabase().prepare('SELECT username FROM local_accounts WHERE user_id=?').get(admin.id)!.username,'renamed-admin');
 assert.equal(getDatabase().prepare("SELECT COUNT(*) AS n FROM user_identities WHERE user_id=? AND provider='local'").get(admin.id)!.n,1);
}));

test('backup restores explicit examination relationships and keeps revocation effective',()=>setup((_dir,admin,a,b)=>{
 const member=createMember(a,{displayName:'合成档案',relationship:'other'});
 setMemberPermission(a,member.id,{userId:b.id,permission:'viewer',version:0});
 const db=getDatabase();
 for(const id of ['source-a','source-b']) {
  db.prepare("INSERT INTO reports(id,member_id,created_by,report_type,title,status) VALUES(?,?,?,'laboratory','合成检查','ready')").run(id,member.id,a.id);
  db.prepare("INSERT INTO report_examinations(id,report_id,source_key,occurred_at,time_kind,confirmation_status,evidence_json) VALUES(?,?,'synthetic','2026-09-08','sampled','confirmed',?)").run(id,id,JSON.stringify([{pageNumber:1,quote:'合成时间证据'}]));
 }
 const versions=()=>['source-a','source-b'].map(id=>Number(getDatabase().prepare('SELECT source_version FROM reports WHERE id=?').get(id)!.source_version));
 let [leftVersion,rightVersion]=versions();
 setExaminationDuplicateDecision(a,{leftId:'source-a',rightId:'source-b',leftVersion,rightVersion,decision:'same'});
 const before=getReportExaminations(b,'source-a');
 const backup=createFullBackup(admin);
 [leftVersion,rightVersion]=versions();
 setExaminationDuplicateDecision(a,{leftId:'source-a',rightId:'source-b',leftVersion,rightVersion,decision:'different'});
 assert.equal(examinationDuplicateResolver()('source-a','source-b'),false);
 const plan=preflightStoredBackup(admin,backup.id);
 restoreBackup(admin,backup.id,plan.token);
 assert.deepEqual(getReportExaminations(b,'source-a'),before);
 assert.equal(examinationDuplicateResolver()('source-a','source-b'),true);
 assert.throws(()=>getReportExaminations(admin,'source-a'),status(403));
 [leftVersion,rightVersion]=versions();
 assert.throws(()=>setExaminationDuplicateDecision(b,{leftId:'source-a',rightId:'source-b',leftVersion,rightVersion,decision:'different'}),status(403));
 setExaminationDuplicateDecision(a,{leftId:'source-a',rightId:'source-b',leftVersion,rightVersion,decision:'different'});
 const unlinked=createFullBackup(admin);
 const unlinkPlan=preflightStoredBackup(admin,unlinked.id);
 restoreBackup(admin,unlinked.id,unlinkPlan.token);
 assert.equal(examinationDuplicateResolver()('source-a','source-b'),false,'explicit unlink survives a second restore');
 setMemberPermission(a,member.id,{userId:b.id,permission:null,version:1});
 assert.throws(()=>getReportExaminations(b,'source-a'),status(403));
 assert.equal(getDatabase().prepare('SELECT COUNT(*) AS n FROM report_examinations').get()!.n,2);
}));

test('cross-instance restore isolates identities despite matching IDs and enables explicit mapping preview',()=>setup((dir,admin,a)=>{
 const self=createMember(a,{displayName:'合成档案',createSelf:true});
 const backup=createFullBackup(admin);
 const anchor=join(dir,'deployment-identity.json');writeFileSync(anchor,JSON.stringify({id:'different-instance'}));
 const plan=preflightStoredBackup(admin,backup.id);assert.equal(plan.strategy,'cross');
 const result=restoreBackup(admin,backup.id,plan.token);assert.notEqual(result.identityRebind.userId,admin.id);
 const target={...admin,id:result.identityRebind.userId};assert.equal(listMembers(target).length,0);
 assert.throws(()=>assertMemberAccess(a,self.id),status(403));
 const database=join(dir,'db','health-records.sqlite');
 const pending=JSON.parse(execFileSync(process.execPath,['scripts/maintenance/identity-recovery.mjs','pending','--database',database],{encoding:'utf8'}));
 assert.ok(pending.some((row:{sourceUserId:string})=>row.sourceUserId===a.id));
 const out=join(dir,'plan.json');
 const preview=JSON.parse(execFileSync(process.execPath,['scripts/maintenance/identity-recovery.mjs','map-plan','--database',database,'--source',a.id,'--target',target.id,'--out',out],{encoding:'utf8'}));
 assert.ok(preview.confirmation);assert.equal(listMembers(target).length,0);
 closeDatabaseForTests();
 const applied=JSON.parse(execFileSync(process.execPath,['scripts/maintenance/identity-recovery.mjs','apply','--database',database,'--plan',out,'--confirm',preview.confirmation,'--actor',target.id,'--receipt',join(dir,'map-receipt.json'),'--backup',join(dir,'before-map.sqlite'),'--service-stopped'],{encoding:'utf8'}));
 assert.equal(applied.applied,true);assert.equal(assertMemberAccess(target,self.id),'manager');
 assert.equal(getDatabase().prepare('SELECT created_by FROM health_members WHERE id=?').get(self.id)!.created_by,a.id);
 assert.equal(getDeploymentIdentity().id,'different-instance');
}));

test('draft only backfills unique creator self candidates, never delegated managers, and is repeatable',()=>{
 const db=new DatabaseSync(':memory:');
 try {
  db.exec(`CREATE TABLE users(id TEXT PRIMARY KEY);CREATE TABLE user_identities(user_id TEXT);CREATE TABLE local_accounts(user_id TEXT,disabled_at TEXT);
   CREATE TABLE health_members(id TEXT PRIMARY KEY,relationship TEXT,created_by TEXT,deleted_at TEXT);
   CREATE TABLE member_permissions(member_id TEXT,user_id TEXT,permission TEXT);
   INSERT INTO users VALUES('a'),('b');INSERT INTO user_identities VALUES('a'),('b');
   INSERT INTO health_members VALUES('one','self','a',NULL),('two','self','a',NULL);
   INSERT INTO member_permissions VALUES('one','a','manager'),('two','a','manager'),('one','b','manager');`);
  ensureMemberSharingDraft(db);
  assert.equal(db.prepare("SELECT self_profile_choice FROM account_preferences WHERE user_id='a'").get()!.self_profile_choice,'pending');
  assert.equal(db.prepare("SELECT can_manage_sharing FROM member_permissions WHERE user_id='b'").get()!.can_manage_sharing,0);
  db.exec("UPDATE account_preferences SET self_profile_choice='skipped'; UPDATE member_permissions SET can_manage_sharing=0");
  ensureMemberSharingDraft(db);assert.equal(db.prepare('SELECT SUM(can_manage_sharing) AS n FROM member_permissions').get()!.n,0);
 } finally {db.close();}
});

test('confirmed restore failure rolls back files, permissions, identity and leaves service usable',()=>setup((dir,admin,a)=>{
 const member=createMember(a,{displayName:'合成档案',createSelf:true});
 const db=getDatabase();
 db.exec("CREATE TRIGGER reject_restored_admin BEFORE UPDATE ON users BEGIN SELECT RAISE(ABORT,'injected identity failure'); END");
 const backup=createFullBackup(admin);db.exec('DROP TRIGGER reject_restored_admin');
 db.prepare("UPDATE health_members SET display_name='当前合成档案' WHERE id=?").run(member.id);
 const plan=preflightStoredBackup(admin,backup.id);
 assert.throws(()=>restoreBackup(admin,backup.id,plan.token),/injected identity failure/);
 assert.equal(getDatabase().prepare('SELECT display_name FROM health_members WHERE id=?').get(member.id)!.display_name,'当前合成档案');
 assert.equal(assertMemberAccess(a,member.id),'manager');assert.equal(listMembers(admin).length,0);
 assert.equal(existsSync(join(dir,'restore-maintenance.json')),false);
}));

test('plans reject substituted archive identity state and cannot be reused',()=>setup((_dir,admin)=>{
 const backup=createFullBackup(admin);const plan=preflightStoredBackup(admin,backup.id);
 getDatabase().prepare("UPDATE user_identities SET subject='changed-login' WHERE user_id=?").run(admin.id);
 assert.throws(()=>restoreBackup(admin,backup.id,plan.token),status(409));
}));

test('two NAS instances with identical external UID never bind the imported source account',()=>{
 const dir=mkdtempSync(join(tmpdir(),'sharing-fnos-'));const env={...process.env};
 process.env.STORAGE_DIR=dir;process.env.AUTH_MODE='fnos';process.env.DISABLE_JOB_RUNNER='true';
 const gateway=()=>({context:{},node:{req:{healthAccessMode:'gateway',headers:{'x-trim-userid':'1000','x-trim-username':'合成网关账号','x-trim-isadmin':'true'}}}} as unknown as H3Event);
 try {
  const source=getRequestUser(gateway());const member=createMember(source,{displayName:'合成档案',createSelf:true});const backup=createFullBackup(source);
  writeFileSync(join(dir,'deployment-identity.json'),JSON.stringify({id:'second-nas'}));
  const target=getRequestUser(gateway());assert.notEqual(target.id,source.id);
  const plan=preflightStoredBackup(target,backup.id);assert.equal(plan.strategy,'cross');
  const restored=restoreBackup(target,backup.id,plan.token);const login=getRequestUser(gateway());
  assert.equal(login.id,restored.identityRebind.userId);assert.notEqual(login.id,source.id);
  assert.equal(listMembers(login).length,0);assert.throws(()=>assertMemberAccess(login,member.id),status(403));
 } finally {closeDatabaseForTests();process.env=env;rmSync(dir,{recursive:true,force:true});}
});

test('legacy repair is selected, backed up, conflict checked and reversible',()=>setup((dir,admin,a)=>{
 const member=createMember(a,{displayName:'合成档案',createSelf:true});const db=getDatabase();
 const baseline=join(dir,'baseline.sqlite');db.exec(`VACUUM INTO '${baseline.replaceAll("'","''")}'`);
 db.prepare("INSERT INTO member_permissions(member_id,user_id,permission,granted_by) VALUES(?,?,'manager',?)").run(member.id,admin.id,admin.id);
 db.prepare("INSERT INTO audit_logs(id,actor_user_id,action,target_type,detail_json) VALUES('old-restore',?,'backup.identity_rebind','user','{}')").run(admin.id);
 const database=join(dir,'db','health-records.sqlite'),plan=join(dir,'repair.json');
 const command=(args:string[])=>JSON.parse(execFileSync(process.execPath,['scripts/maintenance/identity-recovery.mjs',...args,'--database',database],{encoding:'utf8'}));
 const preview=command(['repair-plan','--baseline',baseline,'--user',admin.id,'--members',member.id,'--out',plan]);
 assert.equal(preview.changes.length,1);assert.equal(preview.changes[0].classification,'added-grant');
 closeDatabaseForTests();
 const receipt=join(dir,'receipt.json');
 const applied=command(['apply','--plan',plan,'--confirm',preview.confirmation,'--actor',admin.id,'--receipt',receipt,'--backup',join(dir,'before.sqlite'),'--service-stopped']);
 assert.equal(applied.applied,true);assert.equal(listMembers(admin).length,0);assert.equal(assertMemberAccess(a,member.id),'manager');
 closeDatabaseForTests();
 const undone=command(['undo','--plan',receipt,'--confirm',applied.undoConfirmation,'--actor',admin.id,'--receipt',join(dir,'undo.json'),'--backup',join(dir,'before-undo.sqlite'),'--service-stopped']);
 assert.equal(undone.applied,true);assert.equal(assertMemberAccess(admin,member.id),'manager');
}));

test('orphan claim is explicit and reviewable, never automatic or available when a valid manager exists',()=>setup((dir,admin,a)=>{
 const member=createMember(a,{displayName:'合成孤立档案',createSelf:true});const database=join(dir,'db','health-records.sqlite');
 const args=['scripts/maintenance/identity-recovery.mjs','claim-plan','--database',database,'--members',member.id,'--target',a.id,'--actor',admin.id,'--reason','synthetic-verification','--out',join(dir,'claim.json')];
 assert.throws(()=>execFileSync(process.execPath,args,{stdio:'pipe'}));
 getDatabase().prepare('UPDATE member_permissions SET can_manage_sharing=0 WHERE member_id=?').run(member.id);
 const preview=JSON.parse(execFileSync(process.execPath,args,{encoding:'utf8'}));assert.equal(preview.changes.length,1);
 assert.throws(()=>assertMemberShare(a,member.id),status(403));closeDatabaseForTests();
 execFileSync(process.execPath,['scripts/maintenance/identity-recovery.mjs','apply','--database',database,'--plan',join(dir,'claim.json'),'--confirm',preview.confirmation,'--actor',admin.id,'--receipt',join(dir,'claim-receipt.json'),'--backup',join(dir,'before-claim.sqlite'),'--service-stopped'],{stdio:'pipe'});
 assertMemberShare(a,member.id);assert.equal(listMembers(admin).length,0);
}));

test('sharing account list requires member sharing rights and excludes unusable identities',()=>setup((_dir,admin,a,b)=>{
 const member=createMember(a,{displayName:'测试档案',relationship:'other'});
 assert.throws(()=>listMemberSharingAccounts(admin,member.id),status(403));
 setMemberPermission(a,member.id,{userId:b.id,permission:'viewer',version:0});
 assert.throws(()=>listMemberSharingAccounts(b,member.id),status(403));
 setMemberPermission(a,member.id,{userId:b.id,permission:'manager',version:1});
 assert.throws(()=>listMemberSharingAccounts(b,member.id),status(403));
 setMemberPermission(a,member.id,{userId:b.id,permission:'manager',canManageSharing:true,version:2});
 assert.ok(listMemberSharingAccounts(b,member.id).some(account=>account.id===a.id));
 const inactive=createLocalAccount(admin,{username:'inactive-test',displayName:'停用测试'});
 setLocalAccountDisabled(admin,{userId:inactive.userId,disabled:true});
 const pending=createLocalAccount(admin,{username:'pending-test',displayName:'待确认测试'});
 const db=getDatabase();
 db.prepare("INSERT INTO identity_recovery_pending(user_id,source_json) VALUES(?,'{}')").run(pending.userId);
 db.exec("INSERT INTO users(id,display_name) VALUES('foreign-mode','其他环境'); INSERT INTO user_identities(id,user_id,provider,subject) VALUES('foreign-mode-id','foreign-mode','fnos_gateway','foreign-mode')");
 const accounts=listMemberSharingAccounts(a,member.id);
 assert.deepEqual(new Set(accounts.map(account=>account.id)),new Set([admin.id,a.id,b.id]));
 assert.deepEqual(Object.keys(accounts[0]).sort(),['displayName','id']);
 assert.equal(listMembers(admin).length,0);
 assert.throws(()=>setMemberPermission(a,member.id,{userId:inactive.userId,permission:'viewer',version:3}),status(404));
}));

test('account preferences tolerate retired draft columns without returning them or changing associations',()=>setup((_dir,_admin,a)=>{
 const self=createMember(a,{displayName:'兼容测试',createSelf:true});
 const db=getDatabase();
 assert.ok(!(db.prepare('PRAGMA table_info(account_preferences)').all() as Array<{name:string}>).some(c=>c.name==='share_lookup_code'));
 db.exec("ALTER TABLE account_preferences ADD COLUMN share_lookup_code TEXT DEFAULT 'retired-value'");
 ensureMemberSharingDraft(db);
 assert.equal(getAccountPreferences(a)!.selfMemberId,self.id);
 assert.equal(Object.hasOwn(getAccountPreferences(a)!,'shareLookupCode'),false);
 assert.equal(db.prepare('SELECT share_lookup_code FROM account_preferences WHERE user_id=?').get(a.id)!.share_lookup_code,'retired-value');
}));

test('batch sharing is atomic for version, scope and last-manager failures',()=>setup((_dir,admin,a,b)=>{
 const first=createMember(a,{displayName:'范围一',relationship:'other'});
 const second=createMember(a,{displayName:'范围二',relationship:'other'});
 const untouched=createMember(a,{displayName:'未选择',relationship:'other'});
 const members=[{memberId:first.id,version:0},{memberId:second.id,version:0}];
 assert.throws(()=>setMembersPermission(admin,{members,userId:b.id,permission:'viewer'}),status(403));
 assert.throws(()=>setMembersPermission(a,{members:[members[0],{...members[1],version:1}],userId:b.id,permission:'viewer'}),status(409));
 assert.throws(()=>assertMemberAccess(b,first.id),status(403));
 assert.equal(getDatabase().prepare('SELECT COUNT(*) AS n FROM member_permission_versions WHERE member_id=?').get(first.id)!.n,0);
 assert.throws(()=>setMembersPermission(a,{members:[members[0],members[0]],userId:b.id,permission:'viewer'}),status(400));
 assert.throws(()=>setMembersPermission(a,{members:[],userId:b.id,permission:'viewer'}),status(400));
 assert.deepEqual(setMembersPermission(a,{members,userId:b.id,permission:'viewer'}),{updated:2});
 assert.equal(assertMemberAccess(b,first.id),'viewer');
 assert.equal(assertMemberAccess(b,second.id),'viewer');
 assert.throws(()=>assertMemberAccess(b,untouched.id),status(403));
 setMemberPermission(a,first.id,{userId:b.id,permission:'manager',canManageSharing:true,version:1});
 assert.throws(()=>setMembersPermission(a,{members:[{memberId:first.id,version:2},{memberId:second.id,version:1}],userId:a.id,permission:null}),status(409));
 assertMemberShare(a,first.id);
 assertMemberShare(a,second.id);
 const alien=createMember(admin,{displayName:'无权范围',relationship:'other'});
 assert.throws(()=>setMembersPermission(a,{members:[{memberId:first.id,version:2},{memberId:alien.id,version:0}],userId:b.id,permission:'viewer'}),status(403));
 assertMemberShare(b,first.id);
}));

test('restoring an older backup without examination tables preserves unlinked observations without inference',()=>setup((_dir,admin,a)=>{
 const member=createMember(a,{displayName:'合成旧档案',relationship:'other'});
 const db=getDatabase();
 db.prepare("INSERT INTO reports(id,member_id,created_by,report_type,title,status,report_issued_at) VALUES('old-exam-report',?,?,'laboratory','合成旧报告','ready','2025-01-02')").run(member.id,a.id);
 db.exec("INSERT INTO observations(id,report_id,item_name,result_text) VALUES('old-exam-observation','old-exam-report','合成指标','80'); DROP TABLE observation_examinations; DROP TABLE report_examinations; DROP TABLE report_examination_state;");
 const backup=createFullBackup(admin);
 const plan=preflightStoredBackup(admin,backup.id);
 restoreBackup(admin,backup.id,plan.token);
 const result=getReportExaminations(a,'old-exam-report');
 assert.equal(result.examinations.length,0);
 assert.equal(result.observations.length,1);
 assert.equal(result.observations[0].resultText,'80');
 assert.equal(result.observations[0].examinationId,null);
 assert.equal(getDatabase().prepare('SELECT COUNT(*) AS n FROM processing_jobs').get()!.n,0);
 assert.throws(()=>getReportExaminations(admin,'old-exam-report'),status(403));
}));
