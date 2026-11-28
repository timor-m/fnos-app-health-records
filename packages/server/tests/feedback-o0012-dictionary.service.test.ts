import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {closeDatabaseForTests, getDatabase} from '../database/client';
import {installRemoteDictionarySnapshotForTests} from '../services/indicator-dictionary.service';
import {backfillBuiltinIndicatorNormalizations, normalizeObservation} from '../services/indicator-normalization.service';

test('O0012 keeps M30, M65, urinary concentration and serum creatinine as separate identities', () => {
  const previous = process.env.STORAGE_DIR;
  const storage = mkdtempSync(join(tmpdir(), 'o0012-dictionary-'));
  process.env.STORAGE_DIR = storage;
  try {
    const db = getDatabase();
    db.exec("INSERT INTO users(id,display_name) VALUES('o12-owner','Synthetic'); INSERT INTO health_members(id,display_name,created_by) VALUES('o12-member','Synthetic','o12-owner'); INSERT INTO reports(id,member_id,created_by,title,report_type,status) VALUES('o12-report','o12-member','o12-owner','Synthetic','laboratory','ready')");
    const base = {id:'o12-row', reportId:'o12-report', itemName:'人细胞角蛋白18片段M30', itemCode:null, normalizedName:null, resultText:'1.25', numericValue:1.25, unit:'U/L', referenceText:null, sectionName:'肝功能', reportType:'laboratory', hospitalName:null, performingDepartment:null, reportingDepartment:null};
    const urine = {...base, itemName:'尿肌酐', unit:'mmol/L', sectionName:'尿液检验'};
    const ineligible = (row: ReturnType<typeof normalizeObservation>, key: string, label: string) => assert.ok(row.canonicalKey !== key || ['low','excluded'].includes(row.quality), label);
    assert.notEqual(normalizeObservation(base).canonicalKey, 'liver_ck18_m30');
    assert.notEqual(normalizeObservation(urine).canonicalKey, 'urine_creatinine');
    for (const [id,row] of [['o12-m30',base],['o12-urine',urine]] as const) {
      db.prepare("INSERT INTO observations(id,report_id,item_name,unit,section_name,result_text,numeric_value) VALUES(?,'o12-report',?,?,?,'1.25',1.25)").run(id,row.itemName,row.unit,row.sectionName);
    }
    const raw = () => db.prepare('SELECT * FROM observations ORDER BY id').all();
    const before = raw();
    installRemoteDictionarySnapshotForTests();
    for (const itemName of ['人细胞角蛋白18片段M30','细胞角蛋白18片段M30','CK18-M30','CK18 M30','K18-M30']) {
      const row = normalizeObservation({...base,itemName});
      assert.equal(row.canonicalKey,'liver_ck18_m30',itemName);
      assert.ok(['high','medium'].includes(row.quality),itemName);
    }
    for (const override of [{itemName:'CK18'}, {itemName:'细胞角蛋白18片段'}, {itemName:'CK18-M65'}, {itemName:'CK18-M30抗体'}, {itemName:'M30/M65比值',itemCode:'CK18-M30'}, {itemName:'CK18-M65',itemCode:'CK18-M30'}, {itemName:'CK18',normalizedName:'CK18-M30'}, {unit:'ng/mL'}, {unit:'U/mL'}, {sectionName:'尿液检验'}, {numericValue:null,resultText:'阳性'}]) {
      ineligible(normalizeObservation({...base,...override}),'liver_ck18_m30',JSON.stringify(override));
    }
    assert.equal(normalizeObservation({...base,itemName:'CK18-M65'}).canonicalKey,'liver_ck18_m65');
    for (const itemName of ['尿肌酐','尿肌酐测定','尿肌酐浓度','随机尿肌酐','Urine creatinine','Creatinine urine']) {
      for (const unit of ['mmol/L','μmol/L','umol/L','mg/dL']) {
        const row = normalizeObservation({...urine,itemName,unit});
        assert.equal(row.canonicalKey,'urine_creatinine',itemName+' '+unit);
        assert.ok(['high','medium'].includes(row.quality),itemName+' '+unit);
      }
    }
    for (const override of [{itemName:'24小时尿肌酐',normalizedName:'尿肌酐',unit:'mmol/24h'}, {unit:'mg/24h'}, {unit:'mL/min'}, {itemName:'尿白蛋白/肌酐比值',itemCode:'尿肌酐'}, {itemName:'尿肌酐清除率',itemCode:'尿肌酐'}, {itemName:'血清肌酐',itemCode:'尿肌酐'}, {sectionName:'血清检验'}, {sectionName:'粪便检验'}]) {
      ineligible(normalizeObservation({...urine,...override}),'urine_creatinine',JSON.stringify(override));
    }
    for (const override of [{itemName:'尿肌酐',itemCode:'CREA',unit:'mg/dL',sectionName:'生化'}, {itemName:'Urine creatinine',itemCode:'Cr',unit:'mg/dL',sectionName:'生化'}]) {
      const row = normalizeObservation({...base,...override});
      ineligible(row,'renal_creatinine','explicit urine must not become serum');
      assert.equal(row.canonicalKey,'urine_creatinine');
    }
    assert.equal(normalizeObservation({...base,itemName:'血肌酐',unit:'μmol/L',sectionName:'肾功能'}).canonicalKey,'renal_creatinine');
    assert.equal(normalizeObservation({...urine,itemName:'尿白蛋白/肌酐比值',unit:'mg/g'}).canonicalKey,'urine_albumin_creatinine_ratio');
    backfillBuiltinIndicatorNormalizations();
    assert.deepEqual(db.prepare('SELECT canonical_key FROM observation_normalizations ORDER BY observation_id').all().map(row=>row.canonical_key),['liver_ck18_m30','urine_creatinine']);
    assert.deepEqual(raw(),before);
  } finally {
    closeDatabaseForTests();
    if (previous === undefined) delete process.env.STORAGE_DIR;
    else process.env.STORAGE_DIR = previous;
    rmSync(storage,{recursive:true,force:true});
  }
});
