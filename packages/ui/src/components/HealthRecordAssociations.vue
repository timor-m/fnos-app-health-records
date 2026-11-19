<script setup lang="ts">
import { computed, onActivated, onBeforeUnmount, onDeactivated, ref, watch } from 'vue';
import { RouterLink, useRoute } from 'vue-router';
import { ArrowRight, Route } from '@lucide/vue';
import HealthRecordAssociationModal from './HealthRecordAssociationModal.vue';
import type { AssociationSubject, HealthRecordRef, RecordAssociation } from '../../../shared/health-record-associations';
import { useAppContext } from '../composables/useAppContext';
import { request } from '../utils/api';
import { formatMedicationDate } from '../utils/medication-date';
import { createSubmissionKey } from '../utils/submission-key';
const props=defineProps<{subject:AssociationSubject;memberId:string;compact?:boolean;openInPlace?:boolean}>();
const emit=defineEmits<{updated:[];openRecord:[record:HealthRecordRef]}>();
const app=useAppContext();const route=useRoute();const value=ref<RecordAssociation|null>(null);const error=ref('');const loading=ref(false);const busy=ref(false);
const active=ref(true);const editing=ref(false);let generation=0;
const associateButton=ref<HTMLElement|null>(null);
const writable=computed(()=>props.memberId===app.selectedMemberId.value&&app.selectedMember.value?.permission==='manager');
const scope=computed(()=>JSON.stringify([props.subject,props.memberId,app.selectedMemberId.value]));
const key=createSubmissionKey();
async function load(preserve=false){if(!active.value)return;const token=++generation;if(!preserve)value.value=null;error.value='';loading.value=true;
 try{const next=await request<RecordAssociation>(`health-records/associations?${new URLSearchParams({kind:props.subject.kind,id:props.subject.id})}`);
  if(token!==generation)return;if(!next||next.memberId!==props.memberId||props.memberId!==app.selectedMemberId.value)throw Error('关联信息不属于当前成员');
  if(!Array.isArray(next.processes)||!Array.isArray(next.records)||!Array.isArray(next.evidence))throw Error('关联数据无效，请刷新重试');value.value=next;
 }catch(cause){if(token===generation)error.value=cause instanceof Error?cause.message:'关联读取失败';}finally{if(token===generation)loading.value=false;}}
function open(){if(editing.value||!writable.value||busy.value||!value.value||value.value.processes.length)return;error.value='';editing.value=true;key.reset();}
async function save(records:HealthRecordRef[]){if(!active.value||!writable.value||busy.value||!records.length)return;
 const token=generation;const body={subject:props.subject,records,action:'attach'};busy.value=true;error.value='';
 try{const next=await request<RecordAssociation>('health-records/associations',{method:'POST',body:JSON.stringify({...body,requestKey:key.forRequest('association',body)})});
  if(token!==generation)return;
  if(!next||next.memberId!==props.memberId||!writable.value||next.subject?.id!==props.subject.id||!Array.isArray(next.processes)||!Array.isArray(next.records)||!Array.isArray(next.evidence))throw Error('关联保存结果无效，请刷新后核对');
  value.value=next;editing.value=false;busy.value=false;app.notifyDataChanged();emit('updated');
 }catch(cause){if(token===generation)error.value=cause instanceof Error?cause.message:'保存关联失败';}finally{if(token===generation)busy.value=false;}}
watch(()=>app.dataVersion?.value,()=>{if(!editing.value)void load(true);});
watch(scope,()=>{editing.value=false;busy.value=false;void load();},{immediate:true,flush:'sync'});
watch(writable,allowed=>{if(!allowed)editing.value=false;});
onDeactivated(()=>{active.value=false;editing.value=false;busy.value=false;loading.value=false;generation++;});
onActivated(()=>{if(!active.value){active.value=true;void load(true);}});
onBeforeUnmount(()=>{generation++;});
</script>
<template>
 <section class="health-record-associations" :class="{'is-compact':compact}" aria-label="所属健康历程">
  <header><h4>健康历程</h4><button v-if="writable&&!value?.processes.length" ref="associateButton" type="button" class="soft-action-button" :disabled="busy||!value" @click="open">关联历程</button></header>
  <p v-if="loading&&!value" role="status" class="association-hint">正在读取关联…</p>
  <p v-if="error&&!editing" role="alert" class="inline-panel-error">{{error}} <button type="button" class="error-retry" @click="load(!!value)">重试</button></p>
  <template v-if="value">
   <RouterLink v-for="process in value.processes" :key="process.id" class="association-process-entry" :to="{path:`/health-processes/${encodeURIComponent(process.id)}`,query:{returnTo:route.fullPath}}">
    <Route :size="18"/><span><strong>{{process.title}}</strong><small><template v-if="process.recordCount">{{process.recordCount}} 条记录 · </template><span class="association-process-date">{{formatMedicationDate(process.startedAt)||'日期未记录'}}</span><template v-if="process.latestAt&&process.latestAt!==process.startedAt"> ～ <span class="association-process-date">{{formatMedicationDate(process.latestAt)}}</span></template></small></span><span class="association-process-open">查看历程<ArrowRight :size="14"/></span>
   </RouterLink>
   <p v-if="!value.processes.length" class="association-hint">选择同一健康事项的相关记录，形成或加入健康历程。</p>

  </template>
 </section>
 <HealthRecordAssociationModal v-if="editing&&value" :member-id="memberId" :subject="subject" :exclude="value.records.map(item=>({kind:item.entry.kind,id:item.entry.resourceId}))" :busy="busy" :error="error" :return-focus="associateButton" @close="editing=false;error=''" @confirm="save($event)"/>
</template>
<style scoped>
.health-record-associations{display:grid;gap:10px;min-width:0;width:100%;padding-top:12px;border-top:1px solid var(--line)}.health-record-associations>header{display:flex;align-items:center;justify-content:space-between;gap:10px}.health-record-associations h4{margin:0;font-size:16px;font-weight:500;line-height:22px}.health-record-associations>header button{min-height:32px;padding:5px 10px;font-size:12px;line-height:20px}.association-hint,.association-process-entry{display:flex;align-items:center;gap:8px;min-width:0;padding:10px;background:var(--brand-softer);border:1px solid var(--line);border-radius:var(--radius-s);color:var(--ink);text-decoration:none}.association-process-entry>svg{color:var(--brand-strong);flex-shrink:0}.association-process-entry>span:first-of-type{display:grid;gap:3px;min-width:0;flex:1}.association-process-entry strong{font-size:14px;font-weight:500;overflow-wrap:anywhere}.association-process-entry small{font-size:12px;line-height:18px;color:var(--muted)}.association-process-date{white-space:nowrap}.association-process-open{display:flex;align-items:center;gap:3px;flex-shrink:0;font-size:12px;color:var(--brand-strong)}.health-record-associations button:focus-visible,.health-record-associations a:focus-visible{outline:2px solid var(--brand);outline-offset:2px}@media(max-width:760px),(pointer:coarse){.association-process-entry{padding:8px}.association-process-open{font-size:12px}}
</style>
