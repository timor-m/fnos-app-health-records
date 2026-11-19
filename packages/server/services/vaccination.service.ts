import { associateMedicationSelections } from './health-record-association.service';
import { trashVaccination } from './health-record-trash.service';
import { createError } from 'h3';
import { getDatabase, runInTransaction } from '../database/client';
import type { RequestUser } from '../domain/request-user';
import type { VaccinationEntry } from '../../shared/health-categories';
import { assertMemberAccess, assertMemberManage } from './member.service';
import { assertOccurredDate, dateInput, textInput, hasInput } from './health-event-input';
import { createId } from '../utils/identifier';
import { runHealthWorkflowRequest } from './health-workflow-request.service';
import { createReminder } from './records.service';
const columns=`id,member_id AS memberId,vaccine_name AS vaccineName,dose_number AS doseNumber,
 administered_at AS administeredAt,organization_name AS organizationName,manufacturer,lot_number AS lotNumber,
 administration_site AS administrationSite,note,next_due_at AS nextDueAt,reminder_id AS reminderId,
 completed_reminder_id AS completedReminderId,source_report_id AS sourceReportId,source_fact_id AS sourceFactId,revision,deleted_at AS deletedAt`;
function fail(statusCode:number,statusMessage:string):never {throw createError({statusCode,statusMessage});}
function row(id:string) {
 const value=getDatabase().prepare(`SELECT ${columns} FROM health_vaccinations WHERE id=? AND deleted_at IS NULL`).get(id) as VaccinationEntry|undefined;
 if(!value)fail(404,'接种信息不存在');return value;
}
export function getVaccination(user:RequestUser,id:string):VaccinationEntry {
 const value=row(id);assertMemberAccess(user,value.memberId);const db=getDatabase();
 const reminder=value.reminderId ? db.prepare('SELECT status FROM reminders WHERE id=? AND member_id=?').get(value.reminderId,value.memberId) as {status:'pending'|'completed'|'dismissed'}|undefined : undefined;
 const next=value.reminderId ? db.prepare('SELECT id FROM health_vaccinations WHERE completed_reminder_id=? AND member_id=? AND deleted_at IS NULL').get(value.reminderId,value.memberId) as {id:string}|undefined : undefined;
 return {...value,reminderStatus:reminder?.status||null,nextVaccinationId:next?.id||null};
}
export function listVaccinations(user:RequestUser,memberId:string){assertMemberAccess(user,memberId);return getDatabase().prepare(`SELECT ${columns},
 (SELECT r.status FROM reminders r WHERE r.id=health_vaccinations.reminder_id AND r.member_id=health_vaccinations.member_id) AS reminderStatus,
 (SELECT v.id FROM health_vaccinations v WHERE v.completed_reminder_id=health_vaccinations.reminder_id AND v.member_id=health_vaccinations.member_id AND v.deleted_at IS NULL LIMIT 1) AS nextVaccinationId
 FROM health_vaccinations WHERE member_id=? AND deleted_at IS NULL ORDER BY administered_at DESC,id`).all(memberId) as VaccinationEntry[];}
function fields(memberId:string,input:Record<string,unknown>,previous?:VaccinationEntry){
 const value=(key:keyof VaccinationEntry)=>hasInput(input,key)?input[key]:previous?.[key];
 const vaccineName=textInput(value('vaccineName'),'疫苗名称',180,true)!;
 const administeredAt=dateInput(value('administeredAt'),'接种时间');if(!administeredAt)fail(400,'请填写实际接种时间');assertOccurredDate(administeredAt,'接种时间');
 const nextDueAt=dateInput(value('nextDueAt'),'下一剂日期');if(nextDueAt && nextDueAt.slice(0,10)<administeredAt.slice(0,10))fail(400,'下一剂日期不能早于本次接种');
 const sourceReportId=textInput(value('sourceReportId'),'来源报告',100);
 const sourceFactId=textInput(value('sourceFactId'),'来源接种条目',100);
 if(sourceFactId && !sourceReportId)fail(400,'接种条目缺少来源报告');
 const db=getDatabase();
 if(sourceReportId && !db.prepare("SELECT 1 FROM reports WHERE id=? AND member_id=? AND status<>'trashed' AND deleted_at IS NULL").get(sourceReportId,memberId))fail(400,'接种凭证不属于当前成员');
 if(sourceFactId && !db.prepare('SELECT 1 FROM vaccination_records WHERE id=? AND report_id=? AND is_deleted=0').get(sourceFactId,sourceReportId))fail(400,'来源接种条目不存在');
 return {vaccineName,administeredAt,nextDueAt,sourceReportId,sourceFactId,
  doseNumber:textInput(value('doseNumber'),'剂次',80),organizationName:textInput(value('organizationName'),'接种机构',180),
  manufacturer:textInput(value('manufacturer'),'生产厂家',180),lotNumber:textInput(value('lotNumber'),'批号',120),
  administrationSite:textInput(value('administrationSite'),'接种部位',120),note:textInput(value('note'),'说明',2000)};
}
function audit(user:RequestUser,id:string,action:string){getDatabase().prepare(`INSERT INTO audit_logs(id,actor_user_id,action,target_type,target_id,detail_json) VALUES(?,?,?,'vaccination',?,'{}')`).run(createId('audit'),user.id,action,id);}
function saveReminder(user:RequestUser,memberId:string,value:ReturnType<typeof fields>,previous?:VaccinationEntry){
 const db=getDatabase();
 if(previous?.reminderId && db.prepare('SELECT 1 FROM health_vaccinations WHERE completed_reminder_id=? AND deleted_at IS NULL').get(previous.reminderId)){
  if(value.nextDueAt!==previous.nextDueAt)fail(409,'下一剂已登记，请在该剂接种详情中安排后续提醒');
  return previous.reminderId;
 }
 if(previous?.reminderId && value.nextDueAt===previous.nextDueAt){
  if(value.vaccineName!==previous.vaccineName)db.prepare('UPDATE reminders SET title=? WHERE id=? AND member_id=?').run(`下一剂接种：${value.vaccineName}`,previous.reminderId,memberId);
  return previous.reminderId;
 }
 const oldStatus=previous?.reminderId ? db.prepare('SELECT status FROM reminders WHERE id=? AND member_id=?').get(previous.reminderId,memberId) as {status:string}|undefined : undefined;
 if(previous?.reminderId)db.prepare("UPDATE reminders SET status='dismissed' WHERE id=? AND member_id=? AND status='pending'").run(previous.reminderId,memberId);
 if(!value.nextDueAt)return null;
 const id=createReminder(user,{memberId,title:`下一剂接种：${value.vaccineName}`,dueAt:value.nextDueAt}).id;
 if(previous?.nextDueAt===value.nextDueAt && oldStatus?.status==='dismissed')db.prepare("UPDATE reminders SET status='dismissed' WHERE id=? AND member_id=?").run(id,memberId);
 return id;
}
export function createVaccination(user:RequestUser,input:Record<string,unknown>){
 const memberId=textInput(input.memberId,'成员',100,true)!;assertMemberManage(user,memberId);
 return runHealthWorkflowRequest(user,memberId,'vaccination.create',input,()=>{
 const value=fields(memberId,input);const db=getDatabase();const id=createId('vaccination');
 runInTransaction(db,()=>{
  if(value.sourceFactId && db.prepare('SELECT 1 FROM health_vaccinations WHERE member_id=? AND source_report_id=? AND source_fact_id=? AND deleted_at IS NULL').get(memberId,value.sourceReportId,value.sourceFactId))fail(409,'这条接种信息已确认，请查看已有记录');
  const completedReminderId=textInput(input.completedReminderId,'来源接种提醒',100);
  if(completedReminderId){const previous=db.prepare(`SELECT v.administered_at FROM health_vaccinations v JOIN reminders r ON r.id=v.reminder_id WHERE r.id=? AND r.member_id=? AND v.member_id=? AND r.status='pending' AND v.deleted_at IS NULL`).get(completedReminderId,memberId,memberId);if(!previous)fail(409,'接种提醒已变化，请刷新后重试');if(value.administeredAt.slice(0,10)<String(previous.administered_at).slice(0,10))fail(400,'本次接种不能早于前一剂');}
  const reminderId=saveReminder(user,memberId,value);
  db.prepare(`INSERT INTO health_vaccinations(id,member_id,vaccine_name,dose_number,administered_at,organization_name,manufacturer,lot_number,administration_site,note,next_due_at,reminder_id,source_report_id,source_fact_id,created_by,completed_reminder_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
   .run(id,memberId,value.vaccineName,value.doseNumber,value.administeredAt,value.organizationName,value.manufacturer,value.lotNumber,value.administrationSite,value.note,value.nextDueAt,reminderId,value.sourceReportId,value.sourceFactId,user.id,completedReminderId);
  if(completedReminderId)db.prepare("UPDATE reminders SET status='completed' WHERE id=? AND member_id=?").run(completedReminderId,memberId);
  associateMedicationSelections(user,{kind:'vaccination',id},input.relatedRecords,input.processId);
  audit(user,id,'vaccination.create');
 });return getVaccination(user,id);
 },saved=>getVaccination(user,saved.id));
}
export function updateVaccination(user:RequestUser,id:string,input:Record<string,unknown>){
 const previous=row(id);assertMemberManage(user,previous.memberId);
 if(input.memberId!==undefined && input.memberId!==previous.memberId)fail(400,'不能修改接种所属成员');
 if(input.completedReminderId!==undefined && input.completedReminderId!==previous.completedReminderId)fail(400,'不能修改已关联的接种提醒');
 if(input.revision!==previous.revision)fail(409,'接种信息已更新，请刷新后重试');
 const value=fields(previous.memberId,input,previous);const db=getDatabase();
 if(previous.completedReminderId){const source=db.prepare('SELECT administered_at FROM health_vaccinations WHERE reminder_id=? AND member_id=?').get(previous.completedReminderId,previous.memberId);if(source && value.administeredAt.slice(0,10)<String(source.administered_at).slice(0,10))fail(400,'本次接种不能早于前一剂');}
 if(previous.reminderId){const next=db.prepare('SELECT administered_at FROM health_vaccinations WHERE completed_reminder_id=? AND member_id=? AND deleted_at IS NULL').get(previous.reminderId,previous.memberId);if(next && value.administeredAt.slice(0,10)>String(next.administered_at).slice(0,10))fail(400,'本次接种不能晚于已保存的后一剂');}

 runInTransaction(db,()=>{
  if(value.sourceFactId && db.prepare('SELECT 1 FROM health_vaccinations WHERE member_id=? AND source_report_id=? AND source_fact_id=? AND id<>? AND deleted_at IS NULL').get(previous.memberId,value.sourceReportId,value.sourceFactId,id))fail(409,'这条接种信息已确认');
  const reminderId=saveReminder(user,previous.memberId,value,previous);
  const result=db.prepare(`UPDATE health_vaccinations SET vaccine_name=?,dose_number=?,administered_at=?,organization_name=?,manufacturer=?,lot_number=?,administration_site=?,note=?,next_due_at=?,reminder_id=?,source_report_id=?,source_fact_id=?,revision=revision+1,updated_at=CURRENT_TIMESTAMP WHERE id=? AND revision=?`)
   .run(value.vaccineName,value.doseNumber,value.administeredAt,value.organizationName,value.manufacturer,value.lotNumber,value.administrationSite,value.note,value.nextDueAt,reminderId,value.sourceReportId,value.sourceFactId,id,previous.revision);
  if(!result.changes)fail(409,'接种信息已更新，请刷新后重试');associateMedicationSelections(user,{kind:'vaccination',id},input.relatedRecords,input.processId);audit(user,id,'vaccination.update');
 });return getVaccination(user,id);
}
export function deleteVaccination(user:RequestUser,id:string,input:Record<string,unknown>){
 return trashVaccination(user,id,input);
}
