import { shallowMount } from '@vue/test-utils';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { reactive, ref } from 'vue';
import AppShell from '../src/layouts/AppShell.vue';
import QuickAddMenu from '../src/components/QuickAddMenu.vue';

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  replace: vi.fn(),
  refreshReminderCount: vi.fn(),
  app: null as any,
  route: null as any
}));

vi.mock('../src/utils/api', () => ({ request: (...args: unknown[]) => mocks.request(...args) }));
vi.mock('../src/composables/useAppContext', () => ({ useAppContext: () => mocks.app }));
vi.mock('vue-router', () => ({
  useRoute: () => mocks.route,
  useRouter: () => ({ replace: mocks.replace })
}));

function mountShell() {
  return shallowMount(AppShell, {
    global: {
      stubs: {
        RouterLink: { props: ['to'], template: '<a :href="to"><slot /></a>' },
        RouterView: true
      }
    }
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.route = reactive({ path: '/events', fullPath: '/events', meta: {} });
  mocks.app = {
    session: ref({ id: 'admin', displayName: '管理员', provider: 'development', isAdmin: true }),
    selectedMemberId: ref('member-a'),
    selectedMember: ref({ id: 'member-a', displayName: '示例成员', permission: 'manager' }),
    pendingReminderCount: ref(2),
    topbarSubtitles: ref({}),
    topbarSearch: ref(null),
    accessVersion: ref(0),
    refreshReminderCount: mocks.refreshReminderCount
  };
  mocks.request.mockResolvedValue({ ocrInstalled: true, aiConfigured: true, guideDismissed: true });
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

it('keeps reminders accessible without a member and refreshes the feedback badge once after startup', async () => {
  mocks.app.selectedMemberId.value = '';
  mocks.app.selectedMember.value = null;
  mocks.route.path = mocks.route.fullPath = '/reminders';
  const wrapper = mountShell();
  expect(wrapper.find('member-manager-stub').exists()).toBe(false);
  expect(wrapper.find('router-view-stub').exists()).toBe(true);
  expect(wrapper.findAll('a[href="/me"] .nav-badge').map(badge => badge.text())).toEqual(['2', '2']);
  await vi.advanceTimersByTimeAsync(29999);
  expect(mocks.refreshReminderCount).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(mocks.refreshReminderCount).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(60000);
  expect(mocks.refreshReminderCount).toHaveBeenCalledTimes(1);
  wrapper.unmount();
});

it('keeps event navigation and both quick-add entries when switching members from a health process', async () => {
  mocks.route.path = mocks.route.fullPath = '/health-processes/example';
  const wrapper = mountShell();
  const eventLinks = wrapper.findAll('a[href="/events"]');
  expect(eventLinks).toHaveLength(2);
  expect(eventLinks.every(link => link.classes().includes('router-link-active'))).toBe(true);
  const menus = wrapper.findAllComponents(QuickAddMenu);
  expect(menus.map(menu => menu.props('placement'))).toEqual(['desktop', 'mobile']);
  expect(menus.every(menu => menu.props('canManage') === true)).toBe(true);
  mocks.app.selectedMember.value = { id: 'member-b', displayName: '另一成员', permission: 'viewer' };
  mocks.app.selectedMemberId.value = 'member-b';
  expect(mocks.replace).toHaveBeenCalledWith('/events');
  await wrapper.vm.$nextTick();
  expect(menus.every(menu => menu.props('canManage') === false)).toBe(true);
  wrapper.unmount();
  await vi.advanceTimersByTimeAsync(30000);
  expect(mocks.refreshReminderCount).not.toHaveBeenCalled();
});

it('keeps the process list under records without adding a navigation entry or leaving on member switch', async () => {
  mocks.route.path = mocks.route.fullPath = '/health-processes';
  const wrapper = mountShell();
  expect(wrapper.findAll('a[href="/health-processes"]')).toHaveLength(0);
  expect(wrapper.findAll('a[href="/events"]').every(link => link.classes().includes('router-link-active'))).toBe(true);
  mocks.app.selectedMemberId.value = 'member-b';
  expect(mocks.replace).not.toHaveBeenCalled();
  wrapper.unmount();
});

it('does not request administrator feedback refreshes for an ordinary account', async () => {
  mocks.app.session.value.isAdmin = false;
  const wrapper = mountShell();
  await vi.advanceTimersByTimeAsync(30000);
  expect(mocks.refreshReminderCount).not.toHaveBeenCalled();
  expect(mocks.request).not.toHaveBeenCalled();
  wrapper.unmount();
});

it('labels the timeline as records and preserves the same four navigation entries on desktop and mobile', async () => {
  mocks.route.path = '/events'; mocks.route.fullPath = '/events?medicationId=course';
  const wrapper = mountShell();
  for (const nav of ['.desktop-nav', '.mobile-nav']) {
    expect(wrapper.find(`${nav} a[href="/medications"]`).exists()).toBe(false);
    expect(wrapper.get(`${nav} a[href="/events"]`).classes()).toContain('router-link-active');
    expect(wrapper.get(`${nav} a[href="/events"]`).text()).toBe('记录');
    expect(wrapper.findAll(`${nav} > a`)).toHaveLength(4);
  }
  wrapper.unmount();
});

it('switching members closes medication details from the previous member', () => {
  mocks.route.path = '/events';mocks.route.fullPath = '/events?recordKind=medication&recordId=old';mocks.route.query={recordKind:'medication',recordId:'old'};
  const wrapper=mountShell();
  mocks.app.selectedMemberId.value='member-b';
  expect(mocks.replace).toHaveBeenCalledWith('/events');
  wrapper.unmount();
});

it.each([
  { path: '/events/detail/report/old', query: {} },
  { path: '/events/detail/intake/old', query: {} },
  { path: '/events', query: { recordKind: 'episode', recordId: 'old' } }
])('switching members leaves the previous record detail: $path', ({path, query}) => {
  mocks.route.path = mocks.route.fullPath = path; mocks.route.query = query;
  const wrapper = mountShell();
  mocks.app.selectedMemberId.value = 'member-b';
  expect(mocks.replace).toHaveBeenCalledWith('/events');
  wrapper.unmount();
});

it('restores the record topbar search instead of the member switch button', async () => {
  mocks.app.topbarSearch.value={key:'events',model:ref(''),placeholder:'搜索记录'};
  mocks.app.setTopbarSearchValue=vi.fn();
  const wrapper=mountShell();
  expect(wrapper.find('.member-chip').exists()).toBe(false);
  expect(wrapper.get('.topbar-search-field input').attributes('placeholder')).toBe('搜索记录');
  await wrapper.get('.topbar-search-field input').setValue('合成药品');
  expect(mocks.app.setTopbarSearchValue).toHaveBeenCalledWith('合成药品');wrapper.unmount();
});

it('uses the live overview total in the topbar and leaves other page subtitles independent', async () => {
  mocks.route.path = mocks.route.fullPath = '/overview';
  mocks.route.meta = { title: '概览', subtitle: '旧版概览说明' };
  const wrapper = mountShell();
  expect(wrapper.get('.topbar-subtitle').text()).toBe('');
  mocks.app.topbarSubtitles.value = { overview: '共 9 条记录' };
  await wrapper.vm.$nextTick();
  expect(wrapper.get('.topbar-subtitle').text()).toBe('共 9 条记录');
  mocks.app.topbarSubtitles.value = { overview: '共 0 条记录' };
  await wrapper.vm.$nextTick();
  expect(wrapper.get('.topbar-subtitle').text()).toBe('共 0 条记录');
  mocks.route.path = mocks.route.fullPath = '/events';
  mocks.route.meta = { title: '记录', subtitle: '报告、影像、症状、监测、用药与接种' };
  await wrapper.vm.$nextTick();
  expect(wrapper.get('.topbar-subtitle').text()).toBe('报告、影像、症状、监测、用药与接种');
  wrapper.unmount();
});

it('uses a bounded touch layout only for vaccination entry and retains bottom navigation',async()=>{
 const wrapper=mountShell();expect(wrapper.classes()).not.toContain('is-vaccination-entry');
 mocks.route.path=mocks.route.fullPath='/add/vaccination';await wrapper.vm.$nextTick();expect(wrapper.classes()).toContain('is-vaccination-entry');
 expect(wrapper.get('nav[aria-label="触屏导航"]').findAll('a')).toHaveLength(4);
 mocks.route.path=mocks.route.fullPath='/events';await wrapper.vm.$nextTick();expect(wrapper.classes()).not.toContain('is-vaccination-entry');wrapper.unmount();
});
