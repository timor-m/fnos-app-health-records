import { flushPromises, shallowMount } from '@vue/test-utils';
import { beforeEach, expect, it, vi } from 'vitest';
import { nextTick, reactive, ref } from 'vue';
import RecordsPage from '../src/pages/RecordsPage.vue';

const mocks = vi.hoisted(() => ({ request: vi.fn(), context: { app: null as any, route: null as any, refresh: null as null | (() => void) } }));
vi.mock('../src/utils/api', () => ({ request: mocks.request, apiUrl: (path: string) => path }));
vi.mock('../src/composables/useAppContext', () => ({ useAppContext: () => mocks.context.app }));
vi.mock('../src/composables/useRefreshOnActivate', () => ({ useRefreshOnActivate: (refresh: () => void) => { mocks.context.refresh = refresh; } }));
vi.mock('vue-router', () => ({ useRoute: () => mocks.context.route, useRouter: () => ({ replace: vi.fn().mockResolvedValue(undefined) }) }));
const report = (id: string, memberId = 'member') => ({
  id, memberId, title: id, reportType: 'laboratory', status: 'ready', reportIssuedAt: '2026-09-01',
  hospitalName: null, departmentName: null, bodyPart: null, pageCount: 1, abnormalCount: 0
});

beforeEach(() => {
  mocks.context.app = {
    selectedMemberId: ref('member'), setTopbarSubtitle: vi.fn(), clearTopbarSubtitle: vi.fn(),
    setTopbarSearch: vi.fn(), clearTopbarSearch: vi.fn()
  };
  mocks.context.route = reactive({ path: '/records', query: { reportId: 'target' } });
  vi.spyOn(window, 'matchMedia').mockImplementation(() => ({ matches: true } as MediaQueryList));
  mocks.request.mockReset();
  mocks.request.mockImplementation(async (path: string) => {
    if (path.startsWith('reports?')) return { items: [report('target')], hasMore: false, nextCursor: null };
    if (path.startsWith('reports/summary?')) return { totalReports: 1, totalPages: 1 };
    return report('target');
  });
});

it('手机从事件卡片携带 reportId 进入时直接打开报告详情', async () => {
  const wrapper = shallowMount(RecordsPage);
  await flushPromises();
  expect(wrapper.findComponent({ name: 'ReportDetailSheet' }).props('reportId')).toBe('target');
  wrapper.unmount();
});

it('桌面使用已有详情面板，不打开手机弹层', async () => {
  vi.spyOn(window, 'matchMedia').mockImplementation(() => ({ matches: false } as MediaQueryList));
  const wrapper = shallowMount(RecordsPage);
  await flushPromises();
  expect(wrapper.findComponent({ name: 'ReportDetail' }).props('reportId')).toBe('target');
  expect(wrapper.findComponent({ name: 'ReportDetailSheet' }).exists()).toBe(false);
  wrapper.unmount();
});

it('目标报告在列表第一页之外时按 ID 加载，并打开该报告', async () => {
  const original = mocks.request.getMockImplementation()!;
  mocks.request.mockImplementation(async (path: string) => path.startsWith('reports?')
    ? { items: [report('newer')], hasMore: true, nextCursor: 'next' } : original(path));
  const wrapper = shallowMount(RecordsPage);
  await flushPromises();
  expect(mocks.request).toHaveBeenCalledWith('reports/target');
  expect(wrapper.findComponent({ name: 'ReportDetailSheet' }).props()).toMatchObject({ reportId: 'target', summary: { id: 'target' } });
  wrapper.findComponent({ name: 'ReportDetailSheet' }).vm.$emit('close');
  await nextTick();
  mocks.context.refresh?.();
  await flushPromises();
  expect(wrapper.findComponent({ name: 'ReportDetail' }).props('reportId')).toBe('target');
  expect(wrapper.findComponent({ name: 'ReportDetailSheet' }).exists()).toBe(false);
  wrapper.unmount();
});

it('异步获取的报告属于其他成员时不加入当前列表或弹出详情', async () => {
  const original = mocks.request.getMockImplementation()!;
  mocks.request.mockImplementation(async (path: string) => path.startsWith('reports?')
    ? { items: [], hasMore: false, nextCursor: null } : path === 'reports/target' ? report('target', 'other') : original(path));
  const wrapper = shallowMount(RecordsPage);
  await flushPromises();
  expect(wrapper.findComponent({ name: 'ReportDetailSheet' }).exists()).toBe(false);
  expect(wrapper.text()).toContain('该报告不属于当前成员');
  wrapper.unmount();
});

it('用户已切换成员时丢弃之前报告的迟到响应', async () => {
  let resolveTarget!: (value: unknown) => void;
  const original = mocks.request.getMockImplementation()!;
  mocks.request.mockImplementation((path: string) => path.startsWith('reports?')
    ? Promise.resolve({ items: [], hasMore: false, nextCursor: null })
    : path === 'reports/target' ? new Promise(resolve => { resolveTarget = resolve; }) : original(path));
  const wrapper = shallowMount(RecordsPage);
  await flushPromises();
  mocks.context.route.query.reportId = undefined;
  mocks.context.app.selectedMemberId.value = 'other';
  await nextTick();
  resolveTarget(report('target'));
  await flushPromises();
  expect(wrapper.findComponent({ name: 'ReportDetailSheet' }).exists()).toBe(false);
  expect(wrapper.findComponent({ name: 'ReportDetail' }).exists()).toBe(false);
  wrapper.unmount();
});

it('从报告预览返回创建草稿时移除手机浮层', async () => {
 const wrapper=shallowMount(RecordsPage); await flushPromises();
 expect(wrapper.findComponent({ name: 'ReportDetailSheet' }).exists()).toBe(true);
 mocks.context.route.path='/add/event'; await nextTick();
 expect(wrapper.findComponent({ name: 'ReportDetailSheet' }).exists()).toBe(false); wrapper.unmount();
});

it('keeps the unavailable imaging filter last while retaining report detail access',async()=>{
 const wrapper=shallowMount(RecordsPage);await flushPromises();
 const control=wrapper.findAllComponents({name:'FormSelect'}).find(item=>item.props('ariaLabel')==='报告类型')!;
 expect(control.props('options').at(-1)).toEqual({value:'imaging',label:'影像（暂未开放）',disabled:true});wrapper.unmount();
});
