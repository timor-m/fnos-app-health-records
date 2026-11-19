import {readDoctorContext,updateDoctorContext} from '../services/doctor-context.service';
import {mutateStandaloneTrash as removeRecordForTest} from '../services/health-record-trash.service';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDatabaseForTests,getDatabase } from '../database/client';
import type { RequestUser } from '../domain/request-user';
import { getRecordProcess,linkProcessRecords } from '../services/health-record-process.service';
import { getHealthProcessCare,quickRecordProcess } from '../services/health-process-care.service';
import { readHealthRecordIndex } from '../services/health-record-index.service';
import { updateRecordProcess } from '../services/health-record-process.service';
import { formatMedicationFrequency } from '../../shared/medication-frequency';
import { createPublicSymptom } from '../services/public-symptom.service';
import { createProcessSymptomUpdate,correctProcessSymptomUpdate,retractProcessSymptomUpdate,readProcessSymptoms } from '../services/symptom-episode.service';
import { createMedicationCourse,createMedicationIntake,changeMedicationCourse,getMedicationIntake } from '../services/medication.service';
import { createClinicalFact } from '../services/clinical-fact.service';
const user:RequestUser={id:'manager',displayName:'合成账号',authenticated:true,provider:'development',isGatewayAdmin:true};
async function fixture(run:(id:string)=>unknown){
 const previous=process.env.STORAGE_DIR;const dir=mkdtempSync(join(tmpdir(),'health-process-care-'));process.env.STORAGE_DIR=dir;
 try{const db=getDatabase();db.prepare("INSERT INTO users(id,display_name) VALUES('manager','合成账号'),('viewer','合成只读账号')").run();
  for(const id of ['member','other']){db.prepare('INSERT INTO health_members(id,display_name,created_by) VALUES(?,?,?)').run(id,'合成成员','manager');db.prepare("INSERT INTO member_permissions(member_id,user_id,permission,granted_by) VALUES(?,'manager','manager','manager')").run(id);}
  db.prepare("INSERT INTO member_permissions(member_id,user_id,permission,granted_by) VALUES('member','viewer','viewer','manager')").run();
  for(const id of ['a','b'])db.prepare("INSERT INTO reports(id,member_id,created_by,title,report_type,status,report_issued_at,hospital_name_raw,clinical_diagnosis) VALUES(?,'member','manager',?,'outpatient','ready','2026-01-01','合成机构','合成报告诊断')").run(id,'合成报告 '+id);
  const process=linkProcessRecords(user,{kind:'report',id:'a'},[{kind:'report',id:'b'}])[0];await run(process.id);
 }finally{closeDatabaseForTests();if(previous===undefined)delete process.env.STORAGE_DIR;else process.env.STORAGE_DIR=previous;rmSync(dir,{recursive:true,force:true});}
}
const symptom=(name='发热')=>createPublicSymptom(user,{memberId:'member',name,startedAt:'2026-01-01',relatedRecords:[{kind:'report',id:'a'}]});
const update=(s:ReturnType<typeof symptom>,at:string,value:string,unit='℃')=>createProcessSymptomUpdate(user,s.episodeId,s.id,{recordedAt:at,measurementValue:value,measurementUnit:unit});
const fingerprint=(id:string)=>getRecordProcess(user,id).fingerprint;
test('common symptom creates one original record and observation atomically; continued records reuse its identity and current fingerprint',()=>fixture(id=>{
 const input={kind:'new_symptom',target:'咳嗽',fingerprint:fingerprint(id),recordedAt:'2026-01-02T08:00',change:'worsened',description:'合成首次变化',requestKey:'common-first-key-001'};
 const first=quickRecordProcess(user,id,input);assert.ok(first.symptomId);assert.equal(first.fingerprint,fingerprint(id));
 assert.equal(quickRecordProcess(user,id,input).id,first.id);
 const second=quickRecordProcess(user,id,{...input,kind:'symptom',target:first.symptomId,fingerprint:first.fingerprint,recordedAt:'2026-01-02T12:00',change:'improved',requestKey:'common-next-key-001'});
 assert.notEqual(second.id,first.id);assert.equal(second.symptomId,first.symptomId);
 const care=getHealthProcessCare(user,id);assert.equal(care.symptoms.filter(s=>s.name==='咳嗽').length,1);assert.match(care.summaryByDay!,/2026-01-02/);assert.match(care.summaryByDay!,/合成首次变化/);
 const before=getRecordProcess(user,id).recordCount;
 assert.throws(()=>quickRecordProcess(user,id,{...input,fingerprint:fingerprint(id),target:'皮疹',recordedAt:'2999-01-01',requestKey:'common-future-key-001'}));
 assert.equal(getRecordProcess(user,id).recordCount,before);assert.ok(!getHealthProcessCare(user,id).symptoms.some(s=>s.name==='皮疹'));
}));
test('temperature chart and daily summary use the same retained source readings and viewer date boundaries',()=>fixture(id=>{
 const s=symptom();update(s,'2026-01-01T23:30:00Z','38.1');update(s,'2026-01-02T01:00:00Z','37.0');
 const care=getHealthProcessCare(user,id,'Asia/Shanghai');assert.equal(care.temperature!.readings!.length,2);assert.equal(care.temperature!.recordedDays,1);assert.equal(care.temperature!.thresholdDays,1);
 assert.match(care.summaryByDay!,/2026-01-02/);assert.match(care.summaryByDay!,/07:30/);assert.match(care.summaryByDay!,/38.1 ℃/);
}));
test('lifecycle dates remain explicit metadata, retain source dates and enforce date, member and stale-edit guards',()=>fixture(id=>{
 const before=getRecordProcess(user,id);const values={fingerprint:before.fingerprint,editToken:before.editToken,lifecycle:{status:'resolved',onsetAt:'2025-12-30',endedAt:'2026-01-03'}};
 const saved=updateRecordProcess(user,id,values);assert.equal(saved.startedAt,before.startedAt);assert.deepEqual({...saved.lifecycle},values.lifecycle);assert.notEqual(saved.editToken,before.editToken);
 assert.throws(()=>updateRecordProcess(user,id,values));
 for(const lifecycle of [{status:'resolved',onsetAt:'2026-01-03',endedAt:'2026-01-01'},{status:'active',onsetAt:null,endedAt:'2026-01-01'},{status:'resolved',onsetAt:'2999-01-01',endedAt:null},{status:'bogus',onsetAt:null,endedAt:null}])assert.throws(()=>updateRecordProcess(user,id,{fingerprint:saved.fingerprint,editToken:saved.editToken,lifecycle}));
 const viewer={...user,id:'viewer',isGatewayAdmin:false};assert.throws(()=>updateRecordProcess(viewer,id,{fingerprint:saved.fingerprint,editToken:saved.editToken,lifecycle:values.lifecycle}));
 assert.equal(getRecordProcess(user,id).lifecycle!.onsetAt,'2025-12-30');
}));
test('diagnosis and symptom index deduplicates sources, scopes pages and reads current original records and processes',()=>fixture(id=>{
 createClinicalFact(user,'a','diagnosis',{diagnosisText:'合成报告诊断'});createClinicalFact(user,'a','medication',{medicationName:'合成索引药品'});
 const s=symptom('合成自述症状');
 const page=readHealthRecordIndex(user,'member',{kind:'diagnosis',limit:1});assert.equal(page.entries[0].count,2);
 const detail=readHealthRecordIndex(user,'member',{kind:'diagnosis',name:'合成报告诊断',limit:1});assert.equal(detail.total,2);assert.equal(detail.processes[0].id,id);assert.ok(detail.nextCursor);
 const next=readHealthRecordIndex(user,'member',{kind:'diagnosis',name:'合成报告诊断',limit:1,cursor:detail.nextCursor});assert.notEqual(detail.records[0].ref.id,next.records[0].ref.id);
 assert.throws(()=>readHealthRecordIndex(user,'other',{kind:'diagnosis',name:'合成报告诊断',cursor:detail.nextCursor}));
 const symptoms=readHealthRecordIndex(user,'member',{kind:'symptom',name:'合成自述症状'});assert.equal(symptoms.records[0].ref.id,s.id);
 getDatabase().prepare("UPDATE reports SET status='trashed' WHERE id='a'").run();assert.equal(readHealthRecordIndex(user,'member',{name:'合成报告诊断'}).total,1);
 assert.equal(readHealthRecordIndex(user,'member',{q:'不存在的合成名称'}).total,0);
 const viewer={...user,id:'viewer',isGatewayAdmin:false};assert.equal(readHealthRecordIndex(viewer,'member',{}).total,1);assert.throws(()=>readHealthRecordIndex(viewer,'other',{}));
}));
test('frequency explanations preserve unknown text and never rewrite or infer combined prescriptions',()=>{
 for(const [raw,expected] of [['b.i.d.','b.i.d.（每日两次）'],['q8h','q8h（每8小时一次）'],['每日一次','每日一次'],['qd prn','qd prn'],['q0h','q0h'],['合成特殊频次','合成特殊频次']])assert.equal(formatMedicationFrequency(raw),expected);
});
test('summary uses original diagnoses, prescriptions and confirmed/intake data, without treating prescriptions as taken',()=>fixture(id=>{
 createClinicalFact(user,'a','medication',{medicationName:'合成处方药品',dose:'5',doseUnit:'ml',frequency:'bid'});
 const s=symptom('合成咳嗽');createProcessSymptomUpdate(user,s.episodeId,s.id,{recordedAt:'2026-01-02T08:00',change:'worsened',description:'合成变化'});
 const course=createMedicationCourse(user,{memberId:'member',medicationName:'合成确认药品',confirmed:true,startedAt:'2026-01-01',processId:id});
 createMedicationIntake(user,{memberId:'member',courseId:course.id,takenAt:'2026-01-02T08:00',amount:'2',amountUnit:'片'});
 const care=getHealthProcessCare(user,id);assert.match(care.summaryText,/合成报告诊断/);assert.match(care.summaryText,/合成机构/);assert.match(care.summaryText,/报告所列用药（不代表已服用）/);assert.match(care.summaryText,/实际服药/);assert.match(care.summaryText,/2片/);
 assert.equal(care.medications.find(m=>m.origin==='prescription')!.amount,'');assert.equal(care.medications.find(m=>m.origin==='course')!.amount,'2');assert.equal(care.temperature,null);
}));
test('temperature summary counts explicit Celsius readings, days in viewer timezone and excludes unrelated, nonnumeric and withdrawn values',()=>fixture(id=>{
 const s=symptom();update(s,'2026-01-01T16:30:00Z','38.2');update(s,'2026-01-02T08:00:00Z','37.5','°C');update(s,'2026-01-03T08:00:00Z','36.8');update(s,'2026-01-04T08:00:00Z','偏高');update(s,'2026-01-05T08:00:00Z','102','°F');
 update(s,'2026-01-06T08:00:00Z','40');const withdrawn=readProcessSymptoms(s.episodeId)[0].updates.at(-1)!;retractProcessSymptomUpdate(user,s.episodeId,s.id,withdrawn.id,{version:withdrawn.version});
 const unrelated=symptom('合成室温');update(unrelated,'2026-01-07T08:00:00Z','42');
 let care=getHealthProcessCare(user,id,'Asia/Shanghai');assert.equal(care.temperature!.count,3);assert.equal(care.temperature!.recordedDays,2);assert.equal(care.temperature!.thresholdDays,1);assert.equal(care.temperature!.highest.value,38.2);assert.equal(care.temperature!.latest.value,36.8);
 care=getHealthProcessCare(user,id,'UTC');assert.equal(care.temperature!.thresholdDays,2);assert.equal(care.temperature!.recordedDays,3);assert.throws(()=>getHealthProcessCare(user,id,'bad/timezone'));
 const first=readProcessSymptoms(s.episodeId)[0].updates[0];correctProcessSymptomUpdate(user,s.episodeId,s.id,first.id,{version:first.version,measurementValue:'37.0'});assert.equal(getHealthProcessCare(user,id).temperature!.highest.value,37.5);
}));
test('symptom repeat writes to the original symptom once, preserves time validation and rejects stale or unrelated targets',()=>fixture(id=>{
 const s=symptom();const input={kind:'symptom',target:s.id,fingerprint:fingerprint(id),recordedAt:'2026-01-02T08:00',measurementValue:'38.1',measurementUnit:'℃',requestKey:'symptom-repeat-key-001'};
 const first=quickRecordProcess(user,id,input);const repeated=quickRecordProcess(user,id,input);assert.equal(first.id,repeated.id);assert.equal(readProcessSymptoms(s.episodeId)[0].updates.length,1);assert.equal(getRecordProcess(user,id).recordCount,3);
 assert.throws(()=>quickRecordProcess(user,id,{...input,requestKey:'symptom-repeat-key-002'}),e=>(e as {statusCode:number}).statusCode===409);
 assert.throws(()=>quickRecordProcess(user,id,{...input,fingerprint:fingerprint(id),requestKey:'symptom-repeat-key-003',recordedAt:'2999-01-01'}));
 assert.throws(()=>quickRecordProcess(user,id,{...input,fingerprint:fingerprint(id),target:'unrelated',requestKey:'symptom-repeat-key-004'}));
 assert.equal(readProcessSymptoms(s.episodeId)[0].updates.length,1);
}));
test('medication repeat records separate intake rows, reuses only previous actual amount and remains in the process',()=>fixture(id=>{
 const course=createMedicationCourse(user,{memberId:'member',medicationName:'合成药品',confirmed:true,startedAt:'2026-01-01',dose:'9',doseUnit:'片',processId:id});
 const choice=getHealthProcessCare(user,id).medications[0];assert.equal(choice.amount,'');
 const input={kind:'medication',target:choice.key,fingerprint:fingerprint(id),recordedAt:'2026-01-02T08:00',amount:'1',amountUnit:'片',requestKey:'medication-repeat-key-001'};
 const first=quickRecordProcess(user,id,input);assert.equal(first.id,quickRecordProcess(user,id,input).id);assert.ok(getRecordProcess(user,id).records.some(r=>r.ref.id===first.id));
 const second=quickRecordProcess(user,id,{...input,fingerprint:fingerprint(id),recordedAt:'2026-01-02T12:00',requestKey:'medication-repeat-key-002'});assert.notEqual(first.id,second.id);
 const care=getHealthProcessCare(user,id);assert.equal(care.medications.filter(m=>m.origin==='course').length,1);assert.equal(care.medications[0].amount,'1');assert.match(care.summaryText,/2026-01-02 合成药品 2次/);removeRecordForTest(user,'intake',second.id,{revision:1},'trash');assert.doesNotMatch(getHealthProcessCare(user,id).summaryText,/12:00/);assert.equal(getDatabase().prepare('SELECT dose FROM medication_courses WHERE id=?').get(course.id)!.dose,'9');
}));
test('a prescription quick intake never creates or confirms a medication course',()=>fixture(id=>{
 createClinicalFact(user,'a','medication',{medicationName:'合成处方药',dose:'5',doseUnit:'ml'});
 const choice=getHealthProcessCare(user,id).medications[0];quickRecordProcess(user,id,{kind:'medication',target:choice.key,fingerprint:fingerprint(id),recordedAt:'2026-01-02T08:00',amount:'3',amountUnit:'ml',requestKey:'prescription-intake-key-001'});
 assert.equal(getDatabase().prepare('SELECT COUNT(*) AS n FROM medication_courses').get()!.n,0);const care=getHealthProcessCare(user,id);assert.equal(care.medications.length,1);assert.equal(care.medications[0].amount,'3');assert.match(care.summaryText,/不代表已服用/);assert.match(care.summaryText,/实际服药/);
}));
test('a changed medication snapshot does not prefill a previous formulation amount',()=>fixture(id=>{
 const course=createMedicationCourse(user,{memberId:'member',medicationName:'合成药品',confirmed:true,startedAt:'2026-01-01',specification:'合成规格甲',processId:id});
 createMedicationIntake(user,{memberId:'member',courseId:course.id,takenAt:'2026-01-02T08:00',amount:'2',amountUnit:'ml'});assert.equal(getHealthProcessCare(user,id).medications[0].amount,'2');
 changeMedicationCourse(user,course.id,{action:'adjust',revision:course.revision,occurredAt:'2026-01-03T08:00',specification:'合成规格乙'});assert.equal(getHealthProcessCare(user,id).medications[0].amount,'');
}));
test('viewer can read but cannot record; foreign/unlinked/trash data never enters summaries or recording choices',()=>fixture(id=>{
 const s=symptom();const viewer={...user,id:'viewer',isGatewayAdmin:false};assert.equal(getHealthProcessCare(viewer,id).memberId,'member');assert.throws(()=>quickRecordProcess(viewer,id,{kind:'symptom',target:s.id}),e=>(e as {statusCode:number}).statusCode===403);
 const other=createPublicSymptom(user,{memberId:'other',name:'合成其他成员症状',startedAt:'2026-01-01'});assert.doesNotMatch(getHealthProcessCare(user,id).summaryText,/合成其他成员/);assert.throws(()=>quickRecordProcess(user,id,{kind:'symptom',target:other.id,fingerprint:fingerprint(id),requestKey:'foreign-symptom-key-001'}));
 getDatabase().prepare("UPDATE health_process_symptoms SET deleted_at=CURRENT_TIMESTAMP WHERE id=?").run(s.id);assert.equal(getHealthProcessCare(user,id).symptoms.length,0);
}));
test('HTTP care and quick recording routes preserve the request identity and validate payloads',()=>fixture(async id=>{
 const {H3}=await import('h3');const {default:read}=await import('../routes/api/health-processes/[id]/care.get');const {default:write}=await import('../routes/api/health-processes/[id]/quick-record.post');
 const s=symptom();const http=new H3();http.use(event=>{event.context.requestUser=user;});http.get('/api/health-processes/:id/care',read);http.post('/api/health-processes/:id/quick-record',write);
 const response=await http.request(`http://localhost/api/health-processes/${id}/care?timeZone=UTC`);assert.equal(response.status,200);const care=(await response.json()).data;assert.equal(care.symptoms[0].id,s.id);
 const payload={kind:'symptom',target:s.id,fingerprint:care.fingerprint,recordedAt:'2026-01-02T08:00',change:'improved',requestKey:'http-quick-record-key-001'};
 const saved=await http.request(`http://localhost/api/health-processes/${id}/quick-record`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});assert.equal(saved.status,200);assert.equal((await saved.json()).data.kind,'symptom');assert.equal(readProcessSymptoms(s.episodeId)[0].updates.length,1);
 const invalid=await http.request(`http://localhost/api/health-processes/${id}/quick-record`,{method:'POST',headers:{'Content-Type':'application/json'},body:'[]'});assert.equal(invalid.status,400);
}));

test('quick prescription intake stores exact source; same-name prescriptions never share actual-dose prefills',()=>fixture(id=>{
 const a=createClinicalFact(user,'a','medication',{medicationName:'合成同名药',dose:'9',specification:'合成规格'});
 const b=createClinicalFact(user,'b','medication',{medicationName:'合成同名药',dose:'9',specification:'合成规格'});
 const input={kind:'medication',target:'prescription:'+a.id,fingerprint:fingerprint(id),recordedAt:'2026-01-02T08:00',amount:'2',amountUnit:'片',requestKey:'exact-source-quick-key-001'};
 const result=quickRecordProcess(user,id,input);const intake=getMedicationIntake(user,result.id);
 assert.equal(intake.sourceReportId,'a');assert.equal(intake.source?.medicationId,a.id);assert.equal(intake.courseId,null);
 let care=getHealthProcessCare(user,id);assert.equal(care.medications.find(m=>m.key==='prescription:'+a.id)!.amount,'2');assert.equal(care.medications.find(m=>m.key==='prescription:'+b.id)!.amount,'');
 getDatabase().prepare('DELETE FROM report_medications WHERE id=?').run(a.id);
 care=getHealthProcessCare(user,id);const repeat=care.medications.find(m=>m.key==='intake:'+intake.id)!;assert.ok(repeat);
 const next=quickRecordProcess(user,id,{...input,target:repeat.key,fingerprint:care.fingerprint,recordedAt:'2026-01-03T08:00',requestKey:'exact-source-quick-key-002'});
 assert.deepEqual(getMedicationIntake(user,next.id).source,intake.source);assert.equal(getMedicationIntake(user,next.id).sourceReportId,'a');
 assert.equal(getDatabase().prepare('SELECT COUNT(*) AS n FROM medication_courses').get()!.n,0);
}));
test('unproven older same-name intakes remain distinct from prescriptions',()=>fixture(id=>{
 const fact=createClinicalFact(user,'a','medication',{medicationName:'合成同名药'});
 const intake=createMedicationIntake(user,{memberId:'member',medicationName:'合成同名药',takenAt:'2026-01-02',amount:'3',processId:id});
 const care=getHealthProcessCare(user,id);assert.equal(care.medications.find(m=>m.key==='prescription:'+fact.id)!.amount,'');assert.ok(care.medications.some(m=>m.key==='intake:'+intake.id));
}));

test('doctor summary includes member context, report conclusions and original advice in both layouts without inferring missing values',()=>fixture(id=>{
 const db=getDatabase();db.exec("UPDATE health_members SET birth_date='2020-01-01',sex='female' WHERE id='member'; UPDATE reports SET summary='合成报告结论',impression='合成报告印象',recommendation='合成原报告建议' WHERE id='a'; INSERT INTO report_structured_sections(id,report_id,section_key,section_title,content_text,source) VALUES('section','a','checkup_final_conclusion','合成总检结论','合成相关正常结论','manual')");
 const before=getHealthProcessCare(user,id);assert.ok(before.doctorContext);assert.match(before.summaryText,/过敏及不良反应：未填写/);assert.match(before.summaryText,/女｜出生 2020-01-01/);
 const saved=updateDoctorContext(user,id,{...before.doctorContext,allergies:'不清楚',history:'合成病史',medications:'合成长期用药',concern:'合成就诊诉求',requestKey:'doctor-context-test-key-001'});
 const care=getHealthProcessCare(user,id);for(const text of [care.summaryText,care.summaryByDay!])for(const value of ['合成报告结论','合成报告印象','合成原报告建议','合成相关正常结论','合成就诊诉求','过敏及不良反应：不清楚'])assert.ok(text.includes(value),value);
 const otherProcess=linkProcessRecords(user,{kind:'report',id:'a'},[{kind:'report',id:'b'}])[0];assert.equal(readDoctorContext(user,otherProcess.id).allergies,'不清楚');
 assert.equal(saved.concern,'合成就诊诉求');assert.ok(!care.summaryText.includes('无过敏'));
}));
test('doctor background save is scoped, atomic, revision checked and retry safe without overriding lifecycle metadata',()=>fixture(id=>{
 const db=getDatabase();const process=getRecordProcess(user,id);updateRecordProcess(user,id,{fingerprint:process.fingerprint,editToken:process.editToken,lifecycle:{status:'active',onsetAt:'2026-01-01',endedAt:null}});
 const original=readDoctorContext(user,id),input={...original,allergies:'明确无已知过敏',history:'',medications:'',concern:'合成诉求',requestKey:'doctor-context-retry-key-001'};
 const result=updateDoctorContext(user,id,input);assert.deepEqual(updateDoctorContext(user,id,input),result);assert.equal(getRecordProcess(user,id).lifecycle!.onsetAt,'2026-01-01');
 assert.throws(()=>updateDoctorContext(user,id,{...input,requestKey:'doctor-context-stale-key-001'}),e=>(e as {statusCode:number}).statusCode===409);
 assert.throws(()=>updateDoctorContext({...user,id:'viewer',isGatewayAdmin:false},id,{...result}),e=>(e as {statusCode:number}).statusCode===403);
 assert.throws(()=>updateDoctorContext(user,id,{...result,memberId:'other'}),e=>(e as {statusCode:number}).statusCode===403);
 assert.throws(()=>updateDoctorContext(user,id,{...result,allergies:'should rollback',concern:'x'.repeat(2001),requestKey:'doctor-context-invalid-key-001'}));assert.equal(readDoctorContext(user,id).allergies,result.allergies);
 db.exec("INSERT INTO reports(id,member_id,created_by,title,status,report_type) VALUES('c','member','manager','合成丙','ready','laboratory'),('d','member','manager','合成丁','ready','laboratory')");const second=linkProcessRecords(user,{kind:'report',id:'c'},[{kind:'report',id:'d'}])[0];const context=readDoctorContext(user,second.id);assert.equal(context.allergies,result.allergies);assert.equal(context.concern,'');
 updateDoctorContext(user,second.id,{...context,history:'另一历程更新背景',requestKey:'doctor-context-shared-key-001'});assert.throws(()=>updateDoctorContext(user,id,{...result,concern:'旧背景覆盖',requestKey:'doctor-context-conflict-key-001'}));
}));
test('concern-only saves preserve the member background and read the same values maintained in member information',()=>fixture(id=>{
 const db=getDatabase();db.prepare("UPDATE health_members SET care_allergies='不清楚',care_history='Synthetic member history',care_medications='Synthetic member medication' WHERE id='member'").run();const context=readDoctorContext(user,id);
 const saved=updateDoctorContext(user,id,{memberId:'member',version:context.version,concern:'Synthetic concern only',requestKey:'doctor-concern-only-key-001'});assert.equal(saved.allergies,'不清楚');assert.equal(saved.history,'Synthetic member history');assert.equal(saved.medications,'Synthetic member medication');assert.match(getHealthProcessCare(user,id).summaryText,/Synthetic member history/);
}));

test('quick choices expose the latest retained observation and actual intake without inferring current state',()=>fixture(id=>{
 const s=symptom();update(s,'2026-01-02T08:00','38.2');update(s,'2026-01-01T08:00','39.1');
 const course=createMedicationCourse(user,{memberId:'member',medicationName:'合成药品',confirmed:true,startedAt:'2026-01-01',processId:id});
 let care=getHealthProcessCare(user,id);assert.equal(care.symptoms[0].latest!.measurementValue,'38.2');assert.equal(care.symptoms[0].latest!.recordedAt,'2026-01-02T08:00');assert.equal(care.medications.find(m=>m.key==='course:'+course.id)!.lastTakenAt,null);
 const intake=createMedicationIntake(user,{memberId:'member',courseId:course.id,medicationName:'合成药品',amount:'2',amountUnit:'片',takenAt:'2026-01-02T09:00'});
 care=getHealthProcessCare(user,id);const drug=care.medications.find(m=>m.key==='course:'+course.id)!;assert.equal(drug.lastTakenAt,intake.takenAt);assert.equal(drug.amount,'2');
}));

test('attached body temperature on headache enters the chart, survives retries and corrections without reclassifying legacy measurements',()=>fixture(id=>{
 const s=symptom('头痛');update(s,'2026-01-02T08:00','12','次');
 const input={kind:'symptom',target:s.id,fingerprint:fingerprint(id),recordedAt:'2026-01-03T08:00',change:'unchanged',temperatureValue:'37.8',requestKey:'attached-temperature-key-001'};
 const saved=quickRecordProcess(user,id,input);assert.equal(quickRecordProcess(user,id,input).id,saved.id);
 let care=getHealthProcessCare(user,id);assert.equal(care.temperature!.count,1);assert.equal(care.temperature!.latest.value,37.8);assert.match(care.summaryText,/体温 37.8 ℃/);
 const entry=readProcessSymptoms(s.episodeId)[0].updates.find(entry=>entry.id===saved.id)!;
 assert.equal(entry.measurementValue,null);assert.equal(entry.temperatureValue,'37.8');
 correctProcessSymptomUpdate(user,s.episodeId,s.id,entry.id,{version:entry.version,temperatureValue:'37.1'});
 care=getHealthProcessCare(user,id);assert.equal(care.temperature!.latest.value,37.1);
 const revised=readProcessSymptoms(s.episodeId)[0].updates.find(entry=>entry.id===saved.id)!;
 retractProcessSymptomUpdate(user,s.episodeId,s.id,revised.id,{version:revised.version});assert.equal(getHealthProcessCare(user,id).temperature,null);
 for(const value of ['偏高','-1','0','NaN'])assert.throws(()=>quickRecordProcess(user,id,{...input,fingerprint:fingerprint(id),temperatureValue:value,requestKey:'invalid-temp-'+value}));
}));
