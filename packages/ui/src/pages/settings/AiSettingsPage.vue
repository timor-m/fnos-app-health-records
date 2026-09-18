<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import {
  AlertCircle,
  Bot,
  CheckCircle,
  LoaderCircle,
  Pencil,
  Plug,
  Plus,
  RefreshCw,
  Save,
  TestTubeDiagonal,
  Trash2,
  X,
  XCircle
} from "@lucide/vue";
import SubPageHeader from "../../components/SubPageHeader.vue";
import FormSelect from "../../components/FormSelect.vue";
import { isMiniMaxM2Model } from "../../../../server/services/ai-provider";
import { aiVisionModelHint } from "../../utils/ai-vision-model-hint";
import { useConfirm } from "../../composables/useConfirm";
import { useToast } from "../../composables/useToast";
import { request } from "../../utils/api";

type AiProviderKey = "deepseek" | "kimi" | "glm" | "qwen" | "openai" | "doubao" | "minimax" | "ollama" | "custom";
type AiProviderOption = {
  key: AiProviderKey;
  label: string;
  defaultBaseUrl: string;
  defaultTextModel: string;
  defaultVisionModel: string;
  modelHint?: string;
  apiKeyRequired?: boolean;
};
type AiProfile = {
  id: string;
  name: string;
  provider: AiProviderKey;
  providerLabel: string;
  visionEnabled: boolean;
  baseUrl: string;
  textModel: string;
  visionModel: string;
  apiKeyConfigured: boolean;
  apiKeyMasked: string;
};
type AiTaskOption = {
  key: string;
  label: string;
  description: string;
  implemented: boolean;
};
type AiTaskBinding = {
  profileId: string;
  model: string;
  inherited: boolean;
  implemented: boolean;
};
type AiSettings = {
  enabled: boolean;
  requestTimeoutSeconds: number;
  extractionDepth: "overview" | "detailed";
  defaultProfileId: string;
  profiles: AiProfile[];
  providers: AiProviderOption[];
  tasks: AiTaskOption[];
  taskBindings: Record<string, AiTaskBinding>;
};

const ai = ref<AiSettings>({
  enabled: false,
  requestTimeoutSeconds: 600,
  extractionDepth: "overview",
  defaultProfileId: "",
  profiles: [],
  providers: [],
  tasks: [],
  taskBindings: {}
});
const message = ref("");
const toast = useToast();
const confirmDialog = useConfirm();
const loading = ref(true);
const loadError = ref("");
const saving = ref(false);

// 编辑器里输入但尚未保存的 Key，以及明确要求清除的 Key
const apiKeyDrafts = ref<Record<string, string>>({});
const clearKeyFlags = ref<Record<string, boolean>>({});
// 已在服务端保存过的配置 id，用于测试连接时复用已存 Key
const persistedIds = ref<Set<string>>(new Set());

const implementedTasks = computed(() => ai.value.tasks.filter((task) => task.implemented));
const defaultProfile = computed(() => ai.value.profiles.find((profile) => profile.id === ai.value.defaultProfileId) || null);

function hostOf(baseUrl: string) {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl || "未填写地址";
  }
}

/* ---------- 连接配置编辑器 ---------- */
const editorOpen = ref(false);
const editorId = ref("");
const editorMessage = ref("");
const testing = ref(false);
const editor = ref({
  name: "",
  provider: "deepseek" as AiProviderKey,
  baseUrl: "",
  textModel: "",
  visionModel: "",
  visionEnabled: false,
  apiKey: "",
  apiKeyConfigured: false,
  apiKeyMasked: ""
});
const currentEditorProvider = computed(() =>
  ai.value.providers.find((provider) => provider.key === editor.value.provider) || null
);
const supportsVision = computed(() => !isMiniMaxM2Model(editor.value.visionModel));
watch(supportsVision, (supported) => {
  if (!supported) editor.value.visionEnabled = false;
});

const modelListLoading = ref(false);
const textModelList = ref<Array<{ id: string; name: string }>>([]);
const visionModelList = ref<Array<{ id: string; name: string }>>([]);
const showTextModelDropdown = ref(false);
const showVisionModelDropdown = ref(false);

const enhancedTesting = ref(false);
const testSteps = ref<Array<{ name: string; status: string; message: string; elapsedMs?: number }>>([]);

const visionModelHint = computed(() =>
  aiVisionModelHint(editor.value.provider, editor.value.textModel, editor.value.visionModel)
);

function newProfileId() {
  let id = "";
  do {
    id = `pf_${Math.random().toString(16).slice(2, 10)}`;
  } while (ai.value.profiles.some((profile) => profile.id === id));
  return id;
}

function openEditor(profile?: AiProfile) {
  testSteps.value = [];
  editorMessage.value = "";
  showTextModelDropdown.value = false;
  showVisionModelDropdown.value = false;
  if (profile) {
    editorId.value = profile.id;
    editor.value = {
      name: profile.name,
      provider: profile.provider,
      baseUrl: profile.baseUrl,
      textModel: profile.textModel,
      visionModel: profile.visionModel,
      visionEnabled: profile.visionEnabled,
      apiKey: apiKeyDrafts.value[profile.id] || "",
      apiKeyConfigured: profile.apiKeyConfigured,
      apiKeyMasked: profile.apiKeyMasked
    };
  } else {
    editorId.value = newProfileId();
    const preset = ai.value.providers.find((provider) => provider.key === "deepseek") || ai.value.providers[0];
    editor.value = {
      name: "",
      provider: preset?.key || "deepseek",
      baseUrl: preset?.defaultBaseUrl || "",
      textModel: preset?.defaultTextModel || "",
      visionModel: preset?.defaultVisionModel || "",
      visionEnabled: false,
      apiKey: "",
      apiKeyConfigured: false,
      apiKeyMasked: ""
    };
  }
  editorOpen.value = true;
}

function closeEditor() {
  editorOpen.value = false;
}

function changeEditorProvider() {
  const preset = currentEditorProvider.value;
  if (!preset) return;
  editor.value.baseUrl = preset.defaultBaseUrl;
  editor.value.textModel = preset.defaultTextModel;
  editor.value.visionModel = preset.defaultVisionModel;
  testSteps.value = [];
}

function clearSavedKey() {
  clearKeyFlags.value[editorId.value] = true;
  delete apiKeyDrafts.value[editorId.value];
  editor.value.apiKey = "";
  editor.value.apiKeyConfigured = false;
  editor.value.apiKeyMasked = "";
}

function maskLocal(apiKey: string) {
  if (apiKey.length <= 8) return "••••••••";
  return `${apiKey.slice(0, 3)}••••${apiKey.slice(-4)}`;
}

function applyEditor() {
  editorMessage.value = "";
  if (!editor.value.baseUrl.trim()) {
    editorMessage.value = "请填写 API 地址";
    return;
  }
  const label = currentEditorProvider.value?.label || "自定义";
  const typedKey = editor.value.apiKey.trim();
  if (typedKey) delete clearKeyFlags.value[editorId.value];
  const cleared = clearKeyFlags.value[editorId.value] === true && !typedKey;
  const profile: AiProfile = {
    id: editorId.value,
    name: editor.value.name.trim() || label,
    provider: editor.value.provider,
    providerLabel: label,
    visionEnabled: editor.value.visionEnabled,
    baseUrl: editor.value.baseUrl.trim(),
    textModel: editor.value.textModel.trim(),
    visionModel: editor.value.visionModel.trim(),
    apiKeyConfigured: cleared ? false : editor.value.apiKeyConfigured || Boolean(typedKey),
    apiKeyMasked: cleared ? "" : typedKey ? maskLocal(typedKey) : editor.value.apiKeyMasked
  };
  const index = ai.value.profiles.findIndex((item) => item.id === profile.id);
  if (index >= 0) ai.value.profiles.splice(index, 1, profile);
  else ai.value.profiles.push(profile);
  if (typedKey) apiKeyDrafts.value[profile.id] = typedKey;
  if (!ai.value.defaultProfileId) ai.value.defaultProfileId = profile.id;
  editorOpen.value = false;
  message.value = "连接配置已更新，点击“保存配置”后生效";
}

function removeProfile(profile: AiProfile) {
  if (profile.id === ai.value.defaultProfileId) {
    toast.show("请先把默认连接切换到其他配置，再删除这一项", 2600);
    return;
  }
  confirmDialog.ask({
    title: "删除连接配置",
    message: `确认删除「${profile.name}」？保存配置后该连接的地址、Key 和模型绑定将一并移除。`,
    confirmText: "删除",
    danger: true,
    run: () => {
      ai.value.profiles = ai.value.profiles.filter((item) => item.id !== profile.id);
      for (const binding of Object.values(ai.value.taskBindings)) {
        if (binding.profileId === profile.id) {
          binding.profileId = "";
          binding.model = "";
          binding.inherited = true;
        }
      }
      delete apiKeyDrafts.value[profile.id];
      delete clearKeyFlags.value[profile.id];
      persistedIds.value.delete(profile.id);
      message.value = "连接配置已移除，点击“保存配置”后生效";
    }
  });
}

/* ---------- 编辑器内的连接测试 ---------- */
function editorBody() {
  return {
    ...(persistedIds.value.has(editorId.value) ? { profileId: editorId.value } : {}),
    provider: editor.value.provider,
    baseUrl: editor.value.baseUrl,
    textModel: editor.value.textModel,
    visionModel: editor.value.visionModel,
    visionEnabled: editor.value.visionEnabled,
    ...(editor.value.apiKey.trim() ? { apiKey: editor.value.apiKey.trim() } : {})
  };
}

async function fetchModelList(type: "text" | "vision") {
  modelListLoading.value = true;
  try {
    const params = new URLSearchParams();
    params.set("provider", editor.value.provider);
    params.set("baseUrl", editor.value.baseUrl);
    if (editor.value.apiKey.trim()) params.set("apiKey", editor.value.apiKey.trim());
    if (persistedIds.value.has(editorId.value)) params.set("profileId", editorId.value);
    const result = await request<{ models: Array<{ id: string; name: string }>; total: number }>(`ai/models?${params.toString()}`, {
      method: "GET"
    });
    if (type === "text") {
      textModelList.value = result.models;
      showTextModelDropdown.value = true;
    } else {
      visionModelList.value = result.models;
      showVisionModelDropdown.value = true;
    }
  } catch (error) {
    editorMessage.value = error instanceof Error ? error.message : "获取模型列表失败";
  } finally {
    modelListLoading.value = false;
  }
}

function selectModel(type: "text" | "vision", modelId: string) {
  if (type === "text") {
    editor.value.textModel = modelId;
    showTextModelDropdown.value = false;
  } else {
    editor.value.visionModel = modelId;
    showVisionModelDropdown.value = false;
  }
}

async function test() {
  testing.value = true; editorMessage.value = "";
  try {
    const result = await request<{ model: string; elapsedMs: number }>("ai/test", {
      method: "POST",
      body: JSON.stringify(editorBody())
    });
    editorMessage.value = `${result.model} 连接正常，耗时 ${result.elapsedMs} ms`;
  }
  catch (error) { editorMessage.value = error instanceof Error ? error.message : "连接失败"; }
  finally { testing.value = false; }
}

async function testVision() {
  testing.value = true; editorMessage.value = "";
  try {
    const result = await request<{ model: string; elapsedMs: number }>("ai/test", {
      method: "POST",
      body: JSON.stringify({ ...editorBody(), testVision: true })
    });
    editorMessage.value = `${result.model} 视觉模型可用，耗时 ${result.elapsedMs} ms`;
  }
  catch (error) { editorMessage.value = error instanceof Error ? error.message : "视觉模型测试失败"; }
  finally { testing.value = false; }
}

async function testEnhanced() {
  enhancedTesting.value = true;
  testSteps.value = [];
  editorMessage.value = "";
  try {
    const result = await request<{
      provider: string;
      steps: Array<{ name: string; status: string; message: string; elapsedMs?: number }>;
      overallSuccess: boolean;
      totalElapsedMs: number;
    }>("ai/test-enhanced", {
      method: "POST",
      body: JSON.stringify(editorBody())
    });
    testSteps.value = result.steps;
    editorMessage.value = result.overallSuccess
      ? `全部测试通过，总耗时 ${result.totalElapsedMs} ms`
      : `部分测试失败，请查看详细结果`;
  } catch (error) {
    editorMessage.value = error instanceof Error ? error.message : "测试失败";
  } finally {
    enhancedTesting.value = false;
  }
}

/* ---------- 载入与保存 ---------- */
function editableSettings(value: AiSettings): AiSettings {
  return {
    ...value,
    taskBindings: Object.fromEntries(Object.entries(value.taskBindings || {}).map(([key, binding]) => [
      key,
      binding.inherited ? { ...binding, profileId: "", model: "" } : binding
    ]))
  };
}

function applyLoadedSettings(value: AiSettings) {
  ai.value = editableSettings(value);
  persistedIds.value = new Set(value.profiles.map((profile) => profile.id));
  apiKeyDrafts.value = {};
  clearKeyFlags.value = {};
}

async function save() {
  saving.value = true; message.value = "";
  try {
    const taskBindings = Object.fromEntries(implementedTasks.value.map((task) => {
      const binding = ai.value.taskBindings[task.key];
      return [
        task.key,
        binding?.profileId
          ? { profileId: binding.profileId, ...(binding.model.trim() ? { model: binding.model.trim() } : {}) }
          : null
      ];
    }));
    const body = {
      enabled: ai.value.enabled,
      requestTimeoutSeconds: ai.value.requestTimeoutSeconds,
      extractionDepth: ai.value.extractionDepth,
      defaultProfileId: ai.value.defaultProfileId,
      profiles: ai.value.profiles.map((profile) => ({
        id: profile.id,
        name: profile.name,
        provider: profile.provider,
        visionEnabled: profile.visionEnabled,
        baseUrl: profile.baseUrl,
        textModel: profile.textModel,
        visionModel: profile.visionModel,
        ...(apiKeyDrafts.value[profile.id]?.trim() ? { apiKey: apiKeyDrafts.value[profile.id].trim() } : {}),
        ...(clearKeyFlags.value[profile.id] && !apiKeyDrafts.value[profile.id]?.trim() ? { clearApiKey: true } : {})
      })),
      taskBindings
    };
    applyLoadedSettings(await request<AiSettings>("ai/settings", {
      method: "PUT",
      body: JSON.stringify(body)
    }));
    message.value = "AI 配置已保存";
  }
  catch (error) { message.value = error instanceof Error ? error.message : "保存失败"; }
  finally { saving.value = false; }
}

async function loadSettings() {
  loading.value = true;
  loadError.value = "";
  try {
    applyLoadedSettings(await request<AiSettings>("ai/settings"));
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : "AI 配置加载失败";
  } finally {
    loading.value = false;
  }
}

// 点击外部关闭模型下拉框
const handleClickOutside = (event: MouseEvent) => {
  const target = event.target as HTMLElement;
  if (!target.closest(".model-input-group")) {
    showTextModelDropdown.value = false;
    showVisionModelDropdown.value = false;
  }
};

onMounted(() => {
  void loadSettings();
  document.addEventListener("click", handleClickOutside);
});

onUnmounted(() => {
  document.removeEventListener("click", handleClickOutside);
});
</script>

<template>
  <section class="settings-page">
    <SubPageHeader title="AI 解析模型" description="原图仅在视觉增强开启后发送" />
    <div v-if="loading" class="settings-band"><div class="loading-list"><span v-for="index in 3" :key="index"></span></div></div>
    <p v-else-if="loadError" class="settings-band inline-panel-error">
      {{ loadError }}<button class="error-retry" type="button" @click="loadSettings">重试</button>
    </p>
    <template v-else>
      <section class="settings-band">
        <header><Plug :size="21" /><div><h3>连接配置</h3><p>每份配置包含地址、Key 和模型，可添加任意多份</p></div></header>
        <div v-if="ai.profiles.length" class="ai-profile-list">
          <article v-for="profile in ai.profiles" :key="profile.id" class="ai-profile-row">
            <div class="ai-profile-summary">
              <strong>{{ profile.name }}<em v-if="profile.id === ai.defaultProfileId" class="ai-profile-badge">默认</em></strong>
              <span>{{ profile.providerLabel }} · {{ hostOf(profile.baseUrl) }} · {{ profile.textModel || "未设置模型" }}</span>
            </div>
            <span v-if="profile.visionEnabled" class="ai-profile-badge vision">视觉</span>
            <div class="ai-profile-actions">
              <button type="button" title="编辑" aria-label="编辑连接配置" @click="openEditor(profile)"><Pencil :size="16" /></button>
              <button type="button" class="danger-action" title="删除" aria-label="删除连接配置" @click="removeProfile(profile)"><Trash2 :size="16" /></button>
            </div>
          </article>
        </div>
        <p v-else class="ai-profile-empty">尚未添加连接配置，添加后即可启用 AI 整理</p>
        <div class="ai-profile-add">
          <button type="button" class="soft-action-button" @click="openEditor()"><Plus :size="16" />添加连接配置</button>
        </div>
      </section>

      <section class="settings-band">
        <header><Bot :size="21" /><div><h3>模型配置</h3><p>使用兼容 Chat Completions 的服务</p></div></header>
        <div class="settings-form">
          <label class="toggle-row"><div><strong>启用 AI 整理</strong><span>识别后的文本由 AI 整理为结构化字段</span></div><input v-model="ai.enabled" class="switch" type="checkbox" /></label>
          <label>
            <span>默认连接</span>
            <FormSelect
              v-model="ai.defaultProfileId"
              :options="ai.profiles.map((profile) => ({ value: profile.id, label: profile.name }))"
              placeholder="请先添加连接配置"
              aria-label="默认连接"
            />
            <small class="field-hint">未单独指定场景的解析任务使用此连接{{ defaultProfile ? `（${defaultProfile.providerLabel} · ${defaultProfile.textModel || "未设置模型"}）` : "" }}</small>
          </label>
          <label>
            <span>单次请求超时（秒）</span>
            <input v-model.number="ai.requestTimeoutSeconds" type="number" min="30" max="3600" step="30" inputmode="numeric" />
            <small class="field-hint">每个报告解析单元最多等待 30～3600 秒，本地大模型建议保留默认 600 秒或适当提高</small>
          </label>
          <label>
            <span>AI 解析程度</span>
            <FormSelect v-model="ai.extractionDepth" :options="[
              { value: 'overview', label: '概览（默认，更省 Token）' },
              { value: 'detailed', label: '详细（含叙事章节与遗漏复核）' }
            ]" aria-label="AI 解析程度" />
            <small class="field-hint">概览模式仍逐项提取指标和形态发现并保留证据校验，但合并解析单元、跳过叙事章节和遗漏复核，Token 消耗更低；对新上传和重新整理的报告生效</small>
          </label>
          <section v-if="implementedTasks.length" class="ai-task-bindings">
            <header><strong>场景模型</strong><span>默认继承上方默认连接，也可为单个场景指定其他连接</span></header>
            <article v-for="task in implementedTasks" :key="task.key">
              <div><strong>{{ task.label }}</strong><span>{{ task.description }}</span></div>
              <FormSelect
                v-model="ai.taskBindings[task.key].profileId"
                :options="[
                  { value: '', label: '继承默认连接' },
                  ...ai.profiles.map((profile) => ({ value: profile.id, label: profile.name }))
                ]"
                :aria-label="`${task.label}连接`"
              />
              <input
                v-if="ai.taskBindings[task.key].profileId"
                v-model.trim="ai.taskBindings[task.key].model"
                placeholder="留空使用该配置的文本模型"
                :aria-label="`${task.label}模型`"
              />
            </article>
          </section>
          <p v-if="message" class="form-message">{{ message }}</p>
          <div class="form-actions">
            <button class="primary-button" type="button" :disabled="saving" @click="save">
              <LoaderCircle v-if="saving" class="spin-icon" :size="17" />
              <Save v-else :size="17" />
              {{ saving ? "保存中" : "保存配置" }}
            </button>
          </div>
        </div>
      </section>
    </template>

    <Teleport to="body">
      <div v-if="editorOpen" class="modal-backdrop ai-profile-editor-backdrop" @click.self="closeEditor">
        <section class="modal-panel ai-profile-editor" role="dialog" aria-modal="true" :aria-label="persistedIds.has(editorId) ? '编辑连接配置' : '添加连接配置'">
          <span class="sheet-grabber" aria-hidden="true"></span>
          <header>
            <div><Plug :size="20" /><h3>{{ persistedIds.has(editorId) ? "编辑连接配置" : "添加连接配置" }}</h3></div>
            <button type="button" title="关闭" @click="closeEditor"><X :size="19" /></button>
          </header>
          <div class="ai-profile-editor-form settings-form">
            <label>
              <span>服务商预设</span>
              <FormSelect
                v-model="editor.provider"
                :options="ai.providers.map((provider) => ({ value: provider.key, label: provider.label }))"
                aria-label="服务商预设"
                @change="changeEditorProvider"
              />
              <small v-if="currentEditorProvider?.modelHint" class="field-hint">{{ currentEditorProvider.modelHint }}</small>
            </label>
            <label><span>配置名称</span><input v-model.trim="editor.name" maxlength="30" :placeholder="currentEditorProvider?.label || '自定义连接'" /></label>
            <label><span>API 地址</span><input v-model.trim="editor.baseUrl" :placeholder="currentEditorProvider?.defaultBaseUrl || 'https://api.example.com/v1'" /></label>
            <label>
              <span>API Key <small v-if="currentEditorProvider?.apiKeyRequired === false">（可选）</small></span>
              <input
                v-model="editor.apiKey"
                type="password"
                autocomplete="new-password"
                :placeholder="currentEditorProvider?.apiKeyRequired === false ? 'Ollama 默认无需填写' : editor.apiKeyConfigured ? `已配置 ${editor.apiKeyMasked}` : '输入 API Key'"
              />
              <small v-if="editor.apiKeyConfigured" class="field-hint">
                已保存 {{ editor.apiKeyMasked }}，留空保持不变；<button type="button" class="ai-clear-key" @click="clearSavedKey">清除已保存的 Key</button>
              </small>
            </label>
            <div class="form-grid ai-model-grid">
              <label>
                <span>文本模型</span>
                <div class="model-input-group">
                  <input v-model.trim="editor.textModel" :placeholder="currentEditorProvider?.defaultTextModel" />
                  <button type="button" class="model-refresh-btn" :disabled="modelListLoading" @click="fetchModelList('text')" title="获取模型列表">
                    <LoaderCircle v-if="modelListLoading" class="spin-icon" :size="14" />
                    <RefreshCw v-else :size="14" />
                  </button>
                  <div v-if="showTextModelDropdown && textModelList.length" class="model-dropdown">
                    <div class="model-dropdown-header">
                      <span>可用模型 ({{ textModelList.length }})</span>
                      <button type="button" @click="showTextModelDropdown = false">×</button>
                    </div>
                    <div class="model-dropdown-list">
                      <div v-for="model in textModelList" :key="model.id" class="model-dropdown-item" @click="selectModel('text', model.id)">
                        <span class="model-id">{{ model.id }}</span>
                        <span v-if="model.name !== model.id" class="model-name">{{ model.name }}</span>
                      </div>
                    </div>
                  </div>
                </div>
              </label>
              <label>
                <span>视觉模型</span>
                <div class="model-input-group">
                  <input v-model.trim="editor.visionModel" :placeholder="currentEditorProvider?.defaultVisionModel || '填写支持图片输入的模型'" />
                  <button type="button" class="model-refresh-btn" :disabled="modelListLoading" @click="fetchModelList('vision')" title="获取模型列表">
                    <LoaderCircle v-if="modelListLoading" class="spin-icon" :size="14" />
                    <RefreshCw v-else :size="14" />
                  </button>
                  <div v-if="showVisionModelDropdown && visionModelList.length" class="model-dropdown">
                    <div class="model-dropdown-header">
                      <span>可用模型 ({{ visionModelList.length }})</span>
                      <button type="button" @click="showVisionModelDropdown = false">×</button>
                    </div>
                    <div class="model-dropdown-list">
                      <div v-for="model in visionModelList" :key="model.id" class="model-dropdown-item" @click="selectModel('vision', model.id)">
                        <span class="model-id">{{ model.id }}</span>
                        <span v-if="model.name !== model.id" class="model-name">{{ model.name }}</span>
                      </div>
                    </div>
                  </div>
                </div>
              </label>
              <small class="field-hint vision-hint-grid" :class="{ 'field-warning': !visionModelHint.includes('可能支持') }">{{ visionModelHint }}</small>
            </div>
            <label class="toggle-row">
              <div><strong>视觉增强</strong><span>{{ supportsVision ? "文本整理后仍有疑似遗漏指标时，发送对应页面原图给视觉模型复核补漏" : "MiniMax M2 系列当前仅支持文本整理" }}</span></div>
              <input v-model="editor.visionEnabled" class="switch" type="checkbox" :disabled="!supportsVision" />
            </label>
            <template v-if="supportsVision && editor.visionEnabled">
              <small class="field-hint field-warning">隐私提示：复核会把疑似遗漏页面的原图直接发送给该配置的服务商。图片无法像文本一样自动脱敏，可能包含姓名、证件号等身份信息，请先确认服务商的隐私政策可接受。</small>
              <small class="field-hint">费用说明：视觉模型按图片计费，单价高于纯文本。仅在"详细"解析程度下、文本整理后仍有疑似遗漏时触发，单份报告最多复核 3 页。</small>
            </template>
          </div>

          <div v-if="testSteps.length" class="test-results ai-editor-tests">
            <div class="test-results-header"><strong>测试结果</strong></div>
            <div v-for="(step, index) in testSteps" :key="index" class="test-step" :class="`test-step--${step.status}`">
              <div class="test-step-icon">
                <CheckCircle v-if="step.status === 'success'" :size="16" />
                <XCircle v-else-if="step.status === 'failed'" :size="16" />
                <AlertCircle v-else :size="16" />
              </div>
              <div class="test-step-content">
                <strong class="test-step-name">{{ step.name }}</strong>
                <span class="test-step-message">{{ step.message }}</span>
                <small v-if="step.elapsedMs !== undefined" class="test-step-time">{{ step.elapsedMs }} ms</small>
              </div>
            </div>
          </div>
          <p v-if="editorMessage" class="form-message ai-editor-message">{{ editorMessage }}</p>

          <footer class="ai-editor-footer">
            <button type="button" class="soft-action-button" :disabled="testing" @click="test">
              <LoaderCircle v-if="testing" class="spin-icon" :size="15" />
              <TestTubeDiagonal v-else :size="15" />
              快速测试
            </button>
            <button type="button" class="soft-action-button" :disabled="enhancedTesting" @click="testEnhanced">
              <LoaderCircle v-if="enhancedTesting" class="spin-icon" :size="15" />
              <TestTubeDiagonal v-else :size="15" />
              完整测试
            </button>
            <button v-if="supportsVision && editor.visionModel.trim()" type="button" class="soft-action-button" :disabled="testing" @click="testVision">测试视觉</button>
            <span class="spacer"></span>
            <button type="button" @click="closeEditor">取消</button>
            <button type="button" class="primary-button" @click="applyEditor">确定</button>
          </footer>
        </section>
      </div>
    </Teleport>
  </section>
</template>
