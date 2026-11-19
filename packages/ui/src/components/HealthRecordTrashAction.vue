<script setup lang="ts">
import { computed,onActivated,onBeforeUnmount,onDeactivated,ref,watch } from 'vue';
import { LoaderCircle,Trash2 } from '@lucide/vue';
import type { HealthTrashTarget } from '../../../shared/health-record-trash';
import { useAppContext } from '../composables/useAppContext';
import { useConfirm } from '../composables/useConfirm';
import { useToast } from '../composables/useToast';
import { useUnsavedRecord } from '../composables/useUnsavedRecord';
import { confirmUnsavedRecordChanges } from '../utils/record-edit-guards';
import { request } from '../utils/api';
const props=defineProps<{target?:HealthTrashTarget;delegate?:boolean;disabled?:boolean;note?:string}>();
const emit=defineEmits<{request:[];trashed:[]}>();
const app=useAppContext();const confirmation=useConfirm();const toast=useToast();const busy=ref(false);const active=ref(true);
useUnsavedRecord(()=>'',busy);
const permitted=computed(()=>active.value&&(props.delegate || props.target?.memberId===app.selectedMemberId.value&&app.selectedMember.value?.permission==='manager'));
let generation=0;let alive=true;watch(()=>JSON.stringify(props.target),()=>{generation++;busy.value=false;});onBeforeUnmount(()=>{alive=false;generation++;});
onActivated(()=>{active.value=true;});
onDeactivated(()=>{active.value=false;generation++;busy.value=false;});
async function open(){
 if(!permitted.value||props.disabled||busy.value)return;
 const token=generation;if(!await confirmUnsavedRecordChanges()||!alive||token!==generation||!permitted.value)return;
 if(props.delegate){emit('request');return;}
 const target=props.target;if(!target)return;
 const message=props.note || (target.kind==='report'?'未完成的识别和补页任务会停止。':target.kind==='medication'?'这段用药及其服药补充会一并隐藏，恢复时一起找回；原始用药单及其他记录保留。':target.kind==='vaccination'?'接种凭证保留，未完成的下一剂提醒取消；恢复时核对原有提醒状态。':'原件和其他关联记录会保留。');
 confirmation.ask({title:'移入回收站',message:`将「${target.title}」移入回收站？保留 30 天，期间可以恢复。${message}`,confirmText:'移入回收站',danger:true,run:async()=>{
  if(!alive||token!==generation||!permitted.value||busy.value)return;busy.value=true;
  try{
   if(target.kind==='report')await request(`reports/${encodeURIComponent(target.id)}`,{method:'DELETE'});
   else if(target.kind==='vaccination')await request(`vaccinations/${encodeURIComponent(target.id)}`,{method:'DELETE',body:JSON.stringify({revision:target.revision})});
   else await request('health-records/trash',{method:'POST',body:JSON.stringify({kind:target.kind,id:target.id,revision:target.revision,operation:'trash'})});
   if(!alive||token!==generation||!permitted.value||app.selectedMemberId.value!==target.memberId)return;busy.value=false;app.notifyDataChanged();void app.refreshReminderCount?.();toast.show('已移入回收站，可在“我的 → 回收站”恢复');emit('trashed');
  }finally{if(token===generation)busy.value=false;}
 }});
}
</script>
<template><div v-if="permitted || $slots.default" class="record-detail-toolbar"><slot/><button v-if="permitted" type="button" class="soft-action-button record-trash-button" title="移入回收站" aria-label="移入回收站" :disabled="disabled||busy" @click="open"><LoaderCircle v-if="busy" class="spin-icon" :size="15"/><Trash2 v-else :size="15"/></button></div></template>
<style scoped>
.record-detail-toolbar{display:flex;flex:0 0 auto;align-items:center;justify-content:flex-end;gap:8px;min-width:0;padding:8px var(--record-inset,16px) 0;margin:0}
.record-trash-button{display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;width:32px;height:32px;min-height:32px;padding:0;color:var(--muted);font-size:12px;line-height:20px}
.record-trash-button:hover:not(:disabled){color:var(--danger);background:var(--danger-soft)}
.record-trash-button:focus-visible{outline:2px solid var(--brand);outline-offset:2px}
@media(max-width:760px),(pointer:coarse){
  .record-detail-toolbar{padding-top:4px}
  .record-trash-button{position:relative;width:28px;height:28px;min-height:28px}
  .record-trash-button::after{content:'';position:absolute;inset:-8px}
}
</style>
