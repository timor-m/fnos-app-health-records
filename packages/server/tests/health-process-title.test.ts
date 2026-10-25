import assert from 'node:assert/strict';
import test from 'node:test';
import {specificProcessTitle} from '../services/health-process-title';

test('type lists and overview boilerplate are not matter titles; concrete subjects are retained',()=>{
 for(const title of ['健康记录概览：检验、处方与接种','健康记录概览','资料汇总','报告、影像、症状、用药与接种','体检报告 / 门诊报告 / 处方笺',null])assert.equal(specificProcessTitle(title),null);
 for(const title of ['血脂检查','皮疹就诊与治疗','新冠疫苗接种','健康记录概览：血脂检查与皮疹就诊','健康历程：健康记录概览：血脂检查与皮疹就诊']){
  assert.equal(specificProcessTitle(title),title.replace(/^(?:健康历程：)?健康记录概览：/u,''));
 }
});
test('automatic titles are complete phrases rather than clipped source filenames',()=>{
 for(const title of ['合成事项甲检验…、合成事项乙处方…等4项健康事项','合成事项甲检查...','合成健康事项'.repeat(20),'待命名健康历程'])assert.equal(specificProcessTitle(title),null);
 const title='合成健康事项'.repeat(5);assert.equal(Array.from(title).length,30);assert.equal(specificProcessTitle(title),title);
});
