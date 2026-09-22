import { defineEventHandler, readBody, getRouterParam } from 'h3';
import { continueDuplicateReport } from '../../../../services/report-duplicate-recovery.service';
import { getRequestUser } from '../../../../utils/request-user';
import { ok } from '../../../../utils/api-response';
export default defineEventHandler(async (event) => { const body = await readBody<{
    distinctTarget?: string;
}>(event); return ok(continueDuplicateReport(getRequestUser(event), getRouterParam(event, 'id') || '', typeof body?.distinctTarget === 'string' ? body.distinctTarget : undefined)); });
