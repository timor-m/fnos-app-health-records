<script setup lang="ts">
import { computed, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import {
  BellPlus,
  ChevronDown,
  ChevronRight,
  FileImage,
  FileText,
  History,
  Link2,
  LoaderCircle,
  MoreHorizontal,
  Pencil,
  Ruler,
  ScanSearch,
  Scissors,
  Search,
  X
} from "@lucide/vue";
import EmptyState from "../components/EmptyState.vue";
import DateTimePicker from "../components/DateTimePicker.vue";
import FormSelect from "../components/FormSelect.vue";
import ImageViewer, { type ImageViewerPage } from "../components/ImageViewer.vue";
import MorphologyFindingEditor from "../components/MorphologyFindingEditor.vue";
import PullIndicator from "../components/PullIndicator.vue";
import ReportDetailModal from "../components/ReportDetailModal.vue";
import { useAppContext } from "../composables/useAppContext";
import { usePullRefresh } from "../composables/usePullRefresh";
import { useRefreshOnActivate } from "../composables/useRefreshOnActivate";
import { useToast } from "../composables/useToast";
import { useConfirm } from "../composables/useConfirm";
import type {
  MorphologyTrackingPoint,
  MorphologyTrackingResponse,
  MorphologyTrackingSeries,
  UntrackedMorphologyFinding
} from "../types/api";
import { apiUrl, request } from "../utils/api";

type StatusFilter = "all" | "multi" | "single" | "untracked";

const app = useAppContext();
const route = useRoute();
const toast = useToast();
const confirmDialog = useConfirm();
const root = ref<HTMLElement | null>(null);
const loading = ref(true);
const loadError = ref("");
const data = ref<MorphologyTrackingResponse | null>(null);
const query = ref("");
const statusFilter = ref<StatusFilter>("all");
const previewReportId = ref<string | null>(null);
const sourcePreview = ref<{ point: MorphologyTrackingPoint; seriesName: string } | null>(null);
const processingFinding = ref<UntrackedMorphologyFinding | null>(null);
const editingFinding = ref<UntrackedMorphologyFinding | MorphologyTrackingPoint | null>(null);
const mergeSeries = ref<MorphologyTrackingSeries | null>(null);
const reminderSeries = ref<MorphologyTrackingSeries | null>(null);
const activeSeriesMenuId = ref<string | null>(null);
const expandedSeriesIds = ref<Set<string>>(new Set());
const selectedTrackingGroup = ref("");
const selectedMergeTarget = ref("");
const reminderDueAt = ref("");
const actionLoading = ref(false);
const actionError = ref("");

const statusOptions = [
  { value: "all", label: "全部项目" },
  { value: "multi", label: "历年变化" },
  { value: "single", label: "单次记录" },
  { value: "untracked", label: "待确认" }
];

function normalizeSearch(value: string) {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/g, "");
}

const filteredSeries = computed(() => {
  if (statusFilter.value === "untracked") return [];
  const keyword = normalizeSearch(query.value.trim());
  return (data.value?.series || []).filter((item) => {
    if (statusFilter.value === "multi" && item.pointCount < 2) return false;
    if (statusFilter.value === "single" && item.pointCount !== 1) return false;
    if (!keyword) return true;
    return normalizeSearch([
      item.name,
      item.organ,
      item.region,
      item.findingType,
      item.latest.findingName
    ].filter(Boolean).join(" ")).includes(keyword);
  });
});

const filteredUntracked = computed(() => {
  if (statusFilter.value !== "all" && statusFilter.value !== "untracked") return [];
  const keyword = normalizeSearch(query.value.trim());
  return (data.value?.untracked || []).filter((item) => !keyword || normalizeSearch([
    item.findingName,
    item.organ,
    item.findingType,
    item.reportTitle
  ].filter(Boolean).join(" ")).includes(keyword));
});

const hasResults = computed(() => filteredSeries.value.length > 0 || filteredUntracked.value.length > 0);
const multiRecordSeries = computed(() => filteredSeries.value.filter((item) => item.pointCount > 1));
const singleRecordSeries = computed(() => filteredSeries.value.filter((item) => item.pointCount === 1));
const sourceViewerPages = computed<ImageViewerPage[]>(() => {
  const value = sourcePreview.value;
  const page = value?.point.sourcePage;
  if (!value || !page) return [];
  const previewUrl = apiUrl(`reports/${value.point.reportId}/pages/${page.id}/preview`);
  return [{
    key: page.id,
    fullUrl: previewUrl,
    label: `${value.seriesName} · 第 ${page.pageNumber} 页`,
    downloadUrl: previewUrl,
    downloadName: `${value.seriesName}-第${page.pageNumber}页`
  }];
});

async function load(memberId: string, silent = false) {
  if (!silent) loading.value = true;
  loadError.value = "";
  try {
    data.value = await request<MorphologyTrackingResponse>(
      `morphology-trends?memberId=${encodeURIComponent(memberId)}`
    );
  } catch (cause) {
    loadError.value = cause instanceof Error ? cause.message : "形态变化加载失败";
    throw cause;
  } finally {
    if (!silent) loading.value = false;
  }
}

function reload() {
  const memberId = app.selectedMemberId.value;
  if (memberId) load(memberId, true).catch(() => {});
}

useRefreshOnActivate(reload);
const { pullDistance, refreshing } = usePullRefresh(root, async () => {
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
  query.value = "";
  statusFilter.value = "all";
  if (memberId) load(memberId).catch(() => {});
}, { immediate: true });

function activateTopbarSearch() {
  app.setTopbarSearch({
    key: "trends",
    model: query,
    placeholder: "搜索形态",
    expandedPlaceholder: "搜索部位或发现名称"
  });
}

function nextRouteUsesTopbarSearch() {
  return route.path === "/records" || route.path === "/trends" || route.path.startsWith("/trends/");
}

onMounted(activateTopbarSearch);
onBeforeUnmount(() => app.clearTopbarSearch("trends"));
onActivated(activateTopbarSearch);
onDeactivated(() => {
  if (!nextRouteUsesTopbarSearch()) app.clearTopbarSearch("trends");
});

function formatDate(value: string | null) {
  return value ? value.slice(0, 10) : "日期待确认";
}

function presenceLabel(value: MorphologyTrackingPoint["presence"]) {
  return value === "present" ? "原报告有记录" : value === "absent" ? "原报告未见" : "状态待确认";
}

function pointResult(point: MorphologyTrackingPoint) {
  return point.size.label || point.classification?.label || presenceLabel(point.presence);
}

function timelinePoints(item: MorphologyTrackingSeries) {
  return [...item.points].reverse();
}

function comparableSizePoints(item: MorphologyTrackingSeries) {
  return item.points.filter((point) => point.size.primaryMm !== null);
}

function hasSizeTrend(item: MorphologyTrackingSeries) {
  return comparableSizePoints(item).length > 1;
}

function formatMillimeters(value: number) {
  return `${Number.isInteger(value) ? value : value.toFixed(1)} mm`;
}

function sizeTrendPoints(item: MorphologyTrackingSeries) {
  const points = comparableSizePoints(item);
  const values = points.map((point) => point.size.primaryMm as number);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min;
  return points.map((point, index) => {
    const value = point.size.primaryMm as number;
    return {
      point,
      value,
      x: points.length === 1 ? 50 : 8 + (index / (points.length - 1)) * 84,
      y: range === 0 ? 46 : 18 + ((max - value) / range) * 52
    };
  });
}

function sizeTrendPolyline(item: MorphologyTrackingSeries) {
  return sizeTrendPoints(item).map((point) => `${point.x},${point.y}`).join(" ");
}

function sizeTrendRange(item: MorphologyTrackingSeries) {
  const values = comparableSizePoints(item).map((point) => point.size.primaryMm as number);
  if (!values.length) return "";
  const min = Math.min(...values);
  const max = Math.max(...values);
  return min === max ? formatMillimeters(min) : `${formatMillimeters(min)} - ${formatMillimeters(max)}`;
}

function openTrendPoint(point: MorphologyTrackingPoint, item: MorphologyTrackingSeries) {
  if (point.sourcePage) openSourcePage(point, item);
  else openReport(point.reportId);
}

function seriesExpanded(item: MorphologyTrackingSeries) {
  return expandedSeriesIds.value.has(item.trackingGroupId);
}

function toggleSeries(item: MorphologyTrackingSeries) {
  const next = new Set(expandedSeriesIds.value);
  if (next.has(item.trackingGroupId)) next.delete(item.trackingGroupId);
  else next.add(item.trackingGroupId);
  expandedSeriesIds.value = next;
}

function toggleSeriesMenu(item: MorphologyTrackingSeries) {
  activeSeriesMenuId.value = activeSeriesMenuId.value === item.trackingGroupId
    ? null
    : item.trackingGroupId;
}

function openReport(reportId: string) {
  sourcePreview.value = null;
  activeSeriesMenuId.value = null;
  previewReportId.value = reportId;
}

function openSourcePage(point: MorphologyTrackingPoint, item: MorphologyTrackingSeries) {
  if (!point.sourcePage) return;
  sourcePreview.value = { point, seriesName: item.name };
}

function openSourceReport() {
  const reportId = sourcePreview.value?.point.reportId;
  if (reportId) openReport(reportId);
}

function untrackedMeta(item: UntrackedMorphologyFinding) {
  return [
    formatDate(item.reportIssuedAt),
    item.hospitalName || "机构待整理",
    item.organ || item.findingType || "部位待确认"
  ].join(" · ");
}

function compatibleSeries(finding: UntrackedMorphologyFinding | MorphologyTrackingPoint) {
  return (data.value?.series || []).filter((series) => {
    if (finding.laterality === "left" && series.laterality === "right") return false;
    if (finding.laterality === "right" && series.laterality === "left") return false;
    return series.organ === finding.organ || series.findingType === finding.findingType;
  });
}

function openProcess(item: UntrackedMorphologyFinding) {
  processingFinding.value = item;
  selectedTrackingGroup.value = compatibleSeries(item)[0]?.trackingGroupId || "";
  actionError.value = "";
}

async function setTracking(mode: "existing" | "separate", finding = processingFinding.value) {
  if (!finding) return;
  actionLoading.value = true;
  actionError.value = "";
  try {
    data.value = await request<MorphologyTrackingResponse>(
      `morphology-findings/${encodeURIComponent(finding.findingId)}/tracking`,
      { method: "POST", body: JSON.stringify({ mode, trackingGroupId: selectedTrackingGroup.value }) }
    );
    processingFinding.value = null;
    toast.show(mode === "existing" ? "已归入同一项目" : "已建立独立项目");
  } catch (cause) {
    actionError.value = cause instanceof Error ? cause.message : "处理失败";
  } finally {
    actionLoading.value = false;
  }
}

function ignoreFinding() {
  const finding = processingFinding.value;
  if (!finding) return;
  confirmDialog.ask({
    title: "标记为误提取",
    message: "该记录将不再出现在形态变化和待确认列表，后续 AI 重跑也会保留此结果。",
    confirmText: "确认忽略",
    danger: true,
    run: async () => {
      data.value = await request<MorphologyTrackingResponse>(
        `morphology-findings/${encodeURIComponent(finding.findingId)}/ignore`, { method: "POST" }
      );
      processingFinding.value = null;
      toast.show("已标记为误提取");
    }
  });
}

async function splitPoint(point: MorphologyTrackingPoint) {
  actionLoading.value = true;
  try {
    data.value = await request<MorphologyTrackingResponse>(
      `morphology-findings/${encodeURIComponent(point.findingId)}/tracking`,
      { method: "POST", body: JSON.stringify({ mode: "separate" }) }
    );
    toast.show("已移出当前项目");
  } catch (cause) {
    toast.show(cause instanceof Error ? cause.message : "拆分失败");
  } finally {
    actionLoading.value = false;
  }
}

function openMerge(item: MorphologyTrackingSeries) {
  activeSeriesMenuId.value = null;
  mergeSeries.value = item;
  selectedMergeTarget.value = compatibleMergeSeries(item)[0]?.trackingGroupId || "";
  actionError.value = "";
}

function compatibleMergeSeries(item: MorphologyTrackingSeries) {
  return (data.value?.series || []).filter((series) =>
    series.trackingGroupId !== item.trackingGroupId
    && !(item.laterality === "left" && series.laterality === "right")
    && !(item.laterality === "right" && series.laterality === "left")
    && (series.organ === item.organ || series.findingType === item.findingType)
  );
}

function seriesSelectOptions(list: MorphologyTrackingSeries[]) {
  return list.map((series) => ({ value: series.trackingGroupId, label: `${series.name} · ${series.pointCount} 次记录` }));
}

async function mergeTracking() {
  const memberId = app.selectedMemberId.value;
  if (!mergeSeries.value || !memberId) return;
  actionLoading.value = true;
  actionError.value = "";
  try {
    data.value = await request<MorphologyTrackingResponse>("morphology-trends/merge", {
      method: "POST",
      body: JSON.stringify({ memberId, sourceGroupId: mergeSeries.value.trackingGroupId, targetGroupId: selectedMergeTarget.value })
    });
    mergeSeries.value = null;
    toast.show("已归为同一项目");
  } catch (cause) {
    actionError.value = cause instanceof Error ? cause.message : "合并失败";
  } finally {
    actionLoading.value = false;
  }
}

function openReminder(item: MorphologyTrackingSeries) {
  activeSeriesMenuId.value = null;
  reminderSeries.value = item;
  const due = new Date();
  due.setMonth(due.getMonth() + 6);
  reminderDueAt.value = due.toISOString().slice(0, 10);
  actionError.value = "";
}

async function createFollowupReminder() {
  const memberId = app.selectedMemberId.value;
  const item = reminderSeries.value;
  if (!memberId || !item) return;
  actionLoading.value = true;
  actionError.value = "";
  try {
    await request("reminders", {
      method: "POST",
      body: JSON.stringify({ memberId, reportId: item.latest.reportId, title: `${item.name}复查`, dueAt: reminderDueAt.value })
    });
    await app.refreshReminderCount();
    reminderSeries.value = null;
    toast.show("复查提醒已创建");
  } catch (cause) {
    actionError.value = cause instanceof Error ? cause.message : "提醒创建失败";
  } finally {
    actionLoading.value = false;
  }
}

async function editorSaved() {
  reload();
}
</script>

<template>
  <section ref="root" class="plain-page morphology-trends-page">
    <div class="page-intro">
      <div><h2>形态变化</h2><p>按部位与发现类型关联历次原报告记录</p></div>
      <span class="page-intro-badge"><ScanSearch :size="22" /></span>
    </div>
    <nav class="trend-view-switch" aria-label="趋势视图">
      <RouterLink to="/trends">指标趋势</RouterLink>
      <RouterLink to="/trends/morphology" aria-current="page">形态变化</RouterLink>
    </nav>
    <PullIndicator :distance="pullDistance" :refreshing="refreshing" />

    <div v-if="loading" class="loading-list"><span v-for="index in 3" :key="index"></span></div>
    <p v-else-if="loadError" class="inline-panel-error">
      {{ loadError }}
      <button class="error-retry" type="button" @click="reload">重试</button>
    </p>
    <EmptyState
      v-else-if="!data?.series.length && !data?.untracked.length"
      title="暂无形态变化记录"
      description="报告整理出结节、囊肿、息肉等形态发现后，会按部位保守关联历次记录。"
    />
    <template v-else>
      <section class="morphology-summary">
        <div><strong>{{ data?.summary.groups || 0 }}</strong><span>形态项目</span></div>
        <div><strong>{{ data?.summary.multiRecordGroups || 0 }}</strong><span>历年变化</span></div>
        <div><strong>{{ (data?.summary.groups || 0) - (data?.summary.multiRecordGroups || 0) }}</strong><span>单次记录</span></div>
        <div><strong>{{ data?.summary.untracked || 0 }}</strong><span>待确认</span></div>
      </section>

      <div class="trend-filter-row morphology-filter-row">
        <label class="search-field trend-search-field page-search-field">
          <Search :size="18" />
          <input v-model="query" placeholder="搜索部位或发现名称" />
        </label>
        <FormSelect
          v-model="statusFilter"
          class="trend-status-select records-filter-select"
          :options="statusOptions"
          aria-label="记录状态"
        />
      </div>

      <EmptyState
        v-if="!hasResults"
        title="没有符合条件的记录"
        description="换个部位、发现名称或记录状态试试。"
      />

      <section v-if="multiRecordSeries.length" class="morphology-record-section">
        <header class="morphology-section-heading">
          <div><strong>历年变化</strong><span>同一项目在不同报告中的记录</span></div>
          <em>{{ multiRecordSeries.length }} 项</em>
        </header>
        <div class="morphology-series-list">
          <article
            v-for="item in multiRecordSeries"
            :key="item.trackingGroupId"
            class="morphology-series-card"
            :class="{ 'menu-open': activeSeriesMenuId === item.trackingGroupId }"
          >
            <header class="morphology-card-header">
              <span class="item-icon"><ScanSearch :size="19" /></span>
              <div class="morphology-card-title">
                <strong>{{ item.name }}</strong>
                <span>{{ item.pointCount }} 次记录<template v-if="item.region"> · {{ item.region }}</template></span>
              </div>
              <em class="morphology-change-copy" :class="`change-${item.changeKind}`">{{ item.changeSummary }}</em>
              <div class="morphology-card-menu">
                <button type="button" title="管理项目" aria-label="管理项目" @click="toggleSeriesMenu(item)">
                  <MoreHorizontal :size="19" />
                </button>
                <button
                  v-if="activeSeriesMenuId === item.trackingGroupId"
                  class="morphology-menu-backdrop"
                  type="button"
                  aria-label="关闭项目菜单"
                  @click="activeSeriesMenuId = null"
                ></button>
                <div v-if="activeSeriesMenuId === item.trackingGroupId" class="morphology-menu-popover">
                  <button type="button" @click="openReminder(item)"><BellPlus :size="16" />创建复查提醒</button>
                  <button v-if="compatibleMergeSeries(item).length" type="button" @click="openMerge(item)"><Link2 :size="16" />归为同一项目</button>
                </div>
              </div>
            </header>

            <div class="morphology-card-body">
              <button class="morphology-current-result" type="button" @click="openReport(item.latest.reportId)">
                <span>最近结果</span>
                <strong>{{ pointResult(item.latest) }}</strong>
                <small>{{ formatDate(item.latest.reportIssuedAt) }} · {{ item.latest.hospitalName || "机构待整理" }}</small>
                <p v-if="item.latest.morphology">{{ item.latest.morphology }}</p>
              </button>

              <div v-if="hasSizeTrend(item)" class="morphology-size-trend">
                <header><span><Ruler :size="15" />最大径趋势</span><strong>{{ sizeTrendRange(item) }}</strong></header>
                <div class="morphology-chart-scroll">
                  <div class="morphology-chart-canvas" :style="{ minWidth: `${Math.max(280, comparableSizePoints(item).length * 76)}px` }">
                    <svg viewBox="0 0 100 92" preserveAspectRatio="none" aria-hidden="true">
                      <line x1="8" y1="70" x2="92" y2="70" />
                      <polyline :points="sizeTrendPolyline(item)" />
                    </svg>
                    <button
                      v-for="chartPoint in sizeTrendPoints(item)"
                      :key="chartPoint.point.findingId"
                      class="morphology-chart-node"
                      :class="{ latest: chartPoint.point.findingId === item.latest.findingId }"
                      type="button"
                      :style="{ left: `${chartPoint.x}%`, '--point-y': `${chartPoint.y}%` }"
                      :aria-label="`${formatDate(chartPoint.point.reportIssuedAt)}，最大径${formatMillimeters(chartPoint.value)}`"
                      @click="openTrendPoint(chartPoint.point, item)"
                    >
                      <span>{{ formatMillimeters(chartPoint.value) }}</span>
                      <i></i>
                      <time>{{ formatDate(chartPoint.point.reportIssuedAt).slice(2) }}</time>
                    </button>
                  </div>
                </div>
              </div>
              <div v-else class="morphology-qualitative-change">
                <span>本次对比</span>
                <strong>{{ item.changeSummary }}</strong>
                <small>原报告未提供两次以上可比较尺寸，按状态、分级和形态描述展示。</small>
              </div>
            </div>

            <button
              class="morphology-history-toggle"
              type="button"
              :aria-expanded="seriesExpanded(item)"
              @click="toggleSeries(item)"
            >
              <span><History :size="16" />历年记录 · {{ item.pointCount }} 次</span>
              <ChevronDown :size="17" :class="{ expanded: seriesExpanded(item) }" />
            </button>
            <div v-if="seriesExpanded(item)" class="morphology-timeline">
              <article v-for="point in timelinePoints(item)" :key="point.findingId">
                <i aria-hidden="true"></i>
                <button type="button" class="morphology-point-main" @click="openReport(point.reportId)">
                  <strong>{{ formatDate(point.reportIssuedAt) }} · {{ pointResult(point) }}</strong>
                  <span>{{ point.hospitalName || "机构待整理" }} · {{ point.findingName }}</span>
                  <small v-if="point.morphology">{{ point.morphology }}</small>
                </button>
                <div class="morphology-point-actions">
                  <button v-if="point.sourcePage" type="button" title="查看发现所在页高清图" @click="openSourcePage(point, item)">
                    <FileImage :size="16" /><span>原图</span>
                  </button>
                  <button type="button" title="校对形态字段" @click="editingFinding = point">
                    <Pencil :size="16" /><span>校对</span>
                  </button>
                  <button type="button" title="从当前项目移出" :disabled="actionLoading" @click="splitPoint(point)">
                    <Scissors :size="16" /><span>移出</span>
                  </button>
                </div>
              </article>
            </div>
          </article>
        </div>
      </section>

      <section v-if="singleRecordSeries.length" class="morphology-record-section">
        <header class="morphology-section-heading">
          <div><strong>单次记录</strong><span>目前只有一份报告记录，后续同类报告会自动归总</span></div>
          <em>{{ singleRecordSeries.length }} 项</em>
        </header>
        <div class="morphology-series-list morphology-single-list">
          <article
            v-for="item in singleRecordSeries"
            :key="item.trackingGroupId"
            class="morphology-series-card morphology-single-card"
            :class="{ 'menu-open': activeSeriesMenuId === item.trackingGroupId }"
          >
            <header class="morphology-card-header">
              <span class="item-icon"><ScanSearch :size="19" /></span>
              <div class="morphology-card-title">
                <strong>{{ item.name }}</strong>
                <span>{{ item.organ }}<template v-if="item.region"> · {{ item.region }}</template></span>
              </div>
              <div class="morphology-card-menu">
                <button type="button" title="管理项目" aria-label="管理项目" @click="toggleSeriesMenu(item)">
                  <MoreHorizontal :size="19" />
                </button>
                <button
                  v-if="activeSeriesMenuId === item.trackingGroupId"
                  class="morphology-menu-backdrop"
                  type="button"
                  aria-label="关闭项目菜单"
                  @click="activeSeriesMenuId = null"
                ></button>
                <div v-if="activeSeriesMenuId === item.trackingGroupId" class="morphology-menu-popover">
                  <button type="button" @click="openReminder(item)"><BellPlus :size="16" />创建复查提醒</button>
                  <button v-if="compatibleMergeSeries(item).length" type="button" @click="openMerge(item)"><Link2 :size="16" />归为同一项目</button>
                </div>
              </div>
            </header>
            <button class="morphology-single-result" type="button" @click="openReport(item.latest.reportId)">
              <span><strong>{{ pointResult(item.latest) }}</strong><small>{{ formatDate(item.latest.reportIssuedAt) }}</small></span>
              <p v-if="item.latest.morphology">{{ item.latest.morphology }}</p>
              <em>{{ item.latest.hospitalName || "机构待整理" }}</em>
              <ChevronRight :size="18" />
            </button>
            <div class="morphology-single-actions">
              <button v-if="item.latest.sourcePage" type="button" @click="openSourcePage(item.latest, item)"><FileImage :size="16" />查看原图</button>
              <button type="button" @click="editingFinding = item.latest"><Pencil :size="16" />校对记录</button>
            </div>
          </article>
        </div>
      </section>

      <section v-if="filteredUntracked.length" class="morphology-untracked">
        <header>
          <div><strong>待确认记录</strong><span>查看原报告内容后，可归入已有项目或建立独立项目</span></div>
          <em>{{ filteredUntracked.length }} 项</em>
        </header>
        <article v-for="item in filteredUntracked" :key="item.findingId">
          <span class="item-icon muted"><FileText :size="18" /></span>
          <div>
            <strong>{{ item.findingName }}</strong>
            <span>{{ item.reportTitle }} · {{ untrackedMeta(item) }}</span>
            <p class="morphology-untracked-raw">{{ item.rawText }}</p>
            <small>{{ item.reason }}</small>
          </div>
          <div class="morphology-untracked-actions">
            <button class="soft-action-button" type="button" @click="openProcess(item)"><Link2 :size="16" />查看处理</button>
            <button type="button" title="打开来源报告" @click="openReport(item.reportId)"><ChevronRight :size="18" /></button>
          </div>
        </article>
      </section>
    </template>

    <ReportDetailModal
      :open="Boolean(previewReportId)"
      :report-id="previewReportId"
      @close="previewReportId = null"
      @updated="reload"
    />
    <ImageViewer v-if="sourcePreview" :pages="sourceViewerPages" @close="sourcePreview = null">
      <template #actions>
        <button type="button" title="打开来源报告详情" @click="openSourceReport"><FileText :size="18" /></button>
      </template>
    </ImageViewer>

    <MorphologyFindingEditor
      :open="Boolean(editingFinding)"
      :finding="editingFinding"
      @close="editingFinding = null"
      @saved="editorSaved"
    />

    <Teleport to="body">
      <div v-if="processingFinding" class="modal-backdrop compact-action-backdrop" @click.self="processingFinding = null">
        <section class="modal-panel compact-action-modal" role="dialog" aria-modal="true" aria-label="处理待确认形态记录">
          <header><div><Link2 :size="19" /><span><strong>确认记录归属</strong><small>{{ processingFinding.findingName }}</small></span></div><button class="plain-icon-button" type="button" @click="processingFinding = null"><X :size="18" /></button></header>
          <div class="compact-action-body">
            <div class="compact-finding-summary"><strong>{{ untrackedMeta(processingFinding) }}</strong><span>{{ processingFinding.reason }}</span><p>{{ processingFinding.rawText }}</p></div>
            <p>将记录归入已有项目后，会与该项目的历年报告一起展示；不会修改或删除原报告。</p>
            <label v-if="compatibleSeries(processingFinding).length" class="settings-form"><span>归入已有项目</span><FormSelect v-model="selectedTrackingGroup" :options="seriesSelectOptions(compatibleSeries(processingFinding))" aria-label="归入已有项目" /></label>
            <p v-if="actionError" class="inline-panel-error">{{ actionError }}</p>
          </div>
          <footer class="compact-action-footer">
            <button class="soft-action-button" type="button" @click="editingFinding = processingFinding"><Pencil :size="16" />先校对字段</button>
            <button class="soft-action-button danger-text" type="button" @click="ignoreFinding">不是形态发现</button>
            <button class="soft-action-button" type="button" :disabled="actionLoading" @click="setTracking('separate')">作为新项目</button>
            <button v-if="compatibleSeries(processingFinding).length" class="primary-button" type="button" :disabled="actionLoading || !selectedTrackingGroup" @click="setTracking('existing')"><LoaderCircle v-if="actionLoading" class="spin-icon" :size="16" />确认归入</button>
          </footer>
        </section>
      </div>

      <div v-if="mergeSeries" class="modal-backdrop compact-action-backdrop" @click.self="mergeSeries = null">
        <section class="modal-panel compact-action-modal" role="dialog" aria-modal="true" aria-label="归为同一形态项目">
          <header><div><Link2 :size="19" /><span><strong>归为同一项目</strong><small>{{ mergeSeries.name }}</small></span></div><button class="plain-icon-button" type="button" @click="mergeSeries = null"><X :size="18" /></button></header>
          <div class="compact-action-body">
            <p>选择后，“{{ mergeSeries.name }}”的全部历年记录会归入目标项目；只调整展示关联，不修改或删除原报告。</p>
            <label class="settings-form"><span>目标项目</span><FormSelect v-model="selectedMergeTarget" :options="seriesSelectOptions(compatibleMergeSeries(mergeSeries))" placeholder="选择要归入的项目" aria-label="目标项目" /></label>
            <p v-if="actionError" class="inline-panel-error">{{ actionError }}</p>
          </div>
          <footer class="compact-action-footer"><button type="button" @click="mergeSeries = null">取消</button><button class="primary-button" type="button" :disabled="actionLoading || !selectedMergeTarget" @click="mergeTracking"><LoaderCircle v-if="actionLoading" class="spin-icon" :size="16" />确认归入</button></footer>
        </section>
      </div>

      <div v-if="reminderSeries" class="modal-backdrop compact-action-backdrop" @click.self="reminderSeries = null">
        <section class="modal-panel compact-action-modal" role="dialog" aria-modal="true" aria-label="创建复查提醒">
          <header><div><BellPlus :size="19" /><span><strong>创建复查提醒</strong><small>{{ reminderSeries.name }}</small></span></div><button class="plain-icon-button" type="button" @click="reminderSeries = null"><X :size="18" /></button></header>
          <div class="compact-action-body"><label class="settings-form"><span>提醒日期</span><DateTimePicker v-model="reminderDueAt" aria-label="提醒日期" /></label><p>提醒将关联最近一次来源报告，可从提醒卡片直接打开原报告。</p><p v-if="actionError" class="inline-panel-error">{{ actionError }}</p></div>
          <footer class="compact-action-footer"><button type="button" @click="reminderSeries = null">取消</button><button class="primary-button" type="button" :disabled="actionLoading || !reminderDueAt" @click="createFollowupReminder"><LoaderCircle v-if="actionLoading" class="spin-icon" :size="16" />创建提醒</button></footer>
        </section>
      </div>
    </Teleport>
  </section>
</template>
