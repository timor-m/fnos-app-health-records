import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {closeDatabaseForTests,getDatabase,runInTransaction} from '../database/client';
import type {RequestUser} from '../domain/request-user';
import {createReminder,listReminders,updateReminderStatus} from '../services/records.service';
import {registerUploadedReport,validateUploadContext} from '../services/health-upload-workflow.service';
import {completeReminderWithExistingReport} from '../services/health-process-reminder.service';
import {getRecordProcess,linkProcessRecords,recordProcesses} from '../services/health-record-process.service';
const user:RequestUser={id:'manager',displayName:'Synthetic',provider:'development',authenticated:true,isGatewayAdmin:true};
async function fixture(run:()=>unknown){
 const previous=process.env.STORAGE_DIR;const directory=mkdtempSync(join(tmpdir(),'record-followup-'));process.env.STORAGE_DIR=directory;
 try{const db=getDatabase();db.exec("INSERT INTO users(id,display_name) VALUES('manager','Synthetic');INSERT INTO health_members(id,display_name,created_by) VALUES('member','Synthetic','manager'),('other','Synthetic','manager');INSERT INTO member_permissions(member_id,user_id,permission,granted_by) VALUES('member','manager','manager','manager'),('other','manager','manager','manager')");
 for(const id of ['source','existing','first','second','manual','foreign'])db.prepare("INSERT INTO reports(id,member_id,created_by,title,report_type,status) VALUES(?,?,'manager','Synthetic','laboratory','ready')").run(id,id==='foreign'?'other':'member');await run();
 }finally{closeDatabaseForTests();if(previous===undefined)delete process.env.STORAGE_DIR;else process.env.STORAGE_DIR=previous;rmSync(directory,{recursive:true,force:true});}
}
test('follow-up uploads join actual source records and complete without creating intermediate events',()=>fixture(()=>{
 const process=linkProcessRecords(user,{kind:'report',id:'source'},[{kind:'report',id:'existing'}])[0];
 const reminder=createReminder(user,{memberId:'member',title:'Synthetic',dueAt:'2026-11-01',relatedRecord:{kind:'report',id:'source'}});
 assert.equal(listReminders(user,'member')[0].status,'pending');
 for(const id of ['first','second'])runInTransaction(getDatabase(),()=>registerUploadedReport(user,'member',id,{reminderId:reminder.id}));
 const saved=listReminders(user,'member')[0];assert.equal(saved.status,'completed');assert.deepEqual(saved.completedRecord,{kind:'report',id:'first'});
 const detail=getRecordProcess(user,process.id);assert.equal(detail.recordCount,4);assert.deepEqual(detail.records.filter(r=>r.stage==='followup').map(r=>r.ref.id).sort(),['first','second']);
 assert.equal(getDatabase().prepare('SELECT COUNT(*) AS n FROM health_events').get()!.n,0);
 for(const key of ['sourceEventId','completedEventId','episodeId'])assert.equal(Object.hasOwn(saved,key),false);
}));
test('0.2.15 report reminders use their report anchor and unscoped manual reminders still complete',()=>fixture(()=>{
 const reportReminder=createReminder(user,{memberId:'member',reportId:'source',title:'Synthetic',dueAt:'2026-11-01'});
 registerUploadedReport(user,'member','first',{reminderId:reportReminder.id});assert.equal(recordProcesses(user,{kind:'report',id:'source'})[0].recordCount,2);
 const manual=createReminder(user,{memberId:'member',title:'Synthetic',dueAt:'2026-11-01'});
 registerUploadedReport(user,'member','manual',{reminderId:manual.id});assert.equal(listReminders(user,'member').find(r=>r.id===manual.id)!.status,'completed');
 assert.deepEqual(recordProcesses(user,{kind:'report',id:'manual'}),[]);
}));
test('upload reminder scope, status and source conflict are validated before linking',()=>fixture(()=>{
 const reminder=createReminder(user,{memberId:'member',title:'Synthetic',dueAt:'2026-11-01',relatedRecord:{kind:'report',id:'source'}});
 const invalid=(member:string,input:unknown,status:number)=>assert.throws(()=>validateUploadContext(user,member,input),e=>(e as {statusCode:number}).statusCode===status);
 invalid('other',{reminderId:reminder.id},400);invalid('member',{reminderId:'missing'},400);
 invalid('member',{reminderId:reminder.id,relatedRecord:{kind:'report',id:'existing'}},409);
 getDatabase().prepare("UPDATE reports SET report_type='prescription' WHERE id='source'").run();
 assert.deepEqual(validateUploadContext(user,'member',{reminderId:reminder.id,relatedRecord:{kind:'medication_document',id:'source'}}).relatedRecord,{kind:'medication_document',id:'source'});
 const sourceProcess=linkProcessRecords(user,{kind:'report',id:'source'},[{kind:'report',id:'existing'}])[0];
 const otherProcess=linkProcessRecords(user,{kind:'report',id:'first'},[{kind:'report',id:'second'}])[0];
 invalid('member',{reminderId:reminder.id,processId:otherProcess.id},409);
 assert.equal(validateUploadContext(user,'member',{reminderId:reminder.id,processId:sourceProcess.id}).processId,sourceProcess.id);
 updateReminderStatus(user,reminder.id,'dismissed');invalid('member',{reminderId:reminder.id},409);
 assert.equal(getDatabase().prepare('SELECT COUNT(*) AS n FROM health_record_links').get()!.n,2);
}));

test('an existing report completes a scoped reminder atomically, retains the original and retries after process merge',()=>fixture(()=>{
 const process=linkProcessRecords(user,{kind:'report',id:'source'},[{kind:'report',id:'existing'}])[0];
 linkProcessRecords(user,{kind:'report',id:'first'},[{kind:'report',id:'second'}]);
 const current=getRecordProcess(user,process.id);const reminder=createReminder(user,{memberId:'member',title:'Synthetic',dueAt:'2026-11-01',relatedRecord:{kind:'report',id:'source'}});
 const input={memberId:'member',record:{kind:'report',id:'first'},processId:process.id,fingerprint:current.fingerprint,editToken:current.editToken,requestKey:'followup-existing-key-001'};
 const result=completeReminderWithExistingReport(user,reminder.id,input);assert.equal(result.status,'completed');assert.equal(result.completedRecord.id,'first');assert.ok(result.processId);
 assert.equal(getRecordProcess(user,result.processId!).records.find(r=>r.ref.id==='first')!.stage,'followup');assert.equal(getDatabase().prepare("SELECT status FROM reports WHERE id='first'").get()!.status,'ready');
 assert.deepEqual(completeReminderWithExistingReport(user,reminder.id,input),result);
 assert.equal(getDatabase().prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action='reminder.status' AND target_id=?").get(reminder.id)!.n,1);
 assert.throws(()=>completeReminderWithExistingReport(user,reminder.id,{...input,record:{kind:'report',id:'second'},requestKey:'followup-existing-key-002'}));
}));
test('existing follow-up reports reject foreign members, source reuse, stale context, ignored plans and non-report types without mutating the plan',()=>fixture(()=>{
 const process=linkProcessRecords(user,{kind:'report',id:'source'},[{kind:'report',id:'existing'}])[0];const current=getRecordProcess(user,process.id);
 const reminder=createReminder(user,{memberId:'member',title:'Synthetic',dueAt:'2026-11-01',relatedRecord:{kind:'report',id:'source'}});
 const input={memberId:'member',record:{kind:'report',id:'first'},processId:process.id,fingerprint:current.fingerprint,editToken:current.editToken};
 for(const invalid of [{...input,memberId:'other'},{...input,record:{kind:'report',id:'foreign'}},{...input,record:{kind:'report',id:'source'}},{...input,fingerprint:'stale'},{...input,editToken:'stale'}])assert.throws(()=>completeReminderWithExistingReport(user,reminder.id,invalid));
 getDatabase().prepare("UPDATE reports SET report_type='prescription' WHERE id='first'").run();assert.throws(()=>completeReminderWithExistingReport(user,reminder.id,input));
 assert.equal(listReminders(user,'member')[0].status,'pending');assert.equal(getRecordProcess(user,process.id).recordCount,2);
 const viewer={...user,id:'viewer',isGatewayAdmin:false};getDatabase().exec("INSERT INTO users(id,display_name) VALUES('viewer','Synthetic');INSERT INTO member_permissions(member_id,user_id,permission,granted_by) VALUES('member','viewer','viewer','manager')");assert.throws(()=>completeReminderWithExistingReport(viewer,reminder.id,input),e=>(e as {statusCode:number}).statusCode===403);
 updateReminderStatus(user,reminder.id,'dismissed');assert.throws(()=>completeReminderWithExistingReport(user,reminder.id,input));
}));
test('manual completion can acquire an existing report; a restored pending plan invalidates an old completion receipt',()=>fixture(()=>{
 const reminder=createReminder(user,{memberId:'member',title:'Synthetic',dueAt:'2026-11-01'});updateReminderStatus(user,reminder.id,'completed');
 const input={memberId:'member',record:{kind:'report',id:'first'},requestKey:'followup-manual-key-001'};
 const result=completeReminderWithExistingReport(user,reminder.id,input);assert.equal(result.completedRecord.id,'first');assert.equal(result.processId,null);
 updateReminderStatus(user,reminder.id,'pending');assert.throws(()=>completeReminderWithExistingReport(user,reminder.id,input));
}));

test('HTTP existing report completion validates payloads and returns the real associated process',()=>fixture(async()=>{
 const {H3}=await import('h3');const {default:route}=await import('../routes/api/reminders/[id]/complete-record.post');const app=new H3();app.use(event=>{event.context.requestUser=user;});app.post('/api/reminders/:id/complete-record',route);
 const process=linkProcessRecords(user,{kind:'report',id:'source'},[{kind:'report',id:'existing'}])[0];const current=getRecordProcess(user,process.id);const reminder=createReminder(user,{memberId:'member',title:'Synthetic',dueAt:'2026-11-01',relatedRecord:{kind:'report',id:'source'}});
 const response=await app.request('http://localhost/api/reminders/'+reminder.id+'/complete-record',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({memberId:'member',record:{kind:'report',id:'first'},processId:process.id,fingerprint:current.fingerprint,editToken:current.editToken,requestKey:'http-followup-key-001'})});assert.equal(response.status,200);const saved=(await response.json()).data;assert.equal(saved.completedRecord.id,'first');assert.equal(saved.processId,process.id);
 const invalid=await app.request('http://localhost/api/reminders/'+reminder.id+'/complete-record',{method:'POST',headers:{'Content-Type':'application/json'},body:'[]'});assert.equal(invalid.status,400);
}));
