import { initialSymptomMeasurements } from './symptom-measurement.service';
import { createProcessSymptomUpdate } from './symptom-episode.service';
import { associateMedicationSelections } from './health-record-association.service';
import { createError } from 'h3';
import { getDatabase, runInTransaction } from '../database/client';
import type { RequestUser } from '../domain/request-user';
import { assertMemberManage, assertMemberAccess } from './member.service';
import { textInput } from './health-event-input';
import { createHealthEpisode } from './health-episode.service';
import { runHealthWorkflowRequest } from './health-workflow-request.service';
function read(user:RequestUser,id:string){const value=getDatabase().prepare(`SELECT s.id,s.episode_id AS episodeId,p.member_id AS memberId FROM health_process_symptoms s JOIN health_episodes p ON p.id=s.episode_id WHERE s.id=? AND s.deleted_at IS NULL AND p.deleted_at IS NULL`).get(id);if(!value)throw createError({statusCode:404,statusMessage:'症状不存在'});assertMemberAccess(user,String(value.memberId));return {id:String(value.id),episodeId:String(value.episodeId),memberId:String(value.memberId)};}
export function createPublicSymptom(user:RequestUser,input:Record<string,unknown>){const memberId=textInput(input.memberId,'成员',100,true)!;assertMemberManage(user,memberId);const name=textInput(input.name,'症状名称',120,true)!;
 return runHealthWorkflowRequest(user,memberId,'public.symptom.create',input,()=>{
 return runInTransaction(getDatabase(),()=>{
 const {requestKey,relatedRecords,processId,initialMeasurements,...details}=input;
 const measurements=initialSymptomMeasurements(name,initialMeasurements);
 const episode=createHealthEpisode(user,{memberId,episodeType:'symptom',title:name,startedAt:details.startedAt,symptom:{...details,name}});
 const created=read(user,episode.symptoms[0].id);
 for(const measurement of measurements)createProcessSymptomUpdate(user,created.episodeId,created.id,measurement);
 associateMedicationSelections(user,{kind:'symptom',id:created.id},relatedRecords,processId);
 return created;
 });
 },saved=>read(user,saved.id));
}
