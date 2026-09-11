import { readFileSync, mkdirSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, dirname, isAbsolute, resolve, basename } from 'node:path';
import { getAppConfig } from './runtime-config';

export type StorageMigration = {
  version: 1; id: string; archiveId: string; rootId: string;
  source: string; target: string;
  phase: 'waiting' | 'copying' | 'verifying' | 'switching' | 'completed' | 'failed' | 'cancelled';
  files: number; copiedFiles: number; bytes: number; copiedBytes: number;
  createdAt: string; updatedAt: string; error: string | null;
  cancelRequested: boolean; switched: boolean;
  cleanupCompletedAt?: string;
};

export function atomicStorageJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, path);
  } finally {
    try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  const parent = openSync(dirname(path), 'r');
  try { fsyncSync(parent); } finally { closeSync(parent); }
}

export function readStorageMigration(): StorageMigration | null {
  let text: string;
  try { text = readFileSync(join(getAppConfig().runtimeDir, 'config', 'archive-migration.json'), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  const value = JSON.parse(text) as StorageMigration;
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  if (!value || value.version !== 1 || !uuid.test(value.id) || !uuid.test(value.archiveId)
    || typeof value.rootId !== 'string' || !value.rootId
    || typeof value.source !== 'string' || !isAbsolute(value.source) || resolve(value.source) !== value.source
    || typeof value.target !== 'string' || !isAbsolute(value.target) || resolve(value.target) !== value.target
    || ![getAppConfig().appName, `health-records-${value.id}`].includes(basename(value.target)) || value.target === value.source
    || typeof value.switched !== 'boolean' || typeof value.cancelRequested !== 'boolean'
    || ![value.files, value.copiedFiles, value.bytes, value.copiedBytes].every(n => Number.isSafeInteger(n) && n >= 0)
    || !['waiting', 'copying', 'verifying', 'switching', 'completed', 'failed', 'cancelled'].includes(value.phase)) {
    throw new Error('档案迁移状态无效，请保留配置并联系管理员恢复');
  }
  return value;
}

export function writeStorageMigration(state: StorageMigration) {
  state.updatedAt = new Date().toISOString();
  atomicStorageJson(join(getAppConfig().runtimeDir, 'config', 'archive-migration.json'), state);
}

export function storageMigrationPaused() {
  // Docker only uses its existing mounted /data; copied fnOS control files have no effect.
  if (!['fnos', 'development'].includes(getAppConfig().authMode)) return false;
  try {
    const state = readStorageMigration();
    return Boolean(state && ((state.switched && resolve(getAppConfig().storageDir) !== state.target)
      || !['completed', 'failed', 'cancelled'].includes(state.phase)
      || (state.phase === 'failed' && state.switched)));
  } catch { return true; }
}

const requests = new Set<object>();
export function trackStorageRequest(request: object) { requests.add(request); }
export function finishStorageRequest(request: object) { requests.delete(request); }
export function activeStorageRequests() { return requests.size; }
