<script setup lang="ts">
import { onMounted, ref } from "vue";
import { Ban, KeyRound, LoaderCircle, Pencil, Plus, Power, RotateCcw, ShieldCheck, Trash2, UserRound, X } from "@lucide/vue";
import SubPageHeader from "../../components/SubPageHeader.vue";
import { useAppContext } from "../../composables/useAppContext";
import { useConfirm } from "../../composables/useConfirm";
import { useScrollLock } from "../../composables/useScrollLock";
import { useToast } from "../../composables/useToast";
import { ApiRequestError, request } from "../../utils/api";
import type { LocalAccount } from "../../types/api";

const app = useAppContext();
const toast = useToast();
const confirmDialog = useConfirm();
const accounts = ref<LocalAccount[]>([]);
const resetting = ref(false);
const resetError = ref("");
const createOpen = ref(false);
const creating = ref(false);
const createUsername = ref("");
const createDisplayName = ref("");
const passwordEditOpen = ref(false);
const passwordEditing = ref(false);
const passwordEditError = ref("");
const passwordEditAccount = ref<LocalAccount | null>(null);
const passwordEditValue = ref("");
const passwordEditConfirmation = ref("");
const renameOpen = ref(false);
const renaming = ref(false);
const renameError = ref("");
const renameAccount = ref<LocalAccount | null>(null);
const renameValue = ref("");
const renameDisplayName = ref("");
const actionPending = ref(false);
const isAdmin = Boolean(app.session.value?.isAdmin);

useScrollLock(passwordEditOpen);
useScrollLock(renameOpen);

async function loadAccounts() {
  if (!isAdmin) return;
  try {
    accounts.value = await request<LocalAccount[]>("auth/accounts");
  } catch (cause) {
    resetError.value = cause instanceof Error ? cause.message : "账号列表加载失败";
  }
}

function resetAccount(account: LocalAccount) {
  confirmDialog.ask({
    title: "重置本地账号密码",
    message: `确认将 ${account.displayName} 的密码重置为 admin？对方下次登录必须立即修改密码。`,
    confirmText: "重置密码",
    danger: true,
    run: async () => {
      if (resetting.value) return;
      resetError.value = "";
      resetting.value = true;
      try {
        const result = await request<{ temporaryPassword?: string }>("auth/accounts/password", {
          method: "PUT",
          body: JSON.stringify({ userId: account.userId })
        });
        if (account.userId === app.session.value?.id) {
          await app.load();
          return;
        }
        await loadAccounts();
        toast.show(`密码已重置为 ${result.temporaryPassword || "临时密码"}，对方下次登录必须修改`, 4200);
      } catch (cause) {
        resetError.value = cause instanceof Error ? cause.message : "密码重置失败";
      } finally {
        resetting.value = false;
      }
    }
  });
}

function toggleAccountDisabled(account: LocalAccount) {
  const enabling = Boolean(account.disabledAt);
  confirmDialog.ask({
    title: enabling ? "启用本地账号" : "停用本地账号",
    message: enabling
      ? `确认启用 ${account.displayName}（${account.username}）的账号？对方可使用原密码重新登录。`
      : `确认停用 ${account.displayName}（${account.username}）的账号？对方将立即退出登录且无法再登录，成员档案与健康数据保留。`,
    confirmText: enabling ? "启用账号" : "停用账号",
    danger: !enabling,
    run: async () => {
      if (actionPending.value) return;
      resetError.value = "";
      actionPending.value = true;
      try {
        await request("auth/accounts/status", {
          method: "PUT",
          body: JSON.stringify({ userId: account.userId, disabled: !enabling })
        });
        await loadAccounts();
        toast.show(enabling ? "账号已启用" : "账号已停用，其登录会话已撤销", 4200);
      } catch (cause) {
        resetError.value = cause instanceof Error ? cause.message : "账号状态更新失败";
      } finally {
        actionPending.value = false;
      }
    }
  });
}

function removeAccount(account: LocalAccount) {
  confirmDialog.ask({
    title: "删除本地账号",
    message: `确认删除 ${account.displayName}（${account.username}）的账号？删除后无法登录且不可恢复；其成员档案与健康数据保留。`,
    confirmText: "删除账号",
    danger: true,
    run: () => runDeleteAccount(account, false)
  });
}

function forceRemoveAccount(account: LocalAccount, serverMessage: string) {
  confirmDialog.ask({
    title: "确认强制删除",
    message: `${serverMessage}。强制删除不可恢复，确认继续？`,
    confirmText: "仍要删除",
    danger: true,
    run: () => runDeleteAccount(account, true)
  });
}

async function runDeleteAccount(account: LocalAccount, force: boolean) {
  if (actionPending.value) return;
  resetError.value = "";
  actionPending.value = true;
  try {
    const result = await request<{ exclusiveReportCount?: number }>("auth/accounts", {
      method: "DELETE",
      body: JSON.stringify({ userId: account.userId, ...(force ? { force: true } : {}) })
    });
    await loadAccounts();
    toast.show(
      Number(result.exclusiveReportCount) > 0
        ? "账号已删除；其名下报告已无人可访问，存储仍被占用"
        : "账号已删除，其成员档案保留",
      4200
    );
  } catch (cause) {
    if (!force && cause instanceof ApiRequestError && cause.status === 409) {
      forceRemoveAccount(account, cause.message);
      return;
    }
    resetError.value = cause instanceof Error ? cause.message : "账号删除失败";
  } finally {
    actionPending.value = false;
  }
}

function openCreate() {
  createUsername.value = "";
  createDisplayName.value = "";
  resetError.value = "";
  createOpen.value = true;
}

function openPasswordEdit(account: LocalAccount) {
  passwordEditAccount.value = account;
  passwordEditValue.value = "";
  passwordEditConfirmation.value = "";
  passwordEditError.value = "";
  passwordEditOpen.value = true;
}

function closePasswordEdit() {
  if (passwordEditing.value) return;
  passwordEditOpen.value = false;
  passwordEditAccount.value = null;
}

function openRename(account: LocalAccount) {
  renameAccount.value = account;
  renameValue.value = account.username;
  renameDisplayName.value = account.displayName;
  renameError.value = "";
  renameOpen.value = true;
}

function closeRename() {
  if (renaming.value) return;
  renameOpen.value = false;
  renameAccount.value = null;
}

async function submitRename() {
  if (renaming.value || !renameAccount.value) return;
  const target = renameAccount.value;
  const usernameChanged = renameValue.value !== target.username;
  const displayNameChanged = renameDisplayName.value !== target.displayName;
  renameError.value = "";
  if (!usernameChanged && !displayNameChanged) {
    renameError.value = "未做任何修改";
    return;
  }
  renaming.value = true;
  try {
    if (usernameChanged) {
      await request("auth/accounts/username", {
        method: "PUT",
        body: JSON.stringify({ userId: target.userId, username: renameValue.value })
      });
    }
    if (displayNameChanged) {
      await request("auth/accounts/displayname", {
        method: "PUT",
        body: JSON.stringify({ userId: target.userId, displayName: renameDisplayName.value })
      });
    }
    renameOpen.value = false;
    renameAccount.value = null;
    await loadAccounts();
    const isSelf = target.userId === app.session.value?.id;
    if (isSelf) await app.load();
    toast.show(
      usernameChanged
        ? isSelf ? "账号已更新，下次登录请使用新用户名" : "账号已更新，对方下次登录需使用新用户名"
        : "账号信息已更新",
      4200
    );
  } catch (cause) {
    renameError.value = cause instanceof Error ? cause.message : "账号信息保存失败";
  } finally {
    renaming.value = false;
  }
}

async function updateAccountPassword() {
  if (passwordEditing.value || !passwordEditAccount.value) return;
  passwordEditError.value = "";
  if (passwordEditValue.value !== passwordEditConfirmation.value) {
    passwordEditError.value = "两次输入的新密码不一致";
    return;
  }
  passwordEditing.value = true;
  try {
    await request("auth/accounts/password", {
      method: "PUT",
      body: JSON.stringify({
        userId: passwordEditAccount.value.userId,
        newPassword: passwordEditValue.value,
        confirmPassword: passwordEditConfirmation.value
      })
    });
    const updatedAccount = passwordEditAccount.value;
    passwordEditOpen.value = false;
    passwordEditAccount.value = null;
    passwordEditValue.value = "";
    passwordEditConfirmation.value = "";
    if (updatedAccount.userId === app.session.value?.id) {
      await app.load();
      return;
    }
    await loadAccounts();
    toast.show("密码已修改，对方下次登录必须再次确认密码", 4200);
  } catch (cause) {
    passwordEditError.value = cause instanceof Error ? cause.message : "密码修改失败";
  } finally {
    passwordEditing.value = false;
  }
}

async function createAccount() {
  if (creating.value) return;
  resetError.value = "";
  creating.value = true;
  try {
    const result = await request<{ temporaryPassword: string }>("auth/accounts", {
      method: "POST",
      body: JSON.stringify({ username: createUsername.value, displayName: createDisplayName.value })
    });
    await loadAccounts();
    createOpen.value = false;
    toast.show(`账号已创建，临时密码为 ${result.temporaryPassword}，首次登录必须修改`, 4200);
  } catch (cause) {
    resetError.value = cause instanceof Error ? cause.message : "账号创建失败";
  } finally {
    creating.value = false;
  }
}

onMounted(() => { void loadAccounts(); });
</script>

<template>
  <section class="settings-page">
    <SubPageHeader title="账号安全" description="管理本地账号与登录密码" />

    <section v-if="isAdmin" class="settings-band account-management-band">
      <header class="account-management-header">
        <ShieldCheck :size="21" />
        <div class="account-management-title"><h3>本地账号管理</h3><p>管理员可添加账号、编辑显示名称与用户名、重置密码，或停用、删除普通账号；临时密码登录后必须重新设置</p></div>
        <button class="header-action" type="button" @click="openCreate"><Plus :size="16" />添加账号</button>
      </header>
      <form v-if="createOpen" class="account-create-form" @submit.prevent="createAccount">
        <div class="account-create-heading">
          <div><h4>添加本地账号</h4><p>创建后使用临时密码 <code>admin</code> 登录，并在首次登录时完成修改。</p></div>
          <span class="account-create-badge"><ShieldCheck :size="14" />管理员操作</span>
        </div>
        <div class="form-grid account-form-grid">
          <label><span>显示名称</span><input v-model.trim="createDisplayName" maxlength="40" placeholder="例如：张三" required /></label>
          <label><span>用户名</span><input v-model.trim="createUsername" minlength="3" maxlength="64" autocomplete="username" placeholder="用于登录的账号名" required /></label>
        </div>
        <p v-if="resetError" class="form-error" role="alert">{{ resetError }}</p>
        <div class="form-actions">
          <button type="button" @click="createOpen = false">取消</button>
          <button class="primary-button" type="submit" :disabled="creating">
            <LoaderCircle v-if="creating" class="spin-icon" :size="17" />
            <Plus v-else :size="17" />
            {{ creating ? "正在创建" : "创建账号" }}
          </button>
        </div>
      </form>
      <div class="account-list">
        <article v-for="account in accounts" :key="account.id" class="account-row" :class="{ 'is-disabled': account.disabledAt }">
          <span class="member-avatar small" aria-hidden="true"><UserRound :size="16" /></span>
          <div class="account-summary">
            <strong>{{ account.displayName }}</strong>
            <span class="account-username">{{ account.username }}</span>
            <div class="account-meta">
              <span class="account-role">{{ account.isAdmin ? "管理员" : "普通用户" }}</span>
              <span v-if="account.disabledAt" class="account-status-disabled">已停用</span>
              <template v-else>
                <span v-if="account.mustChangePassword" class="account-password-status">待修改密码</span>
                <span v-else class="account-password-status is-ready">密码已设置</span>
              </template>
            </div>
          </div>
          <div class="account-actions">
            <button class="account-action account-action-rename" type="button" :disabled="resetting || passwordEditing || actionPending" @click="openRename(account)"><Pencil :size="16" />编辑</button>
            <template v-if="!account.disabledAt">
              <button class="account-action account-action-edit" type="button" :disabled="resetting || passwordEditing || actionPending" @click="openPasswordEdit(account)"><KeyRound :size="16" />修改密码</button>
              <button class="account-action account-action-reset" type="button" :disabled="resetting || passwordEditing || actionPending" @click="resetAccount(account)"><RotateCcw :size="16" />重置为 admin</button>
            </template>
            <button v-if="!account.isAdmin" class="account-action" :class="account.disabledAt ? 'account-action-enable' : 'account-action-disable'" type="button" :disabled="resetting || passwordEditing || actionPending" @click="toggleAccountDisabled(account)">
              <Power v-if="account.disabledAt" :size="16" /><Ban v-else :size="16" />{{ account.disabledAt ? "启用" : "停用" }}
            </button>
            <button v-if="!account.isAdmin" class="account-action account-action-delete" type="button" :disabled="resetting || passwordEditing || actionPending" @click="removeAccount(account)"><Trash2 :size="16" />删除</button>
          </div>
        </article>
        <p v-if="!accounts.length && !resetError" class="preview-hint">暂无本地账号</p>
      </div>
      <p v-if="resetError" class="form-error account-reset-error" role="alert">{{ resetError }}</p>
    </section>

    <Teleport to="body">
      <div v-if="passwordEditOpen && passwordEditAccount" class="modal-backdrop account-password-backdrop" @click.self="closePasswordEdit">
        <section class="modal-panel account-password-modal" role="dialog" aria-modal="true" aria-labelledby="account-password-title">
          <header>
            <div><KeyRound :size="20" /><h3 id="account-password-title">修改账号密码</h3></div>
            <button type="button" aria-label="关闭" :disabled="passwordEditing" @click="closePasswordEdit"><X :size="19" /></button>
          </header>
          <form class="member-form account-password-form" @submit.prevent="updateAccountPassword">
            <div class="account-password-target">
              <span class="member-avatar small" aria-hidden="true"><UserRound :size="16" /></span>
              <div><strong>{{ passwordEditAccount.displayName }}</strong><span>{{ passwordEditAccount.username }}</span></div>
            </div>
            <p class="account-password-note">设置后会撤销该账号的现有登录会话，下次登录仍需确认新密码。</p>
            <label>
              <span>新密码</span>
              <input v-model="passwordEditValue" type="password" autocomplete="new-password" minlength="8" maxlength="128" required />
              <small class="field-hint">长度 8-128 个字符</small>
            </label>
            <label>
              <span>确认新密码</span>
              <input v-model="passwordEditConfirmation" type="password" autocomplete="new-password" minlength="8" maxlength="128" required />
            </label>
            <p v-if="passwordEditError" class="form-error" role="alert">{{ passwordEditError }}</p>
            <div class="form-actions">
              <button type="button" :disabled="passwordEditing" @click="closePasswordEdit">取消</button>
              <button class="primary-button" type="submit" :disabled="passwordEditing">
                <LoaderCircle v-if="passwordEditing" class="spin-icon" :size="17" />
                <KeyRound v-else :size="17" />
                {{ passwordEditing ? "正在修改" : "保存密码" }}
              </button>
            </div>
          </form>
        </section>
      </div>
    </Teleport>

    <Teleport to="body">
      <div v-if="renameOpen && renameAccount" class="modal-backdrop account-password-backdrop" @click.self="closeRename">
        <section class="modal-panel account-password-modal" role="dialog" aria-modal="true" aria-labelledby="account-rename-title">
          <header>
            <div><Pencil :size="20" /><h3 id="account-rename-title">编辑账号</h3></div>
            <button type="button" aria-label="关闭" :disabled="renaming" @click="closeRename"><X :size="19" /></button>
          </header>
          <form class="member-form account-password-form" @submit.prevent="submitRename">
            <div class="account-password-target">
              <span class="member-avatar small" aria-hidden="true"><UserRound :size="16" /></span>
              <div><strong>{{ renameAccount.displayName }}</strong><span>{{ renameAccount.username }}</span></div>
            </div>
            <p class="account-password-note">显示名称用于界面展示；用户名用于登录，修改不影响当前登录状态，下次登录需使用新用户名。</p>
            <label>
              <span>显示名称</span>
              <input v-model.trim="renameDisplayName" maxlength="40" autocomplete="off" placeholder="例如：张三" required />
              <small class="field-hint">仅影响账号展示，不影响同名成员档案</small>
            </label>
            <label>
              <span>用户名</span>
              <input v-model.trim="renameValue" minlength="3" maxlength="64" autocomplete="off" placeholder="3-64 位字母、数字、点、下划线或短横线" required />
              <small class="field-hint">3-64 位字母、数字、点、下划线或短横线</small>
            </label>
            <p v-if="renameError" class="form-error" role="alert">{{ renameError }}</p>
            <div class="form-actions">
              <button type="button" :disabled="renaming" @click="closeRename">取消</button>
              <button class="primary-button" type="submit" :disabled="renaming">
                <LoaderCircle v-if="renaming" class="spin-icon" :size="17" />
                <Pencil v-else :size="17" />
                {{ renaming ? "正在保存" : "保存修改" }}
              </button>
            </div>
          </form>
        </section>
      </div>
    </Teleport>
  </section>
</template>
