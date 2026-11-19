import RecordLoading from '../src/components/RecordLoading.vue';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {flushPromises,mount} from '@vue/test-utils';
import {ref} from 'vue';
import {createMemoryHistory,createRouter} from 'vue-router';
import Panel from '../src/components/HealthProcessObservations.vue';
import Editor from '../src/components/ObservationEditorModal.vue';
import type {HealthObservation} from '../../shared/health-observations';
import type {HealthProcessDetail} from '../../shared/health-process';
const mocks=vi.hoisted(()=>({request:vi.fn()}));const app={selectedMemberId:ref('member'),selectedMember:ref({id:'member',permission:'manager'})};
vi.mock('../src/utils/api',()=>({request:mocks.request}));vi.mock('../src/composables/useAppContext',()=>({useAppContext:()=>app}));
const process:HealthProcessDetail={id:'process',memberId:'member',title:'合成历程',summary:null,startedAt:null,latestAt:null,recordCount:2,aiState:'unconfigured',manuallyEdited:false,fingerprint:'source',editToken:'edit',records:[],links:[],highlights:[]};
const entry=(id='update'):HealthObservation=>({ref:{kind:'symptom',id},record:{kind:'symptom',id:'source-symptom'},memberId:'member',name:'发热',recordedAt:'2026-01-02T08:00:00',revision:1,category:'temperature',change:null,severity:null,measurementValue:'38.2',measurementUnit:'℃',amount:null,amountUnit:null,description:null});
const page=(items=[entry()],nextCursor:string|null=null)=>({memberId:'member',processId:'process',items,nextCursor,total:items.length,counts:{symptom:1,temperature:2,intake:1}});
let wrapper:ReturnType<typeof mount>;
beforeEach(()=>{vi.clearAllMocks();app.selectedMemberId.value='member';app.selectedMember.value={id:'member',permission:'manager'};mocks.request.mockResolvedValue(page());});afterEach(()=>{wrapper?.unmount();document.body.innerHTML='';});
async function start(){const router=createRouter({history:createMemoryHistory(),routes:[{path:'/health-processes/process',component:{template:'<div/>'}}]});await router.push('/health-processes/process');await router.isReady();wrapper=mount(Panel,{attachTo:document.body,props:{process},global:{plugins:[router],stubs:{ObservationEditorModal:true}}});await flushPromises();}
it('shows actual-time values and counts, filters in place and opens the exact original observation for editing',async()=>{
 await start();expect(wrapper.get('.observation-list').text()).toContain('38.2 ℃');expect(wrapper.get('.observation-list a').attributes('href')).toContain('source-symptom');
 await wrapper.findAll('.observation-filters button')[2].trigger('click');await flushPromises();expect(mocks.request.mock.calls.at(-1)![0]).toContain('kind=temperature');expect(wrapper.get('.observation-filters [aria-pressed=true]').text()).toBe('体温2');
 await wrapper.get('.observation-heading button').trigger('click');expect(wrapper.getComponent(Editor).props('target')).toEqual({kind:'symptom',id:'update'});
 wrapper.getComponent(Editor).vm.$emit('saved',{...entry(),measurementValue:'37.8',revision:2});await flushPromises();expect(wrapper.get('.observation-receipt').text()).toContain('37.8');expect(wrapper.emitted('updated')).toHaveLength(1);
});
it('paginates, retries from a fresh cursor after an error and retains the revealed window on refresh',async()=>{
 mocks.request.mockResolvedValueOnce(page([entry('one')],'next'));await start();mocks.request.mockResolvedValueOnce(page([entry('two')]));await wrapper.get('.observation-more').trigger('click');await flushPromises();expect(wrapper.findAll('.observation-list>li')).toHaveLength(2);expect(mocks.request.mock.calls.at(-1)![0]).toContain('cursor=next');
 mocks.request.mockResolvedValueOnce(page([entry('one')],'new-next')).mockResolvedValueOnce(page([entry('two')]));await wrapper.setProps({process:{...process,fingerprint:'changed'}});await flushPromises();expect(wrapper.findAll('.observation-list>li')).toHaveLength(2);
});
it('does not expose editing to viewers and clears old member data immediately',async()=>{
 app.selectedMember.value.permission='viewer';await start();expect(wrapper.find('.observation-heading button').exists()).toBe(false);app.selectedMemberId.value='other';await flushPromises();expect(wrapper.find('.process-observations').exists()).toBe(false);expect(wrapper.findComponent(Editor).exists()).toBe(false);
});

it('returns focus to the selected entry on cancel and to the saved receipt after correction',async()=>{
 mocks.request.mockResolvedValue(page([entry('one'),entry('two')]));await start();
 const opener=wrapper.findAll('.observation-heading button')[1];await opener.trigger('click');expect(wrapper.getComponent(Editor).props('returnFocus')).toBe(opener.element);
 wrapper.getComponent(Editor).vm.$emit('close');await flushPromises();expect(document.activeElement).toBe(opener.element);
 await opener.trigger('click');wrapper.getComponent(Editor).vm.$emit('saved',entry('two'));await flushPromises();expect(document.activeElement).toBe(wrapper.get('.observation-receipt button').element);
});

it('hides an empty changes module but preserves filters when other categories still have data',async()=>{
 mocks.request.mockResolvedValue({...page([]),counts:{symptom:0,temperature:0,intake:0}});await start();expect(wrapper.find('.process-observations').exists()).toBe(false);
 mocks.request.mockResolvedValue({...page([]),counts:{symptom:0,temperature:1,intake:0}});await wrapper.setProps({process:{...process,fingerprint:'changed'}});await flushPromises();expect(wrapper.find('.process-observations').exists()).toBe(true);expect(wrapper.find('.observation-filters').exists()).toBe(true);
});

it('uses the shared centered loader for initial and filtered reads and retains loaded entries on refresh',async()=>{
 let finish!:(value:ReturnType<typeof page>)=>void;mocks.request.mockReturnValueOnce(new Promise(resolve=>{finish=resolve;}));await start();
 expect(wrapper.getComponent(RecordLoading).props('label')).toBe('正在读取变化明细…');
 finish(page());await flushPromises();expect(wrapper.findComponent(RecordLoading).exists()).toBe(false);
 mocks.request.mockReturnValueOnce(new Promise(resolve=>{finish=resolve;}));await wrapper.setProps({process:{...process,fingerprint:'refresh'}});
 expect(wrapper.findComponent(RecordLoading).exists()).toBe(false);expect(wrapper.find('.observation-list').exists()).toBe(true);finish(page());await flushPromises();
 mocks.request.mockReturnValueOnce(new Promise(resolve=>{finish=resolve;}));await wrapper.findAll('.observation-filters button')[2].trigger('click');
 expect(wrapper.findComponent(RecordLoading).exists()).toBe(true);finish(page());await flushPromises();expect(wrapper.findComponent(RecordLoading).exists()).toBe(false);
});

it('uses the shared initial page without an extra request, while filters still read independently',async()=>{
 const router=createRouter({history:createMemoryHistory(),routes:[{path:'/',component:{template:'<div/>'}}]});await router.push('/');
 wrapper=mount(Panel,{props:{process,initialLoad:Promise.resolve({processId:'process',memberId:'member',fingerprint:'source',observations:{data:page()}} as any)},global:{plugins:[router]}});await flushPromises();
 expect(mocks.request).not.toHaveBeenCalled();expect(wrapper.get('.observation-list').text()).toContain('38.2');await wrapper.findAll('.observation-filters button')[2].trigger('click');await flushPromises();expect(mocks.request).toHaveBeenCalledTimes(1);
});
it('rejects a foreign initial page and lets the user retry the module on its own',async()=>{
 const router=createRouter({history:createMemoryHistory(),routes:[{path:'/',component:{template:'<div/>'}}]});await router.push('/');
 wrapper=mount(Panel,{props:{process,initialLoad:Promise.resolve({processId:'process',memberId:'other',fingerprint:'source',observations:{data:page()}} as any)},global:{plugins:[router]}});await flushPromises();
 expect(wrapper.get('[role=alert]').text()).toContain('不一致');expect(wrapper.find('.observation-list').exists()).toBe(false);
 await wrapper.get('.error-retry').trigger('click');await flushPromises();expect(wrapper.find('.observation-list').exists()).toBe(true);
});
