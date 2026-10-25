import { createError } from 'h3';
import { getDatabase } from '../database/client';
import type { RequestUser } from '../domain/request-user';
import { textInput } from './health-event-input';
import { previewUploadWorkflow, archiveUploadWorkflow } from './health-upload-workflow.service';
import { runHealthWorkflowRequest } from './health-workflow-request.service';
export function organizeHealthDocuments(user:RequestUser,input:Record<string,unknown>){
 const memberId=textInput(input.memberId,'成员',100,true)!;textInput(input.requestKey,'整理请求编号',100,true);
 if(!Array.isArray(input.groups)||!input.groups.length||input.groups.length>100)throw createError({statusCode:400,statusMessage:'资料分组无效'});
 const groups=input.groups.map(group=>{if(!group||typeof group!=='object'||!Array.isArray(group.reportIds)||!group.reportIds.length||group.reportIds.some((id:unknown)=>typeof id!=='string'))throw createError({statusCode:400,statusMessage:'资料分组无效'});return {reportIds:group.reportIds as string[],title:textInput(group.title,'资料标题',120)};});
 const ids=groups.flatMap(group=>group.reportIds);if(ids.length>100||new Set(ids).size!==ids.length)throw createError({statusCode:400,statusMessage:'资料不能重复分组'});
 return runHealthWorkflowRequest(user,memberId,'documents.organize',input,()=>{
 const preview=previewUploadWorkflow(user,memberId,ids);const byId=new Map(preview.reports.map(report=>[report.id,report]));
 const archiveGroups=[];const skipIds:string[]=[];
 for(const group of groups){const reports=group.reportIds.map(id=>byId.get(id)!);const first=reports[0];
  if(group.reportIds.length>1)archiveGroups.push({reportIds:group.reportIds,event:{...first.draft,title:group.title||first.draft.title}});
  else skipIds.push(...group.reportIds);
 }
 // Internal groups contain only documents explicitly confirmed together.
 const result=archiveUploadWorkflow(user,{memberId,requestKey:typeof input.requestKey==='string'?input.requestKey:undefined,groups:archiveGroups,skipReportIds:skipIds});
 return {memberId,reportIds:ids,groups:result.events.map(group=>({id:group.eventId,reportIds:group.reportIds}))};
 },saved=>{for(const id of saved.reportIds)if(!getDatabase().prepare("SELECT 1 FROM reports WHERE id=? AND member_id=? AND status<>'trashed' AND deleted_at IS NULL").get(id,memberId))throw createError({statusCode:409,statusMessage:'已整理资料发生变化，请刷新'});return saved;});
}
