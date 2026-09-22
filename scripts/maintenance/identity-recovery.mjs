#!/usr/bin/env node
// Offline, explicitly selected identity repair. Never opens the app's default database.
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { resolve } from 'node:path';
const args=process.argv.slice(2);
const option=name=>{const i=args.indexOf(name);return i<0?undefined:args[i+1];};
const required=name=>{const value=option(name);if(!value) throw new Error(`缺少 ${name}`);return value;};
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const output=value=>process.stdout.write(JSON.stringify(value,null,2)+'\n');
const write=(path,value)=>writeFileSync(path,JSON.stringify(value,null,2),{mode:0o600,flag:'wx'});
const dbPath=resolve(required('--database'));
if(!existsSync(dbPath)) throw new Error('数据库不存在');
const mode=args[0];
const apply=mode==='apply'||mode==='undo';
if(apply && !args.includes('--service-stopped')) throw new Error('请停止应用服务，再明确传入 --service-stopped');
const db=new DatabaseSync(dbPath,{readOnly:!apply});db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000');
const permission=(member,user)=>db.prepare('SELECT * FROM member_permissions WHERE member_id=? AND user_id=?').get(member,user)||null;
const usable=id=>Boolean(db.prepare(`SELECT 1 FROM user_identities i WHERE user_id=? AND NOT EXISTS(SELECT 1 FROM identity_recovery_pending p WHERE p.user_id=i.user_id)
 AND (i.provider<>'local' OR EXISTS(SELECT 1 FROM local_accounts a WHERE a.user_id=i.user_id AND a.disabled_at IS NULL))`).get(id));
function manager(member){
 const rows=db.prepare("SELECT user_id FROM member_permissions WHERE member_id=? AND permission='manager' AND can_manage_sharing=1").all(member);
 if(!rows.some(row=>usable(row.user_id))) throw new Error('操作将移除最后可用共享管理者，请先完成管理权转移');
}
function record(change,value){
 if(change.table==='member_permissions') {
  db.prepare('DELETE FROM member_permissions WHERE member_id=? AND user_id=?').run(...change.key);
  if(value) db.prepare('INSERT INTO member_permissions(member_id,user_id,permission,granted_by,granted_at,can_manage_sharing) VALUES(?,?,?,?,?,?)').run(value.member_id,value.user_id,value.permission,value.granted_by,value.granted_at,value.can_manage_sharing||0);
 } else if(change.table==='local_accounts') db.prepare('UPDATE local_accounts SET disabled_at=? WHERE user_id=?').run(value.disabled_at,change.key[0]);
 else if(change.table==='identity_recovery_pending') db.prepare('UPDATE identity_recovery_pending SET mapped_to=?,mapped_at=? WHERE user_id=?').run(value.mapped_to,value.mapped_at,change.key[0]);
 else throw new Error('不支持的变更类型');
}
function current(change){
 if(change.table==='member_permissions') return permission(...change.key);
 if(change.table==='local_accounts') return db.prepare('SELECT disabled_at FROM local_accounts WHERE user_id=?').get(change.key[0])||null;
 if(change.table==='identity_recovery_pending') return db.prepare('SELECT mapped_to,mapped_at FROM identity_recovery_pending WHERE user_id=?').get(change.key[0])||null;
 throw new Error('不支持的变更类型');
}
try {
 if(mode==='pending') {
  output(db.prepare(`SELECT p.user_id AS sourceUserId,p.mapped_to,p.mapped_at,
    (SELECT count(*) FROM member_permissions m WHERE m.user_id=p.user_id) AS memberCount FROM identity_recovery_pending p`).all());
 } else if(mode==='map-plan') {
  const source=required('--source'),target=required('--target');
  if(!usable(target)) throw new Error('目标必须已在当前部署登记且有效，不能选择待映射身份');
  const pending=db.prepare('SELECT mapped_to,mapped_at FROM identity_recovery_pending WHERE user_id=?').get(source);
  if(!pending || pending.mapped_at) throw new Error('源身份不在待映射状态');
  const changes=[];
  for(const row of db.prepare('SELECT * FROM member_permissions WHERE user_id=?').all(source)) {
   if(permission(row.member_id,target)) throw new Error('目标已有该成员授权，请先由档案管理者核实，不能自动覆盖');
   changes.push({table:'member_permissions',key:[row.member_id,target],before:null,after:{...row,user_id:target}});
  }
  changes.push({table:'identity_recovery_pending',key:[source],before:pending,after:{mapped_to:target,mapped_at:new Date().toISOString()}});
  const plan={version:1,database:dbPath,kind:'explicit-identity-map',source,target,sourcePermissions:db.prepare('SELECT * FROM member_permissions WHERE user_id=? ORDER BY member_id').all(source),targetIdentities:db.prepare('SELECT * FROM user_identities WHERE user_id=? ORDER BY id').all(target),changes,createdAt:new Date().toISOString()};
  write(required('--out'),plan);output({confirmation:digest(plan),sourceIdentity:JSON.parse(db.prepare('SELECT source_json FROM identity_recovery_pending WHERE user_id=?').get(source).source_json),targetIdentity:db.prepare('SELECT id,display_name FROM users WHERE id=?').get(target),changes:changes.map(c=>({table:c.table,key:c.key,before:c.before,after:c.after})),notice:'请核实源账号与目标实际持有人；不会修改 created_by、报告归属、密码或自动关联本人。映射后账号自行确认本人及显示偏好。'});
 } else if(mode==='claim-plan') {
  const target=required('--target'),actor=required('--actor'),reason=required('--reason');
  if(!usable(target)||!usable(actor)||!db.prepare('SELECT 1 FROM users WHERE id=? AND is_gateway_admin=1').get(actor)) throw new Error('需要已核实的有效目标账号及系统维护管理员');
  const members=[...new Set(required('--members').split(','))];
  const memberPermissions=[],changes=[];
  for(const member of members) {
   if(!db.prepare('SELECT 1 FROM health_members WHERE id=? AND deleted_at IS NULL').get(member)) throw new Error('指定成员无效');
   const rows=db.prepare('SELECT * FROM member_permissions WHERE member_id=? ORDER BY user_id').all(member);
   if(rows.some(row=>row.permission==='manager'&&row.can_manage_sharing===1&&usable(row.user_id))) throw new Error('该成员已有有效共享管理者，请使用正常共享流程');
   memberPermissions.push({member,rows});
   const before=permission(member,target);
   changes.push({table:'member_permissions',key:[member,target],before,after:{member_id:member,user_id:target,permission:'manager',can_manage_sharing:1,granted_by:actor,granted_at:new Date().toISOString()}});
  }
  const plan={version:1,database:dbPath,kind:'explicit-emergency-claim',target,actor,reason,memberPermissions,changes,createdAt:new Date().toISOString()};
  write(required('--out'),plan);output({confirmation:digest(plan),targetIdentity:db.prepare('SELECT id,display_name FROM users WHERE id=?').get(target),changes,notice:'这不是自动历史归属判定，而是对指定孤立档案的显式应急授权。必须核实持有人与每项档案归属后确认；不提供报告内容。'});
 } else if(mode==='repair-plan') {
  const baselinePath=option('--baseline');
  if(!baselinePath) {output({status:'pending',reason:'没有可信恢复前备份，仅凭管理员角色或姓名不能确认历史授权。请由原账号核实后重新共享。'});process.exitCode=0;}
  else {
   const baseline=new DatabaseSync(resolve(baselinePath),{readOnly:true});
   try {
    const selected=new Set(required('--members').split(','));const user=required('--user');
    const event=db.prepare("SELECT created_at FROM audit_logs WHERE action='backup.identity_rebind' ORDER BY created_at DESC LIMIT 1").get();
    const changes=[],pending=[];
    for(const member of selected) {
     const before=permission(member,user),old=baseline.prepare('SELECT * FROM member_permissions WHERE member_id=? AND user_id=?').get(member,user)||null;
     const later=event && db.prepare("SELECT 1 FROM audit_logs WHERE target_id=? AND action LIKE 'member.permission.%' AND created_at>=?").get(member,event.created_at);
     if(!event || later || !before || Math.abs(Date.parse(before.granted_at+'Z')-Date.parse(event.created_at+'Z'))>2000) {pending.push({member,reason:'缺少可靠恢复事件、时间不一致或存在后续修改，保持待确认'});continue;}
     const after=old?{...old,can_manage_sharing:old.can_manage_sharing||0}:null;
     if(digest(before)!==digest(after)) changes.push({table:'member_permissions',key:[member,user],before,after,classification:old?'role-or-grant-changed':'added-grant'});
    }
    // Account re-enabling requires a separate explicit flag and unchanged restore-time state.
    if(args.includes('--include-account-status')) {
     const old=baseline.prepare('SELECT disabled_at FROM local_accounts WHERE user_id=?').get(user);
     const now=db.prepare('SELECT disabled_at FROM local_accounts WHERE user_id=?').get(user);
     const later=event && db.prepare("SELECT 1 FROM audit_logs WHERE target_id=? AND action IN ('auth.local_account_disabled','auth.local_account_enabled','auth.local_account_deleted') AND created_at>=?").get(user,event.created_at);
     if(old&&now&&event&&!later&&now.disabled_at&&Math.abs(Date.parse(now.disabled_at+'Z')-Date.parse(event.created_at+'Z'))<=2000&&old.disabled_at!==now.disabled_at) changes.push({table:'local_accounts',key:[user],before:now,after:old});
     else pending.push({user,reason:'账号状态无法确认，保持不变'});
    }
    const plan={version:1,database:dbPath,kind:'legacy-repair',changes,pending,createdAt:new Date().toISOString()};
    write(required('--out'),plan);output({confirmation:digest(plan),changes,pending,notice:'差异只说明恢复前后变化，不证明全部由旧恢复造成；执行前逐项核实授权意图。'});
   } finally {baseline.close();}
  }
 } else if(apply) {
  const plan=JSON.parse(readFileSync(required('--plan'),'utf8'));
  if(plan.version!==1 || plan.database!==dbPath || required('--confirm')!==digest(plan)) throw new Error('计划内容、数据库或确认摘要不匹配');
  const actor=required('--actor');
  if(!usable(actor)||!db.prepare('SELECT 1 FROM users WHERE id=? AND is_gateway_admin=1').get(actor)) throw new Error('操作者必须为当前有效系统管理员');
  const changes=mode==='undo'?plan.changes.map(c=>({...c,before:c.after,after:c.before})):plan.changes;
  const backupPath=resolve(required('--backup'));
  if(existsSync(backupPath)) throw new Error('安全备份路径已存在');
  db.exec(`VACUUM INTO '${backupPath.replaceAll("'","''")}'`);
  chmodSync(backupPath,0o600);
  db.exec('BEGIN IMMEDIATE');
  try {
   if(plan.kind==='explicit-emergency-claim' && mode==='apply') {
    if(actor!==plan.actor||!usable(plan.target)) throw new Error('认领操作者或目标身份已失效');
    for(const entry of plan.memberPermissions) if(digest(entry.rows)!==digest(db.prepare('SELECT * FROM member_permissions WHERE member_id=? ORDER BY user_id').all(entry.member))) throw new Error('成员授权已变化，请重新预览');
   }
   if(plan.source && mode==='apply') {
    if(!usable(plan.target) || digest(plan.sourcePermissions)!==digest(db.prepare('SELECT * FROM member_permissions WHERE user_id=? ORDER BY member_id').all(plan.source)) || digest(plan.targetIdentities)!==digest(db.prepare('SELECT * FROM user_identities WHERE user_id=? ORDER BY id').all(plan.target))) throw new Error('源授权或目标身份已变化，请重新预览');
   }
   for(const change of changes) if(digest(current(change))!==digest(change.before)) throw new Error('记录已变化，必须重新生成预览');
   for(const change of changes) record(change,change.after);
   for(const member of new Set(changes.filter(c=>c.table==='member_permissions').map(c=>c.key[0]))) db.prepare('INSERT INTO member_permission_versions(member_id,version) VALUES(?,1) ON CONFLICT(member_id) DO UPDATE SET version=version+1').run(member);
   for(const change of changes) if(change.table==='member_permissions' && !plan.source && !(mode==='undo' && plan.memberPermissions)) manager(change.key[0]);
   const undo={...plan,changes,kind:'applied-repair',appliedAt:new Date().toISOString()};
   write(required('--receipt'),undo);
   db.prepare("INSERT INTO audit_logs(id,actor_user_id,action,target_type,target_id,detail_json) VALUES(?,?,'backup.identity_manual_repair','user',?,?)").run(randomUUID(),actor,plan.target||null,JSON.stringify({kind:plan.kind,undo:mode==='undo',changes:changes.map(c=>({table:c.table,key:c.key}))}));
   db.exec('COMMIT');output({applied:true,undoConfirmation:digest(undo),receipt:option('--receipt')});
  } catch(error){db.exec('ROLLBACK');throw error;}
 } else throw new Error('用法：pending | map-plan | claim-plan | repair-plan | apply | undo；必须显式指定 --database。计划默认只读。');
} finally {db.close();}
