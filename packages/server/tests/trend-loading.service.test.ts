import {runTrendSnapshotTasksOnce} from '../services/trend-snapshot-runner.service';
import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {H3} from 'h3';
import {gunzipSync} from 'node:zlib';
import {getDatabase,closeDatabaseForTests} from '../database/client';
import {normalizeReportObservations} from '../services/indicator-normalization.service';
import {listTrendSeries} from '../services/records.service';
import {buildTrendGroupTree,filterTrendGroups} from '../services/trend-groups.service';
import {reportDuplicateCollapseResolver,shouldCollapseReportPair,reportDuplicatePairKey,reportFileSignature} from '../services/report-duplicate-governance.service';
import handler from '../routes/api/trends.get';
import type {RequestUser} from '../domain/request-user';

test('trend loading reuses source signatures, preserves folding and returns groups with the same histories',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'trend-loading-'));const previous=process.env.STORAGE_DIR;process.env.STORAGE_DIR=dir;
 try{
  const db=getDatabase();
  db.exec(`INSERT INTO users(id,display_name) VALUES('u','Synthetic'),('other','Synthetic');
   INSERT INTO health_members(id,display_name,created_by) VALUES('m','Synthetic','u');
   INSERT INTO member_permissions(member_id,user_id,permission,granted_by) VALUES('m','u','manager','u');`);
  const report=db.prepare("INSERT INTO reports(id,member_id,created_by,report_type,title,status,report_issued_at) VALUES(?,'m','u','laboratory','Synthetic','ready','2026-01-01')");
  const page=db.prepare("INSERT INTO report_pages(id,report_id,page_number,original_name,storage_path,mime_type,file_size,sha256) VALUES(?,?,1,'synthetic.png','synthetic','image/png',128,?)");
  const observation=db.prepare("INSERT INTO observations(id,report_id,section_name,item_name,normalized_name,result_text,numeric_value,unit,reference_text) VALUES(?,?,'血常规','白细胞计数','白细胞计数','5',5,'10^9/L','3.5-9.5')");
  const count=60;
  for(let i=0;i<count;i++){report.run('r'+i);page.run('p'+i,'r'+i,'hash'+i);observation.run('o'+i,'r'+i);normalizeReportObservations('r'+i);}
  const owner:RequestUser={id:'u',displayName:'Synthetic',provider:'development',authenticated:true,isGatewayAdmin:false};
  let signatureReads=0;const prepare=db.prepare.bind(db);
  db.prepare=((sql:string)=>{if(sql.includes('FROM report_pages WHERE report_id=?'))signatureReads++;return prepare(sql);}) as typeof db.prepare;
  let series;
  try{series=listTrendSeries(owner,'m');}finally{db.prepare=prepare;}
  assert.equal(series.reduce((sum,item)=>sum+item.pointCount,0),count);
  assert.equal(signatureReads,count,'each report signature is read once instead of once per report pair');
  const points=()=>listTrendSeries(owner,'m').flatMap(item=>item.points);
  db.exec("UPDATE report_pages SET sha256='hash0' WHERE id='p1'");
  assert.equal(points().length,count-1,'identical complete originals still fold');
  const decision=db.prepare("INSERT INTO report_duplicate_decisions(pair_key,member_id,left_report_id,right_report_id,decision,evidence_json) VALUES(?,'m','r0','r1',?,?)");
  decision.run(reportDuplicatePairKey('r0','r1'),'distinct','{}');
  assert.equal(points().length,count,'an explicit distinct decision overrides identical originals');
  db.exec("UPDATE report_pages SET sha256='hash1' WHERE id='p1'");
  const evidence=JSON.stringify({sourceSignatures:{r0:reportFileSignature('r0'),r1:reportFileSignature('r1')}});
  db.prepare("UPDATE report_duplicate_decisions SET decision='duplicate',evidence_json=?").run(evidence);
  assert.equal(points().length,count-1,'bound manual confirmation still folds');
  const resolver=reportDuplicateCollapseResolver();
  for(const a of ['r0','r1','r2'])for(const b of ['r0','r1','r2'])if(a!==b)assert.equal(resolver(a,b),shouldCollapseReportPair(a,b));
  db.exec("UPDATE report_pages SET sha256='changed' WHERE id='p1'");
  assert.equal(points().length,count,'new requests do not reuse stale source signatures or decisions');
  await runTrendSnapshotTasksOnce();
  let user=owner;const app=new H3();app.use(event=>{event.context.requestUser=user;});app.get('/api/trends',handler);
  const read=async(query:string)=>(await (await app.request('http://localhost/api/trends?memberId=m'+query)).json()).data;
  const plain=await read('');assert.deepEqual(plain,listTrendSeries(owner,'m'));const combined=await read('&includeGroups=true');
  assert.deepEqual(combined.series,plain);assert.deepEqual(combined.groups,buildTrendGroupTree(plain,owner.id));
  const compressed=await app.request('http://localhost/api/trends?memberId=m&includeGroups=true',{headers:{'accept-encoding':'br, gzip'}});
  assert.equal(compressed.headers.get('content-encoding'),'gzip');
  assert.equal(compressed.headers.get('vary'),'Accept-Encoding');
  assert.equal(compressed.headers.get('cache-control'),'private, no-store');
  const bytes=Buffer.from(await compressed.arrayBuffer());
  assert.deepEqual(JSON.parse(gunzipSync(bytes).toString()).data,combined,'transport compression preserves every series and source field');
  assert.ok(bytes.length<Buffer.byteLength(JSON.stringify({ok:true,data:combined}))/2);
  for(const accept of ['identity','gzip;q=0','gzip;q=0, *;q=1']){
    const response=await app.request('http://localhost/api/trends?memberId=m&includeGroups=true',{headers:{'accept-encoding':accept}});
    assert.equal(response.headers.get('content-encoding'),null);
    assert.deepEqual((await response.json()).data,combined);
  }

  const filtered=await read('&includeGroups=true&groupKeys[]=laboratory');
  assert.deepEqual(filtered.series,filterTrendGroups(plain,combined.groups,['laboratory']));
  user={...owner,id:'other'};assert.equal((await app.request('http://localhost/api/trends?memberId=m&includeGroups=true')).status,403);
 }finally{closeDatabaseForTests();if(previous===undefined)delete process.env.STORAGE_DIR;else process.env.STORAGE_DIR=previous;rmSync(dir,{recursive:true,force:true});}
});
