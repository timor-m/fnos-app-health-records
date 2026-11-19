<script setup lang="ts">
import {computed,onBeforeUnmount,ref,watch} from 'vue';
import {RouterLink} from 'vue-router';
import {BellRing} from '@lucide/vue';
import {useAppContext} from '../composables/useAppContext';
import {useToast} from '../composables/useToast';
import {healthRecordPath} from '../utils/health-record-navigation';
import {request} from '../utils/api';
import type {Reminder} from '../types/api';
const props=defineProps<{memberId:string}>();const items=ref<Reminder[]>([]),loading=ref(false),error=ref('');let generation=0;
const app=useAppContext(),toast=useToast(),saving=ref('');
const canManage=computed(()=>app.selectedMemberId.value===props.memberId&&app.selectedMember.value?.permission==='manager');
function destination(item:Reminder){
 const process=item.processes?.[0];
 const record=item.relatedRecord||(item.vaccinationId?{kind:'vaccination' as const,id:item.vaccinationId}:item.reportId?{kind:'report' as const,id:item.reportId}:null);
 const path=process?'/health-processes/'+encodeURIComponent(process.id):record?healthRecordPath(record.kind,record.id):null;
 return path?{path,query:{memberId:props.memberId,returnTo:'/reminders'}}:null;
}
async function update(item:Reminder,status:Reminder['status']){
 if(!canManage.value||saving.value||item.memberId!==props.memberId)return;
 const member=props.memberId,token=generation;saving.value=item.id;error.value='';
 try{await request('reminders/'+encodeURIComponent(item.id),{method:'PUT',body:JSON.stringify({status})});app.notifyDataChanged();void app.refreshReminderCount(member);
 if(member!==props.memberId||token!==generation)return;await refresh();toast.show(status==='completed'?'已手工标记完成':status==='dismissed'?'提醒已忽略':'提醒已恢复');
 }catch(cause){if(member===props.memberId)error.value=cause instanceof Error?cause.message:'更新提醒失败';}
 finally{saving.value='';}
}
const pending=computed(()=>items.value.filter(item=>item.status==='pending').length);
async function refresh(){const token=++generation,member=props.memberId;if(!member){items.value=[];return true;}loading.value=true;error.value='';try{const result=await request<Reminder[]>(`reminders?memberId=${encodeURIComponent(member)}`);if(token!==generation||member!==props.memberId)return false;if(!Array.isArray(result)||result.some(item=>item.memberId!==member))throw Error('提醒与当前成员不一致，请重新加载');items.value=result;return true;}catch(cause){if(token===generation)error.value=cause instanceof Error?cause.message:'提醒加载失败';return false;}finally{if(token===generation)loading.value=false;}}
watch(()=>props.memberId,()=>{items.value=[];void refresh();},{immediate:true});onBeforeUnmount(()=>{generation++;});defineExpose({refresh});
</script>
<template><section class="reminder-inbox" aria-label="复查与待办"><header><h3>复查与待办</h3><span v-if="pending">{{pending}} 项待处理</span></header><p v-if="error" class="inline-panel-error" role="alert">{{error}} <button type="button" class="error-retry" @click="refresh">重新加载</button></p><p v-if="loading&&!items.length" class="reminder-inbox-state" role="status">正在读取提醒…</p><p v-else-if="!items.length&&!error" class="reminder-inbox-state">暂无复查与待办。</p><div v-if="items.length" class="data-list reminder-list"><article v-for="item in items" :key="item.id"><div class="reminder-card-head"><span class="item-icon"><BellRing :size="18"/></span><div class="reminder-card-main"><strong>{{item.title}}</strong><span>{{item.dueAt}} · {{item.vaccinationId?'下一剂接种':item.source==='report_suggestion'?'报告复查建议':'手工提醒'}}</span><small v-if="item.processes?.length">健康历程：{{item.processes.map(process=>process.title).join('、')}}</small><small v-else-if="item.reportTitle">来源：{{item.reportTitle}}</small></div></div><div class="reminder-card-footer"><span class="chip status-label" :class="item.status==='pending'?'chip--amber':item.status==='completed'?'chip--green':''">{{item.status==='pending'?'待处理':item.status==='completed'?'已完成':'已忽略'}}</span><div class="row-actions"><template v-if="canManage"><template v-if="item.status==='pending'"><button type="button" class="soft-action-button" :disabled="Boolean(saving)" @click="update(item,'completed')">手工标记完成</button><button type="button" class="soft-action-button" :disabled="Boolean(saving)" @click="update(item,'dismissed')">忽略</button></template><button v-else-if="!item.completedVaccinationId" type="button" class="soft-action-button" :disabled="Boolean(saving)" @click="update(item,'pending')">恢复待处理</button></template><RouterLink v-if="destination(item)" class="soft-action-button" :to="destination(item)!">查看来源</RouterLink></div></div></article></div></section></template>
<style scoped>
.reminder-inbox{margin:12px 0}.reminder-inbox>header{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:10px}.reminder-inbox h3{margin:0;font-size:16px;line-height:22px;font-weight:500}.reminder-inbox>header>span{font-size:12px;color:var(--muted)}.reminder-inbox-state{margin:0;font-size:14px;line-height:21px;color:var(--muted)}.reminder-inbox .reminder-card-main{min-width:0}.reminder-inbox .reminder-card-main strong{font-size:14px;overflow-wrap:anywhere}.reminder-inbox .reminder-card-main span,.reminder-inbox .reminder-card-main small{font-size:12px;overflow-wrap:anywhere}.reminder-inbox .reminder-card-footer{gap:8px;flex-wrap:wrap}.reminder-inbox .soft-action-button{font-size:12px;min-height:32px;flex-shrink:0}
</style>
