import { mutateStandaloneTrash,purgeExpiredStandaloneRecords } from '../services/health-record-trash.service';
import { createPublicSymptom } from '../services/public-symptom.service';
import { createProcessSymptomUpdate,readProcessSymptoms } from '../services/symptom-episode.service';
import { createMedicationCourse,createMedicationIntake,getMedicationCourse,getMedicationIntake,listMedications} from '../services/medication.service';
import { healthRecordContext } from '../services/health-record-context.service';
import { validateHealthWorkflowDatabase } from '../services/health-workflow-integrity.service';
import { ensureHealthProcessDraft } from '../database/health-process-draft';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDatabase, closeDatabaseForTests } from '../database/client';
import type { RequestUser } from '../domain/request-user';
import { createVaccination, deleteVaccination, getVaccination } from '../services/vaccination.service';
import { listHealthTrash, restoreVaccination, permanentlyDeleteVaccination, purgeExpiredVaccinations } from '../services/health-record-trash.service';
import { listHealthRecordFeed } from '../services/health-record-feed.service';
import { updateReminderStatus } from '../services/records.service';
import { createClinicalFact } from '../services/clinical-fact.service';
import { createHealthEpisode } from '../services/health-episode.service';
import { mergeReportWorkflow } from '../services/health-workflow-integrity.service';
const manager:RequestUser={id:'manager',displayName:'合成账号',provider:'development',authenticated:true,isGatewayAdmin:true};
const viewer:RequestUser={...manager,id:'viewer',isGatewayAdmin:false};
const outsider:RequestUser={...viewer,id:'outsider'};
const input={memberId:'member',vaccineName:'合成疫苗',doseNumber:'1',administeredAt:'2026-01-01',nextDueAt:'2026-02-01'};
function fixture(run:()=>void){const before=process.env.STORAGE_DIR;const dir=mkdtempSync(join(tmpdir(),'health-trash-'));process.env.STORAGE_DIR=dir;
 try{const db=getDatabase();for(const user of [manager,viewer,outsider])db.prepare('INSERT INTO users(id,display_name) VALUES(?,?)').run(user.id,'合成账号');
 for(const member of ['member','second']){db.prepare('INSERT INTO health_members(id,display_name,created_by) VALUES(?,?,?)').run(member,'合成成员',manager.id);db.prepare("INSERT INTO member_permissions(member_id,user_id,permission,granted_by) VALUES(?,?,'manager','manager')").run(member,manager.id);}
 db.prepare("INSERT INTO member_permissions(member_id,user_id,permission,granted_by) VALUES('member','viewer','viewer','manager')").run();run();
 }finally{closeDatabaseForTests();if(before===undefined)delete process.env.STORAGE_DIR;else process.env.STORAGE_DIR=before;rmSync(dir,{recursive:true,force:true});}}
function status(run:()=>unknown,n:number){assert.throws(run,error=>(error as {statusCode:number}).statusCode===n);}
function trash(id:string){deleteVaccination(manager,id,{revision:getVaccination(manager,id).revision});return listHealthTrash(manager,'member').items.find(item=>item.kind==='vaccination'&&item.id===id)!;}
function restore(id:string){const row=listHealthTrash(manager,'member').items.find(item=>item.kind==='vaccination'&&item.id===id)!;return restoreVaccination(manager,id,{revision:row.revision});}
function report(id:string){getDatabase().prepare("INSERT INTO reports(id,member_id,created_by,title,report_type,status) VALUES(?,'member','manager','合成凭证','vaccination','ready')").run(id);}
test('trash and restore preserve the same vaccination, process and next-dose reminder, with revision and permission checks',()=>fixture(()=>{
 const episode=createHealthEpisode(manager,{memberId:'member',episodeType:'symptom',title:'合成过程',symptom:{name:'合成症状'}});
 const saved=createVaccination(manager,{...input,episodeId:episode.id});
 status(()=>deleteVaccination(viewer,saved.id,{revision:saved.revision}),403);status(()=>deleteVaccination(manager,saved.id,{revision:99}),409);
 const row=trash(saved.id);assert.equal(row.kind,'vaccination');assert.ok(row.purgeAfter);assert.equal(listHealthRecordFeed(manager,{memberId:'member'}).items.filter(item=>item.kind==='vaccination').length,0);
 assert.equal(getDatabase().prepare('SELECT status FROM reminders WHERE id=?').get(saved.reminderId!)!.status,'dismissed');
 assert.equal(listHealthTrash(viewer,'member').items.length,1);status(()=>listHealthTrash(outsider,'member'),403);status(()=>restoreVaccination(viewer,saved.id,{revision:row.revision}),403);status(()=>restoreVaccination(manager,saved.id,{revision:99}),409);
 restore(saved.id);const actual=getVaccination(manager,saved.id);assert.equal(actual.doseNumber,'1');assert.equal(actual.reminderId,saved.reminderId);assert.equal(actual.reminderStatus,'pending');assert.equal(actual.revision,3);assert.equal(listHealthTrash(manager,'member').items.length,0);
}));
test('restoring preserves a reminder canceled before trash instead of enabling it',()=>fixture(()=>{
 const saved=createVaccination(manager,input);updateReminderStatus(manager,saved.reminderId!,'dismissed');trash(saved.id);restore(saved.id);assert.equal(getVaccination(manager,saved.id).reminderStatus,'dismissed');
}));
test('legacy retractions appear in the same recycle bin without an automatic expiry and remain recoverable',()=>fixture(()=>{
 const saved=createVaccination(manager,input);const db=getDatabase();db.prepare("UPDATE health_vaccinations SET deleted_at='2000-01-01',revision=revision+1 WHERE id=?").run(saved.id);db.prepare("UPDATE reminders SET status='dismissed' WHERE id=?").run(saved.reminderId!);
 const row=listHealthTrash(manager,'member').items[0];assert.equal(row.purgeAfter,null);assert.equal(purgeExpiredVaccinations().deleted,0);assert.equal(restore(saved.id).reminderNeedsReview,true);assert.equal(getVaccination(manager,saved.id).reminderStatus,'dismissed');
}));
test('restoring a credential-backed dose refuses a duplicate registration without changing reminders or the trashed row',()=>fixture(()=>{
 report('proof');const fact=createClinicalFact(manager,'proof','vaccination',{vaccineName:'合成疫苗',administeredAt:'2026-01-01'});const source={...input,sourceReportId:'proof',sourceFactId:fact.id};const first=createVaccination(manager,source);const row=trash(first.id);createVaccination(manager,source);
 status(()=>restoreVaccination(manager,first.id,{revision:row.revision}),409);assert.ok(getDatabase().prepare('SELECT deleted_at FROM health_vaccinations WHERE id=?').get(first.id)!.deleted_at);assert.equal(getDatabase().prepare('SELECT status FROM reminders WHERE id=?').get(first.reminderId!)!.status,'dismissed');
}));
test('dose-chain restore requires the parent first and completes the original reminder again',()=>fixture(()=>{
 const first=createVaccination(manager,input);const next=createVaccination(manager,{...input,doseNumber:'2',administeredAt:'2026-02-01',nextDueAt:'2026-03-01',completedReminderId:first.reminderId});
 status(()=>deleteVaccination(manager,first.id,{revision:first.revision}),409);trash(next.id);trash(first.id);status(()=>restore(next.id),409);
 restore(first.id);assert.equal(getVaccination(manager,first.id).reminderStatus,'pending');restore(next.id);assert.equal(getVaccination(manager,first.id).reminderStatus,'completed');assert.equal(getVaccination(manager,first.id).nextVaccinationId,next.id);assert.equal(getVaccination(manager,next.id).reminderStatus,'pending');
}));
test('a newly registered dose blocks restoring an older dose against the same reminder',()=>fixture(()=>{
 const first=createVaccination(manager,input);const next=createVaccination(manager,{...input,administeredAt:'2026-02-01',nextDueAt:null,completedReminderId:first.reminderId});const row=trash(next.id);createVaccination(manager,{...input,administeredAt:'2026-02-02',nextDueAt:null,completedReminderId:first.reminderId});status(()=>restoreVaccination(manager,next.id,{revision:row.revision}),409);
}));
test('permanent deletion is restricted to trash, keeps the source document, and invalidates stale restore revisions',()=>fixture(()=>{
 report('proof');const saved=createVaccination(manager,{...input,sourceReportId:'proof'});status(()=>permanentlyDeleteVaccination(manager,saved.id,{revision:saved.revision}),409);const row=trash(saved.id);status(()=>permanentlyDeleteVaccination(viewer,saved.id,{revision:row.revision}),403);status(()=>permanentlyDeleteVaccination(manager,saved.id,{revision:0}),409);
 permanentlyDeleteVaccination(manager,saved.id,{revision:row.revision});assert.ok(getDatabase().prepare('SELECT 1 FROM reports WHERE id=?').get('proof'));status(()=>restoreVaccination(manager,saved.id,{revision:row.revision}),404);
}));
test('purging a parent keeps the child recoverable as an independent dose',()=>fixture(()=>{
 const first=createVaccination(manager,input);const next=createVaccination(manager,{...input,administeredAt:'2026-02-01',nextDueAt:null,completedReminderId:first.reminderId});trash(next.id);const row=trash(first.id);permanentlyDeleteVaccination(manager,first.id,{revision:row.revision});restore(next.id);assert.equal(getVaccination(manager,next.id).completedReminderId,null);
}));
test('scheduled cleanup deletes only expired trash and never legacy retractions or active vaccinations',()=>fixture(()=>{
 const old=createVaccination(manager,input);const recent=createVaccination(manager,{...input,doseNumber:'2'});const legacy=createVaccination(manager,{...input,doseNumber:'3'});const active=createVaccination(manager,{...input,doseNumber:'4'});trash(old.id);trash(recent.id);
 const db=getDatabase();db.prepare("UPDATE health_vaccinations SET purge_after='2000-01-01T00:00:00Z' WHERE id=?").run(old.id);db.prepare("UPDATE health_vaccinations SET deleted_at='2000-01-01' WHERE id=?").run(legacy.id);
 assert.deepEqual(purgeExpiredVaccinations(),{checked:1,deleted:1,failed:0});assert.equal(listHealthTrash(manager,'member').items.length,2);assert.equal(getVaccination(manager,active.id).id,active.id);
}));
test('mixed recycle-bin pagination has no duplicates and refuses a cursor from another member',()=>fixture(()=>{
 const dose=createVaccination(manager,input);trash(dose.id);report(dose.id);getDatabase().prepare("UPDATE reports SET status='trashed',deleted_at=CURRENT_TIMESTAMP,purge_after=datetime('now','+30 days') WHERE id=?").run(dose.id);
 const first=listHealthTrash(manager,'member',{limit:1});assert.ok(first.nextCursor);const second=listHealthTrash(manager,'member',{limit:1,cursor:first.nextCursor!});assert.equal(second.items.length,1);assert.notEqual(first.items[0].kind,second.items[0].kind);assert.equal(second.nextCursor,null);status(()=>listHealthTrash(manager,'second',{cursor:first.nextCursor!}),400);status(()=>listHealthTrash(manager,'member',{cursor:'bad'}),400);
}));
test('source merge while in trash preserves retention and the reminder snapshot for restoration',()=>fixture(()=>{
 report('source');report('target');const dose=createVaccination(manager,{...input,sourceReportId:'source'});const before=trash(dose.id);mergeReportWorkflow(getDatabase(),'source','target');const after=listHealthTrash(manager,'member').items[0];assert.equal(after.purgeAfter,before.purgeAfter);assert.ok(after.revision!>before.revision!);restore(dose.id);assert.equal(getVaccination(manager,dose.id).sourceReportId,'target');assert.equal(getVaccination(manager,dose.id).reminderStatus,'pending');
}));

test('clearing operation logs does not change retention or reminder restoration',()=>fixture(()=>{
 const saved=createVaccination(manager,input);const before=trash(saved.id);getDatabase().prepare('DELETE FROM audit_logs').run();assert.equal(listHealthTrash(manager,'member').items[0].purgeAfter,before.purgeAfter);restore(saved.id);assert.equal(getVaccination(manager,saved.id).reminderStatus,'pending');
}));

test('reminder changes made while a dose is in trash are preserved on restore',()=>fixture(()=>{
 const saved=createVaccination(manager,input);trash(saved.id);updateReminderStatus(manager,saved.reminderId!,'dismissed',{dueAt:'2026-04-01'});restore(saved.id);const actual=getVaccination(manager,saved.id);assert.equal(actual.reminderStatus,'dismissed');assert.equal(actual.nextDueAt,'2026-04-01');
}));

function trashOther(kind:'symptom'|'medication'|'intake',id:string,revision:number){mutateStandaloneTrash(manager,kind,id,{revision},'trash');return listHealthTrash(manager,'member').items.find(item=>item.kind===kind&&item.id===id)!;}
function restoreOther(kind:'symptom'|'medication'|'intake',id:string){const row=listHealthTrash(manager,'member').items.find(item=>item.kind===kind&&item.id===id)!;return mutateStandaloneTrash(manager,kind,id,{revision:row.revision},'restore');}
test('symptom trash restores the same symptom with its observations and links, and permanent deletion leaves no orphan history',()=>fixture(()=>{
 const symptom=createPublicSymptom(manager,{memberId:'member',name:'合成症状',startedAt:'2026-01-01'});createProcessSymptomUpdate(manager,symptom.episodeId,symptom.id,{recordedAt:'2026-01-02',change:'improved',description:'合成变化'});
 const before=readProcessSymptoms(symptom.episodeId)[0];const row=trashOther('symptom',symptom.id,before.version);assert.equal(readProcessSymptoms(symptom.episodeId).length,0);status(()=>healthRecordContext(manager,{kind:'symptom',id:symptom.id}),404);restoreOther('symptom',symptom.id);const after=readProcessSymptoms(symptom.episodeId)[0];assert.equal(after.id,before.id);assert.equal(after.updates.length,1);assert.equal(after.status,before.status);
 const again=trashOther('symptom',symptom.id,after.version);mutateStandaloneTrash(manager,'symptom',symptom.id,{revision:again.revision},'purge');assert.equal(getDatabase().prepare('SELECT COUNT(*) AS n FROM health_process_symptom_updates WHERE symptom_id=?').get(symptom.id)!.n,0);assert.deepEqual(validateHealthWorkflowDatabase(getDatabase()),[]);assert.ok(row.purgeAfter);
}));
test('trashing a medication hides the course and its actual intakes without stopping it; restoring returns its full history',()=>fixture(()=>{
 const course=createMedicationCourse(manager,{memberId:'member',medicationName:'合成药品',startedAt:'2026-01-01',confirmed:true});const intake=createMedicationIntake(manager,{memberId:'member',courseId:course.id,takenAt:'2026-01-02',amount:'1'});
 const before=getMedicationCourse(manager,course.id);trashOther('medication',course.id,before.revision);assert.deepEqual(listMedications(manager,{memberId:'member'}),{courses:[],intakes:[]});status(()=>getMedicationCourse(manager,course.id),404);status(()=>getMedicationIntake(manager,intake.id),404);status(()=>healthRecordContext(manager,{kind:'intake',id:intake.id}),404);
 restoreOther('medication',course.id);const after=getMedicationCourse(manager,course.id);assert.equal(after.status,'active');assert.deepEqual(after.changes,before.changes);assert.equal(listMedications(manager,{memberId:'member'}).intakes[0].id,intake.id);
}));
test('intake recycling is the only removal path and restoration preserves its edit history',()=>fixture(()=>{
 const intake=createMedicationIntake(manager,{memberId:'member',medicationName:'合成单次药品',takenAt:'2026-01-02',amount:'1'});
 const before=getMedicationIntake(manager,intake.id);trashOther('intake',intake.id,intake.revision);assert.equal(listHealthTrash(manager,'member').items.length,1);restoreOther('intake',intake.id);
 const after=getMedicationIntake(manager,intake.id);assert.deepEqual(after.history,before.history);assert.equal(after.amount,before.amount);
}));

test('a trashed intake requires its course to be restored first; course purge preserves separately recoverable intakes',()=>fixture(()=>{
 const course=createMedicationCourse(manager,{memberId:'member',medicationName:'合成方案',startedAt:'2026-01-01',confirmed:true});const first=createMedicationIntake(manager,{memberId:'member',courseId:course.id,takenAt:'2026-01-02',amount:'1'});const retained=createMedicationIntake(manager,{memberId:'member',courseId:course.id,takenAt:'2026-01-03',amount:'2'});trashOther('intake',retained.id,retained.revision);const parent=trashOther('medication',course.id,course.revision);status(()=>restoreOther('intake',retained.id),409);
 mutateStandaloneTrash(manager,'medication',course.id,{revision:parent.revision},'purge');status(()=>getMedicationIntake(manager,first.id),404);restoreOther('intake',retained.id);assert.equal(getMedicationIntake(manager,retained.id).courseId,null);assert.deepEqual(validateHealthWorkflowDatabase(getDatabase()),[]);
}));
test('standalone operations enforce permissions and revisions and mixed trash includes all record kinds',()=>fixture(()=>{
 const symptom=createPublicSymptom(manager,{memberId:'member',name:'合成症状'});const course=createMedicationCourse(manager,{memberId:'member',medicationName:'合成方案',startedAt:'2026-01-01',confirmed:true});const intake=createMedicationIntake(manager,{memberId:'member',medicationName:'合成单次',takenAt:'2026-01-02',amount:'1'});
 for(const [kind,id,revision] of [['symptom',symptom.id,1],['medication',course.id,course.revision],['intake',intake.id,intake.revision]] as const){status(()=>mutateStandaloneTrash(viewer,kind,id,{revision},'trash'),403);status(()=>mutateStandaloneTrash(manager,kind,id,{revision:99},'trash'),409);const row=trashOther(kind,id,revision);status(()=>mutateStandaloneTrash(viewer,kind,id,{revision:row.revision},'restore'),403);}
 assert.deepEqual(listHealthTrash(manager,'member').items.map(row=>row.kind).sort(),['intake','medication','symptom']);
}));

test('expired standalone records are cleaned while legacy removals and revoked intakes remain intact',()=>fixture(()=>{
 const symptom=createPublicSymptom(manager,{memberId:'member',name:'合成旧移除'});getDatabase().prepare("UPDATE health_process_symptoms SET deleted_at='2000-01-01' WHERE id=?").run(symptom.id);const course=createMedicationCourse(manager,{memberId:'member',medicationName:'合成到期方案',startedAt:'2026-01-01',confirmed:true});trashOther('medication',course.id,course.revision);getDatabase().prepare("UPDATE medication_courses SET purge_after='2000-01-01' WHERE id=?").run(course.id);assert.equal(purgeExpiredStandaloneRecords().deleted,1);assert.equal(listHealthTrash(manager,'member').items[0].id,symptom.id);
}));

test('trashed vaccinations keep their original attached without recreating a pending card, and restore reuses it',()=>fixture(()=>{
 report('proof');const saved=createVaccination(manager,{...input,sourceReportId:'proof'});trash(saved.id);
 assert.equal(listHealthRecordFeed(manager,{memberId:'member',category:'vaccination'}).items.length,0);
 assert.equal(getDatabase().prepare('SELECT status FROM reports WHERE id=?').get('proof')!.status,'ready');
 restore(saved.id);const feed=listHealthRecordFeed(manager,{memberId:'member',category:'vaccination'}).items;
 assert.equal(feed.length,1);assert.equal(feed[0].resourceId,saved.id);assert.equal(feed[0].documents[0].id,'proof');
}));
test('purging the last linked vaccination moves its unused original into the report recycle bin',()=>fixture(()=>{
 report('proof');const first=createVaccination(manager,{...input,sourceReportId:'proof'});
 const second=createVaccination(manager,{...input,doseNumber:'2',sourceReportId:'proof'});
 const row=trash(first.id);permanentlyDeleteVaccination(manager,first.id,{revision:row.revision});
 assert.equal(getDatabase().prepare('SELECT status FROM reports WHERE id=?').get('proof')!.status,'ready');
 const next=trash(second.id);permanentlyDeleteVaccination(manager,second.id,{revision:next.revision});
 assert.equal(getDatabase().prepare('SELECT status FROM reports WHERE id=?').get('proof')!.status,'trashed');
 assert.equal(listHealthRecordFeed(manager,{memberId:'member',category:'vaccination'}).items.length,0);
 assert.ok(listHealthTrash(manager,'member').items.some(item=>item.kind==='report'&&item.id==='proof'));
}));
test('vaccination cleanup leaves originals used by other record categories active and rolls back if retiring an original fails',()=>fixture(()=>{
 report('normal');const db=getDatabase();db.prepare("UPDATE reports SET report_type='checkup' WHERE id='normal'").run();
 const other=createVaccination(manager,{...input,sourceReportId:'normal'});const row=trash(other.id);permanentlyDeleteVaccination(manager,other.id,{revision:row.revision});
 assert.equal(db.prepare("SELECT status FROM reports WHERE id='normal'").get()!.status,'ready');
 report('proof');const dose=createVaccination(manager,{...input,sourceReportId:'proof'});const retained=trash(dose.id);
 db.exec("CREATE TRIGGER reject_attachment_retirement BEFORE UPDATE ON reports WHEN NEW.id='proof' AND NEW.status='trashed' BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");
 assert.throws(()=>permanentlyDeleteVaccination(manager,dose.id,{revision:retained.revision}));
 assert.ok(db.prepare('SELECT deleted_at FROM health_vaccinations WHERE id=?').get(dose.id)!.deleted_at);
 assert.equal(db.prepare("SELECT status FROM reports WHERE id='proof'").get()!.status,'ready');
}));

test('expiry retains original evidence referenced by a medication and retires only an unused vaccination original',()=>fixture(()=>{
 report('shared');report('unused');
 const medication=createClinicalFact(manager,'shared','medication',{medicationName:'合成药品'});
 createMedicationCourse(manager,{memberId:'member',sourceMedicationId:medication.id,startedAt:'2026-01-01',confirmed:true});
 const shared=createVaccination(manager,{...input,sourceReportId:'shared'});const unused=createVaccination(manager,{...input,sourceReportId:'unused'});
 trash(shared.id);trash(unused.id);const db=getDatabase();db.prepare("UPDATE health_vaccinations SET purge_after='2000-01-01T00:00:00Z'").run();
 assert.equal(purgeExpiredVaccinations().deleted,2);
 assert.equal(db.prepare("SELECT status FROM reports WHERE id='shared'").get()!.status,'ready');
 assert.equal(db.prepare("SELECT status FROM reports WHERE id='unused'").get()!.status,'trashed');
}));
