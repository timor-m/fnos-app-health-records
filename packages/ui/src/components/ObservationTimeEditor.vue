<script setup lang="ts">
import {ref} from 'vue';
import {request} from '../utils/api';
import type {Observation} from '../types/api';
import type {ExaminationRecord} from '../../../server/domain/examination';
const props=defineProps<{reportId:string;observation:Observation;canManage:boolean;busy?:boolean}>();
const emit=defineEmits<{updated:[]}>();
const editing=ref(false),saving=ref(false),loading=ref(false),error=ref(''),time=ref('');
const kind=ref('examinedAt');
let state:{version:number;reportVersion:number;examinations:ExaminationRecord[]}|undefined;
async function edit(){
 loading.value=true;error.value='';
 try{
  state=await request(`reports/${encodeURIComponent(props.reportId)}/examinations`);
  const exam=state?.examinations.find(item=>item.id===props.observation.examinationId);
  time.value=exam?.occurredAt || '';
  kind.value=exam?.timeKind==='sampled'?'sampledAt':exam?.timeKind==='issued'?'issuedAt':'examinedAt';
  editing.value=true;
 }catch(e){error.value=e instanceof Error?e.message:'无法读取时间';}
 finally{loading.value=false;}
}
async function save(){
 if(!state || !props.canManage || props.busy || saving.value)return;
 saving.value=true;error.value='';
 const exam=state.examinations.find(item=>item.id===props.observation.examinationId);
 try{
  await request(`reports/${encodeURIComponent(props.reportId)}/examinations`,{method:'PUT',body:JSON.stringify({
   version:state.version,reportVersion:state.reportVersion,requestKey:`time-${crypto.randomUUID()}`,
   observationIds:[props.observation.id],
   examination:{...exam,sampledAt:null,examinedAt:null,issuedAt:null,[kind.value]:time.value.trim()}
  })});
  editing.value=false;emit('updated');
 }catch(e){error.value=e instanceof Error?e.message:'保存失败';}
 finally{saving.value=false;}
}
</script>
<template>
 <div class="observation-time">
  <p>{{ observation.examinationId ? observation.examinationTime || '检查时间待确认' : '沿用报告时间' }}
   <button v-if="canManage && !editing" class="soft-action-button" type="button" :disabled="busy || loading" @click="edit">{{ loading?'读取中…':'核对时间' }}</button>
  </p>
  <form v-if="editing && canManage" @submit.prevent="save">
   <label>时间来源<select v-model="kind"><option value="sampledAt">采样时间</option><option value="examinedAt">检查时间</option><option value="issuedAt">报告签发时间</option></select></label>
   <label>原件上的日期或时间<input v-model="time" required placeholder="2026-09-01 或 2026-09-01 08:30" /></label>
   <small>只调整当前指标，不改变其他指标。原件只有日期时，无需填写时刻。</small>
   <div><button class="soft-action-button" type="submit" :disabled="busy || saving">{{saving?'保存中…':'保存时间'}}</button><button class="soft-action-button" type="button" :disabled="saving" @click="editing=false">取消</button></div>
  </form>
  <p v-if="error" role="alert">{{error}}</p>
 </div>
</template>
<style scoped>
.observation-time {padding:.75rem 1rem;border-bottom:1px solid var(--line);}
p {display:flex;align-items:center;justify-content:space-between;gap:.5rem;margin:0;flex-wrap:wrap;font-size:.85rem;color:var(--ink-2);}
form {display:grid;gap:.75rem;margin-top:.75rem;}label {display:grid;gap:.35rem;font-size:.85rem;}input,select {width:100%;min-width:0;}small {color:var(--ink-2);line-height:1.5;}form>div {display:flex;gap:.5rem;}
</style>
