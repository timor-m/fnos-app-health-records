import {captureCombinationSnapshot,saveCombinationRecovery} from './report-combination-recovery.service';
import { createHash } from 'node:crypto';
import { createError } from 'h3';
import { getDatabase, runInTransaction } from '../database/client';
import type { RequestUser } from '../domain/request-user';
import { parseExaminationTime } from '../domain/examination';
import { observationSourceKey, type PersistableObservation } from './observation-field-overrides.service';
import type { ReportCombinationPreview, ReportCombinationResult } from '../../shared/report-combination';
import { reportNoteLimits } from '../../shared/report-notes';
import { createId } from '../utils/identifier';
import { assertMemberManage } from './member.service';
import { assertNoPageAppend } from './page-append-lock.service';
import { isReportJobActive } from './job-runner.service';
import { remapReportEvidencePageNumbers } from './records.service';
import { normalizeReportObservations } from './indicator-normalization.service';
import { discardMemberTrendSnapshots } from './trend-snapshot-runner.service';
// Public content and its saved processing history keep their IDs and ownership together.
const contentTables = ['observations', 'morphology_findings', 'report_diagnoses', 'report_medications',
    'report_procedures', 'vaccination_records', 'billing_items', 'report_structured_sections'] as const;
const transferTables = [...contentTables, 'billing_summaries', 'observation_field_overrides',
    'indicator_unmatched_occurrences', 'report_notes', 'reminders', 'processing_jobs', 'processing_job_events',
    'report_extractions', 'ai_extraction_units', 'ai_extraction_attempts', 'ai_extraction_candidates',
    'ai_audit_events', 'report_page_appends', 'app_notifications', 'upload_receipts'] as const;
const fingerprintTables = [...transferTables, 'report_pages', 'report_field_overrides', 'report_examinations',
    'report_examination_state', 'observation_suppressions'] as const;
type Row = Record<string, string | number | null>;
function fail(code: number, message: string): never { throw createError({ statusCode: code, message }); }
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function id(value: unknown) {
    if (typeof value !== 'string' || !value || value.length > 100)
        fail(400, '请选择有效的报告');
    return value;
}
function pair(user: RequestUser, sourceId: string, targetId: string, allowTrashed = false) {
    id(sourceId);
    id(targetId);
    if (sourceId === targetId)
        fail(400, '请选择另一份报告');
    const db = getDatabase();
    const records = db.prepare('SELECT * FROM reports WHERE id IN (?,?)').all(sourceId, targetId) as Row[];
    const source = records.find(r => r.id === sourceId), target = records.find(r => r.id === targetId);
    if (!source || !target)
        fail(404, '报告不存在或已删除');
    assertMemberManage(user, String(source.member_id));
    assertMemberManage(user, String(target.member_id));
    if (source.member_id !== target.member_id)
        fail(409, '只能合并同一成员的报告');
    if (!allowTrashed && (source.status === 'trashed' || target.status === 'trashed'))
        fail(409, '回收站中的报告不能合并');
    return { source, target };
}
function idle(sourceId: string, targetId: string) {
    const db = getDatabase();
    assertNoPageAppend(sourceId);
    assertNoPageAppend(targetId);
    if (isReportJobActive(sourceId) || isReportJobActive(targetId) || db.prepare("SELECT 1 FROM processing_jobs WHERE report_id IN (?,?) AND status IN ('queued','processing') LIMIT 1").get(sourceId, targetId)
        || db.prepare("SELECT 1 FROM reports WHERE id IN (?,?) AND status IN ('uploading','queued','processing') LIMIT 1").get(sourceId, targetId))
        fail(409, '报告仍有识别或补页任务，请完成或取消后再合并');
}
function checks(sourceId: string, targetId: string) {
    const db = getDatabase();
    idle(sourceId, targetId);
    if (!db.prepare('SELECT 1 FROM report_pages WHERE report_id=?').get(sourceId))
        fail(409, '并入报告没有原件页，暂不能合并');
    if (db.prepare('SELECT 1 FROM billing_summaries WHERE report_id=?').get(sourceId) && db.prepare('SELECT 1 FROM billing_summaries WHERE report_id=?').get(targetId))
        fail(409, '两份报告都有费用汇总，请分别保留，避免混合不同票据的金额');
    if (db.prepare('SELECT 1 FROM observation_field_overrides s JOIN observation_field_overrides t ON s.source_key=t.source_key WHERE s.report_id=? AND t.report_id=? LIMIT 1').get(sourceId, targetId))
        fail(409, '两份报告的人工校对来源存在冲突，暂不能直接合并');
}
function fingerprint(user: RequestUser, source: Row, target: Row) {
    const db = getDatabase();
    const ids = [source.id, target.id];
    const data: unknown[] = [user.id, source, target];
    for (const table of fingerprintTables)
        data.push([table, db.prepare(`SELECT * FROM ${table} WHERE report_id IN (?,?) ORDER BY rowid`).all(...ids)]);
    data.push(db.prepare('SELECT l.* FROM observation_examinations l JOIN observations o ON o.id=l.observation_id WHERE o.report_id IN (?,?) ORDER BY l.observation_id').all(...ids));
    data.push(db.prepare('SELECT l.* FROM morphology_finding_examinations l JOIN morphology_findings f ON f.id=l.finding_id WHERE f.report_id IN (?,?) ORDER BY l.finding_id').all(...ids));
    data.push(db.prepare('SELECT a.* FROM report_note_assets a JOIN report_notes n ON n.id=a.note_id WHERE n.report_id IN (?,?) ORDER BY a.id').all(...ids));
    return hash(data);
}
function counts(reportId: string) {
    const db = getDatabase();
    const count = (table: string) => Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE report_id=?`).get(reportId)!.n);
    return { pages: count('report_pages'), observations: count('observations'), otherRecords: contentTables.filter(t => t !== 'observations').reduce((n, t) => n + count(t), 0) + count('billing_summaries') + count('report_notes') };
}
function summary(row: Row) { return { id: String(row.id), title: String(row.title), reportIssuedAt: row.report_issued_at as string | null, hospitalName: row.hospital_name_raw as string | null }; }
export function previewReportCombination(user: RequestUser, sourceId: string, targetId: string): ReportCombinationPreview {
    const { source, target } = pair(user, sourceId, targetId);
    checks(sourceId, targetId);
    const repeatedPageCount = Number(getDatabase().prepare(`SELECT COUNT(*) AS n FROM report_pages s WHERE s.report_id=? AND EXISTS(SELECT 1 FROM report_pages t WHERE t.report_id=? AND t.sha256=s.sha256 AND t.source_page_number IS s.source_page_number)`).get(sourceId, targetId)!.n);
    return { source: summary(source), target: summary(target), sourceCounts: counts(sourceId), targetCounts: counts(targetId), fingerprint: fingerprint(user, source, target), sameReportDate: Boolean(source.report_issued_at && target.report_issued_at && String(source.report_issued_at).slice(0, 10) === String(target.report_issued_at).slice(0, 10)), repeatedPageCount };
}
// Only page-reference fields change; measurements, raw text and original-file page numbers do not.
function remap(value: unknown, numbers: Map<number, number>): unknown {
    if (Array.isArray(value))
        return value.map(v => remap(v, numbers));
    if (!value || typeof value !== 'object')
        return value;
    return Object.fromEntries(Object.entries(value).map(([key, v]) => [key,
        ['pageNumber', 'page_number'].includes(key) && typeof v === 'number' ? numbers.get(v) ?? v
            : key === 'pageNumbers' && Array.isArray(v) ? v.map(n => typeof n === 'number' ? numbers.get(n) ?? n : n) : remap(v, numbers)]));
}
function jsonPages(value: string, numbers: Map<number, number>) { try {
    return JSON.stringify(remap(JSON.parse(value), numbers));
}
catch {
    return value;
} }
const metadataLabels: Record<string, string> = { title: '原报告标题', report_type: '报告类型', report_subtype: '报告子类型', hospital_name_raw: '医院', hospital_branch: '院区', city: '城市', visit_type: '就诊类型', visit_department: '就诊科室', ordering_department: '开单科室', performing_department: '执行科室', reporting_department: '报告科室', inpatient_ward: '病区', body_parts_json: '检查部位', identifiers_json: '编号信息', report_issued_at: '报告时间', examined_at: '检查时间', ordered_at: '开单时间', sampled_at: '采样时间', received_at: '接收时间', reviewed_at: '审核时间', admitted_at: '入院时间', discharged_at: '出院时间', clinicians_json: '医务人员', clinical_diagnosis: '临床诊断', purpose: '检查目的', chief_complaint: '主诉', findings: '检查所见', impression: '结论', summary: '摘要', recommendation: '建议' };
function readable(value: unknown): string {
    if (Array.isArray(value))
        return value.map(readable).filter(Boolean).join('；');
    if (value && typeof value === 'object')
        return Object.entries(value).map(([key, item]) => { const labels: Record<string, string> = { reportNo: '报告号', outpatientNo: '门诊号', inpatientNo: '住院号', physicalExamNo: '体检号', examNo: '检查号', specimenNo: '标本号', barcodeNo: '条码号', ordering: '开单医生', examining: '检查医生', reporting: '报告医生', reviewing: '审核医生', chief: '主任医生', raw: '原文', name: '名称', parent: '上级部位', laterality: '侧别' }; const text = key==='laterality' ? ({left:'左侧',right:'右侧',bilateral:'双侧',midline:'正中',unspecified:'未注明'} as Record<string,string>)[String(item)]||readable(item) : readable(item); return text ? `${labels[key] || key}：${text}` : ''; }).filter(Boolean).join('；');
    return value === null || value === undefined ? '' : String(value);
}
const reportTypeNames:Record<string,string>={checkup:'体检',laboratory:'检验',imaging:'影像',functional:'功能检查',pathology:'病理',outpatient:'门诊',inpatient:'住院',prescription:'用药单',billing:'费用',vaccination:'接种',other:'其他'};
function sourceNote(source: Row, targetId: string, actorId: string) {
    const lines = ['合并来源报告信息。当前报告基本字段按保留目标展示，以下保留并入报告原有信息：'];
    for (const [key, label] of Object.entries(metadataLabels)) {
        let raw: unknown = key==='report_type' ? reportTypeNames[String(source[key])] || source[key] : source[key];
        if (key.endsWith('_json') && typeof raw === 'string') {
            try {
                raw = JSON.parse(raw);
            }
            catch { /* retain original text */ }
        }
        const value = readable(raw);
        if (value)
            lines.push(`${label}：${value}`);
    }
    const manual = getDatabase().prepare('SELECT field_key FROM report_field_overrides WHERE report_id=? ORDER BY field_key').all(source.id).map(r => String(r.field_key));
    if (manual.length)
        lines.push('原报告的人工校对字段已按保存后的内容保留。');
    const text = lines.join('\n');
    const chunks: string[] = [];
    // Leave room for a visible continuation label and never split a surrogate pair.
    const limit = reportNoteLimits.textLength - 40;
    for (let offset = 0; offset < text.length;) {
        let end = Math.min(offset + limit, text.length);
        if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
        chunks.push(text.slice(offset, end));
        offset = end;
    }
    chunks.forEach((chunk, index) => {
        const prefix = chunks.length > 1 ? `合并来源报告信息（第 ${index + 1}/${chunks.length} 段）\n` : '';
        getDatabase().prepare('INSERT INTO report_notes(id,report_id,content_text,created_by) VALUES(?,?,?,?)')
            .run(createId('note'), targetId, prefix + chunk, actorId);
    });
    return chunks.length;
}
function preserveFallbackTimes(source: Row) {
    const db = getDatabase();
    const observations = db.prepare('SELECT o.id FROM observations o LEFT JOIN observation_examinations e ON e.observation_id=o.id WHERE o.report_id=? AND e.observation_id IS NULL').all(source.id);
    const findings = db.prepare('SELECT f.id FROM morphology_findings f LEFT JOIN morphology_finding_examinations e ON e.finding_id=f.id WHERE f.report_id=? AND e.finding_id IS NULL').all(source.id);
    if (!observations.length && !findings.length)
        return;
    // Preserve the same fallback each view used before the merge. Morphology prefers
    // the examination date, while indicators use the report's display date.
    const displayDate = source.report_issued_at ?? source.reviewed_at ?? source.received_at ?? source.examined_at ?? source.sampled_at ?? source.ordered_at;
    const groups = [
        {kind:'observations',rows:observations,rawDate:displayDate,table:'observation_examinations',key:'observation_id',timeKind:'issued'},
        {kind:'findings',rows:findings,rawDate:source.examined_at ?? displayDate,table:'morphology_finding_examinations',key:'finding_id',timeKind:source.examined_at?'examined':'issued'},
    ];
    for (const group of groups) {
        if (!group.rows.length) continue;
        const text = group.rawDate ? String(group.rawDate) : '';
        const date = parseExaminationTime(text) || (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(text) && Number.isFinite(Date.parse(text)) ? {value:text,precision:'second'} : null);
        const examId = createId('exam');
        db.prepare(`INSERT INTO report_examinations(id,report_id,source_key,institution,issued_at,examined_at,occurred_at,time_kind,time_precision,time_text,confirmation_status) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
            .run(examId,source.id,`combined-fallback:${source.id}:${group.kind}`,source.hospital_name_raw||'',group.timeKind==='issued'?date?.value||null:null,group.timeKind==='examined'?date?.value||null:null,date?.value||null,date?group.timeKind:'unknown',date?.precision||'unknown',text,date?'automatic':'pending');
        for (const row of group.rows) db.prepare(`INSERT INTO ${group.table}(${group.key},examination_id,assignment_source) VALUES(?,?,'automatic')`).run(row.id,examId);
    }
}
function stabilizeObservationKeys(reportId: string) {
    const db = getDatabase(), keys = new Map<string, string>();
    const candidates: PersistableObservation[] = [];
    for (const row of db.prepare('SELECT fields_json FROM report_extractions WHERE report_id=? ORDER BY rowid').all(reportId)) {
        try {
            const values = JSON.parse(String(row.fields_json)).observations;
            if (Array.isArray(values))
                candidates.push(...values);
        }
        catch { /* leave unreadable historic extraction untouched */ }
    }
    for (const row of db.prepare('SELECT section_name AS sectionName,item_code AS itemCode,item_name AS itemName,result_text AS resultText,numeric_value AS numericValue,unit,method,evidence_json FROM observations WHERE report_id=?').all(reportId)) {
        candidates.push({ ...row, evidence: JSON.parse(String(row.evidence_json)) } as PersistableObservation);
    }
    for (const observation of candidates) {
        const canonical = observationSourceKey(observation, reportId);
        for (const key of [observationSourceKey(observation), observationSourceKey(observation, undefined, false), observationSourceKey(observation, reportId, false)])
            keys.set(key, canonical);
    }
    for (const row of db.prepare('SELECT id,source_key FROM observation_field_overrides WHERE report_id=? AND is_manual_created=0').all(reportId)) {
        const key = keys.get(String(row.source_key));
        if (key && key !== row.source_key)
            db.prepare('UPDATE observation_field_overrides SET source_key=? WHERE id=?').run(key, row.id);
    }
    for (const row of db.prepare('SELECT source_key,created_at FROM observation_suppressions WHERE report_id=?').all(reportId)) {
        const key = keys.get(String(row.source_key));
        if (!key || key === row.source_key)
            continue;
        db.prepare('INSERT OR IGNORE INTO observation_suppressions(report_id,source_key,created_at) VALUES(?,?,?)').run(reportId, key, row.created_at);
        db.prepare('DELETE FROM observation_suppressions WHERE report_id=? AND source_key=?').run(reportId, row.source_key);
    }
}
export function combineReports(user: RequestUser, targetId: string, raw: unknown): ReportCombinationResult {
    if (!raw || typeof raw !== 'object')
        fail(400, '合并参数无效');
    const body = raw as {
        sourceReportId?: unknown;
        fingerprint?: unknown;
        requestKey?: unknown;
    };
    const sourceId = id(body.sourceReportId);
    id(targetId);
    if (typeof body.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(body.fingerprint) || typeof body.requestKey !== 'string' || !/^[-\w]{16,100}$/.test(body.requestKey))
        fail(400, '合并预览或请求标识无效，请重新预览');
    const auditId = 'combine_' + hash([user.id, body.requestKey]);
    const db = getDatabase();
    return runInTransaction(db, () => {
        const records = pair(user, sourceId, targetId, true);
        const previous = db.prepare("SELECT target_id,detail_json FROM audit_logs WHERE id=? AND action='report.combine'").get(auditId);
        if (previous) {
            const saved = JSON.parse(String(previous.detail_json));
            if (previous.target_id !== targetId || saved.sourceReportId !== sourceId || saved.fingerprint !== body.fingerprint)
                fail(409, '该请求标识已用于其他合并，请重新预览');
            if(db.prepare('SELECT 1 FROM report_combinations WHERE id=? AND undone_at IS NOT NULL').get(auditId))fail(409,'这次合并已经撤销，请重新预览后再合并');
            return saved.result as ReportCombinationResult;
        }
        if (records.source.status === 'trashed' || records.target.status === 'trashed')
            fail(409, '报告已移入回收站，请刷新后重试');
        checks(sourceId, targetId);
        if (fingerprint(user, records.source, records.target) !== body.fingerprint)
            fail(409, '报告内容已变化，请重新预览后合并');
        const recoveryBefore=captureCombinationSnapshot(sourceId,targetId);
        const sourceCounts = counts(sourceId), targetCounts = counts(targetId);
        const pages = db.prepare('SELECT id,page_number FROM report_pages WHERE report_id=? ORDER BY page_number,id').all(sourceId);
        const max = Number(db.prepare('SELECT COALESCE(MAX(page_number),0) AS n FROM report_pages WHERE report_id=?').get(targetId)!.n);
        const numbers = new Map(pages.map((p, index) => [Number(p.page_number), max + index + 1]));
        preserveFallbackTimes(records.target);
        preserveFallbackTimes(records.source);
        stabilizeObservationKeys(sourceId);
        remapReportEvidencePageNumbers(db, sourceId, numbers);
        for (const row of db.prepare('SELECT id,fields_json FROM observation_field_overrides WHERE report_id=?').all(sourceId))
            db.prepare('UPDATE observation_field_overrides SET fields_json=? WHERE id=?').run(jsonPages(String(row.fields_json), numbers), row.id);
        for (const row of db.prepare('SELECT id,page_numbers_json,page_ranges_json,result_json FROM ai_extraction_units WHERE report_id=?').all(sourceId)) {
            const list = JSON.parse(String(row.page_numbers_json)) as number[];
            db.prepare('UPDATE ai_extraction_units SET page_numbers_json=?,page_ranges_json=?,result_json=? WHERE id=?').run(JSON.stringify(list.map(n => numbers.get(n) ?? n)), jsonPages(String(row.page_ranges_json), numbers), row.result_json === null ? null : jsonPages(String(row.result_json), numbers), row.id);
        }
        for (const [oldNumber, newNumber] of numbers)
            db.prepare('UPDATE ai_extraction_candidates SET page_number=? WHERE report_id=? AND page_number=?').run(-newNumber, sourceId, oldNumber);
        db.prepare('UPDATE ai_extraction_candidates SET page_number=-page_number WHERE report_id=? AND page_number<0').run(sourceId);
        for (const page of pages)
            db.prepare('UPDATE report_pages SET report_id=?,page_number=? WHERE id=?').run(targetId, numbers.get(Number(page.page_number))!, page.id);
        db.prepare("UPDATE report_examinations SET report_id=?,source_key='combined:'||?||':'||source_key WHERE report_id=?").run(targetId, sourceId, sourceId);
        for (const receipt of db.prepare('SELECT user_id,request_key,response_json FROM upload_receipts WHERE report_id=?').all(sourceId)) {
            const response = JSON.parse(String(receipt.response_json));
            response.reportId = targetId;
            if (Array.isArray(response.pages))
                response.pages = response.pages.map((page: Record<string, unknown>) => ({ ...page, pageNumber: typeof page.pageNumber === 'number' ? numbers.get(page.pageNumber) ?? page.pageNumber : page.pageNumber }));
            db.prepare('UPDATE upload_receipts SET response_json=? WHERE user_id=? AND request_key=?').run(JSON.stringify(response), receipt.user_id, receipt.request_key);
        }
        for (const table of transferTables)
            db.prepare(`UPDATE ${table} SET report_id=? WHERE report_id=?`).run(targetId, sourceId);
        db.prepare('INSERT OR IGNORE INTO observation_suppressions(report_id,source_key,created_at) SELECT ?,source_key,created_at FROM observation_suppressions WHERE report_id=?').run(targetId, sourceId);
        db.prepare('DELETE FROM observation_suppressions WHERE report_id=?').run(sourceId);
        db.prepare('UPDATE health_members SET blood_type_source_report_id=? WHERE blood_type_source_report_id=?').run(targetId, sourceId);
        const sourceNoteCount = sourceNote(records.source, targetId, user.id);
        db.prepare("UPDATE reports SET status='trashed',source_version=source_version+1,deleted_at=CURRENT_TIMESTAMP,purge_after=datetime('now','+30 days'),updated_at=CURRENT_TIMESTAMP WHERE id=?").run(sourceId);
        db.prepare("UPDATE reports SET status='needs_review',source_version=source_version+1,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(targetId);
        db.prepare('INSERT INTO report_examination_state(report_id,version) VALUES(?,1) ON CONFLICT(report_id) DO UPDATE SET version=version+1').run(targetId);
        normalizeReportObservations(targetId);
        discardMemberTrendSnapshots([String(records.target.member_id)], db);
        const after = counts(targetId);
        if (after.pages !== sourceCounts.pages + targetCounts.pages || after.observations !== sourceCounts.observations + targetCounts.observations || after.otherRecords !== sourceCounts.otherRecords + targetCounts.otherRecords + sourceNoteCount || db.prepare('PRAGMA foreign_key_check').get())
            fail(409, '合并校验未通过，已回滚');
        saveCombinationRecovery(auditId,user.id,recoveryBefore);
        const result: ReportCombinationResult = { combinationId:auditId, reportId: targetId, sourceReportId: sourceId, status: 'needs_review', movedPages: sourceCounts.pages, movedObservations: sourceCounts.observations, movedOtherRecords: sourceCounts.otherRecords };
        db.prepare("INSERT INTO audit_logs(id,actor_user_id,action,target_type,target_id,detail_json) VALUES(?,?,'report.combine','report',?,?)").run(auditId, user.id, targetId, JSON.stringify({ memberId: records.target.member_id, sourceReportId: sourceId, targetReportId: targetId, fingerprint: body.fingerprint, movedPages: result.movedPages, movedObservations: result.movedObservations, result }));
        return result;
    });
}
