import { appendReviewWarnings } from "./page-append-result-guard.service";
import { normalizeReportObservations } from "./indicator-normalization.service";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  rmSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { createError } from "h3";
import { getDatabase, runInTransaction } from "../database/client";
import type { RequestUser } from "../domain/request-user";
import { createId } from "../utils/identifier";
import { getAppConfig } from "../utils/runtime-config";
import { storageMigrationPaused } from "../utils/storage-migration-state";
import { assertMemberManage } from "./member.service";
import { assertNoPageAppend } from "./page-append-lock.service";
import {
  detectUploadType,
  validateLocalFiles,
  persistValidatedFile,
} from "./upload.service";
import { maxUploadFileBytes } from "../../shared/upload-limits";
import { enqueueFileGarbage } from "./file-gc.service";
import type { WorkerRequest, WorkerResponse } from "./ocr-worker-client";
import {
  isAiExtractionConfigured,
  persistAiExtraction,
  type AiExecutor,
} from "./ai-extraction.service";
import { executeAiExtractionPlan } from "./ai-extraction-orchestrator.service";

const terminal = new Set(["complete", "ocr_only", "noop", "cancelled"]);
const hash = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
function conflict(message: string): never {
  throw createError({
    statusCode: 409,
    data: { code: "UPLOAD_CONFLICT" },
    statusMessage: message,
  });
}
function invalid(message: string): never {
  throw createError({
    statusCode: 400,
    data: { code: "UPLOAD_INVALID" },
    statusMessage: message,
  });
}
type Batch = {
  id: string;
  report_id: string;
  actor_id: string;
  provider: RequestUser["provider"];
  state: string;
  phase: string;
  base_version: number;
  published: number;
  job_id: string | null;
  selection_hash: string | null;
  confirmation_hash: string | null;
  manifest_hash: string;
  error_message: string | null;
  conflicts_json: string;
  result_version: number | null;
  input_hash: string | null;
  attempt?: number;
};
type FileRow = {
  id: string;
  batch_id: string;
  position: number;
  original_name: string;
  file_size: number;
  storage_path: string;
  sha256: string | null;
  mime_type: string | null;
  page_count: number | null;
  error_message: string | null;
};
type Page = {
  id: string;
  file_id: string;
  source_page_number: number;
  rotation: number;
  position: number | null;
  duplicate: number;
  thumbnail_path: string | null;
  ocr_json: string | null;
  storage_path: string;
  mime_type: string;
  original_name: string;
  file_size: number;
  sha256: string;
  source_page_count: number;
};
function report(user: RequestUser, id: string) {
  const row = getDatabase()
    .prepare(
      "SELECT member_id,source_version,status FROM reports WHERE id=? AND status<>'trashed'",
    )
    .get(id) as
    { member_id: string; source_version: number; status: string } | undefined;
  if (!row)
    throw createError({
      statusCode: 404,
      statusMessage: "报告不存在或已移入回收站",
    });
  assertMemberManage(user, row.member_id);
  if (storageMigrationPaused()) conflict("存储维护期间暂不可补充报告页");
  return row;
}
function batchFor(user: RequestUser, reportId: string, id: string) {
  report(user, reportId);
  const row = getDatabase()
    .prepare(
      "SELECT * FROM report_page_appends WHERE id=? AND report_id=? AND actor_id=?",
    )
    .get(id, reportId, user.id) as Batch | undefined;
  if (!row)
    throw createError({ statusCode: 404, statusMessage: "补充批次不存在" });
  return row;
}
const files = (id: string) =>
  getDatabase()
    .prepare(
      "SELECT * FROM report_page_append_files WHERE batch_id=? ORDER BY position",
    )
    .all(id) as FileRow[];
const pages = (id: string) =>
  getDatabase()
    .prepare(
      `SELECT p.*,f.storage_path,f.mime_type,f.original_name,f.file_size,f.sha256,f.page_count AS source_page_count FROM report_page_append_pages p JOIN report_page_append_files f ON f.id=p.file_id WHERE f.batch_id=? ORDER BY COALESCE(p.position,2147483647),f.position,p.source_page_number`,
    )
    .all(id) as Page[];
function queue(batch: Batch, phase: string) {
  const db = getDatabase(),
    job = createId("job");
  db.prepare(
    "INSERT INTO processing_jobs(id,report_id,job_type,pipeline_version,deduplication_key) VALUES(?, ?, ?, 'page-append-v1', ?)",
  ).run(
    job,
    batch.report_id,
    phase === "prepare"
      ? "pdf_extract"
      : phase === "ocr"
        ? "ocr"
        : "ai_extract",
    `${batch.id}:${phase}:${job}`,
  );
  db.prepare(
    "INSERT INTO processing_job_events(id,job_id,report_id,event_type,status,detail_json) VALUES(?,?,?,'queued','queued',?)",
  ).run(
    createId("event"),
    job,
    batch.report_id,
    JSON.stringify({ source: "page_append", batchId: batch.id }),
  );
  db.prepare(
    "UPDATE report_page_appends SET job_id=?,phase=?,state=?,error_message=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?",
  ).run(job, phase, phase === "prepare" ? "preparing" : phase, batch.id);
}
export function startPageAppend(
  user: RequestUser,
  reportId: string,
  input: { requestKey: string; files: Array<{ name: string; size: number }> },
) {
  const r = report(user, reportId);
  if (
    !input ||
    !/^[a-zA-Z0-9_-]{16,100}$/.test(input.requestKey || "") ||
    !Array.isArray(input.files) ||
    !input.files.length ||
    input.files.length > 1000
  )
    invalid("补充文件清单无效");
  let size = 0;
  const manifest = input.files.map((f) => {
    if (
      !f ||
      !Number.isSafeInteger(f.size) ||
      f.size < 1 ||
      f.size > maxUploadFileBytes
    )
      invalid("单个文件不能为空或超过 40 MB");
    size += f.size;
    return {
      name: String(f.name || "报告页")
        .replace(/[\u0000-\u001f]/g, "")
        .slice(0, 180),
      size: f.size,
    };
  });
  if (size > 2 * 1024 ** 3) invalid("单批文件不能超过 2 GB");
  const fingerprint = hash(JSON.stringify({ reportId, files: manifest }));
  const db = getDatabase();
  let id = "";
  runInTransaction(db, () => {
    const old = db
      .prepare(
        "SELECT * FROM report_page_appends WHERE actor_id=? AND request_key=?",
      )
      .get(user.id, input.requestKey) as Batch | undefined;
    if (old) {
      if (old.manifest_hash !== fingerprint)
        conflict("同一请求编号的文件清单不一致");
      id = old.id;
      return;
    }
    assertNoPageAppend(reportId);
    if (
      db
        .prepare(
          "SELECT 1 FROM processing_jobs WHERE report_id=? AND status IN ('queued','processing')",
        )
        .get(reportId)
    )
      conflict("报告正在处理中，请完成后补充");
    const batchId = createId("append");
    db.prepare(
      "INSERT INTO report_page_appends(id,report_id,actor_id,provider,request_key,manifest_hash,base_version) VALUES(?,?,?,?,?,?,?)",
    ).run(
      batchId,
      reportId,
      user.id,
      user.provider,
      input.requestKey,
      fingerprint,
      r.source_version,
    );
    manifest.forEach((f, i) =>
      db
        .prepare(
          "INSERT INTO report_page_append_files(id,batch_id,position,original_name,file_size,storage_path) VALUES(?,?,?,?,?,?)",
        )
        .run(
          createId("file"),
          batchId,
          i,
          f.name,
          f.size,
          `reports/${hash(reportId)}/appends/${batchId}/${i}.bin`,
        ),
    );
    id = batchId;
  });
  return getPageAppend(user, reportId, id);
}
export function getPageAppend(user: RequestUser, reportId: string, id: string) {
  const b = batchFor(user, reportId, id);
  return {
    id: b.id,
    state: b.state,
    phase: b.phase,
    published: Boolean(b.published),
    resultVersion: b.result_version,
    aiProgress:
      b.phase === "ai"
        ? (getDatabase()
            .prepare(
              `SELECT COUNT(*) AS total,
      COALESCE(SUM(CASE WHEN status IN ('completed','warning') THEN 1 ELSE 0 END),0) AS completed
      FROM ai_extraction_units WHERE job_id=? AND status <> 'superseded'`,
            )
            .get(b.job_id) as { total: number; completed: number })
        : null,
    error: b.error_message,
    reviewWarnings:
      [...JSON.parse(b.conflicts_json).filter((message: string) => message.startsWith("新增页与已有页文字高度相似")), ...(b.state === "complete" ? appendReviewWarnings(b.job_id) : [])],
    conflicts: JSON.parse(b.conflicts_json) as string[],
    files: files(id).map((f) => ({
      id: f.id,
      name: f.original_name,
      size: f.file_size,
      received: Boolean(f.sha256),
      pageCount: f.page_count,
      error: f.error_message,
    })),
    pages: pages(id).map((p) => ({
      id: p.id,
      fileId: p.file_id,
      name: p.original_name,
      sourcePageNumber: p.source_page_number,
      rotation: p.rotation,
      position: p.position,
      duplicate: Boolean(p.duplicate),
      hasPreview: Boolean(p.thumbnail_path),
      ocrComplete: Boolean(p.ocr_json),
    })),
  };
}
export function latestPageAppend(user: RequestUser, reportId: string) {
  report(user, reportId);
  const row = getDatabase()
    .prepare(
      "SELECT id FROM report_page_appends WHERE report_id=? AND actor_id=? ORDER BY rowid DESC LIMIT 1",
    )
    .get(reportId, user.id) as { id: string } | undefined;
  return row ? getPageAppend(user, reportId, row.id) : null;
}
export function storePageAppendFile(
  user: RequestUser,
  reportId: string,
  id: string,
  fileId: string,
  data: Uint8Array,
) {
  const b = batchFor(user, reportId, id),
    f = files(id).find((f) => f.id === fileId);
  if (!f) invalid("文件不属于此批次");
  const digest = hash(data);
  if (f.sha256) {
    if (f.sha256 !== digest) conflict("重试文件内容不一致");
    return getPageAppend(user, reportId, id);
  }
  if (b.state !== "uploading") conflict("批次已提交");
  const detected = detectUploadType(data);
  if (data.length !== f.file_size || !detected)
    invalid("文件大小或实际格式不正确");
  const path = join(getAppConfig().storageDir, f.storage_path);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${createId("tmp")}`;
  writeFileSync(temporary, data, { mode: 0o600 });
  try {
    runInTransaction(getDatabase(), () => {
      const current = batchFor(user, reportId, id);
      const stored = files(id).find((file) => file.id === fileId)!;
      if (stored.sha256) {
        if (stored.sha256 !== digest) conflict("重试文件内容不一致");
        return;
      }
      if (current.state !== "uploading") conflict("批次已提交");
      renameSync(temporary, path);
      getDatabase()
        .prepare(
          "UPDATE report_page_append_files SET sha256=?,mime_type=? WHERE id=?",
        )
        .run(digest, detected.mimeType, f.id);
      if (files(id).every((file) => file.sha256)) queue(current, "prepare");
    });
  } finally {
    rmSync(temporary, { force: true });
  }
  return getPageAppend(user, reportId, id);
}
export function submitPageAppend(
  user: RequestUser,
  reportId: string,
  id: string,
  selected: Array<{ id: string; rotation: number }>,
) {
  const b = batchFor(user, reportId, id),
    all = pages(id);
  if (
    !Array.isArray(selected) ||
    !selected.length ||
    selected.length > 10000 ||
    selected.some((p) => !p || typeof p.id !== "string") ||
    new Set(selected.map((p) => p.id)).size !== selected.length
  )
    invalid("请选择有效页面");
  if (
    selected.some(
      (p) =>
        !all.some((a) => a.id === p.id) ||
        ![0, 90, 180, 270].includes(p.rotation),
    )
  )
    invalid("页面或旋转角度无效");
  const fingerprint = hash(JSON.stringify(selected));
  if (b.selection_hash) {
    if (b.selection_hash !== fingerprint)
      conflict("已提交的页面顺序或选择不能改变");
    return getPageAppend(user, reportId, id);
  }
  if (b.state !== "ready") conflict("请等待文件预处理完成");
  runInTransaction(getDatabase(), () => {
    if (report(user, reportId).source_version !== b.base_version)
      conflict("报告已修改，请放弃本批次后重新补充");
    const seen = new Set(
      (
        getDatabase()
          .prepare(
            "SELECT sha256,mime_type,source_page_number FROM report_pages WHERE report_id=?",
          )
          .all(reportId) as Array<{
          sha256: string;
          mime_type: string;
          source_page_number: number | null;
        }>
      ).map(
        (p) =>
          `${p.sha256}:${p.mime_type === "application/pdf" ? p.source_page_number || 1 : 0}`,
      ),
    );
    let included = 0;
    selected.forEach((s, i) => {
      const p = all.find((p) => p.id === s.id)!;
      const key = `${p.sha256}:${p.mime_type === "application/pdf" ? p.source_page_number : 0}`,
        duplicate = seen.has(key);
      seen.add(key);
      if (!duplicate) included++;
      getDatabase()
        .prepare(
          "UPDATE report_page_append_pages SET position=?,rotation=?,duplicate=? WHERE id=?",
        )
        .run(i, s.rotation, Number(duplicate), p.id);
    });
    getDatabase()
      .prepare("UPDATE report_page_appends SET selection_hash=? WHERE id=?")
      .run(fingerprint, id);
    if (included) queue(b, "ocr");
    else
      getDatabase()
        .prepare(
          "UPDATE report_page_appends SET state='noop',error_message='没有新增页面，报告未改变' WHERE id=?",
        )
        .run(id);
  });
  return getPageAppend(user, reportId, id);
}
export function cancelPageAppend(
  user: RequestUser,
  reportId: string,
  id: string,
) {
  const b = batchFor(user, reportId, id),
    db = getDatabase();
  if (b.published) conflict("原件已发布，不能放弃；可重试识别或保留 OCR 结果");
  runInTransaction(db, () => {
    db.prepare(
      "UPDATE processing_jobs SET status='cancelled',lease_expires_at=NULL,finished_at=CURRENT_TIMESTAMP WHERE id=? AND status IN ('queued','processing')",
    ).run(b.job_id);
    db.prepare(
      "UPDATE report_page_appends SET state='cancelled' WHERE id=?",
    ).run(id);
    const paths = [
      ...files(id).map((f) => f.storage_path),
      ...pages(id).map((p) => p.thumbnail_path),
    ].filter(Boolean) as string[];
    enqueueFileGarbage(
      paths.map((storagePath) => ({ storagePath, fileKind: "other" })),
      "page_append_cancel",
      db,
    );
  });
  return { cancelled: true };
}
export function retryPageAppend(
  user: RequestUser,
  reportId: string,
  id: string,
  keepOcr = false,
) {
  const b = batchFor(user, reportId, id);
  if (b.state !== "failed") conflict("此批次无需重试");
  runInTransaction(getDatabase(), () => {
    if (keepOcr && b.published)
      getDatabase()
        .prepare("UPDATE report_page_appends SET state='ocr_only' WHERE id=?")
        .run(id);
    else {
      getDatabase()
        .prepare(
          "UPDATE processing_jobs SET status='queued',error_code=NULL,error_message=NULL,finished_at=NULL,next_retry_at=NULL,lease_expires_at=NULL WHERE id=? AND status='failed'",
        )
        .run(b.job_id);
      getDatabase()
        .prepare(
          "UPDATE report_page_appends SET state=?,error_message=NULL WHERE id=?",
        )
        .run(b.phase === "prepare" ? "preparing" : b.phase, b.id);
    }
  });
  return getPageAppend(user, reportId, id);
}
export function pageAppendPreview(
  user: RequestUser,
  reportId: string,
  id: string,
  pageId: string,
) {
  batchFor(user, reportId, id);
  const p = pages(id).find((p) => p.id === pageId);
  if (
    !p?.thumbnail_path ||
    !existsSync(join(getAppConfig().storageDir, p.thumbnail_path))
  )
    throw createError({ statusCode: 404, statusMessage: "预览尚未生成" });
  return join(getAppConfig().storageDir, p.thumbnail_path);
}
function actor(b: Batch): RequestUser {
  return {
    id: b.actor_id,
    provider: b.provider,
    displayName: "",
    authenticated: true,
    isGatewayAdmin: false,
  };
}
function check(b: Batch) {
  const current = batchFor(actor(b), b.report_id, b.id);
  if (terminal.has(current.state)) conflict("批次已停止");
  if (current.job_id !== b.job_id) conflict("任务已被新的尝试取代");
  if (b.attempt !== undefined) {
    const job = getDatabase()
      .prepare("SELECT status,attempts FROM processing_jobs WHERE id=?")
      .get(b.job_id) as { status: string; attempts: number } | undefined;
    if (!job || job.status !== "processing" || job.attempts !== b.attempt)
      conflict("任务租约已失效");
  }
  if (
    current.input_hash &&
    current.phase === "ai" &&
    current.input_hash !== reportInputFingerprint(b.report_id)
  )
    conflict("识别期间报告内容已变化，旧结果不会覆盖当前内容");
  if (report(actor(b), b.report_id).source_version !== current.base_version)
    conflict("报告内容已变化，旧识别结果不会覆盖当前内容");
}
function publish(b: Batch, keepIds?: string[]) {
  const db = getDatabase();
  runInTransaction(db, () => {
    check(b);
    if (b.published) return;
    if (keepIds !== undefined) {
      const allowed = pages(b.id)
        .filter((p) => p.position !== null && !p.duplicate)
        .map((p) => p.id);
      if (
        !Array.isArray(keepIds) ||
        new Set(keepIds).size !== keepIds.length ||
        keepIds.some((id) => !allowed.includes(id))
      )
        invalid("确认页必须来自已提交的新增页面");
      db.prepare(
        "UPDATE report_page_appends SET confirmation_hash=? WHERE id=?",
      ).run(hash(JSON.stringify([...keepIds].sort())), b.id);
      for (const id of allowed.filter((id) => !keepIds.includes(id)))
        db.prepare(
          "UPDATE report_page_append_pages SET position=NULL WHERE id=?",
        ).run(id);
      if (!keepIds.length) {
        db.prepare(
          "UPDATE report_page_appends SET state='noop',error_message='没有新增页面，报告未改变' WHERE id=?",
        ).run(b.id);
        return;
      }
    }
    let number = Number(
      (
        db
          .prepare(
            "SELECT COALESCE(MAX(page_number),0) AS n FROM report_pages WHERE report_id=?",
          )
          .get(b.report_id) as { n: number }
      ).n,
    );
    for (const p of pages(b.id).filter(
      (p) => p.position !== null && !p.duplicate,
    )) {
      if (!p.ocr_json) conflict("页面 OCR 尚未完成");
      db.prepare(
        "INSERT INTO report_pages(id,report_id,page_number,original_name,storage_path,thumbnail_path,mime_type,file_size,sha256,rotation,source_page_number,source_page_count) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
      ).run(
        p.id,
        b.report_id,
        ++number,
        p.original_name,
        p.storage_path,
        p.thumbnail_path,
        p.mime_type,
        p.file_size,
        p.sha256,
        p.rotation,
        p.mime_type === "application/pdf" ? p.source_page_number : null,
        p.mime_type === "application/pdf" ? p.source_page_count : null,
      );
      const response = JSON.parse(p.ocr_json) as WorkerResponse;
      const ocrJob = createId("job");
      db.prepare(
        "INSERT INTO processing_jobs(id,report_id,page_id,job_type,status,pipeline_version,deduplication_key,finished_at) VALUES(?,?,?,'ocr','completed','page-append-v1',?,CURRENT_TIMESTAMP)",
      ).run(ocrJob, b.report_id, p.id, `${b.id}:${p.id}:ocr`);
      db.prepare(
        "INSERT INTO processing_job_events(id,job_id,report_id,event_type,status,detail_json) VALUES(?,?,?,'queued','queued',?)",
      ).run(
        createId("event"),
        ocrJob,
        b.report_id,
        JSON.stringify({ source: "page_append", batchId: b.id }),
      );
      db.prepare(
        "INSERT INTO ocr_results(id,job_id,page_id,engine,model_version,lines_json,text_length,coord_width,coord_height) VALUES(?,?,?,?,?,?,?,?,?)",
      ).run(
        createId("ocr"),
        ocrJob,
        p.id,
        response.engine || "worker",
        response.modelVersion || "unknown",
        JSON.stringify(response.lines || []),
        (response.lines || []).map((line) => String(line.text || "")).join("\n")
          .length,
        response.coordWidth || null,
        response.coordHeight || null,
      );
    }
    db.prepare(
      "UPDATE reports SET source_version=source_version+1,updated_at=CURRENT_TIMESTAMP WHERE id=?",
    ).run(b.report_id);
    db.prepare(
      "UPDATE report_page_appends SET published=1,base_version=base_version+1 WHERE id=?",
    ).run(b.id);
    b.published = 1;
    b.base_version++;
    db.prepare(
      "UPDATE processing_jobs SET status='completed',finished_at=CURRENT_TIMESTAMP,lease_expires_at=NULL WHERE id=?",
    ).run(b.job_id);
    db.prepare("UPDATE report_page_appends SET input_hash=? WHERE id=?").run(
      reportInputFingerprint(b.report_id),
      b.id,
    );
    if (isAiExtractionConfigured()) queue(b, "ai");
    else
      db.prepare(
        "UPDATE report_page_appends SET state='ocr_only',error_message='原件和 OCR 已保存，AI 未启用，旧识别结果已保留' WHERE id=?",
      ).run(b.id);
  });
}
export function confirmPageAppend(
  user: RequestUser,
  reportId: string,
  id: string,
  keepIds?: string[],
) {
  const b = batchFor(user, reportId, id);
  if (b.published || b.state === "noop") {
    if (
      keepIds !== undefined &&
      (!Array.isArray(keepIds) ||
        hash(JSON.stringify([...keepIds].sort())) !== b.confirmation_hash)
    )
      conflict("重试确认的页面范围不一致");
    return getPageAppend(user, reportId, id);
  }
  if (b.state !== "review") conflict("当前批次无需确认");
  publish(
    b,
    keepIds ??
      pages(id)
        .filter((p) => p.position !== null && !p.duplicate)
        .map((p) => p.id),
  );
  return getPageAppend(user, reportId, id);
}
// Similar templates are advisory; only identity conflicts and unreadable content block publication.
function findConflicts(b: Batch) {
  const old = getDatabase()
    .prepare(
      "SELECT o.lines_json FROM ocr_results o JOIN report_pages p ON p.id=o.page_id WHERE p.report_id=?",
    )
    .all(b.report_id) as { lines_json: string }[];
  const text = (lines: Array<Record<string, unknown>>) =>
    lines.map((l) => String(l.text || "")).join("\n");
  const oldTexts = old.map((o) => text(JSON.parse(o.lines_json)));
  const messages = new Set<string>();
  for (const p of pages(b.id).filter(
    (p) => p.position !== null && !p.duplicate,
  )) {
    const next = text((JSON.parse(p.ocr_json!) as WorkerResponse).lines || []);
    if (!next.trim())
      messages.add("新增页未识别到文字，请核对原件清晰度或页面内容");
    if (oldTexts.some((t) => similarText(t, next)))
      messages.add("新增页与已有页文字高度相似，请核对是否重复");
    // A member's archive can contain multiple examinations; only identity differences
    // require confirmation here. Examination dates and numbers are resolved per result.
    for (const label of ["姓名"]) {
      const re = new RegExp(`${label}[：: ]+([^\\s，,;；]+)`, "g");
      const before = new Set(
        oldTexts.flatMap((t) => [...t.matchAll(re)].map((m) => m[1])),
      );
      const after = [...next.matchAll(re)].map((m) => m[1]);
      if (before.size && after.some((v) => !before.has(v)))
        messages.add(`${label}与已有原件不一致，请确认属于当前成员`);
    }
    oldTexts.push(next);
  }
  return [...messages];
}
export async function processPageAppendJob(
  jobId: string,
  worker: (request: WorkerRequest) => Promise<WorkerResponse>,
  ai: AiExecutor,
) {
  const db = getDatabase(),
    b = db
      .prepare("SELECT * FROM report_page_appends WHERE job_id=?")
      .get(jobId) as Batch | undefined;
  if (!b) return false;
  if (["complete", "ocr_only", "noop"].includes(b.state)) {
    db.prepare(
      "UPDATE processing_jobs SET status='completed',finished_at=CURRENT_TIMESTAMP,lease_expires_at=NULL WHERE id=?",
    ).run(jobId);
    return true;
  }
  b.attempt = (
    db
      .prepare("SELECT attempts FROM processing_jobs WHERE id=?")
      .get(jobId) as { attempts: number }
  ).attempts;
  const work = async (request: WorkerRequest) => {
    check(b);
    const file = files(b.id).find(
      (file) =>
        join(getAppConfig().storageDir, file.storage_path) ===
        request.imagePath,
    );
    try {
      const response = await worker(request);
      check(b);
      if (!response.ok) throw new Error("页面处理失败，请检查文件后重试");
      if (file)
        db.prepare(
          "UPDATE report_page_append_files SET error_message=NULL WHERE id=?",
        ).run(file.id);
      return response;
    } catch (error) {
      if (file)
        db.prepare(
          "UPDATE report_page_append_files SET error_message='此文件处理未完成，可重试' WHERE id=? AND EXISTS(SELECT 1 FROM processing_jobs WHERE id=? AND attempts=? AND status='processing')",
        ).run(file.id, jobId, b.attempt ?? -1);
      throw error;
    }
  };
  try {
    if (
      b.result_version !== null &&
      db.prepare("SELECT 1 FROM report_extractions WHERE job_id=?").get(jobId)
    ) {
      report(actor(b), b.report_id);
      normalizeReportObservations(b.report_id);
      db.prepare(
        "UPDATE report_page_appends SET state='complete',error_message=NULL WHERE id=?",
      ).run(b.id);
      db.prepare(
        "UPDATE processing_jobs SET status='completed',finished_at=CURRENT_TIMESTAMP,lease_expires_at=NULL WHERE id=? AND attempts=?",
      ).run(jobId, b.attempt);
      return true;
    }
    check(b);
    if (b.phase === "prepare") {
      for (const f of files(b.id)) {
        if (!f.page_count) {
          const result =
            f.mime_type === "application/pdf"
              ? await work({
                  action: "inspect_pdf",
                  imagePath: join(getAppConfig().storageDir, f.storage_path),
                  mimeType: f.mime_type,
                })
              : { pageCount: 1 };
          const count = Number(result.pageCount);
          if (
            files(b.id).reduce((sum, file) => sum + (file.page_count || 0), 0) +
              count >
            10000
          )
            invalid("单批 PDF 总页数不能超过 10000 页");
          if (!Number.isInteger(count) || count < 1 || count > 10000)
            invalid("PDF 页数无效或超过限制");
          runInTransaction(db, () => {
            check(b);
            for (let n = 1; n <= count; n++)
              db.prepare(
                "INSERT OR IGNORE INTO report_page_append_pages(id,file_id,source_page_number) VALUES(?,?,?)",
              ).run(createId("page"), f.id, n);
            db.prepare(
              "UPDATE report_page_append_files SET page_count=? WHERE id=?",
            ).run(count, f.id);
          });
        }
      }
      for (const p of pages(b.id)) {
        if (
          p.thumbnail_path &&
          existsSync(join(getAppConfig().storageDir, p.thumbnail_path))
        )
          continue;
        const path = `thumbnails/${b.report_id}/append-${p.id}.jpg`;
        mkdirSync(dirname(join(getAppConfig().storageDir, path)), {
          recursive: true,
        });
        await work({
          action: "thumbnail",
          imagePath: join(getAppConfig().storageDir, p.storage_path),
          mimeType: p.mime_type,
          pageNumber: p.source_page_number,
          outputPath: join(getAppConfig().storageDir, path),
        });
        db.prepare(
          "UPDATE report_page_append_pages SET thumbnail_path=? WHERE id=?",
        ).run(path, p.id);
      }
      db.prepare("UPDATE report_page_appends SET state='ready' WHERE id=?").run(
        b.id,
      );
    } else if (b.phase === "ocr") {
      // Existing valid OCR is reused. Repair only pages which have no OCR result.
      const missing = db
        .prepare(
          `SELECT p.* FROM report_pages p WHERE p.report_id=? AND NOT EXISTS(SELECT 1 FROM ocr_results o JOIN processing_jobs j ON j.id=o.job_id WHERE o.page_id=p.id AND j.status='completed' AND j.id=(SELECT recent.id FROM processing_jobs recent WHERE recent.page_id=p.id AND recent.job_type='ocr' ORDER BY recent.rowid DESC LIMIT 1)) ORDER BY p.page_number`,
        )
        .all(b.report_id) as Array<{
        id: string;
        storage_path: string;
        mime_type: string;
        source_page_number: number | null;
        rotation: number;
      }>;
      for (const p of missing) {
        const response = await work({
          action: "ocr",
          imagePath: join(getAppConfig().storageDir, p.storage_path),
          mimeType: p.mime_type,
          pageNumber: p.source_page_number,
          rotation: p.rotation,
        });
        runInTransaction(db, () => {
          check(b);
          const job = createId("job");
          db.prepare(
            "INSERT INTO processing_jobs(id,report_id,page_id,job_type,status,pipeline_version,deduplication_key) VALUES(?,?,?,'ocr','completed','page-append-v1',?)",
          ).run(job, b.report_id, p.id, `${b.id}:repair:${p.id}`);
          db.prepare(
            "INSERT INTO processing_job_events(id,job_id,report_id,event_type,status,detail_json) VALUES(?,?,?,'queued','queued',?)",
          ).run(
            createId("event"),
            job,
            b.report_id,
            JSON.stringify({ source: "page_append", batchId: b.id }),
          );
          db.prepare(
            "INSERT INTO ocr_results(id,job_id,page_id,engine,model_version,lines_json,coord_width,coord_height) VALUES(?,?,?,?,?,?,?,?)",
          ).run(
            createId("ocr"),
            job,
            p.id,
            response.engine || "worker",
            response.modelVersion || "unknown",
            JSON.stringify(response.lines || []),
            response.coordWidth || null,
            response.coordHeight || null,
          );
        });
      }
      for (const p of pages(b.id).filter(
        (p) => p.position !== null && !p.duplicate && !p.ocr_json,
      )) {
        if (p.rotation && p.thumbnail_path) {
          await work({
            action: "thumbnail",
            imagePath: join(getAppConfig().storageDir, p.storage_path),
            mimeType: p.mime_type,
            pageNumber: p.source_page_number,
            rotation: p.rotation,
            outputPath: join(getAppConfig().storageDir, p.thumbnail_path),
          });
        }
        const response = await work({
          action: "ocr",
          imagePath: join(getAppConfig().storageDir, p.storage_path),
          mimeType: p.mime_type,
          pageNumber: p.source_page_number,
          rotation: p.rotation,
        });
        db.prepare(
          "UPDATE report_page_append_pages SET ocr_json=? WHERE id=?",
        ).run(JSON.stringify(response), p.id);
      }
      const conflicts = findConflicts(b);
      const requiresReview = conflicts.some(message => !message.startsWith("新增页与已有页文字高度相似"));
      db.prepare(
        "UPDATE report_page_appends SET conflicts_json=?,state=? WHERE id=?",
      ).run(
        JSON.stringify(conflicts),
        requiresReview ? "review" : "ocr",
        b.id,
      );
      if (!requiresReview) publish(b);
    } else {
      if (!isAiExtractionConfigured()) {
        db.prepare(
          "UPDATE report_page_appends SET state='ocr_only' WHERE id=?",
        ).run(b.id);
      } else {
        const guardedAi: AiExecutor = async (input) => {
          check(b);
          const result = await ai(input);
          check(b);
          return result;
        };
        const execution = await executeAiExtractionPlan(
          jobId,
          b.report_id,
          guardedAi,
          {
            supplementMissingCandidates: true,
            shouldContinue: () => {
              try {
                check(b);
                return true;
              } catch {
                return false;
              }
            },
          },
        );
        check(b);
        const fields = execution.result.fields;
        if (
          ![
            fields.observations,
            fields.morphologyFindings,
            fields.diagnoses,
            fields.medications,
            fields.procedures,
            fields.vaccinations,
            fields.billingItems,
            fields.reportSections,
          ].some((items) => items.length) &&
          !fields.billingSummary
        ) {
          throw Object.assign(
            new Error("未获得可验证的识别结果，旧结果已保留，请重试"),
            { code: "AI_EMPTY_RESULT" },
          );
        }
        persistAiExtraction(
          b.report_id,
          jobId,
          execution.result,
          execution.inputCharacters,
          () => check(b),
        );
      }
    }
    db.prepare(
      "UPDATE processing_jobs SET status='completed',finished_at=CURRENT_TIMESTAMP,lease_expires_at=NULL WHERE id=? AND status='processing' AND attempts=?",
    ).run(jobId, b.attempt);
    return true;
  } catch (error) {
    const lease = db
      .prepare("SELECT attempts,status FROM processing_jobs WHERE id=?")
      .get(jobId) as { attempts: number; status: string } | undefined;
    if (!lease || lease.attempts !== b.attempt || lease.status !== "processing")
      return true;
    const current = db
      .prepare("SELECT state FROM report_page_appends WHERE id=?")
      .get(b.id) as { state: string } | undefined;
    const revoked = [401, 403, 404].includes(
      Number((error as { statusCode?: number }).statusCode),
    );
    const preservedRecordConflict = Boolean(
      (error as { appendCandidateRejected?: boolean }).appendCandidateRejected,
    );
    const emptyResult = ["AI_EMPTY_RESULT", "AI_EMPTY_RESPONSE"].includes(
      String((error as { code?: string }).code || ""),
    );
    const failureMessage = revoked
      ? "原操作账号授权已变化，处理已停止"
      : preservedRecordConflict
        ? "新结果遗漏或改变了已有记录，旧结果已保留，请核对原件后重试"
        : emptyResult
          ? "未获得可验证的识别结果，旧结果已保留，请重试"
          : "本批次处理未完成，旧结果已保留；请核对权限、报告变化或识别内容后重试";
    if (current && !terminal.has(current.state))
      db.prepare(
        "UPDATE report_page_appends SET state=?,error_message=?,updated_at=CURRENT_TIMESTAMP WHERE id=?",
      ).run(
        revoked ? (b.published ? "ocr_only" : "cancelled") : "failed",
        failureMessage,
        b.id,
      );
    db.prepare(
      "UPDATE processing_jobs SET status='failed',error_code=?,error_message=?,lease_expires_at=NULL,finished_at=CURRENT_TIMESTAMP WHERE id=? AND status='processing' AND attempts=?",
    ).run(
      preservedRecordConflict
        ? "APPEND_PUBLISHED_RECORD_CONFLICT"
        : emptyResult
          ? "AI_EMPTY_RESULT"
          : "PAGE_APPEND_FAILED",
      failureMessage,
      jobId,
      b.attempt,
    );
    return true;
  }
}

export async function importPageAppendFiles(
  user: RequestUser,
  reportId: string,
  input: {
    requestKey: string;
    files?: Array<{ rootId?: unknown; path?: unknown; rotation?: unknown }>;
    authorizedPaths?: unknown;
  },
) {
  report(user, reportId);
  if (!input || !/^[a-zA-Z0-9_-]{16,100}$/.test(input.requestKey || ""))
    invalid("补充请求编号无效");
  const { resolveLocalFilesForUser, resolveAuthorizedFnosFiles } =
    await import("./local-file-import.service");
  const sources = Array.isArray(input.authorizedPaths)
    ? await resolveAuthorizedFnosFiles(user, input.authorizedPaths)
    : await resolveLocalFilesForUser(user, input.files || []);
  const validated = validateLocalFiles(sources);
  let batch = startPageAppend(user, reportId, {
    requestKey: input.requestKey,
    files: validated.map((f) => ({ name: f.originalName, size: f.fileSize })),
  });
  for (let i = 0; i < validated.length; i++) {
    if (batch.files[i]!.received) continue;
    report(user, reportId);
    const temporary = join(
      getAppConfig().storageDir,
      `reports/${hash(reportId)}/appends/${batch.id}/copy-${createId("tmp")}`,
    );
    mkdirSync(dirname(temporary), { recursive: true });
    try {
      persistValidatedFile(validated[i]!, temporary);
      batch = storePageAppendFile(
        user,
        reportId,
        batch.id,
        batch.files[i]!.id,
        readFileSync(temporary),
      );
    } finally {
      rmSync(temporary, { force: true });
    }
  }
  return batch;
}

function reportInputFingerprint(reportId: string) {
  const db = getDatabase();
  const report = db.prepare("SELECT * FROM reports WHERE id=?").get(reportId);
  const pages = db
    .prepare("SELECT * FROM report_pages WHERE report_id=? ORDER BY id")
    .all(reportId);
  const ocr = db
    .prepare(
      "SELECT o.* FROM ocr_results o JOIN report_pages p ON p.id=o.page_id WHERE p.report_id=? ORDER BY o.id",
    )
    .all(reportId);
  const edits = [
    "observations",
    "observation_field_overrides",
    "observation_suppressions",
    "report_diagnoses",
    "report_medications",
    "report_procedures",
    "vaccination_records",
    "billing_items",
    "billing_summaries",
    "report_structured_sections",
    "morphology_findings",
  ].map((table) =>
    db
      .prepare(`SELECT * FROM ${table} WHERE report_id=? ORDER BY rowid`)
      .all(reportId),
  );
  return hash(JSON.stringify({ report, pages, ocr, edits }));
}

function similarText(left: string, right: string) {
  const compact = (s: string) =>
    s
      .normalize("NFKC")
      .replace(/[\s\p{P}]/gu, "")
      .toLowerCase();
  const a = compact(left),
    b = compact(right);
  if (Math.min(a.length, b.length) < 12) return false;
  if (a === b) return true;
  if (Math.min(a.length, b.length) < 40) return false;
  const grams = (s: string) =>
    new Set(
      Array.from({ length: Math.max(0, s.length - 2) }, (_, i) =>
        s.slice(i, i + 3),
      ),
    );
  const x = grams(a),
    y = grams(b);
  return (
    (2 * [...x].filter((g) => y.has(g)).length) / (x.size + y.size) >= 0.92
  );
}
