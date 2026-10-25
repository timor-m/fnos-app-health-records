import {DOMWrapper,flushPromises,mount} from '@vue/test-utils';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {ref} from 'vue';
import Associations from '../src/components/HealthRecordAssociations.vue';
import type {HealthRecordRef,RecordAssociation} from '../../shared/health-record-associations';
import type {HealthFeedEntry} from '../../shared/health-categories';
const mocks=vi.hoisted(()=>({request:vi.fn(),ask:vi.fn(),toast:vi.fn()}));
const app={selectedMemberId:ref('member'),selectedMember:ref({id:'member',permission:'manager'}),dataVersion:ref(0),notifyDataChanged:vi.fn()};
vi.mock('../src/utils/api',()=>({request:mocks.request}));
vi.mock('../src/composables/useAppContext',()=>({useAppContext:()=>app}));
vi.mock('../src/composables/useConfirm',()=>({useConfirm:()=>({ask:mocks.ask})}));
vi.mock('../src/composables/useToast',()=>({useToast:()=>({show:mocks.toast})}));
vi.mock('vue-router',()=>({useRoute:()=>({fullPath:'/events'}),RouterLink:{props:['to'],template:'<a><slot/></a>'}}));
const entry=(id='new',kind:HealthRecordRef['kind']='report'):HealthFeedEntry=>({id:`${kind}:${id}`,resourceId:id,kind,memberId:'member',category:kind==='symptom'?'symptom':'report',title:'合成记录 '+id,date:'2026-01-01',status:'ready',subtype:'laboratory',description:null,institution:'合成机构',documents:[],processIds:[]});
let subject:HealthRecordRef;let wrapper:ReturnType<typeof mount>;let host:HTMLElement;
const response=():RecordAssociation=>({memberId:'member',subject,title:'合成当前记录',processes:[],records:[{entry:entry('existing'),directlyLinked:true}],evidence:[]});
const body=()=>new DOMWrapper(document.body);const modal=()=>body().get('.record-association-modal');
const button=(text:string)=>modal().findAll('button').find(item=>item.text()===text)!;
const saves=()=>mocks.request.mock.calls.filter(([path,options])=>path==='health-records/associations'&&options?.method==='POST');
beforeEach(()=>{
 vi.clearAllMocks();subject={kind:'symptom',id:'current'};app.selectedMemberId.value='member';app.selectedMember.value={id:'member',permission:'manager'};
 app.notifyDataChanged.mockImplementation(()=>{app.dataVersion.value++;});
 mocks.request.mockImplementation(async(path:string,options?:RequestInit)=>path.startsWith('health-records?')?{items:[entry()],nextCursor:null,hasMore:false}:options?.method==='POST'?{...response(),records:[...response().records,{entry:entry(),directlyLinked:true}]}:response());
});
afterEach(()=>{wrapper?.unmount();host?.remove();document.body.innerHTML='';vi.useRealTimers();});
async function open(kind:HealthRecordRef['kind']='symptom'){
 subject={kind,id:'current'};host=document.createElement('section');host.setAttribute('role','dialog');host.innerHTML='<div class="retained-content"><details open><summary>保留历史</summary>合成历史</details></div>';document.body.append(host);
 wrapper=mount(Associations,{props:{subject,memberId:'member'},attachTo:host});await flushPromises();
 const trigger=wrapper.findAll('button').find(b=>b.text()==='关联历程')!;await trigger.trigger('click');await flushPromises();return trigger;
}
it.each(['report','symptom','medication_document','medication','intake','vaccination'] as const)('%s opens an independent filtered dialog; confirm saves directly once and returns to the detail',async kind=>{
 const trigger=await open(kind);const retained=wrapper.get('h4').element;
 expect(wrapper.find('.association-editor').exists()).toBe(false);expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(2);
 expect(host.inert).toBe(true);expect(host.getAttribute('aria-hidden')).toBe('true');expect(document.body.style.overflow).toBe('hidden');
 expect(modal().get('h3').text()).toBe('关联历程');expect(modal().get('input[type="search"]').attributes('placeholder')).toBe('搜索名称或日期');expect(button('确定').attributes('disabled')).toBeDefined();
 expect(modal().get('.association-draft-hint').text()).toBe('选择同一健康事项的相关记录，形成或加入健康历程。');
 await modal().get('.record-picker-option input').setValue(true);await modal().get('form').trigger('submit');await flushPromises();
 expect(saves()).toHaveLength(1);expect(JSON.parse(String(saves()[0][1].body))).toMatchObject({subject:{kind,id:'current'},records:[{kind:'report',id:'new'}],action:'attach'});
 expect(mocks.ask).not.toHaveBeenCalled();expect(body().find('.record-association-modal').exists()).toBe(false);expect(wrapper.emitted('updated')).toHaveLength(1);
 expect(wrapper.get('h4').element).toBe(retained);expect(host.inert).toBe(false);expect(host.hasAttribute('aria-hidden')).toBe(false);expect(document.activeElement).toBe(trigger.element);expect(document.body.style.overflow).toBe('');
});
it('filter changes and paging preserve checked records until confirm',async()=>{
 await open();await modal().get('.record-picker-option input').setValue(true);
 const base=mocks.request.getMockImplementation()!;mocks.request.mockImplementation(async(path:string,options?:RequestInit)=>{
  if(!path.startsWith('health-records?'))return base(path,options);
  return path.includes('cursor=older')?{items:[entry('older','symptom')],nextCursor:null,hasMore:false}:{items:[entry('symptom','symptom')],nextCursor:'older',hasMore:true};
 });
 await button('症状').trigger('click');await flushPromises();expect(mocks.request.mock.calls.at(-1)![0]).toContain('category=symptom');await button('加载更多').trigger('click');await flushPromises();
 await modal().findAll('.record-picker-option input')[1].setValue(true);expect(modal().get('.record-picker-hint').text()).toContain('已选择 2 项');
 await modal().get('form').trigger('submit');await flushPromises();expect(JSON.parse(String(saves()[0][1].body)).records).toEqual([{kind:'report',id:'new'},{kind:'symptom',id:'older'}]);
});
it('restores focus while the saved detail refresh is still pending',async()=>{
 const trigger=await open();await modal().get('.record-picker-option input').setValue(true);
 const base=mocks.request.getMockImplementation()!;let finish!:(value:RecordAssociation)=>void;
 mocks.request.mockImplementation((path:string,options?:RequestInit)=>path.startsWith('health-records/associations?')?new Promise(done=>{finish=done;}):base(path,options));
 await modal().get('form').trigger('submit');await flushPromises();
 expect(body().find('.record-association-modal').exists()).toBe(false);expect(trigger.attributes('disabled')).toBeUndefined();expect(document.activeElement).toBe(trigger.element);
 finish(response());await flushPromises();expect(document.activeElement).toBe(trigger.element);
});
it('cancel and Escape keep the original detail, history and focus; selected items have discard protection',async()=>{
 const trigger=await open();const retained=host.querySelector('.retained-content') as HTMLElement;retained.scrollTop=160;
 await modal().get('.record-picker-option input').setValue(true);await button('取消').trigger('click');expect(mocks.ask).toHaveBeenCalledOnce();expect(saves()).toHaveLength(0);
 mocks.ask.mock.calls[0][0].onCancel();await flushPromises();expect((modal().get('.record-picker-option input').element as HTMLInputElement).checked).toBe(true);
 window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',cancelable:true}));mocks.ask.mock.calls.at(-1)![0].run();await flushPromises();
 expect(body().find('.record-association-modal').exists()).toBe(false);expect(retained.scrollTop).toBe(160);expect((retained.querySelector('details') as HTMLDetailsElement).open).toBe(true);expect(document.activeElement).toBe(trigger.element);
});
it('failed saves retain selection and the retry key; duplicate submits and close during saving do not interrupt the save',async()=>{
 await open();await modal().get('.record-picker-option input').setValue(true);mocks.request.mockRejectedValueOnce(Error('合成保存失败'));
 await modal().get('form').trigger('submit');await flushPromises();expect(modal().get('[role="alert"]').text()).toContain('合成保存失败');expect((modal().get('.record-picker-option input').element as HTMLInputElement).checked).toBe(true);
 let finish!:(result:RecordAssociation)=>void;mocks.request.mockReturnValueOnce(new Promise(done=>finish=done));await modal().get('form').trigger('submit');await modal().get('form').trigger('submit');
 expect(saves()).toHaveLength(2);expect(button('取消').attributes('disabled')).toBeDefined();window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',cancelable:true}));await flushPromises();expect(body().find('.record-association-modal').exists()).toBe(true);
 const keys=saves().map(([,options])=>JSON.parse(String(options.body)).requestKey);expect(keys[0]).toBe(keys[1]);finish(response());await flushPromises();expect(body().find('.record-association-modal').exists()).toBe(false);
});
it('focus stays inside the top dialog and the original dialog regains its own attributes',async()=>{
 await open();expect(document.activeElement).toBe(modal().element);window.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',shiftKey:true,cancelable:true}));expect(document.activeElement).toBe(button('取消').element);
 window.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',cancelable:true}));expect(document.activeElement).toBe(modal().get('[aria-label="关闭关联历程"]').element);
});
it('member changes close the modal, release scroll locking and ignore an old successful save',async()=>{
 await open();await modal().get('.record-picker-option input').setValue(true);const old=response();let finish!:(result:RecordAssociation)=>void;mocks.request.mockReturnValueOnce(new Promise(done=>finish=done));await modal().get('form').trigger('submit');
 app.selectedMemberId.value='other';app.selectedMember.value={id:'other',permission:'manager'};await flushPromises();expect(body().find('.record-association-modal').exists()).toBe(false);expect(host.inert).toBe(false);expect(document.body.style.overflow).toBe('');
 finish(old);await flushPromises();expect(wrapper.emitted('updated')).toBeUndefined();expect(app.notifyDataChanged).not.toHaveBeenCalled();
});
it('a foreign save result stays in the dialog as an error and never updates the detail',async()=>{
 await open();await modal().get('.record-picker-option input').setValue(true);mocks.request.mockResolvedValueOnce({...response(),memberId:'other'});await modal().get('form').trigger('submit');await flushPromises();expect(modal().get('[role="alert"]').text()).toContain('保存结果无效');expect(wrapper.emitted('updated')).toBeUndefined();
});
