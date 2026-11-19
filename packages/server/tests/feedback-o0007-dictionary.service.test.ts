import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { closeDatabaseForTests, getDatabase } from '../database/client.ts';
import { installRemoteDictionarySnapshotForTests } from '../services/indicator-dictionary.service.ts';
import { activeIndicatorNormalizationVersion, backfillBuiltinIndicatorNormalizations, normalizeObservation } from '../services/indicator-normalization.service.ts';
import { cleanIndicatorName } from '../utils/indicator-name.ts';

test('triangle footnotes are removed without stripping delta or medically significant numbers', () => {
  for (const [raw, expected] of [['19△血小板计数','血小板计数'], ['12△红细胞计数','红细胞计数'],
    ['1△白细胞计数','白细胞计数'], ['17△红细胞压积','红细胞压积'], ['△总钙','总钙']]) {
    assert.equal(cleanIndicatorName(raw).name, expected);
  }
  for (const name of ['Δ血糖','25羟维生素D','β2微球蛋白','24小时尿蛋白定量','CD4+','17-羟孕酮']) {
    assert.equal(cleanIndicatorName(name).name, name);
  }
  assert.equal(cleanIndicatorName('20△平均红细胞血红蛋白浓度123').name,'平均红细胞血红蛋白浓度123',
    'a trailing number requires source review and must not be silently discarded');
});

test('reviewed additions and aliases backfill without changing raw data or merging specimen and value boundaries', () => {
  const storage = mkdtempSync(join(tmpdir(), 'o0007-dictionary-'));
  const previous = process.env.STORAGE_DIR;
  process.env.STORAGE_DIR = storage;
  try {
    const db = getDatabase();
    installRemoteDictionarySnapshotForTests();
    db.prepare("INSERT INTO users(id,display_name,is_gateway_admin) VALUES('review-admin','Synthetic',1)").run();
    db.prepare("INSERT INTO health_members(id,display_name,created_by) VALUES('review-member','Synthetic','review-admin')").run();
    db.prepare("INSERT INTO reports(id,member_id,created_by,title,report_type,status) VALUES('review-report','review-member','review-admin','Synthetic','laboratory','ready')").run();
    const base = { id:'synthetic', reportId:'review-report', sectionName:'生化', itemCode:null,
      normalizedName:null, resultText:'1.25', numericValue:1.25, unit:'U/L', referenceText:null,
      reportType:'laboratory', hospitalName:null, performingDepartment:null, reportingDepartment:null };
    const cases = [
      ['血常规','19△血小板计数','10^9/L','cbc_plt'],
      ['血常规','12△红细胞计数','10^12/L','cbc_rbc'],
      ['血常规','1△白细胞计数','10^9/L','cbc_wbc'],
      ['血常规','17△红细胞压积','%','cbc_hct'],
      ['血常规','嗜碱粒细胞绝对值','10^9/L','cbc_basophil_count'],
      ['血常规','嗜酸粒细胞绝对值','10^9/L','cbc_eosinophil_count'],
      ['生化','△总钙','mmol/L','electrolyte_calcium'],
      ['生化','脂肪酶(LIP)','U/L','laboratory_lipase'],
      ['生化','β-羟丁酸(β-HB)','mmol/L','metabolic_beta_hydroxybutyrate'],
      ['生化','胆碱脂酶(CHE)','U/L','laboratory_cholinesterase'],
      ['生化','前白蛋白(PA)','mg/L','liver_prealbumin'],
      ['血气分析','碳氧血红蛋白 COHb','%','blood_gas_cohb'],
      ['血气分析','12 总血红蛋白浓度(tHb)','g/dL','blood_gas_thb'],
      ['血气分析','二氧化碳分压(PCO2)','mmHg','blood_gas_paco2'],
      ['血气分析','氧分压(PO2)','mmHg','blood_gas_pao2']
    ];
    for (const [index,[sectionName,itemName,unit,key]] of cases.entries()) {
      const result = normalizeObservation({...base,sectionName,itemName,unit});
      assert.equal(result.canonicalKey,key,itemName);
      assert.notEqual(result.quality,'low',itemName);
      db.prepare("INSERT INTO observations(id,report_id,section_name,item_name,result_text,numeric_value,unit) VALUES(?,'review-report',?,?, '1.25',1.25,?)")
        .run(`review-${index}`,sectionName,itemName,unit);
    }
    const rawRows = () => db.prepare('SELECT item_name,result_text,numeric_value,unit FROM observations ORDER BY id').all();
    const original = rawRows();
    backfillBuiltinIndicatorNormalizations();
    db.prepare("UPDATE observation_normalizations SET canonical_key=NULL, version=? WHERE observation_id='review-0'")
      .run(activeIndicatorNormalizationVersion().replace('p16-', 'p15-'));
    backfillBuiltinIndicatorNormalizations();
    for (const [index,[,,,key]] of cases.entries()) {
      const row = db.prepare('SELECT canonical_key AS key,version FROM observation_normalizations WHERE observation_id=?').get(`review-${index}`);
      assert.equal(row?.key,key);
      assert.equal(row?.version,activeIndicatorNormalizationVersion());
    }
    assert.deepEqual(rawRows(),original);
    for (const [itemName,key] of [['钩虫卵检查','stool_hookworm_eggs'],['鞭虫卵检查','stool_whipworm_eggs'],['隐血试验','stool_occult_blood']]) {
      const categorical = normalizeObservation({...base,sectionName:'便常规',itemName,unit:null,numericValue:null,resultText:'阴性'});
      assert.equal(categorical.canonicalKey,key);
      assert.equal(categorical.quality,'excluded');
      assert.notEqual(normalizeObservation({...base,sectionName:'尿液',itemName,unit:null}).canonicalKey,key);
    }
    for (const itemName of ['血清脂浊指数(Lip)','血清溶血指数(Hem)','淋巴细胞分类','肺动脉氧分压比','20△平均红细胞血红蛋白浓度123']) {
      assert.equal(normalizeObservation({...base,itemName}).canonicalKey,null,itemName);
    }
    assert.equal(normalizeObservation({...base,itemName:'脂肪酶(LIP)',unit:'mg/L'}).quality,'low');
    assert.notEqual(normalizeObservation({...base,sectionName:'尿液',itemName:'β-羟丁酸',unit:'mmol/L'}).canonicalKey,'metabolic_beta_hydroxybutyrate');
    assert.equal(normalizeObservation({...base,itemName:'血红蛋白',unit:'g/L'}).canonicalKey,'cbc_hgb');
  } finally {
    closeDatabaseForTests();
    if (previous === undefined) delete process.env.STORAGE_DIR; else process.env.STORAGE_DIR=previous;
    rmSync(storage,{recursive:true,force:true});
  }
});
