// Unnumbered draft: included in fresh databases and existing v17 development databases.
export const pageAppendSchemaSql = `
CREATE TABLE IF NOT EXISTS report_page_appends (
 id TEXT PRIMARY KEY, report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
 actor_id TEXT NOT NULL REFERENCES users(id), provider TEXT NOT NULL,
 request_key TEXT NOT NULL, manifest_hash TEXT NOT NULL, selection_hash TEXT, confirmation_hash TEXT,
 state TEXT NOT NULL DEFAULT 'uploading', phase TEXT NOT NULL DEFAULT 'prepare',
 base_version INTEGER NOT NULL, published INTEGER NOT NULL DEFAULT 0,
 result_version INTEGER, input_hash TEXT, job_id TEXT, error_message TEXT,
 conflicts_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(actor_id, request_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS report_page_appends_active ON report_page_appends(report_id)
 WHERE state NOT IN ('complete','ocr_only','noop','cancelled');
CREATE TABLE IF NOT EXISTS report_page_append_files (
 id TEXT PRIMARY KEY, batch_id TEXT NOT NULL REFERENCES report_page_appends(id) ON DELETE CASCADE,
 position INTEGER NOT NULL, original_name TEXT NOT NULL, file_size INTEGER NOT NULL,
 storage_path TEXT NOT NULL, sha256 TEXT, mime_type TEXT, page_count INTEGER, error_message TEXT,
 UNIQUE(batch_id,position)
);
CREATE TABLE IF NOT EXISTS report_page_append_pages (
 id TEXT PRIMARY KEY, file_id TEXT NOT NULL REFERENCES report_page_append_files(id) ON DELETE CASCADE,
 source_page_number INTEGER NOT NULL, rotation INTEGER NOT NULL DEFAULT 0,
 position INTEGER, duplicate INTEGER NOT NULL DEFAULT 0, thumbnail_path TEXT, ocr_json TEXT,
 UNIQUE(file_id,source_page_number)
);
CREATE TABLE IF NOT EXISTS observation_suppressions (
 report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
 source_key TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(report_id,source_key)
);
CREATE TRIGGER IF NOT EXISTS page_append_job_lock BEFORE INSERT ON processing_jobs
WHEN NEW.pipeline_version <> 'page-append-v1' AND EXISTS(SELECT 1 FROM report_page_appends WHERE report_id=NEW.report_id AND state NOT IN ('complete','ocr_only','noop','cancelled'))
BEGIN SELECT RAISE(ABORT,'PAGE_APPEND_BUSY'); END;
CREATE TRIGGER IF NOT EXISTS page_append_page_update_lock BEFORE UPDATE OF page_number,rotation,report_id,storage_path ON report_pages
WHEN EXISTS(SELECT 1 FROM report_page_appends WHERE report_id=OLD.report_id AND state NOT IN ('complete','ocr_only','noop','cancelled'))
BEGIN SELECT RAISE(ABORT,'PAGE_APPEND_BUSY'); END;
CREATE TRIGGER IF NOT EXISTS page_append_page_delete_lock BEFORE DELETE ON report_pages
WHEN EXISTS(SELECT 1 FROM report_page_appends WHERE report_id=OLD.report_id AND state NOT IN ('complete','ocr_only','noop','cancelled'))
BEGIN SELECT RAISE(ABORT,'PAGE_APPEND_BUSY'); END;
CREATE TRIGGER IF NOT EXISTS page_append_report_lock BEFORE UPDATE OF status,member_id ON reports
WHEN (NEW.status<>OLD.status OR NEW.member_id<>OLD.member_id) AND EXISTS(SELECT 1 FROM report_page_appends WHERE report_id=OLD.id AND state NOT IN ('complete','ocr_only','noop','cancelled'))
BEGIN SELECT RAISE(ABORT,'PAGE_APPEND_BUSY'); END;
`;

import type { DatabaseSync } from "node:sqlite";
export function ensurePageAppendDraft(db: DatabaseSync) {
  const columns = (table: string) =>
    new Set(
      (
        db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
      ).map((row) => row.name),
    );
  if (!columns("report_page_appends").has("confirmation_hash"))
    db.exec(
      "ALTER TABLE report_page_appends ADD COLUMN confirmation_hash TEXT",
    );
  if (!columns("report_page_appends").has("input_hash"))
    db.exec("ALTER TABLE report_page_appends ADD COLUMN input_hash TEXT");
  if (!columns("report_page_append_files").has("error_message"))
    db.exec(
      "ALTER TABLE report_page_append_files ADD COLUMN error_message TEXT",
    );
}
