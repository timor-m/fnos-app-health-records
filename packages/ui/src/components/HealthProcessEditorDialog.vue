<script setup lang="ts">
import {nextTick,onBeforeUnmount,onMounted,ref} from 'vue';
import {X} from '@lucide/vue';
import {useScrollLock} from '../composables/useScrollLock';
const props=defineProps<{busy:boolean;title?:string;closeLabel?:string;returnFocus?:HTMLElement|null}>();
const emit=defineEmits<{close:[]}>();const panel=ref<HTMLElement|null>(null),backdrop=ref<HTMLElement|null>(null);useScrollLock(ref(true));
function key(event:KeyboardEvent){
 if(!panel.value||document.querySelector('.form-select-layer,.datetime-picker-layer,.confirm-backdrop')||[...document.querySelectorAll('.modal-backdrop,.sheet-backdrop')].at(-1)!==backdrop.value)return;
 if(event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();if(!props.busy)emit('close');return;}
 if(event.key!=='Tab')return;const items=[...panel.value.querySelectorAll<HTMLElement>('a[href],button:not(:disabled),input:not(:disabled),textarea:not(:disabled),[tabindex="0"]')];const first=items[0],last=items.at(-1);
 if(!panel.value.contains(document.activeElement)||event.shiftKey&&document.activeElement===first||!event.shiftKey&&document.activeElement===last){event.preventDefault();(event.shiftKey?last:first)?.focus();}
}
onMounted(()=>{window.addEventListener('keydown',key);void nextTick(()=>(panel.value?.querySelector<HTMLElement>('input')||panel.value?.querySelector<HTMLElement>('a[href],button:not(:disabled)')||panel.value)?.focus({preventScroll:true}));});
onBeforeUnmount(()=>{window.removeEventListener('keydown',key);void nextTick(()=>{if(props.returnFocus?.isConnected)props.returnFocus.focus({preventScroll:true});});});
</script>
<template><Teleport to="body"><div ref="backdrop" class="modal-backdrop process-editor-backdrop" @click.self="!busy&&emit('close')"><section ref="panel" class="modal-panel record-sheet process-editor-modal" role="dialog" aria-modal="true" :aria-label="title||'编辑健康历程'" tabindex="-1"><span class="sheet-grabber" aria-hidden="true"/><header><h3>{{title||'编辑健康历程'}}</h3><button type="button" class="plain-icon-button" :aria-label="closeLabel||'关闭历程编辑'" :disabled="busy" @click="emit('close')"><X :size="18"/></button></header><slot/></section></div></Teleport></template>
<style scoped>
.process-editor-backdrop{z-index:70}.process-editor-modal{width:min(640px,100%);max-height:88dvh;outline:0}.process-editor-modal>header{padding:10px 14px;min-height:48px;gap:8px}.process-editor-modal h3{margin:0;font-size:16px;line-height:22px}.process-editor-modal>header>button{flex:0 0 28px;width:28px;height:28px}.process-editor-modal button:focus-visible{outline:2px solid var(--brand);outline-offset:2px}
</style>
