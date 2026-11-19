import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {getDatabase,closeDatabaseForTests} from '../database/client';
import type {RequestUser} from '../domain/request-user';
import {createPublicSymptom} from '../services/public-symptom.service';
import {readProcessSymptoms} from '../services/symptom-episode.service';
import {getHealthProcessCare} from '../services/health-process-care.service';
import {linkProcessRecords} from '../services/health-record-process.service';
import {measurementsForSymptom} from '../../shared/symptom-measurements';
const user:RequestUser={id:'manager',displayName:'合成账号',authenticated:true,provider:'development',isGatewayAdmin:true};
function fixture(run:(processId:string)=>void){const previous=process.env.STORAGE_DIR;const dir=mkdtempSync(join(tmpdir(),'initial-symptom-measurement-'));process.env.STORAGE_DIR=dir;
 try{const db=getDatabase();db.exec("INSERT INTO users(id,display_name) VALUES('manager','合成管理'),('viewer','合成查看'); INSERT INTO health_members(id,display_name,created_by) VALUES('member','合成成员','manager'); INSERT INTO member_permissions(member_id,user_id,permission,granted_by) VALUES('member','manager','manager','manager'),('member','viewer','viewer','manager'); INSERT INTO reports(id,member_id,created_by,title,report_type,status,report_issued_at) VALUES('a','member','manager','合成资料甲','outpatient','ready','2026-01-01'),('b','member','manager','合成资料乙','outpatient','ready','2026-01-01')");
 run(linkProcessRecords(user,{kind:'report',id:'a'},[{kind:'report',id:'b'}])[0].id);
 }finally{closeDatabaseForTests();if(previous===undefined)delete process.env.STORAGE_DIR;else process.env.STORAGE_DIR=previous;rmSync(dir,{recursive:true,force:true});}}
const measurement={kind:'temperature',value:'38.2',recordedAt:'2026-01-02T08:30:00'};
function counts(){const db=getDatabase();return ['health_episodes','health_process_symptoms','health_process_symptom_updates','health_record_process_records','health_workflow_requests'].filter(name=>db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name)).map(name=>[name,db.prepare(`SELECT COUNT(*) AS n FROM ${name}`).get()!.n]);}
test('first temperature is atomic, separate from onset and immediately available to the existing curve; retries do not duplicate it',()=>fixture(processId=>{
 const input={memberId:'member',name:'发热',startedAt:'2026-01-01',processId,requestKey:'initial-temperature-retry-001',initialMeasurements:[measurement]};
 const saved=createPublicSymptom(user,input);const symptom=readProcessSymptoms(saved.episodeId)[0];
 assert.equal(symptom.startedAt,'2026-01-01');assert.equal(symptom.updates.length,1);assert.equal(symptom.updates[0].measurementValue,'38.2');assert.equal(symptom.updates[0].measurementUnit,'℃');assert.equal(symptom.updates[0].change,null);assert.equal(symptom.updates[0].recordedAt,measurement.recordedAt);
 const care=getHealthProcessCare(user,processId);assert.equal(care.temperature!.count,1);assert.equal(care.temperature!.readings![0].symptomId,saved.id);assert.match(care.summaryByDay!,/38.2/);
 const before=counts();assert.deepEqual(createPublicSymptom(user,input),saved);assert.deepEqual(counts(),before);
 assert.throws(()=>createPublicSymptom(user,{...input,initialMeasurements:[{...measurement,value:'38.5'}]}));assert.deepEqual(counts(),before);
}));
test('temperature is optional, does not fill unknown onset dates and leaves legacy symptom entry unchanged',()=>fixture(()=>{
 const plain=createPublicSymptom(user,{memberId:'member',name:'发热'});assert.equal(readProcessSymptoms(plain.episodeId)[0].updates.length,0);
 const measured=createPublicSymptom(user,{memberId:'member',name:'发热',initialMeasurements:[measurement]});const row=readProcessSymptoms(measured.episodeId)[0];assert.equal(row.startedAt,null);assert.equal(row.updates.length,1);
 const custom=createPublicSymptom(user,{memberId:'member',name:'合成自定义不适'});assert.equal(readProcessSymptoms(custom.episodeId)[0].updates.length,0);
}));
test('invalid, future, pre-onset and mismatched observations never leave a partial symptom or request receipt',()=>fixture(processId=>{
 const before=counts();const cases=[
  {name:'发热',initialMeasurements:[{...measurement,kind:'unregistered'}]},
  {name:'发热',initialMeasurements:[measurement,measurement]},
  ...['','很高','Infinity','1e2','0','-1'].map(value=>({name:'发热',initialMeasurements:[{...measurement,value}]})),
  {name:'发热',initialMeasurements:[{...measurement,recordedAt:'2999-01-01T08:00:00'}]},
  {name:'发热',initialMeasurements:[{...measurement,recordedAt:'2026-01-02'}]},
  {name:'发热',startedAt:'2026-01-03',initialMeasurements:[measurement]},
  {name:'发热',initialMeasurements:null},
 ];
 cases.forEach((fields,index)=>{assert.throws(()=>createPublicSymptom(user,{memberId:'member',processId,requestKey:`invalid-temperature-test-${index}`, ...fields}));assert.deepEqual(counts(),before);});
 assert.throws(()=>createPublicSymptom({...user,id:'viewer',isGatewayAdmin:false},{memberId:'member',name:'发热',initialMeasurements:[measurement]}));assert.deepEqual(counts(),before);
 // An association failure occurs after observation creation and must roll both back.
 assert.throws(()=>createPublicSymptom(user,{memberId:'member',name:'发热',initialMeasurements:[measurement],relatedRecords:[{kind:'report',id:'missing'}]}));assert.deepEqual(counts(),before);
}));
test('the shared registry uses explicit symptom names and never treats negated or unrelated free text as fever',()=>{
 assert.equal(measurementsForSymptom('发热')[0].id,'temperature');assert.equal(measurementsForSymptom(' 发烧 ')[0].unit,'℃');
 for(const name of ['未发热','无发热','担心发热','咳嗽','合成不适'])assert.deepEqual(measurementsForSymptom(name),[]);
});

test('an explicit first temperature can accompany another symptom and is counted once without creating a fever symptom',()=>fixture(processId=>{
 const input={memberId:'member',name:'咳嗽',associatedSymptomsText:'发热、乏力',processId,initialMeasurements:[measurement],requestKey:'attached-initial-temperature-001'};
 const saved=createPublicSymptom(user,input);const symptom=readProcessSymptoms(saved.episodeId)[0];
 assert.equal(symptom.name,'咳嗽');assert.equal(symptom.associatedSymptomsText,'发热、乏力');assert.equal(symptom.updates.length,1);assert.equal(symptom.updates[0].temperatureValue,'38.2');assert.equal(symptom.updates[0].measurementValue,null);assert.equal(symptom.updates[0].measurementUnit,null);
 assert.equal(createPublicSymptom(user,input).id,saved.id);assert.equal(readProcessSymptoms(saved.episodeId)[0].updates.length,1);
 const care=getHealthProcessCare(user,processId);assert.equal(care.temperature!.count,1);assert.equal(care.temperature!.highest.value,38.2);assert.equal(care.symptoms.filter(item=>item.name==='发热').length,0);
 const manual=createPublicSymptom(user,{memberId:'member',name:'头痛',processId,initialMeasurements:[{...measurement,value:'37.5'}]});assert.equal(readProcessSymptoms(manual.episodeId)[0].updates[0].temperatureValue,'37.5');
 assert.equal(getHealthProcessCare(user,processId).temperature!.count,2);
}));
