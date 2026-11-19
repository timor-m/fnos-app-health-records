<script setup lang="ts">
import { computed,onBeforeUnmount,ref,watch } from 'vue';
import { Upload,LoaderCircle,Paperclip } from '@lucide/vue';
import type { VaccinationEntry } from '../../../shared/health-categories';
import { useAppContext } from '../composables/useAppContext';
import { useUnsavedRecord } from '../composables/useUnsavedRecord';
import { requestUpload } from '../utils/api';
import { createSubmissionKey } from '../utils/submission-key';
import { createUuid } from '../utils/uuid';
import { vaccinationAttachmentError } from '../utils/vaccination-attachments';
const props=defineProps<{entry:VaccinationEntry;disabled?:boolean}>();
const emit=defineEmits<{saved:[entry:VaccinationEntry];busy:[value:boolean]}>();
const app=useAppContext();const input=ref<HTMLInputElement|null>(null);const files=ref<Array<{id:string;file:File}>>([]);
const busy=ref(false);const progress=ref(0);const error=ref('');const key=createSubmissionKey();let generation=0;let alive=true;
const canManage=computed(()=>props.entry.memberId===app.selectedMemberId.value&&app.selectedMember.value?.permission==='manager');
const leave=useUnsavedRecord(()=>JSON.stringify(files.value.map(item=>item.id)),busy);
watch(()=>[props.entry.id,props.entry.revision,app.selectedMemberId.value],()=>{generation++;files.value=[];error.value='';busy.value=false;progress.value=0;key.reset();leave.reset();emit('busy',false);},{flush:'sync'});
async function pick(event:Event) {
 const target=event.target as HTMLInputElement;const selected=Array.from(target.files||[]);target.value='';
 if(!selected.length||busy.value||props.disabled||!canManage.value)return;
 error.value=vaccinationAttachmentError(selected);if(error.value)return;
 files.value=selected.map(file=>({id:createUuid(),file}));await upload();
}
async function upload(){
 if(busy.value||props.disabled||!canManage.value||!files.value.length)return;
 const entry=props.entry;const token=generation;busy.value=true;progress.value=0;error.value='';emit('busy',true);
 try{
  const payload={id:entry.id,memberId:entry.memberId,revision:entry.revision};
  const body=new FormData();body.append('payload',JSON.stringify({...payload,requestKey:key.forRequest('vaccination.original.save',{...payload,files:files.value.map(item=>item.id)})}));
  for(const item of files.value)body.append('files',item.file,item.file.name);
  const saved=await requestUpload<VaccinationEntry>('vaccinations/with-original',body,percent=>{if(alive&&token===generation)progress.value=percent;});
  if(!alive||token!==generation||!canManage.value)return;
  if(saved.id!==entry.id||saved.memberId!==entry.memberId||!saved.sourceReportId)throw Error('附件保存结果不一致，请刷新后查看');
  busy.value=false;files.value=[];leave.reset();emit('busy',false);app.notifyDataChanged();emit('saved',saved);
 }catch(cause){if(alive&&token===generation)error.value=cause instanceof Error?cause.message:'附件上传失败，请重试';}
 finally{if(alive&&token===generation){busy.value=false;emit('busy',false);}}
}
onBeforeUnmount(()=>{alive=false;generation++;emit('busy',false);});
</script>
<template>
 <article class="preview-card originals-card vaccination-original-upload" aria-label="原件附件">
  <div class="section-title-row originals-toolbar originals-toolbar--attachments"><div><h4>原件附件</h4><p>支持图片、PDF，单文件不超过 40 MB</p></div><button v-if="canManage" type="button" class="soft-action-button" :disabled="busy||disabled" @click="input?.click()"><LoaderCircle v-if="busy" :size="15" class="spin-icon"/><Upload v-else :size="15"/>{{busy?`上传中 ${progress}%`:'上传附件'}}</button></div>
  <input ref="input" type="file" accept=".jpg,.jpeg,.png,.webp,.heic,.heif,.pdf,image/jpeg,image/png,image/webp,image/heic,image/heif,application/pdf" multiple hidden aria-label="选择接种附件" @change="pick"/>
  <ul v-if="files.length"><li v-for="item in files" :key="item.id"><Paperclip :size="14"/><span>{{item.file.name}}</span></li></ul>
  <p v-if="busy" class="preview-hint" role="status">{{progress<100?'正在上传附件…':'正在保存附件…'}}</p>
  <p v-else-if="!error" class="preview-hint">暂无原件附件</p>
  <p v-if="error" class="inline-panel-error" role="alert">{{error}} <button v-if="files.length&&canManage" type="button" class="vaccination-inline-action" :disabled="disabled" @click="upload">重试上传</button></p>
 </article>
</template>
<style scoped>
.vaccination-original-upload input[hidden] { display:none; }
.vaccination-original-upload ul { display:grid;gap:6px;margin:10px 0;padding:0;list-style:none; }
.vaccination-original-upload li { display:flex;gap:6px;align-items:center;min-width:0;font-size:12px;color:var(--ink-2); }
.vaccination-original-upload li>svg { flex:0 0 auto;color:var(--muted); }
.vaccination-original-upload li>span { min-width:0;overflow-wrap:anywhere; }
</style>
