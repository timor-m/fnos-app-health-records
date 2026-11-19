import { createHash } from 'node:crypto';
import { createError } from 'h3';
import { getDatabase } from '../database/client';
import type { RequestUser } from '../domain/request-user';
import type { HealthIndexRecord,HealthIndexEntry,HealthIndexKind,HealthRecordIndexPage } from '../../shared/health-record-index';
import type { ProcessRecordRef } from '../../shared/health-process';
import { assertMemberAccess } from './member.service';
import { processRecord,processRecordKey,processMembership,listRecordProcesses } from './health-record-process.service';

const normalize=(value:string)=>value.normalize('NFKC').trim().replace(/\s+/g,' ').toLocaleLowerCase();
const invalid=():never=>{throw createError({statusCode:400,statusMessage:'索引筛选或分页参数无效'});};
/** Read-only source index. No new diagnoses, aliases, records or implicit process links. */
export function readHealthRecordIndex(user:RequestUser,memberId:string,input:{kind?:unknown;q?:unknown;name?:unknown;cursor?:unknown;limit?:unknown}={}):HealthRecordIndexPage {
 assertMemberAccess(user,memberId);
 const kind=input.kind??'diagnosis';if(kind!=='diagnosis'&&kind!=='symptom')return invalid();
 const q=input.q??'',name=input.name??'';const limit=input.limit===undefined?40:Number(input.limit);
 if(input.limit!==undefined&&typeof input.limit!=='number'&&typeof input.limit!=='string')return invalid();
 if(typeof q!=='string'||typeof name!=='string'||q.length>200||name.length>2000||!Number.isInteger(limit)||limit<1||limit>100)return invalid();
 const db=getDatabase();
 const rows=(kind==='diagnosis'?db.prepare(`SELECT d.diagnosis_text AS name,r.id AS id,'report' AS kind,r.report_issued_at AS at
   FROM report_diagnoses d JOIN reports r ON r.id=d.report_id WHERE r.member_id=? AND r.status<>'trashed' AND r.deleted_at IS NULL AND d.is_deleted=0
   UNION ALL SELECT clinical_diagnosis AS name,id,'report' AS kind,report_issued_at AS at FROM reports WHERE member_id=? AND status<>'trashed' AND deleted_at IS NULL AND clinical_diagnosis IS NOT NULL`).all(memberId,memberId)
  :db.prepare(`SELECT s.name,s.id,'symptom' AS kind,COALESCE((SELECT MAX(u.recorded_at) FROM health_process_symptom_updates u WHERE u.symptom_id=s.id AND u.deleted_at IS NULL),s.started_at) AS at
   FROM health_process_symptoms s JOIN health_episodes e ON e.id=s.episode_id WHERE e.member_id=? AND e.deleted_at IS NULL AND s.deleted_at IS NULL`).all(memberId)) as Array<{name:string;id:string;kind:ProcessRecordRef['kind'];at:string|null}>;
 const groups=new Map<string,{entry:HealthIndexEntry;refs:Map<string,ProcessRecordRef>}>();
 for(const row of rows){if(!row.name?.trim())continue;const key=normalize(row.name);if(!key.includes(normalize(q)))continue;
  let group=groups.get(key);if(!group){group={entry:{key,name:row.name.trim(),count:0,lastAt:null},refs:new Map()};groups.set(key,group);}
  const ref={kind:row.kind,id:row.id};group.refs.set(processRecordKey(ref),ref);group.entry.count=group.refs.size;
  if(row.at&&(!group.entry.lastAt||Date.parse(row.at)>Date.parse(group.entry.lastAt)))group.entry.lastAt=row.at;
 }
 const selected=name?groups.get(normalize(name)):null;
 const records:HealthIndexRecord[]=selected?[...selected.refs.values()].map(ref=>processRecord(user,ref)).sort((a,b)=>(b.latestDate?Date.parse(b.latestDate):-Infinity)-(a.latestDate?Date.parse(a.latestDate):-Infinity)||processRecordKey(a.ref).localeCompare(processRecordKey(b.ref))):[];
 const entries=[...groups.values()].map(group=>group.entry).sort((a,b)=>a.name.localeCompare(b.name,'zh-CN')||a.key.localeCompare(b.key));
 const items=name?records:entries;
 const scope=createHash('sha256').update(JSON.stringify([memberId,kind,normalize(q),normalize(name)])).digest('hex');
 let offset=0;
 if(input.cursor!==undefined){try{if(typeof input.cursor!=='string'||input.cursor.length>1024)throw Error();const cursor=JSON.parse(Buffer.from(input.cursor,'base64url').toString());if(cursor.scope!==scope||!Number.isSafeInteger(cursor.offset)||cursor.offset<0)throw Error();offset=cursor.offset;}catch{return invalid();}}
 const page=items.slice(offset,offset+limit);const nextCursor=offset+limit<items.length?Buffer.from(JSON.stringify({scope,offset:offset+limit})).toString('base64url'):null;
 const visibleRecords=name?page as typeof records:[];
 for(const record of visibleRecords)if(record.ref.kind==='report'||record.ref.kind==='medication_document')record.medications=db.prepare('SELECT medication_name AS name FROM report_medications WHERE report_id=? AND is_deleted=0 ORDER BY id').all(record.ref.id).map(row=>String(row.name));
 const processIds=new Set<string>();if(visibleRecords.length){const membership=processMembership(user,memberId);for(const record of visibleRecords)for(const id of membership.get(processRecordKey(record.ref))||[])processIds.add(id);}
 const processes=processIds.size?listRecordProcesses(user,memberId).filter(process=>processIds.has(process.id)):[];
 return {memberId,kind:kind as HealthIndexKind,name:name?selected?.entry.name||name:null,entries:name?[]:page as HealthIndexEntry[],records:visibleRecords,processes,total:items.length,nextCursor};
}
