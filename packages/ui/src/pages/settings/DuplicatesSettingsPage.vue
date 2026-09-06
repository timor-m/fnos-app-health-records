<script setup lang="ts">
import { computed, ref } from "vue";
import { GitMerge, RefreshCw, RotateCcw, SearchCheck, ShieldCheck, ShieldX, Trash2, X } from "@lucide/vue";
import SubPageHeader from "../../components/SubPageHeader.vue";
import EmptyState from "../../components/EmptyState.vue";
import FormSelect from "../../components/FormSelect.vue";
import ReportDetailModal from "../../components/ReportDetailModal.vue";
import { request } from "../../utils/api";
import type {
  DuplicateReportCandidate,
  DuplicateReportGroup,
  DuplicateReportOverview,
  ReportDuplicateBatchResult,
  ReportDuplicateBatchUndoResult,
  ReportDuplicateComparison,
  ReportDuplicateDecisionRecord,
  ReportDuplicateMetrics,
  ReportDuplicateOperationRecord,
  ReportSummary
} from "../../types/api";
import { useAppContext } from "../../composables/useAppContext";
import { useConfirm } from "../../composables/useConfirm";
import { useToast } from "../../composables/useToast";

const app = useAppContext();
const toast = useToast();
const confirmDialog = useConfirm();
const loading = ref(false);
const groups = ref<DuplicateReportGroup[]>([]);
const decisions = ref<ReportDuplicateDecisionRecord[]>([]);
const metrics = ref<ReportDuplicateMetrics | null>(null);
const operations = ref<ReportDuplicateOperationRecord[]>([]);
const governingPairKey = ref<string | null>(null);
const batchGoverning = ref(false);
const error = ref("");
const previewReportId = ref<string | null>(null);
const searchQuery = ref("");
const confidenceFilter = ref("all");
const reportTypeFilter = ref("all");
const hospitalFilter = ref("all");
const selectedPairKeys = ref<string[]>([]);
const selectedDecisionPairKeys = ref<string[]>([]);
const reportTypeOptions = ref<string[]>([]);
const hospitalOptions = ref<string[]>([]);
const confidenceSelectOptions = [
  { value: "all", label: "全部" },
  { value: "high", label: "高置信" },
  { value: "medium", label: "中置信" }
];
const reportTypeSelectOptions = computed(() => [
  { value: "all", label: "全部" },
  ...reportTypeOptions.value.map((type) => ({ value: type, label: type }))
]);
const hospitalSelectOptions = computed(() => [
  { value: "all", label: "全部" },
  ...hospitalOptions.value.map((hospital) => ({ value: hospital, label: hospital }))
]);
const pagination = ref({ page: 1, pageSize: 20, totalGroups: 0, totalPairs: 0, totalPages: 1 });
const comparisonOpen = ref(false);
const comparisonLoading = ref(false);
const comparison = ref<ReportDuplicateComparison | null>(null);
const comparisonSource = ref<ReportSummary | null>(null);
const comparisonTarget = ref<DuplicateReportCandidate | null>(null);

function meta(report: ReportSummary) {
  return [report.reportIssuedAt || "日期待确认", report.hospitalName, report.departmentName, report.bodyPart]
    .filter(Boolean).join(" · ");
}

const filteredGroups = computed(() => groups.value);

const selectableVisiblePairs = computed(() => filteredGroups.value.flatMap((group) => group.candidates
  .filter((candidate) => candidate.governanceDecision !== "duplicate")
  .map((candidate) => candidate.pairKey)));

const selectedCandidates = computed(() => {
  const selected = new Set(selectedPairKeys.value);
  return groups.value.flatMap((group) => group.candidates.flatMap((candidate) => selected.has(candidate.pairKey)
    ? [{ source: group.report, candidate }]
    : []));
});

function isSelected(pairKey: string) {
  return selectedPairKeys.value.includes(pairKey);
}

function toggleSelected(pairKey: string) {
  selectedPairKeys.value = isSelected(pairKey)
    ? selectedPairKeys.value.filter((item) => item !== pairKey)
    : [...selectedPairKeys.value, pairKey];
}

function toggleAllVisible() {
  const visible = selectableVisiblePairs.value;
  const selected = new Set(selectedPairKeys.value);
  const allSelected = visible.length > 0 && visible.every((pairKey) => selected.has(pairKey));
  if (allSelected) {
    selectedPairKeys.value = selectedPairKeys.value.filter((pairKey) => !visible.includes(pairKey));
  } else {
    selectedPairKeys.value = [...new Set([...selectedPairKeys.value, ...visible])].slice(0, 100);
  }
}

async function scan(requestedPage?: number) {
  const memberId = app.selectedMemberId.value;
  if (!memberId) return;
  const page = typeof requestedPage === "number" ? requestedPage : 1;
  loading.value = true;
  error.value = "";
  try {
    const params = new URLSearchParams({ memberId, page: String(page), pageSize: String(pagination.value.pageSize) });
    if (searchQuery.value.trim()) params.set("q", searchQuery.value.trim());
    if (confidenceFilter.value !== "all") params.set("confidence", confidenceFilter.value);
    if (reportTypeFilter.value !== "all") params.set("reportType", reportTypeFilter.value);
    if (hospitalFilter.value !== "all") params.set("hospital", hospitalFilter.value);
    const overview = await request<DuplicateReportOverview>(`duplicates/overview?${params.toString()}`);
    groups.value = overview.groups;
    decisions.value = overview.decisions;
    metrics.value = overview.metrics;
    operations.value = overview.operations;
    pagination.value = overview.pagination;
    reportTypeOptions.value = overview.filterOptions.reportTypes;
    hospitalOptions.value = overview.filterOptions.hospitals;
    selectedPairKeys.value = [];
    selectedDecisionPairKeys.value = [];
    toast.show(overview.pagination.totalGroups ? `发现 ${overview.pagination.totalGroups} 组候选` : "未发现符合条件的重复候选");
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "重复检测失败";
  } finally {
    loading.value = false;
  }
}

function toggleDecisionSelected(pairKey: string) {
  selectedDecisionPairKeys.value = selectedDecisionPairKeys.value.includes(pairKey)
    ? selectedDecisionPairKeys.value.filter((item) => item !== pairKey)
    : [...selectedDecisionPairKeys.value, pairKey].slice(0, 100);
}

function batchUndoDecisions() {
  const pairKeys = [...selectedDecisionPairKeys.value];
  if (!pairKeys.length) return;
  confirmDialog.ask({
    title: "批量撤销治理判断",
    message: `撤销选中的 ${pairKeys.length} 条重复报告判断？撤销后会重新使用自动检测结果。`,
    confirmText: "批量撤销",
    run: async () => {
      batchGoverning.value = true;
      try {
        const result = await request<ReportDuplicateBatchUndoResult>("duplicates/decisions/batch", {
          method: "DELETE",
          body: JSON.stringify({ pairKeys })
        });
        toast.show(`已撤销 ${result.undone} 条治理判断`);
        await scan(pagination.value.page);
      } catch (cause) {
        toast.show(cause instanceof Error ? cause.message : "批量撤销失败，请稍后重试");
      } finally {
        batchGoverning.value = false;
      }
    }
  });
}

function openReport(reportId: string) {
  previewReportId.value = reportId;
}

async function trash(report: ReportSummary) {
  confirmDialog.ask({
    title: "移入回收站",
    message: `确认将「${report.title}」移入回收站？原件会保留 30 天，不会立刻删除。`,
    confirmText: "移入回收站",
    danger: true,
    run: async () => {
      try {
        await request(`reports/${encodeURIComponent(report.id)}`, { method: "DELETE" });
        toast.show("报告已移入回收站");
        await scan();
      } catch (cause) {
        toast.show(cause instanceof Error ? cause.message : "操作失败，请稍后重试");
      }
    }
  });
}

async function governCandidate(source: ReportSummary, candidate: DuplicateReportCandidate, decision: "duplicate" | "distinct") {
  confirmDialog.ask({
    title: decision === "duplicate" ? "确认重复报告" : "确认不是重复报告",
    message: decision === "duplicate"
      ? `确认「${source.title}」与「${candidate.title}」属于同一份报告？确认后趋势会折叠这两份报告的重复数据点。`
      : `确认「${source.title}」与「${candidate.title}」是两份不同报告？该候选将被排除，趋势会保留两份报告的数据。`,
    confirmText: decision === "duplicate" ? "确认重复" : "保留两份",
    danger: decision === "duplicate",
    run: async () => {
      governingPairKey.value = candidate.pairKey;
      try {
        await request("duplicates/decisions", {
          method: "POST",
          body: JSON.stringify({
            reportId: source.id,
            candidateReportId: candidate.id,
            decision,
            reason: decision === "duplicate" ? "人工核对后确认重复" : "人工核对后确认不同报告",
            evidence: {
              confidence: candidate.confidence,
              reason: candidate.reason,
              matchedFields: candidate.matchedFields,
              ruleSnapshot: candidate.ruleSnapshot
            }
          })
        });
        toast.show(decision === "duplicate" ? "已确认重复报告" : "已标记为不同报告");
        await scan();
      } catch (cause) {
        toast.show(cause instanceof Error ? cause.message : "治理失败，请稍后重试");
      } finally {
        governingPairKey.value = null;
      }
    }
  });
}

function batchGovern(decision: "duplicate" | "distinct") {
  const entries = selectedCandidates.value;
  if (!entries.length) return;
  confirmDialog.ask({
    title: decision === "duplicate" ? "批量确认重复" : "批量排除误报",
    message: `将选中的 ${entries.length} 组候选批量标记为${decision === "duplicate" ? "重复报告" : "不同报告"}？该操作会逐组写入治理历史和审计记录。`,
    confirmText: decision === "duplicate" ? "批量确认" : "批量排除",
    danger: decision === "duplicate",
    run: async () => {
      batchGoverning.value = true;
      try {
        const result = await request<ReportDuplicateBatchResult>("duplicates/decisions/batch", {
          method: "POST",
          body: JSON.stringify({
            items: entries.map(({ source, candidate }) => ({
              reportId: source.id,
              candidateReportId: candidate.id,
              decision,
              reason: decision === "duplicate" ? "批量人工核对后确认重复" : "批量人工核对后确认不同报告",
              evidence: {
                confidence: candidate.confidence,
                reason: candidate.reason,
                matchedFields: candidate.matchedFields,
                ruleSnapshot: candidate.ruleSnapshot
              }
            }))
          })
        });
        toast.show(`已批量处理 ${result.applied} 组候选`);
        await scan();
      } catch (cause) {
        toast.show(cause instanceof Error ? cause.message : "批量治理失败，请稍后重试");
      } finally {
        batchGoverning.value = false;
      }
    }
  });
}

async function undoDecision(decision: ReportDuplicateDecisionRecord) {
  confirmDialog.ask({
    title: "撤销重复报告判断",
    message: `撤销「${decision.leftTitle}」与「${decision.rightTitle}」的人工判断？撤销后将重新使用自动检测结果。`,
    confirmText: "撤销判断",
    run: async () => {
      governingPairKey.value = decision.pairKey;
      try {
        await request(`duplicates/decisions/${encodeURIComponent(decision.pairKey)}`, { method: "DELETE" });
        toast.show("已撤销重复报告判断");
        await scan();
      } catch (cause) {
        toast.show(cause instanceof Error ? cause.message : "撤销失败，请稍后重试");
      } finally {
        governingPairKey.value = null;
      }
    }
  });
}

function operationLabel(operation: ReportDuplicateOperationRecord) {
  if (operation.operation === "recompute") return "缓存重算";
  if (operation.operation === "rollback_drill") return "回滚演练";
  return operation.purpose === "rule_compare" ? "规则对比扫描" : "候选扫描";
}

function operationSummary(operation: ReportDuplicateOperationRecord) {
  const stats = operation.stats;
  if (operation.operation === "recompute") return `失效 ${Number(stats.invalidatedPairs || 0)} 组缓存`;
  if (operation.operation === "rollback_drill") return `影响 ${Number(stats.affectedPairs || 0)} 组候选`;
  return `${Number(stats.sourceReportsScanned || 0)} 份报告 · ${Number(stats.candidatePairs || 0)} 组候选 · ${Number(stats.scanDurationMs || 0)}ms`;
}

async function openComparison(source: ReportSummary, target: DuplicateReportCandidate) {
  comparisonOpen.value = true;
  comparisonLoading.value = true;
  comparison.value = null;
  comparisonSource.value = source;
  comparisonTarget.value = target;
  try {
    comparison.value = await request<ReportDuplicateComparison>(
      `duplicates/compare?reportId=${encodeURIComponent(source.id)}&candidateReportId=${encodeURIComponent(target.id)}`
    );
  } catch (cause) {
    toast.show(cause instanceof Error ? cause.message : "差异预览加载失败");
    comparisonOpen.value = false;
  } finally {
    comparisonLoading.value = false;
  }
}

async function mergeToCandidate(source: ReportSummary, target: DuplicateReportCandidate) {
  confirmDialog.ask({
    title: "合并报告",
    message: `把「${source.title}」的原件页合并到「${target.title}」，并将当前报告移入回收站？结构化字段以目标报告为准。`,
    confirmText: "合并",
    danger: true,
    run: async () => {
      try {
        await request(`reports/${encodeURIComponent(source.id)}/merge`, {
          method: "POST",
          body: JSON.stringify({ targetReportId: target.id })
        });
        comparisonOpen.value = false;
        toast.show("已合并原件页，源报告已移入回收站");
        await scan();
      } catch (cause) {
        toast.show(cause instanceof Error ? cause.message : "合并失败，请稍后重试");
      }
    }
  });
}
</script>

<template>
  <section class="settings-page">
    <SubPageHeader title="重复报告检测" description="手动扫描当前成员，处理疑似重复或高度重复的报告" />
    <section class="settings-band">
      <header>
        <div><SearchCheck :size="20" /><div><h3>手动扫描</h3><p>依据原件指纹、OCR 内容、业务编号及已整理字段和指标综合判断。</p></div></div>
        <button class="primary-button compact-primary" type="button" :disabled="loading" @click="scan(1)">
          <RefreshCw :size="16" :class="{ 'spin-icon': loading }" />{{ loading ? "扫描中" : "开始检测" }}
        </button>
      </header>
      <p v-if="error" class="inline-panel-error">{{ error }}</p>
    </section>

    <section v-if="metrics" class="duplicate-metrics-grid" aria-label="重复报告治理指标">
      <article><strong>{{ metrics.candidateGroups }}</strong><span>候选组</span><small>{{ metrics.highCandidates }} 个高置信候选</small></article>
      <article><strong>{{ metrics.manualDuplicateDecisions }}</strong><span>已确认重复</span><small>确认率 {{ Math.round(metrics.duplicateConfirmRate * 100) }}%</small></article>
      <article><strong>{{ metrics.manualDistinctDecisions }}</strong><span>已排除误报</span><small>排除率 {{ Math.round(metrics.distinctRejectRate * 100) }}%</small></article>
      <article><strong>{{ metrics.mergedPairs }}</strong><span>已执行合并</span><small>{{ metrics.totalDecisionHistory }} 条治理历史</small></article>
      <article><strong>{{ metrics.sourceReportsScanned }}</strong><span>本次扫描报告</span><small>{{ metrics.candidateComparisons }} 次比较 · {{ metrics.scanDurationMs }}ms</small></article>
    </section>

    <section v-if="operations.length" class="settings-band duplicate-quality-panel">
      <header><div><RefreshCw :size="20" /><div><h3>运行记录</h3><p>仅保存聚合耗时、缓存和候选数量，不保存报告内容。</p></div></div></header>
      <div class="duplicate-operation-list">
        <article v-for="operation in operations.slice(0, 8)" :key="operation.id">
          <div><strong>{{ operationLabel(operation) }} · {{ operation.ruleVersion || "全部规则" }}</strong><span>{{ operationSummary(operation) }}</span></div>
          <small :class="`is-${operation.status}`">{{ operation.status === "completed" ? "完成" : operation.status === "failed" ? "失败" : "执行中" }} · {{ operation.finishedAt || operation.startedAt }}</small>
        </article>
      </div>
    </section>

    <section v-if="metrics && metrics.candidateGroups" class="settings-band duplicate-filter-panel">
      <div class="duplicate-filter-grid">
        <label><span>搜索</span><input v-model="searchQuery" type="search" placeholder="标题、医院或候选原因" @keyup.enter="scan(1)" /></label>
        <label><span>置信度</span><FormSelect v-model="confidenceFilter" :options="confidenceSelectOptions" aria-label="置信度" @change="scan(1)" /></label>
        <label><span>报告类型</span><FormSelect v-model="reportTypeFilter" :options="reportTypeSelectOptions" aria-label="报告类型" @change="scan(1)" /></label>
        <label><span>医院</span><FormSelect v-model="hospitalFilter" :options="hospitalSelectOptions" aria-label="医院" @change="scan(1)" /></label>
        <button type="button" :disabled="loading" @click="scan(1)">应用筛选</button>
      </div>
      <div class="duplicate-batch-bar">
        <button type="button" :disabled="!selectableVisiblePairs.length" @click="toggleAllVisible">选择/取消当前结果</button>
        <span>已选择 {{ selectedCandidates.length }} 组，单次最多 100 组</span>
        <div>
          <button type="button" :disabled="!selectedCandidates.length || batchGoverning" @click="batchGovern('duplicate')"><ShieldCheck :size="15" />批量确认重复</button>
          <button type="button" :disabled="!selectedCandidates.length || batchGoverning" @click="batchGovern('distinct')"><ShieldX :size="15" />批量排除</button>
        </div>
      </div>
    </section>

    <EmptyState v-if="!loading && metrics && metrics.candidateGroups && !pagination.totalGroups" title="没有符合筛选条件的候选" description="调整搜索词、置信度、报告类型或医院筛选。" />
    <EmptyState v-else-if="!loading && !groups.length" title="暂无重复候选" description="点击“开始检测”后，疑似重复报告会显示在这里。" />
    <div v-else class="duplicate-scan-list">
      <article v-for="group in filteredGroups" :key="group.report.id" class="settings-band duplicate-scan-card">
        <header>
          <div>
            <GitMerge :size="20" />
            <div><h3>{{ group.report.title }}</h3><p>{{ meta(group.report) }}</p></div>
          </div>
          <button type="button" @click="openReport(group.report.id)">查看当前</button>
        </header>
        <section v-for="candidate in group.candidates" :key="candidate.id" class="duplicate-scan-candidate">
          <div class="duplicate-candidate-main">
            <input
              type="checkbox"
              :checked="isSelected(candidate.pairKey)"
              :disabled="candidate.governanceDecision === 'duplicate'"
              :aria-label="`选择 ${candidate.title}`"
              @change="toggleSelected(candidate.pairKey)"
            />
            <div>
              <strong>{{ candidate.governanceDecision === "duplicate" ? "已确认重复" : candidate.confidence === "high" ? "高度重复" : "疑似重复" }} · {{ candidate.title }}</strong>
              <span>{{ meta(candidate) }}</span>
              <small>{{ candidate.reason }} · {{ candidate.matchedFields.join("、") }}</small>
            </div>
          </div>
          <div class="row-actions">
            <button type="button" @click="openReport(candidate.id)">查看已有</button>
            <button type="button" :disabled="governingPairKey === candidate.pairKey || candidate.governanceDecision === 'duplicate'" @click="governCandidate(group.report, candidate, 'duplicate')"><ShieldCheck :size="15" />{{ candidate.governanceDecision === "duplicate" ? "已确认重复" : "确认重复" }}</button>
            <button type="button" :disabled="governingPairKey === candidate.pairKey" @click="governCandidate(group.report, candidate, 'distinct')"><ShieldX :size="15" />不是重复</button>
            <button type="button" @click="openComparison(group.report, candidate)"><GitMerge :size="15" />差异预览/合并</button>
            <button type="button" @click="trash(group.report)"><Trash2 :size="15" />当前进回收站</button>
          </div>
        </section>
      </article>
    </div>

    <nav v-if="pagination.totalPages > 1" class="duplicate-pagination" aria-label="重复候选分页">
      <button type="button" :disabled="loading || pagination.page <= 1" @click="scan(pagination.page - 1)">上一页</button>
      <span>第 {{ pagination.page }} / {{ pagination.totalPages }} 页 · {{ pagination.totalPairs }} 组候选关系</span>
      <button type="button" :disabled="loading || pagination.page >= pagination.totalPages" @click="scan(pagination.page + 1)">下一页</button>
    </nav>

    <section v-if="decisions.length" class="settings-band duplicate-governance-history">
      <header>
        <div><ShieldCheck :size="20" /><div><h3>人工治理记录</h3><p>人工结论优先于自动候选，可随时撤销并重新扫描。</p></div></div>
      </header>
      <div class="duplicate-history-batch-bar">
        <span>已选择 {{ selectedDecisionPairKeys.length }} 条治理记录</span>
        <button type="button" :disabled="!selectedDecisionPairKeys.length || batchGoverning" @click="batchUndoDecisions"><RotateCcw :size="15" />批量撤销</button>
      </div>
      <div class="duplicate-decision-list">
        <article v-for="decision in decisions" :key="decision.pairKey" class="duplicate-decision-row">
          <input type="checkbox" :checked="selectedDecisionPairKeys.includes(decision.pairKey)" :disabled="batchGoverning || governingPairKey === decision.pairKey" :aria-label="`选择 ${decision.leftTitle} 与 ${decision.rightTitle}`" @change="toggleDecisionSelected(decision.pairKey)" />
          <div>
            <strong>{{ decision.decision === "duplicate" ? "确认重复" : "保留两份" }} · {{ decision.leftTitle }} / {{ decision.rightTitle }}</strong>
            <small>{{ decision.reason || "未填写原因" }} · {{ decision.decidedByName || "未知操作人" }} · {{ decision.updatedAt }}</small>
            <small>规则 {{ decision.ruleVersion }} · {{ decision.ruleSnapshot.ruleId }}</small>
          </div>
          <button type="button" :disabled="batchGoverning || governingPairKey === decision.pairKey" @click="undoDecision(decision)"><RotateCcw :size="15" />撤销</button>
        </article>
      </div>
    </section>

    <div v-if="comparisonOpen" class="modal-backdrop duplicate-comparison-backdrop" @click.self="comparisonOpen = false">
      <section class="modal-panel duplicate-comparison-modal" role="dialog" aria-modal="true" aria-label="合并前差异预览">
        <header>
          <div><h3>合并前差异预览</h3><p v-if="comparison">左侧为当前报告，右侧为保留目标。</p></div>
          <button type="button" aria-label="关闭" @click="comparisonOpen = false"><X :size="18" /></button>
        </header>
        <div v-if="comparisonLoading" class="duplicate-comparison-loading"><RefreshCw :size="18" class="spin-icon" />正在比较结构化字段和指标…</div>
        <div v-else-if="comparison" class="duplicate-comparison-body">
          <div class="duplicate-comparison-summary">
            <article><span>当前报告</span><strong>{{ comparison.left.title }}</strong></article>
            <article><span>保留目标</span><strong>{{ comparison.right.title }}</strong></article>
          </div>
          <div class="duplicate-comparison-stats">
            <span>相同指标 {{ comparison.observations.shared }}</span>
            <span :class="{ warning: comparison.observations.conflicts }">冲突 {{ comparison.observations.conflicts }}</span>
            <span>仅当前 {{ comparison.observations.leftOnly }}</span>
            <span>仅目标 {{ comparison.observations.rightOnly }}</span>
          </div>
          <div class="duplicate-field-diff-list">
            <article v-for="field in comparison.fields" :key="field.key" :class="{ equal: field.equal }">
              <strong>{{ field.label }}</strong><span>{{ field.left || "—" }}</span><span>{{ field.right || "—" }}</span>
            </article>
          </div>
          <div v-if="comparison.observations.differences.length" class="duplicate-observation-diff-list">
            <article v-for="item in comparison.observations.differences" :key="item.key">
              <strong>{{ item.itemName }}</strong><span>{{ item.leftResult || "—" }}</span><span>{{ item.rightResult || "—" }}</span>
            </article>
            <small v-if="comparison.observations.truncated">差异较多，当前仅展示前 100 项。</small>
          </div>
        </div>
        <footer v-if="comparison && !comparisonLoading">
          <button type="button" @click="comparisonOpen = false">取消</button>
          <button v-if="comparisonSource && comparisonTarget" type="button" class="danger-action-button" @click="mergeToCandidate(comparisonSource, comparisonTarget)"><GitMerge :size="16" />确认合并到右侧报告</button>
        </footer>
      </section>
    </div>

    <ReportDetailModal :open="Boolean(previewReportId)" :report-id="previewReportId" @close="previewReportId = null" @updated="scan(pagination.page)" />
  </section>
</template>
