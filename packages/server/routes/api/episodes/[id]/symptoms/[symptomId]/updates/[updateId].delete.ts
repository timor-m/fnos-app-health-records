import { createError, defineEventHandler, getRouterParam, readBody } from 'h3';
import { retractProcessSymptomUpdate } from '../../../../../../../services/symptom-episode.service';
import { ok } from '../../../../../../../utils/api-response';
import { getRequestUser } from '../../../../../../../utils/request-user';

export default defineEventHandler(async event => {
  const id = getRouterParam(event, 'id', {decode:true});
  const symptomId = getRouterParam(event, 'symptomId', {decode:true});
  const updateId = getRouterParam(event, 'updateId', {decode:true});
  if (!id || !symptomId || !updateId) throw createError({ statusCode: 400, statusMessage: '记录 ID 无效' });
  const input = await readBody(event) || {};
  if (typeof input !== 'object' || Array.isArray(input)) throw createError({ statusCode: 400, statusMessage: '请求内容无效' });
  return ok(retractProcessSymptomUpdate(getRequestUser(event), id, symptomId, updateId, input as Record<string, unknown>));
});
