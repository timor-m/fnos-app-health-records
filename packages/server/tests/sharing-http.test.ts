import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {H3} from 'h3';
import {getDatabase,closeDatabaseForTests} from '../database/client';
import {createMember,setMemberPermission} from '../services/member.service';
import {createUpload} from '../services/upload.service';
import original from '../routes/api/reports/[id]/pages/[pageId]/original.get';
import upload from '../routes/api/uploads.post';
import sharingAccounts from '../routes/api/members/[id]/sharing-accounts.get';
import batchPermissions from '../routes/api/members/permissions.put';
import errorHandler from '../error-handler';
import type {RequestUser} from '../domain/request-user';

test('viewer original requests are non-cacheable, cross-report IDs fail, revoked URLs and writes fail',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'sharing-http-'));const env={...process.env};process.env.STORAGE_DIR=dir;process.env.AUTH_MODE='fnos';process.env.GATEWAY_PREFIX='/';
 try {
  const db=getDatabase();db.exec("INSERT INTO users(id,display_name) VALUES('a','fixture'),('b','fixture'); INSERT INTO user_identities(id,user_id,provider,subject) VALUES('ia','a','fnos_gateway','a'),('ib','b','fnos_gateway','b')");
  const owner:RequestUser={id:'a',displayName:'fixture',provider:'fnos_gateway',authenticated:true,isGatewayAdmin:false};const viewer={...owner,id:'b'};
  const member=createMember(owner,{displayName:'合成档案',relationship:'other'});setMemberPermission(owner,member.id,{userId:'b',permission:'viewer',version:0});
  const report=createUpload(owner,member.id,[{originalName:'fixture.pdf',data:Buffer.from('%PDF-1.4\n%%EOF')}]);
  const other=createUpload(owner,member.id,[{originalName:'fixture.pdf',data:Buffer.from('%PDF-1.4\n%%EOF')}]);
  const app=new H3({onError:errorHandler});app.use(event=>{event.context.requestUser=viewer;});
  app.get('/api/reports/:id/pages/:pageId/original',original);app.post('/api/uploads',upload);
  const url=`http://localhost/api/reports/${report.reportId}/pages/${report.pages[0].id}/original`;
  const allowed=await app.request(url,{headers:{range:'bytes=0-4'}});assert.equal(allowed.status,200);assert.equal(allowed.headers.get('cache-control'),'private, no-store');await allowed.arrayBuffer();
  const wrong=await app.request(url.replace(report.reportId,other.reportId));assert.equal(wrong.status,404);
  const body=new FormData();body.append('memberId',member.id);body.append('files',new Blob(['%PDF-1.4\n%%EOF']),'fixture.pdf');
  assert.equal((await app.request('http://localhost/api/uploads',{method:'POST',body})).status,403);
  setMemberPermission(owner,member.id,{userId:'b',permission:null,version:1});
  const revoked=await app.request(url,{headers:{range:'bytes=0-4'}});assert.equal(revoked.status,404);
  assert.equal((await revoked.json()).message,(await wrong.json()).message);
 } finally {closeDatabaseForTests();process.env=env;rmSync(dir,{recursive:true,force:true});}
});

test('member account picker endpoint allows sharing managers but not unrelated administrators',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'sharing-accounts-http-'));const env={...process.env};
 process.env.STORAGE_DIR=dir;process.env.AUTH_MODE='fnos';process.env.GATEWAY_PREFIX='/';
 try {
  const db=getDatabase();db.exec("INSERT INTO users(id,display_name) VALUES('owner','测试账号'),('admin','测试维护'); INSERT INTO user_identities(id,user_id,provider,subject) VALUES('owner-i','owner','fnos_gateway','owner'),('admin-i','admin','fnos_gateway','admin')");
  const owner:RequestUser={id:'owner',displayName:'测试账号',provider:'fnos_gateway',authenticated:true,isGatewayAdmin:false};
  let actor:RequestUser=owner;
  const member=createMember(owner,{displayName:'测试档案',relationship:'other'});
  const app=new H3({onError:errorHandler});app.use(event=>{event.context.requestUser=actor;});
  app.get('/api/members/:id/sharing-accounts',sharingAccounts);
  app.put('/api/members/permissions',batchPermissions);
  const url=`http://localhost/api/members/${member.id}/sharing-accounts`;
  const allowed=await app.request(url);assert.equal(allowed.status,200);
  const payload=await allowed.json();
  assert.deepEqual(new Set(payload.data.map((account:{id:string})=>account.id)),new Set(['owner','admin']));
  assert.ok(payload.data.every((account:object)=>Object.keys(account).sort().join(',')==='displayName,id'));
  actor={...owner,id:'admin',isAdmin:true,isGatewayAdmin:true};
  assert.equal((await app.request(url)).status,404);
  const batchBody=JSON.stringify({members:[{memberId:member.id,version:0}],userId:'admin',permission:'viewer'});
  assert.equal((await app.request('http://localhost/api/members/permissions',{method:'PUT',headers:{'content-type':'application/json'},body:batchBody})).status,404);
  actor=owner;
  assert.equal((await app.request('http://localhost/api/members/permissions',{method:'PUT',headers:{'content-type':'application/json'},body:batchBody})).status,200);

 } finally {closeDatabaseForTests();process.env=env;rmSync(dir,{recursive:true,force:true});}
});
