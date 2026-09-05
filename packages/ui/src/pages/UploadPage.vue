<script setup lang="ts">
import { computed, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref } from "vue";
import {
  ArrowDown, ArrowUp, Camera, CheckCircle2, ChevronRight, CircleAlert, FileImage, FileText,
  Folder, FolderOpen, HardDrive, ImagePlus, LoaderCircle, RefreshCw, RotateCw, UploadCloud, X
} from "@lucide/vue";
import { useAppContext } from "../composables/useAppContext";
import { apiUrl, request, requestUpload } from "../utils/api";
import { describeTechnical } from "../utils/error";
import { getDeploymentCopy } from "../utils/deployment-copy";
import type { ProcessingJob } from "../types/api";
import {
  calculateProcessingJobProgress, groupProcessingJobBatches, isProcessingJobBatchSettled
} from "../utils/processing-job-batches";

type QueueItem = {
  id: string;
  file: File;
  previewUrl: string;
  rotation: number;
};

type UploadResult = {
  reportId: string;
  title: string;
  status: "queued";
  pageCount: number;
  jobCount: number;
};

type LocalImportRoot = { id: string; label: string; path: string };
type LocalImportEntry = {
  name: string;
  path: string;
  type: "directory" | "file";
  size: number | null;
  modifiedAt: string;
};
type LocalBrowserResponse = {
  roots: LocalImportRoot[];
  current: { rootId: string; path: string } | null;
  entries: LocalImportEntry[];
  truncated: boolean;
  availability: {
    state: "ready" | "not_configured" | "unavailable";
    configuredCount: number;
    unavailableCount: number;
    message: string | null;
  };
  personalAuthorization: boolean;
};
type SelectedLocalFile = { rootId: string; path: string; name: string; size: number };


const app = useAppContext();
const items = ref<QueueItem[]>([]);
const dragging = ref(false);
const uploading = ref(false);
const error = ref("");
const result = ref<UploadResult | null>(null);
const jobs = ref<ProcessingJob[]>([]);
const runtimeAvailable = ref(true);
const localBrowserOpen = ref(false);
const localBrowserLoading = ref(false);
const localImporting = ref(false);
const localError = ref("");
const localRoots = ref<LocalImportRoot[]>([]);
const localCurrent = ref<{ rootId: string; path: string } | null>(null);
const localEntries = ref<LocalImportEntry[]>([]);
const localTruncated = ref(false);
const localAvailability = ref<LocalBrowserResponse["availability"] | null>(null);
const selectedLocalFiles = ref<SelectedLocalFile[]>([]);
const localPreviewEntry = ref<LocalImportEntry | null>(null);
const localPreviewFailed = ref(new Set<string>());
const localLargePreviewFailed = ref(false);
const localAuthorizing = ref(false);
let pollTimer: ReturnType<typeof setInterval> | null = null;
const totalBytes = computed(() => items.value.reduce((total, item) => total + item.file.size, 0));
const batchGroups = computed(() => groupProcessingJobBatches(jobs.value));
const currentJobs = computed(() => batchGroups.value.currentJobs);
const completedJobs = computed(() => currentJobs.value.filter((job) => job.status === "completed").length);
const failedJobs = computed(() => currentJobs.value.filter((job) => job.status === "failed"));
const cancelledJobs = computed(() => currentJobs.value.filter((job) => job.status === "cancelled").length);
const finishedJobs = computed(() => completedJobs.value + failedJobs.value.length + cancelledJobs.value);
const progressPercent = computed(() => calculateProcessingJobProgress(currentJobs.value));
const jobsSettled = computed(() => isProcessingJobBatchSettled(currentJobs.value));
const uploadFinishedSuccessfully = computed(() => currentJobs.value.length > 0 && currentJobs.value.every((job) => job.status === "completed"));
/* 全部任务结束且 OCR 全为空：原件大概率不是有效报告，需要明确告知用户而不是只发一条通知 */
const ocrEmptyWarning = computed(() => {
  if (!jobsSettled.value || failedJobs.value.length) return false;
  const ocrJobs = currentJobs.value.filter((job) => job.jobType === "ocr" && job.status === "completed");
  return ocrJobs.length > 0 && ocrJobs.every((job) => !job.ocrTextLength);
});
const accept = ".heic,.heif,.jpg,.jpeg,.png,.webp,.pdf,image/heic,image/heif,image/jpeg,image/png,image/webp,application/pdf";
const localSelectionBytes = computed(() => selectedLocalFiles.value.reduce((sum, file) => sum + file.size, 0));
const currentLocalRoot = computed(() => localRoots.value.find((root) => root.id === localCurrent.value?.rootId) || null);
const localBreadcrumbs = computed(() => {
  const segments = (localCurrent.value?.path || "").split("/").filter(Boolean);
  return segments.map((name, index) => ({ name, path: segments.slice(0, index + 1).join("/") }));
});
const deploymentCopy = computed(() => getDeploymentCopy(app.session.value?.authMode));
const canUseNasImport = computed(() => app.session.value?.authMode === "fnos" || Boolean(app.session.value?.isAdmin));
const isFnosImport = computed(() => app.session.value?.authMode === "fnos");
const fnosAuthStateKey = "health-records:fnos-file-auth";
const fnosFileExtensions = [".heic", ".heif", ".jpg", ".jpeg", ".png", ".webp", ".pdf"];

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function localPreviewUrl(entry: LocalImportEntry, variant: "thumbnail" | "large" = "thumbnail") {
  if (!localCurrent.value) return "";
  const params = new URLSearchParams({
    rootId: localCurrent.value.rootId,
    path: entry.path,
    variant
  });
  return apiUrl(`local-files/preview?${params.toString()}`);
}

function localPreviewKey(entry: LocalImportEntry) {
  return `${localCurrent.value?.rootId || ""}:${entry.path}`;
}

function localCheckboxId(entry: LocalImportEntry) {
  return `nas-file-${encodeURIComponent(localPreviewKey(entry))}`;
}

function markLocalPreviewFailed(entry: LocalImportEntry) {
  localPreviewFailed.value = new Set(localPreviewFailed.value).add(localPreviewKey(entry));
}

function openLocalPreview(entry: LocalImportEntry) {
  localLargePreviewFailed.value = false;
  localPreviewEntry.value = entry;
}

function supported(file: File) {
  return /\.(heic|heif|jpe?g|png|webp|pdf)$/i.test(file.name)
    || ["image/heic", "image/heif", "image/jpeg", "image/png", "image/webp", "application/pdf"].includes(file.type);
}

function canPreview(file: File) {
  return ["image/jpeg", "image/png", "image/webp"].includes(file.type)
    || /\.(jpe?g|png|webp)$/i.test(file.name);
}

/* crypto.randomUUID 仅在安全上下文（HTTPS/localhost）可用，HTTP 内网访问或旧浏览器会抛 TypeError，退回 getRandomValues */
function createItemId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") crypto.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

type FnosAuthorizationFlow = "directory" | "files";

function clearFnosAuthorizationQuery() {
  const url = new URL(window.location.href);
  for (const key of ["status", "error", "method", "appName", "state", "path", "paths"]) {
    url.searchParams.delete(key);
  }
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
}

async function requestFnosUserPaths(flow: FnosAuthorizationFlow) {
  const { TrimApp } = await import("@trimjs/web-app");
  const sdk = new TrimApp();
  await sdk.ready();
  const directory = flow === "directory";
  const options = {
    directory,
    ...(directory ? {} : { multiple: true, accept: fnosFileExtensions }),
    sidebarGroup: ["myFiles", "otherShare", "external", "remote", "favorites", "team"] as const,
    title: directory ? "选择报告目录" : "选择健康报告",
    okText: directory ? "授权目录" : "选择并导入"
  };
  if (!sdk.isStandaloneWeb) {
    const result = await sdk.pickUserFile(options);
    if (!result) return null;
    if (result.code !== 0) throw new Error(result.msg || "飞牛文件授权失败");
    return Array.isArray(result.data) ? result.data : [];
  }

  const state = createItemId();
  const memberId = app.selectedMemberId.value;
  sessionStorage.setItem(fnosAuthStateKey, JSON.stringify({ state, flow, memberId }));
  await sdk.openAppAuth("pickUserFile", {
    appName: app.session.value?.appName || "fnos-app-health-records",
    directory,
    ...(!directory ? { accept: fnosFileExtensions } : {}),
    sidebarGroup: [...options.sidebarGroup],
    redirectUri: window.location.pathname,
    state
  }, { target: "_self" });
  return null;
}

async function submitAuthorizedFnosPaths(paths: string[], memberId = app.selectedMemberId.value) {
  if (!paths.length) return;
  if (!memberId) throw new Error("请先选择报告所属成员");
  localImporting.value = true;
  localError.value = "";
  error.value = "";
  result.value = null;
  try {
    result.value = await request<UploadResult>("local-files/import", {
      method: "POST",
      body: JSON.stringify({ memberId, authorizedPaths: paths })
    });
    clearQueue();
    selectedLocalFiles.value = [];
    localBrowserOpen.value = false;
    startPolling();
  } finally {
    localImporting.value = false;
  }
}

async function authorizeFnosDirectory() {
  if (localAuthorizing.value) return;
  localAuthorizing.value = true;
  localError.value = "";
  try {
    const paths = await requestFnosUserPaths("directory");
    if (!paths) return;
    await openLocalBrowser();
  } catch (cause) {
    localError.value = cause instanceof Error ? cause.message : "无法打开飞牛目录授权";
  } finally {
    localAuthorizing.value = false;
  }
}

async function chooseFnosFiles() {
  if (localAuthorizing.value || localImporting.value) return;
  localAuthorizing.value = true;
  localError.value = "";
  try {
    const paths = await requestFnosUserPaths("files");
    if (!paths) return;
    await submitAuthorizedFnosPaths(paths);
  } catch (cause) {
    localError.value = cause instanceof Error ? cause.message : "从飞牛选择文件失败";
    localBrowserOpen.value = true;
  } finally {
    localAuthorizing.value = false;
  }
}

async function handleFnosAuthorizationCallback() {
  const raw = sessionStorage.getItem(fnosAuthStateKey);
  if (!raw) return;
  sessionStorage.removeItem(fnosAuthStateKey);
  try {
    const pending = JSON.parse(raw) as { state?: unknown; flow?: unknown; memberId?: unknown };
    const { TrimApp } = await import("@trimjs/web-app");
    const result = new TrimApp().parseAppAuthCallback(window.location.href);
    clearFnosAuthorizationQuery();
    if (typeof pending.state !== "string" || result.state !== pending.state) {
      throw new Error("飞牛文件授权状态校验失败，请重新选择");
    }
    if (result.status === "cancel") return;
    if (result.status !== "success" || !Array.isArray(result.path)) {
      throw new Error(result.error === "access_denied" ? "当前飞牛用户无权完成文件授权" : "飞牛文件授权失败");
    }
    if (pending.flow === "directory") {
      await openLocalBrowser();
      return;
    }
    await submitAuthorizedFnosPaths(result.path, typeof pending.memberId === "string" ? pending.memberId : "");
  } catch (cause) {
    clearFnosAuthorizationQuery();
    error.value = cause instanceof Error ? cause.message : "无法处理飞牛文件授权结果";
  }
}

function addFiles(files: File[]) {
  error.value = "";
  result.value = null;
  stopPolling();
  jobs.value = [];
  const unsupported = files.find((file) => !supported(file));
  if (unsupported) {
    error.value = `不支持文件“${unsupported.name}”的格式`;
    return;
  }
  if (items.value.length + files.length > 24) {
    error.value = "一次最多上传 24 个文件";
    return;
  }
  if (files.some((file) => file.size > 40 * 1024 * 1024)) {
    error.value = "单个文件不能超过 40 MB";
    return;
  }
  if (totalBytes.value + files.reduce((sum, file) => sum + file.size, 0) > 200 * 1024 * 1024) {
    error.value = "单次上传不能超过 200 MB";
    return;
  }
  /* 入队过程的同步异常（如旧浏览器缺失 API）必须浮现给用户，避免“选完文件毫无反应” */
  try {
    for (const file of files) {
      const duplicate = items.value.some((item) =>
        item.file.name === file.name && item.file.size === file.size && item.file.lastModified === file.lastModified
      );
      if (duplicate) continue;
      items.value.push({
        id: createItemId(),
        file,
        previewUrl: canPreview(file) ? URL.createObjectURL(file) : "",
        rotation: 0
      });
    }
  } catch (cause) {
    error.value = `添加文件失败，请重试或更换浏览器（${describeTechnical(cause)}）`;
  }
}

function pick(event: Event) {
  const input = event.target as HTMLInputElement;
  const files = Array.from(input.files || []);
  if (!files.length) {
    /* 部分 WebView（如卓易通/纯血鸿蒙容器）授权后仍可能无法直接唤起相机，返回空文件列表 */
    error.value = "未获取到照片。请检查相机权限，或尝试使用“选择文件”从相册上传。";
    return;
  }
  addFiles(files);
  input.value = "";
}

function drop(event: DragEvent) {
  dragging.value = false;
  addFiles(Array.from(event.dataTransfer?.files || []));
}

function remove(index: number) {
  const [removed] = items.value.splice(index, 1);
  if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl);
}

function move(index: number, direction: -1 | 1) {
  const target = index + direction;
  if (target < 0 || target >= items.value.length) return;
  const [item] = items.value.splice(index, 1);
  items.value.splice(target, 0, item);
}

function rotate(item: QueueItem) {
  item.rotation = (item.rotation + 90) % 360;
}

function clearQueue() {
  for (const item of items.value) if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
  items.value = [];
}

function isLocalSelected(entry: LocalImportEntry) {
  if (!localCurrent.value) return false;
  return selectedLocalFiles.value.some((file) => file.rootId === localCurrent.value?.rootId && file.path === entry.path);
}

async function loadLocalDirectory(rootId?: string, path = "") {
  localBrowserLoading.value = true;
  localError.value = "";
  try {
    const query = rootId
      ? `?rootId=${encodeURIComponent(rootId)}&path=${encodeURIComponent(path)}`
      : "";
    const response = await request<LocalBrowserResponse>(`local-files${query}`);
    localRoots.value = response.roots;
    localCurrent.value = response.current;
    localEntries.value = response.entries;
    localTruncated.value = response.truncated;
    localAvailability.value = response.availability;
  } catch (cause) {
    localError.value = cause instanceof Error ? cause.message : "无法读取 NAS 目录";
  } finally {
    localBrowserLoading.value = false;
  }
}

async function openLocalBrowser() {
  localBrowserOpen.value = true;
  localRoots.value = [];
  localCurrent.value = null;
  localEntries.value = [];
  localTruncated.value = false;
  localAvailability.value = null;
  selectedLocalFiles.value = [];
  await loadLocalDirectory();
  if (localRoots.value.length === 1) await loadLocalDirectory(localRoots.value[0]!.id);
}

function closeLocalBrowser() {
  if (localImporting.value) return;
  localPreviewEntry.value = null;
  localBrowserOpen.value = false;
  localError.value = "";
}

function chooseLocalRoot(root: LocalImportRoot) {
  void loadLocalDirectory(root.id);
}

function openLocalDirectory(entry: LocalImportEntry) {
  if (!localCurrent.value || entry.type !== "directory") return;
  void loadLocalDirectory(localCurrent.value.rootId, entry.path);
}

function toggleLocalFile(entry: LocalImportEntry) {
  if (!localCurrent.value || entry.type !== "file") return;
  localError.value = "";
  const index = selectedLocalFiles.value.findIndex((file) =>
    file.rootId === localCurrent.value?.rootId && file.path === entry.path
  );
  if (index >= 0) {
    selectedLocalFiles.value.splice(index, 1);
    return;
  }
  if (selectedLocalFiles.value.length >= 24) {
    localError.value = "一次最多导入 24 个文件";
    return;
  }
  if ((entry.size || 0) > 40 * 1024 * 1024) {
    localError.value = "单个文件不能超过 40 MB";
    return;
  }
  if (localSelectionBytes.value + (entry.size || 0) > 200 * 1024 * 1024) {
    localError.value = "单次导入不能超过 200 MB";
    return;
  }
  selectedLocalFiles.value.push({
    rootId: localCurrent.value.rootId,
    path: entry.path,
    name: entry.name,
    size: entry.size || 0
  });
}

async function submitLocalImport() {
  if (!selectedLocalFiles.value.length || !app.selectedMemberId.value) return;
  localImporting.value = true;
  localError.value = "";
  error.value = "";
  result.value = null;
  try {
    result.value = await request<UploadResult>("local-files/import", {
      method: "POST",
      body: JSON.stringify({
        memberId: app.selectedMemberId.value,
        files: selectedLocalFiles.value.map(({ rootId, path }) => ({ rootId, path }))
      })
    });
    clearQueue();
    selectedLocalFiles.value = [];
    localBrowserOpen.value = false;
    startPolling();
  } catch (cause) {
    localError.value = cause instanceof Error ? cause.message : "从 NAS 导入失败";
  } finally {
    localImporting.value = false;
  }
}

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

function clearFinishedUpload() {
  stopPolling();
  result.value = null;
  jobs.value = [];
  error.value = "";
}

function jobLabel(jobType: ProcessingJob["jobType"]) {
  return { pdf_extract: "PDF 拆页", thumbnail: "生成缩略图", ocr: "文字识别", ai_extract: "AI 整理" }[jobType];
}

async function refreshJobs(includeRuntime = false) {
  if (!result.value) return;
  const reportId = result.value.reportId;
  try {
    /* OCR 运行状态仅在提交后首次刷新时查询，轮询周期内不再重复请求 */
    const [nextJobs, ocr] = await Promise.all([
      request<ProcessingJob[]>(`jobs?reportId=${encodeURIComponent(reportId)}`),
      includeRuntime && app.session.value?.isAdmin ? request<{ available: boolean }>("ocr/status") : Promise.resolve(null)
    ]);
    if (result.value?.reportId !== reportId) return;
    jobs.value = nextJobs;
    if (ocr) runtimeAvailable.value = ocr.available;
    const nextCurrentJobs = groupProcessingJobBatches(nextJobs).currentJobs;
    if (nextCurrentJobs.some((job) => job.status === "cancelled")) {
      app.notifyDataChanged();
      clearFinishedUpload();
      return;
    }
    if (isProcessingJobBatchSettled(nextCurrentJobs)) {
      stopPolling();
      app.notifyDataChanged();
    }
  } catch (cause) {
    if (result.value?.reportId !== reportId) return;
    const message = cause instanceof Error ? cause.message : "无法获取任务状态";
    /* 已永久删除的历史上传不再是待处理任务，清掉缓存面板即可。 */
    if (message.includes("报告不存在") && message.includes("HTTP 404")) {
      clearFinishedUpload();
      return;
    }
    error.value = message;
    stopPolling();
  }
}

function startPolling() {
  stopPolling();
  void refreshJobs(true);
  pollTimer = setInterval(() => { void refreshJobs(); }, 2500);
}

async function retryJob(job: ProcessingJob) {
  try {
    await request(`jobs/${job.id}/retry`, { method: "POST" });
    await refreshJobs();
    startPolling();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "任务重试失败";
  }
}

async function submit() {
  if (!items.value.length) return;
  if (!app.selectedMemberId.value) {
    error.value = "请先选择报告所属成员";
    return;
  }
  uploading.value = true;
  error.value = "";
  result.value = null;
  try {
    const body = new FormData();
    body.append("memberId", app.selectedMemberId.value);
    body.append("manifest", JSON.stringify({ pages: items.value.map((item) => ({ rotation: item.rotation })) }));
    for (const item of items.value) body.append("files", item.file, item.file.name);
    result.value = await requestUpload<UploadResult>("uploads", body);
    clearQueue();
    startPolling();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "上传失败";
  } finally {
    uploading.value = false;
  }
}

onBeforeUnmount(() => {
  clearQueue();
  stopPolling();
});
onMounted(() => {
  if (isFnosImport.value) void handleFnosAuthorizationCallback();
});
/* 已完成的上传只在当前停留期间保留结果；离开后回到干净的上传工作台。失败任务继续保留以便重试。 */
onDeactivated(() => {
  if (uploadFinishedSuccessfully.value || cancelledJobs.value) clearFinishedUpload();
});
/* 任务未跑完时后台（KeepAlive 失活）也保持轮询，完成后广播数据变更；回到页面时补一次刷新 */
onActivated(() => {
  if (!result.value) return;
  if (uploadFinishedSuccessfully.value || cancelledJobs.value) {
    clearFinishedUpload();
    return;
  }
  startPolling();
});
</script>

<template>
  <section class="plain-page upload-page">
    <div class="page-intro">
      <div><h2>上传健康报告</h2><p>保存到 {{ app.selectedMember.value?.displayName || "当前成员" }} 的档案，多张图片会合并为同一份报告</p></div>
      <span v-if="items.length" class="count-label">{{ items.length }} 个文件 · {{ formatBytes(totalBytes) }}</span>
    </div>

    <div
      class="drop-zone"
      :class="{ dragging }"
      @dragenter.prevent="dragging = true"
      @dragover.prevent="dragging = true"
      @dragleave.prevent="dragging = false"
      @drop.prevent="drop"
    >
      <span class="drop-icon"><ImagePlus :size="30" /></span>
      <strong>拖放报告到这里</strong>
      <span class="drop-hint">HEIC、JPEG、PNG、WebP 或多页 PDF，按下方顺序识别为一份报告</span>
      <div class="drop-actions">
        <label class="primary-button file-button upload-picker">
          <UploadCloud :size="18" /><span>选择文件</span>
          <input type="file" :accept="accept" multiple aria-label="选择报告文件" @change="pick" />
        </label>
        <label class="camera-button upload-picker">
          <Camera :size="18" /><span>拍照</span>
          <input type="file" accept="image/*" capture="environment" aria-label="拍摄报告照片" @change="pick" />
        </label>
        <button v-if="canUseNasImport" class="nas-import-button" type="button" @click="openLocalBrowser">
          <HardDrive :size="18" /><span>从 NAS 导入</span>
        </button>
      </div>
    </div>

    <p v-if="error" class="upload-error">{{ error }}</p>
    <div v-if="result" class="upload-success">
      <CheckCircle2 :size="22" />
      <div><strong>报告已进入处理队列</strong><span>{{ result.pageCount }} 个原件，{{ result.jobCount }} 个初始任务，AI 整理后自动命名</span></div>
      <RouterLink to="/records">查看档案</RouterLink>
    </div>

    <section v-if="result" class="job-progress" aria-live="polite">
      <div class="job-progress-summary">
        <div>
          <strong>后台处理</strong>
          <span v-if="currentJobs.length">已完成 {{ finishedJobs }} / {{ currentJobs.length }}</span>
          <span v-else>正在读取任务状态</span>
        </div>
        <span v-if="currentJobs.length">{{ progressPercent }}%</span>
      </div>
      <div class="job-progress-bar" role="progressbar" :aria-valuenow="progressPercent" aria-valuemin="0" aria-valuemax="100">
        <span :style="{ width: `${progressPercent}%` }"></span>
      </div>
      <div v-if="!runtimeAvailable" class="runtime-warning">
        <CircleAlert :size="18" />
        <div><strong>等待安装本地 OCR 环境</strong><span>{{ app.session.value?.isAdmin ? "原件已安全保存，安装后任务会自动继续。" : `原件已安全保存，请联系${deploymentCopy.administrator}安装 OCR 环境。` }}</span></div>
        <RouterLink v-if="app.session.value?.isAdmin" to="/me/runtime">前往运行与识别</RouterLink>
      </div>
      <div v-if="ocrEmptyWarning" class="runtime-warning">
        <CircleAlert :size="18" />
        <div><strong>没有识别到任何文字</strong><span>上传的原件上没有可识别的文字内容，可能不是有效的体检报告。请确认照片清晰、完整包含报告文字后重新上传，或在档案详情中手动录入。</span></div>
        <RouterLink to="/records">查看档案</RouterLink>
      </div>
      <div v-if="failedJobs.length" class="failed-job-list">
        <article v-for="job in failedJobs" :key="job.id">
          <CircleAlert :size="18" />
          <div><strong>{{ jobLabel(job.jobType) }}失败</strong><span>{{ job.errorMessage || "任务执行失败" }}</span></div>
          <button type="button" title="重试任务" @click="retryJob(job)"><RefreshCw :size="17" />重试</button>
        </article>
      </div>
    </section>

    <div v-if="items.length" class="upload-pages">
      <article v-for="(item, index) in items" :key="item.id" class="upload-page-item">
        <div class="page-thumbnail">
          <img v-if="item.previewUrl" :src="item.previewUrl" alt="" :style="{ transform: `rotate(${item.rotation}deg)` }" />
          <FileText v-else-if="item.file.type === 'application/pdf' || /\.pdf$/i.test(item.file.name)" :size="28" />
          <FileImage v-else :size="28" />
          <span>{{ index + 1 }}</span>
        </div>
        <div class="upload-page-info"><strong>{{ item.file.name }}</strong><span>{{ formatBytes(item.file.size) }}<template v-if="item.rotation"> · 旋转 {{ item.rotation }}°</template></span></div>
        <div class="upload-page-actions">
          <button type="button" title="向上移动" :disabled="index === 0" @click="move(index, -1)"><ArrowUp :size="17" /></button>
          <button type="button" title="向下移动" :disabled="index === items.length - 1" @click="move(index, 1)"><ArrowDown :size="17" /></button>
          <button type="button" title="顺时针旋转" @click="rotate(item)"><RotateCw :size="17" /></button>
          <button class="danger-action" type="button" title="移除" @click="remove(index)"><X :size="18" /></button>
        </div>
      </article>
      <div class="upload-submit">
        <span>{{ items.length }} 个文件 · {{ formatBytes(totalBytes) }}，提交后离开页面仍会继续处理</span>
        <button class="primary-button" type="button" :disabled="uploading" @click="submit">
          <LoaderCircle v-if="uploading" class="spin-icon" :size="18" />
          <UploadCloud v-else :size="18" />
          {{ uploading ? "正在保存" : "保存并开始识别" }}
        </button>
      </div>
    </div>

    <Teleport to="body">
      <div v-if="localBrowserOpen" class="modal-backdrop local-file-backdrop" @click.self="closeLocalBrowser">
        <section class="modal-panel local-file-modal" role="dialog" aria-modal="true" aria-labelledby="local-file-title">
          <header>
            <div><FolderOpen :size="20" /><h3 id="local-file-title">从 NAS 导入报告</h3></div>
            <button type="button" title="关闭" :disabled="localImporting" @click="closeLocalBrowser"><X :size="20" /></button>
          </header>

          <div v-if="isFnosImport" class="local-file-auth-actions">
            <button type="button" :disabled="localAuthorizing || localImporting" @click="chooseFnosFiles">
              <LoaderCircle v-if="localAuthorizing" class="spin-icon" :size="16" />
              <UploadCloud v-else :size="16" />
              直接选择文件
            </button>
            <button type="button" :disabled="localAuthorizing || localImporting" @click="authorizeFnosDirectory">
              <FolderOpen :size="16" />授权其他目录
            </button>
          </div>

          <div class="local-file-browser">
            <div v-if="localCurrent" class="local-file-toolbar">
              <nav aria-label="当前目录">
                <button type="button" @click="loadLocalDirectory(localCurrent.rootId)">{{ currentLocalRoot?.label || "授权目录" }}</button>
                <template v-for="crumb in localBreadcrumbs" :key="crumb.path">
                  <ChevronRight :size="14" />
                  <button type="button" @click="loadLocalDirectory(localCurrent.rootId, crumb.path)">{{ crumb.name }}</button>
                </template>
              </nav>
              <button v-if="localRoots.length > 1" type="button" @click="loadLocalDirectory()">切换目录</button>
            </div>

            <div v-if="localBrowserLoading" class="local-file-empty"><LoaderCircle class="spin-icon" :size="24" /><span>正在读取目录</span></div>
            <div v-else-if="localError && !localRoots.length" class="local-file-empty is-error"><CircleAlert :size="24" /><span>{{ localError }}</span></div>
            <div v-else-if="!localCurrent && !localRoots.length" class="local-file-empty">
              <HardDrive :size="28" />
              <strong>{{ isFnosImport ? "还没有可浏览的授权目录" : localAvailability?.state === "unavailable" ? "授权目录当前不可读取" : deploymentCopy.importEmptyTitle }}</strong>
              <span>{{ localAvailability?.message || (isFnosImport ? "可在上方直接选择报告文件，或授权一个目录后浏览和预览。" : deploymentCopy.importEmptyDescription) }}</span>
              <button class="soft-action-button" type="button" title="重新检测授权目录" @click="loadLocalDirectory()">
                <RefreshCw :size="16" /><span>重新检测</span>
              </button>
            </div>
            <div v-else-if="!localCurrent" class="local-root-list">
              <button v-for="root in localRoots" :key="root.id" type="button" @click="chooseLocalRoot(root)">
                <HardDrive :size="21" /><span><strong>{{ root.label }}</strong><small>{{ root.path }}</small></span><ChevronRight :size="18" />
              </button>
            </div>
            <div v-else-if="!localEntries.length" class="local-file-empty"><Folder :size="26" /><span>此目录中没有支持的报告文件</span></div>
            <div v-else class="local-entry-list">
              <template v-for="entry in localEntries" :key="entry.path">
                <button v-if="entry.type === 'directory'" class="local-entry is-directory" type="button" @click="openLocalDirectory(entry)">
                  <Folder :size="20" /><span><strong>{{ entry.name }}</strong><small>文件夹</small></span><ChevronRight :size="17" />
                </button>
                <div v-else class="local-entry" :class="{ 'is-selected': isLocalSelected(entry) }">
                  <input :id="localCheckboxId(entry)" type="checkbox" :checked="isLocalSelected(entry)" @change="toggleLocalFile(entry)" />
                  <button
                    class="local-entry-thumbnail"
                    type="button"
                    :title="`预览 ${entry.name}`"
                    :aria-label="`预览 ${entry.name}`"
                    @click.prevent.stop="openLocalPreview(entry)"
                  >
                    <img
                      v-if="!localPreviewFailed.has(localPreviewKey(entry))"
                      :src="localPreviewUrl(entry)"
                      alt=""
                      loading="lazy"
                      decoding="async"
                      @error="markLocalPreviewFailed(entry)"
                    />
                    <FileText v-else-if="/\.pdf$/i.test(entry.name)" :size="20" />
                    <FileImage v-else :size="20" />
                    <small v-if="/\.pdf$/i.test(entry.name)">PDF</small>
                  </button>
                  <label :for="localCheckboxId(entry)"><strong>{{ entry.name }}</strong><small>{{ formatBytes(entry.size || 0) }}</small></label>
                </div>
              </template>
              <p v-if="localTruncated" class="local-file-limit">目录内容较多，仅显示前 500 项，请进入更具体的子目录。</p>
            </div>
          </div>

          <p v-if="(localError || localAvailability?.message) && localRoots.length" class="local-file-error">{{ localError || localAvailability?.message }}</p>
          <footer class="local-file-footer">
            <span>已选 {{ selectedLocalFiles.length }} 个文件<template v-if="selectedLocalFiles.length"> · {{ formatBytes(localSelectionBytes) }}</template></span>
            <button class="primary-button" type="button" :disabled="!selectedLocalFiles.length || localImporting" @click="submitLocalImport">
              <LoaderCircle v-if="localImporting" class="spin-icon" :size="18" />
              <HardDrive v-else :size="18" />
              {{ localImporting ? "正在导入" : "导入并开始识别" }}
            </button>
          </footer>
        </section>
      </div>
    </Teleport>

    <Teleport to="body">
      <div v-if="localPreviewEntry" class="modal-backdrop local-preview-backdrop" @click.self="localPreviewEntry = null">
        <section class="modal-panel local-preview-modal" role="dialog" aria-modal="true" aria-labelledby="local-preview-title">
          <header>
            <div><FileText v-if="/\.pdf$/i.test(localPreviewEntry.name)" :size="20" /><FileImage v-else :size="20" /><h3 id="local-preview-title">{{ localPreviewEntry.name }}</h3></div>
            <button type="button" title="关闭预览" @click="localPreviewEntry = null"><X :size="20" /></button>
          </header>
          <div class="local-preview-stage">
            <img
              v-if="!localLargePreviewFailed"
              :src="localPreviewUrl(localPreviewEntry, 'large')"
              :alt="`${localPreviewEntry.name} 预览`"
              @error="localLargePreviewFailed = true"
            />
            <div v-else class="local-preview-error">
              <CircleAlert :size="28" />
              <strong>暂时无法生成预览</strong>
              <span>文件仍可正常选择并导入，请稍后重试。</span>
            </div>
          </div>
          <p v-if="/\.pdf$/i.test(localPreviewEntry.name)" class="local-preview-note">PDF 显示第一页，导入后可查看完整报告。</p>
        </section>
      </div>
    </Teleport>
  </section>
</template>
