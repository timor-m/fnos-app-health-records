<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue';
import { Check, Files, Layers, LayoutGrid, FileText, GripVertical, Folder, ChevronRight, CornerUpLeft, CircleAlert } from '@lucide/vue';
import IndicatorHint from './IndicatorHint.vue';
import FormSelect from './FormSelect.vue';
import ImageViewer from './ImageViewer.vue';
import { buildUploadPlan } from '../utils/upload-plan';

type Mode = '' | 'independent' | 'merge' | 'custom';
const props = defineProps<{ files: Array<{ id: string; name: string; previewUrl?: string }>; attention?: number }>();
const emit = defineEmits<{ mode: [value: Mode]; plan: [value: string[][]] }>();
const mode = ref<Mode>('');
const modesElement = ref<HTMLElement | null>(null);
watch(() => props.attention, value => {
  if (!value || mode.value || !modesElement.value) return;
  const element = modesElement.value;
  const bounds = element.getBoundingClientRect();
  const viewport = window.visualViewport;
  // Reserve space for the fixed header and the mobile upload action bar.
  const top = (viewport?.offsetTop ?? 0) + 100;
  const bottom = (viewport?.offsetTop ?? 0) + (viewport?.height ?? window.innerHeight) - 180;
  if (bounds.top >= top && bounds.bottom <= bottom) return;
  element.scrollIntoView({
    block: 'center', inline: 'nearest',
    behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth'
  });
}, { flush: 'post' });
const requestedMode = ref<Mode>('');
const groups = ref<Array<{ id: string; name: string; files: string[] }>>([]);
const selected = ref<string[]>([]);
const destination = ref('');
const currentFolderId = ref('');
const previewId = ref('');
const removeFolderPending = ref(false);
const fileGrid = ref<HTMLElement | null>(null);
const draggedId = ref('');
const lastDroppedId = ref('');
const dropFolderId = ref('');
const dropFileId = ref('');
const dropFolder = computed(() => groups.value.find(group => group.id === dropFolderId.value));
const dragPosition = ref({ x: 0, y: 0 });
const dragPreview = computed(() => props.files.find(file => file.id === draggedId.value));
let pressTimer: ReturnType<typeof setTimeout> | undefined;
let pendingPress: { pointerId: number; x: number; y: number } | null = null;
function clearPress() {
  clearTimeout(pressTimer);
  const pending = pendingPress;
  pendingPress = null;
  if (pending && !sortDrag && fileGrid.value?.hasPointerCapture(pending.pointerId)) fileGrid.value.releasePointerCapture(pending.pointerId);
}
function pressCard(event: PointerEvent, id: string) {
  if (event.button !== 0 || sortDrag ||
    (event.target as HTMLElement).closest('button, input, select, textarea, a, [contenteditable], [data-no-sort]')) return;
  clearPress();
  pendingPress = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
  fileGrid.value?.setPointerCapture(event.pointerId);
  pressTimer = setTimeout(() => {
    if (pendingPress) startSort(event, id);
    clearPress();
  }, 380);
}
let sortDrag: { pointerId: number; handle: HTMLElement; groupId: string; original: string[] } | null = null;
function finishSort(cancel = false) {
  clearPress();
  const drag = sortDrag;
  sortDrag = null;
  draggedId.value = '';
  dropFolderId.value = '';
  dropFileId.value = '';
  if (!drag) return;
  const group = groups.value.find(group => group.id === drag.groupId);
  if (cancel && group) group.files = drag.original.filter(id => props.files.some(file => file.id === id));
  if (drag.handle.hasPointerCapture(drag.pointerId)) drag.handle.releasePointerCapture(drag.pointerId);
}
function startSort(event: PointerEvent, id: string) {
  if (event.button !== 0 || sortDrag) return;
  event.preventDefault();
  // Capture on the stable grid, not a card that changes DOM position.
  const handle = fileGrid.value;
  if (!handle) return;
  sortDrag = { pointerId: event.pointerId, handle, groupId: currentFolder.value?.id || '', original: [...(currentFolder.value?.files || [])] };
  draggedId.value = id;
  dragPosition.value = { x: event.clientX, y: event.clientY };
  handle.setPointerCapture(event.pointerId);
}
function dragSort(event: PointerEvent) {
  if (pendingPress && Math.hypot(event.clientX - pendingPress.x, event.clientY - pendingPress.y) > 8) clearPress();
  if (!sortDrag || sortDrag.pointerId !== event.pointerId) return;
  event.preventDefault();
  dragPosition.value = { x: event.clientX, y: event.clientY };
  const target = document.elementFromPoint(event.clientX, event.clientY);
  const folder = target?.closest<HTMLElement>('[data-drop-folder]');
  dropFolderId.value = folder && fileGrid.value?.contains(folder) ? folder.dataset.dropFolder || '' : '';
  const card = target?.closest<HTMLElement>('[data-sort-file]');
  dropFileId.value = !currentFolder.value && !dropFolderId.value && card && fileGrid.value?.contains(card) && card.dataset.sortFile !== draggedId.value ? card.dataset.sortFile || '' : '';
  if (!currentFolder.value) return;
  if (!card || !fileGrid.value?.contains(card)) return;
  const ids = currentFolder.value.files;
  const from = ids.indexOf(draggedId.value);
  const to = ids.indexOf(card.dataset.sortFile || '');
  if (from >= 0 && to >= 0 && from !== to) move(ids, from, to - from);
}
function endSort(event: PointerEvent) {
  clearPress();
  if (sortDrag?.pointerId !== event.pointerId) return;
  if (event.type === 'pointerup') {
    dragSort(event);
    const target = groups.value.find(group => group.id === dropFolderId.value);
    const id = draggedId.value;
    lastDroppedId.value = id;
    if (target && props.files.some(file => file.id === id)) {
      for (const group of groups.value) group.files = group.files.filter(fileId => fileId !== id);
      target.files.push(id);
      groups.value = groups.value.filter(group => group.files.length);
      selected.value = selected.value.filter(fileId => fileId !== id);
    } else if (!currentFolder.value && dropFileId.value && unassigned.value.some(file => file.id === id) && unassigned.value.some(file => file.id === dropFileId.value)) {
      const groupId = String(++groupNumber);
      groups.value.push({ id: groupId, name: `报告 ${groupId}`, files: [dropFileId.value, id] });
      selected.value = selected.value.filter(fileId => fileId !== id && fileId !== dropFileId.value);
    } else if (visibleFiles.value.some(file => file.id === id)) {
      selected.value = [...new Set([...selected.value, id])];
    }
  }
  finishSort(event.type !== 'pointerup');
}
onBeforeUnmount(() => finishSort(true));
const currentFolder = computed(() => groups.value.find(group => group.id === currentFolderId.value));
const visibleFiles = computed(() => currentFolder.value
  ? currentFolder.value.files.flatMap(id => props.files.find(file => file.id === id) || [])
  : unassigned.value);
const previewPages = computed(() => visibleFiles.value.filter(file => file.previewUrl).map(file => ({ key: file.id, fullUrl: file.previewUrl!, label: file.name })));
function navigate(id = '') {
  finishSort(true);
  currentFolderId.value = id;
  selected.value = currentFolder.value?.files.includes(lastDroppedId.value) ? [lastDroppedId.value] : [];
  destination.value = '';
  removeFolderPending.value = false;
  previewId.value = '';
}
onMounted(() => emit('mode', ''));
let groupNumber = 0;
const options = [
  { value: 'independent' as const, label: '独立报告', hint: '每个文件一份报告', icon: Files },
  { value: 'merge' as const, label: '合并报告', hint: '全部文件组成一份报告', icon: Layers },
  { value: 'custom' as const, label: '自定义分组', hint: '手动指定文件归属', icon: LayoutGrid }
];
const unassigned = computed(() => props.files.filter(file => !groups.value.some(group => group.files.includes(file.id))));
const groupOptions = computed(() => groups.value.filter(group => group.id !== currentFolderId.value).map(group => ({ value: group.id, label: group.name })));
const summary = computed(() => mode.value === 'merge' ? `将合并为 1 份报告 · ${props.files.length} 个文件`
  : mode.value === 'independent' ? `将创建 ${props.files.length} 份报告`
  : mode.value === 'custom' ? `已分组 ${groups.value.length} 份报告 · ${unassigned.value.length} 个文件待分组` : '请选择报告组织方式');
watch(() => buildUploadPlan(props.files.map(file => file.id), mode.value, groups.value.map(group => group.files)), plan => emit('plan', plan), { immediate: true });
function choose(value: Mode, confirmed = false) {
  if (value === mode.value) return;
  if (!confirmed && mode.value === 'custom' && groups.value.length) { requestedMode.value = value; return; }
  mode.value = value;
  lastDroppedId.value = '';
  groups.value = [];
  selected.value = [];
  destination.value = '';
  requestedMode.value = '';
  navigate();
  emit('mode', value);
}
function assign(newGroup: boolean) {
  if (!selected.value.length) return;
  let group = groups.value.find(item => item.id === destination.value);
  if (newGroup) {
    const id = String(++groupNumber);
    group = { id, name: `报告 ${id}`, files: [] };
    groups.value.push(group);
  }
  if (!group) return;
  const ids = visibleFiles.value.filter(file => selected.value.includes(file.id)).map(file => file.id);
  for (const existing of groups.value) existing.files = existing.files.filter(id => !ids.includes(id));
  group.files.push(...ids);
  groups.value = groups.value.filter(item => item.files.length);
  selected.value = [];
  destination.value = '';
  if (currentFolderId.value && !currentFolder.value) navigate();
}
function releaseSelected() {
  if (!currentFolder.value) return;
  currentFolder.value.files = currentFolder.value.files.filter(id => !selected.value.includes(id));
  groups.value = groups.value.filter(group => group.files.length);
  selected.value = [];
  if (!currentFolder.value) navigate();
}
function removeFolder() {
  groups.value = groups.value.filter(group => group.id !== currentFolderId.value);
  navigate();
}
function groupRemaining() {
  for (const file of unassigned.value) {
    const id = String(++groupNumber);
    groups.value.push({ id, name: `报告 ${id}`, files: [file.id] });
  }
  selected.value = [];
}
function move(ids: string[], index: number, delta: number) {
  if (index + delta < 0 || index + delta >= ids.length) return;
  const [id] = ids.splice(index, 1);
  ids.splice(index + delta, 0, id);
}
watch(() => props.files.map(file => file.id), ids => {
  selected.value = selected.value.filter(id => ids.includes(id));
  groups.value.forEach(group => { group.files = group.files.filter(id => ids.includes(id)); });
  groups.value = groups.value.filter(group => group.files.length);
  if (!groups.value.some(group => group.id === destination.value)) destination.value = '';
  if (currentFolderId.value && !currentFolder.value) navigate();
  if (!ids.includes(previewId.value)) previewId.value = '';
  if (ids.length < 2) choose('', true);
});
</script>

<template>
  <section v-if="files.length > 1" class="upload-organizer">
    <header><strong>报告组织方式</strong><IndicatorHint text="PDF 内的多页仍属于同一个文件。这里只决定文件如何组成报告，不会修改原件。" /></header>
    <div ref="modesElement" class="organizer-modes" role="group" aria-label="报告组织方式">
      <span v-if="attention && !mode" :key="attention" class="organizer-attention" aria-hidden="true"></span>
      <button v-for="option in options" :key="option.value" type="button" :class="{ selected: mode === option.value }"
        :aria-pressed="mode === option.value" @click="choose(option.value)">
        <component :is="option.icon" :size="19" /><span><strong>{{ option.label }}</strong><small>{{ option.hint }}</small></span>
        <Check v-if="mode === option.value" :size="16" />
      </button>
    </div>
    <div v-if="requestedMode" class="organizer-switch" role="alert">
      <CircleAlert :size="17" aria-hidden="true" />
      <span>切换将重置分组，文件不会删除。</span>
      <button class="soft-action-button" type="button" @click="requestedMode = ''">保留分组</button>
      <button class="soft-action-button" type="button" @click="choose(requestedMode, true)">确认切换</button>
    </div>
    <template v-if="mode === 'custom'">
      <div class="organizer-section-heading">
        <span>{{ currentFolder ? currentFolder.files.length + ' 个文件 · 按序组成一份报告' : groups.length + ' 个报告文件夹 · ' + unassigned.length + ' 个未分组文件' }}</span>
        <IndicatorHint text="一个文件夹就是一份报告，不支持嵌套。点击图片放大，勾选文件后可建组或移动。分组只在此页面暂存，刷新后需重新整理。" />
      </div>
      <nav class="organizer-path" aria-label="报告分组路径">
        <button type="button" :disabled="!currentFolder" @click="navigate()"><CornerUpLeft :size="16" />返回上一级</button>
        <button type="button" @click="navigate()">全部文件</button>
        <template v-if="currentFolder"><ChevronRight :size="16" /><strong>{{ currentFolder.name }}</strong></template>
      </nav>
      <div class="organizer-assignment">
        <button type="button" class="soft-action-button" :disabled="!visibleFiles.length" @click="selected = selected.length === visibleFiles.length ? [] : visibleFiles.map(file => file.id)">{{ selected.length && selected.length === visibleFiles.length ? '取消全选' : '全选文件' }}</button>
        <template v-if="selected.length">
          <span>已选 {{ selected.length }} 项</span>
          <button type="button" class="primary-button" @click="assign(true)">新建报告文件夹</button>
          <template v-if="groupOptions.length">
            <FormSelect v-model="destination" :options="groupOptions" placeholder="选择目标报告" aria-label="目标报告文件夹" />
            <button type="button" class="soft-action-button" :disabled="!destination" @click="assign(false)">移动到</button>
          </template>
          <button v-if="currentFolder" type="button" class="soft-action-button" @click="releaseSelected">移回全部文件</button>
        </template>
        <button v-else-if="!currentFolder && unassigned.length" type="button" class="soft-action-button" @click="groupRemaining">剩余文件各自成组</button>
        <button v-if="currentFolder && !selected.length" type="button" class="soft-action-button" @click="removeFolderPending = true">移除文件夹</button>
      </div>
      <div v-if="removeFolderPending" class="organizer-switch" role="alert">
        <CircleAlert :size="17" aria-hidden="true" />
        <span>移除文件夹后，文件将退回全部文件，不会删除原件。</span>
        <button type="button" class="soft-action-button" @click="removeFolderPending = false">取消</button>
        <button type="button" class="soft-action-button" @click="removeFolder">确认移除</button>
      </div>
      <div ref="fileGrid" class="organizer-files" @pointermove="dragSort" @pointerup="endSort" @pointercancel="endSort" @lostpointercapture="endSort" @pointerleave="clearPress" @touchmove="draggedId && $event.preventDefault()" @keydown.esc="finishSort(true)">
        <template v-if="!currentFolder">
          <button v-for="group in groups" :key="group.id" :data-drop-folder="group.id" type="button" class="organizer-folder" :class="{ 'is-drop-target': dropFolderId === group.id, 'is-selected': group.files.includes(lastDroppedId) }" :aria-label="'打开 ' + group.name" @click="navigate(group.id)">
            <Folder :size="48" /><strong>{{ group.name }}</strong><small>{{ group.files.length }} 个文件</small>
          </button>
        </template>
        <article v-for="(item, index) in visibleFiles" :key="item.id" :data-sort-file="item.id" class="organizer-file" :class="{ checked: selected.includes(item.id), 'is-dragging': draggedId === item.id, 'is-merge-target': dropFileId === item.id }" @pointerdown="pressCard($event, item.id)" @dragstart.prevent @contextmenu.prevent>
          <div class="organizer-file-heading">
            <input v-model="selected" type="checkbox" :value="item.id" :aria-label="'选择 ' + item.name" />
            <small>{{ currentFolder ? index + 1 : '未分组' }}</small>
          </div>
          <button class="organizer-thumbnail" type="button" :disabled="!item.previewUrl" :aria-label="'放大预览 ' + item.name" @click="previewId = item.id">
            <img v-if="item.previewUrl" :src="item.previewUrl" alt="" loading="lazy" draggable="false" /><FileText v-else :size="36" />
          </button>
          <span data-no-sort :title="item.name">{{ item.name }}</span>
          <small v-if="!item.previewUrl" class="organizer-preview-note">此文件暂不支持预览</small>
          <div class="organizer-file-order">
            <button type="button" class="organizer-sort-handle" :aria-label="(currentFolder ? '拖拽排序 ' : '拖入报告文件夹 ') + item.name" :title="currentFolder ? '拖动排序，也可用方向键调整' : '拖到已有报告文件夹，松手归入报告'"
              @pointerdown.stop="startSort($event, item.id)"
              @keydown.esc="finishSort(true)" @keydown.up.prevent="currentFolder && move(currentFolder.files, index, -1)" @keydown.left.prevent="currentFolder && move(currentFolder.files, index, -1)" @keydown.down.prevent="currentFolder && move(currentFolder.files, index, 1)" @keydown.right.prevent="currentFolder && move(currentFolder.files, index, 1)"><GripVertical :size="18" /></button>
          </div>
        </article>
      </div>
      <Teleport to="body">
        <div v-if="dragPreview" class="organizer-drag-preview" :style="{ left: dragPosition.x + 'px', top: dragPosition.y + 'px' }" aria-hidden="true">
          <img v-if="dragPreview.previewUrl" :src="dragPreview.previewUrl" alt="" draggable="false" /><FileText v-else :size="32" />
          <span>{{ dragPreview.name }}</span>
          <small v-if="dropFolder">松手移入 {{ dropFolder.name }}</small>
          <small v-else-if="dropFileId">松手与目标文件合并为一份报告</small>
        </div>
        <ImageViewer v-if="previewId && previewPages.some(page => page.key === previewId)" class="organizer-viewer" :pages="previewPages" :start-index="previewPages.findIndex(page => page.key === previewId)" @close="previewId = ''" />
      </Teleport>
    </template>
    <p class="organizer-summary" role="status">{{ summary }}</p>
    <small v-if="mode" class="organizer-preview-note">文件传齐后逐份进入识别队列；每个文件仅归入一份报告。</small>
  </section>
</template>

<style scoped>
.organizer-viewer { z-index: 150; }
.organizer-drag-preview { position: fixed; z-index: 160; pointer-events: none; transform: translate(-50%, -75%) rotate(3deg); width: 100px; padding: 8px; display: grid; gap: 6px; border: 1px solid var(--brand); border-radius: 12px; background: var(--surface); color: var(--ink); box-shadow: 0 12px 28px #0004; }
.organizer-drag-preview img { width: 100%; height: 70px; object-fit: contain; }
.organizer-drag-preview span { font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.organizer-file { user-select: none; -webkit-user-select: none; -webkit-touch-callout: none; }
.organizer-file img { -webkit-user-drag: none; user-select: none; }
.upload-organizer { margin-block: 20px; padding: 16px; border: 1px solid var(--line); border-radius: 16px; background: var(--surface); min-width: 0; }
.upload-organizer header, .organizer-section-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
.organizer-modes { position: relative; display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); gap: 10px; }
.organizer-attention { position: absolute; inset: -4px; border: 2px solid var(--danger); border-radius: 15px; pointer-events: none; opacity: 0; animation: organizer-attention-pulse .8s ease-in-out 3; }
@keyframes organizer-attention-pulse { 0%, 100% { opacity: 0; } 35%, 65% { opacity: 1; } }
@media (prefers-reduced-motion: reduce) {
  .organizer-attention { animation: none; opacity: 1; }
}
.organizer-modes button { display: flex; align-items: center; gap: 10px; text-align: left; padding: 12px; border: 1px solid var(--line); border-radius: 12px; background: transparent; color: var(--ink); min-width: 0; cursor: pointer; }
.organizer-modes button.selected { border-color: var(--brand); color: var(--brand); }
.organizer-modes button > span { flex: 1; min-width: 0; }
.organizer-modes strong, .organizer-modes small { display: block; }
.organizer-modes small, .organizer-preview-note { color: var(--muted); font-size: 12px; margin-top: 4px; }
.organizer-section-heading { margin-top: 20px; font-size: 13px; line-height: 1.5; color: var(--muted); }
.organizer-files { display: grid; grid-template-columns: repeat(auto-fill,minmax(120px,1fr)); gap: 8px; }
.organizer-file { display: flex; flex-direction: column; gap: 8px; padding: 10px; border: 1px solid var(--line); border-radius: 10px; min-width: 0; }
.organizer-file { transition: background-color .15s, border-color .15s; }
.organizer-file.checked, .organizer-file:focus-within { border-color: var(--brand); background: var(--brand-softer); }
.organizer-file.is-merge-target { border-color: var(--brand); background: var(--brand-softer); box-shadow: inset 0 0 0 2px var(--brand); }
@media (hover: hover) and (pointer: fine) {
  .organizer-file:hover, .organizer-folder:hover { border-color: var(--brand); background: var(--brand-softer); }
}
.organizer-file img { width: 100%; height: 80px; object-fit: contain; }
.organizer-file span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
.organizer-assignment, .organizer-switch { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-block: 12px; }
.organizer-switch { padding: 10px 12px; border: 1px solid var(--amber); border-radius: 10px; background: var(--amber-soft); color: var(--amber); font-size: 13px; line-height: 1.5; }
.organizer-switch > svg { flex-shrink: 0; }
.organizer-switch > span { flex: 1 1 180px; min-width: 0; }
.organizer-switch > button { font-size: 12px; min-height: 32px; padding: 6px 12px; }
.organizer-assignment > :deep(.form-select) { max-width: 200px; }
.organizer-path { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-top: 20px; font-size: 13px; }
.organizer-path button { display: inline-flex; align-items: center; gap: 4px; border: 0; background: transparent; color: var(--brand); padding: 6px 0; cursor: pointer; }
.organizer-folder { display: flex; align-items: center; justify-content: center; flex-direction: column; gap: 8px; padding: 18px 10px; min-height: 154px; border: 1px solid var(--line); border-radius: 10px; background: var(--fill-2); color: var(--ink); cursor: pointer; min-width: 0; }
.organizer-folder svg { color: var(--brand); }
.organizer-folder.is-drop-target { border-color: var(--brand); box-shadow: inset 0 0 0 2px var(--brand); background: var(--brand-softer, var(--fill-2)); }
.organizer-folder.is-selected { border-color: var(--brand); background: var(--brand-softer); }
.organizer-folder small, .organizer-file-heading small { color: var(--muted); }
.organizer-file-heading { display: flex; align-items: center; justify-content: space-between; }
.organizer-file-heading input { width: 20px; height: 20px; margin: 0; accent-color: var(--brand); }
.organizer-thumbnail { display: grid; place-items: center; width: 100%; height: 86px; padding: 0; border: 0; border-radius: 6px; background: var(--fill-2); color: var(--muted); cursor: zoom-in; }
.organizer-file-order { display: flex; justify-content: flex-end; gap: 6px; margin-top: auto; }
.organizer-file.is-dragging { border-color: var(--brand); background: var(--brand-softer); opacity: .65; }
.organizer-file-order .organizer-sort-handle { touch-action: none; user-select: none; cursor: grab; }
.organizer-file-order .organizer-sort-handle:active { cursor: grabbing; }
.organizer-file-order button { border: 0; background: var(--fill-2); color: var(--ink); border-radius: 999px; width: 32px; height: 32px; display: grid; place-items: center; cursor: pointer; }
.upload-organizer button:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; }
.organizer-summary { margin: 14px 0 0; font-size: 13px; }
.upload-organizer button:disabled { opacity: .4; cursor: default; }
@media (max-width: 760px) {
  .upload-organizer { padding: 10px; margin-block: 12px; }
  .upload-organizer header { margin-bottom: 8px; gap: 8px; font-size: 14px; }
  .organizer-section-heading { margin: 10px 0 4px; gap: 6px; font-size: 12px; }
  .organizer-path { margin-top: 4px; gap: 6px; font-size: 12px; }
  .organizer-path button { min-height: 36px; }
  .organizer-assignment { gap: 6px; margin-block: 8px; font-size: 12px; }
  .organizer-assignment > button { min-height: 36px; padding: 6px 10px; font-size: 12px; }
  .organizer-summary { margin-top: 8px; font-size: 12px; line-height: 1.5; }
  .upload-organizer > .organizer-preview-note { display: block; margin-top: 2px; line-height: 1.5; }
  .organizer-files { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; }
  .organizer-file { padding: 6px; gap: 6px; }
  .organizer-file > span { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; white-space: normal; overflow-wrap: anywhere; line-height: 1.4; min-height: 2.8em; }
  .organizer-file-heading { min-height: 32px; }
  .organizer-file-heading input { width: 24px; height: 24px; cursor: pointer; }
  .organizer-thumbnail, .organizer-file img { height: 64px; }
  .organizer-folder { padding: 12px 6px; min-height: 140px; }
  .organizer-file-order { gap: 4px; }
  .organizer-file-order button { width: 34px; height: 34px; flex: 0 0 34px; }
  .organizer-modes { grid-template-columns: repeat(3,minmax(0,1fr)); gap: 6px; }
  .organizer-modes button { position: relative; justify-content: center; min-height: 54px; padding: 8px 4px; gap: 0; text-align: center; }
  .organizer-modes button > svg:first-child { display: none; }
  .organizer-modes button > svg:last-child { position: absolute; top: 3px; right: 3px; width: 10px; height: 10px; }
  .organizer-modes strong { font-size: 12px; line-height: 1.5; }
  .organizer-modes small { margin-top: 2px; font-size: 11px; line-height: 1.4; overflow-wrap: anywhere; }
}
@media (max-width: 359px) {
  .organizer-files { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
</style>
