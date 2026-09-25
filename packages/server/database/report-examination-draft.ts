/** Unnumbered development draft: never infer historical examination dates during upgrade. */
export const reportExaminationDraftSql = `
CREATE TABLE IF NOT EXISTS report_examination_state (
  report_id TEXT PRIMARY KEY REFERENCES reports(id) ON DELETE CASCADE,
  version INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS report_examinations (
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
CREATE INDEX IF NOT EXISTS report_examination_report_idx ON report_examinations(report_id,occurred_at);
CREATE TABLE IF NOT EXISTS observation_examinations (
  observation_id TEXT PRIMARY KEY REFERENCES observations(id) ON DELETE CASCADE,
  examination_id TEXT NOT NULL REFERENCES report_examinations(id) ON DELETE CASCADE,
  assignment_source TEXT NOT NULL CHECK(assignment_source IN ('automatic','manual')),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS observation_examination_idx ON observation_examinations(examination_id);
CREATE TABLE IF NOT EXISTS morphology_finding_examinations (
  finding_id TEXT PRIMARY KEY REFERENCES morphology_findings(id) ON DELETE CASCADE,
  examination_id TEXT NOT NULL REFERENCES report_examinations(id) ON DELETE CASCADE,
  assignment_source TEXT NOT NULL CHECK(assignment_source IN ('automatic','manual')),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS morphology_finding_examination_idx ON morphology_finding_examinations(examination_id);
CREATE TABLE IF NOT EXISTS examination_duplicate_decisions (
  left_id TEXT NOT NULL REFERENCES report_examinations(id) ON DELETE CASCADE,
  right_id TEXT NOT NULL REFERENCES report_examinations(id) ON DELETE CASCADE,
  decision TEXT NOT NULL CHECK(decision IN ('same','different')),
  actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(left_id,right_id),
  CHECK(left_id < right_id)
);
CREATE TRIGGER IF NOT EXISTS examination_duplicate_same_member_insert
BEFORE INSERT ON examination_duplicate_decisions
WHEN (SELECT r.member_id FROM report_examinations e JOIN reports r ON r.id=e.report_id WHERE e.id=NEW.left_id) IS NOT
     (SELECT r.member_id FROM report_examinations e JOIN reports r ON r.id=e.report_id WHERE e.id=NEW.right_id)
BEGIN SELECT RAISE(ABORT,'examination_member_mismatch'); END;
CREATE TRIGGER IF NOT EXISTS examination_duplicate_same_member_update
BEFORE UPDATE ON examination_duplicate_decisions
WHEN (SELECT r.member_id FROM report_examinations e JOIN reports r ON r.id=e.report_id WHERE e.id=NEW.left_id) IS NOT
     (SELECT r.member_id FROM report_examinations e JOIN reports r ON r.id=e.report_id WHERE e.id=NEW.right_id)
BEGIN SELECT RAISE(ABORT,'examination_member_mismatch'); END;
CREATE TRIGGER IF NOT EXISTS observation_examination_same_report_insert
BEFORE INSERT ON observation_examinations
WHEN (SELECT report_id FROM observations WHERE id=NEW.observation_id) IS NOT
     (SELECT report_id FROM report_examinations WHERE id=NEW.examination_id)
BEGIN SELECT RAISE(ABORT,'examination_report_mismatch'); END;
CREATE TRIGGER IF NOT EXISTS observation_examination_same_report_update
BEFORE UPDATE ON observation_examinations
WHEN (SELECT report_id FROM observations WHERE id=NEW.observation_id) IS NOT
     (SELECT report_id FROM report_examinations WHERE id=NEW.examination_id)
BEGIN SELECT RAISE(ABORT,'examination_report_mismatch'); END;
CREATE TRIGGER IF NOT EXISTS morphology_finding_examination_same_report_insert
BEFORE INSERT ON morphology_finding_examinations
WHEN (SELECT report_id FROM morphology_findings WHERE id=NEW.finding_id) IS NOT
     (SELECT report_id FROM report_examinations WHERE id=NEW.examination_id)
BEGIN SELECT RAISE(ABORT,'examination_report_mismatch'); END;
CREATE TRIGGER IF NOT EXISTS morphology_finding_examination_same_report_update
BEFORE UPDATE ON morphology_finding_examinations
WHEN (SELECT report_id FROM morphology_findings WHERE id=NEW.finding_id) IS NOT
     (SELECT report_id FROM report_examinations WHERE id=NEW.examination_id)
BEGIN SELECT RAISE(ABORT,'examination_report_mismatch'); END;
`;
