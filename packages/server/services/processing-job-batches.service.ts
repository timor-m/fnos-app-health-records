import { getDatabase } from "../database/client";

export type ProcessingJobBatchKind = "initial_upload" | "manual_reprocess" | "manual_ai" | "page_append";

export type ProcessingJobBatchSource = {
  id: string;
  jobType: string;
  pipelineVersion: string;
  deduplicationKey: string;
  status: string;
  createdAt: string;
  jobSequence: number;
};

export type ProcessingJobQueuedDetail = {
  batchId: string | null;
  source: string | null;
  previousReportStatus: string | null;
};

export type ProcessingJobBatchAssignment = {
  batchId: string;
  batchKind: ProcessingJobBatchKind;
  batchStartedAt: string;
  batchSequence: number;
};

export function parseProcessingJobQueuedDetail(value: string | undefined): ProcessingJobQueuedDetail {
  try {
    const detail = JSON.parse(value || "{}") as {
      batchId?: unknown;
      source?: unknown;
      previousReportStatus?: unknown;
    };
    return {
      batchId: typeof detail.batchId === "string" && detail.batchId.trim() ? detail.batchId.trim() : null,
      source: typeof detail.source === "string" ? detail.source : null,
      previousReportStatus: typeof detail.previousReportStatus === "string" ? detail.previousReportStatus : null
    };
  } catch {
    return { batchId: null, source: null, previousReportStatus: null };
  }
}

export function deriveProcessingJobBatches(
  jobs: ProcessingJobBatchSource[],
  queuedEventDetails: Map<string, ProcessingJobQueuedDetail>
) {
  const knownManualBatches = jobs.flatMap((job) => {
    const detail = queuedEventDetails.get(job.id);
    const isManualReprocess = detail?.source === "manual_reprocess"
      || detail?.source === "manual_page_edit"
      || detail?.source === "manual_page_delete"
      || job.pipelineVersion === "manual-reprocess-v1"
      || job.pipelineVersion === "manual-page-v1";
    if (!detail?.batchId || !isManualReprocess) return [];
    return [{ id: detail.batchId, startedAt: job.createdAt, sequence: job.jobSequence }];
  }).sort((left, right) => left.startedAt.localeCompare(right.startedAt) || left.sequence - right.sequence);

  const assignments = new Map<string, { batchId: string; batchKind: ProcessingJobBatchKind }>();
  for (const job of jobs) {
    const detail = queuedEventDetails.get(job.id) || {
      batchId: null,
      source: null,
      previousReportStatus: null
    };
    if (detail.source === "page_append" || job.pipelineVersion === "page-append-v1") {
      assignments.set(job.id, { batchId: detail.batchId || job.id, batchKind: "page_append" });
      continue;
    }
    if (detail.source === "manual" || job.deduplicationKey.includes(":ai_extract:manual:")) {
      assignments.set(job.id, {
        batchId: detail.batchId || `manual-ai:${job.id}`,
        batchKind: "manual_ai"
      });
      continue;
    }
    const isManualReprocess = detail.source === "manual_reprocess"
      || detail.source === "manual_page_edit"
      || detail.source === "manual_page_delete"
      || job.pipelineVersion === "manual-reprocess-v1"
      || job.pipelineVersion === "manual-page-v1";
    if (detail.batchId && isManualReprocess) {
      assignments.set(job.id, { batchId: detail.batchId, batchKind: "manual_reprocess" });
      continue;
    }
    if (job.pipelineVersion === "manual-reprocess-v1" || job.pipelineVersion === "manual-page-v1") {
      const inherited = [...knownManualBatches]
        .reverse()
        .find((batch) => batch.startedAt.localeCompare(job.createdAt) < 0
          || (batch.startedAt === job.createdAt && batch.sequence <= job.jobSequence));
      assignments.set(job.id, {
        batchId: inherited?.id || `manual-reprocess:${job.id}`,
        batchKind: "manual_reprocess"
      });
      continue;
    }
    assignments.set(job.id, { batchId: "initial-upload", batchKind: "initial_upload" });
  }

  const batchStartedAt = new Map<string, string>();
  const batchSequence = new Map<string, number>();
  for (const job of jobs) {
    const assignment = assignments.get(job.id)!;
    const currentStartedAt = batchStartedAt.get(assignment.batchId);
    if (!currentStartedAt || job.createdAt.localeCompare(currentStartedAt) < 0) {
      batchStartedAt.set(assignment.batchId, job.createdAt);
    }
    const currentSequence = batchSequence.get(assignment.batchId);
    if (currentSequence === undefined || job.jobSequence > currentSequence) {
      batchSequence.set(assignment.batchId, job.jobSequence);
    }
  }
  return new Map(jobs.map((job) => {
    const assignment = assignments.get(job.id)!;
    return [job.id, {
      ...assignment,
      batchStartedAt: batchStartedAt.get(assignment.batchId) || job.createdAt,
      batchSequence: batchSequence.get(assignment.batchId) ?? job.jobSequence
    }];
  }));
}

export function loadReportProcessingBatchContext(reportId: string) {
  const db = getDatabase();
  const jobs = db.prepare(`
    SELECT id, job_type AS jobType, pipeline_version AS pipelineVersion,
      deduplication_key AS deduplicationKey, status, created_at AS createdAt, rowid AS jobSequence
    FROM processing_jobs
    WHERE report_id = ?
    ORDER BY created_at, rowid
  `).all(reportId) as ProcessingJobBatchSource[];
  const queuedRows = db.prepare(`
    SELECT job_id AS jobId, detail_json AS detailJson
    FROM processing_job_events
    WHERE report_id = ? AND event_type = 'queued'
    ORDER BY created_at, rowid
  `).all(reportId) as Array<{ jobId: string; detailJson: string }>;
  const queuedDetails = new Map<string, ProcessingJobQueuedDetail>();
  for (const row of queuedRows) {
    if (!queuedDetails.has(row.jobId)) queuedDetails.set(row.jobId, parseProcessingJobQueuedDetail(row.detailJson));
  }
  const assignments = deriveProcessingJobBatches(jobs, queuedDetails);
  const grouped = new Map<string, ProcessingJobBatchSource[]>();
  for (const job of jobs) {
    const assignment = assignments.get(job.id)!;
    grouped.set(assignment.batchId, [...(grouped.get(assignment.batchId) || []), job]);
  }
  const batches = [...grouped.entries()].map(([id, batchJobs]) => ({
    id,
    kind: assignments.get(batchJobs[0]!.id)!.batchKind,
    startedAt: assignments.get(batchJobs[0]!.id)!.batchStartedAt,
    sequence: assignments.get(batchJobs[0]!.id)!.batchSequence,
    jobs: batchJobs
  })).sort((left, right) => right.startedAt.localeCompare(left.startedAt)
    || right.sequence - left.sequence
    || right.id.localeCompare(left.id));
  const currentBatch = batches.find((batch) => batch.jobs.some((job) => ["queued", "processing"].includes(job.status)))
    || batches[0]
    || null;
  const previousReportStatus = currentBatch
    ? currentBatch.jobs
        .map((job) => queuedDetails.get(job.id)?.previousReportStatus)
        .find((status): status is string => Boolean(status)) || null
    : null;
  return { jobs, queuedDetails, assignments, batches, currentBatch, previousReportStatus };
}

export function loadProcessingBatchForJob(reportId: string, jobId: string) {
  const context = loadReportProcessingBatchContext(reportId);
  const assignment = context.assignments.get(jobId);
  if (!assignment) return { ...context, batch: null, batchJobs: [] as ProcessingJobBatchSource[] };
  const batch = context.batches.find((item) => item.id === assignment.batchId) || null;
  return { ...context, batch, batchJobs: batch?.jobs || [] };
}
