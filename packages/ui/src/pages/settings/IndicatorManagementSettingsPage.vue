<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { ChevronRight, Database, RefreshCw, Sparkles } from "@lucide/vue";
import SubPageHeader from "../../components/SubPageHeader.vue";
import { useConfirm } from "../../composables/useConfirm";
import { useToast } from "../../composables/useToast";
import { request } from "../../utils/api";

type IndicatorNormalizationResult = {
  scanned: number;
  normalized: number;
  high: number;
  medium: number;
  low: number;
  excluded: number;
  unknown: number;
};

type IndicatorNormalizationTask = {
  id: string;
  mode: "incremental" | "full";
  status: "queued" | "running" | "completed" | "failed";
  totalReports: number;
  processedReports: number;
  progressPercent: number;
  attempts: number;
  result: IndicatorNormalizationResult | null;
  errorMessage: string | null;
  createdAt: string;
  startedAt: string | null;
  updatedAt: string;
  finishedAt: string | null;
  reused?: boolean;
};

const confirmDialog = useConfirm();
const toast = useToast();
const normalizationTask = ref<IndicatorNormalizationTask | null>(null);
const normalizationTaskActive = computed(() =>
  normalizationTask.value?.status === "queued" || normalizationTask.value?.status === "running"
);
const normalizationRunning = computed(() =>
  normalizationTaskActive.value && normalizationTask.value?.mode === "incremental"
);
const fullNormalizationRunning = computed(() =>
  normalizationTaskActive.value && normalizationTask.value?.mode === "full"
);
const normalizationResult = ref<IndicatorNormalizationResult | null>(null);
const normalizationError = ref("");
let normalizationPollTimer: ReturnType<typeof setTimeout> | null = null;

function clearNormalizationPoll() {
  if (normalizationPollTimer) clearTimeout(normalizationPollTimer);
  normalizationPollTimer = null;
}

function normalizationStatusLabel(task: IndicatorNormalizationTask) {
  if (task.status === "queued") return "等待执行";
  if (task.status === "running") return "后台处理中";
  if (task.status === "completed") return "已完成";
  return "执行失败";
}

function applyNormalizationTask(task: IndicatorNormalizationTask | null, notify = false) {
  const previous = normalizationTask.value;
  normalizationTask.value = task;
  if (task?.result) normalizationResult.value = task.result;
  else if (previous?.id !== task?.id) normalizationResult.value = null;
  if (task?.status === "failed") {
    normalizationError.value = task.errorMessage || "指标字典匹配任务执行失败";
  } else if (previous?.id !== task?.id) {
    normalizationError.value = "";
  }
  if (
    notify
    && previous
    && task
    && previous.id === task.id
    && (previous.status === "queued" || previous.status === "running")
    && task.status === "completed"
  ) {
    toast.show(`已匹配 ${task.result?.normalized || 0} 项指标`);
  } else if (
    notify
    && previous
    && task
    && previous.id === task.id
    && (previous.status === "queued" || previous.status === "running")
    && task.status === "failed"
  ) {
    toast.show("指标字典匹配任务执行失败");
  }
}

function scheduleNormalizationPoll() {
  clearNormalizationPoll();
  if (!normalizationTaskActive.value) return;
  normalizationPollTimer = setTimeout(() => {
    void refreshNormalizationTask(true);
  }, 2_000);
}

async function refreshNormalizationTask(notify = false) {
  try {
    const task = await request<IndicatorNormalizationTask | null>("maintenance/indicator-normalization");
    applyNormalizationTask(task, notify);
  } catch (cause) {
    normalizationError.value = cause instanceof Error ? cause.message : "无法获取指标字典匹配任务状态";
  } finally {
    scheduleNormalizationPoll();
  }
}

function normalizeIndicators() {
  confirmDialog.ask({
    title: "匹配未归类指标",
    message: "确认使用当前核心与远程字典匹配尚未归类的历史指标？本操作只建立标准名称、单位、分组和趋势关联，不重新 OCR、不调用 AI，也不修改报告中的原始名称和数值。仍未命中的名称会进入指标问题池。",
    confirmText: "开始匹配",
    run: async () => {
      normalizationError.value = "";
      try {
        const task = await request<IndicatorNormalizationTask>("maintenance/indicator-normalization", { method: "POST" });
        applyNormalizationTask(task);
        toast.show(task.reused
          ? `已有${task.mode === "full" ? "全部重新匹配" : "未归类项匹配"}任务正在执行`
          : "已提交后台匹配任务，可离开当前页面");
        scheduleNormalizationPoll();
      } catch (cause) {
        normalizationError.value = cause instanceof Error ? cause.message : "指标字典匹配失败";
      }
    }
  });
}

const previewLoading = ref(false);

async function normalizeAllIndicators() {
  if (previewLoading.value || normalizationTaskActive.value) return;
  previewLoading.value = true;
  normalizationError.value = "";
  let preview: { scanned: number; eligible: number; recovered: number; removed: number; pending: number; excluded: number; reasons: Array<{ reason: string; count: number }> };
  try {
    preview = await request("maintenance/indicator-normalization/preview", { method: "POST" });
  } catch (cause) {
    normalizationError.value = cause instanceof Error ? cause.message : "历史重评估预览失败";
    return;
  } finally {
    previewLoading.value = false;
  }
  confirmDialog.ask({
    title: "历史重评估预览",
    message: `共 ${preview.scanned} 条，预计 ${preview.eligible} 条可进入趋势（新增恢复 ${preview.recovered} 条、移出 ${preview.removed} 条），${preview.pending} 条仍待核对，${preview.excluded} 条不适用或已排除。${preview.reasons.slice(0, 5).map(item => `${item.reason}（${item.count} 条）`).join("；")}。确认后按当前字典重算，保留人工编辑与治理决策，不重新 OCR、调用 AI 或修改原始指标。预览为当前快照，执行结果可能随数据变化。`,
    confirmText: "全部重新匹配",
    danger: true,
    run: async () => {
      normalizationError.value = "";
      try {
        const task = await request<IndicatorNormalizationTask>("maintenance/indicator-normalization", {
          method: "POST",
          body: JSON.stringify({ full: true })
        });
        applyNormalizationTask(task);
        toast.show(task.reused
          ? `已有${task.mode === "full" ? "全部重新匹配" : "未归类项匹配"}任务正在执行`
          : "已提交全部重新匹配任务，可离开当前页面");
        scheduleNormalizationPoll();
      } catch (cause) {
        normalizationError.value = cause instanceof Error ? cause.message : "全部重新匹配失败";
      }
    }
  });
}

onMounted(() => {
  void refreshNormalizationTask();
});

onBeforeUnmount(clearNormalizationPoll);
</script>

<template>
  <section class="settings-page">
    <SubPageHeader
      title="指标管理"
      description="管理指标字典、历史匹配和未命中问题"
      back-to="/me/maintenance"
      back-label="返回维护工具"
    />

    <section class="settings-band">
      <header>
        <div>
          <Database :size="20" />
          <div>
            <h3>指标字典</h3>
            <p>查看核心与远程字典版本、检查远程更新，并管理更新历史和快照回滚。</p>
          </div>
        </div>
        <RouterLink class="soft-action-button compact-soft" to="/me/maintenance/indicator-dictionary">
          管理<ChevronRight :size="16" />
        </RouterLink>
      </header>
    </section>

    <section class="settings-band">
      <header>
        <div>
          <RefreshCw :size="20" />
          <div>
            <h3>历史指标字典匹配</h3>
            <p>为历史原始指标匹配标准名称、单位、分组和趋势关联。</p>
          </div>
        </div>
        <div class="maintenance-actions">
          <button class="soft-action-button danger-action-button" type="button" :disabled="normalizationTaskActive || previewLoading" @click="normalizeAllIndicators">
            <RefreshCw :size="15" :class="{ 'spin-icon': fullNormalizationRunning || previewLoading }" />{{ previewLoading ? "预览中" : fullNormalizationRunning ? "匹配中" : "全部重新匹配" }}
          </button>
          <button class="primary-button" type="button" :disabled="normalizationTaskActive" @click="normalizeIndicators">
            <RefreshCw :size="15" :class="{ 'spin-icon': normalizationRunning }" />{{ normalizationRunning ? "匹配中" : "匹配未归类项" }}
          </button>
        </div>
      </header>
      <p class="preview-hint">这里只重新匹配指标字典，不重新 OCR 或调用 AI，也不会修改原始指标。原始名称或数值提取错误时，请回到报告详情重新识别。</p>
      <div v-if="normalizationTaskActive && normalizationTask" class="maintenance-task-progress">
        <div class="maintenance-task-progress-head">
          <span>{{ normalizationTask.mode === "full" ? "全部重新匹配" : "匹配未归类项" }}</span>
          <strong>{{ normalizationStatusLabel(normalizationTask) }}</strong>
        </div>
        <div class="maintenance-task-progress-track" aria-hidden="true">
          <i :style="{ width: `${normalizationTask.progressPercent}%` }"></i>
        </div>
        <p v-if="normalizationTask.totalReports">
          已处理 {{ normalizationTask.processedReports }} / {{ normalizationTask.totalReports }} 份报告（{{ normalizationTask.progressPercent }}%）
        </p>
        <p v-else>正在扫描需要整理的报告，可离开当前页面继续执行。</p>
      </div>
      <p v-if="normalizationError" class="inline-panel-error">{{ normalizationError }}</p>
      <div v-if="normalizationResult" class="maintenance-result">
        <div><span>扫描原始指标</span><strong>{{ normalizationResult.scanned }}</strong></div>
        <div><span>成功匹配</span><strong>{{ normalizationResult.normalized }}</strong></div>
        <div><span>高/中可信</span><strong>{{ normalizationResult.high }}/{{ normalizationResult.medium }}</strong></div>
        <div><span>保守排除</span><strong>{{ normalizationResult.excluded + normalizationResult.unknown }}</strong></div>
      </div>
    </section>

    <section class="settings-band">
      <header>
        <div>
          <Sparkles :size="20" />
          <div>
            <h3>指标问题池</h3>
            <p>查看未命中核心或远程字典的指标名称，并提交字典补充反馈。</p>
          </div>
        </div>
        <RouterLink class="soft-action-button compact-soft" to="/me/maintenance/indicator-issues">
          查看<ChevronRight :size="16" />
        </RouterLink>
      </header>
    </section>
  </section>
</template>
