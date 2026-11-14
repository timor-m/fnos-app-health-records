import {shallowMount,flushPromises,type VueWrapper} from '@vue/test-utils';
import {ref} from 'vue';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import Page from '../src/pages/MorphologyTrendsPage.vue';
import {useConfirm} from '../src/composables/useConfirm';
const {request,context}=vi.hoisted(()=>({request:vi.fn(),context:{app:null as any}}));
vi.mock('../src/utils/api',()=>({request:(...args:unknown[])=>request(...args),apiUrl:(x:string)=>x}));
vi.mock('../src/composables/useAppContext',()=>({useAppContext:()=>context.app}));
vi.mock('../src/composables/useRefreshOnActivate',()=>({useRefreshOnActivate:()=>{}}));
vi.mock('vue-router',()=>({useRoute:()=>({path:'/trends/morphology',query:{}})}));
const point={findingId:'f',reportId:'r',reportTitle:'合成报告',reportIssuedAt:'2026-01-01',findingName:'合成囊肿',organ:'肝脏',findingType:'囊肿',presence:'present',laterality:'right',size:{length:8,width:null,height:null,unit:'mm',label:'8mm',primaryMm:8},classification:null,rawText:'合成原文',morphology:null,sourcePage:null};
const series={trackingGroupId:'group',name:'合成囊肿',organ:'肝脏',region:null,findingType:'囊肿',laterality:'right',pointCount:1,points:[point],latest:point,changeKind:'baseline',changeSummary:'目前只有一次报告记录'};
const data={summary:{groups:1,findings:1,untracked:0},series:[series],untracked:[]};
let w:VueWrapper;
const render=()=>w=shallowMount(Page,{global:{stubs:{Teleport:true,RouterLink:true}}});
beforeEach(()=>{context.app={selectedMemberId:ref('member'),selectedMember:ref({permission:'manager'}),dataVersion:ref(0),notifyDataChanged:vi.fn(),setTopbarSubtitle:vi.fn(),clearTopbarSubtitle:vi.fn(),setTopbarSearch:vi.fn(),clearTopbarSearch:vi.fn()};request.mockReset();request.mockResolvedValue(structuredClone(data));});
afterEach(()=>{w?.unmount();useConfirm().cancel();});
it('exposes creation and record deletion via shared editor and confirmation then refreshes the series',async()=>{
 render();await flushPromises();await w.findAll('button').find(b=>b.text()==='补充记录')!.trigger('click');
 const editor=w.findComponent({name:'MorphologyFindingEditor'});expect(editor.props('open')).toBe(true);expect(editor.props('memberId')).toBe('member');editor.vm.$emit('close');await flushPromises();
 await w.get('[title="删除形态记录"]').trigger('click');expect(request).toHaveBeenCalledTimes(1);expect(useConfirm().state.value?.message).toContain('原件不会删除');
 request.mockResolvedValueOnce({summary:{groups:0,findings:0,untracked:0},series:[],untracked:[]});
 await useConfirm().confirm();await flushPromises();expect(request).toHaveBeenCalledWith('morphology-findings/f/ignore',{method:'POST'});expect(w.find('[title="删除形态记录"]').exists()).toBe(false);
});
it('hides write actions for a viewer and closes the editor when switching members',async()=>{
 render();await flushPromises();await w.findAll('button').find(b=>b.text()==='补充记录')!.trigger('click');
 context.app.selectedMemberId.value='other';context.app.selectedMember.value={permission:'viewer'};await flushPromises();
 expect(w.findComponent({name:'MorphologyFindingEditor'}).props('open')).toBe(false);
 expect(w.find('[title="删除形态记录"]').exists()).toBe(false);expect(w.text()).not.toContain('校对记录');expect(w.text()).not.toContain('补充记录');
});

it('does not replace the newly selected member with an earlier delete response',async()=>{
 render();await flushPromises();await w.get('[title="删除形态记录"]').trigger('click');
 let resolve!:(v:unknown)=>void;request.mockReturnValueOnce(new Promise(r=>{resolve=r;}));
 const pending=useConfirm().confirm();await flushPromises();context.app.selectedMemberId.value='other';await flushPromises();
 expect(w.find('[title="删除形态记录"]').exists()).toBe(true);
 resolve({summary:{groups:0,findings:0,untracked:0},series:[],untracked:[]});await pending;await flushPromises();
 expect(w.find('[title="删除形态记录"]').exists()).toBe(true);
});
