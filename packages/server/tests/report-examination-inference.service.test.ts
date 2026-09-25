import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDatabaseForTests, getDatabase } from '../database/client';
import { backfillDocumentWideObservationDates, expandTemporalObservationColumns, inferObservationExamination, type ExaminationSourcePage } from '../services/report-examination-inference.service';
import { resolveExaminationTime } from '../domain/examination';
import type { AiObservation } from '../services/ai-extraction.service';

const page = (lines: string[], pageNumber = 1): ExaminationSourcePage => ({id:`page-${pageNumber}`,pageNumber,lines:lines.map(text=>({text}))});
const observation = (quote: string, pageNumber = 1): AiObservation => ({sectionName:'检验',itemCode:null,itemName:'合成指标',normalizedName:null,resultText:'80',numericValue:80,unit:'U/L',referenceLow:null,referenceHigh:null,referenceText:null,abnormalFlag:null,method:null,evidence:[{pageNumber,quote}]});

test('dated table columns retain equal and different measurements with separate verified times',()=>{
 for(const first of ['120','80']) {
  const row=`合成指标 | ${first} | 80 | U/L`;
  const pages=[page(['报告编号：SYNTHETIC','项目 | 2026-09-01 | 2026-09-08 | 单位',row])];
  const expanded=expandTemporalObservationColumns([observation(row)],pages);
  assert.deepEqual(expanded.map(o=>o.resultText),[first,'80']);
  const inferred=expanded.map(o=>inferObservationExamination(o,pages));
  assert.ok(inferred.every(e=>e.certain));
  assert.deepEqual(inferred.map(e=>resolveExaminationTime(e).occurredAt),['2026-09-01','2026-09-08']);
  assert.notEqual(inferred[0].sourceKey,inferred[1].sourceKey);
 }
});

test('stage-only columns retain both measurements without guessing admission or discharge dates',()=>{
 const row='合成指标 | 120 | 80';
 const pages=[page(['出院日期：2026-09-08','项目 | 入院时 | 出院时',row])];
 const expanded=expandTemporalObservationColumns([observation(row)],pages);
 assert.equal(expanded.length,2);
 for(const item of expanded){const inferred=inferObservationExamination(item,pages);assert.equal(inferred.certain,false);assert.equal(resolveExaminationTime(inferred).occurredAt,null);}
});

test('date hints cannot reach another examination block, a later header, or an ambiguous row',()=>{
 const row='合成指标 | 80';
 const hinted={...observation(row),examination:{timeText:'2026-09-01'}};
 const cases=[
  ['项目 | 2026-09-01','报告编号：SECOND',row],
  [row,'项目 | 2026-09-01'],
  ['项目 | 2026-09-01',row,'报告编号：SECOND','检查日期：2026-09-08',row],
  ['项目 | 2026-09-01 | 2026-09-01','合成指标 | 80 | 80'],
 ];
 for(const lines of cases){const item=lines.at(-1)==='合成指标 | 80 | 80'?{...hinted,evidence:[{pageNumber:1,quote:lines.at(-1)!}]}:hinted;assert.equal(inferObservationExamination(item,[page(lines)]).certain,false);}
});

test('explicit matching report numbers allow continuation dates and contradictory dates remain pending',()=>{
 const row='合成指标 80 U/L';
 const pages=[page(['报告编号：SYNTHETIC','采样时间：2026-09-01']),page(['报告编号：SYNTHETIC',row],2)];
 const inferred=inferObservationExamination(observation(row,2),pages);
 assert.equal(inferred.certain,true);assert.equal(resolveExaminationTime(inferred).occurredAt,'2026-09-01');
 const conflict=[...pages,page(['报告编号：SYNTHETIC','采样时间：2026-09-08'],3)];
 assert.equal(inferObservationExamination(observation(row,2),conflict).certain,false);
 assert.equal(inferObservationExamination(observation(row),[page(['打印日期：2026-09-08',row])]).certain,false);
 assert.equal(inferObservationExamination(observation(row),[page(['采样时间：2026-02-30',row])]).certain,false);
});

test('typed footer time applies within its examination block but not across the next report',()=>{
 const row='合成指标 80 U/L';
 const footer=inferObservationExamination(observation(row),[page(['报告编号：SYNTHETIC',row,'报告日期：2026-09-08'])]);
 assert.equal(footer.certain,true);assert.equal(resolveExaminationTime(footer).occurredAt,'2026-09-08');
 const next=inferObservationExamination(observation(row),[page([row,'报告编号：NEXT','报告日期：2026-09-08'])]);
 assert.equal(next.certain,false);
 const ambiguous=inferObservationExamination(observation(row),[page(['报告日期：2026-09-01',row,'报告日期：2026-09-08'])]);
 assert.equal(ambiguous.certain,false);
});

test('continuation inheritance uses the matching block rather than another examination on that page',()=>{
 const row='合成指标 80 U/L';
 const continuation=page(['报告编号：TARGET',row],2);
 const infer=(lines:string[])=>inferObservationExamination(observation(row,2),[page(lines),continuation]);
 assert.equal(infer(['报告编号：TARGET','普通说明','报告编号：OTHER','采样时间：2026-09-08']).certain,false,'an unrelated block cannot donate its date');
 const matched=infer(['报告编号：OTHER','采样时间：2026-09-08','报告编号：TARGET','采样时间：2026-09-01']);
 assert.equal(matched.certain,true);
 assert.equal(resolveExaminationTime(matched).occurredAt,'2026-09-01');
 assert.ok(matched.evidence?.every(e=>!e.quote.includes('OTHER')));
});

test('historical examination headings isolate current and referenced measurements',()=>{
 const current='合成指标 80 U/L',past='合成指标 120 U/L';
 const pages=[page(['报告编号：CURRENT','报告日期：2026-09-08',current,'【历史检查结果（2025-07-12）】','报告编号：PAST','检查日期：2025-07-12',past])];
 const now=inferObservationExamination(observation(current),pages);
 const then=inferObservationExamination({...observation(past),resultText:'120',numericValue:120},pages);
 assert.equal(now.certain,true);assert.equal(then.certain,true);
 assert.equal(resolveExaminationTime(now).occurredAt,'2026-09-08');
 assert.equal(resolveExaminationTime(then).occurredAt,'2025-07-12');
 assert.notEqual(now.sourceKey,then.sourceKey);
});

test('a missing result in one date column does not discard the other column time',()=>{
 const row='合成指标 |  | 80 | U/L';
 const pages=[page(['报告编号：SYNTHETIC','项目 | 2026-09-01 | 2026-09-08 | 单位',row])];
 const expanded=expandTemporalObservationColumns([observation(row)],pages);
 assert.equal(expanded.length,1);
 assert.equal(expanded[0].examination?.timeText,'2026-09-08');
 assert.equal(resolveExaminationTime(inferObservationExamination(expanded[0],pages)).occurredAt,'2026-09-08');
});

test('column recovery does not cross a newer table header or pick an ambiguous source row',()=>{
 const row='合成指标 | 120 | 80 | U/L';
 const source=observation(row);
 const newer=[page(['项目 | 2026-09-01 | 2026-09-08 | 单位','项目 | 左侧 | 右侧 | 单位',row])];
 assert.deepEqual(expandTemporalObservationColumns([source],newer),[source]);
 const duplicate=[page(['项目 | 2026-09-01 | 2026-09-08 | 单位',row,'项目 | 2026-10-01 | 2026-10-08 | 单位',row])];
 assert.deepEqual(expandTemporalObservationColumns([source],duplicate),[source]);
});

test('continuation inherits verified header identity and groups with the first page',()=>{
 const firstRow='合成指标 80 U/L',nextRow='另一合成指标 90 U/L';
 const pages=[page(['机构：合成机构','报告名称：生化检验','标本：血清','报告编号：SYNTHETIC','采样时间：2026-09-01',firstRow]),page(['报告编号：SYNTHETIC',nextRow],2)];
 const first=inferObservationExamination(observation(firstRow),pages);
 const next=inferObservationExamination({...observation(nextRow,2),sectionName:'其他分类',resultText:'90',numericValue:90},pages);
 assert.equal(first.certain,true);assert.equal(next.certain,true);
 assert.equal(next.institution,'合成机构');assert.equal(next.specimen,'血清');
 assert.equal(next.sourceKey,first.sourceKey,'different indicator sections do not split a verified continuation examination');
 const datedContinuation=[pages[0],page(['报告编号：SYNTHETIC','采样时间：2026-09-01',nextRow],2)];
 assert.equal(inferObservationExamination(observation(nextRow,2),datedContinuation).sourceKey,first.sourceKey);
 const contradictory=[...pages,page(['机构：合成机构','报告名称：另一检查','报告编号：SYNTHETIC','采样时间：2026-09-01'],3)];
 assert.equal(inferObservationExamination(observation(nextRow,2),contradictory).certain,false);
});

test('verified local dates do not require an examination number or merge independent pages',()=>{
 const row='合成指标 80 U/L';
 const inferred=inferObservationExamination(observation(row),[page(['采样时间：2026-09-01',row])]);
 assert.equal(inferred.certain,true);
 const other=inferObservationExamination(observation(row,2),[page(['采样时间：2026-09-01',row],2)]);
 assert.equal(other.certain,true);
 assert.notEqual(inferred.sourceKey,other.sourceKey,'without an explicit identity distinct pages remain separate');
 assert.equal(inferObservationExamination(observation(row),[page([row])]).certain,false,'missing date still requires confirmation');
 assert.equal(inferred.sampledAt,'2026-09-01');
 assert.equal(resolveExaminationTime(inferred).occurredAt,'2026-09-01');
});

test('an undated page inherits the unique document date at date precision only',()=>{
 const row='合成指标 80 U/L';
 const pages=[page(['体检日期：2026-09-08 09:30'],1),page(['检查时间：2026-09-08 11:15'],2),page([row],3)];
 const inferred=inferObservationExamination(observation(row,3),pages);
 assert.equal(inferred.certain,true);
 assert.equal(resolveExaminationTime(inferred).occurredAt,'2026-09-08');
 assert.equal(resolveExaminationTime(inferred).timePrecision,'date');
 assert.ok(inferred.evidence?.some(e=>e.pageNumber===1),'the inherited date retains its source page');
});

test('document-wide date fallback stops when the report date or local block is ambiguous',()=>{
 const row='合成指标 80 U/L';
 const multiDay=[page(['体检日期：2026-09-08'],1),page(['体检日期：2026-09-10'],2),page([row],3)];
 assert.equal(inferObservationExamination(observation(row,3),multiDay).certain,false);
 const localConflict=[page(['体检日期：2026-09-08'],1),page(['检查日期：2026-09-08','检查日期：2026-09-10',row],2)];
 const conflicted=inferObservationExamination(observation(row,2),localConflict);
 assert.equal(conflicted.certain,false);
 assert.equal(resolveExaminationTime(conflicted).occurredAt,null);
});

test('report date fills an undated observation even when other report pages contain different dates',()=>{
 const row='合成指标 80 U/L';
 const pages=[page(['检查日期：2026-09-01'],1),page([row],2),page(['检查日期：2026-09-10'],3)];
 const inferred=inferObservationExamination(observation(row,2),pages,'2026-09-08');
 assert.equal(inferred.certain,true);
 assert.equal(inferred.issuedAt,'2026-09-08');
 assert.equal(resolveExaminationTime(inferred).occurredAt,'2026-09-08');
 assert.equal(resolveExaminationTime(inferred).timePrecision,'date');
 const datedColumn={...observation(row,2),examination:{timeText:'2026-09-10'}};
 const columnPages=[page(['2026-09-10',row],2)];
 const column=inferObservationExamination(datedColumn,columnPages,'2026-09-08');
 assert.equal(column.examinedAt,'2026-09-10','an explicit observation date takes precedence over the report date');
 assert.equal(resolveExaminationTime(column).occurredAt,'2026-09-10');
 const broadPage=page(['检查日期：2026-09-01','检查日期：2026-09-10',row]);
 const broad=inferObservationExamination(observation(row),[broadPage],'2026-09-08');
 assert.equal(broad.certain,true,'page-wide unrelated date ambiguity falls back to the report date');
 assert.equal(resolveExaminationTime(broad).occurredAt,'2026-09-08');
});

test('startup backfill uses the report date for old undated observations after an earlier backfill',()=>{
 const env={...process.env},dir=mkdtempSync(join(tmpdir(),'report-wide-date-'));process.env.STORAGE_DIR=dir;
 try {
  const db=getDatabase();
  db.exec(`INSERT INTO users(id,display_name) VALUES('date-owner','synthetic');
   INSERT INTO health_members(id,display_name,created_by) VALUES('date-member','synthetic','date-owner');
   INSERT INTO reports(id,member_id,created_by,report_type,title,status,report_issued_at) VALUES('date-report','date-member','date-owner','checkup','synthetic','needs_review','2026-09-07');
   INSERT INTO report_pages(id,report_id,page_number,original_name,storage_path,mime_type,file_size,sha256)
    VALUES('date-page-1','date-report',1,'one.pdf','synthetic-1','application/pdf',1,'synthetic-1'),('date-page-2','date-report',2,'two.pdf','synthetic-2','application/pdf',1,'synthetic-2'),('date-page-3','date-report',3,'three.pdf','synthetic-3','application/pdf',1,'synthetic-3');
   INSERT INTO processing_jobs(id,report_id,page_id,job_type,status,pipeline_version,deduplication_key)
    VALUES('date-job-1','date-report','date-page-1','ocr','completed','test','date-job-1'),('date-job-2','date-report','date-page-2','ocr','completed','test','date-job-2'),('date-job-3','date-report','date-page-3','ocr','completed','test','date-job-3');
   INSERT INTO ocr_results(id,job_id,page_id,engine,model_version,lines_json) VALUES
    ('date-ocr-1','date-job-1','date-page-1','test','test','[{"text":"体检日期：2026-09-08 09:30"}]'),
    ('date-ocr-2','date-job-2','date-page-2','test','test','[{"text":"合成指标 80 U/L"}]'),
    ('date-ocr-3','date-job-3','date-page-3','test','test','[{"text":"检查日期：2026-09-10"}]');
   INSERT INTO observations(id,report_id,section_name,item_name,result_text,numeric_value,evidence_json)
    VALUES('date-observation','date-report','一般检查','合成指标','80',80,'[{"pageNumber":2,"quote":"合成指标 80 U/L"}]');
   INSERT INTO report_examinations(id,report_id,source_key,time_text,evidence_json,confirmation_status)
    VALUES('date-pending','date-report','old-pending','未识别日期','[]','pending');
   INSERT INTO observation_examinations(observation_id,examination_id,assignment_source)
    VALUES('date-observation','date-pending','automatic');
   INSERT INTO app_settings(setting_key,value_json) VALUES('observation.document_wide_date_backfill_v1','{}'),('observation.report_date_backfill_v2','{}');`);
  assert.deepEqual(backfillDocumentWideObservationDates(),{scanned:1,assigned:1,alreadyCompleted:false});
  const assigned=db.prepare(`SELECT e.occurred_at AS occurredAt,e.time_precision AS precision,e.confirmation_status AS status,e.evidence_json AS evidence
   FROM observation_examinations l JOIN report_examinations e ON e.id=l.examination_id WHERE l.observation_id='date-observation'`).get() as {occurredAt:string;precision:string;status:string;evidence:string};
  assert.deepEqual([assigned.occurredAt,assigned.precision,assigned.status],['2026-09-07','date','automatic']);
  assert.deepEqual(backfillDocumentWideObservationDates(),{scanned:0,assigned:0,alreadyCompleted:true});
 } finally { closeDatabaseForTests(); process.env=env; rmSync(dir,{recursive:true,force:true}); }
});
