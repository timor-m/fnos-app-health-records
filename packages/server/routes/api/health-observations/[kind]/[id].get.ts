import {defineEventHandler,getRouterParam,createError,getQuery} from 'h3';
import {readHealthObservation,correctHealthObservation} from '../../../../services/health-observation.service';
import {getRequestUser} from '../../../../utils/request-user';
import {ok} from '../../../../utils/api-response';
export default defineEventHandler(async event=>{const kind=getRouterParam(event,'kind');const id=getRouterParam(event,'id')||'';if(kind!=='symptom'&&kind!=='intake')throw createError({statusCode:400,statusMessage:'记录类型无效'});return ok(readHealthObservation(getRequestUser(event),{kind,id},String(getQuery(event).memberId||''),getQuery(event).processId));});
