<script setup lang="ts">
import { PencilLine } from '@lucide/vue';
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type { HealthRecordRef } from '../../../shared/health-record-associations';
import {
  formatMeasurementSessionTitle,
  measurementChannelLabels,
  type MeasurementSession,
} from '../../../shared/measurements';
import HealthRecordAssociations from './HealthRecordAssociations.vue';
import HealthRecordTrashAction from './HealthRecordTrashAction.vue';
import RecordLoading from './RecordLoading.vue';
import MeasurementEditor from './MeasurementEditor.vue';
import type { HealthRecordHeading } from '../utils/health-record-presentation';
import { useAppContext } from '../composables/useAppContext';
import { request } from '../utils/api';
import { formatMedicationDate } from '../utils/medication-date';

const props = defineProps<{ recordId: string; openRelatedInPlace?: boolean }>();
const emit = defineEmits<{
  heading: [value: HealthRecordHeading];
  updated: [];
  close: [];
  openRecord: [record: HealthRecordRef];
}>();

const app = useAppContext();
const route = useRoute();
const router = useRouter();
const value = ref<MeasurementSession | null>(null);
const editing = ref(false);
const error = ref('');
let sequence = 0;
let alive = true;
const scope = computed(() => JSON.stringify([props.recordId, app.selectedMemberId.value]));
const canManage = computed(() => app.selectedMember.value?.permission === 'manager');
const title = computed(() => value.value ? formatMeasurementSessionTitle(value.value.templateId, value.value.items) : '测量记录');

async function load() {
  const token = ++sequence;
  const member = app.selectedMemberId.value;
  value.value = null;
  error.value = '';
  editing.value = false;
  try {
    const next = await request<MeasurementSession>(`measurements/${encodeURIComponent(props.recordId)}`);
    if (!alive || token !== sequence) return;
    if (next.memberId !== member) throw Error('测量记录不属于当前成员');
    value.value = next;
  } catch (cause) {
    if (alive && token === sequence) error.value = cause instanceof Error ? cause.message : '读取失败';
  }
}

watch(value, (item) => {
  if (item) emit('heading', { title: formatMeasurementSessionTitle(item.templateId, item.items), category: 'monitoring' });
});
watch(scope, () => { void load(); }, { immediate: true, flush: 'sync' });
onBeforeUnmount(() => { alive = false; sequence++; });

function saved(next: MeasurementSession) {
  value.value = next;
  editing.value = false;
  emit('updated');
}

async function associationUpdated() {
  await load();
  emit('updated');
}
</script>

<template>
  <section class="measurement-record-detail">
    <p v-if="error" role="alert" class="inline-panel-error record-detail-state">{{ error }}</p>
    <template v-if="value">
      <MeasurementEditor v-if="editing" :entry="value" @saved="saved" @cancel="editing=false" />
      <div v-else class="record-detail-stack">
        <HealthRecordTrashAction
          :target="{ kind: 'measurement', id: value.id, memberId: value.memberId, title, revision: value.revision }"
          @trashed="emit('updated'); emit('close')"
        >
          <div class="preview-heading">
            <span class="record-detail-status is-resolved">{{ measurementChannelLabels[value.channel] }}</span>
          </div>
          <button v-if="canManage" type="button" class="soft-action-button measurement-toolbar-edit" @click="editing=true">
            <PencilLine :size="14" />编辑测量
          </button>
        </HealthRecordTrashAction>
        <div class="record-detail-inset record-detail-stack">
          <h3 class="record-detail-title">{{ title }}</h3>
          <dl class="preview-facts record-detail-facts">
            <div><dt>测量时间</dt><dd>{{ formatMedicationDate(value.recordedAt) }}</dd></div>
            <div><dt>来源</dt><dd>{{ measurementChannelLabels[value.channel] }}</dd></div>
            <div v-if="value.deviceVendor || value.deviceModel">
              <dt>设备</dt>
              <dd>{{ [value.deviceVendor, value.deviceModel].filter(Boolean).join(' ') }}</dd>
            </div>
          </dl>
          <section class="measurement-items" aria-label="测量结果">
            <h4 class="record-detail-section-title">测量结果</h4>
            <dl class="preview-facts record-detail-facts">
              <div v-for="item in value.items" :key="item.id">
                <dt>{{ item.displayName }}<small v-if="item.origin==='derived'"> · 自动计算</small></dt>
                <dd>{{ item.numericValue }} {{ item.unit }}</dd>
              </div>
            </dl>
          </section>
          <p v-if="value.note" class="record-detail-note">{{ value.note }}</p>
          <HealthRecordAssociations
            :subject="{ kind: 'measurement', id: recordId }"
            :open-in-place="openRelatedInPlace"
            :member-id="value.memberId"
            @open-record="emit('openRecord', $event)"
            @updated="associationUpdated"
          />
          <button
            v-if="value.items.length"
            type="button"
            class="soft-action-button"
            @click="router.push({ path: '/trends', query: { returnTo: route.fullPath } })"
          >查看相关趋势</button>
        </div>
      </div>
    </template>
    <RecordLoading v-else-if="!error" label="正在读取测量…" />
  </section>
</template>

<style scoped>
.measurement-toolbar-edit { flex:0 0 auto;min-height:32px;padding:5px 10px;font-size:12px;font-weight:600;line-height:20px;white-space:nowrap; }
.measurement-items { display:grid;gap:8px; }
.record-detail-section-title { margin:0;font-size:16px;font-weight:600; }
.measurement-items small { color:var(--muted);font-weight:400; }
</style>
