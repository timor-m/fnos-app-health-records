import { flushPromises, mount } from '@vue/test-utils';
import { Camera, Plus } from '@lucide/vue';
import { describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import QuickAddMenu from '../src/components/QuickAddMenu.vue';

const routerLinkStub = { name:'RouterLink', props: ['to'], template: '<a :href="typeof to===\'string\'?to:to.path"><slot /></a>' };
function menuRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/events', component: { template: '<div/>' } },
      { path: '/upload', component: { template: '<div/>' } },
      { path: '/trends', component: { template: '<div/>' } },
      { path: '/add/:kind', component: { template: '<div/>' } },
      { path: '/health-processes/:id', component: { template: '<div/>' } },
    ],
  });
}

describe('拍照新增菜单', () => {
  it('历程内补充记录携带历程身份，不绑定某一条基准记录',async()=>{
    const router = menuRouter();
    const wrapper=mount(QuickAddMenu,{props:{placement:'inline',canManage:true,routeKey:'/health-processes/process',processId:'process',memberId:'member'},global:{plugins:[router],stubs:{RouterLink:routerLinkStub,Teleport:true}}});
    await wrapper.get('.quick-add-trigger').trigger('click');expect(wrapper.get('.quick-add-associate').text()).toContain('加入当前历程');
    expect(wrapper.get('.quick-add-associate strong').text()).toBe('添加记录');
    for(const link of wrapper.findAllComponents({name:'RouterLink'})){expect(link.props('to').query).toMatchObject({processId:'process',memberId:'member',returnTo:'/health-processes/process'});expect(link.props('to').query).not.toHaveProperty('relatedId');}
    await wrapper.findAll('button.quick-add-entry').find(button => button.text().includes('用药'))!.trigger('click');
    await flushPromises();
    expect(router.currentRoute.value.query).toMatchObject({add:'medication',processId:'process',memberId:'member',returnTo:'/health-processes/process'});
    wrapper.unmount();
  });
  it('从原拍照位置向上展开，选择类型直接进入新增页面', async () => {
    const wrapper = mount(QuickAddMenu, {
      props: { placement: 'mobile', canManage: true, routeKey: '/events' },
      global: { plugins: [menuRouter()], stubs: { RouterLink: routerLinkStub } }
    });
    const trigger = wrapper.get('.quick-add-trigger');
    expect(trigger.attributes('aria-label')).toBe('拍照或新增记录');
    expect(trigger.findComponent(Plus).exists()).toBe(true);
    expect(trigger.get('svg').attributes('width')).toBe('28');
    expect(trigger.get('svg').attributes('stroke-width')).toBe('2.5');
    expect(trigger.findComponent(Camera).exists()).toBe(false);
    expect(trigger.attributes('aria-expanded')).toBe('false');
    await trigger.trigger('click');
    await nextTick();
    expect(trigger.attributes('aria-expanded')).toBe('true');
    expect(wrapper.get('.quick-add-panel').attributes('role')).toBe('menu');
    expect(wrapper.findAll('a.quick-add-entry').map(link => link.attributes('href')))
      .toEqual(['/upload', '/add/symptom', '/add/measurement', '/add/vaccination']);
    expect(wrapper.findAllComponents({name:'RouterLink'})[1].props('to')).toEqual({path:'/add/symptom',query:{returnTo:'/events'}});
    expect(wrapper.findAllComponents({name:'RouterLink'})[2].props('to')).toEqual({path:'/add/measurement',query:{returnTo:'/events'}});
    const medication = wrapper.findAll('button.quick-add-entry').find(button => button.text().includes('用药'))!;
    expect(medication.attributes('aria-current')).toBeUndefined();
    expect(medication.classes()).not.toContain('router-link-exact-active');
    expect(wrapper.findAllComponents({name:'RouterLink'}).at(-1)!.props('to')).toEqual({path:'/add/vaccination',query:{returnTo:'/events'}});
    expect(wrapper.text()).toContain('接种');
    expect(wrapper.find('.quick-add-entry.is-disabled').exists()).toBe(false);
    expect(wrapper.findAll('.quick-add-entry')[0].text()).toContain('快速拍照');
    expect(wrapper.get('input[capture="environment"]').attributes('multiple')).toBeUndefined();
    document.body.querySelector<HTMLElement>('.quick-add-backdrop')?.click();
    await nextTick();
    expect(trigger.attributes('aria-expanded')).toBe('false');
    await trigger.trigger('click');
    await wrapper.findAll('a.quick-add-entry')[1].trigger('click');
    await wrapper.setProps({ routeKey: '/add/vaccination' });
    expect(trigger.attributes('aria-expanded')).toBe('false');
    wrapper.unmount();
  });

  it('记录页里的用药入口打开用药，且不标成当前页', async () => {
    const router = menuRouter();
    await router.push('/events');
    await router.isReady();
    const wrapper = mount(QuickAddMenu, {
      props: { placement: 'mobile', canManage: true, routeKey: '/events' },
      global: { plugins: [router], stubs: { RouterLink: routerLinkStub } },
    });
    await wrapper.get('.quick-add-trigger').trigger('click');
    const medication = wrapper.findAll('button.quick-add-entry').find(button => button.text().includes('用药'))!;
    expect(medication.attributes('aria-current')).toBeUndefined();
    await medication.trigger('click');
    await flushPromises();
    expect(router.currentRoute.value.fullPath).toBe('/events?add=medication');
    expect(wrapper.find('.quick-add-panel').exists()).toBe(false);
    wrapper.unmount();
  });

  it('切换页面或按 Escape 收起，只有管理权限才能展开', async () => {
    const wrapper = mount(QuickAddMenu, {
      props: { placement: 'desktop', canManage: true, routeKey: '/events' },
      global: { plugins: [menuRouter()], stubs: { RouterLink: routerLinkStub } }
    });
    const trigger = wrapper.get('.quick-add-trigger');
    expect(trigger.attributes('aria-label')).toBe('新增');
    expect(trigger.text()).toContain('新增');
    expect(trigger.findComponent(Plus).exists()).toBe(true);
    expect(trigger.get('svg').attributes('stroke-width')).toBe('2.5');
    expect(trigger.findComponent(Camera).exists()).toBe(false);
    await trigger.trigger('click');
    expect(wrapper.find('.quick-photo-entry').exists()).toBe(false);
    expect(wrapper.find('input[capture]').exists()).toBe(false);
    await wrapper.setProps({ routeKey: '/trends' });
    expect(wrapper.find('.quick-add-panel').exists()).toBe(false);
    await trigger.trigger('click');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await nextTick();
    expect(wrapper.find('.quick-add-panel').exists()).toBe(false);
    await wrapper.setProps({ canManage: false });
    expect(trigger.attributes('disabled')).toBeDefined();
    await trigger.trigger('click');
    expect(wrapper.find('.quick-add-panel').exists()).toBe(false);
    wrapper.unmount();
  });
});

it('record-based association uses the health process label and explains its result',async()=>{
 const wrapper=mount(QuickAddMenu,{props:{placement:'inline',canManage:true,routeKey:'/events',relatedRecord:{kind:'report',id:'synthetic-report'},memberId:'member'},global:{plugins:[menuRouter()],stubs:{RouterLink:routerLinkStub,Teleport:true}}});
 await wrapper.get('.quick-add-trigger').trigger('click');const action=wrapper.get('.quick-add-associate');
 expect(action.get('strong').text()).toBe('关联历程');expect(action.get('small').text()).toBe('选择相关记录，形成或加入健康历程');
 await action.trigger('click');expect(wrapper.emitted('associate')).toHaveLength(1);expect(wrapper.find('.quick-add-panel').exists()).toBe(false);wrapper.unmount();
});

it.each(['mobile','desktop','inline'] as const)('点击 %s 菜单外侧不强制聚焦新增入口，Escape 仍返回入口', async placement => {
 const wrapper=mount(QuickAddMenu,{attachTo:document.body,props:{placement,canManage:true,routeKey:'/events'},global:{plugins:[menuRouter()],stubs:{RouterLink:routerLinkStub}}});
 try {
  const trigger=wrapper.get<HTMLButtonElement>('.quick-add-trigger');
  await trigger.trigger('click');await nextTick();
  const focus=vi.spyOn(trigger.element,'focus');
  document.body.querySelector<HTMLElement>('.quick-add-backdrop')!.click();await nextTick();
  expect(wrapper.find('.quick-add-panel').exists()).toBe(false);
  expect(focus).not.toHaveBeenCalled();
  expect(document.activeElement).not.toBe(trigger.element);
  await trigger.trigger('click');await nextTick();
  window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}));await nextTick();
  expect(document.activeElement).toBe(trigger.element);
  focus.mockRestore();
 } finally {wrapper.unmount();}
});

it('方向键与首尾键移动菜单焦点，Escape 返回触发按钮', async () => {
 const wrapper = mount(QuickAddMenu, { attachTo: document.body, props: { placement: 'desktop', canManage: true, routeKey: '/events' }, global: { plugins: [menuRouter()], stubs: { RouterLink: routerLinkStub } } });
 await wrapper.get('.quick-add-trigger').trigger('click'); await nextTick();
 const items = () => Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)'));
 expect(document.activeElement).toBe(items()[0]);
 for (const [key, index] of [['ArrowDown', 1], ['End', 4], ['Home', 0], ['ArrowUp', 4]] as const) {
   window.dispatchEvent(new KeyboardEvent('keydown', { key })); await nextTick(); expect(document.activeElement).toBe(items()[index]);
 }
 window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); await nextTick();
 expect(document.activeElement).toBe(wrapper.get('.quick-add-trigger').element); wrapper.unmount();
});

it('temporary busy states disable the add menu without claiming the manager has read-only access',async()=>{
 const wrapper=mount(QuickAddMenu,{props:{placement:'inline',label:'补充记录',canManage:true,disabled:true,routeKey:'/health-processes/process'},global:{plugins:[menuRouter()],stubs:{RouterLink:routerLinkStub,Teleport:true}}});
 const trigger=wrapper.get('.quick-add-trigger');expect(trigger.attributes('disabled')).toBeDefined();expect(trigger.attributes('aria-label')).toBe('补充记录');await trigger.trigger('click');expect(wrapper.find('.quick-add-panel').exists()).toBe(false);
 await wrapper.setProps({disabled:false});await trigger.trigger('click');expect(wrapper.find('.quick-add-panel').exists()).toBe(true);await wrapper.setProps({disabled:true});expect(wrapper.find('.quick-add-panel').exists()).toBe(false);wrapper.unmount();
});

it('process menus leave reminder creation in the follow-up module header',async()=>{
 const wrapper=mount(QuickAddMenu,{props:{placement:'inline',canManage:true,routeKey:'/health-processes/process',processId:'process',memberId:'member'},global:{plugins:[menuRouter()],stubs:{RouterLink:routerLinkStub,Teleport:true}}});await wrapper.get('.quick-add-trigger').trigger('click');expect(wrapper.findAll('button[role=menuitem]').some(item=>item.text().includes('添加提醒'))).toBe(false);expect(wrapper.find('.quick-add-associate').exists()).toBe(true);wrapper.unmount();
});

it('opens the shared symptom dialog from the process menu without navigating',async()=>{
 const wrapper=mount(QuickAddMenu,{props:{placement:'inline',canManage:true,symptomDialog:true,processId:'process',memberId:'member',routeKey:'/health-processes/process'},global:{plugins:[menuRouter()],stubs:{RouterLink:routerLinkStub,Teleport:true}}});
 await wrapper.get('.quick-add-trigger').trigger('click');
 const item=wrapper.findAll('button.quick-add-entry').find(button=>button.text().includes('症状 / 不适'))!;
 expect(item.exists()).toBe(true);await item.trigger('click');
 expect(wrapper.emitted('symptom')?.[0][0]).toBe(wrapper.get('.quick-add-trigger').element);
 expect(wrapper.find('.quick-add-panel').exists()).toBe(false);wrapper.unmount();
});
