import { ensurePageAppendDraft } from "./page-append-draft";
import { ensureMemberSharingDraft } from "./member-sharing-draft";
import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createError } from 'h3';
import { getAppConfig } from "../utils/runtime-config";
import {
  databaseMigrations,
  ensureClinicalFactColumns,
  ensureIndicatorDictionaryColumns,
  ensureIndicatorGovernanceSchema,
  ensureLocalAccountColumns,
  ensureMemberBloodTypeColumns,
  ensureObservationDisplayFlagColumns,
  ensureObservationFieldOverrideSchema,
  ensureOcrCoordSpaceColumns,
  ensureReportDuplicateGovernanceSchema,
  repairIncompatibleAiReportSections,
  repairReportDisplayMetadata,
  tableColumnNames
} from "./migrations";
import { schemaSql, schemaVersion } from "./schema";

let database: DatabaseSync | null = null;
let openedDatabasePath: string | null = null;

const countedTables = [
  "users",
  "health_members",
  "reports",
  "report_pages",
  "observations",
  "morphology_findings",
  "report_diagnoses",
  "report_medications",
  "report_procedures",
  "vaccination_records",
  "billing_summaries",
  "billing_items",
  "report_structured_sections",
  "processing_jobs",
  "processing_job_events",
  "ai_audit_events",
  "ocr_results",
  "report_extractions",
  "ai_extraction_units",
  "ai_extraction_unit_routes",
  "ai_extraction_attempts",
  "ai_extraction_candidates",
  "report_field_overrides",
  "observation_field_overrides",
  "reminders",
  "app_notifications",
  "app_upgrade_history",
  "audit_logs"
] as const;

function ensureStorageDirectories(storageDir: string) {
  for (const directory of ["db", "reports", "thumbnails", "backups", "logs", "models", "secrets", "config"]) {
    mkdirSync(join(storageDir, directory), { recursive: true });
  }
}

function tableExists(db: DatabaseSync, tableName: string) {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName) as
    | { name: string }
    | undefined;
  return Boolean(row);
}

function isFreshDatabase(db: DatabaseSync) {
  const row = db.prepare(`
    SELECT COUNT(*) AS count
    FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
  `).get() as { count: number };
  return row.count === 0;
}

function ensureMigrationMetadataColumns(db: DatabaseSync) {
  const columns = tableColumnNames(db, "schema_migrations");
  if (!columns.has("name")) db.exec("ALTER TABLE schema_migrations ADD COLUMN name TEXT NOT NULL DEFAULT ''");
  if (!columns.has("checksum")) db.exec("ALTER TABLE schema_migrations ADD COLUMN checksum TEXT NOT NULL DEFAULT ''");
  if (!columns.has("elapsed_ms")) db.exec("ALTER TABLE schema_migrations ADD COLUMN elapsed_ms INTEGER NOT NULL DEFAULT 0");
}

function appliedSchemaVersion(db: DatabaseSync) {
  const current = db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as
    | { version: number | null }
    | undefined;
  return current?.version ?? 0;
}

function isUnreleasedSchemaVersion(db: DatabaseSync, currentVersion: number) {
  if (currentVersion <= 16 || currentVersion > 19) return false;
  if (currentVersion <= schemaVersion && tableExists(db, "institution_trend_projects")) return false;
  // Distinguish older development drafts from the institution-project test migration.
  const columns = db.prepare("PRAGMA table_info(schema_migrations)").all() as Array<{ name: string }>;
  const marker = columns.some(column => column.name === "checksum")
    ? db.prepare("SELECT checksum FROM schema_migrations WHERE version = 17").get() as { checksum: string } | undefined
    : undefined;
  return marker?.checksum !== "manual:017-institution-trend-projects";
}

/**
 * v17-v19 只存在于发版前的开发过程，已折叠回 v16。
 * 检测到这些版本时不再让进程崩溃：应用以维护模式启动，
 * 由维护页引导用户显式确认修复（自动备份），修复后无需重启。
 */
let unreleasedSchemaVersion: number | null = null;

export function getUnreleasedSchemaMaintenance() {
  return unreleasedSchemaVersion
    ? { databaseVersion: unreleasedSchemaVersion, supportedVersion: schemaVersion }
    : null;
}

function recordMigration(db: DatabaseSync, version: number, elapsedMs: number) {
  const migration = databaseMigrations.find((item) => item.version === version);
  if (!migration) throw new Error(`Missing database migration metadata for schema v${version}.`);
  db.prepare(`
    INSERT INTO schema_migrations (version, name, checksum, elapsed_ms)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(version) DO UPDATE SET
      name = excluded.name,
      checksum = excluded.checksum
  `).run(migration.version, migration.name, migration.checksum, elapsedMs);
}

function backfillAppliedMigrationRows(db: DatabaseSync, currentVersion: number) {
  for (const migration of databaseMigrations.filter((item) => item.version <= currentVersion)) {
    recordMigration(db, migration.version, 0);
  }
}

function sqlString(value: string) {
  return `'${value.replaceAll("'", "''")}'`;
}

function backupDatabaseBeforeMigration(db: DatabaseSync, storageDir: string, databasePath: string, fromVersion: number, toVersion: number) {
  if (!existsSync(databasePath)) return null;
  const backupDir = join(storageDir, "backups", "db");
  mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
  const backupPath = join(backupDir, `pre-migration-v${fromVersion}-to-v${toVersion}-${stamp}.sqlite`);
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  try {
    db.exec(`VACUUM INTO ${sqlString(backupPath)}`);
  } catch {
    copyFileSync(databasePath, backupPath);
  }
  return backupPath;
}

function readJsonSetting<T>(db: DatabaseSync, key: string): T | null {
  if (!tableExists(db, "app_settings")) return null;
  const row = db.prepare("SELECT value_json AS valueJson FROM app_settings WHERE setting_key = ?").get(key) as
    | { valueJson: string }
    | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.valueJson) as T;
  } catch {
    return null;
  }
}

function writeJsonSetting(db: DatabaseSync, key: string, value: unknown) {
  db.prepare(`
    INSERT INTO app_settings (setting_key, value_json, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(setting_key) DO UPDATE SET
      value_json = excluded.value_json,
      updated_at = CURRENT_TIMESTAMP
  `).run(key, JSON.stringify(value));
}

function beginUpgradeHistory(db: DatabaseSync, fromAppVersion: string | null, toAppVersion: string, fromSchemaVersion: number) {
  const id = randomUUID();
  db.prepare(`
    INSERT INTO app_upgrade_history (
      id, from_app_version, to_app_version, from_schema_version, to_schema_version, status
    ) VALUES (?, ?, ?, ?, ?, 'started')
  `).run(id, fromAppVersion, toAppVersion, fromSchemaVersion, schemaVersion);
  return id;
}

function completeUpgradeHistory(db: DatabaseSync, id: string) {
  db.prepare(`
    UPDATE app_upgrade_history
    SET status = 'completed', finished_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(id);
}

function failUpgradeHistory(db: DatabaseSync, id: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  db.prepare(`
    UPDATE app_upgrade_history
    SET status = 'failed', message = ?, finished_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(message.slice(0, 1000), id);
}

// Only for failure cleanup: SQLite may already have rolled back (e.g. SQLITE_FULL).
// Callers still rethrow the original error after completing their other cleanup.
export function rollbackAfterError(db: DatabaseSync) {
  try {
    db.exec("ROLLBACK");
  } catch {
    // A secondary rollback failure must not replace the original error.
  }
}

export function runInTransaction(db: DatabaseSync, action: () => void) {
  db.exec("BEGIN IMMEDIATE");
  try {
    action();
    db.exec("COMMIT");
  } catch (error) {
    rollbackAfterError(db);
    throw error;
  }
}

function migrate(db: DatabaseSync, storageDir: string, databasePath: string) {
  const { appVersion } = getAppConfig();
  if (isFreshDatabase(db)) {
    db.exec(schemaSql);
    ensureClinicalFactColumns(db);
    ensureIndicatorDictionaryColumns(db);
    ensureMemberBloodTypeColumns(db);
    ensureObservationDisplayFlagColumns(db);
    ensureIndicatorGovernanceSchema(db);
    ensureLocalAccountColumns(db);
    ensureMemberSharingDraft(db);
    ensurePageAppendDraft(db);
    ensureObservationFieldOverrideSchema(db);
    ensureOcrCoordSpaceColumns(db);
    ensureReportDuplicateGovernanceSchema(db);
    repairReportDisplayMetadata(db);
    repairIncompatibleAiReportSections(db);
    ensureMigrationMetadataColumns(db);
    const upgradeId = beginUpgradeHistory(db, null, appVersion, 0);
    for (const migration of databaseMigrations) recordMigration(db, migration.version, 0);
    writeJsonSetting(db, "system.last_app_version", appVersion);
    completeUpgradeHistory(db, upgradeId);
    return;
  }

  const hasMigrationTable = tableExists(db, "schema_migrations");
  let currentVersion = hasMigrationTable ? appliedSchemaVersion(db) : 0;
  if (hasMigrationTable && isUnreleasedSchemaVersion(db, currentVersion)) {
    unreleasedSchemaVersion = currentVersion;
    return;
  }
  if (currentVersion === 0 && tableExists(db, "reports")) {
    currentVersion = 1;
  }
  if (currentVersion > schemaVersion) {
    throw new Error(`Database schema v${currentVersion} is newer than this app supports (v${schemaVersion}).`);
  }

  const pendingMigrations = databaseMigrations.filter((migration) => migration.version > currentVersion);
  // Complete older v17 test drafts without renumbering their existing records.
  if (!tableExists(db, "report_page_appends") || !tableColumnNames(db,"report_page_appends").has("confirmation_hash") || !tableColumnNames(db,"report_page_appends").has("input_hash") || !tableColumnNames(db,"report_page_append_files").has("error_message") || !tableExists(db, "file_gc_members") || !tableColumnNames(db, "member_permissions").has("can_manage_sharing") || pendingMigrations.length || !tableExists(db, "indicator_groups") || !tableExists(db, "indicator_group_members") || !tableExists(db, "report_notes") || !tableExists(db, "report_note_assets") || !tableExists(db, "upload_receipts")
    || !tableExists(db, "institution_trend_auto_rules") || !tableExists(db, "institution_trend_auto_decisions")) {
    backupDatabaseBeforeMigration(db, storageDir, databasePath, currentVersion, schemaVersion);
  }

  if (!hasMigrationTable) {
    db.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
  }
  ensureMigrationMetadataColumns(db);
  backfillAppliedMigrationRows(db, currentVersion);

  const lastAppVersion = readJsonSetting<string>(db, "system.last_app_version");
  const needsUpgradeRecord = pendingMigrations.length > 0 || lastAppVersion !== appVersion;
  let upgradeId = needsUpgradeRecord && tableExists(db, "app_upgrade_history")
    ? beginUpgradeHistory(db, lastAppVersion, appVersion, currentVersion)
    : null;

  try {
    for (const migration of pendingMigrations) {
      const started = Date.now();
      runInTransaction(db, () => {
        migration.up(db);
        recordMigration(db, migration.version, Date.now() - started);
      });
    }
    db.exec(schemaSql);
    ensureClinicalFactColumns(db);
    ensureIndicatorDictionaryColumns(db);
    ensureMemberBloodTypeColumns(db);
    ensureObservationDisplayFlagColumns(db);
    ensureIndicatorGovernanceSchema(db);
    ensureLocalAccountColumns(db);
    ensureMemberSharingDraft(db);
    ensurePageAppendDraft(db);
    ensureObservationFieldOverrideSchema(db);
    ensureOcrCoordSpaceColumns(db);
    ensureReportDuplicateGovernanceSchema(db);
    repairReportDisplayMetadata(db);
    repairIncompatibleAiReportSections(db);
    ensureMigrationMetadataColumns(db);
    if (needsUpgradeRecord && !upgradeId && tableExists(db, "app_upgrade_history")) {
      upgradeId = beginUpgradeHistory(db, lastAppVersion, appVersion, currentVersion);
    }
    writeJsonSetting(db, "system.last_app_version", appVersion);
    if (upgradeId) completeUpgradeHistory(db, upgradeId);
  } catch (error) {
    try {
      if (upgradeId) failUpgradeHistory(db, upgradeId, error);
    } catch {
      // Storage failures can also prevent recording the failed upgrade.
    }
    throw error;
  }
}

export function getDatabase() {
  const config = getAppConfig();
  if (config.storageError) {
    closeDatabase();
    throw createError({ statusCode: 503, data: { code: "STORAGE_UNAVAILABLE" }, statusMessage: config.storageError });
  }
  const requestedPath = resolve(config.storageDir, 'db', 'health-records.sqlite');
  if (database) {
    if (openedDatabasePath !== requestedPath) {
      throw createError({ statusCode: 503, data: { code: "STORAGE_UNAVAILABLE" }, statusMessage: '档案目录已变化，数据库尚未完成安全切换，已暂停访问。请通过迁移流程关闭旧连接后重新打开。' });
    }
    return database;
  }
  const { storageDir } = config;
  ensureStorageDirectories(storageDir);
  const databasePath = join(storageDir, "db", "health-records.sqlite");
  mkdirSync(dirname(databasePath), { recursive: true });
  const opened = new DatabaseSync(databasePath);
  try {
    opened.exec("PRAGMA foreign_keys = ON");
    opened.exec("PRAGMA journal_mode = WAL");
    opened.exec("PRAGMA busy_timeout = 5000");
    migrate(opened, storageDir, databasePath);
  } catch (error) {
    unreleasedSchemaVersion = null;
    try { opened.close(); } catch { /* Preserve the initialization failure. */ }
    throw error;
  }
  database = opened;
  openedDatabasePath = requestedPath;
  return database;
}

export function getDatabasePath() {
  return join(getAppConfig().storageDir, "db", "health-records.sqlite");
}

/**
 * 维护页触发的显式修复：备份后删除未发版迁移记录（v17-v19），
 * 折叠回当前支持的 schema 并补齐幂等结构，无需重启进程。
 */
export function repairUnreleasedSchemaVersions() {
  if (!unreleasedSchemaVersion || !database) {
    throw new Error("当前数据库不需要未发版 schema 修复");
  }
  const { storageDir } = getAppConfig();
  const databasePath = getDatabasePath();
  const fromVersion = unreleasedSchemaVersion;
  const backupPath = backupDatabaseBeforeMigration(database, storageDir, databasePath, fromVersion, schemaVersion);
  database.prepare("DELETE FROM schema_migrations WHERE version > 16 AND version <= 19").run();
  unreleasedSchemaVersion = null;
  try {
    migrate(database, storageDir, databasePath);
  } catch (error) {
    try { closeDatabase(); } catch { /* Preserve the repair failure. */ }
    throw error;
  }
  return { fromVersion, toVersion: schemaVersion, backupPath };
}

export function checkpointDatabase() {
  getDatabase().exec("PRAGMA wal_checkpoint(TRUNCATE)");
}

export function getDatabaseStatus() {
  const databasePath = getDatabasePath();
  const db = getDatabase();
  const integrity = db.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
  const journal = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
  const pageSize = db.prepare("PRAGMA page_size").get() as { page_size: number };
  const pageCount = db.prepare("PRAGMA page_count").get() as { page_count: number };
  const freelistCount = db.prepare("PRAGMA freelist_count").get() as { freelist_count: number };
  const migration = db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as
    | { version: number | null }
    | undefined;
  const rowCounts = Object.fromEntries(countedTables.map((table) => {
    const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
    return [table, row.count];
  }));
  const databaseSizeBytes = existsSync(databasePath) ? statSync(databasePath).size : 0;
  const walPath = `${databasePath}-wal`;
  const shmPath = `${databasePath}-shm`;
  const walSizeBytes = existsSync(walPath) ? statSync(walPath).size : 0;
  const shmSizeBytes = existsSync(shmPath) ? statSync(shmPath).size : 0;
  return {
    driver: "node:sqlite",
    path: databasePath,
    integrity: integrity.integrity_check,
    schemaVersion,
    appliedSchemaVersion: migration?.version ?? 0,
    journalMode: journal.journal_mode,
    pageSize: pageSize.page_size,
    pageCount: pageCount.page_count,
    freelistCount: freelistCount.freelist_count,
    usedPageCount: Math.max(0, pageCount.page_count - freelistCount.freelist_count),
    databaseSizeBytes,
    walSizeBytes,
    shmSizeBytes,
    totalSizeBytes: databaseSizeBytes + walSizeBytes + shmSizeBytes,
    rowCounts
  };
}

export function closeDatabase() {
  const closing = database;
  database = null;
  openedDatabasePath = null;
  unreleasedSchemaVersion = null;
  closing?.close();
}

export function closeDatabaseForTests() {
  closeDatabase();
}

/** Upgrade an extracted backup before switching the live database. Never changes the cached connection. */
export function prepareRestoredDatabase(databasePath: string) {
  const staged = new DatabaseSync(databasePath);
  const previousMaintenance = unreleasedSchemaVersion;
  try {
    staged.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000');
    migrate(staged, getAppConfig().storageDir, databasePath);
    if (unreleasedSchemaVersion !== previousMaintenance) throw new Error('备份包含待确认的历史 schema 草案，请先在独立副本中完成适配');
    if ((staged.prepare('PRAGMA integrity_check').get() as {integrity_check:string}).integrity_check !== 'ok' || staged.prepare('PRAGMA foreign_key_check').all().length) throw new Error('备份数据库完整性校验失败');
    return staged;
  } catch(error) { staged.close(); throw error; }
  finally { unreleasedSchemaVersion=previousMaintenance; }
}
