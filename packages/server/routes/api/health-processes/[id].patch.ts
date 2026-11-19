import { createError,defineEventHandler,getRouterParam,readBody } from 'h3';
import { updateRecordProcess } from '../../../services/health-record-process.service';
import { getRequestUser } from '../../../utils/request-user';
import { ok } from '../../../utils/api-response';
export default defineEventHandler(async event=>{const input=await readBody<Record<string,unknown>>(event);if(!input||typeof input!=='object'||Array.isArray(input))throw createError({statusCode:400,statusMessage:'过程内容无效'});
 return ok(updateRecordProcess(getRequestUser(event),getRouterParam(event,'id')||'',input));});
