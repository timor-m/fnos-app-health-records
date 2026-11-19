<script setup lang="ts">
import {computed,nextTick,ref,watch} from 'vue';
import FormSuggest from './FormSuggest.vue';
import {measurementUnitOptions} from '../utils/record-form-options';
import {measurementsForSymptom,isTemperatureMeasurement} from '../../../shared/symptom-measurements';
const props=defineProps<{name:string;disabled?:boolean}>();
const value=defineModel<string>('value',{required:true});
const unit=defineModel<string>('unit',{required:true});
const temperature=defineModel<string>('temperature',{required:true});
const definition=computed(()=>measurementsForSymptom(props.name)[0]);
const legacy=computed(()=>!definition.value&&Boolean(value.value||unit.value));
const label=computed(()=>definition.value?.label||'附带体温');
const expanded=ref(Boolean(temperature.value));
const temperatureInput=ref<HTMLInputElement|null>(null);
const showTemperature=computed(()=>Boolean(definition.value)||expanded.value);
watch(temperature,next=>{if(next)expanded.value=true;});
async function expandTemperature(){expanded.value=true;await nextTick();temperatureInput.value?.focus({preventScroll:true});}
const displayed=computed(()=>definition.value?value.value:temperature.value);
function setTemperature(event:Event){const input=event.target as HTMLInputElement,text=input.value;
 input.setCustomValidity(text&&!isTemperatureMeasurement(text,'℃')?'请填写有效的摄氏体温数值':'');
 if(definition.value){value.value=text;unit.value=text?definition.value.unit:'';}else temperature.value=text;
}
</script>
<template>
 <div class="symptom-observation-measurement">
  <div v-if="legacy" class="symptom-observation-inputs">
   <label>原有测量值（选填）<input v-model="value" name="legacyMeasurementValue" aria-label="原有测量值" maxlength="100" :disabled="disabled"/></label>
   <label>单位<FormSuggest v-model="unit" :options="measurementUnitOptions" label="测量单位" name="measurementUnit" :disabled="disabled" maxlength="50"/></label>
  </div>
  <button v-if="!showTemperature" type="button" class="symptom-temperature-add" :disabled="disabled" :aria-expanded="false" @click="expandTemperature">补充体温</button>
  <div v-if="showTemperature" class="symptom-observation-inputs">
   <label>{{label}}（选填）<input ref="temperatureInput" :value="displayed" @input="setTemperature" :name="definition?'measurementValue':'temperatureValue'" :aria-label="label" inputmode="decimal" maxlength="100" placeholder="如 37.5" :disabled="disabled"/></label>
   <label>单位<input value="℃" :name="definition?'measurementUnit':undefined" aria-label="体温单位" readonly tabindex="-1"/></label>
  </div>
  <p v-if="showTemperature">仅填写实际测量的体温，保存后计入体温趋势；不填写不影响症状记录。</p>
 </div>
</template>
<style scoped>
.symptom-temperature-add{justify-self:start;min-height:32px;padding:4px 0;border:0;background:none;color:var(--brand-strong);font:inherit;font-size:12px;cursor:pointer}.symptom-temperature-add:focus-visible{outline:2px solid var(--brand);outline-offset:2px}.symptom-temperature-add:disabled{opacity:.5;cursor:default}
.symptom-observation-measurement{display:grid;gap:6px;min-width:0}.symptom-observation-inputs{display:grid;grid-template-columns:minmax(0,1fr) 72px;gap:10px}.symptom-observation-inputs label{display:grid;gap:6px;min-width:0;font-size:12px;color:var(--muted)}.symptom-observation-inputs input{width:100%;min-width:0;padding:8px 10px;border:1px solid var(--line-strong);border-radius:var(--radius-s);background:var(--surface);color:var(--ink);font:inherit;font-size:14px;line-height:21px}.symptom-observation-inputs input[readonly]{background:var(--fill-2);color:var(--muted)}.symptom-observation-inputs input:focus{border-color:var(--brand);outline:2px solid var(--brand-soft)}.symptom-observation-measurement p{margin:0;font-size:12px;line-height:18px;color:var(--muted)}
</style>
