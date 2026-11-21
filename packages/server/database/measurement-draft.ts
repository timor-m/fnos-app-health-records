import type { DatabaseSync } from 'node:sqlite';

export const measurementDraftTables = ['measurement_sessions', 'measurement_observations'] as const;

export const measurementDraftSchemaSql = `
CREATE TABLE IF NOT EXISTS measurement_sessions (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES health_members(id) ON DELETE CASCADE,
  recorded_at TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('manual', 'device', 'import')),
  template_id TEXT,
  note TEXT,
  device_vendor TEXT,
  device_model TEXT,
  device_id TEXT,
  device_firmware TEXT,
  external_ref TEXT,
  request_key TEXT,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at TEXT,
  purge_after TEXT,
  trash_state_json TEXT
);
CREATE INDEX IF NOT EXISTS measurement_sessions_member_date_idx
  ON measurement_sessions(member_id, deleted_at, recorded_at DESC, id);
CREATE UNIQUE INDEX IF NOT EXISTS measurement_sessions_request_key_idx
  ON measurement_sessions(member_id, request_key)
  WHERE deleted_at IS NULL AND request_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS measurement_sessions_external_ref_idx
  ON measurement_sessions(member_id, device_id, external_ref)
  WHERE deleted_at IS NULL AND external_ref IS NOT NULL AND device_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS measurement_observations (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES measurement_sessions(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES health_members(id) ON DELETE CASCADE,
  canonical_key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  result_text TEXT NOT NULL,
  numeric_value REAL NOT NULL,
  unit TEXT NOT NULL,
  canonical_value REAL,
  canonical_unit TEXT,
  pair_group TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  origin TEXT NOT NULL DEFAULT 'entered' CHECK (origin IN ('entered', 'derived')),
  quality TEXT NOT NULL DEFAULT 'high' CHECK (quality IN ('high', 'medium', 'low', 'excluded')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS measurement_observations_trend_idx
  ON measurement_observations(member_id, canonical_key, canonical_unit);
CREATE INDEX IF NOT EXISTS measurement_observations_session_idx
  ON measurement_observations(session_id, sort_order, id);
CREATE UNIQUE INDEX IF NOT EXISTS measurement_observations_session_key_idx
  ON measurement_observations(session_id, canonical_key);
`;

const objects = [
  ...measurementDraftTables,
  'measurement_sessions_member_date_idx',
  'measurement_sessions_request_key_idx',
  'measurement_sessions_external_ref_idx',
  'measurement_observations_trend_idx',
  'measurement_observations_session_idx',
  'measurement_observations_session_key_idx',
];

export function measurementDraftNeedsRepair(db: DatabaseSync) {
  return objects.some((name) => !db.prepare('SELECT 1 FROM sqlite_master WHERE name=?').get(name));
}

export function ensureMeasurementDraftSchema(db: DatabaseSync) {
  db.exec('SAVEPOINT measurement_draft');
  try {
    db.exec(measurementDraftSchemaSql);
    db.exec('RELEASE measurement_draft');
  } catch (error) {
    db.exec('ROLLBACK TO measurement_draft');
    db.exec('RELEASE measurement_draft');
    throw error;
  }
}
