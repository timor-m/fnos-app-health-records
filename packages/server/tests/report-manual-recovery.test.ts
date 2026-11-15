import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {getDatabase,closeDatabaseForTests} from '../database/client.ts';
import {createUpload} from '../services/upload.service.ts';
import {saveAiSettings} from '../services/ai-settings.service.ts';
import {processNextJob,type WorkerExecutor} from '../services/job-runner.service.ts';
import {getReportDetail,updateReportFields,confirmReportReady} from '../services/records.service.ts';
import {createManualObservation} from '../services/observation-field-overrides.service.ts';
import type {RequestUser} from '../domain/request-user.ts';
const manager:RequestUser={id:'u',displayName:'合成管理员',authenticated:true,isGatewayAdmin:false,provider:'development'};

test('failed extraction can be manually corrected, supplemented and archived without rewriting its source or failed job',async()=>{
  const root=mkdtempSync(join(tmpdir(),'b0014-manual-recovery-'));const previous=process.env.STORAGE_DIR;process.env.STORAGE_DIR=root;
  try {
    const db=getDatabase();db.exec(`INSERT INTO users(id,display_name) VALUES('u','合成管理员'),('reader','合成只读用户');
      INSERT INTO health_members(id,display_name,created_by) VALUES('m','合成档案','u');
      INSERT INTO member_permissions(member_id,user_id,permission,granted_by) VALUES('m','u','manager','u'),('m','reader','viewer','u');`);
    saveAiSettings({enabled:true,baseUrl:'https://synthetic.example.test/v1',textModel:'synthetic',apiKey:'synthetic-test-key'});
    const upload=createUpload(manager,'m',[{originalName:'synthetic.png',data:Uint8Array.from([137,80,78,71,13,10,26,10,49])}]);
    const worker:WorkerExecutor=async request=>request.action==='thumbnail'?{ok:true,width:100,height:100,elapsedMs:1}:
      {ok:true,engine:'synthetic',modelVersion:'test',elapsedMs:1,lines:[{text:'合成项目 1.5 U/L',confidence:1}]};
    const failAi=async()=>{throw Object.assign(new Error('Synthetic AI extraction failure'),{code:'AI_NO_VERIFIED_OBSERVATIONS'});};
    let extractionFailed=false;
    for(let i=0;i<5;i++) {
      try { if(!await processNextJob(worker,failAi)) break; }
      catch(error) {assert.match(String(error),/Synthetic AI extraction failure/);extractionFailed=true;}
    }
    assert.equal(extractionFailed,true);
    const failed=getReportDetail(manager,upload.reportId);assert.equal(failed.status,'failed');assert.equal(failed.observations.length,0);
    const page=db.prepare('SELECT storage_path AS path FROM report_pages WHERE report_id=?').get(upload.reportId)!;
    const original=readFileSync(join(root,String(page.path)));
    const failedJobs=db.prepare("SELECT id,status,error_message FROM processing_jobs WHERE report_id=? AND status='failed'").all(upload.reportId);
    assert.ok(failedJobs.length>0);
    updateReportFields(manager,upload.reportId,{title:'合成人工归档',reportType:'laboratory',reportIssuedAt:'2026-01-01',expectedSourceVersion:failed.sourceVersion});
    assert.equal(getReportDetail(manager,upload.reportId).status,'failed','saving fields must not silently archive');
    createManualObservation(manager,upload.reportId,{itemName:'合成补录项目',resultText:'1.5',numericValue:1.5,unit:'U/L',sourcePageId:failed.pages[0].id});
    assert.throws(()=>confirmReportReady({...manager,id:'reader'},upload.reportId),/权限/);
    db.prepare("INSERT INTO processing_jobs(id,report_id,job_type,status,pipeline_version,deduplication_key) VALUES('running',?,'ai_extract','processing','test','manual-running')").run(upload.reportId);
    assert.throws(()=>confirmReportReady(manager,upload.reportId),/仍在处理中/);
    assert.equal(getReportDetail(manager,upload.reportId).status,'failed');
    db.prepare("UPDATE processing_jobs SET status='cancelled' WHERE id='running'").run();
    assert.equal(confirmReportReady(manager,upload.reportId).status,'ready');
    const reopened=getReportDetail(manager,upload.reportId);assert.equal(reopened.status,'ready');assert.equal(reopened.title,'合成人工归档');
    assert.equal(reopened.observations.length,1);assert.equal(reopened.observations[0].itemName,'合成补录项目');
    assert.equal(reopened.observations[0].evidence?.pageId,failed.pages[0].id);
    assert.deepEqual(readFileSync(join(root,String(page.path))),original);
    assert.deepEqual(db.prepare("SELECT id,status,error_message FROM processing_jobs WHERE report_id=? AND status='failed'").all(upload.reportId),failedJobs);
    const audits=()=>db.prepare("SELECT detail_json FROM audit_logs WHERE target_id=? AND action='report.confirm_ready'").all(upload.reportId);
    assert.equal(audits().length,1);assert.equal(JSON.parse(String(audits()[0].detail_json)).manualConfirmation,true);
    confirmReportReady(manager,upload.reportId);assert.equal(audits().length,1,'repeat archive is idempotent');
  } finally {closeDatabaseForTests();if(previous===undefined)delete process.env.STORAGE_DIR;else process.env.STORAGE_DIR=previous;rmSync(root,{recursive:true,force:true});}
});
