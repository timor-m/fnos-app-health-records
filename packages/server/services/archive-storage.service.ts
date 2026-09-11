import { access, statfs } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createError } from 'h3';
import { isAdministrator, type RequestUser } from '../domain/request-user';
import { getAppConfig } from '../utils/runtime-config';
import { listLocalImportRoots } from './local-file-import.service';
import { getStorageMigration } from './storage-migration.service';
import { storageMigrationPaused } from '../utils/storage-migration-state';

/** Settings inspection must not create directories, markers, databases or migration tasks. */
export async function getArchiveStorageStatus(user: RequestUser) {
  if (!user.authenticated || !isAdministrator(user)) {
    throw createError({ statusCode: 403, statusMessage: '仅管理员可查看档案存储设置' });
  }
  const config = getAppConfig();
  if (!['fnos', 'development'].includes(config.authMode)) {
    throw createError({ statusCode: 404, statusMessage: '此部署不提供档案存储设置' });
  }
  let availableBytes: number | null = null;
  let capacityBytes: number | null = null;
  let error = config.storageError;
  try {
    await access(config.storageDir, constants.R_OK | constants.W_OK | constants.X_OK);
  } catch {
    error ||= '当前目录不可访问，请检查存储空间和应用读写权限。';
  }
  try {
    const filesystem = await statfs(config.storageDir);
    availableBytes = filesystem.bavail * filesystem.bsize;
    capacityBytes = filesystem.blocks * filesystem.bsize;
  } catch {
    // Capacity inspection is optional and must not change availability or initialize storage.
  }
  return {
    storageDir: config.storageDir,
    runtimeDir: config.runtimeDir,
    relocated: config.storageRelocated,
    state: error ? 'unavailable' as const : 'ready' as const,
    error,
    availableBytes,
    capacityBytes,
    deployment: config.authMode === 'fnos' ? 'fnos' : 'development',
    migrationAvailable: !error,
    roots: listLocalImportRoots(),
    migration: getStorageMigration(),
    paused: storageMigrationPaused(),
  };
}
