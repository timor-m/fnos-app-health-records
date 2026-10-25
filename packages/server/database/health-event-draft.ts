/** Internal document groups and symptom containers for the current unreleased record model. */
export const healthEventDraftSql = `
CREATE TABLE IF NOT EXISTS health_events (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES health_members(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'physical_exam', 'outpatient', 'emergency', 'inpatient', 'screening',
    'diagnostic_exam', 'laboratory_exam', 'procedure', 'vaccination',
    'follow_up', 'rehabilitation_assessment', 'other'
  )),
  title TEXT,
  started_at TEXT,
  ended_at TEXT,
  organization_name TEXT,
  organization_id TEXT REFERENCES medical_organizations(id) ON DELETE SET NULL,
  department TEXT,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  source TEXT NOT NULL DEFAULT 'manual',
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS health_events_member_date_idx
  ON health_events(member_id, deleted_at, started_at DESC, created_at DESC);

CREATE TABLE IF NOT EXISTS health_event_resources (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES health_events(id) ON DELETE CASCADE,
  resource_type TEXT NOT NULL CHECK (resource_type IN (
    'report', 'imaging_study', 'symptom_episode', 'self_monitoring_session',
    'follow_up_record', 'external_resource'
  )),
  resource_id TEXT NOT NULL,
  relation_type TEXT NOT NULL DEFAULT 'related' CHECK (relation_type IN ('primary', 'related', 'reference')),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(event_id, resource_type, resource_id)
);

CREATE INDEX IF NOT EXISTS health_event_resources_resource_idx
  ON health_event_resources(resource_type, resource_id, event_id);

CREATE TABLE IF NOT EXISTS health_episodes (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES health_members(id) ON DELETE CASCADE,
  episode_type TEXT NOT NULL CHECK (episode_type IN ('symptom', 'rehabilitation', 'monitoring', 'other')),
  title TEXT NOT NULL,
  started_at TEXT,
  ended_at TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended', 'unknown')),
  outcome TEXT CHECK (outcome IS NULL OR outcome IN ('improved', 'resolved', 'unchanged', 'worsened', 'unknown')),
  description TEXT,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS health_episodes_member_date_idx
  ON health_episodes(member_id, deleted_at, started_at DESC, created_at DESC);

CREATE TRIGGER IF NOT EXISTS health_event_report_deleted
AFTER DELETE ON reports BEGIN
  DELETE FROM health_event_resources WHERE resource_type = 'report' AND resource_id = OLD.id;
END;

CREATE TRIGGER IF NOT EXISTS health_event_report_member_change
BEFORE UPDATE OF member_id ON reports
WHEN EXISTS (
  SELECT 1 FROM health_event_resources er JOIN health_events e ON e.id=er.event_id
  WHERE er.resource_type='report' AND er.resource_id=OLD.id AND e.member_id<>NEW.member_id
)
BEGIN
  SELECT RAISE(ABORT, 'detach report from events before changing member');
END;

CREATE TRIGGER IF NOT EXISTS health_event_report_attach_guard
BEFORE INSERT ON health_event_resources
WHEN NEW.resource_type='report' AND NOT EXISTS (
  SELECT 1 FROM reports r JOIN health_events e ON e.id=NEW.event_id
  WHERE r.id=NEW.resource_id AND r.member_id=e.member_id
)
BEGIN
  SELECT RAISE(ABORT, 'report and event member mismatch');
END;

`;
