import { createError, defineEventHandler, getQuery, getRouterParam } from 'h3';
import { previewCombinationUndo } from '../../../../services/report-combination-recovery.service';
import { getRequestUser } from '../../../../utils/request-user';
import { ok } from '../../../../utils/api-response';
export default defineEventHandler(event => {
    const id = getRouterParam(event, 'id'), query = getQuery(event);
    if (!id || typeof query.combinationId !== 'string' || query.combinationId.length > 100)
        throw createError({ statusCode: 400, message: '请选择要撤销的合并' });
    return ok(previewCombinationUndo(getRequestUser(event), id, query.combinationId));
});
