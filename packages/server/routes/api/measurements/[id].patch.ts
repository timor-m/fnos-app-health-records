import { createError, defineEventHandler, getRouterParam, readBody } from 'h3';
import { updateMeasurement } from '../../../services/measurement.service';
import { getRequestUser } from '../../../utils/request-user';
import { ok } from '../../../utils/api-response';

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id');
  if (!id) throw createError({ statusCode: 400, statusMessage: '测量编号无效' });
  return ok(updateMeasurement(getRequestUser(event), id, (await readBody(event)) || {}));
});
