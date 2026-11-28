import { definePlugin } from 'nitro';
import { getDatabase, initializeDatabaseForStartup } from '../database/client';
import { resolveFeedbackAppsIdentity } from '../services/feedback-installation.service';
import { syncFeedbackUpdates } from '../services/feedback-sync.service';
import { getAppConfig } from '../utils/runtime-config';
import { storageMigrationPaused } from '../utils/storage-migration-state';

export default definePlugin(() => {
  try {
    if (getAppConfig().storageError || storageMigrationPaused()) return;
    if (initializeDatabaseForStartup()) return;
    const db = getDatabase();
    // fnOS with TRIM_SYS_MACHINE_ID skips creating a local x-client-id; Docker still ensures one.
    resolveFeedbackAppsIdentity(db);
    // Startup feedback is optional: consume failures without UI errors or logs.
    void syncFeedbackUpdates(db).catch(() => {});
  } catch {
    // Initialization failures are silent too; core application startup owns its diagnostics.
  }
});
