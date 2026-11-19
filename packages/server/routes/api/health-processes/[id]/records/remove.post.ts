import { createError,defineEventHandler,getRouterParam,readBody } from 'h3';
import { removeProcessRecord } from '../../../../../services/health-record-process.service';
import { queueHealthProcessOrganization } from '../../../../../services/health-process-ai.service';
import { getRequestUser } from '../../../../../utils/request-user';
import { ok } from '../../../../../utils/api-response';

export default defineEventHandler(async event=>{
  const input=await readBody<Record<string,unknown>>(event);
  if(!input||typeof input!=='object'||Array.isArray(input))throw createError({statusCode:400,statusMessage:'历程记录内容无效'});
  const user=getRequestUser(event);
  const result=removeProcessRecord(user,getRouterParam(event,'id')||'',input);
  if(result.process)queueHealthProcessOrganization(user,[result.process.id]);
  return ok(result);
});
