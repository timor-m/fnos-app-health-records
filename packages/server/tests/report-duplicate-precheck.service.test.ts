import { evaluateDuplicatePair } from "../services/report-duplicate-evidence.ts";
import { saveAiSettings } from "../services/ai-settings.service.ts";
import { buildDuplicateSnapshot, markDuplicateResultCurrent, numericFactValue, completeSourceSignature } from "../services/report-duplicate-snapshot.service.ts";
import { setReportDuplicateDecision, shouldCollapseReportPair, listReportDuplicateDecisions } from "../services/report-duplicate-governance.service.ts";
import { continueDuplicateReport, listDuplicateRecovery, recoverDuplicateReports } from "../services/report-duplicate-recovery.service.ts";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { closeDatabaseForTests, getDatabase } from "../database/client.ts";
import type { RequestUser } from "../domain/request-user.ts";
import { findLocalDuplicateEvidence, pauseDuplicateIfEligible, getDuplicatePause, runDuplicatePostcheck } from "../services/report-duplicate-precheck.service.ts";
import { createUpload } from "../services/upload.service.ts";

const manager: RequestUser = {
  id: "duplicate-precheck-manager",
  displayName: "任务管理员",
  provider: "fnos_gateway",
  authenticated: true,
  isGatewayAdmin: true
};

const baseLines = [
  "机构：合成测试医院",
  "报告名称：合成检验面板",
  "报告号：SYN-001",
  "采样时间：2026-01-01 09:00",
  "健康体检检验结果汇总",
  "白细胞计数 5.62 10^9/L 3.50-9.50",
  "红细胞计数 4.83 10^12/L 4.30-5.80",
  "血红蛋白 151 g/L 130-175",
  "血小板计数 226 10^9/L 125-350",
  "空腹血糖 5.18 mmol/L 3.90-6.10",
  "总胆固醇 4.26 mmol/L 0.00-5.20",
  "甘油三酯 1.12 mmol/L 0.00-1.70",
  "谷丙转氨酶 22 U/L 9-50",
  "肌酐 78 μmol/L 57-111"
];

async function withDatabase(run: () => void) {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-duplicate-precheck-"));
  process.env.STORAGE_DIR = storageDir;
  try {
    const db = getDatabase();
    db.prepare("INSERT INTO users (id, display_name, is_gateway_admin) VALUES (?, ?, 1)")
      .run(manager.id, manager.displayName);
    db.prepare(`
      INSERT INTO health_members (id, display_name, relationship, created_by)
      VALUES ('duplicate-member', '本人', 'self', ?)
    `).run(manager.id);
    db.prepare(`
      INSERT INTO member_permissions (member_id, user_id, permission, granted_by)
      VALUES ('duplicate-member', ?, 'manager', ?)
    `).run(manager.id, manager.id);
    run();
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
}

function addOcrReport(byte: number, lines: string[]) {
  const upload = createUpload(manager, "duplicate-member", [{
    originalName: `report-${byte}.png`,
    data: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, byte])
  }]);
  const row = getDatabase().prepare(`
    SELECT p.id AS pageId, j.id AS jobId
    FROM report_pages p
    JOIN processing_jobs j ON j.page_id = p.id AND j.job_type = 'ocr'
    WHERE p.report_id = ?
  `).get(upload.reportId) as { pageId: string; jobId: string };
  const payload = lines.map((text, index) => ({
    id: `line_${index + 1}`,
    text,
    confidence: 0.99,
    box: [0, index * 20, 520, index * 20 + 14]
  }));
  getDatabase().prepare(`
    INSERT INTO ocr_results (
      id, job_id, page_id, engine, model_version, lines_json, text_length
    ) VALUES (?, ?, ?, 'test-ocr', 'test-v1', ?, ?)
  `).run(`ocr-${byte}`, row.jobId, row.pageId, JSON.stringify(payload), lines.join("").length);
  getDatabase().prepare(`
    UPDATE processing_jobs SET status = 'completed', finished_at = CURRENT_TIMESTAMP
    WHERE report_id = ?
  `).run(upload.reportId);
  getDatabase().prepare(`
    UPDATE reports SET status = 'ready', title = '健康体检报告' WHERE id = ?
  `).run(upload.reportId);
  return upload.reportId;
}

test("finds rescanned reports from local OCR before AI extraction", () => withDatabase(() => {
  const existing = addOcrReport(1, baseLines);
  const incoming = addOcrReport(2, baseLines);
  const matches = findLocalDuplicateEvidence(incoming);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].reportId, existing);
  assert.equal(matches[0].confidence, "high");
  assert.equal(matches[0].evaluation.ruleId, "R1");
  assert.equal(matches[0].pauseEligible, false); // OCR-only target is not usable AI.
}));

test("does not block AI for the same examination panel with different result values", () => withDatabase(() => {
  addOcrReport(3, baseLines);
  const changed = baseLines.map((line, index) => index === 0
    ? line
    : line.replace(/\s\d+(?:\.\d+)?\s/, ` ${(index * 1.37 + 2).toFixed(2)} `));
  const incoming = addOcrReport(4, changed);
  const matches = findLocalDuplicateEvidence(incoming);
  assert.equal(matches.some((match) => match.confidence === "high"), false);
}));

function completeAi(reportId:string) {
 const db=getDatabase();const jobId=`ai-${reportId}`;
 db.prepare("INSERT INTO processing_jobs(id,report_id,job_type,status,pipeline_version,deduplication_key) VALUES(?,?,'ai_extract','completed','test',?)").run(jobId,reportId,jobId);
 db.prepare("INSERT INTO report_extractions(id,report_id,job_id,provider,model,prompt_version,fields_json,raw_response_json) VALUES(?,?,?,'test','test','test','{}','{}')").run(`e-${reportId}`,reportId,jobId);
 for(const [i,f] of buildDuplicateSnapshot(reportId)!.items.entries()) db.prepare("INSERT INTO observations(id,report_id,item_name,result_text,numeric_value,unit,evidence_json) VALUES(?,?,?,?,?,?,?)").run(`ai-obs-${reportId}-${i}`,reportId,f.key.split('|')[0],f.value.split('|')[0],Number(f.value.split('|')[0]),f.value.split('|')[1],JSON.stringify([{pageNumber:f.page||1,lineIds:f.lines||[]}]));
 markDuplicateResultCurrent(reportId);
}
test("gate pauses only against usable result; target trash expires pause",()=>withDatabase(()=>{
 const a=addOcrReport(10,baseLines),b=addOcrReport(11,baseLines);
 assert.equal(pauseDuplicateIfEligible(b).length,0);completeAi(a);
 assert.equal(pauseDuplicateIfEligible(b).length,1);assert.equal(getDuplicatePause(b)?.valid,true);
 getDatabase().prepare("UPDATE reports SET status='trashed' WHERE id=?").run(a);
 assert.equal(getDuplicatePause(b)?.valid,false);
}));
test("distinct affects precheck, pair display and folding; history survives OCR rerun",()=>withDatabase(()=>{
 const a=addOcrReport(12,baseLines),b=addOcrReport(13,baseLines);completeAi(a);
 setReportDuplicateDecision(manager,{reportId:a,candidateReportId:b,decision:'distinct'});
 assert.deepEqual(findLocalDuplicateEvidence(b),[]);assert.deepEqual(pauseDuplicateIfEligible(b),[]);assert.equal(shouldCollapseReportPair(a,b),false);
 getDatabase().prepare("UPDATE ocr_results SET model_version='rerun' WHERE page_id IN (SELECT id FROM report_pages WHERE report_id=?)").run(b);
 assert.deepEqual(findLocalDuplicateEvidence(b),[]);
}));
test("manual duplicate loses folding after an actual page addition but history is retained",()=>withDatabase(()=>{
 const a=addOcrReport(14,baseLines),b=addOcrReport(15,baseLines);
 setReportDuplicateDecision(manager,{reportId:a,candidateReportId:b,decision:'duplicate'});assert.equal(shouldCollapseReportPair(a,b),true);
 getDatabase().prepare("UPDATE report_pages SET sha256='changed-content' WHERE report_id=?").run(b);
 assert.equal(shouldCollapseReportPair(a,b),false);
 assert.equal((getDatabase().prepare('SELECT COUNT(*) AS n FROM report_duplicate_history').get() as {n:number}).n,1);
}));
test("historical strong ID and source recall reach beyond eighty newer reports",()=>withDatabase(()=>{
 const a=addOcrReport(16,baseLines);getDatabase().prepare("UPDATE reports SET updated_at='2000-01-01' WHERE id=?").run(a);
 for(let i=0;i<90;i++)getDatabase().prepare("INSERT INTO reports(id,member_id,created_by,report_type,title,status,updated_at) VALUES(?,'duplicate-member',?,'lab','合成占位','ready','2030-01-01')").run(`filler-${i}`,manager.id);
 const b=addOcrReport(17,baseLines);assert.ok(findLocalDuplicateEvidence(b).some(x=>x.reportId===a));
}));
test("source and OCR content versions invalidate machine pause",()=>withDatabase(()=>{
 const a=addOcrReport(18,baseLines),b=addOcrReport(19,baseLines);completeAi(a);pauseDuplicateIfEligible(b);
 const before=buildDuplicateSnapshot(b)!.version;
 getDatabase().prepare("UPDATE ocr_results SET lines_json=replace(lines_json,'5.18','5.19') WHERE page_id IN (SELECT id FROM report_pages WHERE report_id=?)").run(b);
 assert.notEqual(buildDuplicateSnapshot(b)!.version,before);assert.equal(getDuplicatePause(b)?.valid,false);assert.equal(findLocalDuplicateEvidence(b)[0]?.evaluation.classification,'related_variant');
}));
test("postcheck retains completed extraction and cannot turn failed/no-AI into success",()=>withDatabase(()=>{
 const a=addOcrReport(20,baseLines),b=addOcrReport(21,baseLines);completeAi(a);completeAi(b);runDuplicatePostcheck(b);
 assert.ok(getDatabase().prepare("SELECT 1 FROM report_extractions WHERE report_id=?").get(b));
 assert.equal((getDatabase().prepare('SELECT post_status AS status FROM report_duplicate_runtime WHERE report_id=?').get(b) as {status:string}).status,'complete');
 const c=addOcrReport(22,baseLines);runDuplicatePostcheck(c);assert.equal(getDatabase().prepare('SELECT post_status FROM report_duplicate_runtime WHERE report_id=?').get(c),undefined);
}));
test("actual builder treats weak OCR differently from reliable result changes",()=>withDatabase(()=>{
 const a=addOcrReport(23,baseLines),b=addOcrReport(24,baseLines.map(x=>x.replace('5.18','5.19')));completeAi(a);
 assert.equal(findLocalDuplicateEvidence(b)[0]?.evaluation.classification,'related_variant');
 const row=getDatabase().prepare('SELECT id,lines_json FROM ocr_results WHERE page_id IN (SELECT id FROM report_pages WHERE report_id=?)').get(b) as {id:string;lines_json:string};
 const lines=JSON.parse(row.lines_json);lines.find((x:any)=>x.text.includes('5.19')).confidence=.2;
 getDatabase().prepare('UPDATE ocr_results SET lines_json=? WHERE id=?').run(JSON.stringify(lines),row.id);
 const e=evaluateDuplicatePair(buildDuplicateSnapshot(a)!,buildDuplicateSnapshot(b)!);assert.equal(e.conflictCount,0);assert.equal(e.uncertainCount,1);
}));
test("unknown source quality is not promoted to reliable",()=>withDatabase(()=>{
 const a=addOcrReport(25,baseLines),b=addOcrReport(26,baseLines);completeAi(a);
 const row=getDatabase().prepare('SELECT id,lines_json FROM ocr_results WHERE page_id IN (SELECT id FROM report_pages WHERE report_id=?)').get(b) as {id:string;lines_json:string};
 const lines=JSON.parse(row.lines_json).map(({confidence,...x}:any)=>x);getDatabase().prepare('UPDATE ocr_results SET lines_json=? WHERE id=?').run(JSON.stringify(lines),row.id);
 assert.equal(pauseDuplicateIfEligible(b).length,0);
}));

const twentyLines=[...baseLines.slice(0,4),...Array.from({length:20},(_,i)=>`合成项目${String.fromCharCode(65+i)} ${i+1}.10 mmol/L 0-100`)];
test("real OCR builder R1 retains 18/20 and R2 detects without a report number",()=>withDatabase(()=>{
 const a=addOcrReport(27,twentyLines),b=addOcrReport(28,twentyLines);completeAi(a);
 const row=getDatabase().prepare('SELECT id,lines_json FROM ocr_results WHERE page_id IN (SELECT id FROM report_pages WHERE report_id=?)').get(b) as {id:string;lines_json:string};
 const lines=JSON.parse(row.lines_json);lines[4].confidence=.2;lines[5].confidence=.2;
 getDatabase().prepare('UPDATE ocr_results SET lines_json=? WHERE id=?').run(JSON.stringify(lines),row.id);
 const e=findLocalDuplicateEvidence(b)[0];assert.equal(e?.evaluation.ruleId,'R1');assert.equal(e.evaluation.sameCount,18);assert.equal(e.evaluation.uncertainCount,2);assert.equal(pauseDuplicateIfEligible(b).length,1);
 const c=addOcrReport(29,twentyLines.filter(x=>!x.startsWith('报告号'))),d=addOcrReport(30,twentyLines.filter(x=>!x.startsWith('报告号')));completeAi(c);
 assert.equal(findLocalDuplicateEvidence(d).find(x=>x.reportId===c)?.evaluation.ruleId,'R2');
}));
test("continue and distinct-and-continue have separate pair semantics and idempotent queue",()=>withDatabase(()=>{
 saveAiSettings({enabled:true,baseUrl:'https://ai.example.test/v1',textModel:'synthetic',apiKey:'synthetic'});
 const a=addOcrReport(31,baseLines),b=addOcrReport(32,baseLines),c=addOcrReport(33,baseLines);completeAi(a);completeAi(c);pauseDuplicateIfEligible(b);
 const first=continueDuplicateReport(manager,b),second=continueDuplicateReport(manager,b);assert.equal(first.id,second.id);
 assert.equal((getDatabase().prepare('SELECT COUNT(*) AS n FROM report_duplicate_decisions').get() as {n:number}).n,0);
 continueDuplicateReport(manager,b,a);
 assert.equal((getDatabase().prepare('SELECT COUNT(*) AS n FROM report_duplicate_decisions').get() as {n:number}).n,1);
 assert.ok(findLocalDuplicateEvidence(b).some(x=>x.reportId===c));
 assert.equal(pauseDuplicateIfEligible(b).length,0);
}));
test("recovery requires genuine historical pause and never queues on read",()=>withDatabase(()=>{
 const a=addOcrReport(34,baseLines),b=addOcrReport(35,baseLines);getDatabase().prepare("UPDATE reports SET status='needs_review'").run();
 const job=getDatabase().prepare("SELECT id FROM processing_jobs WHERE report_id=? AND job_type='ocr'").get(a) as {id:string};
 getDatabase().prepare("INSERT INTO processing_job_events(id,job_id,report_id,event_type,status,detail_json) VALUES('legacy-event',?,?,'completed','completed',?)").run(job.id,a,JSON.stringify({stage:'duplicate_precheck',ruleVersion:'family-v1'}));
 assert.deepEqual(listDuplicateRecovery(manager,'duplicate-member').reportIds,[a]);assert.equal(listDuplicateRecovery(manager,'duplicate-member').reportIds.includes(b),false);
 assert.equal((getDatabase().prepare("SELECT COUNT(*) AS n FROM processing_jobs WHERE job_type='ai_extract'").get() as {n:number}).n,0);
 const viewer={...manager,id:'viewer',isGatewayAdmin:true};getDatabase().prepare("INSERT INTO users(id,display_name) VALUES('viewer','合成只读')").run();getDatabase().prepare("INSERT INTO member_permissions(member_id,user_id,permission,granted_by) VALUES('duplicate-member','viewer','viewer',?)").run(manager.id);
 assert.throws(()=>continueDuplicateReport(viewer,a));assert.throws(()=>recoverDuplicateReports(viewer,'duplicate-member',[a]));
}));

test('postcheck failure is isolated from successful extraction and can be retried',()=>withDatabase(()=>{
 const a=addOcrReport(36,baseLines);completeAi(a);
 getDatabase().exec("CREATE TRIGGER fail_duplicate_check BEFORE UPDATE OF post_json ON report_duplicate_runtime WHEN NEW.post_status='complete' BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");
 assert.doesNotThrow(()=>runDuplicatePostcheck(a));
 assert.equal((getDatabase().prepare('SELECT post_status AS status FROM report_duplicate_runtime WHERE report_id=?').get(a) as {status:string}).status,'failed');
 assert.equal((getDatabase().prepare('SELECT status FROM processing_jobs WHERE id=?').get(`ai-${a}`) as {status:string}).status,'completed');
 assert.ok(getDatabase().prepare('SELECT id FROM report_extractions WHERE report_id=?').get(a));
 getDatabase().exec('DROP TRIGGER fail_duplicate_check');runDuplicatePostcheck(a,false);
 assert.equal((getDatabase().prepare('SELECT post_status AS status FROM report_duplicate_runtime WHERE report_id=?').get(a) as {status:string}).status,'complete');
}));
test('concurrent matching uploads cannot mutually pause without a completed result',()=>withDatabase(()=>{
 const a=addOcrReport(37,baseLines),b=addOcrReport(38,baseLines);
 assert.deepEqual(pauseDuplicateIfEligible(a),[]);assert.deepEqual(pauseDuplicateIfEligible(b),[]);
 completeAi(a);assert.equal(pauseDuplicateIfEligible(b).length,1);
}));
test('batch historical recovery queues once only after explicit manager execution',()=>withDatabase(()=>{
 const a=addOcrReport(39,baseLines);getDatabase().prepare("UPDATE reports SET status='needs_review' WHERE id=?").run(a);
 const job=getDatabase().prepare("SELECT id FROM processing_jobs WHERE report_id=? AND job_type='ocr'").get(a) as {id:string};
 getDatabase().prepare("INSERT INTO processing_job_events(id,job_id,report_id,event_type,status,detail_json) VALUES('legacy-batch',?,?,'completed','completed',?)").run(job.id,a,JSON.stringify({stage:'duplicate_precheck'}));
 saveAiSettings({enabled:true,baseUrl:'https://ai.example.test/v1',textModel:'synthetic',apiKey:'synthetic'});
 assert.equal(recoverDuplicateReports(manager,'duplicate-member',[a])[0].status,'queued');
 assert.equal(recoverDuplicateReports(manager,'duplicate-member',[a])[0].status,'skipped');
 assert.equal((getDatabase().prepare("SELECT COUNT(*) AS n FROM processing_jobs WHERE report_id=? AND job_type='ai_extract'").get(a) as {n:number}).n,1);
}));
test('full source multiset is order independent and keeps multiplicity and PDF selection identity',()=>withDatabase(()=>{
 const a=addOcrReport(40,baseLines),b=addOcrReport(41,baseLines);
 const db=getDatabase();db.prepare("UPDATE report_pages SET sha256='same',mime_type='application/pdf',source_page_number=1,source_page_count=2 WHERE report_id IN (?,?)").run(a,b);
 assert.equal(findLocalDuplicateEvidence(b)[0].evaluation.ruleId,'R0');
 db.prepare('UPDATE report_pages SET source_page_number=NULL WHERE report_id=?').run(b);
 assert.notEqual(findLocalDuplicateEvidence(b)[0]?.evaluation.ruleId,'R0');
 db.prepare('UPDATE report_pages SET source_page_number=2 WHERE report_id=?').run(b);
 assert.notEqual(buildDuplicateSnapshot(a)!.sourceSignature,buildDuplicateSnapshot(b)!.sourceSignature);
}));

test('equivalent decimal and exact dimension conversion preserve comparator, reference and flag differences',()=>{
 assert.equal(numericFactValue('5.10','g/L','0-10','normal'),numericFactValue('5100','mg/L','0-10000','normal'));
 assert.equal(numericFactValue('5.10 mmol/L','mmol/L',null,null),numericFactValue('5.1','mmol/L',null,null));
 assert.notEqual(numericFactValue('<5','g/L',null,null),numericFactValue('5','g/L',null,null));
});
test('reordered full image sets match, a single shared page or extra copy does not',()=>withDatabase(()=>{
 const a=addOcrReport(42,baseLines),b=addOcrReport(43,baseLines),db=getDatabase();
 db.prepare("UPDATE report_pages SET sha256='image-one' WHERE report_id=?").run(a);
 db.prepare("UPDATE report_pages SET sha256='image-two' WHERE report_id=?").run(b);
 const add=(id:string,page:number,sha:string)=>db.prepare("INSERT INTO report_pages(id,report_id,page_number,original_name,storage_path,mime_type,file_size,sha256) VALUES(?,?,?,'renamed.png',?,'image/png',1,?)").run(`${id}-${page}`,id,page,`${id}-${page}`,sha);
 add(a,2,'image-two');add(b,2,'image-one');assert.equal(completeSourceSignature(a),completeSourceSignature(b));
 db.prepare("UPDATE report_pages SET sha256='image-three' WHERE report_id=? AND page_number=2").run(b);assert.notEqual(completeSourceSignature(a),completeSourceSignature(b));
 db.prepare("UPDATE report_pages SET sha256='image-one' WHERE report_id=? AND page_number=2").run(b);add(a,3,'image-one');assert.notEqual(completeSourceSignature(a),completeSourceSignature(b));
}));
test('same multi-page PDF renamed is exact, subset and pending expansion are not',()=>withDatabase(()=>{
 const a=addOcrReport(44,baseLines),b=addOcrReport(45,baseLines),db=getDatabase();
 for(const id of [a,b]) {
  db.prepare("UPDATE report_pages SET sha256='synthetic-pdf',mime_type='application/pdf',source_page_number=1,source_page_count=2 WHERE report_id=?").run(id);
  db.prepare("INSERT INTO report_pages(id,report_id,page_number,original_name,storage_path,mime_type,file_size,sha256,source_page_number,source_page_count) VALUES(?,?,2,'renamed.pdf',?,'application/pdf',1,'synthetic-pdf',2,2)").run(`${id}-second`,id,id);
 }
 assert.equal(completeSourceSignature(a),completeSourceSignature(b));
 db.prepare('DELETE FROM report_pages WHERE report_id=? AND page_number=2').run(b);assert.notEqual(completeSourceSignature(a),completeSourceSignature(b));
 db.prepare('UPDATE report_pages SET source_page_number=NULL,source_page_count=NULL WHERE report_id=?').run(b);assert.equal(completeSourceSignature(b),null);
}));

test('distinct-and-continue transaction rolls back queue and intent if governance persistence fails',()=>withDatabase(()=>{
 const a=addOcrReport(46,baseLines),b=addOcrReport(47,baseLines);completeAi(a);
 saveAiSettings({enabled:true,baseUrl:'https://ai.example.test/v1',textModel:'synthetic',apiKey:'synthetic'});
 getDatabase().exec("CREATE TRIGGER reject_synthetic_decision BEFORE INSERT ON report_duplicate_decisions BEGIN SELECT RAISE(ABORT,'synthetic'); END");
 assert.throws(()=>continueDuplicateReport(manager,b,a));
 assert.equal((getDatabase().prepare("SELECT COUNT(*) AS n FROM processing_jobs WHERE report_id=? AND job_type='ai_extract'").get(b) as {n:number}).n,0);
 assert.equal(getDatabase().prepare('SELECT continue_job_id FROM report_duplicate_runtime WHERE report_id=?').get(b),undefined);
}));

test('governance history does not expose a report moved to another member',()=>withDatabase(()=>{
 const a=addOcrReport(48,baseLines),b=addOcrReport(49,baseLines);
 setReportDuplicateDecision(manager,{reportId:a,candidateReportId:b,decision:'duplicate'});
 getDatabase().prepare("INSERT INTO health_members(id,display_name,relationship,created_by) VALUES('other-member','合成其他成员','other',?)").run(manager.id);
 getDatabase().prepare("UPDATE reports SET member_id='other-member' WHERE id=?").run(b);
 assert.equal(listReportDuplicateDecisions(manager,'duplicate-member').length,0);
}));
