import { createError, defineEventHandler, getRouterParam, readBody } from 'h3';
import { createProcessSymptomUpdate } from '../../../../../../services/symptom-episode.service';
import { ok } from '../../../../../../utils/api-response';
import { getRequestUser } from '../../../../../../utils/request-user';

export default defineEventHandler(async event => {
  const id = getRouterParam(event, 'id', {decode:true});
  const symptomId = getRouterParam(event, 'symptomId', {decode:true});
  if (!id || !symptomId) throw createError({ statusCode: 400, statusMessage: '记录 ID 无效' });
  const input = await readBody(event) || {};
  if (typeof input !== 'object' || Array.isArray(input)) throw createError({ statusCode: 400, statusMessage: '请求内容无效' });
  return ok(createProcessSymptomUpdate(getRequestUser(event), id, symptomId, input as Record<string, unknown>));
});
