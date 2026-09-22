import { getDatabase, rollbackAfterError } from '../database/client';
import { evaluateDuplicatePair, type DuplicateEvaluation, type DuplicateEvidenceSnapshot } from './report-duplicate-evidence';
import { buildDuplicateSnapshot, completeSourceSignature, markDuplicateResultCurrent } from './report-duplicate-snapshot.service';
import { getReportDuplicateDecision } from './report-duplicate-governance.service';
export type LocalDuplicateEvidence = {
    reportId: string;
    confidence: 'high' | 'medium';
    matchedFields: string[];
    reason: string;
    textSimilarity: number | null;
    evaluation: DuplicateEvaluation;
    pauseEligible: boolean;
};
export function compareDuplicateReports(a: DuplicateEvidenceSnapshot, b: DuplicateEvidenceSnapshot): LocalDuplicateEvidence | null {
    if (getReportDuplicateDecision(a.reportId, b.reportId)?.decision === 'distinct')
        return null;
    const evaluation = evaluateDuplicatePair(a, b, a.extractionId && b.extractionId ? 'ai_post' : 'ocr_pre');
    if (['insufficient', 'different'].includes(evaluation.classification))
        return null;
    return { reportId: b.reportId, confidence: ['exact_duplicate', 'strong_duplicate'].includes(evaluation.classification) ? 'high' : 'medium', matchedFields: evaluation.support, reason: evaluation.reason, textSimilarity: null, evaluation, pauseEligible: evaluation.preGateEligible && b.usable };
}
export function findLocalDuplicateEvidence(reportId: string, limit = 80, cache = new Map<string, DuplicateEvidenceSnapshot | null>()) {
    const read = (id: string) => {
        if (!cache.has(id))
            cache.set(id, buildDuplicateSnapshot(id));
        return cache.get(id)!;
    };
    const a = read(reportId);
    if (!a)
        return [];
    const recalled = recallDuplicateCandidates(a, limit);
    return recalled.ids.flatMap(id => { const b = read(id); const match = b ? compareDuplicateReports(a, b) : null; return match ? [match] : []; });
}
export function recallDuplicateCandidates(a: DuplicateEvidenceSnapshot, limit = 80) {
    const reportId = a.reportId;
    const db = getDatabase();
    const ids = new Set((db.prepare("SELECT id FROM reports WHERE member_id=? AND id<>? AND status<>'trashed' ORDER BY updated_at DESC,id LIMIT ?").all(a.memberId, reportId, Math.max(1, Math.min(300, Math.round(limit)))) as {
        id: string;
    }[]).map(x => x.id));
    // Indexed source recall and database text filtering escape the recency window.
    const strong = db.prepare(`SELECT DISTINCT r.id FROM reports r JOIN report_pages p ON p.report_id=r.id WHERE r.member_id=? AND r.id<>? AND r.status<>'trashed' AND p.sha256 IN (SELECT sha256 FROM report_pages WHERE report_id=?) LIMIT 301`).all(a.memberId, reportId, reportId) as {
        id: string;
    }[];
    for (const id of a.identifiers.filter(x => x.type === 'report').slice(0, 8)) {
        strong.push(...db.prepare(`SELECT r.id FROM reports r WHERE r.member_id=? AND r.id<>? AND r.status<>'trashed' AND (instr(lower(r.identifiers_json),?)>0 OR EXISTS(SELECT 1 FROM report_pages p JOIN ocr_results o ON o.page_id=p.id WHERE p.report_id=r.id AND instr(lower(o.lines_json),?)>0)) LIMIT 301`).all(a.memberId, reportId, id.value, id.value) as {
            id: string;
        }[]);
    }
    for (const value of [a.times.sampled, a.times.examined].filter((x): x is string => !!x && x.length >= 16)) {
        const prefix = value.slice(0, 16);
        strong.push(...db.prepare(`SELECT r.id FROM reports r WHERE r.member_id=? AND r.id<>? AND r.status<>'trashed' AND (substr(replace(r.sampled_at,'T',' '),1,16)=? OR substr(replace(r.examined_at,'T',' '),1,16)=? OR EXISTS(SELECT 1 FROM report_pages p JOIN ocr_results o ON o.page_id=p.id WHERE p.report_id=r.id AND instr(o.lines_json,?)>0)) LIMIT 301`).all(a.memberId, reportId, prefix, prefix, prefix) as {
            id: string;
        }[]);
    }
    for (const row of strong)
        ids.add(row.id);
    // A capped strong recall must never claim that the whole history was covered.
    const total = (db.prepare("SELECT COUNT(*) AS n FROM reports WHERE member_id=? AND id<>? AND status<>'trashed'").get(a.memberId, reportId) as {
        n: number;
    }).n;
    return { ids: [...ids].slice(0, 600), truncated: ids.size > 600 || new Set(strong.map(row => row.id)).size > 300, ordinaryWindowLimited: total > limit, ordinaryWindowLimit: limit };
}
export function hasHighConfidenceLocalDuplicate(reportId: string) { return findLocalDuplicateEvidence(reportId).some(x => x.pauseEligible); }
export function getDuplicatePause(reportId: string) {
    const db = getDatabase();
    const row = db.prepare('SELECT pause_json AS pauseJson,continue_signature AS continued FROM report_duplicate_runtime WHERE report_id=?').get(reportId) as {
        pauseJson: string | null;
        continued: string | null;
    } | undefined;
    if (!row?.pauseJson)
        return null;
    try {
        const pause = JSON.parse(row.pauseJson) as {
            targetId: string;
            leftVersion: string;
            rightVersion: string;
            reason: string;
            ruleId: string;
            ruleVersion: string;
            sourceSignature: string;
        };
        const a = buildDuplicateSnapshot(reportId), b = buildDuplicateSnapshot(pause.targetId);
        const valid = !!a && !!b && a.version === pause.leftVersion && b.version === pause.rightVersion && b.usable && row.continued !== a.sourceSignature && getReportDuplicateDecision(reportId, b.reportId)?.decision !== 'distinct';
        return { ...pause, valid, state: valid ? 'paused' : 'expired' };
    }
    catch {
        return null;
    }
}
export function pauseDuplicateIfEligible(reportId: string, explicitContinue = false, batchId?: string) {
    const db = getDatabase();
    buildDuplicateSnapshot(reportId); // Materialize the existing dictionary before acquiring the decision transaction.
    // Synchronous transaction only: target result and source versions cannot race with deletion/publication.
    db.exec('BEGIN IMMEDIATE');
    try {
        const a = buildDuplicateSnapshot(reportId);
        const runtime = db.prepare('SELECT continue_signature AS signature FROM report_duplicate_runtime WHERE report_id=?').get(reportId) as {
            signature: string | null;
        } | undefined;
        if (!a || explicitContinue || runtime?.signature === a.sourceSignature) {
            db.exec('COMMIT');
            return [];
        }
        const candidates = findLocalDuplicateEvidence(reportId).filter(x => x.pauseEligible);
        if (candidates.length) {
            const c = candidates[0];
            const pause = { batchId: batchId || a.version, sourceVersion: a.sourceVersion, reasonCode: c.evaluation.ruleId === 'R0' ? 'duplicate_original' : 'duplicate_evidence', targetId: c.reportId, leftVersion: c.evaluation.leftVersion, rightVersion: c.evaluation.rightVersion, sourceSignature: a.sourceSignature, ruleVersion: c.evaluation.ruleVersion, ruleId: c.evaluation.ruleId, reason: c.evaluation.ruleId === 'R0' ? '与已有报告的完整原件一致，已暂缓 AI 整理。' : '检测到高度重复候选，已暂缓 AI 整理。', support: c.evaluation.support };
            db.prepare(`INSERT INTO report_duplicate_runtime(report_id,source_signature,pause_json) VALUES(?,?,?) ON CONFLICT(report_id) DO UPDATE SET source_signature=excluded.source_signature,pause_json=excluded.pause_json,updated_at=CURRENT_TIMESTAMP`).run(reportId, a.sourceSignature, JSON.stringify(pause));
        }
        else
            db.prepare('UPDATE report_duplicate_runtime SET pause_json=NULL WHERE report_id=?').run(reportId);
        db.exec('COMMIT');
        return candidates;
    }
    catch (error) {
        rollbackAfterError(db);
        throw error;
    }
}
export function recordDuplicateContinue(reportId: string, jobId: string) {
    const signature = completeSourceSignature(reportId);
    getDatabase().prepare(`INSERT INTO report_duplicate_runtime(report_id,continue_signature,continue_job_id) VALUES(?,?,?) ON CONFLICT(report_id) DO UPDATE SET continue_signature=excluded.continue_signature,continue_job_id=excluded.continue_job_id,pause_json=NULL,updated_at=CURRENT_TIMESTAMP`).run(reportId, signature, jobId);
}
export function runDuplicatePostcheck(reportId: string, publishedNow = true) {
    const db = getDatabase();
    try {
        if (publishedNow)
            markDuplicateResultCurrent(reportId);
        const snapshot = buildDuplicateSnapshot(reportId);
        if (!snapshot?.extractionId)
            return;
        const results = findLocalDuplicateEvidence(reportId).map(x => ({ reportId: x.reportId, evaluation: x.evaluation }));
        db.prepare("UPDATE report_duplicate_runtime SET post_status='complete',post_json=?,updated_at=CURRENT_TIMESTAMP WHERE report_id=?").run(JSON.stringify({ version: snapshot.version, results }), reportId);
    }
    catch {
        // Postcheck is optional bookkeeping; never fail or roll back an already published extraction.
        try {
            db.prepare("INSERT INTO report_duplicate_runtime(report_id,post_status) VALUES(?,'failed') ON CONFLICT(report_id) DO UPDATE SET post_status='failed',post_json=NULL").run(reportId);
        }
        catch { /* database outage: the successful extraction remains authoritative */ }
    }
}
export function getDuplicateVerification(reportId: string) {
    const row = getDatabase().prepare('SELECT post_status AS status,post_json AS detail FROM report_duplicate_runtime WHERE report_id=?').get(reportId) as {
        status: string | null;
        detail: string | null;
    } | undefined;
    if (!row?.status)
        return null;
    if (row.status === 'failed')
        return { status: 'failed' };
    try {
        return { status: JSON.parse(row.detail || '{}').version === buildDuplicateSnapshot(reportId)?.version ? 'complete' : 'stale' };
    }
    catch {
        return { status: 'stale' };
    }
}
export function duplicateSearchInfo(reportId: string, matchedCount: number) {
    const snapshot = buildDuplicateSnapshot(reportId);
    if (!snapshot)
        return { status: 'unavailable', candidateCount: 0, ordinaryWindowLimited: false, truncated: false };
    const recalled = recallDuplicateCandidates(snapshot);
    return { status: matchedCount ? 'matched' : recalled.ids.length ? 'insufficient' : 'no_candidates', candidateCount: recalled.ids.length, ordinaryWindowLimited: recalled.ordinaryWindowLimited, truncated: recalled.truncated };
}
