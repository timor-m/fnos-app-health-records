import { computed, readonly, ref, shallowRef, watch, type Ref } from "vue";
import { ApiRequestError, request } from "../utils/api";
import { readStorage, writeStorage } from "../utils/storage";
import type { AppNotification, HealthMember, Reminder, Session } from "../types/api";

const loading = ref(true);
const error = ref("");
const repairError = ref("");
const repairingSchema = ref(false);
const session = ref<Session | null>(null);
const members = ref<HealthMember[]>([]);
const selectedMemberId = ref("");
const allMembers = ref<HealthMember[]>([]);
const preferences = ref<{selfMemberId:string|null;selfProfileChoice:string;defaultMemberId:string|null}|null>(null);
let memberRequest=0;
let loadRequest=0;
const identityKey=()=>`${session.value?.authMode}:${session.value?.id}`;
const selectionKey=()=>`health-records:selected-member:${identityKey()}`;
const selectedMember = computed(() => members.value.find((member) => member.id === selectedMemberId.value) || null);
const topbarSubtitles = ref<Record<string, string>>({});
export type TopbarSearchConfig = {
  key: string;
  model: Ref<string>;
  placeholder: string;
  expandedPlaceholder?: string;
  submit?: () => void;
};
const topbarSearch = shallowRef<TopbarSearchConfig | null>(null);
const pendingReminderCount = ref(0);
/* 数据变更信号：上传完成、后台任务跑完等场景递增，各页面据此静默刷新缓存数据 */
const dataVersion = ref(0);
const accessVersion=ref(0);
type SchemaMaintenance = {
  databaseVersion: number;
  supportedVersion: number;
};
const schemaMaintenance = ref<SchemaMaintenance | null>(null);

function maintenanceFromError(cause: unknown): SchemaMaintenance | null {
  if (!(cause instanceof ApiRequestError) || cause.status !== 503) return null;
  const maintenance = cause.meta?.maintenance;
  if (!maintenance || typeof maintenance !== "object") return null;
  const databaseVersion = Reflect.get(maintenance, "databaseVersion");
  const supportedVersion = Reflect.get(maintenance, "supportedVersion");
  if (!Number.isInteger(databaseVersion) || !Number.isInteger(supportedVersion)) return null;
  return { databaseVersion: Number(databaseVersion), supportedVersion: Number(supportedVersion) };
}
function notifyDataChanged() {
  dataVersion.value += 1;
}

watch(selectedMemberId, (value) => {
  if (value) writeStorage(selectionKey(), value);
  void refreshReminderCount(value);
});

async function refreshReminderCount(memberId = selectedMemberId.value) {
  if (!session.value?.authenticated || !memberId) {
    pendingReminderCount.value = 0;
    return;
  }
  try {
    const [reminders, notifications] = await Promise.all([
      request<Reminder[]>(`reminders?memberId=${encodeURIComponent(memberId)}`),
      request<AppNotification[]>(`notifications?memberId=${encodeURIComponent(memberId)}`)
    ]);
    if(memberId!==selectedMemberId.value) return;
    pendingReminderCount.value = reminders.filter((item) => item.status === "pending").length
      + notifications.filter((item) => item.status === "unread").length;
  } catch (cause) {
    pendingReminderCount.value = 0;
    console.warn("[health-records] 提醒计数刷新失败", cause);
  }
}

async function refreshMembers() {
  const sequence=++memberRequest; const identity=identityKey();
  const [result,prefs]=await Promise.all([request<HealthMember[]>('members'),request<NonNullable<typeof preferences.value>>('account/preferences')]);
  if(sequence!==memberRequest || identity!==identityKey()) return;
  if(JSON.stringify(result.map(m=>[m.id,m.permission,m.canManageSharing,m.hidden]))!==JSON.stringify(allMembers.value.map(m=>[m.id,m.permission,m.canManageSharing,m.hidden]))) accessVersion.value++;
  allMembers.value=result;preferences.value=prefs;
  members.value=result.filter(member=>!member.hidden);
  if(!members.value.some(member=>member.id===selectedMemberId.value)) {
    const remembered=readStorage(selectionKey());
    selectedMemberId.value=members.value.find(member=>member.id===remembered)?.id || members.value.find(member=>member.id===prefs.defaultMemberId)?.id || members.value[0]?.id || '';
  }
  await refreshReminderCount();
}

async function load() {
  const sequence=++loadRequest;
  ++memberRequest;
  loading.value = true;
  members.value=[]; allMembers.value=[]; preferences.value=null; selectedMemberId.value="";
  topbarSearch.value=null; topbarSubtitles.value={}; pendingReminderCount.value=0;
  error.value = "";
  schemaMaintenance.value = null;
  try {
    const nextSession=await request<Session>("session");
    if(sequence!==loadRequest) return;
    session.value=nextSession;
    if (session.value.authenticated && !session.value.mustChangePassword) {
      await refreshMembers();
    } else {
      members.value = [];
      selectedMemberId.value = "";
    }
  } catch (cause) {
    schemaMaintenance.value = maintenanceFromError(cause);
    if (!schemaMaintenance.value) {
      error.value = cause instanceof Error ? cause.message : "加载失败";
    }
  } finally {
    if(sequence===loadRequest) loading.value = false;
  }
}

async function logout() {
  await request("auth/logout", { method: "POST" });
  session.value = null;
  members.value = [];
  selectedMemberId.value = "";
  await load();
}

async function repairUnreleasedSchema() {
  if (!schemaMaintenance.value || repairingSchema.value) return;
  repairingSchema.value = true;
  repairError.value = "";
  try {
    await request("maintenance/repair-unreleased-schema", { method: "POST" });
    await load();
  } catch (cause) {
    repairError.value = cause instanceof Error ? cause.message : "数据库适配失败";
  } finally {
    repairingSchema.value = false;
  }
}

export function useAppContext() {
  return {
    loading: readonly(loading),
    error: readonly(error),
    repairError: readonly(repairError),
    repairingSchema: readonly(repairingSchema),
    schemaMaintenance: readonly(schemaMaintenance),
    session: readonly(session),
    members: readonly(members),
    allMembers: readonly(allMembers),
    preferences: readonly(preferences),
    selectedMemberId,
    selectedMember,
    topbarSubtitles: readonly(topbarSubtitles),
    topbarSearch: readonly(topbarSearch),
    pendingReminderCount: readonly(pendingReminderCount),
    dataVersion: readonly(dataVersion),
    accessVersion: readonly(accessVersion),
    notifyDataChanged,
    setTopbarSubtitle: (key: string, value: string) => {
      topbarSubtitles.value = { ...topbarSubtitles.value, [key]: value };
    },
    clearTopbarSubtitle: (key: string) => {
      if (!(key in topbarSubtitles.value)) return;
      const next = { ...topbarSubtitles.value };
      delete next[key];
      topbarSubtitles.value = next;
    },
    setTopbarSearch: (value: TopbarSearchConfig) => {
      topbarSearch.value = value;
    },
    setTopbarSearchValue: (value: string) => {
      if (topbarSearch.value) topbarSearch.value.model.value = value;
    },
    clearTopbarSearch: (key: string) => {
      if (topbarSearch.value?.key === key) topbarSearch.value = null;
    },
    setPendingReminderCount: (value: number) => {
      pendingReminderCount.value = Math.max(0, Math.round(value));
    },
    refreshMembers,
    refreshReminderCount,
    repairUnreleasedSchema,
    logout,
    load
  };
}

if(typeof window!=='undefined') {
 let refreshing=false;
 const refresh=async()=>{
  if(refreshing || loading.value || !session.value?.authenticated) return;
  refreshing=true;
  try {
   const current=await request<Session>('session');
   if(current.id!==session.value?.id || !current.authenticated) await load();
   else await refreshMembers();
  } catch { members.value=[];allMembers.value=[];selectedMemberId.value=''; }
  finally {refreshing=false;}
 };
 window.addEventListener('focus',()=>void refresh());
 window.addEventListener('health-access-denied',()=>void refresh());
}
