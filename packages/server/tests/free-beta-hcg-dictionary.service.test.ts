import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {closeDatabaseForTests,getDatabase} from '../database/client';
import {getIndicatorDictionaryStatus,rollbackRemoteIndicatorDictionary,updateRemoteIndicatorDictionary} from '../services/indicator-dictionary.service';
import {backfillBuiltinIndicatorNormalizations,normalizeReportObservations} from '../services/indicator-normalization.service';
import type {RequestUser} from '../domain/request-user';

const key='hormone_free_beta_hcg';
const admin:RequestUser={id:'dictionary-admin',displayName:'Synthetic',provider:'development',authenticated:true,isGatewayAdmin:true};
function bundle(previous=false) {
  const taxonomy=JSON.parse(readFileSync(new URL('../../../dictionary/remote/taxonomy.json',import.meta.url),'utf8'));
  const indicators=JSON.parse(readFileSync(new URL('../../../dictionary/remote/indicators.json',import.meta.url),'utf8'));
  if(previous){taxonomy.revision--;indicators.revision--;indicators.indicators=indicators.indicators.filter((row:{canonicalKey:string})=>row.canonicalKey!==key);}
  const files={'taxonomy.json':Buffer.from(JSON.stringify(taxonomy)),'indicators.json':Buffer.from(JSON.stringify(indicators))};
  return {files,manifest:{formatVersion:1,revision:indicators.revision,generatedAt:new Date().toISOString(),signature:null,
    files:Object.fromEntries(Object.entries(files).map(([path,bytes])=>[path.split('.')[0],{path,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}]))}};
}

test('free beta hCG dictionary backfills complete names, preserves measurement boundaries and rolls back',async()=>{
  const storage=mkdtempSync(join(tmpdir(),'free-beta-hcg-'));
  const oldStorage=process.env.STORAGE_DIR,oldUrl=process.env.INDICATOR_DICTIONARY_URL,oldFetch=globalThis.fetch;
  process.env.STORAGE_DIR=storage;process.env.INDICATOR_DICTIONARY_URL='https://dictionary.synthetic.invalid/';
  let current=bundle(true);
  globalThis.fetch=async input=>{const path=new URL(String(input)).pathname.split('/').at(-1)!;return path==='manifest.json'?new Response(JSON.stringify(current.manifest)):new Response(current.files[path as keyof typeof current.files]);};
  try {
    const db=getDatabase();
    db.prepare("INSERT INTO users(id,display_name,is_gateway_admin) VALUES(?,'Synthetic',1)").run(admin.id);
    db.prepare("INSERT INTO health_members(id,display_name,created_by) VALUES('member','Synthetic',?)").run(admin.id);
    db.prepare("INSERT INTO reports(id,member_id,created_by,title,report_type,status) VALUES('report','member',?,'Synthetic','laboratory','ready')").run(admin.id);
    const positives=[
      ['complete','人绒毛膜促性腺激素游离β亚基','ng/mL'],
      ['wrapped','人绒毛膜促性腺激素游离β\n亚基（T-12）','ng/ml'],
      ['canonical','游离人绒毛膜促性腺激素β亚单位','μg/L'],
      ['english','free beta hCG','ng/mL'],
      ['short','free β-hCG','ng/mL'],
      ['chinese-short','游离β-HCG','ng/mL']
    ];
    const boundaries=[
      ['fragment','亚基(T-12)','ng/mL'],['beta-fragment','β亚基','ng/mL'],
      ['total','人绒毛膜促性腺激素','ng/mL'],['total-beta','β-HCG','ng/mL'],
      ['total-explicit','总人绒毛膜促性腺激素','ng/mL'],['alpha','人绒毛膜促性腺激素α亚基','ng/mL']
    ];
    const insert=db.prepare("INSERT INTO observations(id,report_id,section_name,item_name,normalized_name,result_text,numeric_value,unit) VALUES(?,'report','激素',?,?,'3',3,?)");
    for(const [id,name,unit] of [...positives,...boundaries,['mom','游离人绒毛膜促性腺激素β亚单位MoM','MoM'],['wrong-unit','游离人绒毛膜促性腺激素β亚单位','IU/L']])insert.run(id,name,name,unit);
    const original=JSON.stringify(db.prepare('SELECT * FROM observations ORDER BY id').all());
    const read=(id:string)=>db.prepare('SELECT canonical_key AS key,canonical_unit AS unit,canonical_value AS value,quality FROM observation_normalizations WHERE observation_id=?').get(id)!;
    await updateRemoteIndicatorDictionary(admin);normalizeReportObservations('report');
    for(const [id] of positives)assert.notEqual(read(id).key,key,id);
    const oldSnapshot=getIndicatorDictionaryStatus(admin).snapshots.find((row:any)=>row.layer==='remote'&&row.revision===current.manifest.revision)!;
    current=bundle();await updateRemoteIndicatorDictionary(admin);backfillBuiltinIndicatorNormalizations();
    for(const [id] of positives){assert.equal(read(id).key,key,id);assert.notEqual(read(id).quality,'low',id);assert.equal(read(id).value,3,id);}
    for(const [id] of boundaries)assert.notEqual(read(id).key,key,id);
    for(const id of ['wrong-unit','mom']){assert.equal(read(id).quality,'low',id);assert.equal(read(id).value,null,id);}
    await rollbackRemoteIndicatorDictionary(admin,String(oldSnapshot.id));backfillBuiltinIndicatorNormalizations();
    for(const [id] of positives)assert.notEqual(read(id).key,key,id);
    assert.equal(JSON.stringify(db.prepare('SELECT * FROM observations ORDER BY id').all()),original);
  }finally{
    globalThis.fetch=oldFetch;closeDatabaseForTests();
    if(oldStorage===undefined)delete process.env.STORAGE_DIR;else process.env.STORAGE_DIR=oldStorage;
    if(oldUrl===undefined)delete process.env.INDICATOR_DICTIONARY_URL;else process.env.INDICATOR_DICTIONARY_URL=oldUrl;
    rmSync(storage,{recursive:true,force:true});
  }
});
