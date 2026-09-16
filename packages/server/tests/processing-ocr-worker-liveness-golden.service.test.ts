import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { closeDatabaseForTests, getDatabase } from "../database/client.ts";
import type { RequestUser } from "../domain/request-user.ts";
import {
  claimNextJob,
  processNextJob,
} from "../services/job-runner.service.ts";
import { requestWorker, stopWorker } from "../services/ocr-worker-client.ts";
import { createUpload } from "../services/upload.service.ts";

const fixture = JSON.parse(
  readFileSync(
    new URL("./fixtures/p3-ocr-worker-liveness-golden.json", import.meta.url),
    "utf8",
  ),
) as {
  expected: {
    pythonHeartbeatMinimum: number;
    clientLongHeartbeatMinimum: number;
    silentTimeoutCode: string;
    hardTimeoutCode: string;
    invalidHeartbeatProtocolCode: string;
    clientSuccessfulResponseCount: number;
    clientProcessCount: number;
    leaseJobAttempts: number;
    leaseOcrResultCount: number;
    leaseActiveJobCount: number;
    persistedHeartbeatCount: number;
    persistedLastHeartbeatElapsedMs: number;
  };
};

const manager: RequestUser = {
  id: "p3-worker-liveness-manager",
  displayName: "Worker 存活保护金标管理员",
  provider: "development",
  authenticated: true,
  isGatewayAdmin: true,
};
const memberId = "p3-worker-liveness-member";

function pngBytes(seed = 0x31) {
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

function errorCode(error: unknown) {
  return (error as { code?: string })?.code;
}

function sleep(milliseconds: number) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

test("keeps slow OCR alive, isolates silent and false-alive workers, and renews local job leases", async () => {
  const directory = mkdtempSync(
    join(tmpdir(), "health-records-p3-worker-liveness-"),
  );
  const previousEnvironment = {
    PYTHONPATH: process.env.PYTHONPATH,
    OCR_PYTHON_BIN: process.env.OCR_PYTHON_BIN,
    OCR_WORKER_SCRIPT: process.env.OCR_WORKER_SCRIPT,
    OCR_WORKER_TIMEOUT_MS: process.env.OCR_WORKER_TIMEOUT_MS,
    OCR_WORKER_HARD_TIMEOUT_MS: process.env.OCR_WORKER_HARD_TIMEOUT_MS,
    OCR_WORKER_STARTUP_TIMEOUT_MS: process.env.OCR_WORKER_STARTUP_TIMEOUT_MS,
    OCR_WORKER_HEARTBEAT_INTERVAL_MS:
      process.env.OCR_WORKER_HEARTBEAT_INTERVAL_MS,
    PROCESSING_JOB_LEASE_HEARTBEAT_INTERVAL_MS:
      process.env.PROCESSING_JOB_LEASE_HEARTBEAT_INTERVAL_MS,
    STORAGE_DIR: process.env.STORAGE_DIR,
    LOG_DIR: process.env.LOG_DIR,
  };
  process.env.STORAGE_DIR = directory;
  process.env.LOG_DIR = join(directory, "logs");
  /* CI 共享 runner 启动 python 冷进程较慢，启动与心跳不响应窗口留足余量，避免存活金标抖动 */
  process.env.OCR_WORKER_STARTUP_TIMEOUT_MS = "2000";

  try {
    const fakeModules = join(directory, "python-modules");
    const pilDirectory = join(fakeModules, "PIL");
    mkdirSync(pilDirectory, { recursive: true });
    writeFileSync(join(pilDirectory, "__init__.py"), "from . import Image\n");
    writeFileSync(
      join(pilDirectory, "Image.py"),
      `
MAX_IMAGE_PIXELS = None
class Source:
    size = (64, 64)
    def __enter__(self): return self
    def __exit__(self, *args): return False
    def load(self): return None
def open(path): return Source()
`,
    );
    for (const moduleName of [
      "rapidocr_openvino.py",
      "rapidocr_onnxruntime.py",
    ]) {
      writeFileSync(
        join(fakeModules, moduleName),
        `
import time
__version__ = "liveness-golden"
class RapidOCR:
    def __call__(self, path):
        time.sleep(0.46)
        return ([([[0, 0], [100, 0], [100, 12], [0, 12]], "匿名检查项目 5.0 mmol/L", 0.99)], {"elapsed": 460})
`,
      );
    }
    process.env.PYTHONPATH = previousEnvironment.PYTHONPATH
      ? `${fakeModules}:${previousEnvironment.PYTHONPATH}`
      : fakeModules;
    process.env.OCR_PYTHON_BIN = "/usr/bin/python3";
    process.env.OCR_WORKER_SCRIPT = resolve("packages/ocr-worker/worker.py");
    process.env.OCR_WORKER_TIMEOUT_MS = "400";
    process.env.OCR_WORKER_HARD_TIMEOUT_MS = "1500";
    process.env.OCR_WORKER_HEARTBEAT_INTERVAL_MS = "100";
    const pythonInput = join(directory, "python-heartbeat.png");
    writeFileSync(pythonInput, pngBytes());
    stopWorker();

    const pythonResponse = await requestWorker({
      action: "ocr",
      imagePath: pythonInput,
    });
    assert.equal(pythonResponse.ok, true);
    assert.equal(
      Number(pythonResponse.workerHeartbeatCount) >=
        fixture.expected.pythonHeartbeatMinimum,
      true,
    );
    assert.equal(
      Number(pythonResponse.workerLastHeartbeatElapsedMs) >= 300,
      true,
    );

    const processCountPath = join(directory, "client-process-count");
    const livenessScript = join(directory, "liveness-worker.mjs");
    writeFileSync(
      livenessScript,
      `
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
const countPath = ${JSON.stringify(processCountPath)};
const processNumber = (existsSync(countPath) ? Number(readFileSync(countPath, "utf8")) : 0) + 1;
writeFileSync(countPath, String(processNumber));
console.log(JSON.stringify({ type: "ready", ok: true }));
const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.imagePath === "silent-stuck") return;
  if (request.imagePath === "long-heartbeat") {
    const started = Date.now();
    const heartbeat = setInterval(() => {
      console.log(JSON.stringify({
        type: "heartbeat",
        id: request.id,
        action: request.action,
        elapsedMs: Date.now() - started
      }));
    }, 40);
    setTimeout(() => {
      clearInterval(heartbeat);
      console.log(JSON.stringify({ id: request.id, ok: true, lines: [{ text: "long-ok" }] }));
    }, 360);
    return;
  }
  if (request.imagePath === "false-alive") {
    const started = Date.now();
    setInterval(() => {
      console.log(JSON.stringify({
        type: "heartbeat",
        id: request.id,
        action: request.action,
        elapsedMs: Date.now() - started
      }));
    }, 40);
    return;
  }
  if (request.imagePath === "invalid-heartbeat") {
    console.log(JSON.stringify({
      type: "heartbeat",
      id: request.id,
      action: request.action,
      elapsedMs: "invalid"
    }));
    return;
  }
  console.log(JSON.stringify({ id: request.id, ok: true, lines: [{ text: request.imagePath }] }));
});
`,
    );
    stopWorker();
    process.env.OCR_PYTHON_BIN = process.execPath;
    process.env.OCR_WORKER_SCRIPT = livenessScript;
    process.env.OCR_WORKER_TIMEOUT_MS = "300";
    process.env.OCR_WORKER_HARD_TIMEOUT_MS = "1000";

    const longResponse = await requestWorker({
      action: "ocr",
      imagePath: "long-heartbeat",
    });
    assert.equal(
      Number(longResponse.workerHeartbeatCount) >=
        fixture.expected.clientLongHeartbeatMinimum,
      true,
    );

    const silentResults = await Promise.allSettled([
      requestWorker({ action: "ocr", imagePath: "silent-stuck" }),
      requestWorker({ action: "ocr", imagePath: "after-silent" }),
    ]);
    assert.equal(silentResults[0]?.status, "rejected");
    assert.equal(
      errorCode((silentResults[0] as PromiseRejectedResult).reason),
      fixture.expected.silentTimeoutCode,
    );
    assert.equal(silentResults[1]?.status, "fulfilled");

    process.env.OCR_WORKER_HARD_TIMEOUT_MS = "300";
    const hardTimeoutResults = await Promise.allSettled([
      requestWorker({ action: "ocr", imagePath: "false-alive" }),
      requestWorker({ action: "ocr", imagePath: "after-hard-timeout" }),
    ]);
    assert.equal(hardTimeoutResults[0]?.status, "rejected");
    assert.equal(
      errorCode((hardTimeoutResults[0] as PromiseRejectedResult).reason),
      fixture.expected.hardTimeoutCode,
    );
    assert.equal(hardTimeoutResults[1]?.status, "fulfilled");

    process.env.OCR_WORKER_HARD_TIMEOUT_MS = "1000";
    const invalidHeartbeatResults = await Promise.allSettled([
      requestWorker({ action: "ocr", imagePath: "invalid-heartbeat" }),
      requestWorker({ action: "ocr", imagePath: "after-invalid-heartbeat" }),
    ]);
    assert.equal(invalidHeartbeatResults[0]?.status, "rejected");
    assert.equal(
      errorCode((invalidHeartbeatResults[0] as PromiseRejectedResult).reason),
      fixture.expected.invalidHeartbeatProtocolCode,
    );
    assert.equal(invalidHeartbeatResults[1]?.status, "fulfilled");

    const successfulClientResponses = [
      longResponse,
      silentResults[1]?.status === "fulfilled" ? silentResults[1].value : null,
      hardTimeoutResults[1]?.status === "fulfilled"
        ? hardTimeoutResults[1].value
        : null,
      invalidHeartbeatResults[1]?.status === "fulfilled"
        ? invalidHeartbeatResults[1].value
        : null,
    ].filter(Boolean);
    assert.equal(
      successfulClientResponses.length,
      fixture.expected.clientSuccessfulResponseCount,
    );
    assert.equal(
      Number(readFileSync(processCountPath, "utf8")),
      fixture.expected.clientProcessCount,
    );

    stopWorker();
    process.env.PROCESSING_JOB_LEASE_HEARTBEAT_INTERVAL_MS = "25";
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
    const upload = createUpload(manager, memberId, [
      { originalName: "长耗时本地识别.png", data: pngBytes(0x32) },
    ]);
    db.prepare(
      "UPDATE processing_jobs SET status = 'cancelled' WHERE report_id = ? AND job_type = 'thumbnail'",
    ).run(upload.reportId);

    let releaseExecutor!: (response: {
      ok: boolean;
      engine: string;
      modelVersion: string;
      lines: Array<Record<string, unknown>>;
      elapsedMs: number;
      workerHeartbeatCount: number;
      workerLastHeartbeatElapsedMs: number;
    }) => void;
    let markExecutorStarted!: () => void;
    const executorStarted = new Promise<void>((resolveStarted) => {
      markExecutorStarted = resolveStarted;
    });
    const heldResponse = new Promise<{
      ok: boolean;
      engine: string;
      modelVersion: string;
      lines: Array<Record<string, unknown>>;
      elapsedMs: number;
      workerHeartbeatCount: number;
      workerLastHeartbeatElapsedMs: number;
    }>((resolveResponse) => {
      releaseExecutor = resolveResponse;
    });
    const runningJob = processNextJob(async () => {
      markExecutorStarted();
      return heldResponse;
    });
    await executorStarted;
    const processingJob = db
      .prepare(
        `
        SELECT id, attempts FROM processing_jobs
        WHERE report_id = ? AND job_type = 'ocr'
      `,
      )
      .get(upload.reportId) as { id: string; attempts: number };
    db.prepare(
      "UPDATE processing_jobs SET lease_expires_at = datetime('now', '-1 minute') WHERE id = ?",
    ).run(processingJob.id);
    await sleep(250);

    assert.equal(claimNextJob(), null);
    const renewedJob = db
      .prepare(
        `
        SELECT status, attempts, lease_expires_at > CURRENT_TIMESTAMP AS leaseIsFresh
        FROM processing_jobs WHERE id = ?
      `,
      )
      .get(processingJob.id) as {
      status: string;
      attempts: number;
      leaseIsFresh: number;
    };
    assert.equal(renewedJob.status, "processing");
    assert.equal(renewedJob.attempts, fixture.expected.leaseJobAttempts);
    assert.equal(renewedJob.leaseIsFresh, 1);

    releaseExecutor({
      ok: true,
      engine: "liveness-golden",
      modelVersion: "liveness-v1",
      lines: [
        {
          id: "line_1",
          text: "匿名检查项目 5.0 mmol/L",
          confidence: 0.99,
          box: [0, 0, 120, 12],
        },
      ],
      elapsedMs: 460,
      workerHeartbeatCount: fixture.expected.persistedHeartbeatCount,
      workerLastHeartbeatElapsedMs:
        fixture.expected.persistedLastHeartbeatElapsedMs,
    });
    assert.equal(await runningJob, true);

    const completedJob = db
      .prepare(
        `
        SELECT status, attempts FROM processing_jobs WHERE id = ?
      `,
      )
      .get(processingJob.id) as { status: string; attempts: number };
    assert.equal(completedJob.status, "completed");
    assert.equal(completedJob.attempts, fixture.expected.leaseJobAttempts);
    assert.equal(
      (
        db
          .prepare("SELECT COUNT(*) AS count FROM ocr_results WHERE job_id = ?")
          .get(processingJob.id) as { count: number }
      ).count,
      fixture.expected.leaseOcrResultCount,
    );
    assert.equal(
      (
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM processing_jobs WHERE report_id = ? AND status IN ('queued', 'processing')",
          )
          .get(upload.reportId) as { count: number }
      ).count,
      fixture.expected.leaseActiveJobCount,
    );
    const completedEvent = db
      .prepare(
        `
        SELECT detail_json AS detailJson FROM processing_job_events
        WHERE job_id = ? AND event_type = 'completed'
        ORDER BY created_at DESC, rowid DESC LIMIT 1
      `,
      )
      .get(processingJob.id) as { detailJson: string };
    const completedDetail = JSON.parse(completedEvent.detailJson) as {
      workerHeartbeatCount?: number;
      workerLastHeartbeatElapsedMs?: number;
    };
    assert.equal(
      completedDetail.workerHeartbeatCount,
      fixture.expected.persistedHeartbeatCount,
    );
    assert.equal(
      completedDetail.workerLastHeartbeatElapsedMs,
      fixture.expected.persistedLastHeartbeatElapsedMs,
    );
  } finally {
    stopWorker();
    closeDatabaseForTests();
    for (const [name, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(directory, { recursive: true, force: true });
  }
});
