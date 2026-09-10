import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const reportDetail = readFileSync(
  join(process.cwd(), "packages/ui/src/components/ReportDetail.vue"),
  "utf8"
);
const styles = readFileSync(
  join(process.cwd(), "packages/ui/src/styles.css"),
  "utf8"
);

test("indicator explanations share a collapsed, dismissible hint without nested card actions", () => {
  const hint = readFileSync(join(process.cwd(), "packages/ui/src/components/IndicatorHint.vue"), "utf8");
  assert.match(hint, /const open = ref\(false\)/);
  assert.match(hint, /@focusout="blur"/);
  assert.match(hint, /@keydown\.esc=/);
  assert.match(hint, /@click\.stop @keydown\.stop/);
  assert.match(hint, /removeEventListener\("pointerdown", outside, true\)/);
  assert.match(hint, /onBeforeUnmount\(cleanup\)/);
  assert.match(reportDetail, /<IndicatorHint/);
  const trends = readFileSync(join(process.cwd(), "packages/ui/src/pages/TrendsPage.vue"), "utf8");
  assert.match(trends, /<IndicatorHint/);
  assert.doesNotMatch(trends, /function toggleNotice/);
});

test("indicator review separates navigation, feedback and per-record actions on narrow screens", () => {
  const page = readFileSync(join(process.cwd(), "packages/ui/src/pages/settings/IndicatorIssuesSettingsPage.vue"), "utf8");
  assert.match(page, /class="indicator-review-tabs" role="group"/);
  assert.match(page, /class="indicator-review-status"/);
  assert.match(page, /class="indicator-review-actions"/);
  assert.match(styles, /\.indicator-review-actions > button \{[^}]*white-space: nowrap/);
  assert.doesNotMatch(styles, /\.indicator-review-actions > button \{[^}]*border-radius/);
  assert.match(styles, /\.indicator-review-actions \{ display: grid; grid-template-columns: minmax\(0, 1fr\) minmax\(0, 1fr\);/);
});

test("report detail previews ten standardized indicators by default", () => {
  assert.match(reportDetail, /const OBSERVATION_PREVIEW_LIMIT = 10;/);
  assert.match(reportDetail, /previewSourceObservations\.value\.slice\(0, OBSERVATION_PREVIEW_LIMIT\)/);
});

test("standard selector explains empty results without blocking raw review", () => {
  const select = readFileSync(join(process.cwd(), "packages/ui/src/components/FormSelect.vue"), "utf8");
  assert.match(select, /v-if="!options.length \|\| hint"/);
  assert.match(select, /暂无可选项/);
  assert.match(reportDetail, /暂无可选标准指标/);
  assert.match(reportDetail, /保留“不指定标准指标”后保存核对/);
});

test("governance directly reuses the indicator editor without cascading report dialogs", () => {
  const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
  const governance = read("packages/ui/src/pages/settings/IndicatorIssuesSettingsPage.vue");
  const records = read("packages/ui/src/pages/RecordsPage.vue");
  assert.match(governance, /:review-observation-id="reviewingIssue.representativeObservationId"/);
  assert.match(reportDetail, /<template v-if="!reviewObservationId">/);
  assert.match(reportDetail, /<aside class="observation-all-list"/);
  assert.match(styles, /\.observation-direct-review > header, \.observation-direct-review \.observation-all-list \{ display: none;/);
  assert.doesNotMatch(styles, /grid-template-areas: "source editor"/);
  assert.match(reportDetail, /if \(target\) openObservationEditor\(target\)/);
  assert.match(records, /<ReportDetailSheet v-if="mobileDetailOpen && selected"/);
  assert.doesNotMatch(reportDetail, /initialObservationId/);
  assert.doesNotMatch(governance, /report-detail-sheet-backdrop/);
  const sheet = read("packages/ui/src/components/ReportDetailSheet.vue");
  assert.match(sheet, /role="dialog" aria-modal="true" aria-label="报告详情"/);
  assert.match(sheet, /@updated="emit\('updated'\)"/);
});

test("observation editor prioritizes result fields and groups optional metadata", () => {
  assert.ok(reportDetail.indexOf('class="form-grid observation-core-fields"') < reportDetail.indexOf('class="observation-catalog-picker"'));
  assert.match(reportDetail, /<summary>标准指标/);
  assert.match(reportDetail, /<summary>更多信息/);
  assert.match(styles, /\.observation-editor-form \.observation-core-fields,[\s\S]*?grid-template-columns: minmax\(0, 1fr\) minmax\(0, 1fr\)/);
  assert.match(styles, /\.observation-editor-fields \{[^}]*align-content: start;[^}]*overflow-y: auto/);
  assert.match(styles, /\.observation-edit-panel\.is-open \{[^}]*height: auto; max-height: 88dvh/);
  assert.doesNotMatch(styles, /\.observation-edit-panel \.observation-editor-form \.form-actions > button \{[^}]*border-radius/);
});

test("report detail uses one review state for non-trend observations", () => {
  assert.match(reportDetail, /const pendingReviewObservations = computed\(\(\) => \[\.\.\.secondaryObservations\.value, \.\.\.governanceObservations\.value\]\);/);
  assert.match(reportDetail, /项待核对/);
  assert.match(reportDetail, /<strong>待核对指标<\/strong>/);
  assert.doesNotMatch(reportDetail, /待补标准指标|待治理项/);
});

test("observation review workspace keeps source context beside the editor", () => {
  assert.match(reportDetail, /class="observation-source-panel"/);
  assert.match(reportDetail, /class="observation-edit-panel"/);
  assert.match(reportDetail, /:highlight-line-ids="observationEvidenceLineIds"/);
  assert.match(reportDetail, /class="observation-all-layout"/);
  assert.match(styles, /grid-template-areas:\s*"source list editor"/);
  assert.doesNotMatch(reportDetail, /observation-editor-backdrop|observation-editor-modal/);
});

test("touch observation editing opens above the review workspace", () => {
  assert.match(reportDetail, /class="observation-edit-panel" :class="\{ 'is-open': observationEditorOpen \}"/);
  assert.match(styles, /\.observation-edit-panel\.is-open \{[^}]*position:\s*fixed;[^}]*z-index:\s*130;/);
  assert.match(styles, /\.form-select-layer \{[^}]*z-index:\s*140;/);
});

test("touch observation review hides the desktop source comparison column", () => {
  assert.match(styles, /\.modal-panel\.observation-all-modal \{ width: 100%; height: auto; max-height: 88dvh;/);
  assert.match(styles, /\.observation-all-modal > header \.observation-all-actions \{ flex: 0 0 auto; flex-flow: row nowrap;/);
  assert.match(styles, /\.observation-all-layout \{[^}]*grid-template-areas:\s*"list";/);
  assert.match(styles, /\.observation-source-panel \{\s*display:\s*none;/);
  assert.match(styles, /\.observation-all-list \{[^}]*max-height:\s*none;/);
});

test("teleported content type selector stays above nested report editors", () => {
  const selectLayer = styles.match(/\.form-select-layer \{[^}]*z-index:\s*(\d+);[^}]*\}/)?.[1];
  const editorLayer = styles.match(/\.structured-section-editor-backdrop[^}]*z-index:\s*(\d+);[^}]*\}/)?.[1];
  assert.ok(selectLayer, "form-select layer z-index should be declared");
  assert.ok(editorLayer, "structured-section editor z-index should be declared");
  assert.ok(Number(selectLayer) > Number(editorLayer));
});
