import {normalizeObservation} from '../services/indicator-normalization.service';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {getDatabase,closeDatabaseForTests} from '../database/client';
import {installRemoteDictionarySnapshotForTests} from '../services/indicator-dictionary.service';
import {createMember} from '../services/member.service';
import {createUpload} from '../services/upload.service';
import {executeAiExtractionPlan} from '../services/ai-extraction-orchestrator.service';
import {persistAiExtraction,normalizeAiExtraction} from '../services/ai-extraction.service';
import {getReportDetail,listTrendSeries,updateTrendPin,updateReportFields} from '../services/records.service';
import {createManualObservation,updateManualObservation,applyObservationFieldOverrides} from '../services/observation-field-overrides.service';
import {getReportExaminations,saveReportExamination} from '../services/report-examination.service';
import {parseCardiacUltrasoundPage} from '../services/cardiac-ultrasound-parser';
import {syntheticCardiacUltrasound} from './fixtures/cardiac-ultrasound';
import {cardiacSeriesIdentity,parseCardiacSeriesKey} from '../../shared/cardiac-measurements';
import {claimTrendSnapshotJob,publishTrendSnapshot,computeTrendSnapshotInWorker} from '../services/trend-snapshot-runner.service';
import {queryTrendSnapshotSeries} from '../services/trend-snapshot-query.service';
import {syncBuiltinTrendGroups} from '../services/trend-groups.service';
import type {RequestUser} from '../domain/request-user';
const user:RequestUser={id:'owner',displayName:'Synthetic',provider:'development',authenticated:true,isGatewayAdmin:false};
async function fixture(run:(db:ReturnType<typeof getDatabase>,memberId:string,reportId:string)=>Promise<void>){
 const env={...process.env},root=mkdtempSync(join(tmpdir(),'cardiac-context-'));process.env.STORAGE_DIR=root;
 try{const db=getDatabase();db.prepare("INSERT INTO users(id,display_name) VALUES('owner','Synthetic')").run();installRemoteDictionarySnapshotForTests();const member=createMember(user,{displayName:'Synthetic',relationship:'other'});const upload=createUpload(user,member.id,[{originalName:'synthetic.jpg',data:Buffer.from([255,216,255,0])}]);await run(db,member.id,upload.reportId);}finally{closeDatabaseForTests();process.env=env;rmSync(root,{recursive:true,force:true});}
}
test('cardiac grid preserves all populated cells, ambiguous RV labels, valve waves and TDI sources',()=>{
 const lines=syntheticCardiacUltrasound(),facts=parseCardiacUltrasoundPage(lines,1);assert.equal(facts.length,20);
 assert.equal(facts.filter(o=>o.method==='组织多普勒').length,3);assert.ok(facts.every(o=>o.examinationModality==='超声心动图' && o.referenceLow===null && o.referenceHigh===null));
 assert.equal(facts.filter(o=>o.measurementSite==='right_ventricle').length,2);assert.equal(facts.find(o=>o.itemName.includes('常规'))?.itemCode,null);
 assert.ok(!facts.some(o=>o.itemCode==='cardiac_tricuspid_a_velocity'));assert.ok(!facts.some(o=>/压差|PHT/.test(o.itemName)));
 assert.equal(parseCardiacUltrasoundPage(lines.map(l=>({...l,text:l.text.replace('心脏彩色超声','胸部CT')})),1).length,0);
 const cm=lines.map(l=>({...l,text:l.text.replace('（m/s）','（cm/s）')}));assert.ok(!parseCardiacUltrasoundPage(cm,1).some(o=>o.unit==='m/s'));
 const low=lines.map(l=>l.text==='0.71'?{...l,confidence:.5}:l);assert.ok(!parseCardiacUltrasoundPage(low,1).some(o=>o.itemCode==='cardiac_mitral_e_velocity'));
 const ambiguous=[...lines, {...lines.find(l=>l.text==='0.71')!,id:'other-value',text:'0.72'}];
 assert.ok(!parseCardiacUltrasoundPage(ambiguous,1).some(o=>o.itemCode==='cardiac_mitral_e_velocity'),'multiple values on the same wave must be rejected');
});
test('normal extraction augments cardiac numeric grid without losing AI narrative or inventing examination dates',()=>fixture(async(db,memberId,reportId)=>{
 const page=db.prepare('SELECT id FROM report_pages WHERE report_id=?').get(reportId)!;const job=db.prepare("SELECT id FROM processing_jobs WHERE page_id=? AND job_type='ocr'").get(page.id)!;
 db.prepare("UPDATE processing_jobs SET status='completed' WHERE id=?").run(job.id);
 db.prepare("INSERT INTO ocr_results(id,job_id,page_id,engine,model_version,lines_json) VALUES('cardiac-ocr',?,?,'synthetic','1',?)").run(job.id,page.id,JSON.stringify(syntheticCardiacUltrasound()));
 db.prepare("INSERT INTO processing_jobs(id,report_id,job_type,pipeline_version,deduplication_key,status) VALUES('cardiac-ai',?,'ai_extract','upload-v1','cardiac-ai','processing')").run(reportId);
 let calls=0;const execution=await executeAiExtractionPlan('cardiac-ai',reportId,async()=>{calls++;return {...normalizeAiExtraction({reportType:'imaging',title:'Synthetic ultrasound',findings:'合成描述，仅供软件验证。',observations:[{itemName:'LVEF',normalizedName:'左室射血分数',numericValue:67,resultText:'67',unit:'%',p:1,q:'LVEF 67%'},{itemName:'二尖瓣环室间隔组织速度S',numericValue:11,resultText:'11',unit:'cm/s',p:1,q:'组织多普勒二尖瓣环室间隔组织速度 S′11cm/s'}]}),provider:'synthetic',model:'synthetic',rawResponseJson:'{}',promptTokens:1,completionTokens:1,elapsedMs:0,promptVersion:'synthetic'};});
 assert.equal(execution.result.fields.reportType,'ultrasound','an explicit ultrasound document overrides the older imaging output');assert.ok(calls>0,'narrative still uses existing AI flow');assert.equal(execution.result.fields.observations.length,20);assert.ok(execution.result.fields.findings);
 persistAiExtraction(reportId,'cardiac-ai',execution.result,0);const detail=getReportDetail(user,reportId);assert.equal(detail.observations.length,20);
 for(const fact of parseCardiacUltrasoundPage(syntheticCardiacUltrasound(),1)){
  const saved=detail.observations.find(o=>fact.itemCode?o.itemCode===fact.itemCode:o.itemName.normalize('NFKC')===fact.itemName.normalize('NFKC'))!;assert.ok(saved,fact.itemName);assert.equal(saved.numericValue,fact.numericValue);assert.equal(saved.method,fact.method);assert.equal(saved.examinationModality,fact.examinationModality);assert.equal(saved.measurementSite,fact.measurementSite);
  if(fact.itemCode)assert.equal(saved.canonicalKey,fact.itemCode,'explicit generic measurements must not be matched to a more specific axis');
  assert.ok(saved.examinationTimeStatus==='pending','no date is invented');
 }
 assert.equal(listTrendSeries(user,memberId).filter(s=>s.points.length).length,0);
}));
test('cardiac site, modality and method isolate curves, groups, pins and edits while legacy/laboratory identities stay intact',()=>fixture(async(db,memberId,reportId)=>{
 const contexts=[['left_ventricle','超声心动图','二维Simpson双平面法'],['left_ventricle','超声心动图','M型'],['left_ventricle','CT','容积法'],['','超声心动图','二维Simpson双平面法'],['left_ventricle','超声心动图',''],['','','']] as const;
 const ids=contexts.map(([measurementSite,examinationModality,method])=>createManualObservation(user,reportId,{itemName:'左室射血分数',resultText:'67',numericValue:67,unit:'%',canonicalKey:'cardiac_lvef',measurementSite,examinationModality,method}));
 const state=getReportExaminations(user,reportId);saveReportExamination(user,reportId,{version:state.version,reportVersion:state.reportVersion,requestKey:'synthetic-cardio-dates',observationIds:ids,examination:{examinedAt:'2026-01-12'}});
 const series=listTrendSeries(user,memberId);assert.equal(series.length,6);assert.ok(series.every(s=>s.points.length===1));
 for(const [index,ctx] of contexts.entries()){
  const key=cardiacSeriesIdentity('cardiac_lvef',...ctx);const curve=series.find(s=>s.indicatorKey===key)!;assert.ok(curve);assert.equal(curve.points[0].observationId,ids[index]);
  if(!ctx[2]){assert.equal(curve.comparable,false);assert.equal(curve.changeAssessmentAllowed,false);}
 }
 assert.equal(cardiacSeriesIdentity('laboratory_ck','left_ventricle','CT','M型'),'laboratory_ck');assert.equal(cardiacSeriesIdentity('cardiac_lvef'), 'cardiac_lvef');assert.equal(cardiacSeriesIdentity('cardiac_lvef',null,null,'M型'),'cardiac_lvef','legacy method text alone must not change old pin keys');assert.equal(cardiacSeriesIdentity('cardiac_nt_probnp','left_ventricle','CT','M型'),'cardiac_nt_probnp');
 syncBuiltinTrendGroups(db);const job=claimTrendSnapshotJob(db)!;publishTrendSnapshot(job,await computeTrendSnapshotInWorker(job),db);
 assert.equal(queryTrendSnapshotSeries(user,memberId,{group:'cardiac_ultrasound',limit:48}).total,2);
 const filtered=queryTrendSnapshotSeries(user,memberId,{query:'M型',limit:1});assert.equal(filtered.total,1);assert.equal(filtered.items.length,1,'search keeps only matching contexts');
 const page=queryTrendSnapshotSeries(user,memberId,{limit:1});assert.equal(page.total,2);assert.equal(page.items.length,4);assert.equal(page.pointCount,6);
 const next=queryTrendSnapshotSeries(user,memberId,{limit:1,cursor:page.nextCursor!});assert.equal(next.items.length,2);assert.equal(next.hasMore,false);
 assert.ok(next.items.every(item=>!page.items.some(peer=>peer.indicatorKey===item.indicatorKey)));
 const first=series.find(s=>s.indicatorKey===cardiacSeriesIdentity('cardiac_lvef',...contexts[0]))!;
 updateTrendPin(user,{memberId,indicatorKey:first.indicatorKey,unit:first.unit},true);assert.equal(queryTrendSnapshotSeries(user,memberId,{pin:'only'}).total,1);
 assert.equal(queryTrendSnapshotSeries(user,memberId,{pin:'only'}).items.length,4,'all method options travel with the pinned card');
 assert.equal(queryTrendSnapshotSeries(user,memberId,{pin:'exclude'}).items.length,2,'unknown site stays separate');
 updateTrendPin(user,{memberId,indicatorKey:cardiacSeriesIdentity('cardiac_lvef',...contexts[1]),unit:first.unit},false);
 assert.equal(queryTrendSnapshotSeries(user,memberId,{pin:'only'}).total,0,'unpinning another method clears the shared card');
 const escaped=cardiacSeriesIdentity('cardiac_lvef','left_ventricle','超声心动图','原文 @ 方法 %');assert.equal(parseCardiacSeriesKey(escaped)?.method,'原文@方法%');
 const beforeClassification=getReportDetail(user,reportId),datesBefore=getReportExaminations(user,reportId).examinations;
 const curveIdentity=()=>listTrendSeries(user,memberId).map(s=>({key:s.indicatorKey,unit:s.unit,points:s.points.map(p=>[p.observationId,p.numericValue,p.reportIssuedAt])}));
 const curvesBefore=curveIdentity();
 updateReportFields(user,reportId,{reportType:'ultrasound',expectedSourceVersion:beforeClassification.sourceVersion});
 assert.deepEqual(getReportDetail(user,reportId).observations,beforeClassification.observations,'classification does not rewrite extracted values or their metadata');
 assert.deepEqual(getReportExaminations(user,reportId).examinations,datesBefore,'classification retains the simulated examination date');
 assert.deepEqual(curveIdentity(),curvesBefore,'classification does not change trend identities, values or dates');
 const current=getReportDetail(user,reportId).observations.find(o=>o.id===ids[0])!;
 updateManualObservation(user,reportId,current.id,{itemName:current.itemName,resultText:current.resultText,numericValue:current.numericValue,unit:current.unit,canonicalKey:current.canonicalKey});
 const edited=getReportDetail(user,reportId).observations.find(o=>o.id===current.id)!;assert.equal(edited.method,contexts[0][2]);assert.equal(edited.examinationModality,contexts[0][1]);assert.equal(edited.measurementSite,contexts[0][0]);
 const overrides=applyObservationFieldOverrides(reportId,[]);assert.ok(overrides.some(o=>o.observation.examinationModality==='CT'));
}));

test('unresolved conventional RV keeps a raw independent curve and never compares even with method/specimen filled',()=>fixture(async(db,memberId,reportId)=>{
 const ids:string[]=[];
 for(const [i,value] of [21,23,22].entries()){
  const id=createManualObservation(user,reportId,{itemName:'右室常规内径（口径未明确）',numericValue:value,resultText:String(value),unit:'mm',method:'合成方法',examinationModality:'超声心动图',measurementSite:'right_ventricle',referenceLow:10,referenceHigh:40});ids.push(id);
  const state=getReportExaminations(user,reportId);saveReportExamination(user,reportId,{version:state.version,reportVersion:state.reportVersion,requestKey:`synthetic-raw-rv-${i}`,observationIds:[id],examination:{examinedAt:`2026-01-${12+i}`,method:'合成方法',specimen:'合成标本'}});
 }
 const other=createManualObservation(user,reportId,{itemName:'右室内径（径线未注明）',canonicalKey:'cardiac_rv_diameter_unspecified',numericValue:34,resultText:'34',unit:'mm',examinationModality:'超声心动图',measurementSite:'right_ventricle'});
 const state=getReportExaminations(user,reportId);saveReportExamination(user,reportId,{version:state.version,reportVersion:state.reportVersion,requestKey:'synthetic-other-rv-date',observationIds:[other],examination:{examinedAt:'2026-01-14'}});
 const before=getReportDetail(user,reportId).observations;
 const series=listTrendSeries(user,memberId);assert.equal(series.length,2);
 const raw=series.find(s=>s.kind==='institution')!;assert.equal(raw.name,'右室常规');assert.equal(raw.points.length,3);assert.deepEqual(new Set(raw.points.map(p=>p.observationId)),new Set(ids));
 assert.equal(raw.measurementContextPending,true);assert.match(raw.comparabilityReason!,/口径待核对/);assert.equal(raw.comparable,false);assert.equal(raw.changeAssessmentAllowed,false);assert.equal(raw.latestChangeConclusionAllowed,false);assert.equal(raw.trendConclusionAllowed,false);assert.equal(raw.delta,null);
 assert.notEqual(raw.indicatorKey,series.find(s=>s.kind==='standard')!.indicatorKey);assert.equal(series.find(s=>s.kind==='standard')!.points[0].observationId,other);
 assert.ok(getReportDetail(user,reportId).observations.filter(o=>ids.includes(o.id)).every(o=>o.canonicalKey===null),'a provisional raw series must not invent a standard identity');
 syncBuiltinTrendGroups(db);const job=claimTrendSnapshotJob(db)!;publishTrendSnapshot(job,await computeTrendSnapshotInWorker(job),db);
 const snapshot=queryTrendSnapshotSeries(user,memberId,{limit:48});const summary=snapshot.items.find(s=>s.indicatorKey===raw.indicatorKey)!;assert.equal(summary.measurementContextPending,true);assert.equal(summary.name,'右室常规');
 updateTrendPin(user,{memberId,indicatorKey:raw.indicatorKey,unit:'mm'},true);assert.equal(queryTrendSnapshotSeries(user,memberId,{pin:'only'}).total,1);
 updateTrendPin(user,{memberId,indicatorKey:series.find(s=>s.kind==='standard')!.indicatorKey,unit:'mm'},false);assert.equal(queryTrendSnapshotSeries(user,memberId,{pin:'only'}).items[0].indicatorKey,raw.indicatorKey);
 assert.deepEqual(getReportDetail(user,reportId).observations,before,'display and pinning do not modify source data');
}));

test('declared bone method contexts persist separately through snapshots, paging and whole-card pins',()=>fixture(async(db,memberId,reportId)=>{
 const incompatible=normalizeObservation({id:'synthetic-incompatible',reportId,itemName:'DXA 骨密度',itemCode:'dxa_bmd',normalizedName:'DXA 骨密度',sectionName:'骨密度',method:'DXA',examinationModality:'CT',measurementSite:'femur_total',measurementLaterality:'left',numericValue:.8,resultText:'0.8',unit:'g/cm2',referenceText:null,reportType:'functional',hospitalName:null,performingDepartment:null,reportingDepartment:null});assert.equal(incompatible.quality,'low','an explicit CT method cannot use the DXA identity even if legacy method says DXA');
 const ids:string[]=[];
 for(const method of ['合成方法A','合成方法B'])for(const metric of ['dxa_bmd','dxa_t_score','dxa_z_score'])ids.push(createManualObservation(user,reportId,{itemName:metric==='dxa_bmd'?'DXA 骨密度':metric==='dxa_t_score'?'DXA T 值':'DXA Z 值',canonicalKey:metric,numericValue:metric==='dxa_bmd'?.8:-1,resultText:metric==='dxa_bmd'?'0.8':'-1',unit:metric==='dxa_bmd'?'g/cm2':null,method,examinationModality:'DXA',measurementSite:'femur_total',measurementLaterality:'left'}));
 const state=getReportExaminations(user,reportId);saveReportExamination(user,reportId,{version:state.version,reportVersion:state.reportVersion,requestKey:'synthetic-bone-methods',observationIds:ids,examination:{examinedAt:'2026-01-12'}});
 const before=getReportDetail(user,reportId).observations;
 const series=listTrendSeries(user,memberId);assert.equal(series.length,6);assert.ok(series.every(s=>s.points.length===1));
 syncBuiltinTrendGroups(db);const job=claimTrendSnapshotJob(db)!;publishTrendSnapshot(job,await computeTrendSnapshotInWorker(job),db);
 const first=queryTrendSnapshotSeries(user,memberId,{group:'bone_density',limit:1});assert.equal(first.total,2);assert.equal(first.items.length,3);assert.ok(first.hasMore);
 const second=queryTrendSnapshotSeries(user,memberId,{group:'bone_density',limit:1,cursor:first.nextCursor!});assert.equal(second.items.length,3);assert.equal(second.hasMore,false);assert.ok(second.items.every(s=>!first.items.some(a=>a.indicatorKey===s.indicatorKey)));
 updateTrendPin(user,{memberId,indicatorKey:first.items[0].indicatorKey,unit:first.items[0].unit},true);assert.equal(queryTrendSnapshotSeries(user,memberId,{pin:'only'}).items.length,3);
 updateTrendPin(user,{memberId,indicatorKey:second.items[0].indicatorKey,unit:second.items[0].unit},false);assert.equal(queryTrendSnapshotSeries(user,memberId,{pin:'only'}).total,1);
 const edited=before.find(o=>o.canonicalKey==='dxa_bmd')!;
 updateManualObservation(user,reportId,edited.id,{itemName:edited.itemName,numericValue:edited.numericValue,resultText:edited.resultText,unit:edited.unit,canonicalKey:edited.canonicalKey});
 const after=getReportDetail(user,reportId).observations.find(o=>o.id===edited.id)!;assert.equal(after.method,edited.method);assert.equal(after.examinationModality,'DXA');
}));
