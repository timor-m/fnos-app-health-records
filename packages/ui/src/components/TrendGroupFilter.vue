<script setup lang="ts">
import { computed, ref } from 'vue';
import { Check, ChevronDown, ChevronRight, Search, X } from '@lucide/vue';
import FormSelect from './FormSelect.vue';
import { flattenTrendGroups, type TrendGroupNode } from '../../../shared/trend-groups';

const props = defineProps<{ groups: TrendGroupNode[]; modelValue: string }>();
const emit = defineEmits<{ 'update:modelValue': [value: string]; manage: [] }>();
const search = ref('');
const showAll = ref(false);
const expanded = ref(new Set<string>());
const keyword = computed(() => search.value.trim().toLocaleLowerCase());
const matches = (node: TrendGroupNode) => !keyword.value || node.searchText.includes(keyword.value);
const roots = computed(() => props.groups.filter(node => (showAll.value || node.indicatorCount > 0) && (matches(node) || node.children.some(matches))));
const options = computed(() => [{ value: '', label: '全部指标' }, ...flattenTrendGroups(props.groups).map(option)]);
function option(node: TrendGroupNode) {
  return { value: node.key, label: node.name, disabled: !node.indicatorCount };
}
function expand(key: string) {
  const next = new Set(expanded.value);
  next.has(key) ? next.delete(key) : next.add(key);
  expanded.value = next;
}
</script>

<template>
  <FormSelect :model-value="modelValue" :options="options" :panel-min-width="320" panel-max-height="90vh" aria-label="指标分组" @update:model-value="emit('update:modelValue', $event)">
    <template #panel="{ pick, close }">
      <div class="trend-group-content">
        <div class="trend-group-heading"><strong>指标分组</strong><button type="button" class="plain-icon-button" aria-label="关闭分组筛选" @click="close"><X :size="18" /></button></div>
        <label class="trend-group-search"><Search :size="16" /><input v-model="search" placeholder="搜索分组、指标或别名" /></label>
        <button type="button" class="form-select-option" :class="{ selected: !modelValue }" role="option" :aria-selected="!modelValue" @click="pick(options[0])"><span>全部指标</span><Check v-if="!modelValue" :size="16" /></button>
        <p v-if="!roots.length" class="form-select-empty">没有匹配的项目</p>
        <div v-for="node in roots" :key="node.key" :class="{ 'trend-group-personal': node.key === 'my_groups' }">
          <button v-if="node.children.length" type="button" class="form-select-option trend-group-domain" :aria-expanded="expanded.has(node.key) || !!keyword" @click="expand(node.key)">
            <component :is="expanded.has(node.key) || keyword ? ChevronDown : ChevronRight" :size="16" /><span>{{ node.name }}</span><small>{{ node.indicatorCount }} / {{ node.configuredIndicatorCount }}</small>
          </button>
          <button v-else type="button" class="form-select-option" :class="{ selected: modelValue === node.key }" role="option" :aria-selected="modelValue === node.key" :disabled="!node.indicatorCount" @click="pick(option(node))"><span>{{ node.name }}</span><small>{{ node.indicatorCount }} / {{ node.configuredIndicatorCount }}</small><Check v-if="modelValue === node.key" :size="16" /></button>
          <div v-if="node.children.length && (expanded.has(node.key) || keyword)" class="trend-group-children">
            <button type="button" class="form-select-option" :class="{ selected: modelValue === node.key }" role="option" :aria-selected="modelValue === node.key" :disabled="!node.indicatorCount" @click="pick(option(node))"><span>全部</span><Check v-if="modelValue === node.key" :size="16" /></button>
            <button v-for="child in node.children.filter(c => (showAll || c.indicatorCount > 0) && (matches(c) || node.name.toLocaleLowerCase().includes(keyword)))" :key="child.key" type="button" class="form-select-option" :class="{ selected: modelValue === child.key }" role="option" :aria-selected="modelValue === child.key" :disabled="!child.indicatorCount" @click="pick(option(child))"><span>{{ child.name }}</span><small>{{ child.indicatorCount }} / {{ child.configuredIndicatorCount }}</small><Check v-if="modelValue === child.key" :size="16" /></button>
          </div>
        </div>
        <div class="trend-group-actions">
          <label class="trend-group-show-all"><input v-model="showAll" type="checkbox" />显示全部项目</label>
          <button type="button" class="primary-button trend-group-manage" @click="close();emit('manage')">管理我的分组</button>
        </div>
      </div>
    </template>
  </FormSelect>
</template>

<style scoped>
.trend-group-heading { position: sticky; top: -6px; z-index: 2; background: var(--surface); border-bottom: 1px solid var(--line); display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 4px 8px 8px; font-size: 15px; }
.trend-group-search { display: flex; align-items: center; gap: 8px; padding: 8px 10px; margin: 0 4px 8px; border: 1px solid var(--line); border-radius: var(--radius-m); }
.trend-group-search input { width: 100%; min-width: 0; padding: 0; background: transparent; border: 0; font: inherit; }
.trend-group-personal { margin-bottom: 6px; padding-bottom: 6px; border-bottom: 1px solid var(--line); }
.trend-group-domain { justify-content: flex-start; }
.trend-group-content small { margin-left: auto; white-space: nowrap; color: var(--muted); font-size: 12px; }
.trend-group-children { padding-left: 20px; }
/* 覆盖面板底部内边距，同时保持按钮原有位置及安全区间距。 */
.trend-group-actions { position: sticky; bottom: -6px; margin-bottom: -6px; z-index: 2; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 8px 16px; border-top: 1px solid var(--line); background: var(--surface); }
.trend-group-show-all { display: flex; align-items: center; gap: 8px; color: var(--muted); font-size: 13px; white-space: nowrap; }
.trend-group-manage { flex-shrink: 0; min-height: 34px; padding: 0 12px; font-size: 12px; white-space: nowrap; }
.trend-group-show-all input { width: 16px; height: 16px; accent-color: var(--brand); }
@media (max-width: 760px) {
  .trend-group-heading { top: -4px; }
  .trend-group-actions { bottom: calc(-12px - var(--safe-bottom)); margin-bottom: calc(-12px - var(--safe-bottom)); padding-bottom: calc(22px + var(--safe-bottom)); }
}
</style>
