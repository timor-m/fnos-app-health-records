import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { ProcessingJob } from "../../ui/src/types/api.ts";
import { resolveReportReprocessNotice } from "../../ui/src/utils/report-reprocess-state.ts";

type ReprocessJob = Pick<ProcessingJob, "jobType" | "status" | "pipelineVersion">;

function job(
  jobType: ReprocessJob["jobType"],
  status: ReprocessJob["status"],
  pipelineVersion = "manual-reprocess-v1"
): ReprocessJob {
  return { jobType, status, pipelineVersion };
}

test("ordinary upload jobs do not claim that an older result is being preserved", () => {
  assert.equal(resolveReportReprocessNotice([
    job("ocr", "processing", "upload-v1"),
    job("ai_extract", "failed", "health-record-v1")
  ]), null);
});

test("active manual OCR or AI reprocess keeps the previous result visible", () => {
  for (const current of [job("ocr", "queued"), job("ocr", "processing"), job("ai_extract", "queued"), job("ai_extract", "processing")]) {
    assert.deepEqual(resolveReportReprocessNotice([current]), {
      tone: "info",
      title: "正在重新识别",
      message: "当前仍展示上一次成功的报告数据和趋势，完成后会自动更新。",
      action: null,
      actionLabel: null
    });
  }
});

test("page refresh waiting for its first job response keeps an explicit preserved-result notice", () => {
  assert.deepEqual(resolveReportReprocessNotice([], true, true), {
    tone: "info",
    title: "正在更新报告页面",
    message: "当前仍展示上一次成功的报告数据和趋势，页面重新识别完成后会自动更新。",
    action: null,
    actionLabel: null
  });
  assert.deepEqual(resolveReportReprocessNotice([], false, true), {
    tone: "info",
    title: "正在更新报告页面",
    message: "正在根据调整后的报告页面重新识别，完成后会自动更新报告内容。",
    action: null,
    actionLabel: null
  });
});

test("page edit refresh has dedicated preserved-result and recovery language", () => {
  assert.deepEqual(resolveReportReprocessNotice([
    job("thumbnail", "completed", "manual-page-v1"),
    job("ocr", "processing", "manual-page-v1")
  ]), {
    tone: "info",
    title: "正在更新报告页面",
    message: "当前仍展示上一次成功的报告数据和趋势，页面重新识别完成后会自动更新。",
    action: null,
    actionLabel: null
  });
  assert.equal(
    resolveReportReprocessNotice([job("ocr", "failed", "manual-page-v1")])?.title,
    "报告页面更新未完成"
  );
  assert.equal(
    resolveReportReprocessNotice([job("ai_extract", "failed", "manual-page-v1")])?.title,
    "页面更新后的 AI 整理失败"
  );
});

test("manual recovery without an older structured result does not claim that old trend data exists", () => {
  assert.deepEqual(resolveReportReprocessNotice([job("ocr", "processing")], false), {
    tone: "info",
    title: "正在重新识别",
    message: "正在处理报告原件，完成后会自动更新报告内容。",
    action: null,
    actionLabel: null
  });
  assert.equal(
    resolveReportReprocessNotice([job("ocr", "failed")], false)?.message,
    "本次未生成可用结果，建议重新运行 OCR + AI。"
  );
  assert.equal(
    resolveReportReprocessNotice([job("ocr", "completed"), job("ai_extract", "failed")], false)?.message,
    "新的 OCR 已完成，但 AI 整理失败，可直接重新 AI 整理。"
  );
});

test("failed OCR recommends a full OCR and AI rerun without invalidating old data", () => {
  assert.deepEqual(resolveReportReprocessNotice([
    job("ocr", "completed"),
    job("ocr", "failed")
  ]), {
    tone: "warning",
    title: "本次重新识别失败",
    message: "原有报告数据和趋势未受影响。建议重新运行 OCR + AI。",
    action: "retry_ocr_ai",
    actionLabel: "重新运行 OCR + AI"
  });
});

test("failed AI after completed OCR recommends AI-only recovery", () => {
  assert.deepEqual(resolveReportReprocessNotice([
    job("ocr", "completed"),
    job("ai_extract", "failed")
  ]), {
    tone: "warning",
    title: "本次 AI 整理失败",
    message: "新的 OCR 已完成，原有报告数据和趋势未受影响，可直接重新 AI 整理。",
    action: "retry_ai",
    actionLabel: "重新 AI 整理"
  });
});

test("completed or cancelled manual reprocess history does not leave a stale notice", () => {
  assert.equal(resolveReportReprocessNotice([job("ocr", "completed"), job("ai_extract", "completed")]), null);
  assert.equal(resolveReportReprocessNotice([job("ocr", "cancelled"), job("ai_extract", "cancelled")]), null);
});

test("report detail and trends use consistent preserved-result language", () => {
  const reportDetail = readFileSync(join(process.cwd(), "packages/ui/src/components/ReportDetail.vue"), "utf8");
  const reprocessState = readFileSync(join(process.cwd(), "packages/ui/src/utils/report-reprocess-state.ts"), "utf8");
  const trends = readFileSync(join(process.cwd(), "packages/ui/src/pages/TrendsPage.vue"), "utf8");
  assert.match(reportDetail, /resolveReportReprocessNotice/);
  assert.match(reportDetail, /reprocessNotice\.message/);
  assert.match(reportDetail, /系统会复用当前 OCR 文本生成 AI 整理结果和指标/);
  assert.match(reportDetail, /当前已保存的报告数据和趋势会继续显示/);
  assert.match(reportDetail, /本次失败也不会覆盖旧结果/);
  assert.match(reportDetail, /已人工校对的字段会保留且不会被 AI 自动覆盖/);
  assert.match(reportDetail, /按原件重新识别文字，并重新生成 AI 整理和指标/);
  assert.match(reportDetail, /新结果还没全部完成前，现在的报告和趋势照常显示/);
  assert.match(reportDetail, /这次失败，也不会覆盖原来的结果/);
  assert.match(reportDetail, /你手工改过的内容会保留，AI 不会再自动改掉/);
  assert.match(reprocessState, /当前仍展示上一次成功的报告数据和趋势/);
  assert.match(reprocessState, /原有报告数据和趋势未受影响/);
  assert.match(reprocessState, /重新运行 OCR \+ AI/);
  assert.match(reprocessState, /重新 AI 整理/);
  assert.match(trends, /暂时展示上一次成功结果/);
  assert.match(trends, /仍来自上一次成功结果/);
});
