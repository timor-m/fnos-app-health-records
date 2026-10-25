import type {HealthProcessDetail} from '../../shared/health-process';
import {createHash} from 'node:crypto';
import {createError} from 'h3';
import {getDatabase,runInTransaction} from '../database/client';
import type {RequestUser} from '../domain/request-user';
import type {HealthObservation,ObservationRef,ObservationCategory,ObservationPage,SymptomContinuationPage} from '../../shared/health-observations';
import type {HealthRecordRef} from '../../shared/health-record-associations';
import {isTemperatureMeasurement,measurementsForSymptom} from '../../shared/symptom-measurements';
import {assertMemberAccess,assertMemberManage} from './member.service';
import {getHealthEpisode} from './health-episode.service';
import {readProcessSymptoms,createProcessSymptomUpdate,correctProcessSymptomUpdate,type ProcessSymptom,type ProcessSymptomUpdate} from './symptom-episode.service';
import {getMedicationIntake,updateMedicationIntake} from './medication.service';
import type {MedicationIntake} from '../../shared/medications';
import {getRecordProcess,processMembership,processRecord,processRecordKey,processRecordRef} from './health-record-process.service';
import {careRecords} from './health-process-care.service';
import {associateMedicationSelections} from './health-record-association.service';
import {runHealthWorkflowRequest} from './health-workflow-request.service';
import {textInput} from './health-event-input';
const fail=(message:string,code=400):never=>{throw createError({statusCode:code,statusMessage:message});};
const normalize=(text:string)=>text.normalize('NFKC').trim().replace(/\s+/g,' ').toLocaleLowerCase();
function symptomSource(user:RequestUser,id:string){
 const row=getDatabase().prepare('SELECT episode_id AS episodeId FROM health_process_symptoms WHERE id=? AND deleted_at IS NULL').get(id);
 if(!row)return fail('症状已移除或不存在',404);
 const episode=getHealthEpisode(user,String(row.episodeId));const symptom=readProcessSymptoms(episode.id).find(s=>s.id===id);
 if(!symptom)return fail('症状已移除或不存在',404);return {episode,symptom};
}
function symptomObservation(memberId:string,symptom:ProcessSymptom,update:ProcessSymptomUpdate):HealthObservation{
 const temperature=isTemperatureMeasurement(update.temperatureValue,'℃')||measurementsForSymptom(symptom.name).some(d=>d.id==='temperature')&&isTemperatureMeasurement(update.measurementValue,update.measurementUnit);
 return {ref:{kind:'symptom',id:update.id},record:{kind:'symptom',id:symptom.id},memberId,name:symptom.name,recordedAt:update.recordedAt,revision:update.version,category:temperature?'temperature':'symptom',change:update.change,severity:update.severity,measurementValue:update.measurementValue,measurementUnit:update.measurementUnit,temperatureValue:update.temperatureValue,amount:null,amountUnit:null,description:update.description};
}
function intakeObservation(intake:MedicationIntake):HealthObservation{return {ref:{kind:'intake',id:intake.id},record:{kind:'intake',id:intake.id},memberId:intake.memberId,name:intake.medicationName+(intake.specification?' · '+intake.specification:''),recordedAt:intake.takenAt,revision:intake.revision,category:'intake',change:null,severity:null,measurementValue:null,measurementUnit:null,amount:intake.amount,amountUnit:intake.amountUnit,description:intake.note};}
function context(user:RequestUser,memberId:string,processId:unknown,entry:HealthObservation){
 if(processId===undefined)return;
 if(typeof processId!=='string'||!processId)return fail('健康历程无效');
 const process=getRecordProcess(user,processId);if(process.memberId!==memberId)return fail('历程不属于当前成员',403);
 const records=careRecords(user,process);if(entry.ref.kind==='symptom'?!records.symptoms.some(s=>s.id===entry.record.id):!records.intakes.some(i=>i.id===entry.ref.id))return fail('记录已移出当前历程，请刷新后核对',409);
}
export function readHealthObservation(user:RequestUser,ref:ObservationRef,memberId:string,processId?:unknown):HealthObservation{
 assertMemberAccess(user,memberId);let entry:HealthObservation;
 if(ref.kind==='intake'){const intake=getMedicationIntake(user,ref.id);entry=intakeObservation(intake);}
 else if(ref.kind==='symptom'){
  const row=getDatabase().prepare('SELECT symptom_id AS symptomId FROM health_process_symptom_updates WHERE id=? AND deleted_at IS NULL').get(ref.id);if(!row)return fail('变化记录已撤销或不存在',404);
  const {episode,symptom}=symptomSource(user,String(row.symptomId));const update=symptom.updates.find(update=>update.id===ref.id&&!update.deletedAt);if(!update)return fail('变化记录已撤销或不存在',404);entry=symptomObservation(episode.memberId,symptom,update);
 }else return fail('记录类型无效');
 if(entry.memberId!==memberId)return fail('记录不属于当前成员',403);context(user,memberId,processId,entry);return entry;
}
export function listProcessObservations(user:RequestUser,id:string,input:{kind?:unknown;cursor?:unknown;limit?:unknown}={}):ObservationPage{
 return buildProcessObservations(user,getRecordProcess(user,id),input);
}
export function buildProcessObservations(user:RequestUser,process:HealthProcessDetail,input:{kind?:unknown;cursor?:unknown;limit?:unknown}={},source=careRecords(user,process,{reports:false})):ObservationPage{
 const id=process.id;const kind=input.kind??'all';const limit=input.limit===undefined?10:Number(input.limit);
 if(typeof kind!=='string'||!['all','symptom','temperature','intake'].includes(kind)||!Number.isInteger(limit)||limit<1||limit>100)return fail('明细筛选或分页参数无效');
 const all=[...source.symptoms.flatMap(symptom=>symptom.updates.map(update=>symptomObservation(process.memberId,symptom,update))),...source.intakes.map(intakeObservation)].sort((a,b)=>Date.parse(b.recordedAt)-Date.parse(a.recordedAt)||a.ref.kind.localeCompare(b.ref.kind)||a.ref.id.localeCompare(b.ref.id));
 const counts={symptom:0,temperature:0,intake:0};for(const entry of all)counts[entry.category]++;
 const rows=all.filter(entry=>kind==='all'||entry.category===kind);
 const scope=createHash('sha256').update(JSON.stringify([id,process.memberId,process.fingerprint,kind,all.map(e=>[e.ref,e.revision,e.recordedAt])])).digest('hex');let offset=0;
 if(input.cursor!==undefined){try{if(typeof input.cursor!=='string'||input.cursor.length>1024)throw Error();const cursor=JSON.parse(Buffer.from(input.cursor,'base64url').toString());if(cursor.scope!==scope||!Number.isSafeInteger(cursor.offset)||cursor.offset<0)throw Error();offset=cursor.offset;}catch{return fail('明细已变化，请刷新后继续',409);}}
 return {processId:id,memberId:process.memberId,counts,total:rows.length,items:rows.slice(offset,offset+limit),nextCursor:offset+limit<rows.length?Buffer.from(JSON.stringify({scope,offset:offset+limit})).toString('base64url'):null};
}
export function correctHealthObservation(user:RequestUser,ref:ObservationRef,input:Record<string,unknown>):HealthObservation{
 const memberId=textInput(input.memberId,'成员',100,true)!;assertMemberManage(user,memberId);readHealthObservation(user,ref,memberId,input.processId);
 return runHealthWorkflowRequest(user,memberId,'observation.correct',{...input,ref},()=>runInTransaction(getDatabase(),()=>{
  const current=readHealthObservation(user,ref,memberId,input.processId);
  if(ref.kind==='intake'){const patch:Record<string,unknown>={revision:input.revision};for(const [from,to] of [['recordedAt','takenAt'],['amount','amount'],['amountUnit','amountUnit'],['description','note']])if(from in input)patch[to]=input[from];updateMedicationIntake(user,ref.id,patch);}
  else{const {episode}=symptomSource(user,current.record.id);const patch:Record<string,unknown>={version:input.revision};for(const key of ['recordedAt','change','severity','measurementValue','measurementUnit','temperatureValue','description'])if(key in input)patch[key]=input[key];if('measurementValue'in input&&!input.measurementValue){patch.measurementValue=null;patch.measurementUnit=null;}correctProcessSymptomUpdate(user,episode.id,current.record.id,ref.id,patch);}
  return readHealthObservation(user,ref,memberId,input.processId);
 }),saved=>readHealthObservation(user,saved.ref,memberId,input.processId));
}
export function symptomContinuationCandidates(user:RequestUser,input:Record<string,unknown>):SymptomContinuationPage{
 const memberId=textInput(input.memberId,'成员',100,true)!;assertMemberAccess(user,memberId);const name=textInput(input.name,'症状名称',120,true)!;let scope:SymptomContinuationPage['scope']='member';let allowed:Set<string>|null=null;
 if(input.processId!==undefined){scope='process';const process=getRecordProcess(user,textInput(input.processId,'健康历程',100,true)!);if(process.memberId!==memberId)return fail('历程不属于当前成员',403);allowed=new Set(process.records.filter(r=>r.ref.kind==='symptom').map(r=>r.ref.id));}
 else if(input.relatedRecords!==undefined){if(!Array.isArray(input.relatedRecords)||input.relatedRecords.length>20)return fail('关联记录无效');if(input.relatedRecords.length){scope='related';allowed=new Set();const membership=processMembership(user,memberId);const processes=new Set<string>();
  for(const ref of input.relatedRecords as HealthRecordRef[]){const record=processRecord(user,ref);if(record.memberId!==memberId)return fail('关联记录不属于当前成员',403);if(ref.kind==='symptom')allowed.add(ref.id);for(const id of membership.get(processRecordKey(ref))||[])processes.add(id);}
  for(const id of processes)for(const record of getRecordProcess(user,id).records)if(record.ref.kind==='symptom')allowed.add(record.ref.id);
 }}
 const db=getDatabase();const rows=db.prepare(`SELECT s.id,s.name,s.body_area AS bodyArea,s.started_at AS startedAt,s.episode_id AS episodeId FROM health_process_symptoms s JOIN health_episodes e ON e.id=s.episode_id WHERE e.member_id=? AND s.deleted_at IS NULL AND e.deleted_at IS NULL`).all(memberId) as Array<{id:string;name:string;bodyArea:string|null;startedAt:string|null;episodeId:string}>;
 const items=rows.filter(row=>(!allowed||allowed.has(row.id))&&normalize(row.name)===normalize(name)).map(row=>{const symptom=readProcessSymptoms(row.episodeId).find(s=>s.id===row.id)!;const last=symptom.updates.filter(u=>!u.deletedAt).at(-1);return {id:row.id,memberId,name:row.name,bodyArea:row.bodyArea,startedAt:row.startedAt,latestAt:last?.recordedAt||row.startedAt,status:symptom.status,unit:last?.measurementUnit||measurementsForSymptom(symptom.name)[0]?.unit||null};}).sort((a,b)=>(b.latestAt?Date.parse(b.latestAt):-Infinity)-(a.latestAt?Date.parse(a.latestAt):-Infinity)||a.id.localeCompare(b.id));
 const cursorScope=createHash('sha256').update(JSON.stringify([memberId,normalize(name),scope,input.processId,input.relatedRecords,items])).digest('hex');let offset=0;
 if(input.cursor!==undefined){try{if(typeof input.cursor!=='string'||input.cursor.length>1024)throw Error();const cursor=JSON.parse(Buffer.from(input.cursor,'base64url').toString());if(cursor.scope!==cursorScope||!Number.isSafeInteger(cursor.offset)||cursor.offset<0)throw Error();offset=cursor.offset;}catch{return fail('已有症状已变化，请重新查找',409);}}
 return {memberId,scope,items:items.slice(offset,offset+20),total:items.length,nextCursor:offset+20<items.length?Buffer.from(JSON.stringify({scope:cursorScope,offset:offset+20})).toString('base64url'):null};
}
export function continueSymptomObservation(user:RequestUser,id:string,input:Record<string,unknown>):HealthObservation{
 const memberId=textInput(input.memberId,'成员',100,true)!;assertMemberManage(user,memberId);const original=symptomSource(user,id);if(original.episode.memberId!==memberId)return fail('症状不属于当前成员',403);
 if(input.processId!==undefined){const process=getRecordProcess(user,textInput(input.processId,'健康历程',100,true)!);if(process.memberId!==memberId||!process.records.some(r=>r.ref.kind==='symptom'&&r.ref.id===id))return fail('症状已移出当前历程，请刷新后核对',409);}
 const related=input.relatedRecords===undefined?undefined:Array.isArray(input.relatedRecords)&&input.relatedRecords.length<=20?input.relatedRecords.map(processRecordRef):fail('关联记录无效');
 textInput(input.recordedAt,'记录时间',100,true);
 return runHealthWorkflowRequest(user,memberId,'symptom.continue',{...input,symptomId:id},()=>runInTransaction(getDatabase(),()=>{
  const {episode,symptom}=symptomSource(user,id);const before=new Set(symptom.updates.map(update=>update.id));
  createProcessSymptomUpdate(user,episode.id,id,{recordedAt:input.recordedAt,change:input.change??null,severity:input.severity??null,temperatureValue:input.temperatureValue||null,measurementValue:input.measurementValue||null,measurementUnit:input.measurementValue?input.measurementUnit:null,description:input.description||null});
  associateMedicationSelections(user,{kind:'symptom',id},related?.filter(ref=>!(ref.kind==='symptom'&&ref.id===id)),input.processId);
  const created=readProcessSymptoms(episode.id).find(s=>s.id===id)!.updates.find(update=>!before.has(update.id))!;return symptomObservation(memberId,symptom,created);
 }),saved=>readHealthObservation(user,saved.ref,memberId,input.processId));
}
