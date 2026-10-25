import {organizeHealthDocuments} from '../services/health-document-organizer.service';
import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync,readdirSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import ts from 'typescript';
import {closeDatabaseForTests,getDatabase} from '../database/client';
import type {RequestUser} from '../domain/request-user';
import {listUserOperationAuditLogs} from '../services/records.service';
import {createMedicationCourse,changeMedicationCourse,createMedicationIntake,updateMedicationIntake} from '../services/medication.service';
import {createVaccination,updateVaccination} from '../services/vaccination.service';
import {createPublicSymptom} from '../services/public-symptom.service';
import {createProcessSymptomUpdate} from '../services/symptom-episode.service';
import {linkProcessRecords,removeProcessRecord,getRecordProcess,updateRecordProcess} from '../services/health-record-process.service';
import {medicationActions} from '../../shared/medications';
import {standaloneTrashKinds,mutateStandaloneTrash} from '../services/health-record-trash.service';

const user:RequestUser={id:'manager',displayName:'合成管理员',provider:'development',authenticated:true,isGatewayAdmin:true};
async function fixture(run:()=>unknown){
 const previous=process.env.STORAGE_DIR;const dir=mkdtempSync(join(tmpdir(),'user-operation-audit-'));process.env.STORAGE_DIR=dir;
 try{const db=getDatabase();db.prepare("INSERT INTO users(id,display_name) VALUES('manager','合成管理员'),('other','合成其他账号')").run();
  db.prepare("INSERT INTO health_members(id,display_name,created_by) VALUES('member','合成成员','manager'),('foreign','合成其他成员','other')").run();
  db.prepare("INSERT INTO member_permissions(member_id,user_id,permission,granted_by) VALUES('member','manager','manager','manager')").run();
  await run();
 }finally{closeDatabaseForTests();if(previous===undefined)delete process.env.STORAGE_DIR;else process.env.STORAGE_DIR=previous;rmSync(dir,{recursive:true,force:true});}
}
function insert(action:string,type:string|null=null,id:string|null=null,detail:unknown={}){
 const db=getDatabase();const n=Number(db.prepare('SELECT COUNT(*) AS n FROM audit_logs').get()!.n);
 db.prepare('INSERT INTO audit_logs(id,actor_user_id,action,target_type,target_id,detail_json) VALUES(?,?,?,?,?,?)').run('audit-'+n,user.id,action,type,id,JSON.stringify(detail));
}
function allLogs(){let cursor:string|undefined;const items:ReturnType<typeof listUserOperationAuditLogs>['items']=[];
 do{const page=listUserOperationAuditLogs(user,50,cursor);items.push(...page.items);cursor=page.hasMore?page.nextCursor||undefined:undefined;}while(cursor);return items;}

test('all literal actions emitted by audit writers and supported dynamic medication/trash actions have readable titles',()=>fixture(()=>{
 const actions=new Set<string>();const targets=new Set<string>();const directory=new URL('../services/',import.meta.url);
 const collect=(node:ts.Node)=>{
  if(ts.isStringLiteralLike(node)&&/^[a-z_]+(?:\.[a-z_]+)+$/.test(node.text))actions.add(node.text);
  ts.forEachChild(node,collect);
 };
 for(const filename of readdirSync(directory).filter(name=>name.endsWith('.ts'))){
  const source=ts.createSourceFile(filename,readFileSync(new URL(filename,directory),'utf8'),ts.ScriptTarget.Latest,true);
  const visit=(node:ts.Node)=>{
   if(ts.isCallExpression(node)){
    const callee=node.expression;
    if(ts.isIdentifier(callee)&&['audit','appendAudit','auditHealthEpisode','touch'].includes(callee.text))node.arguments.forEach(collect);
    if(ts.isPropertyAccessExpression(callee)&&callee.name.text==='run'&&ts.isCallExpression(callee.expression)){
     const prepare=callee.expression;
     if(ts.isPropertyAccessExpression(prepare.expression)&&prepare.expression.name.text==='prepare'&&prepare.arguments[0]&&ts.isStringLiteralLike(prepare.arguments[0])&&/INSERT\s+INTO\s+audit_logs/i.test(prepare.arguments[0].text)){
      for(const match of prepare.arguments[0].text.matchAll(/'([a-z_]+(?:\.[a-z_]+)+)'/g))actions.add(match[1]);
      const target=prepare.arguments[0].text.match(/VALUES\s*\((?:[^,]+,){3}\s*'([a-z_]+)'/i);if(target)targets.add(target[1]);
      node.arguments.forEach(collect);
     }
    }
   }
   if(ts.isPropertyAssignment(node)&&node.name.getText(source)==='auditAction')collect(node.initializer);
   ts.forEachChild(node,visit);
  };visit(source);
 }
 for(const action of medicationActions)actions.add('medication.'+action);
 for(const kind of standaloneTrashKinds)for(const operation of ['trash','restore','purge'])actions.add(`${kind}.${operation}`);
 assert.ok(actions.size>90);
 for(const action of actions)insert(action);
 for(const kind of standaloneTrashKinds)targets.add(kind);
 assert.ok(targets.size>10);for(const target of targets)insert('report.upload',target,'missing',{targetType:target});
 const logs=allLogs();assert.equal(logs.length,actions.size+targets.size);
 for(const item of logs)assert.notEqual(item.title,'未知操作',item.action);
 assert.deepEqual(logs.filter(item=>item.targetLabel==='其他对象').map(item=>item.detail.targetType),[]);
}));

test('actual health workflows resolve their action, current object name and association count without rewriting history',()=>fixture(()=>{
 const db=getDatabase();db.prepare("INSERT INTO reports(id,member_id,created_by,title,report_type,status) VALUES('report','member','manager','合成报告','laboratory','ready')").run();
 const symptom=createPublicSymptom(user,{memberId:'member',name:'合成症状',startedAt:'2026-01-01'});
 createProcessSymptomUpdate(user,symptom.episodeId,symptom.id,{recordedAt:'2026-01-02',change:'improved'});
 let course=createMedicationCourse(user,{memberId:'member',medicationName:'合成药品',startedAt:'2026-01-01',confirmed:true});
 for(const action of ['adjust','pause','resume','stop'])course=changeMedicationCourse(user,course.id,{action,revision:course.revision,occurredAt:'2026-01-02'});
 let intake=createMedicationIntake(user,{memberId:'member',medicationName:'合成服药补充',takenAt:'2026-01-02',amount:'1'});
 intake=updateMedicationIntake(user,intake.id,{revision:intake.revision,medicationName:'合成服药补充更正',takenAt:'2026-01-02',amount:'2'});
 let vaccine=createVaccination(user,{memberId:'member',vaccineName:'合成疫苗',administeredAt:'2026-01-01'});
 vaccine=updateVaccination(user,vaccine.id,{revision:vaccine.revision,vaccineName:'合成疫苗更正'});
 const first=getRecordProcess(user,linkProcessRecords(user,{kind:'report',id:'report'},[{kind:'symptom',id:symptom.id},{kind:'vaccination',id:vaccine.id}])[0].id);
 updateRecordProcess(user,first.id,{fingerprint:first.fingerprint,editToken:first.editToken,title:'合成事项历程'});
 const current=getRecordProcess(user,first.id);removeProcessRecord(user,first.id,{fingerprint:current.fingerprint,editToken:current.editToken,record:{kind:'vaccination',id:vaccine.id}});
 const before=db.prepare('SELECT * FROM audit_logs ORDER BY id').all();const logs=allLogs();
 assert.ok(logs.every(item=>item.title!=='未知操作'&&item.targetLabel!=='其他对象'&&item.description!=='未提供操作详情'));
 for(const action of medicationActions)assert.equal(logs.find(item=>item.action==='medication.'+action)?.targetName,'合成药品');
 for(const action of ['create','edit']){
  const item=logs.find(item=>item.action==='medication.intake.'+action)!;assert.equal(item.targetLabel,'服药补充');assert.equal(item.targetName,'合成服药补充更正');
 }
 assert.equal(logs.find(item=>item.action==='vaccination.create')?.targetName,'合成疫苗更正');
 const change=logs.find(item=>item.action==='episode.symptom.record')!;assert.equal(change.targetLabel,'症状记录');assert.equal(change.targetName,'合成症状');assert.match(change.description,/好转/);
 const link=logs.find(item=>item.action==='record.link.attach')!;assert.equal(link.targetName,'合成报告');assert.equal(link.targetLabel,'报告');assert.match(link.description,/关联 2 条记录/);
 const removal=logs.find(item=>item.action==='process.record.remove')!;assert.equal(removal.targetName,'合成事项历程');assert.match(removal.description,/原记录保留/);
 assert.deepEqual(db.prepare('SELECT * FROM audit_logs ORDER BY id').all(),before);
 const persisted=JSON.stringify(before);for(const name of ['合成药品','合成疫苗更正','合成事项历程','合成服药补充更正'])assert.equal(persisted.includes(name),false);
}));

test('trash, restore and permanent deletion preserve readable history without persisting a clinical snapshot',()=>fixture(()=>{
 const db=getDatabase();const course=createMedicationCourse(user,{memberId:'member',medicationName:'合成回收站用药',startedAt:'2026-01-01',confirmed:true});
 mutateStandaloneTrash(user,'medication',course.id,{revision:course.revision},'trash');
 assert.equal(allLogs().find(item=>item.action==='medication.trash')?.targetName,'合成回收站用药');
 mutateStandaloneTrash(user,'medication',course.id,{revision:course.revision+1},'restore');
 assert.equal(allLogs().find(item=>item.action==='medication.restore')?.title,'恢复用药记录');
 mutateStandaloneTrash(user,'medication',course.id,{revision:course.revision+2},'trash');
 mutateStandaloneTrash(user,'medication',course.id,{revision:course.revision+3},'purge');
 for(const item of allLogs()){assert.notEqual(item.title,'未知操作');assert.equal(item.targetLabel,'用药记录');assert.match(item.targetName||'',/已删除或不可访问/);}
 assert.equal(JSON.stringify(db.prepare('SELECT detail_json FROM audit_logs').all()).includes('合成回收站用药'),false);
}));

test('deleted, moved and inaccessible objects retain readable labels without leaking current names; malformed historical details are tolerated',()=>fixture(()=>{
 const db=getDatabase();const course=createMedicationCourse(user,{memberId:'member',medicationName:'不可泄露的合成名称',startedAt:'2026-01-01',confirmed:true});
 db.prepare("UPDATE medication_courses SET member_id='foreign' WHERE id=?").run(course.id);
 insert('vaccination.trash','vaccination','missing');insert('record.link.detach','health_record','missing',{kind:'symptom',records:[{kind:'report',id:'missing'}]});
 insert('medication.purge','medication','deleted');insert('symptom.trash','symptom','missing',null);
 const logs=allLogs();assert.equal(JSON.stringify(logs).includes('不可泄露的合成名称'),false);
 for(const item of logs){assert.notEqual(item.title,'未知操作');assert.notEqual(item.targetLabel,'其他对象');assert.match(item.targetName||'',/已删除或不可访问/);}
 assert.equal(logs.find(item=>item.action==='vaccination.trash')?.title,'接种记录移入回收站');
 assert.throws(()=>listUserOperationAuditLogs({...user,isGatewayAdmin:false}),/仅管理员/);
 assert.equal(listUserOperationAuditLogs({...user,id:'other'}).items.length,0);
}));


test('document-group audit uses current record terminology and symptom containers never create a phantom process operation',()=>fixture(()=>{
 const db=getDatabase();
 for(const id of ['group-a','group-b'])db.prepare("INSERT INTO reports(id,member_id,created_by,title,report_type,status) VALUES(?,'member','manager','Synthetic','laboratory','ready')").run(id);
 organizeHealthDocuments(user,{memberId:'member',requestKey:'audit-current-group-key',groups:[{reportIds:['group-a','group-b'],title:'Synthetic'}]});
 createPublicSymptom(user,{memberId:'member',name:'Synthetic',requestKey:'audit-current-symptom-key'});
 const logs=allLogs();const group=logs.find(item=>item.action==='event.create')!;
 assert.equal(group.title,'整理同次资料');assert.equal(group.targetLabel,'资料分组');
 assert.equal(logs.some(item=>item.action==='episode.create'),false);
}));
