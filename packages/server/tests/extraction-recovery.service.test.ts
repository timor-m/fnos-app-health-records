import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {getDatabase,closeDatabaseForTests} from '../database/client.ts';
import {executeAiExtractionPlan} from '../services/ai-extraction-orchestrator.service.ts';
import {normalizeAiExtraction,persistAiExtraction,type AiExtractionResult,type AiObservation} from '../services/ai-extraction.service.ts';
import {getReportDetail,listTrendSeries} from '../services/records.service.ts';
import {observationSourceCovered,collectUnverifiedPreviousObservations,readUnverifiedPreviousObservations} from '../services/extraction-review.service.ts';
import {createManualObservation} from '../services/observation-field-overrides.service.ts';
import {groupVisionReviewPages,acceptVisionObservations} from '../services/ai-vision-review.service.ts';
import {snapshotPublishedRecords,assertPublishedRecordsRetained} from '../services/page-append-result-guard.service.ts';
import type {RequestUser} from '../domain/request-user.ts';
const user:RequestUser={id:'owner',displayName:'合成用户',authenticated:true,provider:'fnos_gateway',isGatewayAdmin:false};
const result=(observations:Partial<AiObservation>[]=[]):AiExtractionResult=>({provider:'test',model:'test',promptVersion:'test',
  ...normalizeAiExtraction({observations}),rawResponseJson:'{}',promptTokens:0,completionTokens:0,elapsedMs:0});
const one=(name:string,value:string,unit:string,quote:string)=>({itemName:name,resultText:value,numericValue:Number(value),unit,evidence:[{pageNumber:1,quote}]});
async function withReport(lines:string[],run:(db:ReturnType<typeof getDatabase>)=>Promise<void>){
  const dir=mkdtempSync(join(tmpdir(),'extraction-recovery-')),previous=process.env.STORAGE_DIR;
  process.env.STORAGE_DIR=dir;
  try{const db=getDatabase();db.exec(`
    INSERT INTO users(id,display_name) VALUES('owner','合成用户');
    INSERT INTO health_members(id,display_name,created_by) VALUES('member','合成档案','owner');
    INSERT INTO member_permissions(member_id,user_id,permission,granted_by) VALUES('member','owner','manager','owner');
    INSERT INTO reports(id,member_id,created_by,report_type,title,status,report_issued_at) VALUES('report','member','owner','laboratory','合成报告','ready','2026-01-01');
    INSERT INTO report_pages(id,report_id,page_number,original_name,mime_type,storage_path,file_size,sha256)
      VALUES('page','report',1,'synthetic.png','image/png','synthetic.png',1,'synthetic');
    INSERT INTO processing_jobs(id,report_id,page_id,job_type,status,pipeline_version,deduplication_key)
      VALUES('ocr','report','page','ocr','completed','test','ocr');
    INSERT INTO processing_jobs(id,report_id,job_type,status,pipeline_version,deduplication_key)
      VALUES('ai','report','ai_extract','processing','test','ai');
    INSERT INTO app_settings(setting_key,value_json) VALUES('ai.provider','{"extractionDepth":"overview"}');
  `);const raw=lines.map((text,index)=>({id:`line-${index}`,text,confidence:.99}));
  db.prepare("INSERT INTO ocr_results(id,job_id,page_id,engine,model_version,lines_json,text_length) VALUES('ocr-result','ocr','page','test','test',?,?)")
    .run(JSON.stringify(raw),JSON.stringify(raw).length);
  await run(db);
  }finally{closeDatabaseForTests();if(previous===undefined)delete process.env.STORAGE_DIR;else process.env.STORAGE_DIR=previous;rmSync(dir,{recursive:true,force:true});}
}
function old(db:ReturnType<typeof getDatabase>,id:string,name:string,value:string,unit:string,quote:string){
  db.prepare('INSERT INTO observations(id,report_id,item_name,result_text,numeric_value,unit,evidence_json) VALUES(?,\'report\',?,?,?,?,?)')
    .run(id,name,value,Number(value),unit,JSON.stringify([{pageNumber:1,quote}]));
}

test('existing detailed mode can supplement omissions while healthy overview results make no extra calls',async()=>{
  const first='合成指标甲 1.2 mmol/L 参考范围 1.0-20.0',second='血小板计数 205 10^9/L 参考范围 125-350';
  await withReport(['检验报告',first,second],async()=>{
    getDatabase().prepare("UPDATE app_settings SET value_json='{\"extractionDepth\":\"detailed\"}' WHERE setting_key='ai.provider'").run();
    const calls:string[]=[];let visual=0;
    const output=await executeAiExtractionPlan('ai','report',async request=>{
      calls.push(request.promptMode || 'standard');return result([one('合成指标甲','1.2','mmol/L',first),
        ...(request.promptMode==='supplement'?[one('血小板计数','205','10^9/L',second)]:[])]);
    },{visionReview:async()=>{visual++;return null;}});
    assert.deepEqual(calls,['standard','supplement']);assert.equal(visual,0);
    assert.equal(output.unmatchedCandidates,0);assert.equal(output.result.fields.observations.length,2);
    assert.equal(output.result.recovery?.supplementUnits,1);
  });
  await withReport(['项目 | 结果 | 单位','血红蛋白 | 120 | g/L'],async()=>{
    let visual=0,supplements=0;
    const output=await executeAiExtractionPlan('ai','report',async request=>{if(request.promptMode==='supplement')supplements++;return result();},
      {visionReview:async()=>{visual++;return null;}});
    assert.equal(supplements,0);assert.equal(visual,0);assert.equal(output.result.fields.observations.length,1);
  });
});

test('a missing unit alone does not add text or visual calls in either extraction depth',async()=>{
  for(const depth of ['overview','detailed']) await withReport(['项目 | 结果 | 单位','血红蛋白 | 12 |'],async db=>{
    db.prepare("UPDATE app_settings SET value_json=? WHERE setting_key='ai.provider'").run(JSON.stringify({extractionDepth:depth}));
    let visual=0,supplements=0;
    const output=await executeAiExtractionPlan('ai','report',async request=>{if(request.promptMode==='supplement')supplements++;return result();},
      {visionReview:async()=>{visual++;return null;}});
    assert.equal(visual,0);assert.equal(supplements,0);
    assert.equal(output.result.fields.observations[0].unit,null);
  });
});

test('failed execution or an unreviewed empty publication preserves old results transactionally',async()=>{
  await withReport(['检验报告','合成指标甲 7'],async db=>{
    old(db,'old','合成旧项','12','U/L','合成旧项 | 12 | U/L');
    assert.throws(()=>persistAiExtraction('report','ai',result(),1),{code:'AI_NO_VERIFIED_OBSERVATIONS'});
    await assert.rejects(executeAiExtractionPlan('ai','report',async()=>{throw Object.assign(new Error('synthetic network failure'),{code:'AI_NETWORK_ERROR'});}),{code:'AI_NETWORK_ERROR'});
    assert.equal(db.prepare('SELECT count(*) n FROM observations').get()?.n,1);
    assert.equal(db.prepare('SELECT count(*) n FROM report_extractions').get()?.n,0);
  });
});

test('a completed extraction withdraws old points into one comparison snapshot, never trends',async()=>{
  await withReport(['检验报告','合成指标甲 7'],async db=>{
    old(db,'old','合成旧项','12','U/L','合成旧项 | 12 | U/L');
    const output=await executeAiExtractionPlan('ai','report',async()=>result(),{visionReview:async()=>null});
    persistAiExtraction('report','ai',output.result,output.inputCharacters);
    assert.equal(db.prepare('SELECT count(*) n FROM observations').get()?.n,0);
    assert.equal(listTrendSeries(user,'member').length,0);
    const detail=getReportDetail(user,'report');assert.equal('unverifiedPreviousObservations' in detail,false);
    assert.equal(readUnverifiedPreviousObservations('report')[0].resultText,'12');
    db.exec("INSERT INTO processing_jobs(id,report_id,job_type,status,pipeline_version,deduplication_key) VALUES('again','report','ai_extract','processing','test','again')");
    const again=await executeAiExtractionPlan('again','report',async()=>result(),{visionReview:async()=>null});
    persistAiExtraction('report','again',again.result,again.inputCharacters);
    assert.equal(readUnverifiedPreviousObservations('report').length,1,'retries replace a single comparison list');
  });
});

test('partial overview publishes verified items without extra model calls and withdraws the missing source, without keeping old active values',async()=>{
  const first='合成指标甲 1.2 mmol/L 参考范围 1.0-20.0',second='血小板计数 205 10^9/L 参考范围 125-350';
  await withReport(['检验报告',first,second],async db=>{
    old(db,'a','合成指标甲','1.2','mmol/L',first);old(db,'b','血小板计数','205','10^9/L',second);
    let supplement=0;
    const output=await executeAiExtractionPlan('ai','report',async request=>{if(request.promptMode==='supplement')supplement++;return result([one('合成指标甲','1.2','mmol/L',first)]);},
      {visionReview:async()=>null});
    assert.equal(supplement,0);assert.equal(output.unmatchedCandidates,1);
    persistAiExtraction('report','ai',output.result,output.inputCharacters);
    assert.equal(db.prepare('SELECT count(*) n FROM observations').get()?.n,1);
    assert.equal(listTrendSeries(user,'member').length,1);
    const prior=readUnverifiedPreviousObservations('report');assert.equal(prior.length,1);assert.equal(prior[0].itemName,'血小板计数');
    const version=db.prepare("SELECT source_version version FROM reports WHERE id='report'").get()?.version;
    assert.throws(()=>createManualObservation(user,'report',{itemName:'血小板计数',resultText:'205',numericValue:205,unit:'10^9/L',previousObservationIndex:0,expectedSourceVersion:-1}),/对照已变化/);
    assert.equal(readUnverifiedPreviousObservations('report').length,1,'stale confirmation rolls back its new row');
    createManualObservation(user,'report',{itemName:'血小板计数',resultText:'205',numericValue:205,unit:'10^9/L',previousObservationIndex:0,expectedSourceVersion:version});
    assert.equal(readUnverifiedPreviousObservations('report').length,0);
    assert.equal(db.prepare('SELECT count(*) n FROM observations').get()?.n,2);
  });
});

test('source-version guard rolls back both replacement and comparison metadata',async()=>{
  await withReport(['项目 | 结果 | 单位','血红蛋白 | 120 | g/L'],async db=>{
    old(db,'old','合成旧项','12','U/L','合成旧项 | 12 | U/L');
    const output=await executeAiExtractionPlan('ai','report',async()=>result(),{visionReview:async()=>null});
    assert.throws(()=>persistAiExtraction('report','ai',output.result,output.inputCharacters,()=>{throw new Error('source changed');}),/source changed/);
    assert.equal(db.prepare("SELECT count(*) n FROM observations WHERE id='old'").get()?.n,1);
    assert.equal(db.prepare('SELECT count(*) n FROM report_extractions').get()?.n,0);
  });
});

test('short visual names require a real item cell; separate report flags survive every extraction path',async()=>{
  const line:any={id:'candidate',index:0,text:'K | 7 | mmol/L',sourceLineIds:['item','value','unit'],box:[0,0,300,30],sourceCells:[
    {text:'K',sourceLineIds:['item']},{text:'7',sourceLineIds:['value']},{text:'mmol/L',sourceLineIds:['unit']}]};
  const group=groupVisionReviewPages([{pageId:'page',pageNumber:1,line}])[0];
  const parsed=result([one('K','7','mmol/L',line.text)]).fields.observations;
  assert.equal(acceptVisionObservations(parsed,group,result()).accepted.length,1);
  assert.equal(acceptVisionObservations(parsed,{...group,lines:[{...line,sourceCells:[]}]},result()).accepted.length,0);
  await withReport(['合成检测甲 | 7 | L | 4-10 | U/L'],async()=>{
    const output=await executeAiExtractionPlan('ai','report',async()=>result([{...one('合成检测甲','7','U/L','合成检测甲 | 7 | L | 4-10 | U/L'),
      abnormalFlag:'low',referenceLow:4,referenceHigh:10,referenceText:'4-10'}]),{visionReview:async()=>null});
    assert.equal(output.result.fields.observations[0].abnormalFlag,'low');
  });
});

test('repair transport failures preserve the last published snapshot instead of retiring values',async()=>{
  const line='合成指标甲 7 U/L 参考范围 1-9';
  await withReport(['检验报告',line],async db=>{
    old(db,'old','合成旧项','12','U/L','合成旧项 | 12 | U/L');
    const output=await executeAiExtractionPlan('ai','report',async request=>{
      if(request.promptMode==='supplement') throw Object.assign(new Error('synthetic outage'),{code:'AI_NETWORK_ERROR'});
      return result();
    },{visionReview:async()=>null});
    assert.equal(output.result.recovery?.technicalFailure,true);
    assert.throws(()=>persistAiExtraction('report','ai',output.result,output.inputCharacters),{code:'AI_RECOVERY_INCOMPLETE'});
    assert.equal(db.prepare("SELECT count(*) n FROM observations WHERE id='old'").get()?.n,1);
    assert.equal(db.prepare('SELECT count(*) n FROM report_extractions').get()?.n,0);
  });
});

test('source matching distinguishes pages, result columns, dates and unknown item cells',()=>{
  const original=result([one('合成指标甲','1','U/L','合成指标甲 | 1 | U/L')]).fields.observations[0];
  assert.equal(observationSourceCovered(original,{...original,resultText:'2'}),true);
  assert.equal(observationSourceCovered(original,{...original,evidence:[{pageNumber:2,quote:original.evidence[0].quote}]}),false);
  assert.equal(observationSourceCovered({...original,examination:{timeText:'2026-01-01'}},{...original,examination:{timeText:'2026-01-02'}}),false);
  const sourced=(name:string,id:string)=>({...original,itemName:name,evidence:[{pageNumber:1,quote:'shared',table:{sourceMap:{result:{text:'1',sourceLineIds:[id]}}}}]}) as AiObservation;
  assert.equal(observationSourceCovered(sourced('合成指标甲','left'),sourced('合成指标甲','right')),false);
  assert.equal(observationSourceCovered(sourced('合成指标甲','left'),sourced('合成指标乙','left')),false);
});

test('append publication can withdraw unverified automatic legacy rows but never reviewed manual rows',async()=>{
  await withReport(['检验报告'],async db=>{
    old(db,'old','合成旧项','12','U/L','');
    db.prepare("UPDATE observations SET evidence_json='[]' WHERE id='old'").run();
    const before=snapshotPublishedRecords('report');
    const unverified=collectUnverifiedPreviousObservations('report',[]);
    db.prepare("DELETE FROM observations WHERE id='old'").run();
    assert.doesNotThrow(()=>assertPublishedRecordsRetained('report',before,{observations:[],unverified}));
    createManualObservation(user,'report',{itemName:'合成人工项',resultText:'9',numericValue:9,unit:'U/L'});
    const manual=snapshotPublishedRecords('report');
    db.prepare('DELETE FROM observations').run();
    assert.throws(()=>assertPublishedRecordsRetained('report',manual,{observations:[],unverified:[]}),/已保留上一版/);
  });
});

test('published examination context participates in source matching when collecting old comparisons',async()=>{
  await withReport(['检验报告'],async db=>{
    const quote='合成指标甲 | 12 | U/L';
    old(db,'old','合成指标甲','12','U/L',quote);
    db.exec(`INSERT INTO report_examinations(id,report_id,source_key,time_text) VALUES('exam','report','source','2026-01-01');
      INSERT INTO observation_examinations(observation_id,examination_id,assignment_source) VALUES('old','exam','automatic')`);
    const same=result([one('合成指标甲','12','U/L',quote)]).fields.observations[0];
    assert.equal(collectUnverifiedPreviousObservations('report',[{...same,examination:{timeText:'2026-01-01'}}]).length,0);
    assert.equal(collectUnverifiedPreviousObservations('report',[{...same,examination:{timeText:'2026-01-02'}}]).length,1);
  });
});
