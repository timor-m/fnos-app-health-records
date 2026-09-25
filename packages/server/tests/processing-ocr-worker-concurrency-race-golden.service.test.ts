import assert from "node:assert/strict";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { closeDatabaseForTests, getDatabase } from "../database/client.ts";
import type { RequestUser } from "../domain/request-user.ts";
import { processNextJob } from "../services/job-runner.service.ts";
import { requestWorker, stopWorker } from "../services/ocr-worker-client.ts";
import { createUpload } from "../services/upload.service.ts";

type GoldenFixture = {
  expected: {
    startupRequestCount: number;
    startupProcessCount: number;
    startupEarlyRequestCount: number;
    startupMaxActiveRequests: number;
    protocolProcessCount: number;
    protocolFailureCount: number;
    protocolRecoveredResponseCount: number;
    recycleProcessCount: number;
    recycleSuccessfulResponseCount: number;
    stopRejectedRequestCount: number;
    stopProcessCount: number;
    stopWrittenRequestCount: number;
    retiredProcessCount: number;
    retiredTerminatedProcessCount: number;
    jobReportCount: number;
    jobWorkerProcessCount: number;
    jobWorkerRequestCount: number;
    jobFirstReportAttempts: number;
    jobSecondReportAttempts: number;
    jobOcrResultCount: number;
    jobActiveJobsAfterRecovery: number;
  };
};

const fixture = JSON.parse(
  readFileSync(
    new URL("./fixtures/p3-ocr-worker-concurrency-race-golden.json", import.meta.url),
    "utf8",
  ),
) as GoldenFixture;

function numberFromFile(path: string) {
  return existsSync(path) ? Number(readFileSync(path, "utf8")) : 0;
}

function linesFromFile(path: string) {
  return existsSync(path)
    ? readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean)
    : [];
}

function errorCode(reason: unknown) {
  return (reason as { code?: string })?.code;
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(predicate(), true, "等待 OCR Worker 竞态条件超时");
}

function configureWorker(scriptPath: string) {
  stopWorker();
  process.env.OCR_PYTHON_BIN = process.execPath;
  process.env.OCR_WORKER_SCRIPT = scriptPath;
  process.env.OCR_WORKER_TIMEOUT_MS = "1000";
  // Normal process startup is not the boundary under test; allow parallel-suite scheduling.
  process.env.OCR_WORKER_STARTUP_TIMEOUT_MS = "10000";
}

test("serializes worker requests and isolates startup, protocol, recycle, and stop races", async () => {
  const directory = mkdtempSync(join(tmpdir(), "health-records-worker-race-"));
  const expected = fixture.expected;
  const spawnedPids = new Set<number>();

  try {
    const startupScript = join(directory, "startup-worker.mjs");
    const startupCount = join(directory, "startup-count");
    const earlyCount = join(directory, "startup-early-count");
    const maxActive = join(directory, "startup-max-active");
    writeFileSync(startupScript, `
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
const countPath = ${JSON.stringify(startupCount)};
const earlyPath = ${JSON.stringify(earlyCount)};
const maxPath = ${JSON.stringify(maxActive)};
const increment = (path) => {
  const value = existsSync(path) ? Number(readFileSync(path, "utf8")) : 0;
  writeFileSync(path, String(value + 1));
};
increment(countPath);
let ready = false;
let active = 0;
const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  const request = JSON.parse(line);
  if (!ready) increment(earlyPath);
  active += 1;
  const currentMax = existsSync(maxPath) ? Number(readFileSync(maxPath, "utf8")) : 0;
  if (active > currentMax) writeFileSync(maxPath, String(active));
  setTimeout(() => {
    console.log(JSON.stringify({ id: request.id, ok: true, lines: [{ text: request.imagePath }] }));
    active -= 1;
  }, 40);
});
setTimeout(() => {
  ready = true;
  console.log(JSON.stringify({ type: "ready", ok: true }));
}, 120);
`);
    configureWorker(startupScript);
    const startupResponses = await Promise.all(
      Array.from({ length: expected.startupRequestCount }, (_, index) =>
        requestWorker({ action: "ocr", imagePath: `startup-${index + 1}` }),
      ),
    );
    assert.deepEqual(
      startupResponses.map((response) => response.lines?.[0]?.text),
      ["startup-1", "startup-2", "startup-3"],
    );
    assert.equal(numberFromFile(startupCount), expected.startupProcessCount);
    assert.equal(numberFromFile(earlyCount), expected.startupEarlyRequestCount);
    assert.equal(numberFromFile(maxActive), expected.startupMaxActiveRequests);

    const protocolScript = join(directory, "protocol-worker.mjs");
    const protocolCount = join(directory, "protocol-count");
    const protocolFault = join(directory, "protocol-fault");
    writeFileSync(protocolScript, `
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
const countPath = ${JSON.stringify(protocolCount)};
const faultPath = ${JSON.stringify(protocolFault)};
const count = existsSync(countPath) ? Number(readFileSync(countPath, "utf8")) : 0;
writeFileSync(countPath, String(count + 1));
console.log(JSON.stringify({ type: "ready", ok: true }));
const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  const request = JSON.parse(line);
  if (!existsSync(faultPath)) {
    writeFileSync(faultPath, "1");
    console.log(JSON.stringify({ id: request.id, ok: true }));
    return;
  }
  console.log(JSON.stringify({ id: request.id, ok: true, lines: [{ text: request.imagePath }] }));
});
`);
    configureWorker(protocolScript);
    const protocolResults = await Promise.allSettled([
      requestWorker({ action: "ocr", imagePath: "protocol-fault" }),
      requestWorker({ action: "ocr", imagePath: "protocol-recovery-1" }),
      requestWorker({ action: "ocr", imagePath: "protocol-recovery-2" }),
    ]);
    const protocolFailures = protocolResults.filter(
      (result) => result.status === "rejected",
    );
    const protocolSuccesses = protocolResults.filter(
      (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof requestWorker>>> =>
        result.status === "fulfilled",
    );
    assert.equal(protocolFailures.length, expected.protocolFailureCount);
    assert.equal(
      errorCode((protocolFailures[0] as PromiseRejectedResult).reason),
      "OCR_WORKER_PROTOCOL_ERROR",
    );
    assert.equal(
      protocolSuccesses.length,
      expected.protocolRecoveredResponseCount,
    );
    assert.deepEqual(
      protocolSuccesses.map((result) => result.value.lines?.[0]?.text),
      ["protocol-recovery-1", "protocol-recovery-2"],
    );
    assert.equal(numberFromFile(protocolCount), expected.protocolProcessCount);

    const recycleScript = join(directory, "recycle-worker.mjs");
    const recycleCount = join(directory, "recycle-count");
    writeFileSync(recycleScript, `
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
const countPath = ${JSON.stringify(recycleCount)};
const count = existsSync(countPath) ? Number(readFileSync(countPath, "utf8")) : 0;
writeFileSync(countPath, String(count + 1));
console.log(JSON.stringify({ type: "ready", ok: true }));
const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  const request = JSON.parse(line);
  console.log(JSON.stringify({ id: request.id, ok: true, lines: [{ text: request.imagePath }] }));
  if (request.recycleAfterResponse) process.exit(0);
});
`);
    configureWorker(recycleScript);
    const recycleResults = await Promise.allSettled([
      requestWorker({
        action: "ocr",
        imagePath: "recycle-boundary",
        recycleAfterResponse: true,
      }),
      requestWorker({ action: "ocr", imagePath: "after-recycle-1" }),
      requestWorker({ action: "ocr", imagePath: "after-recycle-2" }),
    ]);
    assert.equal(
      recycleResults.filter((result) => result.status === "fulfilled").length,
      expected.recycleSuccessfulResponseCount,
    );
    assert.equal(numberFromFile(recycleCount), expected.recycleProcessCount);

    const stopScript = join(directory, "stop-worker.mjs");
    const stopCount = join(directory, "stop-count");
    const stopRequests = join(directory, "stop-requests");
    writeFileSync(stopScript, `
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
const countPath = ${JSON.stringify(stopCount)};
const requestsPath = ${JSON.stringify(stopRequests)};
const count = existsSync(countPath) ? Number(readFileSync(countPath, "utf8")) : 0;
writeFileSync(countPath, String(count + 1));
console.log(JSON.stringify({ type: "ready", ok: true }));
const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  const request = JSON.parse(line);
  appendFileSync(requestsPath, request.imagePath + "\\n");
  if (request.imagePath === "hold") return;
  console.log(JSON.stringify({ id: request.id, ok: true, lines: [{ text: request.imagePath }] }));
});
`);
    configureWorker(stopScript);
    const heldRequest = requestWorker({ action: "ocr", imagePath: "hold" });
    const queuedRequest = requestWorker({ action: "ocr", imagePath: "queued" });
    const stopped = Promise.allSettled([heldRequest, queuedRequest]);
    await waitFor(() => linesFromFile(stopRequests).includes("hold"), 10_000);
    stopWorker();
    const stoppedResults = await stopped;
    assert.equal(
      stoppedResults.filter((result) => result.status === "rejected").length,
      expected.stopRejectedRequestCount,
    );
    for (const result of stoppedResults) {
      assert.equal(result.status, "rejected");
      if (result.status === "rejected") {
        assert.equal(errorCode(result.reason), "OCR_WORKER_STOPPED");
      }
    }
    const afterStop = await requestWorker({
      action: "ocr",
      imagePath: "after-stop",
      recycleAfterResponse: true,
    });
    assert.equal(afterStop.lines?.[0]?.text, "after-stop");
    assert.equal(numberFromFile(stopCount), expected.stopProcessCount);
    assert.deepEqual(linesFromFile(stopRequests), ["hold", "after-stop"]);
    assert.equal(
      linesFromFile(stopRequests).length,
      expected.stopWrittenRequestCount,
    );

    const retiredScript = join(directory, "retired-worker.mjs");
    const retiredPids = join(directory, "retired-pids");
    const retiredTerminated = join(directory, "retired-terminated");
    writeFileSync(retiredScript, `
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const pidsPath = ${JSON.stringify(retiredPids)};
const terminatedPath = ${JSON.stringify(retiredTerminated)};
appendFileSync(pidsPath, String(process.pid) + "\\n");
process.on("SIGTERM", () => {
  appendFileSync(terminatedPath, String(process.pid) + "\\n");
  process.exit(0);
});
setInterval(() => {}, 1000);
console.log(JSON.stringify({ type: "ready", ok: true }));
const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  const request = JSON.parse(line);
  console.log(JSON.stringify({ id: request.id, ok: true, lines: [] }));
});
`);
    configureWorker(retiredScript);
    await requestWorker({
      action: "ocr",
      imagePath: "retire-first",
      recycleAfterResponse: true,
    });
    await requestWorker({ action: "ocr", imagePath: "current-second" });
    const pids = linesFromFile(retiredPids).map(Number);
    pids.forEach((pid) => spawnedPids.add(pid));
    assert.equal(pids.length, expected.retiredProcessCount);
    stopWorker();
    await waitFor(
      () =>
        linesFromFile(retiredTerminated).length ===
        expected.retiredTerminatedProcessCount,
    );
  } finally {
    stopWorker();
    for (const pid of spawnedPids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // The expected path already stopped every worker process.
      }
    }
    delete process.env.OCR_PYTHON_BIN;
    delete process.env.OCR_WORKER_SCRIPT;
    delete process.env.OCR_WORKER_TIMEOUT_MS;
    delete process.env.OCR_WORKER_STARTUP_TIMEOUT_MS;
    rmSync(directory, { recursive: true, force: true });
  }
});


const manager: RequestUser = {
  id: "p3-worker-race-manager",
  displayName: "Worker 竞态金标管理员",
  provider: "development",
  authenticated: true,
  isGatewayAdmin: true,
};

function pngBytes(seed: number) {
  return Uint8Array.from([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    seed,
  ]);
}

test("isolates queued reports when the shared OCR worker crashes", async () => {
  const directory = mkdtempSync(
    join(tmpdir(), "health-records-worker-job-isolation-"),
  );
  const expected = fixture.expected;
  const memberId = "p3-worker-race-member";
  const workerScript = join(directory, "job-isolation-worker.mjs");
  const processCountPath = join(directory, "job-process-count");
  const requestCountPath = join(directory, "job-request-count");
  writeFileSync(workerScript, `
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
const processCountPath = ${JSON.stringify(processCountPath)};
const requestCountPath = ${JSON.stringify(requestCountPath)};
const increment = (path) => {
  const value = existsSync(path) ? Number(readFileSync(path, "utf8")) : 0;
  writeFileSync(path, String(value + 1));
  return value + 1;
};
increment(processCountPath);
console.log(JSON.stringify({ type: "ready", ok: true }));
const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  const request = JSON.parse(line);
  const requestCount = increment(requestCountPath);
  if (requestCount === 1) process.exit(37);
  console.log(JSON.stringify({
    id: request.id,
    ok: true,
    engine: "race-golden",
    modelVersion: "race-v1",
    lines: [{
      id: "race-line-" + requestCount,
      text: "匿名检查项目 " + requestCount + ".0 mmol/L",
      confidence: 0.99,
      box: [0, 0, 120, 12]
    }],
    elapsedMs: 3
  }));
  if (request.recycleAfterResponse) setImmediate(() => process.exit(0));
});
`);

  process.env.STORAGE_DIR = directory;
  process.env.LOG_DIR = join(directory, "logs");
  configureWorker(workerScript);
  try {
    const db = getDatabase();
    db.prepare(
      "INSERT INTO users (id, display_name, is_gateway_admin) VALUES (?, ?, 1)",
    ).run(manager.id, manager.displayName);
    db.prepare(
      `
      INSERT INTO health_members (id, display_name, relationship, created_by)
      VALUES (?, '匿名成员', 'self', ?)
    `,
    ).run(memberId, manager.id);
    db.prepare(
      `
      INSERT INTO member_permissions (member_id, user_id, permission, granted_by)
      VALUES (?, ?, 'manager', ?)
    `,
    ).run(memberId, manager.id, manager.id);

    const uploads = [
      createUpload(manager, memberId, [
        { originalName: "竞态报告一.png", data: pngBytes(0x31) },
      ]),
      createUpload(manager, memberId, [
        { originalName: "竞态报告二.png", data: pngBytes(0x32) },
      ]),
    ];
    assert.equal(uploads.length, expected.jobReportCount);
    for (const upload of uploads) {
      db.prepare(
        "UPDATE processing_jobs SET status = 'cancelled' WHERE report_id = ? AND job_type = 'thumbnail'",
      ).run(upload.reportId);
    }
    db.prepare(
      "UPDATE processing_jobs SET created_at = '2026-01-01 00:00:00' WHERE report_id = ? AND job_type = 'ocr'",
    ).run(uploads[0].reportId);
    db.prepare(
      "UPDATE processing_jobs SET created_at = '2026-01-01 00:00:01' WHERE report_id = ? AND job_type = 'ocr'",
    ).run(uploads[1].reportId);

    await assert.rejects(
      () => processNextJob(),
      (error: unknown) => errorCode(error) === "OCR_WORKER_EXITED",
    );
    const failedFirst = db
      .prepare(
        `
        SELECT status, attempts, error_code AS errorCode
        FROM processing_jobs
        WHERE report_id = ? AND job_type = 'ocr'
      `,
      )
      .get(uploads[0].reportId) as {
      status: string;
      attempts: number;
      errorCode: string | null;
    };
    assert.equal(failedFirst.status, "queued");
    assert.equal(failedFirst.attempts, 1);
    assert.equal(failedFirst.errorCode, "OCR_WORKER_EXITED");

    assert.equal(await processNextJob(), true);
    const completedSecond = db
      .prepare(
        `
        SELECT status, attempts, error_code AS errorCode
        FROM processing_jobs
        WHERE report_id = ? AND job_type = 'ocr'
      `,
      )
      .get(uploads[1].reportId) as typeof failedFirst;
    assert.equal(completedSecond.status, "completed");
    assert.equal(completedSecond.attempts, expected.jobSecondReportAttempts);
    assert.equal(completedSecond.errorCode, null);

    db.prepare(
      `
      UPDATE processing_jobs SET next_retry_at = CURRENT_TIMESTAMP
      WHERE report_id = ? AND job_type = 'ocr'
    `,
    ).run(uploads[0].reportId);
    assert.equal(await processNextJob(), true);
    const completedFirst = db
      .prepare(
        `
        SELECT status, attempts, error_code AS errorCode
        FROM processing_jobs
        WHERE report_id = ? AND job_type = 'ocr'
      `,
      )
      .get(uploads[0].reportId) as typeof failedFirst;
    assert.equal(completedFirst.status, "completed");
    assert.equal(completedFirst.attempts, expected.jobFirstReportAttempts);
    assert.equal(completedFirst.errorCode, null);

    assert.equal(numberFromFile(processCountPath), expected.jobWorkerProcessCount);
    assert.equal(numberFromFile(requestCountPath), expected.jobWorkerRequestCount);
    const resultCount = db
      .prepare(
        `
        SELECT COUNT(*) AS count
        FROM ocr_results o
        JOIN processing_jobs j ON j.id = o.job_id
        WHERE j.report_id IN (?, ?)
      `,
      )
      .get(uploads[0].reportId, uploads[1].reportId) as { count: number };
    assert.equal(resultCount.count, expected.jobOcrResultCount);
    const activeJobs = db
      .prepare(
        `
        SELECT COUNT(*) AS count FROM processing_jobs
        WHERE report_id IN (?, ?) AND status IN ('queued', 'processing')
      `,
      )
      .get(uploads[0].reportId, uploads[1].reportId) as { count: number };
    assert.equal(activeJobs.count, expected.jobActiveJobsAfterRecovery);
  } finally {
    stopWorker();
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    delete process.env.LOG_DIR;
    delete process.env.OCR_PYTHON_BIN;
    delete process.env.OCR_WORKER_SCRIPT;
    delete process.env.OCR_WORKER_TIMEOUT_MS;
    delete process.env.OCR_WORKER_STARTUP_TIMEOUT_MS;
    rmSync(directory, { recursive: true, force: true });
  }
});
