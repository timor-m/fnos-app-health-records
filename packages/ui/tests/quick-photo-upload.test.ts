import { mount, flushPromises } from '@vue/test-utils';
import { ref } from 'vue';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';
import QuickAddMenu from '../src/components/QuickAddMenu.vue';

const mocks = vi.hoisted(() => ({ upload: vi.fn(), notify: vi.fn(), toast: vi.fn(), app: null as any }));
vi.mock('../src/utils/api', () => ({ requestUpload: (...args: unknown[]) => mocks.upload(...args) }));
vi.mock('../src/composables/useAppContext', () => ({ useAppContext: () => mocks.app }));
vi.mock('../src/composables/useToast', () => ({ useToast: () => ({ show: mocks.toast }) }));

let wrapper: ReturnType<typeof mount>;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.app = { selectedMemberId: ref('member-a'), session: ref({ id: 'user' }), notifyDataChanged: mocks.notify };
  mocks.upload.mockResolvedValue({ memberId: 'member-a', reportId: 'synthetic-report' });
  wrapper = mount(QuickAddMenu, { props: { placement: 'mobile', canManage: true, routeKey: '/events' },
    global: { plugins: [createRouter({ history: createMemoryHistory(), routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div/>' } }] })], stubs: { Teleport: true, RouterLink: { props: ['to'], template: '<a><slot /></a>' } } } });
});
afterEach(() => wrapper.unmount());

async function openCamera() {
  await wrapper.get('.quick-add-trigger').trigger('click');
  const click = vi.spyOn(wrapper.get('input[capture]').element as HTMLInputElement, 'click');
  await wrapper.get('.quick-photo-entry').trigger('click');
  expect(click).toHaveBeenCalledOnce();
}
async function selectPhoto(file?: File) {
  const input = wrapper.get('input[capture]');
  Object.defineProperty(input.element, 'files', { configurable: true, value: file ? [file] : [] });
  await input.trigger('change');
  await flushPromises();
}
const photo = () => new File(['photo'], 'camera.jpg', { type: 'image/jpeg' });

it('uploads the confirmed single photo immediately with a receipt and refreshes records', async () => {
  let finish!: (result: unknown) => void;
  mocks.upload.mockImplementation((_path, _body, progress) => { progress(42); return new Promise(resolve => { finish = resolve; }); });
  await openCamera();
  await selectPhoto(photo());
  expect(mocks.upload).toHaveBeenCalledOnce();
  const [path, body] = mocks.upload.mock.calls[0];
  expect(path).toBe('uploads');
  expect(body.get('memberId')).toBe('member-a');
  expect(body.getAll('files')).toHaveLength(1);
  expect(JSON.parse(body.get('manifest'))).toEqual({ pages: [{ rotation: 0, size: 5 }] });
  expect(body.get('requestKey')).toBeTruthy();
  expect(wrapper.find('.quick-add-panel').exists()).toBe(false);
  expect(wrapper.get('[role="status"]').text()).toContain('42%');
  finish({ memberId: 'member-a' });
  await flushPromises();
  expect(mocks.notify).toHaveBeenCalledOnce();
  expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining('已保存'), 3500);
  expect(wrapper.find('.quick-photo-status').exists()).toBe(false);
});

it('retains the photo and same request key for retry without duplicates', async () => {
  mocks.upload.mockRejectedValueOnce(new Error('网络中断'));
  await openCamera(); await selectPhoto(photo());
  expect(wrapper.get('[role="alert"]').text()).toContain('网络中断');
  const firstBody = mocks.upload.mock.calls[0][1];
  await wrapper.get('.quick-photo-status button').trigger('click'); await flushPromises();
  expect(mocks.upload).toHaveBeenCalledTimes(2);
  expect(mocks.upload.mock.calls[1][1].get('requestKey')).toBe(firstBody.get('requestKey'));
  const retried = mocks.upload.mock.calls[1][1].get('files') as File;
  expect(retried.name).toBe('camera.jpg');
  expect(await retried.text()).toBe(await (firstBody.get('files') as File).text());
});

it('cancelling the camera does not upload or show an error', async () => {
  await openCamera(); await selectPhoto();
  expect(mocks.upload).not.toHaveBeenCalled();
  expect(wrapper.find('[role="alert"]').exists()).toBe(false);
});

it('does not refocus the navigation camera button when the photo starts uploading', async () => {
  await openCamera();
  const focus = vi.spyOn(wrapper.get('.quick-add-trigger').element as HTMLButtonElement, 'focus');
  await selectPhoto(photo());
  expect(mocks.upload).toHaveBeenCalledOnce();
  expect(focus).not.toHaveBeenCalled();
});

it('does not upload a photo to a different member after returning from the camera', async () => {
  await openCamera(); mocks.app.selectedMemberId.value = 'member-b';
  await selectPhoto(photo());
  expect(mocks.upload).not.toHaveBeenCalled();
});

it('clears failed photos on member changes so retry cannot change their owner', async () => {
  mocks.upload.mockRejectedValueOnce(new Error('网络中断'));
  await openCamera(); await selectPhoto(photo());
  mocks.app.selectedMemberId.value = 'member-b'; await flushPromises();
  expect(wrapper.find('.quick-photo-status').exists()).toBe(false);
  expect(mocks.upload).toHaveBeenCalledOnce();
});

it('rejects oversized photos and unsupported camera output before upload', async () => {
  await openCamera();
  const large = photo(); Object.defineProperty(large, 'size', { value: 40 * 1024 * 1024 + 1 });
  await selectPhoto(large);
  expect(wrapper.get('[role="alert"]').text()).toContain('40 MB');
  await selectPhoto(new File(['pdf'], 'report.pdf', { type: 'application/pdf' }));
  expect(wrapper.get('[role="alert"]').text()).toContain('照片');
  expect(mocks.upload).not.toHaveBeenCalled();
});

it('revoked management permission prevents uploading the returned photo', async () => {
  await openCamera(); await wrapper.setProps({ canManage: false }); await selectPhoto(photo());
  expect(mocks.upload).not.toHaveBeenCalled();
});

it('keeps an in-flight upload tied to its original member and ignores stale completion', async () => {
  let finish!: (result: unknown) => void;
  mocks.upload.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  await openCamera(); await selectPhoto(photo());
  mocks.app.selectedMemberId.value = 'member-b'; await flushPromises();
  await selectPhoto(photo());
  expect(mocks.upload).toHaveBeenCalledOnce();
  expect(mocks.upload.mock.calls[0][1].get('memberId')).toBe('member-a');
  finish({ memberId: 'member-a' }); await flushPromises();
  expect(mocks.toast).not.toHaveBeenCalled();
  expect(wrapper.find('.quick-photo-status').exists()).toBe(false);
});

it('protects failed photos against accidental page exit until explicitly discarded', async () => {
  mocks.upload.mockRejectedValueOnce(new Error('网络中断'));
  await openCamera(); await selectPhoto(photo());
  const leaving = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(leaving); expect(leaving.defaultPrevented).toBe(true);
  await wrapper.findAll('.quick-photo-status button')[1].trigger('click');
  const discarded = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(discarded); expect(discarded.defaultPrevented).toBe(false);
  expect(wrapper.find('.quick-photo-status').exists()).toBe(false);
});
