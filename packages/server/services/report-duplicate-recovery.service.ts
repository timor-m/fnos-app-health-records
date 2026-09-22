import { completeSourceSignature, buildDuplicateSnapshot } from "./report-duplicate-snapshot.service";
import { createError } from 'h3';
import { getDatabase, rollbackAfterError } from '../database/client';
import type { RequestUser } from '../domain/request-user';
import { assertMemberAccess, assertMemberManage } from './member.service';
import { queueManualAiExtraction } from './job-runner.service';
import { pauseDuplicateIfEligible, runDuplicatePostcheck, getDuplicateVerification } from './report-duplicate-precheck.service';
import { setReportDuplicateDecision, getReportDuplicateDecision } from './report-duplicate-governance.service';
export function listDuplicateRecovery(user: RequestUser, memberId: string) {
    assertMemberAccess(user, memberId);
    const reports = getDatabase().prepare(`SELECT r.id FROM reports r WHERE r.member_id=? AND r.status='needs_review'
 AND NOT EXISTS(SELECT 1 FROM report_extractions e JOIN processing_jobs j ON j.id=e.job_id WHERE e.report_id=r.id AND j.status='completed' AND (EXISTS(SELECT 1 FROM observations o WHERE o.report_id=r.id) OR length(coalesce(r.findings,''))+length(coalesce(r.impression,''))>0))
 AND NOT EXISTS(SELECT 1 FROM processing_jobs j WHERE j.report_id=r.id AND (j.status IN ('queued','processing') OR (j.job_type<>'ai_extract' AND j.status='failed' AND NOT EXISTS(SELECT 1 FROM processing_jobs newer WHERE newer.report_id=j.report_id AND newer.job_type=j.job_type AND newer.page_id IS j.page_id AND newer.status='completed' AND newer.rowid>j.rowid))))
 AND EXISTS(SELECT 1 FROM processing_job_events e WHERE e.report_id=r.id AND json_valid(e.detail_json) AND json_extract(e.detail_json,'$.stage')='duplicate_precheck' AND coalesce(json_extract(e.detail_json,'$.ruleVersion'),'family-v1')<>'family-v2')
 AND NOT EXISTS(SELECT 1 FROM report_duplicate_runtime d WHERE d.report_id=r.id AND json_valid(d.pause_json) AND json_extract(d.pause_json,'$.ruleVersion')='family-v2')
 ORDER BY r.id`).all(memberId) as {
        id: string;
    }[];
    return { count: reports.length, reportIds: reports.slice(0, 100).map(r => r.id), hasMore: reports.length > 100 };
}
export function recoverDuplicateReports(user: RequestUser, memberId: string, reportIds: string[]) {
    assertMemberManage(user, memberId);
    if (!Array.isArray(reportIds) || reportIds.length > 100)
        throw createError({ statusCode: 400, statusMessage: '单次最多恢复 100 份报告' });
    const eligible = new Set(listDuplicateRecovery(user, memberId).reportIds);
    return [...new Set(reportIds)].map(reportId => {
        if (!eligible.has(reportId))
            return { reportId, status: 'skipped' };
        try {
            const candidates = pauseDuplicateIfEligible(reportId);
            if (candidates.length)
                return { reportId, status: 'paused', reason: candidates[0].reason };
            return { reportId, status: 'queued', jobId: continueDuplicateReport(user, reportId).id };
        }
        catch {
            return { reportId, status: 'unavailable', reason: '请检查 AI 配置和本地处理状态后重试' };
        }
    });
}
export function continueDuplicateReport(user: RequestUser, reportId: string, distinctTarget?: string) {
    const db = getDatabase();
    const a = db.prepare("SELECT member_id AS memberId FROM reports WHERE id=? AND status<>'trashed'").get(reportId) as {
        memberId: string;
    } | undefined;
    if (!a)
        throw createError({ statusCode: 404, statusMessage: '报告不存在' });
    assertMemberManage(user, a.memberId);
    if (distinctTarget) {
        const b = db.prepare("SELECT member_id AS memberId FROM reports WHERE id=? AND status<>'trashed'").get(distinctTarget) as {
            memberId: string;
        } | undefined;
        if (!b || a.memberId !== b.memberId || reportId === distinctTarget)
            throw createError({ statusCode: 409, statusMessage: '只能处理当前成员的另一份报告' });
    }
    const snapshot = buildDuplicateSnapshot(reportId);
    if (!snapshot?.sourceComplete || snapshot.risks.includes('ocr_page_missing'))
        throw createError({ statusCode: 409, statusMessage: '原件或 OCR 页面尚不完整，请先完成本地处理' });
    db.exec('BEGIN IMMEDIATE');
    try {
        const current = buildDuplicateSnapshot(reportId);
        if (!current?.sourceComplete || current.risks.includes('ocr_page_missing'))
            throw createError({ statusCode: 409, statusMessage: '当前原件已变化，请刷新后重试' });
        assertMemberManage(user, current.memberId);
        const active = db.prepare("SELECT id,status FROM processing_jobs WHERE report_id=? AND job_type='ai_extract' AND status IN ('queued','processing') ORDER BY created_at DESC LIMIT 1").get(reportId) as {
            id: string;
            status: string;
        } | undefined;
        const previous = db.prepare("SELECT j.id,j.status FROM report_duplicate_runtime d JOIN processing_jobs j ON j.id=d.continue_job_id WHERE d.report_id=? AND d.continue_signature=? AND j.status IN ('queued','processing','completed')").get(reportId, completeSourceSignature(reportId)) as {
            id: string;
            status: string;
        } | undefined;
        const result = active || previous || queueManualAiExtraction(user, reportId);
        if (distinctTarget && getReportDuplicateDecision(reportId, distinctTarget)?.decision !== "distinct")
            setReportDuplicateDecision(user, { reportId, candidateReportId: distinctTarget, decision: 'distinct' });
        db.exec("COMMIT");
        return result;
    }
    catch (error) {
        rollbackAfterError(db);
        throw error;
    }
}
export function retryDuplicatePostcheck(user: RequestUser, reportId: string) {
    const r = getDatabase().prepare("SELECT member_id AS memberId FROM reports WHERE id=? AND status<>'trashed'").get(reportId) as {
        memberId: string;
    } | undefined;
    if (!r)
        throw createError({ statusCode: 404, statusMessage: '报告不存在' });
    assertMemberManage(user, r.memberId);
    // Only already stamped results may be retried; no retroactive validity inference.
    if (!getDatabase().prepare('SELECT 1 FROM report_duplicate_runtime WHERE report_id=? AND extraction_id IS NOT NULL').get(reportId))
        throw createError({ statusCode: 409, statusMessage: '尚未完成当前版本的 AI 整理' });
    runDuplicatePostcheck(reportId, false);
    return { checked: getDuplicateVerification(reportId)?.status === "complete" };
}
