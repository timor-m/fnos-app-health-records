import { formatMedicationFrequency } from '../../shared/medication-frequency';
import { createHash } from 'node:crypto';
import { createError } from 'h3';
import { getDatabase } from '../database/client';
import type { RequestUser } from '../domain/request-user';
import { assertMemberAccess } from './member.service';
import { reportCategory, isHealthCategory, type HealthDocument, type HealthFeedEntry, type HealthFeedPage } from '../../shared/health-categories';
import { listMedications, listMedicationDocuments } from './medication.service';
import { listVaccinations } from './vaccination.service';
import { feedDescriptionForSession, feedMetricsForSession, feedTitleForSession, listMeasurements } from './measurement.service';
import { measurementChannelLabels, measurementSearchText } from '../../shared/measurements';
import { readProcessSymptoms } from './symptom-episode.service';
import { processMembership, processRecordKey } from './health-record-process.service';

type Input={memberId:string;category?:string;subtype?:string;status?:string;query?:string;cursor?:string;limit?:number;timeZone?:string};
const allowedStatuses=['needs_review','processing','failed','active'];
const statusMatches=(value:string|null,status:string)=>status==='processing'?['queued','uploading','processing'].includes(value||''):value===status;
const rank=(item:HealthFeedEntry)=>{const value=item.date?Date.parse(item.date):NaN;return Number.isFinite(value)?value:Number.MIN_SAFE_INTEGER;};
const sort=(a:HealthFeedEntry,b:HealthFeedEntry)=>rank(b)-rank(a)||b.id.localeCompare(a.id,'en');
function base(kind:HealthFeedEntry['kind'],resourceId:string,memberId:string,category:HealthFeedEntry['category'],title:string,date:string|null,subtype:string):HealthFeedEntry {
 return {id:`${kind}:${resourceId}`,kind,resourceId,memberId,category,title,date,subtype,description:null,status:null,institution:null,documents:[],processIds:[]};
}
export function healthRecordSnapshot(user:RequestUser,input:Input) {
 const {memberId}=input;assertMemberAccess(user,memberId);
 if(input.category && !isHealthCategory(input.category))throw createError({statusCode:400,statusMessage:'健康分类无效'});
 if(input.status&&!allowedStatuses.includes(input.status))throw createError({statusCode:400,statusMessage:'记录状态无效'});
 const query=(input.query||'').trim().toLocaleLowerCase();if(query.length>200)throw createError({statusCode:400,statusMessage:'搜索内容过长'});
 let dateFormatter:Intl.DateTimeFormat|undefined;
 if(input.timeZone){try{if(input.timeZone.length>100)throw Error();dateFormatter=new Intl.DateTimeFormat('en-CA',{timeZone:input.timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});}catch{throw createError({statusCode:400,statusMessage:'记录查询时区无效'});}}
 const localDate=(value:string|null)=>{if(!value||!dateFormatter||!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value))return value;const date=new Date(value);if(!Number.isFinite(date.getTime()))return value;const parts=Object.fromEntries(dateFormatter.formatToParts(date).map(part=>[part.type,part.value]));return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;};
 const db=getDatabase();const entries:HealthFeedEntry[]=[];const medicationCourses:HealthFeedEntry[]=[];
 // Documents linked to a visit remain visible. A visit is grouping context, not a second card.
 const documents=db.prepare(`SELECT id,member_id AS memberId,title,report_type AS reportType,status,
  COALESCE(NULLIF(report_issued_at,''),NULLIF(reviewed_at,''),NULLIF(received_at,''),NULLIF(examined_at,''),NULLIF(sampled_at,''),NULLIF(ordered_at,'')) AS reportIssuedAt,
  hospital_name_raw AS hospitalName,COALESCE(visit_department,performing_department,reporting_department) AS department,strftime('%Y-%m-%dT%H:%M:%fZ',created_at) AS uploadedAt
  FROM reports WHERE member_id=? AND status<>'trashed' AND deleted_at IS NULL ORDER BY id`).all(memberId) as Array<HealthDocument & {uploadedAt:string|null}>;
 const links=db.prepare(`SELECT x.resource_id AS reportId,e.id AS eventId,e.title,e.started_at AS date
  FROM health_event_resources x JOIN health_events e ON e.id=x.event_id AND e.deleted_at IS NULL
  WHERE x.resource_type='report' AND e.member_id=? ORDER BY x.created_at,x.id`).all(memberId) as Array<{reportId:string;eventId:string;title:string|null;date:string|null}>;
 function symptomCardText(symptom:{bodyArea?:string|null;currentSeverity:number|null;description:string|null}){
  const facts=[symptom.bodyArea?.trim(),symptom.currentSeverity==null?'':`程度 ${symptom.currentSeverity}/10`].filter(Boolean).join(' · ');
  return [facts,symptom.description?.trim()].filter(Boolean).join(' · ')||null;
 }
 const groups=new Map<string,HealthFeedEntry>();
 for(const doc of documents){
  const category=reportCategory(doc.reportType);if(category==='medication')continue;
  const ownLinks=links.filter(link=>link.reportId===doc.id);const event=ownLinks[0];
  const key=event && category!=='vaccination' ? `${event.eventId}:${category}` : `document:${doc.id}`;
  let item=groups.get(key);
  if(!item){item=base('report',doc.id,memberId,category,event?.title||doc.title,event?.date||doc.reportIssuedAt,doc.reportType);if(event)item.groupId=event.eventId;groups.set(key,item);}
  item.documents.push(doc);item.institution ||= doc.hospitalName;
  const priorities=['failed','needs_review','processing','uploading','queued','ready'];
  item.status=[...item.documents].sort((a,b)=>priorities.indexOf(a.status)-priorities.indexOf(b.status))[0]?.status||null;
 }
 entries.push(...groups.values());
 // Symptoms are actual independent items, never whole monitoring/rehabilitation folders.
 const processes=db.prepare("SELECT id FROM health_episodes WHERE member_id=? AND deleted_at IS NULL").all(memberId) as Array<{id:string}>;
 for(const process of processes)for(const symptom of readProcessSymptoms(process.id)){
  const valid=symptom.updates.filter(update=>!update.deletedAt);
  const date=valid.map(update=>update.recordedAt).concat(symptom.startedAt||'').filter(Boolean).sort((a,b)=>Date.parse(a)-Date.parse(b)).at(-1)||null;
  const item=base('symptom',symptom.id,memberId,'symptom',symptom.name,date,'symptom');
  Object.assign(item,{episodeId:process.id,symptomId:symptom.id,processIds:[process.id],description:symptomCardText(symptom),status:symptom.status});entries.push(item);
 }
 const overview=listMedications(user,{memberId});const medicationDocuments=listMedicationDocuments(user,{memberId});
 const ingredientSearch=new Map<string,string>();
 for(const doc of medicationDocuments)if(doc.ingredientNames?.length)ingredientSearch.set(doc.id,doc.ingredientNames.join(' '));
 const documentMap=new Map(medicationDocuments.map(doc=>[doc.id,doc]));
 const documentEntries=new Map<string,HealthFeedEntry>();
 for(const doc of medicationDocuments){const item=base('medication_document',doc.id,memberId,'medication',doc.title,doc.date,'prescription');Object.assign(item,{documents:documents.filter(value=>value.id===doc.id),description:doc.medicationNames.join(' · '),medicationCount:doc.medicationCount,...(doc.formulaCount?{formulaCount:doc.formulaCount}:{}),confirmedCount:0,activeCount:0,status:doc.status});documentEntries.set(doc.id,item);}
 for(const course of overview.courses){
  const intakes=overview.intakes.filter(intake=>intake.courseId===course.id);
  const date=[course.startedAt,course.lastChangedAt,...intakes.map(intake=>intake.takenAt)].filter(Boolean).sort((a,b)=>Date.parse(a)-Date.parse(b)).at(-1)||null;
  const item=base('medication',course.id,memberId,'medication',course.medicationName,date,'course');Object.assign(item,{status:course.status,description:[course.specification,course.dose,course.doseUnit,formatMedicationFrequency(course.frequency)].filter(Boolean).join(' · '),intakeCount:intakes.length});medicationCourses.push(item);
  const parent=input.category==='medication'&&['course','record'].includes(input.subtype||'')?undefined:course.sourceReportId && documentMap.has(course.sourceReportId)?documentEntries.get(course.sourceReportId):undefined;
  if(parent){parent.confirmedCount!++;if(course.status==='active')parent.activeCount!++;if(date && (!parent.date || Date.parse(date)>Date.parse(parent.date)))parent.date=date;parent.description=[parent.description,course.medicationName].filter(Boolean).join(' · ');continue;}
  entries.push(item);
 }
 entries.push(...documentEntries.values());
 const courseIds=new Set(overview.courses.map(course=>course.id));
 for(const intake of overview.intakes.filter(value=>(input.category==='medication'&&input.subtype==='intake'||!value.courseId||!courseIds.has(value.courseId)))){
  const item=base('intake',intake.id,memberId,'medication',intake.medicationName,intake.takenAt,'intake');Object.assign(item,{description:[intake.amount,intake.amountUnit,intake.note].filter(Boolean).join(' · ')});entries.push(item);
 }
 const vaccinations=listVaccinations(user,memberId);const confirmedSources=new Set(db.prepare('SELECT DISTINCT source_report_id AS id FROM health_vaccinations WHERE member_id=? AND source_report_id IS NOT NULL').all(memberId).map(row=>String(row.id)));
 for(const vaccination of vaccinations){const item=base('vaccination',vaccination.id,memberId,'vaccination',vaccination.vaccineName,vaccination.administeredAt,'administered');Object.assign(item,{institution:vaccination.organizationName,doseNumber:vaccination.doseNumber,note:vaccination.note,description:[vaccination.doseNumber,vaccination.note].filter(Boolean).join(' · '),documents:documents.filter(doc=>doc.id===vaccination.sourceReportId)});entries.push(item);}
 for(const session of listMeasurements(user,memberId)){
  const item=base('measurement',session.id,memberId,'monitoring',feedTitleForSession(session),session.recordedAt,session.channel);
  Object.assign(item,{
    description:[feedDescriptionForSession(session), measurementSearchText(session)].filter(Boolean).join(' ')||null,
    metrics:feedMetricsForSession(session),
    status:session.channel==='manual'?null:session.channel,
    institution:[session.deviceVendor,session.deviceModel].filter(Boolean).join(' ')||measurementChannelLabels[session.channel],
    note:session.note,
  });
  entries.push(item);
 }
 // Cards and details share the same direct, grouped and inherited process definitions.
 const memberships=processMembership(user,memberId);
 for(const item of new Set([...entries,...medicationCourses]))item.processIds=[...new Set([...(memberships.get(processRecordKey({kind:item.kind,id:item.resourceId}))||[]),...item.documents.flatMap(doc=>memberships.get(processRecordKey({kind:doc.reportType==='prescription'?'medication_document':'report',id:doc.id}))||[])])];
 // A confirmed vaccination owns its source evidence; do not duplicate its credential card.
 const sorted=entries.filter(item=>!(item.kind==='report' && item.category==='vaccination' && confirmedSources.has(item.resourceId)))
  .filter(item=>(!input.category||item.category===input.category)&&(!input.subtype||(item.category==='vaccination'&&['vaccination','administered'].includes(input.subtype))||(input.category==='medication'&&input.subtype==='record' ? item.kind==='medication'||item.kind==='intake' : item.subtype===input.subtype||item.documents.some(doc=>doc.reportType===input.subtype))))
  .filter(item=>!input.status||statusMatches(item.status,input.status)||item.documents.some(doc=>statusMatches(doc.status,input.status!)))
  .filter(item=>!query||[item.title,item.date,localDate(item.date),item.description,item.institution,item.kind==='medication_document'?ingredientSearch.get(item.resourceId):'',...item.documents.flatMap(doc=>[doc.title,doc.reportIssuedAt,localDate(doc.reportIssuedAt),doc.hospitalName,doc.department])].filter(Boolean).join(' ').toLocaleLowerCase().includes(query)).sort(sort);
 return {entries:sorted,documents,medicationCourses:medicationCourses.sort(sort)};
}
export function healthRecordEntries(user:RequestUser,input:Input):HealthFeedEntry[]{return healthRecordSnapshot(user,input).entries;}
export function listHealthRecordFeed(user:RequestUser,input:Input):HealthFeedPage {
 const sorted=healthRecordEntries(user,input);
 const query=(input.query||'').trim().toLocaleLowerCase();
 const limit=Math.max(1,Math.min(100,input.limit||30));
 const scope=createHash('sha256').update(JSON.stringify([input.memberId,input.category||'',input.subtype||'',input.status||'',query,input.timeZone||''])).digest('hex');
 let after:{rank:number;id:string}|null=null;
 if(input.cursor){try{if(input.cursor.length>4096)throw Error();const cursor=JSON.parse(Buffer.from(input.cursor,'base64url').toString());if(cursor.scope!==scope||typeof cursor.rank!=='number'||!Number.isFinite(cursor.rank)||typeof cursor.id!=='string')throw Error();after=cursor;}catch{throw createError({statusCode:400,statusMessage:'分页信息无效，请重新查询'});}}
 const remaining=after?sorted.filter(item=>rank(item)<after!.rank||(rank(item)===after!.rank && item.id.localeCompare(after!.id,'en')<0)):sorted;
 const items=remaining.slice(0,limit);const hasMore=remaining.length>limit;const last=items.at(-1);
 return {items,hasMore,nextCursor:hasMore && last?Buffer.from(JSON.stringify({scope,rank:rank(last),id:last.id})).toString('base64url'):null};
}
