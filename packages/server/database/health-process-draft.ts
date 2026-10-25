import type { DatabaseSync } from 'node:sqlite';

/** Current symptom records and immutable correction history; unnumbered additive structure. */
export const healthProcessSchemaSql = `
CREATE TABLE IF NOT EXISTS health_process_symptoms (
  id TEXT PRIMARY KEY,
  episode_id TEXT NOT NULL REFERENCES health_episodes(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  started_at TEXT,
  body_area TEXT, severity INTEGER CHECK (severity IS NULL OR severity BETWEEN 0 AND 10),
  frequency TEXT, description TEXT, trigger_text TEXT, relieving_text TEXT, associated_symptoms_text TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at TEXT, purge_after TEXT
);
CREATE INDEX IF NOT EXISTS health_process_symptoms_episode_idx ON health_process_symptoms(episode_id, deleted_at, started_at);
CREATE TABLE IF NOT EXISTS health_process_symptom_updates (
  id TEXT PRIMARY KEY,
  symptom_id TEXT NOT NULL REFERENCES health_process_symptoms(id) ON DELETE CASCADE,
  recorded_at TEXT NOT NULL,
  change TEXT CHECK (change IS NULL OR change IN ('worsened','unchanged','improved','resolved')),
  severity INTEGER CHECK (severity IS NULL OR severity BETWEEN 0 AND 10),
  measurement_value TEXT, measurement_unit TEXT, temperature_value TEXT, description TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS health_process_updates_symptom_idx ON health_process_symptom_updates(symptom_id, recorded_at, created_at);
CREATE TABLE IF NOT EXISTS health_process_symptom_revisions (
  id TEXT PRIMARY KEY,
  episode_id TEXT NOT NULL REFERENCES health_episodes(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK (target_type IN ('symptom','update')),
  target_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('correct','retract')),
  snapshot_json TEXT NOT NULL,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS health_process_symptom_revisions_target_idx ON health_process_symptom_revisions(target_type, target_id);
`;

export const healthProcessTables = ['health_process_symptoms', 'health_process_symptom_updates', 'health_process_symptom_revisions'] as const;
function tableExists(db: DatabaseSync, name: string) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}
export function needsHealthProcessRepair(db: DatabaseSync) {
  if (healthProcessTables.some(table => !tableExists(db, table))) return true;
  if (!db.prepare('PRAGMA table_info(health_process_symptoms)').all().some(column=>column.name==='purge_after')) return true;
  if (!db.prepare('PRAGMA table_info(health_process_symptom_updates)').all().some(column=>column.name==='temperature_value')) return true;
  return false;
}

export function ensureHealthProcessDraft(db: DatabaseSync) {
  db.exec('SAVEPOINT health_process_draft');
  try {
    db.exec(healthProcessSchemaSql);
    if (!db.prepare('PRAGMA table_info(health_process_symptoms)').all().some(column=>column.name==='purge_after')) db.exec('ALTER TABLE health_process_symptoms ADD COLUMN purge_after TEXT');
    if (!db.prepare('PRAGMA table_info(health_process_symptom_updates)').all().some(column=>column.name==='temperature_value')) db.exec('ALTER TABLE health_process_symptom_updates ADD COLUMN temperature_value TEXT');
    db.exec('RELEASE health_process_draft');
  } catch (error) {
    db.exec('ROLLBACK TO health_process_draft; RELEASE health_process_draft');
    throw error;
  }
}
