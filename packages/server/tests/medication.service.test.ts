import {mutateStandaloneTrash} from '../services/health-record-trash.service';
import {syntheticFormula} from './fixtures/decoction-formula';
import {createClinicalFact,updateClinicalFact} from '../services/clinical-fact.service';
import {getReportDetail,updateReportPages,deleteReportPage} from '../services/records.service';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { closeDatabaseForTests, getDatabase } from '../database/client';
import { ensureMedicationDraftSchema, medicationDraftNeedsRepair } from '../database/medication-draft';
import type { RequestUser } from '../domain/request-user';
import { healthRecordEntries } from '../services/health-record-feed.service';
import { changeMedicationCourse, createMedicationCourse, createMedicationIntake, getMedicationCourse, getMedicationIntake,
  listHistoricalMedications, listMedicationDocuments, listMedications, updateMedicationIntake } from '../services/medication.service';
import { mergeReportWorkflow, validateHealthWorkflowDatabase, exportMemberHealthWorkflow } from '../services/health-workflow-integrity.service';
import { assignReportMember } from '../services/report-member-identity.service';

const manager:RequestUser={id:'med-manager',displayName:'合成管理',provider:'development',authenticated:true,isGatewayAdmin:true};
const viewer:RequestUser={id:'med-viewer',displayName:'合成查看',provider:'development',authenticated:true,isGatewayAdmin:false};
const outsider:RequestUser={id:'med-outsider',displayName:'合成其他',provider:'development',authenticated:true,isGatewayAdmin:false};
function status(fn:()=>unknown,expected:number){assert.throws(fn,(error:unknown)=>(error as {statusCode:number}).statusCode===expected);}
function fixture(run:(db:DatabaseSync)=>void){
  const directory=mkdtempSync(join(tmpdir(),'medication-synthetic-'));const previous=process.env.STORAGE_DIR;process.env.STORAGE_DIR=directory;
  try {
    const db=getDatabase();ensureMedicationDraftSchema(db);
    for(const user of [manager,viewer,outsider])db.prepare('INSERT INTO users(id,display_name) VALUES(?,?)').run(user.id,user.displayName);
    for(const id of ['member-a','member-b'])db.prepare("INSERT INTO health_members(id,display_name,relationship,created_by) VALUES(?,?,'other',?)").run(id,id,manager.id);
    for(const [member,user,permission] of [['member-a',manager.id,'manager'],['member-a',viewer.id,'viewer'],['member-b',outsider.id,'manager']])
      db.prepare('INSERT INTO member_permissions(member_id,user_id,permission,granted_by) VALUES(?,?,?,?)').run(member,user,permission,user);
    for(const [id,member] of [['report-a','member-a'],['report-b','member-b']])db.prepare("INSERT INTO reports(id,member_id,created_by,title,report_type,status,report_issued_at) VALUES(?,?,?,'合成处方','prescription','ready','2025-01-01')").run(id,member,manager.id);
    db.prepare(`INSERT INTO report_medications(id,report_id,medication_name,specification,dosage_form,dose,dose_unit,frequency,route,instructions)
      VALUES('source-a','report-a','合成药品','合成规格','片剂','1','片','每日一次','口服','合成用法')`).run();
    db.prepare("INSERT INTO report_medications(id,report_id,medication_name) VALUES('source-b','report-b','其他合成药品')").run();
    for(const [id,member] of [['episode-a','member-a'],['episode-a2','member-a'],['episode-b','member-b']])
      db.prepare("INSERT INTO health_episodes(id,member_id,episode_type,title) VALUES(?,?,'other','合成过程')").run(id,member);
    for(const [id,member] of [['event-a','member-a'],['event-a2','member-a'],['event-b','member-b']])
      db.prepare("INSERT INTO health_events(id,member_id,event_type,title) VALUES(?,?,'outpatient','合成事件')").run(id,member);
    run(db);
  }finally{closeDatabaseForTests();if(previous===undefined)delete process.env.STORAGE_DIR;else process.env.STORAGE_DIR=previous;rmSync(directory,{recursive:true,force:true});}
}

test('a decoction is confirmed and taken as one medication with its original formula snapshot',()=>fixture(db=>{
  const created=createClinicalFact(manager,'report-a','medication',{medicationName:'合成汤剂',context:'prescription',formula:syntheticFormula});
  const source=listHistoricalMedications(manager,'member-a').find(item=>item.medicationId===created.id)!;
  assert.deepEqual(source.formula,syntheticFormula);
  const document=listMedicationDocuments(manager,{memberId:'member-a'}).find(item=>item.id==='report-a');
  assert.equal(document?.formulaCount,1);assert.equal(document?.medicationCount,2);
  assert.equal(getReportDetail(manager,'report-a').medications.find(item=>item.id===created.id)?.formula?.ingredients.length,6);
  assert.equal(listMedications(manager,{memberId:'member-a'}).courses.length,0);
  const course=createMedicationCourse(manager,{memberId:'member-a',sourceMedicationId:created.id,confirmed:true,startedAt:'2025-01-02'});
  assert.equal(listMedications(manager,{memberId:'member-a'}).courses.length,1);
  assert.deepEqual(course.source?.formula,syntheticFormula);
  assert.equal(course.dose,null,'ingredient grams never become an ingestion dose');
  const intake=createMedicationIntake(manager,{memberId:'member-a',courseId:course.id,takenAt:'2025-01-03',amount:'1',amountUnit:'袋'});
  assert.deepEqual(intake.source?.formula,syntheticFormula);
  const changed=structuredClone(syntheticFormula);changed.ingredients[0].amount='99';
  updateClinicalFact(manager,'medication',created.id,{formula:changed});
  assert.equal(listHistoricalMedications(manager,'member-a').find(item=>item.medicationId===created.id)?.formula?.ingredients[0].amount,'99');
  assert.deepEqual(getMedicationCourse(manager,course.id).source?.formula,syntheticFormula);
  assert.deepEqual(getMedicationIntake(manager,intake.id).source?.formula,syntheticFormula);
  status(()=>updateClinicalFact(viewer,'medication',created.id,{formula:changed}),403);
  status(()=>updateClinicalFact(manager,'medication',created.id,{formula:{kind:'decoction',ingredients:[{name:''}]}}),400);
  const matched=healthRecordEntries(manager,{memberId:'member-a',category:'medication',query:'药材丙'});
  assert.equal(matched.length,1);assert.equal(matched[0].kind,'medication_document');
  assert.match(matched[0].description||'',/合成汤剂/);assert.equal(matched[0].description?.includes('药材丙'),false);
  assert.equal(healthRecordEntries(manager,{memberId:'member-a',category:'medication',query:'没有这味'}).length,0);
}));

test('formula constituent evidence follows page reorder and removal without rewriting confirmed snapshots',()=>fixture(db=>{
  for (const number of [1,2]) db.prepare(`INSERT INTO report_pages(id,report_id,page_number,original_name,mime_type,storage_path,file_size,sha256)
    VALUES(?,'report-a',?,?,'image/png',?,1,?)`).run(`page-${number}`,number,`${number}.png`,`${number}.png`,`hash-${number}`);
  db.prepare('UPDATE report_medications SET formula_json=?,evidence_json=? WHERE id=?')
    .run(JSON.stringify(syntheticFormula),JSON.stringify(syntheticFormula.ingredients.flatMap(item=>item.evidence)),'source-a');
  const course=createMedicationCourse(manager,{memberId:'member-a',sourceMedicationId:'source-a',confirmed:true,startedAt:'2025-01-02'});
  updateReportPages(manager,'report-a',{pages:[{id:'page-2'},{id:'page-1'}]});
  let saved=JSON.parse(String(db.prepare('SELECT formula_json FROM report_medications WHERE id=?').get('source-a')?.formula_json));
  assert.equal(saved.ingredients[0].evidence[0].pageNumber,2);
  assert.equal(saved.ingredients[3].evidence[0].pageNumber,1);
  deleteReportPage(manager,'report-a','page-1');
  saved=JSON.parse(String(db.prepare('SELECT formula_json FROM report_medications WHERE id=?').get('source-a')?.formula_json));
  assert.deepEqual(saved.ingredients[0].evidence,[]);
  assert.equal(saved.ingredients[3].evidence[0].pageNumber,1);
  assert.deepEqual(getMedicationCourse(manager,course.id).source?.formula,syntheticFormula);
}));

test('formula columns are backed up before additive completion and reopen without data loss',()=>fixture(db=>{
  db.exec('ALTER TABLE report_medications DROP COLUMN formula_json');
  assert.equal(medicationDraftNeedsRepair(db),true);
  const root=process.env.STORAGE_DIR!;closeDatabaseForTests();
  const reopened=getDatabase();
  assert.equal(reopened.prepare('SELECT medication_name FROM report_medications WHERE id=?').get('source-a')?.medication_name,'合成药品');
  assert.equal(reopened.prepare('SELECT formula_json FROM report_medications WHERE id=?').get('source-a')?.formula_json,null);
  assert.equal(reopened.prepare('SELECT MAX(version) n FROM schema_migrations').get()?.n,19);
  const backups=readdirSync(join(root,'backups','db'));assert.equal(backups.length,1);
  const backup=new DatabaseSync(join(root,'backups','db',backups[0]),{readOnly:true});try{
    assert.ok(!backup.prepare('PRAGMA table_info(report_medications)').all().some(row=>row.name==='formula_json'));
    assert.ok(backup.prepare('SELECT 1 FROM report_medications WHERE id=?').get('source-a'));
  }finally{backup.close();}
  closeDatabaseForTests();getDatabase();assert.deepEqual(readdirSync(join(root,'backups','db')),backups);
}));

test('failed formula backup does not alter the database or continue startup',()=>fixture(db=>{
  db.exec('ALTER TABLE report_medications DROP COLUMN formula_json');
  assert.equal(medicationDraftNeedsRepair(db),true);
  const root=process.env.STORAGE_DIR!;closeDatabaseForTests();
  mkdirSync(join(root,'backups'),{recursive:true});writeFileSync(join(root,'backups','db'),'blocked backup');
  assert.throws(()=>getDatabase());closeDatabaseForTests();
  const unchanged=new DatabaseSync(join(root,'db','health-records.sqlite'),{readOnly:true});try{
    assert.ok(!unchanged.prepare('PRAGMA table_info(report_medications)').all().some(row=>row.name==='formula_json'));
    assert.ok(unchanged.prepare('SELECT 1 FROM report_medications WHERE id=?').get('source-a'));
  }finally{unchanged.close();}
}));

test('historical prescriptions require explicit confirmation and retain their original snapshots through re-extraction',()=>fixture(db=>{
  assert.equal(listHistoricalMedications(manager,'member-a').length,1);
  assert.equal(listMedications(manager,{memberId:'member-a'}).courses.length,0);
  status(()=>createMedicationCourse(manager,{memberId:'member-a',sourceMedicationId:'source-a',startedAt:'2025-01-02'}),400);
  const course=createMedicationCourse(manager,{memberId:'member-a',sourceMedicationId:'source-a',startedAt:'2025-01-02',confirmed:true});
  assert.equal(course.status,'active');assert.equal(course.specification,'合成规格');assert.equal(course.dosageForm,'片剂');
  assert.equal(course.changes.length,1);assert.equal(course.source?.medicationName,'合成药品');
  assert.deepEqual(listHistoricalMedications(manager,'member-a')[0].confirmedCourseIds,[course.id]);
  db.prepare("DELETE FROM report_medications WHERE id='source-a'").run();
  db.prepare("INSERT INTO report_medications(id,report_id,medication_name,dose) VALUES('source-new','report-a','重识别合成药品','3')").run();
  const preserved=getMedicationCourse(manager,course.id);
  assert.equal(preserved.medicationName,'合成药品');assert.equal(preserved.source?.dose,'1');assert.equal(preserved.source?.medicationId,'source-a');
  const duplicate=createMedicationCourse(manager,{memberId:'member-a',medicationName:'合成药品',specification:'另一规格',startedAt:'2025-01-03',confirmed:true});
  assert.notEqual(course.id,duplicate.id);assert.equal(listMedications(manager,{memberId:'member-a'}).courses.length,2);
  db.prepare("UPDATE reports SET member_id='member-b' WHERE id='report-a'").run();
  assert.equal(getMedicationCourse(manager,course.id).sourceReportId,null,'moved source cannot expose the other member report');
  assert.equal(getMedicationCourse(manager,course.id).source?.dose,'1');
  db.prepare("DELETE FROM reports WHERE id='report-a'").run();
  assert.equal(getMedicationCourse(manager,course.id).sourceReportId,null);
  assert.equal(getMedicationCourse(manager,course.id).source?.specification,'合成规格');
}));

test('medication documents read prescription reports once without creating use records or reclassifying ordinary reports',()=>fixture(db=>{
  for (const [id,type,state] of [['report-empty','prescription','ready'],['report-pending','prescription','processing'],
    ['report-failed','prescription','failed'],['report-visit','outpatient','ready']])
    db.prepare("INSERT INTO reports(id,member_id,created_by,title,report_type,status) VALUES(?,'member-a',?,'合成报告',?,?)").run(id,manager.id,type,state);
  for (const [id,report,name,deleted] of [['source-a2','report-a','另一合成药品',0],['source-a3','report-a','合成药品',0],
    ['source-deleted','report-a','已删除明细',1],['source-visit','report-visit','普通就诊用药',0]])
    db.prepare('INSERT INTO report_medications(id,report_id,medication_name,is_deleted) VALUES(?,?,?,?)').run(id,report,name,deleted);
  db.exec('PRAGMA query_only=ON');
  try {
    const documents=listMedicationDocuments(viewer,{memberId:'member-a'});
    assert.deepEqual(documents.map(item=>item.id),['report-a','report-empty','report-failed','report-pending']);
    assert.deepEqual(documents[0],{id:'report-a',memberId:'member-a',title:'合成处方',reportType:'prescription',status:'ready',
      date:'2025-01-01',medicationCount:3,medicationNames:['合成药品','另一合成药品']});
    assert.ok(documents.slice(1).every(item=>item.date===null && item.medicationCount===0 && item.medicationNames.length===0));
    assert.equal(documents.find(item=>item.id==='report-pending')?.status,'processing');
    assert.ok(listHistoricalMedications(viewer,'member-a').some(item=>item.reportId==='report-visit'));
    assert.equal(db.prepare("SELECT report_type FROM reports WHERE id='report-visit'").get()?.report_type,'outpatient');
    for(const table of ['medication_courses','medication_intakes','health_workflow_requests','audit_logs'])
      assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count,0);
  } finally { db.exec('PRAGMA query_only=OFF'); }
}));

test('medication document dates use clinical report dates and remain unknown without one',()=>fixture(db=>{
  const fields=['report_issued_at','reviewed_at','received_at','examined_at','sampled_at','ordered_at'] as const;
  db.prepare("UPDATE reports SET created_at='2025-09-01',report_issued_at='2025-01-01',reviewed_at='2025-01-02',received_at='2025-01-03',examined_at='2025-01-04',sampled_at='2025-01-05',ordered_at='2025-01-06' WHERE id='report-a'").run();
  for(const [index,field] of fields.entries()){
    assert.equal(listMedicationDocuments(manager,{memberId:'member-a'})[0].date,`2025-01-0${index+1}`);
    db.prepare(`UPDATE reports SET ${field}=? WHERE id='report-a'`).run(index%2 ? '' : null);
  }
  assert.equal(listMedicationDocuments(manager,{memberId:'member-a'})[0].date,null,'import/creation time is not a prescription date');
}));

test('medication documents keep archived reports without exposing obsolete event context',()=>fixture(db=>{
  db.prepare("INSERT INTO health_event_resources(id,event_id,resource_type,resource_id) VALUES('resource-a','event-a','report','report-a')").run();
  db.prepare("INSERT INTO health_upload_items(report_id,state,event_id) VALUES('report-a','archived','event-a')").run();
  const document=listMedicationDocuments(viewer,{memberId:'member-a'})[0];
  assert.equal(document.id,'report-a');
  for(const key of ['episodeIds','eventIds','suggestedContext','contextAmbiguous'])assert.equal(Object.hasOwn(document,key),false);
  db.prepare("UPDATE health_events SET deleted_at=CURRENT_TIMESTAMP WHERE id='event-a'").run();
  assert.deepEqual(listMedicationDocuments(viewer,{memberId:'member-a'}),[document]);
}));

test('medication documents respect member reassignment, trash, soft deletion and access checks',()=>fixture(db=>{
  status(()=>listMedicationDocuments(outsider,{memberId:'member-a'}),403);
  status(()=>listMedicationDocuments({...viewer,authenticated:false},{memberId:'member-a'}),401);
  status(()=>listMedicationDocuments(manager,{memberId:['member-a']}),400);
  status(()=>listMedicationDocuments(manager,{}),400);
  db.prepare("INSERT INTO health_event_resources(id,event_id,resource_type,resource_id) VALUES('resource-a','event-a','report','report-a')").run();
  db.prepare("INSERT INTO health_upload_items(report_id,state,event_id) VALUES('report-a','archived','event-a')").run();
  db.prepare("INSERT INTO member_permissions(member_id,user_id,permission,granted_by) VALUES('member-b',?,'manager',?)").run(manager.id,manager.id);
  assignReportMember(manager,'report-a',{memberId:'member-b'});
  assert.deepEqual(listMedicationDocuments(viewer,{memberId:'member-a'}),[]);
  status(()=>listMedicationDocuments(viewer,{memberId:'member-b'}),403);
  const moved=listMedicationDocuments(outsider,{memberId:'member-b'}).find(item=>item.id==='report-a');
  assert.ok(moved);assert.equal(moved.memberId,'member-b');assert.equal(moved.medicationCount,1);
  db.prepare("UPDATE reports SET status='trashed' WHERE id='report-a'").run();
  assert.deepEqual(listMedicationDocuments(outsider,{memberId:'member-b'}).map(item=>item.id),['report-b']);
  db.prepare("UPDATE reports SET status='ready',deleted_at=CURRENT_TIMESTAMP WHERE id='report-a'").run();
  assert.deepEqual(listMedicationDocuments(outsider,{memberId:'member-b'}).map(item=>item.id),['report-b']);
  db.prepare("UPDATE health_members SET deleted_at=CURRENT_TIMESTAMP WHERE id='member-b'").run();
  status(()=>listMedicationDocuments(outsider,{memberId:'member-b'}),403);
}));

test('medication state changes are ordered, versioned, and separate from actual intakes',()=>fixture(db=>{
  let course=createMedicationCourse(manager,{memberId:'member-a',medicationName:'合成药品',specification:'规格一',dose:'1',startedAt:'2025-01-01',confirmed:true});
  status(()=>changeMedicationCourse(manager,course.id,{action:'resume',occurredAt:'2025-01-02',revision:1}),409);
  course=changeMedicationCourse(manager,course.id,{action:'adjust',occurredAt:'2025-01-02',revision:1,dose:'2',specification:'规格二'});
  assert.equal(course.changes[0].snapshot.dose,'1');assert.equal(course.changes[0].snapshot.specification,'规格一');
  assert.equal(course.changes[1].snapshot.dose,'2');assert.equal(course.changes[1].snapshot.specification,'规格二');
  status(()=>changeMedicationCourse(manager,course.id,{action:'pause',occurredAt:'2025-01-03',revision:1}),409);
  status(()=>changeMedicationCourse(manager,course.id,{action:'pause',occurredAt:'2024-01-01',revision:2}),400);
  course=changeMedicationCourse(manager,course.id,{action:'pause',occurredAt:'2025-01-03',revision:2});assert.equal(course.status,'paused');
  course=changeMedicationCourse(manager,course.id,{action:'resume',occurredAt:'2025-01-04',revision:3});assert.equal(course.status,'active');
  course=changeMedicationCourse(manager,course.id,{action:'stop',occurredAt:'2025-01-05',revision:4});assert.equal(course.status,'stopped');
  status(()=>changeMedicationCourse(manager,course.id,{action:'resume',occurredAt:'2025-01-06',revision:5}),409);
  assert.equal(listMedications(manager,{memberId:'member-a'}).intakes.length,0);
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM medication_course_changes').get() as {count:number}).count,5);
  status(()=>createMedicationCourse(manager,{memberId:'member-a',medicationName:'合成药品',startedAt:'2999-01-01',confirmed:true}),400);
  status(()=>createMedicationCourse(manager,{memberId:'member-a',medicationName:'合成药品',startedAt:'2025-02-30T10:00',confirmed:true}),400);
}));

for (const timezone of ['Asia/Shanghai', 'America/Los_Angeles']) {
  test(`medication change precision respects local days and timestamp order in ${timezone}`, context => {
    const previousTimezone = process.env.TZ;
    process.env.TZ = timezone;
    context.mock.timers.enable({ apis: ['Date'], now: new Date('2025-01-02T00:46:00').getTime() });
    try {
      fixture(db => {
        let course = createMedicationCourse(manager, { memberId: 'member-a', medicationName: '合成药品',
          startedAt: '2025-01-02', confirmed: true });
        course = changeMedicationCourse(manager, course.id, { action: 'adjust', occurredAt: '2025-01-02T00:30',
          revision: 1, dose: '2' });
        assert.equal(course.lastChangedAt, '2025-01-02T00:30', 'same-day early morning follows the date-only local day boundary');
        const original = getMedicationCourse(manager, course.id);
        status(() => changeMedicationCourse(manager, course.id, { action: 'pause', occurredAt: '2025-01-02', revision: 2 }), 400);
        status(() => changeMedicationCourse(manager, course.id, { action: 'pause',
          occurredAt: new Date('2025-01-02T00:15').toISOString(), revision: 2 }), 400);
        status(() => changeMedicationCourse(manager, course.id, { action: 'pause', occurredAt: '2025-01-02T00:47', revision: 2 }), 400);
        status(() => changeMedicationCourse(manager, course.id, { action: 'pause', occurredAt: '2025-01-03', revision: 2 }), 400);
        assert.deepEqual(getMedicationCourse(manager, course.id), original, 'rejected backdating or future dates do not change data');
        assert.equal(db.prepare('SELECT COUNT(*) AS count FROM medication_course_changes WHERE course_id=?').get(course.id)?.count, 2);
        const sameInstant = new Date('2025-01-02T00:30').toISOString();
        course = changeMedicationCourse(manager, course.id, { action: 'pause', occurredAt: sameInstant, revision: 2 });
        assert.equal(course.lastChangedAt, sameInstant, 'equal instants remain valid across timezone representations');
        course = changeMedicationCourse(manager, course.id, { action: 'resume', occurredAt: '2025-01-02T00:46', revision: 3 });
        assert.equal(course.lastChangedAt, '2025-01-02T00:46');
        assert.equal(course.startedAt, '2025-01-02', 'comparison does not rewrite stored date precision');
      });
    } finally {
      context.mock.timers.reset();
      if (previousTimezone === undefined) delete process.env.TZ; else process.env.TZ = previousTimezone;
    }
  });
}

test('actual intakes support real edits and recycling while keeping independent snapshots and revisions',()=>fixture(db=>{
  let course=createMedicationCourse(manager,{memberId:'member-a',medicationName:'合成药品',specification:'当时规格',dosageForm:'片剂',route:'口服',startedAt:'2025-01-01',confirmed:true});
  let intake=createMedicationIntake(manager,{memberId:'member-a',courseId:course.id,takenAt:'2025-01-02T08:00',amount:'1',amountUnit:'片'});
  assert.equal(intake.specification,'当时规格');assert.equal(intake.route,'口服');assert.equal(intake.history.length,0);
  course=changeMedicationCourse(manager,course.id,{action:'adjust',occurredAt:'2025-01-03',revision:1,specification:'调整后规格',dose:'2'});
  assert.equal(listMedications(manager,{memberId:'member-a'}).intakes[0].specification,'当时规格');
  intake=updateMedicationIntake(manager,intake.id,{revision:1,amount:'0.5',takenAt:'2025-01-02T09:00'});
  assert.equal(intake.amount,'0.5');assert.equal(intake.revision,2);assert.equal(intake.history[0].snapshot.amount,'1');
  assert.equal(intake.history[0].snapshot.takenAt,'2025-01-02T08:00');
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM medication_intakes').get() as {count:number}).count,1,'editing must update the same intake');
  status(()=>updateMedicationIntake(manager,intake.id,{revision:1,amount:'9'}),409);
  mutateStandaloneTrash(manager,'intake',intake.id,{revision:2},'trash');assert.deepEqual(listMedications(manager,{memberId:'member-a'}).intakes,[]);
  status(()=>updateMedicationIntake(manager,intake.id,{revision:3,amount:'2'}),404);
  const standalone=createMedicationIntake(manager,{memberId:'member-a',medicationName:'独立合成药品',takenAt:'2025-01-01',amount:'1'});
  assert.equal(standalone.courseId,null);
  const unknown=createMedicationIntake(manager,{memberId:'member-a',courseId:course.id,takenAt:'2025-01-04',amount:'1',specification:null,route:null});
  const corrected=updateMedicationIntake(manager,unknown.id,{revision:1,amount:'2'});
  assert.equal(corrected.specification,null,'editing dose does not fill unknown historical facts from the current course');
  assert.equal(corrected.route,null);
  status(()=>createMedicationIntake(manager,{memberId:'member-a',medicationName:'合成药品',takenAt:'2999-01-01',amount:'1'}),400);
  const logs=db.prepare("SELECT detail_json FROM audit_logs WHERE target_type='medication'").all();
  assert.ok(logs.every(row=>!String(row.detail_json).includes('合成') && !String(row.detail_json).includes('amount')));
}));

test('medication source and member access stay independent of retired event context',()=>fixture(db=>{
  const input={memberId:'member-a',medicationName:'合成药品',startedAt:'2025-01-01',confirmed:true};
  status(()=>createMedicationCourse(viewer,input),403);status(()=>listMedications(outsider,{memberId:'member-a'}),403);
  status(()=>createMedicationCourse(manager,{...input,sourceMedicationId:'source-b'}),400);
  const source=listHistoricalMedications(manager,'member-a')[0];
  assert.equal(source.reportId,'report-a');assert.deepEqual(source.confirmedCourseIds,[]);
  for(const key of ['episodeIds','eventIds','suggestedContext','contextAmbiguous'])assert.equal(Object.hasOwn(source,key),false);
  const course=createMedicationCourse(manager,{...input,sourceMedicationId:'source-a'});
  const intake=createMedicationIntake(manager,{memberId:'member-a',courseId:course.id,takenAt:'2025-01-02',amount:'1'});
  assert.equal(intake.sourceReportId,'report-a');assert.equal(listMedications(viewer,{memberId:'member-a'}).courses.length,1);
  status(()=>changeMedicationCourse(viewer,course.id,{action:'pause',occurredAt:'2025-01-03',revision:1}),403);
  status(()=>updateMedicationIntake(viewer,intake.id,{revision:1,amount:'9'}),403);
  status(()=>getMedicationCourse(outsider,course.id),403);
  const foreign=createMedicationCourse(outsider,{...input,memberId:'member-b'});
  status(()=>createMedicationIntake(manager,{memberId:'member-a',courseId:foreign.id,takenAt:'2025-01-01',amount:'1'}),400);
}));

test('medication schema repairs missing draft structure without changing or clearing existing data',()=>fixture(db=>{
  const course=createMedicationCourse(manager,{memberId:'member-a',medicationName:'合成药品',startedAt:'2025-01-01',confirmed:true});
  assert.equal(medicationDraftNeedsRepair(db),false);ensureMedicationDraftSchema(db);
  db.exec('DROP INDEX medication_courses_member_idx');assert.equal(medicationDraftNeedsRepair(db),true);
  ensureMedicationDraftSchema(db);assert.equal(medicationDraftNeedsRepair(db),false);
  assert.equal(getMedicationCourse(manager,course.id).medicationName,'合成药品');
  db.exec('ALTER TABLE medication_courses DROP COLUMN specification');
  assert.equal(medicationDraftNeedsRepair(db),true);ensureMedicationDraftSchema(db);
  assert.equal(medicationDraftNeedsRepair(db),false);assert.equal(getMedicationCourse(manager,course.id).medicationName,'合成药品');
  assert.equal(getMedicationCourse(manager,course.id).changes.length,1);
}));

test('creation receipts prevent duplicate courses and actual intakes after a lost response',()=>fixture(db=>{
  const input={memberId:'member-a',medicationName:'合成药品',specification:'合成规格',startedAt:'2025-01-01',confirmed:true,requestKey:'course-retry-000001'};
  const first=createMedicationCourse(manager,input);const retried=createMedicationCourse(manager,input);
  assert.deepEqual(retried,first);assert.equal(listMedications(manager,{memberId:'member-a'}).courses.length,1);
  status(()=>createMedicationCourse(manager,{...input,dose:'2'}),409);
  const dose={memberId:'member-a',courseId:first.id,takenAt:'2025-01-02',amount:'1',requestKey:'intake-retry-000001'};
  const intake=createMedicationIntake(manager,dose);
  changeMedicationCourse(manager,first.id,{action:'adjust',occurredAt:'2025-01-03',revision:1,specification:'后续规格'});
  assert.deepEqual(createMedicationIntake(manager,dose),intake,'retry returns the original factual snapshot');
  assert.equal(listMedications(manager,{memberId:'member-a'}).intakes.length,1);
  const corrected=updateMedicationIntake(manager,intake.id,{revision:1,amount:'2'});
  assert.deepEqual(createMedicationIntake(manager,dose),corrected,'retry after a correction returns current state of the same record');
  status(()=>createMedicationIntake(manager,{...dose,amount:'2'}),409);
  status(()=>createMedicationIntake(viewer,dose),403);
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM medication_course_changes').get() as {count:number}).count,2);
  const sourceInput={memberId:'member-a',sourceMedicationId:'source-a',startedAt:'2025-01-01',confirmed:true,requestKey:'source-retry-000001'};
  const sourced=createMedicationCourse(manager,sourceInput);
  db.prepare("UPDATE reports SET member_id='member-b' WHERE id='report-a'").run();
  const replay=createMedicationCourse(manager,sourceInput);
  assert.equal(replay.id,sourced.id);assert.equal(replay.sourceReportId,null,'receipt replay rechecks the source report current ownership');
  assert.equal(replay.source?.medicationName,'合成药品');
}));

test('intake source snapshots survive re-extraction, revisions, report merge, reassignment and deletion',()=>fixture(db=>{
 const input={memberId:'member-a',sourceMedicationId:'source-a',takenAt:'2025-01-02',amount:'1',requestKey:'source-intake-stable-key-001'};
 const intake=createMedicationIntake(manager,input);assert.equal(intake.source?.dose,'1');assert.equal(intake.sourceReportId,'report-a');
 db.prepare("DELETE FROM report_medications WHERE id='source-a'").run();
 db.prepare("INSERT INTO report_medications(id,report_id,medication_name,dose) VALUES('new-source','report-a','合成重识别','9')").run();
 assert.equal(createMedicationIntake(manager,input).id,intake.id);
 let saved=updateMedicationIntake(manager,intake.id,{revision:1,amount:'2'});assert.deepEqual(saved.source,intake.source);assert.equal(saved.history[0].snapshot.sourceReportId,'report-a');
 const repeated=createMedicationIntake(manager,{memberId:'member-a',sourceIntakeId:saved.id,takenAt:'2025-01-03',amount:'3'});assert.deepEqual(repeated.source,intake.source);
 status(()=>createMedicationIntake(manager,{memberId:'member-a',sourceIntakeId:saved.id,takenAt:'2025-01-03'}),400);
 status(()=>createMedicationIntake(manager,{memberId:'member-a',sourceIntakeId:saved.id,amount:'3'}),400);
 db.prepare("INSERT INTO reports(id,member_id,created_by,title,report_type,status) VALUES('merged','member-a',?,'合成合并用药单','prescription','ready')").run(manager.id);
 mergeReportWorkflow(db,'report-a','merged');saved=getMedicationIntake(manager,intake.id);assert.equal(saved.sourceReportId,'merged');assert.deepEqual(saved.source,intake.source);
 saved=updateMedicationIntake(manager,intake.id,{revision:saved.revision,amount:'4'});assert.equal(db.prepare('SELECT source_medication_id FROM medication_intakes WHERE id=?').get(intake.id)!.source_medication_id,null,'edit cannot resurrect a removed report fact');
 assert.equal((exportMemberHealthWorkflow(manager,'member-a').medicationIntakes as Array<Record<string,unknown>>).find(row=>row.id===intake.id)!.source_report_id,'merged');
 db.prepare("UPDATE reports SET status='trashed' WHERE id='merged'").run();assert.equal(getMedicationIntake(manager,intake.id).sourceReportId,null);assert.deepEqual(getMedicationIntake(manager,intake.id).source,intake.source);
 db.prepare("UPDATE reports SET status='ready' WHERE id='merged'").run();
 db.prepare("INSERT INTO member_permissions(member_id,user_id,permission,granted_by) VALUES('member-b',?,'manager',?)").run(manager.id,manager.id);
 assignReportMember(manager,'merged',{memberId:'member-b'});saved=getMedicationIntake(manager,intake.id);assert.equal(saved.sourceReportId,null);assert.deepEqual(saved.source,intake.source);assert.equal(saved.revision,4);
 assert.equal(db.prepare('SELECT source_report_id FROM medication_intakes WHERE id=?').get(intake.id)!.source_report_id,null);assert.deepEqual(validateHealthWorkflowDatabase(db),[]);
 db.prepare("DELETE FROM reports WHERE id='merged'").run();assert.deepEqual(getMedicationIntake(manager,intake.id).source,intake.source);
}));
test('missing saved source remains unknown instead of falling back to the current parent source',()=>fixture(db=>{
 const course=createMedicationCourse(manager,{memberId:'member-a',sourceMedicationId:'source-a',startedAt:'2025-01-01',confirmed:true});
 const intake=createMedicationIntake(manager,{memberId:'member-a',courseId:course.id,takenAt:'2025-01-02',amount:'1'});
 db.prepare('UPDATE medication_intakes SET source_report_id=NULL,source_medication_id=NULL,source_snapshot_json=NULL WHERE id=?').run(intake.id);
 const before=db.prepare('SELECT * FROM medication_intakes WHERE id=?').get(intake.id);const saved=getMedicationIntake(viewer,intake.id);
 assert.equal(saved.source,null);assert.equal(saved.sourceReportId,null);assert.deepEqual(db.prepare('SELECT * FROM medication_intakes WHERE id=?').get(intake.id),before);
 const standalone=createMedicationIntake(manager,{memberId:'member-a',medicationName:course.medicationName,takenAt:'2025-01-02',amount:'1'});assert.equal(standalone.source,null);
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM health_record_links').get()!.n,0);
}));
test('intake provenance correction is versioned and cannot combine incompatible parents or foreign sources',()=>fixture(db=>{
 const course=createMedicationCourse(manager,{memberId:'member-a',sourceMedicationId:'source-a',startedAt:'2025-01-01',confirmed:true});
 const intake=createMedicationIntake(manager,{memberId:'member-a',medicationName:'合成药品',takenAt:'2025-01-02',amount:'1'});
 const saved=updateMedicationIntake(manager,intake.id,{revision:1,courseId:course.id});assert.equal(saved.sourceReportId,'report-a');assert.equal(saved.history[0].snapshot.source,null);
 const plain=createMedicationCourse(manager,{memberId:'member-a',medicationName:'合成另一用药',startedAt:'2025-01-01',confirmed:true});
 status(()=>createMedicationIntake(manager,{memberId:'member-a',sourceIntakeId:saved.id,courseId:plain.id,takenAt:'2025-01-03',amount:'1'}),400);
 status(()=>updateMedicationIntake(manager,intake.id,{revision:2,sourceMedicationId:'source-b'}),400);
 assert.equal(getMedicationIntake(manager,intake.id).revision,2);
}));
test('existing v19 intakes receive nullable source columns only after backup, then reopen idempotently',()=>fixture(db=>{
 const intake=createMedicationIntake(manager,{memberId:'member-a',medicationName:'合成药品',takenAt:'2025-01-02',amount:'1'});
 for(const column of ['source_report_id','source_medication_id','source_snapshot_json'])db.exec(`ALTER TABLE medication_intakes DROP COLUMN ${column}`);
 assert.deepEqual(validateHealthWorkflowDatabase(db),[],'older compatible backups remain valid before additive repair');
 const root=process.env.STORAGE_DIR!;closeDatabaseForTests();const reopened=getDatabase();
 assert.equal(reopened.prepare('SELECT MAX(version) AS n FROM schema_migrations').get()!.n,19);
 assert.equal(getMedicationIntake(manager,intake.id).amount,'1');assert.equal(getMedicationIntake(manager,intake.id).source,null);
 const backups=readdirSync(join(root,'backups','db'));assert.equal(backups.length,1);
 const backup=new DatabaseSync(join(root,'backups','db',backups[0]),{readOnly:true});try{
  assert.ok(backup.prepare('SELECT 1 FROM medication_intakes WHERE id=?').get(intake.id));assert.ok(!backup.prepare('PRAGMA table_info(medication_intakes)').all().some(row=>row.name==='source_report_id'));
 }finally{backup.close();}
 closeDatabaseForTests();getDatabase();assert.deepEqual(readdirSync(join(root,'backups','db')),backups);
}));
test('failed backup prevents source-column completion and preserves the old intake row',()=>fixture(db=>{
 const intake=createMedicationIntake(manager,{memberId:'member-a',medicationName:'合成药品',takenAt:'2025-01-02',amount:'1'});
 db.exec('ALTER TABLE medication_intakes DROP COLUMN source_snapshot_json');const root=process.env.STORAGE_DIR!;closeDatabaseForTests();
 mkdirSync(join(root,'backups'),{recursive:true});writeFileSync(join(root,'backups','db'),'synthetic blocked backup directory');assert.throws(()=>getDatabase());closeDatabaseForTests();
 const unchanged=new DatabaseSync(join(root,'db','health-records.sqlite'),{readOnly:true});try{
  assert.equal(unchanged.prepare('PRAGMA table_info(medication_intakes)').all().some(row=>row.name==='source_snapshot_json'),false);assert.ok(unchanged.prepare('SELECT 1 FROM medication_intakes WHERE id=?').get(intake.id));
 }finally{unchanged.close();}
}));

test('recording from a medication with a temporarily trashed source preserves a recoverable source pointer',()=>fixture(db=>{
 const course=createMedicationCourse(manager,{memberId:'member-a',sourceMedicationId:'source-a',startedAt:'2025-01-01',confirmed:true});
 db.prepare("UPDATE reports SET status='trashed' WHERE id='report-a'").run();
 const intake=createMedicationIntake(manager,{memberId:'member-a',courseId:course.id,takenAt:'2025-01-02',amount:'1'});
 assert.equal(intake.sourceReportId,null);assert.equal(intake.source?.medicationId,'source-a');
 assert.equal(db.prepare('SELECT source_report_id FROM medication_intakes WHERE id=?').get(intake.id)!.source_report_id,'report-a');
 const repeat=createMedicationIntake(manager,{memberId:'member-a',sourceIntakeId:intake.id,takenAt:'2025-01-03',amount:'1'});
 assert.equal(repeat.sourceReportId,null);db.prepare("UPDATE reports SET status='ready' WHERE id='report-a'").run();
 assert.equal(getMedicationIntake(manager,intake.id).sourceReportId,'report-a');assert.equal(getMedicationIntake(manager,repeat.id).sourceReportId,'report-a');
}));
