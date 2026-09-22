<script setup lang="ts">
import {
  computed,
  onBeforeUnmount,
  onMounted,
  onActivated,
  onDeactivated,
  ref,
  watch,
  nextTick,
} from "vue";
import {
  Plus,
  CheckCircle2,
  CircleAlert,
  ImagePlus,
  UploadCloud,
  HardDrive,
  Camera,
  FolderOpen,
  ArrowUp,
  ArrowDown,
  RotateCw,
  X,
  LoaderCircle,
} from "@lucide/vue";
import { apiUrl, request, requestUpload, ApiRequestError } from "../utils/api";
import { useAppContext } from "../composables/useAppContext";
import { maxUploadFileBytes } from "../../../shared/upload-limits";
import { useScrollLock } from "../composables/useScrollLock";
const props = defineProps<{
  reportId: string;
  oldPageCount: number;
  reportTitle?: string;
  memberName?: string;
  busy?: boolean;
}>();
const emit = defineEmits<{ updated: []; stateChanged: [state: string] }>();
type Page = {
  id: string;
  name: string;
  fileId: string;
  sourcePageNumber: number;
  rotation: number;
  position: number | null;
  duplicate: boolean;
  hasPreview: boolean;
  ocrComplete: boolean;
};
type Batch = {
  id: string;
  state: string;
  phase: string;
  aiProgress?: { total: number; completed: number } | null;
  published: boolean;
  error: string | null;
  conflicts: string[];
  reviewWarnings?: string[];
  files: Array<{
    id: string;
    name: string;
    size: number;
    received: boolean;
    pageCount: number | null;
    error?: string | null;
  }>;
  pages: Page[];
};
type Directory = {
  roots: Array<{ id: string; label: string }>;
  current: { rootId: string; path: string } | null;
  entries: Array<{
    name: string;
    path: string;
    type: "file" | "directory";
    size: number | null;
  }>;
  availability: { message: string | null };
};
const app = useAppContext(),
  open = ref(false),
  batch = ref<Batch | null>(null),
  error = ref(""),
  working = ref(false),
  localFiles = ref<File[]>([]),
  selected = ref<Array<{ id: string; rotation: number }>>([]),
  percent = ref<Record<string, number>>({});
const drawer = ref<HTMLElement>();
const trigger = ref<HTMLButtonElement>();
useScrollLock(open);
watch(open, async (value) => {
  await nextTick();
  if (value) drawer.value?.focus();
  else trigger.value?.focus();
});
function drawerKeydown(event: KeyboardEvent) {
  if (!open.value) return;
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopImmediatePropagation();
    open.value = false;
  } else if (event.key === "Tab") {
    const elements = Array.from(
      drawer.value?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled):not([hidden]), [href], [tabindex="0"]',
      ) || [],
    );
    const first = elements[0],
      last = elements.at(-1);
    if (!first) {
      event.preventDefault();
      return;
    }
    if (
      event.shiftKey &&
      (document.activeElement === first ||
        document.activeElement === drawer.value)
    ) {
      event.preventDefault();
      last?.focus();
    } else if (
      !event.shiftKey &&
      (document.activeElement === last ||
        document.activeElement === drawer.value)
    ) {
      event.preventDefault();
      first.focus();
    }
  }
}
const resumeInput = ref<HTMLInputElement>();
let dismissedBatchId = "";
const directory = ref<Directory | null>(null),
  nasSelection = ref<Array<{ rootId: string; path: string; name: string }>>([]);
const canUseNasImport = computed(
  () =>
    app.session.value?.authMode === "fnos" ||
    Boolean(app.session.value?.isAdmin),
);
const endpoint = `reports/${encodeURIComponent(props.reportId)}/page-appends`;
const key = ref(crypto.randomUUID()),
  finished = computed(() =>
    Boolean(
      batch.value &&
      ["complete", "ocr_only", "noop", "cancelled"].includes(batch.value.state),
    ),
  );
const labels: Record<string, string> = {
  uploading: "等待上传文件",
  preparing: "正在读取文件并生成预览",
  ready: "请选择补充页面",
  ocr: "正在识别新增页面",
  review: "需要核对补充页面",
  ai: "正在结合整份报告重新整理",
  complete: "补充与识别完成",
  normalizing: "正在更新指标索引",
  ocr_only: "原件和 OCR 已保存，尚未更新 AI 结果",
  noop: "没有新增页面，报告未改变",
  failed: "处理未完成，旧结果已保留",
  cancelled: "已放弃本批次",
};
const processing = computed(() =>
  Boolean(
    batch.value &&
    ["preparing", "ocr", "ai", "normalizing"].includes(batch.value.state),
  ),
);
const needsAttention = computed(() =>
  Boolean(
    batch.value &&
    (["failed", "review", "ocr_only"].includes(batch.value.state) ||
      batch.value.reviewWarnings?.length),
  ),
);
const triggerLabel = computed(() => {
  if (working.value)
    return batch.value?.state === "uploading" || !batch.value
      ? "补页 · 上传中"
      : "补页 · 提交中";
  if (!batch.value)
    return localFiles.value.length ? "补页 · 待上传" : "补充报告页";
  const states: Record<string, string> = {
    uploading: "待上传",
    preparing: "准备中",
    ready: "待提交",
    ocr: "OCR中",
    review: "待核对",
    ai: "AI整理中",
    normalizing: "保存中",
    complete: batch.value.reviewWarnings?.length ? "待核对" : "已完成",
    failed: "需重试",
    ocr_only: "待AI整理",
    noop: "无新增",
  };
  return states[batch.value.state]
    ? `补页 · ${states[batch.value.state]}`
    : "补充报告页";
});
const steps = ["准备页面", "识别文字", "AI 整理", "完成"];
const currentStep = computed(() => {
  const state = batch.value?.state;
  if (state === "complete" || state === "noop") return 3;
  if (["ai", "normalizing", "ocr_only"].includes(state || "")) return 2;
  if (["ocr", "review"].includes(state || "")) return 1;
  if (state === "failed")
    return batch.value?.phase === "ai"
      ? 2
      : batch.value?.phase === "ocr"
        ? 1
        : 0;
  return 0;
});
const stageDetail = computed(() => {
  const b = batch.value;
  if (!b) return "";
  if (b.state === "ocr") {
    const pages = b.pages.filter((p) => p.position !== null && !p.duplicate);
    return `已识别 ${pages.filter((p) => p.ocrComplete).length} / ${pages.length} 个补充页面，完成后自动进入 AI 整理。`;
  }
  if (b.state === "ai") {
    const p = b.aiProgress;
    return p?.total
      ? p.completed < p.total
        ? `AI 已处理 ${p.completed} / ${p.total} 组内容，正在结合整份报告整理指标。`
        : "AI 内容处理完成，正在校验并保存整理结果。"
      : "原件与文字识别结果已保存，正在准备 AI 整理。";
  }
  if (b.state === "normalizing")
    return "正在保存整理结果，完成后报告指标会自动更新。";
  if (b.state === "ready")
    return "页面已准备好。确认勾选后点击“补充并识别”，才会加入当前报告并开始整理。";
  if (b.state === "review")
    return "新页面尚未加入报告，请先核对疑点并确认继续。";
  if (b.state === "complete")
    return b.reviewWarnings?.length
      ? "页面已加入报告，可信指标已保存；以下内容仍需对照原件核对。"
      : "补充页面与整理结果均已保存，报告指标已自动更新。";
  if (b.state === "ocr_only")
    return "页面已加入报告，但 AI 整理尚未完成，当前指标仍是上一版。";
  if (b.state === "failed")
    return b.published
      ? "页面已加入报告，整理尚未完成。已保存的指标不受影响，可重试继续。"
      : "处理尚未完成，补充页面还未加入报告，可重试继续。";
  if (b.state === "preparing")
    return "正在生成页面预览，接下来可勾选、排序和旋转。";
  if (b.state === "uploading")
    return "文件上传后会生成预览，确认选页后再开始识别。";
  return "";
});
const selectablePages = computed(() => {
  const pages = batch.value?.pages || [];
  if (batch.value?.state === "review")
    return pages.filter((p) => p.position !== null && !p.duplicate);
  return [
    ...selected.value
      .map((s) => pages.find((p) => p.id === s.id)!)
      .filter(Boolean),
    ...pages.filter((p) => !selected.value.some((s) => s.id === p.id)),
  ];
});
function rotatePage(id: string) {
  const item = selected.value.find((s) => s.id === id);
  if (item) item.rotation = (item.rotation + 90) % 360;
}
const total = computed(
  () => batch.value?.files.reduce((sum, f) => sum + (f.pageCount || 0), 0) || 0,
);
let timer: ReturnType<typeof setTimeout> | undefined,
  alive = true,
  active = true,
  sequence = 0;
let controller = new AbortController();
function accept(next: Batch | null) {
  if (!alive || !active || next?.id === dismissedBatchId) return;
  const before = batch.value;
  batch.value = next;
  if (
    next &&
    ["ready", "review"].includes(next.state) &&
    (before?.state !== next.state || before.id !== next.id)
  )
    selected.value = next.pages
      .filter(
        (p) => next.state !== "review" || (p.position !== null && !p.duplicate),
      )
      .map((p) => ({
        id: p.id,
        rotation: p.rotation,
      }));
  if (
    before &&
    ((next?.published && !before.published) ||
      (next?.state === "complete" && before.state !== "complete"))
  )
    emit("updated");
  if (
    next &&
    (before?.id !== next.id ||
      before.state !== next.state ||
      before.published !== next.published) &&
    (before || !finished.value)
  ) {
    emit(
      "stateChanged",
      next.state === "complete" && next.reviewWarnings?.length
        ? "complete_review"
        : next.state,
    );
  }
  clearTimeout(timer);
  if (next && !finished.value) timer = setTimeout(reload, 3000);
}
async function reload() {
  if (!alive || !active) return;
  if (working.value) {
    timer = setTimeout(reload, 3000);
    return;
  }
  const expected = sequence;
  try {
    const next = await request<Batch | null>(endpoint, {
      signal: controller.signal,
    });
    if (expected === sequence) accept(next);
  } catch (cause) {
    if (alive) {
      error.value = cause instanceof Error ? cause.message : "无法读取补充进度";
      if (
        cause instanceof ApiRequestError &&
        [401, 403, 404].includes(cause.status)
      ) {
        batch.value = null;
        open.value = false;
        return;
      }
    }
  }
  if (alive && active && batch.value && !finished.value) {
    clearTimeout(timer);
    timer = setTimeout(reload, 3000);
  }
}
onMounted(() => {
  document.addEventListener("keydown", drawerKeydown, true);
  void reload();
});
onDeactivated(() => {
  open.value = false;
  active = false;
  sequence++;
  controller.abort();
  clearTimeout(timer);
});
onActivated(() => {
  if (!active) {
    active = true;
    controller = new AbortController();
    void reload();
  }
});
onBeforeUnmount(() => {
  document.removeEventListener("keydown", drawerKeydown, true);
  alive = false;
  controller.abort();
  clearTimeout(timer);
});
async function perform(action: () => Promise<void>) {
  if (working.value) return;
  sequence++;
  working.value = true;
  error.value = "";
  try {
    await action();
  } catch (cause) {
    if (alive)
      error.value = cause instanceof Error ? cause.message : "操作失败，请重试";
  } finally {
    sequence++;
    if (alive) working.value = false;
  }
}
function addFiles(incoming: File[]) {
  if (batch.value && !finished.value) return;
  if (incoming.some((f) => !f.size || f.size > maxUploadFileBytes)) {
    error.value = "单个文件不能为空或超过 40 MB";
    return;
  }
  const next = [...localFiles.value, ...incoming];
  if (
    next.length > 1000 ||
    next.reduce((sum, f) => sum + f.size, 0) > 2 * 1024 ** 3
  ) {
    error.value = "单批最多 1000 个文件、总计 2 GB";
    return;
  }
  localFiles.value = next;
  error.value = "";
}
function picked(event: Event) {
  const input = event.target as HTMLInputElement;
  addFiles(Array.from(input.files || []));
  input.value = "";
}
function resumePicked(event: Event) {
  const input = event.target as HTMLInputElement;
  localFiles.value = Array.from(input.files || []);
  input.value = "";
  void upload();
}
function dropped(event: DragEvent) {
  addFiles(Array.from(event.dataTransfer?.files || []));
}
async function upload() {
  await perform(async () => {
    if (!batch.value || finished.value) {
      accept(
        await request<Batch>(endpoint, {
          method: "POST",
          body: JSON.stringify({
            requestKey: key.value,
            files: localFiles.value.map((f) => ({
              name: f.name,
              size: f.size,
            })),
          }),
        }),
      );
    }
    const b = batch.value!;
    if (b.files.length !== localFiles.value.length)
      throw new Error("请重新选择与原批次顺序、大小一致的文件，或放弃本批次");
    for (let i = 0; i < b.files.length; i++) {
      if (!alive || !active) return;
      const f = b.files[i]!;
      if (f.received) continue;
      const data = new FormData();
      data.append("file", localFiles.value[i]!);
      accept(
        await requestUpload<Batch>(
          `${endpoint}/${b.id}/files/${f.id}`,
          data,
          (value) => {
            if (alive) percent.value[f.id] = value;
          },
        ),
      );
    }
  });
}
async function retryFile(fileId: string) {
  await perform(async () => {
    const current = batch.value!;
    const index = current.files.findIndex((file) => file.id === fileId);
    const file = localFiles.value[index];
    if (!file) throw new Error("请重新选择本批次的原文件后重试");
    const body = new FormData();
    body.append("file", file);
    accept(
      await requestUpload<Batch>(
        `${endpoint}/${current.id}/files/${fileId}`,
        body,
        (value) => {
          if (alive) percent.value[fileId] = value;
        },
      ),
    );
  });
}
function toggle(id: string) {
  const i = selected.value.findIndex((p) => p.id === id);
  if (i >= 0) selected.value.splice(i, 1);
  else selected.value.push({ id, rotation: 0 });
}
function move(index: number, offset: number) {
  const target = index + offset;
  if (target < 0 || target >= selected.value.length) return;
  const p = selected.value.splice(index, 1)[0]!;
  selected.value.splice(target, 0, p);
}
async function action(name: string, body: unknown = {}) {
  await perform(async () => {
    accept(
      await request<Batch>(`${endpoint}/${batch.value!.id}/${name}`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    );
  });
}
async function discard() {
  await perform(async () => {
    await request(`${endpoint}/${batch.value!.id}`, { method: "DELETE" });
    batch.value = null;
    emit("stateChanged", "");
    localFiles.value = [];
    selected.value = [];
    key.value = crypto.randomUUID();
  });
}
function newBatch() {
  dismissedBatchId = batch.value?.id || "";
  batch.value = null;
  emit("stateChanged", "");
  localFiles.value = [];
  selected.value = [];
  key.value = crypto.randomUUID();
}
async function browse(rootId = "", path = "") {
  await perform(async () => {
    directory.value = await request<Directory>(
      `local-files${rootId ? `?rootId=${encodeURIComponent(rootId)}&path=${encodeURIComponent(path)}` : ""}`,
    );
  });
}
function toggleNas(path: string, name: string) {
  const rootId = directory.value?.current?.rootId;
  if (!rootId) return;
  const index = nasSelection.value.findIndex(
    (f) => f.rootId === rootId && f.path === path,
  );
  if (index < 0) nasSelection.value.push({ rootId, path, name });
  else nasSelection.value.splice(index, 1);
}
async function importNas() {
  await perform(async () => {
    accept(
      await request<Batch>(`${endpoint}/import`, {
        method: "POST",
        body: JSON.stringify({
          requestKey: key.value,
          files: nasSelection.value,
        }),
      }),
    );
    directory.value = null;
  });
}
</script>
<template>
  <div class="report-page-append">
    <button
      type="button"
      ref="trigger"
      class="soft-action-button"
      :aria-label="`补充报告页：${triggerLabel}`"
      :class="{
        'append-trigger-active': processing || working,
        'append-trigger-attention': needsAttention,
      }"
      aria-haspopup="dialog"
      :aria-expanded="open"
      :disabled="busy && !batch"
      @click="
        open = !open;
        open && reload();
      "
    >
      <LoaderCircle v-if="processing || working" :size="15" class="spin-icon" />
      <CircleAlert v-else-if="needsAttention" :size="15" />
      <CheckCircle2 v-else-if="batch?.state === 'complete'" :size="15" />
      <Plus v-else :size="15" />{{ triggerLabel }}
    </button>
    <p v-if="busy && !batch" class="append-muted">
      报告正在处理中，完成后可补充。
    </p>
    <Teleport to="body">
      <div
        v-if="open"
        class="sheet-backdrop append-backdrop"
        @click.self="open = false"
      >
        <section
          ref="drawer"
          tabindex="-1"
          role="dialog"
          aria-modal="true"
          class="sheet-panel append-panel"
          aria-label="补充报告页"
          @dragover.prevent
          @drop.prevent="dropped"
        >
          <header class="sheet-header append-header">
            <div>
              <h4>补充报告页</h4>
              <p v-if="reportTitle || memberName">
                {{ reportTitle }} · {{ memberName }}
              </p>
            </div>
            <button
              type="button"
              class="icon-button"
              aria-label="关闭补充报告页"
              @click="open = false"
            >
              <X :size="18" />
            </button>
          </header>
          <div class="append-body">
            <p class="append-muted">
              将页面补充到当前报告（已有
              {{ oldPageCount }}
              页）。仅用于同一份报告的漏页，不同日期或检查批次请单独上传。
            </p>
            <p v-if="error" role="alert" class="append-error">{{ error }}</p>
            <template v-if="!batch">
              <div class="drop-zone">
                <span class="drop-icon"><ImagePlus :size="30" /></span>
                <strong>拖放报告页到这里</strong>
                <span class="drop-hint"
                  >HEIC、JPEG、PNG、WebP 或多页 PDF，每个文件最多 40 MB</span
                >
                <div class="drop-actions">
                  <label class="primary-button file-button upload-picker">
                    <UploadCloud :size="18" /><span>选择文件</span>
                    <input
                      type="file"
                      multiple
                      :disabled="working"
                      accept="image/jpeg,image/png,image/webp,image/heic,.heif,application/pdf"
                      aria-label="选择补充报告文件"
                      @change="picked"
                    />
                  </label>
                  <label class="camera-button upload-picker">
                    <Camera :size="18" /><span>拍照</span>
                    <input
                      type="file"
                      :disabled="working"
                      accept="image/*"
                      capture="environment"
                      aria-label="拍摄补充报告照片"
                      @change="picked"
                    />
                  </label>
                  <button
                    v-if="canUseNasImport"
                    class="nas-import-button"
                    type="button"
                    :disabled="working"
                    @click="browse()"
                  >
                    <HardDrive :size="18" /><span>从 NAS 导入</span>
                  </button>
                </div>
              </div>
              <ol class="append-file-list">
                <li v-for="(file, index) in localFiles" :key="index">
                  <span :title="file.name">{{ file.name }}</span
                  ><button
                    type="button"
                    aria-label="移除文件"
                    :disabled="working"
                    @click="localFiles.splice(index, 1)"
                  >
                    <X :size="14" />
                  </button>
                </li>
              </ol>
              <button
                v-if="localFiles.length"
                type="button"
                class="primary-button"
                :disabled="working"
                @click="upload"
              >
                <LoaderCircle v-if="working" :size="16" class="spin-icon" />{{
                  working
                    ? "正在上传…"
                    : `上传 ${localFiles.length} 个文件并预览`
                }}
              </button>
            </template>
            <div v-if="directory" class="append-browser">
              <div
                v-if="!directory.roots.length"
                class="append-nas-empty"
                role="status"
              >
                <div class="append-nas-empty-heading">
                  <strong><FolderOpen :size="16" />暂无可导入目录</strong>
                  <button
                    type="button"
                    class="append-nas-retry"
                    :disabled="working"
                    aria-label="重新读取目录"
                    @click="browse()"
                  >
                    <RotateCw
                      :size="14"
                      :class="{ 'spin-icon': working }"
                    />重新读取目录
                  </button>
                </div>
                <p>可先选择本地文件，或配置目录后重试。</p>
                <details
                  v-if="directory.availability.message"
                  class="append-nas-details"
                >
                  <summary>查看配置说明</summary>
                  <p>{{ directory.availability.message }}</p>
                </details>
              </div>
              <p
                v-else-if="directory.availability.message"
                class="append-muted"
              >
                {{ directory.availability.message }}
              </p>
              <div v-if="directory.roots.length" class="append-actions">
                <button
                  v-for="root in directory.roots"
                  :key="root.id"
                  type="button"
                  class="soft-action-button"
                  :disabled="working"
                  @click="browse(root.id)"
                >
                  {{ root.label }}
                </button>
              </div>
              <button
                v-if="directory.current?.path"
                type="button"
                class="soft-action-button"
                @click="
                  browse(
                    directory.current.rootId,
                    directory.current.path.split('/').slice(0, -1).join('/'),
                  )
                "
              >
                上级目录
              </button>
              <div
                v-for="entry in directory.entries"
                :key="entry.path"
                class="append-directory-entry"
              >
                <button
                  v-if="entry.type === 'directory'"
                  type="button"
                  class="soft-action-button"
                  @click="browse(directory.current!.rootId, entry.path)"
                >
                  <FolderOpen :size="16" />{{ entry.name }}
                </button>
                <label v-else
                  ><input
                    type="checkbox"
                    :checked="
                      nasSelection.some(
                        (f) =>
                          f.rootId === directory?.current?.rootId &&
                          f.path === entry.path,
                      )
                    "
                    @change="toggleNas(entry.path, entry.name)"
                  />{{ entry.name }}</label
                >
              </div>
              <button
                type="button"
                class="soft-action-button"
                :disabled="working || !nasSelection.length"
                v-if="nasSelection.length"
                @click="importNas"
              >
                导入 {{ nasSelection.length }} 个文件并预览
              </button>
            </div>
            <template v-if="batch">
              <section
                class="append-progress"
                aria-label="补页处理进度"
                :aria-busy="processing || working"
              >
                <ol
                  v-if="!['noop', 'cancelled'].includes(batch.state)"
                  class="append-steps"
                >
                  <li
                    v-for="(step, index) in steps"
                    :key="step"
                    :class="{
                      done: index < currentStep,
                      current: index === currentStep,
                    }"
                    :aria-current="index === currentStep ? 'step' : undefined"
                  >
                    <CheckCircle2 v-if="index < currentStep" :size="15" /><span
                      v-else
                      class="append-step-number"
                      >{{ index + 1 }}</span
                    ><span>{{ step }}</span>
                  </li>
                </ol>
                <div
                  class="append-progress-message"
                  role="status"
                  aria-live="polite"
                >
                  <LoaderCircle
                    v-if="processing || working"
                    class="spin-icon"
                    :size="18"
                  />
                  <CircleAlert v-else-if="needsAttention" :size="18" />
                  <CheckCircle2
                    v-else-if="batch.state === 'complete'"
                    :size="18"
                  />
                  <div>
                    <strong>{{
                      batch.state === "complete" && batch.reviewWarnings?.length
                        ? "补页完成，部分内容待核对"
                        : working && batch.state === "uploading"
                          ? "正在上传文件"
                          : labels[batch.state] || batch.state
                    }}</strong>
                    <p>{{ stageDetail }}</p>
                  </div>
                </div>
                <p v-if="processing" class="append-background-hint">
                  可以关闭弹窗，后台会继续处理，状态自动更新。
                </p>
              </section>
              <ul
                v-if="batch.reviewWarnings?.length"
                class="append-review-warnings"
              >
                <li v-for="warning in batch.reviewWarnings" :key="warning">
                  {{ warning }}
                </li>
              </ul>
              <p v-if="batch.error" class="append-muted">{{ batch.error }}</p>
              <ul class="append-file-list">
                <li v-for="file in batch.files" :key="file.id">
                  <span>{{ file.name }}</span
                  ><small>{{
                    file.error ||
                    (file.received
                      ? file.pageCount
                        ? `${file.pageCount} 页`
                        : "已上传，等待读取"
                      : `上传 ${percent[file.id] || 0}%`)
                  }}</small>
                  <button
                    v-if="batch.state === 'uploading' && !file.received"
                    type="button"
                    :disabled="working"
                    @click="retryFile(file.id)"
                  >
                    重试此文件
                  </button>
                  <button
                    v-if="batch.state === 'failed' && file.error"
                    type="button"
                    :disabled="working"
                    @click="action('retry')"
                  >
                    重试此文件
                  </button>
                </li>
              </ul>
              <input
                v-if="batch.state === 'uploading'"
                ref="resumeInput"
                hidden
                type="file"
                multiple
                @change="resumePicked"
              />
              <button
                v-if="batch.state === 'uploading'"
                type="button"
                class="soft-action-button"
                :disabled="working"
                @click="localFiles.length ? upload() : resumeInput?.click()"
              >
                重试未完成的文件
              </button>
              <p
                v-if="batch.state === 'ready'"
                class="append-selection-summary"
              >
                {{ batch.files.length }} 个文件，共 {{ total }} 页；已选
                {{ selected.length }} 页
              </p>
              <h5 v-if="['ready', 'review'].includes(batch.state)">待补充页</h5>
              <div
                v-if="['ready', 'review'].includes(batch.state)"
                class="append-page-grid"
              >
                <div
                  v-for="p in selectablePages"
                  :key="p.id"
                  class="append-page-choice"
                  :class="{ selected: selected.some((s) => s.id === p.id) }"
                >
                  <label class="append-page-heading">
                    <input
                      v-if="['ready', 'review'].includes(batch.state)"
                      type="checkbox"
                      :checked="selected.some((s) => s.id === p.id)"
                      @change="toggle(p.id)"
                    />
                    <span>第 {{ p.sourcePageNumber }} 页</span>
                  </label>
                  <div class="append-page-preview">
                    <img
                      v-if="p.hasPreview"
                      :src="apiUrl(`${endpoint}/${batch.id}/pages/${p.id}`)"
                      :style="{
                        transform: `rotate(${(p.ocrComplete ? 0 : selected.find((s) => s.id === p.id)?.rotation) || 0}deg)`,
                      }"
                      :alt="`${p.name} 第 ${p.sourcePageNumber} 页`"
                      loading="lazy"
                    />
                  </div>
                  <span class="append-page-name" :title="p.name">{{
                    p.name
                  }}</span>
                  <small v-if="p.duplicate">完全重复，已跳过</small>
                  <div
                    v-if="
                      batch.state === 'ready' &&
                      selected.some((s) => s.id === p.id)
                    "
                    class="append-page-tools"
                  >
                    <small
                      >{{
                        selected.find((s) => s.id === p.id)?.rotation
                      }}°</small
                    >
                    <button
                      type="button"
                      aria-label="上移补充页"
                      :disabled="selected.findIndex((s) => s.id === p.id) === 0"
                      @click="
                        move(
                          selected.findIndex((s) => s.id === p.id),
                          -1,
                        )
                      "
                    >
                      <ArrowUp :size="16" />
                    </button>
                    <button
                      type="button"
                      aria-label="下移补充页"
                      :disabled="
                        selected.findIndex((s) => s.id === p.id) ===
                        selected.length - 1
                      "
                      @click="
                        move(
                          selected.findIndex((s) => s.id === p.id),
                          1,
                        )
                      "
                    >
                      <ArrowDown :size="16" />
                    </button>
                    <button
                      type="button"
                      aria-label="旋转补充页"
                      @click="rotatePage(p.id)"
                    >
                      <RotateCw :size="16" />
                    </button>
                  </div>
                </div>
              </div>
              <ul v-if="batch.conflicts.length" class="append-error">
                <li v-for="warning in batch.conflicts" :key="warning">
                  {{ warning }}
                </li>
              </ul>
              <p v-if="batch.state === 'review'" class="append-muted">
                这些页面尚未加入正式报告。请对照已有原件，可以取消勾选疑点页；确认保留的页面属于同一成员、同一次报告后再继续。
              </p>
            </template>
          </div>
          <footer v-if="batch" class="append-actions append-batch-actions">
            <button
              v-if="processing"
              type="button"
              class="soft-action-button"
              @click="open = false"
            >
              收起，后台继续处理
            </button>
            <button
              v-if="finished"
              type="button"
              class="primary-button"
              @click="open = false"
            >
              {{ batch.state === "complete" ? "完成" : "关闭" }}
            </button>
            <button
              v-if="batch.state === 'ready'"
              type="button"
              class="primary-button"
              :disabled="working || !selected.length"
              @click="action('submit', { pages: selected })"
            >
              <LoaderCircle v-if="working" :size="16" class="spin-icon" />{{
                working ? "正在提交…" : "补充并识别"
              }}
            </button>
            <button
              v-if="batch.state === 'review'"
              type="button"
              class="primary-button"
              :disabled="working"
              @click="action('confirm', { pageIds: selected.map((p) => p.id) })"
            >
              {{
                selected.length
                  ? "确认所选页属于当前报告，继续"
                  : "排除全部新增页并结束"
              }}
            </button>
            <button
              v-if="batch.state === 'failed'"
              type="button"
              class="primary-button"
              :disabled="working"
              @click="action('retry')"
            >
              <LoaderCircle v-if="working" :size="16" class="spin-icon" />{{
                working ? "正在重试…" : "重试未完成的阶段"
              }}
            </button>
            <button
              v-if="batch.state === 'failed' && batch.published"
              type="button"
              class="soft-action-button"
              :disabled="working"
              @click="action('retry', { keepOcr: true })"
            >
              保留原件与 OCR，结束本次识别
            </button>
            <button
              v-if="!batch.published && !finished"
              type="button"
              class="soft-action-button"
              :disabled="working"
              @click="discard"
            >
              放弃本批次
            </button>
            <button
              v-if="finished"
              type="button"
              class="soft-action-button"
              @click="newBatch"
            >
              继续补充
            </button>
          </footer>
        </section>
      </div>
    </Teleport>
  </div>
</template>
<style scoped>
.report-page-append {
  margin-top: 12px;
}
.append-backdrop {
  z-index: 110;
  padding: 0;
  place-items: stretch end;
}
.append-panel {
  width: min(680px, 100%);
  height: 100dvh;
  max-height: 100dvh;
  border-radius: 20px 0 0 20px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.append-header {
  padding: 18px 20px;
}
.append-header > div {
  min-width: 0;
}
.append-header h4 {
  margin: 0 0 4px;
  font-size: 17px;
}
.append-header p {
  color: var(--muted);
  font-size: 12px;
  overflow-wrap: anywhere;
}
.append-header .icon-button {
  flex: 0 0 auto;
}
.append-body {
  flex: 1;
  align-content: start;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 20px 20px max(20px, env(safe-area-inset-bottom));
  display: grid;
  gap: 16px;
}
.append-body .drop-zone {
  min-height: 220px;
  padding: 20px 12px;
}
.append-body .drop-actions {
  flex-wrap: wrap;
  justify-content: center;
}
@media (max-width: 600px) {
  .append-backdrop {
    place-items: end center;
  }
  .append-panel {
    width: 100%;
    height: 94dvh;
    max-height: 94dvh;
    border-radius: 20px 20px 0 0;
  }
  .append-body {
    padding-inline: 16px;
  }
}
.append-panel h5 {
  margin: 0;
  font-size: 13px;
  color: var(--ink-2);
}
.append-panel p {
  margin: 0;
  line-height: 1.6;
}
.append-muted {
  color: var(--ink-2);
  font-size: 12px;
}
.append-batch-actions {
  flex: 0 0 auto;
  padding: 12px 20px max(12px, env(safe-area-inset-bottom));
  border-top: 1px solid var(--line);
  background: var(--surface);
}
.append-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  align-items: center;
}
.append-actions.append-batch-actions {
  flex-wrap: nowrap;
  gap: 6px;
  padding: 10px 14px max(10px, env(safe-area-inset-bottom));
  overflow-x: auto;
}
.append-batch-actions > button {
  flex: 0 0 auto;
  min-height: 34px;
  padding: 7px 12px;
  font-size: 12px;
  line-height: 1.4;
  white-space: nowrap;
  gap: 5px;
}
.append-review-warnings {
  margin: 0;
  padding: 12px 12px 12px 28px;
  background: var(--fill-2);
  border-radius: 10px;
  color: var(--ink-2);
  font-size: 12px;
  line-height: 1.7;
}
.append-error {
  color: var(--danger, #cf6c69);
  white-space: pre-line;
}
.append-file-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: grid;
  gap: 8px;
}
.append-file-list li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-width: 0;
}
.append-file-list span {
  overflow-wrap: anywhere;
  min-width: 0;
}
.append-file-list small {
  flex-shrink: 0;
  color: var(--ink-2);
}
.append-progress {
  padding: 14px;
  border: 1px solid var(--line);
  border-radius: 14px;
  background: var(--fill-2);
}
.append-steps {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 6px;
  padding: 0 0 12px;
  margin: 0 0 12px;
  list-style: none;
  border-bottom: 1px solid var(--line);
}
.append-steps li {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  color: var(--muted);
  font-size: 11px;
  white-space: nowrap;
}
.append-steps li.current,
.append-steps li.done {
  color: var(--brand);
}
.append-step-number {
  width: 16px;
  height: 16px;
  border: 1px solid currentColor;
  border-radius: 50%;
  display: grid;
  place-items: center;
  font-size: 10px;
  flex-shrink: 0;
}
.append-progress-message {
  display: flex;
  gap: 8px;
  align-items: flex-start;
}
.append-progress-message > svg {
  flex-shrink: 0;
  margin-top: 2px;
  color: var(--brand);
}
.append-progress-message strong {
  font-size: 13px;
}
.append-progress-message p,
.append-background-hint {
  font-size: 12px;
  color: var(--muted);
  line-height: 1.6;
}
.append-progress-message p {
  margin-top: 5px;
}
.append-progress .append-background-hint {
  margin-top: 10px;
}
.append-trigger-active {
  box-shadow: inset 0 0 0 1px var(--brand);
}
.append-trigger-attention {
  box-shadow: inset 0 0 0 1px var(--line);
}
@media (max-width: 380px) {
  .append-steps li {
    flex-direction: column;
    gap: 5px;
  }
}
.append-selection-summary {
  font-size: 12px;
  color: var(--muted);
}
.append-file-list {
  font-size: 12px;
}
.append-file-list li {
  padding: 9px 12px;
  border-radius: 10px;
  background: var(--fill-2);
}
.append-file-list span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.append-file-list small {
  font-size: 11px;
}
.append-page-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 12px;
}
.append-page-choice {
  min-width: 0;
  display: grid;
  align-content: start;
  gap: 8px;
  padding: 10px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--fill-2);
  font-size: 12px;
}
.append-page-choice.selected {
  border-color: var(--brand);
}
.append-page-heading {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  font-weight: 600;
}
.append-page-heading input {
  margin: 0;
  width: 16px;
  height: 16px;
  accent-color: var(--brand);
}
.append-page-preview {
  height: 140px;
  overflow: hidden;
  display: grid;
  place-items: center;
  border-radius: 7px;
  background: var(--surface);
}
.append-page-preview img {
  width: 100%;
  height: 140px;
  object-fit: contain;
}
.append-page-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--muted);
  font-size: 11px;
}
.append-page-tools {
  display: flex;
  align-items: center;
  gap: 2px;
  border-top: 1px solid var(--line);
  padding-top: 6px;
}
.append-page-tools small {
  flex: 1;
  color: var(--muted);
}
.append-page-tools button {
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  padding: 0;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--ink-2);
  cursor: pointer;
}
.append-page-tools button:hover:not(:disabled) {
  background: var(--brand-soft);
  color: var(--brand);
}
.append-page-tools button:disabled {
  opacity: 0.3;
  cursor: default;
}
.append-directory-entry {
  padding: 8px 0;
  overflow-wrap: anywhere;
}
.append-nas-empty {
  padding: 12px 14px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--fill-2);
  min-width: 0;
}
.append-nas-empty-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.append-nas-empty-heading strong {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-size: 13px;
  font-weight: 500;
  color: var(--ink-2);
}
.append-nas-empty-heading svg {
  flex-shrink: 0;
}
.append-nas-empty > p,
.append-nas-details p {
  margin-top: 6px;
  font-size: 12px;
  color: var(--muted);
  line-height: 1.6;
  overflow-wrap: anywhere;
}
.append-nas-details {
  margin-top: 8px;
  font-size: 12px;
  color: var(--muted);
}
.append-nas-details summary {
  cursor: pointer;
  width: fit-content;
}
.append-nas-retry {
  display: inline-flex;
  align-items: center;
  flex-shrink: 0;
  gap: 4px;
  min-height: 32px;
  padding: 4px 0;
  border: 0;
  background: transparent;
  color: var(--brand);
  font-size: 12px;
  white-space: nowrap;
  cursor: pointer;
}
.append-nas-retry:disabled {
  opacity: 0.6;
  cursor: wait;
}
.append-browser {
  max-height: 360px;
  overflow: auto;
}
.append-file-list button {
  background: transparent;
  border: 0;
  color: inherit;
  padding: 6px;
}
@media (max-width: 520px) {
  .append-actions {
    gap: 6px;
  }
}
</style>
