import { beforeEach,afterEach,expect,it,vi } from 'vitest';
import { flushPromises,mount } from '@vue/test-utils';
import { ref } from 'vue';
import Panel from '../src/components/UploadArchivePanel.vue';
import FormSelect from '../src/components/FormSelect.vue';
const mocks=vi.hoisted(()=>({request:vi.fn()}));const app={selectedMemberId:ref('member'),selectedMember:ref({id:'member',permission:'manager'}),notifyDataChanged:vi.fn()};
vi.mock('../src/utils/api',()=>({request:mocks.request}));vi.mock('../src/composables/useAppContext',()=>({useAppContext:()=>app}));
const report=(id:string,type='laboratory',status='ready')=>({id,title:`合成资料${id}`,reportType:type,status,state:'pending',eventId:null});
const preview=(reports=[report('one'),report('two','imaging')])=>({reports,episodes:[{id:'process',title:'合成健康历程'}]});
let wrapper:ReturnType<typeof mount>;
const stubs={ReportDetailModal:{props:['open','reportId'],template:'<div v-if="open" class="preview">{{reportId}}</div>'},RouterLink:{props:['to'],template:'<a :href="to"><slot/></a>'}};
async function render(reportIds=['one','two'],currentBatch=false){wrapper=mount(Panel,{props:{memberId:'member',reportIds,currentBatch},global:{stubs}});await flushPromises();return wrapper;}
const button=(text:string)=>wrapper.findAll('button').find(item=>item.text().includes(text))!;
beforeEach(()=>{sessionStorage.clear();vi.clearAllMocks();app.selectedMemberId.value='member';app.selectedMember.value={id:'member',permission:'manager'};mocks.request.mockImplementation(async(path:string)=>path==='health-records/organize'?{memberId:'member',reportIds:['one','two'],groups:[]}:path.startsWith('reports/')?{memberId:'member',sourceVersion:3}:preview());});
afterEach(()=>{wrapper?.unmount();vi.useRealTimers();});
it('does not request historical uploads when the current batch has no receipts',async()=>{
 await render([],true);expect(mocks.request).not.toHaveBeenCalled();expect(wrapper.find('.archive-panel').exists()).toBe(false);
 await wrapper.setProps({reportIds:['one']});await flushPromises();expect(mocks.request.mock.calls[0][0]).toBe('uploads/workflow/preview');expect(JSON.parse(mocks.request.mock.calls[0][1].body).reportIds).toEqual(['one']);
});
it('shows current upload results without making classification or grouping another required step',async()=>{
 await render(['one','two'],true);expect(wrapper.get('h3').text()).toBe('本次上传资料');expect(wrapper.findAll('.archive-report')).toHaveLength(2);expect(wrapper.findAll('.archive-group')).toHaveLength(0);expect(wrapper.findAllComponents(FormSelect)).toHaveLength(0);expect(wrapper.findAll('input[type="checkbox"]')).toHaveLength(0);
 expect(mocks.request.mock.calls.map(([path])=>path)).toEqual(['uploads/workflow/preview']);expect(wrapper.find('a[href="/events"]').exists()).toBe(false);
 await button('调整资料').trigger('click');expect(wrapper.findAll('.archive-group')).toHaveLength(2);expect(wrapper.findAll('input[type="checkbox"]')).toHaveLength(2);expect(wrapper.findAllComponents(FormSelect).length).toBeGreaterThan(0);
 expect(wrapper.get('.archive-group .archive-processing').text()).toContain('点击“关联历程”');
 await button('收起调整').trigger('click');expect(wrapper.findAll('.archive-group')).toHaveLength(0);expect(wrapper.findAll('.archive-report')).toHaveLength(2);
});
it('saves an optional current-batch adjustment and returns to its compact results',async()=>{
 await render(['one','two'],true);await button('调整资料').trigger('click');for(const input of wrapper.findAll('input[type="checkbox"]'))await input.setValue(true);await button('选中的资料属于同一次').trigger('click');await wrapper.get('.archive-group input').setValue('合成本次资料');await button('保存调整').trigger('click');await flushPromises();
 expect(JSON.parse(mocks.request.mock.calls.find(([path])=>path==='health-records/organize')![1].body).groups).toEqual([{reportIds:['one','two'],title:'合成本次资料'}]);expect(wrapper.findAll('.archive-group')).toHaveLength(0);expect(wrapper.text()).toContain('调整已保存');expect(wrapper.findAll('.archive-report')).toHaveLength(2);
});
it('pages only through the current receipt ids and refreshes every loaded page without fetching history',async()=>{
 vi.useFakeTimers();const ids=Array.from({length:101},(_,index)=>`current-${index}`);let ready=false;
 mocks.request.mockImplementation(async(path:string,options:any)=>{expect(path).toBe('uploads/workflow/preview');return preview(JSON.parse(options.body).reportIds.map((id:string)=>report(id,'laboratory',ready?'ready':'queued')));});
 await render(ids,true);expect(wrapper.findAll('.archive-report')).toHaveLength(100);await button('显示更多本次资料').trigger('click');await flushPromises();expect(wrapper.findAll('.archive-report')).toHaveLength(101);expect(wrapper.text()).not.toContain('显示更多本次资料');ready=true;
 await vi.advanceTimersByTimeAsync(3000);await flushPromises();expect(wrapper.findAll('.archive-report')).toHaveLength(101);expect(wrapper.findAll('.archive-group')).toHaveLength(0);expect(wrapper.text()).not.toContain('待识别');expect(mocks.request.mock.calls.flatMap(([,options])=>JSON.parse(options.body).reportIds).every((id:string)=>ids.includes(id))).toBe(true);
 wrapper.unmount();const count=mocks.request.mock.calls.length;await vi.advanceTimersByTimeAsync(6000);expect(mocks.request).toHaveBeenCalledTimes(count);
});
it('retries a failed current-batch preview without switching to the historical list',async()=>{
 mocks.request.mockRejectedValueOnce(Error('合成预览失败'));await render(['one'],true);expect(wrapper.get('[role="alert"]').text()).toContain('合成预览失败');mocks.request.mockResolvedValueOnce(preview([report('one')]));await button('重试').trigger('click');await flushPromises();expect(wrapper.find('[role="alert"]').exists()).toBe(false);expect(wrapper.findAll('.archive-report')).toHaveLength(1);expect(mocks.request.mock.calls.every(([path,options])=>path==='uploads/workflow/preview'&&JSON.stringify(JSON.parse(options.body).reportIds)==='["one"]')).toBe(true);
});
it('keeps large current batches within the organization limit and does not resubmit adjusted reports',async()=>{
 const ids=Array.from({length:101},(_,index)=>`current-${index}`);
 mocks.request.mockImplementation(async(path:string,options:any)=>{
  const body=JSON.parse(options.body);
  return path==='health-records/organize'?{reportIds:body.groups.flatMap((group:any)=>group.reportIds),groups:[]}:preview(body.reportIds.map((id:string)=>report(id)));
 });
 await render(ids,true);await button('显示更多本次资料').trigger('click');await flushPromises();await button('调整资料').trigger('click');expect(wrapper.findAll('input[type="checkbox"]')).toHaveLength(100);await button('保存调整').trigger('click');await flushPromises();
 expect(wrapper.findAll('.archive-group')).toHaveLength(0);await button('调整资料').trigger('click');expect(wrapper.findAll('input[type="checkbox"]')).toHaveLength(1);await button('保存调整').trigger('click');await flushPromises();
 const saved=mocks.request.mock.calls.filter(([path])=>path==='health-records/organize').map(([,options])=>JSON.parse(options.body).groups.flatMap((group:any)=>group.reportIds));expect(saved.map(batch=>batch.length)).toEqual([100,1]);expect(new Set(saved.flat()).size).toBe(101);expect(wrapper.findAll('.archive-group')).toHaveLength(0);expect(wrapper.findAll('input[type="checkbox"]')).toHaveLength(0);
});
it('loads the workflow reports returned when opening upload without a new upload receipt',async()=>{
 mocks.request.mockResolvedValueOnce({...preview(),nextCursor:null});await render([]);
 expect(wrapper.find('[role="alert"]').exists()).toBe(false);expect(wrapper.findAll('.archive-report')).toHaveLength(2);expect(wrapper.findAll('.archive-group')).toHaveLength(2);
 expect(mocks.request.mock.calls.map(([path])=>path)).toEqual(['uploads/workflow?memberId=member']);
});
it('keeps an empty workflow hidden without an error',async()=>{
 mocks.request.mockResolvedValueOnce({...preview([]),nextCursor:null});await render([]);
 expect(wrapper.find('.archive-panel').exists()).toBe(false);expect(mocks.request).toHaveBeenCalledOnce();
});
it('appends workflow pages without duplicate reports or losing the existing grouping draft',async()=>{
 mocks.request.mockResolvedValueOnce({...preview(),nextCursor:'two'});await render([]);
 for(const input of wrapper.findAll('input[type="checkbox"]'))await input.setValue(true);await button('选中的资料属于同一次').trigger('click');await wrapper.get('.archive-group input').setValue('合成分组标题');
 mocks.request.mockResolvedValueOnce({...preview([report('two','imaging'),report('three')]),nextCursor:null});await button('继续整理更多资料').trigger('click');await flushPromises();
 expect(mocks.request.mock.calls.at(-1)![0]).toBe('uploads/workflow?memberId=member&cursor=two');expect(wrapper.findAll('.archive-report')).toHaveLength(3);expect(wrapper.findAll('.archive-group')).toHaveLength(2);expect((wrapper.get('.archive-group input').element as HTMLInputElement).value).toBe('合成分组标题');expect(wrapper.text()).not.toContain('继续整理更多资料');expect(wrapper.find('[role="alert"]').exists()).toBe(false);
});
it('retries a failed initial workflow request using the actual reports response',async()=>{
 mocks.request.mockRejectedValueOnce(Error('合成读取失败'));await render([]);expect(wrapper.get('[role="alert"]').text()).toContain('合成读取失败');
 mocks.request.mockResolvedValueOnce({...preview([report('one')]),nextCursor:null});await button('重试').trigger('click');await flushPromises();expect(wrapper.find('[role="alert"]').exists()).toBe(false);expect(wrapper.findAll('.archive-report')).toHaveLength(1);expect(mocks.request.mock.calls.map(([path])=>path)).toEqual(['uploads/workflow?memberId=member','uploads/workflow?memberId=member']);
});
it('categorizes uploaded sources without requiring any event type or event creation',async()=>{await render();expect(wrapper.text()).toContain('报告');expect(wrapper.text()).toContain('影像');expect(wrapper.find('[aria-label="事件类型"]').exists()).toBe(false);expect(wrapper.findAll('.archive-group')).toHaveLength(2);expect(mocks.request.mock.calls.some(([,options])=>options?.method==='PUT')).toBe(false);});
it('merges only explicitly selected sources and saves the public grouping contract',async()=>{await render();for(const input of wrapper.findAll('input[type="checkbox"]'))await input.setValue(true);await button('选中的资料属于同一次').trigger('click');expect(wrapper.findAll('.archive-group')).toHaveLength(1);await wrapper.get('.archive-group input').setValue('合成年度体检');await button('确认整理').trigger('click');await flushPromises();const payload=JSON.parse(mocks.request.mock.calls.find(([path])=>path==='health-records/organize')![1].body);expect(payload.groups).toEqual([{reportIds:['one','two'],title:'合成年度体检'}]);expect(payload.groups[0].eventType).toBeUndefined();expect(payload.requestKey).toMatch(/^[\w-]+$/);expect(wrapper.text()).toContain('整理已保存');expect(wrapper.emitted('saved')).toHaveLength(1);});
it('keeps image and other source types separate when saving individually',async()=>{await render();await button('分别保存').trigger('click');await flushPromises();const payload=JSON.parse(mocks.request.mock.calls.find(([path])=>path==='health-records/organize')![1].body);expect(payload.groups.map((group:any)=>group.reportIds)).toEqual([['one'],['two']]);});
it('classification edits use the actual current source version and retain the original document',async()=>{await render();const control=wrapper.findAllComponents(FormSelect).find(item=>String(item.props('ariaLabel')).startsWith('资料类型'))!;control.vm.$emit('update:modelValue','prescription');await flushPromises();const call=mocks.request.mock.calls.find(([path,options])=>path==='reports/one'&&options?.method==='PUT')!;expect(JSON.parse(call[1].body)).toEqual({reportType:'prescription',expectedSourceVersion:3});expect(wrapper.text()).toContain('用药');});
it('only changes classification after the save succeeds and exposes failures',async()=>{await render();mocks.request.mockImplementation(async(path:string,options:any)=>{if(options?.method==='PUT')throw Error('类型保存失败');return {memberId:'member',sourceVersion:2};});wrapper.findAllComponents(FormSelect)[0].vm.$emit('update:modelValue','imaging');await flushPromises();expect(wrapper.get('[role="alert"]').text()).toContain('类型保存失败');expect(wrapper.findAll('.archive-report')[0].text()).toContain('报告');});
it('an unchanged failed organization retries with the same key and keeps grouping drafts',async()=>{await render();mocks.request.mockRejectedValueOnce(Error('网络中断'));await button('确认整理').trigger('click');await flushPromises();expect(wrapper.text()).toContain('网络中断');const first=mocks.request.mock.calls.filter(([path])=>path==='health-records/organize').at(-1)![1].body;await button('确认整理').trigger('click');await flushPromises();const last=mocks.request.mock.calls.filter(([path])=>path==='health-records/organize').at(-1)![1].body;expect(JSON.parse(first).requestKey).toBe(JSON.parse(last).requestKey);});
it('opens the selected source through the original preview',async()=>{await render();await button('合成资料two').trigger('click');expect(wrapper.get('.preview').text()).toBe('two');});
it('member changes discard stale polling and preview data',async()=>{let resolve!:(value:any)=>void;mocks.request.mockReturnValueOnce(new Promise(done=>resolve=done));wrapper=mount(Panel,{props:{memberId:'member',reportIds:['one']},global:{stubs}});app.selectedMemberId.value='second';app.selectedMember.value={id:'second',permission:'manager'};mocks.request.mockResolvedValueOnce(preview([report('new')]));await wrapper.setProps({memberId:'second',reportIds:['new']});await flushPromises();resolve(preview([report('old')]));await flushPromises();expect(wrapper.text()).toContain('合成资料new');expect(wrapper.text()).not.toContain('合成资料old');});
it('viewers can preview originals but never edit classification or organize',async()=>{app.selectedMember.value.permission='viewer';await render();expect(wrapper.findAll('input[type="checkbox"]')).toHaveLength(0);expect(wrapper.findAllComponents(FormSelect)).toHaveLength(0);expect(wrapper.text()).not.toContain('确认整理');});
it('processing sources poll without replacing user grouping choices and stop after unmount',async()=>{vi.useFakeTimers();mocks.request.mockResolvedValue(preview([report('one','laboratory','queued'),report('two','imaging','queued')]));await render();for(const input of wrapper.findAll('input[type="checkbox"]'))await input.setValue(true);await button('选中的资料属于同一次').trigger('click');await vi.advanceTimersByTimeAsync(3000);await flushPromises();expect(wrapper.findAll('.archive-group')).toHaveLength(1);wrapper.unmount();const count=mocks.request.mock.calls.length;await vi.advanceTimersByTimeAsync(6000);expect(mocks.request).toHaveBeenCalledTimes(count);});

it('restores grouping and the same retry key after returning, but never revives already archived sources',async()=>{
 await render();for(const input of wrapper.findAll('input[type="checkbox"]'))await input.setValue(true);await button('选中的资料属于同一次').trigger('click');await wrapper.get('.archive-group input').setValue('合成分组草稿');
 mocks.request.mockRejectedValueOnce(Error('响应中断'));await button('确认整理').trigger('click');await flushPromises();const original=JSON.parse(mocks.request.mock.calls.find(([path])=>path==='health-records/organize')![1].body);
 wrapper.unmount();await render();expect(wrapper.findAll('.archive-group')).toHaveLength(1);expect((wrapper.get('.archive-group input').element as HTMLInputElement).value).toBe('合成分组草稿');
 await button('确认整理').trigger('click');await flushPromises();const retry=JSON.parse(mocks.request.mock.calls.filter(([path])=>path==='health-records/organize').at(-1)![1].body);expect(retry.requestKey).toBe(original.requestKey);expect(sessionStorage.getItem('health-document-groups:member')).toBeNull();
 wrapper.unmount();sessionStorage.setItem('health-document-groups:member',JSON.stringify({groups:[{id:'one',reportIds:['one','two'],title:'旧草稿'}]}));mocks.request.mockResolvedValueOnce(preview([{...report('one'),state:'archived'},report('two')]));await render();expect(wrapper.findAll('input[type="checkbox"]')).toHaveLength(1);await button('确认整理').trigger('click');await flushPromises();expect(JSON.parse(mocks.request.mock.calls.filter(([path])=>path==='health-records/organize').at(-1)![1].body).groups[0].reportIds).toEqual(['two']);
});

it('offers type correction immediately for a completed other document in the current batch',async()=>{
 mocks.request.mockResolvedValue(preview([report('other','other','ready')]));
 await render(['other'],true);expect(wrapper.text()).not.toContain('保存调整');
 expect(wrapper.getComponent(FormSelect).props('modelValue')).toBe('other');
});
