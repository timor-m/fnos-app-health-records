<script setup lang="ts">
import { computed } from "vue";
import { CircleAlert, LoaderCircle } from "@lucide/vue";
import { useConfirm } from "../composables/useConfirm";
import { useScrollLock } from "../composables/useScrollLock";

const confirmDialog = useConfirm();
const open = computed(() => Boolean(confirmDialog.state.value));
useScrollLock(open);
</script>

<template>
  <Teleport to="body">
    <div v-if="confirmDialog.state.value" class="modal-backdrop report-edit-backdrop confirm-backdrop" @click.self="confirmDialog.cancel">
      <section class="modal-panel confirm-modal" role="alertdialog" aria-modal="true" :aria-label="confirmDialog.state.value.title">
        <header>
          <div><CircleAlert :size="20" /><h3>{{ confirmDialog.state.value.title }}</h3></div>
        </header>
        <div class="confirm-modal-body"><p>{{ confirmDialog.state.value.message }}</p></div>
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
