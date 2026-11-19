import type { DatabaseSync } from 'node:sqlite';

/** Development process model: explicit record edges, derived connected components and optional metadata. */
export const healthRecordProcessSchemaSql = `
CREATE TABLE IF NOT EXISTS health_record_processes (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES health_members(id) ON DELETE CASCADE,
  title_override TEXT, summary_override TEXT,
  ai_json TEXT, ai_hash TEXT, attempted_hash TEXT,
  ai_status TEXT NOT NULL DEFAULT 'idle' CHECK(ai_status IN ('idle','pending','ready','failed')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS health_record_process_metadata (
  process_id TEXT PRIMARY KEY REFERENCES health_record_processes(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'unknown' CHECK(status IN ('unknown','active','resolved','chronic')),
  onset_at TEXT, ended_at TEXT, visit_concern TEXT
);
CREATE TABLE IF NOT EXISTS health_record_process_trash (
  process_id TEXT PRIMARY KEY REFERENCES health_record_processes(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES health_members(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  started_at TEXT,
  snapshot_json TEXT,
  deleted_at TEXT,
  purge_after TEXT,
  revision INTEGER NOT NULL DEFAULT 1
);
UPDATE health_record_processes SET ai_status='idle' WHERE ai_status='pending';
CREATE TABLE IF NOT EXISTS health_record_process_nodes (
  member_id TEXT NOT NULL REFERENCES health_members(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('report','medication_document','symptom','medication','intake','vaccination')),
  record_id TEXT NOT NULL,
  process_id TEXT REFERENCES health_record_processes(id) ON DELETE SET NULL,
  stage_override TEXT,
  PRIMARY KEY(member_id,kind,record_id)
);
CREATE INDEX IF NOT EXISTS health_record_process_nodes_process_idx ON health_record_process_nodes(process_id);
CREATE TABLE IF NOT EXISTS health_record_links (
  member_id TEXT NOT NULL REFERENCES health_members(id) ON DELETE CASCADE,
  source_kind TEXT NOT NULL, source_id TEXT NOT NULL,
  target_kind TEXT NOT NULL, target_id TEXT NOT NULL,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(member_id,source_kind,source_id,target_kind,target_id),
  CHECK(source_kind || ':' || source_id < target_kind || ':' || target_id)
);
CREATE INDEX IF NOT EXISTS health_record_links_target_idx ON health_record_links(member_id,target_kind,target_id);
CREATE TABLE IF NOT EXISTS health_record_reminders (
  reminder_id TEXT PRIMARY KEY REFERENCES reminders(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES health_members(id) ON DELETE CASCADE,
  anchor_kind TEXT NOT NULL, anchor_id TEXT NOT NULL,
  completed_kind TEXT, completed_id TEXT
);
${[['reports',"('report','medication_document')"],['health_process_symptoms',"('symptom')"],['medication_courses',"('medication')"],['medication_intakes',"('intake')"],['health_vaccinations',"('vaccination')"]].map(([table,kinds])=>`
DROP TRIGGER IF EXISTS health_record_links_purge_${table};
CREATE TRIGGER IF NOT EXISTS health_record_links_purge_${table} AFTER DELETE ON ${table}
BEGIN
 DELETE FROM health_record_links WHERE (source_kind IN ${kinds} AND source_id=OLD.id) OR (target_kind IN ${kinds} AND target_id=OLD.id);
 DELETE FROM health_record_process_nodes WHERE kind IN ${kinds} AND record_id=OLD.id;
 DELETE FROM health_record_reminders WHERE anchor_kind IN ${kinds} AND anchor_id=OLD.id;
 UPDATE health_record_reminders SET completed_kind=NULL,completed_id=NULL WHERE completed_kind IN ${kinds} AND completed_id=OLD.id;
END;`).join('')}

`;

export function needsHealthRecordProcessDraft(db: DatabaseSync) {
  return ['health_record_processes', 'health_record_process_metadata', 'health_record_process_trash', 'health_record_process_nodes', 'health_record_links', 'health_record_reminders'].some(name =>
    !db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}
