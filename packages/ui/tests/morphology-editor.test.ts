import {mount,flushPromises,type VueWrapper} from '@vue/test-utils';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import Editor from '../src/components/MorphologyFindingEditor.vue';
import FormSelect from '../src/components/FormSelect.vue';
const request=vi.hoisted(()=>vi.fn());
vi.mock('../src/utils/api',()=>({request:(...args:unknown[])=>request(...args)}));
const finding={id:'f',reportId:'r',organ:'肝脏',region:null,laterality:'right' as const,findingType:'囊肿',findingName:'合成记录',presence:'present' as const,size:{length:8,width:null,height:null,unit:'mm'},morphology:null,classification:null,rawText:'合成原文',evidence:[{pageNumber:2,quote:'合成原文'}]};
const report={id:'r',memberId:'member',title:'合成报告',pages:[{id:'p1',pageNumber:1},{id:'p2',pageNumber:2}],morphologyFindings:[finding]};
let w:VueWrapper;
const render=(props:Record<string,unknown>={})=>w=mount(Editor,{props:{open:true,finding:null,memberId:'member',...props},global:{stubs:{Teleport:true}}});
beforeEach(()=>{request.mockReset();request.mockImplementation(async(path:string)=>path.startsWith('reports?')?{items:[{...report,reportIssuedAt:'2026-01-01'}],nextCursor:null}:report);});
afterEach(()=>{w?.unmount();});
async function choose(label:string,value:string){const c=w.findAllComponents(FormSelect).find(c=>c.get('button').attributes('aria-label')===label)!;c.vm.$emit('update:modelValue',value);c.vm.$emit('change',value);await flushPromises();}

it('creates from a member-scoped report and sends the chosen source page and original text',async()=>{
 render();await flushPromises();expect(request).toHaveBeenCalledWith(expect.stringContaining('memberId=member'));
 await choose('来源报告','r');
 await w.get('input[required]').setValue('肝脏');const required=w.findAll('input[required]');await required[1].setValue('囊肿');await required[2].setValue('合成补充');
 await choose('来源页','2');await w.get('[aria-label="形态原文"]').setValue('合成补充原文');
 request.mockResolvedValueOnce({});await w.get('form').trigger('submit');await flushPromises();
 expect(request).toHaveBeenLastCalledWith('reports/r/morphology-findings',expect.objectContaining({method:'POST'}));
 const body=JSON.parse(request.mock.calls.at(-1)![1].body);expect(body).toMatchObject({findingName:'合成补充',sourcePageNumber:'2',rawText:'合成补充原文'});
 expect(w.emitted('saved')).toHaveLength(1);
});
it('edits only changed fields and retains the draft after save failures',async()=>{
 render({finding,reportId:'r'});await flushPromises();
 expect(w.find('[aria-label="来源报告"]').exists()).toBe(false);
 const numeric=w.findAll('input[type="number"]');await numeric[1].setValue('9');
 request.mockRejectedValueOnce(new Error('合成失败'));await w.get('form').trigger('submit');await flushPromises();
 expect(w.text()).toContain('合成失败');expect(w.emitted('saved')).toBeUndefined();
 expect(JSON.parse(request.mock.calls.at(-1)![1].body)).toEqual({sizeLength:9});
 await choose('来源页','1');await w.get('[aria-label="形态原文"]').setValue('更正原文');await w.get('form').trigger('submit');await flushPromises();
 expect(JSON.parse(request.mock.calls.at(-1)![1].body)).toMatchObject({sourcePageNumber:'1',rawText:'更正原文'});
});
it('rejects stale source responses after switching members and prevents duplicate saves',async()=>{
 let resolve!:(v:unknown)=>void;request.mockImplementationOnce(async()=>({items:[report],nextCursor:null})).mockImplementationOnce(()=>new Promise(r=>{resolve=r;}));
 render();await flushPromises();await choose('来源报告','r');await w.setProps({memberId:'another'});resolve(report);await flushPromises();
 expect(w.text()).not.toContain('来源：合成报告');expect(w.find('button[type="submit"]').attributes('disabled')).toBeDefined();
 await w.setProps({memberId:'member',reportId:'r',finding});await flushPromises();
 await w.findAll('input[type="number"]')[1].setValue('9');
 let saved!:(v:unknown)=>void;request.mockReturnValueOnce(new Promise(r=>{saved=r;}));
 await w.get('form').trigger('submit');await w.get('form').trigger('submit');
 expect(request.mock.calls.filter(c=>c[1]?.method==='PUT')).toHaveLength(1);expect(w.findAll('button').find(b=>b.text()==='取消')!.attributes('disabled')).toBeDefined();expect(w.emitted('close')).toBeUndefined();saved({});await flushPromises();
});

it('clears the old report cursor when a new search is entered and retries list failures independently of the chosen source',async()=>{
 request.mockResolvedValueOnce({items:[report],nextCursor:'old-cursor'});render();await flushPromises();await choose('来源报告','r');
 expect(w.text()).toContain('加载更多报告');await w.get('[aria-label="搜索来源报告"]').setValue('新检索');
 expect(w.text()).not.toContain('加载更多报告');
 request.mockRejectedValueOnce(new Error('列表失败'));await w.findAll('button').find(b=>b.text()==='搜索')!.trigger('click');await flushPromises();
 expect(w.text()).toContain('列表失败');request.mockResolvedValueOnce({items:[report],nextCursor:null});
 await w.findAll('button').find(b=>b.text()==='重试')!.trigger('click');await flushPromises();expect(request.mock.calls.at(-1)![0]).toContain('reports?');expect(w.text()).not.toContain('列表失败');
});

it('does not claim the first page as the source of an existing finding without evidence',async()=>{
 request.mockResolvedValueOnce({...report,morphologyFindings:[{...finding,evidence:[]}]});
 render({finding,reportId:'r'});await flushPromises();
 expect(w.findAllComponents(FormSelect).find(c=>c.get('button').attributes('aria-label')==='来源页')!.props('modelValue')).toBe('');
 await w.findAll('input[type="number"]')[1].setValue('9');await w.get('form').trigger('submit');await flushPromises();
 expect(JSON.parse(request.mock.calls.at(-1)![1].body)).toEqual({sizeLength:9});
});

it('does not attach an old pagination cursor to text typed during loading',async()=>{
 let resolve!:(v:unknown)=>void;request.mockReturnValueOnce(new Promise(r=>{resolve=r;}));render();
 await w.get('[aria-label="搜索来源报告"]').setValue('新检索');resolve({items:[report],nextCursor:'old-cursor'});await flushPromises();
 expect(w.text()).not.toContain('加载更多报告');
});
