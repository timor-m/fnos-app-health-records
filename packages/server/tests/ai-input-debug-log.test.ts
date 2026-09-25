import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { closeDatabaseForTests, getDatabase } from "../database/client.ts";
import {
  calculateAiOutputTokenBudget,
  requestAiExtraction
} from "../services/ai-extraction.service.ts";
import { saveAiSettings } from "../services/ai-settings.service.ts";
import {
  isAiInputDebugLogEnabled,
  writeAiInputDebugLog
} from "../utils/ai-input-debug-log.ts";

async function withDebugLogEnvironment(run: (logDir: string) => Promise<void>) {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-ai-debug-"));
  const logDir = join(storageDir, "logs");
  const oldFetch = globalThis.fetch;
  const previous = {
    storageDir: process.env.STORAGE_DIR,
    logDir: process.env.LOG_DIR,
    debug: process.env.AI_INPUT_DEBUG_LOG,
    nodeEnv: process.env.NODE_ENV,
    viteDevServerUrl: process.env.VITE_DEV_SERVER_URL
  };
  process.env.STORAGE_DIR = storageDir;
  process.env.LOG_DIR = logDir;
  try {
    await run(logDir);
  } finally {
    closeDatabaseForTests();
    globalThis.fetch = oldFetch;
    if (previous.storageDir === undefined) delete process.env.STORAGE_DIR;
    else process.env.STORAGE_DIR = previous.storageDir;
    if (previous.logDir === undefined) delete process.env.LOG_DIR;
    else process.env.LOG_DIR = previous.logDir;
    if (previous.debug === undefined) delete process.env.AI_INPUT_DEBUG_LOG;
    else process.env.AI_INPUT_DEBUG_LOG = previous.debug;
    if (previous.nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous.nodeEnv;
    if (previous.viteDevServerUrl === undefined) delete process.env.VITE_DEV_SERVER_URL;
    else process.env.VITE_DEV_SERVER_URL = previous.viteDevServerUrl;
    rmSync(storageDir, { recursive: true, force: true });
  }
}

test("logs the exact redacted AI request body in development", async () => {
  await withDebugLogEnvironment(async (logDir) => {
    process.env.NODE_ENV = "development";
    delete process.env.AI_INPUT_DEBUG_LOG;
    getDatabase();
    saveAiSettings({
      enabled: true,
      baseUrl: "https://ai.example.test/v1",
      textModel: "health-structurer",
      apiKey: "sk-debug-secret"
    });

    let sentBody = "";
    globalThis.fetch = async (_input, init) => {
      sentBody = String(init?.body || "");
      return new Response(JSON.stringify({
        model: "health-structurer",
        choices: [{ message: { content: JSON.stringify({
          reportType: "laboratory",
          title: "血糖检验报告",
          identifiers: { reportNo: "R-20260729" },
          observations: []
        }) } }],
        usage: { prompt_tokens: 100, completion_tokens: 20 }
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    };

    assert.equal(isAiInputDebugLogEnabled(), true);
    await requestAiExtraction({
      reportId: "local-report-id",
      text: [
        "[第 1 页]",
        "姓名：张三 报告号：R-20260729",
        "手机号：13800138000",
        "空腹血糖 5.2 mmol/L"
      ].join("\n"),
      inputCharacters: 78,
      pageCount: 1,
      plannedUnits: 1,
      planHash: "plan-hash",
      compatibilityTruncated: false
    });

    const filePath = join(logDir, "ai-input-debug.log");
    assert.equal(existsSync(filePath), true);
    const raw = readFileSync(filePath, "utf8");
    const inputStart = raw.indexOf("===== AI INPUT");
    const inputEnd = raw.indexOf("===== END AI INPUT =====", inputStart);
    const jsonText = raw.slice(raw.indexOf("{", inputStart), inputEnd).trim();
    const entry = JSON.parse(jsonText) as {
      requestId: string;
      requestBody: Record<string, unknown>;
      provider: string;
      planHash: string;
    };

    assert.deepEqual(entry.requestBody, JSON.parse(sentBody));
    assert.equal(entry.requestBody.max_tokens, 8192);
    assert.equal(entry.provider, "ai.example.test");
    assert.equal(entry.planHash, "plan-hash");
    assert.match(raw, /健康报告结构化助手/);
    assert.match(raw, /R-20260729/);
    assert.match(raw, /空腹血糖 5\.2 mmol\/L/);
    assert.doesNotMatch(raw, /张三|13800138000|sk-debug-secret|local-report-id/);
    const withOutput = readFileSync(filePath, "utf8");
    assert.match(withOutput, /===== AI OUTPUT/);
    assert.ok(entry.requestId);
    const outputStart = withOutput.indexOf("===== AI OUTPUT");
    const outputEnd = withOutput.indexOf("===== END AI OUTPUT =====", outputStart);
    const output = JSON.parse(withOutput.slice(withOutput.indexOf("{", outputStart), outputEnd).trim()) as {
      requestId: string; responseContent: string; completionTokens: number;
    };
    assert.equal(output.requestId, entry.requestId);
    assert.match(output.responseContent, /血糖检验报告/);
    assert.match(withOutput, /空腹血糖/);
    assert.equal(output.completionTokens, 20);
    assert.doesNotMatch(withOutput, /sk-debug-secret/);
  });
});

test("classifies provider output truncation before attempting to parse partial JSON", async () => {
  await withDebugLogEnvironment(async () => {
    process.env.AI_INPUT_DEBUG_LOG = "0";
    getDatabase();
    saveAiSettings({
      enabled: true,
      baseUrl: "https://ai.example.test/v1",
      textModel: "health-structurer",
      apiKey: "sk-debug-secret"
    });
    globalThis.fetch = async () => new Response(JSON.stringify({
      model: "health-structurer",
      choices: [{ finish_reason: "length", message: { content: "{\"reportType\":" } }]
    }), { status: 200, headers: { "content-type": "application/json" } });

    await assert.rejects(
      () => requestAiExtraction({ reportId: "report", text: "[第 1 页]\n血糖 5.2", inputCharacters: 18, pageCount: 1 }),
      (error: unknown) => (error as { code?: string }).code === "AI_OUTPUT_TRUNCATED"
    );
  });
});

test("calculates output tokens from task type and extraction complexity", () => {
  const small = calculateAiOutputTokenBudget({
    text: "[第 1 页]\n血糖 5.2 mmol/L",
    inputCharacters: 24,
    pageCount: 1,
    candidateCount: 1,
    promptMode: "standard"
  }, 384_000);
  const dense = calculateAiOutputTokenBudget({
    text: `[第 1 页]\n${Array.from({ length: 30 }, (_, index) => `结节 ${index + 1} mm`).join("\n")}`,
    inputCharacters: 6000,
    pageCount: 4,
    candidateCount: 45,
    promptMode: "standard"
  }, 384_000);
  const supplement = calculateAiOutputTokenBudget({
    text: "[第 1 页]\n血糖 5.2 mmol/L",
    inputCharacters: 24,
    pageCount: 1,
    candidateCount: 1,
    promptMode: "supplement"
  }, 384_000);

  assert.equal(small, 8_192);
  assert.ok(dense > small);
  assert.equal(supplement, 4_096);
  assert.equal(calculateAiOutputTokenBudget({
    text: "密集内容",
    inputCharacters: 80_000,
    pageCount: 8,
    candidateCount: 500,
    promptMode: "standard",
    outputTokenScale: 8
  }, 32_768), 32_768);
});

test("keeps AI input debug logging disabled by default in production", async () => {
  await withDebugLogEnvironment(async (logDir) => {
    process.env.NODE_ENV = "production";
    delete process.env.VITE_DEV_SERVER_URL;
    delete process.env.AI_INPUT_DEBUG_LOG;

    assert.equal(isAiInputDebugLogEnabled(), false);
    await writeAiInputDebugLog({
      provider: "ai.example.test",
      model: "test-model",
      promptVersion: "test-v1",
      inputCharacters: 4,
      pageCount: 1,
      requestBody: { messages: [{ role: "user", content: "测试" }] }
    });
    assert.equal(existsSync(join(logDir, "ai-input-debug.log")), false);
  });
});
