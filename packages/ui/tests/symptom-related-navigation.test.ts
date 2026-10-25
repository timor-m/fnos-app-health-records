import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { createMemoryHistory, createRouter, RouterLink } from 'vue-router';
import Associations from '../src/components/HealthRecordAssociations.vue';

const mocks=vi.hoisted(()=>({request:vi.fn()}));
const app={selectedMemberId:ref('member'),selectedMember:ref({id:'member',permission:'manager'}),dataVersion:ref(0),notifyDataChanged:vi.fn()};
vi.mock('../src/utils/api',()=>({request:mocks.request}));
vi.mock('../src/composables/useAppContext',()=>({useAppContext:()=>app}));
const wrappers:ReturnType<typeof mount>[]=[];
afterEach(()=>wrappers.splice(0).forEach(wrapper=>wrapper.unmount()));

it('opens the shared process from a symptom detail without repeating its related record cards',async()=>{
 const router=createRouter({history:createMemoryHistory(),routes:[{path:'/events',component:{template:'<div/>'}},{path:'/health-processes/:id',component:{template:'<div/>'}}]});
 await router.push('/events');await router.isReady();
 mocks.request.mockResolvedValue({memberId:'member',subject:{kind:'symptom',id:'symptom'},title:'合成症状',processes:[{id:'process',memberId:'member',title:'合成历程',recordCount:2}],availableProcesses:[],evidence:[],records:[{entry:{id:'report:report',kind:'report',resourceId:'report',memberId:'member',category:'report',title:'合成报告',date:'2026-01-01',status:'ready'},processIds:[],detachableProcessIds:[]}]});
 const wrapper=mount(Associations,{props:{subject:{kind:'symptom',id:'symptom'},memberId:'member',compact:true,openInPlace:true},global:{plugins:[router]}});wrappers.push(wrapper);await flushPromises();
 expect(wrapper.findAllComponents(RouterLink)).toHaveLength(1);
 expect(wrapper.find('.association-records').exists()).toBe(false);await wrapper.get('.association-process-entry').trigger('click',{button:0});await flushPromises();
 expect(router.currentRoute.value.path).toBe('/health-processes/process');expect(router.currentRoute.value.query.returnTo).toBe('/events');expect(wrapper.emitted('openRecord')).toBeUndefined();
});
