<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import {
  AlertTriangle,
  BarChart3,
  Ban,
  CheckCircle2,
  Copy,
  Database,
  ExternalLink,
  History,
  Link2,
  Power,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldCheck,
  Sparkles
} from "@lucide/vue";
import EmptyState from "../../components/EmptyState.vue";
import FormSelect from "../../components/FormSelect.vue";
import IndicatorHint from "../../components/IndicatorHint.vue";
import ReportDetail from "../../components/ReportDetail.vue";
import SubPageHeader from "../../components/SubPageHeader.vue";
import { request } from "../../utils/api";
import { useToast } from "../../composables/useToast";
import { copyTextToClipboard } from "../../utils/clipboard";
import { formatRawIndicatorResult } from "../../utils/indicator-display";
import {
  buildIndicatorDictionaryIssueUrl,
  buildIndicatorFeedbackText,
  feedbackQqGroup,
  sanitizeIndicatorFeedbackName
} from "../../utils/indicator-feedback";
import type {
  IndicatorAliasGovernanceOverview,
  IndicatorAliasUpdateResult,
  IndicatorCatalogOption,
  IndicatorGovernanceHistoryItem,
  IndicatorGovernanceHistoryPage,
  IndicatorGovernanceResult,
  IndicatorGovernanceUndoResult,
  IndicatorNormalizationIssue,
  IndicatorNormalizationMetrics,
  IndicatorNormalizationSourceOrigin
} from "../../types/api";

const issues = ref<IndicatorNormalizationIssue[]>([]);
const reviewingIssue = ref<IndicatorNormalizationIssue | null>(null);
const showEligible = ref(false);
const metrics = ref<IndicatorNormalizationMetrics | null>(null);
const history = ref<IndicatorGovernanceHistoryItem[]>([]);
const historyTotal = ref(0);
const historyLoadingMore = ref(false);
const historyPageSize = 100;
const aliasOverview = ref<IndicatorAliasGovernanceOverview>({ aliases: [], conflicts: [] });
const historyBusyId = ref("");
const aliasBusyId = ref("");
const selectedNames = ref<string[]>([]);
const loading = ref(false);
const error = ref("");
const notice = ref("");
const noticeDetails = ref("");
const maxFeedbackNames = 40;

type IssueEditor = {
  open: boolean;
  query: string;
  options: IndicatorCatalogOption[];
  selectedCanonicalKey: string;
  saveAlias: boolean;
  aliasScope: string;
  reason: string;
  searching: boolean;
  submitting: boolean;
};

const editors = reactive<Record<string, IssueEditor>>({});

const aliasScopeOptions = [
  { value: "report_type", label: "仅同类报告（推荐）" },
  { value: "global", label: "所有报告类型" }
];

function catalogSelectOptions(options: IndicatorCatalogOption[]) {
  return options.map((option) => ({
    value: option.canonicalKey,
    label: `${option.displayName} · ${option.category}${option.defaultUnit ? ` · ${option.defaultUnit}` : ""}`
  }));
}

const displayedIssues = computed(() => issues.value.filter(item => showEligible.value ? item.trendEligible : !item.trendEligible).sort((left, right) =>
  right.count - left.count || (right.latestReportIssuedAt || "").localeCompare(left.latestReportIssuedAt || "")
));

function issueKey(value: string) {
  return sanitizeIndicatorFeedbackName(value)?.toLocaleLowerCase("zh-CN") || "";
}

const selectedIssueNames = computed(() => [...new Set(displayedIssues.value
  .filter((issue) => issue.status === "unknown" && selectedNames.value.includes(issueKey(issue.rawName)))
  .map((issue) => issue.rawName))]);
const selectableNames = computed(() => [...new Set(displayedIssues.value
  .filter((issue) => issue.status === "unknown")
  .map((issue) => issueKey(issue.rawName))
  .filter(Boolean))]);
const allSelected = computed(() => selectableNames.value.length > 0
  && selectableNames.value.slice(0, maxFeedbackNames).every((key) => selectedNames.value.includes(key)));
const feedbackUrl = computed(() => buildIndicatorDictionaryIssueUrl(selectedIssueNames.value));
const toast = useToast();

/* 反馈内容附应用与数据库版本，便于按字典运行环境排查；读取失败不阻塞反馈 */
const aboutInfo = ref<{ appVersion?: string; schemaVersion?: number }>({});
async function loadAboutInfo() {
  try {
    const summary = await request<{
      appVersion: string;
      database: { schemaVersion: number; appliedSchemaVersion: number };
    }>("about");
    aboutInfo.value = {
      appVersion: summary.appVersion,
      schemaVersion: summary.database?.appliedSchemaVersion || summary.database?.schemaVersion
    };
  } catch { /* 版本信息缺失不影响复制 */ }
}

const feedbackText = computed(() => buildIndicatorFeedbackText(selectedIssueNames.value, {
  appVersion: aboutInfo.value.appVersion,
  schemaVersion: aboutInfo.value.schemaVersion
}));

/** 无法访问 GitHub 的国内用户：复制同一份脱敏名单，粘贴到 QQ 群即可反馈。 */
async function copyFeedback() {
  if (!feedbackText.value) return;
  const copied = await copyTextToClipboard(feedbackText.value);
  toast.show(copied
    ? `已复制 ${selectedIssueNames.value.length} 项，请粘贴到 QQ 群 ${feedbackQqGroup} 反馈`
    : "复制失败，请稍后重试");
}

const sourceOriginLabels: Record<IndicatorNormalizationSourceOrigin, string> = {
  item_name: "报告项目名",
  item_code: "报告项目代码",
  combined: "名称与代码组合",
  ai_normalized_name: "AI 预整理名称",
  none: "尚无匹配来源",
  manual_confirmation: "人工确认",
  manual_exclusion: "人工排除",
  legacy: "历史整理结果"
};

const qualityLabels: Record<keyof IndicatorNormalizationMetrics["quality"], string> = {
  high: "高可信",
  medium: "中可信",
  low: "低可信",
  excluded: "已排除"
};

const qualityRows = computed(() => metrics.value
  ? (Object.keys(qualityLabels) as Array<keyof IndicatorNormalizationMetrics["quality"]>).map((quality) => ({
      quality,
      label: qualityLabels[quality],
      count: metrics.value?.quality[quality] || 0
    }))
  : []);

function metricPercent(value: number, total: number) {
  if (!total) return 0;
  return Math.min(100, Math.round((value / total) * 100));
}

function formatDate(value: string | null) {
  return value ? value.slice(0, 10) : "日期未知";
}

function formatDateTime(value: string) {
  return value.replace("T", " ").slice(0, 16);
}

function aliasScopeLabel(scope: IndicatorGovernanceHistoryItem["aliasScope"]) {
  if (scope === "report_type") return "同类报告";
  if (scope === "hospital") return "同医院";
  if (scope === "department") return "同科室";
  if (scope === "global") return "全局";
  return "未保存别名";
}

function historyEventLabel(item: IndicatorGovernanceHistoryItem) {
  if (item.eventType === "undo") return "撤销治理";
  if (item.eventType === "alias_enable") return "启用别名";
  if (item.eventType === "alias_disable") return "停用别名";
  return item.decisionAction === "exclude" ? "排除趋势" : "确认映射";
}

function toggleIssue(key: string) {
  selectedNames.value = selectedNames.value.includes(key)
    ? selectedNames.value.filter((item) => item !== key)
    : selectedNames.value.length < maxFeedbackNames ? [...selectedNames.value, key] : selectedNames.value;
}

function toggleAll() {
  selectedNames.value = allSelected.value ? [] : selectableNames.value.slice(0, maxFeedbackNames);
}

function ensureEditor(issue: IndicatorNormalizationIssue) {
  if (editors[issue.fingerprint]) return editors[issue.fingerprint];
  const candidate = issue.candidateCanonicalKey && issue.candidateCanonicalName ? [{
    canonicalKey: issue.candidateCanonicalKey,
    displayName: issue.candidateCanonicalName,
    category: "当前候选",
    defaultUnit: issue.candidateDefaultUnit,
    aliases: []
  }] : [];
  editors[issue.fingerprint] = {
    open: false,
    query: issue.candidateCanonicalName || issue.rawName,
    options: candidate,
    selectedCanonicalKey: issue.candidateCanonicalKey || "",
    saveAlias: false,
    aliasScope: "report_type",
    reason: "",
    searching: false,
    submitting: false
  };
  return editors[issue.fingerprint];
}

function toggleGovernance(issue: IndicatorNormalizationIssue) {
  const editor = ensureEditor(issue);
  editor.open = !editor.open;
  if (editor.open && !editor.options.length) void searchCatalog(issue);
}

async function searchCatalog(issue: IndicatorNormalizationIssue) {
  const editor = ensureEditor(issue);
  editor.searching = true;
  error.value = "";
  try {
    const options = await request<IndicatorCatalogOption[]>(
      `maintenance/indicator-normalization/catalog?q=${encodeURIComponent(editor.query.trim())}`
    );
    const current = issue.candidateCanonicalKey && issue.candidateCanonicalName ? [{
      canonicalKey: issue.candidateCanonicalKey,
      displayName: issue.candidateCanonicalName,
      category: "当前候选",
      defaultUnit: issue.candidateDefaultUnit,
      aliases: []
    }] : [];
    editor.options = [...new Map([...current, ...options].map((item) => [item.canonicalKey, item])).values()];
    if (!editor.selectedCanonicalKey && editor.options.length === 1) {
      editor.selectedCanonicalKey = editor.options[0]?.canonicalKey || "";
    }
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "标准指标查询失败";
  } finally {
    editor.searching = false;
  }
}

async function resolveIssue(issue: IndicatorNormalizationIssue, action: "confirm" | "exclude") {
  const editor = ensureEditor(issue);
  if (action === "confirm" && !editor.selectedCanonicalKey) {
    error.value = "请先搜索并选择一个标准指标";
    return;
  }
  if (action === "exclude" && !window.confirm(`确认将“${issue.rawName}”及同类记录排除出默认趋势吗？`)) return;
  editor.submitting = true;
  error.value = "";
  notice.value = "";
  noticeDetails.value = "";
  try {
    const result = await request<IndicatorGovernanceResult>(
      `maintenance/indicator-normalization/issues/${issue.fingerprint}/resolve`,
      {
        method: "POST",
        body: JSON.stringify({
          action,
          canonicalKey: action === "confirm" ? editor.selectedCanonicalKey : null,
          saveAlias: action === "confirm" && editor.saveAlias,
          aliasScope: editor.aliasScope,
          reason: editor.reason.trim() || null
        })
      }
    );
    notice.value = action === "confirm"
      ? `已映射 ${result.affectedObservations} 条记录：${result.normalized} 条进入标准趋势，${result.pending} 条仍待核对，${result.excluded} 条不适用或已排除${result.aliasSaved ? "，并保存别名规则" : ""}。`
      : `已排除 ${result.affectedObservations} 条记录，后续重跑仍会保留该决策。`;
    noticeDetails.value = result.remainingReasons.map(item => `${item.reason}（${item.count} 条）`).join("；");
    delete editors[issue.fingerprint];
    await loadIssues();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "指标治理失败";
  } finally {
    editor.submitting = false;
  }
}

async function undoGovernance(item: IndicatorGovernanceHistoryItem) {
  if (!item.fingerprint || !item.canUndo) return;
  const target = item.rawName || item.aliasName || item.canonicalName || "该指标";
  if (!window.confirm(`确认撤销“${target}”的治理决策吗？关联指标会立即重新归一化，可能重新进入待治理列表。`)) return;
  historyBusyId.value = item.id;
  error.value = "";
  notice.value = "";
  noticeDetails.value = "";
  try {
    const result = await request<IndicatorGovernanceUndoResult>(
      `maintenance/indicator-normalization/issues/${item.fingerprint}/undo`,
      { method: "POST", body: JSON.stringify({ reason: "治理中心人工撤销" }) }
    );
    notice.value = `已撤销 ${result.affectedObservations} 条关联记录${result.aliasDisabled ? "，并停用随决策创建的别名" : ""}；${result.reopenedIssues} 条重新进入待治理范围。`;
    await loadIssues();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "撤销治理失败";
  } finally {
    historyBusyId.value = "";
  }
}

async function toggleAlias(aliasId: string, enabled: boolean, aliasName: string) {
  const action = enabled ? "启用" : "停用";
  if (!window.confirm(`确认${action}本地别名“${aliasName}”吗？关联指标会立即重新归一化。`)) return;
  aliasBusyId.value = aliasId;
  error.value = "";
  notice.value = "";
  noticeDetails.value = "";
  try {
    const result = await request<IndicatorAliasUpdateResult>(
      `maintenance/indicator-normalization/aliases/${aliasId}/status`,
      { method: "POST", body: JSON.stringify({ enabled, reason: `治理中心人工${action}` }) }
    );
    notice.value = `已${action}别名“${aliasName}”，重新检查 ${result.affectedObservations} 条关联记录，${result.reopenedIssues} 条需要治理。`;
    await loadIssues();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : `${action}别名失败`;
  } finally {
    aliasBusyId.value = "";
  }
}

async function loadIssues() {
  loading.value = true;
  error.value = "";
  try {
    const [issueRows, metricSnapshot, historyRows, aliases] = await Promise.all([
      request<IndicatorNormalizationIssue[]>("maintenance/indicator-normalization/issues"),
      request<IndicatorNormalizationMetrics>("maintenance/indicator-normalization/metrics"),
      request<IndicatorGovernanceHistoryPage>(`maintenance/indicator-normalization/history?limit=${historyPageSize}`),
      request<IndicatorAliasGovernanceOverview>("maintenance/indicator-normalization/aliases")
    ]);
    issues.value = issueRows;
    metrics.value = metricSnapshot;
    history.value = historyRows.items;
    historyTotal.value = historyRows.total;
    aliasOverview.value = aliases;
    const validKeys = new Set(issues.value
      .filter((issue) => issue.status === "unknown")
      .map((issue) => issueKey(issue.rawName)));
    selectedNames.value = selectedNames.value.filter((key) => validKeys.has(key));
    for (const issue of issues.value) ensureEditor(issue);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "指标问题池读取失败";
  } finally {
    loading.value = false;
  }
}

async function loadMoreHistory() {
  if (historyLoadingMore.value || history.value.length >= historyTotal.value) return;
  historyLoadingMore.value = true;
  error.value = "";
  try {
    const page = await request<IndicatorGovernanceHistoryPage>(
      `maintenance/indicator-normalization/history?limit=${historyPageSize}&offset=${history.value.length}`
    );
    const knownIds = new Set(history.value.map((item) => item.id));
    history.value = history.value.concat(page.items.filter((item) => !knownIds.has(item.id)));
    historyTotal.value = page.total;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "治理历史读取失败";
  } finally {
    historyLoadingMore.value = false;
  }
}

onMounted(() => {
  void loadIssues();
  void loadAboutInfo();
});
</script>

<template>
  <section class="settings-page">
    <SubPageHeader
      title="指标治理中心"
      description="对照报告核对数据，标准指标可选；保存后自动判断能否进入趋势"
      back-to="/me/maintenance/indicators"
      back-label="返回指标管理"
    >
      <button class="soft-action-button compact-soft" type="button" :disabled="loading" @click="loadIssues">
        <RefreshCw :size="16" :class="{ 'spin-icon': loading }" />刷新
      </button>
    </SubPageHeader>

    <p v-if="error" class="inline-panel-error">{{ error }}</p>
    <p v-if="notice" class="indicator-governance-notice" role="status"><ShieldCheck :size="16" />{{ notice }}<IndicatorHint v-if="noticeDetails" :text="noticeDetails" label="查看处理结果详情" /></p>

    <section v-if="metrics" class="settings-band indicator-quality-dashboard">
      <header>
        <div class="indicator-issue-heading">
          <BarChart3 :size="20" />
          <div>
            <h3>归一化质量概览</h3>
            <p>聚合统计不展示报告内容，用于监控来源质量、趋势准入和待治理规模。</p>
          </div>
        </div>
        <span class="indicator-metrics-version">{{ metrics.version }}</span>
      </header>
      <div class="indicator-metric-cards">
        <article>
          <Database :size="17" />
          <strong>{{ metrics.totals.observations }}</strong>
          <span>{{ metrics.totals.reports }} 份报告观察项</span>
        </article>
        <article>
          <ShieldCheck :size="17" />
          <strong>{{ metrics.totals.mapped }}</strong>
          <span>已映射标准指标 · {{ metricPercent(metrics.totals.mapped, metrics.totals.observations) }}%</span>
        </article>
        <article>
          <CheckCircle2 :size="17" />
          <strong>{{ metrics.totals.trendEligible }}</strong>
          <span>可进入标准趋势</span>
        </article>
        <article class="metric-card-warning">
          <Sparkles :size="17" />
          <strong>{{ metrics.totals.needsReview }}</strong>
          <span>{{ metrics.totals.issueGroups }} 组待标准化项目（不代表未进入趋势）</span>
        </article>
        <article>
          <BarChart3 :size="17" />
          <strong>{{ metrics.totals.decisions }}</strong>
          <span>人工决策 · {{ metrics.totals.userAliases }} 条别名</span>
        </article>
      </div>
      <div class="indicator-metric-panels">
        <section>
          <h4>质量分布</h4>
          <div class="indicator-quality-bars">
            <div v-for="row in qualityRows" :key="row.quality">
              <span>{{ row.label }}</span>
              <i><b :class="`quality-bar--${row.quality}`" :style="{ width: `${metricPercent(row.count, metrics.totals.normalizationRows)}%` }"></b></i>
              <strong>{{ row.count }}</strong>
            </div>
          </div>
        </section>
        <section>
          <h4>来源分布</h4>
          <div class="indicator-source-metrics">
            <div v-for="row in metrics.sourceOrigins" :key="row.sourceOrigin">
              <span>{{ sourceOriginLabels[row.sourceOrigin] }}</span>
              <strong>{{ row.count }}</strong>
              <small>{{ row.trendEligible }} 条进入趋势</small>
            </div>
          </div>
        </section>
      </div>
      <div v-if="metrics.reportTypes.length" class="indicator-report-metrics">
        <h4>按报告类型</h4>
        <div class="indicator-report-metric-head">
          <span>类型</span><span>报告</span><span>观察项</span><span>已映射</span><span>趋势</span><span>待治理</span>
        </div>
        <div v-for="row in metrics.reportTypes" :key="row.reportType" class="indicator-report-metric-row">
          <strong>{{ row.reportType }}</strong>
          <span>{{ row.reports }}</span>
          <span>{{ row.observations }}</span>
          <span>{{ row.mapped }}</span>
          <span>{{ row.trendEligible }}</span>
          <span :class="{ 'metric-warning-text': row.needsReview > 0 }">{{ row.needsReview }}</span>
        </div>
      </div>
    </section>
    <section v-if="loading && !issues.length" class="settings-band">
      <div class="audit-loading"><span v-for="index in 5" :key="index"></span></div>
    </section>
    <EmptyState
      v-else-if="!issues.length"
      title="暂无全局待治理指标"
      description="当前没有需要跨报告统一处理的未命中、低可信或保守排除指标。"
    />
    <section v-else class="settings-band maintenance-issue-list">
      <header>
        <div class="indicator-issue-heading">
          <Sparkles :size="20" />
          <div>
            <h3>{{ showEligible ? '已可用 · 可选标准化' : '待核对指标' }}</h3>
            <p>对照原件逐条核对，标准指标可选。</p>
          </div>
        </div>
      </header>
      <div class="indicator-review-toolbar">
        <div class="indicator-review-tabs" role="group" aria-label="指标核对视图">
          <button type="button" :aria-pressed="!showEligible" @click="showEligible = false">待核对</button>
          <button type="button" :aria-pressed="showEligible" @click="showEligible = true">已可用 · 可选标准化</button>
        </div>
        <div class="indicator-feedback-actions">
          <button class="soft-action-button compact-soft" type="button" @click="toggleAll">
            {{ allSelected ? "取消选择" : "全选" }}
          </button>
          <button
            class="soft-action-button compact-soft"
            type="button"
            :disabled="!feedbackText"
            :title="`复制脱敏指标名称，粘贴到 QQ 交流群 ${feedbackQqGroup} 反馈`"
            @click="copyFeedback"
          >
            <Copy :size="15" />{{ selectedIssueNames.length ? `复制 ${selectedIssueNames.length} 项` : '复制' }}
          </button>
          <a
            class="soft-action-button compact-soft"
            :class="{ disabled: !feedbackUrl }"
            :href="feedbackUrl || undefined"
            target="_blank"
            rel="noreferrer"
            :aria-disabled="!feedbackUrl"
            title="打开预填的 GitHub Issue（需要 GitHub 账号）"
            @click="!feedbackUrl && $event.preventDefault()"
          >
            <ExternalLink :size="15" />{{ selectedIssueNames.length ? `反馈 ${selectedIssueNames.length} 项` : '反馈' }}
          </a>
        </div>
      </div>
      <p class="indicator-feedback-note">仅“未命中字典”的项目可提交收录反馈；低可信候选和保守排除项需在本地核对，不会重复申请收录。反馈不包含报告数据；无法访问 GitHub 时点击“复制”，粘贴到 QQ 交流群 {{ feedbackQqGroup }} 即可。</p>
      <div class="maintenance-issue-rows">
        <p v-if="!displayedIssues.length" class="indicator-feedback-note">{{ showEligible ? '暂无已可用但未标准化的指标。' : '当前列表暂无待核对指标；已可用记录可在“可选标准化”中查看，无需重复处理。' }}</p>
        <article v-for="issue in displayedIssues" :key="issue.fingerprint" class="indicator-issue-row indicator-governance-row">
          <label class="indicator-issue-check" :aria-label="`选择 ${issue.rawName}`">
            <input
              type="checkbox"
              :checked="selectedNames.includes(issueKey(issue.rawName))"
              :disabled="issue.status !== 'unknown' || (!selectedNames.includes(issueKey(issue.rawName)) && selectedNames.length >= maxFeedbackNames)"
              @change="toggleIssue(issueKey(issue.rawName))"
            />
          </label>
          <div class="maintenance-issue-main">
            <div class="observation-title"><strong>{{ issue.rawName }}</strong><IndicatorHint v-if="!issue.trendEligible && issue.reason" :text="issue.reason" label="查看待核对原因" /></div>
            <span>{{ issue.sectionName || "未分组" }} · 来源：{{ sourceOriginLabels[issue.sourceOrigin] }}</span>
            <p class="indicator-original-result">原始结果：{{ formatRawIndicatorResult(issue.resultText, issue.unit, "未读取到原始结果") }}</p>
            <p v-if="issue.candidateCanonicalName" class="indicator-candidate-summary">
              当前候选：{{ issue.candidateCanonicalName }}（{{ issue.candidateCanonicalKey }}）
              <template v-if="issue.candidateDefaultUnit"> · 标准单位 {{ issue.candidateDefaultUnit }}</template>
            </p>
            <div v-if="editors[issue.fingerprint]?.open" class="indicator-governance-editor">
              <div class="indicator-catalog-search">
                <input
                  v-model="editors[issue.fingerprint].query"
                  type="search"
                  placeholder="输入标准指标名称或编码"
                  @keyup.enter="searchCatalog(issue)"
                />
                <button
                  class="soft-action-button compact-soft"
                  type="button"
                  :disabled="editors[issue.fingerprint].searching"
                  @click="searchCatalog(issue)"
                >
                  <Search :size="15" />{{ editors[issue.fingerprint].searching ? "查询中" : "查询" }}
                </button>
              </div>
              <FormSelect
                v-model="editors[issue.fingerprint].selectedCanonicalKey"
                :options="catalogSelectOptions(editors[issue.fingerprint].options)"
                placeholder="请选择标准指标"
                empty-text="暂无匹配的标准指标，请换个名称查询；也可返回“核对指标”，不指定标准指标进行核对。"
                aria-label="请选择标准指标"
              />
              <input
                v-model="editors[issue.fingerprint].reason"
                type="text"
                maxlength="300"
                placeholder="治理说明（可选）"
              />
              <div class="indicator-governance-options">
                <label>
                  <input v-model="editors[issue.fingerprint].saveAlias" type="checkbox" />
                  将“{{ issue.rawName }}”保存为本地别名
                </label>
                <FormSelect
                  v-if="editors[issue.fingerprint].saveAlias"
                  v-model="editors[issue.fingerprint].aliasScope"
                  :options="aliasScopeOptions"
                  aria-label="别名范围"
                />
              </div>
              <div class="indicator-governance-actions">
                <button
                  class="primary-button compact-primary"
                  type="button"
                  :disabled="editors[issue.fingerprint].submitting || !editors[issue.fingerprint].selectedCanonicalKey"
                  @click="resolveIssue(issue, 'confirm')"
                >
                  <CheckCircle2 :size="15" />确认映射
                </button>
                <button
                  class="soft-action-button compact-soft danger-soft-action"
                  type="button"
                  :disabled="editors[issue.fingerprint].submitting"
                  @click="resolveIssue(issue, 'exclude')"
                >
                  <Ban :size="15" />排除趋势
                </button>
              </div>
            </div>
          </div>
          <div class="maintenance-issue-meta">
            <div class="indicator-review-status">
            <span :class="`issue-chip issue-chip--${issue.status}`">{{ issue.trendEligible ? '已可用' : '需核对' }}</span>
            <span>待核对 {{ issue.pendingCount }} / {{ issue.count }} 条</span>
            <small>{{ formatDate(issue.latestReportIssuedAt) }}</small>
            </div>
            <div class="indicator-review-actions">
            <button class="primary-button compact-primary" type="button" :disabled="!issue.canManage" :title="issue.canManage ? '打开原件对照并核对当前记录' : '需要该成员档案的管理权限'" @click="reviewingIssue = issue">核对指标</button>
            <button class="soft-action-button compact-soft" type="button" @click="toggleGovernance(issue)">
              {{ editors[issue.fingerprint]?.open ? "收起" : "批量标准化 / 排除" }}
            </button>
            </div>
          </div>
        </article>
      </div>
    </section>

    <section class="settings-band indicator-alias-governance">
      <header>
        <div class="indicator-issue-heading">
          <Link2 :size="20" />
          <div>
            <h3>本地别名规则</h3>
            <p>{{ aliasOverview.aliases.length }} 条人工别名；停用后会立即重新归一化受影响指标。</p>
          </div>
        </div>
        <span v-if="aliasOverview.conflicts.length" class="indicator-conflict-count">
          <AlertTriangle :size="14" />{{ aliasOverview.conflicts.length }} 组冲突
        </span>
      </header>
      <div v-if="aliasOverview.conflicts.length" class="indicator-alias-conflicts">
        <article v-for="conflict in aliasOverview.conflicts" :key="`${conflict.normalizedAlias}-${conflict.scope}-${conflict.reportType || ''}`">
          <AlertTriangle :size="17" />
          <div>
            <strong>“{{ conflict.normalizedAlias }}”存在多目标映射</strong>
            <span>{{ aliasScopeLabel(conflict.scope) }}{{ conflict.reportType ? ` · ${conflict.reportType}` : "" }}</span>
            <p>{{ conflict.targets.map((target) => `${target.canonicalName}（${target.canonicalKey}）`).join(" / ") }}</p>
          </div>
        </article>
      </div>
      <div v-if="aliasOverview.aliases.length" class="indicator-alias-rows">
        <article v-for="alias in aliasOverview.aliases" :key="alias.id">
          <div class="indicator-alias-main">
            <strong>{{ alias.aliasName }}</strong>
            <span>→ {{ alias.canonicalName }}（{{ alias.canonicalKey }}）</span>
            <small>
              {{ aliasScopeLabel(alias.scope) }}{{ alias.reportType ? ` · ${alias.reportType}` : "" }}
              · 匹配 {{ alias.usageCount }} 条记录
            </small>
          </div>
          <div class="indicator-alias-actions">
            <span v-if="alias.conflictCount" class="issue-chip issue-chip--excluded">冲突 {{ alias.conflictCount }}</span>
            <span :class="['issue-chip', alias.enabled ? 'issue-chip--low' : 'issue-chip--unknown']">
              {{ alias.enabled ? "已启用" : "已停用" }}
            </span>
            <button
              class="soft-action-button compact-soft"
              :class="{ 'danger-soft-action': alias.enabled }"
              type="button"
              :disabled="aliasBusyId === alias.id"
              @click="toggleAlias(alias.id, !alias.enabled, alias.aliasName)"
            >
              <Power :size="14" />{{ aliasBusyId === alias.id ? "处理中" : alias.enabled ? "停用" : "启用" }}
            </button>
          </div>
        </article>
      </div>
      <p v-else class="indicator-feedback-note">尚未保存人工别名。治理指标时可选择“保存为本地别名”。</p>
    </section>

    <section class="settings-band indicator-governance-history">
      <header>
        <div class="indicator-issue-heading">
          <History :size="20" />
          <div>
            <h3>治理历史</h3>
            <p>保留确认、排除、撤销和别名启停记录；只有当前有效决策可撤销。</p>
          </div>
        </div>
      </header>
      <div v-if="history.length" class="indicator-history-rows">
        <article v-for="item in history" :key="item.id">
          <div :class="`indicator-history-icon indicator-history-icon--${item.eventType}`">
            <RotateCcw v-if="item.eventType === 'undo'" :size="15" />
            <Power v-else-if="item.eventType === 'alias_enable' || item.eventType === 'alias_disable'" :size="15" />
            <CheckCircle2 v-else-if="item.decisionAction === 'confirm'" :size="15" />
            <Ban v-else :size="15" />
          </div>
          <div class="indicator-history-main">
            <strong>{{ historyEventLabel(item) }} · {{ item.rawName || item.aliasName || item.canonicalName || "指标规则" }}</strong>
            <span v-if="item.canonicalName || item.canonicalKey">
              {{ item.canonicalName || item.canonicalKey }}{{ item.canonicalKey ? `（${item.canonicalKey}）` : "" }}
            </span>
            <small>
              {{ formatDateTime(item.createdAt) }} · {{ item.actorName || "未知操作者" }}
              · 影响 {{ item.affectedObservations }} 条
              <template v-if="item.aliasScope"> · {{ aliasScopeLabel(item.aliasScope) }}</template>
            </small>
            <p v-if="item.reason">{{ item.reason }}</p>
          </div>
          <button
            v-if="item.canUndo"
            class="soft-action-button compact-soft danger-soft-action"
            type="button"
            :disabled="historyBusyId === item.id"
            @click="undoGovernance(item)"
          >
            <RotateCcw :size="14" />{{ historyBusyId === item.id ? "撤销中" : "撤销" }}
          </button>
        </article>
        <footer class="indicator-history-footer">
          <span>已显示 {{ history.length }} / {{ historyTotal }} 条</span>
          <button
            v-if="history.length < historyTotal"
            class="soft-action-button compact-soft"
            type="button"
            :disabled="historyLoadingMore"
            @click="loadMoreHistory"
          >
            <RefreshCw :size="14" :class="{ 'spin-icon': historyLoadingMore }" />{{ historyLoadingMore ? "加载中" : "加载更多" }}
          </button>
        </footer>
      </div>
      <p v-else class="indicator-feedback-note">尚无人工治理历史。</p>
    </section>
    <ReportDetail v-if="reviewingIssue" :key="reviewingIssue.representativeObservationId" :report-id="reviewingIssue.reportId" :review-observation-id="reviewingIssue.representativeObservationId" variant="panel" @close="reviewingIssue = null" @updated="loadIssues" />
  </section>
</template>
