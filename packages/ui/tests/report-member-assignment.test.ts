import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { ref } from 'vue';
import ReportDetail from '../src/components/ReportDetail.vue';
import FormSelect from '../src/components/FormSelect.vue';

const mocks=vi.hoisted(()=>({ask:vi.fn(),toast:vi.fn(),notify:vi.fn(),refreshMembers:vi.fn(async()=>{})}));
const members=ref<Array<{id:string;displayName:string;relationship:string;permission:string}>>([]);
vi.mock('../src/composables/useAppContext',()=>({useAppContext:()=>({
  session:ref({authenticated:true,id:'synthetic-user',isAdmin:false}),selectedMemberId:ref('m1'),allMembers:members,refreshReminderCount:vi.fn(),notifyDataChanged:mocks.notify,refreshMembers:mocks.refreshMembers,
})}));
vi.mock('../src/composables/useConfirm',()=>({useConfirm:()=>({ask:mocks.ask})}));
vi.mock('../src/composables/useToast',()=>({useToast:()=>({show:mocks.toast})}));
vi.mock('../src/composables/useScrollLock',()=>({useScrollLock:()=>{}}));

const initialMembers=[
  {id:'m1',displayName:'当前合成成员',relationship:'self',permission:'manager'},
  {id:'m2',displayName:'其他合成成员',relationship:'parent',permission:'manager'},
  {id:'m3',displayName:'只读合成成员',relationship:'other',permission:'viewer'},
];
function payload(id='r1') {return {id,memberId:'m1',title:'合成资料',reportType:'prescription',status:'ready',sourceVersion:1,
  observations:[],pages:[],morphologyFindings:[],diagnoses:[],medications:[],procedures:[],vaccinations:[],billingItems:[],billingSummary:null,structuredSections:[],duplicateCandidates:[],
  memberIdentityAssessment:{patientName:'李小明',patientSex:'female',patientBirthDate:null,patientAgeText:'35岁',patientApproxBirthDate:null,mismatchedFields:['name'],verificationIncomplete:false,candidates:[]}};}
function json(data:unknown){return new Response(JSON.stringify({ok:true,data}),{headers:{'content-type':'application/json'}});}
let fetchMock:ReturnType<typeof vi.fn>;
const wrappers:ReturnType<typeof mount>[]=[];
beforeEach(()=>{
  vi.clearAllMocks();members.value=structuredClone(initialMembers);
  let assigned = false;
  fetchMock=vi.fn(async(input:RequestInfo|URL)=>{
    const url=String(input).replace('?includeDuplicateCandidates=false','');
    if(url.endsWith('/assign-member')) { assigned = true; return json({reportId:'r1',memberId:'m2'}); }
    if(url.endsWith('/api/reports/r1'))return json({...payload(),memberId:assigned?'m2':'m1'});
    if(url.endsWith('/api/reports/r2'))return json(payload('r2'));
    if(url.includes('/jobs'))return json([]);
    return json({});
  });
  vi.stubGlobal('fetch',fetchMock);
});
afterEach(()=>{wrappers.splice(0).forEach(wrapper=>wrapper.unmount());vi.unstubAllGlobals();});
async function render(extraProps:Record<string,unknown>={}){
  const wrapper=mount(ReportDetail,{props:{reportId:'r1',expectedMemberId:'m1',variant:'panel',...extraProps},global:{stubs:{teleport:true,RouterLink:true,
    ReportNotesPanel:true,ReportProcessAssociation:true,ReportMedicationUseButton:true,ReportPageAppend:true}}});
  wrappers.push(wrapper);await flushPromises();return wrapper;
}
function action(wrapper:ReturnType<typeof mount>,text:string){return wrapper.findAll('button').find(button=>button.text()===text)!;}
function assignments(){return fetchMock.mock.calls.filter(([url,options])=>String(url).includes('/assign-member')&&options?.method==='POST');}

it('offers a manual destination with no recommendations, filters permissions and confirms before writing',async()=>{
  const wrapper=await render();
  expect(wrapper.text()).toContain('李小明');
  expect(action(wrapper,'选择已有成员')).toBeDefined();
  await action(wrapper,'选择已有成员').trigger('click');
  const select=wrapper.getComponent(FormSelect);
  expect(select.props('options').map((option:{value:string})=>option.value)).toEqual(['','m2']);
  expect(select.props('modelValue')).toBe('');
  expect(action(wrapper,'核对并归属').attributes('disabled')).toBeDefined();
  select.vm.$emit('update:modelValue','m2');await flushPromises();
  expect(assignments()).toHaveLength(0);
  await wrapper.get('.member-create-form').trigger('submit');
  expect(mocks.ask).toHaveBeenCalledOnce();expect(assignments()).toHaveLength(0);
  await mocks.ask.mock.calls[0]![0].run();await flushPromises();
  expect(assignments()).toHaveLength(1);
  expect(JSON.parse(assignments()[0]![1].body)).toEqual({memberId:'m2'});
  expect(wrapper.find('.member-create-form').exists()).toBe(false);
  expect(wrapper.emitted('close')).toHaveLength(1);
  expect(wrapper.emitted('updated')).toHaveLength(1);
  expect(mocks.notify).toHaveBeenCalledOnce();
  expect(fetchMock.mock.calls.filter(([url])=>String(url).includes('/reports/r1?'))).toHaveLength(1);
  expect(wrapper.text()).not.toContain('此档案不属于当前成员');
});
it('keeps the manual entry and explains when no other manageable member exists',async()=>{
  members.value=initialMembers.filter(member=>member.id!=='m2');const wrapper=await render();
  await action(wrapper,'选择已有成员').trigger('click');
  expect(wrapper.text()).toContain('暂无其他可管理的成员');
  expect(wrapper.findComponent(FormSelect).exists()).toBe(false);
  expect(assignments()).toHaveLength(0);
});
it('does not expose reassignment controls for a source viewer',async()=>{
  members.value=initialMembers.map(member=>member.id==='m1'?{...member,permission:'viewer'}:member);
  const wrapper=await render();
  expect(action(wrapper,'选择已有成员')).toBeUndefined();
  expect(action(wrapper,'创建新成员并归属')).toBeUndefined();
});
it('clears the selection on report change and rejects confirmation from an earlier report',async()=>{
  const wrapper=await render();await action(wrapper,'选择已有成员').trigger('click');
  wrapper.getComponent(FormSelect).vm.$emit('update:modelValue','m2');await flushPromises();
  await wrapper.get('.member-create-form').trigger('submit');
  const pending=mocks.ask.mock.calls[0]![0];
  await wrapper.setProps({reportId:'r2'});await flushPromises();
  expect(wrapper.find('.member-create-form').exists()).toBe(false);
  await pending.run();expect(assignments()).toHaveLength(0);
  await action(wrapper,'选择已有成员').trigger('click');
  expect(wrapper.getComponent(FormSelect).props('modelValue')).toBe('');
});
it('rejects a destination whose management permission was revoked before confirmation',async()=>{
  const wrapper=await render();await action(wrapper,'选择已有成员').trigger('click');
  wrapper.getComponent(FormSelect).vm.$emit('update:modelValue','m2');await flushPromises();
  await wrapper.get('.member-create-form').trigger('submit');
  members.value=members.value.map(member=>member.id==='m2'?{...member,permission:'viewer'}:member);
  await mocks.ask.mock.calls[0]![0].run();
  expect(assignments()).toHaveLength(0);
  expect(mocks.toast).toHaveBeenCalled();
});

it('closes after creating a destination and treats member-list refresh failure as a completed assignment',async()=>{
  const wrapper=await render();
  await action(wrapper,'创建新成员并归属').trigger('click');
  mocks.refreshMembers.mockRejectedValueOnce(new Error('offline'));
  await wrapper.get('.member-create-form').trigger('submit');await flushPromises();
  expect(assignments()).toHaveLength(1);
  expect(JSON.parse(assignments()[0]![1].body).newMember.displayName).toBe('李小明');
  expect(wrapper.emitted('close')).toHaveLength(1);
  expect(mocks.refreshMembers).toHaveBeenCalledOnce();
  expect(wrapper.text()).not.toContain('此档案不属于当前成员');
  expect(mocks.toast).toHaveBeenCalledWith('归属已完成，成员列表刷新失败，请刷新页面后查看');
});
it('keeps the detail open when reassignment fails',async()=>{
  const wrapper=await render();await action(wrapper,'选择已有成员').trigger('click');
  wrapper.getComponent(FormSelect).vm.$emit('update:modelValue','m2');await flushPromises();
  await wrapper.get('.member-create-form').trigger('submit');
  fetchMock.mockImplementationOnce(async()=>new Response(JSON.stringify({ok:false,error:{message:'归属失败'}}),{status:403,headers:{'content-type':'application/json'}}));
  await mocks.ask.mock.calls[0]![0].run();await flushPromises();
  expect(wrapper.emitted('close')).toBeUndefined();
  expect(mocks.notify).not.toHaveBeenCalled();
  expect(wrapper.find('.member-create-form').exists()).toBe(true);
});

function holdOperation(path:string) {
  let resolve!:(response:Response)=>void;
  let reject!:(error:Error)=>void;
  const pending=new Promise<Response>((yes,no)=>{resolve=yes;reject=no;});
  const previous=fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation((input:RequestInfo|URL,options?:RequestInit)=>String(input).endsWith(path)?pending:previous(input,options));
  return {resolve:(response=json({reportId:'r1',memberId:'m2'}))=>resolve(response),reject};
}
async function chooseDestination(wrapper:ReturnType<typeof mount>) {
  await action(wrapper,'选择已有成员').trigger('click');
  wrapper.getComponent(FormSelect).vm.$emit('update:modelValue','m2');await flushPromises();
  await wrapper.get('.member-create-form').trigger('submit');
  return mocks.ask.mock.calls.at(-1)![0];
}
it('rejects an old confirmation even after navigating away and back to the same report',async()=>{
  const wrapper=await render();const confirmation=await chooseDestination(wrapper);
  await wrapper.setProps({reportId:'r2'});await flushPromises();
  await wrapper.setProps({reportId:'r1'});await flushPromises();
  await confirmation.run();expect(assignments()).toHaveLength(0);
});
it('does not close a new report when an earlier assignment finishes',async()=>{
  const wrapper=await render();const confirmation=await chooseDestination(wrapper);
  const pending=holdOperation('/assign-member');const operation=confirmation.run();await flushPromises();
  expect(action(wrapper,'创建新成员并归属').attributes('disabled')).toBeDefined();
  expect(action(wrapper,'确认属于当前成员').attributes('disabled')).toBeDefined();
  await wrapper.setProps({reportId:'r2'});await flushPromises();
  pending.resolve();await operation;await flushPromises();
  expect(wrapper.emitted('close')).toBeUndefined();expect(wrapper.emitted('updated')).toBeUndefined();
  expect(action(wrapper,'选择已有成员').attributes('disabled')).toBeUndefined();
  expect(mocks.notify).toHaveBeenCalledOnce();
});
it('does not write an earlier create failure into the next report form',async()=>{
  const wrapper=await render();await action(wrapper,'创建新成员并归属').trigger('click');
  const pending=holdOperation('/assign-member');
  await wrapper.get('.member-create-form').trigger('submit');
  expect(action(wrapper,'选择已有成员').attributes('disabled')).toBeDefined();
  await wrapper.setProps({reportId:'r2'});await flushPromises();
  await action(wrapper,'创建新成员并归属').trigger('click');
  pending.reject(new Error('earlier synthetic failure'));await flushPromises();
  expect(wrapper.text()).not.toContain('earlier synthetic failure');
  expect(wrapper.find('.member-create-form').exists()).toBe(true);
  expect(action(wrapper,'创建并归属').attributes('disabled')).toBeUndefined();
});
it('does not close a newly opened creation form when an earlier create finishes',async()=>{
  const wrapper=await render();await action(wrapper,'创建新成员并归属').trigger('click');
  const pending=holdOperation('/assign-member');await wrapper.get('.member-create-form').trigger('submit');
  await wrapper.setProps({reportId:'r2'});await flushPromises();
  await action(wrapper,'创建新成员并归属').trigger('click');
  pending.resolve();await flushPromises();
  expect(wrapper.emitted('close')).toBeUndefined();
  expect(wrapper.find('.member-create-form').exists()).toBe(true);
});
it('does not reload the next report after confirming ownership of an earlier report',async()=>{
  const wrapper=await render();const pending=holdOperation('/dismiss-member-mismatch');
  await action(wrapper,'确认属于当前成员').trigger('click');
  expect(action(wrapper,'选择已有成员').attributes('disabled')).toBeDefined();
  await wrapper.setProps({reportId:'r2'});await flushPromises();
  const reads=fetchMock.mock.calls.filter(([url])=>String(url).includes('/reports/r2?')).length;
  pending.resolve();await flushPromises();
  expect(fetchMock.mock.calls.filter(([url])=>String(url).includes('/reports/r2?'))).toHaveLength(reads);
  expect(mocks.toast).not.toHaveBeenCalledWith('已忽略这份报告的成员提醒');
});
it('does not reload the next report after an earlier archive finishes',async()=>{
  const wrapper=await render({initialDetail:{...payload(),status:'needs_review'}});const pending=holdOperation('/confirm');
  await action(wrapper,'确认归档').trigger('click');
  expect(action(wrapper,'选择已有成员').attributes('disabled')).toBeDefined();
  await wrapper.setProps({reportId:'r2'});await flushPromises();
  const reads=fetchMock.mock.calls.filter(([url])=>String(url).includes('/reports/r2?')).length;
  pending.resolve();await flushPromises();
  expect(fetchMock.mock.calls.filter(([url])=>String(url).includes('/reports/r2?'))).toHaveLength(reads);
  expect(mocks.toast).not.toHaveBeenCalledWith('已确认归档');
});

it('ignores detail data requested before reassignment completed, including the summary fallback',async()=>{
  const wrapper=await render({initialDetail:payload(),summary:payload()});
  const pending=holdOperation('/api/reports/r1?includeDuplicateCandidates=false');
  wrapper.findComponent({name:'ReportPageAppend'}).vm.$emit('stateChanged','ocr');await flushPromises();
  const loaded=wrapper.emitted('loaded')?.length || 0;
  const confirmation=await chooseDestination(wrapper);await confirmation.run();await flushPromises();
  pending.resolve(json(payload()));await flushPromises();
  expect(wrapper.emitted('loaded')).toHaveLength(loaded);
  expect(wrapper.emitted('close')).toHaveLength(1);
  expect(action(wrapper,'选择已有成员')).toBeUndefined();
  expect(wrapper.text()).not.toContain('李小明');
});
