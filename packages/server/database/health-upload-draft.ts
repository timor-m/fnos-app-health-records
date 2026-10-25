import type { DatabaseSync } from 'node:sqlite';

/** Additive upload organization state; original reports remain authoritative. */
export const healthUploadSchemaSql = `
CREATE TABLE IF NOT EXISTS health_upload_items (
  report_id TEXT PRIMARY KEY REFERENCES reports(id) ON DELETE CASCADE,
  context_json TEXT NOT NULL DEFAULT '{}',
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','archived','skipped')),
  event_id TEXT REFERENCES health_events(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_health_upload_items_state ON health_upload_items(state, report_id);
CREATE TABLE IF NOT EXISTS health_upload_archives (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES health_members(id) ON DELETE CASCADE,
  request_key TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(user_id, member_id, request_key)
);
`;

export function needsHealthUploadRepair(db: DatabaseSync) {
  return ['health_upload_items', 'health_upload_archives'].some(name => !db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name))
    || !db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_health_upload_items_state'").get();
}

export function ensureHealthUploadSchema(db: DatabaseSync) { db.exec(healthUploadSchemaSql); }
