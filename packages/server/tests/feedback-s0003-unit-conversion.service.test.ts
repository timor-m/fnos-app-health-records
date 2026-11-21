import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {getDatabase,closeDatabaseForTests} from '../database/client';
import {convertUnit,dictionaryReferenceForUnit,normalizeReportObservations,backfillBuiltinIndicatorNormalizations,activeIndicatorNormalizationVersion} from '../services/indicator-normalization.service';
import {listTrendSeries,getReportDetail} from '../services/records.service';

const near=(actual:number|null,expected:number)=>assert.ok(actual!==null&&Math.abs(actual-expected)<1e-9,`${actual} != ${expected}`);
test('total T4 converts bidirectionally without changing unrelated analytes or scales',()=>{
 near(convertUnit('thyroid_t4_total',2,'μg/dL','nmol/L'),25.74);
 near(convertUnit('thyroid_t4_total',25.74,'nmol/L','μg/dL'),2);
 near(convertUnit('thyroid_t4_total',2,'µg/dL','nmol/L'),25.74);
 near(convertUnit('thyroid_t4_total',2,'ug/dL','nmol/L'),25.74);
 near(convertUnit('thyroid_t4_total',2,'mcg/dl','nmol/L'),25.74);
 assert.equal(convertUnit('thyroid_ft4',2,'μg/dL','nmol/L'),null);
 assert.equal(convertUnit('thyroid_t3_total',2,'μg/dL','nmol/L'),null);
 assert.equal(convertUnit('thyroid_t4_total',2,'mg/dL','nmol/L'),null);
 assert.equal(convertUnit('thyroid_t4_total',2,'ng/dL','pmol/L'),null);
 const range=dictionaryReferenceForUnit(JSON.stringify({low:12.87,high:38.61}), 'thyroid_t4_total','nmol/L','μg/dL');
 assert.ok(range);near(range.low,1);near(range.high,3);
 near(convertUnit('glucose_fasting',180.18,'mg/dL','mmol/L'),10);
 near(convertUnit('renal_creatinine',1,'mg/dL','μmol/L'),88.4);
});
test('free T3 converts bidirectionally and does not borrow total T3 or free T4 factors',()=>{
 near(convertUnit('thyroid_ft3',2,'pg/mL','pmol/L'),3.08);
 near(convertUnit('thyroid_ft3',3.08,'pmol/L','pg/mL'),2);
 near(convertUnit('thyroid_ft3',2,' PG/ML ','pmol/l'),3.08);
 for(const key of ['thyroid_t3_total','thyroid_ft4','thyroid_t4_total']){
  assert.equal(convertUnit(key,2,'pg/mL','pmol/L'),null);
 }
 assert.equal(convertUnit('thyroid_ft3',2,'ng/mL','pmol/L'),null);
 const range=dictionaryReferenceForUnit(JSON.stringify({low:1.54,high:4.62}), 'thyroid_ft3','pmol/L','pg/mL');
 assert.ok(range);near(range.low,1);near(range.high,3);
});
for(const [key,name,massUnit,molarUnit,factor,previousRule] of [
 ['thyroid_t4_total','总甲状腺素','μg/dL','nmol/L',12.87,'p16'],
 ['thyroid_ft3','游离三碘甲状腺原氨酸','pg/mL','pmol/L',1.54,'p17'],
] as const){
test(`${key} historical backfill merges compatible units while preserving raw values, reference bounds and comparator`,()=>{
 const dir=mkdtempSync(join(tmpdir(),'s0003-units-')),previous=process.env.STORAGE_DIR;process.env.STORAGE_DIR=dir;
 try{
  const db=getDatabase();
  db.exec("INSERT INTO users(id,display_name) VALUES('s3-owner','Synthetic'); INSERT INTO health_members(id,display_name,created_by) VALUES('s3-member','Synthetic','s3-owner'); INSERT INTO member_permissions(member_id,user_id,permission,granted_by) VALUES('s3-member','s3-owner','manager','s3-owner')");
  for(const [id,date,text,value,unit,low,high] of [['mass','2026-01-01','2',2,massUnit,1,3],['molar','2026-01-02',String(3*factor),3*factor,molarUnit,factor,3*factor],['bound','2026-01-03','<2',2,massUnit,1,3]] as const){
   db.prepare("INSERT INTO reports(id,member_id,created_by,title,report_type,status,report_issued_at) VALUES(?,'s3-member','s3-owner','Synthetic','laboratory','ready',?)").run(id,date);
   db.prepare("INSERT INTO observations(id,report_id,section_name,item_name,result_text,numeric_value,unit,reference_low,reference_high,reference_text,evidence_json) VALUES(?,?,'甲状腺功能',?,?,?,?,?,?,?,?)").run(id,id,name,text,value,unit,low,high,`${low}-${high}`,JSON.stringify([{pageNumber:1,quote:`${name} | ${text} | ${unit} | ${low}-${high} ${unit}`} ]));
   normalizeReportObservations(id);
  }
  const raw=()=>db.prepare('SELECT id,item_name,result_text,numeric_value,unit,reference_low,reference_high,reference_text FROM observations ORDER BY id').all();const before=raw();
  // Simulate derived rows from the earlier rule; original observations are never rewritten.
  const oldVersion=activeIndicatorNormalizationVersion().replace(/^indicator-normalization-p\d+/,`indicator-normalization-${previousRule}`);
  assert.notEqual(oldVersion,activeIndicatorNormalizationVersion(),'rule version must invalidate previously separated units');
  db.prepare("UPDATE observation_normalizations SET canonical_value=2,canonical_unit=?,version=? WHERE observation_id IN ('mass','bound')").run(massUnit,oldVersion);
  backfillBuiltinIndicatorNormalizations();
  const owner={id:'s3-owner',displayName:'Synthetic',authenticated:true,provider:'development',isGatewayAdmin:false} as const;
  const groups=listTrendSeries(owner,'s3-member').filter(s=>s.indicatorKey===key);
  assert.equal(groups.length,1);const group=groups[0];assert.equal(group.unit,molarUnit);assert.equal(group.points.length,3);
  for(const point of group.points){near(point.referenceLow,factor);near(point.referenceHigh,3*factor);assert.equal(point.referenceStatus,'trusted');}
  near(group.points.find(p=>p.observationId==='mass')!.numericValue,2*factor);
  near(group.points.find(p=>p.observationId==='molar')!.numericValue,3*factor);
  const bound=group.points.find(p=>p.observationId==='bound')!;assert.equal(bound.resultComparator,'<');near(bound.numericValue,2*factor);
  const detail=getReportDetail(owner,'mass').observations.find(o=>o.id==='mass')!;
  assert.equal(detail.unit,massUnit);assert.equal(detail.numericValue,2);near(detail.canonicalValue,2*factor);assert.equal(detail.canonicalUnit,molarUnit);
  assert.deepEqual(raw(),before);
 }finally{closeDatabaseForTests();if(previous===undefined)delete process.env.STORAGE_DIR;else process.env.STORAGE_DIR=previous;rmSync(dir,{recursive:true,force:true});}
});
}
