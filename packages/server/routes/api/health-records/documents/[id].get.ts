import { createError, defineEventHandler, getQuery, getRouterParam } from 'h3';
import { getDatabase } from '../../../../database/client';
import { assertMemberAccess } from '../../../../services/member.service';
import { reportCategory } from '../../../../../shared/health-categories';
import { getRequestUser } from '../../../../utils/request-user';
import { ok } from '../../../../utils/api-response';
import { getReportDetail } from '../../../../services/records.service';
export default defineEventHandler(event=>{
 const id=getRouterParam(event,'id')||'';const db=getDatabase();
 const report=db.prepare("SELECT id,member_id AS memberId,report_type AS reportType FROM reports WHERE id=? AND status<>'trashed' AND deleted_at IS NULL").get(id);
 if(!report)throw createError({statusCode:404,statusMessage:'资料不存在'});assertMemberAccess(getRequestUser(event),String(report.memberId));
 const category=reportCategory(String(report.reportType));
 const group=db.prepare("SELECT e.id FROM health_event_resources x JOIN health_events e ON e.id=x.event_id WHERE x.resource_type='report' AND x.resource_id=? AND e.member_id=? AND e.deleted_at IS NULL ORDER BY x.created_at,x.id LIMIT 1").get(id,report.memberId);
 const documents=group && category!=='medication' && category!=='vaccination' ? db.prepare(`SELECT DISTINCT r.id,r.title,r.report_type AS reportType FROM reports r JOIN health_event_resources x ON x.resource_id=r.id AND x.resource_type='report'
  WHERE x.event_id=? AND r.member_id=? AND r.status<>'trashed' AND r.deleted_at IS NULL ORDER BY r.id`).all(group.id,report.memberId).filter(value=>reportCategory(String(value.reportType))===category):[db.prepare('SELECT id,title,report_type AS reportType FROM reports WHERE id=?').get(id)!];
 // Detail callers can read the bundle and its selected report in one round trip.
 // Vaccination documents retain their separate confirmation flow.
 const detail = getQuery(event).includeDetail === 'true' && category !== 'vaccination'
  ? getReportDetail(getRequestUser(event), id, {includeDuplicateCandidates: false}) : undefined;
 return ok({memberId:report.memberId,category,documents,...(detail ? {detail} : {})});
});
