import { createError, defineEventHandler, getRouterParam } from 'h3';
import { getMeasurement } from '../../../services/measurement.service';
import { getRequestUser } from '../../../utils/request-user';
import { ok } from '../../../utils/api-response';

export default defineEventHandler((event) => {
  const id = getRouterParam(event, 'id');
  if (!id) throw createError({ statusCode: 400, statusMessage: '测量编号无效' });
  return ok(getMeasurement(getRequestUser(event), id));
});
