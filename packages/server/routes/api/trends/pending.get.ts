import { createError, defineEventHandler, getQuery } from 'h3';
import { listPendingExaminationReports } from '../../../services/report-examination.service';
import { getRequestUser } from '../../../utils/request-user';
import { ok } from '../../../utils/api-response';

export default defineEventHandler(event => {
  const { memberId } = getQuery(event);
  if (typeof memberId !== 'string' || !memberId) throw createError({statusCode:400,statusMessage:'请选择成员'});
  return ok(listPendingExaminationReports(getRequestUser(event),memberId));
});
