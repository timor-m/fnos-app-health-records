<script setup lang="ts">
import {computed, onBeforeUnmount, ref, watch} from 'vue';
import DateTimePicker from './DateTimePicker.vue';
import FormSelect from './FormSelect.vue';
import {request} from '../utils/api';
import {useUnsavedRecord} from '../composables/useUnsavedRecord';
import {createSubmissionKey} from '../utils/submission-key';
import type {Observation} from '../types/api';
import type {ExaminationRecord} from '../../../server/domain/examination';
const props=defineProps<{reportId:string;observation:Observation;canManage:boolean;busy?:boolean}>();
const emit=defineEmits<{updated:[]}>();
const editing=ref(false),saving=ref(false),loading=ref(false),error=ref('');
const time=ref<string | null>(null),includeTime=ref(false);
const disabled=computed(()=>Boolean(props.busy || saving.value));
const validTime=computed(()=>Boolean(time.value && (!includeTime.value || /T\d{2}:\d{2}/.test(time.value))));
const timeKinds=[{value:'sampledAt',label:'采样时间'},{value:'examinedAt',label:'检查时间'},{value:'issuedAt',label:'报告签发时间'}];
function toggleTime(event: Event){
 includeTime.value=(event.target as HTMLInputElement).checked;
 if(!includeTime.value && time.value)time.value=time.value.slice(0,10);
}
const kind=ref('examinedAt');
const leave=useUnsavedRecord(()=>editing.value?JSON.stringify([time.value,includeTime.value,kind.value]):'',saving);
const submissionKey=createSubmissionKey();
async function cancel(){if(await leave.confirmLeave()){editing.value=false;error.value='';leave.reset();}}
let generation=0;let alive=true;onBeforeUnmount(()=>{alive=false;generation++;});
let state:{version:number;reportVersion:number;examinations:ExaminationRecord[]}|undefined;
watch(()=>[props.reportId,props.observation.id,props.canManage],()=>{generation++;editing.value=false;state=undefined;loading.value=false;saving.value=false;error.value='';leave.reset();});
async function edit(){
 if(!props.canManage || props.busy || loading.value)return;
 const token=generation;loading.value=true;error.value='';
 try{
  const next=await request<typeof state>(`reports/${encodeURIComponent(props.reportId)}/examinations`);if(!alive||token!==generation)return;state=next;
  const exam=state?.examinations.find(item=>item.id===props.observation.examinationId);
  time.value=exam?.occurredAt?.replace(' ','T') || null;
  includeTime.value=Boolean(time.value?.includes('T'));
  kind.value=exam?.timeKind==='sampled'?'sampledAt':exam?.timeKind==='issued'?'issuedAt':'examinedAt';
  editing.value=true;leave.reset();submissionKey.reset();
 }catch(e){if(alive&&token===generation)error.value=e instanceof Error?e.message:'无法读取时间';}
 finally{if(token===generation)loading.value=false;}
}
async function save(){
 if(!state || !props.canManage || disabled.value)return;
 if(!validTime.value){error.value=includeTime.value?'请选择原件上的日期和时刻':'请选择原件上的日期';return;}
 const token=generation;saving.value=true;error.value='';
 const exam=state.examinations.find(item=>item.id===props.observation.examinationId);
 try{
  const body={
   version:state.version,reportVersion:state.reportVersion,
   observationIds:[props.observation.id],
   examination:{...exam,sampledAt:null,examinedAt:null,issuedAt:null,[kind.value]:time.value!.replace('T',' ')}
  };
  await request(`reports/${encodeURIComponent(props.reportId)}/examinations`,{method:'PUT',body:JSON.stringify({...body,requestKey:`time-${submissionKey.forRequest(props.reportId,body)}`})});
  if(!alive||token!==generation)return;editing.value=false;leave.reset();emit('updated');
 }catch(e){if(alive&&token===generation)error.value=e instanceof Error?e.message:'保存失败';}
 finally{if(token===generation)saving.value=false;}
}
</script>
<template>
 <div class="observation-time">
  <div class="observation-time-summary">
   <div class="observation-time-current">
    <span class="observation-time-label">指标时间</span>
    <span>{{ observation.examinationId ? observation.examinationTime || '检查时间待确认' : '沿用报告时间' }}</span>
   </div>
   <button v-if="canManage && !editing" class="soft-action-button" type="button" :disabled="busy || loading" @click="edit">{{ loading?'读取中…':'核对时间' }}</button>
  </div>
  <form v-if="editing && canManage" class="observation-time-form" @submit.prevent="save">
   <div class="observation-time-field">
    <span class="observation-time-label">时间来源</span>
    <FormSelect v-model="kind" :options="timeKinds" :disabled="disabled" aria-label="时间来源" />
   </div>
   <div class="observation-time-field">
    <span class="observation-time-label">原件上的日期或时间</span>
    <DateTimePicker v-model="time" :show-time="includeTime" :disabled="disabled" aria-label="原件上的日期或时间" />
   </div>
   <label class="observation-time-precision"><input type="checkbox" :checked="includeTime" :disabled="disabled" @change="toggleTime" />原件注明具体时刻</label>
   <p class="observation-time-hint">只调整当前指标。原件只有日期时，无需填写时刻。</p>
   <div class="observation-time-actions">
    <button class="soft-action-button" type="submit" :disabled="disabled || !validTime">{{saving?'保存中…':'保存时间'}}</button>
    <button class="soft-action-button" type="button" :disabled="saving" @click="cancel">取消</button>
   </div>
  </form>
  <p v-if="error" class="observation-time-error" role="alert">{{error}}</p>
 </div>
</template>
<style scoped>
.observation-time { flex-shrink: 0; min-width: 0; padding: 12px; border: 1px solid var(--line); border-radius: 12px; background: var(--surface); }
.observation-time-summary { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px; }
.observation-time-current { display: grid; min-width: 0; gap: 4px; color: var(--ink); font-size: 12px; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
.observation-time-label { color: var(--muted); font-size: 12px; font-weight: 600; }
.observation-time-form { display: grid; gap: 12px; margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--line); }
.observation-time-field { display: grid; min-width: 0; gap: 6px; }
.observation-time-precision { display: flex; align-items: center; gap: 8px; color: var(--ink-2); font-size: 12px; }
.observation-time-precision input { width: 16px; height: 16px; flex: 0 0 auto; margin: 0; accent-color: var(--brand); }
.observation-time-hint, .observation-time-error { margin: 0; font-size: 12px; line-height: 1.6; overflow-wrap: anywhere; }
.observation-time-hint { color: var(--muted); }
.observation-time-error { margin-top: 10px; color: var(--danger); }
.observation-time-actions { display: flex; flex-wrap: wrap; gap: 8px; }
</style>
