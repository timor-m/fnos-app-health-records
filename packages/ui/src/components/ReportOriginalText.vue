<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { X } from '@lucide/vue';
import { useScrollLock } from '../composables/useScrollLock';
const props=defineProps<{ label:string; text:string; manual?:boolean }>();
const preview=computed(()=>{
  const lines=props.text.split('\n');
  const end=Math.min(props.text.length,360,lines.length>8 ? lines.slice(0,8).join('\n').length : props.text.length);
  return props.text.slice(0,end);
});
const long=computed(()=>preview.value.length<props.text.length);
function sections(text:string) {
  return text.split(/(?=^【第 \d+ 页[^\n]*】\n)/m).filter(Boolean).map(part=>{
    const match=/^【(第 \d+ 页[^\n]*)】\n(?:对应问题：([\s\S]*?)\n\n)?([\s\S]*)$/.exec(part);
    if(!match) return {source:'',context:'',issue:'',text:part};
    const [source,...titles]=match[1].split(' · ');
    const context=titles.filter(title=>! /^(?:小结|科室小结|检查小结|概述|原报告概述|报告概述|摘要|总结|结论|检查结论|检查所见|所见|印象|医生建议|医师建议|建议)$/.test(title)).join(' · ');
    return {source,context:context || (match[2]?'':'项目或科室待确认'),issue:match[2]||'',text:match[3]};
  });
}
const previewSections=computed(()=>sections(preview.value));
const fullSections=computed(()=>sections(props.text));
const open=ref(false);
const panel=ref<HTMLElement|null>(null);
let returnFocus:HTMLElement|null=null;
useScrollLock(open);
watch(open,async visible=>{
  if(visible){returnFocus=document.activeElement as HTMLElement;await nextTick();panel.value?.querySelector<HTMLButtonElement>('button')?.focus();}
  else if(returnFocus?.isConnected){returnFocus.focus({preventScroll:true});returnFocus=null;}
});
watch(()=>props.text,()=>{open.value=false;});
onBeforeUnmount(()=>{if(returnFocus?.isConnected)returnFocus.focus({preventScroll:true});});
function keydown(event:KeyboardEvent){
  if(event.key==='Escape'){event.preventDefault();event.stopPropagation();open.value=false;}
  if(event.key==='Tab') {
    const controls=panel.value?.querySelectorAll<HTMLElement>('button,[tabindex="0"]');
    const first=controls?.[0],last=controls?.[controls.length-1];
    if(event.shiftKey && document.activeElement===first){event.preventDefault();last?.focus();}
    else if(!event.shiftKey && document.activeElement===last){event.preventDefault();first?.focus();}
  }
}
</script>
<template>
  <article class="report-original-text">
    <span>{{ label }}<em v-if="manual" class="manual-field-chip">人工校对</em></span>
    <div class="original-text-sections">
      <section v-for="(item,index) in previewSections" :key="index" class="original-text-section">
        <small v-if="item.source" class="original-text-source">{{ item.source }}</small>
        <h4 v-if="item.context" class="original-text-context">{{ item.context }}</h4>
        <h4 v-if="item.issue" class="original-text-issue">对应问题：{{ item.issue }}</h4>
        <p>{{ item.text }}<template v-if="long && index===previewSections.length-1">…</template></p>
      </section>
    </div>
    <button v-if="long" type="button" class="soft-action-button" :aria-label="`查看更多${label}`" @click="open=true">查看更多</button>
    <Teleport to="body">
      <div v-if="open" class="modal-backdrop report-edit-backdrop original-text-backdrop" @click.self="open=false" @keydown="keydown">
        <section ref="panel" class="modal-panel original-text-modal" role="dialog" aria-modal="true" :aria-label="`${label}全文`">
          <header><h3>{{ label }}全文</h3><button type="button" class="plain-icon-button" aria-label="关闭全文" @click="open=false"><X :size="20" /></button></header>
          <div class="original-text-body" tabindex="0" aria-label="全文内容">
            <section v-for="(item,index) in fullSections" :key="index" class="original-text-section">
              <small v-if="item.source" class="original-text-source">{{ item.source }}</small>
              <h4 v-if="item.context" class="original-text-context">{{ item.context }}</h4>
        <h4 v-if="item.issue" class="original-text-issue">对应问题：{{ item.issue }}</h4>
              <p>{{ item.text }}</p>
            </section>
          </div>
        </section>
      </div>
    </Teleport>
  </article>
</template>
<style scoped>
.original-text-backdrop { z-index: 150; }
.original-text-modal { width: min(800px, calc(100vw - 24px)); max-height: calc(100vh - 32px); max-height: calc(100dvh - 32px); display:flex; flex-direction:column; overflow:hidden; }
.original-text-modal > header { display:flex; align-items:center; justify-content:space-between; gap:12px; flex-shrink:0; }
.original-text-modal h3 { margin:0; }
.original-text-body { overflow:auto; min-height:0; padding:16px 20px; }
.original-text-section + .original-text-section { margin-top:20px; padding-top:16px; border-top:1px solid var(--border-color, #8883); }
.original-text-source { display:block; opacity:.65; font-size:12px; margin-bottom:8px; }
.original-text-context, .original-text-issue { margin:0 0 10px; font-size:14px; line-height:1.6; white-space:pre-wrap; overflow-wrap:anywhere; }
.original-text-section p { margin:0; white-space:pre-wrap; overflow-wrap:anywhere; line-height:1.75; }
</style>
