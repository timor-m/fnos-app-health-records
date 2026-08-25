<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { Bot, LoaderCircle, Save, TestTubeDiagonal, RefreshCw, CheckCircle, XCircle, AlertCircle } from "@lucide/vue";
import SubPageHeader from "../../components/SubPageHeader.vue";
import FormSelect from "../../components/FormSelect.vue";
import { request } from "../../utils/api";

type AiProviderKey = "deepseek" | "kimi" | "glm" | "qwen" | "openai" | "doubao" | "ollama";
type AiProviderOption = {
  key: AiProviderKey;
  label: string;
  defaultBaseUrl: string;
  defaultTextModel: string;
  defaultVisionModel: string;
  modelHint?: string;
  apiKeyRequired?: boolean;
};
type AiProviderSettings = {
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
  provider: AiProviderKey | "";
  model: string;
  inherited: boolean;
  implemented: boolean;
};
type AiSettings = AiProviderSettings & {
  enabled: boolean;
  provider: AiProviderKey;
  apiKey: string;
  providerSettings: Record<AiProviderKey, AiProviderSettings>;
  providers: AiProviderOption[];
  tasks: AiTaskOption[];
  taskBindings: Record<string, AiTaskBinding>;
};

const ai = ref<AiSettings>({
  enabled: false,
  provider: "deepseek",
  visionEnabled: false,
  baseUrl: "https://api.deepseek.com",
  textModel: "deepseek-v4-flash",
  visionModel: "",
  apiKey: "",
  apiKeyConfigured: false,
  apiKeyMasked: "",
  providerSettings: {} as Record<AiProviderKey, AiProviderSettings>,
  providers: [],
  tasks: [],
  taskBindings: {}
});
const message = ref("");
const loading = ref(true);
const loadError = ref("");
const saving = ref(false);
const testing = ref(false);
const currentProvider = computed(() => ai.value.providers.find((item) => item.key === ai.value.provider));

// 模型列表相关
const modelListLoading = ref(false);
const textModelList = ref<Array<{ id: string; name: string }>>([]);
const visionModelList = ref<Array<{ id: string; name: string }>>([]);
const showTextModelDropdown = ref(false);
const showVisionModelDropdown = ref(false);

// 增强测试相关
const enhancedTesting = ref(false);
const testSteps = ref<Array<{ name: string; status: string; message: string; elapsedMs?: number }>>([]);
const implementedTasks = computed(() => ai.value.tasks.filter((task) => task.implemented));
const visionModelHint = computed(() => {
  const model = ai.value.visionModel.trim().toLowerCase();
  if (!model) return "请填写视觉模型名称";
  if (ai.value.textModel.trim() && model === ai.value.textModel.trim().toLowerCase()) {
    return "视觉模型与文本模型相同，请确认该模型确实支持图片输入";
  }
  if (/(\b|[-_:])(vl|vision|visual|llava|moondream|internvl|minicpm[-_]?v|idefics|pixtral|qwen[\w.-]*vl|gemma[\w.-]*3)(\b|[-_:])/i.test(model)) {
    return "已识别为可能支持图片输入的模型，请继续测试确认";
  }
  if (/(embedding|rerank|bge[-_]|text[-_]?embedding|nomic[-_]embed|deepseek[-_]?r1|deepseek[-_]?v3|deepseek[-_]?v4|qwen[-_]?(turbo|plus|max)|kimi[-_]|glm[-_]|gpt[-_]?(3\.5|4\.1-mini)|llama[23](\.\d+)?$)/i.test(model)) {
    return "模型名称看起来更像文本模型，建议更换支持图片输入的模型并点击“测试视觉模型”验证";
  }
  return "无法仅根据模型名称确认视觉能力，请点击“测试视觉模型”验证";
});

// 获取模型列表
async function fetchModelList(type: "text" | "vision") {
  modelListLoading.value = true;
  try {
    // 构建查询参数
    const params = new URLSearchParams();
    params.set("provider", ai.value.provider);
    if (ai.value.apiKey.trim()) {
      params.set("apiKey", ai.value.apiKey.trim());
    }
    
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
    message.value = error instanceof Error ? error.message : "获取模型列表失败";
  } finally {
    modelListLoading.value = false;
  }
}

// 选择模型
function selectModel(type: "text" | "vision", modelId: string) {
  if (type === "text") {
    ai.value.textModel = modelId;
    showTextModelDropdown.value = false;
  } else {
    ai.value.visionModel = modelId;
    showVisionModelDropdown.value = false;
  }
}

// 增强版测试连接
async function testEnhanced() {
  enhancedTesting.value = true;
  testSteps.value = [];
  message.value = "";

  try {
    const result = await request<{
      provider: string;
      steps: Array<{ name: string; status: string; message: string; elapsedMs?: number }>;
      overallSuccess: boolean;
      totalElapsedMs: number;
    }>("ai/test-enhanced", {
      method: "POST",
      body: JSON.stringify(aiBody())
    });

    testSteps.value = result.steps;
    message.value = result.overallSuccess
      ? `全部测试通过，总耗时 ${result.totalElapsedMs} ms`
      : `部分测试失败，请查看详细结果`;
  } catch (error) {
    message.value = error instanceof Error ? error.message : "测试失败";
  } finally {
    enhancedTesting.value = false;
  }
}

function editableSettings(value: AiSettings) {
  return {
    ...value,
    taskBindings: Object.fromEntries(Object.entries(value.taskBindings || {}).map(([key, binding]) => [
      key,
      binding.inherited
        ? { ...binding, provider: "" as const, model: "" }
        : binding
    ]))
  };
}

function aiBody() {
  const taskBindings = Object.fromEntries(implementedTasks.value.map((task) => {
    const binding = ai.value.taskBindings[task.key];
    return [
      task.key,
      !binding?.provider
        ? null
        : { provider: binding.provider, ...(binding.model.trim() ? { model: binding.model.trim() } : {}) }
    ];
  }));
  return {
    enabled: ai.value.enabled,
    provider: ai.value.provider,
    visionEnabled: ai.value.visionEnabled,
    baseUrl: ai.value.baseUrl,
    textModel: ai.value.textModel,
    visionModel: ai.value.visionModel,
    taskBindings,
    ...(ai.value.apiKey.trim() ? { apiKey: ai.value.apiKey.trim() } : {})
  };
}
function changeProvider() {
  const provider = currentProvider.value;
  if (!provider) return;
  const saved = ai.value.providerSettings[provider.key];
  ai.value.visionEnabled = saved?.visionEnabled ?? false;
  ai.value.baseUrl = saved?.baseUrl || provider.defaultBaseUrl;
  ai.value.textModel = saved?.textModel || provider.defaultTextModel;
  ai.value.visionModel = saved?.visionModel || provider.defaultVisionModel;
  ai.value.apiKeyConfigured = Boolean(saved?.apiKeyConfigured);
  ai.value.apiKeyMasked = saved?.apiKeyMasked || "";
  ai.value.apiKey = "";
  message.value = saved?.apiKeyConfigured
    ? `已载入 ${provider.label} 保存的配置`
    : `${provider.label} 尚未配置 API Key`;
}
async function save() {
  saving.value = true; message.value = "";
  try {
    ai.value = editableSettings(await request<AiSettings>("ai/settings", {
      method: "PUT",
      body: JSON.stringify(aiBody())
    }));
    message.value = `${currentProvider.value?.label || "AI"} 配置已保存`;
  }
  catch (error) { message.value = error instanceof Error ? error.message : "保存失败"; }
  finally { saving.value = false; }
}
async function test() {
  testing.value = true; message.value = "";
  try {
    const result = await request<{ model: string; elapsedMs: number }>("ai/test", {
      method: "POST",
      body: JSON.stringify(aiBody())
    });
    message.value = `${result.model} 连接正常，耗时 ${result.elapsedMs} ms`;
  }
  catch (error) { message.value = error instanceof Error ? error.message : "连接失败"; }
  finally { testing.value = false; }
}
async function testVision() {
  testing.value = true; message.value = "";
  try {
    const result = await request<{ model: string; elapsedMs: number }>("ai/test", {
      method: "POST",
      body: JSON.stringify({ ...aiBody(), testVision: true })
    });
    message.value = `${result.model} 视觉模型可用，耗时 ${result.elapsedMs} ms`;
  }
  catch (error) { message.value = error instanceof Error ? error.message : "视觉模型测试失败"; }
  finally { testing.value = false; }
}
async function loadSettings() {
  loading.value = true;
  loadError.value = "";
  try {
    ai.value = editableSettings(await request<AiSettings>("ai/settings"));
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : "AI 配置加载失败";
  } finally {
    loading.value = false;
  }
}
onMounted(() => { void loadSettings(); });
</script>

<template>
  <section class="settings-page">
    <SubPageHeader title="AI 解析模型" description="原图仅在视觉增强开启后发送" />
    <section class="settings-band">
      <header><Bot :size="21" /><div><h3>模型配置</h3><p>使用兼容 Chat Completions 的服务</p></div></header>
      <div v-if="loading" class="loading-list"><span v-for="index in 3" :key="index"></span></div>
      <p v-else-if="loadError" class="inline-panel-error">
        {{ loadError }}<button class="error-retry" type="button" @click="loadSettings">重试</button>
      </p>
      <div v-else class="settings-form">
        <label class="toggle-row"><div><strong>启用 AI 整理</strong><span>识别后的文本由 AI 整理为结构化字段</span></div><input v-model="ai.enabled" class="switch" type="checkbox" /></label>
        <label><span>AI 服务商</span><FormSelect v-model="ai.provider" :options="ai.providers.map((provider) => ({ value: provider.key, label: provider.label }))" aria-label="AI 服务商" @change="changeProvider" /></label>
        <label class="toggle-row"><div><strong>视觉增强</strong><span>复杂表格可发送处理后的页面副本</span></div><input v-model="ai.visionEnabled" class="switch" type="checkbox" /></label>
        <label><span>API 地址</span><input v-model.trim="ai.baseUrl" :placeholder="currentProvider?.defaultBaseUrl || 'https://api.example.com/v1'" /></label>
        <div class="form-grid">
          <label>
            <span>文本模型</span>
            <div class="model-input-group">
              <input v-model.trim="ai.textModel" :placeholder="currentProvider?.defaultTextModel" />
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
            <small v-if="currentProvider?.modelHint" class="field-hint">{{ currentProvider.modelHint }}</small>
          </label>
          <label>
            <span>视觉模型</span>
            <div class="model-input-group">
              <input v-model.trim="ai.visionModel" :placeholder="currentProvider?.defaultVisionModel || '填写支持图片输入的模型'" />
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
        <label><span>API Key <small v-if="currentProvider?.apiKeyRequired === false">（可选）</small></span><input v-model="ai.apiKey" type="password" autocomplete="new-password" :placeholder="currentProvider?.apiKeyRequired === false ? 'Ollama 默认无需填写' : ai.apiKeyConfigured ? `已配置 ${ai.apiKeyMasked}` : '输入 API Key'" /></label>
        <section v-if="implementedTasks.length" class="ai-task-bindings">
          <header><strong>场景模型</strong><span>默认继承上方模型，也可为单个场景独立指定</span></header>
          <article v-for="task in implementedTasks" :key="task.key">
            <div><strong>{{ task.label }}</strong><span>{{ task.description }}</span></div>
            <FormSelect
              v-model="ai.taskBindings[task.key].provider"
              :options="[
                { value: '', label: '继承默认模型' },
                ...ai.providers.map((provider) => ({ value: provider.key, label: provider.label }))
              ]"
              :aria-label="`${task.label}服务商`"
            />
            <input
              v-if="ai.taskBindings[task.key].provider"
              v-model.trim="ai.taskBindings[task.key].model"
              placeholder="留空使用该服务商默认文本模型"
              :aria-label="`${task.label}模型`"
            />
          </article>
        </section>
        <p v-if="message" class="form-message">{{ message }}</p>
        
        <!-- 增强测试结果 -->
        <div v-if="testSteps.length" class="test-results">
          <div class="test-results-header">
            <strong>测试结果</strong>
          </div>
          <div v-for="(step, index) in testSteps" :key="index" class="test-step" :class="`test-step--${step.status}`">
            <div class="test-step-icon">
              <CheckCircle v-if="step.status === 'success'" :size="16" />
              <XCircle v-else-if="step.status === 'failed'" :size="16" />
              <AlertCircle v-else :size="16" />
            </div>
            <div class="test-step-content">
              <div class="test-step-name">{{ step.name }}</div>
              <div class="test-step-message">{{ step.message }}</div>
            </div>
            <div v-if="step.elapsedMs" class="test-step-time">{{ step.elapsedMs }}ms</div>
          </div>
        </div>

        <div class="form-actions">
          <button type="button" :disabled="saving || testing || enhancedTesting" @click="test">
            <LoaderCircle v-if="testing" class="spin-icon" :size="17" />
            <TestTubeDiagonal v-else :size="17" />
            {{ testing ? "正在测试" : "快速测试" }}
          </button>
          <button type="button" :disabled="saving || testing || enhancedTesting" @click="testEnhanced">
            <LoaderCircle v-if="enhancedTesting" class="spin-icon" :size="17" />
            <TestTubeDiagonal v-else :size="17" />
            {{ enhancedTesting ? "正在测试" : "完整测试" }}
          </button>
          <button class="primary-button" type="button" :disabled="saving || testing || enhancedTesting" @click="save">
            <LoaderCircle v-if="saving" class="spin-icon" :size="17" />
            <Save v-else :size="17" />
            {{ saving ? "正在保存" : "保存" }}
          </button>
        </div>
      </div>
    </section>
  </section>
</template>
