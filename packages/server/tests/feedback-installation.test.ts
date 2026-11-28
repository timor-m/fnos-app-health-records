import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync,copyFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FEEDBACK_APP_ID,
  getFeedbackInstallation,
  isValidDeviceId,
  preserveFeedbackInstallation,
  readFeedbackInstallation,
  readFnOSMachineId,
  resolveFeedbackAppsIdentity,
} from '../services/feedback-installation.service';

function database(path=':memory:') {const db=new DatabaseSync(path);db.exec('CREATE TABLE IF NOT EXISTS app_settings(setting_key TEXT PRIMARY KEY,value_json TEXT NOT NULL)');return db;}

test('identity is lazy, random, stable across database reopen and backup copies',()=>{
  const dir=mkdtempSync(join(tmpdir(),'feedback-id-'));const path=join(dir,'app.sqlite');
  let db=database(path);
  try {assert.equal(readFeedbackInstallation(db),null);const id=getFeedbackInstallation(db);assert.match(id,/^[A-Za-z0-9_-]{43}$/);assert.equal(getFeedbackInstallation(db),id);db.close();copyFileSync(path,join(dir,'backup.sqlite'));db=database(path);assert.equal(getFeedbackInstallation(db),id);const backup=database(join(dir,'backup.sqlite'));try{assert.equal(getFeedbackInstallation(backup),id);}finally{backup.close();}}finally{db.close();rmSync(dir,{recursive:true,force:true});}
});
test('restore prefers backup identity, old backups inherit target, empty databases remain lazy',()=>{
 const current=database(),backup=database(),old=database(),empty=database();
 try {preserveFeedbackInstallation(old,empty);assert.equal(readFeedbackInstallation(old),null);const first=getFeedbackInstallation(current),second=getFeedbackInstallation(backup);assert.notEqual(first,second);preserveFeedbackInstallation(backup,current);assert.equal(readFeedbackInstallation(backup),second);preserveFeedbackInstallation(old,current);assert.equal(readFeedbackInstallation(old),first);}finally{for(const db of [current,backup,old,empty])db.close();}
});
test('corrupt credentials are not silently replaced',()=>{const db=database();try{db.prepare('INSERT INTO app_settings VALUES (?,?)').run('x-client-id','"bad"');assert.throws(()=>getFeedbackInstallation(db),/损坏/);assert.equal(db.prepare('SELECT value_json FROM app_settings').get()?.value_json,'"bad"');}finally{db.close();}});

test('device id validation rejects short, spaced and placeholder values',()=>{
  assert.equal(isValidDeviceId('fnos-device-001'),true);
  assert.equal(isValidDeviceId('abcd'),false);
  assert.equal(isValidDeviceId('AAAAAAAA'),false);
  assert.equal(isValidDeviceId('bad id'),false);
  assert.equal(readFnOSMachineId({TRIM_SYS_MACHINE_ID:'fnos-device-001'}), 'fnos-device-001');
  assert.equal(readFnOSMachineId({TRIM_SYS_MACHINE_ID:'AAAAAAAA'}), null);
});

test('fnOS with machine id sends device id and does not create a local client id',()=>{
  const db=database();
  try {
    const identity=resolveFeedbackAppsIdentity(db,{machineId:'fnos-device-001'});
    assert.deepEqual(identity.headers,{'x-app-id':FEEDBACK_APP_ID,'x-device-id':'fnos-device-001'});
    assert.equal(identity.clientId,null);
    assert.equal(identity.deviceId,'fnos-device-001');
    assert.equal(identity.localKey,'fnos-device-001');
    assert.equal(readFeedbackInstallation(db),null);
  } finally {db.close();}
});

test('fnOS upgrade dual-passes legacy client with device id for backfill',()=>{
  const db=database();
  try {
    const legacy=getFeedbackInstallation(db);
    const identity=resolveFeedbackAppsIdentity(db,{machineId:'fnos-device-001'});
    assert.deepEqual(identity.headers,{
      'x-app-id':FEEDBACK_APP_ID,
      'x-device-id':'fnos-device-001',
      'x-client-id':legacy,
    });
    assert.equal(identity.localKey,legacy);
  } finally {db.close();}
});

test('Docker and missing machine id keep local client id only',()=>{
  const db=database();
  try {
    const identity=resolveFeedbackAppsIdentity(db,{machineId:null});
    assert.equal(identity.headers['x-app-id'],FEEDBACK_APP_ID);
    assert.match(identity.headers['x-client-id']!,/^[A-Za-z0-9_-]{43}$/);
    assert.equal(identity.headers['x-device-id'],undefined);
    assert.equal(identity.deviceId,null);
    assert.equal(identity.localKey,identity.clientId);
  } finally {db.close();}
});
