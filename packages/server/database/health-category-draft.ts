import type { DatabaseSync } from 'node:sqlite';
/** Unreleased five-category feature. Independent actual vaccinations may have no document. */
export const healthCategorySchemaSql = `
CREATE TABLE IF NOT EXISTS health_vaccinations (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES health_members(id) ON DELETE CASCADE,
  vaccine_name TEXT NOT NULL CHECK(length(trim(vaccine_name))>0),
  dose_number TEXT, administered_at TEXT NOT NULL,
  organization_name TEXT, manufacturer TEXT, lot_number TEXT, administration_site TEXT, note TEXT,
  next_due_at TEXT, reminder_id TEXT REFERENCES reminders(id) ON DELETE SET NULL,
  completed_reminder_id TEXT REFERENCES reminders(id) ON DELETE SET NULL,
  source_report_id TEXT REFERENCES reports(id) ON DELETE SET NULL,
  source_fact_id TEXT,
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0),
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, deleted_at TEXT,
  purge_after TEXT, trash_state_json TEXT
);
CREATE INDEX IF NOT EXISTS health_vaccinations_member_date_idx ON health_vaccinations(member_id,deleted_at,administered_at DESC,id);
CREATE UNIQUE INDEX IF NOT EXISTS health_vaccinations_source_idx ON health_vaccinations(member_id,source_report_id,source_fact_id) WHERE deleted_at IS NULL AND source_fact_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS health_vaccinations_completed_reminder_idx ON health_vaccinations(completed_reminder_id) WHERE deleted_at IS NULL AND completed_reminder_id IS NOT NULL;
`;
export function healthCategoryNeedsRepair(db: DatabaseSync) {
  return !db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='health_vaccinations'").get()
    || !db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='health_vaccinations_member_date_idx'").get()
    || !db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='health_vaccinations_source_idx'").get()
    || !db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='health_vaccinations_completed_reminder_idx'").get()
    || !db.prepare('PRAGMA table_info(health_vaccinations)').all().some(column=>column.name==='reminder_id')
    || !db.prepare('PRAGMA table_info(health_vaccinations)').all().some(column=>column.name==='completed_reminder_id')
    || !db.prepare('PRAGMA table_info(health_vaccinations)').all().some(column=>column.name==='purge_after')
    || !db.prepare('PRAGMA table_info(health_vaccinations)').all().some(column=>column.name==='trash_state_json');
}

/** Complete the current draft in place after the startup backup; never renumber or clear data. */
export function ensureHealthCategoryColumns(db:DatabaseSync){
 if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='health_vaccinations'").get())return;
 const columns=new Set(db.prepare('PRAGMA table_info(health_vaccinations)').all().map(row=>row.name));
 for(const name of ['reminder_id','completed_reminder_id'])if(!columns.has(name))db.exec(`ALTER TABLE health_vaccinations ADD COLUMN ${name} TEXT REFERENCES reminders(id) ON DELETE SET NULL`);
 for(const name of ['purge_after','trash_state_json'])if(!columns.has(name))db.exec(`ALTER TABLE health_vaccinations ADD COLUMN ${name} TEXT`);
}
