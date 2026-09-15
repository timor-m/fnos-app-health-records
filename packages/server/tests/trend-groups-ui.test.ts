import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { computed, ref, reactive } from 'vue';
import { transpile, ScriptTarget } from 'typescript';
import { flattenTrendGroups, type TrendGroupNode } from '../../shared/trend-groups';

function script(file: string) {
  return readFileSync(file, 'utf8').split('<script setup lang="ts">')[1].split('</script>')[0].replace(/^import .*?;\n/gm,'');
}
function state() {
  const node = (key: string, name: string, count: number, searchText: string): TrendGroupNode => ({key, name, indicatorCount: count, configuredIndicatorCount: 5, indicatorKeys: [], searchText, children: []});
  const props = reactive({ groups: [{...node('lab','检验检查',5,'检验检查 tsh'), children: [node('three','甲功三项',3,'甲功三项 tsh ft3'), node('five','甲功五项',5,'甲功五项 tsh ft3 t3'), node('empty','其他检验',0,'其他检验')]}], modelValue: '' });
  const bindings = {computed, ref, flattenTrendGroups, defineProps: () => props, defineEmits: () => (_event: string, key: string) => {props.modelValue = key;} };
  const api = new Function(...Object.keys(bindings), transpile(script('packages/ui/src/components/TrendGroupFilter.vue') + '\nreturn {expanded,expand,roots,search,showAll,options,option};', {target: ScriptTarget.ES2022}))(...Object.values(bindings));
  return { props, ...api };
}
test('domain expands without selecting; selector uses one key and names the active choice', () => {
  const s = state();
  assert.equal(s.expanded.value.size, 0);
  s.expand('lab'); assert.equal(s.expanded.value.has('lab'), true); assert.equal(s.props.modelValue, '');
  s.props.modelValue = 'three';
  assert.equal(s.options.value.find((o: any) => o.value === s.props.modelValue).label, '甲功三项');
  s.props.modelValue = 'five';
  assert.equal(s.options.value.find((o: any) => o.value === s.props.modelValue).label, '甲功五项');
  assert.equal(s.options.value[0].value, '');
});
test('search supports group names and aliases, empty choices stay disabled', () => {
  const s = state();
  s.search.value = 'TSH'; assert.equal(s.roots.value.length, 1);
  s.search.value = '甲功'; assert.equal(s.roots.value.length, 1);
  s.search.value = 'not-matched'; assert.equal(s.roots.value.length, 0);
  assert.equal(s.option(s.props.groups[0].children[2]).disabled, true);
  s.props.groups = []; assert.equal(s.roots.value.length, 0);
});
test('shared FormSelect picks exactly one option, closes on pick, and ignores disabled choices', () => {
  const events: unknown[][] = [];
  const bindings = {computed, ref, nextTick: () => {}, watch: () => {}, onBeforeUnmount: () => {}, useScrollLock: () => {},
    defineProps: () => ({modelValue: '', options: []}), defineEmits: () => (...args: unknown[]) => events.push(args)};
  const api = new Function(...Object.keys(bindings), transpile(script('packages/ui/src/components/FormSelect.vue') + '\nreturn {open,pick};', {target: ScriptTarget.ES2022}))(...Object.values(bindings));
  api.open.value = true;
  api.pick({value:'empty', label:'空项目',disabled:true}); assert.equal(events.length, 0); assert.equal(api.open.value,true);
  api.pick({value:'five',label:'甲功五项'}); assert.deepEqual(events[0], ['update:modelValue','five']); assert.equal(api.open.value,false);
  api.open.value = true; api.pick({value:'',label:'全部指标'}); assert.deepEqual(events[2], ['update:modelValue','']); assert.equal(api.open.value,false);
});
test('single-select UI reuses shared drawer and removes multi-select tags and state', () => {
  const source = readFileSync('packages/ui/src/components/TrendGroupFilter.vue','utf8');
  const page = readFileSync('packages/ui/src/pages/TrendsPage.vue', 'utf8');
  const select = readFileSync('packages/ui/src/components/FormSelect.vue','utf8');
  assert.match(page, /params.append\('groupKeys\[\]', groupFilter.value\)/);
  assert.match(page, /sequence === groupRequest/); assert.match(page, /sequence === loadRequest/);
  assert.match(page, /groupFilter.value = ''/);
  assert.doesNotMatch(page, /trend-group-chips|selectedGroups/);
  assert.doesNotMatch(source, /indeterminate|trend-group-popover|modelValue: string\[\]/);
  assert.match(source, /<FormSelect/); assert.match(source, /pick\(option\(node\)\)/);
  assert.match(source, /显示全部项目/);
  assert.match(source, /pick\(option\(node\)\)"><span>全部<\/span>/);
  assert.doesNotMatch(source, /全部\{\{ node.name \}\}/);
  assert.match(select, /Teleport to="body"/); assert.match(select, /useScrollLock/);
  assert.match(select, /slot name="panel"/);
});
