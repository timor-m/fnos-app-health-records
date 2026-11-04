<script setup lang="ts">
import {computed,nextTick,onBeforeUnmount,onDeactivated,onMounted,ref,toRef,useId,watch} from 'vue';
import {Link2,X} from '@lucide/vue';
import HealthRecordPicker from './HealthRecordPicker.vue';
import type {HealthRecordRef} from '../../../shared/health-record-associations';
import {useAppContext} from '../composables/useAppContext';
import {useScrollLock} from '../composables/useScrollLock';
import {useUnsavedRecord} from '../composables/useUnsavedRecord';

const props=defineProps<{memberId:string;subject?:HealthRecordRef;initialRecords?:HealthRecordRef[];selectionOnly?:boolean;exclude?:HealthRecordRef[];busy:boolean;error?:string;returnFocus?:HTMLElement|null;reportOnly?:boolean;maxSelections?:number;title?:string;hint?:string;confirmText?:string}>();
const emit=defineEmits<{close:[];confirm:[records:HealthRecordRef[]]}>();
const app=useAppContext();const selected=ref<HealthRecordRef[]>((props.initialRecords||[]).map(record=>({...record})));const active=ref(true);
const titleId=useId();const panel=ref<HTMLElement|null>(null);const backdrop=ref<HTMLElement|null>(null);
const visible=computed(()=>active.value&&props.memberId===app.selectedMemberId.value&&app.selectedMember.value?.permission==='manager');
const dialogTitle=computed(()=>props.title||(props.subject||props.selectionOnly?'关联历程':'添加记录'));
const leave=useUnsavedRecord(()=>JSON.stringify(selected.value),toRef(props,'busy'));
let returnFocus:HTMLElement|null=null;
let parentDialog:HTMLElement|null=null;let parentInert=false;let parentHidden:string|null=null;
async function close(){if(await leave.confirmLeave())emit('close');}
const confirmAllowed=computed(()=>props.reportOnly?selected.value.length===1:props.selectionOnly||selected.value.length>0);
function confirm(){if(!visible.value||props.busy||!confirmAllowed.value)return;
 if(props.selectionOnly)leave.reset();
 emit('confirm',selected.value.map(record=>({...record})));
}
function restoreParent(){
  if(parentDialog){parentDialog.inert=parentInert;if(parentHidden===null)parentDialog.removeAttribute('aria-hidden');else parentDialog.setAttribute('aria-hidden',parentHidden);parentDialog=null;}
  const target=returnFocus;
  void nextTick(()=>{if(props.memberId===app.selectedMemberId.value&&target?.isConnected)target.focus({preventScroll:true});});
  returnFocus=null;
}
function keydown(event:KeyboardEvent){
  if(!visible.value||!panel.value||document.querySelector('.confirm-backdrop,.form-select-layer,.datetime-picker-layer'))return;
  if([...document.querySelectorAll('.modal-backdrop,.sheet-backdrop')].slice(-1)[0]!==backdrop.value)return;
  if(event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();void close();return;}
  if(event.key!=='Tab')return;
  const items=[...panel.value.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),a[href],[tabindex="0"]')]
    .filter(item=>!item.closest('[hidden],[inert]')&&getComputedStyle(item).display!=='none');
  const first=items[0],last=items[items.length - 1];
  if(!first){event.preventDefault();panel.value.focus();return;}
  if(event.shiftKey&&(document.activeElement===first||document.activeElement===panel.value||!panel.value.contains(document.activeElement))){event.preventDefault();last?.focus();}
  else if(!event.shiftKey&&(document.activeElement===last||document.activeElement===panel.value||!panel.value.contains(document.activeElement))){event.preventDefault();first.focus();}
}
useScrollLock(visible);
watch(visible,allowed=>{if(!allowed){restoreParent();emit('close');}},{flush:'sync'});
watch(()=>JSON.stringify([props.memberId,props.subject]),()=>{selected.value=(props.initialRecords||[]).map(record=>({...record}));leave.reset();});
onMounted(async()=>{
  returnFocus=props.returnFocus||(document.activeElement instanceof HTMLElement?document.activeElement:null);
  parentDialog=returnFocus?.closest<HTMLElement>('[role="dialog"]')||null;
  if(parentDialog){parentInert=parentDialog.inert;parentHidden=parentDialog.getAttribute('aria-hidden');parentDialog.inert=true;parentDialog.setAttribute('aria-hidden','true');}
  window.addEventListener('keydown',keydown);await nextTick();
  if(visible.value)panel.value?.focus({preventScroll:true});
});
onDeactivated(()=>{active.value=false;});
onBeforeUnmount(()=>{window.removeEventListener('keydown',keydown);restoreParent();});
</script>

<template>
 <Teleport to="body">
  <div v-if="visible" ref="backdrop" class="modal-backdrop record-association-backdrop" @click.self="close">
   <section ref="panel" class="modal-panel record-sheet record-association-modal" role="dialog" aria-modal="true" :aria-labelledby="titleId" tabindex="-1">
    <span class="sheet-grabber" aria-hidden="true"/>
    <header><div><Link2 :size="20" aria-hidden="true"/><h3 :id="titleId">{{dialogTitle}}</h3></div><button class="plain-icon-button association-close" type="button" :aria-label="`关闭${dialogTitle}`" :disabled="busy" @click="close"><X :size="18"/></button></header>
    <form class="association-form" :aria-busy="busy" @submit.prevent.stop="confirm">
     <p class="association-draft-hint">{{hint||(selectionOnly?'选择同一健康事项的相关记录，保存后形成或加入健康历程。':subject?'选择同一健康事项的相关记录，形成或加入健康历程。':'选择要加入当前健康历程的记录。')}}</p>
     <HealthRecordPicker v-model="selected" class="association-picker" :member-id="memberId" :exclude="[...(subject?[subject]:[]),...(exclude||[])]" :disabled="busy" :report-only="reportOnly" :max-selections="maxSelections"/>
     <p v-if="error" class="inline-panel-error association-save-error" role="alert">{{error}}</p>
     <footer class="form-actions record-form-actions association-footer"><button v-if="selected.length" type="button" class="soft-action-button" :disabled="busy" @click="selected=[]">清除选择</button><button type="button" :disabled="busy" @click="close">取消</button><button class="primary-button" type="submit" :disabled="busy||!confirmAllowed">{{busy?'正在保存…':confirmText||'确定'}}</button></footer>
    </form>
   </section>
  </div>
 </Teleport>
</template>

<style scoped>
.record-association-backdrop{z-index:70}.record-association-modal{width:min(720px,100%);height:min(680px,88vh);height:min(680px,88dvh);max-height:88vh;max-height:88dvh;outline:0}.record-association-modal>header{gap:8px;min-height:50px;padding-inline:14px}.record-association-modal>header h3{font-size:16px}.association-close{position:relative;flex:0 0 28px;width:28px;height:28px;padding:0}.association-close::after{content:'';position:absolute;inset:-8px}.record-sheet>.association-form{display:flex;flex:1;flex-direction:column;min-height:0;margin:0;overflow:hidden}.association-draft-hint{flex-shrink:0;margin:10px 14px 0;color:var(--muted);font-size:12px;line-height:19px}.association-picker{display:flex;flex:1;flex-direction:column;min-height:0;padding:14px;overflow:hidden}.association-picker :deep(.record-picker-list){flex:1;min-height:0;max-height:none}.association-picker :deep(.record-picker-state:only-child){display:flex;align-items:center;justify-content:center;min-height:100%;text-align:center;padding:20px}.association-picker :deep(.record-picker-filters){flex-wrap:nowrap;flex-shrink:0;overflow-x:auto;overscroll-behavior-x:contain;touch-action:pan-x;scrollbar-width:none}.association-picker :deep(.record-picker-filters button){flex-shrink:0}.association-picker :deep(.record-picker-filters::-webkit-scrollbar){display:none}.association-picker :deep(.record-picker-option strong){font-size:14px}.association-picker :deep(.record-picker-hint){flex-shrink:0}.association-footer{flex-shrink:0;margin:0;padding:10px 14px;border-top:1px solid var(--line);background:var(--surface)}.association-save-error{flex-shrink:0;margin:0 14px 10px;width:auto}.association-close:focus-visible{outline:2px solid var(--brand);outline-offset:2px}
@media(max-width:760px),(pointer:coarse){.record-association-modal{height:88vh;height:88dvh;max-height:88vh;max-height:88dvh}.association-picker{padding:12px 14px}.association-picker :deep(.record-picker-filters button){min-height:32px}.association-footer{padding:8px 14px max(8px,env(safe-area-inset-bottom))}.record-association-modal{padding-bottom:0}}
</style>
