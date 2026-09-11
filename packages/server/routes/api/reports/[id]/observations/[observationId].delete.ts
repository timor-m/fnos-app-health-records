import { createError, defineEventHandler, getRouterParam } from 'h3';
import { getReportDetail } from '../../../../../services/records.service';
import { deleteManualObservation } from '../../../../../services/observation-field-overrides.service';
import { ok } from '../../../../../utils/api-response';
import { getRequestUser } from '../../../../../utils/request-user';

export default defineEventHandler(event => {
  const reportId = getRouterParam(event, 'id');
  const observationId = getRouterParam(event, 'observationId');
  if (!reportId || !observationId) throw createError({ statusCode: 400, statusMessage: '指标 ID 无效' });
  const user = getRequestUser(event);
  deleteManualObservation(user, reportId, observationId);
  return ok(getReportDetail(user, reportId));
});
