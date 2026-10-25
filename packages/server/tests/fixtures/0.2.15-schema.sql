-- Schema-only fixture generated from 0.2.15 commit f17f54d. No user or health records.
PRAGMA foreign_keys=OFF;
CREATE TABLE member_merges (
 id TEXT PRIMARY KEY,
 actor_id TEXT NOT NULL REFERENCES users(id),
 source_id TEXT NOT NULL UNIQUE REFERENCES health_members(id),
 target_id TEXT NOT NULL REFERENCES health_members(id),
 backup_id TEXT NOT NULL,
 report_count INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK(source_id <> target_id)
);
CREATE TABLE account_preferences (
 user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 self_member_id TEXT REFERENCES health_members(id) ON DELETE SET NULL,
 self_profile_choice TEXT NOT NULL DEFAULT 'undecided' CHECK(self_profile_choice IN ('undecided','created','skipped','pending')),
 default_member_id TEXT REFERENCES health_members(id) ON DELETE SET NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE member_user_preferences (
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 member_id TEXT NOT NULL REFERENCES health_members(id) ON DELETE CASCADE,
 hidden_at TEXT,
 PRIMARY KEY(user_id, member_id)
);
CREATE TABLE identity_recovery_pending (
 user_id TEXT PRIMARY KEY REFERENCES users(id),
 source_json TEXT NOT NULL,
 mapped_to TEXT REFERENCES users(id),
 mapped_at TEXT
);
CREATE TABLE member_permission_versions (
 member_id TEXT PRIMARY KEY REFERENCES health_members(id) ON DELETE CASCADE,
 version INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE report_notes (
  id TEXT PRIMARY KEY,
  report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  content_text TEXT NOT NULL DEFAULT '',
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at TEXT
);
CREATE TABLE report_note_assets (
  id TEXT PRIMARY KEY,
  note_id TEXT NOT NULL REFERENCES report_notes(id) ON DELETE CASCADE,
  asset_type TEXT NOT NULL DEFAULT 'image' CHECK(asset_type = 'image'),
  original_name TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  thumbnail_path TEXT NOT NULL,
  preview_path TEXT,
  mime_type TEXT NOT NULL,
  file_size INTEGER NOT NULL CHECK(file_size > 0),
  sha256 TEXT NOT NULL,
  width INTEGER,
  height INTEGER,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(note_id, sha256)
);
CREATE INDEX report_notes_report_idx ON report_notes(report_id, created_at DESC);
CREATE INDEX report_note_assets_note_idx ON report_note_assets(note_id, sort_order, created_at);
CREATE TABLE indicator_groups (
  id TEXT PRIMARY KEY,
  group_key TEXT NOT NULL UNIQUE,
  parent_id TEXT REFERENCES indicator_groups(id),
  display_name TEXT NOT NULL,
  description TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
  source TEXT NOT NULL DEFAULT 'builtin' CHECK(source IN ('builtin', 'user')),
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX indicator_groups_parent_idx ON indicator_groups(parent_id, sort_order);
CREATE TABLE indicator_group_members (
  group_id TEXT NOT NULL REFERENCES indicator_groups(id) ON DELETE CASCADE,
  indicator_id TEXT NOT NULL REFERENCES indicator_catalog(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'builtin' CHECK(source IN ('builtin', 'user')),
  PRIMARY KEY(group_id, indicator_id)
);
CREATE INDEX indicator_group_members_indicator_idx ON indicator_group_members(indicator_id);
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  checksum TEXT NOT NULL DEFAULT '',
  elapsed_ms INTEGER NOT NULL DEFAULT 0,
  applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  is_gateway_admin INTEGER NOT NULL DEFAULT 0 CHECK (is_gateway_admin IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE user_identities (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('fnos_gateway', 'local', 'development')),
  subject TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(provider, subject)
);
CREATE TABLE health_members (
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
CREATE TABLE member_permissions (
  member_id TEXT NOT NULL REFERENCES health_members(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission TEXT NOT NULL CHECK (permission IN ('viewer', 'manager')),
  can_manage_sharing INTEGER NOT NULL DEFAULT 0 CHECK(can_manage_sharing IN (0,1) AND (can_manage_sharing = 0 OR permission = 'manager')),
  granted_by TEXT NOT NULL REFERENCES users(id),
  granted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(member_id, user_id)
);
CREATE TABLE medical_organizations (
  id TEXT PRIMARY KEY,
  canonical_name TEXT NOT NULL,
  branch_name TEXT,
  city TEXT,
  aliases_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE reports (
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
CREATE INDEX reports_timeline_idx
  ON reports(member_id, report_issued_at DESC, id DESC);
CREATE INDEX reports_status_idx ON reports(status, updated_at DESC);
CREATE INDEX reports_organization_idx
  ON reports(organization_id, report_issued_at DESC);
CREATE TABLE report_field_overrides (
  id TEXT PRIMARY KEY,
  report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  field_key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(report_id, field_key)
);
CREATE INDEX report_field_overrides_report_idx
  ON report_field_overrides(report_id, updated_at DESC);
CREATE TABLE report_pages (
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
  ocr_rotation INTEGER,
  source_page_number INTEGER,
  source_page_count INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(report_id, page_number)
);
CREATE TABLE observations (
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
CREATE INDEX observations_trend_idx
  ON observations(normalized_name, unit, report_id);
CREATE TABLE observation_field_overrides (
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
CREATE INDEX observation_field_overrides_observation_idx
  ON observation_field_overrides(observation_id);
CREATE INDEX observation_field_overrides_report_idx
  ON observation_field_overrides(report_id, updated_at DESC);
CREATE TABLE morphology_findings (
  id TEXT PRIMARY KEY,
  report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  section_name TEXT,
  organ TEXT,
  region TEXT,
  laterality TEXT NOT NULL DEFAULT 'unspecified' CHECK (
    laterality IN ('left', 'right', 'bilateral', 'midline', 'unspecified')
  ),
  finding_type TEXT NOT NULL,
  finding_name TEXT NOT NULL,
  presence TEXT NOT NULL DEFAULT 'present' CHECK (
    presence IN ('present', 'absent', 'uncertain')
  ),
  finding_count INTEGER CHECK (finding_count IS NULL OR finding_count >= 0),
  size_length REAL,
  size_width REAL,
  size_height REAL,
  size_unit TEXT,
  measurements_json TEXT NOT NULL DEFAULT '[]',
  morphology_text TEXT,
  attributes_json TEXT NOT NULL DEFAULT '{}',
  classification_system TEXT,
  classification_value TEXT,
  classification_text TEXT,
  comparison_text TEXT,
  raw_text TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '[]',
  confidence REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  tracking_group_id TEXT,
  match_confidence REAL CHECK (
    match_confidence IS NULL OR (match_confidence >= 0 AND match_confidence <= 1)
  ),
  source TEXT NOT NULL DEFAULT 'ai' CHECK (source IN ('ai', 'manual', 'legacy_migration')),
  manual_fields_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX morphology_findings_report_idx
  ON morphology_findings(report_id, section_name, id);
CREATE INDEX morphology_findings_tracking_idx
  ON morphology_findings(tracking_group_id, report_id)
  WHERE tracking_group_id IS NOT NULL;
CREATE INDEX morphology_findings_lookup_idx
  ON morphology_findings(organ, finding_type, laterality, report_id);
CREATE TABLE report_diagnoses (
  id TEXT PRIMARY KEY,
  report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  section_name TEXT,
  diagnosis_type TEXT NOT NULL DEFAULT 'other' CHECK (
    diagnosis_type IN ('outpatient', 'admission', 'discharge', 'pathology', 'other')
  ),
  diagnosis_text TEXT NOT NULL,
  diagnosis_code TEXT,
  code_system TEXT,
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
  evidence_json TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL DEFAULT 'ai' CHECK (source IN ('ai', 'manual', 'legacy_migration')),
  manual_fields_json TEXT NOT NULL DEFAULT '[]',
  is_deleted INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX report_diagnoses_report_idx
  ON report_diagnoses(report_id, diagnosis_type, id);
CREATE TABLE report_medications (
  id TEXT PRIMARY KEY,
  report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  section_name TEXT,
  medication_context TEXT NOT NULL DEFAULT 'other' CHECK (
    medication_context IN ('prescription', 'outpatient', 'inpatient', 'discharge', 'other')
  ),
  medication_name TEXT NOT NULL,
  generic_name TEXT,
  specification TEXT,
  dosage_form TEXT,
  dose TEXT,
  dose_unit TEXT,
  frequency TEXT,
  route TEXT,
  duration TEXT,
  quantity TEXT,
  quantity_unit TEXT,
  instructions TEXT,
  evidence_json TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL DEFAULT 'ai' CHECK (source IN ('ai', 'manual', 'legacy_migration')),
  manual_fields_json TEXT NOT NULL DEFAULT '[]',
  is_deleted INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX report_medications_report_idx
  ON report_medications(report_id, medication_context, id);
CREATE TABLE report_procedures (
  id TEXT PRIMARY KEY,
  report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  section_name TEXT,
  procedure_type TEXT NOT NULL DEFAULT 'other' CHECK (
    procedure_type IN ('examination', 'treatment', 'surgery', 'other')
  ),
  procedure_name TEXT NOT NULL,
  procedure_code TEXT,
  body_part TEXT,
  performed_at TEXT,
  result_text TEXT,
  evidence_json TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL DEFAULT 'ai' CHECK (source IN ('ai', 'manual', 'legacy_migration')),
  manual_fields_json TEXT NOT NULL DEFAULT '[]',
  is_deleted INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX report_procedures_report_idx
  ON report_procedures(report_id, procedure_type, performed_at, id);
CREATE TABLE vaccination_records (
  id TEXT PRIMARY KEY,
  report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  vaccine_name TEXT NOT NULL,
  dose_number TEXT,
  manufacturer TEXT,
  lot_number TEXT,
  administered_at TEXT,
  administration_site TEXT,
  next_due_at TEXT,
  evidence_json TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL DEFAULT 'ai' CHECK (source IN ('ai', 'manual', 'legacy_migration')),
  manual_fields_json TEXT NOT NULL DEFAULT '[]',
  is_deleted INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX vaccination_records_report_idx
  ON vaccination_records(report_id, administered_at, id);
CREATE TABLE billing_summaries (
  id TEXT PRIMARY KEY,
  report_id TEXT NOT NULL UNIQUE REFERENCES reports(id) ON DELETE CASCADE,
  invoice_number TEXT,
  total_amount REAL,
  insurance_amount REAL,
  self_pay_amount REAL,
  currency TEXT NOT NULL DEFAULT 'CNY',
  evidence_json TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL DEFAULT 'ai' CHECK (source IN ('ai', 'manual', 'legacy_migration')),
  manual_fields_json TEXT NOT NULL DEFAULT '[]',
  is_deleted INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE billing_items (
  id TEXT PRIMARY KEY,
  report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  category TEXT,
  item_name TEXT NOT NULL,
  amount REAL,
  quantity REAL,
  evidence_json TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL DEFAULT 'ai' CHECK (source IN ('ai', 'manual', 'legacy_migration')),
  manual_fields_json TEXT NOT NULL DEFAULT '[]',
  is_deleted INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX billing_items_report_idx
  ON billing_items(report_id, category, id);
CREATE TABLE report_structured_sections (
  id TEXT PRIMARY KEY,
  report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  section_key TEXT NOT NULL,
  section_title TEXT NOT NULL,
  content_text TEXT NOT NULL,
  content_json TEXT,
  evidence_json TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL DEFAULT 'ai' CHECK (source IN ('ai', 'manual', 'legacy_migration')),
  manual_fields_json TEXT NOT NULL DEFAULT '[]',
  is_deleted INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX report_structured_sections_report_idx
  ON report_structured_sections(report_id, section_key, id);
CREATE TABLE indicator_catalog (
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
CREATE TABLE indicator_aliases (
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
CREATE INDEX indicator_aliases_lookup_idx
  ON indicator_aliases(normalized_alias, enabled, scope);
CREATE TABLE observation_normalizations (
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
CREATE INDEX observation_normalizations_trend_idx
  ON observation_normalizations(canonical_key, canonical_unit, quality);
CREATE TABLE indicator_governance_decisions (
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
CREATE INDEX indicator_governance_decisions_key_idx
  ON indicator_governance_decisions(canonical_key, action);
CREATE TABLE indicator_governance_history (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL CHECK (event_type IN ('apply', 'undo', 'alias_enable', 'alias_disable')),
  fingerprint TEXT,
  decision_action TEXT CHECK (decision_action IS NULL OR decision_action IN ('confirm', 'exclude')),
  indicator_id TEXT REFERENCES indicator_catalog(id) ON DELETE SET NULL,
  canonical_key TEXT,
  alias_id TEXT REFERENCES indicator_aliases(id) ON DELETE SET NULL,
  alias_name TEXT,
  alias_scope TEXT CHECK (alias_scope IS NULL OR alias_scope IN ('global', 'hospital', 'department', 'report_type')),
  report_type TEXT,
  reason TEXT,
  affected_observations INTEGER NOT NULL DEFAULT 0 CHECK (affected_observations >= 0),
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX indicator_governance_history_created_idx
  ON indicator_governance_history(created_at DESC, id DESC);
CREATE INDEX indicator_governance_history_fingerprint_idx
  ON indicator_governance_history(fingerprint, created_at DESC);
CREATE INDEX indicator_governance_history_alias_idx
  ON indicator_governance_history(alias_id, created_at DESC);
CREATE TABLE processing_jobs (
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
CREATE TABLE processing_job_events (
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
CREATE INDEX processing_job_events_job_idx
  ON processing_job_events(job_id, created_at, id);
CREATE INDEX processing_job_events_report_idx
  ON processing_job_events(report_id, created_at DESC);
CREATE TABLE ocr_results (
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
CREATE TABLE report_extractions (
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
CREATE INDEX report_extractions_report_idx
  ON report_extractions(report_id, created_at DESC);
CREATE TABLE ai_extraction_units (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES processing_jobs(id) ON DELETE CASCADE,
  report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  plan_hash TEXT NOT NULL,
  unit_key TEXT NOT NULL,
  unit_index INTEGER NOT NULL,
  unit_type TEXT NOT NULL CHECK (unit_type IN ('complete_pages', 'page_chunk', 'supplement')),
  page_numbers_json TEXT NOT NULL DEFAULT '[]',
  page_ranges_json TEXT NOT NULL DEFAULT '[]',
  input_hash TEXT NOT NULL,
  character_count INTEGER NOT NULL DEFAULT 0,
  candidate_count INTEGER NOT NULL DEFAULT 0,
  matched_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'planned' CHECK (
    status IN ('planned', 'processing', 'completed', 'warning', 'failed', 'superseded')
  ),
  attempts INTEGER NOT NULL DEFAULT 0,
  provider TEXT,
  model TEXT,
  prompt_version TEXT,
  result_json TEXT,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  elapsed_ms INTEGER,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  started_at TEXT,
  finished_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(job_id, unit_key)
);
CREATE INDEX ai_extraction_units_job_idx
  ON ai_extraction_units(job_id, unit_index, id);
CREATE INDEX ai_extraction_units_report_idx
  ON ai_extraction_units(report_id, created_at DESC);
CREATE INDEX ai_extraction_units_status_idx
  ON ai_extraction_units(status, updated_at);
CREATE TABLE ai_extraction_unit_routes (
  unit_id TEXT PRIMARY KEY REFERENCES ai_extraction_units(id) ON DELETE CASCADE,
  classifier_version TEXT NOT NULL,
  primary_content_type TEXT NOT NULL,
  content_types_json TEXT NOT NULL DEFAULT '[]',
  confidence REAL NOT NULL DEFAULT 0 CHECK (confidence >= 0 AND confidence <= 1),
  reasons_json TEXT NOT NULL DEFAULT '[]',
  document_content_type TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX ai_extraction_unit_routes_type_idx
  ON ai_extraction_unit_routes(primary_content_type, updated_at DESC);
CREATE TABLE ai_extraction_attempts (
  id TEXT PRIMARY KEY,
  unit_id TEXT NOT NULL REFERENCES ai_extraction_units(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL REFERENCES processing_jobs(id) ON DELETE CASCADE,
  report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  attempt_number INTEGER NOT NULL,
  attempt_type TEXT NOT NULL CHECK (
    attempt_type IN ('main', 'format_retry', 'split', 'supplement', 'visual')
  ),
  status TEXT NOT NULL CHECK (status IN ('completed', 'failed')),
  provider TEXT,
  model TEXT,
  prompt_version TEXT,
  input_characters INTEGER NOT NULL DEFAULT 0,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  elapsed_ms INTEGER,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX ai_extraction_attempts_unit_idx
  ON ai_extraction_attempts(unit_id, attempt_number, created_at);
CREATE INDEX ai_extraction_attempts_report_idx
  ON ai_extraction_attempts(report_id, created_at DESC);
CREATE TABLE ai_extraction_candidates (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES processing_jobs(id) ON DELETE CASCADE,
  unit_id TEXT REFERENCES ai_extraction_units(id) ON DELETE SET NULL,
  report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  candidate_key TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  page_number INTEGER NOT NULL,
  source_line_ids_json TEXT NOT NULL DEFAULT '[]',
  kind TEXT NOT NULL CHECK (kind IN ('scalar', 'morphology')),
  dictionary_keys_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL CHECK (
    status IN ('local_extracted', 'ai_extracted', 'redundant', 'ignored', 'unresolved')
  ),
  matched_entity_key TEXT,
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(job_id, candidate_key)
);
CREATE INDEX ai_extraction_candidates_job_idx
  ON ai_extraction_candidates(job_id, status, page_number, id);
CREATE INDEX ai_extraction_candidates_report_idx
  ON ai_extraction_candidates(report_id, created_at DESC);
CREATE TABLE ai_audit_events (
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
CREATE INDEX ai_audit_events_created_idx
  ON ai_audit_events(created_at DESC, id DESC);
CREATE INDEX ai_audit_events_report_idx
  ON ai_audit_events(report_id, created_at DESC);
CREATE TABLE reminders (
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
CREATE TABLE app_notifications (
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
CREATE INDEX app_notifications_member_idx
  ON app_notifications(member_id, status, created_at DESC);
CREATE INDEX app_notifications_report_idx
  ON app_notifications(report_id, created_at DESC);
CREATE TABLE app_upgrade_history (
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
CREATE INDEX app_upgrade_history_started_idx
  ON app_upgrade_history(started_at DESC);
CREATE TABLE app_settings (
  setting_key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE maintenance_tasks (
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
CREATE INDEX maintenance_tasks_recent_idx
  ON maintenance_tasks(task_type, created_at DESC, id DESC);
CREATE UNIQUE INDEX maintenance_tasks_active_idx
  ON maintenance_tasks(task_type)
  WHERE status IN ('queued', 'running');
CREATE TABLE user_trend_pins (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES health_members(id) ON DELETE CASCADE,
  indicator_key TEXT NOT NULL,
  unit_key TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(user_id, member_id, indicator_key, unit_key)
);
CREATE INDEX user_trend_pins_member_idx
  ON user_trend_pins(user_id, member_id, created_at DESC);
CREATE TABLE local_accounts (
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
CREATE TABLE auth_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE login_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  ip_address TEXT NOT NULL,
  succeeded INTEGER NOT NULL DEFAULT 0 CHECK (succeeded IN (0, 1)),
  attempted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX login_attempts_limit_idx
  ON login_attempts(username, ip_address, attempted_at DESC);
CREATE TABLE file_gc_queue (
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
CREATE TABLE file_gc_members (
 gc_id TEXT NOT NULL REFERENCES file_gc_queue(id) ON DELETE CASCADE,
 member_id TEXT NOT NULL REFERENCES health_members(id) ON DELETE CASCADE,
 PRIMARY KEY(gc_id, member_id)
);
CREATE INDEX file_gc_members_member_idx ON file_gc_members(member_id, gc_id);
CREATE INDEX file_gc_queue_pending_idx
  ON file_gc_queue(completed_at, not_before, created_at);
CREATE TABLE indicator_dictionary_snapshots (
  id TEXT PRIMARY KEY,
  layer TEXT NOT NULL CHECK (layer IN ('core', 'remote')),
  revision INTEGER NOT NULL,
  format_version INTEGER NOT NULL,
  content_sha256 TEXT NOT NULL,
  manifest_json TEXT,
  taxonomy_json TEXT NOT NULL,
  indicators_json TEXT NOT NULL,
  source_url TEXT,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(layer, revision, content_sha256)
);
CREATE INDEX indicator_dictionary_snapshots_layer_idx
  ON indicator_dictionary_snapshots(layer, revision DESC, created_at DESC);
CREATE TABLE indicator_dictionary_state (
  layer TEXT PRIMARY KEY CHECK (layer IN ('core', 'remote')),
  active_snapshot_id TEXT NOT NULL REFERENCES indicator_dictionary_snapshots(id),
  revision INTEGER NOT NULL,
  content_sha256 TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE indicator_dictionary_updates (
  id TEXT PRIMARY KEY,
  operation TEXT NOT NULL CHECK (operation IN ('core_sync', 'remote_update', 'rollback')),
  layer TEXT NOT NULL CHECK (layer IN ('core', 'remote')),
  from_revision INTEGER,
  to_revision INTEGER,
  snapshot_id TEXT REFERENCES indicator_dictionary_snapshots(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN ('started', 'completed', 'failed')),
  source_url TEXT,
  actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  summary_json TEXT NOT NULL DEFAULT '{}',
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at TEXT
);
CREATE INDEX indicator_dictionary_updates_created_idx
  ON indicator_dictionary_updates(created_at DESC, id DESC);
CREATE TABLE indicator_taxonomy_groups (
  group_key TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  item_order INTEGER NOT NULL,
  description TEXT,
  section_hints_json TEXT NOT NULL DEFAULT '[]',
  dictionary_layer TEXT NOT NULL,
  dictionary_revision INTEGER NOT NULL,
  dictionary_snapshot_id TEXT NOT NULL
);
CREATE TABLE indicator_taxonomy_subgroups (
  subgroup_key TEXT PRIMARY KEY,
  group_key TEXT NOT NULL REFERENCES indicator_taxonomy_groups(group_key) ON DELETE CASCADE,
  name TEXT NOT NULL,
  item_order INTEGER NOT NULL,
  description TEXT,
  section_hints_json TEXT NOT NULL DEFAULT '[]',
  dictionary_layer TEXT NOT NULL,
  dictionary_revision INTEGER NOT NULL,
  dictionary_snapshot_id TEXT NOT NULL
);
CREATE TABLE indicator_taxonomy_categories (
  category_key TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  group_key TEXT NOT NULL REFERENCES indicator_taxonomy_groups(group_key) ON DELETE CASCADE,
  subgroup_key TEXT REFERENCES indicator_taxonomy_subgroups(subgroup_key) ON DELETE SET NULL,
  item_order INTEGER NOT NULL,
  aliases_json TEXT NOT NULL DEFAULT '[]',
  section_hints_json TEXT NOT NULL DEFAULT '[]',
  dictionary_layer TEXT NOT NULL,
  dictionary_revision INTEGER NOT NULL,
  dictionary_snapshot_id TEXT NOT NULL
);
CREATE TABLE indicator_unmatched_names (
  fingerprint TEXT PRIMARY KEY,
  normalized_name TEXT NOT NULL,
  raw_name TEXT NOT NULL,
  unit TEXT,
  section_name TEXT,
  sample_result TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'ignored')),
  resolved_canonical_key TEXT,
  first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE indicator_unmatched_occurrences (
  observation_id TEXT PRIMARY KEY REFERENCES observations(id) ON DELETE CASCADE,
  fingerprint TEXT NOT NULL REFERENCES indicator_unmatched_names(fingerprint) ON DELETE CASCADE,
  report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX indicator_unmatched_occurrences_pool_idx
  ON indicator_unmatched_occurrences(fingerprint, created_at DESC);
CREATE TABLE institution_trend_projects (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES health_members(id) ON DELETE CASCADE,
  hospital_name TEXT NOT NULL,
  name TEXT NOT NULL,
  method TEXT NOT NULL,
  specimen TEXT NOT NULL,
  unit TEXT NOT NULL,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE institution_trend_observations (
  observation_id TEXT PRIMARY KEY REFERENCES observations(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES institution_trend_projects(id) ON DELETE CASCADE,
  confirmed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  confirmed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX institution_trend_member_idx ON institution_trend_projects(member_id);
CREATE INDEX institution_trend_project_idx ON institution_trend_observations(project_id);
CREATE TABLE institution_trend_auto_rules (
  project_id TEXT PRIMARY KEY REFERENCES institution_trend_projects(id) ON DELETE CASCADE,
  names_json TEXT NOT NULL,
  confirmed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now'))
);
CREATE TABLE institution_trend_auto_decisions (
  observation_id TEXT PRIMARY KEY REFERENCES observations(id) ON DELETE CASCADE,
  decision TEXT NOT NULL CHECK (decision IN ('blocked', 'linked'))
);
CREATE TABLE report_duplicate_decisions (
  pair_key TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES health_members(id) ON DELETE CASCADE,
  left_report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  right_report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  decision TEXT NOT NULL CHECK (decision IN ('duplicate', 'distinct')),
  reason TEXT,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  rule_version TEXT NOT NULL DEFAULT 'legacy',
  rule_snapshot_json TEXT NOT NULL DEFAULT '{}',
  decided_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (left_report_id < right_report_id),
  UNIQUE(member_id, left_report_id, right_report_id)
);
CREATE INDEX report_duplicate_decisions_member_idx
  ON report_duplicate_decisions(member_id, updated_at DESC, pair_key);
CREATE INDEX report_duplicate_decisions_reports_idx
  ON report_duplicate_decisions(left_report_id, right_report_id, decision);
CREATE TABLE report_duplicate_history (
  id TEXT PRIMARY KEY,
  pair_key TEXT NOT NULL,
  member_id TEXT NOT NULL,
  left_report_id TEXT NOT NULL,
  right_report_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('apply', 'undo')),
  decision TEXT CHECK (decision IS NULL OR decision IN ('duplicate', 'distinct')),
  reason TEXT,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  rule_version TEXT NOT NULL DEFAULT 'legacy',
  rule_snapshot_json TEXT NOT NULL DEFAULT '{}',
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX report_duplicate_history_member_idx
  ON report_duplicate_history(member_id, created_at DESC, id DESC);
CREATE INDEX report_duplicate_history_pair_idx
  ON report_duplicate_history(pair_key, created_at DESC, id DESC);
CREATE TABLE report_duplicate_operations (
  id TEXT PRIMARY KEY,
  operation TEXT NOT NULL CHECK (operation IN ('scan', 'recompute', 'rollback_drill')),
  member_id TEXT NOT NULL REFERENCES health_members(id) ON DELETE CASCADE,
  rule_version TEXT,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  purpose TEXT NOT NULL DEFAULT 'manual',
  requested_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  stats_json TEXT NOT NULL DEFAULT '{}',
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at TEXT
);
CREATE INDEX report_duplicate_operations_member_idx
  ON report_duplicate_operations(member_id, created_at DESC, id DESC);
CREATE INDEX report_duplicate_operations_rule_idx
  ON report_duplicate_operations(rule_version, operation, status, created_at DESC);
CREATE TABLE audit_logs (
  id TEXT PRIMARY KEY,
  actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  ip_address TEXT,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE feedback_sync_state (
  client_hash TEXT NOT NULL,
  number TEXT NOT NULL,
  status TEXT NOT NULL,
  remote_version INTEGER NOT NULL,
  PRIMARY KEY (client_hash, number)
);
CREATE TABLE feedback_notifications (
  id TEXT PRIMARY KEY,
  client_hash TEXT NOT NULL,
  number TEXT NOT NULL,
  remote_version INTEGER NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (client_hash, number, remote_version)
);
CREATE TABLE feedback_notification_reads (
  notification_id TEXT NOT NULL REFERENCES feedback_notifications(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('unread', 'read', 'archived')),
  read_at TEXT,
  PRIMARY KEY (notification_id, user_id)
);
CREATE TABLE upload_receipts (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  request_key TEXT NOT NULL,
  member_id TEXT NOT NULL REFERENCES health_members(id) ON DELETE CASCADE,
  content_hash TEXT NOT NULL,
  report_id TEXT REFERENCES reports(id) ON DELETE SET NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(user_id, request_key)
);
CREATE TABLE report_page_appends (
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
CREATE UNIQUE INDEX report_page_appends_active ON report_page_appends(report_id)
 WHERE state NOT IN ('complete','ocr_only','noop','cancelled');
CREATE TABLE report_page_append_files (
 id TEXT PRIMARY KEY, batch_id TEXT NOT NULL REFERENCES report_page_appends(id) ON DELETE CASCADE,
 position INTEGER NOT NULL, original_name TEXT NOT NULL, file_size INTEGER NOT NULL,
 storage_path TEXT NOT NULL, sha256 TEXT, mime_type TEXT, page_count INTEGER, error_message TEXT,
 UNIQUE(batch_id,position)
);
CREATE TABLE report_page_append_pages (
 id TEXT PRIMARY KEY, file_id TEXT NOT NULL REFERENCES report_page_append_files(id) ON DELETE CASCADE,
 source_page_number INTEGER NOT NULL, rotation INTEGER NOT NULL DEFAULT 0,
 position INTEGER, duplicate INTEGER NOT NULL DEFAULT 0, thumbnail_path TEXT, ocr_json TEXT,
 UNIQUE(file_id,source_page_number)
);
CREATE TABLE observation_suppressions (
 report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
 source_key TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(report_id,source_key)
);
CREATE TRIGGER page_append_job_lock BEFORE INSERT ON processing_jobs
WHEN NEW.pipeline_version <> 'page-append-v1' AND EXISTS(SELECT 1 FROM report_page_appends WHERE report_id=NEW.report_id AND state NOT IN ('complete','ocr_only','noop','cancelled'))
BEGIN SELECT RAISE(ABORT,'PAGE_APPEND_BUSY'); END;
CREATE TRIGGER page_append_page_update_lock BEFORE UPDATE OF page_number,rotation,report_id,storage_path ON report_pages
WHEN EXISTS(SELECT 1 FROM report_page_appends WHERE report_id=OLD.report_id AND state NOT IN ('complete','ocr_only','noop','cancelled'))
BEGIN SELECT RAISE(ABORT,'PAGE_APPEND_BUSY'); END;
CREATE TRIGGER page_append_page_delete_lock BEFORE DELETE ON report_pages
WHEN EXISTS(SELECT 1 FROM report_page_appends WHERE report_id=OLD.report_id AND state NOT IN ('complete','ocr_only','noop','cancelled'))
BEGIN SELECT RAISE(ABORT,'PAGE_APPEND_BUSY'); END;
CREATE TRIGGER page_append_report_lock BEFORE UPDATE OF status,member_id ON reports
WHEN (NEW.status<>OLD.status OR NEW.member_id<>OLD.member_id) AND EXISTS(SELECT 1 FROM report_page_appends WHERE report_id=OLD.id AND state NOT IN ('complete','ocr_only','noop','cancelled'))
BEGIN SELECT RAISE(ABORT,'PAGE_APPEND_BUSY'); END;
CREATE TABLE report_duplicate_runtime (
 report_id TEXT PRIMARY KEY REFERENCES reports(id) ON DELETE CASCADE,
 source_signature TEXT, result_signature TEXT, extraction_id TEXT,
 pause_json TEXT, continue_signature TEXT, continue_job_id TEXT, post_status TEXT, post_json TEXT,
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX duplicate_page_hash_idx ON report_pages(sha256,report_id);
CREATE TABLE report_examination_state (
  report_id TEXT PRIMARY KEY REFERENCES reports(id) ON DELETE CASCADE,
  version INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE report_examinations (
  id TEXT PRIMARY KEY,
  report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  source_key TEXT NOT NULL,
  examination_type TEXT NOT NULL DEFAULT '',
  institution TEXT NOT NULL DEFAULT '',
  report_number TEXT NOT NULL DEFAULT '',
  specimen TEXT NOT NULL DEFAULT '',
  method TEXT NOT NULL DEFAULT '',
  sampled_at TEXT,
  examined_at TEXT,
  issued_at TEXT,
  occurred_at TEXT,
  time_kind TEXT NOT NULL DEFAULT 'unknown' CHECK(time_kind IN ('sampled','examined','issued','manual','unknown')),
  time_precision TEXT NOT NULL DEFAULT 'unknown' CHECK(time_precision IN ('date','minute','second','unknown')),
  time_text TEXT NOT NULL DEFAULT '',
  evidence_json TEXT NOT NULL DEFAULT '[]',
  confirmation_status TEXT NOT NULL DEFAULT 'pending' CHECK(confirmation_status IN ('pending','automatic','confirmed')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(report_id,source_key)
);
CREATE INDEX report_examination_report_idx ON report_examinations(report_id,occurred_at);
CREATE TABLE observation_examinations (
  observation_id TEXT PRIMARY KEY REFERENCES observations(id) ON DELETE CASCADE,
  examination_id TEXT NOT NULL REFERENCES report_examinations(id) ON DELETE CASCADE,
  assignment_source TEXT NOT NULL CHECK(assignment_source IN ('automatic','manual')),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX observation_examination_idx ON observation_examinations(examination_id);
CREATE TABLE morphology_finding_examinations (
  finding_id TEXT PRIMARY KEY REFERENCES morphology_findings(id) ON DELETE CASCADE,
  examination_id TEXT NOT NULL REFERENCES report_examinations(id) ON DELETE CASCADE,
  assignment_source TEXT NOT NULL CHECK(assignment_source IN ('automatic','manual')),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX morphology_finding_examination_idx ON morphology_finding_examinations(examination_id);
CREATE TABLE examination_duplicate_decisions (
  left_id TEXT NOT NULL REFERENCES report_examinations(id) ON DELETE CASCADE,
  right_id TEXT NOT NULL REFERENCES report_examinations(id) ON DELETE CASCADE,
  decision TEXT NOT NULL CHECK(decision IN ('same','different')),
  actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(left_id,right_id),
  CHECK(left_id < right_id)
);
CREATE TRIGGER examination_duplicate_same_member_insert
BEFORE INSERT ON examination_duplicate_decisions
WHEN (SELECT r.member_id FROM report_examinations e JOIN reports r ON r.id=e.report_id WHERE e.id=NEW.left_id) IS NOT
     (SELECT r.member_id FROM report_examinations e JOIN reports r ON r.id=e.report_id WHERE e.id=NEW.right_id)
BEGIN SELECT RAISE(ABORT,'examination_member_mismatch'); END;
CREATE TRIGGER examination_duplicate_same_member_update
BEFORE UPDATE ON examination_duplicate_decisions
WHEN (SELECT r.member_id FROM report_examinations e JOIN reports r ON r.id=e.report_id WHERE e.id=NEW.left_id) IS NOT
     (SELECT r.member_id FROM report_examinations e JOIN reports r ON r.id=e.report_id WHERE e.id=NEW.right_id)
BEGIN SELECT RAISE(ABORT,'examination_member_mismatch'); END;
CREATE TRIGGER observation_examination_same_report_insert
BEFORE INSERT ON observation_examinations
WHEN (SELECT report_id FROM observations WHERE id=NEW.observation_id) IS NOT
     (SELECT report_id FROM report_examinations WHERE id=NEW.examination_id)
BEGIN SELECT RAISE(ABORT,'examination_report_mismatch'); END;
CREATE TRIGGER observation_examination_same_report_update
BEFORE UPDATE ON observation_examinations
WHEN (SELECT report_id FROM observations WHERE id=NEW.observation_id) IS NOT
     (SELECT report_id FROM report_examinations WHERE id=NEW.examination_id)
BEGIN SELECT RAISE(ABORT,'examination_report_mismatch'); END;
CREATE TRIGGER morphology_finding_examination_same_report_insert
BEFORE INSERT ON morphology_finding_examinations
WHEN (SELECT report_id FROM morphology_findings WHERE id=NEW.finding_id) IS NOT
     (SELECT report_id FROM report_examinations WHERE id=NEW.examination_id)
BEGIN SELECT RAISE(ABORT,'examination_report_mismatch'); END;
CREATE TRIGGER morphology_finding_examination_same_report_update
BEFORE UPDATE ON morphology_finding_examinations
WHEN (SELECT report_id FROM morphology_findings WHERE id=NEW.finding_id) IS NOT
     (SELECT report_id FROM report_examinations WHERE id=NEW.examination_id)
BEGIN SELECT RAISE(ABORT,'examination_report_mismatch'); END;
INSERT INTO schema_migrations(version,name,checksum,elapsed_ms,applied_at) VALUES(1,'initial_health_records_schema','manual:001-initial-health-records-schema',0,'2026-10-25 01:31:22');
INSERT INTO schema_migrations(version,name,checksum,elapsed_ms,applied_at) VALUES(2,'add_pdf_source_page_columns','manual:002-add-pdf-source-page-columns',0,'2026-10-25 01:31:22');
INSERT INTO schema_migrations(version,name,checksum,elapsed_ms,applied_at) VALUES(3,'add_report_extractions','manual:003-add-report-extractions',0,'2026-10-25 01:31:22');
INSERT INTO schema_migrations(version,name,checksum,elapsed_ms,applied_at) VALUES(4,'add_processing_job_events','manual:004-add-processing-job-events',0,'2026-10-25 01:31:22');
INSERT INTO schema_migrations(version,name,checksum,elapsed_ms,applied_at) VALUES(5,'add_app_notifications','manual:005-add-app-notifications',0,'2026-10-25 01:31:22');
INSERT INTO schema_migrations(version,name,checksum,elapsed_ms,applied_at) VALUES(6,'add_upgrade_history','manual:006-add-upgrade-history',0,'2026-10-25 01:31:22');
INSERT INTO schema_migrations(version,name,checksum,elapsed_ms,applied_at) VALUES(7,'add_indicator_normalization','manual:007-add-indicator-normalization',0,'2026-10-25 01:31:22');
INSERT INTO schema_migrations(version,name,checksum,elapsed_ms,applied_at) VALUES(8,'add_ai_audit_events','manual:008-add-ai-audit-events',0,'2026-10-25 01:31:22');
INSERT INTO schema_migrations(version,name,checksum,elapsed_ms,applied_at) VALUES(9,'add_report_field_overrides','manual:009-add-report-field-overrides',0,'2026-10-25 01:31:22');
INSERT INTO schema_migrations(version,name,checksum,elapsed_ms,applied_at) VALUES(10,'add_file_gc_queue','manual:010-add-file-gc-queue',0,'2026-10-25 01:31:22');
INSERT INTO schema_migrations(version,name,checksum,elapsed_ms,applied_at) VALUES(11,'add_maintenance_tasks','manual:011-add-maintenance-tasks',0,'2026-10-25 01:31:22');
INSERT INTO schema_migrations(version,name,checksum,elapsed_ms,applied_at) VALUES(12,'add_user_trend_pins','manual:012-add-user-trend-pins',0,'2026-10-25 01:31:22');
INSERT INTO schema_migrations(version,name,checksum,elapsed_ms,applied_at) VALUES(13,'add_trend_indicator_metadata','manual:013-add-trend-indicator-metadata',0,'2026-10-25 01:31:22');
INSERT INTO schema_migrations(version,name,checksum,elapsed_ms,applied_at) VALUES(14,'add_ai_managed_indicator_catalog_flag','manual:014-add-ai-managed-indicator-catalog-flag',0,'2026-10-25 01:31:22');
INSERT INTO schema_migrations(version,name,checksum,elapsed_ms,applied_at) VALUES(15,'add_indicator_dictionary_snapshots','manual:015-add-indicator-dictionary-snapshots',0,'2026-10-25 01:31:22');
INSERT INTO schema_migrations(version,name,checksum,elapsed_ms,applied_at) VALUES(16,'finalize_indicator_dictionary_morphology_ai_units_and_data_governance','manual:016-finalize-indicator-dictionary-morphology-ai-units-data-governance',0,'2026-10-25 01:31:22');
INSERT INTO schema_migrations(version,name,checksum,elapsed_ms,applied_at) VALUES(17,'add_institution_trend_projects','manual:017-institution-trend-projects',0,'2026-10-25 01:31:22');
INSERT INTO schema_migrations(version,name,checksum,elapsed_ms,applied_at) VALUES(18,'preserve_ocr_page_orientation','manual:018-preserve-ocr-page-orientation',0,'2026-10-25 01:31:22');
INSERT INTO schema_migrations(version,name,checksum,elapsed_ms,applied_at) VALUES(19,'add_feedback_status_notifications','manual:019-add-feedback-status-notifications',0,'2026-10-25 01:31:22');
