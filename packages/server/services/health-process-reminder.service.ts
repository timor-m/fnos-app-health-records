import {createError} from 'h3';
import {getDatabase,runInTransaction} from '../database/client';
import type {RequestUser} from '../domain/request-user';
import type {ProcessRecordRef} from '../../shared/health-process';
import type {HealthProcessSummary} from '../../shared/health-process';
import {processRecordKey,getRecordProcess,linkProcessRecords,processRecord,processRecordRef,recordProcesses} from './health-record-process.service';
import {assertMemberManage} from './member.service';
import {runHealthWorkflowRequest} from './health-workflow-request.service';
import {createId} from '../utils/identifier';

/** Select an existing original without uploading a duplicate or silently replacing a completed result. */
export function completeReminderWithExistingReport(user:RequestUser,reminderId:string,input:Record<string,unknown>){
 const db=getDatabase();const reminder=db.prepare('SELECT member_id AS memberId FROM reminders WHERE id=?').get(reminderId);
 if(!reminder)throw createError({statusCode:404,statusMessage:'提醒不存在'});
 const memberId=String(reminder.memberId);assertMemberManage(user,memberId);
 if(input.memberId!==memberId)throw createError({statusCode:409,statusMessage:'提醒所属成员已变化，请重新核对'});
 const read=()=>{
  const context=reminderRecordContext(user,reminderId,memberId);
  const row=db.prepare('SELECT status FROM reminders WHERE id=? AND member_id=?').get(reminderId,memberId);
  const target=processRecordRef(input.record);
  if(row?.status!=='completed'||!context.completedRecord||context.completedRecord.id!==target.id||!['report','medication_document'].includes(context.completedRecord.kind))throw createError({statusCode:409,statusMessage:'复查资料已变化，请刷新后核对'});
  return {id:reminderId,memberId,status:'completed',completedRecord:context.completedRecord,processId:recordProcesses(user,target)[0]?.id||null};
 };
 return runHealthWorkflowRequest(user,memberId,'reminder.complete-record',{...input,reminderId},()=>runInTransaction(db,()=>{
  const context=validateRecordReminder(user,reminderId,memberId);
  if(context.completedRecord)throw createError({statusCode:409,statusMessage:'该提醒已有复查资料，请刷新后查看'});
  const target=processRecord(user,processRecordRef(input.record));
  if(target.memberId!==memberId||target.category!=='report'||target.ref.kind!=='report')throw createError({statusCode:400,statusMessage:'请选择当前成员的报告'});
  if(context.relatedRecord&&target.ref.id===context.relatedRecord.id&&['report','medication_document'].includes(context.relatedRecord.kind))throw createError({statusCode:400,statusMessage:'不能将来源报告作为本次复查结果'});
  if(input.processId!==undefined){
   if(typeof input.processId!=='string'||!input.processId)throw createError({statusCode:400,statusMessage:'健康历程无效'});
   const process=getRecordProcess(user,input.processId);
   if(process.memberId!==memberId||!context.relatedRecord||!context.processes.some(item=>item.id===process.id))throw createError({statusCode:409,statusMessage:'提醒已不属于当前历程，请刷新后核对'});
   if(process.fingerprint!==input.fingerprint||process.editToken!==input.editToken)throw createError({statusCode:409,statusMessage:'历程记录已变化，请重新打开后选择'});
  }
  completeReminderWithRecord(user,reminderId,memberId,target.ref);
  // A reminder without an original anchor can still retain its selected result.
  if(!context.relatedRecord)db.prepare('INSERT INTO health_record_reminders(reminder_id,member_id,anchor_kind,anchor_id,completed_kind,completed_id) VALUES(?,?,?,?,?,?) ON CONFLICT(reminder_id) DO UPDATE SET completed_kind=excluded.completed_kind,completed_id=excluded.completed_id').run(reminderId,memberId,target.ref.kind,target.ref.id,target.ref.kind,target.ref.id);
  db.prepare("INSERT INTO audit_logs(id,actor_user_id,action,target_type,target_id,detail_json) VALUES(?,?,'reminder.status','reminder',?,?)").run(createId('audit'),user.id,reminderId,JSON.stringify({status:'completed',memberId,linkedRecord:true}));
  return read();
 }),()=>read());
}
/** Plans attach to a real record, so process merge/split never leaves a stale process ID. */
export function reminderRecordContext(user:RequestUser,reminderId:string,memberId:string,processes?:Map<string,HealthProcessSummary[]>|(()=>Map<string,HealthProcessSummary[]>)) {
 const db=getDatabase();const plan=db.prepare('SELECT * FROM health_record_reminders WHERE reminder_id=? AND member_id=?').get(reminderId,memberId);
 const reminder=db.prepare('SELECT report_id FROM reminders WHERE id=? AND member_id=?').get(reminderId,memberId);
 const vaccine=db.prepare('SELECT id FROM health_vaccinations WHERE reminder_id=? AND member_id=? AND deleted_at IS NULL').get(reminderId,memberId);
 const anchor=plan?{kind:plan.anchor_kind,id:plan.anchor_id}:vaccine?{kind:'vaccination',id:vaccine.id}:reminder?.report_id?{kind:'report',id:reminder.report_id}:null;
 let relatedRecord:ProcessRecordRef|null=null;let completedRecord:ProcessRecordRef|null=null;
 if(anchor)try{const record=processRecord(user,processRecordRef(anchor));if(record.memberId===memberId)relatedRecord=record.ref;}catch(error){if((error as {statusCode?:number}).statusCode!==404)throw error;}
 if(plan?.completed_id)try{const record=processRecord(user,processRecordRef({kind:plan.completed_kind,id:plan.completed_id}));if(record.memberId===memberId)completedRecord=record.ref;}catch(error){if((error as {statusCode?:number}).statusCode!==404)throw error;}
 return {relatedRecord,completedRecord,processes:relatedRecord?(processes?(typeof processes==='function'?processes():processes).get(processRecordKey(relatedRecord))||[]:recordProcesses(user,relatedRecord)):[]};
}
export function saveReminderRecord(user:RequestUser,reminderId:string,memberId:string,input:unknown){
 if(input===undefined)return;const record=processRecord(user,processRecordRef(input));if(record.memberId!==memberId)throw createError({statusCode:403,statusMessage:'提醒来源不属于当前成员'});
 getDatabase().prepare('INSERT INTO health_record_reminders(reminder_id,member_id,anchor_kind,anchor_id) VALUES(?,?,?,?)').run(reminderId,memberId,record.ref.kind,record.ref.id);
}
export function validateRecordReminder(user:RequestUser,reminderId:string,memberId:string){
 const db=getDatabase();const reminder=db.prepare('SELECT member_id AS memberId,status FROM reminders WHERE id=?').get(reminderId);
 if(!reminder||reminder.memberId!==memberId)throw createError({statusCode:400,statusMessage:'复查提醒不属于当前成员'});
 if(reminder.status==='dismissed')throw createError({statusCode:409,statusMessage:'此提醒已忽略，请先恢复提醒再记录复查'});
 if(db.prepare('SELECT 1 FROM health_vaccinations WHERE reminder_id=? AND member_id=? AND deleted_at IS NULL').get(reminderId,memberId))throw createError({statusCode:400,statusMessage:'请通过下一剂接种填写实际接种信息'});
 return reminderRecordContext(user,reminderId,memberId);
}
export function completeReminderWithRecord(user:RequestUser,reminderId:string,memberId:string,target:ProcessRecordRef){
 const db=getDatabase();const context=validateRecordReminder(user,reminderId,memberId);
 if(context.relatedRecord){
 linkProcessRecords(user,target,[context.relatedRecord]);
 db.prepare('INSERT INTO health_record_reminders(reminder_id,member_id,anchor_kind,anchor_id,completed_kind,completed_id) VALUES(?,?,?,?,?,?) ON CONFLICT(reminder_id) DO UPDATE SET completed_kind=COALESCE(health_record_reminders.completed_kind,excluded.completed_kind),completed_id=COALESCE(health_record_reminders.completed_id,excluded.completed_id)')
  .run(reminderId,memberId,context.relatedRecord.kind,context.relatedRecord.id,target.kind,target.id);
 // Recording a follow-up is an explicit phase choice, never a guess from a later date.
 const nodeKind=target.kind==='medication_document'?'report':target.kind;
 db.prepare("UPDATE health_record_process_nodes SET stage_override='followup' WHERE member_id=? AND kind=? AND record_id=?").run(memberId,nodeKind,target.id);
 }
 db.prepare("UPDATE reminders SET status='completed',confirmed_at=COALESCE(confirmed_at,CURRENT_TIMESTAMP) WHERE id=? AND member_id=?").run(reminderId,memberId);
}
