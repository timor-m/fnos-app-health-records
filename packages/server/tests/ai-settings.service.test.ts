import { inflateSync } from "node:zlib";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { closeDatabaseForTests, getDatabase } from "../database/client.ts";
import {
  getAiProfileSecrets,
  getAiSettings,
  getAiTaskSettings,
  resolveAiExtractionDepth,
  saveAiSettings,
  testAiConnection
} from "../services/ai-settings.service.ts";
import { isAiExtractionConfigured } from "../services/ai-extraction.service.ts";
import { executeAiTask } from "../services/ai-task.service.ts";
import { aiProviderCatalog, isMiniMaxM2Model } from "../services/ai-provider.ts";

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

function storedSettingsJson() {
  return (getDatabase().prepare(
    "SELECT value_json AS valueJson FROM app_settings WHERE setting_key = 'ai.provider'"
  ).get() as { valueJson: string }).valueJson;
}

test("migrates the legacy flat AI configuration into a connection profile", async () => {
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
    const modern = JSON.parse(storedSettingsJson()) as {
      profiles: Array<{ apiKeyEncrypted: string }>;
    };
    // 模拟最早版本的扁平存储（无 profiles 列表），确认读取时自动升级
    getDatabase().prepare("UPDATE app_settings SET value_json = ? WHERE setting_key = 'ai.provider'").run(JSON.stringify({
      enabled: true,
      provider: "deepseek",
      visionEnabled: true,
      baseUrl: "https://legacy.example.com/v1",
      textModel: "legacy-text",
      visionModel: "legacy-vision",
      apiKeyEncrypted: modern.profiles[0].apiKeyEncrypted
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
    assert.equal(settings.defaultProfileId, "legacy_deepseek");
    assert.deepEqual(settings.profiles.map((profile) => profile.id), ["legacy_deepseek"]);
    assert.equal(settings.profiles[0].name, "DeepSeek");
    assert.equal(getAiProfileSecrets().get("legacy_deepseek"), "legacy-secret-key");

    // 迁移结果已回写为新结构，且不含明文 Key
    const rewritten = JSON.parse(storedSettingsJson()) as { profiles?: unknown; providers?: unknown };
    assert.equal(Array.isArray(rewritten.profiles), true);
    assert.equal(rewritten.providers, undefined);
    assert.equal(storedSettingsJson().includes("legacy-secret-key"), false);
  });
});

test("migrates the v1 per-provider map into stable connection profiles", async () => {
  await withDatabase(() => {
    saveAiSettings({
      enabled: true,
      provider: "deepseek",
      baseUrl: "https://api.deepseek.com",
      textModel: "deepseek-v4-flash",
      apiKey: "deepseek-map-key"
    });
    const encrypted = (JSON.parse(storedSettingsJson()) as {
      profiles: Array<{ apiKeyEncrypted: string }>;
    }).profiles[0].apiKeyEncrypted;
    // 模拟 v1 按服务商存储的结构（含场景绑定）
    getDatabase().prepare("UPDATE app_settings SET value_json = ? WHERE setting_key = 'ai.provider'").run(JSON.stringify({
      enabled: true,
      provider: "deepseek",
      requestTimeoutSeconds: 900,
      extractionDepth: "detailed",
      providers: {
        deepseek: {
          visionEnabled: true,
          baseUrl: "https://ds.example.com/v1",
          textModel: "ds-text",
          visionModel: "ds-vision",
          apiKeyEncrypted: encrypted
        },
        qwen: {
          baseUrl: "https://qwen.example.com/v1",
          textModel: "qwen-text",
          apiKey: "qwen-plain-key"
        }
      },
      taskBindings: {
        report_extraction: { provider: "qwen", model: "qwen-report" }
      }
    }));

    const first = getAiSettings(true);
    assert.deepEqual(first.profiles.map((profile) => profile.id), ["legacy_deepseek", "legacy_qwen"]);
    assert.equal(first.defaultProfileId, "legacy_deepseek");
    assert.equal(first.requestTimeoutSeconds, 900);
    assert.equal(first.extractionDepth, "detailed");
    const deepseek = first.profiles.find((profile) => profile.id === "legacy_deepseek");
    assert.equal(deepseek?.baseUrl, "https://ds.example.com/v1");
    assert.equal(deepseek?.visionModel, "ds-vision");
    assert.equal(getAiProfileSecrets().get("legacy_deepseek"), "deepseek-map-key");

    const task = getAiTaskSettings("report_extraction", true);
    assert.equal(task.provider, "qwen");
    assert.equal(task.profileId, "legacy_qwen");
    assert.equal(task.baseUrl, "https://qwen.example.com/v1");
    assert.equal(task.model, "qwen-report");
    assert.equal(task.apiKey, "qwen-plain-key");
    assert.equal(task.inherited, false);

    // id 稳定：多次读取迁移结果一致
    const second = getAiSettings(false);
    assert.deepEqual(second.profiles.map((profile) => profile.id), ["legacy_deepseek", "legacy_qwen"]);
    assert.equal(storedSettingsJson().includes("qwen-plain-key"), false);
  });
});

test("keeps the same model on two platforms as separate connection profiles", async () => {
  await withDatabase(() => {
    const saved = saveAiSettings({
      enabled: true,
      profiles: [
        {
          name: "DeepSeek 官方",
          provider: "deepseek",
          baseUrl: "https://api.deepseek.com",
          textModel: "deepseek-v4-flash",
          apiKey: "official-secret-key"
        },
        {
          name: "聚合平台",
          provider: "custom",
          baseUrl: "https://api.siliconflow.cn/v1",
          textModel: "deepseek-v4-flash",
          visionModel: "glm-4.5v",
          visionEnabled: true,
          apiKey: "aggregator-secret-key"
        }
      ]
    });

    assert.equal(saved.profiles.length, 2);
    const [official, aggregator] = saved.profiles;
    assert.ok(official.id && aggregator.id && official.id !== aggregator.id);
    assert.equal(saved.defaultProfileId, official.id);
    assert.equal(official.providerLabel, "DeepSeek");
    assert.equal(aggregator.name, "聚合平台");
    assert.equal(aggregator.visionEnabled, true);

    // 全量提交时不重复填写 Key，已保存的 Key 保留；场景绑定引用具体配置
    const bound = saveAiSettings({
      profiles: saved.profiles.map((profile) => ({
        id: profile.id,
        name: profile.name,
        provider: profile.provider,
        visionEnabled: profile.visionEnabled,
        baseUrl: profile.baseUrl,
        textModel: profile.textModel,
        visionModel: profile.visionModel
      })),
      taskBindings: {
        report_extraction: { profileId: aggregator.id }
      }
    });
    assert.equal(bound.profiles.find((profile) => profile.id === aggregator.id)?.apiKeyConfigured, true);

    const task = getAiTaskSettings("report_extraction", true);
    assert.equal(task.provider, "custom");
    assert.equal(task.profileId, aggregator.id);
    assert.equal(task.profileName, "聚合平台");
    assert.equal(task.baseUrl, "https://api.siliconflow.cn/v1");
    assert.equal(task.model, "deepseek-v4-flash");
    assert.equal(task.apiKey, "aggregator-secret-key");

    assert.equal(storedSettingsJson().includes("official-secret-key"), false);
    assert.equal(storedSettingsJson().includes("aggregator-secret-key"), false);
  });
});

test("rejects dangling references when replacing the profile list", async () => {
  await withDatabase(() => {
    const saved = saveAiSettings({
      enabled: true,
      profiles: [
        { name: "主配置", provider: "deepseek", baseUrl: "https://api.deepseek.com", textModel: "deepseek-v4-flash", apiKey: "main-key" },
        { name: "备用配置", provider: "qwen", baseUrl: "https://qwen.example.com/v1", textModel: "qwen-plus", apiKey: "backup-key" }
      ]
    });
    const [main, backup] = saved.profiles;
    const mainInput = {
      id: main.id, name: main.name, provider: main.provider,
      baseUrl: main.baseUrl, textModel: main.textModel, visionModel: ""
    };
    saveAiSettings({
      profiles: [mainInput, { id: backup.id, name: backup.name, provider: backup.provider, baseUrl: backup.baseUrl, textModel: backup.textModel }],
      taskBindings: { report_extraction: { profileId: backup.id } }
    });

    // 删除仍被场景引用的配置被拒绝
    assert.throws(
      () => saveAiSettings({
        profiles: [mainInput],
        taskBindings: { report_extraction: { profileId: backup.id } }
      }),
      (error: unknown) => (error as { status?: number }).status === 400
    );
    // 删除默认配置却仍引用它为默认被拒绝
    assert.throws(
      () => saveAiSettings({
        profiles: [mainInput],
        defaultProfileId: backup.id,
        taskBindings: { report_extraction: null }
      }),
      (error: unknown) => (error as { status?: number }).status === 400
    );
    // 先解除绑定再删除即可成功，Key 保留、默认回落到剩余配置
    const removed = saveAiSettings({
      profiles: [mainInput],
      taskBindings: { report_extraction: null }
    });
    assert.equal(removed.profiles.length, 1);
    assert.equal(removed.defaultProfileId, main.id);
    assert.equal(getAiTaskSettings("report_extraction", true).apiKey, "main-key");

    // 启用状态下不允许没有连接配置
    assert.throws(
      () => saveAiSettings({ enabled: true, profiles: [] }),
      (error: unknown) => (error as { status?: number }).status === 400
    );
  });
});

test("legacy provider saves upsert one profile per provider and switch the default", async () => {
  await withDatabase(() => {
    saveAiSettings({
      enabled: true,
      provider: "deepseek",
      baseUrl: "https://deepseek.example.com/v1",
      textModel: "deepseek-health",
      apiKey: "deepseek-key"
    });
    const qwen = saveAiSettings({
      enabled: true,
      provider: "qwen",
      baseUrl: "https://qwen.example.com/v1",
      textModel: "qwen-health",
      visionModel: "qwen-vl-health",
      visionEnabled: true,
      apiKey: "qwen-key"
    });
    assert.equal(qwen.provider, "qwen");
    const deepseekProfile = qwen.profiles.find((profile) => profile.provider === "deepseek");
    const qwenProfile = qwen.profiles.find((profile) => profile.provider === "qwen");
    assert.equal(deepseekProfile?.textModel, "deepseek-health");
    assert.equal(deepseekProfile?.apiKeyConfigured, true);
    assert.equal(qwenProfile?.visionModel, "qwen-vl-health");
    assert.equal(qwen.defaultProfileId, qwenProfile?.id);

    // 旧版“切回服务商”语义：再次保存 deepseek 时配置和 Key 都还在
    const deepseek = saveAiSettings({ provider: "deepseek" });
    assert.equal(deepseek.textModel, "deepseek-health");
    assert.equal(deepseek.apiKeyConfigured, true);
    assert.equal(deepseek.defaultProfileId, deepseekProfile?.id);
    assert.equal(deepseek.profiles.find((profile) => profile.provider === "qwen")?.textModel, "qwen-health");

    const stored = storedSettingsJson();
    assert.equal(stored.includes("deepseek-key"), false);
    assert.equal(stored.includes("qwen-key"), false);
  });
});

test("stores a global AI request timeout and exposes it to task execution", async () => {
  await withDatabase(() => {
    saveAiSettings({
      enabled: true,
      provider: "deepseek",
      baseUrl: "https://deepseek.example.com/v1",
      textModel: "deepseek-default",
      apiKey: "deepseek-secret",
      requestTimeoutSeconds: 1_800
    });
    const settings = getAiTaskSettings("report_extraction", true);
    assert.equal(settings.requestTimeoutSeconds, 1_800);
    assert.throws(
      () => saveAiSettings({ provider: "deepseek", requestTimeoutSeconds: 10 }),
      (error: unknown) => (error as { status?: number }).status === 400
    );
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

    assert.equal(storedSettingsJson().includes("qwen-secret"), false);

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
      assert.equal(getAiSettings(false).profiles.length, 0);
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
      assert.equal(saved.profiles.find((profile) => profile.provider === "minimax")?.apiKeyConfigured, true);
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

test("rejects visual enhancement for MiniMax M2 models", async () => {
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
      () => testAiConnection({ provider: "minimax", testVision: true, visionModel: "MiniMax-M2.7" }),
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

test("defaults extraction depth to overview while preserving an explicit detailed choice", async () => {
  await withDatabase(() => {
    assert.equal(getAiSettings(false).extractionDepth, "overview");
    assert.equal(resolveAiExtractionDepth(), "overview");
    saveAiSettings({ provider: "deepseek", extractionDepth: "detailed" });
    assert.equal(resolveAiExtractionDepth(), "detailed");
    saveAiSettings({ provider: "deepseek" });
    assert.equal(resolveAiExtractionDepth(), "detailed");
  });
});


test("allows MiniMax M3 vision with an M2 text model", async () => {
  await withDatabase(async () => {
    const saved = saveAiSettings({
      provider: "minimax", apiKey: "minimax-test-key",
      textModel: "MiniMax-M2.7", visionModel: "MiniMax-M3", visionEnabled: true
    });
    assert.equal(saved.visionEnabled, true);
    assert.equal(saved.visionModel, "MiniMax-M3");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      assert.equal(body.model, "MiniMax-M3");
      assert.ok(body.messages.some((message: { content: unknown }) =>
        Array.isArray(message.content) && message.content.some((part: { type: string }) => part.type === "image_url")));
      return new Response(JSON.stringify({ choices: [{ message: { content: "red" } }] }), {
        status: 200, headers: { "content-type": "application/json" }
      });
    };
    try {
      await testAiConnection({ provider: "minimax", testVision: true, visionModel: "MiniMax-M3" });
    } finally { globalThis.fetch = originalFetch; }
  });
});


test("identifies only MiniMax M2 model names as text-only", () => {
  for (const model of ["MiniMax-M2", "MiniMax-M2.7", " minimax-m2.5-highspeed ", "MiniMaxAI/MiniMax-M2.7"]) {
    assert.equal(isMiniMaxM2Model(model), true, model);
  }
  for (const model of ["MiniMax-M3", "MiniMax-M3-highspeed", "MiniMax-M20", "MiniMax-VL-01", "", "qwen-vl"]) {
    assert.equal(isMiniMaxM2Model(model), false, model);
  }
});


test("saves and sends image input to DeepSeek multimodal models", async () => {
  await withDatabase(async () => {
    for (const model of ["deepseek-flash", "deepseek-v4.1-flash"]) {
    const saved = saveAiSettings({
      provider: "deepseek", apiKey: "deepseek-test-key",
      textModel: model, visionModel: model, visionEnabled: true
    });
    assert.equal(saved.visionEnabled, true);
    const originalFetch = globalThis.fetch;
    let imageSent = false;
    globalThis.fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      assert.equal(body.model, model);
      imageSent = body.messages.some((message: { content: unknown }) =>
        Array.isArray(message.content) && message.content.some((part: { type: string }) => part.type === "image_url"));
      const image = body.messages[0].content.find((part: { type: string }) => part.type === "image_url");
      const png = Buffer.from(image.image_url.url.split(",")[1], "base64");
      assert.equal(png.readUInt32BE(16), 32);
      assert.equal(png.readUInt32BE(20), 32);
      const chunks: Buffer[] = [];
      for (let offset = 8; offset < png.length;) {
        const length = png.readUInt32BE(offset);
        if (png.toString("ascii", offset + 4, offset + 8) === "IDAT") {
          chunks.push(png.subarray(offset + 8, offset + 8 + length));
        }
        offset += length + 12;
      }
      const pixels = inflateSync(Buffer.concat(chunks));
      assert.equal(pixels.length, 32 * (1 + 32 * 3));
      assert.deepEqual([...pixels.subarray(0, 4)], [0, 255, 0, 0]);
      return new Response(JSON.stringify({ choices: [{ message: { content: "OK" } }] }), {
        status: 200, headers: { "content-type": "application/json" }
      });
    };
    try {
      await testAiConnection({ provider: "deepseek", testVision: true });
      assert.equal(imageSent, true);
    } finally { globalThis.fetch = originalFetch; }
    }
  });
});
