import { createError } from 'h3';
import { getDatabase } from '../database/client';
import type { RequestUser } from '../domain/request-user';
import type { AssociationSubject,HealthRecordRef,RecordProcess } from '../../shared/health-record-associations';
import { processRecord,processRecordRef,recordProcesses } from './health-record-process.service';
import { reportCategory } from '../../shared/health-categories';
export const associationRef=processRecordRef;
export type RecordContext={ref:AssociationSubject;memberId:string;title:string;revision:number;versionKey:string;documentIds:string[];processes:RecordProcess[];evidence:Array<{ref:HealthRecordRef;title:string;label:string}>};
/** A report card may contain multiple explicitly grouped documents. Sources are not process edges. */
export function groupedDocumentIds(id:string,memberId:string):string[]{
 const db=getDatabase();const report=db.prepare('SELECT report_type AS type FROM reports WHERE id=?').get(id);
 if(!report||['prescription','vaccination'].includes(String(report.type)))return [id];
 const event=db.prepare(`SELECT x.event_id FROM health_event_resources x JOIN health_events e ON e.id=x.event_id WHERE x.resource_type='report' AND x.resource_id=? AND e.member_id=? AND e.deleted_at IS NULL ORDER BY x.created_at,x.id LIMIT 1`).get(id,memberId);
 if(!event)return [id];
 return db.prepare(`SELECT r.id,r.report_type FROM health_event_resources x JOIN reports r ON r.id=x.resource_id WHERE x.event_id=? AND x.resource_type='report' AND r.member_id=? AND r.status<>'trashed' AND r.deleted_at IS NULL`).all(event.event_id!,memberId).filter(row=>reportCategory(String(row.report_type))===reportCategory(String(report.type))).map(row=>String(row.id));
}
export function healthRecordContext(user:RequestUser,input:AssociationSubject):RecordContext {
 const record=processRecord(user,input);const db=getDatabase();
 const evidence:RecordContext['evidence']=[];
 if(['medication','vaccination','intake'].includes(record.ref.kind)){
  const source=record.ref.kind==='intake'
   ?db.prepare(`SELECT c.id,c.medication_name AS title,'medication' AS kind FROM medication_intakes i JOIN medication_courses c ON c.id=i.course_id WHERE i.id=? AND c.member_id=? AND c.deleted_at IS NULL`).get(record.ref.id,record.memberId)
   :db.prepare(`SELECT r.id,r.title,CASE WHEN r.report_type='prescription' THEN 'medication_document' ELSE 'report' END AS kind FROM ${record.ref.kind==='medication'?'medication_courses':'health_vaccinations'} x JOIN reports r ON r.id=x.source_report_id WHERE x.id=? AND r.member_id=? AND r.status<>'trashed' AND r.deleted_at IS NULL`).get(record.ref.id,record.memberId);
  if(source)evidence.push({ref:{kind:source.kind as HealthRecordRef['kind'],id:String(source.id)},title:String(source.title),label:record.ref.kind==='intake'?'所属用药':record.ref.kind==='medication'?'来源用药单':'原件附件'});
  if(record.ref.kind==='intake'){
   const report=db.prepare(`SELECT r.id,r.title,CASE WHEN r.report_type='prescription' THEN 'medication_document' ELSE 'report' END AS kind
    FROM medication_intakes i
    JOIN reports r ON r.id=i.source_report_id
    WHERE i.id=? AND r.member_id=? AND r.status<>'trashed' AND r.deleted_at IS NULL`).get(record.ref.id,record.memberId);
   if(report)evidence.push({ref:{kind:report.kind as HealthRecordRef['kind'],id:String(report.id)},title:String(report.title),label:'来源用药单'});
  }
 }
 return {ref:record.ref,memberId:record.memberId,title:record.title,revision:0,versionKey:record.version,
  documentIds:['report','medication_document'].includes(record.ref.kind)?groupedDocumentIds(record.ref.id,record.memberId):[],
  processes:recordProcesses(user,record.ref),evidence};
}
