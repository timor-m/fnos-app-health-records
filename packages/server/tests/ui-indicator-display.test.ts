import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  describeObservationAbnormal,
  formatObservationNormalization,
  formatRawIndicatorResult,
  formatReferenceRange
} from "../../ui/src/utils/indicator-display.ts";

test("indicator display preserves raw values and never duplicates the raw unit", () => {
  assert.equal(formatRawIndicatorResult("480", "mIU/L"), "480 mIU/L");
  assert.equal(formatRawIndicatorResult("480 mIU/L", "mIU/L"), "480 mIU/L");
  assert.equal(formatRawIndicatorResult("", null, "未读取到原始结果"), "未读取到原始结果");
});

test("indicator display distinguishes canonical trend values from withheld raw results", () => {
  assert.equal(formatObservationNormalization({
    canonicalName: "泌乳素",
    canonicalValue: 20,
    canonicalUnit: "ng/mL",
    normalizationQuality: "high",
    normalizationExcludedReason: null
  }), "已整理为：泌乳素 · 高可信 · 趋势值 20 ng/mL");

  const incompatible = formatObservationNormalization({
    canonicalName: "泌乳素",
    canonicalValue: null,
    canonicalUnit: null,
    normalizationQuality: "low",
    normalizationExcludedReason: "单位与标准指标不兼容"
  });
  assert.match(incompatible, /低可信/);
  assert.match(incompatible, /未生成趋势值，保留原始结果/);
  assert.match(incompatible, /单位与标准指标不兼容/);
  assert.equal(incompatible.includes("趋势值 480"), false);
});


test("indicator display uses converted numeric reference bounds when raw text is unavailable", () => {
  assert.equal(formatReferenceRange({
    referenceLow: 3.89,
    referenceHigh: 5.55,
    referenceText: null,
    unit: "mmol/L"
  }), "参考 3.89 - 5.55 mmol/L");
  assert.equal(formatReferenceRange({
    referenceLow: null,
    referenceHigh: 10,
    referenceText: null,
    unit: "ng/mL"
  }), "参考 ≤ 10 ng/mL");
  assert.equal(formatReferenceRange({
    referenceLow: 70,
    referenceHigh: 100,
    referenceText: "70-100 mg/dL",
    unit: "mmol/L"
  }), "参考 70-100 mg/dL");
});

test("observation abnormal display standardizes reported, computed, conflict, normal and unresolved states", () => {
  const reported = describeObservationAbnormal({
    displayAbnormalFlag: "high",
    abnormalStatus: "reported",
    abnormalConflict: false,
    abnormalReason: "报告原始标记偏高",
  });
  assert.equal(reported.label, "偏高");
  assert.equal(reported.isAbnormal, true);
  assert.equal(reported.explanation, null);

  const computed = describeObservationAbnormal({
    displayAbnormalFlag: "high",
    abnormalStatus: "computed",
    abnormalConflict: false,
    abnormalReason: "数值高于报告参考上限",
  });
  assert.equal(computed.label, "高于参考范围");
  assert.equal(computed.isComputed, true);
  assert.equal(computed.explanation, "数值高于报告参考上限");

  const conflict = describeObservationAbnormal({
    displayAbnormalFlag: null,
    abnormalStatus: "conflict",
    abnormalConflict: true,
    abnormalReason: "报告标记与参考范围不一致",
  });
  assert.equal(conflict.label, "异常标记待核验");
  assert.equal(conflict.isConflict, true);
  assert.equal(conflict.isAbnormal, false);

  const normal = describeObservationAbnormal({
    displayAbnormalFlag: "normal",
    abnormalStatus: "reported",
    abnormalConflict: false,
  });
  assert.equal(normal.label, "正常");
  assert.equal(normal.visible, true);

  const unresolved = describeObservationAbnormal({
    displayAbnormalFlag: null,
    abnormalStatus: "unresolved",
    abnormalConflict: false,
  });
  assert.equal(unresolved.visible, false);
  assert.equal(unresolved.tone, "plain");
});

test("report and trend UIs share effective abnormal display semantics", () => {
  const reportDetailSource = readFileSync(join(process.cwd(), "packages/ui/src/components/ReportDetail.vue"), "utf8");
  const trendsSource = readFileSync(join(process.cwd(), "packages/ui/src/pages/TrendsPage.vue"), "utf8");

  assert.match(reportDetailSource, /describeObservationAbnormal/);
  assert.match(reportDetailSource, /observationAbnormalDisplay/);
  assert.match(reportDetailSource, /observationFlagLabel/);
  assert.doesNotMatch(reportDetailSource, /abnormalLabel\(item\.abnormalFlag\)/);

  assert.match(trendsSource, /describeObservationAbnormal/);
  assert.match(trendsSource, /pointAbnormalDisplay/);
  assert.match(trendsSource, /pointFlagClass\(chartPoint\.point\)/);
  assert.doesNotMatch(trendsSource, /flagClass\(point\.abnormalFlag\)/);
});


test("trend UI pauses automatic deltas and explains cross-report comparability", () => {
  const source = readFileSync(join(process.cwd(), "packages/ui/src/pages/TrendsPage.vue"), "utf8");
  assert.match(source, /!item\.changeAssessmentAllowed/);
  assert.match(source, /暂不比较/);
  assert.match(source, /参考范围发生变化/);
  assert.match(source, /检测条件可能不同/);
  assert.match(source, /item\.comparabilityReason/);
});

test("trend UI separates arithmetic changes, multi-point conclusions and outlier handling", () => {
  const source = readFileSync(join(process.cwd(), "packages/ui/src/pages/TrendsPage.vue"), "utf8");
  assert.match(source, /算术差值/);
  assert.match(source, /至少需要 3 次有效记录|trendStatusLabel/);
  assert.match(source, /数值连续上升/);
  assert.match(source, /数值连续下降/);
  assert.match(source, /存在波动/);
  assert.match(source, /item\.typicalMinValue/);
  assert.match(source, /point\.trendOutlier/);
  assert.match(source, /变化待核验/);
});

test("trend UI exposes abnormal continuity without turning numeric direction into medical judgment", () => {
  const source = readFileSync(join(process.cwd(), "packages/ui/src/pages/TrendsPage.vue"), "utf8");
  assert.match(source, /仅本次异常/);
  assert.match(source, /连续 \$\{item\.consecutiveAbnormalCount\} 次异常/);
  assert.match(source, /最新已回到参考范围/);
  assert.match(source, /最新接近参考边界/);
  assert.match(source, /异常标记待核验/);
  // 异常连续性徽章不再直接铺在卡片上；仅“异常标记待核验”这类需要用户核对的
  // 罕见冲突才通过 ! 图标提示，其余状态在图表和整理详情中已可辨识。
  assert.doesNotMatch(source, /class="trend-abnormal-continuity"/);
  const collapsed = source.match(
    /function collapsedNotices\(item: TrendSeries\) \{([\s\S]*?)\n\}/
  )?.[1] || "";
  assert.match(collapsed, /abnormalContinuityStatus === "conflict"/);
  assert.doesNotMatch(collapsed, /latest_abnormal|persistent_abnormal|near_boundary|recovered/);
  assert.match(source, /接近参考边界/);
  assert.match(source, /item\.attentionPriority === "normal"/);
  assert.match(source, /item\.attentionPriority !== "normal"/);
  assert.match(source, /item\.abnormalContinuityReason/);
  assert.doesNotMatch(source, /abnormalContinuityLabel[\s\S]{0,800}(?:改善|恶化|变好|变差)/);
});


test("trend UI prioritizes comparability notices and avoids duplicate detail explanations", () => {
  const source = readFileSync(join(process.cwd(), "packages/ui/src/pages/TrendsPage.vue"), "utf8");
  assert.match(source, /function showTrendChangeSummary\(item: TrendSeries\)/);
  assert.match(source, /item\.pointCount > 1\s*&&\s*item\.changeAssessmentAllowed/);
  assert.match(source, /v-if="showTrendChangeSummary\(item\)" class="trend-change-summary"/);
  // 可比性提示不直接铺在卡片上；! 图标只在检测条件不同（数值不可比）时出现，
  // 参考范围漂移等常见情形交由“暂不比较”差值文案与整理详情说明
  assert.doesNotMatch(source, /class="trend-comparability-notice"/);
  assert.match(source, /item\.trendStatus !== "insufficient_evidence"/);
  assert.match(source, /function collapsedNotices\(item: TrendSeries\)/);
  assert.match(source, /item\.comparabilityStatus === "condition_mismatch"/);
  assert.doesNotMatch(source, /collapsedNotices[\s\S]{0,600}range_drift/);
  assert.match(source, /<IndicatorHint v-if="collapsedNotices\(item\)\.length"/);
  assert.doesNotMatch(source, /class="trend-normalization-popover trend-notice-popover"/);
  assert.match(source, /function showMultiPointTrendDetail\(item: TrendSeries\)/);
  assert.match(source, /function abnormalContinuityDetail\(item: TrendSeries\)/);
  assert.match(source, /item\.attentionReason !== item\.abnormalContinuityReason/);
  assert.doesNotMatch(source, /本次结果[\s\S]{0,300}item\.attentionReason/);
  assert.doesNotMatch(source, /(?:改善|恶化|变好|变差)/);
});
