import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {flushPromises,mount} from '@vue/test-utils';
import {createRouter,createMemoryHistory} from 'vue-router';
import Panel from '../src/components/HealthRecordIndexPanel.vue';
const mocks=vi.hoisted(()=>({request:vi.fn()}));vi.mock('../src/utils/api',()=>({request:mocks.request}));
let wrapper:ReturnType<typeof mount>;let router:ReturnType<typeof createRouter>;
const settle=async()=>{await new Promise(resolve=>setTimeout(resolve,230));await flushPromises();};
const sample=(memberId='member',kind='diagnosis',name:string|null=null)=>({memberId,kind,name,entries:name?[]:[{key:'合成名称',name:'合成名称',count:2,lastAt:'2026-01-01'}],records:name?[{ref:{kind:'report',id:'source'},title:'合成原报告',date:'2026-01-01',latestDate:'2026-01-01',institution:'合成机构',description:'合成原文',medications:['合成药品']}]:[],processes:[],total:name?1:1,nextCursor:null});
beforeEach(()=>{vi.clearAllMocks();mocks.request.mockImplementation(async(path:string)=>{const query=new URLSearchParams(path.split('?')[1]);return sample(query.get('memberId')!,query.get('kind')!,query.get('name')||null);});});
afterEach(()=>wrapper?.unmount());
async function start(){router=createRouter({history:createMemoryHistory(),routes:[{path:'/health-processes',component:{template:'<div/>'}}]});await router.push('/health-processes?view=index');await router.isReady();wrapper=mount(Panel,{props:{memberId:'member'},global:{plugins:[router]}});await settle();}
it('browses source records by diagnosis or symptom, preserves return context and never shows creation or a disease inference',async()=>{
 await start();expect(wrapper.text()).toContain('不代表当前仍患有该疾病');await wrapper.get('.health-index-grid button').trigger('click');await settle();
 expect(router.currentRoute.value.query.indexName).toBe('合成名称');expect(wrapper.get('.health-index-records').text()).toContain('报告所列用药');expect(wrapper.get('.health-index-records a').attributes('href')).toContain('returnTo=');expect(wrapper.text()).toContain('不代表已服用');
 await wrapper.findAll('.health-index-tabs button')[1].trigger('click');await settle();expect(router.currentRoute.value.query.indexName).toBeUndefined();expect(wrapper.text()).toContain('不将症状视为诊断');
});
it('clears the previous member immediately and ignores its late response',async()=>{
 await start();let resolve!:(value:unknown)=>void;mocks.request.mockImplementationOnce(()=>new Promise(done=>{resolve=done;}));await wrapper.setProps({memberId:'other'});await settle();
 await wrapper.setProps({memberId:'third'});await settle();resolve(sample('other'));await flushPromises();expect(wrapper.text()).toContain('合成名称');expect(mocks.request.mock.calls.at(-1)![0]).toContain('memberId=third');expect(wrapper.find('[role=alert]').exists()).toBe(false);
});
