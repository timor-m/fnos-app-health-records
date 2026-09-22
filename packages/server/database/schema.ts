import { pageAppendSchemaSql } from "./page-append-draft";
import { memberSharingSchemaSql } from "./member-sharing-draft";
import { fileGcMembersSchemaSql } from "./file-gc-members-draft";
import {
  uploadReceiptSchemaSql,
  institutionTrendRuleSchemaSql,
  institutionTrendSchemaSql,
  aiExtractionCandidateSchemaSql,
  aiExtractionUnitSchemaSql,
  clinicalFactSchemaSql,
  indicatorDictionarySchemaSql,
  indicatorGovernanceHistorySchemaSql,
  latestSchemaVersion,
  reportDuplicateGovernanceSchemaSql,
  morphologyFindingSchemaSql,
  reportStructuredSectionSchemaSql
} from "./migrations";

import { reportNotesSchemaSql } from "./report-notes-draft";
import { trendGroupsSchemaSql } from "./trend-groups-draft";
export const schemaVersion = latestSchemaVersion;

export const schemaSql = `
${memberSharingSchemaSql}
${reportNotesSchemaSql}
${trendGroupsSchemaSql}
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  checksum TEXT NOT NULL DEFAULT '',
  elapsed_ms INTEGER NOT NULL DEFAULT 0,
  applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  is_gateway_admin INTEGER NOT NULL DEFAULT 0 CHECK (is_gateway_admin IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS user_identities (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('fnos_gateway', 'local', 'development')),
  subject TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(provider, subject)
);

CREATE TABLE IF NOT EXISTS health_members (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  relationship TEXT NOT NULL DEFAULT 'self',
  birth_date TEXT,
  sex TEXT CHECK (sex IS NULL OR sex IN ('male', 'female', 'unknown')),
  blood_type_abo TEXT CHECK (blood_type_abo IS NULL OR blood_type_abo IN ('A', 'B', 'AB', 'O')),
  blood_type_rh TEXT CHECK (blood_type_rh IS NULL OR blood_type_rh IN ('positive', 'negative')),
  blood_type_source_report_id TEXT REFERENCES reports(id),
  avatar_path TEXT,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS member_permissions (
  member_id TEXT NOT NULL REFERENCES health_members(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission TEXT NOT NULL CHECK (permission IN ('viewer', 'manager')),
  can_manage_sharing INTEGER NOT NULL DEFAULT 0 CHECK(can_manage_sharing IN (0,1) AND (can_manage_sharing = 0 OR permission = 'manager')),
  granted_by TEXT NOT NULL REFERENCES users(id),
  granted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(member_id, user_id)
);

CREATE TABLE IF NOT EXISTS medical_organizations (
  id TEXT PRIMARY KEY,
  canonical_name TEXT NOT NULL,
  branch_name TEXT,
  city TEXT,
  aliases_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES health_members(id),
  created_by TEXT NOT NULL REFERENCES users(id),
  report_type TEXT NOT NULL,
  report_subtype TEXT,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'uploading' CHECK (
    status IN ('uploading', 'queued', 'processing', 'needs_review', 'ready', 'failed', 'trashed')
  ),
  hospital_name_raw TEXT,
  organization_id TEXT REFERENCES medical_organizations(id),
  hospital_branch TEXT,
  city TEXT,
  visit_type TEXT,
  visit_department TEXT,
  ordering_department TEXT,
  performing_department TEXT,
  reporting_department TEXT,
  inpatient_ward TEXT,
  body_parts_json TEXT NOT NULL DEFAULT '[]',
  identifiers_json TEXT NOT NULL DEFAULT '{}',
  report_issued_at TEXT,
  examined_at TEXT,
  ordered_at TEXT,
  sampled_at TEXT,
  received_at TEXT,
  reviewed_at TEXT,
  admitted_at TEXT,
  discharged_at TEXT,
  clinicians_json TEXT NOT NULL DEFAULT '{}',
  clinical_diagnosis TEXT,
  purpose TEXT,
  chief_complaint TEXT,
  findings TEXT,
  impression TEXT,
  summary TEXT,
  recommendation TEXT,
  source_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at TEXT,
  purge_after TEXT
);

CREATE INDEX IF NOT EXISTS reports_timeline_idx
  ON reports(member_id, report_issued_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS reports_status_idx ON reports(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS reports_organization_idx
  ON reports(organization_id, report_issued_at DESC);

CREATE TABLE IF NOT EXISTS report_field_overrides (
  id TEXT PRIMARY KEY,
  report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  field_key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(report_id, field_key)
);

CREATE INDEX IF NOT EXISTS report_field_overrides_report_idx
  ON report_field_overrides(report_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS report_pages (
  id TEXT PRIMARY KEY,
  report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  page_number INTEGER NOT NULL,
  original_name TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  thumbnail_path TEXT,
  mime_type TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  width INTEGER,
  height INTEGER,
  rotation INTEGER NOT NULL DEFAULT 0,
  source_page_number INTEGER,
  source_page_count INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(report_id, page_number)
);

CREATE TABLE IF NOT EXISTS observations (
  id TEXT PRIMARY KEY,
  report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  section_name TEXT,
  item_code TEXT,
  item_name TEXT NOT NULL,
  normalized_name TEXT,
  result_text TEXT NOT NULL,
  numeric_value REAL,
  unit TEXT,
  reference_low REAL,
  reference_high REAL,
  reference_text TEXT,
  abnormal_flag TEXT CHECK (
    abnormal_flag IS NULL OR abnormal_flag IN ('high', 'low', 'abnormal', 'normal')
  ),
  display_abnormal_flag TEXT CHECK (
    display_abnormal_flag IS NULL OR display_abnormal_flag IN ('high', 'low', 'abnormal', 'normal')
  ),
  abnormal_conflict INTEGER NOT NULL DEFAULT 0,
  method TEXT,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS observations_trend_idx
  ON observations(normalized_name, unit, report_id);

CREATE TABLE IF NOT EXISTS observation_field_overrides (
  id TEXT PRIMARY KEY,
  report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  source_key TEXT NOT NULL,
  observation_id TEXT,
  fields_json TEXT NOT NULL,
  canonical_key TEXT,
  is_manual_created INTEGER NOT NULL DEFAULT 0 CHECK (is_manual_created IN (0, 1)),
  updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(report_id, source_key)
);

CREATE INDEX IF NOT EXISTS observation_field_overrides_observation_idx
  ON observation_field_overrides(observation_id);
CREATE INDEX IF NOT EXISTS observation_field_overrides_report_idx
  ON observation_field_overrides(report_id, updated_at DESC);

${morphologyFindingSchemaSql}
${clinicalFactSchemaSql}
${reportStructuredSectionSchemaSql}

CREATE TABLE IF NOT EXISTS indicator_catalog (
  id TEXT PRIMARY KEY,
  canonical_key TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  category TEXT NOT NULL,
  specimen TEXT,
  default_unit TEXT,
  value_type TEXT NOT NULL DEFAULT 'numeric' CHECK (value_type IN ('numeric', 'text', 'positive_negative')),
  trend_enabled INTEGER NOT NULL DEFAULT 1 CHECK (trend_enabled IN (0, 1)),
  explanation TEXT,
  source TEXT NOT NULL DEFAULT 'builtin' CHECK (source IN ('builtin', 'user')),
  ai_managed INTEGER NOT NULL DEFAULT 0 CHECK (ai_managed IN (0, 1)),
  builtin_version TEXT,
  category_key TEXT,
  item_order INTEGER,
  observation_kind TEXT,
  unit_dimension TEXT,
  allowed_units_json TEXT NOT NULL DEFAULT '[]',
  section_hints_json TEXT NOT NULL DEFAULT '[]',
  trend_source_preference_json TEXT NOT NULL DEFAULT '{}',
  reference_range_json TEXT NOT NULL DEFAULT '{}',
  dictionary_layer TEXT,
  dictionary_revision INTEGER,
  dictionary_snapshot_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS indicator_aliases (
  id TEXT PRIMARY KEY,
  indicator_id TEXT NOT NULL REFERENCES indicator_catalog(id) ON DELETE CASCADE,
  alias_name TEXT NOT NULL,
  normalized_alias TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'global' CHECK (scope IN ('global', 'hospital', 'department', 'report_type')),
  hospital_name TEXT,
  department_name TEXT,
  report_type TEXT,
  source TEXT NOT NULL DEFAULT 'builtin' CHECK (source IN ('builtin', 'user', 'ai_suggestion')),
  confidence REAL NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  dictionary_layer TEXT,
  dictionary_revision INTEGER,
  dictionary_snapshot_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS indicator_aliases_lookup_idx
  ON indicator_aliases(normalized_alias, enabled, scope);

CREATE TABLE IF NOT EXISTS observation_normalizations (
  observation_id TEXT PRIMARY KEY REFERENCES observations(id) ON DELETE CASCADE,
  indicator_id TEXT REFERENCES indicator_catalog(id) ON DELETE SET NULL,
  canonical_key TEXT,
  canonical_name TEXT,
  canonical_value REAL,
  canonical_unit TEXT,
  canonical_category TEXT,
  canonical_explanation TEXT,
  confidence REAL NOT NULL DEFAULT 0,
  quality TEXT NOT NULL CHECK (quality IN ('high', 'medium', 'low', 'excluded')),
  matched_by TEXT NOT NULL,
  match_reason TEXT NOT NULL,
  excluded_reason TEXT,
  source_origin TEXT NOT NULL DEFAULT 'none' CHECK (
    source_origin IN ('item_name', 'item_code', 'combined', 'ai_normalized_name', 'none', 'manual_confirmation', 'manual_exclusion', 'legacy')
  ),
  source_name TEXT,
  alias_source TEXT CHECK (alias_source IS NULL OR alias_source IN ('builtin', 'user', 'ai_suggestion')),
  review_status TEXT NOT NULL DEFAULT 'unreviewed' CHECK (review_status IN ('unreviewed', 'confirmed', 'excluded')),
  reviewed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TEXT,
  version TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS observation_normalizations_trend_idx
  ON observation_normalizations(canonical_key, canonical_unit, quality);

CREATE TABLE IF NOT EXISTS indicator_governance_decisions (
  fingerprint TEXT PRIMARY KEY REFERENCES indicator_unmatched_names(fingerprint) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('confirm', 'exclude')),
  indicator_id TEXT REFERENCES indicator_catalog(id) ON DELETE SET NULL,
  canonical_key TEXT,
  save_alias INTEGER NOT NULL DEFAULT 0 CHECK (save_alias IN (0, 1)),
  alias_scope TEXT CHECK (alias_scope IS NULL OR alias_scope IN ('global', 'report_type')),
  alias_id TEXT REFERENCES indicator_aliases(id) ON DELETE SET NULL,
  reason TEXT,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS indicator_governance_decisions_key_idx
  ON indicator_governance_decisions(canonical_key, action);

${indicatorGovernanceHistorySchemaSql}

CREATE TABLE IF NOT EXISTS processing_jobs (
  id TEXT PRIMARY KEY,
  report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  page_id TEXT REFERENCES report_pages(id) ON DELETE CASCADE,
  job_type TEXT NOT NULL CHECK (job_type IN ('pdf_extract', 'thumbnail', 'ocr', 'ai_extract')),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (
    status IN ('queued', 'processing', 'completed', 'failed', 'cancelled')
  ),
  attempts INTEGER NOT NULL DEFAULT 0,
  pipeline_version TEXT NOT NULL,
  deduplication_key TEXT NOT NULL UNIQUE,
  locked_at TEXT,
  lease_expires_at TEXT,
  next_retry_at TEXT,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  started_at TEXT,
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS processing_job_events (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES processing_jobs(id) ON DELETE CASCADE,
  report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (
    event_type IN ('queued', 'started', 'completed', 'retry_scheduled', 'failed', 'manual_retry', 'cancelled')
  ),
  status TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 0,
  message TEXT,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS processing_job_events_job_idx
  ON processing_job_events(job_id, created_at, id);
CREATE INDEX IF NOT EXISTS processing_job_events_report_idx
  ON processing_job_events(report_id, created_at DESC);

CREATE TABLE IF NOT EXISTS ocr_results (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL UNIQUE REFERENCES processing_jobs(id) ON DELETE CASCADE,
  page_id TEXT NOT NULL REFERENCES report_pages(id) ON DELETE CASCADE,
  engine TEXT NOT NULL,
  model_version TEXT NOT NULL,
  lines_json TEXT NOT NULL,
  quality_score INTEGER,
  quality_level TEXT CHECK (quality_level IS NULL OR quality_level IN ('good', 'weak', 'poor')),
  quality_reason TEXT,
  text_length INTEGER,
  elapsed_ms INTEGER,
  coord_width REAL,
  coord_height REAL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS report_extractions (
  id TEXT PRIMARY KEY,
  report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL UNIQUE REFERENCES processing_jobs(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  fields_json TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  confidence_json TEXT NOT NULL DEFAULT '{}',
  raw_response_json TEXT NOT NULL,
  input_characters INTEGER NOT NULL DEFAULT 0,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  elapsed_ms INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS report_extractions_report_idx
  ON report_extractions(report_id, created_at DESC);

${aiExtractionUnitSchemaSql}
${aiExtractionCandidateSchemaSql}

CREATE TABLE IF NOT EXISTS ai_audit_events (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL CHECK (source IN ('indicator_normalization')),
  actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  report_id TEXT REFERENCES reports(id) ON DELETE SET NULL,
  target_title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('completed', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 1,
  provider TEXT,
  model TEXT,
  prompt_version TEXT NOT NULL,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  elapsed_ms INTEGER,
  input_characters INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  error_message TEXT,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS ai_audit_events_created_idx
  ON ai_audit_events(created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS ai_audit_events_report_idx
  ON ai_audit_events(report_id, created_at DESC);

CREATE TABLE IF NOT EXISTS reminders (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES health_members(id) ON DELETE CASCADE,
  report_id TEXT REFERENCES reports(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  due_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'dismissed')),
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'report_suggestion')),
  confirmed_at TEXT,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS app_notifications (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES health_members(id) ON DELETE CASCADE,
  report_id TEXT REFERENCES reports(id) ON DELETE SET NULL,
  type TEXT NOT NULL CHECK (type IN ('report_processed', 'report_failed')),
  title TEXT NOT NULL,
  message TEXT,
  severity TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('info', 'success', 'warning', 'error')),
  status TEXT NOT NULL DEFAULT 'unread' CHECK (status IN ('unread', 'read', 'archived')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  read_at TEXT
);

CREATE INDEX IF NOT EXISTS app_notifications_member_idx
  ON app_notifications(member_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS app_notifications_report_idx
  ON app_notifications(report_id, created_at DESC);

CREATE TABLE IF NOT EXISTS app_upgrade_history (
  id TEXT PRIMARY KEY,
  from_app_version TEXT,
  to_app_version TEXT NOT NULL,
  from_schema_version INTEGER NOT NULL,
  to_schema_version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('started', 'completed', 'failed')),
  message TEXT,
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at TEXT
);

CREATE INDEX IF NOT EXISTS app_upgrade_history_started_idx
  ON app_upgrade_history(started_at DESC);

CREATE TABLE IF NOT EXISTS app_settings (
  setting_key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS maintenance_tasks (
  id TEXT PRIMARY KEY,
  task_type TEXT NOT NULL CHECK (task_type IN ('indicator_normalization')),
  mode TEXT NOT NULL CHECK (mode IN ('incremental', 'full')),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (
    status IN ('queued', 'running', 'completed', 'failed')
  ),
  requested_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  total_units INTEGER NOT NULL DEFAULT 0,
  completed_units INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  result_json TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  started_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at TEXT
);

CREATE INDEX IF NOT EXISTS maintenance_tasks_recent_idx
  ON maintenance_tasks(task_type, created_at DESC, id DESC);
CREATE UNIQUE INDEX IF NOT EXISTS maintenance_tasks_active_idx
  ON maintenance_tasks(task_type)
  WHERE status IN ('queued', 'running');

CREATE TABLE IF NOT EXISTS user_trend_pins (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES health_members(id) ON DELETE CASCADE,
  indicator_key TEXT NOT NULL,
  unit_key TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(user_id, member_id, indicator_key, unit_key)
);

CREATE INDEX IF NOT EXISTS user_trend_pins_member_idx
  ON user_trend_pins(user_id, member_id, created_at DESC);

CREATE TABLE IF NOT EXISTS local_accounts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  must_change_password INTEGER NOT NULL DEFAULT 0 CHECK (must_change_password IN (0, 1)),
  disabled_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS auth_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS login_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  ip_address TEXT NOT NULL,
  succeeded INTEGER NOT NULL DEFAULT 0 CHECK (succeeded IN (0, 1)),
  attempted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS login_attempts_limit_idx
  ON login_attempts(username, ip_address, attempted_at DESC);

CREATE TABLE IF NOT EXISTS file_gc_queue (
  id TEXT PRIMARY KEY,
  storage_path TEXT NOT NULL UNIQUE,
  file_kind TEXT NOT NULL CHECK (file_kind IN ('original', 'thumbnail', 'other')),
  reason TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  not_before TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT
);

${fileGcMembersSchemaSql}

CREATE INDEX IF NOT EXISTS file_gc_queue_pending_idx
  ON file_gc_queue(completed_at, not_before, created_at);

${indicatorDictionarySchemaSql}

${institutionTrendSchemaSql}
${institutionTrendRuleSchemaSql}

${reportDuplicateGovernanceSchemaSql}

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  ip_address TEXT,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
${uploadReceiptSchemaSql}
${pageAppendSchemaSql}
`;
