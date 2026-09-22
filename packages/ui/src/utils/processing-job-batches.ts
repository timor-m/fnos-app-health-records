import type { ProcessingJob } from "../types/api";

export type ProcessingJobBatchStatus = "queued" | "processing" | "completed" | "failed" | "cancelled";

export type ProcessingJobBatch = {
  id: string;
  kind: ProcessingJob["batchKind"];
  startedAt: string;
  sequence: number;
  status: ProcessingJobBatchStatus;
  jobs: ProcessingJob[];
};

export type ProcessingJobBatchGroups = {
  currentBatch: ProcessingJobBatch | null;
  currentJobs: ProcessingJob[];
  historicalBatches: ProcessingJobBatch[];
};

const activeStatuses = new Set<ProcessingJob["status"]>(["queued", "processing"]);

function resolveBatchStatus(jobs: readonly ProcessingJob[]): ProcessingJobBatchStatus {
  if (jobs.some((job) => job.status === "processing")) return "processing";
  if (jobs.some((job) => job.status === "queued")) return "queued";
  if (jobs.some((job) => job.status === "failed")) return "failed";
  if (jobs.some((job) => job.status === "completed")) return "completed";
  return "cancelled";
}

function sortJobs(jobs: readonly ProcessingJob[]) {
  return [...jobs].sort((left, right) => {
    const pageOrder = (left.pageNumber ?? Number.MAX_SAFE_INTEGER) - (right.pageNumber ?? Number.MAX_SAFE_INTEGER);
    if (pageOrder) return pageOrder;
    const createdOrder = left.createdAt.localeCompare(right.createdAt);
    return createdOrder || left.id.localeCompare(right.id);
  });
}


export function isProcessingJobBatchSettled(jobs: readonly ProcessingJob[]) {
  return jobs.length > 0 && jobs.every((job) => ["completed", "failed", "cancelled"].includes(job.status));
}

export function calculateProcessingJobProgress(jobs: readonly ProcessingJob[]) {
  if (!jobs.length) return 0;
  const progress = jobs.reduce((sum, job) => {
    if (["completed", "failed", "cancelled"].includes(job.status)) return sum + 1;
    if (job.jobType === "ai_extract" && job.plannedUnits) {
      return sum + Math.min(1, (job.completedUnits || 0) / job.plannedUnits);
    }
    return sum;
  }, 0);
  const percent = Math.round(progress / jobs.length * 100);
  const hasUnfinishedJob = jobs.some((job) => !["completed", "failed", "cancelled"].includes(job.status));
  return hasUnfinishedJob ? Math.min(percent, 99) : percent;
}

export function processingJobBatchLabel(batch: Pick<ProcessingJobBatch, "kind" | "jobs">) {
  if (batch.jobs.some((job) => job.pipelineVersion === "manual-page-v1")) return "页面更新";
  return {
    page_append: "补充报告页",
    initial_upload: "首次识别",
    manual_reprocess: "重新识别",
    manual_ai: "手动 AI 整理"
  }[batch.kind];
}

export function groupProcessingJobBatches(jobs: readonly ProcessingJob[]): ProcessingJobBatchGroups {
  const grouped = new Map<string, ProcessingJob[]>();
  for (const job of jobs) grouped.set(job.batchId, [...(grouped.get(job.batchId) || []), job]);

  const batches = [...grouped.entries()].map(([id, batchJobs]) => ({
    id,
    kind: batchJobs[0].batchKind,
    startedAt: batchJobs.reduce(
      (earliest, job) => job.batchStartedAt.localeCompare(earliest) < 0 ? job.batchStartedAt : earliest,
      batchJobs[0].batchStartedAt
    ),
    sequence: batchJobs.reduce(
      (latest, job) => Math.max(latest, job.batchSequence),
      batchJobs[0].batchSequence
    ),
    status: resolveBatchStatus(batchJobs),
    jobs: sortJobs(batchJobs)
  })).sort((left, right) => right.startedAt.localeCompare(left.startedAt)
    || right.sequence - left.sequence
    || right.id.localeCompare(left.id));

  const currentBatch = batches.find((batch) => batch.jobs.some((job) => activeStatuses.has(job.status)))
    || batches[0]
    || null;
  return {
    currentBatch,
    currentJobs: currentBatch?.jobs || [],
    historicalBatches: currentBatch ? batches.filter((batch) => batch.id !== currentBatch.id) : []
  };
}
