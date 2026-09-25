import {describe,it,expect,vi,beforeEach} from 'vitest';
import {mount,flushPromises} from '@vue/test-utils';
import ObservationTimeEditor from '../src/components/ObservationTimeEditor.vue';
import type {Observation} from '../src/types/api';
const {request}=vi.hoisted(()=>({request:vi.fn()}));
vi.mock('../src/utils/api',()=>({request}));
const observation={id:'o',examinationId:'e',examinationTime:'2026-09-01'} as Observation;
beforeEach(()=>request.mockReset());
describe('inline observation time',()=>{
 it('shows time to readers without requesting editing metadata',()=>{
  const wrapper=mount(ObservationTimeEditor,{props:{reportId:'r',observation,canManage:false}});
  expect(wrapper.text()).toContain('2026-09-01');expect(wrapper.find('button').exists()).toBe(false);expect(request).not.toHaveBeenCalled();
 });
 it('moves only the selected indicator with version protection',async()=>{
  request.mockResolvedValueOnce({version:2,reportVersion:7,examinations:[{id:'e',occurredAt:'2026-09-01',timeKind:'sampled',reportNumber:'SYN',sampledAt:'2026-09-01'}]}).mockResolvedValueOnce({});
  const wrapper=mount(ObservationTimeEditor,{props:{reportId:'r',observation,canManage:true}});
  await wrapper.get('button').trigger('click');await flushPromises();
  await wrapper.get('input').setValue('2026-09-02');await wrapper.get('form').trigger('submit');await flushPromises();
  const body=JSON.parse(request.mock.calls[1][1].body);
  expect(body).toMatchObject({version:2,reportVersion:7,observationIds:['o'],examination:{sampledAt:'2026-09-02',examinedAt:null,issuedAt:null}});
  expect(body.id).toBeUndefined();expect(wrapper.emitted('updated')).toHaveLength(1);
 });
});
