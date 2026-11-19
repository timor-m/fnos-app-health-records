import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {getDatabase,closeDatabaseForTests} from '../database/client.ts';
import {installRemoteDictionarySnapshotForTests} from '../services/indicator-dictionary.service.ts';
import {normalizeObservation,backfillBuiltinIndicatorNormalizations} from '../services/indicator-normalization.service.ts';

test('collection aliases preserve ratio, qualitative, unit and bone-method boundaries and backfill raw names unchanged',()=>{
  const dir=mkdtempSync(join(tmpdir(),'o0008-dictionary-'));
  const previous=process.env.STORAGE_DIR;process.env.STORAGE_DIR=dir;
  try {
    const db=getDatabase();installRemoteDictionarySnapshotForTests();
    db.prepare("INSERT INTO users(id,display_name) VALUES('review-admin','Synthetic')").run();
    db.prepare("INSERT INTO health_members(id,display_name,created_by) VALUES('review-member','Synthetic','review-admin')").run();
    db.prepare("INSERT INTO reports(id,member_id,created_by,title,report_type,status) VALUES('review-report','review-member','review-admin','Synthetic','laboratory','ready')").run();
    const base={id:'synthetic',reportId:'review-report',sectionName:'生化',itemCode:null,normalizedName:null,
      resultText:'1.25',numericValue:1.25,unit:null,referenceText:null,reportType:'laboratory',hospitalName:null,
      performingDepartment:null,reportingDepartment:null};
    const cases=[
      ['血清间接胆红素(计算值)(非 结合胆红素)','生化','μmol/L','liver_ibil'],
      ['尿蛋白质','尿常规','g/L','urine_protein_quantitative'],
      ['体脂百分比 (%)','人体成分','%','body_fat_percentage'],
      ['天门冬氨酸氨基转移酶/丙氨 酸氨基转移酶(计算值)','生化',null,'liver_ast_alt_ratio'],
      ['天门冬氨酸/丙氨酸氨基转移酶比值','生化',null,'liver_ast_alt_ratio'],
      ['血清y-谷氨酰基转移酶测定','生化','U/L','liver_ggt']
    ] as const;
    for(const [index,[itemName,sectionName,unit,key]] of cases.entries()) {
      const r=normalizeObservation({...base,itemName,sectionName,unit});
      assert.equal(r.canonicalKey,key,itemName);assert.notEqual(r.quality,'low',itemName);
      db.prepare("INSERT INTO observations(id,report_id,item_name,section_name,unit,result_text,numeric_value) VALUES(?,'review-report',?,?,?,'1.25',1.25)")
        .run(`review-${index}`,itemName,sectionName,unit);
    }
    const raw=()=>db.prepare('SELECT item_name,result_text,numeric_value,unit FROM observations ORDER BY id').all();
    const before=raw();backfillBuiltinIndicatorNormalizations();
    for(const [index,[,,,key]] of cases.entries())assert.equal(db.prepare('SELECT canonical_key AS key FROM observation_normalizations WHERE observation_id=?').get(`review-${index}`)?.key,key);
    assert.deepEqual(raw(),before);
    const protein=normalizeObservation({...base,itemName:'尿蛋白质',sectionName:'尿常规',resultText:'阴性',numericValue:null});
    assert.equal(protein.canonicalKey,'urine_protein');assert.equal(protein.quality,'excluded');
    for(const [itemName,itemCode,key] of [['癌胚抗原(定性)','CEA','tumor_cea'],['甲胎蛋白(定性)','AFP','tumor_afp']]) {
      for(const unit of [null,'ng/mL']) {
        const r=normalizeObservation({...base,itemName,itemCode,normalizedName:itemName.split('(')[0],unit});
        assert.notEqual(r.canonicalKey,key,'code and AI name cannot erase an explicit qualitative qualifier');
      }
    }
    assert.equal(normalizeObservation({...base,itemName:'癌胚抗原',unit:'ng/mL'}).canonicalKey,'tumor_cea');
    assert.equal(normalizeObservation({...base,itemName:'甲胎蛋白',unit:'ng/mL'}).canonicalKey,'tumor_afp');
    assert.equal(normalizeObservation({...base,itemName:'乙型肝炎表面抗原定性',resultText:'阴性',numericValue:null}).canonicalKey,'infectious_hbsag');
    assert.notEqual(normalizeObservation({...base,itemName:'尿蛋白质',sectionName:'生化血清',unit:'g/L'}).canonicalKey,'urine_protein_quantitative');
    for(const [itemName,unit] of [['体脂百分比 (%)','kg'],['血清间接胆红素(计算值)(非结合胆红素)','U/L']])assert.equal(normalizeObservation({...base,itemName,unit}).quality,'low');
    for(const itemName of ['T值','Z值']) {
      assert.equal(normalizeObservation({...base,itemName,sectionName:'DXA骨密度'}).canonicalKey,null);
      assert.match(normalizeObservation({...base,itemName,sectionName:'定量超声骨密度'}).canonicalKey||'',/^qus_bone_/);
    }
    for(const itemName of ['其他','腹壁','家族史','左回旋支','日期','(计算值)','空腹血糖保持在','血压','内脏脂肪等级'])assert.equal(normalizeObservation({...base,itemName}).canonicalKey,null,itemName);
  } finally {
    closeDatabaseForTests();if(previous===undefined)delete process.env.STORAGE_DIR;else process.env.STORAGE_DIR=previous;
    rmSync(dir,{recursive:true,force:true});
  }
});
