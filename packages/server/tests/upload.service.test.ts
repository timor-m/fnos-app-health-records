import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { closeDatabaseForTests, getDatabase } from "../database/client.ts";
import type { RequestUser } from "../domain/request-user.ts";
import { createUpload, detectUploadType } from "../services/upload.service.ts";

const manager: RequestUser = {
  id: "upload-manager",
  displayName: "上传管理员",
  provider: "fnos_gateway",
  authenticated: true,
  isGatewayAdmin: true
};
const viewer: RequestUser = {
  id: "upload-viewer",
  displayName: "只读账号",
  provider: "fnos_gateway",
  authenticated: true,
  isGatewayAdmin: false
};

function pngBytes() {
  return Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]);
}

test("stores originals and queues page processing jobs atomically", () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-upload-"));
  process.env.STORAGE_DIR = storageDir;
  try {
    const db = getDatabase();
    db.prepare("INSERT INTO users (id, display_name, is_gateway_admin) VALUES (?, ?, 1)")
      .run(manager.id, manager.displayName);
    db.prepare("INSERT INTO users (id, display_name, is_gateway_admin) VALUES (?, ?, 0)")
      .run(viewer.id, viewer.displayName);
    db.prepare(`
      INSERT INTO health_members (id, display_name, relationship, created_by)
      VALUES ('upload-member', '孩子', 'child', ?)
    `).run(manager.id);
    db.prepare(`
      INSERT INTO member_permissions (member_id, user_id, permission, granted_by)
      VALUES ('upload-member', ?, 'manager', ?), ('upload-member', ?, 'viewer', ?)
    `).run(manager.id, manager.id, viewer.id, manager.id);

    const result = createUpload(manager, "upload-member", [
      { originalName: "第一页.png", data: pngBytes(), rotation: 90 },
      { originalName: "报告.pdf", data: Buffer.from("%PDF-1.4\n%%EOF"), rotation: 0 }
    ]);
    assert.equal(result.status, "queued");
    assert.equal(result.pageCount, 2);
    assert.equal(result.jobCount, 4);
    assert.equal(result.pages[0]?.rotation, 90);

    const pages = db.prepare(`
      SELECT storage_path AS storagePath, mime_type AS mimeType, page_number AS pageNumber
      FROM report_pages WHERE report_id = ? ORDER BY page_number
    `).all(result.reportId) as Array<{ storagePath: string; mimeType: string; pageNumber: number }>;
    assert.deepEqual(pages.map((page) => page.mimeType), ["image/png", "application/pdf"]);
    assert.equal(pages.every((page) => existsSync(join(storageDir, page.storagePath))), true);
    const jobs = db.prepare(`
      SELECT job_type AS jobType, status FROM processing_jobs WHERE report_id = ? ORDER BY job_type
    `).all(result.reportId) as Array<{ jobType: string; status: string }>;
    assert.equal(jobs.length, 4);
    assert.equal(jobs.every((job) => job.status === "queued"), true);

    assert.throws(
      () => createUpload(viewer, "upload-member", [
        { originalName: "report.png", data: pngBytes() }
      ]),
      (error: unknown) => (error as { statusCode?: number }).statusCode === 403
    );
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
});

test("detects supported formats from file signatures", () => {
  assert.equal(detectUploadType(pngBytes())?.mimeType, "image/png");
  assert.equal(detectUploadType(Buffer.from("%PDF-1.7\n"))?.mimeType, "application/pdf");
  assert.equal(detectUploadType(Buffer.from("plain text")), null);
});

test('processing failure display uses public decode code without changing persisted retry code', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'upload-error-display-'));
  process.env.STORAGE_DIR = directory;
  try {
    const db = getDatabase();
    db.prepare('INSERT INTO users (id, display_name, is_gateway_admin) VALUES (?, ?, 1)').run(manager.id, 'Test');
    db.prepare("INSERT INTO health_members (id, display_name, relationship, created_by) VALUES ('error-member', 'Test', 'self', ?)").run(manager.id);
    db.prepare("INSERT INTO member_permissions (member_id, user_id, permission, granted_by) VALUES ('error-member', ?, 'manager', ?)").run(manager.id, manager.id);
    const upload = createUpload(manager, 'error-member', [{ originalName: 'test.png', data: pngBytes() }]);
    db.prepare("UPDATE processing_jobs SET status = 'failed', error_code = 'IMAGE_DECODE_FAILED', error_message = 'private worker detail' WHERE report_id = ?").run(upload.reportId);
    const { listProcessingJobs } = await import('../services/upload.service');
    const jobs = listProcessingJobs(manager, upload.reportId);
    assert.ok(jobs.length);
    for (const job of jobs) {
      assert.equal(job.errorCode, 'IMAGE_DECODE_FAILED');
      assert.equal(job.errorMessage, '图片内容无法读取，可能已损坏或格式异常\n错误码：FILE_DECODE_FAILED');
    }
    assert.equal((db.prepare('SELECT error_code FROM processing_jobs WHERE report_id = ?').get(upload.reportId) as { error_code: string }).error_code, 'IMAGE_DECODE_FAILED');
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(directory, { recursive: true, force: true });
  }
});
