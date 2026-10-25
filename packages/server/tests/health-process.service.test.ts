import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { closeDatabaseForTests, getDatabase } from '../database/client';
import { ensureHealthProcessDraft, needsHealthProcessRepair } from '../database/health-process-draft';
import type { RequestUser } from '../domain/request-user';
import { createHealthEpisode, getHealthEpisode } from '../services/health-episode.service';
import { createHealthEvent } from '../services/health-event.service';
import { correctProcessSymptomUpdate, createProcessSymptom,
  createProcessSymptomUpdate, retractProcessSymptom, retractProcessSymptomUpdate,
  updateProcessSymptom } from '../services/symptom-episode.service';

const manager: RequestUser = { id:'manager',displayName:'合成管理者',authenticated:true,provider:'development',isGatewayAdmin:true };
const viewer: RequestUser = { id:'viewer',displayName:'合成查看者',authenticated:true,provider:'development',isGatewayAdmin:false };
const outsider: RequestUser = { id:'outsider',displayName:'合成其他账号',authenticated:true,provider:'development',isGatewayAdmin:false };
function errorStatus(fn:()=>unknown, status:number) { assert.throws(fn,(error:unknown)=>(error as {statusCode:number}).statusCode===status); }
function fixture(run:()=>void) {
  const previous=process.env.STORAGE_DIR;const dir=mkdtempSync(join(tmpdir(),'health-process-'));
  process.env.STORAGE_DIR=dir;
  try {
    const db=getDatabase();
    for(const user of [manager,viewer,outsider])db.prepare('INSERT INTO users(id,display_name) VALUES(?,?)').run(user.id,user.displayName);
    for(const id of ['member','other']){
      db.prepare('INSERT INTO health_members(id,display_name,created_by) VALUES(?,?,?)').run(id,'合成成员',manager.id);
      db.prepare("INSERT INTO member_permissions(member_id,user_id,permission,granted_by) VALUES(?,?,'manager',?)").run(id,manager.id,manager.id);
    }
    db.prepare("INSERT INTO member_permissions(member_id,user_id,permission,granted_by) VALUES('member','viewer','viewer','manager')").run();
    run();
  }finally{closeDatabaseForTests();if(previous===undefined)delete process.env.STORAGE_DIR;else process.env.STORAGE_DIR=previous;rmSync(dir,{recursive:true,force:true});}
}

test('independent symptoms derive state chronologically; corrections and retractions preserve business history',()=>fixture(()=>{
  let episode=createHealthEpisode(manager,{memberId:'member',episodeType:'symptom',title:'合成观察阶段',startedAt:'2026-01-01',symptom:{name:'合成症状甲',severity:4}});
  const first=episode.symptoms[0].id;
  episode=createProcessSymptom(manager,episode.id,{name:'合成症状乙',startedAt:'2026-01-02',description:'synthetic-private-description'});
  const second=episode.symptoms[1].id;
  episode=createProcessSymptomUpdate(manager,episode.id,first,{recordedAt:'2026-01-04T12:00',change:'resolved',severity:0});
  const resolved=episode.symptoms[0].updates[0];
  episode=createProcessSymptomUpdate(manager,episode.id,first,{recordedAt:'2026-01-03',change:'worsened',severity:7});
  assert.equal(episode.symptoms[0].status,'resolved','backfilled older change does not reopen the symptom');
  assert.equal(episode.symptoms[0].currentSeverity,0);
  assert.equal(episode.symptoms[1].status,'active');
  assert.equal(episode.status,'active');assert.equal(episode.endedAt,null);
  episode=createProcessSymptomUpdate(manager,episode.id,second,{recordedAt:'2026-01-05',change:'improved',measurementValue:'0',measurementUnit:'合成单位',description:'synthetic-private-note'});
  assert.equal(episode.symptoms[1].updates[0].measurementValue,'0','measurement is separate from severity and preserves zero');
  assert.equal(episode.symptoms[1].currentSeverity,null);
  errorStatus(()=>correctProcessSymptomUpdate(manager,episode.id,first,resolved.id,{version:0,change:'unchanged'}),409);
  episode=correctProcessSymptomUpdate(manager,episode.id,first,resolved.id,{version:1,change:'improved',severity:2});
  assert.equal(episode.symptoms[0].status,'active');assert.equal(episode.symptoms[0].currentSeverity,2);
  errorStatus(()=>retractProcessSymptomUpdate(manager,episode.id,first,resolved.id,{version:1}),409);
  episode=retractProcessSymptomUpdate(manager,episode.id,first,resolved.id,{version:2});
  assert.equal(episode.symptoms[0].currentSeverity,7,'retraction restores preceding observation');
  assert.ok(episode.symptoms[0].updates.find(item=>item.id===resolved.id)?.deletedAt);
  episode=updateProcessSymptom(manager,episode.id,second,{version:1,name:'更正的合成症状乙',severity:0});
  assert.equal(episode.symptoms[1].name,'更正的合成症状乙');assert.equal(episode.symptoms[1].currentSeverity,0);
  episode=retractProcessSymptom(manager,episode.id,second,{version:2});
  assert.equal(episode.symptoms.length,1);
  const db=getDatabase();
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM health_process_symptom_revisions').get()!.n,4);
  const revisions=db.prepare('SELECT snapshot_json FROM health_process_symptom_revisions WHERE target_id=? ORDER BY rowid').all(resolved.id) as Array<{snapshot_json:string}>;
  assert.equal(JSON.parse(revisions[0].snapshot_json).change,'resolved');assert.equal(JSON.parse(revisions[1].snapshot_json).change,'improved');
  assert.ok(db.prepare('SELECT deleted_at FROM health_process_symptoms WHERE id=?').get(second)!.deleted_at);
  const logs=JSON.stringify(db.prepare("SELECT detail_json FROM audit_logs WHERE target_type='health_episode'").all());
  assert.equal(logs.includes('synthetic-private'),false,'raw descriptions stay out of audit logs');
}));

test('symptom writes enforce access, parent membership, chronology and independent symptom state',()=>fixture(()=>{
 const episode=createHealthEpisode(manager,{memberId:'member',episodeType:'monitoring',title:'合成内部容器'});
 const other=createHealthEpisode(manager,{memberId:'other',episodeType:'monitoring',title:'合成其他容器'});
 errorStatus(()=>createProcessSymptom(viewer,episode.id,{name:'禁止'}),403);
 errorStatus(()=>getHealthEpisode(outsider,episode.id),403);
 let detail=createProcessSymptom(manager,episode.id,{name:'合成症状',startedAt:'2026-01-02'});
 const symptom=detail.symptoms[0].id;
 errorStatus(()=>createProcessSymptomUpdate(manager,other.id,symptom,{change:'unchanged'}),404);
 errorStatus(()=>createProcessSymptomUpdate(viewer,episode.id,symptom,{change:'unchanged'}),403);
 for(const input of [{recordedAt:'2026-01-01',change:'unchanged'},{recordedAt:'2026-02-30T12:00',change:'unchanged'},{measurementValue:'37'},{}])errorStatus(()=>createProcessSymptomUpdate(manager,episode.id,symptom,input),400);
 detail=createProcessSymptomUpdate(manager,episode.id,symptom,{recordedAt:'2026-01-04T22:30',change:'resolved'});
 assert.equal(detail.symptoms[0].status,'resolved');
 errorStatus(()=>updateProcessSymptom(manager,episode.id,symptom,{version:1,startedAt:'2026-01-05'}),400);
 detail=createProcessSymptomUpdate(manager,episode.id,symptom,{recordedAt:'2026-01-03',severity:0,description:'合成补充'});
 assert.equal(detail.symptoms[0].status,'resolved');
 createProcessSymptom(manager,episode.id,{name:'另一合成症状'});
 retractProcessSymptom(manager,episode.id,symptom,{version:1});
 errorStatus(()=>createProcessSymptomUpdate(manager,episode.id,symptom,{recordedAt:'2026-01-03',change:'unchanged'}),404);
 assert.equal(getHealthEpisode(manager,episode.id).symptoms[0].updates.length,0);
}));

test('lost responses for process, symptom and observation creation replay one transaction without duplicate history',()=>fixture(()=>{
  const db=getDatabase();
  const processInput={memberId:'member',episodeType:'symptom',title:'合成阶段',requestKey:'process-response-key',symptom:{name:'合成症状甲'}};
  const initial=createHealthEpisode(manager,processInput);
  const replay=createHealthEpisode(manager,processInput);
  assert.equal(replay.id,initial.id);assert.equal(replay.symptoms[0].id,initial.symptoms[0].id);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM health_episodes').get()!.n,1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM health_process_symptoms').get()!.n,1);
  errorStatus(()=>createHealthEpisode(manager,{...processInput,title:'不同内容'}),409);
  const symptomInput={name:'合成症状乙',requestKey:'symptom-response-key'};
  const withSecond=createProcessSymptom(manager,initial.id,symptomInput);
  assert.equal(createProcessSymptom(manager,initial.id,symptomInput).symptoms[1].id,withSecond.symptoms[1].id);
  const countAudit=()=>db.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action='episode.symptom.record'").get()!.n;
  const observation={recordedAt:'2026-01-02',change:'unchanged',description:'合成变化',requestKey:'observation-response-key'};
  const recorded=createProcessSymptomUpdate(manager,initial.id,initial.symptoms[0].id,observation);
  const recordedAgain=createProcessSymptomUpdate(manager,initial.id,initial.symptoms[0].id,observation);
  assert.equal(recordedAgain.symptoms[0].updates[0].id,recorded.symptoms[0].updates[0].id);assert.equal(countAudit(),1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM health_process_symptom_updates').get()!.n,1);
  errorStatus(()=>createProcessSymptomUpdate(manager,initial.id,withSecond.symptoms[1].id,observation),409);
  errorStatus(()=>createProcessSymptomUpdate(manager,initial.id,initial.symptoms[0].id,{...observation,change:'improved'}),409);
  const other=createHealthEpisode(manager,{memberId:'member',episodeType:'monitoring',title:'其他阶段'});
  errorStatus(()=>createProcessSymptom(manager,other.id,symptomInput),409);
  errorStatus(()=>createProcessSymptom(manager,initial.id,{name:'',requestKey:'failed-creation-key'}),400);
  assert.ok(createProcessSymptom(manager,initial.id,{name:'合成更正输入',requestKey:'failed-creation-key'}).symptoms.length===3);
  db.prepare("UPDATE member_permissions SET permission='viewer' WHERE member_id='member' AND user_id='manager'").run();
  errorStatus(()=>createHealthEpisode(manager,processInput),403);
}));

test('creation replay reads current detail and cannot resurrect a deleted process',()=>fixture(()=>{
  const input={memberId:'member',episodeType:'symptom',title:'合成阶段',symptom:{name:'合成症状'},requestKey:'process-current-receipt'};
  const episode=createHealthEpisode(manager,input);
  getDatabase().prepare('UPDATE health_episodes SET title=? WHERE id=?').run('更正后的阶段',episode.id);
  assert.equal(createHealthEpisode(manager,input).title,'更正后的阶段');
  getDatabase().prepare('UPDATE health_episodes SET deleted_at=CURRENT_TIMESTAMP WHERE id=?').run(episode.id);
  errorStatus(()=>createHealthEpisode(manager,input),404);
  assert.equal(getDatabase().prepare('SELECT COUNT(*) AS n FROM health_episodes').get()!.n,1);
}));
