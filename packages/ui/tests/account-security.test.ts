import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { ref } from "vue";
import type { LocalAccount } from "../src/types/api";

const { appLoad, confirmAsk, toastShow } = vi.hoisted(() => ({
  appLoad: vi.fn(),
  confirmAsk: vi.fn(),
  toastShow: vi.fn()
}));

vi.mock("vue-router", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("../src/composables/useAppContext", () => ({
  useAppContext: () => ({
    session: ref({ id: "user-admin", displayName: "管理员", isAdmin: true }),
    load: appLoad
  })
}));
vi.mock("../src/composables/useConfirm", () => ({ useConfirm: () => ({ ask: confirmAsk }) }));
vi.mock("../src/composables/useToast", () => ({ useToast: () => ({ show: toastShow }) }));
vi.mock("../src/composables/useScrollLock", () => ({ useScrollLock: () => {} }));

import AccountSecuritySettingsPage from "../src/pages/settings/AccountSecuritySettingsPage.vue";

const accounts: LocalAccount[] = [
  { id: "acc-admin", userId: "user-admin", username: "admin", displayName: "管理员", isAdmin: 1, mustChangePassword: 0, disabledAt: null },
  { id: "acc-1", userId: "user-1", username: "zhangsan", displayName: "张三", isAdmin: 0, mustChangePassword: 1, disabledAt: null },
  { id: "acc-2", userId: "user-2", username: "lisi", displayName: "李四", isAdmin: 0, mustChangePassword: 0, disabledAt: "2026-09-15 10:00:00" }
];

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify({ ok: status < 400, data }), {
    status,
    headers: { "content-type": "application/json" }
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

function callTo(urlPart: string, method?: string) {
  return fetchMock.mock.calls.find(([input, init]) => {
    if (!String(input).includes(urlPart)) return false;
    return method ? String((init as RequestInit | undefined)?.method || "GET") === method : true;
  }) as [RequestInfo | URL, RequestInit] | undefined;
}

async function mountPage() {
  const wrapper = mount(AccountSecuritySettingsPage, {
    attachTo: document.body,
    global: { stubs: { teleport: true } }
  });
  await flushPromises();
  return wrapper;
}

beforeEach(() => {
  appLoad.mockReset();
  confirmAsk.mockReset();
  toastShow.mockReset();
  fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/auth/accounts")) return jsonResponse(accounts);
    return jsonResponse({}, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("AccountSecuritySettingsPage", () => {
  it("renders management actions by role and status", async () => {
    const wrapper = await mountPage();
    const rows = wrapper.findAll(".account-row");
    expect(rows).toHaveLength(3);

    const adminRow = rows[0].text();
    expect(adminRow).toContain("管理员");
    expect(adminRow).toContain("编辑");
    expect(adminRow).toContain("修改密码");
    expect(adminRow).toContain("重置为 admin");
    expect(adminRow).not.toContain("停用");
    expect(adminRow).not.toContain("删除");

    const activeRow = rows[1].text();
    expect(activeRow).toContain("待修改密码");
    expect(activeRow).toContain("编辑");
    expect(activeRow).toContain("停用");
    expect(activeRow).toContain("删除");

    expect(rows[2].classes()).toContain("is-disabled");
    const disabledRow = rows[2].text();
    expect(disabledRow).toContain("已停用");
    expect(disabledRow).toContain("启用");
    expect(disabledRow).not.toContain("修改密码");
    expect(disabledRow).not.toContain("重置为 admin");
  });

  it("edits username and display name through the modal", async () => {
    const wrapper = await mountPage();
    await wrapper.findAll(".account-row")[1].find(".account-action-rename").trigger("click");
    await flushPromises();

    const modal = wrapper.find(".account-password-modal");
    expect(modal.exists()).toBe(true);
    expect(modal.text()).toContain("编辑账号");
    const inputs = modal.findAll("input");
    expect(inputs).toHaveLength(2);
    expect((inputs[0].element as HTMLInputElement).value).toBe("张三");
    expect((inputs[1].element as HTMLInputElement).value).toBe("zhangsan");

    fetchMock.mockClear();
    await inputs[0].setValue("张三三");
    await inputs[1].setValue("zhangsan-new");
    await modal.find("form").trigger("submit");
    await flushPromises();

    const renameCall = callTo("/api/auth/accounts/username", "PUT");
    expect(renameCall).toBeTruthy();
    expect(JSON.parse(String(renameCall![1].body))).toEqual({ userId: "user-1", username: "zhangsan-new" });
    const displayNameCall = callTo("/api/auth/accounts/displayname", "PUT");
    expect(displayNameCall).toBeTruthy();
    expect(JSON.parse(String(displayNameCall![1].body))).toEqual({ userId: "user-1", displayName: "张三三" });
    expect(callTo("/api/auth/accounts", "GET")).toBeTruthy();
    expect(toastShow).toHaveBeenCalledWith("账号已更新，对方下次登录需使用新用户名", 4200);
    expect(wrapper.find(".account-password-modal").exists()).toBe(false);
  });

  it("updates only the display name when the username is unchanged", async () => {
    const wrapper = await mountPage();
    await wrapper.findAll(".account-row")[1].find(".account-action-rename").trigger("click");
    await flushPromises();

    const modal = wrapper.find(".account-password-modal");
    fetchMock.mockClear();
    await modal.findAll("input")[0].setValue("张三三");
    await modal.find("form").trigger("submit");
    await flushPromises();

    expect(callTo("/api/auth/accounts/username", "PUT")).toBeUndefined();
    const displayNameCall = callTo("/api/auth/accounts/displayname", "PUT");
    expect(displayNameCall).toBeTruthy();
    expect(JSON.parse(String(displayNameCall![1].body))).toEqual({ userId: "user-1", displayName: "张三三" });
    expect(toastShow).toHaveBeenCalledWith("账号信息已更新", 4200);
  });

  it("rejects submitting the edit modal without changes", async () => {
    const wrapper = await mountPage();
    await wrapper.findAll(".account-row")[1].find(".account-action-rename").trigger("click");
    await flushPromises();

    fetchMock.mockClear();
    await wrapper.find(".account-password-modal form").trigger("submit");
    await flushPromises();

    expect(callTo("/api/auth/accounts/username", "PUT")).toBeUndefined();
    expect(callTo("/api/auth/accounts/displayname", "PUT")).toBeUndefined();
    /* teleport stub 在状态变化后会重建弹窗元素，必须重新查询 */
    expect(wrapper.find(".account-password-modal").text()).toContain("未做任何修改");
  });

  it("asks for confirmation before disabling and calls the status api", async () => {
    const wrapper = await mountPage();
    await wrapper.findAll(".account-row")[1].find(".account-action-disable").trigger("click");

    expect(confirmAsk).toHaveBeenCalledTimes(1);
    const options = confirmAsk.mock.calls[0][0] as { title: string; danger: boolean; run: () => Promise<void> };
    expect(options.title).toBe("停用本地账号");
    expect(options.danger).toBe(true);

    fetchMock.mockClear();
    await options.run();
    const statusCall = callTo("/api/auth/accounts/status", "PUT");
    expect(statusCall).toBeTruthy();
    expect(JSON.parse(String(statusCall![1].body))).toEqual({ userId: "user-1", disabled: true });
    expect(toastShow).toHaveBeenCalledWith("账号已停用，其登录会话已撤销", 4200);
  });

  it("enables a disabled account without danger styling", async () => {
    const wrapper = await mountPage();
    await wrapper.findAll(".account-row")[2].find(".account-action-enable").trigger("click");

    expect(confirmAsk).toHaveBeenCalledTimes(1);
    const options = confirmAsk.mock.calls[0][0] as { title: string; danger: boolean; run: () => Promise<void> };
    expect(options.title).toBe("启用本地账号");
    expect(options.danger).toBe(false);

    fetchMock.mockClear();
    await options.run();
    const statusCall = callTo("/api/auth/accounts/status", "PUT");
    expect(statusCall).toBeTruthy();
    expect(JSON.parse(String(statusCall![1].body))).toEqual({ userId: "user-2", disabled: false });
    expect(toastShow).toHaveBeenCalledWith("账号已启用", 4200);
  });

  it("deletes an ordinary account after a danger confirmation", async () => {
    const wrapper = await mountPage();
    await wrapper.findAll(".account-row")[1].find(".account-action-delete").trigger("click");

    expect(confirmAsk).toHaveBeenCalledTimes(1);
    const options = confirmAsk.mock.calls[0][0] as { title: string; danger: boolean; run: () => Promise<void> };
    expect(options.title).toBe("删除本地账号");
    expect(options.danger).toBe(true);

    fetchMock.mockClear();
    await options.run();
    const deleteCall = callTo("/api/auth/accounts", "DELETE");
    expect(deleteCall).toBeTruthy();
    expect(JSON.parse(String(deleteCall![1].body))).toEqual({ userId: "user-1" });
    expect(toastShow).toHaveBeenCalledWith("账号已删除，其成员档案保留", 4200);
  });

  it("asks a second force confirmation when delete is blocked by orphaned data", async () => {
    fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = String(init?.method || "GET");
      if (url.includes("/api/auth/accounts") && method === "DELETE") {
        const body = JSON.parse(String(init?.body || "{}")) as { force?: boolean };
        if (!body.force) {
          return new Response(
            JSON.stringify({ error: true, status: 409, message: "该账号名下有 1 个仅其管理的成员档案，共 2 份报告" }),
            { status: 409, headers: { "content-type": "application/json" } }
          );
        }
        return jsonResponse({ deleted: true, exclusiveMemberCount: 1, exclusiveReportCount: 2 });
      }
      if (url.includes("/api/auth/accounts")) return jsonResponse(accounts);
      return jsonResponse({}, 404);
    });
    vi.stubGlobal("fetch", fetchMock);

    const wrapper = await mountPage();
    await wrapper.findAll(".account-row")[1].find(".account-action-delete").trigger("click");
    expect(confirmAsk).toHaveBeenCalledTimes(1);

    const first = confirmAsk.mock.calls[0][0] as { run: () => Promise<void> };
    await first.run();

    expect(confirmAsk).toHaveBeenCalledTimes(2);
    const second = confirmAsk.mock.calls[1][0] as { title: string; confirmText: string; danger: boolean; message: string; run: () => Promise<void> };
    expect(second.title).toBe("确认强制删除");
    expect(second.confirmText).toBe("仍要删除");
    expect(second.danger).toBe(true);
    expect(second.message).toContain("共 2 份报告");

    fetchMock.mockClear();
    await second.run();
    const forceCall = callTo("/api/auth/accounts", "DELETE");
    expect(forceCall).toBeTruthy();
    expect(JSON.parse(String(forceCall![1].body))).toEqual({ userId: "user-1", force: true });
    expect(toastShow).toHaveBeenCalledWith("账号已删除；其名下报告已无人可访问，存储仍被占用", 4200);
  });
});
