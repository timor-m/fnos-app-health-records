import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, readFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDatabase, closeDatabaseForTests } from '../database/client';
import type { RequestUser } from '../domain/request-user';
import { createUpload } from '../services/upload.service';
import { saveAiSettings } from '../services/ai-settings.service';
import { processNextJob, type WorkerExecutor } from '../services/job-runner.service';
import { normalizeAiExtraction, type AiExecutor, persistAiExtraction } from '../services/ai-extraction.service';
import { createManualObservation, updateManualObservation, deleteManualObservation, observationSourceKey } from '../services/observation-field-overrides.service';
import { getReportDetail, updateReportFields, permanentlyDeleteReport, listTrendSeries, confirmReportReady } from '../services/records.service';
import {captureCombinationSnapshot,combinationContentFingerprint,previewCombinationUndo,undoReportCombination} from '../services/report-combination-recovery.service';
import { previewReportCombination, combineReports } from '../services/report-combination.service';
import { startPageAppend, cancelPageAppend } from '../services/page-append.service';
import { getReportExaminations, saveReportExamination } from '../services/report-examination.service';
import { createClinicalFact } from '../services/clinical-fact.service';
import { createReportStructuredSection } from '../services/report-structured-section.service';
import { saveReportNote, listReportNotes, stageReportNoteImage } from '../services/report-note.service';
import {setExaminationDuplicateDecision} from '../services/examination-duplicate.service';
import { createMorphologyFinding } from '../services/morphology-finding.service';
import { runFileGarbageCollection } from '../services/file-gc.service';
const owner: RequestUser = { id: 'owner', displayName: '合成管理员', authenticated: true, provider: 'development', isGatewayAdmin: false };
const line = '肌酸激酶 100 U/L 参考范围 40-200';
const observation = { itemName: '肌酸激酶', resultText: '100', numericValue: 100, unit: 'U/L', referenceLow: 40, referenceHigh: 200, referenceText: '40-200', sectionName: '生化', evidence: [{ pageNumber: 1, quote: line }] };
const result = () => ({ provider: 'synthetic', model: 'synthetic', promptVersion: 'synthetic', ...normalizeAiExtraction({ reportType: 'laboratory', title: '合成检验报告', reportIssuedAt: '2026-01-01', hospitalNameRaw: '合成机构', observations: [observation] }), rawResponseJson: '{}', promptTokens: 0, completionTokens: 0, elapsedMs: 0 });
async function fixture(run: (context: {
    db: ReturnType<typeof getDatabase>;
    root: string;
    source: string;
    target: string;
    calls: () => number;
}) => Promise<void> | void) {
    const root = mkdtempSync(join(tmpdir(), 's0005-combine-')), previous = process.env.STORAGE_DIR;
    process.env.STORAGE_DIR = root;
    try {
        const db = getDatabase();
        db.exec(`INSERT INTO users(id,display_name) VALUES('owner','合成管理员'),('reader','合成只读用户');
    INSERT INTO health_members(id,display_name,created_by) VALUES('m','合成档案','owner'),('other','另一合成档案','owner');
    INSERT INTO member_permissions(member_id,user_id,permission,granted_by) VALUES('m','owner','manager','owner'),('m','reader','viewer','owner'),('other','owner','manager','owner');`);
        saveAiSettings({ enabled: true, baseUrl: 'https://synthetic.example.test/v1', textModel: 'synthetic', apiKey: 'synthetic-test-key' });
        let calls = 0;
        const ai: AiExecutor = async () => { calls++; return result(); };
        const worker: WorkerExecutor = async (request) => request.action === 'thumbnail' ? { ok: true, width: 100, height: 100, elapsedMs: 1 } : { ok: true, engine: 'synthetic', modelVersion: 'test', elapsedMs: 1, lines: [{ text: '检验报告', confidence: 1 }, { text: line, confidence: 1 }] };
        const reports: string[] = [];
        for (let index = 0; index < 2; index++) {
            const upload = createUpload(owner, 'm', [{ originalName: `synthetic-${index}.png`, data: Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 49 + index]) }], `synthetic-upload-${index}`);
            reports.push(upload.reportId);
            for (let step = 0; step < 8; step++)
                if (!await processNextJob(worker, ai))
                    break;
            const detail = getReportDetail(owner, upload.reportId);
            assert.equal(detail.observations.length, 1, 'normal upload/extraction produces recognized content');
            updateReportFields(owner, upload.reportId, { title: index ? '合成并入报告' : '合成保留报告', reportType: 'laboratory', reportIssuedAt: '2026-01-01' });
        }
        await run({ db, root, target: reports[0], source: reports[1], calls: () => calls });
    }
    finally {
        closeDatabaseForTests();
        if (previous === undefined)
            delete process.env.STORAGE_DIR;
        else
            process.env.STORAGE_DIR = previous;
        rmSync(root, { recursive: true, force: true });
    }
}
function payload(source: string, fingerprint: string, requestKey = 'synthetic-request-0001') { return { sourceReportId: source, fingerprint, requestKey }; }
test('combines already recognized reports with all originals, corrections, clinical content and confirmed time; replay is idempotent', async () => fixture(async ({ db, root, source, target, calls }) => {
    const sourceDetail = getReportDetail(owner, source), targetDetail = getReportDetail(owner, target);
    const sourceObservation = sourceDetail.observations[0];
    updateManualObservation(owner, source, sourceObservation.id, { ...sourceObservation, resultText: '110', numericValue: 110 });
    createManualObservation(owner, source, { itemName: '合成补充项', resultText: '2', numericValue: 2, unit: 'U/L', sourcePageId: sourceDetail.pages[0].id });
    updateReportFields(owner, source, { title: '合成人工校对标题', reportType: 'laboratory', reportIssuedAt: '2026-01-02', summary: '合成来源摘要' });
    const exams = getReportExaminations(owner, source);
    saveReportExamination(owner, source, { version: exams.version, reportVersion: exams.reportVersion, requestKey: 'synthetic-time', observationIds: [sourceObservation.id], examination: { examinationType: '检验', sampledAt: '2026-01-02', institution: '合成来源机构', evidence: [{ pageNumber: 1, pageId: sourceDetail.pages[0].id, quote: line }] } });
    const facts = [createClinicalFact(owner, source, 'diagnosis', { diagnosisText: '合成诊断说明' }), createClinicalFact(owner, source, 'medication', { medicationName: '合成药品' }), createClinicalFact(owner, source, 'procedure', { procedureName: '合成检查' }), createClinicalFact(owner, source, 'vaccination', { vaccineName: '合成接种' }), createClinicalFact(owner, source, 'billingItem', { itemName: '合成收费项', amount: 1 })];
    const section = createReportStructuredSection(owner, source, { sectionKey: 'outpatient_advice', title: '合成建议', content: '合成专属内容' });
    createMorphologyFinding(owner,source,{organ:'肝脏',findingType:'囊肿',findingName:'合成形态内容',rawText:'合成形态内容约8mm',sourcePageNumber:1});
    const finding=getReportDetail(owner,source).morphologyFindings[0];
    const staged=await stageReportNoteImage(owner,source,{originalName:'synthetic-note.png',data:Uint8Array.from([137,80,78,71,13,10,26,10,51])},async request=>{copyFileSync(String(request.imagePath),String(request.outputPath));return {ok:true,width:1,height:1,elapsedMs:1};});
    const note = saveReportNote(owner, source, { contentText: '合成原备注', assets: [{uploadToken:staged.uploadToken}] });
    const asset=db.prepare('SELECT storage_path FROM report_note_assets WHERE note_id=?').get(note.id)!;
    const assetBytes=readFileSync(join(root,String(asset.storage_path)));
    const originalPages = db.prepare('SELECT id,storage_path FROM report_pages ORDER BY id').all();
    const files = originalPages.map(p => ({ id: p.id, path: String(p.storage_path), bytes: readFileSync(join(root, String(p.storage_path))) }));
    const jobsBefore = db.prepare('SELECT id,status FROM processing_jobs ORDER BY id').all(), ocrBefore = db.prepare('SELECT * FROM ocr_results ORDER BY id').all();
    const callsBefore = calls(), preview = previewReportCombination(owner, source, target);
    assert.equal(preview.sameReportDate, false);
    assert.equal(preview.sourceCounts.observations, 2);
    assert.equal(preview.targetCounts.observations, 1);
    assert.equal(getReportDetail(owner, target).pages.length, 1, 'preview never combines automatically');
    const request = payload(source, preview.fingerprint), combined = combineReports(owner, target, request);
    assert.equal(combined.movedObservations, 2);
    assert.deepEqual(combineReports(owner, target, request), combined);
    assert.throws(() => combineReports(owner, target, { ...request, fingerprint: 'a'.repeat(64) }), /已用于其他合并/);
    const detail = getReportDetail(owner, target);
    assert.equal(detail.title, targetDetail.title);
    assert.equal(detail.status, 'needs_review');
    assert.equal(detail.observations.length, 3);
    assert.equal(detail.pages.length, 2);
    assert.equal(detail.observations.find(o => o.id === sourceObservation.id)?.numericValue, 110);
    assert.equal(detail.morphologyFindings.find(f=>f.id===finding.id)?.evidence?.[0]?.pageNumber,2);
    assert.ok(detail.observations.some(o => o.itemName === '合成补充项'));
    assert.equal(detail.observations.find(o => o.id === sourceObservation.id)?.evidence?.pageId, sourceDetail.pages[0].id);
    assert.equal(detail.pages.find(p => p.id === sourceDetail.pages[0].id)?.pageNumber, 2);
    const linked = getReportExaminations(owner, target);
    const sourceExam = linked.examinations.find(e => e.confirmationStatus === 'confirmed')!;
    assert.equal(sourceExam.occurredAt, '2026-01-02');
    assert.equal(sourceExam.evidence[0].pageNumber, 2);
    assert.equal(linked.observations.find(o => o.observationId === sourceObservation.id)?.examinationId, sourceExam.id);
    for (const [index, table] of ['report_diagnoses', 'report_medications', 'report_procedures', 'vaccination_records', 'billing_items'].entries())
        assert.equal(db.prepare(`SELECT report_id FROM ${table} WHERE id=?`).get(facts[index].id)?.report_id, target);
    assert.equal(db.prepare('SELECT report_id FROM report_structured_sections WHERE id=?').get(section.id)?.report_id, target);
    const notes = listReportNotes(owner, target).notes;
    assert.ok(notes.some(n => n.id === note.id && n.contentText === '合成原备注'));
    assert.ok(notes.some(n => n.contentText.includes('合成人工校对标题') && n.contentText.includes('合成来源摘要') && n.contentText.includes('报告类型：检验')));
    assert.equal(db.prepare('SELECT status FROM reports WHERE id=?').get(source)?.status, 'trashed');
    assert.deepEqual(db.prepare('SELECT id,status FROM processing_jobs ORDER BY id').all(), jobsBefore);
    assert.deepEqual(db.prepare('SELECT * FROM ocr_results ORDER BY id').all(), ocrBefore);
    assert.equal(calls(), callsBefore);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM observations o JOIN observation_examinations l ON l.observation_id=o.id JOIN report_examinations e ON e.id=l.examination_id WHERE o.report_id<>e.report_id').get()?.n, 0);
    assert.equal(db.prepare('PRAGMA foreign_key_check').get(), undefined);
    const retriedUpload = createUpload(owner, 'm', [{ originalName: 'synthetic-1.png', data: Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 50]) }], 'synthetic-upload-1');
    assert.equal(retriedUpload.reportId, target);
    assert.equal(retriedUpload.pages[0].pageNumber, 2);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM app_notifications WHERE report_id=?').get(source)?.n, 0);
    permanentlyDeleteReport(owner, source);
    runFileGarbageCollection();
    for (const file of files) {
        assert.ok(db.prepare('SELECT id FROM report_pages WHERE id=? AND report_id=?').get(file.id, target));
        assert.deepEqual(readFileSync(join(root, file.path)), file.bytes);
    }
    assert.equal(getReportDetail(owner, target).observations.length, 3, 'purging source cannot remove transferred records');
    assert.equal(listReportNotes(owner,target).notes.find(n=>n.id===note.id)?.assets.length,1);
    assert.deepEqual(readFileSync(join(root,String(asset.storage_path))),assetBytes);
}));
test('preserves each legacy fallback date including missing dates, ISO timestamps and secondary report dates', async () => {
    for (const date of ['2026-01-02', null, '2026-01-02T08:03:00.000Z', 'secondary'] as const)
        await fixture(({ db, source, target }) => {
            db.prepare('DELETE FROM observation_examinations WHERE observation_id IN (SELECT id FROM observations WHERE report_id IN (?,?))').run(source, target);
            db.prepare('UPDATE reports SET report_issued_at=?,reviewed_at=?,examined_at=NULL,sampled_at=NULL,received_at=NULL,ordered_at=NULL WHERE id=?').run(date === 'secondary' ? null : date, date === 'secondary' ? '2026-01-03' : null, source);
            const preview = previewReportCombination(owner, source, target);
            combineReports(owner, target, payload(source, preview.fingerprint));
            const sourcePoint = db.prepare('SELECT ex.occurred_at,ex.confirmation_status FROM observations o JOIN observation_examinations l ON l.observation_id=o.id JOIN report_examinations ex ON ex.id=l.examination_id WHERE o.report_id=? AND ex.source_key LIKE ?').get(target, `combined:${source}:%`)!;
            assert.equal(sourcePoint.occurred_at, date === 'secondary' ? '2026-01-03' : date);
            assert.equal(sourcePoint.confirmation_status, date ? 'automatic' : 'pending');
            const targetPoint = db.prepare('SELECT ex.occurred_at FROM observations o JOIN observation_examinations l ON l.observation_id=o.id JOIN report_examinations ex ON ex.id=l.examination_id WHERE o.report_id=? AND ex.source_key NOT LIKE ?').get(target, `combined:${source}:%`)!;
            assert.equal(targetPoint.occurred_at, '2026-01-01');
            if (date)
                assert.ok(listTrendSeries(owner, 'm').flatMap(s => s.points).some(p => p.reportId === target && p.reportIssuedAt === (date === 'secondary' ? '2026-01-03' : date)), 'known source date stays eligible');
        });
});
test('requires manage permission, same member, distinct reports and idle processing', async () => fixture(({ db, source, target }) => {
    assert.throws(() => previewReportCombination({ ...owner, id: 'reader' }, source, target), /权限/);
    assert.throws(() => previewReportCombination(owner, target, target), /另一份/);
    assert.throws(() => previewReportCombination(owner, 'missing', target), /不存在/);
    const append = startPageAppend(owner, target, { requestKey: 'synthetic-append-0001', files: [{ name: 'synthetic.png', size: 9 }] });
    assert.throws(() => previewReportCombination(owner, source, target), /补充|补页/);
    cancelPageAppend(owner, target, append.id);
    db.prepare("UPDATE reports SET member_id='other' WHERE id=?").run(source);
    assert.throws(() => previewReportCombination(owner, source, target), /同一成员/);
    db.prepare("UPDATE reports SET member_id='m' WHERE id=?").run(source);
    db.prepare("UPDATE reports SET status='processing' WHERE id=?").run(target);
    assert.throws(() => previewReportCombination(owner, source, target), /仍有识别/);
    db.prepare("UPDATE reports SET status='ready' WHERE id=?").run(target);
    db.prepare("UPDATE processing_jobs SET status='processing' WHERE id=(SELECT id FROM processing_jobs WHERE report_id=? LIMIT 1)").run(source);
    assert.throws(() => previewReportCombination(owner, source, target), /仍有识别/);
}));
test('rejects stale previews and rolls every write back on a mid-transaction failure', async () => fixture(({ db, source, target }) => {
    let preview = previewReportCombination(owner, source, target);
    assert.equal(preview.sameReportDate, true);
    saveReportNote(owner, source, { contentText: '合成预览后的修改', assets: [] });
    assert.throws(() => combineReports(owner, target, payload(source, preview.fingerprint)), /内容已变化/);
    preview = previewReportCombination(owner, source, target);
    db.exec("CREATE TRIGGER synthetic_combination_failure BEFORE UPDATE OF report_id ON report_medications BEGIN SELECT RAISE(ABORT,'synthetic-rollback'); END");
    createClinicalFact(owner, source, 'medication', { medicationName: '合成回滚测试药品' });
    const before = db.prepare('SELECT * FROM reports ORDER BY id').all(), pages = db.prepare('SELECT * FROM report_pages ORDER BY id').all(), observations = db.prepare('SELECT * FROM observations ORDER BY id').all();
    preview = previewReportCombination(owner, source, target);
    assert.throws(() => combineReports(owner, target, payload(source, preview.fingerprint)), /synthetic-rollback/);
    assert.deepEqual(db.prepare('SELECT * FROM reports ORDER BY id').all(), before);
    assert.deepEqual(db.prepare('SELECT * FROM report_pages ORDER BY id').all(), pages);
    assert.deepEqual(db.prepare('SELECT * FROM observations ORDER BY id').all(), observations);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM audit_logs WHERE action='report.combine'").get()?.n, 0);
    assert.equal(db.prepare('PRAGMA foreign_key_check').get(), undefined);
}));
test('rejects two invoice summaries atomically rather than dropping or adding their totals', async () => fixture(({ db, source, target }) => {
    for (const id of [source, target])
        createClinicalFact(owner, id, 'billingSummary', { totalAmount: 1, invoiceNumber: 'SYNTHETIC' });
    assert.throws(() => previewReportCombination(owner, source, target), /费用汇总/);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM report_pages WHERE report_id=?').get(source)?.n, 1);
}));
test('manual correction and deletion provenance survives page renumbering and normal extraction rerun', async () => fixture(({ db, source, target }) => {
    const sourceDetail = getReportDetail(owner, source);
    const edited = sourceDetail.observations[0];
    updateManualObservation(owner, source, edited.id, { ...edited, resultText: '115', numericValue: 115 });
    createManualObservation(owner, source, { itemName: '合成删除项', resultText: '3', unit: 'U/L', sourcePageId: sourceDetail.pages[0].id });
    const removed = getReportDetail(owner, source).observations.find(o => o.itemName === '合成删除项')!;
    deleteManualObservation(owner, source, removed.id);
    // Simulate an older page-number-only key on a real recognized observation.
    const legacyKey = observationSourceKey({ ...edited, evidence: [{ pageNumber: 1, quote: line }] } as any);
    db.prepare('UPDATE observation_field_overrides SET source_key=? WHERE observation_id=?').run(legacyKey, edited.id);
    const preview = previewReportCombination(owner, source, target);
    combineReports(owner, target, payload(source, preview.fingerprint));
    const before = getReportDetail(owner, target);
    assert.equal(before.observations.find(o => o.id === edited.id)?.numericValue, 115);
    db.prepare("INSERT INTO processing_jobs(id,report_id,job_type,status,pipeline_version,deduplication_key) VALUES('synthetic-rerun',?,'ai_extract','processing','test','synthetic-rerun')").run(target);
    const output = result();
    output.fields.observations = [{ ...output.fields.observations[0], evidence: [{ pageNumber: 1, quote: line }] }, { ...output.fields.observations[0], evidence: [{ pageNumber: 2, quote: line }] }];
    persistAiExtraction(target, 'synthetic-rerun', output, 100);
    const after = getReportDetail(owner, target);
    assert.equal(after.observations.filter(o => o.itemName === '肌酸激酶').length, 2, 'no extra unmatched manual duplicate');
    assert.ok(after.observations.some(o => o.numericValue === 115));
    assert.ok(!after.observations.some(o => o.itemName === '合成删除项'));
}));
test('a deleted recognized source indicator stays deleted after renumbering and extraction rerun', async () => fixture(({ db, source, target }) => {
    const detail = getReportDetail(owner, source), original = detail.observations[0];
    deleteManualObservation(owner, source, original.id);
    // Legacy suppression keys used page numbers; they must not suppress the target's page 1.
    db.prepare('DELETE FROM observation_suppressions WHERE report_id=?').run(source);
    db.prepare('INSERT INTO observation_suppressions(report_id,source_key) VALUES(?,?)').run(source, observationSourceKey({ ...original, evidence: [{ pageNumber: 1, quote: line }] } as any));
    const preview = previewReportCombination(owner, source, target);
    combineReports(owner, target, payload(source, preview.fingerprint));
    db.prepare("INSERT INTO processing_jobs(id,report_id,job_type,status,pipeline_version,deduplication_key) VALUES('synthetic-rerun',?,'ai_extract','processing','test','synthetic-rerun')").run(target);
    const output = result();
    output.fields.observations = [{ ...output.fields.observations[0], evidence: [{ pageNumber: 1, quote: line }] }, { ...output.fields.observations[0], evidence: [{ pageNumber: 2, quote: line }] }];
    persistAiExtraction(target, 'synthetic-rerun', output, 100);
    const after = getReportDetail(owner, target);
    assert.equal(after.observations.length, 1);
    assert.equal(after.observations[0].evidence?.pageId, getReportDetail(owner, target).pages[0].id);
}));


test('long source metadata is retained without breaking Unicode or the editable note limit',async()=>fixture(({db,source,target})=>{
 const conclusion='合成说明'.repeat(2480)+'💊'+'合成续文'.repeat(2600);
 db.prepare('UPDATE reports SET findings=? WHERE id=?').run(conclusion,source);
 const preview=previewReportCombination(owner,source,target);combineReports(owner,target,payload(source,preview.fingerprint));
 const notes=listReportNotes(owner,target).notes.filter(n=>n.contentText.includes('合并来源报告信息（第 '));
 assert.ok(notes.length>1);assert.ok(notes.every(n=>n.contentText.length<=10000&&!n.contentText.includes('\uFFFD')));
 const joined=notes.sort((a,b)=>Number(a.contentText.match(/第 (\d+)/)![1])-Number(b.contentText.match(/第 (\d+)/)![1])).map(n=>n.contentText.replace(/^合并来源报告信息（第 \d+\/\d+ 段）\n/,'')).join('');
 assert.ok(joined.includes(conclusion));
}));


test('legacy morphology keeps its examination date independently of the report issue date',async()=>fixture(({db,source,target})=>{
 createMorphologyFinding(owner,source,{organ:'肝脏',findingType:'囊肿',findingName:'合成形态日期',rawText:'合成形态内容约8mm',sourcePageNumber:1});
 db.prepare('DELETE FROM morphology_finding_examinations WHERE finding_id IN (SELECT id FROM morphology_findings WHERE report_id=?)').run(source);
 db.prepare("UPDATE reports SET examined_at='2026-01-02',report_issued_at='2026-01-04' WHERE id=?").run(source);
 assert.equal(getReportDetail(owner,source).morphologyFindings[0].examDate,'2026-01-02');
 const preview=previewReportCombination(owner,source,target);combineReports(owner,target,payload(source,preview.fingerprint));
 assert.equal(getReportDetail(owner,target).morphologyFindings[0].examDate,'2026-01-02');
}));


test('undo restores both original reports, evidence, corrections, dates and histories without touching original files',async()=>fixture(async({db,root,source,target})=>{
 const original=getReportDetail(owner,source).observations[0];
 updateManualObservation(owner,source,original.id,{...original,resultText:'112',numericValue:112});
 const stagedUndoAsset=await stageReportNoteImage(owner,source,{originalName:'synthetic-undo-note.png',data:Uint8Array.from([137,80,78,71,13,10,26,10,54])},async request=>{copyFileSync(String(request.imagePath),String(request.outputPath));return {ok:true,width:1,height:1,elapsedMs:1};});
 saveReportNote(owner,source,{contentText:'合成来源补充记录',assets:[{uploadToken:stagedUndoAsset.uploadToken}]});
 createManualObservation(owner,source,{itemName:'合成撤销保留项',resultText:'2',numericValue:2,unit:'U/L',sourcePageId:getReportDetail(owner,source).pages[0].id});
 const targetOriginal=getReportDetail(owner,target).observations[0];deleteManualObservation(owner,target,targetOriginal.id);
 const time=getReportExaminations(owner,source);
 saveReportExamination(owner,source,{version:time.version,reportVersion:time.reportVersion,requestKey:'synthetic-undo-time',observationIds:[original.id],examination:{examinationType:'检验',sampledAt:'2026-01-02'}});
 createMorphologyFinding(owner,source,{organ:'肝脏',findingType:'囊肿',findingName:'合成撤销形态',rawText:'合成形态内容约8mm',sourcePageNumber:1});
 for(const [type,input] of [['diagnosis',{diagnosisText:'合成诊断'}],['medication',{medicationName:'合成药品'}],['procedure',{procedureName:'合成检查'}],['vaccination',{vaccineName:'合成接种'}],['billingItem',{itemName:'合成收费项目',amount:1}]] as const)createClinicalFact(owner,source,type,input);
 createReportStructuredSection(owner,source,{sectionKey:'outpatient_advice',title:'合成建议',content:'合成专属内容'});
 db.prepare("UPDATE health_members SET blood_type_source_report_id=? WHERE id='m'").run(source);
 updateReportFields(owner,target,{title:'合成保留报告',reportType:'laboratory',reportIssuedAt:'2026-01-01',recommendation:'合成建议：1个月后复查'});
 const before=captureCombinationSnapshot(source,target),files=before.tables.report_pages.map(p=>[String(p.storage_path),readFileSync(join(root,String(p.storage_path)))] as const);
 const request=payload(source,previewReportCombination(owner,source,target).fingerprint);
 const combined=combineReports(owner,target,request);assert.ok(combined.combinationId);
 assert.equal(getReportDetail(owner,target).combinationUndo?.id,combined.combinationId);
 // Archive is a benign workflow action and must not make undo disappear.
 confirmReportReady(owner,target);
 assert.equal(db.prepare("SELECT COUNT(*) n FROM reminders WHERE report_id=? AND source='report_suggestion'").get(target)?.n,1);
 const preview=previewCombinationUndo(owner,target,combined.combinationId!);
 const versions=db.prepare('SELECT id,source_version FROM reports ORDER BY id').all();
 const undo=undoReportCombination(owner,target,{combinationId:combined.combinationId,fingerprint:preview.fingerprint});
 assert.equal(undo.restoredReportId,source);
 assert.equal(combinationContentFingerprint(captureCombinationSnapshot(source,target)),combinationContentFingerprint(before));
 for(const row of versions)assert.ok(Number(db.prepare('SELECT source_version FROM reports WHERE id=?').get(row.id)?.source_version)>Number(row.source_version));
 assert.equal(getReportDetail(owner,source).observations.find(o=>o.id===original.id)?.numericValue,112);
 assert.equal(listReportNotes(owner,source).notes[0].assets.length,1);
 assert.equal(db.prepare('SELECT before_json FROM report_combinations WHERE id=?').get(combined.combinationId!)?.before_json,'{}');
 assert.equal(getReportDetail(owner,target).combinationUndo,null);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM reminders WHERE report_id=?').get(target)?.n,1);
 for(const [path,bytes] of files)assert.deepEqual(readFileSync(join(root,path)),bytes);
 assert.deepEqual(undoReportCombination(owner,target,{combinationId:combined.combinationId,fingerprint:preview.fingerprint}),undo);
 assert.throws(()=>combineReports(owner,target,request),/已经撤销/);
 assert.equal(db.prepare("SELECT COUNT(*) n FROM audit_logs WHERE action='report.combine_undo'").get()?.n,1);
 assert.equal(db.prepare('PRAGMA foreign_key_check').get(),undefined);
 const audit=String(db.prepare("SELECT detail_json FROM audit_logs WHERE action='report.combine_undo'").get()?.detail_json);
 assert.ok(!audit.includes('合成来源补充记录')&&!audit.includes('112'));
}));

test('undo preview and submission never overwrite edits made after merge',async()=>fixture(({db,source,target})=>{
 const combined=combineReports(owner,target,payload(source,previewReportCombination(owner,source,target).fingerprint));
 const preview=previewCombinationUndo(owner,target,combined.combinationId!);
 const edited=getReportDetail(owner,target).observations[0];
 updateManualObservation(owner,target,edited.id,{...edited,resultText:'119',numericValue:119});
 assert.throws(()=>previewCombinationUndo(owner,target,combined.combinationId!),/修改/);
 assert.throws(()=>undoReportCombination(owner,target,{combinationId:combined.combinationId,fingerprint:preview.fingerprint}),/修改/);
 assert.equal(getReportDetail(owner,target).observations.find(o=>o.id===edited.id)?.numericValue,119);
 assert.equal(db.prepare('SELECT status FROM reports WHERE id=?').get(source)?.status,'trashed');
 assert.equal(db.prepare('SELECT undone_at FROM report_combinations WHERE id=?').get(combined.combinationId!)?.undone_at,null);
}));

test('undo remains authorized and atomic, and preserves read notification state',async()=>fixture(({db,source,target})=>{
 const combined=combineReports(owner,target,payload(source,previewReportCombination(owner,source,target).fingerprint));
 assert.throws(()=>previewCombinationUndo({...owner,id:'reader'},target,combined.combinationId!),/权限/);
 const preview=previewCombinationUndo(owner,target,combined.combinationId!);
 assert.throws(()=>undoReportCombination({...owner,id:'reader'},target,{combinationId:combined.combinationId,fingerprint:preview.fingerprint}),/权限/);
 db.prepare("UPDATE app_notifications SET status='read',read_at=CURRENT_TIMESTAMP WHERE report_id=?").run(target);
 const before=captureCombinationSnapshot(source,target);
 db.exec("CREATE TRIGGER synthetic_undo_failure BEFORE UPDATE OF report_id ON observations WHEN NEW.report_id<>OLD.report_id BEGIN SELECT RAISE(ABORT,'synthetic-undo-rollback'); END");
 assert.throws(()=>undoReportCombination(owner,target,{combinationId:combined.combinationId,fingerprint:preview.fingerprint}),/synthetic-undo-rollback/);
 assert.equal(combinationContentFingerprint(captureCombinationSnapshot(source,target)),combinationContentFingerprint(before));
 assert.equal(db.prepare('SELECT undone_at FROM report_combinations WHERE id=?').get(combined.combinationId!)?.undone_at,null);
 db.exec('DROP TRIGGER synthetic_undo_failure');
 undoReportCombination(owner,target,{combinationId:combined.combinationId,fingerprint:preview.fingerprint});
 assert.equal(db.prepare("SELECT COUNT(*) n FROM app_notifications WHERE status<>'read'").get()?.n,0);
 assert.equal(db.prepare('PRAGMA foreign_key_check').get(),undefined);
}));

test('multiple merges unwind in reverse order',async()=>fixture(async({db,source,target})=>{
 const third=createUpload(owner,'m',[{originalName:'synthetic-third.png',data:Uint8Array.from([137,80,78,71,13,10,26,10,53])}]);
 const worker:WorkerExecutor=async request=>request.action==='thumbnail'?{ok:true,width:100,height:100,elapsedMs:1}:{ok:true,engine:'synthetic',modelVersion:'test',elapsedMs:1,lines:[{text:'检验报告',confidence:1},{text:line,confidence:1}]};
 for(let i=0;i<8;i++)if(!await processNextJob(worker,async()=>result()))break;
 const first=combineReports(owner,target,payload(source,previewReportCombination(owner,source,target).fingerprint));
 const second=combineReports(owner,target,payload(third.reportId,previewReportCombination(owner,third.reportId,target).fingerprint,'synthetic-request-second'));
 assert.throws(()=>previewCombinationUndo(owner,target,first.combinationId!),/先撤销后续/);
 const secondUndo=previewCombinationUndo(owner,target,second.combinationId!);undoReportCombination(owner,target,{combinationId:second.combinationId,fingerprint:secondUndo.fingerprint});
 assert.equal(getReportDetail(owner,third.reportId).pages.length,1);
 const firstUndo=previewCombinationUndo(owner,target,first.combinationId!);undoReportCombination(owner,target,{combinationId:first.combinationId,fingerprint:firstUndo.fingerprint});
 for(const reportId of [source,target,third.reportId])assert.equal(getReportDetail(owner,reportId).pages.length,1);
 assert.equal(db.prepare('PRAGMA foreign_key_check').get(),undefined);
}));


test('saved recovery survives restart and corrupt recovery information cannot change reports',async()=>fixture(({db,source,target})=>{
 const combined=combineReports(owner,target,payload(source,previewReportCombination(owner,source,target).fingerprint));
 const stored=String(db.prepare('SELECT before_json FROM report_combinations WHERE id=?').get(combined.combinationId!)!.before_json);
 const damaged=JSON.parse(stored);damaged.snapshot.tables.reports[0].title='合成损坏内容';
 db.prepare('UPDATE report_combinations SET before_json=? WHERE id=?').run(JSON.stringify(damaged),combined.combinationId!);
 assert.throws(()=>previewCombinationUndo(owner,target,combined.combinationId!),/恢复信息不可用/);
 db.prepare('UPDATE report_combinations SET before_json=? WHERE id=?').run(stored,combined.combinationId!);
 closeDatabaseForTests();
 const reopened=getDatabase();const preview=previewCombinationUndo(owner,target,combined.combinationId!);
 undoReportCombination(owner,target,{combinationId:combined.combinationId,fingerprint:preview.fingerprint});
 assert.equal(getReportDetail(owner,source).pages.length,1);assert.equal(getReportDetail(owner,target).pages.length,1);
 assert.equal(reopened.prepare('PRAGMA foreign_key_check').get(),undefined);
}));


test('undo keeps unrelated member blood-type provenance and protects subsequent examination decisions',async()=>fixture(({db,source,target})=>{
 const combined=combineReports(owner,target,payload(source,previewReportCombination(owner,source,target).fingerprint));
 db.exec("INSERT INTO reports(id,member_id,created_by,title,report_type,status) VALUES('synthetic-independent','m','owner','合成独立报告','laboratory','ready'); UPDATE health_members SET blood_type_abo='A',blood_type_source_report_id='synthetic-independent' WHERE id='m'");
 const preview=previewCombinationUndo(owner,target,combined.combinationId!);
 const examinations=getReportExaminations(owner,target);assert.ok(examinations.examinations.length>=2);
 const decision={leftId:examinations.examinations[0].id,rightId:examinations.examinations[1].id,leftVersion:examinations.reportVersion,rightVersion:examinations.reportVersion,decision:'different' as const};
 setExaminationDuplicateDecision(owner,decision);
 assert.throws(()=>undoReportCombination(owner,target,{combinationId:combined.combinationId,fingerprint:preview.fingerprint}),/修改/);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM examination_duplicate_decisions').get()?.n,1);
 assert.equal(db.prepare("SELECT blood_type_source_report_id FROM health_members WHERE id='m'").get()?.blood_type_source_report_id,'synthetic-independent');
}));

test('undo does not restore unrelated member fields which the merge never changed',async()=>fixture(({db,source,target})=>{
 const combined=combineReports(owner,target,payload(source,previewReportCombination(owner,source,target).fingerprint));
 db.exec("INSERT INTO reports(id,member_id,created_by,title,report_type,status) VALUES('synthetic-independent','m','owner','合成独立报告','laboratory','ready'); UPDATE health_members SET blood_type_abo='A',blood_type_source_report_id='synthetic-independent' WHERE id='m'");
 const preview=previewCombinationUndo(owner,target,combined.combinationId!);undoReportCombination(owner,target,{combinationId:combined.combinationId,fingerprint:preview.fingerprint});
 assert.equal(db.prepare("SELECT blood_type_source_report_id FROM health_members WHERE id='m'").get()?.blood_type_source_report_id,'synthetic-independent');
 assert.equal(getReportDetail(owner,source).pages.length,1);assert.equal(getReportDetail(owner,target).pages.length,1);
}));
