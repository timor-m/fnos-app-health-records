import {mergeReportWorkflow} from '../services/health-workflow-integrity.service';
import {getOverview} from '../services/health-overview.service';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { closeDatabaseForTests,getDatabase } from '../database/client';
import type { RequestUser } from '../domain/request-user';
import { linkProcessRecords,listRecordProcesses,listRecordProcessPage,getRecordProcess,recordProcesses,updateRecordProcess,removeProcessRecord,addProcessRecords,joinRecordProcess } from '../services/health-record-process.service';
const user:RequestUser={id:'manager',displayName:'合成账号',authenticated:true,provider:'development',isGatewayAdmin:true};
async function fixture(run:()=>unknown){const previous=process.env.STORAGE_DIR;const dir=mkdtempSync(join(tmpdir(),'health-process-graph-'));process.env.STORAGE_DIR=dir;
 try{const db=getDatabase();db.prepare('INSERT INTO users(id,display_name) VALUES(?,?)').run(user.id,'合成账号');
  for(const id of ['member','other']){db.prepare('INSERT INTO health_members(id,display_name,created_by) VALUES(?,?,?)').run(id,'合成成员',user.id);db.prepare("INSERT INTO member_permissions(member_id,user_id,permission,granted_by) VALUES(?,?,'manager',?)").run(id,user.id,user.id);}await run();
 }finally{closeDatabaseForTests();if(previous===undefined)delete process.env.STORAGE_DIR;else process.env.STORAGE_DIR=previous;rmSync(dir,{recursive:true,force:true});}}
function report(id:string,type='laboratory',at:string|null='2026-01-01',member='member'){getDatabase().prepare("INSERT INTO reports(id,member_id,created_by,title,report_type,status,report_issued_at) VALUES(?,?,'manager',?,?,'ready',?)").run(id,member,'合成资料 '+id,type,at);return {kind:(type==='prescription'?'medication_document':'report') as 'report'|'medication_document',id};}
test('process pages use stable descending date boundaries, include unknown dates last and search the whole collection',()=>fixture(()=>{
 const ids:Record<string,string>={};
 for(const [key,date] of [['recent','2026-03-01'],['same-a','2026-02-01'],['same-b','2026-02-01'],['unknown',null]] as const){
  const detail=getRecordProcess(user,linkProcessRecords(user,report(key+'-a','laboratory',date),[report(key+'-b','laboratory',date)])[0].id);ids[key]=detail.id;
  updateRecordProcess(user,detail.id,{fingerprint:detail.fingerprint,editToken:detail.editToken,title:`合成${key}`,summary:key==='unknown'?'合成检索目标':null});
 }
 const expected=listRecordProcesses(user,'member').map(item=>item.id);let page=listRecordProcessPage(user,'member',{limit:2});assert.equal(page.total,4);assert.deepEqual(page.items.map(item=>item.id),expected.slice(0,2));assert.equal(page.hasMore,true);
 const cursor=page.nextCursor!;
 // Newer arrivals must not shift the next boundary and repeat an already viewed process.
 linkProcessRecords(user,report('new-a','laboratory','2026-04-01'),[report('new-b','laboratory','2026-04-01')]);
 page=listRecordProcessPage(user,'member',{limit:2,cursor});assert.deepEqual(page.items.map(item=>item.id),expected.slice(2));assert.equal(page.total,5);assert.equal(page.nextCursor,null);assert.equal(page.items.at(-1)!.id,ids.unknown);
 const found=listRecordProcessPage(user,'member',{query:' 检索目标 ',limit:1});assert.equal(found.total,1);assert.equal(found.items[0].id,ids.unknown);
 assert.throws(()=>listRecordProcessPage(user,'member',{query:'changed',cursor}),e=>(e as {statusCode:number}).statusCode===400);
 assert.throws(()=>listRecordProcessPage(user,'other',{cursor}),e=>(e as {statusCode:number}).statusCode===400);
 for(const limit of [0,-1,1.5,101,NaN])assert.throws(()=>listRecordProcessPage(user,'member',{limit}),e=>(e as {statusCode:number}).statusCode===400);
 for(const value of ['invalid',Buffer.from(JSON.stringify({scope:'invalid',rank:0,id:'x'})).toString('base64url')])assert.throws(()=>listRecordProcessPage(user,'member',{cursor:value}),e=>(e as {statusCode:number}).statusCode===400);
}));
test('process list HTTP pagination preserves legacy arrays and enforces query validation and member access',()=>fixture(async()=>{
 const {H3}=await import('h3');const {default:list}=await import('../routes/api/health-processes.get');linkProcessRecords(user,report('a'),[report('b')]);
 const db=getDatabase();db.prepare("INSERT INTO users(id,display_name) VALUES('outsider','合成无权限账号')").run();
 const app=new H3();app.use(event=>{event.context.requestUser=event.req.headers.get('x-synthetic-user')?{...user,id:'outsider',isGatewayAdmin:false}:user;});app.get('/api/health-processes',list);
 const legacy=await (await app.request('http://localhost/api/health-processes?memberId=member')).json();assert.equal(Array.isArray(legacy.data),true);
 const response=await app.request('http://localhost/api/health-processes?memberId=member&limit=1');assert.equal(response.status,200);const page=(await response.json()).data;assert.equal(page.total,1);assert.equal(page.items.length,1);assert.equal(page.nextCursor,null);
 for(const query of ['limit=0','limit=1.2','limit=no','limit=1&limit=2','limit=1&cursor=invalid','q=a&q=b'])assert.equal((await app.request('http://localhost/api/health-processes?memberId=member&'+query)).status,400);
 assert.equal((await app.request('http://localhost/api/health-processes?memberId=member&limit=1',{headers:{'x-synthetic-user':'outsider'}})).status,403);
}));
test('two records create a process, transitive joins retain its identity and unrelated records remain independent',()=>fixture(()=>{
 const a=report('a'),b=report('b'),c=report('c');report('unlinked');assert.equal(listRecordProcesses(user,'member').length,0);
 const first=linkProcessRecords(user,a,[b])[0];assert.equal(first.recordCount,2);
 assert.equal(linkProcessRecords(user,c,[b])[0].id,first.id);assert.equal(recordProcesses(user,a)[0].recordCount,3);
 assert.equal(getRecordProcess(user,first.id).links.length,2);linkProcessRecords(user,a,[b]);assert.equal(getRecordProcess(user,first.id).links.length,2);
}));
test('bridging merges entire components; unlink splits components without deleting records',()=>fixture(()=>{
 const a=report('a'),b=report('b'),c=report('c'),d=report('d');linkProcessRecords(user,a,[b]);linkProcessRecords(user,c,[d]);
 assert.equal(listRecordProcesses(user,'member').length,2);linkProcessRecords(user,b,[c]);assert.equal(listRecordProcesses(user,'member').length,1);
 linkProcessRecords(user,b,[c],true);assert.equal(listRecordProcesses(user,'member').length,2);assert.equal(getDatabase().prepare('SELECT COUNT(*) AS n FROM reports').get()!.n,4);
 linkProcessRecords(user,a,[b],true);assert.equal(recordProcesses(user,a).length,0);assert.equal(recordProcesses(user,b).length,0);
}));
test('stage takes priority over time, missing dates remain unknown and stage changes never modify report facts',()=>fixture(()=>{
 const a=report('a','laboratory','2026-01-03'),b=report('b','prescription','2026-01-01'),c=report('c','laboratory',null);
 const id=linkProcessRecords(user,a,[b,c])[0].id;let detail=getRecordProcess(user,id);
 assert.deepEqual(detail.records.map(r=>r.ref.id),['a','c','b']);assert.equal(detail.startedAt,'2026-01-01');assert.equal(detail.latestAt,'2026-01-03');
 detail=updateRecordProcess(user,id,{fingerprint:detail.fingerprint,editToken:detail.editToken,title:'合成过程',stages:[{ref:a,stage:'followup'}]});
 assert.deepEqual(detail.records.map(r=>r.ref.id),['c','b','a']);assert.equal(detail.title,'合成过程');
 assert.equal(getDatabase().prepare('SELECT report_type FROM reports WHERE id=?').get(a.id)!.report_type,'laboratory');
 assert.throws(()=>updateRecordProcess(user,id,{fingerprint:'stale',title:'过期'}),e=>(e as {statusCode:number}).statusCode===409);
}));
test('trash and restore recompute connectivity using preserved explicit links',()=>fixture(()=>{
 const a=report('a'),b=report('b'),c=report('c');linkProcessRecords(user,a,[b]);linkProcessRecords(user,b,[c]);
 getDatabase().prepare("UPDATE reports SET status='trashed' WHERE id='b'").run();assert.equal(listRecordProcesses(user,'member').length,0);
 getDatabase().prepare("UPDATE reports SET status='ready' WHERE id='b'").run();assert.equal(listRecordProcesses(user,'member')[0].recordCount,3);
 getDatabase().prepare("DELETE FROM reports WHERE id='b'").run();assert.equal(listRecordProcesses(user,'member').length,0);
}));
test('cross-member, self, duplicate and viewer mutations fail atomically',()=>fixture(()=>{
 const a=report('a'),b=report('b'),foreign=report('foreign','laboratory',null,'other');
 assert.throws(()=>linkProcessRecords(user,a,[b,foreign]),e=>(e as {statusCode:number}).statusCode===403);assert.equal(listRecordProcesses(user,'member').length,0);
 assert.throws(()=>linkProcessRecords(user,a,[a]));assert.throws(()=>linkProcessRecords(user,a,[b,b]));
 getDatabase().prepare("INSERT INTO users(id,display_name) VALUES('viewer','合成只读账号')").run();getDatabase().prepare("INSERT INTO member_permissions(member_id,user_id,permission,granted_by) VALUES('member','viewer','viewer','manager')").run();
 assert.throws(()=>linkProcessRecords({...user,id:'viewer',isGatewayAdmin:false},a,[b]),e=>(e as {statusCode:number}).statusCode===403);
}));
test('document reclassification retains its links and manual edits detect concurrent metadata changes',()=>fixture(()=>{
 const a=report('a'),b=report('b');const id=linkProcessRecords(user,a,[b])[0].id;
 const original=getRecordProcess(user,id);const changed=updateRecordProcess(user,id,{fingerprint:original.fingerprint,editToken:original.editToken,title:'手工标题'});
 assert.throws(()=>updateRecordProcess(user,id,{fingerprint:original.fingerprint,editToken:original.editToken,title:'过期修改'}),e=>(e as {statusCode:number}).statusCode===409);
 getDatabase().prepare("UPDATE reports SET report_type='prescription' WHERE id='a'").run();const after=getRecordProcess(user,id);assert.equal(after.recordCount,2);assert.equal(after.records.find(r=>r.ref.id==='a')!.ref.kind,'medication_document');assert.equal(after.title,changed.title);
 linkProcessRecords(user,{kind:'medication_document',id:'a'},[b],true);assert.equal(recordProcesses(user,b).length,0);
}));

test('merging duplicate reports rewires record links without self-edges or losing the remaining process',()=>fixture(()=>{
 const a=report('a'),b=report('b'),c=report('c'),d=report('d');linkProcessRecords(user,a,[b,c]);linkProcessRecords(user,b,[d]);
 mergeReportWorkflow(getDatabase(),'a','b');getDatabase().prepare("DELETE FROM reports WHERE id='a'").run();
 const process=listRecordProcesses(user,'member')[0];assert.equal(process.recordCount,3);assert.equal(getRecordProcess(user,process.id).links.length,2);assert.equal(getDatabase().prepare('SELECT COUNT(*) AS n FROM health_record_links WHERE source_id=target_id AND source_kind=target_kind').get()!.n,0);
}));
test('public association and process routes round-trip without a process ID, title or preview step',()=>fixture(async()=>{
 const {H3}=await import('h3');const {default:associate}=await import('../routes/api/health-records/associations.post');
 const {default:readProcess}=await import('../routes/api/health-processes/[id].get');const {default:editProcess}=await import('../routes/api/health-processes/[id].patch');
 const a=report('a'),b=report('b');const app=new H3();app.use(event=>{event.context.requestUser=user;});app.post('/api/health-records/associations',associate);app.get('/api/health-processes/:id',readProcess);app.patch('/api/health-processes/:id',editProcess);
 const response=await app.request('http://localhost/api/health-records/associations',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({subject:a,records:[b],action:'attach',requestKey:'synthetic-process-http-001'})});assert.equal(response.status,200);
 const linked=await response.json();assert.equal(linked.data.processes.length,1);const id=linked.data.processes[0].id;
 const detail=await (await app.request('http://localhost/api/health-processes/'+id)).json();assert.equal(detail.data.recordCount,2);
 const edit=await app.request('http://localhost/api/health-processes/'+id,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({fingerprint:detail.data.fingerprint,editToken:detail.data.editToken,title:'合成接口过程标题'})});assert.equal(edit.status,200);assert.equal((await edit.json()).data.title,'合成接口过程标题');
}));
test('uploading from a process record joins it immediately and rejects foreign anchors',()=>fixture(async()=>{
 const {registerUploadedReport,validateUploadContext}=await import('../services/health-upload-workflow.service');const a=report('a'),b=report('b');const c=report('c');const foreign=report('foreign','laboratory',null,'other');
 linkProcessRecords(user,a,[b]);const context=validateUploadContext(user,'member',{relatedRecord:b});registerUploadedReport(user,'member',c.id,context);assert.equal(recordProcesses(user,c)[0].recordCount,3);
 assert.throws(()=>validateUploadContext(user,'member',{relatedRecord:foreign}),e=>(e as {statusCode:number}).statusCode===403);
}));
test('symptom edits and observations follow their own dates rather than an internal parent period',()=>fixture(async()=>{
 const {createPublicSymptom}=await import('../services/public-symptom.service');const {updateProcessSymptom,createProcessSymptomUpdate}=await import('../services/symptom-episode.service');
 const symptom=createPublicSymptom(user,{memberId:'member',name:'合成症状',startedAt:'2026-01-02'});
 updateProcessSymptom(user,symptom.episodeId,symptom.id,{version:1,startedAt:'2026-01-01'});
 getDatabase().prepare("UPDATE health_episodes SET status='ended',ended_at='2026-01-02' WHERE id=?").run(symptom.episodeId);
 createProcessSymptomUpdate(user,symptom.episodeId,symptom.id,{recordedAt:'2026-01-03',change:'improved'});
 const doc=report('a');const process=linkProcessRecords(user,{kind:'symptom',id:symptom.id},[doc])[0];assert.equal(process.startedAt,'2026-01-01');assert.equal(process.latestAt,'2026-01-03');
}));
test('record-anchored plans follow process membership and multiple uploaded follow-up reports complete the same plan',()=>fixture(async()=>{
 const {createReminder,listReminders}=await import('../services/records.service');const {registerUploadedReport,validateUploadContext}=await import('../services/health-upload-workflow.service');
 const a=report('a'),b=report('b');const process=linkProcessRecords(user,a,[b])[0];const reminder=createReminder(user,{memberId:'member',title:'合成复查计划',dueAt:'2026-12-01',relatedRecord:a});
 assert.equal(listReminders(user,'member').find(r=>r.id===reminder.id)!.processes[0].id,process.id);assert.equal(getRecordProcess(user,process.id).recordCount,2);
 const c=report('c'),d=report('d');for(const target of [c,d])registerUploadedReport(user,'member',target.id,validateUploadContext(user,'member',{reminderId:reminder.id}));
 const completed=listReminders(user,'member').find(r=>r.id===reminder.id)!;assert.equal(completed.status,'completed');assert.equal(completed.completedRecord?.id,c.id);
 const after=getRecordProcess(user,process.id);assert.equal(after.recordCount,4);assert.deepEqual(after.records.filter(r=>r.stage==='followup').map(r=>r.ref.id),['c','d']);
}));
test('cross-member reminder anchors roll back creation and plans remain independently available after process unlinking',()=>fixture(async()=>{
 const {createReminder,listReminders}=await import('../services/records.service');const a=report('a'),b=report('b'),foreign=report('foreign','laboratory',null,'other');linkProcessRecords(user,a,[b]);
 assert.throws(()=>createReminder(user,{memberId:'member',title:'合成无效计划',dueAt:'2026-12-01',relatedRecord:foreign}),e=>(e as {statusCode:number}).statusCode===403);assert.equal(getDatabase().prepare('SELECT COUNT(*) AS n FROM reminders').get()!.n,0);
 const reminder=createReminder(user,{memberId:'member',title:'合成保留计划',dueAt:'2026-12-01',relatedRecord:a});linkProcessRecords(user,a,[b],true);
 const plan=listReminders(user,'member').find(r=>r.id===reminder.id)!;assert.equal(plan.processes.length,0);assert.equal(plan.status,'pending');assert.equal(plan.relatedRecord?.id,a.id);
}));
test('overview limits process previews by actual record date rather than metadata update time',()=>fixture(()=>{
 const groups=['2026-01-01','2026-02-01','2026-03-01','2026-04-01'].map((at,index)=>linkProcessRecords(user,report('a'+index,'laboratory',at),[report('b'+index,'laboratory',at)])[0]);
 report('unlinked','laboratory','2026-05-01');
 getDatabase().prepare("UPDATE health_record_processes SET updated_at='2099-01-01' WHERE id=?").run(groups[0].id);
 const overview=getOverview(user,'member');assert.deepEqual(overview.processes.map(p=>p.id),groups.slice(1).reverse().map(p=>p.id));
 assert.equal(overview.processes.every(p=>p.recordCount===2),true);
}));
const removalInput=(id:string,record:{kind:string;id:string},requestKey='synthetic-record-remove-001')=>{const current=getRecordProcess(user,id);return {record,fingerprint:current.fingerprint,editToken:current.editToken,requestKey};};
test('removing the shared anchor keeps the other records together and preserves process metadata and original data',()=>fixture(()=>{
 const a=report('a'),b=report('b'),c=report('c'),d=report('d');const id=linkProcessRecords(user,a,[b,c,d])[0].id;
 let current=getRecordProcess(user,id);updateRecordProcess(user,id,{fingerprint:current.fingerprint,editToken:current.editToken,title:'合成保留历程',stages:[{ref:b,stage:'followup'}]});
 const before=getDatabase().prepare('SELECT * FROM reports ORDER BY id').all();const result=removeProcessRecord(user,id,removalInput(id,a));
 assert.equal(result.process?.id,id);assert.equal(result.process?.recordCount,3);assert.equal(result.process?.title,'合成保留历程');assert.deepEqual(result.process?.records.map(r=>r.ref.id).sort(),['b','c','d']);assert.equal(result.process?.records.find(r=>r.ref.id==='b')?.stage,'followup');
 assert.equal(recordProcesses(user,a).length,0);assert.deepEqual(getDatabase().prepare('SELECT * FROM reports ORDER BY id').all(),before);assert.equal(result.process?.links.length,2);
}));
test('removing a bridge reconnects only disconnected remainder groups; existing cycles and unrelated processes remain intact',()=>fixture(()=>{
 const a=report('a'),b=report('b'),c=report('c'),d=report('d'),e=report('e');const id=linkProcessRecords(user,a,[b,c])[0].id;linkProcessRecords(user,b,[c]);linkProcessRecords(user,c,[d]);linkProcessRecords(user,d,[e]);
 const separate=linkProcessRecords(user,report('x'),[report('y')])[0];const originalSeparate=getRecordProcess(user,separate.id);
 const result=removeProcessRecord(user,id,removalInput(id,c));assert.equal(result.process?.recordCount,4);assert.equal(result.process?.id,id);
 assert.equal(result.process?.links.some(edge=>[edge.source.id,edge.target.id].sort().join(',')==='a,b'),true);assert.equal(result.process?.links.some(edge=>[edge.source.id,edge.target.id].sort().join(',')==='d,e'),true);assert.equal(result.process?.links.length,3);assert.deepEqual(getRecordProcess(user,separate.id),originalSeparate);
}));
test('removing one of two records dissolves the process without deleting either record; lost-response retries never remove later additions',()=>fixture(()=>{
 const a=report('a'),b=report('b');const id=linkProcessRecords(user,a,[b])[0].id;const input=removalInput(id,a);
 assert.equal(removeProcessRecord(user,id,input).process,null);assert.equal(listRecordProcesses(user,'member').length,0);assert.equal(getDatabase().prepare('SELECT COUNT(*) AS n FROM reports').get()!.n,2);
 assert.equal(removeProcessRecord(user,id,input).process,null);linkProcessRecords(user,a,[b]);removeProcessRecord(user,id,input);assert.equal(recordProcesses(user,a)[0].recordCount,2);
 assert.equal(getDatabase().prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action='process.record.remove'").get()!.n,1);
 assert.throws(()=>removeProcessRecord(user,id,{...input,record:b}),e=>(e as {statusCode:number}).statusCode===409);
}));
test('removing a reclassified document uses canonical references and clears hidden links so restoration does not rejoin it',()=>fixture(()=>{
 const a=report('a'),b=report('b'),c=report('c'),hidden=report('hidden');const id=linkProcessRecords(user,a,[b,c,hidden])[0].id;
 getDatabase().prepare("UPDATE reports SET status='trashed' WHERE id='hidden'").run();getDatabase().prepare("UPDATE reports SET report_type='prescription' WHERE id='a'").run();
 const result=removeProcessRecord(user,id,removalInput(id,{kind:'report',id:'a'}));assert.equal(result.removed.kind,'medication_document');assert.equal(result.process?.recordCount,2);
 getDatabase().prepare("UPDATE reports SET status='ready' WHERE id='hidden'").run();assert.equal(recordProcesses(user,a).length,0);assert.equal(recordProcesses(user,hidden).length,0);assert.equal(getRecordProcess(user,id).recordCount,2);
}));
test('removal rejects stale content, foreign records, unrelated records and viewers without changing any links',()=>fixture(()=>{
 const a=report('a'),b=report('b'),outside=report('outside'),foreign=report('foreign','laboratory',null,'other');const id=linkProcessRecords(user,a,[b])[0].id;const input=removalInput(id,a);
 const before=getDatabase().prepare('SELECT * FROM health_record_links').all();
 assert.throws(()=>removeProcessRecord(user,id,{...input,fingerprint:'stale'}),e=>(e as {statusCode:number}).statusCode===409);
 assert.throws(()=>removeProcessRecord(user,id,{...input,record:foreign}),e=>(e as {statusCode:number}).statusCode===409);
 assert.throws(()=>removeProcessRecord(user,id,{...input,record:outside}),e=>(e as {statusCode:number}).statusCode===409);
 getDatabase().prepare("INSERT INTO users(id,display_name) VALUES('viewer','合成查看者')").run();getDatabase().prepare("INSERT INTO member_permissions(member_id,user_id,permission,granted_by) VALUES('member','viewer','viewer','manager')").run();
 assert.throws(()=>removeProcessRecord({...user,id:'viewer',isGatewayAdmin:false},id,input),e=>(e as {statusCode:number}).statusCode===403);
 assert.deepEqual(getDatabase().prepare('SELECT * FROM health_record_links').all(),before);
 const current=getRecordProcess(user,id);updateRecordProcess(user,id,{fingerprint:current.fingerprint,editToken:current.editToken,title:'合成已更改标题'});
 assert.throws(()=>removeProcessRecord(user,id,input),e=>(e as {statusCode:number}).statusCode===409);
}));
test('a failure during remainder reconnection rolls back removal and a retry succeeds atomically',()=>fixture(()=>{
 const a=report('a'),b=report('b'),c=report('c');const id=linkProcessRecords(user,a,[b,c])[0].id;const input=removalInput(id,a);const before=getRecordProcess(user,id);
 getDatabase().exec("CREATE TRIGGER synthetic_reconnect_failure BEFORE INSERT ON health_record_links BEGIN SELECT RAISE(ABORT,'synthetic failure'); END;");
 assert.throws(()=>removeProcessRecord(user,id,input));assert.deepEqual(getRecordProcess(user,id),before);
 getDatabase().exec('DROP TRIGGER synthetic_reconnect_failure');assert.equal(removeProcessRecord(user,id,input).process?.recordCount,2);
}));
test('moving a record out preserves its independent reminders and retry reads current remaining process metadata',()=>fixture(async()=>{
 const {createReminder,listReminders}=await import('../services/records.service');
 const a=report('a'),b=report('b'),c=report('c');const id=linkProcessRecords(user,a,[b,c])[0].id;
 const removedPlan=createReminder(user,{memberId:'member',title:'合成独立提醒',dueAt:'2026-12-01',relatedRecord:a});
 const remainingPlan=createReminder(user,{memberId:'member',title:'合成历程提醒',dueAt:'2026-12-02',relatedRecord:b});
 const input=removalInput(id,a);removeProcessRecord(user,id,input);
 const plans=listReminders(user,'member');assert.equal(plans.find(p=>p.id===removedPlan.id)?.status,'pending');assert.equal(plans.find(p=>p.id===removedPlan.id)?.relatedRecord?.id,a.id);assert.equal(plans.find(p=>p.id===removedPlan.id)?.processes.length,0);assert.equal(plans.find(p=>p.id===remainingPlan.id)?.processes[0].id,id);
 const current=getRecordProcess(user,id);updateRecordProcess(user,id,{fingerprint:current.fingerprint,editToken:current.editToken,title:'合成重试读取新标题'});
 const retry=removeProcessRecord(user,id,input);assert.equal(retry.process?.title,'合成重试读取新标题');assert.equal(retry.process?.recordCount,2);
}));
test('record-removal route returns the remaining process and accepts retries after the process dissolves',()=>fixture(async()=>{
 const {H3}=await import('h3');const {default:remove}=await import('../routes/api/health-processes/[id]/records/remove.post');
 const a=report('a'),b=report('b');const id=linkProcessRecords(user,a,[b])[0].id;const input=removalInput(id,a);const app=new H3();app.use(event=>{event.context.requestUser=user;});app.post('/api/health-processes/:id/records/remove',remove);
 for(let i=0;i<2;i++){const response=await app.request(`http://localhost/api/health-processes/${id}/records/remove`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});assert.equal(response.status,200);assert.equal((await response.json()).data.process,null);}
 const malformed=await app.request(`http://localhost/api/health-processes/${id}/records/remove`,{method:'POST',headers:{'Content-Type':'application/json'},body:'[]'});assert.equal(malformed.status,400);
}));
test('adding existing records addresses the process, validates its version and retries without creating duplicate links',()=>fixture(()=>{
 const a=report('a'),b=report('b'),c=report('c');const id=linkProcessRecords(user,a,[b])[0].id;const current=getRecordProcess(user,id);
 const input={records:[c],fingerprint:current.fingerprint,editToken:current.editToken,requestKey:'synthetic-process-add-001'};
 assert.throws(()=>addProcessRecords(user,id,{...input,fingerprint:'stale'}),e=>(e as {statusCode:number}).statusCode===409);
 const result=addProcessRecords(user,id,input);assert.equal(result.id,id);assert.equal(result.recordCount,3);assert.equal(addProcessRecords(user,id,input).links.length,2);
 assert.equal(joinRecordProcess(user,id,'member',[c]).links.length,2);
 assert.throws(()=>joinRecordProcess(user,id,'other',[c]),e=>(e as {statusCode:number}).statusCode===403);
 assert.throws(()=>joinRecordProcess(user,id,'member',[report('foreign','laboratory',null,'other')]),e=>(e as {statusCode:number}).statusCode===403);
}));
test('new symptoms, medication, intakes, vaccinations and uploads join the same explicit process and expose the same membership',()=>fixture(async()=>{
 const {createPublicSymptom}=await import('../services/public-symptom.service');const {createMedicationCourse,createMedicationIntake}=await import('../services/medication.service');const {createVaccination}=await import('../services/vaccination.service');
 const {registerUploadedReport,validateUploadContext}=await import('../services/health-upload-workflow.service');const {getRecordAssociations}=await import('../services/health-record-association.service');
 const a=report('a'),b=report('b');const id=linkProcessRecords(user,a,[b])[0].id;
 const symptom=createPublicSymptom(user,{memberId:'member',name:'合成历程症状',startedAt:'2026-01-02',processId:id});
 const medication=createMedicationCourse(user,{memberId:'member',medicationName:'合成历程用药',startedAt:'2026-01-03',confirmed:true,processId:id});
 const intake=createMedicationIntake(user,{memberId:'member',medicationName:'合成服药补充',takenAt:'2026-01-04',amount:'1',processId:id});
 const vaccination=createVaccination(user,{memberId:'member',vaccineName:'合成历程接种',administeredAt:'2026-01-05',processId:id});
 const uploaded=report('uploaded');registerUploadedReport(user,'member',uploaded.id,validateUploadContext(user,'member',{processId:id}));
 const refs=[a,b,{kind:'symptom',id:symptom.id},{kind:'medication',id:medication.id},{kind:'intake',id:intake.id},{kind:'vaccination',id:vaccination.id},uploaded] as const;
 for(const ref of refs){const membership=getRecordAssociations(user,ref);assert.equal(membership.processes.length,1);assert.equal(membership.processes[0].id,id);assert.equal(membership.processes[0].recordCount,7);}
}));
test('process-scoped creation continues to join the collection after its former anchor is moved out',()=>fixture(async()=>{
 const {createPublicSymptom}=await import('../services/public-symptom.service');const a=report('a'),b=report('b'),c=report('c');const id=linkProcessRecords(user,a,[b,c])[0].id;removeProcessRecord(user,id,removalInput(id,a));
 const symptom=createPublicSymptom(user,{memberId:'member',name:'合成后续症状',startedAt:'2026-01-02',processId:id});assert.equal(recordProcesses(user,{kind:'symptom',id:symptom.id})[0].id,id);assert.equal(getRecordProcess(user,id).recordCount,3);assert.equal(recordProcesses(user,a).length,0);
}));
test('invalid or foreign process contexts roll back newly created records instead of silently creating a different journey',()=>fixture(async()=>{
 const {createPublicSymptom}=await import('../services/public-symptom.service');const {createMedicationCourse}=await import('../services/medication.service');const {createVaccination}=await import('../services/vaccination.service');const {validateUploadContext}=await import('../services/health-upload-workflow.service');
 const id=linkProcessRecords(user,report('x','laboratory',null,'other'),[report('y','laboratory',null,'other')])[0].id;
 const before=['health_process_symptoms','medication_courses','health_vaccinations'].map(table=>getDatabase().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n);
 assert.throws(()=>createPublicSymptom(user,{memberId:'member',name:'合成无效症状',processId:id}),e=>(e as {statusCode:number}).statusCode===403);
 assert.throws(()=>createMedicationCourse(user,{memberId:'member',medicationName:'合成无效用药',startedAt:'2026-01-01',confirmed:true,processId:id}),e=>(e as {statusCode:number}).statusCode===403);
 assert.throws(()=>createVaccination(user,{memberId:'member',vaccineName:'合成无效接种',administeredAt:'2026-01-01',processId:id}),e=>(e as {statusCode:number}).statusCode===403);
 assert.throws(()=>validateUploadContext(user,'member',{processId:id}),e=>(e as {statusCode:number}).statusCode===403);
 assert.deepEqual(['health_process_symptoms','medication_courses','health_vaccinations'].map(table=>getDatabase().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n),before);
}));
test('process-record route adds an existing record by process ID without a record anchor in the request',()=>fixture(async()=>{
 const {H3}=await import('h3');const {default:add}=await import('../routes/api/health-processes/[id]/records.post');const a=report('a'),b=report('b'),c=report('c');const id=linkProcessRecords(user,a,[b])[0].id;const current=getRecordProcess(user,id);
 const app=new H3();app.use(event=>{event.context.requestUser=user;});app.post('/api/health-processes/:id/records',add);
 const response=await app.request(`http://localhost/api/health-processes/${id}/records`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({records:[c],fingerprint:current.fingerprint,editToken:current.editToken,requestKey:'synthetic-process-add-http'})});assert.equal(response.status,200);assert.equal((await response.json()).data.recordCount,3);
}));
