import { createRouter, createWebHistory } from "vue-router";
import OverviewPage from "./pages/OverviewPage.vue";
import RecordsPage from "./pages/RecordsPage.vue";
import TrendsPage from "./pages/TrendsPage.vue";
import MorphologyTrendsPage from "./pages/MorphologyTrendsPage.vue";
import UploadPage from "./pages/UploadPage.vue";
import RemindersPage from "./pages/RemindersPage.vue";
import SettingsPage from "./pages/SettingsPage.vue";
import MembersSettingsPage from "./pages/settings/MembersSettingsPage.vue";
import RuntimeSettingsPage from "./pages/settings/RuntimeSettingsPage.vue";
import StorageSettingsPage from './pages/settings/StorageSettingsPage.vue';
import AiSettingsPage from "./pages/settings/AiSettingsPage.vue";
import TrashSettingsPage from "./pages/settings/TrashSettingsPage.vue";
import DataAuditSettingsPage from "./pages/settings/DataAuditSettingsPage.vue";
import DuplicatesSettingsPage from "./pages/settings/DuplicatesSettingsPage.vue";
import MaintenanceSettingsPage from "./pages/settings/MaintenanceSettingsPage.vue";
import IndicatorManagementSettingsPage from "./pages/settings/IndicatorManagementSettingsPage.vue";
import IndicatorIssuesSettingsPage from "./pages/settings/IndicatorIssuesSettingsPage.vue";
import IndicatorDictionarySettingsPage from "./pages/settings/IndicatorDictionarySettingsPage.vue";
import UserAuditSettingsPage from "./pages/settings/UserAuditSettingsPage.vue";
import AiAuditSettingsPage from "./pages/settings/AiAuditSettingsPage.vue";
import SystemLogsSettingsPage from "./pages/settings/SystemLogsSettingsPage.vue";
import AboutSettingsPage from "./pages/settings/AboutSettingsPage.vue";
import AccountSecuritySettingsPage from "./pages/settings/AccountSecuritySettingsPage.vue";
import { useAppContext } from "./composables/useAppContext";

const base = import.meta.env.BASE_URL.endsWith("/") ? import.meta.env.BASE_URL : `${import.meta.env.BASE_URL}/`;

const router = createRouter({
  history: createWebHistory(base),
  routes: [
    { path: "/", redirect: "/overview" },
    { path: "/overview", component: OverviewPage, meta: { title: "概览", subtitle: "报告、提醒和趋势摘要" } },
    { path: "/records", component: RecordsPage, meta: { title: "档案" } },
    { path: "/trends", component: TrendsPage, meta: { title: "趋势" } },
    { path: "/trends/morphology", component: MorphologyTrendsPage, meta: { title: "形态变化", subtitle: "追踪历次形态变化" } },
    { path: "/upload", component: UploadPage, meta: { title: "上传报告", subtitle: "拍照或上传 PDF，自动识别归档" } },
    { path: "/reminders", component: RemindersPage, meta: { title: "提醒", subtitle: "集中处理即将到期的健康事项" } },
    { path: "/me", component: SettingsPage, meta: { title: "我的", subtitle: "账号、成员与识别服务" } },
    { path: "/me/members", component: MembersSettingsPage, meta: { title: "家庭成员" } },
    { path: "/me/trash", component: TrashSettingsPage, meta: { title: "回收站" } },
    { path: "/me/duplicates", component: DuplicatesSettingsPage, meta: { title: "重复报告检测" } },
    { path: "/me/data", component: DataAuditSettingsPage, meta: { title: "备份与恢复" } },
    { path: "/me/account-security", component: AccountSecuritySettingsPage, meta: { title: "账号安全", requiresLocalAccount: true, requiresAdmin: true } },
    { path: "/me/audit", component: UserAuditSettingsPage, meta: { title: "用户操作日志", requiresAdmin: true } },
    { path: "/me/ai-audit", component: AiAuditSettingsPage, meta: { title: "AI 审计", requiresAdmin: true } },
    { path: "/me/system-logs", component: SystemLogsSettingsPage, meta: { title: "系统日志", requiresAdmin: true } },
    { path: "/me/maintenance", component: MaintenanceSettingsPage, meta: { title: "维护工具", requiresAdmin: true } },
    { path: '/me/storage', component: StorageSettingsPage, meta: { title: '存储设置', requiresAdmin: true, requiresArchiveStorage: true } },
    { path: "/me/maintenance/indicators", component: IndicatorManagementSettingsPage, meta: { title: "指标管理", requiresAdmin: true } },
    { path: "/me/maintenance/indicator-issues", component: IndicatorIssuesSettingsPage, meta: { title: "指标问题池", requiresAdmin: true } },
    { path: "/me/maintenance/indicator-dictionary", component: IndicatorDictionarySettingsPage, meta: { title: "指标字典", requiresAdmin: true } },
    { path: "/me/runtime", component: RuntimeSettingsPage, meta: { title: "运行与识别", requiresAdmin: true } },
    { path: "/me/ai", component: AiSettingsPage, meta: { title: "AI 解析模型", requiresAdmin: true } },
    { path: "/me/about", component: AboutSettingsPage, meta: { title: "关于" } },
    { path: "/settings", redirect: "/me" },
    { path: "/:pathMatch(.*)*", redirect: "/overview" }
  ]
});

router.beforeEach(async (to) => {
  const app = useAppContext();
  if (!app.session.value) await app.load();
  if (to.meta.requiresArchiveStorage && !['fnos', 'development'].includes(app.session.value?.authMode || '')) return '/me';
  if (to.meta.requiresLocalAccount && app.session.value?.provider !== "local") return "/me";
  if (!to.meta.requiresAdmin) return true;
  if (app.session.value?.isAdmin) return true;
  return "/me";
});

export default router;
