import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { closeDatabaseForTests, getDatabase } from '../database/client';
import { assessTrendAdmission, normalizeReportObservations, previewIndicatorNormalization, listIndicatorNormalizationIssues, resolveIndicatorNormalizationIssue, undoIndicatorGovernanceDecision } from '../services/indicator-normalization.service';
import { getReportDetail, listTrendSeries, updateTrendPin } from '../services/records.service';
import { updateManualObservation } from '../services/observation-field-overrides.service';

const user = { id: 'qa-user', displayName: '合成用户', authenticated: true, provider: 'development', isGatewayAdmin: true } as const;
const raw = {
  reportId: 'qa-report', itemName: '合成测定项目甲', resultText: '2', numericValue: 2, unit: 'U/L',
  evidenceJson: JSON.stringify([{ pageNumber: 1, quote: '合成测定项目甲 2 U/L' }]),
  normalizationQuality: 'low', normalizationMatchedBy: 'none', hospitalName: '合成机构', reportIssuedAt: '2026-01-01',
};

test('shared admission requires verified raw numbers and never bypasses exclusions or identity conflicts', () => {
  assert.equal(assessTrendAdmission(raw).kind, 'institution');
  for (const invalid of [
    { evidenceJson: '[]' }, { evidenceJson: '{}' }, { unit: '' }, { hospitalName: '' }, { reportIssuedAt: '' },
    { resultText: '<2' }, { numericValue: 3 }, { normalizationQuality: 'excluded' },
    { evidenceJson: JSON.stringify([{ pageNumber: 1, quote: '合成测定项目甲 <2 U/L' }]) },
    { canonicalKey: 'conflicted' }, { normalizationMatchedBy: 'ambiguous' },
    { evidenceJson: JSON.stringify([{ quote: '其他项目 2 U/L' }]) },
    { evidenceJson: JSON.stringify([{ quote: '合成测定项目甲 2 mg/L' }]) },
  ]) assert.equal(assessTrendAdmission({ ...raw, ...invalid }).eligible, false, JSON.stringify(invalid));
  assert.equal(assessTrendAdmission({ ...raw, evidenceJson: '[]', manualReviewed: true }).kind, 'institution');
  assert.equal(assessTrendAdmission({ ...raw, canonicalKey: 'qa', canonicalName: '合成标准项', normalizationQuality: 'high', normalizationMatchedBy: 'exact', evidenceJson: '[]', hasAiExtraction: 0 }).kind, 'standard');
});

test('raw trend channel shares detail admission, isolates contexts, and responds to edits and exclusions', () => {
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
