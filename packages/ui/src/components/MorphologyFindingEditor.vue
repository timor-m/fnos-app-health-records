<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { LoaderCircle, Pencil, Plus, X } from "@lucide/vue";
import FormSelect from "./FormSelect.vue";
import { useScrollLock } from "../composables/useScrollLock";
import { useToast } from "../composables/useToast";
import type { ReportDetail } from "../types/api";
import { request } from "../utils/api";

type EditableFinding = {
  id?: string;
  findingId?: string;
  reportId?: string;
  organ: string | null;
  region: string | null;
  laterality: "left" | "right" | "bilateral" | "midline" | "unspecified";
  findingType: string;
  findingName: string;
  presence: "present" | "absent" | "uncertain";
  findingCount?: number | null;
  size: { length: number | null; width: number | null; height: number | null; unit: string | null };
  morphology: string | null;
  classification: { system: string | null; value: string | null; text: string | null } | null;
  rawText: string;
  manualFields?: string[];
};

const props = defineProps<{ open: boolean; finding: EditableFinding | null; memberId?: string; reportId?: string }>();
const creating = computed(() => !props.finding);
const emit = defineEmits<{ close: []; saved: [] }>();
const toast = useToast();
const saving = ref(false);
const error = ref("");
const sourceReportId = computed(() => props.reportId || props.finding?.reportId || "");
const sourceReport = ref<ReportDetail | null>(null);
const sourceLoading = ref(false);
const sourceError = ref("");
let sourceRequest = 0;
async function loadSource() {
  const seq = ++sourceRequest;
  sourceReport.value = null;
  sourceError.value = "";
  if (!sourceReportId.value) { sourceLoading.value = false; sourceError.value = "请从对应报告详情中补充形态记录"; return; }
  sourceLoading.value = true;
  try {
    const report = await request<ReportDetail>(`reports/${encodeURIComponent(sourceReportId.value)}?includeDuplicateCandidates=false`);
    if (seq !== sourceRequest || !props.open) return;
    if (props.memberId && report.memberId !== props.memberId) throw new Error("来源报告不属于当前成员");
    sourceReport.value = report;
    const current = report.morphologyFindings.find(item => item.id === (props.finding?.id || props.finding?.findingId));
    form.sourcePageNumber = String(current?.evidence[0]?.pageNumber || (creating.value ? report.pages[0]?.pageNumber : "") || "");
    initialForm.value.sourcePageNumber = form.sourcePageNumber;
  } catch (cause) {
    if (seq === sourceRequest) sourceError.value = cause instanceof Error ? cause.message : "来源报告加载失败";
  } finally { if (seq === sourceRequest) sourceLoading.value = false; }
}
const initialForm = ref<Record<string, string | number>>( {} );
const form = reactive({
  organ: "", region: "", laterality: "unspecified", findingType: "", findingName: "",
  presence: "present", findingCount: "", sizeLength: "", sizeWidth: "", sizeHeight: "",
  sizeUnit: "", morphology: "", classificationSystem: "", classificationValue: "",
  classificationText: "", rawText: "", sourcePageNumber: ""
});

const lateralityOptions = [
  { value: "unspecified", label: "未明确" }, { value: "left", label: "左侧" },
  { value: "right", label: "右侧" }, { value: "bilateral", label: "双侧" },
  { value: "midline", label: "正中" }
];
const presenceOptions = [
  { value: "present", label: "原报告有记录" },
  { value: "absent", label: "原报告未见" },
  { value: "uncertain", label: "待确认" }
];

watch(() => [props.open, props.finding, props.memberId, props.reportId] as const, ([open, finding]) => {
  ++sourceRequest;
  if (!open) return;
  Object.assign(form, {
    organ: finding?.organ || "", region: finding?.region || "", laterality: finding?.laterality || "unspecified",
    findingType: finding?.findingType || "", findingName: finding?.findingName || "",
    presence: finding?.presence || "present", findingCount: finding?.findingCount ?? "",
    sizeLength: finding?.size.length ?? "", sizeWidth: finding?.size.width ?? "",
    sizeHeight: finding?.size.height ?? "", sizeUnit: finding?.size.unit || "",
    morphology: finding?.morphology || "", classificationSystem: finding?.classification?.system || "",
    classificationValue: finding?.classification?.value || "", classificationText: finding?.classification?.text || "",
    rawText: finding?.rawText || "", sourcePageNumber: ""
  });
  initialForm.value = { ...form };
  error.value = ""; sourceError.value = "";
  void loadSource();
}, { immediate: true });

function close() { if (!saving.value) emit("close"); }

useScrollLock(computed(() => props.open));

async function save() {
  const id = props.finding?.id || props.finding?.findingId;
  if (saving.value || sourceLoading.value || (!creating.value && !id)) return;
  if (creating.value && (!sourceReport.value || sourceLoading.value)) return;
  const scope = sourceRequest;
  saving.value = true;
  error.value = "";
  try {
    const body = Object.fromEntries(Object.entries(form).filter(([key, value]) => creating.value || initialForm.value[key] !== value));
    if ("rawText" in body || "sourcePageNumber" in body) {
      body.rawText = form.rawText;
      body.sourcePageNumber = form.sourcePageNumber;
    }
    if (!Object.keys(body).length) {
      emit("close");
      return;
    }
    await request(creating.value ? `reports/${encodeURIComponent(sourceReportId.value)}/morphology-findings` : `morphology-findings/${encodeURIComponent(id!)}`, {
      method: creating.value ? "POST" : "PUT",
      body: JSON.stringify(body)
    });
    if (scope !== sourceRequest || !props.open) return;
    toast.show(creating.value ? "形态记录已补充" : "形态校对已保存");
    emit("saved");
    emit("close");
  } catch (cause) {
    if (scope === sourceRequest && props.open) error.value = cause instanceof Error ? cause.message : "保存失败";
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="modal-backdrop morphology-editor-backdrop" @click.self="close">
      <section class="modal-panel morphology-editor" role="dialog" aria-modal="true" :aria-label="creating ? '补充形态记录' : '校对形态发现'">
        <header>
          <div><Plus v-if="creating" :size="19" /><Pencil v-else :size="19" /><span><strong>{{ creating ? "补充形态记录" : "校对形态发现" }}</strong><small>人工内容在后续 AI 重跑时保持优先</small></span></div>
          <button class="plain-icon-button" type="button" title="关闭" :disabled="saving" @click="close"><X :size="18" /></button>
        </header>
        <form class="settings-form morphology-editor-form" @submit.prevent="save">
          <p v-if="sourceReport" class="muted-copy">来源：{{ sourceReport.title }}</p>
          <p v-if="sourceLoading" role="status">正在读取来源页…</p>
          <p v-if="sourceError" class="inline-panel-error" role="alert">{{ sourceError }} <button class="error-retry" type="button" @click="loadSource()">重试</button></p>
          <div class="form-grid">
            <label><span>器官/部位</span><input v-model="form.organ" required /></label>
            <label><span>具体区域</span><input v-model="form.region" placeholder="如左叶、上极" /></label>
            <label><span>侧别</span><FormSelect v-model="form.laterality" :options="lateralityOptions" /></label>
            <label><span>发现类型</span><input v-model="form.findingType" required /></label>
            <label class="field-wide"><span>发现名称</span><input v-model="form.findingName" required /></label>
            <label><span>原报告状态</span><FormSelect v-model="form.presence" :options="presenceOptions" /></label>
            <label><span>数量</span><input v-model="form.findingCount" type="number" min="0" /></label>
            <label><span>长</span><input v-model="form.sizeLength" type="number" min="0" step="any" /></label>
            <label><span>宽</span><input v-model="form.sizeWidth" type="number" min="0" step="any" /></label>
            <label><span>高</span><input v-model="form.sizeHeight" type="number" min="0" step="any" /></label>
            <label><span>尺寸单位</span><input v-model="form.sizeUnit" placeholder="mm / cm" /></label>
            <label><span>分级体系</span><input v-model="form.classificationSystem" placeholder="如 BI-RADS" /></label>
            <label><span>分级值</span><input v-model="form.classificationValue" /></label>
            <label class="field-wide"><span>分级原文</span><input v-model="form.classificationText" /></label>
            <label class="field-wide"><span>关键形态描述</span><textarea v-model="form.morphology" rows="3"></textarea></label>
          </div>
          <div class="form-grid morphology-editor-original">
            <label class="field-wide"><span>来源页</span><FormSelect v-model="form.sourcePageNumber" :options="(sourceReport?.pages || []).map(page => ({ value: String(page.pageNumber), label: `第 ${page.pageNumber} 页` }))" placeholder="选择原文所在页" aria-label="来源页" :disabled="sourceLoading || !sourceReport" /></label>
            <label class="field-wide"><span>原文</span><textarea v-model="form.rawText" :required="creating" maxlength="3000" rows="3" placeholder="填写来源页中对应的原文" aria-label="形态原文"></textarea></label>
          </div>
          <p v-if="error" class="inline-panel-error">{{ error }}</p>
          <footer class="form-actions morphology-editor-actions">
            <button type="button" :disabled="saving" @click="close">取消</button>
            <button class="primary-button" type="submit" :disabled="saving || sourceLoading || (creating && (!sourceReport || !form.sourcePageNumber || !form.rawText.trim()))">
              <LoaderCircle v-if="saving" class="spin-icon" :size="16" />{{ saving ? "保存中" : creating ? "保存记录" : "保存校对" }}
            </button>
          </footer>
        </form>
      </section>
    </div>
  </Teleport>
</template>
