<script setup lang="ts">
import type {HealthProcessActivity} from '../../../shared/health-process-activity';
import {initialProcessActivity} from '../utils/health-process-activity';
import RecordLoading from './RecordLoading.vue';
import {computed,nextTick,onActivated,onBeforeUnmount,onDeactivated,ref,watch} from 'vue';
import {RouterLink,useRoute} from 'vue-router';
import type {HealthProcessDetail} from '../../../shared/health-process';
import type {HealthObservation,ObservationCategory,ObservationPage,ObservationRef} from '../../../shared/health-observations';
import type {HealthRecordRef} from '../../../shared/health-record-associations';
import {useAppContext} from '../composables/useAppContext';
import {request} from '../utils/api';
import {formatMedicationDate} from '../utils/medication-date';
import {healthRecordPath} from '../utils/health-record-navigation';
import {observationDescription} from '../utils/health-observation';
import ObservationEditorModal from './ObservationEditorModal.vue';
import ObservationReceipt from './ObservationReceipt.vue';
const props=defineProps<{initialLoad?:Promise<HealthProcessActivity>;process:HealthProcessDetail;disabled?:boolean}>();
const emit=defineEmits<{updated:[];openRecord:[record:HealthRecordRef,event:MouseEvent]}>();const app=useAppContext(),route=useRoute();
const root=ref<HTMLElement|null>(null),items=ref<HealthObservation[]>([]),filter=ref<'all'|ObservationCategory>('all');
const counts=ref({symptom:0,temperature:0,intake:0}),cursor=ref<string|null>(null),loading=ref(false),loaded=ref(false),error=ref(''),active=ref(true);
const editing=ref<ObservationRef|null>(null),receipt=ref<HealthObservation|null>(null),opener=ref<HTMLElement|null>(null);let generation=0;
const visible=computed(()=>active.value&&props.process.memberId===app.selectedMemberId.value);
const canManage=computed(()=>visible.value&&app.selectedMember.value?.permission==='manager');
const total=computed(()=>counts.value.symptom+counts.value.temperature+counts.value.intake);
const filters=computed(()=>[{value:'all' as const,label:'全部',count:counts.value.symptom+counts.value.temperature+counts.value.intake},{value:'symptom' as const,label:'症状',count:counts.value.symptom},{value:'temperature' as const,label:'体温',count:counts.value.temperature},{value:'intake' as const,label:'服药',count:counts.value.intake}]);
function validate(page:ObservationPage){if(page.processId!==props.process.id||page.memberId!==props.process.memberId||!Array.isArray(page.items)||page.items.some(entry=>entry.memberId!==props.process.memberId)||!page.counts)throw Error('明细与当前历程不一致');}
async function load(more=false,initial=false){
 if(!visible.value||more&&(loading.value||!cursor.value))return;const token=++generation,id=props.process.id,member=props.process.memberId,kind=filter.value;const keep=more?0:items.value.length;loading.value=true;error.value='';
 const valid=()=>token===generation&&visible.value&&props.process.id===id&&props.process.memberId===member&&filter.value===kind;
 const read=(after?:string)=>request<ObservationPage>(`health-processes/${encodeURIComponent(id)}/observations?${new URLSearchParams({kind,limit:'10',...(after?{cursor:after}:{})})}`);
 try{let page=(initial&&props.initialLoad?await initialProcessActivity(props.initialLoad,props.process,'observations'):undefined)??await read(more?cursor.value!:undefined);if(!valid())return;validate(page);let next=page.items;const visited=new Set<string>();
  while(!more&&page.nextCursor&&next.length<keep){if(visited.has(page.nextCursor))throw Error('明细分页异常，请刷新重试');visited.add(page.nextCursor);page=await read(page.nextCursor);if(!valid())return;validate(page);next.push(...page.items);}
  items.value=more?[...new Map([...items.value,...next].map(entry=>[entry.ref.kind+':'+entry.ref.id,entry])).values()]:next;counts.value=page.counts;cursor.value=page.nextCursor;loaded.value=true;
 }catch(cause){if(valid())error.value=cause instanceof Error?cause.message:'变化明细加载失败';}finally{if(token===generation)loading.value=false;}
}
function choose(value:typeof filter.value){if(value===filter.value)return;filter.value=value;items.value=[];cursor.value=null;loaded.value=false;void load();}
function edit(entry:HealthObservation,event:MouseEvent){if(canManage.value&&!props.disabled){opener.value=event.currentTarget as HTMLElement;editing.value=entry.ref;}}
function editReceipt(ref:ObservationRef,event:MouseEvent){opener.value=event.currentTarget as HTMLElement;editing.value=ref;}
function close(){editing.value=null;void nextTick(()=>opener.value?.focus({preventScroll:true}));}
function saved(entry:HealthObservation){editing.value=null;receipt.value=entry;emit('updated');void load();void nextTick(()=>root.value?.querySelector<HTMLButtonElement>('.observation-receipt button')?.focus({preventScroll:true}));}
watch(()=>JSON.stringify([props.process.id,props.process.memberId,app.selectedMemberId.value]),()=>{generation++;items.value=[];counts.value={symptom:0,temperature:0,intake:0};cursor.value=null;loaded.value=false;error.value='';editing.value=null;receipt.value=null;filter.value='all';void load(false,true);},{immediate:true,flush:'sync'});
watch(()=>[props.process.id,props.process.memberId,app.selectedMemberId.value,props.process.fingerprint],(current,previous)=>{if(current.slice(0,3).every((value,index)=>value===previous[index]))void load();});watch(canManage,value=>{if(!value)editing.value=null;});
onActivated(()=>{if(!active.value){active.value=true;void load();}});onDeactivated(()=>{active.value=false;generation++;editing.value=null;loading.value=false;});onBeforeUnmount(()=>{active.value=false;generation++;});
</script>
<template><section v-if="visible&&(!loaded||error||total>0||receipt)" ref="root" class="process-observations settings-band" aria-label="变化明细"><header><h3>变化明细</h3><span>按实际记录时间</span></header>
 <div class="observation-filters" role="group" aria-label="变化明细类型" data-pull-refresh-ignore><button v-for="item in filters" :key="item.value" type="button" :aria-pressed="filter===item.value" @click="choose(item.value)">{{item.label}}<small>{{item.count}}</small></button></div>
 <div class="observation-content"><ObservationReceipt v-if="receipt" :record="receipt.ref" :label="receipt.name+' '+observationDescription(receipt)" :recorded-at="receipt.recordedAt" :disabled="disabled||!canManage" @edit="editReceipt"/>
 <RecordLoading v-if="loading&&!loaded" label="正在读取变化明细…"/><p v-if="error" class="inline-panel-error" role="alert">{{error}} <button type="button" class="error-retry" :disabled="loading" @click="load()">重试</button></p>
 <ol v-if="items.length" class="observation-list"><li v-for="entry in items" :key="entry.ref.kind+entry.ref.id"><div class="observation-heading"><strong>{{entry.name}}</strong><button v-if="canManage" type="button" data-observation-edit :disabled="disabled||loading" @click="edit(entry,$event)">修改</button></div><p class="observation-value">{{observationDescription(entry)}}</p><p v-if="entry.description" class="observation-note">{{entry.description}}</p><div class="observation-footer"><time>{{formatMedicationDate(entry.recordedAt)}}</time><RouterLink :to="{path:healthRecordPath(entry.record.kind,entry.record.id),query:{returnTo:route.fullPath}}" @click.capture="emit('openRecord',entry.record,$event)">查看{{entry.ref.kind==='intake'?'服药记录':'症状'}}</RouterLink></div></li></ol>
 <p v-else-if="loaded&&!loading&&!error" class="observation-state">{{filter==='all'?'还没有变化明细，可在上方快速记录中补记。':'暂无这类变化明细。'}}</p><button v-if="cursor" type="button" class="soft-action-button observation-more" :disabled="loading" @click="load(true)">{{loading?'正在加载…':'加载更多'}}</button></div>
 <ObservationEditorModal v-if="editing&&canManage" :key="editing.kind+editing.id" :member-id="process.memberId" :process-id="process.id" :target="editing" :return-focus="opener" @close="close" @saved="saved"/>
 </section></template>
<style scoped>
.process-observations{min-width:0;margin-bottom:14px;box-shadow:none}.process-observations>header{display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:44px;padding:10px 12px}.process-observations h3{margin:0;font-size:16px;font-weight:500}.process-observations>header>span{font-size:12px;color:var(--muted)}.observation-filters{display:flex;align-items:center;gap:4px;overflow-x:auto;overflow-y:hidden;touch-action:pan-x pinch-zoom;overscroll-behavior-x:contain;padding:4px 12px;scrollbar-width:none}.observation-filters button{display:inline-flex;align-items:center;flex:0 0 auto;gap:4px;min-height:28px;padding:4px 9px;border:1px solid transparent;border-radius:999px;background:var(--fill-2);color:var(--muted);font:inherit;font-size:12px;line-height:18px}.observation-filters button[aria-pressed=true]{border-color:var(--brand);color:var(--brand-strong);background:var(--brand-soft)}.observation-filters small{font-size:12px;font-variant-numeric:tabular-nums}.observation-content{display:grid;gap:10px;padding:8px 12px 12px;min-width:0}.observation-list{list-style:none;display:grid;gap:0;margin:0;padding:0}.observation-list>li{min-width:0;padding:8px 0}.observation-list>li+li{border-top:1px solid var(--line)}.observation-heading{display:flex;align-items:center;justify-content:space-between;gap:8px}.observation-heading strong{font-size:14px;font-weight:500;min-width:0;overflow-wrap:anywhere}.observation-heading button{flex-shrink:0;min-height:28px;border:0;padding:3px 6px;background:transparent;color:var(--brand-strong);font-size:12px}.observation-value,.observation-note{margin:3px 0 0;font-size:14px;line-height:21px;overflow-wrap:anywhere}.observation-note{white-space:pre-wrap;font-size:14px;color:var(--ink-2)}.observation-footer{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;margin-top:4px;font-size:12px;color:var(--muted)}.observation-footer a{color:var(--brand-strong)}.observation-state{margin:0;color:var(--muted);font-size:14px;line-height:20px}.observation-more{justify-self:center;font-size:12px;min-height:32px}.process-observations button:focus-visible,.process-observations a:focus-visible{outline:2px solid var(--brand);outline-offset:2px}
</style>
