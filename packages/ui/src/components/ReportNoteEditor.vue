<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { ArrowLeft, ArrowRight, FileImage, LoaderCircle, Plus, Trash2, X } from '@lucide/vue';
import ImageViewer, { type ImageViewerPage } from './ImageViewer.vue';
import { request, requestUpload, apiUrl } from '../utils/api';
import { useScrollLock } from '../composables/useScrollLock';
import { useConfirm } from '../composables/useConfirm';
import { reportNoteLimits, type ReportNote } from '../../../shared/report-notes';
import { maxUploadFileBytes } from '../../../shared/upload-limits';

type SelectedImage = { key: string; id?: string; file?: File; originalName: string; fileSize: number; url: string; uploadToken?: string; status: 'ready' | 'uploading' | 'failed'; progress: number; error?: string };
const props = defineProps<{ reportId: string; note: ReportNote | null }>();
const emit = defineEmits<{ close: []; saved: [note: ReportNote] }>();
const content = ref(props.note?.contentText || '');
// getRandomValues also works on HTTP NAS addresses, unlike randomUUID.
const randomId = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
const createId = `note_${randomId()}`;
const images = ref<SelectedImage[]>((props.note?.assets || []).map(asset => ({ key: asset.id, id: asset.id, originalName: asset.originalName, fileSize: asset.fileSize,
  url: apiUrl(`reports/${props.reportId}/notes/${props.note!.id}/assets/${asset.id}?variant=preview`), status: 'ready', progress: 100 })));
const saving = ref(false);
const error = ref('');
const fileInput = ref<HTMLInputElement | null>(null);
const panel = ref<HTMLElement | null>(null);
const viewport = ref({ height: window.visualViewport?.height || window.innerHeight, top: window.visualViewport?.offsetTop || 0 });
const previousFocus = document.activeElement as HTMLElement | null;
function measureViewport() { viewport.value = { height: window.visualViewport?.height || window.innerHeight, top: window.visualViewport?.offsetTop || 0 }; }
onMounted(() => {
  window.visualViewport?.addEventListener('resize', measureViewport);
  window.visualViewport?.addEventListener('scroll', measureViewport);
  panel.value?.focus({ preventScroll: true });
});
const viewer = ref<{ pages: ImageViewerPage[]; index: number } | null>(null);
const confirm = useConfirm();
const busy = computed(() => saving.value || images.value.some(image => image.status === 'uploading'));
const dirty = computed(() => content.value !== (props.note?.contentText || '') || images.value.map(image => image.id || image.key).join(',') !== (props.note?.assets || []).map(image => image.id).join(','));
const objectUrls = new Set<string>();
useScrollLock(computed(() => true));
onBeforeUnmount(() => {
  objectUrls.forEach(url => URL.revokeObjectURL(url));
  window.visualViewport?.removeEventListener('resize', measureViewport);
  window.visualViewport?.removeEventListener('scroll', measureViewport);
  previousFocus?.focus({ preventScroll: true });
});
function trapFocus(event: KeyboardEvent) {
  const buttons = Array.from(panel.value?.querySelectorAll<HTMLElement>('button:not(:disabled), textarea:not(:disabled)') || []);
  const first = buttons[0], last = buttons.at(-1);
  if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.value)) { event.preventDefault(); last?.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
}
const formatSize = (bytes: number) => bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
function close() {
  if (busy.value) return;
  if (!dirty.value) { emit('close'); return; }
  confirm.ask({ title: '放弃未保存的补充记录？', message: '尚未保存的文字和图片不会加入报告。', confirmText: '放弃', run: () => emit('close') });
}
async function upload(image: SelectedImage) {
  if (!image.file) return;
  image.status = 'uploading'; image.error = ''; image.progress = 0;
  try {
    const body = new FormData(); body.append('file', image.file);
    const result = await requestUpload<{ uploadToken: string }>(`reports/${props.reportId}/notes/uploads`, body, percent => { image.progress = percent; });
    image.uploadToken = result.uploadToken;
    image.url = apiUrl(`reports/${props.reportId}/notes/uploads/${result.uploadToken}`);
    image.status = 'ready';
  } catch (cause) { image.status = 'failed'; image.error = cause instanceof Error ? cause.message : '图片上传失败，请重试'; }
}
async function selectFiles(files: File[]) {
  if (busy.value) return;
  error.value = '';
  if (images.value.length + files.length > reportNoteLimits.images) { error.value = `每条最多 ${reportNoteLimits.images} 张图片`; return; }
  for (const file of files) {
    if (!/\.(jpe?g|png|webp|heic|heif)$/i.test(file.name)) { error.value = '暂不支持此文件格式'; continue; }
    if (!file.size || file.size > maxUploadFileBytes) { error.value = '单张图片须大于 0 且不超过 40 MB'; continue; }
    const url = URL.createObjectURL(file); objectUrls.add(url);
    images.value.push({ key: randomId(), file, originalName: file.name, fileSize: file.size, url, status: 'uploading', progress: 0 });
    await upload(images.value[images.value.length - 1]);
  }
}
function picked(event: Event) { const target = event.target as HTMLInputElement; const files = Array.from(target.files || []); target.value = ''; void selectFiles(files); }
function dropped(event: DragEvent) { void selectFiles(Array.from(event.dataTransfer?.files || [])); }
function move(index: number, delta: number) { const [image] = images.value.splice(index, 1); images.value.splice(index + delta, 0, image); }
function preview(index: number) {
  viewer.value = { index, pages: images.value.map(image => ({ key: image.key, label: image.originalName, fullUrl: image.url,
    downloadUrl: image.url.startsWith('blob:') ? image.url : `${image.url.split('?')[0]}?variant=original`, downloadName: image.originalName })) };
}
async function save() {
  if (busy.value) return;
  error.value = '';
  if (!content.value.trim() && !images.value.length) { error.value = '请填写补充说明或添加图片'; return; }
  if (images.value.some(image => image.status !== 'ready')) { error.value = '有图片上传失败，请重试或移除后保存'; return; }
  saving.value = true;
  try {
    const note = await request<ReportNote>(`reports/${props.reportId}/notes${props.note ? `/${props.note.id}` : ''}`, {
      method: props.note ? 'PATCH' : 'POST', body: JSON.stringify({ id: createId, contentText: content.value, updatedAt: props.note?.updatedAt,
        assets: images.value.map(image => image.id ? { id: image.id } : { uploadToken: image.uploadToken }) }) });
    emit('saved', note);
  } catch (cause) { error.value = cause instanceof Error ? cause.message : '保存失败，请重试'; }
  finally { saving.value = false; }
}
</script>

<template>
  <Teleport to="body">
    <div class="modal-backdrop report-edit-backdrop report-note-backdrop" :style="{ '--note-viewport-height': `${viewport.height}px`, top: `${viewport.top}px`, height: `${viewport.height}px`, bottom: 'auto' }" @click.self="close" @keydown.esc.stop="!viewer && close()">
      <section ref="panel" tabindex="-1" class="modal-panel report-note-editor" role="dialog" aria-modal="true" aria-labelledby="note-editor-title" @keydown.tab="trapFocus">
        <header class="report-note-editor-heading"><h3 id="note-editor-title">{{ note ? '编辑补充记录' : '添加补充记录' }}</h3><button type="button" class="plain-icon-button" aria-label="关闭" :disabled="busy" @click="close"><X :size="20" /></button></header>
        <form class="report-note-form" @submit.prevent="save">
          <div class="report-note-editor-body">
            <label class="report-note-label" for="note-content">补充说明</label>
            <textarea id="note-content" v-model="content" :maxlength="reportNoteLimits.textLength" rows="4" :disabled="saving" placeholder="例如：医生说三个月后复查，或补充与这份报告相关的信息……" />
            <div class="report-note-upload-heading"><span>图片 <small>{{ images.length }} / {{ reportNoteLimits.images }}</small></span><small>每张不超过 40 MB</small></div>
            <div class="report-note-dropzone" @dragover.prevent @drop.prevent="dropped">
              <div v-if="images.length" class="report-note-selected-images">
                <article v-for="(image, index) in images" :key="image.key">
                  <button type="button" class="report-note-selected-preview" :aria-label="`预览图片 ${index + 1}`" @click="preview(index)"><img v-if="!image.file || !/\.hei[cf]$/i.test(image.file.name) || image.uploadToken" :src="image.url" alt="" /><FileImage v-else :size="28" /></button>
                  <span class="report-note-filename" :title="image.originalName">{{ image.originalName }}</span><small>{{ formatSize(image.fileSize) }}</small>
                  <div v-if="image.status === 'uploading'" class="report-note-upload-state" role="status"><progress :value="image.progress" max="100" /><small>{{ image.progress === 100 ? '生成预览中…' : `上传中 ${image.progress}%` }}</small></div>
                  <div v-if="image.status === 'failed'" class="report-note-upload-state" role="alert"><small>{{ image.error }}</small><button type="button" :disabled="busy" @click="upload(image)">重试</button></div>
                  <div class="report-note-image-actions"><button type="button" aria-label="向前移动" :disabled="busy || index === 0" @click="move(index, -1)"><ArrowLeft :size="16" /></button><button type="button" aria-label="向后移动" :disabled="busy || index === images.length - 1" @click="move(index, 1)"><ArrowRight :size="16" /></button><button type="button" aria-label="移除图片" :disabled="busy" @click="images.splice(index, 1)"><Trash2 :size="16" /></button></div>
                </article>
              </div>
              <button v-if="images.length < reportNoteLimits.images" type="button" class="report-note-add-image" :disabled="busy" @click="fileInput?.click()"><Plus :size="18" />添加图片<span>JPG / PNG / WebP / HEIC</span></button>
              <input ref="fileInput" type="file" hidden multiple accept="image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif" @change="picked" />
            </div>
            <p class="preview-hint">补充资料不会改变报告原件，也不会参与 OCR 或 AI 识别。</p>
            <p v-if="error" class="inline-panel-error" role="alert">{{ error }}</p>
          </div>
          <footer class="form-actions report-note-editor-actions"><button type="button" :disabled="busy" @click="close">取消</button><button type="submit" class="primary-button" :disabled="busy"><LoaderCircle v-if="saving" class="spin-icon" :size="16" />{{ saving ? '保存中…' : '保存' }}</button></footer>
        </form>
      </section>
    </div>
    <ImageViewer v-if="viewer" :pages="viewer.pages" :start-index="viewer.index" @close="viewer = null" />
  </Teleport>
</template>
