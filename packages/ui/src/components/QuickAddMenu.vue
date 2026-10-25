<script setup lang="ts">
import { computed, nextTick, onDeactivated, onMounted, onUnmounted, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';
import { useScrollLock } from '../composables/useScrollLock';
import HealthCategoryIcon from './HealthCategoryIcon.vue';
import { Camera, ChevronRight, Plus, Link2 } from '@lucide/vue';

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
const open = ref(false);
const trigger = ref<HTMLButtonElement | null>(null);
const panel = ref<HTMLElement | null>(null);
const panelStyle = ref<Record<string,string>>({});
const menuId = `quick-add-${props.placement}`;
useScrollLock(computed(() => open.value && props.placement === 'inline'));

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
 return entry.category==='vaccination'||entry.category==='symptom'||props.relatedRecord||props.processId?{path:entry.to,query:{returnTo:props.routeKey,...context}}:entry.to;
}

const entries = [
  { label: '上传资料', hint: '自动归类报告、用药单和接种原件', to: '/upload', category: 'report' },
  { label: '症状 / 不适', hint: '记录症状及后续变化', to: '/add/symptom', category: 'symptom' },
  { label: '用药', hint: '从用药单带入，或手动记录', to: '/events?add=medication', category: 'medication' },
  { label: '接种', hint: '填写接种日期、剂次和下一剂提醒', to: '/add/vaccination', category: 'vaccination' }
] as const;

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
onUnmounted(() => { window.removeEventListener('keydown', onKeydown); removePositionListeners(); });
</script>

<template>
  <div class="quick-add" :class="`quick-add--${placement}`">
    <button ref="trigger" type="button" class="quick-add-trigger" :class="{ 'is-open': open }"
      :aria-label="canManage ? label||'拍照或新增记录' : '当前成员只有查看权限'"
      aria-haspopup="menu" :aria-expanded="open" :aria-controls="menuId"
      :disabled="!canManage||disabled" @click="toggle">
      <span class="quick-add-icon"><Plus v-if="placement==='inline'" :size="16"/><Camera v-else :size="placement === 'mobile' ? 26 : 19" /></span>
      <span v-if="placement !== 'mobile'">{{label||'新增'}}</span>
    </button>
    <template v-if="open">
      <Teleport to="body">
        <div class="quick-add-backdrop" :class="`quick-add-backdrop--${placement}`" aria-hidden="true" @click="close(true)" />
      </Teleport>
      <Teleport to="body" :disabled="placement!=='inline'">
      <div ref="panel" :id="menuId" class="quick-add-panel" :class="{'quick-add-panel--inline':placement==='inline'}" :style="panelStyle" role="menu" aria-label="新增记录类型">
        <button v-if="processId||relatedRecord" type="button" class="quick-add-entry quick-add-associate" role="menuitem" @click="close();emit('associate')"><span class="quick-add-entry-icon"><Link2 :size="24"/></span><span class="quick-add-entry-copy"><strong>{{processId?'添加记录':'关联历程'}}</strong><small>{{processId?'选择已有记录加入当前历程':'选择相关记录，形成或加入健康历程'}}</small></span><ChevronRight :size="16"/></button>
        <component v-for="entry in entries" :key="entry.to" :is="entry.category==='symptom'&&symptomDialog?'button':RouterLink" :to="entry.category==='symptom'&&symptomDialog?undefined:target(entry)" :type="entry.category==='symptom'&&symptomDialog?'button':undefined"
          class="quick-add-entry" role="menuitem" @click="close();if(entry.category==='symptom'&&symptomDialog)emit('symptom',trigger)">
          <span class="quick-add-entry-icon"><HealthCategoryIcon :category="entry.category" :size="34" /></span>
          <span class="quick-add-entry-copy"><strong>{{ entry.label }}</strong><small>{{ entry.hint }}</small></span>
          <ChevronRight :size="16" class="quick-add-chevron" />
        </component>
        <button type="button" class="quick-add-entry is-disabled" role="menuitem" disabled aria-label="影像，暂未开放">
          <span class="quick-add-entry-icon"><HealthCategoryIcon category="imaging" :size="34" /></span>
          <span class="quick-add-entry-copy"><strong>影像</strong><small>暂未开放；检查报告请上传资料</small></span>
        </button>
      </div>
      </Teleport>
    </template>
  </div>
</template>

<style scoped>
.quick-add-backdrop.quick-add-backdrop--inline { z-index: 69; }
.quick-add-panel.quick-add-panel--inline { position: fixed; z-index: 70; visibility: hidden; overflow-y: auto; overscroll-behavior: contain; -webkit-overflow-scrolling: touch; }
button.quick-add-entry:not(.is-disabled){width:100%;border:0;background:none;font:inherit;text-align:left;cursor:pointer}button.quick-add-entry:not(.is-disabled):hover,button.quick-add-entry:not(.is-disabled):focus-visible{background:var(--brand-softer)}
.quick-add.quick-add--inline{z-index:6}.quick-add--inline .quick-add-trigger{display:flex;align-items:center;gap:5px;min-height:32px;padding:5px 10px;background:var(--brand-softer);border-radius:var(--radius-s);font-size:12px;font-weight:500}.quick-add--inline .quick-add-panel{left:0;top:calc(100% + 6px);z-index:5}.quick-add-associate{width:100%;border:0;background:none;font:inherit;text-align:left;cursor:pointer}

.quick-add{position:relative;min-width:0;z-index:1}.quick-add-trigger{border:0;background:none;cursor:pointer;color:var(--brand-strong);font:inherit;font-weight:600}.quick-add-trigger:disabled{opacity:.45;cursor:not-allowed}.quick-add-icon{display:grid;place-items:center}.quick-add-backdrop{position:fixed;inset:0;background:rgba(24,24,22,.22);z-index:4}.quick-add-backdrop--mobile{z-index:29}.quick-add-panel{position:absolute;z-index:1;width:min(330px,calc(100vw - 24px));padding:10px;border:1px solid var(--line);border-radius:18px;background:var(--surface);box-shadow:var(--shadow-l)}.quick-add-entry{display:flex;align-items:center;gap:12px;min-height:62px;padding:10px;border-radius:12px;color:var(--ink);text-decoration:none}.quick-add-entry:hover,.quick-add-entry:focus-visible{background:var(--brand-softer);outline:none}.quick-add-entry-icon{flex:0 0 auto;display:grid;place-items:center;width:38px;height:38px;}.quick-add-entry-copy{flex:1;display:grid;gap:3px;min-width:0}.quick-add-entry-copy strong{font-size:14px}.quick-add-entry-copy small{font-size:12px;color:var(--muted)}.quick-add-chevron{color:var(--muted)}.quick-add-entry.is-disabled{width:100%;border:0;background:none;font:inherit;text-align:left;opacity:.45;cursor:not-allowed}.quick-add-entry.is-disabled:hover{background:none}.quick-add--desktop .quick-add-trigger{display:flex;align-items:center;gap:9px;min-height:38px;width:100%;padding:0 10px;border-radius:10px;text-align:left;font-size:14px}.quick-add--desktop .quick-add-trigger:hover,.quick-add--desktop .quick-add-trigger.is-open{background:var(--brand-soft)}.quick-add--desktop .quick-add-icon{width:20px;height:20px}.quick-add--desktop .quick-add-panel{left:calc(100% + 12px);top:0}.quick-add--mobile{display:grid;place-items:center}.quick-add--mobile .quick-add-trigger{display:grid;place-items:center;width:100%;height:100%;padding:0}.quick-add--mobile .quick-add-icon{width:50px;height:50px;border-radius:50%;background:var(--brand-gradient);color:#fff;box-shadow:0 6px 16px rgba(14,124,107,.35);transition:transform .12s}.quick-add--mobile .quick-add-trigger:active .quick-add-icon{transform:scale(.92)}.quick-add--mobile .quick-add-panel{left:50%;bottom:calc(100% + 16px);transform:translateX(-50%)}
</style>
