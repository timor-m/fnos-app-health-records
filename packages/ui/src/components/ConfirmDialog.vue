<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { CircleAlert, LoaderCircle } from "@lucide/vue";
import { useConfirm } from "../composables/useConfirm";
import { useScrollLock } from "../composables/useScrollLock";

const confirmDialog = useConfirm();
const open = computed(() => Boolean(confirmDialog.state.value));
const panel = ref<HTMLElement | null>(null);
let returnFocus: HTMLElement | null = null;
useScrollLock(open);
watch(open, async visible => {
  if (visible) {
    returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    await nextTick();
    if (open.value) panel.value?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({preventScroll:true});
  } else {
    if (returnFocus?.isConnected) returnFocus.focus({preventScroll:true});
    returnFocus = null;
  }
});
function onKeydown(event: KeyboardEvent) {
  if (!open.value || !panel.value) return;
  if (event.key==='Escape') { event.preventDefault(); event.stopImmediatePropagation(); confirmDialog.cancel(); return; }
  if (event.key!=='Tab') return;
  event.stopPropagation();
  const controls=[...panel.value.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled)')];
  const first=controls[0]; const last=controls[controls.length - 1];
  if (!first) { event.preventDefault(); panel.value.focus(); return; }
  if (event.shiftKey && (document.activeElement===first || !panel.value.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
  else if (!event.shiftKey && (document.activeElement===last || !panel.value.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
}
onMounted(()=>window.addEventListener('keydown',onKeydown,true));
onBeforeUnmount(()=>{window.removeEventListener('keydown',onKeydown,true);if(returnFocus?.isConnected)returnFocus.focus({preventScroll:true});});
async function changeChoice(event: Event) {
  const input=event.target as HTMLInputElement;
  await confirmDialog.choose(input.checked);
  input.checked=confirmDialog.state.value?.choice?.checked ?? false;
}
</script>

<template>
  <Teleport to="body">
    <div v-if="confirmDialog.state.value" class="modal-backdrop report-edit-backdrop confirm-backdrop" @click.self="confirmDialog.cancel">
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
