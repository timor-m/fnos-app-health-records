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
  const source = normalizeAiExtraction({ observations: [{ itemName: 'SYN★合成指标', resultText: '42', numericValue: 42, unit: 'U/L', evidence: [{ pageNumber: 1, quote: 'SYN★合成指标 42 U/L' }] }] }).fields.observations;
  const cleaned = sanitizeReportObservations(source);
  assert.equal(cleaned[0].itemName, '合成指标');
  assert.equal(cleaned[0].itemCode, 'SYN');
  assert.deepEqual(cleaned[0].evidence, source[0].evidence);
  assert.equal(source[0].itemName, 'SYN★合成指标');
});
