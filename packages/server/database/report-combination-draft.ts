import type { DatabaseSync } from 'node:sqlite';
// Additive undo journal; older applications keep reading the original report tables.
// Startup backs up an existing database before completing this structure.
export const reportCombinationSchemaSql = `
CREATE TABLE IF NOT EXISTS report_combinations (
 id TEXT PRIMARY KEY,
 target_report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
 source_report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
 created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
 snapshot_version INTEGER NOT NULL DEFAULT 1,
 before_json TEXT NOT NULL CHECK(json_valid(before_json)),
 after_fingerprint TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 undone_at TEXT,
 undone_by TEXT REFERENCES users(id) ON DELETE SET NULL,
 CHECK(target_report_id <> source_report_id)
);
CREATE INDEX IF NOT EXISTS report_combinations_target_idx
 ON report_combinations(target_report_id,undone_at);
`;
const required = ['id', 'target_report_id', 'source_report_id', 'created_by', 'snapshot_version', 'before_json', 'after_fingerprint', 'created_at', 'undone_at', 'undone_by'];
export function needsReportCombinationDraft(db: DatabaseSync) {
    const columns = new Set(db.prepare('PRAGMA table_info(report_combinations)').all().map(c => String(c.name)));
    return required.some(c => !columns.has(c)) || !db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='report_combinations_target_idx'").get();
}
export function ensureReportCombinationDraft(db: DatabaseSync) {
    db.exec(reportCombinationSchemaSql);
    if (needsReportCombinationDraft(db))
        throw new Error('Report combination recovery journal structure is incomplete');
}
