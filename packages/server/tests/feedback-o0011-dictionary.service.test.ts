import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {closeDatabaseForTests, getDatabase} from '../database/client';
import {installRemoteDictionarySnapshotForTests} from '../services/indicator-dictionary.service';
import {backfillBuiltinIndicatorNormalizations, normalizeObservation} from '../services/indicator-normalization.service';

test('O0011 adds only explicit M65 names and backfills without changing original observations', () => {
  const previous = process.env.STORAGE_DIR;
  const storage = mkdtempSync(join(tmpdir(), 'o0011-dictionary-'));
  process.env.STORAGE_DIR = storage;
  try {
    const db = getDatabase();
    db.exec("INSERT INTO users(id,display_name) VALUES('o11-owner','Synthetic'); INSERT INTO health_members(id,display_name,created_by) VALUES('o11-member','Synthetic','o11-owner'); INSERT INTO reports(id,member_id,created_by,title,report_type,status) VALUES('o11-report','o11-member','o11-owner','Synthetic','laboratory','ready')");
    const base = {id:'o11-observation', reportId:'o11-report', itemName:'人细胞角蛋白18片段M65', itemCode:null, normalizedName:null, resultText:'1.25', numericValue:1.25, unit:'U/L', referenceText:null, sectionName:'肝功能', reportType:'laboratory', hospitalName:null, performingDepartment:null, reportingDepartment:null};
    db.prepare("INSERT INTO observations(id,report_id,item_name,unit,section_name,result_text,numeric_value) VALUES(?,'o11-report',?,'U/L','肝功能','1.25',1.25)").run(base.id, base.itemName);
    const raw = () => db.prepare('SELECT * FROM observations WHERE id=?').get(base.id);
    const before = raw();
    // Ablation: the packaged core alone must not claim this independent assay.
    assert.notEqual(normalizeObservation(base).canonicalKey, 'liver_ck18_m65');
    installRemoteDictionarySnapshotForTests();
    for (const itemName of ['人细胞角蛋白18片段M65', '细胞角蛋白18片段M65', 'CK18-M65', 'CK18 M65', 'K18-M65']) {
      const row = normalizeObservation({...base, itemName});
      assert.equal(row.canonicalKey, 'liver_ck18_m65', itemName);
      assert.ok(['high', 'medium'].includes(row.quality), itemName);
    }
    for (const itemName of ['CK18-M30', '人细胞角蛋白18片段M30', 'CK18', '细胞角蛋白18片段', 'M30/M65比值', 'CK18-M65抗体', '细胞角蛋白19片段', 'CYFRA21-1']) {
      const row = normalizeObservation({...base, itemName});
      assert.ok(row.canonicalKey !== 'liver_ck18_m65' || ['low', 'excluded'].includes(row.quality), itemName);
    }
    for (const override of [{unit:'ng/mL'}, {unit:'U/mL'}, {sectionName:'尿液检验'}, {sectionName:'粪便检验'}, {numericValue:null, resultText:'阳性'}, {itemName:'CK18-M30', itemCode:'CK18-M65'}, {itemName:'细胞角蛋白18片段', normalizedName:'CK18-M65'}, {itemName:'M30/M65比值', itemCode:'CK18-M65'}]) {
      const row = normalizeObservation({...base, ...override});
      assert.ok(row.canonicalKey !== 'liver_ck18_m65' || ['low', 'excluded'].includes(row.quality), JSON.stringify(override));
    }
    backfillBuiltinIndicatorNormalizations();
    assert.equal(db.prepare('SELECT canonical_key FROM observation_normalizations WHERE observation_id=?').get(base.id)?.canonical_key, 'liver_ck18_m65');
    assert.deepEqual(raw(), before);
  } finally {
    closeDatabaseForTests();
    if (previous === undefined) delete process.env.STORAGE_DIR;
    else process.env.STORAGE_DIR = previous;
    rmSync(storage, {recursive:true, force:true});
  }
});
