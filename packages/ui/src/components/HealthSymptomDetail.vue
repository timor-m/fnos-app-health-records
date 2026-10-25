<script setup lang="ts">
import RecordLoading from './RecordLoading.vue';
import type { HealthRecordHeading } from '../utils/health-record-presentation';
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useAppContext } from '../composables/useAppContext';
import { request } from '../utils/api';
import ProcessSymptomTracker from './ProcessSymptomTracker.vue';
import HealthRecordAssociations from './HealthRecordAssociations.vue';
import type { HealthEpisodeDetail } from '../types/health-events';
import type { HealthRecordRef } from '../../../shared/health-record-associations';
const props=defineProps<{recordId:string;openRelatedInPlace?:boolean}>();const emit=defineEmits<{heading:[value:HealthRecordHeading];updated:[];close:[];openRecord:[record:HealthRecordRef]}>();const app=useAppContext();
const episode=ref<HealthEpisodeDetail|null>(null);const error=ref('');const loading=ref(false);let generation=0;let alive=true;
const scope=computed(()=>JSON.stringify([props.recordId,app.selectedMemberId.value]));
async function load(preserve=false){const current=++generation;const member=app.selectedMemberId.value;if(!preserve)episode.value=null;error.value='';loading.value=true;
 try{const value=await request<{episode:HealthEpisodeDetail;symptomId:string}>(`symptoms/${encodeURIComponent(props.recordId)}`);if(!alive||current!==generation)return;
 if(value.episode.memberId!==member||value.symptomId!==props.recordId)throw Error('症状不属于当前成员');
 const symptom=value.episode.symptoms?.find(item=>item.id===props.recordId);
 if(!symptom)throw Error('症状已移除或数据不完整，请刷新列表后重试');
 episode.value={...value.episode,symptoms:[symptom]};
 }catch(cause){if(alive&&current===generation)error.value=cause instanceof Error?cause.message:'无法读取症状';}finally{if(current===generation)loading.value=false;}}
watch(episode,value=>{const symptom=value?.symptoms.find(item=>item.id===props.recordId);if(symptom)emit('heading',{title:symptom.name,category:'symptom'});});
function updated(removedSymptomId?:string){emit('updated');if(removedSymptomId===props.recordId)emit('close');else void load(true);}
watch(scope,()=>void load(),{immediate:true,flush:'sync'});onBeforeUnmount(()=>{alive=false;generation++;});
</script>
<template><div class="symptom-record-detail"><RecordLoading v-if="loading&&!episode" label="正在读取症状…" /><p v-if="error" role="alert" class="inline-panel-error record-detail-state">{{error}} <button type="button" class="error-retry" @click="load(!!episode)">重试</button></p><template v-if="episode"><ProcessSymptomTracker standalone :episode="episode" :can-manage="app.selectedMember.value?.permission==='manager'" @updated="updated"/><div class="record-detail-inset symptom-related-records"><HealthRecordAssociations compact :open-in-place="openRelatedInPlace" :subject="{kind:'symptom',id:recordId}" :member-id="episode.memberId" @open-record="emit('openRecord',$event)" @updated="updated"/></div></template></div></template>
<style scoped>
.symptom-related-records { padding-top: 0; }
.symptom-related-records :deep(.health-record-associations) { padding-top: 14px; }
.symptom-related-records :deep(.health-record-associations h4) { color: var(--ink); font-weight: 600; line-height: 24px; }
@media (max-width: 760px), (pointer: coarse) {
  .symptom-related-records :deep(.health-record-associations) { padding-top: 12px; }
}
</style>
