import assert from 'node:assert/strict';
import {spawn, type ChildProcess} from 'node:child_process';
import {once} from 'node:events';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync,statSync,writeFileSync} from 'node:fs';
import {createServer} from 'node:net';
import {request} from 'node:http';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import test from 'node:test';
import {getAppConfig} from '../utils/runtime-config.ts';

function fixture(packaged=true){
 const root=mkdtempSync(join(tmpdir(),'fnos-listener-'));
 const entry=join(root,packaged?'serve.mjs':'scripts/start.mjs');
 const module=join(root,packaged?'server/index.mjs':'.server-dist/server/index.mjs');
 mkdirSync(dirname(entry),{recursive:true});mkdirSync(dirname(module),{recursive:true});
 const source=readFileSync(resolve('scripts/prepare-package.mjs'),'utf8');
 const match=source.match(/const serverLauncher = (`[\s\S]*?`);/)!;
 writeFileSync(entry,packaged?Function(`return ${match[1]}`)():readFileSync(resolve('scripts/start.mjs'),'utf8'));
 writeFileSync(module,`export const handleUpgrade=undefined;export function middleware(req,res){res.end(JSON.stringify({accessMode:req.healthAccessMode||null,authMode:process.env.AUTH_MODE,development:process.env.NODE_ENV==='development'||Boolean(process.env.VITE_DEV_SERVER_URL)}));}`);
 writeFileSync(join(root,'template.config.json'),JSON.stringify({localDevPort:3334,gatewayPrefix:'/app/synthetic'}));
 return {root,entry};
}
function start(entry:string,env:Record<string,string>){
 const child=spawn(process.execPath,[entry],{env:{...process.env,NODE_ENV:'production',...env},stdio:['ignore','pipe','pipe']});
 let output='';child.stdout!.on('data',chunk=>output+=chunk);child.stderr!.on('data',chunk=>output+=chunk);
 return {child,output:()=>output};
}
async function ready(child:ChildProcess,output:()=>string){
 for(let n=0;n<150;n++){if(output().includes('listening'))return; if(child.exitCode!==null)throw Error(output());await new Promise(r=>setTimeout(r,20));}
 throw Error('Listener did not become ready');
}
async function stop(child:ChildProcess){if(child.exitCode!==null)return;const done=once(child,'exit');child.kill('SIGTERM');await done;}
async function unusedPort(){const server=createServer();server.listen(0,'127.0.0.1');await once(server,'listening');const port=(server.address() as {port:number}).port;await new Promise<void>(r=>server.close(()=>r()));return port;}
function get(options:Record<string,unknown>){return new Promise<string>((resolveRequest,reject)=>{const req=request({...options,path:'/'},res=>{let body='';res.on('data',chunk=>body+=chunk);res.on('end',()=>resolveRequest(body));});req.on('error',reject);req.end();});}

test('fnOS package exposes only a private gateway socket despite legacy port settings',async()=>{
 const {root,entry}=fixture();const socket=join(root,'app.sock'),port=await unusedPort();
 mkdirSync(join(root,'config'));writeFileSync(join(root,'config/runtime.json'),JSON.stringify({servicePort:port,directPort:port}));
 const processInfo=start(entry,{AUTH_MODE:'local',NODE_ENV:'development',VITE_DEV_SERVER_URL:'http://synthetic.invalid',FNOS_SOCKET_PATH:socket,STORAGE_DIR:root,SERVICE_PORT:String(port),PORT:String(port)});
 try{
  await ready(processInfo.child,processInfo.output);
  assert.deepEqual(JSON.parse(await get({socketPath:socket})),{accessMode:'gateway',authMode:'fnos',development:false});
  assert.equal(statSync(socket).mode&0o777,0o660);
  await assert.rejects(()=>get({host:'127.0.0.1',port,headers:{'x-trim-userid':'spoofed'}}),{code:'ECONNREFUSED'});
 }finally{await stop(processInfo.child);assert.equal(existsSync(socket),false);rmSync(root,{recursive:true,force:true});}
});

test('fnOS package refuses missing socket configuration instead of falling back to TCP',async()=>{
 const {root,entry}=fixture();const running=start(entry,{AUTH_MODE:'fnos',FNOS_SOCKET_PATH:''});
 try{const [code]=await once(running.child,'exit');assert.equal(code,1);assert.match(running.output(),/FNOS_SOCKET_PATH is required/);}
 finally{await stop(running.child);rmSync(root,{recursive:true,force:true});}
});

test('shared launcher refuses fnOS TCP while retaining the explicit local HTTP listener',async()=>{
 const {root,entry}=fixture(false);const port=await unusedPort();
 const denied=start(entry,{AUTH_MODE:'fnos',FNOS_SOCKET_PATH:'',PORT:String(port)});
 try{const [code]=await once(denied.child,'exit');assert.equal(code,1);assert.match(denied.output(),/FNOS_SOCKET_PATH is required/);
  const local=start(entry,{AUTH_MODE:'local',FNOS_SOCKET_PATH:'',HOST:'127.0.0.1',PORT:String(port)});
  try{await ready(local.child,local.output);assert.deepEqual(JSON.parse(await get({host:'127.0.0.1',port})),{accessMode:null,authMode:'local',development:false});}
  finally{await stop(local.child);}
 }finally{await stop(denied.child);rmSync(root,{recursive:true,force:true});}
});

test('runtime metadata reports no TCP service port for fnOS and retains the local port',()=>{
 const previous={...process.env};const root=mkdtempSync(join(tmpdir(),'runtime-mode-'));
 try{process.env.NODE_ENV='production';process.env.STORAGE_DIR=root;process.env.AUTH_MODE='fnos';process.env.SERVICE_PORT='43444';
  assert.equal(getAppConfig().servicePort,null);
  process.env.AUTH_MODE='local';assert.equal(getAppConfig().servicePort,43444);
 }finally{process.env=previous;rmSync(root,{recursive:true,force:true});}
});
