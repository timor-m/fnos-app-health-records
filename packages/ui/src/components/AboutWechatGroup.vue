<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { MessageCircle } from "@lucide/vue";
import { apiUrl } from "../utils/api";

type WechatGroup = {
  id: number;
  name: string;
  description: string;
  qrContent: string;
  expiresAt: string;
  revision: number;
};

const group = ref<WechatGroup | null>(null);
const qrImage = ref("");
const controller = new AbortController();
let timeout: ReturnType<typeof setTimeout> | undefined;
let expiryTimer: ReturnType<typeof setTimeout> | undefined;
let expiresAfter = 0;
let startedAt = 0;
let startedWallTime = 0;

function hideGroup() {
  group.value = null;
  qrImage.value = "";
  clearTimeout(expiryTimer);
}

function remainingLifetime() {
  // A wall-clock delta also covers device sleep in browsers whose performance clock pauses.
  // The monotonic delta prevents moving the device clock backwards from extending validity.
  const elapsed = Math.max(performance.now() - startedAt, Date.now() - startedWallTime);
  return expiresAfter - elapsed;
}

function checkExpiry() {
  clearTimeout(expiryTimer);
  if (!group.value) return;
  const remaining = remainingLifetime();
  if (remaining <= 0) hideGroup();
  else expiryTimer = setTimeout(checkExpiry, Math.min(remaining, 2_147_483_647));
}

function isWechatGroupQrContent(value: unknown): value is string {
  const maxImageBytes = 5 * 1024 * 1024;
  if (typeof value !== "string" || value.length > Math.ceil(maxImageBytes / 3) * 4 + 23) return false;
  const prefix = /^data:image\/(?:jpeg|png|webp);base64,/.exec(value);
  if (!prefix) return false;
  const encoded = value.slice(prefix[0].length);
  if (!encoded.length || encoded.length % 4 !== 0) return false;
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  if (/[^A-Za-z0-9+/]/.test(encoded.slice(0, encoded.length - padding))) return false;
  return encoded.length * 3 / 4 - padding <= maxImageBytes;
}

function validGroup(value: unknown): value is WechatGroup {
  if (!value || typeof value !== "object") return false;
  const candidate = value as WechatGroup;
  return Number.isSafeInteger(candidate.id) && candidate.id > 0
    && typeof candidate.name === "string" && candidate.name.trim().length > 0 && candidate.name.length <= 120
    && typeof candidate.description === "string" && candidate.description.length <= 1000
    && isWechatGroupQrContent(candidate.qrContent)
    && typeof candidate.expiresAt === "string" && Number.isFinite(Date.parse(candidate.expiresAt))
    && Number.isSafeInteger(candidate.revision) && candidate.revision > 0;
}

async function loadGroup() {
  startedAt = performance.now();
  startedWallTime = Date.now();
  timeout = setTimeout(() => { controller.abort(); hideGroup(); }, 6000);
  try {
    // This optional request must not trigger the shared API helper's global access-denied event.
    const response = await fetch(apiUrl("wechat-group"), { signal: controller.signal, cache: "no-store" });
    if (!response.ok || controller.signal.aborted) return;
    const payload = await response.json();
    const data = payload?.ok === true ? payload.data : null;
    if (!validGroup(data?.group) || typeof data.serverTime !== "string") return;
    const serverTime = Date.parse(data.serverTime);
    if (!Number.isFinite(serverTime)) return;
    // Use the server's clock and subtract the full request duration conservatively.
    expiresAfter = Date.parse(data.group.expiresAt) - serverTime;
    if (remainingLifetime() <= 0 || controller.signal.aborted) return;
    qrImage.value = data.group.qrContent;
    group.value = data.group;
    checkExpiry();
  } catch {
    // No group, unavailable service and rendering failures all omit this optional section.
    hideGroup();
  } finally {
    clearTimeout(timeout);
  }
}

onMounted(() => {
  void loadGroup();
  document.addEventListener("visibilitychange", checkExpiry);
});

onBeforeUnmount(() => {
  controller.abort();
  clearTimeout(timeout);
  clearTimeout(expiryTimer);
  document.removeEventListener("visibilitychange", checkExpiry);
});
</script>

<template>
  <section v-if="group && qrImage" class="settings-band about-wechat-group" aria-label="微信交流群">
    <header>
      <MessageCircle :size="21" />
      <div><h3>微信交流群</h3><p>交流使用体验，分享建议</p></div>
    </header>
    <div class="about-wechat-content">
      <img :src="qrImage" :alt="`${group.name}加群二维码`" @error="hideGroup" />
      <div class="about-wechat-description">
        <strong>{{ group.name }}</strong>
        <p v-if="group.description" class="about-wechat-intro">{{ group.description }}</p>
        <p>使用微信扫码，或保存图片后在微信中识别入群</p>
      </div>
    </div>
  </section>
</template>

<style scoped>
.about-wechat-content { display: flex; align-items: center; gap: 24px; padding: 20px; }
.about-wechat-content img { display: block; width: min(360px, 55%); height: auto; max-width: 100%; background: #fff; flex-shrink: 0; border: 1px solid var(--line); border-radius: 12px; }
.about-wechat-description { display: grid; gap: 12px; min-width: 0; overflow-wrap: anywhere; }
.about-wechat-description strong { font-size: 15px; color: var(--ink); }
.about-wechat-description p { line-height: 1.7; }
.about-wechat-intro { white-space: pre-wrap; }
@media (max-width: 600px) {
  .about-wechat-content { flex-direction: column; gap: 16px; text-align: center; }
  .about-wechat-content img { width: min(360px, 100%); }
}
</style>
