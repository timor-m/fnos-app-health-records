import { createError } from 'h3';
import { getDatabase,runInTransaction } from '../database/client';
import type { RequestUser } from '../domain/request-user';
import { assertMemberAccess } from './member.service';

export function getAccountPreferences(user: RequestUser) {
 if (!user.authenticated) throw createError({statusCode:401,statusMessage:'请先登录'});
 const db=getDatabase();
 if(!db.prepare('SELECT 1 FROM account_preferences WHERE user_id=?').get(user.id)) db.prepare('INSERT OR IGNORE INTO account_preferences(user_id) VALUES (?)').run(user.id);
 return db.prepare(`SELECT self_member_id AS selfMemberId,self_profile_choice AS selfProfileChoice,
 default_member_id AS defaultMemberId FROM account_preferences WHERE user_id=?`).get(user.id);
}
export function updateAccountPreferences(user: RequestUser, input: Record<string,unknown>) {
 if(!input || typeof input!=='object' || Array.isArray(input)) throw createError({statusCode:400,statusMessage:'账号偏好格式无效'});
 getAccountPreferences(user);
 runInTransaction(getDatabase(),()=>{
 if(input.selfProfileChoice === 'skipped') getDatabase().prepare("UPDATE account_preferences SET self_profile_choice='skipped' WHERE user_id=? AND self_member_id IS NULL").run(user.id);
 if(input.defaultMemberId !== undefined) {
  if(input.defaultMemberId !== null && typeof input.defaultMemberId !== 'string') throw createError({statusCode:400,statusMessage:'请选择有效档案'});
  if(input.defaultMemberId) assertMemberAccess(user,input.defaultMemberId as string);
  getDatabase().prepare('UPDATE account_preferences SET default_member_id=? WHERE user_id=?').run(input.defaultMemberId as string|null,user.id);
 }
 if(input.selfMemberId !== undefined) {
  if(typeof input.selfMemberId !== 'string') throw createError({statusCode:400,statusMessage:'请选择本人档案'});
  assertMemberAccess(user,input.selfMemberId);
  getDatabase().prepare("UPDATE account_preferences SET self_member_id=?,self_profile_choice='created' WHERE user_id=?").run(input.selfMemberId,user.id);
 }
 });
 return getAccountPreferences(user);
}
export function setMemberHidden(user:RequestUser,memberId:string,hidden:unknown) {
 assertMemberAccess(user,memberId);
 if(typeof hidden !== 'boolean') throw createError({statusCode:400,statusMessage:'请指定隐藏或显示'});
 getDatabase().prepare(`INSERT INTO member_user_preferences(user_id,member_id,hidden_at) VALUES (?,?,?)
 ON CONFLICT(user_id,member_id) DO UPDATE SET hidden_at=excluded.hidden_at`).run(user.id,memberId,hidden?new Date().toISOString():null);
 return {memberId,hidden};
}
