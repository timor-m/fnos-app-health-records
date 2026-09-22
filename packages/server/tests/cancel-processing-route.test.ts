import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { H3, type H3Event } from "h3";
import handler from "../routes/api/reports/[id]/cancel-processing.post.ts";
import { closeDatabaseForTests, getDatabase } from "../database/client.ts";
import { createUpload } from "../services/upload.service.ts";

test("POST cancellation route enforces member permissions and cancels only the selected report", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cancel-route-"));
  const previous = { STORAGE_DIR: process.env.STORAGE_DIR, AUTH_MODE: process.env.AUTH_MODE };
  process.env.STORAGE_DIR = directory;
  process.env.AUTH_MODE = "fnos";
  try {
    const db = getDatabase();
    db.exec(`
      INSERT INTO users (id, display_name) VALUES ('manager', 'Test'), ('viewer', 'Test');
      INSERT INTO user_identities(id,user_id,provider,subject) VALUES('mi','manager','fnos_gateway','manager'),('vi','viewer','fnos_gateway','viewer');
      INSERT INTO health_members (id, display_name, created_by) VALUES ('member', 'Test', 'manager');
      INSERT INTO member_permissions (member_id, user_id, permission, granted_by)
      VALUES ('member', 'manager', 'manager', 'manager'), ('member', 'viewer', 'viewer', 'manager');
    `);
    const user = { id: "manager", displayName: "Test", provider: "fnos_gateway" as const, authenticated: true, isGatewayAdmin: false };
    const file = { originalName: "test.png", data: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]) };
    const report = createUpload(user, "member", [file]);
    const other = createUpload(user, "member", [file]);
    db.prepare("UPDATE processing_jobs SET status = 'processing' WHERE report_id = ? AND job_type = 'ocr'").run(report.reportId);
    const app = new H3();
    // Model the trusted gateway identity injected by the server listener, not public headers.
    let identity = "viewer";
    app.post("/api/reports/:id/cancel-processing", event => handler({
      req: event.req, context: event.context,
      node: { req: { healthAccessMode: "gateway", headers: { "x-trim-userid": identity, "x-trim-username": "Test" } } }
    } as unknown as H3Event));
    const send = (id: string) => app.request(`http://localhost/api/reports/${id}/cancel-processing`, { method: "POST" });
    const active = (id: string) => (db.prepare("SELECT COUNT(*) AS count FROM processing_jobs WHERE report_id = ? AND status IN ('queued', 'processing')").get(id) as { count: number }).count;
    assert.equal((await send(report.reportId)).status, 403);
    assert.equal(active(report.reportId), 2);
    identity = "manager";
    const response = await send(report.reportId);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.ok, true);
    assert.equal(payload.data.cancelled, 2);
    assert.equal(active(report.reportId), 0);
    assert.equal(active(other.reportId), 2);
    assert.equal((await send(report.reportId)).status, 409);
    assert.equal((await send("missing-report")).status, 404);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM reports").get() as { count: number }).count, 2);
  } finally {
    closeDatabaseForTests();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(directory, { recursive: true, force: true });
  }
});
