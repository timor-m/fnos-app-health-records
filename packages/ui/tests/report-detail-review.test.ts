import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { ref } from "vue";

vi.mock("../src/composables/useAppContext", () => ({
  useAppContext: () => ({
    session: ref({ authenticated: true, id: "user-admin", displayName: "管理员", isAdmin: false }),
    selectedMemberId: ref(null),
    allMembers: ref([{id:"m1",permission:"manager"}]),
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
  memberId:"m1",
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


it("refreshes jobs and report details when the append component announces a processing phase", async () => {
  const wrapper = mount(ReportDetail, {
    props: { reportId: "r1", variant: "panel" },
    global: { stubs: { teleport: true, RouterLink: true, ReportPageAppend: {
      emits: ["stateChanged"], template: `<button data-append-state @click="$emit('stateChanged', 'ocr')">补页阶段</button>`
    } } }
  });
  try {
    await flushPromises();await flushPromises();
    const jobsBefore=callsTo('jobs?reportId=r1').length;
    const detailsBefore=fetchMock.mock.calls.filter(([input])=>String(input).endsWith('/api/reports/r1')).length;
    await wrapper.get('[data-append-state]').trigger('click');await flushPromises();await flushPromises();
    expect(wrapper.get('#report-processing-section').text()).toContain('正在识别补充页面（OCR）');
    expect(callsTo('jobs?reportId=r1').length).toBeGreaterThan(jobsBefore);
    expect(fetchMock.mock.calls.filter(([input])=>String(input).endsWith('/api/reports/r1')).length).toBeGreaterThan(detailsBefore);
  } finally { wrapper.unmount(); }
});

describe('重复报告当前暂停状态',()=>{
 async function mountDuplicate(valid=true,memberId='m1') {
  let continued=false;
  fetchMock.mockImplementation(async (input:RequestInfo|URL)=>{
   const url=String(input);
   if(url.endsWith('/duplicate-continue')) {continued=true;return jsonResponse({id:'synthetic-job',status:'queued'});}
   if(url.endsWith('/api/reports/r1')) return jsonResponse({...detailPayload,memberId,status:'needs_review',observations:[],duplicatePause:continued?null:{valid,state:valid?'paused':'expired',targetId:'r2',reason:'与已有报告的完整原件一致，已暂缓 AI 整理。',ruleId:'R0',ruleVersion:'family-v2'}});
   if(url.includes('/original/status'))return jsonResponse({status:'ready'});
   if(url.includes('jobs'))return jsonResponse([]);
   if(url.endsWith('/notes'))return jsonResponse({notes:[],canManage:false});
   return jsonResponse({});
  });
  const wrapper=mount(ReportDetail,{attachTo:document.body,props:{reportId:'r1',variant:'panel'},global:{stubs:{teleport:true,RouterLink:true}}});
  await flushPromises();await flushPromises();return wrapper;
 }
 it('显示当前暂停，继续时不附带排除其他候选的请求',async()=>{
  const wrapper=await mountDuplicate();
  expect(wrapper.text()).toContain('与已有报告的完整原件一致');
  await wrapper.findAll('button').find(b=>b.text()==='仍然继续整理')!.trigger('click');await flushPromises();
  const call=callsTo('duplicate-continue')[0];expect(JSON.parse((call[1] as RequestInit).body as string)).toEqual({});
  expect(wrapper.text()).not.toContain('与已有报告的完整原件一致');wrapper.unmount();
 });
 it('不是重复并继续只发送当前报告对',async()=>{
  const wrapper=await mountDuplicate();await wrapper.findAll('button').find(b=>b.text()==='不是重复并继续整理')!.trigger('click');await flushPromises();
  expect(JSON.parse((callsTo('duplicate-continue')[0][1] as RequestInit).body as string)).toEqual({distinctTarget:'r2'});wrapper.unmount();
 });
 it('失效暂停不会显示仍被拦截，无管理权限不显示继续按钮',async()=>{
  const wrapper=await mountDuplicate(false,'unmanaged');expect(wrapper.text()).toContain('原先暂停已失效');
  expect(wrapper.text()).not.toContain('与已有报告的完整原件一致');expect(wrapper.findAll('button').some(b=>b.text()==='仍然继续整理')).toBe(false);wrapper.unmount();
 });
});
