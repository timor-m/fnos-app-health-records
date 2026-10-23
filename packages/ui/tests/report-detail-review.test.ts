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
  sourceVersion: 7,
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
  it('shows a compact direction warning only for stale pages without opening the original viewer', async () => {
    const pages = [1, 2].map(pageNumber => ({
      id: `p${pageNumber}`, reportId: 'r1', pageNumber, mimeType: 'image/png',
      hasThumbnail: true, rotation: pageNumber === 2 ? 90 : 0, ocrStale: pageNumber === 2
    }));
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/reports/r1')) return jsonResponse({ ...detailPayload, pages });
      if (url.includes('/original/status')) return jsonResponse({ status: 'ready' });
      if (url.includes('jobs')) return jsonResponse([]);
      return jsonResponse({});
    });
    const wrapper = mount(ReportDetail, {
      attachTo: document.body, props: { reportId: 'r1', variant: 'panel' },
      global: { stubs: { RouterLink: true, ReportNotesPanel: true, ReportPageAppend: true } }
    });
    try {
      await flushPromises(); await flushPromises();
      const cards = wrapper.findAll('.original-tile-card');
      expect(cards[0]!.find('.original-orientation-warning').exists()).toBe(false);
      const warning = cards[1]!.get('.original-orientation-warning');
      expect(warning.attributes('aria-label')).toBe('查看第 2 页方向调整说明');
      expect(cards[1]!.find('.preview-hint').exists()).toBe(false);
      expect(document.querySelector('button button')).toBeNull();
      expect(document.querySelector('.indicator-hint-panel')).toBeNull();
      await warning.trigger('click'); await flushPromises();
      expect(document.querySelector('.indicator-hint-panel')?.textContent).toContain('缺少可靠的 OCR 位置');
      expect(document.querySelector('.original-viewer')).toBeNull();
      await warning.trigger('focusout', { relatedTarget: null });
      expect(document.querySelector('.indicator-hint-panel')).toBeNull();
      const anchor = cards[1]!.get('.indicator-hint-anchor');
      await anchor.trigger('mouseenter');
      await warning.trigger('click');
      expect(document.querySelector('.indicator-hint-panel')).not.toBeNull();
      await anchor.trigger('mouseleave');
      expect(document.querySelector('.indicator-hint-panel')).toBeNull();
    } finally { wrapper.unmount(); }
  });

  it.each(['image/png', 'application/pdf'])('restores OCR overlays and removes a healed warning for %s without rotating the PDF twice', async mimeType => {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    const pdf = mimeType === 'application/pdf';
    const page = { id: 'p1', reportId: 'r1', pageNumber: 1, mimeType, hasThumbnail: true, rotation: 90, ocrStale: true };
    const coords = pdf ? { coordWidth: 300, coordHeight: 200, box: [240, 10, 280, 40] } : { coordWidth: 200, coordHeight: 300, box: [10, 20, 40, 60] };
    const dimensions = [
      vi.spyOn(HTMLImageElement.prototype, 'naturalWidth', 'get').mockReturnValue(coords.coordWidth),
      vi.spyOn(HTMLImageElement.prototype, 'naturalHeight', 'get').mockReturnValue(coords.coordHeight),
      vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(200),
      vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(300)
    ];
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/reports/r1')) return jsonResponse({ ...detailPayload, pages: [page] });
      if (url.endsWith('/pages/p1/ocr')) return jsonResponse({
        pageId: 'p1', pageNumber: 1, orientationChanged: false,
        coordWidth: coords.coordWidth, coordHeight: coords.coordHeight,
        lines: [{ id: 'stable-line', text: '合成文字', confidence: 0.96, box: coords.box }]
      });
      if (url.includes('/original/status')) return jsonResponse({ status: 'ready' });
      if (url.includes('jobs')) return jsonResponse([]);
      if (url.endsWith('/ocr')) return jsonResponse([]);
      return jsonResponse({});
    });
    const wrapper = mount(ReportDetail, {
      attachTo: document.body, props: { reportId: 'r1', variant: 'panel' },
      global: { stubs: { teleport: true, transition: false, RouterLink: true, ReportNotesPanel: true, ReportPageAppend: true } }
    });
    try {
      await flushPromises(); await flushPromises();
      expect(wrapper.find('.original-orientation-warning').exists()).toBe(true);
      await wrapper.findAll('button').find(button => button.text() === '校对字段')!.trigger('click');
      await flushPromises(); await flushPromises();
      expect(wrapper.find('.original-orientation-warning').exists()).toBe(false);
      const image = wrapper.get('.edit-original-image-wrapper img');
      await image.trigger('load');
      await flushPromises();
      const toggle = wrapper.findAll('.edit-original-actions button').find(button => button.text().includes('OCR'))!;
      expect(toggle.attributes('disabled')).toBeUndefined();
      await toggle.trigger('click'); await flushPromises();
      expect(wrapper.get('.ocr-text-line').text()).toBe('合成文字');
      const line = wrapper.get('.ocr-text-line').element as HTMLElement;
      expect(line.style.left).toBe(pdf ? '80%' : '5%');
      expect(line.style.top).toBe(pdf ? '5%' : `${20 / 300 * 100}%`);
      expect(wrapper.get('.edit-original-page .original-orientation-content').attributes('style')).toContain(`rotate(${pdf ? 0 : 90}deg)`);
      expect(wrapper.text()).not.toContain('标记暂不可用');
    } finally { wrapper.unmount(); dimensions.forEach(mock => mock.mockRestore()); }
  });

  it('ignores a pending OCR response from before a saved page rotation', async () => {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    let rotation = 0;
    let resolveOcr!: (response: Response) => void;
    const page = () => ({ id: 'p1', reportId: 'r1', pageNumber: 1, mimeType: 'image/png', hasThumbnail: true, rotation, ocrStale: false });
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/pages/p1/ocr')) return new Promise<Response>(resolve => { resolveOcr = resolve; });
      if (url.endsWith('/pages/p1/rotation') && init?.method === 'PUT') {
        rotation = 90;
        return jsonResponse({ ...detailPayload, pages: [page()] });
      }
      if (url.endsWith('/api/reports/r1')) return jsonResponse({ ...detailPayload, pages: [page()] });
      if (url.includes('jobs') || url.endsWith('/ocr')) return jsonResponse([]);
      return jsonResponse({});
    });
    const wrapper = mount(ReportDetail, {
      attachTo: document.body, props: { reportId: 'r1', variant: 'panel' },
      global: { stubs: { teleport: true, RouterLink: true, ReportNotesPanel: true, ReportPageAppend: true } }
    });
    try {
      await flushPromises(); await flushPromises();
      await wrapper.findAll('button').find(button => button.text() === '校对字段')!.trigger('click');
      await flushPromises();
      await wrapper.get('.report-edit-backdrop button[title="关闭"]').trigger('click');
      await wrapper.get('.page-edit-actions button[title^="保存页面方向"]').trigger('click');
      await flushPromises();
      resolveOcr(jsonResponse({ pageId: 'p1', pageNumber: 1, orientationChanged: true, coordWidth: null, coordHeight: null, lines: [] }));
      await flushPromises(); await flushPromises();
      expect(rotation).toBe(90);
      expect(wrapper.find('.original-orientation-warning').exists()).toBe(false);
      expect(callsTo('/pages/p1/ocr')).toHaveLength(1);
    } finally { wrapper.unmount(); }
  });

  it('报告字段保存携带打开编辑器时的版本，冲突时保留输入', async () => {
    let version = 7;
    fetchMock.mockImplementation(async (input:RequestInfo|URL,init?:RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/reports/r1') && init?.method === 'PUT') {
        return new Response(JSON.stringify({error:true,message:'报告已更新，请刷新后重新校对，当前输入尚未保存'}),{status:409,headers:{'content-type':'application/json'}});
      }
      if (url.endsWith('/api/reports/r1')) return jsonResponse({...detailPayload,sourceVersion:version});
      if (url.includes('jobs')) return jsonResponse([]);
      return jsonResponse({});
    });
    const wrapper = mount(ReportDetail,{attachTo:document.body,props:{reportId:'r1',variant:'panel'},global:{stubs:{teleport:true,RouterLink:true,ReportNotesPanel:true,ReportPageAppend:{emits:['stateChanged'],template:'<button data-refresh @click="$emit(\'stateChanged\', \'ocr\')">Refresh</button>'}}}});
    try {
      await flushPromises(); await flushPromises();
      await wrapper.findAll('button').find(button => button.text() === '校对字段')!.trigger('click');
      await flushPromises();
      await wrapper.get('.report-edit-form input').setValue('合成新标题');
      version = 8;
      await wrapper.get('[data-refresh]').trigger('click'); await flushPromises(); await flushPromises();
      await wrapper.get('.report-edit-form').trigger('submit'); await flushPromises();
      const call = fetchMock.mock.calls.find(([input,init]) => String(input).endsWith('/api/reports/r1') && init?.method === 'PUT')!;
      expect(JSON.parse(call[1].body)).toMatchObject({title:'合成新标题',expectedSourceVersion:7});
      expect(wrapper.get('.report-edit-form').text()).toContain('报告已更新');
      expect((wrapper.get('.report-edit-form input').element as HTMLInputElement).value).toBe('合成新标题');
    } finally {wrapper.unmount();}
  });

  it('只展示当前待核对指标，不把历史整理诊断当作报告现状', async () => {
    let reviewed = false;
    fetchMock.mockImplementation(async (input:RequestInfo|URL,init?:RequestInit) => {
      const url = String(input);
      if (url.endsWith('/observations/obs-1') && init?.method === 'PUT') reviewed = true;
      if (url.endsWith('/api/reports/r1') || url.endsWith('/observations/obs-1')) return jsonResponse({...detailPayload,observations:[{...observation,requiresVisualReview:!reviewed,manualReviewed:reviewed}]});
      if (url.includes('jobs')) return jsonResponse([{id:'ai',reportId:'r1',jobType:'ai_extract',status:'completed',createdAt:'2026-01-01',batchId:'batch',batchKind:'manual_ai',batchStartedAt:'2026-01-01',batchSequence:1,unmatchedCandidates:11,layoutWarnings:[{pageNumber:1,pendingVisualResults:1,uncertainRows:1,ocrUnresolved:2,ocrUnretried:1}]}]);
      if (url.includes('indicator-catalog')) return jsonResponse([]);
      return jsonResponse({});
    });
    const wrapper = mount(ReportDetail,{attachTo:document.body,props:{reportId:'r1',variant:'panel'},global:{stubs:{teleport:true,RouterLink:true,ReportNotesPanel:true}}});
    try {
      await flushPromises(); await flushPromises();
      expect(wrapper.text()).toContain('1 个指标需对照原图核对');
      expect(wrapper.text()).not.toContain('11 个原文候选');
      expect(wrapper.text()).not.toContain('行列归属不明');
      await wrapper.findAll('button').find(button => button.text().includes('查看全部'))!.trigger('click'); await flushPromises();
      await wrapper.get('.observation-all-list [title="编辑指标"]').trigger('click'); await flushPromises();
      await wrapper.get('.observation-editor-form').trigger('submit'); await flushPromises(); await flushPromises();
      expect(reviewed).toBe(true);
      expect(wrapper.text()).not.toContain('1 个指标需对照原图核对');
      expect(wrapper.find('.extraction-unmatched-hint').exists()).toBe(false);
    } finally {wrapper.unmount();}
  });

  it("在全部指标显示同名多时间结果，选择时定位来源而不打开编辑",async()=>{
    fetchMock.mockImplementation(async(input:RequestInfo|URL)=>{
      const url=String(input);
      if(url.endsWith('/api/reports/r1'))return jsonResponse({...detailPayload,observations:[
        {...observation,id:'obs-1',examinationId:'e1',examinationTime:'2026-09-01'},
        {...observation,id:'obs-2',examinationId:'e2',examinationTime:'2026-09-08'}
      ]});
      if(url.includes('jobs'))return jsonResponse([]);
      return jsonResponse({});
    });
    const wrapper=mount(ReportDetail,{attachTo:document.body,props:{reportId:'r1',variant:'panel'},global:{stubs:{teleport:true,RouterLink:true,ReportNotesPanel:true}}});
    await flushPromises();await flushPromises();
    expect(wrapper.find('.examinations-panel').exists()).toBe(false);
    const all=wrapper.findAll('button').find(button=>button.text().includes('查看全部'))!;
    await all.trigger('click');await flushPromises();
    expect(wrapper.find('.observation-panel .observation-title .observation-source-label').text()).toBe('P?·2026-09-01');
    expect(wrapper.text()).toContain('2026-09-08');
    const cards=wrapper.findAll('.observation-all-list .observation-list article');
    expect(cards).toHaveLength(2);await cards[1].trigger('click');
    expect(cards[1]!.find('.observation-title .observation-source-label').text()).toBe('P?·2026-09-08');
    expect(cards[1]!.find('.observation-meta .observation-source-label').exists()).toBe(false);
    expect(wrapper.find('.observation-edit-panel.is-open').exists()).toBe(false);
    expect(wrapper.text()).toContain('来源报告页');
    wrapper.unmount();
  });

  it("在名称右侧紧凑显示来源页与检查日期", async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/reports/r1")) return jsonResponse({
        ...detailPayload,
        pages: [{ id: "p1", pageNumber: 1, mimeType: "image/jpeg", hasThumbnail: false }],
        observations: [{ ...observation, examinationId: "e1", examinationTime: "2026-07-13 08:30", evidence: { pageId: "p1" } }]
      });
      if (url.includes("jobs")) return jsonResponse([]);
      return jsonResponse({});
    });
    const wrapper = mount(ReportDetail, {
      props: { reportId: "r1", variant: "panel" },
      global: { stubs: { teleport: true, RouterLink: true, ReportNotesPanel: true } }
    });
    await flushPromises();
    expect(wrapper.find(".observation-panel .observation-title .observation-source-label").text()).toBe("P1·2026-07-13");
    expect(wrapper.find(".observation-panel .observation-meta .observation-source-label").exists()).toBe(false);
    wrapper.unmount();
  });

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
    expect(wrapper.find('.report-append-notice').exists()).toBe(false);
    expect(wrapper.get('#report-processing-section').text()).not.toContain('正在识别补充页面（OCR）');
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
   if(url.endsWith('/examinations'))return jsonResponse({version:0,reportVersion:0,examinations:[],observations:[]});
   return jsonResponse({});
  });
  const wrapper=mount(ReportDetail,{attachTo:document.body,props:{reportId:'r1',variant:'panel'},global:{stubs:{teleport:true,RouterLink:true,ReportNotesPanel:true}}});
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

it('does not show withdrawn extraction values or ask users to compare them',async()=>{
  const previous={itemName:'合成旧项',itemCode:null,sectionName:null,resultText:'12',unit:'U/L',pageNumber:null,sourceLineIds:[],sourceText:'合成旧项 12 U/L',reason:'本次未能核实'};
  fetchMock.mockImplementation(async(input:RequestInfo|URL,init?:RequestInit)=>{
    const url=String(input);
    if(url.endsWith('/api/reports/r1'))return jsonResponse({...detailPayload,observations:[],unverifiedPreviousObservations:[previous]});
    if(url.includes('jobs')||url.includes('indicator-catalog'))return jsonResponse([]);
    return jsonResponse({});
  });
  const wrapper=mount(ReportDetail,{attachTo:document.body,props:{reportId:'r1',variant:'panel'},global:{stubs:{teleport:true,RouterLink:true,ReportNotesPanel:true,ReportPageAppend:true}}});
  try{
    await flushPromises();await flushPromises();
    expect(wrapper.find('.extraction-comparison').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('上次识别对照');
    expect(wrapper.text()).not.toContain('合成旧项');
    expect(wrapper.text()).not.toContain('对照后补录');
    expect(wrapper.find('.observation-editor-form').exists()).toBe(false);
    expect(fetchMock.mock.calls.some(([,init])=>init?.method==='POST')).toBe(false);
  }finally{wrapper.unmount();}
});

it('shows all tiers by original page and submits a page-bound supplement through the existing form', async () => {
  const pages=[1,2].map(pageNumber=>({id:`p${pageNumber}`,pageNumber,mimeType:'image/png',hasThumbnail:false,rotation:0}));
  const payload={...detailPayload,pages,observations:[
    {...observation,id:'late',itemName:'合成下行',displayTier:'primary',evidence:{pageId:'p1',lineIds:['late'],sourceText:''}},
    {...observation,id:'early',itemName:'合成上行',evidence:{pageId:'p1',lineIds:['early'],sourceText:''}}
  ]};
  fetchMock.mockImplementation(async (input:RequestInfo|URL, init?:RequestInit)=>{
    const url=String(input);
    if(url.endsWith('/api/reports/r1') || init?.method==='POST')return jsonResponse(payload);
    if(url.endsWith('/p1/ocr'))return jsonResponse({pageId:'p1',lines:[{id:'early',box:[10,10,200,20]},{id:'late',box:[10,50,200,60]}]});
    if(url.endsWith('/p2/ocr'))return jsonResponse({pageId:'p2',lines:[]});
    if(url.includes('jobs'))return jsonResponse([]);
    return jsonResponse({});
  });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const wrapper=mount(ReportDetail,{attachTo:document.body,props:{reportId:'r1',reviewObservationId:'late',variant:'panel'},global:{stubs:{teleport:true,RouterLink:true}}});
  await flushPromises();await flushPromises();
  try {
    await wrapper.get('.observation-source-image-wrapper img').trigger('load');await flushPromises();
    const buttons=()=>wrapper.get('[aria-label="指标查看方式"]').findAll('button');
    expect(buttons().map(button=>button.text())).toEqual(['分类查看','原文顺序']);
    expect(buttons()[0].attributes('aria-pressed')).toBe('true');
    await buttons()[1].trigger('click');await flushPromises();await flushPromises();
    expect(buttons()[1].attributes('aria-pressed')).toBe('true');
    expect(buttons()[0].attributes('aria-pressed')).toBe('false');
    await buttons()[0].trigger('click');await flushPromises();
    expect(wrapper.text()).toContain('可用于趋势的指标');
    expect(buttons()[0].attributes('aria-pressed')).toBe('true');
    await buttons()[1].trigger('click');await flushPromises();
    const sections=wrapper.findAll('.observation-tier-section');
    expect(sections.map(section=>section.find('header strong').text())).toEqual(['第 1 页','第 2 页']);
    expect(sections[0].findAll('.observation-title strong').map(node=>node.text())).toEqual(['合成上行','合成下行']);
    expect(sections[0].text()).toContain('可用于趋势');
    expect(sections.every(section=>!section.find('header button').exists())).toBe(true);
    await wrapper.get('.observation-source-nav button[title="下一页"]').trigger('click');await flushPromises();
    expect(wrapper.findAll('.observation-add-button')).toHaveLength(1);
    expect(wrapper.get('.observation-add-button').text()).toBe('补充指标');
    await wrapper.get('.observation-add-button').trigger('click');await flushPromises();
    expect(wrapper.get('.observation-add-modal').attributes('role')).toBe('dialog');
    expect(wrapper.get('.observation-add-modal').attributes('aria-label')).toBe('补充指标');
    expect(wrapper.get('.observation-add-backdrop').exists()).toBe(true);
    expect(wrapper.find('.observation-edit-shade').exists()).toBe(false);
    expect(wrapper.findAllComponents({name:'FormSelect'}).find(component=>component.props('ariaLabel')==='补充指标来源页')!.props('modelValue')).toBe('p2');
    await wrapper.findAll('button').find(button=>button.attributes('title')==='取消编辑')!.trigger('click');await flushPromises();
    await buttons()[0].trigger('click');await flushPromises();
    await wrapper.get('.observation-add-button').trigger('click');await flushPromises();
    const sourceSelect=wrapper.findAllComponents({name:'FormSelect'}).find(component=>component.props('ariaLabel')==='补充指标来源页')!;
    expect(sourceSelect.props('modelValue')).toBe('p2');
    const name=wrapper.findAll('.observation-core-fields label').find(node=>node.text()==='指标名称')!.get('input');
    await name.setValue('合成补充项目');
    await wrapper.get('.observation-editor-form').trigger('submit');await flushPromises();
    const saved=callsTo('/observations').find(([,init])=>init?.method==='POST');
    expect(JSON.parse(saved![1].body)).toMatchObject({itemName:'合成补充项目',sourcePageId:'p2',expectedSourceVersion:7});
  } finally {wrapper.unmount();}
});

it('teleports only supplementation into a separate dialog and returns editing to the existing column', async()=>{
 vi.stubGlobal('ResizeObserver',class{observe(){}disconnect(){}});
 const payload={...detailPayload,pages:[{id:'p1',pageNumber:1,mimeType:'image/png',hasThumbnail:false,rotation:0}],observations:[{...observation,evidence:{pageId:'p1',lineIds:[],region:[.1,.2,.3,.4],sourceText:''}}]};
 fetchMock.mockImplementation(async(input:RequestInfo|URL)=>String(input).endsWith('/api/reports/r1')?jsonResponse(payload):jsonResponse([]));
 const wrapper=mount(ReportDetail,{attachTo:document.body,props:{reportId:'r1',reviewObservationId:'obs-1',variant:'panel'},global:{stubs:{RouterLink:true}}});
 try {
  await flushPromises();await flushPromises();
  expect(document.querySelector('.observation-all-layout .observation-edit-panel.is-open')).not.toBeNull();
  expect(document.querySelector('.observation-edit-panel .source-region-picker')).toBeNull();
  expect(document.querySelector('[aria-label="补充指标来源页"]')).toBeNull();
  (document.querySelector('.observation-add-button') as HTMLButtonElement).click();await flushPromises();
  const dialog=document.querySelector('[role="dialog"][aria-label="补充指标"]')!;
  expect(dialog).not.toBeNull();
  expect(dialog.closest('.observation-all-layout')).toBeNull();
  expect(dialog.querySelector('.source-region-picker')).not.toBeNull();
  expect(dialog.querySelector('[aria-label="补充指标来源页"]')).not.toBeNull();
  expect(document.querySelectorAll('.observation-editor-form')).toHaveLength(1);
  dialog.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await flushPromises();
  expect(document.querySelector('.observation-add-modal')).toBeNull();
  expect(wrapper.emitted('close')).toBeUndefined();
  (document.querySelector('button[title="编辑指标"]') as HTMLButtonElement).click();await flushPromises();
  expect(document.querySelector('.observation-all-layout .observation-edit-panel.is-open')).not.toBeNull();
  expect(document.querySelector('.observation-edit-panel .source-region-picker')).toBeNull();
  expect(document.querySelector('[aria-label="补充指标来源页"]')).toBeNull();
  expect(document.querySelector('.observation-add-backdrop')).toBeNull();
 } finally {wrapper.unmount();}
});
