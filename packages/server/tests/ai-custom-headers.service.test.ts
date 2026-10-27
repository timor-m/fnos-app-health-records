import assert from "node:assert/strict";
import test from "node:test";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {H3} from "h3";
import {getDatabase, closeDatabaseForTests} from "../database/client";
import {getAiSettings, getAiTaskSettings, saveAiSettings, testAiConnection} from "../services/ai-settings.service";
import {resolveAiHeaders} from "../services/ai-headers";
import {executeAiTask} from "../services/ai-task.service";
import {isAiExtractionConfigured} from "../services/ai-extraction.service";
import {aiRuntimeHeaders} from "../services/ai-runtime.service";
import modelsPost from "../routes/api/ai/models.post";
import enhancedTest from "../routes/api/ai/test-enhanced.post";
import headersGet from "../routes/api/ai/headers.get";
import {listAiModels} from "../services/ai-models.service";
import {createServer} from "node:http";
import type {AddressInfo} from "node:net";

async function fixture(action:()=>Promise<void>|void) {
  const previous=process.env.STORAGE_DIR, originalFetch=globalThis.fetch;
  const directory=mkdtempSync(join(tmpdir(),'ai-headers-'));
  process.env.STORAGE_DIR=directory;
  try {await action();} finally {
    globalThis.fetch=originalFetch;closeDatabaseForTests();
    if(previous===undefined)delete process.env.STORAGE_DIR;else process.env.STORAGE_DIR=previous;
    rmSync(directory,{recursive:true,force:true});
  }
}
const response=(content='ok')=>new Response(JSON.stringify({choices:[{message:{content},finish_reason:'stop'}]}),{status:200});

test('Go draft model listing and complete tests use the separate catalog while preserving chat paths and headers',()=>fixture(async()=>{
  saveAiSettings({enabled:true,provider:'opencode-go',apiKey:'synthetic-go-key'});
  let rejectChat=false;
  const calls:string[]=[];
  const sessions:string[]=[];
  globalThis.fetch=async(url,init)=>{
    calls.push(String(url));
    const headers=new Headers(init?.headers);
    assert.equal(headers.get('authorization'),'Bearer synthetic-go-key');
    assert.equal(headers.get('x-app'),'synthetic-draft');
    assert.ok(headers.get('x-opencode-session'));
    sessions.push(headers.get('x-opencode-session')!);
    assert.match(headers.get('user-agent')!,/^fnos-app-health-records\//);
    if(String(url)==='https://opencode.ai/inference/go/v1/models') return new Response(JSON.stringify({data:[{id:'glm-5.3'}]}));
    if(String(url)==='https://opencode.ai/inference/go/openai/v1/chat/completions') {
      assert.equal(JSON.parse(String(init?.body)).model,'glm-5.3');
      return rejectChat ? new Response(JSON.stringify({error:{message:'Unauthorized'}}),{status:401}) : response();
    }
    return new Response(null,{status:404});
  };
  const app=new H3();
  app.use(event=>{event.context.requestUser={id:'synthetic-admin',displayName:'Synthetic',provider:'development',authenticated:true,isGatewayAdmin:true};});
  app.post('/models',modelsPost);app.post('/enhanced',enhancedTest);
  const draft={provider:'opencode-go',textModel:'glm-5.3',headers:[{name:'X-App',value:'synthetic-draft'}]};
  const send=(path:string)=>app.request('http://localhost/'+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(draft)});
  const listed=await send('models');
  assert.equal(listed.status,200);
  assert.deepEqual((await listed.json()).data.models,[{id:'glm-5.3',name:'glm-5.3',ownedBy:''}]);
  const complete=(await (await send('enhanced')).json()).data;
  assert.equal(complete.overallSuccess,true);
  assert.equal(complete.steps[0].name,'测试模型列表');
  assert.match(complete.steps[0].message,/API Key 将通过模型调用验证/);
  assert.ok(calls.includes('https://opencode.ai/inference/go/openai/v1/chat/completions'));
  assert.equal(sessions[1],sessions[2]);
  rejectChat=true;
  const failed=(await (await send('enhanced')).json()).data;
  assert.equal(failed.overallSuccess,false);
  assert.equal(failed.steps[0].status,'success');
  assert.equal(failed.steps[1].status,'failed');
  assert.match(failed.steps[1].message,/认证失败/);
}));

test('custom OpenCode addresses receive routing headers and the correct catalog with caller overrides preserved',()=>fixture(async()=>{
  const calls:Array<{url:string;headers:Headers}>=[];
  globalThis.fetch=async(url,init)=>{
    calls.push({url:String(url),headers:new Headers(init?.headers)});
    return new Response(JSON.stringify({data:[{id:'glm-5.3'}]}));
  };
  const input={provider:'custom' as const,baseUrl:'https://opencode.ai/inference/go/openai/v1',apiKey:'synthetic-key'};
  await listAiModels(input);
  assert.equal(calls[0].url,'https://opencode.ai/inference/go/v1/models');
  assert.ok(calls[0].headers.get('x-opencode-session'));
  assert.match(calls[0].headers.get('user-agent')!,/^fnos-app-health-records\//);
  await listAiModels({...input,headers:[{name:'User-Agent',value:'synthetic-client/1'},{name:'X-OpenCode-Session',value:'synthetic-pinned-session'}]});
  assert.equal(calls[1].headers.get('user-agent'),'synthetic-client/1');
  assert.equal(calls[1].headers.get('x-opencode-session'),'synthetic-pinned-session');
}));

test('model list errors expose HTTP status and safe guidance without returning upstream secrets',()=>fixture(async()=>{
  const hints:Record<number,string>={401:'认证失败',403:'访问被拒绝',404:'模型列表地址不存在',429:'请求受限',503:'AI 服务状态'};
  for(const [status,hint] of Object.entries(hints)) {
    globalThis.fetch=async()=>new Response(JSON.stringify({error:{message:'synthetic-private-upstream-content'}}),{status:Number(status)});
    try {
      await listAiModels({provider:'opencode-go',apiKey:'synthetic-key'});
      assert.fail('Expected an upstream error');
    } catch(error:any) {
      assert.equal(error.statusCode,502);
      assert.equal(error.data.meta.upstreamStatus,Number(status));
      assert.match(error.message,new RegExp(`HTTP ${status}`));
      assert.ok(error.message.includes(hint));
      assert.ok(!JSON.stringify(error).includes('synthetic-private-upstream-content'));
    }
  }
}));

test('Go catalog routing preserves a reverse proxy prefix and leaves other providers unchanged',()=>fixture(async()=>{
  const urls:string[]=[];
  globalThis.fetch=async(url)=>{urls.push(String(url));return new Response(JSON.stringify({data:[]}));};
  await listAiModels({provider:'opencode-go',baseUrl:'https://proxy.synthetic.invalid/gateway/inference/go/openai/v1/',apiKey:'synthetic-key'});
  await listAiModels({provider:'custom',baseUrl:'https://proxy.synthetic.invalid/gateway/openai/v1',apiKey:'synthetic-key'});
  assert.deepEqual(urls,['https://proxy.synthetic.invalid/gateway/inference/go/v1/models','https://proxy.synthetic.invalid/gateway/openai/v1/models']);
}));

test('complete Go tests carry one session on actual HTTP model, text and both vision requests',()=>fixture(async()=>{
  const received:Array<{path:string;session:string|undefined;agent:string|undefined;authorization:string|undefined}>=[];
  const upstream=createServer(async(req,res)=>{
    received.push({path:req.url!,session:req.headers['x-opencode-session'] as string|undefined,agent:req.headers['user-agent'],authorization:req.headers.authorization});
    for await(const _chunk of req) { /* Drain the synthetic request body. */ }
    res.setHeader('content-type','application/json');
    res.end(req.method==='GET' ? JSON.stringify({data:[{id:'synthetic-text'}]}) : JSON.stringify({choices:[{message:{content:'red'},finish_reason:'stop'}]}));
  });
  await new Promise<void>(resolve=>upstream.listen(0,'127.0.0.1',resolve));
  try {
    const baseUrl=`http://127.0.0.1:${(upstream.address() as AddressInfo).port}/inference/go/openai/v1`;
    const saved=saveAiSettings({enabled:true,provider:'opencode-go',baseUrl,textModel:'synthetic-text',visionModel:'synthetic-vision',apiKey:'synthetic-key'});
    const app=new H3();
    app.use(event=>{event.context.requestUser={id:'synthetic-admin',displayName:'Synthetic',provider:'development',authenticated:true,isGatewayAdmin:true};});
    app.post('/enhanced',enhancedTest);
    const result=(await (await app.request('http://localhost/enhanced',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({profileId:saved.defaultProfileId})})).json()).data;
    assert.equal(result.overallSuccess,true);
    assert.deepEqual(received.map(item=>item.path),['/inference/go/v1/models',...Array(3).fill('/inference/go/openai/v1/chat/completions')]);
    const session=received[0].session;
    assert.match(session!,/^[a-f0-9]{64}$/);
    for(const item of received) {
      assert.equal(item.session,session);
      assert.match(item.agent!,/^fnos-app-health-records\//);
      assert.equal(item.authorization,'Bearer synthetic-key');
    }
  } finally {
    upstream.closeAllConnections();
    await new Promise<void>((resolve,reject)=>upstream.close(error=>error?reject(error):resolve()));
  }
}));

test('header editor reads only the selected connection, requires an administrator and prevents caching',()=>fixture(async()=>{
  const saved=saveAiSettings({profiles:[{id:'first',provider:'custom',baseUrl:'https://first.synthetic.invalid/v1',headers:[{name:'X-App',value:'synthetic-first'}]},{id:'second',provider:'custom',baseUrl:'https://second.synthetic.invalid/v1',headers:[{name:'X-App',value:'synthetic-second'}]}]});
  let allowed=true;
  const app=new H3();
  app.use(event=>{event.context.requestUser={id:'synthetic-admin',displayName:'Synthetic',provider:'development',authenticated:allowed,isGatewayAdmin:allowed};});
  app.get('/headers',headersGet);
  const result=await app.request('http://localhost/headers?profileId=second');
  assert.equal(result.status,200);
  assert.equal(result.headers.get('cache-control'),'private, no-store');
  assert.deepEqual((await result.json()).data,[{name:'x-app',value:'synthetic-second',configured:true}]);
  assert.ok(!JSON.stringify(saved).includes('synthetic-second'));
  assert.equal((await app.request('http://localhost/headers?profileId=missing')).status,404);
  assert.equal((await app.request('http://localhost/headers')).status,400);
  allowed=false;
  assert.equal((await app.request('http://localhost/headers?profileId=second')).status,403);
}));

test('headers are encrypted, never returned as plaintext, and blank/omitted/delete semantics survive reopening',()=>fixture(()=>{
  const saved=saveAiSettings({enabled:true,provider:'custom',baseUrl:'https://synthetic.invalid/v1',textModel:'synthetic',apiKey:'synthetic-key',headers:[{name:'X-Token',value:'synthetic-private-token'},{name:'User-Agent',value:'synthetic-client/1'}]});
  const id=saved.defaultProfileId;
  assert.deepEqual(saved.profiles[0].headers,[{name:'x-token',value:'',configured:true},{name:'user-agent',value:'',configured:true}]);
  const storage=()=>String(getDatabase().prepare("SELECT value_json AS value FROM app_settings WHERE setting_key='ai.provider'").get()!.value);
  assert.ok(!storage().includes('synthetic-private-token'));
  assert.ok(!JSON.stringify(saved).includes('synthetic-private-token'));
  assert.ok(JSON.parse(storage()).profiles[0].headersEncrypted);
  closeDatabaseForTests();
  assert.equal(getAiTaskSettings('report_extraction',true).headers['x-token'],'synthetic-private-token');
  assert.deepEqual(getAiTaskSettings('report_extraction').headers,{});
  saveAiSettings({profiles:[{id,provider:'custom',headers:[{name:'X-TOKEN',value:''}]}]});
  assert.deepEqual({...getAiTaskSettings('report_extraction',true).headers},{'x-token':'synthetic-private-token'});
  saveAiSettings({profiles:[{id,provider:'custom'}]});
  assert.equal(getAiTaskSettings('report_extraction',true).headers['x-token'],'synthetic-private-token');
  saveAiSettings({profiles:[{id,provider:'custom',headers:[]}]});
  assert.deepEqual(getAiTaskSettings('report_extraction',true).headers,{});
  assert.equal(JSON.parse(storage()).profiles[0].headersEncrypted,undefined);
}));

test('invalid, duplicate and transport headers fail without storing a partial update or exposing their values',()=>fixture(()=>{
  saveAiSettings({provider:'deepseek',apiKey:'synthetic-key'});
  const before=getAiSettings();
  const invalid:unknown[]=[{},[{name:'X-Test',value:'a'},{name:'x-test',value:'b'}],[{name:'Bad Name',value:'a'}],[{name:'Host',value:'synthetic.invalid'}],[{name:'content-length',value:'1'}],[{name:'x-test',value:'synthetic-secret\r\nInjected: true'}],[{name:'x-empty',value:''}],[{name:'x-test',value:12}]];
  for(const headers of invalid) {
    assert.throws(()=>saveAiSettings({provider:'deepseek',headers:headers as any}),error=>{
      assert.equal((error as any).statusCode,400);
      assert.ok(!String(error).includes('synthetic-secret'));return true;
    });
    assert.deepEqual(getAiSettings(),before);
  }
  assert.throws(()=>resolveAiHeaders(Array.from({length:33},(_,i)=>({name:'x-'+i,value:'a'}))),{statusCode:400});
}));

test('each connection keeps its own headers and task bindings select the matching secrets',()=>fixture(()=>{
  const first=saveAiSettings({enabled:true,provider:'custom',baseUrl:'https://a.synthetic.invalid/v1',textModel:'a',apiKey:'synthetic-a',headers:[{name:'X-App',value:'connection-a'}]});
  saveAiSettings({profiles:[{id:first.defaultProfileId,provider:'custom'},{id:'second',provider:'custom',baseUrl:'https://b.synthetic.invalid/v1',textModel:'b',apiKey:'synthetic-b',headers:[{name:'X-App',value:'connection-b'}]}]});
  assert.equal(getAiTaskSettings('report_extraction',true).headers['x-app'],'connection-a');
  saveAiSettings({taskBindings:{report_extraction:{profileId:'second'}}});
  assert.equal(getAiTaskSettings('report_extraction',true).headers['x-app'],'connection-b');
  assert.equal(getAiTaskSettings('report_extraction',true).apiKey,'synthetic-b');
}));

test('custom values override preset headers case-insensitively and do not affect another connection',()=>{
  const headers=aiRuntimeHeaders({provider:'opencode-go',apiKey:'default-key',headers:{Authorization:'Bearer synthetic-override','User-Agent':'synthetic-client/1','X-OpenCode-Session':'synthetic-session'}});
  assert.equal(headers.authorization,'Bearer synthetic-override');
  assert.equal(headers['user-agent'],'synthetic-client/1');
  assert.equal(headers['x-opencode-session'],'synthetic-session');
  assert.deepEqual(aiRuntimeHeaders({provider:'custom',apiKey:'other-key'}),{authorization:'Bearer other-key'});
});

test('header-only authentication reaches connection testing, configured tasks and unsaved model listing',()=>fixture(async()=>{
  const saved=saveAiSettings({enabled:true,provider:'custom',baseUrl:'https://synthetic.invalid/v1',textModel:'synthetic',headers:[{name:'Authorization',value:'Bearer synthetic-header-key'},{name:'X-App',value:'synthetic-app'}]});
  assert.equal(isAiExtractionConfigured(),true);
  const calls:Array<{url:string;headers:Headers}>=[];
  globalThis.fetch=async(url,init)=>{
    const headers=new Headers(init?.headers);calls.push({url:String(url),headers});
    assert.equal(headers.get('authorization'),'Bearer synthetic-header-key');
    if(String(url).endsWith('/models'))return new Response(JSON.stringify({data:[{id:'synthetic'}]}),{status:200});
    assert.equal(headers.get('x-app'),'synthetic-app');return response();
  };
  await testAiConnection({profileId:saved.defaultProfileId});
  await executeAiTask('report_extraction',{messages:[{role:'user',content:'Synthetic'}],maxOutputTokens:16,timeoutMs:15000});
  let allowed=true;const app=new H3();
  app.use(event=>{event.context.requestUser={id:'synthetic-admin',displayName:'Synthetic',provider:'development',authenticated:allowed,isGatewayAdmin:allowed};});
  app.post('/models',modelsPost);app.post('/enhanced',enhancedTest);
  const send=(url:string,body:unknown)=>app.request('http://localhost/'+url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  const listed=await send('models',{profileId:saved.defaultProfileId,headers:[{name:'Authorization',value:''},{name:'X-App',value:'unsaved-app'}]});
  assert.equal(listed.status,200);
  assert.equal(calls.at(-1)!.headers.get('x-app'),'unsaved-app');
  assert.equal(getAiTaskSettings('report_extraction',true).headers['x-app'],'synthetic-app');
  const enhanced=await send('enhanced',{profileId:saved.defaultProfileId});
  assert.equal(enhanced.status,200);assert.equal((await enhanced.json()).data.overallSuccess,true);
  assert.ok(calls.every(call=>!call.url.includes('synthetic-header-key')));
  allowed=false;
  assert.equal((await send('models',{})).status,403);
  allowed=true;assert.equal((await send('models',null)).status,400);
}));
