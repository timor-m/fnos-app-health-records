import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  requestWorker,
  stopWorker,
} from "../services/ocr-worker-client.ts";
import { writeLog } from "../utils/logger.ts";

test("filters known-benign onnxruntime telemetry noise from worker stderr logs", async () => {
  const directory = mkdtempSync(
    join(tmpdir(), "health-records-worker-benign-stderr-"),
  );
  process.env.STORAGE_DIR = directory;
  process.env.LOG_DIR = join(directory, "logs");
  const script = join(directory, "telemetry-noise-worker.mjs");
  writeFileSync(
    script,
    `
import { createInterface } from "node:readline";
process.stderr.write("\\u001b[0;93m2026-09-17 15:42:54.808838813 [W:onnxruntime:Default, telemetry.cc:800 operator()] Failed to persist telemetry device ID; using an in-memory identifier\\u001b[m\\n");
process.stderr.write("simulated genuine worker diagnostic\\n");
console.log(JSON.stringify({ type: "ready", ok: true }));
const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  const request = JSON.parse(line);
  console.log(JSON.stringify({ id: request.id, ok: true, width: 12, height: 34 }));
});
`,
  );
  try {
    stopWorker();
    process.env.OCR_PYTHON_BIN = process.execPath;
    process.env.OCR_WORKER_SCRIPT = script;
    const response = await requestWorker({
      action: "thumbnail",
      imagePath: "/tmp/ignored",
    });
    assert.equal(response.ok, true);
    await writeLog("info", "worker-benign-stderr-flush");
    const logs = readFileSync(join(directory, "logs", "app.log"), "utf8")
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as { message: string; extra?: { message?: string } },
      )
      .filter((entry) => entry.message === "ocr-worker-stderr");
    assert.equal(logs.length, 1);
    assert.match(logs[0]?.extra?.message ?? "", /genuine worker diagnostic/);
  } finally {
    stopWorker();
    rmSync(directory, { recursive: true, force: true });
  }
});
