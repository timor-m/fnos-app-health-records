import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getDatabase,closeDatabaseForTests } from '../database/client';
import type { RequestUser } from '../domain/request-user';
import { createClinicalFact,updateClinicalFact } from '../services/clinical-fact.service';
import { listHealthRecordFeed } from '../services/health-record-feed.service';
import { createMedicationIntake } from '../services/medication.service';
import { createPublicSymptom } from '../services/public-symptom.service';
import { createProcessSymptomUpdate } from '../services/symptom-episode.service';
import { createReportStructuredSection } from '../services/report-structured-section.service';
import { getReportExaminations,saveReportExamination } from '../services/report-examination.service';
const manager:RequestUser={id:'manager',displayName:'合成审查账号',provider:'development',authenticated:true,isGatewayAdmin:true};
function fixture(run:()=>void){const previous=process.env.STORAGE_DIR;const dir=mkdtempSync(join(tmpdir(),'record-editor-retry-'));process.env.STORAGE_DIR=dir;
 try{const db=getDatabase();db.exec("INSERT INTO users(id,display_name) VALUES('manager','合成账号'),('viewer','合成查看者'); INSERT INTO health_members(id,display_name,created_by) VALUES('member','合成成员','manager'),('second','合成另一成员','manager'); INSERT INTO member_permissions(member_id,user_id,permission,granted_by) VALUES('member','manager','manager','manager'),('second','manager','manager','manager'),('member','viewer','viewer','manager'); INSERT INTO reports(id,member_id,created_by,title,report_type,status) VALUES('report','member','manager','合成报告','outpatient','ready'); INSERT INTO observations(id,report_id,item_name,result_text) VALUES('obs','report','合成指标','1')");run();}
 finally{closeDatabaseForTests();if(previous===undefined)delete process.env.STORAGE_DIR;else process.env.STORAGE_DIR=previous;rmSync(dir,{recursive:true,force:true});}}
function status(fn:()=>unknown,value:number){assert.throws(fn,error=>(error as {statusCode:number}).statusCode===value);}
test('clinical fact creation replays a lost response without duplicating rows or source versions',()=>fixture(()=>{
 const input={diagnosisText:'合成诊断',requestKey:'clinical-retry-review-001'};const first=createClinicalFact(manager,'report','diagnosis',input);const version=getDatabase().prepare('SELECT source_version AS n FROM reports WHERE id=?').get('report')!.n;
 assert.deepEqual(createClinicalFact(manager,'report','diagnosis',input),first);assert.equal(getDatabase().prepare('SELECT COUNT(*) AS n FROM report_diagnoses').get()!.n,1);assert.equal(getDatabase().prepare('SELECT source_version AS n FROM reports WHERE id=?').get('report')!.n,version);
 status(()=>createClinicalFact(manager,'report','diagnosis',{...input,diagnosisText:'修改后的合成诊断'}),409);
 status(()=>createClinicalFact({...manager,id:'viewer',isGatewayAdmin:false},'report','diagnosis',input),403);
 getDatabase().prepare("UPDATE reports SET member_id='second' WHERE id='report'").run();status(()=>createClinicalFact(manager,'report','diagnosis',input),409);assert.equal(getDatabase().prepare('SELECT COUNT(*) AS n FROM report_diagnoses').get()!.n,1);
}));
test('report section retry reuses the saved section and refuses to recreate a removed one',()=>fixture(()=>{
 const input={sectionKey:'outpatient_advice',title:'合成说明',content:'合成原文内容',requestKey:'section-retry-review-001'};const first=createReportStructuredSection(manager,'report',input);assert.deepEqual(createReportStructuredSection(manager,'report',input),first);assert.equal(getDatabase().prepare('SELECT COUNT(*) AS n FROM report_structured_sections').get()!.n,1);
 getDatabase().prepare('UPDATE report_structured_sections SET is_deleted=1 WHERE id=?').run(first.id);status(()=>createReportStructuredSection(manager,'report',input),409);
}));
test('examination time retry returns the saved state while changed payloads still conflict',()=>fixture(()=>{
 const state=getReportExaminations(manager,'report');const input={version:state.version,reportVersion:state.reportVersion,observationIds:['obs'],examination:{examinationType:'检验',sampledAt:'2026-01-01'},requestKey:'time-retry-review-001'};
 const first=saveReportExamination(manager,'report',input);assert.deepEqual(saveReportExamination(manager,'report',input),first);assert.equal(getDatabase().prepare('SELECT COUNT(*) AS n FROM report_examinations').get()!.n,1);
 status(()=>saveReportExamination(manager,'report',{...input,examination:{...input.examination,sampledAt:'2026-01-02'}}),409);assert.equal(getReportExaminations(manager,'report').version,first.version);
}));
test('manual report facts share the report version and reject a stale edit without overwriting data',()=>fixture(()=>{
 const first=createClinicalFact(manager,'report','diagnosis',{diagnosisText:'合成初始内容',expectedSourceVersion:1});
 const version=getDatabase().prepare("SELECT source_version AS version FROM reports WHERE id='report'").get()!.version;assert.equal(version,2);
 status(()=>updateClinicalFact(manager,'diagnosis',first.id,{diagnosisText:'合成过期修改',expectedSourceVersion:1}),409);
 assert.equal(getDatabase().prepare('SELECT diagnosis_text FROM report_diagnoses WHERE id=?').get(first.id)!.diagnosis_text,'合成初始内容');
 status(()=>createReportStructuredSection(manager,'report',{sectionKey:'outpatient_advice',content:'合成过期内容',expectedSourceVersion:1}),409);
 assert.equal(getDatabase().prepare('SELECT COUNT(*) AS n FROM report_structured_sections').get()!.n,0);
}));
test('date search matches the displayed local timestamp and pagination is bound to the viewing timezone',()=>fixture(()=>{
 createMedicationIntake(manager,{memberId:'member',medicationName:'合成午夜服用',takenAt:'2026-01-02T16:30:00Z',amount:'1'});
 const local=listHealthRecordFeed(manager,{memberId:'member',query:'2026-01-03',timeZone:'Asia/Shanghai'});assert.ok(local.items.some(item=>item.title==='合成午夜服用'));
 assert.ok(!listHealthRecordFeed(manager,{memberId:'member',query:'2026-01-03',timeZone:'UTC'}).items.some(item=>item.title==='合成午夜服用'));
 status(()=>listHealthRecordFeed(manager,{memberId:'member',timeZone:'not/a/timezone'}),400);
 const page=listHealthRecordFeed(manager,{memberId:'member',timeZone:'Asia/Shanghai',limit:1});assert.ok(page.nextCursor);
 status(()=>listHealthRecordFeed(manager,{memberId:'member',timeZone:'UTC',cursor:page.nextCursor!}),400);
}));
test('actual symptom dates cannot be future plans and rejected writes leave no empty process or observation',()=>fixture(()=>{
 const db=getDatabase();const count=db.prepare('SELECT COUNT(*) AS n FROM health_episodes').get()!.n;
 status(()=>createPublicSymptom(manager,{memberId:'member',name:'合成未来症状',startedAt:'2099-01-01'}),400);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM health_episodes').get()!.n,count);
 const symptom=createPublicSymptom(manager,{memberId:'member',name:'合成实际症状'});status(()=>createProcessSymptomUpdate(manager,symptom.episodeId,symptom.id,{recordedAt:'2099-01-01',change:'unchanged'}),400);
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM health_process_symptom_updates WHERE symptom_id=?').get(symptom.id)!.n,0);
}));
