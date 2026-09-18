<script setup lang="ts">
import { computed, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref } from "vue";
import { CheckCircle2, Cpu, Database, Download, LoaderCircle, Save } from "@lucide/vue";
import SubPageHeader from "../../components/SubPageHeader.vue";
import FormSelect from "../../components/FormSelect.vue";
import { request } from "../../utils/api";
import { useAppContext } from "../../composables/useAppContext";

type OcrStatus = {
  available: boolean;
  tableEnhancementAvailable?: boolean;
  tableEnhancement?: { available: boolean; tableModel: boolean; layoutModel: boolean };
  installing: boolean;
  runtime?: {
    createdAt?: string;
    python?: string;
    pythonVersion?: string;
    backend?: string;
    engine?: string;
    modelVersion?: string;
    rapidocrVersion?: string;
    pymupdfVersion?: string;
    pillowVersion?: string;
    pillowHeifVersion?: string;
    platform?: string;
    machine?: string;
  } | null;
  lastInstall?: {
    state: "idle" | "installing" | "success" | "failed";
    startedAt?: string;
    finishedAt?: string;
    exitCode?: number | null;
    error?: string;
    warning?: string;
    runtimeReady?: boolean;
    missing?: string[];
    logPath?: string;
    logTail?: string[];
  };
  runner: { started: boolean; busy: boolean; queued: number; processing: number; failed: number };
};
type DatabaseStatus = {
  driver: string;
  path: string;
  integrity: string;
  schemaVersion: number;
  appliedSchemaVersion: number;
  journalMode: string;
  pageSize: number;
  pageCount: number;
  freelistCount: number;
  usedPageCount: number;
  databaseSizeBytes: number;
  walSizeBytes: number;
  shmSizeBytes: number;
  totalSizeBytes: number;
  rowCounts: Record<string, number>;
};
type SystemSummary = {
  servicePort: number;
  database: DatabaseStatus;
  storage: {
    storageDir: string;
    databaseBytes: number;
    reportsBytes: number;
    thumbnailsBytes: number;
    backupsBytes: number;
    logsBytes: number;
    modelsBytes: number;
    totalKnownBytes: number;
  };
};
type PipMirrorKey = "official" | "tsinghua" | "aliyun" | "tencent" | "huaweicloud" | "custom";
type OcrInstallSettings = {
  pipMirror: PipMirrorKey;
  customPipIndexUrl: string;
  resolvedPipIndexUrl: string;
  mirrors: Array<{ key: PipMirrorKey; label: string; indexUrl: string; description: string }>;
};

const app = useAppContext();
const system = ref<SystemSummary | null>(null);
const ocr = ref<OcrStatus | null>(null);
const ocrSettings = ref<OcrInstallSettings>({
  pipMirror: "tsinghua",
  customPipIndexUrl: "",
  resolvedPipIndexUrl: "",
  mirrors: []
});
const runtimeMessage = ref("");
const savingOcrSettings = ref(false);
let statusTimer: ReturnType<typeof setInterval> | null = null;
const databaseSummaryRows = computed(() => [
  { label: "报告", value: system.value?.database?.rowCounts?.reports || 0 },
  { label: "页面", value: system.value?.database?.rowCounts?.report_pages || 0 },
  { label: "任务", value: system.value?.database?.rowCounts?.processing_jobs || 0 },
  { label: "日志", value: system.value?.database?.rowCounts?.processing_job_events || 0 }
]);
const ocrRuntimeRows = computed(() => {
  const runtime = ocr.value?.runtime;
  const enhancement = ocr.value?.tableEnhancement;
  const moduleText = (ready?: boolean) => ready ? "已安装" : "未安装";
  const rows = [
    { label: "识别引擎", value: runtime?.engine || runtime?.backend || (ocr.value?.available ? "已安装" : "—") },
    { label: "识别模型", value: runtime?.modelVersion || "—" },
    { label: "表格识别（RapidTable）", value: enhancement ? moduleText(enhancement.tableModel) : "—" },
    { label: "版面分析（RapidLayout）", value: enhancement ? moduleText(enhancement.layoutModel) : "—" },
    { label: "Python", value: runtime?.pythonVersion || "—" },
    { label: "平台", value: runtime?.machine ? `${runtime.platform || "—"} · ${runtime.machine}` : runtime?.platform || "—" }
  ];
  return rows.filter((row) => row.value !== "—" || !ocr.value?.available);
});
const selectedPipIndexUrl = computed(() => {
  if (ocrSettings.value.pipMirror === "custom") return ocrSettings.value.customPipIndexUrl.trim();
  return ocrSettings.value.mirrors.find((mirror) => mirror.key === ocrSettings.value.pipMirror)?.indexUrl || "";
});

function logLineClass(line: string) {
  const lower = line.toLowerCase();
  if (/error|failed|失败|错误/.test(lower)) return "log-line log-line--error";
  if (/warn|警告|注意/.test(lower)) return "log-line log-line--warn";
  return "log-line";
}

function formatBytes(value?: number | null) {
  const bytes = Number(value || 0);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function integrityLabel(value?: string | null) {
  if (!value) return "检查中";
  return value === "ok" ? "正常" : value;
}
function stopStatusPolling() {
  if (!statusTimer) return;
  clearInterval(statusTimer);
  statusTimer = null;
}
function startStatusPolling() {
  if (statusTimer) return;
  statusTimer = setInterval(() => { void refreshOcr(); }, 3000);
}
function syncStatusPolling() {
  if (ocr.value?.installing) startStatusPolling();
  else stopStatusPolling();
}

let statusPollFailures = 0;
async function refreshOcr() {
  try {
    ocr.value = await request<OcrStatus>("ocr/status");
    statusPollFailures = 0;
    syncStatusPolling();
  } catch (error) {
    statusPollFailures += 1;
    /* 安装长达数分钟，允许偶发轮询失败；连续多次失败才停轮询并提示，避免界面卡在“正在安装” */
    if (statusPollFailures >= 5) {
      runtimeMessage.value = `OCR 状态刷新中断：${error instanceof Error ? error.message : "无法获取 OCR 状态"}。请刷新页面查看最新状态`;
      stopStatusPolling();
    }
  }
}
async function installOcr() {
  runtimeMessage.value = "";
  try {
    ocr.value = await request<OcrStatus>("ocr/install", { method: "POST" });
    runtimeMessage.value = "OCR 环境正在后台安装，完成后队列会自动开始处理";
    syncStatusPolling();
  } catch (error) {
    runtimeMessage.value = error instanceof Error ? error.message : "OCR 环境安装启动失败";
    stopStatusPolling();
  }
}
async function saveOcrSettings() {
  savingOcrSettings.value = true;
  runtimeMessage.value = "";
  try {
    ocrSettings.value = await request<OcrInstallSettings>("ocr/settings", {
      method: "PUT",
      body: JSON.stringify({
        pipMirror: ocrSettings.value.pipMirror,
        customPipIndexUrl: ocrSettings.value.customPipIndexUrl
      })
    });
    runtimeMessage.value = "Python 依赖镜像源已保存，下次安装或重装 OCR 环境时生效";
  } catch (error) {
    runtimeMessage.value = error instanceof Error ? error.message : "保存镜像源失败";
  } finally {
    savingOcrSettings.value = false;
  }
}
onMounted(async () => {
  const [systemResult, ocrResult, ocrSettingsResult] = await Promise.allSettled([
    request<SystemSummary>("system"),
    request<OcrStatus>("ocr/status"),
    request<OcrInstallSettings>("ocr/settings")
  ]);
  if (systemResult.status === "fulfilled") system.value = systemResult.value;
  if (ocrResult.status === "fulfilled") ocr.value = ocrResult.value;
  if (ocrSettingsResult.status === "fulfilled") ocrSettings.value = ocrSettingsResult.value;
  const failedParts = [
    systemResult.status === "rejected" ? "系统信息" : "",
    ocrResult.status === "rejected" ? "OCR 状态" : "",
    ocrSettingsResult.status === "rejected" ? "镜像源设置" : ""
  ].filter(Boolean);
  if (failedParts.length) {
    runtimeMessage.value = `${failedParts.join("、")}加载失败，请稍后刷新页面重试`;
  }
  syncStatusPolling();
});
onBeforeUnmount(stopStatusPolling);
/* KeepAlive 缓存期间暂停 OCR 安装状态轮询，回到页面时若仍在安装则恢复 */
onDeactivated(stopStatusPolling);
onActivated(syncStatusPolling);
</script>

<template>
  <section class="settings-page">
    <SubPageHeader title="运行与识别" description="报告先在设备内完成 OCR，再由 AI 整理结构化字段" />
    <section class="settings-band">
      <header>
        <Cpu :size="21" />
        <div><h3>运行状态</h3><p>设备本地识别环境与任务队列</p></div>
        <button
          v-if="app.session.value?.isAdmin"
          class="header-action"
          type="button"
          :disabled="(ocr?.available && ocr?.tableEnhancementAvailable) || ocr?.installing"
          @click="installOcr"
        >
          <LoaderCircle v-if="ocr?.installing" class="spin-icon" :size="17" />
          <CheckCircle2 v-else-if="ocr?.available" :size="17" />
          <Download v-else :size="17" />
          {{ ocr?.installing ? "正在安装" : ocr?.available ? (ocr?.tableEnhancementAvailable ? "OCR 已安装" : "升级 OCR · 表格增强") : "安装 OCR 环境" }}
        </button>
      </header>
      <div class="status-grid">
        <div class="status-card status-card--wide">
          <span>数据库</span>
          <strong><Database :size="16" />{{ integrityLabel(system?.database?.integrity) }} · {{ formatBytes(system?.database?.totalSizeBytes) }}</strong>
          <small>Schema v{{ system?.database?.appliedSchemaVersion || system?.database?.schemaVersion || "—" }} · {{ system?.database?.journalMode?.toUpperCase() || "—" }} · WAL {{ formatBytes(system?.database?.walSizeBytes) }}</small>
          <div class="compact-counts">
            <span v-for="row in databaseSummaryRows" :key="row.label">{{ row.label }} {{ row.value }}</span>
          </div>
        </div>
        <div><span>服务端口</span><strong>{{ system?.servicePort || "检查中" }}</strong></div>
        <div><span>OCR 运行环境</span><strong>{{ ocr?.available ? "可用" : ocr?.installing ? "安装中" : "未安装" }}</strong></div>
        <div><span>处理队列</span><strong>待处理 {{ ocr?.runner?.queued || 0 }} · 运行中 {{ ocr?.runner?.processing || 0 }} · 失败 {{ ocr?.runner?.failed || 0 }}</strong></div>
      </div>
      <section class="runtime-detail">
        <header><h4>数据目录占用</h4><p>{{ system?.storage?.storageDir || "正在读取数据目录" }}</p></header>
        <div class="usage-grid usage-grid--compact">
          <div><span>数据库目录</span><strong>{{ formatBytes(system?.storage?.databaseBytes) }}</strong></div>
          <div><span>报告原件</span><strong>{{ formatBytes(system?.storage?.reportsBytes) }}</strong></div>
          <div><span>缩略图</span><strong>{{ formatBytes(system?.storage?.thumbnailsBytes) }}</strong></div>
          <div><span>备份</span><strong>{{ formatBytes(system?.storage?.backupsBytes) }}</strong></div>
          <div><span>日志</span><strong>{{ formatBytes(system?.storage?.logsBytes) }}</strong></div>
          <div><span>OCR 模型</span><strong>{{ formatBytes(system?.storage?.modelsBytes) }}</strong></div>
          <div><span>已统计合计</span><strong>{{ formatBytes(system?.storage?.totalKnownBytes) }}</strong></div>
        </div>
      </section>
      <section class="runtime-detail">
        <header>
          <h4>Python 依赖镜像源</h4>
          <p>国内网络建议选择清华、阿里云、腾讯云或华为云；保存后下次安装 OCR 环境时生效。</p>
        </header>
        <div class="settings-form runtime-pip-form">
          <label>
            <span>镜像源</span>
            <FormSelect
              :model-value="ocrSettings.pipMirror"
              :options="ocrSettings.mirrors.map((mirror) => ({ value: mirror.key, label: mirror.label }))"
              aria-label="镜像源"
              @update:model-value="ocrSettings.pipMirror = $event as PipMirrorKey"
            />
          </label>
          <label v-if="ocrSettings.pipMirror === 'custom'">
            <span>自定义地址</span>
            <input v-model.trim="ocrSettings.customPipIndexUrl" placeholder="https://example.com/simple" />
          </label>
          <p class="preview-hint">当前将使用：{{ selectedPipIndexUrl || "pip 默认源" }}</p>
          <div class="form-actions">
            <button type="button" :disabled="savingOcrSettings || ocr?.installing" @click="saveOcrSettings">
              <LoaderCircle v-if="savingOcrSettings" class="spin-icon" :size="17" />
              <Save v-else :size="17" />
              {{ savingOcrSettings ? "正在保存" : "保存镜像源" }}
            </button>
          </div>
        </div>
      </section>
      <section v-if="!ocr?.available || ocr?.lastInstall?.state" class="runtime-detail">
        <header>
          <h4>OCR 安装诊断</h4>
          <p>安装完成后会执行一次真实识别测试。表格识别与版面分析模块能明显提升检验单等表格报告的指标提取完整性，未安装时可点上方“升级 OCR · 表格增强”补齐。</p>
        </header>
        <div class="usage-grid usage-grid--compact">
          <div v-for="row in ocrRuntimeRows" :key="row.label"><span>{{ row.label }}</span><strong>{{ row.value }}</strong></div>
        </div>
        <p v-if="ocr?.lastInstall?.error" class="inline-panel-error">{{ ocr.lastInstall.error }}</p>
        <p v-if="ocr?.lastInstall?.warning" class="preview-hint">{{ ocr.lastInstall.warning }}</p>
        <p v-if="ocr?.lastInstall?.missing?.length" class="preview-hint">缺失路径：{{ ocr.lastInstall.missing.join("；") }}</p>
        <p v-if="ocr?.lastInstall?.logPath" class="preview-hint">安装日志：{{ ocr.lastInstall.logPath }}</p>
        <pre v-if="ocr?.lastInstall?.logTail?.length" class="runtime-install-log"><span v-for="(line, index) in ocr.lastInstall.logTail" :key="index" :class="logLineClass(line)">{{ line }}
</span></pre>
      </section>
      <p v-if="runtimeMessage" class="runtime-message">{{ runtimeMessage }}</p>
    </section>
  </section>
</template>
