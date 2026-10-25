<script setup lang="ts">
import { useRouter } from "vue-router";
import { onBeforeUnmount, ref, watch } from "vue";
import { BellRing, CheckCircle2 } from "@lucide/vue";
import ReminderInbox from "../components/ReminderInbox.vue";
import {healthRecordPath} from "../utils/health-record-navigation";
import PullIndicator from "../components/PullIndicator.vue";
import { request } from "../utils/api";
import { formatDatabaseTime } from "../utils/time";
import type { AppNotification } from "../types/api";
import { useAppContext } from "../composables/useAppContext";
import { usePullRefresh } from "../composables/usePullRefresh";
import { useRefreshOnActivate } from "../composables/useRefreshOnActivate";
import { useToast } from "../composables/useToast";

const app = useAppContext();
const router = useRouter();
const loading = ref(true);
const error = ref("");
const notifications = ref<AppNotification[]>([]);
const followups = ref<InstanceType<typeof ReminderInbox> | null>(null);
let requestVersion=0;
onBeforeUnmount(()=>{requestVersion++;});

function openReport(reportId: string | null) {
  if (!reportId) return;
  void router.push({path:healthRecordPath('report',reportId),query:{returnTo:'/reminders'}});
}

async function load(memberId: string, silent = false) {
  const current=++requestVersion;
  if (!silent) loading.value = true;
  error.value = "";
  try {
    const nextNotifications=await request<AppNotification[]>(memberId ? `notifications?memberId=${encodeURIComponent(memberId)}` : 'notifications');
    if(current!==requestVersion||memberId!==app.selectedMemberId.value)return false;
    notifications.value = nextNotifications.filter(item => item.type !== "feedback_updated" || app.session.value?.isAdmin);
    return true;
  } catch(cause) {
    if(current===requestVersion)error.value=cause instanceof Error?cause.message:'通知加载失败';
    return false;
  } finally {
    if(current===requestVersion){if(!silent)loading.value=false;void app.refreshReminderCount(memberId);}
  }
}

function notificationMeta(item: AppNotification) {
  if (item.type === "feedback_updated") return { label: "反馈更新", chip: "chip--amber" };
  if (item.type === "report_failed") return { label: "处理失败", chip: "chip--red" };
  if (item.severity === "warning") return { label: "需要注意", chip: "chip--amber" };
  return { label: "处理完成", chip: "chip--green" };
}

const actionPendingId = ref('');

function reloadReminders() {
  const memberId = app.selectedMemberId.value;
  void load(memberId, true);
  void followups.value?.refresh();
}

useRefreshOnActivate(reloadReminders);

async function setNotificationStatus(item: AppNotification, status: AppNotification["status"]) {
  const memberId = app.selectedMemberId.value;
  if (actionPendingId.value) return;
  actionPendingId.value = item.id;
  try {
    await request(`notifications/${encodeURIComponent(item.id)}`, {
      method: "PUT",
      body: JSON.stringify({ status })
    });
    if(memberId!==app.selectedMemberId.value)return;
    await load(memberId, true);
    toast.show("通知已归档");
  } catch (cause) {
    toast.show(cause instanceof Error ? cause.message : "操作失败，请稍后重试");
  } finally {
    actionPendingId.value = "";
  }
}

async function openFeedback(item: AppNotification) {
  if (!app.session.value?.isAdmin || !item.feedbackNumber || actionPendingId.value) return;
  actionPendingId.value = item.id;
  try {
    if (item.status === 'unread') await request(`notifications/${encodeURIComponent(item.id)}`, {
      method: 'PUT', body: JSON.stringify({ status: 'read' })
    });
    await app.refreshReminderCount();
    await router.push({ path: '/me/feedback', query: { feedback: item.feedbackNumber } });
  } catch (cause) { toast.show(cause instanceof Error ? cause.message : '打开反馈失败，请稍后重试'); }
  finally { actionPendingId.value = ''; }
}

const root = ref<HTMLElement | null>(null);
const toast = useToast();
const { pullDistance, refreshing } = usePullRefresh(root, async () => {
  const memberId = app.selectedMemberId.value;
  try {
    const results=await Promise.all([load(memberId, true),followups.value?.refresh()]);
    if(memberId===app.selectedMemberId.value)toast.show(results.some(value=>value===false)?"刷新失败，请稍后重试":"已是最新数据");
  } catch {
    toast.show("刷新失败，请稍后重试");
  }
});

watch(() => app.selectedMemberId.value, (memberId) => {
  notifications.value=[];
  load(memberId).catch(() => {});
}, { immediate: true });
</script>

<template>
  <section ref="root" class="plain-page">
    <div class="page-intro">
      <div><h2>提醒与通知</h2><p>查看报告处理、复查提醒和反馈进度更新</p></div>
    </div>
    <PullIndicator :distance="pullDistance" :refreshing="refreshing" />
    <ReminderInbox v-if="app.selectedMemberId.value" ref="followups" :member-id="app.selectedMemberId.value" />
    <p v-if="error" class="inline-panel-error">{{ error }}</p>
    <div v-if="loading" class="loading-list"><span v-for="index in 3" :key="index"></span></div>
    <div v-if="!loading && notifications.length" class="data-list reminder-list notification-list">
      <article v-for="item in notifications" :key="item.id" :class="{ unread: item.status === 'unread' }">
        <div class="reminder-card-head">
          <span class="item-icon"><BellRing :size="19" /></span>
          <div class="reminder-card-main">
            <strong>{{ item.title }}</strong>
            <span>{{ formatDatabaseTime(item.createdAt) }} · {{ item.type === "feedback_updated" ? `反馈 ${item.feedbackNumber}` : item.reportTitle || "关联报告" }}</span>
            <small v-if="item.message">{{ item.message }}</small>
          </div>
        </div>
        <div class="reminder-card-footer">
          <span class="chip status-label" :class="notificationMeta(item).chip">{{ notificationMeta(item).label }}</span>
          <div class="row-actions">
            <button v-if="item.type === 'feedback_updated' && app.session.value?.isAdmin" type="button" :disabled="actionPendingId === item.id" @click="openFeedback(item)">查看反馈</button>
            <button v-if="item.reportId" type="button" @click="openReport(item.reportId)">查看报告</button>
            <button type="button" :disabled="actionPendingId === item.id" @click="setNotificationStatus(item, 'archived')"><CheckCircle2 :size="15" />知道了</button>
          </div>
        </div>
      </article>
    </div>
  </section>
</template>
