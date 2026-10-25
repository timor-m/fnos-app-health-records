import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {getDatabase,closeDatabaseForTests} from '../database/client.ts';
import {createManualObservation,updateManualObservation,applyObservationFieldOverrides} from '../services/observation-field-overrides.service.ts';
import {normalizeAiExtraction,persistAiExtraction} from '../services/ai-extraction.service.ts';
import {getReportDetail} from '../services/records.service.ts';

test('page supplement is report-scoped, version checked, retained on reparse and follows page identity',()=>{
 const root=mkdtempSync(join(tmpdir(),'source-page-'));const previous=process.env.STORAGE_DIR;process.env.STORAGE_DIR=root;
 try {
  const db=getDatabase();
  db.exec(`INSERT INTO users(id,display_name) VALUES('u','测试');
   INSERT INTO health_members(id,display_name,created_by) VALUES('m','测试','u');
   INSERT INTO member_permissions(member_id,user_id,permission,granted_by) VALUES('m','u','manager','u');
   INSERT INTO reports(id,member_id,created_by,report_type,title,status) VALUES('r','m','u','laboratory','测试','ready'),('other','m','u','laboratory','测试','ready');
   INSERT INTO report_pages(id,report_id,page_number,original_name,storage_path,mime_type,file_size,sha256) VALUES
    ('p1','r',1,'synthetic.png','synthetic/1.png','image/png',1,'a'),('p2','r',2,'synthetic.png','synthetic/2.png','image/png',1,'b'),('foreign','other',1,'synthetic.png','synthetic/3.png','image/png',1,'c');`);
  const user={id:'u',displayName:'测试',provider:'local' as const,authenticated:true,isGatewayAdmin:false};
  const input={itemName:'合成项目',resultText:'42',numericValue:42,unit:'U/L',sourcePageId:'p2',sourceRegion:{box:[.1,.2,.8,.3],rotation:0}};
  assert.throws(()=>createManualObservation(user,'r',{...input,sourcePageId:'foreign'}));
  assert.throws(()=>createManualObservation(user,'r',{...input,sourcePageId:12}));
  assert.throws(()=>createManualObservation(user,'r',{...input,expectedSourceVersion:999}));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM observations').get()!.n,0);
  for (const sourceRegion of [{box:[-.1,0,.5,.5],rotation:0},{box:[.1,.2,.1,.3],rotation:0},{box:[0,0,1,1],rotation:45},{box:[0,0,Infinity,1],rotation:0}]) assert.throws(()=>createManualObservation(user,'r',{...input,sourceRegion}));
  assert.throws(()=>createManualObservation(user,'r',{...input,sourceRegion:{box:[0,0,1,1],rotation:90}}));
  createManualObservation(user,'r',input);
  assert.equal(getReportDetail(user,'r').observations[0].evidence?.pageId,'p2');
  assert.deepEqual(getReportDetail(user,'r').observations[0].evidence?.region,[.1,.2,.8,.3]);
  const manualId=getReportDetail(user,'r').observations[0].id;
  updateManualObservation(user,'r',manualId,{...input,sourceRegion:{box:[.1,.4,.8,.5],rotation:0}});
  assert.deepEqual(getReportDetail(user,'r').observations[0].evidence?.region,[.1,.4,.8,.5]);
  updateManualObservation(user,'r',manualId,{itemName:input.itemName,resultText:'42',numericValue:42,unit:'U/L'});
  assert.deepEqual(getReportDetail(user,'r').observations[0].evidence?.region,[.1,.4,.8,.5]);
  db.exec("UPDATE report_pages SET page_number=3 WHERE id='p1';UPDATE report_pages SET page_number=1 WHERE id='p2';UPDATE report_pages SET page_number=2 WHERE id='p1'");
  const reapplied=applyObservationFieldOverrides('r',[]);
  assert.equal(reapplied.length,1);
  assert.equal(reapplied[0].observation.evidence[0].pageId,'p2');
  assert.equal(reapplied[0].observation.evidence[0].pageNumber,1);
  assert.equal(getReportDetail(user,'r').observations[0].evidence?.pageId,'p2');
  for (const pageId of ['p1','p2']) {
    db.prepare("INSERT INTO processing_jobs(id,report_id,page_id,job_type,status,pipeline_version,deduplication_key) VALUES(?, 'r', ?, 'ocr','completed','test',?)").run(`ocr-${pageId}`,pageId,`ocr-${pageId}`);
    db.prepare("INSERT INTO ocr_results(id,job_id,page_id,engine,model_version,lines_json,text_length) VALUES(?,?,?,'test','test',?,20)").run(`result-${pageId}`,`ocr-${pageId}`,pageId,JSON.stringify([{id:`line-${pageId}`,text:'合成标题',confidence:1,box:[0,0,100,20]}]));
  }
  db.exec(`INSERT INTO processing_jobs(id,report_id,job_type,pipeline_version,deduplication_key) VALUES('rerun','r','ai_extract','test','rerun');`);
  const result={provider:'test',model:'test',promptVersion:'test',...normalizeAiExtraction({reportType:'laboratory',observations:[]}),rawResponseJson:'{}',promptTokens:0,completionTokens:0,elapsedMs:0,
    recovery:{completed:true as const,supplementUnits:0,visionRequested:false,unresolvedCandidates:0,measurementCandidates:0}};
  persistAiExtraction('r','rerun',result,0);
  const after=getReportDetail(user,'r').observations;
  assert.equal(after.length,1);
  assert.equal(after[0].evidence?.pageId,'p2');
  assert.equal(after[0].resultText,'42');
  assert.deepEqual(after[0].evidence?.region,[.1,.4,.8,.5]);
  db.exec("UPDATE report_pages SET mime_type='application/pdf',rotation=90 WHERE id='p2'");
  assert.deepEqual(getReportDetail(user,'r').observations[0].evidence?.region,[.5,.1,.6,.8]);
  assert.deepEqual(getReportDetail(user,'r').observations[0].evidence?.readingRegion,[.1,.4,.8,.5]);
  db.exec("UPDATE report_pages SET sha256='changed' WHERE id='p2'");
  assert.equal(getReportDetail(user,'r').observations[0].evidence?.region,undefined);
  db.exec("DELETE FROM report_pages WHERE id='p2'");
  assert.equal(getReportDetail(user,'r').observations[0].evidence,null);
  assert.equal(applyObservationFieldOverrides('r',[])[0].observation.evidence[0].pageNumber,undefined);
  createManualObservation(user,'r',{...input,sourcePageId:'',sourceRegion:null});
  assert.equal(getReportDetail(user,'r').observations.length,2);
  const original={sectionName:null,itemCode:null,itemName:'合成自动',resultText:'7',numericValue:7,unit:'U/L',referenceLow:null,referenceHigh:null,referenceText:null,abnormalFlag:null,normalizedName:null,method:null,evidence:[{pageNumber:2,quote:'合成自动 7'}]};
  db.prepare("INSERT INTO observations(id,report_id,item_name,result_text,numeric_value,unit,evidence_json) VALUES('auto','r',?, '7',7,'U/L',?)").run(original.itemName,JSON.stringify(original.evidence));
  updateManualObservation(user,'r','auto',{...original,sourcePageId:'p1',sourceRegion:{box:[.1,.1,.5,.2],rotation:0}});
  const matched=applyObservationFieldOverrides('r',[original]).filter(entry=>entry.observation.itemName==='合成自动');
  assert.equal(matched.length,1);
  assert.deepEqual(matched[0].observation.evidence[0].manualRegion,{box:[.1,.1,.5,.2],rotation:0,pageSha256:'a'});
 } finally {closeDatabaseForTests();if(previous===undefined)delete process.env.STORAGE_DIR;else process.env.STORAGE_DIR=previous;rmSync(root,{recursive:true,force:true});}
});
