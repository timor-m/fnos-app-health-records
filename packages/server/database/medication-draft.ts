import type { DatabaseSync } from 'node:sqlite';

/** Unnumbered additive draft; prescriptions never create confirmed courses automatically. */
export const medicationDraftSchemaSql = `
CREATE TABLE IF NOT EXISTS medication_courses (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES health_members(id) ON DELETE CASCADE,
  medication_name TEXT NOT NULL, specification TEXT, dosage_form TEXT,
  dose TEXT, dose_unit TEXT, frequency TEXT, route TEXT, instructions TEXT,
  status TEXT NOT NULL CHECK(status IN ('active','paused','stopped')),
  started_at TEXT NOT NULL, last_changed_at TEXT NOT NULL, stopped_at TEXT,
  source_report_id TEXT REFERENCES reports(id) ON DELETE SET NULL,
  source_medication_id TEXT,
  source_snapshot_json TEXT CHECK(source_snapshot_json IS NULL OR json_valid(source_snapshot_json)),
  revision INTEGER NOT NULL DEFAULT 1,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at TEXT, purge_after TEXT
);
CREATE INDEX IF NOT EXISTS medication_courses_member_idx ON medication_courses(member_id,status,started_at);
CREATE TABLE IF NOT EXISTS medication_course_changes (
  id TEXT PRIMARY KEY,
  course_id TEXT NOT NULL REFERENCES medication_courses(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK(action IN ('start','adjust','pause','resume','stop')),
  occurred_at TEXT NOT NULL, note TEXT,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  revision INTEGER NOT NULL,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(course_id,revision)
);
CREATE TABLE IF NOT EXISTS medication_intakes (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES health_members(id) ON DELETE CASCADE,
  course_id TEXT REFERENCES medication_courses(id) ON DELETE SET NULL,
  medication_name TEXT NOT NULL, specification TEXT, dosage_form TEXT, route TEXT,
  taken_at TEXT NOT NULL, amount TEXT NOT NULL,
  amount_unit TEXT, note TEXT, revision INTEGER NOT NULL DEFAULT 1,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at TEXT, purge_after TEXT,
  source_report_id TEXT REFERENCES reports(id) ON DELETE SET NULL,
  source_medication_id TEXT,
  source_snapshot_json TEXT CHECK(source_snapshot_json IS NULL OR json_valid(source_snapshot_json)),
  history_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(history_json))
);
CREATE INDEX IF NOT EXISTS medication_intakes_member_idx ON medication_intakes(member_id,taken_at);
CREATE TRIGGER IF NOT EXISTS medication_intake_course_insert BEFORE INSERT ON medication_intakes
WHEN NEW.course_id IS NOT NULL AND NOT EXISTS(
  SELECT 1 FROM medication_courses WHERE id=NEW.course_id AND member_id=NEW.member_id)
BEGIN SELECT RAISE(ABORT,'medication intake must belong to the same member as its course'); END;
CREATE TRIGGER IF NOT EXISTS medication_intake_course_update BEFORE UPDATE OF course_id ON medication_intakes
WHEN NEW.course_id IS NOT NULL AND NOT EXISTS(
  SELECT 1 FROM medication_courses WHERE id=NEW.course_id AND member_id=NEW.member_id)
BEGIN SELECT RAISE(ABORT,'medication intake must belong to the same member as its course'); END;
`;

export const medicationDraftTables = ['medication_courses', 'medication_course_changes',
  'medication_intakes'] as const;
const objects = [
  ...medicationDraftTables, 'medication_courses_member_idx', 'medication_intakes_member_idx',
  'medication_intake_course_insert', 'medication_intake_course_update'
];
const additiveColumns = {
  medication_courses: { specification: 'TEXT', dosage_form: 'TEXT', deleted_at:'TEXT', purge_after:'TEXT' },
  medication_intakes: { specification: 'TEXT', dosage_form: 'TEXT', route: 'TEXT', deleted_at:'TEXT', purge_after:'TEXT',
    source_report_id: 'TEXT REFERENCES reports(id) ON DELETE SET NULL', source_medication_id: 'TEXT',
    source_snapshot_json: 'TEXT CHECK(source_snapshot_json IS NULL OR json_valid(source_snapshot_json))',
    history_json: "TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(history_json))" }
} as const;
export function medicationDraftNeedsRepair(db: DatabaseSync) {
  if (objects.some(name => !db.prepare('SELECT 1 FROM sqlite_master WHERE name=?').get(name))) return true;
  return Object.entries(additiveColumns).some(([table,columns]) => {
    const existing=new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{name:string}>).map(row=>row.name));
    return Object.keys(columns).some(name=>!existing.has(name));
  });
}
export function ensureMedicationDraftSchema(db: DatabaseSync) {
  db.exec('SAVEPOINT medication_draft');
  try {
    db.exec(medicationDraftSchemaSql);
    for(const [table,columns] of Object.entries(additiveColumns)) {
      const existing=new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{name:string}>).map(row=>row.name));
      for(const [column,definition] of Object.entries(columns))if(!existing.has(column))db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
    db.exec('RELEASE medication_draft');
  }
  catch (error) { db.exec('ROLLBACK TO medication_draft'); db.exec('RELEASE medication_draft'); throw error; }
}
