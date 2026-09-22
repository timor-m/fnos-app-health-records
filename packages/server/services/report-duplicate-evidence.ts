import { currentReportDuplicateRuleVersion } from './report-duplicate-rules.service';
// Quality is a source reliability cutoff, never a duplicate probability.
export const duplicateEvidencePolicy = {
    ocrReliable: 0.9, usableCoverage: 0.8, maxCharacters: 200000, maxItems: 2000,
    r1: { coverage: .90, maxUnknown: 2, unknownRatio: .10, anchors: 4 },
    r2: { coverage: .95, maxUnknown: 1, unknownRatio: .05, same: 10, anchors: 6 },
    post: { coverage: .8, unknownRatio: .2, same: 3, narrativeCharacters: 60 },
} as const;
export type EvidenceState = 'exact' | 'equivalent' | 'compatible' | 'uncertain' | 'conflict' | 'missing';
export type DuplicateClassification = 'exact_duplicate' | 'strong_duplicate' | 'possible_duplicate' | 'different' | 'insufficient' | 'related_variant';
export type DuplicateFact = {
    key: string;
    value: string;
    reliable: boolean;
    anchor: boolean;
    page?: number;
    lines?: string[];
    raw?: string;
    quality?: number | null;
};
export type DuplicateEvidenceSnapshot = {
    reportId: string;
    memberId: string;
    version: string;
    sourceVersion: number;
    sourceSignature: string | null;
    sourceComplete: boolean;
    issuer: string;
    scope: string;
    identifiers: Array<{
        type: string;
        value: string;
    }>;
    times: Partial<Record<'sampled' | 'examined' | 'issued' | 'printed', string>>;
    items: DuplicateFact[];
    unknown: number;
    risks: string[];
    narrative: string;
    narrativeReliable: boolean;
    extractionId: string | null;
    usable: boolean;
};
export type DuplicateFieldComparison = {
    key: string;
    state: EvidenceState;
    left?: DuplicateFact;
    right?: DuplicateFact;
};
export type DuplicateEvaluation = {
    ruleVersion: string;
    ruleId: string;
    stage: 'original' | 'ocr_pre' | 'ai_post';
    leftVersion: string;
    rightVersion: string;
    classification: DuplicateClassification;
    sameCount: number;
    uncertainCount: number;
    conflictCount: number;
    missingCount: number;
    anchors: number;
    coverage: [
        number,
        number
    ];
    risks: string[];
    support: string[];
    fields: DuplicateFieldComparison[];
    preGateEligible: boolean;
    reason: string;
};
export function normalizeEvidenceText(value: unknown) {
    return String(value || '').normalize('NFKC').toLowerCase().replace(/\s+/g, '').trim();
}
export function canonicalResult(value: string) {
    const text = normalizeEvidenceText(value).replace(/μ/g, 'µ');
    // Decimal canonicalization uses strings; never round a clinically meaningful value.
    return text.replace(/(^|[<>≤≥=])([+-]?)(\d+)(?:\.(\d+))?(?=$|[a-zµ%])/g, (_, op, sign, whole, fraction) => {
        const digits = whole.replace(/^0+(?=\d)/, '');
        const tail = (fraction || '').replace(/0+$/, '');
        return `${op}${sign === '+' ? '' : sign}${digits}${tail ? '.' + tail : ''}`;
    });
}
function sameResult(a: string, b: string) {
    const x = a.split('|'), y = b.split('|');
    if (x.length === 4 && y.length === 4) {
        return canonicalResult(x[0]) === canonicalResult(y[0]) && x[1] === y[1] && (!x[2] || !y[2] || x[2] === y[2]) && (!x[3] || !y[3] || x[3] === y[3]);
    }
    return canonicalResult(a) === canonicalResult(b);
}
function timeState(a?: string, b?: string): EvidenceState {
    if (!a || !b)
        return 'missing';
    const clean = (s: string) => s.replace(/[年月/.]/g, '-').replace(/日/g, '').replace('T', ' ').trim();
    const x = clean(a), y = clean(b);
    return x === y ? 'exact' : x.startsWith(y) || y.startsWith(x) ? 'compatible' : 'conflict';
}
export function evaluateDuplicatePair(a: DuplicateEvidenceSnapshot, b: DuplicateEvidenceSnapshot, stage: 'ocr_pre' | 'ai_post' = 'ocr_pre'): DuplicateEvaluation {
    const e: DuplicateEvaluation = { ruleVersion: currentReportDuplicateRuleVersion, ruleId: 'insufficient', stage, leftVersion: a.version, rightVersion: b.version, classification: 'insufficient', sameCount: 0, uncertainCount: 0, conflictCount: 0, missingCount: 0, anchors: 0, coverage: [0, 0], risks: [...new Set([...a.risks, ...b.risks])], support: [], fields: [], preGateEligible: false, reason: '证据不足，正常整理不受影响' };
    const finish = (classification: DuplicateClassification, ruleId: string, reason: string, eligible = false) => ({ ...e, classification, ruleId, reason, preGateEligible: eligible });
    if (a.memberId !== b.memberId)
        return finish('different', 'member', '不属于同一成员');
    if (a.sourceComplete && b.sourceComplete && a.sourceSignature && a.sourceSignature === b.sourceSignature) {
        e.stage = 'original';
        e.support = ['完整原件集合一致'];
        return finish('exact_duplicate', 'R0', '上传原件内容完全一致', true);
    }
    const issuer = !!a.issuer && a.issuer === b.issuer, scope = !!a.scope && a.scope === b.scope;
    const reportIds = (s: DuplicateEvidenceSnapshot) => s.identifiers.filter(x => x.type === 'report');
    const idsA = reportIds(a), idsB = reportIds(b);
    const sameId = issuer && scope && idsA.some(x => idsB.some(y => x.value === y.value));
    const differentId = issuer && scope && idsA.length > 0 && idsB.length > 0 && !sameId;
    if (sameId && JSON.stringify([...new Set(idsA.map(x => x.value))].sort()) !== JSON.stringify([...new Set(idsB.map(x => x.value))].sort()))
        return finish('insufficient', 'identity_ambiguous', '多个报告编号未能完整对应，继续正常整理');
    const eventStates = (['sampled', 'examined'] as const).map(k => ({ key: k, state: timeState(a.times[k], b.times[k]), strong: (a.times[k]?.length || 0) >= 16 && (b.times[k]?.length || 0) >= 16 }));
    const eventConflict = eventStates.some(x => x.state === 'conflict');
    const strongEvent = eventStates.some(x => x.strong && ['exact', 'compatible'].includes(x.state));
    const weakEvent = eventStates.some(x => ['exact', 'compatible'].includes(x.state)) || ['exact', 'compatible'].includes(timeState(a.times.issued, b.times.issued));
    e.support.push(...(sameId ? ['机构、报告编号及检查范围匹配'] : []), ...(strongEvent ? ['同类检查时间相容'] : weakEvent ? ['日期相容'] : []));
    const fieldFact = (key: string, value: string | undefined): DuplicateFact | undefined => value ? { key, value, reliable: true, anchor: false } : undefined;
    for (const t of eventStates)
        e.fields.push({ key: t.key, state: t.state, left: fieldFact(t.key, a.times[t.key]), right: fieldFact(t.key, b.times[t.key]) });
    for (const key of ['issuer', 'scope'] as const)
        e.fields.push({ key, state: !a[key] || !b[key] ? 'missing' : a[key] === b[key] ? 'exact' : 'conflict', left: fieldFact(key, a[key]), right: fieldFact(key, b[key]) });
    e.fields.push({ key: 'report_identity', state: sameId ? 'exact' : differentId ? 'conflict' : 'missing', left: fieldFact('report_identity', idsA.map(x => x.value).join('、')), right: fieldFact('report_identity', idsB.map(x => x.value).join('、')) });
    const keys = [...new Set([...a.items, ...b.items].map(x => x.key))].sort();
    for (const key of keys) {
        const left = a.items.filter(x => x.key === key).slice().sort((x, y) => canonicalResult(x.value).localeCompare(canonicalResult(y.value)));
        const right = b.items.filter(x => x.key === key).slice().sort((x, y) => canonicalResult(x.value).localeCompare(canonicalResult(y.value)));
        // Consume exact equivalents first, preserving multiplicity of repeated measurements.
        for (const x of [...left]) {
            const i = right.findIndex(y => sameResult(x.value, y.value));
            if (i < 0)
                continue;
            const y = right.splice(i, 1)[0];
            left.splice(left.indexOf(x), 1);
            const state: EvidenceState = x.reliable && y.reliable ? (x.value === y.value ? 'exact' : 'equivalent') : 'uncertain';
            e.fields.push({ key, state, left: x, right: y });
            if (state === 'uncertain')
                e.uncertainCount++;
            else {
                e.sameCount++;
                if (x.anchor && y.anchor)
                    e.anchors++;
            }
        }
        while (left.length || right.length) {
            const x = left.shift(), y = right.shift();
            const state: EvidenceState = !x || !y ? 'missing' : x.reliable && y.reliable ? 'conflict' : 'uncertain';
            e.fields.push({ key, state, left: x, right: y });
            if (state === 'missing')
                e.missingCount++;
            else if (state === 'conflict')
                e.conflictCount++;
            else
                e.uncertainCount++;
        }
    }
    let unknownLeft = a.unknown, unknownRight = b.unknown;
    for (const field of e.fields.filter(f => keys.includes(f.key) && f.state === 'missing' && (f.left || f.right))) {
        if (!field.left && unknownLeft > 0) {
            unknownLeft--;
            field.state = 'uncertain';
            e.missingCount--;
        }
        else if (!field.right && unknownRight > 0) {
            unknownRight--;
            field.state = 'uncertain';
            e.missingCount--;
        }
    }
    e.uncertainCount += Math.max(a.unknown, b.unknown);
    const n = Math.max(a.items.length + a.unknown, b.items.length + b.unknown);
    e.coverage = [a.items.length + a.unknown ? e.sameCount / (a.items.length + a.unknown) : 0, b.items.length + b.unknown ? e.sameCount / (b.items.length + b.unknown) : 0];
    const coverage = Math.min(...e.coverage);
    if (e.sameCount)
        e.support.push(`${e.sameCount} 项可靠结果匹配`);
    if (e.uncertainCount)
        e.support.push(`${e.uncertainCount} 项局部识别待核对`);
    if (eventConflict || differentId)
        return finish('different', 'R4.event', '报告编号或同类检查事件不同');
    const narrativeA = normalizeEvidenceText(a.narrative), narrativeB = normalizeEvidenceText(b.narrative);
    const narrativeConflict = !!narrativeA && !!narrativeB && narrativeA !== narrativeB && a.narrativeReliable && b.narrativeReliable;
    if (e.conflictCount || narrativeConflict || e.missingCount)
        return finish(sameId ? 'related_variant' : 'different', 'R4.content', sameId ? '报告编号相同，但内容存在差异，请核对是否为修订版' : '存在可靠差异或新增内容，保留两份报告');
    if (e.risks.length)
        return finish('insufficient', 'integrity', '页面或提取内容不完整，继续正常整理');
    const r1 = duplicateEvidencePolicy.r1, r2 = duplicateEvidencePolicy.r2;
    const unknown1 = e.uncertainCount <= Math.min(r1.maxUnknown, Math.floor(n * r1.unknownRatio));
    const auxiliary = a.identifiers.some(x => x.type !== 'report' && ['sample', 'exam', 'barcode'].includes(x.type) && b.identifiers.some(y => x.type === y.type && x.value === y.value));
    const r1Time = weakEvent || e.anchors >= 10 && auxiliary;
    const short = n > 0 && n <= 3 && strongEvent && e.sameCount === n && e.uncertainCount === 0;
    if (sameId && ((coverage >= r1.coverage && unknown1 && e.anchors >= r1.anchors && r1Time) || short))
        return finish('strong_duplicate', short ? 'R1.short' : 'R1', '报告身份与结果内容充分匹配', true);
    if (issuer && scope && strongEvent && coverage >= r2.coverage && e.uncertainCount <= r2.maxUnknown && e.uncertainCount <= n * r2.unknownRatio && e.sameCount >= r2.same && e.anchors >= r2.anchors)
        return finish('strong_duplicate', 'R2', '检查事件与高覆盖结果内容匹配', true);
    const post = duplicateEvidencePolicy.post;
    if (stage === 'ai_post' && issuer && scope && (sameId || strongEvent)) {
        const narrativeMatch = narrativeA.length >= post.narrativeCharacters && narrativeA === narrativeB && a.narrativeReliable && b.narrativeReliable;
        if (narrativeMatch && n === 0) {
            e.support.push('完整所见及结论匹配');
            return finish('possible_duplicate', 'R3.narrative', '整理已完成，完整检查内容相同，请核对是否重复');
        }
        if (coverage >= post.coverage && e.sameCount >= post.same && e.uncertainCount <= n * post.unknownRatio)
            return finish('possible_duplicate', 'R3.results', '整理已完成，请核对是否重复');
    }
    return e;
}
