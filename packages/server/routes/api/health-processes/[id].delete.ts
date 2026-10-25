import {createError,defineEventHandler,getRouterParam,readBody} from 'h3';
import {trashHealthProcess} from '../../../services/health-process-trash.service';
import {getRequestUser} from '../../../utils/request-user';
import {ok} from '../../../utils/api-response';
export default defineEventHandler(async event=>{
 const input=await readBody<Record<string,unknown>>(event);
 if(!input||typeof input!=='object'||Array.isArray(input))throw createError({statusCode:400,statusMessage:'历程删除内容无效'});
 return ok(trashHealthProcess(getRequestUser(event),getRouterParam(event,'id')||'',input));
});
