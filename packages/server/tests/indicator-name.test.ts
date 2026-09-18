import assert from 'node:assert/strict';
import test from 'node:test';
import { cleanIndicatorName } from '../utils/indicator-name.ts';
import { sanitizeReportObservations, normalizeAiExtraction } from '../services/ai-extraction.service.ts';
import { indicatorNameCandidates } from '../services/indicator-normalization.service.ts';

test('cleans edge decorations and separates marked codes without removing medical symbols', () => {
  for (const name of ['★合成指标', '合成指标 ★', '**¥ 合成指标 ￥**', '☆合成指标☆']) {
    assert.equal(cleanIndicatorName(name).name, '合成指标');
    assert.deepEqual(indicatorNameCandidates(name), indicatorNameCandidates('合成指标'));
  }
  for (const name of ['α-指标', 'β-hCG', 'γ-GT', 'CD4+', 'MID%', 'NEUT#', '白/球比值', 'A*B']) {
    assert.equal(cleanIndicatorName(name).name, name);
  }
  assert.deepEqual(cleanIndicatorName('LDL-C★低密度脂蛋白胆固醇'), { name: '低密度脂蛋白胆固醇', code: 'LDL-C' });
  for (const [raw, expected] of [
    ['☆"酸碱度"', '酸碱度'],
    ['“酸碱度”', '酸碱度'],
    ['指标:DOB值', 'DOB值'],
    ['指标：血红蛋白', '血红蛋白'],
    ['项目:肌酐', '肌酐'],
  ] as const) {
    assert.equal(cleanIndicatorName(raw).name, expected);
    assert.deepEqual(indicatorNameCandidates(raw), indicatorNameCandidates(expected));
  }
  const source = normalizeAiExtraction({ observations: [{ itemName: 'SYN★合成指标', resultText: '42', numericValue: 42, unit: 'U/L', evidence: [{ pageNumber: 1, quote: 'SYN★合成指标 42 U/L' }] }] }).fields.observations;
  const cleaned = sanitizeReportObservations(source);
  assert.equal(cleaned[0].itemName, '合成指标');
  assert.equal(cleaned[0].itemCode, 'SYN');
  assert.deepEqual(cleaned[0].evidence, source[0].evidence);
  assert.equal(source[0].itemName, 'SYN★合成指标');
});

test('cleans summary enumeration names and collapses doubled names', () => {
  // 小结/综述的异常枚举：剥序号前缀 + 名称截止到判断词前
  assert.equal(
    cleanIndicatorName('3、血清总胆固醇测定增高:5.48mmol/L(参考区间:2.33-5.18) 血清甘油三酯测定增高:2.61mmol/L(参考区间:0.2-1.70)').name,
    '血清总胆固醇',
  );
  assert.equal(cleanIndicatorName('4、血清丙氨酸氨基转移酶测定增高:48U/L(参考区间:≤45)').name, '血清丙氨酸氨基转移酶');
  assert.equal(cleanIndicatorName('6、尿蛋白质阳性:阳性(1+)(参考区间:阴性)').name, '尿蛋白质');
  // 普通序号明细行：只剥前缀
  assert.equal(cleanIndicatorName('1、血红蛋白').name, '血红蛋白');
  // OCR 重复名称
  assert.equal(cleanIndicatorName('鼓膜 鼓膜').name, '鼓膜');
  // 无序号前缀的正常名称不受影响
  for (const name of ['24小时尿蛋白定量', '甲状腺球蛋白抗体', '嗜酸性细胞百分数(EOS%)', '总胆固醇']) {
    assert.equal(cleanIndicatorName(name).name, name);
  }
});

test('sanitize drops summary echo rows whose result is advice prose and rejects section labels', () => {
  const observations = normalizeAiExtraction({
    observations: [
      {
        itemName: '3、血清总胆固醇测定增高:5.48mmol/L(参考区间:2.33-5.18) 血清甘油三酯测定增高:2.61mmol/L(参考区间:0.2-1.70)',
        resultText: '【建议】生活方式改善是治疗血脂异常的基础措施，包括坚持健康饮食、规律运动。',
        evidence: [{ pageNumber: 1, quote: '3、血清总胆固醇测定增高:5.48mmol/L(参考区间:2.33-5.18)' }],
      },
      {
        itemName: '4、血清丙氨酸氨基转移酶测定增高:48U/L(参考区间:≤45)',
        resultText: '48', numericValue: 48, unit: 'U/L',
        evidence: [{ pageNumber: 1, quote: '4、血清丙氨酸氨基转移酶测定增高:48U/L(参考区间:≤45)' }],
      },
      {
        itemName: '小结',
        resultText: '常规心电图检查(12导联):窦性心律',
        evidence: [{ pageNumber: 1, quote: '小结 | 常规心电图检查(12导联):窦性心律' }],
      },
    ],
  }).fields.observations;
  const cleaned = sanitizeReportObservations(observations);
  assert.equal(cleaned.length, 1);
  assert.equal(cleaned[0].itemName, '血清丙氨酸氨基转移酶');
  assert.equal(cleaned[0].resultText, '48');
});
