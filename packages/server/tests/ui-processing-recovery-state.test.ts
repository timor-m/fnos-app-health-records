import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { ProcessingJob } from "../../ui/src/types/api.ts";
import {
  PROCESSING_DELAY_THRESHOLDS,
  resolveProcessingDelayNotice,
  resolveProcessingRecoveryState
} from "../../ui/src/utils/processing-recovery-state.ts";

type Golden = {
  pollFailureLimit: number;
  queuedDelayMs: number;
  processingDelayMs: number;
  recoveryTitle: string;
  recoveryAction: string;
  queuedTitle: string;
  processingTitle: string;
  delayMessage: string;
};

type DelayJob = Pick<ProcessingJob, "status" | "createdAt" | "startedAt">;

const golden = JSON.parse(readFileSync(
  join(process.cwd(), "packages/server/tests/fixtures/p3-processing-recovery-golden.json"),
  "utf8"
)) as Golden;
const reportDetail = readFileSync(
  join(process.cwd(), "packages/ui/src/components/ReportDetail.vue"),
  "utf8"
);
const styles = readFileSync(
  join(process.cwd(), "packages/ui/src/styles.css"),
  "utf8"
);
const jobRunner = readFileSync(
  join(process.cwd(), "packages/server/services/job-runner.service.ts"),
  "utf8"
);

function recovery(input: Partial<Parameters<typeof resolveProcessingRecoveryState>[0]> = {}) {
  return resolveProcessingRecoveryState({
    reprocessingReport: false,
    jobsLoading: false,
    jobsPollingStopped: false,
    pageRefreshAwaitingJobs: false,
    hasRunningJobs: false,
    reportStatus: "ready",
    ...input
  });
}

function delayJob(
  status: DelayJob["status"],
  createdAt: string,
  startedAt: string | null = null
): DelayJob {
  return { status, createdAt, startedAt };
}

test("stable reports allow reprocessing while uncertain or active states remain disabled", () => {
  assert.deepEqual(recovery(), {
    reprocessDisabled: false,
    reprocessLabel: "重跑 OCR+AI",
    statusUncertain: false
  });
  assert.deepEqual(recovery({ jobsLoading: true }), {
    reprocessDisabled: true,
    reprocessLabel: "读取状态",
    statusUncertain: true
  });
  assert.deepEqual(recovery({ jobsPollingStopped: true }), {
    reprocessDisabled: true,
    reprocessLabel: "先恢复进度",
    statusUncertain: true
  });
  assert.deepEqual(recovery({ pageRefreshAwaitingJobs: true }), {
    reprocessDisabled: true,
    reprocessLabel: "正在更新页面",
    statusUncertain: true
  });
  assert.deepEqual(recovery({ hasRunningJobs: true }), {
    reprocessDisabled: true,
    reprocessLabel: "识别处理中",
    statusUncertain: false
  });
  assert.deepEqual(recovery({ reportStatus: "processing" }), {
    reprocessDisabled: true,
    reprocessLabel: "识别处理中",
    statusUncertain: true
  });
  assert.deepEqual(recovery({ reprocessingReport: true, jobsPollingStopped: true }), {
    reprocessDisabled: true,
    reprocessLabel: "提交中",
    statusUncertain: true
  });
});

test("queued and processing delay thresholds are conservative and deterministic", () => {
  assert.deepEqual(PROCESSING_DELAY_THRESHOLDS, {
    queued: golden.queuedDelayMs,
    processing: golden.processingDelayMs
  });
  const now = Date.parse("2026-08-07T12:00:00Z");
  assert.equal(resolveProcessingDelayNotice([
    delayJob("queued", "2026-08-07 11:45:00.001")
  ], now), null);
  assert.deepEqual(resolveProcessingDelayNotice([
    delayJob("queued", "2026-08-07 11:45:00")
  ], now), {
    status: "queued",
    title: golden.queuedTitle,
    message: golden.delayMessage
  });
  assert.equal(resolveProcessingDelayNotice([
    delayJob("processing", "2026-08-07 10:00:00", "2026-08-07 11:15:00.001")
  ], now), null);
  assert.deepEqual(resolveProcessingDelayNotice([
    delayJob("processing", "2026-08-07 10:00:00", "2026-08-07 11:15:00")
  ], now), {
    status: "processing",
    title: golden.processingTitle,
    message: golden.delayMessage
  });
});

test("delay detection ignores settled history and invalid timestamps and prioritizes processing", () => {
  const now = Date.parse("2026-08-07T12:00:00Z");
  assert.equal(resolveProcessingDelayNotice([
    delayJob("completed", "2026-08-07 08:00:00", "2026-08-07 08:01:00"),
    delayJob("failed", "2026-08-07 08:00:00", "2026-08-07 08:01:00"),
    delayJob("cancelled", "2026-08-07 08:00:00", null),
    delayJob("queued", "not-a-time", null)
  ], now), null);
  assert.equal(resolveProcessingDelayNotice([
    delayJob("processing", "2026-08-07 11:00:00", null)
  ], now)?.status, "processing");
  assert.equal(resolveProcessingDelayNotice([
    delayJob("queued", "2026-08-07 10:00:00"),
    delayJob("processing", "2026-08-07 10:00:00", "2026-08-07 11:00:00")
  ], now)?.status, "processing");
});

test("polling failures expose one GET-only recovery path without creating a duplicate batch", () => {
  assert.equal(golden.pollFailureLimit, 3);
  assert.match(
    reportDetail,
    /jobsPollFailures \+= 1;[\s\S]*?if \(!silent \|\| jobsPollFailures >= 3\)[\s\S]*?jobsPollingStopped\.value = true;[\s\S]*?stopJobsPolling\(\);/
  );
  assert.match(
    reportDetail,
    /selectedJobs\.value = nextJobs;[\s\S]*?jobsPollingStopped\.value = false;[\s\S]*?jobsPollFailures = 0;/
  );
  assert.match(
    reportDetail,
    new RegExp(`<strong>${golden.recoveryTitle}</strong>[\\s\\S]*?@click="refreshJobs\\(\\)"[\\s\\S]*?${golden.recoveryAction}`)
  );
  assert.doesNotMatch(
    reportDetail,
    /processing-recovery-notice[\s\S]{0,900}@click="(?:reprocessCurrentReport|requestReportReprocess|triggerAiExtraction)/
  );
});

test("reprocess protection is consistent in UI guards and the server active-job check", () => {
  assert.match(
    reportDetail,
    /function requestReportReprocess\([^)]*\) \{\s*if \(processingRecoveryState\.value\.reprocessDisabled\) return;/
  );
  assert.match(
    reportDetail,
    /:disabled="processingRecoveryState\.reprocessDisabled"[\s\S]*?\{\{ processingRecoveryState\.reprocessLabel \}\}/
  );
  assert.match(
    jobRunner,
    /status IN \('queued', 'processing'\)[\s\S]*?这份报告已有任务在排队或处理中，请稍后再重新识别/
  );
});

test("report switches and keep-alive activation restore status reading safely", () => {
  assert.match(
    reportDetail,
    /watch\(\(\) => \[props\.reportId, props\.expectedMemberId\] as const,[\s\S]*?jobsPollingStopped\.value = false;/
  );
  assert.match(
    reportDetail,
    /onActivated\(\(\) => \{[\s\S]*?hasRunningJobs\.value \|\| source\.value\?\.status === "queued" \|\| source\.value\?\.status === "processing"[\s\S]*?refreshJobs\(true\)/
  );
});

test("recovery and delay notices wrap actions below their copy on narrow screens", () => {
  assert.match(
    styles,
    /@media \(max-width: 760px\)[\s\S]*?\.processing-recovery-notice,[\s\S]*?\.processing-delay-notice \{ grid-template-columns: 20px minmax\(0, 1fr\); align-items: start; \}[\s\S]*?\.processing-recovery-notice > button,[\s\S]*?\.processing-delay-notice > button \{ grid-column: 2; justify-self: start; \}/
  );
});
