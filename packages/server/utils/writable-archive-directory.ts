import { randomBytes } from 'node:crypto';
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { getAppConfig } from './runtime-config';

const yieldable = new Set(['backups', join('backups', 'full'), 'uploads', 'upload-staging']);
const backupFile = /^backup_[a-f0-9]{32}\.(?:tar\.gz|metadata\.json)$/;

/** Make a backup or upload directory writable without chmod. A directory owned by another user is kept aside and replaced; a directory owned by this process stays untouched. */
export function ensureWritableArchiveDirectory(directory: string) {
  const storageDir = resolve(getAppConfig().storageDir);
  const target = resolve(directory);
  try {
    mkdirSync(target, { recursive: true, mode: 0o700 });
  } catch (error) {
    yieldOrThrow(target, storageDir, error);
  }
  const probeError = probeWrite(target);
  if (!probeError) return target;
  yieldOrThrow(target, storageDir, probeError);
  const again = probeWrite(target);
  if (again) throw again;
  return target;
}

function yieldOrThrow(target: string, storageDir: string, error: unknown) {
  const blocked = blockingDirectory(target, storageDir, error);
  if (!blocked) throw error;
  const retired = `${blocked}.unwritable-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
  // macOS 不允许改名一个调用者写不了的目录；飞牛是 Linux，父目录可写就能改名。改名失败时保持原来的权限错误。
  try { renameSync(blocked, retired); } catch { throw error; }
  try {
    mkdirSync(blocked, { mode: 0o700 });
    salvageBackups(retired, blocked);
    if (blocked !== target) mkdirSync(target, { recursive: true, mode: 0o700 });
  } catch {
    try { renameSync(retired, blocked); } catch { /* 旧目录保留在改名后的位置，避免可写目录和旧目录同时丢失 */ }
    throw error;
  }
}

function blockingDirectory(target: string, storageDir: string, error: unknown) {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code !== 'EACCES' && code !== 'EPERM') return null;
  const current = typeof process.getuid === 'function' ? process.getuid() : undefined;
  if (current === undefined || current === 0) return null;
  let currentPath = target;
  while (currentPath.startsWith(storageDir + sep)) {
    const rel = relative(storageDir, currentPath);
    if (!yieldable.has(rel)) {
      const parent = dirname(currentPath);
      if (parent === currentPath) return null;
      currentPath = parent;
      continue;
    }
    if (isForeignDirectory(currentPath, current) && probeWrite(dirname(currentPath)) === null) return currentPath;
    const parent = dirname(currentPath);
    if (parent === currentPath) return null;
    currentPath = parent;
  }
  return null;
}

function isForeignDirectory(directory: string, currentUid: number) {
  try {
    const info = lstatSync(directory);
    return info.isDirectory() && typeof info.uid === 'number' && info.uid !== currentUid;
  } catch {
    return false;
  }
}

function probeWrite(directory: string) {
  let probe: string | undefined;
  try {
    probe = mkdtempSync(join(directory, '.write-'));
    return null;
  } catch (error) {
    return error;
  } finally {
    if (probe) {
      try { rmSync(probe, { recursive: true, force: true }); } catch { /* 探测目录清不掉时，下次备份仍会重试 */ }
    }
  }
}

/** Delete a storage directory. A foreign directory that cannot be removed is renamed aside when its parent is writable; this process never chmods or moves its own directory. The target path is absent on success. */
export function removeOrRetireDirectory(directory: string) {
  const storageDir = resolve(getAppConfig().storageDir);
  const target = resolve(directory);
  if (target === storageDir || !target.startsWith(storageDir + sep)) {
    const refused = new Error('拒绝移动档案根目录') as NodeJS.ErrnoException;
    refused.code = 'EPERM';
    throw refused;
  }
  try {
    rmSync(target, { recursive: true, force: true });
    return null;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code !== 'EACCES' && code !== 'EPERM') throw error;
    const current = typeof process.getuid === 'function' ? process.getuid() : undefined;
    if (current === undefined || current === 0) throw error;
    if (!isForeignDirectory(target, current) || probeWrite(dirname(target)) !== null) throw error;
    const retired = `${target}.unwritable-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
    try { renameSync(target, retired); } catch { throw error; }
    return retired;
  }
}

function salvageBackups(retired: string, fresh: string) {
  const freshName = relative(dirname(fresh), fresh);
  const source = freshName === 'full' ? retired : freshName === 'backups' ? join(retired, 'full') : '';
  if (!source) return;
  const destination = freshName === 'full' ? fresh : join(fresh, 'full');
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  let names: string[];
  try { names = readdirSync(source); } catch { return; }
  for (const name of names) {
    if (!backupFile.test(name)) continue;
    const from = join(source, name);
    const to = join(destination, name);
    try { renameSync(from, to); } catch {
      try { copyFileSync(from, to); } catch { /* 读不到的旧备份留在改名后的目录里 */ }
    }
  }
}
