<script setup lang="ts">
import type { HealthRecordHeading } from '../utils/health-record-presentation';
import HealthCategoryIcon from './HealthCategoryIcon.vue';
import { healthCategoryLabels } from '../../../shared/health-categories';
import { computed, nextTick, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, watch } from 'vue';
import { X } from '@lucide/vue';
import HealthRecordDetailContent from './HealthRecordDetailContent.vue';
import ReportScrollingTitle from './ReportScrollingTitle.vue';
import { useAppContext } from '../composables/useAppContext';
import { useScrollLock } from '../composables/useScrollLock';
import type { HealthFeedEntry } from '../../../shared/health-categories';
import { confirmUnsavedRecordChanges } from '../utils/record-edit-guards';
import { healthRecordTitles, isHealthRecordKind } from '../utils/health-record-navigation';
import type { HealthRecordRef } from '../../../shared/health-record-associations';

const props = defineProps<{ open: boolean; kind: HealthFeedEntry['kind']; recordId: string }>();
const emit = defineEmits<{ close: []; updated: []; openReport: [reportId: string] }>();
const app = useAppContext();
const active = ref(true);
const openedMember = ref(app.selectedMemberId.value);
const visible = computed(() => props.open && active.value && Boolean(app.selectedMemberId.value)
  && openedMember.value === app.selectedMemberId.value);
const scope = computed(() => JSON.stringify([openedMember.value, props.kind, props.recordId]));
const heading = ref<HealthRecordHeading | null>(null);
const relatedRecord = ref<HealthRecordRef|null>(null);
const headingCategory = computed(() => heading.value?.category || (props.kind === 'symptom' ? 'symptom' : props.kind === 'vaccination' ? 'vaccination' : props.kind === 'report' ? 'report' : 'medication'));
watch([scope, visible], () => { heading.value = null; relatedRecord.value = null; }, { flush: 'sync' });
const panel = ref<HTMLElement | null>(null);
const backdrop = ref<HTMLElement | null>(null);
let returnFocus: HTMLElement | null = null;
let relatedOpener: HTMLElement | null = null;
function openRelated(record:HealthRecordRef) {
  if(!visible.value||!isHealthRecordKind(record.kind)||!record.id.trim()||record.id.length>200)return;
  if(record.kind===props.kind&&record.id===props.recordId)return;
  relatedOpener=document.activeElement instanceof HTMLElement?document.activeElement:null;
  relatedRecord.value=record;
}
async function closeRelated() {
  relatedRecord.value=null;await nextTick();
  if(visible.value){const target=relatedOpener?.isConnected?relatedOpener:panel.value?.querySelector<HTMLButtonElement>('button');target?.focus({preventScroll:true});}
  relatedOpener=null;
}
async function requestClose() { if (await confirmUnsavedRecordChanges()) emit('close'); }
function restoreFocus() {
  if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
  returnFocus = null;
}
function onKeydown(event: KeyboardEvent) {
  if (!visible.value || !panel.value || document.querySelector('.form-select-layer,.datetime-picker-layer,.confirm-backdrop,.original-viewer')) return;
  const overlays = [...document.querySelectorAll('.modal-backdrop,.sheet-backdrop,.original-viewer,.image-preview-backdrop,.confirm-backdrop')];
  if (overlays[overlays.length - 1] !== backdrop.value) return;
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); void requestClose(); return; }
  if (event.key !== 'Tab') return;
  const items = [...panel.value.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),a[href],summary,[tabindex="0"]')]
    .filter(item => !item.closest('[hidden]') && (!item.closest('details:not([open])') || item.tagName === 'SUMMARY')
      && getComputedStyle(item).display !== 'none' && getComputedStyle(item).visibility !== 'hidden');
  const first = items[0]; const last = items[items.length - 1];
  if (!first) { event.preventDefault(); panel.value.focus(); return; }
  if (event.shiftKey && (document.activeElement === panel.value || document.activeElement === first || !panel.value.contains(document.activeElement))) {
    event.preventDefault(); last?.focus();
  } else if (!event.shiftKey && (document.activeElement === last || !panel.value.contains(document.activeElement))) {
    event.preventDefault(); first.focus();
  }
}
useScrollLock(visible);
watch(visible, async open => {
  if (open) {
    returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    await nextTick();
    if (visible.value) panel.value?.focus({ preventScroll: true });
  } else restoreFocus();
}, { immediate: true });
watch(scope, async () => { await nextTick(); if (visible.value) panel.value?.querySelector('.health-record-detail-body')?.scrollTo?.(0, 0); });
watch(() => props.open, open => { if (open) openedMember.value = app.selectedMemberId.value; });
watch(app.selectedMemberId, (next, previous) => { if (next !== previous && props.open) emit('close'); }, { flush: 'sync' });
onDeactivated(() => { active.value = false; });
onActivated(() => { active.value = true; });
onMounted(() => window.addEventListener('keydown', onKeydown));
onBeforeUnmount(() => { window.removeEventListener('keydown', onKeydown); restoreFocus(); });
</script>

<template>
  <Teleport to="body">
    <div v-if="visible" v-show="!relatedRecord" ref="backdrop" class="modal-backdrop health-record-detail-backdrop" @click.self="requestClose">
      <section ref="panel" class="modal-panel report-detail-modal health-record-detail-modal record-sheet" role="dialog" aria-modal="true" :aria-label="heading?.title || healthRecordTitles[kind]" tabindex="-1">
        <span class="sheet-grabber" aria-hidden="true"></span>
        <header class="sheet-header report-detail-floating-header"><div class="record-sheet-title"><HealthCategoryIcon :category="headingCategory" :size="26" :label="healthCategoryLabels[headingCategory]" /><ReportScrollingTitle :text="heading?.title || healthRecordTitles[kind]" /></div><button class="plain-icon-button record-detail-close" type="button" aria-label="关闭记录详情" @click="requestClose"><X :size="18" /></button></header>
        <div class="health-record-detail-body record-dialog-body">
          <HealthRecordDetailContent :key="scope" :kind="kind" :record-id="recordId" hide-report-title open-related-in-place @open-record="openRelated" @heading="heading = $event" @close="requestClose" @updated="emit('updated')" @open-report="emit('openReport', $event)" />
        </div>
      </section>
    </div>
  </Teleport>
  <HealthRecordDetailModal v-if="visible&&relatedRecord" :key="`${relatedRecord.kind}:${relatedRecord.id}`" :open="true" :kind="relatedRecord.kind" :record-id="relatedRecord.id" @close="closeRelated" @updated="emit('updated')" @open-report="openRelated({kind:'report',id:$event})" />
</template>

<style scoped>
/* Reuse the existing report dialog shell, including its mobile height and radius. */
.health-record-detail-modal { overflow: hidden; outline: none; }
.health-record-detail-modal.record-sheet > header { flex-shrink: 0; gap: 4px; padding-inline: 8px; }
.health-record-detail-modal .record-sheet-title { gap: 2px; }
.record-detail-close { position: relative; flex: 0 0 28px; width: 28px; height: 28px; padding: 0; border-radius: 8px; }
/* Keep a 44px touch target without reserving that width in the title row. */
.record-detail-close::after { content: ''; position: absolute; inset: -8px; }
</style>
