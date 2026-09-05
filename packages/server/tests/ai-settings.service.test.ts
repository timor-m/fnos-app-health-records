import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { closeDatabaseForTests, getDatabase } from "../database/client.ts";
import {
  getAiSettings,
  getAiTaskSettings,
  saveAiSettings,
  testAiConnection
} from "../services/ai-settings.service.ts";
import { isAiExtractionConfigured } from "../services/ai-extraction.service.ts";
import { executeAiTask } from "../services/ai-task.service.ts";
import { aiProviderCatalog } from "../services/ai-provider.ts";

async function withDatabase(run: () => Promise<void> | void) {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-ai-settings-"));
  process.env.STORAGE_DIR = storageDir;
  try {
    await run();
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
}

test("migrates the legacy flat AI configuration into the selected provider", async () => {
  await withDatabase(() => {
    saveAiSettings({
      enabled: true,
      provider: "deepseek",
      visionEnabled: true,
      baseUrl: "https://legacy.example.com/v1",
      textModel: "legacy-text",
      visionModel: "legacy-vision",
      apiKey: "legacy-secret-key"
    });
    const db = getDatabase();
    const row = db.prepare("SELECT value_json AS valueJson FROM app_settings WHERE setting_key = 'ai.provider'")
      .get() as { valueJson: string };
    const modern = JSON.parse(row.valueJson) as {
      providers: { deepseek: { apiKeyEncrypted: string } };
    };
    db.prepare("UPDATE app_settings SET value_json = ? WHERE setting_key = 'ai.provider'").run(JSON.stringify({
      enabled: true,
      provider: "deepseek",
      visionEnabled: true,
      baseUrl: "https://legacy.example.com/v1",
      textModel: "legacy-text",
      visionModel: "legacy-vision",
      apiKeyEncrypted: modern.providers.deepseek.apiKeyEncrypted
    }));

    const settings = getAiSettings(true);
    assert.equal(settings.provider, "deepseek");
    assert.equal(settings.baseUrl, "https://legacy.example.com/v1");
    assert.equal(settings.textModel, "legacy-text");
    assert.equal(settings.visionModel, "legacy-vision");
    assert.equal(settings.visionEnabled, true);
    assert.equal(settings.requestTimeoutSeconds, 600);
    assert.equal(settings.apiKey, "legacy-secret-key");
    assert.equal(settings.apiKeyMasked.includes("legacy-secret-key"), false);
  });
});

test("retains independent provider configurations when switching models", async () => {
  await withDatabase(() => {
    saveAiSettings({
      enabled: true,
      provider: "deepseek",
      visionEnabled: false,
      baseUrl: "https://deepseek.example.com/v1",
      textModel: "deepseek-health",
      visionModel: "",
      apiKey: "deepseek-secret-key"
    });
    const qwen = saveAiSettings({
      enabled: true,
      provider: "qwen",
      visionEnabled: true,
      baseUrl: "https://qwen.example.com/v1",
      textModel: "qwen-health",
      visionModel: "qwen-vl-health",
      apiKey: "qwen-secret-key"
    });
    assert.equal(qwen.provider, "qwen");
    assert.equal(qwen.providerSettings.deepseek.textModel, "deepseek-health");
    assert.equal(qwen.providerSettings.deepseek.apiKeyConfigured, true);
    assert.equal(qwen.providerSettings.qwen.visionModel, "qwen-vl-health");

    const deepseek = saveAiSettings({
      enabled: true,
      provider: "deepseek",
      visionEnabled: qwen.providerSettings.deepseek.visionEnabled,
      baseUrl: qwen.providerSettings.deepseek.baseUrl,
      textModel: qwen.providerSettings.deepseek.textModel,
      visionModel: qwen.providerSettings.deepseek.visionModel
    });
    assert.equal(deepseek.provider, "deepseek");
    assert.equal(deepseek.textModel, "deepseek-health");
    assert.equal(deepseek.apiKeyConfigured, true);
    assert.equal(deepseek.providerSettings.qwen.textModel, "qwen-health");
    assert.equal(deepseek.providerSettings.qwen.apiKeyMasked.endsWith("-key"), true);
    assert.equal(isAiExtractionConfigured(), true);

    const stored = JSON.parse((getDatabase().prepare(
      "SELECT value_json AS valueJson FROM app_settings WHERE setting_key = 'ai.provider'"
    ).get() as { valueJson: string }).valueJson) as Record<string, unknown>;
    assert.equal("apiKey" in stored, false);
    assert.equal(JSON.stringify(stored).includes("deepseek-secret-key"), false);
    assert.equal(JSON.stringify(stored).includes("qwen-secret-key"), false);
  });
});

test("stores a global AI request timeout and exposes it to task execution", async () => {
  await withDatabase(() => {
    assert.equal(getAiSettings(false).requestTimeoutSeconds, 600);
    const saved = saveAiSettings({ requestTimeoutSeconds: 900 });
    assert.equal(saved.requestTimeoutSeconds, 900);
    assert.equal(getAiTaskSettings("report_extraction", false).requestTimeoutSeconds, 900);

    assert.throws(
      () => saveAiSettings({ requestTimeoutSeconds: 29 }),
      (error: unknown) => `${(error as { statusText?: string; message?: string }).statusText} ${(error as Error).message}`
        .includes("30 至 3600 秒")
    );
  });
});

test("retains independent OpenAI and Doubao configurations when switching providers", async () => {
  await withDatabase(() => {
    saveAiSettings({
      enabled: true,
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      textModel: "gpt-4.1-mini",
      visionModel: "gpt-4.1-mini",
      apiKey: "openai-secret-key"
    });
    const doubao = saveAiSettings({
      enabled: true,
      provider: "doubao",
      baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
      textModel: "ep-doubao-text",
      visionModel: "ep-doubao-vision",
      apiKey: "doubao-secret-key"
    });

    assert.equal(doubao.providerSettings.openai.textModel, "gpt-4.1-mini");
    assert.equal(doubao.providerSettings.openai.apiKeyConfigured, true);
    assert.equal(doubao.providerSettings.doubao.textModel, "ep-doubao-text");
    assert.equal(doubao.providerSettings.doubao.apiKeyConfigured, true);

    const openai = saveAiSettings({
      provider: "openai",
      baseUrl: doubao.providerSettings.openai.baseUrl,
      textModel: doubao.providerSettings.openai.textModel,
      visionModel: doubao.providerSettings.openai.visionModel
    });
    assert.equal(openai.provider, "openai");
    assert.equal(openai.apiKeyConfigured, true);
    assert.equal(openai.providerSettings.doubao.textModel, "ep-doubao-text");

    const stored = (getDatabase().prepare(
      "SELECT value_json AS valueJson FROM app_settings WHERE setting_key = 'ai.provider'"
    ).get() as { valueJson: string }).valueJson;
    assert.equal(stored.includes("openai-secret-key"), false);
    assert.equal(stored.includes("doubao-secret-key"), false);
  });
});

test("routes an AI task to its own provider and model without duplicating credentials", async () => {
  await withDatabase(() => {
    saveAiSettings({
      enabled: true,
      provider: "deepseek",
      baseUrl: "https://deepseek.example.com/v1",
      textModel: "deepseek-default",
      apiKey: "deepseek-secret"
    });
    saveAiSettings({
      enabled: true,
      provider: "qwen",
      baseUrl: "https://qwen.example.com/v1",
      textModel: "qwen-default",
      apiKey: "qwen-secret",
      taskBindings: {
        report_extraction: { provider: "qwen", model: "qwen-report-structurer" }
      }
    });

    const reportTask = getAiTaskSettings("report_extraction", true);
    assert.deepEqual({
      provider: reportTask.provider,
      baseUrl: reportTask.baseUrl,
      model: reportTask.model,
      apiKey: reportTask.apiKey,
      inherited: reportTask.inherited
    }, {
      provider: "qwen",
      baseUrl: "https://qwen.example.com/v1",
      model: "qwen-report-structurer",
      apiKey: "qwen-secret",
      inherited: false
    });

    const stored = JSON.parse((getDatabase().prepare(
      "SELECT value_json AS valueJson FROM app_settings WHERE setting_key = 'ai.provider'"
    ).get() as { valueJson: string }).valueJson) as Record<string, unknown>;
    assert.equal(JSON.stringify(stored).includes("qwen-secret"), false);

    const reset = saveAiSettings({
      provider: "qwen",
      taskBindings: { report_extraction: null }
    });
    assert.equal(reset.taskBindings.report_extraction.inherited, true);
    assert.equal(getAiTaskSettings("report_extraction", false).model, "qwen-default");
  });
});

test("tests the selected provider with unsaved form values", async () => {
  await withDatabase(async () => {
    const originalFetch = globalThis.fetch;
    let requestedUrl = "";
    let requestedModel = "";
    globalThis.fetch = async (input, init) => {
      requestedUrl = String(input);
      requestedModel = String(JSON.parse(String(init?.body)).model);
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer unsaved-qwen-key");
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
    };
    try {
      const result = await testAiConnection({
        provider: "qwen",
        baseUrl: "https://unsaved.example.com/v1/",
        textModel: "unsaved-qwen-model",
        apiKey: "unsaved-qwen-key"
      });
      assert.equal(result.provider, "qwen");
      assert.equal(requestedUrl, "https://unsaved.example.com/v1/chat/completions");
      assert.equal(requestedModel, "unsaved-qwen-model");
      assert.equal(getAiSettings(false).providerSettings.qwen.apiKeyConfigured, false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("uses Ollama without an API key and normalizes its OpenAI-compatible address", async () => {
  await withDatabase(async () => {
    assert.equal(aiProviderCatalog.ollama.apiKeyRequired, false);
    const originalFetch = globalThis.fetch;
    let requestedUrl = "";
    let authorization: string | null = "unexpected";
    let requestBody: Record<string, unknown> = {};
    globalThis.fetch = async (input, init) => {
      requestedUrl = String(input);
      authorization = new Headers(init?.headers).get("authorization");
      requestBody = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
      return new Response(JSON.stringify({
        model: "qwen2.5:7b",
        choices: [{ finish_reason: "stop", message: { content: "{\"ok\":true}" } }]
      }), { status: 200, headers: { "content-type": "application/json" } });
    };
    try {
      const saved = saveAiSettings({
        enabled: true,
        provider: "ollama",
        baseUrl: "http://ollama.local:11434",
        textModel: "qwen2.5:7b"
      });
      assert.equal(saved.baseUrl, "http://ollama.local:11434/v1");
      assert.equal(isAiExtractionConfigured(), true);
      const result = await testAiConnection({ provider: "ollama" });
      assert.equal(result.model, "qwen2.5:7b");
      assert.equal(requestedUrl, "http://ollama.local:11434/v1/chat/completions");
      assert.equal(authorization, null);
      assert.deepEqual(requestBody.response_format, { type: "json_object" });
      assert.equal(requestBody.max_tokens, 128);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("keeps MiniMax configuration independent and validates structured text output", async () => {
  await withDatabase(async () => {
    const originalFetch = globalThis.fetch;
    let requestBody: Record<string, unknown> = {};
    globalThis.fetch = async (_input, init) => {
      requestBody = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
      return new Response(JSON.stringify({
        model: "MiniMax-M2.7",
        choices: [{
          finish_reason: "stop",
          message: { content: "<think>先检查格式</think>\n{\"ok\":true}" }
        }]
      }), { status: 200, headers: { "content-type": "application/json" } });
    };
    try {
      const saved = saveAiSettings({
        enabled: true,
        provider: "minimax",
        apiKey: "minimax-test-key"
      });
      assert.equal(saved.baseUrl, "https://api.minimaxi.com/v1");
      assert.equal(saved.textModel, "MiniMax-M2.7");
      assert.equal(saved.providerSettings.minimax.apiKeyConfigured, true);
      const result = await testAiConnection({ provider: "minimax" });
      assert.equal(result.model, "MiniMax-M2.7");
      assert.equal(requestBody.temperature, 1);
      assert.equal(requestBody.max_completion_tokens, 128);
      assert.equal(requestBody.reasoning_split, true);
      assert.equal("response_format" in requestBody, false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("rejects visual enhancement for the MiniMax preset", async () => {
  await withDatabase(async () => {
    assert.throws(
      () => saveAiSettings({
        provider: "minimax",
        apiKey: "minimax-test-key",
        visionEnabled: true,
        visionModel: "MiniMax-M2.7"
      }),
      (error: unknown) => {
        const value = error as { status?: number; statusText?: string; message?: string };
        return value.status === 400 && `${value.statusText} ${value.message}`.includes("不支持视觉增强");
      }
    );
    await assert.rejects(
      () => testAiConnection({ provider: "minimax", testVision: true }),
      (error: unknown) => {
        const value = error as { status?: number; statusText?: string; message?: string };
        return value.status === 400 && `${value.statusText} ${value.message}`.includes("不支持图片输入");
      }
    );
  });
});

test("reports an Ollama model that cannot return structured JSON", async () => {
  await withDatabase(async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({
      model: "qwen2.5:7b",
      choices: [{ finish_reason: "stop", message: { content: "ok" } }]
    }), { status: 200, headers: { "content-type": "application/json" } });
    try {
      await assert.rejects(
        () => testAiConnection({
          provider: "ollama",
          baseUrl: "http://ollama.local:11434",
          textModel: "qwen2.5:7b"
        }),
        (error: unknown) => {
          const value = error as { status?: number; statusText?: string; message?: string };
          return value.status === 502
            && `${value.statusText} ${value.message}`.includes("结构化 JSON");
        }
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("uses OpenAI-compatible endpoints for OpenAI and Doubao connection tests", async () => {
  await withDatabase(async () => {
    const originalFetch = globalThis.fetch;
    const requests: Array<{ url: string; model: string; authorization: string | null }> = [];
    globalThis.fetch = async (input, init) => {
      const body = JSON.parse(String(init?.body || "{}")) as { model: string };
      requests.push({
        url: String(input),
        model: body.model,
        authorization: new Headers(init?.headers).get("authorization")
      });
      return new Response(JSON.stringify({
        choices: [{ finish_reason: "stop", message: { content: "ok" } }]
      }), { status: 200, headers: { "content-type": "application/json" } });
    };
    try {
      await testAiConnection({
        provider: "openai",
        apiKey: "openai-test-key",
        textModel: "gpt-4.1-mini"
      });
      await testAiConnection({
        provider: "doubao",
        apiKey: "doubao-test-key",
        textModel: "ep-doubao-text"
      });
      assert.deepEqual(requests, [
        {
          url: "https://api.openai.com/v1/chat/completions",
          model: "gpt-4.1-mini",
          authorization: "Bearer openai-test-key"
        },
        {
          url: "https://ark.cn-beijing.volces.com/api/v3/chat/completions",
          model: "ep-doubao-text",
          authorization: "Bearer doubao-test-key"
        }
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("uses the Kimi-compatible temperature for connection tests", async () => {
  await withDatabase(async () => {
    const originalFetch = globalThis.fetch;
    let requestBody: Record<string, unknown> = {};
    let requestedUrl = "";
    globalThis.fetch = async (input, init) => {
      requestedUrl = String(input);
      requestBody = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
      return new Response(JSON.stringify({
        model: "kimi-k3",
        choices: [{ finish_reason: "stop", message: { content: "ok" } }]
      }), { status: 200, headers: { "content-type": "application/json" } });
    };
    try {
      const result = await testAiConnection({
        provider: "kimi",
        baseUrl: "https://api.kimi.com/coding",
        textModel: "kimi-k3",
        apiKey: "kimi-test-key"
      });
      assert.equal(result.provider, "kimi");
      assert.equal(requestedUrl, "https://api.kimi.com/coding/v1/chat/completions");
      assert.equal(requestBody.temperature, 1);
      assert.equal(requestBody.max_tokens, 4);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("uses the Kimi-compatible temperature for configured AI tasks", async () => {
  await withDatabase(async () => {
    saveAiSettings({
      enabled: true,
      provider: "kimi",
      baseUrl: "https://api.moonshot.ai/v1",
      textModel: "kimi-k3",
      apiKey: "kimi-task-key"
    });
    const originalFetch = globalThis.fetch;
    let requestBody: Record<string, unknown> = {};
    globalThis.fetch = async (_input, init) => {
      requestBody = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
      return new Response(JSON.stringify({
        choices: [{ finish_reason: "stop", message: { content: "{}" } }]
      }), { status: 200, headers: { "content-type": "application/json" } });
    };
    try {
      await executeAiTask("report_extraction", {
        messages: [{ role: "user", content: "test" }],
        temperature: 0,
        responseFormat: "json_object",
        maxOutputTokens: 128,
        timeoutMs: 15_000
      });
      assert.equal(requestBody.temperature, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("returns a client error when AI test configuration is incomplete", async () => {
  await withDatabase(async () => {
    await assert.rejects(
      () => testAiConnection({ provider: "deepseek", apiKey: "", textModel: "deepseek-v4-flash" }),
      (error: unknown) => {
        const value = error as { status?: number; statusText?: string; message?: string };
        return value.status === 400 && `${value.statusText} ${value.message}`.includes("API Key");
      }
    );
  });
});

test("returns an actionable error when the AI provider rejects credentials", async () => {
  await withDatabase(async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({
      error: { message: "invalid api key" }
    }), { status: 401 });
    try {
      await assert.rejects(
        () => testAiConnection({
          provider: "deepseek",
          apiKey: "invalid-key",
          textModel: "deepseek-v4-flash"
        }),
        (error: unknown) => {
          const value = error as { status?: number; statusText?: string; message?: string };
          const detail = `${value.statusText} ${value.message}`;
          return value.status === 502
            && detail.includes("认证失败")
            && detail.includes("invalid api key");
        }
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("returns an actionable error when the NAS cannot resolve the AI host", async () => {
  await withDatabase(async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      const cause = Object.assign(new Error("getaddrinfo ENOTFOUND api.example.com"), { code: "ENOTFOUND" });
      throw new TypeError("fetch failed", { cause });
    };
    try {
      await assert.rejects(
        () => testAiConnection({
          provider: "deepseek",
          baseUrl: "https://api.example.com",
          apiKey: "test-key",
          textModel: "deepseek-v4-flash"
        }),
        (error: unknown) => {
          const value = error as { status?: number; statusText?: string; message?: string };
          return value.status === 502 && `${value.statusText} ${value.message}`.includes("DNS");
        }
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
