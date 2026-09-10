<script setup lang="ts">
import { computed, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { CalendarDays, ChevronRight, CircleAlert, LoaderCircle, RefreshCw, Search } from "@lucide/vue";
import BackToTop from "../components/BackToTop.vue";
import DateTimePicker from "../components/DateTimePicker.vue";
import EmptyState from "../components/EmptyState.vue";
import FormSelect from "../components/FormSelect.vue";
import PullIndicator from "../components/PullIndicator.vue";
import ReportDetail from "../components/ReportDetail.vue";
import ReportDetailSheet from "../components/ReportDetailSheet.vue";
import { request } from "../utils/api";
import type { CursorPage, ReportDetail as ReportDetailType, ReportSummary, ReportSummaryStats } from "../types/api";
import { useAppContext } from "../composables/useAppContext";
import { usePullRefresh } from "../composables/usePullRefresh";
import { useRefreshOnActivate } from "../composables/useRefreshOnActivate";
import { useScrollLock } from "../composables/useScrollLock";
import { useToast } from "../composables/useToast";

type DuplicateCandidate = ReportDetailType["duplicateCandidates"][number];

const app = useAppContext();
const route = useRoute();
const router = useRouter();
const PAGE_SIZE = 20;
const loading = ref(true);
const loadingMore = ref(false);
const reports = ref<ReportSummary[]>([]);
const nextCursor = ref<string | null>(null);
const hasMore = ref(false);
const loadError = ref("");
const loadMoreError = ref("");
const summaryStats = ref<ReportSummaryStats | null>(null);
const query = ref("");
const ocrQuery = ref("");
const typeFilter = ref("all");
const statusFilter = ref("all");
const dateFrom = ref("");
const dateTo = ref("");
const sortFilter = ref("report_date_desc");
const selectedId = ref("");
const mobileDetailOpen = ref(false);
useScrollLock(computed(() => mobileDetailOpen.value));
let listSeq = 0;
let loadMoreObserver: IntersectionObserver | null = null;
let pendingRouteReportId = "";
let searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;

const filtered = computed(() => {
  const keyword = query.value.trim().toLocaleLowerCase();
  if (!keyword) return reports.value;
  return reports.value.filter((report) =>
    [report.title, report.hospitalName, report.departmentName, report.bodyPart]
      .some((value) => value?.toLocaleLowerCase().includes(keyword))
  );
});
const recordCountSubtitle = computed(() => {
  if (loading.value && !reports.value.length) return "";
  const totalReports = summaryStats.value?.totalReports ?? reports.value.length;
  const totalPages = summaryStats.value?.totalPages ?? reports.value.reduce((sum, report) => sum + report.pageCount, 0);
  if (!totalReports) return "";
  return `共 ${totalReports} 份报告${totalPages ? ` · ${totalPages} 页原件` : ""}`;
});
const selected = computed(() => filtered.value.find((report) => report.id === selectedId.value) || null);

const typeLabels: Record<string, string> = {
  checkup: "体检", laboratory: "检验", imaging: "影像", functional: "功能检查", pathology: "病理",
  outpatient: "门诊", inpatient: "住院", prescription: "处方", billing: "票据", vaccination: "疫苗", other: "其他"
};
const statusMeta: Record<string, { label: string; chip: string }> = {
  uploading: { label: "上传中", chip: "chip--info" },
  queued: { label: "排队中", chip: "chip--info" },
  processing: { label: "处理中", chip: "chip--info" },
  needs_review: { label: "待确认", chip: "chip--amber" },
  ready: { label: "已归档", chip: "chip--green" },
  failed: { label: "识别失败", chip: "chip--red" },
  trashed: { label: "回收站", chip: "chip--plain" }
};
const typeOptions = [
  { value: "all", label: "全部类型" },
  ...Object.entries(typeLabels).map(([value, label]) => ({ value, label }))
];
const statusOptions = [
  { value: "all", label: "全部状态" },
  { value: "unfiled", label: "待识别" },
  { value: "needs_review", label: "待确认" },
  { value: "ready", label: "已归档" },
  { value: "processing", label: "处理中" },
  { value: "queued", label: "排队中" },
  { value: "failed", label: "识别失败" }
];
const sortOptions = [
  { value: "report_date_desc", label: "报告日期从新到旧" },
  { value: "report_date_asc", label: "报告日期从旧到新" },
  { value: "created_desc", label: "上传时间从新到旧" }
];
const allowedStatusFilters = new Set(statusOptions.map((item) => item.value));

function typeLabel(reportType: string) {
  return typeLabels[reportType] || "其他";
}

function metaLine(report: ReportSummary) {
  return [report.hospitalName, report.departmentName, report.bodyPart].filter(Boolean).join(" · ") || "信息待整理";
}

function buildReportParams(memberId: string, cursor?: string | null, limit = PAGE_SIZE) {
  const params = new URLSearchParams({ limit: String(limit), memberId });
  if (cursor) params.set("cursor", cursor);
  if (query.value.trim()) params.set("q", query.value.trim());
  if (ocrQuery.value.trim()) params.set("ocr", ocrQuery.value.trim());
  if (typeFilter.value !== "all") params.set("type", typeFilter.value);
  if (statusFilter.value !== "all") params.set("status", statusFilter.value);
  if (dateFrom.value) params.set("dateFrom", dateFrom.value);
  if (dateTo.value) params.set("dateTo", dateTo.value);
  if (sortFilter.value !== "report_date_desc") params.set("sort", sortFilter.value);
  return params;
}

function syncFiltersFromRoute() {
  const routeStatus = typeof route.query.status === "string" ? route.query.status : "all";
  statusFilter.value = allowedStatusFilters.has(routeStatus) ? routeStatus : "all";
}

function applyPendingRouteSelection() {
  if (!pendingRouteReportId || !reports.value.some((report) => report.id === pendingRouteReportId)) return false;
  selectedId.value = pendingRouteReportId;
  pendingRouteReportId = "";
  return true;
}

function syncSelectedReportInRoute(reportId: string) {
  if (route.query.reportId === reportId) return;
  void router.replace({ query: { ...route.query, reportId } })
    .catch((cause) => console.warn("[health-records] 同步当前报告地址失败", cause));
}

function selectReport(report: ReportSummary) {
  pendingRouteReportId = "";
  selectedId.value = report.id;
  syncSelectedReportInRoute(report.id);
  if (window.matchMedia("(max-width: 760px)").matches) mobileDetailOpen.value = true;
}

function openDuplicateCandidate(candidate: DuplicateCandidate) {
  if (!reports.value.some((report) => report.id === candidate.id)) {
    reports.value = [candidate, ...reports.value];
  }
  pendingRouteReportId = "";
  selectedId.value = candidate.id;
  syncSelectedReportInRoute(candidate.id);
}

function closeMobileDetail() {
  mobileDetailOpen.value = false;
}

async function load(memberId: string, silent = false, limit = PAGE_SIZE) {
  const seq = ++listSeq;
  if (!silent) loading.value = true;
  loadError.value = "";
  loadMoreError.value = "";
  try {
    const params = buildReportParams(memberId, null, limit);
    const [page, stats] = await Promise.all([
      request<CursorPage<ReportSummary>>(`reports?${params.toString()}`),
      request<ReportSummaryStats>(`reports/summary?memberId=${encodeURIComponent(memberId)}`)
    ]);
    if (seq !== listSeq) return;
    reports.value = page.items;
    nextCursor.value = page.nextCursor;
    hasMore.value = page.hasMore;
    summaryStats.value = stats;
    /* URL 中的 reportId 只在路由进入/变化时消费一次，后台刷新不能把用户刚切换的报告改回旧值 */
    if (applyPendingRouteSelection()) return;
    if (!reports.value.some((report) => report.id === selectedId.value)) {
      selectedId.value = reports.value[0]?.id || "";
    }
  } catch (cause) {
    if (seq === listSeq && !silent) loadError.value = cause instanceof Error ? cause.message : "档案加载失败";
    throw cause;
  } finally {
    if (seq === listSeq && !silent) loading.value = false;
  }
}

function retryLoad() {
  const memberId = app.selectedMemberId.value;
  if (memberId) load(memberId).catch(() => {});
}

async function loadMoreReports() {
  const memberId = app.selectedMemberId.value;
  if (!memberId || loading.value || loadingMore.value || !hasMore.value || !nextCursor.value) return;
  const seq = listSeq;
  loadingMore.value = true;
  loadMoreError.value = "";
  try {
    const params = buildReportParams(memberId, nextCursor.value);
    const page = await request<CursorPage<ReportSummary>>(`reports?${params.toString()}`);
    if (seq !== listSeq) return;
    const seen = new Set(reports.value.map((report) => report.id));
    reports.value = [
      ...reports.value,
      ...page.items.filter((report) => !seen.has(report.id))
    ];
    nextCursor.value = page.nextCursor;
    hasMore.value = page.hasMore;
  } catch (cause) {
    if (seq === listSeq) loadMoreError.value = cause instanceof Error ? cause.message : "加载更多失败";
  } finally {
    if (seq === listSeq) loadingMore.value = false;
  }
}

async function reloadList() {
  const memberId = app.selectedMemberId.value;
  /* 静默刷新按已加载条数一次性取回（服务端上限 50），避免列表塌回第一页导致滚动位置跳动 */
  if (!memberId) return;
  try {
    await load(memberId, true, Math.min(50, Math.max(PAGE_SIZE, reports.value.length)));
  } catch (cause) {
    console.warn("[health-records] 档案列表后台刷新失败", cause);
  }
}

const root = ref<HTMLElement | null>(null);
const loadMoreSentinel = ref<HTMLElement | null>(null);
const toast = useToast();
const { pullDistance, refreshing, refresh } = usePullRefresh(root, async () => {
  const memberId = app.selectedMemberId.value;
  if (!memberId) return;
  try {
    await load(memberId, true);
    toast.show("已是最新数据");
  } catch {
    toast.show("刷新失败，请稍后重试");
  }
});

watch(() => app.selectedMemberId.value, (memberId) => {
  syncFiltersFromRoute();
  summaryStats.value = null;
  mobileDetailOpen.value = false;
  if (memberId) load(memberId).catch(() => {});
}, { immediate: true });

function cancelPendingSearch() {
  if (!searchDebounceTimer) return;
  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = null;
}

function applyFilters() {
  cancelPendingSearch();
  const memberId = app.selectedMemberId.value;
  if (memberId) load(memberId).catch(() => {});
}

watch(query, () => {
  cancelPendingSearch();
  searchDebounceTimer = setTimeout(() => {
    searchDebounceTimer = null;
    const memberId = app.selectedMemberId.value;
    if (memberId) load(memberId).catch(() => {});
  }, 350);
}, { flush: "sync" });

function activateTopbarSearch() {
  app.setTopbarSearch({
    key: "records",
    model: query,
    placeholder: "搜索档案",
    expandedPlaceholder: "搜索医院、科室、部位或报告",
    submit: applyFilters
  });
}

function nextRouteUsesTopbarSearch() {
  return route.path === "/records" || route.path === "/trends";
}

watch(recordCountSubtitle, (subtitle) => app.setTopbarSubtitle("records", subtitle), { immediate: true });

watch(() => route.query.reportId, (reportId) => {
  pendingRouteReportId = typeof reportId === "string" ? reportId : "";
  applyPendingRouteSelection();
}, { immediate: true });

watch(() => route.query.status, () => {
  const previous = statusFilter.value;
  syncFiltersFromRoute();
  const memberId = app.selectedMemberId.value;
  if (memberId && statusFilter.value !== previous) {
    selectedId.value = "";
    load(memberId).catch(() => {});
  }
}, { immediate: true });

function attachLoadMoreObserver(element: HTMLElement | null) {
  loadMoreObserver?.disconnect();
  loadMoreObserver = null;
  if (!element) return;
  loadMoreObserver = new IntersectionObserver((entries) => {
    if (entries.some((entry) => entry.isIntersecting)) void loadMoreReports();
  }, { root: null, rootMargin: "260px 0px", threshold: 0.01 });
  loadMoreObserver.observe(element);
}

watch(loadMoreSentinel, (element) => attachLoadMoreObserver(element));

onMounted(() => {
  attachLoadMoreObserver(loadMoreSentinel.value);
  activateTopbarSearch();
});
onBeforeUnmount(() => {
  cancelPendingSearch();
  loadMoreObserver?.disconnect();
  app.clearTopbarSubtitle("records");
  app.clearTopbarSearch("records");
});
/* KeepAlive 缓存期间保留本页汇总，路由切回时顶部可以同步读取，避免闪现上一页内容。 */
onDeactivated(() => {
  cancelPendingSearch();
  mobileDetailOpen.value = false;
  if (!nextRouteUsesTopbarSearch()) app.clearTopbarSearch("records");
});
onActivated(() => {
  app.setTopbarSubtitle("records", recordCountSubtitle.value);
  activateTopbarSearch();
});
useRefreshOnActivate(() => { void reloadList(); });
</script>

<template>
  <div ref="root" class="records-page">
    <section class="page-intro">
      <div><h2>健康时间轴</h2><p>按医院报告生成日期整理，点击报告可查看处理进度和原件</p></div>
      <div class="intro-actions">
        <span class="count-label">{{ summaryStats?.totalReports ?? reports.length }} 份报告</span>
        <button class="icon-button refresh-action" type="button" title="刷新" :disabled="refreshing" @click="refresh">
          <RefreshCw :size="18" :class="{ 'spin-icon': refreshing }" />
        </button>
      </div>
    </section>
    <div class="filter-row records-filter-row">
      <label class="search-field records-search-field page-search-field"><Search :size="18" /><input v-model="query" placeholder="搜索医院、科室、部位或报告" @keydown.enter="applyFilters" /></label>
      <input v-model="ocrQuery" class="compact-filter advanced-filter" placeholder="OCR 全文" @keydown.enter="applyFilters" />
      <FormSelect v-model="typeFilter" class="records-filter-select advanced-filter" :options="typeOptions" aria-label="报告类型" @change="applyFilters" />
      <FormSelect v-model="statusFilter" class="records-filter-select advanced-filter" :options="statusOptions" aria-label="归档状态" @change="applyFilters" />
      <FormSelect v-model="sortFilter" class="records-sort-select advanced-filter" :options="sortOptions" aria-label="报告排序" @change="applyFilters" />
      <DateTimePicker v-model="dateFrom" class="compact-filter date-filter advanced-filter" label="开始日期" aria-label="开始日期" @update:model-value="applyFilters" />
      <DateTimePicker v-model="dateTo" class="compact-filter date-filter advanced-filter" label="结束日期" aria-label="结束日期" @update:model-value="applyFilters" />
      <button class="soft-action-button advanced-filter" type="button" @click="applyFilters">筛选</button>
    </div>
    <PullIndicator :distance="pullDistance" :refreshing="refreshing" />
    <div class="records-layout">
      <section class="timeline-panel">
        <div v-if="loading" class="loading-list"><span v-for="index in 4" :key="index"></span></div>
        <p v-else-if="loadError" class="inline-panel-error">
          {{ loadError }}<button class="error-retry" type="button" @click="retryLoad">重试</button>
        </p>
        <EmptyState v-else-if="!filtered.length" title="还没有健康报告" description="上传第一份报告后，会按报告日期出现在这里。">
          <RouterLink class="primary-button" to="/upload">上传报告</RouterLink>
        </EmptyState>
        <template v-else>
          <button
            v-for="report in filtered"
            :key="report.id"
            class="timeline-item"
            :class="{ selected: report.id === selectedId }"
            type="button"
            @click="selectReport(report)"
          >
            <span class="timeline-date"><CalendarDays :size="14" />{{ report.reportIssuedAt || "日期待确认" }}</span>
            <strong>{{ report.title }}</strong>
            <small>{{ metaLine(report) }}</small>
            <span class="chip-row">
              <span class="chip chip--type">{{ typeLabel(report.reportType) }}</span>
              <span v-if="statusMeta[report.status]" class="chip" :class="statusMeta[report.status].chip">{{ statusMeta[report.status].label }}</span>
              <span v-if="report.abnormalCount > 0" class="chip chip--amber">{{ report.abnormalCount }} 项异常</span>
              <span v-if="report.pageCount > 1" class="chip chip--plain">{{ report.pageCount }} 页</span>
            </span>
            <ChevronRight :size="18" class="timeline-arrow" />
          </button>
          <div ref="loadMoreSentinel" class="load-more-indicator" aria-live="polite">
            <template v-if="loadingMore">
              <LoaderCircle :size="18" class="spin-icon" />
              <span>正在加载更多…</span>
            </template>
            <template v-else-if="loadMoreError">
              <CircleAlert :size="17" />
              <button type="button" @click="loadMoreReports">{{ loadMoreError }}，点击重试</button>
            </template>
            <template v-else-if="hasMore">
              <span>继续下滑加载更多</span>
            </template>
            <template v-else>
              <span>已加载全部报告</span>
            </template>
          </div>
        </template>
      </section>
      <section class="report-preview">
        <ReportDetail
          v-if="selectedId"
          :report-id="selectedId"
          :summary="selected"
          variant="panel"
          @updated="reloadList"
          @open-candidate="openDuplicateCandidate"
        />
        <EmptyState v-else title="选择一份报告" description="报告信息、处理进度和关联原件将在这里显示。" />
      </section>
    </div>

    <ReportDetailSheet v-if="mobileDetailOpen && selected" :report-id="selectedId" :summary="selected"
      @updated="reloadList" @close="closeMobileDetail" @open-candidate="openDuplicateCandidate" />
    <BackToTop />
  </div>
</template>
