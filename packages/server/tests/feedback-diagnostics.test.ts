import assert from "node:assert/strict";
import test from "node:test";
import { diagnosticFeatures } from "../services/feedback-diagnostics-summary";

test("feedback diagnostics projects only safe OCR and AI fields", () => {
  const ocr = { available: true, installing: false, runtime: { engine: "rapidocr-onnxruntime", modelVersion: "v4", pythonVersion: "3.12.1", python: "/private/example/python", rapidocrVersion: "1.4.0", pymupdfVersion: "1.24.0" }, tableEnhancement: { tableModel: true, layoutModel: false }, runner: { started: true, busy: false, queued: 99 }, lastInstall: { logTail: ["PRIVATE_LOG"] } };
  const ai = { enabled: true, apiKeyConfigured: true, visionEnabled: false, provider: "custom", model: "namespace/text-v1", extractionDepth: "detailed", visionModel: "unused-vision", profileName: "PRIVATE_PROFILE", apiKey: "PRIVATE_KEY", baseUrl: "https://private.invalid" };
  const result = diagnosticFeatures(ocr, ai);
  assert.deepEqual(result.ai, { enabled: true, visionEnabled: false, provider: "custom", model: "namespace/text-v1", extractionDepth: "detailed" });
  assert.equal(result.ocr?.engine, "rapidocr-onnxruntime");
  assert.equal(result.ocr?.tableModel, true);
  assert.equal(result.ocr?.layoutModel, false);
  assert.equal(result.ocr?.pythonVersion, "3.12.1");
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|private|queued|logTail|baseUrl|installing|started|busy|configured|apiKeyConfigured/);
});
test("optional service failures remain unknown rather than disabled", () => {
  assert.deepEqual(diagnosticFeatures(null, null), { ocr: null, ai: null });
});
test("unexpected paths in version fields are excluded", () => {
  const result = diagnosticFeatures({ available: false, runtime: { engine: "/private/engine", pythonVersion: "secret value" } }, null);
  assert.equal(result.ocr?.engine, null);
  assert.equal(result.ocr?.pythonVersion, null);
});

test('AI snapshot omits inactive configuration and filters private identifiers', async () => {
  const {feedbackAiSnapshot,feedbackModelIdentifier} = await import('../../shared/feedback-ai');
  assert.deepEqual(feedbackAiSnapshot({enabled:false,visionEnabled:false,provider:'custom',model:'unused'}),{enabled:false,visionEnabled:false});
  assert.deepEqual(feedbackAiSnapshot({enabled:true,visionEnabled:true,provider:'ollama',model:'namespace/text:8b',visionModel:'vision-v1',extractionDepth:'overview'}),{enabled:true,visionEnabled:true,provider:'ollama',model:'namespace/text:8b',visionModel:'vision-v1',extractionDepth:'overview'});
  for (const name of ['https://synthetic.invalid/v1','/private/model','C:/private/model','../model','sk-synthetic','ep-synthetic','user@example.test','bad model','a'.repeat(121)]) assert.equal(feedbackModelIdentifier(name),null);
});

test('authenticated diagnostics uses effective report task binding rather than default profile', async () => {
  const {mkdtempSync,rmSync} = await import('node:fs');
  const {tmpdir} = await import('node:os');
  const {join} = await import('node:path');
  const {H3} = await import('h3');
  const {saveAiSettings} = await import('../services/ai-settings.service');
  const {closeDatabaseForTests} = await import('../database/client');
  const {default:handler} = await import('../routes/api/feedback-diagnostics.get');
  const dir=mkdtempSync(join(tmpdir(),'feedback-ai-')),env={...process.env};
  process.env.STORAGE_DIR=dir;process.env.DISABLE_JOB_RUNNER='true';
  let authenticated=false;
  const app=new H3();app.use(e=>{e.context.requestUser={id:'synthetic',authenticated};});
  app.get('/diagnostics',e=>handler(new Proxy(e,{get(target,key,receiver){return key==='node'?{req:{healthAccessMode:'port'}}:Reflect.get(target,key,receiver);}})));
  try {
    assert.equal((await app.request('http://localhost/diagnostics')).status,401);
    saveAiSettings({enabled:true,extractionDepth:'detailed',defaultProfileId:'default',profiles:[
      {id:'default',name:'PRIVATE_DEFAULT',provider:'deepseek',baseUrl:'https://synthetic.invalid',textModel:'default-model',apiKey:'synthetic-key'},
      {id:'bound',name:'PRIVATE_BOUND',provider:'custom',baseUrl:'https://private.invalid',textModel:'profile-model',visionEnabled:true,visionModel:'vision-v1',apiKey:'synthetic-key'}
    ],taskBindings:{report_extraction:{profileId:'bound',model:'namespace/bound-model'}}});
    authenticated=true;
    const response=await app.request('http://localhost/diagnostics');
    assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
    const result=(await response.json()).data;
    assert.deepEqual(result.ai,{enabled:true,visionEnabled:true,provider:'custom',model:'namespace/bound-model',visionModel:'vision-v1',extractionDepth:'detailed'});
    assert.doesNotMatch(JSON.stringify(result),/PRIVATE|private.invalid|synthetic-key|profileId|profileName|default-model|baseUrl|apiKey/);
  } finally {closeDatabaseForTests();process.env=env;rmSync(dir,{recursive:true,force:true});}
});
