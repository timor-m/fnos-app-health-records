import {mutateStandaloneTrash as removeRecordForTest} from '../services/health-record-trash.service';
import {linkProcessRecords,recordProcesses,getRecordProcess} from '../services/health-record-process.service';
import { getOverview } from '../services/health-overview.service';
import { createProcessSymptomUpdate } from '../services/symptom-episode.service';
import { createClinicalFact } from '../services/clinical-fact.service';
import { createPublicSymptom } from '../services/public-symptom.service';
import { organizeHealthDocuments } from '../services/health-document-organizer.service';
import { changeMedicationCourse} from '../services/medication.service';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDatabase, closeDatabaseForTests } from '../database/client';
import type { RequestUser } from '../domain/request-user';
import { healthCategories, reportCategory } from '../../shared/health-categories';
import { getReportDetail, updateReportFields, updateReminderStatus, createReminder } from '../services/records.service';
import { createVaccination, getVaccination, listVaccinations, updateVaccination, deleteVaccination } from '../services/vaccination.service';
import { listHealthRecordFeed } from '../services/health-record-feed.service';
import { createHealthEvent } from '../services/health-event.service';
import { createHealthEpisode } from '../services/health-episode.service';
import { createMedicationCourse, createMedicationIntake } from '../services/medication.service';
const manager:RequestUser={id:'manager',displayName:'合成账号',authenticated:true,provider:'development',isGatewayAdmin:true};
const viewer:RequestUser={...manager,id:'viewer',isGatewayAdmin:false};
const other:RequestUser={...viewer,id:'outsider'};
function fixture(run:()=>void){const previous=process.env.STORAGE_DIR;const dir=mkdtempSync(join(tmpdir(),'health-categories-'));process.env.STORAGE_DIR=dir;
 try{const db=getDatabase();for(const user of [manager,viewer,other])db.prepare('INSERT INTO users(id,display_name) VALUES(?,?)').run(user.id,'合成账号');
 for(const memberId of ['member','second']){db.prepare('INSERT INTO health_members(id,display_name,created_by) VALUES(?,?,?)').run(memberId,'合成成员',manager.id);db.prepare("INSERT INTO member_permissions(member_id,user_id,permission,granted_by) VALUES(?,?,'manager',?)").run(memberId,manager.id,manager.id);}
 db.prepare("INSERT INTO member_permissions(member_id,user_id,permission,granted_by) VALUES('member','viewer','viewer','manager')").run();run();
 }finally{closeDatabaseForTests();if(previous===undefined)delete process.env.STORAGE_DIR;else process.env.STORAGE_DIR=previous;rmSync(dir,{recursive:true,force:true});}}
function status(fn:()=>unknown,code:number){assert.throws(fn,(error:unknown)=>(error as {statusCode:number}).statusCode===code);}
function report(id:string,type:string,title=id,memberId='member'){getDatabase().prepare("INSERT INTO reports(id,member_id,created_by,title,report_type,status,report_issued_at) VALUES(?,?,'manager',?,?,'ready','2026-01-01')").run(id,memberId,title,type);}
const vaccine={memberId:'member',vaccineName:'合成疫苗',administeredAt:'2026-01-01',doseNumber:'1'};
test('public categories are exactly five; source document subtypes do not create extra categories',()=>{
 assert.deepEqual(healthCategories,['report','imaging','symptom','medication','vaccination']);
 for(const type of ['checkup','laboratory','pathology','functional','outpatient','inpatient','billing','other'])assert.equal(reportCategory(type),'report');
 assert.equal(reportCategory('imaging'),'imaging');assert.equal(reportCategory('prescription'),'medication');assert.equal(reportCategory('vaccination'),'vaccination');
});
test('correcting a source category preserves all omitted report metadata and only overrides the selected field',()=>fixture(()=>{
 report('type-only','laboratory','合成原有标题');
 getDatabase().prepare("UPDATE reports SET hospital_name_raw='合成原有机构',body_parts_json=?,summary='合成原有摘要' WHERE id='type-only'").run(JSON.stringify([{name:'合成部位'}]));
 const before=getReportDetail(manager,'type-only');
 updateReportFields(manager,'type-only',{reportType:'imaging',expectedSourceVersion:before.sourceVersion});
 const after=getReportDetail(manager,'type-only');
 for(const field of ['title','hospitalName','reportIssuedAt','summary','bodyParts'] as const)assert.deepEqual(after[field],before[field]);
 assert.equal(after.reportType,'imaging');assert.equal(after.sourceVersion,before.sourceVersion+1);
 status(()=>updateReportFields(manager,'type-only',{reportType:null,expectedSourceVersion:after.sourceVersion}),400);
 assert.equal(getReportDetail(manager,'type-only').reportType,'imaging');
}));
test('manual vaccination has ownership, future-date protection, revisions and atomic next-dose reminders',()=>fixture(()=>{
 const saved=createVaccination(manager,{...vaccine,nextDueAt:'2026-02-01',requestKey:'vaccination-test-create-001'});
 assert.equal(saved.sourceReportId,null);assert.ok(saved.reminderId);
 assert.equal(createVaccination(manager,{...vaccine,nextDueAt:'2026-02-01',requestKey:'vaccination-test-create-001'}).id,saved.id);
 assert.equal(getVaccination(viewer,saved.id).vaccineName,'合成疫苗');status(()=>getVaccination(other,saved.id),403);
 status(()=>createVaccination(viewer,vaccine),403);status(()=>createVaccination(manager,{...vaccine,administeredAt:'2099-01-01'}),400);
 status(()=>updateVaccination(manager,saved.id,{revision:99}),409);
 const updated=updateVaccination(manager,saved.id,{revision:saved.revision,nextDueAt:'2026-03-01'});
 assert.notEqual(updated.reminderId,saved.reminderId);assert.equal(getDatabase().prepare('SELECT status FROM reminders WHERE id=?').get(saved.reminderId!)?.status,'dismissed');
 deleteVaccination(manager,saved.id,{revision:updated.revision});status(()=>getVaccination(manager,saved.id),404);
 assert.equal(getDatabase().prepare('SELECT status FROM reminders WHERE id=?').get(updated.reminderId!)?.status,'dismissed');
}));
test('feed includes linked reports, groups only explicitly related same-category documents, and separates imaging',()=>fixture(()=>{
 report('lab','laboratory','合成检验');report('checkup','checkup','合成体检');report('image','imaging','合成影像');report('foreign','laboratory','其他成员','second');
 createHealthEvent(manager,{memberId:'member',eventType:'physical_exam',title:'合成一次体检',reportIds:['lab','checkup','image']});
 const page=listHealthRecordFeed(manager,{memberId:'member'});
 assert.equal(page.items.length,2);assert.deepEqual(page.items.map(item=>item.category).sort(),['imaging','report']);
 assert.equal(page.items.find(item=>item.category==='report')?.documents.length,2);
 assert.ok(page.items.every(item=>item.kind==='report'));assert.ok(!page.items.some(item=>item.documents.some(doc=>doc.id==='foreign')));
 assert.equal(listHealthRecordFeed(manager,{memberId:'member',category:'report',subtype:'laboratory'}).items.length,1);
 assert.equal(listHealthRecordFeed(manager,{memberId:'member',query:'合成影像'}).items[0].category,'imaging');
 status(()=>listHealthRecordFeed(other,{memberId:'member'}),403);status(()=>listHealthRecordFeed(manager,{memberId:'member',category:'event'}),400);
}));
test('symptom feed exposes actual symptoms and excludes empty monitoring folders',()=>fixture(()=>{
 createHealthEpisode(manager,{memberId:'member',episodeType:'symptom',title:'合成不适',startedAt:'2026-01-01',status:'active'});
 createHealthEpisode(manager,{memberId:'member',episodeType:'monitoring',title:'合成监测',status:'active'});
 const items=listHealthRecordFeed(manager,{memberId:'member',category:'symptom'}).items;
 assert.equal(items.length,1);assert.equal(items[0].kind,'symptom');assert.equal(items[0].title,'合成不适');assert.ok(items[0].symptomId);assert.ok(items[0].episodeId);
}));
test('all categories paginate and search on the server; cursors are bound to member and filter',()=>fixture(()=>{
 for(let index=0;index<9;index++)report(`lab-${index}`,'laboratory');report('image','imaging');createVaccination(manager,vaccine);
 const ids:string[]=[];let cursor:string|undefined;
 do{const page=listHealthRecordFeed(manager,{memberId:'member',limit:3,cursor});ids.push(...page.items.map(item=>item.id));cursor=page.nextCursor||undefined;}while(cursor);
 assert.equal(ids.length,11);assert.equal(new Set(ids).size,11);
 const page=listHealthRecordFeed(manager,{memberId:'member',limit:2});assert.ok(page.nextCursor);
 status(()=>listHealthRecordFeed(manager,{memberId:'second',cursor:page.nextCursor!}),400);
 status(()=>listHealthRecordFeed(manager,{memberId:'member',category:'report',cursor:page.nextCursor!}),400);
 assert.equal(listHealthRecordFeed(manager,{memberId:'member',query:'lab-0'}).items.length,1);
 assert.equal(listHealthRecordFeed(manager,{memberId:'member',query:'合成疫苗'}).items[0].category,'vaccination');
}));

test('next-dose confirmation completes its own reminder atomically and retraction restores it',()=>fixture(()=>{
 const first=createVaccination(manager,{...vaccine,nextDueAt:'2026-02-01'});
 const next=createVaccination(manager,{...vaccine,administeredAt:'2026-02-01',doseNumber:'2',completedReminderId:first.reminderId,nextDueAt:'2026-03-01'});
 assert.equal(next.completedReminderId,first.reminderId);
 status(()=>updateReminderStatus(manager,first.reminderId!,'pending'),409);
 status(()=>updateReminderStatus(manager,first.reminderId!,'completed',{dueAt:'2026-04-01'}),409);
 assert.equal(getDatabase().prepare('SELECT status FROM reminders WHERE id=?').get(first.reminderId!)?.status,'completed');
 status(()=>createVaccination(manager,{...vaccine,administeredAt:'2026-02-02',completedReminderId:first.reminderId}),409);
 status(()=>updateVaccination(manager,next.id,{revision:next.revision,administeredAt:'2025-12-31'}),400);
 status(()=>updateVaccination(manager,first.id,{revision:first.revision,administeredAt:'2026-02-02'}),400);
 status(()=>updateVaccination(manager,first.id,{revision:first.revision,nextDueAt:'2026-04-01'}),409);
 status(()=>deleteVaccination(manager,first.id,{revision:first.revision}),409);
 const renamed=updateVaccination(manager,first.id,{revision:first.revision,vaccineName:'合成疫苗更正'});
 assert.equal(renamed.reminderId,first.reminderId);
 assert.equal(getVaccination(manager,next.id).completedReminderId,renamed.reminderId);
 deleteVaccination(manager,next.id,{revision:next.revision});
 assert.equal(getDatabase().prepare('SELECT status FROM reminders WHERE id=?').get(first.reminderId!)?.status,'pending');
 assert.equal(getDatabase().prepare('SELECT status FROM reminders WHERE id=?').get(next.reminderId!)?.status,'dismissed');
}));

test('public symptom creation hides process scaffolding, is idempotent, and rejects foreign contexts',()=>fixture(()=>{
 const input={memberId:'member',name:'合成不适',startedAt:'2026-01-01',requestKey:'public-symptom-stable-001'};
 const saved=createPublicSymptom(manager,input);assert.equal(createPublicSymptom(manager,input).id,saved.id);
 assert.equal(listHealthRecordFeed(manager,{memberId:'member',category:'symptom'}).items[0].resourceId,saved.id);
 report('foreign-symptom-context','laboratory','Synthetic','second');
 status(()=>createPublicSymptom(manager,{memberId:'member',name:'不能串成员',relatedRecords:[{kind:'report',id:'foreign-symptom-context'}]}),403);
 status(()=>createPublicSymptom(viewer,input),403);
}));
test('document organization groups only on confirmation and links a single document directly to a process',()=>fixture(()=>{
 report('lab','laboratory');report('image','imaging');report('single','laboratory');

 const single=organizeHealthDocuments(manager,{memberId:'member',requestKey:'organize-single-stable-key',groups:[{reportIds:['single']}]});
 assert.equal(single.groups.length,0);assert.equal(getDatabase().prepare('SELECT COUNT(*) AS n FROM health_events').get()?.n,0);
 assert.equal(recordProcesses(manager,{kind:'report',id:'single'}).length,0);
 const process=linkProcessRecords(manager,{kind:'report',id:'single'},[{kind:'report',id:'lab'}])[0];assert.equal(getRecordProcess(manager,process.id).recordCount,2);
 const input={memberId:'member',requestKey:'organize-group-stable-key',groups:[{reportIds:['lab','image'],title:'合成同次体检'}]};
 organizeHealthDocuments(manager,input);organizeHealthDocuments(manager,input);assert.equal(getDatabase().prepare('SELECT COUNT(*) AS n FROM health_events').get()?.n,1);
 assert.deepEqual(listHealthRecordFeed(manager,{memberId:'member'}).items.map(item=>item.category).sort(),['imaging','report','report']);
 const before=getDatabase().prepare('SELECT COUNT(*) AS n FROM health_events').get()?.n;
 status(()=>organizeHealthDocuments(manager,{memberId:'member',requestKey:'organize-invalid-001',groups:[{reportIds:['lab','missing']}]}),404);
 assert.equal(getDatabase().prepare('SELECT COUNT(*) AS n FROM health_events').get()?.n,before);
}));
test('medication documents, courses and doses collapse once and use actual instants rather than ISO lexical order',()=>fixture(()=>{
 report('rx','prescription');
 const fact=createClinicalFact(manager,'rx','medication',{medicationName:'合成药品'});
 const course=createMedicationCourse(manager,{memberId:'member',sourceMedicationId:fact.id,medicationName:'合成药品',startedAt:'2026-01-01',confirmed:true});
 const first=createMedicationIntake(manager,{memberId:'member',courseId:course.id,takenAt:'2026-01-02T23:30:00+08:00',amount:'1',amountUnit:'片'});
 createMedicationIntake(manager,{memberId:'member',courseId:course.id,takenAt:'2026-01-02T16:00:00Z',amount:'1',amountUnit:'片'});
 const revoked=createMedicationIntake(manager,{memberId:'member',courseId:course.id,takenAt:'2026-02-01',amount:'1',amountUnit:'片'});removeRecordForTest(manager,'intake',revoked.id,{revision:revoked.revision},'trash');
 const items=listHealthRecordFeed(manager,{memberId:'member',category:'medication'}).items;
 assert.equal(items.length,1);assert.equal(items[0].kind,'medication_document');assert.equal(items[0].date,'2026-01-02T16:00:00Z');assert.equal(items[0].confirmedCount,1);assert.equal(items[0].activeCount,1);
 const courses=listHealthRecordFeed(manager,{memberId:'member',category:'medication',subtype:'course'}).items;
 assert.deepEqual(courses.map(item=>item.resourceId),[course.id]);assert.equal(courses[0].intakeCount,2);
 const doses=listHealthRecordFeed(manager,{memberId:'member',category:'medication',subtype:'intake'}).items;
 assert.equal(doses.length,2);assert.ok(doses.every(item=>item.kind==='intake'));assert.ok(!doses.some(item=>item.resourceId===revoked.id));
 const manual=createMedicationCourse(manager,{memberId:'member',medicationName:'独立合成药品',startedAt:'2026-01-01',confirmed:true});
 createMedicationIntake(manager,{memberId:'member',medicationName:'独立单次服药',takenAt:'2026-01-02T08:00',amount:'1'});
 const kinds=listHealthRecordFeed(manager,{memberId:'member',category:'medication'}).items.map(item=>item.kind).sort();assert.deepEqual(kinds,['intake','medication','medication_document']);
 assert.equal(getDatabase().prepare('SELECT amount FROM medication_intakes WHERE id=?').get(first.id)?.amount,'1');
}));
test('confirmed vaccination keeps a source snapshot, deduplicates its credential and rejects foreign evidence',()=>fixture(()=>{
 report('vax','vaccination');report('foreign-vax','vaccination','其他成员凭证','second');
 const fact=createClinicalFact(manager,'vax','vaccination',{vaccineName:'合成疫苗',administeredAt:'2026-01-01'});
 const saved=createVaccination(manager,{...vaccine,sourceReportId:'vax',sourceFactId:fact.id});
 assert.equal(listHealthRecordFeed(manager,{memberId:'member',category:'vaccination'}).items.length,1);
 assert.equal(listHealthRecordFeed(manager,{memberId:'member',category:'vaccination'}).items[0].kind,'vaccination');
 assert.equal(getReportDetail(manager,'vax').vaccinations.find(item=>item.id===fact.id)?.confirmedVaccinationId,saved.id);
 const reidentified=createClinicalFact(manager,'vax','vaccination',{vaccineName:vaccine.vaccineName,doseNumber:vaccine.doseNumber,administeredAt:vaccine.administeredAt});
 assert.equal(getReportDetail(manager,'vax').vaccinations.find(item=>item.id===reidentified.id)?.confirmedVaccinationId,saved.id);
 const uncertain=createClinicalFact(manager,'vax','vaccination',{vaccineName:vaccine.vaccineName,doseNumber:vaccine.doseNumber});
 assert.equal(getReportDetail(manager,'vax').vaccinations.find(item=>item.id===uncertain.id)?.confirmedVaccinationId,null);

 status(()=>createVaccination(manager,{...vaccine,sourceReportId:'vax',sourceFactId:fact.id}),409);
 status(()=>createVaccination(manager,{...vaccine,sourceReportId:'foreign-vax'}),400);
 deleteVaccination(manager,saved.id,{revision:saved.revision});assert.equal(listHealthRecordFeed(manager,{memberId:'member',category:'vaccination'}).items.length,0);
}));

test('a symptom with unknown onset sorts by its actual later observation rather than losing its date',()=>fixture(()=>{
 const symptom=createPublicSymptom(manager,{memberId:'member',name:'合成未知开始时间'});
 createProcessSymptomUpdate(manager,symptom.episodeId,symptom.id,{recordedAt:'2026-01-03T08:00',change:'unchanged'});
 assert.equal(listHealthRecordFeed(manager,{memberId:'member',category:'symptom'}).items[0].date,'2026-01-03T08:00');
}));

test('postponing a next-dose reminder updates its vaccination and revision together',()=>fixture(()=>{
 const first=createVaccination(manager,{...vaccine,nextDueAt:'2026-02-01'});
 updateReminderStatus(manager,first.reminderId!,'pending',{dueAt:'2026-02-10'});
 const updated=getVaccination(manager,first.id);assert.equal(updated.nextDueAt,'2026-02-10');assert.equal(updated.revision,first.revision+1);
 status(()=>updateVaccination(manager,first.id,{revision:first.revision,note:'过期编辑'}),409);
 status(()=>updateReminderStatus(manager,first.reminderId!,'pending',{dueAt:'2025-01-01'}),400);
 assert.equal(getVaccination(manager,first.id).nextDueAt,'2026-02-10');
}));

test('overview supports manual-only health records and uses the same five counts as the complete record list',()=>fixture(()=>{
 const symptom=createPublicSymptom(manager,{memberId:'member',name:'合成日常不适',startedAt:'2026-01-02'});
 const medication=createMedicationCourse(manager,{memberId:'member',medicationName:'合成手动用药',startedAt:'2026-01-03',confirmed:true});
 createVaccination(manager,vaccine);
 const overview=getOverview(manager,'member');
 assert.equal(overview.recordCount,3);assert.deepEqual(overview.categoryCounts,{report:0,imaging:0,symptom:1,medication:1,vaccination:1});
 assert.equal(overview.attention.symptoms[0].resourceId,symptom.id);assert.equal(overview.attention.medications[0].resourceId,medication.id);
 assert.equal(overview.pending.processingCount,0);assert.equal(overview.pending.reviewCount,0);assert.equal(overview.pending.failedCount,0);
 assert.deepEqual(overview.recentRecords,listHealthRecordFeed(manager,{memberId:'member'}).items);
 assert.deepEqual(getOverview(viewer,'member'),overview);status(()=>getOverview(other,'member'),403);
 createProcessSymptomUpdate(manager,symptom.episodeId,symptom.id,{recordedAt:'2026-01-04',change:'resolved'});
 changeMedicationCourse(manager,medication.id,{revision:medication.revision,action:'pause',occurredAt:'2026-01-04'});
 const later=getOverview(manager,'member');assert.equal(later.recordCount,3);assert.equal(later.attention.symptomCount,0);assert.equal(later.attention.medicationCount,0);assert.deepEqual(later.categoryCounts,overview.categoryCounts);
}));

test('overview counts grouped cards once, source-processing per document, and confirmed medications as actual courses',()=>fixture(()=>{
 report('checkup','checkup');report('lab','laboratory');report('image','imaging');report('rx','prescription');report('vax-proof','vaccination');report('foreign-private','laboratory','其他成员','second');
 createHealthEvent(manager,{memberId:'member',eventType:'physical_exam',title:'合成同次资料',reportIds:['checkup','lab','image']});
 const fact=createClinicalFact(manager,'rx','medication',{medicationName:'合成处方药'});
 createMedicationCourse(manager,{memberId:'member',sourceMedicationId:fact.id,medicationName:'合成处方药',startedAt:'2026-01-01',confirmed:true});
 createVaccination(manager,{...vaccine,sourceReportId:'vax-proof'});
 getDatabase().prepare("UPDATE reports SET status=CASE id WHEN 'checkup' THEN 'needs_review' WHEN 'lab' THEN 'failed' WHEN 'image' THEN 'uploading' WHEN 'vax-proof' THEN 'processing' ELSE status END").run();
 const overview=getOverview(manager,'member');assert.equal(overview.recordCount,4);assert.deepEqual(overview.categoryCounts,{report:1,imaging:1,symptom:0,medication:1,vaccination:1});
 assert.equal(overview.attention.medicationCount,1);assert.equal(overview.attention.medications[0].kind,'medication');
 assert.equal(overview.pending.failedCount,1);assert.equal(overview.pending.reviewCount,1);assert.equal(overview.pending.processingCount,2);
 assert.equal(overview.pending.documents.length,2);assert.equal(overview.pending.documents[0].resourceId,'lab');assert.ok(overview.recentRecords.every(item=>item.memberId==='member'));
 assert.equal(listHealthRecordFeed(manager,{memberId:'member',status:'needs_review'}).items.length,1);
 assert.equal(listHealthRecordFeed(manager,{memberId:'member',status:'processing'}).items.length,2);
}));

test('overview totals are not capped by record pagination or reminder previews, and exclude retracted or trashed content',()=>fixture(()=>{
 for(let index=0;index<107;index++)report(`many-${index}`,'laboratory');
 for(let index=0;index<7;index++)createReminder(manager,{memberId:'member',title:'合成提醒',dueAt:`2026-12-${String(index+1).padStart(2,'0')}`});
 const vaccineEntry=createVaccination(manager,vaccine);deleteVaccination(manager,vaccineEntry.id,{revision:vaccineEntry.revision});
 getDatabase().prepare("UPDATE reports SET status='trashed' WHERE id='many-0'").run();
 const overview=getOverview(manager,'member');assert.equal(overview.recordCount,106);assert.equal(overview.categoryCounts.report,106);assert.equal(overview.categoryCounts.vaccination,0);
 assert.equal(overview.recentRecords.length,5);assert.equal(overview.pending.reminderCount,7);assert.equal(overview.pending.reminders.length,3);
 const page=listHealthRecordFeed(manager,{memberId:'member',limit:2});assert.ok(page.nextCursor);status(()=>listHealthRecordFeed(manager,{memberId:'member',status:'failed',cursor:page.nextCursor!}),400);
 status(()=>listHealthRecordFeed(manager,{memberId:'member',status:'made-up'}),400);
}));

test('unified medication record filter includes courses and standalone doses without duplicate or lost history',()=>fixture(()=>{
 report('unified-rx','prescription');
 const fact=createClinicalFact(manager,'unified-rx','medication',{medicationName:'合成来源药品'});
 const linked=createMedicationCourse(manager,{memberId:'member',sourceMedicationId:fact.id,medicationName:'合成来源药品',startedAt:'2026-01-01',confirmed:true});
 const manual=createMedicationCourse(manager,{memberId:'member',medicationName:'合成手动药品',startedAt:'2026-01-02',confirmed:true});
 const attached=createMedicationIntake(manager,{memberId:'member',courseId:linked.id,takenAt:'2026-01-03T08:00',amount:'1'});
 const standalone=createMedicationIntake(manager,{memberId:'member',medicationName:'合成独立补充',takenAt:'2026-01-04T08:00',amount:'2'});
 const revoked=createMedicationIntake(manager,{memberId:'member',medicationName:'合成撤销补充',takenAt:'2026-01-05T08:00',amount:'1'});removeRecordForTest(manager,'intake',revoked.id,{revision:revoked.revision},'trash');
 createMedicationIntake(manager,{memberId:'second',medicationName:'其他成员补充',takenAt:'2026-01-06T08:00',amount:'1'});
 const filter={memberId:'member',category:'medication',subtype:'record'};
 const first=listHealthRecordFeed(manager,{...filter,limit:2});assert.ok(first.nextCursor);
 const second=listHealthRecordFeed(manager,{...filter,limit:2,cursor:first.nextCursor!});assert.equal(second.nextCursor,null);
 const items=[...first.items,...second.items];
 assert.deepEqual(items.map(item=>item.resourceId),[standalone.id,linked.id,manual.id]);
 assert.deepEqual(items.map(item=>item.kind),['intake','medication','medication']);
 assert.equal(items.find(item=>item.resourceId===linked.id)?.intakeCount,1);
 assert.deepEqual(listHealthRecordFeed(manager,{...filter,query:'合成独立补充'}).items.map(item=>item.resourceId),[standalone.id]);
 assert.equal(listHealthRecordFeed(manager,{...filter,subtype:'prescription'}).items[0].resourceId,'unified-rx');
 assert.equal(getDatabase().prepare('SELECT amount FROM medication_intakes WHERE id=?').get(attached.id)?.amount,'1');
 assert.equal(getDatabase().prepare('SELECT source_report_id AS source FROM medication_courses WHERE id=?').get(linked.id)?.source,'unified-rx');
}));

test('vaccination detail exposes current reminder state and next-dose links within its member scope',()=>fixture(()=>{
 const first=createVaccination(manager,{...vaccine,nextDueAt:'2026-02-01'});
 assert.equal(getVaccination(manager,first.id).reminderStatus,'pending');assert.equal(getVaccination(manager,first.id).nextVaccinationId,null);
 const next=createVaccination(manager,{...vaccine,administeredAt:'2026-02-01',doseNumber:'2',completedReminderId:first.reminderId});
 const completed=getVaccination(viewer,first.id);assert.equal(completed.reminderStatus,'completed');assert.equal(completed.nextVaccinationId,next.id);
 status(()=>getVaccination(other,first.id),403);
 deleteVaccination(manager,next.id,{revision:next.revision});assert.equal(getVaccination(manager,first.id).reminderStatus,'pending');assert.equal(getVaccination(manager,first.id).nextVaccinationId,null);
 updateReminderStatus(manager,first.reminderId!,'dismissed');assert.equal(getVaccination(manager,first.id).reminderStatus,'dismissed');
 updateReminderStatus(manager,first.reminderId!,'pending');assert.equal(getVaccination(manager,first.id).reminderStatus,'pending');
}));


test('credential records expose reminder links and editing a canceled reminder preserves its state',()=>fixture(()=>{
 const first=createVaccination(manager,{...vaccine,nextDueAt:'2026-02-01'});
 updateReminderStatus(manager,first.reminderId!,'dismissed');
 const edited=updateVaccination(manager,first.id,{revision:first.revision,vaccineName:'合成校对疫苗'});
 assert.equal(edited.reminderId,first.reminderId);assert.equal(edited.reminderStatus,'dismissed');
 assert.equal(getDatabase().prepare('SELECT title FROM reminders WHERE id=?').get(first.reminderId)?.title,'下一剂接种：合成校对疫苗');
 assert.equal(listVaccinations(viewer,'member')[0].reminderStatus,'dismissed');
 const moved=updateVaccination(manager,first.id,{revision:edited.revision,nextDueAt:'2026-02-02'});
 assert.equal(moved.reminderStatus,'pending');
 const next=createVaccination(manager,{...vaccine,administeredAt:'2026-02-02',completedReminderId:moved.reminderId});
 const listed=listVaccinations(viewer,'member').find(item=>item.id===first.id)!;
 assert.equal(listed.reminderStatus,'completed');assert.equal(listed.nextVaccinationId,next.id);
 status(()=>listVaccinations(other,'member'),403);
}));

test('vaccination feed exposes dose and note separately without changing source deduplication or search',()=>fixture(()=>{
 report('vaccine-proof','vaccination');
 const saved=createVaccination(manager,{...vaccine,doseNumber:'加强针',note:'合成备注',organizationName:'合成接种点',sourceReportId:'vaccine-proof'});
 const page=listHealthRecordFeed(manager,{memberId:'member',category:'vaccination',subtype:'administered'});
 assert.equal(page.items.length,1);assert.equal(page.items[0].resourceId,saved.id);
 assert.equal(page.items[0].doseNumber,'加强针');assert.equal(page.items[0].note,'合成备注');assert.equal(page.items[0].institution,'合成接种点');
 assert.equal(page.items[0].documents[0].id,'vaccine-proof');
 assert.equal(listHealthRecordFeed(manager,{memberId:'member',query:'加强针'}).items[0].resourceId,saved.id);
 assert.equal(listHealthRecordFeed(manager,{memberId:'member',query:'合成备注'}).items[0].resourceId,saved.id);
}));
