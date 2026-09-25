import {createHash} from 'node:crypto';
import {getDatabase} from '../database/client';
import {parseExaminationTime,resolveExaminationTime,type ExaminationInput} from '../domain/examination';
import type {AiObservation} from './ai-extraction.service';
import type {AiMorphologyFinding} from './ai-extraction.service';
import {rebuildOcrPages} from './ai-input-planner.service';

const compact=(value:unknown)=>String(value || '').normalize('NFKC').replace(/\s+/g,'').toLowerCase();
const datePattern='(?:19|20|21)\\d{2}[-/.年]\\d{1,2}[-/.月]\\d{1,2}日?(?:[ T]\\d{1,2}[:：]\\d{2}(?:[:：]\\d{2})?)?';
export type ExaminationSourcePage={id:string;pageNumber:number;lines:Array<{id?:string;text:string}>};
export type InferredExamination=ExaminationInput & {sourceKey:string;certain:boolean;risks:string[];wholeReportDate:boolean};
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const cells=(text:string)=>text.split(/[|｜\t]/).map(part=>part.trim());
const examinationBoundary=/(?:报告编号|报告单号|检验单号|检查单号)\s*[:：]|^\s*【?(?:历史|既往)检查结果[（(:：\s]/;
function examinationBlocks(page:ExaminationSourcePage) {
 const starts=new Set([0]);
 page.lines.forEach((line,index)=>{
  if(!examinationBoundary.test(line.text))return;
  let start=index;
  while(start>0 && /^(?:医院名称|机构名称|机构|报告名称|检查项目|检验项目|标本类型|标本|样本类型|检测方法|检验方法)\s*[:：]/.test(page.lines[start-1].text))start--;
  starts.add(start);
 });
 const ordered=[...starts].sort((a,b)=>a-b);
 return ordered.map((start,index)=>({start,end:ordered[index+1] ?? page.lines.length,text:page.lines.slice(start,ordered[index+1] ?? page.lines.length).map(line=>line.text).join('\n')}));
}

export function examinationSourcePages(reportId:string): ExaminationSourcePage[] {
 const rows=getDatabase().prepare(`SELECT p.id,p.page_number AS pageNumber,o.lines_json AS linesJson
 FROM report_pages p JOIN ocr_results o ON o.page_id=p.id WHERE p.report_id=? ORDER BY p.page_number,o.created_at DESC,o.rowid DESC`).all(reportId) as Array<{id:string;pageNumber:number;linesJson:string}>;
 const seen=new Set<string>();
 const latest=rows.flatMap(row=>{
  if(seen.has(row.id))return [];seen.add(row.id);
  try {const parsed=JSON.parse(row.linesJson);return Array.isArray(parsed)?[{pageId:row.id,pageNumber:row.pageNumber,linesJson:row.linesJson}]:[];}catch{return [];}
 });
 // Use the same reconstructed rows as extraction; raw OCR may store one cell per line.
 // Reconstruct independently so input-budget cleanup cannot remove a repeated date header
 // from later pages. Examination evidence must retain each page's own temporal context.
 return latest.flatMap(row=>rebuildOcrPages([row])).map(page=>({id:page.pageId,pageNumber:page.pageNumber,lines:page.lines.map(line=>({id:line.id,text:line.text}))}));
}
function typedDates(text:string) {
 const values:ExaminationInput={};const risks:string[]=[];
 const labels=[['sampledAt','采样|采血|标本采集'],['examinedAt','体检|检查|检验|检测|(?:历史|既往)检查结果[（(]?'],['issuedAt','报告|签发|审核']] as const;
 for(const [key,label] of labels){
  const matches=[...text.matchAll(new RegExp(`(?:${label})(?:日期|时间)?\\s*[:：]?\\s*(${datePattern})`,'g'))];
  const distinct=[...new Set(matches.map(match=>parseExaminationTime(match[1])?.value || match[1]))];
  if(distinct.length===1)values[key]=distinct[0];else if(distinct.length>1)risks.push(`${key}_ambiguous`);
 }
 return {values,risks};
}
function documentWideDate(pages:ExaminationSourcePage[],preferredField:'sampledAt'|'examinedAt',targetPageNumber:number,targetBlockStart:number,targetReportNumber:string) {
 const fields=[preferredField,preferredField==='sampledAt'?'examinedAt':'sampledAt','issuedAt'] as const;
 const blocks=pages.flatMap(page=>examinationBlocks(page).map(block=>({page,block,reportNumber:metadata(block.text).reportNumber})));
 const reportNumbers=new Set(blocks.map(item=>item.reportNumber).filter(Boolean));
 if(reportNumbers.size>1 || (targetReportNumber && reportNumbers.size===1 && !reportNumbers.has(targetReportNumber)))return null;
 for(const field of fields){
  const candidates=blocks.flatMap(({page,block,reportNumber})=>{
   if(page.pageNumber===targetPageNumber && block.start>=targetBlockStart)return [];
   if(targetReportNumber && reportNumber && reportNumber!==targetReportNumber)return [];
   const parsed=typedDates(block.text),raw=parsed.values[field];
   if(!raw || parsed.risks.includes(`${field}_ambiguous`))return [];
   const time=parseExaminationTime(raw);if(!time)return [];
   return [{date:time.value.slice(0,10),page,quote:block.text.slice(0,1000)}];
  });
  if(!candidates.length)continue;
  const dates=[...new Set(candidates.map(item=>item.date))];
  if(dates.length!==1)return null;
  return {date:dates[0],field,page:candidates[0].page,quote:candidates[0].quote};
 }
 return null;
}
function metadata(text:string) {
 const capture=(pattern:RegExp)=>text.match(pattern)?.[1]?.trim() || '';
 return {
  reportNumber:capture(/(?:报告编号|报告单号|检验单号|检查单号)\s*[:：]\s*([^\s|｜，,;；]+)/),
  institution:capture(/(?:医院名称|机构名称|机构)\s*[:：]\s*([^\n|｜，,;；]+)/),
  examinationType:capture(/(?:检查项目|检验项目|报告名称)\s*[:：]\s*([^\n|｜，,;；]+)/),
  specimen:capture(/(?:标本类型|标本|样本类型)\s*[:：]\s*([^\s|｜，,;；]+)/),
  method:capture(/(?:检测方法|检验方法)\s*[:：]\s*([^\n|｜，,;；]+)/)
 };
}

/** Prefer row/column dates, then a unique document date, then the confirmed report date. */
export function inferObservationExamination(observation:AiObservation,pages:ExaminationSourcePage[],reportDate?:string|null):InferredExamination {
 const risks:string[]=[];
 const evidence=observation.evidence[0];
 const page=pages.find(p=>p.pageNumber===evidence?.pageNumber);
 const quote=evidence?.quote || '';
 const matchingRows=page?.lines.flatMap((line,index)=>compact(line.text).includes(compact(quote)) && !!compact(quote)?[index]:[]) || [];
 const rowIndex=matchingRows.length===1?matchingRows[0]:-1;
 if(matchingRows.length>1)risks.push('source_row_ambiguous');
 let context='';let contextStart=0;
 if(page && rowIndex>=0){
  const block=examinationBlocks(page).find(block=>rowIndex>=block.start && rowIndex<block.end)!;
  contextStart=block.start;context=block.text;
 }
 const direct=typedDates(quote);
 const header=typedDates(context);
 const meta=metadata(context);
 let wholeReportDate=false;
 let input:ExaminationInput={...meta,examinationType:meta.examinationType || observation.sectionName || '',timeText:context.slice(0,1000),evidence:page?[{pageId:page.id,pageNumber:page.pageNumber,quote:context || quote}]:[]};
 const hint=observation.examination;
 const columnHeader=evidence?.table?.resultColumn?.headerText || '';
 const selectedHeader=hint?.timeText || (new RegExp(datePattern).test(columnHeader) || /入院时|出院时|入院前|出院后/.test(columnHeader) ? columnHeader : '');
 if(selectedHeader){
  // A model hint is usable only if this exact header exists in this observation's page.
  const sourceHeaders=page?.lines.slice(contextStart,rowIndex+1).filter(line=>cells(line.text).some(cell=>compact(cell)===compact(selectedHeader)) || compact(line.text)===compact(selectedHeader)) || [];
  const sourceHeader=sourceHeaders.length===1?sourceHeaders[0]:undefined;
  const dates=[...selectedHeader.matchAll(new RegExp(datePattern,'g'))];
  if(sourceHeader && (dates.length===1 || (dates.length===0 && /入院时|出院时|入院前|出院后/.test(selectedHeader)))){
   const explicit=typedDates(selectedHeader);input={...input,...explicit.values};
   if(!Object.keys(explicit.values).length && dates.length===1)input.examinedAt=dates[0][0];
   input.timeText=selectedHeader;
   input.evidence=[{pageId:page!.id,pageNumber:page!.pageNumber,quote:sourceHeader.text}];
   // Column hints must also point to a cell containing this value, not simply another date on the page.
   const headerCells=cells(sourceHeader.text),rowCells=cells(page!.lines[rowIndex]?.text || quote);
   const columns=headerCells.flatMap((cell,index)=>compact(cell)===compact(selectedHeader)?[index]:[]);
   const column=columns.length===1?columns[0]:-1;
   if(headerCells.length>1 && (column<0 || !rowCells[column] || compact(rowCells[column]).replace(/[↑↓]/g,'')!==compact(observation.resultText).replace(/[↑↓]/g,'')))risks.push('column_result_unverified');
  } else risks.push('time_hint_unverified');
 } else if(Object.keys(direct.values).length){input={...input,...direct.values};risks.push(...direct.risks);}
 else {
  input={...input,...header.values};
  // A complete PDF may print its single examination date only on a summary page.
  // Reuse the date, never its time, only when this row/block has no competing date evidence.
  const onlyBroadDateAmbiguity=!Object.keys(header.values).length && header.risks.length>0 && header.risks.every(risk=>/^(?:sampledAt|examinedAt|issuedAt)_ambiguous$/.test(risk));
  const mayUseReportDate=!direct.risks.length && !Object.keys(direct.values).length && !Object.keys(header.values).length && (!header.risks.length || onlyBroadDateAmbiguity);
  if(page && rowIndex>=0 && mayUseReportDate){
   const lab=/检验|化验|血常规|尿常规|生化|lab|laboratory/i.test(observation.sectionName || '');
   const documentDate=onlyBroadDateAmbiguity?null:documentWideDate(pages,lab?'sampledAt':'examinedAt',page.pageNumber,contextStart,meta.reportNumber || '');
   let dateResolved=false;
   if(documentDate){
    input[documentDate.field]=documentDate.date;
    const sourceLabel=documentDate.field==='sampledAt'?'采样':documentDate.field==='issuedAt'?'报告':'检查';
    input.timeText=`整份报告唯一${sourceLabel}日期：${documentDate.date}`;
    input.evidence=[...(input.evidence || []),{pageId:documentDate.page.id,pageNumber:documentDate.page.pageNumber,quote:documentDate.quote}];
    wholeReportDate=true;
    dateResolved=true;
   } else {
    // The report's already-confirmed date is the final fallback for an undated
    // observation. Explicit row/column dates and local date conflicts above win.
    const fallback=parseExaminationTime(reportDate);
    if(fallback){
     input.issuedAt=fallback.value;
     input.timeText=`报告日期：${fallback.value}`;
     wholeReportDate=true;
     dateResolved=true;
    }
   }
   if(!dateResolved || !onlyBroadDateAmbiguity)risks.push(...header.risks);
  } else {
   risks.push(...header.risks);
  }
 }
 if(!page || rowIndex<0)risks.push('source_unverified');
 // A continuation page may inherit only from an explicit matching report number.
 if(meta.reportNumber && !selectedHeader){
  const related=pages.filter(p=>p.id!==page?.id).flatMap(p=>examinationBlocks(p).map(block=>({page:p,text:block.text})));
  const candidates=related.map(c=>({...c,dates:typedDates(c.text),meta:metadata(c.text)})).filter(c=>c.meta.reportNumber===meta.reportNumber && !c.dates.risks.length && (!meta.institution || !c.meta.institution || meta.institution===c.meta.institution));
  const signatures=new Set(candidates.map(c=>JSON.stringify(c.dates.values)).filter(v=>v!=='{}'));
  if(signatures.size===1){
   const source=candidates.find(c=>Object.keys(c.dates.values).length)!;
   for(const key of ['sampledAt','examinedAt','issuedAt'] as const){
    const inherited=source.dates.values[key];
    if(input[key] && inherited && input[key]!==inherited)risks.push(`${key}_ambiguous`);
    else if(!input[key] && inherited)input[key]=inherited;
   }
   input.evidence=[...(input.evidence || []),{pageId:source.page.id,pageNumber:source.page.pageNumber,quote:source.text.slice(0,1000)}];
   for(const key of ['institution','examinationType','specimen','method'] as const){
    const values=[...new Set([meta[key],...candidates.map(c=>c.meta[key])].filter(Boolean))];
    if(values.length>1)risks.push(`${key}_ambiguous`);
    else if(values.length===1)input[key]=values[0];
   }
  }
 }
 const time=resolveExaminationTime(input);risks.push(...time.risks);
 const certain=!!time.occurredAt && !risks.length;
 const scope=meta.reportNumber ? ['report',input.institution,meta.reportNumber] : ['block',page?.id || evidence?.pageNumber || '',contextStart];
 const sourceKey=digest([scope,input.sampledAt,input.examinedAt,input.issuedAt,input.examinationType,input.specimen,input.method,selectedHeader || '',certain?'dated':quote]);
 return {...input,sourceKey,certain,risks:[...new Set(risks)],wholeReportDate};
}

/** Expand explicit multi-date table cells without inventing values or dates.
 * The base row must already have been recognized as an observation by the normal pipeline. */
export function expandTemporalObservationColumns(observations:AiObservation[],pages:ExaminationSourcePage[]):AiObservation[] {
 return observations.flatMap(observation=>{
  const evidence=observation.evidence[0],page=pages.find(p=>p.pageNumber===evidence?.pageNumber);
  if(!page || !evidence)return [observation];
  const matchingRows=page.lines.flatMap((line,index)=>compact(line.text)===compact(evidence.quote)?[index]:[]);
  if(matchingRows.length!==1)return [observation];
  const index=matchingRows[0];
  const row=cells(page.lines[index].text);if(row.length<3)return [observation];
  let header:string[]=[];
  for(let i=index-1;i>=0;i--){const candidate=cells(page.lines[i].text);if(candidate.length===row.length && candidate.filter(c=>new RegExp(datePattern).test(c) || /入院时|出院时|入院前|出院后/.test(c)).length>=2){header=candidate;break;}if(examinationBoundary.test(page.lines[i].text) || (candidate.length>1 && /^(?:项目|名称|检测项目|检验项目)$/.test(candidate[0])))break;}
  if(!header.length)return [observation];
  const expanded:AiObservation[]=[];
  for(let col=0;col<header.length;col++){
   if(!new RegExp(datePattern).test(header[col]) && !/入院时|出院时|入院前|出院后/.test(header[col]))continue;
   const result=row[col];if(!/^(?:[<>≤≥]?[+-]?\d+(?:\.\d+)?\s*[↑↓]?|阴性|阳性|[-+]{1,3})$/.test(result))continue;
   const parsed=Number(result.replace(/[↑↓]/g,''));
   expanded.push({...observation,resultText:result,numericValue:Number.isFinite(parsed)?parsed:null,abnormalFlag:/↑/.test(result)?'high':/↓/.test(result)?'low':null,examination:{timeText:header[col]},evidence:[{...evidence,quote:page.lines[index].text}]});
  }
  return expanded.length?expanded:[observation];
 });
}

export function publishExaminationAssignments(reportId:string,observations:Array<{id:string;observation:AiObservation}>,pages:ExaminationSourcePage[],legacyIds:Set<string>) {
 // No OCR exists in historical/import-only adapters. Their original compatibility path remains explicit.
 if(!pages.length)return;
 const db=getDatabase();
 const reportDate=(db.prepare('SELECT report_issued_at AS reportDate FROM reports WHERE id=?').get(reportId) as {reportDate:string|null}|undefined)?.reportDate;
 const included=new Set(observations.map(item=>item.id));
 const restored=db.prepare(`SELECT o.id,o.section_name AS sectionName,o.item_name AS itemName,o.result_text AS resultText,
   o.numeric_value AS numericValue,o.unit,o.evidence_json AS evidenceJson FROM observations o
   JOIN observation_examinations l ON l.observation_id=o.id JOIN report_examinations e ON e.id=l.examination_id
   WHERE o.report_id=? AND l.assignment_source='automatic' AND e.confirmation_status='pending'`).all(reportId);
 const candidates=[...observations,...restored.filter(row=>!included.has(String(row.id))).map(row=>({id:String(row.id),observation:{
   sectionName:row.sectionName,itemName:row.itemName,resultText:row.resultText,numericValue:row.numericValue,unit:row.unit,
   evidence:JSON.parse(String(row.evidenceJson))
 } as AiObservation}))];
 for(const {id,observation} of candidates){
  if(legacyIds.has(id))continue;
  const existing=db.prepare(`SELECT e.id AS examinationId,l.assignment_source,e.confirmation_status FROM observation_examinations l
    JOIN report_examinations e ON e.id=l.examination_id WHERE l.observation_id=?`).get(id);
  if(existing && (existing.assignment_source==='manual' || existing.confirmation_status!=='pending'))continue;
  const inferred=inferObservationExamination(observation,pages,reportDate),time=resolveExaminationTime(inferred);
  // A retry may now have sufficient evidence. Keep manual/confirmed assignments untouched.
  if(existing && !inferred.certain)continue;
  if(existing)db.prepare('DELETE FROM observation_examinations WHERE observation_id=?').run(id);
  const examId=`exam_${digest([reportId,inferred.sourceKey]).slice(0,32)}`;
  db.prepare(`INSERT INTO report_examinations(id,report_id,source_key,examination_type,institution,report_number,specimen,method,sampled_at,examined_at,issued_at,occurred_at,time_kind,time_precision,time_text,evidence_json,confirmation_status)
   VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET occurred_at=excluded.occurred_at,time_kind=excluded.time_kind,time_precision=excluded.time_precision,confirmation_status=excluded.confirmation_status WHERE report_examinations.confirmation_status='pending' AND excluded.confirmation_status='automatic'`).run(examId,reportId,inferred.sourceKey,inferred.examinationType || '',inferred.institution || '',inferred.reportNumber || '',inferred.specimen || '',inferred.method || '',time.sampledAt,time.examinedAt,time.issuedAt,inferred.certain?time.occurredAt:null,inferred.certain?time.timeKind:'unknown',inferred.certain?time.timePrecision:'unknown',inferred.timeText || '',JSON.stringify(inferred.evidence || []),inferred.certain?'automatic':'pending');
  db.prepare("INSERT INTO observation_examinations(observation_id,examination_id,assignment_source) VALUES(?,?,'automatic')").run(id,examId);
  if(existing && existing.examinationId!==examId)db.prepare(`DELETE FROM report_examinations WHERE id=? AND confirmation_status='pending'
   AND NOT EXISTS(SELECT 1 FROM observation_examinations WHERE examination_id=?)
   AND NOT EXISTS(SELECT 1 FROM morphology_finding_examinations WHERE examination_id=?)`).run(existing.examinationId,existing.examinationId,existing.examinationId);
 }
 db.prepare('INSERT OR IGNORE INTO report_examination_state(report_id) VALUES(?)').run(reportId);
}

/** Upgrade old automatic pending indicator dates once, without changing manual or confirmed links. */
export function backfillDocumentWideObservationDates() {
 const db=getDatabase(),marker='observation.report_date_backfill_v3';
 if(db.prepare('SELECT 1 FROM app_settings WHERE setting_key=?').get(marker))return {scanned:0,assigned:0,alreadyCompleted:true};
 const rows=db.prepare(`SELECT o.id,o.report_id AS reportId,o.section_name AS sectionName,o.item_code AS itemCode,
   o.item_name AS itemName,o.normalized_name AS normalizedName,o.result_text AS resultText,o.numeric_value AS numericValue,
   o.unit,o.reference_low AS referenceLow,o.reference_high AS referenceHigh,o.reference_text AS referenceText,
   o.abnormal_flag AS abnormalFlag,o.method,o.evidence_json AS evidenceJson
   FROM observations o JOIN observation_examinations l ON l.observation_id=o.id
   JOIN report_examinations e ON e.id=l.examination_id
   WHERE e.confirmation_status='pending' AND l.assignment_source='automatic'
   ORDER BY o.report_id,o.id`).all() as Array<{id:string;reportId:string;sectionName:string|null;itemCode:string|null;itemName:string;normalizedName:string|null;resultText:string;numericValue:number|null;unit:string|null;referenceLow:number|null;referenceHigh:number|null;referenceText:string|null;abnormalFlag:AiObservation['abnormalFlag'];method:string|null;evidenceJson:string}>;
 const grouped=new Map<string,typeof rows>();
 for(const row of rows)grouped.set(row.reportId,[...(grouped.get(row.reportId)||[]),row]);
 let assigned=0;
 for(const [reportId,items] of grouped){
  const pages=examinationSourcePages(reportId);
  if(!pages.length)continue;
  const candidates=items.map(row=>{
   let evidence:AiObservation['evidence']=[];
   try{const parsed=JSON.parse(row.evidenceJson);if(Array.isArray(parsed))evidence=parsed.filter(item=>Number.isSafeInteger(item?.pageNumber)&&typeof item?.quote==='string');}catch{/* Keep unverifiable source pending. */}
   return {id:row.id,observation:{sectionName:row.sectionName,itemCode:row.itemCode,itemName:row.itemName,normalizedName:row.normalizedName,
    resultText:row.resultText,numericValue:row.numericValue,unit:row.unit,referenceLow:row.referenceLow,referenceHigh:row.referenceHigh,
    referenceText:row.referenceText,abnormalFlag:row.abnormalFlag,method:row.method,evidence} as AiObservation};
  });
  const before=db.prepare(`SELECT COUNT(*) AS count FROM observation_examinations l JOIN report_examinations e ON e.id=l.examination_id
   JOIN observations o ON o.id=l.observation_id WHERE o.report_id=? AND l.assignment_source='automatic' AND e.confirmation_status='pending'`).get(reportId) as {count:number};
  // publish reads the report's date and applies it only when local evidence is absent.
  publishExaminationAssignments(reportId,candidates,pages,new Set());
  const after=db.prepare(`SELECT COUNT(*) AS count FROM observation_examinations l JOIN report_examinations e ON e.id=l.examination_id
   JOIN observations o ON o.id=l.observation_id WHERE o.report_id=? AND l.assignment_source='automatic' AND e.confirmation_status='pending'`).get(reportId) as {count:number};
  assigned+=before.count-after.count;
 }
 db.prepare('INSERT INTO app_settings(setting_key,value_json,updated_at) VALUES(?,?,CURRENT_TIMESTAMP) ON CONFLICT(setting_key) DO UPDATE SET value_json=excluded.value_json,updated_at=CURRENT_TIMESTAMP').run(marker,JSON.stringify({scanned:rows.length,assigned,completedAt:new Date().toISOString()}));
 return {scanned:rows.length,assigned,alreadyCompleted:false};
}

/** Morphology findings use the same source-row/date inference as indicators. */
export function publishMorphologyExaminationAssignments(reportId:string,findings:Array<{id:string;finding:AiMorphologyFinding}>,pages:ExaminationSourcePage[]) {
 if(!pages.length)return;
 const db=getDatabase();
 for(const {id,finding} of findings){
  const existing=db.prepare(`SELECT l.assignment_source,e.confirmation_status FROM morphology_finding_examinations l
    JOIN report_examinations e ON e.id=l.examination_id WHERE l.finding_id=?`).get(id) as {assignment_source:string;confirmation_status:string}|undefined;
  if(existing && (existing.assignment_source==='manual' || existing.confirmation_status!=='pending'))continue;
  const morphologyEvidence=finding.evidence.map(item=>({pageNumber:item.pageNumber,quote:item.quote,table:item.table}));
  const selectedEvidence=morphologyEvidence.find(item=>Number.isSafeInteger(item.table?.resultColumn?.index));
  const evidencePage=pages.find(page=>page.pageNumber===selectedEvidence?.pageNumber);
  const matchingLines=evidencePage?.lines.filter(line=>compact(line.text)===compact(selectedEvidence?.quote || '')) || [];
  const resultText=matchingLines.length===1 && selectedEvidence?.table?.resultColumn
    ? cells(matchingLines[0].text)[selectedEvidence.table.resultColumn.index] || finding.rawText
    : finding.rawText;
  const observation:AiObservation={sectionName:finding.sectionName,itemCode:null,itemName:finding.findingName,normalizedName:null,resultText,numericValue:null,unit:null,
    referenceLow:null,referenceHigh:null,referenceText:null,abnormalFlag:null,method:null,
    examination:finding.examination,
    evidence:morphologyEvidence};
  const inferred=inferObservationExamination(observation,pages),time=resolveExaminationTime(inferred);
  // Unclear dates keep the established report-level date; never replace it with an unverified pending date.
  if(!inferred.certain)continue;
  if(existing && !inferred.certain)continue;
  if(existing)db.prepare('DELETE FROM morphology_finding_examinations WHERE finding_id=?').run(id);
  const examId=`exam_${digest([reportId,inferred.sourceKey]).slice(0,32)}`;
  db.prepare(`INSERT INTO report_examinations(id,report_id,source_key,examination_type,institution,report_number,specimen,method,sampled_at,examined_at,issued_at,occurred_at,time_kind,time_precision,time_text,evidence_json,confirmation_status)
   VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET occurred_at=excluded.occurred_at,time_kind=excluded.time_kind,time_precision=excluded.time_precision,confirmation_status=excluded.confirmation_status WHERE report_examinations.confirmation_status='pending' AND excluded.confirmation_status='automatic'`).run(examId,reportId,inferred.sourceKey,inferred.examinationType || '',inferred.institution || '',inferred.reportNumber || '',inferred.specimen || '',inferred.method || '',time.sampledAt,time.examinedAt,time.issuedAt,inferred.certain?time.occurredAt:null,inferred.certain?time.timeKind:'unknown',inferred.certain?time.timePrecision:'unknown',inferred.timeText || '',JSON.stringify(inferred.evidence || []),inferred.certain?'automatic':'pending');
  db.prepare("INSERT INTO morphology_finding_examinations(finding_id,examination_id,assignment_source) VALUES(?,?,'automatic')").run(id,examId);
 }
 db.prepare('INSERT OR IGNORE INTO report_examination_state(report_id) VALUES(?)').run(reportId);
}

/** Conservatively backfill historical findings only when their OCR evidence proves one examination date. */
export function backfillMorphologyExaminationAssignments() {
 const db=getDatabase();
 const marker='morphology.examination_backfill_v1';
 if(db.prepare('SELECT 1 FROM app_settings WHERE setting_key=?').get(marker))return {scanned:0,assigned:0,alreadyCompleted:true};
 const rows=db.prepare(`SELECT f.id,f.report_id AS reportId,f.section_name AS sectionName,f.finding_name AS findingName,
   f.raw_text AS rawText,f.evidence_json AS evidenceJson FROM morphology_findings f
   WHERE NOT EXISTS(SELECT 1 FROM morphology_finding_examinations l WHERE l.finding_id=f.id)
   ORDER BY f.report_id,f.id`).all() as Array<{id:string;reportId:string;sectionName:string|null;findingName:string;rawText:string;evidenceJson:string}>;
 let assigned=0;
 const grouped=new Map<string,typeof rows>();
 for(const row of rows)grouped.set(row.reportId,[...(grouped.get(row.reportId)||[]),row]);
 for(const [reportId,findings] of grouped){
  const pages=examinationSourcePages(reportId);if(!pages.length)continue;
  const candidates=findings.flatMap(row=>{
   let evidence:AiMorphologyFinding['evidence']=[];try{const parsed=JSON.parse(row.evidenceJson);if(Array.isArray(parsed))evidence=parsed.filter(item=>Number.isSafeInteger(item?.pageNumber)&&typeof item?.quote==='string');}catch{/* No reliable source evidence. */}
   return [{id:row.id,finding:{sectionName:row.sectionName,organ:null,region:null,laterality:'unspecified',findingType:'',findingName:row.findingName,presence:'uncertain',findingCount:null,size:{length:null,width:null,height:null,unit:null},measurements:[],morphology:null,attributes:{},classification:null,comparisonText:null,rawText:row.rawText,evidence,confidence:null} as AiMorphologyFinding}];
  });
  const before=db.prepare('SELECT COUNT(*) AS count FROM morphology_finding_examinations WHERE finding_id IN (SELECT id FROM morphology_findings WHERE report_id=?)').get(reportId) as {count:number};
  publishMorphologyExaminationAssignments(reportId,candidates,pages);
  const after=db.prepare('SELECT COUNT(*) AS count FROM morphology_finding_examinations WHERE finding_id IN (SELECT id FROM morphology_findings WHERE report_id=?)').get(reportId) as {count:number};
  assigned+=after.count-before.count;
 }
 db.prepare('INSERT INTO app_settings(setting_key,value_json,updated_at) VALUES(?,?,CURRENT_TIMESTAMP) ON CONFLICT(setting_key) DO UPDATE SET value_json=excluded.value_json,updated_at=CURRENT_TIMESTAMP').run(marker,JSON.stringify({scanned:rows.length,assigned,completedAt:new Date().toISOString()}));
 return {scanned:rows.length,assigned,alreadyCompleted:false};
}
