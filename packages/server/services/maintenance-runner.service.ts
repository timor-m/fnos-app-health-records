import { scheduleMaintenance, maintenanceTick, maintenanceRunning, maintenanceGcFinished, maintenanceFailed } from "../utils/maintenance-state";
import { rollbackAfterError, getDatabase } from "../database/client";
import { getAppConfig } from '../utils/runtime-config';
import { storageMigrationPaused } from '../utils/storage-migration-state';
import { writeLog } from "../utils/logger";
import { purgeExpiredReports, recoverTimedOutDuplicateReportOperations } from "./records.service";
import { runFileGarbageCollection, scanOrphanStorageFiles } from "./file-gc.service";
import {
  activeIndicatorNormalizationVersion,
  backfillBuiltinIndicatorNormalizations
} from "./indicator-normalization.service";
import { startIndicatorNormalizationTaskRunner } from "./indicator-normalization-task.service";
import {
  deriveObservationDisplayAbnormal,
  observationDisplayFlagDerivationVersion,
  parseDictionaryReferenceRange
} from "./observation-interpretation.service";

const maintenanceIntervalMs = 6 * 60 * 60_000;
const orphanScanIntervalMs = 7 * 24 * 60 * 60_000;
const indicatorDictionaryVersionSetting = "maintenance.indicator_normalization_version";
const observationDisplayFlagVersionSetting = "maintenance.observation_display_flag_version";
let startTimer: ReturnType<typeof setTimeout> | null = null;
let intervalTimer: ReturnType<typeof setInterval> | null = null;
let running = false;

function lastOrphanScanAt() {
  const row = getDatabase().prepare(`
    SELECT value_json AS valueJson FROM app_settings WHERE setting_key = 'maintenance.orphan_scan_at'
  `).get() as { valueJson: string } | undefined;
  if (!row) return 0;
  try {
    const value = JSON.parse(row.valueJson);
    return typeof value === "string" ? Date.parse(value) || 0 : 0;
  } catch {
    return 0;
  }
}

function markOrphanScan() {
  getDatabase().prepare(`
    INSERT INTO app_settings (setting_key, value_json, updated_at)
    VALUES ('maintenance.orphan_scan_at', ?, CURRENT_TIMESTAMP)
    ON CONFLICT(setting_key) DO UPDATE SET
      value_json = excluded.value_json,
      updated_at = CURRENT_TIMESTAMP
  `).run(JSON.stringify(new Date().toISOString()));
}

function indicatorDictionaryVersion() {
  const row = getDatabase().prepare(`
    SELECT value_json AS valueJson FROM app_settings WHERE setting_key = ?
  `).get(indicatorDictionaryVersionSetting) as { valueJson: string } | undefined;
  if (!row) return null;
  try {
    const value = JSON.parse(row.valueJson);
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

function markIndicatorDictionaryVersion() {
  const version = activeIndicatorNormalizationVersion();
  getDatabase().prepare(`
    INSERT INTO app_settings (setting_key, value_json, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(setting_key) DO UPDATE SET
      value_json = excluded.value_json,
      updated_at = CURRENT_TIMESTAMP
  `).run(indicatorDictionaryVersionSetting, JSON.stringify(version));
}

export function runIndicatorDictionaryBackfillIfNeeded() {
  const currentVersion = activeIndicatorNormalizationVersion();
  const previousVersion = indicatorDictionaryVersion();
  if (previousVersion === currentVersion) return null;
  const result = backfillBuiltinIndicatorNormalizations();
  markIndicatorDictionaryVersion();
  return { previousVersion, ...result };
}

function storedObservationDisplayFlagVersion() {
  const row = getDatabase().prepare(`
    SELECT value_json AS valueJson FROM app_settings WHERE setting_key = ?
  `).get(observationDisplayFlagVersionSetting) as { valueJson: string } | undefined;
  if (!row) return 0;
  try {
    const value = JSON.parse(row.valueJson);
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

function markObservationDisplayFlagVersion() {
  getDatabase().prepare(`
    INSERT INTO app_settings (setting_key, value_json, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(setting_key) DO UPDATE SET
      value_json = excluded.value_json,
      updated_at = CURRENT_TIMESTAMP
  `).run(observationDisplayFlagVersionSetting, JSON.stringify(observationDisplayFlagDerivationVersion));
}

/* 展示口径异常标记（display_abnormal_flag / abnormal_conflict）在写入期计算，
   这里按派生版本回填存量数据，供报告列表等 SQL 计数与详情页口径保持一致。 */
export function runObservationDisplayFlagBackfillIfNeeded() {
  const previousVersion = storedObservationDisplayFlagVersion();
  if (previousVersion >= observationDisplayFlagDerivationVersion) return null;
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT observations.id, abnormal_flag AS abnormalFlag, result_text AS resultText,
      numeric_value AS numericValue, reference_low AS referenceLow,
      reference_high AS referenceHigh, reference_text AS referenceText,
      evidence_json AS evidenceJson,
      catalog.reference_range_json AS dictionaryReferenceJson
    FROM observations
    LEFT JOIN observation_normalizations normalizations
      ON normalizations.observation_id = observations.id
    LEFT JOIN indicator_catalog catalog
      ON catalog.id = normalizations.indicator_id
  `).all() as Array<{
    id: string;
    abnormalFlag: "high" | "low" | "abnormal" | "normal" | null;
    resultText: string;
    numericValue: number | null;
    referenceLow: number | null;
    referenceHigh: number | null;
    referenceText: string | null;
    evidenceJson: string;
    dictionaryReferenceJson: string | null;
  }>;
  const update = db.prepare(`
    UPDATE observations SET display_abnormal_flag = ?, abnormal_conflict = ? WHERE id = ?
  `);
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const row of rows) {
      let supportingText: Array<string | null> = [];
      try {
        const evidence = JSON.parse(row.evidenceJson) as unknown;
        if (Array.isArray(evidence)) {
          supportingText = evidence.map((entry) =>
            entry && typeof entry === "object"
              ? String((entry as { quote?: unknown }).quote || "") || null
              : null
          );
        }
      } catch {
        supportingText = [];
      }
      const derived = deriveObservationDisplayAbnormal({
        storedFlag: row.abnormalFlag,
        resultText: row.resultText,
        supportingText,
        numericValue: row.numericValue,
        referenceLow: row.referenceLow,
        referenceHigh: row.referenceHigh,
        referenceText: row.referenceText,
        dictionaryReference: parseDictionaryReferenceRange(row.dictionaryReferenceJson)
      });
      update.run(derived.displayAbnormalFlag, derived.abnormalConflict ? 1 : 0, row.id);
    }
    markObservationDisplayFlagVersion();
    db.exec("COMMIT");
  } catch (error) {
    rollbackAfterError(db);
    throw error;
  }
  return { previousVersion, recomputed: rows.length };
}

function duplicateOperationTimeoutMinutes() {
  const value = Number(process.env.REPORT_DUPLICATE_OPERATION_TIMEOUT_MINUTES || 30);
  if (!Number.isFinite(value)) return 30;
  return Math.min(1_440, Math.max(5, Math.round(value)));
}

export async function runMaintenanceCycle() {
  if (running) return { skipped: true as const };
  if (getAppConfig().storageError || storageMigrationPaused()) { maintenanceFailed(); return { skipped: true as const }; }
  running = true;
  maintenanceRunning(true);
  let gcFinished = false;
  try {
    const indicatorNormalization = runIndicatorDictionaryBackfillIfNeeded();
    const observationDisplayFlags = runObservationDisplayFlagBackfillIfNeeded();
    const duplicateOperations = recoverTimedOutDuplicateReportOperations(duplicateOperationTimeoutMinutes());
    const recycleBin = purgeExpiredReports();
    let orphanScan: ReturnType<typeof scanOrphanStorageFiles> | null = null;
    if (Date.now() - lastOrphanScanAt() >= orphanScanIntervalMs) {
      orphanScan = scanOrphanStorageFiles();
      markOrphanScan();
    }
    const fileGc = runFileGarbageCollection();
    gcFinished = true;
    maintenanceGcFinished(Date.now());
    if (indicatorNormalization || observationDisplayFlags || duplicateOperations.recovered || recycleBin.deleted || recycleBin.failed || fileGc.deleted || fileGc.failed || orphanScan?.queued) {
      await writeLog(recycleBin.failed || fileGc.failed ? "warn" : "info", "maintenance cycle completed", {
        indicatorNormalization,
        observationDisplayFlags,
        duplicateOperations,
        recycleBin,
        fileGc,
        orphanScan
      });
    }
    return { skipped: false as const, indicatorNormalization, observationDisplayFlags, duplicateOperations, recycleBin, fileGc, orphanScan };
  } catch (error) {
    if (!gcFinished) maintenanceFailed();
    throw error;
  } finally {
    running = false;
    maintenanceRunning(false);
  }
}

export function startMaintenanceRunner() {
  startIndicatorNormalizationTaskRunner();
  if (startTimer || intervalTimer) return;
  scheduleMaintenance(Date.now(), 15_000, maintenanceIntervalMs);
  startTimer = setTimeout(() => {
    maintenanceTick(true);
    startTimer = null;
    void runMaintenanceCycle().catch((error) => {
      void writeLog("error", "maintenance cycle failed", {
        error: error instanceof Error ? error.message : String(error)
      });
    });
  }, 15_000);
  startTimer.unref?.();
  intervalTimer = setInterval(() => {
    maintenanceTick(false);
    void runMaintenanceCycle().catch((error) => {
      void writeLog("error", "maintenance cycle failed", {
        error: error instanceof Error ? error.message : String(error)
      });
    });
  }, maintenanceIntervalMs);
  intervalTimer.unref?.();
}

export function isStorageMaintenanceActive() { return running; }
