<script setup lang="ts">
import { useRoute } from "vue-router";
import { useAppContext } from "../../composables/useAppContext";
import { computed, nextTick, onMounted, watch, onDeactivated, onBeforeUnmount, ref } from "vue";
import { ArrowLeft, CircleHelp, Lightbulb, Check, ChevronRight, Copy, MessageSquare, ImagePlus, FileText, Plus, Search, X, LoaderCircle, RefreshCw } from "@lucide/vue";
import FeedbackAttachments from "../../components/FeedbackAttachments.vue";
import FeedbackImageEditor from "../../components/FeedbackImageEditor.vue";
import SubPageHeader from "../../components/SubPageHeader.vue";
import { copyTextToClipboard } from "../../utils/clipboard";
import { useScrollLock } from "../../composables/useScrollLock";
import { request } from "../../utils/api";
import { feedbackEnvironment, feedbackEnvironmentPayload, feedbackSnapshotDisplay, type FeedbackAbout, type FeedbackEnvironment } from "../../utils/feedback-environment";
import { requestFeedback, feedbackStatus, feedbackCategory, createFeedbackOperation, postFeedback, takeFeedbackDraft, type FeedbackDraft, type FeedbackTicket } from "../../utils/feedback-service";
import { createUuid } from "../../utils/uuid";
import { useToast } from "../../composables/useToast";

const app = useAppContext();
const route = useRoute();
type Attachment = { file: File; url: string };
type Feedback = { raw:FeedbackTicket; id:string; title:string; category:string; status:string; description:string; reply:string };
const mine = ref<Feedback[]>([]);
const query=ref("");
const loading=ref(false), listError=ref(''), detailError=ref(''), submitting=ref(false), actionBusy=ref(false);
const detailLoading=ref(false);
const page=ref(1), total=ref(0), eventPage=ref(1);
const message=ref('');
const operation=createFeedbackOperation();
const uploaded=new WeakMap<File,{key:string;id?:number;at?:number}>();
function present(raw:FeedbackTicket):Feedback {return {raw,id:raw.number,title:raw.title,category:feedbackCategory[raw.category]||raw.category,status:feedbackStatus[raw.status]||raw.status,description:raw.description||'',reply:raw.fixedVersion?'修复版本 '+raw.fixedVersion:'更新于 '+new Date(raw.updatedAt).toLocaleString()};}
let listSequence=0, detailSequence=0;
async function loadList() {
  const seq=++listSequence;loading.value=true;listError.value='';
  const params=new URLSearchParams({page:String(page.value),pageSize:'20'});
  if(query.value.trim()) params.set(/^(?:[BSO]\d{4,20}|FB-\d{4}-\d{6,20})$/i.test(query.value.trim())?'number':'q',/^(?:[BSO]\d|FB-)/i.test(query.value.trim())?query.value.trim().toUpperCase():query.value.trim());
  try {const result=await requestFeedback<{items:FeedbackTicket[];total:number}>('tickets?'+params);if(seq===listSequence){mine.value=result.items.map(present);total.value=result.total;void app.refreshReminderCount();}}
  catch(e){if(seq===listSequence) listError.value=e instanceof Error?e.message:'反馈加载失败';}
  finally {if(seq===listSequence) loading.value=false;}
}
async function loadDetail() {
  if(!selected.value) return;
  const number=selected.value.id,seq=++detailSequence;detailError.value='';detailLoading.value=true;
  try {const result=await requestFeedback<FeedbackTicket>('tickets/'+number+'?eventPage='+eventPage.value+'&eventPageSize=10');if(seq===detailSequence&&selected.value?.id===number){selected.value=present(result);return true;}}
  catch(e){if(seq===detailSequence)detailError.value=e instanceof Error?e.message:'详情加载失败';}
  finally {if(seq===detailSequence)detailLoading.value=false;}
}
async function refreshDetail() {
  if(actionBusy.value || detailLoading.value) return;
  if(await loadDetail() && screen.value==='detail') toast.show('处理进度已刷新');
}
let searchTimer:ReturnType<typeof setTimeout>;
watch(query,()=>{clearTimeout(searchTimer);searchTimer=setTimeout(()=>{page.value=1;void loadList();},300);});
onMounted(()=>void loadList());
onBeforeUnmount(()=>{clearTimeout(searchTimer);++listSequence;++detailSequence;});
const screen = ref<"list" | "detail">("list");
const modal = ref<"form" | "success" | null>(null);
const modalPanel = ref<HTMLElement | null>(null);
let trigger: HTMLElement | null = null;
useScrollLock(computed(() => modal.value !== null));
onDeactivated(() => { modal.value = null; editingImage.value = null; });
function closeModal() { if(submitting.value) return; editingImage.value = null; modal.value = null; void nextTick(() => trigger?.focus()); }
function modalKeydown(event: KeyboardEvent) {
  if (editingImage.value) return;
  if (event.key === "Escape") { event.preventDefault(); closeModal(); return; }
  if (event.key !== "Tab") return;
  const elements = Array.from(modalPanel.value?.querySelectorAll<HTMLElement>("button:not(:disabled), input, textarea, summary, [tabindex='0']") ?? [])
    .filter(element => !element.closest("details:not([open])") || element.tagName === "SUMMARY");
  const first = elements[0], last = elements[elements.length - 1];
  if (event.shiftKey && (document.activeElement === first || document.activeElement === modalPanel.value)) { event.preventDefault(); last?.focus(); }
  else if (!event.shiftKey && (document.activeElement === last || document.activeElement === modalPanel.value)) { event.preventDefault(); first?.focus(); }
}
const selected = ref<Feedback | null>(null);
watch(() => route?.query.feedback, async number => {
  if (typeof number !== 'string' || !/^(?:[BSO]\d{4,20}|FB-\d{4}-\d{6,20})$/.test(number)) return;
  try {
    const result = await requestFeedback<FeedbackTicket>('tickets/'+number+'?eventPage=1&eventPageSize=10');
    if (route?.query.feedback !== number) return;
    selected.value=present(result);eventPage.value=1;screen.value='detail';detailError.value='';
  } catch (cause) { detailError.value=cause instanceof Error ? cause.message : '反馈详情加载失败';toast.show(detailError.value); }
}, { immediate: true });
const attachments = ref<Attachment[]>([]);
const editingImage = ref<Attachment | null>(null);
function saveEditedImage(file: File) {
  const old = editingImage.value;
  const index = attachments.value.findIndex(item => item.url === old?.url);
  if (old && index >= 0) {
    const url = URL.createObjectURL(file);
    objectUrls.add(url);
    attachments.value[index] = { file, url };
    if (expandedImage.value === old.url) expandedImage.value = url;
    URL.revokeObjectURL(old.url); objectUrls.delete(old.url);
  }
  editingImage.value = null;
}
const attachmentError = ref("");
const expandedImage = ref<string | null>(null);
const imageInput = ref<HTMLInputElement | null>(null);
const objectUrls = new Set<string>();
onBeforeUnmount(() => { for (const url of objectUrls) URL.revokeObjectURL(url); });
function addImages(event: Event) {
  const input = event.target as HTMLInputElement;
  const errors: string[] = [];
  for (const file of Array.from(input.files || [])) {
    if (!["image/jpeg", "image/png", "image/webp", "application/pdf"].includes(file.type)) { errors.push("仅支持 JPG、PNG、WebP 图片和 PDF"); continue; }
    if (!file.size || file.size > 10 * 1024 * 1024) { errors.push("单个附件需大于 0 且不超过 10 MB"); continue; }
    const url = URL.createObjectURL(file);
    objectUrls.add(url);
    attachments.value.push({ file, url });
  }
  attachmentError.value = [...new Set(errors)].join("；");
  input.value = "";
}
function removeImage(index: number) {
  const [image] = attachments.value.splice(index, 1);
  if (expandedImage.value === image.url) expandedImage.value = null;
  URL.revokeObjectURL(image.url); objectUrls.delete(image.url);
  attachmentError.value = "";
}
const category = ref("使用问题");
const feedbackTypes = [{ label: "使用问题", icon: CircleHelp }, { label: "功能建议", icon: Lightbulb }, { label: "其他反馈", icon: MessageSquare }];
const title = ref("");
const description = ref("");
const steps = ref("");
const error = ref("");
const incomingDraft = ref<FeedbackDraft | null>(null);
const toast = useToast();
const items = computed(() => mine.value);
const environment = ref<FeedbackEnvironment>([]);
const environmentPayload=ref<Record<string,Record<string,unknown>>>({});
const environmentLoading = ref(false);
const environmentFailed = ref(false);
async function loadEnvironment() {
  if (environmentLoading.value) return;
  environmentLoading.value = true;
  environmentFailed.value = false;
  const client = { userAgent: navigator.userAgent, width: window.innerWidth, height: window.innerHeight };
  environment.value = feedbackEnvironment(null, client);
  environmentPayload.value=feedbackEnvironmentPayload(null,client);
  try {
    const about = await request<FeedbackAbout>("feedback-diagnostics");
    environment.value = feedbackEnvironment(about, client);
    environmentPayload.value=feedbackEnvironmentPayload(about,client);
  } catch {
    environmentFailed.value = true;
  } finally {
    environmentLoading.value = false;
  }
}
function openForm() {
  trigger = document.activeElement as HTMLElement;
  modal.value = "form"; error.value = "";
  void loadEnvironment();
  void nextTick(() => modalPanel.value?.focus());
}
function fillIncomingDraft() {
  if (!incomingDraft.value || submitting.value) return;
  category.value = '其他反馈';
  title.value = incomingDraft.value.title;
  description.value = incomingDraft.value.description;
  steps.value = '';
  for (const image of attachments.value) { URL.revokeObjectURL(image.url); objectUrls.delete(image.url); }
  attachments.value = []; expandedImage.value = null; attachmentError.value = '';
  operation.clear('submit');
  incomingDraft.value = null;
  error.value = '';
}
function openIncomingDraft() {
  if (route?.path !== '/me/feedback' || route.query.compose !== 'indicator' || submitting.value) return;
  const draft = takeFeedbackDraft();
  if (!draft) return;
  incomingDraft.value = draft;
  const hasDraft = Boolean(title.value.trim() || description.value.trim() || steps.value.trim() || attachments.value.length);
  if (!hasDraft) fillIncomingDraft();
  openForm();
}
watch(() => [route?.path, route?.query.compose, submitting.value], openIncomingDraft, {immediate:true});
function viewSubmitted() { closeModal(); screen.value = "detail"; void loadDetail(); }
async function submit() {
  if(environmentLoading.value || submitting.value) return;
  if(!title.value.trim() || !description.value.trim()) {error.value='请填写问题标题和详细描述';return;}
  submitting.value=true;error.value='';
  try {
    const ids:number[]=[];
    for(const image of attachments.value) {
      let upload=uploaded.get(image.file);
      if(!upload || (upload.at && Date.now()-upload.at>23*3600000)) {upload={key:createUuid()};uploaded.set(image.file,upload);}
      if(!upload.id) {const form=new FormData();form.set('file',image.file);const result=await requestFeedback<{id:number}>('upload',{method:'POST',headers:{'Idempotency-Key':upload.key},body:form});upload.id=result.id;upload.at=Date.now();}
      ids.push(upload.id);
    }
    const kind=category.value==='使用问题'?'problem':category.value==='功能建议'?'suggestion':'other';
    const body={category:kind,title:title.value.trim(),description:description.value.trim(),...(kind==='problem'?{reproductionSteps:steps.value.trim()}:{}),attachmentIds:ids,environment:environmentPayload.value};
    const result=await postFeedback<{number:string;status:string;version:number;createdAt:string}>('tickets',body,operation.key('submit',JSON.stringify(body)));
    selected.value=present({number:result.number,title:body.title,description:body.description,category:kind,status:result.status,version:result.version,createdAt:result.createdAt,updatedAt:result.createdAt,fixedVersion:null});
    title.value='';description.value='';steps.value='';
    for(const image of attachments.value) {URL.revokeObjectURL(image.url);objectUrls.delete(image.url);}
    attachments.value=[];expandedImage.value=null;operation.clear('submit');eventPage.value=1;modal.value='success';page.value=1;query.value='';void loadList();
  } catch(e) {error.value=e instanceof Error?e.message:'提交失败，请重试';if((e as {status?:number})?.status===410) {for(const image of attachments.value)uploaded.delete(image.file);operation.clear('submit');}}
  finally {submitting.value=false;}
}
async function updateFeedback(action:'message'|'confirm'|'reopen') {
  if(!selected.value || actionBusy.value) return;
  if(action!=='confirm'&&!message.value.trim()){detailError.value='请填写补充说明';return;}
  const number=selected.value.id;
  const body=action==='message'?{content:message.value.trim()}:{action,expectedVersion:selected.value.raw.version,...(message.value.trim()?{content:message.value.trim()}:{})};
  actionBusy.value=true;detailError.value='';
  try {await postFeedback('tickets/'+number+(action==='message'?'/messages':'/resolution'),body,operation.key(action+number,JSON.stringify(body)));message.value='';operation.clear(action+number);eventPage.value=1;await loadDetail();void loadList();}
  catch(e){const failure=e instanceof Error?e.message:'操作失败';if((e as {status?:number})?.status===409)await loadDetail();detailError.value=failure;}
  finally {actionBusy.value=false;}
}
async function copyNumber() {
  if (!selected.value) return;
  const copied = await copyTextToClipboard(selected.value.id);
  toast.show(copied ? "反馈编号已复制" : "复制失败，请手动选择编号");
}
function openDetail(item: Feedback) { selected.value = item; screen.value = "detail";eventPage.value=1;message.value="";void loadDetail(); }
</script>

<template>
  <section class="settings-page feedback-page">
    <SubPageHeader title="反馈与进度" description="让每一个问题都有后续" />

    <template v-if="screen === 'list'">
      <section class="feedback-hero">
        <div class="hero-symbol"><MessageSquare :size="25" /></div>
        <div><h3>遇到问题，或有新的想法？</h3><p>记录问题、补充信息，在这里查看每一步进展。同一应用安装的用户共享反馈记录。</p></div>
        <button class="feedback-primary" @click="openForm"><Plus :size="17" />提交反馈</button>
      </section>
      <section class="feedback-card">
        <div class="list-toolbar">
          <h3 class="feedback-list-title">当前应用的反馈 <span>{{ total }}</span></h3>
          <label class="feedback-search"><Search :size="16" /><input v-model="query" aria-label="搜索反馈" maxlength="80" placeholder="搜索关键词或编号" /></label>
        </div>
        <div class="feedback-list-body" :aria-busy="loading" role="region" aria-label="反馈列表">
          <div v-if="loading" class="feedback-list-loading" :class="{ 'is-refreshing': items.length > 0 }" role="status">
            <span><LoaderCircle :size="18" class="spin-icon" aria-hidden="true" />正在加载反馈…</span>
          </div>
          <div v-if="loading && !items.length" class="feedback-skeleton" aria-hidden="true">
            <div v-for="index in 3" :key="index" class="feedback-skeleton-row">
              <div><span class="skeleton-meta" /><span class="skeleton-title" /><span class="skeleton-description" /></div>
              <span class="skeleton-status" />
            </div>
          </div>
          <p v-if="listError" class="feedback-list-error" role="alert">{{ listError }} <button class="feedback-secondary" @click="loadList">重试</button></p>
          <div v-if="!loading && !listError && !items.length" class="feedback-empty">
            <MessageSquare :size="32" /><h3>{{ query ? '没有找到匹配的反馈' : '还没有提交过反馈' }}</h3>
            <p>{{ query ? '试试其他关键词或完整编号' : '提交后会生成编号，方便查看进度和在群里跟进。' }}</p>
            <button v-if="!query" class="feedback-secondary" @click="openForm">提交第一条反馈</button>
          </div>
          <button v-for="item in items" :key="item.id" class="feedback-row" :disabled="loading" @click="openDetail(item)">
            <div><div class="row-meta"><span>{{ item.id }}</span><span>{{ item.category }}</span></div><h3>{{ item.title }}</h3><p>{{ item.reply }}</p></div>
            <span class="feedback-status" :class="{ active: item.status === '处理中' }">{{ item.status }}</span><ChevronRight :size="17" />
          </button>
        </div>
      </section>
      <div v-if="total > 20" class="list-toolbar"><button class="feedback-secondary" :disabled="page===1 || loading" @click="page--;loadList()">上一页</button><span>第 {{ page }} 页 · 共 {{ total }} 条</span><button class="feedback-secondary" :disabled="page*20>=total || loading" @click="page++;loadList()">下一页</button></div>
    </template>

    <template v-else>
      <button class="feedback-back" :disabled="actionBusy" @click="screen = 'list'"><ArrowLeft :size="16" />返回反馈列表</button>
      <section v-if="selected" class="feedback-card feedback-detail">
        <header><div><div class="row-meta"><span>{{ selected.id }}</span><span>{{ selected.category }}</span></div><h3>{{ selected.title }}</h3></div><span class="feedback-status">{{ selected.status }}</span></header>
        <div class="detail-section"><h4>问题描述</h4><p class="description">{{ selected.description }}</p></div>
        <div v-if="selected.raw.attachments?.length" class="detail-section"><h4>问题附件 · {{ selected.raw.attachments.length }} 个</h4><FeedbackAttachments :attachments="selected.raw.attachments" /></div>
        <div v-if="selected.raw.reproductionSteps" class="detail-section"><h4>复现步骤</h4><p class="description">{{ selected.raw.reproductionSteps }}</p></div>
        <div class="detail-section"><h4 class="feedback-progress-heading">处理进度<button type="button" class="plain-icon-button" :disabled="actionBusy || detailLoading" :aria-busy="detailLoading" :aria-label="detailLoading ? '正在刷新进度' : '刷新进度'" :title="detailLoading ? '正在刷新进度' : '刷新进度'" @click="refreshDetail"><RefreshCw :size="15" :class="{ 'spin-icon': detailLoading }" aria-hidden="true" /></button></h4><p v-if="selected.raw.fixedVersion">修复版本：{{ selected.raw.fixedVersion }}</p><p v-if="detailError" role="alert">{{ detailError }}</p><ol class="feedback-timeline"><li v-for="event in selected.raw.events" :key="event.id"><strong>{{ event.actorType==='admin'?'管理员':event.actorType==='user'?'用户':'系统' }} · {{ event.toStatus ? feedbackStatus[event.toStatus] : '补充回复' }}</strong><p>{{ new Date(event.createdAt).toLocaleString() }}<span v-if="event.fixedVersion"> · 修复版本 {{ event.fixedVersion }}</span></p><p class="description">{{ event.content }}</p><FeedbackAttachments v-if="event.attachments?.length" :attachments="event.attachments" /></li></ol><div v-if="(selected.raw.eventTotal||0)>10" class="list-toolbar"><button :disabled="eventPage===1||actionBusy" @click="eventPage--;loadDetail()">上一页</button><span>第 {{ eventPage }} 页</span><button :disabled="eventPage*10>=(selected.raw.eventTotal||0)||actionBusy" @click="eventPage++;loadDetail()">下一页</button></div></div>
        <div class="detail-section"><h4>补充说明</h4><textarea v-model="message" aria-label="补充说明" rows="3" maxlength="3000" :disabled="actionBusy" placeholder="补充问题情况，请勿填写健康报告、检查结果或账号密钥" /><div class="modal-actions"><button class="feedback-secondary" :disabled="actionBusy||!message.trim()" @click="updateFeedback('message')">发送补充</button><button v-if="selected.raw.status==='released_pending_verification'" class="feedback-primary" :disabled="actionBusy" @click="updateFeedback('confirm')">确认已解决</button><button v-if="['released_pending_verification','resolved'].includes(selected.raw.status)" class="feedback-secondary" :disabled="actionBusy||!message.trim()" @click="updateFeedback('reopen')">仍未解决</button></div></div>
        <details v-if="selected.raw.environment" class="environment-info detail-section"><summary>提交时的环境信息</summary><dl><div v-for="item in feedbackSnapshotDisplay(selected.raw.environment)" :key="item.label"><dt>{{ item.label }}</dt><dd>{{ item.value }}</dd></div></dl></details>
        <footer><span>请通过反馈编号跟进问题；如需紧急了解处理进展，可在 QQ 群发送此编号进行跟进。</span><button class="feedback-secondary" @click="copyNumber"><Copy :size="15" />复制编号</button></footer>
      </section>
    </template>
    <Teleport to="body">
      <div v-if="modal" :inert="editingImage ? true : undefined" class="sheet-backdrop feedback-overlay" @click.self="closeModal" @keydown="modalKeydown">
        <section ref="modalPanel" class="sheet-panel feedback-modal" role="dialog" aria-modal="true" aria-labelledby="feedback-modal-title" tabindex="-1">
          <span class="sheet-grabber" aria-hidden="true"></span>
          <header class="modal-heading"><div><h3 id="feedback-modal-title">{{ modal === 'form' ? '提交反馈' : '提交成功' }}</h3><p>{{ modal === 'form' ? '描述问题，让我们更好地了解你的想法' : '请保存反馈编号，便于后续跟进' }}</p></div><button class="modal-close" aria-label="关闭反馈弹窗" @click="closeModal"><X :size="20" /></button></header>
      <form v-if="modal === 'form'" class="feedback-form" @submit.prevent="submit">
        <p v-if="incomingDraft" class="feedback-error" role="status">已保留当前未提交的反馈，另有一份指标申请待填写。<button type="button" :disabled="submitting" @click="fillIncomingDraft">替换当前草稿为指标申请</button></p>
        <div class="feedback-form-body">
        <fieldset class="feedback-fields" :disabled="submitting">
        <fieldset><legend>反馈类型</legend><div class="type-options"><button v-for="kind in feedbackTypes" :key="kind.label" type="button" :aria-pressed="category === kind.label" @click="category = kind.label"><component :is="kind.icon" :size="15" aria-hidden="true" /><span>{{ kind.label }}</span></button></div></fieldset>
        <label>问题标题 <span class="required">*</span><input v-model="title" maxlength="80" required placeholder="用一句话概括问题或建议" /></label>
        <label>详细描述 <span class="required">*</span><textarea v-model="description" rows="4" maxlength="3000" required placeholder="具体遇到了什么？期望是什么？请勿填写健康报告、检查结果或账号密钥。" /></label>
        <section class="attachment-section" aria-label="问题附件">
          <div class="attachment-heading"><h4>问题附件 <span class="optional">选填</span></h4><span>已添加 {{ attachments.length }} 个</span></div>
          <p>支持 JPG、PNG、WebP 和 PDF，每个不超过 10 MB。PDF 不支持在线打码，请上传前确认已遮挡隐私信息。</p>
          <input ref="imageInput" class="attachment-input" type="file" accept="image/jpeg,image/png,image/webp,application/pdf" multiple aria-label="选择问题附件" @change="addImages" />
          <div class="attachment-grid">
            <div v-for="(image, index) in attachments" :key="image.url" class="attachment-tile">
              <button type="button" class="attachment-preview" :aria-label="`预览附件 ${index + 1}`" @click="expandedImage = expandedImage === image.url ? null : image.url"><span v-if="image.file.type === 'application/pdf'" class="pdf-card"><FileText :size="28" /><span>{{ image.file.name }}</span><small>PDF · {{ Math.ceil(image.file.size / 1024) }} KB</small></span><img v-else :src="image.url" :alt="`问题截图 ${index + 1}`" /></button>
              <button type="button" v-if="image.file.type !== 'application/pdf'" class="attachment-edit" :aria-label="`编辑截图 ${index + 1}`" @click="editingImage = image">涂鸦 / 打码</button>
              <button type="button" class="attachment-remove" :aria-label="`删除附件 ${index + 1}`" @click="removeImage(index)"><X :size="14" /></button>
            </div>
            <button type="button" class="attachment-add" @click="imageInput?.click()"><ImagePlus :size="24" /><span>添加附件</span></button>
          </div>
          <div v-if="expandedImage" class="attachment-expanded"><iframe v-if="attachments.some(a => a.url === expandedImage && a.file.type === 'application/pdf')" :src="expandedImage" title="PDF 附件预览" class="pdf-preview" /><img v-else :src="expandedImage" alt="截图预览" /><a v-if="attachments.some(a => a.url === expandedImage && a.file.type === 'application/pdf')" :href="expandedImage" target="_blank" rel="noopener">在新窗口查看 PDF</a><button type="button" class="feedback-secondary" @click="expandedImage = null">收起预览</button></div>
          <p v-if="attachmentError" role="alert" class="attachment-error">{{ attachmentError }}</p>

        </section>
        <details v-if="category === '使用问题'" class="environment-preview"><summary>复现步骤 <span>选填</span></summary><label><span class="optional">描述操作顺序</span><textarea v-model="steps" rows="2" maxlength="2000" placeholder="例如：打开哪个页面，进行了什么操作……" /></label></details>
        <details class="environment-info" aria-label="随反馈附带的信息" :aria-busy="environmentLoading">
          <summary>随反馈附带的信息<span class="environment-subtitle">附带版本与运行环境，便于定位问题，不包含健康档案、账号或密钥。</span></summary>
          <p v-if="environmentLoading" role="status">正在读取运行环境…</p>
          <p v-if="environmentFailed" role="status">应用环境读取失败，可重试或继续填写。<button type="button" @click="loadEnvironment">重试</button></p>
          <p v-if="environmentPayload.ai?.enabled">AI 信息为提交时的报告整理配置，不代表历史报告当时使用的模型；私有接入点标识不会附带。</p>
          <dl><div v-for="item in environment" :key="item.label"><dt>{{ item.label }}</dt><dd>{{ item.value }}</dd></div></dl>
        </details>
        <p v-if="error" role="alert">{{ error }}</p>
        </fieldset>
        </div>
        <footer class="modal-footer"><span>提交前请确认附件已遮挡隐私信息</span><div class="modal-actions"><button type="button" class="feedback-secondary" @click="closeModal">取消</button><button type="submit" class="feedback-primary" :disabled="environmentLoading || submitting">{{ submitting ? '正在提交…' : '提交反馈' }}<ChevronRight :size="16" /></button></div></footer>
      </form>
      <section v-else-if="selected" class="success-card">
        <div class="success-icon"><Check :size="28" /></div><h3>反馈已提交</h3><p>可以凭此编号在群里询问或跟进。</p>
        <div class="number-box"><span>反馈编号</span><strong>{{ selected.id }}</strong><button class="feedback-secondary" @click="copyNumber"><Copy :size="15" />复制编号</button></div>
        <button class="feedback-primary" @click="viewSubmitted">查看进度<ChevronRight :size="16" /></button>
      </section>
        </section>
      </div>
    </Teleport>
    <FeedbackImageEditor v-if="editingImage" :file="editingImage.file" @cancel="editingImage = null" @save="saveEditedImage" />
  </section>
</template>

<style scoped>
.feedback-page { gap: 18px; }
.feedback-fields { display:grid; gap:14px; min-width:0; }
.feedback-detail textarea { width:100%; box-sizing:border-box; margin:12px 0; padding:12px; border:1px solid var(--line); border-radius:10px; background:var(--surface); color:var(--ink); }
.preview-notice { margin: 0; color: var(--muted); font-size: 12px; line-height: 1.7; }
.feedback-hero { display: flex; align-items: center; gap: 18px; padding: 26px; background: var(--brand-softer); border: 1px solid var(--brand-soft); border-radius: 18px; }
.hero-symbol,.success-icon { display: grid; place-items: center; width: 54px; height: 54px; border-radius: 17px; background: var(--brand-soft); color: var(--brand); flex-shrink: 0; }
.feedback-hero > div:nth-child(2) { flex: 1; }
h3,h4,p { margin: 0; }
h3 { font-size: 16px; line-height: 1.6; } h4 { font-size: 13px; }
p { color: var(--muted); font-size: 13px; line-height: 1.8; }
.feedback-hero p { margin-top: 5px; }
.feedback-primary,.feedback-secondary { display: inline-flex; align-items: center; justify-content: center; gap: 7px; min-height: 40px; padding: 0 15px; border-radius: 10px; font-size: 13px; font-weight: 600; cursor: pointer; white-space: nowrap; }
.feedback-primary { border: 1px solid var(--brand); background: var(--brand); color: white; }
.feedback-primary:hover { background: var(--brand-strong); }
.feedback-secondary { border: 1px solid var(--line); background: var(--surface); color: var(--ink); }
.feedback-card { border: 1px solid var(--line); border-radius: 18px; background: var(--surface); overflow: hidden; }
.feedback-list-title { font-size: 14px; }
.feedback-list-title span { margin-left: 6px; color: var(--muted); font-size: 12px; font-weight: 400; }
.list-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 18px 22px; border-bottom: 1px solid var(--line); }
button[aria-pressed="true"] { background: var(--brand-soft); color: var(--brand-strong); font-weight: 600; }
.type-options { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 4px; padding: 3px; border: 1px solid var(--line); border-radius: 10px; background: var(--fill-2); }
.type-options button { display: flex; align-items: center; justify-content: center; gap: 5px; min-height: 34px; padding: 5px 6px; border: 1px solid transparent; border-radius: 7px; background: transparent; color: var(--muted); font-size: 12px; cursor: pointer; transition: background .15s, color .15s, box-shadow .15s; }
.type-options button:hover { color: var(--brand-strong); background: var(--brand-softer); }
.type-options button[aria-pressed="true"] { color: var(--brand-strong); background: var(--surface); border-color: var(--brand-soft); box-shadow: 0 2px 5px var(--hairline); font-weight: 600; }
.type-options button svg { flex-shrink: 0; }
@media(max-width:360px) { .type-options button { gap: 4px; font-size: 12px; } }
.feedback-search { display: flex; align-items: center; gap: 8px; padding: 9px 12px; border-radius: 9px; background: var(--fill-2); color: var(--muted); }
.feedback-search input { width: 160px; border: 0; outline: 0; background: transparent; font-size: 12px; color: var(--ink); }
.feedback-list-body { position: relative; }
.feedback-list-loading { position: absolute; inset: 0; z-index: 1; display: grid; place-items: center; cursor: progress; }
.feedback-list-loading.is-refreshing { background: color-mix(in srgb, var(--surface) 75%, transparent); }
.feedback-list-loading > span { display: inline-flex; align-items: center; gap: 9px; padding: 12px 16px; border: 1px solid var(--line); border-radius: 12px; background: var(--surface); box-shadow: var(--shadow-m); color: var(--muted); font-size: 13px; }
.feedback-list-loading svg { color: var(--brand); }
.feedback-list-error { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 18px 22px; }
.feedback-skeleton-row { display: flex; align-items: center; gap: 18px; padding: 22px; min-height: 114px; box-sizing: border-box; border-bottom: 1px solid var(--line); }
.feedback-skeleton-row:last-child { border-bottom: 0; }
.feedback-skeleton-row > div { display: grid; gap: 12px; flex: 1; min-width: 0; }
.feedback-skeleton-row span { display: block; height: 12px; border-radius: 5px; background: var(--fill-2); animation: feedback-skeleton-pulse 1.4s ease-in-out infinite; }
.feedback-skeleton-row .skeleton-meta { width: 100px; max-width: 50%; height: 10px; }
.feedback-skeleton-row .skeleton-title { width: 55%; height: 16px; }
.feedback-skeleton-row .skeleton-description { width: 75%; }
.feedback-skeleton-row .skeleton-status { width: 62px; height: 26px; flex-shrink: 0; }
@keyframes feedback-skeleton-pulse { 50% { opacity: .45; } }
@media (prefers-reduced-motion: reduce) { .feedback-skeleton-row span,.feedback-list-loading .spin-icon,.feedback-progress-heading .spin-icon { animation: none; } }
.feedback-empty { display: grid; justify-items: center; gap: 12px; padding: 55px 20px; text-align: center; }
.feedback-empty > svg { color: var(--arrow-muted); margin-bottom: 4px; }
.feedback-row { display: flex; align-items: center; gap: 18px; width: 100%; padding: 22px; border: 0; border-bottom: 1px solid var(--line); background: transparent; text-align: left; color: var(--ink); cursor: pointer; }
.feedback-row:last-child { border-bottom: 0; }.feedback-row:hover { background: var(--fill-2); }
.feedback-row:disabled { cursor: progress; }
.feedback-row > div { flex: 1; min-width: 0; }.feedback-row h3 { font-size: 14px; margin: 6px 0; }.feedback-row > svg { color: var(--arrow-muted); flex-shrink: 0; }
.row-meta { display: flex; flex-wrap: wrap; gap: 10px; color: var(--muted); font-size: 11px; }
.feedback-status { padding: 5px 9px; border-radius: 6px; background: var(--fill-1); color: var(--muted); font-size: 11px; white-space: nowrap; }.feedback-status.active { color: var(--brand-strong); background: var(--brand-soft); }
.feedback-back { display: flex; align-items: center; gap: 7px; justify-self: start; padding: 0; border: 0; background: transparent; color: var(--muted); font-size: 13px; cursor: pointer; }
.feedback-form { display: flex; flex-direction: column; min-height: 0; overflow: hidden; }
.feedback-form-body { padding: 18px 20px; min-height:0; flex:1 1 auto; overflow-y:auto; overscroll-behavior:contain; }.section-heading p { margin-top: 4px; }
.feedback-form fieldset { padding: 0; border: 0; margin: 0; }.feedback-form legend { margin-bottom: 7px; font-size: 12px; font-weight: 600; }
.feedback-form label { font-size: 12px; font-weight: 600; }.required { color: var(--danger); }.optional { color: var(--muted); font-size: 11px; font-weight: 400; }
.feedback-form input,.feedback-form textarea { display: block; width: 100%; box-sizing: border-box; margin-top: 6px; padding: 9px 10px; border: 1px solid var(--line-strong); border-radius: 8px; background: var(--surface); color: var(--ink); font: inherit; font-weight: 400; line-height: 1.6; }.feedback-form textarea { resize: vertical; }
.environment-preview { padding: 11px 12px; border-radius: 10px; background: var(--fill-2); font-size: 12px; }.environment-preview summary { cursor: pointer; }.environment-preview span { color: var(--muted); margin-left: 8px; }.environment-preview p { margin-top: 10px; }
footer { display: flex; align-items: center; justify-content: space-between; gap: 16px; border-top: 1px solid var(--line); padding-top: 18px; }footer > span { font-size: 12px; color: var(--muted); }
.success-card { display: grid; justify-items: center; gap: 16px; padding: 40px 24px; text-align: center; }.number-box { display: grid; justify-items: center; gap: 12px; width: min(100%, 320px); padding: 24px; border-radius: 14px; background: var(--fill-2); }.number-box > span { font-size: 12px; color: var(--muted); }.number-box strong { font-size: 28px; letter-spacing: .05em; }
.feedback-detail { padding: 26px; }.feedback-detail header { display: flex; align-items: center; justify-content: space-between; gap: 16px; }.feedback-detail h3 { margin-top: 7px; }.detail-section { margin-top: 26px; }.detail-section > p { margin-top: 10px; }.description { white-space: pre-wrap; overflow-wrap: anywhere; }.feedback-timeline { padding: 0 0 0 18px; margin: 18px 0 24px; border-left: 2px solid var(--brand-soft); list-style: none; }.feedback-timeline li { position: relative; margin-bottom: 20px; }.feedback-timeline li::before { content: ''; position: absolute; left: -24px; top: 5px; width: 10px; height: 10px; border-radius: 50%; background: var(--brand); border: 2px solid var(--surface); }.feedback-timeline strong { font-size: 13px; }
.feedback-progress-heading { display: flex; align-items: center; gap: 6px; }
button:focus-visible,input:focus-visible,textarea:focus-visible,summary:focus-visible { outline: 2px solid var(--brand); outline-offset: 3px; }
@media(max-width:600px) {
.feedback-hero { flex-wrap: wrap; padding: 20px; gap: 12px; }.hero-symbol { display: none; }.feedback-hero > div:nth-child(2) { flex-basis: 100%; }.list-toolbar { flex-direction: column; align-items: stretch; padding: 14px; }.feedback-search input { width: 100%; }.feedback-row { padding: 18px 14px; gap: 10px; flex-wrap: wrap; }.feedback-row > div { flex-basis: 100%; }.feedback-row > svg { margin-left: auto; }.feedback-detail { padding: 20px 16px; }footer { flex-direction: column; align-items: stretch; }.feedback-detail header { align-items: flex-start; }.number-box { box-sizing: border-box; }
}
.feedback-overlay { position: fixed; inset: 0; z-index: 300; display: flex; align-items: center; justify-content: center; padding: 24px; background: var(--overlay); backdrop-filter: blur(4px); }
.feedback-modal { width: min(600px, 100%); max-height: calc(100dvh - 48px); display: flex; flex-direction: column; overflow: hidden; background: var(--surface); color: var(--ink); border: 1px solid var(--line); border-radius: 20px; box-shadow: var(--shadow-m); outline: none; }
.modal-heading { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 16px 20px; border-bottom: 1px solid var(--line); flex-shrink: 0; }
.modal-heading p { font-size: 12px; margin-top: 4px; }
.modal-close { display: grid; place-items: center; width: 36px; height: 36px; flex-shrink: 0; border: 0; border-radius: 10px; color: var(--muted); background: var(--fill-2); cursor: pointer; }
.modal-footer { padding: 12px 20px; flex-shrink: 0; background: var(--surface); }
.modal-actions { display: flex; gap: 10px; }
.feedback-modal .success-card { overflow-y: auto; padding-bottom: calc(24px + env(safe-area-inset-bottom)); }
@media (max-width: 760px), (pointer: coarse) {
  .feedback-overlay { padding: 0; align-items: flex-end; }
  .feedback-modal { width: 100%; height: auto; max-height: 98vh; max-height: 98dvh; border: 0; border-radius: 20px 20px 0 0; padding-bottom: 0; animation: slide-up .22s ease; }
  .feedback-modal .sheet-grabber { display: block; flex-shrink: 0; width: 36px; height: 4px; margin: 8px auto 2px; border-radius: 999px; background: var(--grabber); }
  .modal-heading { padding: 12px 16px 14px; }
  .feedback-form { flex: 1; }
  .feedback-form-body { padding: 16px; flex: 1; }
  .modal-footer { padding: 10px 16px max(10px, env(safe-area-inset-bottom)); gap: 8px; }
  .modal-actions > button { flex: 1; min-height: 44px; }
}
.environment-info { padding: 16px; border: 1px solid var(--line); border-radius: 12px; background: var(--fill-2); }
details.environment-info { padding: 11px 12px; border: 0; border-radius: 10px; }
.environment-subtitle { display: block; margin-top: 6px; color: var(--muted); font-size: 11px; line-height: 1.7; }
.environment-info > summary { cursor: pointer; font-size: 12px; font-weight: 400; }
.environment-info dl { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px 20px; margin: 14px 0; }
.environment-info dt { color: var(--muted); font-size: 11px; }
.environment-info dd { margin: 4px 0 0; color: var(--ink); font-size: 12px; overflow-wrap: anywhere; }
.environment-info p { font-size: 11px; }
.environment-info button { border: 0; background: transparent; color: var(--brand); cursor: pointer; margin-left: 8px; }
.feedback-primary:disabled { opacity: .55; cursor: wait; }
@media(max-width:360px) { .environment-info dl { grid-template-columns: 1fr; } }
.attachment-heading { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
.attachment-heading > span { font-size: 12px; color: var(--muted); }
.attachment-section p { font-size: 11px; }
.feedback-form .attachment-input { display: none; }
.attachment-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; margin: 12px 0; }
.attachment-tile { position: relative; min-width: 0; }
.attachment-preview,.attachment-add,.attachment-grid > a { width: 100%; aspect-ratio: 4 / 3; border: 1px solid var(--line); border-radius: 10px; overflow: hidden; background: var(--fill-2); padding: 0; display: block; cursor: pointer; }
.attachment-grid img { width: 100%; height: 100%; object-fit: contain; }
.attachment-add { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; border-style: dashed; color: var(--brand); font-size: 12px; }
.attachment-remove { position: absolute; right: 4px; top: 4px; width: 30px; height: 30px; display: grid; place-items: center; border: 1px solid var(--line); border-radius: 50%; background: var(--surface); color: var(--ink); cursor: pointer; }
.attachment-expanded { display: grid; justify-items: center; gap: 10px; margin-bottom: 12px; }
.attachment-expanded img { max-width: 100%; max-height: 50dvh; object-fit: contain; border-radius: 8px; }
.attachment-section .attachment-error { color: var(--danger); }
.attachment-edit { position: absolute; bottom: 5px; left: 5px; right: 5px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface); color: var(--ink); min-height: 30px; font-size: 11px; cursor: pointer; }
.attachment-section .attachment-grid { grid-template-columns: repeat(3, minmax(0, 120px)); gap: 8px; margin: 8px 0; }
.attachment-section h4 { font-size: 12px; }
.pdf-card { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 7px; padding: 8px; height: 100%; box-sizing: border-box; color: var(--brand-strong); }
.pdf-card span { max-width: 100%; white-space: nowrap; text-overflow: ellipsis; overflow: hidden; font-size: 12px; }
.pdf-card small { color: var(--muted); }
.pdf-preview { width: 100%; height: 60vh; border: 0; }
</style>
