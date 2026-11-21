<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { CircleAlert, LoaderCircle } from "@lucide/vue";
import { useConfirm } from "../composables/useConfirm";
import { useScrollLock } from "../composables/useScrollLock";

type MessageBlock = { type: "text"; text: string } | { type: "list"; items: string[] };

const confirmDialog = useConfirm();
const open = computed(() => Boolean(confirmDialog.state.value));
const messageBlocks = computed((): MessageBlock[] => {
  const blocks: MessageBlock[] = [];
  for (const raw of (confirmDialog.state.value?.message || "").split("\n")) {
    const item = raw.match(/^\s*·\s+(.*)$/);
    if (item) {
      const last = blocks.at(-1);
      if (last?.type === "list") last.items.push(item[1]);
      else blocks.push({ type: "list", items: [item[1]] });
      continue;
    }
    const last = blocks.at(-1);
    if (last?.type === "text") last.text += `\n${raw}`;
    else blocks.push({ type: "text", text: raw });
  }
  const result: MessageBlock[] = [];
  for (const block of blocks) {
    if (block.type === "list") {
      if (block.items.length) result.push(block);
      continue;
    }
    const text = block.text.replace(/^\n+|\n+$/g, "");
    if (text) result.push({ type: "text", text });
  }
  return result;
});
const panel = ref<HTMLElement | null>(null);
let returnFocus: HTMLElement | null = null;
useScrollLock(open);
watch(open, async visible => {
  if (visible) {
    returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    await nextTick();
    if (open.value) panel.value?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({preventScroll:true});
  } else {
    if (returnFocus?.isConnected && !returnFocus.closest('[inert]')) returnFocus.focus({preventScroll:true});
    returnFocus = null;
  }
}, {immediate:true});
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
          <template v-for="(block, index) in messageBlocks" :key="index">
            <p v-if="block.type === 'text'">{{ block.text }}</p>
            <ul v-else class="confirm-points">
              <li v-for="item in block.items" :key="item"><span>{{ item }}</span></li>
            </ul>
          </template>
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
.confirm-modal:has(.confirm-points) { width: min(460px, 100%); }
.confirm-points { display: grid; gap: 8px; margin: 10px 0 0; padding: 0; list-style: none; container-type: inline-size; }
.confirm-points li { display: grid; grid-template-columns: 16px minmax(0, 1fr); column-gap: 2px; align-items: center; }
.confirm-points li span { white-space: nowrap; font-size: 14px; line-height: 22px; }
.confirm-points li::before {
  content: ""; width: 8px; height: 8px; border-radius: 50%;
  background: currentColor; justify-self: center;
}
@container (max-width: 390px) {
  .confirm-points li span { font-size: 12px; line-height: 20px; }
}
.restore-choice { display: flex; align-items: flex-start; gap: 8px; margin-top: 16px; }
.restore-choice input { width: auto; flex: 0 0 auto; margin-top: 3px; }
</style>
