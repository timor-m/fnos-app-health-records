<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { CircleAlert, LoaderCircle } from "@lucide/vue";
import { useConfirm } from "../composables/useConfirm";
import { useScrollLock } from "../composables/useScrollLock";

const confirmDialog = useConfirm();
const open = computed(() => Boolean(confirmDialog.state.value));
const panel = ref<HTMLElement>();
let previousFocus: HTMLElement | null = null;
useScrollLock(open);
function focusableElements() {
  return Array.from(panel.value?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)') || []);
}
function restoreFocus() {
  if (previousFocus?.isConnected && !previousFocus.closest('[inert]')) previousFocus.focus();
}
watch(open, async value => {
  if (value) previousFocus = document.activeElement as HTMLElement | null;
  await nextTick();
  if (value && open.value) (focusableElements()[0] || panel.value)?.focus();
  else if (!open.value) restoreFocus();
}, { immediate: true });
onBeforeUnmount(restoreFocus);
function keydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault();
    confirmDialog.cancel();
    return;
  }
  if (event.key !== 'Tab') return;
  const items = focusableElements(), first = items[0], last = items.at(-1);
  if (!first) { event.preventDefault(); panel.value?.focus(); }
  else if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.value)) {
    event.preventDefault(); last?.focus();
  } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === panel.value)) {
    event.preventDefault(); first.focus();
  }
}
async function changeChoice(event: Event) {
  const input=event.target as HTMLInputElement;
  await confirmDialog.choose(input.checked);
  input.checked=confirmDialog.state.value?.choice?.checked ?? false;
}
</script>

<template>
  <Teleport to="body">
    <div v-if="confirmDialog.state.value" class="modal-backdrop report-edit-backdrop confirm-backdrop" @click.self="confirmDialog.cancel" @keydown.stop="keydown">
      <section ref="panel" class="modal-panel confirm-modal" role="alertdialog" aria-modal="true" :aria-label="confirmDialog.state.value.title" tabindex="-1">
        <header>
          <div><CircleAlert :size="20" /><h3>{{ confirmDialog.state.value.title }}</h3></div>
        </header>
        <div class="confirm-modal-body">
          <p>{{ confirmDialog.state.value.message }}</p>
          <label v-if="confirmDialog.state.value.choice" class="restore-choice">
            <input type="checkbox" :checked="confirmDialog.state.value.choice.checked" :disabled="confirmDialog.state.value.loading"
              @change="changeChoice" />
            {{ confirmDialog.state.value.choice.label }}
          </label>
        </div>
        <div class="form-actions confirm-modal-actions">
          <button type="button" :disabled="confirmDialog.state.value.loading" @click="confirmDialog.cancel">
            {{ confirmDialog.state.value.cancelText || "取消" }}
          </button>
          <button
            class="primary-button"
            :class="{ 'danger-primary-button': confirmDialog.state.value.danger }"
            type="button"
            :disabled="confirmDialog.state.value.loading"
            @click="confirmDialog.confirm"
          >
            <LoaderCircle v-if="confirmDialog.state.value.loading" class="spin-icon" :size="16" />
            {{ confirmDialog.state.value.confirmText || "确认" }}
          </button>
        </div>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.restore-choice { display: flex; align-items: flex-start; gap: 8px; margin-top: 16px; }
.restore-choice input { width: auto; flex: 0 0 auto; margin-top: 3px; }
</style>
