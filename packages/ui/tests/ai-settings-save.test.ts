import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";

const mocks = vi.hoisted(() => ({ request: vi.fn(), ask: vi.fn(), toast: vi.fn(), push: vi.fn(), guard: null as any }));
vi.mock("../src/utils/api", () => ({ request: mocks.request }));
vi.mock("../src/composables/useConfirm", () => ({ useConfirm: () => ({ ask: mocks.ask }) }));
vi.mock("../src/composables/useToast", () => ({ useToast: () => ({ show: mocks.toast }) }));
vi.mock("vue-router", () => ({ useRouter: () => ({ push: mocks.push }), onBeforeRouteLeave: (guard: unknown) => { mocks.guard = guard; } }));
import AiSettings from "../src/pages/settings/AiSettingsPage.vue";

function fixture() {
  return {
    enabled: true, requestTimeoutSeconds: 600, extractionDepth: "overview", defaultProfileId: "main",
    profiles: [{ id: "main", name: "合成连接", provider: "deepseek", providerLabel: "DeepSeek", baseUrl: "https://example.test/v1", textModel: "synthetic-model", visionModel: "", visionEnabled: false, apiKeyConfigured: true, apiKeyMasked: "old••••0000", headers: [] as Array<{name:string;value:string;configured?:boolean}> }],
    providers: [{ key: "deepseek", label: "DeepSeek", defaultBaseUrl: "https://example.test/v1", defaultTextModel: "synthetic-model", defaultVisionModel: "" }],
    tasks: [], taskBindings: {}
  };
}
let wrapper: ReturnType<typeof mount>;
let stored: ReturnType<typeof fixture>;
const puts = () => mocks.request.mock.calls.filter(([, init]) => init?.method === "PUT");
function button(text: string, selector = "button") {
  const match = wrapper.findAll(selector).find(b => b.text() === text);
  if (!match) throw new Error(`Missing button: ${text}`);
  return match;
}
async function start() {
  wrapper = mount(AiSettings, { global: { stubs: { teleport: true, SubPageHeader: true, FormSelect: true } } });
  await flushPromises();
}
async function edit() {
  await wrapper.get('[aria-label="编辑连接配置"]').trigger("click");
}
const editorSave = () => button("保存配置", ".ai-editor-footer button");

beforeEach(() => {
  vi.clearAllMocks(); stored = fixture();
  mocks.request.mockImplementation(async (_path, init) => {
    if (init?.method === "PUT") {
      const input = JSON.parse(init.body);
      stored = { ...stored, ...input, profiles: input.profiles.map((p: any) => {
        const { apiKey, clearApiKey, ...profile } = p;
        const headers=(profile.headers || stored.profiles.find(old=>old.id===profile.id)?.headers || []).map((header:any)=>({name:header.name.toLowerCase(),value:'',configured:true}));
        return { ...profile, headers, providerLabel: "DeepSeek", apiKeyConfigured: !clearApiKey, apiKeyMasked: clearApiKey ? "" : apiKey ? "new••••1111" : "old••••0000" };
      }) };
    }
    return structuredClone(stored);
  });
});
afterEach(() => wrapper?.unmount());

it("saves an edited key in one click and reloads the saved response without retaining plaintext", async () => {
  await start(); await edit();
  await wrapper.get('input[type="password"]').setValue("synthetic-new-key");
  await editorSave().trigger("click"); await flushPromises();
  expect(puts()).toHaveLength(1);
  expect(JSON.parse(puts()[0][1].body).profiles[0].apiKey).toBe("synthetic-new-key");
  expect(wrapper.find('[role="dialog"]').exists()).toBe(false);
  expect(wrapper.text()).toContain("AI 配置已保存");
  await edit();
  expect((wrapper.get('input[type="password"]').element as HTMLInputElement).value).toBe("");
  expect(wrapper.text()).toContain("new••••1111");
  wrapper.unmount(); await start(); await edit();
  expect(wrapper.text()).toContain("new••••1111");
});

it("retains input after failure, blocks duplicate saves and closes only after retry succeeds", async () => {
  await start(); await edit();
  await wrapper.get('input[type="password"]').setValue("synthetic-retry-key");
  let reject!: (error: Error) => void;
  mocks.request.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
  await editorSave().trigger("click");
  expect(button("保存中", ".ai-editor-footer button").attributes("disabled")).toBeDefined();
  await button("取消", ".ai-editor-footer button").trigger("click");
  expect(wrapper.find('[role="dialog"]').exists()).toBe(true);
  expect(mocks.guard({ fullPath: "/me" })).toBe(false);
  expect(puts()).toHaveLength(1);
  reject(new Error("合成保存失败")); await flushPromises();
  expect(wrapper.get(".ai-editor-message").text()).toBe("合成保存失败");
  expect((wrapper.get('input[type="password"]').element as HTMLInputElement).value).toBe("synthetic-retry-key");
  expect(wrapper.text()).not.toContain("AI 配置已保存");
  await editorSave().trigger("click"); await flushPromises();
  expect(puts()).toHaveLength(2);
  expect(wrapper.find('[role="dialog"]').exists()).toBe(false);
});

it("cancel discards both key replacement and key clearing before an outer save", async () => {
  await start(); await edit();
  await button("清除已保存的 Key").trigger("click");
  await wrapper.get('input[type="password"]').setValue("synthetic-discarded-key");
  await button("取消", ".ai-editor-footer button").trigger("click");
  await button("保存配置").trigger("click"); await flushPromises();
  const profile = JSON.parse(puts()[0][1].body).profiles[0];
  expect(profile).not.toHaveProperty("apiKey");
  expect(profile).not.toHaveProperty("clearApiKey");
  await edit(); expect(wrapper.text()).toContain("old••••0000");
});

it("saves explicit clearing and gives a newly entered key priority", async () => {
  await start(); await edit(); await button("清除已保存的 Key").trigger("click");
  await editorSave().trigger("click"); await flushPromises();
  expect(JSON.parse(puts()[0][1].body).profiles[0].clearApiKey).toBe(true);
  wrapper.unmount(); stored = fixture(); await start(); await edit();
  await button("清除已保存的 Key").trigger("click");
  await wrapper.get('input[type="password"]').setValue("synthetic-replacement");
  await editorSave().trigger("click"); await flushPromises();
  const profile = JSON.parse(puts()[1][1].body).profiles[0];
  expect(profile.apiKey).toBe("synthetic-replacement");
  expect(profile).not.toHaveProperty("clearApiKey");
});

it("saves a first connection and other page changes together", async () => {
  stored.profiles = []; stored.defaultProfileId = ""; stored.enabled = false;
  await start(); await wrapper.get('input[type="number"]').setValue("900");
  expect(wrapper.text()).toContain("有未保存的修改");
  await button("添加连接配置").trigger("click");
  await wrapper.get('input[type="password"]').setValue("synthetic-first-key");
  await editorSave().trigger("click"); await flushPromises();
  const input = JSON.parse(puts()[0][1].body);
  expect(input.defaultProfileId).toBe(input.profiles[0].id);
  expect(input.requestTimeoutSeconds).toBe(900);
  expect(wrapper.text()).not.toContain("有未保存的修改");
});

it("warns when leaving or reloading unsaved page or editor changes", async () => {
  await start(); expect(mocks.guard({ fullPath: "/me" })).toBe(true);
  await edit(); await wrapper.get('input[type="password"]').setValue("synthetic-draft");
  expect(mocks.guard({ fullPath: "/me" })).toBe(false);
  expect(mocks.ask).toHaveBeenCalledOnce();
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event); expect(event.defaultPrevented).toBe(true);
  await mocks.ask.mock.calls[0][0].run();
  expect(mocks.push).toHaveBeenCalledWith("/me");
  expect(mocks.guard({ fullPath: "/me" })).toBe(true);
  await wrapper.get('input[type="number"]').setValue("900");
  expect(mocks.guard({ fullPath: "/me" })).toBe(false);
});


it("selects the OpenCode Go preset and saves its endpoint and model as a separate connection",async()=>{
 stored.providers.push({key:"opencode-go",label:"OpenCode Go",defaultBaseUrl:"https://opencode.ai/inference/go/openai/v1",defaultTextModel:"glm-5.2",defaultVisionModel:""});
 await start();
 await button("添加连接配置").trigger("click");
 const select=wrapper.findAllComponents({name:"FormSelect"}).find(item=>item.props('ariaLabel')==='服务商预设')!;
 expect(select.props('options')).toContainEqual({value:'opencode-go',label:'OpenCode Go'});
 select.vm.$emit('update:modelValue','opencode-go');await flushPromises();await select.trigger('change');await flushPromises();
 await wrapper.get('input[type="password"]').setValue('synthetic-go-key');
 await editorSave().trigger('click');await flushPromises();
 const profiles=JSON.parse(puts()[0][1].body).profiles;
 expect(profiles.find((item:any)=>item.provider==='opencode-go')).toMatchObject({baseUrl:'https://opencode.ai/inference/go/openai/v1',textModel:'glm-5.2',apiKey:'synthetic-go-key'});
 expect(profiles.find((item:any)=>item.id==='main').provider).toBe('deepseek');
});


it('adds, masks, preserves and removes custom headers while clearing editor values after save',async()=>{
 await start();await edit();
 await button('添加 Header').trigger('click');
 await wrapper.get('[aria-label="Header 名称 1"]').setValue('X-Token');
 await wrapper.get('[aria-label="Header 值 1"]').setValue('synthetic-private-header');
 expect(wrapper.get('[aria-label="Header 值 1"]').attributes('type')).toBe('password');
 await editorSave().trigger('click');await flushPromises();
 expect(JSON.parse(puts()[0][1].body).profiles[0].headers).toEqual([{name:'X-Token',value:'synthetic-private-header'}]);
 expect(JSON.stringify(stored)).not.toContain('synthetic-private-header');
 await edit();
 expect((wrapper.get('[aria-label="Header 值 1"]').element as HTMLInputElement).value).toBe('');
 expect(wrapper.get('[aria-label="Header 值 1"]').attributes('placeholder')).toContain('留空保持');
 await editorSave().trigger('click');await flushPromises();
 expect(JSON.parse(puts()[1][1].body).profiles[0].headers).toEqual([{name:'x-token',value:''}]);
 await edit();await wrapper.get('[aria-label="删除 Header 1"]').trigger('click');
 await editorSave().trigger('click');await flushPromises();
 expect(JSON.parse(puts()[2][1].body).profiles[0].headers).toEqual([]);
});

it('uses unsaved custom headers in model listing and both tests without putting values in URLs or saving',async()=>{
 await start();await edit();
 await button('添加 Header').trigger('click');
 await wrapper.get('[aria-label="Header 名称 1"]').setValue('X-App');
 await wrapper.get('[aria-label="Header 值 1"]').setValue('synthetic-unsaved-header');
 const original=mocks.request.getMockImplementation()!;
 mocks.request.mockImplementation(async(path,init)=>{
  if(path==='ai/models')return {models:[],total:0};
  if(path==='ai/test')return {model:'synthetic',elapsedMs:1};
  if(path==='ai/test-enhanced')return {steps:[],overallSuccess:true,totalElapsedMs:1};
  return original(path,init);
 });
 await wrapper.findAll('[title="获取模型列表"]')[0].trigger('click');await flushPromises();
 await button('快速测试').trigger('click');await flushPromises();
 await button('完整测试').trigger('click');await flushPromises();
 for(const endpoint of ['ai/models','ai/test','ai/test-enhanced']) {
  const call=mocks.request.mock.calls.find(([path])=>path===endpoint)!;
  expect(call[1].method).toBe('POST');
  expect(call[0]).not.toContain('synthetic-unsaved-header');
  expect(JSON.parse(call[1].body).headers).toEqual([{name:'X-App',value:'synthetic-unsaved-header'}]);
 }
 expect(puts()).toHaveLength(0);
});
