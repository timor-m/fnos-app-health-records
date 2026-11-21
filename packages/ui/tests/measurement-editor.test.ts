import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, expect, it, vi } from 'vitest';
import { nextTick, ref } from 'vue';
import Editor from '../src/components/MeasurementEditor.vue';
import FormSelect from '../src/components/FormSelect.vue';
import { useConfirm } from '../src/composables/useConfirm';
import type { MeasurementSession } from '../../shared/measurements';

const request = vi.hoisted(() => vi.fn());
const app = { selectedMemberId: ref('member'), notifyDataChanged: vi.fn() };
vi.mock('../src/utils/api', () => ({ request: (...args: unknown[]) => request(...args) }));
vi.mock('../src/composables/useAppContext', () => ({ useAppContext: () => app }));

let wrapper: VueWrapper | undefined;
const savedSession = { id: 'measurement-1', memberId: 'member', items: [], revision: 1 } as unknown as MeasurementSession;

function render(props: Record<string, unknown> = {}) {
  wrapper = mount(Editor, { props, global: { stubs: { Teleport: true } } });
  return wrapper;
}

function item(partial: Partial<MeasurementSession['items'][number]>): MeasurementSession['items'][number] {
  return {
    id: partial.canonicalKey || 'item',
    sessionId: 'measurement-1',
    memberId: 'member',
    canonicalKey: 'body_weight',
    displayName: '体重',
    resultText: '70',
    numericValue: 70,
    unit: 'kg',
    canonicalValue: 70,
    canonicalUnit: 'kg',
    pairGroup: null,
    sortOrder: 0,
    origin: 'entered',
    quality: 'high',
    ...partial,
  };
}

afterEach(() => {
  useConfirm().cancel();
  wrapper?.unmount();
  wrapper = undefined;
  request.mockReset();
  app.notifyDataChanged.mockClear();
});

it('keeps an incomplete or reversed blood pressure pair from being saved', async () => {
  const view = render();
  const save = () => view.get('button[type="submit"]');
  expect(save().attributes('disabled')).toBeDefined();
  await view.get('[aria-label="收缩压"]').setValue('120');
  expect(view.text()).toContain('血压请同时填写收缩压和舒张压');
  expect(save().attributes('disabled')).toBeDefined();
  await view.get('[aria-label="收缩压"]').setValue('');
  await view.get('[aria-label="脉搏"]').setValue('70');
  expect(save().attributes('disabled')).toBeDefined();
  await view.get('[aria-label="收缩压"]').setValue('110');
  await view.get('[aria-label="舒张压"]').setValue('120');
  expect(view.text()).toContain('收缩压应高于舒张压');
  expect(save().attributes('disabled')).toBeDefined();
  await view.get('form').trigger('submit');
  expect(request).not.toHaveBeenCalled();
});

it('clears the previous save error when the measurement type changes', async () => {
  const view = render();
  await view.get('[aria-label="收缩压"]').setValue('120');
  await view.get('[aria-label="舒张压"]').setValue('80');
  request.mockRejectedValueOnce(new Error('合成失败'));
  await view.get('form').trigger('submit');
  await flushPromises();
  expect(view.text()).toContain('合成失败');
  view.getComponent(FormSelect).vm.$emit('update:modelValue', 'body_metrics');
  await nextTick();
  expect(view.text()).not.toContain('合成失败');
  expect(view.text()).not.toContain('收缩压应高于舒张压');
});

it('cancels an unchanged measurement without asking to discard it', async () => {
  const view = render({
    entry: {
      id: 'measurement-1', memberId: 'member', recordedAt: '2026-03-02T08:00', channel: 'manual',
      templateId: 'body_metrics', note: null, deviceVendor: null, deviceModel: null, deviceId: null,
      deviceFirmware: null, externalRef: null, revision: 3, deletedAt: null,
      items: [item({ canonicalKey: 'body_weight', displayName: '体重', numericValue: 70, unit: 'kg' })],
    } satisfies MeasurementSession,
  });
  await view.findAll('button').find((button) => button.text() === '取消')!.trigger('click');
  expect(useConfirm().state.value).toBeNull();
  expect(view.emitted('cancel')).toHaveLength(1);
});

it('asks before discarding edits and shows a derived BMI without sending it back as entered', async () => {
  const entry: MeasurementSession = {
    id: 'measurement-1',
    memberId: 'member',
    recordedAt: '2026-03-02T08:00',
    channel: 'manual',
    templateId: 'body_metrics',
    note: null,
    deviceVendor: null,
    deviceModel: null,
    deviceId: null,
    deviceFirmware: null,
    externalRef: null,
    revision: 3,
    deletedAt: null,
    items: [
      item({ canonicalKey: 'body_weight', displayName: '体重', numericValue: 70, unit: 'kg' }),
      item({ canonicalKey: 'body_height', displayName: '身高', numericValue: 175, unit: 'cm', canonicalValue: 175, canonicalUnit: 'cm' }),
      item({ canonicalKey: 'body_bmi', displayName: '体重指数', numericValue: 22.86, unit: 'kg/m²', canonicalValue: 22.86, canonicalUnit: 'kg/m²', origin: 'derived' }),
      item({ canonicalKey: 'vital_spo2', displayName: '血氧饱和度', numericValue: 98, unit: '%', canonicalValue: 98, canonicalUnit: '%' }),
    ],
  };
  const view = render({ entry });
  expect(view.get('[aria-label="BMI"]').element).toHaveProperty('value', '');
  expect(view.text()).toContain('当前自动计算 22.86 kg/m²');
  await view.get('[aria-label="体重"]').setValue('71');
  await view.findAll('button').find((button) => button.text() === '取消')!.trigger('click');
  expect(useConfirm().state.value?.title).toBe('放弃未保存的修改？');
  expect(view.emitted('cancel')).toBeUndefined();
  await useConfirm().confirm();
  await flushPromises();
  expect(view.emitted('cancel')).toHaveLength(1);
  view.unmount();

  const again = render({ entry });
  request.mockResolvedValueOnce(savedSession);
  await again.get('form').trigger('submit');
  await flushPromises();
  const body = JSON.parse(request.mock.calls.at(-1)![1].body);
  expect(body.samples.map((sample: { canonicalKey: string }) => sample.canonicalKey)).toEqual([
    'body_weight', 'body_height', 'vital_spo2',
  ]);
});

it('does not carry the previous height into the next continued measurement', async () => {
  const view = render({ allowContinue: true });
  view.getComponent(FormSelect).vm.$emit('update:modelValue', 'body_metrics');
  await flushPromises();
  await view.get('[aria-label="体重"]').setValue('70');
  await view.get('[aria-label="身高"]').setValue('175');
  request.mockResolvedValueOnce(savedSession);
  await view.findAll('button').find((button) => button.text() === '保存并继续')!.trigger('click');
  await flushPromises();
  expect(view.get('[aria-label="身高"]').element).toHaveProperty('value', '');
  expect(view.get('[aria-label="体重"]').element).toHaveProperty('value', '');
  expect(view.emitted('continued')).toHaveLength(1);
});
