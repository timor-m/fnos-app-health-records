<script setup lang="ts">
import { RouterLink } from 'vue-router';
import { Route,ChevronRight } from '@lucide/vue';
import {processLifecycleLabels} from '../../../shared/health-process';
import type { HealthProcessSummary } from '../../../shared/health-process';

defineProps<{process:HealthProcessSummary;returnTo:string}>();
</script>

<template>
 <RouterLink class="overview-process" :aria-label="`查看历程：${process.title}`" :to="{path:'/health-processes/'+encodeURIComponent(process.id),query:{returnTo}}">
  <Route :size="20" aria-hidden="true"/>
  <span><strong>{{process.title}}</strong><small>{{process.recordCount}} 条记录 · <span class="process-date">{{process.startedAt?.slice(0,10)||'日期未记录'}}</span><template v-if="process.latestAt&&process.latestAt!==process.startedAt"> ～ <span class="process-date">{{process.latestAt.slice(0,10)}}</span></template></small><small v-if="process.lifecycle&&process.lifecycle.status!=='unknown'">{{processLifecycleLabels[process.lifecycle.status]}}<template v-if="process.lifecycle.onsetAt"> · <span class="process-date">{{process.lifecycle.onsetAt}}</span> 起</template></small><p v-if="process.summary">{{process.summary}}</p></span>
  <span class="overview-process-open" aria-hidden="true" title="查看历程"><ChevronRight :size="18"/></span>
 </RouterLink>
</template>

<style scoped>
.overview-process{display:flex;align-items:flex-start;gap:10px;padding:12px 0;color:var(--ink);text-decoration:none;min-width:0}
.overview-process+.overview-process{border-top:1px solid var(--line)}
.overview-process>svg{flex-shrink:0;color:var(--brand-strong);margin-top:1px}
.overview-process>span:first-of-type{min-width:0;flex:1}
.overview-process strong{display:block;font-size:14px;line-height:21px;font-weight:500;overflow-wrap:anywhere}
.overview-process small{display:block;margin-top:4px;font-size:12px;line-height:18px;color:var(--muted)}
.process-date{white-space:nowrap}
.overview-process p{margin:5px 0 0;font-size:14px;line-height:20px;color:var(--ink-2);overflow-wrap:anywhere;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden}
.overview-process-open{display:flex;align-items:center;justify-content:center;align-self:center;flex:0 0 20px;width:20px;height:20px;color:var(--brand-strong)}
.overview-process:focus-visible{outline:2px solid var(--brand);outline-offset:-2px}
</style>
