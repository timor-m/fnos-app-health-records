import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {getDatabase,closeDatabaseForTests} from '../database/client';
import type {RequestUser} from '../domain/request-user';
import {organizeHealthDocuments} from '../services/health-document-organizer.service';
import {listHealthRecordFeed} from '../services/health-record-feed.service';
const user:RequestUser={id:'manager',displayName:'Synthetic',provider:'development',authenticated:true,isGatewayAdmin:true};
function fixture(run:()=>void){const prior=process.env.STORAGE_DIR;const dir=mkdtempSync(join(tmpdir(),'document-groups-'));process.env.STORAGE_DIR=dir;
 try{const db=getDatabase();db.exec("INSERT INTO users(id,display_name) VALUES('manager','Synthetic');INSERT INTO health_members(id,display_name,created_by) VALUES('member','Synthetic','manager'),('other','Synthetic','manager');INSERT INTO member_permissions(member_id,user_id,permission,granted_by) VALUES('member','manager','manager','manager')");
 for(const id of ['a','b','c','foreign'])db.prepare("INSERT INTO reports(id,member_id,created_by,title,report_type,status) VALUES(?,?,'manager','Synthetic','laboratory','ready')").run(id,id==='foreign'?'other':'member');run();
 }finally{closeDatabaseForTests();if(prior===undefined)delete process.env.STORAGE_DIR;else process.env.STORAGE_DIR=prior;rmSync(dir,{recursive:true,force:true});}}
test('confirmed document groups remain visible and retries never duplicate a group',()=>fixture(()=>{
 const body={memberId:'member',requestKey:'document-group-test-key',groups:[{reportIds:['a','b'],title:'Synthetic'},{reportIds:['c']}]};
 const saved=organizeHealthDocuments(user,body);assert.deepEqual(organizeHealthDocuments(user,body),saved);assert.equal(saved.groups.length,1);
 const feed=listHealthRecordFeed(user,{memberId:'member'});assert.equal(feed.items.length,2);assert.deepEqual(feed.items.flatMap(r=>r.documents.map(d=>d.id)).sort(),['a','b','c']);
 assert.equal(getDatabase().prepare('SELECT COUNT(*) AS n FROM health_events').get()!.n,1);
 assert.equal(getDatabase().prepare('SELECT COUNT(*) AS n FROM health_record_processes').get()!.n,0);
}));
test('invalid late group and foreign documents leave no partial groups or retry receipts',()=>fixture(()=>{
 for(const id of ['missing','foreign']){
  assert.throws(()=>organizeHealthDocuments(user,{memberId:'member',requestKey:'document-group-atomic-key',groups:[{reportIds:['a','b']},{reportIds:['c',id]}]}));
  for(const table of ['health_events','health_event_resources','health_upload_archives','health_workflow_requests'])assert.equal(getDatabase().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n,0);
 }
}));
