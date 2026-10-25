import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {getDatabase,closeDatabaseForTests} from '../database/client';
import type {RequestUser} from '../domain/request-user';
import {createPublicSymptom} from '../services/public-symptom.service';
import {createProcessSymptomUpdate,readProcessSymptoms,retractProcessSymptomUpdate} from '../services/symptom-episode.service';
import {createMedicationCourse,createMedicationIntake,getMedicationIntake} from '../services/medication.service';
import {linkProcessRecords,getRecordProcess,removeProcessRecord} from '../services/health-record-process.service';
import {mutateStandaloneTrash} from '../services/health-record-trash.service';
import {listProcessObservations,readHealthObservation,correctHealthObservation,continueSymptomObservation,symptomContinuationCandidates} from '../services/health-observation.service';
const user:RequestUser={id:'manager',displayName:'合成账号',provider:'development',authenticated:true,isGatewayAdmin:true};
const viewer={...user,id:'viewer',isGatewayAdmin:false};
function fixture(run:(processId:string)=>void){const previous=process.env.STORAGE_DIR;const dir=mkdtempSync(join(tmpdir(),'health-observations-'));process.env.STORAGE_DIR=dir;
 try{const db=getDatabase();db.exec("INSERT INTO users(id,display_name) VALUES('manager','合成管理'),('viewer','合成只读'); INSERT INTO health_members(id,display_name,created_by) VALUES('member','合成成员','manager'),('other','合成另一成员','manager'); INSERT INTO member_permissions(member_id,user_id,permission,granted_by) VALUES('member','manager','manager','manager'),('other','manager','manager','manager'),('member','viewer','viewer','manager'); INSERT INTO reports(id,member_id,created_by,title,report_type,status,report_issued_at) VALUES('a','member','manager','合成甲','outpatient','ready','2026-01-01'),('b','member','manager','合成乙','outpatient','ready','2026-01-01'),('other-report','other','manager','合成另一成员资料','outpatient','ready','2026-01-01')");run(linkProcessRecords(user,{kind:'report',id:'a'},[{kind:'report',id:'b'}])[0].id);
 }finally{closeDatabaseForTests();if(previous===undefined)delete process.env.STORAGE_DIR;else process.env.STORAGE_DIR=previous;rmSync(dir,{recursive:true,force:true});}}
function original(processId?:string,name='发热'){return createPublicSymptom(user,{memberId:'member',name,bodyArea:'合成部位',startedAt:'2026-01-01',...(processId?{processId}:{})});}
function observe(s:ReturnType<typeof original>,value='38.2',at='2026-01-02T08:00:00'){createProcessSymptomUpdate(user,s.episodeId,s.id,{recordedAt:at,measurementValue:value,measurementUnit:'℃'});return readProcessSymptoms(s.episodeId)[0].updates.at(-1)!;}
function status(run:()=>unknown,code:number){assert.throws(run,(error:{statusCode?:number})=>error.statusCode===code);}
test('continuation candidates are exact-name, member scoped and restricted to an explicit process or related record context',()=>fixture(processId=>{
 const inside=original(processId),outside=original(),unrelated=original(undefined,'不发热');createPublicSymptom(user,{memberId:'other',name:'发热'});
 assert.deepEqual(symptomContinuationCandidates(user,{memberId:'member',name:' 发热 ',processId}).items.map(i=>i.id),[inside.id]);
 assert.deepEqual(symptomContinuationCandidates(user,{memberId:'member',name:'发热',relatedRecords:[{kind:'report',id:'a'}]}).items.map(i=>i.id),[inside.id]);
 assert.equal(symptomContinuationCandidates(user,{memberId:'member',name:'发热'}).total,2);assert.ok(!symptomContinuationCandidates(user,{memberId:'member',name:'发热'}).items.some(i=>i.id===unrelated.id));
 status(()=>symptomContinuationCandidates(user,{memberId:'member',name:'发热',relatedRecords:[{kind:'report',id:'other-report'}]}),403);
 mutateStandaloneTrash(user,'symptom',outside.id,{revision:readProcessSymptoms(outside.episodeId)[0].version},'trash');assert.equal(symptomContinuationCandidates(user,{memberId:'member',name:'发热'}).total,1);
 assert.equal(symptomContinuationCandidates(viewer,{memberId:'member',name:'发热'}).total,1);
}));
test('continuing adds to the selected identity without changing onset or baseline; retries and association failures are atomic',()=>fixture(processId=>{
 const source=original(processId);const input={memberId:'member',processId,recordedAt:'2026-01-03T10:00:00',measurementValue:'38.4',measurementUnit:'℃',requestKey:'continue-observation-key-001'};
 const first=continueSymptomObservation(user,source.id,input);const before=readProcessSymptoms(source.episodeId)[0];assert.equal(before.updates.length,1);assert.equal(before.startedAt,'2026-01-01');assert.equal(before.bodyArea,'合成部位');assert.equal(first.record.id,source.id);
 assert.equal(continueSymptomObservation(user,source.id,input).ref.id,first.ref.id);assert.equal(readProcessSymptoms(source.episodeId)[0].updates.length,1);
 status(()=>continueSymptomObservation(user,source.id,{...input,measurementValue:'38.5'}),409);
 status(()=>continueSymptomObservation(viewer,source.id,{...input,requestKey:'viewer-observation-key-001'}),403);
 status(()=>continueSymptomObservation(user,source.id,{...input,requestKey:'rollback-observation-key-001',relatedRecords:[{kind:'report',id:'other-report'}]}),403);assert.equal(readProcessSymptoms(source.episodeId)[0].updates.length,1);
 status(()=>continueSymptomObservation(user,source.id,{...input,requestKey:'future-observation-key-001',recordedAt:'2999-01-01T08:00:00'}),400);assert.equal(readProcessSymptoms(source.episodeId)[0].updates.length,1);
}));
test('actual-time observation pages count and filter symptoms, temperatures and actual intakes without mixing prescription doses',()=>fixture(processId=>{
 const fever=original(processId),cough=original(processId,'咳嗽');observe(fever,'38.2','2026-01-03T08:00:00');createProcessSymptomUpdate(user,cough.episodeId,cough.id,{recordedAt:'2026-01-02T08:00:00',change:'worsened',description:'合成变化'});
 const course=createMedicationCourse(user,{confirmed:true,memberId:'member',medicationName:'合成药',startedAt:'2026-01-01',dose:'99',doseUnit:'ml',processId});const intake=createMedicationIntake(user,{memberId:'member',courseId:course.id,takenAt:'2026-01-04T08:00:00',amount:'2',amountUnit:'ml'});
 const page=listProcessObservations(viewer,processId,{limit:1});assert.equal(page.total,3);assert.deepEqual(page.counts,{symptom:1,temperature:1,intake:1});assert.equal(page.items[0].ref.id,intake.id);assert.equal(page.items[0].amount,'2');
 const next=listProcessObservations(user,processId,{limit:1,cursor:page.nextCursor});assert.equal(next.items[0].category,'temperature');assert.equal(listProcessObservations(user,processId,{kind:'symptom'}).items[0].record.id,cough.id);
 status(()=>listProcessObservations(user,processId,{kind:'temperature',cursor:page.nextCursor}),409);
 observe(fever,'37.8','2026-01-05T08:00:00');status(()=>listProcessObservations(user,processId,{cursor:page.nextCursor}),409);
}));
test('a correction edits exactly one symptom observation, preserves revision history and supports lost-response retries',()=>fixture(processId=>{
 const source=original(processId);const update=observe(source);const ref={kind:'symptom' as const,id:update.id};const input={memberId:'member',processId,revision:1,recordedAt:'2026-01-02T09:00:00',measurementValue:'37.8',measurementUnit:'℃',change:null,severity:0,description:'合成纠错',requestKey:'correct-observation-key-001'};
 const corrected=correctHealthObservation(user,ref,input);assert.equal(corrected.ref.id,update.id);assert.equal(corrected.revision,2);assert.equal(corrected.measurementValue,'37.8');assert.equal(corrected.severity,0);assert.equal(readProcessSymptoms(source.episodeId)[0].updates.length,1);
 assert.equal(getDatabase().prepare('SELECT COUNT(*) AS n FROM health_process_symptom_revisions WHERE target_id=?').get(update.id)!.n,1);
 assert.equal(correctHealthObservation(user,ref,input).revision,2);status(()=>correctHealthObservation(user,ref,{...input,requestKey:'different-correction-key-001'}),409);
 status(()=>correctHealthObservation(viewer,ref,{...input,revision:2}),403);status(()=>readHealthObservation(user,ref,'other'),403);
 retractProcessSymptomUpdate(user,source.episodeId,source.id,update.id,{version:2});assert.equal(listProcessObservations(user,processId).total,0);status(()=>readHealthObservation(user,ref,'member'),404);
}));
test('intake correction preserves its source, revisions and exact identity, and trashed observations become inaccessible',()=>fixture(processId=>{
 const course=createMedicationCourse(user,{confirmed:true,memberId:'member',medicationName:'合成药',startedAt:'2026-01-01',processId});const intake=createMedicationIntake(user,{memberId:'member',courseId:course.id,takenAt:'2026-01-02T08:00:00',amount:'1',amountUnit:'片'});
 const ref={kind:'intake' as const,id:intake.id};const input={memberId:'member',processId,revision:intake.revision,recordedAt:'2026-01-02T09:00:00',amount:'2',amountUnit:'片',description:'合成纠错',requestKey:'correct-intake-key-001'};
 const edited=correctHealthObservation(user,ref,input);assert.equal(edited.amount,'2');assert.equal(getMedicationIntake(user,intake.id).courseId,course.id);assert.equal(getMedicationIntake(user,intake.id).history.length,1);
 correctHealthObservation(user,ref,input);assert.equal(getMedicationIntake(user,intake.id).history.length,1);
 mutateStandaloneTrash(user,'intake',intake.id,{revision:edited.revision},'trash');assert.equal(listProcessObservations(user,processId).total,0);status(()=>readHealthObservation(user,ref,'member'),404);
}));

test('moving a symptom out invalidates the old process context but keeps the original observation accessible',()=>fixture(processId=>{
 const source=original(processId);const update=observe(source);const ref={kind:'symptom' as const,id:update.id};const process=getRecordProcess(user,processId);
 removeProcessRecord(user,processId,{fingerprint:process.fingerprint,editToken:process.editToken,record:{kind:'symptom',id:source.id}});
 status(()=>readHealthObservation(user,ref,'member',processId),409);
 status(()=>correctHealthObservation(user,ref,{memberId:'member',processId,revision:1,description:'合成修改',requestKey:'moved-observation-key-001'}),409);
 assert.equal(readHealthObservation(user,ref,'member').measurementValue,'38.2');assert.equal(listProcessObservations(user,processId).total,0);
}));
test('partial corrections retain omitted values and candidate pagination is bound to its source scope',()=>fixture(processId=>{
 const source=original(processId);const update=observe(source);const ref={kind:'symptom' as const,id:update.id};
 const changed=correctHealthObservation(user,ref,{memberId:'member',revision:1,description:'只改说明',requestKey:'partial-observation-key-001'});
 assert.equal(changed.measurementValue,'38.2');assert.equal(changed.measurementUnit,'℃');assert.equal(changed.recordedAt,update.recordedAt);
 for(let i=0;i<21;i++)original(undefined,'咳嗽');
 const input={memberId:'member',name:'咳嗽'};const page=symptomContinuationCandidates(user,input);assert.equal(page.items.length,20);assert.equal(page.total,21);
 const next=symptomContinuationCandidates(user,{...input,cursor:page.nextCursor});assert.equal(next.items.length,1);assert.ok(!page.items.some(item=>item.id===next.items[0].id));
 status(()=>symptomContinuationCandidates(user,{...input,processId,cursor:page.nextCursor}),409);
 original(undefined,'咳嗽');status(()=>symptomContinuationCandidates(user,{...input,cursor:page.nextCursor}),409);
}));

test('attached temperature is explicit, classified and editable on non-fever symptoms',()=>fixture(processId=>{
 const source=original(processId,'头痛');
 const saved=continueSymptomObservation(user,source.id,{memberId:'member',processId,recordedAt:'2026-01-03T10:00',temperatureValue:'37.6',requestKey:'attached-observation-001'});
 assert.equal(saved.temperatureValue,'37.6');assert.equal(saved.category,'temperature');assert.equal(saved.measurementValue,null);
 assert.equal(listProcessObservations(user,processId,{kind:'temperature'}).items.some(item=>item.ref.id===saved.ref.id),true);
 const corrected=correctHealthObservation(user,saved.ref,{memberId:'member',processId,revision:saved.revision,temperatureValue:'36.9'});
 assert.equal(corrected.temperatureValue,'36.9');
 const cleared=correctHealthObservation(user,saved.ref,{memberId:'member',processId,revision:corrected.revision,temperatureValue:null,description:'保留症状补充'});
 assert.equal(cleared.category,'symptom');assert.equal(cleared.temperatureValue,null);
}));
