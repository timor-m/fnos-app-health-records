import { mount, flushPromises } from '@vue/test-utils';
import { beforeEach, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import SymptomDetail from '../src/components/HealthSymptomDetail.vue';
import Tracker from '../src/components/ProcessSymptomTracker.vue';
import SymptomSeverityPicker from '../src/components/SymptomSeverityPicker.vue';
import DateTimePicker from '../src/components/DateTimePicker.vue';
import type { HealthEpisodeDetail, HealthProcessSymptom } from '../src/types/health-events';

const mocks=vi.hoisted(()=>({request:vi.fn(),ask:vi.fn()}));
const app={selectedMemberId:ref('member'),selectedMember:ref({id:'member',permission:'manager'}),notifyDataChanged:vi.fn()};
vi.mock('../src/utils/api',()=>({request:mocks.request}));
vi.mock('../src/composables/useAppContext',()=>({useAppContext:()=>app}));
vi.mock('../src/composables/useConfirm',()=>({useConfirm:()=>({ask:mocks.ask})}));
const symptom=(id:string,status:'active'|'resolved'='active'):HealthProcessSymptom=>({
  id,episodeId:'process',name:`合成症状${id}`,startedAt:'2026-01-01',status,endedAt:status==='resolved'?'2026-01-04':null,
  severity:0,currentSeverity:0,bodyArea:null,frequency:null,description:'合成症状原始描述',triggerText:null,relievingText:null,associatedSymptomsText:'伴随原文',version:2,updates:[]
});
const episode=():HealthEpisodeDetail=>({id:'process',memberId:'member',episodeType:'symptom',title:'合成阶段',startedAt:'2026-01-01',endedAt:null,status:'active',outcome:null,description:null,eventCount:0,events:[],symptom:null,updates:[],symptoms:[symptom('a'),symptom('b','resolved')]});
const mountTracker=(data=episode(),canManage=true)=>mount(Tracker,{props:{episode:data,canManage},global:{stubs:{Teleport:true}}});
beforeEach(()=>{vi.clearAllMocks();mocks.request.mockResolvedValue({});app.selectedMember.value={id:'member',permission:'manager'};});

it('quick recording targets one symptom, preserves zero and separates measured value from severity',async()=>{
  const data=episode();data.symptoms[0].name='发热';const wrapper=mountTracker(data);
  expect(wrapper.findAll('.process-symptom')).toHaveLength(2);
  expect(wrapper.text()).toContain('合成症状原始描述');expect(wrapper.text()).toContain('伴随原文');
  await wrapper.findAll('.symptom-record-add')[0].trigger('click');
  expect(wrapper.get('[role="dialog"]').attributes('aria-label')).toBe('记录症状变化');
  await wrapper.findAll('.symptom-change button').find(button=>button.text()==='消失')!.trigger('click');
  await wrapper.getComponent(SymptomSeverityPicker).get('[aria-label="0 / 10"]').trigger('click');
  wrapper.getComponent(DateTimePicker).vm.$emit('update:modelValue','2026-01-04T12:00');
  await wrapper.get('input[placeholder="如 37.5"]').setValue('37.5');
  expect(wrapper.get('input[aria-label="体温单位"]').element.value).toBe('℃');
  await wrapper.get('form').trigger('submit');await flushPromises();
  expect(mocks.request).toHaveBeenCalledOnce();
  expect(mocks.request.mock.calls[0][0]).toBe('episodes/process/symptoms/a/updates');
  expect(JSON.parse(mocks.request.mock.calls[0][1].body)).toMatchObject({change:'resolved',severity:0,measurementValue:'37.5',measurementUnit:'℃',recordedAt:'2026-01-04T12:00'});
  expect(wrapper.emitted('updated')).toHaveLength(1);expect(wrapper.find('[role="dialog"]').exists()).toBe(false);
  expect(mocks.request.mock.calls.some(([url])=>url==='episodes/process')).toBe(false);
  wrapper.unmount();
});

it('a resolved symptom defaults to a supplementary observation and supports guarded correction and retraction',async()=>{
  const data=episode();data.status='ended';data.endedAt='2026-01-05';
  data.symptoms[1].updates=[{id:'record',symptomId:'b',recordedAt:'2026-01-04',change:'resolved',severity:0,measurementValue:null,measurementUnit:null,description:'合成变化',version:3,deletedAt:null,createdAt:'2026-01-04'}];
  const wrapper=mountTracker(data);
  await wrapper.findAll('.symptom-record-add')[1].trigger('click');
  expect(wrapper.get('.symptom-change button[aria-pressed="true"]').text()).toBe('仅补充');
  await wrapper.get('[aria-label="关闭症状面板"]').trigger('click');
  await wrapper.findAll('.symptom-actions button').find(button=>button.text()==='纠错')!.trigger('click');
  await wrapper.findAll('.symptom-change button').find(button=>button.text()==='减轻')!.trigger('click');
  await wrapper.get('form').trigger('submit');await flushPromises();
  expect(mocks.request.mock.calls[0][0]).toBe('episodes/process/symptoms/b/updates/record');
  expect(mocks.request.mock.calls[0][1].method).toBe('PATCH');
  expect(JSON.parse(mocks.request.mock.calls[0][1].body)).toMatchObject({version:3,change:'improved',severity:0});
  await wrapper.findAll('.symptom-actions button').find(button=>button.text()==='撤销')!.trigger('click');
  await mocks.ask.mock.calls[0][0].run();await flushPromises();
  expect(mocks.request.mock.calls[1][1].method).toBe('DELETE');expect(JSON.parse(mocks.request.mock.calls[1][1].body)).toEqual({version:3});
  wrapper.unmount();
});

it('failed saves preserve inputs and stale confirmation cannot modify a different process',async()=>{
  const wrapper=mountTracker();
  await wrapper.findAll('button').find(button=>button.text()==='添加症状')!.trigger('click');
  await wrapper.get('input[required]').setValue('合成新症状');
  mocks.request.mockRejectedValueOnce(new Error('保存失败'));
  await wrapper.get('form').trigger('submit');await flushPromises();
  expect(wrapper.get('[role="alert"]').text()).toBe('保存失败');expect(wrapper.get('input[required]').element.value).toBe('合成新症状');
  await wrapper.get('[aria-label="关闭症状面板"]').trigger('click');
  await wrapper.get('[aria-label="移入回收站"]').trigger('click');
  const confirmation=mocks.ask.mock.calls[0][0];
  await wrapper.setProps({episode:{...episode(),id:'next'}});await confirmation.run();
  expect(mocks.request).toHaveBeenCalledOnce();wrapper.unmount();
});

it('viewer sees current status and retracted history without mutation controls',()=>{
  const data=episode();data.symptoms[0].updates=[{id:'old',symptomId:'a',recordedAt:'2026-01-02',change:'worsened',severity:0,description:'合成撤销记录',measurementValue:null,measurementUnit:null,version:2,deletedAt:'2026-01-03',createdAt:'2026-01-02'}];
  const wrapper=mountTracker(data,false);expect(wrapper.text()).toContain('已撤销');expect(wrapper.find('.symptom-facts').text()).toContain('最近程度0 / 10');
  expect(wrapper.findAll('button')).toHaveLength(0);wrapper.unmount();
});

it('correcting a supplementary record keeps its change empty instead of introducing a new status',async()=>{
  const data=episode();data.symptoms[0].updates=[{id:'note',symptomId:'a',recordedAt:'2026-01-02',change:null,severity:null,description:'合成补充',measurementValue:null,measurementUnit:null,version:1,deletedAt:null,createdAt:'2026-01-02'}];
  const wrapper=mountTracker(data);await wrapper.findAll('.symptom-actions button').find(button=>button.text()==='纠错')!.trigger('click');
  expect(wrapper.get('.symptom-change button[aria-pressed="true"]').text()).toBe('仅补充');
  await wrapper.get('textarea').setValue('更正合成补充');await wrapper.get('form').trigger('submit');await flushPromises();
  expect(JSON.parse(mocks.request.mock.calls[0][1].body)).toMatchObject({change:null,description:'更正合成补充'});wrapper.unmount();
});


it.each(['symptom','record'])('keeps the %s creation key for response-loss retries and replaces it after an edit',async(mode)=>{
  const wrapper=mountTracker();
  if(mode==='symptom'){await wrapper.findAll('button').find(button=>button.text()==='添加症状')!.trigger('click');await wrapper.get('input[required]').setValue('合成症状');}
  else await wrapper.findAll('.symptom-record-add')[0].trigger('click');
  mocks.request.mockRejectedValue(new Error('响应丢失'));
  await wrapper.get('form').trigger('submit');await flushPromises();await wrapper.get('form').trigger('submit');await flushPromises();
  const first=JSON.parse(mocks.request.mock.calls[0][1].body);expect(first.requestKey).toBeTruthy();expect(JSON.parse(mocks.request.mock.calls[1][1].body).requestKey).toBe(first.requestKey);
  await wrapper.get('textarea').setValue('新增合成说明');await wrapper.get('form').trigger('submit');await flushPromises();
  expect(JSON.parse(mocks.request.mock.calls[2][1].body).requestKey).not.toBe(first.requestKey);wrapper.unmount();
});

it('the standalone symptom toolbar groups status, editing and a single trash action',()=>{
 const data=episode();data.symptoms=[data.symptoms[0]];const wrapper=mount(Tracker,{props:{episode:data,canManage:true,standalone:true},global:{stubs:{Teleport:true}}});expect(wrapper.find('.process-symptoms > header').exists()).toBe(false);expect(wrapper.text()).not.toContain('添加症状');expect(wrapper.text()).not.toContain('移除条目');expect(wrapper.findAll('[aria-label="移入回收站"]')).toHaveLength(1);const toolbar=wrapper.get('.record-detail-toolbar');expect(toolbar.get('.symptom-current').text()).toBe('持续跟踪');expect(toolbar.get('.symptom-toolbar-edit').text()).toBe('编辑');expect(wrapper.get('.symptom-detail-section-heading .symptom-detail-actions').text()).toBe('新增变化');wrapper.unmount();
});
it('the common toolbar trashes a migrated symptom using its original ID and closes that exact detail',async()=>{
 const data=episode();const id='legacy-symptom:process';data.symptoms=[symptom(id)];mocks.request.mockResolvedValueOnce({episode:data,symptomId:id});
 const wrapper=mount(SymptomDetail,{props:{recordId:id},global:{stubs:{Teleport:true,HealthRecordAssociations:true}}});await flushPromises();await wrapper.get('[aria-label="移入回收站"]').trigger('click');await mocks.ask.mock.calls[0][0].run();await flushPromises();expect(mocks.request).toHaveBeenCalledWith('health-records/trash',{method:'POST',body:JSON.stringify({kind:'symptom',id,revision:2,operation:'trash'})});expect(wrapper.emitted('close')).toHaveLength(1);wrapper.unmount();
});

it('shows recent history newest first, keeps zero severity and its date, and retains expansion on refreshed data',async()=>{
 const data=episode();data.symptoms=[symptom('a')];data.symptoms[0].updates=Array.from({length:5},(_,i)=>({id:`update-${i}`,symptomId:'a',recordedAt:`2026-01-0${i+1}T08:30`,change:'unchanged' as const,severity:i===3?0:null,measurementValue:null,measurementUnit:null,description:`合成变化${i}`,version:1,deletedAt:null,createdAt:`2026-01-0${i+1}`}));
 const wrapper=mount(Tracker,{props:{episode:data,canManage:true,standalone:true},global:{stubs:{Teleport:true}}});
 expect(wrapper.find('.symptom-current strong').exists()).toBe(false);
 expect(wrapper.findAll('.symptom-record').map(row=>row.find('time').text())).toEqual(['2026-01-05 08:30','2026-01-04 08:30','2026-01-03 08:30']);
 expect(wrapper.get('.symptom-facts').text()).toContain('0 / 10');expect(wrapper.get('.symptom-facts small').text()).toBe('2026-01-04 08:30');
 await wrapper.get('.symptom-history-toggle').trigger('click');expect(wrapper.findAll('.symptom-record')).toHaveLength(5);
 await wrapper.setProps({episode:{...data,symptoms:data.symptoms.map(item=>({...item,version:3}))}});expect(wrapper.findAll('.symptom-record')).toHaveLength(5);
 await wrapper.get('.symptom-history-toggle').trigger('click');expect(wrapper.findAll('.symptom-record')).toHaveLength(3);wrapper.unmount();
});

it('shows supplemental facts directly and keeps removal and history corrections in keyboard-dismissable menus',async()=>{
 const data=episode();data.symptoms=[symptom('a')];data.symptoms[0].triggerText='合成诱因';data.symptoms[0].updates=[{id:'u',symptomId:'a',recordedAt:'2026-01-02',change:null,severity:null,measurementValue:null,measurementUnit:null,description:'合成补充',version:1,deletedAt:null,createdAt:'2026-01-02'}];
 const wrapper=mountTracker(data);expect(wrapper.get('.symptom-extra').text()).toContain('合成诱因');expect(wrapper.find('details.symptom-history').exists()).toBe(false);
 const menu=wrapper.get('.symptom-record .symptom-more');expect((menu.element as HTMLDetailsElement).open).toBe(false);
 (menu.element as HTMLDetailsElement).open=true;await menu.trigger('keydown',{key:'Escape'});expect((menu.element as HTMLDetailsElement).open).toBe(false);
 (menu.element as HTMLDetailsElement).open=true;document.body.dispatchEvent(new Event('pointerdown',{bubbles:true}));expect((menu.element as HTMLDetailsElement).open).toBe(false);wrapper.unmount();
});

it('keeps missing dates and severity explicit without inventing values or exposing empty supplemental sections',()=>{
 const data=episode();data.symptoms=[{...symptom('a'),startedAt:null,severity:null,currentSeverity:null,associatedSymptomsText:null}];
 const wrapper=mountTracker(data,false);expect(wrapper.get('.symptom-facts').text()).toContain('开始时间未记录');expect(wrapper.get('.symptom-facts').text()).toContain('最近程度未记录');
 expect(wrapper.find('.symptom-facts small').exists()).toBe(false);expect(wrapper.find('.symptom-extra').exists()).toBe(false);expect(wrapper.get('.symptom-empty').text()).toBe('还没有变化记录。');wrapper.unmount();
});

it('never attributes the latest severity to a revoked observation',()=>{
 const data=episode();data.symptoms=[symptom('a')];data.symptoms[0].updates=[
  {id:'valid',symptomId:'a',recordedAt:'2026-01-02T08:00',change:'unchanged',severity:0,measurementValue:null,measurementUnit:null,description:'合成记录',version:1,deletedAt:null,createdAt:'2026-01-02'},
  {id:'revoked',symptomId:'a',recordedAt:'2026-01-03T08:00',change:'worsened',severity:8,measurementValue:null,measurementUnit:null,description:'合成撤销',version:1,deletedAt:'2026-01-04',createdAt:'2026-01-03'}
 ];
 const wrapper=mountTracker(data,false);expect(wrapper.get('.symptom-facts small').text()).toBe('2026-01-02 08:00');expect(wrapper.get('.symptom-record.is-retracted').text()).toContain('已撤销');wrapper.unmount();
});


it('standalone details share the labeled facts and compact action layout and hide an empty history',async()=>{
 const data=episode();data.symptoms=[{...symptom('a'),bodyArea:'合成部位',frequency:'合成频率',triggerText:'合成诱因',relievingText:'合成缓解因素'}];
 const wrapper=mount(Tracker,{props:{episode:data,canManage:true,standalone:true},global:{stubs:{Teleport:true}}});
 const facts=wrapper.get('.preview-facts.record-detail-facts');
 expect(facts.text()).toContain('最近程度0 / 10');
 const descriptions=wrapper.get('.symptom-description-section');expect(descriptions.get('h4').text()).toBe('补充描述');expect(descriptions.text()).toContain('症状描述合成症状原始描述');
 expect(facts.text()).toContain('身体部位合成部位');expect(facts.text()).toContain('出现频率合成频率');
 expect(descriptions.text()).toContain('诱因合成诱因');expect(descriptions.text()).toContain('缓解因素合成缓解因素');
 expect(wrapper.get('.symptom-information .symptom-detail-section-heading > h4').text()).toBe('症状信息');
 expect(wrapper.find('.symptom-heading-actions').exists()).toBe(false);expect(wrapper.find('.symptom-description').exists()).toBe(false);
 expect(wrapper.find('.symptom-history').exists()).toBe(false);expect(wrapper.get('.record-detail-status').text()).toBe('持续跟踪');
 await wrapper.get('.symptom-detail-actions .symptom-record-add').trigger('click');
 expect(wrapper.get('[role="dialog"]').attributes('aria-label')).toBe('记录症状变化');
 await wrapper.get('[aria-label="关闭症状面板"]').trigger('click');await flushPromises();
 await wrapper.get('.record-detail-toolbar .symptom-toolbar-edit').trigger('click');
 expect(wrapper.get('[role="dialog"]').attributes('aria-label')).toBe('编辑症状');wrapper.unmount();
});

it('standalone history opens initially and preserves a manual collapse through refreshes',async()=>{
 const data=episode();data.symptoms=[symptom('a','resolved')];data.symptoms[0].updates=[{id:'u',symptomId:'a',recordedAt:'2026-01-04T08:30',change:'resolved',severity:0,measurementValue:null,measurementUnit:null,description:'合成变化',version:1,deletedAt:null,createdAt:'2026-01-04'}];
 const wrapper=mount(Tracker,{props:{episode:data,canManage:false,standalone:true}});
 const history=wrapper.get('details.symptom-history');expect((history.element as HTMLDetailsElement).open).toBe(true);
 expect(history.get('summary').text()).toBe('变化记录（1）');expect(wrapper.get('.record-detail-status').classes()).toContain('is-resolved');
 (history.element as HTMLDetailsElement).open=false;
 await wrapper.setProps({episode:{...data,symptoms:[{...data.symptoms[0],version:3}]}});
 expect((wrapper.get('details.symptom-history').element as HTMLDetailsElement).open).toBe(false);
 expect(wrapper.find('.symptom-detail-actions').exists()).toBe(false);
 expect(wrapper.get('.symptom-record time').text()).toBe('2026-01-04 08:30');wrapper.unmount();
});


it('viewer symptom details keep their toolbar status without edit or trash controls',()=>{
 app.selectedMember.value.permission='viewer';
 const data=episode();data.symptoms=[{...symptom('a'),description:null,associatedSymptomsText:null}];
 const wrapper=mount(Tracker,{props:{episode:data,canManage:false,standalone:true}});
 expect(wrapper.find('.symptom-description-section').exists()).toBe(false);
 expect(wrapper.get('.symptom-information .symptom-detail-section-heading > h4').text()).toBe('症状信息');
 expect(wrapper.get('.record-detail-toolbar .symptom-current').text()).toBe('持续跟踪');
 expect(wrapper.find('.record-detail-toolbar button').exists()).toBe(false);
 expect(wrapper.find('.symptom-detail-actions').exists()).toBe(false);wrapper.unmount();
});

it('shows the latest retained observation with its own time even when history is collapsed, without inferring severity',async()=>{
 const data=episode();data.symptoms=[symptom('a')];data.symptoms[0].name='发热';data.symptoms[0].currentSeverity=null;
 const row=(id:string,date:string,value:string,deletedAt:string|null=null)=>({id,symptomId:'a',recordedAt:date,change:null,severity:null,measurementValue:value,measurementUnit:'℃',description:null,version:1,deletedAt,createdAt:date});
 data.symptoms[0].updates=[row('first','2026-01-02T08:00','38.2'),row('latest','2026-01-03T08:00','37.8'),row('retracted','2026-01-04T08:00','39.0','2026-01-04T09:00')];
 const wrapper=mount(Tracker,{props:{episode:data,canManage:false,standalone:true}});
 (wrapper.get('.symptom-history').element as HTMLDetailsElement).open=false;
 expect(wrapper.get('.symptom-facts').text()).toContain('最近体温37.8 ℃');expect(wrapper.get('.symptom-facts').text()).not.toContain('39.0');expect(wrapper.get('.symptom-facts').text()).toContain('最近程度未记录');expect(wrapper.get('.symptom-history').attributes('open')).toBeUndefined();
 const next=structuredClone(data);next.symptoms[0].updates[1].deletedAt='2026-01-03T09:00';await wrapper.setProps({episode:next});expect(wrapper.get('.symptom-facts').text()).toContain('最近体温38.2 ℃');wrapper.unmount();
});


it.each([0,7,null])('edits the existing symptom with severity %s through tags without creating another record',async(severity)=>{
 const data=episode();data.symptoms=[symptom('a')];
 const wrapper=mount(Tracker,{props:{episode:data,canManage:true,standalone:true},global:{stubs:{Teleport:true}}});
 await wrapper.get('.symptom-toolbar-edit').trigger('click');
 const picker=wrapper.getComponent(SymptomSeverityPicker);expect(picker.get('[aria-pressed=true]').text()).toBe('0');
 await picker.get(severity===null?'.symptom-severity-heading button':`[aria-label="${severity} / 10"]`).trigger('click');
 expect(mocks.request).not.toHaveBeenCalled();
 await wrapper.get('form').trigger('submit');await flushPromises();
 const call=mocks.request.mock.calls[0];expect(call[0]).toBe('episodes/process/symptoms/a');expect(call[1].method).toBe('PATCH');
 expect(JSON.parse(call[1].body)).toMatchObject({severity,version:2,name:'合成症状a'});wrapper.unmount();
});
