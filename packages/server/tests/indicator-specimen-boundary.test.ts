import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { closeDatabaseForTests, getDatabase } from '../database/client.ts';
import { assessTrendAdmission, normalizeObservation } from '../services/indicator-normalization.service.ts';

test('specimen and microscopy boundaries do not trap reliable raw numeric observations', () => {
  const storage = mkdtempSync(join(tmpdir(), 'indicator-specimen-'));
  const previous = process.env.STORAGE_DIR;
  process.env.STORAGE_DIR = storage;
  try {
    const base = {
      id: 'synthetic', reportId: 'synthetic', sectionName: '尿液', itemCode: null,
      normalizedName: null, resultText: '42', numericValue: 42, unit: '个/uL',
      referenceText: null, reportType: 'laboratory', hospitalName: '测试机构',
      reportIssuedAt: '2026-01-01', performingDepartment: null, reportingDepartment: null,
      hasAiExtraction: 1,
    };
    for (const itemName of ['红细胞', '白细胞', '管型']) {
      const row = { ...base, itemName, evidenceJson: JSON.stringify([{ pageNumber: 1, quote: `${itemName} 42 个/uL` }]) };
      const normalized = normalizeObservation(row);
      assert.equal(normalized.canonicalKey, null, itemName);
      assert.equal(normalized.matchedBy, 'none');
      assert.equal(assessTrendAdmission({ ...row,
        normalizationQuality: normalized.quality, normalizationMatchedBy: normalized.matchedBy,
        canonicalKey: normalized.canonicalKey, canonicalName: normalized.canonicalName,
      }).kind, 'institution');
    }
    const blood = normalizeObservation({ ...base, sectionName: '血常规', itemName: '红细胞', unit: '10^12/L', hasAiExtraction: 0 });
    for (const printed of ['*10^9/L', '×10^9/L', '10^9/L']) {
      const admission = assessTrendAdmission({ ...base, itemName: '合成项目', unit: '10^9/L',
        normalizationQuality: 'high', normalizationMatchedBy: 'none', canonicalKey: null, canonicalName: null,
        evidenceJson: JSON.stringify([{ pageNumber: 1, quote: `合成项目 42 ${printed}` }]) });
      assert.equal(admission.kind, 'institution', printed);
    }
    for (const [unit, printed] of [['g/L', 'mg/L'], ['10^9/L', 'mgx10^9/L']]) {
      const admission = assessTrendAdmission({ ...base, itemName: '合成项目', unit,
        normalizationQuality: 'high', normalizationMatchedBy: 'none', canonicalKey: null, canonicalName: null,
        evidenceJson: JSON.stringify([{ pageNumber: 1, quote: `合成项目 42 ${printed}` }]) });
      assert.notEqual(admission.kind, 'institution');
    }
    assert.equal(blood.canonicalKey, 'cbc_rbc');
    const incompatible = normalizeObservation({ ...base, sectionName: '血常规', itemName: '红细胞', unit: 'kg', hasAiExtraction: 0 });
    assert.equal(incompatible.canonicalKey, 'cbc_rbc');
    assert.equal(incompatible.quality, 'low');
    const microscopy = normalizeObservation({ ...base, itemName: '管型(镜检)', unit: '/LPF', hasAiExtraction: 0 });
    assert.equal(microscopy.canonicalKey, 'urine_casts');
    const wrongStool = normalizeObservation({ ...base, itemName: '白细胞(镜检)', unit: '/HP', resultText: '-', numericValue: null });
    assert.notEqual(wrongStool.canonicalKey, 'stool_wbc');
    getDatabase().exec(`
      INSERT INTO users (id, display_name) VALUES ('u', '测试');
      INSERT INTO health_members (id, display_name, relationship, created_by) VALUES ('m', '测试', 'self', 'u');
      INSERT INTO reports (id, member_id, created_by, report_type, title, status)
      VALUES ('synthetic', 'm', 'u', 'laboratory', '尿液分析', 'ready');
    `);
    const fromTitle = normalizeObservation({ ...base, sectionName: null, itemName: '白细胞' });
    assert.equal(fromTitle.canonicalKey, null);
    // A specific blood section takes precedence over the report-level title.
    assert.equal(normalizeObservation({ ...base, sectionName: '血常规', itemName: '白细胞', unit: '10^9/L', hasAiExtraction: 0 }).canonicalKey, 'cbc_wbc');
  } finally {
    closeDatabaseForTests();
    if (previous === undefined) delete process.env.STORAGE_DIR;
    else process.env.STORAGE_DIR = previous;
    rmSync(storage, { recursive: true, force: true });
  }
});
