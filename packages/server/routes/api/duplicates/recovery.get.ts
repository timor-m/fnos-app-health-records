import { createError, defineEventHandler, getQuery } from 'h3';
import { listDuplicateRecovery } from '../../../services/report-duplicate-recovery.service';
import { getRequestUser } from '../../../utils/request-user';
import { ok } from '../../../utils/api-response';
export default defineEventHandler(event => { const memberId = getQuery(event).memberId; if (typeof memberId !== 'string')
    throw createError({ statusCode: 400, statusMessage: '请选择成员' }); return ok(listDuplicateRecovery(getRequestUser(event), memberId)); });
