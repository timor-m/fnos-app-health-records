<script setup lang="ts">
import FormSelect from './FormSelect.vue';
import type { MedicationFormula } from '../../../shared/medication-formula';
const props = defineProps<{ formula: MedicationFormula; editable?: boolean; disabled?: boolean; showSource?: boolean; title?: string }>();
const emit = defineEmits<{ 'update:formula': [value: MedicationFormula]; source: [evidence: MedicationFormula['ingredients'][number]['evidence']] }>();
const basisOptions = [{value:'per_dose',label:'每剂用量'},{value:'total',label:'调剂总量'},{value:'unspecified',label:'原文用量（口径待核对）'}];
function field(key: 'doseCount' | 'preparation', event: Event) {
  emit('update:formula', {...props.formula, [key]: (event.target as HTMLInputElement).value || null});
}
function ingredient(index: number, key: string, value: unknown) {
  emit('update:formula', {...props.formula, ingredients: props.formula.ingredients.map((item,i)=>i===index?{...item,[key]:value || null}:item)});
}
function add() {
  emit('update:formula', {...props.formula, ingredients:[...props.formula.ingredients,
    {name:'',amount:null,unit:null,amountBasis:'unspecified',totalAmount:null,totalUnit:null,instructions:null,evidence:[]}]});
}
function remove(index: number) {
  emit('update:formula', {...props.formula, ingredients:props.formula.ingredients.filter((_,i)=>i!==index)});
}
</script>
<template>
  <section class="formula-panel" aria-label="中药配方">
    <header><strong>{{ title || '配方明细' }} · {{ formula.ingredients.length }} 味</strong><button v-if="editable" type="button" class="soft-action-button" :disabled="disabled" @click="add">添加药材</button></header>
    <div v-if="editable" class="formula-meta">
      <label>剂数<input :value="formula.doseCount" :disabled="disabled" maxlength="100" placeholder="按原文填写，不换算疗程" @input="field('doseCount',$event)" /></label>
      <label>煎制说明<input :value="formula.preparation" :disabled="disabled" maxlength="1000" placeholder="按原文填写" @input="field('preparation',$event)" /></label>
    </div>
    <p v-else-if="formula.doseCount || formula.preparation" class="formula-summary">{{ [formula.doseCount ? '剂数：'+formula.doseCount : '',formula.preparation].filter(Boolean).join(' · ') }}</p>
    <p v-if="editable" class="formula-hint">药材用量是配方投料量；整方的服用频次、每次用量在药单中单独填写。</p>
    <ol class="formula-list">
      <li v-for="(item,index) in formula.ingredients" :key="index">
        <template v-if="editable">
          <div class="formula-edit-row">
            <label>药材名称<input :value="item.name" required :disabled="disabled" maxlength="300" @input="ingredient(index,'name',($event.target as HTMLInputElement).value)" /></label>
            <label>用量口径<FormSelect :model-value="item.amountBasis" :options="basisOptions" :disabled="disabled" @update:model-value="ingredient(index,'amountBasis',$event)" /></label>
            <label>原文用量<input :value="item.amount" :disabled="disabled" maxlength="100" @input="ingredient(index,'amount',($event.target as HTMLInputElement).value)" /></label>
            <label>单位<input :value="item.unit" :disabled="disabled" maxlength="60" @input="ingredient(index,'unit',($event.target as HTMLInputElement).value)" /></label>
            <label>另列总量<input :value="item.totalAmount" :disabled="disabled" maxlength="100" @input="ingredient(index,'totalAmount',($event.target as HTMLInputElement).value)" /></label>
            <label>总量单位<input :value="item.totalUnit" :disabled="disabled" maxlength="60" @input="ingredient(index,'totalUnit',($event.target as HTMLInputElement).value)" /></label>
            <label class="formula-note">配制说明<input :value="item.instructions" :disabled="disabled" maxlength="1000" @input="ingredient(index,'instructions',($event.target as HTMLInputElement).value)" /></label>
            <button type="button" class="soft-action-button" :disabled="disabled" @click="remove(index)">删除药材</button>
          </div>
        </template>
        <template v-else>
          <div class="formula-primary"><strong>{{ item.name }}</strong><span>{{ item.amountBasis==='per_dose'?'每剂':item.amountBasis==='total'?'总量':'原文用量' }} {{ [item.amount,item.unit].filter(Boolean).join(' ') || '未注明' }}</span></div>
          <small v-if="item.amountBasis==='unspecified'" class="formula-hint">用量口径待核对</small>
          <details v-if="item.totalAmount || item.instructions || (showSource && item.evidence.length)">
            <summary>{{ showSource ? '总量、说明与来源' : '总量与说明' }}</summary>
            <p v-if="item.totalAmount">调剂总量：{{ [item.totalAmount,item.totalUnit].filter(Boolean).join(' ') }}</p>
            <p v-if="item.instructions">{{ item.instructions }}</p>
            <button v-if="showSource && item.evidence.length" type="button" class="soft-action-button" @click="emit('source',item.evidence)">查看原页</button>
          </details>
        </template>
      </li>
    </ol>
  </section>
</template>
<style scoped>
.formula-panel{width:100%;min-width:0;border:1px solid var(--line);border-radius:12px;padding:14px}.formula-panel header,.formula-primary{display:flex;align-items:center;justify-content:space-between;gap:12px}.formula-panel header{margin-bottom:10px}.formula-panel header strong{font-size:14px}.formula-summary,.formula-hint,.formula-list summary{font-size:12px;color:var(--muted);line-height:1.6}.formula-list{list-style:none;padding:0;margin:0}.formula-list>li{padding:10px 0;border-top:1px solid var(--line)}.formula-primary strong{font-size:14px}.formula-primary span{font-size:14px;text-align:right}.formula-list details{margin-top:6px}.formula-list summary{cursor:pointer}.formula-list p{margin:6px 0;font-size:14px;white-space:pre-wrap;overflow-wrap:anywhere}.formula-meta,.formula-edit-row{display:grid;grid-template-columns:1fr 1fr;gap:10px}.formula-meta{margin-bottom:12px}.formula-panel label{display:grid;gap:5px;min-width:0;font-size:12px}.formula-panel input{width:100%;min-width:0;min-height:40px;border:1px solid var(--line-strong);border-radius:8px;background:var(--surface);color:var(--ink);padding:8px}.formula-note{grid-column:1/-1}
@media(max-width:520px){.formula-panel{padding:10px}.formula-meta{grid-template-columns:1fr}.formula-primary{align-items:flex-start}.formula-primary strong{overflow-wrap:anywhere}.formula-primary span{flex-shrink:0;max-width:60%;overflow-wrap:anywhere}}
</style>
