<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, useId, watch } from "vue";

const props = withDefaults(defineProps<{ text: string; label?: string }>(), { label: "查看指标提示" });
const id = useId();
const open = ref(false);
const trigger = ref<HTMLButtonElement>();
const panel = ref<HTMLElement>();
const position = ref({ left: "0px", top: "0px" });
function close() { open.value = false; }
function outside(event: PointerEvent) {
  const target = event.target as Node;
  if (!trigger.value?.contains(target) && !panel.value?.contains(target)) close();
}
function blur(event: FocusEvent) {
  const target = event.relatedTarget as Node | null;
  if (!target || (!trigger.value?.contains(target) && !panel.value?.contains(target))) close();
}
function scroll(event: Event) {
  if (!panel.value?.contains(event.target as Node)) close();
}
async function toggle() {
  open.value = !open.value;
  if (!open.value) return;
  await nextTick();
  const anchor = trigger.value?.getBoundingClientRect();
  const box = panel.value?.getBoundingClientRect();
  if (!anchor || !box) return;
  position.value = {
    left: `${Math.max(12, Math.min(anchor.left, window.innerWidth - box.width - 12))}px`,
    top: `${Math.max(12, anchor.bottom + box.height + 8 < window.innerHeight ? anchor.bottom + 8 : anchor.top - box.height - 8)}px`
  };
}
function cleanup() {
  document.removeEventListener("pointerdown", outside, true);
  window.removeEventListener("resize", close);
  document.removeEventListener("scroll", scroll, true);
}
watch(open, value => {
  cleanup();
  if (value) {
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("resize", close);
    document.addEventListener("scroll", scroll, true);
  }
});
watch(() => props.text, close);
onBeforeUnmount(cleanup);
</script>

<template>
  <span class="indicator-hint" @click.stop @keydown.stop>
    <button ref="trigger" type="button" class="indicator-hint-toggle" :aria-label="label"
      :aria-expanded="open" :aria-controls="open ? id : undefined"
      @click="toggle" @focusout="blur" @keydown.esc="close">!</button>
    <Teleport to="body">
      <div v-if="open" :id="id" ref="panel" class="indicator-hint-panel" :style="position"
        role="note" tabindex="0" @focusout="blur" @keydown.esc="trigger?.focus(); close()" @click.stop>
        {{ text }}
      </div>
    </Teleport>
  </span>
</template>

<style scoped>
.indicator-hint { display: inline-flex; vertical-align: middle; }
.indicator-hint .indicator-hint-toggle {
  display: inline-flex; align-items: center; justify-content: center;
  width: 28px; height: 28px; min-width: 28px; padding: 0; border: 1px solid var(--line);
  border-radius: 50%; background: var(--fill-2); color: var(--muted); font-weight: 700;
  font-size: 15px; cursor: pointer; box-shadow: none;
}
.indicator-hint-toggle:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; }
.indicator-hint-panel {
  position: fixed; z-index: 160; width: max-content; max-width: min(320px, calc(100vw - 24px));
  max-height: 40dvh; overflow: auto; padding: 12px 14px; border: 1px solid var(--line);
  border-radius: 12px; background: var(--surface); color: var(--muted);
  box-shadow: 0 8px 28px #0003; font-size: 13px; line-height: 1.6; white-space: pre-line;
  overflow-wrap: anywhere; box-sizing: border-box;
}
</style>
