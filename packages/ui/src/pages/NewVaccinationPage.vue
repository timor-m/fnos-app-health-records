<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAppContext } from '../composables/useAppContext';
import { request } from '../utils/api';
import SubPageHeader from '../components/SubPageHeader.vue';
import VaccinationEditor from '../components/VaccinationEditor.vue';
import RecordLoading from '../components/RecordLoading.vue';
import { healthRecordPath,isHealthRecordKind } from '../utils/health-record-navigation';
import { vaccinationFromReport, vaccinationReturnTo } from '../utils/vaccination';
import { formatMedicationDate } from '../utils/medication-date';
import type { ReportDetail } from '../types/api';
import type { VaccinationEntry } from '../../../shared/health-categories';
const app = useAppContext(); const route = useRoute(); const router = useRouter();
const credentialTarget = ref<HTMLElement | null>(null);
const source = ref<Partial<VaccinationEntry>>({}); const reportSource = ref<ReportDetail|null>(null); const previousDose = ref<VaccinationEntry|null>(null);
const loading = ref(false); const error = ref(''); let sequence = 0; let alive = true;
const scope = computed(() => JSON.stringify([route.path,app.selectedMemberId.value,route.query.processId,route.query.sourceVaccinationId,route.query.reminderId,route.query.sourceReportId,route.query.sourceFactId,route.query.relatedId,route.query.relatedKind,route.query.memberId]));
const relatedRecords=computed(()=>route.query.memberId&&route.query.memberId!==app.selectedMemberId.value?[]:isHealthRecordKind(route.query.relatedKind)&&typeof route.query.relatedId==='string'?[{kind:route.query.relatedKind,id:route.query.relatedId}]:[]);
const backTo = computed(() => vaccinationReturnTo(route.query.returnTo,typeof route.query.sourceReportId === 'string' ? healthRecordPath('report',route.query.sourceReportId) : route.query.reminderId ? '/reminders' : '/events'));
async function load() {
  const token = ++sequence; const member = app.selectedMemberId.value;
  source.value = {}; previousDose.value = null; reportSource.value = null; error.value = ''; loading.value = false;
  if (route.path !== '/add/vaccination') return;
  if((route.query.processId||route.query.relatedId)&&route.query.memberId&&route.query.memberId!==member){error.value='关联来源不属于当前成员，请返回健康历程后重新填写';return;}
  const id = route.query.sourceVaccinationId; const reminderId = route.query.reminderId; const reportId = route.query.sourceReportId; const factId = route.query.sourceFactId;
  if (!id && !reminderId && !reportId && !factId) return;
  loading.value = true;
  try {
    if (reportId || factId) {
      if (typeof reportId !== 'string' || factId !== undefined && typeof factId !== 'string') throw Error('接种资料入口无效');
      const report = await request<ReportDetail>(`reports/${encodeURIComponent(reportId)}`);
      if (!alive || token !== sequence || member !== app.selectedMemberId.value) return;
      if (report.memberId !== member) throw Error('接种资料不属于当前成员');
      const fact = factId ? report.vaccinations.find(item => item.id === factId) : report.vaccinations.length === 1 ? report.vaccinations[0] : undefined;
      if (factId && !fact) throw Error('来源接种条目已变化');
      reportSource.value = report; source.value = vaccinationFromReport(report,fact);
    } else {
      if (typeof id !== 'string' || typeof reminderId !== 'string') throw Error('接种提醒入口无效');
      const previous = await request<VaccinationEntry>(`vaccinations/${encodeURIComponent(id)}`);
      if (!alive || token !== sequence || member !== app.selectedMemberId.value) return;
      if (previous.memberId !== member || previous.reminderId !== reminderId) throw Error('来源接种与提醒不一致');
      if (previous.nextVaccinationId || previous.reminderStatus && previous.reminderStatus !== 'pending') throw Error('这条提醒已完成或取消，请返回接种详情查看');
      previousDose.value = previous;
      source.value = {vaccineName:previous.vaccineName,manufacturer:previous.manufacturer,organizationName:previous.organizationName,completedReminderId:reminderId};
    }
  } catch (cause) { if (alive && token === sequence) error.value = cause instanceof Error ? cause.message : '接种资料读取失败'; }
  finally { if (token === sequence) loading.value = false; }
}
watch(scope, () => { void load(); }, {immediate:true,flush:'sync'});
function saved(entry:VaccinationEntry) { if (alive && route.path === '/add/vaccination' && entry.memberId === app.selectedMemberId.value) void router.replace({path:healthRecordPath('vaccination',entry.id),query:{returnTo:backTo.value}}); }
onBeforeUnmount(() => { alive = false; sequence++; });
</script>
<template>
  <section class="new-vaccination-page page-stack">
    <SubPageHeader category="vaccination" :title="previousDose?'记录下一剂':'记录接种'" :back-to="backTo" back-label="返回上一页"><div v-if="!loading && !error && app.selectedMember.value?.permission==='manager'" ref="credentialTarget" class="vaccination-header-actions" /></SubPageHeader>
    <RecordLoading v-if="loading" label="正在读取来源接种…"/>
    <p v-else-if="error" role="alert" class="inline-panel-error">{{error}} <button class="error-retry" type="button" @click="load">重试</button></p>
    <div v-else-if="app.selectedMember.value?.permission==='manager'" class="settings-band vaccination-create-panel">
      <p v-if="previousDose" class="record-detail-caption vaccination-previous-dose">上一剂：{{previousDose.vaccineName}} · {{formatMedicationDate(previousDose.administeredAt)}}<template v-if="previousDose.doseNumber"> · {{previousDose.doseNumber}}</template>。请填写本次实际接种日期和剂次。</p>
      <VaccinationEditor :key="scope" :source="source" :report="reportSource||undefined" :credential-target="credentialTarget" :initial-related-records="relatedRecords" :process-id="typeof route.query.processId==='string'?route.query.processId:undefined" @saved="saved" @cancel="router.push(backTo)"/>
    </div>
    <p v-else>当前成员仅有查看权限。</p>
  </section>
</template>
