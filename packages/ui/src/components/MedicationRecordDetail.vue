<script setup lang="ts">
import { formatMedicationFrequency } from '../../../shared/medication-frequency';
import { RouterLink } from 'vue-router';
import { healthRecordPath } from '../utils/health-record-navigation';
import HealthRecordTrashAction from './HealthRecordTrashAction.vue';
import type { HealthTrashTarget } from '../../../shared/health-record-trash';
import { PencilLine, Pill } from '@lucide/vue';
import { medicationActionLabels, medicationStatusLabels } from '../../../shared/medications';
import type { MedicationAction, MedicationCourse, MedicationFields, MedicationIntake } from '../types/medications';
import { formatMedicationDate } from '../utils/medication-date';

const props = defineProps<{course?:MedicationCourse; intake?:MedicationIntake; intakes:MedicationIntake[]; trashTarget?:HealthTrashTarget; canManage:boolean; busy:boolean; showName?:boolean; openRelatedInPlace?:boolean}>();
const emit = defineEmits<{
  editCourse:[action:Exclude<MedicationAction,'start'>]; addIntake:[]; trashed:[];
  editIntake:[intake:MedicationIntake]; intakeTrashed:[]; source:[id:string]; parent:[id:string];
}>();
function usage(item:Partial<MedicationFields>) {
  return [item.specification,item.dosageForm,[item.dose,item.doseUnit].filter(Boolean).join(' '),formatMedicationFrequency(item.frequency),item.route].filter(Boolean).join(' · ');
}
</script>

<template>
  <div class="medication-detail">
    <template v-if="course && !intake">
      <HealthRecordTrashAction :target="trashTarget" :disabled="busy" class="medication-detail-toolbar" @trashed="emit('trashed')">
        <div class="preview-heading"><span class="medication-detail-status record-detail-status" :class="`is-${course.status}`">{{ course.status==='active' ? '用药中' : medicationStatusLabels[course.status] }}</span></div>
        <div v-if="canManage" class="medication-toolbar-actions medication-detail-actions record-detail-compact-actions">
          <button type="button" class="soft-action-button" :disabled="busy" :aria-label="course.status==='stopped' ? '补记一次已服药' : '记一次已服药'" :title="course.status==='stopped' ? '补记一次已服药' : '记一次已服药'" @click="emit('addIntake')"><Pill :size="14" />{{ course.status==='stopped' ? '补记服药' : '记服药' }}</button>
          <template v-if="course.status!=='stopped'">
            <button type="button" class="soft-action-button" :disabled="busy" @click="emit('editCourse','adjust')">调整</button>
            <button type="button" class="soft-action-button" :disabled="busy" @click="emit('editCourse',course.status==='paused' ? 'resume' : 'pause')">{{ course.status==='paused' ? '恢复' : '暂停' }}</button>
            <button type="button" class="soft-action-button" :disabled="busy" @click="emit('editCourse','stop')">停止</button>
          </template>
        </div>
      </HealthRecordTrashAction>
      <h3 v-if="showName" class="medication-detail-name">{{ course.medicationName }}</h3>
      <dl class="preview-facts record-detail-facts">
        <div v-if="course.specification"><dt>药品规格</dt><dd>{{ course.specification }}</dd></div>
        <div v-if="course.dosageForm"><dt>剂型</dt><dd>{{ course.dosageForm }}</dd></div>
        <div v-if="course.dose"><dt>每次用量</dt><dd>{{ [course.dose,course.doseUnit].filter(Boolean).join(' ') }}</dd></div>
        <div v-if="course.frequency"><dt>用药频次</dt><dd>{{ formatMedicationFrequency(course.frequency) }}</dd></div>
        <div v-if="course.route"><dt>用药途径</dt><dd>{{ course.route }}</dd></div>
        <div><dt>开始用药</dt><dd>{{ formatMedicationDate(course.startedAt) }}</dd></div>
        <div v-if="course.status==='stopped'"><dt>停止用药</dt><dd>{{ formatMedicationDate(course.stoppedAt || course.lastChangedAt) }}</dd></div>
        <div v-else-if="course.lastChangedAt!==course.startedAt"><dt>最近变更</dt><dd>{{ formatMedicationDate(course.lastChangedAt) }}</dd></div>
        <div v-if="course.instructions"><dt>用药说明</dt><dd class="medication-detail-note">{{ course.instructions }}</dd></div>
        <div v-if="course.source"><dt>来源报告</dt><dd class="medication-detail-source"><button v-if="course.sourceReportId" type="button" class="medication-detail-link" @click="emit('source',course.sourceReportId)">{{ course.source.reportTitle }}</button><span v-else>{{ course.source.reportTitle }}（原报告不可用，已保留确认时快照）</span></dd></div>
      </dl>
      <details v-if="course.source" class="medication-detail-disclosure record-detail-disclosure">
        <summary>确认时的处方</summary>
        <div class="medication-detail-snapshot"><strong>{{ course.source.medicationName }}</strong><p>{{ usage(course.source) || '原报告未注明详细用法' }}</p><p v-if="course.source.instructions">{{ course.source.instructions }}</p><p v-if="course.source.duration">疗程：{{ course.source.duration }}</p></div>
      </details>
      <details v-if="course.changes.length" class="medication-detail-disclosure record-detail-disclosure">
        <summary>查看使用历史（{{ course.changes.length }}）</summary>
        <ol class="medication-detail-history"><li v-for="change in course.changes" :key="change.id"><div class="medication-detail-row"><strong>{{ medicationActionLabels[change.action] }}</strong><time>{{ formatMedicationDate(change.occurredAt) }}</time></div><p>{{ change.snapshot.medicationName }} · {{ usage(change.snapshot) || '未填写用法' }}</p><p v-if="change.snapshot.instructions">{{ change.snapshot.instructions }}</p><p v-if="change.note">{{ change.note }}</p></li></ol>
      </details>
      <section v-if="intakes.length" class="medication-detail-intakes" aria-label="服用记录">
        <header><h4>服用记录 <span>{{ intakes.length }}</span></h4></header>
        <article v-for="item in intakes" :key="item.id" class="medication-detail-intake">
          <div class="medication-detail-row"><strong>{{ item.amount }} {{ item.amountUnit }}</strong><time>{{ formatMedicationDate(item.takenAt) }}</time></div>
          <p v-if="item.medicationName!==course.medicationName">{{ item.medicationName }}</p>
          <p v-if="item.specification || item.dosageForm || item.route" class="medication-detail-caption">{{ [item.specification,item.dosageForm,item.route].filter(Boolean).join(' · ') }}</p>
          <p v-if="item.note" class="medication-detail-note">{{ item.note }}</p>
          <HealthRecordTrashAction v-if="canManage" class="medication-intake-toolbar medication-detail-actions" :target="{kind:'intake',id:item.id,memberId:item.memberId,title:item.medicationName,revision:item.revision}" :disabled="busy" @trashed="emit('intakeTrashed')"><button type="button" class="soft-action-button" :disabled="busy" @click="emit('editIntake',item)">编辑</button></HealthRecordTrashAction>
          <details v-if="item.history.length" class="medication-detail-disclosure record-detail-disclosure"><summary>修订记录（{{ item.history.length }}）</summary><ol class="medication-detail-history"><li v-for="(revision,index) in item.history" :key="index"><div class="medication-detail-row"><strong>编辑前</strong><time>{{ formatMedicationDate(revision.recordedAt) }}</time></div><p>{{ revision.snapshot.medicationName }} {{ revision.snapshot.specification }} · {{ revision.snapshot.amount }} {{ revision.snapshot.amountUnit }} · {{ formatMedicationDate(String(revision.snapshot.takenAt || '')) }}</p></li></ol></details>
        </article>
      </section>
    </template>
    <template v-else-if="intake">
      <HealthRecordTrashAction :target="trashTarget" :disabled="busy" class="medication-detail-toolbar" @trashed="emit('trashed')">
        <div class="preview-heading"><span class="medication-detail-caption">单次服药</span><span class="medication-detail-status record-detail-status is-active">已服用</span></div>
        <div v-if="canManage" class="medication-toolbar-actions medication-detail-actions record-detail-compact-actions"><button type="button" class="soft-action-button" :disabled="busy" @click="emit('editIntake',intake)"><PencilLine :size="14" />编辑</button></div>
      </HealthRecordTrashAction>
      <h3 v-if="showName" class="medication-detail-name">{{ intake.medicationName }}</h3>
      <dl class="preview-facts record-detail-facts">
        <div><dt>服用时间</dt><dd>{{ formatMedicationDate(intake.takenAt) }}</dd></div>
        <div><dt>服用量</dt><dd>{{ intake.amount }} {{ intake.amountUnit }}</dd></div>
        <div v-if="intake.specification"><dt>药品规格</dt><dd>{{ intake.specification }}</dd></div>
        <div v-if="intake.dosageForm"><dt>剂型</dt><dd>{{ intake.dosageForm }}</dd></div>
        <div v-if="intake.route"><dt>用药途径</dt><dd>{{ intake.route }}</dd></div>
        <div v-if="course"><dt>所属用药</dt><dd class="medication-detail-source"><button v-if="openRelatedInPlace" type="button" class="medication-detail-link" @click="emit('parent',course.id)">{{ course.medicationName }}{{ course.specification ? ' · '+course.specification : '' }}</button><RouterLink v-else class="medication-detail-link" :to="healthRecordPath('medication',course.id)">{{ course.medicationName }}{{ course.specification ? ' · '+course.specification : '' }}</RouterLink></dd></div>
        <div v-if="intake.source"><dt>来源用药单</dt><dd class="medication-detail-source"><button v-if="intake.sourceReportId" type="button" class="medication-detail-link" @click="emit('source',intake.sourceReportId)">{{ intake.source.reportTitle }}</button><span v-else>{{ intake.source.reportTitle }}（原报告不可用，已保留来源快照）</span></dd></div>
        <div v-if="intake.note"><dt>备注</dt><dd class="medication-detail-note">{{ intake.note }}</dd></div>
      </dl>
      <details v-if="intake.history.length" class="medication-detail-disclosure record-detail-disclosure"><summary>修订记录（{{ intake.history.length }}）</summary><ol class="medication-detail-history"><li v-for="(revision,index) in intake.history" :key="index"><div class="medication-detail-row"><strong>编辑前</strong><time>{{ formatMedicationDate(revision.recordedAt) }}</time></div><p>{{ revision.snapshot.medicationName }} {{ revision.snapshot.specification }} · {{ revision.snapshot.amount }} {{ revision.snapshot.amountUnit }} · {{ formatMedicationDate(String(revision.snapshot.takenAt || '')) }}</p></li></ol></details>
    </template>
  </div>
</template>

<style scoped>
.medication-detail { display: grid; min-width: 0; gap: 14px; font-size: 14px; line-height: 1.6; overflow-wrap: anywhere; }
.medication-detail > .medication-detail-toolbar { display: grid; grid-template-columns: minmax(0,1fr) auto auto; gap: 6px; padding-inline: 0; }
.medication-detail-toolbar > .preview-heading { grid-column: 1; grid-row: 1; flex-wrap: nowrap; }
.medication-detail-toolbar .record-detail-status { white-space: nowrap; }
.medication-toolbar-actions.record-detail-compact-actions { grid-column: 2; grid-row: 1; width: auto; min-width: 0; margin: 0; gap: 6px; flex-wrap: nowrap; }
.medication-toolbar-actions > button { flex: 0 0 auto; white-space: nowrap; }
.medication-toolbar-actions > button > svg { flex-shrink: 0; }
.medication-detail-toolbar :deep(.record-trash-button) { grid-column: 3; grid-row: 1; }
.medication-detail-name { margin: 0; font-size: 16px; font-weight: 600; }
.medication-detail dl { margin: 0; }
.medication-detail-link { min-width: 0; border: 0; padding: 0; background: none; color: var(--brand-strong); font: inherit; text-align: right; text-decoration: underline; text-underline-offset: 3px; overflow-wrap: anywhere; }
.medication-detail-note { white-space: pre-wrap; }
.medication-detail-snapshot { margin-top: 8px; padding: 10px 12px; background: var(--fill-2); border-radius: 8px; }
.medication-detail p { margin: 4px 0 0; }
.medication-detail-history { margin: 8px 0 0; padding: 0 0 0 12px; list-style: none; border-left: 1px solid var(--line); }
.medication-detail-history > li + li { margin-top: 12px; }
.medication-detail-row { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.medication-detail-row > strong { font-weight: 600; }
.medication-detail-row > time { margin-left: auto; color: var(--muted); font-size: 12px; }
.medication-detail-caption { color: var(--muted); font-size: 12px; }
.medication-detail-intakes { display: grid; gap: 10px; border-top: 1px solid var(--line); padding-top: 14px; }
.medication-detail-intakes > header { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; }
.medication-detail-intakes h4 { margin: 0; font-size: 16px; font-weight: 600; }
.medication-detail-intakes h4 > span { margin-left: 4px; color: var(--muted); font-size: 12px; font-weight: 400; }
.medication-detail-intake + .medication-detail-intake { padding-top: 10px; border-top: 1px dashed var(--line); }
.medication-detail-intake .medication-detail-actions { margin-top: 8px; }
.medication-intake-toolbar.record-detail-toolbar { justify-content: flex-start; padding: 0; }
.medication-detail-checkbox { display: flex; align-items: center; gap: 5px; color: var(--muted); font-size: 12px; }
.medication-detail-checkbox input { width: auto; margin: 0; }
@media (max-width: 760px), (pointer: coarse) {
  .medication-detail { gap: 12px; }
  .medication-detail-source { display: block; flex: 1 1 0; text-align: left; white-space: normal; overflow-wrap: anywhere; }
  .medication-detail-source > .medication-detail-link { max-width: 100%; text-align: left; white-space: normal; }
  .medication-detail > .medication-detail-toolbar { gap: 4px; padding-top: 6px; }
  .medication-detail-toolbar .record-detail-status { padding-inline: 4px; }
  .medication-toolbar-actions.record-detail-compact-actions { gap: 4px; }
  .medication-toolbar-actions > button { position: relative; min-width: 40px; gap: 3px; padding-inline: 6px; justify-content: center; }
  .medication-detail-toolbar :deep(.record-trash-button) { width: 40px; height: 32px; min-height: 32px; }
  .medication-toolbar-actions > button::after, .medication-detail-toolbar :deep(.record-trash-button::after) { content: ''; position: absolute; inset: -6px -2px; }
}
</style>
