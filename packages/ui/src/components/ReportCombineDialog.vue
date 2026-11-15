<script setup lang="ts">
import {computed,nextTick,onBeforeUnmount,onMounted,ref,watch} from 'vue';
import {Check,FilePlus2,LoaderCircle,Search,X} from '@lucide/vue';
import type {CursorPage,ReportSummary} from '../types/api';
import type {ReportCombinationPreview,ReportCombinationResult} from '../../../shared/report-combination';
import {ApiRequestError,request} from '../utils/api';
import {createUuid} from '../utils/uuid';
import {useScrollLock} from '../composables/useScrollLock';
import {useConfirm} from '../composables/useConfirm';
const props=defineProps<{report:Pick<ReportSummary,'id'|'memberId'|'title'|'reportIssuedAt'|'hospitalName'>}>();
const emit=defineEmits<{close:[];combined:[result:ReportCombinationResult]}>();
const dialog=ref<HTMLElement>(),query=ref(''),sameDayOnly=ref(false);
const reports=ref<ReportSummary[]>([]),cursor=ref<string|null>(null),hasMore=ref(false);
const loading=ref(false),listError=ref(''),selected=ref('');
const preview=ref<ReportCombinationPreview|null>(null),previewLoading=ref(false),previewError=ref('');
const saving=ref(false),saveError=ref('');
const confirmDialog=useConfirm();
const confirmationOpen=computed(()=>confirmDialog.state.value?.run===combine);
const day=computed(()=>props.report.reportIssuedAt?.slice(0,10)||'');
let listSequence=0,previewSequence=0,requestKey='',searchTimer:ReturnType<typeof setTimeout>|undefined;
const previousFocus=typeof document==='undefined'?null:document.activeElement as HTMLElement|null;
useScrollLock(ref(true));
const busy=(report:ReportSummary)=>['uploading','queued','processing'].includes(report.status);
function close(){if(!saving.value&&!confirmationOpen.value)emit('close');}
function keydown(event:KeyboardEvent) {
  if(event.key==='Escape'){event.preventDefault();close();}
  if(event.key!=='Tab')return;
  const items=Array.from(dialog.value?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),[tabindex="0"]')||[]);
  const first=items[0],last=items.at(-1);
  if(!first){event.preventDefault();dialog.value?.focus();return;}
  if(event.shiftKey&&(document.activeElement===first||document.activeElement===dialog.value)){event.preventDefault();last?.focus();}
  else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
}
async function loadMore(reset=false) {
  const sequence=++listSequence;
  if(reset){reports.value=[];cursor.value=null;hasMore.value=false;}
  loading.value=true;listError.value='';
  const params=new URLSearchParams({memberId:props.report.memberId,limit:'20'});
  if(query.value.trim())params.set('q',query.value.trim());
  if(sameDayOnly.value&&day.value){params.set('dateFrom',day.value);params.set('dateTo',day.value);}
  if(!reset&&cursor.value)params.set('cursor',cursor.value);
  try {
    const data=await request<CursorPage<ReportSummary>>(`reports?${params}`);
    if(sequence!==listSequence)return;
    const existing=new Set(reports.value.map(r=>r.id));
    reports.value.push(...data.items.filter(r=>r.id!==props.report.id&&!existing.has(r.id)));
    cursor.value=data.nextCursor;hasMore.value=data.hasMore;
  }catch(error){if(sequence===listSequence)listError.value=(error as Error).message;}
  finally{if(sequence===listSequence)loading.value=false;}
}
async function choose(reportId:string) {
  const sequence=++previewSequence;
  selected.value=reportId;preview.value=null;previewError.value='';saveError.value='';requestKey='';previewLoading.value=true;
  try {
    const data=await request<ReportCombinationPreview>(`reports/${props.report.id}/combine-preview?sourceReportId=${encodeURIComponent(reportId)}`);
    if(sequence!==previewSequence)return;
    requestKey=createUuid();preview.value=data;
  }catch(error){if(sequence===previewSequence)previewError.value=(error as Error).message;}
  finally{if(sequence===previewSequence)previewLoading.value=false;}
}
function askCombine() {
  if(!preview.value||saving.value||confirmDialog.state.value)return;
  confirmDialog.ask({
    title:'确认合并这两份报告？',
    message:`将「${preview.value.source.title}」并入「${preview.value.target.title}」。\n保留两份原件、已识别内容和人工校对；「${preview.value.source.title}」将移入回收站。\n来源报告尚未永久删除时，可在详情撤销最近一次合并；若又修改了内容，将暂停撤销，避免覆盖修改。`,
    confirmText:'确认合并',
    cancelText:'取消',
    danger:true,
    run:combine
  });
}
async function combine() {
  if(!preview.value||saving.value)return;
  saving.value=true;saveError.value='';
  try {
    const result=await request<ReportCombinationResult>(`reports/${props.report.id}/combine`,{method:'POST',body:JSON.stringify({sourceReportId:preview.value.source.id,fingerprint:preview.value.fingerprint,requestKey})});
    emit('combined',result);
  }catch(error){saveError.value=(error as Error).message;if(error instanceof ApiRequestError&&error.status===409)preview.value=null;}
  finally{saving.value=false;}
}
watch([query,sameDayOnly],()=>{
  ++listSequence;++previewSequence;selected.value='';preview.value=null;previewLoading.value=false;previewError.value='';saveError.value='';clearTimeout(searchTimer);listError.value='';loading.value=true;
  searchTimer=setTimeout(()=>void loadMore(true),200);
});
onMounted(async()=>{await nextTick();dialog.value?.focus();void loadMore(true);});
onBeforeUnmount(()=>{if(confirmationOpen.value)confirmDialog.cancel();++listSequence;++previewSequence;clearTimeout(searchTimer);previousFocus?.focus();});
</script>

<template>
  <Teleport to="body">
    <div class="modal-backdrop report-combine-backdrop" @click.self="close" @keydown.stop="keydown">
      <section ref="dialog" class="report-combine-dialog" role="dialog" aria-modal="true" aria-labelledby="report-combine-title" tabindex="-1" :aria-busy="saving" :inert="confirmationOpen" :aria-hidden="confirmationOpen || undefined">
        <header class="report-combine-header">
          <div class="sheet-grabber" aria-hidden="true"></div>
          <h3 id="report-combine-title"><FilePlus2 :size="18"/>合并已有报告</h3>
          <button class="plain-icon-button" type="button" aria-label="关闭合并报告" :disabled="saving" @click="close"><X :size="20"/></button>
        </header>
        <div class="report-combine-body">
          <div class="report-combine-retained"><span>保留当前报告</span><strong>{{ report.title }}</strong><small>{{ report.reportIssuedAt || '日期待确认' }}<template v-if="report.hospitalName"> · {{ report.hospitalName }}</template></small></div>
          <p class="report-combine-description">选择一份报告并入，保留两份原件和已识别内容。</p>
          <div class="report-combine-search">
            <label><Search :size="16"/><input v-model="query" type="search" placeholder="搜索报告标题、医院" aria-label="搜索待合并报告" maxlength="80" :disabled="saving"/></label>
            <button v-if="day" type="button" class="soft-action-button" :aria-pressed="sameDayOnly" :disabled="saving" @click="sameDayOnly=!sameDayOnly">{{ sameDayOnly ? '同日报告' : '全部日期' }}</button>
          </div>
          <p v-if="listError" class="inline-panel-error" role="alert">{{ listError }} <button class="soft-action-button" type="button" @click="loadMore(!reports.length)">重试</button></p>
          <div class="report-combine-list" role="group" aria-label="选择并入报告">
            <button v-for="item in reports" :key="item.id" class="report-combine-option" type="button" :class="{'is-selected':selected===item.id}" :aria-pressed="selected===item.id" :disabled="saving||busy(item)" @click="choose(item.id)">
              <span class="report-combine-check"><Check v-if="selected===item.id" :size="15"/></span>
              <span><strong>{{ item.title }}</strong><small>{{ item.reportIssuedAt || '日期待确认' }}<template v-if="item.hospitalName"> · {{ item.hospitalName }}</template></small><small>{{ item.pageCount }} 页<template v-if="busy(item)"> · 识别中，暂不能合并</template><template v-else-if="day&&item.reportIssuedAt?.slice(0,10)===day"> · 同日报告</template></small></span>
            </button>
          </div>
          <p v-if="loading" class="report-combine-status" role="status"><LoaderCircle class="spin-icon" :size="16"/>正在读取报告</p>
          <p v-else-if="!reports.length&&!listError" class="report-combine-status">{{ sameDayOnly ? '没有同日报告，可切换全部日期查找。' : '没有可合并的其他报告。' }}</p>
          <button v-if="hasMore&&!loading" type="button" class="soft-action-button report-combine-more" :disabled="saving" @click="loadMore()">加载更多</button>
          <p v-if="previewLoading" class="report-combine-status" role="status"><LoaderCircle class="spin-icon" :size="16"/>正在检查合并内容</p>
          <p v-if="previewError" class="inline-panel-error" role="alert">{{ previewError }} <button class="soft-action-button" type="button" :disabled="saving" @click="choose(selected)">重新预览</button></p>
          <section v-if="preview" class="report-combine-preview" aria-label="合并预览">
            <h4>合并预览</h4>
            <p>将「{{ preview.source.title }}」并入当前报告。</p>
            <p><strong>{{ preview.sourceCounts.pages+preview.targetCounts.pages }}</strong> 页原件 · <strong>{{ preview.sourceCounts.observations+preview.targetCounts.observations }}</strong> 项指标</p>
            <p>标题、医院等基本信息保留当前报告的内容；并入报告的信息另存为备注。已有检查时间与人工校对内容一并保留。</p>
            <p>并入后，另一份报告移入回收站；可在报告详情撤销合并，恢复原来的两份报告。此次不重新识别，合并结果需确认归档。</p>
            <p v-if="preview.repeatedPageCount" class="report-combine-warning">发现 {{ preview.repeatedPageCount }} 页相同原件，本次仍会全部保留，请确认是否需要合并。</p>
          </section>
          <p v-if="saveError" class="inline-panel-error" role="alert">{{ saveError }} <button v-if="!preview" class="soft-action-button" type="button" :disabled="saving" @click="choose(selected)">重新预览</button></p>
        </div>
        <footer class="report-combine-footer">
          <button class="soft-action-button" type="button" :disabled="saving" @click="close">取消</button>
          <button class="primary-button compact-primary" type="button" :disabled="!preview||saving||previewLoading||confirmationOpen" @click="askCombine"><LoaderCircle v-if="saving" class="spin-icon" :size="16"/>{{ saving ? '合并中' : '确认合并' }}</button>
        </footer>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.report-combine-backdrop {z-index:170;}
.report-combine-dialog {display:flex;flex-direction:column;width:min(580px,calc(100vw - 32px));max-height:calc(100dvh - 48px);background:var(--surface);color:var(--ink);border-radius:var(--radius-l);box-shadow:var(--shadow-l);outline:none;overflow:hidden;font-size:14px;}
.report-combine-header {display:flex;align-items:center;gap:8px;padding:14px 16px;border-bottom:1px solid var(--line);flex-shrink:0;position:relative;}
.report-combine-header h3 {display:flex;align-items:center;gap:8px;margin:0;flex:1;font-size:16px;}
.report-combine-header .sheet-grabber {display:none;}
.report-combine-body {min-height:0;overflow:auto;overscroll-behavior:contain;padding:16px;display:flex;flex-direction:column;gap:12px;}
.report-combine-retained {padding:10px 12px;background:var(--fill-2);border-radius:var(--radius-m);display:grid;gap:4px;overflow-wrap:anywhere;}
.report-combine-retained>span,.report-combine-retained small,.report-combine-option small {font-size:12px;color:var(--muted);}
.report-combine-retained strong,.report-combine-option strong {font-size:14px;font-weight:600;}
.report-combine-description {margin:0;line-height:1.6;font-size:13px;color:var(--muted);}
.report-combine-search {display:flex;align-items:center;gap:8px;}
.report-combine-search label {display:flex;align-items:center;gap:6px;flex:1;min-width:0;padding:0 10px;border:1px solid var(--line);border-radius:var(--radius-m);color:var(--muted);}
.report-combine-search label:focus-within {border-color:var(--brand);}
.report-combine-search input {width:100%;min-width:0;height:36px;padding:0;border:0;background:transparent;outline:none;color:var(--ink);font-size:14px;}
.report-combine-search button {white-space:nowrap;font-size:12px;}
.report-combine-search button[aria-pressed=true] {color:var(--brand);background:var(--brand-softer);}
.report-combine-list {display:grid;gap:6px;}
.report-combine-option {width:100%;display:flex;align-items:center;gap:10px;padding:10px 12px;text-align:left;background:var(--surface);border:1px solid var(--line);border-radius:var(--radius-m);color:var(--ink);}
.report-combine-option>span:last-child {display:grid;gap:4px;min-width:0;overflow-wrap:anywhere;}
.report-combine-option:not(:disabled):hover,.report-combine-option.is-selected {border-color:var(--brand);background:var(--brand-softer);}
.report-combine-option:focus-visible {outline:2px solid var(--brand);outline-offset:2px;}
.report-combine-option:disabled {opacity:.55;cursor:default;}
.report-combine-check {display:grid;place-items:center;width:18px;height:18px;flex-shrink:0;border:1px solid var(--line);border-radius:50%;color:var(--brand);}
.is-selected .report-combine-check {border-color:var(--brand);}
.report-combine-status {display:flex;align-items:center;justify-content:center;gap:6px;padding:12px 0;color:var(--muted);font-size:13px;margin:0;}
.report-combine-more {align-self:center;}
.report-combine-preview {border-top:1px solid var(--line);padding-top:12px;display:grid;gap:8px;}
.report-combine-preview h4 {margin:0;font-size:15px;}
.report-combine-preview p {margin:0;font-size:13px;line-height:1.65;color:var(--ink-2);overflow-wrap:anywhere;}
.report-combine-preview .report-combine-warning {color:var(--amber);}
.report-combine-footer {display:flex;justify-content:flex-end;gap:8px;padding:12px 16px;border-top:1px solid var(--line);flex-shrink:0;}
@media(max-width:767px) {
 .report-combine-backdrop {align-items:flex-end;padding:0;}
 .report-combine-dialog {width:100%;max-height:92dvh;border-radius:var(--radius-l) var(--radius-l) 0 0;}
 .report-combine-header {padding:24px 12px 10px;}
 .report-combine-header .sheet-grabber {display:block;position:absolute;top:8px;left:50%;transform:translateX(-50%);width:36px;height:4px;border-radius:4px;background:var(--line);margin:0;}
 .report-combine-body {padding:12px;gap:10px;}
 .report-combine-footer {padding:10px 12px max(10px,env(safe-area-inset-bottom));}
}
</style>
