import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {syntheticDxaPage,syntheticDxaPageWithAxis,syntheticFullFemurPage} from './fixtures/dxa-table';
import {parseDxaPage} from '../services/bone-density-parser';
import {getDatabase,closeDatabaseForTests} from '../database/client';
import {createUpload} from '../services/upload.service';
import {createMember} from '../services/member.service';
import {executeAiExtractionPlan} from '../services/ai-extraction-orchestrator.service';
import {persistAiExtraction} from '../services/ai-extraction.service';
import {getReportDetail,listTrendSeries,updateTrendPin} from '../services/records.service';
import {normalizeObservation,assessTrendAdmission} from '../services/indicator-normalization.service';
import {createBoneDensityObservations,createManualObservation,updateManualObservation,deleteManualObservation,applyObservationFieldOverrides} from '../services/observation-field-overrides.service';
import {boneSeriesIdentity,parseBoneSeriesKey} from '../../shared/bone-density';
import {ensureBoneDensityDraft} from '../database/bone-density-draft';
import {getReportExaminations,saveReportExamination} from '../services/report-examination.service';
import {getTrendSnapshotOverview,readLegacyTrendSnapshot,queryTrendSnapshotSeries} from '../services/trend-snapshot-query.service';
import {claimTrendSnapshotJob,publishTrendSnapshot,computeTrendSnapshotInWorker} from '../services/trend-snapshot-runner.service';
import {buildTrendGroupTree,syncBuiltinTrendGroups} from '../services/trend-groups.service';
import type {RequestUser} from '../domain/request-user';

test('DXA geometry preserves sites, zero scores and historical dates; uncertain tables stay on normal path',()=>{
 const lines=syntheticDxaPage();const parsed=parseDxaPage(lines,1)!;
 assert.equal(parsed.length,10);assert.equal(parsed.filter(o=>o.itemCode==='dxa_bmd').length,4);
 assert.equal(parsed.find(o=>o.itemCode==='dxa_z_score')?.numericValue,0);
 assert.equal(parsed[0].measurementSite,'lumbar_l1');
 assert.equal(parsed[0].examination?.examinedAt,'2024-05-18');
 assert.equal(parsed[9].examination?.examinedAt,'2023-05-18');
 assert.equal(parseDxaPage([...lines,{...lines[0],text:'检查结论：合成描述'}],1),null,'narrative reports keep their normal AI flow');
 assert.equal(parseDxaPage(lines.filter(l=>l.text!=='T值'),1),null);
 assert.equal(parseDxaPage(lines.map(l=>({...l,text:l.text.replace('iDXA','QUS')})),1),null);
 assert.equal(parseDxaPage(lines.map(l=>({...l,text:l.text.replace('05/18','05/08')})),1),null,'ambiguous date order is not guessed');
 const missing=lines.filter(l=>!(l.text==='-1' && l.box[0][0]===330));
 const withoutScore=parseDxaPage(missing,1)!;assert.equal(withoutScore.length,9);
 const wrong=lines.map(l=>({...l,text:l.text==='腰椎2'?'未明部位':l.text}));assert.equal(parseDxaPage(wrong,1),null);
 assert.equal(parseDxaPage(syntheticDxaPage(true),1)?.[0].measurementLaterality,'left');
 assert.notEqual(boneSeriesIdentity('dxa_bmd','lumbar_l1'),boneSeriesIdentity('dxa_bmd','lumbar_l2'));
 assert.notEqual(boneSeriesIdentity('dxa_bmd','femur_total','left'),boneSeriesIdentity('dxa_bmd','femur_total','right'));
 assert.equal(parseBoneSeriesKey('qus_bone_t_score'),null);
});

test('nullable additions are idempotent and transactional without rewriting legacy observations',()=>{
 const db=new DatabaseSync(':memory:');try{
 db.exec("CREATE TABLE observations(id TEXT PRIMARY KEY,item_name TEXT,numeric_value REAL);INSERT INTO observations VALUES('old','Synthetic',2)");
 db.exec('BEGIN');ensureBoneDensityDraft(db);db.exec('ROLLBACK');
 assert.equal(db.prepare('PRAGMA table_info(observations)').all().length,3);
 ensureBoneDensityDraft(db);ensureBoneDensityDraft(db);
 assert.deepEqual({...db.prepare('SELECT * FROM observations').get()},{id:'old',item_name:'Synthetic',numeric_value:2,measurement_site:null,measurement_laterality:null,examination_modality:null});
 }finally{db.close();}
});

test('DXA normal flow persists 2 pages, isolates trends, protects old data and saves multi-site values atomically',async()=>{
 const root=mkdtempSync(join(tmpdir(),'bone-density-')),env={...process.env};process.env.STORAGE_DIR=root;
 try{
 const db=getDatabase();db.exec("INSERT INTO users(id,display_name) VALUES('owner','Synthetic'),('viewer','Synthetic')");
 const user:RequestUser={id:'owner',displayName:'Synthetic',provider:'development',authenticated:true,isGatewayAdmin:false};
 const member=createMember(user,{displayName:'Synthetic',relationship:'other'});
 const upload=createUpload(user,member.id,[{originalName:'synthetic.jpg',data:Buffer.from([255,216,255,0])},{originalName:'synthetic2.jpg',data:Buffer.from([255,216,255,1])}]);
 const pages=db.prepare('SELECT id,page_number AS pageNumber FROM report_pages WHERE report_id=? ORDER BY page_number').all(upload.reportId) as {id:string;pageNumber:number}[];
 for(const page of pages){
 const job=db.prepare("SELECT id FROM processing_jobs WHERE page_id=? AND job_type='ocr'").get(page.id) as {id:string};
 db.prepare("UPDATE processing_jobs SET status='completed' WHERE id=?").run(job.id);
 db.prepare("INSERT INTO ocr_results(id,job_id,page_id,engine,model_version,lines_json) VALUES(?,?,?,'synthetic','1',?)").run('ocr'+page.pageNumber,job.id,page.id,JSON.stringify(syntheticDxaPage(page.pageNumber===2)));
 }
 db.prepare("INSERT INTO processing_jobs(id,report_id,job_type,pipeline_version,deduplication_key,status) VALUES('dxa-ai',?,'ai_extract','upload-v1','dxa-ai','processing')").run(upload.reportId);
 const execution=await executeAiExtractionPlan('dxa-ai',upload.reportId,async()=>{throw new Error('DXA should not call AI');});
 assert.equal(execution.result.fields.observations.length,17);assert.equal(execution.result.promptTokens,0);
 persistAiExtraction(upload.reportId,'dxa-ai',execution.result,0);
 const detail=getReportDetail(user,upload.reportId);
 assert.equal(detail.observations.length,17);assert.ok(detail.observations.every(o=>o.measurementSite && o.examinationTimeStatus==='automatic'));
 const series=listTrendSeries(user,member.id);assert.equal(series.length,15);assert.ok(series.every(s=>!s.changeAssessmentAllowed));assert.ok(series.every(s=>s.indicatorKey.startsWith('dxa_') && !s.points.some(p=>p.examinationConflict)));
 const tree=buildTrendGroupTree(series.map(s=>({...s,searchAliases:[]})),user.id);assert.equal(tree.find(g=>g.key==='functional')?.children.find(g=>g.key==='bone_density')?.indicatorKeys.length,15);
 const snapshotJob=claimTrendSnapshotJob(db)!;assert.ok(snapshotJob);
 publishTrendSnapshot(snapshotJob,await computeTrendSnapshotInWorker(snapshotJob),db);
 const first=queryTrendSnapshotSeries(user,member.id,{limit:1});
 assert.equal(first.total,5,'three lumbar and two femur cards, not fifteen metric series');
 assert.equal(first.sections.find(section=>section.key==='functional')?.count,5);
 const boneFilter=first.groups.find(group=>group.key==='functional')?.children.find(group=>group.key==='bone_density');
 assert.equal(boneFilter?.indicatorCount,5);
 const seenSeries=new Set<string>(),seenCards=new Set<string>();let page=first,pagesRead=0;
 for(let guard=0;guard<20;guard++){
  const cards=new Set(page.items.map(item=>parseBoneSeriesKey(item.indicatorKey)!.group));
  assert.equal(cards.size,1,'limit one means one visible card');
  for(const card of cards){assert.ok(!seenCards.has(card),'every continuation must add a new card');seenCards.add(card);}
  pagesRead++;page.items.forEach(item=>seenSeries.add(item.indicatorKey));
  if(!page.hasMore)break;
  assert.ok(page.nextCursor);
  page=queryTrendSnapshotSeries(user,member.id,{limit:1,cursor:page.nextCursor!});
 }
 assert.equal(page.hasMore,false);assert.equal(pagesRead,5);assert.equal(seenSeries.size,15,'all metric series remain available');
 assert.equal(queryTrendSnapshotSeries(user,member.id,{query:'BMD'}).total,5);
 let batch=queryTrendSnapshotSeries(user,member.id,{limit:2});const batchCards=new Set<string>();const pageSizes:number[]=[];
 for(let guard=0;guard<10;guard++){
  const cards=new Set(batch.items.map(item=>parseBoneSeriesKey(item.indicatorKey)!.group));pageSizes.push(cards.size);
  for(const card of cards){assert.ok(!batchCards.has(card),'a partial last page must not include earlier cards');batchCards.add(card);}
  if(!batch.hasMore)break;
  batch=queryTrendSnapshotSeries(user,member.id,{limit:2,cursor:batch.nextCursor!});
 }
 assert.deepEqual(pageSizes,[2,2,1]);


 assert.equal(first.items.length,3,'one site brings all available metric metadata across pagination');
 assert.equal(new Set(first.items.map(item=>parseBoneSeriesKey(item.indicatorKey)?.group)).size,1);
 assert.ok(first.items.every(item=>!item.chartLoaded && !item.detailLoaded),'peer histories remain lazy');
 const beforePinSources=db.prepare('SELECT * FROM observations WHERE report_id=? ORDER BY id').all(upload.reportId);
 // Existing single-metric pins now apply to the whole site, including legacy reads.
 const boneKey=first.items[0].indicatorKey,bone=parseBoneSeriesKey(boneKey)!;
 const bmd=boneSeriesIdentity('dxa_bmd',bone.site,bone.side),tScore=boneSeriesIdentity('dxa_t_score',bone.site,bone.side);
 updateTrendPin(user,{memberId:member.id,indicatorKey:bmd,unit:'g/cm2'},true);
 assert.throws(()=>queryTrendSnapshotSeries(user,member.id,{cursor:first.nextCursor!}),'pin changes invalidate old pagination cursors');
 const focused=getTrendSnapshotOverview(user,member.id);
 assert.equal(focused.total,5);assert.equal(focused.pinnedCount,1);
 assert.equal(focused.pinned!.items.length,3);assert.ok(focused.pinned!.items.every(item=>item.pinned));
 assert.equal(focused.sections.find(section=>section.key==='functional')?.count,4,'site does not remain in the ordinary section');
 assert.ok(queryTrendSnapshotSeries(user,member.id,{pin:'exclude'}).items.every(item=>parseBoneSeriesKey(item.indicatorKey)?.group!==bone.group));
 assert.equal(readLegacyTrendSnapshot(user,member.id).series.filter(item=>item.pinned).length,3);
 assert.equal(listTrendSeries(user,member.id).filter(item=>item.pinned).length,3);
 db.prepare("INSERT INTO member_permissions(member_id,user_id,permission,granted_by) VALUES(?,'viewer','viewer','owner')").run(member.id);
 updateTrendPin({...user,id:'viewer'},{memberId:member.id,indicatorKey:tScore},true);
 updateTrendPin(user,{memberId:member.id,indicatorKey:tScore},false);
 assert.equal(queryTrendSnapshotSeries(user,member.id,{pin:'only'}).total,0,'unpin from another tab clears the site pin');
 assert.equal(queryTrendSnapshotSeries({...user,id:'viewer'},member.id,{pin:'only'}).total,1,'another account keeps its own pin');
 updateTrendPin({...user,id:'viewer'},{memberId:member.id,indicatorKey:tScore},false);
 assert.equal(queryTrendSnapshotSeries(user,member.id,{group:'bone_density',limit:2}).items.length,6);
 assert.deepEqual(db.prepare('SELECT * FROM observations WHERE report_id=? ORDER BY id').all(upload.reportId),beforePinSources,'filtering, paging and pinning do not rewrite source measurements');
 const sourceVersion=(db.prepare('SELECT source_version AS v FROM reports WHERE id=?').get(upload.reportId) as {v:number}).v;
 const input={expectedSourceVersion:sourceVersion,examinedAt:'2024-06-18',sites:[{site:'femur_total',side:'right',dxa_bmd:.9,dxa_t_score:-.2},{site:'lumbar_l3',dxa_z_score:0}]};
 assert.throws(()=>createBoneDensityObservations({...user,id:'viewer'},upload.reportId,input));
 assert.throws(()=>createBoneDensityObservations(user,upload.reportId,{...input,sites:[...input.sites,{site:'not-a-site',dxa_bmd:.5}]}));
 assert.equal(getReportDetail(user,upload.reportId).observations.length,17);
 db.exec("CREATE TRIGGER reject_synthetic_bone BEFORE INSERT ON observations WHEN NEW.item_name LIKE '%L3 Z%'  BEGIN SELECT RAISE(ABORT,'Synthetic failure'); END");
 assert.throws(()=>createBoneDensityObservations(user,upload.reportId,input));
 assert.equal(getReportDetail(user,upload.reportId).observations.length,17);
 db.exec('DROP TRIGGER reject_synthetic_bone');
 createBoneDensityObservations(user,upload.reportId,input);
 assert.throws(()=>createBoneDensityObservations(user,upload.reportId,input),'stale version cannot duplicate values');
 const added=getReportDetail(user,upload.reportId).observations.filter(o=>o.manualCreated);assert.equal(added.length,3);
 const current=added.find(o=>o.measurementLaterality==='right')!;
 updateManualObservation(user,upload.reportId,current.id,{itemName:current.itemName,resultText:current.resultText,numericValue:current.numericValue,unit:current.unit,canonicalKey:current.canonicalKey});
 const edited=getReportDetail(user,upload.reportId).observations.find(o=>o.id===current.id)!;assert.equal(edited.measurementSite,'femur_total');assert.equal(edited.method,'DXA','old client edit retains metadata');
 assert.ok(applyObservationFieldOverrides(upload.reportId,[]).every(row=>row.observation.method==='DXA'));
 deleteManualObservation(user,upload.reportId,current.id);
 assert.equal(getReportDetail(user,upload.reportId).observations.length,19);
 const legacy={id:'old',reportId:upload.reportId,itemName:'DXA T 值',numericValue:-1,resultText:'-1',unit:null,sectionName:null,itemCode:null,normalizedName:null,method:'DXA',referenceText:null,reportType:'functional',hospitalName:null,performingDepartment:null,reportingDepartment:null};
 const result=normalizeObservation(legacy);assert.equal(result.quality,'low');
 const explicitQus=normalizeObservation({...legacy,itemName:'T值',normalizedName:'超声骨密度 T 值',sectionName:'超声骨密度检测报告',method:'QUS'});assert.equal(explicitQus.canonicalKey,'qus_bone_t_score');assert.notEqual(explicitQus.quality,'low');
 const wrongMethod=normalizeObservation({...legacy,itemName:'T值',normalizedName:'超声骨密度 T 值',sectionName:'超声骨密度检测报告'});
 assert.equal(wrongMethod.quality,'low');assert.ok(wrongMethod.excludedReason?.includes('DXA'));
 assert.equal(assessTrendAdmission({...legacy,itemName:'超声骨密度 T 值',canonicalKey:wrongMethod.canonicalKey,normalizationQuality:wrongMethod.quality,normalizationExcludedReason:wrongMethod.excludedReason,evidenceJson:'[]'}).eligible,false);
 const ordinary=normalizeObservation({...legacy,itemName:'肌酸激酶',method:null,unit:'U/L',numericValue:12,resultText:'12'});assert.equal(ordinary.canonicalKey,'laboratory_ck');assert.notEqual(ordinary.quality,'low');
 // Mix an ordinary indicator into the same member, with its existing unit-based pin.
 const ordinaryId=createManualObservation(user,upload.reportId,{itemName:'肌酸激酶',numericValue:12,resultText:'12',unit:'U/L',canonicalKey:'laboratory_ck'});
 const ordinaryState=getReportExaminations(user,upload.reportId);
 saveReportExamination(user,upload.reportId,{version:ordinaryState.version,reportVersion:ordinaryState.reportVersion,requestKey:'synthetic-ordinary-date',observationIds:[ordinaryId],examination:{examinedAt:'2024-07-18'}});
 const mixedJob=claimTrendSnapshotJob(db)!;publishTrendSnapshot(mixedJob,await computeTrendSnapshotInWorker(mixedJob),db);
 const mixed=queryTrendSnapshotSeries(user,member.id,{limit:48});assert.equal(mixed.total,8);
 const ordinaryItem=mixed.items.find(item=>item.indicatorKey==='laboratory_ck')!;assert.ok(ordinaryItem);
 updateTrendPin(user,{memberId:member.id,indicatorKey:ordinaryItem.indicatorKey,unit:ordinaryItem.unit},true);
 assert.equal(queryTrendSnapshotSeries(user,member.id,{pin:'only'}).total,1);
 updateTrendPin(user,{memberId:member.id,indicatorKey:ordinaryItem.indicatorKey,unit:'other'},false);
 assert.equal(queryTrendSnapshotSeries(user,member.id,{pin:'only'}).total,1,'ordinary units stay independent');
 updateTrendPin(user,{memberId:member.id,indicatorKey:ordinaryItem.indicatorKey,unit:ordinaryItem.unit},false);
 assert.equal(queryTrendSnapshotSeries(user,member.id,{query:'肌酸激酶'}).total,1);
 const before=db.prepare('SELECT source_version FROM reports WHERE id=?').get(upload.reportId);
 closeDatabaseForTests();getDatabase();assert.deepEqual(getDatabase().prepare('SELECT source_version FROM reports WHERE id=?').get(upload.reportId),before);
 }finally{closeDatabaseForTests();process.env=env;rmSync(root,{recursive:true,force:true});}
});

test('existing databases back up before additive repair; a late failure leaves old structure intact',()=>{
 const root=mkdtempSync(join(tmpdir(),'bone-upgrade-')),env={...process.env};process.env.STORAGE_DIR=root;
 const originalExec=DatabaseSync.prototype.exec;
 try{
  let db=getDatabase();db.exec("INSERT INTO users(id,display_name) VALUES('legacy','Synthetic')");
  const path=join(root,'db','health-records.sqlite');closeDatabaseForTests();
  const old=new DatabaseSync(path);old.exec('ALTER TABLE observations DROP COLUMN measurement_site;ALTER TABLE observations DROP COLUMN measurement_laterality;ALTER TABLE observations DROP COLUMN examination_modality');old.close();
  DatabaseSync.prototype.exec=function(sql:string){if(sql==='ALTER TABLE observations ADD COLUMN examination_modality TEXT')throw new Error('Synthetic bone repair failure');return originalExec.call(this,sql);};
  assert.throws(()=>getDatabase(),/Synthetic bone repair failure/);
  DatabaseSync.prototype.exec=originalExec;
  const before=new DatabaseSync(path);assert.ok(!before.prepare('PRAGMA table_info(observations)').all().some(row=>row.name==='measurement_site'));before.close();
  const backups=readdirSync(join(root,'backups','db'));assert.ok(backups.length,'repair created a backup before altering columns');
  for(const name of backups){const backup=new DatabaseSync(join(root,'backups','db',name),{readOnly:true});try{assert.ok(!backup.prepare('PRAGMA table_info(observations)').all().some(row=>row.name==='measurement_site'));}finally{backup.close();}}
  db=getDatabase();assert.ok(db.prepare('PRAGMA table_info(observations)').all().some(row=>row.name==='measurement_site'));
  assert.ok(db.prepare('PRAGMA table_info(observations)').all().some(row=>row.name==='examination_modality'));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM users WHERE id='legacy'").get()!.n,1);
 }finally{DatabaseSync.prototype.exec=originalExec;closeDatabaseForTests();process.env=env;rmSync(root,{recursive:true,force:true});}
});


test('left hip axis length is independent of BMD/T/Z and excludes means, chart markers and uncertain sources',()=>{
 const lines=syntheticDxaPageWithAxis();const result=parseDxaPage(lines,1)!;
 const axis=result.find(item=>item.itemName==='左侧髋关节中轴长度')!;
 assert.equal(result.length,8);assert.equal(axis.numericValue,112.4);assert.equal(axis.unit,'mm');
 assert.equal(axis.measurementSite,null);assert.equal(axis.referenceLow,null);assert.equal(axis.referenceHigh,null);assert.equal(axis.referenceText,null);
 assert.equal(axis.examination?.examinedAt,'2024-05-18');
 assert.equal(result.some(item=>item.numericValue===109 || item.numericValue===3.4),false);
 const original=parseDxaPage(syntheticDxaPage(true),1)!;
 assert.deepEqual(result.filter(item=>item.itemName!==axis.itemName),original,'existing bone metrics and dates stay identical');
 const replace=(text:string)=>lines.map(line=>line.text.startsWith('左=')?{...line,text}:line);
 assert.equal(parseDxaPage(replace('均值=109.0mm'),1),null);
 assert.equal(parseDxaPage(replace('右=112.4mm 均值=109.0mm'),1)?.find(item=>item.itemName==='右侧髋关节中轴长度')?.numericValue,112.4);
 assert.equal(parseDxaPage(replace('左=0mm 均值=109.0mm'),1),null);
 assert.equal(parseDxaPage(lines.map(line=>line.text.startsWith('左=')?{...line,confidence:.4}:line),1),null);
 const duplicate={...lines[lines.length-1],id:'ambiguous-axis',text:'左=113.5mm'};
 assert.equal(parseDxaPage([...lines,duplicate],1),null);
 assert.equal(parseDxaPage(lines.filter(line=>!line.text.startsWith('髋关节中轴长度')),1)?.length,7,'a bare side number cannot borrow another heading');
});

for(const axisSide of ['left','right','both'] as const) test(`HAL ${axisSide} persists through normal extraction with independent trends and source dates`,async()=>{
 const root=mkdtempSync(join(tmpdir(),'hal-extraction-')),env={...process.env};process.env.STORAGE_DIR=root;
 try{
  const db=getDatabase();db.exec("INSERT INTO users(id,display_name) VALUES('owner','Synthetic')");
  const user:RequestUser={id:'owner',displayName:'Synthetic',provider:'development',authenticated:true,isGatewayAdmin:false};
  const member=createMember(user,{displayName:'Synthetic',relationship:'other'});
  const upload=createUpload(user,member.id,[{originalName:'synthetic-axis.jpg',data:Buffer.from([255,216,255,0])}]);
  const page=db.prepare('SELECT id FROM report_pages WHERE report_id=?').get(upload.reportId) as {id:string};
  const job=db.prepare("SELECT id FROM processing_jobs WHERE page_id=? AND job_type='ocr'").get(page.id) as {id:string};
  db.prepare("UPDATE processing_jobs SET status='completed' WHERE id=?").run(job.id);
  db.prepare("INSERT INTO ocr_results(id,job_id,page_id,engine,model_version,lines_json) VALUES('hal-ocr',?,?,'synthetic','1',?)").run(job.id,page.id,JSON.stringify(syntheticDxaPageWithAxis(axisSide).map(line=>axisSide==='both'?{...line,text:line.text.replace('118.6','112.4')}:line)));
  db.prepare("INSERT INTO processing_jobs(id,report_id,job_type,pipeline_version,deduplication_key,status) VALUES('hal-ai',?,'ai_extract','upload-v1','hal-ai','processing')").run(upload.reportId);
  const execution=await executeAiExtractionPlan('hal-ai',upload.reportId,async()=>{throw new Error('verified source should not call AI');});
  persistAiExtraction(upload.reportId,'hal-ai',execution.result,0);
  const expectedSides=axisSide==='both'?['left','right']:[axisSide];
  const detail=getReportDetail(user,upload.reportId);
  for(const expectedSide of expectedSides) {
  const axis=detail.observations.find(item=>item.canonicalKey===`hip_axis_length_${expectedSide}`)!;
  assert.equal(detail.observations.length,7+expectedSides.length);assert.ok(axis);assert.equal(axis.numericValue,expectedSide==='left' || axisSide==='both'?112.4:118.6);assert.equal(axis.canonicalUnit,'mm');assert.equal(axis.displayTier,'primary');assert.equal(axis.examinationTime,'2024-05-18');
  assert.equal(axis.referenceText,null);assert.equal(axis.referenceLow,null);assert.equal(axis.referenceHigh,null);
  const trends=listTrendSeries(user,member.id);assert.equal(trends.length,6+expectedSides.length);
  const axisTrend=trends.find(item=>item.indicatorKey===`hip_axis_length_${expectedSide}`)!;
  assert.ok(axisTrend);assert.equal(axisTrend.points.length,1);assert.equal(axisTrend.unit,'mm');assert.equal(parseBoneSeriesKey(axisTrend.indicatorKey),null);
  }
  const normalizedBase={id:'synthetic',reportId:upload.reportId,sectionName:'骨结构测量',itemCode:null,itemName:'髋关节中轴长度',normalizedName:null,resultText:'112.4',numericValue:112.4,unit:'mm',referenceText:null,reportType:'functional',hospitalName:null,performingDepartment:null,reportingDepartment:null};
  assert.equal(normalizeObservation(normalizedBase).canonicalKey,null,'unspecified side never matches the left indicator');
  assert.equal(normalizeObservation({...normalizedBase,normalizedName:'左侧髋关节中轴长度'}).canonicalKey,null,'AI suggestion cannot invent a missing side');
  assert.equal(normalizeObservation({...normalizedBase,itemName:'右侧髋关节中轴长度',normalizedName:'左侧髋关节中轴长度'}).canonicalKey,'hip_axis_length_right','actual right-side name wins over an incorrect left suggestion');
  assert.equal(normalizeObservation({...normalizedBase,itemName:'Left Hip Axis Length'}).canonicalKey,'hip_axis_length_left');
  assert.equal(normalizeObservation({...normalizedBase,itemName:'Right Hip Axis Length'}).canonicalKey,'hip_axis_length_right');
  assert.equal(normalizeObservation({...normalizedBase,normalizedName:'右侧髋关节中轴长度'}).canonicalKey,null);
  assert.equal(normalizeObservation({...normalizedBase,itemName:'左侧髋关节中轴长度',normalizedName:'右侧髋关节中轴长度'}).canonicalKey,'hip_axis_length_left');
  assert.equal(normalizeObservation({...normalizedBase,itemName:'左右侧髋关节中轴长度',normalizedName:'右侧髋关节中轴长度'}).canonicalKey,null);
  assert.notEqual(normalizeObservation({...normalizedBase,itemName:'右侧髋关节中轴长度'}).canonicalKey,'hip_axis_length_left');
  const snapshotJob=claimTrendSnapshotJob(db)!;publishTrendSnapshot(snapshotJob,await computeTrendSnapshotInWorker(snapshotJob),db);
  const overview=queryTrendSnapshotSeries(user,member.id);assert.equal(overview.total,2+expectedSides.length,'two bone sites plus independent left/right HAL cards');assert.equal(overview.pointCount,7+expectedSides.length);
  if(axisSide==='both'){
   updateTrendPin(user,{memberId:member.id,indicatorKey:'hip_axis_length_left',unit:'mm'},true);
   assert.deepEqual(queryTrendSnapshotSeries(user,member.id,{pin:'only'}).items.map(item=>item.indicatorKey),['hip_axis_length_left']);
   updateTrendPin(user,{memberId:member.id,indicatorKey:'hip_axis_length_right',unit:'mm'},false);
   assert.equal(queryTrendSnapshotSeries(user,member.id,{pin:'only'}).total,1,'unpinning the right does not change a left pin');
   updateTrendPin(user,{memberId:member.id,indicatorKey:'hip_axis_length_right',unit:'mm'},true);
   assert.equal(queryTrendSnapshotSeries(user,member.id,{pin:'only'}).total,2);
   updateTrendPin(user,{memberId:member.id,indicatorKey:'hip_axis_length_left',unit:'mm'},false);
   assert.deepEqual(queryTrendSnapshotSeries(user,member.id,{pin:'only'}).items.map(item=>item.indicatorKey),['hip_axis_length_right']);
  }

 }finally{closeDatabaseForTests();process.env=env;rmSync(root,{recursive:true,force:true});}
});


test('explicit HAL sides remain separate, including identical values; missing or contradictory sides are not guessed',()=>{
 const right=parseDxaPage(syntheticDxaPageWithAxis('right'),1)!;
 assert.equal(right.find(item=>item.itemName==='右侧髋关节中轴长度')?.measurementLaterality,'right');
 assert.ok(!right.some(item=>item.itemName==='左侧髋关节中轴长度'));
 const both=syntheticDxaPageWithAxis('both');
 const parsed=parseDxaPage(both,1)!;assert.equal(parsed.filter(item=>item.sectionName==='骨结构测量').length,2);
 const independentSide=syntheticDxaPageWithAxis().map(line=>line.text.startsWith('髋关节中轴')?{...line,text:'右侧髋关节中轴长度比较（mm）'}:line.text.startsWith('左=')?{...line,text:'右=118.6mm'}:line);
 const independent=parseDxaPage(independentSide,1)!;
 assert.ok(independent);assert.equal(independent.find(item=>item.itemName==='右侧髋关节中轴长度')?.measurementLaterality,'right');
 assert.ok(independent.filter(item=>item.itemCode).every(item=>item.measurementLaterality==='left'),'HAL heading must not change the BMD table side');
 const bilateralHeader=both.map(line=>line.text.startsWith('髋关节中轴')?{...line,text:'双侧髋关节中轴长度比较（mm）'}:line);
 assert.equal(parseDxaPage(bilateralHeader,1)?.filter(item=>item.sectionName==='骨结构测量').length,2);
 const same=both.map(line=>({...line,text:line.text.replace('118.6','112.4')}));
 assert.equal(parseDxaPage(same,1)?.filter(item=>item.sectionName==='骨结构测量' && item.numericValue===112.4).length,2);
 const separate=syntheticDxaPageWithAxis();const row=separate[separate.length-1];
 separate.push({...row,id:'right-axis',text:'右侧=118.6mm',box:row.box.map(([x,y])=>[x,y+25])});
 assert.equal(parseDxaPage(separate,1)?.filter(item=>item.sectionName==='骨结构测量').length,2);
 for(const text of ['112.4mm 均值=109mm','左右=112.4mm','双侧=112.4mm','左/右=112.4mm','参考左=112.4mm','平均值右=118.6mm']) {
  assert.equal(parseDxaPage(both.map(line=>line.text.startsWith('左=')?{...line,text}:line),1),null);
 }
 const referenceRow={...both[both.length-1],id:'reference-only',text:'参考右=109.0mm'};
 assert.equal(parseDxaPage([...both,referenceRow],1)?.filter(item=>item.sectionName==='骨结构测量').length,2);
 const contradictory=syntheticDxaPageWithAxis('right').map(line=>line.text.startsWith('髋关节中轴')?{...line,text:'右侧髋关节中轴长度比较（mm）'}:line.text.startsWith('右=')?{...line,text:'左=112.4mm'}:line);
 assert.equal(parseDxaPage(contradictory,1),null);
});

for(const offset of [0,.1])test(`all femoral BMD/T/Z regions keep left/right identities through extraction, snapshots and pins (offset ${offset})`,async()=>{
 const root=mkdtempSync(join(tmpdir(),'femur-sides-')),env={...process.env};process.env.STORAGE_DIR=root;
 try{
  const db=getDatabase();db.exec("INSERT INTO users(id,display_name) VALUES('owner','Synthetic')");
  const user:RequestUser={id:'owner',displayName:'Synthetic',provider:'development',authenticated:true,isGatewayAdmin:false};
  const member=createMember(user,{displayName:'Synthetic',relationship:'other'});
  const upload=createUpload(user,member.id,['left','right'].map(side=>({originalName:`synthetic-${side}.jpg`,data:Buffer.from([255,216,255,0])})));
  const pages=db.prepare('SELECT id,page_number AS pageNumber FROM report_pages WHERE report_id=? ORDER BY page_number').all(upload.reportId) as {id:string;pageNumber:number}[];
  for(const page of pages){
   const side=page.pageNumber===1?'left':'right';
   const job=db.prepare("SELECT id FROM processing_jobs WHERE page_id=? AND job_type='ocr'").get(page.id) as {id:string};
   db.prepare("UPDATE processing_jobs SET status='completed' WHERE id=?").run(job.id);
   db.prepare("INSERT INTO ocr_results(id,job_id,page_id,engine,model_version,lines_json) VALUES(?,?,?,'synthetic','1',?)").run('femur-'+side,job.id,page.id,JSON.stringify(syntheticFullFemurPage(side,side==='right'?offset:0)));
  }
  db.prepare("INSERT INTO processing_jobs(id,report_id,job_type,pipeline_version,deduplication_key,status) VALUES('femur-ai',?,'ai_extract','upload-v1','femur-ai','processing')").run(upload.reportId);
  const execution=await executeAiExtractionPlan('femur-ai',upload.reportId,async()=>{throw new Error('verified tables must not call AI');});
  assert.equal(execution.result.fields.observations.length,44,'identical bilateral values must not be deduplicated');
  persistAiExtraction(upload.reportId,'femur-ai',execution.result,0);
  const detail=getReportDetail(user,upload.reportId),series=listTrendSeries(user,member.id);
  assert.equal(detail.observations.length,44);assert.equal(series.length,42);
  const sites=['femur_neck','femur_neck_upper','femur_neck_lower','femur_wards','femur_trochanter','femur_shaft','femur_total'];
 for(const observation of parseDxaPage(syntheticFullFemurPage('left'),1)!){
  const normalized=normalizeObservation({...observation,id:'synthetic-side',reportId:'synthetic',reportType:'functional',hospitalName:null,performingDepartment:null,reportingDepartment:null,measurementLaterality:'unspecified'});
  assert.equal(normalized.quality,'low');assert.ok(normalized.excludedReason?.includes('左右侧'));
 }
  for(const side of ['left','right'])for(const [index,site] of sites.entries())for(const metric of ['dxa_bmd','dxa_t_score','dxa_z_score']){
   const extra=side==='right'?offset:0;
   const value=Number((metric==='dxa_bmd'?.6+index*.02+extra:metric==='dxa_t_score'?-1-index*.2-extra:index*.1+extra).toFixed(2));
   const current=detail.observations.filter(o=>o.canonicalKey===metric && o.measurementSite===site && o.measurementLaterality===side && o.examinationTime==='2024-05-18');
   assert.equal(current.length,1);assert.equal(current[0].numericValue,value);assert.equal(current[0].displayTier,'primary');
   const trend=series.find(s=>s.indicatorKey===boneSeriesIdentity(metric,site,side))!;assert.ok(trend);
   assert.equal(trend.points.length,site==='femur_total' && metric==='dxa_bmd'?2:1);
   assert.ok(trend.points.every(p=>p.sourcePage?.pageNumber===(side==='left'?1:2)),'each curve retains its own side source page');
   assert.equal(trend.points.find(p=>p.numericValue===value)?.numericValue,value);
   if(site==='femur_total' && metric==='dxa_bmd')assert.equal(trend.points.find(p=>p.numericValue!==value)?.numericValue,Number((.5+extra).toFixed(2)));
  }
  syncBuiltinTrendGroups(db);
  const job=claimTrendSnapshotJob(db)!;publishTrendSnapshot(job,await computeTrendSnapshotInWorker(job),db);
  const before=db.prepare('SELECT * FROM observations ORDER BY id').all();

  const pageKeys=new Set<string>();let batch=queryTrendSnapshotSeries(user,member.id,{group:'bone_density',limit:3});
  assert.equal(batch.total,14);assert.equal(batch.pointCount,44);
  for(let guard=0;guard<10;guard++){
   const groups=new Set(batch.items.map(item=>parseBoneSeriesKey(item.indicatorKey)!.group));
   assert.equal(batch.items.length,groups.size*3,'each card contains all three metric summaries');
   for(const group of groups){assert.ok(!pageKeys.has(group));pageKeys.add(group);}
   if(!batch.hasMore)break;
   batch=queryTrendSnapshotSeries(user,member.id,{group:'bone_density',limit:3,cursor:batch.nextCursor!});
  }
  assert.equal(pageKeys.size,14);
  for(const site of sites){
   const left=boneSeriesIdentity('dxa_bmd',site,'left'),right=boneSeriesIdentity('dxa_z_score',site,'right');
   updateTrendPin(user,{memberId:member.id,indicatorKey:left,unit:'g/cm2'},true);
   let pinned=queryTrendSnapshotSeries(user,member.id,{pin:'only'});assert.equal(pinned.total,1);assert.equal(pinned.items.length,3);
   assert.ok(pinned.items.every(item=>parseBoneSeriesKey(item.indicatorKey)?.side==='left' && parseBoneSeriesKey(item.indicatorKey)?.site===site));
   updateTrendPin(user,{memberId:member.id,indicatorKey:right},false);
   assert.equal(queryTrendSnapshotSeries(user,member.id,{pin:'only'}).total,1,'unpinning right cannot clear left');
   updateTrendPin(user,{memberId:member.id,indicatorKey:right},true);
   assert.equal(queryTrendSnapshotSeries(user,member.id,{pin:'only'}).total,2);
   updateTrendPin(user,{memberId:member.id,indicatorKey:boneSeriesIdentity('dxa_t_score',site,'left')},false);
   pinned=queryTrendSnapshotSeries(user,member.id,{pin:'only'});assert.equal(pinned.total,1);assert.ok(pinned.items.every(item=>parseBoneSeriesKey(item.indicatorKey)?.side==='right'));
   updateTrendPin(user,{memberId:member.id,indicatorKey:right},false);
  }
  assert.deepEqual(db.prepare('SELECT * FROM observations ORDER BY id').all(),before);
 }finally{closeDatabaseForTests();process.env=env;rmSync(root,{recursive:true,force:true});}
});

test('femoral side must be explicit; mixed bilateral tables stay on the normal extraction path',()=>{
 const left=syntheticFullFemurPage('left'),right=syntheticFullFemurPage('right');
 for(const title of ['股骨：全部','双侧股骨：全部','左侧股骨 / 右侧股骨：全部']){
  assert.equal(parseDxaPage(left.map(line=>line.text==='左侧股骨：全部'?{...line,text:title}:line),1),null);
 }
 assert.equal(parseDxaPage([...left,...right.map(line=>({...line,box:line.box.map(([x,y])=>[x+900,y])}))],1),null,'a multi-table page cannot borrow a global side');

});
