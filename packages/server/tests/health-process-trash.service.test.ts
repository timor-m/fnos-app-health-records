import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync,readdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {getDatabase,closeDatabaseForTests} from '../database/client';
import type {RequestUser} from '../domain/request-user';
import {linkProcessRecords,listRecordProcesses,getRecordProcess,updateRecordProcess,recordProcesses,processRecord} from '../services/health-record-process.service';
import {trashHealthProcess,mutateHealthProcessTrash,purgeExpiredHealthProcesses} from '../services/health-process-trash.service';
import {listHealthTrash} from '../services/health-record-trash.service';
import {createPublicSymptom} from '../services/public-symptom.service';
import {createMedicationCourse,createMedicationIntake} from '../services/medication.service';
import {createVaccination} from '../services/vaccination.service';
import {listUserOperationAuditLogs} from '../services/records.service';
import {previewMemberMerge,executeMemberMerge} from '../services/member-merge.service';
import {exportMemberHealthWorkflow,validateHealthWorkflowDatabase} from '../services/health-workflow-integrity.service';
import type {ProcessRecordRef} from '../../shared/health-process';
const manager:RequestUser={id:'manager',displayName:'合成管理',provider:'development',authenticated:true,isGatewayAdmin:true};
const viewer:RequestUser={...manager,id:'viewer',isGatewayAdmin:false};
async function fixture(run:(dir:string)=>unknown){const previous=process.env.STORAGE_DIR;const dir=mkdtempSync(join(tmpdir(),'process-trash-'));process.env.STORAGE_DIR=dir;try{
 const db=getDatabase();db.exec("INSERT INTO users(id,display_name) VALUES('manager','Synthetic'),('viewer','Synthetic'); INSERT INTO health_members(id,display_name,created_by) VALUES('member','Synthetic','manager'),('other','Synthetic','manager'); INSERT INTO member_permissions(member_id,user_id,permission,granted_by) VALUES('member','manager','manager','manager'),('member','viewer','viewer','manager'),('other','manager','manager','manager');");await run(dir);
}finally{closeDatabaseForTests();if(previous===undefined)delete process.env.STORAGE_DIR;else process.env.STORAGE_DIR=previous;rmSync(dir,{recursive:true,force:true});}}
function report(id:string):ProcessRecordRef{getDatabase().prepare("INSERT INTO reports(id,member_id,created_by,title,report_type,status,report_issued_at) VALUES(?,'member','manager','Synthetic report','laboratory','ready','2026-01-01')").run(id);return {kind:'report',id};}
function make(){return getRecordProcess(manager,linkProcessRecords(manager,report('a'),[report('b')])[0].id);}
function trash(id:string,requestKey?:string){const p=getRecordProcess(manager,id);return trashHealthProcess(manager,id,{fingerprint:p.fingerprint,editToken:p.editToken,...(requestKey?{requestKey}:{})});}
function entry(id:string){return listHealthTrash(manager,'member').items.find(row=>row.kind==='process'&&row.id===id)!;}
function restore(id:string){return mutateHealthProcessTrash(manager,id,{revision:entry(id).revision},'restore');}
function status(run:()=>unknown,code:number){assert.throws(run,e=>(e as {statusCode?:number}).statusCode===code);}
test('trash and restore preserve every original record, manual process metadata and audit readability',()=>fixture(()=>{
 const db=getDatabase();const root=report('root');const symptom=createPublicSymptom(manager,{memberId:'member',name:'Synthetic symptom',startedAt:'2026-01-01'});
 const course=createMedicationCourse(manager,{memberId:'member',medicationName:'Synthetic medicine',startedAt:'2026-01-01',confirmed:true});
 const intake=createMedicationIntake(manager,{memberId:'member',medicationName:'Synthetic dose',takenAt:'2026-01-02',amount:'1'});
 const vaccine=createVaccination(manager,{memberId:'member',vaccineName:'Synthetic vaccine',administeredAt:'2026-01-01'});
 const refs:ProcessRecordRef[]=[root,{kind:'symptom',id:symptom.id},{kind:'medication',id:course.id},{kind:'intake',id:intake.id},{kind:'vaccination',id:vaccine.id}];
 let p=getRecordProcess(manager,linkProcessRecords(manager,root,refs.slice(1))[0].id);
 p=updateRecordProcess(manager,p.id,{fingerprint:p.fingerprint,editToken:p.editToken,title:'Synthetic retained process',summary:'Synthetic retained summary',lifecycle:{status:'resolved',onsetAt:'2026-01-01',endedAt:'2026-01-03'},stages:[{ref:root,stage:'followup'}]});
 const original=refs.map(ref=>processRecord(manager,ref));const nodes=db.prepare('SELECT * FROM health_record_process_nodes ORDER BY kind,record_id').all();
 trash(p.id);assert.equal(listRecordProcesses(manager,'member').length,0);status(()=>getRecordProcess(manager,p.id),404);
 assert.deepEqual(refs.map(ref=>processRecord(manager,ref)),original);for(const ref of refs)assert.deepEqual(recordProcesses(manager,ref),[]);
 assert.equal(entry(p.id).title,p.title);assert.ok(entry(p.id).purgeAfter);assert.equal(listHealthTrash(viewer,'member').items.length,1);
 restore(p.id);const after=getRecordProcess(manager,p.id);assert.equal(after.title,p.title);assert.equal(after.summary,p.summary);assert.deepEqual(after.lifecycle,p.lifecycle);assert.equal(after.records.find(r=>r.ref.id===root.id)!.stage,'followup');
 assert.deepEqual(refs.map(ref=>processRecord(manager,ref)),original);assert.deepEqual(db.prepare('SELECT * FROM health_record_process_nodes ORDER BY kind,record_id').all(),nodes);assert.equal(listHealthTrash(manager,'member').items.length,0);
 const logs=listUserOperationAuditLogs(manager,50).items.filter(log=>log.action==='process.trash'||log.action==='process.restore');assert.equal(logs.length,2);for(const log of logs){assert.equal(log.targetName,p.title);assert.match(log.description,/原始记录保留/);}
 assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action IN ('process.trash','process.restore') AND detail_json LIKE '%Synthetic%'").get()!.n,0);
}));
test('permissions, stale edits and repeated deletion responses never erase a newer association',()=>fixture(()=>{
 const p=make(),body={fingerprint:p.fingerprint,editToken:p.editToken,requestKey:'synthetic_delete_request'};
 status(()=>trashHealthProcess(viewer,p.id,body),403);status(()=>trashHealthProcess(manager,p.id,{...body,editToken:'stale'}),409);assert.equal(listRecordProcesses(manager,'member').length,1);
 trashHealthProcess(manager,p.id,body);const old=entry(p.id);status(()=>mutateHealthProcessTrash(viewer,p.id,{revision:old.revision},'restore'),403);status(()=>mutateHealthProcessTrash(manager,p.id,{revision:0},'restore'),409);
 assert.deepEqual(trashHealthProcess(manager,p.id,body),{id:p.id,memberId:'member',status:'trashed'});assert.equal(entry(p.id).revision,old.revision);restore(p.id);
 status(()=>trashHealthProcess(manager,p.id,body),409);assert.equal(listRecordProcesses(manager,'member').length,1);
 trash(p.id);status(()=>mutateHealthProcessTrash(manager,p.id,{revision:old.revision},'restore'),409);
}));
test('new process memberships block restoration atomically without merging processes',()=>fixture(()=>{
 const p=make();trash(p.id);const other=linkProcessRecords(manager,{kind:'report',id:'a'},[report('c')])[0];
 status(()=>restore(p.id),409);assert.equal(entry(p.id).id,p.id);assert.equal(getRecordProcess(manager,other.id).recordCount,2);assert.deepEqual(recordProcesses(manager,{kind:'report',id:'b'}),[]);
}));
test('restoration reconnects surviving records and never restores records still in their own trash',()=>fixture(()=>{
 const a=report('a'),b=report('b'),c=report('c'),d=report('d');linkProcessRecords(manager,a,[b]);linkProcessRecords(manager,b,[c,d]);const p=recordProcesses(manager,a)[0];trash(p.id);
 getDatabase().prepare("UPDATE reports SET status='trashed',deleted_at=CURRENT_TIMESTAMP WHERE id='b'").run();getDatabase().prepare("DELETE FROM reports WHERE id='c'").run();
 const result=restore(p.id);assert.ok('omittedRecordCount' in result);assert.equal(result.omittedRecordCount,1);assert.equal(getRecordProcess(manager,p.id).recordCount,2);status(()=>processRecord(manager,b),404);
 getDatabase().prepare("UPDATE reports SET status='ready',deleted_at=NULL WHERE id='b'").run();assert.equal(getRecordProcess(manager,p.id).recordCount,3);
}));
test('restoring fewer than two surviving records fails and permanent deletion keeps originals and newer processes',()=>fixture(()=>{
 const p=make();trash(p.id);getDatabase().prepare("DELETE FROM reports WHERE id='b'").run();status(()=>restore(p.id),409);
 const other=linkProcessRecords(manager,{kind:'report',id:'a'},[report('c')])[0];mutateHealthProcessTrash(manager,p.id,{revision:entry(p.id).revision},'purge');
 assert.equal(getRecordProcess(manager,other.id).recordCount,2);assert.ok(processRecord(manager,{kind:'report',id:'a'}));status(()=>mutateHealthProcessTrash(manager,p.id,{revision:1},'restore'),404);
}));
test('scheduled expiry only purges expired process snapshots and keeps raw records',()=>fixture(()=>{
 const p=make();trash(p.id);assert.equal(purgeExpiredHealthProcesses().deleted,0);getDatabase().prepare("UPDATE health_record_process_trash SET purge_after='2000-01-01'").run();
 assert.deepEqual(purgeExpiredHealthProcesses(),{checked:1,deleted:1,failed:0});assert.equal(listHealthTrash(manager,'member').items.length,0);assert.ok(processRecord(manager,{kind:'report',id:'a'}));
}));
test('a v19 database receives process trash only after backup, preserves metadata and boots idempotently',()=>fixture(dir=>{
 const p=make();let db=getDatabase();db.exec('DROP TABLE health_record_process_trash');closeDatabaseForTests();db=getDatabase();assert.equal(getRecordProcess(manager,p.id).recordCount,2);
 const backups=readdirSync(join(dir,'backups','db'));assert.ok(backups.length);assert.equal(db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get()!.v,19);
 trash(p.id);closeDatabaseForTests();db=getDatabase();assert.equal(entry(p.id).title,p.title);assert.deepEqual(readdirSync(join(dir,'backups','db')),backups);restore(p.id);assert.equal(getRecordProcess(manager,p.id).id,p.id);
}));
test('a failed backup prevents startup from partially adding process trash',()=>fixture(dir=>{
 getDatabase().exec('DROP TABLE health_record_process_trash');closeDatabaseForTests();writeFileSync(join(dir,'backups','db'),'Synthetic backup blocker');assert.throws(()=>getDatabase());closeDatabaseForTests();rmSync(join(dir,'backups','db'));assert.ok(getDatabase().prepare("SELECT 1 FROM sqlite_master WHERE name='health_record_process_trash'").get());
}));
test('HTTP deletion and shared trash operations enforce concurrency and use explicit restoration',()=>fixture(async()=>{
 const {H3}=await import('h3');const {default:remove}=await import('../routes/api/health-processes/[id].delete');const {default:mutate}=await import('../routes/api/health-records/trash.post');
 const p=make();const app=new H3();app.use(event=>{event.context.requestUser=event.req.headers.get('x-viewer')?viewer:manager;});app.delete('/api/health-processes/:id',remove);app.post('/api/health-records/trash',mutate);
 const url='http://localhost/api/health-processes/'+p.id;const options=(body:unknown)=>({headers:{'content-type':'application/json'},body:JSON.stringify(body)});
 assert.equal((await app.request(url,{method:'DELETE',...options({fingerprint:p.fingerprint,editToken:p.editToken})})).status,200);
 const body={kind:'process',id:p.id,revision:entry(p.id).revision,operation:'restore'};
 assert.equal((await app.request('http://localhost/api/health-records/trash',{method:'POST',...options(body),headers:{'content-type':'application/json','x-viewer':'1'}})).status,403);
 assert.equal((await app.request('http://localhost/api/health-records/trash',{method:'POST',...options(body)})).status,200);assert.equal(getRecordProcess(manager,p.id).recordCount,2);
}));
test('restoration preserves unchanged graph fingerprints and canonical document identities',()=>fixture(()=>{
 const a=report('a'),b=report('b'),c=report('c');getDatabase().prepare("UPDATE reports SET report_type='prescription' WHERE id='b'").run();linkProcessRecords(manager,a,[b]);linkProcessRecords(manager,b,[c]);const before=getRecordProcess(manager,recordProcesses(manager,a)[0].id);
 trash(before.id);restore(before.id);const after=getRecordProcess(manager,before.id);assert.equal(after.fingerprint,before.fingerprint);assert.deepEqual(after.links,before.links);assert.equal(after.records.find(r=>r.ref.id==='b')!.ref.kind,'medication_document');
 assert.equal(getDatabase().prepare("SELECT COUNT(*) AS n FROM health_record_links WHERE source_kind='medication_document' OR target_kind='medication_document'").get()!.n,0);
}));
test('member exports and member merge retain a recoverable process snapshot with its new owner',()=>fixture(()=>{
 const p=make();trash(p.id);assert.equal(exportMemberHealthWorkflow(manager,'member').processTrash[0].process_id,p.id);assert.deepEqual(validateHealthWorkflowDatabase(getDatabase()),[]);
 getDatabase().prepare("UPDATE users SET is_gateway_admin=1 WHERE id='manager'").run();getDatabase().exec("INSERT INTO user_identities(id,user_id,provider,subject) VALUES('synthetic-identity','manager','fnos_gateway','synthetic-manager')");
 const plan=previewMemberMerge(manager,{sourceId:'member',targetId:'other',choices:{display_name:'target',birth_date:'target',sex:'target',blood_type_abo:'target',blood_type_rh:'target'},grants:[{userId:'manager',permission:'manager',canManageSharing:true}]});executeMemberMerge(manager,plan.token);
 const row=listHealthTrash(manager,'other').items.find(row=>row.kind==='process')!;assert.equal(row.id,p.id);assert.equal(row.memberId,'other');mutateHealthProcessTrash(manager,p.id,{revision:row.revision},'restore');assert.equal(getRecordProcess(manager,p.id).memberId,'other');assert.deepEqual(validateHealthWorkflowDatabase(getDatabase()),[]);
}));
test('audit names follow the active process title after restoring an AI-named process',()=>fixture(()=>{
 const p=make();const db=getDatabase();db.prepare("UPDATE health_record_processes SET ai_json=?,ai_hash=?,ai_status='ready' WHERE id=?").run(JSON.stringify({title:'Synthetic first title'}),p.fingerprint,p.id);
 trash(p.id);assert.equal(entry(p.id).title,'Synthetic first title');restore(p.id);db.prepare('UPDATE health_record_processes SET ai_json=? WHERE id=?').run(JSON.stringify({title:'Synthetic updated title'}),p.id);
 const logs=listUserOperationAuditLogs(manager,50).items.filter(log=>log.action==='process.trash'||log.action==='process.restore');assert.equal(logs.length,2);for(const log of logs)assert.equal(log.targetName,'Synthetic updated title');
}));
