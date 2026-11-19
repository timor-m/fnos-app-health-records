import {createHash} from 'node:crypto';
import {createError} from 'h3';
import {getDatabase,runInTransaction} from '../database/client';
import type {HealthProcessDetail} from '../../shared/health-process';
import {assertMemberAccess,assertMemberManage} from './member.service';
import {getRecordProcess} from './health-record-process.service';
import {runHealthWorkflowRequest} from './health-workflow-request.service';
import type {RequestUser} from '../domain/request-user';
import type {DoctorContext} from '../../shared/health-process-care';
export function readDoctorContext(user:RequestUser,id:string):DoctorContext{
 return readDoctorContextForProcess(user,getRecordProcess(user,id));
}
/** Reuse an already authorized process snapshot within a read request. */
export function readDoctorContextForProcess(user:RequestUser,process:HealthProcessDetail):DoctorContext{
 assertMemberAccess(user,process.memberId);const id=process.id,db=getDatabase();
 const member=db.prepare('SELECT care_allergies,care_history,care_medications FROM health_members WHERE id=?').get(process.memberId)!;
 const row=db.prepare('SELECT visit_concern FROM health_record_process_metadata WHERE process_id=?').get(id);
 const data={memberId:process.memberId,processId:id,allergies:String(member.care_allergies||''),history:String(member.care_history||''),medications:String(member.care_medications||''),concern:String(row?.visit_concern||'')};
 return {...data,version:createHash('sha256').update(JSON.stringify(data)).digest('hex')};
}
export function updateDoctorContext(user:RequestUser,id:string,input:Record<string,unknown>){
 const current=readDoctorContext(user,id);assertMemberManage(user,current.memberId);
 if(input.memberId!==current.memberId)throw createError({statusCode:403,statusMessage:'历程不属于当前成员'});
 return runHealthWorkflowRequest(user,current.memberId,'doctor.context',{...input,processId:id},()=>runInTransaction(getDatabase(),()=>{
 const before=readDoctorContext(user,id);if(input.version!==before.version)throw createError({statusCode:409,statusMessage:'背景或诉求已变化，请重新打开后核对'});
 const values=['allergies','history','medications','concern'].map(key=>{const value=input[key]===undefined?before[key as 'allergies'|'history'|'medications'|'concern']:input[key];if(typeof value!=='string'||value.length>2000)throw createError({statusCode:400,statusMessage:'背景与诉求内容无效或过长'});return value.trim()||null;});
 const db=getDatabase();db.prepare('UPDATE health_members SET care_allergies=?,care_history=?,care_medications=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(...values.slice(0,3),current.memberId);
 db.prepare('INSERT INTO health_record_process_metadata(process_id,visit_concern) VALUES(?,?) ON CONFLICT(process_id) DO UPDATE SET visit_concern=excluded.visit_concern').run(id,values[3]);
 return readDoctorContext(user,id);
 }),()=>readDoctorContext(user,id));
}
