<script setup lang="ts">
import { onMounted, ref } from "vue";
import { ArchiveRestore, DatabaseBackup, Download, LoaderCircle, ShieldCheck, Trash2, UploadCloud } from "@lucide/vue";
import SubPageHeader from "../../components/SubPageHeader.vue";
import MarqueeText from "../../components/MarqueeText.vue";
import { request, requestUpload } from "../../utils/api";
import { downloadFile, downloadStreamedFile } from "../../utils/download";
import { useAppContext } from "../../composables/useAppContext";
import { useConfirm } from "../../composables/useConfirm";
import { useToast } from "../../composables/useToast";
import { formatDatabaseTime } from "../../utils/time";
import type { BackupSummary, BackupValidationResult } from "../../types/api";

const app = useAppContext();
const toast = useToast();
const confirmDialog = useConfirm();
const message = ref("");
const error = ref("");
const backups = ref<BackupSummary[]>([]);
const loadingBackups = ref(false);
const creatingBackup = ref(false);
const restoringId = ref("");
const deletingId = ref("");
const checkingId = ref("");
const downloadingId = ref("");
const uploadingRestore = ref(false);
const validationById = ref<Record<string, BackupValidationResult>>({});

type RestoreResult = {
  restored: boolean;
  backupId: string;
  safetyBackupId: string;
  filename?: string;
  identityRebind?: { strategy?: 'same'|'cross' };
};

function restoreAccountNotice(result: RestoreResult) {
 return result.identityRebind?.strategy==='cross'?'源账号处于待映射状态，请按备份恢复文档运行受控身份映射工具。':'授权已回到备份时点，请重新登录。';
}

function formatBytes(value?: number | null) {
  const bytes = Number(value || 0);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

const exportingMember = ref(false);

async function exportMember() {
  const memberId = app.selectedMemberId.value;
  if (!memberId || exportingMember.value) return;
  exportingMember.value = true;
  try {
    await downloadFile(`export/member?memberId=${encodeURIComponent(memberId)}`, "member-export.json");
    toast.show("成员清单已导出");
  } catch (cause) {
    toast.show(cause instanceof Error ? cause.message : "成员清单导出失败", 3600);
  } finally {
    exportingMember.value = false;
  }
}

async function loadBackups() {
  if (!app.session.value?.isAdmin) return;
  loadingBackups.value = true;
  try {
    backups.value = await request<BackupSummary[]>("backups");
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "备份列表加载失败";
  } finally {
    loadingBackups.value = false;
  }
}

async function createBackupNow() {
  creatingBackup.value = true;
  message.value = "";
  try {
    const backup = await request<BackupSummary>("backups", { method: "POST" });
    message.value = `完整备份已创建：${backup.filename} · ${formatBytes(backup.sizeBytes)}`;
    toast.show("备份已创建");
    await loadBackups();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "备份创建失败";
  } finally {
    creatingBackup.value = false;
  }
}

async function downloadBackup(backup: BackupSummary) {
  if (downloadingId.value) return;
  downloadingId.value = backup.id;
  try {
    await downloadStreamedFile(`backups/${encodeURIComponent(backup.id)}/download`, backup.filename);
    toast.show("已开始下载，可在浏览器下载列表查看进度");
  } catch (cause) {
    toast.show(cause instanceof Error ? cause.message : "备份下载失败", 3600);
  } finally {
    downloadingId.value = "";
  }
}

function validationText(result: BackupValidationResult) {
  if (result.valid && result.checksumAvailable) return `校验通过：${result.checkedCount}/${result.fileCount} 个文件`;
  if (result.valid) return result.warnings[0] || "基础校验通过：旧备份无校验清单";
  const details = [
    result.errors[0],
    result.missingFiles.length ? `缺失 ${result.missingFiles.length}` : "",
    result.mismatchedFiles.length ? `不一致 ${result.mismatchedFiles.length}` : "",
    result.extraFiles.length ? `未登记 ${result.extraFiles.length}` : ""
  ].filter(Boolean);
  return details.length ? details.join(" · ") : "校验失败";
}

async function checkBackup(backup: BackupSummary) {
  checkingId.value = backup.id;
  message.value = "";
  try {
    const result = await request<BackupValidationResult>(`backups/${encodeURIComponent(backup.id)}/check`);
    validationById.value = { ...validationById.value, [backup.id]: result };
    message.value = `${backup.filename}：${validationText(result)}`;
    toast.show(result.valid ? "备份校验完成" : "备份校验失败");
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "备份校验失败";
  } finally {
    checkingId.value = "";
  }
}

async function restoreBackup(backup: BackupSummary) {
  let plan:{token:string;warning:string};
  try {plan=await request(`backups/${encodeURIComponent(backup.id)}/preflight`,{method:'POST'});}
  catch(cause){error.value=cause instanceof Error?cause.message:'恢复预检失败';return;}
  confirmDialog.ask({
    title: "从备份恢复",
    message: `${plan.warning}\n恢复会覆盖数据库、原件、配置和密钥，并先创建安全备份。`,
    confirmText: "恢复",
    danger: true,
    run: async () => {
      restoringId.value = backup.id;
      message.value = "";
      error.value = "";
      try {
        const result = await request<RestoreResult>(
          `backups/${encodeURIComponent(backup.id)}/restore`,
          { method: "POST",body:JSON.stringify({token:plan.token}) }
        );
        message.value = `恢复完成，恢复前安全备份：${result.safetyBackupId}。建议刷新页面或重新打开应用确认数据状态。${restoreAccountNotice(result)}`;
        toast.show("备份已恢复");
        await app.load();
      } catch (cause) {
        error.value = cause instanceof Error ? cause.message : "备份恢复失败";
      } finally {
        restoringId.value = "";
      }
    }
  });
}

async function restoreUploadedBackup(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  let plan:{token:string;warning:string};
  uploadingRestore.value=true;
  try { const body=new FormData();body.append('backup',file);plan=await requestUpload('backups/restore-upload',body); }
  catch(cause){error.value=cause instanceof Error?cause.message:'恢复预检失败';return;}
  finally {uploadingRestore.value=false;}
  confirmDialog.ask({
    title: "从外部备份恢复",
    message: `${plan.warning}\n恢复前会创建安全备份。`,
    confirmText: "恢复",
    danger: true,
    run: async () => {
      uploadingRestore.value = true;
      message.value = "";
      error.value = "";
      try {
        const body = new FormData();
        body.append("backup", file);
        body.append("token",plan.token);
        const result = await requestUpload<RestoreResult>(
          "backups/restore-upload",
          body
        );
        message.value = `外部备份已恢复：${result.filename}。恢复前安全备份：${result.safetyBackupId}。建议刷新页面或重新打开应用确认数据状态。${restoreAccountNotice(result)}`;
        toast.show("外部备份已恢复");
        await app.load();
      } catch (cause) {
        error.value = cause instanceof Error ? cause.message : "外部备份恢复失败";
      } finally {
        uploadingRestore.value = false;
      }
    }
  });
}

async function deleteBackup(backup: BackupSummary) {
  const label = backup.reason === "pre_restore" ? "恢复前安全备份" : "完整备份";
  confirmDialog.ask({
    title: "删除备份",
    message: `确认删除这份${label}？\n\n${backup.filename}\n\n删除备份不会影响当前档案数据，但删除后无法再用它恢复。`,
    confirmText: "删除",
    danger: true,
    run: async () => {
      deletingId.value = backup.id;
      message.value = "";
      error.value = "";
      try {
        await request(`backups/${encodeURIComponent(backup.id)}`, { method: "DELETE" });
        message.value = `备份已删除：${backup.filename}`;
        toast.show("备份已删除");
        await loadBackups();
      } catch (cause) {
        error.value = cause instanceof Error ? cause.message : "备份删除失败";
      } finally {
        deletingId.value = "";
      }
    }
  });
}

onMounted(() => {
  void loadBackups();
});
</script>

<template>
  <section class="settings-page">
    <SubPageHeader title="备份与恢复" description="导出成员清单，或由管理员创建和恢复完整应用备份" />

    <section class="settings-band">
      <header>
        <Download :size="20" />
        <div><h3>成员清单导出</h3><p>导出当前成员的报告元数据、指标和原件相对路径，适合核对与轻量迁移。</p></div>
      </header>
      <div class="settings-form">
        <div class="form-actions">
          <button class="primary-button" type="button" :disabled="exportingMember" @click="exportMember">
            <LoaderCircle v-if="exportingMember" class="spin-icon" :size="16" />
            <Download v-else :size="16" />{{ exportingMember ? "正在导出" : "导出当前成员" }}
          </button>
        </div>
      </div>
    </section>

    <section class="settings-band backup-restore-card">
      <header>
        <DatabaseBackup :size="20" />
        <div><h3>完整应用备份</h3><p>包含 SQLite 快照、报告原件、分页图、运行配置和 AI 密钥；仅系统管理员可操作。</p></div>
      </header>
      <div v-if="app.session.value?.isAdmin" class="backup-header-actions">
        <button
          class="header-action"
          type="button"
          :disabled="creatingBackup || uploadingRestore"
          @click="createBackupNow"
        >
            <LoaderCircle v-if="creatingBackup" class="spin-icon" :size="16" />
            <DatabaseBackup v-else :size="16" />
            {{ creatingBackup ? "备份中" : "创建备份" }}
          </button>
          <label
            class="header-action muted-action native-file-action"
            :class="{ 'is-disabled': creatingBackup || uploadingRestore || Boolean(restoringId) }"
            :aria-disabled="creatingBackup || uploadingRestore || Boolean(restoringId)"
          >
            <input
              type="file"
              accept=".tar.gz,.tgz,application/gzip,application/x-gzip,application/octet-stream"
              aria-label="选择外部备份文件"
              :disabled="creatingBackup || uploadingRestore || Boolean(restoringId)"
              @change="restoreUploadedBackup"
            />
            <LoaderCircle v-if="uploadingRestore" class="spin-icon" :size="16" />
            <UploadCloud v-else :size="16" />
            {{ uploadingRestore ? "恢复中" : "上传恢复" }}
          </label>
        </div>

      <div v-if="!app.session.value?.isAdmin" class="settings-form">
        <p class="preview-hint">完整备份包含所有成员的医疗数据和密钥，仅系统管理员可查看和恢复。</p>
      </div>
      <div v-else class="backup-list">
        <p v-if="message" class="preview-hint">{{ message }}</p>
        <p v-if="error" class="inline-panel-error">{{ error }}</p>
        <p v-if="loadingBackups" class="backup-empty"><LoaderCircle class="spin-icon" :size="16" />正在加载备份列表</p>
        <p v-else-if="!backups.length" class="backup-empty">暂无完整备份，建议在升级、迁移或批量整理前先创建一份。</p>
        <article v-for="backup in backups" :key="backup.id" class="backup-item">
          <div class="backup-main">
            <MarqueeText :text="backup.filename" />
            <span>{{ formatDatabaseTime(backup.createdAt) }} · {{ formatBytes(backup.sizeBytes) }} · v{{ backup.appVersion }} · DB v{{ backup.schemaVersion }}</span>
            <small>{{ backup.memberCount }} 位成员 · {{ backup.reportCount }} 份报告 · {{ backup.includes.join("、") }}</small>
            <small
              v-if="validationById[backup.id]"
              :class="['backup-check-line', { invalid: !validationById[backup.id].valid }]"
            >
              {{ validationText(validationById[backup.id]) }}
            </small>
          </div>
          <div class="backup-actions">
            <span v-if="backup.reason === 'pre_restore'" class="backup-tag">恢复前安全备份</span>
            <button
              type="button"
              :disabled="Boolean(restoringId || deletingId || checkingId)"
              @click="checkBackup(backup)"
            >
              <LoaderCircle v-if="checkingId === backup.id" class="spin-icon" :size="15" />
              <ShieldCheck v-else :size="15" />
              {{ checkingId === backup.id ? "校验中" : "校验" }}
            </button>
            <button type="button" :disabled="Boolean(downloadingId)" @click="downloadBackup(backup)">
              <LoaderCircle v-if="downloadingId === backup.id" class="spin-icon" :size="15" />
              <Download v-else :size="15" />
              {{ downloadingId === backup.id ? "准备中" : "下载" }}
            </button>
            <button
              class="danger-text-button"
              type="button"
              :disabled="Boolean(restoringId || deletingId)"
              @click="restoreBackup(backup)"
            >
              <LoaderCircle v-if="restoringId === backup.id" class="spin-icon" :size="15" />
              <ArchiveRestore v-else :size="15" />
              {{ restoringId === backup.id ? "恢复中" : "恢复" }}
            </button>
            <button
              class="danger-text-button"
              type="button"
              :disabled="Boolean(restoringId || deletingId)"
              @click="deleteBackup(backup)"
            >
              <LoaderCircle v-if="deletingId === backup.id" class="spin-icon" :size="15" />
              <Trash2 v-else :size="15" />
              {{ deletingId === backup.id ? "删除中" : "删除" }}
            </button>
          </div>
        </article>
      </div>
    </section>
  </section>
</template>
