import { defineEventHandler,getQuery,getRouterParam } from 'h3';
import { getHealthProcessCare } from '../../../../services/health-process-care.service';
import { getRequestUser } from '../../../../utils/request-user';
import { ok } from '../../../../utils/api-response';
export default defineEventHandler(event=>ok(getHealthProcessCare(getRequestUser(event),getRouterParam(event,'id')||'',String(getQuery(event).timeZone||'Asia/Shanghai'),getQuery(event).view!=='quick')));
