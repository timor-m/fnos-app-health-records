import { createError } from 'h3';
import { getDatabase,runInTransaction } from '../database/client';
import type { RequestUser } from '../domain/request-user';
import type { ProcessRecordRef } from '../../shared/health-process';
import { assertMemberManage } from './member.service';
import { getRecordProcess,processRecord,processRecordKey } from './health-record-process.service';
import { runHealthWorkflowRequest } from './health-workflow-request.service';
import { createId } from '../utils/identifier';

type Node={kind:ProcessRecordRef['kind'];record_id:string;stage_override:string|null};
type Edge={source_kind:ProcessRecordRef['kind'];source_id:string;target_kind:ProcessRecordRef['kind'];target_id:string;created_by:string|null;created_at:string};
type Snapshot={nodes:Node[];edges:Edge[]};
function fail(message:string,statusCode=409):never{throw createError({statusCode,statusMessage:message});}
function owner(user:RequestUser,id:string){const row=getDatabase().prepare('SELECT member_id FROM health_record_processes WHERE id=?').get(id);if(!row)return fail('健康历程不存在',404);const memberId=String(row.member_id);assertMemberManage(user,memberId);return memberId;}
function audit(userId:string|null,id:string,operation:string,count?:number){getDatabase().prepare(`INSERT INTO audit_logs(id,actor_user_id,action,target_type,target_id,detail_json) VALUES(?,?,?,'health_record_process',?,?)`).run(createId('audit'),userId,`process.${operation}`,id,JSON.stringify(count===undefined?{}:{recordCount:count}));}
function ref(node:Node):ProcessRecordRef{return {kind:node.kind,id:node.record_id};}
export function trashHealthProcess(user:RequestUser,id:string,input:Record<string,unknown>){
 const memberId=owner(user,id);
 return runHealthWorkflowRequest(user,memberId,'process.trash',{...input,processId:id},()=>runInTransaction(getDatabase(),()=>{
  const db=getDatabase();const current=getRecordProcess(user,id);
  if(input.fingerprint!==current.fingerprint||input.editToken!==current.editToken)return fail('历程内容已变化，请刷新后再删除');
  const nodes=db.prepare('SELECT kind,record_id,stage_override FROM health_record_process_nodes WHERE member_id=? AND process_id=?').all(memberId,id) as Node[];
  const keys=new Set(nodes.map(node=>processRecordKey(ref(node))));
  const edges=(db.prepare('SELECT * FROM health_record_links WHERE member_id=?').all(memberId) as Edge[]).filter(edge=>keys.has(processRecordKey({kind:edge.source_kind,id:edge.source_id}))||keys.has(processRecordKey({kind:edge.target_kind,id:edge.target_id})));
  const deletedAt=new Date().toISOString(),purgeAfter=new Date(Date.parse(deletedAt)+30*86400000).toISOString();
  db.prepare(`INSERT INTO health_record_process_trash(process_id,member_id,title,started_at,snapshot_json,deleted_at,purge_after) VALUES(?,?,?,?,?,?,?)
   ON CONFLICT(process_id) DO UPDATE SET title=excluded.title,started_at=excluded.started_at,snapshot_json=excluded.snapshot_json,deleted_at=excluded.deleted_at,purge_after=excluded.purge_after,revision=health_record_process_trash.revision+1`).run(id,memberId,current.title,current.startedAt,JSON.stringify({nodes,edges}),deletedAt,purgeAfter);
  for(const edge of edges)db.prepare('DELETE FROM health_record_links WHERE member_id=? AND source_kind=? AND source_id=? AND target_kind=? AND target_id=?').run(memberId,edge.source_kind,edge.source_id,edge.target_kind,edge.target_id);
  db.prepare('UPDATE health_record_process_nodes SET process_id=NULL,stage_override=NULL WHERE member_id=? AND process_id=?').run(memberId,id);
  audit(user.id,id,'trash',current.records.length);
  return {id,memberId,status:'trashed' as const};
 }),()=>{
  if(!getDatabase().prepare('SELECT 1 FROM health_record_process_trash WHERE process_id=? AND deleted_at IS NOT NULL').get(id))return fail('历程回收站状态已变化，请刷新后核对');
  return {id,memberId,status:'trashed' as const};
 });
}
function exists(memberId:string,value:ProcessRecordRef){
 const db=getDatabase();
 if(value.kind==='symptom')return !!db.prepare('SELECT 1 FROM health_process_symptoms s JOIN health_episodes e ON e.id=s.episode_id WHERE s.id=? AND e.member_id=?').get(value.id,memberId);
 const table={report:'reports',medication_document:'reports',medication:'medication_courses',intake:'medication_intakes',vaccination:'health_vaccinations'}[value.kind];
 return !!db.prepare(`SELECT 1 FROM ${table} WHERE id=? AND member_id=?`).get(value.id,memberId);
}
function purge(id:string,actor:string|null){
 const db=getDatabase();return runInTransaction(db,()=>{
  if(!db.prepare('SELECT 1 FROM health_record_process_trash WHERE process_id=? AND deleted_at IS NOT NULL').get(id))return fail('只有回收站中的历程可以永久删除');
  // Underlying health records, reminders and their attachments are never deleted here.
  db.prepare('DELETE FROM health_record_processes WHERE id=?').run(id);audit(actor,id,'purge');return {id,deleted:true,pendingFileCount:0};
 });
}
export function mutateHealthProcessTrash(user:RequestUser,id:string,input:Record<string,unknown>,operation:'restore'|'purge'){
 return runInTransaction(getDatabase(),()=>{
  const db=getDatabase();const memberId=owner(user,id);const row=db.prepare('SELECT * FROM health_record_process_trash WHERE process_id=?').get(id);
  if(!row?.deleted_at)return fail('这条历程已不在回收站，请刷新列表');
  if(input.revision!==row.revision)return fail('历程回收站状态已变化，请刷新后重试');
  if(operation==='purge')return purge(id,user.id);
  const snapshot=JSON.parse(String(row.snapshot_json)) as Snapshot;
  const nodes=snapshot.nodes.filter(node=>exists(memberId,ref(node)));
  const allRefs=new Map(nodes.map(node=>[processRecordKey(ref(node)),ref(node)]));
  const edges=snapshot.edges.filter(edge=>exists(memberId,{kind:edge.source_kind,id:edge.source_id})&&exists(memberId,{kind:edge.target_kind,id:edge.target_id}));
  for(const edge of edges)for(const value of [{kind:edge.source_kind,id:edge.source_id},{kind:edge.target_kind,id:edge.target_id}])allRefs.set(processRecordKey(value),value);
  const active:ProcessRecordRef[]=[];
  for(const value of allRefs.values()){
   const assignment=db.prepare('SELECT process_id FROM health_record_process_nodes WHERE member_id=? AND kind=? AND record_id=?').get(memberId,value.kind==='medication_document'?'report':value.kind,value.id);
   if(assignment?.process_id&&assignment.process_id!==id)return fail('原记录已加入其他健康历程，请先核对并移出后再恢复，避免自动合并');
   if(db.prepare('SELECT 1 FROM health_record_links WHERE member_id=? AND ((source_kind=? AND source_id=?) OR (target_kind=? AND target_id=?))').get(memberId,value.kind==='medication_document'?'report':value.kind,value.id,value.kind==='medication_document'?'report':value.kind,value.id))return fail('原记录已有新的历程关联，请先核对后再恢复');
   try{processRecord(user,{...value});if(nodes.some(node=>processRecordKey(ref(node))===processRecordKey(value)))active.push(value);}catch(error){if((error as {statusCode?:number}).statusCode!==404)throw error;}
  }
  if(active.length<2)return fail('至少需要两条可用的原始记录，请先恢复相关记录，再恢复健康历程');
  for(const node of nodes)db.prepare('INSERT INTO health_record_process_nodes(member_id,kind,record_id,process_id,stage_override) VALUES(?,?,?,?,?) ON CONFLICT(member_id,kind,record_id) DO UPDATE SET process_id=excluded.process_id,stage_override=excluded.stage_override').run(memberId,node.kind,node.record_id,id,node.stage_override);
  for(const edge of edges)db.prepare('INSERT INTO health_record_links(member_id,source_kind,source_id,target_kind,target_id,created_by,created_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT DO NOTHING').run(memberId,edge.source_kind,edge.source_id,edge.target_kind,edge.target_id,edge.created_by&&db.prepare('SELECT 1 FROM users WHERE id=?').get(edge.created_by)?edge.created_by:null,edge.created_at);
  // Preserve the original graph and its AI fingerprint; only bridge groups separated by unavailable records.
  const parent=new Map(active.map(value=>[processRecordKey(value),processRecordKey(value)]));
  const root=(key:string):string=>{let next=key;while(parent.get(next)!==next)next=parent.get(next)!;return next;};
  for(const edge of edges){const a=processRecordKey({kind:edge.source_kind,id:edge.source_id}),b=processRecordKey({kind:edge.target_kind,id:edge.target_id});if(parent.has(a)&&parent.has(b))parent.set(root(b),root(a));}
  for(let i=1;i<active.length;i++){
   const [a,b]=[active[0],active[i]].sort((a,b)=>processRecordKey(a)<processRecordKey(b)?-1:1);
   if(root(processRecordKey(a))===root(processRecordKey(b)))continue;
   db.prepare('INSERT INTO health_record_links(member_id,source_kind,source_id,target_kind,target_id,created_by) VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING').run(memberId,a.kind,a.id,b.kind,b.id,user.id);
   parent.set(root(processRecordKey(b)),root(processRecordKey(a)));
  }
  db.prepare('UPDATE health_record_process_trash SET deleted_at=NULL,purge_after=NULL,snapshot_json=NULL,revision=revision+1 WHERE process_id=?').run(id);
  const restored=getRecordProcess(user,id);audit(user.id,id,'restore',restored.recordCount);
  return {id,memberId,status:'active' as const,omittedRecordCount:snapshot.nodes.length-nodes.length};
 });
}
export function purgeExpiredHealthProcesses(limit=50){
 const rows=getDatabase().prepare("SELECT process_id FROM health_record_process_trash WHERE deleted_at IS NOT NULL AND julianday(purge_after)<=julianday('now') ORDER BY deleted_at,process_id LIMIT ?").all(Math.max(1,Math.min(200,Math.round(limit))));
 let deleted=0,failed=0;for(const row of rows){try{purge(String(row.process_id),null);deleted++;}catch{failed++;}}return {checked:rows.length,deleted,failed};
}
