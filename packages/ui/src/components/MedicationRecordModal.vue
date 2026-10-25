<script setup lang="ts">
import HealthCategoryIcon from './HealthCategoryIcon.vue';
import { computed, nextTick, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, watch } from 'vue';
import { X } from '@lucide/vue';
import MedicationRecords from './MedicationRecords.vue';
import ReportScrollingTitle from './ReportScrollingTitle.vue';
import { useAppContext } from '../composables/useAppContext';
import { useScrollLock } from '../composables/useScrollLock';
import { confirmUnsavedRecordChanges } from '../utils/record-edit-guards';
import type { HealthRecordRef } from '../../../shared/health-record-associations';
import type { HistoricalMedication, MedicationCourse, MedicationIntake } from '../types/medications';

const props=defineProps<{open:boolean;courseId?:string;intakeId?:string;reportId?:string;add?:'course'|'intake';entryMode?:'report'|'course'|'intake';entrySource?:HistoricalMedication;processId?:string;initialRelatedRecords?:HealthRecordRef[]}>();
const emit=defineEmits<{close:[];updated:[];completed:[record?:MedicationCourse|MedicationIntake]}>();
const app=useAppContext();const active=ref(true);
const openedMember=ref(app.selectedMemberId.value);
const visible=computed(()=>props.open && active.value && Boolean(app.selectedMemberId.value) && openedMember.value===app.selectedMemberId.value);
const childEntry=ref<{mode?:'report'|'course'|'intake';source?:HistoricalMedication;courseId?:string}|null>(null);
const lastEntry=ref('');
const recordTitle=ref('');
// Keep the previous dialog mounted to preserve searches and filters, but show only the active step.
const shellVisible=computed(()=>visible.value&&!childEntry.value);
const title=computed(()=>props.entryMode==='report'?'从报告带入':props.entryMode==='intake'?'记一次已服药':props.entryMode==='course'?(props.entrySource?'确认开始用药':'手动添加用药'):(props.intakeId || props.courseId) ? recordTitle.value || '用药记录' : props.reportId ? '用药单' : props.add ? '记录用药' : '相关用药');
const scope=computed(()=>JSON.stringify([app.selectedMemberId.value,props.courseId,props.intakeId,props.reportId,props.add,props.entryMode,props.entrySource,props.initialRelatedRecords,props.processId]));
const panel=ref<HTMLElement|null>(null);const backdrop=ref<HTMLElement|null>(null);
let returnFocus:HTMLElement|null=null;
function restoreFocus(){if(returnFocus?.isConnected)returnFocus.focus();returnFocus=null;}
watch(visible,open=>{if(!open)restoreFocus();});
async function requestClose(){if(await confirmUnsavedRecordChanges())emit('close');}
function openEntry(mode:'report'|'course'|'intake',source?:HistoricalMedication){if(mode!=='report'&&app.selectedMember.value?.permission!=='manager')return;lastEntry.value=mode;childEntry.value={mode,source};}
function viewCourse(id:string){childEntry.value={courseId:id};}
function completed(record?:MedicationCourse|MedicationIntake){childEntry.value=null;if(props.entryMode)emit('completed',record);else if(props.add)emit('close');}
watch(scope,()=>{childEntry.value=null;lastEntry.value='';recordTitle.value='';});
watch(()=>props.open,open=>{if(!open){childEntry.value=null;recordTitle.value='';}});
function onKeydown(event:KeyboardEvent){
  if(!shellVisible.value || !panel.value || document.querySelector('.form-select-layer,.datetime-picker-layer,.confirm-backdrop'))return;
  const overlays=[...document.querySelectorAll('.modal-backdrop')];
  if(overlays.at(-1)!==backdrop.value)return;
  if(event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();void requestClose();return;}
  if(event.key!=='Tab')return;
  const items=[...panel.value.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),a[href],summary,[tabindex="0"]')]
    .filter(item=>!item.closest('[hidden]') && (!item.closest('details:not([open])') || item.tagName==='SUMMARY') && getComputedStyle(item).display!=='none');
  const first=items[0];const last=items.at(-1);
  if(!first){event.preventDefault();panel.value.focus();return;}
  if(event.shiftKey && (document.activeElement===first || !panel.value.contains(document.activeElement))){event.preventDefault();last?.focus();}
  else if(!event.shiftKey && (document.activeElement===last || !panel.value.contains(document.activeElement))){event.preventDefault();first.focus();}
}
useScrollLock(visible);
watch(shellVisible,async open=>{
  if(open){if(!returnFocus)returnFocus=document.activeElement instanceof HTMLElement ? document.activeElement : null;await nextTick();if(shellVisible.value){const previous=lastEntry.value?panel.value?.querySelector<HTMLButtonElement>(`[data-medication-entry="${lastEntry.value}"]`):null;(previous||panel.value?.querySelector<HTMLButtonElement>('button'))?.focus();}}
  else if(!visible.value)restoreFocus();
},{immediate:true});
watch(()=>props.open,open=>{if(open)openedMember.value=app.selectedMemberId.value;});
watch(app.selectedMemberId,(next,previous)=>{if(next!==previous && props.open)emit('close');},{flush:'sync'});
onDeactivated(()=>{active.value=false;if(props.open)emit('close');});
onActivated(()=>{active.value=true;});
onMounted(()=>window.addEventListener('keydown',onKeydown));
onBeforeUnmount(()=>{window.removeEventListener('keydown',onKeydown);restoreFocus();});
</script>

<template>
  <Teleport to="body">
    <div v-if="visible" v-show="shellVisible" ref="backdrop" class="modal-backdrop medication-record-backdrop" @click.self="requestClose">
      <section ref="panel" class="modal-panel medication-record-modal record-sheet" :class="{'is-detail':courseId||intakeId,'is-entry':add||entryMode,'is-form-entry':entryMode==='course'||entryMode==='intake'}" role="dialog" aria-modal="true" :aria-label="title" tabindex="-1">
        <span class="sheet-grabber" aria-hidden="true"></span>
        <header><div><HealthCategoryIcon category="medication" :size="26" /><ReportScrollingTitle :text="title" /></div><button type="button" aria-label="关闭用药记录" @click="requestClose"><X :size="20" /></button></header>
        <div class="medication-record-body record-dialog-body"><MedicationRecords :key="scope" :course-id="courseId" :intake-id="intakeId" :report-id="reportId" :add="add" :entry-mode="entryMode" :entry-source="entrySource" :initial-related-records="initialRelatedRecords" :process-id="processId" separate-entry @heading="recordTitle=$event.title" @close="requestClose" @entry="openEntry" @view-course="viewCourse" @back="requestClose" @completed="emit('completed',$event)" @updated="emit('updated')" /></div>
      </section>
    </div>
  </Teleport>
  <MedicationRecordModal v-if="childEntry&&visible" :open="true" :entry-mode="childEntry.mode" :entry-source="childEntry.source" :course-id="childEntry.courseId" :initial-related-records="childEntry.courseId?undefined:initialRelatedRecords" :process-id="childEntry.courseId?undefined:processId" @close="childEntry=null" @completed="completed" @updated="emit('updated')"/>
</template>

<style scoped>
.medication-record-modal { width: min(860px, 100%); height: auto; max-height: 90dvh; display: flex; flex-direction: column; overflow: hidden; }
.medication-record-modal > header { flex-shrink: 0; }
.medication-record-modal.is-detail { width: min(680px,100%); height: 88dvh; max-height: 88dvh; }
@media (min-width: 761px) {
  .medication-record-modal.is-entry { width: min(600px, 100%); }
  .medication-record-modal.is-entry :deep(.medication-form-hint) { margin: 0 0 12px; }
  .medication-record-modal.is-entry :deep(.medication-form-grid) { gap: 12px; }
}
/* Only the editor body scrolls; saving stays reachable with extra fields expanded. */
.medication-record-modal.is-form-entry .medication-record-body { display: flex; flex-direction: column; overflow: hidden; }
.medication-record-modal.is-form-entry :deep(.medication-records) { display: flex; flex-direction: column; min-height: 0; padding: 0; }
.medication-record-modal.is-form-entry :deep(.medication-entry-editor),
.medication-record-modal.is-form-entry :deep(.medication-editor) { display: flex; flex-direction: column; min-height: 0; }
.medication-record-modal.is-form-entry :deep(.medication-form-body) { min-height: 0; overflow: auto; overscroll-behavior: contain; padding: 16px; }
.medication-record-modal.is-form-entry :deep(.medication-editor > .form-error) { flex-shrink: 0; padding: 8px 16px; }
.medication-record-modal.is-form-entry :deep(.medication-dialog-actions) { flex-shrink: 0; margin: 0; padding: 10px 16px; border-top: 1px solid var(--line); }
@media (max-width: 760px), (pointer: coarse) {
 .medication-record-modal { max-height: 94dvh; }
 .medication-record-modal.is-form-entry :deep(.medication-form-body) { padding: 12px 14px; }
 .medication-record-modal.is-form-entry :deep(.medication-dialog-actions) { padding: 8px 14px max(8px, env(safe-area-inset-bottom)); }
}
</style>
