import type { DatabaseSync } from 'node:sqlite';

/** Stable write receipts for current record operations; reminder anchors live with record associations. */
export const healthWorkflowDraftSql = `
CREATE TABLE IF NOT EXISTS health_workflow_requests (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES health_members(id) ON DELETE CASCADE,
  scope TEXT NOT NULL,
  request_key TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  response_json TEXT NOT NULL CHECK(json_valid(response_json)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(user_id,member_id,scope,request_key)
);
`;

export function needsHealthWorkflowDraft(db: DatabaseSync) {
  return ['health_workflow_requests']
    .some(name => !db.prepare('SELECT 1 FROM sqlite_master WHERE name=?').get(name));
}

export function ensureHealthWorkflowDraft(db: DatabaseSync) {
  db.exec(healthWorkflowDraftSql);
}
