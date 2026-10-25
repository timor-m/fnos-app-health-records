import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream, existsSync, readFileSync } from 'node:fs';
import { access, lstat, mkdir, open, readdir, realpath, rename, statfs, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { DatabaseSync } from 'node:sqlite';
import { closeDatabase, getDatabase } from '../database/client';
import { getAppConfig } from '../utils/runtime-config';
import { archiveIdentityFile, archiveLocationFile } from '../utils/archive-storage';
import { activeStorageRequests, atomicStorageJson, readStorageMigration, storageMigrationPaused, writeStorageMigration, type StorageMigration } from '../utils/storage-migration-state';
import { listLocalImportRoots } from './local-file-import.service';
import { isStorageJobActive } from './job-runner.service';
import { isStorageMaintenanceActive, startMaintenanceRunner } from './maintenance-runner.service';
import { isStorageNormalizationActive } from './indicator-normalization-task.service';
import { isStorageExportActive } from './records.service';

const ownedMarker = '.health-records-migration.json';
const cleanupManifestName = 'archive-cleanup.json';
const cleanableDirectories = new Set(['db', 'reports', 'report-notes', 'thumbnails', 'report-exports', 'upload-staging']);
type CleanupManifest = { version: 1; id: string; source: string; target: string; device: number; inode: number; files: Array<{ path: string; size: number; hash: string }> };
let cleaning = false;
const runtimeOnly = new Set(['runtime', 'ocr-venv', 'ocr-table', 'models', 'pip-cache', 'logs', 'tmp', 'cache']);
const controlFiles = new Set(['archive-location.json', 'archive-migration.json', 'archive-location.json.tmp', 'archive-migration.json.tmp', 'fnos-authorized-paths', 'ocr-install-status.json', 'runtime.json']);
let running: Promise<void> | null = null;
let cancelRequested = false;

function issue(message: string): never { const error = new Error(message); error.name = 'StorageMigrationError'; throw error; }
function contains(parent: string, child: string) { const rest = relative(parent, child); return !rest || (!rest.startsWith(`..${sep}`) && rest !== '..' && !isAbsolute(rest)); }
function supportedDeployment() {
  if (!['fnos', 'development'].includes(getAppConfig().authMode)) issue('此部署请通过宿主机数据卷配置存储位置');
}
async function targetRoot(rootId: string) {
  supportedDeployment();
  const root = rootId === 'default' ? {id: 'default', path: getAppConfig().runtimeDir} : listLocalImportRoots().find(root => root.id === rootId);
  if (!root) issue('目标目录未获得应用级授权，请重新选择');
  const path = await realpath(root.path);
  const source = await realpath(getAppConfig().storageDir);
  const runtime = await realpath(getAppConfig().runtimeDir);
  if (rootId === 'default' && source === runtime) issue('档案已在默认位置');
  if (contains(path, source) || contains(source, path) || (rootId !== 'default' && (contains(path, runtime) || contains(runtime, path)))) issue('目标目录不能与当前档案或运行目录重叠');
  await access(path, constants.R_OK | constants.W_OK | constants.X_OK);
  const filesystem = await statfs(path);
  // Only local file systems supported by this application; network mounts are not SQLite targets.
  if (getAppConfig().authMode === 'fnos' && ![0xef53, 0x9123683e, 0x58465342].includes(Number(filesystem.type) >>> 0)) issue('目标不是受支持的本地存储空间，不支持网络挂载目录');
  return { ...root, path, target: rootId === 'default' ? path : join(path, archiveDirectoryName()), returnToDefault: rootId === 'default', availableBytes: filesystem.bavail * filesystem.bsize };
}

type SourceFile = { path: string; size: number; modified: number };
async function inventory(source: string) {
  const files: SourceFile[] = [];
  async function visit(relativePath: string) {
    for (const entry of (await readdir(join(source, relativePath), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!relativePath && (runtimeOnly.has(entry.name) || (entry.isDirectory() && /^ocr-venv\.broken\.\d{14}$/.test(entry.name)) || entry.name === archiveIdentityFile || entry.name === ownedMarker)) continue;
      if (relativePath === 'config' && (entry.name === cleanupManifestName || controlFiles.has(entry.name) || /^archive-(location|migration|cleanup)\.json\..+\.tmp$/.test(entry.name))) continue;
      if (relativePath === 'db' && /-(wal|shm)$/.test(entry.name)) continue;
      const child = join(relativePath, entry.name);
      const stat = await lstat(join(source, child));
      if (stat.isSymbolicLink()) issue(`档案中存在符号链接（相对路径：${child}），需人工核对后迁移`);
      if (stat.isDirectory()) await visit(child);
      else if (stat.isFile()) files.push({ path: child, size: stat.size, modified: stat.mtimeMs });
      else issue('档案中存在不支持的特殊文件');
    }
  }
  await visit('');
  return files;
}

export async function previewStorageMigration(rootId: string) {
  if (cleaning) issue('正在清理旧档案，请稍后再迁移');
  if (storageMigrationPaused()) issue('已有迁移需要完成或取消');
  const root = await targetRoot(rootId);
  const target = root.target;
  if (root.returnToDefault) {
    checkDefaultDatabaseIdle(target);
    await inventory(target);
  } else try {
    await lstat(target);
    issue('目标下已存在应用同名目录，不会覆盖；请继续原迁移任务或选择其他授权目录');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const files = await inventory(getAppConfig().storageDir);
  const bytes = files.reduce((sum, file) => sum + file.size, 0);
  const requiredBytes = bytes + Math.max(256 * 1024 ** 2, Math.ceil(bytes * .1));
  if (root.availableBytes < requiredBytes) issue('目标剩余空间不足，需预留迁移校验空间');
  return { rootId, parent: root.path, target, returnToDefault: root.returnToDefault, files: files.length, bytes, requiredBytes, availableBytes: root.availableBytes };
}

function archiveDirectoryName() {
  const name = getAppConfig().appName;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)) issue('应用 ID 不能用作目录名称');
  return name;
}

export function getStorageMigration() {
  const state = readStorageMigration();
  let cleanupAvailable = false;
  try { cleanupAvailable = Boolean(state?.phase === 'completed' && !state.cleanupCompletedAt && readCleanupManifest().id === state.id); } catch { /* Old migrations have no verified deletion manifest. */ }
  return state ? { ...state, ...(state.rootId==='default' ? {previousArchiveDir:join(defaultReturnDirectory(state),'previous')} : {}), cleanupAvailable, cleaning, interrupted: !running && storageMigrationPaused() } : null;
}

function checkCancelled() { if (cancelRequested) throw new Error('MIGRATION_CANCELLED'); }
async function drainWrites() {
  const deadline = Date.now() + 10 * 60_000;
  while (activeStorageRequests() || isStorageJobActive() || isStorageMaintenanceActive() || isStorageNormalizationActive() || isStorageExportActive()) {
    checkCancelled();
    if (Date.now() > deadline) issue('等待现有任务结束超时，原目录仍保留，请稍后重试');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  checkCancelled();
}

async function hashFile(path: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) { checkCancelled(); hash.update(chunk); }
  return hash.digest('hex');
}

async function safeTargetPath(target: string, relativePath: string) {
  const destination = resolve(target, relativePath);
  if (!contains(target, destination)) issue('迁移文件路径越界');
  let parent = target;
  for (const part of relative(target, dirname(destination)).split(sep).filter(Boolean)) {
    parent = join(parent, part);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    if (await realpath(parent) !== parent) issue('目标目录出现符号链接，已停止迁移');
  }
  if (existsSync(destination)) {
    const stat = await lstat(destination);
    if (!stat.isFile() || stat.nlink !== 1) issue('目标文件存在不安全的链接或类型');
  }
  return destination;
}

async function verifyReferences(target: string) {
  const db = new DatabaseSync(join(target, 'db', 'health-records.sqlite'), { readOnly: true });
  try {
    if (db.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok' || db.prepare('PRAGMA foreign_key_check').get()) issue('目标数据库完整性校验未通过');
    for (const row of db.prepare('SELECT storage_path AS path, thumbnail_path AS thumbnail FROM report_pages').iterate()) {
      for (const value of [row.path, row.thumbnail]) {
        if (!value) continue;
        const path = resolve(target, String(value));
        if (isAbsolute(String(value)) || !contains(target, path)) issue('报告引用包含不安全路径');
        const stat = await lstat(path);
        if (!stat.isFile() || await realpath(path) !== path) issue('报告文件引用校验未通过');
      }
    }
  } finally { db.close(); }
}

async function commitArchiveSwitch(state: StorageMigration, files: CleanupManifest['files']) {
  const config = getAppConfig();
  const sourceIdentity = await lstat(state.source);
  atomicStorageJson(join(config.runtimeDir, 'config', cleanupManifestName), {
    version: 1, id: state.id, source: state.source, target: state.target,
    device: sourceIdentity.dev, inode: sourceIdentity.ino,
    files: files.filter(file => cleanableDirectories.has(file.path.split(sep)[0]))
  } satisfies CleanupManifest);
  state.phase = 'switching'; writeStorageMigration(state);
  // All source writes have drained; the connection stays closed until the durable pointer commits.
  closeDatabase();
  atomicStorageJson(join(config.runtimeDir, 'config', archiveLocationFile), { version: 1, archiveId: state.archiveId, path: state.target });
  state.switched = true;
  writeStorageMigration(state);
  getDatabase();
  state.phase = 'completed'; state.error = null; writeStorageMigration(state);
}

function checkDefaultDatabaseIdle(target: string) {
  for (const suffix of ['-wal', '-shm', '-journal']) if (existsSync(join(target,'db',`health-records.sqlite${suffix}`))) issue('默认目录中的旧数据库可能仍被使用，请停止旧服务后重试');
}

function defaultReturnDirectory(state: StorageMigration) {
  return join(state.target, 'runtime', `archive-return-${state.id}`);
}

async function syncArchiveDirectories(target: string, files: Array<{path:string}>) {
  const directories = new Set<string>([target]);
  for (const file of files) {
    for (let dir = dirname(join(target, file.path)); contains(target, dir); dir = dirname(dir)) {
      directories.add(dir);
      if (dir === target) break;
    }
  }
  for (const dir of [...directories].sort((a, b) => b.length - a.length)) {
    const fd = await open(dir, 'r');
    try { await fd.sync(); } finally { await fd.close(); }
  }
}

async function renameDurably(source: string, target: string) {
  await rename(source,target);
  for (const directory of new Set([dirname(source),dirname(target)])) {
    const fd=await open(directory,'r');try {await fd.sync();} finally {await fd.close();}
  }
}

async function installDefaultArchive(state: StorageMigration) {
  checkDefaultDatabaseIdle(state.target);
  const workspace=defaultReturnDirectory(state);
  const planPath=await safeTargetPath(state.target,relative(state.target,join(workspace,'promotion.json')));
  const plan=JSON.parse(readFileSync(planPath,'utf8')) as {version:number;id:string;files:CleanupManifest['files'];previous:CleanupManifest['files']};
  const valid=(file:CleanupManifest['files'][number],previous:boolean) => {
    if (!file || typeof file.path !== 'string' || isAbsolute(file.path) || file.path.split(sep).some(part=>!part||part==='.'||part==='..')
      || !Number.isSafeInteger(file.size) || file.size<0 || !/^[a-f0-9]{64}$/.test(file.hash)) return false;
    const [top,name]=file.path.split(sep);
    return !runtimeOnly.has(top) && top!==ownedMarker && (top!==archiveIdentityFile||previous)
      && !/^ocr-venv\.broken\.\d{14}$/.test(top)
      && !(top==='config' && (controlFiles.has(name)||name===cleanupManifestName||/^archive-(location|migration|cleanup)\.json\..+\.tmp$/.test(name)))
      && !(top==='db' && /-(wal|shm)$/.test(name));
  };
  if (plan.version!==1||plan.id!==state.id||!Array.isArray(plan.files)||!Array.isArray(plan.previous)
    || !plan.files.every(file=>valid(file,false))||!plan.previous.every(file=>valid(file,true))
    || new Set(plan.files.map(file=>file.path)).size!==plan.files.length||new Set(plan.previous.map(file=>file.path)).size!==plan.previous.length) issue('迁回默认位置的校验清单无效，已暂停切换');
  for (const file of plan.previous) {
    const backup=await safeTargetPath(state.target,relative(state.target,join(workspace,'previous',file.path)));
    if (!existsSync(backup)) {
      const original=await safeTargetPath(state.target,file.path);
      if (await hashFile(original)!==file.hash) issue('默认目录中的旧副本已变化，已暂停切换');
      await renameDurably(original,backup);
    }
    if (await hashFile(backup)!==file.hash) issue('默认目录旧副本的备份校验失败');
  }
  for (const file of plan.files) {
    const staged=await safeTargetPath(state.target,relative(state.target,join(workspace,'staging',file.path)));
    const destination=await safeTargetPath(state.target,file.path);
    if (existsSync(staged)) {
      if (existsSync(destination)) issue('默认目录出现未预期文件，已暂停切换');
      if (await hashFile(staged)!==file.hash) issue('暂存档案校验失败，已暂停切换');
      await renameDurably(staged,destination);
    }
    if (await hashFile(destination)!==file.hash) issue('默认目录的档案校验失败');
  }
  await verifyReferences(state.target);
  await syncArchiveDirectories(state.target,plan.files);
  atomicStorageJson(join(state.target,archiveIdentityFile),{version:1,archiveId:state.archiveId});
  await commitArchiveSwitch(state,plan.files);
}

async function execute(state: StorageMigration) {
  try {
    await drainWrites();
    const config = getAppConfig();
    if (resolve(config.storageDir) === state.target) {
      // A crash after the atomic pointer switch must never recopy an older source over new data.
      state.switched = true;
      if (config.storageError) issue('切换后的档案不可用，请恢复存储空间后继续');
      await verifyReferences(state.target);
      closeDatabase(); getDatabase();
      state.phase = 'completed'; state.error = null; writeStorageMigration(state);
      return;
    }
    if (await realpath(config.storageDir) !== state.source || state.switched) issue('当前目录与迁移记录不一致，已停止操作');
    const root = await targetRoot(state.rootId);
    if (state.target !== root.target) issue('目标授权目录已变化');
    if (root.returnToDefault && state.phase === 'switching') { await installDefaultArchive(state); return; }
    const destinationRoot = root.returnToDefault ? join(defaultReturnDirectory(state), 'staging') : state.target;
    const checkpoint = getDatabase().prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    if (checkpoint?.busy) issue('数据库仍被其他连接占用，请稍后重试');
    closeDatabase();
    state.phase = 'copying'; writeStorageMigration(state);
    const files = await inventory(state.source);
    state.files = files.length; state.bytes = files.reduce((sum, file) => sum + file.size, 0);
    state.copiedBytes = 0; state.copiedFiles = 0;
    const missingBytes = state.bytes; // Conservative on resume: require enough room for a full replacement.
    if (root.availableBytes < missingBytes + Math.max(256 * 1024 ** 2, Math.ceil(missingBytes * .1))) issue('目标剩余空间不足');
    if (existsSync(destinationRoot)) {
      if (await realpath(destinationRoot) !== destinationRoot
        || JSON.parse(readFileSync(join(destinationRoot, ownedMarker), 'utf8')).id !== state.id) issue('目标不是本任务创建的专属目录');
    } else {
      if (root.returnToDefault) await safeTargetPath(state.target, relative(state.target, join(destinationRoot, ownedMarker)));
      else await mkdir(destinationRoot, { mode: 0o700 });
      atomicStorageJson(join(destinationRoot, ownedMarker), { id: state.id, version: 1 });
    }
    const hashes = new Map<string, string>();
    for (const file of files) {
      checkCancelled();
      if (await realpath(root.path) !== root.path || await realpath(state.source) !== state.source) issue('源或目标存储位置已变化');
      const source = join(state.source, file.path);
      const before = await lstat(source);
      if (!before.isFile() || before.size !== file.size || before.mtimeMs !== file.modified || await realpath(source) !== source) issue('迁移期间源文件发生变化，请重试');
      const destination = await safeTargetPath(destinationRoot, file.path);
      const temporary = await safeTargetPath(destinationRoot, `${file.path}.copy-${state.id}`);
      const output = await open(temporary, constants.O_CREAT | constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
      await pipeline(createReadStream(source), async function* (chunks: AsyncIterable<Buffer>) {
        for await (const chunk of chunks) { checkCancelled(); yield chunk; }
      }, output.createWriteStream());
      const hash = await hashFile(source);
      if (await hashFile(temporary) !== hash) issue('文件复制校验失败');
      const after = await lstat(source);
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) issue('迁移期间源文件发生变化，请重试');
      const fd = await open(temporary, 'r+');
      try { await fd.sync(); } finally { await fd.close(); }
      await rename(temporary, destination);
      const directory = await open(dirname(destination), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
      hashes.set(file.path, hash);
      state.copiedBytes += file.size; state.copiedFiles += 1;
      writeStorageMigration(state);
    }
    checkCancelled();
    state.phase = 'verifying'; writeStorageMigration(state);
    for (const file of files) {
      if (await hashFile(join(destinationRoot, file.path)) !== hashes.get(file.path)) issue('目标文件最终校验失败');
      if (await hashFile(join(state.source, file.path)) !== hashes.get(file.path)) issue('校验期间源文件发生变化，请重试');
    }
    const finalFiles = await inventory(state.source);
    if (JSON.stringify(finalFiles) !== JSON.stringify(files)) issue('校验期间源文件列表发生变化，请重试');
    const targetFiles = await inventory(destinationRoot);
    if (JSON.stringify(targetFiles.map(file => file.path)) !== JSON.stringify(files.map(file => file.path))) issue('目标存在不属于本次源快照的文件，请取消后重新创建迁移任务');
    await verifyReferences(destinationRoot);
    checkCancelled();
    // Persist newly created directory entries as well as file contents before switching.
    await syncArchiveDirectories(destinationRoot,files);
    if (root.returnToDefault) {
      checkDefaultDatabaseIdle(state.target);
      const previous = await inventory(state.target);
      const oldFiles: CleanupManifest['files'] = [];
      for (const file of previous) oldFiles.push({path:file.path,size:file.size,hash:await hashFile(join(state.target,file.path))});
      if (existsSync(join(state.target,archiveIdentityFile))) {
        const identityPath=await safeTargetPath(state.target,archiveIdentityFile);
        oldFiles.push({path:archiveIdentityFile,size:(await lstat(identityPath)).size,hash:await hashFile(identityPath)});
      }
      atomicStorageJson(join(defaultReturnDirectory(state),'promotion.json'), {version:1,id:state.id,files:files.map(file=>({path:file.path,size:file.size,hash:hashes.get(file.path)!})),previous:oldFiles});
      state.phase='switching';writeStorageMigration(state);
      await installDefaultArchive(state);return;
    }
    atomicStorageJson(join(state.target, archiveIdentityFile), { version: 1, archiveId: state.archiveId });
    await commitArchiveSwitch(state, files.map(file => ({path:file.path,size:file.size,hash:hashes.get(file.path)!})));
  } catch (error) {
    state.switched ||= resolve(getAppConfig().storageDir) === state.target;
    const cancelled = !state.switched && (error as Error).message === 'MIGRATION_CANCELLED';
    // A partial installation into the default directory must stay paused until resumed.
    state.phase = state.rootId === 'default' && state.phase === 'switching' && !state.switched ? 'switching' : cancelled ? 'cancelled' : 'failed';
    state.error = cancelled ? null : (error as Error).name === 'StorageMigrationError'
      ? (error as Error).message : '迁移未完成，源数据和目标副本均已保留。请检查目录权限、存储空间及数据库后重试。';
    writeStorageMigration(state);
  } finally {
    if (!storageMigrationPaused() && !getAppConfig().storageError && process.env.DISABLE_JOB_RUNNER !== 'true') startMaintenanceRunner();
  }
}

function launch(state: StorageMigration) {
  cancelRequested = false;
  running = execute(state).finally(() => { running = null; });
  // Keep unexpected persistence failures from becoming an unhandled rejection; durable active state stays paused.
  void running.catch(() => undefined);
}

export async function startStorageMigration(rootId: string) {
  supportedDeployment();
  await previewStorageMigration(rootId);
  if (running || cleaning || storageMigrationPaused()) issue('已有迁移或清理正在执行');
  const root = await targetRoot(rootId);
  if (running || cleaning || storageMigrationPaused()) issue('已有迁移或清理正在执行');
  const id = randomUUID();
  const source = await realpath(getAppConfig().storageDir);
  const state: StorageMigration = { version: 1, id, archiveId: randomUUID(), rootId, source,
    target: root.target, phase: 'waiting', files: 0, copiedFiles: 0, bytes: 0, copiedBytes: 0,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), error: null, cancelRequested: false, switched: false };
  // Recheck after the last asynchronous preflight step.
  if (running || cleaning || storageMigrationPaused()) issue('已有迁移或清理正在执行');
  writeStorageMigration(state); launch(state);
  return getStorageMigration();
}

export function resumeStorageMigration() {
  supportedDeployment();
  if (running || cleaning) issue('迁移或清理正在执行');
  const state = readStorageMigration();
  if (!state || ['completed', 'cancelled'].includes(state.phase)) issue('没有可继续的迁移');
  state.phase = state.switched || (state.rootId === 'default' && state.phase === 'switching') ? 'switching' : 'waiting'; state.error = null; state.cancelRequested = false;
  writeStorageMigration(state); launch(state);
  return getStorageMigration();
}

export function cancelStorageMigration() {
  supportedDeployment();
  const state = readStorageMigration();
  if (!state || ['switching', 'completed', 'cancelled'].includes(state.phase) || state.switched
    || resolve(getAppConfig().storageDir) === state.target) issue('当前阶段不能取消或回退');
  cancelRequested = true;
  state.cancelRequested = true;
  if (!running) state.phase = 'cancelled';
  writeStorageMigration(state);
  if (!running && !getAppConfig().storageError && process.env.DISABLE_JOB_RUNNER !== 'true') startMaintenanceRunner();
  return getStorageMigration();
}

export async function waitForStorageMigration() { await running; }

function readCleanupManifest(): CleanupManifest {
  const manifest = JSON.parse(readFileSync(join(getAppConfig().runtimeDir, 'config', cleanupManifestName), 'utf8')) as CleanupManifest;
  if (manifest.version !== 1 || !Array.isArray(manifest.files) || !manifest.files.every(file =>
    typeof file.path === 'string' && !isAbsolute(file.path) && !file.path.split(sep).some(part => !part || part === '.' || part === '..')
    && cleanableDirectories.has(file.path.split(sep)[0]) && Number.isSafeInteger(file.size) && file.size >= 0
    && /^[a-f0-9]{64}$/.test(file.hash))) issue('旧副本校验清单无效，不能自动清理');
  return manifest;
}

async function cleanupContext(id: string, checkedManifest?: CleanupManifest) {
  supportedDeployment();
  const state = readStorageMigration();
  const config = getAppConfig();
  if (!state || state.id !== id || state.phase !== 'completed' || !state.switched || running || storageMigrationPaused()
    || config.storageError || resolve(config.storageDir) !== state.target || contains(state.source, state.target)
    || contains(state.target, state.source)) issue('当前迁移未完成或新档案不可用，不能清理旧副本');
  let manifest: CleanupManifest;
  try { manifest = checkedManifest || readCleanupManifest(); } catch { issue('此迁移缺少有效的文件校验清单，暂不能自动清理旧副本'); }
  if (manifest.id !== id || manifest.source !== state.source || manifest.target !== state.target) issue('清理清单与当前迁移不一致');
  const source = await lstat(state.source);
  if (!source.isDirectory() || await realpath(state.source) !== state.source || source.dev !== manifest.device || source.ino !== manifest.inode) issue('旧目录身份已变化，停止清理');
  const marker = JSON.parse(readFileSync(join(state.target, archiveIdentityFile), 'utf8'));
  if (marker.archiveId !== state.archiveId) issue('新档案身份已变化，停止清理');
  // A new WAL/SHM indicates the old database may have been reopened by another process.
  for (const suffix of ['-wal', '-shm', '-journal']) {
    try { await lstat(join(state.source, 'db', `health-records.sqlite${suffix}`)); issue('旧数据库可能仍被使用，请停止旧服务后重试'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return { state, manifest };
}

async function unchangedCleanupFile(source: string, file: CleanupManifest['files'][number]) {
  const path = join(source, file.path);
  try {
    const before = await lstat(path);
    if (!before.isFile() || before.nlink !== 1 || before.size !== file.size || await realpath(path) !== path) return null;
    const digest = createHash('sha256');
    for await (const chunk of createReadStream(path)) digest.update(chunk);
    const after = await lstat(path);
    if (digest.digest('hex') !== file.hash || before.ino !== after.ino || before.dev !== after.dev
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) return null;
    return after;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}

export async function previewStorageCleanup(id: string) {
  if (cleaning) issue('正在清理旧档案，请稍候');
  const { state, manifest } = await cleanupContext(id);
  if (state.cleanupCompletedAt) return { id, source: state.source, files: 0, bytes: 0, skipped: 0 };
  let files = 0, bytes = 0, skipped = 0;
  for (const file of manifest.files) {
    if (await unchangedCleanupFile(state.source, file)) { files++; bytes += file.size; }
    else if (existsSync(join(state.source, file.path))) skipped++;
  }
  return { id, source: state.source, files, bytes, skipped };
}

export async function cleanupStorageSource(id: string) {
  if (cleaning) issue('正在清理旧档案，请勿重复操作');
  cleaning = true;
  let deletedFiles = 0, deletedBytes = 0, skipped = 0;
  try {
    const { state, manifest } = await cleanupContext(id);
    if (state.cleanupCompletedAt) return { deletedFiles, deletedBytes, skipped };
    await verifyReferences(state.target);
    for (const file of manifest.files) {
      const checked = await unchangedCleanupFile(state.source, file);
      if (!checked) { if (existsSync(join(state.source, file.path))) skipped++; continue; }
      await cleanupContext(id, manifest);
      const path = join(state.source, file.path);
      const latest = await lstat(path);
      if (!latest.isFile() || latest.nlink !== 1 || await realpath(path) !== path || latest.ino !== checked.ino || latest.dev !== checked.dev
        || latest.ctimeMs !== checked.ctimeMs || latest.mtimeMs !== checked.mtimeMs) { skipped++; continue; }
      await unlink(path); // Exact verified files only; never recursively remove the source root.
      deletedFiles++; deletedBytes += file.size;
    }
    if (!skipped) { state.cleanupCompletedAt = new Date().toISOString(); writeStorageMigration(state); }
    return { deletedFiles, deletedBytes, skipped };
  } catch (error) {
    issue(`清理已停止（已删除 ${deletedFiles} 个文件）。${error instanceof Error && error.name === 'StorageMigrationError' ? error.message : '请检查目录权限与存储状态；未处理文件保持原样，可检查后重试。'}`);
  } finally { cleaning = false; }
}
