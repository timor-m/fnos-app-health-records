import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { mount, flushPromises } from '@vue/test-utils';
import DataAuditSettingsPage from '../src/pages/settings/DataAuditSettingsPage.vue';
import ConfirmDialog from '../src/components/ConfirmDialog.vue';
import { useConfirm } from '../src/composables/useConfirm';

const mocks = vi.hoisted(() => ({ request: vi.fn(), upload: vi.fn(), context: vi.fn(), toast: vi.fn(), push: vi.fn() }));
vi.mock('vue-router', () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock('../src/utils/api', () => ({ request: mocks.request, requestUpload: mocks.upload }));
vi.mock('../src/composables/useAppContext', () => ({ useAppContext: mocks.context }));
vi.mock('../src/composables/useToast', () => ({ useToast: () => ({ show: mocks.toast }) }));
vi.mock('../src/utils/download', () => ({ downloadFile: vi.fn(), downloadStreamedFile: vi.fn() }));
const backup = { id: 'backup_synthetic', filename: 'synthetic.tar.gz', sizeBytes: 10, createdAt: '2026-01-01', appVersion: '0.2.10', schemaVersion: 17, memberCount: 2, reportCount: 3, includes: [], reason: 'manual' };
let mounted: ReturnType<typeof mount>[] = [];
const confirm = useConfirm();
function render(admin = true, provider = 'local') {
  mocks.context.mockReturnValue({ session: ref({ isAdmin: admin, provider }), selectedMemberId: ref(''), load: vi.fn(async () => {}) });
  const page = mount(DataAuditSettingsPage, { global: { stubs: { SubPageHeader: true, MarqueeText: true } } });
  const dialog = mount(ConfirmDialog, { attachTo: document.body }); mounted.push(page, dialog);
  return page;
}
function button(page: ReturnType<typeof mount>, text: string) { return page.findAll('button').find(b => b.text() === text)!; }
async function chooseFile(page: ReturnType<typeof mount>, label: string) {
  const input = page.get(`input[aria-label="${label}"]`);
  Object.defineProperty(input.element, 'files', { configurable: true, value: [new File(['synthetic'], 'synthetic.tar.gz')] });
  await input.trigger('change'); await flushPromises();
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.request.mockImplementation(async path => path === 'backups' ? [backup] : path === 'backups/takeover-repair' ? { available: false } : undefined);
});
afterEach(() => { confirm.cancel(); mounted.forEach(w => w.unmount()); mounted = []; document.body.innerHTML = ''; });

describe('restore authorization UX', () => {
  it('fnOS migration uses one confirmation without an extra checkbox and reports granted access', async () => {
    mocks.request.mockImplementation(async (path, options) => {
      if (path === 'backups') return [backup];
      if (path === 'backups/takeover-repair') return { available: false };
      if (path.endsWith('/preflight')) return { token: 'fnos-plan', warning: '检测到飞牛备份。2 个成员档案将由当前管理员管理。', canChooseTakeover: false };
      expect(JSON.parse(options.body)).toEqual({ token: 'fnos-plan' });
      return { restored: true, identityRebind: { strategy: 'cross', accessPolicy: 'admin_takeover', memberPermissionCount: 2 } };
    });
    const page = render(); await flushPromises(); await button(page, '恢复').trigger('click'); await flushPromises();
    expect(document.querySelectorAll('[role="alertdialog"]')).toHaveLength(1);
    expect(document.querySelector('[role="alertdialog"]')!.textContent).toContain('替换当前数据');
    expect(document.querySelector('[role="alertdialog"] input')).toBeNull();
    await confirm.confirm(); await flushPromises();
    expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining('已将 2 个成员档案授权给当前管理员'), 6000);
    expect(page.text()).not.toContain('运行受控身份映射工具');
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(mocks.toast).toHaveBeenCalledTimes(1);
  });

  it('Docker to fnOS restore uses the shared confirmation and guides existing archive association', async () => {
    mocks.upload.mockImplementation(async (_path, body: FormData) => body.get('token')
      ? { restored: true, identityRebind: { strategy: 'cross', accessPolicy: 'admin_takeover', memberPermissionCount: 2 } }
      : { token: 'local-plan', warning: '检测到本地账号备份。2 个成员档案将由当前管理员管理。', canChooseTakeover: false });
    const page = render(true, 'fnos_gateway'); await flushPromises();
    await chooseFile(page, '选择外部备份文件');
    expect(document.querySelectorAll('[role="alertdialog"]')).toHaveLength(1);
    expect(document.querySelector('[role="alertdialog"]')!.textContent).toContain('替换当前数据');
    expect(document.querySelector('[role="alertdialog"] input')).toBeNull();
    await confirm.confirm(); await flushPromises();
    expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining('请重新进入应用后，可将已有档案设为本人或分配共享权限，无须新建成员'), 6000);
    expect(mocks.upload).toHaveBeenCalledTimes(2);
    expect(page.text()).not.toContain('管理账号');
  });

  it('legacy choice defaults off, blocks submission during fresh preflight and uses only the refreshed token', async () => {
    let resolvePlan!: (value: unknown) => void;
    mocks.request.mockImplementation(async (path, options) => {
      if (path === 'backups') return [backup];
      if (path === 'backups/takeover-repair') return { available: false };
      if (path.endsWith('/preflight')) {
        if (!options.body) return { token: 'initial', warning: '待映射', canChooseTakeover: true };
        expect(JSON.parse(options.body)).toEqual({ takeover: true });
        return new Promise(resolve => { resolvePlan = resolve; });
      }
      expect(JSON.parse(options.body)).toEqual({ token: 'chosen' });
      return { identityRebind: { accessPolicy: 'admin_takeover', memberPermissionCount: 2 } };
    });
    const page = render(); await flushPromises(); await button(page, '恢复').trigger('click'); await flushPromises();
    expect((document.querySelector('[role="alertdialog"] input') as HTMLInputElement).checked).toBe(false);
    const changing = confirm.choose(true); await flushPromises();
    expect(confirm.state.value!.loading).toBe(true);
    await confirm.confirm();
    expect(mocks.request.mock.calls.some(([path]) => path.endsWith('/restore'))).toBe(false);
    resolvePlan({ token: 'chosen', warning: '全部档案授权给当前管理员', canChooseTakeover: true });
    await changing; await flushPromises();
    expect(confirm.state.value!.choice!.checked).toBe(true);
    expect(document.querySelector('[role="alertdialog"]')!.textContent).toContain('全部档案授权');
    await confirm.confirm();
  });

  it('failed choice refresh keeps the prior policy and does not restore automatically', async () => {
    const change = vi.fn().mockRejectedValue(new Error('synthetic preflight failure'));
    const run = vi.fn();
    render(); await flushPromises();
    confirm.ask({ title: 'restore', message: 'original policy', run, choice: { label: 'takeover', checked: false, change } });
    await flushPromises();
    const checkbox = document.querySelector('[role="alertdialog"] input') as HTMLInputElement;
    checkbox.checked = true; checkbox.dispatchEvent(new Event('change')); await flushPromises();
    expect(confirm.state.value!.choice!.checked).toBe(false);
    expect(checkbox.checked).toBe(false);
    expect(confirm.state.value!.message).toBe('original policy');
    expect(run).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith('synthetic preflight failure', 3600);
  });

  for (const provider of ['local', 'fnos_gateway']) it(`${provider} optional takeover preflights again and binds confirmation to the same uploaded file`, async () => {
    mocks.upload.mockImplementation(async (_path, body: FormData) => {
      if (body.get('token')) {
        expect(body.get('token')).toBe('upload-chosen');
        return { identityRebind: { accessPolicy: 'admin_takeover', memberPermissionCount: 2 } };
      }
      return { token: body.get('takeover') === 'true' ? 'upload-chosen' : 'upload-initial', warning: 'synthetic', canChooseTakeover: true };
    });
    const page = render(true, provider); await flushPromises(); await chooseFile(page, '选择外部备份文件');
    expect((document.querySelector('[role="alertdialog"] input') as HTMLInputElement).checked).toBe(false);
    expect(document.querySelector('[role="alertdialog"]')!.textContent).toContain('由当前管理员接管全部档案');
    await confirm.choose(true); await confirm.confirm();
    expect(mocks.upload).toHaveBeenCalledTimes(3);
    const files = mocks.upload.mock.calls.map(([, body]) => body.get('backup'));
    expect(files[0]).toBe(files[1]); expect(files[1]).toBe(files[2]);
  });

  it('historical repair checks original backup once, confirms once and removes its entry after success', async () => {
    mocks.request.mockImplementation(async path => path === 'backups' ? [] : { available: true });
    mocks.upload.mockImplementation(async (path, body: FormData) => {
      expect(path).toBe('backups/takeover-repair');
      return body.get('token') ? { memberCount: 2 } : { token: 'repair', warning: '将 2 个未分配档案授权给当前管理员。' };
    });
    const page = render(); await flushPromises();
    await chooseFile(page, '选择原始备份并接管档案');
    expect(document.querySelectorAll('[role="alertdialog"]')).toHaveLength(1);
    await confirm.confirm(); await flushPromises();
    expect(page.find('input[aria-label="选择原始备份并接管档案"]').exists()).toBe(false);
    expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining('已将 2 个成员档案授权给当前管理员'), 6000);
    expect(mocks.upload).toHaveBeenCalledTimes(2);
  });

  it('ordinary accounts never request repair metadata or see an entry', async () => {
    const page = render(false); await flushPromises();
    expect(mocks.request).not.toHaveBeenCalled();
    expect(page.find('input[aria-label="选择原始备份并接管档案"]').exists()).toBe(false);
  });
});

describe('repair discovery and navigation', () => {
  it('offers an inline retry when discovery fails and restores the entry on success', async () => {
    mocks.request.mockImplementation(async path => {
      if (path === 'backups') return [];
      throw new Error('synthetic network failure');
    });
    const page = render(); await flushPromises();
    expect(page.text()).toContain('未能检查历史档案权限');
    expect(mocks.toast).not.toHaveBeenCalled();
    mocks.request.mockResolvedValueOnce({ available: true });
    await button(page, '重新检查').trigger('click'); await flushPromises();
    expect(page.text()).not.toContain('未能检查历史档案权限');
    expect(page.find('.backup-header-actions input[aria-label="选择原始备份并接管档案"]').exists()).toBe(true);
  });
  it('provides local administrator navigation without an extra confirmation', async () => {
    const page = render(); await flushPromises();
    await button(page, '管理账号').trigger('click');
    expect(mocks.push).toHaveBeenCalledWith('/me/account-security');
    await button(page, '分配档案').trigger('click');
    expect(mocks.push).toHaveBeenCalledWith('/me/members');
    expect(confirm.state.value).toBeNull();
  });
});
