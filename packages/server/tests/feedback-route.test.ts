import { getAppConfig } from '../utils/runtime-config';
import assert from 'node:assert/strict';
import test from 'node:test';
import { H3 } from 'h3';
import { mkdtempSync,rmSync,readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import handler from '../routes/api/feedback/[...path]';
import { closeDatabaseForTests } from '../database/client';
import { readFeedbackInstallation } from '../services/feedback-installation.service';
import { getDatabase } from '../database/client';
import { getFeedbackInstallation } from '../services/feedback-installation.service';
import { recordFeedbackStates } from '../services/feedback-sync.service';

test('local authenticated route forwards only feedback operations and edited image bytes',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'feedback-route-')),env={...process.env},originalFetch=globalThis.fetch;
 process.env.STORAGE_DIR=dir;process.env.DISABLE_JOB_RUNNER='true';
 const calls:{url:string;headers:Headers;body?:BodyInit|null}[]=[];
 globalThis.fetch=async(url,init)=>{calls.push({url:String(url),headers:new Headers(init?.headers),body:init?.body});return Response.json({success:true,data:String(url).endsWith('/feedback-attachments')?{id:1,url:'/uploads/example.png',relativePath:'private'}:init?.method==='POST'?{number:'B0001',status:'received',version:1}:{items:[],total:0}});};
 let authenticated=false;
 const app=new H3();app.use(e=>{e.context.requestUser={id:'synthetic',authenticated};});app.all('/api/feedback/**:path',handler);
 try {
  assert.equal((await app.request('http://localhost/api/feedback/tickets')).status,401);assert.equal(calls.length,0);assert.equal(readFeedbackInstallation(getDatabase()),null);
  assert.equal((await app.request('http://localhost/api/feedback/identity')).status,401);
  authenticated=true;
  const identityResponse=await app.request('http://localhost/api/feedback/identity');
  assert.equal(identityResponse.status,200);assert.equal(identityResponse.headers.get('cache-control'),'no-store');
  const identity=(await identityResponse.json()).data.clientId;assert.match(identity,/^[A-Za-z0-9_-]{43}$/);assert.equal(calls.length,0);

  assert.equal((await app.request('http://localhost/api/feedback/admin')).status,404);assert.equal(calls.length,0);
  assert.equal((await app.request('http://localhost/api/feedback/indicator-requests',{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':'obsolete-indicator-request'},body:'{}'})).status,404);assert.equal(calls.length,0);
  assert.equal((await app.request('http://localhost/api/feedback/tickets?page=1')).status,200);
  assert.equal(calls[0].url,'https://gateway.lby.link/health/v1/feedbacks?page=1&pageSize=20');const id=calls[0].headers.get('x-client-id');assert.match(id!,/^[A-Za-z0-9_-]{43}$/);assert.equal(id,identity);assert.equal(calls[0].headers.get('x-version'),getAppConfig().appVersion);
  const form=new FormData();form.set('file',new Blob(['edited-synthetic-image'],{type:'image/png'}),'private-original-name.png');
  const uploaded=await app.request('http://localhost/api/feedback/upload',{method:'POST',headers:{'Idempotency-Key':'upload-test','x-client-id':'untrusted','cookie':'private'},body:form});assert.equal(uploaded.status,200);assert.deepEqual((await uploaded.json()).data,{id:1,url:'/uploads/example.png'});
  assert.equal(calls[1].headers.get('x-client-id'),id);assert.equal(calls[1].headers.get('cookie'),null);const file=(calls[1].body as FormData).get('file') as File;assert.equal(file.name,'screenshot.png');assert.equal(await file.text(),'edited-synthetic-image');assert.deepEqual(readdirSync(join(dir,'uploads')),[]);
  const submitted=await app.request('http://localhost/api/feedback/tickets',{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':'submit-test'},body:JSON.stringify({category:'other',title:'合成标题',description:'合成说明',attachmentIds:[1],environment:{app:{version:'synthetic'},database:{schemaVersion:19},server:{platform:'linux'},ai:{enabled:true,visionEnabled:false,provider:'custom',model:'namespace/text:8b',extractionDepth:'detailed'}}})});assert.equal(submitted.status,200);assert.equal(JSON.parse(String(calls[2].body)).appKey,'health-records');assert.equal(JSON.parse(String(calls[2].body)).category,'other');assert.equal(JSON.parse(String(calls[2].body)).environment.server.platform,'linux');assert.equal(JSON.parse(String(calls[2].body)).environment.ai.model,'namespace/text:8b');
  const bad=await app.request('http://localhost/api/feedback/tickets',{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':'submit-test'},body:JSON.stringify({clientId:'private'})});assert.equal(bad.status,400);assert.equal(calls.length,3);
  const pdf=new FormData();pdf.set('file',new Blob(['%PDF-synthetic-original'],{type:'application/pdf'}),'private-name.pdf');
  assert.equal((await app.request('http://localhost/api/feedback/upload',{method:'POST',headers:{'Idempotency-Key':'pdf-upload-test'},body:pdf})).status,200);
  const forwarded=(calls.at(-1)!.body as FormData).get('file') as File;
  assert.equal(forwarded.name,'report.pdf');assert.equal(forwarded.type,'application/pdf');assert.equal(await forwarded.text(),'%PDF-synthetic-original');
 }finally{globalThis.fetch=originalFetch;closeDatabaseForTests();process.env=env;rmSync(dir,{recursive:true,force:true});}
});

test('list pages make one remote request and compare only returned states without duplicate reminders',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'feedback-pages-')),env={...process.env},originalFetch=globalThis.fetch;
 process.env.STORAGE_DIR=dir;process.env.DISABLE_JOB_RUNNER='true';
 const calls:string[]=[];
 const items=Array.from({length:20},(_,i)=>({number:'B'+String(i+21).padStart(4,'0'),status:'confirmed',version:2}));
 let result={items,total:61,page:2,pageSize:20};
 globalThis.fetch=async url=>{calls.push(String(url));return Response.json({success:true,data:result});};
 const app=new H3();app.use(e=>{e.context.requestUser={id:'synthetic',authenticated:true};});app.all('/api/feedback/**:path',handler);
 try {
  const db=getDatabase(),identity=getFeedbackInstallation(db);
  recordFeedbackStates(db,identity,[{number:'B0021',status:'received',version:1}]);
  const response=await app.request('http://localhost/api/feedback/tickets?page=2&pageSize=20');
  assert.equal(response.status,200);assert.deepEqual((await response.json()).data,result);
  assert.deepEqual(calls,['https://gateway.lby.link/health/v1/feedbacks?page=2&pageSize=20']);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM feedback_sync_state').get()?.n,20);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM feedback_notifications').get()?.n,1);
  assert.equal((await app.request('http://localhost/api/feedback/tickets?page=2&pageSize=20')).status,200);
  assert.equal(calls.length,2);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM feedback_notifications').get()?.n,1);
  result={items:[{number:'B0061',status:'received',version:1}],total:61,page:4,pageSize:20};
  const last=await app.request('http://localhost/api/feedback/tickets?page=4&pageSize=20');
  assert.equal(last.status,200);assert.deepEqual((await last.json()).data,result);
  assert.equal(calls.length,3);assert.equal(calls[2],'https://gateway.lby.link/health/v1/feedbacks?page=4&pageSize=20');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM feedback_sync_state').get()?.n,21);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM feedback_notifications').get()?.n,1);
 }finally{globalThis.fetch=originalFetch;closeDatabaseForTests();process.env=env;rmSync(dir,{recursive:true,force:true});}
});

test('search and filters preserve remote pagination; invalid pages and failed requests do not change local states',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'feedback-search-')),env={...process.env},originalFetch=globalThis.fetch;
 process.env.STORAGE_DIR=dir;process.env.DISABLE_JOB_RUNNER='true';
 const calls:string[]=[];
 const result={items:[{number:'B0021',status:'received',version:1}],total:25,page:2,pageSize:20};
 let fail=false;
 globalThis.fetch=async url=>{calls.push(String(url));if(fail)throw new Error('synthetic outage');return Response.json({success:true,data:result});};
 const app=new H3();app.use(e=>{e.context.requestUser={id:'synthetic',authenticated:true};});app.all('/api/feedback/**:path',handler);
 try {
  for(const filter of ['q=synthetic','number=B0021','status=received&category=problem']) {
   const count=calls.length;
   const response=await app.request('http://localhost/api/feedback/tickets?page=2&pageSize=20&'+filter);
   assert.equal(response.status,200);assert.deepEqual((await response.json()).data,result);
   assert.equal(calls.length,count+1);
   assert.equal(calls.at(-1),'https://gateway.lby.link/health/v1/feedbacks?page=2&pageSize=20&'+filter);
  }
  const count=calls.length;
  for(const query of ['page=0','page=1.5','page=10001','pageSize=0','pageSize=51','q=synthetic&pageSize=invalid']) {
   assert.equal((await app.request('http://localhost/api/feedback/tickets?'+query)).status,400);
  }
  assert.equal(calls.length,count);
  const db=getDatabase(),before=db.prepare('SELECT * FROM feedback_sync_state').all();
  fail=true;
  assert.equal((await app.request('http://localhost/api/feedback/tickets?page=3&pageSize=20')).status,502);
  assert.equal(calls.length,count+1);
  assert.deepEqual(db.prepare('SELECT * FROM feedback_sync_state').all(),before);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM feedback_notifications').get()?.n,0);
 }finally{globalThis.fetch=originalFetch;closeDatabaseForTests();process.env=env;rmSync(dir,{recursive:true,force:true});}
});

test('attachment proxy requires local login, injects installation identity and returns only bounded image bytes',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'feedback-image-')),env={...process.env},originalFetch=globalThis.fetch;
 process.env.STORAGE_DIR=dir;process.env.DISABLE_JOB_RUNNER='true';
 const calls:{url:string;headers:Headers}[]=[];let authenticated=false,denied=false;
 globalThis.fetch=async(url,init)=>{calls.push({url:String(url),headers:new Headers(init?.headers)});assert.equal(init?.redirect,'error');return denied?Response.json({success:false},{status:404}):new Response('synthetic-image',{headers:{'Content-Type':'image/png','Set-Cookie':'untrusted=1'}});};
 const app=new H3();app.use(e=>{e.context.requestUser={id:'synthetic',authenticated};});app.all('/api/feedback/**:path',handler);
 try {
  assert.equal((await app.request('http://localhost/api/feedback/attachments/42')).status,401);assert.equal(calls.length,0);
  authenticated=true;
  const image=await app.request('http://localhost/api/feedback/attachments/42',{headers:{'x-client-id':'forged','Authorization':'Bearer forged','cookie':'private'}});
  assert.equal(image.status,200);assert.equal(await image.text(),'synthetic-image');assert.equal(image.headers.get('content-type'),'image/png');assert.equal(image.headers.get('cache-control'),'private, no-store');assert.equal(image.headers.get('x-content-type-options'),'nosniff');assert.equal(image.headers.get('set-cookie'),null);
  assert.equal(calls[0].url,'https://gateway.lby.link/health/v1/feedback-attachments/42');assert.match(calls[0].headers.get('x-client-id')!,/^[A-Za-z0-9_-]{43}$/);assert.equal(calls[0].headers.get('authorization'),null);assert.equal(calls[0].headers.get('cookie'),null);
  assert.equal((await app.request('http://localhost/api/feedback/attachments/42?url=https://untrusted.invalid')).status,400);assert.equal(calls.length,1);
  denied=true;assert.equal((await app.request('http://localhost/api/feedback/attachments/43')).status,404);
 }finally{globalThis.fetch=originalFetch;closeDatabaseForTests();process.env=env;rmSync(dir,{recursive:true,force:true});}
});
