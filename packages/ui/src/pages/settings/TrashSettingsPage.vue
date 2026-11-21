<script setup lang="ts">
import { computed, onActivated, onDeactivated, onBeforeUnmount, ref, watch } from "vue";
import { Clock3, LoaderCircle, RotateCcw, Trash2 } from "@lucide/vue";
import SubPageHeader from "../../components/SubPageHeader.vue";
import EmptyState from "../../components/EmptyState.vue";
import { ApiRequestError, request } from "../../utils/api";
import { formatDatabaseTimeWithYear } from "../../utils/time";
import type { TrashCleanupSummary } from "../../types/api";
import { healthTrashLabels, type HealthTrashEntry, type HealthTrashPage } from "../../../../shared/health-record-trash";
import { formatMedicationDate } from "../../utils/medication-date";
import { useAppContext } from "../../composables/useAppContext";
import { useConfirm } from "../../composables/useConfirm";
import { useRefreshOnActivate } from "../../composables/useRefreshOnActivate";
import { useToast } from "../../composables/useToast";

const PAGE_SIZE = 30;
const app = useAppContext();
const toast = useToast();
const confirmDialog = useConfirm();
const loading = ref(false);
const loadingMore = ref(false);
const reports = ref<HealthTrashEntry[]>([]);
const nextCursor = ref<string | null>(null);
const hasMore = ref(false);
const error = ref("");
const restoringId = ref("");
const cleanup = ref<TrashCleanupSummary|null>(null);
const cleanupError = ref(false);
const cleanupErrorReason = ref('');
const now = ref(Date.now());
const canManage = computed(() => Boolean(app.session.value?.authenticated) && app.allMembers.value.some(member => member.id===app.selectedMemberId.value && member.permission==='manager'));
const cleanupLabels = {waiting:'关联文件待清理',retrying:'关联文件等待重试',paused:'文件清理已暂缓',delayed:'清理已延期',unknown:'暂时无法确定清理计划',none:''};
let active = true;
let revoked = false;
let generation = 0;
let busy = false;
let timer: ReturnType<typeof setTimeout>|null = null;
let controller: AbortController|null = null;
function stopTimer() { if(timer) clearTimeout(timer); timer=null; }
function clearData() { reports.value=[]; cleanup.value=null; cleanupError.value=false; cleanupErrorReason.value=''; nextCursor.value=null; hasMore.value=false; error.value=''; }
function invalidate() { generation++; controller?.abort(); controller=null; busy=false; loading.value=false; loadingMore.value=false; restoringId.value=''; stopTimer(); }
function visible() { return active && document.visibilityState!=='hidden'; }
function schedule() {
 stopTimer();
 if(visible() && !revoked && (reports.value.length || cleanup.value?.pendingFileCount || cleanupError.value || error.value)) timer=setTimeout(()=>void load(),30_000);
}
function isDenied(cause:unknown) { return cause instanceof ApiRequestError && [401,403,404].includes(cause.status); }
function deny() { revoked=true; invalidate(); clearData(); error.value='当前账号已无法访问该成员的回收站，请重新确认权限。'; }
function trashUrl(memberId:string,cursor?:string|null) {
 const params=new URLSearchParams({memberId,limit:String(PAGE_SIZE)});
 if(cursor) params.set('cursor',cursor);
 return `health-records/trash?${params}`;
}
async function load(more=false) {
 const memberId=app.selectedMemberId.value;
 if(!app.session.value?.authenticated || !memberId || busy || revoked || !visible() || (more && (!hasMore.value || !nextCursor.value))) return;
 const token=generation;
 busy=true; stopTimer(); controller=new AbortController();
 if(more) loadingMore.value=true; else loading.value=true;
 const manager=canManage.value;
 const results=await Promise.allSettled([
   request<HealthTrashPage>(trashUrl(memberId,more?nextCursor.value:null),{signal:controller.signal}),
   manager?request<TrashCleanupSummary>(`reports/trash-cleanup?memberId=${encodeURIComponent(memberId)}`,{signal:controller.signal}):Promise.resolve(null)
 ]);
 if(token!==generation) return;
 if(results.some(result=>result.status==='rejected' && isDenied(result.reason))) {deny();return;}
 const [list,state]=results;
 if(list.status==='fulfilled') {
   const seen=new Set(reports.value.map(report=>`${report.kind}:${report.id}`));
   reports.value=more?[...reports.value,...list.value.items.filter(report=>!seen.has(`${report.kind}:${report.id}`))]:list.value.items;
   nextCursor.value=list.value.nextCursor; hasMore.value=list.value.hasMore; error.value='';
 } else { reports.value=[]; hasMore.value=false; error.value='回收站暂时无法获取，请稍后重试。'; }
 cleanup.value=state.status==='fulfilled'?state.value:null;
 cleanupError.value=manager && state.status==='rejected';
 cleanupErrorReason.value=state.status==='rejected' && state.reason instanceof ApiRequestError && state.reason.code==='STORAGE_UNAVAILABLE'
   ? '档案存储不可用或正在维护，请管理员检查存储挂载、目录权限及迁移状态。' : '';
 now.value=Date.now(); busy=false; loading.value=false; loadingMore.value=false; schedule();
}
function loadMore() { return load(true); }
async function perform(report:HealthTrashEntry,permanent:boolean) {
 if(restoringId.value || !canManage.value || revoked || report.memberId!==app.selectedMemberId.value) return;
 const token=generation; restoringId.value=report.id;
 const isVaccination=report.kind==='vaccination';
 const standalone=['symptom','medication','intake','measurement','process'].includes(report.kind);
 const label=report.kind==='report'?'报告':healthTrashLabels[report.kind];
 try {
   const result=standalone?await request<{pendingFileCount?:number|null;reminderNeedsReview?:boolean;omittedRecordCount?:number}>('health-records/trash',{method:'POST',body:JSON.stringify({kind:report.kind,id:report.id,revision:report.revision,operation:permanent?'purge':'restore'})}):await request<{pendingFileCount?:number|null;reminderNeedsReview?:boolean;omittedRecordCount?:number}>(`${isVaccination?'vaccinations':'reports'}/${encodeURIComponent(report.id)}${permanent?'?permanent=1':'/restore'}`,{method:permanent?'DELETE':'POST',...(isVaccination?{body:JSON.stringify({revision:report.revision})}:{})});
   if(token!==generation) return;
   toast.show(permanent?(report.kind==='report'&&result.pendingFileCount !== 0?'报告已永久删除，部分文件等待后台清理。':`${label}已永久删除。`):result.omittedRecordCount?`健康历程已恢复，${result.omittedRecordCount} 条原记录已不可用，未纳入恢复`:result.reminderNeedsReview?'接种记录已恢复，请在详情核对下一剂提醒':`${label}已恢复`);
   app.notifyDataChanged(); void app.refreshReminderCount();
   invalidate(); // Discard any pre-operation list/status request.
   restoringId.value='';
   await load(); // Query errors are displayed separately, never as deletion failures.
 } catch(cause) {
   if(token!==generation) return;
   if(cause instanceof ApiRequestError && [401,403].includes(cause.status)) deny();
   else if(cause instanceof ApiRequestError && cause.status===404) { invalidate(); await load(); }
   toast.show(cause instanceof Error?cause.message:permanent?'删除失败，请稍后重试':'恢复失败，请稍后重试');
 } finally { if(token===generation) restoringId.value=''; }
}
function restore(report:HealthTrashEntry) { return perform(report,false); }
function purge(report:HealthTrashEntry) {
 const token=generation;
 confirmDialog.ask({title:`永久删除${report.kind==='report'?'报告':healthTrashLabels[report.kind]}`,message:report.kind==='process'?`永久删除「${report.title}」？仅删除历程分组与整理信息，无法恢复；其中的原始记录及附件全部保留。`:report.kind!=='report'?`永久删除「${report.title}」？${report.kind==='medication'?'这段用药及包含的服药补充将无法恢复':report.kind==='symptom'?'这条症状及其变化历史将无法恢复':'这条记录将无法恢复'}，上传的原件和其他记录会保留。`:`永久删除「${report.title}」？永久删除后无法恢复，将立即尝试删除关联文件；仍被其他报告引用的文件会保留，清理失败的文件由后台重试。`,confirmText:'永久删除',danger:true,run:async()=>{if(token===generation) await perform(report,true);}});
}
function contextChanged() { invalidate(); clearData(); restoringId.value=''; revoked=false; void load(); }
watch(()=>[app.selectedMemberId.value,app.session.value?.id,app.session.value?.authenticated,canManage.value,app.accessVersion.value],contextChanged,{immediate:true});
function visibilityChanged() { if(!visible()) invalidate(); else void load(); }
document.addEventListener('visibilitychange',visibilityChanged);
onDeactivated(()=>{active=false;invalidate();});
onActivated(()=>{active=true;});
useRefreshOnActivate(()=>{void load();});
onBeforeUnmount(()=>{active=false;invalidate();document.removeEventListener('visibilitychange',visibilityChanged);});
</script>

<template>
  <section class="settings-page">
    <SubPageHeader title="回收站" description="移入回收站后保留 30 天，可恢复或永久删除。" />
    <p v-if="canManage && cleanupError" class="inline-panel-error" role="alert">清理状态暂时无法获取。{{ cleanupErrorReason || "请稍后重试。" }}</p>
    <section v-if="canManage && cleanup && cleanup.status !== 'none'" class="settings-band trash-cleanup-status" role="status">
      <header><Trash2 :size="20" /><div><h3>{{ cleanupLabels[cleanup.status] }}</h3><p>关联文件待清理：{{ cleanup.pendingFileCount }} 个<span v-if="cleanup.retryingFileCount">，其中 {{ cleanup.retryingFileCount }} 个等待重试</span></p></div></header>
      <div class="trash-cleanup-body">
        <p v-if="cleanup.reasonMessage">{{ cleanup.reasonMessage }}</p>
        <p v-if="cleanup.nextCleanupCheckAt">预计下次后台清理检查时间：{{ formatDatabaseTimeWithYear(cleanup.nextCleanupCheckAt) }}</p>
        <p>后台按队列分批处理，可能顺延至后续批次；检查时间不是全部文件清理完成时间。</p>
        <p>仅统计可关联到当前成员的报告清理任务，不代表整个数据目录的历史残留。</p>
      </div>
    </section>
    <p v-if="error" class="inline-panel-error">{{ error }}</p>
    <div v-if="loading" class="loading-list"><span v-for="index in 3" :key="index"></span></div>
    <EmptyState v-else-if="!reports.length && !error" title="回收站为空" description="移入回收站的记录会显示在这里。" />
    <template v-else>
      <div class="data-list trash-report-list">
        <article v-for="report in reports" :key="`${report.kind}:${report.id}`">
          <div class="trash-report-content"><strong>{{ report.title }}</strong><span>{{ healthTrashLabels[report.kind] }}<template v-if="report.doseNumber"> · {{/^\d+$/.test(report.doseNumber)?`第 ${report.doseNumber} 剂`:report.doseNumber}}</template> · {{ formatMedicationDate(report.date) || "日期待确认" }}<template v-if="report.institution"> · {{ report.institution }}</template></span>
            <span v-if="report.kind==='process'">仅移除历程，原始记录和附件保留</span>
            <span>移入回收站：{{ formatDatabaseTimeWithYear(report.deletedAt, '历史删除时间未记录') }}</span>
          </div>
          <div class="trash-report-footer">
            <span class="trash-retention" :title="formatDatabaseTimeWithYear(report.purgeAfter, '历史保留期限未记录')">
              <Clock3 :size="14" aria-hidden="true" />
              <span v-if="report.purgeAfter && Date.parse(report.purgeAfter) <= now">保留期已到，等待后台永久删除</span>
              <span v-else-if="report.purgeAfter">{{ new Date(report.purgeAfter).toLocaleDateString('zh-CN') }} 后永久删除</span>
              <span v-else>保留期限未记录，可恢复或手动删除</span>
            </span>
          <div v-if="canManage" class="row-actions trash-report-actions">
            <button type="button" :disabled="Boolean(restoringId)" v-if="app.allMembers.value.some(member=>member.id===report.memberId && member.permission==='manager')" @click="restore(report)">
              <LoaderCircle v-if="restoringId === report.id" class="spin-icon" :size="15" /><RotateCcw v-else :size="15" />恢复
            </button>
            <button class="danger-action" type="button" :disabled="Boolean(restoringId)" v-if="app.allMembers.value.some(member=>member.id===report.memberId && member.permission==='manager')" @click="purge(report)">永久删除</button>
          </div>
          </div>
        </article>
      </div>
      <div v-if="hasMore" class="form-actions">
        <button type="button" :disabled="loadingMore" @click="loadMore">
          <LoaderCircle v-if="loadingMore" class="spin-icon" :size="15" />{{ loadingMore ? "正在加载" : "加载更多" }}
        </button>
      </div>
    </template>
  </section>
</template>
