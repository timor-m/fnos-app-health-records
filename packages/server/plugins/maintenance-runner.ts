import { definePlugin } from "nitro";
import { getDatabase, getUnreleasedSchemaMaintenance } from "../database/client";
import { startMaintenanceRunner } from "../services/maintenance-runner.service";
import { getAppConfig } from '../utils/runtime-config';
import { storageMigrationPaused } from '../utils/storage-migration-state';

export default definePlugin(() => {
  if (getAppConfig().storageError || storageMigrationPaused()) return;
  getDatabase();
  // 未发版 schema 维护模式：不启动后台维护任务，等待修复完成
  if (getUnreleasedSchemaMaintenance()) return;
  startMaintenanceRunner();
});
