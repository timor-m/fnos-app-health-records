// Unnumbered v17 development draft. No historical AI is queued during upgrade.
export const reportDuplicateDraftSql = `
CREATE TABLE IF NOT EXISTS report_duplicate_runtime (
 report_id TEXT PRIMARY KEY REFERENCES reports(id) ON DELETE CASCADE,
 source_signature TEXT, result_signature TEXT, extraction_id TEXT,
 pause_json TEXT, continue_signature TEXT, continue_job_id TEXT, post_status TEXT, post_json TEXT,
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS duplicate_page_hash_idx ON report_pages(sha256,report_id);
`;
import type { DatabaseSync } from 'node:sqlite';
export function ensureReportDuplicateDraft(db: DatabaseSync) {
    const columns = db.prepare('PRAGMA table_info(report_duplicate_runtime)').all() as {
        name: string;
    }[];
    if (!columns.some(c => c.name === 'continue_job_id'))
        db.exec('ALTER TABLE report_duplicate_runtime ADD COLUMN continue_job_id TEXT');
}
