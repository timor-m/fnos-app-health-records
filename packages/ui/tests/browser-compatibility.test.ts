import {readdirSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {expect,it} from 'vitest';
import postcss from 'postcss';
import {isHealthRecordKind} from '../src/utils/health-record-navigation';
import {healthRecordFilters} from '../src/utils/health-record-filters';

it('validates record navigation and filters without Object.hasOwn on iOS 15.1',()=>{
 const descriptor=Object.getOwnPropertyDescriptor(Object,'hasOwn')!;
 let kinds:boolean[]=[],filters:ReturnType<typeof healthRecordFilters>|undefined;
 try{
  Object.defineProperty(Object,'hasOwn',{value:undefined,configurable:true});
  kinds=['report','medication_document','toString','__proto__',''].map(isHealthRecordKind);
  filters=healthRecordFilters({status:'failed',category:'report'});
 }finally{Object.defineProperty(Object,'hasOwn',descriptor);}
 expect(kinds).toEqual([true,true,false,false,false]);
 expect(filters).toMatchObject({status:'failed',category:'report'});
 expect(healthRecordFilters({status:'toString'}).status).toBe('');
});

const sourceRoot='packages/ui/src';
function sources(dir:string):string[]{return readdirSync(dir,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?sources(join(dir,entry.name)):/\.(vue|ts|css)$/.test(entry.name)?[join(dir,entry.name)]:[]);}
it('keeps Safari 15.4-only unguarded APIs out of the browser source',()=>{
 for(const path of sources(sourceRoot)){
  const source=readFileSync(path,'utf8');
  expect(source,path).not.toMatch(/Object\.hasOwn\s*\(|\.at\(\s*-?\d+\s*\)|\bstructuredClone\s*\(|\.findLast(?:Index)?\s*\(|\.to(?:Sorted|Reversed|Spliced)\s*\(/);
 }
});
it('provides valid vh fallbacks before dynamic viewport declarations, including scoped dialogs',()=>{
 let checked=0;
 for(const path of sources(sourceRoot)){
  const source=readFileSync(path,'utf8');
  const styles=path.endsWith('.css')?[source]:[...source.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)].map(match=>match[1]);
  for(const style of styles)postcss.parse(style).walkDecls(decl=>{
   if(!/\d+dvh/.test(decl.value))return;
   const previous=decl.prev();
   expect(previous?.type,path+': '+decl.toString()).toBe('decl');
   if(previous?.type==='decl'){
    expect(previous.prop).toBe(decl.prop);
    expect(previous.value).toBe(decl.value.replace(/(\d+(?:\.\d+)?)dvh/g,'$1vh'));
   }
   checked++;
  });
 }
 expect(checked).toBeGreaterThan(0);
});
