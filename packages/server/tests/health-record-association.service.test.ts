import {getRecordProcess,recordProcesses} from '../services/health-record-process.service';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { H3 } from 'h3';
import { closeDatabaseForTests, getDatabase } from '../database/client';
import type { RequestUser } from '../domain/request-user';
import type { AssociationInput, HealthRecordRef } from '../../shared/health-record-associations';
import { createPublicSymptom } from '../services/public-symptom.service';
import { createHealthEpisode, getHealthEpisode } from '../services/health-episode.service';
import { createHealthEvent } from '../services/health-event.service';
import { createClinicalFact } from '../services/clinical-fact.service';
import { createProcessSymptomUpdate, correctProcessSymptomUpdate } from '../services/symptom-episode.service';
import { createMedicationCourse, getMedicationCourse, createMedicationIntake, getMedicationIntake, updateMedicationIntake } from '../services/medication.service';
import { createVaccination, getVaccination } from '../services/vaccination.service';
import { getRecordAssociations, changeRecordAssociations } from '../services/health-record-association.service';
import { listHealthRecordFeed } from '../services/health-record-feed.service';
import { validateHealthWorkflowDatabase } from '../services/health-workflow-integrity.service';
import symptomHandler from '../routes/api/symptoms/[id].get';
import symptomPatchHandler from '../routes/api/episodes/[id]/symptoms/[symptomId].patch';
const manager:RequestUser={id:'manager',displayName:'合成账号',authenticated:true,provider:'development',isGatewayAdmin:true};
const viewer:RequestUser={...manager,id:'viewer',isGatewayAdmin:false};
async function fixture(run:()=>unknown){const previous=process.env.STORAGE_DIR;const dir=mkdtempSync(join(tmpdir(),'record-associations-'));process.env.STORAGE_DIR=dir;
 try{const db=getDatabase();for(const user of [manager,viewer])db.prepare('INSERT INTO users(id,display_name) VALUES(?,?)').run(user.id,'合成账号');
  for(const id of ['member','other']){db.prepare('INSERT INTO health_members(id,display_name,created_by) VALUES(?,?,?)').run(id,'合成成员',manager.id);db.prepare("INSERT INTO member_permissions(member_id,user_id,permission,granted_by) VALUES(?,?,'manager','manager')").run(id,manager.id);}
  db.prepare("INSERT INTO member_permissions(member_id,user_id,permission,granted_by) VALUES('member','viewer','viewer','manager')").run();await run();
 }finally{closeDatabaseForTests();if(previous===undefined)delete process.env.STORAGE_DIR;else process.env.STORAGE_DIR=previous;rmSync(dir,{recursive:true,force:true});}}
function report(id:string,type='laboratory',member='member'){getDatabase().prepare("INSERT INTO reports(id,member_id,created_by,title,report_type,status,report_issued_at) VALUES(?,?,'manager',?,?,'ready','2026-01-01')").run(id,member,'合成资料 '+id,type);}
const symptom=(name='合成症状')=>createPublicSymptom(manager,{memberId:'member',name,startedAt:'2026-01-01'});
const course=(extra={})=>createMedicationCourse(manager,{memberId:'member',medicationName:'合成药品',startedAt:'2026-01-01',confirmed:true,...extra});
function apply(input:AssociationInput,key?:string){return changeRecordAssociations(manager,{...input,...(key?{requestKey:key}:{})});}
function status(fn:()=>unknown,code:number){assert.throws(fn,(error:unknown)=>(error as {statusCode:number}).statusCode===code);}


test('all record types share explicit transitive links without changing clinical facts',()=>fixture(()=>{
 const saved=symptom();report('lab');report('image','imaging');report('rx','prescription');const med=course();const dose=createVaccination(manager,{memberId:'member',vaccineName:'合成疫苗',administeredAt:'2026-01-01'});
 const refs:HealthRecordRef[]=[{kind:'report',id:'lab'},{kind:'report',id:'image'},{kind:'medication_document',id:'rx'},{kind:'medication',id:med.id},{kind:'vaccination',id:dose.id}];
 const before=getDatabase().prepare('SELECT * FROM health_process_symptoms WHERE id=?').get(saved.id);
 const result=apply({subject:{kind:'symptom',id:saved.id},records:refs,action:'attach'});assert.equal(result.records.length,5);assert.equal(result.processes[0].recordCount,6);
 for(const ref of refs)assert.equal(getRecordAssociations(manager,ref).processes[0].id,result.processes[0].id);
 assert.deepEqual(getDatabase().prepare('SELECT * FROM health_process_symptoms WHERE id=?').get(saved.id),before);
 assert.equal(getMedicationCourse(manager,med.id).status,'active');assert.equal(getVaccination(manager,dose.id).sourceReportId,null);
}));
test('one save is idempotent and detach removes only the chosen direct edge',()=>fixture(()=>{
 report('a');report('b');report('c');const input:AssociationInput={subject:{kind:'report',id:'a'},records:[{kind:'report',id:'b'}],action:'attach'};
 const first=apply(input,'association-stable-test-001');apply(input,'association-stable-test-001');
 apply({subject:{kind:'report',id:'c'},records:[{kind:'report',id:'b'}],action:'attach'});
 const a=getRecordAssociations(manager,input.subject);assert.equal(a.records.find(r=>r.entry.resourceId==='b')?.directlyLinked,true);assert.equal(a.records.find(r=>r.entry.resourceId==='c')?.directlyLinked,false);
 apply({...input,action:'detach'});assert.equal(getRecordAssociations(manager,input.subject).processes.length,0);assert.equal(getRecordAssociations(manager,{kind:'report',id:'b'}).records.length,1);
 assert.equal(getDatabase().prepare('SELECT COUNT(*) AS n FROM reports').get()!.n,3);
 status(()=>apply({...input,records:[{kind:'report',id:'c'}]},'association-stable-test-001'),409);
}));
test('symptom observations and correction history remain attached to the original record after joining another process',()=>fixture(()=>{
 const a=symptom('合成甲'),b=symptom('合成乙');const changed=createProcessSymptomUpdate(manager,a.episodeId,a.id,{recordedAt:'2026-01-02',change:'improved'});
 correctProcessSymptomUpdate(manager,a.episodeId,a.id,changed.symptoms[0].updates[0].id,{version:1,description:'合成更正'});
 const before=getDatabase().prepare('SELECT * FROM health_process_symptom_revisions').all();
 apply({subject:{kind:'symptom',id:a.id},records:[{kind:'symptom',id:b.id}],action:'attach'});
 assert.equal(getHealthEpisode(manager,a.episodeId).symptoms[0].id,a.id);assert.equal(getHealthEpisode(manager,b.episodeId).symptoms[0].id,b.id);
 assert.deepEqual(getDatabase().prepare('SELECT * FROM health_process_symptom_revisions').all(),before);assert.deepEqual(validateHealthWorkflowDatabase(getDatabase()),[]);
}));
test('sources remain evidence and never connect unrelated problems implicitly',()=>fixture(()=>{
 const a=symptom('合成甲'),b=symptom('合成乙');report('rx','prescription');const fact=createClinicalFact(manager,'rx','medication',{medicationName:'合成药品'});const med=course({sourceMedicationId:fact.id});
 apply({subject:{kind:'medication',id:med.id},records:[{kind:'symptom',id:a.id}],action:'attach'});
 const source=getRecordAssociations(manager,{kind:'medication_document',id:'rx'});assert.equal(source.processes.length,0);
 const target=getRecordAssociations(manager,{kind:'medication',id:med.id});assert.equal(target.evidence[0].ref.id,'rx');assert.equal(recordProcesses(manager,{kind:'symptom',id:b.id}).length,0);
}));
test('saving medication refuses to silently merge selected records from different processes',()=>fixture(()=>{
 const a=symptom('合成甲'),b=symptom('合成乙');report('a');report('b');apply({subject:{kind:'symptom',id:a.id},records:[{kind:'report',id:'a'}],action:'attach'});apply({subject:{kind:'symptom',id:b.id},records:[{kind:'report',id:'b'}],action:'attach'});
 const before=getDatabase().prepare('SELECT COUNT(*) AS n FROM medication_courses').get()!.n;
 status(()=>course({relatedRecords:[{kind:'symptom',id:a.id},{kind:'symptom',id:b.id}]}),409);
 assert.equal(getDatabase().prepare('SELECT COUNT(*) AS n FROM medication_courses').get()!.n,before);
 assert.notEqual(recordProcesses(manager,{kind:'report',id:'a'})[0].id,recordProcesses(manager,{kind:'report',id:'b'})[0].id);
}));
test('new symptom and vaccination links are committed with their records and reject foreign targets atomically',()=>fixture(()=>{
 report('lab');const a=createPublicSymptom(manager,{memberId:'member',name:'合成症状',relatedRecords:[{kind:'report',id:'lab'}]});
 const vaccine=createVaccination(manager,{memberId:'member',vaccineName:'合成疫苗',administeredAt:'2026-01-01',relatedRecords:[{kind:'symptom',id:a.id}]});assert.equal(recordProcesses(manager,{kind:'vaccination',id:vaccine.id})[0].recordCount,3);
 report('foreign','laboratory','other');const before=getDatabase().prepare('SELECT COUNT(*) AS n FROM health_process_symptoms').get()!.n;
 status(()=>createPublicSymptom(manager,{memberId:'member',name:'不能串成员',relatedRecords:[{kind:'report',id:'foreign'}]}),403);
 assert.equal(getDatabase().prepare('SELECT COUNT(*) AS n FROM health_process_symptoms').get()!.n,before);
}));
test('read-only users and cross-member writes are rejected before changing links',()=>fixture(()=>{
 report('a');report('foreign','laboratory','other');const input:AssociationInput={subject:{kind:'report',id:'a'},records:[{kind:'report',id:'foreign'}],action:'attach'};
 status(()=>changeRecordAssociations(manager,input),403);status(()=>changeRecordAssociations(viewer,input),403);assert.equal(getDatabase().prepare('SELECT COUNT(*) AS n FROM health_record_links').get()!.n,0);
}));
test('a failure halfway through saving multiple links rolls back the entire operation',()=>fixture(()=>{
 report('a');report('b');report('c');const db=getDatabase();db.exec("CREATE TEMP TRIGGER association_test_fail BEFORE INSERT ON health_record_links WHEN NEW.target_id='c' BEGIN SELECT RAISE(ABORT,'synthetic-association-failure'); END");
 assert.throws(()=>apply({subject:{kind:'report',id:'a'},records:[{kind:'report',id:'b'},{kind:'report',id:'c'}],action:'attach'}),/synthetic-association-failure/);
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM health_record_links').get()!.n,0);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM health_record_processes').get()!.n,0);
}));

test('prescription provenance alone does not create a process; subsequent creates inherit an existing source process',()=>fixture(()=>{
 report('rx','prescription');report('visit');const fact=createClinicalFact(manager,'rx','medication',{medicationName:'合成药品',dose:'9'});
 const standalone=course({sourceMedicationId:fact.id});
 const single=createMedicationIntake(manager,{memberId:'member',sourceMedicationId:fact.id,takenAt:'2026-01-02',amount:'1'});
 assert.equal(single.source?.medicationId,fact.id);assert.equal(single.sourceReportId,'rx');assert.equal(single.courseId,null);
 for(const ref of [{kind:'medication',id:standalone.id},{kind:'intake',id:single.id}] as HealthRecordRef[])assert.equal(recordProcesses(manager,ref).length,0);
 const process=apply({subject:{kind:'report',id:'rx'},records:[{kind:'report',id:'visit'}],action:'attach'}).processes[0];
 const inherited=course({sourceMedicationId:fact.id,requestKey:'source-inheritance-course-001'});
 const doseInput={memberId:'member',courseId:standalone.id,takenAt:'2026-01-03',amount:'2',requestKey:'source-inheritance-intake-001'};
 const intake=createMedicationIntake(manager,doseInput);
 assert.equal(recordProcesses(manager,{kind:'medication',id:inherited.id})[0].id,process.id);
 assert.equal(recordProcesses(manager,{kind:'intake',id:intake.id})[0].id,process.id,'older unlinked parent still inherits its source report process');
 assert.equal(recordProcesses(manager,{kind:'medication',id:standalone.id}).length,0,'creation does not rewrite older source membership');
 assert.deepEqual(getRecordAssociations(manager,{kind:'intake',id:intake.id}).evidence.map(e=>[e.label,e.ref.id]),[['所属用药',standalone.id],['来源用药单','rx']]);
 assert.equal(createMedicationIntake(manager,doseInput).id,intake.id);assert.equal(getRecordProcess(manager,process.id).recordCount,4);
 assert.equal(getDatabase().prepare('SELECT COUNT(*) AS n FROM medication_intakes').get()!.n,2);
}));
test('confirmed medication membership is inherited even without a prescription',()=>fixture(()=>{
 report('visit');const med=course({relatedRecords:[{kind:'report',id:'visit'}]});
 const intake=createMedicationIntake(manager,{memberId:'member',courseId:med.id,takenAt:'2026-01-02',amount:'1'});
 assert.equal(getRecordAssociations(manager,{kind:'intake',id:intake.id}).processes[0].id,recordProcesses(manager,{kind:'medication',id:med.id})[0].id);
 assert.equal(intake.source,null);assert.equal(intake.courseId,med.id);
}));
test('source and selected-process conflicts roll back creation, receipts and revision edits without merging',()=>fixture(()=>{
 report('rx','prescription');report('visit');report('other-a');report('other-b');
 const fact=createClinicalFact(manager,'rx','medication',{medicationName:'合成药品'});
 const a=apply({subject:{kind:'report',id:'rx'},records:[{kind:'report',id:'visit'}],action:'attach'}).processes[0];
 const b=apply({subject:{kind:'report',id:'other-a'},records:[{kind:'report',id:'other-b'}],action:'attach'}).processes[0];
 const db=getDatabase();const snapshot=()=>['medication_courses','medication_intakes','medication_course_changes','health_record_links','health_workflow_requests','audit_logs'].map(table=>db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
 const before=snapshot();const input={memberId:'member',sourceMedicationId:fact.id,takenAt:'2026-01-02',amount:'1',processId:b.id,requestKey:'conflicting-intake-key-001'};
 status(()=>createMedicationIntake(manager,input),409);status(()=>course({sourceMedicationId:fact.id,processId:b.id,requestKey:'conflicting-course-key-001'}),409);
 assert.deepEqual(snapshot(),before);
 const intake=createMedicationIntake(manager,{...input,processId:a.id});
 const after=snapshot();status(()=>updateMedicationIntake(manager,intake.id,{revision:1,amount:'3',processId:b.id}),409);assert.deepEqual(snapshot(),after);
 assert.equal(getMedicationIntake(manager,intake.id).amount,'1');assert.equal(getRecordProcess(manager,a.id).recordCount,3);assert.equal(getRecordProcess(manager,b.id).recordCount,2);
}));
test('sources with no process can join an explicit process, but another member cannot be inherited',()=>fixture(()=>{
 report('rx','prescription');report('a');report('b');report('foreign','prescription','other');
 const fact=createClinicalFact(manager,'rx','medication',{medicationName:'合成药品'});const foreign=createClinicalFact(manager,'foreign','medication',{medicationName:'合成其他药品'});
 const process=apply({subject:{kind:'report',id:'a'},records:[{kind:'report',id:'b'}],action:'attach'}).processes[0];
 const intake=createMedicationIntake(manager,{memberId:'member',sourceMedicationId:fact.id,takenAt:'2026-01-02',amount:'1',processId:process.id});
 assert.equal(recordProcesses(manager,{kind:'intake',id:intake.id})[0].id,process.id);assert.equal(recordProcesses(manager,{kind:'report',id:'rx'}).length,0);
 status(()=>createMedicationIntake(manager,{memberId:'member',sourceMedicationId:foreign.id,takenAt:'2026-01-02',amount:'1'}),400);
 status(()=>createMedicationIntake(viewer,{memberId:'member',sourceMedicationId:fact.id,takenAt:'2026-01-02',amount:'1'}),403);
}));

test('explicit association management and non-medication editors retain their existing merge behavior',()=>fixture(()=>{
 report('a');report('b');report('c');report('d');
 apply({subject:{kind:'report',id:'a'},records:[{kind:'report',id:'b'}],action:'attach'});
 apply({subject:{kind:'report',id:'c'},records:[{kind:'report',id:'d'}],action:'attach'});
 const s=createPublicSymptom(manager,{memberId:'member',name:'合成明确关联',relatedRecords:[{kind:'report',id:'a'},{kind:'report',id:'c'}]});
 assert.equal(recordProcesses(manager,{kind:'symptom',id:s.id})[0].recordCount,5);
 report('rx','prescription');report('visit');const fact=createClinicalFact(manager,'rx','medication',{medicationName:'合成药品'});
 const med=course({sourceMedicationId:fact.id});apply({subject:{kind:'medication',id:med.id},records:[{kind:'report',id:'rx'}],action:'attach'});
 apply({subject:{kind:'medication',id:med.id},records:[{kind:'symptom',id:s.id}],action:'attach'});
 assert.equal(recordProcesses(manager,{kind:'medication',id:med.id})[0].recordCount,7);
}));
