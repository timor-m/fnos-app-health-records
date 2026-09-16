import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { H3Event } from "h3";
import { closeDatabaseForTests } from "../database/client.ts";
import { dismissSetupGuide, getSetupGuideStatus } from "../services/setup-guide.service.ts";
import statusHandler from "../routes/api/setup/status.get.ts";
import dismissHandler from "../routes/api/setup/guide-dismissed.put.ts";
import { bootstrapLocalAdministrator, createLocalAccount, login } from "../services/auth.service.ts";
import { getRequestUser } from "../utils/request-user.ts";

function localAuthEvent(options: { cookie?: string; path?: string } = {}) {
  const nodeHeaders: Record<string, string> = {};
  if (options.cookie) nodeHeaders.cookie = options.cookie;
  const headers = new Headers(nodeHeaders);
  return {
    req: {
      headers,
      url: `http://health.test${options.path || "/api/setup/status"}`,
      context: { clientAddress: "127.0.0.1" }
    },
    res: { headers: new Headers() },
    node: { req: { headers: nodeHeaders, url: options.path || "/api/setup/status", socket: {} } }
  } as unknown as H3Event;
}

function loginAs(username: string, password: string) {
  const event = localAuthEvent({ path: "/api/auth/login" });
  login(event, { username, password });
  return (event.res.headers.get("set-cookie") || "").split(";", 1)[0];
}

function statusCode(error: unknown) {
  return Number((error as { statusCode?: number }).statusCode);
}

test("setup guide status reflects fresh environment, persists dismissal and requires admin", () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-setup-guide-"));
  process.env.STORAGE_DIR = storageDir;
  process.env.AUTH_MODE = "local";
  try {
    bootstrapLocalAdministrator();
    const fresh = getSetupGuideStatus();
    assert.deepEqual(fresh, {
      ocrInstalled: false,
      ocrInstalling: false,
      aiConfigured: false,
      guideDismissed: false
    });

    const dismissed = dismissSetupGuide();
    assert.equal(dismissed.guideDismissed, true);
    assert.equal(getSetupGuideStatus().guideDismissed, true);

    const adminCookie = loginAs("admin", "admin");
    const adminEvent = localAuthEvent({ cookie: adminCookie });
    assert.equal(getRequestUser(adminEvent).isAdmin, true);
    const statusPayload = statusHandler(adminEvent) as { ok: boolean; data: { guideDismissed: boolean } };
    assert.equal(statusPayload.ok, true);
    assert.equal(statusPayload.data.guideDismissed, true);
    const dismissPayload = dismissHandler(adminEvent) as { ok: boolean };
    assert.equal(dismissPayload.ok, true);

    createLocalAccount(getRequestUser(localAuthEvent({ cookie: adminCookie })), { username: "viewer", displayName: "普通成员" });
    const viewerCookie = loginAs("viewer", "admin");
    const viewerEvent = localAuthEvent({ cookie: viewerCookie });
    assert.equal(getRequestUser(viewerEvent).isAdmin, false);
    assert.throws(() => statusHandler(viewerEvent), (error: unknown) => statusCode(error) === 403);
    assert.throws(() => dismissHandler(viewerEvent), (error: unknown) => statusCode(error) === 403);
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    delete process.env.AUTH_MODE;
    rmSync(storageDir, { recursive: true, force: true });
  }
});
