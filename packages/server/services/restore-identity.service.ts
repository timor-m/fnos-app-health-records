import type {DatabaseSync} from "node:sqlite";
import { getDatabase, runInTransaction } from '../database/client';
import { isAdministrator, type RequestUser } from '../domain/request-user';
import { createId } from '../utils/identifier';

export type RestoredLocalCredential = {
 username:string; passwordHash:string; passwordSalt:string; mustChangePassword:number;
 accountId:string;
};
export function captureRestoringAdministratorCredential(user:RequestUser):RestoredLocalCredential|null {
 if(user.provider!=='local') return null;
 const row=getDatabase().prepare(`SELECT id AS accountId,username,password_hash AS passwordHash,password_salt AS passwordSalt,must_change_password AS mustChangePassword
 FROM local_accounts WHERE user_id=? AND disabled_at IS NULL`).get(user.id) as RestoredLocalCredential|undefined;
 if(!row) throw new Error('当前管理员凭据不可用');
 return row;
}
export function rebindRestoredAdministrator(user:RequestUser,credential:RestoredLocalCredential|null=null,strategy:'same'|'cross'='cross',identitySubject?:string,database?:DatabaseSync) {
 if(!user.authenticated||!isAdministrator(user)) throw new Error('恢复需要已验证的管理员');
 if(user.provider==='local'&&!credential) throw new Error('缺少管理员凭据');
 const db=database || getDatabase();
 let targetId=user.id;
 runInTransaction(db,()=>{
  if(strategy==='cross') {
   for(const row of db.prepare('SELECT id FROM users').all() as Array<{id:string}>) {
    const identities=db.prepare('SELECT provider,subject FROM user_identities WHERE user_id=?').all(row.id);
    const local=db.prepare('SELECT username,disabled_at FROM local_accounts WHERE user_id=?').get(row.id);
    db.prepare('INSERT OR IGNORE INTO identity_recovery_pending(user_id,source_json) VALUES (?,?)').run(row.id,JSON.stringify({identities,local}));
   }
   // Retain source credentials and status as source metadata; prevent them authenticating here.
   db.exec("UPDATE local_accounts SET disabled_at=COALESCE(disabled_at,CURRENT_TIMESTAMP),username='pending-'||id; UPDATE user_identities SET subject='pending:'||id");
   targetId=createId('user');
  } else if(credential) {
   const restored=db.prepare('SELECT id FROM local_accounts WHERE user_id=?').get(user.id) as {id:string}|undefined;
   if(restored && restored.id!==credential.accountId) throw new Error('备份管理员身份不一致，必须重新预检');
   if(!restored && db.prepare('SELECT 1 FROM users WHERE id=?').get(user.id)) throw new Error('无法确认备份中的管理员身份');
  }
  db.prepare(`INSERT INTO users(id,display_name,is_gateway_admin) VALUES(?,?,1) ON CONFLICT(id) DO UPDATE SET is_gateway_admin=1`).run(targetId,user.displayName);
  if(credential) {
   const conflict=db.prepare('SELECT user_id FROM local_accounts WHERE username=? AND user_id<>?').get(credential.username,targetId);
   if(conflict) throw new Error('管理员登录名冲突，请先处理身份映射');
   db.prepare(`INSERT INTO local_accounts(id,user_id,username,password_hash,password_salt,must_change_password) VALUES(?,?,?,?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET username=excluded.username,password_hash=excluded.password_hash,password_salt=excluded.password_salt,must_change_password=excluded.must_change_password,disabled_at=NULL`).run(strategy==='same'?credential.accountId:createId('account'),targetId,credential.username,credential.passwordHash,credential.passwordSalt,credential.mustChangePassword);
  }
  if(credential) db.prepare("DELETE FROM user_identities WHERE user_id=? AND provider='local'").run(targetId);
  const subject=credential?.username||identitySubject;
  if(subject) db.prepare(`INSERT INTO user_identities(id,user_id,provider,subject) VALUES(?,?,?,?) ON CONFLICT(provider,subject) DO UPDATE SET user_id=excluded.user_id`).run(createId('identity'),targetId,user.provider,subject);
  db.exec('DELETE FROM auth_sessions; DELETE FROM login_attempts');
  db.prepare(`INSERT INTO audit_logs(id,actor_user_id,action,target_type,target_id,detail_json) VALUES(?,?,'backup.identity_restore','user',?,?)`).run(createId('audit'),targetId,targetId,JSON.stringify({strategy,memberPermissionCount:0}));
 });
 return {userId:targetId,memberPermissionCount:0,disabledLocalAccountCount:0,previousAdminCount:0,strategy};
}
export const rebindRestoredGatewayAdministrator=rebindRestoredAdministrator;
