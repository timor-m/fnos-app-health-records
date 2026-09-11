import assert from 'node:assert/strict';
import test from 'node:test';
import { cleanOcrResult } from '../utils/ocr-result.ts';
import { normalizeAiExtraction, sanitizeReportObservations } from '../services/ai-extraction.service.ts';

test('generic numeric cleanup preserves order, ambiguity and extreme results', () => {
  assert.equal(cleanOcrResult('１２ . ３'), '12.3');
  assert.equal(cleanOcrResult("8'0"), "8'0");
  assert.equal(cleanOcrResult('1 234'), '1 234');
  assert.equal(cleanOcrResult('3-9'), '3-9');
  for (const itemName of ['合成项甲', '合成项乙', '合成项丙']) {
    for (const [text, expected] of [['↑ 12 . 3', 12.3], ['99999', 99999], ["8'0", null]] as const) {
      const source = normalizeAiExtraction({ observations: [{ itemName, resultText: text, numericValue: null,
        referenceLow: 0, referenceHigh: 1, evidence: [{pageNumber: 1, quote: `${itemName} ${text}`}] }] }).fields.observations;
      const result = sanitizeReportObservations(source);
      assert.equal(result.length, 1);
      assert.equal(result[0].numericValue, expected);
      assert.deepEqual(result[0].evidence, source[0].evidence);
      assert.equal(result[0].unit, null);
    }
  }
});
