import { createError, defineEventHandler, getQuery, getRouterParam } from 'h3';
import { previewReportCombination } from '../../../../services/report-combination.service';
import { getRequestUser } from '../../../../utils/request-user';
import { ok } from '../../../../utils/api-response';
export default defineEventHandler(event => {
    const targetId = getRouterParam(event, 'id'), query = getQuery(event);
    if (!targetId || typeof query.sourceReportId !== 'string')
        throw createError({ statusCode: 400, message: '请选择要并入的报告' });
    return ok(previewReportCombination(getRequestUser(event), query.sourceReportId, targetId));
});
