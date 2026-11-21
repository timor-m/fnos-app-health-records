<script setup lang="ts">
import { computed, nextTick, onActivated, onDeactivated, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type { HealthRecordHeading } from '../utils/health-record-presentation';
import SubPageHeader from '../components/SubPageHeader.vue';
import HealthRecordDetailContent from '../components/HealthRecordDetailContent.vue';
import { useAppContext } from '../composables/useAppContext';
import { useTouchRecordDetail } from '../composables/useTouchRecordDetail';
import { vaccinationReturnTo } from '../utils/vaccination';
import { healthRecordPath, healthRecordTitles, isHealthRecordKind } from '../utils/health-record-navigation';

const route = useRoute();
const router = useRouter();
const app = useAppContext();
const touch = useTouchRecordDetail();
const active = ref(true);
const page = ref<HTMLElement | null>(null);
const kind = computed(() => isHealthRecordKind(route.params.kind) ? route.params.kind : null);
const recordId = computed(() => typeof route.params.id === 'string' ? route.params.id : '');
const onDetailRoute = computed(() => Boolean(kind.value && recordId.value
  && route.path === healthRecordPath(kind.value, recordId.value)));
const showPage = computed(() => active.value && route.path.startsWith('/events/detail/')
  && (!touch.value || !onDetailRoute.value));
const contentKey = computed(() => JSON.stringify([app.selectedMemberId.value, kind.value, recordId.value]));
const backTo = computed(() => vaccinationReturnTo(route.query.returnTo,route.query.from === 'overview' ? '/overview' : '/events'));
const heading = ref<HealthRecordHeading | null>(null);
const category = computed(() => heading.value?.category || (kind.value==='symptom'?'symptom':kind.value==='vaccination'?'vaccination':kind.value==='measurement'?'monitoring':kind.value==='report'?'report':'medication'));
watch(contentKey,()=>{heading.value=null;},{flush:'sync'});
const title = computed(() => heading.value?.category==='vaccination' ? '接种详情' : heading.value?.category==='monitoring' ? '测量详情' : heading.value && ['medication','symptom'].includes(heading.value.category) ? heading.value.title : kind.value ? healthRecordTitles[kind.value] : '记录详情');

function close() {
  if (active.value && onDetailRoute.value) void router.push(backTo.value);
}
function openReport(id: string) {
  if (!active.value || !onDetailRoute.value || !id) return;
  void router.push({ path: healthRecordPath('report', id), query: route.query });
}
function redirectTouchDetail() {
  if (!active.value || !touch.value || !onDetailRoute.value || !kind.value) return;
  const origin = new URL(backTo.value,'https://health.invalid');
  const path = ['/events','/overview'].includes(origin.pathname) ? origin.pathname : '/events';
  const query = path === origin.pathname ? Object.fromEntries(origin.searchParams) : {};
  void router.replace({ path, query: { ...query, ...route.query, recordKind: kind.value, recordId: recordId.value } });
}
watch([contentKey, touch, active], async () => {
  redirectTouchDetail();
  if (!active.value || touch.value || !onDetailRoute.value) return;
  await nextTick();
  if (active.value && !touch.value && onDetailRoute.value) page.value?.scrollIntoView({ block: 'start' });
}, { immediate: true });
onDeactivated(() => { active.value = false; });
onActivated(() => { active.value = true; });
</script>

<template>
  <section v-if="showPage" ref="page" class="health-record-detail-page page-stack">
    <SubPageHeader :category="kind ? category : undefined" :title="title" :back-to="backTo" :back-label="route.query.returnTo?'返回上一页':backTo==='/overview'?'返回概览':'返回记录'" />
    <HealthRecordDetailContent v-if="!touch && onDetailRoute && kind" :key="contentKey" :kind="kind" :record-id="recordId" @heading="heading=$event" @close="close" @open-report="openReport" />
    <p v-else-if="!kind || !recordId" class="inline-panel-error" role="alert">记录链接无效，请返回记录。</p>
  </section>
</template>
