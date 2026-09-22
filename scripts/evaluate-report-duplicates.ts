/** Synthetic, independently constructed families. No files, OCR/AI requests or user database. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { closeDatabaseForTests, getDatabase } from '../packages/server/database/client';
import { buildDuplicateSnapshot, markDuplicateResultCurrent } from '../packages/server/services/report-duplicate-snapshot.service';
import { findLocalDuplicateEvidence, recallDuplicateCandidates } from '../packages/server/services/report-duplicate-precheck.service';
import { evaluateDuplicatePair } from '../packages/server/services/report-duplicate-evidence';
const storage = mkdtempSync(join(tmpdir(), 'synthetic-duplicate-evaluation-'));
const prior = process.env.STORAGE_DIR;
process.env.STORAGE_DIR = storage;
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
type Case = {
    category: string;
    duplicate: boolean;
    n: number;
    noise?: number;
    noId?: boolean;
    shortRead?: boolean;
    changed?: boolean;
    added?: boolean;
    missing?: boolean;
    narrative?: boolean;
    sameSource?: boolean;
    nextDay?: boolean;
};
const cases: Case[] = [
    { category: '完整原件', duplicate: true, n: 20, sameSource: true },
    { category: '强编号', duplicate: true, n: 20 },
    { category: '无编号', duplicate: true, n: 20, noId: true },
    { category: '识别噪声', duplicate: true, n: 20, noise: 2 },
    { category: '短报告', duplicate: true, n: 3 },
    { category: '短报告不足', duplicate: true, n: 3, shortRead: true },
    { category: '复杂叙事', duplicate: true, n: 0, narrative: true },
    { category: '真实差异', duplicate: false, n: 20, changed: true },
    { category: '缺页内容', duplicate: false, n: 20, missing: true },
    { category: '新增内容', duplicate: false, n: 20, added: true },
    { category: '正常复查', duplicate: false, n: 20, nextDay: true },
    { category: '后置补检', duplicate: true, n: 5, noise: 1 },
];
const narrative = '合成影像所见：左侧指定区域存在明确位置的局部改变，尺寸与边缘状态均已逐项记录；右侧区域形态连续且回声均匀，检查涵盖全部指定范围，结论与完整所见相互对应。';
try {
    const db = getDatabase();
    db.prepare("INSERT INTO users(id,display_name) VALUES('synthetic-eval','合成评测')").run();
    for (const split of ['calibration', 'validation']) {
        const started = performance.now();
        let retrieved = 0, recall = 0, truePause = 0, falsePause = 0, postExtra = 0, falsePositive = 0, insufficient = 0, comparisons = 0;
        const categories: Record<string, unknown> = {};
        for (const [index, c] of cases.entries()) {
            const family = `${split}-${index}`, member = `member-${family}`, a = `left-${family}`, b = `right-${family}`;
            db.prepare("INSERT INTO health_members(id,display_name,relationship,created_by) VALUES(?,'合成成员','other','synthetic-eval')").run(member);
            for (const [id, right] of [[a, false], [b, true]] as const) {
                const valueOffset = split === 'calibration' ? 10 : 70;
                const number = c.n + (right && c.added ? 1 : 0) - (right && c.missing ? 1 : 0);
                const lines = [`机构：合成${family}医院`, `报告名称：合成${family}面板`, ...(c.noId ? [] : [`报告号：SYN-${family}`]), `采样时间：2026-01-${right && c.nextDay ? '02' : '01'} 09:00`, ...(c.narrative ? [narrative] : Array.from({ length: number }, (_, i) => `合成项目${String.fromCharCode(65 + i)} ${valueOffset + i + (right && c.changed && i === 0 ? .01 : 0)}.1 mmol/L 0-999`))].map((text, i) => ({ id: `line-${i}`, text, confidence: right && i >= 4 && i < 4 + (c.shortRead ? 2 : c.noise || 0) ? .3 : .99, box: [0, i * 20, 600, i * 20 + 14] }));
                // Changed result is constructed explicitly, not labeled from evaluator output.
                if (right && c.changed)
                    lines[4].text = `合成项目A ${valueOffset}.11 mmol/L 0-999`;
                db.prepare("INSERT INTO reports(id,member_id,created_by,report_type,title,status) VALUES(?,?,'synthetic-eval','laboratory','合成面板','needs_review')").run(id, member);
                db.prepare("INSERT INTO report_pages(id,report_id,page_number,original_name,storage_path,mime_type,file_size,sha256) VALUES(?,?,1,'synthetic.png',?,'image/png',1,?)").run(`p-${id}`, id, `synthetic/${id}`, hash(c.sameSource ? family : id));
                db.prepare("INSERT INTO processing_jobs(id,report_id,page_id,job_type,status,pipeline_version,deduplication_key) VALUES(?,?,?,'ocr','completed','synthetic',?)").run(`ocr-${id}`, id, `p-${id}`, `ocr-${id}`);
                db.prepare("INSERT INTO ocr_results(id,job_id,page_id,engine,model_version,lines_json) VALUES(?,?,?,'synthetic','synthetic',?)").run(`o-${id}`, `ocr-${id}`, `p-${id}`, JSON.stringify(lines));
            }
            const complete = (id: string) => {
                db.prepare("INSERT INTO processing_jobs(id,report_id,job_type,status,pipeline_version,deduplication_key) VALUES(?,?,'ai_extract','completed','synthetic',?)").run(`ai-${id}`, id, `ai-${id}`);
                db.prepare("INSERT INTO report_extractions(id,report_id,job_id,provider,model,prompt_version,fields_json,raw_response_json) VALUES(?,?,?,'synthetic','synthetic','synthetic','{}','{}')").run(`e-${id}`, id, `ai-${id}`);
                if (c.narrative)
                    db.prepare('UPDATE reports SET findings=? WHERE id=?').run(narrative, id);
                else
                    for (const [i, f] of buildDuplicateSnapshot(id)!.items.entries())
                        db.prepare('INSERT INTO observations(id,report_id,item_name,result_text,numeric_value,unit,evidence_json) VALUES(?,?,?,?,?,?,?)').run(`obs-${id}-${i}`, id, f.key.split('|')[0], f.value.split('|')[0], Number(f.value.split('|')[0]), f.value.split('|')[1],JSON.stringify([{pageNumber:f.page||1,lineIds:f.lines||[]}]));
                markDuplicateResultCurrent(id);
            };
            complete(a);
            if (c.duplicate && recallDuplicateCandidates(buildDuplicateSnapshot(b)!).ids.includes(a))
                retrieved++;
            const pre = findLocalDuplicateEvidence(b).find(x => x.reportId === a);
            if (c.duplicate && pre)
                recall++;
            const paused = !!pre?.pauseEligible;
            if (paused) {
                if (c.duplicate)
                    truePause++;
                else
                    falsePause++;
            }
            complete(b);
            const post = evaluateDuplicatePair(buildDuplicateSnapshot(a)!, buildDuplicateSnapshot(b)!, 'ai_post');
            comparisons += 2;
            const detected = ['exact_duplicate', 'strong_duplicate', 'possible_duplicate'].includes(post.classification);
            if (c.duplicate && !paused && detected)
                postExtra++;
            if (!c.duplicate && (paused || detected))
                falsePositive++;
            if (post.classification === 'insufficient')
                insufficient++;
            categories[c.category] = { samples: 1, truth: c.duplicate ? 'duplicate' : 'different_version_or_event', paused, post: post.classification };
        }
        const positives = cases.filter(c => c.duplicate).length;
        // All reports in this corpus have one same-member partner, inside the bounded retrieval window.
        console.log(JSON.stringify({ split, samples: cases.length, positiveFamilies: positives, candidateRetrievalRecall: retrieved / positives, preQualifiedCandidateRecall: recall / positives, truePause, falsePause, falseBlockShare: falsePause / Math.max(1, truePause + falsePause), trueDuplicatePreRecall: truePause / positives, postExtra, postAdditionalRecall: postExtra / positives, totalDuplicateRecall: (truePause + postExtra) / positives, normalOrRevisionFalsePositive: falsePositive, insufficient, comparisons, elapsedMs: Math.round(performance.now() - started), categories }, null, 2));
    }
}
finally {
    closeDatabaseForTests();
    if (prior === undefined)
        delete process.env.STORAGE_DIR;
    else
        process.env.STORAGE_DIR = prior;
    rmSync(storage, { recursive: true, force: true });
}
