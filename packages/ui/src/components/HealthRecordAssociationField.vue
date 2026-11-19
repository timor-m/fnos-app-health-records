<script setup lang="ts">
import { computed, onDeactivated, ref, watch } from 'vue';
import HealthRecordAssociationModal from './HealthRecordAssociationModal.vue';
import { useAppContext } from '../composables/useAppContext';
import type { HealthRecordRef } from '../../../shared/health-record-associations';
const props=defineProps<{memberId:string;modelValue:HealthRecordRef[];disabled?:boolean;exclude?:HealthRecordRef[]}>();
const emit=defineEmits<{'update:modelValue':[records:HealthRecordRef[]]}>();
const app=useAppContext();const open=ref(false);const trigger=ref<HTMLElement|null>(null);
const writable=computed(()=>props.memberId===app.selectedMemberId.value&&app.selectedMember.value?.permission==='manager');
function confirm(records:HealthRecordRef[]){if(!writable.value||props.disabled)return;open.value=false;emit('update:modelValue',records);}
watch(()=>JSON.stringify([props.memberId,props.modelValue,props.disabled,writable.value]),()=>{open.value=false;});
onDeactivated(()=>{open.value=false;});
</script>
<template>
 <div class="record-association-field">
  <p>{{modelValue.length?'已选择 '+modelValue.length+' 条相关记录':'关联历程（选填）'}}</p>
  <button ref="trigger" type="button" class="soft-action-button" aria-haspopup="dialog" :aria-expanded="open" :disabled="disabled||!writable" @click="open=true">{{modelValue.length?'调整历程关联':'关联历程'}}</button>
  <HealthRecordAssociationModal v-if="open" :member-id="memberId" :initial-records="modelValue" :exclude="exclude" :busy="false" selection-only :return-focus="trigger" @close="open=false" @confirm="confirm"/>
 </div>
</template>
<style scoped>
.record-association-field{display:flex;align-items:center;justify-content:space-between;gap:8px;grid-column:1/-1;min-width:0}.record-association-field>p{margin:0;color:var(--muted);font-size:12px;line-height:20px;overflow-wrap:anywhere}.record-association-field>button{flex-shrink:0;min-height:32px;padding:5px 10px;font-size:12px;line-height:20px}
</style>
