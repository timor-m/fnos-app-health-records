import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { SQLInputValue } from 'node:sqlite';
import { createError } from 'h3';
import { getDatabase, runInTransaction } from '../database/client';
import type { RequestUser } from '../domain/request-user';
import { assertMemberManage } from './member.service';
import { assertNoPageAppend } from './page-append-lock.service';
import { isReportJobActive } from './job-runner.service';
import { normalizeReportObservations } from './indicator-normalization.service';
import { discardMemberTrendSnapshots } from './trend-snapshot-runner.service';
import { getAppConfig } from '../utils/runtime-config';
import { createId } from '../utils/identifier';
import type { ReportCombinationUndoPreview, ReportCombinationUndoResult } from '../../shared/report-combination';
type Row = Record<string, string | number | null>;
const ownedTables = ['reports', 'report_pages', 'report_examinations', 'observations', 'morphology_findings', 'report_diagnoses', 'report_medications', 'report_procedures', 'vaccination_records', 'billing_summaries', 'billing_items', 'report_structured_sections', 'observation_field_overrides', 'report_field_overrides', 'observation_suppressions', 'report_notes', 'reminders', 'processing_jobs', 'processing_job_events', 'report_extractions', 'ai_extraction_units', 'ai_extraction_attempts', 'ai_extraction_candidates', 'ai_audit_events', 'report_page_appends', 'upload_receipts', 'app_notifications'] as const;
const linkedTables = ['observation_examinations', 'morphology_finding_examinations', 'report_note_assets'] as const;
type Table = typeof ownedTables[number] | typeof linkedTables[number];
export type CombinationSnapshot = {
    version: 1;
    sourceId: string;
    targetId: string;
    tables: Record<Table, Row[]>;
    bloodTypeSource: string | null;
    manualNormalizations: Row[];
    examinationDecisions: Row[];
};
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function reject(statusCode: number, message: string): never { throw createError({ statusCode, message }); }
export function captureCombinationSnapshot(sourceId: string, targetId: string): CombinationSnapshot {
    const db = getDatabase(), ids = [sourceId, targetId];
    const tables = {} as Record<Table, Row[]>;
    for (const table of ownedTables)
        tables[table] = db.prepare(`SELECT * FROM ${table} WHERE ${table === 'reports' ? 'id' : 'report_id'} IN (?,?) ORDER BY rowid`).all(...ids) as Row[];
    tables.observation_examinations = db.prepare('SELECT l.* FROM observation_examinations l JOIN observations o ON o.id=l.observation_id WHERE o.report_id IN (?,?) ORDER BY l.observation_id').all(...ids) as Row[];
    tables.morphology_finding_examinations = db.prepare('SELECT l.* FROM morphology_finding_examinations l JOIN morphology_findings f ON f.id=l.finding_id WHERE f.report_id IN (?,?) ORDER BY l.finding_id').all(...ids) as Row[];
    tables.report_note_assets = db.prepare('SELECT a.* FROM report_note_assets a JOIN report_notes n ON n.id=a.note_id WHERE n.report_id IN (?,?) ORDER BY a.id').all(...ids) as Row[];
    const memberId = tables.reports[0]?.member_id;
    const member = db.prepare('SELECT blood_type_source_report_id FROM health_members WHERE id=?').get(memberId as string);
    const manualNormalizations = db.prepare("SELECT n.* FROM observation_normalizations n JOIN observations o ON o.id=n.observation_id WHERE o.report_id IN (?,?) AND n.matched_by LIKE 'manual%' ORDER BY n.observation_id").all(...ids) as Row[];
    const examinationDecisions = db.prepare('SELECT d.* FROM examination_duplicate_decisions d JOIN report_examinations l ON l.id=d.left_id JOIN report_examinations r ON r.id=d.right_id WHERE l.report_id IN (?,?) OR r.report_id IN (?,?) ORDER BY d.left_id,d.right_id').all(...ids, ...ids) as Row[];
    return { version: 1, sourceId, targetId, tables, examinationDecisions, bloodTypeSource: member?.blood_type_source_report_id as string | null, manualNormalizations };
}
function contentState(snapshot: CombinationSnapshot, trackBloodTypeSource: boolean) {
    const tables = Object.fromEntries(Object.entries(snapshot.tables).filter(([table]) => !['app_notifications', 'reminders'].includes(table)).map(([table, rows]) => [table, rows.map(row => Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'updated_at' && (table !== 'reports' || !['source_version', 'status', 'deleted_at', 'purge_after'].includes(key))))).sort((a, b) => { const x = JSON.stringify(a), y = JSON.stringify(b); return x < y ? -1 : x > y ? 1 : 0; })]));
    return { tables, examinationDecisions: snapshot.examinationDecisions, bloodTypeSource: trackBloodTypeSource ? snapshot.bloodTypeSource : null };
}
export function combinationContentFingerprint(snapshot: CombinationSnapshot, trackBloodTypeSource = true) {
    // Reading notifications, archive confirmation and reminder actions are not report content edits.
    return digest({ ...contentState(snapshot, trackBloodTypeSource), manualNormalizations: snapshot.manualNormalizations.map(({ updated_at, ...row }) => row) });
}
export function saveCombinationRecovery(id: string, actorId: string, before: CombinationSnapshot) {
    getDatabase().prepare('INSERT INTO report_combinations(id,target_report_id,source_report_id,created_by,before_json,after_fingerprint) VALUES(?,?,?,?,?,?)')
        .run(id, before.targetId, before.sourceId, actorId, JSON.stringify({ checksum: digest(before), snapshot: before }), combinationContentFingerprint(captureCombinationSnapshot(before.sourceId, before.targetId), before.bloodTypeSource === before.sourceId));
}
type Journal = {
    id: string;
    target_report_id: string;
    source_report_id: string;
    before_json: string;
    after_fingerprint: string;
    snapshot_version: number;
    undone_at: string | null;
    sequence: number;
};
function access(user: RequestUser, targetId: string, combinationId: string) {
    const db = getDatabase();
    const entry = db.prepare('SELECT *,rowid AS sequence FROM report_combinations WHERE id=? AND target_report_id=?').get(combinationId, targetId) as Journal | undefined;
    if (!entry)
        reject(404, '未找到可撤销的合并记录，旧测试包的合并可能没有保存恢复信息');
    const reports = db.prepare('SELECT id,member_id,status,source_version FROM reports WHERE id IN (?,?)').all(entry.source_report_id, targetId) as Row[];
    if (reports.length !== 2)
        reject(409, '原报告已永久删除，无法自动撤销合并');
    for (const report of reports)
        assertMemberManage(user, String(report.member_id));
    if (reports[0].member_id !== reports[1].member_id)
        reject(409, '报告所属成员已变化，暂不能撤销合并');
    return { entry, reports };
}
function snapshotFor(entry: Journal): CombinationSnapshot {
    try {
        const stored = JSON.parse(entry.before_json) as {
            checksum: string;
            snapshot: CombinationSnapshot;
        };
        const snapshot = stored.snapshot;
        if (!snapshot || stored.checksum !== digest(snapshot))
            throw new Error();
        if (entry.snapshot_version !== 1 || snapshot.version !== 1 || snapshot.sourceId !== entry.source_report_id || snapshot.targetId !== entry.target_report_id)
            throw new Error();
        for (const table of [...ownedTables, ...linkedTables])
            if (!Array.isArray(snapshot.tables[table]))
                throw new Error();
        const ids = new Set([entry.source_report_id, entry.target_report_id]);
        if (snapshot.tables.reports.length !== 2 || !snapshot.tables.reports.some(r => r.id === entry.source_report_id) || !snapshot.tables.reports.some(r => r.id === entry.target_report_id))
            throw new Error();
        for (const table of ownedTables)
            if (snapshot.tables[table].some(r => !ids.has(String(table === 'reports' ? r.id : r.report_id))))
                throw new Error();
        return snapshot;
    }
    catch {
        reject(409, '合并恢复信息不可用，未修改当前报告');
    }
}
function idle(ids: string[]) {
    const db = getDatabase();
    if (db.prepare("SELECT 1 FROM reports WHERE id IN (?,?) AND status IN ('uploading','queued','processing') LIMIT 1").get(...ids))
        reject(409, '报告仍在处理中，请结束后再撤销');
    for (const reportId of ids) {
        assertNoPageAppend(reportId);
        if (isReportJobActive(reportId))
            reject(409, '报告仍在处理中，请结束后再撤销');
    }
    if (db.prepare("SELECT 1 FROM processing_jobs WHERE report_id IN (?,?) AND status IN ('queued','processing') LIMIT 1").get(...ids))
        reject(409, '报告仍有识别任务，请完成或取消后再撤销');
}
function ensureRecoverable(entry: Journal, before: CombinationSnapshot) {
    const db = getDatabase(), ids = [entry.source_report_id, entry.target_report_id];
    idle(ids);
    if (db.prepare('SELECT 1 FROM report_combinations WHERE undone_at IS NULL AND rowid>? AND (target_report_id IN (?,?) OR source_report_id IN (?,?)) LIMIT 1').get(entry.sequence, ...ids, ...ids))
        reject(409, '请先撤销后续的合并，再撤销这一次');
    const current = captureCombinationSnapshot(...ids as [
        string,
        string
    ]);
    if (combinationContentFingerprint(current, before.bloodTypeSource === before.sourceId) !== entry.after_fingerprint)
        reject(409, '合并后内容已有校对、补页或重新识别等修改，暂不能直接撤销，以免覆盖后续修改');
    for (const table of [...ownedTables, ...linkedTables]) {
        if (['observation_suppressions', 'app_notifications', 'reminders'].includes(table))
            continue;
        const pk = keys(table), present = new Set(current.tables[table].map(row => rowKey(row, pk)));
        if (before.tables[table].some(row => !present.has(rowKey(row, pk))))
            reject(409, '恢复信息与现有来源不一致，未修改当前报告');
    }
    for (const row of [...before.tables.report_pages, ...before.tables.report_note_assets])
        if (typeof row.storage_path === 'string' && !existsSync(join(getAppConfig().storageDir, row.storage_path)))
            reject(409, '部分原件暂时不可访问，请检查档案存储后再撤销');
}
export function previewCombinationUndo(user: RequestUser, targetId: string, combinationId: string): ReportCombinationUndoPreview {
    const { entry } = access(user, targetId, combinationId);
    if (entry.undone_at)
        reject(409, '这次合并已经撤销，请刷新报告');
    const before = snapshotFor(entry);
    ensureRecoverable(entry, before);
    const summary = (reportId: string) => { const report = before.tables.reports.find(r => r.id === reportId)!; return { id: reportId, title: String(report.title), pages: before.tables.report_pages.filter(r => r.report_id === reportId).length, observations: before.tables.observations.filter(r => r.report_id === reportId).length }; };
    return { combinationId, source: summary(entry.source_report_id), target: summary(targetId), fingerprint: entry.after_fingerprint };
}
function keys(table: Table) { return (getDatabase().prepare(`PRAGMA table_info(${table})`).all() as {
    name: string;
    pk: number;
}[]).filter(c => c.pk).sort((a, b) => a.pk - b.pk).map(c => c.name); }
function rowKey(row: Row, columns: string[]) { return JSON.stringify(columns.map(c => row[c])); }
function restoreRow(table: Table, row: Row, pk: string[], onlyOwnership = false) {
    const allowed = new Set(getDatabase().prepare(`PRAGMA table_info(${table})`).all().map(c => String(c.name)));
    const columns = Object.keys(row).filter(c => allowed.has(c) && !pk.includes(c) && (!onlyOwnership || c === 'report_id'));
    if (!columns.length)
        return;
    getDatabase().prepare(`UPDATE ${table} SET ${columns.map(c => `"${c}"=?`).join(',')} WHERE ${pk.map(c => `"${c}" IS ?`).join(' AND ')}`).run(...columns.map(c => row[c]) as SQLInputValue[], ...pk.map(c => row[c]) as SQLInputValue[]);
}
export function undoReportCombination(user: RequestUser, targetId: string, raw: unknown): ReportCombinationUndoResult {
    if (!raw || typeof raw !== 'object')
        reject(400, '撤销参数无效');
    const body = raw as {
        combinationId?: unknown;
        fingerprint?: unknown;
    };
    if (typeof body.combinationId !== 'string' || body.combinationId.length > 100 || typeof body.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(body.fingerprint))
        reject(400, '请重新预览撤销内容');
    const db = getDatabase();
    return runInTransaction(db, () => {
        const { entry, reports } = access(user, targetId, body.combinationId as string);
        const result = { reportId: targetId, restoredReportId: entry.source_report_id, undone: true as const };
        if (entry.undone_at)
            return result;
        if (body.fingerprint !== entry.after_fingerprint)
            reject(409, '撤销预览已变化，请重新预览');
        const before = snapshotFor(entry);
        ensureRecoverable(entry, before);
        const after = captureCombinationSnapshot(entry.source_report_id, targetId);
        // Parent IDs stay stable. Update their ownership before restoring cross-report links.
        for (const table of ownedTables) {
            if (['reports', 'observation_suppressions', 'app_notifications', 'reminders'].includes(table))
                continue;
            const pk = keys(table);
            for (const row of before.tables[table])
                restoreRow(table, row, pk);
        }
        for (const table of linkedTables) {
            const pk = keys(table), original = new Set(before.tables[table].map(row => rowKey(row, pk)));
            for (const row of after.tables[table])
                if (!original.has(rowKey(row, pk)))
                    db.prepare(`DELETE FROM ${table} WHERE ${pk.map(c => `"${c}" IS ?`).join(' AND ')}`).run(...pk.map(c => row[c]));
            for (const row of before.tables[table])
                restoreRow(table, row, pk);
        }
        // Remove only merge-created records, never delete/recreate original parents and their files.
        for (const table of [...ownedTables].reverse()) {
            if (['reports', 'observation_suppressions', 'app_notifications', 'reminders'].includes(table))
                continue;
            const pk = keys(table), original = new Set(before.tables[table].map(row => rowKey(row, pk)));
            for (const row of after.tables[table])
                if (!original.has(rowKey(row, pk)))
                    db.prepare(`DELETE FROM ${table} WHERE ${pk.map(c => `"${c}" IS ?`).join(' AND ')}`).run(...pk.map(c => row[c]));
        }
        db.prepare('DELETE FROM observation_suppressions WHERE report_id IN (?,?)').run(entry.source_report_id, targetId);
        for (const row of before.tables.observation_suppressions)
            db.prepare('INSERT INTO observation_suppressions(report_id,source_key,created_at) VALUES(?,?,?)').run(row.report_id, row.source_key, row.created_at);
        for (const row of before.tables.app_notifications)
            if (after.tables.app_notifications.some(r => r.id === row.id))
                restoreRow('app_notifications', row, ['id'], true);
        for (const row of before.tables.reminders)
            if (after.tables.reminders.some(r => r.id === row.id))
                restoreRow('reminders', row, ['id'], true);
        for (const row of before.tables.reports) {
            const current = reports.find(r => r.id === row.id)!;
            restoreRow('reports', { ...row, source_version: Number(current.source_version) + 1, updated_at: new Date().toISOString() }, ['id']);
            db.prepare('INSERT INTO report_examination_state(report_id,version) VALUES(?,1) ON CONFLICT(report_id) DO UPDATE SET version=version+1').run(row.id);
        }
        if (before.bloodTypeSource === before.sourceId)
            db.prepare('UPDATE health_members SET blood_type_source_report_id=? WHERE id=?').run(before.bloodTypeSource, reports[0].member_id);
        const restored = captureCombinationSnapshot(entry.source_report_id, targetId);
        if (digest(contentState(restored, before.bloodTypeSource === before.sourceId)) !== digest(contentState(before, before.bloodTypeSource === before.sourceId)))
            reject(409, '恢复校验未通过，已保留合并后的内容');
        for (const report of reports)
            normalizeReportObservations(String(report.id));
        discardMemberTrendSnapshots([String(reports[0].member_id)], db);
        if (db.prepare('PRAGMA foreign_key_check').get() || db.prepare('SELECT 1 FROM observation_examinations l JOIN observations o ON o.id=l.observation_id JOIN report_examinations e ON e.id=l.examination_id WHERE o.report_id<>e.report_id LIMIT 1').get() || db.prepare('SELECT 1 FROM morphology_finding_examinations l JOIN morphology_findings f ON f.id=l.finding_id JOIN report_examinations e ON e.id=l.examination_id WHERE f.report_id<>e.report_id LIMIT 1').get())
            reject(409, '恢复校验未通过，已保留合并后的内容');
        db.prepare("UPDATE report_combinations SET before_json='{}',undone_at=CURRENT_TIMESTAMP,undone_by=? WHERE id=?").run(user.id, entry.id);
        db.prepare("INSERT INTO audit_logs(id,actor_user_id,action,target_type,target_id,detail_json) VALUES(?,?,'report.combine_undo','report',?,?)").run(createId('audit'), user.id, targetId, JSON.stringify({ combinationId: entry.id, memberId: reports[0].member_id, sourceReportId: entry.source_report_id, targetReportId: targetId }));
        return result;
    });
}
