import {createError,defineEventHandler,getRouterParam,readBody} from 'h3';
import {saveReportExamination} from '../../../../services/report-examination.service';
import {getRequestUser} from '../../../../utils/request-user';
import {ok} from '../../../../utils/api-response';
export default defineEventHandler(async event=>{
  const reportId=getRouterParam(event,'id');
  if(!reportId) throw createError({statusCode:400,statusMessage:'报告 ID 无效'});
  const body=await readBody(event);
  if(!body || typeof body!=='object' || Array.isArray(body)) throw createError({statusCode:400,statusMessage:'检查信息格式无效'});
  return ok(saveReportExamination(getRequestUser(event),reportId,body as Record<string,unknown>));
});
