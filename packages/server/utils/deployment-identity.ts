import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getAppConfig } from './runtime-config';

// Lives in the runtime root, outside directories copied by business-data restore.
export function getDeploymentIdentity() {
 const config=getAppConfig();
 const path=join(config.runtimeDir,'deployment-identity.json');
 mkdirSync(config.runtimeDir,{recursive:true});
 if(!existsSync(path)) {
  try { writeFileSync(path,JSON.stringify({id:randomUUID()}),{flag:'wx',mode:0o600}); }
  catch(error) { if(!existsSync(path)) throw error; }
 }
 const {id}=JSON.parse(readFileSync(path,'utf8')) as {id:string};
 if(typeof id!=='string'||!id) throw new Error('部署身份文件无效，请保留文件并联系维护人员');
 return {id,authMode:config.authMode,identityDomain:`${id}:${config.authMode}`};
}
