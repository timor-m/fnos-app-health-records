<script setup lang="ts">
import {computed,onMounted,onBeforeUnmount,ref,watch} from 'vue';
import {Crosshair,RectangleHorizontal} from '@lucide/vue';
import OriginalOrientation from './OriginalOrientation.vue';
import {sourceRegion,unrotateRegionPoint,type SourceRegion} from '../../../shared/source-region';
const props=defineProps<{src:string;pageKey:string;modelValue:SourceRegion|null;coordinateRotation:number;displayRotation?:number}>();
const emit=defineEmits<{'update:modelValue':[value:SourceRegion|null]}>();
const selecting=ref(false);
const tools=ref<HTMLElement|null>(null);
const viewport=ref<HTMLElement|null>(null),viewportSize=ref({width:0,height:0});
let observer:ResizeObserver|undefined;
function measureViewport(){viewportSize.value={width:viewport.value?.clientWidth||0,height:viewport.value?.clientHeight||0};}
onMounted(()=>{observer=new ResizeObserver(measureViewport);if(viewport.value)observer.observe(viewport.value);measureViewport();});
onBeforeUnmount(()=>observer?.disconnect());
const image=ref<HTMLImageElement|null>(null),rotation=ref(0),zoom=ref(1);
const imageWidth=computed(()=>{
 const {width,height}=viewportSize.value;
 if(!image.value?.naturalWidth||!image.value.naturalHeight||!width||!height)return '100%';
 const rotated=rotation.value%180!==0;
 const ratio=rotated?image.value.naturalHeight/image.value.naturalWidth:image.value.naturalWidth/image.value.naturalHeight;
 return `${Math.min(width,height*ratio)*zoom.value}px`;
});
const draft=ref<SourceRegion['box']|null>(null);
let start:[number,number]|null=null;
let pointer:number|null=null;
watch(()=>props.pageKey,()=>{start=null;pointer=null;draft.value=null;image.value=null;rotation.value=0;zoom.value=1;});
const box=computed(()=>draft.value || props.modelValue?.box);
const style=computed(()=>box.value?{left:`${box.value[0]*100}%`,top:`${box.value[1]*100}%`,width:`${(box.value[2]-box.value[0])*100}%`,height:`${(box.value[3]-box.value[1])*100}%`}:{});
function point(event:PointerEvent){
 const rect=(event.currentTarget as HTMLElement).getBoundingClientRect();
 return unrotateRegionPoint(Math.min(1,Math.max(0,(event.clientX-rect.left)/rect.width)),Math.min(1,Math.max(0,(event.clientY-rect.top)/rect.height)),rotation.value);
}
function down(event:PointerEvent){
 if(!selecting.value || !image.value || event.button!==0 || pointer!==null)return;
 event.preventDefault();pointer=event.pointerId;start=point(event);draft.value=null;
 (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
}
function move(event:PointerEvent){
 if(pointer!==event.pointerId||!start)return;
 const end=point(event);draft.value=[Math.min(start[0],end[0]),Math.min(start[1],end[1]),Math.max(start[0],end[0]),Math.max(start[1],end[1])];
}
function end(event:PointerEvent){
 if(pointer!==event.pointerId)return;
 move(event);
 const region=sourceRegion({box:draft.value,rotation:props.coordinateRotation});
 if(region){emit('update:modelValue',region);selecting.value=false;}
 start=null;pointer=null;draft.value=null;
}
function cancel(){start=null;pointer=null;draft.value=null;}
</script>
<template>
 <div class="source-region-picker">
  <div ref="tools" class="source-region-tools"><button type="button" class="primary-button source-region-start" title="拖动框选原文位置，仅记录位置，不会自动识别" :disabled="!image" :aria-pressed="selecting" @click="selecting=!selecting;cancel()"><Crosshair v-if="selecting" :size="16" aria-hidden="true" /><RectangleHorizontal v-else :size="16" aria-hidden="true" /><span>{{selecting?"框选中 · 退出":"开始框选"}}</span></button><button type="button" :disabled="zoom<=1" aria-label="缩小框选原图" @click="zoom=Math.max(1,zoom-.5)">−</button><span>{{zoom*100}}%</span><button type="button" :disabled="zoom>=3" aria-label="放大框选原图" @click="zoom=Math.min(3,zoom+.5)">＋</button><button type="button" :disabled="!modelValue" @click="emit('update:modelValue',null)">清除定位</button></div>
  <div ref="viewport" class="source-region-scroll"><div class="source-region-stage" :style="{width:imageWidth}">
   <OriginalOrientation :image="image" :toolbar-target="tools" :page-key="pageKey" :initial-rotation="displayRotation" @rotation-change="rotation=$event">
    <div class="source-region-image">
     <img :src="src" alt="框选指标来源区域" draggable="false" @load="image=$event.target as HTMLImageElement" />
     <div class="source-region-canvas" :style="{pointerEvents:selecting?'auto':'none'}" role="img" aria-label="拖动框选来源区域" @pointerdown="down" @pointermove="move" @pointerup="end" @pointercancel="cancel" @lostpointercapture="cancel">
      <div v-if="box" class="source-region-box" :style="style"></div>
     </div>
    </div>
   </OriginalOrientation>
  </div></div>
 </div>
</template>
<style scoped>
.source-region-tools{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:12px;margin:0 0 8px}.source-region-tools button{min-height:34px;display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:6px 10px;border:1px solid var(--line);border-radius:8px;background:var(--surface);color:var(--ink)}
.source-region-tools :deep(.original-orientation-toolbar){margin:0}.source-region-tools :deep(.original-orientation-toolbar button){width:34px;height:34px;padding:6px;border:1px solid var(--line);border-radius:8px;background:var(--surface);color:var(--ink)}
.source-region-tools .source-region-start{background:var(--brand-gradient);color:#fff;border-color:transparent;font-weight:700;white-space:nowrap}.source-region-tools .source-region-start[aria-pressed="true"]{background:#b45309;border-color:#fbbf24;color:#fff;box-shadow:0 0 0 3px #f59e0b33}.source-region-tools .source-region-start:disabled{opacity:.5}
.source-region-stage{margin:0 auto}.source-region-scroll{height:380px;max-height:380px;overflow:auto;border:1px solid var(--line);border-radius:8px}.source-region-image{position:relative;width:100%;line-height:0}.source-region-image img{display:block;width:100%;height:auto;user-select:none}.source-region-canvas{position:absolute;inset:0;touch-action:none;cursor:crosshair}.source-region-box{position:absolute;border:2px solid #d68a24;background:#e9a43a25;pointer-events:none;box-sizing:border-box}
</style>
