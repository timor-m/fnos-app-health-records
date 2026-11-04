<script setup lang="ts">
import RecordLoading from './RecordLoading.vue';
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import type {DoctorContext} from '../../../shared/health-process-care';
import {useUnsavedRecord} from '../composables/useUnsavedRecord';
import {createSubmissionKey} from '../utils/submission-key';
import {request} from '../utils/api';
import { Copy, Stethoscope, X } from '@lucide/vue';
import { useAppContext } from '../composables/useAppContext';
import { useScrollLock } from '../composables/useScrollLock';
import { copyTextToClipboard } from '../utils/clipboard';

const props = defineProps<{ memberId: string; text: string; dayText?: string; context?:DoctorContext; disabled?:boolean; loading?:boolean; loadError?:string; returnFocus?: HTMLElement | null }>();
const emit = defineEmits<{ close: []; updated:[]; editMember:[] }>();
const app = useAppContext();
const visible = computed(() => props.memberId === app.selectedMemberId.value);
const panel = ref<HTMLElement | null>(null);
const backdrop = ref<HTMLElement | null>(null);
const copyStatus = ref('');
const editing=ref(false),busy=ref(false),error=ref('');
const form=reactive({concern:''});let version='';
const writable=computed(()=>visible.value&&app.selectedMember.value?.permission==='manager');
let restoreSavedFocus=false;
watch(()=>props.disabled,disabled=>{if(!disabled&&restoreSavedFocus){restoreSavedFocus=false;void nextTick(()=>panel.value?.querySelector<HTMLButtonElement>('[data-edit-context]')?.focus());}});
const leave=useUnsavedRecord(()=>editing.value?JSON.stringify(form):'',busy);const key=createSubmissionKey();
function edit(){if(!writable.value||props.disabled||!props.context)return;form.concern=props.context.concern;version=props.context.version;editing.value=true;error.value='';leave.reset();void nextTick(()=>panel.value?.querySelector<HTMLTextAreaElement>('textarea')?.focus());}
async function cancelEdit(){if(await leave.confirmLeave()){editing.value=false;leave.reset();void nextTick(()=>panel.value?.querySelector<HTMLButtonElement>('[data-edit-context]')?.focus());}}
async function reload(){if(await leave.confirmLeave()){editing.value=false;leave.reset();error.value='';emit('updated');}}
async function close(){if(await leave.confirmLeave())emit('close');}
async function save(){if(!writable.value||props.disabled||busy.value||!props.context)return;busy.value=true;error.value='';const member=props.memberId,processId=props.context.processId;
 const body={memberId:member,version,concern:form.concern};const path=`health-processes/${encodeURIComponent(processId)}/doctor-context`;
 try{const result=await request<DoctorContext>(path,{method:'PATCH',body:JSON.stringify({...body,requestKey:key.forRequest(path,body)})});if(!alive||!writable.value||props.memberId!==member)return;if(result.memberId!==member||result.processId!==processId)throw Error('保存结果与当前历程不一致');editing.value=false;leave.reset();restoreSavedFocus=true;app.notifyDataChanged();emit('updated');void nextTick(()=>panel.value?.querySelector<HTMLButtonElement>('[data-edit-context]')?.focus());}
 catch(cause){if(alive&&writable.value)error.value=cause instanceof Error?cause.message:'保存失败，请重试';}finally{busy.value=false;}}
watch(writable,allowed=>{if(!allowed&&editing.value){editing.value=false;leave.reset();}});

const missingBackground=computed(()=>props.context?[!props.context.allergies.trim()?'过敏及不良反应':'',!props.context.history.trim()?'重要病史':'',!props.context.medications.trim()?'长期用药':''].filter(Boolean):[]);
const mode=ref<'subject'|'day'>('subject');
const shownText=computed(()=>mode.value==='day'&&props.dayText?props.dayText:props.text);
let alive = true;
useScrollLock(visible);
watch(shownText, () => { copyStatus.value = ''; });

async function copy() {
  if (!visible.value) return;
  const text = shownText.value;
  const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const success = await copyTextToClipboard(text);
  if (alive && visible.value && shownText.value === text) {
    copyStatus.value = success ? '已复制' : '未能自动复制，可长按正文选择复制。';
    // The HTTP clipboard fallback removes a temporary textarea; keep focus in the dialog.
    if (document.activeElement === document.body && trigger && panel.value?.contains(trigger)) trigger.focus({ preventScroll: true });
  }
}
function onKey(event: KeyboardEvent) {
  if (!visible.value || !panel.value || [...document.querySelectorAll('.modal-backdrop,.sheet-backdrop,.confirm-backdrop,.original-viewer')].slice(-1)[0] !== backdrop.value) return;
  if (event.key === 'Escape') {
    event.preventDefault(); event.stopImmediatePropagation(); void close(); return;
  }
  if (event.key !== 'Tab') return;
  const items = [...panel.value.querySelectorAll<HTMLElement>('button:not(:disabled),textarea:not(:disabled),[tabindex="0"]')];
  const first = items[0], last = items[items.length - 1];
  if (!panel.value.contains(document.activeElement) || document.activeElement === panel.value
    || (event.shiftKey && document.activeElement === first) || (!event.shiftKey && document.activeElement === last)) {
    event.preventDefault(); (event.shiftKey ? last : first)?.focus();
  }
}
onMounted(() => {
  window.addEventListener('keydown', onKey);
  void nextTick(() => { if (visible.value) panel.value?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true }); });
});
onBeforeUnmount(() => {
  alive = false; window.removeEventListener('keydown', onKey);
  const target = props.returnFocus;
  void nextTick(() => { if (visible.value && target?.isConnected) target.focus({ preventScroll: true }); });
});
</script>

<template>
  <Teleport to="body">
    <div v-if="visible" ref="backdrop" class="modal-backdrop process-doctor-summary-backdrop" @click.self="close">
      <section ref="panel" class="modal-panel record-sheet process-doctor-summary-modal" role="dialog" aria-modal="true" aria-label="给医生看的就诊摘要" tabindex="-1">
        <span class="sheet-grabber" aria-hidden="true"></span>
        <header><div><Stethoscope :size="16" /><h3>就诊摘要</h3></div><button type="button" class="plain-icon-button" aria-label="关闭就诊摘要"  :disabled="busy" @click="close"><X :size="18" /></button></header>
        <div v-if="!editing&&dayText" class="process-summary-views" role="group" aria-label="摘要排列"><button type="button" :aria-pressed="mode==='subject'" @click="mode='subject'">按内容</button><button type="button" :aria-pressed="mode==='day'" @click="mode='day'">按天</button></div>
        <form v-if="editing" id="doctor-context-form" class="doctor-context-form record-dialog-body" @submit.prevent="save"><fieldset :disabled="busy"><p>本次诉求只用于当前历程。健康背景请在成员信息中维护。</p><label>本次最想解决的问题<textarea v-model="form.concern" maxlength="2000" rows="3" placeholder="希望这次就诊重点解决什么"/></label><p v-if="error" class="inline-panel-error" role="alert">{{error}} <button type="button" class="error-retry" @click="reload">重新读取</button></p></fieldset></form>
        <div v-else class="process-doctor-summary-body record-dialog-body"><div v-if="missingBackground.length" class="doctor-background-guide"><p>成员信息尚未填写：{{missingBackground.join('、')}}。</p><button v-if="writable" type="button" class="soft-action-button" :disabled="disabled" @click="emit('editMember')">补充成员信息</button></div><p v-if="loadError" class="inline-panel-error" role="alert">{{loadError}} <button type="button" class="error-retry" @click="reload">重试</button></p><RecordLoading v-else-if="loading&&!text" label="正在准备就诊摘要…"/><p v-else-if="disabled&&text" role="status" class="doctor-summary-status">正在更新摘要…</p><pre v-if="text" tabindex="0" aria-label="就诊摘要正文">{{ shownText }}</pre></div>
        <footer class="form-actions record-form-actions">
          <p v-if="copyStatus" class="process-summary-copy-status" role="status">{{ copyStatus }}</p>
          <template v-if="editing"><button type="button" :disabled="busy" @click="cancelEdit">取消</button><button form="doctor-context-form" class="primary-button" type="submit" :disabled="busy">{{busy?'正在保存…':'保存'}}</button></template><template v-else><button v-if="context&&writable" type="button" data-edit-context :disabled="disabled" @click="edit">本次诉求</button><button type="button" class="primary-button" :disabled="disabled||Boolean(loadError)" @click="copy"><Copy :size="14" />复制摘要</button></template>
        </footer>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.doctor-background-guide{display:flex;align-items:center;flex-wrap:wrap;gap:6px 10px;margin:10px 14px 0;padding:8px 10px;border-radius:8px;background:var(--brand-soft)}.doctor-background-guide p{flex:1;min-width:160px;margin:0;font-size:12px;line-height:19px;color:var(--muted)}.doctor-background-guide button{font-size:12px;min-height:32px}
.doctor-summary-status{margin:8px 14px;font-size:12px;color:var(--muted)}
.doctor-context-form{min-height:0;overflow:auto;padding:12px 14px;overscroll-behavior:contain}.doctor-context-form fieldset{display:grid;gap:12px;min-width:0;padding:0;border:0;margin:0}.doctor-context-form p{margin:0;font-size:12px;color:var(--muted);line-height:19px}.doctor-context-form label{display:grid;gap:6px;font-size:12px;color:var(--muted)}.doctor-context-form textarea{width:100%;min-width:0;padding:8px 10px;border:1px solid var(--line-strong);border-radius:var(--radius-s);background:var(--surface);color:var(--ink);font:inherit;font-size:14px;line-height:21px}.doctor-context-form textarea:focus{outline:2px solid var(--brand-soft);border-color:var(--brand)}
.process-summary-views { display:flex;gap:6px;padding:8px 14px 0; }
.process-summary-views button { min-height:30px;padding:4px 10px;border:1px solid var(--line);border-radius:8px;background:var(--surface);color:var(--muted);font-size:12px; }
.process-summary-views button[aria-pressed=true] { color:var(--brand-strong);background:var(--brand-soft);border-color:var(--brand); }
.process-doctor-summary-backdrop { z-index: 70; }
.process-doctor-summary-modal { width: min(720px,100%); max-height: 88vh; max-height: 88dvh; outline: 0; }
.process-doctor-summary-modal > header { min-height: 50px; padding: 10px 14px; gap: 8px; }
.process-doctor-summary-modal h3 { margin: 0; font-size: 16px; line-height: 22px; }
.process-doctor-summary-modal > header > button { position: relative; flex: 0 0 28px; width: 28px; height: 28px; padding: 0; }
.process-doctor-summary-modal > header > button::after { content: ''; position: absolute; inset: -8px; }
.process-doctor-summary-body { flex: 1 1 auto; min-height: 0; }
.process-doctor-summary-body pre { margin: 0; padding: 14px; white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; font-size: 14px; line-height: 1.7; user-select: text; -webkit-user-select: text; }
.process-doctor-summary-modal > footer { flex: 0 0 auto; margin: 0; padding: 10px 14px; border-top: 1px solid var(--line); }
.process-summary-copy-status { flex: 1 1 180px; margin: 0; color: var(--muted); font-size: 12px; line-height: 19px; overflow-wrap: anywhere; }
.process-doctor-summary-modal button:focus-visible, .process-doctor-summary-body pre:focus-visible { outline: 2px solid var(--brand); outline-offset: -2px; }
@media (max-width: 760px), (pointer: coarse) {
  .process-doctor-summary-body pre { padding: 12px 14px; }
  .process-doctor-summary-modal > footer { padding: 8px 14px max(8px,env(safe-area-inset-bottom)); }
}
</style>
