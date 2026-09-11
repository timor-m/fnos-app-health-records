import { accessSync, constants, lstatSync, readFileSync, realpathSync, openSync, readSync, closeSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

export const archiveLocationFile = 'archive-location.json';
export const archiveIdentityFile = '.health-records-archive.json';

export type ArchiveLocation = {
  storageDir: string;
  relocated: boolean;
  error: string | null;
};

/** Read-only resolution. Missing/unreadable configured storage must never create a new archive. */
export function resolveArchiveLocation(runtimeDir: string, enabled: boolean): ArchiveLocation {
  const legacy = { storageDir: runtimeDir, relocated: false, error: null };
  if (!enabled) return legacy;
  let content: string;
  try {
    content = readFileSync(join(runtimeDir, 'config', archiveLocationFile), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return legacy;
    return { ...legacy, error: '无法读取档案存储配置，已停止访问档案。请检查应用目录权限。' };
  }
  let location: { version: number; path: string; archiveId: string };
  try {
    location = JSON.parse(content);
    if (location.version !== 1 || typeof location.path !== 'string' || !isAbsolute(location.path)
      || typeof location.archiveId !== 'string' || !/^[a-f0-9-]{36}$/i.test(location.archiveId)
      || resolve(location.path) === resolve(runtimeDir)) throw new Error('Invalid location');
  } catch {
    return { ...legacy, error: '档案存储配置无效，已停止访问档案，不会初始化空数据库。' };
  }
  const selected = { storageDir: location.path, relocated: true };
  try {
    if (realpathSync(location.path) !== resolve(location.path)) throw new Error('Changed location');
    const markerPath = join(location.path, archiveIdentityFile);
    const dbPath = join(location.path, 'db', 'health-records.sqlite');
    if (realpathSync(join(location.path, 'db')) !== join(resolve(location.path), 'db')) throw new Error('Changed database directory');
    if (!lstatSync(markerPath).isFile() || !lstatSync(dbPath).isFile()) throw new Error('Missing files');
    const fd = openSync(dbPath, 'r');
    try {
      const signature = Buffer.alloc(16);
      if (readSync(fd, signature, 0, 16, 0) !== 16 || signature.toString('ascii') !== 'SQLite format 3\0') throw new Error('Invalid database');
    } finally { closeSync(fd); }
    const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
    if (marker.version !== 1 || marker.archiveId !== location.archiveId) throw new Error('Wrong archive');
    accessSync(location.path, constants.R_OK | constants.W_OK | constants.X_OK);
    accessSync(join(location.path, 'db'), constants.R_OK | constants.W_OK | constants.X_OK);
    accessSync(dbPath, constants.R_OK | constants.W_OK);
    return { ...selected, error: null };
  } catch {
    return { ...selected, error: '档案存储不可用或目录身份不匹配。请检查存储空间挂载和读写权限；不会切回旧目录或创建空档案。' };
  }
}
