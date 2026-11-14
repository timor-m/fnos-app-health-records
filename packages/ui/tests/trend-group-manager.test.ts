import {mount,flushPromises,type VueWrapper} from '@vue/test-utils';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import Manager from '../src/components/TrendGroupManager.vue';
import {useConfirm} from '../src/composables/useConfirm';
const request=vi.hoisted(()=>vi.fn());
vi.mock('../src/utils/api',()=>({request:(...args:unknown[])=>request(...args)}));
const indicators=Array.from({length:7},(_,i)=>({key:`k${i}`,name:`合成指标${i}`,category:'合成分类',aliases:[`Alias${i}`],enabled:true}));
const data={groups:[{key:'builtin',name:'内置组合',source:'builtin',indicatorKeys:['k0','k1','k2','k3']},{key:'mine',name:'已有个人组合',source:'user',indicatorKeys:['k0']}],indicators};
let page:VueWrapper;
const button=(text:string)=>page.findAll('button').find(b=>b.text()===text)!;
const render=()=>page=mount(Manager,{global:{stubs:{Teleport:true}}});
beforeEach(()=>{request.mockReset();request.mockResolvedValue(structuredClone(data));});
afterEach(()=>{page?.unmount();useConfirm().cancel();});

it('copies an immutable built-in into a new personal group and keeps selections while searching aliases',async()=>{
 render();await flushPromises();
 expect(page.text()).toContain('已有个人组合');
 await page.get('[aria-label="复制内置分组"]').setValue('builtin');
 expect(page.text()).toContain('已选 4 项');
 await page.get('[aria-label="分组名称"]').setValue('我的七项');
 await page.get('[aria-label="搜索分组指标"]').setValue('alias4');
 expect(page.findAll('.manager-indicator')).toHaveLength(1);
 await page.get('.manager-indicator input').setValue(true);
 await page.get('[aria-label="搜索分组指标"]').setValue('');
 expect(page.findAll('.manager-indicator input:checked')).toHaveLength(5);
 request.mockResolvedValueOnce({key:'created',name:'我的七项',indicatorKeys:['k0','k1','k2','k3','k4'],source:'user'});
 await page.get('form').trigger('submit');await flushPromises();
 expect(request).toHaveBeenLastCalledWith('trends/groups',{method:'POST',body:JSON.stringify({name:'我的七项',indicatorKeys:['k0','k1','k2','k3','k4']})});
 expect(page.emitted('changed')).toEqual([['created',false]]);expect(page.emitted('close')).toHaveLength(1);
});

it('edits only the personal group and retains the draft after a failed save',async()=>{
 render();await flushPromises();await button('编辑').trigger('click');
 await page.get('[aria-label="分组名称"]').setValue('改名');
 request.mockRejectedValueOnce(new Error('合成保存失败'));
 await page.get('form').trigger('submit');await flushPromises();
 expect(page.get('[role="alert"]').text()).toContain('合成保存失败');
 expect((page.get('[aria-label="分组名称"]').element as HTMLInputElement).value).toBe('改名');
 expect(page.emitted('changed')).toBeUndefined();
 request.mockResolvedValueOnce({key:'mine'});await page.get('form').trigger('submit');await flushPromises();
 expect(request).toHaveBeenLastCalledWith('trends/groups/mine',expect.objectContaining({method:'PUT'}));
 expect(page.emitted('changed')).toEqual([['mine',false]]);
});

it('disables submission while saving and deletes only after the shared confirmation',async()=>{
 render();await flushPromises();await button('删除').trigger('click');
 expect(request).toHaveBeenCalledTimes(1);expect(useConfirm().state.value?.message).toContain('报告和指标数据会保留');
 request.mockResolvedValueOnce({deleted:true}).mockResolvedValueOnce({...data,groups:[data.groups[0]]});
 await useConfirm().confirm();await flushPromises();
 expect(request).toHaveBeenCalledWith('trends/groups/mine',{method:'DELETE'});expect(page.emitted('changed')).toEqual([['mine',true]]);
 await button('新建分组').trigger('click');await page.get('[aria-label="分组名称"]').setValue('合成');await page.get('.manager-indicator input').setValue(true);
 let resolve!:(value:unknown)=>void;request.mockReturnValueOnce(new Promise(r=>{resolve=r;}));
 await page.get('form').trigger('submit');expect(button('保存中…').attributes('disabled')).toBeDefined();
 await page.get('form').trigger('submit');expect(request.mock.calls.filter(c=>c[0]==='trends/groups')).toHaveLength(1);
 resolve({key:'new'});await flushPromises();
});

it('retries management loading and does not offer editing before definitions arrive',async()=>{
 request.mockRejectedValueOnce(new Error('合成读取失败'));render();await flushPromises();
 expect(page.get('[role="alert"]').text()).toContain('合成读取失败');expect(button('新建分组').attributes('disabled')).toBeDefined();
 await button('重试').trigger('click');await flushPromises();expect(page.find('[role="alert"]').exists()).toBe(false);
});
