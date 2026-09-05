<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { Pencil, Plus, ShieldCheck, Trash2, UserRound, UsersRound, X } from "@lucide/vue";
import { useAppContext } from "../composables/useAppContext";
import { useConfirm } from "../composables/useConfirm";
import { useScrollLock } from "../composables/useScrollLock";
import DateTimePicker from "./DateTimePicker.vue";
import FormSelect from "./FormSelect.vue";
import type { AccessUser, HealthMember, MemberAccess } from "../types/api";
import { request } from "../utils/api";

const app = useAppContext();
const confirmDialog = useConfirm();
const relationshipLabels: Record<string, string> = {
  self: "本人", spouse: "配偶", child: "子女", parent: "父母", sibling: "兄弟姐妹", other: "其他"
};
const sexLabels: Record<string, string> = { male: "男", female: "女", unknown: "未知" };
const editorOpen = ref(false);
const accessOpen = ref(false);
const editingId = ref("");
const saving = ref(false);
const error = ref("");
const accessUsers = ref<AccessUser[]>([]);
const memberAccess = ref<MemberAccess[]>([]);
const accessMember = ref<HealthMember | null>(null);
const form = ref({ displayName: "", relationship: "child", birthDate: "", sex: "", bloodTypeAbo: "", bloodTypeRh: "" });
const currentYear = new Date().getFullYear();
const editorTitle = computed(() => editingId.value ? "编辑成员" : "添加家庭成员");
const isAdmin = computed(() => Boolean(app.session.value?.isAdmin));
useScrollLock(computed(() => editorOpen.value || accessOpen.value));

function onModalKeydown(event: KeyboardEvent) {
  if (event.key !== "Escape") return;
  if (accessOpen.value) accessOpen.value = false;
  else if (editorOpen.value) editorOpen.value = false;
}
watch([editorOpen, accessOpen], ([editor, access]) => {
  if (editor || access) window.addEventListener("keydown", onModalKeydown);
  else window.removeEventListener("keydown", onModalKeydown);
});
onBeforeUnmount(() => window.removeEventListener("keydown", onModalKeydown));

function canManageMember(member: HealthMember) {
  return isAdmin.value || member.permission === "manager";
}

function resetForm(member?: HealthMember) {
  editingId.value = member?.id || "";
  form.value = {
    displayName: member?.displayName || "",
    relationship: member?.relationship === "self" ? "self" : member?.relationship || "child",
    birthDate: member?.birthDate || "",
    sex: member?.sex || "",
    bloodTypeAbo: member?.bloodTypeAbo || "",
    bloodTypeRh: member?.bloodTypeRh || ""
  };
  error.value = "";
}

function bloodTypeLabel(member: HealthMember) {
  const abo = member.bloodTypeAbo ? `${member.bloodTypeAbo} 型` : "";
  const rh =
    member.bloodTypeRh === "positive" ? "Rh 阳性" :
    member.bloodTypeRh === "negative" ? "Rh 阴性" : "";
  return [abo, rh].filter(Boolean).join(" · ");
}

async function openEditor(member?: HealthMember) {
  resetForm(member);
  editorOpen.value = true;
  await nextTick();
  document.querySelector<HTMLInputElement>("#member-display-name")?.focus();
}

async function saveMember() {
  saving.value = true;
  error.value = "";
  try {
    const body = JSON.stringify(form.value);
    if (editingId.value) await request(`members/${editingId.value}`, { method: "PUT", body });
    else await request("members", { method: "POST", body });
    await app.refreshMembers();
    editorOpen.value = false;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "保存失败";
  } finally {
    saving.value = false;
  }
}

async function removeMember(member: HealthMember) {
  confirmDialog.ask({
    title: "删除家庭成员",
    message: `确认删除 ${member.displayName} 的家庭成员档案？已有数据会保留但不再显示。`,
    confirmText: "删除",
    danger: true,
    run: async () => {
      try {
        await request(`members/${member.id}`, { method: "DELETE" });
        await app.refreshMembers();
      } catch (cause) {
        error.value = cause instanceof Error ? cause.message : "删除失败";
      }
    }
  });
}

async function openAccess(member: HealthMember) {
  if (!isAdmin.value) return;
  error.value = "";
  accessMember.value = member;
  try {
    [accessUsers.value, memberAccess.value] = await Promise.all([
      request<AccessUser[]>("access-users"),
      request<MemberAccess[]>(`members/${member.id}/permissions`)
    ]);
    accessOpen.value = true;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "权限加载失败";
  }
}

function currentPermission(userId: string) {
  return memberAccess.value.find((item) => item.userId === userId)?.permission || "";
}

function providerLabel(providers: string | null) {
  const labels: Record<string, string> = { fnos_gateway: "fnOS 账号", local: "本地账号", development: "开发账号" };
  return (providers || "").split(",").filter(Boolean).map((provider) => labels[provider] || provider).join("、") || "账号";
}

async function changePermission(userId: string, value: string) {
  if (!accessMember.value) return;
  try {
    memberAccess.value = await request(`members/${accessMember.value.id}/permissions`, {
      method: "PUT",
      body: JSON.stringify({ userId, permission: value || null })
    });
    await app.refreshMembers();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "授权失败";
  }
}

const relationshipOptions = [
  { value: "self", label: "本人" }, { value: "spouse", label: "配偶" }, { value: "child", label: "子女" },
  { value: "parent", label: "父母" }, { value: "sibling", label: "兄弟姐妹" }, { value: "other", label: "其他" }
];
const sexOptions = [
  { value: "", label: "未填写" }, { value: "male", label: "男" },
  { value: "female", label: "女" }, { value: "unknown", label: "未知" }
];
const bloodTypeAboOptions = [
  { value: "", label: "未填写" }, { value: "A", label: "A 型" },
  { value: "B", label: "B 型" }, { value: "AB", label: "AB 型" }, { value: "O", label: "O 型" }
];
const bloodTypeRhOptions = [
  { value: "", label: "未填写" }, { value: "positive", label: "Rh 阳性" }, { value: "negative", label: "Rh 阴性" }
];
const permissionOptions = [
  { value: "", label: "无权限" }, { value: "viewer", label: "查看" }, { value: "manager", label: "管理" }
];
</script>

<template>
  <section class="settings-band member-manager">
    <header>
      <UsersRound :size="21" />
      <div><h3>家庭成员</h3><p>{{ isAdmin ? "管理基础资料和账号访问范围" : "添加成员后可为他们上传健康报告" }}</p></div>
      <button class="header-action" type="button" @click="openEditor()"><Plus :size="17" />添加</button>
    </header>
    <p v-if="error && !editorOpen && !accessOpen" class="inline-error">{{ error }}</p>
    <div class="member-list">
      <article v-for="member in app.members.value" :key="member.id" class="member-row">
        <span class="member-avatar" aria-hidden="true">{{ member.displayName.slice(0, 1) }}</span>
        <div class="member-summary">
          <strong>{{ member.displayName }}</strong>
          <span>{{ relationshipLabels[member.relationship] || "其他" }}<template v-if="member.birthDate"> · {{ member.birthDate }}</template><template v-if="member.sex"> · {{ sexLabels[member.sex] }}</template><template v-if="bloodTypeLabel(member)"> · {{ bloodTypeLabel(member) }}</template></span>
        </div>
        <span class="permission-label">{{ member.permission === "manager" ? "可管理" : "仅查看" }}</span>
        <div class="member-actions">
          <button v-if="isAdmin" type="button" title="访问权限" @click="openAccess(member)"><ShieldCheck :size="18" /></button>
          <button v-if="canManageMember(member)" type="button" title="编辑成员" @click="openEditor(member)"><Pencil :size="17" /></button>
          <button v-if="member.relationship !== 'self' && canManageMember(member)" class="danger-action" type="button" title="删除成员" @click="removeMember(member)"><Trash2 :size="17" /></button>
        </div>
      </article>
    </div>
  </section>

  <div v-if="editorOpen" class="modal-backdrop" @mousedown.self="editorOpen = false">
    <section class="modal-panel" role="dialog" aria-modal="true" :aria-label="editorTitle">
      <span class="sheet-grabber" aria-hidden="true"></span>
      <header><div><UserRound :size="20" /><h3>{{ editorTitle }}</h3></div><button type="button" title="关闭" @click="editorOpen = false"><X :size="19" /></button></header>
      <form class="member-form" @submit.prevent="saveMember">
        <label><span>姓名或称呼</span><input id="member-display-name" v-model="form.displayName" maxlength="40" required /></label>
        <div class="form-grid">
          <label><span>家庭关系</span><FormSelect v-model="form.relationship" :options="relationshipOptions" :disabled="form.relationship === 'self'" aria-label="家庭关系" /></label>
          <label><span>性别</span><FormSelect v-model="form.sex" :options="sexOptions" aria-label="性别" /></label>
        </div>
        <div class="form-grid">
          <label><span>ABO 血型</span><FormSelect v-model="form.bloodTypeAbo" :options="bloodTypeAboOptions" aria-label="ABO 血型" /></label>
          <label><span>Rh 血型</span><FormSelect v-model="form.bloodTypeRh" :options="bloodTypeRhOptions" aria-label="Rh 血型" /></label>
        </div>
        <label><span>出生日期</span><DateTimePicker v-model="form.birthDate" :min-year="1900" :max-year="currentYear" aria-label="出生日期" /></label>
        <p v-if="error" class="form-error">{{ error }}</p>
        <div class="form-actions"><button type="button" @click="editorOpen = false">取消</button><button class="primary-button" type="submit" :disabled="saving">{{ saving ? "保存中" : "保存" }}</button></div>
      </form>
    </section>
  </div>

  <div v-if="accessOpen" class="modal-backdrop" @mousedown.self="accessOpen = false">
    <section class="modal-panel" role="dialog" aria-modal="true" aria-label="访问权限">
      <span class="sheet-grabber" aria-hidden="true"></span>
      <header><div><ShieldCheck :size="20" /><h3>{{ accessMember?.displayName }}的访问权限</h3></div><button type="button" title="关闭" @click="accessOpen = false"><X :size="19" /></button></header>
      <div class="access-list">
        <article v-for="user in accessUsers" :key="user.id">
          <span class="member-avatar small" aria-hidden="true">{{ user.displayName.slice(0, 1) }}</span>
          <div><strong>{{ user.displayName }}</strong><span>{{ providerLabel(user.providers) }}{{ user.isAdmin ? " · 管理员" : "" }}</span></div>
          <FormSelect
            :model-value="currentPermission(user.id)"
            :options="permissionOptions"
            :aria-label="`${user.displayName}的权限`"
            class="access-select"
            @change="changePermission(user.id, $event)"
          />
        </article>
        <p v-if="error" class="inline-error">{{ error }}</p>
      </div>
    </section>
  </div>
</template>
