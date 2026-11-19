import { shallowMount, flushPromises } from '@vue/test-utils';
import { ref } from 'vue';
import { beforeEach, expect, it, vi } from 'vitest';
import Timeline from '../src/pages/HealthEventsPage.vue';
const mock = vi.hoisted(() => ({ request: vi.fn(), push: vi.fn() }));
const route={path:'/events',fullPath:'/events',params:{},query:{}};
const app={setTopbarSearch:vi.fn(),clearTopbarSearch:vi.fn(),selectedMemberId:ref('member'),selectedMember:ref({id:'member',permission:'manager'}),dataVersion:ref(0)};
vi.mock('vue-router',()=>({useRoute:()=>route,useRouter:()=>({push:mock.push}),RouterLink:{props:['to'],template:'<a><slot/></a>'}}));
vi.mock('../src/utils/api',()=>({request:mock.request}));
vi.mock('../src/composables/useAppContext',()=>({useAppContext:()=>app}));
beforeEach(()=>vi.clearAllMocks());
it('feed failure offers retry without exposing stale event cards',async()=>{
 route.path=route.fullPath='/events';mock.request.mockRejectedValue(new Error('读取失败'));
 const w=shallowMount(Timeline);await flushPromises();expect(w.text()).toContain('读取失败');expect(w.text()).toContain('重试');w.unmount();
});
