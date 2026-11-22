import { definePlugin } from "nitro";
import { getDatabase, initializeDatabaseForStartup } from "../database/client";
import { ensureCoreDictionaryMaterialized } from "../services/indicator-dictionary.service";
import { getAppConfig } from '../utils/runtime-config';
import { storageMigrationPaused } from '../utils/storage-migration-state';
import { syncBuiltinTrendGroups } from '../services/trend-groups.service';
import {
  backfillLegacyMorphologyFindings,
  rebuildMorphologyTrackingIfNeeded
} from "../services/morphology-finding.service";
import { collapseStoredUnverifiedObservationDuplicates } from "../services/ai-extraction.service";
import { backfillDocumentWideObservationDates, backfillMorphologyExaminationAssignments } from "../services/report-examination-inference.service";

export default definePlugin(() => {
  if (getAppConfig().storageError || storageMigrationPaused()) return;
  // 数据库维护模式下跳过字典物化与历史数据回填。
  if (initializeDatabaseForStartup()) return;
  ensureCoreDictionaryMaterialized();
  syncBuiltinTrendGroups(getDatabase());
  backfillLegacyMorphologyFindings();
  backfillDocumentWideObservationDates();
  collapseStoredUnverifiedObservationDuplicates();
  backfillMorphologyExaminationAssignments();
  rebuildMorphologyTrackingIfNeeded();
});
