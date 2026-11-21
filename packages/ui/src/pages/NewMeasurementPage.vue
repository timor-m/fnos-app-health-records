<script setup lang="ts">
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import SubPageHeader from '../components/SubPageHeader.vue';
import MeasurementEditor from '../components/MeasurementEditor.vue';
import { useAppContext } from '../composables/useAppContext';
import { useToast } from '../composables/useToast';
import { healthRecordPath, isHealthRecordKind } from '../utils/health-record-navigation';
import { vaccinationReturnTo } from '../utils/vaccination';
import type { MeasurementSession, MeasurementTemplateId } from '../../../shared/measurements';
import { isMeasurementTemplateId } from '../../../shared/measurements';

const route = useRoute();
const router = useRouter();
const app = useAppContext();
const toast = useToast();
const backTo = computed(() => vaccinationReturnTo(route.query.returnTo, '/events'));
const templateId = computed<MeasurementTemplateId | null>(() =>
  isMeasurementTemplateId(route.query.template) ? route.query.template : null,
);
const processId = computed(() => typeof route.query.processId === 'string' ? route.query.processId : undefined);
const relatedRecords = computed(() =>
  route.query.memberId && route.query.memberId !== app.selectedMemberId.value
    ? []
    : isHealthRecordKind(route.query.relatedKind) && typeof route.query.relatedId === 'string'
      ? [{ kind: route.query.relatedKind, id: route.query.relatedId }]
      : [],
);

function saved(entry: MeasurementSession) {
  void router.replace({
    path: healthRecordPath('measurement', entry.id),
    query: { returnTo: backTo.value },
  });
}

function continued() {
  toast.show('已保存，可以继续记录下一次');
}
</script>

<template>
  <section class="page-stack">
    <SubPageHeader
      category="monitoring"
      title="记录测量"
      :back-to="backTo"
      back-label="返回上一页"
      description="记录血压、体格、血糖、体温、血氧等日常监测，可与报告指标一起查看趋势。"
    />
    <div class="settings-band measurement-create-panel">
      <p v-if="processId" class="measurement-process-hint">保存后将加入当前健康历程。</p>
      <MeasurementEditor
        allow-continue
        :template-id="templateId"
        :process-id="processId"
        :related-records="relatedRecords"
        @saved="saved"
        @continued="continued"
        @cancel="router.push(backTo)"
      />
    </div>
  </section>
</template>

<style scoped>
.measurement-create-panel {
  width: min(760px, 100%);
  margin-inline: auto;
  padding: 16px;
  display: grid;
  gap: 12px;
  min-width: 0;
}
.measurement-process-hint {
  margin: 0;
  font-size: 12px;
  line-height: 20px;
  color: var(--muted);
}
@media (max-width: 760px) {
  .measurement-create-panel {
    width: 100%;
    padding: 14px;
  }
}
</style>
