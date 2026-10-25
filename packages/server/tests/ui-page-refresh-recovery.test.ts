import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { ProcessingJob } from "../../ui/src/types/api.ts";
import { resolveAiTriggerState } from "../../ui/src/utils/ai-trigger-state.ts";
import { resolveReportReprocessNotice } from "../../ui/src/utils/report-reprocess-state.ts";

type Golden = {
  awaitingWithPrevious: ReturnType<typeof resolveReportReprocessNotice>;
  awaitingWithoutPrevious: ReturnType<typeof resolveReportReprocessNotice>;
  button: ReturnType<typeof resolveAiTriggerState>;
  pipelineVersion: string;
  pollFailureLimit: number;
  detailSyncIntervalMs: number;
};

type ReprocessJob = Pick<ProcessingJob, "jobType" | "status" | "pipelineVersion">;

const golden = JSON.parse(readFileSync(
  join(process.cwd(), "packages/server/tests/fixtures/p3-page-refresh-recovery-golden.json"),
  "utf8"
)) as Golden;

function job(
  jobType: ReprocessJob["jobType"],
  status: ReprocessJob["status"],
  pipelineVersion: string
): ReprocessJob {
  return { jobType, status, pipelineVersion };
}

const reportDetail = readFileSync(
  join(process.cwd(), "packages/ui/src/components/ReportDetail.vue"),
  "utf8"
);

test("page refresh waiting for jobs preserves the old result or explains the first extraction", () => {
  assert.deepEqual(resolveReportReprocessNotice([], true, true), golden.awaitingWithPrevious);
  assert.deepEqual(resolveReportReprocessNotice([], false, true), golden.awaitingWithoutPrevious);
});

test("AI action remains disabled and loading while the page refresh batch is not visible yet", () => {
  assert.deepEqual(resolveAiTriggerState({
    triggeringAi: false,
    pageMutationPending: true,
    jobsLoading: false,
    reportStatus: "processing",
    jobs: []
  }), golden.button);
  assert.match(
    reportDetail,
    /pageMutationPending: savingPages\.value \|\| pageRefreshAwaitingJobs\.value/
  );
});

test("the awaiting state is cleared only after the current page-refresh batch becomes visible", () => {
  assert.match(
    reportDetail,
    /pageRefreshAwaitingJobs\.value[\s\S]*?nextCurrentJobs\.some\(\(job\) => job\.pipelineVersion === "manual-page-v1"\)[\s\S]*?pageRefreshAwaitingJobs\.value = false/
  );
  assert.deepEqual(resolveReportReprocessNotice([
    job("ocr", "processing", golden.pipelineVersion)
  ], true, false), golden.awaitingWithPrevious);
});

test("silent job refresh failures keep polling twice and surface the third consecutive failure", () => {
  assert.equal(golden.pollFailureLimit, 3);
  assert.match(
    reportDetail,
    /jobsPollFailures \+= 1;[\s\S]*?if \(!silent \|\| jobsPollFailures >= 3\)[\s\S]*?failJobsAction\(cause, "无法读取处理进度"\);[\s\S]*?stopJobsPolling\(\);[\s\S]*?else \{[\s\S]*?maybeStartJobsPolling\(\);/
  );
});

test("settled jobs retry final detail synchronization while the report still looks active", () => {
  assert.equal(golden.detailSyncIntervalMs, 10000);
  assert.match(reportDetail, /Date\.now\(\) - lastDetailSyncAt > 10000/);
  assert.match(
    reportDetail,
    /const finalDetailMayBeStale = settled && \["queued", "processing"\]\.includes\(source\.value\?\.status \|\| ""\)/
  );
  assert.match(
    reportDetail,
    /\|\| \(finalDetailMayBeStale && syncIntervalElapsed\)/
  );
  assert.match(reportDetail, /await loadDetail\(reportId, true\)/);
});

test("switching reports clears page-refresh recovery state", () => {
  assert.match(
    reportDetail,
    /watch\(\(\) => \[props\.reportId, props\.expectedMemberId\] as const,[\s\S]*?pageRefreshAwaitingJobs\.value = false/
  );
});

test("ordinary upload and manual AI/OCR reruns retain their existing notice semantics", () => {
  assert.equal(resolveReportReprocessNotice([
    job("ocr", "processing", "upload-v1")
  ], true, false), null);
  assert.equal(resolveReportReprocessNotice([
    job("ocr", "processing", "manual-reprocess-v1")
  ], true, false)?.title, "正在重新识别");
});
