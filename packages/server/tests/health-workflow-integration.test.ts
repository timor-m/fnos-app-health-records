import {mutateStandaloneTrash as removeRecordForTest} from '../services/health-record-trash.service';
import {organizeHealthDocuments} from '../services/health-document-organizer.service';
import {linkProcessRecords,recordProcesses,getRecordProcess} from '../services/health-record-process.service';
import { mutateStandaloneTrash } from '../services/health-record-trash.service';
import { restoreVaccination, listHealthTrash } from '../services/health-record-trash.service';
import { createVaccination, deleteVaccination, getVaccination } from '../services/vaccination.service';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { closeDatabaseForTests, getDatabase } from '../database/client';
import { schemaVersion } from '../database/schema';
import type { RequestUser } from '../domain/request-user';
import { bootstrapLocalAdministrator, createLocalAccount } from '../services/auth.service';
import { createMember, assertMemberAccess, assertMemberManage, setMemberPermission } from '../services/member.service';
import { createFullBackup, createReminder, buildMemberExportManifest, preflightRestore, preflightStoredBackup, restoreBackup, validateBackup } from '../services/records.service';
import { createHealthEpisode, getHealthEpisode } from '../services/health-episode.service';
import { createHealthEvent } from '../services/health-event.service';
import { correctProcessSymptomUpdate, createProcessSymptom, createProcessSymptomUpdate, retractProcessSymptomUpdate } from '../services/symptom-episode.service';
import { createMedicationCourse, changeMedicationCourse, createMedicationIntake, updateMedicationIntake} from '../services/medication.service';
import { registerUploadedReport } from '../services/health-upload-workflow.service';
import { exportMemberHealthWorkflow, validateHealthWorkflowDatabase } from '../services/health-workflow-integrity.service';
import { executeMemberMerge, previewMemberMerge } from '../services/member-merge.service';

const eventTables=['health_events','health_event_resources','health_episodes'];
const additiveTables=['health_process_symptoms','health_process_symptom_updates','health_process_symptom_revisions',
  'medication_courses','medication_course_changes','medication_intakes',
  'health_upload_items','health_upload_archives','health_workflow_requests','health_vaccinations','health_record_processes','health_record_process_nodes','health_record_links','health_record_reminders'];
const workflowTables=[...eventTables,...additiveTables];
type Fixture={dir:string;admin:RequestUser;owner:RequestUser;viewer:RequestUser;memberId:string;otherId:string};
function fixture(run:(fixture:Fixture)=>void) {
  const previous={storage:process.env.STORAGE_DIR,auth:process.env.AUTH_MODE,jobs:process.env.DISABLE_JOB_RUNNER};
  const dir=mkdtempSync(join(tmpdir(),'health-workflow-integration-'));
  process.env.STORAGE_DIR=dir;process.env.AUTH_MODE='local';process.env.DISABLE_JOB_RUNNER='true';
  try {
    bootstrapLocalAdministrator();const db=getDatabase();
    const adminId=String(db.prepare('SELECT user_id FROM local_accounts LIMIT 1').get()!.user_id);
    const admin:RequestUser={id:adminId,displayName:'合成维护账号',provider:'local',authenticated:true,isAdmin:true,isGatewayAdmin:true};
    const ordinary=(username:string):RequestUser=>({...admin,id:createLocalAccount(admin,{username,displayName:'合成普通账号'}).userId,isAdmin:false,isGatewayAdmin:false});
    const owner=ordinary('workflow-owner');const viewer=ordinary('workflow-viewer');
    const member=createMember(owner,{displayName:'合成来源成员',relationship:'other'});
    const other=createMember(owner,{displayName:'合成目标成员',relationship:'other'});
    setMemberPermission(owner,member.id,{userId:viewer.id,permission:'viewer',version:0});
    run({dir,admin,owner,viewer,memberId:member.id,otherId:other.id});
  }finally{
    closeDatabaseForTests();
    for(const [key,value] of Object.entries({STORAGE_DIR:previous.storage,AUTH_MODE:previous.auth,DISABLE_JOB_RUNNER:previous.jobs}))if(value===undefined)delete process.env[key];else process.env[key]=value;
    rmSync(dir,{recursive:true,force:true});
  }
}
function seed(f:Fixture) {
  const {owner,memberId,otherId,dir}=f;const db=getDatabase();
  for(const [id,member] of [['workflow-report',memberId],['group-peer',memberId],['foreign-report',otherId],['pending-report',memberId],['followup-report',memberId]])
    db.prepare("INSERT INTO reports(id,member_id,created_by,title,report_type,status,report_issued_at) VALUES(?,?,?,'合成档案','prescription','ready','2026-01-02')").run(id,member,owner.id);
  const bytes=Buffer.from('synthetic-original-only');writeFileSync(join(dir,'reports','synthetic-original.bin'),bytes);
  db.prepare(`INSERT INTO report_pages(id,report_id,page_number,original_name,storage_path,mime_type,file_size,sha256)
    VALUES('workflow-page','workflow-report',1,'synthetic.bin','reports/synthetic-original.bin','application/octet-stream',?,?)`).run(bytes.length,createHash('sha256').update(bytes).digest('hex'));
  db.exec("INSERT INTO report_medications(id,report_id,medication_name,specification,dose,dose_unit) VALUES('workflow-rx','workflow-report','合成药品','合成规格','1','合成单位')");
  let episode=createHealthEpisode(owner,{memberId,episodeType:'symptom',title:'合成阶段',startedAt:'2026-01-01',symptom:{name:'合成症状甲',description:'合成原始症状'}});
  const symptomId=episode.symptoms[0].id;
  episode=createProcessSymptom(owner,episode.id,{name:'合成症状乙',startedAt:'2026-01-02'});
  episode=createProcessSymptomUpdate(owner,episode.id,symptomId,{recordedAt:'2026-01-02',change:'worsened',severity:5});
  const firstUpdate=episode.symptoms[0].updates[0].id;
  correctProcessSymptomUpdate(owner,episode.id,symptomId,firstUpdate,{version:1,description:'合成纠错记录',severity:4});
  retractProcessSymptomUpdate(owner,episode.id,symptomId,firstUpdate,{version:2});
  createProcessSymptomUpdate(owner,episode.id,symptomId,{recordedAt:'2026-01-03',change:'resolved',severity:0});
  const shared=createHealthEpisode(owner,{memberId,episodeType:'monitoring',title:'合成另一阶段',startedAt:'2026-01-01'});
  const foreignEpisode=createHealthEpisode(owner,{memberId:otherId,episodeType:'other',title:'合成其他成员阶段'});
  const eventInput={memberId,groups:[{reportIds:['workflow-report','group-peer']}],requestKey:'workflow-event-stable-key'};
  const event={id:organizeHealthDocuments(owner,eventInput).groups[0].id};
  assert.equal(organizeHealthDocuments(owner,eventInput).groups[0].id,event.id);
  const foreignEvent=createHealthEvent(owner,{memberId:otherId,eventType:'other'});
  registerUploadedReport(owner,memberId,'pending-report',{relatedRecord:{kind:'symptom',id:symptomId}});
  const reminder=createReminder(owner,{memberId,title:'合成复查计划',dueAt:'2026-01-05',reportId:'workflow-report',relatedRecord:{kind:'report',id:'workflow-report'}});
  registerUploadedReport(owner,memberId,'followup-report',{reminderId:reminder.id});const followup={id:'followup-report'};
  let course=createMedicationCourse(owner,{memberId,sourceMedicationId:'workflow-rx',startedAt:'2026-01-02',confirmed:true});
  course=changeMedicationCourse(owner,course.id,{revision:1,action:'adjust',occurredAt:'2026-01-03',dose:'2',note:'合成调整说明'});
  course=changeMedicationCourse(owner,course.id,{revision:2,action:'stop',occurredAt:'2026-01-04'});
  let intake=createMedicationIntake(owner,{memberId,courseId:course.id,takenAt:'2026-01-03T08:00',amount:'1',amountUnit:'合成单位'});
  intake=updateMedicationIntake(owner,intake.id,{revision:1,amount:'0.5'});
  const revoked=createMedicationIntake(owner,{memberId,courseId:course.id,takenAt:'2026-01-02T08:00',amount:'1'});removeRecordForTest(owner,'intake',revoked.id,{revision:1},'trash');
  linkProcessRecords(owner,{kind:'symptom',id:symptomId},[{kind:'medication',id:course.id}]);
  assert.deepEqual(validateHealthWorkflowDatabase(db),[]);
  return {episodeId:episode.id,symptomId,firstUpdate,courseId:course.id,intakeId:intake.id,eventId:event.id,followupId:followup.id,
    reminderId:reminder.id,foreignEpisodeId:foreignEpisode.id,foreignEventId:foreignEvent.id};
}
function snapshot(tables=workflowTables) {const db=getDatabase();return Object.fromEntries(tables.map(table=>[table,db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));}

test('v19 without all additive workflow structure is backed up before repair and restart preserves populated history',()=>fixture(f=>{
  const db=getDatabase();const migrations=db.prepare('SELECT * FROM schema_migrations').all();
  db.prepare("INSERT INTO reports(id,member_id,created_by,title,report_type,status) VALUES('prior-report',?,?,'合成旧档案','laboratory','ready')").run(f.memberId,f.owner.id);
  const prior=db.prepare("SELECT * FROM reports WHERE id='prior-report'").get();closeDatabaseForTests();
  const old=new DatabaseSync(join(f.dir,'db','health-records.sqlite'));old.exec('PRAGMA foreign_keys=OFF');
  for(const row of old.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger'").all())if(workflowTables.some(table=>String(row.sql).includes(table)))old.exec(`DROP TRIGGER "${row.name}"`);
  for(const table of [...workflowTables].reverse())old.exec(`DROP TABLE ${table}`);old.close();
  const upgraded=getDatabase();assert.equal(schemaVersion,19);assert.deepEqual(upgraded.prepare('SELECT * FROM schema_migrations').all(),migrations);
  assert.deepEqual(upgraded.prepare("SELECT * FROM reports WHERE id='prior-report'").get(),prior);
  for(const table of workflowTables)assert.equal(upgraded.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n,0);
  const backupDir=join(f.dir,'backups','db');const backups=readdirSync(backupDir);assert.equal(backups.length,1);
  const backup=new DatabaseSync(join(backupDir,backups[0]),{readOnly:true});
  try{assert.ok(backup.prepare("SELECT 1 FROM reports WHERE id='prior-report'").get());for(const table of workflowTables)assert.equal(backup.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table),undefined);}finally{backup.close();}
  seed(f);const before=snapshot();closeDatabaseForTests();assert.deepEqual(snapshot(),before);assert.deepEqual(readdirSync(backupDir),backups);
}));

test('complete backup restore retains symptom corrections, medication changes/intakes, reminder completion and member export',()=>fixture(f=>{
  const ids=seed(f);const vaccination=createVaccination(f.owner,{memberId:f.memberId,vaccineName:'合成备份疫苗',administeredAt:'2026-01-01'});linkProcessRecords(f.owner,{kind:'report',id:'pending-report'},[{kind:'vaccination',id:vaccination.id},{kind:'symptom',id:ids.symptomId}]);createReminder(f.owner,{memberId:f.memberId,title:'合成记录复查计划',dueAt:'2026-12-01',relatedRecord:{kind:'symptom',id:ids.symptomId}});const before=snapshot();const backup=createFullBackup(f.admin);
  assert.equal(validateBackup(f.admin,backup.id).valid,true);
  const plan=preflightStoredBackup(f.admin,backup.id);assert.equal(plan.strategy,'same');
  getDatabase().prepare('UPDATE health_process_symptom_updates SET description=? WHERE id=?').run('合成备份后变更',ids.firstUpdate);
  getDatabase().prepare('UPDATE medication_intakes SET amount=? WHERE id=?').run('9',ids.intakeId);
  writeFileSync(join(f.dir,'reports','synthetic-original.bin'),'synthetic-after-backup');
  assert.equal(restoreBackup(f.admin,backup.id,plan.token).restored,true);
  assert.deepEqual(snapshot(),before);assert.equal(readFileSync(join(f.dir,'reports','synthetic-original.bin'),'utf8'),'synthetic-original-only');
  assert.deepEqual(validateHealthWorkflowDatabase(getDatabase()),[]);
  assert.equal(assertMemberAccess(f.viewer,f.memberId),'viewer');assert.throws(()=>assertMemberManage(f.viewer,f.memberId));
  assert.throws(()=>exportMemberHealthWorkflow(f.admin,f.memberId),'administrator has no implicit health access');
  const detail=getHealthEpisode(f.owner,ids.episodeId);assert.equal(detail.status,'active');assert.equal(detail.symptoms[0].status,'resolved');assert.equal(detail.symptoms[1].status,'active');
  const manifest=buildMemberExportManifest(f.owner,f.memberId);const exported=manifest.healthWorkflow;
  assert.ok(exported.vaccinations.some(row=>row.id===vaccination.id));assert.equal(exported.recordLinks.length,before.health_record_links.length);assert.equal(exported.processNodes.length,before.health_record_process_nodes.length);assert.equal(exported.recordReminders.length,before.health_record_reminders.length);
  assert.equal(exported.symptomRevisions.length,2);assert.ok(exported.symptomUpdates.some(row=>row.deleted_at));
  assert.equal(exported.medicationChanges.length,3);assert.equal(exported.medicationIntakes.length,2);
  assert.ok(exported.medicationIntakes.some(row=>row.deleted_at));assert.equal(JSON.parse(String(exported.medicationIntakes.find(row=>row.id===ids.intakeId)!.history_json))[0].snapshot.amount,'1');
  assert.equal(exported.recordReminders.find(row=>row.reminder_id===ids.reminderId)!.completed_id,ids.followupId);assert.equal(exported.reminders.find(row=>row.id===ids.reminderId)!.status,'completed');
  assert.equal(exported.uploadItems.length,4);assert.deepEqual(exported.uploadItems.find(row=>row.report_id==='pending-report')!.context.relatedRecord,{kind:'symptom',id:ids.symptomId});
  assert.ok(!JSON.stringify(exported).includes('workflow-archive-stable-key'),'retry receipt keys are not member health export content');
  assert.ok(!JSON.stringify(exported).includes('workflow-event-stable-key'));
  assert.ok(getDatabase().prepare("SELECT 1 FROM health_workflow_requests WHERE request_key='workflow-event-stable-key'").get(),'request receipts survive full restore');
  assert.ok(exported.events.every(row=>row.member_id===f.memberId));assert.ok(!manifest.reports.some(row=>row.id==='foreign-report'));
}));

function damagedArchive(f:Fixture,source:string,label:string,mutate:(db:DatabaseSync)=>void) {
  const root=mkdtempSync(join(f.dir,'damaged-'));const path=join(root,'db','health-records.sqlite');
  execFileSync('tar',['-xzf',source,'-C',root],{stdio:'pipe'});
  const db=new DatabaseSync(path);db.exec('PRAGMA foreign_keys=OFF');try{mutate(db);}finally{db.close();}
  const manifestPath=join(root,'manifest.json');const manifest=JSON.parse(readFileSync(manifestPath,'utf8'));
  const entry=manifest.files.find((item:{path:string})=>item.path==='db/health-records.sqlite');
  entry.sizeBytes=statSync(path).size;entry.sha256=createHash('sha256').update(readFileSync(path)).digest('hex');writeFileSync(manifestPath,JSON.stringify(manifest));
  const archive=join(f.dir,`damaged-${label}.tar.gz`);execFileSync('tar',['-czf',archive,'-C',root,'.'],{stdio:'pipe'});rmSync(root,{recursive:true,force:true});return archive;
}

test('restore preflight rejects partial workflow groups and every cross-member relationship despite valid checksums',()=>fixture(f=>{
  const ids=seed(f);const backup=createFullBackup(f.admin);const before=snapshot();
  const variants:Array<[string,(db:DatabaseSync)=>void]>=[
    ...['health_process_symptom_revisions','medication_course_changes','health_upload_archives'].map(table=>[`missing-${table}`,(db:DatabaseSync)=>db.exec(`DROP TABLE ${table}`)] as [string,(db:DatabaseSync)=>void]),
    ['intake-member',db=>db.prepare('UPDATE medication_intakes SET member_id=? WHERE id=?').run(f.otherId,ids.intakeId)],
    ['medication-source',db=>db.prepare('UPDATE medication_courses SET source_report_id=? WHERE id=?').run('foreign-report',ids.courseId)],
    ['reminder-anchor',db=>db.prepare("UPDATE health_record_reminders SET anchor_id='foreign-report' WHERE reminder_id=?").run(ids.reminderId)],
    ['upload-event',db=>db.prepare("UPDATE health_upload_items SET event_id=? WHERE report_id='workflow-report'").run(ids.foreignEventId)],
    ['upload-pending-context',db=>db.prepare("UPDATE health_upload_items SET context_json=? WHERE report_id='pending-report'").run(JSON.stringify({relatedRecord:{kind:'report',id:'foreign-report'}}))],
    ['symptom-revision',db=>db.prepare('UPDATE health_process_symptom_revisions SET episode_id=? WHERE target_id=?').run(ids.foreignEpisodeId,ids.firstUpdate)]
  ];
  const accepted:string[]=[];
  for(const [label,mutate] of variants){const archive=damagedArchive(f,backup.path,label,mutate);try{preflightRestore(f.admin,archive);accepted.push(label);}catch(error){assert.match(String(error),/备份校验失败|关联|缺少|完整性/);}}
  assert.deepEqual(accepted,[],'invalid archives must fail before replacing active data');assert.deepEqual(snapshot(),before);
}));

test('member merge moves the full workflow atomically without granting administrator access and retains a pre-merge backup on rollback',()=>fixture(f=>{
  const ids=seed(f);const db=getDatabase();const before=snapshot();
  const request={sourceId:f.memberId,targetId:f.otherId,choices:{display_name:'target',birth_date:'target',sex:'target',blood_type_abo:'target',blood_type_rh:'target'},
    grants:[{userId:f.owner.id,permission:'manager',canManageSharing:true},{userId:f.viewer.id,permission:'viewer',canManageSharing:false}]};
  const plan=previewMemberMerge(f.admin,request);
  db.exec("CREATE TRIGGER workflow_merge_failure BEFORE INSERT ON member_merges BEGIN SELECT RAISE(ABORT,'synthetic workflow rollback'); END");
  assert.throws(()=>executeMemberMerge(f.admin,plan.token),/synthetic workflow rollback/);assert.deepEqual(snapshot(),before);
  assert.equal(assertMemberAccess(f.viewer,f.memberId),'viewer');assert.ok(readdirSync(join(f.dir,'backups','full')).some(name=>name.endsWith('.tar.gz')));
  db.exec('DROP TRIGGER workflow_merge_failure');assert.equal(executeMemberMerge(f.admin,plan.token).status,'completed');
  for(const table of ['health_events','health_episodes','medication_courses','medication_intakes','health_upload_archives','health_workflow_requests','reports','reminders'])
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE member_id=?`).get(f.memberId)!.n,0);
  assert.equal(getHealthEpisode(f.owner,ids.episodeId).memberId,f.otherId);
  for(const table of ['health_process_symptoms','health_process_symptom_updates','health_process_symptom_revisions','medication_course_changes','health_upload_items'])
    assert.deepEqual(db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),before[table]);
  assert.equal(assertMemberAccess(f.viewer,f.otherId),'viewer');assert.throws(()=>assertMemberManage(f.viewer,f.otherId));assert.throws(()=>assertMemberAccess(f.admin,f.otherId));assert.throws(()=>assertMemberAccess(f.owner,f.memberId));
  assert.deepEqual(validateHealthWorkflowDatabase(db),[]);assert.equal(db.prepare('PRAGMA foreign_key_check').get(),undefined);
  assert.equal(buildMemberExportManifest(f.owner,f.otherId).healthWorkflow.symptomRevisions.length,2);
}));

test('member merge preview detects child-only changes even when all parent rows stay identical',()=>fixture(f=>{
  const ids=seed(f);const db=getDatabase();
  const request={sourceId:f.memberId,targetId:f.otherId,choices:{display_name:'target',birth_date:'target',sex:'target',blood_type_abo:'target',blood_type_rh:'target'},
    grants:[{userId:f.owner.id,permission:'manager',canManageSharing:true}]};
  const parentBefore=snapshot(['health_episodes','health_events','medication_courses','medication_intakes','reports','reminders']);
  const variants:Array<[string,()=>void]>=[
    ['symptom observation',()=>db.prepare('UPDATE health_process_symptom_updates SET description=? WHERE id=?').run('合成子项更正',ids.firstUpdate)],
    ['symptom correction history',()=>db.prepare("UPDATE health_process_symptom_revisions SET operation='correct' WHERE target_id=?").run(ids.firstUpdate)],
    ['process node',()=>db.prepare("UPDATE health_record_process_nodes SET stage_override='followup' WHERE kind='medication' AND record_id=?").run(ids.courseId)],
    ['upload organization',()=>db.prepare("UPDATE health_upload_items SET state='skipped' WHERE report_id='pending-report'").run()],
    ['follow-up anchor',()=>db.prepare("UPDATE health_record_reminders SET completed_id=NULL,completed_kind=NULL WHERE reminder_id=?").run(ids.reminderId)]
  ];
  for(const [label,mutate] of variants){
    const plan=previewMemberMerge(f.admin,request);mutate();
    assert.deepEqual(snapshot(['health_episodes','health_events','medication_courses','medication_intakes','reports','reminders']),parentBefore,label);
    assert.throws(()=>executeMemberMerge(f.admin,plan.token),/变化/,label);
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM member_merges').get()!.n,0);
  assert.equal(assertMemberAccess(f.viewer,f.memberId),'viewer');
}));

test('persisted vaccination drafts are backed up before missing reminder columns are completed without losing doses',()=>fixture(f=>{
 const saved=createVaccination(f.owner,{memberId:f.memberId,vaccineName:'合成草案接种',administeredAt:'2026-01-01'});
 closeDatabaseForTests();const path=join(f.dir,'db','health-records.sqlite');const old=new DatabaseSync(path);
 old.exec('DROP INDEX health_vaccinations_completed_reminder_idx; ALTER TABLE health_vaccinations DROP COLUMN completed_reminder_id; ALTER TABLE health_vaccinations DROP COLUMN reminder_id');old.close();
 const backupsBefore=new Set(existsSync(join(f.dir,'backups','db'))?readdirSync(join(f.dir,'backups','db')):[]);const db=getDatabase();
 const dose=db.prepare('SELECT * FROM health_vaccinations WHERE id=?').get(saved.id)!;assert.equal(dose.vaccine_name,'合成草案接种');assert.equal(dose.revision,1);assert.equal(dose.reminder_id,null);assert.equal(dose.completed_reminder_id,null);
 const backupName=readdirSync(join(f.dir,'backups','db')).find(name=>!backupsBefore.has(name))!;assert.ok(backupName);
 const backup=new DatabaseSync(join(f.dir,'backups','db',backupName),{readOnly:true});try{assert.ok(backup.prepare('SELECT 1 FROM health_vaccinations WHERE id=?').get(saved.id));assert.equal(backup.prepare('PRAGMA table_info(health_vaccinations)').all().some(column=>column.name==='reminder_id'),false);}finally{backup.close();}
 closeDatabaseForTests();assert.deepEqual(getDatabase().prepare('SELECT * FROM health_vaccinations WHERE id=?').get(saved.id),dose);assert.equal(getDatabase().prepare('SELECT MAX(version) AS version FROM schema_migrations').get()!.version,19);
}));

test('v19 vaccination trash columns are backed up and completed in place without losing active or retracted doses',()=>fixture(f=>{
 const saved=createVaccination(f.owner,{memberId:f.memberId,vaccineName:'合成历史接种',administeredAt:'2026-01-01'});
 const active=createVaccination(f.owner,{memberId:f.memberId,vaccineName:'合成在册接种',administeredAt:'2026-01-02'});
 getDatabase().prepare("UPDATE health_vaccinations SET deleted_at='2026-01-03',revision=revision+1 WHERE id=?").run(saved.id);
 closeDatabaseForTests();const path=join(f.dir,'db','health-records.sqlite');const old=new DatabaseSync(path);old.exec('ALTER TABLE health_vaccinations DROP COLUMN purge_after; ALTER TABLE health_vaccinations DROP COLUMN trash_state_json');old.close();
 const backupDir=join(f.dir,'backups','db');const before=new Set(existsSync(backupDir)?readdirSync(backupDir):[]);const db=getDatabase();const history=db.prepare('SELECT * FROM health_vaccinations WHERE id=?').get(saved.id)!;assert.equal(history.deleted_at,'2026-01-03');assert.equal(history.purge_after,null);assert.equal(history.trash_state_json,null);assert.equal(getVaccination(f.owner,active.id).id,active.id);
 const files=readdirSync(backupDir);const name=files.find(value=>!before.has(value))!;assert.ok(name);const backup=new DatabaseSync(join(backupDir,name),{readOnly:true});try{assert.equal(backup.prepare('PRAGMA table_info(health_vaccinations)').all().some(column=>column.name==='purge_after'),false);assert.equal(backup.prepare('SELECT deleted_at FROM health_vaccinations WHERE id=?').get(saved.id)!.deleted_at,'2026-01-03');}finally{backup.close();}
 closeDatabaseForTests();assert.deepEqual(getDatabase().prepare('SELECT * FROM health_vaccinations WHERE id=?').get(saved.id),history);assert.deepEqual(readdirSync(backupDir),files);assert.equal(getDatabase().prepare('SELECT MAX(version) AS version FROM schema_migrations').get()!.version,19);
 restoreVaccination(f.owner,saved.id,{revision:history.revision});assert.equal(getVaccination(f.owner,saved.id).id,saved.id);
}));
test('missing trash columns are not altered when the required pre-upgrade backup fails',()=>fixture(f=>{
 const saved=createVaccination(f.owner,{memberId:f.memberId,vaccineName:'合成备份保护',administeredAt:'2026-01-01'});closeDatabaseForTests();const path=join(f.dir,'db','health-records.sqlite');const old=new DatabaseSync(path);old.exec('ALTER TABLE health_vaccinations DROP COLUMN purge_after; ALTER TABLE health_vaccinations DROP COLUMN trash_state_json');old.close();
 mkdirSync(join(f.dir,'backups'),{recursive:true});writeFileSync(join(f.dir,'backups','db'),'synthetic blocked backup directory');assert.throws(()=>getDatabase());closeDatabaseForTests();const unchanged=new DatabaseSync(path,{readOnly:true});try{assert.equal(unchanged.prepare('PRAGMA table_info(health_vaccinations)').all().some(column=>column.name==='purge_after'),false);assert.ok(unchanged.prepare('SELECT 1 FROM health_vaccinations WHERE id=?').get(saved.id));}finally{unchanged.close();}
}));
test('full backup and member export retain trash retention and reminder snapshots for a later restore',()=>fixture(f=>{
 const saved=createVaccination(f.owner,{memberId:f.memberId,vaccineName:'合成回收站备份',administeredAt:'2026-01-01',nextDueAt:'2026-02-01'});deleteVaccination(f.owner,saved.id,{revision:saved.revision});const row=listHealthTrash(f.owner,f.memberId).items[0];const full=createFullBackup(f.admin);assert.equal(validateBackup(f.admin,full.id).valid,true);
 const exported=exportMemberHealthWorkflow(f.owner,f.memberId).vaccinations.find(item=>item.id===saved.id)!;assert.ok(exported.purge_after);assert.equal(JSON.parse(String(exported.trash_state_json)).reminderStatus,'pending');
 restoreVaccination(f.owner,saved.id,{revision:row.revision});const plan=preflightStoredBackup(f.admin,full.id);restoreBackup(f.admin,full.id,plan.token);assert.equal(listHealthTrash(f.owner,f.memberId).items[0].purgeAfter,row.purgeAfter);restoreVaccination(f.owner,saved.id,{revision:row.revision});assert.equal(getVaccination(f.owner,saved.id).reminderStatus,'pending');
}));

test('missing symptom and medication recycle columns are backed up before idempotent v19 completion',()=>fixture(f=>{
 const course=createMedicationCourse(f.owner,{memberId:f.memberId,medicationName:'合成兼容方案',startedAt:'2026-01-01',confirmed:true});const intake=createMedicationIntake(f.owner,{memberId:f.memberId,medicationName:'合成兼容单次',takenAt:'2026-01-02',amount:'1'});const episode=createHealthEpisode(f.owner,{memberId:f.memberId,episodeType:'symptom',title:'合成兼容症状',symptom:{name:'合成兼容症状'}});const symptomId=episode.symptoms[0].id;
 getDatabase().prepare("UPDATE health_process_symptoms SET deleted_at='2026-01-03' WHERE id=?").run(symptomId);closeDatabaseForTests();const path=join(f.dir,'db','health-records.sqlite');const old=new DatabaseSync(path);old.exec('ALTER TABLE health_process_symptoms DROP COLUMN purge_after; ALTER TABLE medication_courses DROP COLUMN deleted_at; ALTER TABLE medication_courses DROP COLUMN purge_after; ALTER TABLE medication_intakes DROP COLUMN deleted_at; ALTER TABLE medication_intakes DROP COLUMN purge_after');old.close();
 const backupDir=join(f.dir,'backups','db');const before=new Set(existsSync(backupDir)?readdirSync(backupDir):[]);const db=getDatabase();assert.equal(db.prepare('SELECT deleted_at FROM medication_courses WHERE id=?').get(course.id)!.deleted_at,null);assert.equal(db.prepare('SELECT deleted_at FROM medication_intakes WHERE id=?').get(intake.id)!.deleted_at,null);assert.equal(db.prepare('SELECT deleted_at,purge_after FROM health_process_symptoms WHERE id=?').get(symptomId)!.deleted_at,'2026-01-03');
 const files=readdirSync(backupDir);const backupName=files.find(name=>!before.has(name))!;assert.ok(backupName);const snapshot=new DatabaseSync(join(backupDir,backupName),{readOnly:true});try{assert.equal(snapshot.prepare('PRAGMA table_info(medication_courses)').all().some(row=>row.name==='deleted_at'),false);assert.ok(snapshot.prepare('SELECT 1 FROM medication_intakes WHERE id=?').get(intake.id));}finally{snapshot.close();}
 closeDatabaseForTests();getDatabase();assert.deepEqual(readdirSync(backupDir),files);assert.equal(getDatabase().prepare('SELECT MAX(version) AS version FROM schema_migrations').get()!.version,19);
}));
test('backup restore preserves the full symptom, course and independent-intake recycle lifecycle',()=>fixture(f=>{
 const episode=createHealthEpisode(f.owner,{memberId:f.memberId,episodeType:'symptom',title:'合成回收症状',symptom:{name:'合成回收症状'}});const symptom=episode.symptoms[0];const course=createMedicationCourse(f.owner,{memberId:f.memberId,medicationName:'合成回收方案',startedAt:'2026-01-01',confirmed:true});const intake=createMedicationIntake(f.owner,{memberId:f.memberId,medicationName:'合成回收服药',takenAt:'2026-01-02',amount:'1'});
 for(const [kind,id,revision] of [['symptom',symptom.id,symptom.version],['medication',course.id,course.revision],['intake',intake.id,intake.revision]] as const)mutateStandaloneTrash(f.owner,kind,id,{revision},'trash');
 const before=listHealthTrash(f.owner,f.memberId).items;assert.equal(before.length,3);const backup=createFullBackup(f.admin);assert.equal(validateBackup(f.admin,backup.id).valid,true);for(const row of before)mutateStandaloneTrash(f.owner,row.kind as 'symptom'|'medication'|'intake',row.id,{revision:row.revision},'restore');const plan=preflightStoredBackup(f.admin,backup.id);restoreBackup(f.admin,backup.id,plan.token);assert.deepEqual(listHealthTrash(f.owner,f.memberId).items,before);assert.deepEqual(validateHealthWorkflowDatabase(getDatabase()),[]);
}));
