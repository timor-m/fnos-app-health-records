import assert from 'node:assert/strict';
import test from 'node:test';
import {H3} from 'h3';
import cleanupRoute from '../routes/api/reports/trash-cleanup.get';
import errorHandler from '../error-handler';
import {runMaintenanceCycle} from '../services/maintenance-runner.service';
import fs, {mkdtempSync,rmSync,mkdirSync,writeFileSync,existsSync,readdirSync,symlinkSync} from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {getDatabase,closeDatabaseForTests} from '../database/client';
import {enqueueFileGarbage,runFileGarbageCollection} from '../services/file-gc.service';
import {getTrashCleanupSummary} from '../services/trash-cleanup.service';
import {listReports,permanentlyDeleteReport,purgeExpiredReports} from '../services/records.service';
import {cleanupSchedule,scheduleMaintenance,getMaintenanceState,maintenanceTick,maintenanceFailed,maintenanceGcFinished} from '../utils/maintenance-state';
import type {RequestUser} from '../domain/request-user';
const manager:RequestUser={id:'u',displayName:'测试账号',authenticated:true,provider:'fnos_gateway',isGatewayAdmin:false};
async function fixture(run:(dir:string)=>void|Promise<void>) {
 const env={...process.env};const dir=mkdtempSync(join(tmpdir(),'trash-cleanup-'));process.env.STORAGE_DIR=dir;process.env.AUTH_MODE='fnos';process.env.GATEWAY_PREFIX='/';
 try {const db=getDatabase();db.exec("INSERT INTO users(id,display_name) VALUES('u','fixture'),('v','fixture'); INSERT INTO health_members(id,display_name,relationship,created_by) VALUES('m','fixture','other','u'),('n','fixture','other','u'); INSERT INTO member_permissions(member_id,user_id,permission,granted_by) VALUES('m','u','manager','u'),('n','u','manager','u'),('m','v','viewer','u')");await run(dir);}
 finally{closeDatabaseForTests();process.env=env;rmSync(dir,{recursive:true,force:true});}
}
function report(id='r',member='m') {getDatabase().prepare("INSERT INTO reports(id,member_id,created_by,report_type,title,status,deleted_at,purge_after) VALUES(?,?,'u','exam','fixture','trashed','2026-09-21 06:30:00','2026-10-21 06:30:00')").run(id,member);}
function due() {getDatabase().exec("UPDATE file_gc_queue SET not_before=datetime('now','-1 minute') WHERE completed_at IS NULL");}

test('trash timestamps are UTC and nullable; manual/automatic purge associates originals and rollback is atomic',()=>fixture(dir=>{
 const db=getDatabase();report();
 db.exec("INSERT INTO report_pages(id,report_id,page_number,storage_path,original_name,mime_type,file_size,sha256) VALUES('p','r',1,'reports/fixture.pdf','fixture.pdf','application/pdf',7,'test')");
 const row=listReports(manager,30,{memberId:'m',trash:true}).items[0];
 assert.equal(row.deletedAt,'2026-09-21T06:30:00.000Z');assert.equal(row.purgeAfter,'2026-10-21T06:30:00.000Z');
 db.exec("CREATE TRIGGER fail_gc_member BEFORE INSERT ON file_gc_members BEGIN SELECT RAISE(ABORT,'fixture'); END");
 assert.throws(()=>permanentlyDeleteReport(manager,'r'));assert.ok(db.prepare("SELECT 1 FROM reports WHERE id='r'").get());assert.equal(db.prepare('SELECT COUNT(*) AS n FROM file_gc_queue').get()!.n,0);
 db.exec('DROP TRIGGER fail_gc_member');
 db.exec("CREATE TRIGGER fail_enqueue BEFORE INSERT ON file_gc_queue BEGIN SELECT RAISE(ABORT,'fixture'); END");
 assert.throws(()=>permanentlyDeleteReport(manager,'r'));assert.ok(db.prepare("SELECT 1 FROM reports WHERE id='r'").get());
 assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action='report.purge'").get()!.n,0);
 db.exec('DROP TRIGGER fail_enqueue');mkdirSync(join(dir,'reports'),{recursive:true});writeFileSync(join(dir,'reports/fixture.pdf'),'fixture');
 assert.equal(permanentlyDeleteReport(manager,'r').pendingFileCount,0);assert.equal(existsSync(join(dir,'reports/fixture.pdf')),false);
 assert.equal(getTrashCleanupSummary(manager,'m').pendingFileCount,0);assert.equal(getTrashCleanupSummary(manager,'n').pendingFileCount,0);
 report('auto');db.exec("UPDATE report_pages SET report_id='auto'");
 db.exec("INSERT INTO report_pages(id,report_id,page_number,storage_path,original_name,mime_type,file_size,sha256) VALUES('p2','auto',1,'reports/auto.png','auto.png','image/png',7,'other'); UPDATE reports SET deleted_at=NULL,purge_after=NULL WHERE id='auto'");
 assert.equal(listReports(manager,30,{memberId:'m',trash:true}).items[0].deletedAt,null);
 db.exec("UPDATE reports SET purge_after=datetime('now','-1 minute') WHERE id='auto'");assert.equal(purgeExpiredReports().deleted,1);
 assert.equal(getTrashCleanupSummary(manager,'m').pendingFileCount,1);
 assert.equal(runFileGarbageCollection().checked,0);due();runFileGarbageCollection();assert.equal(existsSync(join(dir,'reports/fixture.pdf')),false);
}));

test('queue actual IDs merge members, retain membership across reason changes, reset completed rounds, and close missing files',()=>fixture(()=>{
 const db=getDatabase();enqueueFileGarbage([{storagePath:'reports/shared',fileKind:'original'}],'report_purge',db,10,'m');
 const id=db.prepare('SELECT id FROM file_gc_queue').get()!.id;
 enqueueFileGarbage([{storagePath:'reports/shared',fileKind:'original'}],'report_purge',db,10,'n');
 const before=db.prepare('SELECT not_before FROM file_gc_queue').get()!.not_before;
 enqueueFileGarbage([{storagePath:'reports/shared',fileKind:'original'}],'orphan_scan',db,0);
 assert.equal(db.prepare('SELECT not_before FROM file_gc_queue').get()!.not_before,before);
 assert.deepEqual(db.prepare('SELECT DISTINCT gc_id FROM file_gc_members').all().map(x=>x.gc_id),[id]);
 assert.equal(getTrashCleanupSummary(manager,'m').pendingFileCount,1);assert.equal(getTrashCleanupSummary(manager,'n').pendingFileCount,1);
 due();runFileGarbageCollection();assert.equal(db.prepare('SELECT COUNT(*) AS n FROM file_gc_members').get()!.n,0);
 db.exec("UPDATE file_gc_queue SET attempts=7; INSERT INTO file_gc_members(gc_id,member_id) SELECT id,'m' FROM file_gc_queue");enqueueFileGarbage([{storagePath:'reports/shared',fileKind:'original'}],'report_purge',db,10,'n');
 assert.equal(getTrashCleanupSummary(manager,'m').pendingFileCount,0);assert.equal(getTrashCleanupSummary(manager,'n').retryingFileCount,0);
 assert.equal(db.prepare('SELECT attempts FROM file_gc_queue').get()!.attempts,0);
}));

test('failed disk deletion and failed completion metadata retain ownership and converge idempotently',t=>fixture(dir=>{
 const db=getDatabase();mkdirSync(join(dir,'reports'),{recursive:true});const file=join(dir,'reports/retry');writeFileSync(file,'fixture');
 enqueueFileGarbage([{storagePath:'reports/retry',fileKind:'original'}],'report_purge',db,0,'m');
 const original=fs.rmSync;
 const mocked=t.mock.method(fs,'rmSync',((path:fs.PathLike,options?:fs.RmOptions)=>{if(String(path)===file)throw Object.assign(new Error('fixture permission error'),{code:'EACCES'});return original(path,options);}) as typeof fs.rmSync);syncBuiltinESMExports();
 try {assert.equal(runFileGarbageCollection().failed,1);assert.ok(existsSync(file));} finally {mocked.mock.restore();syncBuiltinESMExports();}
 assert.equal(getTrashCleanupSummary(manager,'m').retryingFileCount,1);
 db.exec("CREATE TRIGGER fail_complete BEFORE DELETE ON file_gc_members BEGIN SELECT RAISE(ABORT,'fixture'); END");due();assert.equal(runFileGarbageCollection().failed,1);assert.equal(existsSync(file),false);
 assert.equal(getTrashCleanupSummary(manager,'m').pendingFileCount,1);
 db.exec('DROP TRIGGER fail_complete');due();assert.equal(runFileGarbageCollection().deleted,1);assert.equal(getTrashCleanupSummary(manager,'m').status,'none');
}));

test('batch limit is normal waiting; historical queues stay unassigned and upgrades preserve them',()=>fixture(dir=>{
 const db=getDatabase();for(let i=0;i<101;i++) enqueueFileGarbage([{storagePath:`reports/${i}`,fileKind:'original'}],'report_purge',db,0,'m');
 scheduleMaintenance(Date.now(),15000,21600000);
 assert.equal(runFileGarbageCollection().checked,100);assert.equal(getTrashCleanupSummary(manager,'m').status,'waiting');assert.equal(getTrashCleanupSummary(manager,'m').pendingFileCount,1);
 db.exec('DROP TABLE file_gc_members');closeDatabaseForTests();const upgraded=getDatabase();
 assert.equal(upgraded.prepare('SELECT COUNT(*) AS n FROM file_gc_members').get()!.n,0);assert.equal(getTrashCleanupSummary(manager,'m').status,'none');
 assert.equal(runFileGarbageCollection().checked,1);assert.ok(readdirSync(join(dir,'backups/db')).length);
}));

test('cleanup summary denies anonymous, viewer and unrelated administrators without exposing global tasks',()=>fixture(()=>{
 enqueueFileGarbage([{storagePath:'reports/private-file',fileKind:'original'}],'report_purge',getDatabase(),0,'m');
 for(const user of [{...manager,authenticated:false},{...manager,id:'v'},{...manager,id:'v',isAdmin:true,isGatewayAdmin:true}]) assert.throws(()=>getTrashCleanupSummary(user,'m'));
 assert.throws(()=>getTrashCleanupSummary({...manager,id:'v'},'n'));
 getDatabase().exec("DELETE FROM member_permissions WHERE member_id='m' AND user_id='u'");assert.throws(()=>getTrashCleanupSummary(manager,'m'));
}));

test('schedule uses independent startup and periodic phases, equality, retries, overdue and restart',()=>{
 const base=Date.parse('2026-09-21T00:00:00Z');const interval=6*3600000;
 scheduleMaintenance(base,15000,interval);let state=getMaintenanceState();
 assert.equal(cleanupSchedule(state,base+15000,base,null).at,new Date(base+15000).toISOString());
 assert.equal(cleanupSchedule(state,base+600000,base,null).at,new Date(base+interval).toISOString());
 assert.equal(cleanupSchedule(state,base+interval+1,base,null).at,new Date(base+2*interval).toISOString());
 assert.equal(cleanupSchedule(state,base,base+15001,null).status,'delayed');
 maintenanceTick(true);state=getMaintenanceState();assert.equal(state.periodicAt,base+interval);
 maintenanceFailed();assert.equal(cleanupSchedule(getMaintenanceState(),base,base+20000,null).status,'delayed');
 maintenanceGcFinished(base+21000);assert.equal(cleanupSchedule(getMaintenanceState(),base,base+22000,null).status,'waiting');
 assert.equal(cleanupSchedule(getMaintenanceState(),base,base,'STORAGE_MIGRATION').at,null);
 assert.equal(cleanupSchedule({...state,ready:false},base,base,null).status,'unknown');
 assert.equal(cleanupSchedule({...state,running:true},base,base,null).at,null);
 assert.equal(cleanupSchedule({...state,running:true,failure:true},null,base,null).status,'delayed');
 assert.equal(cleanupSchedule(state,Date.parse('2026-09-21T14:00:00+08:00'),base,null).at,'2026-09-21T06:00:00.000Z');
 scheduleMaintenance(base+100000,15000,interval);assert.equal(getMaintenanceState().firstAt,base+115000);
 assert.equal(cleanupSchedule(getMaintenanceState(),null,base+100000,null).at,null);
});

test('PDF shared pages, thumbnails, note derivatives and existing report caches are deleted immediately on manual purge',()=>fixture(dir=>{
 const db=getDatabase();report();
 const files=['reports/shared.pdf','thumbnails/one.jpg','thumbnails/two.jpg','report-notes/original.png','report-notes/thumb.jpg','report-notes/preview.jpg','previews/r/p.jpg','previews/vision/r/p.r90.jpg',`report-exports/r-${'a'.repeat(32)}.pdf`];
 for(const file of files){mkdirSync(dirname(join(dir,file)),{recursive:true});writeFileSync(join(dir,file),'fixture');}
 db.exec("INSERT INTO report_pages(id,report_id,page_number,storage_path,thumbnail_path,original_name,mime_type,file_size,sha256) VALUES('p','r',1,'reports/shared.pdf','thumbnails/one.jpg','fixture.pdf','application/pdf',7,'one'),('p2','r',2,'reports/shared.pdf','thumbnails/two.jpg','fixture.pdf','application/pdf',7,'two'); INSERT INTO report_notes(id,report_id) VALUES('note','r'); INSERT INTO report_note_assets(id,note_id,original_name,storage_path,thumbnail_path,preview_path,mime_type,file_size,sha256) VALUES('asset','note','fixture.png','report-notes/original.png','report-notes/thumb.jpg','report-notes/preview.jpg','image/png',7,'note')");
 assert.equal(permanentlyDeleteReport(manager,'r').pendingFileCount,0);
 assert.equal(runFileGarbageCollection().checked,0);
 for(const file of files)assert.equal(existsSync(join(dir,file)),false);
 assert.equal(getTrashCleanupSummary(manager,'m').status,'none');
}));

test('referenced files end only their current association, and unsafe paths are retained for retry',()=>fixture(dir=>{
 const db=getDatabase();report();mkdirSync(join(dir,'reports'),{recursive:true});writeFileSync(join(dir,'reports/referenced'),'fixture');
 db.exec("INSERT INTO report_pages(id,report_id,page_number,storage_path,original_name,mime_type,file_size,sha256) VALUES('p','r',1,'reports/referenced','fixture.png','image/png',7,'one')");
 enqueueFileGarbage([{storagePath:'reports/referenced',fileKind:'original'}],'report_purge',db,0,'m');
 assert.equal(runFileGarbageCollection().retained,1);assert.ok(existsSync(join(dir,'reports/referenced')));assert.equal(getTrashCleanupSummary(manager,'m').status,'none');
 enqueueFileGarbage([{storagePath:'../outside-fixture',fileKind:'original'}],'report_purge',db,0,'m');assert.equal(runFileGarbageCollection().failed,1);assert.equal(getTrashCleanupSummary(manager,'m').retryingFileCount,1);
}));


test('HTTP cleanup endpoint is private, member-scoped and read-only; errors cannot masquerade as zero',()=>fixture(async()=>{
 const db=getDatabase();enqueueFileGarbage([{storagePath:'reports/private-fixture',fileKind:'original'}],'report_purge',db,0,'m');
 let user=manager;
 const app=new H3({onError:errorHandler});app.use(event=>{event.context.requestUser=user;});
 app.get('/api/reports/trash-cleanup',cleanupRoute);app.get('/api/reports/:id',()=>({wrongRoute:true}));
 const url='http://localhost/api/reports/trash-cleanup?memberId=m';
 const before=db.prepare('SELECT * FROM file_gc_queue').all();
 const result=await app.request(url);assert.equal(result.status,200);assert.equal(result.headers.get('cache-control'),'private, no-store');
 const body=await result.json();assert.equal(body.data.pendingFileCount,1);assert.equal(JSON.stringify(body).includes('private-fixture'),false);
 assert.deepEqual(db.prepare('SELECT * FROM file_gc_queue').all(),before);
 user={...manager,id:'v'};assert.equal((await app.request(url)).status,403);
 user={...manager,id:'v',isGatewayAdmin:true};assert.equal((await app.request(url.replace('memberId=m','memberId=n'))).status,404);
 user={...manager,authenticated:false};assert.equal((await app.request(url)).status,401);
 user=manager;db.exec('DROP TABLE file_gc_members');assert.equal((await app.request(url)).status,500);
}));

test('maintenance failures before GC remain delayed until a cycle actually reaches GC',()=>fixture(async()=>{
 const db=getDatabase();scheduleMaintenance(Date.now(),15000,21600000);
 db.exec("CREATE TRIGGER fail_maintenance BEFORE INSERT ON app_settings BEGIN SELECT RAISE(ABORT,'fixture'); END");
 await assert.rejects(()=>runMaintenanceCycle());assert.equal(getMaintenanceState().failure,true);assert.equal(getMaintenanceState().lastGcAt,null);
 db.exec('DROP TRIGGER fail_maintenance');await runMaintenanceCycle();assert.equal(getMaintenanceState().failure,false);assert.ok(getMaintenanceState().lastGcAt);
}));


test('symlinked parent cannot redirect queued deletion outside the archive',()=>fixture(dir=>{
 const outside=mkdtempSync(join(tmpdir(),'gc-outside-fixture-'));
 try {
  writeFileSync(join(outside,'keep'),'fixture');symlinkSync(outside,join(dir,'linked'));
  enqueueFileGarbage([{storagePath:'linked/keep',fileKind:'original'}],'report_purge',getDatabase(),0,'m');
  assert.equal(runFileGarbageCollection().failed,1);assert.ok(existsSync(join(outside,'keep')));
 } finally {rmSync(outside,{recursive:true,force:true});}
}));

test('manual purge attempts only its own files and reports failed deletion for background retry',t=>fixture(dir=>{
 const db=getDatabase();report();mkdirSync(join(dir,'reports'),{recursive:true});
 const target=join(dir,'reports/manual');writeFileSync(target,'fixture');writeFileSync(join(dir,'reports/unrelated'),'fixture');
 db.exec("INSERT INTO report_pages(id,report_id,page_number,storage_path,original_name,mime_type,file_size,sha256) VALUES('p','r',1,'reports/manual','fixture.png','image/png',7,'one')");
 enqueueFileGarbage([{storagePath:'reports/unrelated',fileKind:'original'}],'report_purge',db,0,'m');
 const original=fs.rmSync;
 const mocked=t.mock.method(fs,'rmSync',((path:fs.PathLike,options?:fs.RmOptions)=>{if(String(path)===target)throw Object.assign(new Error('fixture permission error'),{code:'EACCES'});return original(path,options);}) as typeof fs.rmSync);syncBuiltinESMExports();
 try {assert.deepEqual(permanentlyDeleteReport(manager,'r'),{id:'r',deleted:true,pendingFileCount:1});} finally {mocked.mock.restore();syncBuiltinESMExports();}
 assert.equal(db.prepare("SELECT 1 FROM reports WHERE id='r'").get(),undefined);
 assert.ok(existsSync(target));assert.ok(existsSync(join(dir,'reports/unrelated')));
 assert.equal(getTrashCleanupSummary(manager,'m').retryingFileCount,1);
 due();runFileGarbageCollection();assert.equal(existsSync(target),false);
}));

test('manual purge retains shared files and processes all its files even above the background batch cap',()=>fixture(dir=>{
 const db=getDatabase();report();report('other','n');mkdirSync(join(dir,'reports'),{recursive:true});
 const insert=db.prepare("INSERT INTO report_pages(id,report_id,page_number,storage_path,original_name,mime_type,file_size,sha256) VALUES(?, ?, ?, ?, 'fixture.png','image/png',7,?)");
 for(let i=0;i<105;i++){writeFileSync(join(dir,`reports/manual-${i}`),'fixture');insert.run(`p${i}`,'r',i+1,`reports/manual-${i}`,`hash${i}`);}
 insert.run('other-page','other',1,'reports/manual-0','shared');
 assert.equal(permanentlyDeleteReport(manager,'r').pendingFileCount,0);
 assert.ok(existsSync(join(dir,'reports/manual-0')));for(let i=1;i<105;i++)assert.equal(existsSync(join(dir,`reports/manual-${i}`)),false);
 assert.equal(getTrashCleanupSummary(manager,'m').status,'none');
}));

test('post-commit completion failure never reports an already-deleted report as a failed purge',()=>fixture(dir=>{
 const db=getDatabase();report();mkdirSync(join(dir,'reports'),{recursive:true});writeFileSync(join(dir,'reports/mark-failure'),'fixture');
 db.exec("INSERT INTO report_pages(id,report_id,page_number,storage_path,original_name,mime_type,file_size,sha256) VALUES('p','r',1,'reports/mark-failure','fixture.png','image/png',7,'one'); CREATE TRIGGER fail_gc_update BEFORE UPDATE ON file_gc_queue BEGIN SELECT RAISE(ABORT,'fixture'); END");
 assert.deepEqual(permanentlyDeleteReport(manager,'r'),{id:'r',deleted:true,pendingFileCount:null});
 assert.equal(db.prepare("SELECT 1 FROM reports WHERE id='r'").get(),undefined);assert.equal(existsSync(join(dir,'reports/mark-failure')),false);
 assert.equal(getTrashCleanupSummary(manager,'m').pendingFileCount,1);
 db.exec('DROP TRIGGER fail_gc_update');assert.equal(runFileGarbageCollection().deleted,1);
}));
