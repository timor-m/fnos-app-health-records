import { getAppConfig } from '../utils/runtime-config';
import { deploymentType, feedbackUserAgent } from '../utils/deployment';
import { validateFeedbackEnvironment } from '../services/feedback-validation';
import assert from 'node:assert/strict';
import test from 'node:test';
import { FEEDBACK_APP_ID, type FeedbackAppsIdentity } from '../services/feedback-installation.service';
import { sendFeedbackRequest } from '../services/feedback-remote.service';

const syntheticIdentity = (clientId = 'synthetic'): FeedbackAppsIdentity => ({
  headers: { 'x-app-id': FEEDBACK_APP_ID, 'x-client-id': clientId },
  localKey: clientId,
  clientId,
  deviceId: null,
});
const deps = (fetch: typeof globalThis.fetch, identity: FeedbackAppsIdentity = syntheticIdentity()) => ({
  fetch,
  resolveIdentity: () => identity,
});

test('feedback proxy uses fixed HTTPS destination, server identity, idempotency and no redirects',async()=>{
 let calls=0;
 const fetch:typeof globalThis.fetch=async (url,options)=>{calls++;assert.equal(String(url),'https://gateway.lby.link/apps/v1/feedbacks');assert.equal(new Headers(options?.headers).get('x-app-id'),FEEDBACK_APP_ID);assert.equal(new Headers(options?.headers).get('x-client-id'),'synthetic');assert.equal(new Headers(options?.headers).get('x-version'), getAppConfig().appVersion);assert.equal(new Headers(options?.headers).get('x-debug'), getAppConfig().authMode==='development'?'1':null);assert.equal(new Headers(options?.headers).get('Idempotency-Key'),'retry-test');assert.equal(options?.redirect,'error');assert.equal(new Headers(options?.headers).get('cookie'),null);return Response.json({success:true,data:{number:'B0001'}});};
 assert.deepEqual(await sendFeedbackRequest('/tickets',{method:'POST',key:'retry-test',json:true,body:'{}'},deps(fetch)),{number:'B0001'});assert.equal(calls,1);
});

test('development feedback requests send x-debug so upstream skips installation statistics',async()=>{
 const env={...process.env};
 process.env.VITE_DEV_SERVER_URL='http://127.0.0.1:5173';
 process.env.STORAGE_DIR=process.env.STORAGE_DIR||'/tmp/health-records-feedback-debug-test';
 try {
  assert.equal(getAppConfig().authMode,'development');
  let seen:string|null=null;
  const fetch:typeof globalThis.fetch=async (_url,options)=>{
   seen=new Headers(options?.headers).get('x-debug');
   return Response.json({success:true,data:{items:[],total:0}});
  };
  await sendFeedbackRequest('/tickets',{},deps(fetch));
  assert.equal(seen,'1');
 } finally { process.env=env; }
});
test('all feedback operations use an application UA without forwarding browser or installation details',async()=>{
 const config=getAppConfig();let calls=0;
 const fetch:typeof globalThis.fetch=async (_url,options)=>{
  const headers=new Headers(options?.headers);assert.equal(headers.get('user-agent'),feedbackUserAgent(config.appVersion,deploymentType(config.authMode)));
  assert.equal(headers.get('x-version'),config.appVersion);assert.equal(headers.get('x-app-id'),FEEDBACK_APP_ID);assert.doesNotMatch(headers.get('user-agent')!,/synthetic|Mozilla|AppleWebKit/);calls++;
  return Response.json({success:true,data:{items:[],total:0}});
 };
 for(const path of ['/tickets?page=1&pageSize=50','/tickets/B0001','/upload','/tickets','/tickets/B0001/messages','/tickets/B0001/resolution']) await sendFeedbackRequest(path,{}, deps(fetch));
 assert.equal(calls,6);
});
test('upstream errors never expose response credentials, raw URLs or content',async()=>{
 const fetch:typeof globalThis.fetch=async ()=>Response.json({success:false,message:'SYNTHETIC_PRIVATE'},{status:409});
 await assert.rejects(sendFeedbackRequest('/tickets',{}, deps(fetch)),(error:any)=>error.status===409&&!String(error).includes('SYNTHETIC_PRIVATE'));
 const broken:typeof globalThis.fetch=async()=>{throw new Error('SYNTHETIC_PRIVATE');};
 await assert.rejects(sendFeedbackRequest('/tickets',{}, deps(broken)),(error:any)=>error.status===502&&!String(error).includes('SYNTHETIC_PRIVATE'));
});

test('DEVICE_ID_CONFLICT and identity errors surface fixed messages without regenerating identity',async()=>{
 let resolved=0;
 const identity=syntheticIdentity();
 const cases:[number,string,string,number][]=[
  [409,'DEVICE_ID_CONFLICT','当前安装已绑定其他设备',409],
  [401,'INSTALLATION_AUTH_INVALID','反馈安装身份无效',502],
  [401,'APP_IDENTITY_REQUIRED','反馈服务缺少应用身份',502],
 ];
 for(const [status,code,message,expectedStatus] of cases){
  resolved=0;
  await assert.rejects(
   sendFeedbackRequest('/tickets',{},{
    fetch:async()=>Response.json({success:false,message:'SYNTHETIC_PRIVATE',data:{code}},{status}),
    resolveIdentity:()=>{resolved++;return identity;},
   }),
   (error:any)=>error.status===expectedStatus&&String(error.statusMessage||error.message).includes(message)&&!String(error).includes('SYNTHETIC_PRIVATE')&&error.data?.code===code,
  );
  assert.equal(resolved,1);
 }
});

test('environment rejects nested secrets and unapproved data before forwarding',()=>{
 assert.doesNotThrow(()=>validateFeedbackEnvironment({app:{version:'1'},ocr:{available:false}}));
 for(const value of [{app:{buildId:'secret'}},{ai:{apiKey:'secret'}},{reports:[]},{app:{version:{secret:'value'}}}]) assert.throws(()=>validateFeedbackEnvironment(value));
});

test('AI environment validates safe active models and preserves legacy snapshots',()=>{
 const ai={enabled:true,visionEnabled:true,provider:'custom',model:'namespace/text:8b',visionModel:'vision-v1',extractionDepth:'detailed'};
 for(const value of [ai,{enabled:false,visionEnabled:false},{enabled:true,visionEnabled:false}]) assert.doesNotThrow(()=>validateFeedbackEnvironment({ai:value}));
 for(const patch of [{model:'https://synthetic.invalid'},{model:'ep-synthetic'},{model:'sk-synthetic'},{model:'/private/model'},{model:3},{provider:'private-provider'},{extractionDepth:'unknown'},{enabled:false},{visionEnabled:false},{baseUrl:'https://synthetic.invalid'}]) assert.throws(()=>validateFeedbackEnvironment({ai:{...ai,...patch}}));
});

test('binary image responses reject wrong types, oversized bodies and stream errors without exposing content',async()=>{
 for(const response of [new Response('private',{headers:{'Content-Type':'text/html'}}),new Response('private',{headers:{'Content-Type':'image/png','Content-Length':String(10*1024*1024+1)}}),new Response(new Uint8Array(10*1024*1024+1),{headers:{'Content-Type':'image/png'}}),new Response(new ReadableStream({start(c){c.error(new Error('SYNTHETIC_PRIVATE'));}}),{headers:{'Content-Type':'image/png'}})]) {
  await assert.rejects(sendFeedbackRequest('/attachments/42',{image:true},deps(async()=>response)),(e:any)=>e.status===502&&!String(e).includes('SYNTHETIC_PRIVATE'));
 }
});

test('PDF attachment bytes use the same private bounded download proxy',async()=>{
 const result=await sendFeedbackRequest('/attachments/42',{image:true},deps(async()=>new Response('%PDF-synthetic',{headers:{'Content-Type':'application/pdf'}}))) as {bytes:Buffer;mimeType:string};
 assert.equal(result.mimeType,'application/pdf');assert.equal(result.bytes.toString(),'%PDF-synthetic');
 await assert.rejects(sendFeedbackRequest('/attachments/42',{image:true},deps(async()=>new Response('too large',{headers:{'Content-Type':'application/pdf','Content-Length':String(10*1024*1024+1)}}))));
});
