import { computed, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, watch, type Ref } from 'vue';
import { useConfirm } from './useConfirm';
import { useToast } from './useToast';
import { registerRecordEditGuard } from '../utils/record-edit-guards';

export function useUnsavedRecord(snapshot: () => string, busy: Ref<boolean>, enabled: () => boolean = () => true) {
  const confirmation = useConfirm();
  const toast = useToast();
  const baseline = ref(snapshot());
  const dirty = computed(() => enabled() && snapshot() !== baseline.value);
  let active = true;
  let confirmationRun: (() => void) | undefined;
  let approved = '';
  let version = 0;
  let pending: Promise<boolean> | null = null;
  let settle: ((value: boolean) => void) | null = null;
  let unregister: (() => void) | undefined;
  function reset() {
    version++; baseline.value = snapshot(); approved = '';
    if (confirmationRun && confirmation.state?.value?.run === confirmationRun) confirmation.cancel();
    settle?.(false); settle = null; pending = null; confirmationRun = undefined;
  }
  async function confirmLeave() {
    if (!active || !enabled()) return true;
    if (busy.value) { toast.show('正在保存，请稍候'); return false; }
    if (!dirty.value || approved === snapshot()) return true;
    if (pending) return pending;
    const token = version;
    const current = snapshot();
    pending = new Promise<boolean>(resolve => {
      settle = resolve;
      confirmationRun = () => { const valid = token === version && active && !busy.value; if (valid) approved = current; resolve(valid); pending = null; settle = null; };
      confirmation.ask({title:'放弃未保存的修改？',message:'已填写的内容尚未保存。',confirmText:'放弃修改',cancelText:'继续填写',
        onCancel: () => { resolve(false); pending = null; settle = null; },
        run: confirmationRun
      });
    });
    return pending;
  }
  watch(snapshot, () => { approved = ''; });
  function register() { active = true; unregister?.(); unregister = registerRecordEditGuard(confirmLeave); }
  function beforeUnload(event: BeforeUnloadEvent) { if (active && enabled() && (dirty.value || busy.value)) { event.preventDefault(); event.returnValue = ''; } }
  onMounted(() => { register(); window.addEventListener('beforeunload', beforeUnload); });
  onActivated(register);
  onDeactivated(() => { active = false; unregister?.(); });
  onBeforeUnmount(() => { active = false; reset(); unregister?.(); window.removeEventListener('beforeunload', beforeUnload); });
  return { dirty, reset, confirmLeave };
}
