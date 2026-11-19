<script setup lang="ts">
import type {HealthRecordRef} from '../../../shared/health-record-associations';
import RecordLoading from './RecordLoading.vue';
import type { HealthRecordHeading } from '../utils/health-record-presentation';
import { useRoute } from 'vue-router';
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import ReportDetail from './ReportDetail.vue';
import VaccinationDocument from './VaccinationDocument.vue';
import { useAppContext } from '../composables/useAppContext';
import { request } from '../utils/api';
import type { ReportDetail as ReportDetailData } from '../types/api';
import type { HealthCategory } from '../../../shared/health-categories';
const props=defineProps<{recordId:string;hideTitle?:boolean;openRelatedInPlace?:boolean}>();const emit=defineEmits<{heading:[value:HealthRecordHeading];close:[];updated:[];openReport:[id:string];openRecord:[record:HealthRecordRef]}>();const app=useAppContext();const route=useRoute();
const documents=ref<Array<{id:string;title:string}>>([]);const selected=ref('');const category=ref<HealthCategory>('report');const error=ref('');let sequence=0;let alive=true;
const initialDetail=ref<ReportDetailData|null>(null);
const scope=computed(()=>JSON.stringify([props.recordId,app.selectedMemberId.value]));
watch(scope,async()=>{
 const token=++sequence;const member=app.selectedMemberId.value;
 documents.value=[];selected.value='';initialDetail.value=null;error.value='';
 try{
  const next=await request<{memberId:string;category:HealthCategory;documents:Array<{id:string;title:string}>;detail?:ReportDetailData}>(`health-records/documents/${encodeURIComponent(props.recordId)}?includeDetail=true`);
  if(!alive||token!==sequence)return;
  if(next.memberId!==member || (next.detail && next.detail.memberId!==member))throw Error('资料不属于当前成员');
  documents.value=next.documents;category.value=next.category;
  initialDetail.value=next.detail?.id===props.recordId?next.detail:null;
  selected.value=next.documents.some(doc=>doc.id===props.recordId)?props.recordId:next.documents[0]?.id||'';
 }catch(cause){if(alive&&token===sequence)error.value=cause instanceof Error?cause.message:'无法读取资料';}
},{immediate:true,flush:'sync'});
// Switching back must fetch current data rather than replay the opening snapshot.
watch(selected,(next,previous)=>{if(previous && next!==previous)initialDetail.value=null;});
watch([selected,documents,category],()=>{const doc=documents.value.find(item=>item.id===selected.value);if(doc)emit('heading',{title:doc.title,category:category.value});});
function updated(){app.notifyDataChanged();emit('updated');}
onBeforeUnmount(()=>{alive=false;sequence++;});
</script>
<template><section class="report-bundle-detail"><p v-if="error" role="alert" class="inline-panel-error record-detail-state">{{error}}</p><template v-else-if="selected"><div v-if="documents.length>1" class="record-detail-inset record-bundle-toolbar"><div class="record-document-switch" role="group" aria-label="同次资料"><button v-for="doc in documents" :key="doc.id" :aria-pressed="selected===doc.id" @click="selected=doc.id">{{doc.title}}</button></div></div><VaccinationDocument v-if="category==='vaccination'" :key="selected" :report-id="selected" :hide-title="hideTitle" :open-related-in-place="openRelatedInPlace" @open-record="emit('openRecord',$event)" @heading="emit('heading',$event)" @close="emit('close')" @updated="updated" @open-report="emit('openReport',$event)"/><ReportDetail v-else :key="selected" :initial-detail="initialDetail" :report-id="selected" :expected-member-id="app.selectedMemberId.value" :hide-title="hideTitle || category==='medication'" :open-related-in-place="openRelatedInPlace" @open-record="emit('openRecord',$event)" variant="panel" :return-to="route.fullPath||route.path" @heading="emit('heading',$event)" @close="emit('close')" @updated="updated" @open-candidate="emit('openReport',$event.id)"/></template><RecordLoading v-else label="正在读取资料…" /></section></template>
