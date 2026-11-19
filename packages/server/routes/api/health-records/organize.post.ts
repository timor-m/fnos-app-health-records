import { createError,defineEventHandler,readBody } from 'h3';
import { getRequestUser } from '../../../utils/request-user';
import { ok } from '../../../utils/api-response';
import { organizeHealthDocuments } from '../../../services/health-document-organizer.service';
export default defineEventHandler(async event=>{const body=await readBody(event);if(!body||typeof body!=='object'||Array.isArray(body))throw createError({statusCode:400,statusMessage:'整理信息无效'});return ok(organizeHealthDocuments(getRequestUser(event),body as Record<string,unknown>));});
