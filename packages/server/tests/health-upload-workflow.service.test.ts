import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {getDatabase,closeDatabaseForTests} from '../database/client';
import type {RequestUser} from '../domain/request-user';
import {createUpload,createUploadFromLocalFiles} from '../services/upload.service';
import {startStagedUpload,storeStagedFile,completeStagedUpload} from '../services/staged-upload.service';
import {archiveUploadWorkflow,listUploadWorkflow,previewUploadWorkflow} from '../services/health-upload-workflow.service';
import {getHealthEvent} from '../services/health-event.service';

const manager:RequestUser={id:'workflow-manager',displayName:'Synthetic',provider:'development',authenticated:true,isGatewayAdmin:true};
const viewer:RequestUser={...manager,id:'workflow-viewer',isGatewayAdmin:false};
const bytes=Uint8Array.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,1]);
const files=[{originalName:'synthetic.png',data:bytes}];
function setup(){
  const directory=mkdtempSync(join(tmpdir(),'health-upload-workflow-'));process.env.STORAGE_DIR=directory;
  const db=getDatabase();
  for(const user of [manager,viewer])db.prepare('INSERT INTO users(id,display_name) VALUES(?,?)').run(user.id,user.displayName);
  for(const memberId of ['member-a','member-b']){
    db.prepare("INSERT INTO health_members(id,display_name,relationship,created_by) VALUES(?,?,'self',?)").run(memberId,'Synthetic',manager.id);
    db.prepare("INSERT INTO member_permissions(member_id,user_id,permission,granted_by) VALUES(?,?,'manager',?)").run(memberId,manager.id,manager.id);
  }
  db.prepare("INSERT INTO member_permissions(member_id,user_id,permission,granted_by) VALUES('member-a',?,'viewer',?)").run(viewer.id,manager.id);
  db.prepare("INSERT INTO health_episodes(id,member_id,episode_type,title,created_by) VALUES('episode-a','member-a','symptom','Synthetic',?)").run(manager.id);
  return {db,directory,cleanup(){closeDatabaseForTests();delete process.env.STORAGE_DIR;rmSync(directory,{recursive:true,force:true});}};
}
function status(fn:()=>unknown,code:number){assert.throws(fn,(e:unknown)=>(e as {statusCode:number}).statusCode===code);}

test('direct, staged and local uploads link actual records and retry without duplicate records',()=>{
 const {db,directory,cleanup}=setup();try{
  db.exec("INSERT INTO reports(id,member_id,created_by,title,report_type,status) VALUES('anchor','member-a','workflow-manager','Synthetic','laboratory','ready'),('foreign','member-b','workflow-manager','Synthetic','laboratory','ready');INSERT INTO health_upload_items(report_id,state) VALUES('anchor','skipped')");
  const context={relatedRecord:{kind:'report' as const,id:'anchor'}};
  const direct=createUpload(manager,'member-a',files,'direct-workflow-key1',context);
  assert.equal(createUpload(manager,'member-a',files,'direct-workflow-key1',context).reportId,direct.reportId);
  status(()=>createUpload(manager,'member-a',files,'direct-workflow-key1',{}),409);
  startStagedUpload(manager,'staged-workflow-key1',{memberId:'member-a',context,files:[{originalName:'synthetic.png',size:bytes.length,rotation:0}]});
  storeStagedFile(manager,'staged-workflow-key1',0,bytes);
  const staged=completeStagedUpload(manager,'staged-workflow-key1');assert.equal(completeStagedUpload(manager,'staged-workflow-key1').reportId,staged.reportId);
  const path=join(directory,'source.png');writeFileSync(path,bytes);
  const local=createUploadFromLocalFiles(manager,'member-a',[{originalName:'synthetic.png',sourcePath:path}],'local-workflow-key1',context);
  assert.equal(createUploadFromLocalFiles(manager,'member-a',[{originalName:'synthetic.png',sourcePath:path}],'local-workflow-key1',context).reportId,local.reportId);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM health_record_links').get()!.n,3);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM health_events').get()!.n,0);
  status(()=>createUpload(manager,'member-a',files,undefined,{relatedRecord:{kind:'report',id:'foreign'}}),403);
  status(()=>createUpload(viewer,'member-a',files,undefined,context),403);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM reports').get()!.n,5);
 }finally{cleanup();}
});

test('document confirmation groups selected reports, preserves failures and skips independent reports',()=>{
 const {db,cleanup}=setup();try{
  const reports=Array.from({length:4},()=>createUpload(manager,'member-a',files));
  db.prepare("UPDATE reports SET status='failed',report_issued_at='2026-10-01'").run();
  const preview=previewUploadWorkflow(manager,'member-a',reports.map(r=>r.reportId));assert.equal(preview.reports.length,4);
  for(const key of ['events','episodes','groupSuggestions'])assert.equal(Object.hasOwn(preview,key),false);
  assert.ok(preview.reports.every(report=>!Object.hasOwn(report,'context')));
  const body={memberId:'member-a',requestKey:'archive-workflow-key1',groups:[{reportIds:reports.slice(0,2).map(r=>r.reportId),event:{eventType:'outpatient',title:'Synthetic'}}],skipReportIds:reports.slice(2).map(r=>r.reportId)};
  const archived=archiveUploadWorkflow(manager,body);assert.deepEqual(archiveUploadWorkflow(manager,body),archived);
  assert.equal(getHealthEvent(manager,archived.events[0].eventId).resources.length,2);assert.equal(listUploadWorkflow(manager,'member-a').reports.length,0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM reports').get()!.n,4);
  status(()=>archiveUploadWorkflow(manager,{...body,requestKey:'another-request-key1'}),409);
  status(()=>archiveUploadWorkflow(manager,{...body,skipReportIds:[]}),409);status(()=>archiveUploadWorkflow(viewer,body),403);
 }finally{cleanup();}
});

test('late grouping failure rolls back every group while actual uploaded follow-up already completes its reminder',()=>{
 const {db,cleanup}=setup();try{
  db.prepare("INSERT INTO reminders(id,member_id,title,due_at,created_by) VALUES('reminder-a','member-a','Synthetic','2026-11-01',?)").run(manager.id);
  const first=createUpload(manager,'member-a',files,undefined,{reminderId:'reminder-a'});const second=createUpload(manager,'member-a',files);
  assert.equal(db.prepare("SELECT status FROM reminders WHERE id='reminder-a'").get()!.status,'completed');
  status(()=>archiveUploadWorkflow(manager,{memberId:'member-a',requestKey:'archive-failure-key1',groups:[{reportIds:[first.reportId],event:{eventType:'outpatient'}},{reportIds:[second.reportId],event:{eventType:'bad-type'}}]}),400);
  for(const table of ['health_events','health_event_resources','health_upload_archives'])assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n,0);
  const body={memberId:'member-a',requestKey:'archive-success-key1',groups:[{reportIds:[first.reportId,second.reportId],event:{eventType:'outpatient'}}]};
  const archived=archiveUploadWorkflow(manager,body);assert.deepEqual(archiveUploadWorkflow(manager,body),archived);
  assert.equal(db.prepare("SELECT status FROM reminders WHERE id='reminder-a'").get()!.status,'completed');
 }finally{cleanup();}
});

test('pending pagination includes historical reports without inventing events and preserves skip across reload',()=>{
 const {db,cleanup}=setup();try{
  for(let i=0;i<105;i++)db.prepare("INSERT INTO reports(id,member_id,created_by,title,report_type,status) VALUES(?,'member-a',?,'Synthetic','other','ready')").run(`history-${String(i).padStart(3,'0')}`,manager.id);
  const first=listUploadWorkflow(manager,'member-a');assert.equal(first.reports.length,100);assert.ok(first.nextCursor);
  const second=listUploadWorkflow(manager,'member-a',first.nextCursor!);assert.equal(second.reports.length,5);
  assert.equal(new Set([...first.reports,...second.reports].map(r=>r.id)).size,105);
  archiveUploadWorkflow(manager,{memberId:'member-a',requestKey:'skip-historical-key1',groups:[],skipReportIds:first.reports.map(r=>r.id)});
  assert.equal(listUploadWorkflow(manager,'member-a').reports.length,5);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM health_events').get()!.n,0);
 }finally{cleanup();}
});

for(const change of ['deleted-event','moved-report','merged-report','detached-report'] as const) test(`archive replay rejects stale ${change} without returning old identifiers`,()=>{
 const {db,cleanup}=setup();try{
  const report=createUpload(manager,'member-a',files);
  const body={memberId:'member-a',requestKey:'lifecycle-receipt-key',groups:[{reportIds:[report.reportId],event:{eventType:'outpatient'}}]};
  const saved=archiveUploadWorkflow(manager,body);const eventId=saved.events[0].eventId;
  if(change==='deleted-event') db.prepare('UPDATE health_events SET deleted_at=CURRENT_TIMESTAMP WHERE id=?').run(eventId);
  if(change==='moved-report'){
    db.prepare("DELETE FROM health_event_resources WHERE resource_type='report' AND resource_id=?").run(report.reportId);
    db.prepare("UPDATE reports SET member_id='member-b' WHERE id=?").run(report.reportId);
  }
  if(change==='merged-report')db.prepare("UPDATE reports SET status='trashed' WHERE id=?").run(report.reportId);
  if(change==='detached-report')db.prepare("DELETE FROM health_event_resources WHERE resource_type='report' AND resource_id=?").run(report.reportId);
  assert.throws(()=>archiveUploadWorkflow(manager,body),(error:unknown)=>{
    const value=error as {statusCode:number;message:string};assert.equal(value.statusCode,409);
    assert.ok(!value.message.includes(report.reportId)&&!value.message.includes(eventId));return true;
  });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM health_events').get()!.n,1);
 }finally{cleanup();}
});

test('group draft dates follow the report display fallback order',()=>{
 const {db,cleanup}=setup();try{
  const report=createUpload(manager,'member-a',files);
  db.prepare("UPDATE reports SET report_type='laboratory' WHERE id=?").run(report.reportId);
  assert.equal(previewUploadWorkflow(manager,'member-a',[report.reportId]).reports[0].draft.eventType,'laboratory_exam');
  const dateFields=['ordered_at','sampled_at','examined_at','received_at','reviewed_at','report_issued_at'];
  for(const [index,field] of dateFields.entries()){
    const date=`2026-10-${String(index+1).padStart(2,'0')}`;
    db.prepare(`UPDATE reports SET ${field}=? WHERE id=?`).run(date,report.reportId);
    const preview=previewUploadWorkflow(manager,'member-a',[report.reportId]);
    assert.equal(preview.reports[0].draft.startedAt,date);
  }
 }finally{cleanup();}
});

test('upload replay rejects a report whose ownership changed after its original save',()=>{
 const {db,cleanup}=setup();try{
  const report=createUpload(manager,'member-a',files,'upload-moved-receipt');
  db.prepare("UPDATE reports SET member_id='member-b' WHERE id=?").run(report.reportId);
  status(()=>createUpload(manager,'member-a',files,'upload-moved-receipt'),409);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM reports').get()!.n,1);
 }finally{cleanup();}
});

test('unscoped medication documents do not fill the pending queue and remain explicitly previewable or linkable',()=>{
 const {db,cleanup}=setup();try{
  const insert=db.prepare("INSERT INTO reports(id,member_id,created_by,title,report_type,status) VALUES(?,'member-a',?,'Synthetic',?,'ready')");
  for(let index=0;index<105;index++)insert.run(`rx-${String(index).padStart(3,'0')}`,manager.id,'prescription');
  db.prepare("INSERT INTO health_upload_items(report_id,state,context_json) VALUES('rx-000','pending','{}'),('rx-001','pending','')").run();
  insert.run('ordinary-report',manager.id,'laboratory');
  const before=db.prepare('SELECT * FROM health_upload_items ORDER BY report_id').all();
  const pending=listUploadWorkflow(manager,'member-a');
  assert.deepEqual(pending.reports.map(report=>report.id),['ordinary-report']);assert.equal(pending.nextCursor,null);
  assert.deepEqual(db.prepare('SELECT * FROM health_upload_items ORDER BY report_id').all(),before);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM health_events').get()!.n,0);
  const preview=previewUploadWorkflow(manager,'member-a',['rx-000','rx-002']);
  assert.deepEqual(preview.reports.map(report=>report.reportType),['prescription','prescription']);
  assert.ok(preview.reports.every(report=>report.state==='pending'&&report.eventId===null));
  const result=archiveUploadWorkflow(manager,{memberId:'member-a',requestKey:'explicit-rx-link-request',groups:[{reportIds:['rx-000','rx-002'],event:{eventType:'outpatient'}}]});
  assert.equal(getHealthEvent(manager,result.events[0].eventId).resources.length,2);
 }finally{cleanup();}
});

test('each explicit upload context keeps prescription documents in encounter review while reclassification stays reversible',()=>{
 const {db,cleanup}=setup();try{
  const keys=['processId','reminderId','relatedRecord'];
  for(const key of keys){
   const id=`context-${key}`;
   db.prepare("INSERT INTO reports(id,member_id,created_by,title,report_type,status) VALUES(?,'member-a',?,'Synthetic','prescription','ready')").run(id,manager.id);
   db.prepare("INSERT INTO health_upload_items(report_id,state,context_json) VALUES(?,'pending',?)").run(id,JSON.stringify({[key]:key==='relatedRecord'?{kind:'report',id:'anchor'}:'synthetic-context'}));
  }
  const report=createUpload(manager,'member-a',files);
  assert.equal(listUploadWorkflow(manager,'member-a').reports.length,4);
  db.prepare("UPDATE reports SET report_type='prescription',status='ready' WHERE id=?").run(report.reportId);
  assert.deepEqual(listUploadWorkflow(manager,'member-a').reports.map(row=>row.id).sort(),keys.map(key=>`context-${key}`).sort());
  assert.equal(previewUploadWorkflow(manager,'member-a',[report.reportId]).reports[0].reportType,'prescription');
  assert.equal(db.prepare('SELECT state FROM health_upload_items WHERE report_id=?').get(report.reportId)!.state,'pending');
  db.prepare("UPDATE reports SET report_type='laboratory' WHERE id=?").run(report.reportId);
  assert.equal(listUploadWorkflow(manager,'member-a').reports.length,4);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM health_events').get()!.n,0);
 }finally{cleanup();}
});
