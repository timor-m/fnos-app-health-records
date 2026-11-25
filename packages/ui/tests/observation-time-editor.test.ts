import {describe,it,expect,vi,beforeEach,afterEach} from 'vitest';
import {mount,flushPromises} from '@vue/test-utils';
import ObservationTimeEditor from '../src/components/ObservationTimeEditor.vue';
import DateTimePicker from '../src/components/DateTimePicker.vue';
import type {Observation} from '../src/types/api';
const {request}=vi.hoisted(()=>({request:vi.fn()}));
vi.mock('../src/utils/api',()=>({request}));
const observation={id:'o',examinationId:'e',examinationTime:'2026-09-01'} as Observation;
beforeEach(()=>request.mockReset());
afterEach(()=>vi.unstubAllGlobals());
describe('inline observation time',()=>{
 it('shows time to readers without requesting editing metadata',()=>{
  const wrapper=mount(ObservationTimeEditor,{props:{reportId:'r',observation,canManage:false}});
  expect(wrapper.text()).toContain('2026-09-01');expect(wrapper.find('button').exists()).toBe(false);expect(request).not.toHaveBeenCalled();
 });
 it('moves only the selected indicator with version protection',async()=>{
  request.mockResolvedValueOnce({version:2,reportVersion:7,examinations:[{id:'e',occurredAt:'2026-09-01',timeKind:'sampled',reportNumber:'SYN',sampledAt:'2026-09-01'}]}).mockResolvedValueOnce({});
  const wrapper=mount(ObservationTimeEditor,{props:{reportId:'r',observation,canManage:true}});
  await wrapper.get('button').trigger('click');await flushPromises();
  wrapper.getComponent(DateTimePicker).vm.$emit('update:modelValue','2026-09-02');await wrapper.vm.$nextTick();await wrapper.get('form').trigger('submit');await flushPromises();
  const body=JSON.parse(request.mock.calls[1][1].body);
  expect(body).toMatchObject({version:2,reportVersion:7,observationIds:['o'],examination:{sampledAt:'2026-09-02',examinedAt:null,issuedAt:null}});
  expect(body.id).toBeUndefined();expect(wrapper.emitted('updated')).toHaveLength(1);
 });
 it('loads source-local time into the picker and preserves date-only precision',async()=>{
  request.mockResolvedValueOnce({version:2,reportVersion:7,examinations:[{id:'e',occurredAt:'2026-09-01 08:30:15',timeKind:'examined'}]}).mockResolvedValueOnce({});
  const wrapper=mount(ObservationTimeEditor,{props:{reportId:'r',observation,canManage:true}});
  await wrapper.get('button').trigger('click');await flushPromises();
  const picker=wrapper.getComponent(DateTimePicker);
  expect(picker.props('modelValue')).toBe('2026-09-01T08:30:15');
  expect(picker.props('showTime')).toBe(true);
  await wrapper.get('input[type="checkbox"]').setValue(false);
  expect(picker.props('modelValue')).toBe('2026-09-01');
  expect(picker.props('showTime')).toBe(false);
  await wrapper.get('form').trigger('submit');await flushPromises();
  expect(JSON.parse(request.mock.calls[1][1].body).examination.examinedAt).toBe('2026-09-01');
 });
 it('requires a selected date and explicit time instead of inventing midnight',async()=>{
  request.mockResolvedValueOnce({version:2,reportVersion:7,examinations:[]}).mockResolvedValueOnce({});
  const wrapper=mount(ObservationTimeEditor,{props:{reportId:'r',observation,canManage:true}});
  await wrapper.get('button').trigger('click');await flushPromises();
  await wrapper.get('form').trigger('submit');
  expect(request).toHaveBeenCalledTimes(1);
  expect(wrapper.get('[role="alert"]').text()).toContain('请选择');
  const picker=wrapper.getComponent(DateTimePicker);
  picker.vm.$emit('update:modelValue','2026-09-02');await wrapper.vm.$nextTick();
  await wrapper.get('input[type="checkbox"]').setValue(true);
  expect(wrapper.get('button[type="submit"]').attributes('disabled')).toBeDefined();
  picker.vm.$emit('update:modelValue','2026-09-02T09:45');await wrapper.vm.$nextTick();
  await wrapper.get('form').trigger('submit');await flushPromises();
  expect(JSON.parse(request.mock.calls[1][1].body).examination.examinedAt).toBe('2026-09-02 09:45');
 });
 it('saves on HTTP when randomUUID is unavailable and generates a fresh request key',async()=>{
  const getRandomValues=vi.fn((bytes:Uint8Array)=>{bytes.fill(getRandomValues.mock.calls.length);return bytes;});
  vi.stubGlobal('crypto',{getRandomValues});
  const state={version:2,reportVersion:7,examinations:[{id:'e',occurredAt:'2026-09-01',timeKind:'examined'}]};
  request.mockResolvedValue(state);
  const wrapper=mount(ObservationTimeEditor,{props:{reportId:'r',observation,canManage:true}});
  for(let i=0;i<2;i++){
   await wrapper.get('button').trigger('click');await flushPromises();
   await wrapper.get('form').trigger('submit');await flushPromises();
  }
  const bodies=request.mock.calls.filter(([,options])=>options?.method==='PUT').map(([,options])=>JSON.parse(options.body));
  expect(bodies).toHaveLength(2);
  expect(bodies[0].requestKey).toMatch(/^time-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  expect(bodies[0].requestKey).not.toBe(bodies[1].requestKey);
  expect(wrapper.emitted('updated')).toHaveLength(2);
 });
 it('confirms a pending indicator time over HTTP without relying on the report date',async()=>{
  vi.stubGlobal('crypto',{getRandomValues:(bytes:Uint8Array)=>{bytes.fill(42);return bytes;}});
  request.mockResolvedValueOnce({version:3,reportVersion:8,examinations:[
   {id:'e',occurredAt:null,timeKind:'unknown',confirmationStatus:'pending'},
  ]}).mockResolvedValueOnce({});
  const wrapper=mount(ObservationTimeEditor,{props:{reportId:'r',observation:{...observation,examinationTime:null,examinationTimeStatus:'pending'},canManage:true}});
  expect(wrapper.text()).toContain('检查时间待确认');
  await wrapper.get('button').trigger('click');await flushPromises();
  const picker=wrapper.getComponent(DateTimePicker);
  expect(picker.props('modelValue')).toBeNull();
  picker.vm.$emit('update:modelValue','2026-09-03');await wrapper.vm.$nextTick();
  await wrapper.get('form').trigger('submit');await flushPromises();
  expect(request.mock.calls[1][0]).toBe('reports/r/examinations');
  const body=JSON.parse(request.mock.calls[1][1].body);
  expect(body).toMatchObject({version:3,reportVersion:8,observationIds:['o'],examination:{examinedAt:'2026-09-03'}});
  expect(wrapper.find('[role="alert"]').exists()).toBe(false);
  expect(wrapper.find('form').exists()).toBe(false);
  expect(wrapper.emitted('updated')).toHaveLength(1);
 });
 it('defaults to page confirmation with a visible count and allows current-only correction',async()=>{
  const state={version:3,reportVersion:8,examinations:[{id:'e',occurredAt:null,timeKind:'unknown',confirmationStatus:'pending'}],pageTimeGroups:[{pageNumber:5,observationIds:['o','peer']}]};
  request.mockResolvedValue(state);
  const wrapper=mount(ObservationTimeEditor,{props:{reportId:'r',observation:{...observation,examinationTime:null},canManage:true}});
  await wrapper.get('button').trigger('click');await flushPromises();
  expect(wrapper.text()).toContain('第 5 页其余 1 项');
  expect(wrapper.get('button[type="submit"]').text()).toBe('保存本页 2 项时间');
  wrapper.getComponent(DateTimePicker).vm.$emit('update:modelValue','2026-09-03');await wrapper.vm.$nextTick();
  await wrapper.get('form').trigger('submit');await flushPromises();
  let body=JSON.parse(request.mock.calls[1][1].body);
  expect(body).toMatchObject({applyToPage:true,observationIds:['o']});
  await wrapper.get('button').trigger('click');await flushPromises();
  const checkboxes=wrapper.findAll('input[type="checkbox"]');
  await checkboxes[1].setValue(false);
  wrapper.getComponent(DateTimePicker).vm.$emit('update:modelValue','2026-09-04');await wrapper.vm.$nextTick();
  expect(wrapper.get('button[type="submit"]').text()).toBe('保存时间');
  await wrapper.get('form').trigger('submit');await flushPromises();
  body=JSON.parse(request.mock.calls[3][1].body);expect(body.applyToPage).toBeUndefined();expect(body.observationIds).toEqual(['o']);
 });
 it('does not offer page confirmation without a safe page group or for a reader',async()=>{
  request.mockResolvedValue({version:1,reportVersion:1,examinations:[],pageTimeGroups:[{pageNumber:2,observationIds:['another','peer']}]});
  const wrapper=mount(ObservationTimeEditor,{props:{reportId:'r',observation,canManage:true}});
  await wrapper.get('button').trigger('click');await flushPromises();
  expect(wrapper.text()).not.toContain('同时确认');expect(wrapper.text()).toContain('只调整当前指标');
 });

});
