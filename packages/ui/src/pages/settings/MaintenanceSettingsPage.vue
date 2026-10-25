<script setup lang="ts">
import { ref } from "vue";
import { Bot, ClipboardList, DatabaseBackup, GitMerge, ScrollText, ChevronRight, Database, FileText, RefreshCw, ScanSearch } from "@lucide/vue";
import SubPageHeader from "../../components/SubPageHeader.vue";
import { request } from "../../utils/api";
import { useConfirm } from "../../composables/useConfirm";
import { useToast } from "../../composables/useToast";
import { useAppContext } from "../../composables/useAppContext";

const app = useAppContext();
const confirmDialog = useConfirm();

type PdfPreviewMaintenanceResult = {
  scanned: number;
  regenerated: number;
  failed: number;
  removedLegacy: number;
  failures: Array<{ pageId: string; reportId: string; message: string }>;
};

type MorphologyTrackingResult = {
  scanned: number;
  linked: number;
  groups: number;
  untracked: number;
  ambiguous: number;
  members: number;
};

const toast = useToast();
const previewRunning = ref(false);
const previewResult = ref<PdfPreviewMaintenanceResult | null>(null);
const previewError = ref("");
const morphologyRunning = ref(false);
const morphologyResult = ref<MorphologyTrackingResult | null>(null);
const morphologyError = ref("");

async function regeneratePdfPreviews() {
  confirmDialog.ask({
    title: "重新生成 PDF 单页图",
    message: "确认重新生成历史 PDF 单页预览图？会用高清单页图直接替换旧预览图，原 PDF 和缩略图不受影响。",
    confirmText: "开始生成",
    run: async () => {
      previewRunning.value = true;
      previewError.value = "";
      try {
        previewResult.value = await request<PdfPreviewMaintenanceResult>("maintenance/pdf-previews", { method: "POST" });
        toast.show(previewResult.value.failed
          ? `已生成 ${previewResult.value.regenerated} 页，失败 ${previewResult.value.failed} 页`
          : `已生成 ${previewResult.value.regenerated} 页高清图`);
      } catch (cause) {
        previewError.value = cause instanceof Error ? cause.message : "PDF 单页图维护失败";
      } finally {
        previewRunning.value = false;
      }
    }
  });
}

async function rebuildMorphologyTracking() {
  confirmDialog.ask({
    title: "重新关联历史形态发现",
    message: "确认按部位、左右侧和发现类型重新关联历史形态记录？该操作只在本地整理关联关系，不调用 AI，也不会修改原报告内容。",
    confirmText: "开始关联",
    run: async () => {
      morphologyRunning.value = true;
      morphologyError.value = "";
      try {
        morphologyResult.value = await request<MorphologyTrackingResult>(
          "maintenance/morphology-tracking",
          { method: "POST" }
        );
        toast.show(`已建立 ${morphologyResult.value.groups} 组形态变化记录`);
      } catch (cause) {
        morphologyError.value = cause instanceof Error ? cause.message : "历史形态关联失败";
      } finally {
        morphologyRunning.value = false;
      }
    }
  });
}
</script>

<template>
  <section class="settings-page maintenance-page">
    <SubPageHeader title="维护工具" description="数据维护、检查修复与日志诊断" />

    <section class="maintenance-group" aria-labelledby="maintenance-data-title">
      <header class="maintenance-group-header"><h3 id="maintenance-data-title">数据维护</h3><p>{{ app.session.value?.isAdmin ? "备份档案，整理重复报告" : "检查与整理重复报告" }}</p></header>
    <nav class="settings-menu" aria-label="数据维护">
      <RouterLink v-if="app.session.value?.isAdmin" to="/me/data"><DatabaseBackup :size="20" /><div><strong>备份与恢复</strong><span>导出成员清单，备份与恢复档案</span></div><ChevronRight :size="18" /></RouterLink>
      <RouterLink v-if="app.session.value?.isAdmin" to="/me/maintenance/member-merges"><GitMerge :size="20" /><div><strong>成员档案合并</strong><span>合并同一人的档案，核对归属与共享权限</span></div><ChevronRight :size="18" /></RouterLink>
      <RouterLink to="/me/duplicates"><GitMerge :size="20" /><div><strong>重复报告检测</strong><span>查找重复报告，核对后合并或清理</span></div><ChevronRight :size="18" /></RouterLink>
    </nav>
    </section>

    <template v-if="app.session.value?.isAdmin">
    <section class="maintenance-group" aria-labelledby="maintenance-repair-title">
      <header class="maintenance-group-header"><h3 id="maintenance-repair-title">检查与修复</h3><p>管理指标匹配，维护历史记录与预览图</p></header>
    <nav class="settings-menu" aria-label="指标管理">
      <RouterLink to="/me/maintenance/indicators"><Database :size="20" /><div><strong>指标管理</strong><span>管理指标字典、历史匹配与未命中项目</span></div><ChevronRight :size="18" /></RouterLink>
    </nav>

    <section class="maintenance-tool">
      <header>
        <div>
          <ScanSearch :size="20" />
          <div>
            <h4>历史形态关联</h4>
            <p>重新整理历史形态变化，歧义记录留待确认</p>
          </div>
        </div>
        <button class="maintenance-action" type="button" :disabled="morphologyRunning" @click="rebuildMorphologyTracking">
          <RefreshCw :size="16" :class="{ 'spin-icon': morphologyRunning }" />{{ morphologyRunning ? "关联中" : "重新关联" }}
        </button>
      </header>
      <p v-if="morphologyError" class="inline-panel-error">{{ morphologyError }}</p>
      <div v-if="morphologyResult" class="maintenance-result">
        <div>
          <span>扫描发现</span>
          <strong>{{ morphologyResult.scanned }}</strong>
        </div>
        <div>
          <span>成功关联</span>
          <strong>{{ morphologyResult.linked }}</strong>
        </div>
        <div>
          <span>变化分组</span>
          <strong>{{ morphologyResult.groups }}</strong>
        </div>
        <div>
          <span>待确认/歧义</span>
          <strong>{{ morphologyResult.untracked }}/{{ morphologyResult.ambiguous }}</strong>
        </div>
      </div>
    </section>

    <section class="maintenance-tool">
      <header>
        <div>
          <FileText :size="20" />
          <div>
            <h4>PDF 高清分页图</h4>
            <p>更新历史报告预览图，保留原 PDF 与缩略图</p>
          </div>
        </div>
        <button class="maintenance-action" type="button" :disabled="previewRunning" @click="regeneratePdfPreviews">
          <RefreshCw :size="16" :class="{ 'spin-icon': previewRunning }" />{{ previewRunning ? "生成中" : "重新生成" }}
        </button>
      </header>
      <p v-if="previewError" class="inline-panel-error">{{ previewError }}</p>
      <div v-if="previewResult" class="maintenance-result">
        <div>
          <span>扫描 PDF 页</span>
          <strong>{{ previewResult.scanned }}</strong>
        </div>
        <div>
          <span>生成高清图</span>
          <strong>{{ previewResult.regenerated }}</strong>
        </div>
        <div>
          <span>替换旧图</span>
          <strong>{{ previewResult.removedLegacy }}</strong>
        </div>
        <div>
          <span>失败页数</span>
          <strong>{{ previewResult.failed }}</strong>
        </div>
      </div>
    </section>

    <section v-if="previewResult?.failures.length" class="maintenance-tool maintenance-change-list">
      <header>
        <div><FileText :size="20" /><div><h4>生成失败样例</h4><p>最多显示前 {{ previewResult.failures.length }} 条。</p></div></div>
      </header>
      <article v-for="failure in previewResult.failures" :key="failure.pageId">
        <span>{{ failure.reportId }} / {{ failure.pageId }}</span>
        <strong>{{ failure.message }}</strong>
      </article>
    </section>
    </section>

    <section class="maintenance-group" aria-labelledby="maintenance-logs-title">
      <header class="maintenance-group-header"><h3 id="maintenance-logs-title">日志与诊断</h3><p>查看运行情况与操作记录，排查异常</p></header>
    <nav class="settings-menu" aria-label="日志与诊断">
      <RouterLink to="/me/system-logs"><ScrollText :size="20" /><div><strong>系统日志</strong><span>运行异常、日志占用与清理</span></div><ChevronRight :size="18" /></RouterLink>
      <RouterLink to="/me/audit"><ClipboardList :size="20" /><div><strong>用户操作日志</strong><span>健康记录、历程关联与维护操作记录</span></div><ChevronRight :size="18" /></RouterLink>
      <RouterLink to="/me/ai-audit"><Bot :size="20" /><div><strong>AI 审计</strong><span>调用次数、失败、耗时和 Token 消耗</span></div><ChevronRight :size="18" /></RouterLink>
    </nav>
    </section>
    </template>
  </section>
</template>

<style scoped>
.maintenance-page { gap: 20px; }
.maintenance-group {
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: 20px;
  background: var(--surface);
  box-shadow: 0 3px 12px var(--hairline);
  padding: 6px 20px;
}
.maintenance-group-header {
  display: flex; align-items: baseline; justify-content: space-between; gap: 12px;
  padding: 17px 2px 15px; border-bottom: 1px solid var(--line);
}
.maintenance-group-header h3 { margin: 0; font-size: 16px; font-weight: 700; letter-spacing: .02em; }
.maintenance-group-header p { margin: 0; color: var(--muted); font-size: 12px; line-height: 1.6; }
.maintenance-group .settings-menu { border-radius: 0; box-shadow: none; background: transparent; overflow: visible; }
.maintenance-group .settings-menu a {
  grid-template-columns: 42px minmax(0, 1fr) 18px;
  gap: 14px; padding: 19px 2px; min-height: 84px;
}
.maintenance-group .settings-menu a:hover { background: var(--brand-softer); }
.maintenance-group .settings-menu a > svg:first-child,
.maintenance-tool > header > div > svg {
  box-sizing: content-box; width: 20px; height: 20px; padding: 11px;
  border-radius: 13px; background: var(--brand-softer); color: var(--brand);
  flex-shrink: 0;
}
.maintenance-group .settings-menu a strong { font-size: 14px; font-weight: 600; line-height: 1.6; }
.maintenance-group .settings-menu a span { line-height: 1.6; font-size: 12px; }
.maintenance-tool { border-top: 1px solid var(--line); }
.maintenance-tool > header { display: flex; align-items: center; gap: 16px; padding: 19px 2px; min-height: 84px; }
.maintenance-tool > header > div { display: flex; align-items: center; gap: 14px; flex: 1; min-width: 0; }
.maintenance-tool h4 { margin: 0; font-size: 16px; font-weight: 600; line-height: 1.6; }
.maintenance-tool p { margin: 3px 0 0; color: var(--muted); font-size: 12px; line-height: 1.6; }
.maintenance-action {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  flex-shrink: 0; min-height: 36px; padding: 0 12px;
  border: 0; border-radius: 9px;
  background: var(--brand-soft); color: var(--brand-strong); font-size: 12px; font-weight: 600;
  white-space: nowrap; cursor: pointer; transition: background .15s;
}
.maintenance-action:hover:not(:disabled) { background: var(--brand-soft-hover); }
.maintenance-action:focus-visible, .settings-menu a:focus-visible { outline: 2px solid var(--brand); outline-offset: 3px; }
.maintenance-action:disabled { opacity: .55; cursor: wait; }
.maintenance-tool .inline-panel-error { width: auto; margin: 0 2px 16px; color: var(--danger); }
.maintenance-result { padding: 0 2px 18px; gap: 8px; }
.maintenance-result > div { border: 0; border-radius: 10px; background: var(--fill-2); }
.maintenance-change-list article { overflow-wrap: anywhere; }
@media (max-width: 600px) {
  .maintenance-page { gap: 14px; }
  .maintenance-group { padding: 3px 14px; border-radius: 16px; }
  .maintenance-group-header { display: block; padding: 14px 0 12px; }
  .maintenance-group-header p { margin-top: 3px; font-size: 12px; }
  .maintenance-group .settings-menu a { grid-template-columns: 36px minmax(0, 1fr) 16px; gap: 11px; padding: 15px 0; }
  .maintenance-group .settings-menu a > svg:first-child,
  .maintenance-tool > header > div > svg { padding: 8px; border-radius: 11px; }
  .maintenance-tool > header { flex-wrap: wrap; gap: 10px; padding: 15px 0; }
  .maintenance-tool > header > div { flex-basis: 100%; gap: 11px; }
  .maintenance-action { margin-left: 47px; min-height: 40px; }
  .maintenance-result { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
</style>
