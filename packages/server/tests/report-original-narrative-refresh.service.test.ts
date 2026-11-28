import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {getDatabase,closeDatabaseForTests} from '../database/client';
import {createMember,setMemberPermission} from '../services/member.service';
import {createUpload} from '../services/upload.service';
import {upsertManualReportFieldOverrides} from '../services/report-field-overrides.service';
import {refreshReportOriginalNarratives} from '../services/report-original-narrative-refresh.service';
import type {RequestUser} from '../domain/request-user';

test('local narrative refresh changes only generated narrative columns, preserves manual data and never runs AI',()=>{
 const dir=mkdtempSync(join(tmpdir(),'original-refresh-')),env={...process.env},originalFetch=globalThis.fetch;
 process.env.STORAGE_DIR=dir;let networkCalls=0;
 globalThis.fetch=async()=>{networkCalls++;throw new Error('Local replay must not use the network');};
 try {
  const db=getDatabase();db.exec("INSERT INTO users(id,display_name) VALUES('owner','Synthetic'),('viewer','Synthetic')");
  db.exec("INSERT INTO user_identities(id,user_id,provider,subject) VALUES('owner-ident','owner','development','owner'),('viewer-ident','viewer','development','viewer')");
  const owner:RequestUser={id:'owner',displayName:'Synthetic',provider:'development',authenticated:true,isGatewayAdmin:false};
  const viewer:RequestUser={...owner,id:'viewer'};
  const member=createMember(owner,{displayName:'Synthetic',relationship:'other'});
  setMemberPermission(owner,member.id,{userId:'viewer',permission:'viewer',version:0});
  const report=createUpload(owner,member.id,[{originalName:'synthetic.pdf',data:Buffer.from('%PDF-1.4\n%%EOF')}]);
  const rid=report.reportId,pageId=(db.prepare('SELECT id FROM report_pages WHERE report_id=?').get(rid) as {id:string}).id;
  db.prepare("UPDATE processing_jobs SET status='completed' WHERE report_id=?").run(rid);
  db.prepare("UPDATE reports SET status='ready',summary='人工校对概述',impression='旧结论摘要',recommendation='旧建议摘要',findings='旧所见摘要',source_version=7 WHERE id=?").run(rid);
  db.prepare("INSERT INTO report_pages(id,report_id,page_number,original_name,storage_path,mime_type,file_size,sha256) VALUES('p2',?,2,'synthetic.png','synthetic.png','image/png',1,'synthetic')").run(rid);
  const lines1=[{text:'【内科】'},{text:'概述：'},{text:'完整概述原文。'},{text:'结论：'},{text:'完整结论原文。'},{text:'医生建议：'},{text:'完整建议原文。'}];
  const lines2=[{text:'检查项目：胸部CT'},{text:'非标准正文标题'},{text:'专属所见首句。'},{text:'专属所见末句。'}];
  for(const [id,page,lines]of [['ocr1',pageId,lines1],['ocr2','p2',lines2]] as const) {
   db.prepare("INSERT INTO processing_jobs(id,report_id,page_id,job_type,status,pipeline_version,deduplication_key) VALUES(?,?,?,'ocr','completed','synthetic',?)").run(id,rid,page,id);
   db.prepare("INSERT INTO ocr_results(id,job_id,page_id,engine,model_version,lines_json) VALUES(?,?,?,'synthetic','synthetic',?)").run(id+'result',id,page,JSON.stringify(lines));
  }
  db.prepare("INSERT INTO processing_jobs(id,report_id,job_type,status,pipeline_version,deduplication_key) VALUES('ai',?,'ai_extract','completed','synthetic','ai')").run(rid);
  const refs={narrativeSections:[{field:'findings',p:2,startQuote:'专属所见首句。',endQuote:'专属所见末句。'}]};
  db.prepare("INSERT INTO report_extractions(id,report_id,job_id,provider,model,prompt_version,fields_json,raw_response_json) VALUES('extract',?,'ai','synthetic','synthetic','synthetic',?,'{}')").run(rid,JSON.stringify(refs));
  db.prepare("INSERT INTO observations(id,report_id,item_name,result_text,numeric_value,unit,evidence_json) VALUES('observation',?,'合成指标','123',123,'g/L','[]')").run(rid);
  db.prepare("INSERT INTO observation_field_overrides(id,report_id,source_key,observation_id,fields_json,is_manual_created) VALUES('manual-observation',?,'synthetic','observation','{\"itemName\":\"人工指标\",\"resultText\":\"123\"}',1)").run(rid);
  upsertManualReportFieldOverrides({reportId:rid,userId:owner.id,fields:[{fieldKey:'summary',value:'人工校对概述'}]});
  // Existing report-update triggers invalidate cache revisions; cached trend payloads and all clinical rows must remain unchanged.
  const tables=(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT IN ('reports','trend_snapshot_members','trend_snapshot_dirty_reports') ORDER BY name").all() as {name:string}[]).map(row=>row.name);
  const otherTables=()=>Object.fromEntries(tables.map(name=>[name,createHash('sha256').update(JSON.stringify(db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all())).digest('hex')]));
  const row=()=>db.prepare('SELECT * FROM reports WHERE id=?').get(rid)!;
  const before=row(),untouched=otherTables();
  const result=refreshReportOriginalNarratives(owner,rid,7),after=row();
  assert.deepEqual(result.updatedFields,['impression','recommendation','findings']);assert.deepEqual(result.protectedFields,['summary']);
  assert.equal(after.status,'ready');assert.equal(after.summary,'人工校对概述');assert.match(String(after.impression),/内科 · 结论/);
  assert.match(String(after.findings),/胸部CT/);assert.match(String(after.findings),/专属所见末句/);
  for(const key of Object.keys(before)) if(!['impression','recommendation','findings','source_version','updated_at'].includes(key)) assert.deepEqual(after[key],before[key],key);
  assert.deepEqual(otherTables(),untouched);assert.equal(networkCalls,0);
  assert.deepEqual(refreshReportOriginalNarratives(owner,rid,8).updatedFields,[]);assert.deepEqual(row(),after);assert.deepEqual(otherTables(),untouched);
  assert.throws(()=>refreshReportOriginalNarratives(owner,rid,7),{statusCode:409});
  assert.throws(()=>refreshReportOriginalNarratives(viewer,rid,8),{statusCode:403});
  assert.throws(()=>refreshReportOriginalNarratives(owner,rid,NaN),{statusCode:400});
  assert.throws(()=>refreshReportOriginalNarratives(owner,'missing',8),{statusCode:404});
  db.prepare("UPDATE processing_jobs SET status='queued' WHERE id='ai'").run();
  assert.throws(()=>refreshReportOriginalNarratives(owner,rid,8),{statusCode:409});assert.deepEqual(row(),after);
  db.prepare("UPDATE processing_jobs SET status='completed' WHERE id='ai'").run();
  db.prepare("UPDATE ocr_results SET lines_json='[' WHERE job_id='ocr2'").run();
  assert.throws(()=>refreshReportOriginalNarratives(owner,rid,8),{statusCode:409});assert.deepEqual(row(),after);
  db.prepare("UPDATE ocr_results SET lines_json=? WHERE job_id='ocr2'").run(JSON.stringify(lines2));
  // Without saved classification, unknown old content is retained, not erased.
  db.prepare("UPDATE report_extractions SET fields_json='{}' WHERE id='extract'").run();
  db.prepare("UPDATE reports SET findings='无法定位的历史所见' WHERE id=?").run(rid);
  const unresolved=refreshReportOriginalNarratives(owner,rid,8);
  assert.deepEqual(unresolved.updatedFields,[]);assert.deepEqual(unresolved.unresolvedFields,['findings']);assert.equal(row().findings,'无法定位的历史所见');
  // A failed write rolls back the entire update and leaves all other tables alone.
  db.prepare("UPDATE reports SET impression='待更新结论' WHERE id=?").run(rid);
  db.exec("CREATE TRIGGER reject_original_refresh BEFORE UPDATE OF impression ON reports BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");
  const failedBefore=row(),failedTables=otherTables();assert.throws(()=>refreshReportOriginalNarratives(owner,rid,8),/synthetic failure/);
  assert.deepEqual(row(),failedBefore);assert.deepEqual(otherTables(),failedTables);assert.equal(networkCalls,0);
 } finally {globalThis.fetch=originalFetch;closeDatabaseForTests();process.env=env;rmSync(dir,{recursive:true,force:true});}
});
