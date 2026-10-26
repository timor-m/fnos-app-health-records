import {discardMemberTrendSnapshots} from './trend-snapshot-runner.service';
import { createHash, randomBytes } from 'node:crypto';
import { createError } from 'h3';
import { getDatabase, runInTransaction } from '../database/client';
import { isAdministrator, type RequestUser } from '../domain/request-user';
import { isUsableMemberAccount } from './member.service';
import { createBackup, isStorageExportActive } from './records.service';
import { getJobRunnerStatus } from './job-runner.service';
import { isStorageMaintenanceActive } from './maintenance-runner.service';
import { isStorageNormalizationActive } from './indicator-normalization-task.service';
import { activeStorageRequests, storageMigrationPaused } from '../utils/storage-migration-state';
import { rebuildMorphologyTrackingForMember } from './morphology-finding.service';

type Grant = {userId:string;permission:'viewer'|'manager';canManageSharing:boolean};
type Choices = Record<'display_name'|'birth_date'|'sex'|'blood_type_abo'|'blood_type_rh', 'source'|'target'>;
type Input = {sourceId:string;targetId:string;grants:Grant[];choices:Choices;selfUserId:string|null};
const fields = ['display_name','birth_date','sex','blood_type_abo','blood_type_rh'] as const;
const simpleTables = ['reports','reminders','app_notifications','institution_trend_projects','report_duplicate_decisions','report_duplicate_history','report_duplicate_operations','upload_receipts'];
// Historical installations may retain these tables. Move events before reports
// to satisfy the report/event ownership trigger without dropping any safeguards.
const optionalTables = ['health_episodes','health_events'];
function existingOptionalTables() {
 const db=getDatabase();
 return optionalTables.filter(name=>Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)));
}
const pairTables = ['member_user_preferences','user_trend_pins','file_gc_members'];
// Derived snapshots are discarded rather than moved or fingerprinted.
const trendSnapshotTables = ['trend_snapshot_members','trend_snapshot_entries','trend_snapshot_series','trend_snapshot_contributions','trend_snapshot_dirty_reports'];
const knownTables = new Set([...simpleTables,...optionalTables,...pairTables,...trendSnapshotTables,'member_permissions','member_permission_versions']);
const plans = new Map<string,{actorId:string;expires:number;input:Input;fingerprint:string}>();
function fail(status:number,message:string):never {throw createError({statusCode:status,statusMessage:message});}
const hash = (v:unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
export function requireMergeAdministrator(user:RequestUser) {
 if (!user.authenticated || !isAdministrator(user)) fail(403,'仅管理员可合并成员档案');
 const db=getDatabase();
 if (!db.prepare('SELECT id FROM users WHERE id=? AND is_gateway_admin=1').get(user.id) || db.prepare('SELECT 1 FROM identity_recovery_pending WHERE user_id=?').get(user.id) || db.prepare('SELECT 1 FROM local_accounts WHERE user_id=? AND disabled_at IS NOT NULL').get(user.id)) fail(403,'当前账号不可用');
}
function member(id:string) {
 const row=getDatabase().prepare(`SELECT id,display_name,birth_date,sex,blood_type_abo,blood_type_rh,created_by,created_at,updated_at FROM health_members WHERE id=? AND deleted_at IS NULL`).get(id);
 if (!row) fail(409,'所选档案已删除或合并，请重新选择');
 return row;
}
function accounts(id:string) {
 return (getDatabase().prepare(`SELECT p.user_id AS userId,u.display_name AS displayName,p.permission,p.can_manage_sharing AS sharing FROM member_permissions p JOIN users u ON u.id=p.user_id WHERE p.member_id=? ORDER BY p.user_id`).all(id) as Array<{userId:string;displayName:string;permission:'viewer'|'manager';sharing:number}>).map(r=>({...r,usable:isUsableMemberAccount(String(r.userId)),canManageSharing:Boolean(r.sharing)}));
}
function selfAccounts(source:string,target:string) {
 return (getDatabase().prepare('SELECT a.user_id AS userId,a.self_member_id AS memberId,u.display_name AS displayName FROM account_preferences a JOIN users u ON u.id=a.user_id WHERE a.self_member_id IN (?,?) ORDER BY a.user_id').all(source,target) as Array<{userId:string;memberId:string;displayName:string}>).map(r=>({...r,usable:isUsableMemberAccount(r.userId)}));
}
function idle(source:string,target:string) {
 const db=getDatabase();
 if(db.prepare("SELECT 1 FROM report_duplicate_operations WHERE member_id IN (?,?) AND status='running' LIMIT 1").get(source,target)) fail(409,'所选档案正在执行重复检测，请稍后重试');
 if(storageMigrationPaused() || getJobRunnerStatus().busy || isStorageMaintenanceActive() || isStorageNormalizationActive() || isStorageExportActive() || activeStorageRequests()>1) fail(409,'仍有请求或后台任务执行中，请稍后重试');
 if(db.prepare("SELECT 1 FROM processing_jobs j JOIN reports r ON r.id=j.report_id WHERE r.member_id IN (?,?) AND j.status IN ('queued','processing') LIMIT 1").get(source,target) || db.prepare("SELECT 1 FROM report_page_appends a JOIN reports r ON r.id=a.report_id WHERE r.member_id IN (?,?) AND a.state NOT IN ('complete','ocr_only','noop','cancelled') LIMIT 1").get(source,target)) fail(409,'所选档案有未完成的识别或补页任务，请完成或取消后重试');
}
function inventory() {
 const db=getDatabase();
 for(const row of db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()) {
  const name=String(row.name);
  if(!/^[a-z_]+$/.test(name)) fail(409,'存在尚未支持的数据库结构，暂不能合并');
  const refs=db.prepare(`PRAGMA foreign_key_list("${name}")`).all().filter(r=>r.table==='health_members');
  if(refs.some(r=>r.from!=='member_id') && !['account_preferences','member_merges'].includes(name)) fail(409,'存在尚未支持的成员关联结构，暂不能合并');
  if(db.prepare(`PRAGMA table_info("${name}")`).all().some(c=>c.name==='member_id') && !knownTables.has(name)) fail(409,'存在尚未支持的成员关联结构，暂不能合并');
 }
}
function fingerprint(source:string,target:string) {
 const db=getDatabase();
 const data:unknown[]=[member(source),member(target),accounts(source),accounts(target),selfAccounts(source,target)];
 for(const name of [...simpleTables,...existingOptionalTables(),...pairTables,'member_permissions','member_permission_versions']) data.push(db.prepare(`SELECT * FROM ${name} WHERE member_id IN (?,?) ORDER BY rowid`).all(source,target));
 data.push(db.prepare('SELECT * FROM account_preferences WHERE self_member_id IN (?,?) OR default_member_id IN (?,?) ORDER BY user_id').all(source,target,source,target));
 return hash(data);
}
function parse(raw:unknown):Input {
 if(!raw || typeof raw!=='object') fail(400,'合并参数无效');
 const x=raw as Input;
 if(typeof x.sourceId!=='string' || typeof x.targetId!=='string' || !x.sourceId || !x.targetId || x.sourceId.length>100 || x.targetId.length>100 || x.sourceId===x.targetId) fail(400,'请选择两个不同成员档案');
 if(!Array.isArray(x.grants) || !x.grants.length || x.grants.length>100 || new Set(x.grants.map(g=>g?.userId)).size!==x.grants.length) fail(400,'请选择有效的最终授权');
 const allowed=new Set([...accounts(x.sourceId),...accounts(x.targetId)].map(a=>String(a.userId)));
 for(const g of x.grants) if(!g || typeof g.userId!=='string' || !allowed.has(g.userId) || !isUsableMemberAccount(g.userId) || !['viewer','manager'].includes(g.permission) || typeof g.canManageSharing!=='boolean' || (g.canManageSharing && g.permission!=='manager')) fail(400,'授权账号或权限无效');
 if(!x.grants.some(g=>g.permission==='manager' && g.canManageSharing)) fail(409,'至少保留一名可管理共享权限的有效管理者');
 const selves=selfAccounts(x.sourceId,x.targetId);
 if(x.selfUserId===undefined && selves.length>1) fail(409,'请明确选择合并后保留的本人账号');
 const selfUserId=x.selfUserId===undefined?(selves[0]?.userId??null):x.selfUserId;
 if(selfUserId!==null && (typeof selfUserId!=='string' || !selves.some(a=>a.userId===selfUserId && a.usable))) fail(400,'本人账号无效或不可用，请重新选择');
 if(selfUserId!==null && !x.grants.some(g=>g.userId===selfUserId)) fail(409,'必须保留本人关联账号的访问权限');
 if(!x.choices || fields.some(f=>!['source','target'].includes(x.choices[f]))) fail(400,'请确认基本信息保留方式');
 return {sourceId:x.sourceId,targetId:x.targetId,selfUserId,grants:x.grants.map(g=>({userId:g.userId,permission:g.permission,canManageSharing:g.canManageSharing})).sort((a,b)=>a.userId.localeCompare(b.userId)),choices:Object.fromEntries(fields.map(f=>[f,x.choices[f]])) as Choices};
}
export function listMergeCandidates(user:RequestUser, query:{q?:unknown;page?:unknown}={}) {
 requireMergeAdministrator(user);const page=Number(query.page||1);const q=typeof query.q==='string'?query.q.trim():'';
 if(!Number.isSafeInteger(page)||page<1||page>10000||q.length>80) fail(400,'查询参数无效');
 const db=getDatabase();const where="m.deleted_at IS NULL AND (m.display_name LIKE ? ESCAPE '\\' OR m.id=?)";
 const term='%'+q.replace(/[\\%_]/g,'\\$&')+'%';
 const items=db.prepare(`SELECT m.id,m.display_name AS displayName,m.created_at AS createdAt,u.display_name AS creatorName,(SELECT COUNT(*) FROM reports r WHERE r.member_id=m.id) AS reportCount,(SELECT u2.display_name FROM account_preferences a JOIN users u2 ON u2.id=a.user_id WHERE a.self_member_id=m.id LIMIT 1) AS selfName FROM health_members m JOIN users u ON u.id=m.created_by WHERE ${where} ORDER BY m.created_at DESC,m.id LIMIT 20 OFFSET ?`).all(term,q,(page-1)*20);
 return {items,total:Number(db.prepare(`SELECT COUNT(*) AS n FROM health_members m WHERE ${where}`).get(term,q)!.n),page};
}
export function getMergeSelection(user:RequestUser, sourceId:string,targetId:string) {
 requireMergeAdministrator(user);if(sourceId===targetId) fail(400,'请选择两个不同档案');
 return {source:member(sourceId),target:member(targetId),sourceAccounts:accounts(sourceId),targetAccounts:accounts(targetId),selfAccounts:selfAccounts(sourceId,targetId)};
}
export function previewMemberMerge(user:RequestUser, raw:unknown) {
 requireMergeAdministrator(user);const input=parse(raw);inventory();idle(input.sourceId,input.targetId);
 for(const [k,p] of plans) if(p.expires<Date.now()) plans.delete(k);
 if(plans.size>=100) fail(429,'预览请求过多，请稍后重试');
 const token=randomBytes(32).toString('base64url'), expires=Date.now()+10*60000;
 plans.set(token,{actorId:user.id,expires,input,fingerprint:fingerprint(input.sourceId,input.targetId)});
 const db=getDatabase();
 return {token,expiresAt:new Date(expires).toISOString(),sourceId:input.sourceId,targetId:input.targetId,resolvedFields:Object.fromEntries(fields.map(f=>[f,member(input.choices[f]==='source'?input.sourceId:input.targetId)[f]])),reportCount:Number(db.prepare('SELECT COUNT(*) AS n FROM reports WHERE member_id=?').get(input.sourceId)!.n),grants:input.grants,selfResolution:{retained:selfAccounts(input.sourceId,input.targetId).find(a=>a.userId===input.selfUserId)??null,released:selfAccounts(input.sourceId,input.targetId).filter(a=>a.userId!==input.selfUserId)},warning:'目标档案获授权账号将可访问迁入的全部报告。未保留的来源账号将失去访问权限。成功后不支持一键拆分。'};
}
export function getMemberMerge(user:RequestUser,id:string) {
 requireMergeAdministrator(user);const row=getDatabase().prepare('SELECT id,source_id AS sourceId,target_id AS targetId,report_count AS reportCount,created_at AS createdAt FROM member_merges WHERE id=? AND actor_id=?').get(id,user.id) as {id:string;sourceId:string;targetId:string;reportCount:number;createdAt:string}|undefined;
 if(!row) fail(404,'未找到合并记录');return {...row,status:'completed'};
}
export function executeMemberMerge(user:RequestUser,token:unknown) {
 requireMergeAdministrator(user);if(typeof token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(token)) fail(400,'合并凭证无效');
 const id=hash(token),db=getDatabase();
 if(db.prepare('SELECT 1 FROM member_merges WHERE id=? AND actor_id=?').get(id,user.id)) return getMemberMerge(user,id);
 const plan=plans.get(token);if(!plan||plan.actorId!==user.id||plan.expires<Date.now()) fail(409,'预览已失效，请重新核对');
 const input=parse(plan.input),{sourceId:source,targetId:target}=input;
 inventory();idle(source,target);
 if(fingerprint(source,target)!==plan.fingerprint) fail(409,'档案或授权已变化，请重新预览');
 // Synchronous backup and transaction: no event-loop yield between idle check and commit.
 // Recheck inside BEGIN IMMEDIATE also catches writes made by another SQLite connection.
 const backup=createBackup(user);
 runInTransaction(db,()=>{
  if(fingerprint(source,target)!==plan.fingerprint) fail(409,'备份期间档案发生变化，请重新预览');
  idle(source,target);
  const before=Number(db.prepare('SELECT COUNT(*) AS n FROM reports WHERE member_id IN (?,?)').get(source,target)!.n);
  const sourceCount=Number(db.prepare('SELECT COUNT(*) AS n FROM reports WHERE member_id=?').get(source)!.n);
  const a=member(source),b=member(target);
  for(const table of [...existingOptionalTables(),...simpleTables]) db.prepare(`UPDATE ${table} SET member_id=? WHERE member_id=?`).run(target,source);
  for(const table of pairTables) {
   const info=db.prepare(`PRAGMA table_info(${table})`).all();
   const cols=info.map(c=>String(c.name));
   const keys=info.filter(c=>Number(c.pk)>0).sort((a,b)=>Number(a.pk)-Number(b.pk)).map(c=>String(c.name));
   if(!keys.length) fail(409,'成员关联结构缺少唯一键，已回滚');
   db.prepare(`INSERT INTO ${table} (${cols.join(',')}) SELECT ${cols.map(c=>c==='member_id'?'?':c).join(',')} FROM ${table} WHERE member_id=? ON CONFLICT(${keys.join(',')}) DO NOTHING`).run(target,source);
   db.prepare(`DELETE FROM ${table} WHERE member_id=?`).run(source);
  }
  db.prepare('DELETE FROM member_permissions WHERE member_id IN (?,?)').run(source,target);
  for(const g of input.grants) db.prepare('INSERT INTO member_permissions(member_id,user_id,permission,can_manage_sharing,granted_by) VALUES(?,?,?,?,?)').run(target,g.userId,g.permission,Number(g.canManageSharing),user.id);
  db.prepare("UPDATE account_preferences SET self_member_id=NULL,self_profile_choice='skipped' WHERE self_member_id IN (?,?)").run(source,target);
  if(input.selfUserId!==null) db.prepare("UPDATE account_preferences SET self_member_id=?,self_profile_choice='created' WHERE user_id=?").run(target,input.selfUserId);
  db.prepare(`UPDATE account_preferences SET default_member_id=CASE WHEN EXISTS(SELECT 1 FROM member_permissions p WHERE p.member_id=? AND p.user_id=account_preferences.user_id) THEN ? ELSE NULL END WHERE default_member_id IN (?,?)`).run(target,target,source,target);
  for(const f of fields) db.prepare(`UPDATE health_members SET ${f}=? WHERE id=?`).run((input.choices[f]==='source'?a:b)[f],target);
  db.prepare('UPDATE health_members SET blood_type_source_report_id=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(target);
  db.prepare('UPDATE health_members SET deleted_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(source);
  for(const mid of [source,target]) db.prepare('INSERT INTO member_permission_versions(member_id,version) VALUES(?,1) ON CONFLICT(member_id) DO UPDATE SET version=version+1').run(mid);
  // Cache/ownership changes invalidate pending UI edits while preserving report IDs and files.
  db.prepare('UPDATE reports SET source_version=source_version+1,updated_at=CURRENT_TIMESTAMP WHERE member_id=?').run(target);
  discardMemberTrendSnapshots([source,target],db);
  rebuildMorphologyTrackingForMember(target);
  if(Number(db.prepare('SELECT COUNT(*) AS n FROM reports WHERE member_id=?').get(target)!.n)!==before || db.prepare('PRAGMA foreign_key_check').get()) fail(409,'合并校验未通过，已回滚');
  db.prepare('INSERT INTO member_merges(id,actor_id,source_id,target_id,backup_id,report_count) VALUES(?,?,?,?,?,?)').run(id,user.id,source,target,backup.id,sourceCount);
 });
 plans.delete(token);return getMemberMerge(user,id);
}
