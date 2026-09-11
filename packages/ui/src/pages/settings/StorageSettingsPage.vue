<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { FolderInput, HardDrive, RefreshCw } from '@lucide/vue';
import FormSelect from '../../components/FormSelect.vue';
import SubPageHeader from '../../components/SubPageHeader.vue';
import { request } from '../../utils/api';
import { useConfirm } from '../../composables/useConfirm';
import { useToast } from '../../composables/useToast';

type StorageStatus = {
  storageDir: string; runtimeDir: string; relocated: boolean;
  state: 'ready' | 'unavailable'; error: string | null;
  availableBytes: number | null; capacityBytes: number | null;
  deployment: 'fnos' | 'development';
  migrationAvailable: boolean; paused: boolean;
  roots: { id: string; path: string }[];
  migration: { id: string; source: string; phase: string; error: string | null; cleanupAvailable: boolean; cleaning: boolean; cleanupCompletedAt?: string } | null;
};
const storage = ref<StorageStatus | null>(null);
const loading = ref(false);
const error = ref('');
const selectedRoot = ref('');
const rootOptions = computed(() => storage.value?.roots.map(root => ({ value: root.id, label: root.path })) || []);
const confirm = useConfirm();
const toast = useToast();
async function cleanOldArchive() {
  const migrationId = storage.value?.migration?.id;
  if (!migrationId || loading.value) return;
  loading.value = true; error.value = '';
  try {
    const preview = await request<{ source: string; files: number; bytes: number; skipped: number }>('storage/cleanup-preview', {
      method: 'POST', headers: { 'x-storage-operation': '1' }, body: JSON.stringify({ migrationId })
    });
    if (!preview.files && preview.skipped) { toast.show('没有可安全删除的旧文件，已变化的文件会保留。'); return; }
    confirm.ask({ title: '清理旧档案副本', confirmText: '确认删除旧副本', danger: true,
      message: `将删除 ${preview.source} 中 ${preview.files} 个已迁移且未变化的文件（${size(preview.bytes)}）。此操作无法撤销，请确认新档案可用并已保留独立备份。运行配置、密钥、OCR 环境、备份及新增或变化的文件保留；新档案不受影响。`,
      run: async () => {
        loading.value = true;
        try {
          const result = await request<{ deletedFiles: number; skipped: number }>('storage/cleanup', {
            method: 'POST', headers: { 'x-storage-operation': '1' }, body: JSON.stringify({ migrationId, confirmed: true })
          });
          toast.show(`已删除 ${result.deletedFiles} 个旧文件${result.skipped ? `，${result.skipped} 个变化文件已保留` : ''}。运行环境和备份保留。`, 5000);
          await refresh();
        } catch (cause) { error.value = cause instanceof Error ? cause.message : '清理未完成，未处理文件保留'; }
        finally { loading.value = false; }
      }
    });
  } catch (cause) { error.value = cause instanceof Error ? cause.message : '无法核对旧副本'; }
  finally { loading.value = false; }
}
async function migrate() {
  if (!selectedRoot.value || loading.value) return;
  loading.value = true; error.value = '';
  const rootId = selectedRoot.value;
  try {
    const preview = await request<{ files: number; bytes: number; parent: string }>('storage/preview', {
      method: 'POST', headers: { 'x-storage-operation': '1' }, body: JSON.stringify({ rootId })
    });
    confirm.ask({ title: '迁移档案存储', confirmText: '确认并开始迁移',
      message: `将 ${preview.files} 个文件（约 ${size(preview.bytes)}）迁移到 ${preview.parent} 下的专属目录。期间暂停所有用户的业务操作，原目录数据保留。请先完成独立备份。`,
      run: async () => {
        await request('storage/migrate', { method: 'POST', headers: { 'x-storage-operation': '1' }, body: JSON.stringify({ rootId }) });
        window.location.reload();
      }
    });
  } catch (cause) { error.value = cause instanceof Error ? cause.message : '迁移检查未通过'; }
  finally { loading.value = false; }
}
function size(bytes: number | null) {
  if (bytes === null) return '暂不可用';
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}
async function refresh() {
  loading.value = true;
  error.value = '';
  try { storage.value = await request<StorageStatus>('storage'); }
  catch (cause) { error.value = cause instanceof Error ? cause.message : '无法读取存储信息'; }
  finally { loading.value = false; }
}
onMounted(refresh);
</script>

<template>
  <section class="settings-page">
    <SubPageHeader title="存储设置" description="查看档案数据与运行环境的位置" />
    <section class="settings-band archive-storage-panel" :aria-busy="loading">
      <header>
        <HardDrive :size="21" />
        <div><h3>当前存储</h3><p>档案数据与应用运行环境的位置</p></div>
        <button type="button" class="header-action" :disabled="loading" @click="refresh"><RefreshCw :size="16" :class="{ 'spin-icon': loading }" />{{ loading ? '读取中' : '刷新' }}</button>
      </header>
      <div class="archive-storage-body">
        <p v-if="error || storage?.error" class="form-error" role="alert">{{ error || storage?.error }}</p>
        <template v-if="storage">
          <div class="archive-capacity">
            <div><span>存储空间可用</span><strong>{{ size(storage.availableBytes) }} <small>/ {{ size(storage.capacityBytes) }}</small></strong></div>
            <span class="archive-status" :class="{ unavailable: storage.state !== 'ready' }">{{ storage.state === 'ready' ? (storage.relocated ? '已迁移' : '默认位置') : '不可用' }}</span>
          </div>
          <dl class="archive-directories">
            <div><dt>档案目录<span>数据库、原件与业务配置</span></dt><dd>{{ storage.storageDir }}</dd></div>
            <div><dt>运行目录<span>应用配置与 OCR 环境</span></dt><dd>{{ storage.runtimeDir }}</dd></div>
          </dl>
          <div v-if="storage.migration?.phase === 'completed'" class="archive-cleanup">
            <div><strong>{{ storage.migration.cleanupCompletedAt ? '旧档案副本已清理' : '旧档案副本仍保留' }}</strong>
              <p v-if="storage.migration.cleanupCompletedAt">运行环境、配置、密钥及备份未删除。</p>
              <p v-else-if="storage.migration.cleanupAvailable">确认新档案正常后，可清理已迁移的旧文件以释放空间。</p>
              <p v-else>本次迁移没有文件校验清单，暂不能自动清理。请勿直接删除整个旧目录。</p>
            </div>
            <button v-if="storage.migration.cleanupAvailable" type="button" class="soft-action-button" :disabled="loading || storage.paused || storage.state !== 'ready' || storage.migration.cleaning" @click="cleanOldArchive">检查并清理旧副本</button>
          </div>
        </template>
        <p v-else-if="loading" role="status">正在读取存储信息…</p>
      </div>
    </section>
    <section v-if="storage" class="settings-band archive-storage-panel">
      <header><FolderInput :size="21" /><div><h3>迁移档案</h3><p>更换存储空间，应用与 OCR 环境保持原位</p></div></header>
      <div class="archive-storage-body">
        <p v-if="storage.migration?.error" class="form-error" role="alert">{{ storage.migration.error }}</p>
        <div class="archive-migration-form">
          <div class="archive-target"><span>目标存储目录</span>
            <FormSelect v-model="selectedRoot" :options="rootOptions" placeholder="请选择已授权目录" aria-label="目标存储目录" empty-text="暂无已授权目录" :disabled="loading || storage.paused || !storage.roots.length" />
          </div>
          <div class="form-actions"><button type="button" class="primary-button" :disabled="loading || !selectedRoot || !storage.migrationAvailable || storage.paused" @click="migrate"><FolderInput :size="16" />检查并迁移</button></div>
        </div>
        <p v-if="!storage.roots.length" class="archive-guidance">{{ storage.deployment === 'fnos' ? '请先在飞牛应用设置中授权目标目录的读写权限。' : '请通过 IMPORT_ROOTS 配置本地测试目录。' }}</p>
        <p class="archive-guidance">迁移前会检查目录与空间，确认后才开始。旧副本保留，成功后可另行确认清理。</p>
        <details class="archive-safety">
          <summary>数据安全说明</summary>
          <p>请先完成独立备份。目标须为本地存储空间，不能与当前目录重叠。迁移期间暂停业务访问；不要只移动 reports 文件夹或手动修改存储配置。</p>
        </details>
      </div>
    </section>
  </section>
</template>

<style scoped>
.archive-storage-panel { min-width: 0; }
.archive-storage-body { padding: 20px; display: grid; gap: 18px; }
.archive-cleanup { display: flex; align-items: center; gap: 16px; border-top: 1px solid var(--line); padding-top: 16px; }
.archive-cleanup > div { flex: 1; min-width: 0; }
.archive-cleanup strong { font-size: 13px; font-weight: 500; }
.archive-cleanup button { flex-shrink: 0; white-space: nowrap; }
.archive-storage-panel p { line-height: 1.65; }
.archive-capacity { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 16px; background: var(--fill-2); border-radius: var(--radius-m); }
.archive-capacity > div { display: grid; gap: 6px; min-width: 0; }
.archive-capacity span, .archive-capacity small { font-size: 12px; color: var(--muted); font-weight: 400; }
.archive-capacity strong { font-size: 22px; font-weight: 600; font-variant-numeric: tabular-nums; }
.archive-capacity .archive-status { flex-shrink: 0; color: var(--brand); background: var(--brand-soft); padding: 4px 10px; border-radius: var(--radius-s); }
.archive-capacity .unavailable { color: var(--danger); background: var(--danger-soft); }
.archive-directories { margin: 0; display: grid; gap: 16px; }
.archive-directories > div { display: grid; grid-template-columns: 180px minmax(0, 1fr); gap: 16px; }
.archive-directories > div + div { border-top: 1px solid var(--line); padding-top: 16px; }
.archive-directories dt { font-size: 13px; color: var(--ink); }
.archive-directories dt span { display: block; margin-top: 5px; font-size: 12px; color: var(--muted); }
.archive-directories dd { margin: 0; font-size: 13px; line-height: 1.7; color: var(--ink-2); overflow-wrap: anywhere; }
.archive-migration-form { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: end; gap: 16px; }
.archive-target { min-width: 0; display: grid; gap: 8px; font-size: 13px; }
.archive-migration-form button { white-space: nowrap; }
.archive-safety { border-top: 1px solid var(--line); padding-top: 14px; font-size: 12px; color: var(--muted); }
.archive-safety summary { cursor: pointer; width: fit-content; }
.archive-safety p { margin-top: 10px; }
@media (max-width: 760px) {
  .archive-cleanup { align-items: stretch; flex-direction: column; }
  .archive-storage-body { padding: 16px; gap: 16px; }
  .archive-directories > div { grid-template-columns: minmax(0, 1fr); gap: 8px; }
  .archive-migration-form { grid-template-columns: minmax(0, 1fr); gap: 12px; }
  .archive-migration-form .form-actions button { width: 100%; }
  .archive-capacity { padding: 12px; }
  .archive-capacity strong { font-size: 20px; }
}
</style>
