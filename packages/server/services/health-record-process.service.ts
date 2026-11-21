import { formatMedicationFrequency } from '../../shared/medication-frequency';
import { createHash } from 'node:crypto';
import { createError } from 'h3';
import { getDatabase, runInTransaction } from '../database/client';
import type { RequestUser } from '../domain/request-user';
import { assertMemberAccess, assertMemberManage } from './member.service';
import { createId } from '../utils/identifier';
import { reportCategory } from '../../shared/health-categories';
import { processStages, untitledHealthProcessTitle, type HealthProcessPage, type ProcessStage, type ProcessRecordRef, type ProcessRecord,
  type HealthProcessDetail, type HealthProcessSummary, type ProcessHighlight } from '../../shared/health-process';
import { readProcessSymptoms } from './symptom-episode.service';
import { dateInput,assertOccurredDate,assertDateOrder } from './health-event-input';
import { processLifecycleLabels,type ProcessLifecycle } from '../../shared/health-process';
import { textInput } from './health-event-input';
import { getAiTaskSettings } from './ai-settings.service';
import { aiProviderHasRequiredApiKey } from './ai-provider';
import { runHealthWorkflowRequest } from './health-workflow-request.service';
import type { ProcessRecordRemoval } from '../../shared/health-process';
import { specificProcessTitle } from './health-process-title';
import { formatMeasurementSessionDescription, formatMeasurementSessionTitle } from '../../shared/measurements';

// Reclassifying a document must never disconnect its existing process.
const storageRef = (ref: ProcessRecordRef): ProcessRecordRef => ({kind:ref.kind==='medication_document'?'report':ref.kind,id:ref.id});
export const processRecordKey = (ref: ProcessRecordRef) => `${storageRef(ref).kind}:${ref.id}`;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = (message: string, statusCode = 400): never => { throw createError({ statusCode, statusMessage: message }); };
const kinds = ['report', 'medication_document', 'symptom', 'medication', 'intake', 'vaccination', 'measurement'];
export function processRecordRef(value: unknown): ProcessRecordRef {
  const ref = value as ProcessRecordRef;
  if (!ref || !kinds.includes(ref.kind) || typeof ref.id !== 'string' || !ref.id.trim() || ref.id.length > 200) return fail('关联记录无效');
  return { kind: ref.kind, id: ref.id };
}
function date(value: unknown): string | null {
  return typeof value === 'string' && value && Number.isFinite(Date.parse(value)) ? value : null;
}
function sortedDates(values: unknown[]) { return values.map(date).filter((v): v is string => !!v).sort((a,b) => Date.parse(a)-Date.parse(b)); }

/** Original clinical records stay independent. Internal symptom storage parents are not visible processes. */
export function processRecord(user: RequestUser, input: ProcessRecordRef): ProcessRecord & { memberId: string } {
  const ref = processRecordRef(input); const db = getDatabase();
  let row: Record<string, unknown> | undefined;
  let title = ''; let at: string | null = null; let latest: string | null = null;
  let description: string | null = null; let institution: string | null = null;
  let category: ProcessRecord['category'] = 'report'; let stage: ProcessStage = 'other'; let extra: unknown;
  if (ref.kind === 'report' || ref.kind === 'medication_document') {
    row = db.prepare("SELECT * FROM reports WHERE id=? AND status<>'trashed' AND deleted_at IS NULL").get(ref.id);
    if (row) {
      ref.kind = row.report_type === 'prescription' ? 'medication_document' : 'report';
      title = String(row.title); category = reportCategory(String(row.report_type));
      at = [row.report_issued_at,row.reviewed_at,row.received_at,row.examined_at,row.sampled_at,row.ordered_at].map(date).find(Boolean) || null;
      institution = row.hospital_name_raw as string | null;
      description = row.clinical_diagnosis as string | null;
      stage = category === 'medication' ? 'medication' : category === 'vaccination' ? 'vaccination'
        : ['outpatient','inpatient'].includes(String(row.report_type)) ? 'consultation'
        : ['checkup','laboratory','pathology','functional','imaging'].includes(String(row.report_type)) ? 'examination' : 'other';
      extra = [row.source_version, row.status, row.visit_department];
    }
  } else if (ref.kind === 'symptom') {
    row = db.prepare(`SELECT s.*,p.member_id FROM health_process_symptoms s JOIN health_episodes p ON p.id=s.episode_id
      WHERE s.id=? AND s.deleted_at IS NULL AND p.deleted_at IS NULL`).get(ref.id);
    if (row) {
      title = String(row.name); at = date(row.started_at); category = 'symptom'; stage = 'symptom'; description = row.description as string | null;
      const symptom = readProcessSymptoms(String(row.episode_id),ref.id).find(s => s.id === ref.id)!;
      extra = symptom;
      latest = sortedDates([at,...symptom.updates.filter(u=>!u.deletedAt).map(u=>u.recordedAt)]).at(-1) || null;
    }
  } else if (ref.kind === 'medication') {
    row = db.prepare('SELECT * FROM medication_courses WHERE id=? AND deleted_at IS NULL').get(ref.id);
    if (row) {
      title = String(row.medication_name); at = date(row.started_at); category = 'medication'; stage = 'medication';
      description = [row.specification,[row.dose,row.dose_unit].filter(Boolean).join(''),formatMedicationFrequency(row.frequency),row.route].filter(Boolean).join(' · ') || null;
      const changes=db.prepare('SELECT action,occurred_at,note,snapshot_json FROM medication_course_changes WHERE course_id=? ORDER BY revision').all(ref.id);
      const intakes=db.prepare('SELECT taken_at,amount,amount_unit,note,revision FROM medication_intakes WHERE course_id=? AND deleted_at IS NULL ORDER BY taken_at,id').all(ref.id);
      extra={changes,intakes};latest=sortedDates([at,row.last_changed_at,...intakes.map(r=>r.taken_at)]).at(-1)||null;
    }
  } else if (ref.kind === 'intake') {
    row = db.prepare(`SELECT * FROM medication_intakes WHERE id=? AND deleted_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM medication_courses c WHERE c.id=medication_intakes.course_id AND c.deleted_at IS NOT NULL)`).get(ref.id);
    if (row) {
      title = String(row.medication_name); at = date(row.taken_at); category = 'medication'; stage = 'medication';
      description = [[row.amount,row.amount_unit].filter(Boolean).join(''),row.note].filter(Boolean).join(' · ') || null;
    }
  } else if (ref.kind === 'measurement') {
    row = db.prepare('SELECT * FROM measurement_sessions WHERE id=? AND deleted_at IS NULL').get(ref.id);
    if (row) {
      const items = db.prepare(`
        SELECT canonical_key AS canonicalKey, display_name AS displayName, numeric_value AS numericValue, unit, pair_group AS pairGroup
        FROM measurement_observations WHERE session_id=? ORDER BY sort_order,id
      `).all(ref.id) as Array<{canonicalKey:string;displayName:string;numericValue:number;unit:string;pairGroup:string|null}>;
      title = formatMeasurementSessionTitle(row.template_id as never, items);
      at = date(row.recorded_at); category = 'monitoring'; stage = 'other';
      description = formatMeasurementSessionDescription(items) || null;
      institution = [row.device_vendor, row.device_model].filter(Boolean).join(' ') || null;
      extra = items;
    }
  } else {
    row = db.prepare('SELECT * FROM health_vaccinations WHERE id=? AND deleted_at IS NULL').get(ref.id);
    if (row) {
      title = String(row.vaccine_name); at = date(row.administered_at); category = 'vaccination'; stage = 'vaccination';
      description = [row.dose_number,row.note].filter(Boolean).join(' · ') || null; institution = row.organization_name as string | null;
    }
  }
  if (!row) return fail('记录不存在或已移入回收站',404);
  const memberId = String(row.member_id); assertMemberAccess(user,memberId);
  return { ref, memberId, title, date: at, latestDate: latest || at, category, stage, stageSource: 'record', description, institution,
    version: hash([row,extra]) };
}

type Node = { kind: ProcessRecordRef['kind']; record_id: string; process_id: string | null; stage_override: ProcessStage | null };
type Edge = { source_kind: ProcessRecordRef['kind']; source_id: string; target_kind: ProcessRecordRef['kind']; target_id: string };
type ProcessRow = { id: string; member_id: string; title_override: string | null; summary_override: string | null;
  ai_json: string | null; ai_hash: string | null; attempted_hash: string | null; ai_status: 'idle'|'pending'|'ready'|'failed' };
type Component = { id: string; records: Array<ProcessRecord & {memberId: string}>; links: HealthProcessDetail['links'] };

/** Reconcile live connected components; trash hides nodes, restore reconnects preserved edges. */
function components(user: RequestUser, memberId: string): Component[] {
  assertMemberAccess(user,memberId);
  const db = getDatabase();
  return runInTransaction(db,()=>{
    const nodes = db.prepare('SELECT kind,record_id,process_id,stage_override FROM health_record_process_nodes WHERE member_id=?').all(memberId) as Node[];
    const trashed=new Set(db.prepare('SELECT process_id FROM health_record_process_trash WHERE member_id=? AND deleted_at IS NOT NULL').all(memberId).map(row=>String(row.process_id)));
    const saved = new Map(nodes.map(n=>[processRecordKey({kind:n.kind,id:n.record_id}),n]));
    const records = new Map<string,ProcessRecord & {memberId:string}>();
    for (const node of nodes) {
      try { const record = processRecord(user,{kind:node.kind,id:node.record_id});
        if (record.memberId !== memberId) continue;
        if (node.stage_override && processStages.includes(node.stage_override)) { record.stage=node.stage_override;record.stageSource='manual'; }
        records.set(processRecordKey(record.ref),record);
      } catch (error) { if ((error as {statusCode?:number}).statusCode !== 404) throw error; }
    }
    const adjacency = new Map<string,Set<string>>(); const edges: HealthProcessDetail['links'] = [];
    for (const edge of db.prepare('SELECT * FROM health_record_links WHERE member_id=?').all(memberId) as Edge[]) {
      const source={kind:edge.source_kind,id:edge.source_id}; const target={kind:edge.target_kind,id:edge.target_id};
      const a=processRecordKey(source),b=processRecordKey(target);
      if (!records.has(a)||!records.has(b)) continue;
      if (!adjacency.has(a)) adjacency.set(a,new Set());if (!adjacency.has(b)) adjacency.set(b,new Set());
      adjacency.get(a)!.add(b);adjacency.get(b)!.add(a);edges.push({source,target});
    }
    const visited=new Set<string>();const groups:string[][]=[];
    for(const key of [...adjacency.keys()].sort()) {
      if(visited.has(key))continue;const group:string[]=[];const pending=[key];
      while(pending.length){const next=pending.pop()!;if(visited.has(next))continue;visited.add(next);group.push(next);for(const neighbor of adjacency.get(next)||[])pending.push(neighbor);}
      if(group.length>=2)groups.push(group.sort());
    }
    groups.sort((a,b)=>b.length-a.length||a[0].localeCompare(b[0]));const used=new Set<string>();const output:Component[]=[];
    for(const group of groups) {
      const candidates=new Map<string,number>();for(const key of group){const id=saved.get(key)?.process_id;if(id)candidates.set(id,(candidates.get(id)||0)+1);}
      let id=[...candidates].filter(([id])=>!used.has(id)&&!trashed.has(id)).sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0])).map(([id])=>id)[0];
      if(!id){id=createId('process');db.prepare('INSERT INTO health_record_processes(id,member_id) VALUES(?,?)').run(id,memberId);}
      used.add(id);const keys=new Set(group);
      for(const key of group){const record=records.get(key)!;if(saved.get(key)?.process_id!==id)db.prepare('UPDATE health_record_process_nodes SET process_id=? WHERE member_id=? AND kind=? AND record_id=?').run(id,memberId,storageRef(record.ref).kind,record.ref.id);}
      output.push({id,records:group.map(key=>records.get(key)!),links:edges.filter(e=>keys.has(processRecordKey(e.source))&&keys.has(processRecordKey(e.target)))});
    }
    // Singletons do not appear in the derived collection. Retain their last identity so
    // restoring a link can recover manually edited process metadata.
    return output;
  });
}
export function processAiAvailable() { const settings=getAiTaskSettings('health_process_summary',true); return !!(settings.enabled&&settings.model&&settings.baseUrl&&(!aiProviderHasRequiredApiKey(settings.provider)||settings.apiKey)); }
function detail(memberId:string,component:Component):HealthProcessDetail {
  const db=getDatabase();const row=db.prepare('SELECT * FROM health_record_processes WHERE id=? AND member_id=?').get(component.id,memberId) as ProcessRow;
  const lifecycle=(db.prepare('SELECT status,onset_at AS onsetAt,ended_at AS endedAt FROM health_record_process_metadata WHERE process_id=?').get(component.id)||{status:'unknown',onsetAt:null,endedAt:null}) as ProcessLifecycle;
  const fingerprint=hash([component.records.map(r=>[r.ref,r.version,r.stage,r.stageSource]),component.links]);
  let ai: {title?:string;summary?:string;highlights?:ProcessHighlight[];stages?:Array<{ref:ProcessRecordRef;stage:ProcessStage}>}={};
  if(row.ai_hash===fingerprint&&row.ai_json){try{ai=JSON.parse(row.ai_json);}catch{ /* Invalid cached metadata never prevents opening original records. */ }}
  const records=component.records.map(record=>{
    const suggested=ai.stages?.find(s=>processRecordKey(s.ref)===processRecordKey(record.ref));
    return record.stageSource!=='manual'&&suggested&&processStages.includes(suggested.stage)?{...record,stage:suggested.stage,stageSource:'ai' as const}:record;
  }).sort((a,b)=>processStages.indexOf(a.stage)-processStages.indexOf(b.stage)
    || (a.date?Date.parse(a.date):Infinity)-(b.date?Date.parse(b.date):Infinity)||processRecordKey(a.ref).localeCompare(processRecordKey(b.ref)));
  const dates=sortedDates(component.records.flatMap(record=>[record.date,record.latestDate]));
  const aiState=!processAiAvailable()?'unconfigured':row.ai_status==='pending'?'pending':row.attempted_hash===fingerprint&&row.ai_status==='failed'?'failed':row.ai_hash===fingerprint&&row.ai_json?'ready':row.ai_json?'stale':'idle';
  return {id:component.id,memberId,lifecycle,title:row.title_override||specificProcessTitle(ai.title)||untitledHealthProcessTitle,summary:row.summary_override??ai.summary??null,
    startedAt:dates[0]||null,latestAt:dates.at(-1)||null,recordCount:records.length,records,links:component.links,
    highlights:ai.highlights||[],aiState,manuallyEdited:row.title_override!==null||row.summary_override!==null,fingerprint,
    editToken:hash([fingerprint,row.title_override,row.summary_override,lifecycle])};
}
export function listRecordProcesses(user:RequestUser,memberId:string):HealthProcessSummary[] {
  return components(user,memberId).map(component=>{const {records,links,highlights,fingerprint,editToken,...summary}=detail(memberId,component);return summary;})
    .sort((a,b)=>(b.latestAt?Date.parse(b.latestAt):-Infinity)-(a.latestAt?Date.parse(a.latestAt):-Infinity)||a.id.localeCompare(b.id));
}
/** Keep cursors tied to member/search and a stable date/id boundary, rather than an offset. */
export function listRecordProcessPage(user:RequestUser,memberId:string,input:{query?:string;cursor?:string;limit?:number}={}):HealthProcessPage {
  const query=(input.query||'').trim().toLocaleLowerCase();const limit=input.limit??20;
  if(!Number.isInteger(limit)||limit<1||limit>100||query.length>200)return fail('分页或搜索参数无效');
  const scope=hash([memberId,query]);let after:{rank:number;id:string}|null=null;
  if(input.cursor){try{if(input.cursor.length>4096)throw Error();const value=JSON.parse(Buffer.from(input.cursor,'base64url').toString());
    if(value.scope!==scope||!Number.isFinite(value.rank)||typeof value.id!=='string'||!value.id||value.id.length>200)throw Error();after=value;
  }catch{return fail('分页信息无效，请重新查询');}}
  const rank=(item:HealthProcessSummary)=>{const value=item.latestAt?Date.parse(item.latestAt):NaN;return Number.isFinite(value)?value:Number.MIN_SAFE_INTEGER;};
  const all=listRecordProcesses(user,memberId).filter(item=>!query||`${item.title}\n${item.summary||''}`.toLocaleLowerCase().includes(query));
  const remaining=after?all.filter(item=>rank(item)<after!.rank||rank(item)===after!.rank&&item.id.localeCompare(after!.id)>0):all;
  const items=remaining.slice(0,limit);const hasMore=remaining.length>limit;const last=items.at(-1);
  return {items,total:all.length,hasMore,nextCursor:hasMore&&last?Buffer.from(JSON.stringify({scope,rank:rank(last),id:last.id})).toString('base64url'):null};
}
export function processMembership(user:RequestUser,memberId:string) {
  const result=new Map<string,string[]>();
  for(const component of components(user,memberId))for(const record of component.records)result.set(processRecordKey(record.ref),[component.id]);
  return result;
}
export function getRecordProcess(user:RequestUser,id:string):HealthProcessDetail {
  const row=getDatabase().prepare('SELECT member_id FROM health_record_processes WHERE id=? AND NOT EXISTS(SELECT 1 FROM health_record_process_trash t WHERE t.process_id=health_record_processes.id AND t.deleted_at IS NOT NULL)').get(id);
  if(!row)return fail('健康历程不存在或已移入回收站',404);const memberId=String(row.member_id);assertMemberAccess(user,memberId);
  const component=components(user,memberId).find(c=>c.id===id);
  if(!component)return fail('历程已合并或关联已解除，请从记录重新进入',404);
  return detail(memberId,component);
}
/** One request-local graph read for all reminder contexts; never cached across writes or users. */
export function recordProcessSummaryMap(user:RequestUser,memberId:string) {
  const result=new Map<string,HealthProcessSummary[]>();
  for(const component of components(user,memberId)){
    const {records,links,highlights,fingerprint,editToken,...summary}=detail(memberId,component);
    for(const record of records)result.set(processRecordKey(record.ref),[summary]);
  }
  return result;
}
export function recordProcesses(user:RequestUser,input:ProcessRecordRef):HealthProcessSummary[] {
  const record=processRecord(user,input);return components(user,record.memberId).filter(component=>component.records.some(r=>processRecordKey(r.ref)===processRecordKey(record.ref)))
    .map(component=>{const {records,links,highlights,fingerprint,editToken,...summary}=detail(record.memberId,component);return summary;});
}
export function directRecordLinks(user:RequestUser,input:ProcessRecordRef):ProcessRecordRef[] {
  const record=processRecord(user,input);const key=processRecordKey(record.ref);const result:ProcessRecordRef[]=[];
  for(const edge of getDatabase().prepare('SELECT * FROM health_record_links WHERE member_id=?').all(record.memberId) as Edge[]){
    const source={kind:edge.source_kind,id:edge.source_id},target={kind:edge.target_kind,id:edge.target_id};
    const other=processRecordKey(source)===key?target:processRecordKey(target)===key?source:null;
    if(other)try{const next=processRecord(user,other);if(next.memberId===record.memberId)result.push(next.ref);}catch(error){if((error as {statusCode?:number}).statusCode!==404)throw error;}
  }return result;
}
export function linkProcessRecords(user:RequestUser,subject:ProcessRecordRef,selection:unknown,remove=false) {
  const current=processRecord(user,subject);assertMemberManage(user,current.memberId);
  if(!Array.isArray(selection)||!selection.length||selection.length>20)return fail('请选择 1～20 条记录');
  const targets=selection.map(value=>processRecord(user,processRecordRef(value)));
  if(targets.some(t=>t.memberId!==current.memberId))return fail('只能关联当前成员的记录',403);
  if(targets.some(t=>processRecordKey(t.ref)===processRecordKey(current.ref)))return fail('不能关联记录自身');
  if(new Set(targets.map(t=>processRecordKey(t.ref))).size!==targets.length)return fail('请勿重复选择记录');
  return runInTransaction(getDatabase(),()=>{
    const db=getDatabase();
    for(const target of targets){const [a,b]=[storageRef(current.ref),storageRef(target.ref)].sort((a,b)=>processRecordKey(a)<processRecordKey(b)?-1:1);
      if(remove)db.prepare('DELETE FROM health_record_links WHERE member_id=? AND source_kind=? AND source_id=? AND target_kind=? AND target_id=?').run(current.memberId,a.kind,a.id,b.kind,b.id);
      else{for(const ref of [a,b])db.prepare('INSERT INTO health_record_process_nodes(member_id,kind,record_id) VALUES(?,?,?) ON CONFLICT DO NOTHING').run(current.memberId,ref.kind,ref.id);
        db.prepare('INSERT INTO health_record_links(member_id,source_kind,source_id,target_kind,target_id,created_by) VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING').run(current.memberId,a.kind,a.id,b.kind,b.id,user.id);}
    }
    const processes=recordProcesses(user,current.ref);
    db.prepare(`INSERT INTO audit_logs(id,actor_user_id,action,target_type,target_id,detail_json) VALUES(?,?,?,'health_record',?,?)`).run(createId('audit'),user.id,remove?'record.link.detach':'record.link.attach',current.ref.id,JSON.stringify({kind:current.ref.kind,records:targets.map(t=>t.ref)}));
    return processes;
  });
}
/** Add records to an explicit process; record-to-record edges remain an internal storage detail. */
export function joinRecordProcess(user:RequestUser,processId:unknown,memberId:string,selection:unknown):HealthProcessDetail {
  const id=textInput(processId,'健康历程',100,true)!;
  return runInTransaction(getDatabase(),()=>{
    const current=getRecordProcess(user,id);assertMemberManage(user,current.memberId);
    if(current.memberId!==memberId)return fail('只能加入当前成员的健康历程',403);
    if(!Array.isArray(selection)||!selection.length||selection.length>20)return fail('请选择 1～20 条记录');
    const targets=selection.map(value=>processRecord(user,processRecordRef(value)));
    if(targets.some(target=>target.memberId!==memberId))return fail('只能加入当前成员的记录',403);
    if(new Set(targets.map(target=>processRecordKey(target.ref))).size!==targets.length)return fail('请勿重复选择记录');
    const existing=new Set(current.records.map(record=>processRecordKey(record.ref)));
    const additions=targets.filter(target=>!existing.has(processRecordKey(target.ref))).map(target=>target.ref);
    if(!additions.length)return current;
    const next=linkProcessRecords(user,current.records[0].ref,additions)[0];
    return getRecordProcess(user,next.id);
  });
}
export function addProcessRecords(user:RequestUser,id:string,input:Record<string,unknown>):HealthProcessDetail {
  const row=getDatabase().prepare('SELECT member_id FROM health_record_processes WHERE id=?').get(id);
  if(!row)return fail('健康历程不存在',404);
  const memberId=String(row.member_id);
  return runHealthWorkflowRequest(user,memberId,'process.records.add',{...input,processId:id},()=>{
    const current=getRecordProcess(user,id);
    if(input.fingerprint!==current.fingerprint||input.editToken!==current.editToken)return fail('历程内容已变化，请刷新后再加入',409);
    return joinRecordProcess(user,id,memberId,input.records);
  },saved=>getRecordProcess(user,saved.id));
}
/** Remove one member of the collection while keeping all other records in the same process. */
export function removeProcessRecord(user:RequestUser,id:string,input:Record<string,unknown>):ProcessRecordRemoval {
  const db=getDatabase();const row=db.prepare('SELECT member_id FROM health_record_processes WHERE id=?').get(id);
  if(!row)return fail('健康历程不存在',404);
  const memberId=String(row.member_id);
  return runHealthWorkflowRequest(user,memberId,'process.record.remove',{...input,processId:id},()=>runInTransaction(db,()=>{
    const current=getRecordProcess(user,id);
    if(input.fingerprint!==current.fingerprint||input.editToken!==current.editToken)return fail('历程内容已变化，请刷新后再移出',409);
    const record=processRecordRef(input.record);const removedKey=processRecordKey(record);
    const target=current.records.find(item=>processRecordKey(item.ref)===removedKey);
    if(!target)return fail('记录不在当前历程中',409);
    const stored=storageRef(target.ref);
    db.prepare(`DELETE FROM health_record_links WHERE member_id=? AND
      ((source_kind=? AND source_id=?) OR (target_kind=? AND target_id=?))`).run(memberId,stored.kind,stored.id,stored.kind,stored.id);
    db.prepare('UPDATE health_record_process_nodes SET process_id=NULL,stage_override=NULL WHERE member_id=? AND kind=? AND record_id=?').run(memberId,stored.kind,stored.id);
    const remaining=current.records.filter(item=>processRecordKey(item.ref)!==removedKey);
    const refs=new Map(remaining.map(item=>[processRecordKey(item.ref),storageRef(item.ref)]));
    const adjacency=new Map([...refs.keys()].map(key=>[key,new Set<string>()]));
    for(const edge of current.links){
      const a=processRecordKey(edge.source),b=processRecordKey(edge.target);
      if(adjacency.has(a)&&adjacency.has(b)){adjacency.get(a)!.add(b);adjacency.get(b)!.add(a);}
    }
    const visited=new Set<string>();const roots:string[]=[];
    for(const key of [...refs.keys()].sort()){
      if(visited.has(key))continue;roots.push(key);const pending=[key];
      while(pending.length){const next=pending.pop()!;if(visited.has(next))continue;visited.add(next);for(const neighbor of adjacency.get(next)!)pending.push(neighbor);}
    }
    // Only reconnect disconnected remainder groups; existing record links are preserved.
    for(const key of roots.slice(1)){
      const [a,b]=[refs.get(roots[0])!,refs.get(key)!].sort((a,b)=>processRecordKey(a)<processRecordKey(b)?-1:1);
      db.prepare('INSERT INTO health_record_links(member_id,source_kind,source_id,target_kind,target_id,created_by) VALUES(?,?,?,?,?,?)').run(memberId,a.kind,a.id,b.kind,b.id,user.id);
    }
    const process=remaining.length>=2?getRecordProcess(user,id):null;
    db.prepare(`INSERT INTO audit_logs(id,actor_user_id,action,target_type,target_id,detail_json) VALUES(?,?,?,'health_record_process',?,?)`)
      .run(createId('audit'),user.id,'process.record.remove',id,JSON.stringify({record:target.ref}));
    return {memberId,removed:target.ref,process};
  }),saved=>{
    if(!saved.process)return saved;
    try{return {...saved,process:getRecordProcess(user,saved.process.id)};}
    catch(error){if((error as {statusCode?:number}).statusCode!==404)throw error;return {...saved,process:null};}
  });
}
export function updateRecordProcess(user:RequestUser,id:string,input:Record<string,unknown>) {
  const current=getRecordProcess(user,id);assertMemberManage(user,current.memberId);
  if(input.fingerprint!==current.fingerprint||input.editToken!==current.editToken)return fail('过程内容已变化，请刷新后再保存',409);
  return runInTransaction(getDatabase(),()=>{
    const db=getDatabase();
    if('title'in input||'summary'in input){const row=db.prepare('SELECT title_override,summary_override FROM health_record_processes WHERE id=?').get(id)!;
      const title='title'in input?textInput(input.title,'历程标题',120,true):row.title_override;
      const summary='summary'in input?(input.summary===''?'':textInput(input.summary,'历程摘要',2000)):row.summary_override;
      db.prepare('UPDATE health_record_processes SET title_override=?,summary_override=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(title??null,summary??null,id);}
    if('lifecycle'in input){
      const value=input.lifecycle as ProcessLifecycle;
      if(!value||typeof value!=='object'||Array.isArray(value)||!Object.hasOwn(processLifecycleLabels,value.status))return fail('历程状态无效');
      const onset=dateInput(value.onsetAt,'起病／开始日期'),ended=dateInput(value.endedAt,'结束日期');
      if(onset&&onset.length!==10||ended&&ended.length!==10)return fail('请选择日期，不包含时刻');
      assertOccurredDate(onset,'起病／开始日期');assertOccurredDate(ended,'结束日期');assertDateOrder(onset,ended);
      if(value.status!=='resolved'&&ended)return fail('只有已结束的历程可以填写结束日期');
      db.prepare('INSERT INTO health_record_process_metadata(process_id,status,onset_at,ended_at) VALUES(?,?,?,?) ON CONFLICT(process_id) DO UPDATE SET status=excluded.status,onset_at=excluded.onset_at,ended_at=excluded.ended_at').run(id,value.status,onset,ended);
    }
    if('stages'in input){if(!Array.isArray(input.stages)||input.stages.length>current.records.length)return fail('阶段设置无效');
      for(const value of input.stages){const ref=processRecordRef(value?.ref);const record=current.records.find(r=>processRecordKey(r.ref)===processRecordKey(ref));
        if(!record||value.stage!==null&&!processStages.includes(value.stage))return fail('阶段设置无效');
        db.prepare('UPDATE health_record_process_nodes SET stage_override=? WHERE member_id=? AND kind=? AND record_id=?').run(value.stage,current.memberId,storageRef(ref).kind,ref.id);}}
    return getRecordProcess(user,id);
  });
}
