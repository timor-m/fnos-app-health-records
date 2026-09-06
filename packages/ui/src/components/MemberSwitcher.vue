<script setup lang="ts">
import { computed, onBeforeUnmount, watch } from "vue";
import { Check, X } from "@lucide/vue";
import { useAppContext } from "../composables/useAppContext";
import { useScrollLock } from "../composables/useScrollLock";

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: [] }>();

const app = useAppContext();
useScrollLock(computed(() => props.open));

function onKeydown(event: KeyboardEvent) {
  if (event.key === "Escape") emit("close");
}
watch(() => props.open, (open) => {
  if (open) window.addEventListener("keydown", onKeydown);
  else window.removeEventListener("keydown", onKeydown);
});
onBeforeUnmount(() => window.removeEventListener("keydown", onKeydown));

const relationshipLabels: Record<string, string> = {
  self: "本人", spouse: "配偶", child: "子女", parent: "父母", sibling: "兄弟姐妹", other: "其他"
};

function pick(id: string) {
  app.selectedMemberId.value = id;
  emit("close");
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="sheet-backdrop" @click.self="emit('close')">
      <section class="sheet-panel member-sheet" role="dialog" aria-modal="true" aria-label="切换成员">
        <span class="sheet-grabber" aria-hidden="true"></span>
        <header class="sheet-header">
          <h3>切换成员</h3>
          <button type="button" class="plain-icon-button" title="关闭" @click="emit('close')"><X :size="19" /></button>
        </header>
        <div class="member-sheet-list">
          <button
            v-for="member in app.members.value"
            :key="member.id"
            type="button"
            class="member-sheet-item"
            :class="{ selected: member.id === app.selectedMemberId.value }"
            @click="pick(member.id)"
          >
            <span class="member-avatar" aria-hidden="true">{{ member.displayName.slice(0, 1) }}</span>
            <span class="member-sheet-info">
              <strong>{{ member.displayName }}</strong>
              <span>{{ relationshipLabels[member.relationship] || "其他" }}</span>
            </span>
            <Check v-if="member.id === app.selectedMemberId.value" :size="19" class="member-sheet-check" />
          </button>
        </div>
      </section>
    </div>
  </Teleport>
</template>
