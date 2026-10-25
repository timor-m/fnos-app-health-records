<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { Bot, CircleAlert, LoaderCircle, RefreshCw } from "@lucide/vue";
import SubPageHeader from "../../components/SubPageHeader.vue";
import PullIndicator from "../../components/PullIndicator.vue";
import { request } from "../../utils/api";
import { formatDatabaseTime } from "../../utils/time";
import { processingCodeLabel } from "../../utils/processing-code-labels";
import type { AiAuditSummary } from "../../types/api";
import { usePullRefresh } from "../../composables/usePullRefresh";
import { useRefreshOnActivate } from "../../composables/useRefreshOnActivate";
import { useToast } from "../../composables/useToast";

const PAGE_SIZE = 30;
const root = ref<HTMLElement | null>(null);
const sentinel = ref<HTMLElement | null>(null);
const loading = ref(true);
const loadingMore = ref(false);
const error = ref("");
const data = ref<AiAuditSummary | null>(null);
const nextCursor = ref<string | null>(null);
const hasMore = ref(false);
const toast = useToast();
let observer: IntersectionObserver | null = null;
let seq = 0;

function numberText(value: number | null | undefined) {
  return Number(value || 0).toLocaleString("zh-CN");
}

function compactNumberText(value: number | null | undefined) {
  const number = Number(value || 0);
  const abs = Math.abs(number);
  if (abs >= 100_000_000) return `${trimUnit(number / 100_000_000)}亿`;
  if (abs >= 10_000) return `${trimUnit(number / 10_000)}万`;
  if (abs >= 1_000) return `${trimUnit(number / 1_000)}K`;
  return number.toLocaleString("zh-CN");
}

function trimUnit(value: number) {
  const fixed = value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1) : value.toFixed(2);
  return fixed.replace(/\.0+$/, "").replace(/(\.\d*[1-9])0+$/, "$1");
}

function tokenText(value: number | null | undefined) {
  return `${compactNumberText(value)} tokens`;
}

function tokenTitle(value: number | null | undefined) {
  return `${numberText(value)} tokens`;
}

function msText(value: number | null | undefined) {
  if (!value) return "—";
  return value < 1000 ? `${value}ms` : `${(value / 1000).toFixed(1)}s`;
}

function statusText(value: string) {
  return { queued: "排队", processing: "处理中", completed: "成功", failed: "失败", cancelled: "取消" }[value] || value;
}

function sourceText(value: string) {
  return ({indicator_normalization:"指标归一化",health_process_summary:"健康历程整理",report_extraction:"报告整理"} as Record<string,string>)[value]||"AI 任务";
}

function routeText(value: string | null) {
  if (!value) return "";
  const labels: Record<string, string> = {
    checkup: "体检", laboratory: "检验", imaging: "影像", functional: "功能检查",
    pathology: "病理", outpatient: "门诊", inpatient: "住院", prescription: "处方",
    billing: "票据", vaccination: "疫苗", other: "其他"
  };
  return value.split(",").map((item) => labels[item] || item).join("、");
}

async function load(reset = true) {
  let current = seq;
  if (reset) {
    current = ++seq;
    loading.value = true;
    nextCursor.value = null;
  } else {
    if (loading.value || loadingMore.value || !hasMore.value || !nextCursor.value) return true;
    current = seq;
    loadingMore.value = true;
  }
  error.value = "";
  try {
    const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
    if (!reset && nextCursor.value) params.set("cursor", nextCursor.value);
    const page = await request<AiAuditSummary>(`audit/ai?${params.toString()}`);
    if (current !== seq) return true;
    if (reset || !data.value) {
      data.value = page;
    } else {
      data.value = {
        ...page,
        summary: page.summary,
        recent: [
          ...data.value.recent,
          ...page.recent.filter((item) => !data.value?.recent.some((existing) => existing.id === item.id))
        ]
      };
    }
    nextCursor.value = page.nextCursor;
    hasMore.value = page.hasMore;
    return true;
  } catch (cause) {
    if (current === seq) error.value = cause instanceof Error ? cause.message : "AI 审计加载失败";
    return false;
  } finally {
    if (current === seq) {
      loading.value = false;
      loadingMore.value = false;
    }
  }
}

const { pullDistance, refreshing, refresh } = usePullRefresh(root, async () => {
  const succeeded = await load(true);
  toast.show(succeeded ? "AI 审计已刷新" : "刷新失败，请稍后重试");
});

function attachObserver(element: HTMLElement | null) {
  observer?.disconnect();
  observer = null;
  if (!element) return;
  observer = new IntersectionObserver((entries) => {
    if (entries.some((entry) => entry.isIntersecting)) void load(false);
  }, { rootMargin: "260px 0px", threshold: 0.01 });
  observer.observe(element);
}

onMounted(async () => {
  await load(true);
  attachObserver(sentinel.value);
});
useRefreshOnActivate(() => load(true));
onBeforeUnmount(() => observer?.disconnect());
</script>

<template>
  <section ref="root" class="settings-page">
    <SubPageHeader back-to="/me/maintenance" back-label="返回维护工具" title="AI 审计" description="统计 AI 解析调用、成功失败、Token 消耗和最近任务" />
    <PullIndicator :distance="pullDistance" :refreshing="refreshing" />

    <section class="settings-band">
      <header>
        <Bot :size="20" />
        <div><h3>调用概览</h3><p>统计报告整理、指标归一化和健康历程整理的 AI 调用，Token 来自已返回的模型用量。</p></div>
        <button class="plain-icon-button" type="button" :disabled="loading || refreshing" title="刷新" @click="refresh">
          <RefreshCw :size="17" :class="{ 'spin-icon': loading || refreshing }" />
        </button>
      </header>
      <p v-if="error" class="inline-panel-error">{{ error }}</p>
      <div v-if="loading && !data" class="loading-list audit-loading"><span v-for="index in 4" :key="index"></span></div>
      <div v-else-if="data" class="ai-audit-grid">
        <div><span>任务数</span><strong>{{ numberText(data.summary.jobCount) }}</strong></div>
        <div><span>调用次数</span><strong>{{ numberText(data.summary.callCount) }}</strong></div>
        <div><span>成功 / 失败</span><strong>{{ numberText(data.summary.successJobs) }} / {{ numberText(data.summary.failedJobs) }}</strong></div>
        <div><span>排队 / 处理中</span><strong>{{ numberText(data.summary.queuedJobs) }} / {{ numberText(data.summary.processingJobs) }}</strong></div>
        <div><span>总 Tokens</span><strong :title="tokenTitle(data.summary.totalTokens)">{{ compactNumberText(data.summary.totalTokens) }}</strong></div>
        <div>
          <span>输入 / 输出 Tokens</span>
          <strong :title="`${tokenTitle(data.summary.promptTokens)} / ${tokenTitle(data.summary.completionTokens)}`">
            {{ compactNumberText(data.summary.promptTokens) }} / {{ compactNumberText(data.summary.completionTokens) }}
          </strong>
        </div>
        <div><span>平均耗时</span><strong>{{ msText(data.summary.avgElapsedMs) }}</strong></div>
      </div>
    </section>

    <section class="settings-band dense-audit-card">
      <div v-if="loading && !data" class="loading-list audit-loading"><span v-for="index in 6" :key="index"></span></div>
      <div v-else-if="!data?.recent.length" class="preview-hint">暂无 AI 调用记录。</div>
      <div v-else class="ai-audit-list">
        <article v-for="item in data.recent" :key="item.id" :class="{ failed: item.status === 'failed' }">
          <div>
            <strong>{{ item.reportTitle }}</strong>
            <span>{{ sourceText(item.source) }} · {{ formatDatabaseTime(item.createdAt) }} · {{ item.model || "未返回模型" }}<template v-if="item.routedContentTypes"> · {{ routeText(item.routedContentTypes) }}</template></span>
          </div>
          <em>{{ statusText(item.status) }}</em>
          <small :title="tokenTitle((item.promptTokens || 0) + (item.completionTokens || 0))">
            尝试 {{ item.attempts }} 次 · {{ tokenText((item.promptTokens || 0) + (item.completionTokens || 0)) }} · {{ msText(item.elapsedMs) }}
          </small>
          <p v-if="item.errorMessage"><CircleAlert :size="14" />{{ processingCodeLabel(item.errorCode || "AI_ERROR") }} · {{ item.errorMessage }}</p>
        </article>
      </div>
      <div ref="sentinel" class="load-more-indicator" aria-live="polite">
        <template v-if="loadingMore"><LoaderCircle :size="18" class="spin-icon" /><span>正在加载更多…</span></template>
        <template v-else-if="hasMore"><span>继续下滑加载更多</span></template>
        <template v-else-if="data?.recent.length"><span>已加载全部 AI 调用记录</span></template>
      </div>
    </section>
  </section>
</template>
