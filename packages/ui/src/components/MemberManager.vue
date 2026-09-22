<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { Eye, EyeOff, Pencil, Plus, ShieldCheck, Trash2, UserRound, UsersRound, X } from "@lucide/vue";
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
  shared: "共享档案", self: "本人", spouse: "配偶", child: "子女", parent: "父母", sibling: "兄弟姐妹", other: "其他"
};
const sexLabels: Record<string, string> = { male: "男", female: "女", unknown: "未知" };
const editorOpen = ref(false);
const accessOpen = ref(false);
const editingId = ref("");
const saving = ref(false);
const error = ref("");
const accessUsers = ref<Array<Pick<AccessUser, "id" | "displayName">>>([]);
const memberAccess = ref<MemberAccess[]>([]);
const accessMember = ref<HealthMember | null>(null);
const selectedMemberIds = ref<string[]>([]);
const scopeLoading = ref(false);
const scopePermissions = ref<Record<string, MemberAccess[]>>({});
const sharingMembers = computed(() => app.allMembers.value.filter(member => member.permission === "manager" && member.canManageSharing));
const batchUserId = ref("");
const batchPermission = ref("viewer");
const batchSharing = ref(false);
const scopeLabel = computed(() => sharingMembers.value.filter(member => selectedMemberIds.value.includes(member.id)).map(member => member.displayName).join("、"));
let scopeRequest = 0;
async function changeScope() {
  const sequence = ++scopeRequest;
  scopeLoading.value = true;
  error.value = "";
  try {
    const entries = await Promise.all(selectedMemberIds.value.map(async id => [id, await request<MemberAccess[]>(`members/${id}/permissions`)] as const));
    if (sequence !== scopeRequest) return;
    scopePermissions.value = Object.fromEntries(entries);
    memberAccess.value = entries.length === 1 ? entries[0][1] : [];
  } catch (cause) {
    if (sequence === scopeRequest) {
      scopePermissions.value = {};
      error.value = cause instanceof Error ? cause.message : "权限加载失败";
    }
  } finally { if (sequence === scopeRequest) scopeLoading.value = false; }
}
async function saveBatchPermission() {
  if (saving.value || scopeLoading.value || !batchUserId.value || selectedMemberIds.value.length < 2) return;
  const members = selectedMemberIds.value.map(memberId => ({memberId, version: scopePermissions.value[memberId]?.[0]?.version}));
  if (members.some(member => member.version === undefined)) return;
  const userId = batchUserId.value;
  const permission = batchPermission.value;
  const canManageSharing = permission === "manager" && batchSharing.value;
  const accountName = accessUsers.value.find(account => account.id === userId)?.displayName || "";
  confirmDialog.ask({
    title: "确认设置所选成员的共享权限",
    message: `将「${scopeLabel.value}」共 ${members.length} 位成员对「${accountName}」的权限统一设为${permission === "manager" ? "管理（可上传、修改和删除报告）" : permission === "viewer" ? "仅查看" : "无权限"}${canManageSharing ? "，并允许再次共享" : "，不允许再次共享"}。会覆盖该账号在所选成员上的原权限，未选成员不受影响。`,
    confirmText: "确认设置",
    run: async () => {
      saving.value = true; error.value = "";
      try {
        await request("members/permissions", {method:"PUT",body:JSON.stringify({userId,permission:permission || null,canManageSharing,members})});
        accessOpen.value = false;
        await app.refreshMembers();
      } catch (cause) { error.value = cause instanceof Error ? cause.message : "授权失败"; }
      finally { saving.value = false; }
    }
  });
}
const form = ref({ displayName: "", relationship: "child", birthDate: "", sex: "", bloodTypeAbo: "", bloodTypeRh: "" });
const showHidden=ref(false);
const displayedMembers=computed(()=>app.allMembers.value.filter(member=>Boolean(member.hidden)===showHidden.value));
async function toggleHidden(member:HealthMember) {
 confirmDialog.ask({title:member.hidden?'取消隐藏':'仅对我隐藏',message:'仅从你的常用列表隐藏，不会删除报告，也不会影响其他账号。',confirmText:'确认',run:async()=>{await request(`members/${member.id}/preferences`,{method:'PUT',body:JSON.stringify({hidden:!member.hidden})});await app.refreshMembers();}});
}
async function skipSelf() {await request('account/preferences',{method:'PUT',body:JSON.stringify({selfProfileChoice:'skipped'})});await app.refreshMembers();}
async function selectSelf(member:HealthMember) {
 confirmDialog.ask({title:'确认本人档案',message:`将 ${member.displayName} 关联为当前账号的本人档案，不改变报告或其他账号权限。`,confirmText:'确认',run:async()=>{await request('account/preferences',{method:'PUT',body:JSON.stringify({selfMemberId:member.id})});await app.refreshMembers();}});
}
const currentYear = new Date().getFullYear();
const editorTitle = computed(() => editingId.value ? "编辑成员" : "添加家庭成员");
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
  return member.permission === "manager";
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
    else await request("members", { method: "POST", body:JSON.stringify({...form.value,createSelf:form.value.relationship==='self'}) });
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
  if (!member.canManageSharing) return;
  error.value = "";
  ++scopeRequest;
  scopeLoading.value = false;
  accessMember.value = member;
  selectedMemberIds.value = [member.id];
  batchUserId.value = "";
  batchPermission.value = "viewer";
  batchSharing.value = false;
  try {
    const [permissions, accounts] = await Promise.all([
      request<MemberAccess[]>(`members/${member.id}/permissions`),
      request<Array<Pick<AccessUser, "id" | "displayName">>>(`members/${member.id}/sharing-accounts`)
    ]);
    memberAccess.value = permissions;
    scopePermissions.value = {[member.id]: permissions};
    accessUsers.value = accounts;
    accessOpen.value = true;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "权限加载失败";
  }
}

function currentPermission(userId: string) {
  return memberAccess.value.find((item) => item.userId === userId)?.permission || "";
}

async function changePermission(userId: string, value: string, sharing=false) {
  if (!accessMember.value || selectedMemberIds.value.length !== 1 || scopeLoading.value || !scopePermissions.value[selectedMemberIds.value[0]]) return;
  if(value==='manager' || sharing || userId===app.session.value?.id) {
    confirmDialog.ask({title:'确认修改共享权限',message:sharing?'允许该账号向其他人共享此成员的全部报告。':value==='manager'?'管理账号可上传、修改和删除报告。':'降低或撤销自己的权限可能无法再次管理该档案。',confirmText:'确认',run:()=>applyPermission(userId,value,sharing)});
    return;
  }
  await applyPermission(userId,value,sharing);
}
async function applyPermission(userId:string,value:string,sharing:boolean) {
  if(!accessMember.value || saving.value || scopeLoading.value || selectedMemberIds.value.length !== 1 || !scopePermissions.value[selectedMemberIds.value[0]]) return;
  saving.value=true;
  try {
    memberAccess.value = await request(`members/${selectedMemberIds.value[0]}/permissions`, {
      method: "PUT",
      body: JSON.stringify({ userId, permission: value || null,canManageSharing:sharing,version:memberAccess.value[0]?.version||0 })
    });
    await app.refreshMembers();
    if(!memberAccess.value.length) accessOpen.value=false;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "授权失败";
  } finally {saving.value=false;}
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
  { value: "", label: "无权限" }, { value: "viewer", label: "仅查看" }, { value: "manager", label: "管理" }
];
</script>

<template>
  <section class="settings-band member-manager">
    <header>
      <UsersRound :size="21" />
      <div><h3>家庭成员</h3><p>管理你有权访问的档案与共享权限</p></div>
      <button class="header-action" type="button" @click="openEditor()"><Plus :size="17" />添加</button>
    </header>
    <p v-if="error && !editorOpen && !accessOpen" class="inline-error">{{ error }}</p>
    <div v-if="!app.preferences.value?.selfMemberId" class="member-self-prompt">
      <div><strong>本人档案，按需创建</strong><p>{{ app.preferences.value?.selfProfileChoice==='pending' ? '有多个历史本人候选，请逐项确认关联；不会自动合并。' : '可以创建新档案，也可以将下方已有档案设为本人。' }}</p></div>
      <div class="member-prompt-actions">
        <button class="sharing-soft-button" type="button" @click="openEditor(); form.relationship='self'">创建我的档案</button>
        <button v-if="app.preferences.value?.selfProfileChoice==='undecided'" class="sharing-text-button" type="button" @click="skipSelf">暂不创建</button>
      </div>
    </div>
    <div class="member-list-toolbar" role="group" aria-label="档案显示范围">
      <button type="button" :aria-pressed="!showHidden" :class="{ active: !showHidden }" @click="showHidden=false">常用档案</button>
      <button type="button" :aria-pressed="showHidden" :class="{ active: showHidden }" @click="showHidden=true">已隐藏档案</button>
    </div>
    <p v-if="!displayedMembers.length" class="member-empty">{{ showHidden ? '没有已隐藏档案' : '暂无可见档案，可添加成员或请家人共享。' }}</p>
    <div class="member-list">
      <article v-for="member in displayedMembers" :key="member.id" class="member-row">
        <span class="member-avatar" aria-hidden="true">{{ member.displayName.slice(0, 1) }}</span>
        <div class="member-summary">
          <strong>{{ member.displayName }}</strong><button class="sharing-text-button member-self-link" v-if="!app.preferences.value?.selfMemberId" type="button" @click="selectSelf(member)">设为本人</button>
          <span>{{ relationshipLabels[member.relationship] || "其他" }}<template v-if="member.birthDate"> · {{ member.birthDate }}</template><template v-if="member.sex"> · {{ sexLabels[member.sex] }}</template><template v-if="bloodTypeLabel(member)"> · {{ bloodTypeLabel(member) }}</template></span>
        </div>
        <span class="permission-label">{{ member.permission === "manager" ? "可管理" : "仅查看" }}</span>
        <div class="member-actions">
          <button type="button" :title="member.hidden ? '取消隐藏' : '仅对我隐藏'" :aria-label="member.hidden ? '取消隐藏' : '仅对我隐藏'" @click="toggleHidden(member)"><Eye v-if="member.hidden" :size="18" /><EyeOff v-else :size="18" /></button>
          <button v-if="member.canManageSharing" type="button" title="访问权限" @click="openAccess(member)"><ShieldCheck :size="18" /></button>
          <button v-if="canManageMember(member)" type="button" title="编辑成员" @click="openEditor(member)"><Pencil :size="17" /></button>
          <button v-if="member.relationship !== 'self' && !member.isSelf && member.canManageSharing" class="danger-action" type="button" title="删除成员" @click="removeMember(member)"><Trash2 :size="17" /></button>
        </div>
      </article>
    </div>
  </section>

  <div v-if="editorOpen" class="modal-backdrop" @click.self="editorOpen = false">
    <section class="modal-panel" role="dialog" aria-modal="true" :aria-label="editorTitle">
      <span class="sheet-grabber" aria-hidden="true"></span>
      <header><div><UserRound :size="20" /><h3>{{ editorTitle }}</h3></div><button type="button" title="关闭" @click="editorOpen = false"><X :size="19" /></button></header>
      <form class="member-form" @submit.prevent="saveMember">
        <label><span>姓名或称呼</span><input id="member-display-name" v-model="form.displayName" maxlength="40" required /></label>
        <div class="form-grid">
          <label><span>家庭关系</span><FormSelect v-model="form.relationship" :options="relationshipOptions" :disabled="Boolean(editingId) && form.relationship === 'self'" aria-label="家庭关系" /></label>
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

  <div v-if="accessOpen" class="modal-backdrop" @click.self="accessOpen = false">
    <section class="modal-panel member-access-modal" role="dialog" aria-modal="true" aria-label="访问权限">
      <span class="sheet-grabber" aria-hidden="true"></span>
      <header><div><ShieldCheck :size="20" /><h3>设置共享权限</h3></div><button type="button" title="关闭" @click="accessOpen = false"><X :size="19" /></button></header>
      <div class="sharing-scope">
        <p>成员范围 · 已选 {{ selectedMemberIds.length }} 位</p>
        <div class="sharing-member-options">
          <label v-for="member in sharingMembers" :key="member.id"><input v-model="selectedMemberIds" type="checkbox" :value="member.id" :disabled="saving || scopeLoading" @change="changeScope" /><span>{{ member.displayName }}{{ member.hidden ? '（已隐藏）' : '' }}</span></label>
        </div>
        <span>仅对所选成员设置权限，包含各自全部历史及后续报告、原件与趋势；未选成员不受影响。</span>
      </div>
      <div class="sharing-account-heading"><h4>账号授权</h4><p>选择账号并授予权限。仅列出当前登录方式下可用的应用账号。</p></div>
      <div class="sharing-role-guide"><span><strong>仅查看</strong> · 浏览报告与趋势</span><span><strong>管理</strong> · 可上传、修改和删除报告</span></div>
      <p v-if="scopeLoading" class="member-empty" role="status">正在加载所选成员权限…</p>
      <p v-else-if="!selectedMemberIds.length" class="member-empty">请至少选择一位成员。</p>
      <form v-else-if="selectedMemberIds.length > 1" class="member-form" @submit.prevent="saveBatchPermission">
        <label><span>接收账号</span><FormSelect v-model="batchUserId" :options="accessUsers.map(user => ({value:user.id,label:user.displayName}))" placeholder="请选择账号" aria-label="接收账号" :disabled="saving" /></label>
        <label><span>统一设置权限</span><FormSelect v-model="batchPermission" :options="permissionOptions" aria-label="批量权限" :disabled="saving" /></label>
        <label v-if="batchPermission === 'manager'" class="sharing-batch-delegation"><input v-model="batchSharing" type="checkbox" :disabled="saving" />允许管理共享（可向其他账号授权）</label>
        <p class="sharing-batch-note">将覆盖接收账号在所选成员上的原权限。提交前会再次确认；任一成员校验失败，整批不生效。</p>
        <div class="form-actions"><button class="primary-button" type="submit" :disabled="saving || !batchUserId || selectedMemberIds.some(id => !scopePermissions[id])">设置 {{ selectedMemberIds.length }} 位成员的权限</button></div>
      </form>
      <div v-else class="access-list">
        <p v-if="!accessUsers.length" class="member-empty">暂无可用账号，请对方先登录本应用。</p>
        <article v-for="user in accessUsers" :key="user.id">
          <span class="member-avatar small" aria-hidden="true">{{ user.displayName.slice(0, 1) }}</span>
          <div><strong>{{ user.displayName }}</strong><span>{{ currentPermission(user.id) ? "已共享" : "尚未共享" }}</span></div>
          <FormSelect
            v-if="currentPermission(user.id)"
            :model-value="currentPermission(user.id)"
            :options="permissionOptions"
            :aria-label="`${user.displayName}的权限`"
            class="access-select"
            :disabled="saving"
            @change="changePermission(user.id, $event)"
          />
          <button v-else class="sharing-soft-button" :disabled="saving" @click="changePermission(user.id,'viewer')">共享为仅查看</button>
          <label class="sharing-delegation" v-if="currentPermission(user.id)==='manager'"><input type="checkbox" :disabled="saving" :checked="Boolean(memberAccess.find(item=>item.userId===user.id)?.canManageSharing)" @change="changePermission(user.id,'manager',($event.target as HTMLInputElement).checked)" /><span><strong>允许管理共享</strong><small>可向其他账号授权或撤销访问</small></span></label>

        </article>
      </div>
      <p v-if="error" class="inline-error" role="alert">{{ error }}</p>
    </section>
  </div>
</template>
