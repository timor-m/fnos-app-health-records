import {createError,defineEventHandler,getRouterParam,readBody} from 'h3';
import {refreshReportOriginalNarratives} from '../../../../services/report-original-narrative-refresh.service';
import {ok} from '../../../../utils/api-response';
import {getRequestUser} from '../../../../utils/request-user';

export default defineEventHandler(async event=>{
  const reportId=getRouterParam(event,'id');
  if(!reportId) throw createError({statusCode:400,statusMessage:'报告 ID 无效'});
  const body=await readBody<{sourceVersion?:number}>(event);
  return ok(refreshReportOriginalNarratives(getRequestUser(event),reportId,body?.sourceVersion as number));
});
