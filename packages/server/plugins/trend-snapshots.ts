import { definePlugin } from 'nitro';
import { initializeDatabaseForStartup } from '../database/client';
import { startTrendSnapshotRunner, stopTrendSnapshotRunner } from '../services/trend-snapshot-runner.service';
import { getAppConfig } from '../utils/runtime-config';
import { storageMigrationPaused } from '../utils/storage-migration-state';

export default definePlugin(app => {
  app.hooks.hook('close', stopTrendSnapshotRunner);
  if (getAppConfig().storageError || storageMigrationPaused() || initializeDatabaseForStartup()) return;
  startTrendSnapshotRunner();
});
