import {createMember} from "../services/member.service";
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { H3, type H3Event } from 'h3';
import { withMultipartUpload } from '../utils/read-multipart-upload';
import { readUploadFile } from '../utils/read-upload-file';
import { toApiErrorPayload } from '../utils/api-error';
import { getRequestUser } from '../utils/request-user';
import { closeDatabaseForTests, getDatabase } from '../database/client';
import { createFullBackup } from '../services/records.service';
import uploads from '../routes/api/uploads.post';
import restore from '../routes/api/backups/restore-upload.post';
import errorHandler from '../error-handler';

async function withStorage(run: (dir:string)=>Promise<void>) {
  const dir=mkdtempSync(join(tmpdir(),'multipart-test-'));
  process.env.STORAGE_DIR=dir; process.env.AUTH_MODE='fnos';
  try { await run(dir); }
  finally { closeDatabaseForTests(); delete process.env.STORAGE_DIR; delete process.env.AUTH_MODE; rmSync(dir,{recursive:true,force:true}); }
}
function event(body: BodyInit, headers?: HeadersInit) {
  const req=new Request('http://localhost/upload',{method:'POST',body,headers,duplex:'half'} as RequestInit);
  return {req, headers:req.headers} as H3Event;
}
const limits={requestBytes:8192,fileBytes:2048,files:2,sizeMessage:'上传超过限制'};
function form(size=1024,name='file',filename='测试.pdf') {
  const data=new FormData(); data.set('memberId','member-test');
  data.append(name,new Blob([new Uint8Array(size).fill(42)],{type:'application/pdf'}),filename);
  return data;
}
function clean(dir:string) { assert.deepEqual(readdirSync(join(dir,'uploads')),[]); }

test('multipart streams files onto archive storage, preserving UTF-8 names, bytes, and owner-only permissions',()=>withStorage(async dir=>{
  await withMultipartUpload(event(form()),limits,({fields,files})=>{
    assert.equal(fields.memberId,'member-test'); assert.equal(files[0].filename,'测试.pdf');
    assert.equal(files[0].size,1024); assert.deepEqual(readFileSync(files[0].path),Buffer.alloc(1024,42));
    assert.ok(files[0].path.startsWith(join(dir,'uploads'))); assert.equal(statSync(files[0].path).mode & 0o777,0o600);
  }); clean(dir);
  const file=await readUploadFile(event(form()));
  assert.equal(file.name,'测试.pdf'); assert.deepEqual(Buffer.from(await file.arrayBuffer()),Buffer.alloc(1024,42)); clean(dir);
}));

test('multipart counts actual bytes without Content-Length or with a false small length and cancels the input',()=>withStorage(async dir=>{
  for(const header of [undefined,'1']) {
    let cancelled=false; let sent=0;
    const body=new ReadableStream({pull(c){sent++; if(sent>8) c.close(); else c.enqueue(new Uint8Array(4096).fill(65));},cancel(){cancelled=true;}});
    const headers:Record<string,string>={'content-type':'multipart/form-data; boundary=test'};
    if(header) headers['content-length']=header;
    await assert.rejects(()=>withMultipartUpload(event(body,headers),limits,()=>assert.fail('must not consume oversized input')),e=>toApiErrorPayload(e).status===413);
    assert.equal(cancelled,true); assert.ok(sent<10); clean(dir);
  }
}));

test('multipart accepts the exact file limit and rejects oversized files, fields, excess parts, and interrupted streams',()=>withStorage(async dir=>{
  await withMultipartUpload(event(form(2048)),limits,({files})=>assert.equal(files[0].size,2048)); clean(dir);
  const tooMany=form(); for(let i=0;i<2;i++) tooMany.append('file',new Blob(['x']),'extra.pdf');
  const bigField=form(); bigField.set('extra','x'.repeat(1024*1024+1));
  for(const [body,options] of [[form(2049),limits],[tooMany,limits],[bigField,{...limits,requestBytes:2*1024*1024}]] as const) {
    await assert.rejects(()=>withMultipartUpload(event(body),options,()=>assert.fail()),e=>toApiErrorPayload(e).status===413); clean(dir);
  }
  const encoded=new Request('http://localhost',{method:'POST',body:form()});
  const bytes=new Uint8Array(await encoded.arrayBuffer()); let started=false;
  const broken=new ReadableStream({pull(c){if(!started){started=true;c.enqueue(bytes.subarray(0,500));}else c.error(new Error('private transport detail'));}});
  await assert.rejects(()=>withMultipartUpload(event(broken,encoded.headers),limits,()=>assert.fail()),e=>toApiErrorPayload(e).status===400); clean(dir);
}));

test('write failures remain storage errors and consumer failures clean temporary files',()=>withStorage(async dir=>{
  await withMultipartUpload(event(form()),limits,()=>{});
  chmodSync(join(dir,'uploads'),0o500);
  try { await assert.rejects(()=>withMultipartUpload(event(form()),limits,()=>assert.fail()),e=>toApiErrorPayload(e).code==='STORAGE_UNAVAILABLE'); }
  finally { chmodSync(join(dir,'uploads'),0o700); }
  const sentinel=new Error('consumer failure');
  await assert.rejects(()=>withMultipartUpload(event(form()),limits,()=>{throw sentinel;}),e=>e===sentinel); clean(dir);
}));

function authenticatedApp() {
  const user=getRequestUser({context:{},node:{req:{healthAccessMode:'gateway',headers:{'x-trim-userid':'route-test','x-trim-username':'Test','x-trim-isadmin':'true'}}}} as unknown as H3Event);
  const app=new H3({onError:errorHandler}); app.use(e=>{e.context.requestUser=user;});
  return {app,user};
}

test('legacy multipart report upload preserves manifest order, rotation, file names and retry result',()=>withStorage(async dir=>{
  const {app,user}=authenticatedApp(); app.post('/api/uploads',uploads);
  const {id}=createMember(user,{displayName:'合成测试',createSelf:true});
  const body=new FormData(); const bytes=Buffer.from('%PDF-1.4\n%%EOF');
  body.set('memberId',id); body.set('requestKey','legacy-request-0001');
  body.set('manifest',JSON.stringify({pages:[{size:bytes.length,rotation:90}]})); body.append('files',new Blob([bytes]),'示例.pdf');
  const first=await app.request('http://localhost/api/uploads',{method:'POST',body}); assert.equal(first.status,201);
  const result=await first.json(); assert.equal(result.data.pages[0].originalName,'示例.pdf'); assert.equal(result.data.pages[0].rotation,90);
  const second=await app.request('http://localhost/api/uploads',{method:'POST',body}); assert.equal(second.status,201);
  assert.deepEqual(await second.json(),result); clean(dir);
}));

test('uploaded backup restores through the existing validator and rejects unauthorized requests before reading',()=>withStorage(async dir=>{
  const {app,user}=authenticatedApp(); app.post('/api/backups/restore-upload',restore);
  const backup=createFullBackup(user);
  const path=backup.path;
  assert.equal(existsSync(path),true);
  const db=getDatabase(); db.prepare('UPDATE users SET display_name=? WHERE id=?').run('Changed',user.id);
  const body=new FormData(); body.append('backup',new Blob([readFileSync(path)]),'backup.tar.gz');
  const preview=await app.request('http://localhost/api/backups/restore-upload',{method:'POST',body});
  const plan=(await preview.json()).data;assert.equal(plan.strategy,'same');body.append('token',plan.token);
  const response=await app.request('http://localhost/api/backups/restore-upload',{method:'POST',body});
  assert.equal(response.status,200); assert.equal((await response.json()).data.restored,true); clean(dir);
  assert.equal(readdirSync(join(dir,"backups")).some(name => name.startsWith(".check-") || name.startsWith(".restore-")),false);
  let pulled=false;
  const req=new Request('http://localhost/upload',{method:'POST',body:new ReadableStream({pull(){pulled=true;}},{highWaterMark:0}),duplex:'half'} as RequestInit);
  await assert.rejects(()=>restore({req,headers:req.headers,context:{requestUser:{...user,isAdmin:false,isGatewayAdmin:false}}} as unknown as H3Event),e=>toApiErrorPayload(e).status===403);
  assert.equal(pulled,false);
}));
