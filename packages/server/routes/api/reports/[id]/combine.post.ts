import { createError, defineEventHandler, getRouterParam, readBody } from 'h3';
import { combineReports } from '../../../../services/report-combination.service';
import { getRequestUser } from '../../../../utils/request-user';
import { ok } from '../../../../utils/api-response';
export default defineEventHandler(async (event) => {
    const id = getRouterParam(event, 'id');
    if (!id)
        throw createError({ statusCode: 400, message: '报告 ID 无效' });
    return ok(combineReports(getRequestUser(event), id, await readBody(event)));
});
