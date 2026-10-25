<script setup lang="ts">
import type {HealthRecordRef} from '../../../shared/health-record-associations';
import HealthRecordAssociations from './HealthRecordAssociations.vue';
defineProps<{reportId:string;memberId:string;kind?:'report'|'medication_document';openInPlace?:boolean}>();
const emit=defineEmits<{updated:[];openRecord:[record:HealthRecordRef]}>();
</script>
<template><HealthRecordAssociations :open-in-place="openInPlace" @open-record="emit('openRecord',$event)" :subject="{kind:kind||'report',id:reportId}" :member-id="memberId" @updated="emit('updated')"/></template>
