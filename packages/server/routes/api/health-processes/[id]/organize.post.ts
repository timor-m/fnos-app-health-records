import { defineEventHandler,getRouterParam } from 'h3';
import { organizeHealthProcess } from '../../../../services/health-process-ai.service';
import { getRequestUser } from '../../../../utils/request-user';
import { ok } from '../../../../utils/api-response';
export default defineEventHandler(async event=>ok(await organizeHealthProcess(getRequestUser(event),getRouterParam(event,'id')||'')));
