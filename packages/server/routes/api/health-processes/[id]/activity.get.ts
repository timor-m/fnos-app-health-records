import {defineEventHandler,getQuery,getRouterParam} from 'h3';
import {getHealthProcessActivity} from '../../../../services/health-process-activity.service';
import {getRequestUser} from '../../../../utils/request-user';
import {ok} from '../../../../utils/api-response';
export default defineEventHandler(event=>ok(getHealthProcessActivity(getRequestUser(event),getRouterParam(event,'id')||'',String(getQuery(event).timeZone||'Asia/Shanghai'))));
