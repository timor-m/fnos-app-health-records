import { createError,defineEventHandler,getRouterParam,readBody } from 'h3';
import { restoreVaccination } from '../../../../services/health-record-trash.service';
import { getRequestUser } from '../../../../utils/request-user';
import { ok } from '../../../../utils/api-response';
export default defineEventHandler(async event=>{
 const id=getRouterParam(event,'id',{decode:true});if(!id)throw createError({statusCode:400,statusMessage:'接种编号无效'});
 return ok(restoreVaccination(getRequestUser(event),id,await readBody<Record<string,unknown>>(event)||{}));
});
