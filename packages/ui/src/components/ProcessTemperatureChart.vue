<script setup lang="ts">
import { computed } from 'vue';
import { formatMedicationDate } from '../utils/medication-date';
import type { TemperatureReading } from '../../../shared/health-process-care';
const props=defineProps<{readings:TemperatureReading[]}>();
const points=computed(()=>{
 const rows=props.readings.filter(r=>Number.isFinite(r.value)&&Number.isFinite(Date.parse(r.at))).slice().sort((a,b)=>Date.parse(a.at)-Date.parse(b.at));
 if(!rows.length)return [];
 const low=Math.floor(Math.min(...rows.map(r=>r.value))-.5),high=Math.ceil(Math.max(...rows.map(r=>r.value))+.5);
 const start=Date.parse(rows[0].at),span=Date.parse(rows.at(-1)!.at)-start;
 return rows.map(row=>({...row,x:span?34+(Date.parse(row.at)-start)/span*292:180,y:20+(high-row.value)/(high-low)*104}));
});
const highest=computed(()=>points.value.reduce((max,p)=>Math.max(max,p.value),-Infinity));
const line=computed(()=>points.value.map(p=>`${p.x},${p.y}`).join(' '));
</script>
<template>
 <figure v-if="points.length" class="process-temperature-chart">
  <figcaption>体温变化 <span>按实际记录时间排列</span></figcaption>
  <svg viewBox="0 0 350 155" role="img" :aria-label="`体温变化，共 ${points.length} 次记录`">
   <line x1="34" y1="132" x2="326" y2="132" class="chart-axis"/>
   <polyline v-if="points.length>1" :points="line" fill="none" class="chart-line"/>
   <g v-for="(point,index) in points" :key="point.updateId"><circle :cx="point.x" :cy="point.y" r="3" class="chart-dot"><title>{{formatMedicationDate(point.at)}} · {{point.value}}℃</title></circle><text v-if="points.length<=8||point.updateId===points.at(-1)?.updateId||point.value===highest" :x="point.x" :y="index>0&&point.x-points[index-1].x<28?point.y+15:point.y-7" text-anchor="middle">{{point.value}}</text></g>
   <text x="34" y="149">{{formatMedicationDate(points[0].at)}}</text><text v-if="points.length>1" x="326" y="149" text-anchor="end">{{formatMedicationDate(points.at(-1)!.at)}}</text>
  </svg>
 </figure>
</template>
<style scoped>
.process-temperature-chart{margin:0;padding:0 12px 10px;min-width:0}.process-temperature-chart figcaption{font-size:12px;color:var(--ink-2)}.process-temperature-chart figcaption span{font-size:12px;color:var(--muted);margin-left:8px}.process-temperature-chart svg{display:block;width:100%;max-width:460px;height:auto;margin:0 auto}.chart-axis{stroke:var(--line)}.chart-line{stroke:var(--brand);stroke-width:1.5}.chart-dot{fill:var(--brand)}.process-temperature-chart text{fill:var(--muted);font-size:12px}
</style>
