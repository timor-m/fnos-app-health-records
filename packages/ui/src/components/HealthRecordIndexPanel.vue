<script setup lang="ts">
import '../styles/process-list-filters.css';
import {Search} from '@lucide/vue';
import {computed,onActivated,onDeactivated,onBeforeUnmount,ref,watch} from 'vue';
import {RouterLink,useRoute,useRouter} from 'vue-router';
import RecordLoading from './RecordLoading.vue';
import HealthProcessCard from './HealthProcessCard.vue';
import {request} from '../utils/api';
import {healthRecordPath} from '../utils/health-record-navigation';
import {formatMedicationDate} from '../utils/medication-date';
import type {HealthRecordIndexPage,HealthIndexKind} from '../../../shared/health-record-index';
const props=defineProps<{memberId:string}>();const route=useRoute(),router=useRouter();
const kind=computed<HealthIndexKind>(()=>route.query.indexKind==='symptom'?'symptom':'diagnosis');
const name=computed(()=>typeof route.query.indexName==='string'?route.query.indexName:'');
const query=computed({get:()=>typeof route.query.indexQuery==='string'?route.query.indexQuery:'',set:value=>navigate({indexQuery:value||undefined,indexName:undefined})});
const page=ref<HealthRecordIndexPage|null>(null);const busy=ref(false),error=ref('');let generation=0,active=true;let timer:ReturnType<typeof setTimeout>|undefined;
function navigate(values:Record<string,string|undefined>){void router.replace({path:'/health-processes',query:{...route.query,view:'index',...values}});}
async function load(more=false){
 if(!active||!props.memberId||more&&!page.value?.nextCursor)return;
 const token=++generation,member=props.memberId;busy.value=true;error.value='';
 const params=new URLSearchParams({memberId:member,kind:kind.value,q:query.value,name:name.value,limit:'40'});if(more&&page.value?.nextCursor)params.set('cursor',page.value.nextCursor);
 try{const next=await request<HealthRecordIndexPage>(`health-record-index?${params}`);if(token!==generation||member!==props.memberId||!active)return;
  if(next.memberId!==member||next.kind!==kind.value||!Array.isArray(next.entries)||!Array.isArray(next.records)||!Array.isArray(next.processes)||next.processes.some(p=>p.memberId!==member))throw Error('索引数据与当前成员不一致');
  if(more&&page.value)page.value={...next,entries:[...new Map([...page.value.entries,...next.entries].map(item=>[item.key,item])).values()],records:[...new Map([...page.value.records,...next.records].map(item=>[item.ref.kind+':'+item.ref.id,item])).values()],processes:[...new Map([...page.value.processes,...next.processes].map(item=>[item.id,item])).values()]};else page.value=next;
 }catch(cause){if(token===generation)error.value=cause instanceof Error?cause.message:'读取索引失败';}finally{if(token===generation)busy.value=false;}
}
watch(()=>props.memberId,(next,previous)=>{if(active&&route.path==='/health-processes'&&previous&&next!==previous)navigate({indexName:undefined,indexQuery:undefined});});
watch(()=>[props.memberId,kind.value,name.value,query.value],()=>{generation++;page.value=null;error.value='';clearTimeout(timer);busy.value=true;timer=setTimeout(()=>void load(),200);},{immediate:true});
onDeactivated(()=>{active=false;generation++;clearTimeout(timer);busy.value=false;});onActivated(()=>{if(!active){active=true;void load();}});onBeforeUnmount(()=>{active=false;generation++;clearTimeout(timer);});
</script>
<template>
 <section class="health-index-panel" aria-label="疾病与症状索引">
  <div class="health-index-tabs process-filter-row process-filter-secondary" role="group" aria-label="索引类型"><button v-for="item in [{value:'diagnosis',label:'报告诊断'},{value:'symptom',label:'自述症状'}]" :key="item.value" type="button" :aria-pressed="kind===item.value" @click="navigate({indexKind:item.value,indexName:undefined})">{{item.label}}</button></div>
  <label v-if="!name" class="health-index-search"><Search :size="16" aria-hidden="true"/><input v-model="query" type="search" maxlength="200" placeholder="搜索名称" aria-label="搜索诊断或症状"/></label>
  <div v-else class="health-index-heading"><button type="button" class="soft-action-button" @click="navigate({indexName:undefined})">返回索引</button><h3>{{name}}</h3></div>
  <p class="health-index-hint">{{kind==='diagnosis'?'报告诊断历史，不代表当前仍患有该疾病。':'已记录的症状历史，不将症状视为诊断。'}}</p>
  <RecordLoading v-if="busy&&!page" label="正在读取索引…"/>
  <p v-if="error" class="inline-panel-error" role="alert">{{error}} <button type="button" class="error-retry" :disabled="busy" @click="load()">重试</button></p>
  <template v-if="page">
   <p class="health-index-hint">{{name?`共 ${page.total} 条原始记录`:`共 ${page.total} 个条目`}}</p>
   <div v-if="!name" class="health-index-grid"><button v-for="item in page.entries" :key="item.key" type="button" @click="navigate({indexName:item.name})"><strong>{{item.name}}</strong><span>{{item.count}} 条记录<template v-if="item.lastAt"> · {{formatMedicationDate(item.lastAt)}}</template></span></button></div>
   <template v-else><div class="health-index-records"><RouterLink v-for="record in page.records" :key="record.ref.kind+record.ref.id" :to="{path:healthRecordPath(record.ref.kind,record.ref.id),query:{returnTo:route.fullPath}}"><strong>{{record.title}}</strong><span>{{formatMedicationDate(record.latestDate)||'日期未记录'}}<template v-if="record.institution"> · {{record.institution}}</template></span><p v-if="record.description">{{record.description}}</p><p v-if="record.medications?.length">报告所列用药：{{record.medications.join('、')}}（不代表已服用）</p></RouterLink></div><section v-if="page.processes.length"><h3>相关健康历程</h3><HealthProcessCard v-for="process in page.processes" :key="process.id" :process="process" :return-to="route.fullPath"/></section></template>
   <p v-if="!page.total&&!busy" class="health-index-hint">暂无匹配记录，可先记录症状或上传报告。</p>
   <button v-if="page.nextCursor" type="button" class="soft-action-button" :disabled="busy" @click="load(true)">{{busy?'正在加载…':'加载更多'}}</button>
  </template>
 </section>
</template>
<style scoped>
.health-index-panel{display:grid;gap:6px;min-width:0}.health-index-hint{margin:0;font-size:12px;line-height:17px;color:var(--muted)}.health-index-search{display:flex;align-items:center;gap:6px;min-width:0;padding:5px 10px;border:1px solid var(--line-strong);border-radius:var(--radius-s);background:var(--surface);color:var(--muted)}.health-index-search:focus-within{border-color:var(--brand);outline:2px solid var(--brand-soft)}.health-index-search>svg{flex-shrink:0}.health-index-search input{width:100%;min-width:0;padding:0;border:0;border-radius:0;background:transparent;color:var(--ink);font:inherit;font-size:14px;line-height:20px;outline:none;box-shadow:none}.health-index-heading{display:flex;gap:10px;align-items:center;min-width:0}.health-index-panel h3{margin:0;font-size:16px;overflow-wrap:anywhere}.health-index-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(180px,100%),1fr));gap:8px}.health-index-grid button,.health-index-records>a{display:grid;gap:5px;padding:12px;border:1px solid var(--line);border-radius:10px;background:var(--surface);text-align:left;text-decoration:none;color:var(--ink);min-width:0;overflow-wrap:anywhere}.health-index-grid strong,.health-index-records strong{font-size:14px;font-weight:500}.health-index-grid span,.health-index-records span{font-size:12px;color:var(--muted)}.health-index-records{display:grid;gap:8px}.health-index-records p{margin:0;font-size:14px;line-height:20px}.health-index-panel button:focus-visible,.health-index-panel a:focus-visible{outline:2px solid var(--brand);outline-offset:2px}
</style>
