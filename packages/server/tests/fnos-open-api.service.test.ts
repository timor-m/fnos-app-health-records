import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { RequestUser } from "../domain/request-user.ts";
import { checkFnosUserAcl, getFnosUserAccessibleFolders } from "../services/fnos-open-api.service.ts";

const user: RequestUser = {
  id: "1001",
  displayName: "普通用户",
  provider: "fnos_gateway",
  authenticated: true,
  isAdmin: false,
  isGatewayAdmin: false
};

test("queries fnOS personal folders and checks the current user's file ACL", async () => {
  const directory = mkdtempSync(join(tmpdir(), "health-records-fnos-api-"));
  const socketPath = join(directory, "open-api.sock");
  const requests: Array<{ authorization: string | undefined; body: Record<string, unknown> }> = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      requests.push({ authorization: request.headers.authorization, body });
      const data = body.req === "trim.file.getUserAccessibleFolders"
        ? { paths: ["/vol1/1001/reports"] }
        : [{ path: "/vol1/1001/reports/report.pdf", readable: true, writable: false, deletable: false }];
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ reqId: body.reqId, code: 0, msg: "", data }));
    });
  });
  process.env.AUTH_MODE = "fnos";
  process.env.TRIM_API_TOKEN = "test-token";
  process.env.TRIM_OPEN_API_SOCKET = socketPath;

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    assert.deepEqual(await getFnosUserAccessibleFolders(user), ["/vol1/1001/reports"]);
    assert.deepEqual(await checkFnosUserAcl(user, ["/vol1/1001/reports/report.pdf"]), [{
      path: "/vol1/1001/reports/report.pdf",
      readable: true,
      writable: false,
      deletable: false
    }]);
    assert.equal(requests.length, 2);
    assert.equal(requests.every((item) => item.authorization === "Bearer test-token"), true);
    assert.equal(requests.every((item) => item.body.appName === "fnos-app-health-records"), true);
    assert.deepEqual((requests[0]!.body.data as { uid: number }).uid, 1001);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    delete process.env.AUTH_MODE;
    delete process.env.TRIM_API_TOKEN;
    delete process.env.TRIM_OPEN_API_SOCKET;
    rmSync(directory, { recursive: true, force: true });
  }
});
