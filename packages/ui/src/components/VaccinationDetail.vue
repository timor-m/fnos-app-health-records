<script setup lang="ts">
import type {HealthRecordRef} from '../../../shared/health-record-associations';
import { PencilLine } from '@lucide/vue';
import ReportDetail from './ReportDetail.vue';
import VaccinationOriginalUpload from './VaccinationOriginalUpload.vue';
import HealthRecordTrashAction from './HealthRecordTrashAction.vue';
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { RouterLink, useRoute } from 'vue-router';
import RecordLoading from './RecordLoading.vue';
import VaccinationEditor from './VaccinationEditor.vue';
import VaccinationReminderEditor from './VaccinationReminderEditor.vue';
import HealthRecordAssociations from './HealthRecordAssociations.vue';
import type { HealthRecordHeading } from '../utils/health-record-presentation';
import { useAppContext } from '../composables/useAppContext';
import { request } from '../utils/api';
import { formatMedicationDate } from '../utils/medication-date';
import { healthRecordPath } from '../utils/health-record-navigation';
import type { ReportDetail as ReportDetailData } from '../types/api';
import type { VaccinationEntry } from '../../../shared/health-categories';

const props = defineProps<{recordId:string; initialEntry?:VaccinationEntry;associationSubject?:HealthRecordRef;openRelatedInPlace?:boolean}>();
const emit = defineEmits<{heading:[value:HealthRecordHeading]; updated:[]; changed:[entry:VaccinationEntry]; close:[]; openReport:[id:string];openRecord:[record:HealthRecordRef]}>();
const app = useAppContext(); const route = useRoute();
const root=ref<HTMLElement|null>(null);
const sourceSnapshot = ref<ReportDetailData|null>(null);
const attachmentBusy=ref(false);
const value = ref<VaccinationEntry|null>(null); const editing = ref(false); const reminderEditing = ref(false); const error = ref(''); const reminderBusy = ref(false);
let sequence = 0; let alive = true;
const scope = computed(() => JSON.stringify([props.recordId,app.selectedMemberId.value]));
const canManage = computed(() => app.selectedMember.value?.permission === 'manager');
const hasExtra = computed(() => Boolean(value.value && [value.value.manufacturer,value.value.lotNumber,value.value.administrationSite,value.value.note].some(Boolean)));
const trashNote=computed(()=>[value.value?.sourceReportId?'原件附件会保留，可随接种信息恢复查看。':'',value.value?.reminderId?'尚未完成的下一剂提醒也会取消。':'',value.value?.completedReminderId?'关联的前一剂提醒若已完成，将恢复为待接种。':'','日期或剂次有误可使用“编辑接种”。'].join(''));
const nextDoseLink = computed(() => ({path:'/add/vaccination',query:{sourceVaccinationId:props.recordId,reminderId:value.value?.reminderId || '',returnTo:route.fullPath || healthRecordPath('vaccination',props.recordId)}}));
const reminderLabel = computed(() => value.value?.nextVaccinationId ? '已登记下一剂' : value.value?.reminderStatus === 'dismissed' ? '提醒已取消' : value.value?.reminderStatus === 'completed' ? '提醒已完成' : value.value?.reminderStatus === 'pending' ? '待接种' : '已安排日期');
async function load(useInitial = true) {
  const token = ++sequence; const member = app.selectedMemberId.value; value.value = null; sourceSnapshot.value = null; error.value = ''; editing.value = false; reminderEditing.value = false; reminderBusy.value = false; attachmentBusy.value=false;
  try {
    const next = useInitial && props.initialEntry?.id === props.recordId ? props.initialEntry : await request<VaccinationEntry>(`vaccinations/${encodeURIComponent(props.recordId)}`);
    if (!alive || token !== sequence) return;
    if (next.memberId !== member) throw Error('接种信息不属于当前成员');
    value.value = next;
  } catch (cause) { if (alive && token === sequence) error.value = cause instanceof Error ? cause.message : '读取失败'; }
}
function edit() { if(attachmentBusy.value)return; editing.value = true; reminderEditing.value = false; }
async function editReminder() { if(attachmentBusy.value)return; reminderEditing.value=true; await nextTick(); root.value?.querySelector<HTMLInputElement>('.vaccination-reminder-form input')?.focus(); }
async function setReminderStatus(status:'pending'|'dismissed') {
  const entry = value.value; const token = sequence;
  if (!entry?.reminderId || entry.nextVaccinationId || !canManage.value || reminderBusy.value || attachmentBusy.value) return;
  reminderBusy.value = true; error.value = '';
  try {
    await request(`reminders/${encodeURIComponent(entry.reminderId)}`,{method:'PUT',body:JSON.stringify({status})});
    if (!alive || token !== sequence || entry.memberId !== app.selectedMemberId.value) return;
    saved({...entry,reminderStatus:status});
    app.notifyDataChanged(); void app.refreshReminderCount?.();
  } catch (cause) { if (alive && token === sequence) error.value = cause instanceof Error ? cause.message : '提醒更新失败'; }
  finally { if (token === sequence) reminderBusy.value = false; }
}
watch(value, item => { if (item) emit('heading',{title:item.vaccineName,category:'vaccination'}); });
function saved(next:VaccinationEntry) { if(next.sourceReportId !== value.value?.sourceReportId) sourceSnapshot.value = null; value.value = next; editing.value = false; reminderEditing.value = false; emit('changed',next); emit('updated'); }
function attachmentLoaded(next:ReportDetailData) { if(next.id === value.value?.sourceReportId && next.memberId === app.selectedMemberId.value) sourceSnapshot.value = next; }
async function associationUpdated(){await load(false);if(value.value)emit('changed',value.value);emit('updated');}
watch(scope, () => { void load(); }, {immediate:true,flush:'sync'});
onBeforeUnmount(() => { alive = false; sequence++; });
</script>

<template>
  <section ref="root" class="vaccination-record-detail">
    <p v-if="error" role="alert" class="inline-panel-error record-detail-state">{{error}}</p>
    <template v-if="value">
      <VaccinationEditor v-if="editing" :entry="value" @saved="saved" @cancel="editing=false"/>
      <div v-else class="record-detail-stack">
        <HealthRecordTrashAction v-if="!reminderEditing" :target="{kind:'vaccination',id:value.id,memberId:value.memberId,title:value.vaccineName,revision:value.revision}" :disabled="reminderBusy || attachmentBusy" :note="trashNote" @trashed="emit('updated');emit('close')"><div class="preview-heading"><span class="record-detail-status is-resolved">已接种</span></div><button v-if="canManage" type="button" class="soft-action-button vaccination-toolbar-edit" :disabled="reminderBusy || attachmentBusy" @click="edit()"><PencilLine :size="14"/>编辑接种</button></HealthRecordTrashAction>
        <div class="record-detail-inset record-detail-stack">
        <h3 class="record-detail-title vaccination-detail-name">{{value.vaccineName}}</h3>
        <dl class="preview-facts record-detail-facts"><div><dt>接种日期</dt><dd>{{formatMedicationDate(value.administeredAt)}}</dd></div><div v-if="value.doseNumber"><dt>剂次</dt><dd>{{value.doseNumber}}</dd></div><div v-if="value.organizationName"><dt>接种机构</dt><dd>{{value.organizationName}}</dd></div></dl>
        <section v-if="value.nextDueAt" class="vaccination-next-dose" aria-label="下一剂提醒">
          <div class="vaccination-next-heading"><strong>下一剂 · {{formatMedicationDate(value.nextDueAt)}}</strong><span>{{reminderLabel}}</span></div>
          <VaccinationReminderEditor v-if="reminderEditing" :entry="value" @saved="saved" @cancel="reminderEditing=false"/>
          <div v-else class="record-detail-actions">
            <RouterLink v-if="value.nextVaccinationId" :to="healthRecordPath('vaccination',value.nextVaccinationId)">查看下一剂记录</RouterLink>
            <template v-else-if="canManage"><RouterLink v-if="value.reminderStatus==='pending'" :to="nextDoseLink">记录下一剂</RouterLink><button v-if="value.reminderStatus==='dismissed'" type="button" class="soft-action-button" :disabled="reminderBusy || attachmentBusy" @click="setReminderStatus('pending')">{{reminderBusy?'正在更新…':'恢复提醒'}}</button><button v-if="value.reminderStatus==='pending'" type="button" class="soft-action-button" :disabled="reminderBusy || attachmentBusy" @click="setReminderStatus('dismissed')">{{reminderBusy?'正在更新…':'取消提醒'}}</button><button v-if="value.reminderStatus!=='completed'" type="button" class="soft-action-button" :disabled="reminderBusy || attachmentBusy" @click="editReminder">调整提醒</button></template>
          </div>
        </section>
        <section v-else-if="canManage" class="vaccination-next-dose"><VaccinationReminderEditor v-if="reminderEditing" :entry="value" @saved="saved" @cancel="reminderEditing=false"/><button v-else type="button" class="soft-action-button vaccination-add-reminder" @click="editReminder">添加下一剂提醒（选填）</button></section>
        <details v-if="hasExtra" class="vaccination-supplement"><summary>补充信息</summary><div class="vaccination-extra-fields"><dl class="preview-facts record-detail-facts"><div v-if="value.manufacturer"><dt>生产厂家</dt><dd>{{value.manufacturer}}</dd></div><div v-if="value.lotNumber"><dt>批号</dt><dd>{{value.lotNumber}}</dd></div><div v-if="value.administrationSite"><dt>接种部位</dt><dd>{{value.administrationSite}}</dd></div></dl><p v-if="value.note" class="record-detail-note">{{value.note}}</p></div></details>
        <div v-if="!reminderEditing" :inert="attachmentBusy || undefined"><HealthRecordAssociations :subject="associationSubject||{kind:'vaccination',id:recordId}" :open-in-place="openRelatedInPlace" @open-record="emit('openRecord',$event)" :member-id="value.memberId" @updated="associationUpdated"/></div>
        <button v-if="value.sourceReportId && (sourceSnapshot?.vaccinations.length || 0) > 1 && !reminderEditing" type="button" class="soft-action-button vaccination-related-source" @click="emit('openReport',value.sourceReportId)">查看同份原件中的其他接种</button>
        <ReportDetail v-if="value.sourceReportId && !reminderEditing" :report-id="value.sourceReportId" :expected-member-id="value.memberId" originals-only hide-title hide-trash-action variant="panel" @loaded="attachmentLoaded" @updated="emit('updated')"/>
        <VaccinationOriginalUpload v-else-if="!reminderEditing" :entry="value" :disabled="reminderBusy" @busy="attachmentBusy=$event" @saved="saved"/>
        </div>
      </div>
    </template>
    <RecordLoading v-else-if="!error" label="正在读取接种…"/>
  </section>
</template>

<style scoped>
.vaccination-toolbar-edit { flex:0 0 auto;min-height:32px;padding:5px 10px;font-size:12px;font-weight:600;line-height:20px;white-space:nowrap; }
@media(max-width:760px),(pointer:coarse) {
  .vaccination-toolbar-edit { position:relative;min-height:28px;padding:3px 8px; }
  .vaccination-toolbar-edit::after { content:'';position:absolute;inset:-8px 0; }
}
</style>
