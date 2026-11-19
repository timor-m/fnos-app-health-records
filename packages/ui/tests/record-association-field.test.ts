import { DOMWrapper, flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { KeepAlive, defineComponent, ref } from 'vue';
import Field from '../src/components/HealthRecordAssociationField.vue';
import type { HealthFeedEntry } from '../../shared/health-categories';
import type { HealthRecordRef } from '../../shared/health-record-associations';
const mocks=vi.hoisted(()=>({request:vi.fn(),ask:vi.fn()}));
const app={selectedMemberId:ref('member'),selectedMember:ref({id:'member',permission:'manager'})};
vi.mock('../src/utils/api',()=>({request:mocks.request}));
vi.mock('../src/composables/useAppContext',()=>({useAppContext:()=>app}));
vi.mock('../src/composables/useConfirm',()=>({useConfirm:()=>({ask:mocks.ask})}));
vi.mock('../src/composables/useToast',()=>({useToast:()=>({show:vi.fn()})}));
const entry=(id='report'):HealthFeedEntry=>({id:'report:'+id,resourceId:id,kind:'report',memberId:'member',category:'report',title:'合成资料 '+id,date:'2026-01-01',status:'ready',subtype:'laboratory',description:null,institution:null,documents:[],processIds:[]});
const body=()=>new DOMWrapper(document.body);const modal=()=>body().get('.record-association-modal');
let wrapper:ReturnType<typeof mount>;let host:HTMLElement;
const trigger=()=>wrapper.get('.record-association-field>button');
const action=(text:string)=>modal().findAll('button').find(button=>button.text()===text)!;
const writes=()=>mocks.request.mock.calls.filter(([,options])=>options?.method);
async function render(initial:HealthRecordRef[]=[]){
 host=document.createElement('section');host.setAttribute('role','dialog');document.body.append(host);
 wrapper=mount(Field,{props:{memberId:'member',modelValue:initial},attachTo:host});await trigger().trigger('click');await flushPromises();
}
beforeEach(()=>{vi.clearAllMocks();app.selectedMemberId.value='member';app.selectedMember.value={id:'member',permission:'manager'};
 mocks.request.mockResolvedValue({items:[entry()],nextCursor:null,hasMore:false});});
afterEach(()=>{wrapper?.unmount();host?.remove();document.body.innerHTML='';});
it('uses the existing modal shell, returns choices without a write, and restores the parent and focus',async()=>{
 await render();expect(host.inert).toBe(true);expect(host.getAttribute('aria-hidden')).toBe('true');expect(document.body.style.overflow).toBe('hidden');
 expect(wrapper.find('.health-record-picker').exists()).toBe(false);expect(modal().text()).toContain('保存后形成或加入健康历程');
 await modal().get('.record-picker-option input').setValue(true);expect(wrapper.emitted('update:modelValue')).toBeUndefined();expect(writes()).toHaveLength(0);
 await modal().get('form').trigger('submit');await flushPromises();expect(wrapper.emitted('update:modelValue')).toEqual([[[{kind:'report',id:'report'}]]]);expect(writes()).toHaveLength(0);
 expect(body().find('.record-association-modal').exists()).toBe(false);expect(host.inert).toBe(false);expect(document.body.style.overflow).toBe('');expect(document.activeElement).toBe(trigger().element);
});
it('restores checked initial choices and allows clearing all, including choices outside the loaded page',async()=>{
 await render([{kind:'report',id:'report'},{kind:'symptom',id:'unloaded'}]);
 expect((modal().get('.record-picker-option input').element as HTMLInputElement).checked).toBe(true);
 await action('清除选择').trigger('click');expect((modal().get('.record-picker-option input').element as HTMLInputElement).checked).toBe(false);expect(action('确定').attributes('disabled')).toBeUndefined();
 await modal().get('form').trigger('submit');await flushPromises();expect(wrapper.emitted('update:modelValue')).toEqual([[[]]]);expect(mocks.ask).not.toHaveBeenCalled();expect(writes()).toHaveLength(0);
});
it('unchanged initial choices cancel without a discard prompt; changed draft choices never alter the parent on cancel',async()=>{
 await render([{kind:'report',id:'report'}]);await action('取消').trigger('click');await flushPromises();expect(mocks.ask).not.toHaveBeenCalled();
 await trigger().trigger('click');await flushPromises();await action('清除选择').trigger('click');await action('取消').trigger('click');expect(mocks.ask).toHaveBeenCalledOnce();
 mocks.ask.mock.calls[0][0].run();await flushPromises();expect(wrapper.emitted('update:modelValue')).toBeUndefined();expect(wrapper.props('modelValue')).toEqual([{kind:'report',id:'report'}]);expect(writes()).toHaveLength(0);
});
it('member changes dismiss the picker, restore the parent, and ignore a stale record response',async()=>{
 let finish!:(value:unknown)=>void;mocks.request.mockReturnValueOnce(new Promise(done=>{finish=done;}));await render();
 app.selectedMemberId.value='other';await flushPromises();expect(body().find('.record-association-modal').exists()).toBe(false);expect(host.inert).toBe(false);expect(document.body.style.overflow).toBe('');
 finish({items:[entry()],nextCursor:null,hasMore:false});await flushPromises();expect(wrapper.emitted('update:modelValue')).toBeUndefined();
});
it('permission loss or a disabled parent closes the selection without committing it',async()=>{
 await render();await modal().get('.record-picker-option input').setValue(true);app.selectedMember.value={id:'member',permission:'viewer'};await flushPromises();
 expect(body().find('.record-association-modal').exists()).toBe(false);expect(wrapper.emitted('update:modelValue')).toBeUndefined();expect(trigger().attributes('disabled')).toBeDefined();
 app.selectedMember.value={id:'member',permission:'manager'};await flushPromises();await trigger().trigger('click');await flushPromises();await wrapper.setProps({disabled:true});expect(body().find('.record-association-modal').exists()).toBe(false);
});
it('leaving a cached form removes the independent modal and its scroll lock',async()=>{
 const visible=ref(true);const Host=defineComponent({components:{KeepAlive,Field},setup:()=>({visible,records:ref([])}),template:'<KeepAlive><Field v-if="visible" v-model="records" member-id="member"/></KeepAlive>'});
 wrapper=mount(Host,{attachTo:document.body});await trigger().trigger('click');await flushPromises();expect(body().find('.record-association-modal').exists()).toBe(true);
 visible.value=false;await flushPromises();expect(body().find('.record-association-modal').exists()).toBe(false);expect(document.body.style.overflow).toBe('');expect(writes()).toHaveLength(0);
});
