import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import AboutSettingsPage from "../src/pages/settings/AboutSettingsPage.vue";

const { toastShow } = vi.hoisted(() => ({ toastShow: vi.fn() }));
vi.mock("../src/composables/useToast", () => ({ useToast: () => ({ show: toastShow }) }));

const group = {
  id: 1,
  name: "健康档案用户交流群",
  description: "欢迎交流使用体验",
  qrContent: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZuUAAAAASUVORK5CYII=",
  expiresAt: "2026-10-23T12:01:00.000Z",
  revision: 1
};
const serverTime = "2026-10-23T12:00:00.000Z";
let page: VueWrapper | undefined;
let fetchMock: ReturnType<typeof vi.fn>;
let accessDenied: ReturnType<typeof vi.fn>;

function response(data: unknown, status = 200) {
  return new Response(JSON.stringify({ ok: status < 400, data }), { status });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

function render() {
  page = mount(AboutSettingsPage, { global: { stubs: { SubPageHeader: true } } });
  return page;
}

function expectHidden() {
  expect(page!.find('[aria-label="微信交流群"]').exists()).toBe(false);
  expect(page!.text()).not.toContain("微信交流群");
  expect(toastShow).not.toHaveBeenCalled();
  expect(accessDenied).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance", "Date"] });
  vi.setSystemTime(new Date("2026-10-23T12:00:00.000Z"));
  toastShow.mockReset();
  accessDenied = vi.fn();
  window.addEventListener("health-access-denied", accessDenied);
  fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).endsWith("/api/about")) return response({ appVersion: "0.3.0", maintainer: "维护者" });
    return response({ group, serverTime });
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  page?.unmount();
  page = undefined;
  window.removeEventListener("health-access-denied", accessDenied);
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("关于页微信交流群", () => {
  it("displays the original non-QR image beside developer information and preserves QQ", async () => {
    render();
    expectHidden();
    await flushPromises();
    const section = page!.get('[aria-label="微信交流群"]');
    expect(section.text()).toContain(group.name);
    expect(section.text()).toContain(group.description);
    expect(section.get("img").attributes("src")).toBe(group.qrContent);
    expect(section.get("img").attributes("alt")).toContain(group.name);
    expect(section.get("img").attributes("height")).toBeUndefined();
    expect(page!.text()).toContain("1085626763");
    const [, init] = fetchMock.mock.calls.find(([input]) => String(input).endsWith("/api/wechat-group"))!;
    expect(init).toMatchObject({ cache: "no-store", signal: expect.any(AbortSignal) });
    expect(toastShow).not.toHaveBeenCalled();
  });

  it.each([
    "data:image/jpeg;base64,/9j/2Q==",
    "data:image/webp;base64,UklGRg=="
  ])("displays accepted image data URL %s unchanged", async qrContent => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => response(String(input).endsWith("/api/about") ? {} : { group: { ...group, qrContent }, serverTime }));
    render();
    await flushPromises();
    expect(page!.find('[aria-label="微信交流群"]').exists()).toBe(true);
    expect(page!.get('[aria-label="微信交流群"] img').attributes("src")).toBe(qrContent);
  });

  it.each([null, {}, { ...group, qrContent: "" }, { ...group, qrContent: "javascript:alert(1)" }, { ...group, expiresAt: "invalid" }, { ...group, expiresAt: serverTime }])(
    "omits unavailable, malformed and expired groups without placeholders: %j", async invalidGroup => {
      fetchMock.mockImplementation(async (input: RequestInfo | URL) => response(String(input).endsWith("/api/about") ? {} : { group: invalidGroup, serverTime }));
      render();
      await flushPromises();
      expectHidden();
      expect(page!.find(".inline-panel-error").exists()).toBe(false);
    }
  );

  it.each([
    "https://weixin.qq.com/g/synthetic-group",
    "data:image/svg+xml;base64,PHN2Zz4=",
    "data:image/gif;base64,R0lGODlh",
    "data:text/html;base64,dGVzdA==",
    "data:image/png,plain",
    "data:image/png;base64,",
    "data:image/png;base64,a",
    "data:image/png;base64,AAAA====",
    "data:image/png;base64,AA A",
    "data:image/png;base64,AA-A",
    "data:image/png;base64,===="
  ])("silently rejects unsafe or malformed image data %s", async qrContent => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => response(String(input).endsWith("/api/about") ? {} : { group: { ...group, qrContent }, serverTime }));
    render();
    await flushPromises();
    expectHidden();
  });

  it("accepts the 5 MiB limit and silently omits one byte above it", async () => {
    const maxBytes = 5 * 1024 * 1024;
    let qrContent = `data:image/png;base64,${Buffer.alloc(maxBytes).toString("base64")}`;
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => response(String(input).endsWith("/api/about") ? {} : { group: { ...group, qrContent }, serverTime }));
    render();
    await flushPromises();
    expect(page!.get('[aria-label="微信交流群"] img').attributes("src")).toBe(qrContent);
    page!.unmount();
    qrContent = `data:image/png;base64,${Buffer.alloc(maxBytes + 1).toString("base64")}`;
    render();
    await flushPromises();
    expectHidden();
  });

  it.each([401, 403, 404, 500, 503])("silently ignores HTTP %s without global access errors", async status => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => response({}, String(input).endsWith("/api/about") ? 200 : status));
    render();
    await flushPromises();
    expectHidden();
    expect(page!.find(".inline-panel-error").exists()).toBe(false);
  });

  it.each(["network", "json"])("silently omits the group after a %s failure", async failure => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/api/about")) return response({});
      if (failure === "json") return new Response("invalid JSON");
      throw new Error("synthetic network failure");
    });
    render();
    await flushPromises();
    expectHidden();
    expect(page!.find(".inline-panel-error").exists()).toBe(false);
  });

  it("starts independently of about loading and preserves existing about errors", async () => {
    const pending = deferred<Response>();
    fetchMock.mockImplementation((input: RequestInfo | URL) => String(input).endsWith("/api/about") ? pending.promise : Promise.resolve(response({ group, serverTime })));
    render();
    await flushPromises();
    expect(page!.find('[aria-label="微信交流群"]').exists()).toBe(true);
    pending.resolve(response({}, 500));
    await flushPromises();
    expect(page!.get(".inline-panel-error").text()).toContain("请求失败");
    expect(page!.find('[aria-label="微信交流群"]').exists()).toBe(true);
  });

  it("uses server time despite device clock skew and hides exactly on expiry", async () => {
    vi.setSystemTime(new Date("2099-01-01T00:00:00Z"));
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => response(String(input).endsWith("/api/about") ? {} : { group: { ...group, expiresAt: "2026-10-23T12:00:01.000Z" }, serverTime }));
    render();
    await flushPromises();
    expect(page!.find('[aria-label="微信交流群"]').exists()).toBe(true);
    await vi.advanceTimersByTimeAsync(999);
    expect(page!.find('[aria-label="微信交流群"]').exists()).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expectHidden();
  });

  it("hides an expired QR on return after device sleep even if the performance clock paused", async () => {
    render();
    await flushPromises();
    expect(page!.find('[aria-label="微信交流群"]').exists()).toBe(true);
    vi.setSystemTime(new Date("2026-10-23T12:02:00.000Z"));
    document.dispatchEvent(new Event("visibilitychange"));
    await flushPromises();
    expectHidden();
  });

  it("does not display an image that expires while the response is in transit", async () => {
    const pending = deferred<Response>();
    fetchMock.mockImplementation((input: RequestInfo | URL) => String(input).endsWith("/api/about") ? Promise.resolve(response({})) : pending.promise);
    render();
    await flushPromises();
    await vi.advanceTimersByTimeAsync(1001);
    pending.resolve(response({ group: { ...group, expiresAt: "2026-10-23T12:00:01.000Z" }, serverTime }));
    await flushPromises();
    expectHidden();
  });

  it("aborts a slow request silently and ignores any late result", async () => {
    const pending = deferred<Response>();
    fetchMock.mockImplementation((input: RequestInfo | URL) => String(input).endsWith("/api/about") ? Promise.resolve(response({})) : pending.promise);
    render();
    await flushPromises();
    const [, init] = fetchMock.mock.calls.find(([input]) => String(input).endsWith("/api/wechat-group"))!;
    await vi.advanceTimersByTimeAsync(6000);
    expect((init as RequestInit).signal!.aborted).toBe(true);
    pending.resolve(response({ group, serverTime }));
    await flushPromises();
    expectHidden();
  });

  it("aborts on unmount and removes expiry timers and visibility listeners", async () => {
    const removeListener = vi.spyOn(document, "removeEventListener");
    render();
    await flushPromises();
    const [, init] = fetchMock.mock.calls.find(([input]) => String(input).endsWith("/api/wechat-group"))!;
    expect(vi.getTimerCount()).toBe(1);
    page!.unmount();
    page = undefined;
    expect((init as RequestInit).signal!.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(removeListener).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
  });

  it("hides the complete section if the original image cannot load", async () => {
    render();
    await flushPromises();
    await page!.get('[aria-label="微信交流群"] img').trigger("error");
    expectHidden();
  });
});
