<script setup lang="ts">
import ReportDetail from "./ReportDetail.vue";
import type { ReportSummary, ReportDetail as ReportDetailData } from "../types/api";

defineProps<{ reportId: string; summary?: ReportSummary | null }>();
const emit = defineEmits<{
  close: [];
  updated: [];
  openCandidate: [candidate: ReportDetailData["duplicateCandidates"][number]];
}>();
</script>

<template>
  <Teleport to="body">
    <div class="sheet-backdrop report-detail-sheet-backdrop" @click.self="emit('close')">
      <section class="sheet-panel report-detail-sheet" role="dialog" aria-modal="true" aria-label="报告详情">
        <span class="sheet-grabber" aria-hidden="true"></span>
        <ReportDetail :report-id="reportId" :summary="summary" variant="floating"
          @close="emit('close')" @updated="emit('updated')" @open-candidate="emit('openCandidate', $event)" />
      </section>
    </div>
  </Teleport>
</template>
