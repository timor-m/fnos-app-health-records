import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { H3 } from 'h3';
import duplicatesHandler from '../routes/api/reports/[id]/duplicate-candidates.get.ts';
import reportHandler from '../routes/api/reports/[id].get.ts';
import { closeDatabaseForTests, getDatabase } from '../database/client.ts';
import { createUpload } from '../services/upload.service.ts';

test('report content-first reads preserve detail, duplicate results and access checks', async () => {
 const directory=mkdtempSync(join(tmpdir(),'document-detail-'));
 const previous=process.env.STORAGE_DIR;process.env.STORAGE_DIR=directory;
 try {
  const db=getDatabase();
  db.exec(`INSERT INTO users(id,display_name) VALUES('owner','Synthetic'),('other','Synthetic');
   INSERT INTO health_members(id,display_name,created_by) VALUES('member','Synthetic','owner');
   INSERT INTO member_permissions(member_id,user_id,permission,granted_by) VALUES('member','owner','manager','owner');`);
  const owner={id:'owner',displayName:'Synthetic',provider:'fnos_gateway' as const,authenticated:true,isGatewayAdmin:false};
  const uploaded=createUpload(owner,'member',[{originalName:'synthetic.png',data:Buffer.from([137,80,78,71,13,10,26,10,1])}]);
  const existing=createUpload(owner,'member',[{originalName:'synthetic-copy.png',data:Buffer.from([137,80,78,71,13,10,26,10,1])}]);
  db.prepare("UPDATE reports SET status='ready' WHERE id=?").run(existing.reportId);
  let identity=owner;
  const app=new H3();app.use(event=>{event.context.requestUser=identity;});
  app.get('/api/reports/:id',reportHandler);
  app.get('/api/reports/:id/duplicate-candidates',duplicatesHandler);
  db.prepare("UPDATE reports SET status='needs_review' WHERE id=?").run(uploaded.reportId);
  const readUrl=`http://localhost/api/reports/${uploaded.reportId}`;
  const full=(await (await app.request(readUrl)).json()).data;
  const content=(await (await app.request(`${readUrl}?includeDuplicateCandidates=false`)).json()).data;
  assert.deepEqual(content.pages,full.pages);assert.deepEqual(content.observations,full.observations);
  assert.equal(content.duplicateCandidatesPending,true);assert.equal(content.duplicateSearch,undefined);
  assert.equal(full.duplicateCandidatesPending,undefined);
  const candidates=(await (await app.request(`${readUrl}/duplicate-candidates`)).json()).data;
  assert.ok(full.duplicateCandidates.some((candidate: {id:string}) => candidate.id === existing.reportId));
  assert.deepEqual(candidates.duplicateCandidates,full.duplicateCandidates);
  assert.equal(candidates.memberId,full.memberId);assert.equal(candidates.sourceVersion,full.sourceVersion);assert.equal(candidates.updatedAt,full.updatedAt);
  db.prepare("UPDATE reports SET status='ready' WHERE id=?").run(uploaded.reportId);
  const archived=(await (await app.request(`${readUrl}?includeDuplicateCandidates=false`)).json()).data;
  assert.equal(archived.duplicateCandidatesPending,false);
  identity={...owner,id:'other'};
  assert.equal((await app.request(`${readUrl}/duplicate-candidates`)).status,403);
  assert.equal((await app.request('http://localhost/api/reports/missing/duplicate-candidates')).status,404);
 } finally {
  closeDatabaseForTests();if(previous===undefined)delete process.env.STORAGE_DIR;else process.env.STORAGE_DIR=previous;
  rmSync(directory,{recursive:true,force:true});
 }
});
