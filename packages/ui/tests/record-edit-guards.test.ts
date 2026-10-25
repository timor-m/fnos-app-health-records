import { mount,flushPromises } from '@vue/test-utils';
import { afterEach,beforeEach,expect,it } from 'vitest';
import { defineComponent,KeepAlive,nextTick,ref } from 'vue';
import { createMemoryHistory,createRouter } from 'vue-router';
import { useUnsavedRecord } from '../src/composables/useUnsavedRecord';
import { useConfirm } from '../src/composables/useConfirm';
import { confirmUnsavedRecordChanges } from '../src/utils/record-edit-guards';
const confirmation=useConfirm();
const input=ref('');const busy=ref(false);
let editor:ReturnType<typeof useUnsavedRecord>;
const Form=defineComponent({setup(){editor=useUnsavedRecord(()=>input.value,busy);return()=>null;}});
let wrapper:ReturnType<typeof mount>|undefined;
beforeEach(()=>{input.value='';busy.value=false;confirmation.cancel();});
afterEach(()=>{wrapper?.unmount();wrapper=undefined;confirmation.cancel();});
it('does not prompt for an unchanged form, and cancellation preserves a changed form',async()=>{
 wrapper=mount(Form);expect(await confirmUnsavedRecordChanges()).toBe(true);expect(confirmation.state.value).toBeNull();
 input.value='未保存内容';await nextTick();const navigation=confirmUnsavedRecordChanges();await flushPromises();expect(confirmation.state.value?.title).toContain('未保存');
 confirmation.cancel();expect(await navigation).toBe(false);expect(input.value).toBe('未保存内容');expect(editor.dirty.value).toBe(true);
 const approved=confirmUnsavedRecordChanges();await flushPromises();await confirmation.confirm();expect(await approved).toBe(true);expect(await confirmUnsavedRecordChanges()).toBe(true);
 input.value='再次修改';await nextTick();const again=confirmUnsavedRecordChanges();await flushPromises();expect(confirmation.state.value).not.toBeNull();confirmation.cancel();expect(await again).toBe(false);
});
it('does not let a saving form leave, and resetting a member cancels stale prompts only',async()=>{
 wrapper=mount(Form);busy.value=true;expect(await confirmUnsavedRecordChanges()).toBe(false);busy.value=false;
 input.value='修改';await nextTick();const pending=confirmUnsavedRecordChanges();await flushPromises();input.value='';editor.reset();expect(await pending).toBe(false);expect(confirmation.state.value).toBeNull();
 confirmation.ask({title:'其他操作',message:'合成提示',run:()=>{}});editor.reset();expect(confirmation.state.value?.title).toBe('其他操作');
});
it('guards browser back and query navigation, then unregisters cached forms',async()=>{
 const shown=ref(true);const router=createRouter({history:createMemoryHistory(),routes:['/one','/two'].map(path=>({path,component:{template:'<div/>'}}))});
 router.beforeEach(()=>confirmUnsavedRecordChanges());await router.push('/one');await router.push('/two');
 wrapper=mount(defineComponent({components:{KeepAlive,Form},setup:()=>({shown}),template:'<KeepAlive><Form v-if="shown"/></KeepAlive>'}));
 input.value='未保存';await nextTick();router.back();await flushPromises();expect(confirmation.state.value).not.toBeNull();confirmation.cancel();await flushPromises();expect(router.currentRoute.value.path).toBe('/two');
 const queryNavigation=router.push('/two?recordId=next');await flushPromises();confirmation.cancel();await queryNavigation;expect(router.currentRoute.value.fullPath).toBe('/two');
 router.back();await flushPromises();await confirmation.confirm();await flushPromises();expect(router.currentRoute.value.path).toBe('/one');
 shown.value=false;await nextTick();expect(await confirmUnsavedRecordChanges()).toBe(true);
 const unload=new Event('beforeunload',{cancelable:true});window.dispatchEvent(unload);expect(unload.defaultPrevented).toBe(false);
});
it('protects reload while an active form is dirty and removes the listener on unmount',async()=>{
 wrapper=mount(Form);input.value='未保存';await nextTick();const unload=new Event('beforeunload',{cancelable:true});window.dispatchEvent(unload);expect(unload.defaultPrevented).toBe(true);
 wrapper.unmount();wrapper=undefined;const after=new Event('beforeunload',{cancelable:true});window.dispatchEvent(after);expect(after.defaultPrevented).toBe(false);
});

it('temporarily delegates to a child editor without discarding the parent dirty state',async()=>{
 const enabled=ref(true);wrapper=mount(defineComponent({setup(){editor=useUnsavedRecord(()=>input.value,busy,()=>enabled.value);return()=>null;}}));
 input.value='合成父表单草稿';await nextTick();expect(editor.dirty.value).toBe(true);enabled.value=false;await nextTick();expect(await confirmUnsavedRecordChanges()).toBe(true);expect(confirmation.state.value).toBeNull();
 const unload=new Event('beforeunload',{cancelable:true});window.dispatchEvent(unload);expect(unload.defaultPrevented).toBe(false);
 enabled.value=true;await nextTick();expect(editor.dirty.value).toBe(true);const pending=confirmUnsavedRecordChanges();await flushPromises();expect(confirmation.state.value).not.toBeNull();confirmation.cancel();expect(await pending).toBe(false);expect(input.value).toBe('合成父表单草稿');
});
