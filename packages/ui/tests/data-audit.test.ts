import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { ref } from "vue";
import type { BackupSummary } from "../src/types/api";

const { appLoad, confirmAsk, toastShow } = vi.hoisted(() => ({
  appLoad: vi.fn(),
  confirmAsk: vi.fn(),
  toastShow: vi.fn()
}));

vi.mock("vue-router", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("../src/composables/useAppContext", () => ({
  useAppContext: () => ({
    session: ref({ id: "user-admin", displayName: "管理员", isAdmin: true, provider: "local" }),
    selectedMemberId: ref(""),
    load: appLoad
  })
}));
vi.mock("../src/composables/useConfirm", () => ({ useConfirm: () => ({ ask: confirmAsk }) }));
vi.mock("../src/composables/useToast", () => ({ useToast: () => ({ show: toastShow }) }));
vi.mock("../src/composables/useScrollLock", () => ({ useScrollLock: () => {} }));

import DataAuditSettingsPage from "../src/pages/settings/DataAuditSettingsPage.vue";

const backup: BackupSummary = {
  id: "backup_1",
  filename: "health-records-backup.tar.gz",
  createdAt: "2026-09-15 10:00:00",
  sizeBytes: 2048,
  appVersion: "0.2.8",
  schemaVersion: 17,
  reportCount: 3,
  memberCount: 1,
  includes: ["数据库", "原件"],
  reason: "manual"
};

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify({ ok: status < 400, data }), {
    status,
    headers: { "content-type": "application/json" }
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  appLoad.mockReset();
  confirmAsk.mockReset();
  toastShow.mockReset();
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = String(init?.method || "GET");
    if(url.endsWith("/preflight")) return jsonResponse({token:"test-plan",warning:"账号和授权将回到备份时点，普通账号不会统一停用"});
    if (url.includes("/api/backups/") && method === "POST") {
      return jsonResponse({
        restored: true,
        backupId: "backup_1",
        safetyBackupId: "backup_0",
        identityRebind: { strategy: "same" }
      });
    }
    if (url.includes("/api/backups")) return jsonResponse([backup]);
    return jsonResponse({}, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("DataAuditSettingsPage restore notices", () => {
  it("requires preflight confirmation and preserves local account permissions", async () => {
    const wrapper = mount(DataAuditSettingsPage, { attachTo: document.body });
    await flushPromises();

    const restoreButton = wrapper.findAll(".backup-item .backup-actions button")
      .find(button => button.text().includes("恢复"));
    expect(restoreButton).toBeTruthy();
    await restoreButton!.trigger("click");
    await flushPromises();

    expect(confirmAsk).toHaveBeenCalledTimes(1);
    const options = confirmAsk.mock.calls[0][0] as { title: string; message: string; danger: boolean; run: () => Promise<void> };
    expect(options.title).toBe("从备份恢复");
    expect(options.message).toContain("账号和授权将回到备份时点");
    expect(options.message).toContain("普通账号不会统一停用");

    await options.run();
    await flushPromises();

    expect(wrapper.text()).toContain("授权已回到备份时点，请重新登录");
    expect(fetchMock.mock.calls.some(([url,init])=>String(url).endsWith("/restore") && JSON.parse(String(init?.body)).token==="test-plan")).toBe(true);
    expect(toastShow).toHaveBeenCalledWith("备份已恢复");
    expect(appLoad).toHaveBeenCalled();
  });
});
