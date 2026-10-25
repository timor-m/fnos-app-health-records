import assert from 'node:assert/strict';
import test from 'node:test';
import {measurementEvidenceRegions} from '../utils/measurement-bound.ts';

test('exact single Han name regions support glued ordinals without borrowing substrings or references',()=>{
  assert.deepEqual(measurementEvidenceRegions('1钾 | 6.4 | mmol/L | 1-9',['钾']),['6.4 mmol/L']);
  assert.deepEqual(measurementEvidenceRegions('钠 8.6 mmol/L',['钠']),['8.6 mmol/l']);
  assert.deepEqual(measurementEvidenceRegions('12白蛋白 | 33 | g/L',['白蛋白']),['33 g/L']);
  for(const [quote,name] of [['尿钾 6.4 mmol/L','钾'],['1型 6.4 U/L','型'],['25羟维生素D 8.6 ng/mL','羟维生素D'],['参考范围 钾 1-9','钾'],['ALT 12 U/L','A']]){
    assert.deepEqual(measurementEvidenceRegions(quote,[name]),[],quote);
  }
});
