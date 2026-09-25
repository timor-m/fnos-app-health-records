<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { LoaderCircle, Pencil, X } from "@lucide/vue";
import FormSelect from "./FormSelect.vue";
import { useScrollLock } from "../composables/useScrollLock";
import { useToast } from "../composables/useToast";
import { request } from "../utils/api";

type EditableFinding = {
  id?: string;
  findingId?: string;
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

const props = defineProps<{ open: boolean; finding: EditableFinding | null }>();
const emit = defineEmits<{ close: []; saved: [] }>();
const toast = useToast();
const saving = ref(false);
const error = ref("");
const initialForm = ref<Record<string, string | number>>( {} );
const form = reactive({
  organ: "", region: "", laterality: "unspecified", findingType: "", findingName: "",
  presence: "present", findingCount: "", sizeLength: "", sizeWidth: "", sizeHeight: "",
  sizeUnit: "", morphology: "", classificationSystem: "", classificationValue: "",
  classificationText: ""
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

watch(() => [props.open, props.finding] as const, ([open, finding]) => {
  if (!open || !finding) return;
  Object.assign(form, {
    organ: finding.organ || "", region: finding.region || "", laterality: finding.laterality,
    findingType: finding.findingType || "", findingName: finding.findingName || "",
    presence: finding.presence, findingCount: finding.findingCount ?? "",
    sizeLength: finding.size.length ?? "", sizeWidth: finding.size.width ?? "",
    sizeHeight: finding.size.height ?? "", sizeUnit: finding.size.unit || "",
    morphology: finding.morphology || "", classificationSystem: finding.classification?.system || "",
    classificationValue: finding.classification?.value || "", classificationText: finding.classification?.text || ""
  });
  initialForm.value = { ...form };
  error.value = "";
}, { immediate: true });

useScrollLock(computed(() => props.open));

async function save() {
  const id = props.finding?.id || props.finding?.findingId;
  if (!id) return;
  saving.value = true;
  error.value = "";
  try {
    const body = Object.fromEntries(Object.entries(form).filter(([key, value]) => initialForm.value[key] !== value));
    if (!Object.keys(body).length) {
      emit("close");
      return;
    }
    await request(`morphology-findings/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify(body)
    });
    toast.show("形态校对已保存");
    emit("saved");
    emit("close");
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "保存失败";
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open && finding" class="modal-backdrop morphology-editor-backdrop" @click.self="emit('close')">
      <section class="modal-panel morphology-editor" role="dialog" aria-modal="true" aria-label="校对形态发现">
        <header>
          <div><Pencil :size="19" /><span><strong>校对形态发现</strong><small>人工内容在后续 AI 重跑时保持优先</small></span></div>
          <button class="plain-icon-button" type="button" title="关闭" @click="emit('close')"><X :size="18" /></button>
        </header>
        <form class="settings-form morphology-editor-form" @submit.prevent="save">
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
          <div class="morphology-editor-original"><span>原文备案</span><p>{{ finding.rawText || "原报告未提供原文证据" }}</p></div>
          <p v-if="error" class="inline-panel-error">{{ error }}</p>
          <footer class="form-actions morphology-editor-actions">
            <button type="button" @click="emit('close')">取消</button>
            <button class="primary-button" type="submit" :disabled="saving">
              <LoaderCircle v-if="saving" class="spin-icon" :size="16" />{{ saving ? "保存中" : "保存校对" }}
            </button>
          </footer>
        </form>
      </section>
    </div>
  </Teleport>
</template>
