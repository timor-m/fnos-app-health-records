import {createError,defineEventHandler,getRouterParam,readBody} from 'h3';
import {getReportExaminations} from '../../../../../services/report-examination.service';
import {setExaminationDuplicateDecision} from '../../../../../services/examination-duplicate.service';
import {getRequestUser} from '../../../../../utils/request-user';
import {ok} from '../../../../../utils/api-response';
export default defineEventHandler(async event=>{
 const reportId=getRouterParam(event,'id'),user=getRequestUser(event);
 if(!reportId)throw createError({statusCode:400,statusMessage:'报告 ID 无效'});
 const body=await readBody<Parameters<typeof setExaminationDuplicateDecision>[1]>(event);
 const state=getReportExaminations(user,reportId);
 if(!body || !state.examinations.some(e=>e.id===body.leftId))throw createError({statusCode:400,statusMessage:'所选检查不属于当前报告'});
 setExaminationDuplicateDecision(user,body);
 return ok(getReportExaminations(user,reportId));
});
