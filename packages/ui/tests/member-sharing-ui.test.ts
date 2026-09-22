import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { ref } from "vue";

const { request, ask, refreshMembers } = vi.hoisted(() => ({
  request: vi.fn(), ask: vi.fn(), refreshMembers: vi.fn()
}));
vi.mock("../src/utils/api", () => ({ request }));
vi.mock("../src/composables/useConfirm", () => ({ useConfirm: () => ({ ask }) }));
vi.mock("../src/composables/useScrollLock", () => ({ useScrollLock: () => {} }));
vi.mock("../src/composables/useAppContext", () => ({
  useAppContext: () => ({
    session: ref({ id: "owner" }),
    preferences: ref({ selfMemberId: "member" }),
    allMembers: ref([
      { id: "member", displayName: "示例成员", relationship: "self", permission: "manager", canManageSharing: true },
      { id: "second", displayName: "第二成员", relationship: "other", permission: "manager", canManageSharing: true },
      { id: "hidden", displayName: "隐藏示例", relationship: "other", permission: "viewer", hidden: true }
    ]),
    refreshMembers
  })
}));
import MemberManager from "../src/components/MemberManager.vue";

const access = [{ userId: "owner", displayName: "示例账号", permission: "manager", canManageSharing: true, version: 3 }];
beforeEach(() => {
  vi.clearAllMocks();
  request.mockImplementation(async (path: string, options?: RequestInit) => {
    if (path.endsWith("/sharing-accounts")) return [{ id: "owner", displayName: "示例账号" }, { id: "guest", displayName: "待共享账号" }];
    if (options?.method === "PUT") return [...access, { userId: "guest", displayName: "待共享账号", permission: "viewer", version: 4 }];
    return access;
  });
});

describe("成员共享交互", () => {
  it("加载账号列表不自动授权，新增共享默认仅查看且不允许再次共享", async () => {
    const wrapper = mount(MemberManager);
    await wrapper.get('[title="访问权限"]').trigger("click");
    await flushPromises();
    expect(request).toHaveBeenCalledWith("members/member/sharing-accounts");
    expect(wrapper.text()).toContain("待共享账号");
    expect(request.mock.calls.some(([, options]) => options?.method === "PUT")).toBe(false);
    const shareButton = wrapper.findAll("button").find(button => button.text() === "共享为仅查看")!;
    await shareButton.trigger("click");
    await flushPromises();
    expect(request).toHaveBeenCalledWith("members/member/permissions", expect.objectContaining({
      body: JSON.stringify({ userId: "guest", permission: "viewer", canManageSharing: false, version: 3 })
    }));
    expect(ask).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("切换已隐藏档案只切换列表，不修改授权或删除档案", async () => {
    const wrapper = mount(MemberManager);
    expect(wrapper.find(".member-list").text()).not.toContain("隐藏示例");
    await wrapper.findAll(".member-list-toolbar button")[1].trigger("click");
    expect(wrapper.find(".member-list").text()).toContain("隐藏示例");
    expect(wrapper.find(".member-list").text()).not.toContain("示例成员");
    expect(wrapper.get('[title="取消隐藏"]').exists()).toBe(true);
    expect(request).not.toHaveBeenCalled();
    wrapper.unmount();
  });
});

it("成员范围默认当前成员，多选仅向所选范围提交并确认覆盖", async () => {
  const wrapper = mount(MemberManager);
  await wrapper.findAll('[title="访问权限"]')[0].trigger("click");
  await flushPromises();
  const checkboxes = wrapper.findAll('.sharing-member-options input');
  expect(checkboxes).toHaveLength(2);
  expect((checkboxes[0].element as HTMLInputElement).checked).toBe(true);
  expect((checkboxes[1].element as HTMLInputElement).checked).toBe(false);
  await checkboxes[1].setValue(true);
  await flushPromises();
  const picker = wrapper.findAllComponents({name:"FormSelect"}).find(component => component.props("ariaLabel") === "接收账号")!;
  picker.vm.$emit("update:modelValue", "guest");
  await flushPromises();
  await wrapper.get(".member-form").trigger("submit");
  expect(ask).toHaveBeenCalled();
  const confirmation = ask.mock.calls[0][0];
  expect(confirmation.message).toContain("示例成员、第二成员");
  expect(confirmation.message).toContain("覆盖");
  expect(request.mock.calls.some(([,options])=>options?.method==="PUT")).toBe(false);
  await confirmation.run();
  expect(request).toHaveBeenCalledWith("members/permissions", expect.objectContaining({
    body:JSON.stringify({userId:"guest",permission:"viewer",canManageSharing:false,members:[{memberId:"member",version:3},{memberId:"second",version:3}]})
  }));
  wrapper.unmount();
});
