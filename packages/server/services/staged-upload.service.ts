import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createError } from 'h3';
import type { RequestUser } from '../domain/request-user';
import { getAppConfig } from '../utils/runtime-config';
import { assertMemberManage } from './member.service';
import { createUploadFromStagedFiles, detectUploadType } from './upload.service';

type StagedManifest = { memberId: string; files: Array<{ originalName: string; size: number; rotation: number }> };
// Opportunistic cleanup is limited to this service's hashed temporary directories.
export function cleanupExpiredStagedUploads(now = Date.now()) {
  const root = join(getAppConfig().storageDir, 'upload-staging');
  if (!existsSync(root)) return;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name)) continue;
    const path = join(root, entry.name);
    if (now - statSync(path).mtimeMs > 7 * 24 * 60 * 60 * 1000) rmSync(path, { recursive: true, force: true });
  }
}
function stageDirectory(user: RequestUser, key: string) {
  if (typeof key !== 'string' || !/^[a-zA-Z0-9_-]{16,100}$/.test(key)) throw createError({ statusCode: 400, statusMessage: '上传请求编号无效' });
  return join(getAppConfig().storageDir, 'upload-staging', createHash('sha256').update(`${user.id}\0${key}`).digest('hex'));
}
function readStage(user: RequestUser, key: string) {
  const directory = stageDirectory(user, key);
  if (!existsSync(join(directory, 'manifest.json'))) throw createError({ statusCode: 404, statusMessage: '上传暂存不存在，请重新初始化' });
  const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8')) as StagedManifest;
  assertMemberManage(user, manifest.memberId);
  return { directory, manifest };
}
export function startStagedUpload(user: RequestUser, key: string, input: StagedManifest) {
  if (!input || typeof input.memberId !== 'string') throw createError({ statusCode: 400, statusMessage: '请选择报告所属成员' });
  assertMemberManage(user, input.memberId);
  cleanupExpiredStagedUploads();
  if (!Array.isArray(input.files) || !input.files.length || input.files.length > 1000) throw createError({ statusCode: 400, statusMessage: '一次导入请选择 1 至 1000 个文件' });
  let total = 0;
  const files = input.files.map(file => {
    if (!file || typeof file.originalName !== 'string' || !file.originalName.trim() || file.originalName.length > 255 || !Number.isInteger(file.size) || file.size <= 0 || file.size > 40 * 1024 * 1024 || ![0, 90, 180, 270].includes(file.rotation)) throw createError({ statusCode: 400, statusMessage: '文件清单无效，单文件上限 40MB' });
    total += file.size;
    return { originalName: file.originalName, size: file.size, rotation: file.rotation };
  });
  if (total > 2 * 1024 * 1024 * 1024) throw createError({ statusCode: 413, statusMessage: '一次导入总大小不能超过 2GB' });
  const manifest = { memberId: input.memberId, files };
  const directory = stageDirectory(user, key);
  mkdirSync(directory, { recursive: true });
  const now = new Date();
  utimesSync(directory, now, now);
  const path = join(directory, 'manifest.json');
  if (existsSync(path)) {
    if (readFileSync(path, 'utf8') !== JSON.stringify(manifest)) throw createError({ statusCode: 409, statusMessage: '重试文件清单发生变化，请新建上传任务' });
  } else {
    writeFileSync(join(directory, 'manifest.tmp'), JSON.stringify(manifest), { mode: 0o600 });
    renameSync(join(directory, 'manifest.tmp'), path);
  }
  const received = files.flatMap((file, index) => {
    const path = join(directory, `${index}.bin`);
    return existsSync(path) && statSync(path).size === file.size ? [index] : [];
  });
  return { received };
}
export function storeStagedFile(user: RequestUser, key: string, index: number, data: Uint8Array) {
  const { directory, manifest } = readStage(user, key);
  const file = Number.isInteger(index) && index >= 0 ? manifest.files[index] : undefined;
  if (!file || data.byteLength !== file.size || !detectUploadType(data)) throw createError({ statusCode: 400, statusMessage: '文件大小或实际格式与上传要求不符' });
  const path = join(directory, `${index}.bin`);
  const hash = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
  if (existsSync(path)) {
    if (hash(readFileSync(path)) !== hash(data)) throw createError({ statusCode: 409, statusMessage: '重试文件内容发生变化' });
  } else {
    writeFileSync(`${path}.tmp`, data, { mode: 0o600 });
    renameSync(`${path}.tmp`, path);
  }
  return { index, received: true };
}
export function completeStagedUpload(user: RequestUser, key: string) {
  const { directory, manifest } = readStage(user, key);
  const files = manifest.files.map((file, index) => {
    const path = join(directory, `${index}.bin`);
    if (!existsSync(path) || statSync(path).size !== file.size) throw createError({ statusCode: 409, statusMessage: '报告文件尚未传齐，请继续上传后再识别' });
    return { originalName: file.originalName, rotation: file.rotation, sourcePath: path };
  });
  const result = createUploadFromStagedFiles(user, manifest.memberId, files, key);
  // Keep the manifest so a lost completion response can be retried; payloads
  // are removed only by the explicit discard endpoint after acknowledgement.
  return result;
}
export function discardStagedUpload(user: RequestUser, key: string) {
  const directory = stageDirectory(user, key);
  if (existsSync(join(directory, 'manifest.json'))) readStage(user, key);
  rmSync(directory, { recursive: true, force: true });
  return { discarded: true };
}
