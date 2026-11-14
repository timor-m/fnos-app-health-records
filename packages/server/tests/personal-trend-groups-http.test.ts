import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {H3} from 'h3';
import {getDatabase,closeDatabaseForTests} from '../database/client';
import manage from '../routes/api/trends/groups/manage.get';
import create from '../routes/api/trends/groups.post';
import update from '../routes/api/trends/groups/[key].put';
import remove from '../routes/api/trends/groups/[key].delete';
import type {RequestUser} from '../domain/request-user';

test('group HTTP endpoints enforce account ownership, validate bodies and retain the stored group on failure',async()=>{
 const previous=process.env.STORAGE_DIR,storage=mkdtempSync(join(tmpdir(),'personal-groups-http-'));process.env.STORAGE_DIR=storage;
 try{
  const db=getDatabase();db.exec("INSERT INTO users(id,display_name) VALUES('owner','Synthetic'),('other','Synthetic')");
  let user:RequestUser={id:'owner',displayName:'Synthetic',provider:'development',authenticated:true,isGatewayAdmin:false};
  const app=new H3();app.use(event=>{event.context.requestUser=user;});
  app.get('/groups/manage',manage);app.post('/groups',create);app.put('/groups/:key',update);app.delete('/groups/:key',remove);
  const req=(url:string,method='GET',body?:unknown)=>app.request('http://localhost'+url,{method,headers:{'content-type':'application/json'},...(body!==undefined?{body:JSON.stringify(body)}:{})});
  const list=await req('/groups/manage');assert.equal(list.status,200);assert.ok((await list.json()).data.indicators.length);
  const created=await req('/groups','POST',{name:'合成个人分组',indicatorKeys:['lipid_tc']});assert.equal(created.status,201);
  const group=(await created.json()).data;
  user={...user,id:'other',isGatewayAdmin:true};
  assert.ok(!(await (await req('/groups/manage')).json()).data.groups.some((g:any)=>g.key===group.key));
  assert.equal((await req('/groups/'+group.key,'PUT',{name:'越权',indicatorKeys:['lipid_tg']})).status,404);
  assert.equal((await req('/groups/'+group.key,'DELETE')).status,404);
  assert.equal((await req('/groups/lipid_panel','DELETE')).status,404);
  user={...user,id:'owner'};
  assert.equal((await req('/groups/'+group.key,'PUT',{name:'无效',indicatorKeys:['forged']})).status,400);
  assert.equal((await req('/groups/'+group.key,'PUT',{name:'已编辑',indicatorKeys:['lipid_tg']})).status,200);
  const edited=(await (await req('/groups/manage')).json()).data.groups.find((g:any)=>g.key===group.key);
  assert.deepEqual(edited.indicatorKeys,['lipid_tg']);
  user={...user,authenticated:false};assert.equal((await req('/groups/manage')).status,401);
  assert.equal((await req('/groups','POST',{name:'无身份',indicatorKeys:['lipid_tc']})).status,401);
  user={...user,authenticated:true};assert.equal((await req('/groups/'+group.key,'DELETE')).status,200);
  assert.ok(!(await (await req('/groups/manage')).json()).data.groups.some((g:any)=>g.key===group.key));
 }finally{closeDatabaseForTests();if(previous===undefined)delete process.env.STORAGE_DIR;else process.env.STORAGE_DIR=previous;rmSync(storage,{recursive:true,force:true});}
});
