import {DOMWrapper} from '@vue/test-utils';
import { mount,flushPromises } from '@vue/test-utils';
import { describe,it,expect,vi,beforeEach } from 'vitest';
import FeedbackImageEditor from '../src/components/FeedbackImageEditor.vue';
import Page from '../src/pages/settings/FeedbackSettingsPage.vue';
import { createFeedbackOperation, feedbackImageUrl } from '../src/utils/feedback-service';
import { feedbackEnvironmentPayload } from '../src/utils/feedback-environment';
const request=vi.hoisted(()=>vi.fn());
vi.mock('../src/utils/api',()=>({apiUrl:(path:string)=>'/app/api/'+path,request:(path:string,...args:unknown[])=>path==='feedback/identity'?Promise.resolve({clientId:'a'.repeat(43)}):request(path,...args)}));
const ticket={number:'B0001',title:'测试反馈',category:'problem',status:'released_pending_verification',version:2,fixedVersion:'0.2.12',description:'合成描述',createdAt:'2026-01-01T00:00:00Z',updatedAt:'2026-01-01T00:00:00Z',events:[{id:1,actorType:'admin',content:'已更新',toStatus:'released_pending_verification',fixedVersion:'0.2.12',createdAt:'2026-01-01T00:00:00Z',attachments:[]}],eventTotal:1};
function render(){return withTeleportDom(mount(Page,{attachTo:document.body,global:{stubs:{SubPageHeader:true,Teleport:false,FeedbackImageEditor:true}}}));}
beforeEach(()=>{request.mockReset();request.mockImplementation(async(path:string)=>path==='feedback-diagnostics'?{}:path.includes('?page=')?{items:[],total:0}:ticket);});
describe('live feedback workflows',()=>{
 it('renders primary and follow-up PDFs as private file links, preserving image previews',async()=>{
  const pdf={id:8,url:'https://untrusted.example.test/report.pdf',mimeType:'application/pdf'};
  const detail={...ticket,attachments:[pdf,{id:9,url:'ignored',mimeType:'image/png'}],events:[{...ticket.events[0],attachments:[pdf]}]};
  request.mockImplementation(async(path:string)=>path.includes('?page=')?{items:[ticket],total:1}:detail);
  const page=render();try {
   await flushPromises();await page.get('.feedback-row').trigger('click');await flushPromises();
   expect(page.findAll('.pdf-card')).toHaveLength(2);
   expect(page.findAll('img')).toHaveLength(1);
   for(const link of page.findAll('.pdf-card').map(card=>card.element.closest('a'))) expect(link?.getAttribute('href')).toBe('/app/api/feedback/attachments/8');
   expect(page.html()).not.toContain('untrusted.example.test');
  }finally{page.unmount();}
 });
 it('always uses the local authenticated attachment route and ignores stored public URLs',()=>{
  for(const url of ['https://s.lby.link/health/feedback/synthetic.png','/health/feedback/synthetic.png','https://untrusted.example.test/image.png','']) expect(feedbackImageUrl({id:42,url})).toBe('/app/api/feedback/attachments/42');
  for(const id of [0,-1,NaN,1.5,Number.MAX_SAFE_INTEGER+1]) expect(feedbackImageUrl({id,url:'https://s.lby.link/synthetic.png'})).toBe('');
 });
 it('shows original and follow-up screenshots from relative URLs and keeps the section after refresh',async()=>{
  const detail={...ticket,attachments:[{id:1,url:'/health/feedback/original.png'},{id:2,url:'https://s.lby.link/health/feedback/complete.png'}],events:[{...ticket.events[0],attachments:[{id:3,url:'/health/feedback/reply.png'}]}]};
  request.mockImplementation(async(path:string)=>path.includes('?page=')?{items:[ticket],total:1}:detail);
  const page=render();
  try {
   await flushPromises();await page.get('.feedback-row').trigger('click');await flushPromises();
   const assertScreenshots=()=>{
    const section=page.findAll('.detail-section').find(section=>section.find('h4').text().startsWith('问题附件'));
    expect(section?.get('h4').text()).toBe('问题附件 · 2 个');
    expect(section?.findAll('img').map(image=>image.attributes('src'))).toEqual(['/app/api/feedback/attachments/1','/app/api/feedback/attachments/2']);
    expect(section?.findAll('a').map(link=>link.attributes('href'))).toEqual(['/app/api/feedback/attachments/1','/app/api/feedback/attachments/2']);
    expect(page.get('.feedback-timeline img').attributes('src')).toBe('/app/api/feedback/attachments/3');
   };
   assertScreenshots();await page.get('button[aria-label="刷新进度"]').trigger('click');await flushPromises();assertScreenshots();
  }finally{page.unmount();}
 });
 it('loads feedback lazily on page mount and submits only approved fields without exposing installation identity',async()=>{
  const page=render();await flushPromises();expect(request).toHaveBeenCalledWith('feedback/tickets?page=1&pageSize=20',expect.objectContaining({headers:{}}));
  await page.get('.feedback-primary').trigger('click');await flushPromises();
  await page.get('form input').setValue('测试反馈');await page.get('form textarea').setValue('合成描述');
  await page.findAll('.type-options button')[1].trigger('click');
  await page.get('form').trigger('submit');await flushPromises();
  const [,options]=request.mock.calls.find(c=>c[0]==='feedback/tickets')!;
  expect(JSON.parse(options.body).category).toBe('suggestion');expect(JSON.parse(options.body).reproductionSteps).toBeUndefined();expect(options.headers['idempotency-key']).toBeTruthy();expect(options.headers['x-client-id']).toBeUndefined();expect(page.get('.number-box').text()).toContain('B0001');page.unmount();
 });
 it('shows real progress and version, sends user confirmation with optimistic version',async()=>{
  request.mockImplementation(async(path:string)=>path.includes('?page=')?{items:[ticket],total:1}:ticket);
  const page=render();await flushPromises();await page.get('.feedback-row').trigger('click');await flushPromises();expect(page.text()).toContain('0.2.12');
  await page.findAll('button').find(b=>b.text()==='确认已解决')!.trigger('click');await flushPromises();
  const call=request.mock.calls.find(c=>c[0]==='feedback/tickets/B0001/resolution')!;expect(JSON.parse(call[1].body)).toEqual({action:'confirm',expectedVersion:2});page.unmount();
 });

 it('uploads only the edited image and reuses upload and submission keys after a timeout',async()=>{
  const objectUrl=vi.spyOn(URL,'createObjectURL').mockReturnValue('blob:synthetic');const revoke=vi.spyOn(URL,'revokeObjectURL').mockImplementation(()=>{});
  let submissions=0;
  request.mockImplementation(async(path:string)=>{if(path.includes('?page='))return {items:[],total:0};if(path==='feedback-diagnostics')return {};if(path==='feedback/upload')return {id:7};if(path==='feedback/tickets'){if(++submissions===1)throw new Error('timeout');return ticket;}return ticket;});
  const page=render();try {
   await page.get('.feedback-primary').trigger('click');await flushPromises();
   const input=page.get('input[type="file"]');Object.defineProperty(input.element,'files',{value:[new File(['original'],'private.png',{type:'image/png'})]});await input.trigger('change');await page.get('.attachment-edit').trigger('click');
   page.getComponent(FeedbackImageEditor).vm.$emit('save',new File(['masked'],'edited.png',{type:'image/png'}));await page.vm.$nextTick();
   await page.get('form input').setValue('测试截图');await page.get('form textarea').setValue('合成说明');await page.get('form').trigger('submit');await flushPromises();expect(page.find('.success-card').exists()).toBe(false);
   await page.get('form').trigger('submit');await flushPromises();
   const uploads=request.mock.calls.filter(c=>c[0]==='feedback/upload');expect(uploads).toHaveLength(1);expect(await (uploads[0][1].body.get('file') as File).text()).toBe('masked');
   const posts=request.mock.calls.filter(c=>c[0]==='feedback/tickets');expect(posts[0][1].headers['idempotency-key']).toBe(posts[1][1].headers['idempotency-key']);expect(JSON.parse(posts[1][1].body).attachmentIds).toEqual([7]);expect(page.find('.success-card').exists()).toBe(true);
  }finally{page.unmount();objectUrl.mockRestore();revoke.mockRestore();}
 });
 it('retries an unchanged submission with the same operation key',()=>{const operation=createFeedbackOperation();const key=operation.key('submit','body');expect(operation.key('submit','body')).toBe(key);expect(operation.key('submit','changed')).not.toBe(key);});
 it('diagnostics payload has no build ID, raw UA or credentials',()=>{const body=feedbackEnvironmentPayload({appVersion:'1',ocr:{available:false},ai:{enabled:false,visionEnabled:false}},{userAgent:'SYNTHETIC_UA',width:360,height:740});expect(body.app).toEqual({version:'1'});expect(body.ocr.available).toBe(false);expect(JSON.stringify(body)).not.toContain('SYNTHETIC_UA');expect(JSON.stringify(body)).not.toContain('buildId');});
});

// The generic Teleport stub remounts child pickers on updates; exercise real Teleports.
function withTeleportDom<T extends {get:any;find:any;findAll:any;text:any}>(page:T):T {
  const dom=new DOMWrapper(document.body);
  return Object.assign(page,{get:dom.get.bind(dom),find:dom.find.bind(dom),findAll:dom.findAll.bind(dom),text:dom.text.bind(dom)});
}
