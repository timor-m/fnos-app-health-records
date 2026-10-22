<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { Copy, Cpu, UserRound } from "@lucide/vue";
import SubPageHeader from "../../components/SubPageHeader.vue";
import AboutWechatGroup from "../../components/AboutWechatGroup.vue";
import { request } from "../../utils/api";
import { useToast } from "../../composables/useToast";
import { copyTextToClipboard } from "../../utils/clipboard";

type AboutSummary = {
  appName: string;
  appTitle: string;
  appVersion: string;
  appDescription: string;
  maintainer: string;
  maintainerUrl: string;
  distributor: string;
  distributorUrl: string;
  osMinVersion: string;
  accessMode: string;
  runtime: {
    name: string;
    node: string;
    platform: string;
    arch: string;
  };
  database: {
    driver: string;
    schemaVersion: number;
    appliedSchemaVersion: number;
    journalMode: string;
    integrity: string;
  };
};

const about = ref<AboutSummary | null>(null);
const loadFailed = ref(false);
const message = ref("");
const toast = useToast();
const qqGroupNumber = "1085626763";

async function copyQqGroup() {
  const copied = await copyTextToClipboard(qqGroupNumber);
  toast.show(copied ? "QQ 群号已复制" : "复制失败，请长按群号手动复制");
}
const placeholder = computed(() => (loadFailed.value ? "—" : "加载中"));
const subtitle = computed(() => `应用标识：${about.value?.appName || "fnos-app-health-records"}`);
const currentSchemaVersion = computed(() => about.value?.database?.appliedSchemaVersion || about.value?.database?.schemaVersion || "—");

async function loadAbout() {
  loadFailed.value = false;
  message.value = "";
  try {
    about.value = await request<AboutSummary>("about");
  } catch (error) {
    loadFailed.value = true;
    message.value = error instanceof Error ? error.message : "无法读取应用信息";
  }
}

onMounted(() => {
  void loadAbout();
});
</script>

<template>
  <section class="settings-page">
    <SubPageHeader title="关于" :description="subtitle" />

    <section class="settings-band about-hero">
      <div class="about-summary-grid">
        <div><span>应用版本</span><strong>{{ about?.appVersion || placeholder }}</strong></div>
        <div><span>当前数据库版本</span><strong>v{{ currentSchemaVersion }}</strong></div>
      </div>
    </section>

    <section class="settings-band">
      <header>
        <Cpu :size="21" />
        <div><h3>运行环境</h3><p>服务端运行时与设备架构</p></div>
      </header>
      <div class="about-summary-grid about-summary-grid--compact">
        <div><span>运行时</span><strong>{{ about?.runtime?.name || placeholder }}</strong></div>
        <div><span>Node.js</span><strong>{{ about?.runtime?.node || placeholder }}</strong></div>
        <div><span>平台</span><strong>{{ about?.runtime?.platform || placeholder }}</strong></div>
        <div><span>架构</span><strong>{{ about?.runtime?.arch || placeholder }}</strong></div>
      </div>
    </section>

    <section class="settings-band">
      <header>
        <UserRound :size="21" />
        <div><h3>开发者信息</h3><p>维护者与源代码</p></div>
      </header>
      <div class="about-kv-list">
        <div><span>维护者</span><strong>{{ about?.maintainer || placeholder }}</strong></div>
        <div><span>源代码</span><a v-if="about?.maintainerUrl" :href="about.maintainerUrl" target="_blank" rel="noreferrer">{{ about.maintainerUrl }}</a><strong v-else>{{ placeholder }}</strong></div>
        <div><span>QQ 交流群</span><button class="about-copy-value" type="button" title="点击复制群号" @click="copyQqGroup"><strong>{{ qqGroupNumber }}</strong><Copy :size="13" /></button></div>
      </div>
    </section>

    <AboutWechatGroup />

    <p v-if="message" class="inline-panel-error">
      {{ message }}<button class="error-retry" type="button" @click="loadAbout">重试</button>
    </p>
  </section>
</template>
