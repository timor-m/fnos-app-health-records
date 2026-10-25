<script setup lang="ts">
import { onActivated, onBeforeUnmount, onDeactivated, ref, watch } from 'vue';
import MedicationRecordModal from './MedicationRecordModal.vue';
import { request } from '../utils/api';
import { useToast } from '../composables/useToast';
import type { HistoricalMedication } from '../types/medications';
const props=defineProps<{memberId:string;medicationId:string}>();
const source=ref<HistoricalMedication|null>(null);const loading=ref(false);const error=ref('');let sequence=0;
const editing=ref(false);const currentCourseId=ref<string|undefined>();
let active=true;
const toast=useToast();
async function open() {
  if(!active)return;
  const current=++sequence;loading.value=true;error.value='';
  try {
    const history=await request<HistoricalMedication[]>(`medications/report-history?memberId=${encodeURIComponent(props.memberId)}`);
    if(current!==sequence)return;
    source.value=history.find(item=>item.medicationId===props.medicationId) || null;
    if(!source.value)error.value='来源用药已变化，请刷新报告后重试';
    editing.value=Boolean(source.value && !source.value.confirmedCourseIds.length);
  } catch(cause){if(current===sequence)error.value=cause instanceof Error ? cause.message : '用药信息加载失败';}
  finally{if(current===sequence)loading.value=false;}
}
function saved(record?:{id:string}){source.value=null;editing.value=false;currentCourseId.value=record?.id;toast.show('已确认用药，可继续查看或调整');}
watch(()=>[props.memberId,props.medicationId],()=>{sequence++;source.value=null;editing.value=false;currentCourseId.value=undefined;loading.value=false;error.value='';});
onBeforeUnmount(()=>{sequence++;});
onDeactivated(()=>{active=false;sequence++;source.value=null;editing.value=false;currentCourseId.value=undefined;loading.value=false;});
onActivated(()=>{active=true;});
</script>
<template>
  <div class="report-medication-use">
    <button v-if="!source" type="button" class="soft-action-button" :disabled="loading" @click="open">{{ loading ? '加载中…' : '确认实际使用' }}</button>
    <p v-if="error" role="alert">{{ error }}</p>
    <div v-if="source?.confirmedCourseIds.length" class="report-medication-existing">
      <p>这条报告用药已有确认的用药记录，可直接查看和调整。</p>
      <button v-for="id in source.confirmedCourseIds" :key="id" type="button" class="soft-action-button" @click="currentCourseId=id">查看已确认用药</button>
      <details><summary>再次开始新的一段用药</summary><button type="button" class="soft-action-button" @click="editing=true">填写新的开始日期</button></details>
    </div>
    <MedicationRecordModal v-if="source && editing" :open="true" entry-mode="course" :entry-source="source" @close="source=null;editing=false" @completed="saved" />
    <MedicationRecordModal :open="Boolean(currentCourseId)" :course-id="currentCourseId" @close="currentCourseId=undefined" />
  </div>
</template>
<style scoped>.report-medication-use{margin-top:10px;width:100%}.report-medication-use>p{font-size:12px;color:var(--danger)}.report-medication-existing{display:flex;flex-wrap:wrap;gap:10px}.report-medication-existing p{width:100%;font-size:12px;color:var(--muted)}.report-medication-existing details{width:100%}.report-medication-existing summary{font-size:12px;color:var(--muted);cursor:pointer;margin-bottom:10px}</style>
