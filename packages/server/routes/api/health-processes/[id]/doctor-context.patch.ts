import {createError,defineEventHandler,getRouterParam,readBody} from 'h3';
import {updateDoctorContext} from '../../../../services/doctor-context.service';
import {getRequestUser} from '../../../../utils/request-user';
import {ok} from '../../../../utils/api-response';
export default defineEventHandler(async event=>{const input=await readBody(event);if(!input||typeof input!=='object'||Array.isArray(input))throw createError({statusCode:400,statusMessage:'内容无效'});return ok(updateDoctorContext(getRequestUser(event),getRouterParam(event,'id')||'',input as Record<string,unknown>));});
