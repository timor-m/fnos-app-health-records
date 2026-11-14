import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {H3} from 'h3';
import {closeDatabaseForTests,getDatabase} from '../database/client';
import create from '../routes/api/reports/[id]/morphology-findings.post';
import update from '../routes/api/morphology-findings/[id].put';
import ignore from '../routes/api/morphology-findings/[id]/ignore.post';
import {listMorphologyTracking,rebuildMorphologyTrackingForMember} from '../services/morphology-finding.service';
import {getReportDetail} from '../services/records.service';
import {normalizeAiExtraction,persistAiExtraction} from '../services/ai-extraction.service';
import type {RequestUser} from '../domain/request-user';

test('manual morphology uses real report pages, respects member permissions and survives AI reruns including deletion',async()=>{
 const previous=process.env.STORAGE_DIR;const storage=mkdtempSync(join(tmpdir(),'morphology-management-'));process.env.STORAGE_DIR=storage;
 try {
  const db=getDatabase();
  db.exec(`INSERT INTO users(id,display_name) VALUES('owner','Synthetic'),('viewer','Synthetic'),('stranger','Synthetic');
   INSERT INTO health_members(id,display_name,created_by) VALUES('member','Synthetic','owner'),('other','Synthetic','stranger');
   INSERT INTO member_permissions(member_id,user_id,permission,granted_by) VALUES('member','owner','manager','owner'),('member','viewer','viewer','owner'),('other','stranger','manager','stranger');
   INSERT INTO reports(id,member_id,created_by,report_type,title,status,report_issued_at) VALUES('report','member','owner','imaging','Synthetic','ready','2026-01-02'),('foreign','other','stranger','imaging','Synthetic','ready','2026-01-03');
   INSERT INTO report_pages(id,report_id,page_number,original_name,storage_path,mime_type,file_size,sha256) VALUES('p1','report',1,'synthetic','synthetic.png','image/png',1,'s1'),('p2','report',2,'synthetic','synthetic2.png','image/png',1,'s2'),('p3','foreign',3,'synthetic','synthetic3.png','image/png',1,'s3');
   INSERT INTO processing_jobs(id,report_id,page_id,job_type,pipeline_version,deduplication_key,status) VALUES('ocr1','report','p1','ocr','test','ocr1','completed'),('ocr2','report','p2','ocr','test','ocr2','completed');
   INSERT INTO ocr_results(id,job_id,page_id,engine,model_version,lines_json) VALUES('ocr1','ocr1','p1','test','test','[{"text":"Synthetic source"}]'),('ocr2','ocr2','p2','test','test','[{"text":"Synthetic source"}]');
   INSERT INTO processing_jobs(id,report_id,job_type,pipeline_version,deduplication_key) VALUES('job','report','ai_extract','test','synthetic-morphology');`);
  let user:RequestUser={id:'owner',displayName:'Synthetic',provider:'development',authenticated:true,isGatewayAdmin:false};
  const app=new H3();app.use(event=>{event.context.requestUser=user;});
  app.post('/reports/:id/morphology',create);app.put('/morphology/:id',update);app.post('/morphology/:id/ignore',ignore);
  const req=(url:string,body:unknown,method='POST')=>app.request('http://localhost'+url,{method,headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  const input={organ:'肝脏',region:null,laterality:'unspecified',findingType:'囊肿',findingName:'合成肝囊肿',presence:'present',sizeLength:8,sizeUnit:'mm',rawText:'合成肝囊肿 8mm',sourcePageNumber:1};
  for(const id of ['viewer','stranger']) {
   user={...user,id};assert.equal((await req('/reports/report/morphology',input)).status,403);
  }
  user={...user,id:'owner'};
  assert.equal((await req('/reports/report/morphology',{...input,sourcePageNumber:3})).status,400);
  assert.equal((await req('/reports/report/morphology',{...input,rawText:''})).status,400);
  assert.equal((await req('/reports/report/morphology',{...input,findingName:''})).status,400);
  db.prepare("UPDATE reports SET status='processing' WHERE id='report'").run();
  assert.equal((await req('/reports/report/morphology',input)).status,409);
  db.prepare("UPDATE reports SET status='ready' WHERE id='report'").run();
  assert.equal((await req('/reports/report/morphology',input)).status,200);
  const finding=db.prepare("SELECT id FROM morphology_findings WHERE report_id='report'").get() as {id:string};
  assert.equal(getReportDetail(user,'report').morphologyFindings[0].rawText,input.rawText);
  user={...user,id:'viewer'};
  assert.equal((await req('/morphology/'+finding.id,{sizeLength:99},'PUT')).status,403);
  assert.equal((await req('/morphology/'+finding.id+'/ignore',{})).status,403);
  user={...user,id:'owner'};
  assert.equal((await req('/morphology/'+finding.id,{sourcePageNumber:3,rawText:'wrong'},'PUT')).status,400);
  assert.equal((await req('/morphology/'+finding.id,{sourcePageNumber:2,rawText:input.rawText,sizeLength:9,findingName:'人工校对名称'},'PUT')).status,200);
  let runNumber=0;
  const rerun=(findings:unknown[])=>{ const job='rerun-'+(++runNumber); db.prepare("INSERT INTO processing_jobs(id,report_id,job_type,pipeline_version,deduplication_key) VALUES(?, 'report', 'ai_extract', 'test', ?)").run(job,job); return persistAiExtraction('report',job,{provider:'test',model:'test',promptVersion:'test',...normalizeAiExtraction({reportType:'imaging',morphologyFindings:findings}),rawResponseJson:'{}',promptTokens:0,completionTokens:0,elapsedMs:0},100); };
  const ai={...input,region:'右叶',laterality:'right',size:{length:12,unit:'mm'},evidence:[{pageNumber:1,quote:input.rawText}]};
  rerun([ai]);
  let rows=db.prepare("SELECT id,size_length AS size,evidence_json AS evidence FROM morphology_findings WHERE report_id='report'").all() as Array<{id:string;size:number;evidence:string}>;
  assert.equal(rows.length,1);assert.equal(rows[0].id,finding.id);assert.equal(rows[0].size,9);assert.equal(getReportDetail(user,'report').morphologyFindings[0].findingName,'人工校对名称');assert.equal(JSON.parse(rows[0].evidence)[0].pageNumber,2);
  rerun([]);assert.equal(getReportDetail(user,'report').morphologyFindings[0].id,finding.id);
  assert.equal((await req('/morphology/'+finding.id,{region:'右叶',laterality:'right'},'PUT')).status,200);
  // Exact source text cannot override explicitly conflicting laterality and region.
  rerun([{...ai,region:'左叶',laterality:'left'}]);assert.equal(getReportDetail(user,'report').morphologyFindings.length,2);
  // Similar anatomy without matching source must not overwrite or absorb another lesion.
  rerun([{...ai,rawText:'合成另一处肝囊肿 12mm',evidence:[{pageNumber:1,quote:'合成另一处肝囊肿 12mm'}]}]);
  assert.equal(getReportDetail(user,'report').morphologyFindings.length,2);
  assert.equal((await req('/morphology/'+finding.id+'/ignore',{})).status,200);
  rerun([ai]);rebuildMorphologyTrackingForMember('member');
  assert.equal(getReportDetail(user,'report').morphologyFindings.length,0);
  assert.equal(listMorphologyTracking(user,'member').summary.findings,0);
  assert.equal(listMorphologyTracking(user,'member').untracked.length,0);
  assert.ok(db.prepare("SELECT 1 FROM report_pages WHERE id='p1'").get());
  // An empty later run still retains the deletion marker.
  rerun([]);assert.ok(db.prepare('SELECT id FROM morphology_findings WHERE id=?').get(finding.id));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action IN ('morphology.create','morphology.update','morphology.ignore')").get()?.n,4);
 } finally {closeDatabaseForTests();if(previous===undefined)delete process.env.STORAGE_DIR;else process.env.STORAGE_DIR=previous;rmSync(storage,{recursive:true,force:true});}
});

test('source corrections recalculate automatic examination dates but retain explicitly confirmed dates',async()=>{
 const previous=process.env.STORAGE_DIR;const storage=mkdtempSync(join(tmpdir(),'morphology-source-date-'));process.env.STORAGE_DIR=storage;
 try {
  const db=getDatabase();db.exec(`INSERT INTO users(id,display_name) VALUES('owner','Synthetic');
   INSERT INTO health_members(id,display_name,created_by) VALUES('member','Synthetic','owner');
   INSERT INTO member_permissions(member_id,user_id,permission,granted_by) VALUES('member','owner','manager','owner');
   INSERT INTO reports(id,member_id,created_by,report_type,title,status,report_issued_at) VALUES('report','member','owner','imaging','Synthetic','ready','2026-03-01');
   INSERT INTO report_pages(id,report_id,page_number,original_name,storage_path,mime_type,file_size,sha256) VALUES('p1','report',1,'synthetic','synthetic','image/png',1,'s1'),('p2','report',2,'synthetic','synthetic','image/png',1,'s2');
   INSERT INTO processing_jobs(id,report_id,page_id,job_type,pipeline_version,deduplication_key,status) VALUES('ocr1','report','p1','ocr','test','ocr1','completed'),('ocr2','report','p2','ocr','test','ocr2','completed');
   INSERT INTO ocr_results(id,job_id,page_id,engine,model_version,lines_json) VALUES('ocr1','ocr1','p1','test','test','[{"text":"检查日期：2026-01-01"},{"text":"合成肝囊肿约8mm"}]'),('ocr2','ocr2','p2','test','test','[{"text":"检查日期：2026-02-01"},{"text":"合成肝囊肿约9mm"}]');`);
  const {createMorphologyFinding,updateMorphologyFinding}=await import('../services/morphology-finding.service');
  const user:RequestUser={id:'owner',displayName:'Synthetic',provider:'development',authenticated:true,isGatewayAdmin:false};
  createMorphologyFinding(user,'report',{organ:'肝脏',findingType:'囊肿',findingName:'合成肝囊肿',rawText:'合成肝囊肿约8mm',sourcePageNumber:1});
  const id=(db.prepare('SELECT id FROM morphology_findings').get() as {id:string}).id;
  const date=()=>db.prepare('SELECT e.occurred_at AS date FROM morphology_finding_examinations l JOIN report_examinations e ON e.id=l.examination_id WHERE l.finding_id=?').get(id)?.date;
  assert.equal(date(),'2026-01-01');
  updateMorphologyFinding(user,id,{rawText:'合成肝囊肿约9mm',sourcePageNumber:2});assert.equal(date(),'2026-02-01');
  db.prepare("UPDATE report_examinations SET confirmation_status='confirmed' WHERE occurred_at='2026-02-01'").run();
  updateMorphologyFinding(user,id,{rawText:'合成肝囊肿约8mm',sourcePageNumber:1});assert.equal(date(),'2026-02-01');
 } finally {closeDatabaseForTests();if(previous===undefined)delete process.env.STORAGE_DIR;else process.env.STORAGE_DIR=previous;rmSync(storage,{recursive:true,force:true});}
});
