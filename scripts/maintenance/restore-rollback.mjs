#!/usr/bin/env node
import { readFileSync,existsSync,cpSync,rmSync,mkdirSync,readdirSync,lstatSync } from 'node:fs';
import { resolve,join,sep,basename } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
const args=process.argv.slice(2);
const option=name=>{const i=args.indexOf(name);if(i<0||!args[i+1]) throw new Error(`需要 ${name}`);return args[i+1];};
const runtime=resolve(option('--runtime')),storage=resolve(option('--storage'));
const journal=join(runtime,'restore-maintenance.json');
const state=JSON.parse(readFileSync(journal,'utf8'));
const root=resolve(state.rollbackRoot||'');
if(state.version!==1||!root.startsWith(join(storage,'backups')+sep)||!basename(root).startsWith('.rollback-')) throw new Error('维护记录路径无效，拒绝操作');
const manifest=JSON.parse(readFileSync(join(root,'manifest.json'),'utf8'));
for(const file of manifest.files||[]) {
 const path=resolve(root,file.path);
 if(!path.startsWith(root+sep)||lstatSync(path).isSymbolicLink()||createHash('sha256').update(readFileSync(path)).digest('hex')!==file.sha256) throw new Error('安全备份完整性校验失败');
}
if(!manifest.files?.some(file=>file.path==='db/health-records.sqlite')) throw new Error('缺少数据库校验记录');
const check=new DatabaseSync(join(root,'db','health-records.sqlite'),{readOnly:true});
try{if(check.prepare('PRAGMA integrity_check').get().integrity_check!=='ok') throw new Error('安全备份数据库损坏');}finally{check.close();}
const confirmation=createHash('sha256').update(JSON.stringify({state,runtime,storage})).digest('hex');
if(!args.includes('--apply')) console.log(JSON.stringify({confirmation,safetyBackupId:state.safetyBackupId,notice:'预览通过。停止服务，使用 --apply --service-stopped --confirm 摘要 执行；恢复数据库、文件和身份至安全备份时点。'}));
else {
 if(!args.includes('--service-stopped')||option('--confirm')!==confirmation) throw new Error('必须停止服务并确认本次预览摘要');
 const control=name=>/^archive-(location|migration|cleanup)\.json(?:\..*)?$/.test(name);
 for(const dir of ['reports','report-notes','thumbnails','config','secrets']) {
  const target=join(storage,dir),source=join(root,dir);
  if(dir==='config') {mkdirSync(target,{recursive:true});for(const name of readdirSync(target)) if(!control(name)) rmSync(join(target,name),{recursive:true,force:true});}
  else rmSync(target,{recursive:true,force:true});
  if(existsSync(source)) cpSync(source,target,{recursive:true,filter:path=>dir!=='config'||!control(basename(path))});
  else mkdirSync(target,{recursive:true});
 }
 const target=join(storage,'db','health-records.sqlite');
 for(const suffix of ['','-wal','-shm']) rmSync(target+suffix,{force:true});
 cpSync(join(root,'db','health-records.sqlite'),target);
 const db=new DatabaseSync(target);try{if(db.prepare('PRAGMA integrity_check').get().integrity_check!=='ok') throw new Error('回滚后数据库校验失败，继续维护');}finally{db.close();}
 rmSync(journal);console.log('回滚完成，可启动应用；完整安全备份与回滚目录已保留。');
}
