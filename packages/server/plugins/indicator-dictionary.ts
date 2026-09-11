import { definePlugin } from "nitro";
import { getDatabase, getUnreleasedSchemaMaintenance } from "../database/client";
import { ensureCoreDictionaryMaterialized } from "../services/indicator-dictionary.service";
import { getAppConfig } from '../utils/runtime-config';
import { storageMigrationPaused } from '../utils/storage-migration-state';
import {
  backfillLegacyMorphologyFindings,
  rebuildMorphologyTrackingIfNeeded
} from "../services/morphology-finding.service";

export default definePlugin(() => {
  if (getAppConfig().storageError || storageMigrationPaused()) return;
  getDatabase();
  // 未发版 schema 维护模式：跳过字典物化与形态学回填，等待维护页修复后再初始化
  if (getUnreleasedSchemaMaintenance()) return;
  ensureCoreDictionaryMaterialized();
  backfillLegacyMorphologyFindings();
  rebuildMorphologyTrackingIfNeeded();
});
