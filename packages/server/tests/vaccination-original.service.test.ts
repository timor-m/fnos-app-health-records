import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync,writeFileSync,rmSync,readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDatabase,closeDatabaseForTests } from '../database/client';
import type { RequestUser } from '../domain/request-user';
import { saveVaccinationWithOriginal } from '../services/vaccination-original.service';
import { createVaccination,getVaccination,updateVaccination } from '../services/vaccination.service';
import { getReportDetail } from '../services/records.service';
import { listHealthRecordFeed } from '../services/health-record-feed.service';
const manager:RequestUser={id:'manager',displayName:'合成账号',authenticated:true,provider:'development',isGatewayAdmin:true};
const viewer:RequestUser={...manager,id:'viewer',isGatewayAdmin:false};
const input={memberId:'member',vaccineName:'合成疫苗',administeredAt:'2026-01-01',doseNumber:'第 1 剂',requestKey:'vaccination-original-save-001'};
function fixture(run:(dir:string,files:Array<{originalName:string;sourcePath:string}>)=>void){
 const previous=process.env.STORAGE_DIR;const dir=mkdtempSync(join(tmpdir(),'vaccination-original-'));process.env.STORAGE_DIR=dir;
 try{
  const db=getDatabase();for(const user of [manager,viewer])db.prepare('INSERT INTO users(id,display_name) VALUES(?,?)').run(user.id,'合成账号');
  for(const id of ['member','second']){db.prepare('INSERT INTO health_members(id,display_name,created_by) VALUES(?,?,?)').run(id,'合成成员',manager.id);db.prepare("INSERT INTO member_permissions(member_id,user_id,permission,granted_by) VALUES(?,?,'manager','manager')").run(id,manager.id);}
  db.prepare("INSERT INTO member_permissions(member_id,user_id,permission,granted_by) VALUES('member','viewer','viewer','manager')").run();
  const path=join(dir,'synthetic.png');writeFileSync(path,Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,1]));
  run(dir,[{originalName:'合成附件.png',sourcePath:path}]);
 }finally{closeDatabaseForTests();if(previous===undefined)delete process.env.STORAGE_DIR;else process.env.STORAGE_DIR=previous;rmSync(dir,{recursive:true,force:true});}
}
function status(run:()=>unknown,code:number){assert.throws(run,error=>(error as {statusCode:number}).statusCode===code);}
function count(table:string){return getDatabase().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n;}
test('manual creation saves originals, vaccination and reminder atomically without duplicate cards or retry records',()=>fixture((_dir,files)=>{
 const body={...input,nextDueAt:'2026-02-01'};const saved=saveVaccinationWithOriginal(manager,body,files);
 assert.ok(saved.sourceReportId);assert.ok(saved.reminderId);assert.equal(saved.sourceFactId,null);assert.equal(saved.doseNumber,input.doseNumber);
 const original=getReportDetail(manager,saved.sourceReportId!);assert.equal(original.reportType,'vaccination');assert.equal(original.pages.length,1);assert.ok(original.manualFieldKeys.includes('reportType'));
 assert.equal(count('reports'),1);assert.equal(count('health_vaccinations'),1);assert.equal(count('processing_jobs'),2);
 assert.equal(listHealthRecordFeed(manager,{memberId:'member'}).items.length,1);
 assert.equal(saveVaccinationWithOriginal(manager,body,files).id,saved.id);assert.equal(count('reports'),1);assert.equal(count('reminders'),1);
 status(()=>saveVaccinationWithOriginal(manager,{...body,vaccineName:'合成更改'},files),409);
}));
test('an existing manual vaccination receives its first attachment and an unchanged retry keeps its identity and revision',()=>fixture((_dir,files)=>{
 const manual=createVaccination(manager,input);const body={...input,id:manual.id,revision:manual.revision,requestKey:'vaccination-original-edit-001'};
 const saved=saveVaccinationWithOriginal(manager,body,files);assert.equal(saved.id,manual.id);assert.ok(saved.sourceReportId);assert.equal(saved.revision,2);
 const again=saveVaccinationWithOriginal(manager,body,files);assert.equal(again.id,saved.id);assert.equal(again.revision,2);assert.equal(count('reports'),1);assert.equal(count('health_vaccinations'),1);
}));
test('invalid vaccination fields and stale revisions roll back files, report jobs and receipts',()=>fixture((dir,files)=>{
 status(()=>saveVaccinationWithOriginal(manager,{...input,administeredAt:'2099-01-01'},files),400);
 assert.equal(count('reports'),0);assert.equal(count('processing_jobs'),0);assert.equal(count('upload_receipts'),0);assert.equal(count('health_vaccinations'),0);
 assert.deepEqual(readdirSync(join(dir,'reports','member')),[]);
 const manual=createVaccination(manager,input);updateVaccination(manager,manual.id,{revision:manual.revision,note:'合成修改'});
 status(()=>saveVaccinationWithOriginal(manager,{...input,id:manual.id,revision:manual.revision},files),409);
 assert.equal(count('reports'),0);assert.equal(getVaccination(manager,manual.id).sourceReportId,null);assert.deepEqual(readdirSync(join(dir,'reports','member')),[]);
}));
test('attachment writes reject viewers, cross-member records and unsupported file contents',()=>fixture((dir,files)=>{
 status(()=>saveVaccinationWithOriginal(viewer,input,files),403);
 const foreign=createVaccination(manager,{...input,memberId:'second'});
 status(()=>saveVaccinationWithOriginal(manager,{...input,id:foreign.id,revision:foreign.revision},files),403);
 const bad=join(dir,'invalid.png');writeFileSync(bad,'synthetic non-image');status(()=>saveVaccinationWithOriginal(manager,input,[{originalName:'invalid.png',sourcePath:bad}]),415);
 assert.equal(count('reports'),0);
}));
test('a lost response retry validates attachment content and current source ownership',()=>fixture((dir,files)=>{
 const saved=saveVaccinationWithOriginal(manager,input,files);
 writeFileSync(files[0].sourcePath,Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,2]));
 status(()=>saveVaccinationWithOriginal(manager,input,files),409);assert.equal(count('reports'),1);
 getDatabase().prepare("UPDATE reports SET member_id='second' WHERE id=?").run(saved.sourceReportId!);
 status(()=>saveVaccinationWithOriginal(manager,input,files),409);
}));
test('multiple images and PDFs become one attachment collection and trigger failures leave no orphan files',()=>fixture((dir,files)=>{
 const pdf=join(dir,'synthetic.pdf');writeFileSync(pdf,'%PDF-1.4\n%%EOF');
 const saved=saveVaccinationWithOriginal(manager,input,[...files,{originalName:'合成附件.pdf',sourcePath:pdf}]);
 assert.equal(getReportDetail(manager,saved.sourceReportId!).pages.length,2);assert.equal(count('health_vaccinations'),1);
 const before=count('reports');getDatabase().exec("CREATE TRIGGER reject_new_vaccination BEFORE INSERT ON health_vaccinations BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");
 assert.throws(()=>saveVaccinationWithOriginal(manager,{...input,requestKey:'vaccination-original-fail-001'},files));
 assert.equal(count('reports'),before);assert.equal(readdirSync(join(dir,'reports','member')).length,1);
}));

test('detail attachment upload needs only identity and revision, preserving dose fields and canceled reminder state',()=>fixture((_dir,files)=>{
 const manual=createVaccination(manager,{...input,nextDueAt:'2026-02-01'});const db=getDatabase();db.prepare("UPDATE reminders SET status='dismissed' WHERE id=?").run(manual.reminderId!);
 const body={id:manual.id,memberId:manual.memberId,revision:manual.revision,requestKey:'vaccination-detail-original-001'};
 const saved=saveVaccinationWithOriginal(manager,body,files);
 assert.equal(saved.id,manual.id);assert.equal(saved.vaccineName,manual.vaccineName);assert.equal(saved.administeredAt,manual.administeredAt);assert.equal(saved.doseNumber,manual.doseNumber);
 assert.equal(saved.nextDueAt,manual.nextDueAt);assert.equal(saved.reminderId,manual.reminderId);assert.equal(saved.reminderStatus,'dismissed');assert.ok(saved.sourceReportId);
 assert.equal(saveVaccinationWithOriginal(manager,body,files).sourceReportId,saved.sourceReportId);assert.equal(count('reports'),1);
}));
