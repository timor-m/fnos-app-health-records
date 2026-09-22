import { createError, defineEventHandler, getQuery, setResponseHeader } from 'h3';
import { getTrashCleanupSummary } from '../../../services/trash-cleanup.service';
import { getRequestUser } from '../../../utils/request-user';
import { ok } from '../../../utils/api-response';
export default defineEventHandler(event=>{
 setResponseHeader(event,'Cache-Control','private, no-store');
 const memberId=getQuery(event).memberId;
 if(typeof memberId!=='string' || !memberId.trim()) throw createError({statusCode:400,statusMessage:'请选择成员'});
 return ok(getTrashCleanupSummary(getRequestUser(event),memberId));
});
