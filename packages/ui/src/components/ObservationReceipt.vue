<script setup lang="ts">
import type {ObservationRef} from '../../../shared/health-observations';
import {formatMedicationDate} from '../utils/medication-date';
defineProps<{record:ObservationRef;label?:string;recordedAt?:string;disabled?:boolean}>();
const emit=defineEmits<{edit:[record:ObservationRef,event:MouseEvent]}>();
</script>
<template><div class="observation-receipt" role="status"><span>已保存<template v-if="label">：{{label}}</template><small v-if="recordedAt">{{formatMedicationDate(recordedAt)}}</small></span><button type="button" data-observation-edit :disabled="disabled" @click="emit('edit',record,$event)">修改</button></div></template>
<style scoped>
.observation-receipt{display:flex;align-items:center;justify-content:space-between;gap:8px;min-width:0;padding:8px 10px;border-radius:8px;background:var(--brand-soft);color:var(--brand-strong);font-size:14px;line-height:20px}.observation-receipt>span{min-width:0;overflow-wrap:anywhere}.observation-receipt small{display:block;color:var(--muted);font-size:12px}.observation-receipt button{flex-shrink:0;min-height:32px;padding:4px 8px;border:0;border-radius:6px;background:transparent;color:var(--brand-strong);font:inherit;font-size:12px}.observation-receipt button:focus-visible{outline:2px solid var(--brand);outline-offset:2px}
</style>
