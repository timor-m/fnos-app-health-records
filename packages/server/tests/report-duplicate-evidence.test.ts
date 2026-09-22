import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateDuplicatePair as evaluate, canonicalResult, type DuplicateEvidenceSnapshot as Snapshot } from '../services/report-duplicate-evidence.ts';
export function syntheticSnapshot(id = 'a', n = 20): Snapshot {
    return { reportId: id, memberId: 'synthetic-member', version: id, sourceVersion: 1, sourceSignature: id, sourceComplete: true, issuer: 'synthetic-lab', scope: 'synthetic-panel', identifiers: [{ type: 'report', value: '001-A' }], times: { sampled: '2026-01-01 09:00' }, items: Array.from({ length: n }, (_, i) => ({ key: `analyte-${i}`, value: `${i + 1}.10`, reliable: true, anchor: true, page: 1, lines: [`line-${i}`] })), unknown: 0, risks: [], narrative: '', narrativeReliable: false, extractionId: null, usable: false };
}
const pair = () => [syntheticSnapshot('a'), syntheticSnapshot('b')] as const;
test('R0 complete originals survive OCR changes, but incomplete and subsets do not', () => {
    const [a, b] = pair();
    b.sourceSignature = a.sourceSignature;
    b.items[0].value = '99';
    assert.equal(evaluate(a, b).ruleId, 'R0');
    b.sourceComplete = false;
    assert.equal(evaluate(a, b).preGateEligible, false);
    b.sourceComplete = true;
    b.sourceSignature = 'subset';
    b.items.pop();
    assert.equal(evaluate(a, b).preGateEligible, false);
});
test('R1 allows 18/20 reliable anchors plus two genuinely weak facts', () => { const [a, b] = pair(); b.items[0].reliable = false; b.items[1].reliable = false; const e = evaluate(a, b); assert.equal(e.ruleId, 'R1'); assert.equal(e.sameCount, 18); assert.equal(e.uncertainCount, 2); assert.equal(e.coverage[0], .9); });
test('R1 includes two unparsed candidates in denominator', () => { const [a, b] = pair(); b.items.splice(0, 2); b.unknown = 2; const e = evaluate(a, b); assert.equal(e.ruleId, 'R1'); assert.equal(e.sameCount, 18); assert.deepEqual(e.coverage, [.9, .9]); });
for (const n of [3, 9, 10, 19, 20, 21, 30])
    test(`unknown thresholds remain bounded at N=${n}`, () => { const a = syntheticSnapshot('a', n), b = syntheticSnapshot('b', n); const allowed = Math.min(2, Math.floor(n * .1)); for (let i = 0; i <= allowed; i++)
        b.items[i].reliable = false; assert.equal(evaluate(a, b).preGateEligible, false); });
test('reliable numeric differences are not rounded or explained away', () => { for (const [x, y] of [['5.18', '5.19'], ['1.23', '12.3'], ['<5', '5'], ['阴性', '阳性'], ['+', '++']]) {
    const [a, b] = pair();
    a.items[0].value = x;
    b.items[0].value = y;
    assert.equal(evaluate(a, b).classification, 'related_variant');
    b.items[0].reliable = false;
    assert.equal(evaluate(a, b).ruleId, 'R1');
} });
test('decimal canonicalization does not round', () => { assert.equal(canonicalResult('5.10'), canonicalResult('5.1')); assert.notEqual(canonicalResult('5.18'), canonicalResult('5.19')); });
test('minute and second compatible, date-only with identity works, missing event needs additional evidence', () => { const [a, b] = pair(); b.times.sampled += ':30'; assert.equal(evaluate(a, b).ruleId, 'R1'); a.times.sampled = '2026-01-01'; assert.equal(evaluate(a, b).ruleId, 'R1'); a.times = {}; b.times = {}; assert.equal(evaluate(a, b).preGateEligible, false); a.identifiers.push({ type: 'sample', value: 's001' }); b.identifiers.push({ type: 'sample', value: 's001' }); assert.equal(evaluate(a, b).ruleId, 'R1'); });
test('small 1–3 result reports need full content and precise event', () => { for (const n of [1, 2, 3]) {
    const a = syntheticSnapshot('a', n), b = syntheticSnapshot('b', n);
    assert.equal(evaluate(a, b).ruleId, 'R1.short');
    b.items[0].reliable = false;
    assert.equal(evaluate(a, b).preGateEligible, false);
} });
test('R2 detects no-number reuploads but not same-day background', () => { const [a, b] = pair(); a.identifiers = []; b.identifiers = []; assert.equal(evaluate(a, b).ruleId, 'R2'); a.times.sampled = '2026-01-01'; assert.equal(evaluate(a, b).preGateEligible, false); });
test('different report IDs, issuer, event and scope cannot be background substitutes', () => { for (const change of [(s: Snapshot) => s.identifiers = [{ type: 'report', value: '002-A' }], (s: Snapshot) => s.issuer = 'other-lab', (s: Snapshot) => s.times.sampled = '2026-01-01 10:00', (s: Snapshot) => s.scope = 'other-panel']) {
    const [a, b] = pair();
    change(b);
    assert.equal(evaluate(a, b).preGateEligible, false);
} });
test('visit ID alone not strong identity', () => { const a = syntheticSnapshot('a', 4), b = syntheticSnapshot('b', 4); a.identifiers = b.identifiers = [{ type: 'visit', value: 'v001' }]; assert.equal(evaluate(a, b).preGateEligible, false); });
test('leading zeros and separators retain identity meaning', () => { const [a, b] = pair(); b.identifiers = [{ type: 'report', value: '1A' }]; assert.equal(evaluate(a, b).preGateEligible, false); });
test('multiset repeated name preserves a second measurement conflict', () => { const [a, b] = pair(); a.items[1].key = a.items[0].key; b.items[1].key = b.items[0].key; b.items[1].value = '50'; assert.equal(evaluate(a, b).conflictCount, 1); });
for (const risk of ['ocr_page_missing', 'content_budget_exceeded', 'revision_note', 'ocr_page_poor', 'unresolved_page'])
    test(`integrity risk ${risk} prevents content pause`, () => { const [a, b] = pair(); b.risks = [risk]; assert.equal(evaluate(a, b).preGateEligible, false); });
test('additional result cannot disappear behind high overlap', () => { const [a, b] = pair(); b.items.push({ ...b.items[0], key: 'added-result' }); assert.equal(evaluate(a, b).classification, 'related_variant'); });
test('semantic context prevents percent, specimen, laterality and method conflation', () => { for (const key of ['analyte-0|urine', 'analyte-0|left', 'analyte-0|percent', 'analyte-0|different-method']) {
    const [a, b] = pair();
    b.items[0].key = key;
    assert.equal(evaluate(a, b).preGateEligible, false);
} });
test('post results lower threshold but require identity and real content', () => { const a = syntheticSnapshot('a', 5), b = syntheticSnapshot('b', 5); b.items[0].reliable = false; assert.equal(evaluate(a, b).preGateEligible, false); assert.equal(evaluate(a, b, 'ai_post').ruleId, 'R3.results'); b.items[1].value = '900'; assert.equal(evaluate(a, b, 'ai_post').classification, 'related_variant'); });
test('narrative post compares entire findings, not generic conclusion or prefix', () => { const a = syntheticSnapshot('a', 0), b = syntheticSnapshot('b', 0); a.narrative = b.narrative = '合成影像所见：左侧特定区域存在明确范围的局部改变，测量范围与位置均有记录；右侧区域连续且形态均匀，检查涵盖完整范围，结论与所见一致。'; a.narrativeReliable = b.narrativeReliable = true; assert.equal(evaluate(a, b, 'ai_post').ruleId, 'R3.narrative'); b.narrative += '新增病灶。'; assert.equal(evaluate(a, b, 'ai_post').classification, 'related_variant'); a.narrative = b.narrative = '未见异常'; assert.equal(evaluate(a, b, 'ai_post').classification, 'insufficient'); });
test('symmetric conclusions and counts under exchange', () => { const [a, b] = pair(); b.items[0].reliable = false; a.items.reverse(); const x = evaluate(a, b), y = evaluate(b, a); assert.equal(x.classification, y.classification); assert.equal(x.sameCount, y.sameCount); assert.equal(x.uncertainCount, y.uncertainCount); assert.deepEqual(x.coverage, y.coverage.reverse()); });
test('replacing known with unknown cannot strengthen evidence', () => { const [a, b] = pair(); const before = evaluate(a, b); b.items[0].reliable = false; const after = evaluate(a, b); assert.ok(after.sameCount < before.sameCount); assert.ok(after.coverage[0] < before.coverage[0]); });
