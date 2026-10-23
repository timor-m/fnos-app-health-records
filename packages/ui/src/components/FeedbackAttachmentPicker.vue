<script setup lang="ts">
import {computed,onBeforeUnmount,onDeactivated,ref,watch} from 'vue';
import {FileText,ImagePlus,X} from '@lucide/vue';
import FeedbackImageEditor from './FeedbackImageEditor.vue';
const files=defineModel<File[]>({required:true});
defineProps<{disabled?:boolean}>();
const emit=defineEmits<{editing:[value:boolean]}>();
const urls=new Map<File,string>();
const expandedImage=ref<string|null>(null);
const editingImage=ref<{file:File;url:string}|null>(null);
const imageInput=ref<HTMLInputElement|null>(null);
const attachmentError=ref('');
const previews=computed(()=>files.value.map(file=>({file,url:urls.get(file)!})));
watch(files,()=>{
  if(!files.value.length) attachmentError.value='';
  for(const [file,url] of urls) if(!files.value.includes(file)) {
    URL.revokeObjectURL(url);urls.delete(file);
    if(expandedImage.value===url) expandedImage.value=null;
  }
  for(const file of files.value) if(!urls.has(file)) urls.set(file,URL.createObjectURL(file));
},{immediate:true,flush:'sync'});
watch(editingImage,value=>emit('editing',Boolean(value)),{flush:'sync'});
onDeactivated(()=>{editingImage.value=null;expandedImage.value=null;});
onBeforeUnmount(()=>{for(const url of urls.values()) URL.revokeObjectURL(url);emit('editing',false);});
function addImages(event:Event){
  const input=event.target as HTMLInputElement;
  const errors:string[]=[];const added:File[]=[];
  for(const file of Array.from(input.files||[])){
    if(!['image/jpeg','image/png','image/webp','application/pdf'].includes(file.type)){errors.push('仅支持 JPG、PNG、WebP 图片和 PDF');continue;}
    if(!file.size||file.size>10*1024*1024){errors.push('单个附件需大于 0 且不超过 10 MB');continue;}
    added.push(file);
  }
  files.value=[...files.value,...added];attachmentError.value=[...new Set(errors)].join('；');input.value='';
}
function removeImage(index:number){files.value=files.value.filter((_,i)=>i!==index);attachmentError.value='';}
function saveEditedImage(file:File){
  const original=editingImage.value?.file;
  files.value=files.value.map(value=>value===original?file:value);editingImage.value=null;
}
</script>
<template>
        <section class="attachment-section" aria-label="问题附件">
          <div class="attachment-heading"><h4>问题附件 <span class="optional">选填</span></h4><span>已添加 {{ previews.length }} 个</span></div>
          <p>支持 JPG、PNG、WebP 和 PDF，每个不超过 10 MB。PDF 不支持在线打码，请上传前确认已遮挡隐私信息。</p>
          <input ref="imageInput" class="attachment-input" type="file" :disabled="disabled" accept="image/jpeg,image/png,image/webp,application/pdf" multiple aria-label="选择问题附件" @change="addImages" />
          <div class="attachment-grid">
            <div v-for="(image, index) in previews" :key="image.url" class="attachment-tile">
              <button type="button" :disabled="disabled" class="attachment-preview" :aria-label="`预览附件 ${index + 1}`" @click="expandedImage = expandedImage === image.url ? null : image.url"><span v-if="image.file.type === 'application/pdf'" class="pdf-card"><FileText :size="28" /><span>{{ image.file.name }}</span><small>PDF · {{ Math.ceil(image.file.size / 1024) }} KB</small></span><img v-else :src="image.url" :alt="`问题截图 ${index + 1}`" /></button>
              <button type="button" :disabled="disabled" v-if="image.file.type !== 'application/pdf'" class="attachment-edit" :aria-label="`编辑截图 ${index + 1}`" @click="editingImage = image">涂鸦 / 打码</button>
              <button type="button" :disabled="disabled" class="attachment-remove" :aria-label="`删除附件 ${index + 1}`" @click="removeImage(index)"><X :size="14" /></button>
            </div>
            <button type="button" :disabled="disabled" class="attachment-add" @click="imageInput?.click()"><ImagePlus :size="24" /><span>添加附件</span></button>
          </div>
          <div v-if="expandedImage" class="attachment-expanded"><iframe v-if="previews.some(a => a.url === expandedImage && a.file.type === 'application/pdf')" :src="expandedImage" title="PDF 附件预览" class="pdf-preview" /><img v-else :src="expandedImage" alt="截图预览" /><a v-if="previews.some(a => a.url === expandedImage && a.file.type === 'application/pdf')" :href="expandedImage" target="_blank" rel="noopener">在新窗口查看 PDF</a><button type="button" :disabled="disabled" class="feedback-secondary" @click="expandedImage = null">收起预览</button></div>
          <p v-if="attachmentError" role="alert" class="attachment-error">{{ attachmentError }}</p>

        </section>
<FeedbackImageEditor v-if="editingImage" :file="editingImage.file" @cancel="editingImage=null" @save="saveEditedImage" />
</template>
<style scoped>
.attachment-heading { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
.attachment-heading > span { font-size: 12px; color: var(--muted); }
.attachment-section p { font-size: 11px; }
.attachment-input { display: none; }
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
.attachment-section h4 { margin: 0; font-size: 12px; }
.optional { font-size: 11px; font-weight: 400; color: var(--muted); }
.feedback-secondary { border: 1px solid var(--line); border-radius: 8px; padding: 8px 12px; background: var(--surface); color: var(--ink); }
.pdf-card { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 7px; padding: 8px; height: 100%; box-sizing: border-box; color: var(--brand-strong); }
.pdf-card span { max-width: 100%; white-space: nowrap; text-overflow: ellipsis; overflow: hidden; font-size: 12px; }
.pdf-card small { color: var(--muted); }
.pdf-preview { width: 100%; height: 60vh; border: 0; }

.attachment-grid button:disabled { opacity: .55; cursor: wait; }
</style>
