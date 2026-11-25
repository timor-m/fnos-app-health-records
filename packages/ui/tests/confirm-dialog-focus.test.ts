import { mount, flushPromises } from '@vue/test-utils';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import ConfirmDialog from '../src/components/ConfirmDialog.vue';
import { useConfirm } from '../src/composables/useConfirm';

const confirmation=useConfirm();
let wrapper:ReturnType<typeof mount>|undefined;
const atDescriptor=Object.getOwnPropertyDescriptor(Array.prototype,'at')!;
beforeEach(()=>Object.defineProperty(Array.prototype,'at',{...atDescriptor,value:undefined}));
afterEach(()=>{confirmation.cancel();wrapper?.unmount();document.body.innerHTML='';Object.defineProperty(Array.prototype,'at',atDescriptor);vi.restoreAllMocks();});
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

it('renders mixed paragraphs and bullet groups without Array.at, including reactive choice changes',async()=>{
 wrapper=mount(ConfirmDialog,{attachTo:document.body});let finishChoice!:(message:string)=>void;
 const run=vi.fn();
 confirmation.ask({title:'合成确认',message:'第一段 <em>原文</em>\n第二行\n· 项目一\n· 项目二\n\n最后说明\n· 项目三',run,
  choice:{label:'包含选项',checked:false,change:()=>new Promise(resolve=>{finishChoice=resolve;})}});
 await flushPromises();
 const dialog=document.querySelector('.confirm-modal')!;
 expect(Array.from(dialog.querySelectorAll('p')).map(node=>node.textContent)).toEqual(['第一段 <em>原文</em>\n第二行','最后说明']);
 expect(Array.from(dialog.querySelectorAll('ul')).map(node=>Array.from(node.querySelectorAll('li')).map(item=>item.textContent))).toEqual([['项目一','项目二'],['项目三']]);
 expect(dialog.querySelector('em')).toBeNull();
 const input=dialog.querySelector<HTMLInputElement>('input')!;input.checked=true;input.dispatchEvent(new Event('change',{bubbles:true}));await flushPromises();
 expect(input.disabled).toBe(true);expect([...dialog.querySelectorAll('button')].every(button=>button.disabled)).toBe(true);
 finishChoice('更新说明\n· 更新项目一\n· 更新项目二');await flushPromises();
 expect(input.checked).toBe(true);expect(input.disabled).toBe(false);
 expect(Array.from(dialog.querySelectorAll('li')).map(item=>item.textContent)).toEqual(['更新项目一','更新项目二']);expect(run).not.toHaveBeenCalled();
});
it.each(['button','backdrop'])('cancels through %s once and restores focus without running the operation',async source=>{
 const origin=document.createElement('button');document.body.append(origin);origin.focus();
 wrapper=mount(ConfirmDialog,{attachTo:document.body});const run=vi.fn(),onCancel=vi.fn();
 confirmation.ask({title:'合成取消',message:'· 合成提示',onCancel,run});await flushPromises();
 const target=source==='button'?document.querySelector<HTMLButtonElement>('.confirm-modal button')!:document.querySelector<HTMLElement>('.confirm-backdrop')!;
 target.click();await flushPromises();expect(confirmation.state.value).toBeNull();expect(run).not.toHaveBeenCalled();expect(onCancel).toHaveBeenCalledOnce();expect(document.activeElement).toBe(origin);
});
it('confirms only once while saving and restores focus after completion',async()=>{
 const origin=document.createElement('button');document.body.append(origin);origin.focus();
 wrapper=mount(ConfirmDialog,{attachTo:document.body});let finish!:()=>void;
 const run=vi.fn(()=>new Promise<void>(resolve=>{finish=resolve;})),onCancel=vi.fn();
 confirmation.ask({title:'合成确认',message:'说明\n· 合成项目',run,onCancel,danger:true,confirmText:'继续操作'});await flushPromises();
 const confirm=document.querySelector<HTMLButtonElement>('.confirm-modal .primary-button')!;expect(confirm.classList.contains('danger-primary-button')).toBe(true);
 confirm.click();await flushPromises();confirm.click();document.querySelector<HTMLElement>('.confirm-backdrop')!.click();window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',cancelable:true}));
 expect(run).toHaveBeenCalledOnce();expect(onCancel).not.toHaveBeenCalled();expect(confirmation.state.value?.loading).toBe(true);
 finish();await flushPromises();expect(confirmation.state.value).toBeNull();expect(document.activeElement).toBe(origin);expect(document.body.style.overflow).toBe('');
});
it('keeps a follow-up confirmation opened by the confirmed action',async()=>{
 wrapper=mount(ConfirmDialog,{attachTo:document.body});const nextRun=vi.fn();
 confirmation.ask({title:'首次确认',message:'第一段',run:()=>confirmation.ask({title:'再次确认',message:'· 后续项目',run:nextRun})});await flushPromises();
 document.querySelector<HTMLButtonElement>('.confirm-modal .primary-button')!.click();await flushPromises();
 expect(confirmation.state.value?.title).toBe('再次确认');expect(document.querySelector('.confirm-points li')?.textContent).toBe('后续项目');expect(nextRun).not.toHaveBeenCalled();
 document.querySelector<HTMLButtonElement>('.confirm-modal .primary-button')!.click();await flushPromises();expect(nextRun).toHaveBeenCalledOnce();expect(confirmation.state.value).toBeNull();
});
