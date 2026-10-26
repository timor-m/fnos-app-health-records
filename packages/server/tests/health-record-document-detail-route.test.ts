import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { H3 } from 'h3';
import duplicatesHandler from '../routes/api/reports/[id]/duplicate-candidates.get.ts';
import reportHandler from '../routes/api/reports/[id].get.ts';
import handler from '../routes/api/health-records/documents/[id].get.ts';
import { closeDatabaseForTests, getDatabase } from '../database/client.ts';
import { createUpload } from '../services/upload.service.ts';

test('document detail expansion returns the selected report without weakening member access', async () => {
 const directory=mkdtempSync(join(tmpdir(),'document-detail-'));
 const previous=process.env.STORAGE_DIR;process.env.STORAGE_DIR=directory;
 try {
  const db=getDatabase();
  db.exec(`INSERT INTO users(id,display_name) VALUES('owner','Synthetic'),('other','Synthetic');
   INSERT INTO health_members(id,display_name,created_by) VALUES('member','Synthetic','owner');
   INSERT INTO member_permissions(member_id,user_id,permission,granted_by) VALUES('member','owner','manager','owner');`);
  const owner={id:'owner',displayName:'Synthetic',provider:'fnos_gateway' as const,authenticated:true,isGatewayAdmin:false};
  const uploaded=createUpload(owner,'member',[{originalName:'synthetic.png',data:Buffer.from([137,80,78,71,13,10,26,10,1])}]);
  let identity=owner;
  const app=new H3();app.use(event=>{event.context.requestUser=identity;});
  app.get('/api/health-records/documents/:id',handler);
  app.get('/api/reports/:id',reportHandler);
  app.get('/api/reports/:id/duplicate-candidates',duplicatesHandler);
  const url=`http://localhost/api/health-records/documents/${uploaded.reportId}`;
  const plain=await app.request(url);assert.equal(plain.status,200);
  const metadata=(await plain.json()).data;assert.equal(metadata.memberId,'member');assert.equal(metadata.detail,undefined);
  const expanded=await app.request(`${url}?includeDetail=true`);assert.equal(expanded.status,200);
  const payload=(await expanded.json()).data;
  assert.deepEqual(payload.documents,metadata.documents);assert.equal(payload.detail.id,uploaded.reportId);
  assert.equal(payload.detail.memberId,'member');assert.equal(payload.detail.pages.length,1);
  db.prepare("UPDATE reports SET status='needs_review' WHERE id=?").run(uploaded.reportId);
  const readUrl=`http://localhost/api/reports/${uploaded.reportId}`;
  const full=(await (await app.request(readUrl)).json()).data;
  const content=(await (await app.request(`${readUrl}?includeDuplicateCandidates=false`)).json()).data;
  assert.deepEqual(content.pages,full.pages);assert.deepEqual(content.observations,full.observations);
  assert.equal(content.duplicateCandidatesPending,true);assert.equal(content.duplicateSearch,undefined);
  assert.equal(full.duplicateCandidatesPending,undefined);
  const candidates=(await (await app.request(`${readUrl}/duplicate-candidates`)).json()).data;
  assert.deepEqual(candidates.duplicateCandidates,full.duplicateCandidates);
  assert.equal(candidates.memberId,full.memberId);assert.equal(candidates.sourceVersion,full.sourceVersion);assert.equal(candidates.updatedAt,full.updatedAt);
  const expandedReview=(await (await app.request(`${url}?includeDetail=true`)).json()).data;
  assert.equal(expandedReview.detail.duplicateCandidatesPending,true);
  db.prepare("UPDATE reports SET status='ready' WHERE id=?").run(uploaded.reportId);
  const archived=(await (await app.request(`${readUrl}?includeDuplicateCandidates=false`)).json()).data;
  assert.equal(archived.duplicateCandidatesPending,false);
  identity={...owner,id:'other'};
  assert.equal((await app.request(`${readUrl}/duplicate-candidates`)).status,403);
  assert.equal((await app.request(`${url}?includeDetail=true`)).status,403);
  assert.equal((await app.request('http://localhost/api/health-records/documents/missing?includeDetail=true')).status,404);
 } finally {
  closeDatabaseForTests();if(previous===undefined)delete process.env.STORAGE_DIR;else process.env.STORAGE_DIR=previous;
  rmSync(directory,{recursive:true,force:true});
 }
});
