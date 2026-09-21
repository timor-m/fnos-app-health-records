import { apiError, classifySystemError } from "../utils/api-error";
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, lstatSync, realpathSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { createError } from 'h3';
import { getDatabase } from '../database/client';
import type { RequestUser } from '../domain/request-user';
import { createId } from '../utils/identifier';
import { getAppConfig } from '../utils/runtime-config';
import { assertMemberAccess, assertMemberManage } from './member.service';
import { detectUploadType, type UploadInputFile } from './upload.service';
import { requestWorker } from './ocr-worker-client';
import { cleanupExpiredStagedUploads } from './staged-upload.service';
import { enqueueFileGarbage, type FileGarbageCandidate } from './file-gc.service';
import { reportNoteLimits, type ReportNote, type ReportNoteAsset, type ReportNoteInput } from '../../shared/report-notes';
import { maxUploadFileBytes } from '../../shared/upload-limits';

const fail = (statusCode: number, statusMessage: string): never => { throw createError({ statusCode, statusMessage }); };
type AssetRow = ReportNoteAsset & { storagePath: string; thumbnailPath: string; previewPath: string | null; sha256: string };
type Stage = { reportId: string; originalName: string; mimeType: string; fileSize: number; sha256: string; extension: string; width: number | null; height: number | null };
const hash = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex');

export function assertReportNoteAccess(user: RequestUser, reportId: string, manage = false) {
  const report = getDatabase().prepare('SELECT member_id AS memberId, status FROM reports WHERE id = ?').get(reportId) as { memberId: string; status: string } | undefined;
  if (!report) return fail(404, '报告不存在');
  const permission = assertMemberAccess(user, report.memberId);
  if (manage) {
    assertMemberManage(user, report.memberId);
    if (report.status === 'trashed') fail(409, '请先恢复回收站中的报告');
  }
  return permission === 'manager' && report.status !== 'trashed';
}
function requireNote(reportId: string, noteId: string) {
  const row = getDatabase().prepare(`SELECT id, content_text AS contentText, created_by AS createdBy,
    created_at AS createdAt, updated_at AS updatedAt FROM report_notes
    WHERE id = ? AND report_id = ? AND deleted_at IS NULL`).get(noteId, reportId) as Omit<ReportNote, 'assets'> | undefined;
  return row || fail(404, '补充记录不存在');
}
function assetRows(noteId: string) {
  return getDatabase().prepare(`SELECT id, original_name AS originalName, mime_type AS mimeType, file_size AS fileSize,
    width, height, sort_order AS sortOrder, storage_path AS storagePath, thumbnail_path AS thumbnailPath,
    preview_path AS previewPath, sha256 FROM report_note_assets WHERE note_id = ? ORDER BY sort_order, created_at, id`).all(noteId) as AssetRow[];
}
function publicAsset(row: AssetRow): ReportNoteAsset {
  const { id, originalName, mimeType, fileSize, width, height, sortOrder } = row;
  return { id, originalName, mimeType, fileSize, width, height, sortOrder };
}
export function listReportNotes(user: RequestUser, reportId: string) {
  const canManage = assertReportNoteAccess(user, reportId);
  const ids = getDatabase().prepare('SELECT id FROM report_notes WHERE report_id = ? AND deleted_at IS NULL ORDER BY created_at, id').all(reportId) as { id: string }[];
  return { canManage, notes: ids.map(({ id }) => ({ ...requireNote(reportId, id), assets: assetRows(id).map(publicAsset) })) };
}
function audit(user: RequestUser, reportId: string, noteId: string, action: string, assetCount: number) {
  getDatabase().prepare(`INSERT INTO audit_logs(id, actor_user_id, action, target_type, target_id, detail_json)
    VALUES (?, ?, ?, 'report', ?, ?)`).run(createId('audit'), user.id, action, reportId, JSON.stringify({ reportId, noteId, assetCount }));
}
function stageDirectory(user: RequestUser, token: string) {
  if (!/^note_upload_[a-f0-9]{32}$/.test(token)) fail(400, '图片上传凭据无效');
  return join(getAppConfig().storageDir, 'upload-staging', hash(`report-note\0${user.id}\0${token}`));
}
function readStage(user: RequestUser, reportId: string, token: string) {
  const directory = stageDirectory(user, token);
  const path = join(directory, 'note.json');
  if (!existsSync(path)) return fail(410, '暂存图片已过期，请重新上传');
  const stage = JSON.parse(readFileSync(path, 'utf8')) as Stage;
  if (stage.reportId !== reportId) fail(404, '图片不属于当前报告');
  return { directory, stage };
}

// Only the existing image renderer is invoked; no OCR job or report page is created.
export async function stageReportNoteImage(user: RequestUser, reportId: string, file: UploadInputFile, render = requestWorker) {
  assertReportNoteAccess(user, reportId, true);
  if (!file.data.byteLength || file.data.byteLength > maxUploadFileBytes) fail(413, '单张图片须大于 0 且不超过 40 MB');
  const type = detectUploadType(file.data);
  if (!type || type.kind !== 'image') return fail(415, '暂不支持此文件格式');
  const declared = file.declaredType?.toLowerCase();
  if (declared && declared !== 'application/octet-stream' && declared !== type.mimeType
    && !(type.mimeType === 'image/heic' && declared === 'image/heif')
    && !(type.mimeType === 'image/jpeg' && declared === 'image/jpg')) fail(415, '图片声明类型与实际格式不符');
  cleanupExpiredStagedUploads();
  const token = createId('note_upload');
  const directory = stageDirectory(user, token);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const originalPath = join(directory, `original${type.extension}`);
  try {
    writeFileSync(originalPath, file.data, { mode: 0o600, flag: 'wx' });
    const thumbnail = await render({ action: 'thumbnail', imagePath: originalPath, mimeType: type.mimeType, outputPath: join(directory, 'thumbnail.jpg'), maxSize: 480 });
    if (!thumbnail.ok && thumbnail.errorCode) throw Object.assign(new Error('图片处理失败'), { code: thumbnail.errorCode });
    if (!thumbnail.ok || !existsSync(join(directory, 'thumbnail.jpg'))) fail(422, '图片缩略图生成失败，请检查图片及本地图片处理环境后重试');
    if (type.mimeType === 'image/heic') {
      const preview = await render({ action: 'thumbnail', imagePath: originalPath, mimeType: type.mimeType, outputPath: join(directory, 'preview.jpg'), maxSize: 2560 });
      if (!preview.ok && preview.errorCode) throw Object.assign(new Error('图片处理失败'), { code: preview.errorCode });
      if (!preview.ok || !existsSync(join(directory, 'preview.jpg'))) fail(422, 'HEIC 图片预览生成失败，请检查图片处理环境后重试');
    }
    assertReportNoteAccess(user, reportId, true); // Permission may change during rendering.
    const stage: Stage = { reportId, originalName: file.originalName.replace(/.*[/\\]/, '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 180) || `图片${type.extension}`,
      mimeType: type.mimeType, extension: type.extension, fileSize: file.data.byteLength, sha256: hash(file.data),
      // Renderer returns thumbnail dimensions, not original dimensions.
      width: null, height: null };
    writeFileSync(join(directory, 'note.json'), JSON.stringify(stage), { mode: 0o600 });
    return { uploadToken: token, originalName: stage.originalName, mimeType: stage.mimeType, fileSize: stage.fileSize };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    // Never propagate worker errors containing paths or image details to logs/UI.
    if ((error as { statusCode?: number }).statusCode) throw error;
    const classified = classifySystemError(error);
    if (classified) throw apiError(classified.status, classified.code, classified.message);
    throw apiError(422, 'OCR_UNAVAILABLE', '图片处理失败，请确认本地图片处理环境已安装，或重试上传');
  }
}
export function getStagedNoteImage(user: RequestUser, reportId: string, token: string, variant = 'preview') {
  assertReportNoteAccess(user, reportId, true);
  if (!['original', 'preview'].includes(variant)) fail(400, '图片版本无效');
  const { directory, stage } = readStage(user, reportId, token);
  const preview = variant === 'preview' && stage.mimeType === 'image/heic';
  const path = join(directory, preview ? 'preview.jpg' : `original${stage.extension}`);
  if (!existsSync(path)) fail(410, '暂存图片已清理，请重新上传');
  return { path, mimeType: preview ? 'image/jpeg' : stage.mimeType };
}
function garbage(rows: AssetRow[]): FileGarbageCandidate[] {
  return rows.flatMap(row => [row.storagePath, row.thumbnailPath, row.previewPath].map(storagePath => ({ storagePath, fileKind: 'other' as const })));
}
export function reportNoteFiles(reportId: string): FileGarbageCandidate[] {
  const notes = getDatabase().prepare('SELECT id FROM report_notes WHERE report_id = ?').all(reportId) as { id: string }[];
  return notes.flatMap(note => garbage(assetRows(note.id)));
}

export function saveReportNote(user: RequestUser, reportId: string, input: ReportNoteInput | undefined, noteId?: string) {
  assertReportNoteAccess(user, reportId, true);
  if (!input || typeof input.contentText !== 'string' || input.contentText.length > reportNoteLimits.textLength
    || !Array.isArray(input.assets) || input.assets.length > reportNoteLimits.images) return fail(400, '补充记录最多 10000 字、9 张图片');
  const contentText = input.contentText.trim();
  if (!contentText && !input.assets.length) fail(400, '请填写补充说明或添加图片');
  const id = noteId || input.id || createId('note');
  if (!/^note_[a-f0-9]{32}$/.test(id)) fail(400, '补充记录编号无效');
  const db = getDatabase();
  // A stable client id makes a lost create response safe to retry, without creating duplicates.
  if (!noteId && db.prepare('SELECT id FROM report_notes WHERE id = ?').get(id)) {
    const note = requireNote(reportId, id);
    if (note.createdBy !== user.id) fail(409, '补充记录编号已被使用');
    const saved = assetRows(id);
    if (note.contentText !== contentText || saved.length !== input.assets.length
      || input.assets.some((asset, index) => !asset?.uploadToken || readStage(user, reportId, asset.uploadToken).stage.sha256 !== saved[index].sha256)) {
      fail(409, '记录已保存，但本次内容发生变化，请关闭并重新打开记录后编辑');
    }
    return { ...note, assets: saved.map(publicAsset) };
  }
  const previous = noteId ? requireNote(reportId, id) : null;
  if (previous && input.updatedAt !== previous.updatedAt) fail(409, '这条记录已更新，请重新打开后编辑');
  const existing = previous ? assetRows(id) : [];
  const copied: string[] = [];
  const seen = new Set<string>();
  const rows: AssetRow[] = [];
  const stagedGarbage: FileGarbageCandidate[] = [];
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const [index, item] of input.assets.entries()) {
      if (!item || Boolean(item.id) === Boolean(item.uploadToken)) fail(400, '图片清单无效');
      let row: AssetRow;
      if (item.id) {
        row = existing.find(asset => asset.id === item.id) || fail(404, '图片不属于当前补充记录');
      } else {
        const { directory, stage } = readStage(user, reportId, item.uploadToken!);
        if (!existsSync(join(directory, `original${stage.extension}`))) fail(410, '暂存图片已清理，请重新上传');
        const assetId = createId('note_asset');
        // reportId is hashed for filesystem layout, never trusted as a path component.
        const base = `report-notes/${hash(reportId)}/${id}`;
        const storagePath = `${base}/original/${assetId}${stage.extension}`;
        const thumbnailPath = `${base}/thumbnails/${assetId}.jpg`;
        const previewPath = stage.mimeType === 'image/heic' ? `${base}/previews/${assetId}.jpg` : null;
        for (const [source, target] of [[`original${stage.extension}`, storagePath], ['thumbnail.jpg', thumbnailPath], ...(previewPath ? [['preview.jpg', previewPath]] : [])]) {
          const absolute = join(getAppConfig().storageDir, target);
          mkdirSync(dirname(absolute), { recursive: true });
          copyFileSync(join(directory, source), absolute);
          copied.push(absolute);
          stagedGarbage.push({ storagePath: relative(getAppConfig().storageDir, join(directory, source)).split(sep).join('/'), fileKind: 'other' });
        }
        row = { id: assetId, originalName: stage.originalName, mimeType: stage.mimeType, fileSize: stage.fileSize,
          sha256: stage.sha256, width: stage.width, height: stage.height, storagePath, thumbnailPath, previewPath, sortOrder: index };
      }
      if (seen.has(row.sha256)) fail(409, '同一条补充记录中不能重复添加相同图片');
      seen.add(row.sha256);
      rows.push({ ...row, sortOrder: index });
    }
    const now = new Date(Math.max(Date.now(), previous ? Date.parse(previous.updatedAt) + 1 : 0)).toISOString();
    if (previous) db.prepare('UPDATE report_notes SET content_text = ?, updated_at = ? WHERE id = ?').run(contentText, now, id);
    else db.prepare('INSERT INTO report_notes(id, report_id, content_text, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, reportId, contentText, user.id, now, now);
    const removed = existing.filter(asset => !rows.some(row => row.id === asset.id));
    for (const row of removed) db.prepare('DELETE FROM report_note_assets WHERE id = ?').run(row.id);
    const insert = db.prepare(`INSERT INTO report_note_assets(id, note_id, original_name, storage_path, thumbnail_path, preview_path,
      mime_type, file_size, sha256, width, height, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET sort_order = excluded.sort_order`);
    for (const row of rows) insert.run(row.id, id, row.originalName, row.storagePath, row.thumbnailPath, row.previewPath, row.mimeType, row.fileSize, row.sha256, row.width, row.height, row.sortOrder);
    enqueueFileGarbage(garbage(removed), 'report_note_asset_delete', db);
    // Keep only stage metadata for idempotent retries; committed payload copies
    // use the existing delayed GC instead of occupying disk until stage expiry.
    enqueueFileGarbage(stagedGarbage, 'report_note_stage_committed', db);
    audit(user, reportId, id, previous ? 'report.note.update' : 'report.note.create', rows.length);
    const added = rows.filter(row => !existing.some(asset => asset.id === row.id)).length;
    if (added) audit(user, reportId, id, 'report.note.asset.upload', added);
    if (removed.length) audit(user, reportId, id, 'report.note.asset.delete', removed.length);
    db.exec('COMMIT');
    return { ...requireNote(reportId, id), assets: rows.map(publicAsset) };
  } catch (error) {
    db.exec('ROLLBACK');
    for (const path of copied) rmSync(path, { force: true });
    throw error;
  }
}
export function deleteReportNote(user: RequestUser, reportId: string, noteId: string) {
  assertReportNoteAccess(user, reportId, true);
  requireNote(reportId, noteId);
  const db = getDatabase();
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('UPDATE report_notes SET deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(noteId);
    audit(user, reportId, noteId, 'report.note.delete', assetRows(noteId).length);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  // Soft-deleted assets stay referenced until the report is permanently purged.
  return { deleted: true };
}
export function getReportNoteImage(user: RequestUser, reportId: string, noteId: string, assetId: string, variant: string) {
  assertReportNoteAccess(user, reportId);
  requireNote(reportId, noteId);
  const row = assetRows(noteId).find(asset => asset.id === assetId) || fail(404, '图片不存在');
  if (!['original', 'thumbnail', 'preview'].includes(variant)) fail(400, '图片版本无效');
  const relativePath = variant === 'thumbnail' ? row.thumbnailPath : variant === 'preview' ? row.previewPath || row.storagePath : row.storagePath;
  const root = realpathSync(getAppConfig().storageDir);
  const path = resolve(root, relativePath);
  if (!path.startsWith(`${root}${sep}`) || !existsSync(path) || !realpathSync(path).startsWith(`${root}${sep}`) || !lstatSync(path).isFile()) fail(404, '图片文件不存在');
  return { path, mimeType: variant === 'thumbnail' || (variant === 'preview' && row.previewPath) ? 'image/jpeg' : row.mimeType };
}
