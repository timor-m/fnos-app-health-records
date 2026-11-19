import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Picker from '../src/components/HealthRecordPicker.vue';
import type { HealthFeedEntry } from '../../shared/health-categories';
const api=vi.hoisted(()=>({request:vi.fn()}));
vi.mock('../src/utils/api',()=>({request:api.request}));
const entry=(id:string,kind:HealthFeedEntry['kind']='report'):HealthFeedEntry=>({id:kind+':'+id,resourceId:id,kind,memberId:'member',category:kind==='medication_document'?'medication':'report',title:'合成资料 '+id,date:'2026-01-01',status:'ready',subtype:'laboratory',description:null,institution:null,documents:[],processIds:['process']});
let wrapper:ReturnType<typeof mount>;
beforeEach(()=>{api.request.mockReset();});
afterEach(()=>{wrapper?.unmount();vi.useRealTimers();});
it('excludes a medication document already in the process even when its reference is stored as a report',async()=>{
 api.request.mockResolvedValue({items:[entry('rx','medication_document'),entry('other')],nextCursor:null,hasMore:false});
 wrapper=mount(Picker,{props:{memberId:'member',modelValue:[],exclude:[{kind:'report',id:'rx'}]}});await flushPromises();
 expect(wrapper.findAll('.record-picker-option strong').map(node=>node.text())).toEqual(['合成资料 other']);expect(wrapper.text()).toContain('已有关联历程');expect(wrapper.text()).not.toContain('所属过程');
});
it('recognizes a checked document alias and removes it without adding a second reference',async()=>{
 api.request.mockResolvedValue({items:[entry('rx','medication_document')],nextCursor:null,hasMore:false});
 wrapper=mount(Picker,{props:{memberId:'member',modelValue:[{kind:'report',id:'rx'}]}});await flushPromises();
 expect((wrapper.get('input[type=checkbox]').element as HTMLInputElement).checked).toBe(true);await wrapper.get('input[type=checkbox]').setValue(false);
 expect(wrapper.emitted('update:modelValue')).toEqual([[[]]]);
});
it('changing search immediately retires the old cursor and ignores an older page reply',async()=>{
 vi.useFakeTimers();let finish!:(value:unknown)=>void;
 api.request.mockResolvedValueOnce({items:[entry('first')],nextCursor:'old-cursor',hasMore:true}).mockReturnValueOnce(new Promise(done=>{finish=done;})).mockResolvedValueOnce({items:[entry('new')],nextCursor:null,hasMore:false});
 wrapper=mount(Picker,{props:{memberId:'member',modelValue:[]}});await flushPromises();
 await wrapper.findAll('button').find(button=>button.text()==='加载更多')!.trigger('click');await wrapper.get('input[type=search]').setValue('合成新词');
 expect(wrapper.findAll('button').some(button=>button.text()==='加载更多')).toBe(false);expect(wrapper.findAll('.record-picker-option')).toHaveLength(0);
 finish({items:[entry('stale')],nextCursor:'older',hasMore:true});await flushPromises();await vi.advanceTimersByTimeAsync(250);await flushPromises();
 expect(wrapper.findAll('.record-picker-option strong').map(node=>node.text())).toEqual(['合成资料 new']);expect(api.request.mock.calls.at(-1)![0]).toContain('q=');expect(api.request.mock.calls.at(-1)![0]).not.toContain('cursor=');
});

it('follow-up report selection restricts the query and uses replaceable single selection',async()=>{
 api.request.mockResolvedValue({items:[entry('first'),entry('second'),entry('rx','medication_document')],nextCursor:null});wrapper=mount(Picker,{props:{memberId:'member',modelValue:[],reportOnly:true,maxSelections:1}});await flushPromises();
 expect(api.request.mock.calls[0][0]).toContain('category=report');expect(wrapper.find('.record-picker-filters').exists()).toBe(false);expect(wrapper.findAll('input[type=radio]')).toHaveLength(2);await wrapper.findAll('input[type=radio]')[0].setValue();await wrapper.setProps({modelValue:[{kind:'report',id:'first'}]});await wrapper.findAll('input[type=radio]')[1].setValue();expect(wrapper.emitted('update:modelValue')!.at(-1)).toEqual([[{kind:'report',id:'second'}]]);
});
