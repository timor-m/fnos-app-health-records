import { readFileSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mount, flushPromises, config } from "@vue/test-utils";
import { ref } from "vue";
const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  upload: vi.fn(),
  admin: false,
}));
vi.mock("../src/utils/api", () => ({
  request: mocks.request,
  requestUpload: mocks.upload,
  apiUrl: (path: string) => "/api/" + path,
  ApiRequestError: class extends Error {
    status = 403;
  },
}));
vi.mock("../src/composables/useAppContext", () => ({
  useAppContext: () => ({
    session: ref({
      id: "user",
      authenticated: true,
      authMode: "local",
      isAdmin: mocks.admin,
    }),
  }),
}));
import Panel from "../src/components/ReportPageAppend.vue";
const pages = [1, 2, 3].map((n) => ({
  id: `page-${n}`,
  name: "合成文件.pdf",
  fileId: "file",
  sourcePageNumber: n,
  rotation: 0,
  position: null,
  duplicate: false,
  hasPreview: true,
  ocrComplete: false,
}));
const batch = {
  id: "batch",
  state: "ready",
  phase: "prepare",
  published: false,
  error: null,
  conflicts: [],
  files: [
    {
      id: "file",
      name: "合成文件.pdf",
      size: 20,
      received: true,
      pageCount: 3,
    },
  ],
  pages,
};
let wrapper: ReturnType<typeof mount>;
const button = (label: string) =>
  label === "补充报告页"
    ? wrapper.get('button[aria-haspopup="dialog"]')
    : wrapper.findAll("button").find((b) => b.text().includes(label))!;
beforeEach(() => {
  config.global.stubs = { ...config.global.stubs, teleport: true };
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.admin = false;
  mocks.request.mockResolvedValue(null);
});
afterEach(() => {
  wrapper?.unmount();
  delete config.global.stubs.teleport;
  vi.useRealTimers();
});
it("allows PDF subset, ordering and rotation without changing old pages; failed submission keeps selections", async () => {
  mocks.request.mockImplementation(
    async (_path: string, options?: { method?: string }) => {
      if (options?.method === "POST") throw new Error("合成网络错误");
      return structuredClone(batch);
    },
  );
  wrapper = mount(Panel, { props: { reportId: "report", oldPageCount: 4 } });
  await flushPromises();
  await button("补充报告页").trigger("click");
  await flushPromises();
  expect(wrapper.text()).toContain("已有 4 页");
  expect(wrapper.text()).toContain("已选 3 页");
  await wrapper.findAll("input[type=checkbox]")[1]!.setValue(false);
  await wrapper.findAll('[aria-label="下移补充页"]')[0]!.trigger("click");
  await wrapper.findAll('[aria-label="旋转补充页"]')[0]!.trigger("click");
  await button("补充并识别").trigger("click");
  await flushPromises();
  const call = mocks.request.mock.calls.find((c) => c[0].endsWith("/submit"))!;
  expect(JSON.parse(call[1].body).pages).toEqual([
    { id: "page-3", rotation: 90 },
    { id: "page-1", rotation: 0 },
  ]);
  expect(wrapper.text()).toContain("合成网络错误");
  expect(wrapper.text()).toContain("已选 2 页");
  expect(wrapper.text()).toContain("90°");
  if (process.env.ISSUE40_VISUAL === "1") {
    const css = readFileSync("packages/ui/src/styles.css", "utf8");
    const component = readFileSync(
      "packages/ui/src/components/ReportPageAppend.vue",
      "utf8",
    );
    const local =
      component.match(/<style scoped>([\s\S]*?)<\/style>/)?.[1] || "";
    const preview =
      "data:image/svg+xml," +
      encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" width="150" height="200"><rect width="150" height="200" fill="white"/><path d="M15 25h120M15 50h90M15 75h120M15 100h90M15 125h120" stroke="#c9cecc" stroke-width="5"/></svg>',
      );
    const html = wrapper.html().replace(/src="[^"]*"/g, `src="${preview}"`);
    for (const theme of ["light", "dark"])
      writeFileSync(
        `/tmp/issue40-append-${theme}.html`,
        `<!doctype html><html data-theme="${theme}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}\n${local}body{margin:0;padding:16px}.report-page-append{max-width:900px;margin:auto}</style><body>${html}</body></html>`,
      );
  }
});
it("pending conflicts require explicit confirmation and never submit automatically", async () => {
  mocks.request.mockResolvedValue({
    ...batch,
    state: "review",
    pages: pages.map((p, i) => ({ ...p, position: i })),
    conflicts: ["姓名不一致，请核对"],
  });
  wrapper = mount(Panel, { props: { reportId: "report", oldPageCount: 1 } });
  await flushPromises();
  await button("补充报告页").trigger("click");
  await flushPromises();
  expect(wrapper.text()).toContain("尚未加入正式报告");
  expect(
    mocks.request.mock.calls.filter((c) => c[1]?.method === "POST"),
  ).toHaveLength(0);
  await button("确认所选页属于当前报告").trigger("click");
  await flushPromises();
  expect(mocks.request.mock.calls.some((c) => c[0].endsWith("/confirm"))).toBe(
    true,
  );
});
it("reports AI failure honestly, preserves original pages, and allows ending with OCR only", async () => {
  mocks.request.mockResolvedValue({
    ...batch,
    state: "failed",
    published: true,
    error: "旧结果已保留",
  });
  wrapper = mount(Panel, { props: { reportId: "report", oldPageCount: 2 } });
  await flushPromises();
  await button("补充报告页").trigger("click");
  await flushPromises();
  expect(wrapper.text()).toContain("旧结果已保留");
  expect(wrapper.findAll("button").some((b) => b.text() === "放弃本批次")).toBe(
    false,
  );
  await button("保留原件与 OCR").trigger("click");
  await flushPromises();
  const call = mocks.request.mock.calls.find((c) => c[0].endsWith("/retry"))!;
  expect(JSON.parse(call[1].body)).toEqual({ keepOcr: true });
});
it("rejects oversized files locally and exposes no fnOS-specific controls in Docker", async () => {
  wrapper = mount(Panel, { props: { reportId: "report", oldPageCount: 1 } });
  await flushPromises();
  await button("补充报告页").trigger("click");
  await flushPromises();
  const file = new File(["test"], "large.png");
  Object.defineProperty(file, "size", { value: 41 * 1024 * 1024 });
  await wrapper
    .find("section")
    .trigger("drop", { dataTransfer: { files: [file] } });
  expect(wrapper.text()).toContain("超过 40 MB");
  expect(wrapper.text()).not.toContain("飞牛");
  expect(mocks.upload).not.toHaveBeenCalled();
});
it("unmount stops polling and ignores a delayed response", async () => {
  let resolve!: (value: unknown) => void;
  mocks.request.mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  wrapper = mount(Panel, { props: { reportId: "report", oldPageCount: 1 } });
  wrapper.unmount();
  resolve(batch);
  await flushPromises();
  await vi.advanceTimersByTimeAsync(10000);
  expect(mocks.request).toHaveBeenCalledTimes(1);
});

it("opens a teleported drawer, retains picked files after Escape and restores focus and scroll", async () => {
  wrapper = mount(Panel, {
    attachTo: document.body,
    props: { reportId: "report", oldPageCount: 2 },
    global: { stubs: { teleport: false } },
  });
  await flushPromises();
  const trigger = button("补充报告页");
  await trigger.trigger("click");
  await flushPromises();
  expect(document.body.style.overflow).toBe("hidden");
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
  expect(dialog.getAttribute("aria-modal")).toBe("true");
  expect(wrapper.element.contains(dialog)).toBe(false);
  expect(document.activeElement).toBe(dialog);
  const camera = dialog.querySelector<HTMLInputElement>(
    'input[capture="environment"]',
  )!;
  expect(camera.accept).toBe("image/*");
  const input = dialog.querySelector<HTMLInputElement>("input[multiple]")!;
  Object.defineProperty(input, "files", {
    value: [new File(["synthetic"], "synthetic.png", { type: "image/png" })],
  });
  input.dispatchEvent(new Event("change", { bubbles: true }));
  await flushPromises();
  document.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
  );
  await flushPromises();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.body.style.overflow).toBe("");
  expect(document.activeElement).toBe(trigger.element);
  await trigger.trigger("click");
  await flushPromises();
  expect(document.querySelector('[role="dialog"]')!.textContent).toContain(
    "synthetic.png",
  );
  document
    .querySelector(".append-backdrop")!
    .dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await flushPromises();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

it("offers NAS import for an authorized directory and sends its selection to the append batch", async () => {
  mocks.admin = true;
  mocks.request.mockImplementation(async (path: string) =>
    path === "local-files"
      ? {
          roots: [{ id: "root", label: "授权目录" }],
          current: { rootId: "root", path: "" },
          entries: [
            {
              name: "synthetic.pdf",
              path: "synthetic.pdf",
              type: "file",
              size: 20,
            },
          ],
          availability: { message: null },
        }
      : path.endsWith("/import")
        ? structuredClone(batch)
        : null,
  );
  wrapper = mount(Panel, { props: { reportId: "report", oldPageCount: 2 } });
  await flushPromises();
  await button("补充报告页").trigger("click");
  await flushPromises();
  await button("从 NAS 导入").trigger("click");
  await flushPromises();
  await wrapper.get(".append-directory-entry input").setValue(true);
  await button("导入 1 个文件并预览").trigger("click");
  await flushPromises();
  expect(mocks.request).toHaveBeenCalledWith(
    "reports/report/page-appends/import",
    expect.objectContaining({
      method: "POST",
      body: expect.stringContaining("synthetic.pdf"),
    }),
  );
  expect(wrapper.findAll(".append-page-choice")).toHaveLength(3);
});

it("keeps the NAS entry visible without roots or after a directory request failure", async () => {
  mocks.admin = true;
  mocks.request.mockImplementation(async (path: string) => {
    if (path === "local-files") throw new Error("合成目录读取失败");
    return null;
  });
  wrapper = mount(Panel, { props: { reportId: "report", oldPageCount: 2 } });
  await flushPromises();
  await button("补充报告页").trigger("click");
  await flushPromises();
  expect(
    mocks.request.mock.calls.some(([path]) => path === "local-files"),
  ).toBe(false);
  await button("从 NAS 导入").trigger("click");
  await flushPromises();
  expect(wrapper.text()).toContain("合成目录读取失败");
  expect(button("从 NAS 导入").exists()).toBe(true);
  mocks.request.mockResolvedValue({
    roots: [],
    current: null,
    entries: [],
    availability: { message: "请先配置授权目录" },
  });
  await button("从 NAS 导入").trigger("click");
  await flushPromises();
  expect(wrapper.text()).toContain("请先配置授权目录");
  expect(button("重新读取目录").exists()).toBe(true);
  expect(wrapper.find(".append-nas-empty").exists()).toBe(true);
  expect(wrapper.text()).not.toContain("导入 0 个文件");
});

it("notifies the report of OCR, AI, failure, retry and completion even with the drawer closed", async () => {
  let state = "ocr";
  mocks.request.mockImplementation(async () => ({
    ...structuredClone(batch),
    state,
    published: state !== "ocr",
  }));
  wrapper = mount(Panel, { props: { reportId: "report", oldPageCount: 2 } });
  await flushPromises();
  expect(wrapper.find('[role="dialog"]').exists()).toBe(false);
  expect(wrapper.emitted("stateChanged")).toEqual([["ocr"]]);
  await vi.advanceTimersByTimeAsync(3000);
  await flushPromises();
  expect(wrapper.emitted("stateChanged")).toHaveLength(1);
  for (const next of ["ai", "failed", "ai", "normalizing", "complete"]) {
    state = next;
    await vi.advanceTimersByTimeAsync(3000);
    await flushPromises();
  }
  expect(wrapper.emitted("stateChanged")).toEqual([
    ["ocr"],
    ["ai"],
    ["failed"],
    ["ai"],
    ["normalizing"],
    ["complete"],
  ]);
  expect(wrapper.emitted("updated")).toHaveLength(2);
  const count = mocks.request.mock.calls.length;
  await vi.advanceTimersByTimeAsync(6000);
  expect(mocks.request).toHaveBeenCalledTimes(count);
});

it("shows completed-with-review warnings instead of claiming full extraction success", async () => {
  let state = "ai";
  mocks.request.mockImplementation(async () => ({
    ...structuredClone(batch),
    state,
    published: true,
    reviewWarnings:
      state === "complete"
        ? ["本次识别第 2 页有 1 项内容未完整匹配，请对照原件核对"]
        : [],
  }));
  wrapper = mount(Panel, { props: { reportId: "report", oldPageCount: 2 } });
  await flushPromises();
  await button("补充报告页").trigger("click");
  await flushPromises();
  state = "complete";
  await vi.advanceTimersByTimeAsync(3000);
  await flushPromises();
  expect(wrapper.text()).toContain("补页完成，部分内容待核对");
  expect(wrapper.text()).toContain("第 2 页");
  expect(wrapper.text()).not.toContain("补充与识别完成");
  expect(wrapper.emitted("stateChanged")?.at(-1)).toEqual(["complete_review"]);
});

it("shows OCR and AI progress and keeps the entry informative after closing the drawer", async () => {
  let next = {
    ...structuredClone(batch),
    state: "ocr",
    phase: "ocr",
    pages: pages.map((p) => ({
      ...p,
      position: p.sourcePageNumber,
      ocrComplete: p.sourcePageNumber === 1,
    })),
    aiProgress: { completed: 0, total: 0 },
  };
  mocks.request.mockImplementation(async () => structuredClone(next));
  wrapper = mount(Panel, { props: { reportId: "report", oldPageCount: 2 } });
  await flushPromises();
  expect(button("补充报告页").text()).toContain("OCR中");
  await button("补充报告页").trigger("click");
  await flushPromises();
  expect(wrapper.text()).toContain("已识别 1 / 3 个补充页面");
  expect(wrapper.findAll(".append-steps li")).toHaveLength(4);
  next = {
    ...next,
    state: "ai",
    phase: "ai",
    aiProgress: { completed: 1, total: 3 },
  };
  await vi.advanceTimersByTimeAsync(3000);
  await flushPromises();
  expect(wrapper.text()).toContain("AI 已处理 1 / 3 组内容");
  await button("收起，后台继续处理").trigger("click");
  expect(wrapper.find('[role="dialog"]').exists()).toBe(false);
  expect(button("补充报告页").text()).toContain("AI整理中");
  next = { ...next, state: "complete", aiProgress: { completed: 3, total: 3 } };
  await vi.advanceTimersByTimeAsync(3000);
  await flushPromises();
  expect(button("补充报告页").text()).toContain("已完成");
  await button("补充报告页").trigger("click");
  await flushPromises();
  expect(wrapper.text()).toContain("补充页面与整理结果均已保存");
});

it("shows that ready pages still need submission and OCR-only does not mean AI completion", async () => {
  mocks.request.mockResolvedValue(structuredClone(batch));
  wrapper = mount(Panel, { props: { reportId: "report", oldPageCount: 2 } });
  await flushPromises();
  expect(button("补充报告页").text()).toContain("待提交");
  await button("补充报告页").trigger("click");
  await flushPromises();
  expect(wrapper.text()).toContain("才会加入当前报告并开始整理");
  expect(button("补充并识别").classes()).toContain("primary-button");
  mocks.request.mockResolvedValue({
    ...structuredClone(batch),
    state: "ocr_only",
    published: true,
  });
  await vi.advanceTimersByTimeAsync(3000);
  await flushPromises();
  expect(button("补充报告页").text()).toContain("待AI整理");
  expect(wrapper.text()).toContain("当前指标仍是上一版");
  expect(wrapper.text()).not.toContain("补充页面与整理结果均已保存");
});
