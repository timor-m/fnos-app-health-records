import { createError } from 'h3';
import type { HealthFeedEntry } from '../../shared/health-categories';
import type { RequestUser } from '../domain/request-user';
import type { AssociationInput, AssociationSubject, HealthRecordRef, RecordAssociation } from '../../shared/health-record-associations';
import { healthRecordContext } from './health-record-context.service';
import { healthRecordEntries, healthRecordSnapshot } from './health-record-feed.service';
import { runHealthWorkflowRequest } from './health-workflow-request.service';
import { directRecordLinks, getRecordProcess, joinRecordProcess, linkProcessRecords, processRecord, processRecordKey, recordProcesses } from './health-record-process.service';

export function getRecordAssociations(user:RequestUser,subject:AssociationSubject):RecordAssociation {
  const ref=subject;const current=processRecord(user,ref);const context=healthRecordContext(user,current.ref);
  const processes=[...new Map((context.documentIds.length?context.documentIds.flatMap(id=>recordProcesses(user,{kind:'report',id})):recordProcesses(user,current.ref)).map(p=>[p.id,p])).values()];
  const members=[...new Map(processes.flatMap(p=>getRecordProcess(user,p.id).records).map(record=>[processRecordKey(record.ref),record])).values()];
  const direct=new Set(directRecordLinks(user,current.ref).map(processRecordKey));
  const snapshot=healthRecordSnapshot(user,{memberId:current.memberId,category:'medication',subtype:'record'});
  const entries=[...healthRecordEntries(user,{memberId:current.memberId}),...snapshot.entries,...snapshot.medicationCourses];
  const own=new Set(context.documentIds.map(id=>processRecordKey({kind:'report',id})));own.add(processRecordKey(current.ref));
  const records=members.filter(record=>!own.has(processRecordKey(record.ref))).map(record=>{
    const candidate=entries.find(entry=>processRecordKey({kind:entry.kind,id:entry.resourceId})===processRecordKey(record.ref)||entry.documents.some(doc=>processRecordKey({kind:'report',id:doc.id})===processRecordKey(record.ref)));
    const entry:HealthFeedEntry=candidate?{...candidate,id:processRecordKey(record.ref),kind:record.ref.kind,resourceId:record.ref.id}:{id:processRecordKey(record.ref),kind:record.ref.kind,resourceId:record.ref.id,memberId:current.memberId,category:record.category,title:record.title,date:record.date,subtype:record.ref.kind,description:record.description,status:null,institution:record.institution,documents:[],processIds:processes.map(p=>p.id)};
    return {entry,directlyLinked:direct.has(processRecordKey(record.ref))};
  });
  return {memberId:current.memberId,subject:current.ref,title:current.title,
    processes,records,evidence:context.evidence};
}
export function changeRecordAssociations(user:RequestUser,input:AssociationInput&{requestKey?:string}) {
  const ref=input.subject;const current=processRecord(user,ref);
  if(!['attach','detach'].includes(input.action))throw createError({statusCode:400,statusMessage:'关联操作无效'});
  return runHealthWorkflowRequest(user,current.memberId,'record.link',input,()=>{
    linkProcessRecords(user,ref,input.records,input.action==='detach');return getRecordAssociations(user,ref);
  },()=>getRecordAssociations(user,ref));
}
/** Sources are provenance, not new processes. Inherit an existing process without silently merging any. */
export function associateMedicationSelections(user:RequestUser,subject:HealthRecordRef,selection:unknown,processId?:unknown,sources:HealthRecordRef[]=[]) {
  const current=processRecord(user,subject);
  if(selection!==undefined&&(!Array.isArray(selection)||selection.length>20))throw createError({statusCode:400,statusMessage:'关联记录无效，最多选择 20 项'});
  const records=(selection||[]) as HealthRecordRef[];
  // Other editors retain their existing explicit association behavior.
  if(!['medication','intake'].includes(current.ref.kind)) {
    if(processId!==undefined) {
      if(typeof processId!=='string'||!processId.trim())throw createError({statusCode:400,statusMessage:'健康历程无效'});
      joinRecordProcess(user,processId,current.memberId,[current.ref]);
    }
    if(records.length)linkProcessRecords(user,current.ref,records);
    return;
  }
  const processes=new Set(recordProcesses(user,current.ref).map(p=>p.id));
  for(const ref of [...sources,...records]) {
    const target=processRecord(user,ref);
    if(target.memberId!==current.memberId)throw createError({statusCode:403,statusMessage:'只能关联当前成员的记录'});
    for(const process of recordProcesses(user,target.ref))processes.add(process.id);
  }
  if(processId!==undefined) {
    if(typeof processId!=='string'||!processId.trim())throw createError({statusCode:400,statusMessage:'健康历程无效'});
    const process=getRecordProcess(user,processId);
    if(process.memberId!==current.memberId)throw createError({statusCode:403,statusMessage:'只能加入当前成员的健康历程'});
    processes.add(process.id);
  }
  if(processes.size>1)throw createError({statusCode:409,statusMessage:'来源或所选记录属于不同健康历程，请先明确合并历程，再保存用药记录'});
  const inherited=[...processes][0];
  if(inherited)joinRecordProcess(user,inherited,current.memberId,[current.ref]);
  if(records.length)linkProcessRecords(user,current.ref,records);
}
