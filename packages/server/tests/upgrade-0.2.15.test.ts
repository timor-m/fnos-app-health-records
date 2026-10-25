import {validateHealthWorkflowDatabase} from '../services/health-workflow-integrity.service';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,readFileSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';
import {getDatabase,closeDatabaseForTests} from '../database/client';
import {ensureHealthProcessDraft} from '../database/health-process-draft';
import {listReminders} from '../services/records.service';
import {createPublicSymptom} from '../services/public-symptom.service';
import type {RequestUser} from '../domain/request-user';

const obsolete=['health_event_relations','health_episode_events','symptom_episode_details','symptom_updates','health_document_process_links','health_reminder_context','medication_context_links'];
const user:RequestUser={id:'baseline-user',displayName:'Synthetic',provider:'development',authenticated:true,isGatewayAdmin:true};

test('the actual 0.2.15 schema upgrades with original reports and reminders intact, without intermediate-version business tables',()=>{
 const previous=process.env.STORAGE_DIR;const root=mkdtempSync(join(tmpdir(),'upgrade-0215-'));process.env.STORAGE_DIR=root;
 try{
  mkdirSync(join(root,'db'));const file=join(root,'db','health-records.sqlite');const old=new DatabaseSync(file);
  old.exec(readFileSync('packages/server/tests/fixtures/0.2.15-schema.sql','utf8'));
  old.exec("INSERT INTO users(id,display_name) VALUES('baseline-user','Synthetic');INSERT INTO health_members(id,display_name,created_by) VALUES('member','Synthetic','baseline-user');INSERT INTO member_permissions(member_id,user_id,permission,granted_by) VALUES('member','baseline-user','manager','baseline-user');INSERT INTO reports(id,member_id,created_by,title,report_type,status) VALUES('report','member','baseline-user','Synthetic','laboratory','ready');INSERT INTO reminders(id,member_id,report_id,title,due_at,source,created_by) VALUES('reminder','member','report','Synthetic','2026-12-01','report_suggestion','baseline-user')");
  assert.deepEqual(validateHealthWorkflowDatabase(old),[]);
  const baselineReport=old.prepare("SELECT * FROM reports WHERE id='report'").get();const migrations=old.prepare('SELECT * FROM schema_migrations ORDER BY version').all();old.close();
  const upgraded=getDatabase();assert.deepEqual(upgraded.prepare("SELECT * FROM reports WHERE id='report'").get(),baselineReport);assert.deepEqual(upgraded.prepare('SELECT * FROM schema_migrations ORDER BY version').all(),migrations);
  for(const table of obsolete)assert.equal(upgraded.prepare('SELECT 1 FROM sqlite_master WHERE name=?').get(table),undefined,table);
  for(const table of ['health_process_symptoms','health_record_links','health_record_processes','medication_courses','health_vaccinations'])assert.equal(upgraded.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n,0);
  const reminder=listReminders(user,'member')[0];assert.equal(reminder.id,'reminder');assert.equal(reminder.status,'pending');assert.deepEqual(reminder.relatedRecord,{kind:'report',id:'report'});
  const backups=readdirSync(join(root,'backups','db'));assert.equal(backups.length,1);
  const snapshot=new DatabaseSync(join(root,'backups','db',backups[0]),{readOnly:true});try{assert.deepEqual(snapshot.prepare("SELECT * FROM reports WHERE id='report'").get(),baselineReport);assert.equal(snapshot.prepare("SELECT 1 FROM sqlite_master WHERE name='health_record_links'").get(),undefined);}finally{snapshot.close();}
  const created=createPublicSymptom(user,{memberId:'member',name:'Synthetic',requestKey:'baseline-symptom-create',startedAt:'2026-01-01'});
  const record=upgraded.prepare('SELECT * FROM health_process_symptoms WHERE id=?').get(created.id);
  closeDatabaseForTests();assert.deepEqual(getDatabase().prepare('SELECT * FROM health_process_symptoms WHERE id=?').get(created.id),record);assert.deepEqual(readdirSync(join(root,'backups','db')),backups);
  assert.equal(getDatabase().prepare('PRAGMA foreign_key_check').get(),undefined);
 }finally{closeDatabaseForTests();if(previous===undefined)delete process.env.STORAGE_DIR;else process.env.STORAGE_DIR=previous;rmSync(root,{recursive:true,force:true});}
});

test('reapplying the current symptom schema preserves saved records and never synthesizes early symptom payloads',()=>{
 const db=new DatabaseSync(':memory:');try{
  db.exec("CREATE TABLE health_episodes(id TEXT PRIMARY KEY);CREATE TABLE users(id TEXT PRIMARY KEY);INSERT INTO health_episodes(id) VALUES('container')");ensureHealthProcessDraft(db);
  db.exec("INSERT INTO health_process_symptoms(id,episode_id,name) VALUES('saved','container','Synthetic');CREATE TABLE symptom_episode_details(episode_id TEXT);INSERT INTO symptom_episode_details VALUES('unreleased-draft')");
  const saved=db.prepare('SELECT * FROM health_process_symptoms').all();ensureHealthProcessDraft(db);assert.deepEqual(db.prepare('SELECT * FROM health_process_symptoms').all(),saved);
  for(const column of ['legacy_episode_id','baseline_status','baseline_ended_at'])assert.equal(db.prepare('PRAGMA table_info(health_process_symptoms)').all().some(r=>r.name===column),false);
 }finally{db.close();}
});
