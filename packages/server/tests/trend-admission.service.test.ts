import { runTrendSnapshotTasksOnce } from '../services/trend-snapshot-runner.service';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { closeDatabaseForTests, getDatabase } from '../database/client';
import { ensureBuiltinIndicatorCatalog, assessTrendAdmission, normalizeReportObservations, previewIndicatorNormalization, listIndicatorNormalizationIssues, resolveIndicatorNormalizationIssue, undoIndicatorGovernanceDecision } from '../services/indicator-normalization.service';
import { getReportDetail, listTrendSeries, updateTrendPin } from '../services/records.service';
import { updateManualObservation } from '../services/observation-field-overrides.service';
import { normalizeAiExtraction, persistAiExtraction } from '../services/ai-extraction.service';
import { executeAiExtractionPlan } from '../services/ai-extraction-orchestrator.service';
import { acceptVisionObservations, groupVisionReviewPages } from '../services/ai-vision-review.service';

const user = { id: 'qa-user', displayName: '合成用户', authenticated: true, provider: 'development', isGatewayAdmin: true } as const;
const raw = {
  reportId: 'qa-report', itemName: '合成测定项目甲', resultText: '2', numericValue: 2, unit: 'U/L',
  evidenceJson: JSON.stringify([{ pageNumber: 1, quote: '合成测定项目甲 2 U/L' }]),
  normalizationQuality: 'low', normalizationMatchedBy: 'none', hospitalName: '合成机构', reportIssuedAt: '2026-01-01',
};

test('shared admission requires verified raw numbers and never bypasses exclusions or identity conflicts', () => {
  assert.equal(assessTrendAdmission(raw).kind, 'institution');
  // 纯指标型报告缺机构不阻断趋势（进入“机构未确认”分组）；数值+内联单位/箭头视为明确单值
  assert.equal(assessTrendAdmission({ ...raw, hospitalName: '' }).kind, 'institution');
  assert.equal(assessTrendAdmission({ ...raw, resultText: '2 (U/L)' }).kind, 'institution');
  assert.equal(assessTrendAdmission({ ...raw, resultText: '2（U/L）↑' }).kind, 'institution');
  // 矫正后的规范单位（fL）可回指原文中的 OCR 形近误读（f1），但无单位证据仍拒绝
  assert.equal(assessTrendAdmission({ ...raw, numericValue: 82, resultText: '82', unit: 'fL',
    evidenceJson: JSON.stringify([{ pageNumber: 1, quote: '合成测定项目甲 82 f1' }]) }).kind, 'institution');
  assert.equal(assessTrendAdmission({ ...raw, numericValue: 82, resultText: '82', unit: 'fL',
    evidenceJson: JSON.stringify([{ pageNumber: 1, quote: '合成测定项目甲 82' }]) }).eligible, false);
  // 锚定变体从别名表反向生成：其他形近误读（mL→m1）同样可回指
  assert.equal(assessTrendAdmission({ ...raw, numericValue: 92, resultText: '92', unit: 'mL',
    evidenceJson: JSON.stringify([{ pageNumber: 1, quote: '合成测定项目甲 92 m1' }]) }).kind, 'institution');
  // 视觉纠正与 OCR 冲突时保留记录，但必须人工确认才能进入趋势
  assert.equal(assessTrendAdmission({ ...raw, numericValue: 130, resultText: '130', unit: 'g/L',
    evidenceJson: JSON.stringify([{ pageNumber: 1, quote: '合成测定项目甲 158 U/L', source: 'vision' }]) }).eligible, false);
  assert.equal(assessTrendAdmission({ ...raw, numericValue: 130, resultText: '130', unit: 'g/L', manualReviewed:true,
    evidenceJson: JSON.stringify([{ pageNumber: 1, quote: '合成测定项目甲 158 U/L', source: 'vision' }]) }).eligible, true);
  assert.equal(assessTrendAdmission({ ...raw,
    evidenceJson: JSON.stringify([{ pageNumber: 1, quote: '合成测定项目甲 2 U/L', source: 'vision' }]) }).eligible, true);
  // AI 规范化后的单位（10^9/L）可回指 OCR 原文丢上标的形态（109/L）
  assert.equal(assessTrendAdmission({ ...raw, numericValue: 29.59, resultText: '29.59', unit: '10^9/L',
    evidenceJson: JSON.stringify([{ pageNumber: 1, quote: '合成测定项目甲 29.59 109/L' }]) }).kind, 'institution');
  assert.equal(assessTrendAdmission({ ...raw, numericValue: 5.21, resultText: '5.21', unit: '10^12/L',
    evidenceJson: JSON.stringify([{ pageNumber: 1, quote: '合成测定项目甲 5.21 1012/L' }]) }).kind, 'institution');
  // 大写 I 误读（μmoI/L）同样可矫正并回指
  assert.equal(assessTrendAdmission({ ...raw, numericValue: 105, resultText: '105', unit: 'μmol/L',
    evidenceJson: JSON.stringify([{ pageNumber: 1, quote: '合成测定项目甲 105 μmoI/L' }]) }).kind, 'institution');
  // 混合来源（vision + 普通证据）不享受放行，数值仍需回指
  assert.equal(assessTrendAdmission({ ...raw, numericValue: 130, resultText: '130',
    evidenceJson: JSON.stringify([
      { pageNumber: 1, quote: '合成测定项目甲 158 U/L', source: 'vision' },
      { pageNumber: 1, quote: '备注 160' },
    ]) }).eligible, false);
  for (const invalid of [
    { evidenceJson: '[]' }, { evidenceJson: '{}' }, { unit: '' }, { reportIssuedAt: '' },
    { resultText: '<2' }, { resultText: '2-3' }, { numericValue: 3 }, { normalizationQuality: 'excluded' },
    { evidenceJson: JSON.stringify([{ pageNumber: 1, quote: '合成测定项目甲 <2 U/L' }]) },
    { canonicalKey: 'conflicted' }, { normalizationMatchedBy: 'ambiguous' },
    { evidenceJson: JSON.stringify([{ quote: '其他项目 2 U/L' }]) },
    { evidenceJson: JSON.stringify([{ quote: '合成测定项目甲 2 mg/L' }]) },
  ]) assert.equal(assessTrendAdmission({ ...raw, ...invalid }).eligible, false, JSON.stringify(invalid));
  assert.equal(assessTrendAdmission({ ...raw, evidenceJson: '[]', manualReviewed: true }).kind, 'institution');
  assert.equal(assessTrendAdmission({ ...raw, canonicalKey: 'qa', canonicalName: '合成标准项', normalizationQuality: 'high', normalizationMatchedBy: 'exact', evidenceJson: '[]', hasAiExtraction: 0 }).kind, 'standard');
});

test('raw trend channel shares detail admission, isolates contexts, and responds to edits and exclusions', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'health-admission-'));
  process.env.STORAGE_DIR = dir;
  try {
    const db = getDatabase();
    db.prepare('INSERT INTO users (id, display_name) VALUES (?, ?)').run(user.id, user.displayName);
    db.prepare("INSERT INTO health_members (id, display_name, relationship, created_by) VALUES ('qa-member', '合成成员', 'self', ?)").run(user.id);
    db.prepare("INSERT INTO member_permissions (member_id, user_id, permission, granted_by) VALUES ('qa-member', ?, 'manager', ?)").run(user.id, user.id);
    function insert(id: string, hospital = '合成机构', unit = 'U/L', method: string | null = '合成方法', specimen = '血清', evidence = raw.evidenceJson) {
      db.prepare("INSERT INTO reports (id, member_id, created_by, title, report_type, status, report_issued_at, hospital_name_raw) VALUES (?, 'qa-member', ?, '合成报告', 'laboratory', 'ready', ?, ?)").run(id, user.id, `2026-01-${id === 'b' ? '02' : '01'}`, hospital);
      db.prepare("INSERT INTO observations (id, report_id, item_name, result_text, numeric_value, unit, method, evidence_json) VALUES (?, ?, ?, '2', 2, ?, ?, ?)").run(id, id, raw.itemName, unit, method, evidence);
      if (specimen) db.prepare("INSERT INTO report_structured_sections (id, report_id, section_key, section_title, content_text, evidence_json, source) VALUES (?, ?, 'laboratory_specimen', '标本', ?, '[]', 'ai')").run(id, id, specimen);
      normalizeReportObservations(id);
    }
    insert('a'); insert('b');
    const series = () => listTrendSeries(user, 'qa-member');
    assert.equal(series().length, 1);
    assert.equal(series()[0].kind, 'institution');
    assert.equal(series()[0].pointCount, 2);
    assert.equal(previewIndicatorNormalization(user).eligible, 2, 'preview includes reliable non-dictionary points');
    const usableIssue = listIndicatorNormalizationIssues(user).find(item => item.rawName === raw.itemName)!;
    assert.equal(usableIssue.trendEligible, true);
    assert.equal(usableIssue.reason, '已可用于趋势，标准化为可选操作');
    assert.equal(usableIssue.canManage, true);
    assert.equal(usableIssue.reportId, 'b');
    assert.equal(getReportDetail(user, 'a').observations.find(o => o.id === 'a')?.displayTier, 'primary');
    assert.equal((db.prepare('SELECT canonical_key FROM observation_normalizations WHERE observation_id = ?').get('a') as {canonical_key: string | null}).canonical_key, null);
    const initial = series()[0];
    await runTrendSnapshotTasksOnce();
    updateTrendPin(user, { memberId: 'qa-member', indicatorKey: initial.indicatorKey, unit: initial.unit }, true);
    assert.throws(() => updateTrendPin(user, { memberId: 'qa-member', indicatorKey: 'institution:forged', unit: 'U/L' }, true));
    insert('hospital', '其他合成机构');
    insert('method', '合成机构', 'U/L', '另一个方法');
    insert('specimen', '合成机构', 'U/L', '合成方法', '血浆');
    insert('unit', '合成机构', 'mg/L', '合成方法', '血清', JSON.stringify([{pageNumber: 1, quote: '合成测定项目甲 2 mg/L'}]));
    insert('unknown', '合成机构', 'U/L', null, '');
    assert.equal(series().length, 6, JSON.stringify(series().map(s => ({ unit: s.unit, points: s.points.map(p => p.reportId) }))));
    const unknown = series().find(s => s.points.some(p => p.reportId === 'unknown'))!;
    assert.equal(unknown.comparable, false);
    assert.equal(unknown.changeAssessmentAllowed, false);
    // 纯指标型报告（无机构）进入独立的“机构未确认”分组，不再被挡在趋势外
    insert('nohosp', '');
    assert.equal(series().length, 7, JSON.stringify(series().map(s => ({ unit: s.unit, points: s.points.map(p => p.reportId) }))));
    const nohosp = series().find(s => s.points.some(p => p.reportId === 'nohosp'))!;
    assert.equal(nohosp.kind, 'institution');
    assert.equal(nohosp.pointCount, 1);
    assert.equal(nohosp.indicatorKey === series().find(s => s.points.some(p => p.reportId === 'a'))!.indicatorKey, false, '机构未确认与已知机构分组隔离');
    insert('manual', '合成机构', 'U/L', '合成方法', '血清', '{}');
    const pendingIssue = listIndicatorNormalizationIssues(user).find(item => item.unit === 'U/L')!;
    assert.equal(pendingIssue.trendEligible, false, 'a mixed group remains pending until every record is usable');
    assert.equal(pendingIssue.reportId, 'manual', 'open the pending record rather than a newer usable record');
    assert.equal(pendingIssue.reason, getReportDetail(user, 'manual').observations.find(o => o.id === 'manual')?.displayReason, 'governance explains the same admission failure as report detail');
    assert.equal(series().some(s => s.points.some(p => p.reportId === 'manual')), false);
    updateManualObservation(user, 'manual', 'manual', { itemName: raw.itemName, resultText: '2', numericValue: 2, unit: 'U/L' });
    assert.equal(series().some(s => s.points.some(p => p.reportId === 'manual')), true);
    assert.equal(getReportDetail(user, 'manual').observations.find(o => o.id === 'manual')?.displayTier, 'primary');
    db.prepare("UPDATE observation_normalizations SET quality = 'excluded' WHERE observation_id = 'manual'").run();
    assert.equal(series().some(s => s.points.some(p => p.reportId === 'manual')), false);
    assert.notEqual(getReportDetail(user, 'manual').observations.find(o => o.id === 'manual')?.displayTier, 'primary');
    assert.throws(() => listTrendSeries({ ...user, id: 'unauthorized', isGatewayAdmin: false }, 'qa-member'), /无权访问/);
    const issue = listIndicatorNormalizationIssues(user).find(item => item.unit === 'U/L')!;
    assert.ok(issue);
    resolveIndicatorNormalizationIssue(user, { fingerprint: issue.fingerprint, action: 'exclude' });
    assert.throws(() => updateManualObservation(user, 'a', 'a', {
      itemName: 'ALT', resultText: '2', numericValue: 2, unit: 'U/L', canonicalKey: 'liver_alt'
    }), /撤销排除/);
    assert.equal((db.prepare("SELECT item_name FROM observations WHERE id = 'a'").get() as {item_name: string}).item_name, raw.itemName, 'rejected edit must not mutate fields');
    undoIndicatorGovernanceDecision(user, issue.fingerprint);
    updateManualObservation(user, 'a', 'a', { itemName: 'ALT', resultText: '2', numericValue: 2, unit: 'U/L', canonicalKey: 'liver_alt' });
    assert.ok(series().find(item => item.indicatorKey === 'liver_alt')?.points.some(point => point.reportId === 'a'));
    updateManualObservation(user, 'a', 'a', { itemName: 'ALT', resultText: '3', numericValue: 2, unit: 'U/L', canonicalKey: 'liver_alt' });
    assert.equal(series().some(item => item.points.some(point => point.reportId === 'a')), false, 'manual review does not bypass conflicting values');
    assert.match(getReportDetail(user, 'a').observations.find(item => item.id === 'a')?.displayReason || '', /数值与结果文本不一致/);
    updateManualObservation(user, 'a', 'a', { itemName: 'ALT', resultText: '3', numericValue: 3, unit: 'U/L', canonicalKey: 'liver_alt' });
    assert.equal(series().some(item => item.points.some(point => point.reportId === 'a')), true);
    insert('conflict');
    db.prepare("UPDATE observations SET item_name = '合成待校对项目乙', result_text = '3' WHERE id = 'conflict'").run();
    normalizeReportObservations('conflict');
    const conflictIssue = listIndicatorNormalizationIssues(user).find(item => item.rawName === '合成待校对项目乙')!;
    const mapped = resolveIndicatorNormalizationIssue(user, { fingerprint: conflictIssue.fingerprint, action: 'confirm', canonicalKey: 'liver_alt' });
    assert.equal(mapped.normalized, 0, 'identity mapping is not result verification');
    assert.equal(mapped.pending, 1);
    assert.match(mapped.remainingReasons[0].reason, /数值与结果文本不一致/);
    assert.equal(series().some(item => item.points.some(point => point.reportId === 'conflict')), false);
    updateManualObservation(user, 'conflict', 'conflict', { itemName: '合成待校对项目乙', resultText: '3', numericValue: 3, unit: 'U/L', canonicalKey: 'liver_alt' });
    assert.equal(series().some(item => item.points.some(point => point.reportId === 'conflict')), true);
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('limit records appear in details and time series without becoming exact values or anomaly evidence', () => {
  const dir = mkdtempSync(join(tmpdir(), 'health-limit-trends-'));
  const previous = process.env.STORAGE_DIR;
  process.env.STORAGE_DIR = dir;
  try {
    const db = getDatabase();
    db.prepare('INSERT INTO users(id,display_name) VALUES(?,?)').run(user.id, user.displayName);
    db.prepare("INSERT INTO health_members(id,display_name,created_by) VALUES('limit-member','合成成员',?)").run(user.id);
    db.prepare("INSERT INTO member_permissions(member_id,user_id,permission,granted_by) VALUES('limit-member',?,'manager',?)").run(user.id,user.id);
    const inputs = ['3', '4', '<999', '5', '>=1000'];
    inputs.forEach((text, index) => {
      const id = `limit-${index}`;
      db.prepare("INSERT INTO reports(id,member_id,created_by,title,report_type,status,report_issued_at) VALUES(?,'limit-member',?,'合成报告','laboratory','ready',?)").run(id,user.id,`2026-01-0${index+1}`);
      for (const name of ['丙氨酸氨基转移酶', '合成测定项目甲']) {
        db.prepare('INSERT INTO observations(id,report_id,item_name,result_text,numeric_value,unit,reference_low,reference_high,reference_text,evidence_json) VALUES(?,?,?,?,?,?,?,?,?,?)')
          .run(`${id}-${name}`,id,name,text,Number(text.replace(/^[<>=]+/,'')),'U/L',2,8,'2-8',JSON.stringify([{pageNumber:1,quote:`${name} ${text} U/L`} ]));
      }
      normalizeReportObservations(id);
    });
    const series = listTrendSeries(user,'limit-member');
    assert.equal(series.length,2);
    for (const item of series) {
      assert.equal(item.pointCount,5);
      assert.deepEqual(item.points.map(p=>p.resultComparator),[null,null,'<',null,'≥']);
      assert.equal(item.points.at(-1)?.resultText,'>=1000');
      assert.equal(item.latestValue,null);
      assert.equal(item.previousValue,5);
      assert.equal(item.delta,null);
      assert.equal(item.minValue,3);
      assert.equal(item.maxValue,5);
      assert.equal(item.analysisPointCount,3);
      assert.equal(item.outlierCount,0);
      assert.equal(item.trendConclusionAllowed,false);
      assert.equal(item.latestChangeStatus,'not_comparable');
      assert.equal(item.attentionLevel,null);
      assert.equal(item.latestAbnormal,false);
      assert.equal(item.recoveredFromAbnormal,false);
    }
    const detail = getReportDetail(user,'limit-4');
    assert.ok(detail.observations.every(o=>o.displayTier==='primary'));
    assert.ok(detail.observations.every(o=>o.displayReason?.includes('限值结果')));
    assert.equal((db.prepare('SELECT result_text text FROM observations WHERE report_id=? LIMIT 1').get('limit-4') as {text:string}).text,'>=1000');
  } finally {
    closeDatabaseForTests();
    if(previous===undefined)delete process.env.STORAGE_DIR;else process.env.STORAGE_DIR=previous;
    rmSync(dir,{recursive:true,force:true});
  }
});

test('standard admission preserves detection limits and requires item identity, including trusted aliases', () => {
  const dir = mkdtempSync(join(tmpdir(), 'health-evidence-'));
  const previous = process.env.STORAGE_DIR;
  process.env.STORAGE_DIR = dir;
  try {
    ensureBuiltinIndicatorCatalog();
    const base = { ...raw, itemName: '丙氨酸氨基转移酶', canonicalKey: 'liver_alt', canonicalName: '丙氨酸氨基转移酶', normalizationQuality: 'high', normalizationMatchedBy: 'exact', hasAiExtraction: 1 };
    const evidence = (quote: string) => JSON.stringify([{ pageNumber: 1, quote }]);
    for (const bound of ['<', '>', '≤', '≥', '<=', '>=']) {
      assert.equal(assessTrendAdmission({ ...base, evidenceJson: evidence(`丙氨酸氨基转移酶 ${bound}2 U/L`) }).eligible, false);
      for (const manualReviewed of [false, true]) {
        assert.equal(assessTrendAdmission({ ...base, resultText: `${bound}2`, manualReviewed, evidenceJson: evidence(`丙氨酸氨基转移酶 ${bound}2 U/L`) }).eligible, true);
      }
      assert.equal(assessTrendAdmission({...base, resultText: `${bound}2`, evidenceJson: evidence('ALT 2 U/L')}).eligible, false, 'a model cannot invent a limit');
    }
    assert.equal(assessTrendAdmission({ ...base, evidenceJson: evidence('合成另一项目 2 U/L') }).eligible, false);
    for (const resultText of ['↑ <2', '≤2 U/L', '<=２.０', '>=2e0']) {
      assert.equal(assessTrendAdmission({...base, resultText, evidenceJson:evidence(`ALT ${resultText}${resultText.includes('U/L') ? '' : ' U/L'}`)}).eligible,true,resultText);
    }
    assert.equal(assessTrendAdmission({ ...base, evidenceJson: evidence('ALT 2 U/L') }).eligible, true);
    assert.equal(assessTrendAdmission({ ...base, evidenceJson: evidence('SALT 2 U/L') }).eligible, false);
    assert.equal(assessTrendAdmission({ ...base, evidenceJson: evidence('丙氨酸氨基转移酶 2 U/L 参考范围 <2') }).eligible, true);
    for (const resultText of ['2-3','2～3','2至3','2 ± 0.1','2/3','约2','2 (3)','2 (mg/L)','<2-3','<约2','<2/3','<2 ± 1','<2.0.0']) {
      for (const manualReviewed of [false,true]) {
        assert.equal(assessTrendAdmission({...base,resultText,manualReviewed,evidenceJson:evidence(`ALT ${resultText} U/L`)}).eligible,false,resultText);
      }
    }
    for (const resultText of ['2','2 U/L','2（U/L）↑','2e0','２.０']) {
      assert.equal(assessTrendAdmission({...base,resultText,evidenceJson:evidence('ALT 2 U/L')}).eligible,true,resultText);
    }
    assert.equal(assessTrendAdmission({...base,evidenceJson:evidence('ALT 2-3 U/L')}).eligible,false);
    assert.equal(assessTrendAdmission({...base,evidenceJson:evidence('ALT 2 U/L 参考范围 2-3')}).eligible,true);
    assert.equal(assessTrendAdmission({...base,unit:'u/l',resultText:'2 U/L',evidenceJson:evidence('ALT 2 U/L')}).eligible,true);
    assert.equal(assessTrendAdmission({...base,unit:null,canonicalUnit:'U/L',resultText:'2 U/L',evidenceJson:evidence('ALT 2 U/L')}).eligible,true);
    assert.equal(assessTrendAdmission({...base,unit:null,canonicalUnit:'U/L',resultText:'2 mg/L',evidenceJson:evidence('ALT 2 mg/L')}).eligible,false);
    assert.equal(assessTrendAdmission({...base,resultText:'2e3',numericValue:2000,evidenceJson:evidence('ALT 2e3 U/L')}).eligible,true);
    for (const withCode of [false,true]) {
      const quote = `${withCode ? 'ABI ' : ''}右踝：1.07 | 左踝：1.08`;
      const side = {...base,itemName:'右侧踝肱指数',itemCode:'ABI',canonicalKey:'vascular_abi_right',canonicalName:'右侧踝肱指数',unit:null,evidenceJson:evidence(quote)};
      assert.equal(assessTrendAdmission({...side,resultText:'1.08',numericValue:1.08}).eligible,false);
      assert.equal(assessTrendAdmission({...side,resultText:'1.07',numericValue:1.07}).eligible,true);
      const pwv = {...side,itemName:'右侧肱踝脉搏波传导速度',itemCode:'baPWV',unit:'cm/s',evidenceJson:evidence(`${withCode ? 'baPWV ' : ''}右：1315 | 左：1395 | PWV(cm/s)`)};
      assert.equal(assessTrendAdmission({...pwv,resultText:'1395',numericValue:1395}).eligible,false);
      assert.equal(assessTrendAdmission({...pwv,resultText:'1315',numericValue:1315}).eligible,true);
    }
  } finally {
    closeDatabaseForTests();
    if (previous === undefined) delete process.env.STORAGE_DIR; else process.env.STORAGE_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('field evidence isolates neighbouring results, units and reference columns', () => {
  const directory = mkdtempSync(join(tmpdir(), 'health-field-evidence-'));
  const previous = process.env.STORAGE_DIR;
  process.env.STORAGE_DIR = directory;
  try {
    ensureBuiltinIndicatorCatalog();
    const base = { ...raw, itemName: 'ALT', itemCode: 'AST', resultText: '40', numericValue: 40,
      canonicalKey: 'liver_alt', canonicalName: '丙氨酸氨基转移酶', normalizationQuality: 'high', normalizationMatchedBy: 'exact', hasAiExtraction: 1 };
    const admitted = (quote: string, overrides = {}) => assessTrendAdmission({ ...base, ...overrides, evidenceJson: JSON.stringify([{pageNumber:1,quote}]) }).eligible;
    assert.equal(admitted('ALT 12 U/L | AST 40 U/L'), false, 'a wrong item code cannot override the printed name');
    assert.equal(admitted('ALT | 12 | U/L | 0-40'), false, 'reference endpoint is not a result');
    assert.equal(admitted('ALT | 40 | U/L | 0-40'), true);
    assert.equal(admitted('ALT 40 U/L | AST <40 U/L'), true, 'a neighbour detection limit does not change ALT');
    assert.equal(admitted('ALT <40 U/L | AST 40 U/L'), false);
    assert.equal(admitted('ALT 40-50 U/L'), false);
    assert.equal(admitted('ALT 40 mg/L | AST 40 U/L'), false, 'units belong to their own value');
    assert.equal(admitted('ALT 40 mg/L AST 40 U/L'), false, 'inline paragraphs cannot borrow the later unit');
    for (const quote of ['ALT <1e3 U/L', 'ALT <1,000 U/L', 'ALT 1e3-2e3 U/L', 'ALT 1,000-2,000 U/L']) {
      assert.equal(admitted(quote, {resultText:'1000',numericValue:1000}), false, quote);
    }
    assert.equal(admitted('超敏C反应蛋白 2 mg/L', {itemName:'C反应蛋白',itemCode:null,canonicalKey:'inflammation_crp',canonicalName:'C反应蛋白',resultText:'2',numericValue:2,unit:'mg/L'}), false);
    for (const result of ['↑40', '40↑', '40 H', '40H', '1,000', '1e3']) {
      const value = result === '1,000' || result === '1e3' ? 1000 : 40;
      assert.equal(admitted(`ALT ${result} U/L`, {resultText:result,numericValue:value}), true, result);
    }
  } finally {
    closeDatabaseForTests();
    if (previous === undefined) delete process.env.STORAGE_DIR; else process.env.STORAGE_DIR = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});

test('pipeline keeps uncertain visual values pending and only converts a printed unit', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'health-field-pipeline-'));
  const previous = process.env.STORAGE_DIR;
  process.env.STORAGE_DIR = directory;
  try {
    const db = getDatabase();
    db.exec(`INSERT INTO users(id,display_name) VALUES('qa-user','合成用户');
      INSERT INTO health_members(id,display_name,created_by) VALUES('qa-member','合成成员','qa-user');
      INSERT INTO member_permissions(member_id,user_id,permission,granted_by) VALUES('qa-member','qa-user','manager','qa-user');`);
    const empty = { ...normalizeAiExtraction({}), provider:'test',model:'test',promptVersion:'test',rawResponseJson:'{}',promptTokens:0,completionTokens:0,elapsedMs:0 };
    for (const scenario of [
      {id:'visual-swap',quote:'ALT 12 U/L | AST 37 U/L',name:'ALT',value:37,unit:'U/L',vision:true},
      {id:'missing-unit',quote:'空腹血糖 90',name:'空腹血糖',value:90,unit:null,vision:false},
      {id:'printed-unit',quote:'空腹血糖 90 mg/dL',name:'空腹血糖',value:90,unit:null,vision:false},
    ]) {
      const {id,quote} = scenario;
      const pageId = `${id}-page`, jobId = `${id}-ai`, ocrId = `${id}-ocr`;
      db.prepare("INSERT INTO reports(id,member_id,created_by,report_type,title,status,report_issued_at) VALUES(?,'qa-member','qa-user','laboratory','合成报告','ready','2026-01-01')").run(id);
      db.prepare("INSERT INTO report_pages(id,report_id,page_number,original_name,storage_path,mime_type,file_size,sha256) VALUES(?,?,1,'synthetic.png','synthetic.png','image/png',1,'synthetic')").run(pageId,id);
      db.prepare("INSERT INTO processing_jobs(id,report_id,page_id,job_type,status,pipeline_version,deduplication_key) VALUES(?,?,?,'ocr','completed','test',?)").run(ocrId,id,pageId,ocrId);
      db.prepare("INSERT INTO processing_jobs(id,report_id,job_type,status,pipeline_version,deduplication_key) VALUES(?,?,'ai_extract','processing','test',?)").run(jobId,id,jobId);
      db.prepare("INSERT INTO ocr_results(id,job_id,page_id,engine,model_version,lines_json) VALUES(?,?,?,'test','test',?)").run(`${id}-result`,ocrId,pageId,JSON.stringify([{id:'l1',text:quote,confidence:1,box:[0,0,1000,20]}]));
      const generated = { ...empty, ...normalizeAiExtraction({observations:[{itemName:scenario.name,resultText:String(scenario.value),numericValue:scenario.value,unit:scenario.unit,evidence:[{pageNumber:1,quote}]}]}) };
      let visionCalls = 0;
      const output = await executeAiExtractionPlan(jobId,id,async()=>generated,{
        visionReview: async input => {
          if (!scenario.vision) return null;
          visionCalls++;
          const group = groupVisionReviewPages(input.candidates)[0];
          if (!group) return null;
          const accepted = acceptVisionObservations(generated.fields.observations,group,input.result);
          return {...empty,fields:{...empty.fields,observations:accepted.accepted}};
        },
      });
      persistAiExtraction(id,jobId,output.result,output.inputCharacters);
      const detail = getReportDetail(user,id);
      const points = listTrendSeries(user,'qa-member').flatMap(series=>series.points).filter(point=>point.reportId===id);
      assert.equal(detail.observations.length,1,`${id} remains available for review`);
      if (scenario.id === 'printed-unit') {
        assert.equal(detail.observations[0].unit,'mg/dL');
        assert.equal(points.length,1);
        assert.ok(Math.abs(points[0].numericValue - 90 / 18.018) < 1e-8);
      } else {
        assert.equal(points.length,0,`${id} cannot publish an unverified numeric point`);
        assert.equal(detail.observations[0].normalizationQuality,'low');
      }
      if (scenario.vision) {
        assert.equal(visionCalls,1);
        assert.equal(output.result.fields.observations[0].evidence[0].source,'vision');
      }
    }
  } finally {
    closeDatabaseForTests();
    if (previous === undefined) delete process.env.STORAGE_DIR; else process.env.STORAGE_DIR = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});


test('detail and trends use the confirmed examination date even when the report date is absent', () => {
  const dir=mkdtempSync(join(tmpdir(),'health-time-admission-'));
  const previous=process.env.STORAGE_DIR;
  process.env.STORAGE_DIR=dir;
  try {
    const db=getDatabase();
    db.prepare('INSERT INTO users (id,display_name) VALUES (?,?)').run(user.id,user.displayName);
    db.prepare("INSERT INTO health_members (id,display_name,relationship,created_by) VALUES ('time-member','合成成员','self',?)").run(user.id);
    db.prepare("INSERT INTO member_permissions (member_id,user_id,permission,granted_by) VALUES ('time-member',?,'manager',?)").run(user.id,user.id);
    db.prepare("INSERT INTO reports (id,member_id,created_by,title,report_type,status) VALUES ('time-report','time-member',?,'合成报告','laboratory','needs_review')").run(user.id);
    db.prepare("INSERT INTO observations (id,report_id,item_name,result_text,numeric_value,unit,evidence_json) VALUES ('time-observation','time-report',?,'2',2,'U/L',?)").run(raw.itemName,raw.evidenceJson);
    normalizeReportObservations('time-report');
    db.prepare("INSERT INTO report_examinations (id,report_id,source_key,occurred_at,time_kind,time_precision,confirmation_status) VALUES ('time-exam','time-report','synthetic-time','2026-01-02','examined','date','confirmed')").run();
    db.prepare("INSERT INTO observation_examinations (observation_id,examination_id,assignment_source) VALUES ('time-observation','time-exam','manual')").run();
    const detail=()=>getReportDetail(user,'time-report');
    const series=()=>listTrendSeries(user,'time-member');
    assert.equal(detail().observations[0].displayTier,'primary');
    assert.equal(series()[0].pointCount,1);
    assert.equal(detail().status,'needs_review','time confirmation does not archive a report');
    // A pending examination cannot borrow the report date to enter either display.
    db.prepare("UPDATE reports SET report_issued_at='2026-01-03' WHERE id='time-report'").run();
    db.prepare("UPDATE report_examinations SET confirmation_status='pending',occurred_at=NULL WHERE id='time-exam'").run();
    assert.equal(detail().observations[0].displayTier,'secondary');
    assert.equal(detail().observations[0].displayReason,'请先确认检查时间');
    assert.equal(series().length,0);
  } finally {
    closeDatabaseForTests();
    if(previous===undefined)delete process.env.STORAGE_DIR;else process.env.STORAGE_DIR=previous;
    rmSync(dir,{recursive:true,force:true});
  }
});
