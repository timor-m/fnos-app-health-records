import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {flushPromises,mount} from '@vue/test-utils';
import {ref} from 'vue';
import Page from '../src/pages/settings/AiAuditSettingsPage.vue';
const mocks=vi.hoisted(()=>({request:vi.fn(),reactivate:vi.fn()}));
vi.mock('../src/utils/api',()=>({request:mocks.request}));
vi.mock('../src/composables/useRefreshOnActivate',()=>({useRefreshOnActivate:(load:()=>unknown)=>mocks.reactivate.mockImplementation(load)}));
vi.mock('../src/composables/usePullRefresh',()=>({usePullRefresh:()=>({pullDistance:ref(0),refreshing:ref(false),refresh:vi.fn()})}));
vi.mock('../src/composables/useToast',()=>({useToast:()=>({show:vi.fn()})}));
let wrapper:ReturnType<typeof mount>;
beforeEach(()=>{vi.clearAllMocks();vi.stubGlobal('IntersectionObserver',class{observe(){}disconnect(){}});});
afterEach(()=>{wrapper?.unmount();vi.unstubAllGlobals();});
it('shows process organization as its own AI task with running status, actual usage and completion',async()=>{
 const item={id:'audit',source:'health_process_summary',reportTitle:'合成健康历程',status:'processing',attempts:1,createdAt:'2026-01-01 10:00:00',model:'synthetic-model',promptTokens:null,completionTokens:null,elapsedMs:null};
 const data=(status:string)=>({summary:{jobCount:1,callCount:1,successJobs:status==='completed'?1:0,failedJobs:0,processingJobs:status==='processing'?1:0,queuedJobs:0,promptTokens:120,completionTokens:40,totalTokens:160,avgElapsedMs:650},recent:[{...item,status,promptTokens:120,completionTokens:40,elapsedMs:650}],hasMore:false,nextCursor:null});
 mocks.request.mockResolvedValue(data('processing'));wrapper=mount(Page,{global:{stubs:{SubPageHeader:true,PullIndicator:true}}});await flushPromises();
 const row=wrapper.get('.ai-audit-list article');expect(row.text()).toContain('合成健康历程');expect(row.text()).toContain('健康历程整理');expect(row.get('em').text()).toBe('处理中');expect(row.text()).toContain('160 tokens');
 mocks.request.mockResolvedValue(data('completed'));await mocks.reactivate();await flushPromises();expect(wrapper.get('.ai-audit-list article em').text()).toBe('成功');
});
