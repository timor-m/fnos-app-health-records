<script setup lang="ts">
import { computed, nextTick, onDeactivated, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue';
import { RouterLink, useRouter } from 'vue-router';
import { useScrollLock } from '../composables/useScrollLock';
import HealthCategoryIcon from './HealthCategoryIcon.vue';
import { Camera, ChevronRight, Plus, Link2 } from '@lucide/vue';
import { useAppContext } from '../composables/useAppContext';
import { useToast } from '../composables/useToast';
import { useUnsavedRecord } from '../composables/useUnsavedRecord';
import { requestUpload } from '../utils/api';
import { createUuid } from '../utils/uuid';
import { maxUploadFileBytes } from '../../../shared/upload-limits';

const props = defineProps<{
  placement: 'mobile' | 'desktop' | 'inline';
  processId?:string;
  symptomDialog?:boolean;
  relatedRecord?: {kind:string;id:string};
  memberId?: string;
  label?: string;
  canManage: boolean;
  disabled?:boolean;
  routeKey: string;
}>();

const emit=defineEmits<{associate:[];symptom:[opener:HTMLElement|null]}>();
const router = useRouter();
const triggerLabel = computed(() => props.label || (props.placement === 'mobile' ? '拍照或新增记录' : '新增'));
const open = ref(false);
const trigger = ref<HTMLButtonElement | null>(null);
const panel = ref<HTMLElement | null>(null);
const panelStyle = ref<Record<string,string>>({});
const menuId = `quick-add-${props.placement}`;
useScrollLock(computed(() => open.value && props.placement === 'inline'));

const app = useAppContext();
const toast = useToast();
const camera = ref<HTMLInputElement | null>(null);
const photo = shallowRef<{ memberId: string; file: File; key: string } | null>(null);
const photoBusy = ref(false);
const photoProgress = ref(0);
const photoError = ref('');
let cameraMemberId = '';
let mounted = true;
const photoGuard = useUnsavedRecord(() => photo.value?.key || '', photoBusy, () => props.placement === 'mobile');

watch(() => props.placement === 'mobile' ? [app.selectedMemberId.value, app.session.value?.id, props.canManage] : [], () => {
  cameraMemberId = '';
  photo.value = null;
  photoError.value = '';
  photoGuard.reset();
}, { flush: 'sync' });

function takePhoto() {
  if (!props.canManage || props.disabled || photoBusy.value || photo.value || !app.selectedMemberId.value) return;
  cameraMemberId = app.selectedMemberId.value;
  camera.value?.click();
}

async function pickPhoto(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file || photoBusy.value || !props.canManage || props.disabled || !cameraMemberId || cameraMemberId !== app.selectedMemberId.value) return;
  close();
  photoError.value = '';
  if (!/\.(heic|heif|jpe?g|png|webp)$/i.test(file.name) && !/^image\/(heic|heif|jpeg|png|webp)$/i.test(file.type)) {
    photoError.value = '请使用 HEIC、JPEG、PNG 或 WebP 照片，也可通过“上传资料”选择文件。';
    return;
  }
  if (!file.size || file.size > maxUploadFileBytes) {
    photoError.value = file.size ? '单张照片不能超过 40 MB' : '照片为空，请重新拍摄';
    return;
  }
  try {
    photo.value = { memberId: cameraMemberId, file, key: createUuid() };
    await uploadPhoto();
  } catch {
    photoError.value = '无法准备上传，请通过“上传资料”重试';
  }
}

async function uploadPhoto() {
  const current = photo.value;
  if (!current || photoBusy.value || !props.canManage || props.disabled || current.memberId !== app.selectedMemberId.value) return;
  photoBusy.value = true;
  photoProgress.value = 0;
  photoError.value = '';
  try {
    const body = new FormData();
    body.append('memberId', current.memberId);
    body.append('requestKey', current.key);
    body.append('manifest', JSON.stringify({ pages: [{ rotation: 0, size: current.file.size }] }));
    body.append('files', current.file, current.file.name);
    await requestUpload('uploads', body, percent => { if (mounted && photo.value === current) photoProgress.value = percent; });
    if (!mounted || photo.value !== current) return;
    photo.value = null;
    photoGuard.reset();
    app.notifyDataChanged();
    toast.show('已保存，正在识别，可到记录页查看', 3500);
  } catch (cause) {
    if (mounted && photo.value === current) photoError.value = cause instanceof Error ? cause.message : '上传失败，请重试';
  } finally {
    if (mounted) photoBusy.value = false;
  }
}

function dismissPhoto() {
  if (photoBusy.value) return;
  photo.value = null;
  photoError.value = '';
  photoGuard.reset();
}

function updatePanelPosition(event?: Event) {
  if (!open.value || props.placement !== 'inline' || !panel.value || !trigger.value) return;
  if (event?.type === 'scroll' && event.target instanceof Node && panel.value.contains(event.target)) return;
  const viewport = window.visualViewport;
  const viewportLeft = viewport?.offsetLeft || 0;
  const viewportTop = viewport?.offsetTop || 0;
  const viewportWidth = viewport?.width || window.innerWidth;
  const viewportHeight = viewport?.height || window.innerHeight;
  const padding = 12, gap = 6;
  const width = Math.max(0, Math.min(330, viewportWidth - padding * 2));
  panel.value.style.width = `${width}px`;
  const rect = trigger.value.getBoundingClientRect();
  const contentHeight = panel.value.scrollHeight + 2;
  const above = Math.max(0, rect.top - viewportTop - padding - gap);
  const below = Math.max(0, viewportTop + viewportHeight - padding - rect.bottom - gap);
  const upward = below < contentHeight && above > below;
  const available = Math.max(0, Math.min(upward ? above : below, viewportHeight - padding * 2));
  const height = Math.min(contentHeight, available);
  const left = Math.max(viewportLeft + padding, Math.min(rect.left, viewportLeft + viewportWidth - width - padding));
  const preferredTop = upward ? rect.top - gap - height : rect.bottom + gap;
  const top = Math.max(viewportTop + padding, Math.min(preferredTop, viewportTop + viewportHeight - padding - height));
  panelStyle.value = { left:`${left}px`, top:`${top}px`, width:`${width}px`, maxHeight:`${available}px`, visibility:'visible' };
}

function removePositionListeners() {
  window.removeEventListener('resize', updatePanelPosition);
  window.removeEventListener('scroll', updatePanelPosition, true);
  window.visualViewport?.removeEventListener('resize', updatePanelPosition);
  window.visualViewport?.removeEventListener('scroll', updatePanelPosition);
}
watch(open, value => {
  removePositionListeners();
  if (value && props.placement === 'inline') {
    window.addEventListener('resize', updatePanelPosition);
    window.addEventListener('scroll', updatePanelPosition, true);
    window.visualViewport?.addEventListener('resize', updatePanelPosition);
    window.visualViewport?.addEventListener('scroll', updatePanelPosition);
  }
});

function target(entry:typeof entries[number]) {
 const context=props.processId?{processId:props.processId,memberId:props.memberId,returnTo:props.routeKey}:props.relatedRecord?{relatedKind:props.relatedRecord.kind,relatedId:props.relatedRecord.id,memberId:props.memberId,returnTo:props.routeKey}:{};
 if(entry.category==='medication'){const origin=new URL(props.routeKey,'https://health.invalid');const query=origin.pathname==='/events'?Object.fromEntries(origin.searchParams):{};delete query.recordKind;delete query.recordId;return {path:'/events',query:{...query,...context,add:'medication'}};}
 return entry.category==='vaccination'||entry.category==='symptom'||entry.category==='monitoring'||props.relatedRecord||props.processId?{path:entry.to,query:{returnTo:props.routeKey,...context}}:entry.to;
}

const entries = [
  { label: '上传资料', hint: '自动归类报告、用药单和接种原件', to: '/upload', category: 'report' },
  { label: '症状 / 不适', hint: '记录症状及后续变化', to: '/add/symptom', category: 'symptom' },
  { label: '记录测量', hint: '血压、体格、血糖、体温、血氧等', to: '/add/measurement', category: 'monitoring' },
  { label: '用药', hint: '从用药单带入，或手动记录', to: '/events?add=medication', category: 'medication' },
  { label: '接种', hint: '填写接种日期、剂次和下一剂提醒', to: '/add/vaccination', category: 'vaccination' }
] as const;

function isAction(entry: typeof entries[number]) {
  return entry.category === 'medication' || (entry.category === 'symptom' && props.symptomDialog);
}
async function choose(entry: typeof entries[number]) {
  const destination = entry.category === 'medication' ? target(entry) : null;
  const symptom = entry.category === 'symptom' && props.symptomDialog;
  close();
  if (symptom) emit('symptom', trigger.value);
  else if (destination) await router.push(destination);
}

async function toggle() {
  if (!props.canManage||props.disabled) return;
  open.value = !open.value;
  if (open.value) {
    await nextTick();
    if (!open.value) return;
    updatePanelPosition();
    panel.value?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus({preventScroll:true});
  }
}

function close(restoreFocus = false) {
  open.value = false;
  panelStyle.value = {};
  if (restoreFocus) trigger.value?.focus();
}

function onKeydown(event: KeyboardEvent) {
  if (!open.value) return;
  const items = Array.from(panel.value?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') || []);
  const index = items.indexOf(document.activeElement as HTMLElement);
  if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
      : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  }
  if (event.key === 'Tab') close(true);
  if (open.value && event.key === 'Escape') {
    event.preventDefault();
    close(true);
  }
}

watch(() => props.routeKey, () => close());
watch(() => props.placement, () => close());
watch(() => props.disabled, disabled => { if(disabled)close(); });
watch(() => props.canManage, allowed => { if (!allowed) close(); });
onMounted(() => window.addEventListener('keydown', onKeydown));
onDeactivated(() => close());
onUnmounted(() => { mounted = false; window.removeEventListener('keydown', onKeydown); removePositionListeners(); });
</script>

<template>
  <div class="quick-add" :class="`quick-add--${placement}`">
    <input v-if="placement === 'mobile'" ref="camera" type="file" accept="image/*" capture="environment" hidden aria-label="快速拍摄单张报告" @change="pickPhoto" />
    <Teleport to="body">
      <div v-if="placement === 'mobile' && (photoBusy || photoError)" class="quick-photo-status" :role="photoError ? 'alert' : 'status'">
        <template v-if="photoBusy">{{ photoProgress < 100 ? `正在上传照片 ${photoProgress}%` : '正在保存照片…' }}</template>
        <template v-else>{{ photoError }}<button v-if="photo && canManage && !disabled" type="button" @click="uploadPhoto">重试上传</button><button type="button" @click="dismissPhoto">{{ photo ? '放弃上传' : '关闭' }}</button></template>
      </div>
    </Teleport>
    <button ref="trigger" type="button" class="quick-add-trigger" :class="{ 'is-open': open }"
      :aria-label="canManage ? triggerLabel : '当前成员只有查看权限'"
      aria-haspopup="menu" :aria-expanded="open" :aria-controls="menuId"
      :disabled="!canManage||disabled" @click="toggle">
      <span class="quick-add-icon"><Plus :size="placement==='mobile'?28:placement==='inline'?16:19" :stroke-width="2.5"/></span>
      <span v-if="placement !== 'mobile'">{{label||'新增'}}</span>
    </button>
    <template v-if="open">
      <Teleport to="body">
        <div class="quick-add-backdrop" :class="`quick-add-backdrop--${placement}`" aria-hidden="true" @click="close(true)" />
      </Teleport>
      <Teleport to="body" :disabled="placement!=='inline'">
      <div ref="panel" :id="menuId" class="quick-add-panel" :class="{'quick-add-panel--inline':placement==='inline'}" :style="panelStyle" role="menu" aria-label="新增记录类型">
        <button v-if="placement === 'mobile'" type="button" class="quick-add-entry quick-photo-entry" role="menuitem" :disabled="photoBusy || !!photo" @click="takePhoto">
          <span class="quick-add-entry-icon"><Camera :size="28" /></span>
          <span class="quick-add-entry-copy"><strong>快速拍照</strong><small>单张报告，拍照确认后直接上传</small></span>
          <ChevronRight :size="16" class="quick-add-chevron" />
        </button>
        <button v-if="processId||relatedRecord" type="button" class="quick-add-entry quick-add-associate" role="menuitem" @click="close();emit('associate')"><span class="quick-add-entry-icon"><Link2 :size="24"/></span><span class="quick-add-entry-copy"><strong>{{processId?'添加记录':'关联历程'}}</strong><small>{{processId?'选择已有记录加入当前历程':'选择相关记录，形成或加入健康历程'}}</small></span><ChevronRight :size="16"/></button>
        <component v-for="entry in entries" :key="entry.to" :is="isAction(entry)?'button':RouterLink" :to="isAction(entry)?undefined:target(entry)" :type="isAction(entry)?'button':undefined"
          class="quick-add-entry" role="menuitem" @click="choose(entry)">
          <span class="quick-add-entry-icon"><HealthCategoryIcon :category="entry.category" :size="34" /></span>
          <span class="quick-add-entry-copy"><strong>{{ entry.label }}</strong><small>{{ entry.hint }}</small></span>
          <ChevronRight :size="16" class="quick-add-chevron" />
        </component>
        <button v-if="placement !== 'mobile'" type="button" class="quick-add-entry is-disabled" role="menuitem" disabled aria-label="影像，暂未开放">
          <span class="quick-add-entry-icon"><HealthCategoryIcon category="imaging" :size="34" /></span>
          <span class="quick-add-entry-copy"><strong>影像</strong><small>暂未开放；检查报告请上传资料</small></span>
        </button>
      </div>
      </Teleport>
    </template>
  </div>
</template>

<style scoped>
.quick-photo-status { position:fixed;left:16px;right:16px;bottom:calc(90px + env(safe-area-inset-bottom));z-index:80;max-width:440px;margin:auto;padding:14px;border:1px solid var(--line);border-radius:12px;background:var(--surface);box-shadow:var(--shadow-l);font-size:14px;overflow-wrap:anywhere; }
.quick-photo-status button { margin:8px 12px 0 0;border:0;background:none;color:var(--brand-strong);font:inherit;cursor:pointer; }
.quick-add-panel .quick-photo-entry:disabled { opacity:.45;cursor:not-allowed; }
.quick-add-backdrop.quick-add-backdrop--inline { z-index: 69; }
.quick-add-panel.quick-add-panel--inline { position: fixed; z-index: 70; visibility: hidden; overflow-y: auto; overscroll-behavior: contain; -webkit-overflow-scrolling: touch; }
button.quick-add-entry:not(.is-disabled){width:100%;border:0;background:none;font:inherit;text-align:left;cursor:pointer}button.quick-add-entry:not(.is-disabled):hover,button.quick-add-entry:not(.is-disabled):focus-visible{background:var(--brand-softer)}
.quick-add.quick-add--inline{z-index:6}.quick-add--inline .quick-add-trigger{display:flex;align-items:center;gap:5px;min-height:32px;padding:5px 10px;background:var(--brand-softer);border-radius:var(--radius-s);font-size:12px;font-weight:500}.quick-add--inline .quick-add-panel{left:0;top:calc(100% + 6px);z-index:5}.quick-add-associate{width:100%;border:0;background:none;font:inherit;text-align:left;cursor:pointer}

.quick-add{position:relative;min-width:0;z-index:1}.quick-add-trigger{border:0;background:none;cursor:pointer;color:var(--brand-strong);font:inherit;font-weight:600}.quick-add-trigger:disabled{opacity:.45;cursor:not-allowed}.quick-add-icon{display:grid;place-items:center}.quick-add-backdrop{position:fixed;inset:0;background:rgba(24,24,22,.22);z-index:4}.quick-add-backdrop--mobile{z-index:29}.quick-add-panel{position:absolute;z-index:1;width:min(330px,calc(100vw - 24px));padding:10px;border:1px solid var(--line);border-radius:18px;background:var(--surface);box-shadow:var(--shadow-l)}.quick-add-entry{display:flex;align-items:center;gap:12px;min-height:62px;padding:10px;border-radius:12px;color:var(--ink);text-decoration:none}.quick-add-entry:hover,.quick-add-entry:focus-visible{background:var(--brand-softer);outline:none}.quick-add-entry-icon{flex:0 0 auto;display:grid;place-items:center;width:38px;height:38px;}.quick-add-entry-copy{flex:1;display:grid;gap:3px;min-width:0}.quick-add-entry-copy strong{font-size:14px}.quick-add-entry-copy small{font-size:12px;color:var(--muted)}.quick-add-chevron{color:var(--muted)}.quick-add-entry.is-disabled{width:100%;border:0;background:none;font:inherit;text-align:left;opacity:.45;cursor:not-allowed}.quick-add-entry.is-disabled:hover{background:none}.quick-add--desktop .quick-add-trigger{display:flex;align-items:center;gap:9px;min-height:38px;width:100%;padding:0 10px;border-radius:10px;text-align:left;font-size:14px}.quick-add--desktop .quick-add-trigger:hover,.quick-add--desktop .quick-add-trigger.is-open{background:var(--brand-soft)}.quick-add--desktop .quick-add-icon{width:26px;height:26px;border-radius:50%;background:var(--brand-gradient);color:#fff}.quick-add--desktop .quick-add-panel{left:calc(100% + 12px);top:0}.quick-add--mobile{position:relative;z-index:2;display:grid;place-items:center}.quick-add--mobile .quick-add-trigger{position:absolute;left:50%;top:-16px;display:grid;place-items:center;width:62px;height:62px;padding:0;transform:translateX(-50%);color:#fff}.quick-add--mobile .quick-add-icon{width:62px;height:62px;border-radius:50%;background:var(--brand-gradient);color:#fff;box-shadow:0 3px 8px rgba(14,124,107,.22);transition:transform .12s}.quick-add--mobile .quick-add-trigger:active .quick-add-icon{transform:scale(.94)}.quick-add--mobile .quick-add-panel{left:50%;bottom:calc(100% + 26px);transform:translateX(-50%)}
</style>
