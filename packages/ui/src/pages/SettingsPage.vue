<script setup lang="ts">
import { computed, ref } from "vue";
import { Bell, Bot, ChevronRight, ChevronsUpDown, ClipboardList, DatabaseBackup, GitMerge, HardDrive, Info, KeyRound, LogOut, ScrollText, ServerCog, SunMoon, Trash2, UsersRound, Wrench } from "@lucide/vue";
import FormSelect from "../components/FormSelect.vue";
import MemberSwitcher from "../components/MemberSwitcher.vue";
import { useAppContext } from "../composables/useAppContext";
import { useTheme } from "../composables/useTheme";

const app = useAppContext();
const memberSheetOpen = ref(false);
const { setting: themeSetting } = useTheme();
const themeOptions = [
  { value: "system", label: "跟随系统" },
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" }
];
const accountRole = app.session.value?.isAdmin ? "管理员" : "家庭成员";
const reminderBadge = computed(() => {
  const count = app.pendingReminderCount.value;
  if (count <= 0) return "";
  return count > 99 ? "99+" : String(count);
});
</script>

<template>
  <section class="settings-page my-page">
    <div class="page-intro my-page-title">
      <div><h2>我的</h2><p>{{ app.session.value?.displayName }} · {{ accountRole }}</p></div>
    </div>

    <section class="my-profile">
      <span class="my-avatar">{{ app.session.value?.displayName?.slice(0, 1) || "我" }}</span>
      <div><strong>{{ app.session.value?.displayName }}</strong><span>管理家庭健康档案与识别服务</span></div>
      <button class="member-select-card" type="button" @click="memberSheetOpen = true">
        <span>当前档案</span>
        <strong>{{ app.selectedMember.value?.displayName || "选择成员" }}</strong>
        <ChevronsUpDown :size="15" />
      </button>
      <RouterLink class="profile-reminder-link" to="/reminders" aria-label="查看提醒">
        <Bell :size="20" />
        <span v-if="reminderBadge" class="nav-badge">{{ reminderBadge }}</span>
      </RouterLink>
    </section>

    <section class="settings-band appearance-band">
      <header>
        <SunMoon :size="20" />
        <div><h3>外观</h3><p>主题跟随系统，也可固定浅色或深色</p></div>
        <FormSelect v-model="themeSetting" :options="themeOptions" aria-label="外观主题" class="appearance-select" />
      </header>
    </section>

    <nav class="settings-menu" aria-label="设置入口">
      <RouterLink to="/me/members"><UsersRound :size="20" /><div><strong>家庭成员</strong><span>{{ app.session.value?.isAdmin ? "成员资料与访问权限" : "添加和管理自己的成员" }}</span></div><ChevronRight :size="18" /></RouterLink>
      <RouterLink v-if="app.session.value?.provider === 'local' && app.session.value?.isAdmin" to="/me/account-security"><KeyRound :size="20" /><div><strong>账号安全</strong><span>管理本地账号与密码</span></div><ChevronRight :size="18" /></RouterLink>
      <RouterLink to="/me/duplicates"><GitMerge :size="20" /><div><strong>重复报告检测</strong><span>手动扫描并合并或删除重复报告</span></div><ChevronRight :size="18" /></RouterLink>
      <RouterLink to="/me/trash"><Trash2 :size="20" /><div><strong>回收站</strong><span>恢复或永久删除已移除报告</span></div><ChevronRight :size="18" /></RouterLink>
      <RouterLink to="/me/data"><DatabaseBackup :size="20" /><div><strong>备份与恢复</strong><span>成员清单导出，管理员可完整备份和恢复</span></div><ChevronRight :size="18" /></RouterLink>
      <RouterLink v-if="app.session.value?.isAdmin && ['fnos', 'development'].includes(app.session.value.authMode)" to="/me/storage"><HardDrive :size="20" /><div><strong>存储设置</strong><span>档案位置与存储空间</span></div><ChevronRight :size="18" /></RouterLink>
      <RouterLink v-if="app.session.value?.isAdmin" to="/me/audit"><ClipboardList :size="20" /><div><strong>用户操作日志</strong><span>报告、成员、提醒和维护操作记录</span></div><ChevronRight :size="18" /></RouterLink>
      <RouterLink v-if="app.session.value?.isAdmin" to="/me/ai-audit"><Bot :size="20" /><div><strong>AI 审计</strong><span>调用次数、失败、耗时和 Token 消耗</span></div><ChevronRight :size="18" /></RouterLink>
      <RouterLink v-if="app.session.value?.isAdmin" to="/me/system-logs"><ScrollText :size="20" /><div><strong>系统日志</strong><span>运行异常、日志占用与清理</span></div><ChevronRight :size="18" /></RouterLink>
      <RouterLink v-if="app.session.value?.isAdmin" to="/me/maintenance"><Wrench :size="20" /><div><strong>维护工具</strong><span>PDF 高清图与指标趋势整理</span></div><ChevronRight :size="18" /></RouterLink>
      <RouterLink v-if="app.session.value?.isAdmin" to="/me/runtime"><ServerCog :size="20" /><div><strong>运行与识别</strong><span>OCR 环境、端口与任务队列</span></div><ChevronRight :size="18" /></RouterLink>
      <RouterLink v-if="app.session.value?.isAdmin" to="/me/ai"><Bot :size="20" /><div><strong>AI 解析模型</strong><span>模型地址、密钥与视觉增强</span></div><ChevronRight :size="18" /></RouterLink>
      <RouterLink to="/me/about"><Info :size="20" /><div><strong>关于</strong><span>应用版本、运行环境与源代码</span></div><ChevronRight :size="18" /></RouterLink>
      <button v-if="app.session.value?.provider === 'local'" type="button" class="settings-menu-action danger-menu-action" @click="app.logout">
        <LogOut :size="20" /><div><strong>退出登录</strong><span>结束当前本地账号会话</span></div><ChevronRight :size="18" />
      </button>
    </nav>

    <MemberSwitcher :open="memberSheetOpen" @close="memberSheetOpen = false" />
  </section>
</template>
