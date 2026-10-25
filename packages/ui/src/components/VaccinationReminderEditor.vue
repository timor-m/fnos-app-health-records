<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue';
import type { VaccinationEntry } from '../../../shared/health-categories';
import { useAppContext } from '../composables/useAppContext';
import { useUnsavedRecord } from '../composables/useUnsavedRecord';
import { request } from '../utils/api';
import DateTimePicker from './DateTimePicker.vue';

const props = defineProps<{ entry: VaccinationEntry }>();
const emit = defineEmits<{ saved: [entry: VaccinationEntry]; cancel: [] }>();
const app = useAppContext();
const date = ref<string | null>(null);
const busy = ref(false);
const error = ref('');
const leave = useUnsavedRecord(() => date.value || '', busy);
let sequence = 0;
let alive = true;
watch(() => [props.entry.id, props.entry.revision, app.selectedMemberId.value], () => {
  sequence++; busy.value = false; error.value = '';
  date.value = props.entry.nextDueAt?.slice(0, 10) || null;
  leave.reset();
}, { immediate: true, flush: 'sync' });
async function save() {
  if (busy.value || app.selectedMember.value?.permission !== 'manager' || props.entry.memberId !== app.selectedMemberId.value) return;
  const value = date.value;
  const parsed = value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00Z`) : null;
  if (!parsed || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value || value! < props.entry.administeredAt.slice(0, 10)) {
    error.value = '请选择不早于本次接种的下一剂日期'; return;
  }
  const token = sequence; const member = app.selectedMemberId.value;
  busy.value = true; error.value = '';
  try {
    const next = await request<VaccinationEntry>(`vaccinations/${encodeURIComponent(props.entry.id)}`, {
      method: 'PATCH', body: JSON.stringify({ revision: props.entry.revision, nextDueAt: props.entry.nextDueAt?.slice(0, 10) === value ? props.entry.nextDueAt : value })
    });
    if (!alive || token !== sequence || member !== app.selectedMemberId.value) return;
    if (next.memberId !== member) throw Error('保存结果与当前成员不一致，请刷新后查看');
    busy.value = false; leave.reset(); app.notifyDataChanged(); void app.refreshReminderCount?.(); emit('saved', next);
  } catch (cause) { if (alive && token === sequence) error.value = cause instanceof Error ? cause.message : '提醒保存失败，请重试'; }
  finally { if (token === sequence) busy.value = false; }
}
async function cancel() { if (await leave.confirmLeave()) emit('cancel'); }
onBeforeUnmount(() => { alive = false; sequence++; });
</script>

<template>
  <form class="vaccination-reminder-form" novalidate :aria-busy="busy" @submit.prevent="save">
    <fieldset :disabled="busy">
      <DateTimePicker v-model="date" aria-label="下一剂日期" label="选择下一剂日期" :aria-invalid="!!error" @update:model-value="error=''"/>
      <p v-if="entry.reminderStatus==='dismissed'" class="record-detail-caption">原提醒已取消；修改日期并保存后重新安排，保留原日期请使用“恢复提醒”。</p>
      <p v-else class="record-detail-caption">按接种凭证或接种机构的安排填写日期。</p>
      <p v-if="error" role="alert" class="vaccination-field-error">{{error}}</p>
    </fieldset>
    <div class="form-actions vaccination-editor-actions"><button type="button" class="soft-action-button" :disabled="busy" @click="cancel">取消</button><button type="submit" class="primary-button" :disabled="busy">{{busy?'正在保存…':'保存提醒'}}</button></div>
  </form>
</template>
