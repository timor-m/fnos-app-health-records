import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {getDatabase,closeDatabaseForTests} from '../database/client';
import {examinationDuplicateResolver,setExaminationDuplicateDecision,listExaminationRelationships} from '../services/examination-duplicate.service';
import {listTrendSeries} from '../services/records.service';
import {normalizeReportObservations} from '../services/indicator-normalization.service';
import type {RequestUser} from '../domain/request-user';

test('examination duplicate decisions require strong identity, preserve sources, and enforce permission and versions',()=>{
 const env={...process.env},directory=mkdtempSync(join(tmpdir(),'exam-duplicate-'));process.env.STORAGE_DIR=directory;
 try{
  const db=getDatabase();
  db.exec(`INSERT INTO users(id,display_name) VALUES('owner','synthetic'),('viewer','synthetic');
   INSERT INTO health_members(id,display_name,relationship,created_by) VALUES('m','synthetic','other','owner'),('other','synthetic','other','owner');
   INSERT INTO member_permissions(member_id,user_id,permission,granted_by) VALUES('m','owner','manager','owner'),('m','viewer','viewer','owner'),('other','owner','manager','owner');`);
  const owner:RequestUser={id:'owner',displayName:'synthetic',provider:'development',authenticated:true,isGatewayAdmin:false};
  for(const [id,member] of [['a','m'],['b','m'],['c','other']]){
   db.prepare("INSERT INTO reports(id,member_id,created_by,report_type,title,status) VALUES(?,?,'owner','laboratory','synthetic','ready')").run(id,member);
   db.prepare("INSERT INTO report_examinations(id,report_id,source_key,institution,report_number,examination_type,occurred_at,time_kind,confirmation_status) VALUES(?,?,'source','synthetic institution','EXAM-1','检验','2026-09-08','sampled','confirmed')").run(id,id);
  }
  for(const [id,report] of [['oa','a'],['oa-copy','a'],['ob','b']]){
   db.prepare("INSERT INTO observations(id,report_id,section_name,item_name,normalized_name,result_text,numeric_value,unit,reference_low,reference_high,reference_text) VALUES(?,?,'生化检验','肌酸激酶','肌酸激酶','80',80,'U/L',40,200,'40-200')").run(id,report);
   db.prepare("INSERT INTO observation_examinations(observation_id,examination_id,assignment_source) VALUES(?,?,'manual')").run(id,report);
  }
  normalizeReportObservations('a');normalizeReportObservations('b');
  const points=()=>listTrendSeries(owner,'m').flatMap(series=>series.points);
  assert.equal(points().length,1,'same examination counts once within and across reports');
  assert.equal(points()[0].duplicateSources?.length,3,'all references remain accessible');
  db.exec("UPDATE observations SET reference_high=180,reference_text='40-180' WHERE id='ob'");normalizeReportObservations('b');
  assert.equal(points().length,2,'different reference ranges remain separately inspectable even with equal results');
  db.exec("UPDATE observations SET reference_high=200,reference_text='40-200' WHERE id='ob'");normalizeReportObservations('b');
  assert.equal(points().length,1);
  db.exec("UPDATE observations SET result_text='90',numeric_value=90 WHERE id='ob'");normalizeReportObservations('b');
  assert.equal(points().length,2);assert.ok(points().every(p=>p.examinationConflict),'cross-report conflicting values are never silently removed');
  db.exec("UPDATE observations SET result_text='80',numeric_value=80 WHERE id='ob'");normalizeReportObservations('b');
  assert.equal(examinationDuplicateResolver()('a','b'),true);
  const listed=listExaminationRelationships({...owner,id:'viewer'},'a');
  assert.deepEqual(listed.relatedExaminations.map(e=>e.id),['a','b']);
  assert.equal(listed.relationships[0].decision,'automatic');
  assert.equal(examinationDuplicateResolver()('a','c'),false);
  db.exec("UPDATE report_examinations SET report_number='' WHERE id='b'");
  assert.equal(examinationDuplicateResolver()('a','b'),false,'date and value alone are insufficient');
  const decision={leftId:'a',rightId:'b',leftVersion:Number(db.prepare("SELECT source_version FROM reports WHERE id='a'").get()!.source_version),rightVersion:Number(db.prepare("SELECT source_version FROM reports WHERE id='b'").get()!.source_version),decision:'same' as const};
  assert.throws(()=>setExaminationDuplicateDecision({...owner,id:'viewer'},decision));
  setExaminationDuplicateDecision(owner,decision);
  assert.equal(examinationDuplicateResolver()('a','b'),true);
  assert.throws(()=>setExaminationDuplicateDecision(owner,decision),/已修改/);
  setExaminationDuplicateDecision(owner,{...decision,leftVersion:decision.leftVersion+1,rightVersion:decision.rightVersion+1,decision:'different'});
  db.exec("UPDATE report_examinations SET report_number='EXAM-1' WHERE id='b'");
  assert.equal(examinationDuplicateResolver()('a','b'),false,'explicit unlink overrides automatic identity');
  assert.equal(points().length,2,'unlink restores independent measurements');
  db.exec("UPDATE reports SET status='trashed' WHERE id='a'");
  assert.equal(examinationDuplicateResolver()('a','b'),false);
  assert.equal(points().length,1);assert.equal(points()[0].reportId,'b','surviving source remains in trends');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM report_examinations').get()!.n,3,'decisions and trash never delete examinations');
  assert.throws(()=>db.prepare("INSERT INTO examination_duplicate_decisions(left_id,right_id,decision) VALUES('b','c','same')").run(),/member_mismatch/);
  db.exec("UPDATE reports SET status='ready' WHERE id='a'");
  const leftVersion=Number(db.prepare("SELECT source_version FROM reports WHERE id='a'").get()!.source_version);
  const rightVersion=Number(db.prepare("SELECT source_version FROM reports WHERE id='b'").get()!.source_version);
  setExaminationDuplicateDecision(owner,{leftId:'a',rightId:'b',leftVersion,rightVersion,decision:'same'});
  db.exec(`INSERT INTO report_examinations(id,report_id,source_key,occurred_at,time_kind,confirmation_status) VALUES('later','b','later','2026-09-15','sampled','confirmed');
   INSERT INTO observations(id,report_id,section_name,item_name,normalized_name,result_text,numeric_value,unit,reference_low,reference_high,reference_text) VALUES('later-result','b','生化检验','肌酸激酶','肌酸激酶','80',80,'U/L',40,200,'40-200');
   INSERT INTO observation_examinations(observation_id,examination_id,assignment_source) VALUES('later-result','later','manual');`);
  normalizeReportObservations('b');
  assert.deepEqual(points().map(p=>[p.reportIssuedAt,p.numericValue]),[['2026-09-08',80],['2026-09-15',80]],'a partially duplicated archive preserves its additional equal-valued examination');
  assert.equal(points()[0].duplicateSources?.length,3);
 }finally{closeDatabaseForTests();process.env=env;rmSync(directory,{recursive:true,force:true});}
});
