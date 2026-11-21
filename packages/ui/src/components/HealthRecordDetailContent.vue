<script setup lang="ts">
import type { HealthRecordHeading } from '../utils/health-record-presentation';
import { computed } from 'vue';
import { useAppContext } from '../composables/useAppContext';
import MedicationRecords from './MedicationRecords.vue';
import ReportBundleDetail from './ReportBundleDetail.vue';
import HealthSymptomDetail from './HealthSymptomDetail.vue';
import MeasurementDetail from './MeasurementDetail.vue';
import VaccinationDetail from './VaccinationDetail.vue';
import type { HealthFeedEntry } from '../../../shared/health-categories';
import type { HealthRecordRef } from '../../../shared/health-record-associations';
const props=defineProps<{kind:HealthFeedEntry['kind'];recordId:string;hideReportTitle?:boolean;openRelatedInPlace?:boolean}>();
const emit=defineEmits<{heading:[value:HealthRecordHeading];close:[];updated:[];openReport:[reportId:string];openRecord:[record:HealthRecordRef]}>();
const app=useAppContext();const scope=computed(()=>JSON.stringify([app.selectedMemberId.value,props.kind,props.recordId]));
</script>
<template><div v-if="app.selectedMemberId.value" :key="scope" class="health-record-detail-content">
 <ReportBundleDetail v-if="kind==='report' || kind==='medication_document'" :record-id="recordId" :hide-title="hideReportTitle" :open-related-in-place="openRelatedInPlace" @open-record="emit('openRecord',$event)" @close="emit('close')" @heading="emit('heading',$event)" @updated="emit('updated')" @open-report="emit('openReport',$event)"/>
 <HealthSymptomDetail v-else-if="kind==='symptom'" :record-id="recordId" :open-related-in-place="openRelatedInPlace" @open-record="emit('openRecord',$event)" @close="emit('close')" @heading="emit('heading',$event)" @updated="emit('updated')"/>
 <VaccinationDetail :open-related-in-place="openRelatedInPlace" @open-record="emit('openRecord',$event)" v-else-if="kind==='vaccination'" :record-id="recordId" @close="emit('close')" @heading="emit('heading',$event)" @updated="emit('updated')" @open-report="emit('openReport',$event)"/>
 <MeasurementDetail :open-related-in-place="openRelatedInPlace" @open-record="emit('openRecord',$event)" v-else-if="kind==='measurement'" :record-id="recordId" @close="emit('close')" @heading="emit('heading',$event)" @updated="emit('updated')"/>
 <MedicationRecords :open-related-in-place="openRelatedInPlace" @open-record="emit('openRecord',$event)" v-else-if="kind==='medication'" :course-id="recordId" @close="emit('close')" @heading="emit('heading',$event)" @updated="emit('updated')"/>
 <MedicationRecords :open-related-in-place="openRelatedInPlace" @open-record="emit('openRecord',$event)" v-else-if="kind==='intake'" :intake-id="recordId" @close="emit('close')" @heading="emit('heading',$event)" @updated="emit('updated')"/>
</div><p v-else>请先选择家庭成员。</p></template>
