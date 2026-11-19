<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { ArrowLeft } from "@lucide/vue";
import ReportDetail from "./ReportDetail.vue";
import { useScrollLock } from "../composables/useScrollLock";
import type { ReportDetail as ReportDetailType } from "../types/api";

type DuplicateCandidate = ReportDetailType["duplicateCandidates"][number];

const props = defineProps<{ open: boolean; reportId: string | null; hideVaccinationConfirmation?: boolean; originalsOnly?: boolean }>();
const emit = defineEmits<{ close: []; updated: [] }>();
useScrollLock(computed(() => props.open));

/* 弹窗内核对重复候选时原地切换，而不是关窗跳到档案页：
   核对完能返回上一份继续归档，也不丢失当前页面的浏览上下文。 */
const currentReportId = ref<string | null>(props.reportId);
const reportHistory = ref<string[]>([]);

watch(
  () => [props.open, props.reportId],
  () => {
    currentReportId.value = props.reportId;
    reportHistory.value = [];
  },
);

function onOpenCandidate(candidate: DuplicateCandidate) {
  if (!currentReportId.value || candidate.id === currentReportId.value) return;
  reportHistory.value = [...reportHistory.value, currentReportId.value];
  currentReportId.value = candidate.id;
}

function goBackToPreviousReport() {
  const previous = reportHistory.value[reportHistory.value.length - 1];
  if (!previous) return;
  reportHistory.value = reportHistory.value.slice(0, -1);
  currentReportId.value = previous;
}
</script>

<template>
  <Teleport to="body">
    <div v-if="props.open && currentReportId" class="modal-backdrop" @click.self="emit('close')">
      <section
        class="modal-panel duplicate-detail-modal report-detail-modal record-sheet"
        :class="{ 'has-report-history': reportHistory.length > 0 }"
        role="dialog"
        aria-modal="true"
        aria-label="档案详情"
      >
        <span class="sheet-grabber" aria-hidden="true"></span>
        <div v-if="reportHistory.length" class="report-history-bar">
          <button type="button" class="report-history-back" @click="goBackToPreviousReport">
            <ArrowLeft :size="15" />返回上一份报告
          </button>
        </div>
        <ReportDetail
          :key="currentReportId"
          :report-id="currentReportId"
          variant="floating"
          :hide-vaccination-confirmation="hideVaccinationConfirmation"
          :originals-only="originalsOnly"
          @close="emit('close')"
          @updated="emit('updated')"
          @open-candidate="onOpenCandidate"
        />
      </section>
    </div>
  </Teleport>
</template>
