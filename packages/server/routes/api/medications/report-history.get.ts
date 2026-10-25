import { defineEventHandler, getQuery, createError } from 'h3';
import { listHistoricalMedications } from '../../../services/medication.service';
import { ok } from '../../../utils/api-response';
import { getRequestUser } from '../../../utils/request-user';
export default defineEventHandler(event => {
  const memberId = getQuery(event).memberId;
  if (typeof memberId !== 'string' || !memberId) throw createError({statusCode:400,statusMessage:'请选择成员'});
  return ok(listHistoricalMedications(getRequestUser(event),memberId));
});
