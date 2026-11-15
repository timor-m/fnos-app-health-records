import { createError, defineEventHandler, getRouterParam, readBody } from 'h3';
import { undoReportCombination } from '../../../../services/report-combination-recovery.service';
import { getRequestUser } from '../../../../utils/request-user';
import { ok } from '../../../../utils/api-response';
export default defineEventHandler(async (event) => {
    const id = getRouterParam(event, 'id');
    if (!id)
        throw createError({ statusCode: 400, message: '报告不存在' });
    return ok(undoReportCombination(getRequestUser(event), id, await readBody(event)));
});
