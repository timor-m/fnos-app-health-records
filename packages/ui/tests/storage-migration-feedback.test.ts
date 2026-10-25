import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import StorageSettingsPage from '../src/pages/settings/StorageSettingsPage.vue';
import { useConfirm } from '../src/composables/useConfirm';

const mocks = vi.hoisted(() => ({request:vi.fn(),toast:vi.fn()}));
vi.mock('../src/utils/api',()=>({request:mocks.request}));
vi.mock('../src/composables/useToast',()=>({useToast:()=>({show:mocks.toast})}));
const status={storageDir:'/synthetic/archive',runtimeDir:'/synthetic/runtime',state:'ready',error:null,
  availableBytes:1024**3,capacityBytes:1024**4,deployment:'fnos',migrationAvailable:true,paused:false,
  roots:[{id:'target',path:'/synthetic/target'}],migration:null};
let page:ReturnType<typeof mount>;
const confirm=useConfirm();
beforeEach(()=>{vi.clearAllMocks();confirm.cancel();mocks.request.mockResolvedValue(status);});
afterEach(()=>{page?.unmount();confirm.cancel();});
async function selectTarget(rootId = 'target'){
  page=mount(StorageSettingsPage,{global:{stubs:{SubPageHeader:true,FormSelect:{name:'FormSelect',props:['modelValue','options'],emits:['update:modelValue'],setup:()=>({rootId}),template:'<button @click="$emit(\'update:modelValue\', rootId)">select target</button>'}}}});
  await flushPromises();await page.find('.archive-target button').trigger('click');
}
it('shows pending preflight beside the action, blocks duplicate requests and opens confirmation only after success',async()=>{
  await selectTarget();let resolve!:(value:unknown)=>void;
  mocks.request.mockImplementation(()=>new Promise(done=>{resolve=done;}));
  const action=page.find('.archive-migration-form .primary-button');await action.trigger('click');
  expect(action.text()).toContain('检查中');
  expect(action.attributes('disabled')).toBeDefined();
  expect(page.find('.archive-migration-form').element.parentElement!.textContent).toContain('正在检查');
  expect(confirm.state.value).toBeNull();
  await action.trigger('click');expect(mocks.request).toHaveBeenCalledTimes(2); // status + one preflight
  resolve({files:2,bytes:1024,parent:'/synthetic/target'});await flushPromises();
  expect(confirm.state.value?.title).toBe('迁移档案存储');
  expect(mocks.request.mock.calls.some(([path])=>path==='storage/migrate')).toBe(false);
  expect(action.text()).toBe('检查并迁移');
});
it('keeps preflight errors next to migration controls rather than only in the current-storage section',async()=>{
  await selectTarget();mocks.request.mockRejectedValueOnce(new Error('合成预检失败'));
  await page.find('.archive-migration-form .primary-button').trigger('click');await flushPromises();
  const sections=page.findAll('.archive-storage-body');
  expect(sections[1].find('[role="alert"]').text()).toBe('合成预检失败');
  expect(mocks.toast).toHaveBeenCalledExactlyOnceWith('合成预检失败',5000);
  expect(sections[0].find('[role="alert"]').exists()).toBe(false);
  expect(page.find('.archive-migration-form .primary-button').attributes('disabled')).toBeUndefined();
  expect(confirm.state.value).toBeNull();
});

it('reports start failures through toast and the migration area without clearing the stored reason',async()=>{
  await selectTarget();
  mocks.request.mockImplementation(async path=>{
    if(path==='storage/preview') return {files:2,bytes:1024,parent:'/synthetic/target'};
    throw new Error('合成启动失败');
  });
  await page.find('.archive-migration-form .primary-button').trigger('click');await flushPromises();
  await confirm.confirm();await flushPromises();
  expect(mocks.toast).toHaveBeenCalledExactlyOnceWith('合成启动失败',5000);
  expect(page.findAll('.archive-storage-body')[1].find('[role="alert"]').text()).toBe('合成启动失败');
  expect(confirm.state.value).toBeNull();
  expect(page.find('.archive-migration-form .primary-button').attributes('disabled')).toBeUndefined();
});
it('reports refresh failures through toast while retaining the reason on the page',async()=>{
  await selectTarget();mocks.request.mockRejectedValueOnce(new Error('合成读取失败'));
  await page.find('.header-action').trigger('click');await flushPromises();
  expect(mocks.toast).toHaveBeenCalledExactlyOnceWith('合成读取失败',5000);
  expect(page.findAll('.archive-storage-body')[0].find('[role="alert"]').text()).toBe('合成读取失败');
});
it.each(['preview','cleanup'])('reports old-copy %s failures through toast',async stage=>{
  mocks.request.mockResolvedValueOnce({...status,migration:{id:'synthetic-migration',source:'/synthetic/old',phase:'completed',cleanupAvailable:true,cleaning:false,error:null}});
  await selectTarget();
  mocks.request.mockImplementation(async path=>{
    if(path==='storage/cleanup-preview'&&stage==='cleanup')return{source:'/synthetic/old',files:2,bytes:1024,skipped:0};
    throw new Error('合成清理失败');
  });
  await page.find('.archive-cleanup button').trigger('click');await flushPromises();
  if(stage==='cleanup'){await confirm.confirm();await flushPromises();}
  expect(mocks.toast).toHaveBeenCalledExactlyOnceWith('合成清理失败',5000);
  expect(page.findAll('.archive-storage-body')[0].find('[role="alert"]').text()).toBe('合成清理失败');
});

it('offers the labeled default target and confirms a verified return instead of treating it as a fresh external directory',async()=>{
  mocks.request.mockResolvedValueOnce({...status,relocated:true,roots:[{id:'default',path:'/synthetic/runtime',label:'默认位置 · /synthetic/runtime'}]});
  await selectTarget('default');
  expect(page.findComponent({name:'FormSelect'}).props('options')[0].label).toContain('默认位置');
  mocks.request.mockResolvedValueOnce({files:3,bytes:1024,parent:'/synthetic/runtime',target:'/synthetic/runtime',returnToDefault:true});
  await page.find('.archive-migration-form .primary-button').trigger('click');await flushPromises();
  expect(confirm.state.value?.title).toBe('迁回默认位置');
  expect(confirm.state.value?.message).toContain('默认目录中的旧档案会另行保留');
  expect(confirm.state.value?.message).not.toContain('下的专属目录');
  expect(JSON.parse(mocks.request.mock.calls.at(-1)![1].body)).toEqual({rootId:'default'});
  expect(mocks.request.mock.calls.some(([path])=>path==='storage/migrate')).toBe(false);
});
