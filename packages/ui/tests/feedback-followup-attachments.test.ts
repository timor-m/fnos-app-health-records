import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {DOMWrapper,flushPromises,mount} from '@vue/test-utils';
import {createMemoryHistory,createRouter} from 'vue-router';
import Feedback from '../src/pages/settings/FeedbackSettingsPage.vue';
import FeedbackImageEditor from '../src/components/FeedbackImageEditor.vue';
const mocks=vi.hoisted(()=>({request:vi.fn()}));
vi.mock('../src/utils/api',()=>({apiUrl:(path:string)=>'/api/'+path,request:mocks.request}));
vi.mock('../src/composables/useAppContext',()=>({useAppContext:()=>({refreshReminderCount:vi.fn()})}));
const ticket={number:'B0001',title:'合成反馈',category:'problem',status:'received',version:1,description:'合成说明',createdAt:'2026-01-01',updatedAt:'2026-01-01',events:[],attachments:[]};
let wrapper:ReturnType<typeof mount>,router:ReturnType<typeof createRouter>;
const dom=()=>new DOMWrapper(document.body);
const send=()=>dom().findAll('button').find(button=>button.text()==='发送补充')!;
const posted=()=>mocks.request.mock.calls.filter(([path])=>path==='feedback/tickets/B0001/messages');
beforeEach(()=>{
 vi.clearAllMocks();let id=0;
 vi.spyOn(URL,'createObjectURL').mockImplementation(()=>`blob:synthetic-${++id}`);
 vi.spyOn(URL,'revokeObjectURL').mockImplementation(()=>{});
 mocks.request.mockImplementation(async(path:string)=>{
  if(path==='feedback/identity')return{clientId:'a'.repeat(43)};
  if(path.startsWith('feedback/tickets?'))return{items:[ticket],total:1};
  if(path==='feedback/upload')return{id:++id};
  return ticket;
 });
});
afterEach(()=>{wrapper?.unmount();vi.restoreAllMocks();});
async function open(){
 router=createRouter({history:createMemoryHistory(),routes:[{path:'/me/feedback',component:Feedback}]});
 await router.push('/me/feedback?feedback=B0001');await router.isReady();
 wrapper=mount(Feedback,{attachTo:document.body,global:{plugins:[router],stubs:{SubPageHeader:true,FeedbackImageEditor:true,Teleport:false}}});await flushPromises();
}
async function add(files:File[]){
 const input=dom().get('input[type="file"]');Object.defineProperty(input.element,'files',{configurable:true,value:files});await input.trigger('change');
}
it('sends edited screenshots and PDF without text, then renders private event attachments and clears the draft',async()=>{
 await open();expect(send().attributes('disabled')).toBeDefined();
 await add([new File(['original'],'screenshot.png',{type:'image/png'}),new File(['pdf'],'report.pdf',{type:'application/pdf'})]);
 await dom().get('.attachment-edit').trigger('click');
 wrapper.getComponent(FeedbackImageEditor).vm.$emit('save',new File(['masked'],'masked.png',{type:'image/png'}));await flushPromises();
 expect(send().attributes('disabled')).toBeUndefined();
 mocks.request.mockImplementation(async(path:string,options:any)=>{
  if(path==='feedback/upload')return{id:options.body.get('file').type==='application/pdf'?2:1};
  if(path==='feedback/tickets/B0001/messages')return{};
  if(path.startsWith('feedback/tickets/B0001?'))return{...ticket,events:[{id:1,actorType:'user',content:'',createdAt:'2026-01-02',attachments:[{id:1,mimeType:'image/png'},{id:2,mimeType:'application/pdf'}]}]};
  return{items:[ticket],total:1};
 });
 await send().trigger('click');await flushPromises();
 expect(JSON.parse(posted()[0][1].body)).toEqual({content:'',attachmentIds:[1,2]});
 const files=mocks.request.mock.calls.filter(([path])=>path==='feedback/upload').map(([,options])=>options.body.get('file') as File);
 expect(await files[0].text()).toBe('masked');expect(files[1].type).toBe('application/pdf');
 expect(dom().findAll('.attachment-tile')).toHaveLength(0);
 expect(dom().get('.feedback-timeline .feedback-attachments img').attributes('src')).toBe('/api/feedback/attachments/1');
 expect(dom().get('.feedback-timeline .feedback-attachments a[aria-label="查看附件 2"]').attributes('href')).toBe('/api/feedback/attachments/2');
});
it('retains attachments on failure and reuses upload IDs and message key on an unchanged retry',async()=>{
 await open();await add([new File(['synthetic'],'a.png',{type:'image/png'})]);let attempts=0;
 const implementation=mocks.request.getMockImplementation()!;
 mocks.request.mockImplementation(async(path:string,...rest:any[])=>{if(path==='feedback/tickets/B0001/messages'&&++attempts===1)throw new Error('synthetic timeout');return implementation(path,...rest);});
 await send().trigger('click');await flushPromises();expect(dom().findAll('.attachment-tile')).toHaveLength(1);
 await send().trigger('click');await flushPromises();
 expect(mocks.request.mock.calls.filter(([path])=>path==='feedback/upload')).toHaveLength(1);
 expect(posted()).toHaveLength(2);expect(posted()[0][1].headers['idempotency-key']).toBe(posted()[1][1].headers['idempotency-key']);
});
it('locks the composer during upload and clears attachment drafts when switching tickets',async()=>{
 await open();await add([new File(['synthetic'],'a.png',{type:'image/png'})]);let finish!:(value:unknown)=>void;
 const implementation=mocks.request.getMockImplementation()!;
 mocks.request.mockImplementation((path:string,...rest:any[])=>path==='feedback/upload'?new Promise(resolve=>{finish=resolve;}):implementation(path,...rest));
 await send().trigger('click');expect(dom().get('.attachment-add').attributes('disabled')).toBeDefined();
 expect(dom().findAll('button').some(b=>b.text()==='发送中…'&&b.attributes('disabled')!==undefined)).toBe(true);
 finish({id:9});await flushPromises();
 await add([new File(['other'],'b.png',{type:'image/png'})]);
 mocks.request.mockImplementation(async(path:string)=>path.startsWith('feedback/tickets/B0002')?{...ticket,number:'B0002'}:{items:[ticket],total:1});
 await router.push('/me/feedback?feedback=B0002');await flushPromises();
 expect(dom().findAll('.attachment-tile')).toHaveLength(0);expect(send().attributes('disabled')).toBeDefined();
});
it('reuploads expired attachments while keeping the user draft',async()=>{
 await open();await add([new File(['synthetic'],'a.png',{type:'image/png'})]);let attempts=0;
 const implementation=mocks.request.getMockImplementation()!;
 mocks.request.mockImplementation(async(path:string,...rest:any[])=>{if(path==='feedback/tickets/B0001/messages'&&++attempts===1)throw Object.assign(new Error('expired'),{status:410});return implementation(path,...rest);});
 await send().trigger('click');await flushPromises();expect(dom().findAll('.attachment-tile')).toHaveLength(1);
 await send().trigger('click');await flushPromises();
 expect(mocks.request.mock.calls.filter(([path])=>path==='feedback/upload')).toHaveLength(2);
 expect(posted()[0][1].headers['idempotency-key']).not.toBe(posted()[1][1].headers['idempotency-key']);
});
