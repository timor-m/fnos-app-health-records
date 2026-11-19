import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {closeDatabaseForTests,getDatabase} from '../database/client';
import type {RequestUser} from '../domain/request-user';
import {saveAiSettings} from '../services/ai-settings.service';
import {getRecordProcess,listRecordProcesses,recordProcesses,linkProcessRecords,updateRecordProcess} from '../services/health-record-process.service';
import {organizeHealthProcess,validateProcessMetadata,processAiInput,processAiInputMaxChars} from '../services/health-process-ai.service';
import {createClinicalFact} from '../services/clinical-fact.service';
import {createReportStructuredSection} from '../services/report-structured-section.service';
import {createPublicSymptom} from '../services/public-symptom.service';
import {createProcessSymptomUpdate} from '../services/symptom-episode.service';
import {createMedicationCourse,createMedicationIntake,changeMedicationCourse} from '../services/medication.service';
import {getAiAuditSummary,clearUserOperationAuditLogs,listUserOperationAuditLogs} from '../services/records.service';
const user:RequestUser={id:'manager',displayName:'合成账号',authenticated:true,provider:'development',isGatewayAdmin:true};
async function fixture(run:(id:string)=>unknown){const previous=process.env.STORAGE_DIR;const dir=mkdtempSync(join(tmpdir(),'health-process-ai-'));process.env.STORAGE_DIR=dir;
 try{const db=getDatabase();db.prepare("INSERT INTO users(id,display_name) VALUES('manager','合成账号')").run();db.prepare("INSERT INTO health_members(id,display_name,created_by) VALUES('member','合成成员','manager')").run();db.prepare("INSERT INTO member_permissions(member_id,user_id,permission,granted_by) VALUES('member','manager','manager','manager')").run();
 for(const id of ['a','b'])db.prepare("INSERT INTO reports(id,member_id,created_by,title,report_type,status,report_issued_at) VALUES(?,'member','manager',?,'laboratory','ready','2026-01-01')").run(id,'合成资料 '+id);
 const id=linkProcessRecords(user,{kind:'report',id:'a'},[{kind:'report',id:'b'}])[0].id;await run(id);
 }finally{closeDatabaseForTests();if(previous===undefined)delete process.env.STORAGE_DIR;else process.env.STORAGE_DIR=previous;rmSync(dir,{recursive:true,force:true});}}
function enable(){saveAiSettings({enabled:true,profiles:[{id:'synthetic',provider:'deepseek',apiKey:'synthetic-only-key',baseUrl:'https://synthetic.invalid/v1',textModel:'synthetic-text'}],defaultProfileId:'synthetic'});}
const metadata=()=>({title:'合成检查过程',summary:'整理已记录的检查资料。',highlights:[{text:'已记录检查资料。',sources:[{kind:'report',id:'a'}]}],stages:[{ref:{kind:'report',id:'b'},stage:'followup'}]});
test('AI is optional and missing configuration never prevents process access',()=>fixture(async id=>{
 assert.equal(getRecordProcess(user,id).aiState,'unconfigured');let calls=0;await assert.rejects(()=>organizeHealthProcess(user,id,async()=>{calls++;return {content:''};}));assert.equal(calls,0);assert.equal(getRecordProcess(user,id).records.length,2);
}));
test('validated metadata uses only known source refs; source dates and report facts remain unchanged',()=>fixture(async id=>{
 enable();const before=getDatabase().prepare('SELECT * FROM reports ORDER BY id').all();
 const result=await organizeHealthProcess(user,id,async request=>{const content=String(request.messages[1].content);assert.equal(content.match(/^记录 /gm)?.length,2);assert.equal(content.includes('memberId'),false);assert.equal(request.maxOutputTokens,1600);return {content:JSON.stringify({...metadata(),startedAt:'2099-01-01'})};});
 assert.equal(result.title,'合成检查过程');assert.equal(result.startedAt,'2026-01-01');assert.equal(result.records.find(r=>r.ref.id==='b')!.stage,'followup');assert.equal(result.aiState,'ready');assert.deepEqual(getDatabase().prepare('SELECT * FROM reports ORDER BY id').all(),before);
 assert.throws(()=>validateProcessMetadata({...metadata(),highlights:[{text:'无来源内容',sources:[{kind:'report',id:'foreign'}]}]},result));
}));
test('manual title, summary and stages survive model organization',()=>fixture(async id=>{
 enable();const original=getRecordProcess(user,id);updateRecordProcess(user,id,{fingerprint:original.fingerprint,editToken:original.editToken,title:'手工过程标题',summary:'手工摘要',stages:[{ref:{kind:'report',id:'b'},stage:'examination'}]});
 const result=await organizeHealthProcess(user,id,async()=>({content:JSON.stringify(metadata())}));assert.equal(result.title,'手工过程标题');assert.equal(result.summary,'手工摘要');assert.equal(result.records.find(r=>r.ref.id==='b')!.stage,'examination');assert.equal(result.records.find(r=>r.ref.id==='b')!.stageSource,'manual');
}));
test('matter titles use concrete source facts, without imposing one diagnosis on mixed records',()=>fixture(async id=>{
 enable();createClinicalFact(user,'a','diagnosis',{diagnosisText:'合成事项甲'});
 getDatabase().prepare("UPDATE reports SET title='合成事项乙检查报告' WHERE id='b'").run();
 const result=await organizeHealthProcess(user,id,async request=>{
  const system=String(request.messages[0].content),input=String(request.messages[1].content);
  assert.match(system,/具体健康事项/);assert.match(system,/不能将单条记录的诊断扩大/);assert.match(system,/只有症状自述或登记而无就诊评估依据/);assert.match(system,/多个独立事项/);assert.match(system,/禁止只罗列/);
  assert.match(input,/合成事项甲/);assert.match(input,/合成事项乙检查报告/);
  return {content:JSON.stringify({...metadata(),title:'健康记录概览：合成事项甲与合成事项乙检查'})};
 });
 assert.equal(result.title,'合成事项甲与合成事项乙检查');assert.equal(result.aiState,'ready');
 assert.equal(JSON.parse(String(getDatabase().prepare('SELECT ai_json FROM health_record_processes WHERE id=?').get(id)!.ai_json)).title,result.title);
}));
test('generic AI titles remain explicitly untitled rather than concatenating source filenames or overriding manual titles',()=>fixture(async id=>{
 enable();const db=getDatabase();db.prepare("UPDATE reports SET title=CASE id WHEN 'a' THEN '合成事项甲检验报告' ELSE '合成事项乙接种资料' END").run();
 const result=await organizeHealthProcess(user,id,async()=>({content:JSON.stringify({...metadata(),title:'健康记录概览：检验、处方与接种'})}));
 assert.equal(result.title,'待命名健康历程');assert.equal(result.summary,metadata().summary);assert.equal(result.aiState,'ready');
 const manual=updateRecordProcess(user,id,{fingerprint:result.fingerprint,editToken:result.editToken,title:'健康记录概览：我的自定义标题'});
 await organizeHealthProcess(user,id,async()=>({content:JSON.stringify({...metadata(),title:'检验、处方与接种'})}));
 assert.equal(getRecordProcess(user,id).title,manual.title);
}));
test('legacy generic titles are cleaned consistently without rewriting caches or triggering another AI run',()=>fixture(id=>{
 const db=getDatabase();const before=getRecordProcess(user,id);const cache=JSON.stringify({...metadata(),title:'健康记录概览：检验、处方与接种'});
 db.prepare("UPDATE health_record_processes SET ai_json=?,ai_hash=?,attempted_hash=?,ai_status='ready' WHERE id=?").run(cache,before.fingerprint,before.fingerprint,id);
 const result=getRecordProcess(user,id);assert.equal(result.title,'待命名健康历程');
 assert.equal(listRecordProcesses(user,'member')[0].title,result.title);assert.equal(recordProcesses(user,{kind:'report',id:'a'})[0].title,result.title);
 assert.equal(result.fingerprint,before.fingerprint);assert.equal(result.editToken,before.editToken);assert.equal(result.summary,metadata().summary);
 assert.equal(db.prepare('SELECT ai_json FROM health_record_processes WHERE id=?').get(id)!.ai_json,cache);
 assert.equal(getAiAuditSummary(user).summary.jobCount,0);
}));
test('missing or truncated model titles preserve usable summaries without fabricating a matter title',()=>fixture(async id=>{
 enable();assert.equal(getRecordProcess(user,id).title,'待命名健康历程');
 for(const title of [null,'合成资料甲检查…、合成资料乙处方…等4项健康事项','合成事项'.repeat(20)]){
  const result=await organizeHealthProcess(user,id,async request=>{
   assert.match(String(request.messages[0].content),/不复制医院名称、报告文件名/);
   return {content:JSON.stringify({...metadata(),title})};
  });
  assert.equal(result.title,'待命名健康历程');assert.equal(result.summary,metadata().summary);assert.equal(result.records.length,2);assert.equal(result.aiState,'ready');
 }
}));
test('a source correction while generation runs invalidates the response and hides stale key information',()=>fixture(async id=>{
 enable();await organizeHealthProcess(user,id,async()=>({content:JSON.stringify(metadata())}));
 const result=await organizeHealthProcess(user,id,async()=>{getDatabase().prepare("UPDATE reports SET title='更正的合成资料',source_version=source_version+1 WHERE id='a'").run();return {content:JSON.stringify(metadata())};});
 assert.notEqual(result.aiState,'ready');assert.equal(result.highlights.length,0);assert.notEqual(result.title,'合成检查过程');
}));
test('invalid output and provider errors preserve original records and expose no upstream health content',()=>fixture(async id=>{
 enable();await assert.rejects(()=>organizeHealthProcess(user,id,async()=>({content:'invalid'})),e=>String((e as Error).message).includes('整理失败'));
 assert.equal(getRecordProcess(user,id).aiState,'failed');assert.equal(getRecordProcess(user,id).recordCount,2);
 await assert.rejects(()=>organizeHealthProcess(user,id,async()=>{throw Error('synthetic private payload');}),e=>!String(e).includes('private payload'));
 assert.equal(JSON.stringify(getDatabase().prepare('SELECT * FROM health_record_processes').all()).includes('private payload'),false);
}));
test('parallel organization requests share one model run and a manually cleared summary stays empty',()=>fixture(async id=>{
 enable();let calls=0;let finish!:(value:{content:string})=>void;
 const execute=async()=>{calls++;return new Promise<{content:string}>(done=>finish=done);};
 const a=organizeHealthProcess(user,id,execute),b=organizeHealthProcess(user,id,execute);assert.equal(calls,1);finish({content:JSON.stringify(metadata())});await Promise.all([a,b]);
 const before=getRecordProcess(user,id);updateRecordProcess(user,id,{fingerprint:before.fingerprint,editToken:before.editToken,summary:''});await organizeHealthProcess(user,id,async()=>({content:JSON.stringify(metadata())}));assert.equal(getRecordProcess(user,id).summary,'');
}));
test('organization receives actual report facts and a fact correction invalidates the cached summary',()=>fixture(async id=>{
 enable();createClinicalFact(user,'a','diagnosis',{diagnosisText:'合成诊断描述'});
 createClinicalFact(user,'a','medication',{medicationName:'合成处方药品',dose:'1',doseUnit:'片',frequency:'合成频次'});
 await organizeHealthProcess(user,id,async request=>{
  const content=String(request.messages[1].content);
  assert.match(content,/报告诊断：合成诊断描述/);assert.match(content,/报告所列用药（不代表已使用）：合成处方药品 1片 合成频次/);
  assert.equal(content.includes('已确认使用：'),false);return {content:JSON.stringify(metadata())};
 });
 assert.equal(getRecordProcess(user,id).aiState,'ready');
 createClinicalFact(user,'a','diagnosis',{diagnosisText:'合成后续核对描述'});
 const changed=getRecordProcess(user,id);assert.equal(changed.aiState,'stale');assert.equal(changed.highlights.length,0);
}));
test('prescription topics retain the prescription qualifier instead of claiming a treatment was performed',()=>fixture(async id=>{
 enable();getDatabase().prepare("UPDATE reports SET report_type='prescription' WHERE id='b'").run();
 createClinicalFact(user,'b','procedure',{procedureName:'合成操作医嘱',procedureType:'treatment'});
 const result=await organizeHealthProcess(user,id,async request=>{
  const system=String(request.messages[0].content),input=String(request.messages[1].content);
  assert.match(system,/标题必须保留“处方”或“医嘱”的限定/);assert.match(system,/不能根据药品组合推断治疗方式/);
  assert.match(input,/资料性质：处方或用药单/);assert.match(input,/处方所列操作（不代表已执行）：合成操作医嘱/);
  return {content:JSON.stringify({...metadata(),title:'合成检查与合成操作医嘱',stages:[]})};
 });
 assert.equal(result.title,'合成检查与合成操作医嘱');
}));
test('report conclusions suppress indicator fallback across the whole process and deduplicate repeated conclusions',()=>fixture(id=>{
 const db=getDatabase();db.prepare("UPDATE reports SET report_type='checkup',summary='合成总检结论',impression='合成报告印象',clinical_diagnosis='合成诊断' WHERE id='a'").run();
 createReportStructuredSection(user,'a',{sectionKey:'checkup_final_conclusion',content:'合成总检结论'});
 createReportStructuredSection(user,'a',{sectionKey:'checkup_package',content:'不应发送的整套检查明细'});
 const insert=db.prepare('INSERT INTO observations(id,report_id,item_name,result_text,unit,abnormal_flag,reference_low,reference_high,numeric_value) VALUES(?,?,?,?,?,?,?,?,?)');
 for(let i=0;i<110;i++)insert.run('n'+i,'a','正常项目'+i,'9','合成单位','normal',0,10,9);
 for(let i=0;i<8;i++)insert.run('z'+i,'a','标记项目'+i,'12.50','合成单位',i===0?'low':'high',null,null,12.5);
 insert.run('other-report','b','其他报告的标记项目','20','合成单位','high',null,null,20);
 insert.run('unmarked','a','仅范围推导的项目','30','合成单位',null,0,10,30);
 const before=db.prepare('SELECT * FROM observations ORDER BY id').all();const text=processAiInput(user,getRecordProcess(user,id));
 assert.equal((text.match(/合成总检结论/g)||[]).length,1);assert.match(text,/合成报告印象/);assert.match(text,/合成诊断/);
 assert.equal(text.includes('正常项目'),false);assert.equal(text.includes('仅范围推导的项目'),false);assert.equal(text.includes('整套检查明细'),false);
 assert.equal(text.includes('标记项目'),false);
 assert.match(text,/省略不代表正常或不存在/);assert.deepEqual(db.prepare('SELECT * FROM observations ORDER BY id').all(),before);
}));
test('only a process without overview facts supplements at most five explicitly marked indicators per report',()=>fixture(id=>{
 const db=getDatabase();const insert=db.prepare('INSERT INTO observations(id,report_id,item_name,result_text,unit,abnormal_flag,reference_low,reference_high,numeric_value) VALUES(?,?,?,?,?,?,?,?,?)');
 for(let i=0;i<110;i++)insert.run('n'+i,'a','正常项目'+i,'9','合成单位','normal',0,10,9);
 for(let i=0;i<8;i++)insert.run('z'+i,'a','标记项目'+i,'12.50','合成单位',i===0?'low':'high',null,null,12.5);
 insert.run('unmarked','a','仅范围推导的项目','30','合成单位',null,0,10,30);
 const text=processAiInput(user,getRecordProcess(user,id));assert.match(text,/概述缺失时补充原报告标记指标/);
 assert.equal(text.includes('正常项目'),false);assert.equal(text.includes('仅范围推导的项目'),false);
 assert.equal((text.match(/标记项目/g)||[]).length,5);assert.match(text,/标记项目0 12\.50 合成单位（原报告偏低）/);
}));
test('actual symptom changes or medication overview suppress fallback; empty symptom metadata alone does not',()=>fixture(id=>{
 getDatabase().prepare("INSERT INTO observations(id,report_id,item_name,result_text,unit,abnormal_flag) VALUES('flag','a','待兜底项目','12.50','合成单位','high')").run();
 const read=()=>processAiInput(user,getRecordProcess(user,id));assert.match(read(),/待兜底项目/);
 const symptom=createPublicSymptom(user,{memberId:'member',name:'合成症状',startedAt:'2026-01-01'});
 linkProcessRecords(user,{kind:'report',id:'a'},[{kind:'symptom',id:symptom.id}]);assert.match(read(),/待兜底项目/);
 createProcessSymptomUpdate(user,symptom.episodeId,symptom.id,{recordedAt:'2026-01-02',change:'improved',severity:0,description:'合成变化概要'});
 assert.match(read(),/合成变化概要/);assert.match(read(),/最近程度：0\/10/);assert.equal(read().includes('待兜底项目'),false);
 linkProcessRecords(user,{kind:'report',id:'a'},[{kind:'symptom',id:symptom.id}],true);assert.match(read(),/待兜底项目/);
 const course=createMedicationCourse(user,{memberId:'member',medicationName:'合成用药',startedAt:'2026-01-01',confirmed:true});
 linkProcessRecords(user,{kind:'report',id:'a'},[{kind:'medication',id:course.id}]);assert.match(read(),/已确认使用：合成用药/);assert.equal(read().includes('待兜底项目'),false);
}));
test('overview keeps recent symptom and medication changes, zero severity and intake counts without full histories',()=>fixture(id=>{
 const symptom=createPublicSymptom(user,{memberId:'member',name:'合成症状',startedAt:'2026-01-01'});
 for(let i=1;i<=6;i++)createProcessSymptomUpdate(user,symptom.episodeId,symptom.id,{recordedAt:`2026-01-0${i}`,change:'improved',severity:i===6?0:3,description:'症状变化-'+i});
 let course=createMedicationCourse(user,{memberId:'member',medicationName:'合成用药',startedAt:'2026-01-01',confirmed:true});
 for(let i=2;i<=6;i++)course=changeMedicationCourse(user,course.id,{action:'adjust',revision:course.revision,occurredAt:`2026-01-0${i}`,dose:String(i),note:'用药变化-'+i});
 for(let i=1;i<=8;i++)createMedicationIntake(user,{memberId:'member',courseId:course.id,takenAt:`2026-01-0${i}T08:00`,amount:'1',note:'不应逐次发送的服用明细-'+i});
 linkProcessRecords(user,{kind:'report',id:'a'},[{kind:'symptom',id:symptom.id},{kind:'medication',id:course.id}]);
 const text=processAiInput(user,getRecordProcess(user,id));assert.match(text,/最近程度：0\/10/);assert.equal((text.match(/症状变化-/g)||[]).length,3);
 assert.equal(text.includes('症状变化-1'),false);assert.match(text,/症状变化-6/);assert.equal((text.match(/用药变化-/g)||[]).length,3);assert.match(text,/已确认使用：合成用药/);
 assert.match(text,/实际服用补充：8次/);assert.equal(text.includes('不应逐次发送的服用明细'),false);
}));
test('large overview input has a total character budget and retains every source reference and actual date',()=>fixture(id=>{
 const db=getDatabase();const refs:Array<{kind:'report';id:string}>=[];
 for(let i=0;i<18;i++){
  const ref={kind:'report' as const,id:'extra-'+i};refs.push(ref);
  db.prepare("INSERT INTO reports(id,member_id,created_by,title,report_type,status,report_issued_at,summary,impression,recommendation) VALUES(?,'member','manager',?,'laboratory','ready','2026-01-02',?,?,?)")
   .run(ref.id,'合成长标题'+i,'概览结论'.repeat(500),'报告印象'.repeat(500),'报告建议'.repeat(500));
 }
 linkProcessRecords(user,{kind:'report',id:'a'},refs);const process=getRecordProcess(user,id);const text=processAiInput(user,process);
 assert.ok(text.length<=processAiInputMaxChars);assert.equal(text.match(/^记录 /gm)?.length,process.recordCount);
 for(const record of process.records){assert.ok(text.includes(JSON.stringify(record.ref)));assert.ok(text.includes('日期='+record.date));}
 assert.match(text,/部分内容未附入/);
}));
test('process audit is visible while running, records actual usage on completion, and excludes clinical input and output',()=>fixture(async id=>{
 enable();let finish!:(value:{content:string;promptTokens:number;completionTokens:number;elapsedMs:number})=>void;
 const work=organizeHealthProcess(user,id,async()=>new Promise(done=>{finish=done;}));
 const running=getAiAuditSummary(user);assert.equal(running.summary.processingJobs,1);assert.equal(running.recent[0].source,'health_process_summary');assert.equal(running.recent[0].status,'processing');assert.equal(running.recent[0].attempts,1);
 finish({content:JSON.stringify(metadata()),promptTokens:120,completionTokens:45,elapsedMs:650});await work;
 const audit=getAiAuditSummary(user);assert.equal(audit.summary.processingJobs,0);assert.equal(audit.summary.successJobs,1);assert.equal(audit.summary.callCount,1);assert.equal(audit.summary.totalTokens,165);assert.equal(audit.recent[0].elapsedMs,650);assert.equal(audit.recent[0].reportTitle,'合成检查过程');assert.ok(audit.recent[0].finishedAt);
 const stored=JSON.stringify(getDatabase().prepare("SELECT detail_json FROM audit_logs WHERE action='ai.health_process_summary'").all());assert.equal(stored.includes(metadata().summary),false);assert.equal(stored.includes('合成资料'),false);assert.equal(stored.includes('synthetic-only-key'),false);assert.equal(stored.includes('messages'),false);
 assert.equal(listUserOperationAuditLogs(user).items.some(item=>item.action==='ai.health_process_summary'),false);clearUserOperationAuditLogs(user);assert.equal(getAiAuditSummary(user).summary.jobCount,1);
}));
test('failures and rejected output have sanitized audit reasons and retain any returned token usage',()=>fixture(async id=>{
 enable();await assert.rejects(()=>organizeHealthProcess(user,id,async()=>{throw Error('private raw health payload synthetic-only-key');}));
 let audit=getAiAuditSummary(user);assert.equal(audit.summary.failedJobs,1);assert.equal(audit.recent[0].errorCode,'AI_CALL_FAILED');assert.equal(audit.recent[0].errorMessage?.includes('private'),false);
 await assert.rejects(()=>organizeHealthProcess(user,id,async()=>({content:'private invalid JSON',promptTokens:60,completionTokens:20})));
 audit=getAiAuditSummary(user);assert.equal(audit.summary.failedJobs,2);assert.equal(audit.summary.totalTokens,80);assert.ok(audit.recent.some(item=>item.errorCode==='AI_INVALID_OUTPUT'));
 assert.equal(JSON.stringify(getDatabase().prepare("SELECT detail_json FROM audit_logs WHERE action='ai.health_process_summary'").all()).includes('private'),false);
}));
test('concurrent calls share one audit entry; stale results remain auditable without being applied',()=>fixture(async id=>{
 enable();let finish!:(value:{content:string;promptTokens:number})=>void;const execute=async()=>new Promise<{content:string;promptTokens:number}>(done=>{finish=done;});
 const first=organizeHealthProcess(user,id,execute),second=organizeHealthProcess(user,id,execute);assert.equal(getAiAuditSummary(user).summary.jobCount,1);
 getDatabase().prepare("UPDATE reports SET source_version=source_version+1 WHERE id='a'").run();finish({content:JSON.stringify(metadata()),promptTokens:50});await Promise.all([first,second]);
 const audit=getAiAuditSummary(user);assert.equal(audit.recent[0].status,'cancelled');assert.equal(audit.recent[0].errorCode,'AI_RESULT_STALE');assert.equal(audit.summary.totalTokens,50);assert.equal(getRecordProcess(user,id).aiState,'idle');
}));
test('automatic runs are audited and current member permissions scope both totals and pagination',()=>fixture(async id=>{
 enable();await organizeHealthProcess(user,id,async()=>({content:JSON.stringify(metadata())}),'automatic');await organizeHealthProcess(user,id,async()=>({content:JSON.stringify(metadata())}));
 const db=getDatabase();const detail=JSON.parse(String(db.prepare("SELECT detail_json FROM audit_logs WHERE action='ai.health_process_summary' ORDER BY rowid LIMIT 1").get()!.detail_json));assert.equal(detail.trigger,'automatic');
 const first=getAiAuditSummary(user,1);assert.equal(first.hasMore,true);const second=getAiAuditSummary(user,1,first.nextCursor!);assert.notEqual(first.recent[0].id,second.recent[0].id);assert.equal(second.hasMore,false);
 db.prepare("INSERT INTO users(id,display_name) VALUES('other-admin','合成其他管理员')").run();const other={...user,id:'other-admin'};assert.equal(getAiAuditSummary(other).summary.jobCount,0);
 db.prepare("DELETE FROM member_permissions WHERE user_id='manager'").run();assert.equal(getAiAuditSummary(user).recent.length,0);
}));
test('interrupted processing is displayed as failed after restart state recovery and a subsequent retry keeps the history',()=>fixture(async id=>{
 enable();const db=getDatabase();db.prepare("UPDATE health_record_processes SET ai_status='idle' WHERE id=?").run(id);
 db.prepare("INSERT INTO audit_logs(id,actor_user_id,action,target_type,target_id,detail_json) VALUES('interrupted','manager','ai.health_process_summary','health_record_process',?,?)").run(id,JSON.stringify({status:'processing',attempts:1}));
 assert.equal(getAiAuditSummary(user).recent[0].errorCode,'AI_PROCESS_INTERRUPTED');await organizeHealthProcess(user,id,async()=>({content:JSON.stringify(metadata())}));
 const audit=getAiAuditSummary(user);assert.equal(audit.summary.failedJobs,1);assert.equal(audit.summary.successJobs,1);
}));
test('a failed repeat organization remains failed on fresh reads while keeping the last valid summary',()=>fixture(async id=>{
 enable();await organizeHealthProcess(user,id,async()=>({content:JSON.stringify(metadata())}));const before=getRecordProcess(user,id);
 await assert.rejects(()=>organizeHealthProcess(user,id,async()=>{throw Error('synthetic provider failure');}));
 const current=getRecordProcess(user,id);assert.equal(current.aiState,'failed');assert.equal(current.summary,before.summary);assert.equal(current.title,before.title);assert.deepEqual(current.records,before.records);
}));
