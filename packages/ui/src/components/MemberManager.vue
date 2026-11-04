<script setup lang="ts">
import {useUnsavedRecord} from "../composables/useUnsavedRecord";
import { computed, nextTick, onBeforeUnmount,onActivated,onDeactivated, ref, watch } from "vue";
import { Eye, EyeOff, Pencil, Plus, ShieldCheck, Trash2, UserRound, UsersRound, X } from "@lucide/vue";
import { useAppContext } from "../composables/useAppContext";
import { useConfirm } from "../composables/useConfirm";
import { useScrollLock } from "../composables/useScrollLock";
import DateTimePicker from "./DateTimePicker.vue";
import FormSelect from "./FormSelect.vue";
import type { AccessUser, HealthMember, MemberAccess } from "../types/api";
import { request } from "../utils/api";

const props=defineProps<{editMemberId?:string}>();const emit=defineEmits<{saved:[id:string]}>();
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
type SharingAccount = Pick<AccessUser, "id" | "displayName"> & { username?: string };
const accessUsers = ref<SharingAccount[]>([]);
const accountLabel = (user: SharingAccount) => user.username ? `${user.displayName}（${user.username}）` : user.displayName;
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
  const account = accessUsers.value.find(account => account.id === userId);
  const accountName = account ? accountLabel(account) : "";
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
const form = ref({ displayName: "", relationship: "child", birthDate: "", sex: "", bloodTypeAbo: "", bloodTypeRh: "",careAllergies:"",careHistory:"",careMedications:"",careBackgroundVersion:"" });
const memberLeave=useUnsavedRecord(()=>editorOpen.value?JSON.stringify(form.value):'',saving);let editorGeneration=0,requestedMember='';
async function closeEditor(){if(await memberLeave.confirmLeave()){editorOpen.value=false;editorGeneration++;memberLeave.reset();}}
function openRequested(){const id=props.editMemberId;if(!id||id===requestedMember)return;const member=app.allMembers.value.find(m=>m.id===id&&m.permission==='manager');if(member){requestedMember=id;void openEditor(member,true);}}
watch(()=>[props.editMemberId,app.allMembers.value],()=>{openRequested();if(editorOpen.value&&editingId.value&&!app.allMembers.value.some(m=>m.id===editingId.value&&m.permission==='manager')){editorOpen.value=false;editorGeneration++;memberLeave.reset();}},{immediate:true});
onActivated(()=>{requestedMember='';openRequested();});onDeactivated(()=>{editorOpen.value=false;editorGeneration++;memberLeave.reset();});
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
  if (event.key !== "Escape" || confirmDialog.state.value || saving.value) return;
  if (accessOpen.value) closeAccess();
  else if (editorOpen.value) void closeEditor();
}
watch([editorOpen, accessOpen], ([editor, access]) => {
  if (editor || access) window.addEventListener("keydown", onModalKeydown);
  else window.removeEventListener("keydown", onModalKeydown);
});
onBeforeUnmount(() => { ++editorGeneration;++scopeRequest; window.removeEventListener("keydown", onModalKeydown); });
function closeAccess() {
  if (saving.value || confirmDialog.state.value) return;
  ++scopeRequest;
  accessOpen.value = false;
  scopeLoading.value = false;
}

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
    bloodTypeRh: member?.bloodTypeRh || "",careAllergies:member?.careAllergies||"",careHistory:member?.careHistory||"",careMedications:member?.careMedications||"",careBackgroundVersion:member?.careBackgroundVersion||""
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

async function openEditor(member?: HealthMember,background=false) {
  editorGeneration++;
  resetForm(member);
  editorOpen.value = true;memberLeave.reset();
  await nextTick();
  document.querySelector<HTMLElement>(background?"#member-care-allergies":"#member-display-name")?.focus({preventScroll:!background});
}

async function saveMember() {
  if(saving.value)return;const generation=editorGeneration,target=editingId.value;
  saving.value = true;
  error.value = "";
  try {
    const body = JSON.stringify({...form.value,relationship:form.value.relationship==='shared'?undefined:form.value.relationship});
    if (editingId.value) await request(`members/${editingId.value}`, { method: "PUT", body });
    else await request("members", { method: "POST", body:JSON.stringify({...form.value,createSelf:form.value.relationship==='self'}) });
    await app.refreshMembers();
    if(generation!==editorGeneration)return;editorOpen.value = false;memberLeave.reset();emit("saved",target);
  } catch (cause) {
    if(generation===editorGeneration)error.value = cause instanceof Error ? cause.message : "保存失败";
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
  const sequence = ++scopeRequest;
  scopeLoading.value = true;
  accessOpen.value = true;
  memberAccess.value = [];
  scopePermissions.value = {};
  accessUsers.value = [];
  accessMember.value = member;
  selectedMemberIds.value = [member.id];
  batchUserId.value = "";
  batchPermission.value = "viewer";
  batchSharing.value = false;
  try {
    const [permissions, accounts] = await Promise.all([
      request<MemberAccess[]>(`members/${member.id}/permissions`),
      request<SharingAccount[]>(`members/${member.id}/sharing-accounts`)
    ]);
    if (sequence !== scopeRequest) return;
    memberAccess.value = permissions;
    scopePermissions.value = {[member.id]: permissions};
    accessUsers.value = accounts;
    accessOpen.value = true;
  } catch (cause) {
    if (sequence === scopeRequest) error.value = cause instanceof Error ? cause.message : "权限加载失败";
  } finally { if (sequence === scopeRequest) scopeLoading.value = false; }
}

function currentPermission(userId: string) {
  return memberAccess.value.find((item) => item.userId === userId)?.permission || "";
}

function changeDelegation(userId: string, event: Event) {
  const input = event.target as HTMLInputElement;
  const requested = input.checked;
  input.checked = Boolean(memberAccess.value.find(item => item.userId === userId)?.canManageSharing);
  void changePermission(userId, 'manager', requested);
}
async function changePermission(userId: string, value: string, sharing=false) {
  if (!accessMember.value || saving.value || selectedMemberIds.value.length !== 1 || scopeLoading.value || !scopePermissions.value[selectedMemberIds.value[0]]) return;
  const memberId = selectedMemberIds.value[0];
  const version = memberAccess.value[0]?.version || 0;
  const memberName = sharingMembers.value.find(member => member.id === memberId)?.displayName || '';
  const account = accessUsers.value.find(user => user.id === userId);
  const run = () => applyPermission(memberId, version, userId, value, sharing);
  if(value==='manager' || sharing || userId===app.session.value?.id) {
    const permission = value === 'manager' ? '管理（可上传、修改和删除报告）' : value === 'viewer' ? '仅查看' : '无权限';
    confirmDialog.ask({title:'确认修改共享权限',message:`将「${memberName}」对「${account ? accountLabel(account) : ''}」的权限设为${permission}${sharing ? '，并允许向其他账号共享' : '，不允许再次共享'}。${userId === app.session.value?.id ? '降低或撤销自己的权限可能无法再次管理该档案。' : ''}`,confirmText:'确认',run});
    return;
  }
  await run();
}
async function applyPermission(memberId:string,version:number,userId:string,value:string,sharing:boolean) {
  if(saving.value) return;
  saving.value=true; error.value='';
  try {
    const permissions = await request<MemberAccess[]>(`members/${memberId}/permissions`, {
      method: "PUT",
      body: JSON.stringify({ userId, permission: value || null,canManageSharing:sharing,version })
    });
    if (selectedMemberIds.value.length === 1 && selectedMemberIds.value[0] === memberId) {
      memberAccess.value = permissions;
      scopePermissions.value[memberId] = permissions;
      if (!permissions.length) accessOpen.value=false;
    }
    await app.refreshMembers();
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
    <p v-if="!displayedMembers.length" class="member-empty">{{ showHidden ? '没有已隐藏档案' : '暂无可访问的档案，可添加成员或联系管理员分配权限。' }}</p>
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

  <div v-if="editorOpen" class="modal-backdrop" @click.self="closeEditor">
    <section class="modal-panel record-sheet member-editor-modal" role="dialog" aria-modal="true" :aria-label="editorTitle">
      <span class="sheet-grabber" aria-hidden="true"></span>
      <header><div><UserRound :size="20" /><h3>{{ editorTitle }}</h3></div><button type="button" title="关闭" :disabled="saving" @click="closeEditor"><X :size="19" /></button></header>
      <form class="member-form" @submit.prevent="saveMember"><div class="member-editor-body"><fieldset :disabled="saving">
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
        <section class="member-health-background" aria-label="重要健康背景"><h4>重要健康背景（选填）</h4><p>就诊摘要会自动带出。没有或不清楚请明确填写，留空表示未填写。</p><label><span>过敏及不良反应</span><textarea id="member-care-allergies" v-model="form.careAllergies" rows="2" maxlength="2000" placeholder="已知过敏物及具体反应"/></label><label><span>重要病史</span><textarea v-model="form.careHistory" rows="2" maxlength="2000" placeholder="重要既往疾病、手术等"/></label><label><span>长期用药</span><textarea v-model="form.careMedications" rows="2" maxlength="2000" placeholder="药名及用法等；不会修改已有用药记录"/></label></section>
        <p v-if="error" class="form-error">{{ error }}</p></fieldset></div>
        <div class="form-actions"><button type="button" :disabled="saving" @click="closeEditor">取消</button><button class="primary-button" type="submit" :disabled="saving">{{ saving ? "保存中" : "保存" }}</button></div>
      </form>
    </section>
  </div>

  <div v-if="accessOpen" class="modal-backdrop" @click.self="closeAccess">
    <section class="modal-panel member-access-modal" role="dialog" aria-modal="true" aria-label="访问权限">
      <span class="sheet-grabber" aria-hidden="true"></span>
      <header><div><ShieldCheck :size="20" /><h3>设置共享权限</h3></div><button type="button" title="关闭" @click="closeAccess"><X :size="19" /></button></header>
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
        <label><span>接收账号</span><FormSelect v-model="batchUserId" :options="accessUsers.map(user => ({value:user.id,label:accountLabel(user)}))" placeholder="请选择账号" aria-label="接收账号" :disabled="saving" /></label>
        <label><span>统一设置权限</span><FormSelect v-model="batchPermission" :options="permissionOptions" aria-label="批量权限" :disabled="saving" /></label>
        <label v-if="batchPermission === 'manager'" class="sharing-batch-delegation"><input v-model="batchSharing" type="checkbox" :disabled="saving" />允许管理共享（可向其他账号授权）</label>
        <p class="sharing-batch-note">将覆盖接收账号在所选成员上的原权限。提交前会再次确认；任一成员校验失败，整批不生效。</p>
        <div class="form-actions"><button class="primary-button" type="submit" :disabled="saving || !batchUserId || selectedMemberIds.some(id => !scopePermissions[id])">设置 {{ selectedMemberIds.length }} 位成员的权限</button></div>
      </form>
      <div v-else class="access-list">
        <p v-if="!accessUsers.length" class="member-empty">暂无可用账号，请对方先登录本应用。</p>
        <article v-for="user in accessUsers" :key="user.id">
          <span class="member-avatar small" aria-hidden="true">{{ user.displayName.slice(0, 1) }}</span>
          <div><strong>{{ accountLabel(user) }}</strong><span>{{ currentPermission(user.id) ? "已共享" : "尚未共享" }}</span></div>
          <FormSelect
            v-if="currentPermission(user.id)"
            :model-value="currentPermission(user.id)"
            :options="permissionOptions"
            :aria-label="`${accountLabel(user)}的权限`"
            class="access-select"
            :disabled="saving"
            @change="changePermission(user.id, $event)"
          />
          <button v-else class="sharing-soft-button" :disabled="saving" @click="changePermission(user.id,'viewer')">共享为仅查看</button>
          <label class="sharing-delegation" v-if="currentPermission(user.id)==='manager'"><input type="checkbox" :disabled="saving" :checked="Boolean(memberAccess.find(item=>item.userId===user.id)?.canManageSharing)" @change="changeDelegation(user.id, $event)" /><span><strong>允许管理共享</strong><small>可向其他账号授权或撤销访问</small></span></label>

        </article>
      </div>
      <p v-if="error" class="inline-error" role="alert">{{ error }}</p>
    </section>
  </div>
</template>

<style scoped>
.member-editor-modal{max-height:88vh;max-height:88dvh}.member-editor-modal>.member-form{padding:0;display:flex;flex-direction:column;min-height:0;overflow:hidden;gap:0}.member-editor-body{min-height:0;overflow:auto;position:relative;overscroll-behavior:contain}.member-editor-body label{display:grid;gap:7px;color:var(--muted);font-size:12px}.member-editor-body fieldset{display:grid;gap:12px;border:0;margin:0;padding:12px 14px;min-width:0}.member-editor-modal .form-actions{flex-shrink:0;padding:8px 14px;margin:0;border-top:1px solid var(--line)}.member-health-background{display:grid;gap:10px;border-top:1px solid var(--line);padding-top:12px}.member-health-background h4{margin:0;font-size:14px;font-weight:500}.member-health-background p{margin:0;font-size:12px;line-height:19px;color:var(--muted)}.member-health-background textarea{width:100%;min-width:0;font:inherit;font-size:14px;line-height:21px;padding:8px 10px;border:1px solid var(--line-strong);border-radius:var(--radius-s);background:var(--surface);color:var(--ink)}.member-health-background textarea:focus{outline:2px solid var(--brand-soft);border-color:var(--brand)}
</style>
