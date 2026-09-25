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
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { closeDatabaseForTests, getDatabase } from "../database/client.ts";
import type { RequestUser } from "../domain/request-user.ts";
import { processNextJob } from "../services/job-runner.service.ts";
import { requestWorker, stopWorker } from "../services/ocr-worker-client.ts";
import { createUpload } from "../services/upload.service.ts";

const fixture = JSON.parse(
  readFileSync(
    new URL(
      "./fixtures/p3-ocr-worker-input-resource-boundary-golden.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as {
  expected: {
    inputTooLargeCode: string;
    inputPreflightWorkerStarts: number;
    pdfPageCountCode: string;
    pdfPageDimensionsCode: string;
    imageDimensionsCode: string;
    ocrEngineLoadsBeforeBoundaryFailure: number;
    inspectProtocolCode: string;
    inspectLimitCode: string;
    inspectRecoveryProcessCount: number;
    invalidOutputCode: string;
    largeOutputCode: string;
    thumbnailRecoveryProcessCount: number;
    jobRetryAttempts: number;
    jobWorkerRequestCount: number;
    persistedOcrResultCount: number;
    activeJobsAfterRecovery: number;
    reportStatusAfterRecovery: string;
  };
};

const manager: RequestUser = {
  id: "p3-worker-resource-manager",
  displayName: "Worker 资源边界金标管理员",
  provider: "development",
  authenticated: true,
  isGatewayAdmin: true,
};
const memberId = "p3-worker-resource-member";

function pngBytes() {
  return Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x34,
  ]);
}

function errorCode(error: unknown) {
  return (error as { code?: string })?.code;
}

function numericFile(path: string) {
  return existsSync(path) ? Number(readFileSync(path, "utf8")) : 0;
}

function useNodeWorker(scriptPath: string) {
  stopWorker();
  process.env.OCR_PYTHON_BIN = process.execPath;
  process.env.OCR_WORKER_SCRIPT = scriptPath;
}

function writeCountingWorker(
  scriptPath: string,
  processCountPath: string,
  handlerSource: string,
) {
  writeFileSync(
    scriptPath,
    `
import { dirname } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
const countPath = ${JSON.stringify(processCountPath)};
const count = existsSync(countPath) ? Number(readFileSync(countPath, "utf8")) : 0;
writeFileSync(countPath, String(count + 1));
console.log(JSON.stringify({ type: "ready", ok: true }));
const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  const request = JSON.parse(line);
  ${handlerSource}
});
`,
  );
}

test("protects OCR input, rendered page, and temporary output resources before persistence", async () => {
  const directory = mkdtempSync(
    join(tmpdir(), "health-records-p3-worker-resource-"),
  );
  const previousPythonPath = process.env.PYTHONPATH;
  process.env.STORAGE_DIR = directory;
  process.env.LOG_DIR = join(directory, "logs");
  process.env.OCR_WORKER_TIMEOUT_MS = "1000";
  // Normal process startup is not the boundary under test; allow parallel-suite scheduling.
  process.env.OCR_WORKER_STARTUP_TIMEOUT_MS = "10000";
  process.env.OCR_WORKER_MAX_INPUT_FILE_BYTES = "10";
  process.env.OCR_WORKER_MAX_OUTPUT_FILE_BYTES = "1024";
  process.env.OCR_WORKER_MAX_PDF_PAGES = "500";
  process.env.OCR_WORKER_MAX_IMAGE_PIXELS = "1000000";
  process.env.OCR_WORKER_MAX_PDF_PAGE_RENDER_PIXELS = "10000000";
  try {
    const preflightCountPath = join(directory, "preflight-process-count");
    const preflightScript = join(directory, "preflight-worker.mjs");
    writeCountingWorker(
      preflightScript,
      preflightCountPath,
      `console.log(JSON.stringify({ id: request.id, ok: true, lines: [] }));`,
    );
    useNodeWorker(preflightScript);
    const oversizedInput = join(directory, "oversized-input.png");
    writeFileSync(oversizedInput, Buffer.alloc(11, 1));
    await assert.rejects(
      () => requestWorker({ action: "ocr", imagePath: oversizedInput }),
      (error: unknown) =>
        errorCode(error) === fixture.expected.inputTooLargeCode,
    );
    assert.equal(
      numericFile(preflightCountPath),
      fixture.expected.inputPreflightWorkerStarts,
    );
    writeFileSync(oversizedInput, pngBytes());
    assert.equal(
      (await requestWorker({ action: "ocr", imagePath: oversizedInput })).ok,
      true,
    );

    stopWorker();
    const fakeModules = join(directory, "python-modules");
    const pilDirectory = join(fakeModules, "PIL");
    mkdirSync(pilDirectory, { recursive: true });
    const engineLoadMarker = join(directory, "python-engine-loaded");
    writeFileSync(
      join(fakeModules, "fitz.py"),
      `
class Rect:
    def __init__(self, width, height):
        self.width = width
        self.height = height
class Page:
    def __init__(self, width, height):
        self.rect = Rect(width, height)
class Document:
    def __init__(self, path):
        self.path = str(path)
        self.page_count = 501 if "page-count" in self.path else 1
    def __enter__(self): return self
    def __exit__(self, *args): return False
    def load_page(self, index): return Page(2000, 2000)
def open(path): return Document(path)
class Matrix:
    def __init__(self, *args): pass
`,
    );
    writeFileSync(join(pilDirectory, "__init__.py"), "from . import Image\n");
    writeFileSync(
      join(pilDirectory, "Image.py"),
      `
MAX_IMAGE_PIXELS = None
class Source:
    size = (2000, 2000)
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
from pathlib import Path
Path(${JSON.stringify(engineLoadMarker)}).write_text("loaded")
class RapidOCR:
    def __call__(self, path): return ([], {})
`,
      );
    }
    process.env.PYTHONPATH = previousPythonPath
      ? `${fakeModules}:${previousPythonPath}`
      : fakeModules;
    process.env.OCR_PYTHON_BIN = "/usr/bin/python3";
    process.env.OCR_WORKER_SCRIPT = resolve("packages/ocr-worker/worker.py");
    for (const [name, action, expectedCode] of [
      ["page-count.pdf", "inspect_pdf", fixture.expected.pdfPageCountCode],
      ["page-size.pdf", "inspect_pdf", fixture.expected.pdfPageDimensionsCode],
      ["image-size.png", "ocr", fixture.expected.imageDimensionsCode],
    ] as const) {
      const inputPath = join(directory, name);
      writeFileSync(
        inputPath,
        name.endsWith(".pdf") ? Buffer.from("%PDF-1.7") : pngBytes(),
      );
      await assert.rejects(
        () => requestWorker({ action, imagePath: inputPath }),
        (error: unknown) => errorCode(error) === expectedCode,
      );
    }
    assert.equal(
      Number(existsSync(engineLoadMarker)),
      fixture.expected.ocrEngineLoadsBeforeBoundaryFailure,
    );

    const inspectCountPath = join(directory, "inspect-process-count");
    const inspectScript = join(directory, "inspect-worker.mjs");
    writeCountingWorker(
      inspectScript,
      inspectCountPath,
      `
const name = String(request.imagePath);
let response;
if (name.includes("missing-page")) response = { pageCount: 2, pages: [{ pageNumber: 1, width: 595, height: 842 }] };
else if (name.includes("wrong-order")) response = { pageCount: 2, pages: [{ pageNumber: 1, width: 595, height: 842 }, { pageNumber: 1, width: 595, height: 842 }] };
else if (name.includes("huge-page")) response = { pageCount: 1, pages: [{ pageNumber: 1, width: 2000, height: 2000 }] };
else response = { pageCount: 1, pages: [{ pageNumber: 1, width: 595, height: 842 }] };
console.log(JSON.stringify({ id: request.id, ok: true, ...response }));
`,
    );
    useNodeWorker(inspectScript);
    for (const name of ["missing-page", "wrong-order"]) {
      await assert.rejects(
        () => requestWorker({ action: "inspect_pdf", imagePath: name }),
        (error: unknown) =>
          errorCode(error) === fixture.expected.inspectProtocolCode,
      );
    }
    await assert.rejects(
      () => requestWorker({ action: "inspect_pdf", imagePath: "huge-page" }),
      (error: unknown) =>
        errorCode(error) === fixture.expected.inspectLimitCode,
    );
    const validInspect = await requestWorker({
      action: "inspect_pdf",
      imagePath: "valid-page",
    });
    assert.equal(validInspect.pageCount, 1);
    assert.equal(
      numericFile(inspectCountPath),
      fixture.expected.inspectRecoveryProcessCount,
    );

    const thumbnailCountPath = join(directory, "thumbnail-process-count");
    const thumbnailScript = join(directory, "thumbnail-worker.mjs");
    writeCountingWorker(
      thumbnailScript,
      thumbnailCountPath,
      `
const name = String(request.imagePath);
if (request.outputPath && !name.includes("missing")) {
  mkdirSync(dirname(request.outputPath), { recursive: true });
  if (name.includes("empty")) writeFileSync(request.outputPath, Buffer.alloc(0));
  else if (name.includes("not-jpeg")) writeFileSync(request.outputPath, "not-jpeg");
  else if (name.includes("too-large")) writeFileSync(request.outputPath, Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(2048)]));
  else writeFileSync(request.outputPath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
}
const dimension = name.includes("wrong-size") ? 800 : 320;
console.log(JSON.stringify({ id: request.id, ok: true, width: dimension, height: dimension }));
`,
    );
    useNodeWorker(thumbnailScript);
    for (const [name, expectedCode] of [
      ["missing", fixture.expected.invalidOutputCode],
      ["empty", fixture.expected.invalidOutputCode],
      ["not-jpeg", fixture.expected.invalidOutputCode],
      ["too-large", fixture.expected.largeOutputCode],
      ["wrong-size", fixture.expected.inspectProtocolCode],
    ] as const) {
      const outputPath = join(directory, "outputs", `${name}.jpg`);
      await assert.rejects(
        () =>
          requestWorker({
            action: "thumbnail",
            imagePath: name,
            outputPath,
            maxSize: 480,
          }),
        (error: unknown) => errorCode(error) === expectedCode,
      );
      assert.equal(existsSync(outputPath), false);
    }
    const validOutput = join(directory, "outputs", "valid.jpg");
    const validThumbnail = await requestWorker({
      action: "thumbnail",
      imagePath: "valid",
      outputPath: validOutput,
      maxSize: 480,
    });
    assert.equal(validThumbnail.ok, true);
    assert.equal(existsSync(validOutput), true);
    assert.equal(
      numericFile(thumbnailCountPath),
      fixture.expected.thumbnailRecoveryProcessCount,
    );

    const jobRequestCountPath = join(directory, "job-request-count");
    const jobScript = join(directory, "job-worker.mjs");
    writeCountingWorker(
      jobScript,
      join(directory, "job-process-count"),
      `
const count = existsSync(${JSON.stringify(jobRequestCountPath)}) ? Number(readFileSync(${JSON.stringify(jobRequestCountPath)}, "utf8")) : 0;
writeFileSync(${JSON.stringify(jobRequestCountPath)}, String(count + 1));
if (request.action === "thumbnail") {
  mkdirSync(dirname(request.outputPath), { recursive: true });
  writeFileSync(request.outputPath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  console.log(JSON.stringify({ id: request.id, ok: true, width: 320, height: 240 }));
} else {
  console.log(JSON.stringify({ id: request.id, ok: true, engine: "resource-golden", modelVersion: "resource-v1", lines: [{ id: "resource-line-1", text: "匿名检查项目 5.0 mmol/L", confidence: 0.99, box: [0, 0, 120, 12] }] }));
}
`,
    );
    useNodeWorker(jobScript);

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
      { originalName: "资源边界恢复.png", data: pngBytes() },
    ]);
    const page = db
      .prepare(
        "SELECT id, storage_path AS storagePath FROM report_pages WHERE report_id = ?",
      )
      .get(upload.reportId) as { id: string; storagePath: string };
    const sourcePath = join(directory, page.storagePath);
    writeFileSync(sourcePath, Buffer.alloc(11, 1));
    db.prepare("UPDATE report_pages SET file_size = 11 WHERE id = ?").run(
      page.id,
    );

    await assert.rejects(
      () => processNextJob(),
      (error: unknown) =>
        errorCode(error) === fixture.expected.inputTooLargeCode,
    );
    let thumbnailJob = db
      .prepare(
        `
        SELECT id, status, attempts, error_code AS errorCode
        FROM processing_jobs WHERE report_id = ? AND job_type = 'thumbnail'
      `,
      )
      .get(upload.reportId) as {
      id: string;
      status: string;
      attempts: number;
      errorCode: string | null;
    };
    assert.equal(thumbnailJob.status, "queued");
    assert.equal(thumbnailJob.errorCode, fixture.expected.inputTooLargeCode);
    assert.equal(numericFile(jobRequestCountPath), 0);

    writeFileSync(sourcePath, pngBytes());
    db.prepare("UPDATE report_pages SET file_size = 9 WHERE id = ?").run(
      page.id,
    );
    db.prepare(
      "UPDATE processing_jobs SET next_retry_at = CURRENT_TIMESTAMP WHERE id = ?",
    ).run(thumbnailJob.id);
    assert.equal(await processNextJob(), true);
    assert.equal(await processNextJob(), true);
    thumbnailJob = db
      .prepare(
        `
        SELECT id, status, attempts, error_code AS errorCode
        FROM processing_jobs WHERE id = ?
      `,
      )
      .get(thumbnailJob.id) as typeof thumbnailJob;
    assert.equal(thumbnailJob.status, "completed");
    assert.equal(thumbnailJob.errorCode, null);
    assert.equal(thumbnailJob.attempts, fixture.expected.jobRetryAttempts);
    assert.equal(
      numericFile(jobRequestCountPath),
      fixture.expected.jobWorkerRequestCount,
    );
    const ocrResultCount = db
      .prepare("SELECT COUNT(*) AS count FROM ocr_results WHERE page_id = ?")
      .get(page.id) as { count: number };
    assert.equal(
      ocrResultCount.count,
      fixture.expected.persistedOcrResultCount,
    );
    const activeJobs = db
      .prepare(
        `
        SELECT COUNT(*) AS count FROM processing_jobs
        WHERE report_id = ? AND status IN ('queued', 'processing')
      `,
      )
      .get(upload.reportId) as { count: number };
    assert.equal(activeJobs.count, fixture.expected.activeJobsAfterRecovery);
    const report = db
      .prepare("SELECT status FROM reports WHERE id = ?")
      .get(upload.reportId) as { status: string };
    assert.equal(report.status, fixture.expected.reportStatusAfterRecovery);
  } finally {
    stopWorker();
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    delete process.env.LOG_DIR;
    delete process.env.OCR_PYTHON_BIN;
    delete process.env.OCR_WORKER_SCRIPT;
    delete process.env.OCR_WORKER_TIMEOUT_MS;
    delete process.env.OCR_WORKER_STARTUP_TIMEOUT_MS;
    delete process.env.OCR_WORKER_MAX_INPUT_FILE_BYTES;
    delete process.env.OCR_WORKER_MAX_OUTPUT_FILE_BYTES;
    delete process.env.OCR_WORKER_MAX_PDF_PAGES;
    delete process.env.OCR_WORKER_MAX_IMAGE_PIXELS;
    delete process.env.OCR_WORKER_MAX_PDF_PAGE_RENDER_PIXELS;
    if (previousPythonPath === undefined) delete process.env.PYTHONPATH;
    else process.env.PYTHONPATH = previousPythonPath;
    rmSync(directory, { recursive: true, force: true });
  }
});
