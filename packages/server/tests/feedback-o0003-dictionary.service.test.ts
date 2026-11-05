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

const addedKeys=[
  'trace_whole_blood_fe','trace_whole_blood_zn','trace_whole_blood_cu','inflammation_mpo_mass',
  'lipid_lp_pla2_mass','lipid_lp_pla2_activity','metabolic_adiponectin',
  'infectious_h_pylori_14c_urea_breath_test_dpm','infectious_h_pylori_14c_urea_breath_test_cpm',
  ...['cd3','cd4','cd8','cd19','nk'].flatMap(code=>['percentage','count'].map(kind=>`immunology_${code}_${kind}`)),
  'immunology_cd4_cd8_ratio','immunology_igm','immunology_iga','immunology_igg','immunology_c3','immunology_c4','urine_prostatic_exosomal_protein'
];
const admin:RequestUser={id:'dictionary-admin',displayName:'Synthetic',provider:'development',authenticated:true,isGatewayAdmin:true};
function bundle(previous=false) {
  const taxonomy=JSON.parse(readFileSync(new URL('../../../dictionary/remote/taxonomy.json',import.meta.url),'utf8'));
  const indicators=JSON.parse(readFileSync(new URL('../../../dictionary/remote/indicators.json',import.meta.url),'utf8'));
  if(previous){taxonomy.revision--;indicators.revision--;indicators.indicators=indicators.indicators.filter((row:{canonicalKey:string})=>!addedKeys.includes(row.canonicalKey));}
  const files={'taxonomy.json':Buffer.from(JSON.stringify(taxonomy)),'indicators.json':Buffer.from(JSON.stringify(indicators))};
  return {files,manifest:{formatVersion:1,revision:indicators.revision,generatedAt:new Date().toISOString(),signature:null,
    files:Object.fromEntries(Object.entries(files).map(([path,bytes])=>[path.split('.')[0],{path,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}]))}};
}

test('O0002/O0003 standard definitions backfill history, separate measurement meanings and roll back without changing source observations',async()=>{
  const storage=mkdtempSync(join(tmpdir(),'o0003-dictionary-'));
  const oldStorage=process.env.STORAGE_DIR,oldUrl=process.env.INDICATOR_DICTIONARY_URL,oldFetch=globalThis.fetch;
  process.env.STORAGE_DIR=storage;process.env.INDICATOR_DICTIONARY_URL='https://dictionary.synthetic.invalid/';
  let current=bundle(true);
  globalThis.fetch=async input=>{const path=new URL(String(input)).pathname.split('/').at(-1)!;return path==='manifest.json'?new Response(JSON.stringify(current.manifest)):new Response(current.files[path as keyof typeof current.files]);};
  try {
    const db=getDatabase();
    db.prepare("INSERT INTO users(id,display_name,is_gateway_admin) VALUES(?,'Synthetic',1)").run(admin.id);
    db.prepare("INSERT INTO health_members(id,display_name,created_by) VALUES('member','Synthetic',?)").run(admin.id);
    db.prepare("INSERT INTO reports(id,member_id,created_by,title,report_type,status) VALUES('report','member',?,'Synthetic','laboratory','ready')").run(admin.id);
    // Synthetic values; only indicator names come from the application list.
    const positives:Array<[string,string,string,string,string]>= [
      ['fe','微量元素','全血铁测定(Fe)','mmol/L','trace_whole_blood_fe'],
      ['zn','微量元素','全血锌测定(Zn)','μmol/L','trace_whole_blood_zn'],
      ['cu','微量元素','全血铜测定(Cu)','μmol/L','trace_whole_blood_cu'],
      ['mpo','生化','髓过氧化物酶','ng/mL','inflammation_mpo_mass'],
      ['mpo-code','生化','髓过氧化物酶(MPO)','μg/L','inflammation_mpo_mass'],
      ['pla2-mass','生化','脂蛋白相关磷脂酶A2','ng/mL','lipid_lp_pla2_mass'],
      ['pla2-activity','生化','脂蛋白磷脂酶A2','U/L','lipid_lp_pla2_activity'],
      ['adpn','生化','脂联素检测(ADPN)','μg/mL','metabolic_adiponectin'],
      ['14c-dpm','碳14呼气试验','碳14呼气试验检测数值','DPM','infectious_h_pylori_14c_urea_breath_test_dpm'],
      ['14c-cpm','碳14呼气试验','碳14呼气试验检测数值','CPM','infectious_h_pylori_14c_urea_breath_test_cpm'],
      ['cd4-p','淋巴细胞亚群','CD4+T细胞%','%','immunology_cd4_percentage'],
      ['cd8-p','淋巴细胞亚群','CD8+T细胞%','%','immunology_cd8_percentage'],
      ...[['cd3','T淋巴细胞CD3'],['cd4','CD4+T细胞'],['cd8','CD8+T细胞'],['cd19','B淋巴细胞CD19'],['nk','自然杀伤细胞CD16+56']].flatMap(([code,name])=>[
        [`${code}-generic-p`,'淋巴细胞亚群',name!,'%',`immunology_${code}_percentage`],
        [`${code}-generic-count`,'淋巴细胞亚群',name!,'个/μL',`immunology_${code}_count`]
      ] as Array<[string,string,string,string,string]>),
      ['cd4-cd8','淋巴细胞亚群','CD4/CD8','','immunology_cd4_cd8_ratio'],
      ['igm','体液免疫','IgM免疫球蛋白','g/L','immunology_igm'],
      ['iga','体液免疫','IgA免疫球蛋白','g/L','immunology_iga'],
      ['igg','体液免疫','IgG免疫球蛋白','g/L','immunology_igg'],
      ['c3','体液免疫','补体C3','g/L','immunology_c3'],
      ['c4','体液免疫','补体C4','g/L','immunology_c4'],
      ['urine-psep','尿液','尿前列腺小体外泄蛋白','ng/mL','urine_prostatic_exosomal_protein']
    ];
    const boundaries:Array<[string,string,string,string]>=[
      ['ratio-reversed','淋巴细胞亚群','CD8/CD4',''],
      ['subunit-incomplete','其他','亚基(T-12)','ng/mL'],
      ['ratio-percent','淋巴细胞亚群','CD4/CD8','%'],
      ['pla2-no-unit','生化','脂蛋白相关磷脂酶A2',''],
      ['14c-no-unit','碳14呼气试验','碳14呼气试验检测数值',''],
      ['cd4-no-unit','淋巴细胞亚群','CD4+T细胞',''],
      ['cd4-wrong-unit','淋巴细胞亚群','CD4+T细胞%','个/μL'],
      ['epithelial-unspecified','其他','上皮细胞(Shangpi)','/μL'],
      ['psep-unspecified','其他','前列腺小体外泄蛋白','ng/mL'],
      ['lymph-unspecified','其他','淋巴细胞',''],
      ['mpo-antibody','免疫','抗髓过氧化物酶抗体','U/mL'],
      ['mpo-activity','生化','髓过氧化物酶','U/L'],
      ['adpn-hmw','生化','高分子量脂联素','μg/mL'],
      ['iga-pathogen','感染免疫','肺炎衣原体IgA抗体','g/L'],
      ['fe-serum','生化','血清铁','μmol/L'],
      ['13c','13C呼气试验','13C尿素呼气试验DOB值','‰']
    ];
    const insert=db.prepare("INSERT INTO observations(id,report_id,section_name,item_name,normalized_name,result_text,numeric_value,unit) VALUES(?,'report',?,?,?,'2',2,?)");
    for(const [id,section,name,unit] of [...positives,...boundaries])insert.run(id,section,name,name,unit.trim());
    const original=JSON.stringify(db.prepare('SELECT * FROM observations ORDER BY id').all());
    const read=(id:string)=>db.prepare('SELECT canonical_key AS key,canonical_unit AS unit,canonical_value AS value,quality,excluded_reason AS reason FROM observation_normalizations WHERE observation_id=?').get(id)!;
    await updateRemoteIndicatorDictionary(admin);normalizeReportObservations('report');
    for(const [id,,,,key] of positives) assert.notEqual(read(id).key,key,id);
    const oldSnapshot=getIndicatorDictionaryStatus(admin).snapshots.find((row:any)=>row.layer==='remote'&&row.revision===current.manifest.revision)!;
    current=bundle();await updateRemoteIndicatorDictionary(admin);backfillBuiltinIndicatorNormalizations();
    for(const [id,,,unit,key] of positives){assert.equal(read(id).key,key,id);assert.notEqual(read(id).quality,'low',id);assert.equal(read(id).value,2,id);assert.equal(read(id).unit,unit.trim() || null,id);}
    for(const id of ['pla2-no-unit','14c-no-unit','cd4-no-unit','cd4-wrong-unit','mpo-activity','ratio-percent'])assert.equal(read(id).quality,'low',id);
    for(const id of ['ratio-reversed','subunit-incomplete','epithelial-unspecified','psep-unspecified','lymph-unspecified','mpo-antibody','adpn-hmw','iga-pathogen','fe-serum','13c'])assert.ok(!addedKeys.includes(String(read(id).key)),id);
    await rollbackRemoteIndicatorDictionary(admin,String(oldSnapshot.id));backfillBuiltinIndicatorNormalizations();
    for(const [id,,,,key] of positives)assert.notEqual(read(id).key,key,id);
    assert.equal(JSON.stringify(db.prepare('SELECT * FROM observations ORDER BY id').all()),original);
  } finally {
    globalThis.fetch=oldFetch;closeDatabaseForTests();
    if(oldStorage===undefined)delete process.env.STORAGE_DIR;else process.env.STORAGE_DIR=oldStorage;
    if(oldUrl===undefined)delete process.env.INDICATOR_DICTIONARY_URL;else process.env.INDICATOR_DICTIONARY_URL=oldUrl;
    rmSync(storage,{recursive:true,force:true});
  }
});
