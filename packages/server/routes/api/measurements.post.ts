import { defineEventHandler, readBody } from 'h3';
import { createMeasurement } from '../../services/measurement.service';
import { getRequestUser } from '../../utils/request-user';
import { ok } from '../../utils/api-response';

export default defineEventHandler(async (event) => {
  return ok(createMeasurement(getRequestUser(event), (await readBody(event)) || {}));
});
