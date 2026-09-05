<script setup lang="ts">
import { computed, nextTick, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, watch } from "vue";
import {
  ArrowDown, ArrowUp, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, CircleAlert, Clock3, Download,
  CircleStop, FileImage, FileText, LoaderCircle, Maximize2, Pencil, Plus, RefreshCw, RotateCw, ScrollText, Search,
  Sparkles, Trash2, X
} from "@lucide/vue";
import ClinicalFactEditor from "./ClinicalFactEditor.vue";
import DateTimePicker from "./DateTimePicker.vue";
import OcrTextOverlay from "./OcrTextOverlay.vue";
import ReportStructuredSectionEditor from "./ReportStructuredSectionEditor.vue";
import FormSelect from "./FormSelect.vue";
import ImageViewer, { type ImageViewerPage } from "./ImageViewer.vue";
import MorphologyFindingEditor from "./MorphologyFindingEditor.vue";
import { request, apiUrl } from "../utils/api";
import { downloadStreamedFile } from "../utils/download";
import { describeObservationAbnormal, formatObservationNormalization, formatReferenceRange } from "../utils/indicator-display";
import { formatDatabaseTime, formatDatabaseTimeWithYear } from "../utils/time";
import { hasEmptyCompletedOcr, resolveAiTriggerState } from "../utils/ai-trigger-state";
import { resolveClinicalEvidenceNavigation } from "../utils/clinical-evidence-navigation";
import { resolveReportReprocessNotice } from "../utils/report-reprocess-state";
import { resolveProcessingDelayNotice, resolveProcessingRecoveryState } from "../utils/processing-recovery-state";
import { processingCodeLabel } from "../utils/processing-code-labels";
import { getDeploymentCopy } from "../utils/deployment-copy";
import {
  calculateProcessingJobProgress, groupProcessingJobBatches, isProcessingJobBatchSettled,
  processingJobBatchLabel, type ProcessingJobBatch
} from "../utils/processing-job-batches";
import type {
  AiExtractionUnitProgress, ClinicalEvidence, ClinicalFactType, OcrPageDetail, OcrPageText, ProcessingJob, ProcessingJobEvent,
  ProcessingDiagnosticReviewItem, ProcessingJobEventDetail,
  IndicatorCatalogOption, ReportDetail, ReportPage, ReportSummary
} from "../types/api";
import { useAppContext } from "../composables/useAppContext";
import { useConfirm } from "../composables/useConfirm";
import { useScrollLock } from "../composables/useScrollLock";
import { useToast } from "../composables/useToast";

type DuplicateCandidate = ReportDetail["duplicateCandidates"][number];
type DisplayAiUnit = AiExtractionUnitProgress & { displayLabel: string };

const props = defineProps<{
  reportId: string;
  summary?: ReportSummary | null;
  variant: "panel" | "floating";
}>();
const emit = defineEmits<{
  close: [];
  updated: [];
  openCandidate: [candidate: DuplicateCandidate];
}>();

const app = useAppContext();
const deploymentCopy = computed(() => getDeploymentCopy(app.session.value?.authMode));
const toast = useToast();
const confirmDialog = useConfirm();
const detail = ref<ReportDetail | null>(null);
const detailLoading = ref(false);
const detailError = ref("");
const selectedJobs = ref<ProcessingJob[]>([]);
const jobsLoading = ref(false);
const jobsError = ref("");
const jobsPollingStopped = ref(false);
const processingExpanded = ref(false);
const runtimeAvailable = ref(true);
const eventSheetOpen = ref(false);
const eventLoading = ref(false);
const eventPolling = ref(false);
const eventError = ref("");
const eventJob = ref<ProcessingJob | null>(null);
const jobEvents = ref<ProcessingJobEvent[]>([]);
const jobEventDetail = ref<ProcessingJobEventDetail | null>(null);
const viewerOpen = ref(false);
const viewerIndex = ref(0);
const pdfViewerOpen = ref(false);
const pdfViewerPage = ref<ReportPage | null>(null);
const ocrSheetOpen = ref(false);
const ocrLoading = ref(false);
const ocrError = ref("");
const ocrPages = ref<OcrPageText[]>([]);
const ocrReportId = ref<string | null>(null);
const ocrDetailPage = ref<OcrPageDetail | null>(null);
const ocrDetailLoading = ref(false);
const ocrDetailError = ref("");
const showOcrOverlay = ref(false);
const editOriginalImage = ref<HTMLImageElement | null>(null);
const observationOriginalImage = ref<HTMLImageElement | null>(null);
// 记录已完成加载的图片页 id：翻页后图片未就绪前不渲染 OCR 标记，避免标记先出现、
// 图片后撑开造成的抖动。
const loadedOriginalImagePageId = ref("");
const loadedOcrCompareImagePageId = ref("");
const diagnosticReviewItem = ref<ProcessingDiagnosticReviewItem | null>(null);
const ocrComparePageNumber = ref<number | null>(null);
const ocrCompareImage = ref<HTMLImageElement | null>(null);
const confirming = ref(false);
const triggeringAi = ref(false);
const reprocessingReport = ref(false);
const cancellingJobs = ref(false);
const trashingReport = ref(false);
const editOpen = ref(false);
const morphologyEditItem = ref<ReportDetail["morphologyFindings"][number] | null>(null);
const clinicalFactEditor = ref<{
  type: ClinicalFactType;
  fact: (Record<string, unknown> & { id?: string }) | null;
} | null>(null);
const structuredSectionEditor = ref<ReportDetail["structuredSections"][number] | null | "create">(null);
const allObservationsOpen = ref(false);
const observationEditorOpen = ref(false);
const editingObservationId = ref<string | null>(null);
const selectedObservationId = ref<string | null>(null);
const observationSourcePageIndex = ref(0);
const loadedObservationOriginalPageId = ref("");
const savingObservation = ref(false);
const observationEditorError = ref("");
const observationCatalogQuery = ref("");
const observationCatalogOptions = ref<IndicatorCatalogOption[]>([]);
const observationCatalogLoading = ref(false);
const observationForm = ref({
  sectionName: "", itemCode: "", itemName: "", resultText: "", numericValue: null as number | null,
  unit: "", referenceLow: null as number | null, referenceHigh: null as number | null,
  referenceText: "", abnormalFlag: "" as "" | "high" | "low" | "abnormal" | "normal",
  canonicalKey: ""
});
const editOriginalIndex = ref(0);
const savingReport = ref(false);
const savingPages = ref(false);
const exportingOriginal = ref(false);
const originalExportStatus = ref<"ready" | "generating" | "available">("available");
let originalExportStatusTimer: ReturnType<typeof setInterval> | null = null;
const pageRefreshAwaitingJobs = ref(false);
const editForm = ref({
  title: "", reportType: "other", hospitalName: "", hospitalBranch: "", city: "",
  departmentName: "", orderingDepartment: "", performingDepartment: "", reportingDepartment: "",
  bodyPart: "", reportIssuedAt: "", examinedAt: "", clinicalDiagnosis: "", purpose: "",
  findings: "", impression: "", summary: "", recommendation: ""
});
let jobsTimer: ReturnType<typeof setInterval> | null = null;
let eventTimer: ReturnType<typeof setInterval> | null = null;
let detailSeq = 0;
let jobsSeq = 0;
let jobsLoadingSeq = 0;
let ocrSeq = 0;
let jobsPollFailures = 0;
let eventSeq = 0;
let eventRequestPending = false;
const OBSERVATION_PREVIEW_LIMIT = 10;

/* 处理进度区默认折叠：任何写入 jobsError 的失败都要同时展开该区并 toast，否则按钮停了用户却看不到原因 */
function failJobsAction(cause: unknown, fallback: string) {
  jobsError.value = cause instanceof Error ? cause.message : fallback;
  processingExpanded.value = true;
  toast.show(jobsError.value, 3600);
}

const currentDetail = computed(() =>
  detail.value?.id === props.reportId ? detail.value : null
);
const currentSummary = computed(() =>
  props.summary?.id === props.reportId ? props.summary : null
);
const source = computed(() => currentDetail.value || currentSummary.value || null);
const isAiEventLog = computed(() => eventJob.value?.jobType === "ai_extract");
const orderedAiUnits = computed<DisplayAiUnit[]>(() => {
  const units = [...(jobEventDetail.value?.units || [])].sort((left, right) => {
    const leftSupplement = left.unitType === "supplement" ? 1 : 0;
    const rightSupplement = right.unitType === "supplement" ? 1 : 0;
    return leftSupplement - rightSupplement
      || (left.pageNumbers[0] ?? Number.MAX_SAFE_INTEGER) - (right.pageNumbers[0] ?? Number.MAX_SAFE_INTEGER)
      || left.unitIndex - right.unitIndex
      || left.id.localeCompare(right.id);
  });
  let mainSequence = 0;
  let supplementSequence = 0;
  return units.map((unit) => ({
    ...unit,
    displayLabel: unit.unitType === "supplement"
      ? `遗漏补提取 ${++supplementSequence}`
      : `解析单元 ${++mainSequence}`
  }));
});
const completedAiUnits = computed(() => orderedAiUnits.value.filter((unit) =>
  unit.status === "completed" || unit.status === "warning"
).length);
const aiUnitProgressPercent = computed(() => orderedAiUnits.value.length
  ? Math.round(completedAiUnits.value / orderedAiUnits.value.length * 100)
  : 0
);
const processingDiagnostics = computed(() => jobEventDetail.value?.diagnostics || null);
const diagnosticSourceLineIds = computed(() => diagnosticReviewItem.value?.sourceLineIds || []);
const diagnosticRepairMode = (item: ProcessingDiagnosticReviewItem) =>
  item.issueType === "ocr_content" ? "ocr_ai" : "ai";
const diagnosticRepairLabel = (item: ProcessingDiagnosticReviewItem) =>
  diagnosticRepairMode(item) === "ocr_ai" ? "重新 OCR + AI" : "重新 AI 整理";
const diagnosticRepairDescription = (item: ProcessingDiagnosticReviewItem) =>
  diagnosticRepairMode(item) === "ocr_ai"
    ? "将基于原件重新识别全部页面，再自动进行 AI 整理。"
    : "将复用当前 OCR 文本重新进行 AI 整理。";
const diagnosticMetrics = computed(() => {
  const diagnostics = processingDiagnostics.value;
  if (!diagnostics) return [];
  const metrics = diagnostics.metrics;
  if (jobEventDetail.value?.job.jobType === "ai_extract") {
    return [
      { label: "OCR 有效页", value: `${Math.max(0, metrics.ocrCompletedPages - metrics.ocrEmptyPages)}/${metrics.pageCount}` },
      { label: "解析单元", value: `${metrics.completedUnits + metrics.warningUnits}/${metrics.plannedUnits}` },
      { label: "补提取", value: String(metrics.supplementUnits) },
      { label: "AI 请求", value: metrics.aiFailureCount ? `${metrics.aiRequestCount}（失败 ${metrics.aiFailureCount}）` : String(metrics.aiRequestCount) },
      { label: "测量候选", value: String(metrics.candidateCount) },
      { label: "候选闭环", value: `${metrics.resolvedCandidateCount}/${metrics.candidateCount}（${metrics.candidateClosurePercent}%）` },
      { label: "有效提取", value: String(metrics.localExtractedCount + metrics.aiExtractedCount) },
      { label: "重复合并", value: String(metrics.redundantCount) },
      { label: "待核对", value: String(metrics.unresolvedCount) },
      { label: "证据拒绝", value: String(metrics.postprocessRejectedCount) },
      { label: "落库指标", value: String(metrics.persistedObservationCount) },
      { label: "趋势可用", value: `${metrics.trendReadyObservationCount} 项 / ${metrics.trendSeriesCount} 类` }
    ];
  }
  if (jobEventDetail.value?.job.jobType === "ocr") {
    return [
      { label: "报告页数", value: String(metrics.pageCount) },
      { label: "OCR 完成", value: String(metrics.ocrCompletedPages) },
      { label: "空内容页", value: String(metrics.ocrEmptyPages) },
      { label: "低质量页", value: String(metrics.ocrWeakPages) },
      { label: "失败页", value: String(metrics.ocrFailedPages) }
    ];
  }
  return [{ label: "报告页数", value: String(metrics.pageCount) }];
});
const eventLogHasContent = computed(() => isAiEventLog.value
  ? Boolean(jobEventDetail.value)
  : jobEvents.value.length > 0
);
const processingJobGroups = computed(() => groupProcessingJobBatches(selectedJobs.value));
const currentBatch = computed(() => processingJobGroups.value.currentBatch);
const currentJobs = computed(() => processingJobGroups.value.currentJobs);
const historicalBatches = computed(() => processingJobGroups.value.historicalBatches);
/* OCR 全部完成但没有任何文字：只判断当前批次，避免历史空 OCR 覆盖后续成功结果。 */
const ocrEmptyNotice = computed(() => hasEmptyCompletedOcr(currentJobs.value));
const completedJobs = computed(() => currentJobs.value.filter((job) => job.status === "completed").length);
const failedJobs = computed(() => currentJobs.value.filter((job) => job.status === "failed"));
const progressPercent = computed(() => calculateProcessingJobProgress(currentJobs.value));
const hasRunningJobs = computed(() => currentJobs.value.some((job) => ["queued", "processing"].includes(job.status)));
const processingRecoveryState = computed(() => resolveProcessingRecoveryState({
  reprocessingReport: reprocessingReport.value,
  jobsLoading: jobsLoading.value,
  jobsPollingStopped: jobsPollingStopped.value,
  pageRefreshAwaitingJobs: pageRefreshAwaitingJobs.value,
  hasRunningJobs: hasRunningJobs.value,
  reportStatus: source.value?.status
}));
const processingDelayNotice = computed(() => resolveProcessingDelayNotice(currentJobs.value));
const needsOcrRuntime = computed(() =>
  !runtimeAvailable.value && currentJobs.value.some((job) => job.jobType === "ocr" && job.status !== "completed")
);
const viewerImagePages = computed<ImageViewerPage[]>(() =>
  (detail.value?.pages || []).map((page) => ({
    key: page.id,
    fullUrl: viewerFullUrl(page),
    previewUrl: page.hasThumbnail ? thumbnailUrl(page) : undefined,
    label: `第 ${page.pageNumber} 页`,
    downloadUrl: originalUrl(page),
    downloadName: page.originalName
  }))
);
const firstPdfPage = computed(() => detail.value?.pages.find((page) => page.mimeType === "application/pdf") || null);
const currentOriginalPage = computed(() => detail.value?.pages[editOriginalIndex.value] || null);
const pdfViewerSrc = computed(() => {
  const page = pdfViewerPage.value;
  if (!page) return "";
  return `${originalUrl(page)}#page=${page.sourcePageNumber || page.pageNumber}`;
});
const hasAiContent = computed(() => Boolean(
  detail.value && (
    detail.value.summary || detail.value.findings || detail.value.impression || detail.value.recommendation
    || detail.value.clinicalDiagnosis || detail.value.purpose || detail.value.chiefComplaint
    || detail.value.observations.length || detail.value.morphologyFindings.length
    || detail.value.diagnoses.length || detail.value.medications.length || detail.value.procedures.length
    || detail.value.vaccinations.length || detail.value.billingSummary || detail.value.billingItems.length
    || detail.value.structuredSections.length
  )
));
const primaryObservations = computed(() => detail.value?.observations.filter((item) => item.displayTier === "primary") || []);
const secondaryObservations = computed(() => detail.value?.observations.filter((item) => item.displayTier === "secondary") || []);
const medicalCandidateObservations = computed(() => secondaryObservations.value.filter((item) => item.displayCategory === "medical_candidate"));
const qualitativeObservations = computed(() => secondaryObservations.value.filter((item) => item.displayCategory === "qualitative_finding"));
const technicalObservations = computed(() => secondaryObservations.value.filter((item) => item.displayCategory === "technical_measurement"));
const governanceObservations = computed(() => detail.value?.observations.filter((item) => item.displayTier === "governance_only") || []);
const pendingReviewObservations = computed(() => [...secondaryObservations.value, ...governanceObservations.value]);
const selectedObservation = computed(() => detail.value?.observations.find((item) => item.id === selectedObservationId.value) || null);
const observationSourcePage = computed(() => detail.value?.pages[observationSourcePageIndex.value] || null);
const observationEvidenceLineIds = computed(() => {
  const observation = selectedObservation.value;
  const page = observationSourcePage.value;
  if (!observation || !page || observation.evidence?.pageId !== page.id) return [];
  return observation.evidence.lineIds;
});
const prioritizedSecondaryObservations = computed(() => [
  ...medicalCandidateObservations.value,
  ...qualitativeObservations.value,
  ...technicalObservations.value
]);
const readableObservations = computed(() => [...primaryObservations.value, ...prioritizedSecondaryObservations.value]);
const abnormalObservations = computed(() => readableObservations.value.filter((item) =>
  !item.abnormalConflict && ["high", "low", "abnormal"].includes(String(item.displayAbnormalFlag))
));
const conflictingObservations = computed(() => readableObservations.value.filter((item) => item.abnormalConflict));
const previewSourceObservations = computed(() => primaryObservations.value.length ? primaryObservations.value : prioritizedSecondaryObservations.value);
const visibleObservations = computed(() => previewSourceObservations.value.slice(0, OBSERVATION_PREVIEW_LIMIT));
/* 重复匹配是双向的，但确认提示只属于尚未归档的新报告，避免打开已有报告时反向显示同一警告。 */
const duplicateCandidates = computed(() =>
  source.value?.status === "needs_review"
    ? currentDetail.value?.duplicateCandidates || []
    : []
);
const aiJobs = computed(() => currentJobs.value.filter((job) => job.jobType === "ai_extract"));
const runningAiJobs = computed(() => aiJobs.value.filter((job) => ["queued", "processing"].includes(job.status)));
const failedAiJobs = computed(() => aiJobs.value.filter((job) => job.status === "failed"));
const completedAiJobs = computed(() => aiJobs.value.filter((job) => job.status === "completed"));
const aiTriggerState = computed(() => resolveAiTriggerState({
  triggeringAi: triggeringAi.value,
  pageMutationPending: savingPages.value || pageRefreshAwaitingJobs.value,
  jobsLoading: jobsLoading.value,
  reportStatus: source.value?.status,
  jobs: currentJobs.value
}));
const reprocessNotice = computed(() => resolveReportReprocessNotice(
  currentJobs.value,
  hasAiContent.value,
  pageRefreshAwaitingJobs.value
));
const canTriggerAi = computed(() => !hasAiContent.value);
const aiEmptyHint = computed(() => {
  if (runningAiJobs.value.length) return "AI 整理任务已在队列中，请稍候；处理进度里可以查看当前状态和详细日志。";
  if (failedAiJobs.value.length) return "AI 整理失败，可在处理进度里查看日志，也可以点击“重新整理”再次尝试。";
  if (completedAiJobs.value.length) return "上次 AI 整理没有得到结构化内容，可点击“重新整理”再试一次。";
  return "已有 OCR 文本后可手动触发 AI 整理；如果提示 AI 未启用，请让管理员先配置模型。";
});

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
const jobStatusMeta: Record<ProcessingJob["status"], { label: string; chip: string }> = {
  queued: { label: "排队中", chip: "chip--info" },
  processing: { label: "处理中", chip: "chip--info" },
  completed: { label: "完成", chip: "chip--green" },
  failed: { label: "失败", chip: "chip--red" },
  cancelled: { label: "已取消", chip: "chip--plain" }
};
const eventTypeLabels: Record<ProcessingJobEvent["eventType"], string> = {
  queued: "进入队列",
  started: "开始处理",
  completed: "处理完成",
  retry_scheduled: "自动重试",
  failed: "最终失败",
  manual_retry: "手动重试",
  cancelled: "已取消"
};

function typeLabel(reportType: string) {
  return typeLabels[reportType] || "其他";
}

function isManualField(fieldKey: string) {
  return Boolean(detail.value?.manualFieldKeys?.includes(fieldKey));
}

function toDateTimeLocalValue(value: string | null | undefined) {
  if (!value) return "";
  const match = value.trim().match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::(\d{2}))?$/);
  if (match) return `${match[1]}T${match[2]}:${match[3] || "00"}`;
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00` : "";
}

function jobLabel(jobType: ProcessingJob["jobType"]) {
  return { pdf_extract: "PDF 拆页", thumbnail: "生成缩略图", ocr: "文字识别", ai_extract: "AI 整理" }[jobType];
}

function batchSummary(batch: ProcessingJobBatch) {
  const completed = batch.jobs.filter((job) => job.status === "completed").length;
  const failed = batch.jobs.filter((job) => job.status === "failed").length;
  const cancelled = batch.jobs.filter((job) => job.status === "cancelled").length;
  return [
    `${batch.jobs.length} 个任务`,
    completed ? `完成 ${completed}` : "",
    failed ? `失败 ${failed}` : "",
    cancelled ? `取消 ${cancelled}` : ""
  ].filter(Boolean).join(" · ");
}

function formatMs(value: number | null) {
  if (value == null) return "";
  if (value < 1000) return `${value}ms`;
  return `${(value / 1000).toFixed(1)}s`;
}

function jobMeta(job: ProcessingJob) {
  const parts = [
    job.pageNumber ? `第 ${job.pageNumber} 页${job.originalName ? ` · ${job.originalName}` : ""}` : "整份报告",
    job.startedAt ? `开始 ${formatDatabaseTime(job.startedAt)}` : `创建 ${formatDatabaseTime(job.createdAt)}`
  ];
  if (job.finishedAt) parts.push(`结束 ${formatDatabaseTime(job.finishedAt)}`);
  if (job.jobType === "ai_extract" && job.aiRequestCount) {
    parts.push(`调用 ${job.aiRequestCount} 次（成功 ${job.aiSuccessCount || 0} / 失败 ${job.aiFailureCount || 0}）`);
  } else if (job.attempts > 0) {
    parts.push(`尝试 ${job.attempts} 次`);
  }
  return parts.join(" · ");
}

function jobDetail(job: ProcessingJob) {
  if (job.errorMessage) return job.errorMessage;
  if (job.jobType === "ocr" && job.ocrEngine) {
    return [job.ocrEngine, job.ocrModelVersion, formatMs(job.ocrElapsedMs)].filter(Boolean).join(" · ");
  }
  if (
    job.jobType === "ai_extract"
    && (
      job.aiModel
      || job.aiElapsedMs != null
      || job.promptTokens != null
      || job.completionTokens != null
      || Boolean(job.unmatchedCandidates)
    )
  ) {
    const tokens = [job.promptTokens, job.completionTokens].some((value) => value != null)
      ? `${job.promptTokens || 0}/${job.completionTokens || 0} tokens`
      : "";
    const quality = job.unmatchedCandidates ? `${job.unmatchedCandidates} 项待核对` : "";
    return [job.aiModel, formatMs(job.aiElapsedMs), tokens, quality].filter(Boolean).join(" · ");
  }
  if (job.jobType === "ai_extract" && job.plannedUnits) {
    const pages = job.currentPages?.length ? `当前第 ${job.currentPages.join("、")} 页` : "";
    return [`解析单元 ${job.completedUnits || 0}/${job.plannedUnits}`, pages].filter(Boolean).join(" · ");
  }
  return job.status === "processing" ? "任务正在后台执行" : job.status === "queued" ? "等待后台队列处理" : "任务已完成";
}

function eventTitle(event: ProcessingJobEvent) {
  if (event.detail?.stage === "duplicate_precheck") return "发现重复报告";
  const prefix = eventTypeLabels[event.eventType] || event.eventType;
  return event.attempt > 0 ? `${prefix} · 第 ${event.attempt} 次尝试` : prefix;
}

function eventDetail(event: ProcessingJobEvent) {
  const payload = event.detail || {};
  const ocrSourceText = {
    pdf_text: "PDF 文字层",
    pdf_render: "PDF 高清渲染 OCR",
    pdf_text_plus_render: "PDF 文字层+高清 OCR 合并"
  }[typeof payload.ocrSource === "string" ? payload.ocrSource : ""] || "";
  const parts = [
    typeof payload.code === "string" ? `错误码 ${payload.code}` : "",
    typeof payload.elapsedMs === "number" ? `耗时 ${formatMs(payload.elapsedMs)}` : "",
    typeof payload.retryDelaySeconds === "number" ? `${payload.retryDelaySeconds} 秒后自动重试` : "",
    typeof payload.model === "string" ? String(payload.model) : "",
    typeof payload.engine === "string" ? `OCR ${payload.engine}` : "",
    typeof payload.modelVersion === "string" ? String(payload.modelVersion) : "",
    ocrSourceText,
    typeof payload.renderScale === "number" ? `${payload.renderScale}x 渲染` : "",
    typeof payload.mergedLines === "number" ? `合并 ${payload.mergedLines} 行` : "",
    typeof payload.ocrLines === "number" && typeof payload.mergedLines !== "number" ? `OCR ${payload.ocrLines} 行` : "",
    typeof payload.pdfTextLines === "number" ? `文字层 ${payload.pdfTextLines} 行` : "",
    typeof payload.imageCoverage === "number" && payload.imageCoverage > 0
      ? `图片覆盖 ${Math.round(payload.imageCoverage * 100)}%`
      : "",
    typeof payload.promptTokens === "number" || typeof payload.completionTokens === "number"
      ? `${Number(payload.promptTokens || 0)}/${Number(payload.completionTokens || 0)} tokens`
      : "",
    Array.isArray(payload.pageNumbers) && payload.pageNumbers.length
      ? `第 ${payload.pageNumbers.join("、")} 页`
      : "",
    typeof payload.unitIndex === "number" ? `单元 ${payload.unitIndex + 1}` : "",
    typeof payload.characterCount === "number" ? `${payload.characterCount} 字符` : "",
    typeof payload.candidateCount === "number" ? `${payload.candidateCount} 个候选行` : "",
    typeof payload.unmatchedCandidates === "number" && payload.unmatchedCandidates > 0
      ? `${payload.unmatchedCandidates} 项待核对`
      : ""
  ].filter(Boolean);
  return parts.join(" · ");
}

function aiUnitStatusLabel(status: AiExtractionUnitProgress["status"]) {
  return {
    planned: "等待处理",
    processing: "处理中",
    completed: "已完成",
    warning: "已完成，有待核对",
    failed: "处理失败"
  }[status];
}

function aiJobStatusLabel(status: string) {
  return {
    queued: "等待开始",
    processing: "处理中",
    completed: "全部完成",
    failed: "任务失败",
    cancelled: "已取消"
  }[status] || status;
}

function diagnosticStageLabel(stage: ProcessingJobEventDetail["diagnostics"]["stage"]) {
  return {
    local_processing: "文件处理",
    ocr: "OCR 识别",
    ai_planning: "AI 规划",
    ai_call: "AI 解析",
    supplement: "遗漏补提取",
    post_processing: "结果校验",
    completed: "处理完成"
  }[stage];
}

function aiUnitTypeLabel(type: AiExtractionUnitProgress["unitType"]) {
  return type === "page_chunk" ? "页内分块" : type === "supplement" ? "遗漏补提取" : "完整页面";
}


function formatPageNumbers(pages: number[]) {
  if (!pages.length) return "页码待规划";
  const sorted = [...new Set(pages)].sort((left, right) => left - right);
  const ranges: string[] = [];
  let start = sorted[0]!;
  let end = start;
  for (const page of sorted.slice(1)) {
    if (page === end + 1) {
      end = page;
      continue;
    }
    ranges.push(start === end ? String(start) : `${start}-${end}`);
    start = page;
    end = page;
  }
  ranges.push(start === end ? String(start) : `${start}-${end}`);
  return `第 ${ranges.join("、")} 页`;
}

function aiUnitMeta(unit: AiExtractionUnitProgress) {
  const tokens = unit.promptTokens != null || unit.completionTokens != null
    ? `${unit.promptTokens || 0}/${unit.completionTokens || 0} tokens`
    : "";
  const candidateProgress = unit.candidateCount > 0
    ? `候选 ${unit.candidateCount} · 匹配 ${unit.matchedCount}`
    : "";
  return [
    aiUnitTypeLabel(unit.unitType),
    unit.characterCount > 0 ? `${unit.characterCount} 字符` : "",
    candidateProgress,
    unit.attempts > 1 ? `${unit.attempts} 次调用` : unit.attempts === 1 ? "1 次调用" : "",
    formatMs(unit.elapsedMs),
    tokens,
    unit.model
  ].filter(Boolean).join(" · ");
}

function originalUrl(page: ReportPage) {
  return apiUrl(`reports/${page.reportId}/pages/${page.id}/original`);
}

async function downloadReportOriginal() {
  if (exportingOriginal.value) return;
  exportingOriginal.value = true;
  try {
    if (originalExportStatus.value !== "ready") {
      originalExportStatus.value = "generating";
      await request(`reports/${encodeURIComponent(props.reportId)}/original`, { method: "POST" });
      for (let attempt = 0; attempt < 300; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        const status = await request<{ status: "ready" | "generating" | "available" }>(`reports/${encodeURIComponent(props.reportId)}/original/status`);
        originalExportStatus.value = status.status;
        if (status.status === "ready") break;
      }
      if (originalExportStatus.value !== "ready") throw new Error("PDF 生成超时，请稍后再试");
    }
    await downloadStreamedFile(`reports/${encodeURIComponent(props.reportId)}/original`, "健康报告.pdf");
  } catch (cause) {
    toast.show(cause instanceof Error ? cause.message : "报告原件导出失败");
  } finally {
    exportingOriginal.value = false;
  }
}

function stopOriginalExportStatusPolling() {
  if (originalExportStatusTimer) clearInterval(originalExportStatusTimer);
  originalExportStatusTimer = null;
}

function startOriginalExportStatusPolling(reportId: string) {
  stopOriginalExportStatusPolling();
  originalExportStatusTimer = setInterval(() => {
    void request<{ status: "ready" | "generating" | "available" }>(`reports/${encodeURIComponent(reportId)}/original/status`)
      .then((status) => {
        if (props.reportId !== reportId) return;
        originalExportStatus.value = status.status;
        if (status.status !== "generating") stopOriginalExportStatusPolling();
      })
      .catch(() => undefined);
  }, 1500);
}

function thumbnailUrl(page: ReportPage) {
  return apiUrl(`reports/${page.reportId}/pages/${page.id}/thumbnail`);
}

function previewUrl(page: ReportPage) {
  return apiUrl(`reports/${page.reportId}/pages/${page.id}/preview`);
}

function viewerFullUrl(page: ReportPage) {
  return page.mimeType === "application/pdf" ? previewUrl(page) : originalUrl(page);
}

function handleOriginalClick(index: number) {
  const selection = window.getSelection()?.toString() || "";
  if (selection.trim()) return;
  openOriginalViewer(index);
}

function openOriginalViewer(index: number) {
  if (!viewerImagePages.value[index]) return;
  viewerIndex.value = index;
  viewerOpen.value = true;
}

function openPdfOriginalViewer(page: ReportPage) {
  pdfViewerPage.value = page;
  pdfViewerOpen.value = true;
}

function closePdfOriginalViewer() {
  pdfViewerOpen.value = false;
  pdfViewerPage.value = null;
}

/* 弹层打开期间锁定背景滚动（页面缩放已全局禁用） */
useScrollLock(computed(() =>
  pdfViewerOpen.value || editOpen.value || Boolean(morphologyEditItem.value)
  || Boolean(clinicalFactEditor.value) || ocrSheetOpen.value || eventSheetOpen.value
  || Boolean(structuredSectionEditor.value) || allObservationsOpen.value || observationEditorOpen.value
));

const observationFlagOptions = [
  { value: "", label: "未标记" },
  { value: "normal", label: "正常" },
  { value: "high", label: "偏高" },
  { value: "low", label: "偏低" },
  { value: "abnormal", label: "异常" }
];
const observationCatalogSelectOptions = computed(() => [
  { value: "", label: "不指定标准指标" },
  ...observationCatalogOptions.value.map((item) => ({
    value: item.canonicalKey,
    label: `${item.displayName} · ${item.category}${item.defaultUnit ? ` · ${item.defaultUnit}` : ""}`
  }))
]);

async function searchObservationCatalog() {
  observationCatalogLoading.value = true;
  observationEditorError.value = "";
  try {
    const options = await request<IndicatorCatalogOption[]>(
      `reports/${encodeURIComponent(props.reportId)}/indicator-catalog?q=${encodeURIComponent(observationCatalogQuery.value.trim())}`
    );
    observationCatalogOptions.value = [...new Map(
      [...observationCatalogOptions.value, ...options].map((item) => [item.canonicalKey, item])
    ).values()];
  } catch (cause) {
    observationEditorError.value = cause instanceof Error ? cause.message : "本地指标字典查询失败";
  } finally {
    observationCatalogLoading.value = false;
  }
}

function openObservationEditor(item?: ReportDetail["observations"][number]) {
  selectedObservationId.value = item?.id || null;
  const evidencePageIndex = item?.evidence?.pageId
    ? detail.value?.pages.findIndex((page) => page.id === item.evidence?.pageId) ?? -1
    : -1;
  observationSourcePageIndex.value = evidencePageIndex >= 0 ? evidencePageIndex : 0;
  editingObservationId.value = item?.id || null;
  observationEditorError.value = "";
  observationCatalogQuery.value = item?.itemName || "";
  observationCatalogOptions.value = item?.canonicalKey && item.canonicalName ? [{
    canonicalKey: item.canonicalKey,
    displayName: item.canonicalName,
    category: "当前指标",
    defaultUnit: item.canonicalUnit,
    aliases: []
  }] : [];
  observationForm.value = {
    sectionName: item?.sectionName || "",
    itemCode: item?.itemCode || "",
    itemName: item?.itemName || "",
    resultText: item?.resultText || "",
    numericValue: item?.numericValue ?? null,
    unit: item?.unit || "",
    referenceLow: item?.referenceLow ?? null,
    referenceHigh: item?.referenceHigh ?? null,
    referenceText: item?.referenceText || "",
    abnormalFlag: item?.abnormalFlag || "",
    canonicalKey: item?.manualCanonicalKey || item?.canonicalKey || ""
  };
  observationEditorOpen.value = true;
  if (item?.itemName) void searchObservationCatalog();
}

function closeObservationEditor() {
  observationEditorOpen.value = false;
  editingObservationId.value = null;
}

function closeAllObservations() {
  allObservationsOpen.value = false;
  closeObservationEditor();
  selectedObservationId.value = null;
}

async function saveObservation() {
  if (!observationForm.value.itemName.trim()) {
    observationEditorError.value = "请填写指标名称";
    return;
  }
  savingObservation.value = true;
  observationEditorError.value = "";
  try {
    const path = editingObservationId.value
      ? `reports/${encodeURIComponent(props.reportId)}/observations/${encodeURIComponent(editingObservationId.value)}`
      : `reports/${encodeURIComponent(props.reportId)}/observations`;
    detail.value = await request<ReportDetail>(path, {
      method: editingObservationId.value ? "PUT" : "POST",
      body: JSON.stringify(observationForm.value)
    });
    observationEditorOpen.value = false;
    emit("updated");
    toast.show(editingObservationId.value ? "指标校对已保存" : "指标已添加");
  } catch (cause) {
    observationEditorError.value = cause instanceof Error ? cause.message : "指标保存失败";
  } finally {
    savingObservation.value = false;
  }
}

function observationAbnormalDisplay(item: ReportDetail["observations"][number]) {
  return describeObservationAbnormal(item);
}

function observationFlagVisible(item: ReportDetail["observations"][number]) {
  return observationAbnormalDisplay(item).visible;
}

function observationFlagLabel(item: ReportDetail["observations"][number]) {
  return observationAbnormalDisplay(item).label;
}

function observationFlagClass(item: ReportDetail["observations"][number]) {
  const display = observationAbnormalDisplay(item);
  return {
    abnormal: display.isAbnormal,
    review: display.isConflict,
    computed: display.isComputed,
  };
}

function observationInterpretationLine(item: ReportDetail["observations"][number]) {
  return observationAbnormalDisplay(item).explanation;
}

function observationValueLine(item: ReportDetail["observations"][number]) {
  const result = (item.resultText || "").trim();
  const unit = (item.unit || "").trim();
  if (!result) return unit;
  if (!unit) return result;
  /* 部分报告的 resultText 已包含单位（如 “89 mmHg”），避免 “89 mmHg mmHg” 重复展示 */
  if (result.toLowerCase().endsWith(unit.toLowerCase())) return result;
  return `${result} ${unit}`;
}

function observationReferenceLine(item: ReportDetail["observations"][number]) {
  return formatReferenceRange({
    referenceLow: item.referenceLow,
    referenceHigh: item.referenceHigh,
    referenceText: item.referenceText,
    unit: item.referenceText ? null : item.unit,
  }, "");
}

function observationNormalizationLine(item: ReportDetail["observations"][number]) {
  return formatObservationNormalization(item);
}

function medicationDetail(item: ReportDetail["medications"][number]) {
  return [
    item.specification,
    [item.dose, item.doseUnit].filter(Boolean).join(" "),
    item.frequency,
    item.route,
    item.duration,
    item.quantity ? `数量 ${item.quantity}${item.quantityUnit || ""}` : null
  ].filter(Boolean).join(" · ");
}

function procedureDetail(item: ReportDetail["procedures"][number]) {
  return [item.performedAt, item.bodyPart, item.resultText].filter(Boolean).join(" · ");
}

function billingMoney(value: number | null, currency = "CNY") {
  if (value === null || value === undefined) return "";
  return `${currency === "CNY" ? "¥" : `${currency} `}${value.toFixed(2)}`;
}

const clinicalFactTypeLabels: Record<ClinicalFactType, string> = {
  diagnosis: "诊断",
  medication: "用药",
  procedure: "操作",
  vaccination: "疫苗",
  billingSummary: "费用汇总",
  billingItem: "费用明细"
};

const structuredSectionLabels: Record<ReportDetail["structuredSections"][number]["sectionKey"], string> = {
  checkup_package: "体检套餐", checkup_positive_findings: "阳性发现",
  checkup_abnormal_summary: "异常汇总", checkup_final_conclusion: "总检结论",
  checkup_original_recommendation: "原报告建议", laboratory_specimen: "检验标本",
  laboratory_method: "检验方法", imaging_modality: "检查方式", imaging_contrast: "增强信息",
  functional_method: "检查方法", functional_description: "检查描述",
  pathology_specimen: "病理标本", pathology_gross_findings: "肉眼所见",
  pathology_microscopic_findings: "镜下所见", pathology_immunohistochemistry: "免疫组化",
  pathology_grade: "病理分级", pathology_stage: "病理分期", outpatient_history: "病史",
  outpatient_physical_examination: "体格检查", outpatient_disposition: "处置",
  outpatient_advice: "医嘱", inpatient_course: "住院经过",
  inpatient_discharge_instructions: "出院医嘱"
};

const clinicalFactAddTypes = computed<ClinicalFactType[]>(() => {
  const type = detail.value?.reportType;
  if (type === "outpatient") return ["diagnosis", "medication", "procedure"];
  if (type === "inpatient") return ["diagnosis", "medication", "procedure"];
  if (type === "prescription") return ["medication"];
  if (type === "billing") return ["billingSummary", "billingItem"];
  if (type === "vaccination") return ["vaccination"];
  if (type === "pathology") return ["diagnosis", "procedure"];
  return [];
});

function editClinicalFact(type: ClinicalFactType, fact: object | null = null) {
  clinicalFactEditor.value = {
    type,
    fact: fact ? fact as Record<string, unknown> & { id?: string } : null
  };
}

async function clinicalFactSaved() {
  await loadDetail(props.reportId, true);
  emit("updated");
}

function openClinicalEvidence(evidence: ClinicalEvidence) {
  const navigation = resolveClinicalEvidenceNavigation(
    evidence,
    detail.value?.pages || [],
    savingPages.value
  );
  if (navigation.status === "pending") {
    toast.show("报告页面正在更新，请稍候再查看原页");
    return;
  }
  if (navigation.status === "missing_evidence") {
    toast.show("这条记录没有可定位的原页证据");
    return;
  }
  if (navigation.status === "page_not_found") {
    toast.show(`未找到第 ${navigation.pageNumber} 页原件，请刷新报告后重试`);
    return;
  }
  openOriginalViewer(navigation.pageIndex);
}

function removeClinicalFact(type: ClinicalFactType, fact: { id: string }) {
  confirmDialog.ask({
    title: `删除${clinicalFactTypeLabels[type]}`,
    message: "删除后，后续 AI 重跑也不会自动恢复同一条原文记录。",
    confirmText: "删除",
    danger: true,
    run: async () => {
      try {
        detail.value = await request<ReportDetail>(
          `clinical-facts/${type}/${encodeURIComponent(fact.id)}`,
          { method: "DELETE" }
        );
        emit("updated");
        toast.show(`${clinicalFactTypeLabels[type]}已删除`);
      } catch (cause) {
        detailError.value = cause instanceof Error ? cause.message : "删除失败";
        toast.show(detailError.value);
      }
    }
  });
}

async function structuredSectionSaved() {
  await loadDetail(props.reportId, true);
  emit("updated");
}

function removeStructuredSection(section: ReportDetail["structuredSections"][number]) {
  confirmDialog.ask({
    title: `删除${section.title}`,
    message: "删除后，后续 AI 重跑也不会自动恢复同一类原文内容。",
    confirmText: "删除",
    danger: true,
    run: async () => {
      try {
        detail.value = await request<ReportDetail>(
          `report-structured-sections/${encodeURIComponent(section.id)}`,
          { method: "DELETE" }
        );
        emit("updated");
        toast.show(`${section.title}已删除`);
      } catch (cause) {
        detailError.value = cause instanceof Error ? cause.message : "删除失败";
        toast.show(detailError.value);
      }
    }
  });
}

const morphologyLateralityLabels: Record<ReportDetail["morphologyFindings"][number]["laterality"], string> = {
  left: "左侧",
  right: "右侧",
  bilateral: "双侧",
  midline: "正中",
  unspecified: ""
};

function morphologySizeLine(item: ReportDetail["morphologyFindings"][number]) {
  const dimensions = [item.size.length, item.size.width, item.size.height]
    .filter((value): value is number => value !== null && value !== undefined);
  if (!dimensions.length) return "";
  return `${dimensions.join(" × ")}${item.size.unit ? ` ${item.size.unit}` : ""}`;
}

function morphologyLocationLine(item: ReportDetail["morphologyFindings"][number]) {
  return [
    morphologyLateralityLabels[item.laterality],
    item.organ,
    item.region
  ].filter(Boolean).join(" · ") || item.sectionName || "部位未明确";
}

function morphologyClassificationLine(item: ReportDetail["morphologyFindings"][number]) {
  if (!item.classification) return "";
  return item.classification.text
    || [item.classification.system, item.classification.value].filter(Boolean).join(" ");
}

function morphologyEvidenceItems(item: ReportDetail["morphologyFindings"][number]) {
  const seen = new Set<string>();
  return item.evidence.filter((evidence) => {
    const key = `${evidence.pageNumber}:${evidence.quote.normalize("NFKC").replace(/\s+/g, "")}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function morphologyEvidencePagesLine(item: ReportDetail["morphologyFindings"][number]) {
  const pages = [...new Set(
    morphologyEvidenceItems(item)
      .map((evidence) => evidence.pageNumber)
      .filter((pageNumber) => pageNumber > 0),
  )].sort((left, right) => left - right);
  return pages.length ? `第 ${pages.join("、")} 页` : "";
}

function openMorphologyEvidencePage(pageNumber: number) {
  const index = detail.value?.pages.findIndex((page) => page.pageNumber === pageNumber) ?? -1;
  if (index >= 0) openOriginalViewer(index);
}

async function morphologySaved() {
  await loadDetail(props.reportId, true);
  emit("updated");
}

async function openEditReport() {
  const current = source.value;
  if (!current) return;
  const reportId = props.reportId;
  editForm.value = {
    title: current.title || "",
    reportType: current.reportType || "other",
    hospitalName: current.hospitalName || "",
    hospitalBranch: current.hospitalBranch || "",
    city: detail.value?.city || "",
    departmentName: detail.value?.visitDepartment || "",
    orderingDepartment: detail.value?.orderingDepartment || "",
    performingDepartment: detail.value?.performingDepartment || "",
    reportingDepartment: detail.value?.reportingDepartment || "",
    bodyPart: current.bodyPart || "",
    reportIssuedAt: toDateTimeLocalValue(current.reportIssuedAt),
    examinedAt: toDateTimeLocalValue(detail.value?.examinedAt),
    clinicalDiagnosis: detail.value?.clinicalDiagnosis || "",
    purpose: detail.value?.purpose || "",
    findings: detail.value?.findings || "",
    impression: detail.value?.impression || "",
    summary: detail.value?.summary || "",
    recommendation: detail.value?.recommendation || ""
  };
  editOpen.value = true;
  if (
    window.matchMedia("(min-width: 761px)").matches
    && (!ocrPages.value.length || ocrReportId.value !== reportId)
    && !ocrLoading.value
  ) {
    void loadOcrPages(reportId);
  }
  if (currentOriginalPage.value) await loadOcrDetail(currentOriginalPage.value.id);
}

async function saveReportFields() {
  savingReport.value = true;
  detailError.value = "";
  try {
    detail.value = await request<ReportDetail>(`reports/${encodeURIComponent(props.reportId)}`, {
      method: "PUT",
      body: JSON.stringify(editForm.value)
    });
    editOpen.value = false;
    emit("updated");
    toast.show("校对内容已保存");
  } catch (cause) {
    detailError.value = cause instanceof Error ? cause.message : "保存失败";
  } finally {
    savingReport.value = false;
  }
}

async function savePageLayout(pages: ReportPage[]) {
  savingPages.value = true;
  detailError.value = "";
  try {
    detail.value = await request<ReportDetail>(`reports/${encodeURIComponent(props.reportId)}/pages`, {
      method: "PUT",
      body: JSON.stringify({ pages: pages.map((page) => ({ id: page.id, rotation: page.rotation })) })
    });
    pageRefreshAwaitingJobs.value = true;
    await refreshJobs(true);
    emit("updated");
    toast.show("页面调整已保存，正在重新生成缩略图/OCR");
  } catch (cause) {
    detailError.value = cause instanceof Error ? cause.message : "页面调整失败";
  } finally {
    savingPages.value = false;
  }
}

async function rotateSavedPage(page: ReportPage) {
  if (!detail.value) return;
  await savePageLayout(detail.value.pages.map((item) => item.id === page.id ? { ...item, rotation: (item.rotation + 90) % 360 } : item));
}

async function moveSavedPage(page: ReportPage, direction: -1 | 1) {
  if (!detail.value) return;
  const pages = [...detail.value.pages];
  const index = pages.findIndex((item) => item.id === page.id);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= pages.length) return;
  [pages[index], pages[target]] = [pages[target], pages[index]];
  await savePageLayout(pages);
}

async function deleteSavedPage(page: ReportPage) {
  confirmDialog.ask({
    title: "删除单页",
    message: `确认删除第 ${page.pageNumber} 页？原文件不会立即物理清理。`,
    confirmText: "删除",
    danger: true,
    run: async () => {
      savingPages.value = true;
      try {
        detail.value = await request<ReportDetail>(`reports/${encodeURIComponent(props.reportId)}/pages/${encodeURIComponent(page.id)}`, { method: "DELETE" });
        pageRefreshAwaitingJobs.value = true;
        await refreshJobs(true);
        emit("updated");
        toast.show("页面已删除，正在重新生成缩略图/OCR");
      } catch (cause) {
        detailError.value = cause instanceof Error ? cause.message : "页面删除失败";
      } finally {
        savingPages.value = false;
      }
    }
  });
}

/* 原件 swiper：触摸滑动翻页 + OCR 栏联动 */
let originalSwipeX = 0;
let originalSwipeY = 0;

function onOriginalSwipeStart(event: TouchEvent) {
  originalSwipeX = event.touches[0].clientX;
  originalSwipeY = event.touches[0].clientY;
}

function onOriginalSwipeEnd(event: TouchEvent) {
  const dx = event.changedTouches[0].clientX - originalSwipeX;
  const dy = event.changedTouches[0].clientY - originalSwipeY;
  const pageCount = detail.value?.pages.length || 0;
  if (Math.abs(dx) < 56 || Math.abs(dx) <= Math.abs(dy) * 1.5) return;
  if (dx < 0 && editOriginalIndex.value < pageCount - 1) editOriginalIndex.value += 1;
  else if (dx > 0 && editOriginalIndex.value > 0) editOriginalIndex.value -= 1;
}

watch(editOriginalIndex, (index) => {
  const page = detail.value?.pages[index];
  if (!page) return;
  document.getElementById(`edit-ocr-page-${page.pageNumber}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  if (editOpen.value) void loadOcrDetail(page.id);
});

async function loadOcrPages(reportId = props.reportId) {
  const seq = ++ocrSeq;
  ocrLoading.value = true;
  ocrError.value = "";
  ocrPages.value = [];
  ocrReportId.value = null;
  try {
    const nextPages = await request<OcrPageText[]>(`reports/${encodeURIComponent(reportId)}/ocr`);
    if (seq !== ocrSeq || props.reportId !== reportId) return;
    ocrPages.value = nextPages;
    ocrReportId.value = reportId;
  } catch (cause) {
    if (seq === ocrSeq && props.reportId === reportId) {
      ocrError.value = cause instanceof Error ? cause.message : "无法读取 OCR 文本";
    }
  } finally {
    if (seq === ocrSeq && props.reportId === reportId) ocrLoading.value = false;
  }
}

async function loadOcrDetail(pageId: string) {
  if (!pageId || ocrDetailPage.value?.pageId === pageId) return;
  ocrDetailLoading.value = true;
  ocrDetailError.value = "";
  ocrDetailPage.value = null;
  try {
    ocrDetailPage.value = await request<OcrPageDetail>(`reports/${encodeURIComponent(props.reportId)}/pages/${encodeURIComponent(pageId)}/ocr`);
  } catch (cause) {
    ocrDetailError.value = cause instanceof Error ? cause.message : "无法读取 OCR 详情";
  } finally {
    ocrDetailLoading.value = false;
  }
}

watch([observationSourcePage, allObservationsOpen], ([page, open]) => {
  if (open && page) void loadOcrDetail(page.id);
});

function reviewIssueLabel(issueType: ProcessingDiagnosticReviewItem["issueType"]) {
  return {
    ocr_content: "OCR 内容问题",
    ai_missing: "AI 未提取",
    layout_ambiguity: "版面歧义",
    evidence_rejected: "证据校验拒绝"
  }[issueType];
}

function reportPageByNumber(pageNumber: number) {
  return detail.value?.pages.find((page) => page.pageNumber === pageNumber) || null;
}

function reviewOriginalUrl(pageNumber: number) {
  const page = reportPageByNumber(pageNumber);
  return page ? viewerFullUrl(page) : "";
}

function isDiagnosticSourceLine(lineId: string) {
  return diagnosticSourceLineIds.value.includes(lineId);
}

function setOcrCompareImage(element: unknown) {
  ocrCompareImage.value = element instanceof HTMLImageElement ? element : null;
}

function onOriginalImageLoad(pageId: string) {
  loadedOriginalImagePageId.value = pageId;
}

function onObservationOriginalImageLoad(pageId: string) {
  loadedObservationOriginalPageId.value = pageId;
}

function onOcrCompareImageLoad(pageId: string) {
  loadedOcrCompareImagePageId.value = pageId;
}

// 用已知的页面宽高比给图片占位，翻页时先撑出高度，避免图片加载完成后布局跳动。
// auto 关键字让加载完成的图片回退到真实比例，占位比例只在加载前生效。
function originalImageAspectStyle(page: { width: number | null; height: number | null }) {
  if (!page.width || !page.height) return undefined;
  return { aspectRatio: `auto ${page.width} / ${page.height}` };
}

async function toggleOcrPageCompare(pageNumber: number) {
  if (ocrComparePageNumber.value === pageNumber) {
    ocrComparePageNumber.value = null;
    ocrCompareImage.value = null;
    ocrDetailPage.value = null;
    ocrDetailError.value = "";
    return;
  }
  ocrComparePageNumber.value = pageNumber;
  ocrCompareImage.value = null;
  const page = ocrPages.value.find((item) => item.pageNumber === pageNumber);
  if (page) await loadOcrDetail(page.pageId);
}

function closeOcrText() {
  ocrSheetOpen.value = false;
  diagnosticReviewItem.value = null;
  ocrComparePageNumber.value = null;
  ocrCompareImage.value = null;
  ocrDetailPage.value = null;
  ocrDetailError.value = "";
}

async function openOcrText() {
  diagnosticReviewItem.value = null;
  ocrComparePageNumber.value = null;
  ocrCompareImage.value = null;
  ocrDetailPage.value = null;
  ocrSheetOpen.value = true;
  await loadOcrPages(props.reportId);
}

async function openDiagnosticReview(item: ProcessingDiagnosticReviewItem) {
  diagnosticReviewItem.value = item;
  const pageNumber = item.pages[0] ?? null;
  ocrComparePageNumber.value = null;
  ocrCompareImage.value = null;
  ocrDetailPage.value = null;
  closeJobEvents();
  ocrSheetOpen.value = true;
  await loadOcrPages(props.reportId);
  if (pageNumber != null) {
    await toggleOcrPageCompare(pageNumber);
    await nextTick();
    document.getElementById(`ocr-review-page-${pageNumber}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

async function confirmReady() {
  confirming.value = true;
  jobsError.value = "";
  try {
    await request(`reports/${encodeURIComponent(props.reportId)}/confirm`, { method: "POST" });
    await loadDetail(props.reportId);
    emit("updated");
    toast.show("已确认归档");
  } catch (cause) {
    failJobsAction(cause, "确认归档失败");
  } finally {
    confirming.value = false;
  }
}

function askTrash() {
  confirmDialog.ask({
    title: "移入回收站",
    message: `确认将「${source.value?.title || "当前报告"}」移入回收站？原件会保留 30 天，不会立刻删除。`,
    confirmText: "移入回收站",
    danger: true,
    run: trashCurrentReport
  });
}

async function trashCurrentReport() {
  if (trashingReport.value) return;
  trashingReport.value = true;
  jobsError.value = "";
  try {
    await request(`reports/${encodeURIComponent(props.reportId)}`, { method: "DELETE" });
    stopJobsPolling();
    detail.value = null;
    selectedJobs.value = [];
    emit("updated");
    emit("close");
    toast.show("已移入回收站，原件将保留 30 天");
  } catch (cause) {
    failJobsAction(cause, "移入回收站失败");
  } finally {
    trashingReport.value = false;
  }
}

async function focusQueuedProcessing(closeDiagnosticReview: boolean) {
  if (closeDiagnosticReview) closeOcrText();
  processingExpanded.value = true;
  await nextTick();
  document.getElementById("report-processing-section")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

async function queueAiExtraction(closeDiagnosticReview: boolean) {
  if (triggeringAi.value || aiTriggerState.value.disabled) return;
  triggeringAi.value = true;
  jobsError.value = "";
  try {
    await request(`reports/${encodeURIComponent(props.reportId)}/ai`, { method: "POST" });
    await refreshJobs();
    await focusQueuedProcessing(closeDiagnosticReview);
    toast.show("AI 整理任务已加入队列");
  } catch (cause) {
    failJobsAction(cause, "AI 整理触发失败");
  } finally {
    triggeringAi.value = false;
  }
}

function requestAiExtraction(closeDiagnosticReview = false) {
  if (triggeringAi.value || aiTriggerState.value.disabled) return;
  const title = source.value?.title || "当前报告";
  const isRetry = closeDiagnosticReview || aiJobs.value.length > 0 || hasAiContent.value;
  confirmDialog.ask({
    title: isRetry ? "重新 AI 整理" : "开始 AI 整理",
    message: `确认${isRetry ? "重新" : "开始"}整理「${title}」？\n\n系统会复用当前 OCR 文本生成 AI 整理结果和指标。在新结果完整成功前，当前已保存的报告数据和趋势会继续显示；本次失败也不会覆盖旧结果。已人工校对的字段会保留且不会被 AI 自动覆盖。`,
    confirmText: isRetry ? "重新整理" : "开始整理",
    run: () => queueAiExtraction(closeDiagnosticReview)
  });
}

function triggerAiExtraction() {
  requestAiExtraction(false);
}

async function queueCancelProcessing() {
  if (cancellingJobs.value || !hasRunningJobs.value) return;
  cancellingJobs.value = true;
  jobsError.value = "";
  try {
    await request(`reports/${encodeURIComponent(props.reportId)}/cancel-processing`, { method: "POST" });
    await refreshJobs();
    toast.show("已中断，正在执行的任务会在当前步骤结束后停止");
  } catch (cause) {
    failJobsAction(cause, "中断任务失败");
  } finally {
    cancellingJobs.value = false;
  }
}

function requestCancelProcessing() {
  if (cancellingJobs.value || !hasRunningJobs.value) return;
  const title = source.value?.title || "当前报告";
  confirmDialog.ask({
    title: "中断处理",
    message: `确认中断「${title}」的当前处理任务？\n\n排队中的任务会立即停止；正在执行的任务会在当前步骤结束后停止，不会发起新的 AI 请求。已保存的报告数据和趋势不受影响，之后可以随时重新整理。`,
    confirmText: "中断任务",
    run: queueCancelProcessing
  });
}

const memberIdentityAssessment = computed(() => currentDetail.value?.memberIdentityAssessment || null);
const mismatchRelationshipLabels: Record<string, string> = {
  self: "本人", spouse: "配偶", child: "子女", parent: "父母", sibling: "兄弟姐妹", other: "其他"
};
const memberPatientInfo = computed(() => {
  const assessment = memberIdentityAssessment.value;
  if (!assessment) return "";
  const parts: string[] = [];
  if (assessment.patientSex) parts.push(assessment.patientSex === "male" ? "男" : "女");
  if (assessment.patientBirthDate) parts.push(`出生于 ${assessment.patientBirthDate}`);
  else if (assessment.patientAgeText) parts.push(`年龄 ${assessment.patientAgeText}`);
  return parts.join(" · ") || "未识别";
});
const memberMismatchFieldLabels = computed(() =>
  (memberIdentityAssessment.value?.mismatchedFields || [])
    .map((field) => (field === "sex" ? "性别" : "出生日期/年龄"))
    .join("和")
);
const assigningMember = ref(false);
const dismissingMismatch = ref(false);
const memberCreateOpen = ref(false);
const memberCreateSaving = ref(false);
const memberCreateError = ref("");
const memberCreateForm = ref({ displayName: "", relationship: "other", sex: "", birthDate: "" });

async function postMemberAssignment(body: Record<string, unknown>, successMessage: string) {
  await request(`reports/${encodeURIComponent(props.reportId)}/assign-member`, {
    method: "POST",
    body: JSON.stringify(body)
  });
  await loadDetail(props.reportId, true);
  emit("updated");
  toast.show(successMessage);
}

function assignToCandidate(candidate: { id: string; displayName: string }) {
  if (assigningMember.value) return;
  const title = source.value?.title || "当前报告";
  confirmDialog.ask({
    title: "归属报告",
    message: `确认把「${title}」归属到成员「${candidate.displayName}」？\n\n报告的指标、趋势和形态发现会一并转移到该成员的档案下。`,
    confirmText: "确认归属",
    run: async () => {
      assigningMember.value = true;
      try {
        await postMemberAssignment({ memberId: candidate.id }, `已归属到「${candidate.displayName}」`);
      } catch (cause) {
        failJobsAction(cause, "归属失败");
      } finally {
        assigningMember.value = false;
      }
    }
  });
}

function openMemberCreate() {
  const assessment = memberIdentityAssessment.value;
  memberCreateForm.value = {
    displayName: "",
    relationship: "other",
    sex: assessment?.patientSex || "",
    birthDate: assessment?.patientBirthDate || assessment?.patientApproxBirthDate || ""
  };
  memberCreateError.value = "";
  memberCreateOpen.value = true;
}

async function submitMemberCreate() {
  if (memberCreateSaving.value) return;
  const displayName = memberCreateForm.value.displayName.trim();
  if (!displayName) {
    memberCreateError.value = "请填写成员姓名";
    return;
  }
  memberCreateSaving.value = true;
  memberCreateError.value = "";
  try {
    await postMemberAssignment(
      {
        newMember: {
          displayName,
          relationship: memberCreateForm.value.relationship,
          sex: memberCreateForm.value.sex || null,
          birthDate: memberCreateForm.value.birthDate || null
        }
      },
      `已创建成员「${displayName}」并完成归属`
    );
    memberCreateOpen.value = false;
  } catch (cause) {
    memberCreateError.value = cause instanceof Error ? cause.message : "创建成员失败";
  } finally {
    memberCreateSaving.value = false;
  }
}

async function dismissMemberMismatch() {
  if (dismissingMismatch.value) return;
  dismissingMismatch.value = true;
  try {
    await request(`reports/${encodeURIComponent(props.reportId)}/dismiss-member-mismatch`, { method: "POST" });
    await loadDetail(props.reportId, true);
    toast.show("已忽略这份报告的成员提醒");
  } catch (cause) {
    failJobsAction(cause, "操作失败");
  } finally {
    dismissingMismatch.value = false;
  }
}

function runReprocessNoticeAction() {
  if (reprocessNotice.value?.action === "retry_ai") {
    triggerAiExtraction();
    return;
  }
  if (reprocessNotice.value?.action === "retry_ocr_ai") reprocessCurrentReport();
}

function requestReportReprocess(closeDiagnosticReview = false) {
  if (processingRecoveryState.value.reprocessDisabled) return;
  const title = source.value?.title || "当前报告";
  confirmDialog.ask({
    title: "重新识别",
    message: `确认重新识别「${title}」？\n\n系统会基于原件重新生成 OCR、AI 整理结果和指标。在新结果完整成功前，当前已保存的报告数据和趋势会继续显示；本次失败也不会覆盖旧结果。已人工校对的字段会保留且不会被 AI 自动覆盖。`,
    confirmText: "重新识别",
    run: async () => {
      reprocessingReport.value = true;
      jobsError.value = "";
      try {
        const result = await request<{ queuedOcr: number; aiWillRun: boolean }>(
          `reports/${encodeURIComponent(props.reportId)}/reprocess`,
          { method: "POST" }
        );
        await refreshJobs();
        await loadDetail(props.reportId, true);
        await focusQueuedProcessing(closeDiagnosticReview);
        emit("updated");
        toast.show(result.aiWillRun
          ? `已重新排队 OCR ${result.queuedOcr} 页，完成后会自动 AI 整理`
          : `已重新排队 OCR ${result.queuedOcr} 页，AI 未配置时需稍后手动整理`);
      } catch (cause) {
        failJobsAction(cause, "重新识别失败");
      } finally {
        reprocessingReport.value = false;
      }
    }
  });
}

function reprocessCurrentReport() {
  requestReportReprocess(false);
}

function repairDiagnosticIssue(item: ProcessingDiagnosticReviewItem) {
  if (diagnosticRepairMode(item) === "ocr_ai") {
    requestReportReprocess(true);
    return;
  }
  requestAiExtraction(true);
}

function handleViewerKeydown(event: KeyboardEvent) {
  if (pdfViewerOpen.value && event.key === "Escape") {
    closePdfOriginalViewer();
    event.preventDefault();
  }
}

function stopJobsPolling() {
  if (jobsTimer) clearInterval(jobsTimer);
  jobsTimer = null;
}

function stopEventPolling() {
  if (eventTimer) clearInterval(eventTimer);
  eventTimer = null;
  eventPolling.value = false;
}

function eventJobIsRunning(jobId: string) {
  const current = selectedJobs.value.find((job) => job.id === jobId) || eventJob.value;
  return Boolean(current && ["queued", "processing"].includes(current.status));
}

function startEventPolling(jobId: string) {
  stopEventPolling();
  if (!eventSheetOpen.value || !eventJobIsRunning(jobId)) return;
  eventPolling.value = true;
  eventTimer = setInterval(() => { void loadJobEvents(jobId, true); }, 2000);
}

function maybeStartJobsPolling() {
  stopJobsPolling();
  if (hasRunningJobs.value || source.value?.status === "queued" || source.value?.status === "processing") {
    jobsTimer = setInterval(() => { void refreshJobs(true); }, 2500);
  }
}

/* 详情/列表/提醒级联刷新的节流时间戳：处理中任务状态几乎每轮都变，避免每 2.5 秒拉一整页数据 */
let lastDetailSyncAt = 0;

async function refreshJobs(silent = false) {
  if (!props.reportId) return;
  const reportId = props.reportId;
  const seq = ++jobsSeq;
  const previousStatuses = new Map(selectedJobs.value.map((job) => [job.id, job.status]));
  if (!silent) {
    jobsLoadingSeq = seq;
    jobsLoading.value = true;
  }
  jobsError.value = "";
  try {
    /* OCR 运行状态只在打开报告/手动重试（非轮询）时查询，轮询周期内不再重复请求 */
    const [nextJobs, ocr] = await Promise.all([
      request<ProcessingJob[]>(`jobs?reportId=${encodeURIComponent(reportId)}`),
      !silent && app.session.value?.isAdmin ? request<{ available: boolean }>("ocr/status") : Promise.resolve(null)
    ]);
    if (seq !== jobsSeq || props.reportId !== reportId) return;
    const jobStatusChanged = nextJobs.length !== previousStatuses.size
      || nextJobs.some((job) => previousStatuses.get(job.id) !== job.status);
    selectedJobs.value = nextJobs;
    jobsPollingStopped.value = false;
    if (eventJob.value) {
      eventJob.value = nextJobs.find((job) => job.id === eventJob.value?.id) || eventJob.value;
    }
    jobsPollFailures = 0;
    if (ocr) runtimeAvailable.value = ocr.available;
    const nextCurrentJobs = groupProcessingJobBatches(nextJobs).currentJobs;
    if (
      pageRefreshAwaitingJobs.value
      && nextCurrentJobs.some((job) => job.pipelineVersion === "manual-page-v1")
    ) {
      pageRefreshAwaitingJobs.value = false;
    }
    const settled = isProcessingJobBatchSettled(nextCurrentJobs);
    const newlyFailed = nextCurrentJobs.some((job) => job.status === "failed" && previousStatuses.get(job.id) !== "failed");
    /* 级联刷新（详情+提醒+列表）节流 10 秒；任务全部结束或出现新失败时立即同步 */
    const syncIntervalElapsed = Date.now() - lastDetailSyncAt > 10000;
    const finalDetailMayBeStale = settled && ["queued", "processing"].includes(source.value?.status || "");
    const shouldSync = (jobStatusChanged && (settled || newlyFailed || syncIntervalElapsed))
      || (finalDetailMayBeStale && syncIntervalElapsed);
    if (shouldSync && props.reportId === reportId) {
      lastDetailSyncAt = Date.now();
      await loadDetail(reportId, true);
      if (app.selectedMemberId.value) await app.refreshReminderCount(app.selectedMemberId.value);
      emit("updated");
    }
    maybeStartJobsPolling();
  } catch (cause) {
    if (seq !== jobsSeq || props.reportId !== reportId) return;
    jobsPollFailures += 1;
    /* 轮询允许偶发失败（网络抖动），连续 3 次失败才停止并提示，避免进度条假死 */
    if (!silent || jobsPollFailures >= 3) {
      jobsPollingStopped.value = true;
      failJobsAction(cause, "无法读取处理进度");
      stopJobsPolling();
    } else {
      /* 页面保存已经成功时，即使第一次任务读取遇到网络抖动，也继续按报告 processing 状态自动恢复轮询。 */
      maybeStartJobsPolling();
    }
  } finally {
    if (!silent && jobsLoadingSeq === seq && props.reportId === reportId) jobsLoading.value = false;
  }
}

async function loadDetail(reportId: string, preserveCurrent = false) {
  const seq = ++detailSeq;
  detailLoading.value = true;
  detailError.value = "";
  if (!preserveCurrent) detail.value = null;
  try {
    const next = await request<ReportDetail>(`reports/${encodeURIComponent(reportId)}`);
    if (seq === detailSeq && props.reportId === reportId && next.id === reportId) {
      detail.value = next;
      try {
        const status = await request<{ status: "ready" | "generating" | "available" }>(`reports/${encodeURIComponent(reportId)}/original/status`);
        if (seq === detailSeq && props.reportId === reportId) {
          originalExportStatus.value = status.status;
          if (status.status === "generating") startOriginalExportStatusPolling(reportId);
        }
      } catch { /* 原件状态不影响报告详情显示。 */ }
    }
  } catch (cause) {
    if (seq === detailSeq && props.reportId === reportId) {
      detailError.value = cause instanceof Error ? cause.message : "报告详情读取失败";
    }
  } finally {
    if (seq === detailSeq && props.reportId === reportId) detailLoading.value = false;
  }
}

async function retryJob(job: ProcessingJob) {
  jobsError.value = "";
  try {
    await request(`jobs/${job.id}/retry`, { method: "POST" });
    await refreshJobs();
  } catch (cause) {
    failJobsAction(cause, "任务重试失败");
  }
}

async function openJobEvents(job: ProcessingJob) {
  const seq = ++eventSeq;
  stopEventPolling();
  eventJob.value = job;
  eventSheetOpen.value = true;
  eventError.value = "";
  jobEvents.value = [];
  jobEventDetail.value = null;
  await loadJobEvents(job.id, false, seq);
  if (seq === eventSeq && eventSheetOpen.value) startEventPolling(job.id);
}

async function loadJobEvents(jobId: string, silent = false, expectedSeq = eventSeq) {
  if (eventRequestPending || !eventSheetOpen.value || eventJob.value?.id !== jobId) return;
  eventRequestPending = true;
  if (!silent) eventLoading.value = true;
  try {
    const nextDetail = await request<ProcessingJobEventDetail>(`jobs/${jobId}/events`);
    if (expectedSeq !== eventSeq || !eventSheetOpen.value || eventJob.value?.id !== jobId) return;
    jobEventDetail.value = nextDetail;
    jobEvents.value = nextDetail.generalEvents;
    eventError.value = "";
    if (!eventJobIsRunning(jobId)) stopEventPolling();
  } catch (cause) {
    if (expectedSeq === eventSeq && eventSheetOpen.value && eventJob.value?.id === jobId) {
      eventError.value = cause instanceof Error ? cause.message : "无法读取详细日志";
    }
  } finally {
    eventRequestPending = false;
    if (!silent && expectedSeq === eventSeq) eventLoading.value = false;
  }
}

function closeJobEvents() {
  eventSeq += 1;
  stopEventPolling();
  eventSheetOpen.value = false;
  eventJob.value = null;
  jobEvents.value = [];
  jobEventDetail.value = null;
  eventError.value = "";
  eventLoading.value = false;
}

watch(() => props.reportId, (reportId) => {
  stopJobsPolling();
  closeJobEvents();
  jobsSeq += 1;
  jobsLoadingSeq = 0;
  ocrSeq += 1;
  selectedJobs.value = [];
  pageRefreshAwaitingJobs.value = false;
  jobsLoading.value = false;
  jobsPollFailures = 0;
  jobsPollingStopped.value = false;
  jobsError.value = "";
  processingExpanded.value = false;
  closeOcrText();
  ocrPages.value = [];
  ocrReportId.value = null;
  ocrLoading.value = false;
  ocrError.value = "";
  editOpen.value = false;
  allObservationsOpen.value = false;
  editOriginalIndex.value = 0;
  if (!reportId) {
    detail.value = null;
    return;
  }
  /* 打开报告时 watch 已拉详情，标记同步时间点避免首轮轮询重复级联 */
  lastDetailSyncAt = Date.now();
  void loadDetail(reportId);
  void refreshJobs();
}, { immediate: true });

onMounted(() => {
  window.addEventListener("keydown", handleViewerKeydown);
});
onBeforeUnmount(() => {
  stopOriginalExportStatusPolling();
  stopJobsPolling();
  stopEventPolling();
  eventSeq += 1;
  window.removeEventListener("keydown", handleViewerKeydown);
});
/* 随 KeepAlive 页面失活暂停任务轮询，激活时立即刷新一次并按任务状态恢复轮询 */
onDeactivated(() => {
  stopJobsPolling();
  stopEventPolling();
});
onActivated(() => {
  if (hasRunningJobs.value || source.value?.status === "queued" || source.value?.status === "processing") {
    void refreshJobs(true);
  }
  if (eventSheetOpen.value && eventJob.value) {
    void loadJobEvents(eventJob.value.id, true);
    startEventPolling(eventJob.value.id);
  }
});
</script>

<template>
  <header v-if="variant === 'floating'" class="sheet-header report-detail-floating-header">
    <h3>{{ source?.title || "报告详情" }}</h3>
    <button class="plain-icon-button" type="button" title="关闭" @click="emit('close')"><X :size="18" /></button>
  </header>
  <div v-if="!source" class="mini-loading report-detail-loading"><LoaderCircle class="spin-icon" :size="16" />正在读取报告详情</div>
  <div v-else class="preview-stack" :class="{ 'preview-stack--floating': variant === 'floating' }">
    <article class="preview-card">
      <div class="preview-heading">
        <span class="chip chip--type">{{ typeLabel(source.reportType) }}</span>
        <span v-if="statusMeta[source.status]" class="chip" :class="statusMeta[source.status].chip">
          {{ statusMeta[source.status].label }}
        </span>
        <button class="preview-trash-button" type="button" title="移入回收站" :disabled="trashingReport" @click="askTrash">
          <LoaderCircle v-if="trashingReport" class="spin-icon" :size="16" />
          <Trash2 v-else :size="16" />
        </button>
      </div>
      <h3>{{ source.title }}</h3>
      <p v-if="detailError" class="inline-panel-error">{{ detailError }}</p>
      <div v-if="ocrEmptyNotice" class="runtime-warning compact">
        <CircleAlert :size="18" />
        <div><strong>没有识别到文字</strong><span>这份报告的原件上没有识别到任何文字，可能不是有效的体检报告。可重新上传清晰原件，或直接手动校对填写。</span></div>
      </div>
      <dl class="preview-facts">
        <div><dt>报告日期</dt><dd>{{ source.reportIssuedAt || "日期待确认" }}<span v-if="isManualField('reportIssuedAt')" class="manual-field-chip">人工校对</span></dd></div>
        <div><dt>医院</dt><dd>{{ [source.hospitalName, source.hospitalBranch].filter(Boolean).join(" · ") || "待整理" }}<span v-if="isManualField('hospitalName') || isManualField('hospitalBranch')" class="manual-field-chip">人工校对</span></dd></div>
        <div><dt>科室</dt><dd>{{ source.departmentName || "待整理" }}<span v-if="['departmentName', 'performingDepartment', 'reportingDepartment', 'orderingDepartment'].some(isManualField)" class="manual-field-chip">人工校对</span></dd></div>
        <div><dt>部位</dt><dd>{{ source.bodyPart || "待整理" }}<span v-if="isManualField('bodyParts')" class="manual-field-chip">人工校对</span></dd></div>
        <div><dt>页数</dt><dd>{{ source.pageCount || 0 }} 页</dd></div>
        <div><dt>状态</dt><dd>{{ statusMeta[source.status]?.label || source.status }}</dd></div>
        <div v-if="currentDetail?.createdAt"><dt>上传时间</dt><dd>{{ formatDatabaseTimeWithYear(currentDetail.createdAt) }}</dd></div>
      </dl>
      <div v-if="detailLoading" class="mini-loading"><LoaderCircle class="spin-icon" :size="16" />正在读取报告详情</div>
      <div class="report-action-row">
        <button v-if="source.status === 'needs_review'" class="primary-button compact-primary" type="button" :disabled="confirming" @click="confirmReady">
          <LoaderCircle v-if="confirming" class="spin-icon" :size="17" />
          <CheckCircle2 v-else :size="17" />
          {{ confirming ? "确认中" : "确认归档" }}
        </button>
        <button class="soft-action-button" type="button" @click="openEditReport"><Pencil :size="17" />校对字段</button>
        <button class="soft-action-button" type="button" @click="openOcrText"><ScrollText :size="17" />查看 OCR</button>
        <button v-if="firstPdfPage" class="soft-action-button" type="button" @click="openPdfOriginalViewer(firstPdfPage)"><FileText :size="17" />查看 PDF</button>
      </div>
      <section v-if="reprocessNotice" class="reprocess-notice" :class="`is-${reprocessNotice.tone}`">
        <LoaderCircle v-if="reprocessNotice.tone === 'info'" class="spin-icon" :size="19" />
        <CircleAlert v-else :size="19" />
        <div>
          <strong>{{ reprocessNotice.title }}</strong>
          <p>{{ reprocessNotice.message }}</p>
        </div>
        <button
          v-if="reprocessNotice.action"
          type="button"
          :disabled="reprocessingReport || triggeringAi || hasRunningJobs"
          @click="runReprocessNoticeAction"
        >
          <LoaderCircle v-if="reprocessingReport || triggeringAi" class="spin-icon" :size="15" />
          <RefreshCw v-else :size="15" />
          {{ reprocessingReport || triggeringAi ? "提交中" : reprocessNotice.actionLabel }}
        </button>
      </section>
      <section v-if="duplicateCandidates.length" class="duplicate-warning">
        <CircleAlert :size="18" />
        <div>
          <strong>可能已上传过这份报告</strong>
          <p>系统根据原件、OCR 和已整理的报告内容发现 {{ duplicateCandidates.length }} 个候选，确认归档前建议先核对。若自动 AI 整理已暂缓，仍可在下方手动继续。</p>
          <button
            v-for="candidate in duplicateCandidates"
            :key="candidate.id"
            class="duplicate-candidate-button"
            type="button"
            @click="emit('openCandidate', candidate)"
          >
            查看已有报告 · {{ candidate.confidence === "high" ? "高度重复" : "疑似重复" }} · {{ candidate.title }}
            <span>{{ candidate.reason }} · {{ candidate.matchedFields.join("、") }}</span>
          </button>
          <div v-if="source.status === 'needs_review'" class="duplicate-actions">
            <button class="duplicate-confirm-button" type="button" :disabled="confirming" @click="confirmReady">
              <CheckCircle2 :size="15" />仍然确认归档
            </button>
          </div>
        </div>
      </section>
      <section v-if="memberIdentityAssessment" class="duplicate-warning member-mismatch-notice">
        <CircleAlert :size="18" />
        <div>
          <strong>这份报告可能不属于当前成员</strong>
          <p>报告患者信息（{{ memberPatientInfo }}）与当前成员资料的{{ memberMismatchFieldLabels }}不一致，可能上传时选错了成员。核对后可以一键归属，或创建新成员并归属。</p>
          <div class="duplicate-actions member-mismatch-actions">
            <button
              v-for="candidate in memberIdentityAssessment.candidates"
              :key="candidate.id"
              class="duplicate-confirm-button"
              type="button"
              :disabled="assigningMember"
              @click="assignToCandidate(candidate)"
            >
              <LoaderCircle v-if="assigningMember" class="spin-icon" :size="15" />
              <CheckCircle2 v-else :size="15" />
              归属到「{{ candidate.displayName }}」（{{ mismatchRelationshipLabels[candidate.relationship] || "其他" }}）
            </button>
            <button class="duplicate-confirm-button" type="button" :disabled="assigningMember" @click="openMemberCreate">
              <Plus :size="15" />创建新成员并归属
            </button>
            <button class="soft-action-button" type="button" :disabled="dismissingMismatch" @click="dismissMemberMismatch">
              {{ dismissingMismatch ? "处理中" : "忽略提醒" }}
            </button>
          </div>
          <form v-if="memberCreateOpen" class="member-create-form" @submit.prevent="submitMemberCreate">
            <input v-model="memberCreateForm.displayName" type="text" maxlength="40" placeholder="成员姓名（必填）" required />
            <select v-model="memberCreateForm.relationship" aria-label="家庭关系">
              <option v-for="(label, value) in mismatchRelationshipLabels" :key="value" :value="value">{{ label }}</option>
            </select>
            <select v-model="memberCreateForm.sex" aria-label="性别">
              <option value="">性别未知</option>
              <option value="male">男</option>
              <option value="female">女</option>
            </select>
            <input v-model="memberCreateForm.birthDate" type="date" aria-label="出生日期" />
            <p v-if="!memberIdentityAssessment.patientBirthDate && memberIdentityAssessment.patientApproxBirthDate" class="member-create-hint">出生日期按报告年龄推算，请核对后再保存</p>
            <button type="submit" class="duplicate-confirm-button" :disabled="memberCreateSaving">
              {{ memberCreateSaving ? "创建中" : "创建并归属" }}
            </button>
            <button type="button" class="soft-action-button" @click="memberCreateOpen = false">取消</button>
            <p v-if="memberCreateError" class="inline-panel-error">{{ memberCreateError }}</p>
          </form>
        </div>
      </section>
    </article>

    <article class="preview-card ai-result-card">
      <div class="section-title-row">
        <div><h4>AI 整理结果</h4><p>{{ hasAiContent ? "以下内容来自 OCR 后的结构化整理，确认前请核对原件。" : "AI 尚未整理出结构化内容。" }}</p></div>
        <div class="section-title-actions">
          <button v-if="canTriggerAi" class="soft-action-button ai-trigger-button" type="button" :disabled="aiTriggerState.disabled" @click="triggerAiExtraction">
            <LoaderCircle v-if="aiTriggerState.loading" class="spin-icon" :size="16" />
            <Sparkles v-else :size="16" />
            {{ aiTriggerState.label }}
          </button>
          <Sparkles :size="19" />
        </div>
      </div>
      <div v-if="hasAiContent" class="ai-content">
        <section v-if="detail?.summary || detail?.impression || detail?.recommendation" class="ai-section-grid">
          <article v-if="detail?.summary"><span>摘要<em v-if="isManualField('summary')" class="manual-field-chip">人工校对</em></span><p>{{ detail.summary }}</p></article>
          <article v-if="detail?.impression"><span>结论<em v-if="isManualField('impression')" class="manual-field-chip">人工校对</em></span><p>{{ detail.impression }}</p></article>
          <article v-if="detail?.recommendation"><span>建议/复查<em v-if="isManualField('recommendation')" class="manual-field-chip">人工校对</em></span><p>{{ detail.recommendation }}</p></article>
        </section>
        <section v-if="detail?.clinicalDiagnosis || detail?.purpose || detail?.chiefComplaint || detail?.findings" class="ai-long-text">
          <article v-if="detail?.clinicalDiagnosis"><span>临床诊断<em v-if="isManualField('clinicalDiagnosis')" class="manual-field-chip">人工校对</em></span><p>{{ detail.clinicalDiagnosis }}</p></article>
          <article v-if="detail?.purpose"><span>检查目的<em v-if="isManualField('purpose')" class="manual-field-chip">人工校对</em></span><p>{{ detail.purpose }}</p></article>
          <article v-if="detail?.chiefComplaint"><span>主诉<em v-if="isManualField('chiefComplaint')" class="manual-field-chip">人工校对</em></span><p>{{ detail.chiefComplaint }}</p></article>
          <article v-if="detail?.findings"><span>检查所见<em v-if="isManualField('findings')" class="manual-field-chip">人工校对</em></span><p>{{ detail.findings }}</p></article>
        </section>
        <section v-if="clinicalFactAddTypes.length" class="clinical-fact-add-strip">
          <span>补充分类信息</span>
          <div>
            <button v-for="type in clinicalFactAddTypes" :key="type" type="button" @click="editClinicalFact(type)">
              <Plus :size="15" />{{ clinicalFactTypeLabels[type] }}
            </button>
          </div>
        </section>
        <section
          v-if="detail && ['checkup', 'laboratory', 'imaging', 'functional', 'pathology', 'outpatient', 'inpatient'].includes(detail.reportType)"
          class="clinical-fact-add-strip"
        >
          <span>报告专属内容</span>
          <div>
            <button type="button" @click="structuredSectionEditor = 'create'">
              <Plus :size="15" />补充内容
            </button>
          </div>
        </section>
        <section v-if="detail?.structuredSections.length" class="clinical-fact-panel structured-section-panel">
          <header><strong>报告专属内容</strong><span>共 {{ detail.structuredSections.length }} 项</span></header>
          <div class="structured-section-list">
            <article v-for="item in detail.structuredSections" :key="item.id">
              <div class="clinical-fact-heading">
                <strong>
                  {{ item.title || structuredSectionLabels[item.sectionKey] }}
                  <em v-if="item.manualFields.length" class="manual-field-chip">人工校对</em>
                </strong>
                <div class="clinical-fact-actions">
                  <button v-if="item.evidence.length" type="button" :title="savingPages ? '页面正在更新' : '查看原页'" :disabled="savingPages" @click="openClinicalEvidence(item.evidence)"><FileImage :size="15" /></button>
                  <button type="button" title="校对专属内容" @click="structuredSectionEditor = item"><Pencil :size="15" /></button>
                  <button type="button" title="删除专属内容" @click="removeStructuredSection(item)"><Trash2 :size="15" /></button>
                </div>
              </div>
              <p>{{ item.content }}</p>
            </article>
          </div>
        </section>
        <section v-if="detail?.diagnoses.length" class="clinical-fact-panel">
          <header><strong>诊断记录</strong><span>共 {{ detail.diagnoses.length }} 项</span></header>
          <div class="clinical-fact-list">
            <article v-for="item in detail.diagnoses" :key="item.id">
              <div class="clinical-fact-heading">
                <strong>{{ item.diagnosisText }}<em v-if="item.manualFields.length" class="manual-field-chip">人工校对</em></strong>
                <div class="clinical-fact-actions">
                  <button v-if="item.evidence.length" type="button" :title="savingPages ? '页面正在更新' : '查看原页'" :disabled="savingPages" @click="openClinicalEvidence(item.evidence)"><FileImage :size="15" /></button>
                  <button type="button" title="校对诊断" @click="editClinicalFact('diagnosis', item)"><Pencil :size="15" /></button>
                  <button type="button" title="删除诊断" @click="removeClinicalFact('diagnosis', item)"><Trash2 :size="15" /></button>
                </div>
              </div>
              <p>{{ [item.sectionName, item.diagnosisCode, item.codeSystem].filter(Boolean).join(" · ") || "原报告诊断" }}</p>
            </article>
          </div>
        </section>
        <section v-if="detail?.medications.length" class="clinical-fact-panel">
          <header><strong>用药记录</strong><span>共 {{ detail.medications.length }} 项</span></header>
          <div class="clinical-fact-list">
            <article v-for="item in detail.medications" :key="item.id">
              <div class="clinical-fact-heading">
                <strong>{{ item.medicationName }}<em v-if="item.manualFields.length" class="manual-field-chip">人工校对</em></strong>
                <div class="clinical-fact-actions">
                  <button v-if="item.evidence.length" type="button" :title="savingPages ? '页面正在更新' : '查看原页'" :disabled="savingPages" @click="openClinicalEvidence(item.evidence)"><FileImage :size="15" /></button>
                  <button type="button" title="校对用药" @click="editClinicalFact('medication', item)"><Pencil :size="15" /></button>
                  <button type="button" title="删除用药" @click="removeClinicalFact('medication', item)"><Trash2 :size="15" /></button>
                </div>
              </div>
              <p>{{ medicationDetail(item) || item.instructions || "原报告未注明详细用法" }}</p>
              <small v-if="item.instructions && medicationDetail(item)">{{ item.instructions }}</small>
            </article>
          </div>
        </section>
        <section v-if="detail?.procedures.length" class="clinical-fact-panel">
          <header><strong>诊疗与操作</strong><span>共 {{ detail.procedures.length }} 项</span></header>
          <div class="clinical-fact-list">
            <article v-for="item in detail.procedures" :key="item.id">
              <div class="clinical-fact-heading">
                <strong>{{ item.procedureName }}<em v-if="item.manualFields.length" class="manual-field-chip">人工校对</em></strong>
                <div class="clinical-fact-actions">
                  <button v-if="item.evidence.length" type="button" :title="savingPages ? '页面正在更新' : '查看原页'" :disabled="savingPages" @click="openClinicalEvidence(item.evidence)"><FileImage :size="15" /></button>
                  <button type="button" title="校对操作" @click="editClinicalFact('procedure', item)"><Pencil :size="15" /></button>
                  <button type="button" title="删除操作" @click="removeClinicalFact('procedure', item)"><Trash2 :size="15" /></button>
                </div>
              </div>
              <p>{{ procedureDetail(item) || item.sectionName || "原报告诊疗记录" }}</p>
            </article>
          </div>
        </section>
        <section v-if="detail?.vaccinations.length" class="clinical-fact-panel">
          <header><strong>疫苗接种</strong><span>共 {{ detail.vaccinations.length }} 项</span></header>
          <div class="clinical-fact-list">
            <article v-for="item in detail.vaccinations" :key="item.id">
              <div class="clinical-fact-heading">
                <strong>{{ item.vaccineName }}<template v-if="item.doseNumber"> · {{ item.doseNumber }}</template><em v-if="item.manualFields.length" class="manual-field-chip">人工校对</em></strong>
                <div class="clinical-fact-actions">
                  <button v-if="item.evidence.length" type="button" :title="savingPages ? '页面正在更新' : '查看原页'" :disabled="savingPages" @click="openClinicalEvidence(item.evidence)"><FileImage :size="15" /></button>
                  <button type="button" title="校对疫苗" @click="editClinicalFact('vaccination', item)"><Pencil :size="15" /></button>
                  <button type="button" title="删除疫苗" @click="removeClinicalFact('vaccination', item)"><Trash2 :size="15" /></button>
                </div>
              </div>
              <p>{{ [item.administeredAt, item.manufacturer, item.lotNumber ? `批号 ${item.lotNumber}` : null, item.administrationSite].filter(Boolean).join(" · ") || "原报告接种记录" }}</p>
            </article>
          </div>
        </section>
        <section v-if="detail?.billingSummary || detail?.billingItems.length" class="clinical-fact-panel">
          <header><strong>费用信息</strong><span>{{ detail.billingItems.length }} 项明细</span></header>
          <div v-if="detail.billingSummary" class="billing-summary-block">
            <div class="billing-summary-line">
              <span v-if="detail.billingSummary.totalAmount !== null">合计 <strong>{{ billingMoney(detail.billingSummary.totalAmount, detail.billingSummary.currency) }}</strong></span>
              <span v-if="detail.billingSummary.insuranceAmount !== null">医保 <strong>{{ billingMoney(detail.billingSummary.insuranceAmount, detail.billingSummary.currency) }}</strong></span>
              <span v-if="detail.billingSummary.selfPayAmount !== null">自费 <strong>{{ billingMoney(detail.billingSummary.selfPayAmount, detail.billingSummary.currency) }}</strong></span>
              <em v-if="detail.billingSummary.manualFields.length" class="manual-field-chip">人工校对</em>
            </div>
            <div class="clinical-fact-actions">
              <button v-if="detail.billingSummary.evidence.length" type="button" :title="savingPages ? '页面正在更新' : '查看原页'" :disabled="savingPages" @click="openClinicalEvidence(detail.billingSummary.evidence)"><FileImage :size="15" /></button>
              <button type="button" title="校对费用汇总" @click="editClinicalFact('billingSummary', detail.billingSummary)"><Pencil :size="15" /></button>
              <button type="button" title="删除费用汇总" @click="removeClinicalFact('billingSummary', detail.billingSummary)"><Trash2 :size="15" /></button>
            </div>
          </div>
          <div v-if="detail.billingItems.length" class="clinical-fact-list">
            <article v-for="item in detail.billingItems" :key="item.id">
              <div class="clinical-fact-heading">
                <strong>{{ item.itemName }}<em v-if="item.manualFields.length" class="manual-field-chip">人工校对</em></strong>
                <div class="clinical-fact-actions">
                  <button v-if="item.evidence.length" type="button" :title="savingPages ? '页面正在更新' : '查看原页'" :disabled="savingPages" @click="openClinicalEvidence(item.evidence)"><FileImage :size="15" /></button>
                  <button type="button" title="校对费用明细" @click="editClinicalFact('billingItem', item)"><Pencil :size="15" /></button>
                  <button type="button" title="删除费用明细" @click="removeClinicalFact('billingItem', item)"><Trash2 :size="15" /></button>
                </div>
              </div>
              <p>{{ [item.category, billingMoney(item.amount, detail.billingSummary?.currency || 'CNY')].filter(Boolean).join(" · ") }}</p>
            </article>
          </div>
        </section>
        <section v-if="detail?.morphologyFindings.length" class="morphology-panel">
          <header>
            <strong>形态学发现</strong>
            <span>共 {{ detail.morphologyFindings.length }} 项</span>
          </header>
          <div class="morphology-list">
            <article v-for="item in detail.morphologyFindings" :key="item.id">
              <div class="morphology-heading">
                <div>
                  <strong>{{ item.findingName }}<em v-if="item.manualFields.length" class="manual-field-chip">人工校对</em></strong>
                  <span>{{ morphologyLocationLine(item) }}</span>
                </div>
                <div class="morphology-heading-actions">
                  <em v-if="item.presence !== 'present'" :class="`morphology-presence morphology-presence--${item.presence}`">
                    {{ item.presence === "absent" ? "未见" : "待确认" }}
                  </em>
                  <button class="plain-icon-button" type="button" title="校对形态字段" @click="morphologyEditItem = item"><Pencil :size="16" /></button>
                </div>
              </div>
              <div v-if="morphologySizeLine(item) || morphologyClassificationLine(item)" class="morphology-facts">
                <span v-if="morphologySizeLine(item)">尺寸 <strong>{{ morphologySizeLine(item) }}</strong></span>
                <span v-if="morphologyClassificationLine(item)">分级 <strong>{{ morphologyClassificationLine(item) }}</strong></span>
              </div>
              <p v-if="item.morphology">{{ item.morphology }}</p>
              <div v-if="item.measurements.length" class="morphology-measurements">
                <span v-for="measurement in item.measurements" :key="`${measurement.key}-${measurement.value}-${measurement.unit || ''}`">
                  {{ measurement.key }} {{ measurement.value }}{{ measurement.unit ? ` ${measurement.unit}` : "" }}
                </span>
              </div>
              <details v-if="item.evidence.length || item.rawText" class="morphology-raw">
                <summary>查看证据<template v-if="morphologyEvidencePagesLine(item)"> · {{ morphologyEvidencePagesLine(item) }}</template></summary>
                <div v-if="morphologyEvidenceItems(item).length" class="morphology-evidence-list">
                  <article
                    v-for="evidence in morphologyEvidenceItems(item)"
                    :key="`${evidence.pageNumber}-${evidence.quote}`"
                  >
                    <button
                      v-if="reportPageByNumber(evidence.pageNumber)"
                      type="button"
                      title="查看该证据所在页"
                      @click="openMorphologyEvidencePage(evidence.pageNumber)"
                    >
                      第 {{ evidence.pageNumber }} 页
                    </button>
                    <span v-else>第 {{ evidence.pageNumber }} 页</span>
                    <p>{{ evidence.quote }}</p>
                  </article>
                </div>
                <p v-else>{{ item.rawText }}</p>
              </details>
            </article>
          </div>
        </section>
        <section v-if="detail?.observations.length" class="observation-panel">
          <header>
            <strong>指标总览</strong>
            <span>
              {{ detail.observations.length }} 项已识别 · {{ primaryObservations.length }} 项可用于趋势
              <template v-if="pendingReviewObservations.length"> · {{ pendingReviewObservations.length }} 项待核对</template>
              <template v-if="abnormalObservations.length"> · {{ abnormalObservations.length }} 项异常</template>
              <template v-if="conflictingObservations.length"> · {{ conflictingObservations.length }} 项待核验</template>
            </span>
          </header>
          <div class="observation-list">
            <article v-for="item in visibleObservations" :key="item.id">
              <strong>{{ item.itemName }}</strong>
              <p>{{ observationValueLine(item) }}<em v-if="observationFlagVisible(item)" :class="observationFlagClass(item)" :title="item.abnormalReason || undefined">{{ observationFlagLabel(item) }}</em></p>
              <div class="observation-meta"><span>{{ item.sectionName || item.normalizedName || "未分组" }}</span><span v-if="observationReferenceLine(item)">{{ observationReferenceLine(item) }}</span></div>
                <small v-if="observationInterpretationLine(item)" class="observation-interpretation-line">{{ observationInterpretationLine(item) }}</small>
              <small v-if="observationNormalizationLine(item)" class="observation-normalization-line">{{ observationNormalizationLine(item) }}</small>
              <small v-if="item.canonicalExplanation" class="observation-explanation-line">说明：{{ item.canonicalExplanation }}</small>
            </article>
          </div>
          <div class="observation-panel-footer">
            <span>
              <template v-if="readableObservations.length > visibleObservations.length">已显示前 {{ visibleObservations.length }} 项</template>
              <template v-else>可查看并人工校对全部指标</template>
            </span>
            <button type="button" @click="allObservationsOpen = true">
              查看全部<template v-if="pendingReviewObservations.length"> · {{ pendingReviewObservations.length }} 项待核对</template>
              <ChevronRight :size="16" />
            </button>
          </div>
        </section>
      </div>
      <div v-else class="preview-hint">{{ aiEmptyHint }}</div>
    </article>

    <MorphologyFindingEditor
      :open="Boolean(morphologyEditItem)"
      :finding="morphologyEditItem"
      @close="morphologyEditItem = null"
      @saved="morphologySaved"
    />
    <ClinicalFactEditor
      v-if="clinicalFactEditor"
      :open="Boolean(clinicalFactEditor)"
      :report-id="props.reportId"
      :type="clinicalFactEditor.type"
      :fact="clinicalFactEditor.fact"
      @close="clinicalFactEditor = null"
      @saved="clinicalFactSaved"
    />
    <ReportStructuredSectionEditor
      v-if="structuredSectionEditor && detail"
      :open="Boolean(structuredSectionEditor)"
      :report-id="props.reportId"
      :report-type="detail.reportType"
      :section="structuredSectionEditor === 'create' ? null : structuredSectionEditor"
      @close="structuredSectionEditor = null"
      @saved="structuredSectionSaved"
    />

    <article id="report-processing-section" class="preview-card processing-card">
      <div class="section-title-row">
        <div>
          <h4>当前处理</h4>
          <p v-if="currentBatch">
            {{ processingJobBatchLabel(currentBatch) }} · 已完成 {{ completedJobs }} / {{ currentJobs.length }}，失败 {{ failedJobs.length }} 个
          </p>
          <p v-else>{{ jobsLoading ? "正在读取任务状态" : "这份报告暂无后台任务记录" }}</p>
        </div>
        <div class="section-title-actions">
          <button
            v-if="hasRunningJobs"
            class="soft-action-button cancel-processing-button"
            type="button"
            :disabled="cancellingJobs"
            @click="requestCancelProcessing"
          >
            <LoaderCircle v-if="cancellingJobs" class="spin-icon" :size="16" />
            <CircleStop v-else :size="16" />
            {{ cancellingJobs ? "中断中" : "中断" }}
          </button>
          <button class="soft-action-button reprocess-action-button" type="button" :disabled="processingRecoveryState.reprocessDisabled" @click="reprocessCurrentReport">
            <LoaderCircle v-if="reprocessingReport || jobsLoading" class="spin-icon" :size="16" />
            <RefreshCw v-else :size="16" />
            {{ processingRecoveryState.reprocessLabel }}
          </button>
          <button
            v-if="selectedJobs.length || jobsError || needsOcrRuntime"
            class="collapse-toggle"
            type="button"
            :aria-expanded="processingExpanded"
            @click="processingExpanded = !processingExpanded"
          >
            <ChevronDown :size="16" :class="{ rotated: processingExpanded }" />
            {{ processingExpanded ? "收起" : "展开" }}
          </button>
          <button class="plain-icon-button" type="button" title="刷新处理进度" :disabled="jobsLoading" @click="refreshJobs()">
            <RefreshCw :size="17" :class="{ 'spin-icon': jobsLoading }" />
          </button>
        </div>
      </div>
      <div v-if="currentJobs.length" class="job-progress-compact">
        <div class="job-progress-bar" role="progressbar" :aria-valuenow="progressPercent" aria-valuemin="0" aria-valuemax="100">
          <span :style="{ width: `${progressPercent}%` }"></span>
        </div>
        <strong>{{ progressPercent }}%</strong>
      </div>
      <div v-if="processingExpanded" class="processing-details">
        <div v-if="needsOcrRuntime" class="runtime-warning compact">
          <CircleAlert :size="18" />
          <div><strong>等待安装本地 OCR 环境</strong><span>{{ app.session.value?.isAdmin ? "原件已保存，安装后任务会自动继续。" : `原件已保存，请联系${deploymentCopy.administrator}安装 OCR 环境。` }}</span></div>
          <RouterLink v-if="app.session.value?.isAdmin" to="/me/runtime">去设置</RouterLink>
        </div>
        <div v-if="jobsPollingStopped" class="processing-recovery-notice">
          <CircleAlert :size="18" />
          <div>
            <strong>处理进度暂时无法读取</strong>
            <span>报告任务不会因此重复提交。请重新连接后继续读取状态。</span>
            <small v-if="jobsError">{{ jobsError }}</small>
          </div>
          <button type="button" :disabled="jobsLoading" @click="refreshJobs()">
            <LoaderCircle v-if="jobsLoading" class="spin-icon" :size="15" />
            <RefreshCw v-else :size="15" />
            {{ jobsLoading ? "连接中" : "重新连接" }}
          </button>
        </div>
        <p v-else-if="jobsError" class="inline-panel-error">{{ jobsError }}</p>
        <div v-if="processingDelayNotice && !jobsPollingStopped" class="runtime-warning compact processing-delay-notice">
          <Clock3 :size="18" />
          <div><strong>{{ processingDelayNotice.title }}</strong><span>{{ processingDelayNotice.message }}</span></div>
          <button type="button" :disabled="jobsLoading" @click="refreshJobs()">刷新进度</button>
        </div>
        <section v-if="currentBatch" class="processing-current-batch">
          <header class="processing-batch-heading">
            <div>
              <strong>{{ processingJobBatchLabel(currentBatch) }}</strong>
              <span>{{ formatDatabaseTime(currentBatch.startedAt) }} · {{ batchSummary(currentBatch) }}</span>
            </div>
            <span class="chip" :class="jobStatusMeta[currentBatch.status].chip">{{ jobStatusMeta[currentBatch.status].label }}</span>
          </header>
          <div class="job-log-list">
            <article v-for="job in currentJobs" :key="job.id" class="job-log-item">
              <span class="job-icon" :class="`job-icon--${job.status}`">
                <CheckCircle2 v-if="job.status === 'completed'" :size="17" />
                <CircleAlert v-else-if="job.status === 'failed'" :size="17" />
                <LoaderCircle v-else-if="job.status === 'processing'" class="spin-icon" :size="17" />
                <Clock3 v-else :size="17" />
              </span>
              <div>
                <header>
                  <strong>{{ jobLabel(job.jobType) }}</strong>
                  <span class="chip" :class="jobStatusMeta[job.status].chip">{{ jobStatusMeta[job.status].label }}</span>
                </header>
                <span>{{ jobMeta(job) }}</span>
                <small>{{ jobDetail(job) }}</small>
              </div>
              <div class="job-log-actions">
                <button type="button" @click="openJobEvents(job)"><ScrollText :size="16" />日志</button>
                <button v-if="job.status === 'failed'" class="retry-action" type="button" @click="retryJob(job)"><RefreshCw :size="16" />重试</button>
              </div>
            </article>
          </div>
        </section>
        <details v-if="historicalBatches.length" class="processing-history">
          <summary>历史处理记录（{{ historicalBatches.length }} 次）</summary>
          <div class="processing-history-list">
            <details v-for="batch in historicalBatches" :key="batch.id" class="processing-history-batch">
              <summary>
                <span>
                  <strong>{{ processingJobBatchLabel(batch) }}</strong>
                  <small>{{ formatDatabaseTime(batch.startedAt) }} · {{ batchSummary(batch) }}</small>
                </span>
                <span class="chip" :class="jobStatusMeta[batch.status].chip">{{ jobStatusMeta[batch.status].label }}</span>
              </summary>
              <div class="job-log-list historical-job-log-list">
                <article v-for="job in batch.jobs" :key="job.id" class="job-log-item">
                  <span class="job-icon" :class="`job-icon--${job.status}`">
                    <CheckCircle2 v-if="job.status === 'completed'" :size="17" />
                    <CircleAlert v-else-if="job.status === 'failed'" :size="17" />
                    <LoaderCircle v-else-if="job.status === 'processing'" class="spin-icon" :size="17" />
                    <Clock3 v-else :size="17" />
                  </span>
                  <div>
                    <header>
                      <strong>{{ jobLabel(job.jobType) }}</strong>
                      <span class="chip" :class="jobStatusMeta[job.status].chip">{{ jobStatusMeta[job.status].label }}</span>
                    </header>
                    <span>{{ jobMeta(job) }}</span>
                    <small>{{ jobDetail(job) }}</small>
                  </div>
                  <div class="job-log-actions">
                    <button type="button" @click="openJobEvents(job)"><ScrollText :size="16" />日志</button>
                  </div>
                </article>
              </div>
            </details>
          </div>
        </details>
      </div>
    </article>

    <article class="preview-card originals-card">
      <div class="section-title-row">
        <div><h4>报告原件</h4><p>点击打开原图或 PDF 原件</p></div>
        <button class="soft-action-button" type="button" :disabled="exportingOriginal || !detail?.pages.length" @click="downloadReportOriginal">
          <LoaderCircle v-if="exportingOriginal || originalExportStatus === 'generating'" class="spin-icon" :size="15" />
          <Download v-else :size="15" />
          {{ originalExportStatus === 'ready' ? '下载 PDF' : originalExportStatus === 'generating' ? '正在生成 PDF' : '生成 PDF' }}
        </button>
      </div>
      <div v-if="detail?.pages.length" class="original-grid">
        <div v-for="(page, index) in detail.pages" :key="page.id" class="original-tile-card">
          <button type="button" class="original-tile" :disabled="savingPages" @click="openOriginalViewer(index)">
            <img v-if="page.hasThumbnail" :src="thumbnailUrl(page)" alt="" loading="lazy" decoding="async" />
            <FileText v-else-if="page.mimeType === 'application/pdf'" :size="28" />
            <FileImage v-else :size="28" />
            <span>第 {{ page.pageNumber }} 页</span>
            <Maximize2 :size="15" />
          </button>
          <div class="page-edit-actions">
            <button type="button" :disabled="savingPages || index === 0" title="上移" @click="moveSavedPage(page, -1)"><ArrowUp :size="15" /></button>
            <button type="button" :disabled="savingPages || index === detail.pages.length - 1" title="下移" @click="moveSavedPage(page, 1)"><ArrowDown :size="15" /></button>
            <button type="button" :disabled="savingPages" title="旋转" @click="rotateSavedPage(page)"><RotateCw :size="15" /></button>
            <button type="button" :disabled="savingPages || detail.pages.length <= 1" title="删除" @click="deleteSavedPage(page)"><Trash2 :size="15" /></button>
          </div>
        </div>
      </div>
      <p v-else class="preview-hint">详情加载后会显示关联原件。</p>
    </article>
  </div>

  <Teleport to="body">
    <div v-if="allObservationsOpen && detail" class="modal-backdrop observation-all-backdrop" @click.self="closeAllObservations">
      <section class="modal-panel observation-all-modal" role="dialog" aria-modal="true" aria-label="全部结构化指标">
        <header>
            <div>
            <ScrollText :size="20" />
            <div class="observation-all-title">
              <h3>全部结构化指标</h3>
              <p>{{ detail.observations.length }} 项已识别 · {{ primaryObservations.length }} 项可用于趋势<template v-if="pendingReviewObservations.length"> · {{ pendingReviewObservations.length }} 项待核对</template></p>
            </div>
          </div>
          <div class="observation-all-actions">
            <button class="soft-action-button observation-add-button" type="button" @click="openObservationEditor()"><Plus :size="15" />补充</button>
            <button class="plain-icon-button" type="button" title="关闭" @click="closeAllObservations"><X :size="18" /></button>
          </div>
        </header>
        <div class="observation-all-body">
          <div class="observation-all-layout">
            <aside class="observation-all-list">
          <section v-if="primaryObservations.length" class="observation-tier-section">
            <header><strong>标准化指标</strong><span>{{ primaryObservations.length }} 项，可参与趋势门禁判断</span></header>
            <div class="observation-list">
              <article
                v-for="item in primaryObservations"
                :key="item.id"
                :class="{ 'is-selected': selectedObservationId === item.id }"
                tabindex="0"
                @click="openObservationEditor(item)"
                @keydown.enter.prevent="openObservationEditor(item)"
                @keydown.space.prevent="openObservationEditor(item)"
              >
                <strong>{{ item.itemName }}</strong>
                <p>{{ observationValueLine(item) }}<em v-if="observationFlagVisible(item)" :class="observationFlagClass(item)" :title="item.abnormalReason || undefined">{{ observationFlagLabel(item) }}</em></p>
                <button class="observation-edit-button" type="button" title="编辑指标" @click.stop="openObservationEditor(item)"><Pencil :size="15" /></button>
                <div class="observation-meta"><span>{{ item.sectionName || item.normalizedName || "未分组" }}<em v-if="item.manualReviewed" class="observation-manual-chip">人工校对</em></span><span v-if="observationReferenceLine(item)">{{ observationReferenceLine(item) }}</span></div>
                <small v-if="observationInterpretationLine(item)" class="observation-interpretation-line">{{ observationInterpretationLine(item) }}</small>
                <small v-if="observationNormalizationLine(item)" class="observation-normalization-line">{{ observationNormalizationLine(item) }}</small>
                <small v-if="item.canonicalExplanation" class="observation-explanation-line">说明：{{ item.canonicalExplanation }}</small>
              </article>
            </div>
          </section>
          <section v-if="pendingReviewObservations.length" class="observation-tier-section">
            <header><strong>待核对指标</strong><span>{{ pendingReviewObservations.length }} 项，已识别但暂不进入趋势</span></header>
            <div class="observation-list">
              <article
                v-for="item in pendingReviewObservations"
                :key="item.id"
                :class="{ 'is-selected': selectedObservationId === item.id }"
                tabindex="0"
                @click="openObservationEditor(item)"
                @keydown.enter.prevent="openObservationEditor(item)"
                @keydown.space.prevent="openObservationEditor(item)"
              >
                <strong>{{ item.itemName }}</strong>
                <p>{{ observationValueLine(item) }}<em v-if="observationFlagVisible(item)" :class="observationFlagClass(item)" :title="item.abnormalReason || undefined">{{ observationFlagLabel(item) }}</em></p>
                <button class="observation-edit-button" type="button" title="编辑指标" @click.stop="openObservationEditor(item)"><Pencil :size="15" /></button>
                <div class="observation-meta"><span>{{ item.sectionName || item.normalizedName || "未分组" }}<em v-if="item.manualReviewed" class="observation-manual-chip">人工校对</em></span><span v-if="observationReferenceLine(item)">{{ observationReferenceLine(item) }}</span></div>
                <small v-if="observationInterpretationLine(item)" class="observation-interpretation-line">{{ observationInterpretationLine(item) }}</small>
                <small v-if="item.displayReason" class="observation-display-reason">{{ item.displayReason }}</small>
                <small v-if="observationNormalizationLine(item)" class="observation-normalization-line">{{ observationNormalizationLine(item) }}</small>
              </article>
            </div>
          </section>
            </aside>
            <section class="observation-source-panel">
              <header>
                <div><h4>原件参考</h4><p>{{ selectedObservation ? "已定位该指标的原件证据" : "选择指标后定位相关原件" }}</p></div>
                <button v-if="observationSourcePage" class="plain-icon-button" type="button" title="打开原件" @click="openOriginalViewer(observationSourcePageIndex)"><Maximize2 :size="16" /></button>
              </header>
              <div v-if="observationSourcePage" class="observation-source-stage">
                <div class="observation-source-image-wrapper">
                  <img
                    ref="observationOriginalImage"
                    :src="viewerFullUrl(observationSourcePage)"
                    :alt="`第 ${observationSourcePage.pageNumber} 页原件`"
                    :style="originalImageAspectStyle(observationSourcePage)"
                    decoding="async"
                    @load="onObservationOriginalImageLoad(observationSourcePage.id)"
                  />
                  <OcrTextOverlay
                    v-if="ocrDetailPage?.pageId === observationSourcePage.id && loadedObservationOriginalPageId === observationSourcePage.id && observationEvidenceLineIds.length"
                    :image="observationOriginalImage"
                    :lines="ocrDetailPage.lines"
                    :coord-width="ocrDetailPage.coordWidth"
                    :coord-height="ocrDetailPage.coordHeight"
                    :highlight-line-ids="observationEvidenceLineIds"
                    :interactive="false"
                  />
                </div>
                <span>第 {{ observationSourcePage.pageNumber }} 页</span>
                <small v-if="selectedObservation && !selectedObservation.evidence" class="observation-source-hint">这条指标暂无可定位的原件证据</small>
                <small v-else-if="ocrDetailLoading" class="observation-source-hint">正在读取证据位置...</small>
                <small v-else-if="selectedObservation && !observationEvidenceLineIds.length" class="observation-source-hint">已定位页面，但暂无可高亮的 OCR 行</small>
              </div>
              <p v-else class="preview-hint">暂无可用原件。</p>
              <div v-if="detail.pages.length > 1" class="observation-source-nav">
                <button type="button" title="上一页" :disabled="observationSourcePageIndex === 0" @click="observationSourcePageIndex -= 1"><ChevronLeft :size="16" /></button>
                <span>第 {{ observationSourcePage?.pageNumber || 0 }} 页 / 共 {{ detail.pages.length }} 页</span>
                <button type="button" title="下一页" :disabled="observationSourcePageIndex >= detail.pages.length - 1" @click="observationSourcePageIndex += 1"><ChevronRight :size="16" /></button>
              </div>
            </section>
            <section class="observation-edit-panel" :class="{ 'is-open': observationEditorOpen }">
              <header>
                <div><h4>{{ editingObservationId ? "编辑指标" : "补充指标" }}</h4><p>{{ editingObservationId ? "已提取内容已自动带入" : "填写后加入当前报告" }}</p></div>
                <button v-if="observationEditorOpen" class="plain-icon-button" type="button" title="取消编辑" @click="closeObservationEditor"><X :size="16" /></button>
              </header>
              <div v-if="!observationEditorOpen" class="observation-edit-empty">
                <Pencil :size="22" />
                <p>从中间选择指标开始校对</p>
              </div>
              <form v-else class="settings-form observation-editor-form" @submit.prevent="saveObservation">
                <div class="observation-catalog-picker">
                  <span>本地标准指标</span>
                  <div class="observation-catalog-search">
                    <input
                      v-model="observationCatalogQuery"
                      type="search"
                      aria-label="搜索本地标准指标"
                      placeholder="输入指标名称或编码"
                      @keyup.enter.prevent="searchObservationCatalog"
                    />
                    <button
                      class="soft-action-button"
                      type="button"
                      :disabled="observationCatalogLoading"
                      @click="searchObservationCatalog"
                    >
                      <LoaderCircle v-if="observationCatalogLoading" class="spin-icon" :size="15" />
                      <Search v-else :size="15" />查询
                    </button>
                  </div>
                  <FormSelect
                    v-model="observationForm.canonicalKey"
                    :options="observationCatalogSelectOptions"
                    aria-label="选择本地标准指标"
                  />
                </div>
                <div class="form-grid">
                  <label><span>指标名称</span><input v-model="observationForm.itemName" required /></label>
                  <label><span>指标代码</span><input v-model="observationForm.itemCode" /></label>
                  <label><span>分组/章节</span><input v-model="observationForm.sectionName" /></label>
                  <label><span>结果原文</span><input v-model="observationForm.resultText" /></label>
                  <label><span>数值结果</span><input v-model.number="observationForm.numericValue" type="number" step="any" /></label>
                  <label><span>单位</span><input v-model="observationForm.unit" /></label>
                  <label><span>参考下限</span><input v-model.number="observationForm.referenceLow" type="number" step="any" /></label>
                  <label><span>参考上限</span><input v-model.number="observationForm.referenceHigh" type="number" step="any" /></label>
                  <label><span>异常标记</span><FormSelect v-model="observationForm.abnormalFlag" :options="observationFlagOptions" aria-label="异常标记" /></label>
                  <label><span>参考范围原文</span><input v-model="observationForm.referenceText" /></label>
                </div>
                <p v-if="observationEditorError" class="inline-panel-error">{{ observationEditorError }}</p>
                <div class="form-actions">
                  <button type="button" @click="closeObservationEditor">取消</button>
                  <button class="primary-button" type="submit" :disabled="savingObservation">
                    <LoaderCircle v-if="savingObservation" class="spin-icon" :size="16" />保存指标
                  </button>
                </div>
              </form>
            </section>
          </div>
        </div>
      </section>
    </div>
  </Teleport>

  <Teleport to="body">
    <div v-if="editOpen" class="modal-backdrop report-edit-backdrop" @click.self="editOpen = false">
      <section class="modal-panel edit-workspace" role="dialog" aria-modal="true" aria-label="校对报告字段">
        <header class="edit-workspace-header">
          <div class="edit-workspace-title">
            <Pencil :size="20" />
            <div><h3>校对报告字段</h3><p>对照原件与 OCR 文本逐项核对</p></div>
          </div>
          <button class="plain-icon-button" type="button" title="关闭" @click="editOpen = false"><X :size="18" /></button>
        </header>
        <div class="edit-workspace-body">
          <section class="edit-col edit-col-originals">
            <div class="section-title-row">
              <div><h4>报告原件</h4><p>OCR 文字可叠加在原图上选择复制</p></div>
              <div class="edit-original-actions">
                <button v-if="currentOriginalPage" type="button" class="soft-action-button" :disabled="ocrDetailLoading" @click="showOcrOverlay = !showOcrOverlay">
                  <Sparkles :size="14" />
                  <template v-if="showOcrOverlay">隐藏</template>
                  <template v-else>显示</template>
                  OCR
                </button>
                <button v-if="firstPdfPage" class="soft-action-button edit-original-pdf" type="button" @click="openPdfOriginalViewer(firstPdfPage)">
                  <FileText :size="16" />打开 PDF 原件
                </button>
              </div>
            </div>
            <div v-if="currentOriginalPage" class="edit-swiper">
              <button
                class="edit-swiper-nav edit-swiper-nav--prev"
                type="button" title="上一页" :disabled="editOriginalIndex === 0"
                @click="editOriginalIndex -= 1"
              ><ChevronLeft :size="20" /></button>
              <div
                class="edit-swiper-stage"
                @touchstart="onOriginalSwipeStart"
                @touchend="onOriginalSwipeEnd"
              >
                <Transition name="page-fade" mode="out-in">
                 <div
                    :key="currentOriginalPage.id"
                    class="edit-original-page"
                    role="button"
                    tabindex="0"
                    :title="`第 ${currentOriginalPage.pageNumber} 页，点击放大`"
                    @click="handleOriginalClick(editOriginalIndex)"
                    @keydown.enter="openOriginalViewer(editOriginalIndex)"
                    @keydown.space.prevent="openOriginalViewer(editOriginalIndex)"
                  >
                    <div class="edit-original-image-wrapper">
                      <img
                        ref="editOriginalImage"
                        :src="viewerFullUrl(currentOriginalPage)"
                        :alt="`第 ${currentOriginalPage.pageNumber} 页`"
                        :style="originalImageAspectStyle(currentOriginalPage)"
                        decoding="async"
                        @load="onOriginalImageLoad(currentOriginalPage.id)"
                      />
                      <OcrTextOverlay v-if="showOcrOverlay && ocrDetailPage?.pageId === currentOriginalPage.id && loadedOriginalImagePageId === currentOriginalPage.id" :image="editOriginalImage" :lines="ocrDetailPage.lines" :coord-width="ocrDetailPage.coordWidth" :coord-height="ocrDetailPage.coordHeight" />
                    </div>
                    <span>第 {{ currentOriginalPage.pageNumber }} 页</span>
                  </div>
                </Transition>
              </div>
              <button
                class="edit-swiper-nav edit-swiper-nav--next"
                type="button" title="下一页" :disabled="editOriginalIndex >= (detail?.pages.length || 1) - 1"
                @click="editOriginalIndex += 1"
              ><ChevronRight :size="20" /></button>
            </div>
            <div v-if="(detail?.pages.length || 0) > 1" class="edit-swiper-indicator">
              <span>第 {{ currentOriginalPage?.pageNumber }} 页 / 共 {{ detail?.pages.length }} 页</span>
              <div class="edit-swiper-dots">
                <button
                  v-for="(page, index) in detail?.pages || []"
                  :key="page.id"
                  type="button"
                  :class="{ active: index === editOriginalIndex }"
                  :aria-label="`第 ${page.pageNumber} 页`"
                  @click="editOriginalIndex = index"
                ></button>
              </div>
            </div>
          </section>
          <section class="edit-col edit-col-ocr">
            <h4>OCR 识别文本</h4>
            <div v-if="ocrLoading" class="mini-loading"><LoaderCircle class="spin-icon" :size="16" />正在读取 OCR 文本</div>
            <p v-else-if="ocrError" class="inline-panel-error">{{ ocrError }}</p>
            <template v-else-if="ocrPages.length">
              <article v-for="page in ocrPages" :key="page.pageId" :id="`edit-ocr-page-${page.pageNumber}`" class="ocr-page-text">
                <header>
                  <strong>第 {{ page.pageNumber }} 页</strong>
                  <span>{{ page.engine || "未识别" }} · {{ page.lineCount }} 行</span>
                </header>
                <pre v-if="page.text">{{ page.text }}</pre>
                <p v-else class="preview-hint">这一页还没有 OCR 文本。</p>
              </article>
            </template>
            <p v-else class="preview-hint">暂无 OCR 文本。</p>
          </section>
          <section class="edit-col edit-col-form">
            <form class="settings-form report-edit-form" @submit.prevent="saveReportFields">
              <div class="form-grid">
                <label><span>标题<em v-if="isManualField('title')" class="manual-field-chip">人工校对</em></span><input v-model="editForm.title" /></label>
                <label><span>报告类型<em v-if="isManualField('reportType')" class="manual-field-chip">人工校对</em></span><FormSelect v-model="editForm.reportType" :options="typeOptions.filter((option) => option.value !== 'all')" aria-label="报告类型" /></label>
                <label><span>报告生成时间<em v-if="isManualField('reportIssuedAt')" class="manual-field-chip">人工校对</em></span><DateTimePicker v-model="editForm.reportIssuedAt" show-time aria-label="报告生成时间" /></label>
                <label><span>检查时间<em v-if="isManualField('examinedAt')" class="manual-field-chip">人工校对</em></span><DateTimePicker v-model="editForm.examinedAt" show-time aria-label="检查时间" /></label>
                <label><span>医院<em v-if="isManualField('hospitalName')" class="manual-field-chip">人工校对</em></span><input v-model="editForm.hospitalName" /></label>
                <label><span>院区/分院<em v-if="isManualField('hospitalBranch')" class="manual-field-chip">人工校对</em></span><input v-model="editForm.hospitalBranch" /></label>
                <label><span>城市<em v-if="isManualField('city')" class="manual-field-chip">人工校对</em></span><input v-model="editForm.city" /></label>
                <label><span>就诊科室<em v-if="isManualField('departmentName')" class="manual-field-chip">人工校对</em></span><input v-model="editForm.departmentName" /></label>
                <label><span>开单科室<em v-if="isManualField('orderingDepartment')" class="manual-field-chip">人工校对</em></span><input v-model="editForm.orderingDepartment" /></label>
                <label><span>执行科室<em v-if="isManualField('performingDepartment')" class="manual-field-chip">人工校对</em></span><input v-model="editForm.performingDepartment" /></label>
                <label><span>报告科室<em v-if="isManualField('reportingDepartment')" class="manual-field-chip">人工校对</em></span><input v-model="editForm.reportingDepartment" /></label>
                <label><span>检查部位<em v-if="isManualField('bodyParts')" class="manual-field-chip">人工校对</em></span><input v-model="editForm.bodyPart" /></label>
              </div>
              <label><span>临床诊断<em v-if="isManualField('clinicalDiagnosis')" class="manual-field-chip">人工校对</em></span><textarea v-model="editForm.clinicalDiagnosis" rows="2"></textarea></label>
              <label><span>检查目的<em v-if="isManualField('purpose')" class="manual-field-chip">人工校对</em></span><textarea v-model="editForm.purpose" rows="2"></textarea></label>
              <label><span>检查所见<em v-if="isManualField('findings')" class="manual-field-chip">人工校对</em></span><textarea v-model="editForm.findings" rows="4"></textarea></label>
              <label><span>结论<em v-if="isManualField('impression')" class="manual-field-chip">人工校对</em></span><textarea v-model="editForm.impression" rows="3"></textarea></label>
              <label><span>摘要<em v-if="isManualField('summary')" class="manual-field-chip">人工校对</em></span><textarea v-model="editForm.summary" rows="3"></textarea></label>
              <label><span>建议/复查<em v-if="isManualField('recommendation')" class="manual-field-chip">人工校对</em></span><textarea v-model="editForm.recommendation" rows="3"></textarea></label>
              <p v-if="detailError" class="inline-panel-error">{{ detailError }}</p>
              <div class="form-actions">
                <button type="button" @click="editOpen = false">取消</button>
                <button class="primary-button" type="submit" :disabled="savingReport">
                  <LoaderCircle v-if="savingReport" class="spin-icon" :size="16" />
                  保存校对
                </button>
              </div>
            </form>
          </section>
        </div>
      </section>
    </div>
  </Teleport>

  <Teleport to="body">
    <div v-if="ocrSheetOpen" class="sheet-backdrop ocr-text-sheet-backdrop" @click.self="closeOcrText">
      <section class="sheet-panel ocr-text-sheet" :class="{ 'is-reviewing': diagnosticReviewItem, 'is-comparing': ocrComparePageNumber !== null }">
        <span class="sheet-grabber"></span>
        <header class="sheet-header">
          <div>
            <h3>{{ diagnosticReviewItem ? "OCR 原文核对" : "OCR 识别文本" }}</h3>
            <p>{{ source?.title }} · 敏感号码已过滤</p>
          </div>
          <button class="plain-icon-button" type="button" title="关闭" @click="closeOcrText"><X :size="18" /></button>
        </header>
        <div class="ocr-text-body">
          <section v-if="diagnosticReviewItem" class="ocr-review-context" :class="`is-${diagnosticReviewItem.issueType}`">
            <header>
              <span>{{ reviewIssueLabel(diagnosticReviewItem.issueType) }}</span>
              <strong>{{ diagnosticReviewItem.title }}</strong>
            </header>
            <p>{{ diagnosticReviewItem.description }}</p>
            <dl>
              <div><dt>提取结果</dt><dd>{{ diagnosticReviewItem.resultSummary }}</dd></div>
              <div><dt>核对原因</dt><dd>{{ diagnosticReviewItem.reason }}</dd></div>
            </dl>
            <div class="ocr-review-actions">
              <p>
                {{ diagnosticRepairDescription(diagnosticReviewItem) }}新结果成功前继续显示当前结果，失败不会覆盖旧结果，人工校对字段也不会被覆盖。
              </p>
              <button
                class="soft-action-button"
                type="button"
                :disabled="diagnosticRepairMode(diagnosticReviewItem) === 'ocr_ai'
                  ? reprocessingReport || triggeringAi || jobsLoading || hasRunningJobs
                  : reprocessingReport || aiTriggerState.disabled"
                @click="repairDiagnosticIssue(diagnosticReviewItem)"
              >
                <LoaderCircle
                  v-if="diagnosticRepairMode(diagnosticReviewItem) === 'ocr_ai'
                    ? reprocessingReport
                    : aiTriggerState.loading"
                  class="spin-icon"
                  :size="16"
                />
                <RefreshCw v-else-if="diagnosticRepairMode(diagnosticReviewItem) === 'ocr_ai'" :size="16" />
                <Sparkles v-else :size="16" />
                {{ diagnosticRepairMode(diagnosticReviewItem) === 'ocr_ai' && reprocessingReport
                  ? "提交中"
                  : diagnosticRepairMode(diagnosticReviewItem) === 'ai' && aiTriggerState.loading
                    ? aiTriggerState.label
                    : diagnosticRepairLabel(diagnosticReviewItem) }}
              </button>
            </div>
          </section>
          <div v-if="ocrLoading" class="mini-loading"><LoaderCircle class="spin-icon" :size="16" />正在读取 OCR 文本</div>
          <p v-else-if="ocrError" class="inline-panel-error">{{ ocrError }}</p>
          <template v-else-if="ocrPages.length">
            <article
              v-for="page in ocrPages"
              :id="`ocr-review-page-${page.pageNumber}`"
              :key="page.pageId"
              class="ocr-page-text"
              :class="{ 'is-review-target': diagnosticReviewItem?.pages.includes(page.pageNumber) }"
            >
              <header>
                <div>
                  <strong>第 {{ page.pageNumber }} 页</strong>
                  <span>
                    {{ page.engine || "未识别" }}<template v-if="page.elapsedMs"> · {{ formatMs(page.elapsedMs) }}</template> · {{ page.lineCount }} 行
                    <template v-if="page.qualityLevel"> · 质量{{ page.qualityLevel === "good" ? "良好" : page.qualityLevel === "weak" ? "偏弱" : "较差" }} {{ page.qualityScore ?? "—" }}</template>
                  </span>
                </div>
                <button class="soft-action-button ocr-page-compare-button" type="button" @click="toggleOcrPageCompare(page.pageNumber)">
                  {{ ocrComparePageNumber === page.pageNumber ? "收起对照" : "原件对照" }}
                </button>
              </header>
              <p v-if="page.qualityLevel && page.qualityLevel !== 'good'" class="preview-hint">{{ page.qualityReason || "OCR 文本质量不足，AI 整理可能不完整，可尝试重新 OCR 或启用视觉模型兜底。" }}</p>
              <div v-if="ocrComparePageNumber === page.pageNumber" class="ocr-page-compare">
                <div class="ocr-page-compare__original">
                  <div v-if="reviewOriginalUrl(page.pageNumber)" class="ocr-page-compare__image">
                    <img :ref="setOcrCompareImage" :src="reviewOriginalUrl(page.pageNumber)" :alt="`第 ${page.pageNumber} 页原件`" decoding="async" @load="onOcrCompareImageLoad(page.pageId)" />
                    <OcrTextOverlay
                      v-if="ocrDetailPage?.pageId === page.pageId && loadedOcrCompareImagePageId === page.pageId"
                      :image="ocrCompareImage"
                      :lines="ocrDetailPage.lines"
                      :coord-width="ocrDetailPage.coordWidth"
                      :coord-height="ocrDetailPage.coordHeight"
                      :highlight-line-ids="diagnosticSourceLineIds"
                    />
                  </div>
                  <p v-else class="preview-hint">未找到这一页的原件预览。</p>
                </div>
                <div class="ocr-page-compare__text">
                  <div v-if="ocrDetailLoading" class="mini-loading"><LoaderCircle class="spin-icon" :size="16" />正在读取页级 OCR</div>
                  <p v-else-if="ocrDetailError" class="inline-panel-error">{{ ocrDetailError }}</p>
                  <ol v-else-if="ocrDetailPage?.pageId === page.pageId && ocrDetailPage.lines.length" class="ocr-page-lines">
                    <li
                      v-for="line in ocrDetailPage.lines"
                      :key="line.id"
                      class="ocr-page-line"
                      :class="{ 'is-review-source': isDiagnosticSourceLine(line.id) }"
                    >
                      <span v-if="isDiagnosticSourceLine(line.id)">候选原文</span>
                      <p>{{ line.text }}</p>
                    </li>
                  </ol>
                  <p v-else class="preview-hint">这一页没有可展示的 OCR 行。</p>
                </div>
              </div>
              <template v-else>
                <pre v-if="page.text">{{ page.text }}</pre>
                <p v-else class="preview-hint">这一页还没有 OCR 文本，可能仍在处理或识别失败。</p>
              </template>
            </article>
          </template>
          <p v-else class="preview-hint">暂无 OCR 文本。</p>
        </div>
      </section>
    </div>
  </Teleport>

  <ImageViewer v-if="viewerOpen" :pages="viewerImagePages" :start-index="viewerIndex" @close="viewerOpen = false" />

  <Teleport to="body">
    <div v-if="pdfViewerOpen && pdfViewerPage" class="original-viewer pdf-document-viewer" role="dialog" aria-modal="true" @click.self="closePdfOriginalViewer">
      <header class="original-viewer-header">
        <div>
          <strong>PDF 原件</strong>
          <span>已打开到第 {{ pdfViewerPage.pageNumber }} 页</span>
        </div>
        <div class="original-viewer-actions">
          <a :href="originalUrl(pdfViewerPage)" :download="pdfViewerPage.originalName" title="下载 PDF"><Download :size="18" /></a>
          <button type="button" title="关闭" @click="closePdfOriginalViewer"><X :size="20" /></button>
        </div>
      </header>
      <main class="original-viewer-stage pdf-document-stage">
        <iframe :src="pdfViewerSrc" title="PDF 原件"></iframe>
      </main>
      <footer class="original-viewer-footer">
        <span>这是完整 PDF 原件，文件较大时加载会比当前页图片慢。</span>
      </footer>
    </div>
  </Teleport>

  <Teleport to="body">
    <div v-if="eventSheetOpen && eventJob" class="sheet-backdrop job-event-sheet-backdrop" @click.self="closeJobEvents">
      <section class="sheet-panel job-event-sheet">
        <span class="sheet-grabber"></span>
        <header class="sheet-header">
          <div>
            <h3>{{ jobLabel(eventJob.jobType) }}详细日志</h3>
            <p>
              {{ eventJob.pageNumber ? `第 ${eventJob.pageNumber} 页` : "整份报告" }}{{ eventJob.originalName ? ` · ${eventJob.originalName}` : "" }}
              <template v-if="eventPolling"> · 实时更新中</template>
            </p>
          </div>
          <button class="plain-icon-button" type="button" title="关闭" @click="closeJobEvents"><X :size="18" /></button>
        </header>
        <div class="job-event-body">
          <div v-if="eventLoading" class="mini-loading"><LoaderCircle class="spin-icon" :size="16" />正在读取详细日志</div>
          <p v-if="eventError" class="inline-panel-error">{{ eventError }}</p>
          <section
            v-if="!eventLoading && processingDiagnostics"
            class="processing-diagnostics"
            :class="`is-${processingDiagnostics.outcome}`"
          >
            <header class="processing-diagnostics__header">
              <span class="processing-diagnostics__icon">
                <CheckCircle2 v-if="processingDiagnostics.outcome === 'success'" :size="19" />
                <LoaderCircle v-else-if="processingDiagnostics.outcome === 'running'" class="spin-icon" :size="19" />
                <CircleAlert v-else :size="19" />
              </span>
              <div>
                <strong>本次处理摘要</strong>
                <span>{{ processingDiagnostics.headline }}</span>
              </div>
              <small>{{ diagnosticStageLabel(processingDiagnostics.stage) }}</small>
            </header>
            <div class="processing-diagnostics__metrics">
              <div v-for="metric in diagnosticMetrics" :key="metric.label">
                <span>{{ metric.label }}</span>
                <strong>{{ metric.value }}</strong>
              </div>
            </div>
            <p v-if="processingDiagnostics.supplement.reason" class="processing-diagnostics__supplement">
              {{ processingDiagnostics.supplement.reason }}
            </p>
            <ul v-if="processingDiagnostics.reasons.length" class="processing-diagnostics__reasons">
              <li v-for="reason in processingDiagnostics.reasons" :key="reason.code" :class="`is-${reason.severity}`">
                <span>{{ processingCodeLabel(reason.code) }}</span>
                <p>{{ reason.message }}<template v-if="reason.pages.length"> · {{ formatPageNumbers(reason.pages) }}</template></p>
              </li>
            </ul>
            <div v-if="processingDiagnostics.reviewItems.length" class="processing-review-list">
              <article v-for="item in processingDiagnostics.reviewItems" :key="item.id" class="processing-review-item" :class="`is-${item.issueType}`">
                <div class="processing-review-item__type">{{ reviewIssueLabel(item.issueType) }}</div>
                <div class="processing-review-item__content">
                  <strong>{{ item.title }}</strong>
                  <p>{{ item.resultSummary }}</p>
                  <small>{{ item.reason }}</small>
                </div>
                <button v-if="item.pages.length" class="soft-action-button" type="button" @click="openDiagnosticReview(item)">
                  核对第 {{ item.pages[0] }} 页
                </button>
              </article>
            </div>
          </section>
          <div v-if="!eventLoading && isAiEventLog && jobEventDetail" class="ai-job-plan">
            <section class="ai-job-plan-summary" :class="`is-${jobEventDetail.job.status}`">
              <div class="ai-job-plan-summary__main">
                <span class="ai-job-plan-summary__icon">
                  <CheckCircle2 v-if="jobEventDetail.job.status === 'completed'" :size="20" />
                  <CircleAlert v-else-if="jobEventDetail.job.status === 'failed'" :size="20" />
                  <LoaderCircle v-else-if="jobEventDetail.job.status === 'processing'" class="spin-icon" :size="20" />
                  <Clock3 v-else :size="20" />
                </span>
                <div>
                  <strong>AI 报告整理</strong>
                  <span v-if="orderedAiUnits.length">
                    已完成 {{ completedAiUnits }}/{{ orderedAiUnits.length }} 个解析单元
                    <template v-if="jobEventDetail.job.finishedAt"> · {{ formatDatabaseTime(jobEventDetail.job.finishedAt) }} 结束</template>
                  </span>
                  <span v-else-if="jobEventDetail.job.status === 'queued' || jobEventDetail.job.status === 'processing'">正在生成解析计划</span>
                  <span v-else>该历史任务未保存解析单元明细</span>
                </div>
                <span class="ai-job-status-label" :class="`is-${jobEventDetail.job.status}`">
                  {{ aiJobStatusLabel(jobEventDetail.job.status) }}
                </span>
              </div>
              <div v-if="orderedAiUnits.length" class="ai-job-plan-progress" aria-hidden="true">
                <span :style="{ width: `${aiUnitProgressPercent}%` }"></span>
              </div>
              <p v-if="jobEventDetail.job.errorMessage" class="ai-job-plan-error">
                <template v-if="jobEventDetail.job.errorCode">{{ processingCodeLabel(jobEventDetail.job.errorCode) }} · </template>{{ jobEventDetail.job.errorMessage }}
              </p>
            </section>

            <div v-if="orderedAiUnits.length" class="ai-unit-list">
              <article v-for="unit in orderedAiUnits" :key="unit.id" class="ai-unit-row" :class="`is-${unit.status}`">
                <div class="ai-unit-row__header">
                  <span class="ai-unit-status-icon">
                    <CheckCircle2 v-if="unit.status === 'completed'" :size="18" />
                    <CircleAlert v-else-if="unit.status === 'failed' || unit.status === 'warning'" :size="18" />
                    <LoaderCircle v-else-if="unit.status === 'processing'" class="spin-icon" :size="18" />
                    <Clock3 v-else :size="18" />
                  </span>
                  <div class="ai-unit-row__content">
                    <div class="ai-unit-row__title">
                      <strong>{{ unit.displayLabel }}</strong>
                      <span>{{ formatPageNumbers(unit.pageNumbers) }}</span>
                    </div>
                    <small v-if="aiUnitMeta(unit)">{{ aiUnitMeta(unit) }}</small>
                    <p v-if="unit.errorMessage">{{ unit.errorCode ? `${processingCodeLabel(unit.errorCode)} · ` : "" }}{{ unit.errorMessage }}</p>
                  </div>
                  <span class="ai-unit-status-label" :class="`is-${unit.status}`">{{ aiUnitStatusLabel(unit.status) }}</span>
                </div>
                <details v-if="unit.events.length" class="ai-unit-history" :open="unit.status === 'failed'">
                  <summary>执行记录 {{ unit.events.length }} 条</summary>
                  <div class="job-event-timeline job-event-timeline--compact">
                    <article v-for="event in unit.events" :key="event.id" class="job-event-item" :class="`job-event-item--${event.eventType}`">
                      <span class="job-event-dot"></span>
                      <div>
                        <time>{{ formatDatabaseTime(event.createdAt) }}</time>
                        <strong>{{ eventTitle(event) }}</strong>
                        <p v-if="event.message">{{ event.message }}</p>
                        <small v-if="eventDetail(event)">{{ eventDetail(event) }}</small>
                      </div>
                    </article>
                  </div>
                </details>
              </article>
            </div>
            <p v-else-if="jobEventDetail.job.status === 'queued' || jobEventDetail.job.status === 'processing'" class="ai-job-plan-waiting">
              任务启动后会按规划顺序显示解析单元。
            </p>

            <details v-if="jobEventDetail.generalEvents.length" class="ai-job-general-history">
              <summary>任务记录 {{ jobEventDetail.generalEvents.length }} 条</summary>
              <div class="job-event-timeline job-event-timeline--compact">
                <article v-for="event in jobEventDetail.generalEvents" :key="event.id" class="job-event-item" :class="`job-event-item--${event.eventType}`">
                  <span class="job-event-dot"></span>
                  <div>
                    <time>{{ formatDatabaseTime(event.createdAt) }}</time>
                    <strong>{{ eventTitle(event) }}</strong>
                    <p v-if="event.message">{{ event.message }}</p>
                    <small v-if="eventDetail(event)">{{ eventDetail(event) }}</small>
                  </div>
                </article>
              </div>
            </details>
          </div>
          <div v-else-if="!eventLoading && !isAiEventLog && jobEvents.length" class="job-event-timeline">
            <article v-for="event in jobEvents" :key="event.id" class="job-event-item" :class="`job-event-item--${event.eventType}`">
              <span class="job-event-dot"></span>
              <div>
                <time>{{ formatDatabaseTime(event.createdAt) }}</time>
                <strong>{{ eventTitle(event) }}</strong>
                <p v-if="event.message">{{ event.message }}</p>
                <small v-if="eventDetail(event)">{{ eventDetail(event) }}</small>
              </div>
            </article>
          </div>
          <p v-else-if="!eventLoading && !eventError && !eventLogHasContent" class="preview-hint">这条任务还没有详细事件记录，处理中会自动更新。</p>
        </div>
      </section>
    </div>
  </Teleport>
</template>
