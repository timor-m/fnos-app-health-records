<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import {
  Bot,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Cpu,
  ExternalLink,
  KeyRound,
  LoaderCircle,
  PartyPopper,
  ScanText,
  X
} from "@lucide/vue";
import { request } from "../utils/api";
import { useScrollLock } from "../composables/useScrollLock";

type SetupGuideStatus = {
  ocrInstalled: boolean;
  ocrInstalling: boolean;
  aiConfigured: boolean;
  guideDismissed: boolean;
};
type OcrStatus = {
  available: boolean;
  installing: boolean;
  lastInstall?: { state?: string; error?: string; logTail?: string[] };
};
type AiProviderOption = { key: string; label: string; defaultBaseUrl: string; defaultTextModel: string };
type AiSettingsView = { providers: AiProviderOption[] };

const emit = defineEmits<{ done: [] }>();
const router = useRouter();
useScrollLock(computed(() => true));

type Step = "welcome" | "ocr" | "ai" | "done";
const step = ref<Step>("welcome");
const leadText = computed(() => ({
  welcome: "上传的体检报告需要两步准备工作才能自动识别成健康数据，全程大约 5 分钟，只需配置一次。",
  ocr: "OCR 负责把报告图片和 PDF 转成文字，安装在本机运行，可能需要几分钟下载组件。",
  ai: "推荐使用 DeepSeek：注册即可使用，按量计费、价格以官方页面为准。",
  done: "OCR 环境和 AI 服务都已就绪。现在上传第一份体检报告，就能自动识别指标并归档。"
}[step.value]));
const progressLabel = computed(() => ({
  welcome: "共 2 步，只需配置一次",
  ocr: "第 1 步 · OCR 识别环境",
  ai: "第 2 步 · AI 整理服务",
  done: "配置完成"
}[step.value]));

/* ---------- OCR 安装 ---------- */
const ocrAvailable = ref(false);
const ocrInstalling = ref(false);
const ocrError = ref("");
const ocrLogTail = ref<string[]>([]);
let ocrTimer: ReturnType<typeof setInterval> | null = null;

function stopOcrPolling() {
  if (!ocrTimer) return;
  clearInterval(ocrTimer);
  ocrTimer = null;
}
function startOcrPolling() {
  if (ocrTimer) return;
  ocrTimer = setInterval(() => { void refreshOcrStatus(); }, 3000);
}

async function refreshOcrStatus() {
  try {
    const status = await request<OcrStatus>("ocr/status");
    ocrAvailable.value = status.available;
    ocrInstalling.value = status.installing;
    ocrLogTail.value = status.lastInstall?.logTail?.slice(-6) || [];
    if (status.available) {
      ocrError.value = "";
      stopOcrPolling();
    } else if (!status.installing) {
      stopOcrPolling();
      if (status.lastInstall?.state === "failed") {
        ocrError.value = status.lastInstall.error || "安装失败，可到“运行与识别”中更换镜像源后重试";
      }
    }
  } catch { /* 轮询偶发失败不打断，下个周期重试 */ }
}

async function installOcr() {
  ocrError.value = "";
  try {
    const status = await request<OcrStatus>("ocr/install", { method: "POST" });
    ocrAvailable.value = status.available;
    ocrInstalling.value = status.installing;
    if (status.installing) startOcrPolling();
    else await refreshOcrStatus();
  } catch (cause) {
    ocrError.value = cause instanceof Error ? cause.message : "OCR 安装启动失败";
  }
}

/* ---------- AI（DeepSeek）配置 ---------- */
const aiBaseUrl = ref("https://api.deepseek.com");
const aiTextModel = ref("deepseek-v4-flash");
const apiKey = ref("");
const testing = ref(false);
const saving = ref(false);
const testPassed = ref(false);
const aiMessage = ref("");
const aiMessageOk = ref(false);

async function loadAiPreset() {
  try {
    const settings = await request<AiSettingsView>("ai/settings");
    const preset = settings.providers.find((provider) => provider.key === "deepseek") || settings.providers[0];
    if (preset) {
      aiBaseUrl.value = preset.defaultBaseUrl || aiBaseUrl.value;
      aiTextModel.value = preset.defaultTextModel || aiTextModel.value;
    }
  } catch { /* 预置读取失败时使用内置默认值 */ }
}

function aiPayload() {
  return {
    provider: "deepseek",
    baseUrl: aiBaseUrl.value.trim(),
    textModel: aiTextModel.value.trim(),
    apiKey: apiKey.value.trim()
  };
}

async function testConnection() {
  testing.value = true;
  aiMessage.value = "";
  aiMessageOk.value = false;
  try {
    const result = await request<{ model: string; elapsedMs: number }>("ai/test", {
      method: "POST",
      body: JSON.stringify(aiPayload())
    });
    testPassed.value = true;
    aiMessageOk.value = true;
    aiMessage.value = `${result.model} 连接正常，耗时 ${result.elapsedMs} ms`;
  } catch (cause) {
    testPassed.value = false;
    aiMessage.value = cause instanceof Error ? cause.message : "连接失败，请检查 Key 是否正确";
  } finally {
    testing.value = false;
  }
}

async function saveAiConfig() {
  saving.value = true;
  aiMessage.value = "";
  aiMessageOk.value = false;
  try {
    await request("ai/settings", {
      method: "PUT",
      body: JSON.stringify({ enabled: true, ...aiPayload() })
    });
    step.value = "done";
  } catch (cause) {
    aiMessage.value = cause instanceof Error ? cause.message : "保存失败，请稍后重试";
  } finally {
    saving.value = false;
  }
}

/* ---------- 完成与关闭 ---------- */
const dismissing = ref(false);

async function finishGuide() {
  dismissing.value = true;
  try {
    await request("setup/guide-dismissed", { method: "PUT" });
  } catch { /* 标记失败不影响关闭，下次状态齐全后也不会再弹出 */ }
  dismissing.value = false;
  emit("done");
}

/* 中途关闭只隐藏本次：配置未齐全时下次打开应用仍会引导 */
function closeGuide() {
  stopOcrPolling();
  emit("done");
}

function openAdvanced(path: string) {
  closeGuide();
  void router.push(path);
}

onMounted(async () => {
  void loadAiPreset();
  try {
    const status = await request<SetupGuideStatus>("setup/status");
    ocrAvailable.value = status.ocrInstalled;
    ocrInstalling.value = status.ocrInstalling;
    if (status.ocrInstalling) startOcrPolling();
  } catch { /* 状态读取失败时按未安装展示，可手动重试 */ }
});

onBeforeUnmount(stopOcrPolling);
</script>

<template>
  <Teleport to="body">
    <div class="modal-backdrop setup-guide-backdrop" @click.self="closeGuide">
      <section class="modal-panel setup-guide-panel" role="dialog" aria-modal="true" aria-label="首次使用引导">
        <header class="setup-guide-header">
          <div class="setup-guide-title">
            <span class="setup-guide-title-icon" aria-hidden="true"><PartyPopper :size="18" /></span>
            <h3>欢迎使用健康档案</h3>
          </div>
          <button class="plain-icon-button" type="button" title="稍后再说" @click="closeGuide"><X :size="18" /></button>
        </header>
        <div class="setup-guide-body">
          <p class="setup-guide-lead">{{ leadText }}</p>
          <div class="setup-guide-progress" aria-hidden="true">
            <span :class="{ active: step === 'ocr', done: step === 'ai' || step === 'done' }"></span>
            <span :class="{ active: step === 'ai', done: step === 'done' }"></span>
            <small>{{ progressLabel }}</small>
          </div>

        <template v-if="step === 'welcome'">
          <div class="setup-guide-intro">
            <article>
              <ScanText :size="20" />
              <div><strong>安装 OCR 识别环境</strong><span>在本地把报告图片/PDF 转成文字，原件不上传云端</span></div>
            </article>
            <article>
              <Bot :size="20" />
              <div><strong>配置 AI 整理服务</strong><span>把文字整理成指标、趋势和提醒，推荐使用 DeepSeek</span></div>
            </article>
          </div>
          <div class="setup-guide-actions">
            <button class="primary-button" type="button" @click="step = 'ocr'">开始设置<ChevronRight :size="16" /></button>
            <button class="soft-action-button" type="button" @click="closeGuide">稍后再说</button>
          </div>
        </template>

        <template v-else-if="step === 'ocr'">
          <h3 class="setup-guide-step-title"><Cpu :size="18" />第一步：安装 OCR 识别环境</h3>
          <div v-if="ocrAvailable" class="setup-guide-status ok">
            <CheckCircle2 :size="18" /><span>OCR 环境已就绪</span>
          </div>
          <div v-else-if="ocrInstalling" class="setup-guide-status busy">
            <LoaderCircle :size="18" class="spin-icon" /><span>正在安装 OCR 环境，请稍候…</span>
          </div>
          <pre v-if="ocrInstalling && ocrLogTail.length" class="setup-guide-log">{{ ocrLogTail.join("\n") }}</pre>
          <p v-if="ocrError" class="setup-guide-error"><CircleAlert :size="15" />{{ ocrError }}</p>
          <div class="setup-guide-actions">
            <button v-if="!ocrAvailable && !ocrInstalling" class="primary-button" type="button" @click="installOcr">一键安装 OCR</button>
            <button v-if="ocrAvailable" class="primary-button" type="button" @click="step = 'ai'">下一步<ChevronRight :size="16" /></button>
            <button class="soft-action-button" type="button" :disabled="ocrInstalling" @click="step = 'welcome'"><ChevronLeft :size="16" />上一步</button>
          </div>
          <button class="setup-guide-link" type="button" @click="openAdvanced('/me/runtime')">安装遇到问题？打开“运行与识别”诊断</button>
        </template>

        <template v-else-if="step === 'ai'">
          <h3 class="setup-guide-step-title"><KeyRound :size="18" />第二步：配置 AI 整理服务</h3>
          <ol class="setup-guide-tutorial">
            <li>打开 <a href="https://platform.deepseek.com/" target="_blank" rel="noreferrer">DeepSeek 开放平台<ExternalLink :size="12" /></a>，注册并登录账号</li>
            <li>进入「API Keys」页面，创建一个新的 API Key 并复制</li>
            <li>把 Key 粘贴到下方输入框</li>
          </ol>
          <label class="setup-guide-field">
            <span>DeepSeek API Key</span>
            <input
              v-model="apiKey"
              type="password"
              placeholder="sk-..."
              autocomplete="off"
              @input="testPassed = false"
            />
          </label>
          <p class="setup-guide-hint">服务地址 {{ aiBaseUrl }} · 模型 {{ aiTextModel }}，Key 只保存在本机</p>
          <p v-if="aiMessage" class="setup-guide-error" :class="{ ok: aiMessageOk }">
            <CheckCircle2 v-if="aiMessageOk" :size="15" /><CircleAlert v-else :size="15" />{{ aiMessage }}
          </p>
          <div class="setup-guide-actions">
            <button class="soft-action-button" type="button" :disabled="testing || saving || !apiKey.trim()" @click="testConnection">
              <LoaderCircle v-if="testing" class="spin-icon" :size="15" />{{ testing ? "测试中" : "测试连接" }}
            </button>
            <button class="primary-button" type="button" :disabled="saving || testing || !apiKey.trim()" @click="saveAiConfig">
              <LoaderCircle v-if="saving" class="spin-icon" :size="15" />{{ saving ? "保存中" : "保存并完成" }}
            </button>
            <button class="soft-action-button" type="button" :disabled="saving" @click="step = 'ocr'"><ChevronLeft :size="16" />上一步</button>
          </div>
          <button class="setup-guide-link" type="button" @click="openAdvanced('/me/ai')">使用其他服务商或本地模型？打开“AI 解析模型”设置</button>
        </template>

        <template v-else>
          <h3 class="setup-guide-step-title ok"><CheckCircle2 :size="18" />配置完成</h3>
          <div class="setup-guide-intro">
            <article><ScanText :size="20" /><div><strong>OCR 识别环境</strong><span>已安装</span></div></article>
            <article><Bot :size="20" /><div><strong>AI 整理服务</strong><span>已配置 DeepSeek</span></div></article>
          </div>
          <div class="setup-guide-actions">
            <button class="primary-button" type="button" :disabled="dismissing" @click="finishGuide">
              <LoaderCircle v-if="dismissing" class="spin-icon" :size="15" />开始上传报告
            </button>
          </div>
        </template>
        </div>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.setup-guide-backdrop { display: flex; align-items: center; justify-content: center; padding: 20px; z-index: 90; }
.setup-guide-panel { width: min(520px, 100%); max-height: calc(100dvh - 40px); overflow-y: auto; padding: 18px 22px 22px; }
.setup-guide-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 6px; }
.setup-guide-title { display: flex; align-items: center; gap: 10px; min-width: 0; }
.setup-guide-title-icon { flex: 0 0 auto; width: 32px; height: 32px; border-radius: 10px; display: flex; align-items: center; justify-content: center; background: var(--brand-softer, #e8f1fe); color: var(--brand-strong, #1f64d8); }
.setup-guide-header h3 { margin: 0; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 16px; }
.setup-guide-progress { display: flex; align-items: center; gap: 6px; }
.setup-guide-progress span { width: 26px; height: 4px; border-radius: 999px; background: var(--fill-4, #e5e7eb); transition: background .2s; }
.setup-guide-progress span.active { background: var(--brand, #2f7cf6); }
.setup-guide-progress span.done { background: var(--brand, #2f7cf6); opacity: .45; }
.setup-guide-progress small { margin-left: 4px; color: var(--muted); font-size: 12px; }
.setup-guide-body { display: grid; gap: 12px; }
.setup-guide-body h3 { margin: 0; font-size: 18px; }
.setup-guide-step-title { display: flex; align-items: center; gap: 8px; }
.setup-guide-step-title svg { flex: 0 0 auto; color: var(--brand-strong, #1f64d8); }
.setup-guide-step-title.ok svg { color: var(--success, #1c9a5b); }
.setup-guide-lead { margin: 0; color: var(--muted); font-size: 14px; line-height: 1.7; }
.setup-guide-intro { display: grid; gap: 8px; }
.setup-guide-intro article { display: flex; gap: 12px; align-items: flex-start; padding: 12px 14px; border-radius: 12px; background: var(--fill-2, #f6f7f9); color: var(--brand-strong, #1f64d8); }
.setup-guide-intro article div { display: grid; gap: 2px; }
.setup-guide-intro article strong { color: var(--ink); font-size: 14px; }
.setup-guide-intro article span { color: var(--muted); font-size: 12px; line-height: 1.5; }
.setup-guide-status { display: flex; align-items: center; gap: 8px; padding: 12px 14px; border-radius: 12px; font-size: 14px; font-weight: 600; }
.setup-guide-status.ok { background: var(--success-soft, #e5f7ed); color: var(--success, #1c9a5b); }
.setup-guide-status.busy { background: var(--brand-softer, #e8f1fe); color: var(--brand-strong, #1f64d8); }
.setup-guide-log { margin: 0; padding: 10px 12px; border-radius: 10px; background: var(--fill-2, #f6f7f9); color: var(--muted); font-size: 11px; line-height: 1.6; max-height: 120px; overflow-y: auto; white-space: pre-wrap; word-break: break-all; }
.setup-guide-tutorial { margin: 0; padding-left: 20px; display: grid; gap: 6px; color: var(--ink); font-size: 14px; line-height: 1.7; }
.setup-guide-tutorial a { color: var(--brand-strong, #1f64d8); font-weight: 600; display: inline-flex; align-items: center; gap: 3px; }
.setup-guide-field { display: grid; gap: 6px; }
.setup-guide-field span { color: var(--muted); font-size: 12px; font-weight: 600; }
.setup-guide-field input { width: 100%; min-height: 44px; padding: 10px 12px; border: 1px solid var(--line-strong, #d4d7dd); border-radius: 10px; background: var(--surface); color: var(--ink); }
.setup-guide-field input:focus { border-color: var(--brand, #2f7cf6); outline: 0; box-shadow: 0 0 0 3px var(--brand-soft, #d6e6fd); }
.setup-guide-hint { margin: 0; color: var(--muted); font-size: 12px; }
.setup-guide-error { display: flex; align-items: center; gap: 6px; margin: 0; color: var(--danger, #d64545); font-size: 13px; }
.setup-guide-error.ok { color: var(--success, #1c9a5b); }
.setup-guide-actions { display: flex; flex-wrap: wrap; gap: 10px; }
.setup-guide-actions button { display: inline-flex; align-items: center; gap: 6px; }
.setup-guide-link { border: 0; background: transparent; color: var(--muted); font-size: 12px; text-decoration: underline; text-underline-offset: 3px; cursor: pointer; padding: 0; justify-self: start; }
.setup-guide-link:hover { color: var(--brand-strong, #1f64d8); }
@media (max-width: 760px), (pointer: coarse) {
  .setup-guide-backdrop { padding: 0; align-items: flex-end; }
  .setup-guide-panel { width: 100%; max-height: 94dvh; border-radius: 20px 20px 0 0; padding-bottom: calc(22px + var(--safe-bottom, 0px)); }
  .setup-guide-actions button { flex: 1 1 auto; justify-content: center; }
}
</style>
