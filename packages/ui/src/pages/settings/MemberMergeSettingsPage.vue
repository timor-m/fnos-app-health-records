<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import SubPageHeader from '../../components/SubPageHeader.vue';
import FormSelect from '../../components/FormSelect.vue';
import { ArrowRight, Info } from '@lucide/vue';
import { request } from '../../utils/api';
import { useAppContext } from '../../composables/useAppContext';
type Candidate={id:string;displayName:string;creatorName:string;selfName:string|null;reportCount:number};
type Account={userId:string;displayName:string;permission:'viewer'|'manager';canManageSharing:boolean;usable:boolean};
type SelfAccount={userId:string;memberId:string;displayName:string;usable:boolean};
type Field='display_name'|'birth_date'|'sex'|'blood_type_abo'|'blood_type_rh'|'care_allergies'|'care_history'|'care_medications';
const labels:Record<Field,string>={display_name:'姓名',birth_date:'出生日期',sex:'性别',blood_type_abo:'ABO 血型',blood_type_rh:'Rh 血型',care_allergies:'过敏及不良反应',care_history:'重要病史',care_medications:'长期用药'};
const fields=Object.keys(labels) as Field[];
const display=(field:Field,value:string|null)=>field==='sex'?({male:'男',female:'女',unknown:'未知'}[value||'unknown']||value):(value||'未填写');
const app=useAppContext();
const items=ref<Candidate[]>([]),total=ref(0),page=ref(1),q=ref(''),loading=ref(false),busy=ref(false),error=ref('');
const source=ref<Candidate|null>(null),target=ref<Candidate|null>(null);
const selection=ref<{source:Record<Field,string|null>;target:Record<Field,string|null>;sourceAccounts:Account[];targetAccounts:Account[];selfAccounts:SelfAccount[]}|null>(null);
const choices=ref<Record<Field,'source'|'target'>>({display_name:'target',birth_date:'target',sex:'target',blood_type_abo:'target',blood_type_rh:'target',care_allergies:'target',care_history:'target',care_medications:'target'});
const grants=ref<Array<Account & {included:boolean}>>([]);
const preview=ref<{token:string;reportCount:number;warning:string;resolvedFields:Record<Field,string|null>;selfResolution:{retained:SelfAccount|null;released:SelfAccount[]}}|null>(null),result=ref<{reportCount:number}|null>(null),confirmed=ref(false);
const selfUserId=ref('');
const selfOptions=computed(()=>[{value:'',label:'暂不关联本人账号'},...(selection.value?.selfAccounts??[]).map(a=>({value:a.userId,label:`${a.displayName}（${a.userId} · ${a.memberId===target.value?.id?'保留档案':'迁入档案'}${a.usable?'':' · 账号不可用'}）`,disabled:!a.usable}))]);
let sequence=0;
async function load() {
 const seq=++sequence;loading.value=true;error.value='';
 try {const r=await request<{items:Candidate[];total:number}>(`maintenance/member-merges/candidates?page=${page.value}&q=${encodeURIComponent(q.value)}`);if(seq===sequence){items.value=r.items;total.value=r.total;}}
 catch(e){if(seq===sequence) error.value=e instanceof Error?e.message:'加载失败';}finally{if(seq===sequence)loading.value=false;}
}
function pick(row:Candidate,kind:'source'|'target') {if(kind==='source')source.value=row;else target.value=row;selection.value=null;preview.value=null;confirmed.value=false;}
async function next() {
 if(!source.value||!target.value||source.value.id===target.value.id)return;
 busy.value=true;error.value='';
 try {
 selection.value=await request(`maintenance/member-merges/selection?sourceId=${encodeURIComponent(source.value.id)}&targetId=${encodeURIComponent(target.value.id)}`);
 const selected=selection.value!;const map=new Map<string,Account & {included:boolean}>();
 selected.sourceAccounts.forEach(a=>map.set(a.userId,{...a,included:false}));selected.targetAccounts.forEach(a=>map.set(a.userId,{...a,included:a.usable}));
 grants.value=[...map.values()];
 const candidates=selected.selfAccounts.filter(a=>a.usable&&map.has(a.userId));
 selfUserId.value=(candidates.find(a=>a.memberId===target.value!.id)??candidates[0])?.userId??'';
 const selfGrant=grants.value.find(g=>g.userId===selfUserId.value);if(selfGrant)selfGrant.included=true;
 fields.forEach(f=>choices.value[f]='target');preview.value=null;
 }catch(e){error.value=e instanceof Error?e.message:'加载失败';}finally{busy.value=false;}
}
async function preflight() {
 busy.value=true;error.value='';confirmed.value=false;
 try {preview.value=await request('maintenance/member-merges/preview',{method:'POST',body:JSON.stringify({sourceId:source.value!.id,targetId:target.value!.id,choices:choices.value,selfUserId:selfUserId.value||null,grants:grants.value.filter(g=>g.included).map(g=>({userId:g.userId,permission:g.permission,canManageSharing:g.permission==='manager'&&g.canManageSharing}))})});}
 catch(e){error.value=e instanceof Error?e.message:'预览失败';}finally{busy.value=false;}
}
async function execute() {
 if(!preview.value||!confirmed.value)return;
 busy.value=true;error.value='';
 try {result.value=await request('maintenance/member-merges',{method:'POST',body:JSON.stringify({token:preview.value.token})});try { await app.refreshMembers(); } catch { /* Merge already committed; a later refresh can reload membership. */ }}
 catch(e){error.value=e instanceof Error?e.message:'合并失败，可重试；已完成的请求不会重复合并';}finally{busy.value=false;}
}
onMounted(()=>{if(app.session.value?.isAdmin)void load();});
</script>
<template>
 <section class="settings-page merge-page">
  <SubPageHeader title="成员档案合并" description="将同一人的两个档案统一到一个成员，保留报告与人工校对" />
  <p v-if="!app.session.value?.isAdmin" role="alert">仅管理员可使用此功能</p>
  <template v-else>
   <div class="notice"><Info :size="16" aria-hidden="true" /><p>这里只展示成员摘要。合并权限不会赋予你报告阅读权限，也不会合并登录账号。</p></div>
   <p v-if="error" class="error" role="alert">{{ error }}</p>
   <section v-if="result" class="panel" role="status"><h3>合并完成</h3><p>已将 {{ result.reportCount }} 份报告迁入 {{ target?.displayName }}，来源档案已退出成员列表。</p><p>后续可通过成员共享分配访问权限。合并前安全备份已保留。</p><button @click="result=null;selection=null;preview=null;source=null;target=null;load()">返回档案列表</button></section>
   <template v-else>
    <section class="panel direction"><div class="direction-card"><small>迁入档案</small><strong>{{ source?.displayName || '请选择' }}</strong><code>{{ source?.id }}</code></div><button class="swap-button" aria-label="交换迁入和保留档案" title="交换迁入和保留档案" :disabled="busy||!source||!target" @click="[source,target]=[target,source];selection=null;preview=null;confirmed=false"><ArrowRight :size="18" aria-hidden="true" /><span>交换</span></button><div class="direction-card target-card"><small>保留档案</small><strong>{{ target?.displayName || '请选择' }}</strong><code>{{ target?.id }}</code></div></section>
    <section v-if="!selection" class="panel">
     <form class="toolbar" @submit.prevent="page=1;load()"><input v-model="q" aria-label="搜索成员姓名或编号" placeholder="搜索姓名或完整档案编号" maxlength="80" /><button :disabled="loading">查询</button></form>
     <p v-if="loading" role="status">正在加载…</p>
     <p v-else-if="!items.length">暂无可合并的档案</p>
     <article v-for="row in items" :key="row.id" class="candidate"><div><strong>{{ row.displayName }}</strong><code>{{ row.id }}</code><p>创建账号：{{ row.creatorName }} · 本人账号：{{ row.selfName || '未关联' }} · {{ row.reportCount }} 份报告（含回收站）</p></div><div class="actions"><button :disabled="busy||target?.id===row.id" :aria-pressed="source?.id===row.id" @click="pick(row,'source')">{{ source?.id===row.id?'已选迁入':'作为迁入' }}</button><button :disabled="busy||source?.id===row.id" :aria-pressed="target?.id===row.id" @click="pick(row,'target')">{{ target?.id===row.id?'已选保留':'作为保留' }}</button></div></article>
     <div class="toolbar"><button :disabled="loading||page===1" @click="page--;load()">上一页</button><span>{{ page }} / {{ Math.max(1,Math.ceil(total/20)) }}</span><button :disabled="loading||page*20>=total" @click="page++;load()">下一页</button><button class="primary" :disabled="busy||!source||!target||source.id===target.id" @click="next">核对合并结果</button></div>
    </section>
    <section v-else class="panel">
     <fieldset :disabled="busy||!!preview"><legend>基本信息</legend><div v-for="field in fields" :key="field" class="field"><span>{{ labels[field] }}</span><FormSelect v-model="choices[field]" :aria-label="labels[field] + '保留方式'" :disabled="busy || !!preview" :options="[{ value: 'target', label: '保留：' + display(field,selection.target[field]) }, { value: 'source', label: '迁入：' + display(field,selection.source[field]) }]" /></div>
      <h3 class="permissions-title">本人账号关联</h3><p class="section-hint">选择合并后保留的本人账号。其他账号仅解除本人关联，不删除账号或报告；是否继续访问由下方授权决定。旧备份账号不可用时可暂不关联。</p><FormSelect v-model="selfUserId" aria-label="合并后本人账号" :disabled="busy || !!preview" :options="selfOptions" />
      <h3 class="permissions-title">最终访问权限</h3><p class="section-hint">勾选的账号将能访问合并后的全部报告；未勾选的账号不再保留访问权限。</p>
      <article v-for="g in grants" :key="g.userId" class="grant"><label><input v-model="g.included" type="checkbox" :disabled="!g.usable" />{{ g.displayName }} <small>{{ g.userId }}{{ selection.selfAccounts.some(a=>a.userId===g.userId)?' · 本人账号':'' }}{{ !g.usable?' · 账号不可用':'' }}</small><small>迁入档案：{{ selection.sourceAccounts.find(a=>a.userId===g.userId)?.permission==='manager'?'管理':selection.sourceAccounts.some(a=>a.userId===g.userId)?'查看':'无权限' }} · 保留档案：{{ selection.targetAccounts.find(a=>a.userId===g.userId)?.permission==='manager'?'管理':selection.targetAccounts.some(a=>a.userId===g.userId)?'查看':'无权限' }}</small></label><FormSelect v-model="g.permission" class="permission-select" :aria-label="g.displayName + '的访问权限'" :disabled="busy || !!preview || !g.included" :options="[{ value: 'viewer', label: '仅查看' }, { value: 'manager', label: '管理' }]" /><label class="sharing-option"><input v-model="g.canManageSharing" type="checkbox" :disabled="!g.included||g.permission!=='manager'" />允许管理共享</label></article>
     </fieldset>
     <div v-if="!preview" class="toolbar"><button :disabled="busy" @click="selection=null">重新选择</button><button class="primary" :disabled="busy" @click="preflight">生成确认预览</button></div>
     <div v-else class="confirmation"><h3>将迁入 {{ preview.reportCount }} 份报告</h3><p>{{ preview.warning }}</p><p>保留本人关联：{{ preview.selfResolution.retained ? `${preview.selfResolution.retained.displayName}（${preview.selfResolution.retained.userId}）` : '暂不关联' }}</p><p v-if="preview.selfResolution.released.length">解除本人关联：{{ preview.selfResolution.released.map(a=>`${a.displayName}（${a.userId}）`).join('、') }}。账号和报告不会删除。</p><dl><template v-for="field in fields" :key="field"><dt>{{ labels[field] }}</dt><dd>{{ display(field,preview.resolvedFields[field]) }}</dd></template></dl><p>执行前自动创建完整安全备份；有正在运行的任务时不会执行。备份及合并期间请勿关闭应用。</p><label class="confirm-check"><input v-model="confirmed" type="checkbox" :disabled="busy" />我确认是同一人的档案，并确认上述信息、本人账号关联和最终访问权限。</label><div class="toolbar"><button :disabled="busy" @click="preview=null;confirmed=false">返回修改</button><button class="primary" :disabled="busy||!confirmed" @click="execute">{{ busy?'正在备份并合并…':'确认合并' }}</button></div></div>
    </section>
   </template>
  </template>
 </section>
</template>
<style scoped>
.merge-page { display: grid; gap: 14px; font-size: 14px; line-height: 1.6; }
.panel { min-width: 0; padding: 18px; background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius-l, 14px); }
p { margin: 6px 0; color: var(--muted); font-size: 12px; line-height: 1.7; }
h3, legend { margin: 0; padding: 0; color: var(--ink); font-size: 16px; font-weight: 600; }
strong { font-size: 14px; font-weight: 600; }
small { color: var(--muted); font-size: 12px; }
.notice { display: flex; align-items: flex-start; gap: 9px; padding: 11px 14px; border-radius: 10px; background: var(--brand-soft); color: var(--brand-strong); }
.notice svg { flex-shrink: 0; margin-top: 2px; }
.notice p { margin: 0; color: inherit; }
.error { padding: 10px 12px; border-radius: 9px; background: color-mix(in srgb, var(--red, #b42318) 7%, var(--surface)); color: var(--red, #b42318); }
.direction { display: flex; align-items: center; gap: 12px; }
.direction-card { flex: 1; min-width: 0; padding: 12px 14px; border: 1px solid var(--line); border-radius: 10px; }
.target-card { background: color-mix(in srgb, var(--brand-soft) 45%, var(--surface)); }
.direction-card strong, .direction-card small, code { display: block; }
.direction-card strong { margin-top: 3px; }
.swap-button { flex: 0 0 42px; flex-direction: column; gap: 2px; width: 42px; min-height: 48px; padding: 5px 0; color: var(--brand-strong); }
.swap-button span { font-size: 12px; line-height: 1.4; }
code { margin-top: 3px; color: var(--muted); font-size: 12px; line-height: 1.5; overflow-wrap: anywhere; }
.toolbar, .actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.toolbar { margin-top: 16px; font-size: 12px; color: var(--muted); }
form.toolbar { margin-top: 0; margin-bottom: 8px; }
.toolbar input { flex: 1; min-width: 140px; }
.toolbar .primary { margin-left: auto; }
button, input:not([type=checkbox]) { min-height: 34px; padding: 7px 11px; border: 1px solid var(--line); border-radius: 8px; background: var(--surface); color: var(--ink); font: inherit; font-size: 14px; line-height: 1.5; }
button { display: inline-flex; align-items: center; justify-content: center; gap: 5px; cursor: pointer; transition: background .15s, border-color .15s; }
button:hover:not(:disabled) { background: var(--brand-soft); border-color: var(--brand); }
button:disabled { opacity: .45; cursor: not-allowed; }
button:focus-visible, input:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; }
.primary { background: var(--brand); border-color: var(--brand); color: #fff; font-weight: 600; }
.primary:hover:not(:disabled) { background: var(--brand-strong); color: #fff; }
button[aria-pressed=true] { background: var(--brand-soft); border-color: var(--brand); color: var(--brand-strong); }
.candidate { display: flex; align-items: center; justify-content: space-between; gap: 14px; padding: 14px 0; border-bottom: 1px solid var(--line); }
.candidate>div:first-child { min-width: 0; }
.candidate p { margin: 5px 0 0; font-size: 12px; }
.actions { flex-shrink: 0; }
fieldset { min-width: 0; padding: 0; margin: 0; border: 0; }
.field { display: grid; grid-template-columns: 90px minmax(0, 1fr); align-items: center; gap: 12px; padding: 7px 0; }
.field:first-of-type { margin-top: 8px; }
.field>span { color: var(--muted); font-size: 12px; }
.field .form-select { width: 100%; min-width: 0; }
:deep(.form-select-trigger) { height: 34px; min-height: 34px; padding: 0 11px; border-radius: 8px; font-size: 14px; }
.permissions-title { margin-top: 20px; padding-top: 18px; border-top: 1px solid var(--line); }
.section-hint { margin: 5px 0 8px; }
.grant { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; padding: 13px 0; border-bottom: 1px solid var(--line); font-size: 12px; }
.grant>label:first-child { flex: 1; min-width: 180px; font-weight: 500; }
.grant small { display: block; margin: 3px 0 0 23px; font-size: 12px; font-weight: 400; overflow-wrap: anywhere; }
.permission-select { width: 110px; flex-shrink: 0; }
.sharing-option, .confirm-check { display: flex; align-items: flex-start; gap: 7px; font-size: 12px; line-height: 1.7; }
input[type=checkbox] { width: 14px; height: 14px; margin: 3px 6px 0 0; vertical-align: top; accent-color: var(--brand); flex-shrink: 0; }
.confirmation { margin-top: 18px; padding: 16px; border: 1px solid color-mix(in srgb, var(--amber, #d97706) 25%, var(--line)); border-radius: 10px; background: color-mix(in srgb, var(--amber, #d97706) 4%, var(--surface)); }
.confirmation dl { display: grid; grid-template-columns: 90px minmax(0, 1fr); gap: 7px 12px; margin: 12px 0; padding: 12px 0; border-block: 1px solid var(--line); font-size: 12px; }
.confirmation dt { color: var(--muted); }
.confirmation dd { margin: 0; overflow-wrap: anywhere; }
.confirm-check { margin-top: 12px; }
@media (max-width: 760px), (pointer: coarse) {
 .direction {
  position: sticky;
  top: 8px;
  z-index: 10;
  align-self: start;
  box-shadow: var(--shadow-s);
 }
}
@media (max-width: 760px) {
 .direction { top: calc(58px + var(--safe-top, 0px) + 8px); }
}
@media(max-width:640px) {
 .merge-page { gap: 12px; }
 .panel { padding: 14px; }
 .direction { gap: 8px; }
 .direction-card { padding: 10px; }
 .candidate { flex-direction: column; align-items: stretch; gap: 10px; }
 .actions { display: grid; grid-template-columns: 1fr 1fr; }
 .toolbar .primary { width: 100%; margin-left: 0; }
 .field { grid-template-columns: 70px minmax(0, 1fr); gap: 8px; }
 .grant { gap: 10px; }
 .grant>label:first-child { flex-basis: 100%; }
 .permission-select { flex: 1; }
 .confirmation { padding: 12px; }
}
</style>
