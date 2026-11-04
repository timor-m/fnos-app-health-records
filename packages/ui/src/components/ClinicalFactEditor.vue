<script setup lang="ts">
import MedicationFormulaPanel from './MedicationFormulaPanel.vue';
import {parseMedicationFormula,type MedicationFormula} from '../../../shared/medication-formula';
import FormSuggest from './FormSuggest.vue';
import MedicationUnitPicker from './MedicationUnitPicker.vue';
import { medicationDosageFormOptions, medicationFrequencyOptions, medicationQuantityUnitOptions, medicationRouteOptions } from '../utils/record-form-options';
import { useUnsavedRecord } from "../composables/useUnsavedRecord";
import { createSubmissionKey } from "../utils/submission-key";
import { onBeforeUnmount, computed, reactive, ref, watch } from "vue";
import { LoaderCircle, Pencil, X } from "@lucide/vue";
import DateTimePicker from "./DateTimePicker.vue";
import FormSelect from "./FormSelect.vue";
import { useScrollLock } from "../composables/useScrollLock";
import { useToast } from "../composables/useToast";
import { request } from "../utils/api";
import type { ClinicalFactType } from "../types/api";

type EditableFact = Record<string, unknown> & { id?: string };

const props = defineProps<{
  open: boolean;
  expectedSourceVersion?:number;
  reportId: string;
  type: ClinicalFactType;
  fact: EditableFact | null;
}>();
const emit = defineEmits<{ close: []; saved: [] }>();
const toast = useToast();
const saving = ref(false);
const error = ref("");
const form = reactive({
  sectionName: "",
  diagnosisType: "other",
  diagnosisText: "",
  diagnosisCode: "",
  codeSystem: "",
  isPrimary: false,
  context: "other",
  medicationName: "",
  genericName: "",
  specification: "",
  dosageForm: "",
  dose: "",
  doseUnit: "",
  frequency: "",
  route: "",
  duration: "",
  quantity: "",
  quantityUnit: "",
  instructions: "",
  procedureType: "other",
  procedureName: "",
  procedureCode: "",
  bodyPart: "",
  performedAt: "",
  resultText: "",
  vaccineName: "",
  doseNumber: "",
  manufacturer: "",
  lotNumber: "",
  administeredAt: "",
  administrationSite: "",
  nextDueAt: "",
  invoiceNumber: "",
  totalAmount: "",
  insuranceAmount: "",
  selfPayAmount: "",
  currency: "CNY",
  category: "",
  itemName: "",
  amount: ""
});

const titles: Record<ClinicalFactType, string> = {
  diagnosis: "诊断记录",
  medication: "用药记录",
  procedure: "诊疗与操作",
  vaccination: "疫苗接种",
  billingSummary: "费用汇总",
  billingItem: "费用明细"
};
const diagnosisTypeOptions = [
  { value: "outpatient", label: "门诊诊断" },
  { value: "admission", label: "入院诊断" },
  { value: "discharge", label: "出院诊断" },
  { value: "pathology", label: "病理诊断" },
  { value: "other", label: "其他诊断" }
];
const medicationContextOptions = [
  { value: "prescription", label: "处方用药" },
  { value: "outpatient", label: "门诊用药" },
  { value: "inpatient", label: "住院用药" },
  { value: "discharge", label: "出院用药" },
  { value: "other", label: "其他用药" }
];
const procedureTypeOptions = [
  { value: "examination", label: "检查" },
  { value: "treatment", label: "治疗" },
  { value: "surgery", label: "手术" },
  { value: "other", label: "其他操作" }
];

function inputDateTime(value: unknown) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return "";
  return text.replace(" ", "T").slice(0, 19);
}

function factText(key: string) {
  const value = props.fact?.[key];
  return value === null || value === undefined ? "" : String(value);
}

const formula=ref<MedicationFormula|null>(null);
function setFormula(enabled:boolean){
  formula.value=enabled?{kind:'decoction',doseCount:null,preparation:null,ingredients:[{name:'',amount:null,unit:null,amountBasis:'unspecified',totalAmount:null,totalUnit:null,instructions:null,evidence:[]}]}:null;
  if(enabled){form.medicationName ||= '中药汤剂';form.genericName='';form.specification='';form.dosageForm='汤剂';if(form.context==='other')form.context='prescription';}
}
const editVersion=ref<number>();
let generation=0;let alive=true;onBeforeUnmount(()=>{alive=false;generation++;});
const leave=useUnsavedRecord(()=>props.open?JSON.stringify([form,formula.value]):'',saving);
const submissionKey=createSubmissionKey();
async function close(){if(await leave.confirmLeave())emit('close');}
watch(() => [props.open, props.reportId, props.type, props.fact] as const, ([open]) => {
  generation++;saving.value=false;editVersion.value=props.expectedSourceVersion;if(!open){leave.reset();return;}
  formula.value=parseMedicationFormula(props.fact?.formula);
  Object.assign(form, {
    sectionName: factText("sectionName"),
    diagnosisType: factText("diagnosisType") || "other",
    diagnosisText: factText("diagnosisText"),
    diagnosisCode: factText("diagnosisCode"),
    codeSystem: factText("codeSystem"),
    isPrimary: Boolean(props.fact?.isPrimary),
    context: factText("context") || "other",
    medicationName: factText("medicationName"),
    genericName: factText("genericName"),
    specification: factText("specification"),
    dosageForm: factText("dosageForm"),
    dose: factText("dose"),
    doseUnit: factText("doseUnit"),
    frequency: factText("frequency"),
    route: factText("route"),
    duration: factText("duration"),
    quantity: factText("quantity"),
    quantityUnit: factText("quantityUnit"),
    instructions: factText("instructions"),
    procedureType: factText("procedureType") || "other",
    procedureName: factText("procedureName"),
    procedureCode: factText("procedureCode"),
    bodyPart: factText("bodyPart"),
    performedAt: inputDateTime(props.fact?.performedAt),
    resultText: factText("resultText"),
    vaccineName: factText("vaccineName"),
    doseNumber: factText("doseNumber"),
    manufacturer: factText("manufacturer"),
    lotNumber: factText("lotNumber"),
    administeredAt: inputDateTime(props.fact?.administeredAt),
    administrationSite: factText("administrationSite"),
    nextDueAt: inputDateTime(props.fact?.nextDueAt),
    invoiceNumber: factText("invoiceNumber"),
    totalAmount: factText("totalAmount"),
    insuranceAmount: factText("insuranceAmount"),
    selfPayAmount: factText("selfPayAmount"),
    currency: factText("currency") || "CNY",
    category: factText("category"),
    itemName: factText("itemName"),
    amount: factText("amount")
  });
  error.value = "";
  leave.reset();submissionKey.reset();
}, { immediate: true });

useScrollLock(computed(() => props.open));

function payload() {
  if (props.type === "diagnosis") {
    return {
      sectionName: form.sectionName, diagnosisType: form.diagnosisType,
      diagnosisText: form.diagnosisText, diagnosisCode: form.diagnosisCode,
      codeSystem: form.codeSystem, isPrimary: form.isPrimary
    };
  }
  if (props.type === "medication") {
    return {
      sectionName: form.sectionName, context: form.context, medicationName: form.medicationName,
      genericName: form.genericName, specification: form.specification, dosageForm: form.dosageForm,
      dose: form.dose, doseUnit: form.doseUnit, frequency: form.frequency, route: form.route,
      duration: form.duration, quantity: form.quantity, quantityUnit: form.quantityUnit,
      instructions: form.instructions, formula: formula.value
    };
  }
  if (props.type === "procedure") {
    return {
      sectionName: form.sectionName, procedureType: form.procedureType,
      procedureName: form.procedureName, procedureCode: form.procedureCode,
      bodyPart: form.bodyPart, performedAt: form.performedAt, resultText: form.resultText
    };
  }
  if (props.type === "vaccination") {
    return {
      vaccineName: form.vaccineName, doseNumber: form.doseNumber, manufacturer: form.manufacturer,
      lotNumber: form.lotNumber, administeredAt: form.administeredAt,
      administrationSite: form.administrationSite, nextDueAt: form.nextDueAt
    };
  }
  if (props.type === "billingSummary") {
    return {
      invoiceNumber: form.invoiceNumber, totalAmount: form.totalAmount,
      insuranceAmount: form.insuranceAmount, selfPayAmount: form.selfPayAmount,
      currency: form.currency
    };
  }
  return { category: form.category, itemName: form.itemName, amount: form.amount, quantity: form.quantity };
}

async function save() {
  if(saving.value||!props.open)return;const token=generation;
  saving.value = true;
  error.value = "";
  try {
    if (props.fact?.id) {
      await request(`clinical-facts/${props.type}/${encodeURIComponent(props.fact.id)}`, {
        method: "PUT",
        body: JSON.stringify({...payload(),expectedSourceVersion:editVersion.value})
      });
    } else {
      await request(`reports/${encodeURIComponent(props.reportId)}/clinical-facts`, {
        method: "POST",
        body: JSON.stringify({ type: props.type, ...payload(),expectedSourceVersion:editVersion.value,requestKey:submissionKey.forRequest(props.reportId,{type:props.type,...payload(),expectedSourceVersion:editVersion.value}) })
      });
    }
    if(!alive||token!==generation||!props.open)return;
    toast.show(`${titles[props.type]}已保存`);
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
    <div v-if="open" class="modal-backdrop clinical-fact-editor-backdrop" @click.self="close">
      <section class="modal-panel clinical-fact-editor" role="dialog" aria-modal="true" :aria-label="`校对${titles[type]}`">
        <header>
          <div><Pencil :size="19" /><span><strong>{{ fact?.id ? "校对" : "新增" }}{{ titles[type] }}</strong><small>人工结果在后续 AI 重跑时保持优先</small></span></div>
          <button class="plain-icon-button" type="button" title="关闭" @click="close"><X :size="18" /></button>
        </header>
        <form class="settings-form clinical-fact-editor-form" @submit.prevent="save">
          <div v-if="type === 'diagnosis'" class="form-grid">
            <label><span>诊断类型</span><FormSelect v-model="form.diagnosisType" :options="diagnosisTypeOptions" /></label>
            <label><span>报告章节</span><input v-model="form.sectionName" /></label>
            <label class="field-wide"><span>诊断内容</span><input v-model="form.diagnosisText" required /></label>
            <label><span>诊断编码</span><input v-model="form.diagnosisCode" /></label>
            <label><span>编码体系</span><input v-model="form.codeSystem" /></label>
            <label class="clinical-fact-check"><input v-model="form.isPrimary" type="checkbox" /><span>主要诊断</span></label>
          </div>
          <div v-else-if="type === 'medication'" class="form-grid">
            <label class="field-wide"><span>药单类型</span><select :value="formula?'decoction':'single'" :disabled="saving" @change="setFormula(($event.target as HTMLSelectElement).value==='decoction')"><option value="single">单个药品</option><option value="decoction">中药汤剂（整方）</option></select></label>
            <label v-if="!formula"><span>用药场景</span><FormSelect v-model="form.context" :options="medicationContextOptions" /></label>
            <label v-if="!formula"><span>报告章节</span><input v-model="form.sectionName" /></label>
            <label class="field-wide"><span>{{ formula ? '药方名称' : '药品名称' }}</span><input v-model="form.medicationName" required /></label>
            <MedicationFormulaPanel v-if="formula" v-model:formula="formula" class="field-wide" editable :disabled="saving" />
            <label v-if="!formula"><span>通用名</span><input v-model="form.genericName" /></label>
            <label v-if="!formula"><span>规格</span><input v-model="form.specification" /></label>
            <label v-if="!formula"><span>剂型</span><FormSuggest v-model="form.dosageForm" :options="medicationDosageFormOptions" label="剂型" name="dosageForm" placeholder="选择或填写" :disabled="saving" /></label>
            <label><span>{{ formula ? '整方每次服用量' : '每次剂量' }}</span><input v-model="form.dose" /></label>
            <MedicationUnitPicker v-model="form.doseUnit" label="剂量单位" name="doseUnit" :disabled="saving" />
            <label><span>频次</span><FormSuggest v-model="form.frequency" :options="medicationFrequencyOptions" label="用药频次" name="frequency" placeholder="选择或填写" :disabled="saving" /></label>
            <label><span>途径</span><FormSuggest v-model="form.route" :options="medicationRouteOptions" label="使用途径" name="route" placeholder="选择或填写" :disabled="saving" /></label>
            <label><span>疗程</span><input v-model="form.duration" /></label>
            <label><span>{{ formula ? '整方调剂数量' : '数量' }}</span><input v-model="form.quantity" /></label>
            <label><span>数量单位</span><FormSuggest v-model="form.quantityUnit" :options="medicationQuantityUnitOptions" label="数量单位" name="quantityUnit" placeholder="选择或填写" :disabled="saving" /></label>
            <label class="field-wide"><span>原文用法</span><textarea v-model="form.instructions" rows="3"></textarea></label>
          </div>
          <div v-else-if="type === 'procedure'" class="form-grid">
            <label><span>操作类型</span><FormSelect v-model="form.procedureType" :options="procedureTypeOptions" /></label>
            <label><span>报告章节</span><input v-model="form.sectionName" /></label>
            <label class="field-wide"><span>操作名称</span><input v-model="form.procedureName" required /></label>
            <label><span>操作编码</span><input v-model="form.procedureCode" /></label>
            <label><span>部位</span><input v-model="form.bodyPart" /></label>
            <label><span>执行时间</span><DateTimePicker v-model="form.performedAt" show-time aria-label="执行时间" /></label>
            <label class="field-wide"><span>结果原文</span><textarea v-model="form.resultText" rows="3"></textarea></label>
          </div>
          <div v-else-if="type === 'vaccination'" class="form-grid">
            <label class="field-wide"><span>疫苗名称</span><input v-model="form.vaccineName" required /></label>
            <label><span>剂次</span><input v-model="form.doseNumber" /></label>
            <label><span>厂家</span><input v-model="form.manufacturer" /></label>
            <label><span>批号</span><input v-model="form.lotNumber" /></label>
            <label><span>接种时间</span><DateTimePicker v-model="form.administeredAt" show-time aria-label="接种时间" /></label>
            <label><span>接种部位</span><input v-model="form.administrationSite" /></label>
            <label><span>下次接种时间</span><DateTimePicker v-model="form.nextDueAt" show-time aria-label="下次接种时间" /></label>
          </div>
          <div v-else-if="type === 'billingSummary'" class="form-grid">
            <label><span>票据号</span><input v-model="form.invoiceNumber" /></label>
            <label><span>币种</span><input v-model="form.currency" maxlength="8" /></label>
            <label><span>总额</span><input v-model="form.totalAmount" type="number" min="0" step="0.01" /></label>
            <label><span>医保支付</span><input v-model="form.insuranceAmount" type="number" min="0" step="0.01" /></label>
            <label><span>自费金额</span><input v-model="form.selfPayAmount" type="number" min="0" step="0.01" /></label>
          </div>
          <div v-else class="form-grid">
            <label><span>费用分类</span><input v-model="form.category" /></label>
            <label class="field-wide"><span>项目名称</span><input v-model="form.itemName" required /></label>
            <label><span>金额</span><input v-model="form.amount" type="number" min="0" step="0.01" /></label>
            <label><span>数量</span><input v-model="form.quantity" type="number" min="0" step="any" /></label>
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
