import {createError,defineEventHandler,getRouterParam,readBody} from 'h3';
import {completeReminderWithExistingReport} from '../../../../services/health-process-reminder.service';
import {queueHealthProcessOrganization} from '../../../../services/health-process-ai.service';
import {getRequestUser} from '../../../../utils/request-user';
import {ok} from '../../../../utils/api-response';

export default defineEventHandler(async event=>{
 const input=await readBody<Record<string,unknown>>(event);
 if(!input||typeof input!=='object'||Array.isArray(input))throw createError({statusCode:400,statusMessage:'复查资料内容无效'});
 const user=getRequestUser(event);const result=completeReminderWithExistingReport(user,getRouterParam(event,'id')||'',input);
 if(result.processId)queueHealthProcessOrganization(user,[result.processId]);
 return ok(result);
});
