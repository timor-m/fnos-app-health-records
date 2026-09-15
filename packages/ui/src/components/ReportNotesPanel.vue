<script setup lang="ts">
import { ref, watch } from 'vue';
import { Plus, Pencil, Trash2 } from '@lucide/vue';
import ImageViewer, { type ImageViewerPage } from './ImageViewer.vue';
import ReportNoteEditor from './ReportNoteEditor.vue';
import { request, apiUrl } from '../utils/api';
import { formatDatabaseTimeWithYear } from '../utils/time';
import { useConfirm } from '../composables/useConfirm';
import { useToast } from '../composables/useToast';
import type { ReportNote, ReportNotesResult } from '../../../shared/report-notes';

const props = defineProps<{ reportId: string }>();
const notes = ref<ReportNote[]>([]);
const canManage = ref(false);
const loading = ref(false);
const error = ref('');
const editing = ref<ReportNote | null | undefined>(undefined);
const viewer = ref<{ pages: ImageViewerPage[]; index: number } | null>(null);
const confirm = useConfirm();
const toast = useToast();
let loadSequence = 0;
async function load() {
  const sequence = ++loadSequence;
  loading.value = true; error.value = '';
  try {
    const result = await request<ReportNotesResult>(`reports/${props.reportId}/notes`);
    if (sequence !== loadSequence) return;
    notes.value = result.notes; canManage.value = result.canManage;
  } catch (cause) {
    if (sequence === loadSequence) { error.value = cause instanceof Error ? cause.message : '补充记录加载失败'; canManage.value = false; }
  } finally { if (sequence === loadSequence) loading.value = false; }
}
watch(() => props.reportId, () => { notes.value = []; canManage.value = false; editing.value = undefined; viewer.value = null; void load(); }, { immediate: true });
function imageUrl(note: ReportNote, assetId: string, variant = 'thumbnail') {
  return apiUrl(`reports/${props.reportId}/notes/${note.id}/assets/${assetId}?variant=${variant}`);
}
function preview(note: ReportNote, index: number) {
  viewer.value = { index, pages: note.assets.map(asset => ({ key: asset.id, label: asset.originalName,
    fullUrl: imageUrl(note, asset.id, 'preview'), previewUrl: imageUrl(note, asset.id),
    downloadUrl: imageUrl(note, asset.id, 'original'), downloadName: asset.originalName })) };
}
function saved(note: ReportNote) {
  const index = notes.value.findIndex(row => row.id === note.id);
  if (index < 0) notes.value.push(note); else notes.value[index] = note;
  editing.value = undefined; toast.show('补充记录已保存');
}
function remove(note: ReportNote) {
  const reportId = props.reportId;
  confirm.ask({ title: '删除这条补充记录？', message: '其中包含的图片也将一起隐藏，并在报告彻底删除时清理。', danger: true, confirmText: '删除', run: async () => {
    try {
      await request(`reports/${reportId}/notes/${note.id}`, { method: 'DELETE' });
      if (props.reportId === reportId) notes.value = notes.value.filter(row => row.id !== note.id);
      toast.show('补充记录已删除');
    } catch (cause) { toast.show(cause instanceof Error ? cause.message : '删除失败，请重试'); }
  } });
}
</script>

<template>
  <article class="preview-card report-notes-panel">
    <div class="section-title-row">
      <div><h4>补充记录<span v-if="notes.length" class="note-count">{{ notes.length }}</span></h4><p>个人补充资料，不参与报告识别</p></div>
      <button v-if="canManage" type="button" class="soft-action-button" @click="editing = null"><Plus :size="16" />添加</button>
    </div>
    <p v-if="loading" class="preview-hint" role="status">正在加载补充记录…</p>
    <div v-else-if="error" class="inline-panel-error" role="alert">{{ error }} <button type="button" @click="load">重试</button></div>
    <p v-else-if="!notes.length" class="preview-hint">可以添加与这份报告相关的说明或图片，例如医生口头交代、药品照片或后续补充资料。</p>
    <ol v-else class="report-notes-timeline">
      <li v-for="note in notes" :key="note.id" class="report-note-card">
        <header><time>{{ formatDatabaseTimeWithYear(note.createdAt) }}</time><small v-if="note.updatedAt !== note.createdAt">已编辑</small></header>
        <p v-if="note.contentText" class="report-note-text">{{ note.contentText }}</p>
        <div v-if="note.assets.length" class="report-note-images">
          <button v-for="(asset, index) in note.assets" :key="asset.id" type="button" :aria-label="`查看图片 ${index + 1}`" @click="preview(note, index)">
            <img :src="imageUrl(note, asset.id)" :alt="asset.originalName" loading="lazy" />
          </button>
        </div>
        <div v-if="canManage" class="report-note-actions">
          <button type="button" @click="editing = note"><Pencil :size="14" />编辑</button>
          <button type="button" @click="remove(note)"><Trash2 :size="14" />删除</button>
        </div>
      </li>
    </ol>
  </article>
  <ReportNoteEditor v-if="editing !== undefined" :key="reportId" :report-id="reportId" :note="editing" @close="editing = undefined" @saved="saved" />
  <Teleport to="body"><ImageViewer v-if="viewer" :pages="viewer.pages" :start-index="viewer.index" @close="viewer = null" /></Teleport>
</template>
