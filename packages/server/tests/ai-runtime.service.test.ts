import assert from "node:assert/strict";
import test from "node:test";
import { executeAiChatCompletion } from "../services/ai-runtime.service.ts";

test("executes an OpenAI-compatible task without knowing report-domain fields", async () => {
  const originalFetch = globalThis.fetch;
  let body: Record<string, unknown> = {};
  let headers = new Headers();
  globalThis.fetch = async (_input, init) => {
    headers = new Headers(init?.headers);
    body = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
    return new Response(JSON.stringify({
      model: "runtime-model-v2",
      choices: [{ finish_reason: "stop", message: { content: "{\"ok\":true}" } }],
      usage: { prompt_tokens: 12, completion_tokens: 5 }
    }), { status: 200 });
  };
  try {
    const result = await executeAiChatCompletion({
      provider: "test",
      baseUrl: "https://ai.example.test/v1",
      apiKey: "secret",
      model: "runtime-model"
    }, {
      messages: [{ role: "user", content: "test" }],
      responseFormat: "json_object",
      maxOutputTokens: 128,
      timeoutMs: 15_000
    });
    assert.equal(body.model, "runtime-model");
    assert.equal(headers.has("x-opencode-session"), false);
    assert.deepEqual(body.response_format, { type: "json_object" });
    assert.deepEqual(result, {
      provider: "test",
      model: "runtime-model-v2",
      content: "{\"ok\":true}",
      reasoningContent: null,
      finishReason: "stop",
      promptTokens: 12,
      completionTokens: 5,
      elapsedMs: result.elapsedMs
    });
    assert.ok(result.elapsedMs >= 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("returns provider status and detail through a stable runtime error", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    error: { message: "quota exhausted" }
  }), { status: 429 });
  try {
    await assert.rejects(
      () => executeAiChatCompletion({
        provider: "test",
        baseUrl: "https://ai.example.test/v1",
        apiKey: "secret",
        model: "runtime-model"
      }, {
        messages: [{ role: "user", content: "test" }],
        maxOutputTokens: 64,
        timeoutMs: 15_000
      }),
      (error: unknown) => {
        const value = error as { message: string; code?: string; upstreamStatus?: number; upstreamDetail?: string };
        return value.code === "AI_HTTP_429"
          && value.upstreamStatus === 429
          && value.upstreamDetail === "quota exhausted"
          && !value.message.includes("quota exhausted")
          && value.message.includes("请求受限");
      }
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("uses MiniMax completion fields and separates inline reasoning", async () => {
  const originalFetch = globalThis.fetch;
  let body: Record<string, unknown> = {};
  globalThis.fetch = async (_input, init) => {
    body = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
    return new Response(JSON.stringify({
      model: "MiniMax-M2.7",
      choices: [{
        finish_reason: "stop",
        message: { content: "<think>内部推理</think>\n{\"ok\":true}" }
      }]
    }), { status: 200 });
  };
  try {
    const result = await executeAiChatCompletion({
      provider: "api.minimaxi.com",
      providerKey: "minimax",
      baseUrl: "https://api.minimaxi.com/v1",
      apiKey: "secret",
      model: "MiniMax-M2.7"
    }, {
      messages: [{ role: "user", content: "test" }],
      responseFormat: "json_object",
      maxOutputTokens: 8_192,
      temperature: 1,
      timeoutMs: 15_000
    });
    assert.equal(body.max_completion_tokens, 2_048);
    assert.equal(body.reasoning_split, true);
    assert.equal("max_tokens" in body, false);
    assert.equal("response_format" in body, false);
    assert.equal(result.content, "{\"ok\":true}");
    assert.equal(result.reasoningContent, "内部推理");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("retries without json_object when a compatible service explicitly rejects it", async () => {
  const originalFetch = globalThis.fetch;
  const bodies: Array<Record<string, unknown>> = [];
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
    bodies.push(body);
    if (bodies.length === 1) {
      return new Response(JSON.stringify({
        error: "'response_format.type' must be 'json_schema' or 'text'"
      }), { status: 400 });
    }
    return new Response(JSON.stringify({
      model: "qwen2.5-7b-instruct",
      choices: [{ finish_reason: "stop", message: { content: "```json\n{\"ok\":true}\n```" } }]
    }), { status: 200 });
  };
  try {
    const result = await executeAiChatCompletion({
      provider: "localhost:1234",
      providerKey: "ollama",
      baseUrl: "http://localhost:1234/v1",
      apiKey: "",
      model: "qwen2.5-7b-instruct"
    }, {
      messages: [{ role: "user", content: "test" }],
      responseFormat: "json_object",
      maxOutputTokens: 128,
      timeoutMs: 15_000
    });
    assert.deepEqual(bodies[0]?.response_format, { type: "json_object" });
    assert.equal("response_format" in (bodies[1] || {}), false);
    assert.match(result.content, /\{"ok":true\}/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("disables DeepSeek thinking mode for structured extraction requests", async () => {
  const originalFetch = globalThis.fetch;
  let body: Record<string, unknown> = {};
  globalThis.fetch = async (_input, init) => {
    body = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
    return new Response(JSON.stringify({
      model: "deepseek-v4-flash",
      choices: [{ finish_reason: "stop", message: { content: "{\"ok\":true}" } }]
    }), { status: 200 });
  };
  try {
    await executeAiChatCompletion({
      provider: "api.deepseek.com",
      providerKey: "deepseek",
      baseUrl: "https://api.deepseek.com",
      apiKey: "secret",
      model: "deepseek-v4-flash"
    }, {
      messages: [{ role: "user", content: "test" }],
      maxOutputTokens: 8_192,
      timeoutMs: 15_000
    });
    assert.deepEqual(body.thinking, { type: "disabled" });
    assert.equal(body.max_tokens, 8_192);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("retries without thinking when an older DeepSeek model rejects the parameter", async () => {
  const originalFetch = globalThis.fetch;
  const bodies: Array<Record<string, unknown>> = [];
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
    bodies.push(body);
    if (bodies.length === 1) {
      return new Response(JSON.stringify({
        error: { message: "unknown parameter: thinking" }
      }), { status: 400 });
    }
    return new Response(JSON.stringify({
      model: "deepseek-chat",
      choices: [{ finish_reason: "stop", message: { content: "{\"ok\":true}" } }]
    }), { status: 200 });
  };
  try {
    const result = await executeAiChatCompletion({
      provider: "api.deepseek.com",
      providerKey: "deepseek",
      baseUrl: "https://api.deepseek.com",
      apiKey: "secret",
      model: "deepseek-chat"
    }, {
      messages: [{ role: "user", content: "test" }],
      maxOutputTokens: 128,
      timeoutMs: 15_000
    });
    assert.deepEqual(bodies[0]?.thinking, { type: "disabled" });
    assert.equal("thinking" in (bodies[1] || {}), false);
    assert.equal(result.content, "{\"ok\":true}");
  } finally {
    globalThis.fetch = originalFetch;
  }
});


test("OpenCode Go identifies the client and keeps opaque sessions stable across retries and related calls", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{url:string;headers:Headers;body:Record<string,unknown>}> = [];
  globalThis.fetch = async (url, init) => {
    calls.push({url:String(url),headers:new Headers(init?.headers),body:JSON.parse(String(init?.body))});
    if (calls.length === 1) return new Response(JSON.stringify({error:{message:"response_format is unsupported"}}), {status:400});
    return new Response(JSON.stringify({choices:[{finish_reason:"stop",message:{content:'{"ok":true}'}}]}), {status:200});
  };
  try {
    const config = {provider:"opencode.ai",providerKey:"opencode-go",baseUrl:"https://opencode.ai/inference/go/openai/v1",apiKey:"synthetic-key",model:"glm-5.2"};
    const request = {messages:[{role:"user" as const,content:"Synthetic"}],responseFormat:"json_object" as const,maxOutputTokens:128,timeoutMs:15000,sessionKey:"synthetic-report-a"};
    await executeAiChatCompletion(config, request);
    await executeAiChatCompletion(config, request);
    await executeAiChatCompletion(config, {...request,sessionKey:"synthetic-report-b"});
    await executeAiChatCompletion(config, {...request,sessionKey:undefined});
    assert.equal(calls.length,5);
    const session = calls[0].headers.get("x-opencode-session");
    assert.match(session!,/^[a-f0-9]{64}$/);
    assert.equal(calls[1].headers.get("x-opencode-session"),session);
    assert.equal(calls[2].headers.get("x-opencode-session"),session);
    assert.notEqual(calls[3].headers.get("x-opencode-session"),session);
    assert.ok(calls[4].headers.get("x-opencode-session"));
    assert.equal(calls[1].body.response_format,undefined);
    for(const call of calls) {
      assert.equal(call.url,config.baseUrl+"/chat/completions");
      assert.match(call.headers.get("user-agent")!,/^fnos-app-health-records\/\d+\.\d+\.\d+$/);
      assert.equal(call.headers.get("authorization"),"Bearer synthetic-key");
      assert.equal(call.body.sessionKey,undefined);
      assert.ok(!call.headers.get("x-opencode-session")!.includes("synthetic-report"));
    }
  } finally { globalThis.fetch = originalFetch; }
});
