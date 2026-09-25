import {getDatabase,runInTransaction} from '../database/client';
import {createError} from 'h3';
import {assertMemberManage,assertMemberAccess} from './member.service';
import {createId} from '../utils/identifier';
import type {RequestUser} from '../domain/request-user';

type Identity={id:string;memberId:string;reportId:string;reportTitle:string;version:number;institution:string;reportNumber:string;examinationType:string;occurredAt:string|null;timeKind:string;specimen:string;method:string};
const select=`SELECT e.id,r.member_id AS memberId,e.report_id AS reportId,r.title AS reportTitle,r.source_version AS version,
 e.institution,e.report_number AS reportNumber,e.examination_type AS examinationType,e.occurred_at AS occurredAt,
 e.time_kind AS timeKind,e.specimen,e.method FROM report_examinations e JOIN reports r ON r.id=e.report_id
 WHERE r.status<>'trashed' AND r.deleted_at IS NULL`;
const normalized=(value:string)=>value.normalize('NFKC').trim().replace(/\s+/g,'').toLowerCase();
export function listExaminationRelationships(user:RequestUser,reportId:string){
 const db=getDatabase();
 const report=db.prepare("SELECT member_id FROM reports WHERE id=? AND status<>'trashed' AND deleted_at IS NULL").get(reportId) as {member_id:string}|undefined;
 if(!report)throw createError({statusCode:404,statusMessage:'报告不存在'});
 assertMemberAccess(user,report.member_id);
 const relatedExaminations=db.prepare(`${select} AND r.member_id=? ORDER BY e.occurred_at,e.id`).all(report.member_id) as Identity[];
 const own=relatedExaminations.filter(e=>e.reportId===reportId),relationships:Array<{leftId:string;rightId:string;decision:'same'|'different'|'automatic'}>=[];
 for(const a of own)for(const b of relatedExaminations){
  if(a.id===b.id)continue;
  const [left,right]=[a.id,b.id].sort();
  const explicit=db.prepare('SELECT decision FROM examination_duplicate_decisions WHERE left_id=? AND right_id=?').get(left,right) as {decision:'same'|'different'}|undefined;
  if(explicit || hasStrongExaminationIdentity(a,b))relationships.push({leftId:a.id,rightId:b.id,decision:explicit?.decision || 'automatic'});
 }
 return {relatedExaminations,relationships};
}
export function hasStrongExaminationIdentity(a:Identity,b:Identity){
 return a.memberId===b.memberId && !!a.occurredAt && a.occurredAt===b.occurredAt && a.timeKind===b.timeKind
  && ['institution','reportNumber','examinationType'].every(key=>{
   const k=key as 'institution'|'reportNumber'|'examinationType';return !!normalized(a[k]) && normalized(a[k])===normalized(b[k]);
  }) && normalized(a.specimen)===normalized(b.specimen) && normalized(a.method)===normalized(b.method);
}
/** Read-time resolution includes only active sources; no cached primary source can disappear in trash. */
export function examinationDuplicateResolver(){
 const db=getDatabase(),identities=new Map((db.prepare(select).all() as Identity[]).map(e=>[e.id,e]));
 const decisions=new Map((db.prepare('SELECT left_id,right_id,decision FROM examination_duplicate_decisions').all() as Array<{left_id:string;right_id:string;decision:string}>).map(d=>[JSON.stringify([d.left_id,d.right_id]),d.decision]));
 return (left:string,right:string)=>{
  const a=identities.get(left),b=identities.get(right);
  if(!a || !b || a.memberId!==b.memberId)return false;
  if(left===right)return true;
  const decision=decisions.get(JSON.stringify([left,right].sort()));
  return decision?decision==='same':hasStrongExaminationIdentity(a,b);
 };
}
export function setExaminationDuplicateDecision(user:RequestUser,input:{leftId:string;rightId:string;leftVersion:number;rightVersion:number;decision:'same'|'different'}){
 if(!input || !['same','different'].includes(input.decision) || typeof input.leftId!=='string' || typeof input.rightId!=='string' || input.leftId===input.rightId || !Number.isSafeInteger(input.leftVersion) || !Number.isSafeInteger(input.rightVersion))throw createError({statusCode:400,statusMessage:'检查关联参数无效'});
 const db=getDatabase();
 runInTransaction(db,()=>{
  const a=db.prepare(`${select} AND e.id=?`).get(input.leftId) as Identity|undefined;
  const b=db.prepare(`${select} AND e.id=?`).get(input.rightId) as Identity|undefined;
  if(!a || !b)throw createError({statusCode:404,statusMessage:'检查不存在'});
  assertMemberManage(user,a.memberId);assertMemberManage(user,b.memberId);
  if(a.memberId!==b.memberId)throw createError({statusCode:400,statusMessage:'不能关联不同成员的检查'});
  if(a.version!==input.leftVersion || b.version!==input.rightVersion)throw createError({statusCode:409,statusMessage:'检查来源已修改，请重新核对'});
  const [left,right]=[a.id,b.id].sort();
  db.prepare(`INSERT INTO examination_duplicate_decisions(left_id,right_id,decision,actor_user_id) VALUES(?,?,?,?)
   ON CONFLICT(left_id,right_id) DO UPDATE SET decision=excluded.decision,actor_user_id=excluded.actor_user_id,updated_at=CURRENT_TIMESTAMP`).run(left,right,input.decision,user.id);
  for(const reportId of new Set([a.reportId,b.reportId])){
   db.prepare('UPDATE reports SET source_version=source_version+1 WHERE id=?').run(reportId);
   db.prepare('UPDATE report_examination_state SET version=version+1 WHERE report_id=?').run(reportId);
  }
  db.prepare("INSERT INTO audit_logs(id,actor_user_id,action,target_type,target_id,detail_json) VALUES(?,?,'report.examination.duplicate','report',?,'{}')").run(createId('audit'),user.id,a.reportId);
 });
 return {saved:true};
}
