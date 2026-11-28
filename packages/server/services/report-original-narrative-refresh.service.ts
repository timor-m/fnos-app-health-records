import {createError} from 'h3';
import {getDatabase,runInTransaction} from '../database/client';
import type {RequestUser} from '../domain/request-user';
import {assertMemberManage} from './member.service';
import {listManualReportFieldKeys} from './report-field-overrides.service';
import {originalNarrativeFields,originalNarrativeFieldsFromSections,restoreOriginalNarrativeSections,
  type OriginalNarrativeField,type NarrativeOcrPage} from './report-original-narrative';

/** Local replay only: no job runner, provider, indicator normalization or status transition. */
export function refreshReportOriginalNarratives(user:RequestUser,reportId:string,sourceVersion:number) {
  if(!Number.isSafeInteger(sourceVersion) || sourceVersion<0) throw createError({statusCode:400,statusMessage:'报告版本无效，请刷新后重试'});
  const db=getDatabase();
  return runInTransaction(db,()=>{
    const report=db.prepare(`SELECT member_id AS memberId,source_version AS sourceVersion,status,
      summary,impression,recommendation,findings FROM reports WHERE id=? AND status<>'trashed' AND deleted_at IS NULL`).get(reportId) as
      (Record<OriginalNarrativeField,string|null>&{memberId:string;sourceVersion:number;status:string})|undefined;
    if(!report) throw createError({statusCode:404,statusMessage:'报告不存在或已删除'});
    assertMemberManage(user,report.memberId);
    if(report.sourceVersion!==sourceVersion) throw createError({statusCode:409,statusMessage:'报告已发生变化，请刷新后重试'});
    if(['processing','uploading'].includes(report.status) || db.prepare("SELECT 1 FROM processing_jobs WHERE report_id=? AND status IN ('queued','processing') LIMIT 1").get(reportId)) {
      throw createError({statusCode:409,statusMessage:'报告仍在处理中，请完成后再更新原文分组'});
    }
    if(db.prepare("SELECT 1 FROM report_page_appends WHERE report_id=? AND state NOT IN ('complete','ocr_only','noop','cancelled') LIMIT 1").get(reportId)) {
      throw createError({statusCode:409,statusMessage:'补充报告页尚未结束，请完成后再更新原文分组'});
    }
    const sourcePages=db.prepare(`SELECT p.page_number AS pageNumber,
      (SELECT o.lines_json FROM ocr_results o JOIN processing_jobs j ON j.id=o.job_id AND j.status='completed'
       WHERE o.page_id=p.id ORDER BY o.created_at DESC,o.id DESC LIMIT 1) AS linesJson
      FROM report_pages p WHERE p.report_id=? ORDER BY p.page_number`).all(reportId) as {pageNumber:number;linesJson:string|null}[];
    const pages:NarrativeOcrPage[]=sourcePages.map(page=>{
      let lines:unknown;
      try {lines=JSON.parse(page.linesJson || 'null');} catch { /* Report a recoverable source problem below. */ }
      if(!Array.isArray(lines) || !lines.some(line=>typeof line?.text==='string' && line.text.trim())) {
        throw createError({statusCode:409,statusMessage:'报告部分页面缺少可用的 OCR 文字，未修改内容，请先完成本地识别'});
      }
      return {pageNumber:page.pageNumber,lines:lines.filter(line=>typeof line?.text==='string')};
    });
    if(!pages.length) throw createError({statusCode:409,statusMessage:'报告没有可用的 OCR 文字，未修改内容'});
    const extraction=db.prepare(`SELECT e.fields_json AS fieldsJson FROM report_extractions e
      JOIN processing_jobs j ON j.id=e.job_id AND j.status='completed'
      WHERE e.report_id=? ORDER BY e.created_at DESC,e.id DESC LIMIT 1`).get(reportId) as {fieldsJson:string}|undefined;
    let saved:Record<string,unknown>={};
    try {const value=JSON.parse(extraction?.fieldsJson || '{}');if(value && typeof value==='object' && !Array.isArray(value)) saved=value;} catch { /* Explicit OCR headings still work without saved AI references. */ }
    const previous={...Object.fromEntries(originalNarrativeFields.map(field=>[field,typeof saved[field]==='string'?saved[field]:report[field]])),narrativeSections:saved.narrativeSections};
    const restored=originalNarrativeFieldsFromSections(restoreOriginalNarrativeSections(pages,previous));
    const manual=listManualReportFieldKeys(reportId);
    const protectedFields=originalNarrativeFields.filter(field=>manual.has(field));
    // An unrecognised old section is retained rather than silently erased.
    const unresolvedFields=originalNarrativeFields.filter(field=>!manual.has(field) && !restored[field] && Boolean(report[field]));
    const updatedFields=originalNarrativeFields.filter(field=>!manual.has(field) && restored[field] && restored[field]!==report[field]);
    if(updatedFields.length) db.prepare(`UPDATE reports SET ${updatedFields.map(field=>`${field}=?`).join(',')},
      source_version=source_version+1,updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(...updatedFields.map(field=>restored[field]),reportId);
    return {updatedFields,protectedFields,unresolvedFields,sourceVersion:report.sourceVersion+(updatedFields.length?1:0)};
  });
}
