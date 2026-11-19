import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {flushPromises,mount} from '@vue/test-utils';
import {ref} from 'vue';
import {createMemoryHistory,createRouter} from 'vue-router';
import Page from '../src/pages/HealthProcessDetailPage.vue';
import type {HealthProcessDetail} from '../../shared/health-process';
import {useConfirm} from '../src/composables/useConfirm';
const api=vi.hoisted(()=>({request:vi.fn()}));
const touch=ref(true);
const app={selectedMemberId:ref('member'),selectedMember:ref({id:'member',permission:'manager'}),dataVersion:ref(0),notifyDataChanged:vi.fn()};
vi.mock('../src/components/HealthProcessCarePanel.vue',()=>({default:{template:'<div/>'}}));
vi.mock('../src/composables/useAppContext',()=>({useAppContext:()=>app}));
vi.mock('../src/composables/useTouchRecordDetail',()=>({useTouchRecordDetail:()=>touch}));
vi.mock('../src/components/HealthRecordDetailModal.vue',()=>({default:{props:['open','kind','recordId'],emits:['close'],template:'<div v-if="open" role="dialog">{{kind}}:{{recordId}}<button @click="$emit(\'close\')">关闭详情</button></div>'}}));
const process:HealthProcessDetail={id:'process',memberId:'member',title:'合成过程',summary:null,startedAt:null,latestAt:null,recordCount:2,aiState:'unconfigured',manuallyEdited:false,fingerprint:'source',editToken:'edit',highlights:[],links:[],records:['a','b'].map(id=>({ref:{kind:'report',id},title:`合成报告 ${id}`,date:null,latestDate:null,category:'report',stage:'examination',stageSource:'record',description:null,institution:null,version:id}))};
vi.mock('../src/utils/api',()=>({request:api.request}));
let wrapper:ReturnType<typeof mount>;
let router:ReturnType<typeof createRouter>;
async function start(url='/health-processes/process?returnTo=/events'){
 router=createRouter({history:createMemoryHistory(),routes:[{path:'/health-processes/:id',component:Page},{path:'/events/detail/:kind/:id',component:{template:'<div class="record-page"/>'}}]});
 await router.push(url);await router.isReady();
 wrapper=mount({template:'<RouterView/>'},{attachTo:document.body,global:{plugins:[router],stubs:{HealthProcessFollowups:true}}});await flushPromises();
}
const settleHistory=async()=>{await new Promise(resolve=>setTimeout(resolve,0));await flushPromises();};
beforeEach(()=>{touch.value=true;app.selectedMemberId.value='member';api.request.mockReset();api.request.mockResolvedValue(process);});
afterEach(()=>{wrapper?.unmount();useConfirm().cancel();});
it('touch opens the shared detail over the same timeline and close restores its route and focus',async()=>{
 await start();const list=wrapper.get('.process-stages').element;const link=wrapper.findAll('.process-record')[0];
 await link.trigger('click',{button:0});await flushPromises();expect(router.currentRoute.value.query).toMatchObject({returnTo:'/events',recordKind:'report',recordId:'a'});
 expect(wrapper.get('.process-stages').element).toBe(list);expect(wrapper.get('[role="dialog"]').text()).toContain('report:a');
 await wrapper.get('[role="dialog"] button').trigger('click');await settleHistory();
 expect(router.currentRoute.value.query).toEqual({returnTo:'/events'});expect(wrapper.find('[role="dialog"]').exists()).toBe(false);expect(document.activeElement).toBe(link.element);
});
it('browser back closes a touch detail without leaving the process',async()=>{
 await start();await wrapper.findAll('.process-record')[1].trigger('click',{button:0});await flushPromises();router.back();await settleHistory();
 expect(router.currentRoute.value.path).toBe('/health-processes/process');expect(wrapper.find('[role="dialog"]').exists()).toBe(false);
});
it('a directly shared detail query closes by replacement without leaving the process',async()=>{
 await start('/health-processes/process?recordKind=report&recordId=b&returnTo=/events');await wrapper.get('[role="dialog"] button').trigger('click');await flushPromises();
 expect(router.currentRoute.value.fullPath).toBe('/health-processes/process?returnTo=/events');expect(wrapper.find('[role="dialog"]').exists()).toBe(false);
});
it('desktop follows the record page and preserves the process return location',async()=>{
 touch.value=false;await start();await wrapper.findAll('.process-record')[0].trigger('click',{button:0});await flushPromises();
 expect(router.currentRoute.value.path).toBe('/events/detail/report/a');expect(router.currentRoute.value.query.returnTo).toBe('/health-processes/process?returnTo=/events');expect(wrapper.find('.record-page').exists()).toBe(true);
});
it('removing one of two records releases the saving guard before returning to the original record',async()=>{
 await start('/health-processes/process?returnTo=/events/detail/report/a');await wrapper.get('[aria-label="移出历程：合成报告 a"]').trigger('click');
 api.request.mockResolvedValueOnce({memberId:'member',removed:{kind:'report',id:'a'},process:null});await useConfirm().confirm();await flushPromises();
 expect(router.currentRoute.value.path).toBe('/events/detail/report/a');expect(wrapper.find('.record-page').exists()).toBe(true);expect(useConfirm().state.value).toBeNull();
});
