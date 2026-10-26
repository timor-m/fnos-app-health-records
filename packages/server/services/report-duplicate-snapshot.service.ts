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
function rowGeometry(box: unknown) {
    if (!Array.isArray(box)) return null;
    const points=box.flat();
    if (![4,8].includes(points.length)||!points.every(Number.isFinite)) return null;
    const ys=points.length===4?[points[1],points[3]]:points.filter((_,i)=>i%2===1);
    const top=Math.min(...ys),bottom=Math.max(...ys);
    return bottom>top?{center:(top+bottom)/2,height:bottom-top}:null;
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
    }>>(p.linesJson, []).map(l => ({ ...l, page: p.pageNumber, pageId:p.pageId })));
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
    let photoItems:DuplicateFact[]|undefined;
    let photoUnknown:number|undefined;
    const photoRows:DuplicateFact[]=[];
    let photoRowUnknown=0;
    const rebuilt = budget || !pages.some(p => p.linesJson) ? [] : rebuildOcrPages(pages.filter(p => p.linesJson).map(p => ({ ...p, linesJson: p.linesJson! })));
    const unitPattern = measurementUnitPattern();
    const exactUnitPattern=new RegExp(`^(?:${unitPattern.source})$`,unitPattern.flags.replace(/g/g,''));
    // Advisory-only literal table rows: preserve every numeric column in source order.
    // This can compare two photographs even when AI extracted different subsets of rows.
    for(const page of rebuilt)for(const line of page.lines){
        let cells=line.sourceCells||[];
        if(cells.length<3)continue;
        if(/^\d{1,3}$/.test(cells[0].text.trim())&&/[\p{L}]/u.test(cells[1].text))cells=cells.slice(1);
        const numeric=cells.filter(c=>/^[<>≤≥]?[+-]?\d+(?:\.\d+)?(?:\s*[-~～]\s*[+-]?\d+(?:\.\d+)?)?(?:\s*[↑↓hl])?$/i.test(c.text.trim()));
        const units=cells.filter(c=>/^[a-zµμ][a-zµμ\d%‰/^²³·.*×+\-]*$/i.test(norm(c.text))&&(/[/%‰]/.test(c.text)||exactUnitPattern.test(c.text.trim())));
        const names=cells.filter(c=>!numeric.includes(c)&&!units.includes(c)&&/[\p{L}]{2}/u.test(norm(c.text)));
        if(!numeric.length||!names.length)continue;
        if(units.length!==1){photoRowUnknown++;continue;}
        if(!exactUnitPattern.test(units[0].text.trim())){photoRowUnknown++;continue;}
        const result=numeric[0];const box=rowGeometry(result.box);
        if(!box||cells.some(c=>{const cell=rowGeometry(c.box);return !cell||Math.abs(cell.center-box.center)>Math.max(cell.height,box.height)*.75;})){photoRowUnknown++;continue;}
        const source=raw.filter(l=>l.page===page.pageNumber&&l.id&&cells.some(c=>c.sourceLineIds.includes(l.id!)));
        const reliable=source.length>0&&cells.every(c=>c.sourceLineIds.length>0&&c.sourceLineIds.every(id=>source.some(l=>l.id===id)))&&source.every(l=>typeof l.confidence==='number'&&l.confidence>=duplicateEvidencePolicy.ocrReliable);
        photoRows.push({key:[names.map(c=>norm(c.text)).join('/'),norm(line.sectionName),'literal_row'].join('|'),
            value:`${numeric.map(c=>canonicalResult(c.text)).join(';')}|${norm(units[0].text)}||`,
            anchor:true,anchorValue:canonicalResult(result.text),reliable,page:page.pageNumber,lines:source.flatMap(l=>l.id?[l.id]:[])});
    }
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
        const photo:DuplicateFact[]=[];
        const replaced = new Set<DuplicateFact>();
        for (const o of observations) {
            const refs = json<any>(o.evidence_json, []);
            const entries = Array.isArray(refs) ? refs : [refs];
            const matched = raw.filter(l => entries.some((x: any) => {
                if(!x||typeof x!=='object')return false;
                if(x.pageId ? x.pageId!==l.pageId : x.pageNumber!==l.page)return false;
                if(x.pageNumber!==undefined&&x.pageNumber!==l.page)return false;
                const ids=x.lineIds||x.sourceLineIds||x.table?.rowSourceLineIds||[];
                if(Array.isArray(ids)&&l.id&&ids.includes(l.id))return true;
                const quote:string=typeof x.quote==='string'?x.quote:typeof x.sourceText==='string'?x.sourceText:'';
                // Persisted quotes may combine reconstructed table cells with '|'.
                // Only exact original-line fragments count as evidence, not substring similarity.
                return !!norm(l.text)&&quote.split(/[|｜\n]/).some(fragment=>norm(fragment)===norm(l.text)
                    ||fragment.trim().split(/\s+/).some(token=>norm(token)===norm(l.text)));
            }));
            const value=numericFactValue(o.result_text,o.unit,o.reference_text,o.abnormal_flag);
            const sourceFacts=items.filter(f=>!replaced.has(f)&&matched.some(l=>l.page===f.page&&l.id&&f.lines?.includes(l.id)));
            const sameValue=(f:DuplicateFact)=>f.value.split('|').slice(0,2).join('|')===value.split('|').slice(0,2).join('|');
            const named=sourceFacts.filter(f=>f.key.split('|')[0]===norm(o.normalized_name||o.item_name));
            const valued=sourceFacts.filter(sameValue);
            const sourceFact=named.length===1?named[0]:valued.length===1?valued[0]:sourceFacts.length===1?sourceFacts[0]:undefined;
            if(sourceFact)replaced.add(sourceFact);
            const sourceText=norm(matched.map(l=>l.text).join(' '));
            const sourceNumbers=matched.flatMap(l=>(String(l.text||'').match(/[<>≤≥]?[+-]?\d+(?:\.\d+)?/g)||[])).map(canonicalResult);
            const literalResult=sourceNumbers.includes(canonicalResult(o.result_text));
            const literalSupport=!!norm(o.item_name)&&sourceText.includes(norm(o.item_name))&&literalResult
                &&!!norm(o.unit)&&sourceText.includes(norm(o.unit));
            const sourceReliable = matched.length > 0 && matched.every(l => typeof l.confidence === 'number' && l.confidence >= duplicateEvidencePolicy.ocrReliable)
                &&(sourceFact?sameValue(sourceFact)&&(sourceFact.reliable||literalSupport):literalSupport);
            const section=norm(o.section_name);
            // AI display grouping is not report identity. Keep source context and explicit
            // specimen/laterality/timing distinctions instead of arbitrary generated headings.
            const protectedSection=/(尿|粪|便|痰|血清|血浆|全血|脑脊液|胸水|腹水|左|右|空腹|餐后|随机|负荷|运动|urine|stool|serum|plasma|wholeblood|left|right|fasting|postprandial)/.test(section);
            const key=sourceFact
                ?[sourceFact.key.split('|')[0],protectedSection?section:sourceFact.key.split('|')[1],norm(o.method)].join('|')
                :[norm(o.normalized_name||o.item_name),section,norm(o.method)].join('|');
            const fact={key:[norm(o.normalized_name||o.item_name),section,norm(o.method)].join('|'),value,
                reliable:sourceReliable,anchor:o.numeric_value!==null,raw:o.result_text,
                page:matched[0]?.page,lines:matched.flatMap(l=>l.id?[l.id]:[])};
            structured.push(fact);
            // Only the advisory tier ignores generated display headings. Clinical context remains.
            const aiSources=matched.filter(l=>typeof l.confidence==='number'&&l.confidence>=duplicateEvidencePolicy.ocrReliable);
            const aiSourceText=norm(aiSources.map(l=>l.text).join(' '));
            const aiSourceNumbers=aiSources.flatMap(l=>(String(l.text||'').match(/[<>≤≥]?[+-]?\d+(?:\.\d+)?/g)||[])).map(canonicalResult);
            const aiNames=String(o.item_name||'').trim().split(/\s+/);
            const aiValues=String(o.result_text||'').trim().split(/\s+/);
            // Some completed extractions retain an entire name/result column in one row.
            // Only expand equally sized, ordered columns supported by their saved quotation.
            const grouped=aiNames.length>=3&&aiNames.length===aiValues.length
                &&aiNames.every(name=>/[\p{L}]{2}/u.test(name))
                &&aiValues.every(v=>/^[<>≤≥]?[+-]?\d+(?:\.\d+)?$/.test(v));
            if(grouped){
                for(const [i,name] of aiNames.entries()){
                    const result=aiValues[i];
                    const supported=aiSourceText.includes(norm(name))
                        &&aiSourceNumbers.includes(canonicalResult(result));
                    photo.push({...fact,key:[norm(name),protectedSection?section:'',norm(o.method)].join('|'),
                        value:`${canonicalResult(result)}|||`,anchorValue:canonicalResult(result),anchor:true,reliable:supported});
                }
            }else{
                photo.push({...fact,key:sourceFact?key:[norm(o.normalized_name||o.item_name),protectedSection?section:'',norm(o.method)].join('|'),
                    reliable:sourceReliable||(!!norm(o.item_name)&&aiSourceText.includes(norm(o.item_name))&&aiSourceNumbers.includes(canonicalResult(o.result_text))),
                    anchorValue:canonicalResult(o.result_text)});
            }
        }
        // Strict coverage keeps its conservative parser denominator. Advisory coverage uses
        // grounded measurements, not speculative counts from unsafe reconstructed table cells.
        if (structured.length) {
            const remaining=items.filter(f=>!replaced.has(f));
            photoItems=[...remaining,...photo];
            const candidateTotal=items.length+unknown;
            items.splice(0,items.length,...structured);
            unknown=Math.max(0,candidateTotal-structured.length);
        }
        const unresolved = db.prepare("SELECT COUNT(*) AS n FROM ai_extraction_candidates WHERE job_id=? AND status='unresolved'").get(extraction.job_id) as {
            n: number;
        };
        unknown = Math.max(unknown, unresolved.n);
        const unresolvedRows=db.prepare("SELECT page_number AS page,source_line_ids_json AS lines,dictionary_keys_json AS keys FROM ai_extraction_candidates WHERE job_id=? AND status='unresolved' AND kind='scalar'").all(extraction.job_id) as Array<{page:number;lines:string;keys:string}>;
        photoUnknown=unresolvedRows.filter(row=>json<string[]>(row.keys,[]).length>0
            &&!photoItems?.some(f=>f.page===row.page&&f.lines?.some(id=>json<string[]>(row.lines,[]).includes(id)))).length;
    }
    if (items.length > duplicateEvidencePolicy.maxItems) {
        items.length = duplicateEvidencePolicy.maxItems;
        risks.push('item_budget_exceeded');
    }
    if(photoItems&&photoItems.length>duplicateEvidencePolicy.maxItems){
        photoItems.length=duplicateEvidencePolicy.maxItems;
        if(!risks.includes('item_budget_exceeded'))risks.push('item_budget_exceeded');
    }
    if(photoRows.length>duplicateEvidencePolicy.maxItems){photoRows.length=duplicateEvidencePolicy.maxItems;if(!risks.includes('item_budget_exceeded'))risks.push('item_budget_exceeded');}
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
    const version = duplicateDigest([dictionaryVersion, sections, currentReportDuplicateRuleVersion, r.source_version, signature, pages.map(p => [p.ocrId, p.linesJson]), extraction, items, photoItems, photoUnknown, photoRows, photoRowUnknown, overrides, observationOverrides, r.identifiers_json, r.sampled_at, r.examined_at, r.report_issued_at, r.findings, r.impression, r.title, r.hospital_name_raw]);
    return { reportId, memberId: r.member_id, version, sourceVersion: r.source_version, sourceSignature: signature, sourceComplete: !!signature, issuer, scope, identifiers, times, items, unknown, photoItems, photoUnknown, photoRows, photoRowUnknown, risks, narrative, narrativeReliable, extractionId: currentResult ? extraction!.id : null, usable: currentResult && !active && !risks.length && (hasStoredResults && items.length > 0 && items.filter(item => item.reliable).length / (items.length + unknown) >= duplicateEvidencePolicy.usableCoverage || narrativeReliable) };
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
