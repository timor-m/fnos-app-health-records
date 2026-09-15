<script setup lang="ts">
import { computed, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import {
  Activity,
  ChartNoAxesCombined,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  FileText,
  Pin,
  Search,
  X
} from "@lucide/vue";
import BackToTop from "../components/BackToTop.vue";
import EmptyState from "../components/EmptyState.vue";
import FormSelect from "../components/FormSelect.vue";
import TrendGroupFilter from '../components/TrendGroupFilter.vue';
import { flattenTrendGroups, type TrendGroupNode } from '../../../shared/trend-groups';
import IndicatorHint from "../components/IndicatorHint.vue";
import ImageViewer, { type ImageViewerPage } from "../components/ImageViewer.vue";
import PullIndicator from "../components/PullIndicator.vue";
import ReportDetailModal from "../components/ReportDetailModal.vue";
import { apiUrl, request } from "../utils/api";
import { matchTrendSearch } from "../utils/trends";
import { describeObservationAbnormal, formatReferenceRange } from "../utils/indicator-display";
import {
  canonicalNotation,
  convertScaledValue,
  formatScaledValue,
  notationTitle,
  scaledDeltaPrecision
} from "../utils/value-scale";
import { useAppContext } from "../composables/useAppContext";
import { usePullRefresh } from "../composables/usePullRefresh";
import { useRefreshOnActivate } from "../composables/useRefreshOnActivate";
import { useToast } from "../composables/useToast";
import type { IndicatorNormalizationMetrics, OcrPageDetail, TrendExcludedPoint, TrendPoint, TrendSeries, TrendValueScale } from "../types/api";

const app = useAppContext();
const route = useRoute();
const loading = ref(true);
const loadError = ref("");
const series = ref<TrendSeries[]>([]);
const query = ref("");
const groupFilter = ref('');
const groupTree = ref<TrendGroupNode[]>([]);
const groupResultKeys = ref<Set<string> | null>(null);
const groupResultOrder = computed(() => new Map([...(groupResultKeys.value || [])].map((key, index) => [key, index])));
const groupPending = ref(false);
const groupError = ref('');
let groupRequest = 0;
let loadRequest = 0;
const attentionFilter = ref<"all" | "attention" | "abnormal" | "near_boundary" | "unflagged">("all");
const collapsedGroups = ref(new Set<string>());
// 登记了表示法的序列（如视力的小数/五分记录法）可按类型切换显示，选择跨会话保留。
const SCALE_NOTATION_STORAGE_KEY = "health-records:trend-scale-notation";
const LEGACY_VISION_SCALE_STORAGE_KEY = "health-records:trend-vision-scale";
const scaleNotations = ref<Record<string, string>>(loadScaleNotations());

function loadScaleNotations() {
  let stored: Record<string, string> = {};
  try {
    const parsed = JSON.parse(localStorage.getItem(SCALE_NOTATION_STORAGE_KEY) || "{}");
    if (parsed && typeof parsed === "object") stored = parsed;
  } catch { /* 本地偏好损坏时回退默认表示法 */ }
  // 迁移旧版视力记录方式偏好
  const legacyVision = localStorage.getItem(LEGACY_VISION_SCALE_STORAGE_KEY);
  if (legacyVision && !stored.visual_acuity) {
    stored = { ...stored, visual_acuity: legacyVision };
    localStorage.removeItem(LEGACY_VISION_SCALE_STORAGE_KEY);
    localStorage.setItem(SCALE_NOTATION_STORAGE_KEY, JSON.stringify(stored));
  }
  return stored;
}
const detailPopoverStyle = ref<Record<string, string>>({});
const detailPopoverPlacement = ref<"above" | "below">("below");
const previewReportId = ref<string | null>(null);
const activeDetailKey = ref<string | null>(null);
const pinPendingKeys = ref(new Set<string>());
// 仅管理员可见：指标问题池待治理组数，0 表示无待办或非管理员
const adminIssueCount = ref(0);
const sourcePreview = ref<{
  point: TrendPoint | TrendExcludedPoint;
  seriesName: string;
  unit: string | null;
} | null>(null);
const sourceOcrDetail = ref<OcrPageDetail | null>(null);
let sourceOcrSeq = 0;

// 打开原图时并行拉取该页 OCR 行数据，供叠加层把数据点所在的表格行/结果
// 单元格标记出来；读取失败时静默降级为只看原图。
watch(sourcePreview, async (value) => {
  sourceOcrDetail.value = null;
  const page = value?.point.sourcePage;
  if (!value || !page) return;
  const seq = ++sourceOcrSeq;
  try {
    const detail = await request<OcrPageDetail>(
      `reports/${encodeURIComponent(value.point.reportId)}/pages/${encodeURIComponent(page.id)}/ocr`
    );
    if (seq === sourceOcrSeq) sourceOcrDetail.value = detail;
  } catch {
    if (seq === sourceOcrSeq) sourceOcrDetail.value = null;
  }
});

const sourcePreviewUrl = computed(() => {
  const value = sourcePreview.value;
  if (!value?.point.sourcePage) return "";
  return apiUrl(`reports/${value.point.reportId}/pages/${value.point.sourcePage.id}/preview`);
});
const sourceViewerPages = computed<ImageViewerPage[]>(() => {
  const value = sourcePreview.value;
  if (!value || !sourcePreviewUrl.value) return [];
  return [{
    key: value.point.sourcePage?.id || "source",
    fullUrl: sourcePreviewUrl.value,
    label: `${value.seriesName} · 第 ${value.point.sourcePage?.pageNumber || 1} 页`,
    downloadUrl: sourcePreviewUrl.value
  }];
});

const selectedGroup = computed(() => flattenTrendGroups(groupTree.value).find(g => groupFilter.value === g.key));
const searchedGroupKeys = computed(() => {
  const text = query.value.trim().toLocaleLowerCase();
  return new Set(text ? flattenTrendGroups(groupTree.value).filter(g => g.name.toLocaleLowerCase().includes(text)).flatMap(g => g.indicatorKeys) : []);
});

async function filterGroups() {
  const memberId = app.selectedMemberId.value;
  const sequence = ++groupRequest;
  groupError.value = '';
  if (!memberId || !groupFilter.value.length) {
    groupResultKeys.value = null;
    groupPending.value = false;
    return;
  }
  groupPending.value = true;
  groupResultKeys.value = new Set();
  const params = new URLSearchParams({ memberId });
  params.append('groupKeys[]', groupFilter.value);
  try {
    const result = await request<TrendSeries[]>(`trends?${params}`);
    if (sequence === groupRequest && memberId === app.selectedMemberId.value) groupResultKeys.value = new Set(result.map(item => item.indicatorKey));
  } catch (error) {
    if (sequence === groupRequest) groupError.value = error instanceof Error ? error.message : '分组筛选失败';
  } finally { if (sequence === groupRequest) groupPending.value = false; }
}
const attentionOptions = [
  { value: "all", label: "全部状态" },
  { value: "attention", label: "需要关注" },
  { value: "abnormal", label: "报告已标异常" },
  { value: "near_boundary", label: "接近参考边界" },
  { value: "unflagged", label: "未列入关注" }
];

function trendPointProcessingHint(point: TrendPoint) {
  if (point.reportStatus === "processing") return "来源报告正在重新识别，此处暂时展示上一次成功结果";
  if (point.reportStatus === "failed") return "来源报告最近一次重新识别失败，此趋势点仍来自上一次成功结果";
  return "";
}

function matchingAlias(item: TrendSeries) {
  return matchTrendSearch(item, query.value).alias;
}

const filteredSeries = computed(() => {
  return series.value.filter((item) => {
    if (groupResultKeys.value && !groupResultKeys.value.has(item.indicatorKey)) return false;
    if (attentionFilter.value === "attention" && item.attentionPriority === "normal") return false;
    if (attentionFilter.value === "unflagged" && item.attentionPriority !== "normal") return false;
    if (
      attentionFilter.value !== "all"
      && attentionFilter.value !== "attention"
      && attentionFilter.value !== "unflagged"
      && item.attentionLevel !== attentionFilter.value
    ) return false;
    return searchedGroupKeys.value.has(item.indicatorKey) || matchTrendSearch(item, query.value).matches;
  });
});

type TrendSection = {
  key: string;
  name: string;
  order: number;
  pinned: boolean;
  items: TrendSeries[];
  abnormalCount: number;
  subgroups: Array<{ key: string; name: string; order: number; items: TrendSeries[] }>;
};

const trendSections = computed<TrendSection[]>(() => {
  const result: TrendSection[] = [];
  const pinned = filteredSeries.value.filter((item) => item.pinned).sort(compareTrendSeries);
  if (pinned.length) {
    result.push({
      key: "pinned",
      name: "我的关注",
      order: 0,
      pinned: true,
      items: pinned,
      abnormalCount: pinned.filter((item) => item.attentionLevel === "abnormal").length,
      subgroups: []
    });
  }
  const standardItems = filteredSeries.value.filter((item) => !item.pinned);
  const grouped = new Map<string, TrendSection>();
  for (const item of standardItems) {
    if (!grouped.has(item.groupKey)) {
      grouped.set(item.groupKey, {
        key: item.groupKey,
        name: item.groupName,
        order: item.groupOrder,
        pinned: false,
        items: [],
        abnormalCount: 0,
        subgroups: []
      });
    }
    const section = grouped.get(item.groupKey)!;
    section.items.push(item);
    if (item.attentionLevel === "abnormal") section.abnormalCount += 1;
  }
  for (const section of grouped.values()) {
    section.items.sort(compareTrendSeries);
    if (section.key === "laboratory") {
      const subgroups = new Map<string, { key: string; name: string; order: number; items: TrendSeries[] }>();
      for (const item of section.items) {
        const key = item.subgroupKey || "laboratory_other";
        if (!subgroups.has(key)) {
          subgroups.set(key, {
            key,
            name: item.subgroupName || "其他检验",
            order: item.subgroupOrder,
            items: []
          });
        }
        subgroups.get(key)!.items.push(item);
      }
      section.subgroups = [...subgroups.values()].sort((left, right) => left.order - right.order);
    }
    result.push(section);
  }
  return result.sort((left, right) => left.order - right.order);
});

const hasActiveFilters = computed(() =>
  Boolean(query.value.trim()) || groupFilter.value.length > 0 || attentionFilter.value !== "all"
);

const trendCountSubtitle = computed(() => {
  if (!series.value.length) return "";
  const pointCount = series.value.reduce((sum, item) => sum + item.pointCount, 0);
  return `共 ${series.value.length} 项指标${pointCount ? ` · ${pointCount} 个数据点` : ""}`;
});

const filterSummary = computed(() => {
  if (!series.value.length) return "";
  const group = selectedGroup.value ? ` · ${selectedGroup.value.name}` : '';
  const keyword = query.value.trim() ? ` · “${query.value.trim()}”` : "";
  const attention = attentionFilter.value === "abnormal"
    ? " · 报告已标异常"
    : attentionFilter.value === "near_boundary"
      ? " · 接近参考边界"
      : attentionFilter.value === "attention"
        ? " · 需要关注"
        : attentionFilter.value === "unflagged" ? " · 未列入关注" : "";
  return `显示 ${filteredSeries.value.length} / ${series.value.length} 项${group}${attention}${keyword}`;
});

async function load(memberId: string, silent = false) {
  const sequence = ++loadRequest;
  if (!silent) loading.value = true;
  loadError.value = "";
  closeDetails();
  try {
    const params = `memberId=${encodeURIComponent(memberId)}`;
    const [result, tree] = await Promise.all([
      request<TrendSeries[]>(`trends?${params}`), request<TrendGroupNode[]>(`trends/groups?${params}`)
    ]);
    if (app.selectedMemberId.value === memberId && sequence === loadRequest) {
      series.value = result;
      groupTree.value = tree;
      const availableKeys = new Set(flattenTrendGroups(tree).filter(g => g.indicatorCount > 0).map(g => g.key));
      if (groupFilter.value && !availableKeys.has(groupFilter.value)) groupFilter.value = '';
      else await filterGroups();
    }
  }
  catch (cause) {
    if (!silent && app.selectedMemberId.value === memberId && sequence === loadRequest) loadError.value = cause instanceof Error ? cause.message : "指标趋势加载失败";
    throw cause;
  }
  finally { if (!silent && app.selectedMemberId.value === memberId && sequence === loadRequest) loading.value = false; }
}

function compareTrendSeries(left: TrendSeries, right: TrendSeries) {
  return Number(right.pinned) - Number(left.pinned)
    || ((groupResultOrder.value.get(left.indicatorKey) ?? 9999) - (groupResultOrder.value.get(right.indicatorKey) ?? 9999))
    || left.groupOrder - right.groupOrder
    || left.subgroupOrder - right.subgroupOrder
    || left.itemOrder - right.itemOrder
    || left.name.localeCompare(right.name, "zh-CN")
    || String(left.unit || "").localeCompare(String(right.unit || ""), "zh-CN");
}

function trendPinRequestKey(memberId: string, item: TrendSeries) {
  return `${memberId}\u0000${item.indicatorKey}\u0000${item.unit || ""}`;
}

function pinPending(item: TrendSeries) {
  const memberId = app.selectedMemberId.value;
  return Boolean(memberId && pinPendingKeys.value.has(trendPinRequestKey(memberId, item)));
}

function setPinPending(key: string, pending: boolean) {
  const next = new Set(pinPendingKeys.value);
  if (pending) next.add(key);
  else next.delete(key);
  pinPendingKeys.value = next;
}

async function toggleTrendPin(item: TrendSeries) {
  const memberId = app.selectedMemberId.value;
  if (!memberId) return;
  const requestKey = trendPinRequestKey(memberId, item);
  if (pinPendingKeys.value.has(requestKey)) return;
  setPinPending(requestKey, true);
  try {
    const result = await request<{ pinned: boolean }>("trends/pins", {
      method: item.pinned ? "DELETE" : "POST",
      body: JSON.stringify({
        memberId,
        indicatorKey: item.indicatorKey,
        unit: item.unit
      })
    });
    if (app.selectedMemberId.value !== memberId) return;
    const current = series.value.find((candidate) =>
      candidate.indicatorKey === item.indicatorKey && (candidate.unit || "") === (item.unit || "")
    );
    if (current) current.pinned = result.pinned;
    series.value = [...series.value].sort(compareTrendSeries);
    toast.show(result.pinned ? `已置顶“${item.name}”` : `已取消置顶“${item.name}”`);
  } catch (cause) {
    toast.show(cause instanceof Error ? cause.message : "指标置顶操作失败");
  } finally {
    setPinPending(requestKey, false);
  }
}

function retryLoad() {
  const memberId = app.selectedMemberId.value;
  if (memberId) load(memberId).catch(() => {});
}

function reloadTrends() {
  const memberId = app.selectedMemberId.value;
  if (!memberId) return;
  load(memberId, true).catch((cause) => console.warn("[health-records] 指标趋势后台刷新失败", cause));
  loadAdminIssueCount();
}

// 问题池接口仅管理员可访问，非管理员直接跳过，避免无谓的 403
function loadAdminIssueCount() {
  if (!app.session.value?.isAdmin) return;
  request<IndicatorNormalizationMetrics>("maintenance/indicator-normalization/metrics")
    .then((metrics) => { adminIssueCount.value = metrics.totals.issueGroups; })
    .catch(() => {});
}

useRefreshOnActivate(reloadTrends);

function formatNumber(value: number | null) {
  if (value === null) return "—";
  if (Math.abs(value) >= 100) return value.toFixed(1).replace(/\.0$/, "");
  if (Math.abs(value) >= 10) return value.toFixed(2).replace(/0$/, "").replace(/\.$/, "");
  return value.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}

function scaleOf(item: TrendSeries) {
  return item.valueScale || null;
}

function notationOf(scale: TrendValueScale) {
  const stored = scaleNotations.value[scale.type];
  return scale.notations.some((entry) => entry.key === stored) ? stored : canonicalNotation(scale);
}

function setScaleNotation(scale: TrendValueScale, notation: string) {
  scaleNotations.value = { ...scaleNotations.value, [scale.type]: notation };
  localStorage.setItem(SCALE_NOTATION_STORAGE_KEY, JSON.stringify(scaleNotations.value));
}

function scaleNotationTitle(item: TrendSeries) {
  const scale = scaleOf(item);
  return scale ? notationTitle(scale, notationOf(scale)) : "";
}

/** 登记了表示法的序列按当前选择换算展示值，其余序列保持原值。 */
function formatSeriesNumber(item: TrendSeries, value: number | null) {
  if (value === null) return "—";
  const scale = scaleOf(item);
  if (scale) return formatScaledValue(scale, value, notationOf(scale));
  return formatNumber(value);
}

/** 非 canonical 表示法下差值也按展示口径换算（如视力五分模式 +0.1 表示提升一行）。 */
function displayDelta(item: TrendSeries) {
  if (item.delta === null) return null;
  const scale = scaleOf(item);
  if (!scale) return item.delta;
  const notation = notationOf(scale);
  if (notation === canonicalNotation(scale) || item.latestValue === null || item.previousValue === null) {
    return item.delta;
  }
  const diff = convertScaledValue(scale, item.latestValue, notation) - convertScaledValue(scale, item.previousValue, notation);
  const precision = scaledDeltaPrecision(scale, notation);
  return precision === null ? diff : Number(diff.toFixed(precision));
}

/** 差值绝对值的格式化：表示法提供精度时按精度，否则通用数字格式。 */
function formatDeltaMagnitude(item: TrendSeries, delta: number) {
  const scale = scaleOf(item);
  const precision = scale ? scaledDeltaPrecision(scale, notationOf(scale)) : null;
  return precision === null ? formatNumber(Math.abs(delta)) : Math.abs(delta).toFixed(precision);
}

function formatDate(value: string | null) {
  if (!value) return "日期待确认";
  return value.slice(0, 10);
}

function pointValue(item: TrendSeries, point: TrendPoint) {
  return [formatSeriesNumber(item, point.numericValue), item.unit].filter(Boolean).join(" ");
}

/* 部分报告的 resultText 已包含单位，避免 “89 mmHg mmHg” 重复展示 */
function excludedPointText(point: TrendExcludedPoint) {
  const result = (point.resultText || "").trim();
  const unit = (point.unit || "").trim();
  if (!result) return unit;
  if (!unit) return result;
  return result.toLowerCase().endsWith(unit.toLowerCase()) ? result : `${result} ${unit}`;
}

function pointAbnormalDisplay(point: TrendPoint) {
  return describeObservationAbnormal(point);
}

function pointFlagClass(point: TrendPoint) {
  const display = pointAbnormalDisplay(point);
  const toneClass = {
    high: "up",
    low: "down",
    abnormal: "warn",
    normal: "ok",
    review: "plain",
    plain: "plain",
  }[display.tone];
  return [toneClass, { review: display.isConflict, computed: display.isComputed }];
}

function pointFlagLabel(point: TrendPoint) {
  return pointAbnormalDisplay(point).label;
}

function pointFlagVisible(point: TrendPoint) {
  return pointAbnormalDisplay(point).visible;
}

function pointInterpretationLine(point: TrendPoint) {
  return pointAbnormalDisplay(point).explanation;
}

function qualityLabel(value: TrendSeries["quality"]) {
  return {
    high: "高可信",
    medium: "中可信",
    low: "低可信",
    excluded: "未纳入",
    raw: "机构内 · 未标准化"
  }[value] || "原始展示";
}

function latestPoint(item: TrendSeries) {
  return item.points[item.points.length - 1] || null;
}

function referenceSummary(point: TrendPoint | null, unit: string | null) {
  if (!point) return "参考范围待整理";
  return formatReferenceRange({
    referenceLow: point.referenceLow,
    referenceHigh: point.referenceHigh,
    referenceText: point.referenceText,
    unit: point.referenceText ? null : unit,
    formatNumber
  });
}

// 数据点没有整理出任何参考信息时不展示占位文案，减少干扰、不占行高。
function hasReferenceInfo(point: TrendPoint) {
  return Boolean(
    (point.referenceText || "").trim()
    || point.referenceLow !== null
    || point.referenceHigh !== null
  );
}

function trendValueRange(item: TrendSeries) {
  if (item.pointCount < 2 || item.typicalMinValue === null || item.typicalMaxValue === null) return null;
  if (item.typicalMinValue === item.typicalMaxValue) return null;
  return `${formatSeriesNumber(item, item.typicalMinValue)} - ${formatSeriesNumber(item, item.typicalMaxValue)}${item.unit || ""}`;
}

function trendValueRangeLabel(item: TrendSeries) {
  return item.outlierCount ? "常见区间" : "变化区间";
}

function trendDateRange(item: TrendSeries) {
  if (item.pointCount < 2 || !item.firstDate || !item.lastDate) return null;
  const first = formatDate(item.firstDate);
  const last = formatDate(item.lastDate);
  return first !== last ? `${first} 至 ${last}` : null;
}

function cardDomId(item: TrendSeries) {
  const value = seriesKey(item);
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `trend-card-${(hash >>> 0).toString(36)}`;
}

function sectionClusters(section: TrendSection) {
  return section.subgroups.length
    ? section.subgroups
    : [{ key: `${section.key}-all`, name: "", order: 0, items: section.items }];
}

function groupExpanded(section: TrendSection) {
  return Boolean(query.value.trim() || attentionFilter.value !== "all")
    || !collapsedGroups.value.has(section.key);
}

function toggleGroup(section: TrendSection) {
  const next = new Set(collapsedGroups.value);
  if (next.has(section.key)) next.delete(section.key);
  else next.add(section.key);
  collapsedGroups.value = next;
}

function deltaText(item: TrendSeries) {
  if (item.pointCount <= 1 || item.latestChangeStatus === "baseline") return "基线";
  if (!item.changeAssessmentAllowed && item.pointCount > 1) return "暂不比较";
  if (item.latestChangeStatus === "not_comparable") return "暂不比较";
  if (!item.latestChangeConclusionAllowed || item.latestChangeStatus === "needs_review") return "变化待核验";
  if (item.latestChangeStatus === "unchanged" || item.delta === 0) return "较上次持平";
  if (item.delta === null) return "变化待核验";
  const delta = displayDelta(item);
  if (delta === null) return "变化待核验";
  if (delta === 0) return "较上次持平";
  return `较上次 ${delta > 0 ? "+" : delta < 0 ? "-" : ""}${formatDeltaMagnitude(item, delta)}`;
}

function deltaClass(item: TrendSeries) {
  if (!item.latestChangeConclusionAllowed || item.latestChangeStatus === "unchanged") return "neutral";
  if (item.latestChangeStatus === "increase") return "up";
  if (item.latestChangeStatus === "decrease") return "down";
  return "neutral";
}

function intervalLabel(days: number | null) {
  if (days === null) return "间隔未知";
  if (days === 0) return "同日记录";
  if (days < 30) return `间隔 ${days} 天`;
  if (days < 365) return `间隔约 ${Math.max(1, Math.round(days / 30))} 个月`;
  const years = days / 365;
  return `间隔约 ${Number.isInteger(years) ? years : years.toFixed(1)} 年`;
}

function magnitudeLabel(item: TrendSeries) {
  return {
    unavailable: "幅度暂不判断",
    unchanged: "数值基本持平",
    small: "较小幅度变化",
    moderate: "一般幅度变化",
    large: "较大幅度变化"
  }[item.latestChangeMagnitude];
}

function trendStatusLabel(item: TrendSeries) {
  return {
    baseline: "单次基线",
    stable: "整体稳定",
    sustained_rise: "数值连续上升",
    sustained_fall: "数值连续下降",
    fluctuating: "存在波动",
    insufficient_evidence: "趋势证据不足"
  }[item.trendStatus];
}

function abnormalContinuityLabel(item: TrendSeries) {
  if (item.abnormalContinuityStatus === "latest_abnormal") return "仅本次异常";
  if (item.abnormalContinuityStatus === "persistent_abnormal") return `连续 ${item.consecutiveAbnormalCount} 次异常`;
  if (item.abnormalContinuityStatus === "recovered") return "最新已回到参考范围";
  if (item.abnormalContinuityStatus === "near_boundary") return "最新接近参考边界";
  if (item.abnormalContinuityStatus === "conflict") return "异常标记待核验";
  if (item.abnormalContinuityStatus === "insufficient_evidence") return "异常连续性证据不足";
  return "未见连续异常";
}

function latestChangeDetail(item: TrendSeries) {
  if (item.delta === null) return "目前没有可计算的前次差值";
  const value = displayDelta(item) ?? item.delta;
  const delta = `${value > 0 ? "+" : value < 0 ? "-" : ""}${formatDeltaMagnitude(item, value)}${item.unit || ""}`;
  return `算术差值 ${delta} · ${intervalLabel(item.latestIntervalDays)} · ${magnitudeLabel(item)}`;
}


function comparabilityLabel(item: TrendSeries) {
  if (item.comparabilityStatus === "range_drift") return "参考范围发生变化";
  if (item.comparabilityStatus === "condition_mismatch") return "检测条件可能不同";
  if (item.comparabilityStatus === "insufficient_evidence") return "参考条件信息不完整";
  return "可直接比较";
}

function showTrendChangeSummary(item: TrendSeries) {
  // “趋势证据不足”不构成结论，收进 ! 图标弹层；其余状态是有效结论，直接展示。
  return item.pointCount > 1
    && item.changeAssessmentAllowed
    && item.trendStatus !== "insufficient_evidence";
}

// ! 入口只保留真正需要用户核对的罕见问题：异常标记冲突、检测条件不同
// （标本/方法/年龄阶段变化，数值本身不可比）。参考范围漂移在年度体检间很常见，
// 已由“暂不比较”差值文案表达；证据不足等默认状态不再提示。
function collapsedNotices(item: TrendSeries) {
  const notices: Array<{ cls: string; text: string }> = [];
  if (item.abnormalContinuityStatus === "conflict") {
    notices.push({
      cls: "conflict",
      text: `${abnormalContinuityLabel(item)}${abnormalContinuityDetail(item) ? ` · ${abnormalContinuityDetail(item)}` : ""}`
    });
  }
  if (item.pointCount > 1 && item.comparabilityStatus === "condition_mismatch") {
    notices.push({
      cls: item.comparabilityStatus,
      text: `${comparabilityLabel(item)} · ${item.comparabilityReason || "数值保留，变化结论需谨慎"}`
    });
  }
  return notices;
}

function showMultiPointTrendDetail(item: TrendSeries) {
  return item.pointCount > 1 && (item.changeAssessmentAllowed || item.trendConclusionAllowed);
}

function abnormalContinuityDetail(item: TrendSeries) {
  const parts = [item.abnormalContinuityReason];
  if (item.attentionReason && item.attentionReason !== item.abnormalContinuityReason) parts.push(item.attentionReason);
  return parts.filter(Boolean).join(" · ");
}

function trendChartPoints(item: TrendSeries) {
  const values = item.points.map((point) => point.numericValue);
  if (!values.length) return [];
  const min = item.typicalMinValue ?? Math.min(...values);
  const max = item.typicalMaxValue ?? Math.max(...values);
  const span = max - min || 1;
  return item.points.map((point, index) => {
    const ratio = Math.max(0, Math.min(1, (point.numericValue - min) / span));
    return {
      point,
      x: values.length === 1 ? 50 : 12 + (index / (values.length - 1)) * 76,
      y: values.length === 1 ? 46 : 62 - ratio * 34
    };
  });
}

function trendChartPolyline(item: TrendSeries) {
  return trendChartPoints(item)
    .map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`)
    .join(" ");
}

function trendChartMinWidth(item: TrendSeries) {
  return `${Math.max(320, item.points.length * 88)}px`;
}

function trendNodeLabel(point: TrendPoint, item: TrendSeries) {
  const review = point.trendOutlier ? "，该点与其余记录差异较大" : "";
  return `${item.name} ${pointValue(item, point)}，${formatDate(point.reportIssuedAt)}${review}，点击查看来源`;
}

function recentPoints(item: TrendSeries) {
  return [...item.points].reverse().slice(0, 6);
}

function seriesKey(item: TrendSeries) {
  return `${item.indicatorKey}\u0000${item.unit || ""}`;
}

function detailsOpen(item: TrendSeries) {
  return activeDetailKey.value === seriesKey(item);
}


function closeDetails() {
  activeDetailKey.value = null;
  detailPopoverStyle.value = {};
}

function popoverAnchorFrame(event: MouseEvent) {
  const anchor = (event.currentTarget as HTMLElement).getBoundingClientRect();
  const mobile = window.matchMedia("(max-width: 760px)").matches;
  const horizontalMargin = mobile ? 12 : 16;
  const topInset = mobile ? 70 : 12;
  const bottomInset = mobile ? 82 : 12;
  const gap = 8;
  const width = Math.min(360, window.innerWidth - horizontalMargin * 2);
  const preferredHeight = Math.min(mobile ? 560 : 420, window.innerHeight * (mobile ? 0.66 : 0.62));
  const availableBelow = window.innerHeight - bottomInset - anchor.bottom - gap;
  const availableAbove = anchor.top - topInset - gap;
  const placement = availableBelow >= Math.min(preferredHeight, 260) || availableBelow >= availableAbove
    ? "below"
    : "above";
  const availableHeight = placement === "below" ? availableBelow : availableAbove;
  const maxHeight = Math.max(96, Math.min(preferredHeight, availableHeight));
  const left = Math.max(
    horizontalMargin,
    Math.min(anchor.right - width, window.innerWidth - horizontalMargin - width)
  );

  return {
    placement: placement as "above" | "below",
    style: {
      left: `${left}px`,
      width: `${width}px`,
      maxHeight: `${maxHeight}px`,
      ...(placement === "below"
        ? { top: `${anchor.bottom + gap}px`, bottom: "auto" }
        : { top: "auto", bottom: `${window.innerHeight - anchor.top + gap}px` })
    }
  };
}

function toggleDetails(item: TrendSeries, event: MouseEvent) {
  const key = seriesKey(item);
  if (activeDetailKey.value === key) {
    closeDetails();
    return;
  }

  const frame = popoverAnchorFrame(event);
  closeDetails();
  detailPopoverPlacement.value = frame.placement;
  detailPopoverStyle.value = frame.style;
  activeDetailKey.value = key;
}


function openReport(reportId: string) {
  closeDetails();
  previewReportId.value = reportId;
}

function openSourcePage(point: TrendPoint | TrendExcludedPoint, item: TrendSeries) {
  closeDetails();
  if (!point.sourcePage) {
    openReport(point.reportId);
    return;
  }
  sourcePreview.value = { point, seriesName: item.name, unit: item.unit };
}

function closeSourcePage() {
  sourcePreview.value = null;
}

function openSourceReport() {
  const reportId = sourcePreview.value?.point.reportId;
  if (!reportId) return;
  closeSourcePage();
  openReport(reportId);
}

const root = ref<HTMLElement | null>(null);
const toast = useToast();
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
  ++loadRequest;
  ++groupRequest;
  series.value = [];
  groupTree.value = [];
  groupFilter.value = '';
  groupResultKeys.value = null;
  groupError.value = '';
  groupPending.value = false;
  if (!memberId) return;
  load(memberId).catch(() => {});
}, { immediate: true });

// session 可能在页面挂载后才就绪，这里等管理员身份确定后再拉取待治理数
watch(() => app.session.value?.isAdmin, (isAdmin) => {
  if (isAdmin) loadAdminIssueCount();
}, { immediate: true });

watch([query, groupFilter, attentionFilter], () => {
  closeDetails();
});
watch(groupFilter, filterGroups);

watch(trendCountSubtitle, (subtitle) => app.setTopbarSubtitle("trends", subtitle), { immediate: true });

function activateTopbarSearch() {
  app.setTopbarSearch({
    key: "trends",
    model: query,
    placeholder: "搜索指标",
    expandedPlaceholder: "搜索指标名称"
  });
}

function nextRouteUsesTopbarSearch() {
  return route.path === "/records" || route.path === "/trends" || route.path.startsWith("/trends/");
}

onMounted(() => {
  window.addEventListener("resize", closeDetails, { passive: true });
  // 弹层是 fixed 定位，窗口滚动后会与锚点卡片脱离，滚动时直接关闭
  window.addEventListener("scroll", closeDetails, { passive: true });
  activateTopbarSearch();
});
onBeforeUnmount(() => {
  window.removeEventListener("resize", closeDetails);
  window.removeEventListener("scroll", closeDetails);
  app.clearTopbarSubtitle("trends");
  app.clearTopbarSearch("trends");
});
onActivated(() => {
  app.setTopbarSubtitle("trends", trendCountSubtitle.value);
  activateTopbarSearch();
});
onDeactivated(() => {
  if (!nextRouteUsesTopbarSearch()) app.clearTopbarSearch("trends");
});
</script>

<template>
  <section ref="root" class="plain-page">
    <div class="page-intro"><div><h2>指标趋势</h2><p>{{ trendCountSubtitle || "仅比较相同指标和兼容单位" }}</p></div><span class="page-intro-badge"><ChartNoAxesCombined :size="22" /></span></div>
    <nav class="trend-view-switch" aria-label="趋势视图">
      <RouterLink to="/trends" aria-current="page">指标趋势</RouterLink>
      <RouterLink to="/trends/morphology">形态变化</RouterLink>
    </nav>
    <PullIndicator :distance="pullDistance" :refreshing="refreshing" />
    <div v-if="loading" class="loading-list"><span v-for="index in 3" :key="index"></span></div>
    <p v-else-if="loadError" class="inline-panel-error">
      {{ loadError }}<button class="error-retry" type="button" @click="retryLoad">重试</button>
    </p>
    <EmptyState v-else-if="!series.length" title="暂无可比较指标" description="AI 整理出结构化数值后，这里会展示单次基线值和多次趋势。" />
    <template v-else>
      <div class="trend-filter-row">
        <label class="search-field trend-search-field page-search-field">
          <Search :size="18" />
          <input v-model="query" placeholder="搜索指标名" />
        </label>
        <TrendGroupFilter v-model="groupFilter" :groups="groupTree" class="trend-group-select" />
        <FormSelect v-model="attentionFilter" class="trend-status-select records-filter-select" :options="attentionOptions" aria-label="指标状态" />
      </div>
      <p v-if="hasActiveFilters" class="trend-filter-summary">{{ filterSummary }}</p>
      <p v-if="groupPending" role="status" class="trend-filter-summary">正在筛选…</p>
      <p v-if="groupError" class="inline-panel-error">{{ groupError }}<button type="button" @click="filterGroups">重试</button></p>
      <RouterLink v-if="adminIssueCount > 0" class="trend-admin-issue-entry" to="/me/maintenance/indicator-issues">
        <CircleAlert :size="16" />
        <span>{{ adminIssueCount }} 组指标可核对或补充标准化</span>
        <ChevronRight :size="16" />
      </RouterLink>
      <EmptyState
        v-if="!filteredSeries.length && !groupPending && !groupError"
        title="没有符合条件的指标"
        description="换个指标名、体检分组或指标状态试试，也可以等待更多报告完成整理。"
      />
      <div v-else class="trend-sections">
        <section v-for="section in trendSections" :key="section.key" class="trend-section">
          <button
            class="trend-section-header"
            type="button"
            :aria-expanded="groupExpanded(section)"
            @click="toggleGroup(section)"
          >
            <span>
              <Pin v-if="section.pinned" :size="18" fill="currentColor" />
              <strong>{{ section.name }}</strong>
              <small>{{ section.items.length }} 项</small>
              <em v-if="section.abnormalCount">{{ section.abnormalCount }} 项异常</em>
            </span>
            <ChevronDown :size="19" :class="{ collapsed: !groupExpanded(section) }" />
          </button>
          <div v-if="groupExpanded(section)" class="trend-section-body">
            <section v-for="cluster in sectionClusters(section)" :key="cluster.key" class="trend-subsection">
              <h3 v-if="cluster.name">{{ cluster.name }}<small>{{ cluster.items.length }} 项</small></h3>
              <div class="trend-list">
                <article
                  v-for="item in cluster.items"
                  :id="cardDomId(item)"
                  :key="`${item.indicatorKey}-${item.unit}`"
                  class="trend-card"
                  :class="item.attentionLevel ? ['attention', item.attentionLevel] : item.attentionConflict ? ['attention-conflict'] : []"
                >
          <header class="trend-card-header">
            <span class="item-icon"><Activity :size="19" /></span>
            <div>
              <div class="trend-title-row">
                <strong>{{ item.name }}</strong>
                <em class="trend-delta" :class="deltaClass(item)">{{ deltaText(item) }}</em>
              </div>
              <span>{{ item.pointCount }} 个数据点 · {{ item.unit || (scaleOf(item) ? scaleNotationTitle(item) : "无单位") }} · {{ qualityLabel(item.quality) }}</span>
              <span v-if="scaleOf(item)" class="scale-notation-switch" role="group" :aria-label="`${item.name}显示方式切换`">
                <button
                  v-for="notation in scaleOf(item)!.notations"
                  :key="notation.key"
                  type="button"
                  :class="{ active: notationOf(scaleOf(item)!) === notation.key }"
                  :aria-pressed="notationOf(scaleOf(item)!) === notation.key"
                  :title="`按${notation.title || notation.label}显示`"
                  @click="setScaleNotation(scaleOf(item)!, notation.key)"
                >{{ notation.label }}</button>
              </span>
              <small v-if="item.kind === 'institution'" class="trend-match-alias">{{ item.points[0]?.hospitalName }} · {{ item.points[0]?.comparisonMethod || '方法未注明' }} · {{ item.points[0]?.comparisonSpecimen || '标本未注明' }}</small>
              <small v-if="matchingAlias(item)" class="trend-match-alias">匹配名称：{{ matchingAlias(item) }}</small>
            </div>
            <button
              class="trend-pin-button"
              :class="{ active: item.pinned }"
              type="button"
              :disabled="pinPending(item)"
              :title="item.pinned ? '取消置顶' : '置顶指标'"
              :aria-label="`${item.pinned ? '取消置顶' : '置顶'}${item.name}`"
              :aria-pressed="item.pinned"
              @click="toggleTrendPin(item)"
            >
              <Pin :size="17" :fill="item.pinned ? 'currentColor' : 'none'" />
            </button>
          </header>
          <div class="trend-main">
            <div class="trend-latest">
              <span>最新值</span>
              <strong>{{ formatSeriesNumber(item, item.latestValue) }}<small v-if="item.unit">{{ item.unit }}</small></strong>
              <p>{{ formatDate(item.lastDate) }}<template v-if="item.pointCount === 1"> · 目前只有一次记录</template></p>
              <small v-if="showTrendChangeSummary(item)" class="trend-change-summary" :class="item.trendStatus">
                {{ trendStatusLabel(item) }}<template v-if="item.latestIntervalDays !== null"> · {{ intervalLabel(item.latestIntervalDays) }}</template>
              </small>
              <div class="trend-detail-popover-wrap">
                <IndicatorHint v-if="collapsedNotices(item).length" :text="collapsedNotices(item).map(notice => notice.text).join('\n')" :label="`${item.name}的指标提示`" />
                <button
                  class="trend-detail-toggle"
                  type="button"
                  :aria-expanded="detailsOpen(item)"
                  @click="toggleDetails(item, $event)"
                >
                  整理详情
                  <template v-if="item.excludedPoints.length"> · {{ item.excludedPoints.length }}</template>
                </button>
                <Teleport to="body">
                  <div v-if="detailsOpen(item)" class="trend-detail-popover-backdrop" @click="closeDetails"></div>
                  <section
                    v-if="detailsOpen(item)"
                    class="trend-normalization-popover"
                    :class="`placement-${detailPopoverPlacement}`"
                    :style="detailPopoverStyle"
                    role="dialog"
                    aria-label="指标整理详情"
                    @click.stop
                  >
                    <header class="trend-normalization-popover-header">
                      <strong>整理详情</strong>
                      <button type="button" title="关闭" aria-label="关闭整理详情" @click="closeDetails">
                        <X :size="17" />
                      </button>
                    </header>
                    <div>
                      <span>指标说明</span>
                      <p>{{ item.explanation || "暂未形成可靠说明，可查看原报告或等待指标字典更新。" }}</p>
                    </div>
                    <div>
                      <span>本次结果</span>
                      <p>
                        {{ formatSeriesNumber(item, item.latestValue) }}{{ item.unit || "" }}
                        · {{ referenceSummary(latestPoint(item), item.unit) }}
                      </p>
                    </div>
                    <div v-if="item.abnormalContinuityStatus !== 'none'">
                      <span>异常连续性</span>
                      <p>{{ abnormalContinuityLabel(item) }}<template v-if="abnormalContinuityDetail(item)"> · {{ abnormalContinuityDetail(item) }}</template></p>
                    </div>
                    <div v-if="item.pointCount > 1">
                      <span>最近变化</span>
                      <p>{{ latestChangeDetail(item) }}<template v-if="item.latestChangeReason"> · {{ item.latestChangeReason }}</template></p>
                    </div>
                    <div v-if="showMultiPointTrendDetail(item)">
                      <span>多次趋势</span>
                      <p>{{ trendStatusLabel(item) }} · {{ item.trendReason }}</p>
                    </div>
                    <div v-if="item.pointCount > 1">
                      <span>跨报告比较</span>
                      <p>{{ comparabilityLabel(item) }}<template v-if="item.comparabilityReason"> · {{ item.comparabilityReason }}</template></p>
                    </div>
                    <p class="trend-detail-part-title">系统整理信息</p>
                    <div>
                      <span>整理依据</span>
                      <p v-if="item.matchReasons.length">{{ item.matchReasons.join("；") }}</p>
                      <p v-else>按原始名称和单位展示。</p>
                    </div>
                    <div>
                      <span>已纳入名称</span>
                      <p>{{ item.sourceNames.length ? item.sourceNames.join("、") : "暂无" }}</p>
                    </div>
                    <div v-if="item.excludedPoints.length">
                      <span>相似但未纳入</span>
                      <article v-for="point in item.excludedPoints" :key="point.observationId" class="trend-excluded-point">
                        <div>
                          <strong>{{ point.itemName }} · {{ excludedPointText(point) }}</strong>
                          <small>{{ formatDate(point.reportIssuedAt) }} · {{ point.hospitalName || "医院待整理" }} · {{ point.reason }}</small>
                        </div>
                        <button v-if="point.sourcePage" type="button" @click="openSourcePage(point, item)">原图</button>
                        <button type="button" @click="openReport(point.reportId)">报告</button>
                      </article>
                    </div>
                  </section>
                </Teleport>
              </div>
            </div>
            <div class="trend-chart-scroll">
              <div class="trend-chart-canvas" :style="{ minWidth: trendChartMinWidth(item) }">
                <svg class="trend-sparkline" viewBox="0 0 100 96" preserveAspectRatio="none" aria-hidden="true">
                  <line x1="4" y1="64" x2="96" y2="64" />
                  <polyline v-if="item.kind !== 'institution' || item.comparable" :points="trendChartPolyline(item)" />
                </svg>
                <button
                  v-for="chartPoint in trendChartPoints(item)"
                  :key="chartPoint.point.observationId"
                  class="trend-chart-node"
                  :class="{ latest: chartPoint.point === item.points[item.points.length - 1], outlier: chartPoint.point.trendOutlier }"
                  type="button"
                  :style="{ left: `${chartPoint.x}%`, '--point-y': `${chartPoint.y}%` }"
                  :aria-label="trendNodeLabel(chartPoint.point, item)"
                  @click="openSourcePage(chartPoint.point, item)"
                >
                  <span class="trend-chart-value">{{ formatSeriesNumber(item, chartPoint.point.numericValue) }}</span>
                  <i :class="pointFlagClass(chartPoint.point)"></i>
                  <time>{{ formatDate(chartPoint.point.reportIssuedAt) }}</time>
                </button>
              </div>
            </div>
          </div>
          <div v-if="trendValueRange(item) || trendDateRange(item)" class="trend-range">
            <div class="trend-range-copy">
              <span v-if="trendValueRange(item)">{{ trendValueRangeLabel(item) }} {{ trendValueRange(item) }}<template v-if="item.outlierCount"> · {{ item.outlierCount }} 个差异较大点未参与区间计算</template></span>
              <span v-if="trendDateRange(item)">{{ trendDateRange(item) }}</span>
            </div>
          </div>
          <div class="trend-points">
            <article v-for="point in recentPoints(item)" :key="`${item.name}-${point.reportId}-${point.observationId}`">
              <div>
                <strong>{{ pointValue(item, point) }}<em v-if="pointFlagVisible(point)" class="trend-flag" :class="pointFlagClass(point)" :title="point.abnormalReason || undefined">{{ pointFlagLabel(point) }}</em></strong>
                <span>{{ formatDate(point.reportIssuedAt) }} · {{ point.hospitalName || "医院待整理" }}</span>
                <small v-if="hasReferenceInfo(point)">{{ referenceSummary(point, item.unit) }}</small>
                <small v-if="pointInterpretationLine(point)" class="trend-point-interpretation">{{ pointInterpretationLine(point) }}</small>
                <small v-if="point.trendOutlier" class="trend-point-outlier">{{ point.trendOutlierReason }}</small>
                <small v-if="trendPointProcessingHint(point)" class="trend-point-lifecycle">{{ trendPointProcessingHint(point) }}</small>
              </div>
              <button v-if="point.sourcePage" class="trend-source-button" type="button" title="查看指标所在页高清图" @click="openSourcePage(point, item)">原图</button>
              <button type="button" title="打开来源报告" @click="openReport(point.reportId)">
                <ChevronRight :size="18" />
              </button>
            </article>
          </div>
                </article>
              </div>
            </section>
          </div>
        </section>
      </div>
    </template>
    <ReportDetailModal :open="Boolean(previewReportId)" :report-id="previewReportId" @close="previewReportId = null" @updated="reloadTrends" />
    <ImageViewer
      v-if="sourcePreview"
      :pages="sourceViewerPages"
      :ocr-detail="sourceOcrDetail"
      :highlight-line-ids="sourcePreview.point.sourceLineIds"
      :accent-line-ids="sourcePreview.point.resultLineIds"
      auto-locate
      @close="closeSourcePage"
    >
      <template #actions>
        <button type="button" title="打开来源报告详情" @click="openSourceReport"><FileText :size="18" /></button>
      </template>
    </ImageViewer>
    <BackToTop />
  </section>
</template>
