import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";

const { routerPush } = vi.hoisted(() => ({ routerPush: vi.fn() }));

vi.mock("vue-router", () => ({ useRouter: () => ({ push: routerPush }) }));
vi.mock("../src/composables/useScrollLock", () => ({ useScrollLock: () => {} }));

import SetupGuideModal from "../src/components/SetupGuideModal.vue";

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify({ ok: status < 400, data }), {
    status,
    headers: { "content-type": "application/json" }
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

function callsTo(urlPart: string, method?: string) {
  return fetchMock.mock.calls.filter(([input, init]) => {
    if (!String(input).includes(urlPart)) return false;
    return method ? String((init as RequestInit | undefined)?.method || "GET") === method : true;
  });
}

async function mountGuide() {
  const wrapper = mount(SetupGuideModal, {
    attachTo: document.body,
    global: { stubs: { teleport: true } }
  });
  await flushPromises();
  return wrapper;
}

beforeEach(() => {
  routerPush.mockReset();
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method || "GET";
    if (url.includes("/api/setup/guide-dismissed")) return jsonResponse({ guideDismissed: true });
    if (url.includes("/api/setup/status")) {
      return jsonResponse({ ocrInstalled: false, ocrInstalling: false, aiConfigured: false, guideDismissed: false });
    }
    if (url.includes("/api/ocr/install")) return jsonResponse({ available: true, installing: false });
    if (url.includes("/api/ocr/status")) return jsonResponse({ available: true, installing: false });
    if (url.includes("/api/ai/settings") && method === "PUT") return jsonResponse({});
    if (url.includes("/api/ai/settings")) {
      return jsonResponse({
        providers: [{ key: "deepseek", label: "DeepSeek", defaultBaseUrl: "https://api.deepseek.com", defaultTextModel: "deepseek-v4-flash" }]
      });
    }
    if (url.includes("/api/ai/test")) return jsonResponse({ model: "deepseek-v4-flash", elapsedMs: 321 });
    return jsonResponse({}, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("SetupGuideModal 首次使用引导", () => {
  it("按步骤完成 OCR 安装与 DeepSeek 配置后标记引导完成", async () => {
    const wrapper = await mountGuide();
    expect(wrapper.text()).toContain("欢迎使用健康档案");

    await wrapper.find(".setup-guide-actions .primary-button").trigger("click");
    expect(wrapper.text()).toContain("第一步：安装 OCR 识别环境");

    await wrapper.find(".setup-guide-actions .primary-button").trigger("click");
    await flushPromises();
    expect(callsTo("/api/ocr/install", "POST").length).toBe(1);
    expect(wrapper.text()).toContain("OCR 环境已就绪");

    await wrapper.find(".setup-guide-actions .primary-button").trigger("click");
    expect(wrapper.text()).toContain("第二步：配置 AI 整理服务");
    expect(wrapper.find(".setup-guide-tutorial a").attributes("href")).toContain("platform.deepseek.com");
    expect(wrapper.text()).toContain("https://api.deepseek.com");
    expect(wrapper.text()).toContain("deepseek-v4-flash");

    const keyInput = wrapper.find(".setup-guide-field input");
    await keyInput.setValue("sk-test-key");
    const testButton = wrapper.findAll(".setup-guide-actions button").find((button) => button.text().includes("测试连接"));
    await testButton!.trigger("click");
    await flushPromises();
    expect(callsTo("/api/ai/test", "POST").length).toBe(1);
    expect(wrapper.text()).toContain("连接正常");

    const saveButton = wrapper.findAll(".setup-guide-actions button").find((button) => button.text().includes("保存并完成"));
    await saveButton!.trigger("click");
    await flushPromises();
    const saveCall = callsTo("/api/ai/settings", "PUT")[0];
    const saveBody = JSON.parse(String((saveCall[1] as RequestInit).body));
    expect(saveBody).toMatchObject({ enabled: true, provider: "deepseek", baseUrl: "https://api.deepseek.com", apiKey: "sk-test-key" });
    expect(wrapper.text()).toContain("配置完成");

    const finishButton = wrapper.findAll(".setup-guide-actions button").find((button) => button.text().includes("开始上传报告"));
    await finishButton!.trigger("click");
    await flushPromises();
    expect(callsTo("/api/setup/guide-dismissed", "PUT").length).toBe(1);
    expect(wrapper.emitted("done")).toHaveLength(1);
    wrapper.unmount();
  });

  it("中途关闭只触发 done，不标记引导完成", async () => {
    const wrapper = await mountGuide();
    await wrapper.find(".setup-guide-header button").trigger("click");
    expect(wrapper.emitted("done")).toHaveLength(1);
    expect(callsTo("/api/setup/guide-dismissed").length).toBe(0);
    wrapper.unmount();
  });

  it("AI 连接测试失败时展示错误且仍可继续保存", async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/ai/test")) {
        return new Response(JSON.stringify({ error: true, message: "API Key 无效" }), {
          status: 401,
          headers: { "content-type": "application/json" }
        });
      }
      if (url.includes("/api/setup/status")) {
        return jsonResponse({ ocrInstalled: true, ocrInstalling: false, aiConfigured: false, guideDismissed: false });
      }
      if (url.includes("/api/ai/settings") && init?.method === "PUT") return jsonResponse({});
      if (url.includes("/api/ai/settings")) {
        return jsonResponse({
          providers: [{ key: "deepseek", label: "DeepSeek", defaultBaseUrl: "https://api.deepseek.com", defaultTextModel: "deepseek-v4-flash" }]
        });
      }
      return jsonResponse({});
    });
    const wrapper = await mountGuide();
    await wrapper.find(".setup-guide-actions .primary-button").trigger("click");
    await flushPromises();
    await wrapper.find(".setup-guide-actions .primary-button").trigger("click");
    await wrapper.find(".setup-guide-field input").setValue("sk-bad-key");
    const testButton = wrapper.findAll(".setup-guide-actions button").find((button) => button.text().includes("测试连接"));
    await testButton!.trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("API Key 无效");
    const saveButton = wrapper.findAll(".setup-guide-actions button").find((button) => button.text().includes("保存并完成"));
    expect(saveButton!.attributes("disabled")).toBeUndefined();
    wrapper.unmount();
  });
});
