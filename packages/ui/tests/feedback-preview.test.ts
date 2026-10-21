import { mount, flushPromises } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import FeedbackImageEditor from "../src/components/FeedbackImageEditor.vue";
import FeedbackSettingsPage from "../src/pages/settings/FeedbackSettingsPage.vue";
const request = vi.hoisted(() => vi.fn());
vi.mock("../src/utils/api", () => ({ request:(path:string,...args:unknown[])=>path==='feedback/identity'?Promise.resolve({clientId:'a'.repeat(43)}):request(path,...args) }));
beforeEach(() => { request.mockReset(); request.mockImplementation(async (path:string) => {
  if(path==='feedback-diagnostics') return {appVersion:'0.2.11',accessMode:'port',runtime:{platform:'linux',arch:'arm64',node:'v24'},database:{appliedSchemaVersion:17}};
  if(path.startsWith('feedback/tickets?')) return {items:[],total:0};
  throw new Error('服务连接失败，尚未提交');
}); });
afterEach(() => vi.restoreAllMocks());
function render() { return mount(FeedbackSettingsPage, { global: { stubs: { SubPageHeader: true, Teleport: true, FeedbackImageEditor: true } } }); }
describe("feedback service UI", () => {
  it("mixes PDFs and images without a count limit, edits only images and submits the original PDF", async () => {
    let counter=0;
    vi.spyOn(URL,'createObjectURL').mockImplementation(()=>`blob:mixed-${++counter}`);
    vi.spyOn(URL,'revokeObjectURL').mockImplementation(()=>{});
    const files=[new File(['original-pdf-bytes'],'report.pdf',{type:'application/pdf'}),
      ...Array.from({length:7},(_,i)=>new File(['image'],`image-${i}.png`,{type:'image/png'}))];
    const wrapper=render();await wrapper.get('.feedback-primary').trigger('click');
    const input=wrapper.get('input[type="file"]');
    expect(input.attributes('accept')).toContain('application/pdf');
    Object.defineProperty(input.element,'files',{value:files});await input.trigger('change');
    expect(wrapper.findAll('.attachment-tile')).toHaveLength(8);
    expect(wrapper.findAll('.attachment-edit')).toHaveLength(7);
    expect(wrapper.get('.attachment-add').exists()).toBe(true);
    await wrapper.get('.attachment-preview').trigger('click');
    expect(wrapper.get('iframe[title="PDF 附件预览"]').attributes('src')).toBe('blob:mixed-1');
    expect(wrapper.text()).toContain('PDF 不支持在线打码');
    let uploads=0;const received:File[]=[];
    request.mockImplementation(async(path:string,init:any)=>{
      if(path==='feedback/upload'){received.push(init.body.get('file'));return{id:++uploads};}
      if(path==='feedback/tickets'&&init?.method==='POST'){
        expect(JSON.parse(init.body).attachmentIds).toHaveLength(8);
        return{number:'B0001',status:'received',version:1,createdAt:'2026-01-03'};
      }
      return{items:[],total:0};
    });
    await wrapper.get('form input').setValue('合成附件反馈');await wrapper.get('form textarea').setValue('合成描述');
    await flushPromises();await wrapper.get('form').trigger('submit');await flushPromises();
    expect(uploads).toBe(8);expect(received[0].name).toBe(files[0].name);expect(received[0].type).toBe('application/pdf');
    expect(await received[0].text()).toBe('original-pdf-bytes');
    wrapper.unmount();
  });
  it("preserves draft and avoids success when the service fails", async () => {
    const wrapper = render();
    expect(wrapper.text()).not.toContain("UI 预览");
    await wrapper.get(".feedback-primary").trigger("click");
    await wrapper.get("form input").setValue("界面建议");
    await wrapper.get("form textarea").setValue("希望优化按钮布局");
    expect(wrapper.get('button[type="submit"]').text()).toBe("提交反馈");
    await flushPromises();
    await wrapper.get("form").trigger("submit");
    await flushPromises();
    expect(wrapper.findAll('[role="alert"]').map(i=>i.text()).join(" ")).toContain("尚未提交");
    expect(wrapper.find(".success-card").exists()).toBe(false);
    expect(wrapper.text()).not.toContain("DEMO-");
    expect((wrapper.get("form input").element as HTMLInputElement).value).toBe("界面建议");
    expect(request.mock.calls.every(call => typeof call[0] === "string" && (call[0] === "feedback-diagnostics" || call[1]?.headers?.["x-client-id"] === undefined))).toBe(true);
    wrapper.unmount();
  });
  it("keeps the list visible and preserves a draft when dismissed", async () => {
    const wrapper = render();
    await wrapper.get(".feedback-primary").trigger("click");
    expect(wrapper.find(".list-toolbar").exists()).toBe(true);
    expect(wrapper.get("details.environment-info").attributes("open")).toBeUndefined();
    const types = wrapper.findAll(".type-options button");
    expect(types[0].text()).toBe("使用问题");
    expect(types[0].attributes("aria-pressed")).toBe("true");
    await types[1].trigger("click");
    expect(wrapper.findAll(".type-options button")[1].attributes("aria-pressed")).toBe("true");
    expect(wrapper.findAll(".type-options button")[0].attributes("aria-pressed")).toBe("false");
    expect(wrapper.get('[role="dialog"]').attributes("aria-modal")).toBe("true");
    await wrapper.get("form input").setValue("未提交草稿");
    await wrapper.get(".modal-close").trigger("click");
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false);
    await wrapper.get(".feedback-primary").trigger("click");
    expect((wrapper.get("form input").element as HTMLInputElement).value).toBe("未提交草稿");
    await wrapper.get(".feedback-overlay").trigger("keydown", { key: "Escape" });
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false);
    wrapper.unmount();
  });
  it("only includes reproduction steps for usage problems", async () => {
    const wrapper = render();
    await wrapper.get(".feedback-primary").trigger("click");
    await wrapper.get("form input").setValue("建议标题");
    await wrapper.get("form textarea").setValue("建议描述");
    expect(wrapper.get("details").attributes("open")).toBeUndefined();
    await wrapper.get("details textarea").setValue("步骤草稿");
    for (const index of [1, 2]) {
      await wrapper.findAll(".type-options button")[index].trigger("click");
      expect(wrapper.find("details textarea").exists()).toBe(false);
    }
    await wrapper.findAll(".type-options button")[0].trigger("click");
    expect((wrapper.get("details textarea").element as HTMLTextAreaElement).value).toBe("步骤草稿");
    await wrapper.findAll(".type-options button")[1].trigger("click");
    await flushPromises();
    await wrapper.get("form").trigger("submit");
    await flushPromises();
    expect(wrapper.find("details textarea").exists()).toBe(false);
    expect(wrapper.findAll('[role="alert"]').map(i=>i.text()).join(" ")).toContain("尚未提交");
    wrapper.unmount();
  });
  it("validates local screenshots, preserves them and releases previews", async () => {
    let count = 0;
    vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:preview-${++count}`);
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const wrapper = render();
    await wrapper.get(".feedback-primary").trigger("click");
    const input = wrapper.get('input[type="file"]');
    const valid = new File(["image"], "sample.png", { type: "image/png" });
    const invalid = new File(["text"], "sample.svg", { type: "image/svg+xml" });
    const oversized = new File(["x"], "large.png", { type: "image/png" });
    Object.defineProperty(oversized, "size", { value: 11 * 1024 * 1024 });
    Object.defineProperty(input.element, "files", { configurable: true, value: [invalid, oversized, ...Array(7).fill(valid)] });
    await input.trigger("change");
    expect(wrapper.findAll(".attachment-tile")).toHaveLength(7);
    expect(wrapper.get(".attachment-error").text()).toContain("10 MB");
    expect(wrapper.get(".attachment-add").exists()).toBe(true);
    await wrapper.get(".attachment-preview").trigger("click");
    expect(wrapper.find(".attachment-expanded img").exists()).toBe(true);
    await wrapper.get(".attachment-remove").trigger("click");
    expect(revoke).toHaveBeenCalledWith("blob:preview-1");
    await wrapper.get(".modal-close").trigger("click");
    await wrapper.get(".feedback-primary").trigger("click");
    expect(wrapper.findAll(".attachment-tile")).toHaveLength(6);
    await wrapper.get("form input").setValue("截图反馈");
    await wrapper.get("form textarea").setValue("布局问题");
    await flushPromises();
    await wrapper.get("form").trigger("submit");
    await flushPromises();
    expect(wrapper.findAll(".attachment-tile")).toHaveLength(6);
    expect(wrapper.find(".success-card").exists()).toBe(false);
    expect(request.mock.calls.every(call => typeof call[0] === "string" && (call[0] === "feedback-diagnostics" || call[1]?.headers?.["x-client-id"] === undefined))).toBe(true);
    wrapper.unmount();
    expect(revoke).toHaveBeenCalledTimes(7);
  });
  it("replaces the original attachment with the edited file", async () => {
    vi.spyOn(URL, "createObjectURL").mockReturnValueOnce("blob:original").mockReturnValueOnce("blob:edited");
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const wrapper = render();
    await wrapper.get(".feedback-primary").trigger("click");
    const input = wrapper.get('input[type="file"]');
    Object.defineProperty(input.element, "files", { value: [new File(["original"], "sample.png", { type: "image/png" })] });
    await input.trigger("change");
    await wrapper.get(".attachment-edit").trigger("click");
    wrapper.getComponent(FeedbackImageEditor).vm.$emit("save", new File(["masked"], "feedback-edited.png", { type: "image/png" }));
    await wrapper.vm.$nextTick();
    expect(wrapper.get(".attachment-preview img").attributes("src")).toBe("blob:edited");
    expect(revoke).toHaveBeenCalledWith("blob:original");
    await wrapper.get(".attachment-edit").trigger("click");
    expect(await wrapper.getComponent(FeedbackImageEditor).props("file").text()).toBe("masked");
    wrapper.unmount();
  });
  it("does not add an unsubmitted draft to the feedback list", async () => {
    const wrapper = render();
    await wrapper.get(".feedback-primary").trigger("click");
    await wrapper.get("form input").setValue("搜索测试");
    await wrapper.get("form textarea").setValue("反馈描述");
    await flushPromises();
    await wrapper.get("form").trigger("submit");
    await flushPromises();
    await wrapper.get(".modal-close").trigger("click");
    expect(wrapper.findAll(".feedback-row")).toHaveLength(0);
    expect(wrapper.text()).toContain("还没有提交过反馈");
    wrapper.unmount();
  });
});
