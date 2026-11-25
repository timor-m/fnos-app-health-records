import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {getDatabase,closeDatabaseForTests} from '../database/client';
import {createMember,setMemberPermission} from '../services/member.service';
import {createUpload} from '../services/upload.service';
import {getReportExaminations,saveReportExamination} from '../services/report-examination.service';
import {getReportDetail,listTrendSeries} from '../services/records.service';
import {normalizeReportObservations} from '../services/indicator-normalization.service';
import type {RequestUser} from '../domain/request-user';

test('page time confirmation protects dates, source boundaries, examination identity, permissions and retries',()=>{
 const dir=mkdtempSync(join(tmpdir(),'page-time-')),env={...process.env};process.env.STORAGE_DIR=dir;
 try{
  const db=getDatabase();db.exec("INSERT INTO users(id,display_name) VALUES('owner','Synthetic'),('viewer','Synthetic')");
  db.exec("INSERT INTO user_identities(id,user_id,provider,subject) VALUES('identity-owner','owner','development','owner'),('identity-viewer','viewer','development','viewer')");
  const owner:RequestUser={id:'owner',displayName:'Synthetic',provider:'development',authenticated:true,isGatewayAdmin:false};
  const member=createMember(owner,{displayName:'Synthetic',relationship:'other'});
  setMemberPermission(owner,member.id,{userId:'viewer',permission:'viewer',version:0});
  const report=createUpload(owner,member.id,[{originalName:'synthetic.pdf',data:Buffer.from('%PDF-1.4\n%%EOF')}]);
  db.prepare("UPDATE reports SET status='ready',report_type='laboratory' WHERE id=?").run(report.reportId);
  const firstPage=db.prepare('SELECT id FROM report_pages WHERE report_id=?').get(report.reportId) as {id:string};
  db.prepare("INSERT INTO report_pages(id,report_id,page_number,original_name,storage_path,mime_type,file_size,sha256) VALUES('second',?,2,'synthetic.png','synthetic.png','image/png',1,'synthetic')").run(report.reportId);
  for(const [id,status,date,specimen,reportNumber] of [['pending','pending',null,'serum','SYN-A'],['urine','pending',null,'urine','SYN-B'],['automatic','automatic','2026-08-01','',''],['confirmed','confirmed','2026-08-02','','']] as const){
   db.prepare("INSERT INTO report_examinations(id,report_id,source_key,examination_type,specimen,report_number,occurred_at,confirmation_status) VALUES(?,?,?,'检验',?,?,?,?)").run(id,report.reportId,id,specimen,reportNumber,date,status);
  }
  for(const [id,exam,page,assignment] of [['anchor','pending',1,'automatic'],['peer','urine',1,'automatic'],['other-page','pending',2,'automatic'],['automatic-row','automatic',1,'automatic'],['confirmed-row','confirmed',1,'automatic'],['manual-row','pending',1,'manual'],['ambiguous','pending',0,'automatic'],['missing','pending',-1,'automatic'],['wrong-id','pending',3,'automatic']] as const){
   const evidence=page===0?[{pageNumber:1,quote:'Synthetic'},{pageNumber:2,quote:'Synthetic'}]:page===-1?[]:[{pageNumber:page===3?1:page,pageId:page===3?'foreign-page':page===1?firstPage.id:'second',quote:'肌酸激酶 120 U/L'}];
   db.prepare("INSERT INTO observations(id,report_id,item_name,result_text,numeric_value,unit,reference_low,reference_high,evidence_json) VALUES(?,?,'肌酸激酶','120',120,'U/L',40,200,?)").run(id,report.reportId,JSON.stringify(evidence));
   db.prepare('INSERT INTO observation_examinations(observation_id,examination_id,assignment_source) VALUES(?,?,?)').run(id,exam,assignment);
  }
  normalizeReportObservations(report.reportId);
  const raw=db.prepare('SELECT * FROM observations ORDER BY id').all();
  const initial=getReportExaminations(owner,report.reportId);
  assert.deepEqual(initial.pageTimeGroups,[{pageNumber:1,observationIds:['anchor','peer']},{pageNumber:2,observationIds:['other-page']}]);
  const body={version:initial.version,reportVersion:initial.reportVersion,requestKey:'time-page-synthetic-request',observationIds:['anchor'],applyToPage:true,examination:{sampledAt:'2026-09-01'}};
  assert.throws(()=>saveReportExamination({...owner,id:'viewer'},report.reportId,body));
  assert.throws(()=>saveReportExamination(owner,report.reportId,{...body,version:-1}));
  assert.throws(()=>saveReportExamination(owner,report.reportId,{...body,requestKey:'invalid',applyToPage:'yes'}));
  for(const id of ['missing','wrong-id','ambiguous','confirmed-row','manual-row']) assert.throws(()=>saveReportExamination(owner,report.reportId,{...body,observationIds:[id]}));
  db.prepare('UPDATE report_examinations SET evidence_json=? WHERE id=?').run(JSON.stringify([{pageNumber:99,quote:'Synthetic'}]),'urine');
  const beforeFailure=getReportExaminations(owner,report.reportId);
  assert.throws(()=>saveReportExamination(owner,report.reportId,body));
  assert.deepEqual(getReportExaminations(owner,report.reportId),beforeFailure,'a later examination failure rolls back the whole page');
  db.prepare("UPDATE report_examinations SET evidence_json='[]' WHERE id='urine'").run();
  const after=saveReportExamination(owner,report.reportId,body);
  assert.deepEqual(saveReportExamination(owner,report.reportId,body),after,'retry must return the saved result');
  assert.throws(()=>saveReportExamination(owner,report.reportId,{...body,requestKey:'another-request-key'}));
  for(const id of ['anchor','peer']){
   const observation=after.observations.find(item=>item.observationId===id)!;
   const exam=after.examinations.find(item=>item.id===observation.examinationId)!;
   assert.equal(exam.occurredAt,'2026-09-01');assert.equal(exam.timePrecision,'date');assert.equal(exam.confirmationStatus,'confirmed');
   assert.equal(exam.specimen,id==='anchor'?'serum':'urine');assert.equal(exam.reportNumber,id==='anchor'?'SYN-A':'SYN-B');
  }
  for(const before of initial.observations.filter(item=>!['anchor','peer'].includes(item.observationId))) assert.deepEqual(after.observations.find(item=>item.observationId===before.observationId),before);
  for(const exam of initial.examinations) assert.deepEqual(after.examinations.find(item=>item.id===exam.id),exam,'old examination must not change');
  assert.deepEqual(db.prepare('SELECT * FROM observations ORDER BY id').all(),raw,'raw results and evidence are retained');
  const detail=getReportDetail(owner,report.reportId);
  assert.equal(detail.observations.find(item=>item.id==='anchor')!.examinationTime,'2026-09-01');
  assert.equal(detail.observations.find(item=>item.id==='other-page')!.examinationTime,null);
  const series=listTrendSeries(owner,member.id).find(item=>item.indicatorKey==='laboratory_ck');
  assert.ok(series?.points.some(item=>item.observationId==='anchor'),'confirmed point enters trend');
  assert.ok(!series?.points.some(item=>item.observationId==='other-page'),'other page stays pending');
 }finally{closeDatabaseForTests();process.env=env;rmSync(dir,{recursive:true,force:true});}
});
