import { createError,defineEventHandler,getQuery } from 'h3';
import { getDatabase } from '../../../database/client';
import { assertMemberAccess } from '../../../services/member.service';
import { getRequestUser } from '../../../utils/request-user';
import { ok } from '../../../utils/api-response';
export default defineEventHandler(event=>{const {memberId}=getQuery(event);if(typeof memberId!=='string'||!memberId)throw createError({statusCode:400,statusMessage:'成员无效'});assertMemberAccess(getRequestUser(event),memberId);return ok(getDatabase().prepare("SELECT id,title FROM reports WHERE member_id=? AND (report_type='vaccination' OR EXISTS(SELECT 1 FROM vaccination_records v WHERE v.report_id=reports.id AND v.is_deleted=0)) AND status<>'trashed' AND deleted_at IS NULL ORDER BY report_issued_at DESC,id").all(memberId));});
