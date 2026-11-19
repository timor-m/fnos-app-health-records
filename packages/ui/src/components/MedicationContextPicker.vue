<script setup lang="ts">
import { computed } from 'vue';
import HealthRecordAssociationField from './HealthRecordAssociationField.vue';
import type { MedicationContext } from '../types/medications';
import type { HealthRecordRef } from '../../../shared/health-record-associations';
const props=defineProps<{memberId:string;modelValue:MedicationContext;disabled?:boolean;exclude?:HealthRecordRef[]}>();
const emit=defineEmits<{'update:modelValue':[value:MedicationContext]}>();
const records=computed({get:()=>props.modelValue.relatedRecords||[],set:(relatedRecords:HealthRecordRef[])=>emit('update:modelValue',{...props.modelValue,relatedRecords})});
</script>
<template><section class="medication-context-picker">
 <p v-if="modelValue.processId" class="medication-context-hint">保存后加入当前健康历程。</p>
 <HealthRecordAssociationField v-else v-model="records" :member-id="memberId" :exclude="exclude" :disabled="disabled"/>
</section></template>
<style scoped>
.medication-context-picker{grid-column:1/-1;min-width:0}.medication-context-hint{font-size:12px;line-height:19px;color:var(--muted);margin:4px 0}
</style>
