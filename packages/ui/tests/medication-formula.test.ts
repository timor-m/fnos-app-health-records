import { afterEach, expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import MedicationFormulaPanel from '../src/components/MedicationFormulaPanel.vue';
import ClinicalFactEditor from '../src/components/ClinicalFactEditor.vue';
import { syntheticFormula } from '../../server/tests/fixtures/decoction-formula';
import type { MedicationFormula } from '../../shared/medication-formula';

const wrappers: ReturnType<typeof mount>[] = [];
const mocks=vi.hoisted(()=>({request:vi.fn().mockResolvedValue({})}));
vi.mock('../src/utils/api',()=>({request:mocks.request}));
afterEach(()=>wrappers.splice(0).forEach(wrapper=>wrapper.unmount()));
function render(editable=false,showSource=false) {
  const wrapper=mount(MedicationFormulaPanel,{props:{formula:structuredClone(syntheticFormula),editable,showSource,
    'onUpdate:formula':(formula:MedicationFormula)=>wrapper.setProps({formula})}});
  wrappers.push(wrapper);return wrapper;
}
it('shows the whole recipe with distinct per-dose and total quantities and per-herb evidence',async()=>{
  const wrapper=render(false,true);
  expect(wrapper.get('header').text()).toContain('6 味');
  expect(wrapper.findAll('li')).toHaveLength(6);
  expect(wrapper.findAll('li')[0]!.text()).toContain('每剂 6 g');
  expect(wrapper.findAll('li')[0]!.text()).toContain('调剂总量：18 g');
  await wrapper.findAll('button')[0]!.trigger('click');
  expect(wrapper.emitted('source')?.[0]?.[0]).toEqual(syntheticFormula.ingredients[0]!.evidence);
});
it('corrects a constituent without converting or changing another constituent',async()=>{
  const wrapper=render(true);
  const amount=wrapper.findAll('li')[0]!.findAll('input')[1]!;
  await amount.setValue('9');
  expect(wrapper.props('formula').ingredients[0]!.amount).toBe('9');
  expect(wrapper.props('formula').ingredients[0]!.totalAmount).toBe('18');
  expect(wrapper.props('formula').ingredients[1]).toEqual(syntheticFormula.ingredients[1]);
  await wrapper.get('header button').trigger('click');
  expect(wrapper.props('formula').ingredients).toHaveLength(7);
  expect(wrapper.props('formula').ingredients[6]!.amountBasis).toBe('unspecified');
});
it('does not present unhandled source controls or imply an unspecified quantity is per-dose',async()=>{
  const wrapper=render();
  const formula=structuredClone(syntheticFormula);formula.ingredients[0]!.amountBasis='unspecified';
  await wrapper.setProps({formula});
  expect(wrapper.findAll('button')).toHaveLength(0);
  expect(wrapper.findAll('li')[0]!.text()).toContain('用量口径待核对');
  expect(wrapper.findAll('li')[0]!.text()).not.toContain('每剂');
});
it('saves a corrected recipe through the normal clinical editor without converting its total quantity',async()=>{
  mocks.request.mockClear();
  const wrapper=mount(ClinicalFactEditor,{props:{open:true,type:'medication',reportId:'synthetic',expectedSourceVersion:3,
    fact:{id:'synthetic-formula',medicationName:'合成汤剂',context:'prescription',formula:structuredClone(syntheticFormula)}},
    global:{stubs:{Teleport:true}}});
  wrappers.push(wrapper);await flushPromises();
  expect(wrapper.text()).toContain('药方名称');
  expect(wrapper.text()).not.toContain('通用名');
  await wrapper.getComponent(MedicationFormulaPanel).findAll('li')[0]!.findAll('input')[1]!.setValue('9');
  await wrapper.get('form').trigger('submit');await flushPromises();
  expect(mocks.request).toHaveBeenCalledOnce();
  const [path,options]=mocks.request.mock.calls[0]!;
  expect(path).toBe('clinical-facts/medication/synthetic-formula');
  const body=JSON.parse(options.body);
  expect(body.expectedSourceVersion).toBe(3);
  expect(body.formula.ingredients[0].amount).toBe('9');
  expect(body.formula.ingredients[0].totalAmount).toBe('18');
  expect(body.dose).toBe('');
});
