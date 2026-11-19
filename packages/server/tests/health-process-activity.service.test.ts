import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {getDatabase,closeDatabaseForTests} from '../database/client';
import type {RequestUser} from '../domain/request-user';
import {getHealthProcessActivity} from '../services/health-process-activity.service';
import {getHealthProcessCare} from '../services/health-process-care.service';
import {listProcessObservations} from '../services/health-observation.service';
import {getRecordProcess,linkProcessRecords,removeProcessRecord} from '../services/health-record-process.service';
import {createReminder,listReminders} from '../services/records.service';
import {createPublicSymptom} from '../services/public-symptom.service';
import {createProcessSymptomUpdate} from '../services/symptom-episode.service';
import {createMedicationCourse,createMedicationIntake} from '../services/medication.service';
const user:RequestUser={id:'manager',displayName:'合成账号',authenticated:true,provider:'development',isGatewayAdmin:true};
async function fixture(run:(id:string,otherId:string)=>unknown){
 const previous=process.env.STORAGE_DIR,dir=mkdtempSync(join(tmpdir(),'health-process-activity-'));process.env.STORAGE_DIR=dir;
 try{const db=getDatabase();db.prepare("INSERT INTO users(id,display_name) VALUES('manager','合成账号'),('viewer','合成只读账号'),('outsider','合成无权限账号')").run();
  for(const member of ['member','other']){db.prepare('INSERT INTO health_members(id,display_name,created_by) VALUES(?,?,?)').run(member,'合成成员',user.id);db.prepare("INSERT INTO member_permissions(member_id,user_id,permission,granted_by) VALUES(?,'manager','manager','manager')").run(member);}
  db.prepare("INSERT INTO member_permissions(member_id,user_id,permission,granted_by) VALUES('member','viewer','viewer','manager')").run();
  for(const id of ['a','b','c','d'])db.prepare("INSERT INTO reports(id,member_id,created_by,title,report_type,status,report_issued_at,chief_complaint,summary,recommendation) VALUES(?,'member','manager',?,'laboratory','ready','2026-01-01','合成主诉','合成结论','合成建议')").run(id,'合成报告 '+id);
  const id=linkProcessRecords(user,{kind:'report',id:'a'},[{kind:'report',id:'b'}])[0].id;
  const otherId=linkProcessRecords(user,{kind:'report',id:'c'},[{kind:'report',id:'d'}])[0].id;
  await run(id,otherId);
 }finally{closeDatabaseForTests();if(previous===undefined)delete process.env.STORAGE_DIR;else process.env.STORAGE_DIR=previous;rmSync(dir,{recursive:true,force:true});}
}
function countReads<T>(run:()=>T){const db=getDatabase(),prepare=db.prepare.bind(db),queries:string[]=[];
 db.prepare=((sql:string)=>{queries.push(sql);return prepare(sql);}) as typeof db.prepare;
 try{return {value:run(),queries};}finally{db.prepare=prepare;}
}
const graphReads=(queries:string[])=>queries.filter(sql=>sql.includes('SELECT kind,record_id,process_id,stage_override FROM health_record_process_nodes')).length;
test('initial modules share one graph/source read and agree with individual endpoints without preparing a doctor summary',()=>fixture(id=>{
 const symptom=createPublicSymptom(user,{memberId:'member',name:'发热',startedAt:'2026-01-01',processId:id});
 for(let i=1;i<=12;i++)createProcessSymptomUpdate(user,symptom.episodeId,symptom.id,{recordedAt:`2026-01-${String(i).padStart(2,'0')}T08:00`,measurementValue:'38.1',measurementUnit:'℃'});
 const course=createMedicationCourse(user,{memberId:'member',medicationName:'合成药品',startedAt:'2026-01-01',confirmed:true,processId:id});
 createMedicationIntake(user,{memberId:'member',courseId:course.id,takenAt:'2026-01-02T08:00',amount:'1',amountUnit:'片'});
 createReminder(user,{memberId:'member',title:'合成复查',dueAt:'2026-12-01',relatedRecord:{kind:'report',id:'a'}});
 const {value:activity,queries}=countReads(()=>getHealthProcessActivity(user,id));
 assert.equal(graphReads(queries),1);assert.equal(queries.some(sql=>/FROM (report_pages|ocr_results|report_structured_sections|report_diagnoses|report_procedures)/.test(sql)),false);
 assert.deepEqual(activity.care.data,getHealthProcessCare(user,id,'Asia/Shanghai',false));assert.equal(activity.care.data?.summaryReady,false);assert.equal(activity.care.data?.summaryText,'');assert.equal(activity.care.data?.summaryByDay,undefined);assert.equal(activity.care.data?.doctorContext,undefined);
 assert.deepEqual(activity.observations.data,listProcessObservations(user,id));assert.equal(activity.observations.data?.items.length,10);assert.ok(activity.observations.data?.nextCursor);
 assert.deepEqual(activity.reminders.data,listReminders(user,'member').filter(row=>row.processes.some(p=>p.id===id)));
 const full=getHealthProcessCare(user,id);assert.equal(full.summaryReady,true);assert.match(full.summaryText,/合成结论/);assert.match(full.summaryByDay!,/合成建议/);assert.ok(full.doctorContext);
 const next=listProcessObservations(user,id,{cursor:activity.observations.data?.nextCursor});assert.equal(next.items.length,3);
}));
test('scoped reminders read current process anchors and the global list computes membership once per member',()=>fixture((id,otherId)=>{
 for(let i=0;i<15;i++)createReminder(user,{memberId:'member',title:'合成当前提醒',dueAt:'2026-12-01',relatedRecord:{kind:'report',id:'a'}});
 const unrelated=createReminder(user,{memberId:'member',title:'合成其他提醒',dueAt:'2026-12-02',relatedRecord:{kind:'report',id:'c'}});
 const legacy=createReminder(user,{memberId:'member',title:'合成旧来源提醒',dueAt:'2026-12-02',reportId:'b'});
 // An explicit plan anchor must take precedence over a legacy report reference.
 const override=createReminder(user,{memberId:'member',title:'合成明确来源',dueAt:'2026-12-02',reportId:'a',relatedRecord:{kind:'report',id:'c'}});
 const {value:scoped,queries}=countReads(()=>listReminders(user,'member',getRecordProcess(user,id)));
 assert.equal(graphReads(queries),1);assert.equal(scoped.length,16);assert.ok(scoped.some(row=>row.id===legacy.id));assert.equal(scoped.some(row=>row.id===unrelated.id||row.id===override.id),false);
 const global=countReads(()=>listReminders(user,'member'));assert.equal(graphReads(global.queries),1);assert.equal(global.value.find(row=>row.id===override.id)?.processes[0].id,otherId);
 const process=getRecordProcess(user,id);removeProcessRecord(user,id,{fingerprint:process.fingerprint,editToken:process.editToken,record:{kind:'report',id:'a'},requestKey:'synthetic-move-anchor-001'});
 assert.equal(listReminders(user,'member').find(row=>row.id===legacy.id)?.processes.length,0);
 assert.throws(()=>getHealthProcessActivity(user,id));
}));
test('the initial snapshot rereads changes and isolates module errors without exposing internal errors',()=>fixture(id=>{
 const before=getHealthProcessActivity(user,id);assert.equal(before.reminders.data?.length,0);
 createReminder(user,{memberId:'member',title:'合成后续提醒',dueAt:'2026-12-01',relatedRecord:{kind:'report',id:'a'}});
 assert.equal(getHealthProcessActivity(user,id).reminders.data?.length,1);
 const db=getDatabase(),prepare=db.prepare.bind(db);
 db.prepare=((sql:string)=>{if(sql.includes('SELECT DISTINCT re.id FROM reminders'))throw Error('synthetic-private-error');return prepare(sql);}) as typeof db.prepare;
 try{const partial=getHealthProcessActivity(user,id);assert.ok(partial.care.data);assert.ok(partial.observations.data);assert.ok(partial.reminders.error);assert.doesNotMatch(JSON.stringify(partial),/synthetic-private-error/);}finally{db.prepare=prepare;}
 assert.deepEqual(before.care.data?.symptoms,[]);
}));
test('activity, quick care and scoped follow-up routes enforce access and preserve complete summary behavior',()=>fixture(async id=>{
 const {H3}=await import('h3');const {default:activity}=await import('../routes/api/health-processes/[id]/activity.get');const {default:care}=await import('../routes/api/health-processes/[id]/care.get');const {default:followups}=await import('../routes/api/health-processes/[id]/followups.get');
 const app=new H3();app.use(event=>{event.context.requestUser={...user,id:event.req.headers.get('x-synthetic-user')||user.id,isGatewayAdmin:false};});
 app.get('/process/:id/activity',activity);app.get('/process/:id/care',care);app.get('/process/:id/followups',followups);
 for(const suffix of ['activity','care?view=quick','care','followups']){
  assert.equal((await app.request(`http://localhost/process/${id}/${suffix}`,{headers:{'x-synthetic-user':'outsider'}})).status,403);
  assert.equal((await app.request(`http://localhost/process/${id}/${suffix}`,{headers:{'x-synthetic-user':'viewer'}})).status,200);
  assert.equal((await app.request(`http://localhost/process/missing/${suffix}`)).status,404);
 }
 const quick=await (await app.request(`http://localhost/process/${id}/care?view=quick`)).json();assert.equal(quick.data.summaryReady,false);
 const full=await (await app.request(`http://localhost/process/${id}/care`)).json();assert.match(full.data.summaryText,/合成结论/);
}));
