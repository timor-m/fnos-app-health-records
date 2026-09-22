import { existsSync, lstatSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { getDatabase, runInTransaction } from "../database/client";
import { createId } from "../utils/identifier";
import { getAppConfig } from "../utils/runtime-config";

export type FileGarbageCandidate = {
  storagePath: string | null | undefined;
  fileKind: "original" | "thumbnail" | "other";
};

type FileGarbageRow = {
  id: string;
  storagePath: string;
};

function safeStoragePath(relativePath: string) {
  const root = resolve(getAppConfig().storageDir);
  const target = resolve(root, relativePath);
  if (!relativePath || target === root || !target.startsWith(`${root}${sep}`)) {
    throw new Error("文件清理路径无效");
  }
  // A lexical child can still escape through a symlinked parent directory.
  let parent = dirname(target);
  while (!existsSync(parent) && parent !== root) parent = dirname(parent);
  const physicalRoot = realpathSync(root);
  const physicalParent = realpathSync(parent);
  if (physicalParent !== physicalRoot && !physicalParent.startsWith(`${physicalRoot}${sep}`)) {
    throw new Error("文件清理路径无效");
  }
  return { root, target };
}

function referencedFileCount(db: DatabaseSync, storagePath: string) {
  const row = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM report_page_append_files f JOIN report_page_appends b ON b.id=f.batch_id WHERE f.storage_path=? AND b.state NOT IN ('cancelled','noop','complete','ocr_only')) +
      (SELECT COUNT(*) FROM report_page_append_pages p JOIN report_page_append_files f ON f.id=p.file_id JOIN report_page_appends b ON b.id=f.batch_id WHERE p.thumbnail_path=? AND b.state NOT IN ('cancelled','noop','complete','ocr_only')) +
      (SELECT COUNT(*) FROM report_pages WHERE storage_path = ?) +
      (SELECT COUNT(*) FROM report_pages WHERE thumbnail_path = ?) +
      (SELECT COUNT(*) FROM health_members WHERE avatar_path = ?) +
      (SELECT COUNT(*) FROM report_note_assets WHERE storage_path = ? OR thumbnail_path = ? OR preview_path = ?) +
      (SELECT COUNT(*) FROM reports WHERE ? LIKE 'previews/' || id || '/%'
        OR ? LIKE 'previews/vision/' || id || '/%'
        OR ? LIKE 'report-exports/' || id || '-%.pdf') AS count
  `).get(storagePath, storagePath, storagePath, storagePath, storagePath, storagePath, storagePath, storagePath, storagePath, storagePath, storagePath) as { count: number };
  return Number(row.count || 0);
}

export function enqueueFileGarbage(
  candidates: FileGarbageCandidate[],
  reason: string,
  db: DatabaseSync = getDatabase(),
  delayMinutes = 10,
  memberId?: string
) {
  const unique = new Map<string, FileGarbageCandidate["fileKind"]>();
  for (const candidate of candidates) {
    const path = candidate.storagePath?.trim();
    if (path) unique.set(path, candidate.fileKind);
  }
  const insert = db.prepare(`
    INSERT INTO file_gc_queue (
      id, storage_path, file_kind, reason, not_before, completed_at, updated_at
    ) VALUES (?, ?, ?, ?, datetime('now', ?), NULL, CURRENT_TIMESTAMP)
    ON CONFLICT(storage_path) DO UPDATE SET
      file_kind = excluded.file_kind,
      reason = excluded.reason,
      not_before = CASE WHEN excluded.reason = 'orphan_scan' AND file_gc_queue.completed_at IS NULL
        THEN file_gc_queue.not_before ELSE excluded.not_before END,
      completed_at = NULL,
      last_error = CASE WHEN file_gc_queue.completed_at IS NULL THEN file_gc_queue.last_error ELSE NULL END,
      attempts = CASE WHEN file_gc_queue.completed_at IS NULL THEN file_gc_queue.attempts ELSE 0 END,
      updated_at = CURRENT_TIMESTAMP
    RETURNING id
  `);
  const delay = `+${Math.max(0, Math.round(delayMinutes))} minutes`;
  db.exec("SAVEPOINT enqueue_file_garbage");
  try {
    for (const [storagePath, fileKind] of unique) {
      db.prepare(`DELETE FROM file_gc_members WHERE gc_id IN
        (SELECT id FROM file_gc_queue WHERE storage_path=? AND completed_at IS NOT NULL)`).run(storagePath);
      const row = insert.get(createId("file_gc"), storagePath, fileKind, reason.slice(0, 80), delay) as {id:string};
      if (memberId) db.prepare("INSERT OR IGNORE INTO file_gc_members(gc_id,member_id) VALUES(?,?)").run(row.id,memberId);
    }
    db.exec("RELEASE enqueue_file_garbage");
  } catch (error) {
    db.exec("ROLLBACK TO enqueue_file_garbage; RELEASE enqueue_file_garbage");
    throw error;
  }
  return unique.size;
}

function pruneEmptyParents(path: string, root: string) {
  let current = dirname(path);
  for (let depth = 0; depth < 3 && current !== root && current.startsWith(`${root}${sep}`); depth += 1) {
    try {
      if (readdirSync(current).length) break;
      rmSync(current, { recursive: false });
      current = dirname(current);
    } catch {
      break;
    }
  }
}

function completeFileGarbage(db: DatabaseSync, id: string) {
  runInTransaction(db, () => {
    db.prepare("UPDATE file_gc_queue SET completed_at=CURRENT_TIMESTAMP,last_error=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(id);
    db.prepare("DELETE FROM file_gc_members WHERE gc_id=?").run(id);
  });
}

export function runFileGarbageCollection(limit = 100) {
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT id, storage_path AS storagePath
    FROM file_gc_queue
    WHERE completed_at IS NULL AND not_before <= CURRENT_TIMESTAMP
    ORDER BY not_before, created_at
    LIMIT ?
  `).all(Math.min(500, Math.max(1, Math.round(limit)))) as FileGarbageRow[];
  return collectFileGarbageRows(db, rows);
}

// Only the committed purge's paths, never the whole member/global queue.
export function collectReportFileGarbage(candidates: FileGarbageCandidate[], db: DatabaseSync = getDatabase()) {
  const paths = new Set(candidates.map(candidate => candidate.storagePath?.trim()).filter((path):path is string => Boolean(path)));
  const select = db.prepare("SELECT id,storage_path AS storagePath FROM file_gc_queue WHERE storage_path=? AND completed_at IS NULL");
  const rows = [...paths].map(path => select.get(path) as FileGarbageRow | undefined).filter((row):row is FileGarbageRow => Boolean(row));
  return collectFileGarbageRows(db, rows);
}

function collectFileGarbageRows(db: DatabaseSync, rows: FileGarbageRow[]) {
  let deleted = 0;
  let retained = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      if (referencedFileCount(db, row.storagePath) > 0) {
        completeFileGarbage(db, row.id);
        retained += 1;
        continue;
      }
      const { root, target } = safeStoragePath(row.storagePath);
      rmSync(target, { force: true });
      pruneEmptyParents(target, root);
      completeFileGarbage(db, row.id);
      deleted += 1;
    } catch (error) {
      db.prepare(`
        UPDATE file_gc_queue
        SET attempts = attempts + 1,
          last_error = ?,
          not_before = datetime('now', CASE WHEN attempts >= 5 THEN '+24 hours' ELSE '+1 hour' END),
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(error instanceof Error ? error.message.slice(0, 500) : "文件删除失败", row.id);
      failed += 1;
    }
  }
  return { checked: rows.length, deleted, retained, failed };
}

function referencedStoragePaths() {
  const db = getDatabase();
  const paths = new Set<string>();
  const pages = db.prepare(`
    SELECT storage_path AS storagePath, thumbnail_path AS thumbnailPath FROM report_pages
  `).all() as Array<{ storagePath: string; thumbnailPath: string | null }>;
  for (const page of pages) {
    if (page.storagePath) paths.add(page.storagePath);
    if (page.thumbnailPath) paths.add(page.thumbnailPath);
  }
  const avatars = db.prepare("SELECT avatar_path AS avatarPath FROM health_members WHERE avatar_path IS NOT NULL")
    .all() as Array<{ avatarPath: string }>;
  for (const avatar of avatars) paths.add(avatar.avatarPath);
  const assets = db.prepare('SELECT storage_path, thumbnail_path, preview_path FROM report_note_assets').all() as Array<{ storage_path: string; thumbnail_path: string; preview_path: string | null }>;
  for (const asset of assets) for (const path of [asset.storage_path, asset.thumbnail_path, asset.preview_path]) if (path) paths.add(path);
  const drafts = db.prepare(`SELECT f.storage_path,p.thumbnail_path FROM report_page_append_files f JOIN report_page_appends b ON b.id=f.batch_id LEFT JOIN report_page_append_pages p ON p.file_id=f.id WHERE b.state NOT IN ('cancelled','noop','complete','ocr_only')`).all() as Array<{storage_path:string;thumbnail_path:string|null}>;
  for (const draft of drafts) for (const path of [draft.storage_path,draft.thumbnail_path]) if(path) paths.add(path);
  return paths;
}

export function scanOrphanStorageFiles(minimumAgeMs = 24 * 60 * 60_000) {
  const storageRoot = resolve(getAppConfig().storageDir);
  const referenced = referencedStoragePaths();
  const candidates: FileGarbageCandidate[] = [];
  const cutoff = Date.now() - minimumAgeMs;

  function walk(directory: string) {
    if (!existsSync(directory)) return;
    for (const name of readdirSync(directory)) {
      const absolutePath = join(directory, name);
      try {
        const stats = lstatSync(absolutePath);
        if (stats.isSymbolicLink()) continue;
        if (stats.isDirectory()) {
          walk(absolutePath);
          continue;
        }
        if (!stats.isFile() || stats.mtimeMs > cutoff) continue;
        const storagePath = relative(storageRoot, absolutePath).split(sep).join("/");
        if (!referenced.has(storagePath)) {
          candidates.push({
            storagePath,
            fileKind: storagePath.startsWith("thumbnails/") ? "thumbnail" : "original"
          });
        }
      } catch {
        // Files may disappear while a Worker or another maintenance cycle is finishing.
      }
    }
  }

  walk(join(storageRoot, "reports"));
  walk(join(storageRoot, "thumbnails"));
  walk(join(storageRoot, "report-notes"));
  return { scannedRoots: 3, queued: enqueueFileGarbage(candidates, "orphan_scan", getDatabase(), 0) };
}
