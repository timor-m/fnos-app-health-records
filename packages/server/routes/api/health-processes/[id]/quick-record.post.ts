import { createError,defineEventHandler,getRouterParam,readBody } from 'h3';
import { quickRecordProcess } from '../../../../services/health-process-care.service';
import { getRequestUser } from '../../../../utils/request-user';
import { ok } from '../../../../utils/api-response';
export default defineEventHandler(async event=>{
 const input=await readBody(event);if(!input||typeof input!=='object'||Array.isArray(input))throw createError({statusCode:400,statusMessage:'记录内容无效'});
 return ok(quickRecordProcess(getRequestUser(event),getRouterParam(event,'id')||'',input as Record<string,unknown>));
});
