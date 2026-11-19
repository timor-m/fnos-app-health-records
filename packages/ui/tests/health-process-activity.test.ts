import {expect,it} from 'vitest';
import {initialProcessActivity} from '../src/utils/health-process-activity';
import type {HealthProcessActivity} from '../../shared/health-process-activity';
const process={id:'process',memberId:'member',fingerprint:'current'};
const activity={processId:'process',memberId:'member',fingerprint:'current',care:{error:'快速记录读取失败，请重试'},observations:{data:{processId:'process',memberId:'member',items:[],counts:{symptom:0,temperature:0,intake:0},total:0,nextCursor:null}},reminders:{data:[]}} satisfies HealthProcessActivity;
it('handles each module independently when another initial section fails',async()=>{
 const pending=Promise.resolve(activity);await expect(initialProcessActivity(pending,process,'care')).rejects.toThrow('快速记录读取失败');
 expect(await initialProcessActivity(pending,process,'observations')).toEqual(activity.observations.data);expect(await initialProcessActivity(pending,process,'reminders')).toEqual([]);
});
it('requires a fresh read when records changed between the primary and auxiliary requests',async()=>{
 expect(await initialProcessActivity(Promise.resolve({...activity,fingerprint:'old'}),process,'observations')).toBeUndefined();
});
it('rejects foreign members and processes instead of reusing their initial data',async()=>{
 for(const change of [{memberId:'other'},{processId:'other'}])await expect(initialProcessActivity(Promise.resolve({...activity,...change}),process,'reminders')).rejects.toThrow('不一致');
});
it('keeps initial request failures available to each module retry',async()=>{
 const pending=Promise.reject(Error('合成网络失败'));await expect(initialProcessActivity(pending,process,'reminders')).rejects.toThrow('合成网络失败');
});
