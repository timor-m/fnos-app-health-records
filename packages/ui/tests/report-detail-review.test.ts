import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { ref } from "vue";

vi.mock("../src/composables/useAppContext", () => ({
  useAppContext: () => ({
    session: ref({ id: "user-admin", displayName: "管理员", isAdmin: false }),
    selectedMemberId: ref(null),
    refreshReminderCount: vi.fn()
  })
}));
vi.mock("../src/composables/useConfirm", () => ({ useConfirm: () => ({ ask: vi.fn() }) }));
vi.mock("../src/composables/useToast", () => ({ useToast: () => ({ show: vi.fn() }) }));
vi.mock("../src/composables/useScrollLock", () => ({ useScrollLock: () => {} }));

import ReportDetail from "../src/components/ReportDetail.vue";

const observation = {
  id: "obs-1",
  sectionName: "血常规",
  itemCode: null,
  itemName: "嗜酸性细胞百分比",
  normalizedName: "嗜酸性细胞百分比",
  resultText: "5.2",
  numericValue: 5.2,
  unit: "%",
  referenceLow: null,
  referenceHigh: null,
  referenceText: "",
  abnormalFlag: "",
  abnormalReason: null,
  canonicalKey: null,
  canonicalName: null,
  canonicalUnit: null,
  manualCanonicalKey: null,
  manualReviewed: false,
  displayTier: "secondary",
  displayCategory: "medical_candidate",
  displayReason: "未命中指标字典",
  evidence: null
};

const detailPayload = {
  id: "r1",
  reportType: "checkup",
  status: "ready",
  title: "年度体检",
  observations: [observation],
  pages: [],
  morphologyFindings: [],
  diagnoses: [],
  medications: [],
  procedures: [],
  vaccinations: [],
  billingItems: [],
  billingSummary: null,
  structuredSections: [],
  duplicateCandidates: []
};

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify({ ok: status < 400, data }), {
    status,
    headers: { "content-type": "application/json" }
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

function callsTo(urlPart: string) {
  return fetchMock.mock.calls.filter(([input]) => String(input).includes(urlPart));
}

async function mountReview(reviewObservationId: string) {
  const wrapper = mount(ReportDetail, {
    attachTo: document.body,
    props: { reportId: "r1", reviewObservationId, variant: "panel" },
    global: { stubs: { teleport: true, RouterLink: true } }
  });
  await flushPromises();
  await flushPromises();
  return wrapper;
}

beforeEach(() => {
  fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/reports/r1/original/status")) return jsonResponse({ status: "ready" });
    if (url.includes("/api/reports/r1/indicator-catalog")) return jsonResponse([]);
    if (url.includes("/api/reports/r1/pages/")) return jsonResponse({ pageId: "p1", lines: [] });
    if (url.endsWith("/api/reports/r1")) return jsonResponse(detailPayload);
    if (url.includes("jobs")) return jsonResponse([]);
    return jsonResponse({}, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("ReportDetail 核对指标模式", () => {
  it("打开核对弹窗时直接展示编辑面板，且不查询任务进度", async () => {
    const wrapper = await mountReview("obs-1");
    expect(wrapper.find(".observation-edit-panel.is-open").exists()).toBe(true);
    expect(wrapper.text()).toContain("编辑指标");
    expect(callsTo("jobs").length).toBe(0);
    expect(callsTo("/api/reports/r1").filter(([input]) => String(input).endsWith("/api/reports/r1")).length).toBe(1);
    wrapper.unmount();
  });

  it("目标指标不存在时持续展示错误提示而不是空白弹窗", async () => {
    const wrapper = await mountReview("obs-missing");
    await flushPromises();
    expect(wrapper.find(".observation-review-loading").exists()).toBe(true);
    expect(wrapper.text()).toContain("该指标已不存在");
    expect(wrapper.find(".observation-edit-panel.is-open").exists()).toBe(false);
    wrapper.unmount();
  });
});
