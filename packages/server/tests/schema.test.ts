import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  closeDatabaseForTests,
  getDatabase,
  getDatabaseStatus,
  getUnreleasedSchemaMaintenance,
  repairUnreleasedSchemaVersions
} from "../database/client.ts";
import { schemaSql, schemaVersion } from "../database/schema.ts";

test("initializes the health records schema with WAL", () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-schema-"));
  process.env.STORAGE_DIR = storageDir;
  try {
    const db = getDatabase();
    const journal = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
    const names = new Set(tables.map((table) => table.name));
    assert.equal(journal.journal_mode, "wal");
    for (const expected of [
      "users", "user_identities", "health_members", "member_permissions", "reports",
      "report_pages", "observations", "processing_jobs", "reminders", "local_accounts",
      "morphology_findings",
      "auth_sessions", "audit_logs", "report_extractions", "processing_job_events", "app_notifications",
      "ai_extraction_units", "ai_extraction_unit_routes", "ai_extraction_attempts", "ai_extraction_candidates",
      "report_diagnoses", "report_medications", "report_procedures",
      "vaccination_records", "billing_summaries", "billing_items", "report_structured_sections",
      "app_upgrade_history", "indicator_catalog", "indicator_aliases", "observation_normalizations",
      "ai_audit_events", "report_field_overrides", "observation_field_overrides", "file_gc_queue", "maintenance_tasks",
      "user_trend_pins", "indicator_dictionary_snapshots", "indicator_dictionary_state",
      "indicator_dictionary_updates", "indicator_taxonomy_groups", "indicator_taxonomy_subgroups",
      "indicator_taxonomy_categories", "indicator_unmatched_names", "indicator_unmatched_occurrences",
      "indicator_governance_decisions", "indicator_governance_history",
      "report_duplicate_decisions", "report_duplicate_history", "report_duplicate_operations"
    ]) {
      assert.equal(names.has(expected), true, `missing table ${expected}`);
    }
    assert.equal(getDatabaseStatus().schemaVersion, schemaVersion);
    assert.equal(getDatabaseStatus().appliedSchemaVersion, schemaVersion);
    assert.equal(getDatabaseStatus().integrity, "ok");
    const migrationRows = db.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get() as { count: number };
    assert.equal(migrationRows.count, schemaVersion);
    const upgrades = db.prepare("SELECT COUNT(*) AS count FROM app_upgrade_history WHERE status = 'completed'").get() as
      { count: number };
    assert.equal(upgrades.count, 1);
    const reportPageColumns = db.prepare("PRAGMA table_info(report_pages)").all() as Array<{ name: string }>;
    assert.equal(reportPageColumns.some((column) => column.name === "source_page_number"), true);
    assert.equal(reportPageColumns.some((column) => column.name === "source_page_count"), true);
    const normalizationColumns = db.prepare("PRAGMA table_info(observation_normalizations)").all() as Array<{ name: string }>;
    assert.equal(normalizationColumns.some((column) => column.name === "canonical_category"), true);
    assert.equal(normalizationColumns.some((column) => column.name === "canonical_explanation"), true);
    for (const columnName of [
      "source_origin", "source_name", "alias_source", "review_status", "reviewed_by", "reviewed_at"
    ]) {
      assert.equal(normalizationColumns.some((column) => column.name === columnName), true, `missing column ${columnName}`);
    }
    const duplicateDecisionColumns = db.prepare("PRAGMA table_info(report_duplicate_decisions)").all() as Array<{ name: string }>;
    const duplicateHistoryColumns = db.prepare("PRAGMA table_info(report_duplicate_history)").all() as Array<{ name: string }>;
    for (const columnName of ["rule_version", "rule_snapshot_json"]) {
      assert.equal(duplicateDecisionColumns.some((column) => column.name === columnName), true, `missing duplicate decision column ${columnName}`);
      assert.equal(duplicateHistoryColumns.some((column) => column.name === columnName), true, `missing duplicate history column ${columnName}`);
    }
    assert.equal(schemaVersion, 17);
    const organizationIndex = db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'index' AND name = 'reports_organization_idx'
    `).get() as { name: string } | undefined;
    assert.equal(organizationIndex?.name, "reports_organization_idx");
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
});

test("migrates an existing v1 database to PDF source page columns", () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-migration-"));
  const databasePath = join(storageDir, "db", "health-records.sqlite");
  mkdirSync(join(storageDir, "db"), { recursive: true });
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(schemaSql
    .replace("  source_page_number INTEGER,\n", "")
    .replace("  source_page_count INTEGER,\n", ""));
  legacy.prepare("INSERT INTO schema_migrations (version) VALUES (1)").run();
  legacy.close();
  process.env.STORAGE_DIR = storageDir;
  try {
    const columns = getDatabase().prepare("PRAGMA table_info(report_pages)").all() as Array<{ name: string }>;
    assert.equal(columns.some((column) => column.name === "source_page_number"), true);
    assert.equal(columns.some((column) => column.name === "source_page_count"), true);
    assert.equal(getDatabaseStatus().schemaVersion, schemaVersion);
    assert.equal(getDatabaseStatus().appliedSchemaVersion, schemaVersion);
    const extractionTable = getDatabase().prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'report_extractions'
    `).get() as { name: string } | undefined;
    assert.equal(extractionTable?.name, "report_extractions");
    const eventTable = getDatabase().prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'processing_job_events'
    `).get() as { name: string } | undefined;
    assert.equal(eventTable?.name, "processing_job_events");
    const notificationTable = getDatabase().prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'app_notifications'
    `).get() as { name: string } | undefined;
    assert.equal(notificationTable?.name, "app_notifications");
    const upgradeTable = getDatabase().prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'app_upgrade_history'
    `).get() as { name: string } | undefined;
    assert.equal(upgradeTable?.name, "app_upgrade_history");
    const aiAuditTable = getDatabase().prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ai_audit_events'
    `).get() as { name: string } | undefined;
    assert.equal(aiAuditTable?.name, "ai_audit_events");
    const overridesTable = getDatabase().prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'report_field_overrides'
    `).get() as { name: string } | undefined;
    assert.equal(overridesTable?.name, "report_field_overrides");
    const observationOverrideColumns = getDatabase().prepare(`
      SELECT name FROM pragma_table_info('observation_field_overrides')
    `).all() as Array<{ name: string }>;
    assert.equal(observationOverrideColumns.some((column) => column.name === "canonical_key"), true);
    const fileGcTable = getDatabase().prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'file_gc_queue'
    `).get() as { name: string } | undefined;
    assert.equal(fileGcTable?.name, "file_gc_queue");
    const maintenanceTaskTable = getDatabase().prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'maintenance_tasks'
    `).get() as { name: string } | undefined;
    assert.equal(maintenanceTaskTable?.name, "maintenance_tasks");
    const trendPinsTable = getDatabase().prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'user_trend_pins'
    `).get() as { name: string } | undefined;
    assert.equal(trendPinsTable?.name, "user_trend_pins");
    const normalizationColumns = getDatabase().prepare("PRAGMA table_info(observation_normalizations)").all() as Array<{ name: string }>;
    assert.equal(normalizationColumns.some((column) => column.name === "canonical_category"), true);
    assert.equal(normalizationColumns.some((column) => column.name === "canonical_explanation"), true);
    for (const columnName of [
      "source_origin", "source_name", "alias_source", "review_status", "reviewed_by", "reviewed_at"
    ]) {
      assert.equal(normalizationColumns.some((column) => column.name === columnName), true, `missing column ${columnName}`);
    }
    assert.equal(schemaVersion, 17);
    const upgrades = getDatabase().prepare("SELECT COUNT(*) AS count FROM app_upgrade_history WHERE status = 'completed'").get() as
      { count: number };
    assert.equal(upgrades.count, 1);
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
});

test("migrates a v12 normalization row through the latest trend metadata schema", () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-migration-v13-"));
  const databasePath = join(storageDir, "db", "health-records.sqlite");
  mkdirSync(join(storageDir, "db"), { recursive: true });
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(schemaSql
    .replace("  canonical_category TEXT,\n", "")
    .replace("  canonical_explanation TEXT,\n", ""));
  for (let version = 1; version <= 12; version += 1) {
    legacy.prepare("INSERT INTO schema_migrations (version) VALUES (?)").run(version);
  }
  legacy.prepare("INSERT INTO users (id, display_name) VALUES ('user-v12', '旧用户')").run();
  legacy.prepare(`
    INSERT INTO health_members (id, display_name, created_by)
    VALUES ('member-v12', '旧成员', 'user-v12')
  `).run();
  legacy.prepare(`
    INSERT INTO reports (id, member_id, created_by, report_type, title, status)
    VALUES ('report-v12', 'member-v12', 'user-v12', 'laboratory', '旧报告', 'ready')
  `).run();
  legacy.prepare(`
    INSERT INTO observations (id, report_id, item_name, result_text, numeric_value, unit)
    VALUES ('observation-v12', 'report-v12', '空腹血糖', '5.2', 5.2, 'mmol/L')
  `).run();
  legacy.prepare(`
    INSERT INTO indicator_catalog (
      id, canonical_key, display_name, category, default_unit, explanation
    ) VALUES (
      'indicator-v12', 'glucose_fasting', '空腹血糖', '血糖', 'mmol/L', '用于观察空腹状态下血糖变化。'
    )
  `).run();
  legacy.prepare(`
    INSERT INTO observation_normalizations (
      observation_id, indicator_id, canonical_key, canonical_name, canonical_value,
      canonical_unit, confidence, quality, matched_by, match_reason, version
    ) VALUES (
      'observation-v12', 'indicator-v12', 'glucose_fasting', '空腹血糖', 5.2,
      'mmol/L', 1, 'high', 'builtin_alias', '旧版整理', 'indicator-normalization-old'
    )
  `).run();
  legacy.close();
  process.env.STORAGE_DIR = storageDir;
  try {
    const row = getDatabase().prepare(`
      SELECT canonical_category AS category, canonical_explanation AS explanation
      FROM observation_normalizations WHERE observation_id = 'observation-v12'
    `).get() as { category: string | null; explanation: string | null };
    assert.equal(row.category, "血糖");
    assert.equal(row.explanation, "用于观察空腹状态下血糖变化。");
    assert.equal(getDatabaseStatus().appliedSchemaVersion, schemaVersion);
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
});

test("migrates a v13 indicator catalog through the latest dictionary schema", () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-migration-v14-"));
  const databasePath = join(storageDir, "db", "health-records.sqlite");
  mkdirSync(join(storageDir, "db"), { recursive: true });
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(schemaSql.replace(
    "  ai_managed INTEGER NOT NULL DEFAULT 0 CHECK (ai_managed IN (0, 1)),\n",
    ""
  ));
  for (let version = 1; version <= 13; version += 1) {
    legacy.prepare("INSERT INTO schema_migrations (version) VALUES (?)").run(version);
  }
  legacy.prepare(`
    INSERT INTO indicator_catalog (
      id, canonical_key, display_name, category, source
    ) VALUES ('indicator-v13', 'legacy_metric', '旧指标', '其他检查', 'user')
  `).run();
  legacy.close();
  process.env.STORAGE_DIR = storageDir;
  try {
    const row = getDatabase().prepare(`
      SELECT ai_managed AS aiManaged
      FROM indicator_catalog WHERE id = 'indicator-v13'
    `).get() as { aiManaged: number };
    assert.equal(row.aiManaged, 0);
    assert.equal(getDatabaseStatus().appliedSchemaVersion, schemaVersion);
    const columns = getDatabase().prepare("PRAGMA table_info(indicator_catalog)").all() as Array<{ name: string }>;
    assert.equal(columns.some((column) => column.name === "dictionary_snapshot_id"), true);
    const dictionaryTable = getDatabase().prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name = 'indicator_dictionary_snapshots'
    `).get();
    assert.ok(dictionaryTable);
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
});

test("migrates a genuine v14 database to the latest materialized dictionary schema", () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-migration-v15-"));
  const databasePath = join(storageDir, "db", "health-records.sqlite");
  mkdirSync(join(storageDir, "db"), { recursive: true });
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(schemaSql);
  legacy.exec(`
    DROP TABLE indicator_unmatched_occurrences;
    DROP TABLE indicator_unmatched_names;
    DROP TABLE indicator_taxonomy_categories;
    DROP TABLE indicator_taxonomy_subgroups;
    DROP TABLE indicator_taxonomy_groups;
    DROP TABLE indicator_dictionary_updates;
    DROP TABLE indicator_dictionary_state;
    DROP TABLE indicator_dictionary_snapshots;
    ALTER TABLE indicator_aliases DROP COLUMN dictionary_snapshot_id;
    ALTER TABLE indicator_aliases DROP COLUMN dictionary_revision;
    ALTER TABLE indicator_aliases DROP COLUMN dictionary_layer;
    ALTER TABLE indicator_catalog DROP COLUMN dictionary_snapshot_id;
    ALTER TABLE indicator_catalog DROP COLUMN dictionary_revision;
    ALTER TABLE indicator_catalog DROP COLUMN dictionary_layer;
    ALTER TABLE indicator_catalog DROP COLUMN section_hints_json;
    ALTER TABLE indicator_catalog DROP COLUMN allowed_units_json;
    ALTER TABLE indicator_catalog DROP COLUMN unit_dimension;
    ALTER TABLE indicator_catalog DROP COLUMN observation_kind;
    ALTER TABLE indicator_catalog DROP COLUMN item_order;
    ALTER TABLE indicator_catalog DROP COLUMN category_key;
  `);
  for (let version = 1; version <= 14; version += 1) {
    legacy.prepare("INSERT INTO schema_migrations (version) VALUES (?)").run(version);
  }
  legacy.prepare(`
    INSERT INTO users (id, display_name, is_gateway_admin)
    VALUES ('user-v14', '旧管理员', 1)
  `).run();
  legacy.prepare(`
    INSERT INTO indicator_catalog (
      id, canonical_key, display_name, category, source, ai_managed
    ) VALUES ('indicator-v14', 'legacy_v14_metric', '旧指标', '其他检查', 'user', 0)
  `).run();
  legacy.prepare(`
    INSERT INTO indicator_aliases (
      id, indicator_id, alias_name, normalized_alias, scope, source, confidence, enabled
    ) VALUES (
      'alias-v14', 'indicator-v14', '旧指标别名', '旧指标别名',
      'global', 'user', 1, 1
    )
  `).run();
  legacy.close();

  process.env.STORAGE_DIR = storageDir;
  try {
    const db = getDatabase();
    assert.equal(getDatabaseStatus().appliedSchemaVersion, schemaVersion);
    const catalogColumns = db.prepare("PRAGMA table_info(indicator_catalog)").all() as Array<{ name: string }>;
    assert.equal(catalogColumns.some((column) => column.name === "dictionary_snapshot_id"), true);
    const aliasColumns = db.prepare("PRAGMA table_info(indicator_aliases)").all() as Array<{ name: string }>;
    assert.equal(aliasColumns.some((column) => column.name === "dictionary_revision"), true);
    const preserved = db.prepare(`
      SELECT catalog.display_name AS displayName, aliases.alias_name AS aliasName
      FROM indicator_catalog catalog
      JOIN indicator_aliases aliases ON aliases.indicator_id = catalog.id
      WHERE catalog.id = 'indicator-v14'
    `).get() as { displayName: string; aliasName: string };
    assert.deepEqual({ ...preserved }, {
      displayName: "旧指标",
      aliasName: "旧指标别名"
    });
    const dictionaryTables = db.prepare(`
      SELECT COUNT(*) AS count
      FROM sqlite_master
      WHERE type = 'table' AND name IN (
        'indicator_dictionary_snapshots',
        'indicator_dictionary_state',
        'indicator_dictionary_updates',
        'indicator_taxonomy_groups',
        'indicator_taxonomy_subgroups',
        'indicator_taxonomy_categories',
        'indicator_unmatched_names',
        'indicator_unmatched_occurrences'
      )
    `).get() as { count: number };
    assert.equal(dictionaryTables.count, 8);
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
});

test("repairs an early v15 dictionary catalog without losing existing rows", () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-migration-v16-repair-"));
  const databasePath = join(storageDir, "db", "health-records.sqlite");
  mkdirSync(join(storageDir, "db"), { recursive: true });
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(schemaSql);
  legacy.exec(`
    ALTER TABLE indicator_aliases DROP COLUMN dictionary_snapshot_id;
    ALTER TABLE indicator_aliases DROP COLUMN dictionary_revision;
    ALTER TABLE indicator_aliases DROP COLUMN dictionary_layer;
    ALTER TABLE indicator_catalog DROP COLUMN dictionary_snapshot_id;
    ALTER TABLE indicator_catalog DROP COLUMN dictionary_revision;
    ALTER TABLE indicator_catalog DROP COLUMN dictionary_layer;
    ALTER TABLE indicator_catalog DROP COLUMN section_hints_json;
    ALTER TABLE indicator_catalog DROP COLUMN allowed_units_json;
    ALTER TABLE indicator_catalog DROP COLUMN unit_dimension;
    ALTER TABLE indicator_catalog DROP COLUMN observation_kind;
    ALTER TABLE indicator_catalog DROP COLUMN item_order;
    ALTER TABLE indicator_catalog DROP COLUMN category_key;
  `);
  for (let version = 1; version <= 15; version += 1) {
    legacy.prepare("INSERT INTO schema_migrations (version) VALUES (?)").run(version);
  }
  legacy.prepare(`
    INSERT INTO indicator_catalog (id, canonical_key, display_name, category)
    VALUES ('early-v15-indicator', 'early_v15_metric', '早期指标', '其他检查')
  `).run();
  legacy.close();

  process.env.STORAGE_DIR = storageDir;
  try {
    const db = getDatabase();
    assert.equal(getDatabaseStatus().appliedSchemaVersion, schemaVersion);
    const columns = db.prepare("PRAGMA table_info(indicator_catalog)").all() as Array<{ name: string }>;
    assert.equal(columns.some((column) => column.name === "category_key"), true);
    assert.equal(columns.some((column) => column.name === "dictionary_snapshot_id"), true);
    const preserved = db.prepare(`
      SELECT display_name AS displayName FROM indicator_catalog WHERE id = 'early-v15-indicator'
    `).get() as { displayName: string };
    assert.equal(preserved.displayName, "早期指标");
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
});

test("upgrades an early v16 database through AI candidate tracking and governance provenance", () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-migration-v16-final-"));
  const databasePath = join(storageDir, "db", "health-records.sqlite");
  mkdirSync(join(storageDir, "db"), { recursive: true });
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(schemaSql);
  legacy.exec("DROP INDEX reports_organization_idx");
  legacy.exec("DROP TABLE morphology_findings");
  legacy.exec("DROP TABLE ai_extraction_unit_routes");
  legacy.exec("DROP TABLE ai_extraction_attempts");
  legacy.exec("DROP TABLE ai_extraction_candidates");
  legacy.exec("DROP TABLE ai_extraction_units");
  legacy.exec("DROP TABLE billing_items");
  legacy.exec("DROP TABLE billing_summaries");
  legacy.exec("DROP TABLE vaccination_records");
  legacy.exec("DROP TABLE report_procedures");
  legacy.exec("DROP TABLE report_medications");
  legacy.exec("DROP TABLE report_structured_sections");
  legacy.exec("DROP TABLE report_duplicate_decisions");
  legacy.exec("DROP TABLE report_duplicate_history");
  legacy.exec("ALTER TABLE report_diagnoses DROP COLUMN manual_fields_json");
  legacy.exec("ALTER TABLE report_diagnoses DROP COLUMN is_deleted");
  for (let version = 1; version <= 16; version += 1) {
    legacy.prepare("INSERT INTO schema_migrations (version) VALUES (?)").run(version);
  }
  legacy.close();

  process.env.STORAGE_DIR = storageDir;
  try {
    const db = getDatabase();
    assert.equal(getDatabaseStatus().appliedSchemaVersion, schemaVersion);
    const tables = db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name IN (
        'morphology_findings', 'ai_extraction_units', 'ai_extraction_unit_routes',
        'ai_extraction_attempts', 'ai_extraction_candidates', 'report_diagnoses', 'report_medications',
        'report_procedures', 'vaccination_records', 'billing_summaries', 'billing_items',
        'report_structured_sections', 'report_duplicate_decisions', 'report_duplicate_history',
        'report_duplicate_operations'
      )
    `).all() as Array<{ name: string }>;
    assert.deepEqual(new Set(tables.map((table) => table.name)), new Set([
      "morphology_findings", "ai_extraction_units", "ai_extraction_unit_routes",
      "ai_extraction_attempts", "ai_extraction_candidates", "report_diagnoses", "report_medications",
      "report_procedures", "vaccination_records", "billing_summaries", "billing_items",
      "report_structured_sections", "report_duplicate_decisions", "report_duplicate_history",
      "report_duplicate_operations"
    ]));
    const organizationIndex = db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'index' AND name = 'reports_organization_idx'
    `).get() as { name: string } | undefined;
    assert.equal(organizationIndex?.name, "reports_organization_idx");
    for (const table of [
      "report_diagnoses", "report_medications", "report_procedures",
      "vaccination_records", "billing_summaries", "billing_items"
    ]) {
      const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      assert.equal(columns.some((column) => column.name === "manual_fields_json"), true);
      assert.equal(columns.some((column) => column.name === "is_deleted"), true);
    }
    const migration = db.prepare(`
      SELECT name, checksum FROM schema_migrations WHERE version = 16
    `).get() as { name: string; checksum: string };
    assert.equal(migration.name, "finalize_indicator_dictionary_morphology_ai_units_and_data_governance");
    assert.match(migration.checksum, /ai-units-data-governance/);
    const migrationCount = db.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get() as { count: number };
    assert.equal(migrationCount.count, schemaVersion);
    const normalizationColumns = db.prepare("PRAGMA table_info(observation_normalizations)").all() as Array<{ name: string }>;
    for (const columnName of [
      "source_origin", "source_name", "alias_source", "review_status", "reviewed_by", "reviewed_at"
    ]) {
      assert.equal(normalizationColumns.some((column) => column.name === columnName), true, `missing column ${columnName}`);
    }
    const decisionColumns = db.prepare("PRAGMA table_info(indicator_governance_decisions)").all() as Array<{ name: string }>;
    assert.equal(decisionColumns.some((column) => column.name === "alias_id"), true);
    const historyTable = db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name = 'indicator_governance_history'
    `).get() as { name: string } | undefined;
    assert.equal(historyTable?.name, "indicator_governance_history");
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
});

test("rejects unreleased v17-v19 metadata until explicitly repaired into the final v16 governance schema", () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-migration-v16-squashed-governance-"));
  const databasePath = join(storageDir, "db", "health-records.sqlite");
  mkdirSync(join(storageDir, "db"), { recursive: true });
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(schemaSql);
  legacy.exec('DROP TABLE institution_trend_projects');
  legacy.exec('DROP TABLE upload_receipts');
  legacy.exec("DROP TABLE indicator_governance_history");
  legacy.exec("DROP TABLE indicator_governance_decisions");
  legacy.exec("DROP TABLE report_duplicate_decisions");
  legacy.exec("DROP TABLE report_duplicate_history");
  for (const columnName of [
    "reviewed_at", "reviewed_by", "review_status", "alias_source", "source_name", "source_origin"
  ]) {
    legacy.exec(`ALTER TABLE observation_normalizations DROP COLUMN ${columnName}`);
  }
  for (let version = 1; version <= 19; version += 1) {
    legacy.prepare("INSERT INTO schema_migrations (version) VALUES (?)").run(version);
  }
  legacy.prepare("INSERT INTO users (id, display_name) VALUES ('user-v17', '旧用户')").run();
  legacy.prepare(`
    INSERT INTO health_members (id, display_name, created_by)
    VALUES ('member-v17', '旧成员', 'user-v17')
  `).run();
  legacy.prepare(`
    INSERT INTO reports (id, member_id, created_by, report_type, title, status)
    VALUES ('report-v17', 'member-v17', 'user-v17', 'laboratory', '旧报告', 'ready')
  `).run();
  const insertObservation = legacy.prepare(`
    INSERT INTO observations (id, report_id, item_name, normalized_name, result_text, numeric_value, unit)
    VALUES (?, 'report-v17', ?, ?, '5.2', 5.2, 'mmol/L')
  `);
  const insertNormalization = legacy.prepare(`
    INSERT INTO observation_normalizations (
      observation_id, canonical_key, canonical_name, canonical_value, canonical_unit,
      confidence, quality, matched_by, match_reason, version
    ) VALUES (?, NULL, NULL, 5.2, 'mmol/L', 0.5, 'low', ?, '旧版整理', 'indicator-normalization-old')
  `);
  for (const row of [
    { id: "v17-ai-name", name: "AI 名称", normalizedName: "空腹血糖", matchedBy: "normalized_name_fallback" },
    { id: "v17-builtin", name: "空腹血糖", normalizedName: "空腹血糖", matchedBy: "builtin_alias" },
    { id: "v17-ai-suggestion", name: "自定义指标", normalizedName: "自定义指标", matchedBy: "ai_suggestion" },
    { id: "v17-none", name: "未知项目", normalizedName: "未知项目", matchedBy: "none" }
  ]) {
    insertObservation.run(row.id, row.name, row.normalizedName);
    insertNormalization.run(row.id, row.matchedBy);
  }
  legacy.close();

  process.env.STORAGE_DIR = storageDir;
  try {
    // 未发版 schema 不再让进程崩溃：应用以维护模式启动，等待维护页显式修复
    getDatabase();
    assert.deepEqual(getUnreleasedSchemaMaintenance(), { databaseVersion: 19, supportedVersion: schemaVersion });
    closeDatabaseForTests();

    const repair = new DatabaseSync(databasePath);
    repair.prepare("DELETE FROM schema_migrations WHERE version > 16 AND version <= 19").run();
    repair.close();

    const db = getDatabase();
    assert.equal(getUnreleasedSchemaMaintenance(), null);
    assert.equal(getDatabaseStatus().appliedSchemaVersion, schemaVersion);
    const migrationCount = db.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get() as { count: number };
    assert.equal(migrationCount.count, schemaVersion);
    const columns = db.prepare("PRAGMA table_info(observation_normalizations)").all() as Array<{ name: string }>;
    for (const columnName of [
      "source_origin", "source_name", "alias_source", "review_status", "reviewed_by", "reviewed_at"
    ]) {
      assert.equal(columns.some((column) => column.name === columnName), true, `missing migrated column ${columnName}`);
    }
    const rows = db.prepare(`
      SELECT observation_id AS observationId, source_origin AS sourceOrigin,
        alias_source AS aliasSource, review_status AS reviewStatus
      FROM observation_normalizations
      WHERE observation_id LIKE 'v17-%'
      ORDER BY observation_id
    `).all() as Array<{
      observationId: string;
      sourceOrigin: string;
      aliasSource: string | null;
      reviewStatus: string;
    }>;
    assert.deepEqual(rows.map((row) => ({ ...row })), [
      { observationId: "v17-ai-name", sourceOrigin: "ai_normalized_name", aliasSource: null, reviewStatus: "unreviewed" },
      { observationId: "v17-ai-suggestion", sourceOrigin: "legacy", aliasSource: "ai_suggestion", reviewStatus: "unreviewed" },
      { observationId: "v17-builtin", sourceOrigin: "legacy", aliasSource: "builtin", reviewStatus: "unreviewed" },
      { observationId: "v17-none", sourceOrigin: "none", aliasSource: null, reviewStatus: "unreviewed" }
    ]);
    const governanceTable = db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name = 'indicator_governance_decisions'
    `).get() as { name: string } | undefined;
    assert.equal(governanceTable?.name, "indicator_governance_decisions");
    const decisionColumns = db.prepare("PRAGMA table_info(indicator_governance_decisions)").all() as Array<{ name: string }>;
    assert.equal(decisionColumns.some((column) => column.name === "alias_id"), true);
    const historyTable = db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name = 'indicator_governance_history'
    `).get() as { name: string } | undefined;
    assert.equal(historyTable?.name, "indicator_governance_history");
    const duplicateGovernanceTables = db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name IN (
        'report_duplicate_decisions', 'report_duplicate_history', 'report_duplicate_operations'
      )
      ORDER BY name
    `).all() as Array<{ name: string }>;
    assert.deepEqual(duplicateGovernanceTables.map((row) => row.name), [
      "report_duplicate_decisions",
      "report_duplicate_history",
      "report_duplicate_operations"
    ]);
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
});

test("repairs unreleased schema from the maintenance page flow with backup and data intact", () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-maintenance-repair-"));
  const databasePath = join(storageDir, "db", "health-records.sqlite");
  mkdirSync(join(storageDir, "db"), { recursive: true });
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(schemaSql);
  legacy.exec('DROP TABLE institution_trend_projects');
  legacy.exec('DROP TABLE upload_receipts');
  for (let version = 1; version <= 19; version += 1) {
    legacy.prepare("INSERT INTO schema_migrations (version) VALUES (?)").run(version);
  }
  legacy.prepare("INSERT INTO users (id, display_name) VALUES ('user-keep', '保留用户')").run();
  legacy.close();

  process.env.STORAGE_DIR = storageDir;
  try {
    getDatabase();
    assert.deepEqual(getUnreleasedSchemaMaintenance(), { databaseVersion: 19, supportedVersion: schemaVersion });

    const result = repairUnreleasedSchemaVersions();
    assert.equal(result.fromVersion, 19);
    assert.equal(result.toVersion, schemaVersion);
    assert.ok(result.backupPath && existsSync(result.backupPath), "修复前必须生成数据库备份");

    assert.equal(getUnreleasedSchemaMaintenance(), null);
    assert.equal(getDatabaseStatus().appliedSchemaVersion, schemaVersion);
    const kept = getDatabase()
      .prepare("SELECT display_name AS name FROM users WHERE id = 'user-keep'")
      .get() as { name: string } | undefined;
    assert.equal(kept?.name, "保留用户");
    const backups = readdirSync(join(storageDir, "backups", "db"));
    assert.equal(backups.length, 2);

    // 重复调用必须报错，不允许修复正常数据库
    assert.throws(() => repairUnreleasedSchemaVersions(), /不需要未发版 schema 修复/);
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
});

test("repairs an already-recorded v16 duplicate governance schema without creating v17", () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-v16-duplicate-rule-repair-"));
  const databasePath = join(storageDir, "db", "health-records.sqlite");
  mkdirSync(join(storageDir, "db"), { recursive: true });
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(schemaSql);
  legacy.exec(`
    ALTER TABLE report_duplicate_decisions DROP COLUMN rule_snapshot_json;
    ALTER TABLE report_duplicate_decisions DROP COLUMN rule_version;
    ALTER TABLE report_duplicate_history DROP COLUMN rule_snapshot_json;
    ALTER TABLE report_duplicate_history DROP COLUMN rule_version;
  `);
  for (let version = 1; version <= 16; version += 1) {
    legacy.prepare("INSERT INTO schema_migrations (version) VALUES (?)").run(version);
  }
  legacy.close();

  process.env.STORAGE_DIR = storageDir;
  try {
    const db = getDatabase();
    assert.equal(getDatabaseStatus().appliedSchemaVersion, schemaVersion);
    const migrationCount = db.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get() as { count: number };
    assert.equal(migrationCount.count, schemaVersion);
    for (const tableName of ["report_duplicate_decisions", "report_duplicate_history"]) {
      const columns = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
      assert.equal(columns.some((column) => column.name === "rule_version"), true);
      assert.equal(columns.some((column) => column.name === "rule_snapshot_json"), true);
    }
    const cacheTable = db.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'report_duplicate_pair_cache'
    `).get() as { name: string } | undefined;
    assert.equal(cacheTable, undefined);
    const operationTable = db.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'report_duplicate_operations'
    `).get() as { name: string } | undefined;
    assert.equal(operationTable?.name, "report_duplicate_operations");
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
});

test("repairs report-type enum values persisted as body parts on the current schema", () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-v16-report-metadata-repair-"));
  const databasePath = join(storageDir, "db", "health-records.sqlite");
  mkdirSync(join(storageDir, "db"), { recursive: true });
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(schemaSql);
  for (let version = 1; version <= schemaVersion; version += 1) {
    legacy.prepare("INSERT INTO schema_migrations (version) VALUES (?)").run(version);
  }
  legacy.prepare("INSERT INTO users (id, display_name) VALUES ('legacy-user', '旧用户')").run();
  legacy.prepare(`
    INSERT INTO health_members (id, display_name, created_by)
    VALUES ('legacy-member', '本人', 'legacy-user')
  `).run();
  legacy.prepare(`
    INSERT INTO reports (
      id, member_id, created_by, report_type, report_subtype, title, status, body_parts_json
    ) VALUES (
      'legacy-checkup', 'legacy-member', 'legacy-user', 'checkup', 'checkup',
      '个人健康体检报告', 'ready',
      '[{"raw":"checkup","name":"checkup","parent":null,"laterality":"unspecified"}]'
    )
  `).run();
  legacy.close();

  process.env.STORAGE_DIR = storageDir;
  try {
    const db = getDatabase();
    const row = db.prepare(`
      SELECT report_subtype AS reportSubtype, body_parts_json AS bodyPartsJson
      FROM reports WHERE id = 'legacy-checkup'
    `).get() as { reportSubtype: string | null; bodyPartsJson: string };
    assert.equal(row.reportSubtype, null);
    assert.deepEqual(JSON.parse(row.bodyPartsJson), [{
      raw: "综合体检",
      name: "综合体检",
      parent: null,
      laterality: "unspecified"
    }]);
    assert.equal(getDatabaseStatus().appliedSchemaVersion, schemaVersion);
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
});

test("repairs incompatible AI report sections without removing manual content", () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-v16-section-repair-"));
  const databasePath = join(storageDir, "db", "health-records.sqlite");
  mkdirSync(join(storageDir, "db"), { recursive: true });
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(schemaSql);
  for (let version = 1; version <= schemaVersion; version += 1) {
    legacy.prepare("INSERT INTO schema_migrations (version) VALUES (?)").run(version);
  }
  legacy.exec(`
    INSERT INTO users (id, display_name) VALUES ('legacy-user', '旧用户');
    INSERT INTO health_members (id, display_name, created_by)
      VALUES ('legacy-member', '本人', 'legacy-user');
    INSERT INTO reports (id, member_id, created_by, report_type, title, status)
      VALUES ('legacy-checkup', 'legacy-member', 'legacy-user', 'checkup', '体检报告', 'ready');
    INSERT INTO report_structured_sections (
      id, report_id, section_key, section_title, content_text, source, manual_fields_json
    ) VALUES
      ('ai-outpatient', 'legacy-checkup', 'outpatient_history', '病史', '主诉 | 无特殊', 'ai', '[]'),
      ('manual-outpatient', 'legacy-checkup', 'outpatient_history', '人工病史', '用户确认内容', 'manual', '["*"]'),
      ('ai-checkup', 'legacy-checkup', 'checkup_final_conclusion', '总检结论', '体检完成', 'ai', '[]');
  `);
  legacy.close();

  process.env.STORAGE_DIR = storageDir;
  try {
    const db = getDatabase();
    const rows = db.prepare(`
      SELECT id, source FROM report_structured_sections ORDER BY id
    `).all() as Array<{ id: string; source: string }>;
    assert.deepEqual(rows.map((row) => ({ ...row })), [
      { id: "ai-checkup", source: "ai" },
      { id: "manual-outpatient", source: "manual" }
    ]);
    assert.equal(getDatabaseStatus().appliedSchemaVersion, schemaVersion);
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
});
