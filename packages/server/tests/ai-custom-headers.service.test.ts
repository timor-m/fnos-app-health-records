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
