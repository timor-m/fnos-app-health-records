import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { defineComponent, KeepAlive, ref } from 'vue';
import HealthRecordDetailModal from '../src/components/HealthRecordDetailModal.vue';
import ReportScrollingTitle from '../src/components/ReportScrollingTitle.vue';
import { healthPageScrollKey, healthRecordPath, isHealthRecordKind } from '../src/utils/health-record-navigation';
import { useTouchRecordDetail } from '../src/composables/useTouchRecordDetail';

const app = { selectedMemberId: ref('member') };
vi.mock('../src/composables/useAppContext', () => ({ useAppContext: () => app }));
vi.mock('../src/components/HealthRecordDetailContent.vue', () => ({ default: {
  name: 'HealthRecordDetailContent', props: {kind:String,recordId:String,hideReportTitle:Boolean,openRelatedInPlace:Boolean}, emits: ['close', 'updated', 'openReport', 'heading', 'openRecord'],
  template: '<div class="record-content">{{ kind }}:{{ recordId }}<button @click="$emit(\'openReport\', \'report-other\')">查看原件</button><button @click="$emit(\'close\')">完成</button><details class="retained-history"><summary>历史</summary>历史内容</details><button class="open-related-record" @click="$emit(\'openRecord\', {kind:\'report\',id:\'related\'})">相关报告</button></div>'
} }));
const mounted: ReturnType<typeof mount>[] = [];
function show(props = {}) {
  const wrapper = mount(HealthRecordDetailModal, { props: { open: true, kind: 'symptom', recordId: 'one', ...props }, attachTo: document.body });
  mounted.push(wrapper); return wrapper;
}
beforeEach(() => { app.selectedMemberId.value = 'member'; });
afterEach(() => { for (const wrapper of mounted.splice(0)) wrapper.unmount(); document.body.innerHTML = ''; vi.restoreAllMocks(); });

it.each(['symptom','report','medication_document','medication','intake','vaccination'] as const)('returns from related records to the same %s content, scroll position and focused link',async kind=>{
 const wrapper=show({kind});await flushPromises();
 const body=document.querySelector('.health-record-detail-body') as HTMLElement;body.scrollTop=180;
 const history=document.querySelector('.retained-history') as HTMLDetailsElement;history.open=true;
 const opener=document.querySelector('.open-related-record') as HTMLButtonElement;opener.focus();
 opener.click();await flushPromises();
 const backdrops=[...document.querySelectorAll<HTMLElement>('.health-record-detail-backdrop')];
 expect(backdrops).toHaveLength(2);expect(backdrops[0].style.display).toBe('none');expect(backdrops[1].style.display).not.toBe('none');
 expect(body.isConnected).toBe(true);expect(document.body.style.overflow).toBe('hidden');
 (backdrops[1].querySelector('[aria-label="关闭记录详情"]') as HTMLButtonElement).click();await flushPromises();
 expect(document.querySelectorAll('.health-record-detail-backdrop')).toHaveLength(1);expect(backdrops[0].style.display).not.toBe('none');
 expect(body.scrollTop).toBe(180);expect(history.open).toBe(true);expect(document.activeElement).toBe(opener);expect(document.body.style.overflow).toBe('hidden');
});

it('discards the related record together with the symptom when the member changes',async()=>{
 const wrapper=show({kind:'symptom'});await flushPromises();(document.querySelector('.open-related-record') as HTMLButtonElement).click();await flushPromises();
 app.selectedMemberId.value='second';await flushPromises();expect(document.querySelector('[role="dialog"]')).toBeNull();expect(document.body.style.overflow).toBe('');
});

it('restores focus to the symptom close control if the related record link has been removed',async()=>{
 show({kind:'symptom'});await flushPromises();const opener=document.querySelector('.open-related-record') as HTMLButtonElement;opener.focus();opener.click();await flushPromises();
 opener.remove();const closes=document.querySelectorAll<HTMLButtonElement>('[aria-label="关闭记录详情"]');closes[1].click();await flushPromises();expect(document.activeElement).toBe(closes[0]);
});

it.each(['symptom', 'vaccination', 'report', 'medication_document', 'medication', 'intake'] as const)('hosts %s in the same accessible overlay with scroll locking', async kind => {
  const wrapper = show({ kind }); await flushPromises();
  const panel = document.querySelector('[role="dialog"]')!;
  expect(panel.getAttribute('aria-modal')).toBe('true');
  expect(document.activeElement).toBe(panel);
  expect(panel.textContent).toContain(`${kind}:one`);
  expect(wrapper.findComponent({name:'HealthRecordDetailContent'}).props('hideReportTitle')).toBe(true);
  expect(document.body.style.overflow).toBe('hidden');
  await wrapper.setProps({ open: false });
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.body.style.overflow).toBe('');
});

it('traps focus, restores the trigger without scrolling, and leaves nested overlays in control', async () => {
  const trigger = document.createElement('button'); document.body.append(trigger); trigger.focus();
  const restore = vi.spyOn(trigger, 'focus');
  const wrapper = show(); await flushPromises();
  const buttons = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')];
  expect(document.activeElement).toBe(document.querySelector('[role="dialog"]'));
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, cancelable: true }));
  expect(document.activeElement).toBe(buttons.at(-1));
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', cancelable: true }));
  expect(document.activeElement).toBe(buttons[0]);
  const nested = document.createElement('div'); nested.className = 'modal-backdrop'; document.body.append(nested);
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
  expect(wrapper.emitted('close')).toBeUndefined();
  nested.remove();
  for (const className of ['modal-backdrop confirm-backdrop', 'original-viewer']) {
    const priorityOverlay = document.createElement('div'); priorityOverlay.className = className; document.body.prepend(priorityOverlay);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
    expect(wrapper.emitted('close')).toBeUndefined(); priorityOverlay.remove();
  }
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
  await flushPromises();expect(wrapper.emitted('close')).toHaveLength(1);
  await wrapper.setProps({ open: false });
  expect(restore).toHaveBeenCalledWith({ preventScroll: true });
});

it('unmounts old member content immediately and only reopens through a new open action', async () => {
  const wrapper = show(); await flushPromises();
  app.selectedMemberId.value = 'second'; await flushPromises();
  expect(document.querySelector('.record-content')).toBeNull();
  expect(wrapper.emitted('close')).toHaveLength(1);
  expect(document.body.style.overflow).toBe('');
  await wrapper.setProps({ open: false }); await wrapper.setProps({ open: true, recordId: 'two' });
  expect(document.querySelector('.record-content')?.textContent).toContain('symptom:two');
});

it('forwards report selection and closes cached overlays when the page deactivates', async () => {
  const shown = ref(true);
  const wrapper = mount(defineComponent({ components: { KeepAlive, HealthRecordDetailModal }, setup: () => ({ shown }),
    template: '<KeepAlive><HealthRecordDetailModal v-if="shown" :open="true" kind="medication_document" record-id="one" /></KeepAlive>'
  }), { attachTo: document.body }); mounted.push(wrapper); await flushPromises();
  const child = wrapper.getComponent(HealthRecordDetailModal);
  document.querySelector<HTMLButtonElement>('.record-content button')!.click();
  expect(child.emitted('openReport')).toEqual([['report-other']]);
  shown.value = false; await flushPromises();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.body.style.overflow).toBe('');
});

it('keeps record URLs internal and isolates timeline scroll positions by member', () => {
  expect(isHealthRecordKind('constructor')).toBe(false);
  expect(isHealthRecordKind(['event'])).toBe(false);
  expect(healthRecordPath('report', 'a/b?c')).toBe('/events/detail/report/a%2Fb%3Fc');
  expect(healthPageScrollKey('/events?filter=medication&recordKind=report&recordId=one', 'member'))
    .toBe(healthPageScrollKey('/events?filter=medication', 'member'));
  expect(healthPageScrollKey('/events', 'member')).not.toBe(healthPageScrollKey('/events', 'second'));
});

it('reacts to touch layout changes, including coarse-pointer tablets, and removes its listener', async () => {
  let listener: () => void = () => {};
  const media = { matches: false, addEventListener: vi.fn((_type, fn) => { listener = fn; }), removeEventListener: vi.fn() };
  const match = vi.spyOn(window, 'matchMedia').mockReturnValue(media as unknown as MediaQueryList);
  const wrapper = mount(defineComponent({ setup: () => ({ touch: useTouchRecordDetail() }), template: '<span>{{ touch }}</span>' }));
  expect(match).toHaveBeenCalledWith('(max-width: 760px), (pointer: coarse)');
  expect(wrapper.text()).toBe('false'); media.matches = true; listener(); await wrapper.vm.$nextTick();
  expect(wrapper.text()).toBe('true'); wrapper.unmount(); expect(media.removeEventListener).toHaveBeenCalledWith('change', listener);
});

it('shows the selected record title and type icon, resets on record changes and reopening', async () => {
  const wrapper = show({kind:'report'}); await flushPromises();
  const content = () => wrapper.findComponent({name:'HealthRecordDetailContent'});
  // The child only publishes headings after its data passes ownership checks.
  content().vm.$emit('heading', {title:'合成影像报告标题', category:'imaging'}); await flushPromises();
  expect(document.querySelector('.record-sheet-title h3')?.textContent).toBe('合成影像报告标题');
  expect(wrapper.getComponent(ReportScrollingTitle).props('text')).toBe('合成影像报告标题');
  expect(document.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('合成影像报告标题');
  expect(document.querySelector('.record-sheet-title img')?.getAttribute('alt')).toBe('影像');
  await wrapper.setProps({recordId:'two'});
  expect(document.querySelector('.record-sheet-title h3')?.textContent).toBe('资料详情');
  content().vm.$emit('heading', {title:'第二份合成资料',category:'report'}); await flushPromises();
  await wrapper.setProps({open:false}); await wrapper.setProps({open:true});
  expect(document.querySelector('.record-sheet-title h3')?.textContent).toBe('资料详情');
});
