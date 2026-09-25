import {createError,defineEventHandler,getRouterParam} from 'h3';
import {previewReportExaminations} from '../../../../../services/report-examination.service';
import {getRequestUser} from '../../../../../utils/request-user';
import {ok} from '../../../../../utils/api-response';
export default defineEventHandler(event=>{
 const reportId=getRouterParam(event,'id');
 if(!reportId)throw createError({statusCode:400,statusMessage:'报告 ID 无效'});
 return ok(previewReportExaminations(getRequestUser(event),reportId));
});
