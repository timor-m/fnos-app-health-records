<script setup lang="ts">
import { useUnsavedRecord } from "../composables/useUnsavedRecord";
import { createSubmissionKey } from "../utils/submission-key";
import { onBeforeUnmount, computed, reactive, ref, watch } from "vue";
import { LoaderCircle, Pencil, X } from "@lucide/vue";
import FormSelect from "./FormSelect.vue";
import { useScrollLock } from "../composables/useScrollLock";
import { useToast } from "../composables/useToast";
import { request } from "../utils/api";
import type {
  ReportStructuredSection,
  ReportStructuredSectionKey
} from "../types/api";

const props = defineProps<{
  open: boolean;
  expectedSourceVersion?:number;
  reportId: string;
  reportType: string;
  section: ReportStructuredSection | null;
}>();
const emit = defineEmits<{ close: []; saved: [] }>();
const toast = useToast();
const saving = ref(false);
const error = ref("");
const form = reactive({
  sectionKey: "checkup_package" as ReportStructuredSectionKey,
  title: "",
  content: ""
});

const structuredSectionLabels: Record<ReportStructuredSectionKey, string> = {
  checkup_package: "体检套餐",
  checkup_positive_findings: "阳性发现",
  checkup_abnormal_summary: "异常汇总",
  checkup_final_conclusion: "总检结论",
  checkup_original_recommendation: "原报告建议",
  laboratory_specimen: "检验标本",
  laboratory_method: "检验方法",
  imaging_modality: "检查方式",
  imaging_contrast: "增强信息",
  functional_method: "检查方法",
  functional_description: "检查描述",
  pathology_specimen: "病理标本",
  pathology_gross_findings: "肉眼所见",
  pathology_microscopic_findings: "镜下所见",
  pathology_immunohistochemistry: "免疫组化",
  pathology_grade: "病理分级",
  pathology_stage: "病理分期",
  outpatient_history: "病史",
  outpatient_physical_examination: "体格检查",
  outpatient_disposition: "处置",
  outpatient_advice: "医嘱",
  inpatient_course: "住院经过",
  inpatient_discharge_instructions: "出院医嘱"
};

const keysByReportType: Partial<Record<string, ReportStructuredSectionKey[]>> = {
  checkup: [
    "checkup_package", "checkup_positive_findings", "checkup_abnormal_summary",
    "checkup_final_conclusion", "checkup_original_recommendation"
  ],
  laboratory: ["laboratory_specimen", "laboratory_method"],
  imaging: ["imaging_modality", "imaging_contrast"],
  functional: ["functional_method", "functional_description"],
  pathology: [
    "pathology_specimen", "pathology_gross_findings", "pathology_microscopic_findings",
    "pathology_immunohistochemistry", "pathology_grade", "pathology_stage"
  ],
  outpatient: [
    "outpatient_history", "outpatient_physical_examination",
    "outpatient_disposition", "outpatient_advice"
  ],
  inpatient: ["inpatient_course", "inpatient_discharge_instructions"]
};

const sectionOptions = computed(() => {
  const current = props.section?.sectionKey;
  const keys = keysByReportType[props.reportType] || [];
  const effective = current && !keys.includes(current) ? [current, ...keys] : keys;
  return effective.map((value) => ({ value, label: structuredSectionLabels[value] }));
});

const editVersion=ref<number>();
let generation=0;let alive=true;onBeforeUnmount(()=>{alive=false;generation++;});
const leave=useUnsavedRecord(()=>props.open?JSON.stringify(form):'',saving);
const submissionKey=createSubmissionKey();
async function close(){if(await leave.confirmLeave())emit('close');}
watch(() => [props.open, props.reportId, props.section] as const, ([open]) => {
  generation++;saving.value=false;editVersion.value=props.expectedSourceVersion;if(!open){leave.reset();return;}
  const fallback = sectionOptions.value[0]?.value || "checkup_package";
  form.sectionKey = props.section?.sectionKey || fallback;
  form.title = props.section?.title || structuredSectionLabels[form.sectionKey];
  form.content = props.section?.content || "";
  error.value = "";
  leave.reset();submissionKey.reset();
}, { immediate: true });

watch(() => form.sectionKey, (key, previous) => {
  if (!form.title || form.title === structuredSectionLabels[previous]) {
    form.title = structuredSectionLabels[key];
  }
});

useScrollLock(computed(() => props.open));

async function save() {
  if(saving.value||!props.open)return;const token=generation;
  saving.value = true;
  error.value = "";
  try {
    const payload = {
      sectionKey: form.sectionKey,
      title: form.title,
      content: form.content,expectedSourceVersion:editVersion.value
    };
    if (props.section?.id) {
      await request(`report-structured-sections/${encodeURIComponent(props.section.id)}`, {
        method: "PUT",
        body: JSON.stringify({...payload,requestKey:submissionKey.forRequest(props.reportId,payload)})
      });
    } else {
      await request(`reports/${encodeURIComponent(props.reportId)}/structured-sections`, {
        method: "POST",
        body: JSON.stringify({...payload,requestKey:submissionKey.forRequest(props.reportId,payload)})
      });
    }
    if(!alive||token!==generation||!props.open)return;
    toast.show("报告专属内容已保存");
    leave.reset();emit("saved");
    emit("close");
  } catch (cause) {
    if(alive&&token===generation)error.value = cause instanceof Error ? cause.message : "保存失败";
  } finally {
    if(token===generation)saving.value = false;
  }
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="modal-backdrop structured-section-editor-backdrop" @click.self="close">
      <section class="modal-panel structured-section-editor" role="dialog" aria-modal="true" aria-label="校对报告专属内容">
        <header>
          <div>
            <Pencil :size="19" />
            <span>
              <strong>{{ section ? "校对" : "新增" }}报告专属内容</strong>
              <small>人工结果在后续 AI 重跑时保持优先</small>
            </span>
          </div>
          <button class="plain-icon-button" type="button" title="关闭" @click="close"><X :size="18" /></button>
        </header>
        <form class="settings-form structured-section-editor-form" @submit.prevent="save">
          <div class="form-grid">
            <label>
              <span>内容类型</span>
              <FormSelect v-model="form.sectionKey" :options="sectionOptions" />
            </label>
            <label><span>显示标题</span><input v-model="form.title" required maxlength="120" /></label>
            <label class="field-wide">
              <span>报告原文内容</span>
              <textarea v-model="form.content" rows="10" required maxlength="20000"></textarea>
            </label>
          </div>
          <p v-if="error" class="inline-panel-error">{{ error }}</p>
          <footer class="form-actions record-form-actions">
            <button type="button" @click="close">取消</button>
            <button class="primary-button" type="submit" :disabled="saving">
              <LoaderCircle v-if="saving" class="spin-icon" :size="16" />{{ saving ? "保存中" : "保存校对" }}
            </button>
          </footer>
        </form>
      </section>
    </div>
  </Teleport>
</template>
