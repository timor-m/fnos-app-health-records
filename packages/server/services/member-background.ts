import {createHash} from 'node:crypto';
export function memberBackgroundVersion(member:{careAllergies?:unknown;careHistory?:unknown;careMedications?:unknown}){
 return createHash('sha256').update(JSON.stringify([member.careAllergies||'',member.careHistory||'',member.careMedications||''])).digest('hex');
}
export function cleanMemberBackground(value:unknown):string|null{
 if(value===null||value==='')return null;
 if(typeof value!=='string'||value.length>2000)throw new Error('健康背景最多填写 2000 字');
 return value.trim()||null;
}
