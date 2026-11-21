import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {closeDatabaseForTests,getDatabase} from '../database/client';
import {installRemoteDictionarySnapshotForTests} from '../services/indicator-dictionary.service';
import {normalizeObservation,backfillBuiltinIndicatorNormalizations} from '../services/indicator-normalization.service';

test('O0009 dictionary matches explicit names, preserves unit and specimen boundaries and backfills raw rows unchanged',()=>{
 const previous=process.env.STORAGE_DIR,storage=mkdtempSync(join(tmpdir(),'o0009-dictionary-'));process.env.STORAGE_DIR=storage;
 try{
  const db=getDatabase();
  db.exec("INSERT INTO users(id,display_name) VALUES('o9-owner','Synthetic'); INSERT INTO health_members(id,display_name,created_by) VALUES('o9-member','Synthetic','o9-owner'); INSERT INTO reports(id,member_id,created_by,title,report_type,status) VALUES('o9-report','o9-member','o9-owner','Synthetic','laboratory','ready')");
  const base={id:'synthetic',reportId:'o9-report',itemCode:null,normalizedName:null,resultText:'1.25',numericValue:1.25,referenceText:null,reportType:'laboratory',hospitalName:null,performingDepartment:null,reportingDepartment:null};
  const cases=[['肌红蛋白','ng/mL','心肌标志物','cardiac_myoglobin'],['嗜中性粒细胞百分比','%','血常规','cbc_neutrophil_percentage'],['嗜中性粒细胞绝对数','10^9/L','血常规','cbc_neutrophil_count']] as const;
  for(const [i,[itemName,unit,sectionName]] of cases.entries())db.prepare("INSERT INTO observations(id,report_id,item_name,unit,section_name,result_text,numeric_value) VALUES(?,'o9-report',?,?,?,'1.25',1.25)").run(`o9-${i}`,itemName,unit,sectionName);
  const raw=()=>db.prepare('SELECT id,item_name,result_text,numeric_value,unit FROM observations ORDER BY id').all();const before=raw();
  installRemoteDictionarySnapshotForTests();
  for(const [itemName,unit,sectionName,key] of cases){const row=normalizeObservation({...base,itemName,unit,sectionName});assert.equal(row.canonicalKey,key,itemName);assert.ok(['high','medium'].includes(row.quality),itemName);}
  for(const unit of ['μg/L','ug/L'])assert.equal(normalizeObservation({...base,itemName:'血清肌红蛋白',unit,sectionName:'心肌标志物'}).canonicalKey,'cardiac_myoglobin');
  for(const [itemName,unit,sectionName,key] of [
   ['嗜中性粒细胞百分比','10^9/L','血常规','cbc_neutrophil_percentage'],['嗜中性粒细胞绝对数','%','血常规','cbc_neutrophil_count'],['肌红蛋白','U/L','心肌标志物','cardiac_myoglobin'],['尿肌红蛋白','ng/mL','尿液检验','cardiac_myoglobin'],['肌红蛋白抗体','ng/mL','免疫学','cardiac_myoglobin']
  ]){const row=normalizeObservation({...base,itemName,unit,sectionName});assert.ok(row.canonicalKey!==key||['low','excluded'].includes(row.quality),itemName+' must not be an eligible match');}
  for(const [itemName,key,unit] of [['中性粒细胞百分比','cbc_neutrophil_percentage','%'],['中性粒细胞绝对值','cbc_neutrophil_count','10^9/L'],['肌钙蛋白 I','tumor_troponin_i','ng/mL']])assert.equal(normalizeObservation({...base,itemName,unit,sectionName:'生化'}).canonicalKey,key);
  backfillBuiltinIndicatorNormalizations();
  assert.deepEqual(db.prepare('SELECT canonical_key FROM observation_normalizations ORDER BY observation_id').all().map(r=>r.canonical_key),cases.map(c=>c[3]));
  assert.deepEqual(raw(),before);
 }finally{closeDatabaseForTests();if(previous===undefined)delete process.env.STORAGE_DIR;else process.env.STORAGE_DIR=previous;rmSync(storage,{recursive:true,force:true});}
});
