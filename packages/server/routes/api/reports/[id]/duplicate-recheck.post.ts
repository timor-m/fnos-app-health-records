import { defineEventHandler, getRouterParam } from 'h3';
import { retryDuplicatePostcheck } from '../../../../services/report-duplicate-recovery.service';
import { getRequestUser } from '../../../../utils/request-user';
import { ok } from '../../../../utils/api-response';
export default defineEventHandler(event => ok(retryDuplicatePostcheck(getRequestUser(event), getRouterParam(event, 'id') || '')));
