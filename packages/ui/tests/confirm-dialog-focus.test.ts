import { mount, flushPromises } from '@vue/test-utils';
import { afterEach, expect, it, vi } from 'vitest';
import ConfirmDialog from '../src/components/ConfirmDialog.vue';
import { useConfirm } from '../src/composables/useConfirm';

const confirmation=useConfirm();
let wrapper:ReturnType<typeof mount>|undefined;
afterEach(()=>{confirmation.cancel();wrapper?.unmount();document.body.innerHTML='';});
it('focuses the safe action, traps keyboard focus and restores it after canceling unsaved changes',async()=>{
 const origin=document.createElement('button');document.body.append(origin);origin.focus();
 wrapper=mount(ConfirmDialog,{attachTo:document.body});const onCancel=vi.fn();
 confirmation.ask({title:'放弃未保存的修改？',message:'合成提示',cancelText:'继续填写',onCancel,run:()=>{}});await flushPromises();
 const buttons=[...document.querySelectorAll<HTMLButtonElement>('.confirm-modal button')];expect(document.activeElement).toBe(buttons[0]);
 buttons[1].focus();window.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',cancelable:true}));expect(document.activeElement).toBe(buttons[0]);
 window.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',shiftKey:true,cancelable:true}));expect(document.activeElement).toBe(buttons[1]);
 const underlyingEscape=vi.fn();window.addEventListener('keydown',underlyingEscape);
 window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',cancelable:true}));window.removeEventListener('keydown',underlyingEscape);
 await flushPromises();expect(underlyingEscape).not.toHaveBeenCalled();expect(confirmation.state.value).toBeNull();expect(onCancel).toHaveBeenCalledOnce();expect(document.activeElement).toBe(origin);expect(document.body.style.overflow).toBe('');
});
it('does not dismiss an operation that is still saving',async()=>{
 wrapper=mount(ConfirmDialog,{attachTo:document.body});let finish!:()=>void;
 confirmation.ask({title:'合成保存',message:'合成提示',run:()=>new Promise<void>(resolve=>finish=resolve)});await flushPromises();
 const saving=confirmation.confirm();await flushPromises();window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',cancelable:true}));expect(confirmation.state.value?.loading).toBe(true);
 finish();await saving;await flushPromises();expect(confirmation.state.value).toBeNull();
});
