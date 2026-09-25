import { createError } from 'h3';
import { getDatabase, runInTransaction } from '../database/client';
import type { RequestUser } from '../domain/request-user';
import { resolveExaminationTime, type ExaminationInput, type ExaminationRecord, type ExaminationObservation } from '../domain/examination';
import { assertMemberAccess, assertMemberManage } from './member.service';
import { createId } from '../utils/identifier';
import {listExaminationRelationships} from './examination-duplicate.service';
import { examinationSourcePages, inferObservationExamination } from './report-examination-inference.service';
import type { AiObservation } from './ai-extraction.service';
import type { ExaminationPreview, ExaminationProposal } from '../domain/examination';

function reportAccess(user: RequestUser, reportId: string, manage = false) {
  const report = getDatabase().prepare("SELECT id,member_id AS memberId,source_version AS sourceVersion FROM reports WHERE id=? AND status<>'trashed' AND deleted_at IS NULL").get(reportId) as { id: string; memberId: string; sourceVersion: number } | undefined;
  if (!report) throw createError({statusCode:404,statusMessage:'报告不存在或无权访问'});
  if (manage) assertMemberManage(user,report.memberId); else assertMemberAccess(user,report.memberId);
  return report;
}
const examinationSelect = `SELECT id, report_id AS reportId, examination_type AS examinationType,
 institution,report_number AS reportNumber,specimen,method,sampled_at AS sampledAt,examined_at AS examinedAt,
 issued_at AS issuedAt,occurred_at AS occurredAt,time_kind AS timeKind,time_precision AS timePrecision,
 time_text AS timeText,evidence_json AS evidenceJson,confirmation_status AS confirmationStatus FROM report_examinations`;
export function getReportExaminations(user: RequestUser, reportId: string) {
  const report = reportAccess(user,reportId);
  const db = getDatabase();
  const state = db.prepare('SELECT version FROM report_examination_state WHERE report_id=?').get(reportId) as {version:number} | undefined;
  const examinations = (db.prepare(`${examinationSelect} WHERE report_id=? ORDER BY occurred_at,id`).all(reportId) as Array<Omit<ExaminationRecord,"evidence"> & {evidenceJson:string}>).map(row => {
    const {evidenceJson,...rest} = row;
    return {...rest,evidence:JSON.parse(String(evidenceJson))};
  });
  const observations = (db.prepare(`SELECT o.id AS observationId,o.item_name AS itemName,o.result_text AS resultText,o.unit,
    o.evidence_json AS evidenceJson,l.examination_id AS examinationId,l.assignment_source AS assignmentSource
    FROM observations o LEFT JOIN observation_examinations l ON l.observation_id=o.id WHERE o.report_id=? ORDER BY o.id`).all(reportId) as Array<Omit<ExaminationObservation,"evidence"> & {evidenceJson:string}>).map(row => {
    const {evidenceJson,...rest} = row;
    return {...rest,evidence:JSON.parse(String(evidenceJson))};
  });
  return {version:state?.version || 0,reportVersion:report.sourceVersion,examinations,observations,...listExaminationRelationships(user,reportId)};
}
function invalid(message: string): never { throw createError({statusCode:400,statusMessage:message}); }

/** Read-only proposal: existing OCR is reused, and confirmed/manual data is never reassigned here. */
export function previewReportExaminations(user: RequestUser, reportId: string): ExaminationPreview {
  reportAccess(user, reportId, true);
  const state = getReportExaminations(user, reportId);
  const db = getDatabase();
  const pages = examinationSourcePages(reportId);
  const rows = db.prepare(`SELECT o.id, o.section_name AS sectionName, o.item_code AS itemCode,
    o.item_name AS itemName, o.normalized_name AS normalizedName, o.result_text AS resultText,
    o.numeric_value AS numericValue, o.unit, o.reference_low AS referenceLow, o.reference_high AS referenceHigh,
    o.reference_text AS referenceText, o.abnormal_flag AS abnormalFlag, o.method, o.evidence_json AS evidenceJson,
    l.assignment_source AS assignmentSource, e.confirmation_status AS confirmationStatus,
    CASE WHEN e.id IS NULL THEN r.report_issued_at ELSE e.occurred_at END AS previousTime,
    EXISTS(SELECT 1 FROM observation_field_overrides f WHERE f.observation_id=o.id) AS manuallyCorrected
    FROM observations o JOIN reports r ON r.id=o.report_id
    LEFT JOIN observation_examinations l ON l.observation_id=o.id
    LEFT JOIN report_examinations e ON e.id=l.examination_id WHERE o.report_id=? ORDER BY o.id`).all(reportId) as unknown as Array<AiObservation & {
      id:string; evidenceJson:string; assignmentSource:string|null; confirmationStatus:string|null;
      previousTime:string|null; manuallyCorrected:number;
    }>;
  let protectedCount=0;
  const groups=new Map<string,ExaminationProposal>();
  for(const row of rows) {
    if(row.assignmentSource==='manual' || row.confirmationStatus==='confirmed' || row.manuallyCorrected) { protectedCount++; continue; }
    if(!pages.length) continue;
    let evidence:AiObservation['evidence']=[];
    try { const parsed=JSON.parse(row.evidenceJson); if(Array.isArray(parsed)) evidence=parsed.filter(e=>typeof e?.pageNumber==='number' && typeof e?.quote==='string'); } catch { /* Missing evidence stays pending. */ }
    const inferred=inferObservationExamination({...row,evidence},pages);
    const {sourceKey,certain,risks,...input}=inferred;
    const examination=certain?input:{...input,sampledAt:null,examinedAt:null,issuedAt:null};
    const proposal=groups.get(sourceKey) || {key:sourceKey,examination,occurredAt:certain?resolveExaminationTime(input).occurredAt:null,certain,observations:[]};
    proposal.observations.push({observationId:row.id,itemName:row.itemName,resultText:row.resultText,unit:row.unit,previousTime:row.previousTime});
    groups.set(sourceKey,proposal);
  }
  return {version:state.version,reportVersion:state.reportVersion,hasOcr:pages.length>0,protectedCount,proposals:[...groups.values()]};
}
function validateExamination(input: unknown): ExaminationInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('检查信息格式无效');
  const data = input as Record<string,unknown>;
  const result: Record<string,unknown> = {};
  for (const key of ['examinationType','institution','reportNumber','specimen','method','timeText','sampledAt','examinedAt','issuedAt']) {
    if (data[key] !== undefined && data[key] !== null && (typeof data[key] !== 'string' || (data[key] as string).length > 1000)) invalid('检查字段格式无效');
    result[key] = typeof data[key] === 'string' ? data[key].trim() : null;
  }
  if (data.evidence !== undefined) {
    if (!Array.isArray(data.evidence) || data.evidence.length > 100 || data.evidence.some(e => !e || !Number.isSafeInteger(e.pageNumber) || e.pageNumber < 1 || typeof e.quote !== 'string' || e.quote.length > 10000 || (e.pageId !== undefined && typeof e.pageId !== 'string'))) invalid('检查时间证据格式无效');
    result.evidence = data.evidence.map(e => ({pageNumber:e.pageNumber,pageId:e.pageId,quote:e.quote}));
  }
  return result as ExaminationInput;
}
/** One editor submission is atomic, protected by both source and examination revisions. */
export function saveReportExamination(user: RequestUser, reportId: string, body: Record<string,unknown>) {
  reportAccess(user,reportId,true);
  if (!Number.isSafeInteger(body.version) || !Number.isSafeInteger(body.reportVersion)) invalid('缺少检查记录版本，请刷新后重试');
  if (body.id !== undefined && (typeof body.id !== 'string' || !body.id)) invalid('检查记录无效');
  if (typeof body.requestKey !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(body.requestKey)) invalid('请求标识无效');
  if (!Array.isArray(body.observationIds) || body.observationIds.length > 2000 || body.observationIds.some(id=>typeof id !== 'string') || new Set(body.observationIds).size !== body.observationIds.length) invalid('指标范围无效');
  const input = validateExamination(body.examination);
  const time = resolveExaminationTime(input);
  if (time.risks.length) invalid('检查时间格式错误或检查发生时间晚于签发时间，请核对原文');
  const db = getDatabase();
  runInTransaction(db,()=>{
    const report = reportAccess(user,reportId,true);
    db.prepare('INSERT OR IGNORE INTO report_examination_state(report_id) VALUES(?)').run(reportId);
    const state = db.prepare('SELECT version FROM report_examination_state WHERE report_id=?').get(reportId) as {version:number};
    if (state.version !== body.version || report.sourceVersion !== body.reportVersion) throw createError({statusCode:409,statusMessage:'报告或检查归属已修改，请刷新后核对'});
    const old = body.id ? db.prepare('SELECT id FROM report_examinations WHERE id=? AND report_id=?').get(String(body.id),reportId) : null;
    if (body.id && !old) throw createError({statusCode:404,statusMessage:'检查记录不存在'});
    for (const observationId of body.observationIds as string[]) {
      if (!db.prepare('SELECT 1 FROM observations WHERE id=? AND report_id=?').get(observationId,reportId)) invalid('所选指标不属于当前报告');
    }
    for (const evidence of input.evidence || []) {
      const page = db.prepare('SELECT id FROM report_pages WHERE report_id=? AND page_number=?').get(reportId,evidence.pageNumber) as {id:string} | undefined;
      if (!page || (evidence.pageId && evidence.pageId !== page.id)) invalid('时间证据不属于当前报告');
    }
    if (!old && db.prepare('SELECT 1 FROM report_examinations WHERE report_id=? AND source_key=?').get(reportId,`manual:${body.requestKey}`)) throw createError({statusCode:409,statusMessage:'该检查记录已经创建，请刷新后编辑'});
    const id = old ? String(old.id) : createId('exam');
    const values = [input.examinationType || '',input.institution || '',input.reportNumber || '',input.specimen || '',input.method || '',time.sampledAt,time.examinedAt,time.issuedAt,time.occurredAt,time.timeKind,time.timePrecision,input.timeText || '',JSON.stringify(input.evidence || []),time.occurredAt ? 'confirmed' : 'pending'];
    if (old) {
      db.prepare(`UPDATE report_examinations SET examination_type=?,institution=?,report_number=?,specimen=?,method=?,sampled_at=?,examined_at=?,issued_at=?,occurred_at=?,time_kind=?,time_precision=?,time_text=?,evidence_json=?,confirmation_status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(...values,id);
    } else {
      db.prepare(`INSERT INTO report_examinations(id,report_id,source_key,examination_type,institution,report_number,specimen,method,sampled_at,examined_at,issued_at,occurred_at,time_kind,time_precision,time_text,evidence_json,confirmation_status) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,reportId,`manual:${body.requestKey}`,...values);
    }
    for (const observationId of body.observationIds as string[]) {
      db.prepare(`INSERT INTO observation_examinations(observation_id,examination_id,assignment_source) VALUES(?,?,'manual') ON CONFLICT(observation_id) DO UPDATE SET examination_id=excluded.examination_id,assignment_source='manual',updated_at=CURRENT_TIMESTAMP`).run(observationId,id);
    }
    db.prepare('UPDATE report_examination_state SET version=version+1 WHERE report_id=?').run(reportId);
    db.prepare('UPDATE reports SET source_version=source_version+1,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(reportId);
    db.prepare("INSERT INTO audit_logs(id,actor_user_id,action,target_type,target_id,detail_json) VALUES(?,?,'report.examination.confirm','report',?,'{}')").run(createId('audit'),user.id,reportId);
  });
  return getReportExaminations(user,reportId);
}

/** Capture before extraction replaces observation IDs; runs inside the publication transaction. */
export function snapshotExaminationAssignments(reportId: string, includeLegacy = false) {
  const db=getDatabase();
  return (db.prepare(`SELECT o.* FROM observations o ${includeLegacy ? "LEFT JOIN" : "JOIN"} observation_examinations l ON l.observation_id=o.id WHERE o.report_id=?`).all(reportId)).map(observation=>({
    observation,
    link:db.prepare(`SELECT l.examination_id,l.assignment_source,e.confirmation_status,
      e.source_key AS sourceKey,e.occurred_at AS occurredAt,e.time_text AS timeText
      FROM observation_examinations l JOIN report_examinations e ON e.id=l.examination_id
      WHERE l.observation_id=?`).get(String(observation.id))
  }));
}
export function restoreExaminationAssignments(reportId: string, snapshot: ReturnType<typeof snapshotExaminationAssignments>, preserveAutomatic = false) {
  const db=getDatabase();
  const candidates=db.prepare('SELECT * FROM observations WHERE report_id=?').all(reportId);
  const reportDate=(db.prepare('SELECT report_issued_at AS reportDate FROM reports WHERE id=?').get(reportId) as {reportDate:string|null}|undefined)?.reportDate;
  const pages=examinationSourcePages(reportId);
  const used=new Set<string>();
  const legacyIds=new Set<string>();
  const compact=(value:unknown)=>String(value ?? '').normalize('NFKC').replace(/[\s（）()，,。.:：;；、|_\-]+/g,'').toLowerCase();
  const inferredCache=new Map<string,ReturnType<typeof inferObservationExamination>>();
  const inferred=(row:Record<string,unknown>)=>{
    const id=String(row.id);
    let value=inferredCache.get(id);
    if(value)return value;
    let evidence:AiObservation['evidence']=[];
    try { const parsed=JSON.parse(String(row.evidence_json || '[]')); if(Array.isArray(parsed)) evidence=parsed; } catch { /* Keep missing evidence unmatchable by source. */ }
    value=inferObservationExamination({
      sectionName:row.section_name as string|null,itemCode:row.item_code as string|null,
      itemName:String(row.item_name || ''),normalizedName:row.normalized_name as string|null,
      resultText:String(row.result_text || ''),numericValue:typeof row.numeric_value==='number'?row.numeric_value:null,
      unit:row.unit as string|null,referenceLow:row.reference_low as number|null,referenceHigh:row.reference_high as number|null,
      referenceText:row.reference_text as string|null,abnormalFlag:row.abnormal_flag as AiObservation['abnormalFlag'],
      method:row.method as string|null,evidence,
    },pages,reportDate);
    inferredCache.set(id,value);
    return value;
  };
  const sameMeasurement=(left:Record<string,unknown>,right:Record<string,unknown>)=>{
    const leftNames=[left.item_name,left.normalized_name].map(compact).filter(Boolean);
    const rightNames=[right.item_name,right.normalized_name].map(compact).filter(Boolean);
    if(!leftNames.some(name=>rightNames.includes(name)))return false;
    const leftNumeric=typeof left.numeric_value==='number'?left.numeric_value:null;
    const rightNumeric=typeof right.numeric_value==='number'?right.numeric_value:null;
    const sameValue=leftNumeric!==null && rightNumeric!==null
      ? Math.abs(leftNumeric-rightNumeric)<=Math.max(1,Math.abs(leftNumeric),Math.abs(rightNumeric))*1e-10
      : compact(left.result_text)===compact(right.result_text);
    if(!sameValue)return false;
    const leftUnit=compact(left.unit),rightUnit=compact(right.unit);
    if(leftUnit && rightUnit && leftUnit!==rightUnit)return false;
    const leftMethod=compact(left.method),rightMethod=compact(right.method);
    return !leftMethod || !rightMethod || leftMethod===rightMethod;
  };
  const sameExamination=(candidate:Record<string,unknown>,link:unknown,previousRow:Record<string,unknown>)=>{
    const next=inferred(candidate);
    if(link && typeof link==='object'){
      const previous=link as {sourceKey?:string;occurredAt?:string|null;timeText?:string};
      if(previous.sourceKey===next.sourceKey)return true;
      return /^(?:报告日期：|整份报告唯一)/.test(previous.timeText || '') && next.wholeReportDate
        && !!previous.occurredAt && previous.occurredAt===resolveExaminationTime(next).occurredAt;
    }
    const previous=inferred(previousRow);
    if(previous.sourceKey===next.sourceKey)return true;
    return previous.wholeReportDate && next.wholeReportDate
      && resolveExaminationTime(previous).occurredAt===resolveExaminationTime(next).occurredAt;
  };
  const identity=(row: Record<string,unknown>)=>JSON.stringify([
    'item_name','result_text','numeric_value','unit','method','reference_low','reference_high',
    'reference_text','abnormal_flag','item_code','section_name','evidence_json',
  ].map(key=>row[key]));
  for(const {observation,link} of snapshot) {
    const available=candidates.filter(candidate=>!used.has(String(candidate.id)));
    // Re-extraction can rewrite an evidence quote (for example, by including a table
    // header) while preserving the same result. Match exact evidence first, then allow
    // a field-only fallback only when it is unambiguous; otherwise retain the old row.
    const exact=available.find(candidate=>identity(candidate)===identity(observation));
    const equivalent=available.filter(candidate=>sameMeasurement(candidate,observation) && sameExamination(candidate,link,observation));
    const match=exact || (equivalent.length===1 ? equivalent[0] : undefined);
    let id=match ? String(match.id) : null;
    if(!id && (preserveAutomatic || !link || link.assignment_source==='manual' || link.confirmation_status==='confirmed')) {
      // A confirmed source is never silently erased merely because a new extraction omitted it.
      const keys=Object.keys(observation);
      db.prepare(`INSERT INTO observations(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`).run(...keys.map(key=>observation[key]));
      id=String(observation.id);
    }
    if(id) {
      used.add(id);
      if(!link) { legacyIds.add(id); continue; }
      db.prepare('INSERT INTO observation_examinations(observation_id,examination_id,assignment_source) VALUES(?,?,?)').run(id,link.examination_id,link.assignment_source);
    }
  }
  db.prepare('UPDATE report_examination_state SET version=version+1 WHERE report_id=?').run(reportId);
  return legacyIds;
}

/** Pending results remain discoverable even when a member has no dated trend points. */
export function listPendingExaminationReports(user: RequestUser, memberId: string) {
  assertMemberAccess(user, memberId);
  return getDatabase().prepare(`SELECT r.id AS reportId,r.title AS reportTitle,
    COUNT(DISTINCT e.id) AS examinationCount,COUNT(o.id) AS observationCount
    FROM reports r JOIN report_examinations e ON e.report_id=r.id
    JOIN observation_examinations l ON l.examination_id=e.id
    JOIN observations o ON o.id=l.observation_id AND o.report_id=r.id
    WHERE r.member_id=? AND r.status<>'trashed' AND r.deleted_at IS NULL
    AND (e.confirmation_status='pending' OR e.occurred_at IS NULL)
    GROUP BY r.id ORDER BY r.created_at DESC,r.id`).all(memberId) as Array<{
      reportId:string;reportTitle:string;examinationCount:number;observationCount:number;
    }>;
}
