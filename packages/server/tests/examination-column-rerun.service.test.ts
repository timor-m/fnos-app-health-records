import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {getDatabase,closeDatabaseForTests} from '../database/client';
import {createMember} from '../services/member.service';
import {createUpload} from '../services/upload.service';
import {normalizeAiExtraction,persistAiExtraction} from '../services/ai-extraction.service';
import {updateManualObservation} from '../services/observation-field-overrides.service';
import type {RequestUser} from '../domain/request-user';

test('equal-valued date columns retain their own manual correction across extraction reruns',()=>{
 const env={...process.env},directory=mkdtempSync(join(tmpdir(),'exam-columns-'));process.env.STORAGE_DIR=directory;
 try{
  const db=getDatabase();db.exec("INSERT INTO users(id,display_name) VALUES('owner','synthetic')");
  const user:RequestUser={id:'owner',displayName:'synthetic',provider:'development',authenticated:true,isGatewayAdmin:false};
  const member=createMember(user,{displayName:'合成成员',relationship:'other'});
  const upload=createUpload(user,member.id,[{originalName:'synthetic.png',data:Buffer.from([137,80,78,71,13,10,26,10,1])}]);
  const page=upload.pages[0],ocr=db.prepare("SELECT id FROM processing_jobs WHERE report_id=? AND job_type='ocr'").get(upload.reportId)!;
  const quote='肌酸激酶 | 80 | 80 | U/L';
  db.prepare("INSERT INTO ocr_results(id,job_id,page_id,engine,model_version,lines_json) VALUES('ocr',?,?,'test','test',?)").run(ocr.id,page.id,JSON.stringify([{text:'报告编号：SYNTHETIC'},{text:'项目 | 2026-09-01 | 2026-09-08 | 单位'},{text:quote}]));
  const run=(id:string)=>{
   db.prepare("INSERT INTO processing_jobs(id,report_id,job_type,pipeline_version,deduplication_key,status) VALUES(?,?,'ai_extract','test',?,'completed')").run(id,upload.reportId,id);
   const normalized=normalizeAiExtraction({reportType:'laboratory',observations:[{sectionName:'生化检验',itemName:'肌酸激酶',resultText:'80',numericValue:80,unit:'U/L',evidence:[{pageNumber:1,quote}]}]});
   persistAiExtraction(upload.reportId,id,{...normalized,provider:'test',model:'test',promptVersion:'test',rawResponseJson:'{}',promptTokens:1,completionTokens:1,elapsedMs:1},100);
  };
  const results=()=>db.prepare(`SELECT o.id,o.numeric_value AS value,e.occurred_at AS time,o.evidence_json AS evidence
   FROM observations o JOIN observation_examinations l ON l.observation_id=o.id JOIN report_examinations e ON e.id=l.examination_id WHERE o.report_id=? ORDER BY e.occurred_at`).all(upload.reportId);
  run('first');
  assert.equal(results().length,2);
  const first=results();
  assert.notEqual(JSON.parse(String(first[0].evidence))[0].examinationSourceKey,JSON.parse(String(first[1].evidence))[0].examinationSourceKey);
  updateManualObservation(user,upload.reportId,String(first[1].id),{itemName:'肌酸激酶',resultText:'81',numericValue:81,unit:'U/L'});
  run('second');
  assert.deepEqual(results().map(r=>[r.time,r.value]),[['2026-09-01',80],['2026-09-08',81]]);
 }finally{closeDatabaseForTests();process.env=env;rmSync(directory,{recursive:true,force:true});}
});

test('publication separates same-page examinations and preserves stage-only results as pending',()=>{
 const env={...process.env},directory=mkdtempSync(join(tmpdir(),'exam-layouts-'));process.env.STORAGE_DIR=directory;
 try{
  const db=getDatabase();db.exec("INSERT INTO users(id,display_name) VALUES('owner','synthetic')");
  const user:RequestUser={id:'owner',displayName:'synthetic',provider:'development',authenticated:true,isGatewayAdmin:false};
  const member=createMember(user,{displayName:'合成成员',relationship:'other'});
  const upload=createUpload(user,member.id,[{originalName:'synthetic.png',data:Buffer.from([137,80,78,71,13,10,26,10,2])}]);
  const page=upload.pages[0],ocr=db.prepare("SELECT id FROM processing_jobs WHERE report_id=? AND job_type='ocr'").get(upload.reportId)!;
  const lines=['报告编号：FIRST','采样日期：2026-09-01','肌酸激酶 120 U/L','报告编号：SECOND','采样日期：2026-09-08','肌酸激酶 80 U/L','报告编号：STAGES','出院日期：2026-09-10','项目 | 入院时 | 出院时 | 单位','肌酸激酶 | 150 | 90 | U/L'];
  db.prepare("INSERT INTO ocr_results(id,job_id,page_id,engine,model_version,lines_json) VALUES('ocr',?,?,'test','test',?)").run(ocr.id,page.id,JSON.stringify(lines.map(text=>({text}))));
  const normalized=normalizeAiExtraction({reportType:'laboratory',observations:[
   {sectionName:'检验',itemName:'肌酸激酶',resultText:'120',numericValue:120,unit:'U/L',evidence:[{pageNumber:1,quote:lines[2]}]},
   {sectionName:'检验',itemName:'肌酸激酶',resultText:'80',numericValue:80,unit:'U/L',evidence:[{pageNumber:1,quote:lines[5]}]},
   {sectionName:'检验',itemName:'肌酸激酶',resultText:'150',numericValue:150,unit:'U/L',evidence:[{pageNumber:1,quote:lines[9]}]},
  ]});
  const run=(id:string)=>{
   db.prepare("INSERT INTO processing_jobs(id,report_id,job_type,pipeline_version,deduplication_key,status) VALUES(?,?,'ai_extract','test',?,'completed')").run(id,upload.reportId,id);
   persistAiExtraction(upload.reportId,id,{...normalized,provider:'test',model:'test',promptVersion:'test',rawResponseJson:'{}',promptTokens:1,completionTokens:1,elapsedMs:1},100);
  };
  const results=()=>db.prepare(`SELECT o.numeric_value AS value,e.occurred_at AS time,e.confirmation_status AS status,e.time_text AS label
   FROM observations o JOIN observation_examinations l ON l.observation_id=o.id JOIN report_examinations e ON e.id=l.examination_id WHERE o.report_id=? ORDER BY o.numeric_value`).all(upload.reportId);
  run('layout-first');
  assert.deepEqual(results().map(r=>[r.value,r.time,r.status]),[[80,'2026-09-08','automatic'],[90,null,'pending'],[120,'2026-09-01','automatic'],[150,null,'pending']]);
  assert.equal(results().find(r=>r.value===90)?.label,'出院时');
  assert.equal(results().find(r=>r.value===150)?.label,'入院时');
  const first=results();run('layout-retry');assert.deepEqual(results(),first,'retry does not duplicate rows or assign discharge dates to stage labels');
  db.prepare("UPDATE report_examinations SET occurred_at=NULL,time_kind='unknown',time_precision='unknown',confirmation_status='pending' WHERE report_id=? AND occurred_at='2026-09-01'").run(upload.reportId);
  assert.equal(results().find(r=>r.value===120)?.status,'pending');
  run('layout-resolve-pending');
  assert.deepEqual(results(),first,'retry resolves automatic pending dates from clear source evidence without manual confirmation');

 }finally{closeDatabaseForTests();process.env=env;rmSync(directory,{recursive:true,force:true});}
});
