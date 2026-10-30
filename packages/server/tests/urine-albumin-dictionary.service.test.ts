import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {closeDatabaseForTests, getDatabase} from '../database/client';
import {getIndicatorDictionaryStatus, rollbackRemoteIndicatorDictionary, updateRemoteIndicatorDictionary} from '../services/indicator-dictionary.service';
import {backfillBuiltinIndicatorNormalizations, normalizeReportObservations} from '../services/indicator-normalization.service';
import type {RequestUser} from '../domain/request-user';

const concentrationKey = 'urine_microalbumin';
const ratioKey = 'urine_albumin_creatinine_ratio';
const admin: RequestUser = {id:'dictionary-admin',displayName:'Synthetic',provider:'development',authenticated:true,isGatewayAdmin:true};

function bundle(previous = false) {
  const taxonomy = JSON.parse(readFileSync(new URL('../../../dictionary/remote/taxonomy.json',import.meta.url),'utf8'));
  const indicators = JSON.parse(readFileSync(new URL('../../../dictionary/remote/indicators.json',import.meta.url),'utf8'));
  if (previous) {
    taxonomy.revision--;
    indicators.revision--;
    indicators.indicators = indicators.indicators.filter((row: {canonicalKey:string}) => ![concentrationKey,ratioKey].includes(row.canonicalKey));
  }
  const files = {'taxonomy.json':Buffer.from(JSON.stringify(taxonomy)),'indicators.json':Buffer.from(JSON.stringify(indicators))};
  return {
    files,
    manifest:{formatVersion:1,revision:indicators.revision,generatedAt:new Date().toISOString(),signature:null,
      files:Object.fromEntries(Object.entries(files).map(([path,bytes])=>[path.split('.')[0],{path,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}]))}
  };
}

test('urine albumin dictionary upgrades and rolls back historical matches without merging concentrations, ratios or excretion units',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'urine-albumin-dictionary-'));
  const beforeStorage=process.env.STORAGE_DIR,beforeUrl=process.env.INDICATOR_DICTIONARY_URL,originalFetch=globalThis.fetch;
  process.env.STORAGE_DIR=directory;process.env.INDICATOR_DICTIONARY_URL='https://dictionary.synthetic.invalid/';
  let current=bundle(true);
  globalThis.fetch=async(input)=>{
    const path=new URL(String(input)).pathname.split('/').at(-1)!;
    return path==='manifest.json' ? new Response(JSON.stringify(current.manifest)) : new Response(current.files[path as keyof typeof current.files]);
  };
  try {
    const db=getDatabase();
    db.prepare("INSERT INTO users(id,display_name,is_gateway_admin) VALUES(?,'Synthetic',1)").run(admin.id);
    db.prepare("INSERT INTO health_members(id,display_name,created_by) VALUES('member','Synthetic',?)").run(admin.id);
    db.prepare("INSERT INTO reports(id,member_id,created_by,title,report_type,status,report_issued_at) VALUES('report','member',?,'Synthetic','laboratory','ready','2026-01-01')").run(admin.id);
    const cases = [
      ['concentration','尿液','微量白蛋白(mAlb)测定',12,'mg/L'],
      ['concentration-dl','尿液','尿微量白蛋白',2,'mg/dL'],
      ['concentration-ug','尿液','尿微量白蛋白',3,'μg/mL'],
      ['ratio','尿液','尿微量白蛋白比尿肌酐',14,'mg/g'],
      ['ratio-molar','尿液','尿微量白蛋白与尿肌酐比值',2,'mg/mmol'],
      ['ratio-abbreviation','尿液','UACR',5,'mg/g'],
      ['serum','肝功能','血清白蛋白',40,'g/L'],
      ['total-protein','尿液','尿蛋白（定量）',10,'mg/L'],
      ['excretion','尿液','24小时尿微量白蛋白',15,'mg/24h'],
      ['bad-concentration-unit','尿液','尿微量白蛋白',16,'mg/24h'],
      ['bad-ratio-unit','尿液','尿微量白蛋白比尿肌酐',17,'mg/L'],
      ['protein-ratio','尿液','尿总蛋白/肌酐比值',18,'mg/g']
    ] as const;
    const insert=db.prepare('INSERT INTO observations(id,report_id,section_name,item_name,normalized_name,result_text,numeric_value,unit) VALUES(?,\'report\',?,?,?,?,?,?)');
    for(const [id,section,name,value,unit] of cases) insert.run(id,section,name,name,String(value),value,unit);
    const read=(id:string)=>db.prepare('SELECT canonical_key AS key,canonical_unit AS unit,canonical_value AS value,quality,excluded_reason AS reason FROM observation_normalizations WHERE observation_id=?').get(id)!;
    await updateRemoteIndicatorDictionary(admin);
    normalizeReportObservations('report');
    assert.notEqual(read('concentration').key,concentrationKey);
    assert.notEqual(read('ratio').key,ratioKey);
    const oldSnapshot=getIndicatorDictionaryStatus(admin).snapshots.find((row:any)=>row.layer==='remote'&&row.revision===current.manifest.revision)!;
    current=bundle();
    await updateRemoteIndicatorDictionary(admin);
    backfillBuiltinIndicatorNormalizations();
    for(const [id,unit,value] of [['concentration','mg/L',12],['concentration-dl','mg/dL',2],['concentration-ug','μg/mL',3]] as const) {
      assert.equal(read(id).key,concentrationKey);assert.equal(read(id).unit,unit);assert.equal(read(id).value,value);
    }
    for(const [id,unit,value] of [['ratio','mg/g',14],['ratio-molar','mg/mmol',2],['ratio-abbreviation','mg/g',5]] as const) {
      assert.equal(read(id).key,ratioKey);assert.equal(read(id).unit,unit);assert.equal(read(id).value,value);
    }
    assert.equal(read('serum').key,'liver_albumin');
    assert.equal(read('total-protein').key,'urine_protein_quantitative');
    for(const id of ['excretion','bad-concentration-unit','bad-ratio-unit']) {
      const row=read(id);
      if([concentrationKey,ratioKey].includes(String(row.key))) {
        assert.equal(row.value,null,id);assert.equal(row.unit,null,id);
        assert.equal(row.quality,'low',id);assert.match(String(row.reason),/单位.*不兼容/);
      }
    }
    assert.notEqual(read('protein-ratio').key,ratioKey);
    assert.ok(typeof oldSnapshot.id==='string');
    await rollbackRemoteIndicatorDictionary(admin,oldSnapshot.id);
    backfillBuiltinIndicatorNormalizations();
    assert.notEqual(read('concentration').key,concentrationKey);assert.notEqual(read('ratio').key,ratioKey);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM observations').get()!.n,cases.length);
  } finally {
    globalThis.fetch=originalFetch;closeDatabaseForTests();
    if(beforeStorage===undefined)delete process.env.STORAGE_DIR;else process.env.STORAGE_DIR=beforeStorage;
    if(beforeUrl===undefined)delete process.env.INDICATOR_DICTIONARY_URL;else process.env.INDICATOR_DICTIONARY_URL=beforeUrl;
    rmSync(directory,{recursive:true,force:true});
  }
});
