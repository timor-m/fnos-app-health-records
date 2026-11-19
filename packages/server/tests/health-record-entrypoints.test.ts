import assert from 'node:assert/strict';
import {existsSync,readFileSync,readdirSync} from 'node:fs';
import test from 'node:test';

const ui='packages/ui/src/';
const api='packages/server/routes/api/';

test('record and process routes replace the unreleased event-detail business',()=>{
 const router=readFileSync(ui+'router.ts','utf8');
 assert.doesNotMatch(router,/HealthEventDetailPage|path:\s*["']\/events\/:id["']/);
 for(const path of ['/events','/events/detail/:kind/:id','/health-processes','/health-processes/:id'])
  assert.ok(router.includes(`path: "${path}"`),`missing current route ${path}`);
 for(const file of ['pages/HealthEventDetailPage.vue','components/EventCandidateReports.vue','components/EventClinicalSummary.vue','components/HealthProcessActivity.vue','components/EpisodeMedicationPanel.vue'])
  assert.equal(existsSync(ui+file),false,`obsolete event UI returned: ${file}`);
});

test('obsolete public event operations are no longer exposed alongside record associations',()=>{
 const eventsDir=api+'events';
 assert.deepEqual(existsSync(eventsDir)?readdirSync(eventsDir,{recursive:true}).filter(file=>String(file).endsWith('.ts')):[],[]);
 for(const file of ['events.get.ts','events.post.ts','episodes/[id].get.ts','episodes/[id]/events.post.ts','episodes/[id]/events/[eventId].delete.ts','episodes/[id]/activity.get.ts','episodes/[id]/symptom.patch.ts','episodes/[id]/updates.post.ts','uploads/workflow/archive.post.ts'])
  assert.equal(existsSync(api+file),false,`obsolete public operation returned: ${file}`);
 for(const file of ['health-records.get.ts','health-records/associations.get.ts','health-records/associations.post.ts','health-records/organize.post.ts','health-processes/[id]/records.post.ts','symptoms/[id].get.ts','episodes/[id]/symptoms/[symptomId]/updates.post.ts'])
  assert.equal(existsSync(api+file),true,`current record workflow must remain available: ${file}`);
});

// No released client ever used these 0.3.0 intermediate routes or services.
test('unreleased navigation aliases and obsolete association services stay removed',()=>{
 const router=readFileSync(ui+'router.ts','utf8');
 for(const path of ['/medications','/add'])assert.equal(router.includes(`path: "${path}"`),false);
 for(const file of ['health-workflow-context','health-activity','health-event-candidate','health-event-resource','health-event-relation','health-episode-event'])assert.equal(existsSync(`packages/server/services/${file}.service.ts`),false,file);
 assert.equal(existsSync(api+'medications/intakes/[id].delete.ts'),false);
});
