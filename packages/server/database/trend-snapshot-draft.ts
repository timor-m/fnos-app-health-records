import type { DatabaseSync } from 'node:sqlite';

// Additive unpublished structure. A release/schema compatibility decision is separate.
const tables = ['trend_snapshot_members', 'trend_snapshot_dirty_reports', 'trend_snapshot_series', 'trend_snapshot_entries', 'trend_snapshot_contributions'];
const requiredColumns: Record<string, string[]> = {
  trend_snapshot_members: ['member_id', 'desired_revision', 'active_revision', 'invalidated', 'full_rebuild', 'algorithm_version', 'lease_token', 'attempts', 'retry_at', 'error_code', 'updated_at'],
  trend_snapshot_dirty_reports: ['member_id', 'report_id', 'revision'],
  trend_snapshot_series: ['member_id', 'series_key', 'content_hash', 'indicator_key', 'unit_key', 'name', 'search_text', 'group_key', 'group_name', 'point_count', 'subgroup_key', 'subgroup_name', 'group_order', 'subgroup_order', 'item_order', 'attention_level', 'attention_priority', 'attention_conflict', 'last_date', 'summary_json', 'chart_json', 'detail_json'],
  trend_snapshot_entries: ['member_id', 'revision', 'series_key', 'content_hash', 'sort_order'],
  trend_snapshot_contributions: ['member_id', 'report_id', 'series_key']
};
const sqlKey = (sql: string) => sql.replace(/IF NOT EXISTS/gi, '').replace(/\s+/g, ' ').trim().replace(/;$/, '');

function dirty(member: string, report: string | null, destructive = false, condition = '1') {
  return `
    INSERT INTO trend_snapshot_members(member_id, desired_revision, invalidated, full_rebuild)
      SELECT id, 1, 1, ${report === null ? 1 : 0} FROM health_members WHERE id = ${member} AND (${condition})
      ON CONFLICT(member_id) DO UPDATE SET
        desired_revision = desired_revision + 1,
        invalidated = MAX(invalidated, ${destructive ? 1 : 0}),
        full_rebuild = MAX(full_rebuild, ${report === null ? 1 : 0}),
        retry_at = 0;
    ${report === null ? '' : `INSERT INTO trend_snapshot_dirty_reports(member_id, report_id, revision)
      SELECT member_id, ${report}, desired_revision FROM trend_snapshot_members WHERE member_id = ${member} AND (${condition})
      ON CONFLICT(member_id, report_id) DO UPDATE SET revision = excluded.revision;`}
  `;
}

function reportDirty(report: string, destructive: boolean, condition = '1') {
  return dirty(`(SELECT member_id FROM reports WHERE id = ${report})`, report, destructive, condition);
}

const triggers: Array<{name: string; sql: string}> = [];
function trigger(name: string, table: string, event: string, body: string) {
  triggers.push({name: `trend_dirty_${name}`, sql: `CREATE TRIGGER IF NOT EXISTS trend_dirty_${name} ${event} ON ${table} BEGIN ${body} END;`});
}

for (const event of ['INSERT', 'UPDATE', 'DELETE']) {
  const row = event === 'DELETE' ? 'OLD' : 'NEW';
  const timing = event === 'DELETE' ? 'BEFORE' : 'AFTER';
  trigger(`report_${event.toLowerCase()}`, 'reports', `${timing} ${event}`,
    dirty(`${row}.member_id`, `${row}.id`, event === 'DELETE')
    + (event === 'UPDATE' ? dirty('OLD.member_id', 'OLD.id', true, "OLD.member_id<>NEW.member_id OR NEW.status='trashed' OR NEW.deleted_at IS NOT NULL") : ''));
  for (const table of ['observations', 'report_pages', 'report_examinations', 'report_structured_sections', 'report_extractions', 'report_field_overrides']) {
    trigger(`${table}_${event.toLowerCase()}`, table, `${timing} ${event}`, reportDirty(`${row}.report_id`, event === 'DELETE')
      + (event === 'UPDATE' ? reportDirty('OLD.report_id', true, 'OLD.report_id<>NEW.report_id') : ''));
  }
  for (const table of ['observation_normalizations', 'observation_examinations', 'observation_field_overrides']) {
    trigger(`${table}_${event.toLowerCase()}`, table, `${timing} ${event}`,
      reportDirty(`(SELECT report_id FROM observations WHERE id = ${row}.observation_id)`, event === 'DELETE'));
  }
  trigger(`ocr_${event.toLowerCase()}`, 'ocr_results', `${timing} ${event}`,
    reportDirty(`(SELECT report_id FROM report_pages WHERE id = ${row}.page_id)`, event === 'DELETE'));
  trigger(`report_decision_${event.toLowerCase()}`, 'report_duplicate_decisions', `${timing} ${event}`,
    reportDirty(`${row}.left_report_id`, event === 'DELETE') + reportDirty(`${row}.right_report_id`, event === 'DELETE'));
  trigger(`exam_decision_${event.toLowerCase()}`, 'examination_duplicate_decisions', `${timing} ${event}`,
    reportDirty(`(SELECT report_id FROM report_examinations WHERE id = ${row}.left_id)`, event === 'DELETE')
    + reportDirty(`(SELECT report_id FROM report_examinations WHERE id = ${row}.right_id)`, event === 'DELETE'));
}
trigger('member_insert', 'health_members', 'AFTER INSERT', dirty('NEW.id', null));
trigger('member_update', 'health_members', 'AFTER UPDATE', dirty('NEW.id', null));
for (const table of ['indicator_catalog', 'indicator_aliases', 'indicator_dictionary_snapshots', 'indicator_taxonomy_groups', 'indicator_taxonomy_subgroups', 'indicator_taxonomy_categories']) {
  for (const event of ['INSERT', 'UPDATE', 'DELETE']) {
    trigger(`${table}_${event.toLowerCase()}`, table, `AFTER ${event}`,
      `UPDATE trend_snapshot_members SET desired_revision=desired_revision+1, full_rebuild=1, retry_at=0;`);
  }
}

export function needsTrendSnapshotDraft(db: DatabaseSync) {
  const definitions = new Map((db.prepare("SELECT name,sql FROM sqlite_master WHERE type IN ('table','trigger')").all() as Array<{name:string;sql:string}>).map(row => [row.name, row.sql]));
  return tables.some(name => {
    if (!definitions.has(name)) return true;
    const columns = new Set((db.prepare(`PRAGMA table_info(${name})`).all() as Array<{name:string}>).map(item => item.name));
    return requiredColumns[name].some(column => !columns.has(column));
  })
    || triggers.some(item => sqlKey(definitions.get(item.name) || '') !== sqlKey(item.sql));
}

export const trendSnapshotSchemaSql = `
    CREATE TABLE IF NOT EXISTS trend_snapshot_members (
      member_id TEXT PRIMARY KEY REFERENCES health_members(id) ON DELETE CASCADE,
      desired_revision INTEGER NOT NULL DEFAULT 1,
      active_revision INTEGER NOT NULL DEFAULT 0,
      invalidated INTEGER NOT NULL DEFAULT 1 CHECK(invalidated IN (0,1)),
      full_rebuild INTEGER NOT NULL DEFAULT 1 CHECK(full_rebuild IN (0,1)),
      algorithm_version TEXT NOT NULL DEFAULT '',
      lease_token TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      retry_at INTEGER NOT NULL DEFAULT 0,
      error_code TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS trend_snapshot_dirty_reports (
      member_id TEXT NOT NULL REFERENCES health_members(id) ON DELETE CASCADE,
      report_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      PRIMARY KEY(member_id,report_id)
    );
    CREATE TABLE IF NOT EXISTS trend_snapshot_series (
      member_id TEXT NOT NULL REFERENCES health_members(id) ON DELETE CASCADE,
      series_key TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      indicator_key TEXT NOT NULL,
      unit_key TEXT NOT NULL,
      name TEXT NOT NULL,
      search_text TEXT NOT NULL,
      group_key TEXT NOT NULL,
      group_name TEXT NOT NULL,
      point_count INTEGER NOT NULL,
      subgroup_key TEXT,
      subgroup_name TEXT,
      group_order INTEGER NOT NULL,
      subgroup_order INTEGER NOT NULL,
      item_order INTEGER NOT NULL,
      attention_level TEXT,
      attention_priority TEXT NOT NULL DEFAULT 'normal',
      attention_conflict INTEGER NOT NULL,
      last_date TEXT,
      summary_json TEXT NOT NULL,
      chart_json TEXT NOT NULL,
      detail_json TEXT NOT NULL,
      PRIMARY KEY(member_id,series_key,content_hash)
    );
    CREATE TABLE IF NOT EXISTS trend_snapshot_entries (
      member_id TEXT NOT NULL REFERENCES health_members(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL,
      series_key TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(member_id,revision,series_key),
      FOREIGN KEY(member_id,series_key,content_hash)
        REFERENCES trend_snapshot_series(member_id,series_key,content_hash)
    );
    CREATE TABLE IF NOT EXISTS trend_snapshot_contributions (
      member_id TEXT NOT NULL REFERENCES health_members(id) ON DELETE CASCADE,
      report_id TEXT NOT NULL,
      series_key TEXT NOT NULL,
      PRIMARY KEY(member_id,report_id,series_key)
    );
    CREATE INDEX IF NOT EXISTS trend_snapshot_query_idx
      ON trend_snapshot_series(member_id,group_order,subgroup_order,item_order,name,series_key);
    INSERT INTO trend_snapshot_members(member_id) SELECT id FROM health_members WHERE 1
      ON CONFLICT(member_id) DO NOTHING;
    ${triggers.map(item => item.sql).join('\n')}
  `;

export function ensureTrendSnapshotDraft(db: DatabaseSync) {
  db.exec(trendSnapshotSchemaSql);
  let extended = false;
  for (const [table, column, definition] of [
    ['trend_snapshot_series', 'attention_priority', "TEXT NOT NULL DEFAULT 'normal'"],
    ['trend_snapshot_series', 'group_name', "TEXT NOT NULL DEFAULT ''"],
    ['trend_snapshot_series', 'point_count', 'INTEGER NOT NULL DEFAULT 0'],
    ['trend_snapshot_series', 'subgroup_key', 'TEXT'],
    ['trend_snapshot_series', 'subgroup_name', 'TEXT'],
    ['trend_snapshot_entries', 'sort_order', 'INTEGER NOT NULL DEFAULT 0']
  ]) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all();
    if (!columns.some(item => item.name === column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
      extended = true;
    }
  }
  if (extended) db.exec('UPDATE trend_snapshot_members SET desired_revision=desired_revision+1,full_rebuild=1,invalidated=1,retry_at=0');
  for (const item of triggers) {
    const current = db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?").get(item.name) as {sql:string} | undefined;
    if (current && sqlKey(current.sql) !== sqlKey(item.sql)) {
      db.exec(`DROP TRIGGER ${item.name}; ${item.sql}`);
    }
  }
  if (needsTrendSnapshotDraft(db)) throw new Error('Unsupported trend snapshot structure');
}
