import { measurementUnitPattern } from "./measurement-units.service";
import { createHash } from 'node:crypto';
import { getDatabase } from '../database/client';
import { rebuildOcrPages, localObservationsForLine } from './ai-input-planner.service';
import { duplicateEvidencePolicy, normalizeEvidenceText as norm, canonicalResult, type DuplicateEvidenceSnapshot, type DuplicateFact } from './report-duplicate-evidence';
import { currentReportDuplicateRuleVersion } from './report-duplicate-rules.service';
export function duplicateDigest(value: unknown) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function json<T>(s: string | null, fallback: T): T {
    try {
        return s ? JSON.parse(s) : fallback;
    }
    catch {
        return fallback;
    }
}
export function completeSourceSignature(reportId: string): string | null {
    const pages = getDatabase().prepare('SELECT sha256,mime_type,source_page_number,source_page_count FROM report_pages WHERE report_id=?').all(reportId) as Array<{
        sha256: string;
        mime_type: string;
        source_page_number: number | null;
        source_page_count: number | null;
    }>;
    if (!pages.length || pages.some(p => !p.sha256 || p.mime_type === 'application/pdf' && (!Number.isInteger(p.source_page_count) || !Number.isInteger(p.source_page_number) || (p.source_page_count || 0) < 1 || (p.source_page_number || 0) < 1 || p.source_page_number! > p.source_page_count!)))
        return null;
    return duplicateDigest(pages.map(p => `${p.sha256}:${p.source_page_number || 0}:${p.source_page_count || 0}`).sort());
}
const identifierTypes: Record<string, string> = { 报告号: 'report', 报告编号: 'report', reportNumber: 'report', reportNo: 'report', reportId: 'report', 标本号: 'sample', sampleNumber: 'sample', sampleNo: 'sample', 检查号: 'exam', examNumber: 'exam', 条码号: 'barcode', barcode: 'barcode' };
const typedTimes: Record<string, 'sampled' | 'examined' | 'issued' | 'printed'> = { 采样时间: 'sampled', 采样日期: 'sampled', 采集时间: 'sampled', 检查时间: 'examined', 检查日期: 'examined', 报告时间: 'issued', 报告日期: 'issued', 打印时间: 'printed' };
function shiftDecimalThree(value: string) {
    return value.replace(/[+-]?\d+(?:\.\d+)?/g, token => {
        const negative = token.startsWith('-'), unsigned = token.replace(/^[+-]/, '');
        const [whole, fraction = ''] = unsigned.split('.');
        return canonicalResult(`${negative ? '-' : ''}${whole}${(fraction + '000').slice(0, 3)}.${fraction.slice(3) || '0'}`);
    });
}
export function numericFactValue(result: string, unit: string | null, reference: string | null, flag: string | null) {
    // Only dimension-preserving, exact decimal shifts. No guessed analyte conversions.
    let u = norm(unit).replace(/μ/g, 'µ');
    const raw = norm(result).replace(/μ/g, 'µ');
    let value = canonicalResult(u && raw.endsWith(u) ? raw.slice(0, -u.length) : raw), ref = norm(reference);
    if (u === 'g/l' && /^[<>≤≥]?[+-]?\d+(\.\d+)?$/.test(value)) {
        value = shiftDecimalThree(value);
        ref = shiftDecimalThree(ref);
        u = 'mg/l';
    }
    return `${value}|${u}|${ref}|${norm(flag)}`;
}
export function buildDuplicateSnapshot(reportId: string): DuplicateEvidenceSnapshot | null {
    const db = getDatabase();
    const r = db.prepare("SELECT * FROM reports WHERE id=? AND status<>'trashed'").get(reportId) as Record<string, any> | undefined;
    if (!r)
        return null;
    const pages = db.prepare(`SELECT p.id AS pageId,p.page_number AS pageNumber,p.mime_type AS mimeType,p.source_page_number AS sourcePageNumber,p.source_page_count AS sourcePageCount,
 o.id AS ocrId,o.lines_json AS linesJson,o.quality_level AS qualityLevel,o.created_at AS ocrCreated
 FROM report_pages p LEFT JOIN ocr_results o ON o.id=(SELECT o2.id FROM ocr_results o2 JOIN processing_jobs j ON j.id=o2.job_id WHERE o2.page_id=p.id AND j.status='completed' ORDER BY o2.created_at DESC,o2.id DESC LIMIT 1)
 WHERE p.report_id=? ORDER BY p.page_number,p.id`).all(reportId) as Array<{
        pageId: string;
        pageNumber: number;
        mimeType: string;
        sourcePageNumber: number | null;
        sourcePageCount: number | null;
        ocrId: string | null;
        linesJson: string | null;
        qualityLevel: string | null;
        ocrCreated: string | null;
    }>;
    const signature = completeSourceSignature(reportId);
    const risks: string[] = [];
    if (!signature)
        risks.push('source_incomplete');
    if (!pages.length || pages.some(p => !p.linesJson))
        risks.push('ocr_page_missing');
    if (pages.some(p => p.qualityLevel === 'poor'))
        risks.push('ocr_page_poor');
    const budget = pages.reduce((n, p) => n + (p.linesJson?.length || 0), 0) > duplicateEvidencePolicy.maxCharacters;
    if (budget)
        risks.push('content_budget_exceeded');
    const raw = budget ? [] : pages.flatMap(p => json<Array<{
        id?: string;
        text?: string;
        confidence?: number;
    }>>(p.linesJson, []).map(l => ({ ...l, page: p.pageNumber })));
    const reliableText = raw.filter(l => typeof l.confidence === 'number' && l.confidence >= duplicateEvidencePolicy.ocrReliable).map(l => l.text || '').join('\n');
    const text = raw.map(l => l.text || '').join('\n');
    if (pages.some(p => !raw.some(l => l.page === p.pageNumber && l.text?.trim())))
        risks.push('ocr_page_empty');
    if (/修订|更正|补充结果|补发|追加结果/.test(text))
        risks.push('revision_note');
    const metadata = json<Record<string, unknown>>(r.identifiers_json, {});
    const identifiers = Object.entries(metadata).flatMap(([k, v]) => identifierTypes[k] && typeof v === 'string' && norm(reliableText).includes(norm(v)) ? [{ type: identifierTypes[k], value: norm(v) }] : []);
    for (const m of reliableText.matchAll(/(报告号|报告编号|标本号|检查号|条码号)\s*[:：]\s*([A-Za-z0-9][A-Za-z0-9./_-]*)/g))
        identifiers.push({ type: identifierTypes[m[1]], value: norm(m[2]) });
    const times: DuplicateEvidenceSnapshot['times'] = {};
    for (const [k, column] of [['sampled', 'sampled_at'], ['examined', 'examined_at'], ['issued', 'report_issued_at']] as const)
        if (r[column])
            times[k] = String(r[column]);
    for (const [label, key] of Object.entries(typedTimes)) {
        const match = reliableText.match(new RegExp(`${label}\\s*[:：]?[ \\t]*(\\d{4}[-/.年]\\d{1,2}[-/.月]\\d{1,2}日?(?:[ T]\\d{2}:\\d{2}(?::\\d{2})?)?)`));
        if (match && !times[key])
            times[key] = match[1];
    }
    const issuer = norm(r.hospital_name_raw || reliableText.match(/(?:机构|医院名称)\s*[:：]\s*([^\n]+)/)?.[1] || raw.find(l => (l.confidence || 0) >= duplicateEvidencePolicy.ocrReliable && /医院\s*$/.test(l.text || ''))?.text);
    const scope = norm(reliableText.match(/(?:检查项目|检验项目|检查范围|报告名称)\s*[:：]\s*([^\n]+)/)?.[1] || ((r.title && !['待识别报告', '健康体检报告'].includes(r.title)) ? r.title : ''));
    const extraction = db.prepare('SELECT id,job_id,fields_json,evidence_json,confidence_json FROM report_extractions WHERE report_id=? ORDER BY created_at DESC,id DESC LIMIT 1').get(reportId) as {
        id: string;
        job_id: string;
        fields_json: string;
        evidence_json: string;
        confidence_json: string;
    } | undefined;
    const runtime = db.prepare('SELECT * FROM report_duplicate_runtime WHERE report_id=?').get(reportId) as Record<string, any> | undefined;
    const currentResult = !!extraction && runtime?.result_signature === signature && runtime?.extraction_id === extraction.id;
    const items: DuplicateFact[] = [];
    let unknown = 0;
    const rebuilt = budget || !pages.some(p => p.linesJson) ? [] : rebuildOcrPages(pages.filter(p => p.linesJson).map(p => ({ ...p, linesJson: p.linesJson! })));
    const unitPattern = measurementUnitPattern();
    for (const page of rebuilt)
        for (const line of page.lines) {
            const facts = localObservationsForLine(line);
            const sourceLines = raw.filter(l => l.page === page.pageNumber && !!l.id && line.sourceLineIds.includes(l.id));
            const quality = sourceLines.length && sourceLines.every(l => typeof l.confidence === 'number') ? Math.min(...sourceLines.map(l => l.confidence!)) : null;
            const reliable = quality !== null && quality >= duplicateEvidencePolicy.ocrReliable && !line.tableStructureUnsafe;
            // Conservative adapter for already reconstructed, single result rows without a table header.
            // Ambiguous / multi-column rows stay in the planner's unparsed candidate denominator.
            let fallback = false;
            if (!facts.length && line.candidateKind === 'scalar' && !line.tableStructureUnsafe) {
                const m = line.text.match(/^([^\d<>≤≥]+?)\s+([<>≤≥]?[+-]?\d+(?:\.\d+)?|阴性|阳性|[-+]{1,3})\s+(\S+)(?:\s+([<>≤≥]?[+-]?\d+(?:\.\d+)?(?:\s*[-~～]\s*[+-]?\d+(?:\.\d+)?)?))?\s*$/);
                if (m && unitPattern.test(m[3])) {
                    const alias = line.dictionaryFacts.find(f => norm(f.alias) === norm(m[1]));
                    items.push({ key: [norm(alias?.displayName || m[1]), norm(line.sectionName), ''].join('|'), value: numericFactValue(m[2], m[3], m[4] || null, null), reliable, anchor: /\d/.test(m[2]), page: page.pageNumber, lines: line.sourceLineIds, raw: line.text, quality });
                    fallback = true;
                }
            }
            for (const f of facts)
                items.push({ key: [norm(f.normalizedName || f.itemName), norm(f.sectionName), ''].join('|'), value: numericFactValue(f.resultText, f.unit, f.referenceText, f.abnormalFlag), reliable, anchor: f.numericValue !== null, page: page.pageNumber, lines: line.sourceLineIds, raw: f.sourceText, quality: line.confidence });
            if (line.candidateKind === 'scalar')
                unknown += Math.max(0, (line.expectedLocalObservationCount || 1) - facts.length - (fallback ? 1 : 0));
        }
    // Structured rows replace their OCR facts by source reference, never add a second vote.
    if (currentResult) {
        const observations = db.prepare('SELECT * FROM observations WHERE report_id=? ORDER BY id').all(reportId) as Array<Record<string, any>>;
        const structured: DuplicateFact[] = [];
        for (const o of observations) {
            const refs = json<any>(o.evidence_json, []);
            const entries = Array.isArray(refs) ? refs : [refs];
            const matched = raw.filter(l => entries.some((x: any) => x.pageNumber === l.page && ((x.lineIds || x.sourceLineIds || []).includes(l.id) || typeof x.quote === 'string' && norm(x.quote) === norm(l.text))));
            const sourceReliable = matched.length > 0 && matched.every(l => typeof l.confidence === 'number' && l.confidence >= duplicateEvidencePolicy.ocrReliable);
            structured.push({ key: [norm(o.normalized_name || o.item_name), norm(o.section_name), norm(o.method)].join('|'), value: numericFactValue(o.result_text, o.unit, o.reference_text, o.abnormal_flag), reliable: sourceReliable, anchor: o.numeric_value !== null, raw: o.result_text, lines: matched.flatMap(l => l.id ? [l.id] : []) });
        }
        // Structured results replace OCR facts, retaining weak/unsubstantiated rows as uncertain.
        if (structured.length) {
            const candidateTotal = items.length + unknown;
            items.splice(0, items.length, ...structured);
            unknown = Math.max(0, candidateTotal - structured.length);
        }
        const unresolved = db.prepare("SELECT COUNT(*) AS n FROM ai_extraction_candidates WHERE job_id=? AND status='unresolved'").get(extraction.job_id) as {
            n: number;
        };
        unknown = Math.max(unknown, unresolved.n);
    }
    if (items.length > duplicateEvidencePolicy.maxItems) {
        items.length = duplicateEvidencePolicy.maxItems;
        risks.push('item_budget_exceeded');
    }
    const sections = db.prepare('SELECT section_key,content_text,content_json,evidence_json FROM report_structured_sections WHERE report_id=? AND is_deleted=0 ORDER BY section_key,id').all(reportId) as Array<{
        section_key: string;
        content_text: string;
        content_json: string | null;
        evidence_json: string;
    }>;
    const narrativeParts = [r.findings, r.impression, ...sections.map(s => s.content_text)].filter(Boolean) as string[];
    const narrative = narrativeParts.join('\n');
    const narrativeReliable = currentResult && !!narrative && raw.length > 0 && raw.every(l => typeof l.confidence === 'number' && l.confidence >= duplicateEvidencePolicy.ocrReliable) && narrativeParts.every(part => norm(text).includes(norm(part)));
    if (narrativeReliable && rebuilt.some(p => p.lines.some(l => ['narrative', 'morphology'].includes(l.role) && l.text.length > 20 && !norm(narrative).includes(norm(l.text).replace(/^(检查所见|诊断结论|所见|结论)[:：]/, '')))))
        risks.push('narrative_uncovered');
    const hasStoredResults = !!db.prepare('SELECT 1 FROM observations WHERE report_id=? LIMIT 1').get(reportId) || !!db.prepare("SELECT 1 FROM report_structured_sections WHERE report_id=? AND is_deleted=0 LIMIT 1").get(reportId);
    const active = !!db.prepare("SELECT 1 FROM processing_jobs WHERE report_id=? AND status IN ('queued','processing') LIMIT 1").get(reportId) || !!db.prepare("SELECT 1 FROM report_page_appends WHERE report_id=? AND state NOT IN ('complete','noop','cancelled','ocr_only')").get(reportId);
    const overrides = db.prepare('SELECT field_key,value_json FROM report_field_overrides WHERE report_id=? ORDER BY field_key').all(reportId);
    const observationOverrides = db.prepare('SELECT source_key,fields_json FROM observation_field_overrides WHERE report_id=? ORDER BY source_key').all(reportId);
    const dictionaryVersion = db.prepare("SELECT layer,revision,content_sha256 FROM indicator_dictionary_state ORDER BY layer").all();
    const version = duplicateDigest([dictionaryVersion, sections, currentReportDuplicateRuleVersion, r.source_version, signature, pages.map(p => [p.ocrId, p.linesJson]), extraction, items, overrides, observationOverrides, r.identifiers_json, r.sampled_at, r.examined_at, r.report_issued_at, r.findings, r.impression, r.title, r.hospital_name_raw]);
    return { reportId, memberId: r.member_id, version, sourceVersion: r.source_version, sourceSignature: signature, sourceComplete: !!signature, issuer, scope, identifiers, times, items, unknown, risks, narrative, narrativeReliable, extractionId: currentResult ? extraction!.id : null, usable: currentResult && !active && !risks.length && (hasStoredResults && items.length > 0 && items.filter(item => item.reliable).length / (items.length + unknown) >= duplicateEvidencePolicy.usableCoverage || narrativeReliable) };
}
export function markDuplicateResultCurrent(reportId: string) {
    const db = getDatabase(), signature = completeSourceSignature(reportId);
    const extraction = db.prepare('SELECT id FROM report_extractions WHERE report_id=? ORDER BY created_at DESC,id DESC LIMIT 1').get(reportId) as {
        id: string;
    } | undefined;
    if (!extraction || !signature)
        return;
    db.prepare(`INSERT INTO report_duplicate_runtime(report_id,result_signature,extraction_id) VALUES(?,?,?) ON CONFLICT(report_id) DO UPDATE SET result_signature=excluded.result_signature,extraction_id=excluded.extraction_id,pause_json=NULL,updated_at=CURRENT_TIMESTAMP`).run(reportId, signature, extraction.id);
}
