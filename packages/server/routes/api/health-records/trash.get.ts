import { createError,defineEventHandler,getQuery } from 'h3';
import { listHealthTrash } from '../../../services/health-record-trash.service';
import { getRequestUser } from '../../../utils/request-user';
import { ok } from '../../../utils/api-response';
export default defineEventHandler(event=>{
 const query=getQuery(event);
 for(const key of ['memberId','cursor','limit'])if(query[key]!==undefined&&typeof query[key]!=='string')throw createError({statusCode:400,statusMessage:'回收站查询无效'});
 if(typeof query.memberId!=='string'||!query.memberId)throw createError({statusCode:400,statusMessage:'成员无效'});
 return ok(listHealthTrash(getRequestUser(event),query.memberId,{cursor:query.cursor as string|undefined,limit:query.limit===undefined?30:Number(query.limit)}));
});
