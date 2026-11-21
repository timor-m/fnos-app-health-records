<script setup lang="ts">
import MemberManager from "../components/MemberManager.vue";
import { computed, onMounted, onBeforeUnmount, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { Bell, ChartNoAxesCombined, ChevronsUpDown, FolderHeart, LayoutDashboard, Search, UserRound, X } from "@lucide/vue";
import appIcon from "../assets/app-icon.png";
import MemberSwitcher from "../components/MemberSwitcher.vue";
import SetupGuideModal from "../components/SetupGuideModal.vue";
import QuickAddMenu from "../components/QuickAddMenu.vue";
import { useAppContext } from "../composables/useAppContext";
import { request } from "../utils/api";
import { healthPageScrollKey } from '../utils/health-record-navigation';

const app = useAppContext();
const route = useRoute();
const router = useRouter();
watch(app.selectedMemberId, (next, previous) => {
  if (previous && next !== previous && (/^\/(health-processes|add)\/[^/]+$/.test(route.path) || route.path.startsWith('/events/detail/'))) void router.replace('/events');
  if (previous && next !== previous && route.path === '/events' && (route.query?.recordKind || route.query?.recordId || route.query?.add)) void router.replace('/events');
}, { flush: 'sync' });
const memberSheetOpen = ref(false);
const topbarSearchFocused = ref(false);
const topbarSearchInput = ref<HTMLInputElement | null>(null);
// Startup feedback sync is bounded to 30 seconds. Refresh the local badge once
// afterwards, without polling the remote feedback service or delaying app loading.
let startupNoticeRefresh: ReturnType<typeof setTimeout> | undefined;
onMounted(() => {
  if (app.session.value?.isAdmin) startupNoticeRefresh = setTimeout(() => {
    if (app.session.value?.isAdmin) void app.refreshReminderCount();
  }, 30000);
});
onBeforeUnmount(() => { if (startupNoticeRefresh) clearTimeout(startupNoticeRefresh); });


/* 首次使用引导：管理员且 OCR/AI 未配齐时自动弹出，完成引导或配置齐全后不再出现 */
type SetupGuideStatus = { ocrInstalled: boolean; aiConfigured: boolean; guideDismissed: boolean };
const setupGuideOpen = ref(false);
onMounted(async () => {
  if (!app.session.value?.isAdmin) return;
  try {
    const status = await request<SetupGuideStatus>("setup/status");
    if (!status.guideDismissed && (!status.ocrInstalled || !status.aiConfigured)) setupGuideOpen.value = true;
  } catch { /* 引导状态读取失败不影响正常使用 */ }
});

const accountRole = computed(() => {
  if (!app.session.value?.isAdmin) return "家庭成员";
  if (app.session.value.provider === "development") return "开发管理员";
  if (app.session.value.provider === "local") return "本地管理员";
  return "fnOS 系统管理员";
});
const pageTitle = computed(() => (route.meta.title as string) || "健康档案");
const pageSubtitleKey = computed(() => {
  if (route.path === "/overview") return "overview";
  if (route.path === "/records") return "records";
  if (route.path === "/trends") return "trends";
  return "";
});
const pageSubtitle = computed(() => {
  const key = pageSubtitleKey.value;
  if (key) return app.topbarSubtitles.value[key] || "";
  return (route.meta.subtitle as string) || "";
});
const memberInitial = computed(() => app.selectedMember.value?.displayName?.slice(0, 1) || "档");
const reminderBadge = computed(() => {
  const count = app.pendingReminderCount.value;
  if (count <= 0) return "";
  return count > 99 ? "99+" : String(count);
});
function isNavActive(to: string, mobile = false) {
  if (to === '/events' && (route.path === '/health-processes' || route.path.startsWith('/health-processes/') || route.path === '/records')) return true;
  return route.path === to || route.path.startsWith(`${to}/`);
}
// “我的”及其二级设置页统一展示账号信息顶栏，页面标题由页面内的 SubPageHeader 承担
const isMePage = computed(() => route.path === "/me" || route.path.startsWith("/me/"));
const topbarSearchPageKey = computed(() => {
  if (route.path === "/records") return "records";
  if (route.path === "/events") return "events";
  if (route.path === "/trends" || route.path.startsWith("/trends/")) return "trends";
  return "";
});
const activeTopbarSearch = computed(() => {
  const search = app.topbarSearch.value;
  return search?.key === topbarSearchPageKey.value ? search : null;
});
const topbarSearchPlaceholder = computed(() => {
  const search = activeTopbarSearch.value;
  if (topbarSearchFocused.value && search?.expandedPlaceholder) return search.expandedPlaceholder;
  return search?.placeholder
    || (topbarSearchPageKey.value === "events" ? "搜索记录" : topbarSearchPageKey.value === "records" ? "搜索档案" : "搜索指标");
});
const topbarSearchValue = computed({
  get: () => activeTopbarSearch.value?.model.value || "",
  set: (value: string) => {
    if (activeTopbarSearch.value) app.setTopbarSearchValue(value);
  }
});

function submitTopbarSearch() {
  activeTopbarSearch.value?.submit?.();
}

function clearTopbarSearch() {
  topbarSearchValue.value = "";
  activeTopbarSearch.value?.submit?.();
}

function cancelTopbarSearch() {
  clearTopbarSearch();
  topbarSearchInput.value?.blur();
  topbarSearchFocused.value = false;
}

watch([topbarSearchPageKey, () => app.topbarSearch.value?.key], () => {
  topbarSearchFocused.value = false;
});

/* 页面缓存（KeepAlive）下的滚动位置记忆：切走前按路径保存；恢复放在 enter（新页已插入但淡入未开始），避免过渡期间位置漂移造成跳动 */
const pageScrollPositions = new Map<string, number>();
let activePath = healthPageScrollKey(route.fullPath, app.selectedMemberId.value);
function savePageScroll() {
  pageScrollPositions.set(activePath, window.scrollY);
}
function restorePageScroll() {
  activePath = healthPageScrollKey(route.fullPath, app.selectedMemberId.value);
  window.scrollTo(0, pageScrollPositions.get(activePath) ?? 0);
}
const sessionInitial = computed(() => app.session.value?.displayName?.slice(0, 1) || "我");
const providerLabel = computed(() => {
  const provider = app.session.value?.provider;
  if (provider === "local") return "直连账号";
  if (provider === "development") return "开发账号";
  return "fnOS 账号";
});
const roleLabel = computed(() => app.session.value?.isAdmin ? "管理员" : "家庭成员");
const canManageSelectedMember = computed(() => app.selectedMember.value?.permission === 'manager');
const navItems = [
  { to: "/overview", label: "概览", icon: LayoutDashboard },
  { to: "/events", label: "记录", icon: FolderHeart },
  { to: "/trends", label: "趋势", icon: ChartNoAxesCombined },
  { to: "/me", label: "我的", icon: UserRound, badge: reminderBadge }
];
</script>

<template>
  <div class="app-shell" :class="{ 'is-vaccination-entry': route.path === '/add/vaccination' }">
    <aside class="sidebar">
      <div class="brand">
        <img :src="appIcon" alt="" />
        <div><strong>健康档案</strong><span>家庭医疗记录</span></div>
      </div>
      <button class="member-picker-card" type="button" @click="memberSheetOpen = true">
        <span class="member-picker-label">当前成员</span>
        <span class="member-picker-body">
          <span class="member-avatar small" aria-hidden="true">{{ memberInitial }}</span>
          <strong>{{ app.selectedMember.value?.displayName || "选择成员" }}</strong>
          <ChevronsUpDown :size="16" />
        </span>
      </button>
      <nav class="desktop-nav" aria-label="主导航">
        <template v-for="item in navItems" :key="item.to">
          <RouterLink :to="item.to" :class="{ 'router-link-active': isNavActive(item.to) }">
            <span class="nav-icon-wrap">
              <component :is="item.icon" :size="17" />
              <span v-if="item.badge?.value" class="nav-badge">{{ item.badge.value }}</span>
            </span>
            <span>{{ item.label }}</span>
          </RouterLink>
          <QuickAddMenu v-if="item.to === '/events'" placement="desktop" :can-manage="canManageSelectedMember" :route-key="route.fullPath" />
        </template>
      </nav>
      <div class="account-summary">
        <span class="member-avatar small" aria-hidden="true">{{ app.session.value?.displayName?.slice(0, 1) }}</span>
        <div><strong>{{ app.session.value?.displayName }}</strong><span>{{ accountRole }}</span></div>
      </div>
    </aside>

    <section class="workspace">
      <header
        class="mobile-topbar"
        :class="{
          'has-topbar-search': Boolean(topbarSearchPageKey),
          'topbar-search-focused': topbarSearchFocused
        }"
      >
        <template v-if="isMePage">
          <span class="topbar-avatar" aria-hidden="true">{{ sessionInitial }}</span>
          <div class="topbar-heading">
            <strong class="topbar-title">{{ app.session.value?.displayName }}</strong>
            <span class="topbar-subtitle">{{ providerLabel }} · {{ roleLabel }}</span>
          </div>
          <RouterLink class="topbar-bell" to="/reminders" aria-label="查看提醒">
            <Bell :size="19" />
            <span v-if="reminderBadge" class="nav-badge">{{ reminderBadge }}</span>
          </RouterLink>
        </template>
        <template v-else>
          <img class="topbar-brand-icon topbar-search-context" :src="appIcon" alt="" />
          <div class="topbar-heading topbar-search-context">
            <strong class="topbar-title">{{ pageTitle }}</strong>
            <span
              v-if="pageSubtitle || pageSubtitleKey"
              class="topbar-subtitle"
              :class="{ 'is-placeholder': !pageSubtitle }"
              :aria-hidden="!pageSubtitle"
            >{{ pageSubtitle }}</span>
          </div>
          <div v-if="topbarSearchPageKey" class="topbar-search-tools">
            <label class="topbar-search-field">
              <Search :size="17" />
              <input
                ref="topbarSearchInput"
                v-model="topbarSearchValue"
                :placeholder="topbarSearchPlaceholder"
                :aria-label="activeTopbarSearch?.placeholder || topbarSearchPlaceholder"
                enterkeyhint="search"
                @focus="topbarSearchFocused = true"
                @blur="topbarSearchFocused = false"
                @keydown.enter="submitTopbarSearch"
                @keydown.esc="cancelTopbarSearch"
              />
              <button
                v-if="topbarSearchValue"
                type="button"
                title="清空搜索"
                aria-label="清空搜索"
                @mousedown.prevent
                @click="clearTopbarSearch"
              >
                <X :size="15" />
              </button>
            </label>
            <button
              v-if="topbarSearchFocused"
              class="topbar-search-cancel"
              type="button"
              @mousedown.prevent
              @click="cancelTopbarSearch"
            >取消</button>
          </div>
          <button v-else class="member-chip" type="button" @click="memberSheetOpen = true">
            <span class="member-chip-avatar" aria-hidden="true">{{ memberInitial }}</span>
            <span class="member-chip-name">{{ app.selectedMember.value?.displayName || "选择成员" }}</span>
            <ChevronsUpDown :size="15" />
          </button>
        </template>
      </header>
      <main class="page-content">
        <MemberManager v-if="!app.selectedMemberId.value && !route.path.startsWith('/me') && route.path !== '/reminders'" />
        <RouterView v-else v-slot="{ Component }">
          <Transition name="page-fade" mode="out-in" @before-leave="savePageScroll" @enter="restorePageScroll">
            <KeepAlive :key="`${app.session.value?.id}:${app.selectedMemberId.value}:${app.accessVersion.value}`">
              <component :is="Component" />
            </KeepAlive>
          </Transition>
        </RouterView>
      </main>
    </section>

    <nav class="mobile-nav" aria-label="触屏导航">
      <span class="mobile-nav-rules" aria-hidden="true"></span>
      <div class="mobile-nav-shoulder" aria-hidden="true"></div>
      <svg class="mobile-nav-edge" viewBox="-42 -18 84 22" aria-hidden="true">
        <path d="M-35.1 0 A16 16 0 0 0 -24.088 -4.392 A35 35 0 0 1 24.088 -4.392 A16 16 0 0 0 35.1 0" />
      </svg>
      <template v-for="item in navItems" :key="item.to">
        <RouterLink :to="item.to" :class="{ 'router-link-active': isNavActive(item.to, true) }">
          <span class="mobile-nav-icon">
            <component :is="item.icon" :size="21" />
            <span v-if="item.badge?.value" class="nav-badge mobile">{{ item.badge.value }}</span>
          </span>
          <span>{{ item.label }}</span>
        </RouterLink>
        <QuickAddMenu v-if="item.to === '/events'" placement="mobile" :can-manage="canManageSelectedMember" :route-key="route.fullPath" />
      </template>
    </nav>

    <MemberSwitcher :open="memberSheetOpen" @close="memberSheetOpen = false" />
    <SetupGuideModal v-if="setupGuideOpen" @done="setupGuideOpen = false" />
  </div>
</template>
