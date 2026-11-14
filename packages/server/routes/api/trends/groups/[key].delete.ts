import {defineEventHandler,getRouterParam,createError} from 'h3';
import {deletePersonalTrendGroup} from '../../../../services/trend-groups.service';
import {getRequestUser} from '../../../../utils/request-user';
import {ok} from '../../../../utils/api-response';
export default defineEventHandler(event=>{
  const key=getRouterParam(event,'key');if(!key)throw createError({statusCode:400,statusMessage:'请选择分组'});
  return ok(deletePersonalTrendGroup(getRequestUser(event),key));
});
