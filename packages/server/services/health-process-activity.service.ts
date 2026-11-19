import type {RequestUser} from '../domain/request-user';
import type {ActivityResult,HealthProcessActivity} from '../../shared/health-process-activity';
import {getRecordProcess} from './health-record-process.service';
import {buildHealthProcessCare,careRecords} from './health-process-care.service';
import {buildProcessObservations} from './health-observation.service';
import {listReminders} from './records.service';
function read<T>(label:string,run:()=>T):ActivityResult<T>{try{return {data:run()};}catch{return {error:label+'读取失败，请重试'};}}
/** One authorized, request-local snapshot; original records and permissions are reread on every request. */
export function getHealthProcessActivity(user:RequestUser,id:string,timeZone='Asia/Shanghai'):HealthProcessActivity{
 const process=getRecordProcess(user,id);
 const source=read('快速记录与变化明细',()=>careRecords(user,process,{summary:false}));
 return {processId:id,memberId:process.memberId,fingerprint:process.fingerprint,
   care:source.error?{error:source.error}:read('快速记录',()=>buildHealthProcessCare(user,process,timeZone,false,source.data!)),
   observations:source.error?{error:source.error}:read('变化明细',()=>buildProcessObservations(user,process,{},source.data!)),
   reminders:read('复查与待办',()=>listReminders(user,process.memberId,process)),
 };
}
