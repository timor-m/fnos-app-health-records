import { defineEventHandler, readBody } from 'h3';
import { recoverDuplicateReports } from '../../../services/report-duplicate-recovery.service';
import { getRequestUser } from '../../../utils/request-user';
import { ok } from '../../../utils/api-response';
export default defineEventHandler(async (event) => { const body = await readBody<{
    memberId?: string;
    reportIds: string[];
}>(event); return ok(recoverDuplicateReports(getRequestUser(event), String(body?.memberId || ''), body?.reportIds || [])); });
